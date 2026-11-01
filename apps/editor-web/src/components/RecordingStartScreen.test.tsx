// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() };
const frame = { pageCreated: vi.fn(), pageTitleChanged: vi.fn(), pageSaved: vi.fn(), pageOpened: vi.fn(), narrow: false };

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./EditorFrame", () => ({ useEditorFrame: () => frame }));
// jsdom の <audio> はメタデータを読まないので、長さは偽物にする（既定は「分からない」）
vi.mock("@/lib/audio-duration", () => ({ probeAudioDuration: vi.fn(async () => null) }));

import { createHash } from "node:crypto";
import { probeAudioDuration } from "@/lib/audio-duration";
import { resetAudioLimitsCache } from "@/lib/audio-upload-client";
import type { KeptTake, RecordingKeep } from "@/lib/recording-keep";
import { RecordingStartScreen } from "./RecordingStartScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PAGE_ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:04.000\n<v Takuya>こんにちは\n";

const created = {
  page: { id: PAGE_ID, kind: "rec", title: "dinner", lang: "ja", createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z" },
  recording: {
    revision: 1,
    source: "vtt",
    language: "ja",
    engine: "vtt-import",
    durationSec: 4,
    sourceName: "dinner.vtt",
    sourceSha256: null,
    segments: [{ start: 0, end: 4, text: "こんにちは", speaker: 1 }],
    speakerNames: { "1": "Takuya" },
    audio: null,
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
  },
  speakers: [{ speaker: 1, name: "Takuya", count: 1 }],
};

let root: Root | null = null;
let container: HTMLElement | null = null;

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---- 音声の取り込み（#36 段 3b-1）の偽物。合成の値だけ（ticket の url はダミー） ----

const TICKET_URL = "https://storage.example.test/upload?session=synthetic";
const LIMITS = {
  maxBytes: 2 * 1024 ** 3,
  maxDurationSec: 21600,
  retentionDays: 30,
  extensions: ["m4a", "mp3", "wav", "aac", "ogg", "flac", "webm"],
  contentTypes: ["audio/mp4", "audio/x-m4a", "audio/m4a", "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave", "audio/aac", "audio/ogg", "audio/flac", "audio/x-flac", "audio/webm"],
};
const audioPage = { id: PAGE_ID, kind: "rec", title: "合成の会議", lang: "ja", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" };
const audioRecording = (status: "uploading" | "uploaded") => ({ ...created.recording, source: "audio", segments: [], speakerNames: {}, audio: { status, bytes: 3, contentType: "audio/mp4", expiresAt: "2030-01-31T03:00:00.000Z" } });

const audioPart = (partIndex: number, status: "uploading" | "uploaded" = "uploading") => ({
  partIndex,
  status,
  bytes: 3,
  contentType: "audio/mp4",
  durationSec: null,
  offsetSec: 600,
  sourceName: `音声 ${partIndex + 1}.m4a`,
  expiresAt: "2030-01-31T03:00:00.000Z",
});

type Route = () => Response | Promise<Response>;
/** 同じ origin の API の偽物（上限・開始・完了と、2 本目以降の音声）。 */
function audioApi(routes: { limits?: Route; start?: Route; complete?: Route; parts?: Route } = {}) {
  const fetchMock = vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
    const path = String(resource);
    void init;
    if (path === "/api/recordings/audio/limits") return routes.limits ? routes.limits() : respond(200, LIMITS);
    if (path === "/api/recordings/audio/start") {
      return routes.start ? routes.start() : respond(201, { page: audioPage, recording: audioRecording("uploading"), speakers: [], upload: { url: TICKET_URL, method: "PUT", headers: { "Content-Type": "audio/mp4" }, expiresAt: "2030-01-08T00:00:00.000Z", maxBytes: 3 } });
    }
    if (path === `/api/pages/${PAGE_ID}/recording/audio/complete`) return routes.complete ? routes.complete() : respond(200, { recording: audioRecording("uploaded"), speakers: [] });
    // 2 本目以降の音声（#36 段 3b-4）
    if (path === `/api/pages/${PAGE_ID}/recording/audio/parts`) {
      return routes.parts
        ? routes.parts()
        : respond(201, { part: audioPart(1), parts: [audioPart(0, "uploaded"), audioPart(1)], upload: { url: TICKET_URL, method: "PUT", headers: {}, expiresAt: "2030-01-08T00:00:00.000Z", maxBytes: 3 } });
    }
    if (/\/recording\/audio\/parts\/\d+\/complete$/.test(path)) {
      const index = Number(path.split("/").at(-2));
      return respond(200, { part: audioPart(index, "uploaded"), parts: [audioPart(0, "uploaded"), audioPart(index, "uploaded")] });
    }
    throw new Error(`unexpected ${path}`);
  });
  const calls = (path: string) => fetchMock.mock.calls.filter(([resource]) => String(resource) === path);
  return { fetchMock, calls };
}

