import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Block } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { StepError, fakeExecutor } from "../steps/executor";
import { MemoryStepRunStore } from "../steps/memory-store";
import { MemoryTaskQueue, taskName, type TaskQueue } from "../steps/queue";
import { DEFAULT_RECIPES, type RecipeDef } from "../steps/recipes";
import { runAttempt } from "../steps/runner";
import { createFlowRun } from "./flow-api";
import { cancelStepRun, getStepPartialOutput, getSteps, resumeStepRun, updateStepRunRecipe, type RunView, type StepsApiDeps } from "./steps-api";

const ORIGIN = "http://editor.test";
const INLINE = { EDITOR_STEPS_MODE: "inline" };
const transcript = [{ type: "paragraph", content: [{ type: "text", text: "合成の文字起こし" }] }];

/** 手順の API が呼ぶのは getSession だけ。ログインの経路（AuthProvider の残り）は使わない。 */
const notUsed = async (): Promise<Response> => {
  throw new Error("the steps API never calls the login routes");
};

function authAs(userId: string | null): AuthProvider {
  return {
    mode: "stub",
    getSession: async () => (userId ? { userId, mode: "stub" } : null),
    beginLogin: notUsed,
    completeLogin: notUsed,
    logout: notUsed,
  };
}

function deps(
  userId: string | null,
  store: MemoryStepRunStore | null,
  options: { env?: Record<string, string | undefined>; queue?: TaskQueue | null; recipes?: readonly RecipeDef[] } = {},
): StepsApiDeps {
  const queue = options.queue === undefined ? new MemoryTaskQueue() : options.queue;
  const recipes = options.recipes ?? DEFAULT_RECIPES;
  return { auth: () => authAs(userId), steps: () => store, recipes: () => async () => recipes, queue: () => queue, env: options.env ?? INLINE };
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const init: RequestInit = { method, headers: { host: "editor.test", ...(method === "GET" ? {} : { origin: ORIGIN, "content-type": "application/json" }), ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, init);
}

/** date 以外の header を並べたもの（同じ応答かどうかを比べる）。 */
async function snapshot(response: Response) {
  const headers = [...response.headers.entries()].filter(([name]) => name !== "date").sort();
  return { status: response.status, headers, body: await response.text() };
}

/** フォルダと、その中の録音のタブ（#309。run の親はフォルダ、入力は録音）。 */
function setup() {
  const store = new MemoryStepRunStore();
  const folder = store.addFolder("user-a");
  const recording = store.addPage("user-a", { kind: "rec", blocks: transcript, parent: folder });
  return { store, folder, recording };
}

/** 流れの「作成」（録音から最後の段階まで。手順はフォルダのもの＝既定の tpl-1）。 */
const start = (tab: string, d: StepsApiDeps, headers?: Record<string, string>, toStep = 2) =>
  createFlowRun(request("POST", `/api/pages/${tab}/flow/runs`, { inputTab: tab, toStep }, headers), tab, d);
const read = (id: string, d: StepsApiDeps) => getSteps(request("GET", `/api/pages/${id}/steps`), id, d);
const cancel = (id: string, runId: string, d: StepsApiDeps, headers?: Record<string, string>) =>
  cancelStepRun(request("POST", `/api/pages/${id}/steps/runs/${runId}/cancel`, undefined, headers), id, runId, d);

const readPartial = (id: string, runId: string, index: string, d: StepsApiDeps) => {
  const path = "/api/pages/" + id + "/steps/runs/" + runId + "/steps/" + index + "/partial";
  return getStepPartialOutput(request("GET", path), id, runId, index, d);
};

async function runOf(response: Response): Promise<RunView> {
  return ((await response.json()) as { run: RunView }).run;
}

describe("/api/pages/{id}/steps（フォルダの run。#309）", () => {
  it("passes the used input chars of a cut step through, and nothing for a step that was not cut (#277)", async () => {
    const { store, folder, recording } = setup();
    const d = deps("user-a", store);
    const run = await runOf(await start(recording, d));
    const claimed = await store.claimAttempt(run.id, 0);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const blocks: Block[] = [{ type: "paragraph", content: [{ type: "text", text: "合成の結果" }] }];
    await store.commitAttempt({ runId: run.id, stepIndex: 0, generation: claimed.claim.generation, blocks, inputBasis: "a".repeat(64), inputUsedChars: 100_000 });
    const steps = (await runOf(await read(folder, d))).steps;
    expect(steps[0]?.inputUsedChars).toBe(100_000);
    expect("inputUsedChars" in steps[1]!).toBe(false);
  });

  it("reveals partial output only on explicit owner request and only for the latest failed run", async () => {
    const { store, folder, recording } = setup();
    const d = deps("user-a", store);
    const run = await runOf(await start(recording, d));
    const claimed = await store.claimAttempt(run.id, 0);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const partial: Block[] = [{ type: "paragraph", content: [{ type: "text", text: "合成の途中出力" }] }];
    await store.failAttempt({ runId: run.id, stepIndex: 0, generation: claimed.claim.generation, code: "output_too_long", retryable: false, partial });

    const polled = await read(folder, d);
    const pollText = await polled.text();
    expect(pollText).toContain('"hasPartialOutput":true');
    expect(pollText).not.toContain("合成の途中出力");
    expect(await (await readPartial(folder, run.id, "0", d)).json()).toEqual({ blocks: partial });
    expect((await readPartial(folder, run.id, "0", deps("user-b", store))).status).toBe(404);
    expect((await readPartial(folder, run.id, "0", deps(null, store))).status).toBe(401);
    expect((await readPartial(folder, run.id, "1", d)).status).toBe(404);
    expect((await readPartial(folder, run.id, "00", d)).status).toBe(404);

    const newer = await start(recording, d);
    expect(newer.status).toBe(202);
    expect((await readPartial(folder, run.id, "0", d)).status).toBe(404);
  });

  it("inherits the snapshot on rerun and updates only after an explicit diff review", async () => {
    const { store, folder, recording } = setup();
    let recipes: readonly RecipeDef[] = DEFAULT_RECIPES;
    const d = deps("user-a", store);
    d.recipes = () => async () => recipes;
    const first = await runOf(await start(recording, d));
    await cancel(folder, first.id, d);
    recipes = DEFAULT_RECIPES.map((recipe) => recipe.id === "tpl-1" ? { ...recipe, revision: 2, steps: recipe.steps.map((step, index) => index === 0 ? { ...step, name: "新しい段階" } : step) } : recipe);
    const rerun = await runOf(await start(recording, d));
    expect(rerun).toMatchObject({ recipeRevision: 1, currentRevision: 2 });
    expect(rerun.steps[0]?.name).toBe("文字起こし修正");
    expect(rerun.designChanges).toContain("名前: 文字起こし修正 → 新しい段階");
    const update = (runId: string) => updateStepRunRecipe(request("POST", `/api/pages/${folder}/steps/runs/${runId}/update-recipe`, { expectedRevision: 1 }), folder, runId, d);
    expect((await update(rerun.id)).status).toBe(409);
    await cancel(folder, rerun.id, d);
    const updated = await update(rerun.id);
    expect(updated.status).toBe(200);
    expect(await runOf(updated)).toMatchObject({ recipeRevision: 2, currentRevision: 2 });
    const next = await runOf(await start(recording, d));
    expect(next.steps[0]?.name).toBe("新しい段階");
  });

  it("marks prior outputs stale after an accepted step reorder", async () => {
    const { store, folder, recording } = setup();
    const queue = new MemoryTaskQueue();
    let recipes: readonly RecipeDef[] = DEFAULT_RECIPES;
    const d = deps("user-a", store, { queue });
    d.recipes = () => async () => recipes;
    const run = await runOf(await start(recording, d));
    const runner = { store, executor: fakeExecutor, queue };
    let tasks = queue.drain();
    while (tasks.length > 0) {
      for (const task of tasks) await runAttempt(runner, task);
      tasks = queue.drain();
    }
    expect((await runOf(await read(folder, d))).steps.map((step) => step.stepStatus)).toEqual(["done", "done", "done"]);

    recipes = DEFAULT_RECIPES.map((recipe) => recipe.id === "tpl-1"
      ? { ...recipe, revision: 2, steps: [recipe.steps[1]!, recipe.steps[0]!, ...recipe.steps.slice(2)] }
      : recipe);
    const updated = await updateStepRunRecipe(request("POST", `/api/pages/${folder}/steps/runs/${run.id}/update-recipe`, { expectedRevision: 1 }), folder, run.id, d);
    expect(updated.status).toBe(200);
    expect((await runOf(updated)).steps.map((step) => step.stepStatus)).toEqual(["stale", "stale", "stale"]);
  });

  it("recomputes stale steps on every GET and returns the latest run", async () => {
    const { store, folder, recording } = setup();
    const queue = new MemoryTaskQueue();
    const d = deps("user-a", store, { queue });
    const empty = await read(folder, d);
    expect(empty.status).toBe(200);
    // run が無くても、その人の手順の一覧は答える
    expect(await empty.json()).toEqual({
      run: null,
      recipes: [
        { id: "tpl-1", name: "記事制作", defaultName: "記事制作", unusableReason: null },
        { id: "tpl-2", name: "議事録", defaultName: "議事録", unusableReason: null },
        { id: "tpl-3", name: "インサイト整理", defaultName: "インサイト整理", unusableReason: null },
        { id: "tpl-4", name: "コーチング", defaultName: "コーチング", unusableReason: null },
      ],
    });

    const created = await runOf(await start(recording, d));
    for (let tasks = queue.drain(); tasks.length > 0; tasks = queue.drain()) {
      for (const task of tasks) await runAttempt({ store, recipes: async () => DEFAULT_RECIPES, executor: fakeExecutor, queue }, task);
    }
    const refresh = vi.spyOn(store, "refreshStale");
    const done = await runOf(await read(folder, d));
    expect(done.id).toBe(created.id);
    expect(done.state).toBe("succeeded");
    expect(done.steps.map((step) => step.stepStatus)).toEqual(["done", "done", "done"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]?.slice(0, 2)).toEqual(["user-a", folder]);
    expect(refresh.mock.calls[0]?.[2]).toMatchObject({ id: "tpl-1" });

    // 上流のタブを直すと、次の GET で下流が前提変更になる
    store.pages.get(done.steps[0]!.pageId)!.blocks = [{ type: "paragraph", content: [{ type: "text", text: "直した結果" }] }];
    const stale = await runOf(await read(folder, d));
    expect(stale.steps.map((step) => step.stepStatus)).toEqual(["done", "stale", "stale"]);
    expect(stale.steps.map((step) => step.staleReasons)).toEqual([[], ["artifact"], ["artifact"]]);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("cancels a run idempotently", async () => {
    const { store, folder, recording } = setup();
    const d = deps("user-a", store);
    const run = await runOf(await start(recording, d));
    const first = await cancel(folder, run.id, d);
    expect(first.status).toBe(200);
    const canceled = await runOf(first.clone());
    expect(canceled.state).toBe("canceled");
    expect(canceled.steps.map((step) => step.state)).toEqual(["canceled", "canceled", "canceled"]);
    const again = await cancel(folder, run.id, d);
    expect(await snapshot(again)).toEqual(await snapshot(first));
    // 取消のあとは作り直せる
    expect((await start(recording, d)).status).toBe(202);
  });

  it("answers the same 404 for another owner's folder, an unknown id, a malformed id, a deleted folder, and a page that is not a folder", async () => {
    const { store, folder, recording } = setup();
    const theirs = store.addFolder("user-b");
    const theirRecording = store.addPage("user-b", { kind: "rec", parent: theirs });
    const removed = store.addFolder("user-a");
    store.pages.get(removed)!.deleted = true;
    const d = deps("user-a", store);
    const theirRun = await runOf(await start(theirRecording, deps("user-b", store)));
    const mine = await runOf(await start(recording, d));
    const ids = [theirs, randomUUID(), "not-a-uuid", "../../etc", removed, recording];

    const reference = await snapshot(await read(randomUUID(), d));
    expect(reference.status).toBe(404);
    expect(reference.body).toBe('{"error":"not_found"}');
    const responses = [
      ...(await Promise.all(ids.map((id) => read(id, d)))),
      ...(await Promise.all(ids.map((id) => cancel(id, mine.id, d)))),
      // 本人のフォルダの path でも、別の人の run・存在しない run・不正な run の id は同じ 404
      ...(await Promise.all([theirRun.id, randomUUID(), "not-a-uuid"].map((runId) => cancel(folder, runId, d)))),
    ];
    for (const response of responses) expect(await snapshot(response)).toEqual(reference);
    expect(store.runs.get(theirRun.id)?.state).toBe("queued");
    expect(store.runs.get(mine.id)?.state).toBe("queued");
  });

  it("answers 401 without a session on every route", async () => {
    const { store, folder } = setup();
    const responses = [await read(folder, deps(null, store)), await cancel(folder, randomUUID(), deps(null, store))];
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('{"error":"unauthorized"}');
    }
    expect(store.runs.size).toBe(0);
  });

  it("answers 403 to writes from another origin or without an Origin", async () => {
    const { store, folder, recording } = setup();
    const run = await runOf(await start(recording, deps("user-a", store)));
    for (const origin of ["https://evil.example", "null", ""]) {
      expect((await cancel(folder, run.id, deps("user-a", store), { origin })).status).toBe(403);
    }
    expect(store.runs.get(run.id)?.state).toBe("queued");
  });

  it("answers 503 without a database; the list and the cancel work without a steps mode", async () => {
    const { store, folder, recording } = setup();
    const id = randomUUID();
    for (const response of [await read(id, deps("user-a", null)), await cancel(id, randomUUID(), deps("user-a", null))]) {
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('{"error":"unavailable"}');
    }
    const run = await runOf(await start(recording, deps("user-a", store)));
    expect((await read(folder, deps("user-a", store, { env: {} }))).status).toBe(200);
    expect((await cancel(folder, run.id, deps("user-a", store, { env: {} }))).status).toBe(200);
  });

  it("answers 500 without internal details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const broken = new MemoryStepRunStore();
      broken.listRun = async () => {
        throw Object.assign(new Error('relation "step_runs" does not exist at SELECT secret_column FROM step_runs'), { code: "42P01" });
      };
      const response = await read(randomUUID(), deps("user-a", broken));
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('{"error":"internal"}');
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).not.toContain("SELECT");
      expect(logged).not.toContain("secret");
    } finally {
      log.mockRestore();
    }
  });

  it("marks every response noindex, nofollow and uncacheable", async () => {
    const { store, folder, recording } = setup();
    const d = deps("user-a", store);
    const run = await runOf(await start(recording, d));
    const responses = [
      await read(folder, d),
      await cancel(folder, run.id, d),
      await cancel(folder, randomUUID(), d),
      await read(folder, deps(null, store)),
      await read(folder, deps("user-a", null)),
    ];
    for (const response of responses) {
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    }
  });
});

