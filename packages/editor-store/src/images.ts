import { CONTROL_CHARACTERS, SHA256, TOUCH_PAGE_SQL, assertOwner, charCount, isInvalidTextRepresentation, isStorableText, rollback, type Connectable } from "./recordings.ts";
import { isShareToken } from "./shares.ts";
import { isPageId } from "./store.ts";
import { IMAGE_MAX_BYTES, PAGE_IMAGE_MAX_COUNT, PAGE_MAX_BYTES, pageImageCharges, pageSizeBytes } from "./page-size.ts";
import type { OwnerId, Queryable } from "./types.ts";

/**
 * 本文の画像（#33。migrations/0011_image_assets.sql）。
 *
 * 流れ（音声（#36 段 2a）と同じ二段）: 開始（startImageUpload）で assets の行（kind = 'image'・upload_status = 'uploading'・
 * consent = false）を作る → ブラウザが保存先へ直接アップロードする → 完了（completeImageUpload）で、保存先にある object の
 * 大きさを保存先で確かめて 'ready' にする。ready の bytes は実寸、sha256・content_type はクライアントの申告
 * （サーバーは中身を読まず、sha256 を検証しない）。
 *
 * 読み取りは呼び出し側（editor-web）がサーバーで中継する。ここが返すのは bucket の中の場所（bucket 名・URL・署名は持たない）。
 * 読み書きは全て本人の・ゴミ箱でないページの画像だけ（別の人・存在しない・UUID として不正な id・削除済み・画像でない資産は null）。
 * 共有リンクの読み取り（sharedImageAsset）は token で絞り、shares.ts の readSharedPage と同じ条件（ゴミ箱のページは返さない）に、
 * 「そのページの画像」と「アップロードの済んだ（ready）画像」を足す。
 * 画像の object はここでは消さない（取消・期限切れ・ゴミ箱 purge は資産の行だけを消す）。
 */

/** 画像の object を置く場所の接頭辞。 */
export const IMAGE_OBJECT_PREFIX = "image/";
/** alt・クレジットの上限（0001 の assets の CHECK と同じ）。 */
export const IMAGE_ALT_MAX_CHARS = 1000;
export const IMAGE_CREDIT_MAX_CHARS = 500;
/** content type の文字数の上限（0001 の assets.content_type の CHECK と同じ）。 */
const CONTENT_TYPE_MAX_CHARS = 255;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** uploading: 開始だけが済んだ（実体はまだ無いかもしれない）/ ready: 大きさを確かめた。 */
export const IMAGE_UPLOAD_STATUSES = ["uploading", "ready"] as const;
export type ImageUploadStatus = (typeof IMAGE_UPLOAD_STATUSES)[number];

/** 本人から見た画像の資産（bucket 名・URL・署名は持たない）。 */
export type ImageAsset = {
  assetId: string;
  pageId: string;
  /** bucket の中の場所（`image/{asset id}`）。ブラウザへは渡さない。 */
  objectPath: string;
  status: ImageUploadStatus;
  bytes: number;
  contentType: string;
  /** クライアントの申告の SHA-256（サーバーは検証しない）。 */
  sha256: string;
  alt: string | null;
  credit: string | null;
  consent: boolean;
  createdAt: string;
};

export type StartImageUploadInput = {
  /** 資産の id（呼び出し側が先に作る。保存先の場所 `image/{assetId}` に使う）。 */
  assetId: string;
  /** 画像を入れるページ（本人の・ゴミ箱でないページだけ）。 */
  pageId: string;
  /** 申告の content type（小文字に正規化したもの）。 */
  contentType: string;
  /** 申告の大きさ（バイト）。 */
  bytes: number;
  /** 申告の SHA-256（小文字 16 進 64 桁。サーバーは検証しない）。 */
  sha256: string;
  /** 冪等キー（UUID）。無ければ null（同じ要求の再送でも別の資産になる）。 */
  uploadKey: string | null;
  /** 開始の要求の正規化した内容の SHA-256（同じキーで内容が違う要求を見分ける）。 */
  requestHash: string;
};

export type StartedImageUpload = {
  /** created: 今作った / existing: 同じキー・同じ内容の要求で作ったもの（何も書かない）。 */
  status: "created" | "existing";
  assetId: string;
  objectPath: string;
  uploadStatus: ImageUploadStatus;
};

