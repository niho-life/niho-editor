/**
 * ブラウザから「流れ」（#309）の API を呼ぶ薄い関数（同じ origin。cookie・token は扱わない）。
 * 契約はサーバー側の src/server/flow-api.ts。状態は開いているタブの id で読む（`GET /api/pages/{tab}/flow`）。
 * 作成は `POST /api/pages/{tab}/flow/runs`、フォルダの手順は `PATCH /api/pages/{tab}/flow`。
 * run の取消・やり直し・途中出力は ./steps-client.ts（フォルダの id で）。
 */

import { StepsRequestError, parseRecipeChoice, parseStepRun, type StepPageStatus, type StepRecipeChoice, type StepRun } from "./steps-client";

export type FlowTabView = { id: string; kind: "note" | "rec" | "article"; label: string; status: StepPageStatus | null; running: boolean };

/** サーバーの FlowRowView と同じ形。 */
export type FlowRow = {
  kind: "rec" | "transcript" | "step";
  stepId?: string;
  stepIndex?: number;
  name: string;
  holder: { id: string; title: string } | null;
  tabs: FlowTabView[];
  current: boolean;
  from: string | null;
  action: "go" | "done" | null;
  engines?: { id: string; used: boolean }[];
};

export type FlowState = {
  tab: { id: string; kind: "note" | "rec" | "article"; holder: string | null; folder: { id: string; title: string } | null };
  recipe: { id: string; name: string; steps: { id: string; name: string }[] };
  recipes: StepRecipeChoice[];
  rows: FlowRow[];
  run: StepRun | null;
};

export type FlowRunInput = { inputTab: string; toStep: number } | { regenerate: string } | { sibling: string };

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
  return new StepsRequestError(response.status, isPlainObject(body) && typeof body.error === "string" ? body.error : null);
}

const TAB_KINDS = ["note", "rec", "article"] as const;
const STATUSES = ["done", "run", "wait", "stale", "failed"] as const;

function toTab(value: unknown): FlowTabView | null {
  if (!isPlainObject(value)) return null;
  const { id, kind, label, status, running } = value;
  if (typeof id !== "string" || typeof label !== "string" || typeof running !== "boolean") return null;
  if (typeof kind !== "string" || !(TAB_KINDS as readonly string[]).includes(kind)) return null;
  if (status !== null && (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status))) return null;
  return { id, kind: kind as FlowTabView["kind"], label, status: status as StepPageStatus | null, running };
}

function toRow(value: unknown): FlowRow | null {
  if (!isPlainObject(value)) return null;
  const { kind, stepId, stepIndex, name, holder, tabs, current, from, action, engines } = value;
  if (kind !== "rec" && kind !== "transcript" && kind !== "step") return null;
  if (typeof name !== "string" || typeof current !== "boolean") return null;
  if (from !== null && typeof from !== "string") return null;
  if (action !== null && action !== "go" && action !== "done") return null;
  if (holder !== null && (!isPlainObject(holder) || typeof holder.id !== "string" || typeof holder.title !== "string")) return null;
  if (!Array.isArray(tabs)) return null;
  const parsedTabs = tabs.map(toTab);
  if (parsedTabs.some((tab) => tab === null)) return null;
  if (stepId !== undefined && (typeof stepId !== "string" || typeof stepIndex !== "number" || !Number.isInteger(stepIndex) || stepIndex < 0)) return null;
  if (engines !== undefined && (!Array.isArray(engines) || !engines.every((engine) => isPlainObject(engine) && typeof engine.id === "string" && typeof engine.used === "boolean"))) return null;
  return {
    kind,
    ...(stepId === undefined ? {} : { stepId: stepId as string, stepIndex: stepIndex as number }),
    name,
    holder: holder as FlowRow["holder"],
    tabs: parsedTabs as FlowTabView[],
    current,
    from: from as string | null,
    action: action as FlowRow["action"],
    ...(engines === undefined ? {} : { engines: engines as FlowRow["engines"] }),
  };
}

function toState(data: unknown): FlowState | null {
  if (!isPlainObject(data) || !isPlainObject(data.tab) || !isPlainObject(data.recipe) || !Array.isArray(data.recipes) || !Array.isArray(data.rows) || !("run" in data)) return null;
  const { tab, recipe } = data;
  if (typeof tab.id !== "string" || typeof tab.kind !== "string" || !(TAB_KINDS as readonly string[]).includes(tab.kind)) return null;
  if (tab.holder !== null && typeof tab.holder !== "string") return null;
  if (tab.folder !== null && (!isPlainObject(tab.folder) || typeof tab.folder.id !== "string" || typeof tab.folder.title !== "string")) return null;
  if (typeof recipe.id !== "string" || typeof recipe.name !== "string" || !Array.isArray(recipe.steps)) return null;
  if (!recipe.steps.every((step) => isPlainObject(step) && typeof step.id === "string" && typeof step.name === "string")) return null;
  const recipes = data.recipes.map(parseRecipeChoice);
  const rows = data.rows.map(toRow);
  if (recipes.some((item) => item === null) || rows.some((row) => row === null)) return null;
  const run = data.run === null ? null : parseStepRun(data.run);
  if (data.run !== null && run === null) return null;
  return {
    tab: { id: tab.id, kind: tab.kind as FlowState["tab"]["kind"], holder: tab.holder as string | null, folder: tab.folder as FlowState["tab"]["folder"] },
    recipe: recipe as FlowState["recipe"],
    recipes: recipes as StepRecipeChoice[],
    rows: rows as FlowRow[],
    run,
  };
}

function flowPath(tabId: string, rest = ""): string {
  return `/api/pages/${encodeURIComponent(tabId)}/flow${rest}`;
}

/** 開いているタブの流れ（行・フォルダの手順・候補・最新の run）。読むたびにサーバーが前提変更を測り直す。 */
export async function getFlow(tabId: string, fetchImpl: FetchLike = fetch): Promise<FlowState> {
  const response = await fetchImpl(flowPath(tabId), { method: "GET", credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw await failure(response);
  const state = toState(await readJson(response));
  if (!state) throw new StepsRequestError(500);
  return state;
}

export type FlowRunResult = { run: StepRun; folder: string; opened: string | null };

/** 流れの「作成」（202 は作った run。`opened` は開くタブ）。フォルダの外のタブはサーバーがフォルダに入れる。 */
export async function startFlowRun(tabId: string, input: FlowRunInput, options: { idempotencyKey?: string } = {}, fetchImpl: FetchLike = fetch): Promise<FlowRunResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;
  const response = await fetchImpl(flowPath(tabId, "/runs"), { method: "POST", headers, body: JSON.stringify(input), credentials: "same-origin", cache: "no-store" });
  if (response.status !== 202) throw await failure(response);
  const data = await readJson(response);
  const run = isPlainObject(data) ? parseStepRun(data.run) : null;
  if (!run || !isPlainObject(data) || typeof data.folder !== "string" || (data.opened !== null && typeof data.opened !== "string")) throw new StepsRequestError(500);
  return { run, folder: data.folder, opened: data.opened as string | null };
}

/** フォルダの手順を替える（null で既定）。返すのは入れたフォルダの id（フォルダの外のタブはサーバーがフォルダに入れる）。 */
export async function setFlowRecipe(tabId: string, recipe: string | null, fetchImpl: FetchLike = fetch): Promise<string> {
  const response = await fetchImpl(flowPath(tabId), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ recipe }), credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw await failure(response);
  const data = await readJson(response);
  if (!isPlainObject(data) || typeof data.folder !== "string") throw new StepsRequestError(500);
  return data.folder;
}
