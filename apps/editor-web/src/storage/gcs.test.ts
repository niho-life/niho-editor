import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GCS_SESSION_TTL_MS, METADATA_TOKEN_URL, createGcsStorage, createMetadataTokenProvider } from "./gcs";
import { StorageError } from "./types";

// 値は明らかなダミーだけ（実際の bucket・token・セッション URI ではない）
const BUCKET = "synthetic-test-bucket";
const TOKEN = "synthetic-access-token-0123456789";
const OBJECT = "audio/6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const SESSION = "https://storage.googleapis.com/upload/storage/v1/b/synthetic-test-bucket/o?uploadType=resumable&upload_id=synthetic-session-id";
const NOW = Date.parse("2030-01-01T00:00:00.000Z");

type Call = { url: string; init: RequestInit };

/** 呼ばれた要求を記録し、順に応答を返す fetch（応答が足りなければ失敗）。 */
function fakeFetch(...responses: Array<Response | Error | ((call: Call) => Response | Promise<Response>)>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(call) : next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const tokenResponse = (expiresIn = 3600) => new Response(JSON.stringify({ access_token: TOKEN, expires_in: expiresIn, token_type: "Bearer" }), { status: 200 });
const started = () => new Response(null, { status: 200, headers: { Location: SESSION } });
const objectResponse = (size = "4096", contentType = "audio/mp4", generation = "7") => new Response(JSON.stringify({ size, contentType, generation }), { status: 200 });

function headersOf(call: Call): Record<string, string> {
  return Object.fromEntries(Object.entries((call.init.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]));
}

/** エラーの見える部分（メッセージ・文字列・JSON・stack）に秘密や場所が入っていないこと。 */
function expectNoSecrets(error: unknown) {
  expect(error).toBeInstanceOf(StorageError);
  const visible = [String(error), (error as Error).message, JSON.stringify(error), (error as Error).stack ?? "", JSON.stringify(Object.entries(error as object))].join("\n");
  for (const secret of [TOKEN, BUCKET, OBJECT, "6f1d0d7c", SESSION, "synthetic-session-id", "googleapis"]) expect(visible).not.toContain(secret);
}

async function failureOf(promise: Promise<unknown>): Promise<StorageError> {
  try {
    await promise;
  } catch (error) {
    expectNoSecrets(error);
    return error as StorageError;
  }
  throw new Error("expected a failure");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GCS storage: starting a resumable upload", () => {
  it("POSTs to the resumable endpoint with ifGenerationMatch=0, the upload headers, the editor origin and only the bearer token, and returns the Location", async () => {
    const { fetch, calls } = fakeFetch(tokenResponse(), started());
    const storage = createGcsStorage({ bucket: BUCKET, fetch, now: () => NOW });
    expect(storage.kind).toBe("gcs");
    const ticket = await storage.startUpload({ objectPath: OBJECT, contentType: "audio/mp4", sizeBytes: 4096, origin: "https://editor.example.test" });

    expect(calls).toHaveLength(2);
    const [tokenCall, startCall] = calls as [Call, Call];
    expect(tokenCall.url).toBe(METADATA_TOKEN_URL);
    expect(tokenCall.url).toBe("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token");
    expect(tokenCall.init.method).toBe("GET");
    expect(headersOf(tokenCall)).toEqual({ "metadata-flavor": "Google" });

    const url = new URL(startCall.url);
    expect(`${url.origin}${url.pathname}`).toBe(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o`);
    expect([...url.searchParams.entries()]).toEqual([
      ["uploadType", "resumable"],
      ["name", OBJECT],
      ["ifGenerationMatch", "0"],
    ]);
    expect(startCall.url).toContain("name=audio%2F6f1d0d7c-");
    expect(startCall.init.method).toBe("POST");
    expect(startCall.init.redirect).toBe("error");
    expect(startCall.init.signal).toBeInstanceOf(AbortSignal);
    expect(startCall.init.body).toBeUndefined();
    expect(headersOf(startCall)).toEqual({
      authorization: `Bearer ${TOKEN}`,
      "x-upload-content-type": "audio/mp4",
      "x-upload-content-length": "4096",
      origin: "https://editor.example.test",
    });

    expect(ticket).toEqual({ url: SESSION, method: "PUT", headers: { "Content-Type": "audio/mp4" }, expiresAt: new Date(NOW + GCS_SESSION_TTL_MS).toISOString() });
  });

  it("omits the Origin header when the origin is unknown or not an origin", async () => {
    for (const origin of [null, "not a url", "https://editor.example.test/path", "javascript:alert(1)"]) {
      const { fetch, calls } = fakeFetch(started());
      const storage = createGcsStorage({ bucket: BUCKET, fetch, accessToken: async () => TOKEN });
      await storage.startUpload({ objectPath: OBJECT, contentType: "audio/mp4", sizeBytes: 1, origin });
      expect(headersOf(calls[0]!)).not.toHaveProperty("origin");
    }
  });

  it("maps failures: unreachable, 401, 403, 408, 429 and 5xx are unavailable; other 4xx are rejected", async () => {
    const cases: Array<[Response | Error, "unavailable" | "rejected"]> = [
      [new TypeError("fetch failed: connect ECONNREFUSED"), "unavailable"],
      [new Response("denied", { status: 401 }), "unavailable"],
      [new Response(`no access to ${BUCKET}`, { status: 403 }), "unavailable"],
      [new Response(null, { status: 408 }), "unavailable"],
      [new Response(null, { status: 429 }), "unavailable"],
      [new Response(null, { status: 500 }), "unavailable"],
      [new Response(null, { status: 503 }), "unavailable"],
      [new Response(`bad ${OBJECT}`, { status: 400 }), "rejected"],
      [new Response(null, { status: 404 }), "rejected"],
      [new Response(null, { status: 412 }), "rejected"],
    ];
    for (const [response, code] of cases) {
      const { fetch } = fakeFetch(response);
      const storage = createGcsStorage({ bucket: BUCKET, fetch, accessToken: async () => TOKEN });
      const error = await failureOf(storage.startUpload({ objectPath: OBJECT, contentType: "audio/mp4", sizeBytes: 1, origin: null }));
      expect(error.code, response instanceof Response ? String(response.status) : "network").toBe(code);
    }
  });

  it("does not hand out a missing or foreign Location", async () => {
    for (const location of [undefined, "", "not a url", "https://evil.example/upload?x=1", "http://storage.googleapis.com/upload"]) {
      const headers: Record<string, string> = location === undefined ? {} : { Location: location };
      const { fetch } = fakeFetch(new Response(null, { status: 200, headers }));
      const storage = createGcsStorage({ bucket: BUCKET, fetch, accessToken: async () => TOKEN });
      const error = await failureOf(storage.startUpload({ objectPath: OBJECT, contentType: "audio/mp4", sizeBytes: 1, origin: null }));
      expect(error.code, String(location)).toBe("unavailable");
    }
  });

  it("refuses a bad object path, content type or size without calling anything", async () => {
    const { fetch, calls } = fakeFetch();
    const storage = createGcsStorage({ bucket: BUCKET, fetch, accessToken: async () => TOKEN });
    for (const input of [
      { objectPath: "audio/../x", contentType: "audio/mp4", sizeBytes: 1 },
      { objectPath: "/audio/x", contentType: "audio/mp4", sizeBytes: 1 },
      { objectPath: OBJECT, contentType: "audio/mp4\r\nX-Injected: 1", sizeBytes: 1 },
      { objectPath: OBJECT, contentType: "", sizeBytes: 1 },
      { objectPath: OBJECT, contentType: "audio/mp4", sizeBytes: -1 },
      { objectPath: OBJECT, contentType: "audio/mp4", sizeBytes: 1.5 },
    ]) {
      const error = await failureOf(storage.startUpload({ ...input, origin: null }));
      expect(error.code).toBe("rejected");
    }
    await expect(storage.stat("audio/a/b")).rejects.toMatchObject({ code: "rejected" });
    expect(calls).toHaveLength(0);
  });

  it("times out after the configured time as unavailable", async () => {
    const { fetch } = fakeFetch(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.init.signal?.addEventListener("abort", () => reject(call.init.signal?.reason));
        }),
    );
    const storage = createGcsStorage({ bucket: BUCKET, fetch, accessToken: async () => TOKEN, timeoutMs: 20 });
    const error = await failureOf(storage.startUpload({ objectPath: OBJECT, contentType: "audio/mp4", sizeBytes: 1, origin: null }));
    expect(error.code).toBe("unavailable");
  });
});

describe("GCS storage: checking an object", () => {
  it("GETs the object metadata with the bearer token and reads size and contentType", async () => {
    const { fetch, calls } = fakeFetch(objectResponse("2147483648", "audio/mp4"));
    const storage = createGcsStorage({ bucket: BUCKET, fetch, accessToken: async () => TOKEN });
    expect(await storage.stat(OBJECT)).toEqual({ sizeBytes: 2_147_483_648, contentType: "audio/mp4", generation: "7" });
    const call = calls[0]!;
    const url = new URL(call.url);
    expect(url.origin).toBe("https://storage.googleapis.com");
    expect(call.url.startsWith(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/audio%2F6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11?`)).toBe(true);
    expect(url.searchParams.get("fields")).toBe("size,contentType,generation");
    expect(call.init.method).toBe("GET");
    expect(call.init.redirect).toBe("error");
    expect(headersOf(call)).toEqual({ authorization: `Bearer ${TOKEN}` });
  });

  it("answers null for 404, and maps the other failures", async () => {
    const missing = createGcsStorage({ bucket: BUCKET, fetch: fakeFetch(new Response(null, { status: 404 })).fetch, accessToken: async () => TOKEN });
    expect(await missing.stat(OBJECT)).toBeNull();
    const noType = createGcsStorage({ bucket: BUCKET, fetch: fakeFetch(new Response(JSON.stringify({ size: "0", generation: "9" }), { status: 200 })).fetch, accessToken: async () => TOKEN });
    expect(await noType.stat(OBJECT)).toEqual({ sizeBytes: 0, contentType: null, generation: "9" });
    const cases: Array<[Response | Error, "unavailable" | "rejected"]> = [
      [new Error("socket hang up"), "unavailable"],
      [new Response(null, { status: 401 }), "unavailable"],
      [new Response(null, { status: 403 }), "unavailable"],
      [new Response(null, { status: 502 }), "unavailable"],
      [new Response(null, { status: 400 }), "rejected"],
      [new Response("not json", { status: 200 }), "unavailable"],
      [objectResponse("-1"), "unavailable"],
      [objectResponse("1.5"), "unavailable"],
      [new Response(JSON.stringify({ size: 10 }), { status: 200 }), "unavailable"],
      [new Response(JSON.stringify(null), { status: 200 }), "unavailable"],
    ];
    for (const [response, code] of cases) {
      const storage = createGcsStorage({ bucket: BUCKET, fetch: fakeFetch(response).fetch, accessToken: async () => TOKEN });
      expect((await failureOf(storage.stat(OBJECT))).code).toBe(code);
    }
  });
});

