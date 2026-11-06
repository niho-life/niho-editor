// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "@niho/editor-store";
import type { AuthProvider } from "@/auth/types";
import type { AttachedAiSteps, AttachedFlow } from "@/lib/attached-page";
import { createFlowRun, getFlow, patchFlow } from "@/server/flow-api";
import { cancelStepRun, type StepsApiDeps } from "@/server/steps-api";
import { fakeBlocks, type StepExecutor } from "@/steps/executor";
import { MemoryStepRunStore } from "@/steps/memory-store";
import { MemoryTaskQueue } from "@/steps/queue";
import { DEFAULT_RECIPES } from "@/steps/recipes";
import { runAttempt } from "@/steps/runner";
import type { FrameFlowPage } from "./EditorFrame";

const router = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() };
const frame = {
  registerFlow: vi.fn<(flow: AttachedFlow) => () => void>(() => () => undefined),
  registerAiSteps: vi.fn<(steps: AttachedAiSteps) => () => void>(() => () => undefined),
  flowPagesChanged: vi.fn<(pages: readonly FrameFlowPage[]) => void>(),
};
const onBodyReplaced = vi.fn();
const startTranscription = vi.fn(async () => ({ status: 202 as const, run: { id: "tr-1", engine: "gemini", status: "queued" as const, language: "ja" as const, errorCode: null, createdAt: "", startedAt: null, finishedAt: null, tab: "new-tab" }, tab: "new-tab" }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./EditorFrame", () => ({ useEditorFrame: () => frame }));
vi.mock("@/lib/transcription-client", async (original) => ({
  ...(await original<typeof import("@/lib/transcription-client")>()),
  startTranscription: (...args: unknown[]) => startTranscription(...(args as [])),
}));
const started = vi.fn<(pageId: string) => void>();
vi.mock("@/lib/use-transcription", () => ({ notifyTranscriptionStarted: (pageId: string) => started(pageId) }));

import { FlowWatcher } from "./FlowWatcher";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORIGIN = "http://editor.test";
const TRANSCRIPT: Block[] = [{ type: "paragraph", content: [{ type: "text", text: "合成の文字起こし" }] }];
const FLOW_PATH = /^\/api\/pages\/([^/]+)\/flow(?:\/runs)?$/;
const CANCEL_PATH = /^\/api\/pages\/([^/]+)\/steps\/runs\/([^/]+)\/cancel$/;

const notUsed = async (): Promise<Response> => {
  throw new Error("the flow API never calls the login routes");
};

/** 本物の受付 API（src/server/flow-api.ts・steps-api.ts）とメモリの store を、画面の fetch の先につなぐ。 */
function server() {
  const store = new MemoryStepRunStore();
  const queue = new MemoryTaskQueue();
  const folder = store.addFolder("user-a", "取材");
  const recording = store.addPage("user-a", { kind: "rec", blocks: [], title: "合成の録音", parent: folder });
  // 文字起こしのタブ（#310。「文字起こし」ページのタブ。段階の入力はここから）
  const transcript = store.addPage("user-a", { kind: "note", blocks: TRANSCRIPT, title: "文字起こし", parent: folder, role: { kind: "transcript" }, madeFrom: { kind: "transcript", recording, engine: "gemini" } });
  const auth: AuthProvider = { mode: "stub", getSession: async () => ({ userId: "user-a", mode: "stub" }), beginLogin: notUsed, completeLogin: notUsed, logout: notUsed };
  const deps: StepsApiDeps = { auth: () => auth, steps: () => store, recipes: () => async () => DEFAULT_RECIPES, queue: () => queue, engines: () => ["gemini", "deepgram"], env: { EDITOR_STEPS_MODE: "inline" } };
  const calls: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const method = init?.method ?? "GET";
    const url = new URL(String(input), ORIGIN);
    calls.push(`${method} ${url.pathname}`);
    const headers = new Headers(init?.headers);
    headers.set("host", "editor.test");
    if (method !== "GET") headers.set("origin", ORIGIN);
    const request = new Request(url, { ...init, method, headers });
    const cancel = CANCEL_PATH.exec(url.pathname);
    if (cancel) return cancelStepRun(request, decodeURIComponent(cancel[1]!), decodeURIComponent(cancel[2]!), deps);
    const match = FLOW_PATH.exec(url.pathname);
    if (!match) throw new Error(`the test server does not serve ${url.pathname}`);
    const id = decodeURIComponent(match[1]!);
    if (method === "GET") return getFlow(request, id, deps);
    if (method === "PATCH") return patchFlow(request, id, deps);
    return createFlowRun(request, id, deps);
  });
  const good: StepExecutor = { async run(input) { return { blocks: fakeBlocks(input) }; } };
  /** 積まれている段階を、積まれなくなるまで実行する（本番は Cloud Tasks の worker）。 */
  const work = async (executor: StepExecutor = good) => {
    for (let tasks = queue.drain(); tasks.length > 0; tasks = queue.drain()) {
      for (const task of tasks) await runAttempt({ store, executor, queue }, task);
    }
  };
  return { store, queue, deps, folder, recording, transcript, calls, fetchImpl, work };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(async () => {
  await unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(props: { pageId: string; kind: "rec" | "note" | "folder" }) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<FlowWatcher pageId={props.pageId} kind={props.kind} onBodyReplaced={onBodyReplaced} />);
  });
  await settle();
}

