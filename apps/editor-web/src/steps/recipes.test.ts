import { FLOW_TEMPLATES, STANDARD_PROFILE_ID, stepHash } from "@niho/docs-core";
import { cleanRecipe, instructionHash, recipesProblem, type SettingsRecipe, type StoredRecipe } from "@niho/editor-store";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECIPES,
  findRecipeIn,
  isDefaultRecipeId,
  isRecipeKey,
  recipesFromStored,
  recipesOf,
  toRecipeInputs,
  type RecipeDef,
} from "./recipes";

const added: SettingsRecipe = { id: "r-1", name: "座談会", guide: "お手本", steps: [{ id: "s-1", name: "まとめ", instruction: "まとめる。" }] };
/** 設定に保存した手順（プロファイルを持たない形）を読んだときの手順の定義。 */
const addedDef: RecipeDef = {
  ...added,
  revision: 1,
  steps: added.steps.map((step) => ({ ...step, profile: STANDARD_PROFILE_ID })),
  terms: [],
  samples: [],
};

describe("recipes", () => {
  it("copies the four templates of design §7.2 from docs-core, coaching included", () => {
    expect(DEFAULT_RECIPES.map((recipe) => [recipe.id, recipe.name, recipe.steps.length])).toEqual([
      ["tpl-1", "記事制作", 3],
      ["tpl-2", "議事録", 2],
      ["tpl-3", "インサイト整理", 1],
      ["tpl-4", "コーチング", 2],
    ]);
    expect(DEFAULT_RECIPES.flatMap((recipe) => recipe.steps.map((step) => step.id))).toEqual(["k7m2q9xa", "r4t8wz3c", "h2n6v5pe", "d9c3x7mf", "w5q1j8ks", "u3e7z6rh", "c5v8n3qd", "a3m9t6kw"]);
    // コーチングは「文字起こし修正」を記事制作と共有し、1 行だけ足した指示文で持つ（docs-core の COACHING_TRANSCRIPT_LINE）
    expect(findRecipeIn(DEFAULT_RECIPES, "tpl-4")?.steps.map((step) => step.name)).toEqual(["文字起こし修正", "分析"]);
    expect(isDefaultRecipeId("tpl-4")).toBe(true);
    expect(isDefaultRecipeId("tpl-9")).toBe(false);
    expect(isDefaultRecipeId("tpl-1")).toBe(true);
    expect(findRecipeIn(DEFAULT_RECIPES, "tpl-2")?.steps.map((step) => step.name)).toEqual(["議事録", "共有用の要約"]);
  });

  it("keeps the instructions and the guide of docs-core as they are", () => {
    for (const recipe of DEFAULT_RECIPES) {
      const template = FLOW_TEMPLATES.find((candidate) => candidate.id === recipe.id);
      expect(recipe.steps).toEqual(template?.steps.map(({ id, name, instruction, profile }) => ({ id, name, instruction, profile })));
      expect(recipe.guide).toBe(template?.guide);
    }
  });

  it("hashes instructions in editor-store exactly like docs-core's stepHash (the input basis depends on it)", () => {
    const samples = [...FLOW_TEMPLATES.flatMap((template) => template.steps.map((step) => step.instruction)), "", "  前後の空白  \n", "合成の指示"];
    for (const instruction of samples) expect(instructionHash(instruction)).toBe(stepHash(instruction));
  });

  it("accepts the ids of both the default and the added recipes, and nothing else", () => {
    for (const id of ["tpl-1", "r-1", "a", "a-b-c", "r-0123456789abcdef"]) expect(isRecipeKey(id), id).toBe(true);
    for (const id of ["", "Tpl-1", "-x", "tpl_1", "a".repeat(65), "tpl 1", null, 1]) expect(isRecipeKey(id), String(id)).toBe(false);
  });
});

