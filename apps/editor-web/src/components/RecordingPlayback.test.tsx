// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as recordingView from "@/lib/recording-view";
import { TranscriptPage } from "./TranscriptPage";

// 段落の欄を描き直した回数を数える（再生位置が段落の中で動くだけなら描き直さない）
vi.mock("@/lib/recording-view", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/recording-view")>();
  return { ...actual, shellSegments: vi.fn(actual.shellSegments) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 合成の値だけ（実在の人名・音声は使わない）。再生は文字起こしのタブ（TAB）で、音声は元の録音のタブ（PAGE_ID）から
const PAGE_ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const TAB = "7a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const FUTURE = "2099-01-31T03:00:00.000Z";
const PAST = "2000-01-09T03:00:00.000Z";
const SEGMENTS = [
  { start: 0, end: 4, text: "合成の一つ目の段落です。", speaker: 1 },
  { start: 4, end: 9, text: "合成の二つ目の段落です。", speaker: 2 },
  { start: null, end: null, text: "時刻の無い合成の段落です。", speaker: 1 },
  { start: 9, end: 12, text: "同じ時刻に始まる一つ目です。", speaker: 1 },
  { start: 9, end: 12, text: "同じ時刻に始まる二つ目です。", speaker: 2 },
  { start: 12, end: 15, text: "合成の最後の段落です。", speaker: 1 },
];

type AudioShape = { status: "uploading" | "uploaded"; bytes: number; contentType: string; expiresAt: string | null } | null;

function createServer(options: { audio?: AudioShape; segments?: typeof SEGMENTS; durationSec?: number | null } = {}) {
  const segments = options.segments ?? SEGMENTS;
  const audio = options.audio === undefined ? { status: "uploaded" as const, bytes: 10, contentType: "audio/mp4", expiresAt: FUTURE } : options.audio;
  const durationSec = options.durationSec === undefined ? 125 : options.durationSec;
  const speakers = [1, 2].map((speaker) => ({ speaker, name: null, count: segments.filter((segment) => segment.speaker === speaker).length }));
  const recording = () => ({
    recording: {
      revision: 1,
      source: audio ? "audio" : "vtt",
      language: "ja",
      engine: null,
      durationSec,
      sourceName: "合成の会議.m4a",
      sourceSha256: null,
      audio,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
    },
    audios: audio ? [{ partIndex: 0, status: audio.status, bytes: audio.bytes, contentType: audio.contentType, durationSec, offsetSec: 0, sourceName: null, expiresAt: audio.expiresAt }] : [],
    transcripts: [],
    engines: ["fake"],
    defaultEngine: "fake",
  });
  const transcript = () => ({
    transcript: { revision: 1, recording: PAGE_ID, engine: "fake", engineLabel: "開発の偽物", language: "ja", durationSec, segments, speakerNames: {}, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" },
    speakers,
    run: null,
  });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchMock = vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
    const path = String(resource);
    if (path === `/api/pages/${PAGE_ID}/recording` && init?.method === "GET") return json(200, recording());
    if (path === `/api/pages/${TAB}/transcript` && init?.method === "GET") return json(200, transcript());
    if (path === `/api/pages/${TAB}/transcript/versions`) return json(200, { versions: [] });
    throw new Error(`unexpected ${init?.method} ${path}`);
  });
  return { fetchMock };
}

/** jsdom は再生を持たないので、HTMLMediaElement の再生の部分だけを偽物にする（play・pause・load・currentTime・paused・duration・error）。 */
type MediaState = { paused: boolean; currentTime: number; duration: number; error: { code: number } | null };
const media = new WeakMap<HTMLMediaElement, MediaState>();
const stateOf = (element: HTMLMediaElement): MediaState => {
  let state = media.get(element);
  if (!state) {
    state = { paused: true, currentTime: 0, duration: 15, error: null };
    media.set(element, state);
  }
  return state;
};
let playFailure: Error | null = null;
const play = vi.fn(function (this: HTMLMediaElement) {
  if (playFailure) return Promise.reject(playFailure);
  const state = stateOf(this);
  if (state.paused) {
    state.paused = false;
    this.dispatchEvent(new Event("play"));
  }
  return Promise.resolve();
});
const pause = vi.fn(function (this: HTMLMediaElement) {
  const state = stateOf(this);
  if (!state.paused) {
    state.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
});
const load = vi.fn(function (this: HTMLMediaElement) {
  stateOf(this).error = null;
});
const PATCHED = ["play", "pause", "load", "paused", "currentTime", "duration", "error", "ended"] as const;
const originals = new Map<string, PropertyDescriptor | undefined>();

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  window.localStorage.clear();
  playFailure = null;
  for (const name of PATCHED) originals.set(name, Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, name));
  const proto = HTMLMediaElement.prototype;
  Object.defineProperty(proto, "play", { configurable: true, writable: true, value: play });
  Object.defineProperty(proto, "pause", { configurable: true, writable: true, value: pause });
  Object.defineProperty(proto, "load", { configurable: true, writable: true, value: load });
  Object.defineProperty(proto, "paused", { configurable: true, get(this: HTMLMediaElement) { return stateOf(this).paused; } });
  Object.defineProperty(proto, "ended", { configurable: true, get: () => false });
  Object.defineProperty(proto, "duration", { configurable: true, get(this: HTMLMediaElement) { return stateOf(this).duration; } });
  Object.defineProperty(proto, "error", { configurable: true, get(this: HTMLMediaElement) { return stateOf(this).error; } });
  Object.defineProperty(proto, "currentTime", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return stateOf(this).currentTime;
    },
    set(this: HTMLMediaElement, value: number) {
      // ブラウザは位置を変えると seeked を出す
      stateOf(this).currentTime = value;
      this.dispatchEvent(new Event("seeked"));
    },
  });
  play.mockClear();
  pause.mockClear();
  load.mockClear();
  vi.mocked(recordingView.shellSegments).mockClear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  for (const name of PATCHED) {
    const descriptor = originals.get(name);
    if (descriptor) Object.defineProperty(HTMLMediaElement.prototype, name, descriptor);
    else delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(server = createServer()) {
  vi.stubGlobal("fetch", server.fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<TranscriptPage tabId={TAB} recording={PAGE_ID} />);
  });
  for (let attempt = 0; attempt < 20 && !container.querySelector('[data-transcript="ready"]'); attempt += 1) await settle();
  // 元の録音（音声の列）は別の要求。それが届くまで待つ
  for (let attempt = 0; attempt < 20 && !container.querySelector("audio") && !container.querySelector("[data-transcript-audio]"); attempt += 1) await settle();
  await settle();
  return server;
}

