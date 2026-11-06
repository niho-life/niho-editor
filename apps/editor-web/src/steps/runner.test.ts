import { describe, expect, it, vi } from "vitest";
import { stepBlocksText } from "@niho/editor-store";
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
  // run の親はフォルダ、入力はその中の録音のタブ（#309）。`parent` は録音のタブ（資料・欄はそこ）、`folder` が run の親
  const folder = store.addFolder(OWNER);
  const parent = store.addPage(OWNER, { kind: "rec", blocks: transcript, parent: folder });
  const deps: RunnerDeps = { store, recipes: async () => DEFAULT_RECIPES, executor, queue, ...extra };
  /** 入力のタブ（既定は録音）から段階 `toStep`（既定は最後）まで作って、最初の段階を積む。 */
  const start = async (input: { from?: string; toStep?: number } = {}, recipe = tpl1) => {
    const result = await store.createRun(OWNER, folder, { recipe, inputTab: input.from ?? parent, toStep: input.toStep ?? recipe.steps.length - 1 });
    if (result.status !== "created") throw new Error(result.status);
    await queue.enqueue({ name: taskName(result.run.id, result.run.fromStep, 0), runId: result.run.id, stepIndex: result.run.fromStep });
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
  const view = async () => (await store.listRun(OWNER, folder))?.run;
  return { store, queue, parent, folder, deps, start, drainAll, view };
}

