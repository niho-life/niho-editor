import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AuthProvider } from "../auth/types";
import { fakeExecutor } from "../steps/executor";
import { MemoryStepRunStore } from "../steps/memory-store";
import { MemoryTaskQueue, taskName, type TaskQueue } from "../steps/queue";
import { DEFAULT_RECIPES, recipesOf, type RecipeDef } from "../steps/recipes";
import { runAttempt } from "../steps/runner";
import { MAX_BODY_BYTES } from "./http";
import { createFlowRun, getFlow, patchFlow, type FlowResponse } from "./flow-api";
import type { StepsApiDeps } from "./steps-api";

const ORIGIN = "http://editor.test";
const INLINE = { EDITOR_STEPS_MODE: "inline" };
const transcript = [{ type: "paragraph", content: [{ type: "text", text: "合成の文字起こし" }] }];

const notUsed = async (): Promise<Response> => {
  throw new Error("the flow API never calls the login routes");
};

function authAs(userId: string | null): AuthProvider {
  return { mode: "stub", getSession: async () => (userId ? { userId, mode: "stub" } : null), beginLogin: notUsed, completeLogin: notUsed, logout: notUsed };
}

function deps(
  userId: string | null,
  store: MemoryStepRunStore | null,
  options: { env?: Record<string, string | undefined>; queue?: TaskQueue | null; recipes?: readonly RecipeDef[]; engines?: readonly string[] } = {},
): StepsApiDeps {
  const queue = options.queue === undefined ? new MemoryTaskQueue() : options.queue;
  const recipes = options.recipes ?? DEFAULT_RECIPES;
  return { auth: () => authAs(userId), steps: () => store, recipes: () => async () => recipes, queue: () => queue, engines: () => options.engines ?? ["gemini", "deepgram"], env: options.env ?? INLINE };
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const init: RequestInit = { method, headers: { host: "editor.test", ...(method === "GET" ? {} : { origin: ORIGIN, "content-type": "application/json" }), ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, init);
}

function setup() {
  const store = new MemoryStepRunStore();
  const folder = store.addFolder("user-a", "取材");
  const recording = store.addPage("user-a", { kind: "rec", blocks: transcript, title: "合成の録音", parent: folder });
  return { store, folder, recording };
}

const flow = (id: string, d: StepsApiDeps, query = "") => getFlow(request("GET", `/api/pages/${id}/flow${query}`), id, d);
const post = (id: string, body: unknown, d: StepsApiDeps, headers?: Record<string, string>) => createFlowRun(request("POST", `/api/pages/${id}/flow/runs`, body, headers), id, d);
const patch = (id: string, body: unknown, d: StepsApiDeps, headers?: Record<string, string>) => patchFlow(request("PATCH", `/api/pages/${id}/flow`, body, headers), id, d);
const flowOf = async (response: Response) => (await response.json()) as FlowResponse;
const runOf = async (response: Response) => ((await response.json()) as { run: { id: string; fromStep: number; steps: { index: number; pageId: string; state: string }[] }; folder: string; opened: string | null });

async function drain(store: MemoryStepRunStore, queue: MemoryTaskQueue) {
  for (let tasks = queue.drain(); tasks.length > 0; tasks = queue.drain()) {
    for (const task of tasks) await runAttempt({ store, executor: fakeExecutor, queue }, task);
  }
}

describe("GET /api/pages/{id}/flow（流れ。#309）", () => {
  it("録音のタブ: 行は 録音 › 文字起こし（エンジン）› 段階…、手順はフォルダの既定、run は無し", async () => {
    const { store, folder, recording } = setup();
    const response = await flow(recording, deps("user-a", store));
    expect(response.status).toBe(200);
    const body = await flowOf(response);
    expect(body.tab).toEqual({ id: recording, kind: "rec", holder: store.holderOf(recording)!.id, folder: { id: folder, title: "取材" } });
    expect(body.recipe).toMatchObject({ id: "tpl-1", name: "記事制作" });
    expect(body.recipes.map((recipe) => recipe.id)).toEqual(["tpl-1", "tpl-2", "tpl-3", "tpl-4"]);
    // 録音のタブからは段階を作らない（段階の入力は文字起こしのタブ。#310）。文字起こしの行はエンジンのメニュー（この録音に）
    expect(body.rows.map((row) => [row.kind, row.name, row.current, row.action])).toEqual([
      ["rec", "合成の録音", true, null],
      ["transcript", "文字起こし", false, "go"],
      ["step", "文字起こし修正", false, null],
      ["step", "記事方針", false, null],
      ["step", "記事本文", false, null],
    ]);
    expect(body.rows[1]?.engines).toEqual([{ id: "gemini", used: false }, { id: "deepgram", used: false }]);
    expect(body.rows[1]?.recording).toBe(recording);
    expect(body.run).toBeNull();
    // フォルダの id と ?tab= でも同じ。別のフォルダの id・タブで無い id は 404
    expect(await flowOf(await flow(folder, deps("user-a", store), `?tab=${recording}`))).toEqual(body);
    expect((await flow(folder, deps("user-a", store))).status).toBe(404);
    expect((await flow(store.addFolder("user-a"), deps("user-a", store), `?tab=${recording}`)).status).toBe(404);
    expect((await flow(folder, deps("user-a", store), "?tab=not-a-uuid")).status).toBe(400);
  });

  it("作成の後: 段階の行に入れ物とタブが付き、この録音から作ったので「済み」。使ったエンジンもメニューで済み", async () => {
    const { store, folder, recording } = setup();
    const queue = new MemoryTaskQueue();
    const d = deps("user-a", store, { queue });
    const created = await runOf(await post(recording, { inputTab: recording, toStep: 1 }, d));
    await drain(store, queue);
    store.usedEngines.set(recording, ["gemini"]);
    const body = await flowOf(await flow(recording, d));
    expect(body.rows.map((row) => [row.name, row.action, row.holder?.title ?? null, row.tabs.map((tab) => tab.status)])).toEqual([
      ["合成の録音", null, "合成の録音", [null]],
      ["文字起こし", "go", null, []],
      ["文字起こし修正", "done", "文字起こし修正", ["done"]],
      ["記事方針", "done", "記事方針", ["done"]],
      ["記事本文", null, null, []],
    ]);
    expect(body.rows[1]?.engines).toEqual([{ id: "gemini", used: true }, { id: "deepgram", used: false }]);
    expect(body.run?.id).toBe(created.run.id);
    expect(body.run?.steps.map((step) => step.stepStatus)).toEqual(["done", "done"]);
    // 記事方針のタブを開くと: 手前は何も出ず、記事本文は「作成」、今の行は「文字起こし修正 から」
    const policyTab = created.run.steps[1]!.pageId;
    const atPolicy = await flowOf(await flow(policyTab, d));
    expect(atPolicy.rows.map((row) => [row.current, row.action, row.from])).toEqual([[false, null, null], [false, null, null], [false, null, null], [true, null, "文字起こし修正"], [false, "go", null]]);
    expect(atPolicy.rows[1]?.engines).toBeUndefined();
    expect(atPolicy.tab.folder?.id).toBe(folder);
  });

  it("役割の無いページのタブと、フォルダの外のページ（流れは既定の手順。作成するとフォルダに入る）", async () => {
    const { store, folder } = setup();
    const note = store.addPage("user-a", { kind: "note", title: "コラム", parent: folder });
    const d = deps("user-a", store);
    const inside = await flowOf(await flow(note, d));
    expect(inside.rows.map((row) => [row.current, row.action])).toEqual([[false, null], [false, null], [false, "go"], [false, "go"], [false, "go"]]);
    const lone = store.addPage("user-a", { kind: "note", title: "外のメモ" });
    const outside = await flowOf(await flow(lone, d));
    expect(outside.tab.folder).toBeNull();
    expect(outside.rows.map((row) => [row.name, row.action])).toEqual([["録音", null], ["文字起こし", null], ["文字起こし修正", "go"], ["記事方針", "go"], ["記事本文", "go"]]);
  });

  it("フォルダの手順（PATCH）: 行はその手順の段階になる。知らない手順は 400、null で既定に戻る。フォルダの外のタブは包んでから", async () => {
    const { store, folder, recording } = setup();
    const d = deps("user-a", store);
    const changed = await patch(recording, { recipe: "tpl-2" }, d);
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ folder, recipe: "tpl-2" });
    const body = await flowOf(await flow(recording, d));
    expect(body.recipe.id).toBe("tpl-2");
    expect(body.rows.filter((row) => row.kind === "step").map((row) => row.name)).toEqual(DEFAULT_RECIPES[1]!.steps.map((step) => step.name));
    for (const bad of [{ recipe: "tpl-9" }, { recipe: "TPL-1" }, { recipe: 1 }, {}, { recipe: "tpl-1", other: 1 }]) {
      const response = await patch(recording, bad, d);
      expect(response.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await patch(recording, { recipe: null }, d)).status).toBe(200);
    expect((await flowOf(await flow(recording, d))).recipe.id).toBe("tpl-1");
    const lone = store.addPage("user-a", { kind: "note", title: "外のメモ" });
    const wrapped = await patch(lone, { recipe: "tpl-3" }, d);
    expect(wrapped.status).toBe(200);
    const { folder: made } = (await wrapped.json()) as { folder: string };
    expect(store.pages.get(made)).toMatchObject({ kind: "folder", title: "外のメモ", recipe: "tpl-3" });
    expect(store.pages.get(lone)?.parent).toBe(made);
    expect((await patch(lone, { recipe: "tpl-1" }, d, { origin: "https://evil.example" })).status).toBe(403);
    expect((await patch(lone, { recipe: "tpl-1" }, deps(null, store))).status).toBe(401);
    expect((await patch(randomUUID(), { recipe: "tpl-1" }, d)).status).toBe(404);
  });
});

