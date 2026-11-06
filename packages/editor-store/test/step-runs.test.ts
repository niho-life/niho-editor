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
  readPartialOutput,
  readStepInput,
  readStepStaleReasons,
  refreshStale,
  stepPageId,
  stepPageIdForStep,
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

  it("derives the sub-page id from the parent, the recipe and the step (fixed values)", () => {
    const parent = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
    assert.equal(stepPageId(parent, "tpl-1", 0), "c11cf89c-21f8-50be-9768-808ee1198bf5");
    assert.equal(stepPageId(parent, "tpl-1", 1), "6a3abd86-e699-5034-89fe-510b42b3f78a");
    assert.equal(stepPageId(parent.toUpperCase(), "tpl-1", 0), stepPageId(parent, "tpl-1", 0));
    assert.notEqual(stepPageId(parent, "tpl-2", 0), stepPageId(parent, "tpl-1", 0));
    assert.match(stepPageId(randomUUID(), "tpl-3", 2), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(stepPageIdForStep(parent, "tpl-1", "stable-step"), stepPageIdForStep(parent, "tpl-1", "stable-step"));
    assert.notEqual(stepPageIdForStep(parent, "tpl-1", "stable-step"), stepPageIdForStep(parent, "tpl-1", "another-step"));
  });

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
    assert.equal(basis, "38ddc6bcad045dd669e9d8a9eedef6a82d47404b48057af98516d56a2e4cd93c");
    // key の順・指示文の前後の空白だけの違いは同じ基準
    assert.equal(computeBasis([{ content: [{ text: "合成の本文", type: "text" }], type: "paragraph" }], "  合成の指示\n"), basis);
    assert.notEqual(computeBasis(paragraph("合成の本文。"), "合成の指示"), basis);
    assert.notEqual(computeBasis(blocks, "合成の別の指示"), basis);
  });

  it("validates error codes and idempotency keys", () => {
    for (const code of ["internal", "lease_expired", "a", "x".repeat(64)]) assert.ok(isStepErrorCode(code), code);
    for (const code of ["", "Internal", "has space", "x".repeat(65), "message: secret"]) assert.ok(!isStepErrorCode(code), code);
    for (const key of ["a", "abc-DEF_123", "k".repeat(128)]) assert.ok(isIdempotencyKey(key), key);
    for (const key of ["", "has space", "k".repeat(129), "a/b", "鍵"]) assert.ok(!isIdempotencyKey(key), key);
  });

  it("treats malformed ids as missing and refuses an empty owner without querying", async () => {
    assert.deepEqual(await createRun(untouchable, OWNER, "not-a-uuid", { recipe: RECIPE }), { status: "not_found" });
    assert.equal(await listRun(untouchable, OWNER, "not-a-uuid"), null);
    assert.equal(await cancelRun(untouchable, OWNER, "not-a-uuid", randomUUID()), null);
    assert.equal(await cancelRun(untouchable, OWNER, randomUUID(), "x' OR '1'='1"), null);
    assert.deepEqual(await claimAttempt(untouchable, "not-a-uuid", 0), { ok: false, reason: "run_inactive" });
    assert.equal(await heartbeatAttempt(untouchable, { runId: "not-a-uuid", stepIndex: 0, generation: 1 }), false);
    assert.equal(await refreshStale(untouchable, OWNER, "not-a-uuid", RECIPE), 0);
    await assert.rejects(() => createRun(untouchable, "", randomUUID(), { recipe: RECIPE }), TypeError);
    await assert.rejects(() => listRun(untouchable, "", randomUUID()), TypeError);
    await assert.rejects(() => createRun(untouchable, OWNER, randomUUID(), { recipe: RECIPE, fromStep: -1 }), RangeError);
    await assert.rejects(() => createRun(untouchable, OWNER, randomUUID(), { recipe: RECIPE, idempotencyKey: "has space" }), TypeError);
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

  async function recording(owner = OWNER, blocks: Block[] = TRANSCRIPT): Promise<string> {
    return (await store.createPage(owner, { kind: "rec", title: "合成の録音", blocks })).id;
  }

  /** 利用者がページを保存する（今の revision を持って。#58 の楽観ロック）。 */
  async function userEdit(owner: string, id: string, blocks: Block[]) {
    const current = await store.getPage(owner, id);
    assert.ok(current, "page exists");
    const result = await store.savePage(owner, id, { blocks }, { baseRevision: current.revision });
    assert.equal(result?.status, "saved");
  }

  async function pageRow(id: string) {
    const result = await pool.query<{ kind: string; title: string; parent: string | null; recipe: string | null; step_status: string | null; blocks: Block[]; deleted_at: Date | null }>(
      "SELECT kind, title, parent, recipe, step_status, blocks, deleted_at FROM pages WHERE id = $1",
      [id],
    );
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
    return (await pool.query<{ state: string; finished_at: Date | null }>("SELECT state, finished_at FROM step_runs WHERE id = $1", [runId])).rows[0];
  }

  async function created(parentId: string, options: { fromStep?: number; idempotencyKey?: string } = {}) {
    const result = await createRun(pool, OWNER, parentId, { recipe: RECIPE, ...options });
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

  async function completeAll(runId: string, fromStep = 0) {
    for (let index = fromStep; index < RECIPE.steps.length; index++) await complete(runId, index);
  }

  it("applies the migration to an empty schema and accepts failed as a step status", async () => {
    const page = await store.createPage(OWNER);
    await pool.query("UPDATE pages SET step_status = 'failed' WHERE id = $1", [page.id]);
    await assert.rejects(() => pool.query("UPDATE pages SET step_status = 'paused' WHERE id = $1", [page.id]), { code: "23514" });
  });

  it("creates a run with deterministic sub-pages and queues the first step", async () => {
    const parent = await recording();
    const run = await created(parent);
    assert.equal(run.state, "queued");
    assert.equal(run.recipe, RECIPE.id);
    assert.equal(run.fromStep, 0);
    assert.deepEqual(run.steps.map((step) => step.state), ["queued", "pending", "pending"]);
    assert.deepEqual(run.steps.map((step) => step.stepId), RECIPE.steps.map((step) => step.id));
    for (const [index, step] of run.steps.entries()) {
      assert.equal(step.pageId, stepPageIdForStep(parent, RECIPE.id, RECIPE.steps[index]!.id));
      assert.equal(step.stepStatus, "wait");
      assert.equal(step.tries, 0);
      const page = await pageRow(step.pageId);
      assert.deepEqual(
        { kind: page?.kind, title: page?.title, parent: page?.parent, recipe: page?.recipe, status: page?.step_status, blocks: page?.blocks },
        { kind: "step", title: RECIPE.steps[index]!.name, parent, recipe: RECIPE.id, status: "wait", blocks: [] },
      );
    }
    assert.deepEqual(await listRun(pool, OWNER, parent), { run });
  });

  it("reads the latest run's guide and terms for the recording and for a page under it — and for nobody else", async () => {
    const owner = "synthetic-guide-owner";
    const recipe = { ...RECIPE, revision: 1, name: "合成の手順", guide: "合成のガイド: 常体でそろえる", terms: [{ term: "円覚寺", reading: "えんがくじ", variants: ["円学寺"], note: "" }], steps: RECIPE.steps.map((step) => ({ ...step, profile: "standard" })) };
    await pool.query("INSERT INTO recipes(owner,id,name,guide,steps,terms) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)", [owner, recipe.id, recipe.name, recipe.guide, JSON.stringify(recipe.steps), JSON.stringify(recipe.terms)]);
    const parent = (await store.createPage(owner, { kind: "rec", title: "合成の録音", blocks: TRANSCRIPT })).id;
    // run が無いあいだは何も返さない
    assert.equal(await getRunGuide(pool, owner, parent), null);
    const first = await createRun(pool, owner, parent, { recipe });
    assert.equal(first.status, "created");
    const expected = { recipeName: "合成の手順", guide: "合成のガイド: 常体でそろえる", terms: recipe.terms };
    assert.deepEqual(await getRunGuide(pool, owner, parent), expected);
    // 録音の下の段階のページ（kind = 'step'）からも、同じ録音の run のものが読める
    const stepPage = first.status === "created" ? first.run.steps[0]!.pageId : "";
    assert.deepEqual(await getRunGuide(pool, owner, stepPage), expected);
    // ふつうのページ・他人・ゴミ箱の録音・形の悪い id は null
    const note = await store.createPage(owner, { title: "合成のメモ" });
    assert.equal(await getRunGuide(pool, owner, note.id), null);
    assert.equal(await getRunGuide(pool, "synthetic-other-owner", parent), null);
    assert.equal(await getRunGuide(pool, owner, "not-a-page-id"), null);
    assert.equal(await store.deletePage(owner, parent), "deleted");
    assert.equal(await getRunGuide(pool, owner, parent), null);
  });

  it("pins the parent/recipe design across runs and changes it only on explicit update", async () => {
    const owner = "synthetic-snapshot-owner";
    const old = { ...RECIPE, revision: 1, name: "Old design", guide: "Old guide", steps: RECIPE.steps.map((step) => ({ ...step, profile: "standard" })) };
    await pool.query("INSERT INTO recipes(owner,id,name,guide,steps) VALUES($1,$2,$3,$4,$5::jsonb)", [owner, old.id, old.name, old.guide, JSON.stringify(old.steps)]);
    const parent = (await store.createPage(owner, { kind: "rec", title: "Synthetic", blocks: TRANSCRIPT })).id;
    const first = await createRun(pool, owner, parent, { recipe: old });
    assert.equal(first.status, "created");
    if (first.status !== "created") return;
    assert.equal(first.run.recipeSnapshot.steps[0]?.profile, "standard");
    await cancelRun(pool, owner, parent, first.run.id);
    const fresh = { ...old, revision: 2, name: "New design", steps: old.steps.map((step, index) => index === 0 ? { ...step, name: "New step", instruction: "New instruction", profile: "light" } : step) };
    await pool.query("UPDATE recipes SET name=$3,steps=$4::jsonb,revision=2 WHERE owner=$1 AND id=$2", [owner, old.id, fresh.name, JSON.stringify(fresh.steps)]);
    assert.deepEqual(await createRun(pool, owner, parent, { recipe: old }), { status: "recipe_changed" });
    const rerun = await createRun(pool, owner, parent, { recipe: fresh });
    assert.equal(rerun.status, "created");
    if (rerun.status !== "created") return;
    assert.equal(rerun.run.recipeRevision, 1);
    assert.equal(rerun.run.recipeSnapshot.steps[0]?.name, old.steps[0]?.name);
    await cancelRun(pool, owner, parent, rerun.run.id);
    const updated = await updateRunRecipeSnapshot(pool, owner, parent, rerun.run.id, fresh, 1);
    assert.equal(updated.status, "updated");
    if (updated.status !== "updated") return;
    assert.equal(updated.run.recipeRevision, 2);
    assert.equal(updated.run.recipeSnapshot.steps[0]?.profile, "light");
    const next = await createRun(pool, owner, parent, { recipe: fresh });
    assert.equal(next.status, "created");
    if (next.status === "created") assert.equal(next.run.recipeSnapshot.steps[0]?.name, "New step");
  });

  it("invalidates every prior result when the accepted recipe changes step order", async () => {
    const owner = "synthetic-reordered-recipe-owner";
    const original = { ...RECIPE, revision: 1, name: RECIPE.id, guide: "", steps: RECIPE.steps.map((step) => ({ ...step, profile: "standard" })) };
    await pool.query("INSERT INTO recipes(owner,id,name,steps) VALUES($1,$2,$3,$4::jsonb)", [owner, original.id, original.name ?? original.id, JSON.stringify(original.steps)]);
    const parent = await recording(owner);
    const started = await createRun(pool, owner, parent, { recipe: original });
    assert.equal(started.status, "created");
    if (started.status !== "created") return;
    await completeAll(started.run.id);

    const reordered = { ...original, revision: 2, steps: [original.steps[1]!, original.steps[0]!, original.steps[2]!] };
    await pool.query("UPDATE recipes SET steps=$3::jsonb,revision=2 WHERE owner=$1 AND id=$2", [owner, original.id, JSON.stringify(reordered.steps)]);
    const updated = await updateRunRecipeSnapshot(pool, owner, parent, started.run.id, reordered, 1);
    assert.equal(updated.status, "updated");
    if (updated.status !== "updated") return;
    assert.deepEqual(
      updated.run.steps.map((step) => step.pageId),
      [started.run.steps[1]!.pageId, started.run.steps[0]!.pageId, started.run.steps[2]!.pageId],
      "artifact page IDs follow stable step IDs across reordering",
    );
    assert.equal(await refreshStale(pool, owner, parent, {
      id: reordered.id, name: reordered.name, guide: reordered.guide,
      steps: reordered.steps, terms: [], samples: [],
    }), RECIPE.steps.length);
    const listed = await listRun(pool, owner, parent);
    assert.deepEqual(listed?.run?.steps.map((step) => step.stepStatus), ["stale", "stale", "stale"]);
  });

  it("refuses a second run on the same recording while one is in progress, even when many arrive at once", async () => {
    const parent = await recording();
    await created(parent);
    assert.deepEqual(await createRun(pool, OWNER, parent, { recipe: RECIPE }), { status: "run_in_progress" });

    const fresh = await recording();
    const results = await Promise.all(Array.from({ length: 10 }, () => createRun(pool, OWNER, fresh, { recipe: RECIPE })));
    assert.equal(results.filter((result) => result.status === "created").length, 1);
    assert.equal(results.filter((result) => result.status === "run_in_progress").length, 9);
    const count = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM step_runs WHERE parent = $1", [fresh]);
    assert.equal(count.rows[0]?.n, "1");
  });

  it("returns the same run for the same Idempotency-Key, also when the retries race", async () => {
    const parent = await recording();
    const key = `synthetic-${randomUUID()}`;
    const first = await created(parent, { idempotencyKey: key });
    const again = await createRun(pool, OWNER, parent, { recipe: RECIPE, idempotencyKey: key });
    assert.equal(again.status, "existing");
    assert.equal(again.status === "existing" ? again.run.id : null, first.id);

    const racing = await recording();
    const raceKey = `synthetic-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 6 }, () => createRun(pool, OWNER, racing, { recipe: RECIPE, idempotencyKey: raceKey })));
    assert.equal(results.filter((result) => result.status === "created").length, 1);
    const ids = new Set(results.map((result) => (result.status === "created" || result.status === "existing" ? result.run.id : result.status)));
    assert.equal(ids.size, 1, "every retry sees the one run");
  });

  it("refuses parents that are not the owner's live recording page", async () => {
    const note = (await store.createPage(OWNER, { kind: "note" })).id;
    const theirs = await recording(OTHER);
    const removed = await recording();
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [removed]);
    for (const parent of [note, theirs, removed, randomUUID()]) {
      assert.deepEqual(await createRun(pool, OWNER, parent, { recipe: RECIPE }), { status: "not_found" }, parent);
      const count = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM step_runs WHERE parent = $1", [parent]);
      assert.equal(count.rows[0]?.n, "0");
    }
  });

  it("reuses completed upstream sub-pages from fromStep and refuses fromStep without them", async () => {
    const parent = await recording();
    assert.deepEqual(await createRun(pool, OWNER, parent, { recipe: RECIPE, fromStep: 1 }), { status: "invalid_from_step" });
    assert.deepEqual(await listRun(pool, OWNER, parent), { run: null }, "no run is left behind");
    const children = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM pages WHERE parent = $1", [parent]);
    assert.equal(children.rows[0]?.n, "0", "no sub-page is left behind");

    const first = await created(parent);
    await completeAll(first.id);
    const upstream = await pageRow(first.steps[0]!.pageId);

    const rerun = await created(parent, { fromStep: 2 });
    assert.deepEqual(rerun.steps.map((step) => step.state), ["reused", "reused", "queued"]);
    assert.deepEqual(rerun.steps.map((step) => step.pageId), first.steps.map((step) => step.pageId), "the same pages");
    assert.deepEqual(rerun.steps.map((step) => step.stepStatus), ["done", "done", "wait"]);
    assert.deepEqual((await pageRow(first.steps[0]!.pageId))?.blocks, upstream?.blocks, "the upstream result is kept");
    await complete(rerun.id, 2, "作り直した結果");
    assert.equal((await runRow(rerun.id))?.state, "succeeded");
    assert.deepEqual((await pageRow(first.steps[2]!.pageId))?.blocks, paragraph("作り直した結果"));

    // 削除したサブページは、その段階から作り直すと戻る
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [first.steps[2]!.pageId]);
    assert.equal((await createRun(pool, OWNER, parent, { recipe: RECIPE, fromStep: 2 })).status, "created");
    assert.equal((await pageRow(first.steps[2]!.pageId))?.deleted_at, null);
  });

  it("claims a queued attempt exactly once under 20 concurrent claims and advances the generation", async () => {
    const parent = await recording();
    const run = await created(parent);
    const results = await Promise.all(Array.from({ length: 20 }, () => claimAttempt(pool, run.id, 0)));
    const winners = results.filter((result) => result.ok);
    assert.equal(winners.length, 1);
    for (const result of results) if (!result.ok) assert.equal(result.reason, "not_queued");
    const winner = winners[0];
    assert.ok(winner?.ok);
    assert.equal(winner.claim.generation, 1);
    assert.equal(winner.claim.tries, 1);
    assert.equal(winner.claim.owner, OWNER);
    assert.equal(winner.claim.parentId, parent);
    assert.equal(winner.claim.previousPageId, null);

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

  it("keeps the used input chars of a cut source on the committed step only, and clears them on the next claim (#277)", async () => {
    const parent = await recording();
    const run = await created(parent);
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
    const view = (await listRun(pool, OWNER, parent))?.run;
    assert.equal(view?.steps[0]?.inputUsedChars, 100_000);
    assert.equal("inputUsedChars" in (view?.steps[1] ?? {}), false, "a step that was not cut (or not run) carries nothing");
    await complete(run.id, 1);
    await complete(run.id, 2);
    assert.equal("inputUsedChars" in ((await listRun(pool, OWNER, parent))?.run?.steps[1] ?? {}), false);

    const again = await created(parent);
    await claimed(again.id, 0);
    assert.equal((await pool.query<{ input_used_chars: number | null }>("SELECT input_used_chars FROM step_attempts WHERE run_id = $1 AND step_index = 0", [again.id])).rows[0]?.input_used_chars, null);
    assert.equal("inputUsedChars" in ((await listRun(pool, OWNER, parent))?.run?.steps[0] ?? {}), false, "a running step shows nothing");
  });

  it("commits only with the current generation, then queues the next step and finishes the run on the last step", async () => {
    const parent = await recording();
    const run = await created(parent);
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
    const view = (await listRun(pool, OWNER, parent))?.run;
    assert.deepEqual(view?.steps.map((step) => [step.state, step.stepStatus]), [["succeeded", "done"], ["succeeded", "done"], ["succeeded", "done"]]);
  });

  it("does not commit into a sub-page that was deleted while the step ran", async () => {
    const parent = await recording();
    const run = await created(parent);
    const claim = await claimed(run.id, 0);
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [claim.pageId]);
    const result = await commitAttempt(pool, { ...refOf(claim), blocks: paragraph("x"), inputBasis: computeBasis(TRANSCRIPT, RECIPE.steps[0]!.instruction) });
    assert.deepEqual(result, { ok: false, reason: "page_missing" });
    assert.equal((await attemptRow(run.id, 0))?.state, "running", "nothing was written");
  });

  it("retries a retryable failure until MAX_TRIES, then fails the run and cancels the rest", async () => {
    const parent = await recording();
    const run = await created(parent);
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

    const view = (await listRun(pool, OWNER, parent))?.run;
    assert.equal(view?.state, "failed");
    assert.deepEqual(view?.steps.map((step) => [step.state, step.stepStatus, step.errorCode]), [
      ["succeeded", "done", null],
      ["failed", "failed", "model_timeout"],
      ["canceled", "wait", null],
    ]);
    assert.ok((await runRow(run.id))?.finished_at);
    assert.deepEqual((await pageRow(run.steps[0]!.pageId))?.blocks, paragraph("合成の結果 0"), "the upstream result is kept");
  });

  it("書き切れなかったときは、書けたところまでを残す（サブページの本文には書かない。#37）", async () => {
    const parent = await recording();
    const run = await created(parent);
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
    // 失敗した段階のページを半分の本文で埋めない
    assert.deepEqual((await pageRow(claim.pageId))?.blocks, []);
  });

  it("途中出力は本人の最新の失敗 run だけで読み、polling には有無だけを返す", async () => {
    const parent = await recording();
    const run = await created(parent);
    const claim = await claimed(run.id, 0);
    const partial = paragraph("合成の途中出力");
    await failAttempt(pool, { ...refOf(claim), code: "output_too_long", retryable: false, partial });

    const view = (await listRun(pool, OWNER, parent))?.run;
    assert.equal(view?.steps[0]?.hasPartialOutput, true);
    assert.equal(JSON.stringify(view).includes("合成の途中出力"), false);
    assert.deepEqual(await readPartialOutput(pool, OWNER, parent, run.id, 0), partial);
    assert.equal(await readPartialOutput(pool, OTHER, parent, run.id, 0), null);
    assert.equal(await readPartialOutput(pool, OWNER, randomUUID(), run.id, 0), null);
    assert.equal(await readPartialOutput(pool, OWNER, parent, randomUUID(), 0), null);

    const next = await createRun(pool, OWNER, parent, { recipe: RECIPE });
    assert.equal(next.status, "created");
    assert.equal(await readPartialOutput(pool, OWNER, parent, run.id, 0), null, "a new run hides older partial output");
  });

  it("積み直すときは書きかけを残さず、次の claim でも消えている", async () => {
    const parent = await recording();
    const run = await created(parent);
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
    const parent = await recording();
    const run = await created(parent);
    const claim = await claimed(run.id, 0);
    assert.deepEqual(await failAttempt(pool, { ...refOf(claim), code: "invalid_output", retryable: false }), { ok: true, outcome: "failed" });
    const view = (await listRun(pool, OWNER, parent))?.run;
    assert.equal(view?.state, "failed");
    assert.deepEqual(view?.steps.map((step) => [step.state, step.tries]), [["failed", 1], ["canceled", 0], ["canceled", 0]]);
    await assert.rejects(() => failAttempt(pool, { ...refOf(claim), code: "Not A Code", retryable: false }), TypeError);
  });

  it("cancels idempotently, advances the running generation so a late result is refused, and keeps completed sub-pages", async () => {
    const parent = await recording();
    const run = await created(parent);
    await complete(run.id, 0);
    const running = await claimed(run.id, 1);

    const canceled = await cancelRun(pool, OWNER, parent, run.id);
    assert.equal(canceled?.state, "canceled");
    assert.deepEqual(canceled?.steps.map((step) => [step.state, step.stepStatus]), [["succeeded", "done"], ["canceled", "wait"], ["canceled", "wait"]]);
    assert.equal((await attemptRow(run.id, 1))?.generation, running.generation + 1);

    const late = await commitAttempt(pool, { ...refOf(running), blocks: paragraph("遅れた結果"), inputBasis: computeBasis(paragraph("x"), "y") });
    assert.deepEqual(late, { ok: false, reason: "stale_generation" });
    assert.deepEqual((await pageRow(running.pageId))?.blocks, [], "the late result is not written");
    assert.equal(await heartbeatAttempt(pool, refOf(running)), false);
    assert.deepEqual(await failAttempt(pool, { ...refOf(running), code: "internal", retryable: true }), { ok: false, reason: "stale_generation" });
    assert.deepEqual(await claimAttempt(pool, run.id, 1), { ok: false, reason: "run_inactive" });

    assert.deepEqual(await cancelRun(pool, OWNER, parent, run.id), canceled, "cancel is idempotent");
    assert.deepEqual((await pageRow(run.steps[0]!.pageId))?.blocks, paragraph("合成の結果 0"));
    // 取消のあとは新しい run を作れる
    assert.equal((await createRun(pool, OWNER, parent, { recipe: RECIPE })).status, "created");
    // 別の録音ページの path では取り消せない
    assert.equal(await cancelRun(pool, OWNER, await recording(), run.id), null);
  });

  it("extends the lease on heartbeat only for the current generation", async () => {
    const parent = await recording();
    const run = await created(parent);
    const claim = (await claimAttempt(pool, run.id, 0, { leaseSeconds: 30 }));
    assert.ok(claim.ok);
    const before = (await attemptRow(run.id, 0))?.lease_until?.getTime() ?? 0;
    assert.equal(await heartbeatAttempt(pool, refOf(claim.claim), { leaseSeconds: 600 }), true);
    const after = (await attemptRow(run.id, 0))?.lease_until?.getTime() ?? 0;
    assert.ok(after - before > 500_000, "the lease was extended");
    assert.equal(await heartbeatAttempt(pool, { ...refOf(claim.claim), generation: claim.claim.generation + 1 }), false);
  });

  it("sweeps expired leases back to the queue, and to failed (lease_expired) after MAX_TRIES", async () => {
    const parent = await recording();
    const run = await created(parent);
    const expire = () => pool.query("UPDATE step_attempts SET lease_until = clock_timestamp() - interval '1 second' WHERE run_id = $1 AND state = 'running'", [run.id]);

    const live = await recording();
    const liveRun = await created(live);
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
    const view = (await listRun(pool, OWNER, parent))?.run;
    assert.equal(view?.state, "failed");
    assert.deepEqual(view?.steps.map((step) => [step.state, step.stepStatus, step.errorCode]), [
      ["failed", "failed", "lease_expired"],
      ["canceled", "wait", null],
      ["canceled", "wait", null],
    ]);
    assert.equal((await attemptRow(liveRun.id, 0))?.state, "running");
  });

  it("marks downstream sub-pages stale when an upstream page changes, and done again when it is restored", async () => {
    const parent = await recording();
    const run = await created(parent);
    await completeAll(run.id);
    const [first, second, third] = run.steps.map((step) => step.pageId) as [string, string, string];
    const statuses = async () => Promise.all([first, second, third].map(async (id) => (await pageRow(id))?.step_status));

    assert.equal(await refreshStale(pool, OWNER, parent, RECIPE), 0);
    assert.deepEqual(await statuses(), ["done", "done", "done"]);

    await userEdit(OWNER, first, paragraph("直した結果 0"));
    assert.equal(await refreshStale(pool, OWNER, parent, RECIPE), 2);
    assert.deepEqual(await statuses(), ["done", "stale", "stale"]);
    assert.equal((await listRun(pool, OWNER, parent))?.run?.steps[1]?.stepStatus, "stale");
    await userEdit(OWNER, first, paragraph("合成の結果 0"));
    assert.equal(await refreshStale(pool, OWNER, parent, RECIPE), 2);
    assert.deepEqual(await statuses(), ["done", "done", "done"]);

    await userEdit(OWNER, parent, paragraph("直した文字起こし"));
    await refreshStale(pool, OWNER, parent, RECIPE);
    assert.deepEqual(await statuses(), ["stale", "stale", "stale"]);
    await userEdit(OWNER, parent, TRANSCRIPT);
    await refreshStale(pool, OWNER, parent, RECIPE);
    assert.deepEqual(await statuses(), ["done", "done", "done"]);

    await userEdit(OWNER, second, paragraph("直した結果 1"));
    await refreshStale(pool, OWNER, parent, RECIPE);
    assert.deepEqual(await statuses(), ["done", "done", "stale"]);
    // 前提が変わった段階から作り直すと、新しい基準が記録されて印が消える
    const rerun = await created(parent, { fromStep: 2 });
    await completeAll(rerun.id, 2);
    await refreshStale(pool, OWNER, parent, RECIPE);
    assert.deepEqual(await statuses(), ["done", "done", "done"]);
  });

  it("uses an empty background when the recording has no fields of its own", async () => {
    const parent = await recording();
    const input = await readStepInput(pool, { owner: OWNER, parentId: parent, previousPageId: null });
    assert.deepEqual(input?.parentBlocks, TRANSCRIPT);
    assert.equal(input?.background, "");
    assert.deepEqual(input?.fields, { entities: [], terms: [] });
  });

  it("reads all upstream, the recording's own fields, settings and ordered references; explains each changed input", async () => {
    const folder = (await store.createPage(OWNER, { kind: "folder", title: "合成フォルダ" })).id;
    const parent = await recording();
    await pool.query("UPDATE pages SET parent = $2 WHERE id = $1", [parent, folder]);
    const reference = (await store.createPage(OWNER, { title: "初期の題名", blocks: paragraph("参考本文") })).id;
    await pool.query("UPDATE pages SET parent = $2 WHERE id = $1", [reference, folder]);
    // 欄は録音ページ自身の id で持つ（フォルダの id の行は読まない）
    await pool.query("INSERT INTO page_fields(owner,page_id,entities,background) VALUES ($1,$2,$3::jsonb,'合成の背景情報')", [OWNER, parent, JSON.stringify([{ name: "合成人物", reading: "", role: "取材相手", note: "" }])]);
    await pool.query("INSERT INTO page_fields(owner,page_id,entities,background) VALUES ($1,$2,$3::jsonb,'フォルダの古い背景')", [OWNER, folder, JSON.stringify([{ name: "フォルダの人物", reading: "", role: "", note: "" }])]);
    await pool.query("INSERT INTO editor_settings(owner,ai_lang,about) VALUES ($1,'en','合成の説明') ON CONFLICT(owner) DO UPDATE SET ai_lang = 'en', about = '合成の説明'", [OWNER]);
    const run = await created(parent);
    await completeAll(run.id);
    const input = await readStepInput(pool, { owner: OWNER, parentId: parent, recipe: RECIPE.id, stepIndex: 2, previousPageId: run.steps[1]!.pageId, stepIds: RECIPE.steps.map((step) => step.id) });
    assert.deepEqual(input?.upstream.map((item) => item.id), ["aaaa1111", "bbbb2222"]);
    assert.deepEqual(input?.parentBlocks, TRANSCRIPT);
    assert.equal(input?.background, "合成の背景情報");
    assert.deepEqual(input?.refs.map((item) => item.id), [reference]);
    assert.equal(input?.fields.entities[0]?.name, "合成人物");
    assert.equal(input?.settings.aiLang, "en");
    assert.deepEqual((await readStepStaleReasons(pool, OWNER, parent, RECIPE))[2], []);

    await pool.query("UPDATE page_fields SET background = '変更した合成の背景情報' WHERE owner = $1 AND page_id = $2", [OWNER, parent]);
    assert.equal(await refreshStale(pool, OWNER, parent, RECIPE), 3);
    assert.deepEqual((await readStepStaleReasons(pool, OWNER, parent, RECIPE))[2], ["info"]);
    await pool.query("UPDATE page_fields SET background = '合成の背景情報' WHERE owner = $1 AND page_id = $2", [OWNER, parent]);
    assert.equal(await refreshStale(pool, OWNER, parent, RECIPE), 3);
    assert.deepEqual((await readStepStaleReasons(pool, OWNER, parent, RECIPE))[2], []);

    await pool.query("UPDATE pages SET title = '新しい題名' WHERE id = $1", [reference]);
    assert.equal(await refreshStale(pool, OWNER, parent, RECIPE), 0);
    await userEdit(OWNER, reference, paragraph("変更した参考本文"));
    assert.equal(await refreshStale(pool, OWNER, parent, RECIPE), 3);
    assert.deepEqual((await readStepStaleReasons(pool, OWNER, parent, RECIPE))[2], ["refs"]);
    await userEdit(OWNER, reference, paragraph("参考本文"));
    await refreshStale(pool, OWNER, parent, RECIPE);
    await pool.query("UPDATE page_fields SET terms = $3::jsonb WHERE owner = $1 AND page_id = $2", [OWNER, parent, JSON.stringify([{ term: "合成語", reading: "", variants: [], note: "" }])]);
    await refreshStale(pool, OWNER, parent, RECIPE);
    assert.deepEqual((await readStepStaleReasons(pool, OWNER, parent, RECIPE))[2], ["info"]);
    await pool.query("UPDATE page_fields SET terms = '[]'::jsonb WHERE owner = $1 AND page_id = $2", [OWNER, parent]);
    await pool.query("UPDATE editor_settings SET about = '変更' WHERE owner = $1", [OWNER]);
    await refreshStale(pool, OWNER, parent, RECIPE);
    assert.deepEqual((await readStepStaleReasons(pool, OWNER, parent, RECIPE))[2], ["info"]);
    await pool.query("UPDATE editor_settings SET about = '合成の説明' WHERE owner = $1", [OWNER]);
    const guide = { ...RECIPE, guide: "変更したガイド" };
    assert.deepEqual((await readStepStaleReasons(pool, OWNER, parent, guide))[2], ["guide"]);
    const instruction = { ...RECIPE, steps: RECIPE.steps.map((step, index) => index === 1 ? { ...step, instruction: "変更した指示" } : step) };
    assert.deepEqual((await readStepStaleReasons(pool, OWNER, parent, instruction))[2], ["step"]);
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [run.steps[0]!.pageId]);
    const afterDelete = await readStepInput(pool, { owner: OWNER, parentId: parent, recipe: RECIPE.id, stepIndex: 2, previousPageId: run.steps[1]!.pageId, stepIds: RECIPE.steps.map((step) => step.id) });
    assert.deepEqual(afterDelete?.upstream[0]?.blocks, []);
  });

  it("treats a legacy digest as unrecorded after the jsonb migration", async () => {
    const parent = await recording();
    const run = await created(parent);
    const claim = await claimed(run.id, 0);
    assert.deepEqual(await commitAttempt(pool, { ...refOf(claim), blocks: paragraph("旧版の結果"), inputBasis: "a".repeat(64) }), { ok: true, next: 1 });
    await userEdit(OWNER, parent, paragraph("変更した原文"));
    assert.equal(await refreshStale(pool, OWNER, parent, RECIPE), 0);
    assert.deepEqual((await readStepStaleReasons(pool, OWNER, parent, RECIPE))[0], []);
  });

  it("guards the refresh's write with the row version (xmin), so a row changed after the read is not overwritten", async () => {
    const parent = await recording();
    const run = await created(parent);
    await completeAll(run.id);
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
    const parent = await recording();
    const run = await created(parent);
    await complete(run.id, 0);
    await userEdit(OWNER, parent, paragraph("直した文字起こし"));

    assert.equal(await listRun(pool, OTHER, parent), null);
    assert.equal(await cancelRun(pool, OTHER, parent, run.id), null);
    assert.deepEqual(await createRun(pool, OTHER, parent, { recipe: RECIPE }), { status: "not_found" });
    assert.equal(await refreshStale(pool, OTHER, parent, RECIPE), 0);
    assert.equal((await pageRow(run.steps[0]!.pageId))?.step_status, "done", "another owner's refresh changes nothing");
    assert.equal(await readStepInput(pool, { owner: OTHER, parentId: parent, previousPageId: null }), null);
    assert.equal((await runRow(run.id))?.state, "running");
  });

  it("bumps the revision when a step writes the page, so a stale save from the user becomes a conflict (#58)", async () => {
    const parent = await recording();
    const run = await created(parent);
    const subPage = run.steps[0]!.pageId;
    const before = await store.getPage(OWNER, subPage);
    assert.ok(before);
    await complete(run.id, 0);
    const after = await store.getPage(OWNER, subPage);
    assert.equal(after?.revision, before.revision + 1);
    // 利用者が結果を見る前の revision のまま保存しても、worker の結果を黙って上書きしない
    const stale = await store.savePage(OWNER, subPage, { blocks: paragraph("利用者の古い画面からの保存") }, { baseRevision: before.revision });
    assert.equal(stale?.status, "conflict");
    assert.deepEqual((await store.getPage(OWNER, subPage))?.blocks, paragraph("合成の結果 0"));
  });

  it("keeps the body it replaces as an ai version when a rerun overwrites a sub-page, but not on the first generation", async () => {
    const parent = await recording();
    const first = await created(parent);
    const subPage = first.steps[0]!.pageId;
    const versions = async () =>
      (await pool.query<{ version: number; reason: string; blocks: Block[] }>("SELECT version, reason, blocks FROM page_versions WHERE page_id = $1 ORDER BY version", [subPage])).rows;
    await completeAll(first.id);
    assert.deepEqual(await versions(), [], "the first generation replaces an empty body: nothing to keep");

    // 利用者がサブページを直してから、その段階を作り直す
    await userEdit(OWNER, subPage, paragraph("利用者が直した内容"));
    const rerun = await created(parent, { fromStep: 0 });
    await complete(rerun.id, 0, "作り直した結果");
    // 利用者の保存（#58 の savePage）が残す autosave の版とは別に、作り直しが ai の版を 1 つ残す
    const kept = (await versions()).filter((version) => version.reason === "ai");
    assert.equal(kept.length, 1);
    assert.deepEqual(kept[0]?.blocks, paragraph("利用者が直した内容"), "the user's edit survives in the history");
    assert.deepEqual((await store.getPage(OWNER, subPage))?.blocks, paragraph("作り直した結果"));
  });

  it("lets pages that carry step records be hard-deleted (the trash purge), taking the records with them", async () => {
    const parent = await recording();
    const run = await created(parent);
    await complete(run.id, 0);
    const count = async (sql: string, id: string) => Number((await pool.query<{ n: string }>(sql, [id])).rows[0]?.n);
    assert.equal(await count("SELECT count(*)::text AS n FROM step_attempts WHERE run_id = $1", run.id), 3);

    // 出力のサブページを消す（子が先）: その段階の記録も消える。外部キーで止まらない
    await pool.query("DELETE FROM pages WHERE parent = $1", [parent]);
    assert.equal(await count("SELECT count(*)::text AS n FROM step_attempts WHERE run_id = $1", run.id), 0);
    assert.equal(await count("SELECT count(*)::text AS n FROM step_runs WHERE id = $1", run.id), 1);

    // 録音ページを消す: run も一緒に消える
    await pool.query("DELETE FROM pages WHERE id = $1", [parent]);
    assert.equal(await count("SELECT count(*)::text AS n FROM step_runs WHERE id = $1", run.id), 0);
  });

  it("keeps the step tables' invariants even when the functions are bypassed", async () => {
    const parent = await recording();
    const run = await created(parent);
    const theirs = await recording(OTHER);
    await assert.rejects(() => pool.query("INSERT INTO step_runs (owner, parent, recipe, recipe_snapshot, recipe_revision) VALUES ($1, $2, 'tpl-1', '{}'::jsonb, 1)", [OWNER, theirs]), { code: "23503" });
    await assert.rejects(() => pool.query("UPDATE step_runs SET state = 'paused' WHERE id = $1", [run.id]), { code: "23514" });
    await assert.rejects(() => pool.query("UPDATE step_runs SET idempotency_key = $2 WHERE id = $1", [run.id, "k".repeat(129)]), { code: "23514" });
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
    const parent = (await store.createPage(OWNER, { kind: "rec", title: "合成の録音", blocks: TRANSCRIPT })).id;
    const result = await createRun(pool, OWNER, parent, { recipe: RECIPE });
    assert.ok(result.status === "created");
    return { parent, run: result.run };
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
    const parent = (await store.createPage(OWNER, { kind: "rec", title: "合成の録音", blocks: TRANSCRIPT })).id;
    const result = await createRun(pool, OWNER, parent, { recipe: CHUNKED });
    assert.ok(result.status === "created");
    return { parent, run: result.run };
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
    const { parent, run } = await setup();
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

    // 文字起こしを直すと、やり直せない（最初から作り直す）
    const page = await store.getPage(OWNER, parent);
    assert.ok(page);
    assert.equal((await store.savePage(OWNER, parent, { blocks: paragraph("直した文字起こし") }, { baseRevision: page.revision }))?.status, "saved");
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
    const newer = await createRun(pool, OWNER, other.parent, { recipe: CHUNKED });
    assert.equal(newer.status, "created");
    assert.equal((await resumeRun(pool, OWNER, other.parent, other.run.id)).status, "run_in_progress");
    assert.ok(newer.status === "created");
    await cancelRun(pool, OWNER, other.parent, newer.run.id);
    assert.equal((await resumeRun(pool, OWNER, other.parent, other.run.id)).status, "not_resumable", "a newer run exists");
  });
});
