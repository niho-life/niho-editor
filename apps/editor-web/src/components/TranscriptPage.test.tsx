// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RecordingData } from "@niho/editor-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendTranscript } from "@/recording/append-transcript";
import { editSegments } from "@/recording/edit-segments";
import { listSpeakers, mergeSpeakers, renameSpeaker } from "@/recording/speakers";
import { readVtt } from "@/recording/vtt-import";
import { TranscriptPage } from "./TranscriptPage";

// 合成の値だけ（実在の人名・音声は使わない）
const TAB = "7a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const REC = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const CONFLICT_TEXT = "別の場所で先に直されました。最新に合わせました";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Patch = {
  baseRevision: number;
  edits?: { index: number; text: string }[];
  renameSpeaker?: { speaker: number; name: string | null };
  mergeSpeakers?: { from: number; into: number };
  appendVtt?: { name: string; vtt: string };
};
type Run = { id: string; status: "queued" | "running" | "succeeded" | "failed"; engine: string; language: "ja"; errorCode: string | null; createdAt: string; startedAt: null; finishedAt: null; tab: string };
const runOf = (status: Run["status"], errorCode: string | null = null): Run => ({ id: "0b6c9a4e-3f0a-4c5e-9d1e-2a7b8c9d0e1f", status, engine: "fake", language: "ja", errorCode, createdAt: "2030-01-10T00:00:00.000Z", startedAt: null, finishedAt: null, tab: TAB });

/**
 * 本物の純粋な関数（edit-segments・speakers）で動く、revision つきの文字起こしのタブの API（`/api/pages/{tab}/transcript`）の代わり。
 * 録音のタブの GET（音声の列・使えるエンジン）も答える。
 */
function createServer(initial?: Partial<RecordingData>) {
  const state = {
    revision: 1,
    durationSec: 125 as number | null,
    data: {
      segments: [
        { start: 0, end: 4, text: "最初の段落です。", speaker: 1 },
        { start: 4, end: 9, text: "二つ目の段落です。", speaker: 2 },
        { start: 9, end: 12, text: "三つ目の段落です。", speaker: 1 },
        { start: 12, end: 15, text: "四つ目の段落です。", speaker: 3 },
      ],
      speakerNames: { "1": "Takuya", "2": "Mika" },
      ...initial,
    } as RecordingData,
    patches: [] as Patch[],
    gets: 0,
    status: 200,
    /** 値を入れると、次の PATCH はそれが呼ばれるまで返さない。 */
    hold: null as Promise<void> | null,
    /** このタブに書く最新の run（GET の応答にだけ付く）。 */
    run: null as Run | null,
    /** 元の録音（null なら録音が消えている＝404）。 */
    recording: { audio: null as unknown, audios: [] as unknown[], engines: ["fake"] as string[], durationSec: 125 as number | null },
    posts: [] as unknown[],
  };
  const snapshot = () => ({
    transcript: {
      revision: state.revision,
      recording: REC,
      engine: "fake",
      engineLabel: "開発の偽物",
      language: "ja",
      durationSec: state.durationSec,
      segments: state.data.segments,
      speakerNames: state.data.speakerNames,
      createdAt: "2026-10-30T00:00:00.000Z",
      updatedAt: "2026-10-30T00:00:00.000Z",
    },
    speakers: listSpeakers(state.data),
  });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchMock = vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
    const path = String(resource);
    if (path === `/api/pages/${REC}/recording`) {
      if (!state.recording) return json(404, { error: "not_found" });
      return json(200, {
        recording: { revision: 1, source: "audio", language: "ja", engine: null, durationSec: state.recording.durationSec, sourceName: null, sourceSha256: null, segments: [], speakerNames: {}, audio: state.recording.audio, createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z" },
        speakers: [],
        audios: state.recording.audios,
        transcripts: [],
        engines: state.recording.engines,
        defaultEngine: "fake",
      });
    }
    if (path === `/api/pages/${REC}/recording/transcribe`) {
      state.posts.push(JSON.parse(String(init?.body ?? "{}")));
      return json(202, { run: runOf("queued"), tab: TAB });
    }
    if (path === `/api/pages/${TAB}/transcript/versions`) return json(200, { versions: [] });
    if (path !== `/api/pages/${TAB}/transcript`) throw new Error(`unexpected ${init?.method} ${path}`);
    if (state.status !== 200) return json(state.status, { error: "x" });
    if (init?.method === "GET") {
      state.gets += 1;
      return json(200, { ...snapshot(), run: state.run });
    }
    const patch = JSON.parse(init!.body as string) as Patch;
    state.patches.push(patch);
    if (state.hold) await state.hold;
    if (patch.baseRevision !== state.revision) return json(409, { error: "conflict", ...snapshot() });
    const appended = patch.appendVtt ? readVtt(patch.appendVtt) : null;
    if (appended && !appended.ok) return json(400, { error: "bad_request", reason: appended.reason });
    const result = patch.edits
      ? editSegments(state.data, patch.edits)
      : patch.renameSpeaker
        ? renameSpeaker(state.data, patch.renameSpeaker.speaker, patch.renameSpeaker.name)
        : appended
          ? appendTranscript({ ...state.data, durationSec: state.durationSec }, appended.value)
          : mergeSpeakers(state.data, patch.mergeSpeakers!.from, patch.mergeSpeakers!.into);
    if ("rejected" in result) return json(400, { error: "bad_request", reason: result.rejected });
    state.data = { segments: result.segments, speakerNames: result.speakerNames };
    if (result.durationSec !== undefined && result.durationSec !== null) state.durationSec = result.durationSec;
    state.revision += 1;
    return json(200, snapshot());
  });
  /** 別の画面が先に直した（この画面は知らない）。 */
  const external = (mutate: (data: RecordingData) => RecordingData) => {
    state.data = mutate(state.data);
    state.revision += 1;
  };
  return { state, fetchMock, external };
}

