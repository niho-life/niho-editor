// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingTranscript } from "./RecordingTranscript";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 合成の値だけ（実在の人名・音声は使わない）
const PAGE_ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const RUN_ID = "0b6c9a4e-3f0a-4c5e-9d1e-2a7b8c9d0e1f";
const NOW = Date.parse("2030-01-10T03:00:00.000Z");
const EXPIRES = "2030-01-31T03:00:00.000Z";
const SEGMENTS = [
  { start: 0, end: 4, text: "[fake] 一つ目の段落です。", speaker: 1 },
  { start: 4, end: 9, text: "[fake] 二つ目の段落です。", speaker: 2 },
];

type Run = { id: string; status: "queued" | "running" | "succeeded" | "failed"; engine: string; language: "ja"; errorCode: string | null; createdAt: string; startedAt: null; finishedAt: null };
const runOf = (status: Run["status"], errorCode: string | null = null): Run => ({ id: RUN_ID, status, engine: "fake", language: "ja", errorCode, createdAt: "2030-01-10T00:00:00.000Z", startedAt: null, finishedAt: null });

/** 音声のある録音の API の偽物。runs は GET transcription が順に返す run（最後は繰り返す）。 */
function createServer(options: { segments?: typeof SEGMENTS; audioStatus?: "uploading" | "uploaded"; expiresAt?: string; runs?: (Run | null)[]; start?: () => Response; recordingAfter?: typeof SEGMENTS; defaultEngine?: string | null } = {}) {
  const state = {
    revision: 1,
    segments: options.segments ?? [],
    runs: [...(options.runs ?? [null])],
    posts: [] as unknown[],
    gets: { recording: 0, transcription: 0 },
  };
  const snapshot = () => ({
    recording: {
      revision: state.revision,
      source: "audio",
      language: "ja",
      engine: null,
      durationSec: 125,
      sourceName: "合成の会議.m4a",
      sourceSha256: null,
      segments: state.segments,
      speakerNames: {},
      audio: { status: options.audioStatus ?? "uploaded", bytes: 3, contentType: "audio/mp4", expiresAt: options.expiresAt ?? EXPIRES },
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    },
    speakers: [...new Set(state.segments.map((segment) => segment.speaker))].map((speaker) => ({ speaker, name: null, count: state.segments.filter((segment) => segment.speaker === speaker).length })),
    engines: ["deepgram"],
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
      if (next?.status === "succeeded" && options.recordingAfter) {
        state.segments = options.recordingAfter;
        state.revision += 1;
      }
      return json(200, { run: next });
    }
    if (path === `/api/pages/${PAGE_ID}/recording/transcribe`) {
      state.posts.push(JSON.parse(String(init?.body ?? "{}")));
      return options.start ? options.start() : json(202, { run: runOf("queued") });
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

describe("録音ページの文字起こしの開始と状態（#36 段 3b-1）", () => {
  it("offers to start when the audio is uploaded and there are no paragraphs, with the external-service note and the deletion date", async () => {
    const server = createServer();
    await mount(server);
    expect(buttonByText("文字起こしをはじめる")).not.toBeNull();
    expect(text()).toContain("文字起こしを始めると、音声は Deepgram に送られます");
    expect(text()).toContain("音声は 1月31日に削除されます");
    // 段落がまだ無いので、段落の欄（直す・話者・時刻）は出さない
    expect(text()).not.toContain("文字起こしを直す");
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

  it("starts, says 待機中 then 文字起こし中 every 3 seconds, and shows the paragraphs when it succeeds; then stops reading", async () => {
    const server = createServer({ runs: [null, runOf("running"), runOf("succeeded")], recordingAfter: SEGMENTS });
    await mount(server);
    await click("文字起こしをはじめる");
    expect(server.state.posts).toEqual([{}]);
    expect(statusOf()).toBe("待機中");
    expect(buttonByText("文字起こしをはじめる")).toBeNull();
    await flush(3000);
    expect(statusOf()).toBe("文字起こし中");
    await flush(3000);
    await flush();
    expect(text()).toContain("[fake] 一つ目の段落です。");
    expect(text()).toContain("文字起こしを直す");
    expect(statusOf()).toBe("");
    expect(server.state.gets.recording).toBe(2);
    const reads = server.state.gets.transcription;
    await flush(30_000);
    expect(server.state.gets.transcription).toBe(reads);
  });

  it("explains each failure with role=alert and offers もう一度 (not when the audio is gone)", async () => {
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
      // 段落が無いので確かめずに送る
      expect(server.state.posts).toEqual([{}]);
      await act(async () => root?.unmount());
      root = null;
    }
    const gone = createServer({ runs: [runOf("failed", "audio_expired")] });
    await mount(gone);
    expect(alerts()).toContain("文字起こしに失敗しました。音声は削除されました。");
    expect(buttonByText("もう一度")).toBeNull();
  });

  it("asks once before replacing paragraphs that are already there, and sends replace only after yes", async () => {
    const server = createServer({ segments: SEGMENTS });
    await mount(server);
    expect(text()).toContain("[fake] 一つ目の段落です。");
    // 段落があるときは、外部のサービスの一言は確かめる欄に出す
    expect(container!.querySelector("[data-transcription]")!.textContent).not.toContain("音声は Deepgram に送られます");
    await click("もう一度文字起こしする");
    expect(text()).toContain("いまの文字起こしは、足した分も含めて置き換えられます");
    expect(text()).toContain("文字起こしを始めると、音声は Deepgram に送られます");
    expect(document.activeElement?.textContent).toBe("やめる");
    await click("やめる");
    expect(server.state.posts).toEqual([]);
    expect(document.activeElement?.textContent).toBe("もう一度文字起こしする");
    await click("もう一度文字起こしする");
    await click("置き換える");
    expect(server.state.posts).toEqual([{ replace: true }]);
    expect(statusOf()).toBe("待機中");
  });

  it("also asks before retrying a failed run when paragraphs are there", async () => {
    const server = createServer({ segments: SEGMENTS, runs: [runOf("failed", "engine_timeout")] });
    await mount(server);
    await click("もう一度");
    expect(server.state.posts).toEqual([]);
    await click("置き換える");
    expect(server.state.posts).toEqual([{ replace: true }]);
  });

  it("says it cannot start now (503), and reloads when the server says there is already a transcript", async () => {
    const unavailable = createServer({ start: () => new Response(JSON.stringify({ error: "transcription_unavailable" }), { status: 503 }) });
    await mount(unavailable);
    await click("文字起こしをはじめる");
    expect(alerts()).toContain("いまは始められません。少ししてから、もう一度試してください。");
    expect(buttonByText("文字起こしをはじめる")).not.toBeNull();
    await act(async () => root?.unmount());
    root = null;

    const conflict = createServer({ start: () => new Response(JSON.stringify({ error: "cannot_start", reason: "has_transcript" }), { status: 409 }) });
    await mount(conflict);
    conflict.state.segments = SEGMENTS;
    await click("文字起こしをはじめる");
    await flush();
    expect(conflict.state.gets.recording).toBe(2);
    expect(text()).toContain("[fake] 一つ目の段落です。");
  });

  it("stops reading when the page goes away", async () => {
    const server = createServer({ runs: [runOf("running")] });
    await mount(server);
    expect(statusOf()).toBe("文字起こし中");
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
    expect(statusOf()).toBe("文字起こし中");
  });

  it("says the audio was deleted after the date (the paragraphs stay), and offers nothing to start", async () => {
    const server = createServer({ segments: SEGMENTS, expiresAt: "2030-01-09T03:00:00.000Z" });
    await mount(server);
    expect(text()).toContain("音声は削除されました");
    expect(text()).toContain("[fake] 一つ目の段落です。");
    expect(buttonByText("もう一度文字起こしする")).toBeNull();
  });

  it("does not read the transcription state while the audio is still uploading, and says so", async () => {
    const server = createServer({ audioStatus: "uploading" });
    await mount(server);
    expect(text()).toContain("音声の取り込みが終わっていません");
    expect(buttonByText("文字起こしをはじめる")).toBeNull();
    expect(server.state.gets.transcription).toBe(0);
  });
});