/**
 * conflict: 同じキーで内容が違う要求か、そのキーで作った資産のページがゴミ箱にある（キーは使えない）。
 * null: 本人の・ゴミ箱でないページが無い（別の人・存在しない・不正な id・削除済み）。
 */
export type StartImageUploadResult = StartedImageUpload | { status: "conflict" } | { status: "page_full" } | { status: "too_many" } | null;

export type CompleteImageUploadResult = { status: "ok"; asset: ImageAsset } | { status: "size_mismatch" } | { status: "page_full" } | null;

/** 画像の欄（指定したものだけを変える）。alt・クレジットは空文字を null として入れる。 */
export type ImageMetaPatch = { alt?: string | null; credit?: string | null; consent?: boolean };

/** 共有リンクのページの画像（token で絞った読み取り。id・owner・sha256・状態は含めない）。 */
export type SharedImageAsset = {
  objectPath: string;
  contentType: string;
  bytes: number;
  alt: string | null;
  credit: string | null;
};

export class InvalidImageError extends TypeError {
  override readonly name = "InvalidImageError";
  readonly problem: string;
  constructor(problem: string) {
    super(`editor-store: image is not valid (${problem})`);
    this.problem = problem;
  }
}

/** 画像の object の場所（`image/{asset id}`）。asset id は UUID だけ（それ以外は TypeError）。 */
export function imageObjectPath(assetId: string): string {
  if (typeof assetId !== "string" || !isPageId(assetId)) throw new TypeError("editor-store: asset id must be a UUID");
  return `${IMAGE_OBJECT_PREFIX}${assetId.toLowerCase()}`;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && isPageId(value);
}

function startProblem(input: StartImageUploadInput): string | null {
  if (!isUuid(input.assetId)) return "asset";
  if (!isUuid(input.pageId)) return "page";
  if (typeof input.contentType !== "string" || input.contentType.length > CONTENT_TYPE_MAX_CHARS || !CONTENT_TYPE.test(input.contentType)) {
    return "content_type";
  }
  if (typeof input.bytes !== "number" || !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > IMAGE_MAX_BYTES) return "bytes";
  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) return "sha256";
  if (input.uploadKey !== null && !isUuid(input.uploadKey)) return "upload_key";
  if (typeof input.requestHash !== "string" || !SHA256.test(input.requestHash)) return "request_hash";
  return null;
}

/** 欄として保存してよい文字か（1 行の値。制御文字・対になっていない surrogate を含まない）。 */
function metaProblem(patch: ImageMetaPatch): string | null {
  for (const [key, max] of [
    ["alt", IMAGE_ALT_MAX_CHARS],
    ["credit", IMAGE_CREDIT_MAX_CHARS],
  ] as const) {
    const value = patch[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || !isStorableText(value) || CONTROL_CHARACTERS.test(value) || charCount(value) > max) return key;
  }
  if (patch.consent !== undefined && typeof patch.consent !== "boolean") return "consent";
  return null;
}

type ImageRow = {
  id: string;
  page_id: string;
  bucket_path: string;
  upload_status: ImageUploadStatus;
  bytes: string;
  content_type: string;
  sha256: string;
  alt: string | null;
  credit: string | null;
  consent: boolean;
  created_at: Date;
};

const IMAGE_COLUMNS = `a.id, a.page_id, a.bucket_path, a.upload_status, a.bytes::text AS bytes, a.content_type, a.sha256,
       a.alt, a.credit, a.consent, a.created_at`;

function toAsset(row: ImageRow): ImageAsset {
  return {
    assetId: row.id,
    pageId: row.page_id,
    objectPath: row.bucket_path,
    status: row.upload_status,
    bytes: Number(row.bytes),
    contentType: row.content_type,
    sha256: row.sha256,
    alt: row.alt,
    credit: row.credit,
    consent: row.consent,
    createdAt: row.created_at.toISOString(),
  };
}