const audio = () => container!.querySelector<HTMLAudioElement>("audio[data-recording-audio]");
const playButton = () => container!.querySelector<HTMLButtonElement>(".es-play");
const timeButtons = () => [...container!.querySelectorAll<HTMLButtonElement>("button.es-at")];
const highlighted = () => [...container!.querySelectorAll(".es-seg")].map((row, index) => (row.classList.contains("es-seg--cur") ? index : -1)).filter((index) => index >= 0);
const paragraphs = () => [...container!.querySelectorAll<HTMLElement>(".es-seg p")];
const slider = () => container!.querySelector<HTMLInputElement>('input[aria-label="再生位置"]');
const alerts = () => [...container!.querySelectorAll('[role="alert"]')].map((node) => node.textContent ?? "");
const segmentRenders = () => vi.mocked(recordingView.shellSegments).mock.calls.length;

/** 再生位置を動かして timeupdate を出す（ブラウザが再生中に出すのと同じ）。 */
function advance(seconds: number) {
  act(() => {
    stateOf(audio()!).currentTime = seconds;
    audio()!.dispatchEvent(new Event("timeupdate"));
  });
}

describe("録音ページの再生（#36 段 3b-2）: 出すとき・出さないとき", () => {
  it("draws one <audio preload=metadata> from the same-origin route, the play button, the position slider and the time buttons when the audio is playable", async () => {
    await mount();
    expect(container!.querySelectorAll("audio")).toHaveLength(1);
    expect(audio()!.getAttribute("src")).toBe(`/api/pages/${PAGE_ID}/recording/audio?part=0`);
    expect(audio()!.getAttribute("preload")).toBe("metadata");
    expect(audio()!.hasAttribute("controls")).toBe(false);
    expect(playButton()!.getAttribute("aria-label")).toBe("再生");
    expect(container!.querySelector(".es-wave")).toBeNull();
    expect(slider()).not.toBeNull();
    // 時刻の無い段落にはボタンが無い
    expect(timeButtons().map((button) => button.getAttribute("aria-label"))).toEqual(["00:00 から再生", "00:04 から再生", "00:09 から再生", "00:09 から再生", "00:12 から再生"]);
    // まだ再生していないので、どの段落も強調しない
    expect(highlighted()).toEqual([]);
  });

  it("keeps the source when React detaches and re-attaches the element (StrictMode in development)", async () => {
    vi.stubGlobal("fetch", createServer().fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <StrictMode>
          <TranscriptPage tabId={TAB} recording={PAGE_ID} />
        </StrictMode>,
      );
    });
    for (let attempt = 0; attempt < 20 && !audio(); attempt += 1) await settle();
    expect(audio()!.getAttribute("src")).toBe(`/api/pages/${PAGE_ID}/recording/audio?part=0`);
    await act(async () => timeButtons()[1]!.click());
    expect(play).toHaveBeenCalledTimes(1);
    expect(highlighted()).toEqual([1]);
  });

  it("draws no playback parts for a VTT recording, audio still uploading, or expired audio", async () => {
    for (const options of [
      { audio: null },
      { audio: { status: "uploading" as const, bytes: 10, contentType: "audio/mp4", expiresAt: FUTURE } },
      { audio: { status: "uploaded" as const, bytes: 10, contentType: "audio/mp4", expiresAt: PAST } },
    ]) {
      await mount(createServer(options));
      const label = JSON.stringify(options);
      expect(container!.querySelector("audio"), label).toBeNull();
      expect(playButton(), label).toBeNull();
      expect(timeButtons(), label).toEqual([]);
      expect(slider(), label).toBeNull();
      if (options.audio === null) expect(container!.querySelector(".es-time")?.textContent).toBe("長さ 02:05");
      if (options.audio?.expiresAt === PAST) expect(container!.textContent).toContain("音声は削除されたので、再生できません");
      await act(async () => root!.unmount());
      container!.remove();
      root = null;
    }
  });

  it("keeps audio available before transcription segments exist", async () => {
    await mount(createServer({ segments: [] }));
    expect(audio()).not.toBeNull();
    expect(container!.querySelector('button[aria-label="再生"]')).not.toBeNull();
    expect(timeButtons()).toEqual([]);
    expect(slider()).not.toBeNull();
  });
});

