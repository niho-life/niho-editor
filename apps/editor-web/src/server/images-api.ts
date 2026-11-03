import { createHash, randomUUID } from "node:crypto";
import {
  imageObjectPath,
  type CompleteImageUploadResult,
  type ImageAsset,
  type ImageMetaPatch,
  type OwnerId,
  type SharedImageAsset,
  type StartImageUploadInput,
  type StartImageUploadResult,
} from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import {
  IMAGE_CONTENT_TYPES,
  IMAGE_PAGE_MAX_COUNT,
  imageRequestCanonical,
  validateImageStart,
  type ImageStart,
  type ImageStartRejection,
} from "../image/image-limits";
import { StorageError, type ObjectStorage, type ReadObject, type StoredObject, type UploadTicket } from "../storage/types";
import { ROBOTS_HEADER_VALUE, errorResponse, expectedOrigin, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";

/**
 * 本文の画像（#33）の API: 開始・完了・欄の保存・中身の中継。作法は音声の API（audio-api.ts）と同じで、画像はその鏡写し。
 *
 * - 開始: 要求を検査し（種類・大きさ・1 ページの枚数の上限を超えたら保存の前に断る）、保存先のアップロードのセッションを作ってから、
 *   資産の行（kind = 'image'・状態 uploading・掲載許諾 false）を作る。ブラウザは返した ticket の url へ直接 PUT する
 *   （サーバーは画像を受け取らない）。
 * - 完了: 保存先にある object の実寸を確認して ready にする。
 * - 中継: `GET /api/assets/{id}`（本人）と `GET /s/{token}/a/{id}`（共有リンク）が object の中身を流す。**署名付き URL は
 *   ブラウザへ渡さない**ので、CSP は `img-src 'self'` のままでよい（src/security/csp.ts は変えない）。
 *
 * 本人の・ゴミ箱でないページ（の画像）だけ、未認証 401、更新系は同じ origin からだけ（403）、別の人・存在しない・不正な id・
 * 削除済み・画像でない資産・まだ済んでいない画像は同じ 404。エラーの本文は短い code と理由だけ。
 * ticket の url・bucket 名・object の場所・token は、ログにもエラーの本文にも応答にも出さない。
 * sha256・content type はクライアントの申告（サーバーは中身を読まず、sha256 を検証しない）。大きさは完了時の実寸。
 */

/** 画像の API が使う store の操作（packages/editor-store の関数に Pool を渡したもの）。 */
export type ImageStore = {
  startImageUpload: (owner: OwnerId, input: StartImageUploadInput) => Promise<StartImageUploadResult>;
  completeImageUpload: (owner: OwnerId, assetId: string, stored: { sizeBytes: number }) => Promise<CompleteImageUploadResult>;
  cancelImageUpload: (owner: OwnerId, pageId: string, assetId: string) => Promise<boolean>;
  imageAsset: (owner: OwnerId, assetId: string) => Promise<ImageAsset | null>;
  updateImageMeta: (owner: OwnerId, assetId: string, patch: ImageMetaPatch) => Promise<ImageAsset | null>;
  countPageImages: (owner: OwnerId, pageId: string) => Promise<number | null>;
  /** 同じキーの資産が既にあるか（枚数の上限の判定の前に、冪等な再送を見分ける。何も書かない）。 */
  findImageUploadByKey: (owner: OwnerId, input: { uploadKey: string; pageId: string; requestHash: string }) => Promise<StartImageUploadResult>;
  /** 共有リンクの読み取り（認証なし。token で絞る）。 */
  sharedImageAsset: (token: string, assetId: string) => Promise<SharedImageAsset | null>;
};

export type ImageApiDeps = {
  auth: () => AuthProvider;
  /** DB が使えないときは null（503 unavailable）。 */
  store: () => ImageStore | null;
  /** 保存先が使えないときは null（503 storage_unavailable）。 */
  storage: () => ObjectStorage | null;
  env?: Readonly<Record<string, string | undefined>>;
  /** 資産の id を作る（テストで差し替える）。 */
  newAssetId?: () => string;
};

/** 開始の要求の本文の上限（種類・大きさ・ハッシュだけなので小さい）。超えたら 413。 */
export const IMAGE_START_BODY_MAX_BYTES = 4 * 1024;
/** 欄の保存の要求の本文の上限（alt 1000 文字・クレジット 500 文字が入る大きさ）。 */
export const IMAGE_META_BODY_MAX_BYTES = 16 * 1024;

/** 中継の応答の cache（本人の画像。object は上書きしないので長めに持たせる）。 */
export const IMAGE_CACHE_CONTROL = "private, max-age=86400, immutable";
/** 共有リンクの画像の cache（共有の停止・作り直しがすぐ効くよう、`/s/{token}` の方針と同じ）。 */
export const SHARED_IMAGE_CACHE_CONTROL = "private, no-store";

const START_KEYS = ["contentType", "sizeBytes", "sha256"] as const;
const META_KEYS = ["alt", "credit", "consent"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** alt・クレジットは 1 行の値（制御文字を入れない。DB の CHECK と store の検査に合わせる）。 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const ALT_MAX_CHARS = 1000;
const CREDIT_MAX_CHARS = 500;

export type ImageBadRequestReason = "body" | "idempotency_key" | "too_many" | "alt" | "credit" | "consent" | ImageStartRejection;

type ImageErrorCode = "storage_unavailable" | "storage_failed" | "idempotency_conflict" | "incomplete";

const IMAGE_STATUS: Record<ImageErrorCode, number> = {
  // 保存先を使わない設定（off・本番の fake・設定の誤り）
  storage_unavailable: 503,
  // 保存先が失敗した・断った（中身は出さない）
  storage_failed: 502,
  // 同じ Idempotency-Key で内容の違う要求（またはそのキーの資産のページがゴミ箱にある）
  idempotency_conflict: 409,
  // 完了を呼んだが、保存先に object が無い（missing）か大きさが申告と違う（size_mismatch）
  incomplete: 409,
};

/** http.ts に無い画像の code。header は他の応答と同じ（jsonResponse）。 */
function imageError(code: ImageErrorCode, reason?: "missing" | "size_mismatch"): Response {
  return jsonResponse(IMAGE_STATUS[code], reason ? { error: code, reason } : { error: code });
}

function badRequest(reason: ImageBadRequestReason): Response {
  return jsonResponse(400, { error: "bad_request", reason });
}

/**
 * 想定外の失敗は 500 の汎用エラー（内部の情報は応答に出さず、ログにも名前と code だけを書く。URL・token・場所を出さない）。
 * audio-api.ts の guarded と同じ。保存先の失敗（StorageError）は 502 storage_failed。
 */
async function guarded(route: string, handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof StorageError) {
      console.error("editor-web: object storage failed", { route, code: error.code });
      return imageError("storage_failed");
    }
    const name = error instanceof Error ? error.name : "unknown";
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
    console.error("editor-web: request failed", { route, name, code });
    return errorResponse("internal");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 開始の要求の正規化した内容の SHA-256（冪等キーの比較用）。 */
export function imageRequestHash(pageId: string, start: ImageStart): string {
  return createHash("sha256").update(imageRequestCanonical(pageId, start), "utf8").digest("hex");
}

/** 応答に載せる ticket（決まった項目だけ）。maxBytes は申告の大きさ（保存先はこれを超える PUT を断る。完了で一致を確かめる）。 */
function uploadBody(ticket: UploadTicket, sizeBytes: number) {
  return { url: ticket.url, method: ticket.method, headers: { ...ticket.headers }, expiresAt: ticket.expiresAt, maxBytes: sizeBytes };
}

/** ブラウザに返す画像の資産（object の場所・sha256・owner は出さない）。 */
function publicImage(asset: ImageAsset) {
  return {
    assetId: asset.assetId,
    pageId: asset.pageId,
    status: asset.status,
    bytes: asset.bytes,
    contentType: asset.contentType,
    alt: asset.alt,
    credit: asset.credit,
    consent: asset.consent,
  };
}

/** 中継で返す種類（開始で受け付けた種類だけ。それ以外は中身を推測させない octet-stream）。 */
function servedContentType(contentType: string | null): string {
  return contentType !== null && IMAGE_CONTENT_TYPES.includes(contentType) ? contentType : "application/octet-stream";
}

/**
 * object の中身の応答。`X-Content-Type-Options: nosniff` で種類を推測させず、`Content-Length` は保存先で見た大きさ。
 * 本文は保存先の流れをそのまま渡す（サーバーはメモリに溜めない）。
 */
function objectResponse(read: ReadObject, contentType: string, cacheControl: string): Response {
  return new Response(read.body, {
    status: 200,
    headers: {
      "Content-Type": servedContentType(contentType),
      "Content-Length": String(read.sizeBytes),
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": ROBOTS_HEADER_VALUE,
      // 中身を今の画面の外で開かせない（画像以外が入っていてもブラウザに文書として描かせない）
      "Content-Disposition": "inline",
    },
  });
}

/**
 * POST /api/pages/{id}/images/start — 画像のアップロードを始める。
 * 201 `{ assetId, upload }`。同じ Idempotency-Key・同じ内容の再送は 200 で同じ資産（uploading なら ticket を作り直す。
 * ready なら upload: null）。同じキーで内容が違えば 409 idempotency_conflict。
 */
export function startImageRoute(request: Request, pageId: string, deps: ImageApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/images/start", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const storage = deps.storage();
    if (!storage) return imageError("storage_unavailable");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");

    const body = await readJsonBody(request, IMAGE_START_BODY_MAX_BYTES);
    if (!body.ok) return body.response.status === 400 ? badRequest("body") : body.response;
    const value = body.value;
    if (!isPlainObject(value) || !Object.keys(value).every((key) => (START_KEYS as readonly string[]).includes(key))) return badRequest("body");
    const rawKey = request.headers.get("idempotency-key");
    if (rawKey !== null && !UUID.test(rawKey.trim())) return badRequest("idempotency_key");
    const uploadKey = rawKey === null ? null : rawKey.trim().toLowerCase();

    const checked = validateImageStart({ contentType: value.contentType, sizeBytes: value.sizeBytes, sha256: value.sha256 });
    if (!checked.ok) return badRequest(checked.reason);
    const start = checked.value;

    // Early rejection keeps the storage ticket count low. The store repeats this check under the page lock.
    const images = await store.countPageImages(session.userId, pageId);
    if (images === null) return notFoundResponse();
    if (images >= IMAGE_PAGE_MAX_COUNT) {
      const existing = uploadKey === null ? null : await store.findImageUploadByKey(session.userId, { uploadKey, pageId, requestHash: imageRequestHash(pageId, start) });
      if (existing === null) return badRequest("too_many");
    }

    const assetId = (deps.newAssetId ?? randomUUID)();
    const origin = expectedOrigin(request, deps.env);
    // 先に保存先のセッションを作る（失敗したら何も書かない。作ったまま使われないセッションは object を作らない）
    const ticket = await storage.startUpload({ objectPath: imageObjectPath(assetId), contentType: start.contentType, sizeBytes: start.sizeBytes, origin });
    // owner は認証の層の本人だけ（要求の値からは決めない）
    const started = await store.startImageUpload(session.userId, {
      assetId,
      pageId,
      contentType: start.contentType,
      bytes: start.sizeBytes,
      sha256: start.sha256,
      uploadKey,
      requestHash: imageRequestHash(pageId, start),
    });
    if (started === null) return notFoundResponse();
    if (started.status === "conflict") return imageError("idempotency_conflict");
    if (started.status === "too_many") return badRequest("too_many");
    if (started.status === "page_full") return errorResponse("page_full");
    if (started.status === "created") {
      return jsonResponse(201, { assetId: started.assetId, upload: uploadBody(ticket, start.sizeBytes) });
    }
    // 同じキー・同じ内容の再送: 先に作った資産を返す。まだアップロード中なら、その資産の場所に ticket を作り直す
    let upload: ReturnType<typeof uploadBody> | null = null;
    if (started.uploadStatus === "uploading") {
      const again = await storage.startUpload({ objectPath: started.objectPath, contentType: start.contentType, sizeBytes: start.sizeBytes, origin });
      upload = uploadBody(again, start.sizeBytes);
    }
    return jsonResponse(200, { assetId: started.assetId, upload });
  });
}

