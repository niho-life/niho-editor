import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { applyMigrations } from "../src/migrate.ts";
import {
  MAX_TRIES,
  cancelRun,
  canonicalJson,
  claimAttempt,
  commitAttempt,
  commitChunk,
  resumeRun,
  startChunks,
  computeBasis,
  createRun,
  failAttempt,
  finalStepPageNames,
  getRunGuide,
  heartbeatAttempt,
  isIdempotencyKey,
  isStepErrorCode,
  listQueuedAttempts,
  requeueAttempt,
  listRun,
  readFlow,
  readPartialOutput,
  readStepInput,
  readStepStaleReasons,
  refreshStale,
  sweepExpiredLeases,
  updateRunRecipeSnapshot,
  type StepClaim,
  type StepRecipe,
  type StepRunsDb,
} from "../src/step-runs.ts";
import { EditorStore } from "../src/store.ts";
import { parseRecipeSnapshot, snapshotOf } from "../src/recipe-snapshot.ts";
import { RECIPE_LIMITS } from "../src/recipes.ts";
import type { Block } from "../src/types.ts";
import { computeChunkBasis, computeStepBasis } from "../src/step-basis.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID・本文・指示文だけを使う（実在の人の値を入れない）
const OWNER = "synthetic-owner-a";
const OTHER = "synthetic-owner-b";

const RECIPE: StepRecipe = {
  id: "tpl-synthetic",
  steps: [
    { id: "aaaa1111", name: "合成の段階 1", instruction: "合成の指示 1" },
    { id: "bbbb2222", name: "合成の段階 2", instruction: "合成の指示 2" },
    { id: "cccc3333", name: "合成の段階 3", instruction: "合成の指示 3" },
  ],
};
const LAST = RECIPE.steps.length - 1;

function paragraph(text: string): Block[] {
  return [{ type: "paragraph", content: [{ type: "text", text }] }];
}

const TRANSCRIPT = paragraph("合成の文字起こし");

describe("step runs without a database", () => {
  const untouchable: StepRunsDb = {
    query: (() => {
      throw new Error("must not reach the database");
    }) as unknown as StepRunsDb["query"],
    connect: (() => {
      throw new Error("must not reach the database");
    }) as unknown as StepRunsDb["connect"],
  };

  it("reads historical final-step names for only the requested owner and page", async () => {
    const id = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
    const queried: { text: string; values: unknown[] }[] = [];
    const db = {
      query: async (text: string, values: unknown[]) => {
        queried.push({ text, values });
        return { rows: [{ name: "記事本文" }, { name: null }, { name: "旧・記事本文" }] };
      },
    } as unknown as StepRunsDb;

    assert.deepEqual(await finalStepPageNames(db, OWNER, id), ["記事本文", "旧・記事本文"]);
    assert.deepEqual(queried[0]?.values, [OWNER, id]);
    assert.match(queried[0]?.text ?? "", /jsonb_array_length/);
    assert.deepEqual(await finalStepPageNames(db, "", id), []);
    assert.deepEqual(await finalStepPageNames(db, OWNER, "not-a-page-id"), []);
  });

  it("keeps executable profile and sample metadata, and rejects malformed snapshots", () => {
    const snapshot = snapshotOf({
      id: "tpl-synthetic", name: "合成", guide: "文書ガイド",
      steps: [{ id: "aaaa1111", name: "段階", instruction: "指示", profile: "light" }],
      terms: [], samples: [{ id: "sample-1", name: "お手本", chars: 12 }],
    });
    assert.equal(parseRecipeSnapshot(snapshot)?.steps[0]?.profile, "light");
    assert.deepEqual(snapshot.samples, [{ id: "sample-1", name: "お手本", chars: 12 }]);
    assert.equal(parseRecipeSnapshot({ ...snapshot, steps: [{ id: "aaaa1111", name: "段階", instruction: "指示" }] }), null);
    assert.equal(parseRecipeSnapshot({ ...snapshot, samples: [{ ...snapshot.samples[0], body: "複製してはいけない" }] }), null);
    assert.equal(parseRecipeSnapshot(null), null);
  });

  it("counts recipe snapshot text in Unicode code points like recipe settings do", () => {
    const name = `${"😀".repeat(40)}${"a".repeat(40)}`;
    assert.equal(Array.from(name).length, RECIPE_LIMITS.nameChars);
    assert.ok(name.length > RECIPE_LIMITS.nameChars);
    const guide = `${"😀".repeat(RECIPE_LIMITS.guideChars / 2)}${"a".repeat(RECIPE_LIMITS.guideChars / 2)}`;
    assert.equal(Array.from(guide).length, RECIPE_LIMITS.guideChars);
    assert.ok(guide.length > RECIPE_LIMITS.guideChars);
    const snapshot = snapshotOf({
      id: "tpl-synthetic", name, guide,
      steps: [{ id: "aaaa1111", name: "段階", instruction: "指示", profile: "standard" }],
      terms: [], samples: [],
    });
    assert.equal(parseRecipeSnapshot(snapshot)?.name, name);
    assert.equal(parseRecipeSnapshot(snapshot)?.guide, guide);
  });

  it("computes the input basis from the canonical JSON of the previous blocks and the instruction (fixed value)", () => {
    assert.equal(canonicalJson([{ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }]), '[{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}]');
    const blocks = paragraph("合成の本文");
    const basis = computeBasis(blocks, "合成の指示");
    assert.match(basis, /^[0-9a-f]{64}$/);
    assert.equal(basis, computeBasis([{ type: "paragraph", content: [{ text: "合成の本文", type: "text" }] }], "  合成の指示 "));
    assert.notEqual(basis, computeBasis(blocks, "別の指示"));
    assert.notEqual(basis, computeBasis(paragraph("別の本文"), "合成の指示"));
  });

  it("validates error codes and idempotency keys", () => {
    assert.equal(isStepErrorCode("model_timeout"), true);
    assert.equal(isStepErrorCode("Message: secret"), false);
    assert.equal(isStepErrorCode(""), false);
    assert.equal(isIdempotencyKey("abc-DEF_123"), true);
    assert.equal(isIdempotencyKey("a".repeat(129)), false);
    assert.equal(isIdempotencyKey("with space"), false);
  });

  it("treats malformed ids as missing and refuses an empty owner without querying", async () => {
    assert.deepEqual(await createRun(untouchable, OWNER, "not-a-page-id", { recipe: RECIPE, inputTab: randomUUID(), toStep: 0 }), { status: "not_found" });
    assert.deepEqual(await createRun(untouchable, OWNER, randomUUID(), { recipe: RECIPE, inputTab: "not-a-page-id", toStep: 0 }), { status: "not_found" });
    assert.equal(await listRun(untouchable, OWNER, "not-a-page-id"), null);
    assert.equal(await cancelRun(untouchable, OWNER, "not-a-page-id", randomUUID()), null);
    assert.equal(await readFlow(untouchable, OWNER, "not-a-page-id"), null);
    assert.deepEqual(await claimAttempt(untouchable, "not-a-run-id", 0), { ok: false, reason: "run_inactive" });
    assert.equal(await readStepInput(untouchable, { owner: OWNER, parentId: randomUUID(), inputTabId: "not-a-page-id", previousPageId: null }), null);
    await assert.rejects(() => createRun(untouchable, "", randomUUID(), { recipe: RECIPE, inputTab: randomUUID(), toStep: 0 }), TypeError);
    await assert.rejects(() => createRun(untouchable, OWNER, randomUUID(), { recipe: RECIPE, inputTab: randomUUID(), toStep: -1 }), RangeError);
    await assert.rejects(() => createRun(untouchable, OWNER, randomUUID(), { recipe: RECIPE, inputTab: randomUUID(), toStep: 0, idempotencyKey: "bad key" }), TypeError);
    await assert.rejects(() => createRun(untouchable, OWNER, randomUUID(), { recipe: { id: "x", steps: [] }, inputTab: randomUUID(), toStep: 0 }), TypeError);
  });
});

