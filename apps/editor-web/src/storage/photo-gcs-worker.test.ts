import { afterEach, describe, expect, it, vi } from "vitest";
import { IDS } from "../../../../packages/photo-library-contract/fixtures/v1";
import { executePhotoPurge, type PhotoPurgeStorePort } from "../../../../workers/photo-purge/src/executor";
import { createGcsPhotoMediaStorage, createGcsPhotoPurgeObjects } from "./photo-gcs-worker";
import { PhotoStorageError } from "./photo-types";

const PHOTO_ID = "44444444-4444-4444-8444-444444444444";
const ASSET_ID = "55555555-5555-4555-8555-555555555555";
const KEY = `photo/final/${PHOTO_ID}/${ASSET_ID}`;
const GENERATION = "123456789";
const TOKEN = "synthetic-token";
const BUCKET = "synthetic/private bucket";
const bytes = new Uint8Array([1, 2, 3, 4]);
const abortSignal = () => new AbortController().signal;

type FetchCall = [string, RequestInit];

function responseMetadata(generation = GENERATION, size = "4", contentType = "image/jpeg"): Response {
  return new Response(JSON.stringify({ generation, size, contentType }));
}

function chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* () { for (const value of values) yield value; })();
}

async function consumeBody(init: RequestInit): Promise<Uint8Array> {
  const reader = (init.body as ReadableStream<Uint8Array>).getReader();
  const found: number[] = [];
  while (true) {
    const item = await reader.read();
    if (item.done) return new Uint8Array(found);
    found.push(...item.value);
  }
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const found: number[] = [];
  for await (const chunk of iterable) found.push(...chunk);
  return new Uint8Array(found);
}

function media(fetcher: typeof fetch, accessToken = vi.fn(async () => TOKEN), timeoutMs = 30_000) {
  return { storage: createGcsPhotoMediaStorage({ bucket: BUCKET, fetch: fetcher, accessToken, timeoutMs }), accessToken };
}