let root: Root | null = null;
let container: HTMLElement | null = null;
const MEDIA_DESCRIPTOR_NAMES = ["paused", "currentTime", "duration"] as const;
const ORIGINAL_MEDIA_DESCRIPTORS = new Map(MEDIA_DESCRIPTOR_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, name)]));

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const name of MEDIA_DESCRIPTOR_NAMES) {
    const descriptor = ORIGINAL_MEDIA_DESCRIPTORS.get(name);
    if (descriptor) Object.defineProperty(HTMLMediaElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLMediaElement.prototype, name);
  }
});

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error("condition not met");
}

async function mount(server = createServer()) {
  vi.stubGlobal("fetch", server.fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<TranscriptPage tabId={TAB} recording={REC} />);
  });
  return server;
}

const paragraphs = () => [...container!.querySelectorAll<HTMLElement>(".es-seg p")];
const seekSlider = () => container!.querySelector<HTMLInputElement>('input[aria-label="再生位置"]');
const whoOf = () => [...container!.querySelectorAll(".es-who > span")].map((node) => node.textContent);
const status = () => container!.querySelector("[data-save-state]")!;
const chip = (name: string) => container!.querySelector<HTMLButtonElement>(`button[aria-label="${name} の名前を変える"]`)!;
const buttonByText = (text: string) => [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text)!;
const notice = () => container!.querySelector("[data-transcript-notice]")?.textContent ?? "";

function installAudioMedia() {
  type State = { paused: boolean; currentTime: number; duration: number };
  const states = new WeakMap<HTMLMediaElement, State>();
  const state = (audio: HTMLMediaElement) => {
    let current = states.get(audio);
    if (!current) {
      current = { paused: true, currentTime: 0, duration: 600 };
      states.set(audio, current);
    }
    return current;
  };
  Object.defineProperties(HTMLMediaElement.prototype, {
    paused: { configurable: true, get() { return state(this).paused; } },
    currentTime: { configurable: true, get() { return state(this).currentTime; }, set(value: number) { state(this).currentTime = value; } },
    duration: { configurable: true, get() { return state(this).duration; } },
  });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    state(this).paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    state(this).paused = true;
    this.dispatchEvent(new Event("pause"));
  });
  return {
    finish(audio: HTMLMediaElement) {
      state(audio).paused = true;
      audio.dispatchEvent(new Event("ended"));
    },
    currentTime(audio: HTMLMediaElement) { return state(audio).currentTime; },
    setDuration(audio: HTMLMediaElement, duration: number) { state(audio).duration = duration; },
  };
}

