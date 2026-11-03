import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { applyMigrations } from "../src/migrate.ts";
import { putRecipeSample, listRecipeSampleBodies, getRecipeGuideExtraction, saveRecipeGuideExtraction } from "../src/recipe-samples.ts";
import { duplicateRecipeWithSamples, putRecipes, type RecipeInput } from "../src/recipes.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const OWNER = "synthetic-recipe-samples-owner-a";
const OTHER = "synthetic-recipe-samples-owner-b";
const baseRecipe: RecipeInput = {
  id: "r-sample-test",
  name: "合成手順",
  guide: "## 元のガイド",
  steps: [{ id: "s-sample-test", name: "まとめ", instruction: "合成指示", profile: "standard" }],
  terms: [],
  samples: [],
  origin: "own",
};

describe("recipe samples and review drafts", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_recipe_samples_${randomUUID().replaceAll("-", "")}`;
  let pool: PgPool;

  before(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try { await applyMigrations(client); } finally { client.release(); }
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("keeps sample bodies owner scoped and removes previews when their sample set changes", async () => {
    await putRecipes(pool, OWNER, [baseRecipe]);
    await putRecipes(pool, OTHER, [baseRecipe]);
    const first = { id: "sample-a", name: "合成見本A", chars: 10 };
    const second = { id: "sample-b", name: "合成見本B", chars: 10 };
    assert.equal(await putRecipeSample(pool, OWNER, baseRecipe.id, first, "合成本文A"), "created");
    assert.equal(await saveRecipeGuideExtraction(pool, OWNER, baseRecipe.id, [first.id], "## 抽出案", [{ term: "合成語", reading: "ごうせいご", variants: [], note: "" }]), true);
    assert.equal((await getRecipeGuideExtraction(pool, OWNER, baseRecipe.id))?.guide, "## 抽出案");
    assert.equal(await getRecipeGuideExtraction(pool, OTHER, baseRecipe.id), null);

    // 既存の抽出案を作った後に見本を増やし、対象の set が変わると案を破棄する。
    assert.equal(await putRecipeSample(pool, OWNER, baseRecipe.id, second, "合成本文B"), "created");
    assert.deepEqual(await listRecipeSampleBodies(pool, OWNER, baseRecipe.id), [
      { id: "sample-a", text: "合成本文A" },
      { id: "sample-b", text: "合成本文B" },
    ]);
    assert.deepEqual(await listRecipeSampleBodies(pool, OTHER, baseRecipe.id), []);
    assert.equal(await getRecipeGuideExtraction(pool, OWNER, baseRecipe.id), null, "新しいサンプルを加えた後は古い抽出案を残さない");

    await saveRecipeGuideExtraction(pool, OWNER, baseRecipe.id, [first.id], "## もう一度の抽出案", []);
    await putRecipes(pool, OWNER, [{ ...baseRecipe, samples: [second] }]);
    assert.deepEqual(await listRecipeSampleBodies(pool, OWNER, baseRecipe.id), [{ id: "sample-b", text: "合成本文B" }]);
    assert.equal(await getRecipeGuideExtraction(pool, OWNER, baseRecipe.id), null, "参照サンプルの削除で本文と抽出案を回収する");
  });

  it("duplicates the recipe and sample bodies atomically without copying an extraction preview", async () => {
    await putRecipes(pool, OWNER, [baseRecipe]);
    const sample = { id: "sample-copy", name: "複製用のお手本", chars: 9 };
    assert.equal(await putRecipeSample(pool, OWNER, baseRecipe.id, sample, "合成本文を複製"), "created");
    await saveRecipeGuideExtraction(pool, OWNER, baseRecipe.id, [sample.id], "## 抽出案", []);

    const result = await duplicateRecipeWithSamples(pool, OWNER, baseRecipe.id);
    assert.equal(result.status, "created");
    if (result.status !== "created") return;
    assert.notEqual(result.recipe.id, baseRecipe.id);
    assert.equal(result.recipe.revision, 1);
    assert.equal(result.recipe.origin, "own");
    assert.equal(result.recipe.guide, baseRecipe.guide);
    assert.notEqual(result.recipe.steps[0]?.id, baseRecipe.steps[0]?.id);
    assert.notEqual(result.recipe.samples[0]?.id, sample.id);
    assert.deepEqual(await listRecipeSampleBodies(pool, OWNER, result.recipe.id), [
      { id: result.recipe.samples[0]!.id, text: "合成本文を複製" },
    ]);
    assert.equal(await getRecipeGuideExtraction(pool, OWNER, result.recipe.id), null);
  });
});
