import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isPageId } from "./store.ts";
import type { Block, OwnerId, Queryable, StepStatus } from "./types.ts";
import { parseRecipeSnapshot, snapshotOf, type RecipeSnapshot } from "./recipe-snapshot.ts";
import { computeChunkBasis, computeStepBasis, parseStepBasis, stepStaleReasons, type StepBasis, type StepMaterials, type StepStaleReason } from "./step-basis.ts";
import { isPageEntity } from "./page-fields.ts";
import { isSettingsTerm } from "./settings.ts";
export { parseRecipeSnapshot, snapshotOf, type RecipeSnapshot } from "./recipe-snapshot.ts";

/**
 * 手順（#37）の実行の層。docs/architecture/editor-steps-execution.md §5（方式 B）。
 *
 * 状態遷移はすべて「世代（generation）と状態を条件にした UPDATE」（CAS）で行い、読んだ値をもとに書かない。
 * 複数の行を書く遷移は 1 transaction で、最初に run の行を FOR UPDATE で取る（同じ run の遷移を直列にし、
 * 行の lock の順を run → attempt → ページ に固定してデッドロックを避ける）。サブページを書くのは、その親で
 * 進行中の唯一の run だけ（step_runs_active_idx）なので、別の run とサブページの lock を取り合わない。
 */

export const RUN_STATES = ["queued", "running", "succeeded", "failed", "canceled"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const ATTEMPT_STATES = ["pending", "queued", "running", "succeeded", "failed", "canceled", "reused"] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

/** 1 つの段階を実行する回数の上限（自動の再試行は 2 回まで。設計 §7）。 */
export const MAX_TRIES = 3;

/** lease の既定の長さ（秒）。実行する側は 1/3 おきに生存確認で延ばす。 */
export const DEFAULT_LEASE_SECONDS = 120;

const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** エラーの種類の code（短い英小文字・数字・_ だけ。本文や内部の情報は入れない）。 */
export function isStepErrorCode(value: unknown): value is string {
  return typeof value === "string" && ERROR_CODE_PATTERN.test(value);
}

/** `Idempotency-Key` の値（1〜128 の英数字と `-` `_`）。 */
export function isIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY_PATTERN.test(value);
}

/**
 * 手順の定義（editor-web が docs-core のテンプレートから作って渡すデータ。この package は docs-core に依存しない）。
 * editor-web の `RecipeDef` をそのまま渡せる形。
 */
export type StepRecipe = {
  readonly id: string;
  readonly name?: string;
  readonly guide?: string;
  readonly revision?: number;
  readonly terms?: RecipeSnapshot["terms"];
  readonly samples?: RecipeSnapshot["samples"];
  readonly steps: readonly { readonly id: string; readonly name: string; readonly instruction: string; readonly profile?: string; readonly chunked?: boolean }[];
};

/** この層が使う pg の Pool の部分（transaction のために connect も使う）。 */
export type StepRunsDb = Pick<Pool, "query" | "connect">;

export type StepRunStepView = {
  index: number;
  stepId: string;
  state: AttemptState;
  pageId: string;
  /** サブページの段階の状態（サブページが削除されていれば null）。 */
  stepStatus: StepStatus | null;
  tries: number;
  errorCode: string | null;
  /** 本文を含めず、本人が明示取得できる途中出力があるかだけを返す。 */
  hasPartialOutput?: boolean;
  /** 済みの段階で、資料を上限で切ったときだけ、実際に使った字数（code point。#277）。 */
  inputUsedChars?: number;
  /** 区切って処理している（いた）段階の進み（`index` は終えた区切りの数）。待ち・実行中・失敗のときだけ（#277）。 */
  chunk?: { index: number; count: number };
};

export type StepRunView = {
  id: string;
  recipe: string;
  state: RunState;
  fromStep: number;
  recipeSnapshot: RecipeSnapshot;
  recipeRevision: number;
  steps: StepRunStepView[];
};

// ---------------------------------------------------------------------------
// 純粋な部分

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 段階の結果を書くサブページの id。親・recipe・段階から決定的に作る（作り直しても同じページになる）。
 * `sha256(parent + ':' + recipe + ':' + stepIndex)` の先頭 16 byte を UUID v5 の形（version 5・RFC 4122 の variant）に整える。
 */
export function stepPageId(parentId: string, recipeId: string, stepIndex: number): string {
  const digest = createHash("sha256").update(`${parentId.toLowerCase()}:${recipeId}:${stepIndex}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return formatUuid(bytes);
}

/** New artifact identity: bind the page to the stable step ID, not its current position. */
export function stepPageIdForStep(parentId: string, recipeId: string, stepId: string): string {
  const digest = createHash("sha256").update(`${parentId.toLowerCase()}:${recipeId}:step:${stepId}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return formatUuid(bytes);
}

/** Historical generated titles for pages that were the final step in a run snapshot. */
export async function finalStepPageNames(db: Queryable, owner: OwnerId, pageId: string): Promise<string[]> {
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256 || !isPageId(pageId)) return [];
  const result = await db.query<{ name: string }>(
    `SELECT DISTINCT r.recipe_snapshot->'steps'->a.step_index->>'name' AS name
       FROM step_attempts a
       JOIN step_runs r ON r.id=a.run_id
      WHERE r.owner=$1 AND a.page_id=$2
        AND CASE
          WHEN jsonb_typeof(r.recipe_snapshot->'steps')='array'
          THEN a.step_index >= 0
            AND a.step_index=jsonb_array_length(r.recipe_snapshot->'steps')-1
            AND r.recipe_snapshot->'steps'->a.step_index->>'id'=a.step_id
            AND r.recipe_snapshot->'steps'->a.step_index->>'name' IS NOT NULL
          ELSE false
        END
      ORDER BY name`,
    [owner, pageId],
  );
  return result.rows.map((row) => row.name).filter((name) => typeof name === "string");
}

/** キーを辞書順に並べた JSON（同じ内容なら key の順に関わらず同じ文字列）。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** docs-core の hashText の写し（64 bit の非暗号のハッシュ。16 進 16 文字）。 */
function hashText(text: string): string {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/**
 * 指示文の前提。docs-core の `stepHash` と同じ値（前後の空白だけの違いは同じ）。
 * この package を docs-core に依存させないため写しを持ち、editor-web の test（src/steps/recipes.test.ts）が一致を確かめる。
 */
export function instructionHash(instruction: string): string {
  return hashText(instruction.trim());
}

/**
 * 段階の入力の基準（前提変更の判定に使う）。`sha256(正規化した前の段階の blocks の JSON + '\n' + stepHash(指示文))`。
 * 段階 0 の「前の段階」は録音ページの blocks。
 */
export function computeBasis(prevBlocks: readonly Block[], instruction: string): string {
  return createHash("sha256").update(`${canonicalJson(prevBlocks)}\n${instructionHash(instruction)}`).digest("hex");
}

// ---------------------------------------------------------------------------
// DB の部分

function assertOwner(owner: OwnerId): void {
  // 認証の層の誤りで空の owner が来たときに、誰のものでもない行を読み書きしないための守り（store.ts と同じ）
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) {
    throw new TypeError("editor-store: owner must be a non-empty stable user id");
  }
}

function assertRecipe(recipe: StepRecipe): void {
  if (typeof recipe.id !== "string" || recipe.id.length === 0 || recipe.id.length > 256 || recipe.steps.length === 0) {
    throw new TypeError("editor-store: recipe must have an id and at least one step");
  }
}

function snapshotFromRecipe(recipe: StepRecipe): RecipeSnapshot {
  return snapshotOf({
    id: recipe.id,
    name: recipe.name ?? recipe.id,
    guide: recipe.guide ?? "",
    steps: recipe.steps.map((step) => ({ id: step.id, name: step.name, instruction: step.instruction, profile: step.profile ?? "standard", ...(step.chunked === true ? { chunked: true } : {}) })),
    terms: recipe.terms ?? [],
    samples: recipe.samples ?? [],
  });
}

function assertLease(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) throw new RangeError("editor-store: lease must be 0 < seconds <= 3600");
}

/** 書いたものを捨てて値を返す（transaction の中から使う）。 */
class Rollback<T> {
  readonly value: T;
  constructor(value: T) {
    this.value = value;
  }
}

async function inTransaction<T>(db: StepRunsDb, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    let result: T;
    try {
      result = await work(client);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof Rollback) return error.value as T;
      throw error;
    }
    await client.query("COMMIT");
    return result;
  } finally {
    client.release();
  }
}

type ViewRow = {
  id: string;
  recipe: string;
  state: RunState;
  from_step: number;
  recipe_snapshot: unknown;
  recipe_revision: number | null;
  step_index: number;
  step_id: string;
  step_state: AttemptState;
  page_id: string;
  tries: number;
  error_code: string | null;
  step_status: StepStatus | null;
  has_partial_output: boolean;
  input_used_chars: number | null;
  chunk_count: number | null;
  chunk_index: number;
};

