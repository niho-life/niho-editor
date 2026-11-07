import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isPageId } from "./store.ts";
import type { Block, MadeFrom, OwnerId, PageKind, PageRole, Queryable, StepStatus } from "./types.ts";
import { parseRecipeSnapshot, snapshotOf, type RecipeSnapshot } from "./recipe-snapshot.ts";
import { computeChunkBasis, computeStepBasis, parseStepBasis, stepStaleReasons, type StepBasis, type StepMaterials, type StepStaleReason } from "./step-basis.ts";
import { isPageEntity } from "./page-fields.ts";
import { isSettingsTerm } from "./settings.ts";
export { parseRecipeSnapshot, snapshotOf, type RecipeSnapshot } from "./recipe-snapshot.ts";

/**
 * 手順（#37）の実行の層。docs/architecture/editor-steps-execution.md §5（方式 B）。
 *
 * run は**フォルダ**に属し（`step_runs.parent`。#309。1 フォルダに 1 つの手順、進行中の run は 1 つ）、**入力のタブ**（`input_tab`）から
 * 段階 `from_step`〜最後の attempt までを作る。各段階の出力は、フォルダ直下の役割ページ（`role = { kind: 'step', recipe, stepId }` の入れ物）の
 * **新しいタブ**（`made_from = { kind: 'step', run, input }`）。作り直す（regenerate）は同じタブへ、同じ入力でもう 1 つ（sibling）は同じ入れ物の新しいタブ。
 *
 * 状態遷移はすべて「世代（generation）と状態を条件にした UPDATE」（CAS）で行い、読んだ値をもとに書かない。
 * 複数の行を書く遷移は 1 transaction で、最初に run の行を FOR UPDATE で取る（同じ run の遷移を直列にし、
 * 行の lock の順を run → attempt → ページ に固定してデッドロックを避ける）。出力のタブを書くのは、そのフォルダで
 * 進行中の唯一の run だけ（step_runs_active_idx）なので、別の run と出力のタブの lock を取り合わない。
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
  /** 最初の attempt の段階（入力のタブの役割の次。#309）。 */
  fromStep: number;
  /** 入力のタブ（#309。migration 前の run は null）。 */
  inputTab: string | null;
  recipeSnapshot: RecipeSnapshot;
  recipeRevision: number;
  steps: StepRunStepView[];
};

