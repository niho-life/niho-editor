// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { developSettingsEngineIdentifiers, supportedDevelopSettingsVersions } from "niho-photo-contract";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { library as fixtureLibrary, readyPhoto } from "../../../../../packages/photo-library-contract/fixtures/v1";
import type { Json, JsonObject, Photo, RecipeDocument } from "../../../../../packages/photo-library-contract/src/v1";
import { createPhotoCatalogRoutes } from "../photo-catalog/routes";
import { createPhotoCatalogStore } from "../photo-catalog/store-adapter";
import { createPhotoRecipesRoutes } from "../photo-recipes/routes";
import { createPhotoRecipeStore } from "../photo-recipes/store-adapter";
import type { PhotoRecipeValidator } from "../photo-recipes/types";
import {
  CONFORMANCE_ORIGIN,
  SYNTHETIC_JPEG,
  SYNTHETIC_PNG,
  actor,
  conformanceDatabaseUrl,
  createConformanceHarness,
  digest,
  maskRequest,
  openConformanceDatabase,
  originalRequest,
  post,
  startAndStage,
} from "./harness";

const databaseUrl = conformanceDatabaseUrl();
const databaseDescribe = databaseUrl ? describe : describe.skip;
const owner = (label: string) => `synthetic-recipes-${label}-${randomUUID()}`;
const key = () => `synthetic_recipe_${randomUUID().replaceAll("-", "")}`;
const securityCasesUrl = new URL("../../../../../packages/photo-library-contract/fixtures/security-cases.json", import.meta.url);