async function loadRunView(db: Queryable, owner: OwnerId, runId: string): Promise<StepRunView | null> {
  const result = await db.query<ViewRow>(
    `SELECT r.id, r.recipe, r.state, r.from_step, r.recipe_snapshot, r.recipe_revision,
            a.step_index, a.step_id, a.state AS step_state, a.page_id, a.tries, a.error_code,
            p.step_status,
            CASE WHEN r.state = 'failed' AND a.state = 'failed' AND p.id IS NOT NULL
                   AND jsonb_typeof(a.partial_blocks) = 'array'
                 THEN jsonb_array_length(a.partial_blocks) > 0 ELSE false END AS has_partial_output,
            CASE WHEN a.state = 'succeeded' THEN a.input_used_chars END AS input_used_chars,
            CASE WHEN a.state IN ('queued', 'running', 'failed') THEN a.chunk_count END AS chunk_count,
            a.chunk_index
       FROM step_runs r
       JOIN step_attempts a ON a.run_id = r.id
       LEFT JOIN pages p ON p.id = a.page_id AND p.owner = r.owner AND p.deleted_at IS NULL
      WHERE r.owner = $1 AND r.id = $2
      ORDER BY a.step_index`,
    [owner, runId],
  );
  const first = result.rows[0];
  if (!first) return null;
  const recipeSnapshot = parseRecipeSnapshot(first.recipe_snapshot);
  if (!recipeSnapshot || recipeSnapshot.id !== first.recipe || !Number.isInteger(first.recipe_revision) || (first.recipe_revision ?? 0) < 1) {
    throw new Error("editor-store: invalid run recipe snapshot");
  }
  return {
    id: first.id,
    recipe: first.recipe,
    state: first.state,
    fromStep: first.from_step,
    recipeSnapshot,
    recipeRevision: first.recipe_revision!,
    steps: result.rows.map((row) => ({
      index: row.step_index,
      stepId: row.step_id,
      state: row.step_state,
      pageId: row.page_id,
      stepStatus: row.step_status,
      tries: row.tries,
      errorCode: row.error_code,
      ...(row.has_partial_output ? { hasPartialOutput: true } : {}),
      ...(row.input_used_chars !== null && row.input_used_chars !== undefined ? { inputUsedChars: row.input_used_chars } : {}),
      ...(row.chunk_count !== null && row.chunk_count !== undefined ? { chunk: { index: row.chunk_index, count: row.chunk_count } } : {}),
    })),
  };
}

async function requireRunView(db: Queryable, owner: OwnerId, runId: string): Promise<StepRunView> {
  const view = await loadRunView(db, owner, runId);
  if (!view) throw new Error("editor-store: run disappeared");
  return view;
}

export type CreateRunInput = {
  recipe: StepRecipe;
  /** ここから作り直す（既定 0）。前の段階は完了済みのサブページを再利用する。 */
  fromStep?: number;
  idempotencyKey?: string | null;
};

export type CreateRunResult =
  | { status: "created"; run: StepRunView }
  /** 同じ `Idempotency-Key` の run が既にある（新しく作らない）。 */
  | { status: "existing"; run: StepRunView }
  /** 親が本人の録音ページでない（別の人・削除済み・存在しない・不正な id）。404 にする。 */
  | { status: "not_found" }
  /** 同じ録音ページで queued / running の run が既にある。409 にする。 */
  | { status: "run_in_progress" }
  /** `fromStep` より前に完了済みのサブページが無い段階がある。400 にする。 */
  | { status: "invalid_from_step" }
  | { status: "recipe_changed" };

/**
 * run を作る。`fromStep` 以降のサブページを用意して `wait` に戻し（削除されていれば戻す）、`fromStep` の attempt を
 * `queued`・以降を `pending`・前を `reused` にする。親・冪等・進行中の検査と作成を同じ transaction で行う。
 */
export async function createRun(db: StepRunsDb, owner: OwnerId, parentId: string, input: CreateRunInput): Promise<CreateRunResult> {
  assertOwner(owner);
  assertRecipe(input.recipe);
  const { recipe } = input;
  const fromStep = input.fromStep ?? 0;
  if (!Number.isInteger(fromStep) || fromStep < 0) {
    throw new RangeError("editor-store: fromStep is out of range");
  }
  const key = input.idempotencyKey ?? null;
  if (key !== null && !isIdempotencyKey(key)) throw new TypeError("editor-store: invalid idempotency key");
  if (!isPageId(parentId)) return { status: "not_found" };

  return inTransaction<CreateRunResult>(db, async (client) => {
    // 親が本人の生きている録音ページであること（作り終えるまで削除させない）
    const parent = await client.query<{ id: string; lang: string }>(
      `SELECT id, lang FROM pages
        WHERE owner = $1 AND id = $2 AND kind = 'rec' AND deleted_at IS NULL
        FOR UPDATE`,
      [owner, parentId],
    );
    const parentRow = parent.rows[0];
    if (!parentRow) throw new Rollback<CreateRunResult>({ status: "not_found" });
    const parentKey = parentRow.id;

    const existingByKey = async (): Promise<string | null> => {
      if (key === null) return null;
      const found = await client.query<{ id: string }>("SELECT id FROM step_runs WHERE owner = $1 AND idempotency_key = $2", [owner, key]);
      return found.rows[0]?.id ?? null;
    };
    const replay = await existingByKey();
    if (replay) return { status: "existing", run: await requireRunView(client, owner, replay) } satisfies CreateRunResult;

    // A recipe save takes the same row lock. A first run cannot capture a stale read.
    const current = await client.query<{ revision: number }>(
      "SELECT revision FROM recipes WHERE owner = $1 AND id = $2 FOR SHARE", [owner, recipe.id],
    );
    const currentRevision = current.rows[0]?.revision;
    if (currentRevision === undefined || (recipe.revision !== undefined && currentRevision !== recipe.revision)) {
      throw new Rollback<CreateRunResult>({ status: "recipe_changed" });
    }
    const previous = await client.query<{ id: string; recipe_snapshot: unknown; recipe_revision: number | null }>(
      `SELECT id, recipe_snapshot, recipe_revision FROM step_runs
        WHERE owner = $1 AND parent = $2 AND recipe = $3
        ORDER BY created_at DESC, id DESC LIMIT 1 FOR SHARE`,
      [owner, parentKey, recipe.id],
    );
    const prior = previous.rows[0];
    const snapshot = prior ? parseRecipeSnapshot(prior.recipe_snapshot) : snapshotFromRecipe(recipe);
    if (!snapshot || snapshot.id !== recipe.id || (prior && (!Number.isInteger(prior.recipe_revision) || (prior.recipe_revision ?? 0) < 1))) {
      throw new Error("editor-store: invalid run recipe snapshot");
    }
    const revision = prior ? prior.recipe_revision! : currentRevision;
    if (fromStep >= snapshot.steps.length) throw new Rollback<CreateRunResult>({ status: "invalid_from_step" });

    // 進行中の run・同じ key の run とぶつかったら作らない（一意の索引が判定する。読んでから作る race を作らない）
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO step_runs (owner, parent, recipe, from_step, idempotency_key, recipe_snapshot, recipe_revision)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [owner, parentKey, recipe.id, fromStep, key, JSON.stringify(snapshot), revision],
    );
    const runId = inserted.rows[0]?.id;
    if (!runId) {
      const raced = await existingByKey();
      if (raced) return { status: "existing", run: await requireRunView(client, owner, raced) } satisfies CreateRunResult;
      throw new Rollback<CreateRunResult>({ status: "run_in_progress" });
    }

    // Preserve existing artifact IDs by their stable step ID. Older runs used the index-derived ID;
    // their attempt rows provide the compatibility mapping when a user reorders the recipe.
    const previousAttempts = prior
      ? await client.query<{ step_id: string; page_id: string }>("SELECT step_id, page_id FROM step_attempts WHERE run_id = $1 ORDER BY step_index", [prior.id])
      : { rows: [] as { step_id: string; page_id: string }[] };
    const previousPageByStep = new Map(previousAttempts.rows.map((row) => [row.step_id, row.page_id] as const));
    const pageIds = snapshot.steps.map((step) => previousPageByStep.get(step.id) ?? stepPageIdForStep(parentKey, recipe.id, step.id));

    // fromStep より前は、完了済みのサブページを再利用する（作り終えるまで状態を変えさせない）
    if (fromStep > 0) {
      const reused = await client.query(
        `SELECT id FROM pages
          WHERE owner = $1 AND parent = $2 AND recipe = $3 AND kind = 'step' AND deleted_at IS NULL
            AND step_status = 'done' AND id = ANY($4::uuid[])
          FOR SHARE`,
        [owner, parentKey, recipe.id, pageIds.slice(0, fromStep)],
      );
      if (reused.rowCount !== fromStep) throw new Rollback<CreateRunResult>({ status: "invalid_from_step" });
    }

    // fromStep 以降のサブページ（無ければ作り、あれば wait に戻す。削除されていれば戻す）
    const upserted = await client.query(
      `INSERT INTO pages (id, owner, kind, title, lang, parent, recipe, step_status)
       SELECT v.id, $1::text, 'step', v.title, $3::text, $2::uuid, $4::text, 'wait'
         FROM unnest($5::uuid[], $6::text[]) AS v(id, title)
       ON CONFLICT (id) DO UPDATE
          SET step_status = 'wait', deleted_at = NULL
        WHERE pages.owner = EXCLUDED.owner AND pages.parent = EXCLUDED.parent
          AND pages.recipe = EXCLUDED.recipe AND pages.kind = 'step'
       RETURNING id`,
      [owner, parentKey, parentRow.lang, recipe.id, pageIds.slice(fromStep), snapshot.steps.slice(fromStep).map((step) => step.name)],
    );
    if (upserted.rowCount !== snapshot.steps.length - fromStep) throw new Error("editor-store: a step page id is taken by another page");

    await client.query(
      `INSERT INTO step_attempts (run_id, step_index, step_id, page_id, state, finished_at)
       SELECT $1::uuid, v.step_index, v.step_id, v.page_id, v.state, CASE WHEN v.state = 'reused' THEN clock_timestamp() END
         FROM unnest($2::integer[], $3::text[], $4::uuid[], $5::text[]) AS v(step_index, step_id, page_id, state)`,
      [
        runId,
        snapshot.steps.map((_, index) => index),
        snapshot.steps.map((step) => step.id),
        pageIds,
        snapshot.steps.map((_, index) => (index < fromStep ? "reused" : index === fromStep ? "queued" : "pending")),
      ],
    );
    return { status: "created", run: await requireRunView(client, owner, runId) } satisfies CreateRunResult;
  });
}

