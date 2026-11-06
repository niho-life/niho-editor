import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageAsset, ImageMetaPatch, SharedImageAsset, StartImageUploadInput, StartImageUploadResult } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { IMAGE_MAX_BYTES, IMAGE_PAGE_MAX_COUNT } from "../image/image-limits";
import { FAKE_STORAGE_PATH, createFakeStorage, type FakeStorage } from "../storage/fake";
import { StorageError, type ObjectStorage } from "../storage/types";
import {
  IMAGE_CACHE_CONTROL,
  IMAGE_START_BODY_MAX_BYTES,
  SHARED_IMAGE_CACHE_CONTROL,
  completeImageRoute,
  deleteImageRoute,
  imageMetadataRoute,
  listImagesRoute,
  readImageRoute,
  sharedImageRoute,
  startImageRoute,
  updateImageRoute,
  type ImageApiDeps,
  type ImageStore,
} from "./images-api";

// 合成のユーザー ID・ページ・ダミーのハッシュだけを使う（実在の人・実際の画像を入れない）

const ORIGIN = "http://editor.test";
const SHA = "d".repeat(64);
const PAGE = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const OTHER_PAGE = "7f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const TOKEN = "s".repeat(43);
const START = { contentType: "image/png", sizeBytes: 5, sha256: SHA };

type Row = { asset: ImageAsset; owner: string; uploadKey: string | null; requestHash: string };

/** メモリの中だけの合成の store（packages/editor-store と同じ約束: 自分の・ゴミ箱でない行だけ、冪等キー、大きさの照合）。 */
function memoryStore(options: { pages?: Record<string, string>; trashed?: readonly string[]; images?: number } = {}) {
  // ページ → owner（既定: PAGE と OTHER_PAGE は user-a のもの）
  const pages: Record<string, string> = options.pages ?? { [PAGE]: "user-a", [OTHER_PAGE]: "user-a" };
  const trashed = new Set(options.trashed ?? []);
  let imageCount = options.images;
  const rows: Row[] = [];
  const starts: Array<{ owner: string; input: StartImageUploadInput }> = [];
  const metas: Array<{ owner: string; assetId: string; patch: ImageMetaPatch }> = [];
  const own = (owner: string, pageId: string) => pages[pageId] === owner && !trashed.has(pageId);
  const find = (owner: string, assetId: string) => rows.find((row) => row.owner === owner && row.asset.assetId === assetId && own(owner, row.asset.pageId)) ?? null;
  const store: ImageStore = {
    startImageUpload: async (owner, input): Promise<StartImageUploadResult> => {
      starts.push({ owner, input });
      const existing = input.uploadKey === null ? undefined : rows.find((row) => row.owner === owner && row.uploadKey === input.uploadKey);
      if (existing) {
        if (!own(owner, existing.asset.pageId) || existing.asset.pageId !== input.pageId || existing.requestHash !== input.requestHash) {
          return { status: "conflict" };
        }
        return { status: "existing", assetId: existing.asset.assetId, objectPath: existing.asset.objectPath, uploadStatus: existing.asset.status };
      }
      if (!own(owner, input.pageId)) return null;
      const asset: ImageAsset = {
        assetId: input.assetId,
        pageId: input.pageId,
        objectPath: `image/${input.assetId}`,
        status: "uploading",
        bytes: input.bytes,
        contentType: input.contentType,
        sha256: input.sha256,
        alt: null,
        credit: null,
        consent: false,
        share: false,
        createdAt: new Date(0).toISOString(),
      };
      rows.push({ asset, owner, uploadKey: input.uploadKey, requestHash: input.requestHash });
      return { status: "created", assetId: asset.assetId, objectPath: asset.objectPath, uploadStatus: "uploading" };
    },
    findImageUploadByKey: async (owner, input): Promise<StartImageUploadResult> => {
      const existing = rows.find((row) => row.owner === owner && row.uploadKey === input.uploadKey);
      if (!existing) return null;
      if (!own(owner, existing.asset.pageId) || existing.asset.pageId !== input.pageId || existing.requestHash !== input.requestHash) return { status: "conflict" };
      return { status: "existing", assetId: existing.asset.assetId, objectPath: existing.asset.objectPath, uploadStatus: existing.asset.status };
    },
    completeImageUpload: async (owner, assetId, stored) => {
      const row = find(owner, assetId);
      if (!row) return null;
      if (row.asset.status === "ready") return { status: "ok", asset: row.asset };
      if (row.asset.bytes !== stored.sizeBytes) return { status: "size_mismatch" };
      row.asset = { ...row.asset, status: "ready" };
      return { status: "ok", asset: row.asset };
    },
    deletePageImage: async (owner, pageId, assetId) => {
      const index = rows.findIndex((row) => row.owner === owner && row.asset.pageId === pageId && row.asset.assetId === assetId && own(owner, pageId));
      if (index < 0) return null;
      rows.splice(index, 1);
      return { coverCleared: false };
    },
    listPageImages: async (owner, pageId) => {
      if (!own(owner, pageId)) return null;
      return rows
        .filter((row) => row.owner === owner && row.asset.pageId === pageId && row.asset.status === "ready")
        .reverse()
        .map(({ asset }) => ({ assetId: asset.assetId, bytes: asset.bytes, contentType: asset.contentType, alt: asset.alt, credit: asset.credit, consent: asset.consent, share: asset.share, createdAt: asset.createdAt }));
    },
    imageAsset: async (owner, assetId) => find(owner, assetId)?.asset ?? null,
    updateImageMeta: async (owner, assetId, patch) => {
      metas.push({ owner, assetId, patch });
      const row = find(owner, assetId);
      if (!row) return null;
      row.asset = {
        ...row.asset,
        alt: patch.alt === undefined ? row.asset.alt : patch.alt === "" ? null : patch.alt,
        credit: patch.credit === undefined ? row.asset.credit : patch.credit === "" ? null : patch.credit,
        consent: patch.consent === undefined ? row.asset.consent : patch.consent,
        share: patch.share === undefined ? row.asset.share : patch.share,
      };
      return row.asset;
    },
    countPageImages: async (owner, pageId) => {
      if (!own(owner, pageId)) return null;
      return imageCount ?? rows.filter((row) => row.asset.pageId === pageId).length;
    },
    sharedImageAsset: async (token, assetId): Promise<SharedImageAsset | null> => {
      if (token !== TOKEN) return null;
      const row = rows.find((item) => item.asset.assetId === assetId);
      // 共有しているページ（PAGE だけ）の、済んだ画像だけ
      if (!row || row.asset.pageId !== PAGE || row.asset.status !== "ready") return null;
      const { objectPath, contentType, bytes, alt, credit } = row.asset;
      return { objectPath, contentType, bytes, alt, credit };
    },
  };
  return { store, rows, starts, metas, setImages: (count: number | undefined) => void (imageCount = count) };
}