// 本人の・ゴミ箱でないページにだけ入れる（ページが無ければ 0 行）。consent は false から始める（掲載許諾は人が入れる）。
// $1 page id / $2 owner / $3 asset id / $4 bucket path / $5 bytes（申告）/ $6 sha256（申告）/ $7 content type（申告）/
// $8 upload key / $9 request hash
const INSERT_IMAGE_SQL = `
INSERT INTO assets (id, owner, page_id, kind, bucket_path, bytes, sha256, content_type, consent, upload_status, upload_key, request_hash, reservation_expires_at)
SELECT $3::uuid, p.owner, p.id, 'image', $4::text, $5::bigint, $6::text, $7::text, false, 'uploading', $8::uuid, $9::text, clock_timestamp() + interval '8 days'
  FROM pages AS p
 WHERE p.id = $1 AND p.owner = $2 AND p.deleted_at IS NULL
RETURNING id, bucket_path, upload_status`;

// 同じ owner・同じ冪等キーの資産（ゴミ箱のページのものも引き、呼び出し側で conflict にする）。$1 owner / $2 key。
const FIND_BY_KEY_SQL = `
SELECT a.id, a.page_id, a.bucket_path, a.kind, a.upload_status, a.request_hash, p.deleted_at IS NOT NULL AS deleted
  FROM assets AS a
  JOIN pages AS p ON p.owner = a.owner AND p.id = a.page_id
 WHERE a.owner = $1 AND a.upload_key = $2`;

const UPLOAD_KEY_CONSTRAINT = "assets_upload_key_key";

function isUploadKeyConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === "23505" && constraint === UPLOAD_KEY_CONSTRAINT;
}

type KeyRow = {
  id: string;
  page_id: string;
  bucket_path: string;
  kind: string;
  upload_status: ImageUploadStatus;
  request_hash: string | null;
  deleted: boolean;
};

async function findByKey(db: Queryable, owner: OwnerId, key: string, pageId: string, requestHash: string): Promise<StartImageUploadResult | null> {
  const result = await db.query<KeyRow>(FIND_BY_KEY_SQL, [owner, key]);
  const row = result.rows[0];
  if (!row) return null;
  // 同じキーで、ページ・内容が違う要求（と、そのキーのページがゴミ箱にある場合）はキーを使い回せない
  if (row.deleted || row.kind !== "image" || row.page_id !== pageId || row.request_hash !== requestHash) return { status: "conflict" };
  return { status: "existing", assetId: row.id, objectPath: row.bucket_path, uploadStatus: row.upload_status };
}

/**
 * 同じ owner・uploadKey の資産が既にあるか（1 ページの枚数の上限の判定の前に、冪等な再送を見分けるために使う。何も書かない）。
 * 無ければ null。ページと要求の内容（requestHash）が同じなら existing、違えば conflict（`startImageUpload` と同じ判定）。
 */
export async function findImageUploadByKey(
  db: Queryable,
  owner: OwnerId,
  input: { uploadKey: string; pageId: string; requestHash: string },
): Promise<StartImageUploadResult> {
  assertOwner(owner);
  return findByKey(db, owner, input.uploadKey.toLowerCase(), input.pageId.toLowerCase(), input.requestHash);
}

/**
 * 画像のアップロードを始める: ページ行を押さえ、予約を含む容量と枚数を検査してから assets の行を入れる。
 * 冪等: 同じ owner・同じ uploadKey の資産が既にあれば、ページと要求の内容（requestHash）が同じなら何も書かずにそれを返し
 * （existing）、違えば conflict。同じキーの要求が並んでも、入るのは 1 つだけ（UNIQUE で止まった側は先に入った方を引いて返す）。
 * 形が規則に合わなければ InvalidImageError（何も書かない）。
 */
