import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONFLICT_MESSAGE,
  RecordingCandidateConflictError,
  RecordingConflictError,
  RecordingRequestError,
  editSegments,
  getRecording,
  importVtt,
  mergeSpeakers,
  recordingErrorMessage,
  renameSpeaker,
  updateCandidate,
} from "./recording-client";

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
    segments: [
      { start: 0, end: 4.2, text: "最初の段落", speaker: 1 },
      { start: 4.2, end: 9, text: "次の段落", speaker: 2 },
    ],
    speakerNames: { "1": "Takuya" },
    audio: null,
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    ...overrides,
  };
}
const SPEAKERS = [
  { speaker: 1, name: "Takuya", count: 1 },
  { speaker: 2, name: null, count: 1 },
];
const snapshot = (revision: number) => ({ recording: recording(revision), speakers: SPEAKERS });
const candidate = (revision = 3) => ({
  id: "11111111-1111-4111-8111-111111111111", revision, name: "比較案", engine: "fake", engineLabel: "開発の偽物",
  language: "ja", durationSec: 9, adopted: false, state: "ready", busy: false, segmentCount: 1, preview: ["本文"],
  createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z",
  segments: [{ start: 0, end: 9, text: "本文", speaker: 1 }], speakerNames: { "1": "話し手" },
} as const);

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
  it("importVtt posts name and vtt (and lang when given) and returns the page with the recording", async () => {
    const fetchMock = mockFetch(201, { page: { id: ID, kind: "rec", title: "dinner", lang: "ja", createdAt: "x", updatedAt: "x" }, ...snapshot(1) });
    const imported = await importVtt({ name: "dinner.vtt", vtt: "WEBVTT\n" });
    expect(imported.page).toEqual({ id: ID, title: "dinner", lang: "ja" });
    expect(imported.recording.revision).toBe(1);
    expect(imported.speakers).toEqual(SPEAKERS);
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
    expect(loaded.recording.segments[0]).toEqual({ start: 0, end: 4.2, text: "最初の段落", speaker: 1 });
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/pages/${ID}/recording`);
    expect(lastInit(fetchMock)).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
    expect(lastInit(fetchMock).body).toBeUndefined();
    await getRecording("../x?y");
    expect(fetchMock.mock.calls.at(-1)![0]).toBe("/api/pages/..%2Fx%3Fy/recording");
  });

  it("editSegments / renameSpeaker / mergeSpeakers patch with baseRevision and exactly one operation", async () => {
    const fetchMock = mockFetch(200, snapshot(4));
    expect((await editSegments(ID, 3, [{ index: 1, text: "直した" }])).recording.revision).toBe(4);
    expect(lastInit(fetchMock).method).toBe("PATCH");
    expect(JSON.parse(lastInit(fetchMock).body as string)).toEqual({ baseRevision: 3, edits: [{ index: 1, text: "直した" }] });
    await renameSpeaker(ID, 4, 2, "Mika");
    expect(JSON.parse(lastInit(fetchMock).body as string)).toEqual({ baseRevision: 4, renameSpeaker: { speaker: 2, name: "Mika" } });
    await renameSpeaker(ID, 5, 2, null);
    expect(JSON.parse(lastInit(fetchMock).body as string)).toEqual({ baseRevision: 5, renameSpeaker: { speaker: 2, name: null } });
    await mergeSpeakers(ID, 6, 2, 1);
    expect(JSON.parse(lastInit(fetchMock).body as string)).toEqual({ baseRevision: 6, mergeSpeakers: { from: 2, into: 1 } });
    expect(fetchMock.mock.calls.at(-1)![0]).toBe(`/api/pages/${ID}/recording`);
  });

  it("candidate mutation retries a lost response once with the same operation ID", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidate: candidate(4), replayed: true }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const saved = await updateCandidate(ID, candidate().id, { expectedRevision: 3, name: "比較案" });
    expect(saved.revision).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    const second = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body));
    expect(first.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toEqual(first);
  });
});

describe("recording client: failures", () => {
  it("409 with the latest recording becomes a RecordingConflictError carrying the snapshot", async () => {
    mockFetch(409, { error: "conflict", ...snapshot(7) });
    const error = await editSegments(ID, 6, [{ index: 0, text: "x" }]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RecordingConflictError);
    expect(error).toBeInstanceOf(RecordingRequestError);
    expect((error as RecordingConflictError).status).toBe(409);
    expect((error as RecordingConflictError).snapshot.recording.revision).toBe(7);
    expect((error as RecordingConflictError).snapshot.speakers).toEqual(SPEAKERS);
  });

  it("candidate 409 carries the latest candidate without treating it as a recording conflict", async () => {
    mockFetch(409, { error: "conflict", candidate: candidate(5) });
    const error = await updateCandidate(ID, candidate().id, { expectedRevision: 3, name: "私の案" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RecordingCandidateConflictError);
    expect(error).not.toBeInstanceOf(RecordingConflictError);
    expect((error as RecordingCandidateConflictError).candidate.revision).toBe(5);
  });

  it("a 409 that is not in the conflict shape is a plain failure", async () => {
    mockFetch(409, { error: "something" });
    const error = await renameSpeaker(ID, 1, 1, "x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RecordingRequestError);
    expect(error).not.toBeInstanceOf(RecordingConflictError);
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
    mockFetch(200, { recording: { revision: 0, segments: [] }, speakers: [] });
    expect(await getRecording(ID).catch((caught: unknown) => caught)).toMatchObject({ status: 500 });
    mockFetch(200, { page: { id: "not-a-uuid", title: "x", lang: "ja" }, ...snapshot(1) });
    expect(await importVtt({ name: "a.vtt", vtt: "x" }).catch((caught: unknown) => caught)).toMatchObject({ status: 500 });
    mockFetch(200, { recording: recording(1, { segments: [{ start: 0, end: 1, text: 3, speaker: 1 }] }), speakers: SPEAKERS });
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