function write(element: HTMLElement, text: string) {
  act(() => {
    element.textContent = text;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const blur = (element: HTMLElement) => act(() => element.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
const compose = (element: HTMLElement, type: "compositionstart" | "compositionend") => act(() => element.dispatchEvent(new Event(type, { bubbles: true })));
async function edit(index: number, text: string) {
  write(paragraphs()[index]!, text);
  blur(paragraphs()[index]!);
  await settle();
}
function setValue(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const submitName = async () => {
  await act(async () => container!.querySelector<HTMLFormElement>(".es-spkform")!.requestSubmit());
  await settle();
};

describe("TranscriptPage: loading", () => {
  it("shows a loading state, then the transcript of the tab: paragraphs, speakers, length, timestamps, saved", async () => {
    const server = createServer();
    vi.stubGlobal("fetch", server.fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<TranscriptPage tabId={TAB} recording={REC} />);
    });
    await until(() => paragraphs().length === 4);
    expect(server.fetchMock).toHaveBeenCalledWith(`/api/pages/${TAB}/transcript`, expect.objectContaining({ method: "GET" }));
    expect(server.fetchMock).toHaveBeenCalledWith(`/api/pages/${REC}/recording`, expect.objectContaining({ method: "GET" }));
    expect(paragraphs().map((node) => node.textContent)).toEqual(["最初の段落です。", "二つ目の段落です。", "三つ目の段落です。", "四つ目の段落です。"]);
    // 名前の無い話者は「話者N」。色は番号の順
    expect(whoOf()).toEqual(["Takuya", "Mika", "Takuya", "話者3"]);
    expect([...container!.querySelectorAll(".es-seg .es-tone")].map((node) => node.className.match(/es-tone--(\w)/)![1])).toEqual(["a", "b", "a", "c"]);
    expect([...container!.querySelectorAll(".es-who time")].map((node) => node.textContent)).toEqual(["00:00", "00:04", "00:09", "00:12"]);
    expect(container!.querySelector(".es-time")?.textContent).toBe("長さ 02:05");
    expect(status().textContent).toBe("保存済み");
    // 音声の無い録音（VTT の取り込み）なので再生は無い
    expect(container!.querySelector('[aria-label="再生"]')).toBeNull();
    expect(container!.querySelector(".es-wave")).toBeNull();
    expect(container!.querySelector("[data-transcript-engine]")?.getAttribute("data-transcript-engine")).toBe("fake");
  });

  it("says so when the page is not a transcript tab (404)", async () => {
    const server = createServer();
    server.state.status = 404;
    await mount(server);
    await until(() => container!.querySelector("[data-transcript=missing]") !== null);
    expect(container!.textContent).toContain("この文字起こしは見つかりません。");
  });

  it("shows a failure in Japanese and loads again on request", async () => {
    const server = createServer();
    server.state.status = 503;
    await mount(server);
    await until(() => container!.querySelector("[data-transcript=failed]") !== null);
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain("サーバーが使えません");
    server.state.status = 200;
    await act(async () => buttonByText("もう一度読み込む").click());
    await until(() => paragraphs().length === 4);
  });

  it("says the recording is gone (no playback) when the original recording tab was deleted, and keeps the transcript", async () => {
    const server = createServer();
    server.state.recording = null as never;
    await mount(server);
    await until(() => paragraphs().length === 4);
    await until(() => container!.querySelector('[data-transcript-audio="missing"]') !== null);
    expect(container!.textContent).toContain("元の録音が見つからないので、再生はできません");
    expect(container!.querySelector("audio")).toBeNull();
  });
});

describe("TranscriptPage: the run that writes this tab", () => {
  it("shows the engine while the run is queued or running, without the paragraph editor, and loads the paragraphs when it succeeds", async () => {
    const server = createServer({ segments: [], speakerNames: {} });
    server.state.run = runOf("running");
    await mount(server);
    await until(() => (container!.textContent ?? "").includes("文字起こし中"));
    expect(container!.textContent).toContain("文字起こし中（開発の偽物）");
    expect(container!.querySelector(".es-seg")).toBeNull();
    // 済んだら段落を読み直す
    server.state.data = { segments: [{ start: 0, end: 2, text: "[fake] 新しい段落。", speaker: 1 }], speakerNames: {} };
    server.state.revision = 2;
    server.state.run = runOf("succeeded");
    await settle(3100);
    await until(() => paragraphs().length === 1);
    expect(paragraphs()[0]!.textContent).toBe("[fake] 新しい段落。");
  });

  it("explains a failed run and offers もう一度 that rewrites this same tab with the same engine (only when the server can run it)", async () => {
    const server = createServer({ segments: [], speakerNames: {} });
    server.state.run = runOf("failed", "engine_timeout");
    await mount(server);
    await until(() => container!.querySelector("[data-transcription-error]") !== null);
    expect(container!.querySelector("[data-transcription-error]")?.textContent).toContain("時間内に終わりませんでした。");
    await act(async () => buttonByText("もう一度").click());
    await settle();
    expect(server.state.posts).toEqual([{ engine: "fake", tab: TAB }]);

    // このタブのエンジンがサーバーで使えない（Mac の CLI で作ったタブ）なら「もう一度」を出さない
    const mac = createServer({ segments: [], speakerNames: {} });
    mac.state.run = { ...runOf("failed", "stopped"), engine: "gemini-cli" };
    mac.state.recording.engines = ["deepgram"];
    await act(async () => root?.unmount());
    root = null;
    await mount(mac);
    await until(() => mac.state.gets >= 1);
    await settle();
    expect([...container!.querySelectorAll("button")].some((button) => button.textContent?.trim() === "もう一度")).toBe(false);
  });
});

describe("TranscriptPage: editing paragraphs", () => {
  it("saves a fixed paragraph on blur with the loaded revision, and the next one with the revision it got back", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    await edit(1, "二つ目の段落を直しました。");
    expect(server.state.patches).toEqual([{ baseRevision: 1, edits: [{ index: 1, text: "二つ目の段落を直しました。" }] }]);
    expect(status().textContent).toBe("保存済み");
    expect(server.state.data.segments[1]!.text).toBe("二つ目の段落を直しました。");
    await edit(3, "四つ目も直しました。");
    expect(server.state.patches[1]).toEqual({ baseRevision: 2, edits: [{ index: 3, text: "四つ目も直しました。" }] });
    expect(paragraphs()[1]!.textContent).toBe("二つ目の段落を直しました。");
    expect(paragraphs()[3]!.textContent).toBe("四つ目も直しました。");
  });

  it("does not send when nothing changed", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    blur(paragraphs()[0]!);
    write(paragraphs()[0]!, "別の文章");
    write(paragraphs()[0]!, "最初の段落です。");
    blur(paragraphs()[0]!);
    await settle();
    expect(server.state.patches).toEqual([]);
  });

  it("sends the same operations one at a time: the second waits for the first and uses its revision", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    let release!: () => void;
    server.state.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    write(paragraphs()[0]!, "一回目");
    blur(paragraphs()[0]!);
    await settle();
    write(paragraphs()[2]!, "二回目");
    blur(paragraphs()[2]!);
    await settle();
    expect(status().textContent).toBe("保存中");
    expect(server.state.patches).toHaveLength(1);
    server.state.hold = null;
    release();
    await until(() => server.state.patches.length === 2);
    await until(() => status().textContent === "保存済み");
    expect(server.state.patches[1]).toEqual({ baseRevision: 2, edits: [{ index: 2, text: "二回目" }] });
    expect(server.state.data.segments.map((segment) => segment.text)).toEqual(["一回目", "二つ目の段落です。", "二回目", "四つ目の段落です。"]);
  });

  it("does not confirm while composing (IME): it sends after the composition ends", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    const first = paragraphs()[0]!;
    compose(first, "compositionstart");
    write(first, "にゅうりょくちゅう");
    blur(first);
    await settle();
    expect(server.state.patches).toEqual([]);
    compose(first, "compositionend");
    await settle();
    expect(server.state.patches).toEqual([{ baseRevision: 1, edits: [{ index: 0, text: "にゅうりょくちゅう" }] }]);
  });
});

