import type { ImageMeta, ImageProblem, PageImageUploadResult, PageImages } from "niho-docs-ui/page/images";
import { isAllowedImageSize, isAllowedImageType } from "@/image/image-limits";
import { imageAssetPath } from "@/image/image-paths";

/**
 * ブラウザから本文の画像をアップロードする関数と、エディタに渡す口（#33）。
 * 流れ: startImageUpload（資産の行と ticket）→ putImage（ticket の url へ直接 PUT。保存先は本番では GCS、開発では同じ origin の
 * 偽物）→ completeImageUpload（大きさを確かめて ready にする）。描くときは `/api/assets/{id}`（サーバーが中継する）。
 *
 * - sha256 はここで計算して申告する（サーバーは検証しない）。20MB までなので一度に読んで digest する。
 * - ticket の url は持っている人がアップロードできる値なので、ログ・保存・本文に残さない。
 * - API の呼び出しは同じ origin。PUT は credentials を付けない（保存先は別の origin）。
 */

/** 口の型は共通（packages/docs-ui の page/images.ts。Mac・Web で同じエディタが読む）。実装（通信）だけがここにある。 */
export type { ImageMeta, ImageProblem, PageImageUploadResult, PageImages } from "niho-docs-ui/page/images";

export type ImageUploadTicket = {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
  /** 申告の大きさ（この大きさを PUT する）。 */
  maxBytes: number;
};

/** 開始の結果。`upload` が null なら既に済んでいる（同じ Idempotency-Key の再送）。 */
export type ImageStartResponse = { status: 200 | 201; assetId: string; upload: ImageUploadTicket | null };

/** サーバーが返す画像の資産（object の場所・sha256 は含まれない）。 */
export type ImageResponse = {
  assetId: string;
  pageId: string;
  status: "uploading" | "ready";
  bytes: number;
  contentType: string;
} & ImageMeta;

/** API の失敗。`error` と `reason` はサーバーの短い code（`bad_request`・`too_many`・`incomplete` など）。 */
export class ImageUploadError extends Error {
  override readonly name = "ImageUploadError";
  constructor(
    readonly status: number,
    readonly error: string | null = null,
    readonly reason: string | null = null,
  ) {
    super(`image upload failed with ${status}${error ? ` (${error}${reason ? `: ${reason}` : ""})` : ""}`);
  }
}

type FetchLike = typeof fetch;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function failure(response: Response): Promise<ImageUploadError> {
  const body = await readJson(response);
  const error = isPlainObject(body) && typeof body.error === "string" ? body.error : null;
  const reason = isPlainObject(body) && typeof body.reason === "string" ? body.reason : null;
  return new ImageUploadError(response.status, error, reason);
}

function isTicket(value: unknown): value is ImageUploadTicket {
  if (!isPlainObject(value) || value.method !== "PUT" || typeof value.url !== "string" || typeof value.expiresAt !== "string") return false;
  if (typeof value.maxBytes !== "number" || !isPlainObject(value.headers)) return false;
  return Object.values(value.headers).every((header) => typeof header === "string");
}

function toImage(value: unknown): ImageResponse | null {
  if (!isPlainObject(value) || typeof value.assetId !== "string" || typeof value.pageId !== "string") return null;
  if (value.status !== "uploading" && value.status !== "ready") return null;
  if (typeof value.bytes !== "number" || typeof value.contentType !== "string") return null;
  return {
    assetId: value.assetId,
    pageId: value.pageId,
    status: value.status,
    bytes: value.bytes,
    contentType: value.contentType,
    alt: typeof value.alt === "string" ? value.alt : null,
    credit: typeof value.credit === "string" ? value.credit : null,
    consent: value.consent === true,
  };
}

/** 画像の中身を読む path（サーバーが中継する）。 */
export { imageAssetPath };

/** ファイルの SHA-256（小文字 16 進）。サーバーは検証しないので、同じファイルを同じ資産にするための申告値。 */
export async function imageSha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** アップロードを始める。同じファイルの再送には同じ idempotencyKey（UUID）を渡す（同じ資産が返る）。 */
export async function startImageUpload(
  pageId: string,
  input: { contentType: string; sizeBytes: number; sha256: string },
  options: { idempotencyKey?: string; fetch?: FetchLike } = {},
): Promise<ImageStartResponse> {
  const fetchImpl = options.fetch ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.idempotencyKey !== undefined) {
    if (!UUID_PATTERN.test(options.idempotencyKey)) throw new TypeError("idempotencyKey must be a UUID");
    headers["idempotency-key"] = options.idempotencyKey;
  }
  const response = await fetchImpl(`/api/pages/${encodeURIComponent(pageId)}/images/start`, {
    method: "POST",
    headers,
    body: JSON.stringify({ contentType: input.contentType, sizeBytes: input.sizeBytes, sha256: input.sha256 }),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status !== 200 && response.status !== 201) throw await failure(response);
  const data = await readJson(response);
  if (!isPlainObject(data) || typeof data.assetId !== "string") throw new ImageUploadError(500);
  if (data.upload !== null && !isTicket(data.upload)) throw new ImageUploadError(500);
  return { status: response.status as 200 | 201, assetId: data.assetId, upload: data.upload as ImageUploadTicket | null };
}