/** Explicitly replace the latest run's design. Running work is never changed in place. */
export async function updateRunRecipeSnapshot(
  db: StepRunsDb, owner: OwnerId, parentId: string, runId: string,
  recipe: StepRecipe, expectedRevision: number,
): Promise<{ status: "updated"; run: StepRunView } | { status: "not_found" } | { status: "conflict" }> {
  assertOwner(owner);
  assertRecipe(recipe);
  if (!isPageId(parentId) || !isPageId(runId) || !Number.isInteger(expectedRevision) || expectedRevision < 1) return { status: "not_found" };
  return inTransaction(db, async (client) => {
    const parent = await client.query("SELECT id FROM pages WHERE owner=$1 AND id=$2 AND kind='rec' AND deleted_at IS NULL FOR UPDATE", [owner, parentId]);
    if (!parent.rowCount) return { status: "not_found" };
    const current = await client.query<{ revision: number }>("SELECT revision FROM recipes WHERE owner=$1 AND id=$2 FOR SHARE", [owner, recipe.id]);
    if (!current.rows[0] || current.rows[0].revision !== recipe.revision) return { status: "conflict" };
    const latest = await client.query<{ id: string; state: RunState; recipe_revision: number | null; recipe_snapshot: unknown }>(
      `SELECT id, state, recipe_revision, recipe_snapshot FROM step_runs
       WHERE owner=$1 AND parent=$2 AND recipe=$3 ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`,
      [owner, parentId, recipe.id],
    );
    const row = latest.rows[0];
    if (!row || row.id !== runId) return { status: "not_found" };
    const previousSnapshot = parseRecipeSnapshot(row.recipe_snapshot);
    if (!previousSnapshot) throw new Error("editor-store: invalid run recipe snapshot");
    if (row.state === "queued" || row.state === "running" || row.recipe_revision !== expectedRevision) return { status: "conflict" };
    const snapshot = snapshotFromRecipe(recipe);
    const attempts = await client.query<{ step_id: string; step_index: number }>(
      "SELECT step_id, step_index FROM step_attempts WHERE run_id=$1 ORDER BY step_index FOR UPDATE",
      [runId],
    );
    const currentStepIds = new Set(attempts.rows.map((attempt) => attempt.step_id));
    if (attempts.rows.length !== snapshot.steps.length || snapshot.steps.some((step) => !currentStepIds.has(step.id))) {
      // Reordering and editing a step preserve its artifact identity. Adding or removing a step
      // needs a new run because this completed run has no matching attempt row for that design.
      return { status: "conflict" };
    }
    if (previousSnapshot.steps.length !== snapshot.steps.length) return { status: "conflict" };
    // Move indices out of the active range first so unique (run_id, step_index) remains valid
    // while two or more step IDs exchange positions.
    const offset = attempts.rows.length;
    if (offset > 0) {
      await client.query("UPDATE step_attempts SET step_index=step_index+$2 WHERE run_id=$1", [runId, offset]);
      for (const [index, step] of snapshot.steps.entries()) {
        const remapped = await client.query(
          "UPDATE step_attempts SET step_index=$3 WHERE run_id=$1 AND step_id=$2",
          [runId, step.id, index],
        );
        if (remapped.rowCount !== 1) throw new Error("editor-store: recipe snapshot step remap was incomplete");
      }
    }
    await client.query("UPDATE step_runs SET recipe_snapshot=$2::jsonb, recipe_revision=$3, updated_at=GREATEST(clock_timestamp(), updated_at) WHERE id=$1", [runId, JSON.stringify(snapshot), current.rows[0].revision]);
    return { status: "updated", run: await requireRunView(client, owner, runId) };
  });
}

/** 親ページの最新の run（帯に出す）。親が本人のページでなければ null（404）。run が無ければ `{ run: null }`。 */
export async function listRun(db: Queryable, owner: OwnerId, parentId: string): Promise<{ run: StepRunView | null } | null> {
  assertOwner(owner);
  if (!isPageId(parentId)) return null;
  const found = await db.query<{ run_id: string | null }>(
    `SELECT r.id AS run_id
       FROM pages p
       LEFT JOIN LATERAL (
         SELECT id FROM step_runs
          WHERE owner = p.owner AND parent = p.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
       ) r ON true
      WHERE p.owner = $1 AND p.id = $2 AND p.deleted_at IS NULL`,
    [owner, parentId],
  );
  const row = found.rows[0];
  if (!row) return null;
  return { run: row.run_id ? await loadRunView(db, owner, row.run_id) : null };
}

/**
 * 失敗した最新 run の途中出力だけを owner・親ページ・run・段階で絞って読む。
 * 新しい run が始まった後、retry 中、成功・取消後、親/成果物ページ削除後は返さない。
 */
export async function readPartialOutput(
  db: Queryable,
  owner: OwnerId,
  parentId: string,
  runId: string,
  stepIndex: number,
): Promise<Block[] | null> {
  assertOwner(owner);
  if (!isPageId(parentId) || !isPageId(runId) || !Number.isSafeInteger(stepIndex) || stepIndex < 0) return null;
  const result = await db.query<{ partial_blocks: unknown }>(
    `SELECT a.partial_blocks
       FROM pages parent_page
       JOIN step_runs r ON r.owner = parent_page.owner AND r.parent = parent_page.id
       JOIN step_attempts a ON a.run_id = r.id AND a.step_index = $4
       JOIN pages output_page ON output_page.owner = r.owner AND output_page.id = a.page_id AND output_page.deleted_at IS NULL
      WHERE parent_page.owner = $1 AND parent_page.id = $2 AND parent_page.deleted_at IS NULL
        AND r.id = $3 AND r.state = 'failed' AND a.state = 'failed' AND a.partial_blocks IS NOT NULL
        AND r.id = (
          SELECT latest.id FROM step_runs latest
           WHERE latest.owner = $1 AND latest.parent = $2
           ORDER BY latest.created_at DESC, latest.id DESC
           LIMIT 1
        )
        AND CASE WHEN jsonb_typeof(a.partial_blocks) = 'array'
                 THEN jsonb_array_length(a.partial_blocks) > 0 ELSE false END`,
    [owner, parentId, runId, stepIndex],
  );
  const blocks = result.rows[0]?.partial_blocks;
  return Array.isArray(blocks) ? blocks as Block[] : null;
}

export type StepClaim = {
  runId: string;
  stepIndex: number;
  /** この実行の世代。確定・失敗・生存確認に渡す。 */
  generation: number;
  tries: number;
  owner: OwnerId;
  parentId: string;
  recipe: string;
  recipeSnapshot: RecipeSnapshot | null;
  stepId: string;
  pageId: string;
  /** 前の段階のサブページ（段階 0 は null）。 */
  previousPageId: string | null;
  /** この run の上流段階と成果物ページ。並べ替え後も段階 ID とページ ID の対応を保つ。 */
  upstreamPageIds: { id: string; pageId: string }[];
  /**
   * 区切りの状態（#277）。`count` が null なら区切りを始めていない。`index` は終えた区切りの数、
   * `blocks` は終えた区切りごとの出力、`basis` は最初の区切りを始めたときの入力の基準。
   */
  chunk: StepChunkState;
};

export type StepChunkState = { count: number | null; index: number; basis: string | null; blocks: Block[][] };

export type ClaimResult =
  | { ok: true; claim: StepClaim }
  /**
   * `run_inactive`: run が無い・終わっている（取消・失敗・成功）。
   * `not_queued`: attempt が queued でない（他が実行中・済み・まだ順番でない）。
   * `superseded`: 前の段階の結果が済み（succeeded / reused）でなくなっている（この段階を実行する前提が崩れた）。
   */
  | { ok: false; reason: "not_queued" | "run_inactive" | "superseded" };

