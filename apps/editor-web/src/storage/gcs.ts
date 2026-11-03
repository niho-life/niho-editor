import { createHash } from "node:crypto";
import {
  StorageError,
  isByteRange,
  isObjectPath,
  type ByteRange,
  type CopiedObject,
  type CopyObjectInput,
  type ObjectStorage,
  type ReadObject,
  type ReadObjectOptions,
  type StartUploadInput,
  type StoredObject,
  type UploadTicket,
} from "./types";

/**
 * Google Cloud Storage の保存先（`EDITOR_STORAGE=gcs`）。依存を足さず、fetch と Cloud Run のメタデータサーバーの token だけで呼ぶ。
 *
 * **実際の GCS では未検証**（bucket がまだ無いため。テストは fetch を差し替えて、送る要求の形と応答の扱いだけを確かめている）。
 *
 * 実行 ID（Cloud Run のサービスアカウント）は bucket に作成と閲覧だけ（削除・上書き不可）で、署名付き URL（V4 の署名）の権限も無い前提。
 * そのため、サーバーが自分の資格情報で resumable upload のセッションを始め、そのセッション URI をブラウザに渡して直接 PUT させる
 * （Cloud Run の要求の大きさの上限を避ける）。依拠している API の仕様:
 * - 開始: `POST https://storage.googleapis.com/upload/storage/v1/b/{bucket}/o?uploadType=resumable&name={object}`、
 *   header `X-Upload-Content-Type`（object の種類）・`X-Upload-Content-Length`（大きさ。超える PUT は保存先が断る）。
 *   成功は 200 で、`Location` header がセッション URI（https://cloud.google.com/storage/docs/performing-resumable-uploads）。
 *   セッション URI は 1 週間で使えなくなる。
 * - `ifGenerationMatch=0`: 同じ名前の object が無いときだけ作る（上書きしない。https://cloud.google.com/storage/docs/request-preconditions）。
 * - CORS: 開始の要求の `Origin` header が、そのセッション URI へのブラウザからの要求に返す origin になる
 *   （https://cloud.google.com/storage/docs/cross-origin）。bucket の CORS の設定もあわせて要る（README の「bucket に要求する設定」）。
 * - 確認: `GET https://storage.googleapis.com/storage/v1/b/{bucket}/o/{object（URL エンコード）}` の `size`（10 進の文字列）・`contentType`。
 * - 読み取り（画像の中継 #33・文字起こし #36 段 2b）: 同じ URL に `?alt=media` を付けた `GET`（同じ token の道）。応答の本文がそのまま
 *   object の中身で、`Content-Type` が種類、大きさは `Content-Length`（無ければ `x-goog-stored-content-length`）。`Accept-Encoding: identity`
 *   （中身をそのまま・`Content-Length` 付きで受ける）。時間切れは header が届くまでだけで、本文の読み取りには時間切れをかけない
 *   （長い音声をエンジンへ流し終えるまでの時間は、呼び出し側の時間切れが決める）。署名付き URL は作らない（実行 ID に署名の権限が無い前提）。
 * - 範囲の読み取り（録音の再生 #36 段 3b-2）: 同じ GET に `Range: bytes={start}-{end}`。206 の `Content-Range: bytes a-b/total` から
 *   返した範囲と全体の大きさを読む（求めた始まりと、object の終わりで切った終わりに一致しなければ信じない）。200 は範囲を無視した
 *   全体として扱う（https://cloud.google.com/storage/docs/json_api/v1/objects/get の Range）。416 は range_not_satisfiable。
 * - token: メタデータサーバー `GET {METADATA_TOKEN_URL}`（header `Metadata-Flavor: Google`）の `access_token`・`expires_in`（秒）。
 *
 * 失敗の写し方: 届かない・時間切れ（30 秒）・401・403・408・429・5xx は unavailable、それ以外の 4xx は rejected、確認の 404 は null。
 * token・セッション URI・bucket 名・object の場所は、ログにもエラーにも出さない（このファイルはログを書かない）。
 * リダイレクトは辿らない（Authorization を別の場所へ送らない）。
 */

