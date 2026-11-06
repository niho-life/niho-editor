/**
 * ブラウザから手順（#37）の受付 API を呼ぶ薄い関数（同じ origin。cookie・token は扱わない）。
 * 契約はサーバー側の src/server/steps-api.ts。実行の仕組み（Cloud Tasks の worker）はサーバーだけが持ち、
 * 画面は「始める」「状態を読む」「取消」「設計の写しを更新」「区切りの続きからやり直す」の API を使う。
 *
 * - 状態はフォルダの id で読む（`GET /api/pages/{folder}/steps`。#309。始めるのは ./flow-client.ts の流れの API）。
 * - 手順は設定（#108）で変えられるので、画面は静的な一覧を持たず、同じ答えに入っている `recipes` に従う。
 * - 読むたびにサーバーが前提変更を測り直す（`stepStatus` が `stale` になる）。画面は測らない。
 * - 短い間隔で回さない（components/FlowWatcher.tsx が間隔を空け、画面を閉じたら止める）。
 */

import type { AttemptState, Block, RunState, StepStatus } from "@niho/editor-store";
import type { StepStaleReason } from "@niho/editor-store";

/** editor-store の RUN_STATES・ATTEMPT_STATES・STEP_STATUSES の写し（画面に pg を持ち込まないよう、値は import しない）。 */
const RUN_STATES = ["queued", "running", "succeeded", "failed", "canceled"] as const satisfies readonly RunState[];
const ATTEMPT_STATES = ["pending", "queued", "running", "succeeded", "failed", "canceled", "reused"] as const satisfies readonly AttemptState[];
const STEP_STATUSES = ["done", "run", "wait", "stale", "failed"] as const satisfies readonly StepStatus[];

export type StepRunState = (typeof RUN_STATES)[number];
export type StepAttemptState = (typeof ATTEMPT_STATES)[number];
export type StepPageStatus = (typeof STEP_STATUSES)[number];

/** 帯に出す 1 つの段階（サーバーの RunView.steps と同じ形）。 */
export type StepRunStep = {
  index: number;
  id: string;
  name: string;
  state: StepAttemptState;
  pageId: string;
  /** サブページの段階の状態（サブページが削除されていれば null）。前提変更はここに出る。 */
  stepStatus: StepPageStatus | null;
  staleReasons?: StepStaleReason[];
  tries: number;
  errorCode: string | null;
  hasPartialOutput?: boolean;
  /** 資料を上限で切ったときだけ、実際に使った字数（code point。#277）。無ければ切っていない（古い run も無い）。 */
  inputUsedChars?: number;
  /** 区切って処理している段階の進み（`index` は終えた区切りの数。待ち・実行中・失敗のときだけ。#277）。 */
  chunk?: { index: number; count: number };
};

export type StepRun = {
  id: string;
  recipe: string;
  recipeName?: string;
  /** 文書ガイドがある（AI の欄の「読むもの」に札を出す）。古い応答には無い。 */
  hasGuide?: boolean;
  recipeRevision?: number;
  currentRevision?: number | null;
  designChanges?: string[];
  state: StepRunState;
  fromStep: number;
  steps: StepRunStep[];
};

/**
 * その人の手順（サーバーの `RecipeChoiceView`）。`defaultName` は既定の手順の元の名前（既定でなければ null）。
 * 帯の名前と、録音ページの入口に出すものをこれで決める。
 */
export type StepRecipeChoice = { id: string; name: string; defaultName: string | null; unusableReason?: string | null };

/** API の失敗。`error` はサーバーの短い code（`steps_unavailable`・`run_in_progress`・`invalid_from_step` など）。 */
export class StepsRequestError extends Error {
  override readonly name = "StepsRequestError";
  constructor(
    readonly status: number,
    readonly error: string | null = null,
  ) {
    super(`steps request failed with ${status}${error ? ` (${error})` : ""}`);
  }
}

type FetchLike = typeof fetch;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function failure(response: Response): Promise<StepsRequestError> {
  const body = await readJson(response);
  const error = isPlainObject(body) && typeof body.error === "string" ? body.error : null;
  return new StepsRequestError(response.status, error);
}

function toStep(value: unknown): StepRunStep | null {
  if (!isPlainObject(value)) return null;
  const { index, id, name, state, pageId, stepStatus, tries, errorCode, staleReasons, hasPartialOutput, inputUsedChars, chunk } = value;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return null;
  if (typeof id !== "string" || typeof name !== "string" || typeof pageId !== "string") return null;
  if (typeof state !== "string" || !(ATTEMPT_STATES as readonly string[]).includes(state)) return null;
  if (stepStatus !== null && (typeof stepStatus !== "string" || !(STEP_STATUSES as readonly string[]).includes(stepStatus))) return null;
  if (typeof tries !== "number" || !Number.isInteger(tries) || tries < 0) return null;
  if (errorCode !== null && typeof errorCode !== "string") return null;
  if (hasPartialOutput !== undefined && typeof hasPartialOutput !== "boolean") return null;
  const reasons = ["source", "artifact", "refs", "info", "guide", "step"];
  if (staleReasons !== undefined && (!Array.isArray(staleReasons) || !staleReasons.every((item) => typeof item === "string" && reasons.includes(item)))) return null;
  return {
    index,
    id,
    name,
    state: state as StepAttemptState,
    pageId,
    stepStatus: stepStatus as StepPageStatus | null,
    staleReasons: staleReasons as StepStaleReason[] | undefined,
    tries,
    errorCode,
    ...(hasPartialOutput === true ? { hasPartialOutput: true } : {}),
    // 形の合わない値は捨てる（帯の一言が出ないだけで、段階そのものは読める）
    ...(typeof inputUsedChars === "number" && Number.isInteger(inputUsedChars) && inputUsedChars >= 0 ? { inputUsedChars } : {}),
    ...(toChunk(chunk) ?? {}),
  };
}

