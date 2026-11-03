import "server-only";
import { duplicateRecipeWithSamples, getEditorSettings, saveEditorSettings } from "@niho/editor-store";
import { getAuthProvider } from "../auth";
import { getPool } from "./db";
import { ownerRecipes, saveOwnerRecipes } from "./recipe-source";
import type { SettingsApiDeps } from "./settings-api";

/**
 * 設定の route（`/api/settings`。#108）の実行時の依存（DB の接続は要求のたびに遅延して決める。Pool は getStore と共有）。
 * deps.ts と並行して触らないよう、ここに置いている（ai-deps.ts・steps-deps.ts と同じ作り）。
 */
export const settingsDeps: SettingsApiDeps = {
  auth: () => getAuthProvider(),
  settings: () => {
    const pool = getPool();
    if (!pool) return null;
    return {
      get: (owner) => getEditorSettings(pool, owner),
      save: (owner, patch) => saveEditorSettings(pool, owner, patch),
      recipes: (owner) => ownerRecipes(pool, owner),
      saveRecipes: (owner, recipes) => saveOwnerRecipes(pool, owner, recipes),
    };
  },
  duplicateRecipe: async (owner, recipeId) => {
    const pool = getPool();
    if (!pool) return { status: "unavailable" };
    await ownerRecipes(pool, owner);
    const result = await duplicateRecipeWithSamples(pool, owner, recipeId);
    if (result.status !== "created") return result;
    return { status: "created", recipes: await ownerRecipes(pool, owner) };
  },
};