/** queued の attempt を実行中にする（世代を 1 つ進め、lease を取る）。同時に何本来ても 1 本だけが通る。 */
export async function claimAttempt(
  db: StepRunsDb,
  runId: string,
  stepIndex: number,
  options: { leaseSeconds?: number } = {},
): Promise<ClaimResult> {
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  assertLease(leaseSeconds);
  if (!isPageId(runId) || !Number.isInteger(stepIndex) || stepIndex < 0) return { ok: false, reason: "run_inactive" };
  return inTransaction<ClaimResult>(db, async (client) => {
    const run = await client.query<{ owner: string; parent: string; recipe: string; recipe_snapshot: unknown; state: RunState }>(
      "SELECT owner, parent, recipe, recipe_snapshot, state FROM step_runs WHERE id = $1 FOR UPDATE",
      [runId],
    );
    const runRow = run.rows[0];
    if (!runRow || (runRow.state !== "queued" && runRow.state !== "running")) {
      return { ok: false, reason: "run_inactive" } satisfies ClaimResult;
    }
    const claimed = await client.query<{ generation: number; tries: number; step_id: string; page_id: string; chunk_count: number | null; chunk_index: number; chunk_basis: string | null; chunk_blocks: unknown }>(
      `UPDATE step_attempts a
          SET state = 'running',
              generation = a.generation + 1,
              tries = a.tries + 1,
              lease_until = clock_timestamp() + make_interval(secs => $3::double precision),
              heartbeat_at = clock_timestamp(),
              started_at = clock_timestamp(),
              finished_at = NULL,
              error_code = NULL,
              partial_blocks = NULL,
              input_used_chars = NULL
        WHERE a.run_id = $1 AND a.step_index = $2 AND a.state = 'queued'
          AND (a.step_index = 0 OR EXISTS (
                SELECT 1 FROM step_attempts prev
                 WHERE prev.run_id = a.run_id AND prev.step_index = a.step_index - 1
                   AND prev.state IN ('succeeded', 'reused')))
        RETURNING a.generation, a.tries, a.step_id, a.page_id, a.chunk_count, a.chunk_index, a.chunk_basis, a.chunk_blocks`,
      [runId, stepIndex, leaseSeconds],
    );
    const attempt = claimed.rows[0];
    if (!attempt) {
      // 通らなかった理由を返すためだけに読む（これをもとに書かない）
      const current = await client.query<{ state: AttemptState }>("SELECT state FROM step_attempts WHERE run_id = $1 AND step_index = $2", [runId, stepIndex]);
      return { ok: false, reason: current.rows[0]?.state === "queued" ? "superseded" : "not_queued" } satisfies ClaimResult;
    }
    await client.query(
      "UPDATE step_runs SET state = 'running', updated_at = GREATEST(clock_timestamp(), updated_at) WHERE id = $1 AND state IN ('queued', 'running')",
      [runId],
    );
    await client.query("UPDATE pages SET step_status = 'run' WHERE owner = $1 AND id = $2 AND deleted_at IS NULL", [runRow.owner, attempt.page_id]);
    const upstream = stepIndex === 0
      ? []
      : (await client.query<{ step_id: string; page_id: string }>(
          "SELECT step_id, page_id FROM step_attempts WHERE run_id = $1 AND step_index < $2 ORDER BY step_index",
          [runId, stepIndex],
        )).rows.map((row) => ({ id: row.step_id, pageId: row.page_id }));
    return {
      ok: true,
      claim: {
        runId,
        stepIndex,
        generation: attempt.generation,
        tries: attempt.tries,
        owner: runRow.owner,
        parentId: runRow.parent,
        recipe: runRow.recipe,
        recipeSnapshot: parseRecipeSnapshot(runRow.recipe_snapshot),
        stepId: attempt.step_id,
        pageId: attempt.page_id,
        previousPageId: upstream.at(-1)?.pageId ?? null,
        upstreamPageIds: upstream,
        chunk: {
          count: attempt.chunk_count,
          index: attempt.chunk_index,
          basis: attempt.chunk_basis,
          blocks: Array.isArray(attempt.chunk_blocks) ? (attempt.chunk_blocks as unknown[]).filter(Array.isArray) as Block[][] : [],
        },
      },
    } satisfies ClaimResult;
  });
}

export type AttemptRef = { runId: string; stepIndex: number; generation: number };

/** 生存確認。世代が一致して実行中のときだけ lease を延ばす。違えば false（取消・掃除のあと。実行をやめる）。 */
export async function heartbeatAttempt(db: Queryable, ref: AttemptRef, options: { leaseSeconds?: number } = {}): Promise<boolean> {
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  assertLease(leaseSeconds);
  if (!isPageId(ref.runId)) return false;
  const result = await db.query(
    `UPDATE step_attempts
        SET lease_until = clock_timestamp() + make_interval(secs => $4::double precision),
            heartbeat_at = clock_timestamp()
      WHERE run_id = $1 AND step_index = $2 AND generation = $3 AND state = 'running'`,
    [ref.runId, ref.stepIndex, ref.generation, leaseSeconds],
  );
  return result.rowCount === 1;
}

export type StepInput = StepMaterials & { previousBlocks: Block[] | null };

/** 段階の入力。録音本文と録音ページ自身の欄（背景・登場人物・固有名詞）を、owner で絞った単一 SQL snapshot で読む。 */
export async function readStepInput(
  db: Queryable,
  claim: Pick<StepClaim, "owner" | "parentId" | "previousPageId"> & { recipe?: string; stepIndex?: number; recipeSnapshot?: Pick<RecipeSnapshot, "steps"> | null; stepIds?: readonly string[]; upstreamPageIds?: readonly { id: string; pageId: string }[] },
): Promise<StepInput | null> {
  assertOwner(claim.owner);
  const stepIndex = claim.stepIndex ?? 0;
  const upstream = claim.upstreamPageIds ?? Array.from({ length: stepIndex }, (_, index) => ({
    id: claim.stepIds?.[index] ?? claim.recipeSnapshot?.steps[index]?.id ?? String(index),
    pageId: stepPageId(claim.parentId, claim.recipe ?? "", index),
  }));
  const result = await db.query<{ parent_blocks: Block[] | null; background: string | null; previous_blocks: Block[] | null; upstream: { id: string; blocks: Block[] }[]; refs: { id: string; blocks: Block[] }[]; entities: StepMaterials["fields"]["entities"]; terms: StepMaterials["fields"]["terms"]; ai_lang: string | null; glossary: StepMaterials["settings"]["glossary"] | null; about_name: string | null; about: string | null }>(
    `SELECT p.blocks AS parent_blocks,
            COALESCE(f.background, '') AS background,
            (SELECT blocks FROM pages WHERE owner = $1 AND id = $3 AND deleted_at IS NULL) AS previous_blocks,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id', prior.step_id, 'blocks', COALESCE(s.blocks, '[]'::jsonb)) ORDER BY prior.ord)
              FROM unnest($4::text[], $5::uuid[]) WITH ORDINALITY prior(step_id, page_id, ord)
              LEFT JOIN pages s ON s.owner = $1 AND s.id = prior.page_id AND s.deleted_at IS NULL), '[]'::jsonb) AS upstream,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'blocks', s.blocks) ORDER BY s.created_at, s.id)
              FROM pages s WHERE s.owner = $1 AND s.parent = p.parent AND s.deleted_at IS NULL AND s.id <> p.id), '[]'::jsonb) AS refs,
            COALESCE(f.entities, '[]'::jsonb) AS entities, COALESCE(f.terms, '[]'::jsonb) AS terms,
            e.ai_lang, e.glossary, e.about_name, e.about
       FROM pages p
       LEFT JOIN page_fields f ON f.owner = p.owner AND f.page_id = p.id
       LEFT JOIN editor_settings e ON e.owner = p.owner
      WHERE p.owner = $1 AND p.id = $2 AND p.deleted_at IS NULL`,
    [claim.owner, claim.parentId, claim.previousPageId, upstream.map((item) => item.id), upstream.map((item) => item.pageId)],
  );
  const row = result.rows[0];
  if (!row?.parent_blocks) return null;
  return {
    parentBlocks: row.parent_blocks, background: typeof row.background === "string" ? row.background : "",
    previousBlocks: claim.previousPageId === null ? null : (row.previous_blocks ?? []),
    upstream: row.upstream ?? [], refs: row.refs ?? [], fields: {
      entities: Array.isArray(row.entities) ? row.entities.filter(isPageEntity) : [],
      terms: Array.isArray(row.terms) ? row.terms.filter(isSettingsTerm) : [],
    },
    settings: {
      aiLang: row.ai_lang === "en" || row.ai_lang === "ja" ? row.ai_lang : "same",
      glossary: Array.isArray(row.glossary) ? row.glossary.filter(isSettingsTerm) : [],
      aboutName: row.about_name ?? "", about: row.about ?? "",
    },
  };
}

export type CommitInput = AttemptRef & {
  blocks: readonly Block[];
  inputBasis: StepBasis | string;
  /** 資料を上限で切ったときだけ、実際に使った字数（code point）。切っていなければ渡さない（#277）。 */
  inputUsedChars?: number;
};

export type CommitResult =
  /** `next`: 次に実行する段階（最後の段階なら null。run は succeeded）。 */
  | { ok: true; next: number | null }
  /** `stale_generation`: 世代が古い・実行中でない（取消・掃除・再取得のあと）。何も書いていない。 */
  | { ok: false; reason: "stale_generation" | "page_missing" };