function purge(responses: Response[], accessToken = vi.fn(async () => TOKEN)) {
  const fetcher = vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected synthetic request");
    return response;
  });
  return { objects: createGcsPhotoPurgeObjects({ bucket: BUCKET, fetch: fetcher as typeof fetch, accessToken }), fetcher, accessToken };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GCS P02 media worker storage", () => {
  it("streams a create-only final object with exact REST preconditions", async () => {
    const received: Uint8Array[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init).toBeDefined();
      received.push(await consumeBody(init!));
      return responseMetadata();
    });
    const f = media(fetcher as typeof fetch);
    const result = await f.storage.create({ key: KEY, bytes: chunks(bytes.subarray(0, 2), bytes.subarray(2)), sizeBytes: 4, contentType: "image/jpeg", ifGenerationMatch: 0 }, abortSignal());
    expect(result).toEqual({ generation: GENERATION, sizeBytes: 4, contentType: "image/jpeg" });
    expect(received).toEqual([bytes]);
    const [url, init] = fetcher.mock.calls[0] as unknown as FetchCall;
    expect(url).toBe(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(BUCKET)}/o?uploadType=media&name=${encodeURIComponent(KEY)}&ifGenerationMatch=0`);
    expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", duplex: "half" });
    expect(new Headers(init.headers)).toMatchObject(expect.any(Headers));
    expect(new Headers(init.headers).get("content-type")).toBe("image/jpeg");
    expect(new Headers(init.headers).get("content-length")).toBe("4");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect("deleteGeneration" in f.storage).toBe(false);
  });

  it("returns provider metadata without a locator so P02 can ledger its known generation", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      await consumeBody(init!);
      return responseMetadata("987", "9", "image/png");
    });
    const result = await media(fetcher as typeof fetch).storage.create({ key: KEY, bytes: chunks(bytes), sizeBytes: 4, contentType: "image/jpeg", ifGenerationMatch: 0 }, abortSignal());
    expect(result).toEqual({ generation: "987", sizeBytes: 9, contentType: "image/png" });
    expect(result).not.toHaveProperty("key");
    expect(result).not.toHaveProperty("url");
  });

  it.each([
    ["short", chunks(bytes.subarray(0, 3)), 4],
    ["long", chunks(bytes, new Uint8Array([5])), 4],
  ])("rejects a %s create body and closes its iterator", async (_name, source, sizeBytes) => {
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const iterator = source[Symbol.asyncIterator]();
    iterator.return = returned;
    const iterable = { [Symbol.asyncIterator]: () => iterator };
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      await consumeBody(init!);
      return responseMetadata();
    });
    await expect(media(fetcher as typeof fetch).storage.create({ key: KEY, bytes: iterable, sizeBytes, contentType: "image/jpeg", ifGenerationMatch: 0 }, abortSignal())).rejects.toMatchObject({ code: "unavailable" });
    expect(returned).toHaveBeenCalled();
  });

  it("rejects an early success promptly, aborts the request, and requests iterator cleanup", async () => {
    const returned = vi.fn(async () => await new Promise<IteratorResult<Uint8Array>>(() => undefined));
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({ next: async () => new Promise<IteratorResult<Uint8Array>>(() => undefined), return: returned }),
    };
    let requestSignal: AbortSignal | null = null;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? null;
      return responseMetadata();
    });
    await expect(media(fetcher as typeof fetch).storage.create({ key: KEY, bytes: source, sizeBytes: 4, contentType: "image/jpeg", ifGenerationMatch: 0 }, abortSignal())).rejects.toMatchObject({ code: "unavailable" });
    expect(returned).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(true);
  });

  it("closes the create iterator when the caller aborts during upload", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({ next: async () => { entered(); return await new Promise<IteratorResult<Uint8Array>>(() => undefined); }, return: returned }),
    };
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      await consumeBody(init!);
      return responseMetadata();
    });
    const controller = new AbortController();
    const pending = media(fetcher as typeof fetch).storage.create({ key: KEY, bytes: source, sizeBytes: 4, contentType: "image/png", ifGenerationMatch: 0 }, controller.signal);
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
    expect(returned).toHaveBeenCalled();
  });

  it("does not wait for hung next/return cleanup or send a late chunk after timeout", async () => {
    vi.useFakeTimers();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let resolveNext!: (value: IteratorResult<Uint8Array>) => void;
    const next = new Promise<IteratorResult<Uint8Array>>((resolve) => { resolveNext = resolve; });
    const returned = vi.fn(async () => await new Promise<IteratorResult<Uint8Array>>(() => undefined));
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({ next: () => { entered(); return next; }, return: returned }),
    };
    let sentBytes = 0;
    let requestSignal: AbortSignal | null = null;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? null;
      const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
      try {
        const item = await reader.read();
        if (!item.done) sentBytes += item.value.byteLength;
      } catch { /* The operation aborts the upload stream. */ }
      return responseMetadata();
    });
    const pending = media(fetcher as typeof fetch, vi.fn(async () => TOKEN), 10).storage.create({ key: KEY, bytes: source, sizeBytes: 4, contentType: "image/jpeg", ifGenerationMatch: 0 }, abortSignal());
    const rejected = expect(pending).rejects.toMatchObject({ code: "unavailable" });
    await started;
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(returned).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(true);
    resolveNext({ done: false, value: bytes });
    await Promise.resolve();
    await Promise.resolve();
    expect(sentBytes).toBe(0);
  });

  it.each([
    [412, "conflict"],
    [503, "unavailable"],
  ] as const)("maps an early %i without waiting for request-body consumption", async (status, code) => {
    const returned = vi.fn(async () => await new Promise<IteratorResult<Uint8Array>>(() => undefined));
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({ next: async () => await new Promise<IteratorResult<Uint8Array>>(() => undefined), return: returned }),
    };
    let requestSignal: AbortSignal | null = null;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? null;
      return new Response(null, { status });
    });
    await expect(media(fetcher as typeof fetch).storage.create({ key: KEY, bytes: source, sizeBytes: 4, contentType: "image/png", ifGenerationMatch: 0 }, abortSignal())).rejects.toMatchObject({ code });
    expect(returned).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(true);
  });

  it("maps 412 to conflict only after consuming the exact create body", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(await consumeBody(init!)).toEqual(bytes);
      return new Response(null, { status: 412 });
    });
    await expect(media(fetcher as typeof fetch).storage.create({ key: KEY, bytes: chunks(bytes), sizeBytes: 4, contentType: "image/png", ifGenerationMatch: 0 }, abortSignal())).rejects.toMatchObject({ code: "conflict" });
  });

  it("reads only one exact final generation as an identity-encoded bounded stream", async () => {
    const fetcher = vi.fn(async () => new Response(bytes, { headers: { "Content-Length": "4", "x-goog-generation": GENERATION } }));
    const f = media(fetcher as typeof fetch);
    expect(await collect(await f.storage.read({ key: KEY, generation: GENERATION, sizeBytes: 4, contentType: "image/heic" }, abortSignal()))).toEqual(bytes);
    const [url, init] = fetcher.mock.calls[0] as unknown as FetchCall;
    expect(url).toBe(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(BUCKET)}/o/${encodeURIComponent(KEY)}?alt=media&generation=${GENERATION}&ifGenerationMatch=${GENERATION}`);
    expect(init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
    expect(new Headers(init.headers).get("accept-encoding")).toBe("identity");
    expect("create" in createGcsPhotoPurgeObjects({ bucket: BUCKET, fetch: fetcher as typeof fetch, accessToken: async () => TOKEN })).toBe(false);
  });

  it.each([
    ["short body", new Response(bytes.subarray(0, 3), { headers: { "Content-Length": "4" } })],
    ["long body", new Response(new Uint8Array([1, 2, 3, 4, 5]), { headers: { "Content-Length": "4" } })],
    ["range", new Response(bytes, { status: 206, headers: { "Content-Length": "4", "Content-Range": "bytes 0-3/4" } })],
    ["generation", new Response(bytes, { headers: { "Content-Length": "4", "x-goog-generation": "999" } })],
    ["encoding", new Response(bytes, { headers: { "Content-Length": "4", "Content-Encoding": "gzip" } })],
    ["stored encoding", new Response(bytes, { headers: { "Content-Length": "4", "x-goog-stored-content-encoding": "br" } })],
    ["redirect", new Response(null, { status: 302, headers: { Location: "https://foreign.invalid/private" } })],
  ])("rejects read %s", async (_name, response) => {
    const storage = media(vi.fn(async () => response) as typeof fetch).storage;
    const attempt = async () => collect(await storage.read({ key: KEY, generation: GENERATION, sizeBytes: 4, contentType: "image/jpeg" }, abortSignal()));
    await expect(attempt()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("returns promptly after an early read return even when provider cancellation never settles", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn(async () => await new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(bytes.subarray(0, 2)); },
      cancel: cancelled,
    }, { highWaterMark: 0 });
    let requestSignal: AbortSignal | null = null;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? null;
      return new Response(body, { headers: { "Content-Length": "4" } });
    });
    const storage = media(fetcher as typeof fetch).storage;
    const iteration = (async () => {
      for await (const chunk of await storage.read({ key: KEY, generation: GENERATION, sizeBytes: 4, contentType: "image/jpeg" }, abortSignal())) {
        expect(chunk).toEqual(bytes.subarray(0, 2));
        break;
      }
      return "completed";
    })();
    const winner = Promise.race([iteration, new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 10))]);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await expect(winner).resolves.toBe("completed");
    expect(cancelled).toHaveBeenCalled();
    expect(requestSignal?.aborted).toBe(true);
  });

  it("rejects all invalid namespaces, generations and create fields before credentials or network", async () => {
    const accessToken = vi.fn(async () => TOKEN);
    const fetcher = vi.fn();
    const storage = media(fetcher as typeof fetch, accessToken).storage;
    for (const key of [`photo/stage/${PHOTO_ID}`, `docs/final/${PHOTO_ID}/${ASSET_ID}`, `photo/final/${PHOTO_ID}`, `${KEY}/extra`]) {
      await expect(storage.read({ key, generation: GENERATION, sizeBytes: 4, contentType: "image/jpeg" }, abortSignal())).rejects.toBeInstanceOf(PhotoStorageError);
    }
    for (const generation of ["0", "-1", "01", "latest", "1.5"]) {
      await expect(storage.read({ key: KEY, generation, sizeBytes: 4, contentType: "image/jpeg" }, abortSignal())).rejects.toBeInstanceOf(PhotoStorageError);
    }
    await expect(storage.create({ key: KEY, bytes: chunks(bytes), sizeBytes: 4, contentType: "image/gif", ifGenerationMatch: 0 }, abortSignal())).rejects.toMatchObject({ code: "conflict" });
    await expect(storage.create({ key: KEY, bytes: chunks(bytes), sizeBytes: 4, contentType: "image/jpeg", ifGenerationMatch: 1 as 0 }, abortSignal())).rejects.toMatchObject({ code: "conflict" });
    expect(accessToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not request credentials or transmit for a pre-aborted operation", async () => {
    const accessToken = vi.fn(async () => TOKEN);
    const fetcher = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(media(fetcher as typeof fetch, accessToken).storage.read({ key: KEY, generation: GENERATION, sizeBytes: 4, contentType: "image/jpeg" }, controller.signal)).rejects.toMatchObject({ code: "unavailable" });
    expect(accessToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds credential waiting, request waiting, and metadata body consumption", async () => {
    vi.useFakeTimers();
    const neverToken = vi.fn(async () => await new Promise<string>(() => undefined));
    const tokenAttempt = media(vi.fn() as typeof fetch, neverToken, 10).storage.read({ key: KEY, generation: GENERATION, sizeBytes: 4, contentType: "image/jpeg" }, abortSignal());
    const tokenRejected = expect(tokenAttempt).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(10);
    await tokenRejected;

    const neverFetch = vi.fn(async () => await new Promise<Response>(() => undefined));
    const requestAttempt = media(neverFetch as typeof fetch, vi.fn(async () => TOKEN), 10).storage.read({ key: KEY, generation: GENERATION, sizeBytes: 4, contentType: "image/jpeg" }, abortSignal());
    const requestRejected = expect(requestAttempt).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(10);
    await requestRejected;

    const bodyCancelled = vi.fn(async () => await new Promise<void>(() => undefined));
    const pendingBody = new ReadableStream<Uint8Array>({
      pull: async () => await new Promise<void>(() => undefined),
      cancel: bodyCancelled,
    });
    const bodyFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      await consumeBody(init!);
      return new Response(pendingBody);
    });
    const bodyAttempt = media(bodyFetch as typeof fetch, vi.fn(async () => TOKEN), 10).storage.create({ key: KEY, bytes: chunks(bytes), sizeBytes: 4, contentType: "image/jpeg", ifGenerationMatch: 0 }, abortSignal());
    const bodyRejected = expect(bodyAttempt).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(10);
    await bodyRejected;
    expect(bodyCancelled).toHaveBeenCalled();
  });

  it("never leaks credential, bucket, URL, response body, or transport details", async () => {
    const secrets = ["private-token-path", BUCKET, "foreign.invalid/private", "private-response-body", "socket-private-detail"];
    const cases = [
      media(vi.fn() as typeof fetch, async () => { throw new Error(secrets[0]); }).storage,
      media(vi.fn(async () => new Response(secrets[3], { status: 503, headers: { Location: `https://${secrets[2]}` } })) as typeof fetch).storage,
      media(vi.fn(async () => { throw new Error(secrets[4]); }) as typeof fetch).storage,
    ];
    for (const storage of cases) {
      const error = await storage.read({ key: KEY, generation: GENERATION, sizeBytes: 4, contentType: "image/jpeg" }, abortSignal()).catch((failure: unknown) => failure);
      expect(String(error)).toBe("Error: photo storage: unavailable");
      for (const secret of secrets) expect(String(error)).not.toContain(secret);
    }
  });
});