export async function startImageUpload(db: Connectable, owner: OwnerId, input: StartImageUploadInput): Promise<StartImageUploadResult> {
  assertOwner(owner);
  const problem = startProblem(input);
  if (problem) throw new InvalidImageError(problem);
  const assetId = input.assetId.toLowerCase();
  const pageId = input.pageId.toLowerCase();
  const objectPath = imageObjectPath(assetId);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Every page writer takes this lock before inspecting its images. Count and insert are one decision.
    const page = (await client.query<{ title: string; blocks: { readonly [key: string]: unknown }[]; cover: string | null; lead: string | null }>(
      "SELECT title, blocks, cover, lead FROM pages WHERE id = $1 AND owner = $2 AND deleted_at IS NULL FOR UPDATE",
      [pageId, owner],
    )).rows[0];
    if (!page) {
      await rollback(client);
      return input.uploadKey === null ? null : (await findByKey(client, owner, input.uploadKey, pageId, input.requestHash)) ?? null;
    }
    const charges = await pageImageCharges(client, owner, pageId);
    if (input.uploadKey !== null) {
      const existing = await findByKey(client, owner, input.uploadKey, pageId, input.requestHash);
      if (existing) {
        if (existing.status === "existing" && existing.uploadStatus === "uploading") {
          await client.query(
            "UPDATE assets SET reservation_expires_at = clock_timestamp() + interval '8 days' WHERE owner = $1 AND id = $2 AND upload_status = 'uploading'",
            [owner, existing.assetId],
          );
          await client.query("COMMIT");
          return existing;
        }
        await client.query("COMMIT");
        return existing;
      }
    }
    if (charges.length >= PAGE_IMAGE_MAX_COUNT) {
      await client.query("COMMIT");
      return { status: "too_many" };
    }
    if (pageSizeBytes(page.title, page.blocks, charges, page.cover, page.lead) + input.bytes > PAGE_MAX_BYTES) {
      await client.query("COMMIT");
      return { status: "page_full" };
    }
    const inserted = await client.query<{ id: string; bucket_path: string; upload_status: ImageUploadStatus }>(INSERT_IMAGE_SQL, [
      pageId,
      owner,
      assetId,
      objectPath,
      input.bytes,
      input.sha256,
      input.contentType,
      input.uploadKey,
      input.requestHash,
    ]);
    const row = inserted.rows[0];
    // ページが無い（別の人・存在しない・ゴミ箱）
    if (!row) throw new Error("editor-store: locked page vanished during image start");
    await client.query("COMMIT");
    return { status: "created", assetId: row.id, objectPath: row.bucket_path, uploadStatus: row.upload_status };
  } catch (error) {
    await rollback(client);
    // 同じキーの要求が並んで、先に入った方がある: その資産を返す（ページ・内容が違えば conflict）
    if (input.uploadKey !== null && isUploadKeyConflict(error)) {
      const existing = await findByKey(client, owner, input.uploadKey, pageId, input.requestHash);
      if (existing) return existing;
    }
    throw error;
  } finally {
    client.release();
  }
}

// 本人の・ゴミ箱でないページの画像の行を押さえる。$1 owner / $2 asset id。
const LOCK_IMAGE_SQL = `
SELECT a.id, a.page_id, a.bytes::text AS bytes, a.upload_status
  FROM assets AS a
  JOIN pages AS p ON p.owner = a.owner AND p.id = a.page_id
 WHERE a.owner = $1 AND a.id = $2 AND a.kind = 'image' AND p.deleted_at IS NULL
   FOR UPDATE OF a`;

const MARK_READY_SQL = `
UPDATE assets AS a
   SET upload_status = 'ready', bytes = $3, reservation_expires_at = NULL
 WHERE a.owner = $1 AND a.id = $2 AND a.kind = 'image' AND a.upload_status = 'uploading'
RETURNING ${IMAGE_COLUMNS}`;

// $1 owner / $2 asset id。
const GET_IMAGE_SQL = `
SELECT ${IMAGE_COLUMNS}
  FROM assets AS a
  JOIN pages AS p ON p.owner = a.owner AND p.id = a.page_id
 WHERE a.owner = $1 AND a.id = $2 AND a.kind = 'image' AND p.deleted_at IS NULL`;

/**
 * アップロードの完了。行を FOR UPDATE で押さえてから状態を見るので、並んで呼ばれても更新は 1 回だけ。
 * - 本人の・ゴミ箱でないページの画像が無い: null
 * - ready: 何も書かずにそのまま成功（冪等）
 * - uploading で保存先の実寸が 1〜20 MiB、ページ容量にも収まる: bytes を実寸に確定して ready にする
 * - 実寸が 0 または 20 MiB 超: `{ status: "size_mismatch" }`（何も書かない）
 * - ページ容量超過: `{ status: "page_full" }`（何も書かない）
 * stored は保存先で確かめた object の大きさ（呼び出し側が保存先に問い合わせる）。
 */
