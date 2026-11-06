import { describe, expect, it, vi } from "vitest";
import { StepError, createFakeExecutor, fakeExecutor, type StepExecutor } from "./executor";
import { MemoryStepRunStore } from "./memory-store";
import { MemoryTaskQueue, taskName } from "./queue";
import { DEFAULT_RECIPES, findRecipeIn, recipesOf } from "./recipes";
import { runAttempt, type AttemptOutcome, type RunnerDeps } from "./runner";

// 合成の値だけを使う
const OWNER = "synthetic-owner-a";
const transcript = [{ type: "paragraph", content: [{ type: "text", text: "合成の座談会の文字起こし" }] }];
const tpl1 = findRecipeIn(DEFAULT_RECIPES, "tpl-1")!;

async function setup(executor: StepExecutor = fakeExecutor, extra: Partial<RunnerDeps> = {}) {
  const store = new MemoryStepRunStore();
  const queue = new MemoryTaskQueue();
  const parent = store.addPage(OWNER, { kind: "rec", blocks: transcript });
  const deps: RunnerDeps = { store, recipes: async () => DEFAULT_RECIPES, executor, queue, ...extra };
  const start = async (fromStep = 0, recipe = tpl1) => {
    const result = await store.createRun(OWNER, parent, { recipe, fromStep });
    if (result.status !== "created") throw new Error(result.status);
    await queue.enqueue({ name: taskName(result.run.id, fromStep, 0), runId: result.run.id, stepIndex: fromStep });
    return result.run;
  };
  /** 積まれた task を空になるまで実行する（再試行の間隔は待たない）。 */
  const drainAll = async () => {
    const outcomes: AttemptOutcome[] = [];
    for (let tasks = queue.drain(); tasks.length > 0; tasks = queue.drain()) {
      for (const task of tasks) outcomes.push(await runAttempt(deps, task));
    }
    return outcomes;
  };
  const view = async () => (await store.listRun(OWNER, parent))?.run;
  return { store, queue, parent, deps, start, drainAll, view };
}

