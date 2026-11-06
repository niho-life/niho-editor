import { randomUUID } from "node:crypto";
import { SETTINGS_ID_PATTERN, SETTINGS_LIMITS, isSettingsTerm, isSettingsText, type SettingsTerm } from "./settings.ts";
import type { Database, OwnerId, Queryable } from "./types.ts";

/**
 * 手順の実体（表 recipes。migration 20261101001500_recipes。docs/architecture/editor-recipes-and-folders.md §2）。
 *
 * - owner ごとの行。既定の 3 つ（記事制作・議事録・インサイト整理）も行として入る（`origin` が `builtin`）。
 *   行が 1 つも無い owner の最初の読み出しで既定を写して入れるのは editor-web（src/server/recipe-source.ts）。
 *   この package は docs-core に依存しないので、既定の中身（指示文の正）は持たない。
 * - 1 つの手順が持つのは、工程（プロファイル込み）・お手本（guide・samples）・この手順の固有名詞（terms）。
 *   アカウント共通の固有名詞は `editor_settings.glossary`（0013）のまま。
 * - 書き込みは `putRecipes` で全部入れ替える（部分的な継ぎ足しをしない）。同時の保存は後から来たものが勝つ。
 * - 検証はここの純粋な関数（`recipesProblem`）が 1 か所で決め、API はそれで 400 を返す。保存は assert で守る。
 */

/** builtin＝既定の 3 つの写し、own＝この人が足した、import＝旧 NIHO docs から取り込んだ（取り込みは未実装）。 */
export const RECIPE_ORIGINS = ["builtin", "own", "import"] as const;
export type RecipeOrigin = (typeof RECIPE_ORIGINS)[number];

/**
 * 1 つの工程。`id` は成果物のサブページに結ぶ固定の文字列、`profile` は AI の設定のプロファイル名（標準・高性能・軽量）。
 * `provider` は工程が指す AI（無ければ登録した AI の先頭）。どちらの名前も editor-web 側（docs-core）が決めるので、
 * ここでは短い文字列としてだけ見る。
 */
export type RecipeStep = {
  id: string;
  name: string;
  instruction: string;
  profile: string;
  provider?: string;
  /** 長い入力を区切って処理する（全文を書き直す段階。#277）。無い古い行は false。 */
  chunked?: boolean;
};

/** お手本の文書 1 つ（本文は資産として別に置く。docs-core の `FlowSample` と同じ形）。 */
export type RecipeSample = {
  id: string;
  name: string;
  chars: number;
  truncatedFrom?: number;
  sourceUrl?: string;
};

/** 表から読んだ手順 1 つ。 */
export type StoredRecipe = {
  id: string;
  name: string;
  /** お手本（文書ガイド。全工程の入力に入る Markdown）。 */
  guide: string;
  steps: RecipeStep[];
  /** この手順の固有名詞と誤りやすい表記。 */
  terms: SettingsTerm[];
  samples: RecipeSample[];
  origin: RecipeOrigin;
  /** 一覧の並び（0 から。同じ値なら id の順）。 */
  sortOrder: number;
  /** 保存のたびに 1 つ増える。 */
  revision: number;
  /** 取り込んだ行の元の id（取り込みでなければ null）。 */
  importedFrom: string | null;
};

/** 保存する手順 1 つ（並びは渡した順、`revision` は表が数える）。 */
export type RecipeInput = {
  id: string;
  name: string;
  guide?: string;
  steps: RecipeStep[];
  terms?: SettingsTerm[];
  samples?: RecipeSample[];
  origin?: RecipeOrigin;
  importedFrom?: string | null;
};

/** 画面と API が守る上限（表の CHECK は件数だけを見る）。手順・工程の分は設定（0013）と同じ値を使う。 */
export const RECIPE_LIMITS = Object.freeze({
  recipes: SETTINGS_LIMITS.recipes,
  nameChars: SETTINGS_LIMITS.recipeNameChars,
  guideChars: SETTINGS_LIMITS.guideChars,
  steps: SETTINGS_LIMITS.steps,
  stepNameChars: SETTINGS_LIMITS.stepNameChars,
  instructionChars: SETTINGS_LIMITS.instructionChars,
  terms: SETTINGS_LIMITS.glossary,
  profileChars: 64,
  providerChars: 32,
  samples: 5,
  sampleNameChars: 200,
  sampleUrlChars: 2000,
});