describe("TranscriptPage: someone fixed it elsewhere first (409)", () => {
  it("keeps what I wrote, takes the latest for the rest, says so, and sends again on request", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    server.external((data) => ({
      segments: data.segments.map((segment, index) => (index === 2 ? { ...segment, text: "別の画面で直した三つ目。" } : segment)),
      speakerNames: { ...data.speakerNames, "2": "Mika Sato" },
    }));
    await edit(1, "私が直した二つ目。");
    expect(paragraphs()[1]!.textContent).toBe("私が直した二つ目。");
    expect(paragraphs()[2]!.textContent).toBe("別の画面で直した三つ目。");
    expect(whoOf()[1]).toBe("Mika Sato");
    expect(notice()).toContain(CONFLICT_TEXT);
    expect(status().textContent).toContain("保存されていない段落が 1 つあります");
    expect(server.state.data.segments[1]!.text).toBe("二つ目の段落です。");
    expect(server.state.patches).toHaveLength(1);

    await act(async () => buttonByText("もう一度保存").click());
    await settle();
    expect(server.state.patches[1]).toEqual({ baseRevision: 2, edits: [{ index: 1, text: "私が直した二つ目。" }] });
    expect(server.state.data.segments[1]!.text).toBe("私が直した二つ目。");
    expect(status().textContent).toBe("保存済み");
    expect(notice()).toBe("");
    expect(paragraphs()[1]!.textContent).toBe("私が直した二つ目。");
  });

  it("confirming another paragraph does not send the held one; confirming the same one again does", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    server.external((data) => ({ segments: data.segments, speakerNames: { ...data.speakerNames, "1": "T" } }));
    await edit(0, "止められた文章");
    expect(server.state.patches).toHaveLength(1);
    await edit(3, "別の段落");
    expect(server.state.patches[1]).toEqual({ baseRevision: 2, edits: [{ index: 3, text: "別の段落" }] });
    expect(server.state.data.segments[0]!.text).toBe("最初の段落です。");
    expect(status().textContent).toContain("保存されていない段落が 1 つあります");
    await edit(0, "止められた文章を書き直した");
    expect(server.state.patches[2]).toEqual({ baseRevision: 3, edits: [{ index: 0, text: "止められた文章を書き直した" }] });
    expect(status().textContent).toBe("保存済み");
  });

  it("holds every draft on a conflict, including paragraphs fixed while the save was in flight: none is laid over the latest without asking", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    let release!: () => void;
    server.state.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.external((data) => ({
      segments: data.segments.map((segment, index) => (index === 1 ? { ...segment, text: "別の画面で直した二つ目。" } : segment)),
      speakerNames: data.speakerNames,
    }));
    await edit(0, "私の一つ目");
    expect(server.state.patches).toHaveLength(1);
    await edit(1, "私の二つ目");
    await edit(0, "私の一つ目（書き直し）");
    server.state.hold = null;
    release();
    await until(() => status().textContent?.includes("保存されていない段落") ?? false);
    await settle(20);
    expect(server.state.patches).toHaveLength(1);
    expect(server.state.data.segments[1]!.text).toBe("別の画面で直した二つ目。");
    expect(status().textContent).toContain("保存されていない段落が 2 つあります");
    expect(paragraphs()[0]!.textContent).toBe("私の一つ目（書き直し）");
    expect(paragraphs()[1]!.textContent).toBe("私の二つ目");
    await act(async () => buttonByText("もう一度保存").click());
    await settle();
    expect(server.state.patches[1]).toEqual({
      baseRevision: 2,
      edits: [
        { index: 0, text: "私の一つ目（書き直し）" },
        { index: 1, text: "私の二つ目" },
      ],
    });
    expect(status().textContent).toBe("保存済み");
  });

  it("keeps the text and offers to try again when the save fails (not a conflict)", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    server.state.status = 503;
    await edit(0, "失敗する文章");
    expect(paragraphs()[0]!.textContent).toBe("失敗する文章");
    expect(notice()).toContain("サーバーが使えません");
    expect(status().textContent).toContain("保存されていない段落が 1 つあります");
    server.state.status = 200;
    await act(async () => buttonByText("もう一度保存").click());
    await settle();
    expect(server.state.data.segments[0]!.text).toBe("失敗する文章");
    expect(status().textContent).toBe("保存済み");
  });

  it("explains a rejected paragraph (too long) and keeps it", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    await edit(0, "あ".repeat(5001));
    expect(notice()).toContain("5,000 字");
    expect(paragraphs()[0]!.textContent).toHaveLength(5001);
    expect(server.state.data.segments[0]!.text).toBe("最初の段落です。");
  });
});

