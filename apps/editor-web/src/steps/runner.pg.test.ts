import { randomUUID } from "node:crypto";
import { EditorStore, seedRecipes } from "@niho/editor-store";
import { applyMigrations } from "@niho/editor-store/migrate";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { StepError, fakeExecutor, type StepExecutor } from "./executor";
import { createInlineQueue } from "./inline";
import { MemoryTaskQueue, taskName } from "./queue";
import { DEFAULT_RECIPES, findRecipeIn, toRecipeInputs } from "./recipes";
import { runAttempt } from "./runner";
import { pgStepRunStore } from "./store";

// 実 PostgreSQL で runner と step-runs.ts をつないで確かめる（メモリの store との食い違いを拾う）。TEST_DATABASE_URL が無ければ skip。
const databaseUrl = process.env.TEST_DATABASE_URL;
const OWNER = "synthetic-owner-a";
const transcript = [{ type: "paragraph", content: [{ type: "text", text: "合成の座談会の文字起こし" }] }];

describe.skipIf(databaseUrl === undefined)("runAttempt with PostgreSQL", () => {
  const schema = `editor_steps_runner_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await applyMigrations(client);
      await seedRecipes(client, OWNER, toRecipeInputs(DEFAULT_RECIPES));
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  /** フォルダと録音のタブを作り、録音から最後の段階まで run を作る（#309。`parentId` はフォルダ）。 */
  async function begin(recipeId: "tpl-1" | "tpl-2") {
    const store = pgStepRunStore(pool);
    const pages = new EditorStore(pool);
    const parentId = (await pages.createPage(OWNER, { kind: "folder", title: "合成のフォルダ" })).id;
    const recording = (await pages.createPage(OWNER, { kind: "rec", blocks: transcript, parent: parentId }))!.id;
    const recipe = findRecipeIn(DEFAULT_RECIPES, recipeId)!;
    const created = await store.createRun(OWNER, parentId, { recipe, inputTab: recording, toStep: recipe.steps.length - 1 });
    if (created.status !== "created") throw new Error(created.status);
    return { store, parentId, recording, run: created.run };
  }

  it("runs tpl-1 to the end, fails a step after three tries, and continues from a step's tab leaving the upstream untouched", async () => {
    const { store, parentId, run } = await begin("tpl-1");
    const queue = new MemoryTaskQueue();
    const drainAll = async (executor: StepExecutor) => {
      const statuses: string[] = [];
      for (let tasks = queue.drain(); tasks.length > 0; tasks = queue.drain()) {
        for (const task of tasks) statuses.push((await runAttempt({ store, recipes: async () => DEFAULT_RECIPES, executor, queue }, task)).status);
      }
      return statuses;
    };
    await queue.enqueue({ name: taskName(run.id, 0, 0), runId: run.id, stepIndex: 0 });
    expect(await drainAll(fakeExecutor)).toEqual(["completed", "completed", "completed"]);
    const done = (await store.listRun(OWNER, parentId))?.run;
    expect(done?.state).toBe("succeeded");
    expect(done?.steps.map((step) => step.stepStatus)).toEqual(["done", "done", "done"]);
    expect(await store.refreshStale(OWNER, parentId, findRecipeIn(DEFAULT_RECIPES, "tpl-1")!)).toBe(0);

    const upstream = await pool.query("SELECT id, blocks FROM pages WHERE parent = $1 ORDER BY id", [parentId]);
    // 段階 1 の出力のタブから続きを作る: 段階 2〜3 だけが新しいタブに走る（上流のタブは触らない。#309）
    const rerun = await store.createRun(OWNER, parentId, { recipe: findRecipeIn(DEFAULT_RECIPES, "tpl-1")!, inputTab: done!.steps[0]!.pageId, toStep: 2 });
    if (rerun.status !== "created") throw new Error(rerun.status);
    await queue.enqueue({ name: taskName(rerun.run.id, 1, 0), runId: rerun.run.id, stepIndex: 1 });
    const failing: StepExecutor = { run: async () => Promise.reject(new StepError("model_timeout", true)) };
    expect(await drainAll(failing)).toEqual(["retry", "retry", "failed"]);
    const failed = (await store.listRun(OWNER, parentId))?.run;
    expect(failed?.steps.map((step) => [step.index, step.state, step.stepStatus])).toEqual([[1, "failed", "failed"], [2, "canceled", "wait"]]);
    const kept = await pool.query("SELECT blocks FROM pages WHERE id = $1", [done!.steps[0]!.pageId]);
    expect(kept.rows[0]?.blocks).toEqual(upstream.rows.find((row) => row.id === done!.steps[0]!.pageId)?.blocks);
  });

  it("runs tpl-2 in the same process through the inline queue", async () => {
    const { store, parentId, run } = await begin("tpl-2");
    const queue = createInlineQueue({ store, recipes: async () => DEFAULT_RECIPES });
    await queue.enqueue({ name: taskName(run.id, 0, 0), runId: run.id, stepIndex: 0 });
    await vi.waitFor(async () => expect((await store.listRun(OWNER, parentId))?.run?.state).toBe("succeeded"), { timeout: 5_000 });
  });
});