/**
 * POST /api/pages/{id}/images/{assetId}/complete — 保存先の実寸を確定して ready にする。
 * 200 `{ image }`。済んでいればそのまま 200。object が無い・画像上限外は 409 incomplete。
 */
export function completeImageRoute(request: Request, pageId: string, assetId: string, deps: ImageApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/images/[assetId]/complete", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const storage = deps.storage();
    if (!storage) return imageError("storage_unavailable");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");

    const asset = await store.imageAsset(session.userId, assetId);
    // 別のページの資産を、そのページの path から完了できないようにする（どちらも同じ 404）
    if (!asset || asset.pageId !== pageId) return notFoundResponse();
    // 済んだものは保存先に問い合わせない
    if (asset.status === "ready") return jsonResponse(200, { image: publicImage(asset) });
    const stored: StoredObject | null = await storage.stat(asset.objectPath);
    if (!stored) return imageError("incomplete", "missing");
    const result = await store.completeImageUpload(session.userId, assetId, { sizeBytes: stored.sizeBytes });
    if (!result) return notFoundResponse();
    if (result.status === "size_mismatch") return imageError("incomplete", "size_mismatch");
    if (result.status === "page_full") return errorResponse("page_full");
    return jsonResponse(200, { image: publicImage(result.asset) });
  });
}

