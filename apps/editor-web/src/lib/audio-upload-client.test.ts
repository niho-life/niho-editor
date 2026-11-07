import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AudioUploadError,
  AudioUploadFailure,
  audioUploadMessage,
  checkAudioFile,
  completeAudioUpload,
  getAudioLimits,
  putAudio,
  putAudioWithProgress,
  resetAudioLimitsCache,
  startAudioUpload,
  uploadAudioFile,
  type AudioUploadFailureKind,
  type AudioUploadProgress,
  type AudioUploadTicket,
  type XhrLike,
} from "./audio-upload-client";

// 合成の値だけ（ticket の url はダミー）
const ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const KEY = "0b6c9a4e-3f0a-4c5e-9d1e-2a7b8c9d0e1f";
const SHA = "e".repeat(64);
const LIMITS = { maxBytes: 2147483648, maxDurationSec: 21600, retentionDays: 30, extensions: ["m4a", "mp3"], contentTypes: ["audio/mp4", "audio/mpeg"] };
const TICKET: AudioUploadTicket = { url: "https://storage.example.test/upload?session=synthetic", method: "PUT", headers: { "Content-Type": "audio/mp4" }, expiresAt: "2030-01-08T00:00:00.000Z", maxBytes: 3 };
const RECORDING = { revision: 1, source: "audio", audio: { status: "uploading", bytes: 3, contentType: "audio/mp4", expiresAt: "2030-01-31T00:00:00.000Z" } };
const PAGE = { id: ID, kind: "rec", title: "合成", lang: "ja", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" };

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("audio upload client", () => {
  it("reads the limits from the same origin, uncached", async () => {
    const fetchMock = respond(200, { ...LIMITS, extra: "dropped" });
    expect(await getAudioLimits(fetchMock as unknown as typeof fetch)).toEqual(LIMITS);
    expect(fetchMock).toHaveBeenCalledWith("/api/recordings/audio/limits", { method: "GET", credentials: "same-origin", cache: "no-store" });
    await expect(getAudioLimits(respond(200, { maxBytes: "x" }) as unknown as typeof fetch)).rejects.toMatchObject({ status: 500 });
    await expect(getAudioLimits(respond(401, { error: "unauthorized" }) as unknown as typeof fetch)).rejects.toMatchObject({ status: 401, error: "unauthorized" });
  });

  it("starts an upload with the JSON body and the Idempotency-Key, and returns the ticket", async () => {
    const fetchMock = respond(201, { page: PAGE, recording: RECORDING, upload: TICKET });
    const started = await startAudioUpload({ name: "合成.m4a", contentType: "audio/mp4", sizeBytes: 3, sha256: SHA, lang: "en", durationSec: 1.5 }, { idempotencyKey: KEY, fetch: fetchMock as unknown as typeof fetch });
    expect(started).toEqual({ status: 201, page: PAGE, recording: RECORDING, upload: TICKET });
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/recordings/audio/start");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json", "idempotency-key": KEY } });
    expect(JSON.parse(init.body as string)).toEqual({ name: "合成.m4a", contentType: "audio/mp4", sizeBytes: 3, sha256: SHA, lang: "en", durationSec: 1.5 });

    const replay = respond(200, { page: PAGE, recording: { ...RECORDING, audio: { ...RECORDING.audio, status: "uploaded" } }, upload: null });
    const done = await startAudioUpload({ name: "合成.m4a", contentType: "audio/mp4", sizeBytes: 3, sha256: SHA }, { fetch: replay as unknown as typeof fetch });
    expect(done.status).toBe(200);
    expect(done.upload).toBeNull();
    const [, replayInit] = replay.mock.calls[0] as unknown as [string, RequestInit];
    expect(replayInit.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(replayInit.body as string)).toEqual({ name: "合成.m4a", contentType: "audio/mp4", sizeBytes: 3, sha256: SHA });
  });

  it("turns refusals into AudioUploadError with the server's code and reason, and refuses a malformed answer", async () => {
    const input = { name: "合成.m4a", contentType: "audio/mp4", sizeBytes: 3, sha256: SHA };
    for (const [status, body] of [
      [400, { error: "bad_request", reason: "too_large" }],
      [409, { error: "idempotency_conflict" }],
      [503, { error: "storage_unavailable" }],
      [502, { error: "storage_failed" }],
    ] as const) {
      const error = await startAudioUpload(input, { fetch: respond(status, body) as unknown as typeof fetch }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AudioUploadError);
      expect(error).toMatchObject({ status, error: body.error, reason: "reason" in body ? body.reason : null });
    }
    await expect(startAudioUpload(input, { fetch: respond(201, { page: PAGE, recording: RECORDING, upload: { ...TICKET, method: "POST" } }) as unknown as typeof fetch })).rejects.toMatchObject({ status: 500 });
    await expect(startAudioUpload(input, { fetch: respond(201, { page: PAGE }) as unknown as typeof fetch })).rejects.toMatchObject({ status: 500 });
    await expect(startAudioUpload(input, { idempotencyKey: "not-a-uuid", fetch: respond(201, {}) as unknown as typeof fetch })).rejects.toBeInstanceOf(TypeError);
  });

  it("PUTs the file to the ticket url with its headers and no credentials; 412 means it is already there", async () => {
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" });
    const fetchMock = respond(200, undefined);
    await putAudio(TICKET, file, fetchMock as unknown as typeof fetch);
    expect(fetchMock).toHaveBeenCalledWith(TICKET.url, { method: "PUT", headers: { "Content-Type": "audio/mp4" }, body: file, credentials: "omit", cache: "no-store" });
    await expect(putAudio(TICKET, file, respond(412, undefined) as unknown as typeof fetch)).resolves.toBeUndefined();
    const failed = await putAudio(TICKET, file, respond(403, { secret: "storage body" }) as unknown as typeof fetch).catch((caught: unknown) => caught);
    expect(failed).toMatchObject({ status: 403, error: null, reason: null });
    expect(String(failed)).not.toContain(TICKET.url);
  });

  it("completes the upload for the page and reports missing or size_mismatch", async () => {
    const fetchMock = respond(200, { recording: { ...RECORDING, audio: { ...RECORDING.audio, status: "uploaded" } } });
    const done = await completeAudioUpload(ID, fetchMock as unknown as typeof fetch);
    expect(done.recording.audio?.status).toBe("uploaded");
    expect(fetchMock).toHaveBeenCalledWith(`/api/pages/${ID}/recording/audio/complete`, { method: "POST", credentials: "same-origin", cache: "no-store" });
    await expect(completeAudioUpload(ID, respond(409, { error: "incomplete", reason: "size_mismatch" }) as unknown as typeof fetch)).rejects.toMatchObject({
      status: 409,
      error: "incomplete",
      reason: "size_mismatch",
    });
    const encoded = respond(404, { error: "not_found" });
    await expect(completeAudioUpload("../search?q=x", encoded as unknown as typeof fetch)).rejects.toMatchObject({ status: 404 });
    expect((encoded.mock.calls[0] as unknown as [string])[0]).toBe("/api/pages/..%2Fsearch%3Fq%3Dx/recording/audio/complete");
  });
});