export async function completeImageUpload(
  pool: Connectable,
  owner: OwnerId,
  assetId: string,
  stored: { sizeBytes: number },
): Promise<CompleteImageUploadResult> {
  assertOwner(owner);
  if (!stored || typeof stored.sizeBytes !== "number" || !Number.isSafeInteger(stored.sizeBytes) || stored.sizeBytes < 0) {
    throw new TypeError("editor-store: stored size must be a non-negative integer");
  }
  if (!isPageId(assetId)) return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const location = await client.query<{ page_id: string }>(
        "SELECT page_id FROM assets WHERE owner = $1 AND id = $2 AND kind = 'image'",
        [owner, assetId],
      );
      if (!location.rows[0]) {
        await rollback(client);
        return null;
      }
      const page = (await client.query<{ title: string; blocks: { readonly [key: string]: unknown }[]; cover: string | null; lead: string | null }>(
        "SELECT title, blocks, cover, lead FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE",
        [owner, location.rows[0].page_id],
      )).rows[0];
      if (!page) {
        await rollback(client);
        return null;
      }
      const charges = await pageImageCharges(client, owner, location.rows[0].page_id);
      const locked = await client.query<{ id: string; page_id: string; bytes: string; upload_status: ImageUploadStatus }>(LOCK_IMAGE_SQL, [owner, assetId]);
      const row = locked.rows[0];
      if (!row) {
        await rollback(client);
        return null;
      }
      if (row.upload_status === "ready") {
        const current = await client.query<ImageRow>(GET_IMAGE_SQL, [owner, assetId]);
        await rollback(client);
        const asset = current.rows[0];
        return asset ? { status: "ok", asset: toAsset(asset) } : null;
      }
      if (stored.sizeBytes < 1 || stored.sizeBytes > IMAGE_MAX_BYTES) {
        await rollback(client);
        return { status: "size_mismatch" };
      }
      const adjusted = charges.map((charge) => charge.id === row.id ? { ...charge, bytes: stored.sizeBytes, status: "ready" as const } : charge);
      if (pageSizeBytes(page.title, page.blocks, adjusted, page.cover, page.lead) > PAGE_MAX_BYTES) {
        await rollback(client);
        return { status: "page_full" };
      }
      const updated = await client.query<ImageRow>(MARK_READY_SQL, [owner, assetId, stored.sizeBytes]);
      const saved = updated.rows[0];
      if (!saved) throw new Error("editor-store: update returned no asset");
      await client.query(TOUCH_PAGE_SQL, [owner, row.page_id]);
      await client.query("COMMIT");
      return { status: "ok", asset: toAsset(saved) };
    } catch (error) {
      await rollback(client);
      throw error;
    }
  } finally {
    client.release();
  }
}

