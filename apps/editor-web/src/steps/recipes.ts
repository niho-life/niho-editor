import { FLOW_TEMPLATES, STANDARD_PROFILE_ID } from "@niho/docs-core";
import { SETTINGS_ID_PATTERN, type RecipeInput, type RecipeSample, type SettingsRecipe, type SettingsTerm, type StoredRecipe } from "@niho/editor-store";

/**
 * 手順の定義（設計 §7.2）。docs-core のテンプレート（指示文の正）から、既定の 4 つ（記事制作・議事録・
 * インサイト整理・コーチング）を写す。**旧 NIHO docs のテンプレートは 4 つで、editor も 4 つ**（オーナー
 * 「旧版の機能は全部必要」2026-11-01。設計 docs/architecture/editor-steps-recipes.md §1.5）。
 * テンプレートが無ければ読み込んだ時点で落とす（起動・build で気づく）。
 *
 * **既定の手順を増やすのはこの `DEFAULT_RECIPE_IDS` に 1 つ足すだけ**（docs-core にテンプレートがあれば中身はそこから来る）。
 * もう表に行がある人にも、次の読み出しで足りない既定だけが入る（`src/server/recipe-source.ts`）。
 *
 * 実行のときに使う手順は、表 `recipes`（migration 20261101001500_recipes）から読む（`src/server/recipe-source.ts`）。この定数はその表の
 * 既定の中身で、手順が 1 つも無い人の最初の読み出しで表へ写される。設定（#108）で段階の名前・指示・お手本を変えたもの・
 * 足したものも同じ表の行になる。run の開始時に写しを固定し、同じ親ページと手順の再実行でもその写しを引き継ぐ。
 * 手順の編集は、既存 run の写しを明示的に更新するまで実行へ反映しない（設計 §2.7）。
 */
export const DEFAULT_RECIPE_IDS = ["tpl-1", "tpl-2", "tpl-3", "tpl-4"] as const;
export type DefaultRecipeId = (typeof DEFAULT_RECIPE_IDS)[number];

/**
 * 1 つの工程。`profile` は AI の設定のプロファイル（標準・高性能・軽量）、`provider` は指す AI。
 * `chunked` は「長い入力は区切って処理する（全文を書き直す段階）」（#277。無い古い行は false）。
 */
export type RecipeStep = { id: string; name: string; instruction: string; profile: string; provider?: string; chunked?: boolean };

export type RecipeDef = {
  id: string;
  revision?: number;
  name: string;
  /** お手本（文書ガイド。全段階の入力に入る）。 */
  guide: string;
  steps: RecipeStep[];
  /** この手順の固有名詞と誤りやすい表記（アカウント共通の分は設定の glossary）。 */
  terms: SettingsTerm[];
  /** お手本の文書（本文は資産として別に置く）。 */
  samples: RecipeSample[];
};

function fromTemplate(id: DefaultRecipeId): RecipeDef {
  const template = FLOW_TEMPLATES.find((candidate) => candidate.id === id);
  if (!template || template.steps.length === 0) throw new Error(`editor-web: the step template ${id} is missing in docs-core`);
  return {
    id,
    revision: 1,
    name: template.name,
    guide: template.guide,
    steps: template.steps.map((step) => ({
      id: step.id,
      name: step.name,
      instruction: step.instruction,
      profile: step.profile,
      ...(step.provider === undefined ? {} : { provider: step.provider }),
      ...(step.chunked === true ? { chunked: true } : {}),
    })),
    terms: [],
    samples: [],
  };
}

export const DEFAULT_RECIPES: readonly RecipeDef[] = DEFAULT_RECIPE_IDS.map(fromTemplate);

export function isDefaultRecipeId(value: unknown): value is DefaultRecipeId {
  return typeof value === "string" && (DEFAULT_RECIPE_IDS as readonly string[]).includes(value);
}

/** 手順の id として受け付ける形（既定の `tpl-1` も、設定で足した `r-…` も通る）。存在するかは `findRecipeIn` が見る。 */
export function isRecipeKey(value: unknown): value is string {
  return typeof value === "string" && SETTINGS_ID_PATTERN.test(value);
}