/** 検証が断る理由（API はこれをそのまま返さない。短い code だけを返す）。 */
export type RecipeProblem = "count" | "id" | "name" | "guide" | "steps" | "terms" | "samples" | "origin";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isCount(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

export function isRecipeOrigin(value: unknown): value is RecipeOrigin {
  return typeof value === "string" && (RECIPE_ORIGINS as readonly string[]).includes(value);
}

export function isRecipeStep(value: unknown): value is RecipeStep {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id", "name", "instruction", "profile", "provider", "chunked"])) return false;
  if (value.chunked !== undefined && typeof value.chunked !== "boolean") return false;
  if (typeof value.id !== "string" || !SETTINGS_ID_PATTERN.test(value.id)) return false;
  if (!isSettingsText(value.name, RECIPE_LIMITS.stepNameChars) || value.name.trim() === "") return false;
  if (!isSettingsText(value.instruction, RECIPE_LIMITS.instructionChars, true)) return false;
  if (!isSettingsText(value.profile, RECIPE_LIMITS.profileChars) || value.profile.trim() === "") return false;
  return value.provider === undefined || (isSettingsText(value.provider, RECIPE_LIMITS.providerChars) && value.provider.trim() !== "");
}

export function isRecipeSample(value: unknown): value is RecipeSample {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id", "name", "chars", "truncatedFrom", "sourceUrl"])) return false;
  if (typeof value.id !== "string" || !SETTINGS_ID_PATTERN.test(value.id)) return false;
  if (!isSettingsText(value.name, RECIPE_LIMITS.sampleNameChars) || value.name.trim() === "") return false;
  // 字数は保存した本文の長さ（2^31 までの整数）。本文そのものはこの表に持たない
  if (!isCount(value.chars, 2_147_483_647)) return false;
  if (value.truncatedFrom !== undefined && !isCount(value.truncatedFrom, 2_147_483_647)) return false;
  return value.sourceUrl === undefined || isSettingsText(value.sourceUrl, RECIPE_LIMITS.sampleUrlChars);
}

/** 1 つの手順に通らないところがあれば、その項目を返す（無ければ null）。 */
export function recipeProblem(value: unknown): RecipeProblem | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id", "name", "guide", "steps", "terms", "samples", "origin", "importedFrom"])) {
    return "id";
  }
  if (typeof value.id !== "string" || !SETTINGS_ID_PATTERN.test(value.id)) return "id";
  if (!isSettingsText(value.name, RECIPE_LIMITS.nameChars) || value.name.trim() === "") return "name";
  if (value.guide !== undefined && !isSettingsText(value.guide, RECIPE_LIMITS.guideChars, true)) return "guide";
  // 工程が 1 つも無い手順は実行できない
  if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > RECIPE_LIMITS.steps) return "steps";
  if (!value.steps.every(isRecipeStep)) return "steps";
  const stepIds = (value.steps as RecipeStep[]).map((step) => step.id);
  if (new Set(stepIds).size !== stepIds.length) return "steps";
  if (value.terms !== undefined) {
    if (!Array.isArray(value.terms) || value.terms.length > RECIPE_LIMITS.terms || !value.terms.every(isSettingsTerm)) return "terms";
  }
  if (value.samples !== undefined) {
    if (!Array.isArray(value.samples) || value.samples.length > RECIPE_LIMITS.samples || !value.samples.every(isRecipeSample)) return "samples";
    const sampleIds = (value.samples as RecipeSample[]).map((sample) => sample.id);
    if (new Set(sampleIds).size !== sampleIds.length) return "samples";
  }
  if (value.origin !== undefined && !isRecipeOrigin(value.origin)) return "origin";
  if (value.importedFrom !== undefined && value.importedFrom !== null) {
    if (!isSettingsText(value.importedFrom, 256) || value.importedFrom.trim() === "" || value.origin !== "import") return "origin";
  }
  return null;
}