describe("recipesOf", () => {
  it("answers the defaults when nothing is saved", () => {
    expect(recipesOf()).toEqual(DEFAULT_RECIPES);
    expect(recipesOf([])).toEqual(DEFAULT_RECIPES);
  });

  it("lays a saved copy over the default of the same id, in the default's place", () => {
    const override: SettingsRecipe = { id: "tpl-2", name: "議事録（短め）", guide: "短く", steps: [{ id: "d9c3x7mf", name: "要点", instruction: "要点だけ。" }] };
    const recipes = recipesOf([override]);
    expect(recipes.map((recipe) => recipe.id)).toEqual(["tpl-1", "tpl-2", "tpl-3", "tpl-4"]);
    // 設定の形にはプロファイルが無いので、同じ id の工程のプロファイル（既定の「軽量」）を引き継ぐ
    expect(recipes[1]).toEqual({
      ...override,
      revision: 1,
      steps: [{ ...override.steps[0]!, profile: findRecipeIn(DEFAULT_RECIPES, "tpl-2")!.steps[0]!.profile }],
      terms: [],
      samples: [],
    });
    // 既定の定数は書き換えない
    expect(findRecipeIn(DEFAULT_RECIPES, "tpl-2")?.name).toBe("議事録");
  });

  it("puts the added recipes after the defaults, in the saved order", () => {
    const second: SettingsRecipe = { ...added, id: "r-2", name: "対談" };
    const recipes = recipesOf([second, added]);
    expect(recipes.map((recipe) => recipe.id)).toEqual(["tpl-1", "tpl-2", "tpl-3", "tpl-4", "r-2", "r-1"]);
    expect(findRecipeIn(recipes, "r-1")).toEqual(addedDef);
  });

  it("hands out copies, so that a caller cannot change the next reader's recipe", () => {
    const recipes = recipesOf([added]);
    recipes[3]!.steps[0]!.name = "書き換え";
    expect(findRecipeIn(recipesOf([added]), "r-1")?.steps[0]?.name).toBe("まとめ");
  });
});

/**
 * T1（#37）の条件: 固定で持っていた既定の手順が、表（`recipes`）から読んだ既定として同じように動くこと。
 * 表との行き来は `toRecipeInputs`（書く形）と `recipesFromStored`（読んだ行）で、どちらも純粋な関数。
 */
describe("the recipes table holds the fixed recipes without changing them", () => {
  /** 表に入れて読み直したのと同じ（jsonb は列の値をそのまま返す。既定は `origin` が builtin で並びは渡した順）。 */
  function roundTrip(recipes: readonly RecipeDef[]): StoredRecipe[] {
    return toRecipeInputs(recipes).map((input, index) => {
      const row = cleanRecipe(input);
      return { ...row, sortOrder: index, revision: 1 };
    });
  }

  it("writes every default as a storable row, in order, marked as builtin", () => {
    const inputs = toRecipeInputs(DEFAULT_RECIPES);
    expect(recipesProblem(inputs)).toBeNull();
    expect(inputs.map((input) => [input.id, input.origin])).toEqual([
      ["tpl-1", "builtin"],
      ["tpl-2", "builtin"],
      ["tpl-3", "builtin"],
      ["tpl-4", "builtin"],
    ]);
  });

  it("reads them back as the same recipes the runner used to get from the constant", () => {
    expect(recipesFromStored(roundTrip(DEFAULT_RECIPES))).toEqual(DEFAULT_RECIPES);
  });

  it("keeps every instruction, guide and profile byte for byte", () => {
    for (const recipe of recipesFromStored(roundTrip(DEFAULT_RECIPES))) {
      const template = FLOW_TEMPLATES.find((candidate) => candidate.id === recipe.id);
      expect(recipe.guide, recipe.id).toBe(template?.guide);
      expect(recipe.steps.map((step) => [step.id, step.name, step.instruction, step.profile])).toEqual(
        template?.steps.map((step) => [step.id, step.name, step.instruction, step.profile]),
      );
    }
  });

  it("carries a saved copy and an added recipe through the table too", () => {
    const override: SettingsRecipe = { id: "tpl-2", name: "議事録（短め）", guide: "短く", steps: [{ id: "d9c3x7mf", name: "要点", instruction: "要点だけ。" }] };
    const effective = recipesOf([override, added]);
    expect(recipesFromStored(roundTrip(effective))).toEqual(effective);
    expect(toRecipeInputs(effective).map((input) => input.origin)).toEqual(["builtin", "builtin", "builtin", "builtin", "own"]);
  });

  it("drops a row whose 工程 have all gone, so that the runner never claims an empty recipe", () => {
    const rows = roundTrip(DEFAULT_RECIPES);
    expect(recipesFromStored(rows.map((row) => (row.id === "tpl-2" ? { ...row, steps: [] } : row))).map((recipe) => recipe.id)).toEqual(["tpl-1", "tpl-3", "tpl-4"]);
  });
});