describe("runAttempt", () => {
  it("keeps the recording's own background separate and marks completed steps info-stale when it changes", async () => {
    const seen: { source: unknown; background: unknown }[] = [];
    const executor: StepExecutor = { run: async (input) => {
      seen.push({ source: input.parentBlocks, background: input.background });
      return fakeExecutor.run(input);
    } };
    const { store, parent, start, drainAll } = await setup(executor);
    store.fields.set(parent, { entities: [], terms: [], background: "合成の背景" });
    await start();
    await drainAll();
    expect(seen[0]).toEqual({ source: transcript, background: "合成の背景" });
    store.fields.set(parent, { entities: [], terms: [], background: "変更した背景" });
    expect(await store.refreshStale(OWNER, parent, tpl1)).toBe(tpl1.steps.length);
    expect((await store.readStaleReasons(OWNER, parent, tpl1))[2]).toEqual(["info"]);
  });

  it("runs tpl-1 to the end and leaves its three sub-pages done", async () => {
    const { store, start, drainAll, view } = await setup();
    await start();
    expect(await drainAll()).toEqual([
      { status: "completed", next: 1 },
      { status: "completed", next: 2 },
      { status: "completed" },
    ]);
    const run = await view();
    expect(run?.state).toBe("succeeded");
    expect(run?.steps.map((step) => [step.state, step.stepStatus, step.tries])).toEqual([
      ["succeeded", "done", 1],
      ["succeeded", "done", 1],
      ["succeeded", "done", 1],
    ]);
    for (const [index, step] of (run?.steps ?? []).entries()) {
      const text = JSON.stringify(store.pages.get(step.pageId)?.blocks);
      expect(text).toContain("[fake]");
      expect(text).toContain(tpl1.steps[index]!.name);
    }
    // 次の段階は前の段階の結果を読む
    expect(JSON.stringify(store.pages.get(run!.steps[1]!.pageId)?.blocks)).toContain("[fake] 文字起こし修正");
  });

  it("runs the recipe captured at start even if the reader changes before the claim", async () => {
    const edited = recipesOf([{ id: "tpl-1", name: "記事制作", guide: "お手本を替えた", steps: tpl1.steps.map((step) => ({ ...step, name: `${step.name}（短め）` })) }]);
    const { store, start, drainAll, view } = await setup(fakeExecutor, {
      recipes: async () => { throw new Error("runner must not read current recipes"); },
    });
    await start(0, edited[0]!);
    await drainAll();
    const run = await view();
    expect(run?.state).toBe("succeeded");
    expect(JSON.stringify(store.pages.get(run!.steps[0]!.pageId)?.blocks)).toContain("[fake] 文字起こし修正（短め）");
  });

  it("fails closed without retrying if the persisted snapshot is malformed", async () => {
    const { store, start, queue, deps, view } = await setup(fakeExecutor);
    const created = await start();
    store.runs.get(created.id)!.recipeSnapshot = null as never;
    expect(await runAttempt(deps, queue.drain()[0]!)).toEqual({ status: "failed" });
    expect((await view())?.steps[0]?.errorCode).toBe("invalid_snapshot");
  });

  it("fails a middle step after three failures and keeps the upstream result", async () => {
    const executor: StepExecutor = {
      run: (input) => (input.stepIndex === 1 ? Promise.reject(new StepError("model_timeout", true)) : fakeExecutor.run(input)),
    };
    const { store, queue, start, deps, view } = await setup(executor);
    const run = await start();
    expect(await runAttempt(deps, queue.drain()[0]!)).toEqual({ status: "completed", next: 1 });
    const upstream = structuredClone(store.pages.get(run.steps[0]!.pageId)?.blocks);

    const retries = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [task] = queue.drain();
      expect(task?.stepIndex).toBe(1);
      retries.push([task?.name, task?.delaySeconds]);
      const outcome = await runAttempt(deps, task!);
      expect(outcome.status).toBe(attempt < 3 ? "retry" : "failed");
    }
    // 世代の入った名前で積み直し、間隔は指数的に空ける
    expect(retries).toEqual([
      [taskName(run.id, 1, 0), undefined],
      [taskName(run.id, 1, 1), 10],
      [taskName(run.id, 1, 2), 20],
    ]);
    expect(queue.size).toBe(0);
    const failed = await view();
    expect(failed?.state).toBe("failed");
    expect(failed?.steps.map((step) => [step.state, step.stepStatus, step.errorCode])).toEqual([
      ["succeeded", "done", null],
      ["failed", "failed", "model_timeout"],
      ["canceled", "wait", null],
    ]);
    expect(store.pages.get(run.steps[0]!.pageId)?.blocks).toEqual(upstream);
  });

  it("書き切れなかったときは、書けたところまでを残す（サブページの本文には書かない。#37）", async () => {
    const partial = [{ type: "paragraph", content: [{ type: "text", text: "書けたところまで" }] }];
    const executor: StepExecutor = { run: () => Promise.reject(new StepError("output_too_long", false, partial)) };
    const { store, queue, start, deps, view } = await setup(executor);
    const run = await start();
    expect((await runAttempt(deps, queue.drain()[0]!)).status).toBe("failed");
    expect(store.partialOf(run.id, 0)).toEqual(partial);
    // 失敗した段階のページを半分の本文で埋めない
    expect(store.pages.get(run.steps[0]!.pageId)?.blocks).toEqual([]);
    expect((await view())?.steps[0]?.errorCode).toBe("output_too_long");
  });

  it("もう一度積み直すときは、書きかけを残さない（次の試行が書き直す）", async () => {
    const partial = [{ type: "paragraph", content: [{ type: "text", text: "途中" }] }];
    const executor: StepExecutor = { run: () => Promise.reject(new StepError("ai_timeout", true, partial)) };
    const { store, queue, start, deps } = await setup(executor);
    const run = await start();
    expect((await runAttempt(deps, queue.drain()[0]!)).status).toBe("retry");
    expect(store.partialOf(run.id, 0)).toBeNull();
  });

  it("rebuilds from fromStep and reuses the upstream sub-pages", async () => {
    const executor = createFakeExecutor();
    const { store, start, drainAll, view } = await setup(executor);
    const first = await start();
    await drainAll();
    const upstream = [0, 1].map((index) => structuredClone(store.pages.get(first.steps[index]!.pageId)?.blocks));

    const rerun = await start(2);
    expect(rerun.steps.map((step) => step.state)).toEqual(["reused", "reused", "queued"]);
    expect(await drainAll()).toEqual([{ status: "completed" }]);
    expect(executor.calls).toBe(4);
    const run = await view();
    expect(run?.id).toBe(rerun.id);
    expect(run?.steps.map((step) => step.pageId)).toEqual(first.steps.map((step) => step.pageId));
    expect([0, 1].map((index) => store.pages.get(first.steps[index]!.pageId)?.blocks)).toEqual(upstream);
    expect(run?.steps.map((step) => step.stepStatus)).toEqual(["done", "done", "done"]);
  });

  it("ignores the result of an older generation (cancelled while the step ran)", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const executor: StepExecutor = { run: async (input) => (await gate, fakeExecutor.run(input)) };
    const { store, queue, parent, start, deps, view } = await setup(executor);
    const run = await start();
    const running = runAttempt(deps, queue.drain()[0]!);
    await vi.waitFor(() => expect(store.runs.get(run.id)?.attempts[0]?.state).toBe("running"));
    await store.cancelRun(OWNER, parent, run.id);
    release();
    expect(await running).toEqual({ status: "stale" });
    expect(store.pages.get(run.steps[0]!.pageId)?.blocks).toEqual([]);
    expect((await view())?.steps.map((step) => [step.state, step.stepStatus])).toEqual([["canceled", "wait"], ["canceled", "wait"], ["canceled", "wait"]]);
    expect(queue.size).toBe(0);
  });

  it("ignores a late result after the step was claimed again by a newer generation", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const executor: StepExecutor = {
      run: async () => {
        const call = ++calls;
        if (call === 1) await gate;
        return { blocks: [{ type: "paragraph", content: [{ type: "text", text: `合成の結果 ${call}` }] }] };
      },
    };
    const { store, queue, start, deps, view } = await setup(executor);
    const run = await start();
    const stalled = runAttempt(deps, queue.drain()[0]!);
    await vi.waitFor(() => expect(store.runs.get(run.id)?.attempts[0]?.state).toBe("running"));
    // lease が切れて掃除が queued に戻したのと同じ状態にし、別の実行が新しい世代で取り直して確定する
    const attempt = store.runs.get(run.id)!.attempts[0]!;
    attempt.state = "queued";
    attempt.leaseUntil = null;
    expect(await runAttempt(deps, { runId: run.id, stepIndex: 0 })).toEqual({ status: "completed", next: 1 });
    expect(attempt.generation).toBe(2);
    release();
    expect(await stalled).toEqual({ status: "stale" });
    expect(store.pages.get(run.steps[0]!.pageId)?.blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "合成の結果 2" }] }]);
    expect((await view())?.steps[0]).toMatchObject({ state: "succeeded", tries: 2 });
  });

  it("keeps extending the lease while the step runs and stops the heartbeat on completion", async () => {
    const { store, queue, start, deps } = await setup(createFakeExecutor({ delayMs: 400 }), { leaseSeconds: 0.15 });
    const run = await start();
    const original = store.heartbeatAttempt;
    const leases: number[] = [];
    const heartbeat = vi.spyOn(store, "heartbeatAttempt").mockImplementation(async (ref, options) => {
      const alive = await original(ref, options);
      leases.push(store.runs.get(ref.runId)!.attempts[ref.stepIndex]!.leaseUntil ?? 0);
      return alive;
    });
    const running = runAttempt(deps, queue.drain()[0]!);
    await vi.waitFor(() => expect(store.runs.get(run.id)?.attempts[0]?.state).toBe("running"));
    const claimedLease = store.runs.get(run.id)!.attempts[0]!.leaseUntil!;
    expect(await running).toEqual({ status: "completed", next: 1 });
    // lease の 1/3（50ms）おきに延ばし、どれも claim の lease より後まで延びている
    expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(leases.every((lease) => lease > claimedLease)).toBe(true);
    expect(leases).toEqual([...leases].sort((a, b) => a - b));
    const calls = heartbeat.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(heartbeat.mock.calls.length).toBe(calls);
  });

  it("stops the step when the heartbeat finds the lease lost (cancelled)", async () => {
    const { store, queue, parent, start, deps } = await setup(createFakeExecutor({ delayMs: 10_000 }), { leaseSeconds: 0.15 });
    const run = await start();
    const running = runAttempt(deps, queue.drain()[0]!);
    await vi.waitFor(() => expect(store.runs.get(run.id)?.attempts[0]?.state).toBe("running"));
    await store.cancelRun(OWNER, parent, run.id);
    const cancelledAt = Date.now();
    expect(await running).toEqual({ status: "stale" });
    expect(Date.now() - cancelledAt).toBeLessThan(1_000);
    expect(store.pages.get(run.steps[0]!.pageId)?.blocks).toEqual([]);
  });

  it("records unexpected exceptions as a retryable internal error without their message", async () => {
    const executor = createFakeExecutor({ failures: 1, error: () => new Error("synthetic secret detail") });
    const { store, queue, start, deps } = await setup(executor);
    const run = await start();
    expect(await runAttempt(deps, queue.drain()[0]!)).toEqual({ status: "retry" });
    const attempt = store.runs.get(run.id)?.attempts[0];
    expect(attempt?.errorCode).toBe("internal");
    expect(attempt?.state).toBe("queued");
    expect(JSON.stringify([...store.runs.values()])).not.toContain("secret");
  });

  it("keeps what it wrote in the record, but never in the subpage, the code or the log", async () => {
    // #138 は書けた分を `step_attempts.partial_blocks` に残す。**サブページの本文には書かない**
    const partial = [{ type: "paragraph", content: [{ type: "text", text: "合成の書けた本文" }] }];
    const executor: StepExecutor = {
      run: async () => {
        throw new StepError("output_too_long", false, partial);
      },
    };
    const { store, queue, start, deps, view } = await setup(executor);
    const run = await start();
    expect(await runAttempt(deps, queue.drain()[0]!)).toEqual({ status: "failed" });
    expect(store.partialOf(run.id, 0)).toEqual(partial);
    expect((await view())?.steps[0]).toMatchObject({ state: "failed", errorCode: "output_too_long" });
    // サブページの本文は空のまま（中途半端な文書を黙って入れない）
    expect(store.pages.get(run.steps[0]!.pageId)?.blocks).toEqual([]);
    // 失敗の code と文には本文が入らない
    expect(new StepError("output_too_long", false, partial).message).toBe("step failed: output_too_long");
  });

  it("fails at once on output that is not blocks, and skips a duplicated task", async () => {
    const executor: StepExecutor = { run: async () => ({ blocks: [{ text: "no type" }] as never }) };
    const { queue, start, deps, view } = await setup(executor);
    const run = await start();
    const [task] = queue.drain();
    expect(await runAttempt(deps, task!)).toEqual({ status: "failed" });
    expect(await runAttempt(deps, task!)).toEqual({ status: "skipped" });
    expect((await view())?.steps[0]).toMatchObject({ state: "failed", errorCode: "invalid_output", stepStatus: "failed" });
    expect(run.state).toBe("queued");
  });
});
