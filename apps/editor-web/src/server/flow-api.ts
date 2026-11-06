import { isIdempotencyKey, isPageId, type CreateRunInput, type TabLocation } from "@niho/editor-store";
import { resolveStepsMode } from "../steps/inline";
import { taskName } from "../steps/queue";
import { findRecipeIn, isRecipeKey, type RecipeDef } from "../steps/recipes";
import { validateRecipeDefinition } from "../steps/recipe-validation";
import type { StepRunStore } from "../steps/store";
import { flowRows, type FlowRowView } from "./flow-view";
import { errorResponse, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";
import { guarded, stepsError, toChoices, toRunView, type RecipeChoiceView, type RunView, type StepsApiDeps } from "./steps-api";

/** フォルダに手順が無いときの手順（既定の「記事」）。 */
export const DEFAULT_FLOW_RECIPE = "tpl-1";

/** `GET /api/pages/{id}/flow` の答え。 */
export type FlowResponse = {
  /** 開いているタブの居場所（フォルダの外なら folder は null）。 */
  tab: { id: string; kind: TabLocation["kind"]; holder: string | null; folder: { id: string; title: string } | null };
  /** このフォルダの手順（1 フォルダに 1 つ。無ければ既定）。 */
  recipe: { id: string; name: string; steps: { id: string; name: string }[] };
  /** その人の手順（▾ で替える候補）。 */
  recipes: RecipeChoiceView[];
  rows: FlowRowView[];
  /** フォルダの最新の run（無ければ null）。 */
  run: RunView | null;
};

type Located = { tab: TabLocation; folderId: string | null };

/** `id`（タブかフォルダ）と `tab`（フォルダのときのタブ）から、開いているタブとそのフォルダ。合わなければ null。 */
async function locate(steps: StepRunStore, owner: string, id: string, tabId: string | null): Promise<Located | null> {
  const tab = await steps.locateTab(owner, tabId ?? id);
  if (!tab) return null;
  // id はそのタブ自身か、タブの入っているフォルダ
  if (tab.id !== id && tab.folder !== id) return null;
  return { tab, folderId: tab.folder };
}

/** フォルダの手順（`pages.recipe`、無ければ既定）。その人の手順に無ければ既定、既定も無ければ最初のもの。 */
function recipeOfFolder(recipes: readonly RecipeDef[], recipeId: string | null): RecipeDef | undefined {
  return (recipeId ? findRecipeIn(recipes, recipeId) : undefined) ?? findRecipeIn(recipes, DEFAULT_FLOW_RECIPE) ?? recipes[0];
}

/**
 * GET /api/pages/{id}/flow[?tab=] — 「ページ」パネルの「流れ」。`id` は開いているタブ（または `tab` を添えたフォルダ）。
 * 行・フォルダの手順・候補・最新の run（返す前に前提変更を再計算する）。
 */
export function getFlow(request: Request, id: string, deps: StepsApiDeps): Promise<Response> {
  return guarded("GET /api/pages/[id]/flow", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const tabParam = new URL(request.url).searchParams.get("tab");
    if (tabParam !== null && !isPageId(tabParam)) return errorResponse("bad_request");
    const steps = deps.steps();
    const readRecipes = deps.recipes();
    if (!steps || !readRecipes) return errorResponse("unavailable");
    const owner = session.userId;
    const located = await locate(steps, owner, id, tabParam);
    if (!located) return notFoundResponse();
    const recipes = await readRecipes(owner);
    const flow = located.folderId ? await steps.readFlow(owner, located.folderId) : null;
    const recipe = recipeOfFolder(recipes, flow?.folder.recipe ?? null);
    if (!recipe) return errorResponse("unavailable");
    let run = flow ? ((await steps.listRun(owner, flow.folder.id))?.run ?? null) : null;
    if (flow && run && (await steps.refreshStale(owner, flow.folder.id, run.recipeSnapshot)) > 0) {
      run = (await steps.listRun(owner, flow.folder.id))?.run ?? null;
    }
    const reasons = flow && run ? await steps.readStaleReasons?.(owner, flow.folder.id, run.recipeSnapshot) : undefined;
    const runView = run ? toRunView(run, recipes, reasons) : null;
    const body: FlowResponse = {
      tab: { id: located.tab.id, kind: located.tab.kind, holder: located.tab.holder, folder: flow ? { id: flow.folder.id, title: flow.folder.title } : null },
      recipe: { id: recipe.id, name: recipe.name, steps: recipe.steps.map((step) => ({ id: step.id, name: step.name })) },
      recipes: toChoices(recipes),
      rows: flowRows({ tab: located.tab, flow, recipe, run: runView, engines: deps.engines?.() ?? [] }),
      run: runView,
    };
    return jsonResponse(200, body);
  });
}

type FlowRunBody = { inputTab: string; toStep: number } | { regenerate: string } | { sibling: string };

/** `{ inputTab, toStep }`・`{ regenerate }`・`{ sibling }` のどれか 1 つだけ（他の鍵・形の悪い id・範囲外の段階は 400）。 */
function parseFlowRunBody(body: unknown): FlowRunBody | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") === "inputTab,toStep") {
    const { inputTab, toStep } = record;
    if (typeof inputTab !== "string" || !isPageId(inputTab)) return null;
    if (typeof toStep !== "number" || !Number.isInteger(toStep) || toStep < 0) return null;
    return { inputTab, toStep };
  }
  if (keys.join(",") === "regenerate" && typeof record.regenerate === "string" && isPageId(record.regenerate)) return { regenerate: record.regenerate };
  if (keys.join(",") === "sibling" && typeof record.sibling === "string" && isPageId(record.sibling)) return { sibling: record.sibling };
  return null;
}