/** XMLHttpRequest の偽物。send されたら xhrScript を呼ぶ。 */
let xhrScript: (xhr: FakeXhr) => void = (xhr) => xhr.respond(200);
class FakeXhr {
  static created: FakeXhr[] = [];
  url = "";
  headers: Record<string, string> = {};
  body: Blob | null = null;
  status = 0;
  withCredentials = true;
  aborted = false;
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
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: Blob) {
    this.body = body;
    xhrScript(this);
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ loaded, total, lengthComputable: true });
  }
  respond(status: number) {
    this.status = status;
    this.onload?.();
  }
}

/** マイクの偽物（getUserMedia・MediaRecorder・トラック）。 */
function installMic(options: { deny?: string; noRecorder?: boolean } = {}) {
  const tracks: { stopped: boolean; stop: () => void; addEventListener: () => void }[] = [];
  const recorders: { emit: (bytes: number[]) => void }[] = [];
  const getUserMedia = vi.fn(async () => {
    if (options.deny) throw Object.assign(new Error(options.deny), { name: options.deny });
    const track = { stopped: false, stop: () => (track.stopped = true), addEventListener: () => undefined };
    tracks.push(track);
    return { getTracks: () => [track] } as unknown as MediaStream;
  });
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
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
  if (options.noRecorder) vi.stubGlobal("MediaRecorder", undefined);
  else vi.stubGlobal("MediaRecorder", FakeRecorder);
  return { getUserMedia, tracks, recorders };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAudioLimitsCache();
  FakeXhr.created = [];
  xhrScript = (xhr) => xhr.respond(200);
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mount(props: { keep?: RecordingKeep | null; limits?: typeof LIMITS; transcriptionEngine?: string | null } = {}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<RecordingStartScreen {...props} />);
  });
}

/** 端末の控えの偽物（IndexedDB は jsdom に無いので、画面には口だけを渡す）。 */
function memoryKeep(takes: KeptTake[], files: Record<string, File> = {}) {
  const removed: string[] = [];
  const keep: RecordingKeep = {
    begin: async () => undefined,
    addChunk: async () => undefined,
    finish: async () => undefined,
    list: async () => takes,
    load: async (id) => {
      const take = takes.find((item) => item.id === id);
      const file = files[id];
      return take && file ? { take, file } : null;
    },
    remove: async (id) => {
      removed.push(id);
    },
  };
  return { keep, removed };
}

const keptTake = (overrides: Partial<KeptTake> = {}): KeptTake => ({
  id: "33333333-3333-4333-8333-333333333333",
  name: "録音 2030-01-02 09-05.webm",
  mimeType: "audio/webm",
  startedAt: "2030-01-02T00:05:00.000Z",
  durationSec: 65,
  bytes: 2048,
  finished: false,
  ...overrides,
});

const fileInput = () => container!.querySelector<HTMLInputElement>('input[type="file"]')!;
const buttonByText = (text: string) => [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(text))!;
const status = () => container!.querySelector('[role="status"]')?.textContent ?? "";
const alertText = () => container!.querySelector('[role="alert"]')?.textContent ?? "";
const vttFile = (name = "dinner.vtt", text = VTT) => new File([text], name, { type: "text/vtt" });

async function choose(file: File) {
  await chooseMany([file]);
}