describe("TranscriptPage: leaving with unsaved writing", () => {
  const unload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it("counts a paragraph I am still typing in (not confirmed yet): it says so and closing the tab asks first", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    expect(status().textContent).toBe("保存済み");
    expect(unload()).toBe(false);
    write(paragraphs()[1]!, "書いている途中");
    expect(server.state.patches).toHaveLength(0);
    expect(status().textContent).toBe("保存待ち");
    expect(unload()).toBe(true);
    blur(paragraphs()[1]!);
    await until(() => status().textContent === "保存済み");
    expect(server.state.patches).toHaveLength(1);
    expect(unload()).toBe(false);
  });

  it("does not ask after typing is undone before it is confirmed", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    write(paragraphs()[0]!, "変えた");
    write(paragraphs()[0]!, "最初の段落です。");
    expect(unload()).toBe(true);
    blur(paragraphs()[0]!);
    await settle();
    expect(server.state.patches).toHaveLength(0);
    expect(status().textContent).toBe("保存済み");
    expect(unload()).toBe(false);
  });

  it("keeps asking while composing (IME) with focus gone, until the composition ends", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    compose(paragraphs()[2]!, "compositionstart");
    write(paragraphs()[2]!, "へんかんちゅう");
    blur(paragraphs()[2]!);
    expect(unload()).toBe(true);
    expect(server.state.patches).toHaveLength(0);
    compose(paragraphs()[2]!, "compositionend");
    await until(() => status().textContent === "保存済み");
    expect(server.state.patches).toHaveLength(1);
    expect(unload()).toBe(false);
  });
});