/** 手順の一覧に通らないところがあれば、その項目を返す（無ければ null）。 */
export function recipesProblem(value: unknown): RecipeProblem | null {
  if (!Array.isArray(value) || value.length > RECIPE_LIMITS.recipes) return "count";
  for (const recipe of value) {
    const problem = recipeProblem(recipe);
    if (problem) return problem;
  }
  const ids = (value as RecipeInput[]).map((recipe) => recipe.id);
  return new Set(ids).size === ids.length ? null : "id";
}

/** 前後の空白を落として整える（保存の直前に 1 回だけ通す）。 */
export function cleanRecipe(recipe: RecipeInput): Required<Omit<RecipeInput, "importedFrom">> & { importedFrom: string | null } {
  return {
    id: recipe.id,
    name: recipe.name.trim(),
    guide: (recipe.guide ?? "").trim(),
    steps: recipe.steps.map((step) => ({
      id: step.id,
      name: step.name.trim(),
      instruction: step.instruction.trim(),
      profile: step.profile.trim(),
      ...(step.provider === undefined ? {} : { provider: step.provider.trim() }),
      ...(step.chunked === true ? { chunked: true } : {}),
    })),
    terms: (recipe.terms ?? []).map((term) => ({
      term: term.term.trim(),
      reading: term.reading.trim(),
      variants: term.variants.map((variant) => variant.trim()).filter((variant) => variant !== ""),
      note: term.note.trim(),
    })),
    samples: (recipe.samples ?? []).map((sample) => ({ ...sample, name: sample.name.trim() })),
    origin: recipe.origin ?? "own",
    importedFrom: recipe.importedFrom ?? null,
  };
}

function assertOwner(owner: OwnerId): void {
  // store.ts と同じ守り（空の owner で誰のものでもない行を読み書きしない）
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) {
    throw new TypeError("editor-store: owner must be a non-empty stable user id");
  }
}

type RecipeRow = {
  id: string;
  name: string;
  guide: string;
  steps: unknown;
  terms: unknown;
  samples: unknown;
  origin: string;
  sort_order: number;
  revision: number;
  imported_from: string | null;
};

/** 保存した値が今の形に合わなければ落として読む（古い行・手で直した行で画面を壊さない）。 */
function toRecipe(row: RecipeRow): StoredRecipe {
  return {
    id: row.id,
    name: row.name,
    guide: row.guide,
    steps: Array.isArray(row.steps) ? row.steps.filter(isRecipeStep) : [],
    terms: Array.isArray(row.terms) ? row.terms.filter(isSettingsTerm) : [],
    samples: Array.isArray(row.samples) ? row.samples.filter(isRecipeSample) : [],
    origin: isRecipeOrigin(row.origin) ? row.origin : "own",
    sortOrder: row.sort_order,
    revision: row.revision,
    importedFrom: row.imported_from,
  };
}

export type DuplicateRecipeResult =
  | { status: "created"; recipe: StoredRecipe }
  | { status: "not_found" }
  | { status: "limit" }
  | { status: "samples_missing" };

function recipeCopyName(source: string, usedNames: readonly string[]): string {
  const used = new Set(usedNames.map((name) => name.normalize("NFKC").trim()));
  const base = `${source.trim()}のコピー`;
  for (let suffix = 1; ; suffix += 1) {
    const tail = suffix === 1 ? "" : ` ${suffix}`;
    const prefix = Array.from(base).slice(0, Math.max(1, RECIPE_LIMITS.nameChars - Array.from(tail).length)).join("");
    const candidate = `${prefix}${tail}`;
    if (!used.has(candidate.normalize("NFKC").trim())) return candidate;
  }
}