/** 区切りの進み（形の合わない値は捨てる。帯に分数が出ないだけ）。 */
function toChunk(value: unknown): { chunk: { index: number; count: number } } | null {
  if (!isPlainObject(value)) return null;
  const { index, count } = value;
  if (typeof index !== "number" || typeof count !== "number" || !Number.isInteger(index) || !Number.isInteger(count)) return null;
  if (index < 0 || count < 1 || index >= count) return null;
  return { chunk: { index, count } };
}

/** サーバーの RunView を読む（形の合わない値は null）。流れの応答（./flow-client.ts）も同じ形の run を持つ。 */
export function parseStepRun(value: unknown): StepRun | null {
  if (!isPlainObject(value)) return null;
  const { id, recipe, recipeName, hasGuide, recipeRevision, currentRevision, designChanges, state, fromStep, steps } = value;
  if (typeof id !== "string" || typeof recipe !== "string") return null;
  if (typeof state !== "string" || !(RUN_STATES as readonly string[]).includes(state)) return null;
  if (typeof fromStep !== "number" || !Number.isInteger(fromStep) || fromStep < 0) return null;
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const parsed = steps.map(toStep);
  if (parsed.some((step) => step === null)) return null;
  if (recipeName !== undefined && typeof recipeName !== "string") return null;
  if (hasGuide !== undefined && typeof hasGuide !== "boolean") return null;
  if (recipeRevision !== undefined && (!Number.isInteger(recipeRevision) || (recipeRevision as number) < 1)) return null;
  if (currentRevision !== undefined && currentRevision !== null && (!Number.isInteger(currentRevision) || (currentRevision as number) < 1)) return null;
  if (designChanges !== undefined && (!Array.isArray(designChanges) || !designChanges.every((change) => typeof change === "string"))) return null;
  return { id, recipe, recipeName: recipeName as string | undefined, ...(hasGuide === undefined ? {} : { hasGuide }), recipeRevision: recipeRevision as number | undefined, currentRevision: currentRevision as number | null | undefined, designChanges: designChanges as string[] | undefined, state: state as StepRunState, fromStep, steps: parsed as StepRunStep[] };
}

/** サーバーの RecipeChoiceView を読む（形の合わない値は null）。 */
export function parseRecipeChoice(value: unknown): StepRecipeChoice | null {
  if (!isPlainObject(value)) return null;
  const { id, name, defaultName, unusableReason } = value;
  if (typeof id !== "string" || id === "" || typeof name !== "string") return null;
  if (defaultName !== null && typeof defaultName !== "string") return null;
  if (unusableReason !== undefined && unusableReason !== null && typeof unusableReason !== "string") return null;
  return { id, name, defaultName, ...(unusableReason === undefined ? {} : { unusableReason: unusableReason as string | null }) };
}

function stepsPath(parentId: string, rest = ""): string {
  return `/api/pages/${encodeURIComponent(parentId)}/steps${rest}`;
}

/** 開示を利用者が選んだときだけ、失敗した最新段階の途中出力を取得する。 */
export async function getStepPartialOutput(
  parentId: string,
  runId: string,
  stepIndex: number,
  fetchImpl: FetchLike = fetch,
): Promise<Block[]> {
  const path = "/runs/" + encodeURIComponent(runId) + "/steps/" + stepIndex + "/partial";
  const response = await fetchImpl(stepsPath(parentId, path), {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw await failure(response);
  const data = await readJson(response);
  if (!isPlainObject(data) || !Array.isArray(data.blocks)) throw new StepsRequestError(500);
  return data.blocks as Block[];
}

/** 取消（冪等）。 */
export async function cancelStepRun(parentId: string, runId: string, fetchImpl: FetchLike = fetch): Promise<StepRun> {
  const response = await fetchImpl(stepsPath(parentId, `/runs/${encodeURIComponent(runId)}/cancel`), {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw await failure(response);
  const data = await readJson(response);
  const run = isPlainObject(data) ? parseStepRun(data.run) : null;
  if (!run) throw new StepsRequestError(500);
  return run;
}

/** 失敗した run を、失敗した区切りからやり直す（#277。202 は queued に戻した run）。 */
export async function resumeStepRun(parentId: string, runId: string, fetchImpl: FetchLike = fetch): Promise<StepRun> {
  const response = await fetchImpl(stepsPath(parentId, `/runs/${encodeURIComponent(runId)}/resume`), {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status !== 202) throw await failure(response);
  const data = await readJson(response);
  const run = isPlainObject(data) ? parseStepRun(data.run) : null;
  if (!run) throw new StepsRequestError(500);
  return run;
}

export async function updateStepRunRecipe(parentId: string, runId: string, expectedRevision: number, fetchImpl: FetchLike = fetch): Promise<StepRun> {
  const response = await fetchImpl(stepsPath(parentId, `/runs/${encodeURIComponent(runId)}/update-recipe`), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision }),
    credentials: "same-origin", cache: "no-store",
  });
  if (!response.ok) throw await failure(response);
  const data = await readJson(response);
  const run = isPlainObject(data) ? parseStepRun(data.run) : null;
  if (!run) throw new StepsRequestError(500);
  return run;
}

/** 実行が終わったか（これ以上は変わらないので、状態を読むのをやめてよい）。 */
export function isStepRunDone(run: StepRun | null): boolean {
  return run !== null && run.state !== "queued" && run.state !== "running";
}