describe("TranscriptPage: speakers", () => {
  it("renames a speaker; every paragraph shows the new name", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    act(() => chip("話者3").click());
    setValue(container!.querySelector<HTMLInputElement>(".es-spkform input")!, "Haruka");
    await submitName();
    expect(server.state.patches).toEqual([{ baseRevision: 1, renameSpeaker: { speaker: 3, name: "Haruka" } }]);
    expect(whoOf()).toEqual(["Takuya", "Mika", "Takuya", "Haruka"]);
    expect(container!.querySelector(".es-spkform")).toBeNull();
    act(() => chip("Haruka").click());
    setValue(container!.querySelector<HTMLInputElement>(".es-spkform input")!, "");
    await submitName();
    expect(server.state.patches[1]).toEqual({ baseRevision: 2, renameSpeaker: { speaker: 3, name: null } });
    expect(whoOf()[3]).toBe("話者3");
  });

  it("shows why a name cannot be used and keeps the form open with what was typed", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    act(() => chip("Mika").click());
    setValue(container!.querySelector<HTMLInputElement>(".es-spkform input")!, "話者5");
    await submitName();
    expect(container!.querySelector(".es-spkform")).not.toBeNull();
    expect(container!.querySelector(".es-spkform [role=alert]")?.textContent).toContain("「話者1」の形");
    expect(container!.querySelector<HTMLInputElement>(".es-spkform input")!.value).toBe("話者5");
    expect(server.state.data.speakerNames["2"]).toBe("Mika");
  });

  it("on a conflict while renaming, takes the latest, tells me, and lets me decide again", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    server.external((data) => ({
      segments: data.segments.map((segment, index) => (index === 0 ? { ...segment, text: "別の画面の一つ目" } : segment)),
      speakerNames: data.speakerNames,
    }));
    act(() => chip("Mika").click());
    setValue(container!.querySelector<HTMLInputElement>(".es-spkform input")!, "Mika Sato");
    await submitName();
    expect(container!.querySelector(".es-spkform [role=alert]")?.textContent).toContain(CONFLICT_TEXT);
    expect(paragraphs()[0]!.textContent).toBe("別の画面の一つ目");
    expect(container!.querySelector<HTMLInputElement>(".es-spkform input")!.value).toBe("Mika Sato");
    await submitName();
    expect(server.state.patches[1]).toEqual({ baseRevision: 2, renameSpeaker: { speaker: 2, name: "Mika Sato" } });
    expect(whoOf()[1]).toBe("Mika Sato");
  });

  it("merges one speaker into another after one confirmation: their paragraphs move and the speaker disappears", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    act(() => chip("話者3").click());
    const select = container!.querySelector<HTMLSelectElement>('select[aria-label="まとめる先の話者"]')!;
    expect([...select.options].map((option) => option.textContent)).toEqual(["Takuya", "Mika"]);
    act(() => buttonByText("まとめる").click());
    expect(server.state.patches).toEqual([]);
    expect(container!.querySelector(".es-spkform-merge")?.textContent).toContain("「話者3」の段落をすべて「Takuya」にまとめます。元には戻せません。");
    await act(async () => buttonByText("まとめる").click());
    await settle();
    expect(server.state.patches).toEqual([{ baseRevision: 1, mergeSpeakers: { from: 3, into: 1 } }]);
    expect(whoOf()).toEqual(["Takuya", "Mika", "Takuya", "Takuya"]);
    expect(chip("話者3")).toBeNull();
    expect(container!.querySelector(".es-spkform")).toBeNull();
    expect([...container!.querySelectorAll(".es-seg .es-tone")].map((node) => node.className.match(/es-tone--(\w)/)![1])).toEqual(["a", "b", "a", "a"]);
  });
});

describe("TranscriptPage: timestamps", () => {
  it("hides and shows the times, and remembers the choice on this device", async () => {
    await mount();
    await until(() => paragraphs().length === 4);
    expect(container!.querySelectorAll(".es-who time")).toHaveLength(4);
    const toggle = buttonByText("タイムスタンプ");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    act(() => toggle.click());
    expect(container!.querySelectorAll(".es-who time")).toHaveLength(0);
    expect(buttonByText("タイムスタンプ").getAttribute("aria-pressed")).toBe("false");
    expect(window.localStorage.getItem("editor:transcript-timestamps")).toBe("off");
    await act(async () => root!.unmount());
    container!.remove();
    await mount();
    await until(() => paragraphs().length === 4);
    expect(container!.querySelectorAll(".es-who time")).toHaveLength(0);
    act(() => buttonByText("タイムスタンプ").click());
    expect(container!.querySelectorAll(".es-who time")).toHaveLength(4);
    expect(window.localStorage.getItem("editor:transcript-timestamps")).toBe("on");
  });

  it("works when the device blocks storage", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    await mount();
    await until(() => paragraphs().length === 4);
    expect(container!.querySelectorAll(".es-who time")).toHaveLength(4);
    act(() => buttonByText("タイムスタンプ").click());
    expect(container!.querySelectorAll(".es-who time")).toHaveLength(0);
  });
});