describe("PostgreSQL step runs", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_steps_test_${randomUUID().replaceAll("-", "")}`;
  let pool: PgPool;
  let store: EditorStore;

  before(async () => {
    const { Pool } = await import("pg");
    // 並行の claim を本当に並行にするため、接続を多めに持つ
    pool = new Pool({ connectionString: databaseUrl, max: 25, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await applyMigrations(client);
      await client.query("INSERT INTO recipes (owner,id,name,steps) VALUES ($1,$2,$3,$4::jsonb)", [OWNER, RECIPE.id, RECIPE.id, JSON.stringify(RECIPE.steps.map((step) => ({ ...step, profile: "standard" })))]);
    } finally {
      client.release();
    }
    store = new EditorStore(pool);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  /** フォルダと、その中の録音のタブ（run の入力）。 */
  async function folderWithRecording(owner = OWNER, blocks: Block[] = TRANSCRIPT): Promise<{ folder: string; rec: string }> {
    const folder = (await store.createPage(owner, { kind: "folder", title: "合成のフォルダ" })).id;
    const rec = await store.createPage(owner, { kind: "rec", title: "合成の録音", blocks, parent: folder });
    assert.ok(rec);
    return { folder, rec: rec.id };
  }

  /** 利用者がページを保存する（今の revision を持って。#58 の楽観ロック）。 */
  async function userEdit(owner: string, id: string, blocks: Block[]) {
    const current = await store.getPage(owner, id);
    assert.ok(current, "page exists");
    const result = await store.savePage(owner, id, { blocks }, { baseRevision: current.revision });
    assert.equal(result?.status, "saved");
  }

  async function pageRow(id: string) {
    const result = await pool.query<{ kind: string; title: string; parent: string | null; page: string | null; recipe: string | null; step_status: string | null; blocks: Block[]; made_from: unknown; deleted_at: Date | null }>(
      "SELECT kind, title, parent, page, recipe, step_status, blocks, made_from, deleted_at FROM pages WHERE id = $1",
      [id],
    );
    return result.rows[0];
  }

  async function holderRow(id: string | null | undefined) {
    assert.ok(id, "an output tab belongs to a holder");
    const result = await pool.query<{ kind: string; title: string; parent: string | null; role: unknown; last_tab: string | null }>("SELECT kind, title, parent, role, last_tab FROM pages WHERE id = $1", [id]);
    return result.rows[0];
  }

  async function attemptRow(runId: string, stepIndex: number) {
    const result = await pool.query<{ state: string; generation: number; tries: number; error_code: string | null; input_basis: string | null; input_basis_v2: unknown; lease_until: Date | null; partial_blocks: unknown }>(
      "SELECT state, generation, tries, error_code, input_basis, input_basis_v2, lease_until, partial_blocks FROM step_attempts WHERE run_id = $1 AND step_index = $2",
      [runId, stepIndex],
    );
    return result.rows[0];
  }

  async function runRow(runId: string) {
    return (await pool.query<{ state: string; finished_at: Date | null; parent: string; input_tab: string | null; from_step: number }>("SELECT state, finished_at, parent, input_tab, from_step FROM step_runs WHERE id = $1", [runId])).rows[0];
  }

  /** 入力のタブから最後の段階まで（既定）作る run。 */
  async function created(folderId: string, inputTab: string, options: { toStep?: number; idempotencyKey?: string } = {}) {
    const result = await createRun(pool, OWNER, folderId, { recipe: RECIPE, inputTab, toStep: options.toStep ?? LAST, ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }) });
    assert.equal(result.status, "created");
    assert.ok(result.status === "created");
    return result.run;
  }

  async function claimed(runId: string, stepIndex: number): Promise<StepClaim> {
    const result = await claimAttempt(pool, runId, stepIndex);
    assert.ok(result.ok, `claim ${stepIndex}: ${result.ok ? "" : result.reason}`);
    return result.claim;
  }

  const refOf = (claim: StepClaim) => ({ runId: claim.runId, stepIndex: claim.stepIndex, generation: claim.generation });

  /** claim → 入力を読む → 基準を付けて確定。 */
  async function complete(runId: string, stepIndex: number, text = `合成の結果 ${stepIndex}`) {
    const claim = await claimed(runId, stepIndex);
    const input = await readStepInput(pool, claim);
    assert.ok(input);
    const result = await commitAttempt(pool, { ...refOf(claim), blocks: paragraph(text), inputBasis: computeStepBasis(RECIPE, stepIndex, input) });
    assert.ok(result.ok, `commit ${stepIndex}`);
    return { claim, next: result.next };
  }

  async function completeAll(run: { id: string; steps: { index: number }[] }) {
    for (const step of run.steps) await complete(run.id, step.index);
  }

  it("applies the migration to an empty schema and accepts failed as a step status", async () => {
    const page = await store.createPage(OWNER);
    await pool.query("UPDATE pages SET step_status = 'failed' WHERE id = $1", [page.id]);
    await assert.rejects(() => pool.query("UPDATE pages SET step_status = 'paused' WHERE id = $1", [page.id]), { code: "23514" });
  });

  it("creates a run on the folder from the recording tab, with a role holder and a new tab per step, and queues the first step", async () => {
    const { folder, rec } = await folderWithRecording();
    const run = await created(folder, rec);
    assert.equal(run.state, "queued");
    assert.equal(run.recipe, RECIPE.id);
    assert.equal(run.fromStep, 0);
    assert.equal(run.inputTab, rec);
    assert.deepEqual(run.steps.map((step) => step.state), ["queued", "pending", "pending"]);
    assert.deepEqual(run.steps.map((step) => step.stepId), RECIPE.steps.map((step) => step.id));
    assert.deepEqual(await runRow(run.id), { ...(await runRow(run.id))!, parent: folder, input_tab: rec, from_step: 0 });
    let previous = rec;
    for (const [index, step] of run.steps.entries()) {
      assert.equal(step.stepStatus, "wait");
      assert.equal(step.tries, 0);
      const page = await pageRow(step.pageId);
      // 出力は役割ページ（フォルダ直下・role = step）の新しいタブ。題名は段階の名前。系譜は run と入力（前の段階の出力）
      assert.deepEqual(
        { kind: page?.kind, title: page?.title, parent: page?.parent, recipe: page?.recipe, status: page?.step_status, blocks: page?.blocks, made: page?.made_from },
        { kind: "note", title: RECIPE.steps[index]!.name, parent: folder, recipe: RECIPE.id, status: "wait", blocks: [], made: { kind: "step", run: run.id, input: previous, inputRevision: index === 0 ? 1 : 0 } },
      );
      const holder = await holderRow(page?.page);
      assert.deepEqual([holder?.kind, holder?.title, holder?.parent, holder?.role, holder?.last_tab], ["page", RECIPE.steps[index]!.name, folder, { kind: "step", recipe: RECIPE.id, stepId: step.stepId }, step.pageId]);
      previous = step.pageId;
    }
    assert.deepEqual(await listRun(pool, OWNER, folder), { run });
    // 流れ: 入れ物（録音と 3 つの役割ページ）とそのタブ
    const flow = await readFlow(pool, OWNER, folder);
    assert.deepEqual(flow?.folder, { id: folder, title: "合成のフォルダ", recipe: null });
    assert.deepEqual(flow?.holders.map((holder) => [holder.role, holder.tabs.map((tab) => [tab.id, tab.tabPos, tab.stepStatus])]), [
      [null, [[rec, 1, null]]],
      ...run.steps.map((step) => [{ kind: "step", recipe: RECIPE.id, stepId: step.stepId }, [[step.pageId, 1, "wait"]]]),
    ]);
    assert.deepEqual(flow?.usedEngines, []);
    assert.equal(await readFlow(pool, OWNER, rec), null, "only a folder has a flow");
  });

  it("reuses the role holder: a second run adds a tab to it; the input's role decides the first step; toStep can stop early", async () => {
    const { folder, rec } = await folderWithRecording();
    const first = await created(folder, rec, { toStep: 1 });
    assert.deepEqual(first.steps.map((step) => step.index), [0, 1]);
    await completeAll(first);
    assert.equal((await runRow(first.id))?.state, "succeeded");
    // 段階 2 の出力のタブ（役割 2）から → 段階 3 だけ。役割 2 の入れ物は同じ、段階 3 の入れ物は新しくできる
    const secondTab = first.steps[1]!.pageId;
    const next = await created(folder, secondTab);
    assert.equal(next.fromStep, 2);
    assert.equal(next.inputTab, secondTab);
    assert.deepEqual(next.steps.map((step) => [step.index, step.state]), [[2, "queued"]]);
    assert.deepEqual((await pageRow(next.steps[0]!.pageId))?.made_from, { kind: "step", run: next.id, input: secondTab, inputRevision: 2 });
    // 録音からもう一度段階 1〜2 を作ると、同じ役割の入れ物に 2 つ目のタブ
    const again = await createRun(pool, OWNER, folder, { recipe: RECIPE, inputTab: rec, toStep: 1 });
    assert.equal(again.status, "run_in_progress", "the folder has a run in progress");
    await cancelRun(pool, OWNER, folder, next.id);
    const rerun = await created(folder, rec, { toStep: 1 });
    assert.equal((await pageRow(rerun.steps[0]!.pageId))?.page, (await pageRow(first.steps[0]!.pageId))?.page, "the same holder");
    assert.notEqual(rerun.steps[0]!.pageId, first.steps[0]!.pageId, "a new tab");
    const flow = await readFlow(pool, OWNER, folder);
    const holder = flow?.holders.find((item) => item.role?.kind === "step" && item.role.stepId === RECIPE.steps[0]!.id);
    assert.deepEqual(holder?.tabs.map((tab) => [tab.id, tab.tabPos]), [[first.steps[0]!.pageId, 1], [rerun.steps[0]!.pageId, 2]]);
    // 段階の範囲の外は 400。まだ済んでいない段階の出力（待ち・失敗）からも作れない
    await cancelRun(pool, OWNER, folder, rerun.id);
    assert.deepEqual(await createRun(pool, OWNER, folder, { recipe: RECIPE, inputTab: secondTab, toStep: 1 }), { status: "invalid_from_step" }, "toStep before the input's role");
    assert.deepEqual(await createRun(pool, OWNER, folder, { recipe: RECIPE, inputTab: rec, toStep: 3 }), { status: "invalid_from_step" }, "past the last step");
    assert.deepEqual(await createRun(pool, OWNER, folder, { recipe: RECIPE, inputTab: rerun.steps[0]!.pageId, toStep: 2 }), { status: "invalid_from_step" }, "the canceled run's output never ran (wait)");
  });

  it("regenerates into the same tab and makes a sibling from the same input", async () => {
    const { folder, rec } = await folderWithRecording();
    const first = await created(folder, rec);
    await completeAll(first);
    const [tab0, tab1] = [first.steps[0]!.pageId, first.steps[1]!.pageId];
    // 作り直す: 新しいタブは増えず、同じタブへ書く。入力は系譜（段階 1 の入力＝録音、段階 2 の入力＝段階 1 の出力）
    const redo = await createRun(pool, OWNER, folder, { recipe: RECIPE, regenerate: tab1 });
    assert.ok(redo.status === "created");
    assert.deepEqual(redo.run.steps.map((step) => [step.index, step.pageId, step.state, step.stepStatus]), [[1, tab1, "queued", "wait"]]);
    assert.equal(redo.run.inputTab, tab0);
    await complete(redo.run.id, 1, "作り直した結果");
    assert.deepEqual((await pageRow(tab1))?.blocks, paragraph("作り直した結果"));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pages WHERE page = $1 AND deleted_at IS NULL", [(await pageRow(tab1))?.page])).rows[0]?.n, 1, "no new tab");
    // 同じ入力でもう 1 つ: 同じ入れ物に新しいタブ、入力は同じ
    const more = await createRun(pool, OWNER, folder, { recipe: RECIPE, sibling: tab1 });
    assert.ok(more.status === "created");
    const sibling = more.run.steps[0]!.pageId;
    assert.notEqual(sibling, tab1);
    assert.equal((await pageRow(sibling))?.page, (await pageRow(tab1))?.page);
    assert.deepEqual((await pageRow(sibling))?.made_from, { kind: "step", run: more.run.id, input: tab0, inputRevision: 2 });
    await cancelRun(pool, OWNER, folder, more.run.id);
    // 段階の出力でないタブ・入力が消えたタブは作り直せない
    assert.deepEqual(await createRun(pool, OWNER, folder, { recipe: RECIPE, regenerate: rec }), { status: "invalid_from_step" });
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [tab0]);
    assert.deepEqual(await createRun(pool, OWNER, folder, { recipe: RECIPE, regenerate: tab1 }), { status: "invalid_from_step" });
  });

  it("reads the latest run's guide and terms for the folder, its pages and output tabs — and for nobody else", async () => {
    const owner = "synthetic-guide-owner";
    const recipe = { ...RECIPE, revision: 1, name: "合成の手順", guide: "合成のガイド: 常体でそろえる", terms: [{ term: "円覚寺", reading: "えんがくじ", variants: ["円学寺"], note: "" }], steps: RECIPE.steps.map((step) => ({ ...step, profile: "standard" })) };
    await pool.query("INSERT INTO recipes(owner,id,name,guide,steps,terms) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)", [owner, recipe.id, recipe.name, recipe.guide, JSON.stringify(recipe.steps), JSON.stringify(recipe.terms)]);
    const { folder, rec } = await folderWithRecording(owner);
    // run が無いあいだは何も返さない
    assert.equal(await getRunGuide(pool, owner, rec), null);
    const first = await createRun(pool, owner, folder, { recipe, inputTab: rec, toStep: LAST });
    assert.equal(first.status, "created");
    const expected = { recipeName: "合成の手順", guide: "合成のガイド: 常体でそろえる", terms: recipe.terms };
    assert.deepEqual(await getRunGuide(pool, owner, folder), expected);
    assert.deepEqual(await getRunGuide(pool, owner, rec), expected);
    const outputTab = first.status === "created" ? first.run.steps[0]!.pageId : "";
    assert.deepEqual(await getRunGuide(pool, owner, outputTab), expected);
    // フォルダの外のページ・他人・ゴミ箱のフォルダ・形の悪い id は null
    const note = await store.createPage(owner, { title: "合成のメモ" });
    assert.equal(await getRunGuide(pool, owner, note.id), null);
    assert.equal(await getRunGuide(pool, "synthetic-other-owner", rec), null);
    assert.equal(await getRunGuide(pool, owner, "not-a-page-id"), null);
    assert.equal(await store.deletePage(owner, folder), "deleted");
    assert.equal(await getRunGuide(pool, owner, folder), null);
  });

  it("pins the folder/recipe design across runs and changes it only on explicit update", async () => {
    const owner = "synthetic-snapshot-owner";
    const old = { ...RECIPE, revision: 1, name: "Old design", guide: "Old guide", steps: RECIPE.steps.map((step) => ({ ...step, profile: "standard" })) };
    await pool.query("INSERT INTO recipes(owner,id,name,guide,steps) VALUES($1,$2,$3,$4,$5::jsonb)", [owner, old.id, old.name, old.guide, JSON.stringify(old.steps)]);
    const { folder, rec } = await folderWithRecording(owner);
    const first = await createRun(pool, owner, folder, { recipe: old, inputTab: rec, toStep: LAST });
    assert.equal(first.status, "created");
    if (first.status !== "created") return;
    assert.equal(first.run.recipeSnapshot.steps[0]?.profile, "standard");
    await cancelRun(pool, owner, folder, first.run.id);
    const fresh = { ...old, revision: 2, name: "New design", steps: old.steps.map((step, index) => index === 0 ? { ...step, name: "New step", instruction: "New instruction", profile: "light" } : step) };
    await pool.query("UPDATE recipes SET name=$3,steps=$4::jsonb,revision=2 WHERE owner=$1 AND id=$2", [owner, old.id, fresh.name, JSON.stringify(fresh.steps)]);
    assert.deepEqual(await createRun(pool, owner, folder, { recipe: old, inputTab: rec, toStep: LAST }), { status: "recipe_changed" });
    const rerun = await createRun(pool, owner, folder, { recipe: fresh, inputTab: rec, toStep: LAST });
    assert.equal(rerun.status, "created");
    if (rerun.status !== "created") return;
    assert.equal(rerun.run.recipeRevision, 1);
    assert.equal(rerun.run.recipeSnapshot.steps[0]?.name, old.steps[0]?.name);
    await cancelRun(pool, owner, folder, rerun.run.id);
    const updated = await updateRunRecipeSnapshot(pool, owner, folder, rerun.run.id, fresh, 1);
    assert.equal(updated.status, "updated");
    if (updated.status !== "updated") return;
    assert.equal(updated.run.recipeRevision, 2);
    assert.equal(updated.run.recipeSnapshot.steps[0]?.profile, "light");
    const next = await createRun(pool, owner, folder, { recipe: fresh, inputTab: rec, toStep: LAST });
    assert.equal(next.status, "created");
    if (next.status === "created") assert.equal(next.run.recipeSnapshot.steps[0]?.name, "New step");
  });

  it("invalidates every prior result when the accepted recipe changes step order", async () => {
    const owner = "synthetic-reordered-recipe-owner";
    const original = { ...RECIPE, revision: 1, name: RECIPE.id, guide: "", steps: RECIPE.steps.map((step) => ({ ...step, profile: "standard" })) };
    await pool.query("INSERT INTO recipes(owner,id,name,steps) VALUES($1,$2,$3,$4::jsonb)", [owner, original.id, original.name ?? original.id, JSON.stringify(original.steps)]);
    const { folder, rec } = await folderWithRecording(owner);
    const started = await createRun(pool, owner, folder, { recipe: original, inputTab: rec, toStep: LAST });
    assert.equal(started.status, "created");
    if (started.status !== "created") return;
    for (const step of started.run.steps) {
      const claim = await claimed(started.run.id, step.index);
      const input = await readStepInput(pool, claim);
      assert.ok(input);
      assert.ok((await commitAttempt(pool, { ...refOf(claim), blocks: paragraph(`結果 ${step.index}`), inputBasis: computeStepBasis(original, step.index, input) })).ok);
    }

    const reordered = { ...original, revision: 2, steps: [original.steps[1]!, original.steps[0]!, original.steps[2]!] };
    await pool.query("UPDATE recipes SET steps=$3::jsonb,revision=2 WHERE owner=$1 AND id=$2", [owner, original.id, JSON.stringify(reordered.steps)]);
    const updated = await updateRunRecipeSnapshot(pool, owner, folder, started.run.id, reordered, 1);
    assert.equal(updated.status, "updated");
    if (updated.status !== "updated") return;
    assert.deepEqual(
      updated.run.steps.map((step) => step.pageId),
      [started.run.steps[1]!.pageId, started.run.steps[0]!.pageId, started.run.steps[2]!.pageId],
      "artifact tabs follow stable step IDs across reordering",
    );
    assert.equal(await refreshStale(pool, owner, folder, {
      id: reordered.id, name: reordered.name, guide: reordered.guide,
      steps: reordered.steps, terms: [], samples: [],
    }), RECIPE.steps.length);
    const listed = await listRun(pool, owner, folder);
    assert.deepEqual(listed?.run?.steps.map((step) => step.stepStatus), ["stale", "stale", "stale"]);
  });

  it("refuses a second run in the same folder while one is in progress, even when many arrive at once", async () => {
    const { folder, rec } = await folderWithRecording();
    await created(folder, rec);
    assert.deepEqual(await createRun(pool, OWNER, folder, { recipe: RECIPE, inputTab: rec, toStep: LAST }), { status: "run_in_progress" });

    const fresh = await folderWithRecording();
    const results = await Promise.all(Array.from({ length: 10 }, () => createRun(pool, OWNER, fresh.folder, { recipe: RECIPE, inputTab: fresh.rec, toStep: LAST })));
    assert.equal(results.filter((result) => result.status === "created").length, 1);
    assert.equal(results.filter((result) => result.status === "run_in_progress").length, 9);
    const count = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM step_runs WHERE parent = $1", [fresh.folder]);
    assert.equal(count.rows[0]?.n, "1");
    // 負けた要求は出力のタブも入れ物も残さない
    const holders = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM pages WHERE parent = $1 AND kind = 'page' AND role IS NOT NULL", [fresh.folder]);
    assert.equal(holders.rows[0]?.n, String(RECIPE.steps.length));
  });

  it("returns the same run for the same Idempotency-Key, also when the retries race", async () => {
    const { folder, rec } = await folderWithRecording();
    const key = `synthetic-${randomUUID()}`;
    const first = await created(folder, rec, { idempotencyKey: key });
    const again = await createRun(pool, OWNER, folder, { recipe: RECIPE, inputTab: rec, toStep: LAST, idempotencyKey: key });
    assert.equal(again.status, "existing");
    assert.equal(again.status === "existing" ? again.run.id : null, first.id);

    const racing = await folderWithRecording();
    const raceKey = `synthetic-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 6 }, () => createRun(pool, OWNER, racing.folder, { recipe: RECIPE, inputTab: racing.rec, toStep: LAST, idempotencyKey: raceKey })));
    assert.equal(results.filter((result) => result.status === "created").length, 1);
    const ids = new Set(results.map((result) => (result.status === "created" || result.status === "existing" ? result.run.id : result.status)));
    assert.equal(ids.size, 1, "every retry sees the one run");
  });

  it("refuses folders and inputs that are not the owner's live folder and a tab in it", async () => {
    const note = (await store.createPage(OWNER, { kind: "note" })).id;
    const theirs = await folderWithRecording(OTHER);
    const removed = await folderWithRecording();
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [removed.folder]);
    const { folder, rec } = await folderWithRecording();
    for (const [parent, input] of [[note, note], [theirs.folder, theirs.rec], [removed.folder, removed.rec], [randomUUID(), rec], [folder, note], [folder, theirs.rec], [folder, randomUUID()], [folder, folder]]) {
      assert.deepEqual(await createRun(pool, OWNER, parent!, { recipe: RECIPE, inputTab: input!, toStep: LAST }), { status: "not_found" }, `${parent} / ${input}`);
    }
    const count = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM step_runs WHERE owner = $1 AND parent = ANY($2::uuid[])", [OWNER, [note, theirs.folder, removed.folder, folder]]);
    assert.equal(count.rows[0]?.n, "0");
  });

  it("claims a queued attempt exactly once under 20 concurrent claims and advances the generation", async () => {
    const { folder, rec } = await folderWithRecording();
    const run = await created(folder, rec);
    const results = await Promise.all(Array.from({ length: 20 }, () => claimAttempt(pool, run.id, 0)));
    const winners = results.filter((result) => result.ok);
    assert.equal(winners.length, 1);
    for (const result of results) if (!result.ok) assert.equal(result.reason, "not_queued");
    const winner = winners[0];
    assert.ok(winner?.ok);
    assert.equal(winner.claim.generation, 1);
    assert.equal(winner.claim.tries, 1);
    assert.equal(winner.claim.owner, OWNER);
    assert.equal(winner.claim.parentId, folder);
    assert.equal(winner.claim.inputTabId, rec);
    assert.equal(winner.claim.previousPageId, null);
    assert.deepEqual(winner.claim.upstreamPageIds, []);

    const attempt = await attemptRow(run.id, 0);
    assert.equal(attempt?.state, "running");
    assert.ok(attempt?.lease_until && attempt.lease_until.getTime() > Date.now());
    assert.equal((await pageRow(run.steps[0]!.pageId))?.step_status, "run");
    assert.equal((await runRow(run.id))?.state, "running");

    // 前の段階が済んでいなければ、次の段階は claim できない
    assert.deepEqual(await claimAttempt(pool, run.id, 1), { ok: false, reason: "not_queued" });
    await pool.query("UPDATE step_attempts SET state = 'queued' WHERE run_id = $1 AND step_index = 1", [run.id]);
    assert.deepEqual(await claimAttempt(pool, run.id, 1), { ok: false, reason: "superseded" });
    await pool.query("UPDATE step_attempts SET state = 'pending' WHERE run_id = $1 AND step_index = 1", [run.id]);
    assert.deepEqual(await claimAttempt(pool, run.id, 9), { ok: false, reason: "not_queued" });
  });

  it("gives a run that starts at a later step its input tab as the previous page and the upstream artifact", async () => {
    const { folder, rec } = await folderWithRecording();
    const first = await created(folder, rec, { toStep: 0 });
    await completeAll(first);
    const tab0 = first.steps[0]!.pageId;
    const next = await created(folder, tab0);
    const claim = await claimed(next.id, 1);
    assert.equal(claim.previousPageId, tab0);
    assert.deepEqual(claim.upstreamPageIds, [{ id: RECIPE.steps[0]!.id, pageId: tab0 }]);
    const input = await readStepInput(pool, claim);
    assert.deepEqual(input?.previousBlocks, paragraph("合成の結果 0"));
    assert.deepEqual(input?.parentBlocks, TRANSCRIPT, "the source is the root of the input's lineage (the recording)");
    assert.deepEqual(input?.upstream, [{ id: RECIPE.steps[0]!.id, blocks: paragraph("合成の結果 0") }]);
    assert.ok(input);
    assert.ok((await commitAttempt(pool, { ...refOf(claim), blocks: paragraph("合成の結果 1"), inputBasis: computeStepBasis(RECIPE, 1, input) })).ok);
    const last = await claimed(next.id, 2);
    assert.equal(last.previousPageId, next.steps[0]!.pageId);
    assert.deepEqual(last.upstreamPageIds.map((item) => item.pageId), [tab0, next.steps[0]!.pageId]);
  });

  it("keeps the used input chars of a cut source on the committed step only, and clears them on the next claim (#277)", async () => {
    const { folder, rec } = await folderWithRecording();
    const run = await created(folder, rec);
    const first = await claimed(run.id, 0);
    const input = await readStepInput(pool, first);
    assert.ok(input);
    await assert.rejects(
      commitAttempt(pool, { ...refOf(first), blocks: paragraph("x"), inputBasis: computeStepBasis(RECIPE, 0, input), inputUsedChars: -1 }),
      TypeError,
    );
    assert.deepEqual(
      await commitAttempt(pool, { ...refOf(first), blocks: paragraph("切った結果"), inputBasis: computeStepBasis(RECIPE, 0, input), inputUsedChars: 100_000 }),
      { ok: true, next: 1 },
    );
    const view = (await listRun(pool, OWNER, folder))?.run;
    assert.equal(view?.steps[0]?.inputUsedChars, 100_000);
    assert.equal("inputUsedChars" in (view?.steps[1] ?? {}), false, "a step that was not cut (or not run) carries nothing");
    await complete(run.id, 1);
    await complete(run.id, 2);
    assert.equal("inputUsedChars" in ((await listRun(pool, OWNER, folder))?.run?.steps[1] ?? {}), false);

    const again = await createRun(pool, OWNER, folder, { recipe: RECIPE, regenerate: run.steps[0]!.pageId });
    assert.ok(again.status === "created");
    await claimed(again.run.id, 0);
    assert.equal((await pool.query<{ input_used_chars: number | null }>("SELECT input_used_chars FROM step_attempts WHERE run_id = $1 AND step_index = 0", [again.run.id])).rows[0]?.input_used_chars, null);
    assert.equal("inputUsedChars" in ((await listRun(pool, OWNER, folder))?.run?.steps[0] ?? {}), false, "a running step shows nothing");
  });

  it("commits only with the current generation, then queues the next step and finishes the run on the last step", async () => {
    const { folder, rec } = await folderWithRecording();
    const run = await created(folder, rec);
    const claim = await claimed(run.id, 0);
    const basis = computeBasis(TRANSCRIPT, RECIPE.steps[0]!.instruction);

    const stale = await commitAttempt(pool, { ...refOf(claim), generation: claim.generation - 1, blocks: paragraph("古い結果"), inputBasis: basis });
    assert.deepEqual(stale, { ok: false, reason: "stale_generation" });
    assert.deepEqual((await pageRow(claim.pageId))?.blocks, [], "a stale commit writes nothing");
    assert.equal((await attemptRow(run.id, 0))?.state, "running");

    assert.deepEqual(await commitAttempt(pool, { ...refOf(claim), blocks: paragraph("合成の結果 0"), inputBasis: basis }), { ok: true, next: 1 });
    const page = await pageRow(claim.pageId);
    assert.equal(page?.step_status, "done");
    assert.deepEqual(page?.blocks, paragraph("合成の結果 0"));
    const attempt = await attemptRow(run.id, 0);
    assert.equal(attempt?.state, "succeeded");
    assert.equal(attempt?.input_basis, basis);
    assert.equal(attempt?.input_basis_v2, null);
    assert.equal(attempt?.lease_until, null);
    assert.equal((await attemptRow(run.id, 1))?.state, "queued");
    assert.deepEqual(await commitAttempt(pool, { ...refOf(claim), blocks: paragraph("二度目"), inputBasis: basis }), { ok: false, reason: "stale_generation" });

    const second = await complete(run.id, 1);
    assert.equal(second.claim.previousPageId, claim.pageId);
    assert.equal(second.next, 2);
    assert.equal((await complete(run.id, 2)).next, null);
    const finished = await runRow(run.id);
    assert.equal(finished?.state, "succeeded");
    assert.ok(finished?.finished_at);
    const view = (await listRun(pool, OWNER, folder))?.run;
    assert.deepEqual(view?.steps.map((step) => [step.state, step.stepStatus]), [["succeeded", "done"], ["succeeded", "done"], ["succeeded", "done"]]);
  });

  it("does not commit into an output tab that was deleted while the step ran", async () => {
    const { folder, rec } = await folderWithRecording();
    const run = await created(folder, rec);
    const claim = await claimed(run.id, 0);
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [claim.pageId]);
    const result = await commitAttempt(pool, { ...refOf(claim), blocks: paragraph("x"), inputBasis: computeBasis(TRANSCRIPT, RECIPE.steps[0]!.instruction) });
    assert.deepEqual(result, { ok: false, reason: "page_missing" });
    assert.equal((await attemptRow(run.id, 0))?.state, "running", "nothing was written");
  });

  it("retries a retryable failure until MAX_TRIES, then fails the run and cancels the rest", async () => {
    const { folder, rec } = await folderWithRecording();
    const run = await created(folder, rec);
    await complete(run.id, 0);
    for (let tries = 1; tries < MAX_TRIES; tries++) {
      const claim = await claimed(run.id, 1);
      assert.equal(claim.tries, tries);
      assert.equal(claim.generation, tries);
      const result = await failAttempt(pool, { ...refOf(claim), code: "model_timeout", retryable: true });
      assert.deepEqual(result, { ok: true, outcome: "retry", generation: tries, tries });
      const attempt = await attemptRow(run.id, 1);
      assert.equal(attempt?.state, "queued");
      assert.equal(attempt?.lease_until, null);
      assert.equal((await pageRow(claim.pageId))?.step_status, "wait");
      // 古い世代の失敗は通らない
      assert.deepEqual(await failAttempt(pool, { ...refOf(claim), code: "model_timeout", retryable: true }), { ok: false, reason: "stale_generation" });
    }
    const last = await claimed(run.id, 1);
    assert.equal(last.tries, MAX_TRIES);
    assert.deepEqual(await failAttempt(pool, { ...refOf(last), code: "model_timeout", retryable: true }), { ok: true, outcome: "failed" });

    const view = (await listRun(pool, OWNER, folder))?.run;
    assert.equal(view?.state, "failed");
    assert.deepEqual(view?.steps.map((step) => [step.state, step.stepStatus, step.errorCode]), [
      ["succeeded", "done", null],
      ["failed", "failed", "model_timeout"],
      ["canceled", "wait", null],
    ]);
    assert.ok((await runRow(run.id))?.finished_at);
    assert.deepEqual((await pageRow(run.steps[0]!.pageId))?.blocks, paragraph("合成の結果 0"), "the upstream result is kept");
  });

  it("書き切れなかったときは、書けたところまでを残す（出力のタブの本文には書かない。#37）", async () => {
    const { folder, rec } = await folderWithRecording();
    const run = await created(folder, rec);
    const claim = await claimed(run.id, 0);
    const partial = paragraph("書けたところまで");
    assert.deepEqual(
      await failAttempt(pool, { ...refOf(claim), code: "output_too_long", retryable: false, partial }),
      { ok: true, outcome: "failed" },
    );
    const attempt = await attemptRow(run.id, 0);
    assert.equal(attempt?.state, "failed");
    assert.equal(attempt?.error_code, "output_too_long");
    assert.deepEqual(attempt?.partial_blocks, partial);
    // 失敗した段階のタブを半分の本文で埋めない
    assert.deepEqual((await pageRow(claim.pageId))?.blocks, []);
  });

  it("途中出力は本人の最新の失敗 run だけで読み、polling には有無だけを返す", async () => {
    const { folder, rec } = await folderWithRecording();
    const run = await created(folder, rec);
    const claim = await claimed(run.id, 0);
    const partial = paragraph("合成の途中出力");
    await failAttempt(pool, { ...refOf(claim), code: "output_too_long", retryable: false, partial });

    const view = (await listRun(pool, OWNER, folder))?.run;
    assert.equal(view?.steps[0]?.hasPartialOutput, true);
    assert.equal(JSON.stringify(view).includes("合成の途中出力"), false);
    assert.deepEqual(await readPartialOutput(pool, OWNER, folder, run.id, 0), partial);
    assert.equal(await readPartialOutput(pool, OTHER, folder, run.id, 0), null);
    assert.equal(await readPartialOutput(pool, OWNER, randomUUID(), run.id, 0), null);
    assert.equal(await readPartialOutput(pool, OWNER, folder, randomUUID(), 0), null);

    const next = await createRun(pool, OWNER, folder, { recipe: RECIPE, inputTab: rec, toStep: LAST });
    assert.equal(next.status, "created");
    assert.equal(await readPartialOutput(pool, OWNER, folder, run.id, 0), null, "a new run hides older partial output");
  });

  it("積み直すときは書きかけを残さず、次の claim でも消えている", async () => {
    const { folder, rec } = await folderWithRecording();
    const run = await created(folder, rec);
    const first = await claimed(run.id, 0);
    const partial = paragraph("途中");
    // 積み直す失敗では残さない
    assert.deepEqual(await failAttempt(pool, { ...refOf(first), code: "ai_timeout", retryable: true, partial }), {
      ok: true,
      outcome: "retry",
      generation: 1,
      tries: 1,
    });
    assert.equal((await attemptRow(run.id, 0))?.partial_blocks, null);
    // 最後の失敗で残したものは、同じ段階を claim し直すと消える（古い書きかけを残さない）
    const second = await claimed(run.id, 0);
    assert.deepEqual(await failAttempt(pool, { ...refOf(second), code: "output_too_long", retryable: false, partial }), {
      ok: true,
      outcome: "failed",
    });
    assert.deepEqual((await attemptRow(run.id, 0))?.partial_blocks, partial);
  });

  it("fails at once on a non-retryable error", async () => {
    const { folder, rec } = await folderWithRecording();
    const run = await created(folder, rec);
    const claim = await claimed(run.id, 0);
    assert.deepEqual(await failAttempt(pool, { ...refOf(claim), code: "invalid_output", retryable: false }), { ok: true, outcome: "failed" });
    const view = (await listRun(pool, OWNER, folder))?.run;
    assert.equal(view?.state, "failed");
    assert.deepEqual(view?.steps.map((step) => [step.state, step.tries]), [["failed", 1], ["canceled", 0], ["canceled", 0]]);
    await assert.rejects(() => failAttempt(pool, { ...refOf(claim), code: "Not A Code", retryable: false }), TypeError);
  });

  it("cancels idempotently, advances the running generation so a late result is refused, and keeps completed tabs", async () => {
    const { folder, rec } = await folderWithRecording();
    const run = await created(folder, rec);
    await complete(run.id, 0);
    const running = await claimed(run.id, 1);

    const canceled = await cancelRun(pool, OWNER, folder, run.id);
    assert.equal(canceled?.state, "canceled");
    assert.deepEqual(canceled?.steps.map((step) => [step.state, step.stepStatus]), [["succeeded", "done"], ["canceled", "wait"], ["canceled", "wait"]]);
    assert.equal((await attemptRow(run.id, 1))?.generation, running.generation + 1);

    const late = await commitAttempt(pool, { ...refOf(running), blocks: paragraph("遅れた結果"), inputBasis: computeBasis(paragraph("x"), "y") });
    assert.deepEqual(late, { ok: false, reason: "stale_generation" });
    assert.deepEqual((await pageRow(running.pageId))?.blocks, [], "the late result is not written");
    assert.equal(await heartbeatAttempt(pool, refOf(running)), false);
    assert.deepEqual(await failAttempt(pool, { ...refOf(running), code: "internal", retryable: true }), { ok: false, reason: "stale_generation" });
    assert.deepEqual(await claimAttempt(pool, run.id, 1), { ok: false, reason: "run_inactive" });

    assert.deepEqual(await cancelRun(pool, OWNER, folder, run.id), canceled, "cancel is idempotent");
    assert.deepEqual((await pageRow(run.steps[0]!.pageId))?.blocks, paragraph("合成の結果 0"));
    // 取消のあとは新しい run を作れる
    assert.equal((await createRun(pool, OWNER, folder, { recipe: RECIPE, inputTab: rec, toStep: LAST })).status, "created");
    // 別のフォルダの path では取り消せない
    assert.equal(await cancelRun(pool, OWNER, (await folderWithRecording()).folder, run.id), null);
  });

  it("extends the lease on heartbeat only for the current generation", async () => {
    const { folder, rec } = await folderWithRecording();
    const run = await created(folder, rec);
    const claim = (await claimAttempt(pool, run.id, 0, { leaseSeconds: 30 }));
    assert.ok(claim.ok);
    const before = (await attemptRow(run.id, 0))?.lease_until?.getTime() ?? 0;
    assert.equal(await heartbeatAttempt(pool, refOf(claim.claim), { leaseSeconds: 600 }), true);
    const after = (await attemptRow(run.id, 0))?.lease_until?.getTime() ?? 0;
    assert.ok(after - before > 500_000, "the lease was extended");
    assert.equal(await heartbeatAttempt(pool, { ...refOf(claim.claim), generation: claim.claim.generation + 1 }), false);
  });

  it("sweeps expired leases back to the queue, and to failed (lease_expired) after MAX_TRIES", async () => {
    const { folder, rec } = await folderWithRecording();
    const run = await created(folder, rec);
    const expire = () => pool.query("UPDATE step_attempts SET lease_until = clock_timestamp() - interval '1 second' WHERE run_id = $1 AND state = 'running'", [run.id]);

    const live = await folderWithRecording();
    const liveRun = await created(live.folder, live.rec);
    await claimed(liveRun.id, 0);

    for (let tries = 1; tries < MAX_TRIES; tries++) {
      const claim = await claimed(run.id, 0);
      await expire();
      const swept = await sweepExpiredLeases(pool);
      assert.deepEqual(swept.filter((ref) => ref.runId === run.id), [refOf(claim)]);
      assert.ok(!swept.some((ref) => ref.runId === liveRun.id), "a live lease is not touched");
      const attempt = await attemptRow(run.id, 0);
      assert.equal(attempt?.state, "queued");
      assert.equal(attempt?.error_code, "lease_expired");
      assert.equal((await pageRow(claim.pageId))?.step_status, "wait");
      assert.equal(await heartbeatAttempt(pool, refOf(claim)), false, "the stalled worker lost its lease");
    }
    const last = await claimed(run.id, 0);
    assert.equal(last.tries, MAX_TRIES);
    await expire();
    assert.deepEqual((await sweepExpiredLeases(pool)).filter((ref) => ref.runId === run.id), []);
    const view = (await listRun(pool, OWNER, folder))?.run;
    assert.equal(view?.state, "failed");
    assert.deepEqual(view?.steps.map((step) => [step.state, step.stepStatus, step.errorCode]), [
      ["failed", "failed", "lease_expired"],
      ["canceled", "wait", null],
      ["canceled", "wait", null],
    ]);
    assert.equal((await attemptRow(liveRun.id, 0))?.state, "running");
  });

  it("marks downstream tabs stale when an upstream tab or the input changes, and done again when it is restored", async () => {
    const { folder, rec } = await folderWithRecording();
    const run = await created(folder, rec);
    await completeAll(run);
    const [first, second, third] = run.steps.map((step) => step.pageId) as [string, string, string];
    const statuses = async () => Promise.all([first, second, third].map(async (id) => (await pageRow(id))?.step_status));

    assert.equal(await refreshStale(pool, OWNER, folder, RECIPE), 0);
    assert.deepEqual(await statuses(), ["done", "done", "done"]);

    await userEdit(OWNER, first, paragraph("直した結果 0"));
    assert.equal(await refreshStale(pool, OWNER, folder, RECIPE), 2);
    assert.deepEqual(await statuses(), ["done", "stale", "stale"]);
    assert.equal((await listRun(pool, OWNER, folder))?.run?.steps[1]?.stepStatus, "stale");
    await userEdit(OWNER, first, paragraph("合成の結果 0"));
    assert.equal(await refreshStale(pool, OWNER, folder, RECIPE), 2);
    assert.deepEqual(await statuses(), ["done", "done", "done"]);

    await userEdit(OWNER, rec, paragraph("直した文字起こし"));
    await refreshStale(pool, OWNER, folder, RECIPE);
    assert.deepEqual(await statuses(), ["stale", "stale", "stale"]);
    await userEdit(OWNER, rec, TRANSCRIPT);
    await refreshStale(pool, OWNER, folder, RECIPE);
    assert.deepEqual(await statuses(), ["done", "done", "done"]);

    await userEdit(OWNER, second, paragraph("直した結果 1"));
    await refreshStale(pool, OWNER, folder, RECIPE);
    assert.deepEqual(await statuses(), ["done", "done", "stale"]);
    // 前提が変わった段階を作り直すと、新しい基準が記録されて印が消える（最新 run の分だけを見る）
    const rerun = await createRun(pool, OWNER, folder, { recipe: RECIPE, regenerate: third });
    assert.ok(rerun.status === "created");
    await completeAll(rerun.run);
    await refreshStale(pool, OWNER, folder, RECIPE);
    assert.equal((await pageRow(third))?.step_status, "done");
  });

  it("uses an empty background when the recording has no fields of its own, and the recording's transcript as the source", async () => {
    const { folder, rec } = await folderWithRecording();
    const input = await readStepInput(pool, { owner: OWNER, parentId: folder, inputTabId: rec, previousPageId: null });
    assert.deepEqual(input?.parentBlocks, TRANSCRIPT);
    assert.equal(input?.background, "");
    assert.deepEqual(input?.fields, { entities: [], terms: [] });
    assert.deepEqual(input?.refs, []);
    // 文字起こしの段落があれば、本文の代わりに「[分:秒] 話者: 文」の段落
    await pool.query(
      "INSERT INTO page_recordings (page_id, owner, source, language, engine, segments, speaker_names) VALUES ($1, $2, 'vtt', 'ja', 'fake', $3::jsonb, $4::jsonb)",
      [rec, OWNER, JSON.stringify([{ start: 65, end: 70, text: "おはようございます", speaker: 1 }, { start: null, end: null, text: "話者なし", speaker: null }]), JSON.stringify({ "1": "合成の話し手" })],
    );
    const withSegments = await readStepInput(pool, { owner: OWNER, parentId: folder, inputTabId: rec, previousPageId: null });
    assert.deepEqual(withSegments?.parentBlocks, [...paragraph("[1:05] 合成の話し手: おはようございます"), ...paragraph("話者なし")]);
  });

  it("reads all upstream, the recording's own fields, settings and ordered references; explains each changed input", async () => {
    const { folder, rec } = await folderWithRecording();
    const reference = (await store.createPage(OWNER, { title: "初期の題名", blocks: paragraph("参考本文"), parent: folder }))!.id;
    // 欄は録音のタブ自身の id で持つ（フォルダの id の行は読まない）
    await pool.query("INSERT INTO page_fields(owner,page_id,entities,background) VALUES ($1,$2,$3::jsonb,'合成の背景情報')", [OWNER, rec, JSON.stringify([{ name: "合成人物", reading: "", role: "取材相手", note: "" }])]);
    await pool.query("INSERT INTO page_fields(owner,page_id,entities,background) VALUES ($1,$2,$3::jsonb,'フォルダの古い背景')", [OWNER, folder, JSON.stringify([{ name: "フォルダの人物", reading: "", role: "", note: "" }])]);
    await pool.query("INSERT INTO editor_settings(owner,ai_lang,about) VALUES ($1,'en','合成の説明') ON CONFLICT(owner) DO UPDATE SET ai_lang = 'en', about = '合成の説明'", [OWNER]);
    const run = await created(folder, rec);
    await completeAll(run);
    const claim = { owner: OWNER, parentId: folder, inputTabId: rec, previousPageId: run.steps[1]!.pageId, upstreamPageIds: run.steps.slice(0, 2).map((step) => ({ id: step.stepId, pageId: step.pageId })) };
    const input = await readStepInput(pool, claim);
    assert.deepEqual(input?.upstream.map((item) => item.id), ["aaaa1111", "bbbb2222"]);
    assert.deepEqual(input?.parentBlocks, TRANSCRIPT);
    assert.equal(input?.background, "合成の背景情報");
    // 参考は同じフォルダの役割の無いページのタブ（段階の出力・入力の系譜・録音は入れない）
    assert.deepEqual(input?.refs.map((item) => item.id), [reference]);
    assert.equal(input?.fields.entities[0]?.name, "合成人物");
    assert.equal(input?.settings.aiLang, "en");
    assert.deepEqual((await readStepStaleReasons(pool, OWNER, folder, RECIPE))[2], []);

    await pool.query("UPDATE page_fields SET background = '変更した合成の背景情報' WHERE owner = $1 AND page_id = $2", [OWNER, rec]);
    assert.equal(await refreshStale(pool, OWNER, folder, RECIPE), 3);
    assert.deepEqual((await readStepStaleReasons(pool, OWNER, folder, RECIPE))[2], ["info"]);
    await pool.query("UPDATE page_fields SET background = '合成の背景情報' WHERE owner = $1 AND page_id = $2", [OWNER, rec]);
    assert.equal(await refreshStale(pool, OWNER, folder, RECIPE), 3);
    assert.deepEqual((await readStepStaleReasons(pool, OWNER, folder, RECIPE))[2], []);

    await pool.query("UPDATE pages SET title = '新しい題名' WHERE id = $1", [reference]);
    assert.equal(await refreshStale(pool, OWNER, folder, RECIPE), 0);
    await userEdit(OWNER, reference, paragraph("変更した参考本文"));
    assert.equal(await refreshStale(pool, OWNER, folder, RECIPE), 3);
    assert.deepEqual((await readStepStaleReasons(pool, OWNER, folder, RECIPE))[2], ["refs"]);
    await userEdit(OWNER, reference, paragraph("参考本文"));
    await refreshStale(pool, OWNER, folder, RECIPE);
    await pool.query("UPDATE page_fields SET terms = $3::jsonb WHERE owner = $1 AND page_id = $2", [OWNER, rec, JSON.stringify([{ term: "合成語", reading: "", variants: [], note: "" }])]);
    await refreshStale(pool, OWNER, folder, RECIPE);
    assert.deepEqual((await readStepStaleReasons(pool, OWNER, folder, RECIPE))[2], ["info"]);
    await pool.query("UPDATE page_fields SET terms = '[]'::jsonb WHERE owner = $1 AND page_id = $2", [OWNER, rec]);
    await pool.query("UPDATE editor_settings SET about = '変更' WHERE owner = $1", [OWNER]);
    await refreshStale(pool, OWNER, folder, RECIPE);
    assert.deepEqual((await readStepStaleReasons(pool, OWNER, folder, RECIPE))[2], ["info"]);
    await pool.query("UPDATE editor_settings SET about = '合成の説明' WHERE owner = $1", [OWNER]);
    const guide = { ...RECIPE, guide: "変更したガイド" };
    assert.deepEqual((await readStepStaleReasons(pool, OWNER, folder, guide))[2], ["guide"]);
    const instruction = { ...RECIPE, steps: RECIPE.steps.map((step, index) => index === 1 ? { ...step, instruction: "変更した指示" } : step) };
    assert.deepEqual((await readStepStaleReasons(pool, OWNER, folder, instruction))[2], ["step"]);
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [run.steps[0]!.pageId]);
    const afterDelete = await readStepInput(pool, claim);
    assert.deepEqual(afterDelete?.upstream[0]?.blocks, []);
    // 入力のタブが消えていれば読めない
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [rec]);
    assert.equal(await readStepInput(pool, claim), null);
  });

  it("treats a legacy digest as unrecorded after the jsonb migration", async () => {
    const { folder, rec } = await folderWithRecording();
    const run = await created(folder, rec);
    const claim = await claimed(run.id, 0);
    assert.deepEqual(await commitAttempt(pool, { ...refOf(claim), blocks: paragraph("旧版の結果"), inputBasis: "a".repeat(64) }), { ok: true, next: 1 });
    await userEdit(OWNER, rec, paragraph("変更した原文"));
    assert.equal(await refreshStale(pool, OWNER, folder, RECIPE), 0);
    assert.deepEqual((await readStepStaleReasons(pool, OWNER, folder, RECIPE))[0], []);
  });

  it("guards the refresh's write with the row version (xmin), so a row changed after the read is not overwritten", async () => {
    const { folder, rec } = await folderWithRecording();
    const run = await created(folder, rec);
    await completeAll(run);
    const second = run.steps[1]!.pageId;
    await userEdit(OWNER, run.steps[0]!.pageId, paragraph("直した結果 0"));
    // refresh が読んだ後に行が変わった場合と同じ条件（xmin が違う）で書こうとしても通らない
    const before = await pool.query<{ version: string }>("SELECT xmin::text AS version FROM pages WHERE id = $1", [second]);
    await pool.query("UPDATE pages SET step_status = 'done' WHERE id = $1", [second]);
    const write = await pool.query(
      "UPDATE pages SET step_status = 'stale' WHERE owner = $1 AND id = $2 AND step_status = 'done' AND xmin::text = $3",
      [OWNER, second, before.rows[0]?.version],
    );
    assert.equal(write.rowCount, 0);
  });

  it("keeps runs of another owner out of reach", async () => {
    const { folder, rec } = await folderWithRecording();
    const run = await created(folder, rec);
    await complete(run.id, 0);
    await userEdit(OWNER, rec, paragraph("直した文字起こし"));

    assert.equal(await listRun(pool, OTHER, folder), null);
    assert.equal(await cancelRun(pool, OTHER, folder, run.id), null);
    assert.deepEqual(await createRun(pool, OTHER, folder, { recipe: RECIPE, inputTab: rec, toStep: LAST }), { status: "not_found" });
    assert.equal(await refreshStale(pool, OTHER, folder, RECIPE), 0);
    assert.equal(await readFlow(pool, OTHER, folder), null);
    assert.equal((await pageRow(run.steps[0]!.pageId))?.step_status, "done", "another owner's refresh changes nothing");
    assert.equal(await readStepInput(pool, { owner: OTHER, parentId: folder, inputTabId: rec, previousPageId: null }), null);
    assert.equal((await runRow(run.id))?.state, "running");
  });

  it("bumps the revision when a step writes the tab, so a stale save from the user becomes a conflict (#58)", async () => {
    const { folder, rec } = await folderWithRecording();
    const run = await created(folder, rec);
    const tab = run.steps[0]!.pageId;
    const before = await store.getPage(OWNER, tab);
    assert.ok(before);
    await complete(run.id, 0);
    const after = await store.getPage(OWNER, tab);
    assert.equal(after?.revision, before.revision + 1);
    // 利用者が結果を見る前の revision のまま保存しても、worker の結果を黙って上書きしない
    const stale = await store.savePage(OWNER, tab, { blocks: paragraph("利用者の古い画面からの保存") }, { baseRevision: before.revision });
    assert.equal(stale?.status, "conflict");
    assert.deepEqual((await store.getPage(OWNER, tab))?.blocks, paragraph("合成の結果 0"));
  });

  it("keeps the body it replaces as an ai version when a rerun overwrites a tab, but not on the first generation", async () => {
    const { folder, rec } = await folderWithRecording();
    const first = await created(folder, rec);
    const tab = first.steps[0]!.pageId;
    const versions = async () =>
      (await pool.query<{ version: number; reason: string; blocks: Block[] }>("SELECT version, reason, blocks FROM page_versions WHERE page_id = $1 ORDER BY version", [tab])).rows;
    await completeAll(first);
    assert.deepEqual(await versions(), [], "the first generation replaces an empty body: nothing to keep");

    // 利用者がタブを直してから、その段階を作り直す
    await userEdit(OWNER, tab, paragraph("利用者が直した内容"));
    const rerun = await createRun(pool, OWNER, folder, { recipe: RECIPE, regenerate: tab });
    assert.ok(rerun.status === "created");
    await complete(rerun.run.id, 0, "作り直した結果");
    // 利用者の保存（#58 の savePage）が残す autosave の版とは別に、作り直しが ai の版を 1 つ残す
    const kept = (await versions()).filter((version) => version.reason === "ai");
    assert.equal(kept.length, 1);
    assert.deepEqual(kept[0]?.blocks, paragraph("利用者が直した内容"), "the user's edit survives in the history");
    assert.deepEqual((await store.getPage(OWNER, tab))?.blocks, paragraph("作り直した結果"));
  });

  it("lets pages that carry step records be hard-deleted (the trash purge), taking the records with them", async () => {
    const { folder, rec } = await folderWithRecording();
    const run = await created(folder, rec);
    await complete(run.id, 0);
    const count = async (sql: string, id: string) => Number((await pool.query<{ n: string }>(sql, [id])).rows[0]?.n);
    assert.equal(await count("SELECT count(*)::text AS n FROM step_attempts WHERE run_id = $1", run.id), 3);

    // 出力のタブを消す: その段階の記録も消える。外部キーで止まらない
    await pool.query("DELETE FROM pages WHERE id = ANY($1::uuid[])", [run.steps.map((step) => step.pageId)]);
    assert.equal(await count("SELECT count(*)::text AS n FROM step_attempts WHERE run_id = $1", run.id), 0);
    assert.equal(await count("SELECT count(*)::text AS n FROM step_runs WHERE id = $1", run.id), 1);

    // フォルダを消す: run も一緒に消える
    await pool.query("DELETE FROM pages WHERE parent = $1", [folder]);
    await pool.query("DELETE FROM pages WHERE id = $1", [folder]);
    assert.equal(await count("SELECT count(*)::text AS n FROM step_runs WHERE id = $1", run.id), 0);
  });

  it("keeps the step tables' invariants even when the functions are bypassed", async () => {
    const { folder, rec } = await folderWithRecording();
    const run = await created(folder, rec);
    const theirs = await folderWithRecording(OTHER);
    await assert.rejects(() => pool.query("INSERT INTO step_runs (owner, parent, recipe, recipe_snapshot, recipe_revision) VALUES ($1, $2, 'tpl-1', '{}'::jsonb, 1)", [OWNER, theirs.folder]), { code: "23503" });
    await assert.rejects(() => pool.query("UPDATE step_runs SET state = 'paused' WHERE id = $1", [run.id]), { code: "23514" });
    await assert.rejects(() => pool.query("UPDATE step_runs SET idempotency_key = $2 WHERE id = $1", [run.id, "k".repeat(129)]), { code: "23514" });
    await assert.rejects(() => pool.query("UPDATE step_runs SET input_revision = -1 WHERE id = $1", [run.id]), { code: "23514" });
    await assert.rejects(() => pool.query("UPDATE step_attempts SET error_code = 'Message: secret' WHERE run_id = $1", [run.id]), { code: "23514" });
    const legacyBasis = "a".repeat(64);
    await pool.query("UPDATE step_attempts SET input_basis = $2 WHERE run_id = $1 AND step_index = 0", [run.id, legacyBasis]);
    const structuredBasis = JSON.stringify({ source: legacyBasis, artifacts: {}, refs: legacyBasis, info: legacyBasis, guide: legacyBasis, step: legacyBasis });
    await pool.query("UPDATE step_attempts SET input_basis_v2 = $2::jsonb WHERE run_id = $1 AND step_index = 0", [run.id, structuredBasis]);
    await pool.query("UPDATE step_attempts SET state = 'running', lease_until = clock_timestamp() WHERE run_id = $1 AND step_index = 0", [run.id]);
    assert.equal((await attemptRow(run.id, 0))?.input_basis_v2, null, "an old worker's retry clears only the new structured basis");
    await pool.query("UPDATE step_attempts SET state = 'succeeded', input_basis = $2, lease_until = NULL, finished_at = clock_timestamp() WHERE run_id = $1 AND step_index = 0", [run.id, legacyBasis]);
    await assert.rejects(() => pool.query("UPDATE step_attempts SET input_basis_v2 = '\"abc\"'::jsonb WHERE run_id = $1", [run.id]), { code: "23514" });
    await assert.rejects(() => pool.query("UPDATE step_attempts SET input_basis_v2 = '{\"source\":\"abc\"}'::jsonb WHERE run_id = $1", [run.id]), { code: "23514" });
    await assert.rejects(() => pool.query("UPDATE step_attempts SET input_basis = 'not-a-digest' WHERE run_id = $1", [run.id]), { code: "23514" });
    await assert.rejects(() => pool.query("UPDATE step_attempts SET state = 'running', lease_until = NULL WHERE run_id = $1 AND step_index = 0", [run.id]), { code: "23514" });
    // 実行中の attempt は run あたり 1 つまで
    await assert.rejects(
      () => pool.query("UPDATE step_attempts SET state = 'running', lease_until = clock_timestamp() WHERE run_id = $1", [run.id]),
      { code: "23505" },
    );
    assert.ok(rec);
  });
});

