import { describe, expect, it, vi } from "vitest";
import { TranscriptionRequestError, getTranscription, isTranscriptionDone, startTranscription, type TranscriptionRun } from "./transcription-client";

const PAGE = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const RUN: TranscriptionRun = {
  id: "0b6f7d8e-1c2a-4b3c-8d4e-5f6a7b8c9d0e",
  status: "queued",
  engine: "fake",
  language: "ja",
  errorCode: null,
  createdAt: "2030-01-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  tab: null,
};
const TAB = "7a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";

function fakeFetch(response: Response) {
  const fn = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => response);
  return { fetch: fn as unknown as typeof fetch, fn };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("startTranscription", () => {
  it("POSTs only the given options as JSON to the same origin and returns the run and the tab", async () => {
    const { fetch, fn } = fakeFetch(json(202, { run: { ...RUN, tab: TAB }, tab: TAB }));
    const result = await startTranscription(PAGE, { tab: TAB, terms: ["合成語"] }, fetch);
    expect(result).toEqual({ status: 202, run: { ...RUN, tab: TAB }, tab: TAB });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe(`/api/pages/${PAGE}/recording/transcribe`);
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.cache).toBe("no-store");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ tab: TAB, terms: ["合成語"] });

    const existing = fakeFetch(json(200, { run: { ...RUN, status: "running", startedAt: "2030-01-01T00:00:01.000Z" }, tab: null }));
    const again = await startTranscription(PAGE, {}, existing.fetch);
    expect([again.status, again.tab]).toEqual([200, null]);
    expect(JSON.parse(String(existing.fn.mock.calls[0]![1]?.body))).toEqual({});
    const escaped = fakeFetch(json(202, { run: RUN }));
    await startTranscription("a/../b", {}, escaped.fetch);
    expect(escaped.fn.mock.calls[0]![0]).toBe("/api/pages/a%2F..%2Fb/recording/transcribe");
  });

  it("throws the server's code and reason, and a 500 for a body it cannot read", async () => {
    const conflict = startTranscription(PAGE, {}, fakeFetch(json(409, { error: "cannot_start", reason: "tab_missing" })).fetch);
    await expect(conflict).rejects.toMatchObject({ name: "TranscriptionRequestError", status: 409, error: "cannot_start", reason: "tab_missing" });
    await expect(startTranscription(PAGE, {}, fakeFetch(json(503, { error: "transcription_unavailable" })).fetch)).rejects.toMatchObject({
      status: 503,
      error: "transcription_unavailable",
      reason: null,
    });
    await expect(startTranscription(PAGE, {}, fakeFetch(new Response("oops", { status: 502 })).fetch)).rejects.toMatchObject({ status: 502, error: null });
    for (const body of [{}, { run: { ...RUN, status: "paused" } }, { run: { ...RUN, language: "fr" } }, { run: null }]) {
      await expect(startTranscription(PAGE, {}, fakeFetch(json(202, body)).fetch)).rejects.toBeInstanceOf(TranscriptionRequestError);
    }
  });
});

describe("getTranscription", () => {
  it("returns the latest run or null, and throws the server's code", async () => {
    const { fetch, fn } = fakeFetch(json(200, { run: { ...RUN, status: "failed", errorCode: "engine_unavailable", finishedAt: "2030-01-01T00:00:02.000Z" } }));
    const run = await getTranscription(PAGE, fetch);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("engine_unavailable");
    expect(fn.mock.calls[0]![0]).toBe(`/api/pages/${PAGE}/recording/transcription`);
    expect(fn.mock.calls[0]![1]).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
    expect(await getTranscription(PAGE, fakeFetch(json(200, { run: null })).fetch)).toBeNull();
    await expect(getTranscription(PAGE, fakeFetch(json(404, { error: "not_found" })).fetch)).rejects.toMatchObject({ status: 404, error: "not_found" });
    await expect(getTranscription(PAGE, fakeFetch(json(200, {})).fetch)).rejects.toMatchObject({ status: 500 });
    await expect(getTranscription(PAGE, fakeFetch(json(200, { run: { id: 1 } })).fetch)).rejects.toMatchObject({ status: 500 });
  });

  it("tells whether a run has finished", () => {
    expect(isTranscriptionDone(null)).toBe(false);
    expect(isTranscriptionDone(RUN)).toBe(false);
    expect(isTranscriptionDone({ ...RUN, status: "running" })).toBe(false);
    expect(isTranscriptionDone({ ...RUN, status: "succeeded" })).toBe(true);
    expect(isTranscriptionDone({ ...RUN, status: "failed" })).toBe(true);
  });
});