describe("POST /api/pages/{id}/steps/runs/{runId}/resume (#277)", () => {
  const longTranscript = Array.from({ length: 40 }, (_, index) => ({ type: "paragraph", content: [{ type: "text", text: `段落${index}`.padEnd(1000, "話") }] }));
  const resume = (id: string, runId: string, d: StepsApiDeps, headers?: Record<string, string>) =>
    resumeStepRun(request("POST", `/api/pages/${id}/steps/runs/${runId}/resume`, undefined, headers), id, runId, d);

  /** 区切り 2 で失敗した run を作る（区切り 1 は終えている）。 */
  async function failedAtSecondChunk() {
    const store = new MemoryStepRunStore();
    const folder = store.addFolder("user-a");
    const recording = store.addPage("user-a", { kind: "rec", blocks: longTranscript, parent: folder });
    const queue = new MemoryTaskQueue();
    const d = deps("user-a", store, { queue });
    const run = await runOf(await start(recording, d));
    let calls = 0;
    const executor = { run: async (input: Parameters<typeof fakeExecutor.run>[0]) => {
      calls += 1;
      if (calls === 2) throw new StepError("invalid_output", false);
      return fakeExecutor.run(input);
    } };
    for (let tasks = queue.drain(); tasks.length > 0; tasks = queue.drain()) {
      for (const task of tasks) await runAttempt({ store, executor, queue }, task);
    }
    return { store, folder, recording, queue, d, run };
  }

  it("shows the chunk progress and resumes from the failed chunk, queueing it", async () => {
    const { folder, queue, d, run } = await failedAtSecondChunk();
    const failed = await runOf(await read(folder, d));
    expect(failed.state).toBe("failed");
    expect(failed.steps[0]).toMatchObject({ state: "failed", errorCode: "invalid_output", chunk: { index: 1, count: 3 } });
    const response = await resume(folder, run.id, d);
    expect(response.status).toBe(202);
    const resumed = await runOf(response);
    expect(resumed.state).toBe("queued");
    expect(resumed.steps.map((step) => step.state)).toEqual(["queued", "pending", "pending"]);
    expect(queue.drain().map((task) => [task.stepIndex, task.name])).toEqual([[0, taskName(run.id, 0, 3)]]);
    // 2 度目は進行中なので断る
    const again = await resume(folder, run.id, d);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "run_in_progress" });
  });

  it("refuses with 409 input_changed after the transcript was edited, and 404 for another owner", async () => {
    const { store, folder, recording, d, run } = await failedAtSecondChunk();
    store.pages.get(recording)!.blocks = transcript;
    const response = await resume(folder, run.id, d);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "input_changed" });
    expect((await resume(folder, run.id, deps("user-b", store))).status).toBe(404);
    expect((await resume(folder, randomUUID(), d)).status).toBe(404);
  });

  it("answers 401 without a session, 403 from another origin, and 409 not_resumable for a step that never chunked", async () => {
    const { store, folder, d, run } = await failedAtSecondChunk();
    expect((await resume(folder, run.id, deps(null, store))).status).toBe(401);
    expect((await resume(folder, run.id, d, { origin: "https://evil.example" })).status).toBe(403);

    const plain = setup();
    const queue = new MemoryTaskQueue();
    const pd = deps("user-a", plain.store, { queue });
    const short = await runOf(await start(plain.recording, pd));
    const claimed = await plain.store.claimAttempt(short.id, 0);
    if (!claimed.ok) throw new Error("claim");
    await plain.store.failAttempt({ runId: short.id, stepIndex: 0, generation: claimed.claim.generation, code: "invalid_output", retryable: false });
    const response = await resume(plain.folder, short.id, pd);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "not_resumable" });
  });
});
