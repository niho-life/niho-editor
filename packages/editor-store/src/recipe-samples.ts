import { isRecipeSample, RECIPE_LIMITS, type RecipeSample } from "./recipes.ts";
import { SETTINGS_ID_PATTERN, isSettingsTerm, type SettingsTerm } from "./settings.ts";
import type { Database, OwnerId, Queryable } from "./types.ts";

/** The storage ceiling matches docs-core's current sample limits. Import truncation remains in editor-web. */
export const RECIPE_SAMPLE_BODY_MAX_CHARS = 30_000;
export const RECIPE_SAMPLE_MAX_COUNT = RECIPE_LIMITS.samples;
export const RECIPE_SAMPLE_GUIDE_MAX_CHARS = 4_000;

export type RecipeSampleBody = { id: string; text: string };
export type RecipeGuideExtraction = { sampleIds: string[]; guide: string; candidates: SettingsTerm[]; createdAt: string };
export type PutRecipeSampleResult = "created" | "not_found" | "limit" | "conflict";

function assertOwner(owner: OwnerId): void {
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) throw new TypeError("editor-store: owner must be a non-empty stable user id");
}

function validRecipeId(recipeId: string): boolean {
  return typeof recipeId === "string" && SETTINGS_ID_PATTERN.test(recipeId);
}

function validSampleBody(sample: RecipeSample, body: string): boolean {
  return isRecipeSample(sample) && typeof body === "string" && Array.from(body).length > 0 && Array.from(body).length <= RECIPE_SAMPLE_BODY_MAX_CHARS;
}

function sampleList(value: unknown): RecipeSample[] | null {
  if (!Array.isArray(value) || !value.every(isRecipeSample)) return null;
  const samples = value as RecipeSample[];
  return new Set(samples.map((sample) => sample.id)).size === samples.length ? samples : null;
}

/** Body is returned only for the owner and only while its metadata remains attached to that recipe. */
export async function listRecipeSampleBodies(db: Queryable, owner: OwnerId, recipeId: string): Promise<RecipeSampleBody[] | null> {
  assertOwner(owner);
  if (!validRecipeId(recipeId)) return null;
  const result = await db.query<{ sample_id: string; body: string }>(
    `SELECT b.sample_id, b.body
       FROM recipe_sample_bodies b
       JOIN recipes r ON r.owner = b.owner AND r.id = b.recipe_id
      WHERE b.owner = $1 AND b.recipe_id = $2
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.samples) item WHERE item->>'id' = b.sample_id)
      ORDER BY b.created_at, b.sample_id`,
    [owner, recipeId],
  );
  return result.rows.map((row) => ({ id: row.sample_id, text: row.body }));
}

/** Add metadata and its body in the same owner-serialized transaction. */
export async function putRecipeSample(db: Database, owner: OwnerId, recipeId: string, sample: RecipeSample, body: string): Promise<PutRecipeSampleResult> {
  assertOwner(owner);
  if (!validRecipeId(recipeId) || !validSampleBody(sample, body)) throw new TypeError("editor-store: invalid recipe sample");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`recipes:${owner}`]);
    const locked = await client.query<{ samples: unknown }>("SELECT samples FROM recipes WHERE owner=$1 AND id=$2 FOR UPDATE", [owner, recipeId]);
    const current = locked.rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return "not_found";
    }
    const samples = sampleList(current.samples);
    if (!samples) throw new Error("editor-store: malformed recipe samples");
    if (samples.some((entry) => entry.id === sample.id)) {
      await client.query("ROLLBACK");
      return "conflict";
    }
    if (samples.length >= RECIPE_SAMPLE_MAX_COUNT) {
      await client.query("ROLLBACK");
      return "limit";
    }
    await client.query(
      `UPDATE recipes SET samples=$3::jsonb, revision=revision+1, updated_at=clock_timestamp()
        WHERE owner=$1 AND id=$2`,
      [owner, recipeId, JSON.stringify([...samples, sample])],
    );
    await client.query(
      `INSERT INTO recipe_sample_bodies(owner,recipe_id,sample_id,body)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(owner,recipe_id,sample_id) DO UPDATE SET body=EXCLUDED.body, updated_at=clock_timestamp()`,
      [owner, recipeId, sample.id, body],
    );
    // An old preview would omit this newly attached document. Keep previews aligned with their exact sample set.
    await client.query("DELETE FROM recipe_sample_extractions WHERE owner=$1 AND recipe_id=$2", [owner, recipeId]);
    await client.query("COMMIT");
    return "created";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Persist the proposed guide and only-new term candidates for a later explicit review. */
