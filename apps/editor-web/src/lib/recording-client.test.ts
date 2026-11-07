import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFLICT_MESSAGE, RecordingRequestError, getRecording, importVtt, recordingErrorMessage } from "./recording-client";

const ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";

function recording(revision: number, overrides: Record<string, unknown> = {}) {
  return {
    revision,
    source: "vtt",
    language: "ja",
    engine: "vtt-import",
    durationSec: 62.5,
    sourceName: "dinner.vtt",
    sourceSha256: "a".repeat(64),
    audio: null,
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    ...overrides,
  };
}
const snapshot = (revision: number) => ({ recording: recording(revision) });
const TAB = "11111111-1111-4111-8111-111111111111";
/** 文字起こしのタブの 1 行（#310。GET の `transcripts`）。 */
const transcriptTab = (overrides: Record<string, unknown> = {}) => ({
  id: TAB, label: "Deepgram", engine: "deepgram", engineLabel: "Deepgram", language: "ja", durationSec: 9, segmentCount: 12, revision: 2,
  updatedAt: "2026-10-30T00:00:00.000Z", ...overrides,
});

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const lastInit = (fetchMock: ReturnType<typeof mockFetch>) => fetchMock.mock.calls.at(-1)![1]!;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recording client: requests", () => {
  it("importVtt posts name and vtt (and lang when given) and returns the page, the transcript tab and the recording", async () => {
    const fetchMock = mockFetch(201, { page: { id: ID, kind: "rec", title: "dinner", lang: "ja", createdAt: "x", updatedAt: "x" }, transcript: TAB, ...snapshot(1) });
    const imported = await importVtt({ name: "dinner.vtt", vtt: "WEBVTT\n" });
    expect(imported.page).toEqual({ id: ID, title: "dinner", lang: "ja" });
    expect(imported.transcript).toBe(TAB);
    expect(imported.recording.revision).toBe(1);
    expect(imported.recording).not.toHaveProperty("segments");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/recordings/import-vtt");
    expect(lastInit(fetchMock)).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(lastInit(fetchMock).body as string)).toEqual({ name: "dinner.vtt", vtt: "WEBVTT\n" });
    await importVtt({ name: "a.vtt", vtt: "x", lang: "en" });
    expect(JSON.parse(lastInit(fetchMock).body as string)).toEqual({ name: "a.vtt", vtt: "x", lang: "en" });
  });

  it("getRecording reads the recording of the page (id encoded into the path)", async () => {
    const fetchMock = mockFetch(200, snapshot(3));
    const loaded = await getRecording(ID);
    expect(loaded.recording.revision).toBe(3);
    expect(loaded.recording.durationSec).toBe(62.5);
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/pages/${ID}/recording`);
    expect(lastInit(fetchMock)).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
    expect(lastInit(fetchMock).body).toBeUndefined();
    await getRecording("../x?y");
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/pages/..%2Fx%3Fy/recording");
  });

  it("reads the transcript tabs of the recording (#310) and drops rows in the wrong shape", async () => {
    const second = transcriptTab({ id: "22222222-2222-4222-8222-222222222222", label: "Gemini", engine: "gemini", engineLabel: "Gemini", segmentCount: 0, durationSec: null });
    mockFetch(200, { ...snapshot(3), transcripts: [transcriptTab(), { id: "not-a-uuid", label: "x" }, second], engines: ["deepgram", "gemini"], defaultEngine: "deepgram" });

    const loaded = await getRecording(ID);

    expect(loaded.transcripts?.map((item) => [item.id, item.label, item.segmentCount])).toEqual([[TAB, "Deepgram", 12], [second.id, "Gemini", 0]]);
    expect(loaded.engines).toEqual(["deepgram", "gemini"]);
    expect(loaded.defaultEngine).toBe("deepgram");
    mockFetch(200, snapshot(3));
    expect((await getRecording(ID)).transcripts).toBeUndefined();
  });
});

describe("recording client: failures", () => {
  it("a 409 becomes a plain failure carrying the short reason (a transcription that cannot start)", async () => {
    mockFetch(409, { error: "existing" });
    const error = await getRecording(ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RecordingRequestError);
    expect(error).toMatchObject({ status: 409, reason: "existing" });
    mockFetch(409, { reason: "tab_missing", error: "conflict" });
    expect(await getRecording(ID).catch((caught: unknown) => caught)).toMatchObject({ status: 409, reason: "tab_missing" });
    mockFetch(409, {});
    expect(await getRecording(ID).catch((caught: unknown) => caught)).toMatchObject({ status: 409, reason: null });
  });

  it("keeps the status and the 400 reason", async () => {
    mockFetch(400, { error: "bad_request", reason: "vtt_invalid" });
    const error = (await importVtt({ name: "a.vtt", vtt: "x" }).catch((caught: unknown) => caught)) as RecordingRequestError;
    expect(error).toMatchObject({ status: 400, reason: "vtt_invalid" });
    mockFetch(404, { error: "not_found" });
    expect(await getRecording(ID).catch((caught: unknown) => caught)).toMatchObject({ status: 404, reason: null });
    mockFetch(413, {});
    expect(await importVtt({ name: "a.vtt", vtt: "x" }).catch((caught: unknown) => caught)).toMatchObject({ status: 413 });
  });

  it("a network failure or a timeout is status 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect(await getRecording(ID).catch((caught: unknown) => caught)).toMatchObject({ status: 0 });
  });

  it("a response in the wrong shape is a server failure, not data", async () => {
    mockFetch(200, { recording: { revision: 0 } });
    expect(await getRecording(ID).catch((caught: unknown) => caught)).toMatchObject({ status: 500 });
    mockFetch(200, { page: { id: "not-a-uuid", title: "x", lang: "ja" }, transcript: TAB, ...snapshot(1) });
    expect(await importVtt({ name: "a.vtt", vtt: "x" }).catch((caught: unknown) => caught)).toMatchObject({ status: 500 });
    mockFetch(200, { page: { id: ID, title: "x", lang: "ja" }, ...snapshot(1) });
    expect(await importVtt({ name: "a.vtt", vtt: "x" }).catch((caught: unknown) => caught)).toMatchObject({ status: 500 });
    mockFetch(200, { recording: recording(1, { durationSec: "long" }) });
    expect(await getRecording(ID).catch((caught: unknown) => caught)).toMatchObject({ status: 500 });
    mockFetch(200, { recording: recording(1, { source: "mic" }) });
    expect(await getRecording(ID).catch((caught: unknown) => caught)).toMatchObject({ status: 500 });
  });
});

describe("recordingErrorMessage", () => {
  const failure = (status: number, reason: string | null = null) => new RecordingRequestError(status, reason);

  it("maps every server reason to a short Japanese sentence", () => {
    const reasons = ["body", "lang", "vtt_empty", "vtt_too_large", "vtt_invalid", "index", "text", "speaker", "merge"];
    for (const reason of reasons) {
      const message = recordingErrorMessage(failure(400, reason), "edit");
      expect(message, reason).toMatch(/[ぁ-んァ-ン]/);
      expect(message, reason).not.toContain("サーバーで問題");
    }
    expect(new Set(reasons.map((reason) => recordingErrorMessage(failure(400, reason), "edit"))).size).toBe(reasons.length);
  });

  it("the reason name means the file name when importing and the speaker name when renaming", () => {
    expect(recordingErrorMessage(failure(400, "name"), "import")).toContain("ファイル名");
    const rename = recordingErrorMessage(failure(400, "name"), "rename");
    expect(rename).toContain("60 字");
    expect(rename).toContain("話者1");
  });

  it("maps the statuses", () => {
    expect(recordingErrorMessage(failure(409), "edit")).toBe(CONFLICT_MESSAGE);
    expect(recordingErrorMessage(failure(0), "edit")).toContain("つながりませんでした");
    expect(recordingErrorMessage(failure(401), "edit")).toContain("ログイン");
    expect(recordingErrorMessage(failure(403), "edit")).toContain("開き直して");
    expect(recordingErrorMessage(failure(404), "load")).toBe("このページには文字起こしがありません。");
    expect(recordingErrorMessage(failure(404), "edit")).toContain("見つかりません");
    expect(recordingErrorMessage(failure(413), "import")).toContain("4 MiB");
    expect(recordingErrorMessage(failure(503), "load")).toContain("サーバーが使えません");
    expect(recordingErrorMessage(failure(500), "load")).toContain("サーバーで問題");
    expect(recordingErrorMessage(failure(400, "unknown_reason"), "edit")).toContain("サーバーで問題");
    expect(recordingErrorMessage(new Error("x"), "edit")).toContain("もう一度試してください");
  });

  it("never echoes the server's own text", () => {
    expect(recordingErrorMessage(failure(400, "<script>alert(1)</script>"), "edit")).not.toContain("script");
  });
});