/** 画像の API が呼ぶのは getSession だけ。 */
const notUsed = async (): Promise<Response> => {
  throw new Error("the image API never calls the login routes");
};

function authAs(userId: string | null): AuthProvider {
  return { mode: "stub", getSession: async () => (userId ? { userId, mode: "stub" } : null), beginLogin: notUsed, completeLogin: notUsed, logout: notUsed };
}

function deps(userId: string | null, store: ImageStore | null, storage: ObjectStorage | null, extra: Partial<ImageApiDeps> = {}): ImageApiDeps {
  return { auth: () => authAs(userId), store: () => store, storage: () => storage, env: {}, ...extra };
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const sameOrigin: Record<string, string> = method === "GET" ? {} : { origin: ORIGIN };
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { host: "editor.test", ...(body === undefined ? {} : { "content-type": "application/json" }), ...sameOrigin, ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

const start = (body: unknown, d: ImageApiDeps, headers: Record<string, string> = {}, pageId = PAGE) =>
  startImageRoute(request("POST", `/api/pages/${pageId}/images/start`, body, headers), pageId, d);
const complete = (assetId: string, d: ImageApiDeps, headers: Record<string, string> = {}, pageId = PAGE) =>
  completeImageRoute(request("POST", `/api/pages/${pageId}/images/${assetId}/complete`, undefined, headers), pageId, assetId, d);
const remove = (assetId: string, d: ImageApiDeps, headers: Record<string, string> = {}, pageId = PAGE) =>
  deleteImageRoute(request("DELETE", `/api/pages/${pageId}/images/${assetId}`, undefined, headers), pageId, assetId, d);
const list = (d: ImageApiDeps, pageId = PAGE) => listImagesRoute(request("GET", `/api/pages/${pageId}/images`), pageId, d);
const patch = (assetId: string, body: unknown, d: ImageApiDeps, headers: Record<string, string> = {}) =>
  updateImageRoute(request("PATCH", `/api/assets/${assetId}`, body, headers), assetId, d);
const read = (assetId: string, d: ImageApiDeps) => readImageRoute(request("GET", `/api/assets/${assetId}`), assetId, d);
const readMetadata = (assetId: string, d: ImageApiDeps) => imageMetadataRoute(request("GET", `/api/assets/${assetId}/meta`), assetId, d);
const shared = (token: string, assetId: string, d: ImageApiDeps) => sharedImageRoute(request("GET", `/s/${token}/a/${assetId}`), token, assetId, d);

async function snapshot(response: Response) {
  return { status: response.status, headers: [...response.headers.entries()].sort(), body: await response.text() };
}

function tokenOf(url: string): string {
  return url.slice(FAKE_STORAGE_PATH.length);
}

/** 開始して、偽の保存先に bytes 個のバイトを置き、完了まで進めて資産の id を返す。 */
async function upload(storage: FakeStorage, d: ImageApiDeps, bytes = 5, body: object = START) {
  const started = await start(body, d);
  expect(started.status).toBe(201);
  const created = await started.json();
  expect(storage.putFakeObject(tokenOf(created.upload.url), new Uint8Array(bytes), "image/png")).toBe("ok");
  const done = await complete(created.assetId, d);
  expect(done.status).toBe(200);
  return created.assetId as string;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/pages/{id}/images/start", () => {
  it("creates the asset for the signed-in owner and answers 201 with the id and an upload ticket", async () => {
    const { store, starts } = memoryStore();
    const storage = createFakeStorage();
    const startUpload = vi.spyOn(storage, "startUpload");
    const assetId = randomUUID();
    const response = await start(START, deps("user-a", store, storage, { newAssetId: () => assetId }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["assetId", "upload"]);
    expect(body.assetId).toBe(assetId);
    expect(body.upload).toEqual({
      url: expect.stringMatching(/^\/api\/dev\/fake-storage\//),
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      expiresAt: expect.any(String),
      maxBytes: 5,
    });
    expect(startUpload).toHaveBeenCalledWith({ objectPath: `image/${assetId}`, contentType: "image/png", sizeBytes: 5, origin: ORIGIN });
    expect(starts).toHaveLength(1);
    expect(starts[0]!.owner).toBe("user-a");
    expect(starts[0]!.input).toEqual({
      assetId,
      pageId: PAGE,
      contentType: "image/png",
      bytes: 5,
      sha256: SHA,
      uploadKey: null,
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("answers 401, 403, 503 storage_unavailable and 503 unavailable in that order, touching nothing", async () => {
    const { store, starts } = memoryStore();
    const storage = createFakeStorage();
    const startUpload = vi.spyOn(storage, "startUpload");
    expect(await snapshot(await start(START, deps(null, store, storage)))).toMatchObject({ status: 401, body: '{"error":"unauthorized"}' });
    for (const headers of [{ origin: "https://evil.example" }, { origin: "null" }]) {
      expect(await snapshot(await start(START, deps("user-a", store, storage), headers))).toMatchObject({ status: 403, body: '{"error":"forbidden"}' });
    }
    const noOrigin = new Request(`${ORIGIN}/api/pages/${PAGE}/images/start`, {
      method: "POST",
      headers: { host: "editor.test", "content-type": "application/json" },
      body: JSON.stringify(START),
    });
    expect((await startImageRoute(noOrigin, PAGE, deps("user-a", store, storage))).status).toBe(403);
    const off = await start(START, deps("user-a", store, null));
    expect(off.status).toBe(503);
    expect(await off.text()).toBe('{"error":"storage_unavailable"}');
    const noDb = await start(START, deps("user-a", null, storage));
    expect(noDb.status).toBe(503);
    expect(await noDb.text()).toBe('{"error":"unavailable"}');
    expect(startUpload).not.toHaveBeenCalled();
    expect(starts).toHaveLength(0);
  });

  it("answers the same 404 for someone else's page, a page that is not there, a trashed page and an id that is not a UUID", async () => {
    const { store, starts } = memoryStore({ pages: { [PAGE]: "user-b", [OTHER_PAGE]: "user-a" }, trashed: [OTHER_PAGE] });
    const storage = createFakeStorage();
    const startUpload = vi.spyOn(storage, "startUpload");
    const responses = [];
    for (const pageId of [PAGE, OTHER_PAGE, "5f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11", "not-a-uuid", "../etc/passwd"]) {
      responses.push(await snapshot(await start(START, deps("user-a", store, storage), {}, pageId)));
    }
    for (const response of responses) expect(response).toEqual(responses[0]);
    expect(responses[0]).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
    // 保存先にも store にも何も書かない（存在を漏らさない）
    expect(startUpload).not.toHaveBeenCalled();
    expect(starts).toHaveLength(0);
  });

  it("refuses a request over the limits before anything is stored, with a reason", async () => {
    const { store, starts } = memoryStore();
    const storage = createFakeStorage();
    const startUpload = vi.spyOn(storage, "startUpload");
    const cases: Array<[unknown, string, Record<string, string>?]> = [
      ["not json", "body"],
      [[START], "body"],
      [{ ...START, extra: 1 }, "body"],
      [{ contentType: "image/png", sizeBytes: 5 }, "sha256"],
      [START, "idempotency_key", { "idempotency-key": "not-a-uuid" }],
      // 許さない種類（415 相当。SVG は script を持てるので受け付けない）
      [{ ...START, contentType: "image/svg+xml" }, "content_type"],
      [{ ...START, contentType: "text/html" }, "content_type"],
      [{ ...START, sizeBytes: 0 }, "size"],
      [{ ...START, sizeBytes: IMAGE_MAX_BYTES + 1 }, "too_large"],
      [{ ...START, sha256: "x" }, "sha256"],
    ];
    for (const [body, reason, headers] of cases) {
      const response = await start(body, deps("user-a", store, storage), headers);
      expect(response.status, reason).toBe(400);
      expect(await response.text()).toBe(JSON.stringify({ error: "bad_request", reason }));
    }
    const wrongType = await startImageRoute(
      new Request(`${ORIGIN}/api/pages/${PAGE}/images/start`, {
        method: "POST",
        headers: { host: "editor.test", origin: ORIGIN, "content-type": "text/plain" },
        body: JSON.stringify(START),
      }),
      PAGE,
      deps("user-a", store, storage),
    );
    expect(await wrongType.text()).toBe('{"error":"bad_request","reason":"body"}');
    expect(startUpload).not.toHaveBeenCalled();
    expect(starts).toHaveLength(0);
  });

  it("refuses the page's 101st image before storing anything", async () => {
    const { store, starts } = memoryStore({ images: IMAGE_PAGE_MAX_COUNT });
    const storage = createFakeStorage();
    const startUpload = vi.spyOn(storage, "startUpload");
    const response = await start(START, deps("user-a", store, storage));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('{"error":"bad_request","reason":"too_many"}');
    expect(startUpload).not.toHaveBeenCalled();
    expect(starts).toHaveLength(0);
    // 上限の 1 つ下までは入る
    const room = memoryStore({ images: IMAGE_PAGE_MAX_COUNT - 1 });
    expect((await start(START, deps("user-a", room.store, storage))).status).toBe(201);
  });

  it("at the limit, a retry with the same Idempotency-Key still gets the asset it made; a new asset is still refused", async () => {
    const { store, setImages } = memoryStore({ images: IMAGE_PAGE_MAX_COUNT - 1 });
    const storage = createFakeStorage();
    const key = { "idempotency-key": "11111111-1111-4111-8111-111111111111" };
    // 最後の 1 枚（応答が届かなかったとする）
    const first = await start(START, deps("user-a", store, storage), key);
    expect(first.status).toBe(201);
    const { assetId } = (await first.json()) as { assetId: string };
    setImages(IMAGE_PAGE_MAX_COUNT);
    // 同じキー・同じ内容の再送は、上限に達していても、先の資産と、アップロード中なので ticket を返す
    const again = await start(START, deps("user-a", store, storage), key);
    expect(again.status).toBe(200);
    const body = (await again.json()) as { assetId: string; upload: { url: string } | null };
    expect(body.assetId).toBe(assetId);
    expect(body.upload?.url).toBeTruthy();
    // キーが無い・初めてのキー・同じキーで内容が違う（資産を作らない）
    expect((await start(START, deps("user-a", store, storage))).status).toBe(400);
    expect((await start(START, deps("user-a", store, storage), { "idempotency-key": "22222222-2222-4222-8222-222222222222" })).status).toBe(400);
    const other = await start({ ...START, sizeBytes: 6 }, deps("user-a", store, storage), key);
    expect(other.status).toBe(409);
    expect(await other.text()).toContain("idempotency_conflict");
  });

  it("answers 413 to a body over the limit, declared or streamed", async () => {
    const { store, starts } = memoryStore();
    const storage = createFakeStorage();
    const huge = JSON.stringify({ ...START, sha256: SHA, contentType: `image/${"p".repeat(IMAGE_START_BODY_MAX_BYTES)}` });
    const declared = await start(huge, deps("user-a", store, storage));
    expect(declared.status).toBe(413);
    expect(await declared.text()).toBe('{"error":"payload_too_large"}');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(huge));
        controller.close();
      },
    });
    const streamed = await startImageRoute(
      new Request(`${ORIGIN}/api/pages/${PAGE}/images/start`, {
        method: "POST",
        headers: { host: "editor.test", origin: ORIGIN, "content-type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit),
      PAGE,
      deps("user-a", store, storage),
    );
    expect(streamed.status).toBe(413);
    expect(starts).toHaveLength(0);
  });

  it("answers 502 storage_failed when the storage fails, writes nothing, and logs only the route and the code", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const code of ["unavailable", "rejected"] as const) {
      const { store, starts } = memoryStore();
      const storage: ObjectStorage = {
        kind: "gcs",
        startUpload: async () => {
          throw new StorageError(code);
        },
        stat: async () => null,
        readObject: async () => null,
      };
      const response = await start(START, deps("user-a", store, storage));
      expect(response.status).toBe(502);
      expect(await response.text()).toBe('{"error":"storage_failed"}');
      expect(starts).toHaveLength(0);
    }
    for (const call of errors.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("bucket");
      expect(call[1]).toEqual({ route: "POST /api/pages/[id]/images/start", code: expect.any(String) });
    }
  });

  it("is idempotent for the same key and the same content, and 409 for the same key with other content", async () => {
    const { store, starts } = memoryStore();
    const storage = createFakeStorage();
    const key = randomUUID();
    const first = await start(START, deps("user-a", store, storage), { "idempotency-key": key });
    expect(first.status).toBe(201);
    const created = await first.json();
    // 同じキー・同じ内容: 200 で同じ資産。まだアップロード中なので ticket を作り直す
    const again = await start(START, deps("user-a", store, storage), { "idempotency-key": key });
    expect(again.status).toBe(200);
    const repeat = await again.json();
    expect(repeat.assetId).toBe(created.assetId);
    expect(repeat.upload.url).not.toBe(created.upload.url);
    expect(repeat.upload.maxBytes).toBe(5);
    // 済んでいれば upload は null
    expect(storage.putFakeObject(tokenOf(repeat.upload.url), new Uint8Array(5), "image/png")).toBe("ok");
    expect((await complete(created.assetId, deps("user-a", store, storage))).status).toBe(200);
    const third = await start(START, deps("user-a", store, storage), { "idempotency-key": key });
    expect(third.status).toBe(200);
    expect(await third.json()).toEqual({ assetId: created.assetId, upload: null });
    // 同じキーで内容が違う
    const conflict = await start({ ...START, sizeBytes: 6 }, deps("user-a", store, storage), { "idempotency-key": key });
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).toBe('{"error":"idempotency_conflict"}');
    // 作られた資産は 1 つだけ
    expect(starts.filter((item) => item.input.uploadKey === key)).toHaveLength(4);
  });
});

describe("POST /api/pages/{id}/images/{assetId}/complete", () => {
  it("marks the upload ready once, and stays 200 when called again", async () => {
    const { store } = memoryStore();
    const storage = createFakeStorage();
    const d = deps("user-a", store, storage);
    const assetId = await upload(storage, d);
    const response = await complete(assetId, d);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.image).toEqual({ assetId, pageId: PAGE, status: "ready", bytes: 5, contentType: "image/png", alt: null, credit: null, consent: false, share: false });
    // object の場所・sha256 は応答に出さない
    expect(JSON.stringify(body)).not.toContain("image/" + assetId);
    expect(JSON.stringify(body)).not.toContain(SHA);
  });

  it("answers 409 incomplete when the object is missing or a different size, and writes nothing", async () => {
    const { store, rows } = memoryStore();
    const storage = createFakeStorage();
    const d = deps("user-a", store, storage);
    const started = await (await start(START, d)).json();
    const missing = await complete(started.assetId, d);
    expect(missing.status).toBe(409);
    expect(await missing.text()).toBe('{"error":"incomplete","reason":"missing"}');
    // 申告（5）と違う大きさを置いた
    expect(storage.putFakeObject(tokenOf(started.upload.url), new Uint8Array(4), "image/png")).toBe("ok");
    const mismatch = await complete(started.assetId, d);
    expect(mismatch.status).toBe(409);
    expect(await mismatch.text()).toBe('{"error":"incomplete","reason":"size_mismatch"}');
    expect(rows[0]!.asset.status).toBe("uploading");
  });

  it("answers the same 404 for someone else's asset, another page's asset and ids that are not UUIDs", async () => {
    const { store } = memoryStore();
    const storage = createFakeStorage();
    const mine = deps("user-a", store, storage);
    const assetId = await upload(storage, mine);
    const responses = [
      // 別の人
      await snapshot(await complete(assetId, deps("user-b", store, storage))),
      // 同じ人の別のページの path で
      await snapshot(await complete(assetId, mine, {}, OTHER_PAGE)),
      // 無い資産・不正な id
      await snapshot(await complete("5f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11", mine)),
      await snapshot(await complete("not-a-uuid", mine)),
    ];
    for (const response of responses) expect(response).toEqual(responses[0]);
    expect(responses[0]).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
  });

  it("answers 401 and 403 before looking anything up", async () => {
    const { store } = memoryStore();
    const storage = createFakeStorage();
    const assetId = await upload(storage, deps("user-a", store, storage));
    const lookup = vi.spyOn(store, "imageAsset");
    expect((await complete(assetId, deps(null, store, storage))).status).toBe(401);
    expect((await complete(assetId, deps("user-a", store, storage), { origin: "https://evil.example" })).status).toBe(403);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/pages/{id}/images/{assetId}", () => {
  it("releases only the authenticated owner's unfinished image", async () => {
    const storage = createFakeStorage();
    const memory = memoryStore();
    const owner = deps("user-a", memory.store, storage);
    const created = await (await start(START, owner)).json();
    const assetId = created.assetId as string;
    expect((await remove(assetId, deps(null, memory.store, storage))).status).toBe(401);
    expect((await remove(assetId, deps("user-b", memory.store, storage))).status).toBe(404);
    expect((await remove(assetId, owner, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await remove(assetId, owner)).status).toBe(204);
    expect((await remove(assetId, owner)).status).toBe(404);
    expect((await complete(assetId, owner)).status).toBe(404);
  });

  it("removes a finished photo from the page's panel, only through its own page, and answers the same 404 otherwise", async () => {
    const storage = createFakeStorage();
    const memory = memoryStore();
    const owner = deps("user-a", memory.store, storage);
    const assetId = await upload(storage, owner);
    const removal = vi.spyOn(memory.store, "deletePageImage");
    expect((await remove(assetId, deps(null, memory.store, storage))).status).toBe(401);
    expect((await remove(assetId, owner, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect(removal).not.toHaveBeenCalled();
    const notFound = await snapshot(await remove(assetId, owner, {}, OTHER_PAGE));
    expect(notFound.status).toBe(404);
    expect(await snapshot(await remove(randomUUID(), owner))).toEqual(notFound);
    expect(await snapshot(await remove("not-a-uuid", owner))).toEqual(notFound);
    const removed = await remove(assetId, owner);
    expect(removed.status).toBe(204);
    expect(removed.headers.get("cache-control")).toBe("private, no-store");
    expect(await (await list(owner)).json()).toEqual({ images: [] });
    expect((await read(assetId, owner)).status).toBe(404);
  });
});

describe("GET /api/pages/{id}/images", () => {
  it("lists the page's finished photos newest first with only the public fields", async () => {
    const storage = createFakeStorage();
    const memory = memoryStore();
    const owner = deps("user-a", memory.store, storage);
    const first = await upload(storage, owner);
    const second = await upload(storage, owner);
    // アップロード中のものは出さない
    await start(START, owner);
    const response = await list(owner);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.images.map((image: { assetId: string }) => image.assetId)).toEqual([second, first]);
    expect(Object.keys(body.images[0]).sort()).toEqual(["alt", "assetId", "bytes", "consent", "contentType", "createdAt", "credit", "share"]);
  });

  it("answers 401 without looking, and the same 404 for someone else's, a missing and a malformed page", async () => {
    const storage = createFakeStorage();
    const memory = memoryStore();
    const lookup = vi.spyOn(memory.store, "listPageImages");
    expect((await list(deps(null, memory.store, storage))).status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
    const notFound = await snapshot(await list(deps("user-b", memory.store, storage)));
    expect(notFound.status).toBe(404);
    expect(await snapshot(await list(deps("user-a", memory.store, storage), randomUUID()))).toEqual(notFound);
    expect(await snapshot(await list(deps("user-a", memory.store, storage), "not-a-uuid"))).toEqual(notFound);
    expect((await list(deps("user-a", null, storage))).status).toBe(503);
  });
});

describe("PATCH /api/assets/{assetId}", () => {
  it("saves alt, credit and consent, and empties a field with null", async () => {
    const { store, metas } = memoryStore();
    const storage = createFakeStorage();
    const d = deps("user-a", store, storage);
    const assetId = await upload(storage, d);
    const response = await patch(assetId, { alt: "合成の写真", credit: "合成の提供元", consent: true }, d);
    expect(response.status).toBe(200);
    expect((await response.json()).image).toMatchObject({ assetId, alt: "合成の写真", credit: "合成の提供元", consent: true });
    const cleared = await patch(assetId, { alt: null, consent: false }, d);
    expect((await cleared.json()).image).toMatchObject({ alt: null, credit: "合成の提供元", consent: false });
    // 指定した欄だけを渡す
    expect(metas.map((meta) => meta.patch)).toEqual([{ alt: "合成の写真", credit: "合成の提供元", consent: true }, { alt: null, consent: false }]);
  });

  it("saves the share-image permission as its own field, apart from consent", async () => {
    const { store, metas } = memoryStore();
    const storage = createFakeStorage();
    const d = deps("user-a", store, storage);
    const assetId = await upload(storage, d);
    await patch(assetId, { consent: true }, d);
    const shared = await patch(assetId, { share: true }, d);
    expect(shared.status).toBe(200);
    expect((await shared.json()).image).toMatchObject({ assetId, consent: true, share: true });
    const off = await patch(assetId, { share: false }, d);
    expect((await off.json()).image).toMatchObject({ consent: true, share: false });
    expect(metas.map((meta) => meta.patch)).toEqual([{ consent: true }, { share: true }, { share: false }]);
  });

  it("refuses a body that is not the three fields, a long or multi-line value, and a non-boolean consent", async () => {
    const { store } = memoryStore();
    const storage = createFakeStorage();
    const d = deps("user-a", store, storage);
    const assetId = await upload(storage, d);
    const cases: Array<[unknown, string]> = [
      [{}, "body"],
      [{ title: "x" }, "body"],
      ["not json", "body"],
      [{ alt: "a".repeat(1001) }, "alt"],
      [{ alt: "一行目\n二行目" }, "alt"],
      [{ alt: 1 }, "alt"],
      [{ credit: "c".repeat(501) }, "credit"],
      [{ credit: "改行 入り" }, "credit"],
      [{ consent: "true" }, "consent"],
      [{ share: "true" }, "share"],
      [{ share: null }, "share"],
    ];
    for (const [body, reason] of cases) {
      const response = await patch(assetId, body, d);
      expect(response.status, reason).toBe(400);
      expect(await response.text()).toBe(JSON.stringify({ error: "bad_request", reason }));
    }
  });

  it("answers 401, 403 and the same 404 for someone else's asset", async () => {
    const { store } = memoryStore();
    const storage = createFakeStorage();
    const d = deps("user-a", store, storage);
    const assetId = await upload(storage, d);
    expect((await patch(assetId, { consent: true }, deps(null, store, storage))).status).toBe(401);
    expect((await patch(assetId, { consent: true }, d, { origin: "https://evil.example" })).status).toBe(403);
    const responses = [
      await snapshot(await patch(assetId, { consent: true }, deps("user-b", store, storage))),
      await snapshot(await patch("5f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11", { consent: true }, d)),
      await snapshot(await patch("not-a-uuid", { consent: true }, d)),
    ];
    for (const response of responses) expect(response).toEqual(responses[0]);
    expect(responses[0]).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
  });
});

describe("GET /api/assets/{assetId}", () => {
  it("relays the bytes to the owner with the stored type, nosniff and a private cache", async () => {
    const { store } = memoryStore();
    const storage = createFakeStorage();
    const d = deps("user-a", store, storage);
    const assetId = await upload(storage, d);
    const response = await read(assetId, d);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe("5");
    expect(response.headers.get("cache-control")).toBe(IMAGE_CACHE_CONTROL);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(5));
    // 署名付き URL・保存先の場所は応答の header に出さない
    expect([...response.headers.keys()].sort()).toEqual(["cache-control", "content-disposition", "content-length", "content-type", "x-content-type-options", "x-robots-tag"]);
  });

  it("answers 401 without looking, and the same 404 for someone else's, an unfinished, a missing and a malformed asset", async () => {
    const { store } = memoryStore();
    const storage = createFakeStorage();
    const d = deps("user-a", store, storage);
    const ready = await upload(storage, d);
    const unfinished = (await (await start(START, d)).json()).assetId as string;
    expect((await read(ready, deps(null, store, storage))).status).toBe(401);
    const responses = [
      await snapshot(await read(ready, deps("user-b", store, storage))),
      await snapshot(await read(unfinished, d)),
      await snapshot(await read("5f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11", d)),
      await snapshot(await read("not-a-uuid", d)),
    ];
    for (const response of responses) expect(response).toEqual(responses[0]);
    expect(responses[0]).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
  });

  it("answers 404 when the row is there but the object is gone, and 502 when the storage fails", async () => {
    const { store } = memoryStore();
    const storage = createFakeStorage();
    const d = deps("user-a", store, storage);
    const assetId = await upload(storage, d);
    vi.spyOn(storage, "readObject").mockResolvedValue(null);
    expect((await read(assetId, d)).status).toBe(404);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(storage, "readObject").mockRejectedValue(new StorageError("unavailable"));
    const failed = await read(assetId, d);
    expect(failed.status).toBe(502);
    expect(await failed.text()).toBe('{"error":"storage_failed"}');
  });

  it("never serves a type outside the five image types", async () => {
    const { store, rows } = memoryStore();
    const storage = createFakeStorage();
    const d = deps("user-a", store, storage);
    const assetId = await upload(storage, d);
    // 行の値が受け付けない種類になっていても、中身を推測させない
    rows[0]!.asset = { ...rows[0]!.asset, contentType: "text/html" };
    const response = await read(assetId, d);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("GET /api/assets/{assetId}/meta", () => {
  it("returns only the authenticated owner's image metadata", async () => {
    const { store } = memoryStore();
    const storage = createFakeStorage();
    const d = deps("user-a", store, storage);
    const assetId = await upload(storage, d);
    await patch(assetId, { consent: true }, d);
    const response = await readMetadata(assetId, d);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      image: { assetId, pageId: PAGE, status: "ready", bytes: 5, contentType: "image/png", alt: null, credit: null, consent: true, share: false },
    });
    expect((await readMetadata(assetId, deps(null, store, storage))).status).toBe(401);
    expect((await readMetadata(assetId, deps("user-b", store, storage))).status).toBe(404);
  });
});

describe("GET /s/{token}/a/{assetId}", () => {
  it("relays the image of a shared page without a session, with the share's no-store cache", async () => {
    const { store } = memoryStore();
    const storage = createFakeStorage();
    const owner = deps("user-a", store, storage);
    const assetId = await upload(storage, owner);
    const anonymous = deps(null, store, storage);
    const response = await shared(TOKEN, assetId, anonymous);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe(SHARED_IMAGE_CACHE_CONTROL);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(5));
  });

  it("answers the same 404 for another token, another page's image, an unfinished image and ids that are not UUIDs", async () => {
    const { store } = memoryStore();
    const storage = createFakeStorage();
    const owner = deps("user-a", store, storage);
    const assetId = await upload(storage, owner);
    const other = await upload(storage, owner, 5, START);
    // 共有していないページの画像（memoryStore の sharedImageAsset は PAGE だけを共有している）
    const otherPage = (await (await start(START, owner, {}, OTHER_PAGE)).json()).assetId as string;
    const anonymous = deps(null, store, storage);
    const responses = [
      await snapshot(await shared("x".repeat(43), assetId, anonymous)),
      await snapshot(await shared(TOKEN, otherPage, anonymous)),
      await snapshot(await shared(TOKEN, "5f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11", anonymous)),
      await snapshot(await shared(TOKEN, "not-a-uuid", anonymous)),
    ];
    for (const response of responses) expect(response).toEqual(responses[0]);
    expect(responses[0]).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
    // 共有しているページの済んだ画像は読める
    expect((await shared(TOKEN, other, anonymous)).status).toBe(200);
  });
});