/**
 * 段階の確定（1 transaction）。サブページの本文と状態・attempt・次の attempt（または run の成功）を同時に書く。
 * 世代が一致して実行中のときだけ通る。サブページが削除されていたら何も書かずに `page_missing`。
 */
export async function commitAttempt(db: StepRunsDb, input: CommitInput): Promise<CommitResult> {
  const structuredBasis = parseStepBasis(input.inputBasis);
  if (!structuredBasis && !(typeof input.inputBasis === "string" && /^[0-9a-f]{64}$/.test(input.inputBasis))) throw new TypeError("editor-store: inputBasis must be a complete basis or legacy digest");
  const legacyBasis = structuredBasis ? null : input.inputBasis as string;
  if (input.inputUsedChars !== undefined && !(Number.isInteger(input.inputUsedChars) && input.inputUsedChars >= 0 && input.inputUsedChars <= 2_147_483_647)) {
    throw new TypeError("editor-store: inputUsedChars must be a non-negative integer");
  }
  if (!isPageId(input.runId)) return { ok: false, reason: "stale_generation" };
  return inTransaction<CommitResult>(db, async (client) => {
    const run = await client.query<{ owner: string; state: RunState }>("SELECT owner, state FROM step_runs WHERE id = $1 FOR UPDATE", [input.runId]);
    const runRow = run.rows[0];
    if (!runRow || runRow.state !== "running") return { ok: false, reason: "stale_generation" } satisfies CommitResult;
    const done = await client.query<{ page_id: string }>(
      `UPDATE step_attempts
          SET state = 'succeeded', input_basis = $4, input_basis_v2 = $5::jsonb, finished_at = clock_timestamp(), lease_until = NULL, error_code = NULL,
              partial_blocks = NULL, input_used_chars = $6
        WHERE run_id = $1 AND step_index = $2 AND generation = $3 AND state = 'running'
        RETURNING page_id`,
      [input.runId, input.stepIndex, input.generation, legacyBasis, structuredBasis ? JSON.stringify(structuredBasis) : null, input.inputUsedChars ?? null],
    );
    const pageId = done.rows[0]?.page_id;
    if (!pageId) return { ok: false, reason: "stale_generation" } satisfies CommitResult;
    // 本文を置き換える。利用者の保存と食い違わないよう、先にページの行を押さえる（lock の順は run → attempt → ページ）
    const locked = await client.query("SELECT 1 FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE", [runRow.owner, pageId]);
    if (locked.rowCount !== 1) throw new Rollback<CommitResult>({ ok: false, reason: "page_missing" });
    // 作り直しで今の本文（利用者が直した内容を含む）を置き換えるときは、先に版（ai）に残す。最初の生成（空の本文）では残さない。
    // 版の番号はページごとの連番（packages/editor-store/src/store.ts の #snapshot と同じ）
    await client.query(
      `INSERT INTO page_versions (page_id, version, blocks, reason, cover, lead, metadata_tracked)
       SELECT p.id, COALESCE((SELECT max(v.version) FROM page_versions v WHERE v.page_id = p.id), 0) + 1, p.blocks, 'ai', p.cover, p.lead, true
         FROM pages p
        WHERE p.owner = $1 AND p.id = $2 AND p.deleted_at IS NULL AND jsonb_array_length(p.blocks) > 0`,
      [runRow.owner, pageId],
    );
    // revision を進める: 利用者が古い revision のまま保存しても、この結果を黙って上書きせず競合として返る（#58 の楽観ロック）
    await client.query(
      `UPDATE pages
          SET blocks = $3::jsonb, step_status = 'done', revision = revision + 1, updated_at = GREATEST(clock_timestamp(), updated_at)
        WHERE owner = $1 AND id = $2 AND deleted_at IS NULL`,
      [runRow.owner, pageId, JSON.stringify(input.blocks)],
    );
    const next = await client.query<{ step_index: number }>(
      "UPDATE step_attempts SET state = 'queued' WHERE run_id = $1 AND step_index = $2 AND state = 'pending' RETURNING step_index",
      [input.runId, input.stepIndex + 1],
    );
    const nextIndex = next.rows[0]?.step_index;
    if (nextIndex !== undefined) return { ok: true, next: nextIndex } satisfies CommitResult;
    const finished = await client.query(
      `UPDATE step_runs
          SET state = 'succeeded', finished_at = clock_timestamp(), updated_at = GREATEST(clock_timestamp(), updated_at)
        WHERE id = $1 AND state = 'running'
          AND NOT EXISTS (SELECT 1 FROM step_attempts WHERE run_id = $1 AND step_index > $2)`,
      [input.runId, input.stepIndex],
    );
    if (finished.rowCount !== 1) throw new Error("editor-store: the next step of a run is not pending");
    return { ok: true, next: null } satisfies CommitResult;
  });
}

// ---------------------------------------------------------------------------
// 区切り（#277。全文を書き直す段階の長い入力。docs/architecture/editor-steps-execution.md §5）

/** 区切りの数の上限（migration 20261106211229_steps_chunks の CHECK と同じ）。 */
export const MAX_STEP_CHUNKS = 60;

/**
 * 最後の失敗のときに `partial_blocks` へ残す本文。終えた区切りの出力（`chunk_blocks`）を順につなぎ、
 * その後ろに今の区切りの書けたところまで（`extra`）を足す。区切りを始めていなければ `extra` のまま。
 * UPDATE step_attempts の SET の中で使う（対象の行の `chunk_blocks` を読む）。
 */
function FINAL_PARTIAL_SQL(extra: string): string {
  return `CASE WHEN jsonb_typeof(step_attempts.chunk_blocks) = 'array' AND jsonb_array_length(step_attempts.chunk_blocks) > 0
    THEN COALESCE((SELECT jsonb_agg(piece.block ORDER BY chunk.ord, piece.ord)
                     FROM jsonb_array_elements(step_attempts.chunk_blocks) WITH ORDINALITY AS chunk(blocks, ord)
                     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(chunk.blocks) = 'array' THEN chunk.blocks ELSE '[]'::jsonb END)
                       WITH ORDINALITY AS piece(block, ord)), '[]'::jsonb) || COALESCE(${extra}, '[]'::jsonb)
    ELSE ${extra} END`;
}

const CHUNK_BASIS_PATTERN = /^[0-9a-f]{64}$/;

export type StartChunksInput = AttemptRef & { count: number; basis: string };

/**
 * 区切りを始める（最初の区切りの前に 1 回だけ）。区切りの数と入力の基準を記録する。
 * claim の世代で実行中で、まだ区切りを始めていないときだけ通る（遅れた実行・二重の開始は false）。
 */
export async function startChunks(db: Queryable, input: StartChunksInput): Promise<boolean> {
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_STEP_CHUNKS) throw new RangeError("editor-store: chunk count must be 1..60");
  if (!CHUNK_BASIS_PATTERN.test(input.basis)) throw new TypeError("editor-store: chunk basis must be a sha256 hex digest");
  if (!isPageId(input.runId)) return false;
  const result = await db.query(
    `UPDATE step_attempts
        SET chunk_count = $4, chunk_basis = $5, chunk_index = 0, chunk_blocks = '[]'::jsonb
      WHERE run_id = $1 AND step_index = $2 AND generation = $3 AND state = 'running' AND chunk_count IS NULL`,
    [input.runId, input.stepIndex, input.generation, input.count, input.basis],
  );
  return result.rowCount === 1;
}

export type CommitChunkInput = AttemptRef & {
  /** 終えた区切りの番号（0 始まり。今の `chunk_index` と同じでなければ通らない）。 */
  chunkIndex: number;
  blocks: readonly Block[];
};

export type CommitChunkResult =
  /** 次の区切りを待つ（attempt は queued。`generation` は task の名前に入れる今の世代）。 */
  | { ok: true; generation: number }
  /** 世代が古い・実行中でない・区切りの番号が合わない・最後の区切り（最後は commitAttempt で 1 版にする）。何も書いていない。 */
  | { ok: false; reason: "stale_generation" };

/**
 * 途中の区切りの確定（最後の区切りは `commitAttempt`）。claim の世代・状態・区切りの番号の CAS で、出力を
 * `chunk_blocks` に追記して `chunk_index` を進め、attempt を queued に戻して lease を外す。
 * `tries` は 0 に戻す（再試行の上限は区切りごとに数える。失敗した区切りだけを繰り返す）。サブページの本文には書かない。
 */
