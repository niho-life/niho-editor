/**
 * 本文の画像の上限と、受け付ける種類（#33）。純粋な関数だけ（保存先・DB・node の API に触れない。
 * ブラウザの側（エディタ・貼り付け・ドロップ）からも読むので、node:crypto などは入れない）。
 * 上限は設計 §12「1 ファイルの容量の上限を設定に明記し、超えたら保存前に断る」。値はここの 1 か所だけにある
 * （README の「本文の画像（#33）」に同じ値を書いている）。
 */

/** 1 枚の容量の上限（20 MB）。ブラウザで sha256 を計算し、1 回の PUT で送れる大きさ。 */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** 題名・本文 JSON・参照する画像・アップロード予約の合計。 */
export const PAGE_MAX_BYTES = 30 * 1024 * 1024;
/** 1 ページに入れられる枚数。超えたら開始で断る（保存の前）。 */
export const IMAGE_PAGE_MAX_COUNT = 100;
/** alt・クレジットの上限（DB の assets の CHECK・限定 AST と同じ値。ここが 1 か所）。 */
export const IMAGE_ALT_MAX_CHARS = 1000;
export const IMAGE_CREDIT_MAX_CHARS = 500;

/** 受け付ける種類（この 5 つだけ。SVG は script を持てるので入れない）。 */
export const IMAGE_CONTENT_TYPES: readonly string[] = Object.freeze(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);

/** ファイル選択の `accept` に渡す値。 */
export const IMAGE_ACCEPT = IMAGE_CONTENT_TYPES.join(",");

export type ImageStartRejection = "content_type" | "size" | "too_large" | "sha256";

export type ImageStartInput = {
  contentType: unknown;
  sizeBytes: unknown;
  sha256: unknown;
};

/** 検査を通った開始の要求（正規化した値）。 */
export type ImageStart = {
  /** 小文字にした content type。 */
  contentType: string;
  sizeBytes: number;
  /** クライアントの申告の SHA-256（サーバーは検証しない）。 */
  sha256: string;
};

export type ImageStartResult = { ok: true; value: ImageStart } | { ok: false; reason: ImageStartRejection };

const SHA256 = /^[0-9a-f]{64}$/;

/** 受け付ける種類か（画面と貼り付け・ドロップの検査でも使う）。 */
export function isAllowedImageType(value: unknown): value is string {
  return typeof value === "string" && IMAGE_CONTENT_TYPES.includes(value.trim().toLowerCase());
}

/** 1 枚の大きさの上限の内側か。 */
export function isAllowedImageSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= IMAGE_MAX_BYTES;
}

/** 開始の要求の検査（保存の前に断る）。順に content_type → size・too_large → sha256。 */
export function validateImageStart(input: ImageStartInput): ImageStartResult {
  if (!isAllowedImageType(input.contentType)) return { ok: false, reason: "content_type" };
  const contentType = (input.contentType as string).trim().toLowerCase();

  const { sizeBytes } = input;
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1) return { ok: false, reason: "size" };
  if (sizeBytes > IMAGE_MAX_BYTES) return { ok: false, reason: "too_large" };

  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) return { ok: false, reason: "sha256" };

  return { ok: true, value: { contentType, sizeBytes, sha256: input.sha256 } };
}

/** 開始の要求の正規化した内容（冪等キーの比較用の SHA-256 を作る元。サーバーの images-api.ts が使う）。 */
export function imageRequestCanonical(pageId: string, start: ImageStart): string {
  return JSON.stringify([pageId.toLowerCase(), start.contentType, start.sizeBytes, start.sha256]);
}
