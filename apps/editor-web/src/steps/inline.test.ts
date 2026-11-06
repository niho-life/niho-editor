import { describe, expect, it, vi } from "vitest";
import { createFakeExecutor } from "./executor";
import { createInlineQueue, resolveStepsMode } from "./inline";
import { MemoryStepRunStore } from "./memory-store";
import { taskName } from "./queue";
import { DEFAULT_RECIPES, findRecipeIn } from "./recipes";

const OWNER = "synthetic-owner-a";

describe("resolveStepsMode", () => {
  it("accepts inline outside production only, and nothing else", () => {
    expect(resolveStepsMode({ EDITOR_STEPS_MODE: "inline" })).toBe("inline");
    expect(resolveStepsMode({ EDITOR_STEPS_MODE: "inline", NODE_ENV: "development" })).toBe("inline");
    expect(resolveStepsMode({ EDITOR_STEPS_MODE: "inline", NODE_ENV: "production" })).toBeNull();
    for (const value of [undefined, "", "off", "Inline", "cloud-tasks", "Cloud-Tasks"]) expect(resolveStepsMode({ EDITOR_STEPS_MODE: value })).toBeNull();
  });

  it("accepts cloud-tasks (also in production) only when the queue, the worker URL and the invoker service account are all set and well formed", () => {
    const cloud = {
      EDITOR_STEPS_MODE: "cloud-tasks",
      EDITOR_STEPS_QUEUE: "projects/synthetic-project/locations/asia-northeast1/queues/synthetic-queue",
      EDITOR_STEPS_WORKER_URL: "https://worker.example.test",
      EDITOR_STEPS_INVOKER_SA: "synthetic-tasks@synthetic-project.iam.gserviceaccount.com",
    };
    expect(resolveStepsMode(cloud)).toBe("cloud-tasks");
    expect(resolveStepsMode({ ...cloud, NODE_ENV: "production" })).toBe("cloud-tasks");
    for (const name of ["EDITOR_STEPS_QUEUE", "EDITOR_STEPS_WORKER_URL", "EDITOR_STEPS_INVOKER_SA"]) {
      expect(resolveStepsMode({ ...cloud, [name]: undefined }), name).toBeNull();
    }
    expect(resolveStepsMode({ ...cloud, EDITOR_STEPS_WORKER_URL: "http://worker.example.test" })).toBeNull();
    expect(resolveStepsMode({ ...cloud, EDITOR_STEPS_QUEUE: "synthetic-queue" })).toBeNull();
    // 3 つが揃っていても、方式が inline なら本番では拒む
    expect(resolveStepsMode({ ...cloud, EDITOR_STEPS_MODE: "inline", NODE_ENV: "production" })).toBeNull();
  });
});

describe("createInlineQueue", () => {
  it("runs a whole recipe in the same process without the caller awaiting it", async () => {
    const store = new MemoryStepRunStore();
    const executor = createFakeExecutor();
    const queue = createInlineQueue({ store, recipes: async () => DEFAULT_RECIPES, executor });
    const parent = store.addFolder(OWNER);
    const recording = store.addPage(OWNER, { kind: "rec", blocks: [{ type: "paragraph", content: [{ type: "text", text: "合成の会議の文字起こし" }] }], parent });
    const created = await store.createRun(OWNER, parent, { recipe: findRecipeIn(DEFAULT_RECIPES, "tpl-2")!, inputTab: recording, toStep: 1 });
    if (created.status !== "created") throw new Error(created.status);
    const task = { name: taskName(created.run.id, 0, 0), runId: created.run.id, stepIndex: 0 };

    expect(await queue.enqueue(task)).toEqual({ deduplicated: false });
    // enqueue は実行を待たない（積んだ時点ではまだ始まっていない）
    expect(executor.calls).toBe(0);
    expect(await queue.enqueue(task)).toEqual({ deduplicated: true });

    await vi.waitFor(async () => expect((await store.listRun(OWNER, parent))?.run?.state).toBe("succeeded"));
    expect(executor.calls).toBe(2);
    const run = (await store.listRun(OWNER, parent))?.run;
    expect(run?.steps.map((step) => step.stepStatus)).toEqual(["done", "done"]);
  });

  it("retries after the delay and reports unexpected failures without details", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const store = new MemoryStepRunStore();
      const executor = createFakeExecutor({ failures: 1 });
      const onError = vi.fn();
      const queue = createInlineQueue({ store, recipes: async () => DEFAULT_RECIPES, executor, onError, retryDelaySeconds: () => 5 });
      const parent = store.addFolder(OWNER);
      const recording = store.addPage(OWNER, { kind: "rec", blocks: [{ type: "paragraph", content: [{ type: "text", text: "合成の文字起こし" }] }], parent });
      const created = await store.createRun(OWNER, parent, { recipe: findRecipeIn(DEFAULT_RECIPES, "tpl-3")!, inputTab: recording, toStep: 0 });
      if (created.status !== "created") throw new Error(created.status);
      await queue.enqueue({ name: taskName(created.run.id, 0, 0), runId: created.run.id, stepIndex: 0 });
      await vi.waitFor(() => expect(store.runs.get(created.run.id)?.attempts[0]?.tries).toBe(1));
      await vi.waitFor(() => expect(store.runs.get(created.run.id)?.attempts[0]?.state).toBe("queued"));
      expect(executor.calls).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(store.runs.get(created.run.id)?.state).toBe("succeeded"));
      expect(executor.calls).toBe(2);
      expect(onError).not.toHaveBeenCalled();

      store.claimAttempt = async () => {
        throw new Error("synthetic connection failure");
      };
      const other = store.addFolder(OWNER);
      const otherRecording = store.addPage(OWNER, { kind: "rec", blocks: [{ type: "paragraph", content: [{ type: "text", text: "合成の文字起こし" }] }], parent: other });
      const again = await store.createRun(OWNER, other, { recipe: findRecipeIn(DEFAULT_RECIPES, "tpl-3")!, inputTab: otherRecording, toStep: 0 });
      if (again.status !== "created") throw new Error(again.status);
      await queue.enqueue({ name: taskName(again.run.id, 0, 0), runId: again.run.id, stepIndex: 0 });
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    } finally {
      vi.useRealTimers();
    }
  });
});