describe("GCS P02 purge worker storage", () => {
  it.each([
    [204, "deleted"],
    [404, "already_absent"],
  ] as const)("confirms DELETE %i only after live and soft-deleted metadata are both absent", async (status, expected) => {
    const f = purge([new Response(null, { status }), new Response(null, { status: 404 }), new Response(null, { status: 404 })]);
    await expect(f.objects.deleteGeneration({ objectKey: KEY, ifGenerationMatch: GENERATION })).resolves.toBe(expected);
    const calls = f.fetcher.mock.calls as unknown as FetchCall[];
    expect(calls.map(([url]) => url)).toEqual([
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(BUCKET)}/o/${encodeURIComponent(KEY)}?generation=${GENERATION}&ifGenerationMatch=${GENERATION}`,
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(BUCKET)}/o/${encodeURIComponent(KEY)}?generation=${GENERATION}`,
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(BUCKET)}/o/${encodeURIComponent(KEY)}?generation=${GENERATION}&softDeleted=true`,
    ]);
    expect(calls.map(([, init]) => init.method)).toEqual(["DELETE", "GET", "GET"]);
    expect(calls.every(([, init]) => init.redirect === "error" && init.cache === "no-store")).toBe(true);
  });

  it("returns generation_mismatch for 412 without checking or deleting anything else", async () => {
    const f = purge([new Response(null, { status: 412 })]);
    await expect(f.objects.deleteGeneration({ objectKey: KEY, ifGenerationMatch: GENERATION })).resolves.toBe("generation_mismatch");
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ["live generation still exists", [new Response(null, { status: 204 }), responseMetadata()]],
    ["soft-deleted generation exists", [new Response(null, { status: 204 }), new Response(null, { status: 404 }), responseMetadata()]],
    ["soft-delete check is ambiguous", [new Response(null, { status: 404 }), new Response(null, { status: 404 }), new Response(null, { status: 403 })]],
    ["delete is unavailable", [new Response(null, { status: 503 })]],
  ])("does not confirm when %s", async (_name, responses) => {
    const f = purge(responses);
    await expect(f.objects.deleteGeneration({ objectKey: KEY, ifGenerationMatch: GENERATION })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("validates the exact final key and positive generation before token or DELETE", async () => {
    const accessToken = vi.fn(async () => TOKEN);
    const f = purge([], accessToken);
    for (const input of [
      { objectKey: `photo/stage/${PHOTO_ID}`, ifGenerationMatch: GENERATION },
      { objectKey: "site/photo", ifGenerationMatch: GENERATION },
      { objectKey: KEY, ifGenerationMatch: "0" },
      { objectKey: KEY, ifGenerationMatch: "01" },
    ]) await expect(f.objects.deleteGeneration(input)).rejects.toMatchObject({ code: "conflict" });
    expect(accessToken).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("sanitizes purge token, provider, status and body failures", async () => {
    const providerFailure = createGcsPhotoPurgeObjects({ bucket: BUCKET, fetch: vi.fn() as typeof fetch, accessToken: async () => { throw new Error("private-token"); } });
    const statusFailure = purge([new Response("private-body", { status: 400 })]).objects;
    for (const objects of [providerFailure, statusFailure]) {
      const error = await objects.deleteGeneration({ objectKey: KEY, ifGenerationMatch: GENERATION }).catch((failure: unknown) => failure);
      expect(String(error)).toBe("Error: photo storage: unavailable");
      expect(String(error)).not.toContain("private");
      expect(String(error)).not.toContain(BUCKET);
    }
  });

  it.each([
    ["soft-deleted generation remains", [new Response(null, { status: 204 }), new Response(null, { status: 404 }), responseMetadata()]],
    ["absence response is ambiguous", [new Response(null, { status: 204 }), new Response(null, { status: 500 })]],
  ])("keeps the durable purge ledger pending when %s", async (_name, responses) => {
    const f = purge(responses);
    const confirmAssetDeleted = vi.fn<PhotoPurgeStorePort["confirmAssetDeleted"]>(async () => ({ id: IDS.job, state: "completed", pendingBytes: 0 }));
    const store: PhotoPurgeStorePort = {
      getJob: async () => ({ id: IDS.job, state: "queued", pendingBytes: 4 }),
      listPendingAssets: async () => [{ id: IDS.original, objectKey: KEY, objectGeneration: GENERATION }],
      confirmAssetDeleted,
    };
    await expect(executePhotoPurge(IDS.userA, IDS.job, store, f.objects)).rejects.toMatchObject({ code: "delete_failed" });
    expect(confirmAssetDeleted).not.toHaveBeenCalled();
  });
});