export async function commitChunk(db: StepRunsDb, input: CommitChunkInput): Promise<CommitChunkResult> {
  if (!Number.isInteger(input.chunkIndex) || input.chunkIndex < 0) throw new RangeError("editor-store: chunkIndex must be a non-negative integer");
  if (!isPageId(input.runId)) return { ok: false, reason: "stale_generation" };
  return inTransaction<CommitChunkResult>(db, async (client) => {
    const run = await client.query<{ state: RunState }>("SELECT state FROM step_runs WHERE id = $1 FOR UPDATE", [input.runId]);
    if (run.rows[0]?.state !== "running") return { ok: false, reason: "stale_generation" } satisfies CommitChunkResult;
    const updated = await client.query<{ generation: number }>(
      `UPDATE step_attempts
          SET chunk_blocks = COALESCE(chunk_blocks, '[]'::jsonb) || jsonb_build_array($5::jsonb),
              chunk_index = chunk_index + 1,
              state = 'queued', lease_until = NULL, heartbeat_at = NULL, tries = 0, error_code = NULL
        WHERE run_id = $1 AND step_index = $2 AND generation = $3 AND state = 'running'
          AND chunk_count IS NOT NULL AND chunk_index = $4 AND chunk_index + 1 < chunk_count
          AND COALESCE(jsonb_array_length(chunk_blocks), 0) = chunk_index
        RETURNING generation`,
      [input.runId, input.stepIndex, input.generation, input.chunkIndex, JSON.stringify(input.blocks)],
    );
    const generation = updated.rows[0]?.generation;
    return generation === undefined ? { ok: false, reason: "stale_generation" } : { ok: true, generation };
  });
}

export type ResumeRunResult =
  /** 同じ run・同じ attempt を queued に戻した。`stepIndex`・`generation` で task を積む。 */
  | { status: "resumed"; run: StepRunView; stepIndex: number; generation: number }
  /** 本人のその親ページの run でない。404。 */
  | { status: "not_found" }
  /** 同じ録音ページで進行中の run がある（この run を含む）。409。 */
  | { status: "run_in_progress" }
  /** 最新の run でない・失敗していない・失敗した段階が区切っていない・結果のページが無い。409。 */
  | { status: "not_resumable" }
  /** 入力が最初の区切りを始めたときと違う。最初から作り直す。409。 */
  | { status: "input_changed" };

/**
 * 失敗した run を「区切り i からやり直す」（#277）。入力の基準が `chunk_basis` と同じときだけ、同じ run・同じ attempt を
 * failed → queued に戻す（`tries` は 0、`chunk_*` は保つ、世代を 1 つ進めて新しい task の名前にする）。後続の段階は
 * pending に戻し、run は queued にする。親・run を lock し、入力の読み・比較・書き込みを 1 transaction で行う。
 */
export async function resumeRun(db: StepRunsDb, owner: OwnerId, parentId: string, runId: string): Promise<ResumeRunResult> {
  assertOwner(owner);
  if (!isPageId(parentId) || !isPageId(runId)) return { status: "not_found" };
  return inTransaction<ResumeRunResult>(db, async (client) => {
    // createRun と同じ順（親 → run）で lock する。進行中の run の作成と直列にする
    const parent = await client.query("SELECT id FROM pages WHERE owner = $1 AND id = $2 AND kind = 'rec' AND deleted_at IS NULL FOR UPDATE", [owner, parentId]);
    if (!parent.rowCount) return { status: "not_found" } satisfies ResumeRunResult;
    const run = await client.query<{ state: RunState; recipe: string; recipe_snapshot: unknown }>(
      "SELECT state, recipe, recipe_snapshot FROM step_runs WHERE owner = $1 AND id = $2 AND parent = $3 FOR UPDATE",
      [owner, runId, parentId],
    );
    const runRow = run.rows[0];
    if (!runRow) return { status: "not_found" } satisfies ResumeRunResult;
    const active = await client.query("SELECT 1 FROM step_runs WHERE owner = $1 AND parent = $2 AND state IN ('queued', 'running')", [owner, parentId]);
    if (active.rowCount) return { status: "run_in_progress" } satisfies ResumeRunResult;
    const latest = await client.query<{ id: string }>(
      "SELECT id FROM step_runs WHERE owner = $1 AND parent = $2 ORDER BY created_at DESC, id DESC LIMIT 1",
      [owner, parentId],
    );
    if (latest.rows[0]?.id !== runId || runRow.state !== "failed") return { status: "not_resumable" } satisfies ResumeRunResult;
    const snapshot = parseRecipeSnapshot(runRow.recipe_snapshot);
    if (!snapshot || snapshot.id !== runRow.recipe) return { status: "not_resumable" } satisfies ResumeRunResult;
    const attempts = await client.query<{ step_index: number; step_id: string; page_id: string; state: AttemptState; generation: number; chunk_count: number | null; chunk_index: number; chunk_basis: string | null }>(
      "SELECT step_index, step_id, page_id, state, generation, chunk_count, chunk_index, chunk_basis FROM step_attempts WHERE run_id = $1 ORDER BY step_index FOR UPDATE",
      [runId],
    );
    const failed = attempts.rows.find((row) => row.state === "failed");
    const step = failed ? snapshot.steps[failed.step_index] : undefined;
    if (!failed || !step || step.id !== failed.step_id || step.chunked !== true || failed.chunk_count === null || failed.chunk_basis === null) {
      return { status: "not_resumable" } satisfies ResumeRunResult;
    }
    const page = await client.query("SELECT 1 FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL", [owner, failed.page_id]);
    if (!page.rowCount) return { status: "not_resumable" } satisfies ResumeRunResult;
    const upstreamPageIds = attempts.rows.filter((row) => row.step_index < failed.step_index).map((row) => ({ id: row.step_id, pageId: row.page_id }));
    const input = await readStepInput(client, {
      owner, parentId, previousPageId: upstreamPageIds.at(-1)?.pageId ?? null, recipe: runRow.recipe,
      stepIndex: failed.step_index, recipeSnapshot: snapshot, upstreamPageIds,
    });
    if (!input) return { status: "not_resumable" } satisfies ResumeRunResult;
    if (computeChunkBasis(computeStepBasis(snapshot, failed.step_index, input)) !== failed.chunk_basis) {
      return { status: "input_changed" } satisfies ResumeRunResult;
    }
    const resumed = await client.query<{ generation: number }>(
      `UPDATE step_attempts
          SET state = 'queued', tries = 0, generation = generation + 1, error_code = NULL, finished_at = NULL,
              partial_blocks = NULL, lease_until = NULL, heartbeat_at = NULL
        WHERE run_id = $1 AND step_index = $2 AND generation = $3 AND state = 'failed'
        RETURNING generation`,
      [runId, failed.step_index, failed.generation],
    );
    const generation = resumed.rows[0]?.generation;
    if (generation === undefined) throw new Rollback<ResumeRunResult>({ status: "not_resumable" });
    await client.query(
      "UPDATE step_attempts SET state = 'pending', finished_at = NULL WHERE run_id = $1 AND step_index > $2 AND state = 'canceled'",
      [runId, failed.step_index],
    );
    try {
      await client.query(
        `UPDATE step_runs SET state = 'queued', finished_at = NULL, updated_at = GREATEST(clock_timestamp(), updated_at)
          WHERE id = $1 AND state = 'failed'`,
        [runId],
      );
    } catch (error) {
      // 進行中の run は親ごとに 1 つ（step_runs_active_idx）。読んだあとに別の run が始まった
      if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505") {
        throw new Rollback<ResumeRunResult>({ status: "run_in_progress" });
      }
      throw error;
    }
    await client.query("UPDATE pages SET step_status = 'wait' WHERE owner = $1 AND id = $2 AND deleted_at IS NULL", [owner, failed.page_id]);
    return { status: "resumed", run: await requireRunView(client, owner, runId), stepIndex: failed.step_index, generation } satisfies ResumeRunResult;
  });
}

/** run を失敗で終える（attempt は失敗にした後）。後続は canceled、サブページは失敗の段階が failed・後続が wait。 */
async function failRunFrom(client: PoolClient, owner: OwnerId, runId: string, stepIndex: number, pageId: string): Promise<void> {
  const rest = await client.query<{ page_id: string }>(
    `UPDATE step_attempts SET state = 'canceled', finished_at = clock_timestamp()
      WHERE run_id = $1 AND step_index > $2 AND state IN ('pending', 'queued')
      RETURNING page_id`,
    [runId, stepIndex],
  );
  await client.query(
    `UPDATE step_runs SET state = 'failed', finished_at = clock_timestamp(), updated_at = GREATEST(clock_timestamp(), updated_at)
      WHERE id = $1 AND state IN ('queued', 'running')`,
    [runId],
  );
  await client.query(
    `UPDATE pages SET step_status = CASE WHEN id = $2 THEN 'failed' ELSE 'wait' END
      WHERE owner = $1 AND deleted_at IS NULL AND id = ANY($3::uuid[])`,
    [owner, pageId, [pageId, ...rest.rows.map((row) => row.page_id)]],
  );
}

export type FailInput = AttemptRef & {
  code: string;
  retryable: boolean;
  /**
   * 書けたところまでの本文（`output_too_long` のように、やり直しても同じところで終わる失敗のときだけ）。
   * **最後の失敗のときにだけ残す**（積み直すときは書かない。次の試行が書き直す）。サブページの本文には入れない。
   */
  partial?: readonly Block[];
};

export type FailResult =
  /** もう一度積む（`generation` はこの attempt の今の世代。task の名前に入れる）。 */
  | { ok: true; outcome: "retry"; generation: number; tries: number }
  | { ok: true; outcome: "failed" }
  | { ok: false; reason: "stale_generation" };

/**
 * 段階の失敗。世代が一致して実行中のときだけ通る。`retryable` で `tries < MAX_TRIES` なら queued に戻し（lease を外す。
 * サブページは wait）、そうでなければ attempt を failed・後続を canceled・run を failed にする。
 * `partial` を渡すと、**最後の失敗のときだけ**書けたところまでの本文を残す（積み直すときは残さない）。
 */
