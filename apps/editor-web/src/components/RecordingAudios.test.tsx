// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom の <audio> はメタデータを読まないので、長さは偽物にする（既定は「分からない」）
vi.mock("@/lib/audio-duration", () => ({ probeAudioDuration: vi.fn(async () => null) }));

import type { AudioPartView } from "@/lib/audio-upload-client";
import { resetAudioLimitsCache } from "@/lib/audio-upload-client";
import { RecordingAudios } from "./RecordingAudios";

const PAGE_ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const TICKET_URL = "https://storage.example.test/upload?session=synthetic";
const LIMITS = {
  maxBytes: 2 * 1024 ** 3,
  maxDurationSec: 21600,
  retentionDays: 30,
  extensions: ["m4a", "mp3", "wav", "aac", "ogg", "flac", "webm"],
  contentTypes: ["audio/mp4", "audio/x-m4a", "audio/m4a", "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave", "audio/aac", "audio/ogg", "audio/flac", "audio/x-flac", "audio/webm"],
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const part = (extra: Partial<AudioPartView> = {}): AudioPartView => ({
  partIndex: 0,
  status: "uploaded",
  bytes: 2 * 1024 * 1024,
  contentType: "audio/mp4",
  durationSec: 600,
  offsetSec: 0,
  sourceName: "音声 1.m4a",
  expiresAt: "2030-02-01T00:00:00.000Z",
  ...extra,
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** 2 本目以降の音声の API の偽物（上限・開始・完了）。 */
function partsApi() {
  let next = 1;
  const fetchMock = vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const path = String(resource);
    if (path === "/api/recordings/audio/limits") return json(200, LIMITS);
    if (path === `/api/pages/${PAGE_ID}/recording/audio/parts`) {
      const added = part({ partIndex: next, status: "uploading", sourceName: `音声 ${next + 1}.m4a` });
      next += 1;
      return json(201, { part: added, parts: [part(), added], upload: { url: TICKET_URL, method: "PUT", headers: {}, expiresAt: "2030-01-08T00:00:00.000Z", maxBytes: 3 } });
    }
    if (/\/recording\/audio\/parts\/\d+\/complete$/.test(path)) {
      const index = Number(path.split("/").at(-2));
      return json(200, { part: part({ partIndex: index }), parts: [part(), part({ partIndex: index })] });
    }
    throw new Error(`unexpected ${path}`);
  });
  const calls = (pattern: RegExp) => fetchMock.mock.calls.filter(([resource]) => pattern.test(String(resource)));
  return { fetchMock, calls };
}

/** XMLHttpRequest の偽物（保存先への PUT）。 */
class FakeXhr {
  static created: FakeXhr[] = [];
  url = "";
  status = 0;
  withCredentials = true;
  upload: { onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  constructor() {
    FakeXhr.created.push(this);
  }
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  send() {
    this.status = 200;
    this.onload?.();
  }
  abort() {
    this.onabort?.();
  }
}

/** マイクの偽物。 */
function installMic() {
  const tracks: { stopped: boolean; stop: () => void; addEventListener: () => void }[] = [];
  const getUserMedia = vi.fn(async () => {
    const track = { stopped: false, stop: () => (track.stopped = true), addEventListener: () => undefined };
    tracks.push(track);
    return { getTracks: () => [track] } as unknown as MediaStream;
  });
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  const recorders: { emit: (bytes: number[]) => void }[] = [];
  class FakeRecorder {
    static isTypeSupported = (type: string) => type === "audio/webm;codecs=opus";
    state = "inactive";
    mimeType: string;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(_stream: MediaStream, init?: { mimeType?: string }) {
      this.mimeType = init?.mimeType ?? "audio/webm";
      recorders.push(this);
    }
    start() {
      this.state = "recording";
    }
    emit(bytes: number[]) {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) });
    }
    stop() {
      this.state = "inactive";
      this.emit([7]);
      this.onstop?.();
    }
  }
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  return { getUserMedia, tracks, recorders };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  resetAudioLimitsCache();
  FakeXhr.created = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  Reflect.deleteProperty(navigator, "mediaDevices");
  vi.unstubAllGlobals();
});

async function mount(audios: AudioPartView[], onChanged = vi.fn()) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<RecordingAudios pageId={PAGE_ID} audios={audios} onChanged={onChanged} />);
  });
  return onChanged;
}

const fileInput = () => container!.querySelector<HTMLInputElement>('input[type="file"]')!;
const buttonByText = (text: string) => [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text);
const click = (text: string) => act(async () => buttonByText(text)!.click());
const statusText = () => container!.querySelector('[role="status"]')?.textContent ?? "";
const alertText = () => container!.querySelector('[role="alert"]')?.textContent ?? "";

async function choose(files: File[]) {
  const input = fileInput();
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("condition not met");
}

const audioFile = (name = "音声 2.m4a") => new File([new Uint8Array([1, 2, 3])], name, { type: "audio/mp4" });

