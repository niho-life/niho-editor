import {
  SETTINGS_LIMITS,
  RECIPE_LIMITS,
  isRecipeSample,
  isSettingsRecipe,
  isSettingsTerm,
  isSettingsText,
  settingsProblem,
  type EditorSettings,
  type EditorSettingsPatch,
  type OwnerId,
  type SettingsAiLang,
  type SettingsRecipe,
  type SettingsTerm,
  type RecipeSample,
} from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { DEFAULT_RECIPES, findRecipeIn, isDefaultRecipeId, isRecipeKey, type RecipeDef } from "../steps/recipes";
import { validateRecipeDefinition } from "../steps/recipe-validation";
import { errorResponse, guarded, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";

/**
 * アカウントの設定の API（Issue #108。`GET /api/settings`・`PATCH /api/settings`）。
 *
 * - 本人のものだけ。未認証は 401、DB が使えないときは 503。更新は同じ origin の画面からだけ（違えば 403）。
 * - 持つのは画面から変えられるものだけ（AI の提案の言語・固有名詞・手順）。文字起こしのエンジンはサーバーの設定、
 *   保存先は NIHO から毎回読むので、この API では変えられない（画面は読むだけ。設計 §2.1）。
 * - 手順は「効いている手順の全部」を送り受けする（実体は表 `recipes`。migration 20261101001500_recipes）。既定の値をそのまま送れば
 *   「既定に戻す」になる。既定でない手順を送らなければ、その手順は消える。
 * - 新しい画面は工程profile・固有名詞・お手本のメタデータも送る。古い画面がこれらを省略した場合は、今の値を維持する。
 * - 応答の本文に鍵・token は無い（この API はそういう値を持たない）。失敗は短い code だけを返す。
 */

export type SettingsStore = {
  get: (owner: OwnerId) => Promise<EditorSettings>;
  save: (owner: OwnerId, patch: EditorSettingsPatch) => Promise<EditorSettings>;
  /** その人の手順（表 `recipes`）。 */
  recipes: (owner: OwnerId) => Promise<RecipeDef[]>;
  /** その人の手順をすべて入れ替える（渡した順が並び）。 */
  saveRecipes: (owner: OwnerId, recipes: readonly RecipeDef[]) => Promise<RecipeDef[]>;
};

export type SettingsApiDeps = {
  auth: () => AuthProvider;
  /** DB が使えないときは null（503）。 */
  settings: () => SettingsStore | null;
  /** 手順・段階・お手本文を同じ owner の新しい手順として複製する。 */
  duplicateRecipe?: (owner: OwnerId, recipeId: string) => Promise<
    | { status: "created"; recipes: RecipeDef[] }
    | { status: "not_found" }
    | { status: "limit" }
    | { status: "samples_missing" }
    | { status: "unavailable" }
  >;
  env?: Readonly<Record<string, string | undefined>>;
};

/**
 * 画面に出す 1 つの手順。`isDefault` は既定の手順か、`modified` は既定に手を入れているか（戻せる）。
 * `defaults` は既定の手順の元の定義（既定でない手順は null）。「既定に戻す」は、この値で置き換えた一覧を送る
 * （既定の手順を一覧から外すのではない。PATCH は既定の 3 つが揃っていることを求める）。
 */
export type SettingsRecipeInput = {
  id: string;
  name: string;
  guide: string;
  steps: (SettingsRecipe["steps"][number] & { profile?: string })[];
  terms?: SettingsTerm[];
  samples?: RecipeSample[];
};

export type SettingsRecipeContent = {
  id: string;
  name: string;
  guide: string;
  steps: (SettingsRecipe["steps"][number] & { profile: string })[];
  terms: SettingsTerm[];
  samples: RecipeSample[];
};

export type SettingsRecipeDto = SettingsRecipeContent & {
  isDefault: boolean;
  modified: boolean;
  unusableReason: string | null;
  defaults: Omit<SettingsRecipeContent, "id"> | null;
};

export type SettingsPatchInput = Omit<EditorSettingsPatch, "recipes"> & { recipes?: SettingsRecipeInput[] };

export type SettingsDto = {
  aiLang: SettingsAiLang;
  glossary: SettingsTerm[];
  /** 効いている手順（既定の並び → 足したものの並び）。 */
  recipes: SettingsRecipeDto[];
  /** 「あなたについて」（AI に渡す本人の説明と書き方の希望）。 */
  aboutName: string;
  about: string;
  limits: typeof SETTINGS_LIMITS;
};

/** 設定の画面が送り受けする形。お手本の本文は別経路で取り込み、ここにはメタデータだけを出す。 */
function toSettingsRecipe(recipe: RecipeDef): SettingsRecipeContent {
  return {
    id: recipe.id,
    name: recipe.name,
    guide: recipe.guide,
    steps: recipe.steps.map((step) => ({ id: step.id, name: step.name, instruction: step.instruction, profile: step.profile })),
    terms: recipe.terms.map((term) => ({ ...term, variants: [...term.variants] })),
    samples: recipe.samples.map((sample) => ({ ...sample })),
  };
}

function sameRecipe(a: SettingsRecipeContent, b: SettingsRecipeContent): boolean {
  if (a.name !== b.name || a.guide !== b.guide || a.steps.length !== b.steps.length) return false;
  if (JSON.stringify(a.terms) !== JSON.stringify(b.terms) || JSON.stringify(a.samples) !== JSON.stringify(b.samples)) return false;
  return a.steps.every((step, index) => {
    const other = b.steps[index]!;
    return step.id === other.id && step.name === other.name && step.instruction === other.instruction && step.profile === other.profile;
  });
}

export function settingsDto(settings: EditorSettings, recipes: readonly RecipeDef[]): SettingsDto {
  const contents = recipes.map(toSettingsRecipe);
  return {
    aiLang: settings.aiLang,
    glossary: settings.glossary,
    aboutName: settings.aboutName,
    about: settings.about,
    recipes: contents.map((recipe) => {
      const base = findRecipeIn(DEFAULT_RECIPES, recipe.id);
      const defaults = base ? toSettingsRecipe(base) : null;
      return {
        ...recipe,
        isDefault: base !== undefined,
        modified: defaults !== null && !sameRecipe(recipe, defaults),
        unusableReason: validateRecipeDefinition(recipe, contents).unusableReason,
        defaults: defaults ? { name: defaults.name, guide: defaults.guide, steps: defaults.steps, terms: defaults.terms, samples: defaults.samples } : null,
      };
    }),
    limits: SETTINGS_LIMITS,
  };
}

/**
 * 古いpayloadが省略したprofile・terms・samplesは既存値を保つ。新しいpayloadでは各項目を更新する。
 */
export function mergeRecipes(current: readonly RecipeDef[], sent: readonly SettingsRecipeInput[]): RecipeDef[] {
  return sent.map((recipe) => {
    const existing = findRecipeIn(current, recipe.id) ?? findRecipeIn(DEFAULT_RECIPES, recipe.id);
    const priorSteps = new Map((existing?.steps ?? []).map((step) => [step.id, step] as const));
    return {
      id: recipe.id,
      revision: existing?.revision ?? 1,
      name: recipe.name,
      guide: recipe.guide,
      terms: recipe.terms === undefined
        ? (existing?.terms ?? []).map((term) => ({ ...term, variants: [...term.variants] }))
        : recipe.terms.map((term) => ({ ...term, variants: [...term.variants] })),
      samples: recipe.samples === undefined
        ? (existing?.samples ?? []).map((sample) => ({ ...sample }))
        : recipe.samples.map((sample) => ({ ...sample })),
      steps: recipe.steps.map((step) => {
        const prior = priorSteps.get(step.id);
        return {
          ...step,
          profile: step.profile ?? prior?.profile ?? "standard",
          ...(prior?.provider === undefined ? {} : { provider: prior.provider }),
        };
      }),
    };
  });
}

/** 手順は別の表なので、設定の列への patch（aiLang・glossary・あなたについて）と分けて持つ。 */
type PatchResult = { ok: true; value: EditorSettingsPatch; recipes?: SettingsRecipeInput[] } | { ok: false };

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recipeInputProblem(value: unknown): boolean {
  if (!plainObject(value) || Object.keys(value).some((key) => !["id", "name", "guide", "steps", "terms", "samples"].includes(key))) return true;
  if (!Array.isArray(value.steps)) return true;
  const legacy = {
    id: value.id,
    name: value.name,
    guide: value.guide,
    steps: value.steps.map((step) => plainObject(step) ? { id: step.id, name: step.name, instruction: step.instruction } : step),
  };
  if (!isSettingsRecipe(legacy)) return true;
  const steps = value.steps as unknown[];
  if (steps.some((step) => plainObject(step) && (Object.keys(step).some((key) => !["id", "name", "instruction", "profile"].includes(key)) ||
    (step.profile !== undefined && (!isSettingsText(step.profile, RECIPE_LIMITS.profileChars) || step.profile.trim() === ""))))) return true;
  if (value.terms !== undefined && (!Array.isArray(value.terms) || value.terms.length > RECIPE_LIMITS.terms || !value.terms.every(isSettingsTerm))) return true;
  if (value.samples !== undefined && (!Array.isArray(value.samples) || value.samples.length > RECIPE_LIMITS.samples || !value.samples.every(isRecipeSample))) return true;
  if (Array.isArray(value.samples) && new Set((value.samples as { id: string }[]).map((sample) => sample.id)).size !== value.samples.length) return true;
  return false;
}

/**
 * PATCH の本文（`{ aiLang?, glossary?, recipes? }` だけ）。手順は既定の 3 つの id を 1 回ずつ含み、
 * 段階の id は既定の手順ではそのままでなければならない（成果物のサブページがその id に結んでいる）。
 */
export function parseSettingsPatch(body: unknown): PatchResult {
  if (!plainObject(body) || Object.keys(body).some((key) => !["aiLang", "glossary", "recipes", "about", "aboutName"].includes(key))) return { ok: false };
  const { recipes: rawRecipes, ...settingsPatch } = body;
  if (rawRecipes === undefined) {
    if (settingsProblem(settingsPatch) !== null) return { ok: false };
    return { ok: true, value: settingsPatch as EditorSettingsPatch };
  }
  if (!Array.isArray(rawRecipes) || rawRecipes.length > SETTINGS_LIMITS.recipes || rawRecipes.some(recipeInputProblem)) return { ok: false };
  const sent = rawRecipes as SettingsRecipeInput[];
  if (settingsProblem({ ...settingsPatch, recipes: sent.map((recipe) => ({
    id: recipe.id, name: recipe.name, guide: recipe.guide,
    steps: recipe.steps.map(({ id, name, instruction }) => ({ id, name, instruction })),
  })) }) !== null) return { ok: false };
  if (settingsProblem(settingsPatch) !== null) return { ok: false };
  {
    const ids = sent.filter((recipe) => isDefaultRecipeId(recipe.id)).map((recipe) => recipe.id);
    if (ids.length !== DEFAULT_RECIPES.length) return { ok: false };
    for (const recipe of sent) {
      const base = findRecipeIn(DEFAULT_RECIPES, recipe.id);
      if (!base) continue;
      const stepIds = recipe.steps.map((step) => step.id);
      if (stepIds.length !== base.steps.length || new Set(stepIds).size !== stepIds.length || base.steps.some((step) => !stepIds.includes(step.id))) return { ok: false };
    }
  }
  return { ok: true, value: settingsPatch as EditorSettingsPatch, recipes: sent };
}

/** GET /api/settings — 今の設定（行が無い人も既定値で答える）。 */
export function getSettings(request: Request, deps: SettingsApiDeps): Promise<Response> {
  return guarded("GET /api/settings", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const store = deps.settings();
    if (!store) return errorResponse("unavailable");
    const [settings, recipes] = await Promise.all([store.get(session.userId), store.recipes(session.userId)]);
    return jsonResponse(200, { settings: settingsDto(settings, recipes) });
  });
}