// ---------------------------------------------------------------------------
// 純粋な部分

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
  input_tab: string | null;
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
    `SELECT r.id, r.recipe, r.state, r.from_step, r.input_tab, r.recipe_snapshot, r.recipe_revision,
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
    inputTab: first.input_tab,
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
  idempotencyKey?: string | null;
} & (
  /** 入力のタブから、その段階まで作る（間の段階が無ければ一緒に。#309）。入力の役割が段階 k なら k+1 から。 */
  | { inputTab: string; toStep: number }
  /** 作り直す: 段階の出力のタブを、同じ入力で同じタブへ書き直す。 */
  | { regenerate: string }
  /** 同じ入力でもう 1 つ: 段階の出力のタブと同じ入力で、同じ入れ物に新しいタブ。 */
  | { sibling: string }
);

export type CreateRunResult =
  | { status: "created"; run: StepRunView }
  /** 同じ `Idempotency-Key` の run が既にある（新しく作らない）。 */
  | { status: "existing"; run: StepRunView }
  /** フォルダ・タブが本人の生きているものでない（別の人・削除済み・存在しない・不正な id・そのフォルダの中にない）。404 にする。 */
  | { status: "not_found" }
  /** 同じフォルダで queued / running の run が既にある。409 にする。 */
  | { status: "run_in_progress" }
  /** 段階が範囲の外（入力の役割より前・最後より後）、作り直す・もう 1 つの対象が段階の出力でない、その入力が消えている。400 にする。 */
  | { status: "invalid_from_step" }
  | { status: "recipe_changed" };

/** 入力のタブの役割から、最初に作る段階（役割が段階 k の入れ物のタブなら k+1、それ以外は 0）。手順が違う役割は 0。 */
function startStepOf(role: PageRole | null, recipeId: string, steps: readonly { id: string }[]): number {
  if (!role || role.kind !== "step" || role.recipe !== recipeId) return 0;
  const index = steps.findIndex((step) => step.id === role.stepId);
  return index < 0 ? 0 : index + 1;
}

type TargetTabRow = { id: string; revision: number; page: string | null; kind: PageKind; step_status: StepStatus | null; made_from: MadeFrom | null; role: PageRole | null };

/** 段階の出力のタブで、まだ済んでいない（待ち・作成中・失敗）。そこからは次の段階を作れない（本文が無い・途中）。 */
function isUnfinishedOutput(tab: Pick<TargetTabRow, "step_status" | "made_from">): boolean {
  return tab.made_from?.kind === "step" && (tab.step_status === "wait" || tab.step_status === "run" || tab.step_status === "failed");
}

/**
 * run を作る（#309）。フォルダ・入力のタブ・冪等・進行中の検査と、出力のタブの用意を同じ transaction で行う。
 * 段階 `from_step`〜`toStep` ごとに、フォルダ直下の役割ページ（無ければ作る）に**新しいタブ**を足し（本文なし・`wait`・
 * `made_from` は run と入力）、最初の attempt を `queued`・以降を `pending` にする。作り直す（`regenerate`）は新しいタブを作らず
 * そのタブへ、同じ入力でもう 1 つ（`sibling`）はそのタブの入れ物に新しいタブ。
 */
export async function createRun(db: StepRunsDb, owner: OwnerId, folderId: string, input: CreateRunInput): Promise<CreateRunResult> {
  assertOwner(owner);
  assertRecipe(input.recipe);
  const { recipe } = input;
  const target = "inputTab" in input ? input.inputTab : "regenerate" in input ? input.regenerate : input.sibling;
  if ("inputTab" in input && (!Number.isInteger(input.toStep) || input.toStep < 0)) throw new RangeError("editor-store: toStep is out of range");
  const key = input.idempotencyKey ?? null;
  if (key !== null && !isIdempotencyKey(key)) throw new TypeError("editor-store: invalid idempotency key");
  if (!isPageId(folderId) || !isPageId(target)) return { status: "not_found" };

  return inTransaction<CreateRunResult>(db, async (client) => {
    // フォルダが本人の生きているフォルダであること（作り終えるまで消させない。進行中の run の判定と直列にする）
    const folder = await client.query<{ id: string; lang: string }>(
      "SELECT id, lang FROM pages WHERE owner = $1 AND id = $2 AND kind = 'folder' AND deleted_at IS NULL FOR UPDATE",
      [owner, folderId],
    );
    const folderRow = folder.rows[0];
    if (!folderRow) throw new Rollback<CreateRunResult>({ status: "not_found" });
    // 対象のタブ（入力・作り直す・もう 1 つ）はそのフォルダの本文を持つ行
    const tab = await client.query<TargetTabRow>(
      `SELECT t.id, t.revision, t.page, t.kind, t.step_status, t.made_from, h.role
         FROM pages t
         LEFT JOIN pages h ON h.owner = t.owner AND h.id = t.page AND h.deleted_at IS NULL
        WHERE t.owner = $1 AND t.id = $2 AND t.parent = $3 AND t.deleted_at IS NULL AND t.kind IN ('note', 'rec', 'article')
        FOR UPDATE OF t`,
      [owner, target, folderRow.id],
    );
    const tabRow = tab.rows[0];
    if (!tabRow) throw new Rollback<CreateRunResult>({ status: "not_found" });

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
      [owner, folderRow.id, recipe.id],
    );
    const prior = previous.rows[0];
    const snapshot = prior ? parseRecipeSnapshot(prior.recipe_snapshot) : snapshotFromRecipe(recipe);
    if (!snapshot || snapshot.id !== recipe.id || (prior && (!Number.isInteger(prior.recipe_revision) || (prior.recipe_revision ?? 0) < 1))) {
      throw new Error("editor-store: invalid run recipe snapshot");
    }
    const revision = prior ? prior.recipe_revision! : currentRevision;

    // 段階の始まりと終わり・入力のタブ
    let inputTab: string;
    let inputRevision: number;
    let fromStep: number;
    let toStep: number;
    let regenerateTab: string | null = null;
    let siblingHolder: string | null = null;
    if ("inputTab" in input) {
      fromStep = startStepOf(tabRow.role, recipe.id, snapshot.steps);
      toStep = input.toStep;
      inputTab = tabRow.id;
      inputRevision = tabRow.revision;
      if (toStep < fromStep || toStep >= snapshot.steps.length || isUnfinishedOutput(tabRow)) throw new Rollback<CreateRunResult>({ status: "invalid_from_step" });
    } else {
      // 作り直す・同じ入力でもう 1 つ: 段階の出力のタブだけ。入力はそのタブの系譜（made_from.input）
      const made = tabRow.made_from;
      const role = tabRow.role;
      const stepIndex = role && role.kind === "step" && role.recipe === recipe.id ? snapshot.steps.findIndex((step) => step.id === role.stepId) : -1;
      if (!made || made.kind !== "step" || stepIndex < 0 || !isPageId(made.input)) throw new Rollback<CreateRunResult>({ status: "invalid_from_step" });
      const source = await client.query<{ id: string; revision: number }>(
        "SELECT id, revision FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL",
        [owner, made.input],
      );
      const sourceRow = source.rows[0];
      if (!sourceRow) throw new Rollback<CreateRunResult>({ status: "invalid_from_step" });
      inputTab = sourceRow.id;
      inputRevision = sourceRow.revision;
      fromStep = toStep = stepIndex;
      if ("regenerate" in input) regenerateTab = tabRow.id;
      else siblingHolder = tabRow.page;
    }

    // 進行中の run・同じ key の run とぶつかったら作らない（一意の索引が判定する。読んでから作る race を作らない）
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO step_runs (owner, parent, recipe, from_step, idempotency_key, recipe_snapshot, recipe_revision, input_tab, input_revision)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [owner, folderRow.id, recipe.id, fromStep, key, JSON.stringify(snapshot), revision, inputTab, inputRevision],
    );
    const runId = inserted.rows[0]?.id;
    if (!runId) {
      const raced = await existingByKey();
      if (raced) return { status: "existing", run: await requireRunView(client, owner, raced) } satisfies CreateRunResult;
      throw new Rollback<CreateRunResult>({ status: "run_in_progress" });
    }

    // 段階ごとの出力先（役割ページの新しいタブ。作り直すときはそのタブ）。入力は前の段階の出力（最初は入力のタブ）
    const outputs: string[] = [];
    let previousTab = inputTab;
    for (let index = fromStep; index <= toStep; index++) {
      const step = snapshot.steps[index]!;
      const madeFrom = JSON.stringify({ kind: "step", run: runId, input: previousTab, inputRevision: index === fromStep ? inputRevision : 0 });
      let outputTab: string;
      if (regenerateTab !== null) {
        await client.query("UPDATE pages SET step_status = 'wait', made_from = $3::jsonb WHERE owner = $1 AND id = $2", [owner, regenerateTab, madeFrom]);
        outputTab = regenerateTab;
      } else {
        const holder = siblingHolder !== null && index === fromStep ? siblingHolder : await stepHolder(client, owner, folderRow.id, folderRow.lang, recipe.id, step);
        const made = await client.query<{ id: string }>(
          `INSERT INTO pages (owner, kind, title, lang, blocks, parent, page, recipe, step_status, made_from, sort_order)
           SELECT $1, 'note', h.title, h.lang, '[]'::jsonb, h.parent, h.id, $3, 'wait', $4::jsonb,
                  COALESCE((SELECT max(t.sort_order) FROM pages t WHERE t.owner = h.owner AND t.page = h.id AND t.deleted_at IS NULL), 0) + 1
             FROM pages h
            WHERE h.owner = $1 AND h.id = $2 AND h.deleted_at IS NULL
           RETURNING id`,
          [owner, holder, recipe.id, madeFrom],
        );
        const made0 = made.rows[0];
        if (!made0) throw new Error("editor-store: insert returned no output tab");
        outputTab = made0.id;
        await client.query("UPDATE pages SET last_tab = $3, updated_at = GREATEST(clock_timestamp(), updated_at) WHERE owner = $1 AND id = $2", [owner, holder, outputTab]);
      }
      outputs.push(outputTab);
      previousTab = outputTab;
    }

    await client.query(
      `INSERT INTO step_attempts (run_id, step_index, step_id, page_id, state)
       SELECT $1::uuid, v.step_index, v.step_id, v.page_id, v.state
         FROM unnest($2::integer[], $3::text[], $4::uuid[], $5::text[]) AS v(step_index, step_id, page_id, state)`,
      [
        runId,
        outputs.map((_, offset) => fromStep + offset),
        outputs.map((_, offset) => snapshot.steps[fromStep + offset]!.id),
        outputs,
        outputs.map((_, offset) => (offset === 0 ? "queued" : "pending")),
      ],
    );
    return { status: "created", run: await requireRunView(client, owner, runId) } satisfies CreateRunResult;
  });
}

/** 段階の役割ページ（フォルダ直下の `role = { kind: 'step', recipe, stepId }` の入れ物）。無ければ作る（題名は段階の名前）。 */
async function stepHolder(client: PoolClient, owner: OwnerId, folderId: string, lang: string, recipeId: string, step: { id: string; name: string }): Promise<string> {
  const role = JSON.stringify({ kind: "step", recipe: recipeId, stepId: step.id });
  const found = await client.query<{ id: string }>(
    `SELECT id FROM pages
      WHERE owner = $1 AND parent = $2 AND kind = 'page' AND deleted_at IS NULL AND role = $3::jsonb
      ORDER BY created_at, id LIMIT 1
      FOR UPDATE`,
    [owner, folderId, role],
  );
  const existing = found.rows[0];
  if (existing) return existing.id;
  const made = await client.query<{ id: string }>(
    `INSERT INTO pages (owner, kind, title, lang, blocks, parent, role)
     VALUES ($1, 'page', $2, $3, '[]'::jsonb, $4, $5::jsonb)
     RETURNING id`,
    [owner, step.name, lang, folderId, role],
  );
  const row = made.rows[0];
  if (!row) throw new Error("editor-store: insert returned no holder");
  return row.id;
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
    const parent = await client.query("SELECT id FROM pages WHERE owner=$1 AND id=$2 AND kind='folder' AND deleted_at IS NULL FOR UPDATE", [owner, parentId]);
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
    const newIndex = new Map(snapshot.steps.map((step, index) => [step.id, index] as const));
    // この run の attempt（段階の一部のこともある。#309）が全部、新しい設計にもあり、並びが連続していること。
    // 段階の追加・削除で attempt の無い段階ができるのは新しい run の仕事（この run には書く行が無い）
    const targets = attempts.rows.map((attempt) => newIndex.get(attempt.step_id));
    if (targets.some((index) => index === undefined) || previousSnapshot.steps.length !== snapshot.steps.length) return { status: "conflict" };
    const sorted = [...(targets as number[])].sort((a, b) => a - b);
    if (sorted.some((index, at) => at > 0 && index !== sorted[at - 1]! + 1)) return { status: "conflict" };
    // Move indices out of the active range first so unique (run_id, step_index) remains valid
    // while two or more step IDs exchange positions.
    const offset = snapshot.steps.length;
    if (attempts.rows.length > 0) {
      await client.query("UPDATE step_attempts SET step_index=step_index+$2 WHERE run_id=$1", [runId, offset]);
      for (const attempt of attempts.rows) {
        const remapped = await client.query(
          "UPDATE step_attempts SET step_index=$3 WHERE run_id=$1 AND step_id=$2",
          [runId, attempt.step_id, newIndex.get(attempt.step_id)],
        );
        if (remapped.rowCount !== 1) throw new Error("editor-store: recipe snapshot step remap was incomplete");
      }
    }
    await client.query(
      "UPDATE step_runs SET recipe_snapshot=$2::jsonb, recipe_revision=$3, from_step=$4, updated_at=GREATEST(clock_timestamp(), updated_at) WHERE id=$1",
      [runId, JSON.stringify(snapshot), current.rows[0].revision, sorted[0] ?? 0],
    );
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

/** AI チャットの文脈になる、最新の run の文書ガイドと手順の固有名詞（run の写し。今の設定ではない）。 */
export type RunGuide = { recipeName: string; guide: string; terms: RecipeSnapshot["terms"] };

/**
 * 開いているページのフォルダ（フォルダ自身か、その中のページ・タブ）の最新の run の文書ガイドと手順の固有名詞を返す（#309）。
 * run が無い・写しが読めない・フォルダの外のページ・他人のページは null。
 * 手順の段階と同じ「run の写し」を読むので、設定でガイドを書き換えても、作ったときのガイドで直せる。
 */
export async function getRunGuide(db: Queryable, owner: OwnerId, pageId: string): Promise<RunGuide | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  const result = await db.query<{ recipe_snapshot: unknown }>(
    `SELECT r.recipe_snapshot
       FROM pages p
       JOIN pages f ON f.owner = p.owner AND f.deleted_at IS NULL AND f.kind = 'folder'
                   AND f.id = CASE WHEN p.kind = 'folder' THEN p.id ELSE p.parent END
       JOIN LATERAL (
         SELECT recipe_snapshot FROM step_runs
          WHERE owner = f.owner AND parent = f.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
       ) r ON true
      WHERE p.owner = $1 AND p.id = $2 AND p.deleted_at IS NULL`,
    [owner, pageId],
  );
  const snapshot = parseRecipeSnapshot(result.rows[0]?.recipe_snapshot);
  return snapshot ? { recipeName: snapshot.name, guide: snapshot.guide, terms: snapshot.terms } : null;
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
  /** run のフォルダ（#309）。 */
  parentId: string;
  /** run の入力のタブ（migration 前の run は null）。資料の本文の出どころはこのタブの系譜の根。 */
  inputTabId: string | null;
  recipe: string;
  recipeSnapshot: RecipeSnapshot | null;
  stepId: string;
  pageId: string;
  /** 前の段階の出力（この run の最初の段階なら入力のタブ。段階 0 は null）。 */
  previousPageId: string | null;
  /** 上流の段階と成果物のタブ（run の最初の段階より前の分は入力のタブ）。並べ替え後も段階 ID とページ ID の対応を保つ。 */
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
    const run = await client.query<{ owner: string; parent: string; recipe: string; recipe_snapshot: unknown; state: RunState; from_step: number; input_tab: string | null }>(
      "SELECT owner, parent, recipe, recipe_snapshot, state, from_step, input_tab FROM step_runs WHERE id = $1 FOR UPDATE",
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
          AND (a.step_index = $4::integer OR EXISTS (
                SELECT 1 FROM step_attempts prev
                 WHERE prev.run_id = a.run_id AND prev.step_index = a.step_index - 1
                   AND prev.state IN ('succeeded', 'reused')))
        RETURNING a.generation, a.tries, a.step_id, a.page_id, a.chunk_count, a.chunk_index, a.chunk_basis, a.chunk_blocks`,
      [runId, stepIndex, leaseSeconds, runRow.from_step],
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
    const snapshot = parseRecipeSnapshot(runRow.recipe_snapshot);
    const upstream = upstreamOf(snapshot, runRow.from_step, runRow.input_tab, stepIndex === 0
      ? []
      : (await client.query<{ step_id: string; page_id: string }>(
          "SELECT step_id, page_id FROM step_attempts WHERE run_id = $1 AND step_index < $2 ORDER BY step_index",
          [runId, stepIndex],
        )).rows.map((row) => ({ id: row.step_id, pageId: row.page_id })));
    return {
      ok: true,
      claim: {
        runId,
        stepIndex,
        generation: attempt.generation,
        tries: attempt.tries,
        owner: runRow.owner,
        parentId: runRow.parent,
        inputTabId: runRow.input_tab,
        recipe: runRow.recipe,
        recipeSnapshot: snapshot,
        stepId: attempt.step_id,
        pageId: attempt.page_id,
        previousPageId: stepIndex === 0 ? null : (upstream.at(-1)?.pageId ?? null),
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

/**
 * 上流の段階と成果物（#309）: run が段階 k から始まるなら、段階 k-1 の成果物は入力のタブ。その前の段階の成果物は無い
 * （基準では空の本文として数える。記録と現在で同じ数え方なので前提変更の判定はそろう）。
 */
function upstreamOf(snapshot: RecipeSnapshot | null, fromStep: number, inputTab: string | null, attempts: readonly { id: string; pageId: string }[]): { id: string; pageId: string }[] {
  const before = snapshot?.steps[fromStep - 1];
  const input = fromStep > 0 && inputTab !== null && before ? [{ id: before.id, pageId: inputTab }] : [];
  return [...input, ...attempts];
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

/**
 * ページの本文を資料として読む SQL（`x` は pages の行）。文字起こしのタブ（#310。page_transcripts）に段落があれば、
 * 段落ごとに「[分:秒] 話者: 文」の段落にする（#309）。それ以外は `blocks` のまま。
 */
const PAGE_TEXT_SQL = `
  CASE WHEN EXISTS (SELECT 1 FROM page_transcripts pt WHERE pt.owner = x.owner AND pt.page_id = x.id AND jsonb_array_length(pt.segments) > 0)
       THEN (SELECT jsonb_agg(jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text',
                      CASE WHEN jsonb_typeof(s.seg->'start') = 'number'
                           THEN '[' || floor((s.seg->>'start')::numeric / 60)::int::text || ':' || lpad(floor(mod((s.seg->>'start')::numeric, 60))::int::text, 2, '0') || '] '
                           ELSE '' END
                      || CASE WHEN jsonb_typeof(s.seg->'speaker') = 'number'
                              THEN COALESCE(pr.speaker_names->>(s.seg->>'speaker'), '話者' || (s.seg->>'speaker')) || ': '
                              ELSE '' END
                      || COALESCE(s.seg->>'text', '')))) ORDER BY s.ord)
               FROM page_transcripts pr, jsonb_array_elements(pr.segments) WITH ORDINALITY s(seg, ord)
              WHERE pr.owner = x.owner AND pr.page_id = x.id)
       ELSE x.blocks END`;

/**
 * 段階の入力（#309）。run の入力のタブの系譜（`made_from.input` を最大 8 段たどった根）を資料の本文（録音なら文字起こし）とし、
 * 「この録音について」（背景・登場人物・固有名詞）はその根の欄。前の段階の出力・上流の成果物・同じフォルダの役割の無いページ
 * （参考）・設定を、owner で絞った単一 SQL snapshot で読む。入力のタブが無ければ null。
 */
export async function readStepInput(
  db: Queryable,
  claim: Pick<StepClaim, "owner" | "parentId" | "inputTabId" | "previousPageId"> & { upstreamPageIds?: readonly { id: string; pageId: string }[] },
): Promise<StepInput | null> {
  assertOwner(claim.owner);
  if (!isPageId(claim.parentId) || claim.inputTabId === null || !isPageId(claim.inputTabId)) return null;
  if (claim.previousPageId !== null && !isPageId(claim.previousPageId)) return null;
  const upstream = claim.upstreamPageIds ?? [];
  const result = await db.query<{ root: string | null; parent_blocks: Block[] | null; background: string | null; previous_blocks: Block[] | null; upstream: { id: string; blocks: Block[] }[]; refs: { id: string; blocks: Block[] }[]; entities: StepMaterials["fields"]["entities"]; terms: StepMaterials["fields"]["terms"]; ai_lang: string | null; glossary: StepMaterials["settings"]["glossary"] | null; about_name: string | null; about: string | null }>(
    `WITH RECURSIVE chain AS (
       SELECT p.id, p.made_from, 0 AS hops FROM pages p WHERE p.owner = $1 AND p.id = $3 AND p.deleted_at IS NULL
       UNION ALL
       SELECT p.id, p.made_from, c.hops + 1
         FROM chain c
         JOIN pages p ON p.owner = $1 AND p.deleted_at IS NULL AND c.made_from->>'kind' = 'step' AND p.id = (c.made_from->>'input')::uuid
        WHERE c.hops < 8
     ),
     root AS (SELECT c.id FROM chain c ORDER BY c.hops DESC LIMIT 1)
     SELECT root.id AS root,
            (SELECT ${PAGE_TEXT_SQL} FROM pages x WHERE x.owner = $1 AND x.id = root.id AND x.deleted_at IS NULL) AS parent_blocks,
            COALESCE(f.background, '') AS background,
            (SELECT ${PAGE_TEXT_SQL} FROM pages x WHERE x.owner = $1 AND x.id = $4 AND x.deleted_at IS NULL) AS previous_blocks,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id', prior.step_id, 'blocks', COALESCE((SELECT ${PAGE_TEXT_SQL} FROM pages x WHERE x.owner = $1 AND x.id = prior.page_id AND x.deleted_at IS NULL), '[]'::jsonb)) ORDER BY prior.ord)
              FROM unnest($5::text[], $6::uuid[]) WITH ORDINALITY prior(step_id, page_id, ord)), '[]'::jsonb) AS upstream,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'blocks', s.blocks) ORDER BY s.created_at, s.id)
              FROM pages s
              LEFT JOIN pages h ON h.owner = s.owner AND h.id = s.page
             WHERE s.owner = $1 AND s.parent = $2 AND s.deleted_at IS NULL AND s.kind IN ('note', 'article')
               AND (h.id IS NULL OR h.role IS NULL) AND COALESCE(s.made_from->>'kind', '') <> 'step'
               AND s.id <> ALL(SELECT c.id FROM chain c) AND s.id IS DISTINCT FROM $4::uuid AND s.id <> ALL($6::uuid[])), '[]'::jsonb) AS refs,
            COALESCE(f.entities, '[]'::jsonb) AS entities, COALESCE(f.terms, '[]'::jsonb) AS terms,
            e.ai_lang, e.glossary, e.about_name, e.about
       FROM root
       LEFT JOIN page_fields f ON f.owner = $1 AND f.page_id = root.id
       LEFT JOIN editor_settings e ON e.owner = $1`,
    [claim.owner, claim.parentId, claim.inputTabId, claim.previousPageId, upstream.map((item) => item.id), upstream.map((item) => item.pageId)],
  );
  const row = result.rows[0];
  if (!row?.root || !row.parent_blocks) return null;
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
    // createRun と同じ順（フォルダ → run）で lock する。進行中の run の作成と直列にする
    const parent = await client.query("SELECT id FROM pages WHERE owner = $1 AND id = $2 AND kind = 'folder' AND deleted_at IS NULL FOR UPDATE", [owner, parentId]);
    if (!parent.rowCount) return { status: "not_found" } satisfies ResumeRunResult;
    const run = await client.query<{ state: RunState; recipe: string; recipe_snapshot: unknown; from_step: number; input_tab: string | null }>(
      "SELECT state, recipe, recipe_snapshot, from_step, input_tab FROM step_runs WHERE owner = $1 AND id = $2 AND parent = $3 FOR UPDATE",
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
    const upstreamPageIds = upstreamOf(snapshot, runRow.from_step, runRow.input_tab, attempts.rows.filter((row) => row.step_index < failed.step_index).map((row) => ({ id: row.step_id, pageId: row.page_id })));
    const input = await readStepInput(client, {
      owner, parentId, inputTabId: runRow.input_tab, previousPageId: failed.step_index === 0 ? null : (upstreamPageIds.at(-1)?.pageId ?? null), upstreamPageIds,
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

type StalePageRow = { id: string; step_status: StepStatus | null; version: string };

/** 最新 run（フォルダ・手順）の attempt と、その出力のタブの今の基準（REPEATABLE READ の 1 snapshot で読む。#309）。 */
type StaleSnapshot = {
  run: { id: string; from_step: number; input_tab: string | null; snapshot: RecipeSnapshot | null };
  attempts: { step_index: number; step_id: string; page_id: string }[];
  pages: Map<string, StalePageRow>;
  /** 出力のタブごとの、最後に成功した attempt の記録した基準。 */
  recorded: Map<string, unknown>;
  /** 出力のタブごとの、今の基準（入力が読めなければ無い）。 */
  current: Map<string, StepBasis>;
  /** attempt の段階が手順の並びと合っていない（段階の追加・削除・並べ替えのあと）。 */
  structuralMismatch: boolean;
};

async function readStaleSnapshot(client: PoolClient, owner: OwnerId, folderId: string, recipe: StepRecipe): Promise<StaleSnapshot | null> {
  const latest = await client.query<{ id: string; from_step: number; input_tab: string | null; recipe_snapshot: unknown }>(
    `SELECT id, from_step, input_tab, recipe_snapshot FROM step_runs
      WHERE owner = $1 AND parent = $2 AND recipe = $3
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [owner, folderId, recipe.id],
  );
  const runRow = latest.rows[0];
  if (!runRow) return null;
  const attempts = (await client.query<{ step_index: number; step_id: string; page_id: string }>(
    "SELECT step_index, step_id, page_id FROM step_attempts WHERE run_id = $1 ORDER BY step_index",
    [runRow.id],
  )).rows;
  const structuralMismatch = attempts.length === 0 || attempts.some((row) => row.step_id !== recipe.steps[row.step_index]?.id);
  const rows = await client.query<StalePageRow>(
    "SELECT id, step_status, xmin::text AS version FROM pages WHERE owner = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])",
    [owner, attempts.map((row) => row.page_id)],
  );
  const bases = await client.query<{ page_id: string; input_basis_v2: unknown }>(
    `SELECT DISTINCT ON (a.page_id) a.page_id, a.input_basis_v2
       FROM step_attempts a
       JOIN step_runs r ON r.id = a.run_id
      WHERE r.owner = $1 AND r.parent = $2 AND r.recipe = $3 AND a.state = 'succeeded' AND a.input_basis_v2 IS NOT NULL
        AND a.page_id = ANY($4::uuid[])
      ORDER BY a.page_id, a.finished_at DESC`,
    [owner, folderId, recipe.id, attempts.map((row) => row.page_id)],
  );
  const snapshot = parseRecipeSnapshot(runRow.recipe_snapshot);
  const current = new Map<string, StepBasis>();
  for (const [at, attempt] of attempts.entries()) {
    const index = attempt.step_index;
    if (index >= recipe.steps.length) continue;
    const upstreamPageIds = upstreamOf(snapshot, runRow.from_step, runRow.input_tab, attempts.slice(0, at).map((row) => ({ id: row.step_id, pageId: row.page_id })));
    const input = await readStepInput(client, { owner, parentId: folderId, inputTabId: runRow.input_tab, previousPageId: index === 0 ? null : (upstreamPageIds.at(-1)?.pageId ?? null), upstreamPageIds });
    if (input) current.set(attempt.page_id, computeStepBasis(recipe, index, input));
  }
  return {
    run: { id: runRow.id, from_step: runRow.from_step, input_tab: runRow.input_tab, snapshot },
    attempts,
    pages: new Map(rows.rows.map((row) => [row.id, row])),
    recorded: new Map(bases.rows.map((row) => [row.page_id, row.input_basis_v2])),
    current,
    structuralMismatch,
  };
}

async function inReadSnapshot<T>(db: StepRunsDb, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * 前提変更の再計算（#309: フォルダの最新 run の出力のタブについて）。完了済み（done / stale）の段階について、今の基準
 * （入力のタブの系譜の本文・前の段階の出力・参考・欄・設定・指示文）が記録した基準（最後に成功した attempt の input_basis_v2）と
 * 違えば、その段階から後の done を stale にし、戻れば done に戻す。
 * 読むのは 1 つの snapshot、書くのは「読んだときから行が変わっていない（xmin が同じ）」ときだけ（並行する確定・作り直しを上書きしない）。
 * 戻り値は状態を変えたタブの数。
 */
export async function refreshStale(db: StepRunsDb, owner: OwnerId, parentId: string, recipe: StepRecipe): Promise<number> {
  assertOwner(owner);
  assertRecipe(recipe);
  if (!isPageId(parentId)) return 0;
  const read = await inReadSnapshot(db, (client) => readStaleSnapshot(client, owner, parentId, recipe));
  if (!read) return 0;

  let changed = 0;
  let upstreamFresh = true;
  for (const attempt of read.attempts) {
    const page = read.pages.get(attempt.page_id);
    const status = page?.step_status ?? null;
    if (!page || (status !== "done" && status !== "stale")) {
      // 済みでない段階の後ろは、前提が定まっていない
      upstreamFresh = false;
      continue;
    }
    const basis = read.current.get(attempt.page_id);
    const reasons = basis ? stepStaleReasons(parseStepBasis(read.recorded.get(attempt.page_id)), basis) : [];
    const fresh: boolean = !read.structuralMismatch && upstreamFresh && basis !== undefined && reasons.length === 0;
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

/** 画面に渡す理由（段階の index ごと）。成功 attempt の記録だけを、現在の入力と同一 snapshot で比較する。後ろの段階は前の理由も受け継ぐ。 */
export async function readStepStaleReasons(db: StepRunsDb, owner: OwnerId, parentId: string, recipe: StepRecipe): Promise<Record<number, StepStaleReason[]>> {
  assertOwner(owner);
  if (!isPageId(parentId)) return {};
  const read = await inReadSnapshot(db, (client) => readStaleSnapshot(client, owner, parentId, recipe));
  if (!read) return {};
  const reasons: Record<number, StepStaleReason[]> = {};
  let inherited: StepStaleReason[] = [];
  for (const attempt of read.attempts) {
    const basis = read.current.get(attempt.page_id);
    const own = basis ? stepStaleReasons(parseStepBasis(read.recorded.get(attempt.page_id)), basis) : [];
    inherited = [...new Set([...inherited, ...own])];
    reasons[attempt.step_index] = inherited;
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// 流れ（#309。「ページ」パネルの行: フォルダの役割ページとそのタブ・録音・使ったエンジン）

export type FlowTab = {
  id: string;
  kind: PageKind;
  title: string;
  tabName: string | null;
  tabPos: number;
  revision: number;
  stepStatus: StepStatus | null;
  madeFrom: MadeFrom | null;
};

export type FlowHolder = { id: string; title: string; role: PageRole | null; tabs: FlowTab[] };

export type FlowView = {
  folder: { id: string; title: string; recipe: string | null };
  /** フォルダ直下の入れ物（役割の有無を問わず。タブは入れ物の中の並び）。 */
  holders: FlowHolder[];
  /** フォルダの録音ごとに、文字起こしのタブがあるエンジン（#310。流れの「文字起こし 作成 ▾」で済みにする）。 */
  usedEngines: { recording: string; engine: string }[];
};

type FlowRow = { holder: string; holder_title: string; role: PageRole | null; id: string; kind: PageKind; title: string; tab_name: string | null; tab_pos: number | string; revision: number; step_status: StepStatus | null; made_from: MadeFrom | null };

/** フォルダ（本人の生きているフォルダ）の流れに要るもの。フォルダでなければ null。 */
export async function readFlow(db: Queryable, owner: OwnerId, folderId: string): Promise<FlowView | null> {
  assertOwner(owner);
  if (!isPageId(folderId)) return null;
  const folder = await db.query<{ id: string; title: string; recipe: string | null }>(
    "SELECT id, title, recipe FROM pages WHERE owner = $1 AND id = $2 AND kind = 'folder' AND deleted_at IS NULL",
    [owner, folderId],
  );
  const folderRow = folder.rows[0];
  if (!folderRow) return null;
  const rows = await db.query<FlowRow>(
    `SELECT h.id AS holder, h.title AS holder_title, h.role, t.id, t.kind, t.title, t.tab_name, t.revision, t.step_status, t.made_from,
            (SELECT count(*) FROM pages o WHERE o.owner = t.owner AND o.page = t.page AND o.deleted_at IS NULL
               AND (o.sort_order, o.created_at, o.id) <= (t.sort_order, t.created_at, t.id)) AS tab_pos
       FROM pages h
       JOIN pages t ON t.owner = h.owner AND t.page = h.id AND t.deleted_at IS NULL
      WHERE h.owner = $1 AND h.parent = $2 AND h.kind = 'page' AND h.deleted_at IS NULL
      ORDER BY h.created_at, h.id, t.sort_order, t.created_at, t.id`,
    [owner, folderId],
  );
  const holders = new Map<string, FlowHolder>();
  for (const row of rows.rows) {
    const holder = holders.get(row.holder) ?? { id: row.holder, title: row.holder_title, role: row.role, tabs: [] };
    holder.tabs.push({ id: row.id, kind: row.kind, title: row.title, tabName: row.tab_name, tabPos: Number(row.tab_pos), revision: row.revision, stepStatus: row.step_status, madeFrom: row.made_from });
    holders.set(row.holder, holder);
  }
  // 済んだ（使った）エンジン: 文字起こしのタブ（#310。役割 transcript の入れ物のタブの made_from）
  const seen = new Set<string>();
  const engines: { recording: string; engine: string }[] = [];
  for (const holder of holders.values()) {
    if (holder.role?.kind !== "transcript") continue;
    for (const tab of holder.tabs) {
      const made = tab.madeFrom;
      if (!made || made.kind !== "transcript" || seen.has(`${made.recording}\n${made.engine}`)) continue;
      seen.add(`${made.recording}\n${made.engine}`);
      engines.push({ recording: made.recording, engine: made.engine });
    }
  }
  return { folder: { id: folderRow.id, title: folderRow.title, recipe: folderRow.recipe }, holders: [...holders.values()], usedEngines: engines };
}

// ---------------------------------------------------------------------------
// タブの居場所とフォルダの手順（#309。流れの API が、押されたタブのフォルダを決め、フォルダの手順を替えるのに使う）

export type TabLocation = {
  id: string;
  kind: PageKind;
  /** ページの名前（入れ物と全てのタブで同じ。#308）。 */
  title: string;
  /** 入れ物（`kind='page'`）。#307 より前のページには無い。 */
  holder: string | null;
  /** 入っているフォルダ（親がフォルダのときだけ）。 */
  folder: string | null;
};

/** 本人の生きている本文のページ（note / rec / article）の居場所。入れ物・フォルダは生きているものだけ。無ければ null。 */
export async function readTabLocation(db: Queryable, owner: OwnerId, tabId: string): Promise<TabLocation | null> {
  assertOwner(owner);
  if (!isPageId(tabId)) return null;
  const result = await db.query<{ id: string; kind: PageKind; title: string; holder: string | null; folder: string | null }>(
    `SELECT t.id, t.kind, t.title, h.id AS holder, f.id AS folder
       FROM pages t
       LEFT JOIN pages h ON h.owner = t.owner AND h.id = t.page AND h.kind = 'page' AND h.deleted_at IS NULL
       LEFT JOIN pages f ON f.owner = t.owner AND f.id = t.parent AND f.kind = 'folder' AND f.deleted_at IS NULL
      WHERE t.owner = $1 AND t.id = $2 AND t.deleted_at IS NULL AND t.kind IN ('note', 'rec', 'article')`,
    [owner, tabId],
  );
  const row = result.rows[0];
  return row ? { id: row.id, kind: row.kind, title: row.title, holder: row.holder, folder: row.folder } : null;
}

/** フォルダの手順を替える（1 フォルダに 1 つ。null で既定に戻す）。本人の生きているフォルダでなければ false。 */
export async function setFolderRecipe(db: Queryable, owner: OwnerId, folderId: string, recipe: string | null): Promise<boolean> {
  assertOwner(owner);
  if (!isPageId(folderId)) return false;
  if (recipe !== null && (typeof recipe !== "string" || recipe.length === 0 || recipe.length > 256)) throw new TypeError("editor-store: recipe must be a short id or null");
  const result = await db.query(
    "UPDATE pages SET recipe = $3, updated_at = GREATEST(clock_timestamp(), updated_at) WHERE owner = $1 AND id = $2 AND kind = 'folder' AND deleted_at IS NULL",
    [owner, folderId, recipe],
  );
  return (result.rowCount ?? 0) > 0;
}
