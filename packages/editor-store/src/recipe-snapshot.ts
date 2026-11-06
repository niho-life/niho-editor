import { isRecipeSample, isRecipeStep, RECIPE_LIMITS } from "./recipes.ts";
import { isSettingsTerm, SETTINGS_ID_PATTERN } from "./settings.ts";

/** A run's executable design. Sample bodies are stored separately and are never copied here. */
export type RecipeSnapshot = {
  id: string;
  name: string;
  guide: string;
  /** `chunked`: 長い入力を区切って処理する（全文を書き直す段階。#277）。無い古い写しは false。true のときだけ持つ。 */
  steps: { id: string; name: string; instruction: string; profile: string; chunked?: boolean }[];
  terms: { term: string; reading: string; variants: string[]; note: string }[];
  samples: { id: string; name: string; chars: number; truncatedFrom?: number; sourceUrl?: string }[];
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Never silently repair a persisted snapshot using today's recipe. */
export function parseRecipeSnapshot(value: unknown): RecipeSnapshot | null {
  if (!object(value) || Object.keys(value).some((key) => !["id", "name", "guide", "steps", "terms", "samples"].includes(key))) return null;
  if (typeof value.id !== "string" || !SETTINGS_ID_PATTERN.test(value.id)) return null;
  // Match settings/recipe validation: limits count Unicode code points, not UTF-16 units.
  if (typeof value.name !== "string" || !value.name.trim() || Array.from(value.name).length > RECIPE_LIMITS.nameChars) return null;
  if (typeof value.guide !== "string" || Array.from(value.guide).length > RECIPE_LIMITS.guideChars) return null;
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > RECIPE_LIMITS.steps) return null;
  if (!value.steps.every((step) => object(step) && Object.keys(step).every((key) => ["id", "name", "instruction", "profile", "chunked"].includes(key)) && isRecipeStep(step) && step.provider === undefined)) return null;
  if (new Set(value.steps.map((step) => step.id)).size !== value.steps.length) return null;
  if (!Array.isArray(value.terms) || value.terms.length > RECIPE_LIMITS.terms || !value.terms.every(isSettingsTerm)) return null;
  if (!Array.isArray(value.samples) || value.samples.length > RECIPE_LIMITS.samples || !value.samples.every(isRecipeSample)) return null;
  if (new Set(value.samples.map((sample) => sample.id)).size !== value.samples.length) return null;
  return value as RecipeSnapshot;
}

export function snapshotOf(recipe: RecipeSnapshot): RecipeSnapshot {
  const snapshot = {
    id: recipe.id, name: recipe.name, guide: recipe.guide,
    steps: recipe.steps.map(({ id, name, instruction, profile, chunked }) => ({ id, name, instruction, profile, ...(chunked === true ? { chunked: true } : {}) })),
    terms: recipe.terms.map(({ term, reading, variants, note }) => ({ term, reading, variants: [...variants], note })),
    samples: recipe.samples.map((sample) => ({ ...sample })),
  };
  if (!parseRecipeSnapshot(snapshot)) throw new TypeError("editor-store: invalid recipe snapshot");
  return snapshot;
}
