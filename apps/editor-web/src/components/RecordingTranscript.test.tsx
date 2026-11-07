// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingTranscript } from "./RecordingTranscript";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));
const frame = vi.hoisted(() => ({ openPage: null as null | ((id: string) => void) }));
const macCompletion = vi.hoisted(() => ({ onSucceeded: null as (() => void) | null }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./EditorFrame", () => ({ useEditorFrame: () => ({ openPage: frame.openPage }) }));
vi.mock("./MacGeminiTranscription", () => ({
  MacGeminiTranscription: ({ onSucceeded }: { onSucceeded: () => void }) => {
    macCompletion.onSucceeded = onSucceeded;
    return null;
  },
}));
vi.mock("./MacLocalTranscription", () => ({ MacLocalTranscription: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 合成の値だけ（実在の人名・音声は使わない）
const PAGE_ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const TAB = "7a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const TAB2 = "8b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e";
const RUN_ID = "0b6c9a4e-3f0a-4c5e-9d1e-2a7b8c9d0e1f";
const NOW = Date.parse("2030-01-10T03:00:00.000Z");
const EXPIRES = "2030-01-31T03:00:00.000Z";

type Run = { id: string; status: "queued" | "running" | "succeeded" | "failed"; engine: string; language: "ja"; errorCode: string | null; createdAt: string; startedAt: null; finishedAt: null; tab: string | null };
const runOf = (status: Run["status"], errorCode: string | null = null, tab: string | null = TAB): Run => ({ id: RUN_ID, status, engine: "fake", language: "ja", errorCode, createdAt: "2030-01-10T00:00:00.000Z", startedAt: null, finishedAt: null, tab });
type TabRow = { id: string; label: string; engine: string; engineLabel: string; language: "ja"; durationSec: number | null; segmentCount: number; revision: number; updatedAt: string };
const tabOf = (id: string, label: string, engine: string, segmentCount: number): TabRow => ({ id, label, engine, engineLabel: engine === "fake" ? "開発の偽物" : "Deepgram", language: "ja", durationSec: 125, segmentCount, revision: 1, updatedAt: "2030-01-10T00:00:00.000Z" });

/** 音声のある録音の API の偽物。runs は GET transcription が順に返す run（最後は繰り返す）。 */
function createServer(options: { audio?: null | { status: "uploading" | "uploaded"; expiresAt?: string }; runs?: (Run | null)[]; start?: () => Response; defaultEngine?: string | null; transcripts?: TabRow[]; transcriptsAfter?: TabRow[] } = {}) {
  const state = {
    runs: [...(options.runs ?? [null])],
    posts: [] as unknown[],
    gets: { recording: 0, transcription: 0 },
    transcripts: options.transcripts ?? [],
  };
  const snapshot = () => ({
    recording: {
      revision: 1,
      source: options.audio === null ? "vtt" : "audio",
      language: "ja",
      engine: null,
      durationSec: 125,
      sourceName: "合成の会議.m4a",
      sourceSha256: null,
      audio: options.audio === null ? null : { status: options.audio?.status ?? "uploaded", bytes: 3, contentType: "audio/mp4", expiresAt: options.audio?.expiresAt ?? EXPIRES },
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    },
    audios: [],
    transcripts: state.transcripts,
    engines: ["deepgram", "fake"],
    defaultEngine: options.defaultEngine === undefined ? "deepgram" : options.defaultEngine,
  });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchMock = vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
    const path = String(resource);
    if (path === `/api/pages/${PAGE_ID}/recording` && init?.method === "GET") {
      state.gets.recording += 1;
      return json(200, snapshot());
    }
    if (path === `/api/pages/${PAGE_ID}/recording/transcription`) {
      state.gets.transcription += 1;
      const next = state.runs.length > 1 ? state.runs.shift()! : state.runs[0]!;
      if (next?.status === "succeeded" && options.transcriptsAfter) state.transcripts = options.transcriptsAfter;
      return json(200, { run: next });
    }
    if (path === `/api/pages/${PAGE_ID}/recording/transcribe`) {
      state.posts.push(JSON.parse(String(init?.body ?? "{}")));
      return options.start ? options.start() : json(202, { run: runOf("queued"), tab: TAB });
    }
    throw new Error(`unexpected ${init?.method} ${path}`);
  });
  return { state, fetchMock };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  window.localStorage.clear();
  router.push.mockClear();
  frame.openPage = null;
  macCompletion.onSucceeded = null;
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount(server: ReturnType<typeof createServer>) {
  vi.stubGlobal("fetch", server.fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<RecordingTranscript pageId={PAGE_ID} />);
  });
  await flush();
  await flush();
}

const text = () => container!.textContent ?? "";
const buttonByText = (label: string) => [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label) ?? null;
const statusOf = () => container!.querySelector('[data-transcription] [role="status"]')?.textContent ?? "";
const alerts = () => [...container!.querySelectorAll('[role="alert"]')].map((node) => node.textContent ?? "");
const click = async (label: string) => {
  const button = buttonByText(label);
  if (!button) throw new Error(`no button ${label}`);
  await act(async () => button.click());
  await flush();
};

describe("録音のタブ: 文字起こしのタブの一覧（#310）", () => {
  it("lists the transcript tabs made from this recording with their engine, size and length, and opens one when pressed", async () => {
    const server = createServer({ transcripts: [tabOf(TAB, "Deepgram", "deepgram", 12), tabOf(TAB2, "開発の偽物", "fake", 0)] });
    await mount(server);
    const list = container!.querySelector('[data-transcripts="2"]')!;
    expect(list).not.toBeNull();
    expect([...list.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["文字起こし DeepgramDeepgram · 12 区間 · 長さ 02:05", "文字起こし 開発の偽物開発の偽物 · まだ空 · 長さ 02:05"]);
    // 段落はここでは出さない（本文はタブ）
    expect(container!.querySelector(".es-seg")).toBeNull();
    await click("文字起こし Deepgram");
    expect(router.push).toHaveBeenCalledWith(`/p/${TAB}`);
  });

  it("opens a tab through the frame (openPage) when the frame offers it", async () => {
    frame.openPage = vi.fn();
    await mount(createServer({ transcripts: [tabOf(TAB2, "開発の偽物", "fake", 0)] }));
    await click("文字起こし 開発の偽物");
    expect(frame.openPage).toHaveBeenCalledWith(TAB2);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("says there is none yet and how to start, and does not offer a start for a recording without audio (VTT import)", async () => {
    await mount(createServer({ audio: null }));
    expect(container!.querySelector('[data-transcripts="none"]')?.textContent).toBe("まだ文字起こしがありません。");
    expect(buttonByText("文字起こしをはじめる")).toBeNull();
    await act(async () => root?.unmount());
    root = null;
    await mount(createServer());
    expect(container!.querySelector('[data-transcripts="none"]')?.textContent).toContain("「ページ」パネルの流れでエンジンを選んで始めます");
  });

  it("says so when the page has no recording (404) and when it cannot be read", async () => {
    const missing = createServer();
    missing.fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
    await mount(missing);
    expect(container!.querySelector("[data-transcript=missing]")?.textContent).toBe("このページには録音がありません。");
    await act(async () => root?.unmount());
    root = null;
    const failing = createServer();
    failing.fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: "x" }), { status: 503 }));
    await mount(failing);
    expect(container!.querySelector("[data-transcript=failed]")?.textContent).toContain("サーバーが使えません");
  });
});

describe("録音のタブ: 文字起こしの開始と状態（#36 段 3b-1 → #310）", () => {
  it("offers to start when the audio is uploaded, with the external-service note and the deletion date", async () => {
    const server = createServer();
    await mount(server);
    expect(buttonByText("文字起こしをはじめる")).not.toBeNull();
    expect(text()).toContain("文字起こしを始めると、音声は Deepgram に送られます");
    expect(text()).toContain("音声は 1月31日に削除されます");
    expect(container!.querySelector('[data-transcription] [role="status"]')!.getAttribute("aria-live")).toBe("polite");
    expect(server.state.gets.transcription).toBe(1);
  });

  it("does not start when the server cannot identify a transcription recipient", async () => {
    const server = createServer({ defaultEngine: null });
    await mount(server);
    expect(buttonByText("文字起こしをはじめる")).toBeNull();
    expect(text()).toContain("送信先を確認できません");
    expect(server.state.posts).toEqual([]);
  });

  it("starts without asking (the result goes to a new tab), opens that tab, and keeps the start button hidden while it runs", async () => {
    const server = createServer({ runs: [null, runOf("running")] });
    await mount(server);
    await click("文字起こしをはじめる");
    expect(server.state.posts).toEqual([{}]);
    expect(router.push).toHaveBeenCalledWith(`/p/${TAB}`);
    expect(statusOf()).toBe("待機中（開発の偽物）");
    expect(buttonByText("文字起こしをはじめる")).toBeNull();
    await flush(3000);
    expect(statusOf()).toBe("文字起こし中（開発の偽物）");
  });

  it("reloads the list of tabs when a run it watches succeeds, then stops reading", async () => {
    const server = createServer({ runs: [runOf("running"), runOf("succeeded")], transcriptsAfter: [tabOf(TAB, "開発の偽物", "fake", 3)] });
    await mount(server);
    expect(statusOf()).toBe("文字起こし中（開発の偽物）");
    await flush(3000);
    await flush();
    expect(container!.querySelector('[data-transcripts="1"]')).not.toBeNull();
    expect(statusOf()).toBe("");
    expect(server.state.gets.recording).toBe(2);
    const reads = server.state.gets.transcription;
    await flush(30_000);
    expect(server.state.gets.transcription).toBe(reads);
  });

  it("explains each failure with role=alert and offers もう一度 that rewrites the same tab (not when the audio is gone)", async () => {
    const expectations: [string, string][] = [
      ["audio_missing", "音声が見つかりませんでした。"],
      ["engine_unavailable", "文字起こしのサービスにつながりませんでした。"],
      ["engine_rejected", "文字起こしのサービスがこの音声を受け付けませんでした。"],
      ["engine_timeout", "時間内に終わりませんでした。"],
      ["engine_bad_response", "文字起こしの結果を読み取れませんでした。"],
      ["too_large", "文字起こしの結果が大きすぎました。"],
      ["internal", "サーバーで問題が起きました。"],
    ];
    for (const [code, reason] of expectations) {
      const server = createServer({ runs: [runOf("failed", code)] });
      await mount(server);
      expect(alerts()).toContain(`文字起こしに失敗しました。${reason}`);
      expect(buttonByText("もう一度"), code).not.toBeNull();
      await click("もう一度");
      expect(server.state.posts).toEqual([{ engine: "fake", tab: TAB }]);
      await act(async () => root?.unmount());
      root = null;
    }
    const gone = createServer({ runs: [runOf("failed", "audio_expired")] });
    await mount(gone);
    expect(alerts()).toContain("文字起こしに失敗しました。音声は削除されました。");
    expect(buttonByText("もう一度")).toBeNull();
  });

  it("says it cannot start now (503) and keeps the button", async () => {
    const unavailable = createServer({ start: () => new Response(JSON.stringify({ error: "transcription_unavailable" }), { status: 503 }) });
    await mount(unavailable);
    await click("文字起こしをはじめる");
    expect(alerts()).toContain("いまは始められません。少ししてから、もう一度試してください。");
    expect(buttonByText("文字起こしをはじめる")).not.toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("reloads the list when the Mac CLI saves its result", async () => {
    const server = createServer();
    await mount(server);
    expect(macCompletion.onSucceeded).not.toBeNull();
    server.state.transcripts = [tabOf(TAB, "Gemini（このMacのCLI）", "gemini-cli", 9)];
    await act(async () => macCompletion.onSucceeded!());
    await flush();
    expect(container!.querySelector('[data-transcripts="1"]')).not.toBeNull();
  });

  it("stops reading when the page goes away", async () => {
    const server = createServer({ runs: [runOf("running")] });
    await mount(server);
    expect(statusOf()).toBe("文字起こし中（開発の偽物）");
    await act(async () => root?.unmount());
    root = null;
    const reads = server.state.gets.transcription;
    await flush(30_000);
    expect(server.state.gets.transcription).toBe(reads);
  });

  it("reads less often while the page is hidden", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const server = createServer({ runs: [runOf("running")] });
    await mount(server);
    expect(server.state.gets.transcription).toBe(1);
    await flush(3000);
    expect(server.state.gets.transcription).toBe(1);
    await flush(12_000);
    expect(server.state.gets.transcription).toBe(2);
    hidden.mockReturnValue(false);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(server.state.gets.transcription).toBe(3);
  });

  it("stops after three failed reads in a row with 更新できません, and reads again on request", async () => {
    const server = createServer({ runs: [runOf("running")] });
    await mount(server);
    const original = server.fetchMock.getMockImplementation()!;
    server.fetchMock.mockImplementation(async (resource, init) => {
      if (String(resource).endsWith("/transcription")) throw new TypeError("offline");
      return original(resource, init);
    });
    await flush(3000);
    await flush(3000);
    await flush(3000);
    expect(alerts().some((alert) => alert.includes("文字起こしの状態を更新できません。"))).toBe(true);
    server.fetchMock.mockImplementation(original);
    const reads = server.state.gets.transcription;
    await flush(30_000);
    expect(server.state.gets.transcription).toBe(reads);
    await click("更新する");
    expect(server.state.gets.transcription).toBe(reads + 1);
    expect(statusOf()).toBe("文字起こし中（開発の偽物）");
  });

  it("says the audio was deleted after the date (the tabs stay), and offers nothing to start", async () => {
    const server = createServer({ audio: { status: "uploaded", expiresAt: "2030-01-09T03:00:00.000Z" }, transcripts: [tabOf(TAB, "Deepgram", "deepgram", 12)] });
    await mount(server);
    expect(text()).toContain("音声は削除されました");
    expect(container!.querySelector('[data-transcripts="1"]')).not.toBeNull();
    expect(buttonByText("文字起こしをはじめる")).toBeNull();
  });

  it("does not read the transcription state while the audio is still uploading, and says so", async () => {
    const server = createServer({ audio: { status: "uploading" } });
    await mount(server);
    expect(text()).toContain("音声の取り込みが終わっていません");
    expect(buttonByText("文字起こしをはじめる")).toBeNull();
    expect(server.state.gets.transcription).toBe(0);
  });
});