function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((name) => `${JSON.stringify(name)}:${canonicalJson(object[name]!)}`).join(",")}}`;
}

function settingsSha256(settings: RecipeDocument["settings"]): string {
  return createHash("sha256").update(canonicalJson(settings)).digest("hex");
}

function request(photoId: string, body: unknown, idempotencyKey: string): Request {
  return new Request(`${CONFORMANCE_ORIGIN}/api/photo/v1/photos/${photoId}/recipe`, {
    method: "PUT",
    headers: {
      origin: CONFORMANCE_ORIGIN,
      "content-type": "application/json; charset=utf-8",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

function routes(pool: Pool, user: string, validator: PhotoRecipeValidator) {
  return createPhotoRecipesRoutes({
    recipes: () => ({
      store: createPhotoRecipeStore(pool, fixtureLibrary.capabilities),
      validator,
    }),
    verify: async () => actor(user),
    origins: [CONFORMANCE_ORIGIN],
  });
}

function catalogRoutes(pool: Pool, user: string) {
  return createPhotoCatalogRoutes({
    enabled: true,
    cursorSecret: Buffer.alloc(32, 23),
    store: createPhotoCatalogStore(pool, fixtureLibrary.capabilities),
    verify: async () => actor(user),
  });
}

async function seed(pool: Pool, user: string): Promise<Photo> {
  const harness = createConformanceHarness(pool);
  const staged = await startAndStage(harness, user, originalRequest(), SYNTHETIC_JPEG);
  const response = await harness.api.complete(post(), actor(user), staged.uploadId);
  expect(response.status).toBe(200);
  return (await response.json() as { value: { result: { photo: Photo } } }).value.result.photo;
}

const compatibleValidator: PhotoRecipeValidator = {
  validate: async (settings) => ({ settingsSha256: settingsSha256(settings), maskSurfaceIds: [] }),
};

async function recipeDatabaseState(pool: Pool, user: string, photoId: string) {
  const recipe = (await pool.query<{
    photo_revision: string;
    recipe_revision: string;
    settings_sha256: string;
    settings: RecipeDocument["settings"];
  }>(
    `SELECT p.recipe_revision::text AS photo_revision, r.revision::text AS recipe_revision,
            r.settings_sha256, r.settings
       FROM photos AS p JOIN photo_recipes AS r ON r.owner = p.owner AND r.photo_id = p.id
      WHERE p.owner = $1 AND p.id = $2`,
    [user, photoId],
  )).rows[0]!;
  const outbox = (await pool.query<{
    recipe_revision: string;
    settings_sha256: string;
    consumed_at: Date | null;
  }>(
    `SELECT recipe_revision::text AS recipe_revision, settings_sha256, consumed_at
       FROM photo_media_outbox WHERE owner = $1 AND photo_id = $2
      ORDER BY recipe_revision`,
    [user, photoId],
  )).rows;
  const receipts = (await pool.query<{ idempotency_key: string; result_revision: string }>(
    `SELECT idempotency_key, result_revision::text AS result_revision
       FROM photo_write_receipts WHERE owner = $1 AND photo_id = $2 AND operation = 'recipe'
      ORDER BY idempotency_key`,
    [user, photoId],
  )).rows;
  return { recipe, outbox, receipts };
}

databaseDescribe("P12 recipe routes + production PostgreSQL adapter", () => {
  let pool: Pool;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => { ({ pool, close } = await openConformanceDatabase(databaseUrl!)); });
  afterAll(async () => { await close?.(); });

  it("recipe-stale: 同じexpectedRevisionの2 route writeは一方だけcommitし、replayとpayload conflictをDBで直列化する", async () => {
    const user = owner("stale");
    const photo = await seed(pool, user);
    const recipeRoutes = routes(pool, user, compatibleValidator);
    const before = await recipeDatabaseState(pool, user, photo.id);
    const bodies = [
      { expectedRevision: 0, settings: { ...readyPhoto.recipe.settings, exposure: 0.25 }, baseVersion: null },
      { expectedRevision: 0, settings: { ...readyPhoto.recipe.settings, exposure: -0.25 }, baseVersion: null },
    ];
    const keys = [key(), key()];

    const responses = await Promise.all(bodies.map((body, index) =>
      recipeRoutes.putRecipe(request(photo.id, body, keys[index]!), photo.id)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const payloads = await Promise.all(responses.map((response) => response.json())) as Array<{
      value?: Photo;
      replayed?: boolean;
      error?: { code: string; currentRevision?: number };
    }>;
    const winner = responses.findIndex((response) => response.status === 200);
    const loser = winner === 0 ? 1 : 0;
    expect(payloads[winner]).toMatchObject({ replayed: false, value: { recipe: { revision: 1 } } });
    expect(payloads[loser]).toMatchObject({ error: { code: "revision_conflict", currentRevision: 1 } });

    const committedHash = settingsSha256(bodies[winner]!.settings);
    const after = await recipeDatabaseState(pool, user, photo.id);
    expect(after.recipe).toMatchObject({
      photo_revision: "1",
      recipe_revision: "1",
      settings_sha256: committedHash,
      settings: bodies[winner]!.settings,
    });
    expect(after.outbox).toHaveLength(before.outbox.length + 1);
    expect(after.outbox.at(-1)).toEqual({ recipe_revision: "1", settings_sha256: committedHash, consumed_at: null });
    expect(after.receipts).toEqual([{ idempotency_key: keys[winner], result_revision: "1" }]);

    const replay = await recipeRoutes.putRecipe(request(photo.id, bodies[winner], keys[winner]!), photo.id);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, value: { recipe: { revision: 1 } } });
    const changed = {
      ...bodies[winner]!,
      settings: { ...bodies[winner]!.settings, contrast: 0.5 },
    };
    const conflict = await recipeRoutes.putRecipe(request(photo.id, changed, keys[winner]!), photo.id);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
    expect(await recipeDatabaseState(pool, user, photo.id)).toEqual(after);
  });

  it("missing-mask: 合成validatorはsurface ID抽出だけを担い、foreign surfaceを実P02 writerがcommitしない", async () => {
    const user = owner("mask-a");
    const foreign = owner("mask-b");
    const photo = await seed(pool, user);
    const foreignPhoto = await seed(pool, foreign);
    const foreignHarness = createConformanceHarness(pool);
    foreignHarness.setProbe({
      format: "png", contentType: "image/png", width: 2, height: 1,
      encodedWidth: 2, encodedHeight: 1, bitDepth: 8, channels: "gray",
    });
    const mask = await startAndStage(foreignHarness, foreign, maskRequest(foreignPhoto.id), SYNTHETIC_PNG);
    expect((await foreignHarness.api.complete(post(), actor(foreign), mask.uploadId)).status).toBe(200);
    const surfaceId = digest(SYNTHETIC_PNG);
    expect((await pool.query(
      "SELECT 1 FROM photo_assets WHERE owner = $1 AND photo_id = $2 AND kind = 'mask' AND sha256 = $3",
      [foreign, foreignPhoto.id, surfaceId],
    )).rowCount).toBe(1);

    const syntheticMaskExtractor: PhotoRecipeValidator = {
      validate: vi.fn(async (settings) => {
        const masks: readonly Json[] = Array.isArray(settings.masks) ? settings.masks : [];
        const maskSurfaceIds = masks.flatMap((maskValue: Json) => {
          if (!maskValue || typeof maskValue !== "object" || Array.isArray(maskValue)) return [];
          const surface = (maskValue as JsonObject).surface;
          if (!surface || typeof surface !== "object" || Array.isArray(surface)) return [];
          const surfaceId = (surface as JsonObject).id;
          return typeof surfaceId === "string" ? [surfaceId] : [];
        });
        return { settingsSha256: settingsSha256(settings), maskSurfaceIds };
      }),
    };
    const settings = {
      ...readyPhoto.recipe.settings,
      v: 5,
      masks: [{
        id: "synthetic-sky",
        kind: "sky",
        surface: { id: surfaceId, width: 2, height: 1 },
        adjust: { exposure: -0.5 },
      }],
    };
    const body = { expectedRevision: 0, settings, baseVersion: null };
    const before = await recipeDatabaseState(pool, user, photo.id);
    const response = await routes(pool, user, syntheticMaskExtractor)
      .putRecipe(request(photo.id, body, key()), photo.id);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "missing_mask_surface" } });
    expect(syntheticMaskExtractor.validate).toHaveBeenCalledOnce();
    expect(await recipeDatabaseState(pool, user, photo.id)).toEqual(before);
  });

  it("unknown-recipe: P04はP00 future JSONをopaque保持し、P05 capability guardはvalidator前に拒否する", async () => {
    const fixture = JSON.parse(await readFile(securityCasesUrl, "utf8")) as {
      cases: Array<{
        id: string;
        request: {
          expectedRevision: number;
          settings: RecipeDocument["settings"];
          baseVersion: string | null;
        };
        expected: { status: number; code: string };
      }>;
    };
    const p00 = fixture.cases.find((item) => item.id === "unknown-recipe");
    expect(p00).toBeDefined();
    const user = owner("unknown");
    const photo = await seed(pool, user);
    const futureSettings = p00!.request.settings;
    const futureHash = settingsSha256(futureSettings);

    expect(fixtureLibrary.capabilities.renderer.settingsVersions).toEqual([...supportedDevelopSettingsVersions]);
    expect(fixtureLibrary.capabilities.renderer.engines).toEqual([...developSettingsEngineIdentifiers]);
    expect(supportedDevelopSettingsVersions).not.toContain(futureSettings.v);
    expect(developSettingsEngineIdentifiers).not.toContain(futureSettings.engine);

    // A dedicated newer-writer fixture replaces revision zero without passing through the older host validator.
    const current = await pool.query(
      `UPDATE photo_recipes
          SET settings = $3::jsonb, settings_sha256 = $4, has_edits = true
        WHERE owner = $1 AND photo_id = $2 AND revision = 0`,
      [user, photo.id, JSON.stringify(futureSettings), futureHash],
    );
    const history = await pool.query(
      `UPDATE photo_recipe_revisions
          SET settings = $3::jsonb, settings_sha256 = $4, has_edits = true
        WHERE owner = $1 AND photo_id = $2 AND revision = 0`,
      [user, photo.id, JSON.stringify(futureSettings), futureHash],
    );
    expect({ current: current.rowCount, history: history.rowCount }).toEqual({ current: 1, history: 1 });

    const read = await catalogRoutes(pool, user).photo(
      new Request(`${CONFORMANCE_ORIGIN}/api/photo/v1/photos/${photo.id}`),
      photo.id,
    );
    expect(read.status).toBe(200);
    const readPhoto = await read.json() as Photo;
    expect(readPhoto.recipe).toMatchObject({ revision: 0, settings: futureSettings, settingsSha256: futureHash });
    expect(readPhoto.recipe.settings.futureField).toEqual({ keep: [1, "opaque"] });
    expect(JSON.stringify(readPhoto)).not.toMatch(/objectKey|objectGeneration|photo\/final\//);

    const syntheticValidator: PhotoRecipeValidator = {
      validate: vi.fn(async () => ({ settingsSha256: futureHash, maskSurfaceIds: [] })),
    };
    const before = await recipeDatabaseState(pool, user, photo.id);
    const response = await routes(pool, user, syntheticValidator).putRecipe(
      request(photo.id, {
        expectedRevision: p00!.request.expectedRevision,
        settings: futureSettings,
        baseVersion: p00!.request.baseVersion,
      }, key()),
      photo.id,
    );

    expect(response.status).toBe(p00!.expected.status);
    expect(await response.json()).toMatchObject({ error: { code: p00!.expected.code } });
    expect(syntheticValidator.validate).not.toHaveBeenCalled();
    expect(await recipeDatabaseState(pool, user, photo.id)).toEqual(before);
  });
});