/** Cancel only an uploading asset. The page lock makes cancellation exclusive with start, complete and save. */
export async function cancelImageUpload(pool: Connectable, owner: OwnerId, pageId: string, assetId: string): Promise<boolean> {
  assertOwner(owner);
  if (!isPageId(pageId) || !isPageId(assetId)) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const page = await client.query("SELECT id FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE", [owner, pageId]);
    if (page.rows.length === 0) {
      await rollback(client);
      return false;
    }
    const removed = await client.query(
      `DELETE FROM assets AS a WHERE a.owner = $1 AND a.page_id = $2 AND a.id = $3 AND a.kind = 'image'
         AND a.upload_status = 'uploading'
         AND NOT EXISTS (SELECT 1 FROM pages AS p WHERE p.owner = a.owner AND p.cover = a.id)
       RETURNING a.id`,
      [owner, pageId, assetId],
    );
    await client.query("COMMIT");
    return removed.rows.length > 0;
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

/** 本人の・ゴミ箱でないページの画像の資産（中継と欄の読み取り）。無ければ null。 */
export async function imageAsset(db: Queryable, owner: OwnerId, assetId: string): Promise<ImageAsset | null> {
  assertOwner(owner);
  if (!isPageId(assetId)) return null;
  try {
    const result = await db.query<ImageRow>(GET_IMAGE_SQL, [owner, assetId]);
    const row = result.rows[0];
    return row ? toAsset(row) : null;
  } catch (error) {
    if (isInvalidTextRepresentation(error)) return null;
    throw error;
  }
}

// $1 owner / $2 asset id / $3 alt を変えるか / $4 alt / $5 クレジットを変えるか / $6 クレジット / $7 掲載許諾を変えるか / $8 掲載許諾。
// ページの更新時刻は進めない（欄は本文（AST）にも入り、その保存が進める）。
const UPDATE_META_SQL = `
UPDATE assets AS a
   SET alt = CASE WHEN $3::bool THEN $4::text ELSE a.alt END,
       credit = CASE WHEN $5::bool THEN $6::text ELSE a.credit END,
       consent = CASE WHEN $7::bool THEN $8::bool ELSE a.consent END
  FROM pages AS p
 WHERE p.owner = a.owner AND p.id = a.page_id AND p.deleted_at IS NULL
   AND a.owner = $1 AND a.id = $2 AND a.kind = 'image'
RETURNING ${IMAGE_COLUMNS}`;

/**
 * alt・クレジット・掲載許諾を直す（指定したものだけ）。空文字は null として入れる。
 * 本人の・ゴミ箱でないページの画像が無ければ null。形が規則に合わなければ InvalidImageError（何も書かない）。
 */
export async function updateImageMeta(db: Queryable, owner: OwnerId, assetId: string, patch: ImageMetaPatch): Promise<ImageAsset | null> {
  assertOwner(owner);
  const problem = metaProblem(patch);
  if (problem) throw new InvalidImageError(problem);
  if (!isPageId(assetId)) return null;
  const empty = (value: string | null | undefined) => (value === undefined || value === null || value === "" ? null : value);
  try {
    const result = await db.query<ImageRow>(UPDATE_META_SQL, [
      owner,
      assetId,
      patch.alt !== undefined,
      empty(patch.alt),
      patch.credit !== undefined,
      empty(patch.credit),
      patch.consent !== undefined,
      patch.consent ?? false,
    ]);
    const row = result.rows[0];
    return row ? toAsset(row) : null;
  } catch (error) {
    if (isInvalidTextRepresentation(error)) return null;
    throw error;
  }
}

// $1 owner / $2 page id。ページが無ければ 0 行（null）。
const COUNT_IMAGES_SQL = `
SELECT (SELECT count(*) FROM assets AS a WHERE a.owner = p.owner AND a.page_id = p.id AND a.kind = 'image'
       AND (a.upload_status = 'ready' OR a.reservation_expires_at IS NULL OR a.reservation_expires_at > clock_timestamp()))::int AS images
  FROM pages AS p
 WHERE p.owner = $1 AND p.id = $2 AND p.deleted_at IS NULL`;

/**
 * 1 ページの画像の枚数（上限の検査用。uploading のものも数える）。
 * 本人の・ゴミ箱でないページが無ければ null（呼び出し側は同じ 404 にする）。
 */
export async function countPageImages(db: Queryable, owner: OwnerId, pageId: string): Promise<number | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  try {
    const result = await db.query<{ images: number }>(COUNT_IMAGES_SQL, [owner, pageId]);
    const row = result.rows[0];
    return row ? row.images : null;
  } catch (error) {
    if (isInvalidTextRepresentation(error)) return null;
    throw error;
  }
}

// 認証なしの読み取り（共有リンク）。ページは毎回 join し、ゴミ箱のページ・そのページ以外の画像・済んでいない画像は返さない。
// $1 token / $2 asset id。
const SHARED_IMAGE_SQL = `
SELECT a.bucket_path, a.content_type, a.bytes::text AS bytes, a.alt, a.credit
  FROM page_shares AS s
  JOIN pages AS p ON p.owner = s.owner AND p.id = s.page_id
  JOIN assets AS a ON a.owner = p.owner AND a.page_id = p.id
 WHERE s.token = $1 AND p.deleted_at IS NULL AND a.id = $2 AND a.kind = 'image' AND a.upload_status = 'ready'`;

/**
 * 共有リンクのページの画像（認証なし）。token か asset id が形として正しくなければ DB に問い合わせずに null。
 * 共有していない・止めた・作り直した後の古い token・ゴミ箱のページ・別のページの画像・まだ済んでいない画像はどれも null
 * （呼び出し側は同じ 404 にする）。
 */
export async function sharedImageAsset(db: Queryable, token: string, assetId: string): Promise<SharedImageAsset | null> {
  if (!isShareToken(token) || !isPageId(assetId)) return null;
  const result = await db.query<{ bucket_path: string; content_type: string; bytes: string; alt: string | null; credit: string | null }>(SHARED_IMAGE_SQL, [
    token,
    assetId,
  ]);
  const row = result.rows[0];
  if (!row) return null;
  return { objectPath: row.bucket_path, contentType: row.content_type, bytes: Number(row.bytes), alt: row.alt, credit: row.credit };
}