describe("POST /api/pages/{id}/flow/runs（作成。#309）", () => {
  it("録音から記事本文まで: 役割ページとタブがフォルダ直下にでき、最初の段階が積まれ、開くのは最後のタブ。202", async () => {
    const { store, folder, recording } = setup();
    const queue = new MemoryTaskQueue();
    const response = await post(recording, { inputTab: recording, toStep: 2 }, deps("user-a", store, { queue }));
    expect(response.status).toBe(202);
    const { run, folder: at, opened } = await runOf(response);
    expect(at).toBe(folder);
    expect(run.fromStep).toBe(0);
    expect(run.steps.map((step) => [step.index, step.state])).toEqual([[0, "queued"], [1, "pending"], [2, "pending"]]);
    expect(opened).toBe(run.steps[2]!.pageId);
    for (const [index, step] of run.steps.entries()) {
      const tab = store.pages.get(step.pageId)!;
      const holder = store.pages.get(tab.page!)!;
      expect([tab.kind, tab.parent, tab.title, tab.stepStatus]).toEqual(["note", folder, DEFAULT_RECIPES[0]!.steps[index]!.name, "wait"]);
      expect(holder.role).toEqual({ kind: "step", recipe: "tpl-1", stepId: DEFAULT_RECIPES[0]!.steps[index]!.id });
    }
    // 録音の下には何も増えない
    expect([...store.pages.values()].filter((page) => page.parent === recording)).toEqual([]);
    expect(queue.drain()).toEqual([{ name: taskName(run.id, 0, 0), runId: run.id, stepIndex: 0 }]);
  });

  it("段階の出力のタブから続き・作り直す・同じ入力でもう 1 つ。手前の段階へは 400、動いている間は 409", async () => {
    const { store, recording } = setup();
    const queue = new MemoryTaskQueue();
    const d = deps("user-a", store, { queue });
    const first = await runOf(await post(recording, { inputTab: recording, toStep: 0 }, d));
    expect((await post(recording, { inputTab: recording, toStep: 1 }, d)).status).toBe(409);
    await drain(store, queue);
    const fixed = first.run.steps[0]!.pageId;
    // 文字起こし修正のタブから記事本文まで（段階 1〜2 が新しいタブに）
    const next = await runOf(await post(fixed, { inputTab: fixed, toStep: 2 }, d));
    expect(next.run.fromStep).toBe(1);
    expect(next.run.steps.map((step) => step.index)).toEqual([1, 2]);
    expect(next.opened).toBe(next.run.steps[1]!.pageId);
    await drain(store, queue);
    // 手前の段階（段階 0）へは作れない
    const back = await post(fixed, { inputTab: fixed, toStep: 0 }, d);
    expect(back.status).toBe(400);
    expect(await back.json()).toEqual({ error: "invalid_from_step" });
    // 作り直す: 同じタブ、新しいタブは増えない。もう 1 つ: 同じ入れ物に新しいタブ
    const policy = next.run.steps[0]!.pageId;
    const redo = await runOf(await post(policy, { regenerate: policy }, d));
    expect(redo.run.steps.map((step) => [step.index, step.pageId])).toEqual([[1, policy]]);
    expect(redo.opened).toBe(policy);
    await drain(store, queue);
    const more = await runOf(await post(policy, { sibling: policy }, d));
    expect(more.run.steps[0]!.pageId).not.toBe(policy);
    expect(store.pages.get(more.run.steps[0]!.pageId)?.page).toBe(store.pages.get(policy)?.page);
    await drain(store, queue);
    // 録音を作り直すことはできない
    expect((await post(recording, { regenerate: recording }, d)).status).toBe(400);
  });

  it("フォルダの外のページ: その題名でフォルダを作って入れてから始める（作り直す・もう 1 つは不可）", async () => {
    const store = new MemoryStepRunStore();
    const lone = store.addPage("user-a", { kind: "rec", blocks: transcript, title: "外の録音" });
    const d = deps("user-a", store);
    const response = await post(lone, { inputTab: lone, toStep: 0 }, d);
    expect(response.status).toBe(202);
    const { folder } = await runOf(response);
    expect(store.pages.get(folder)).toMatchObject({ kind: "folder", title: "外の録音", parent: null });
    expect(store.pages.get(lone)?.parent).toBe(folder);
    expect(store.holderOf(lone)?.parent).toBe(folder);
    const other = store.addPage("user-a", { kind: "note" });
    const regenerate = await post(other, { regenerate: other }, d);
    expect(regenerate.status).toBe(400);
    expect(await regenerate.json()).toEqual({ error: "invalid_from_step" });
    expect([...store.pages.values()].filter((page) => page.kind === "folder")).toHaveLength(1);
  });

  it("手順はフォルダのもの（設定で変えた・足した手順も）。使えない手順は 409 recipe_unusable", async () => {
    const { store, folder, recording } = setup();
    const recipes = recipesOf([
      { id: "tpl-2", name: "議事録（短め）", guide: "短く", steps: [{ id: "d9c3x7mf", name: "要点", instruction: "要点だけ。" }] },
      { id: "r-talk", name: "対談", guide: "", steps: [{ id: "s-1", name: "まとめ", instruction: "まとめる。" }] },
    ]);
    const d = deps("user-a", store, { recipes });
    await store.setFolderRecipe("user-a", folder, "r-talk");
    const talk = await runOf(await post(recording, { inputTab: recording, toStep: 0 }, d));
    expect(store.holderOf(talk.run.steps[0]!.pageId)?.role).toEqual({ kind: "step", recipe: "r-talk", stepId: "s-1" });
    expect((await post(recording, { inputTab: recording, toStep: 0 }, d)).status).toBe(409);
    await store.cancelRun("user-a", folder, talk.run.id);
    const out = await post(recording, { inputTab: recording, toStep: 1 }, d);
    expect(out.status).toBe(400);
    expect(await out.json()).toEqual({ error: "invalid_from_step" });
    // 使えない手順（指示が空）
    const invalid = DEFAULT_RECIPES.map((recipe) => recipe.id === "tpl-3" ? { ...recipe, steps: recipe.steps.map((step, index) => index === 0 ? { ...step, instruction: "   " } : step) } : recipe);
    await store.setFolderRecipe("user-a", folder, "tpl-3");
    const unusable = await post(recording, { inputTab: recording, toStep: 0 }, deps("user-a", store, { recipes: invalid }));
    expect(await unusable.json()).toEqual({ error: "recipe_unusable" });
    expect(unusable.status).toBe(409);
    // 設定から消えた手順を持つフォルダは既定に戻る
    await store.setFolderRecipe("user-a", folder, "r-gone");
    expect((await flowOf(await flow(recording, d))).recipe.id).toBe("tpl-1");
  });

  it("returns the same run for the same Idempotency-Key and queues it once", async () => {
    const { store, recording } = setup();
    const queue = new MemoryTaskQueue();
    const d = deps("user-a", store, { queue });
    const headers = { "idempotency-key": "synthetic-key_1" };
    const first = await post(recording, { inputTab: recording, toStep: 2 }, d, headers);
    const second = await post(recording, { inputTab: recording, toStep: 2 }, d, headers);
    expect([first.status, second.status]).toEqual([202, 202]);
    expect((await runOf(second)).run.id).toBe((await runOf(first)).run.id);
    expect(queue.size).toBe(1);
    for (const key of ["has space", "k".repeat(129), "a/b", "a.b"]) {
      const response = await post(recording, { inputTab: recording, toStep: 2 }, d, { "idempotency-key": key });
      expect(response.status).toBe(400);
    }
  });

  it("answers the same 404 for another owner's tab, an unknown id, a malformed id, a deleted tab, a folder, and a tab whose folder is not the path", async () => {
    const { store, folder, recording } = setup();
    const theirs = store.addPage("user-b", { kind: "rec", parent: store.addFolder("user-b") });
    const removed = store.addPage("user-a", { kind: "rec", parent: folder });
    store.pages.get(removed)!.deleted = true;
    const d = deps("user-a", store);
    const reference = await post(randomUUID(), { inputTab: randomUUID(), toStep: 0 }, d);
    expect(reference.status).toBe(404);
    for (const [id, tab] of [[theirs, theirs], [randomUUID(), randomUUID()], ["not-a-uuid", recording], [removed, removed], [folder, folder], [store.addFolder("user-a"), recording]] as const) {
      const response = await post(id, { inputTab: tab, toStep: 0 }, d);
      expect(response.status, `${id} / ${tab}`).toBe(404);
      expect(await response.text()).toBe('{"error":"not_found"}');
    }
    expect(store.runs.size).toBe(0);
  });

  it("answers 401 without a session and 403 from another origin, before looking at the id", async () => {
    const { store, recording } = setup();
    expect((await post(recording, { inputTab: recording, toStep: 0 }, deps(null, store))).status).toBe(401);
    for (const origin of ["https://evil.example", "null", ""]) {
      expect((await post(recording, { inputTab: recording, toStep: 0 }, deps("user-a", store), { origin })).status).toBe(403);
    }
    expect(store.runs.size).toBe(0);
  });

  it("answers 413 above 1 MiB and 400 to bodies that are not JSON or not the right shape, before looking at the id", async () => {
    const { store, recording } = setup();
    const d = deps("user-a", store);
    const big = JSON.stringify({ inputTab: recording, toStep: 0, padding: "a".repeat(MAX_BODY_BYTES) });
    expect((await post(recording, big, d)).status).toBe(413);
    const bad: Array<[unknown, Record<string, string>?]> = [
      ["{", undefined],
      ["inputTab=x", { "content-type": "application/x-www-form-urlencoded" }],
      [{ inputTab: recording, toStep: 0 }, { "content-type": "text/plain" }],
      [{}, undefined],
      [[], undefined],
      [{ inputTab: recording }, undefined],
      [{ toStep: 0 }, undefined],
      [{ inputTab: "not-a-uuid", toStep: 0 }, undefined],
      [{ inputTab: recording, toStep: -1 }, undefined],
      [{ inputTab: recording, toStep: 1.5 }, undefined],
      [{ inputTab: recording, toStep: "0" }, undefined],
      [{ inputTab: recording, toStep: 0, recipe: "tpl-1" }, undefined],
      [{ regenerate: recording, sibling: recording }, undefined],
      [{ regenerate: "not-a-uuid" }, undefined],
    ];
    for (const id of [recording, "not-a-uuid"]) {
      for (const [body, headers] of bad) {
        const response = await post(id, body, d, headers);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(await response.text()).toBe('{"error":"bad_request"}');
      }
    }
    expect(store.runs.size).toBe(0);
  });

  it("answers 503 without a database, without a steps mode, or with inline in production; 500 leaves no run in progress", async () => {
    const { store, recording } = setup();
    expect((await post(recording, { inputTab: recording, toStep: 0 }, deps("user-a", null))).status).toBe(503);
    const queue = new MemoryTaskQueue();
    for (const env of [{}, { EDITOR_STEPS_MODE: "off" }, { EDITOR_STEPS_MODE: "cloud" }, { EDITOR_STEPS_MODE: "inline", NODE_ENV: "production" }]) {
      const response = await post(recording, { inputTab: recording, toStep: 0 }, deps("user-a", store, { env, queue }));
      expect(response.status, JSON.stringify(env)).toBe(503);
      expect(await response.text()).toBe('{"error":"steps_unavailable"}');
    }
    expect((await post(recording, { inputTab: recording, toStep: 0 }, deps("user-a", store, { queue: null }))).status).toBe(503);
    expect(store.runs.size).toBe(0);

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const failing: TaskQueue = { enqueue: async () => { throw new Error("synthetic queue failure at https://queue.invalid/secret"); } };
      const queued = await post(recording, { inputTab: recording, toStep: 0 }, deps("user-a", store, { queue: failing }));
      expect(queued.status).toBe(500);
      expect(await queued.text()).toBe('{"error":"internal"}');
      expect([...store.runs.values()].map((run) => run.state)).toEqual(["canceled"]);
      expect((await post(recording, { inputTab: recording, toStep: 0 }, deps("user-a", store))).status).toBe(202);
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    } finally {
      log.mockRestore();
    }
  });

  it("marks every response noindex, nofollow and uncacheable", async () => {
    const { store, recording } = setup();
    const d = deps("user-a", store);
    const responses = [
      await flow(recording, d),
      await post(recording, { inputTab: recording, toStep: 0 }, d),
      await post(recording, "{", d),
      await patch(recording, { recipe: "tpl-2" }, d),
      await flow(recording, deps(null, store)),
      await flow(recording, deps("user-a", null)),
    ];
    for (const response of responses) {
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    }
  });
});
