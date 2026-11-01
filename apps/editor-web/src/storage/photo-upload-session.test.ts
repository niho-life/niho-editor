import { describe, expect, it, vi } from "vitest";
import { PhotoStorageError } from "./photo-types";
import { createGcsPhotoUploadSessionDriver } from "./photo-upload-session";
import type { PhotoUploadSessionIdentity } from "./photo-session-identity";

const BUCKET = "synthetic-docs-bucket";
const UPLOAD_ID = "44444444-4444-4444-8444-444444444444";
const IDENTITY: PhotoUploadSessionIdentity = {
  ownerId: "synthetic-owner",
  uploadId: UPLOAD_ID,
  stageKey: `photo/stage/${UPLOAD_ID}`,
  sizeBytes: 600_000,
  contentType: "image/jpeg",
  libraryId: "55555555-5555-4555-8555-555555555555",
  libraryLifecycleEpoch: 2,
  uploadLeaseGeneration: 3,
};
const SESSION = `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?upload_id=synthetic-private-session`;
const signal = () => new AbortController().signal;
const metadata = (overrides: Record<string, unknown> = {}, status = 200) => new Response(JSON.stringify({
  name: IDENTITY.stageKey,
  bucket: BUCKET,
  size: String(IDENTITY.sizeBytes),
  contentType: IDENTITY.contentType,
  generation: "123456789",
  ...overrides,
}), { status, headers: { "Content-Type": "application/json" } });

function sequence(responses: Array<Response | Error | Promise<Response>>, timeoutMs = 30_000) {
  const fetcher = vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected synthetic fetch");
    if (next instanceof Error) throw next;
    return next;
  });
  return {
    fetcher,
    driver: createGcsPhotoUploadSessionDriver({ bucket: BUCKET, fetch: fetcher, timeoutMs }),
  };
}

function expectGeneric(error: unknown, code: "unavailable" | "conflict") {
  expect(error).toBeInstanceOf(PhotoStorageError);
  expect(error).toMatchObject({ code, message: `photo storage: ${code}` });
  expect(String(error)).not.toMatch(/synthetic-private-session|provider-secret|foreign\.invalid/i);
}