describe("TranscriptPage: multiple audio parts of the original recording", () => {
  const audio = { status: "uploaded", bytes: 64, contentType: "audio/mp4", expiresAt: "2030-02-01T00:00:00.000Z" };
  const part = (partIndex: number, offsetSec: number, durationSec: number | null, extra: Record<string, unknown> = {}) => ({
    partIndex, status: "uploaded", bytes: 64, contentType: "audio/mp4", durationSec, offsetSec, sourceName: `part-${partIndex}.m4a`, expiresAt: "2030-02-01T00:00:00.000Z", ...extra,
  });
  const withAudio = (server: ReturnType<typeof createServer>, audios: unknown[], durationSec: number | null = 125) => {
    server.state.recording = { audio, audios, engines: ["fake"], durationSec };
    server.state.durationSec = durationSec;
    return server;
  };

  it("uses browser metadata for a single part when saved and transcript lengths are unknown", async () => {
    const media = installAudioMedia();
    const server = withAudio(createServer(), [part(0, 0, null)], null);
    await mount(server);
    await until(() => seekSlider() !== null);
    const element = container!.querySelector<HTMLAudioElement>("audio")!;
    media.setDuration(element, Number.POSITIVE_INFINITY);
    act(() => element.dispatchEvent(new Event("durationchange")));
    expect(seekSlider()!.disabled).toBe(true);
    media.setDuration(element, 37);
    act(() => element.dispatchEvent(new Event("loadedmetadata")));
    expect(seekSlider()!.max).toBe("37");
    expect(seekSlider()!.disabled).toBe(false);
  });

  it("does not use one part's metadata as the total when multiple part lengths are unknown", async () => {
    const media = installAudioMedia();
    const server = withAudio(createServer(), [part(0, 0, null), part(1, 600, null)], null);
    await mount(server);
    await until(() => seekSlider() !== null);
    const element = container!.querySelector<HTMLAudioElement>("audio")!;
    media.setDuration(element, 37);
    act(() => element.dispatchEvent(new Event("loadedmetadata")));
    expect(seekSlider()!.max).toBe("600");
    expect(seekSlider()!.disabled).toBe(false);
  });

  it("plays the next uploaded part automatically at the boundary (the audio comes from the recording tab's route)", async () => {
    const media = installAudioMedia();
    const server = withAudio(createServer(), [part(0, 0, 600), part(1, 600, 300)]);
    await mount(server);
    await until(() => container!.querySelector('[data-playback-part]') !== null);
    const element = container!.querySelector<HTMLAudioElement>("audio")!;
    expect(element.getAttribute("src")).toBe(`/api/pages/${REC}/recording/audio?part=0`);
    act(() => container!.querySelector<HTMLButtonElement>('[aria-label="再生"]')!.click());
    expect(container!.querySelector('[data-playback-part]')?.textContent).toBe("音声 1を再生中");
    await act(async () => media.finish(element));
    await settle();
    expect(element.getAttribute("src")).toBe(`/api/pages/${REC}/recording/audio?part=1`);
    await act(async () => {
      element.dispatchEvent(new Event("loadedmetadata"));
      element.dispatchEvent(new Event("seeked"));
    });
    await settle();
    expect(container!.querySelector('[data-playback-part]')?.textContent).toBe("音声 2を再生中");
    expect(media.currentTime(element)).toBe(0);
  });

  it("seeks on the full recording timeline and translates the position into the selected part", async () => {
    const media = installAudioMedia();
    const server = withAudio(createServer({ segments: [{ start: 650, end: 660, text: "後半の段落です。", speaker: 1 }] }), [part(0, 0, 600), part(1, 600, 300)]);
    await mount(server);
    await until(() => container!.querySelector('[data-playback-part]') !== null);
    const element = container!.querySelector<HTMLAudioElement>("audio")!;
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="10:50 から再生"]')!.click());
    await settle();
    expect(element.getAttribute("src")).toBe(`/api/pages/${REC}/recording/audio?part=1`);
    await act(async () => {
      element.dispatchEvent(new Event("loadedmetadata"));
      element.dispatchEvent(new Event("seeked"));
    });
    expect(media.currentTime(element)).toBe(50);
    expect(container!.querySelector('[data-playback-part]')?.textContent).toBe("音声 2を再生中");
    expect(container!.querySelector<HTMLInputElement>('[aria-label="再生位置"]')?.max).toBe("900");
    expect(container!.querySelector<HTMLInputElement>('[aria-label="再生位置"]')?.getAttribute("aria-valuetext")).toBe("10:50 / 15:00");
  });

  it("moves between available parts with labelled keyboard-operable buttons", async () => {
    installAudioMedia();
    const server = withAudio(createServer(), [part(0, 0, 600), part(1, 600, 300)]);
    await mount(server);
    await until(() => container!.querySelector('[data-playback-part]') !== null);
    const element = container!.querySelector<HTMLAudioElement>("audio")!;
    const next = container!.querySelector<HTMLButtonElement>('[aria-label="次の音声Part"]')!;
    expect(next.disabled).toBe(false);
    expect(next.tagName).toBe("BUTTON");
    act(() => next.click());
    await settle();
    expect(element.getAttribute("src")).toBe(`/api/pages/${REC}/recording/audio?part=1`);
    await act(async () => element.dispatchEvent(new Event("loadedmetadata")));
    act(() => container!.querySelector<HTMLButtonElement>('[aria-label="前の音声Part"]')!.click());
    await settle();
    expect(element.getAttribute("src")).toBe(`/api/pages/${REC}/recording/audio?part=0`);
    expect(container!.querySelector('[data-playback-part]')?.textContent).toBe("音声 1を選択中");
  });

  it("does not jump across a missing part when seeking, and announces its state", async () => {
    const media = installAudioMedia();
    const server = withAudio(createServer({ segments: [{ start: 650, end: 660, text: "欠落区間の段落です。", speaker: 1 }] }), [part(0, 0, 600), part(2, 1200, 300)]);
    await mount(server);
    await until(() => container!.querySelector('[data-playback-part]') !== null);
    const element = container!.querySelector<HTMLAudioElement>("audio")!;
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="10:50 から再生"]')!.click());
    expect(element.getAttribute("src")).toBe(`/api/pages/${REC}/recording/audio?part=0`);
    expect(container!.querySelector("[data-playback-notice]")?.textContent).toContain("音声 2 が見つかりません");
    expect(media.currentTime(element)).toBe(0);
  });
});