// ---- 画面から呼ぶ一続きの流れ（#36 段 3b-1） ----

const FULL_LIMITS = {
  maxBytes: 2 * 1024 ** 3,
  maxDurationSec: 21600,
  retentionDays: 30,
  extensions: ["m4a", "mp3", "wav", "aac", "ogg", "flac", "webm"],
  contentTypes: ["audio/mp4", "audio/x-m4a", "audio/m4a", "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave", "audio/aac", "audio/ogg", "audio/flac", "audio/x-flac", "audio/webm"],
};

/** XMLHttpRequest の偽物。send されたら script を呼ぶ（進み具合・応答はテストが決める）。 */
class FakeXhr implements XhrLike {
  static created: FakeXhr[] = [];
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: Blob | null = null;
  status = 0;
  withCredentials = true;
  aborted = false;
  upload: XhrLike["upload"] = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  constructor(private readonly script: (xhr: FakeXhr) => void) {
    FakeXhr.created.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: Blob) {
    this.body = body;
    this.script(this);
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

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 同じ origin の API の偽物。経路ごとに応答を返し、呼ばれた順を残す。 */
function api(routes: { limits?: () => Response | Promise<Response>; start?: () => Response | Promise<Response>; complete?: () => Response | Promise<Response> } = {}) {
  const calls: { path: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (resource: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(resource);
    calls.push({ path, init });
    if (path === "/api/recordings/audio/limits") return routes.limits ? routes.limits() : json(200, FULL_LIMITS);
    if (path === "/api/recordings/audio/start") return routes.start ? routes.start() : json(201, { page: PAGE, recording: RECORDING, upload: TICKET });
    if (path === `/api/pages/${ID}/recording/audio/complete`) {
      return routes.complete ? routes.complete() : json(200, { recording: { ...RECORDING, audio: { ...RECORDING.audio, status: "uploaded" } } });
    }
    throw new Error(`unexpected ${path}`);
  });
  return { fetchMock: fetchMock as unknown as typeof fetch, calls, paths: () => calls.map((call) => call.path) };
}

const audioFile = (bytes = new Uint8Array([1, 2, 3]), name = "合成の会議.m4a", type = "audio/mp4") => new File([bytes], name, { type });
const okXhr = () => new FakeXhr((xhr) => {
  xhr.progress(1, 3);
  xhr.progress(3, 3);
  xhr.respond(200);
});

beforeEach(() => {
  resetAudioLimitsCache();
  FakeXhr.created = [];
});

describe("putAudioWithProgress", () => {
  it("PUTs with the ticket's headers and no credentials, reports progress, and treats 2xx and 412 as done", async () => {
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" });
    const progress: number[] = [];
    await putAudioWithProgress(TICKET, file, { createXhr: okXhr, onProgress: (fraction) => progress.push(fraction) });
    const [xhr] = FakeXhr.created;
    expect(xhr).toMatchObject({ method: "PUT", url: TICKET.url, headers: { "Content-Type": "audio/mp4" }, withCredentials: false, body: file });
    expect(progress).toEqual([1 / 3, 1, 1]);
    await expect(putAudioWithProgress(TICKET, file, { createXhr: () => new FakeXhr((x) => x.respond(412)) })).resolves.toBeUndefined();
    await expect(putAudioWithProgress(TICKET, file, { createXhr: () => new FakeXhr((x) => x.respond(201)) })).resolves.toBeUndefined();
  });

  it("refuses other answers, a network or CORS failure and a timeout, without the url in the error", async () => {
    const file = new Blob([new Uint8Array([1])]);
    const forbidden = await putAudioWithProgress(TICKET, file, { createXhr: () => new FakeXhr((x) => x.respond(403)) }).catch((caught: unknown) => caught);
    expect(forbidden).toMatchObject({ status: 403, error: null });
    const network = await putAudioWithProgress(TICKET, file, { createXhr: () => new FakeXhr((x) => x.onerror?.()) }).catch((caught: unknown) => caught);
    expect(network).toMatchObject({ status: 0, error: "network" });
    const timeout = await putAudioWithProgress(TICKET, file, { createXhr: () => new FakeXhr((x) => x.ontimeout?.()) }).catch((caught: unknown) => caught);
    expect(timeout).toMatchObject({ status: 0, error: "timeout" });
    for (const error of [forbidden, network, timeout]) expect(String(error)).not.toContain("storage.example.test");
  });

  it("aborts the request when the signal fires, and does not start when already aborted", async () => {
    const file = new Blob([new Uint8Array([1])]);
    const controller = new AbortController();
    const pending = putAudioWithProgress(TICKET, file, { signal: controller.signal, createXhr: () => new FakeXhr((x) => x.progress(0, 1)) });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeXhr.created[0]!.aborted).toBe(true);
    const created = FakeXhr.created.length;
    await expect(putAudioWithProgress(TICKET, file, { signal: controller.signal, createXhr: okXhr })).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeXhr.created).toHaveLength(created);
  });
});