/** 既存のデータに migration を当てる: 録音の run はフォルダに結び、録音の下の段階のサブページは役割ページのタブになる（#309）。 */
describe("migration 20261107021307_step_runs_folder on existing runs", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_steps_up_${randomUUID().replaceAll("-", "")}`;
  const MIGRATION = "20261107021307_step_runs_folder.sql";
  let pool: PgPool;
  let dir: string;

  before(async () => {
    const { Pool } = await import("pg");
    const { mkdtemp, copyFile, readdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { MIGRATION_FILE_PATTERN, defaultMigrationsDir } = await import("../src/migrate.ts");
    pool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    dir = await mkdtemp(join(tmpdir(), "editor-store-steps-up-"));
    for (const name of await readdir(defaultMigrationsDir)) {
      if (MIGRATION_FILE_PATTERN.test(name) && name < MIGRATION) await copyFile(new URL(name, defaultMigrationsDir), join(dir, name));
    }
  });

  after(async () => {
    const { rm } = await import("node:fs/promises");
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  });

  it("moves a recording's run to its folder with the recording as the input, and turns its step subpages into role tabs", async () => {
    const { copyFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const { defaultMigrationsDir } = await import("../src/migrate.ts");
    const client = await pool.connect();
    try {
      await applyMigrations(client, pathToFileURL(`${dir}/`));
      const id = async (sql: string, values: unknown[]) => (await client.query<{ id: string }>(sql, values)).rows[0]!.id;
      await client.query("INSERT INTO recipes (owner,id,name,steps) VALUES ($1,$2,$3,$4::jsonb)", [OWNER, RECIPE.id, RECIPE.id, JSON.stringify(RECIPE.steps.map((step) => ({ ...step, profile: "standard" })))]);
      const folder = await id("INSERT INTO pages (owner, kind, title) VALUES ($1, 'folder', 'フォルダ') RETURNING id", [OWNER]);
      const holder = await id("INSERT INTO pages (owner, kind, title, parent) VALUES ($1, 'page', '録音', $2) RETURNING id", [OWNER, folder]);
      const rec = await id("INSERT INTO pages (owner, kind, title, parent, page) VALUES ($1, 'rec', '録音', $2, $3) RETURNING id", [OWNER, folder, holder]);
      const top = await id("INSERT INTO pages (owner, kind, title) VALUES ($1, 'rec', '上の段の録音') RETURNING id", [OWNER]);
      const snapshot = JSON.stringify(snapshotOf({ id: RECIPE.id, name: RECIPE.id, guide: "", steps: RECIPE.steps.map((step) => ({ ...step, profile: "standard" })), terms: [], samples: [] }));
      const run = await id("INSERT INTO step_runs (owner, parent, recipe, state, recipe_snapshot, recipe_revision) VALUES ($1, $2, $3, 'succeeded', $4::jsonb, 1) RETURNING id", [OWNER, rec, RECIPE.id, snapshot]);
      const topRun = await id("INSERT INTO step_runs (owner, parent, recipe, state, recipe_snapshot, recipe_revision) VALUES ($1, $2, $3, 'succeeded', $4::jsonb, 1) RETURNING id", [OWNER, top, RECIPE.id, snapshot]);
      // 同じフォルダの 2 つ目の録音にも進行中の run: 最新の 1 つだけ残り、古い方は取消になる（step_runs_active_idx に当たらない）
      const rec2 = await id("INSERT INTO pages (owner, kind, title, parent) VALUES ($1, 'rec', '録音 2', $2) RETURNING id", [OWNER, folder]);
      const olderActive = await id("INSERT INTO step_runs (owner, parent, recipe, state, recipe_snapshot, recipe_revision, created_at) VALUES ($1, $2, $3, 'running', $4::jsonb, 1, clock_timestamp() - interval '1 hour') RETURNING id", [OWNER, rec, RECIPE.id, snapshot]);
      const newerActive = await id("INSERT INTO step_runs (owner, parent, recipe, state, recipe_snapshot, recipe_revision) VALUES ($1, $2, $3, 'queued', $4::jsonb, 1) RETURNING id", [OWNER, rec2, RECIPE.id, snapshot]);
      await client.query("INSERT INTO step_attempts (run_id, step_index, step_id, page_id, state, lease_until) VALUES ($1, 0, $2, $3, 'running', clock_timestamp() + interval '1 minute')", [olderActive, RECIPE.steps[0]!.id, rec]);
      const steps: string[] = [];
      for (const [index, step] of RECIPE.steps.entries()) {
        const page = await id("INSERT INTO pages (owner, kind, title, parent, recipe, step_status, blocks) VALUES ($1, 'step', $2, $3, $4, 'done', $5::jsonb) RETURNING id", [OWNER, step.name, rec, RECIPE.id, JSON.stringify(paragraph(`結果 ${index}`))]);
        steps.push(page);
        await client.query("INSERT INTO step_attempts (run_id, step_index, step_id, page_id, state) VALUES ($1, $2, $3, $4, 'succeeded')", [run, index, step.id, page]);
      }
      // 上の段の録音の下の段階（フォルダが無いので動かない）
      const topStep = await id("INSERT INTO pages (owner, kind, title, parent, recipe, step_status) VALUES ($1, 'step', $2, $3, $4, 'done') RETURNING id", [OWNER, RECIPE.steps[0]!.name, top, RECIPE.id]);
      await client.query("INSERT INTO step_attempts (run_id, step_index, step_id, page_id, state) VALUES ($1, 0, $2, $3, 'succeeded')", [topRun, RECIPE.steps[0]!.id, topStep]);

      await copyFile(new URL(MIGRATION, defaultMigrationsDir), join(dir, MIGRATION));
      const result = await applyMigrations(client, pathToFileURL(`${dir}/`));
      assert.deepEqual(result.applied, [MIGRATION]);

      const runRow = (await client.query<{ parent: string; input_tab: string | null; input_revision: number | null }>("SELECT parent, input_tab, input_revision FROM step_runs WHERE id = $1", [run])).rows[0]!;
      assert.deepEqual(runRow, { parent: folder, input_tab: rec, input_revision: 1 });
      const topRow = (await client.query<{ parent: string; input_tab: string | null }>("SELECT parent, input_tab FROM step_runs WHERE id = $1", [topRun])).rows[0]!;
      assert.deepEqual(topRow, { parent: top, input_tab: null }, "a recording outside a folder keeps its run as it was");
      const actives = (await client.query<{ state: string; parent: string }>("SELECT state, parent FROM step_runs WHERE id = ANY($1::uuid[]) ORDER BY created_at", [[olderActive, newerActive]])).rows;
      assert.deepEqual(actives.map((row) => [row.state, row.parent]), [["canceled", folder], ["queued", folder]]);
      assert.equal((await client.query("SELECT state FROM step_attempts WHERE run_id = $1", [olderActive])).rows[0]?.state, "canceled");
      for (const [index, page] of steps.entries()) {
        const row = (await client.query<{ kind: string; parent: string | null; page: string | null; made_from: unknown; sort_order: number; blocks: Block[] }>("SELECT kind, parent, page, made_from, sort_order, blocks FROM pages WHERE id = $1", [page])).rows[0]!;
        // 系譜: 最初の段階は録音から、後の段階は直前の段階の出力から（作り直し・もう 1 つがその入力を使う）
        assert.deepEqual([row.kind, row.parent, row.made_from, row.sort_order, row.blocks], ["note", folder, { kind: "step", run, input: index === 0 ? rec : steps[index - 1], inputRevision: 0 }, 1, paragraph(`結果 ${index}`)]);
        const holderRow = (await client.query<{ kind: string; title: string; parent: string | null; role: unknown; last_tab: string | null }>("SELECT kind, title, parent, role, last_tab FROM pages WHERE id = $1", [row.page])).rows[0]!;
        assert.deepEqual(holderRow, { kind: "page", title: RECIPE.steps[index]!.name, parent: folder, role: { kind: "step", recipe: RECIPE.id, stepId: RECIPE.steps[index]!.id }, last_tab: page });
      }
      assert.equal((await client.query("SELECT kind FROM pages WHERE id = $1", [topStep])).rows[0]?.kind, "step");
      // 流れが読める（役割ページ 3 つ）
      const flow = await readFlow(client, OWNER, folder);
      assert.deepEqual(flow?.holders.filter((item) => item.role !== null).map((item) => [item.role, item.tabs.map((tab) => tab.id)]), RECIPE.steps.map((step, index) => [{ kind: "step", recipe: RECIPE.id, stepId: step.id }, [steps[index]]]));
    } finally {
      client.release();
    }
  });
});

// 掃除が積み直す queued の一覧。上限と順を他のテストの run に左右されずに確かめるため、空の schema で行う。
describe("PostgreSQL queued attempts for the sweep", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_steps_queued_${randomUUID().replaceAll("-", "")}`;
  let pool: PgPool;
  let store: EditorStore;

  before(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await applyMigrations(client);
      await client.query("INSERT INTO recipes (owner,id,name,steps) VALUES ($1,$2,$3,$4::jsonb)", [OWNER, RECIPE.id, RECIPE.id, JSON.stringify(RECIPE.steps.map((step) => ({ ...step, profile: "standard" })))]);
    } finally {
      client.release();
    }
    store = new EditorStore(pool);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  async function newRun() {
    const folder = (await store.createPage(OWNER, { kind: "folder", title: "合成のフォルダ" })).id;
    const rec = (await store.createPage(OWNER, { kind: "rec", title: "合成の録音", blocks: TRANSCRIPT, parent: folder }))!.id;
    const result = await createRun(pool, OWNER, folder, { recipe: RECIPE, inputTab: rec, toStep: LAST });
    assert.ok(result.status === "created");
    return { parent: folder, run: result.run };
  }

  async function claimOk(runId: string, stepIndex: number) {
    const result = await claimAttempt(pool, runId, stepIndex);
    assert.ok(result.ok);
    return result.claim;
  }

  async function finish(runId: string, stepIndex: number) {
    const claim = await claimOk(runId, stepIndex);
    const input = await readStepInput(pool, claim);
    assert.ok(input);
    const previous = stepIndex === 0 ? input.parentBlocks : input.previousBlocks;
    assert.ok(previous);
    const committed = await commitAttempt(pool, {
      runId,
      stepIndex,
      generation: claim.generation,
      blocks: paragraph(`合成の結果 ${stepIndex}`),
      inputBasis: computeBasis(previous, RECIPE.steps[stepIndex]!.instruction),
    });
    assert.ok(committed.ok);
  }

  it("lists queued attempts of runs in progress only, oldest run first, with the generation for the task name and a limit", async () => {
    assert.deepEqual(await listQueuedAttempts(pool), []);

    // 積んだまま（世代 0）
    const fresh = await newRun();
    // 一時的な失敗で積み直した（世代は claim で進んだ 1）
    const retried = await newRun();
    const claim = await claimOk(retried.run.id, 0);
    assert.deepEqual(await failAttempt(pool, { runId: retried.run.id, stepIndex: 0, generation: claim.generation, code: "fake_failure", retryable: true }), {
      ok: true,
      outcome: "retry",
      generation: 1,
      tries: 1,
    });
    // 段階 0 が済み、段階 1 が queued（世代 0）
    const advanced = await newRun();
    await finish(advanced.run.id, 0);

    // 含まないもの: 実行中・取消・成功・進行中でない run の queued
    const running = await newRun();
    await claimOk(running.run.id, 0);
    const canceled = await newRun();
    assert.equal((await cancelRun(pool, OWNER, canceled.parent, canceled.run.id))?.state, "canceled");
    const succeeded = await newRun();
    for (let index = 0; index < RECIPE.steps.length; index++) await finish(succeeded.run.id, index);
    const inactive = await newRun();
    await pool.query("UPDATE step_runs SET state = 'failed', finished_at = clock_timestamp() WHERE id = $1", [inactive.run.id]);
    assert.equal((await pool.query("SELECT state FROM step_attempts WHERE run_id = $1 AND step_index = 0", [inactive.run.id])).rows[0]?.state, "queued");

    const expected = [
      { runId: fresh.run.id, stepIndex: 0, generation: 0 },
      { runId: retried.run.id, stepIndex: 0, generation: 1 },
      { runId: advanced.run.id, stepIndex: 1, generation: 0 },
    ];
    assert.deepEqual(await listQueuedAttempts(pool), expected);
    assert.deepEqual(await listQueuedAttempts(pool, { limit: 2 }), expected.slice(0, 2));
    // 上限は 1〜1000 に丸める
    assert.deepEqual(await listQueuedAttempts(pool, { limit: 0 }), expected.slice(0, 1));
    assert.deepEqual(await listQueuedAttempts(pool, { limit: 5000 }), expected);
    // 続きから（前の回の最後の次）。続きが無ければ空、最後まで読めば終わり
    assert.deepEqual(await listQueuedAttempts(pool, { limit: 1, after: expected[0]! }), expected.slice(1, 2));
    assert.deepEqual(await listQueuedAttempts(pool, { after: expected[1]! }), expected.slice(2));
    assert.deepEqual(await listQueuedAttempts(pool, { after: expected[2]! }), []);
    // 形の合わない続きは何も返さない
    assert.deepEqual(await listQueuedAttempts(pool, { after: { runId: expected[0]!.runId, stepIndex: -1 } }), []);
    assert.deepEqual(await listQueuedAttempts(pool, { after: { runId: "not-a-uuid", stepIndex: 0 } }), []);
    // 続きの run が消えていれば何も返さない（次の掃除は先頭から読み直す）
    assert.deepEqual(await listQueuedAttempts(pool, { after: { runId: "00000000-0000-4000-8000-000000000000", stepIndex: 0 } }), []);
    // 読むだけ（状態を変えない）
    assert.deepEqual(await listQueuedAttempts(pool), expected);
  });

  it("moves the generation of a queued attempt on so the sweep can enqueue it under a name the deleted task does not hold", async () => {
    const { run } = await newRun();
    const ref = { runId: run.id, stepIndex: 0, generation: 0 };

    assert.equal(await requeueAttempt(pool, { ...ref, generation: 1 }), null, "the generation has to match");
    assert.equal(await requeueAttempt(pool, ref), 1);
    assert.equal(await requeueAttempt(pool, { ...ref, generation: 1 }), 2, "every sweep gives a name that was never used");
    // state は queued のまま。tries も動かない（積み直しは試行ではない）
    const row = (await pool.query<{ state: string; tries: number; generation: number }>(
      "SELECT state, tries, generation FROM step_attempts WHERE run_id = $1 AND step_index = 0",
      [run.id],
    )).rows[0];
    assert.deepEqual(row, { state: "queued", tries: 0, generation: 2 });
    // 一覧は（前のテストが残した分も含めて）表の全体を読むので、この run の分だけを見る
    assert.deepEqual(
      (await listQueuedAttempts(pool, { limit: 1000 })).filter((item) => item.runId === run.id),
      [{ runId: run.id, stepIndex: 0, generation: 2 }],
    );

    // 積んだ task はそのまま claim できる（世代は claim でさらに進む）
    const claim = await claimOk(run.id, 0);
    assert.equal(claim.generation, 3);
    // claim 済み・取消・無い attempt は積み直さない
    assert.equal(await requeueAttempt(pool, { ...ref, generation: 3 }), null);
    const canceled = await newRun();
    assert.equal((await cancelRun(pool, OWNER, canceled.parent, canceled.run.id))?.state, "canceled");
    assert.equal(await requeueAttempt(pool, { runId: canceled.run.id, stepIndex: 0, generation: 0 }), null);
    assert.equal(await requeueAttempt(pool, { runId: randomUUID(), stepIndex: 0, generation: 0 }), null);
    assert.equal(await requeueAttempt(pool, { runId: "not-a-uuid", stepIndex: 0, generation: 0 }), null);
    await assert.rejects(() => requeueAttempt(pool, { ...ref, generation: -1 }), TypeError);
    await assert.rejects(() => requeueAttempt(pool, { ...ref, stepIndex: 1.5, generation: 0 }), TypeError);
  });
});