describe("TranscriptPage（あとの .vtt を足す）", () => {
  const VTT = (text: string) => ["WEBVTT", "", "00:00:00.000 --> 00:00:03.000", `<v Takuya>${text}`, "", ""].join("\n");
  const appendInput = () => container!.querySelector<HTMLInputElement>('[data-recording-append] input[type="file"]')!;
  const appendError = () => container!.querySelector('[data-recording-append-error=""]')?.textContent ?? "";

  async function pick(files: File[]) {
    const input = appendInput();
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("複数の .vtt を選んだ順に足し、前の音声の長さだけ時刻をずらしてつなぐ", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    expect(appendInput().multiple).toBe(true);
    await pick([new File([VTT("続きです")], "2.vtt", { type: "text/vtt" }), new File([VTT("もっと続きます")], "3.vtt", { type: "text/vtt" })]);
    await until(() => paragraphs().length === 6);
    expect(server.state.patches.map((patch) => [patch.baseRevision, patch.appendVtt?.name])).toEqual([
      [1, "2.vtt"],
      [2, "3.vtt"],
    ]);
    expect(server.state.data.segments.slice(4).map((segment) => [segment.start, segment.end, segment.text])).toEqual([
      [125, 128, "続きです"],
      [128, 131, "もっと続きます"],
    ]);
    expect(server.state.data.segments.slice(4).map((segment) => segment.speaker)).toEqual([1, 1]);
    expect(server.state.durationSec).toBe(131);
    expect(container!.textContent).toContain("2 件の文字起こしを足しました");
    expect(appendError()).toBe("");
  });

  it("途中で失敗したら、そこで止めて何件足せたかを知らせる", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    await pick([new File([VTT("続きです")], "2.vtt", { type: "text/vtt" }), new File(["これは字幕ではありません"], "3.vtt", { type: "text/vtt" })]);
    await until(() => appendError() !== "");
    expect(appendError()).toContain("1 件足しました");
    expect(appendError()).toContain("3.vttは足せませんでした");
    expect(server.state.data.segments).toHaveLength(5);
  });

  it("音声ファイルは足せないと言う（足せるのは .vtt）", async () => {
    await mount();
    await until(() => paragraphs().length === 4);
    await pick([new File([new Uint8Array([1])], "音声.m4a", { type: "audio/mp4" })]);
    await until(() => appendError() !== "");
    expect(appendError()).toBe("足せるのは文字起こし済みの .vtt ファイルです。");
  });
});