describe("checkAudioFile（送る前の検査。server と同じ順）", () => {
  const check = (input: Partial<{ name: string; size: number; type: string; durationSec: number | null }>, limits = FULL_LIMITS) =>
    checkAudioFile({ name: "合成.m4a", size: 10, type: "audio/mp4", ...input }, limits);

  it("accepts each extension, declares a matching content type, and strips parameters", () => {
    expect(check({})).toEqual({ ok: true, extension: "m4a", contentType: "audio/mp4", durationSec: undefined });
    expect(check({ name: "録音 2030-01-01 09-05.webm", type: "audio/webm;codecs=opus" })).toMatchObject({ ok: true, contentType: "audio/webm" });
    // 種類が空・違うときは拡張子の代表の種類
    expect(check({ name: "合成.flac", type: "" })).toMatchObject({ ok: true, contentType: "audio/flac" });
    expect(check({ name: "合成.M4A", type: "video/mp4" })).toMatchObject({ ok: true, extension: "m4a", contentType: "audio/mp4" });
    expect(check({ name: "合成.wav", type: "audio/x-wav" })).toMatchObject({ ok: true, contentType: "audio/x-wav" });
  });

  it("refuses VTT, unknown and unlisted formats, bad names, empty and too large files, and too long recordings", () => {
    for (const name of ["合成.vtt", "合成.mp4", "合成", "合成.m4a.exe", ".m4a"]) expect(check({ name }), name).toEqual({ ok: false, kind: "format" });
    expect(check({ name: "合成.webm" }, { ...FULL_LIMITS, extensions: ["m4a"] })).toEqual({ ok: false, kind: "format" });
    for (const name of ["", "  ", "a/b.m4a", "a\u0000.m4a", `${"あ".repeat(197)}.m4a`]) expect(check({ name }), JSON.stringify(name)).toEqual({ ok: false, kind: "name" });
    expect(check({ size: 0 })).toEqual({ ok: false, kind: "empty" });
    expect(check({ size: FULL_LIMITS.maxBytes })).toMatchObject({ ok: true });
    expect(check({ size: FULL_LIMITS.maxBytes + 1 })).toEqual({ ok: false, kind: "too_large" });
    expect(check({ durationSec: 21600 })).toMatchObject({ ok: true, durationSec: 21600 });
    expect(check({ durationSec: 21600.5 })).toEqual({ ok: false, kind: "too_long" });
    // 分からない長さ（Infinity・NaN・0）は送らない
    for (const durationSec of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1, null]) expect(check({ durationSec }), String(durationSec)).toMatchObject({ ok: true, durationSec: undefined });
  });
});

