import { isIdempotencyKey, isPageId, type AttemptState, type Block, type RunState, type StepRunView, type StepStatus, type StepStaleReason } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { validateBlocks } from "../ast/blocks";
import { resolveStepsMode } from "../steps/inline";
import { taskName, type TaskQueue } from "../steps/queue";
import { DEFAULT_RECIPES, findRecipeIn, isRecipeKey, type RecipeDef, type RecipeReader } from "../steps/recipes";
import { validateRecipeDefinition } from "../steps/recipe-validation";
import type { StepRunStore } from "../steps/store";
import { errorResponse, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";

/** `/api/pages/{id}/steps/**` が使うもの。route から渡す（テストでは差し替える）。 */
export type StepsApiDeps = {
  auth: () => AuthProvider;
  /** DB が使えないときは null（503）。 */
  steps: () => StepRunStore | null;
  /** その人の手順（設定で変えたものを既定にかぶせたもの。#108）。DB が使えないときは null（503）。 */
  recipes: () => RecipeReader | null;
  /** 実行の方式（`EDITOR_STEPS_MODE`）に応じたキュー。使えないときは null（run の作成は 503 `steps_unavailable`）。 */
  queue: () => TaskQueue | null;
  env?: Readonly<Record<string, string | undefined>>;
};

/** 帯に出す run（段階の名前は手順の定義から）。 */
export type RunView = {
  id: string;
  recipe: string;
  recipeName: string;
  recipeRevision: number;
  currentRevision: number | null;
  designChanges: string[];
  state: RunState;
  fromStep: number;
  steps: {
    index: number;
    id: string;
    name: string;
    state: AttemptState;
    pageId: string;
    stepStatus: StepStatus | null;
    staleReasons: StepStaleReason[];
    tries: number;
    errorCode: string | null;
    hasPartialOutput?: boolean;
  }[];
};

/** http.ts の code に無いもの（http.ts は変えず、共通の header はそのまま使う）。 */
type StepsErrorCode = "steps_unavailable" | "run_in_progress" | "invalid_from_step" | "recipe_changed" | "recipe_unusable";
const STEPS_ERROR_STATUS: Record<StepsErrorCode, number> = { steps_unavailable: 503, run_in_progress: 409, invalid_from_step: 400, recipe_changed: 409, recipe_unusable: 409 };

function stepsError(code: StepsErrorCode): Response {
  return jsonResponse(STEPS_ERROR_STATUS[code], { error: code });
}

/**
 * 想定外の失敗は 500 の汎用エラー（内部の情報は応答に出さず、ログにも名前と code だけを書く）。
 * pages-api.ts の guarded と同じ（他の PR と並行して触らないよう、ここに置いている）。
 */
async function guarded(route: string, handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
    console.error("editor-web: request failed", { route, name, code });
    return errorResponse("internal");
  }
}

function designChanges(run: StepRunView, current: RecipeDef | undefined): string[] {
  if (!current || current.revision === run.recipeRevision) return [];
  const before = run.recipeSnapshot;
  const changes: string[] = [];
  if (before.name !== current.name) changes.push("手順の名前");
  if (before.guide !== current.guide) changes.push("文書ガイド");
  if (JSON.stringify(before.samples) !== JSON.stringify(current.samples)) changes.push("お手本");
  if (JSON.stringify(before.terms) !== JSON.stringify(current.terms)) changes.push("固有名詞");
  const oldIds = before.steps.map((step) => step.id);
  const newIds = current.steps.map((step) => step.id);
  for (const step of current.steps) {
    const old = before.steps.find((item) => item.id === step.id);
    if (!old) changes.push(`追加: ${step.name}`);
    else {
      if (old.name !== step.name) changes.push(`名前: ${old.name} → ${step.name}`);
      if (old.instruction !== step.instruction) changes.push(`指示: ${step.name}`);
      if (old.profile !== step.profile) changes.push(`プロファイル: ${step.name}`);
    }
  }
  for (const step of before.steps) if (!newIds.includes(step.id)) changes.push(`削除: ${step.name}`);
  if (oldIds.filter((id) => newIds.includes(id)).join("\n") !== newIds.filter((id) => oldIds.includes(id)).join("\n")) changes.push("段階の並び");
  return changes.length > 0 ? changes : ["その他の設定"];
}