async function chooseMany(files: File[]) {
  const input = fileInput();
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const start = (label = "文字起こしをはじめる") => act(async () => buttonByText(label).click());
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("RecordingStartScreen", () => {
  it("accepts .vtt and the audio formats in the file picker, and names them in the drop area", async () => {
    await mount();
    const accept = fileInput().accept.split(",");
    expect(accept.slice(0, 2)).toEqual([".vtt", "text/vtt"]);
    expect(accept).toEqual(expect.arrayContaining([".m4a", ".mp3", ".wav", ".aac", ".ogg", ".flac", ".webm", "audio/mp4", "audio/webm"]));
    expect(fileInput().hidden).toBe(true);
    expect(container!.textContent).toContain(".m4a .mp3 .wav .aac .ogg .flac .webm、文字起こし済みの .vtt も");
  });

  it("opens the file picker from the drop area, and shows the chosen file", async () => {
    await mount();
    const open = vi.spyOn(fileInput(), "click");
    await act(async () => buttonByText("音声ファイルをここにドロップ").click());
    expect(open).toHaveBeenCalledTimes(1);
    await choose(vttFile("dinner.vtt"));
    expect(container!.textContent).toContain("dinner.vtt");
    expect(container!.textContent).toContain("別のファイルを選ぶ");
    expect(alertText()).toBe("");
  });

  it("imports the chosen .vtt: posts its name and text once, adds the page to the list, and moves to it", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => respond(201, created));
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await choose(vttFile());
    await start();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/recordings/import-vtt");
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ name: "dinner.vtt", vtt: VTT });
    expect(frame.pageCreated).toHaveBeenCalledWith(PAGE_ID, "dinner");
    expect(router.push).toHaveBeenCalledWith(`/p/${PAGE_ID}`);
  });

  it("does not send twice while importing", async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await choose(vttFile());
    await start();
    await start();
    await start();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(status()).toBe("取り込んでいます");
    await act(async () => finish(respond(201, created)));
    await settle();
    expect(router.push).toHaveBeenCalledTimes(1);
    await start();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("takes audio files (any listed format) and asks for a file when none is chosen", async () => {
    const { fetchMock } = audioApi();
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await start();
    expect(alertText()).toBe("取り込むファイルを選んでください。");
    for (const name of ["talk.m4a", "talk.mp3", "TALK.WAV", "talk.flac", "録音 2030-01-02 09-05.webm"]) {
      await choose(new File(["x"], name, { type: "" }));
      await settle();
      expect(container!.textContent).toContain(name);
      expect(alertText()).toBe("");
      expect(buttonByText("取り込む")).toBeTruthy();
    }
    // 調べたのは上限だけ（「取り込む」を押すまで何も送らない）
    expect(fetchMock.mock.calls.map(([path]) => String(path))).toEqual(["/api/recordings/audio/limits"]);
  });

  it("refuses a file over 4 MiB before sending, and other kinds of file", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await choose(new File([new Uint8Array(4 * 1024 * 1024 + 1)], "big.vtt", { type: "text/vtt" }));
    expect(alertText()).toContain("4 MiB");
    expect(container!.textContent).not.toContain("big.vtt");
    await choose(new File(["x"], "notes.txt", { type: "text/plain" }));
    expect(alertText()).toContain(".vtt ファイルを選んでください");
    await start();
    expect(fetchMock).not.toHaveBeenCalled();
    // ちょうど 4 MiB は選べる
    await choose(new File([new Uint8Array(4 * 1024 * 1024)], "edge.vtt", { type: "text/vtt" }));
    expect(alertText()).toBe("");
    expect(container!.textContent).toContain("edge.vtt");
  });

  it("takes a dropped .vtt file", async () => {
    await mount();
    const target = container!.querySelector(".es-start")!.parentElement!;
    const event = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer: { files: File[] } };
    event.dataTransfer = { files: [vttFile("dropped.vtt")] };
    await act(async () => {
      target.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(container!.textContent).toContain("dropped.vtt");
  });

  it("shows a failure in Japanese, keeps the chosen file, and imports when pressed again", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(400, { error: "bad_request", reason: "vtt_invalid" }))
      .mockResolvedValueOnce(respond(201, created));
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await choose(vttFile("broken.vtt"));
    await start();
    await settle();
    expect(alertText()).toContain("読み取れませんでした");
    expect(container!.textContent).toContain("broken.vtt");
    expect(router.push).not.toHaveBeenCalled();
    expect(frame.pageCreated).not.toHaveBeenCalled();
    await start();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(router.push).toHaveBeenCalledWith(`/p/${PAGE_ID}`);
    expect(alertText()).toBe("");
  });

  it("keeps the file on a network failure and on a payload that is too large", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(respond(413, { error: "payload_too_large" }));
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await choose(vttFile("a.vtt"));
    await start();
    await settle();
    expect(alertText()).toContain("つながりませんでした");
    await start();
    await settle();
    expect(alertText()).toContain("大きすぎます");
    expect(container!.textContent).toContain("a.vtt");
  });
});

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error("condition not met");
}