export const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
export const GCS_UPLOAD_BASE = "https://storage.googleapis.com/upload/storage/v1/b/";
export const GCS_JSON_BASE = "https://storage.googleapis.com/storage/v1/b/";
/** セッション URI の origin（これ以外の Location はブラウザに渡さない）。 */
const SESSION_ORIGIN = "https://storage.googleapis.com";
/** 1 回の要求の時間切れ。 */
export const GCS_TIMEOUT_MS = 30_000;
/** resumable upload のセッション URI が使える期間（GCS の仕様で 1 週間）。 */
export const GCS_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** token の期限の少し前に取り直す（秒）。 */
const TOKEN_REFRESH_MARGIN_SEC = 60;

type Fetch = typeof fetch;

/** 保存先を呼ぶための access token（Bearer）を返す。失敗は StorageError（unavailable）。 */
export type AccessTokenProvider = () => Promise<string>;

/** header に入れてよい 1 語（空白・改行・制御文字なし）。 */
const HEADER_TOKEN = /^[\x21-\x7e]+$/;

async function send(doFetch: Fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await doFetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    // 中身（URL・token を含み得る）は捨てる
    throw new StorageError("unavailable");
  }
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new StorageError("unavailable");
  }
}

function failure(status: number): StorageError {
  if (status === 401 || status === 403 || status === 408 || status === 429 || status >= 500) return new StorageError("unavailable");
  return new StorageError("rejected");
}

/** 10 進の大きさ（`Content-Length` など。前後の空白は許す）。形が違えば NaN。 */
function lengthOf(value: string | null): number {
  return value !== null && /^\d{1,16}$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
}

const CONTENT_RANGE = /^bytes (\d{1,16})-(\d{1,16})\/(\d{1,16})$/i;

/** 206 の `Content-Range: bytes a-b/total`（a ≤ b < total）。形が違えば null（`*` の全体・不明の大きさも null）。 */
function parseContentRange(value: string | null): (ByteRange & { total: number }) | null {
  const match = value === null ? null : CONTENT_RANGE.exec(value.trim());
  if (!match) return null;
  const [start, end, total] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total) return null;
  return { start, end, total };
}

/**
 * Cloud Run（GCE）のメタデータサーバーから既定のサービスアカウントの token を取る。期限の 60 秒前まではメモリに持って使い回し、
 * 同時に呼ばれても取りに行くのは 1 回だけ。
 */
export function createMetadataTokenProvider(options: { fetch?: Fetch; now?: () => number; timeoutMs?: number } = {}): AccessTokenProvider {
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? GCS_TIMEOUT_MS;
  let cached: { token: string; expiresAtMs: number } | null = null;
  let pending: Promise<string> | null = null;

  const load = async (): Promise<string> => {
    const response = await send(doFetch, METADATA_TOKEN_URL, { method: "GET", headers: { "Metadata-Flavor": "Google" } }, timeoutMs);
    if (!response.ok) {
      await discard(response);
      throw new StorageError("unavailable");
    }
    const body = await readJson(response);
    const token = typeof body === "object" && body !== null ? (body as { access_token?: unknown }).access_token : undefined;
    const expiresIn = typeof body === "object" && body !== null ? (body as { expires_in?: unknown }).expires_in : undefined;
    if (typeof token !== "string" || !HEADER_TOKEN.test(token) || typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new StorageError("unavailable");
    }
    cached = { token, expiresAtMs: now() + Math.max(0, expiresIn - TOKEN_REFRESH_MARGIN_SEC) * 1000 };
    return token;
  };

  return async () => {
    if (cached && cached.expiresAtMs > now()) return cached.token;
    pending ??= load().finally(() => {
      pending = null;
    });
    return pending;
  };
}

export type GcsStorageOptions = {
  bucket: string;
  fetch?: Fetch;
  accessToken?: AccessTokenProvider;
  now?: () => number;
  timeoutMs?: number;
};

