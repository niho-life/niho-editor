// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enqueuePhotoMediaJob,
  getPhotoAsset,
  getPhotoLibrary,
  getPhotoSnapshot,
} from "@niho/editor-store";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { library as fixtureLibrary, readyPhoto } from "../../../../../packages/photo-library-contract/fixtures/v1";
import {
  PHOTO_LIMITS,
  type Json,
  type JsonObject,
  type Photo,
  type PhotoAsset,
  type RecipeDocument,
} from "../../../../../packages/photo-library-contract/src/v1";
import { createMediaExecutor } from "../../../../../workers/photo-media/src/run.ts";
import { createP02MediaJobs, createP02MediaObjects, type MediaObjectStorage } from "../../../../../workers/photo-media/src/p02.ts";
import { MediaProviderError, type MediaClaim, type MediaProvider, type StoredDerivative } from "../../../../../workers/photo-media/src/types.ts";
import { createPhotoCatalogRoutes } from "../photo-catalog/routes";
import { createPhotoCatalogStore } from "../photo-catalog/store-adapter";
import { createPhotoRecipesRoutes } from "../photo-recipes/routes";
import { createPhotoRecipeStore } from "../photo-recipes/store-adapter";
import type { PhotoRecipeValidator } from "../photo-recipes/types";
import {
  CONFORMANCE_ORIGIN,
  SYNTHETIC_JPEG,
  actor,
  conformanceDatabaseUrl,
  createConformanceHarness,
  digest,
  get,
  openConformanceDatabase,
  originalRequest,
  post,
  startAndStage,
  type ConformanceHarness,
} from "./harness";

const databaseUrl = conformanceDatabaseUrl();
const databaseDescribe = databaseUrl ? describe : describe.skip;
const owner = (label: string) => `synthetic-media-${label}-${randomUUID()}`;
const recipeKey = () => `synthetic_recipe_${randomUUID().replaceAll("-", "")}`;
const mediaSpec = {
  rendererManifestSha256: fixtureLibrary.capabilities.renderer.manifestSha256,
  thumbnailMaxEdge: PHOTO_LIMITS.thumbnailMaxEdge,
  previewMaxEdge: PHOTO_LIMITS.previewMaxEdge,
  workingCopyMaxEdge: PHOTO_LIMITS.workingCopyMaxEdge,
};