/** Stop an unfinished upload and release its reservation. A signed ticket may outlive this row;
 * the storage object, if uploaded later, is not deleted by this API. */
export function cancelImageRoute(request: Request, pageId: string, assetId: string, deps: ImageApiDeps): Promise<Response> {
  return guarded("DELETE /api/pages/[id]/images/[assetId]", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    if (!(await store.cancelImageUpload(session.userId, pageId, assetId))) return notFoundResponse();
    return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": ROBOTS_HEADER_VALUE } });
  });
}

type MetaResult = { ok: true; patch: ImageMetaPatch } | { ok: false; reason: ImageBadRequestReason };

/** 欄の要求の検査（指定した欄だけを変える。alt・クレジットは 1 行の文字、null は空にする）。 */
function readMetaPatch(value: unknown): MetaResult {
  if (!isPlainObject(value) || !Object.keys(value).every((key) => (META_KEYS as readonly string[]).includes(key))) return { ok: false, reason: "body" };
  if (Object.keys(value).length === 0) return { ok: false, reason: "body" };
  const patch: ImageMetaPatch = {};
  for (const [key, max] of [
    ["alt", ALT_MAX_CHARS],
    ["credit", CREDIT_MAX_CHARS],
  ] as const) {
    if (!(key in value)) continue;
    const raw = value[key];
    if (raw === null) {
      patch[key] = null;
      continue;
    }
    if (typeof raw !== "string" || raw.includes("\u0000") || CONTROL_CHARACTERS.test(raw) || Array.from(raw).length > max) {
      return { ok: false, reason: key };
    }
    patch[key] = raw;
  }
  if ("consent" in value) {
    if (typeof value.consent !== "boolean") return { ok: false, reason: "consent" };
    patch.consent = value.consent;
  }
  return { ok: true, patch };
}