export async function saveRecipeGuideExtraction(
  db: Database,
  owner: OwnerId,
  recipeId: string,
  sampleIds: readonly string[],
  guide: string,
  candidates: readonly SettingsTerm[],
): Promise<boolean> {
  assertOwner(owner);
  if (!validRecipeId(recipeId) || sampleIds.length < 1 || sampleIds.length > RECIPE_SAMPLE_MAX_COUNT ||
      sampleIds.some((id) => !SETTINGS_ID_PATTERN.test(id)) || new Set(sampleIds).size !== sampleIds.length ||
      typeof guide !== "string" || guide.trim() === "" || Array.from(guide).length > RECIPE_SAMPLE_GUIDE_MAX_CHARS ||
      candidates.length > 200 || !candidates.every(isSettingsTerm)) throw new TypeError("editor-store: invalid recipe guide extraction");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`recipes:${owner}`]);
    const recipe = await client.query<{ samples: unknown }>("SELECT samples FROM recipes WHERE owner=$1 AND id=$2 FOR UPDATE", [owner, recipeId]);
    const metadata = sampleList(recipe.rows[0]?.samples);
    if (!metadata || sampleIds.some((id) => !metadata.some((sample) => sample.id === id))) {
      await client.query("ROLLBACK");
      return false;
    }
    const bodies = await client.query<{ sample_id: string }>(
      "SELECT sample_id FROM recipe_sample_bodies WHERE owner=$1 AND recipe_id=$2 AND sample_id=ANY($3::text[])",
      [owner, recipeId, [...sampleIds]],
    );
    if (new Set(bodies.rows.map((row) => row.sample_id)).size !== sampleIds.length) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `INSERT INTO recipe_sample_extractions(owner,recipe_id,sample_ids,guide,candidates)
       VALUES($1,$2,$3::jsonb,$4,$5::jsonb)
       ON CONFLICT(owner,recipe_id) DO UPDATE
         SET sample_ids=EXCLUDED.sample_ids, guide=EXCLUDED.guide, candidates=EXCLUDED.candidates, created_at=clock_timestamp()`,
      [owner, recipeId, JSON.stringify(sampleIds), guide, JSON.stringify(candidates)],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getRecipeGuideExtraction(db: Queryable, owner: OwnerId, recipeId: string): Promise<RecipeGuideExtraction | null> {
  assertOwner(owner);
  if (!validRecipeId(recipeId)) return null;
  const result = await db.query<{ sample_ids: unknown; guide: string; candidates: unknown; created_at: Date | string }>(
    `SELECT e.sample_ids, e.guide, e.candidates, e.created_at
       FROM recipe_sample_extractions e JOIN recipes r ON r.owner=e.owner AND r.id=e.recipe_id
      WHERE e.owner=$1 AND e.recipe_id=$2`,
    [owner, recipeId],
  );
  const row = result.rows[0];
  if (!row || !Array.isArray(row.sample_ids) || !row.sample_ids.every((id) => typeof id === "string") ||
      !Array.isArray(row.candidates) || !row.candidates.every(isSettingsTerm)) return null;
  const samples = await listRecipeSampleBodies(db, owner, recipeId);
  const sampleIds = row.sample_ids as string[];
  if (!samples || sampleIds.some((id) => !samples.some((sample) => sample.id === id))) return null;
  return { sampleIds, guide: row.guide, candidates: row.candidates as SettingsTerm[], createdAt: new Date(row.created_at).toISOString() };
}