describe("GCS storage: generation-pinned copy", () => {
  const SOURCE = "image/6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
  const TARGET = "image/7f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d22";
  const metadata = (path: "source" | "target" = "source") => new Response(JSON.stringify({
    size: "3",
    contentType: "image/png",
    generation: path === "source" ? "17" : "18",
    metadata: path === "target" ? { nihoSourceGeneration: "17", nihoSourceObjectHash: createHash("sha256").update(SOURCE).digest("hex") } : {},
  }), { status: 200 });

  it("pins the source generation and requires destination generation zero", async () => {
    const rewritten = new Response(JSON.stringify({
      done: true,
      resource: { size: "3", contentType: "image/png", metadata: { nihoSourceGeneration: "17", nihoSourceObjectHash: createHash("sha256").update(SOURCE).digest("hex") } },
    }), { status: 200 });
    const { fetch, calls } = fakeFetch(metadata(), rewritten);
    const storage = createGcsStorage({ bucket: BUCKET, fetch, accessToken: async () => TOKEN });
    await expect(storage.copyObject!({ sourceObjectPath: SOURCE, targetObjectPath: TARGET, sourceGeneration: "17" })).resolves.toEqual({
      sourceGeneration: "17", sizeBytes: 3, contentType: "image/png",
    });
    expect(calls).toHaveLength(2);
    const rewrite = calls[1]!;
    const url = new URL(rewrite.url);
    expect(url.pathname).toContain(`/o/${encodeURIComponent(SOURCE)}/rewriteTo/b/${BUCKET}/o/${encodeURIComponent(TARGET)}`);
    expect(url.searchParams.get("ifSourceGenerationMatch")).toBe("17");
    expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
    expect(rewrite.init.redirect).toBe("error");
    expect(JSON.parse(String(rewrite.init.body))).toEqual({ contentType: "image/png", metadata: { nihoSourceGeneration: "17", nihoSourceObjectHash: createHash("sha256").update(SOURCE).digest("hex") } });
  });

  it("treats a 412 as an idempotent retry only when destination metadata matches", async () => {
    const { fetch } = fakeFetch(metadata(), new Response(null, { status: 412 }), metadata("target"));
    const storage = createGcsStorage({ bucket: BUCKET, fetch, accessToken: async () => TOKEN });
    await expect(storage.copyObject!({ sourceObjectPath: SOURCE, targetObjectPath: TARGET, sourceGeneration: "17" })).resolves.toMatchObject({ sourceGeneration: "17" });

    const mismatch = createGcsStorage({ bucket: BUCKET, fetch: fakeFetch(metadata(), new Response(null, { status: 412 }), metadata()).fetch, accessToken: async () => TOKEN });
    await expect(mismatch.copyObject!({ sourceObjectPath: SOURCE, targetObjectPath: TARGET, sourceGeneration: "17" })).rejects.toMatchObject({ code: "rejected" });
  });

  it("does not accept another source object with the same generation and size", async () => {
    const wrong = new Response(JSON.stringify({ size: "3", contentType: "image/png", generation: "18", metadata: {
      nihoSourceGeneration: "17", nihoSourceObjectHash: createHash("sha256").update("image/another-source").digest("hex"),
    } }), { status: 200 });
    const storage = createGcsStorage({ bucket: BUCKET, fetch: fakeFetch(metadata(), new Response(null, { status: 412 }), wrong).fetch, accessToken: async () => TOKEN });
    await expect(storage.copyObject!({ sourceObjectPath: SOURCE, targetObjectPath: TARGET, sourceGeneration: "17" })).rejects.toMatchObject({ code: "rejected" });
  });

  it("refuses a changed source generation before starting rewrite", async () => {
    const { fetch, calls } = fakeFetch(metadata());
    const storage = createGcsStorage({ bucket: BUCKET, fetch, accessToken: async () => TOKEN });
    await expect(storage.copyObject!({ sourceObjectPath: SOURCE, targetObjectPath: TARGET, sourceGeneration: "16" })).rejects.toMatchObject({ code: "rejected" });
    expect(calls).toHaveLength(1);
  });
});