async function unmount() {
  const current = root;
  root = null;
  await act(async () => current?.unmount());
  container?.remove();
  container = null;
}

/** 進んでいる要求（fetch）と、そのあとの描画を待つ。 */
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
/** 次の読み直しまで進める。 */
const poll = () => act(async () => void (await vi.advanceTimersByTimeAsync(4_000)));

const latestFlow = () => frame.registerFlow.mock.calls.at(-1)?.[0] ?? null;
const latestAi = () => frame.registerAiSteps.mock.calls.at(-1)?.[0] ?? null;
const stepRow = (name: string) => latestFlow()!.rows.find((row) => row.kind === "step" && row.name === name)!;

describe("FlowWatcher（流れの見張り。#309）", () => {
  it("開いたときに流れを読み、パネルの流れ・AI の工程の選択・一覧の行を登録する。読むのは 1 回（動いていないので読み直さない）", async () => {
    const { fetchImpl, calls, folder, recording, transcript } = server();
    vi.stubGlobal("fetch", fetchImpl);
    await mount({ pageId: recording, kind: "rec" });
    const flow = latestFlow()!;
    expect(flow.ownerId).toBe(recording);
    expect(flow.folder).toEqual({ id: folder, title: "取材" });
    expect(flow.recipe).toEqual({ id: "tpl-1", name: "記事制作" });
    // 録音のタブからは段階を作らない（入力は文字起こしのタブ。#310）。文字起こしの行は入れ物とタブを持ち、エンジンのメニューはこの録音に
    expect(flow.rows.map((row) => [row.kind, row.name, row.current, row.action])).toEqual([
      ["rec", "合成の録音", true, null],
      ["transcript", "文字起こし", false, "go"],
      ["step", "文字起こし修正", false, null],
      ["step", "記事方針", false, null],
      ["step", "記事本文", false, null],
    ]);
    expect(flow.rows[1]?.holder?.title).toBe("文字起こし");
    expect(flow.rows[1]?.tabs.map((tab) => tab.id)).toEqual([transcript]);
    expect(flow.rows[1]?.engines).toEqual([{ id: "gemini", label: "Gemini", used: false }, { id: "deepgram", label: "Deepgram", used: false }]);
    expect(flow.run).toBeNull();
    expect(flow.actions).toEqual([]);
    const ai = latestAi()!;
    // AI の工程の選択も、録音のタブでは始められない（文字起こしのタブから）
    expect(ai.options.map((option) => [option.id, option.label, option.disabledReason])).toEqual([
      ["step:k7m2q9xa", "文字起こし修正", "録音のタブからは作れません。文字起こしのタブを開いてから。"],
      ["step:r4t8wz3c", "記事方針", "録音のタブからは作れません。文字起こしのタブを開いてから。"],
      ["step:h2n6v5pe", "記事本文", "録音のタブからは作れません。文字起こしのタブを開いてから。"],
    ]);
    expect(frame.flowPagesChanged.mock.calls.at(-1)?.[0].slice(0, 5)).toEqual([
      { id: folder, title: "取材", kind: "folder", parent: null, page: null, stepStatus: null },
      expect.objectContaining({ kind: "page", title: "合成の録音", parent: folder }),
      expect.objectContaining({ id: recording, kind: "rec", parent: folder, stepStatus: null, tabPos: 1 }),
      expect.objectContaining({ kind: "page", title: "文字起こし", parent: folder }),
      expect.objectContaining({ id: transcript, kind: "note", parent: folder, stepStatus: null, tabPos: 1 }),
    ]);
    await poll();
    expect(calls).toEqual([`GET /api/pages/${recording}/flow`]);
  });

  it("「作成」は今のタブ（文字起こしのタブ）を入力にその段階まで作り、できた最後のタブを開く。動いている間は読み直し、済むと行が「済み」になる", async () => {
    const { store, fetchImpl, calls, transcript, work } = server();
    vi.stubGlobal("fetch", fetchImpl);
    await mount({ pageId: transcript, kind: "note" });
    expect(latestFlow()!.rows.find((row) => row.current)?.name).toBe("文字起こし");
    let result: { ok: boolean; message: string } | undefined;
    await act(async () => {
      result = await latestFlow()!.make(stepRow("記事本文"));
    });
    expect(result).toMatchObject({ ok: true });
    expect(calls).toContain(`POST /api/pages/${transcript}/flow/runs`);
    const run = [...store.runs.values()][0]!;
    expect(run.attempts.map((attempt) => attempt.state)).toEqual(["queued", "pending", "pending"]);
    expect(router.push).toHaveBeenCalledWith(`/p/${run.attempts[2]!.pageId}`);
    await settle();
    // 始めた直後に読み直し、動いている間は「やめる」だけ
    expect(latestFlow()!.run?.state).toBe("queued");
    expect(latestFlow()!.actions.map((action) => action.id)).toEqual(["cancel"]);
    expect(latestFlow()!.note).toBe("順番を待っています。画面を閉じても進みます。");
    expect(latestAi()!.options.every((option) => option.disabledReason !== null)).toBe(true);
    expect(stepRow("記事本文").tabs).toEqual([{ id: run.attempts[2]!.pageId, label: "1", status: "wait", running: true }]);
    await work();
    await poll();
    expect(latestFlow()!.run?.state).toBe("succeeded");
    expect(latestFlow()!.rows.filter((row) => row.kind === "step").map((row) => row.action)).toEqual(["done", "done", "done"]);
    expect(latestFlow()!.note).toBe("すべての段階が済みました。");
    // 一覧の行: 文字起こしのタブ（段階ではない）と、済んだ 3 つの段階のタブ
    expect(frame.flowPagesChanged.mock.calls.at(-1)?.[0].filter((page) => page.kind === "note").map((page) => page.stepStatus)).toEqual([null, "done", "done", "done"]);
    // 終わったので読み直しは止まる
    const seen = calls.length;
    await poll();
    expect(calls.length).toBe(seen);
  });

  it("開いているタブが段階の出力で、その段階が済んで本文が入れ替わったら知らせる（1 回だけ）", async () => {
    const { store, deps, fetchImpl, recording, transcript, work } = server();
    vi.stubGlobal("fetch", fetchImpl);
    const created = await store.createRun("user-a", store.pages.get(recording)!.parent!, { recipe: DEFAULT_RECIPES[0]!, inputTab: transcript, toStep: 1 });
    if (created.status !== "created") throw new Error(created.status);
    await deps.queue()!.enqueue({ name: "t", runId: created.run.id, stepIndex: 0 });
    const output = created.run.steps[1]!.pageId;
    await mount({ pageId: output, kind: "note" });
    expect(latestFlow()!.rows.find((row) => row.current)?.name).toBe("記事方針");
    expect(latestFlow()!.rows.find((row) => row.current)?.from).toBe("文字起こし修正");
    expect(onBodyReplaced).not.toHaveBeenCalled();
    await work();
    await poll();
    expect(onBodyReplaced).toHaveBeenCalledTimes(1);
    await poll();
    expect(onBodyReplaced).toHaveBeenCalledTimes(1);
  });

  it("文字起こしの「作成 ▾」は行の録音をエンジンを指定して文字起こしし、できるタブを開く。▾ の手順はフォルダの手順を替える", async () => {
    const { store, fetchImpl, folder, recording, transcript } = server();
    vi.stubGlobal("fetch", fetchImpl);
    await mount({ pageId: recording, kind: "rec" });
    await act(async () => {
      expect(await latestFlow()!.transcribe("gemini")).toMatchObject({ ok: true, message: "Gemini で文字起こしを始めました。" });
    });
    // 結果は新しいタブに入る（置き換えの確認は要らない）。録音の watcher に知らせ、できるタブを開く
    expect(startTranscription).toHaveBeenCalledWith(recording, { engine: "gemini" });
    expect(started).toHaveBeenCalledWith(recording);
    expect(router.push).toHaveBeenCalledWith("/p/new-tab");
    // 文字起こしのタブを開いているときも、行の録音に対して始められる
    await unmount();
    vi.clearAllMocks();
    await mount({ pageId: transcript, kind: "note" });
    await act(async () => {
      expect(await latestFlow()!.transcribe("deepgram")).toMatchObject({ ok: true });
    });
    expect(startTranscription).toHaveBeenCalledWith(recording, { engine: "deepgram" });
    await act(async () => {
      expect(await latestFlow()!.changeRecipe("tpl-2")).toMatchObject({ ok: true });
    });
    await settle();
    expect(store.pages.get(folder)?.recipe).toBe("tpl-2");
    expect(latestFlow()!.recipe).toEqual({ id: "tpl-2", name: "議事録" });
    expect(latestFlow()!.rows.filter((row) => row.kind === "step").map((row) => row.name)).toEqual(DEFAULT_RECIPES[1]!.steps.map((step) => step.name));
  });

  it("「やめる」は run を取消す。読めないときは一言を出し、ログインが切れていれば読み直さない", async () => {
    const { store, fetchImpl, calls, recording, transcript } = server();
    vi.stubGlobal("fetch", fetchImpl);
    await mount({ pageId: transcript, kind: "note" });
    await act(async () => {
      await latestFlow()!.make(stepRow("文字起こし修正"));
    });
    await settle();
    expect(latestFlow()!.actions.map((action) => action.id)).toEqual(["cancel"]);
    await act(async () => latestFlow()!.onAction("cancel"));
    await settle();
    expect([...store.runs.values()][0]?.state).toBe("canceled");
    expect(latestFlow()!.note).toBe("手順を取消しました。もう一度始められます。");
    expect(calls.filter((call) => call.endsWith("/cancel"))).toHaveLength(1);

    await unmount();
    vi.clearAllMocks();
    const denied = vi.fn<typeof fetch>(async () => new Response('{"error":"unauthorized"}', { status: 401, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", denied);
    await mount({ pageId: recording, kind: "rec" });
    expect(frame.registerFlow).not.toHaveBeenCalled();
    await poll();
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it("フォルダと古い段階のサブページでは何も読まない", async () => {
    const { fetchImpl, folder } = server();
    vi.stubGlobal("fetch", fetchImpl);
    await mount({ pageId: folder, kind: "folder" });
    await poll();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(frame.registerFlow).not.toHaveBeenCalled();
  });
});