function toRunView(run: StepRunView, recipes: readonly RecipeDef[], reasons: Record<number, StepStaleReason[]> = {}): RunView {
  const recipe = findRecipeIn(recipes, run.recipe);
  return {
    id: run.id,
    recipe: run.recipe,
    recipeName: run.recipeSnapshot.name,
    recipeRevision: run.recipeRevision,
    currentRevision: recipe?.revision ?? null,
    designChanges: designChanges(run, recipe),
    state: run.state,
    fromStep: run.fromStep,
    steps: run.steps.map((step) => ({
      index: step.index,
      id: step.stepId,
      name: run.recipeSnapshot.steps.find((recipeStep) => recipeStep.id === step.stepId)?.name ?? step.stepId,
      state: step.state,
      pageId: step.pageId,
      stepStatus: step.stepStatus,
      staleReasons: step.stepStatus === "stale" ? reasons[step.index] ?? [] : [],
      tries: step.tries,
      errorCode: step.errorCode,
      ...(step.hasPartialOutput ? { hasPartialOutput: true } : {}),
    })),
  };
}

/**
 * 「この録音から」の入口に出す手順（#37）。手順は設定（#108）で変えられるので、画面は静的な一覧を持たず
 * この答えに従う。`defaultName` は既定の手順の元の名前（既定でなければ null。画面はこれで、既定の言い方
 * 「記事にする」を使うか、付けられた名前を使うかを決める）。
 */
export type RecipeChoiceView = { id: string; name: string; defaultName: string | null; unusableReason: string | null };

function toChoices(recipes: readonly RecipeDef[]): RecipeChoiceView[] {
  return recipes.map((recipe) => ({
    id: recipe.id,
    name: recipe.name,
    defaultName: findRecipeIn(DEFAULT_RECIPES, recipe.id)?.name ?? null,
    unusableReason: validateRecipeDefinition(recipe, recipes).unusableReason,
  }));
}

type RunInput = { ok: true; recipe: RecipeDef; fromStep: number } | { ok: false; unusable?: boolean };

/** `{ recipe, fromStep? }` だけを受ける（他の key・知らない手順・範囲外の段階は 400）。 */
function parseRunInput(body: unknown, recipes: readonly RecipeDef[]): RunInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false };
  const record = body as Record<string, unknown>;
  if (!Object.keys(record).every((key) => key === "recipe" || key === "fromStep")) return { ok: false };
  if (!isRecipeKey(record.recipe)) return { ok: false };
  const recipe = findRecipeIn(recipes, record.recipe);
  if (!recipe) return { ok: false };
  if (validateRecipeDefinition(recipe, recipes).unusableReason !== null) return { ok: false, unusable: true };
  const fromStep = record.fromStep ?? 0;
  if (typeof fromStep !== "number" || !Number.isInteger(fromStep) || fromStep < 0) return { ok: false };
  return { ok: true, recipe, fromStep };
}

/**
 * GET /api/pages/{id}/steps — そのページの最新の run（無ければ null）と、その人の手順の一覧（帯の名前と、
 * 録音ページの入口に出すもの）。返す前に前提変更を再計算する。
 */
export function getSteps(request: Request, id: string, deps: StepsApiDeps): Promise<Response> {
  return guarded("GET /api/pages/[id]/steps", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const steps = deps.steps();
    const readRecipes = deps.recipes();
    if (!steps || !readRecipes) return errorResponse("unavailable");
    const listed = await steps.listRun(session.userId, id);
    if (!listed) return notFoundResponse();
    let run = listed.run;
    const recipes = await readRecipes(session.userId);
    if (run && (await steps.refreshStale(session.userId, id, run.recipeSnapshot)) > 0) {
      run = (await steps.listRun(session.userId, id))?.run ?? null;
    }
    const reasons = run ? await steps.readStaleReasons?.(session.userId, id, run.recipeSnapshot) : undefined;
    return jsonResponse(200, { run: run ? toRunView(run, recipes, reasons) : null, recipes: toChoices(recipes) });
  });
}

/** GET /api/pages/{id}/steps/runs/{runId}/steps/{stepIndex}/partial — 利用者が開いたときだけ失敗の途中出力を返す。 */
export function getStepPartialOutput(
  request: Request,
  id: string,
  runId: string,
  stepIndexText: string,
  deps: StepsApiDeps,
): Promise<Response> {
  return guarded("GET /api/pages/[id]/steps/runs/[runId]/steps/[stepIndex]/partial", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const stepIndex = /^(0|[1-9]\d*)$/.test(stepIndexText) ? Number(stepIndexText) : Number.NaN;
    if (!isPageId(id) || !isPageId(runId) || !Number.isSafeInteger(stepIndex)) return notFoundResponse();
    const steps = deps.steps();
    if (!steps) return errorResponse("unavailable");
    const partial = await steps.readPartialOutput(session.userId, id, runId, stepIndex);
    if (!partial) return notFoundResponse();
    const checked = validateBlocks(partial as Block[]);
    if (!checked.ok || checked.blocks.length === 0) return errorResponse("internal");
    return jsonResponse(200, { blocks: checked.blocks });
  });
}