function copyStep(step: RecipeStep): RecipeStep {
  return { ...step };
}

function copyRecipe(recipe: RecipeDef): RecipeDef {
  return {
    id: recipe.id,
    revision: recipe.revision,
    name: recipe.name,
    guide: recipe.guide,
    steps: recipe.steps.map(copyStep),
    terms: recipe.terms.map((term) => ({ ...term, variants: [...term.variants] })),
    samples: recipe.samples.map((sample) => ({ ...sample })),
  };
}

/**
 * 設定（`editor_settings.recipes`。0013）に保存した手順を、工程のプロファイルを足して手順の定義にする。
 * 設定の形には工程のプロファイルが無いので、同じ id の工程のプロファイル（既定の手順のもの）を引き継ぎ、
 * 足した手順・新しい工程は「標準」にする。
 */
export function recipeFromSettings(saved: SettingsRecipe, base: RecipeDef | undefined): RecipeDef {
  const byId = new Map((base?.steps ?? []).map((step) => [step.id, step] as const));
  return {
    id: saved.id,
    revision: base?.revision ?? 1,
    name: saved.name,
    guide: saved.guide,
    steps: saved.steps.map((step) => {
      const known = byId.get(step.id);
      return {
        id: step.id,
        name: step.name,
        instruction: step.instruction,
        profile: known?.profile ?? STANDARD_PROFILE_ID,
        ...(known?.provider === undefined ? {} : { provider: known.provider }),
        ...(known?.chunked === true ? { chunked: true } : {}),
      };
    }),
    terms: base?.terms.map((term) => ({ ...term, variants: [...term.variants] })) ?? [],
    samples: base?.samples.map((sample) => ({ ...sample })) ?? [],
  };
}

/**
 * 設定に保存した手順を既定にかぶせた、その人の手順。並びは既定の 3 つ（手を入れたものはその場）→ 足したものの保存順。
 * 表へ移したあとは、表に行が無い人の 1 回目の引き継ぎだけで使う（`src/server/recipe-source.ts`）。
 */
export function recipesOf(saved: readonly SettingsRecipe[] = []): RecipeDef[] {
  const byId = new Map(saved.map((recipe) => [recipe.id, recipe] as const));
  const defaults = DEFAULT_RECIPES.map((recipe) => {
    const override = byId.get(recipe.id);
    return override ? recipeFromSettings(override, recipe) : copyRecipe(recipe);
  });
  const added = saved.filter((recipe) => !isDefaultRecipeId(recipe.id)).map((recipe) => recipeFromSettings(recipe, undefined));
  return [...defaults, ...added];
}

/** 表から読んだ行を手順の定義にする（並びは表の順）。工程が残っていない行は、実行できないので出さない。 */
export function recipesFromStored(rows: readonly StoredRecipe[]): RecipeDef[] {
  return rows
    .filter((row) => row.steps.length > 0)
    .map((row) => ({
      id: row.id,
      revision: row.revision,
      name: row.name,
      guide: row.guide,
      steps: row.steps.map((step) => ({ ...step })),
      terms: row.terms.map((term) => ({ ...term, variants: [...term.variants] })),
      samples: row.samples.map((sample) => ({ ...sample })),
    }));
}

/** 手順の定義を表に保存する形にする（既定の 3 つは `builtin`、それ以外は `own`）。並びは渡した順。 */
export function toRecipeInputs(recipes: readonly RecipeDef[]): RecipeInput[] {
  return recipes.map((recipe) => ({
    id: recipe.id,
    name: recipe.name,
    guide: recipe.guide,
    steps: recipe.steps.map(copyStep),
    terms: recipe.terms.map((term) => ({ ...term, variants: [...term.variants] })),
    samples: recipe.samples.map((sample) => ({ ...sample })),
    origin: isDefaultRecipeId(recipe.id) ? "builtin" : "own",
  }));
}

export function findRecipeIn(recipes: readonly RecipeDef[], id: string): RecipeDef | undefined {
  return recipes.find((recipe) => recipe.id === id);
}

/** その人の手順を読む（表 `recipes` から。実行時の配線は src/server/steps-deps.ts）。 */
export type RecipeReader = (owner: string) => Promise<readonly RecipeDef[]>;
