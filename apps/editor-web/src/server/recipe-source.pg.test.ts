import { randomUUID } from "node:crypto";
import { EditorStore, listRecipes, saveEditorSettings } from "@niho/editor-store";
import { applyMigrations } from "@niho/editor-store/migrate";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgStepRunStore } from "../steps/store";
import { DEFAULT_RECIPES, findRecipeIn } from "../steps/recipes";
import { ownerRecipes, saveOwnerRecipes } from "./recipe-source";

/**
 * T1（#37）の条件を実 PostgreSQL で確かめる: 固定だった 3 つの手順が、表 `recipes`から読んだ既定として同じように
 * 動くこと。TEST_DATABASE_URL が無ければ skip。値はすべて合成。
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const transcript = [{ type: "paragraph", content: [{ type: "text", text: "合成の座談会の文字起こし" }] }];

describe.skipIf(databaseUrl === undefined)("ownerRecipes with PostgreSQL", () => {
  const schema = `editor_recipe_source_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("writes every default into the table on the first read, and answers exactly the old constant", async () => {
    const owner = "synthetic-owner-fresh";
    expect(await listRecipes(pool, owner)).toEqual([]);
    expect(await ownerRecipes(pool, owner)).toEqual(DEFAULT_RECIPES);
    // 行として入っている（次からは表だけを読む）
    expect((await listRecipes(pool, owner)).map((recipe) => [recipe.id, recipe.origin, recipe.sortOrder])).toEqual([
      ["tpl-1", "builtin", 0],
      ["tpl-2", "builtin", 1],
      ["tpl-3", "builtin", 2],
      ["tpl-4", "builtin", 3],
    ]);
    expect(await ownerRecipes(pool, owner)).toEqual(DEFAULT_RECIPES);
  });

  it("carries the 0013 column over once: an edited default and an added recipe survive the move to the table", async () => {
    const owner = "synthetic-owner-carried";
    await saveEditorSettings(pool, owner, {
      recipes: [
        { id: "tpl-2", name: "議事録（短め）", guide: "短く", steps: [{ id: "d9c3x7mf", name: "要点", instruction: "要点だけ。" }] },
        { id: "r-talk", name: "対談", guide: "", steps: [{ id: "s-1", name: "まとめ", instruction: "まとめる。" }] },
      ],
    });
    const recipes = await ownerRecipes(pool, owner);
    expect(recipes.map((recipe) => [recipe.id, recipe.name])).toEqual([
      ["tpl-1", "記事制作"],
      ["tpl-2", "議事録（短め）"],
      ["tpl-3", DEFAULT_RECIPES[2]!.name],
      ["tpl-4", DEFAULT_RECIPES[3]!.name],
      ["r-talk", "対談"],
    ]);
    // 設定の形が持たない工程のプロファイルは、既定の同じ工程のものを引き継ぐ
    expect(recipes[1]?.steps.map((step) => step.profile)).toEqual([DEFAULT_RECIPES[1]!.steps[0]!.profile]);
    expect((await listRecipes(pool, owner)).map((recipe) => recipe.origin)).toEqual(["builtin", "builtin", "builtin", "builtin", "own"]);
    // 2 回目は列を読んでも書き足さない
    await saveEditorSettings(pool, owner, { recipes: [] });
    expect((await ownerRecipes(pool, owner)).map((recipe) => recipe.id)).toEqual(["tpl-1", "tpl-2", "tpl-3", "tpl-4", "r-talk"]);
  });

  it("adds a 既定の手順 that is missing from the table, so that a fourth default would reach someone who already has rows", async () => {
    const owner = "synthetic-owner-topped-up";
    await ownerRecipes(pool, owner);
    // 既定の手順が 1 つ増えた状態を作る（表から 1 つ消して、読み直す）
    await pool.query("DELETE FROM recipes WHERE owner = $1 AND id = $2", [owner, "tpl-2"]);
    expect((await listRecipes(pool, owner)).map((recipe) => recipe.id)).toEqual(["tpl-1", "tpl-3", "tpl-4"]);
    const recipes = await ownerRecipes(pool, owner);
    // 足りない既定だけが、今の並びの後ろに付く（ほかの行は動かない）
    expect(recipes.map((recipe) => recipe.id)).toEqual(["tpl-1", "tpl-3", "tpl-4", "tpl-2"]);
    expect(recipes.find((recipe) => recipe.id === "tpl-2")).toEqual(DEFAULT_RECIPES[1]);
    expect((await listRecipes(pool, owner)).map((recipe) => recipe.origin)).toEqual(["builtin", "builtin", "builtin", "builtin"]);
  });

  it("starts a run from a table-read recipe with the same 段階 and the same 役割ページ as the constant did", async () => {
    const owner = "synthetic-owner-run";
    const store = pgStepRunStore(pool);
    const recipes = await ownerRecipes(pool, owner);
    const fromTable = findRecipeIn(recipes, "tpl-1")!;
    const fromConstant = findRecipeIn(DEFAULT_RECIPES, "tpl-1")!;
    expect(fromTable).toEqual(fromConstant);

    const pages = new EditorStore(pool);
    const folderId = (await pages.createPage(owner, { kind: "folder", title: "合成のフォルダ" })).id;
    const recording = (await pages.createPage(owner, { kind: "rec", blocks: transcript, parent: folderId }))!.id;
    const created = await store.createRun(owner, folderId, { recipe: fromTable, inputTab: recording, toStep: fromTable.steps.length - 1 });
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    expect(created.run.steps.map((step) => [step.index, step.stepId, step.state])).toEqual([
      [0, "k7m2q9xa", "queued"],
      [1, "r4t8wz3c", "pending"],
      [2, "h2n6v5pe", "pending"],
    ]);
    // 役割ページ（出力のタブの入れ物）の題名は手順の工程の名前（表から読んでも同じ。#309）
    const holders = await pool.query<{ title: string }>("SELECT title FROM pages WHERE owner = $1 AND parent = $2 AND kind = 'page' AND role IS NOT NULL ORDER BY created_at, id", [owner, folderId]);
    expect(holders.rows.map((row) => row.title).sort()).toEqual(fromConstant.steps.map((step) => step.name).sort());
  });

  it("replaces the whole list when the 設定 saves, and the next read answers the saved order", async () => {
    const owner = "synthetic-owner-saved";
    const recipes = await ownerRecipes(pool, owner);
    const edited = recipes.map((recipe) => (recipe.id === "tpl-3" ? { ...recipe, name: "インサイト整理（短め）" } : recipe));
    const saved = await saveOwnerRecipes(pool, owner, [edited[2]!, edited[0]!, edited[1]!, edited[3]!]);
    expect(saved.map((recipe) => recipe.name)).toEqual(["インサイト整理（短め）", "記事制作", "議事録", "コーチング"]);
    expect(await ownerRecipes(pool, owner)).toEqual(saved);
  });
});