/** POST /api/pages/{id}/steps/runs — 録音ページで手順を始める（`fromStep` からの作り直しを含む）。 */
export function createStepRun(request: Request, id: string, deps: StepsApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/steps/runs", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const steps = deps.steps();
    const readRecipes = deps.recipes();
    if (!steps || !readRecipes) return errorResponse("unavailable");
    // 本文の検査は id の有無より先（どの id でも同じ順に判定し、存在を漏らさない）
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const recipes = await readRecipes(session.userId);
    const input = parseRunInput(body.value, recipes);
    if (!input.ok) return input.unusable ? stepsError("recipe_unusable") : errorResponse("bad_request");
    const key = request.headers.get("idempotency-key");
    if (key !== null && !isIdempotencyKey(key)) return errorResponse("bad_request");
    if (!resolveStepsMode(deps.env ?? process.env)) return stepsError("steps_unavailable");
    const queue = deps.queue();
    if (!queue) return stepsError("steps_unavailable");

    // owner は認証の層の本人だけ（要求の値からは決めない）
    const owner = session.userId;
    const result = await steps.createRun(owner, id, { recipe: input.recipe, fromStep: input.fromStep, idempotencyKey: key });
    switch (result.status) {
      case "not_found":
        return notFoundResponse();
      case "run_in_progress":
      case "invalid_from_step":
      case "recipe_changed":
        return stepsError(result.status);
      case "existing":
        // 同じ要求の再送。積むのは最初の要求だけ
        return jsonResponse(202, { run: toRunView(result.run, recipes) });
      case "created":
        break;
    }
    const { run } = result;
    try {
      await queue.enqueue({ name: taskName(run.id, run.fromStep, 0), runId: run.id, stepIndex: run.fromStep });
    } catch (error) {
      // 積めなかった run を進行中のまま残さない（同じ録音ページで次の run を作れるように）
      await steps.cancelRun(owner, id, run.id);
      throw error;
    }
    return jsonResponse(202, { run: toRunView(run, recipes) });
  });
}

/** POST /api/pages/{id}/steps/runs/{runId}/cancel — 取消（冪等）。 */
export function cancelStepRun(request: Request, id: string, runId: string, deps: StepsApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/steps/runs/[runId]/cancel", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const steps = deps.steps();
    const readRecipes = deps.recipes();
    if (!steps || !readRecipes) return errorResponse("unavailable");
    const run = await steps.cancelRun(session.userId, id, runId);
    return run ? jsonResponse(200, { run: toRunView(run, await readRecipes(session.userId)) }) : notFoundResponse();
  });
}

/** POST /api/pages/{id}/steps/runs/{runId}/update-recipe — show a diff first, then opt in to the current design. */
export function updateStepRunRecipe(request: Request, id: string, runId: string, deps: StepsApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/steps/runs/[runId]/update-recipe", async () => {
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
    if (Object.keys(value).some((key) => key !== "expectedRevision") || !Number.isInteger(value.expectedRevision) || (value.expectedRevision as number) < 1) return errorResponse("bad_request");
    const listed = await steps.listRun(session.userId, id);
    if (!listed) return notFoundResponse();
    const run = listed.run;
    if (!run || run.id !== runId) return notFoundResponse();
    const recipes = await readRecipes(session.userId);
    const recipe = findRecipeIn(recipes, run.recipe);
    if (!recipe || recipe.revision === undefined) return stepsError("recipe_changed");
    const result = await steps.updateRunRecipeSnapshot(session.userId, id, runId, recipe, value.expectedRevision as number);
    if (result.status === "not_found") return notFoundResponse();
    if (result.status === "conflict") return stepsError("recipe_changed");
    await steps.refreshStale(session.userId, id, result.run.recipeSnapshot);
    const updated = (await steps.listRun(session.userId, id))?.run ?? result.run;
    return jsonResponse(200, { run: toRunView(updated, recipes) });
  });
}