const progressBar = () => container!.querySelector("progress");
const audioFile = (name = "合成の会議.m4a", bytes = [1, 2, 3], type = "audio/mp4") => new File([new Uint8Array(bytes)], name, { type });
const fireBeforeUnload = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

describe("RecordingStartScreen（音声ファイル）", () => {
  it("imports an audio file with progress: hashes, starts with a key, PUTs to the ticket, completes, and moves to the recording page", async () => {
    const { fetchMock, calls } = audioApi();
    vi.stubGlobal("fetch", fetchMock);
    let sending: FakeXhr | null = null;
    xhrScript = (xhr) => {
      sending = xhr;
      xhr.progress(1, 3);
    };
    await mount();
    await choose(audioFile());
    await settle();
    expect(container!.textContent).toContain("合成の会議.m4a");
    expect(container!.textContent).toContain("1 KB · 別のファイルを選ぶ");
    await start("取り込む");
    await until(() => sending !== null);
    // 送っている途中: 進み具合（progress）・段階の読み上げ・中止
    await until(() => progressBar()?.value === 33);
    expect(progressBar()!.max).toBe(100);
    expect(progressBar()!.getAttribute("aria-label")).toBe("取り込みの進み具合");
    expect(status()).toBe("送っています");
    expect(container!.querySelector('[role="status"]')!.getAttribute("aria-live")).toBe("polite");
    expect(buttonByText("中止")).toBeTruthy();
    expect(fireBeforeUnload()).toBe(true);
    const start1 = calls("/api/recordings/audio/start")[0]![1]!;
    expect((start1.headers as Record<string, string>)["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(start1.body as string)).toEqual({ name: "合成の会議.m4a", contentType: "audio/mp4", sizeBytes: 3, sha256: createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex") });
    expect(sending!.url).toBe(TICKET_URL);
    expect(sending!.withCredentials).toBe(false);
    expect(sending!.headers).toEqual({ "Content-Type": "audio/mp4" });
    await act(async () => sending!.respond(200));
    await until(() => router.push.mock.calls.length > 0);
    expect(calls(`/api/pages/${PAGE_ID}/recording/audio/complete`)).toHaveLength(1);
    expect(frame.pageCreated).toHaveBeenCalledWith(PAGE_ID, "合成の会議", "rec");
    expect(router.push).toHaveBeenCalledWith(`/p/${PAGE_ID}`);
    expect(alertText()).toBe("");
  });

  it("shows the length when the browser can read it", async () => {
    vi.mocked(probeAudioDuration).mockResolvedValueOnce(878.4);
    vi.stubGlobal("fetch", audioApi().fetchMock);
    await mount();
    await choose(audioFile());
    await settle();
    expect(container!.textContent).toContain("14:38 · 1 KB · 別のファイルを選ぶ");
  });

  it("takes a dropped audio file", async () => {
    vi.stubGlobal("fetch", audioApi().fetchMock);
    await mount();
    const target = container!.querySelector(".es-start")!.parentElement!;
    const event = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer: { files: File[] } };
    event.dataTransfer = { files: [audioFile("dropped.wav", [1], "audio/wav")] };
    await act(async () => {
      target.dispatchEvent(event);
    });
    expect(container!.textContent).toContain("dropped.wav");
    expect(buttonByText("取り込む")).toBeTruthy();
  });

  it("refuses before sending: over the limit (from the server), an unknown format, an empty file", async () => {
    const { fetchMock, calls } = audioApi({ limits: () => respond(200, { ...LIMITS, maxBytes: 1024 * 1024 }) });
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await choose(new File([new Uint8Array(1024 * 1024 + 1)], "大きい.m4a", { type: "audio/mp4" }));
    await settle();
    expect(alertText()).toBe("ファイルが大きすぎます。音声は 1 MiB までです。");
    expect(container!.textContent).not.toContain("大きい.m4a");
    await choose(new File(["x"], "talk.opus", { type: "audio/opus" }));
    expect(alertText()).toContain("音声ファイルか、文字起こし済みの .vtt ファイルを選んでください");
    await choose(audioFile("空.m4a", []));
    expect(alertText()).toContain("ファイルが空です");
    expect(container!.textContent).not.toContain("空.m4a");
    expect(calls("/api/recordings/audio/start")).toHaveLength(0);
    expect(FakeXhr.created).toHaveLength(0);
  });

  it("cancels while sending: keeps the file, says so politely, and takes it in again with the same key", async () => {
    const { fetchMock, calls } = audioApi();
    vi.stubGlobal("fetch", fetchMock);
    xhrScript = (xhr) => xhr.progress(1, 3);
    await mount();
    await choose(audioFile());
    await start("取り込む");
    await until(() => FakeXhr.created.length === 1 && progressBar() !== null);
    await act(async () => buttonByText("中止").click());
    await until(() => progressBar() === null);
    expect(FakeXhr.created[0]!.aborted).toBe(true);
    expect(status()).toBe("取り込みを中止しました。");
    expect(alertText()).toBe("");
    expect(container!.textContent).toContain("合成の会議.m4a");
    expect(fireBeforeUnload()).toBe(false);
    expect(calls(`/api/pages/${PAGE_ID}/recording/audio/complete`)).toHaveLength(0);

    xhrScript = (xhr) => xhr.respond(200);
    await start("取り込む");
    await until(() => router.push.mock.calls.length > 0);
    const keys = calls("/api/recordings/audio/start").map(([, init]) => (init!.headers as Record<string, string>)["idempotency-key"]);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("shows failures as an alert in Japanese without the url, and lets me try again", async () => {
    const { fetchMock } = audioApi({ start: () => respond(503, { error: "storage_unavailable" }) });
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await choose(audioFile());
    await start("取り込む");
    await until(() => alertText() !== "");
    expect(alertText()).toBe("いまは音声を取り込めません。少ししてから、もう一度試してください。");
    expect(container!.querySelector('[role="alert"]')).not.toBeNull();

    vi.stubGlobal("fetch", audioApi().fetchMock);
    xhrScript = (xhr) => xhr.onerror?.();
    await start("取り込む");
    await until(() => alertText().includes("送れませんでした"));
    expect(alertText()).toBe("音声を送れませんでした。ネットワークを確かめて、もう一度試してください。");
    expect(container!.textContent).not.toContain("storage.example.test");
    expect(container!.textContent).toContain("合成の会議.m4a");
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("RecordingStartScreen（音声を 2 本以上まとめて）", () => {
  const audioFile = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: "audio/mp4" });

  it("1 本目で録音ページを作り、残りはその録音に足してから移る", async () => {
    const { fetchMock, calls } = audioApi();
    vi.stubGlobal("fetch", fetchMock);
    await mount({ limits: LIMITS });
    await chooseMany([audioFile("会議 1.m4a"), audioFile("会議 2.m4a"), audioFile("会議 3.m4a")]);
    // 選んだ本数と、取り込みのボタンの文言
    expect(container!.textContent).toContain("ほかに 2 本");
    await start("3 本を取り込む");
    await until(() => router.push.mock.calls.length > 0);
    // 1 本目は録音ページを作る開始、2 本目以降は足す開始
    expect(calls("/api/recordings/audio/start")).toHaveLength(1);
    expect(calls(`/api/pages/${PAGE_ID}/recording/audio/parts`)).toHaveLength(2);
    expect(router.push).toHaveBeenCalledWith(`/p/${PAGE_ID}`);
    expect(frame.pageCreated).toHaveBeenCalledWith(PAGE_ID, "合成の会議", "rec");
  });

  it("足す途中で失敗したら、その場で知らせて録音ページを開ける（1 本目は残る）", async () => {
    const { fetchMock } = audioApi({ parts: () => respond(502, { error: "storage_failed" }) });
    vi.stubGlobal("fetch", fetchMock);
    await mount({ limits: LIMITS });
    await chooseMany([audioFile("会議 1.m4a"), audioFile("会議 2.m4a")]);
    await start("2 本を取り込む");
    await until(() => alertText() !== "");
    expect(alertText()).toBe("会議 2.m4aを足せませんでした。録音ページで足せます。");
    expect(router.push).not.toHaveBeenCalled();
    await act(async () => buttonByText("録音ページを開く").click());
    expect(router.push).toHaveBeenCalledWith(`/p/${PAGE_ID}`);
  });

  it("音声と .vtt を一度に選んだら、音声だけを取り込むと言う", async () => {
    vi.stubGlobal("fetch", audioApi().fetchMock);
    await mount({ limits: LIMITS });
    await chooseMany([audioFile("会議 1.m4a"), vttFile("字幕.vtt")]);
    expect(status()).toBe("音声だけを取り込みます。文字起こし（.vtt）は録音ページで足せます。");
    expect(container!.textContent).not.toContain("ほかに 1 本");
  });

  it(".vtt は 1 つずつ（残りは録音ページで足せる）", async () => {
    vi.stubGlobal("fetch", audioApi().fetchMock);
    await mount({ limits: LIMITS });
    await chooseMany([vttFile("字幕 1.vtt"), vttFile("字幕 2.vtt")]);
    expect(status()).toBe("文字起こし（.vtt）は 1 つずつ取り込めます。残りは録音ページで足せます。");
    expect(container!.textContent).toContain("字幕 1.vtt");
  });
});

describe("RecordingStartScreen（前回の録音・上限の案内）", () => {
  it("録音中に画面を閉じた録音を出し、取り込んで、控えを消す", async () => {
    const take = keptTake();
    const { keep, removed } = memoryKeep([take], { [take.id]: new File([new Uint8Array([1, 2, 3])], take.name, { type: "audio/webm" }) });
    const { fetchMock, calls } = audioApi();
    vi.stubGlobal("fetch", fetchMock);
    await mount({ keep });
    await until(() => container!.querySelector("[data-mic-kept]") !== null);
    const row = container!.querySelector("[data-mic-kept]")!;
    expect(row.getAttribute("data-mic-kept")).toBe("interrupted");
    // 色だけで示さない: 残っていること・長さ・大きさを文で出す
    expect(row.textContent).toContain("前回の録音が残っています（録音中に画面が閉じました）");
    expect(row.textContent).toContain("01:05");
    expect(row.textContent).toContain("2 KB");

    await act(async () => buttonByText("取り込む").click());
    await until(() => router.push.mock.calls.length > 0);
    const body = JSON.parse(calls("/api/recordings/audio/start")[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.name).toBe(take.name);
    expect(body.durationSec).toBe(65);
    // サーバーに入ったので端末には残さない
    expect(removed).toEqual([take.id]);
    expect(router.push).toHaveBeenCalledWith(`/p/${PAGE_ID}`);
  });

  it("「消す」で控えを消し、欄を閉じる", async () => {
    const take = keptTake({ finished: true });
    const { keep, removed } = memoryKeep([take]);
    vi.stubGlobal("fetch", audioApi().fetchMock);
    await mount({ keep });
    await until(() => container!.querySelector("[data-mic-kept]") !== null);
    expect(container!.querySelector("[data-mic-kept]")!.getAttribute("data-mic-kept")).toBe("stopped");
    await act(async () => buttonByText("消す").click());
    expect(removed).toEqual([take.id]);
    expect(container!.querySelector("[data-mic-kept]")).toBeNull();
  });

  it("控えが読めなくなっていたら、欄を閉じて知らせる", async () => {
    const take = keptTake();
    const { keep } = memoryKeep([take]);
    vi.stubGlobal("fetch", audioApi().fetchMock);
    await mount({ keep });
    await until(() => container!.querySelector("[data-mic-kept]") !== null);
    await act(async () => buttonByText("取り込む").click());
    await until(() => alertText() !== "");
    expect(alertText()).toBe("前回の録音が読み出せませんでした。");
    expect(container!.querySelector("[data-mic-kept]")).toBeNull();
  });

  it("長さ・容量の上限と、クラウドの音声が消える日数を出す（server から渡った値。要求を増やさない）", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => respond(200, LIMITS));
    vi.stubGlobal("fetch", fetchMock);
    await mount({ limits: LIMITS });
    expect(container!.textContent).toContain("音声は 1 つ 6 時間・2 GiB まで。クラウドの音声は 30 日で消えます（文字起こしは残ります）");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("録音の開始画面に文字起こしの送信先を正確に表示する", async () => {
    await mount({ limits: LIMITS, transcriptionEngine: "gemini" });
    expect(container!.textContent).toContain("文字起こしを始めると、音声は Google Gemini に送られます");
  });
});

describe("RecordingStartScreen（マイク）", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("records: start, elapsed time, stop; the recording is taken in like a file and opens the recording page", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2030, 0, 2, 9, 5, 30));
    const mic = installMic();
    const { fetchMock, calls } = audioApi();
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await act(async () => buttonByText("録音する").click());
    expect(buttonByText("録音する").getAttribute("aria-pressed")).toBe("true");
    await start("録音をはじめる");
    await until(() => container!.querySelector('[data-mic="recording"]') !== null);
    expect(mic.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(container!.querySelector('[role="timer"]')!.textContent).toBe("00:00");
    expect(fireBeforeUnload()).toBe(true);
    mic.recorders[0]!.emit([1, 2]);
    await start("止める");
    await until(() => router.push.mock.calls.length > 0);
    const body = JSON.parse(calls("/api/recordings/audio/start")[0]![1]!.body as string) as Record<string, unknown>;
    expect(body.name).toBe("録音 2030-01-02 09-05.webm");
    expect(body.contentType).toBe("audio/webm");
    expect(body.sizeBytes).toBe(3);
    expect(body.sha256).toBe(createHash("sha256").update(new Uint8Array([1, 2, 7])).digest("hex"));
    expect(mic.tracks[0]!.stopped).toBe(true);
    expect(frame.pageCreated).toHaveBeenCalledWith(PAGE_ID, "合成の会議", "rec");
    vi.useRealTimers();
  });

  it("counts the elapsed time, and discards the recording after one confirmation (stopping the microphone)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const mic = installMic();
    vi.stubGlobal("fetch", audioApi().fetchMock);
    await mount();
    await act(async () => buttonByText("録音する").click());
    await start("録音をはじめる");
    await until(() => container!.querySelector('[role="timer"]') !== null);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(65_000);
    });
    expect(container!.querySelector('[role="timer"]')!.textContent).toBe("01:05");
    await act(async () => buttonByText("やり直す").click());
    expect(container!.querySelector('[data-mic="confirm"]')!.textContent).toContain("いまの録音を消しますか");
    await act(async () => buttonByText("やめる").click());
    expect(mic.tracks[0]!.stopped).toBe(false);
    await act(async () => buttonByText("やり直す").click());
    await act(async () => buttonByText("消す").click());
    expect(mic.tracks[0]!.stopped).toBe(true);
    expect(container!.querySelector('[data-mic="recording"]')).toBeNull();
    expect(buttonByText("録音をはじめる")).toBeTruthy();
    expect(fireBeforeUnload()).toBe(false);
    vi.useRealTimers();
  });

  it("says why it cannot record: permission denied, no microphone, an unsupported browser", async () => {
    for (const [options, text] of [
      [{ deny: "NotAllowedError" }, "マイクの使用が許可されていません。ブラウザの設定でマイクを許可してください。"],
      [{ deny: "NotFoundError" }, "マイクが見つかりません。マイクをつないでから、もう一度試してください。"],
      [{ noRecorder: true }, "このブラウザでは録音できません。音声ファイルを選んでください。"],
    ] as const) {
      installMic(options);
      await mount();
      await act(async () => buttonByText("録音する").click());
      await start("録音をはじめる");
      await until(() => alertText() !== "");
      expect(alertText()).toBe(text);
      expect(buttonByText("録音をはじめる")).toBeTruthy();
      await act(async () => root?.unmount());
      container?.remove();
      root = null;
      vi.unstubAllGlobals();
      vi.stubGlobal("XMLHttpRequest", FakeXhr);
    }
  });

  it("stops the microphone when the screen goes away while recording", async () => {
    const mic = installMic();
    await mount();
    await act(async () => buttonByText("録音する").click());
    await start("録音をはじめる");
    await until(() => mic.tracks.length === 1);
    await act(async () => root?.unmount());
    root = null;
    expect(mic.tracks[0]!.stopped).toBe(true);
  });

  it("keeps the recording when taking it in fails, and takes it in again", async () => {
    installMic();
    vi.stubGlobal("fetch", audioApi({ start: () => respond(502, { error: "storage_failed" }) }).fetchMock);
    await mount();
    await act(async () => buttonByText("録音する").click());
    await start("録音をはじめる");
    await until(() => container!.querySelector('[data-mic="recording"]') !== null);
    await start("止める");
    await until(() => alertText() !== "");
    expect(alertText()).toBe("いまは音声を取り込めません。少ししてから、もう一度試してください。");
    expect(container!.querySelector('[data-mic="ready"]')!.textContent).toMatch(/^録音 \d{4}-\d{2}-\d{2} \d{2}-\d{2}\.webm · 00:00 · 1 KB/);
    expect(fireBeforeUnload()).toBe(true);
    vi.stubGlobal("fetch", audioApi().fetchMock);
    await start("取り込む");
    await until(() => router.push.mock.calls.length > 0);
  });
});