function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(",")}}`;
}

function recipeRequest(photoId: string, body: unknown): Request {
  return new Request(`${CONFORMANCE_ORIGIN}/api/photo/v1/photos/${photoId}/recipe`, {
    method: "PUT",
    headers: {
      origin: CONFORMANCE_ORIGIN,
      "content-type": "application/json; charset=utf-8",
      "idempotency-key": recipeKey(),
    },
    body: JSON.stringify(body),
  });
}

function catalogRoutes(pool: Pool, user: string) {
  return createPhotoCatalogRoutes({
    enabled: true,
    cursorSecret: Buffer.alloc(32, 19),
    store: createPhotoCatalogStore(pool, fixtureLibrary.capabilities),
    verify: async () => actor(user),
  });
}

function recipeRoutes(pool: Pool, user: string, validator: PhotoRecipeValidator) {
  return createPhotoRecipesRoutes({
    recipes: () => ({ store: createPhotoRecipeStore(pool, fixtureLibrary.capabilities), validator }),
    verify: async () => actor(user),
    origins: [CONFORMANCE_ORIGIN],
  });
}

async function seed(pool: Pool, user: string, bytes = SYNTHETIC_JPEG): Promise<{ harness: ConformanceHarness; photo: Photo }> {
  const harness = createConformanceHarness(pool);
  const staged = await startAndStage(harness, user, originalRequest(bytes), bytes);
  const response = await harness.api.complete(post(), actor(user), staged.uploadId);
  expect(response.status).toBe(200);
  const body = await response.json() as { value: { result: { photo: Photo } } };
  return { harness, photo: body.value.result.photo };
}

/** Test-only create-once storage. Original reads delegate to P03's generation-aware fake storage. */
function syntheticMediaStorage(harness: ConformanceHarness): MediaObjectStorage {
  let nextGeneration = 10_000;
  const outputs = new Map<string, { generation: string; bytes: Uint8Array; contentType: string }>();
  return {
    async read(object, signal) {
      signal.throwIfAborted();
      const output = outputs.get(object.key);
      if (!output) {
        const stream = await harness.storage.read(object, null, signal);
        return (async function* () {
          const reader = stream.getReader();
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) return;
              yield next.value;
            }
          } finally {
            reader.releaseLock();
          }
        })();
      }
      if (output.generation !== object.generation || output.bytes.byteLength !== object.sizeBytes
        || output.contentType !== object.contentType) throw new Error("synthetic media generation mismatch");
      return (async function* () { yield output.bytes.slice(); })();
    },
    async create(input, signal) {
      signal.throwIfAborted();
      if (input.ifGenerationMatch !== 0 || outputs.has(input.key)) throw new Error("synthetic media create conflict");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of input.bytes) {
        signal.throwIfAborted();
        chunks.push(chunk.slice());
        size += chunk.byteLength;
      }
      if (size !== input.sizeBytes) throw new Error("synthetic media size mismatch");
      const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      const generation = String(++nextGeneration);
      outputs.set(input.key, { generation, bytes, contentType: input.contentType });
      return { generation, sizeBytes: bytes.byteLength, contentType: input.contentType };
    },
  };
}

async function stageSyntheticDerivative(
  objects: ReturnType<typeof createP02MediaObjects>,
  claim: MediaClaim,
  directory: string,
  kind: "thumbnail" | "preview",
  marker: number,
): Promise<StoredDerivative> {
  // Opaque ledger bytes only: this intentionally does not stand in for a decoded image.
  const bytes = Buffer.from([0x50, 0x31, 0x32, marker]);
  const path = join(directory, kind);
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  const stored = await objects.stage(claim, {
    path,
    kind,
    sha256: digest(bytes),
    sizeBytes: bytes.byteLength,
    contentType: "image/jpeg",
    width: 2,
    height: 1,
  }, new AbortController().signal);
  const asset: PhotoAsset = {
    id: stored.id,
    kind,
    sha256: digest(bytes),
    sizeBytes: bytes.byteLength,
    contentType: "image/jpeg",
    width: 2,
    height: 1,
  };
  return { asset, generation: stored.generation };
}

databaseDescribe("P12 production media adapter + worker + catalog conformance", () => {
  let pool: Pool;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => { ({ pool, close } = await openConformanceDatabase(databaseUrl!)); });
  afterAll(async () => { await close?.(); });

  it("stored-media-failed: decoder-confirmed synthetic failure keeps the durable original and owner boundary", async () => {
    const user = owner("failed-a");
    const foreign = owner("failed-b");
    const bytes = Buffer.concat([SYNTHETIC_JPEG, Buffer.from([41, 42])]);
    const { harness, photo } = await seed(pool, user, bytes);
    const originalBefore = await getPhotoAsset(pool, user, photo.id, photo.original.id);
    const libraryBefore = await getPhotoLibrary(pool, user);
    const job = await enqueuePhotoMediaJob(pool, user, photo.id, mediaSpec);
    expect(job).not.toBeNull();

    const render = vi.fn(async (input: Parameters<MediaProvider["render"]>[0]) => {
      expect(Buffer.from(await readFile(input.originalPath))).toEqual(bytes);
      throw new MediaProviderError("decoder_failed");
    });
    const provider: MediaProvider = {
      renderer: fixtureLibrary.capabilities.renderer,
      acceptedFormats: ["jpeg"],
      supports: vi.fn(() => true),
      render,
      inspect: vi.fn(async () => { throw new Error("synthetic decoder failure has no output"); }),
    };
    const execute = createMediaExecutor({
      jobs: createP02MediaJobs(pool, user),
      objects: createP02MediaObjects(pool, user, syntheticMediaStorage(harness)),
      provider,
    });

    expect(await execute(job!.id)).toBe("decoder_failed");
    expect(render).toHaveBeenCalledOnce();
    const jobRow = (await pool.query<{
      current_media_job_id: string;
      state: string;
      error_code: string;
      attempt_error: string;
    }>(
      `SELECT p.current_media_job_id, j.state, j.error_code, j.attempt_error
         FROM photos AS p JOIN photo_media_jobs AS j ON j.owner = p.owner AND j.id = p.current_media_job_id
        WHERE p.owner = $1 AND p.id = $2`,
      [user, photo.id],
    )).rows[0];
    expect(jobRow).toEqual({
      current_media_job_id: job!.id,
      state: "failed",
      error_code: "decoder_failed",
      attempt_error: "decoder_failed",
    });

    const response = await catalogRoutes(pool, user).photo(
      new Request(`${CONFORMANCE_ORIGIN}/api/photo/v1/photos/${photo.id}`),
      photo.id,
    );
    expect(response.status).toBe(200);
    const projected = await response.json() as Photo;
    expect(projected).toMatchObject({
      id: photo.id,
      storageState: "stored",
      media: { state: "failed", code: "decoder_failed" },
      original: { id: photo.original.id, sha256: digest(bytes), sizeBytes: bytes.byteLength },
    });
    expect(projected.media).not.toHaveProperty("jobId");
    expect(JSON.stringify(projected)).not.toMatch(/objectKey|objectGeneration|photo\/final\//);

    const content = await harness.api.content(get(), actor(user), photo.id, photo.original.id);
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer())).toEqual(bytes);
    expect((await harness.api.content(get(), actor(foreign), photo.id, photo.original.id)).status).toBe(404);
    expect((await catalogRoutes(pool, foreign).photo(
      new Request(`${CONFORMANCE_ORIGIN}/api/photo/v1/photos/${photo.id}`),
      photo.id,
    )).status).toBe(404);

    expect(await getPhotoAsset(pool, user, photo.id, photo.original.id)).toEqual(originalBefore);
    const libraryAfter = await getPhotoLibrary(pool, user);
    expect(libraryAfter.usage).toEqual(libraryBefore.usage);
    expect(libraryAfter.usage.originalBytes).toBe(bytes.byteLength);
  });

  it("stale-preview: recipe CAS fences an old claimed generation and P04 never projects its staged preview", async () => {
    const user = owner("stale-preview");
    const { harness, photo } = await seed(pool, user);
    const job = await enqueuePhotoMediaJob(pool, user, photo.id, mediaSpec);
    expect(job).not.toBeNull();
    const jobs = createP02MediaJobs(pool, user);
    const claim = await jobs.claim(job!.id);
    expect(claim).not.toBeNull();
    expect(claim!.identity.recipeRevision).toBe(0);
    expect(claim!.generation).toBeGreaterThan(0);

    const objects = createP02MediaObjects(pool, user, syntheticMediaStorage(harness));
    const directory = await mkdtemp(join(tmpdir(), "niho-p12-stale-preview-"));
    const staged: readonly StoredDerivative[] = await (async () => {
      try {
        return await Promise.all([
          stageSyntheticDerivative(objects, claim!, directory, "thumbnail", 1),
          stageSyntheticDerivative(objects, claim!, directory, "preview", 2),
        ]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    })();
    const thumbnail = staged.find((item) => item.asset.kind === "thumbnail")!;
    const preview = staged.find((item) => item.asset.kind === "preview")!;

    const compatibleValidator: PhotoRecipeValidator = {
      validate: vi.fn(async (settings: RecipeDocument["settings"]) => ({
        settingsSha256: digest(Buffer.from(canonicalJson(settings))),
        maskSurfaceIds: [],
      })),
    };
    const settings = { ...readyPhoto.recipe.settings, exposure: 0.375 };
    const update = await recipeRoutes(pool, user, compatibleValidator).putRecipe(
      recipeRequest(photo.id, { expectedRevision: 0, settings, baseVersion: null }),
      photo.id,
    );
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ value: { recipe: { revision: 1, settings } } });

    const published = await jobs.publish(claim!, {
      state: "ready",
      thumbnail: thumbnail.asset,
      preview: preview.asset,
      workingCopy: null,
      recipeRevision: claim!.identity.recipeRevision,
      rendererManifestSha256: claim!.identity.rendererManifestSha256,
    }, staged, claim!.expiresAt - 1_000);
    expect(published).toBe(false);
    expect(await jobs.supersede(claim!)).toBe(true);

    const jobRow = (await pool.query<{
      state: string;
      terminal_reason: string;
      claim_generation: string;
    }>(
      "SELECT state, terminal_reason, claim_generation::text AS claim_generation FROM photo_media_jobs WHERE owner = $1 AND id = $2",
      [user, job!.id],
    )).rows[0];
    expect(jobRow).toEqual({ state: "failed", terminal_reason: "superseded", claim_generation: String(claim!.generation) });
    expect((await pool.query<{ state: string }>(
      "SELECT state FROM photo_media_candidates WHERE owner = $1 AND job_id = $2 ORDER BY kind",
      [user, job!.id],
    )).rows).toEqual([{ state: "abandoned" }, { state: "abandoned" }]);
    expect((await getPhotoSnapshot(pool, user, photo.id))?.media).toBeNull();
    expect((await pool.query(
      "SELECT 1 FROM photo_assets WHERE owner = $1 AND photo_id = $2 AND id = ANY($3::uuid[])",
      [user, photo.id, staged.map((item) => item.asset.id)],
    )).rowCount).toBe(0);

    const response = await catalogRoutes(pool, user).photo(
      new Request(`${CONFORMANCE_ORIGIN}/api/photo/v1/photos/${photo.id}`),
      photo.id,
    );
    expect(response.status).toBe(200);
    const projected = await response.json() as Photo;
    expect(projected).toMatchObject({ id: photo.id, recipe: { revision: 1 }, media: { state: "pending" } });
    expect(JSON.stringify(projected)).not.toContain(thumbnail.asset.id);
    expect(JSON.stringify(projected)).not.toContain(preview.asset.id);
    expect(JSON.stringify(projected)).not.toMatch(/objectKey|objectGeneration|photo\/final\//);
  });
});