/** Duplicate a recipe and its private sample bodies atomically; review previews are intentionally not copied. */
export async function duplicateRecipeWithSamples(db: Database, owner: OwnerId, recipeId: string): Promise<DuplicateRecipeResult> {
  assertOwner(owner);
  if (typeof recipeId !== "string" || !SETTINGS_ID_PATTERN.test(recipeId)) throw new TypeError("editor-store: invalid recipe id");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`recipes:${owner}`]);
    const sourceResult = await client.query<RecipeRow>(`SELECT ${COLUMNS} FROM recipes WHERE owner=$1 AND id=$2 FOR UPDATE`, [owner, recipeId]);
    const source = sourceResult.rows[0] ? toRecipe(sourceResult.rows[0]) : null;
    if (!source || source.steps.length === 0) {
      await client.query("ROLLBACK");
      return { status: "not_found" };
    }
    const count = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM recipes WHERE owner=$1", [owner]);
    if ((count.rows[0]?.count ?? 0) >= RECIPE_LIMITS.recipes) {
      await client.query("ROLLBACK");
      return { status: "limit" };
    }
    const names = await client.query<{ name: string }>("SELECT name FROM recipes WHERE owner=$1", [owner]);
    const sampleBodies = await client.query<{ sample_id: string; body: string }>(
      "SELECT sample_id,body FROM recipe_sample_bodies WHERE owner=$1 AND recipe_id=$2 AND sample_id=ANY($3::text[])",
      [owner, recipeId, source.samples.map((sample) => sample.id)],
    );
    if (sampleBodies.rows.length !== source.samples.length) {
      await client.query("ROLLBACK");
      return { status: "samples_missing" };
    }

    const duplicateId = (prefix: string) => `${prefix}-${randomUUID().replaceAll("-", "")}`;
    const sampleIdMap = new Map(source.samples.map((sample) => [sample.id, duplicateId("sample")] as const));
    const steps = source.steps.map((step) => ({ ...step, id: duplicateId("s") }));
    const samples = source.samples.map((sample) => ({ ...sample, id: sampleIdMap.get(sample.id)! }));
    const duplicate: RecipeInput = {
      id: duplicateId("r"),
      name: recipeCopyName(source.name, names.rows.map((row) => row.name)),
      guide: source.guide,
      steps,
      terms: source.terms,
      samples,
      origin: "own",
      importedFrom: null,
    };
    assertStorable([duplicate]);
    const sortOrder = await client.query<{ sort_order: number }>("SELECT COALESCE(max(sort_order),-1)+1 AS sort_order FROM recipes WHERE owner=$1", [owner]);
    const inserted = await client.query<RecipeRow>(
      `INSERT INTO recipes(owner,id,name,guide,steps,terms,samples,origin,sort_order,revision,imported_from)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,'own',$8,1,NULL)
       RETURNING ${COLUMNS}`,
      [owner, duplicate.id, duplicate.name, duplicate.guide, JSON.stringify(duplicate.steps), JSON.stringify(duplicate.terms), JSON.stringify(duplicate.samples), sortOrder.rows[0]?.sort_order ?? 0],
    );
    if (source.samples.length > 0) {
      const copied = await client.query(
        `INSERT INTO recipe_sample_bodies(owner,recipe_id,sample_id,body)
         SELECT $1,$2,m.new_id,b.body
           FROM unnest($3::text[],$4::text[]) AS m(old_id,new_id)
           JOIN recipe_sample_bodies b ON b.owner=$1 AND b.recipe_id=$5 AND b.sample_id=m.old_id`,
        [owner, duplicate.id, source.samples.map((sample) => sample.id), source.samples.map((sample) => sampleIdMap.get(sample.id)!), recipeId],
      );
      if (copied.rowCount !== source.samples.length) throw new Error("editor-store: recipe sample copy was incomplete");
    }
    await client.query("COMMIT");
    const row = inserted.rows[0];
    if (!row) throw new Error("editor-store: duplicated recipe was not returned");
    return { status: "created", recipe: toRecipe(row) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const COLUMNS = "id, name, guide, steps, terms, samples, origin, sort_order, revision, imported_from";
const ORDER = "ORDER BY sort_order, id";

/** その人の手順（並びの順。1 つも無ければ空の配列）。 */
export async function listRecipes(db: Queryable, owner: OwnerId): Promise<StoredRecipe[]> {
  assertOwner(owner);
  const result = await db.query<RecipeRow>(`SELECT ${COLUMNS} FROM recipes WHERE owner = $1 ${ORDER}`, [owner]);
  return result.rows.map(toRecipe);
}

/** 1 つの INSERT … SELECT unnest（並びは渡した順）。 */
const INSERT = `INSERT INTO recipes (owner, id, name, guide, steps, terms, samples, origin, sort_order, imported_from)
     SELECT $1, t.id, t.name, t.guide, t.steps, t.terms, t.samples, t.origin, t.sort_order, t.imported_from
       FROM unnest($2::text[], $3::text[], $4::text[], $5::jsonb[], $6::jsonb[], $7::jsonb[], $8::text[], $9::int[], $10::text[])
         AS t(id, name, guide, steps, terms, samples, origin, sort_order, imported_from)`;

function insertParams(owner: OwnerId, recipes: readonly RecipeInput[]): unknown[] {
  const cleaned = recipes.map(cleanRecipe);
  return [
    owner,
    cleaned.map((recipe) => recipe.id),
    cleaned.map((recipe) => recipe.name),
    cleaned.map((recipe) => recipe.guide),
    cleaned.map((recipe) => JSON.stringify(recipe.steps)),
    cleaned.map((recipe) => JSON.stringify(recipe.terms)),
    cleaned.map((recipe) => JSON.stringify(recipe.samples)),
    cleaned.map((recipe) => recipe.origin),
    cleaned.map((_, index) => index),
    cleaned.map((recipe) => recipe.importedFrom),
  ];
}

function assertStorable(recipes: readonly RecipeInput[]): void {
  const problem = recipesProblem(recipes);
  if (problem) throw new TypeError(`editor-store: recipes.${problem} is not storable`);
}

/**
 * その人の手順をすべて入れ替える（渡した順が並び）。渡さなかった手順は消える。
 * 1 つの transaction で「無くなったものを消す → 渡したものを入れる／直す」。中身が変わった手順だけ `revision` が増える。
 */
export async function putRecipes(db: Database, owner: OwnerId, recipes: readonly RecipeInput[]): Promise<StoredRecipe[]> {
  assertOwner(owner);
  assertStorable(recipes);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // 同じ人の入れ替えを 1 本ずつにする。ロック無しだと、重なった 2 本が互いの追加を見ないまま DELETE を済ませ、
    // どちらの一覧とも違う「2 本の和」が残る（後から来た保存が前の保存を置き換える、にならない）
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`recipes:${owner}`]);
    const params = insertParams(owner, recipes);
    // A preview belongs to the exact recipe sample set that was reviewed. Adding or changing samples
    // invalidates it too, even when every sample it referenced is still present.
    await client.query(
      `DELETE FROM recipe_sample_extractions AS extraction
        USING recipes AS current
        JOIN unnest($2::text[], $3::jsonb[]) AS incoming(id, samples) ON incoming.id = current.id
       WHERE extraction.owner = $1 AND extraction.recipe_id = current.id
         AND current.owner = $1 AND current.samples IS DISTINCT FROM incoming.samples`,
      [owner, params[1], params[6]],
    );
    await client.query("DELETE FROM recipes WHERE owner = $1 AND NOT (id = ANY($2::text[]))", [owner, params[1]]);
    const result = await client.query<RecipeRow>(
      `${INSERT}
       ON CONFLICT (owner, id) DO UPDATE
          SET name = EXCLUDED.name,
              guide = EXCLUDED.guide,
              steps = EXCLUDED.steps,
              terms = EXCLUDED.terms,
              samples = EXCLUDED.samples,
              origin = EXCLUDED.origin,
              sort_order = EXCLUDED.sort_order,
              imported_from = EXCLUDED.imported_from,
              -- 中身が同じ保存（並べ替えだけ）では版を増やさない
              revision = recipes.revision + (
                CASE
                  WHEN recipes.name IS DISTINCT FROM EXCLUDED.name
                    OR recipes.guide IS DISTINCT FROM EXCLUDED.guide
                    OR recipes.steps IS DISTINCT FROM EXCLUDED.steps
                    OR recipes.terms IS DISTINCT FROM EXCLUDED.terms
                    OR recipes.samples IS DISTINCT FROM EXCLUDED.samples
                  THEN 1
                  ELSE 0
                END
              ),
              updated_at = clock_timestamp()
       RETURNING ${COLUMNS}`,
      params,
    );
    // Sample bytes and extraction previews live outside the recipe JSON. Removing a sample from settings
    // removes its body in this same transaction and invalidates previews that referenced it.
    await client.query(
      `DELETE FROM recipe_sample_bodies b
        WHERE b.owner=$1 AND NOT EXISTS (
          SELECT 1 FROM recipes r
           WHERE r.owner=b.owner AND r.id=b.recipe_id
             AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.samples) sample WHERE sample->>'id'=b.sample_id)
        )`,
      [owner],
    );
    await client.query(
      `DELETE FROM recipe_sample_extractions e
        WHERE e.owner=$1 AND NOT EXISTS (
          SELECT 1 FROM recipes r
           WHERE r.owner=e.owner AND r.id=e.recipe_id
             AND NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(e.sample_ids) requested(sample_id)
                WHERE NOT EXISTS (
                  SELECT 1 FROM jsonb_array_elements(r.samples) sample WHERE sample->>'id'=requested.sample_id
                ) OR NOT EXISTS (
                  SELECT 1 FROM recipe_sample_bodies body
                   WHERE body.owner=e.owner AND body.recipe_id=e.recipe_id AND body.sample_id=requested.sample_id
                )
             )
        )`,
      [owner],
    );
    await client.query("COMMIT");
    return result.rows.map(toRecipe).sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * まだ無い手順だけを足す（既定の手順が増えたとき。`recipe-source.ts` が呼ぶ）。既にある行は中身も並びも触らない。
 * 足した手順は今の並びの後ろに付く。入れたあとの一覧を返す。
 */