describe("uploadAudioFile", () => {
  it("checks the limits, hashes, starts with an Idempotency-Key, PUTs with progress, completes, and returns the page", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { fetchMock, calls, paths } = api();
    const progress: AudioUploadProgress[] = [];
    const result = await uploadAudioFile({ file: audioFile(bytes), lang: "ja", durationSec: 1.5, fetch: fetchMock, createXhr: okXhr, onProgress: (item) => progress.push(item) });
    expect(result.page).toEqual(PAGE);
    expect(result.recording.audio?.status).toBe("uploaded");
    expect(paths()).toEqual(["/api/recordings/audio/limits", "/api/recordings/audio/start", `/api/pages/${ID}/recording/audio/complete`]);
    const start = calls[1]!;
    const key = (start.init.headers as Record<string, string>)["idempotency-key"];
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(JSON.parse(start.init.body as string)).toEqual({
      name: "合成の会議.m4a",
      contentType: "audio/mp4",
      sizeBytes: 3,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      lang: "ja",
      durationSec: 1.5,
    });
    expect(FakeXhr.created).toHaveLength(1);
    const stages = progress.map((item) => item.stage);
    expect([...new Set(stages)]).toEqual(["hashing", "starting", "uploading", "completing"]);
    expect(progress.filter((item) => item.stage === "uploading").map((item) => item.fraction)).toEqual([0, 1 / 3, 1, 1]);
    expect(progress.filter((item) => item.stage === "hashing").at(-1)!.fraction).toBe(1);
  });

  it("skips the PUT when the start answers that it is already uploaded (upload: null), and uses the given key", async () => {
    const replay = { page: PAGE, recording: { ...RECORDING, audio: { ...RECORDING.audio, status: "uploaded" } }, upload: null };
    const { fetchMock, calls, paths } = api({ start: () => json(200, replay) });
    await uploadAudioFile({ file: audioFile(), idempotencyKey: KEY, fetch: fetchMock, createXhr: okXhr });
    expect(FakeXhr.created).toHaveLength(0);
    expect(paths()).toEqual(["/api/recordings/audio/limits", "/api/recordings/audio/start", `/api/pages/${ID}/recording/audio/complete`]);
    expect((calls[1]!.init.headers as Record<string, string>)["idempotency-key"]).toBe(KEY);
  });

  it("refuses before sending anything (no hashing, no start) when the file breaks the limits", async () => {
    const small = { ...FULL_LIMITS, maxBytes: 2, maxDurationSec: 60 };
    for (const [file, durationSec, kind] of [
      [audioFile(new Uint8Array([1, 2, 3])), undefined, "too_large"],
      [audioFile(new Uint8Array([1]), "合成.vtt", "text/vtt"), undefined, "format"],
      [audioFile(new Uint8Array([1]), "合成.txt", "text/plain"), undefined, "format"],
      [audioFile(new Uint8Array(0)), undefined, "empty"],
      [audioFile(new Uint8Array([1])), 61, "too_long"],
    ] as const) {
      resetAudioLimitsCache();
      const { fetchMock, paths } = api({ limits: () => json(200, small) });
      const slice = vi.spyOn(file, "slice");
      const error = await uploadAudioFile({ file, durationSec, fetch: fetchMock, createXhr: okXhr }).catch((caught: unknown) => caught);
      expect(error, kind).toBeInstanceOf(AudioUploadFailure);
      expect((error as AudioUploadFailure).kind).toBe(kind);
      expect(paths()).toEqual(["/api/recordings/audio/limits"]);
      expect(slice).not.toHaveBeenCalled();
    }
    expect(FakeXhr.created).toHaveLength(0);
  });

  it("asks for the limits once while the page is open", async () => {
    const { fetchMock, paths } = api();
    await uploadAudioFile({ file: audioFile(), fetch: fetchMock, createXhr: okXhr });
    await uploadAudioFile({ file: audioFile(), fetch: fetchMock, createXhr: okXhr });
    expect(paths().filter((path) => path.endsWith("/limits"))).toHaveLength(1);
  });

  it("does not hash the same file again when it is taken in again", async () => {
    const file = audioFile(new Uint8Array(100));
    const slice = vi.spyOn(file, "slice");
    const { fetchMock } = api({ complete: () => json(409, { error: "incomplete", reason: "missing" }) });
    await expect(uploadAudioFile({ file, idempotencyKey: KEY, fetch: fetchMock, createXhr: okXhr })).rejects.toMatchObject({ kind: "incomplete" });
    const reads = slice.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    await expect(uploadAudioFile({ file, idempotencyKey: KEY, fetch: fetchMock, createXhr: okXhr })).rejects.toMatchObject({ kind: "incomplete" });
    expect(slice.mock.calls.length).toBe(reads);
  });

  it("names each failure: storage off, sign-in, server refusals, the PUT, an unfinished upload, no connection", async () => {
    const cases: [Parameters<typeof api>[0], (() => FakeXhr) | null, AudioUploadFailureKind][] = [
      [{ start: () => json(503, { error: "storage_unavailable" }) }, null, "unavailable"],
      [{ start: () => json(502, { error: "storage_failed" }) }, null, "unavailable"],
      [{ start: () => json(401, { error: "unauthorized" }) }, null, "unauthorized"],
      [{ limits: () => json(401, { error: "unauthorized" }) }, null, "unauthorized"],
      [{ start: () => json(400, { error: "bad_request", reason: "too_large" }) }, null, "too_large"],
      [{ start: () => json(400, { error: "bad_request", reason: "extension" }) }, null, "format"],
      [{ start: () => json(400, { error: "bad_request", reason: "too_long" }) }, null, "too_long"],
      [{ start: () => json(400, { error: "bad_request", reason: "name" }) }, null, "name"],
      [{ start: () => json(409, { error: "idempotency_conflict" }) }, null, "other"],
      [{ start: () => json(403, { error: "forbidden" }) }, null, "other"],
      [{}, () => new FakeXhr((x) => x.onerror?.()), "network"],
      [{}, () => new FakeXhr((x) => x.respond(403)), "network"],
      [{ complete: () => json(409, { error: "incomplete", reason: "size_mismatch" }) }, null, "incomplete"],
      [{ start: () => Promise.reject(new TypeError("offline")) }, null, "connection"],
      [{ limits: () => Promise.reject(new TypeError("offline")) }, null, "connection"],
      [{ start: () => json(201, { page: PAGE }) }, null, "other"],
    ];
    for (const [routes, xhr, kind] of cases) {
      resetAudioLimitsCache();
      const { fetchMock } = api(routes);
      const error = await uploadAudioFile({ file: audioFile(), fetch: fetchMock, createXhr: xhr ?? okXhr }).catch((caught: unknown) => caught);
      expect(error, `${kind} ${JSON.stringify(Object.keys(routes ?? {}))}`).toBeInstanceOf(AudioUploadFailure);
      expect((error as AudioUploadFailure).kind, kind).toBe(kind);
      expect(String(error)).not.toContain("storage.example.test");
    }
  });

  it("stops when aborted while hashing, starting, or uploading", async () => {
    const before = new AbortController();
    before.abort();
    const { fetchMock: first, paths } = api();
    await expect(uploadAudioFile({ file: audioFile(), signal: before.signal, fetch: first })).rejects.toMatchObject({ kind: "aborted" });
    expect(paths()).toEqual([]);

    const whileHashing = new AbortController();
    const { fetchMock: second, paths: secondPaths } = api();
    await expect(
      uploadAudioFile({ file: audioFile(), signal: whileHashing.signal, fetch: second, onProgress: (item) => item.stage === "hashing" && whileHashing.abort() }),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(secondPaths()).toEqual(["/api/recordings/audio/limits"]);

    // 開始の要求に中止の signal が渡る（fetch が AbortError で終わる）
    const whileStarting = new AbortController();
    const { fetchMock: third, calls } = api({
      start: () => {
        whileStarting.abort();
        return Promise.reject(new DOMException("aborted", "AbortError"));
      },
    });
    await expect(uploadAudioFile({ file: audioFile(), signal: whileStarting.signal, fetch: third })).rejects.toMatchObject({ kind: "aborted" });
    expect(calls.find((call) => call.path === "/api/recordings/audio/start")!.init.signal).toBe(whileStarting.signal);

    const whileUploading = new AbortController();
    const { fetchMock: fourth, paths: fourthPaths } = api();
    const pending = uploadAudioFile({
      file: audioFile(),
      signal: whileUploading.signal,
      fetch: fourth,
      createXhr: () => new FakeXhr((x) => x.progress(1, 3)),
      onProgress: (item) => item.stage === "uploading" && item.fraction > 0 && whileUploading.abort(),
    });
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
    expect(FakeXhr.created.at(-1)!.aborted).toBe(true);
    expect(fourthPaths()).not.toContain(`/api/pages/${ID}/recording/audio/complete`);
  });

  it("turns every failure into a short Japanese message without URLs or internals", () => {
    const kinds: AudioUploadFailureKind[] = ["format", "too_large", "too_long", "empty", "name", "unreadable", "network", "connection", "unavailable", "incomplete", "unauthorized", "aborted", "other"];
    const messages = kinds.map((kind) => audioUploadMessage(kind, FULL_LIMITS));
    expect(new Set(messages).size).toBe(kinds.length);
    for (const message of [...messages, ...kinds.map((kind) => audioUploadMessage(kind))]) {
      expect(message).toMatch(/[ぁ-んァ-ン]/);
      expect(message).not.toMatch(/https?:|storage|token|session|\{|\d{3}/i);
    }
    expect(audioUploadMessage("too_large", FULL_LIMITS)).toBe("ファイルが大きすぎます。音声は 2 GiB までです。");
    expect(audioUploadMessage("too_long", FULL_LIMITS)).toBe("録音が長すぎます。6 時間までです。");
    expect(audioUploadMessage("format", FULL_LIMITS)).toContain(".m4a .mp3 .wav .aac .ogg .flac .webm");
  });
});