describe("recipe snapshot chunked flag (#277)", () => {
  it("keeps chunked only when true, reads old snapshots as false, and rejects a non-boolean", () => {
    const snapshot = snapshotOf({
      id: "tpl-synthetic", name: "合成", guide: "",
      steps: [
        { id: "aaaa1111", name: "書き直す", instruction: "指示", profile: "light", chunked: true },
        { id: "bbbb2222", name: "まとめる", instruction: "指示", profile: "standard", chunked: false },
      ],
      terms: [], samples: [],
    });
    assert.equal(parseRecipeSnapshot(snapshot)?.steps[0]?.chunked, true);
    assert.equal("chunked" in snapshot.steps[1]!, false, "false is not written (old snapshots stay byte-identical)");
    assert.equal(parseRecipeSnapshot({ ...snapshot, steps: [{ id: "aaaa1111", name: "書き直す", instruction: "指示", profile: "light", chunked: "yes" }] }), null);
  });

  it("derives the chunk basis from the whole step basis, independent of artifact key order", () => {
    const basis = { source: "a".repeat(64), artifacts: { x: "b".repeat(64), y: "c".repeat(64) }, refs: "d".repeat(64), info: "e".repeat(64), guide: "f".repeat(64), step: "0".repeat(64) };
    const reordered = { ...basis, artifacts: { y: "c".repeat(64), x: "b".repeat(64) } };
    assert.match(computeChunkBasis(basis), /^[0-9a-f]{64}$/);
    assert.equal(computeChunkBasis(basis), computeChunkBasis(reordered));
    assert.notEqual(computeChunkBasis(basis), computeChunkBasis({ ...basis, source: "1".repeat(64) }));
  });
});