describe("GCS storage: reading an object (the image relay)", () => {
  const IMAGE = "image/6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
  const media = (body: string, headers: Record<string, string>) => new Response(body, { status: 200, headers });

  it("GETs the media with the same bearer token and returns the stream, type and length", async () => {
    const { fetch, calls } = fakeFetch(media("abc", { "content-type": "image/png", "content-length": "3" }));
    const storage = createGcsStorage({ bucket: BUCKET, fetch, accessToken: async () => TOKEN });
    const read = await storage.readObject(IMAGE);
    expect(read).toMatchObject({ contentType: "image/png", sizeBytes: 3 });
    expect(await new Response(read!.body).text()).toBe("abc");
    const call = calls[0]!;
    const url = new URL(call.url);
    expect(url.origin).toBe("https://storage.googleapis.com");
    expect(call.url.startsWith(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/image%2F6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11?`)).toBe(true);
    expect(url.searchParams.get("alt")).toBe("media");
    expect(call.init.method).toBe("GET");
    expect(call.init.redirect).toBe("error");
    // 同じ token と、中身をそのまま受ける identity だけ（文字起こしの音声の読み出しと同じ規則）
    expect(headersOf(call)).toEqual({ authorization: `Bearer ${TOKEN}`, "accept-encoding": "identity" });
  });

  it("answers null for 404, maps the other failures, and refuses a response without a usable length", async () => {
    const missing = createGcsStorage({ bucket: BUCKET, fetch: fakeFetch(new Response(null, { status: 404 })).fetch, accessToken: async () => TOKEN });
    expect(await missing.readObject(IMAGE)).toBeNull();
    const cases: Array<[Response | Error, "unavailable" | "rejected"]> = [
      [new Error("socket hang up"), "unavailable"],
      [new Response(null, { status: 401 }), "unavailable"],
      [new Response(null, { status: 500 }), "unavailable"],
      [new Response(null, { status: 400 }), "rejected"],
      [media("abc", { "content-type": "image/png", "content-length": "x" }), "unavailable"],
    ];
    for (const [response, code] of cases) {
      const storage = createGcsStorage({ bucket: BUCKET, fetch: fakeFetch(response).fetch, accessToken: async () => TOKEN });
      expect((await failureOf(storage.readObject(IMAGE))).code).toBe(code);
    }
    const bad = createGcsStorage({ bucket: BUCKET, fetch: fakeFetch(media("x", {})).fetch, accessToken: async () => TOKEN });
    await expect(bad.readObject("image/../x")).rejects.toMatchObject({ code: "rejected" });
  });
});

describe("metadata server token", () => {
  it("keeps the token in memory until shortly before it expires, and fetches it once for concurrent callers", async () => {
    let now = NOW;
    const { fetch, calls } = fakeFetch(tokenResponse(3600), tokenResponse(3600));
    const token = createMetadataTokenProvider({ fetch, now: () => now });
    expect(await Promise.all([token(), token(), token()])).toEqual([TOKEN, TOKEN, TOKEN]);
    expect(calls).toHaveLength(1);
    now += (3600 - 61) * 1000;
    expect(await token()).toBe(TOKEN);
    expect(calls).toHaveLength(1);
    now += 2000;
    expect(await token()).toBe(TOKEN);
    expect(calls, "fetched again within the last minute before expiry").toHaveLength(2);
  });

  it("is reused by the storage across calls", async () => {
    const { fetch, calls } = fakeFetch(tokenResponse(), started(), started(), objectResponse());
    const storage = createGcsStorage({ bucket: BUCKET, fetch, now: () => NOW });
    await storage.startUpload({ objectPath: OBJECT, contentType: "audio/mp4", sizeBytes: 1, origin: null });
    await storage.startUpload({ objectPath: OBJECT, contentType: "audio/mp4", sizeBytes: 1, origin: null });
    await storage.stat(OBJECT);
    expect(calls.map((call) => call.url).filter((url) => url === METADATA_TOKEN_URL)).toHaveLength(1);
  });

  it("fails as unavailable, without the token or the body in the error, and tries again next time", async () => {
    const bad: Array<Response | Error> = [
      new Error("getaddrinfo ENOTFOUND metadata.google.internal"),
      new Response(`{"access_token":"${TOKEN}"}`, { status: 500 }),
      new Response("not json", { status: 200 }),
      new Response(JSON.stringify({ access_token: "", expires_in: 3600 }), { status: 200 }),
      new Response(JSON.stringify({ access_token: `${TOKEN}\r\nX-Injected: 1`, expires_in: 3600 }), { status: 200 }),
      new Response(JSON.stringify({ access_token: TOKEN }), { status: 200 }),
      new Response(JSON.stringify({ access_token: TOKEN, expires_in: 0 }), { status: 200 }),
    ];
    for (const response of bad) {
      const { fetch } = fakeFetch(response);
      const storage = createGcsStorage({ bucket: BUCKET, fetch });
      const error = await failureOf(storage.startUpload({ objectPath: OBJECT, contentType: "audio/mp4", sizeBytes: 1, origin: null }));
      expect(error.code).toBe("unavailable");
    }
    const { fetch, calls } = fakeFetch(new Response(null, { status: 503 }), tokenResponse());
    const token = createMetadataTokenProvider({ fetch });
    await expect(token()).rejects.toMatchObject({ code: "unavailable" });
    expect(await token()).toBe(TOKEN);
    expect(calls).toHaveLength(2);
  });

  it("never writes to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const { fetch } = fakeFetch(tokenResponse(), started(), new Response(null, { status: 403 }), objectResponse());
    const storage = createGcsStorage({ bucket: BUCKET, fetch });
    await storage.startUpload({ objectPath: OBJECT, contentType: "audio/mp4", sizeBytes: 1, origin: "https://editor.example.test" });
    await storage.startUpload({ objectPath: OBJECT, contentType: "audio/mp4", sizeBytes: 1, origin: null }).catch(() => undefined);
    await storage.stat(OBJECT);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