describe("録音ページの再生: 操作", () => {
  it("plays from the paragraph whose time is pressed, highlights it, and turns the button into pause", async () => {
    await mount();
    await act(async () => timeButtons()[1]!.click());
    expect(stateOf(audio()!).currentTime).toBe(4);
    expect(play).toHaveBeenCalledTimes(1);
    expect(highlighted()).toEqual([1]);
    expect(playButton()!.getAttribute("aria-label")).toBe("一時停止");
    // 同じ時刻の二つ目を押しても、強調はその時刻の最初の段落
    await act(async () => timeButtons()[3]!.click());
    expect(stateOf(audio()!).currentTime).toBe(9);
    expect(highlighted()).toEqual([3]);
  });

  it("toggles play and pause with the button", async () => {
    await mount();
    await act(async () => playButton()!.click());
    expect(play).toHaveBeenCalledTimes(1);
    expect(playButton()!.getAttribute("aria-label")).toBe("一時停止");
    await act(async () => playButton()!.click());
    expect(pause).toHaveBeenCalledTimes(1);
    expect(playButton()!.getAttribute("aria-label")).toBe("再生");
  });

  it("says so when play() is refused (autoplay rules), and not for an interrupted play()", async () => {
    await mount();
    playFailure = Object.assign(new Error("interrupted"), { name: "AbortError" });
    await act(async () => playButton()!.click());
    await settle();
    expect(alerts()).toEqual([]);
    playFailure = Object.assign(new Error("not allowed"), { name: "NotAllowedError" });
    await act(async () => timeButtons()[0]!.click());
    await settle();
    expect(alerts()).toEqual(["再生できませんでした"]);
    // 次に再生が始まったら消える
    playFailure = null;
    await act(async () => playButton()!.click());
    expect(alerts()).toEqual([]);
  });

  it("follows the position with the highlight, and redraws the paragraphs only when the paragraph changes", async () => {
    await mount();
    await act(async () => playButton()!.click());
    expect(highlighted()).toEqual([0]);
    await settle();
    advance(0);
    await settle();
    const before = segmentRenders();
    // 同じ段落の中で位置が動くだけ（ブラウザは 4 回／秒ほど timeupdate を出す）
    for (const seconds of [0.25, 0.5, 1, 2, 3.75]) advance(seconds);
    expect(segmentRenders()).toBe(before);
    expect(highlighted()).toEqual([0]);
    advance(4.2);
    expect(highlighted()).toEqual([1]);
    await settle();
    const secondSegmentRenders = segmentRenders();
    advance(6);
    await settle();
    const withinSecondSegmentRenders = segmentRenders();
    expect(withinSecondSegmentRenders).toBeLessThanOrEqual(secondSegmentRenders + 1);
    advance(8.9);
    await settle();
    expect(segmentRenders()).toBe(withinSecondSegmentRenders);
    // 時刻の無い段落は飛ばし、同じ時刻の段落は最初の段落
    advance(10);
    expect(highlighted()).toEqual([3]);
    await settle();
    const thirdSegmentRenders = segmentRenders();
    advance(14);
    expect(highlighted()).toEqual([5]);
    await settle();
    expect(segmentRenders()).toBe(thirdSegmentRenders + 1);
    // 一時停止しても強調は残る（どこまで聞いたかが分かる）
    await act(async () => playButton()!.click());
    expect(highlighted()).toEqual([5]);
  });

  it("does not disturb a paragraph being written when the highlight moves onto it", async () => {
    await mount();
    await act(async () => playButton()!.click());
    const target = paragraphs()[1]!;
    target.tabIndex = -1;
    act(() => target.focus());
    act(() => {
      target.textContent = "書いている途中の合成の文章";
      target.dispatchEvent(new Event("input", { bubbles: true }));
    });
    advance(5);
    expect(highlighted()).toEqual([1]);
    expect(paragraphs()[1]).toBe(target);
    expect(target.textContent).toBe("書いている途中の合成の文章");
    expect(document.activeElement).toBe(target);
    expect(container!.querySelector("[data-save-state]")!.getAttribute("data-save-state")).toBe("pending");
  });

  it("moves the position with the slider (1 second steps), without counting it as writing", async () => {
    await mount(createServer({ durationSec: 15 }));
    const input = slider()!;
    expect(input.max).toBe("15");
    expect(input.getAttribute("aria-valuetext")).toBe("00:00 / 00:15");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "7");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(stateOf(audio()!).currentTime).toBe(7);
    expect(container!.querySelector("[data-save-state]")!.getAttribute("data-save-state")).toBe("saved");
    advance(7);
    expect(slider()!.getAttribute("aria-valuetext")).toBe("00:07 / 00:15");
    expect(container!.querySelector(".es-seek .es-time")?.textContent).toBe("00:07 / 00:15");
  });

  it("uses the recording length when the browser does not know the duration (microphone webm)", async () => {
    await mount(createServer({ durationSec: 42 }));
    act(() => {
      stateOf(audio()!).duration = Number.POSITIVE_INFINITY;
      audio()!.dispatchEvent(new Event("durationchange"));
    });
    expect(slider()!.max).toBe("42");
    expect(slider()!.disabled).toBe(false);
  });

  it("says the audio cannot be played on an error, keeps the player, and loads again on もう一度", async () => {
    await mount();
    const loadsBeforeRetry = load.mock.calls.length;
    act(() => {
      stateOf(audio()!).error = { code: 4 };
      audio()!.dispatchEvent(new Event("error"));
    });
    expect(alerts()).toEqual(["音声 1を読み込めません。期限切れまたは見つからない可能性があります。別の音声へ移動できます。もう一度"]);
    expect(playButton()).not.toBeNull();
    expect(audio()).not.toBeNull();
    const retry = container!.querySelector<HTMLButtonElement>('button[aria-label="音声をもう一度読み込む"]')!;
    expect(retry.textContent).toBe("もう一度");
    await act(async () => retry.click());
    expect(load).toHaveBeenCalledTimes(loadsBeforeRetry + 1);
    expect(alerts()).toEqual([]);
    // 読み直して長さが分かったら、そのまま再生できる
    act(() => audio()!.dispatchEvent(new Event("loadedmetadata")));
    await act(async () => playButton()!.click());
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("stops and drops the source when the page goes away (no playing in the background)", async () => {
    await mount();
    await act(async () => playButton()!.click());
    const element = audio()!;
    expect(stateOf(element).paused).toBe(false);
    load.mockClear();
    await act(async () => root!.unmount());
    root = null;
    expect(pause).toHaveBeenCalled();
    expect(stateOf(element).paused).toBe(true);
    expect(element.hasAttribute("src")).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
