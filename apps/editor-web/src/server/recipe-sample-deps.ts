import "server-only";
import { getAiUsage, getEditorSettings, monthKeyJst, putRecipeSample, getRecipeGuideExtraction, listRecipeSampleBodies, recordAiUsage, saveRecipeGuideExtraction } from "@niho/editor-store";
import { getAuthProvider } from "../auth";
import { monthlyLimitUsd, resolveAiCompose } from "../ai/config";
import { ownerRecipes } from "./recipe-source";
import { getPool } from "./db";
import type { RecipeSampleApiDeps } from "./recipe-samples-api";

export const recipeSampleApiDeps: RecipeSampleApiDeps = {
  auth: () => getAuthProvider(),
  store: () => {
    const pool = getPool();
    if (!pool) return null;
    return {
      recipes: (owner) => ownerRecipes(pool, owner),
      glossary: async (owner) => (await getEditorSettings(pool, owner)).glossary,
      sampleBodies: (owner, recipeId) => listRecipeSampleBodies(pool, owner, recipeId),
      addSample: (owner, recipeId, sample, body) => putRecipeSample(pool, owner, recipeId, sample, body),
      saveExtraction: (owner, recipeId, sampleIds, guide, candidates) => saveRecipeGuideExtraction(pool, owner, recipeId, sampleIds, guide, candidates),
      getExtraction: (owner, recipeId) => getRecipeGuideExtraction(pool, owner, recipeId),
    };
  },
  compose: () => resolveAiCompose(process.env),
  usage: () => {
    const pool = getPool();
    return pool ? {
      get: (owner, month) => getAiUsage(pool, owner, month, "server"),
      record: (owner, month, delta) => recordAiUsage(pool, owner, month, delta, "server"),
    } : null;
  },
  limitUsd: () => monthlyLimitUsd(process.env),
  now: () => new Date(),
  monthKey: monthKeyJst,
};