describe("PostgreSQL chunked steps (#277)", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_steps_chunks_${randomUUID().replaceAll("-", "")}`;
  const CHUNKED: StepRecipe = {
    id: "tpl-chunked",
    steps: [
      { id: "aaaa1111", name: "合成の書き直し", instruction: "合成の指示 1", chunked: true },
      { id: "bbbb2222", name: "合成のまとめ", instruction: "合成の指示 2" },
    ],
  };
  let pool: PgPool;
  let store: EditorStore;

  before(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await applyMigrations(client);
      await client.query("INSERT INTO recipes (owner,id,name,steps) VALUES ($1,$2,$3,$4::jsonb)", [OWNER, CHUNKED.id, CHUNKED.id, JSON.stringify(CHUNKED.steps.map((step) => ({ ...step, profile: "standard" })))]);
    } finally {
      client.release();
    }
    store = new EditorStore(pool);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  async function setup() {
    const folder = (await store.createPage(OWNER, { kind: "folder", title: "合成のフォルダ" })).id;
    const rec = (await store.createPage(OWNER, { kind: "rec", title: "合成の録音", blocks: TRANSCRIPT, parent: folder }))!.id;
    const result = await createRun(pool, OWNER, folder, { recipe: CHUNKED, inputTab: rec, toStep: 1 });
    assert.ok(result.status === "created");
    return { parent: folder, rec, run: result.run };
  }

  async function claimOk(runId: string, stepIndex = 0): Promise<StepClaim> {
    const result = await claimAttempt(pool, runId, stepIndex);
    assert.ok(result.ok, result.ok ? "" : result.reason);
    return result.claim;
  }

  async function basisOf(claim: StepClaim): Promise<string> {
    const input = await readStepInput(pool, claim);
    assert.ok(input);
    return computeChunkBasis(computeStepBasis(claim.recipeSnapshot!, claim.stepIndex, input));
  }

  const refOf = (claim: StepClaim) => ({ runId: claim.runId, stepIndex: claim.stepIndex, generation: claim.generation });

  async function chunkRow(runId: string) {
    return (await pool.query<{ state: string; tries: number; generation: number; chunk_count: number | null; chunk_index: number; chunk_blocks: unknown; chunk_basis: string | null; partial_blocks: unknown }>(
      "SELECT state, tries, generation, chunk_count, chunk_index, chunk_blocks, chunk_basis, partial_blocks FROM step_attempts WHERE run_id = $1 AND step_index = 0",
      [runId],
    )).rows[0]!;
  }

  it("pins the chunked flag into the run snapshot and starts chunks once per attempt, fenced by the generation", async () => {
    const { run } = await setup();
    assert.equal(run.recipeSnapshot.steps[0]?.chunked, true);
    assert.equal(run.recipeSnapshot.steps[1]?.chunked, undefined);
    const claim = await claimOk(run.id);
    assert.deepEqual(claim.chunk, { count: null, index: 0, basis: null, blocks: [] });
    const basis = await basisOf(claim);
    assert.equal(await startChunks(pool, { ...refOf(claim), generation: claim.generation - 1, count: 3, basis }), false, "an old generation cannot start");
    assert.equal(await startChunks(pool, { ...refOf(claim), count: 3, basis }), true);
    assert.equal(await startChunks(pool, { ...refOf(claim), count: 4, basis }), false, "only once");
    await assert.rejects(() => startChunks(pool, { ...refOf(claim), count: 61, basis }), RangeError);
    await assert.rejects(() => startChunks(pool, { ...refOf(claim), count: 2, basis: "nope" }), TypeError);
  });

  it("commits a middle chunk only with the current generation and index, queues the attempt, and finishes with commitAttempt", async () => {
    const { parent, run } = await setup();
    const first = await claimOk(run.id);
    const basis = await basisOf(first);
    assert.ok(await startChunks(pool, { ...refOf(first), count: 3, basis }));
    assert.deepEqual(await commitChunk(pool, { ...refOf(first), generation: first.generation - 1, chunkIndex: 0, blocks: paragraph("区切り 1") }), { ok: false, reason: "stale_generation" });
    assert.deepEqual(await commitChunk(pool, { ...refOf(first), chunkIndex: 1, blocks: paragraph("区切り 1") }), { ok: false, reason: "stale_generation" });
    assert.deepEqual(await commitChunk(pool, { ...refOf(first), chunkIndex: 0, blocks: paragraph("区切り 1") }), { ok: true, generation: first.generation });
    assert.deepEqual(await commitChunk(pool, { ...refOf(first), chunkIndex: 1, blocks: paragraph("二重") }), { ok: false, reason: "stale_generation" }, "the attempt is no longer running");
    let row = await chunkRow(run.id);
    assert.equal(row.state, "queued");
    assert.equal(row.tries, 0, "tries restart for each chunk");
    assert.equal(row.chunk_index, 1);
    assert.deepEqual(row.chunk_blocks, [paragraph("区切り 1")]);
    const view = (await listRun(pool, OWNER, parent))?.run;
    assert.deepEqual(view?.steps[0]?.chunk, { index: 1, count: 3 });

    const second = await claimOk(run.id);
    assert.equal(second.generation, first.generation + 1);
    assert.deepEqual(second.chunk, { count: 3, index: 1, basis, blocks: [paragraph("区切り 1")] });
    assert.ok((await commitChunk(pool, { ...refOf(second), chunkIndex: 1, blocks: paragraph("区切り 2") })).ok);
    const third = await claimOk(run.id);
    assert.deepEqual(await commitChunk(pool, { ...refOf(third), chunkIndex: 2, blocks: paragraph("区切り 3") }), { ok: false, reason: "stale_generation" }, "the last chunk goes through commitAttempt");
    const input = await readStepInput(pool, third);
    assert.ok(input);
    const all = [...third.chunk.blocks.flat(), ...paragraph("区切り 3")];
    const committed = await commitAttempt(pool, { ...refOf(third), blocks: all, inputBasis: computeStepBasis(CHUNKED, 0, input) });
    assert.deepEqual(committed, { ok: true, next: 1 });
    row = await chunkRow(run.id);
    assert.equal(row.state, "succeeded");
    assert.equal((await listRun(pool, OWNER, parent))?.run?.steps[0]?.chunk, undefined, "a finished step shows no progress");
  });

  it("keeps finished chunks through a retry and a lease sweep, and joins them into partial_blocks on the final failure", async () => {
    const { parent, run } = await setup();
    const first = await claimOk(run.id);
    assert.ok(await startChunks(pool, { ...refOf(first), count: 3, basis: await basisOf(first) }));
    assert.ok((await commitChunk(pool, { ...refOf(first), chunkIndex: 0, blocks: paragraph("区切り 1") })).ok);
    // 区切り 2 で一時的に失敗 → 積み直し（終えた区切りは残る）
    const retry = await claimOk(run.id);
    assert.equal((await failAttempt(pool, { ...refOf(retry), code: "ai_timeout", retryable: true })).ok, true);
    assert.deepEqual((await chunkRow(run.id)).chunk_blocks, [paragraph("区切り 1")]);
    // lease 切れの掃除でも残る
    const swept = await claimOk(run.id);
    await pool.query("UPDATE step_attempts SET lease_until = clock_timestamp() - interval '1 second' WHERE run_id = $1 AND state = 'running'", [run.id]);
    assert.equal((await sweepExpiredLeases(pool)).filter((ref) => ref.runId === run.id).length, 1);
    let row = await chunkRow(run.id);
    assert.equal(row.state, "queued");
    assert.equal(row.chunk_index, 1);
    assert.deepEqual(row.chunk_blocks, [paragraph("区切り 1")]);
    assert.equal(swept.chunk.index, 1);
    // 最後の失敗: 終えた区切り + 今の区切りの書けたところまで
    const last = await claimOk(run.id);
    assert.deepEqual(await failAttempt(pool, { ...refOf(last), code: "output_too_long", retryable: false, partial: paragraph("区切り 2 の途中") }), { ok: true, outcome: "failed" });
    row = await chunkRow(run.id);
    assert.deepEqual(row.partial_blocks, [...paragraph("区切り 1"), ...paragraph("区切り 2 の途中")]);
    assert.deepEqual(row.chunk_blocks, [paragraph("区切り 1")], "chunk_blocks stay for a resume");
    assert.deepEqual(await readPartialOutput(pool, OWNER, parent, run.id, 0), [...paragraph("区切り 1"), ...paragraph("区切り 2 の途中")]);
    const view = (await listRun(pool, OWNER, parent))?.run;
    assert.deepEqual(view?.steps[0]?.chunk, { index: 1, count: 3 });
    assert.equal(view?.steps[0]?.hasPartialOutput, true);
  });

  it("joins finished chunks into partial_blocks when the sweep fails the attempt", async () => {
    const { run } = await setup();
    const first = await claimOk(run.id);
    assert.ok(await startChunks(pool, { ...refOf(first), count: 2, basis: await basisOf(first) }));
    assert.ok((await commitChunk(pool, { ...refOf(first), chunkIndex: 0, blocks: paragraph("区切り 1") })).ok);
    for (let tries = 1; tries <= MAX_TRIES; tries++) {
      await claimOk(run.id);
      await pool.query("UPDATE step_attempts SET lease_until = clock_timestamp() - interval '1 second' WHERE run_id = $1 AND state = 'running'", [run.id]);
      await sweepExpiredLeases(pool);
    }
    const row = await chunkRow(run.id);
    assert.equal(row.state, "failed");
    assert.deepEqual(row.partial_blocks, paragraph("区切り 1"));
  });

  it("resumes a failed chunked run from the failed chunk only while the input is unchanged", async () => {
    const { parent, rec, run } = await setup();
    const first = await claimOk(run.id);
    assert.ok(await startChunks(pool, { ...refOf(first), count: 3, basis: await basisOf(first) }));
    assert.ok((await commitChunk(pool, { ...refOf(first), chunkIndex: 0, blocks: paragraph("区切り 1") })).ok);
    const second = await claimOk(run.id);
    assert.ok((await commitChunk(pool, { ...refOf(second), chunkIndex: 1, blocks: paragraph("区切り 2") })).ok);
    const third = await claimOk(run.id);
    assert.equal(await resumeRun(pool, OWNER, parent, run.id).then((result) => result.status), "run_in_progress");
    await failAttempt(pool, { ...refOf(third), code: "invalid_output", retryable: false });

    assert.equal((await resumeRun(pool, OTHER, parent, run.id)).status, "not_found");
    assert.equal((await resumeRun(pool, OWNER, parent, randomUUID())).status, "not_found");
    const resumed = await resumeRun(pool, OWNER, parent, run.id);
    assert.ok(resumed.status === "resumed");
    assert.equal(resumed.stepIndex, 0);
    assert.equal(resumed.generation, third.generation + 1);
    assert.equal(resumed.run.state, "queued");
    assert.deepEqual(resumed.run.steps.map((step) => step.state), ["queued", "pending"]);
    let row = await chunkRow(run.id);
    assert.equal(row.tries, 0);
    assert.equal(row.chunk_index, 2);
    assert.equal(row.partial_blocks, null);
    const again = await claimOk(run.id);
    assert.equal(again.chunk.index, 2, "chunks 1 and 2 are reused");
    assert.deepEqual(again.chunk.blocks, [paragraph("区切り 1"), paragraph("区切り 2")]);
    await failAttempt(pool, { ...refOf(again), code: "invalid_output", retryable: false });

    // 文字起こし（入力のタブ）を直すと、やり直せない（最初から作り直す）
    const page = await store.getPage(OWNER, rec);
    assert.ok(page);
    assert.equal((await store.savePage(OWNER, rec, { blocks: paragraph("直した文字起こし") }, { baseRevision: page.revision }))?.status, "saved");
    assert.equal((await resumeRun(pool, OWNER, parent, run.id)).status, "input_changed");
    row = await chunkRow(run.id);
    assert.equal(row.state, "failed", "a refused resume writes nothing");
  });

  it("refuses to resume a run that is not the latest, or whose failed step did not chunk", async () => {
    const { parent, run } = await setup();
    const claim = await claimOk(run.id);
    await failAttempt(pool, { ...refOf(claim), code: "invalid_output", retryable: false });
    assert.equal((await resumeRun(pool, OWNER, parent, run.id)).status, "not_resumable", "the step never chunked");

    const other = await setup();
    const started = await claimOk(other.run.id);
    assert.ok(await startChunks(pool, { ...refOf(started), count: 2, basis: await basisOf(started) }));
    await failAttempt(pool, { ...refOf(started), code: "invalid_output", retryable: false });
    const newer = await createRun(pool, OWNER, other.parent, { recipe: CHUNKED, inputTab: other.rec, toStep: 1 });
    assert.equal(newer.status, "created");
    assert.equal((await resumeRun(pool, OWNER, other.parent, other.run.id)).status, "run_in_progress");
    assert.ok(newer.status === "created");
    await cancelRun(pool, OWNER, other.parent, newer.run.id);
    assert.equal((await resumeRun(pool, OWNER, other.parent, other.run.id)).status, "not_resumable", "a newer run exists");
  });
});
