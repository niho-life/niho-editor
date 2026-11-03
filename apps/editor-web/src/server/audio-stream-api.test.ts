import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioInfo } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { createFakeStorage, type FakeStorage } from "../storage/fake";
import { createGcsStorage } from "../storage/gcs";
import { StorageError, type ObjectStorage, type ReadObject, type ReadObjectOptions } from "../storage/types";
import { headAudioRoute, streamAudioRoute, type AudioStreamApiDeps, type AudioStreamStore } from "./audio-stream-api";

// 合成のユーザー ID・合成のバイト列だけを使う（i 番目のバイトが i の並びで、範囲の中身が分かる）

const ORIGIN = "http://editor.test";
const ME = "synthetic-owner";
const THEM = "synthetic-other-owner";
const NOW = Date.parse("2030-01-10T00:00:00.000Z");
const FUTURE = "2030-02-09T00:00:00.000Z";
const PAST = "2030-01-09T00:00:00.000Z";
const SEQUENCE = Uint8Array.from({ length: 10 }, (_, index) => index);
const BUCKET = "synthetic-test-bucket";
const TOKEN = "synthetic-access-token-0123456789";

type Row = { owner: string; pageId: string; deleted: boolean; info: AudioInfo | null; partIndex?: number };

function audio(status: AudioInfo["status"], expiresAt: string | null = FUTURE, bytes = SEQUENCE.byteLength, contentType = "audio/mp4"): AudioInfo {
  const assetId = randomUUID();
  return { assetId, objectPath: `audio/${assetId}`, status, bytes, contentType, sha256: "e".repeat(64), expiresAt };
}

/** メモリの中だけの合成の store（本人の・ゴミ箱でないページのPartだけ）。 */
function memoryStore(rows: Row[]): AudioStreamStore & { calls: number } {
  const store = {
    calls: 0,
    listAudioParts: async (owner: string, pageId: string) => {
      store.calls += 1;
      return rows
        .filter((row) => row.owner === owner && row.pageId === pageId && !row.deleted && row.info !== null)
        .map((row) => ({
          partIndex: row.partIndex ?? 0,
          objectPath: row.info!.objectPath,
          status: row.info!.status,
          bytes: row.info!.bytes,
          contentType: row.info!.contentType,
          expiresAt: row.info!.expiresAt,
        }));
    },
  };
  return store;
}

const notUsed = async (): Promise<Response> => {
  throw new Error("the audio stream API never calls the login routes");
};

function authAs(userId: string | null): AuthProvider {
  return { mode: "stub", getSession: async () => (userId ? { userId, mode: "stub" } : null), beginLogin: notUsed, completeLogin: notUsed, logout: notUsed };
}

function deps(userId: string | null, store: AudioStreamStore | null, storage: ObjectStorage | null): AudioStreamApiDeps {
  return { auth: () => authAs(userId), store: () => store, storage: () => storage, now: () => NOW };
}