/**
 * POST /api/pages/{id}/flow/runs — 流れの「作成」。`id` は押されたタブ（またはそのフォルダ）。本文は
 * `{ inputTab, toStep }`（そのタブを入力に段階 toStep まで）・`{ regenerate }`（同じ入力で同じタブへ）・`{ sibling }`（同じ入力でもう 1 つ）。
 * フォルダの外のタブなら、その入れ物の題名でフォルダを作って入れてから始める（#309）。手順はフォルダのもの（無ければ既定）。
 * 202 は作った run（`opened` は最後の段階の出力のタブ。画面はそれを開く）。同じ Idempotency-Key の再送も 202。
 */
export function createFlowRun(request: Request, id: string, deps: StepsApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/flow/runs", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const steps = deps.steps();
    const readRecipes = deps.recipes();
    if (!steps || !readRecipes) return errorResponse("unavailable");
    // 本文の検査は id の有無より先（どの id でも同じ順に判定し、存在を漏らさない）
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const input = parseFlowRunBody(body.value);
    if (!input) return errorResponse("bad_request");
    const key = request.headers.get("idempotency-key");
    if (key !== null && !isIdempotencyKey(key)) return errorResponse("bad_request");
    if (!resolveStepsMode(deps.env ?? process.env)) return stepsError("steps_unavailable");
    const queue = deps.queue();
    if (!queue) return stepsError("steps_unavailable");

    // owner は認証の層の本人だけ（要求の値からは決めない）
    const owner = session.userId;
    const target = "inputTab" in input ? input.inputTab : "regenerate" in input ? input.regenerate : input.sibling;
    const located = await locate(steps, owner, id, target);
    if (!located) return notFoundResponse();
    let folderId = located.folderId;
    if (folderId === null) {
      // 作り直す・もう 1 つは段階の出力（いつもフォルダの中）だけ
      if (!("inputTab" in input) || located.tab.holder === null) return stepsError("invalid_from_step");
      folderId = await steps.wrapInFolder(owner, located.tab.holder);
      if (folderId === null) return notFoundResponse();
    }
    const recipes = await readRecipes(owner);
    const flow = await steps.readFlow(owner, folderId);
    // 作り直す・もう 1 つは、そのタブの入れ物の役割の手順で（フォルダの手順を替えたあとでも、そのタブは元の手順の段階）
    const role = flow?.holders.find((holder) => holder.tabs.some((tab) => tab.id === located.tab.id))?.role ?? null;
    const recipeId = "inputTab" in input ? flow?.folder.recipe ?? null : role?.kind === "step" ? role.recipe : flow?.folder.recipe ?? null;
    const recipe = recipeOfFolder(recipes, recipeId);
    if (!recipe || validateRecipeDefinition(recipe, recipes).unusableReason !== null) return stepsError("recipe_unusable");
    const runInput: CreateRunInput = { recipe, ...(key === null ? {} : { idempotencyKey: key }), ...input };
    const result = await steps.createRun(owner, folderId, runInput);
    switch (result.status) {
      case "not_found":
        return notFoundResponse();
      case "run_in_progress":
      case "invalid_from_step":
      case "recipe_changed":
        return stepsError(result.status);
      case "existing":
        // 同じ要求の再送。積むのは最初の要求だけ
        return jsonResponse(202, { run: toRunView(result.run, recipes), folder: folderId, opened: result.run.steps.at(-1)?.pageId ?? null });
      case "created":
        break;
    }
    const { run } = result;
    try {
      await queue.enqueue({ name: taskName(run.id, run.fromStep, 0), runId: run.id, stepIndex: run.fromStep });
    } catch (error) {
      // 積めなかった run を進行中のまま残さない（同じフォルダで次の run を作れるように）
      await steps.cancelRun(owner, folderId, run.id);
      throw error;
    }
    return jsonResponse(202, { run: toRunView(run, recipes), folder: folderId, opened: run.steps.at(-1)?.pageId ?? null });
  });
}

/**
 * PATCH /api/pages/{id}/flow — フォルダの手順を替える（`{ recipe }`。null で既定）。`id` は開いているタブかフォルダ。
 * フォルダの外のタブなら、まず入れ物をフォルダに入れる。知らない手順は 400。
 */
export function patchFlow(request: Request, id: string, deps: StepsApiDeps): Promise<Response> {
  return guarded("PATCH /api/pages/[id]/flow", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const steps = deps.steps();
    const readRecipes = deps.recipes();
    if (!steps || !readRecipes) return errorResponse("unavailable");
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    if (typeof body.value !== "object" || body.value === null || Array.isArray(body.value)) return errorResponse("bad_request");
    const value = body.value as Record<string, unknown>;
    if (Object.keys(value).join(",") !== "recipe" || (value.recipe !== null && !isRecipeKey(value.recipe))) return errorResponse("bad_request");
    const owner = session.userId;
    const recipes = await readRecipes(owner);
    if (value.recipe !== null && !findRecipeIn(recipes, value.recipe as string)) return errorResponse("bad_request");
    const located = await locate(steps, owner, id, null);
    if (!located) return notFoundResponse();
    let folderId = located.folderId;
    if (folderId === null) {
      if (located.tab.holder === null) return notFoundResponse();
      folderId = await steps.wrapInFolder(owner, located.tab.holder);
      if (folderId === null) return notFoundResponse();
    }
    if (!(await steps.setFolderRecipe(owner, folderId, value.recipe as string | null))) return notFoundResponse();
    return jsonResponse(200, { folder: folderId, recipe: value.recipe });
  });
}