/**
 * PATCH /api/assets/{assetId} — alt・クレジット・掲載許諾を直す（指定したものだけ）。200 `{ image }`。
 * 本文（AST）にも同じ値が入るが、正本はこの行（共有リンクの描画はこの行から読む）。
 */
export function updateImageRoute(request: Request, assetId: string, deps: ImageApiDeps): Promise<Response> {
  return guarded("PATCH /api/assets/[assetId]", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");

    const body = await readJsonBody(request, IMAGE_META_BODY_MAX_BYTES);
    if (!body.ok) return body.response.status === 400 ? badRequest("body") : body.response;
    const checked = readMetaPatch(body.value);
    if (!checked.ok) return badRequest(checked.reason);

    const updated = await store.updateImageMeta(session.userId, assetId, checked.patch);
    if (!updated) return notFoundResponse();
    return jsonResponse(200, { image: publicImage(updated) });
  });
}

/** GET /api/assets/{assetId}/meta — 本人の画像の掲載メタデータ（本文は別 endpoint）。 */
export function imageMetadataRoute(request: Request, assetId: string, deps: ImageApiDeps): Promise<Response> {
  return guarded("GET /api/assets/[assetId]/meta", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const image = await store.imageAsset(session.userId, assetId);
    if (!image) return notFoundResponse();
    return jsonResponse(200, { image: publicImage(image) });
  });
}

/**
 * GET /api/assets/{assetId} — 画像の中身の中継（本人だけ）。
 * まだ済んでいない（uploading）画像・保存先に object が無い画像は、他の 404 と同じ応答。
 */
export function readImageRoute(request: Request, assetId: string, deps: ImageApiDeps): Promise<Response> {
  return guarded("GET /api/assets/[assetId]", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const storage = deps.storage();
    if (!storage) return imageError("storage_unavailable");

    const asset = await store.imageAsset(session.userId, assetId);
    if (!asset || asset.status !== "ready") return notFoundResponse();
    const read = await storage.readObject(asset.objectPath);
    if (!read) return notFoundResponse();
    return objectResponse(read, asset.contentType, IMAGE_CACHE_CONTROL);
  });
}

/**
 * GET /s/{token}/a/{assetId} — 共有リンクのページの画像（ログイン不要）。
 * 形の違う token・共有していない・止めた・作り直す前の token・ゴミ箱のページ・別のページの画像・まだ済んでいない画像は
 * どれも同じ 404。
 */
export function sharedImageRoute(request: Request, token: string, assetId: string, deps: Pick<ImageApiDeps, "store" | "storage">): Promise<Response> {
  return guarded("GET /s/[token]/a/[assetId]", async () => {
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const storage = deps.storage();
    if (!storage) return imageError("storage_unavailable");

    const asset = await store.sharedImageAsset(token, assetId);
    if (!asset) return notFoundResponse();
    const read = await storage.readObject(asset.objectPath);
    if (!read) return notFoundResponse();
    return objectResponse(read, asset.contentType, SHARED_IMAGE_CACHE_CONTROL);
  });
}