/** ticket の url へ画像を直接 PUT する。412（既に置いてある）は成功と同じに扱い、続けて完了を呼べばよい。 */
export async function putImage(ticket: ImageUploadTicket, body: Blob, fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<void> {
  const response = await fetchImpl(ticket.url, { method: "PUT", headers: { ...ticket.headers }, body, credentials: "omit", cache: "no-store", signal });
  await response.body?.cancel().catch(() => undefined);
  if (response.ok || response.status === 412) return;
  // 保存先の応答の本文は読まない（中身を出さない）
  throw new ImageUploadError(response.status);
}

/** アップロードの完了。保存先に無い・大きさが違うは ImageUploadError（409、reason が missing・size_mismatch）。 */
export async function completeImageUpload(pageId: string, assetId: string, fetchImpl: FetchLike = fetch): Promise<ImageResponse> {
  const response = await fetchImpl(`/api/pages/${encodeURIComponent(pageId)}/images/${encodeURIComponent(assetId)}/complete`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw await failure(response);
  const data = await readJson(response);
  const image = isPlainObject(data) ? toImage(data.image) : null;
  if (!image) throw new ImageUploadError(500);
  return image;
}

/** 画像の公開メタデータ（掲載許諾など）を読む。画像本体は返さない。 */
export async function getImageMetadata(assetId: string, fetchImpl: FetchLike = fetch): Promise<ImageResponse> {
  const response = await fetchImpl(`/api/assets/${encodeURIComponent(assetId)}/meta`, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw await failure(response);
  const data = await readJson(response);
  const image = isPlainObject(data) ? toImage(data.image) : null;
  if (!image) throw new ImageUploadError(500);
  return image;
}

/** alt・クレジット・掲載許諾を保存する（指定したものだけ）。 */
export async function saveImageMeta(assetId: string, patch: Partial<ImageMeta>, fetchImpl: FetchLike = fetch): Promise<ImageResponse> {
  const body: Record<string, unknown> = {};
  if (patch.alt !== undefined) body.alt = patch.alt;
  if (patch.credit !== undefined) body.credit = patch.credit;
  if (patch.consent !== undefined) body.consent = patch.consent;
  const response = await fetchImpl(`/api/assets/${encodeURIComponent(assetId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw await failure(response);
  const data = await readJson(response);
  const image = isPlainObject(data) ? toImage(data.image) : null;
  if (!image) throw new ImageUploadError(500);
  return image;
}

/** サーバーが断った理由を、画面に出す理由に写す（分からないものは failed）。 */
function problemOf(error: unknown): ImageProblem {
  if (error instanceof ImageUploadError && error.error === "page_full") return "page_full";
  if (error instanceof ImageUploadError && error.error === "bad_request") {
    if (error.reason === "content_type") return "content_type";
    if (error.reason === "too_large") return "too_large";
    if (error.reason === "too_many") return "too_many";
  }
  return "failed";
}

/** A failed upload must not keep its page reservation. The server removes only uploading assets. */
export async function cancelImageUpload(pageId: string, assetId: string, fetchImpl: FetchLike = fetch): Promise<void> {
  await fetchImpl(`/api/pages/${encodeURIComponent(pageId)}/images/${encodeURIComponent(assetId)}`, {
    method: "DELETE",
    credentials: "same-origin",
    cache: "no-store",
  });
}

/**
 * エディタに渡す口。上限（種類・大きさ）はここでも先に見て、超えるものは送らない（枚数の上限はサーバーが見る）。
 * 1 枚ごとに開始 → PUT → 完了まで進め、どこかで失敗したら本文には何も入れない（断る理由を返す）。
 */
export function createPageImages(options: { fetch?: FetchLike } = {}): PageImages {
  const fetchImpl = options.fetch ?? ((...args: Parameters<FetchLike>) => fetch(...args));
  return {
    upload: async (file, pageId, signal) => {
      if (!isAllowedImageType(file.type)) return { ok: false, problem: "content_type" };
      if (!isAllowedImageSize(file.size)) return { ok: false, problem: "too_large" };
      let startedAssetId: string | null = null;
      try {
        const sha256 = await imageSha256(file);
        if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
        const started = await startImageUpload(pageId, { contentType: file.type.toLowerCase(), sizeBytes: file.size, sha256 }, { fetch: fetchImpl, idempotencyKey: crypto.randomUUID() });
        startedAssetId = started.upload ? started.assetId : null;
        if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
        if (started.upload) await putImage(started.upload, file, fetchImpl, signal);
        if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
        const image = await completeImageUpload(pageId, started.assetId, fetchImpl);
        return { ok: true, assetId: image.assetId, meta: { alt: image.alt, credit: image.credit, consent: image.consent } };
      } catch (error) {
        if (startedAssetId) await cancelImageUpload(pageId, startedAssetId, fetchImpl).catch(() => undefined);
        return { ok: false, problem: problemOf(error) };
      }
    },
    saveMeta: async (assetId, patch) => {
      try {
        await saveImageMeta(assetId, patch, fetchImpl);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** 画面が使う既定の口（`src/components/PageEditor.tsx` が渡す）。 */
export const pageImages: PageImages = createPageImages();