describe("GCS private resumable upload session driver", () => {
  it("reports empty, partially acknowledged, and completed authoritative progress", async () => {
    const f = sequence([
      new Response(null, { status: 308 }),
      new Response(null, { status: 308, headers: { Range: "bytes=0-262143" } }),
      metadata(),
    ]);
    expect(await f.driver.progress(SESSION, IDENTITY, signal())).toBe(0);
    expect(await f.driver.progress(SESSION, IDENTITY, signal())).toBe(262_144);
    expect(await f.driver.progress(SESSION, IDENTITY, signal())).toBe(IDENTITY.sizeBytes);
    for (const [, init] of f.fetcher.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(init).toMatchObject({ method: "PUT", cache: "no-store", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
      expect(headers.get("Content-Length")).toBe("0");
      expect(headers.get("Content-Range")).toBe(`bytes */${IDENTITY.sizeBytes}`);
      expect(headers.has("Authorization")).toBe(false);
      expect(headers.has("Cookie")).toBe(false);
    }
  });

  it("allows only the exact configured GCS session URL before fetch", async () => {
    const f = sequence([]);
    const invalid = [
      SESSION.replace("https:", "http:"),
      SESSION.replace("storage.googleapis.com", "foreign.invalid"),
      SESSION.replace("storage.googleapis.com", "user:pass@storage.googleapis.com"),
      SESSION.replace(BUCKET, "foreign-bucket"),
      SESSION.replace("/upload/storage/v1", "/storage/v1"),
      `${SESSION}#fragment`,
      SESSION.replace("upload_id=", "unknown=x&upload_id="),
      `${SESSION}&upload_id=duplicate`,
      SESSION.replace("synthetic-private-session", ""),
      `${SESSION}&uploadType=media`,
      `${SESSION}&name=photo%2Fstage%2F00000000-0000-0000-0000-000000000000`,
      `${SESSION}&ifGenerationMatch=1`,
    ];
    for (const url of invalid) await expect(f.driver.progress(url, IDENTITY, signal())).rejects.toMatchObject({ code: "unavailable" });
    expect(f.fetcher).not.toHaveBeenCalled();

    const allowed = sequence([new Response(null, { status: 308 }), new Response(null, { status: 308 })]);
    await expect(allowed.driver.progress(`${SESSION}&uploadType=resumable&name=${encodeURIComponent(IDENTITY.stageKey)}&ifGenerationMatch=0`, IDENTITY, signal())).resolves.toBe(0);
    await expect(allowed.driver.progress(SESSION, IDENTITY, signal())).resolves.toBe(0);
  });

  it("rejects non-canonical or out-of-bounds private identity before fetch", async () => {
    const f = sequence([]);
    for (const identity of [
      { ...IDENTITY, ownerId: "bad\nowner" },
      { ...IDENTITY, uploadId: IDENTITY.uploadId.toUpperCase(), stageKey: IDENTITY.stageKey.toUpperCase() },
      { ...IDENTITY, stageKey: `${IDENTITY.stageKey}/extra` },
      { ...IDENTITY, sizeBytes: 256 * 1_024 ** 2 + 1 },
      { ...IDENTITY, contentType: "text/plain" },
      { ...IDENTITY, libraryId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
      { ...IDENTITY, libraryLifecycleEpoch: -1 },
      { ...IDENTITY, uploadLeaseGeneration: Number.MAX_SAFE_INTEGER + 1 },
    ]) await expect(f.driver.progress(SESSION, identity, signal())).rejects.toMatchObject({ code: "conflict" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("fails closed on malformed or out-of-bounds acknowledged ranges", async () => {
    for (const range of [
      "bytes=1-2",
      "bytes=0-01",
      "bytes=0-599999",
      "bytes=0-600000",
      "bytes=0-1, bytes=0-2",
      "bytes 0-2",
    ]) {
      const f = sequence([new Response(null, { status: 308, headers: { Range: range } })]);
      await expect(f.driver.progress(SESSION, IDENTITY, signal())).rejects.toMatchObject({ code: "unavailable" });
    }
  });

  it("requires exact bounded completion metadata", async () => {
    const cases = [
      metadata({ name: "photo/stage/00000000-0000-0000-0000-000000000000" }),
      metadata({ bucket: "foreign-bucket" }),
      metadata({ size: "0600000" }),
      metadata({ size: "599999" }),
      metadata({ contentType: "image/png" }),
      metadata({ generation: "0" }),
      metadata({ generation: "1".repeat(129) }),
      new Response("not-json"),
      new Response(JSON.stringify({ name: IDENTITY.stageKey })),
      new Response("x".repeat(32 * 1_024 + 1)),
    ];
    for (const response of cases) {
      const f = sequence([response]);
      await expect(f.driver.progress(SESSION, IDENTITY, signal())).rejects.toMatchObject({ code: "unavailable" });
    }
  });

  it("sends only identity-bound content headers and follows a partial provider ACK", async () => {
    const bytes = new Uint8Array(262_144).fill(7);
    const f = sequence([
      new Response(null, { status: 308 }),
      new Response(null, { status: 308, headers: { Range: "bytes=0-131071", "X-Provider-Secret": "provider-secret" } }),
    ]);
    expect(await f.driver.put(SESSION, IDENTITY, { start: 0, bytes }, signal())).toBe(131_072);
    const [, init] = f.fetcher.mock.calls[1]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("Content-Length")).toBe("262144");
    expect(headers.get("Content-Range")).toBe(`bytes 0-262143/${IDENTITY.sizeBytes}`);
    expect(headers.get("Content-Type")).toBe(IDENTITY.contentType);
    expect([...headers.keys()].sort()).toEqual(["content-length", "content-range", "content-type"]);
    expect(init?.body).toBeInstanceOf(Uint8Array);
  });

  it("rejects a stale or completed starting offset without sending the data PUT", async () => {
    const stale = sequence([new Response(null, { status: 308, headers: { Range: "bytes=0-262143" } })]);
    await expect(stale.driver.put(SESSION, IDENTITY, { start: 0, bytes: new Uint8Array(262_144) }, signal())).rejects.toMatchObject({ code: "conflict" });
    expect(stale.fetcher).toHaveBeenCalledOnce();

    const complete = sequence([metadata()]);
    await expect(complete.driver.put(SESSION, IDENTITY, { start: 0, bytes: new Uint8Array(262_144) }, signal())).rejects.toMatchObject({ code: "conflict" });
    expect(complete.fetcher).toHaveBeenCalledOnce();
  });

  it("enforces chunk size, bounds and non-final alignment while accepting a small final chunk", async () => {
    const noFetch = sequence([]);
    for (const chunk of [
      { start: 0, bytes: new Uint8Array() },
      { start: 0, bytes: new Uint8Array(1) },
      { start: IDENTITY.sizeBytes - 1, bytes: new Uint8Array(2) },
      { start: 0, bytes: new Uint8Array(4 * 1_024 * 1_024 + 1) },
      { start: Number.MAX_SAFE_INTEGER, bytes: new Uint8Array(1) },
    ]) await expect(noFetch.driver.put(SESSION, IDENTITY, chunk, signal())).rejects.toMatchObject({ code: "conflict" });
    expect(noFetch.fetcher).not.toHaveBeenCalled();

    const finalIdentity = { ...IDENTITY, sizeBytes: 3 };
    const final = sequence([new Response(null, { status: 308 }), metadata({ size: "3" }, 201)]);
    await expect(final.driver.put(SESSION, finalIdentity, { start: 0, bytes: new Uint8Array([1, 2, 3]) }, signal())).resolves.toBe(3);
  });

  it("rejects impossible post-write ACKs and completion on a non-final chunk", async () => {
    const behind = sequence([
      new Response(null, { status: 308, headers: { Range: "bytes=0-262143" } }),
      new Response(null, { status: 308 }),
    ]);
    await expect(behind.driver.put(SESSION, IDENTITY, { start: 262_144, bytes: new Uint8Array(262_144) }, signal())).rejects.toMatchObject({ code: "unavailable" });

    const earlyComplete = sequence([new Response(null, { status: 308 }), metadata()]);
    await expect(earlyComplete.driver.put(SESSION, IDENTITY, { start: 0, bytes: new Uint8Array(262_144) }, signal())).rejects.toMatchObject({ code: "unavailable" });
  });

  it("maps provider failures and redirects to a fixed generic error", async () => {
    for (const response of [
      new Response("provider-secret", { status: 404, headers: { "X-Provider-Secret": "provider-secret" } }),
      new Response(null, { status: 410 }),
      new Response(null, { status: 500 }),
      new Response(null, { status: 302, headers: { Location: "https://foreign.invalid/provider-secret" } }),
    ]) {
      const f = sequence([response]);
      try {
        await f.driver.progress(SESSION, IDENTITY, signal());
        throw new Error("expected failure");
      } catch (error) {
        expectGeneric(error, "unavailable");
      }
    }
  });

  it("does not fetch for pre-abort and hides fetch rejection details", async () => {
    const preAborted = sequence([]);
    await expect(preAborted.driver.progress(SESSION, IDENTITY, AbortSignal.abort("provider-secret"))).rejects.toMatchObject({ code: "unavailable" });
    expect(preAborted.fetcher).not.toHaveBeenCalled();

    const rejected = sequence([new Error("provider-secret synthetic-private-session")]);
    try {
      await rejected.driver.progress(SESSION, IDENTITY, signal());
    } catch (error) {
      expectGeneric(error, "unavailable");
    }
  });

  it("times out stalled fetch and metadata bodies even when they ignore abort", async () => {
    const stalledFetch = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    const fetchDriver = createGcsPhotoUploadSessionDriver({ bucket: BUCKET, fetch: stalledFetch, timeoutMs: 20 });
    await expect(fetchDriver.progress(SESSION, IDENTITY, signal())).rejects.toMatchObject({ code: "unavailable" });

    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => new Promise<void>(() => undefined),
    });
    const stalledBody = sequence([new Response(body, { status: 200 })], 20);
    await expect(stalledBody.driver.progress(SESSION, IDENTITY, signal())).rejects.toMatchObject({ code: "unavailable" });
  });

  it("observes a late fetch rejection after timeout", async () => {
    let rejectFetch: ((error: Error) => void) | undefined;
    const unhandled: unknown[] = [];
    const listener = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", listener);
    try {
      const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((_, reject) => { rejectFetch = reject; }));
      const driver = createGcsPhotoUploadSessionDriver({ bucket: BUCKET, fetch: fetcher, timeoutMs: 10 });
      await expect(driver.progress(SESSION, IDENTITY, signal())).rejects.toMatchObject({ code: "unavailable" });
      rejectFetch!(new Error("provider-secret late rejection"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});