describe("runAttempt", () => {
  it("keeps the recording's own background separate and marks completed steps info-stale when it changes", async () => {
    const seen: { source: unknown; background: unknown }[] = [];
    const executor: StepExecutor = { run: async (input) => {
      seen.push({ source: input.parentBlocks, background: input.background });
      return fakeExecutor.run(input);
    } };
    const { store, parent, folder, start, drainAll } = await setup(executor);
    store.fields.set(parent, { entities: [], terms: [], background: "合成の背景" });
    await start();
    await drainAll();
    expect(seen[0]).toEqual({ source: transcript, background: "合成の背景" });
    store.fields.set(parent, { entities: [], terms: [], background: "変更した背景" });
    expect(await store.refreshStale(OWNER, folder, tpl1)).toBe(tpl1.steps.length);
    expect((await store.readStaleReasons(OWNER, folder, tpl1))[2]).toEqual(["info"]);
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
    await start({}, edited[0]!);
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

  it("資料を切ったときは、使った字数を確定した段階に残す（#277）", async () => {
    const executor: StepExecutor = {
      run: async (input) => ({ ...(await fakeExecutor.run(input)), ...(input.stepIndex === 1 ? { inputUsedChars: 100_000 } : {}) }),
    };
    const { start, drainAll, view } = await setup(executor);
    await start();
    await drainAll();
    expect((await view())?.steps.map((step) => step.inputUsedChars)).toEqual([undefined, 100_000, undefined]);
  });

  it("もう一度積み直すときは、書きかけを残さない（次の試行が書き直す）", async () => {
    const partial = [{ type: "paragraph", content: [{ type: "text", text: "途中" }] }];
    const executor: StepExecutor = { run: () => Promise.reject(new StepError("ai_timeout", true, partial)) };
    const { store, queue, start, deps } = await setup(executor);
    const run = await start();
    expect((await runAttempt(deps, queue.drain()[0]!)).status).toBe("retry");
    expect(store.partialOf(run.id, 0)).toBeNull();
  });

  it("starts again from a step's output tab: only the later step runs, into a new tab of the same role page, and the upstream tabs are untouched (#309)", async () => {
    const executor = createFakeExecutor();
    const { store, start, drainAll, view } = await setup(executor);
    const first = await start();
    await drainAll();
    const upstream = [0, 1].map((index) => structuredClone(store.pages.get(first.steps[index]!.pageId)?.blocks));

    const rerun = await start({ from: first.steps[1]!.pageId });
    expect(rerun.fromStep).toBe(2);
    expect(rerun.steps.map((step) => [step.index, step.state])).toEqual([[2, "queued"]]);
    expect(await drainAll()).toEqual([{ status: "completed" }]);
    expect(executor.calls).toBe(4);
    const run = await view();
    expect(run?.id).toBe(rerun.id);
    const made = run!.steps[0]!.pageId;
    expect(made).not.toBe(first.steps[2]!.pageId);
    expect(store.pages.get(made)?.page).toBe(store.pages.get(first.steps[2]!.pageId)?.page);
    expect(store.pages.get(made)?.madeFrom).toEqual({ kind: "step", run: rerun.id, input: first.steps[1]!.pageId, inputRevision: 2 });
    expect([0, 1].map((index) => store.pages.get(first.steps[index]!.pageId)?.blocks)).toEqual(upstream);
    expect(run?.steps.map((step) => step.stepStatus)).toEqual(["done"]);
  });

  it("ignores the result of an older generation (cancelled while the step ran)", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const executor: StepExecutor = { run: async (input) => (await gate, fakeExecutor.run(input)) };
    const { store, queue, folder, start, deps, view } = await setup(executor);
    const run = await start();
    const running = runAttempt(deps, queue.drain()[0]!);
    await vi.waitFor(() => expect(store.runs.get(run.id)?.attempts[0]?.state).toBe("running"));
    await store.cancelRun(OWNER, folder, run.id);
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
    const { store, queue, folder, start, deps } = await setup(createFakeExecutor({ delayMs: 10_000 }), { leaseSeconds: 0.15 });
    const run = await start();
    const running = runAttempt(deps, queue.drain()[0]!);
    await vi.waitFor(() => expect(store.runs.get(run.id)?.attempts[0]?.state).toBe("running"));
    await store.cancelRun(OWNER, folder, run.id);
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

describe("runAttempt with chunks (#277)", () => {
  // 1 段落 1,000 字。15 段落で 1 区切り（約 1.6 万字）
  const longTranscript = (paragraphs: number) =>
    Array.from({ length: paragraphs }, (_, index) => ({ type: "paragraph", content: [{ type: "text", text: `段落${index}`.padEnd(1000, "話") }] }));

  async function chunkSetup(executor: StepExecutor, paragraphs = 75) {
    const ctx = await setup(executor);
    ctx.store.pages.get(ctx.parent)!.blocks = longTranscript(paragraphs);
    return ctx;
  }

  /** 実行器に渡った区切りを覚える偽物（`fail(index, call)` が投げるものを決める）。 */
  function recordingExecutor(fail?: (chunkIndex: number, call: number) => unknown) {
    const seen: { stepIndex: number; chunk?: { index: number; count: number; text: string; previousTail: string } }[] = [];
    const executor: StepExecutor = {
      run: async (input) => {
        seen.push({ stepIndex: input.stepIndex, ...(input.chunk ? { chunk: { ...input.chunk } } : {}) });
        if (input.chunk && fail) {
          const calls = seen.filter((item) => item.chunk?.index === input.chunk!.index).length;
          const error = fail(input.chunk.index, calls);
          if (error) throw error;
        }
        return fakeExecutor.run(input);
      },
    };
    return { executor, seen };
  }

  it("rewrites a long transcript chunk by chunk and commits the whole text as one version", async () => {
    const { executor, seen } = recordingExecutor();
    const { store, start, drainAll, view, parent } = await chunkSetup(executor);
    await start();
    expect(await drainAll()).toEqual([
      { status: "chunk" }, { status: "chunk" }, { status: "chunk" }, { status: "chunk" },
      { status: "completed", next: 1 },
      { status: "completed", next: 2 },
      { status: "completed" },
    ]);
    const chunks = seen.filter((item) => item.stepIndex === 0).map((item) => item.chunk!);
    expect(chunks.map((chunk) => [chunk.index, chunk.count])).toEqual([[0, 5], [1, 5], [2, 5], [3, 5], [4, 5]]);
    // 区切りをつなぐと元の全文（先頭だけにならない）
    expect(chunks.map((chunk) => chunk.text).join("\n\n")).toBe(stepBlocksText(store.pages.get(parent)!.blocks));
    // 次の区切りには直前の区切りの出力の末尾を添える
    expect(chunks[0]!.previousTail).toBe("");
    expect(chunks[1]!.previousTail).toContain("[fake] 文字起こし修正 区切り 1/5");
    // まとめる段階は区切らない
    expect(seen.filter((item) => item.stepIndex > 0).every((item) => item.chunk === undefined)).toBe(true);
    const run = await view();
    expect(run?.state).toBe("succeeded");
    const page = JSON.stringify(store.pages.get(run!.steps[0]!.pageId)?.blocks);
    for (let index = 1; index <= 5; index++) expect(page).toContain(`区切り ${index}/5`);
    expect(page.indexOf("区切り 1/5")).toBeLessThan(page.indexOf("区切り 5/5"));
    // 最後の区切り（後半）の結果も入っている
    expect(page).toContain("区切り 5/5: 段落60");
  });

  it("does not chunk an input at or under 18,000 chars", async () => {
    const { executor, seen } = recordingExecutor();
    const { start, drainAll } = await chunkSetup(executor, 17);
    await start();
    expect((await drainAll())[0]).toEqual({ status: "completed", next: 1 });
    expect(seen[0]?.chunk).toBeUndefined();
  });

  it("retries only the failed chunk and reuses the finished ones", async () => {
    const { executor, seen } = recordingExecutor((index, call) => (index === 2 && call === 1 ? new StepError("ai_timeout", true) : undefined));
    const { start, drainAll, view } = await chunkSetup(executor);
    await start();
    const outcomes = await drainAll();
    expect(outcomes.slice(0, 4)).toEqual([{ status: "chunk" }, { status: "chunk" }, { status: "retry" }, { status: "chunk" }]);
    expect((await view())?.state).toBe("succeeded");
    expect(seen.filter((item) => item.chunk).map((item) => item.chunk!.index)).toEqual([0, 1, 2, 2, 3, 4]);
  });

  it("fails at chunk 3, then resumes from chunk 3 reusing 1 and 2", async () => {
    const { executor, seen } = recordingExecutor((index, call) => (index === 2 && call === 1 ? new StepError("invalid_output", false) : undefined));
    const { store, queue, start, drainAll, view, folder } = await chunkSetup(executor);
    const run = await start();
    await drainAll();
    let current = await view();
    expect(current?.state).toBe("failed");
    expect(current?.steps[0]).toMatchObject({ state: "failed", errorCode: "invalid_output", chunk: { index: 2, count: 5 }, hasPartialOutput: true });
    // 終えた区切りは「人が見て写す」用に partial にも残る
    expect(JSON.stringify(store.partialOf(run.id, 0))).toContain("区切り 2/5");

    const resumed = await store.resumeRun(OWNER, folder, run.id);
    expect(resumed.status).toBe("resumed");
    if (resumed.status !== "resumed") return;
    await queue.enqueue({ name: taskName(run.id, resumed.stepIndex, resumed.generation), runId: run.id, stepIndex: resumed.stepIndex });
    await drainAll();
    current = await view();
    expect(current?.state).toBe("succeeded");
    expect(seen.filter((item) => item.chunk).map((item) => item.chunk!.index)).toEqual([0, 1, 2, 2, 3, 4]);
    expect(JSON.stringify(store.pages.get(run.steps[0]!.pageId)?.blocks)).toContain("区切り 1/5");
  });

  it("stops before the next chunk when the transcript is edited mid-way, and refuses to resume", async () => {
    const { executor, seen } = recordingExecutor();
    const { store, queue, start, deps, view, parent, folder } = await chunkSetup(executor);
    const run = await start();
    expect(await runAttempt(deps, queue.drain()[0]!)).toEqual({ status: "chunk" });
    // 区切りの途中で文字起こしを直す
    store.pages.get(parent)!.blocks = [...longTranscript(75).slice(0, 74), { type: "paragraph", content: [{ type: "text", text: "直した段落" }] }];
    expect(await runAttempt(deps, queue.drain()[0]!)).toEqual({ status: "failed" });
    expect(seen).toHaveLength(1);
    const current = await view();
    expect(current?.steps[0]).toMatchObject({ state: "failed", errorCode: "input_changed", chunk: { index: 1, count: 5 } });
    expect(JSON.stringify(store.partialOf(run.id, 0))).toContain("区切り 1/5");
    expect((await store.resumeRun(OWNER, folder, run.id)).status).toBe("input_changed");
  });

  it("fails without retrying when the input needs more than 60 chunks", async () => {
    const { executor, seen } = recordingExecutor();
    const { store, queue, start, deps, view, parent } = await chunkSetup(executor, 0);
    store.pages.get(parent)!.blocks = Array.from({ length: 61 }, () => ({ type: "paragraph", content: [{ type: "text", text: "う".repeat(16_000) }] }));
    await start();
    expect(await runAttempt(deps, queue.drain()[0]!)).toEqual({ status: "failed" });
    expect(seen).toHaveLength(0);
    expect((await view())?.steps[0]).toMatchObject({ state: "failed", errorCode: "input_too_long" });
  });
});