describe("RecordingAudios（1 ページに音声を複数）", () => {
  it("音声の列を、長さ・大きさ・期限つきで出す（状態は文で）", async () => {
    await mount([
      part(),
      part({ partIndex: 1, status: "uploading", durationSec: 300, bytes: 1024, sourceName: "音声 2.m4a" }),
      part({ partIndex: 2, durationSec: 120, expiresAt: "2020-01-01T00:00:00.000Z", sourceName: "音声 3.m4a" }),
    ]);
    const rows = [...container!.querySelectorAll("[data-audio-part]")].map((row) => row.textContent ?? "");
    expect(rows[0]).toContain("音声 1（音声 1.m4a） · 10:00 · 2.0 MB");
    expect(rows[0]).toContain("月1日に削除されます");
    expect(rows[1]).toContain("音声 2（音声 2.m4a） · 05:00 · 1 KB · 取り込み中");
    expect(rows[2]).toContain("音声は削除されました");
  });

  it("取り込みの途中の音声（2 本目以降）にだけ「取り消す」が出て、押すとその行を消して録音を読み直す", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", path });
        return new Response(JSON.stringify({ parts: [part()] }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const onChanged = await mount([part(), part({ partIndex: 1, status: "uploading", durationSec: 300, bytes: 1024 }), part({ partIndex: 2, durationSec: 120 })]);
    // 途中の 2 本目だけ。1 本目と、済んだ 3 本目には出ない
    expect([...container!.querySelectorAll("[data-audio-part] button")].map((button) => button.getAttribute("aria-label"))).toEqual(["音声 2 の取り込みを取り消す"]);

    await click("取り消す");
    expect(calls).toEqual([{ method: "DELETE", path: `/api/pages/${PAGE_ID}/recording/audio/parts/1` }]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(statusText()).toContain("音声 2 の取り込みを取り消しました");
  });

  it("取り消そうとした音声がもう済んでいたら、そう伝えて読み直す（消えない）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not_unfinished" }), { status: 409, headers: { "content-type": "application/json" } })));
    const onChanged = await mount([part(), part({ partIndex: 1, status: "uploading", durationSec: 300, bytes: 1024 })]);
    await click("取り消す");
    expect(alertText()).toContain("この音声はもう取り込みが済んでいます");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("音声が無ければそう言う", async () => {
    await mount([]);
    expect(container!.querySelector('[data-audio-part="none"]')?.textContent).toBe("この録音には音声がありません");
  });

  it("選んだ音声を順に足し、やり直すとつながると知らせる", async () => {
    const { fetchMock, calls } = partsApi();
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = await mount([part()]);
    await choose([audioFile("音声 2.m4a"), audioFile("音声 3.m4a")]);
    await until(() => statusText().includes("足しました"));
    // 2 本とも 開始 → PUT → 完了
    expect(calls(/\/recording\/audio\/parts$/)).toHaveLength(2);
    expect(calls(/\/complete$/)).toHaveLength(2);
    expect(FakeXhr.created.map((xhr) => xhr.url)).toEqual([TICKET_URL, TICKET_URL]);
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(statusText()).toBe("音声を 2 本足しました。文字起こしをやり直すと 1 本につながります");
    expect(alertText()).toBe("");
  });

  it("音声ではないファイルは断る（.vtt は「文字起こしを足す」へ）", async () => {
    vi.stubGlobal("fetch", partsApi().fetchMock);
    await mount([part()]);
    await choose([new File(["WEBVTT\n"], "字幕.vtt", { type: "text/vtt" })]);
    await until(() => alertText() !== "");
    expect(alertText()).toContain("足せるのは音声ファイルです");
    expect(fileInput().multiple).toBe(true);
  });

  it("送れなかったら理由を出す（足した分は残る）", async () => {
    let fail = false;
    const { fetchMock } = partsApi();
    const failing = vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
      if (fail && String(resource).endsWith("/parts")) return json(503, { error: "storage_unavailable" });
      return fetchMock(resource, init);
    });
    vi.stubGlobal("fetch", failing);
    const onChanged = await mount([part()]);
    await choose([audioFile("音声 2.m4a")]);
    await until(() => statusText().includes("足しました"));
    fail = true;
    await choose([audioFile("音声 3.m4a")]);
    await until(() => alertText() !== "");
    expect(alertText()).toBe("いまは音声を取り込めません。少ししてから、もう一度試してください。");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("その場で録音して足せる（止めるとそのまま送る）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2030, 0, 2, 9, 5, 30));
    const mic = installMic();
    const { fetchMock, calls } = partsApi();
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = await mount([part()]);
    await click("録音して足す");
    await until(() => container!.querySelector('[data-mic="recording"]') !== null);
    expect(mic.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(container!.querySelector('[role="timer"]')?.textContent).toBe("00:00");
    mic.recorders[0]!.emit([1, 2]);
    await click("止めて足す");
    await until(() => statusText().includes("録音を足しました"));
    const body = JSON.parse(String(calls(/\/recording\/audio\/parts$/)[0]![1]!.body)) as Record<string, unknown>;
    expect(body.name).toBe("録音 2030-01-02 09-05.webm");
    expect(body.contentType).toBe("audio/webm");
    // 2 本目以降は言語を送らない（ページの言語を使う）
    expect(body.lang).toBeUndefined();
    expect(mic.tracks[0]!.stopped).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