export async function failAttempt(db: StepRunsDb, input: FailInput): Promise<FailResult> {
  if (!isStepErrorCode(input.code)) throw new TypeError("editor-store: error code must match ^[a-z0-9_]{1,64}$");
  if (!isPageId(input.runId)) return { ok: false, reason: "stale_generation" };
  return inTransaction<FailResult>(db, async (client) => {
    const run = await client.query<{ owner: string; state: RunState }>("SELECT owner, state FROM step_runs WHERE id = $1 FOR UPDATE", [input.runId]);
    const runRow = run.rows[0];
    if (!runRow || runRow.state !== "running") return { ok: false, reason: "stale_generation" } satisfies FailResult;
    const retried = await client.query<{ generation: number; tries: number; page_id: string }>(
      `UPDATE step_attempts
          SET state = 'queued', lease_until = NULL, heartbeat_at = NULL, error_code = $4
        WHERE run_id = $1 AND step_index = $2 AND generation = $3 AND state = 'running'
          AND $5::boolean AND tries < $6
        RETURNING generation, tries, page_id`,
      [input.runId, input.stepIndex, input.generation, input.code, input.retryable, MAX_TRIES],
    );
    const retry = retried.rows[0];
    if (retry) {
      await client.query("UPDATE pages SET step_status = 'wait' WHERE owner = $1 AND id = $2 AND deleted_at IS NULL", [runRow.owner, retry.page_id]);
      return { ok: true, outcome: "retry", generation: retry.generation, tries: retry.tries } satisfies FailResult;
    }
    const failed = await client.query<{ page_id: string }>(
      `UPDATE step_attempts
          SET state = 'failed', lease_until = NULL, error_code = $4, finished_at = clock_timestamp(),
              partial_blocks = ${FINAL_PARTIAL_SQL("$5::jsonb")}
        WHERE run_id = $1 AND step_index = $2 AND generation = $3 AND state = 'running'
        RETURNING page_id`,
      [input.runId, input.stepIndex, input.generation, input.code, input.partial === undefined ? null : JSON.stringify(input.partial)],
    );
    const pageId = failed.rows[0]?.page_id;
    if (!pageId) return { ok: false, reason: "stale_generation" } satisfies FailResult;
    await failRunFrom(client, runRow.owner, input.runId, input.stepIndex, pageId);
    return { ok: true, outcome: "failed" } satisfies FailResult;
  });
}

/**
 * 取消（冪等）。run を canceled、未完了の attempt を canceled にし、実行中の attempt は世代を進めて遅れて返る確定を拒否させる。
 * 未完了のサブページは wait。完了済みのサブページはそのまま。既に終わった run は何もしない。
 * 本人のその親ページの run でなければ null（404）。
 */
export async function cancelRun(db: StepRunsDb, owner: OwnerId, parentId: string, runId: string): Promise<StepRunView | null> {
  assertOwner(owner);
  if (!isPageId(parentId) || !isPageId(runId)) return null;
  return inTransaction<StepRunView | null>(db, async (client) => {
    const run = await client.query<{ state: RunState }>(
      "SELECT state FROM step_runs WHERE owner = $1 AND id = $2 AND parent = $3 FOR UPDATE",
      [owner, runId, parentId],
    );
    const runRow = run.rows[0];
    if (!runRow) return null;
    if (runRow.state === "queued" || runRow.state === "running") {
      await client.query(
        `UPDATE step_runs SET state = 'canceled', finished_at = clock_timestamp(), updated_at = GREATEST(clock_timestamp(), updated_at)
          WHERE id = $1 AND state IN ('queued', 'running')`,
        [runId],
      );
      const canceled = await client.query<{ page_id: string }>(
        `UPDATE step_attempts
            SET state = 'canceled',
                generation = CASE WHEN state = 'running' THEN generation + 1 ELSE generation END,
                lease_until = NULL,
                finished_at = clock_timestamp()
          WHERE run_id = $1 AND state IN ('queued', 'pending', 'running')
          RETURNING page_id`,
        [runId],
      );
      await client.query(
        "UPDATE pages SET step_status = 'wait' WHERE owner = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])",
        [owner, canceled.rows.map((row) => row.page_id)],
      );
    }
    return loadRunView(client, owner, runId);
  });
}

/**
 * 期限切れの lease の掃除（定期の Scheduler から呼ぶ想定）。lease が切れた running を、`tries < MAX_TRIES` なら queued に戻し、
 * そうでなければ failed（`lease_expired`）にする。戻り値は積み直す対象（task の名前に世代を入れる）。
 */
export async function sweepExpiredLeases(db: StepRunsDb, options: { limit?: number } = {}): Promise<AttemptRef[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  const expired = await db.query<{ run_id: string; step_index: number; generation: number }>(
    `SELECT run_id, step_index, generation FROM step_attempts
      WHERE state = 'running' AND lease_until < clock_timestamp()
      ORDER BY lease_until
      LIMIT $1`,
    [limit],
  );
  const requeue: AttemptRef[] = [];
  for (const candidate of expired.rows) {
    const ref = { runId: candidate.run_id, stepIndex: candidate.step_index, generation: candidate.generation };
    const outcome = await inTransaction(db, async (client) => {
      const run = await client.query<{ owner: string }>("SELECT owner FROM step_runs WHERE id = $1 FOR UPDATE", [ref.runId]);
      const owner = run.rows[0]?.owner;
      if (!owner) return "skipped" as const;
      // 生存確認が間に合った・別の世代になったものは触らない（条件はすべて UPDATE の中）
      const retried = await client.query<{ page_id: string }>(
        `UPDATE step_attempts SET state = 'queued', lease_until = NULL, heartbeat_at = NULL, error_code = 'lease_expired'
          WHERE run_id = $1 AND step_index = $2 AND generation = $3 AND state = 'running'
            AND lease_until < clock_timestamp() AND tries < $4
          RETURNING page_id`,
        [ref.runId, ref.stepIndex, ref.generation, MAX_TRIES],
      );
      const retryPage = retried.rows[0]?.page_id;
      if (retryPage) {
        await client.query("UPDATE pages SET step_status = 'wait' WHERE owner = $1 AND id = $2 AND deleted_at IS NULL", [owner, retryPage]);
        return "requeued" as const;
      }
      const failed = await client.query<{ page_id: string }>(
        `UPDATE step_attempts SET state = 'failed', lease_until = NULL, error_code = 'lease_expired', finished_at = clock_timestamp(),
                partial_blocks = ${FINAL_PARTIAL_SQL("NULL::jsonb")}
          WHERE run_id = $1 AND step_index = $2 AND generation = $3 AND state = 'running'
            AND lease_until < clock_timestamp()
          RETURNING page_id`,
        [ref.runId, ref.stepIndex, ref.generation],
      );
      const failedPage = failed.rows[0]?.page_id;
      if (!failedPage) return "skipped" as const;
      await failRunFrom(client, owner, ref.runId, ref.stepIndex, failedPage);
      return "failed" as const;
    });
    if (outcome === "requeued") requeue.push(ref);
  }
  return requeue;
}

// $1 run id / $2 step index / $3 generation。まだ claim されていない attempt の世代だけを 1 つ進める（state は queued のまま）。
const REQUEUE_ATTEMPT_SQL = `
UPDATE step_attempts
   SET generation = generation + 1
 WHERE run_id = $1 AND step_index = $2 AND generation = $3 AND state = 'queued'
RETURNING generation`;

/**
 * 掃除が積み直す前に、まだ claim されていない attempt の世代を 1 つ進める。新しい世代を返す（queued でない・世代が違う・
 * 無い・不正な id なら null＝積み直さない）。state は queued のままなので、積んだ task は今までと同じように claim できる。
 *
 * 世代を進めるのは、task の名前（`<run>-<段階>-<世代>`）を前の task と別にするため。**Cloud Tasks は消した task の名前を
 * 最大 24 時間使わせない**ので、同じ名前で積み直すと「まだ積まれている」と区別がつかず、取りこぼした段階がその間だまって
 * 止まる（worker が 503 を返しているあいだに再試行を使い切って task が消えた、積み込みが途中で落ちた、など）。
 * claim・lease 切れの戻しで世代が進む attempt はこれに当たらない（死んだ task の名前より先に進んでいる）ので、
 * 進めるのは「一度も claim されていない queued」だけ。文字起こし（#36）の `requeueRun` と同じ作法。
 */
export async function requeueAttempt(db: Queryable, ref: AttemptRef): Promise<number | null> {
  if (!Number.isSafeInteger(ref.generation) || ref.generation < 0) throw new TypeError("editor-store: generation must be a non-negative integer");
  if (!Number.isSafeInteger(ref.stepIndex) || ref.stepIndex < 0) throw new TypeError("editor-store: stepIndex must be a non-negative integer");
  if (typeof ref.runId !== "string" || !isPageId(ref.runId)) return null;
  const row = (await db.query<{ generation: number }>(REQUEUE_ATTEMPT_SQL, [ref.runId, ref.stepIndex, ref.generation])).rows[0];
  return row ? row.generation : null;
}

