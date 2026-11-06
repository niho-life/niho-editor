/**
 * ブラウザから手順（#37）の受付 API を呼ぶ薄い関数（同じ origin。cookie・token は扱わない）。
 * 契約はサーバー側の src/server/steps-api.ts。実行の仕組み（Cloud Tasks の worker）はサーバーだけが持ち、
 * 画面は「始める」「状態を読む」「取消」「設計の写しを更新」の API を使う。
 *
 * - 状態は親（録音ページ）の id で読む（`GET /api/pages/{parent}/steps`）。サブページを開いているときも親で読む。
 * - 手順は設定（#108）で変えられるので、画面は静的な一覧を持たず、同じ答えに入っている `recipes` に従う。
 * - 読むたびにサーバーが前提変更を測り直す（`stepStatus` が `stale` になる）。画面は測らない。
 * - 短い間隔で回さない（./use-step-run.ts が間隔を空け、画面を閉じたら止める）。
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

/** `GET /api/pages/{id}/steps` の答え。 */
export type StepsState = { run: StepRun | null; recipes: StepRecipeChoice[] };

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
  const { index, id, name, state, pageId, stepStatus, tries, errorCode, staleReasons, hasPartialOutput, inputUsedChars } = value;
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
  };
}

function toRun(value: unknown): StepRun | null {
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

function toChoice(value: unknown): StepRecipeChoice | null {
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

/** 最新の run（無ければ null）と、その人の手順。読むたびにサーバーが前提変更を測り直す。 */
export async function getSteps(parentId: string, fetchImpl: FetchLike = fetch): Promise<StepsState> {
  const response = await fetchImpl(stepsPath(parentId), { method: "GET", credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw await failure(response);
  const data = await readJson(response);
  if (!isPlainObject(data) || !("run" in data) || !Array.isArray(data.recipes)) throw new StepsRequestError(500);
  const recipes = data.recipes.map(toChoice);
  if (recipes.some((recipe) => recipe === null)) throw new StepsRequestError(500);
  if (data.run === null) return { run: null, recipes: recipes as StepRecipeChoice[] };
  const run = toRun(data.run);
  if (!run) throw new StepsRequestError(500);
  return { run, recipes: recipes as StepRecipeChoice[] };
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

/** 手順を始める（`fromStep` を渡すとその段階からの作り直し）。202 は作った run、200 は同じ要求の再送。 */
export async function startStepRun(
  parentId: string,
  input: { recipe: string; fromStep?: number; idempotencyKey?: string },
  fetchImpl: FetchLike = fetch,
): Promise<StepRun> {
  const body: Record<string, unknown> = { recipe: input.recipe };
  if (input.fromStep !== undefined) body.fromStep = input.fromStep;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (input.idempotencyKey !== undefined) headers["idempotency-key"] = input.idempotencyKey;
  const response = await fetchImpl(stepsPath(parentId, "/runs"), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status !== 200 && response.status !== 202) throw await failure(response);
  const data = await readJson(response);
  const run = isPlainObject(data) ? toRun(data.run) : null;
  if (!run) throw new StepsRequestError(500);
  return run;
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
  const run = isPlainObject(data) ? toRun(data.run) : null;
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
  const run = isPlainObject(data) ? toRun(data.run) : null;
  if (!run) throw new StepsRequestError(500);
  return run;
}

/** 実行が終わったか（これ以上は変わらないので、状態を読むのをやめてよい）。 */
export function isStepRunDone(run: StepRun | null): boolean {
  return run !== null && run.state !== "queued" && run.state !== "running";
}