function validOrigin(origin: string | null): string | null {
  if (origin === null) return null;
  try {
    const url = new URL(origin);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === origin ? origin : null;
  } catch {
    return null;
  }
}

export function createGcsStorage(options: GcsStorageOptions): ObjectStorage {
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? GCS_TIMEOUT_MS;
  const accessToken = options.accessToken ?? createMetadataTokenProvider({ fetch: doFetch, now, timeoutMs });
  const bucket = encodeURIComponent(options.bucket);

  const authorization = async (): Promise<string> => {
    let token: string;
    try {
      token = await accessToken();
    } catch {
      throw new StorageError("unavailable");
    }
    if (typeof token !== "string" || !HEADER_TOKEN.test(token)) throw new StorageError("unavailable");
    return `Bearer ${token}`;
  };

  type CopyMetadata = { sizeBytes: number; contentType: string | null; generation: string; copiedFromGeneration: string | null; copiedFromObjectHash: string | null };
  const copyMetadata = async (objectPath: string): Promise<CopyMetadata | null> => {
    const url = `${GCS_JSON_BASE}${bucket}/o/${encodeURIComponent(objectPath)}?fields=size%2CcontentType%2Cgeneration%2Cmetadata`;
    const response = await send(doFetch, url, { method: "GET", headers: { Authorization: await authorization() } }, timeoutMs);
    if (response.status === 404) {
      await discard(response);
      return null;
    }
    if (!response.ok) {
      await discard(response);
      throw failure(response.status);
    }
    const body = await readJson(response);
    if (typeof body !== "object" || body === null) throw new StorageError("unavailable");
    const { size, contentType, generation, metadata } = body as { size?: unknown; contentType?: unknown; generation?: unknown; metadata?: unknown };
    const sizeBytes = typeof size === "string" && /^\d{1,16}$/.test(size) ? Number(size) : Number.NaN;
    if (!Number.isSafeInteger(sizeBytes) || typeof generation !== "string" || !/^[1-9][0-9]{0,30}$/.test(generation)) throw new StorageError("unavailable");
    const copied = typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
      ? (metadata as { nihoSourceGeneration?: unknown }).nihoSourceGeneration
      : null;
    const sourceHash = typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
      ? (metadata as { nihoSourceObjectHash?: unknown }).nihoSourceObjectHash : null;
    return { sizeBytes, contentType: typeof contentType === "string" ? contentType : null, generation,
      copiedFromGeneration: typeof copied === "string" ? copied : null, copiedFromObjectHash: typeof sourceHash === "string" ? sourceHash : null };
  };

  return {
    kind: "gcs",
    async startUpload(input: StartUploadInput): Promise<UploadTicket> {
      if (
        !isObjectPath(input.objectPath) ||
        typeof input.contentType !== "string" ||
        !HEADER_TOKEN.test(input.contentType) ||
        !Number.isSafeInteger(input.sizeBytes) ||
        input.sizeBytes < 0
      ) {
        throw new StorageError("rejected");
      }
      const headers: Record<string, string> = {
        Authorization: await authorization(),
        "X-Upload-Content-Type": input.contentType,
        "X-Upload-Content-Length": String(input.sizeBytes),
      };
      const origin = validOrigin(input.origin);
      if (origin !== null) headers.Origin = origin;
      const url = `${GCS_UPLOAD_BASE}${bucket}/o?uploadType=resumable&name=${encodeURIComponent(input.objectPath)}&ifGenerationMatch=0`;
      const response = await send(doFetch, url, { method: "POST", headers }, timeoutMs);
      await discard(response);
      if (!response.ok) throw failure(response.status);
      const location = response.headers.get("location");
      let session: URL;
      try {
        session = new URL(location ?? "");
      } catch {
        throw new StorageError("unavailable");
      }
      if (session.origin !== SESSION_ORIGIN) throw new StorageError("unavailable");
      return {
        url: session.href,
        method: "PUT",
        headers: { "Content-Type": input.contentType },
        expiresAt: new Date(now() + GCS_SESSION_TTL_MS).toISOString(),
      };
    },
    async stat(objectPath: string): Promise<StoredObject | null> {
      if (!isObjectPath(objectPath)) throw new StorageError("rejected");
      const url = `${GCS_JSON_BASE}${bucket}/o/${encodeURIComponent(objectPath)}?fields=size%2CcontentType%2Cgeneration`;
      const response = await send(doFetch, url, { method: "GET", headers: { Authorization: await authorization() } }, timeoutMs);
      if (response.status === 404) {
        await discard(response);
        return null;
      }
      if (!response.ok) {
        await discard(response);
        throw failure(response.status);
      }
      const body = await readJson(response);
      if (typeof body !== "object" || body === null) throw new StorageError("unavailable");
      const { size, contentType, generation } = body as { size?: unknown; contentType?: unknown; generation?: unknown };
      const sizeBytes = typeof size === "string" && /^\d{1,16}$/.test(size) ? Number(size) : Number.NaN;
      if (!Number.isSafeInteger(sizeBytes) || typeof generation !== "string" || !/^[1-9][0-9]{0,30}$/.test(generation)) throw new StorageError("unavailable");
      return { sizeBytes, contentType: typeof contentType === "string" ? contentType : null, generation };
    },
    async copyObject(input: CopyObjectInput): Promise<CopiedObject> {
      if (
        !isObjectPath(input.sourceObjectPath) || !isObjectPath(input.targetObjectPath)
        || input.sourceObjectPath === input.targetObjectPath
        || !/^[1-9][0-9]{0,30}$/.test(input.sourceGeneration)
      ) throw new StorageError("rejected");
      const source = await copyMetadata(input.sourceObjectPath);
      if (!source) throw new StorageError("rejected");
      const sourceGeneration = input.sourceGeneration;
      const sourceObjectHash = createHash("sha256").update(input.sourceObjectPath).digest("hex");
      if (source.generation !== sourceGeneration) throw new StorageError("rejected");
      const base = `${GCS_JSON_BASE}${bucket}/o/${encodeURIComponent(input.sourceObjectPath)}/rewriteTo/b/${bucket}/o/${encodeURIComponent(input.targetObjectPath)}`;
      let rewriteToken: string | null = null;
      for (let round = 0; round < 100; round += 1) {
        const query = new URLSearchParams({ ifSourceGenerationMatch: sourceGeneration, ifGenerationMatch: "0" });
        if (rewriteToken !== null) query.set("rewriteToken", rewriteToken);
        const response = await send(doFetch, `${base}?${query.toString()}`, {
          method: "POST",
          headers: { Authorization: await authorization(), "Content-Type": "application/json" },
          body: JSON.stringify({ contentType: source.contentType, metadata: { nihoSourceGeneration: sourceGeneration, nihoSourceObjectHash: sourceObjectHash } }),
        }, timeoutMs);
        if (response.status === 412) {
          await discard(response);
          const existing = await copyMetadata(input.targetObjectPath);
          if (!existing || existing.sizeBytes !== source.sizeBytes || existing.contentType !== source.contentType || existing.copiedFromGeneration !== sourceGeneration || existing.copiedFromObjectHash !== sourceObjectHash) throw new StorageError("rejected");
          return { sourceGeneration, sizeBytes: source.sizeBytes, contentType: source.contentType };
        }
        if (!response.ok) {
          await discard(response);
          throw failure(response.status);
        }
        const body = await readJson(response);
        if (typeof body !== "object" || body === null) throw new StorageError("unavailable");
        const result = body as { done?: unknown; rewriteToken?: unknown; resource?: unknown };
        if (result.done === true) {
          const resource = result.resource;
          if (typeof resource !== "object" || resource === null) throw new StorageError("unavailable");
          const saved = resource as { size?: unknown; contentType?: unknown; metadata?: unknown };
          const sizeBytes = typeof saved.size === "string" && /^\d{1,16}$/.test(saved.size) ? Number(saved.size) : Number.NaN;
          const marker = typeof saved.metadata === "object" && saved.metadata !== null
            ? (saved.metadata as { nihoSourceGeneration?: unknown }).nihoSourceGeneration
            : null;
          const objectMarker = typeof saved.metadata === "object" && saved.metadata !== null
            ? (saved.metadata as { nihoSourceObjectHash?: unknown }).nihoSourceObjectHash : null;
          if (objectMarker !== sourceObjectHash || sizeBytes !== source.sizeBytes || (typeof saved.contentType === "string" ? saved.contentType : null) !== source.contentType || marker !== sourceGeneration) throw new StorageError("unavailable");
          return { sourceGeneration, sizeBytes, contentType: source.contentType };
        }
        if (typeof result.rewriteToken !== "string" || result.rewriteToken.length < 1 || result.rewriteToken.length > 2048 || /[\u0000-\u001f\u007f]/.test(result.rewriteToken)) throw new StorageError("unavailable");
        rewriteToken = result.rewriteToken;
      }
      throw new StorageError("unavailable");
    },
    async readObject(objectPath: string, options: ReadObjectOptions = {}): Promise<ReadObject | null> {
      if (!isObjectPath(objectPath)) throw new StorageError("rejected");
      const { range } = options;
      if (range !== undefined && !isByteRange(range)) throw new StorageError("rejected");
      const url = `${GCS_JSON_BASE}${bucket}/o/${encodeURIComponent(objectPath)}?alt=media`;
      const headers: Record<string, string> = { Authorization: await authorization(), "Accept-Encoding": "identity" };
      if (range !== undefined) headers.Range = `bytes=${range.start}-${range.end}`;
      // 時間切れは header が届くまで（本文を読む間は切らない。届いたら timer を止める）
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await doFetch(url, { method: "GET", headers, redirect: "error", signal: controller.signal });
      } catch {
        // 中身（URL・token を含み得る）は捨てる
        throw new StorageError("unavailable");
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 404) {
        await discard(response);
        return null;
      }
      if (range !== undefined && response.status === 416) {
        await discard(response);
        throw new StorageError("range_not_satisfiable");
      }
      if (!response.ok) {
        await discard(response);
        throw failure(response.status);
      }
      const contentType = response.headers.get("content-type");
      if (range !== undefined && response.status === 206) {
        // 求めた始まりから、求めた終わり（object の終わりで切る）まで。それ以外の範囲・大きさの食い違いは信じない
        const served = parseContentRange(response.headers.get("content-range"));
        const length = response.headers.get("content-length");
        const sizeBytes = served ? served.end - served.start + 1 : Number.NaN;
        if (
          !served ||
          !response.body ||
          served.start !== range.start ||
          served.end !== Math.min(range.end, served.total - 1) ||
          (length !== null && lengthOf(length) !== sizeBytes)
        ) {
          await discard(response);
          throw new StorageError("unavailable");
        }
        return { body: response.body, contentType, sizeBytes, range: { start: served.start, end: served.end }, totalBytes: served.total };
      }
      if (range !== undefined && response.status !== 200) {
        await discard(response);
        throw new StorageError("unavailable");
      }
      const sizeBytes = lengthOf(response.headers.get("content-length") ?? response.headers.get("x-goog-stored-content-length"));
      if (!response.body || !Number.isSafeInteger(sizeBytes)) {
        await discard(response);
        throw new StorageError("unavailable");
      }
      if (range === undefined) return { body: response.body, contentType, sizeBytes };
      // 範囲を求めたのに 200: 保存先が範囲を無視して全体を返した。全体の範囲として返す（空の object には範囲が無い）
      if (sizeBytes === 0) {
        await discard(response);
        throw new StorageError("range_not_satisfiable");
      }
      return { body: response.body, contentType, sizeBytes, range: { start: 0, end: sizeBytes - 1 }, totalBytes: sizeBytes };
    },
  };
}