/**
 * queued の attempt（run が進行中のものだけ）。定期の掃除が、世代を 1 つ進めた task の名前で積み直す対象
 * （積み込みの失敗・失われた task を拾う。requeueAttempt で世代を進めてから積む）。古い run から、1 回に上限つき。読むだけ。
 * 続きは `after`（前の回の最後の `runId`・`stepIndex`）の次から。古い 100 件が queued のまま残っても、後ろの attempt に届く。
 * `after` の run が無くなっていれば（物理削除）何も返さない（次の掃除は先頭から読み直す）。
 */
export async function listQueuedAttempts(
  db: Queryable,
  options: { limit?: number; after?: Pick<AttemptRef, "runId" | "stepIndex"> } = {},
): Promise<AttemptRef[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  const after = options.after;
  if (after !== undefined && (!isPageId(after.runId) || !Number.isInteger(after.stepIndex) || after.stepIndex < 0)) return [];
  const queued = await db.query<{ run_id: string; step_index: number; generation: number }>(
    `SELECT a.run_id, a.step_index, a.generation
       FROM step_attempts a
       JOIN step_runs r ON r.id = a.run_id
      WHERE a.state = 'queued' AND r.state IN ('queued', 'running')
        AND ($2::uuid IS NULL
             OR (r.created_at, a.run_id, a.step_index) > ((SELECT created_at FROM step_runs WHERE id = $2::uuid), $2::uuid, $3::integer))
      ORDER BY r.created_at, a.run_id, a.step_index
      LIMIT $1`,
    [limit, after?.runId ?? null, after?.stepIndex ?? 0],
  );
  return queued.rows.map((row) => ({ runId: row.run_id, stepIndex: row.step_index, generation: row.generation }));
}

type StalePageRow = { id: string; blocks: Block[]; step_status: StepStatus | null; version: string };

/**
 * 前提変更の再計算。完了済み（done / stale）の段階について、今の基準（前の段階のサブページ・段階 0 は録音ページの blocks と指示文）
 * が記録した基準（最後に成功した attempt の input_basis_v2）と違えば、その段階から後の done を stale にし、戻れば done に戻す。
 * 読むのは 1 つの snapshot、書くのは「読んだときから行が変わっていない（xmin が同じ）」ときだけ（並行する確定・作り直しを上書きしない）。
 * 戻り値は状態を変えたサブページの数。
 */
export async function refreshStale(db: StepRunsDb, owner: OwnerId, parentId: string, recipe: StepRecipe): Promise<number> {
  assertOwner(owner);
  assertRecipe(recipe);
  if (!isPageId(parentId)) return 0;
  const pageIds: string[] = [];
  const client = await db.connect();
  let parentBlocks: Block[] | null;
  let pages: Map<string, StalePageRow>;
  let recorded: Map<string, unknown>;
  let current: Map<string, StepBasis>;
  let structuralMismatch: boolean;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const parent = await client.query<{ blocks: Block[] }>(
        "SELECT blocks FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL",
        [owner, parentId],
      );
      parentBlocks = parent.rows[0]?.blocks ?? null;
      const latestAttemptIds = await client.query<{ step_id: string; page_id: string }>(
        `SELECT a.step_id, a.page_id FROM step_attempts a
          WHERE a.run_id = (
            SELECT id FROM step_runs WHERE owner = $1 AND parent = $2 AND recipe = $3
             ORDER BY created_at DESC, id DESC LIMIT 1
          )
          ORDER BY a.step_index`,
        [owner, parentId, recipe.id],
      );
      structuralMismatch = latestAttemptIds.rows.length !== recipe.steps.length ||
        latestAttemptIds.rows.some((row, index) => row.step_id !== recipe.steps[index]?.id);
      const previousPageByStep = new Map(latestAttemptIds.rows.map((row) => [row.step_id, row.page_id] as const));
      pageIds.push(...recipe.steps.map((step) => previousPageByStep.get(step.id) ?? stepPageIdForStep(parentId, recipe.id, step.id)));
      const rows = await client.query<StalePageRow>(
        `SELECT id, blocks, step_status, xmin::text AS version FROM pages
          WHERE owner = $1 AND parent = $2 AND recipe = $3 AND kind = 'step' AND deleted_at IS NULL AND id = ANY($4::uuid[])`,
        [owner, parentId, recipe.id, pageIds],
      );
      pages = new Map(rows.rows.map((row) => [row.id, row]));
      const bases = await client.query<{ step_id: string; input_basis_v2: unknown }>(
        `SELECT DISTINCT ON (a.step_id) a.step_id, a.input_basis_v2
           FROM step_attempts a
           JOIN step_runs r ON r.id = a.run_id
          WHERE r.owner = $1 AND r.parent = $2 AND r.recipe = $3 AND a.state = 'succeeded' AND a.input_basis_v2 IS NOT NULL
          ORDER BY a.step_id, a.finished_at DESC`,
        [owner, parentId, recipe.id],
      );
      recorded = new Map(bases.rows.map((row) => [row.step_id, row.input_basis_v2]));
      current = new Map();
      for (const [index] of recipe.steps.entries()) {
        const stepIds = recipe.steps.slice(0, index).map((step, prior) => ({ id: step.id, pageId: pageIds[prior]! }));
        const input = await readStepInput(client, { owner, parentId, previousPageId: index === 0 ? null : pageIds[index - 1]!, recipe: recipe.id, stepIndex: index, stepIds: recipe.steps.map((step) => step.id), upstreamPageIds: stepIds });
        if (input) current.set(recipe.steps[index]!.id, computeStepBasis(recipe, index, input));
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
  if (parentBlocks === null) return 0;

  let changed = 0;
  let upstreamFresh = true;
  for (const [index] of recipe.steps.entries()) {
    const page = pages.get(pageIds[index]!);
    const status = page?.step_status ?? null;
    if (!page || (status !== "done" && status !== "stale")) {
      // 済みでない段階の後ろは、前提が定まっていない
      upstreamFresh = false;
      continue;
    }
    const stepId = recipe.steps[index]!.id;
    const basis = current.get(stepId);
    const reasons = basis ? stepStaleReasons(parseStepBasis(recorded.get(stepId)), basis) : [];
    const fresh: boolean = !structuralMismatch && upstreamFresh && basis !== undefined && reasons.length === 0;
    upstreamFresh = fresh;
    const want: StepStatus = fresh ? "done" : "stale";
    if (want === status) continue;
    const result = await db.query(
      `UPDATE pages SET step_status = $3
        WHERE owner = $1 AND id = $2 AND deleted_at IS NULL AND step_status = $4 AND xmin::text = $5`,
      [owner, page.id, want, status, page.version],
    );
    changed += result.rowCount ?? 0;
  }
  return changed;
}

/** GET の帯に渡す理由。成功 attempt の記録だけを、現在の入力と同一 snapshot で比較する。 */
export async function readStepStaleReasons(db: StepRunsDb, owner: OwnerId, parentId: string, recipe: StepRecipe): Promise<Record<number, StepStaleReason[]>> {
  assertOwner(owner);
  if (!isPageId(parentId)) return {};
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const latest = await client.query<{ step_id: string; page_id: string }>(
        `SELECT a.step_id, a.page_id FROM step_attempts a
          WHERE a.run_id = (
            SELECT id FROM step_runs WHERE owner = $1 AND parent = $2 AND recipe = $3
             ORDER BY created_at DESC, id DESC LIMIT 1
          )
          ORDER BY a.step_index`, [owner, parentId, recipe.id],
      );
      const pageByStep = new Map(latest.rows.map((row) => [row.step_id, row.page_id] as const));
      const rows = await client.query<{ step_id: string; input_basis_v2: unknown }>(
        `SELECT DISTINCT ON (a.step_id) a.step_id, a.input_basis_v2
           FROM step_attempts a JOIN step_runs r ON r.id = a.run_id
          WHERE r.owner = $1 AND r.parent = $2 AND r.recipe = $3 AND a.state = 'succeeded' AND a.input_basis_v2 IS NOT NULL
          ORDER BY a.step_id, a.finished_at DESC`, [owner, parentId, recipe.id],
      );
      const recorded = new Map(rows.rows.map((row) => [row.step_id, row.input_basis_v2]));
      const reasons: Record<number, StepStaleReason[]> = {};
      let inherited: StepStaleReason[] = [];
      for (const [index] of recipe.steps.entries()) {
        const upstreamPageIds = recipe.steps.slice(0, index).map((step, prior) => ({ id: step.id, pageId: pageByStep.get(step.id) ?? stepPageIdForStep(parentId, recipe.id, step.id) }));
        const input = await readStepInput(client, { owner, parentId, previousPageId: upstreamPageIds.at(-1)?.pageId ?? null, recipe: recipe.id, stepIndex: index, stepIds: recipe.steps.map((step) => step.id), upstreamPageIds });
        const stepId = recipe.steps[index]!.id;
        const own = input ? stepStaleReasons(parseStepBasis(recorded.get(stepId)), computeStepBasis(recipe, index, input)) : [];
        inherited = [...new Set([...inherited, ...own])];
        reasons[index] = inherited;
      }
      await client.query("COMMIT");
      return reasons;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally { client.release(); }
}