export async function addRecipes(db: Queryable, owner: OwnerId, recipes: readonly RecipeInput[]): Promise<StoredRecipe[]> {
  assertOwner(owner);
  assertStorable(recipes);
  if (recipes.length > 0) {
    const params = insertParams(owner, recipes);
    await db.query(
      // 並びは「今の末尾の次」から、渡した順に 1 つずつ（既にある手順は数えない）
      `INSERT INTO recipes (owner, id, name, guide, steps, terms, samples, origin, sort_order, imported_from)
       SELECT $1, t.id, t.name, t.guide, t.steps, t.terms, t.samples, t.origin,
              base.next + (row_number() OVER (ORDER BY t.sort_order)) - 1,
              t.imported_from
         FROM unnest($2::text[], $3::text[], $4::text[], $5::jsonb[], $6::jsonb[], $7::jsonb[], $8::text[], $9::int[], $10::text[])
           AS t(id, name, guide, steps, terms, samples, origin, sort_order, imported_from)
        CROSS JOIN (SELECT COALESCE(max(sort_order), -1) + 1 AS next FROM recipes WHERE owner = $1) AS base
        WHERE NOT EXISTS (SELECT 1 FROM recipes existing WHERE existing.owner = $1 AND existing.id = t.id)
       ON CONFLICT (owner, id) DO NOTHING`,
      params,
    );
  }
  return listRecipes(db, owner);
}

/**
 * その人に手順が 1 つも無ければ、渡した手順を入れる（既定の 3 つの引き継ぎ。`recipe-source.ts` が呼ぶ）。
 * 行が 1 つでもあれば何も書かない（消した手順を勝手に戻さない）。どちらでも、入れたあとの一覧を返す。
 * 同時に 2 本走っても `ON CONFLICT DO NOTHING` で片方だけが入る。
 */
export async function seedRecipes(db: Queryable, owner: OwnerId, recipes: readonly RecipeInput[]): Promise<StoredRecipe[]> {
  assertOwner(owner);
  assertStorable(recipes);
  if (recipes.length > 0) {
    await db.query(
      `${INSERT}
          WHERE NOT EXISTS (SELECT 1 FROM recipes existing WHERE existing.owner = $1)
       ON CONFLICT (owner, id) DO NOTHING`,
      insertParams(owner, recipes),
    );
  }
  return listRecipes(db, owner);
}