function request(id: string, headers: Record<string, string> = {}, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}/api/pages/${id}/recording/audio`, { method: "GET", headers: { host: "editor.test", ...headers }, ...init });
}

const get = (id: string, d: AudioStreamApiDeps, headers: Record<string, string> = {}) => streamAudioRoute(request(id, headers), id, d);

async function snapshot(response: Response) {
  return { status: response.status, headers: [...response.headers.entries()].sort(), body: await response.text() };
}

async function bytesOf(response: Response): Promise<number[]> {
  return [...new Uint8Array(await response.arrayBuffer())];
}

/** 偽の保存先に、資産の場所へ中身を置く。 */
async function put(storage: FakeStorage, info: AudioInfo, bytes: Uint8Array) {
  const ticket = await storage.startUpload({ objectPath: info.objectPath, contentType: info.contentType, sizeBytes: bytes.byteLength, origin: null });
  expect(storage.putFakeObject(ticket.url.split("/").pop()!, bytes, info.contentType)).toBe("ok");
}

/** 自分の再生できる音声（10 バイト）と、404 になるはずの各種の行。 */
async function world() {
  const storage = createFakeStorage();
  const mine = { owner: ME, pageId: randomUUID(), deleted: false, info: audio("uploaded") };
  await put(storage, mine.info, SEQUENCE);
  const theirs = { owner: THEM, pageId: randomUUID(), deleted: false, info: audio("uploaded") };
  await put(storage, theirs.info, SEQUENCE);
  const deleted = { owner: ME, pageId: randomUUID(), deleted: true, info: audio("uploaded") };
  await put(storage, deleted.info, SEQUENCE);
  // 録音の無いページ・音声の無い録音（VTT）はPartが空
  const noAudio = { owner: ME, pageId: randomUUID(), deleted: false, info: null };
  const uploading = { owner: ME, pageId: randomUUID(), deleted: false, info: audio("uploading") };
  await put(storage, uploading.info, SEQUENCE);
  const expired = { owner: ME, pageId: randomUUID(), deleted: false, info: audio("uploaded", PAST) };
  await put(storage, expired.info, SEQUENCE);
  const expiresNow = { owner: ME, pageId: randomUUID(), deleted: false, info: audio("uploaded", new Date(NOW).toISOString()) };
  await put(storage, expiresNow.info, SEQUENCE);
  // 期限の前に保存先の規則で消えた（object が無い）
  const vanished = { owner: ME, pageId: randomUUID(), deleted: false, info: audio("uploaded") };
  const rows = [mine, theirs, deleted, noAudio, uploading, expired, expiresNow, vanished];
  return { storage, rows, store: memoryStore(rows), mine, theirs, deleted, noAudio, uploading, expired, expiresNow, vanished };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/pages/{id}/recording/audio: who can read (#36 段 3b-2)", () => {
  it("answers 401 without a session, before the store and the storage", async () => {
    const { storage, store, mine } = await world();
    const read = vi.spyOn(storage, "readObject");
    const response = await get(mine.pageId, deps(null, store, storage));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('{"error":"unauthorized"}');
    expect(store.calls).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it("answers the same 404 (body and headers) for another owner, an unknown id, a malformed id, the trash, no audio, uploading, expired and a vanished object", async () => {
    const w = await world();
    const d = deps(ME, w.store, w.storage);
    const unknown = await snapshot(await get(randomUUID(), d));
    expect(unknown.status).toBe(404);
    expect(unknown.body).toBe('{"error":"not_found"}');
    for (const id of [w.theirs.pageId, "not-a-uuid", "../../etc", w.deleted.pageId, w.noAudio.pageId, w.uploading.pageId, w.expired.pageId, w.expiresNow.pageId, w.vanished.pageId]) {
      expect(await snapshot(await get(id, d)), id).toEqual(unknown);
    }
    // 範囲を付けても同じ（416 で大きさを漏らさない）
    const unknownRange = await snapshot(await get(randomUUID(), d, { range: "bytes=999-" }));
    expect(unknownRange).toEqual(unknown);
    for (const id of [w.theirs.pageId, w.uploading.pageId, w.expired.pageId]) {
      expect(await snapshot(await get(id, d, { range: "bytes=999-" })), id).toEqual(unknown);
      expect(await snapshot(await get(id, d, { range: "bytes=0-1,2-3" })), id).toEqual(unknown);
    }
  });

  it("answers 503 when the database or the storage is not available", async () => {
    const { storage, store, mine } = await world();
    const noDb = await get(mine.pageId, deps(ME, null, storage));
    expect(noDb.status).toBe(503);
    expect(await noDb.text()).toBe('{"error":"unavailable"}');
    const noStorage = await get(mine.pageId, deps(ME, store, null));
    expect(noStorage.status).toBe(503);
    expect(await noStorage.text()).toBe('{"error":"storage_unavailable"}');
  });
});

describe("GET /api/pages/{id}/recording/audio: the body and Range", () => {
  it("answers 200 with the whole audio and the headers when there is no Range", async () => {
    const { storage, store, mine } = await world();
    const response = await get(mine.pageId, deps(ME, store, storage));
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers.entries())).toEqual({
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "content-disposition": "inline",
      "content-length": "10",
      "content-type": "audio/mp4",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    });
    expect(await bytesOf(response)).toEqual([...SEQUENCE]);
  });

  it("answers 206 with Content-Range and Content-Length for one range: a-b, a-, -n, the end cut at the end", async () => {
    const { storage, store, mine } = await world();
    const d = deps(ME, store, storage);
    for (const [header, start, end] of [
      ["bytes=2-5", 2, 5],
      ["bytes=0-0", 0, 0],
      ["bytes=9-9", 9, 9],
      ["bytes=0-", 0, 9],
      ["bytes=7-", 7, 9],
      ["bytes=-3", 7, 9],
      ["bytes=-50", 0, 9],
      ["bytes=5-100", 5, 9],
      ["Bytes=2-5", 2, 5],
    ] as const) {
      const response = await get(mine.pageId, d, { range: header });
      expect(response.status, header).toBe(206);
      expect(response.headers.get("content-range"), header).toBe(`bytes ${start}-${end}/10`);
      expect(response.headers.get("content-length"), header).toBe(String(end - start + 1));
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("content-disposition")).toBe("inline");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-type")).toBe("audio/mp4");
      expect(await bytesOf(response), header).toEqual([...SEQUENCE.slice(start, end + 1)]);
    }
  });

  it("answers 416 with Content-Range: bytes */total for several ranges, a malformed range and a start past the end, without reading the storage", async () => {
    const { storage, store, mine } = await world();
    const read = vi.spyOn(storage, "readObject");
    const d = deps(ME, store, storage);
    for (const header of ["bytes=0-1,4-5", "bytes=0-1, 4-5", "bytes=abc", "bytes=5-2", "bytes=", "bytes=10-", "bytes=10-20", "bytes=-0", "nonsense"]) {
      const response = await get(mine.pageId, d, { range: header });
      expect(response.status, header).toBe(416);
      expect(response.headers.get("content-range"), header).toBe("bytes */10");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).toBe('{"error":"range_not_satisfiable"}');
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("ignores the Range with If-Range (no validators are given) and with another unit: the whole audio with 200", async () => {
    const { storage, store, mine } = await world();
    const d = deps(ME, store, storage);
    const withIfRange = await get(mine.pageId, d, { range: "bytes=2-5", "if-range": '"anything"' });
    expect(withIfRange.status).toBe(200);
    expect(withIfRange.headers.get("content-range")).toBeNull();
    expect(await bytesOf(withIfRange)).toEqual([...SEQUENCE]);
    const otherUnit = await get(mine.pageId, d, { range: "items=0-1" });
    expect(otherUnit.status).toBe(200);
    expect(await bytesOf(otherUnit)).toEqual([...SEQUENCE]);
  });

  it("serves a known audio type without parameters, and anything else as octet-stream", async () => {
    const storage = createFakeStorage();
    const webm = { owner: ME, pageId: randomUUID(), deleted: false, info: audio("uploaded", FUTURE, 10, "audio/webm") };
    await put(storage, webm.info, SEQUENCE);
    const odd = { owner: ME, pageId: randomUUID(), deleted: false, info: audio("uploaded", FUTURE, 10, "text/html") };
    await put(storage, odd.info, SEQUENCE);
    const d = deps(ME, memoryStore([webm, odd]), storage);
    expect((await get(webm.pageId, d)).headers.get("content-type")).toBe("audio/webm");
    expect((await get(odd.pageId, d)).headers.get("content-type")).toBe("application/octet-stream");
  });

  it("reads only the requested uploaded part, keeps owner/page scoping, and returns 404 for unavailable or malformed part indexes", async () => {
    const storage = createFakeStorage();
    const pageId = randomUUID();
    const first = audio("uploaded", FUTURE, 10, "audio/mp4");
    const second = audio("uploaded", FUTURE, 10, "audio/webm");
    const expiredPart = audio("uploaded", PAST, 10, "audio/mp4");
    const uploadingPart = audio("uploading", FUTURE, 10, "audio/mp4");
    for (const info of [first, second, expiredPart, uploadingPart]) await put(storage, info, SEQUENCE);
    const rows: Row[] = [
      { owner: ME, pageId, deleted: false, info: first, partIndex: 0 },
      { owner: ME, pageId, deleted: false, info: second, partIndex: 1 },
      { owner: ME, pageId, deleted: false, info: expiredPart, partIndex: 2 },
      { owner: ME, pageId, deleted: false, info: uploadingPart, partIndex: 3 },
      { owner: THEM, pageId, deleted: false, info: audio("uploaded"), partIndex: 4 },
    ];
    const store = memoryStore(rows);
    const read = vi.spyOn(storage, "readObject");
    const d = deps(ME, store, storage);
    const response = await get(pageId, d, {});
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mp4");
    expect(read.mock.calls.at(-1)?.[0]).toBe(first.objectPath);
    const secondRequest = new Request(`${ORIGIN}/api/pages/${pageId}/recording/audio?part=1`, { headers: { host: "editor.test" } });
    const secondPart = await streamAudioRoute(secondRequest, pageId, d);
    expect(secondPart.status).toBe(200);
    expect(secondPart.headers.get("content-type")).toBe("audio/webm");
    expect(read.mock.calls.at(-1)?.[0]).toBe(second.objectPath);

    for (const query of ["part=2", "part=3", "part=4", "part=-1", "part=1.5", "part=01", "part=999"]) {
      const rejected = await streamAudioRoute(new Request(`${ORIGIN}/api/pages/${pageId}/recording/audio?${query}`, { headers: { host: "editor.test" } }), pageId, d);
      expect(rejected.status, query).toBe(404);
    }
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("answers 200 with the whole audio when the storage ignored the range, and 416 when the storage cannot serve it", async () => {
    const { store, mine } = await world();
    const whole: ObjectStorage = {
      ...createFakeStorage(),
      readObject: async () => ({ body: new Response(SEQUENCE).body!, contentType: "audio/mp4", sizeBytes: 10, range: { start: 0, end: 9 }, totalBytes: 10 }),
    };
    const ignored = await get(mine.pageId, deps(ME, store, whole), { range: "bytes=2-5" });
    expect(ignored.status).toBe(200);
    expect(ignored.headers.get("content-length")).toBe("10");
    expect(ignored.headers.get("content-range")).toBeNull();
    expect(await bytesOf(ignored)).toEqual([...SEQUENCE]);

    const short: ObjectStorage = {
      ...createFakeStorage(),
      readObject: async () => {
        throw new StorageError("range_not_satisfiable");
      },
    };
    const refused = await get(mine.pageId, deps(ME, store, short), { range: "bytes=8-" });
    expect(refused.status).toBe(416);
    expect(refused.headers.get("content-range")).toBe("bytes */10");
  });
});

describe("GET /api/pages/{id}/recording/audio: streaming", () => {
  /** chunk を 1 バイトずつ、求められた分だけ作る保存先。pull と cancel を数える。 */
  function countingStorage(total: number) {
    const seen = { pulls: 0, cancelled: 0, options: [] as (ReadObjectOptions | undefined)[] };
    const storage: ObjectStorage = {
      ...createFakeStorage(),
      readObject: async (_path: string, options?: ReadObjectOptions): Promise<ReadObject> => {
        seen.options.push(options);
        let next = options?.range?.start ?? 0;
        const end = options?.range ? Math.min(options.range.end, total - 1) : total - 1;
        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              seen.pulls += 1;
              if (next > end) {
                controller.close();
                return;
              }
              controller.enqueue(new Uint8Array([next % 256]));
              next += 1;
            },
            cancel() {
              seen.cancelled += 1;
            },
          },
          { highWaterMark: 0 },
        );
        const sizeBytes = end - (options?.range?.start ?? 0) + 1;
        return options?.range
          ? { body, contentType: "audio/mp4", sizeBytes, range: { start: options.range.start, end }, totalBytes: total }
          : { body, contentType: "audio/mp4", sizeBytes };
      },
    };
    return { storage, seen };
  }

  it("passes the storage stream through without reading it all, and cancels the storage stream when the client stops reading", async () => {
    const total = 1000;
    const { storage, seen } = countingStorage(total);
    const row = { owner: ME, pageId: randomUUID(), deleted: false, info: audio("uploaded", FUTURE, total) };
    const response = await get(row.pageId, deps(ME, memoryStore([row]), storage));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(total));
    // 応答を作っただけでは読まない
    expect(seen.pulls).toBeLessThanOrEqual(1);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect([...first.value!]).toEqual([0]);
    expect(seen.pulls).toBeLessThan(5);
    await reader.cancel();
    expect(seen.cancelled).toBe(1);
  });

  it("cancels the storage stream when the request is aborted (the client went away)", async () => {
    const { storage, seen } = countingStorage(1000);
    const row = { owner: ME, pageId: randomUUID(), deleted: false, info: audio("uploaded", FUTURE, 1000) };
    const controller = new AbortController();
    const response = await streamAudioRoute(request(row.pageId, { range: "bytes=100-" }, { signal: controller.signal }), row.pageId, deps(ME, memoryStore([row]), storage));
    expect(response.status).toBe(206);
    expect(seen.options).toEqual([{ range: { start: 100, end: 999 } }]);
    const reader = response.body!.getReader();
    expect([...(await reader.read()).value!]).toEqual([100]);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen.cancelled).toBe(1);
  });

  it("answers HEAD with the same status and headers and no body, and cancels the storage stream at once", async () => {
    const { storage, seen } = countingStorage(10);
    const row = { owner: ME, pageId: randomUUID(), deleted: false, info: audio("uploaded") };
    const d = deps(ME, memoryStore([row]), storage);
    const head = await headAudioRoute(request(row.pageId, { range: "bytes=2-5" }, { method: "HEAD" }), row.pageId, d);
    expect(head.status).toBe(206);
    expect(head.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(head.headers.get("content-length")).toBe("4");
    expect(head.body).toBeNull();
    expect(seen.cancelled).toBe(1);
    const missing = await headAudioRoute(request(randomUUID(), {}, { method: "HEAD" }), randomUUID(), d);
    expect(missing.status).toBe(404);
    expect(missing.body).toBeNull();
  });
});

describe("GET /api/pages/{id}/recording/audio: storage failures", () => {
  it("answers 502 storage_failed for a storage failure and a size that differs from the record, without the path, the bucket or the token in the answer or the log", async () => {
    const { store, mine } = await world();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = createGcsStorage({
      bucket: BUCKET,
      accessToken: async () => TOKEN,
      fetch: (async () => {
        throw new Error(`connect failed ${TOKEN} ${BUCKET} ${mine.info!.objectPath}`);
      }) as unknown as typeof fetch,
    });
    const failed = await snapshot(await get(mine.pageId, deps(ME, store, failing), { range: "bytes=0-1" }));
    expect(failed.status).toBe(502);
    expect(failed.body).toBe('{"error":"storage_failed"}');

    let cancelled = false;
    const wrongSize: ObjectStorage = {
      ...createFakeStorage(),
      readObject: async () => ({
        body: new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
        contentType: "audio/mp4",
        sizeBytes: 7,
      }),
    };
    const mismatch = await snapshot(await get(mine.pageId, deps(ME, store, wrongSize)));
    expect(mismatch.status).toBe(502);
    expect(mismatch.body).toBe('{"error":"storage_failed"}');
    expect(cancelled).toBe(true);

    const visible = JSON.stringify([failed, mismatch, errors.mock.calls]);
    for (const secret of [TOKEN, BUCKET, mine.info!.objectPath, mine.info!.assetId, "googleapis"]) expect(visible).not.toContain(secret);
    expect(errors).toHaveBeenCalledWith("editor-web: object storage failed", { route: "GET /api/pages/[id]/recording/audio", code: "unavailable" });
  });

  it("never puts the object path in a successful answer either", async () => {
    const { storage, store, mine } = await world();
    const ok = await snapshot(await get(mine.pageId, deps(ME, store, storage), { range: "bytes=0-3" }));
    expect(ok.status).toBe(206);
    expect(JSON.stringify(ok.headers)).not.toContain(mine.info!.objectPath);
    expect(JSON.stringify(ok.headers)).not.toContain(mine.info!.assetId);
  });
});