/** PATCH /api/settings — 渡した項目だけを入れ替え、入れ替えた後の設定を返す。 */
export function patchSettings(request: Request, deps: SettingsApiDeps): Promise<Response> {
  return guarded("PATCH /api/settings", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.settings();
    if (!store) return errorResponse("unavailable");
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const patch = parseSettingsPatch(body.value);
    if (!patch.ok) return errorResponse("bad_request");
    // owner は認証の層の本人だけ（要求の値からは決めない）
    const owner = session.userId;
    const settings = await store.save(owner, patch.value);
    // 手順は別の表。送られてこなければ今のまま読む
    const recipes = patch.recipes ? await store.saveRecipes(owner, mergeRecipes(await store.recipes(owner), patch.recipes)) : await store.recipes(owner);
    return jsonResponse(200, { settings: settingsDto(settings, recipes) });
  });
}

/** POST /api/settings/recipes/{recipeId}/duplicate — お手本文も含めて owner 内で複製する。 */
export function duplicateSettingsRecipe(request: Request, recipeId: string, deps: SettingsApiDeps): Promise<Response> {
  return guarded("POST /api/settings/recipes/[recipeId]/duplicate", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    if (!isRecipeKey(recipeId)) return notFoundResponse();
    const store = deps.settings();
    if (!store || !deps.duplicateRecipe) return errorResponse("unavailable");
    const [settings, result] = await Promise.all([
      store.get(session.userId),
      deps.duplicateRecipe(session.userId, recipeId),
    ]);
    if (result.status === "not_found") return notFoundResponse();
    if (result.status === "limit") return jsonResponse(409, { error: "recipe_limit" });
    if (result.status === "samples_missing") return jsonResponse(409, { error: "sample_content_missing" });
    if (result.status === "unavailable") return errorResponse("unavailable");
    return jsonResponse(201, { settings: settingsDto(settings, result.recipes) });
  });
}
