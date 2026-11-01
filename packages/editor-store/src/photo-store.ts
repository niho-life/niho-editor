import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { assertOwner, rollback } from "./recordings.ts";
import { isPageId } from "./store.ts";
import type { Database, OwnerId, Queryable } from "./types.ts";

export const PHOTO_QUOTA_BYTES = 5 * 1024 ** 3;
export const PHOTO_RESERVATION_SECONDS = 24 * 60 * 60;
export const PHOTO_VERIFICATION_LEASE_MAX_SECONDS = 15 * 60;
export const PHOTO_TRASH_RETENTION_DAYS = 30;
export const PHOTO_MAX_ORIGINAL_BYTES = 256 * 1024 ** 2;
export const PHOTO_MAX_MASK_BYTES = 8 * 1024 ** 2;
export const PHOTO_MAX_PIXELS = 100_000_000;
export const PHOTO_MAX_MASK_EDGE = 4096;

const SHA256 = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const OBJECT_KEY_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const OBJECT_KEY_PARENT = /(^|\/)\.\.(\/|$)/;
const FILE_NAME_FORBIDDEN = /[\/\\\u0000-\u001f\u007f]/;
const PHOTO_FORMATS = ["jpeg", "png", "heic", "heif", "tiff", "raw"] as const;
const REJECTION_CODES = ["content_rejected", "unsupported_format", "pixel_limit_exceeded"] as const;
const GC_REASONS = ["copy_db_failure", "late_upload", "duplicate_copy", "cancelled_upload", "rejected_upload", "expired_upload"] as const;
// raster は contract fixture、RAW は SDK の neutralDevelopSettings(null, { raw: true }) と同じ初期値。
const RASTER_NEUTRAL_SETTINGS = {
  v: 1,
  engine: "niho-14",
  look: "niho-standard-1",
  base: null,
  exposure: 0,
  contrast: 0,
  saturation: 0,
  relativeTemperature: 0,
  relativeTint: 0,
  whiteBalance: { mode: "asShot" },
} as const;
const RAW_NEUTRAL_SETTINGS = { ...RASTER_NEUTRAL_SETTINGS, engine: "niho-2" } as const;
// 上記を RFC 8785 canonical JSON にした SHA-256。通常の JSON.stringify の property order hash ではない。
const RASTER_NEUTRAL_SETTINGS_SHA256 = "198b7c25b44f10770c7301d31d8144dfedbb0393288d3555b7ce1d17a35ca62c";
const RAW_NEUTRAL_SETTINGS_SHA256 = "3a383e927baab026edf69699800751b6ad03f3e1e055bcf6b102345c003631af";

export type PhotoFormat = (typeof PHOTO_FORMATS)[number];
export type PhotoUploadOperation = "original" | "mask";
export type PhotoUploadState = "reserved" | "verifying" | "stored" | "cancelled" | "expired" | "rejected";
export type PhotoRejectionCode = (typeof REJECTION_CODES)[number];
export type PhotoGcReason = (typeof GC_REASONS)[number];
export type PhotoStoreErrorCode =
  | "quota_exceeded"
  | "idempotency_conflict"
  | "upload_state_conflict"
  | "upload_expired"
  | "photo_trashed"
  | "account_deleting"
  | "revision_conflict"
  | "unsupported_settings"
  | "content_rejected";

export class PhotoStoreError extends Error {
  override readonly name = "PhotoStoreError";
  readonly code: PhotoStoreErrorCode;
  constructor(code: PhotoStoreErrorCode) {
    super(`editor-store: photo operation failed (${code})`);
    this.code = code;
  }
}

export type PhotoUsage = {
  quotaBytes: number;
  usedBytes: number;
  originalBytes: number;
  maskBytes: number;
  trashBytes: number;
  pendingPurgeBytes: number;
  reservedBytes: number;
  availableBytes: number;
};

export type PhotoLibraryRecord = {
  id: string;
  owner: OwnerId;
  state: "active" | "deleting";
  revision: number;
  lifecycleEpoch: number;
  nextPhotoSequence: number;
  usage: PhotoUsage;
  createdAt: string;
  updatedAt: string;
};

export type PhotoAssetRecord = {
  id: string;
  photoId: string;
  kind: "original" | "mask" | "thumbnail" | "preview" | "working-copy";
  sha256: string;
  sizeBytes: number;
  contentType: string;
  width: number;
  height: number;
  objectKey: string;
  objectGeneration: string;
  deletionState: "retained" | "pending" | "deleted";
  createdAt: string;
};

export type PhotoRecord = {
  id: string;
  libraryId: string;
  creationSequence: number;
  lifecycle: "active" | "trashed";
  lifecycleEpoch: number;
  fileName: string;
  format: PhotoFormat;
  width: number;
  height: number;
  capturedAt: string | null;
  addedAt: string;
  trashedAt: string | null;
  purgeAfter: string | null;
  recipeRevision: number;
  versionsRevision: number;
  original: PhotoAssetRecord;
};

export type PhotoUploadRecord = {
  id: string;
  operation: PhotoUploadOperation;
  targetPhotoId: string | null;
  state: PhotoUploadState;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  fileName: string | null;
  format: PhotoFormat | null;
  reservedBytes: number;
  leaseGeneration: number;
  verificationJobId: string | null;
  verificationLeaseUntil: string | null;
  expiresAt: string;
  resultPhotoId: string | null;
  resultAssetId: string | null;
  rejectionCode: PhotoRejectionCode | null;
  createdAt: string;
  updatedAt: string;
};

export type ReservePhotoUploadInput = {
  operation: PhotoUploadOperation;
  targetPhotoId?: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  fileName?: string;
  format?: PhotoFormat;
  idempotencyKey: string;
  requestHash: string;
};

export type ReservePhotoUploadResult =
  | { status: "created" | "replayed"; upload: PhotoUploadRecord }
  | { status: "existing"; photoId: string; assetId: string };

/** Values here must come from a server worker that read and verified every byte, not provider stat alone. */
export type VerifiedPhotoObject = {
  leaseGeneration: number;
  sha256: string;
  sizeBytes: number;
  objectKey: string;
  objectGeneration: string;
  contentType: string;
  format?: PhotoFormat;
  width: number;
  height: number;
  capturedAt?: string | null;
};

export type CompletePhotoUploadResult = {
  replayed: boolean;
  photoId: string;
  assetId: string;
  deduplicated: boolean;
};

export type PhotoPurgeJob = {
  id: string;
  photoId: string;
  state: "queued" | "running" | "completed" | "retrying";
  pendingBytes: number;
  lifecycleEpoch: number;
  createdAt: string;
  updatedAt: string;
};

export type PhotoGcObject = {
  id: string;
  uploadId: string | null;
  objectKey: string;
  objectGeneration: string;
  reason: PhotoGcReason;
  state: "pending" | "deleted";
  createdAt: string;
  deletedAt: string | null;
};

type LibraryRow = {
  owner: string;
  id: string;
  state: "active" | "deleting";
  quota_bytes: string;
  used_bytes: string;
  original_bytes: string;
  mask_bytes: string;
  trash_bytes: string;
  pending_purge_bytes: string;
  reserved_bytes: string;
  revision: string;
  next_photo_sequence: string;
  lifecycle_epoch: string;
  created_at: Date;
  updated_at: Date;
};

type AssetRow = {
  id: string;
  photo_id: string;
  kind: PhotoAssetRecord["kind"];
  sha256: string;
  size_bytes: string;
  content_type: string;
  width: number;
  height: number;
  object_key: string;
  object_generation: string;
  deletion_state: PhotoAssetRecord["deletionState"];
  created_at: Date;
};

type UploadRow = {
  id: string;
  operation: PhotoUploadOperation;
  target_photo_id: string | null;
  state: PhotoUploadState;
  declared_size_bytes: string;
  sha256: string;
  content_type: string;
  file_name: string | null;
  format: PhotoFormat | null;
  reserved_bytes: string;
  lease_generation: string;
  verification_job_id: string | null;
  verification_lease_until: Date | null;
  expires_at: Date;
  result_photo_id: string | null;
  result_asset_id: string | null;
  completed_lease_generation: string | null;
  completed_object_key?: string | null;
  completed_object_generation?: string | null;
  completed_content_type?: string | null;
  completed_format?: PhotoFormat | null;
  completed_width?: number | null;
  completed_height?: number | null;
  completed_captured_at?: Date | null;
  deduplicated?: boolean;
  rejection_code: PhotoRejectionCode | null;
  created_at: Date;
  updated_at: Date;
  request_hash?: string;
  library_lifecycle_epoch?: string;
  target_lifecycle_epoch?: string | null;
};

const LIBRARY_COLUMNS = `owner, id, state, quota_bytes::text AS quota_bytes, used_bytes::text AS used_bytes,
  original_bytes::text AS original_bytes, mask_bytes::text AS mask_bytes, trash_bytes::text AS trash_bytes,
  pending_purge_bytes::text AS pending_purge_bytes, reserved_bytes::text AS reserved_bytes,
  revision::text AS revision, next_photo_sequence::text AS next_photo_sequence,
  lifecycle_epoch::text AS lifecycle_epoch, created_at, updated_at`;
const ASSET_COLUMNS = `id, photo_id, kind, sha256, size_bytes::text AS size_bytes, content_type, width, height,
  object_key, object_generation, deletion_state, created_at`;
const UPLOAD_COLUMNS = `id, operation, target_photo_id, state, declared_size_bytes::text AS declared_size_bytes,
  sha256, content_type, file_name, format, reserved_bytes::text AS reserved_bytes,
  lease_generation::text AS lease_generation, verification_job_id, verification_lease_until, expires_at,
  result_photo_id, result_asset_id, completed_lease_generation::text AS completed_lease_generation,
  completed_object_key, completed_object_generation, completed_content_type, completed_format, completed_width, completed_height,
  completed_captured_at, deduplicated, rejection_code, created_at, updated_at`;

function number(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("editor-store: photo counter exceeds safe integer range");
  return parsed;
}

function toUsage(row: LibraryRow): PhotoUsage {
  const quotaBytes = number(row.quota_bytes);
  const usedBytes = number(row.used_bytes);
  const reservedBytes = number(row.reserved_bytes);
  return {
    quotaBytes,
    usedBytes,
    originalBytes: number(row.original_bytes),
    maskBytes: number(row.mask_bytes),
    trashBytes: number(row.trash_bytes),
    pendingPurgeBytes: number(row.pending_purge_bytes),
    reservedBytes,
    availableBytes: quotaBytes - usedBytes - reservedBytes,
  };
}

function toLibrary(row: LibraryRow): PhotoLibraryRecord {
  return {
    id: row.id,
    owner: row.owner,
    state: row.state,
    revision: number(row.revision),
    lifecycleEpoch: number(row.lifecycle_epoch),
    nextPhotoSequence: number(row.next_photo_sequence),
    usage: toUsage(row),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toAsset(row: AssetRow): PhotoAssetRecord {
  return {
    id: row.id,
    photoId: row.photo_id,
    kind: row.kind,
    sha256: row.sha256,
    sizeBytes: number(row.size_bytes),
    contentType: row.content_type,
    width: row.width,
    height: row.height,
    objectKey: row.object_key,
    objectGeneration: row.object_generation,
    deletionState: row.deletion_state,
    createdAt: row.created_at.toISOString(),
  };
}

function toUpload(row: UploadRow): PhotoUploadRecord {
  return {
    id: row.id,
    operation: row.operation,
    targetPhotoId: row.target_photo_id,
    state: row.state,
    sizeBytes: number(row.declared_size_bytes),
    sha256: row.sha256,
    contentType: row.content_type,
    fileName: row.file_name,
    format: row.format,
    reservedBytes: number(row.reserved_bytes),
    leaseGeneration: number(row.lease_generation),
    verificationJobId: row.verification_job_id,
    verificationLeaseUntil: row.verification_lease_until?.toISOString() ?? null,
    expiresAt: row.expires_at.toISOString(),
    resultPhotoId: row.result_photo_id,
    resultAssetId: row.result_asset_id,
    rejectionCode: row.rejection_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && isPageId(value);
}

function validPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validObjectLocator(key: unknown, generation: unknown): key is string {
  return typeof key === "string" && key.length >= 1 && key.length <= 1024 && !OBJECT_KEY_URL.test(key) && !OBJECT_KEY_PARENT.test(key)
    && typeof generation === "string" && generation.length >= 1 && generation.length <= 255;
}

function assertIdempotency(key: string, requestHash: string): void {
  if (!IDEMPOTENCY_KEY.test(key) || !SHA256.test(requestHash)) throw new TypeError("editor-store: invalid photo idempotency values");
}

function assertReserveInput(input: ReservePhotoUploadInput): void {
  if (!input || (input.operation !== "original" && input.operation !== "mask")) throw new TypeError("editor-store: invalid photo upload operation");
  if (!validPositiveSafeInteger(input.sizeBytes) || !SHA256.test(input.sha256)) throw new TypeError("editor-store: invalid photo upload bytes or digest");
  const maxBytes = input.operation === "original" ? PHOTO_MAX_ORIGINAL_BYTES : PHOTO_MAX_MASK_BYTES;
  if (input.sizeBytes > maxBytes) throw new TypeError("editor-store: photo upload exceeds the per-object limit");
  if (typeof input.contentType !== "string" || input.contentType.length > 255 || !CONTENT_TYPE.test(input.contentType)) {
    throw new TypeError("editor-store: invalid photo content type");
  }
  assertIdempotency(input.idempotencyKey, input.requestHash);
  if (input.operation === "original") {
    if (input.targetPhotoId !== undefined || typeof input.fileName !== "string" || Buffer.byteLength(input.fileName) < 1 || Buffer.byteLength(input.fileName) > 255
      || FILE_NAME_FORBIDDEN.test(input.fileName)
      || !PHOTO_FORMATS.includes(input.format as PhotoFormat)) throw new TypeError("editor-store: invalid original upload target");
  } else if (!validUuid(input.targetPhotoId) || input.fileName !== undefined || input.format !== undefined || input.contentType !== "image/png") {
    throw new TypeError("editor-store: invalid mask upload target");
  }
}

function assertVerifiedObject(value: VerifiedPhotoObject): void {
  if (!value || !Number.isSafeInteger(value.leaseGeneration) || value.leaseGeneration < 1 || !SHA256.test(value.sha256)
    || !validPositiveSafeInteger(value.sizeBytes) || !validObjectLocator(value.objectKey, value.objectGeneration)
    || typeof value.contentType !== "string" || value.contentType.length > 255 || !CONTENT_TYPE.test(value.contentType)
    || (value.format !== undefined && !PHOTO_FORMATS.includes(value.format))
    || !validPositiveSafeInteger(value.width) || !validPositiveSafeInteger(value.height)
    || value.width > PHOTO_MAX_PIXELS || value.height > PHOTO_MAX_PIXELS || value.width * value.height > PHOTO_MAX_PIXELS
    || (value.capturedAt !== undefined && value.capturedAt !== null && !Number.isFinite(Date.parse(value.capturedAt)))) {
    throw new TypeError("editor-store: invalid verified photo object");
  }
}

async function transaction<T>(db: Database, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollback(client);
      throw error;
    }
  } finally {
    client.release();
  }
}

async function lockLibrary(client: Queryable, owner: OwnerId): Promise<LibraryRow> {
  await client.query("INSERT INTO photo_libraries (owner) VALUES ($1) ON CONFLICT (owner) DO NOTHING", [owner]);
  const row = (await client.query<LibraryRow>(`SELECT ${LIBRARY_COLUMNS} FROM photo_libraries WHERE owner = $1 FOR UPDATE`, [owner])).rows[0];
  if (!row) throw new Error("editor-store: photo library lock returned no row");
  return row;
}

function assertLibraryActive(library: LibraryRow): void {
  if (library.state !== "active") throw new PhotoStoreError("account_deleting");
}

export async function getPhotoLibrary(db: Database, owner: OwnerId): Promise<PhotoLibraryRecord> {
  assertOwner(owner);
  return transaction(db, async (client) => toLibrary(await lockLibrary(client, owner)));
}

export async function getPhotoUsage(db: Database, owner: OwnerId): Promise<PhotoUsage> {
  return (await getPhotoLibrary(db, owner)).usage;
}

type PhotoJoinedRow = {
  id: string;
  library_id: string;
  creation_sequence: string;
  lifecycle: "active" | "trashed";
  lifecycle_epoch: string;
  file_name: string;
  format: PhotoFormat;
  width: number;
  height: number;
  captured_at: Date | null;
  added_at: Date;
  trashed_at: Date | null;
  purge_after: Date | null;
  recipe_revision: string;
  versions_revision: string;
  asset_id: string;
  asset_photo_id: string;
  asset_kind: PhotoAssetRecord["kind"];
  asset_sha256: string;
  asset_size_bytes: string;
  asset_content_type: string;
  asset_width: number;
  asset_height: number;
  asset_object_key: string;
  asset_object_generation: string;
  asset_deletion_state: PhotoAssetRecord["deletionState"];
  asset_created_at: Date;
};

function toPhoto(row: PhotoJoinedRow): PhotoRecord {
  return {
    id: row.id,
    libraryId: row.library_id,
    creationSequence: number(row.creation_sequence),
    lifecycle: row.lifecycle,
    lifecycleEpoch: number(row.lifecycle_epoch),
    fileName: row.file_name,
    format: row.format,
    width: row.width,
    height: row.height,
    capturedAt: row.captured_at?.toISOString() ?? null,
    addedAt: row.added_at.toISOString(),
    trashedAt: row.trashed_at?.toISOString() ?? null,
    purgeAfter: row.purge_after?.toISOString() ?? null,
    recipeRevision: number(row.recipe_revision),
    versionsRevision: number(row.versions_revision),
    original: toAsset({
      id: row.asset_id,
      photo_id: row.asset_photo_id,
      kind: row.asset_kind,
      sha256: row.asset_sha256,
      size_bytes: row.asset_size_bytes,
      content_type: row.asset_content_type,
      width: row.asset_width,
      height: row.asset_height,
      object_key: row.asset_object_key,
      object_generation: row.asset_object_generation,
      deletion_state: row.asset_deletion_state,
      created_at: row.asset_created_at,
    }),
  };
}

const PHOTO_SELECT = `SELECT p.id, p.library_id, p.creation_sequence::text AS creation_sequence, p.lifecycle,
  p.lifecycle_epoch::text AS lifecycle_epoch, p.file_name, p.format, p.width, p.height, p.captured_at,
  p.added_at, p.trashed_at, p.purge_after, p.recipe_revision::text AS recipe_revision,
  p.versions_revision::text AS versions_revision,
  a.id AS asset_id, a.photo_id AS asset_photo_id, a.kind AS asset_kind, a.sha256 AS asset_sha256,
  a.size_bytes::text AS asset_size_bytes, a.content_type AS asset_content_type, a.width AS asset_width,
  a.height AS asset_height, a.object_key AS asset_object_key, a.object_generation AS asset_object_generation,
  a.deletion_state AS asset_deletion_state, a.created_at AS asset_created_at
 FROM photos AS p
 JOIN photo_assets AS a ON a.owner = p.owner AND a.photo_id = p.id AND a.id = p.original_asset_id
 WHERE p.owner = $1 AND p.id = $2 AND p.lifecycle IN ('active', 'trashed') AND a.deletion_state = 'retained'`;

export async function getPhoto(db: Queryable, owner: OwnerId, photoId: string): Promise<PhotoRecord | null> {
  assertOwner(owner);
  if (!validUuid(photoId)) return null;
  const row = (await db.query<PhotoJoinedRow>(PHOTO_SELECT, [owner, photoId.toLowerCase()])).rows[0];
  return row ? toPhoto(row) : null;
}

export async function getPhotoAsset(db: Queryable, owner: OwnerId, photoId: string, assetId: string): Promise<PhotoAssetRecord | null> {
  assertOwner(owner);
  if (!validUuid(photoId) || !validUuid(assetId)) return null;
  const row = (await db.query<AssetRow>(
    `SELECT a.id, a.photo_id, a.kind, a.sha256, a.size_bytes::text AS size_bytes,
            a.content_type, a.width, a.height, a.object_key, a.object_generation,
            a.deletion_state, a.created_at
       FROM photo_assets AS a
      JOIN photos AS p ON p.owner = a.owner AND p.id = a.photo_id
     WHERE a.owner = $1 AND a.photo_id = $2 AND a.id = $3
       AND p.lifecycle IN ('active', 'trashed') AND a.deletion_state = 'retained'`,
    [owner, photoId.toLowerCase(), assetId.toLowerCase()],
  )).rows[0];
  return row ? toAsset(row) : null;
}

async function existingOriginal(client: Queryable, owner: OwnerId, sha256: string, sizeBytes: number): Promise<{ photoId: string; assetId: string; lifecycle: string } | null> {
  const row = (await client.query<{ photo_id: string; asset_id: string; lifecycle: string }>(
    `SELECT p.id AS photo_id, a.id AS asset_id, p.lifecycle
       FROM photo_assets AS a JOIN photos AS p ON p.owner = a.owner AND p.id = a.photo_id
      WHERE a.owner = $1 AND a.kind = 'original' AND a.sha256 = $2 AND a.size_bytes = $3
        AND a.deletion_state = 'retained' AND p.lifecycle IN ('active', 'trashed')`,
    [owner, sha256, sizeBytes],
  )).rows[0];
  return row ? { photoId: row.photo_id, assetId: row.asset_id, lifecycle: row.lifecycle } : null;
}

async function existingMask(client: Queryable, owner: OwnerId, photoId: string, sha256: string): Promise<{ photoId: string; assetId: string } | null> {
  const row = (await client.query<{ photo_id: string; asset_id: string }>(
    `SELECT a.photo_id, a.id AS asset_id FROM photo_assets AS a
      JOIN photos AS p ON p.owner = a.owner AND p.id = a.photo_id
     WHERE a.owner = $1 AND a.photo_id = $2 AND a.kind = 'mask' AND a.sha256 = $3
       AND a.deletion_state = 'retained' AND p.lifecycle = 'active'`,
    [owner, photoId, sha256],
  )).rows[0];
  return row ? { photoId: row.photo_id, assetId: row.asset_id } : null;
}

async function storedUploadResultIsCurrent(client: Queryable, owner: OwnerId, upload: UploadRow): Promise<boolean> {
  if (!upload.result_photo_id || !upload.result_asset_id) return false;
  const row = (await client.query<{ lifecycle: string; deletion_state: string }>(
    `SELECT p.lifecycle, a.deletion_state
       FROM photos AS p
       JOIN photo_assets AS a ON a.owner = p.owner AND a.photo_id = p.id AND a.id = $3
      WHERE p.owner = $1 AND p.id = $2`,
    [owner, upload.result_photo_id, upload.result_asset_id],
  )).rows[0];
  if (!row || row.lifecycle === "purging" || row.lifecycle === "purged" || row.deletion_state !== "retained") return false;
  if (row.lifecycle === "trashed") throw new PhotoStoreError("photo_trashed");
  return row.lifecycle === "active";
}

type ObjectLocatorState = {
  retired: boolean;
  asset: { owner: string; photoId: string; assetId: string } | null;
};

/** Serializes the physical generation across every owner and both the live-asset and GC tables. */
async function lockObjectLocator(client: Queryable, objectKey: string, objectGeneration: string): Promise<ObjectLocatorState> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended(octet_length($1)::text || ':' || $1 || $2, 0))",
    [objectKey, objectGeneration],
  );
  const retired = (await client.query(
    "SELECT 1 FROM photo_gc_objects WHERE object_key = $1 AND object_generation = $2",
    [objectKey, objectGeneration],
  )).rowCount !== 0;
  const asset = (await client.query<{ owner: string; photo_id: string; id: string }>(
    "SELECT owner, photo_id, id FROM photo_assets WHERE object_key = $1 AND object_generation = $2",
    [objectKey, objectGeneration],
  )).rows[0];
  return { retired, asset: asset ? { owner: asset.owner, photoId: asset.photo_id, assetId: asset.id } : null };
}

export async function lookupPhotoByOriginal(db: Queryable, owner: OwnerId, sha256: string, sizeBytes: number): Promise<PhotoRecord | null> {
  assertOwner(owner);
  if (!SHA256.test(sha256) || !validPositiveSafeInteger(sizeBytes)) throw new TypeError("editor-store: invalid photo lookup");
  const found = await existingOriginal(db, owner, sha256, sizeBytes);
  if (!found || found.lifecycle !== "active") return null;
  return getPhoto(db, owner, found.photoId);
}

/** A deduplicated start is still an idempotent success; generation zero denotes no incoming copy. */
async function recordExistingUploadStart(
  client: Queryable, owner: OwnerId, library: LibraryRow, input: ReservePhotoUploadInput,
  existing: { photoId: string; assetId: string }, targetLifecycleEpoch: number | null,
): Promise<ReservePhotoUploadResult> {
  await client.query(
    `INSERT INTO photo_uploads
       (owner, library_id, operation, target_photo_id, declared_size_bytes, sha256, content_type,
        file_name, format, idempotency_key, request_hash, reserved_bytes, library_lifecycle_epoch,
        target_lifecycle_epoch, state, result_photo_id, result_asset_id, completed_lease_generation,
        completed_object_key, completed_object_generation, completed_content_type, completed_format,
        completed_width, completed_height, completed_captured_at, deduplicated)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13, 'stored',
        p.id, a.id, 0, a.object_key, a.object_generation, a.content_type,
        CASE WHEN $3 = 'original' THEN p.format ELSE NULL END, a.width, a.height, p.captured_at, true
       FROM photos AS p JOIN photo_assets AS a ON a.owner = p.owner AND a.photo_id = p.id
      WHERE p.owner = $1 AND p.id = $14 AND a.id = $15`,
    [owner, library.id, input.operation, input.targetPhotoId ?? null, input.sizeBytes, input.sha256,
      input.contentType, input.fileName ?? null, input.format ?? null, input.idempotencyKey, input.requestHash,
      library.lifecycle_epoch, targetLifecycleEpoch, existing.photoId, existing.assetId],
  );
  return { status: "existing", photoId: existing.photoId, assetId: existing.assetId };
}

export async function reservePhotoUpload(db: Database, owner: OwnerId, input: ReservePhotoUploadInput): Promise<ReservePhotoUploadResult | null> {
  assertOwner(owner);
  assertReserveInput(input);
  return transaction(db, async (client) => {
    const library = await lockLibrary(client, owner);
    assertLibraryActive(library);

    const replay = (await client.query<UploadRow & { request_hash: string }>(
      `SELECT ${UPLOAD_COLUMNS}, request_hash FROM photo_uploads
        WHERE owner = $1 AND operation = $2 AND idempotency_key = $3`,
      [owner, input.operation, input.idempotencyKey],
    )).rows[0];
    if (replay) {
      if (replay.request_hash !== input.requestHash) throw new PhotoStoreError("idempotency_conflict");
      if (replay.state === "stored") {
        if (!(await storedUploadResultIsCurrent(client, owner, replay))) return null;
        if (number(replay.lease_generation) === 0 && replay.deduplicated) {
          return { status: "existing", photoId: replay.result_photo_id!, assetId: replay.result_asset_id! };
        }
      }
      return { status: "replayed", upload: toUpload(replay) };
    }

    let targetLifecycleEpoch: number | null = null;
    if (input.operation === "original") {
      const existing = await existingOriginal(client, owner, input.sha256, input.sizeBytes);
      if (existing?.lifecycle === "trashed") throw new PhotoStoreError("photo_trashed");
      if (existing) return recordExistingUploadStart(client, owner, library, input, existing, targetLifecycleEpoch);
    } else {
      const target = (await client.query<{ lifecycle: string; lifecycle_epoch: string }>(
        "SELECT lifecycle, lifecycle_epoch::text AS lifecycle_epoch FROM photos WHERE owner = $1 AND id = $2 FOR UPDATE",
        [owner, input.targetPhotoId],
      )).rows[0];
      if (!target) return null;
      if (target.lifecycle === "trashed") throw new PhotoStoreError("photo_trashed");
      if (target.lifecycle !== "active") return null;
      targetLifecycleEpoch = number(target.lifecycle_epoch);
      const existing = await existingMask(client, owner, input.targetPhotoId!, input.sha256);
      if (existing) return recordExistingUploadStart(client, owner, library, input, existing, targetLifecycleEpoch);
    }

    if (number(library.used_bytes) + number(library.reserved_bytes) + input.sizeBytes > number(library.quota_bytes)) {
      throw new PhotoStoreError("quota_exceeded");
    }
    const upload = (await client.query<UploadRow>(
      `INSERT INTO photo_uploads
         (owner, library_id, operation, target_photo_id, declared_size_bytes, sha256, content_type,
          file_name, format, idempotency_key, request_hash, reserved_bytes, library_lifecycle_epoch, target_lifecycle_epoch)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $5, $12, $13)
       RETURNING ${UPLOAD_COLUMNS}`,
      [owner, library.id, input.operation, input.targetPhotoId ?? null, input.sizeBytes, input.sha256, input.contentType,
        input.fileName ?? null, input.format ?? null, input.idempotencyKey, input.requestHash, library.lifecycle_epoch, targetLifecycleEpoch],
    )).rows[0];
    if (!upload) throw new Error("editor-store: photo upload insert returned no row");
    await client.query(
      `UPDATE photo_libraries SET reserved_bytes = reserved_bytes + $2, revision = revision + 1,
         updated_at = GREATEST(updated_at, clock_timestamp()) WHERE owner = $1`,
      [owner, input.sizeBytes],
    );
    return { status: "created", upload: toUpload(upload) };
  });
}

export async function getPhotoUpload(db: Queryable, owner: OwnerId, uploadId: string): Promise<PhotoUploadRecord | null> {
  assertOwner(owner);
  if (!validUuid(uploadId)) return null;
  const row = (await db.query<UploadRow>(`SELECT ${UPLOAD_COLUMNS} FROM photo_uploads WHERE owner = $1 AND id = $2`, [owner, uploadId.toLowerCase()])).rows[0];
  return row ? toUpload(row) : null;
}

export async function claimPhotoUploadVerification(
  db: Database,
  owner: OwnerId,
  uploadId: string,
  leaseSeconds = PHOTO_VERIFICATION_LEASE_MAX_SECONDS,
): Promise<PhotoUploadRecord | null> {
  assertOwner(owner);
  if (!validUuid(uploadId)) return null;
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > PHOTO_VERIFICATION_LEASE_MAX_SECONDS) {
    throw new TypeError("editor-store: invalid photo verification lease");
  }
  const result = await transaction<PhotoUploadRecord | null | "expired">(db, async (client) => {
    const library = await lockLibrary(client, owner);
    assertLibraryActive(library);
    const current = (await client.query<UploadRow & { library_lifecycle_epoch: string; target_lifecycle_epoch: string | null }>(
      `SELECT ${UPLOAD_COLUMNS}, library_lifecycle_epoch::text AS library_lifecycle_epoch,
          target_lifecycle_epoch::text AS target_lifecycle_epoch
         FROM photo_uploads WHERE owner = $1 AND id = $2 FOR UPDATE`,
      [owner, uploadId.toLowerCase()],
    )).rows[0];
    if (!current) return null;
    if (current.state === "expired") return "expired";
    if (current.state !== "reserved" && current.state !== "verifying") throw new PhotoStoreError("upload_state_conflict");
    const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
    if (current.expires_at <= now) {
      await releaseUpload(client, owner, current, "expired");
      return "expired";
    }
    if (number(current.library_lifecycle_epoch) !== number(library.lifecycle_epoch)) throw new PhotoStoreError("upload_state_conflict");
    if (current.operation === "mask") {
      if (!current.target_photo_id || current.target_lifecycle_epoch === null) throw new PhotoStoreError("upload_state_conflict");
      const target = (await client.query<{ lifecycle: string; lifecycle_epoch: string }>(
        "SELECT lifecycle, lifecycle_epoch::text AS lifecycle_epoch FROM photos WHERE owner = $1 AND id = $2 FOR UPDATE",
        [owner, current.target_photo_id],
      )).rows[0];
      if (target?.lifecycle === "trashed") throw new PhotoStoreError("photo_trashed");
      if (!target || target.lifecycle !== "active" || number(target.lifecycle_epoch) !== number(current.target_lifecycle_epoch)) {
        throw new PhotoStoreError("upload_state_conflict");
      }
    }
    if (current.state === "verifying" && current.verification_lease_until !== null && current.verification_lease_until > now) {
      throw new PhotoStoreError("upload_state_conflict");
    }
    const claimed = (await client.query<UploadRow>(
      `UPDATE photo_uploads SET state = 'verifying', lease_generation = lease_generation + 1,
          verification_job_id = gen_random_uuid(), verification_lease_until = clock_timestamp() + $3::int * interval '1 second',
          updated_at = GREATEST(updated_at, clock_timestamp())
        WHERE owner = $1 AND id = $2 RETURNING ${UPLOAD_COLUMNS}`,
      [owner, uploadId.toLowerCase(), leaseSeconds],
    )).rows[0];
    if (!claimed) throw new Error("editor-store: photo upload claim returned no row");
    return toUpload(claimed);
  });
  if (result === "expired") throw new PhotoStoreError("upload_expired");
  return result;
}

async function insertGc(
  client: Queryable,
  owner: OwnerId,
  input: { uploadId: string | null; objectKey: string; objectGeneration: string; reason: PhotoGcReason },
): Promise<string | null> {
  const locator = await lockObjectLocator(client, input.objectKey, input.objectGeneration);
  if (locator.asset) return null;
  if (locator.retired) {
    return (await client.query<{ id: string }>(
      "SELECT id FROM photo_gc_objects WHERE owner = $1 AND object_key = $2 AND object_generation = $3",
      [owner, input.objectKey, input.objectGeneration],
    )).rows[0]?.id ?? null;
  }
  const row = (await client.query<{ id: string }>(
    `INSERT INTO photo_gc_objects (owner, upload_id, object_key, object_generation, reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (object_key, object_generation) DO NOTHING
     RETURNING id`,
    [owner, input.uploadId, input.objectKey, input.objectGeneration, input.reason],
  )).rows[0];
  if (row) return row.id;
  return (await client.query<{ id: string }>(
    "SELECT id FROM photo_gc_objects WHERE owner = $1 AND object_key = $2 AND object_generation = $3",
    [owner, input.objectKey, input.objectGeneration],
  )).rows[0]?.id ?? null;
}

async function storeUploadResult(
  client: Queryable,
  owner: OwnerId,
  uploadId: string,
  leaseGeneration: number,
  photoId: string,
  assetId: string,
  verified: VerifiedPhotoObject,
  deduplicated: boolean,
): Promise<void> {
  await client.query(
    `UPDATE photo_uploads SET state = 'stored', reserved_bytes = 0, verification_job_id = NULL,
       verification_lease_until = NULL, result_photo_id = $4, result_asset_id = $5,
       completed_lease_generation = $3, completed_object_key = $6, completed_object_generation = $7,
       completed_content_type = $8, completed_format = $9, completed_width = $10, completed_height = $11, completed_captured_at = $12,
       deduplicated = $13, updated_at = GREATEST(updated_at, clock_timestamp())
     WHERE owner = $1 AND id = $2`,
    [owner, uploadId, leaseGeneration, photoId, assetId, verified.objectKey, verified.objectGeneration,
      verified.contentType, verified.format ?? null, verified.width, verified.height, verified.capturedAt ?? null, deduplicated],
  );
}

export async function completePhotoUpload(
  db: Database,
  owner: OwnerId,
  uploadId: string,
  verified: VerifiedPhotoObject,
): Promise<CompletePhotoUploadResult | null> {
  assertOwner(owner);
  if (!validUuid(uploadId)) return null;
  assertVerifiedObject(verified);
  const result = await transaction<CompletePhotoUploadResult | null | "expired">(db, async (client) => {
    const library = await lockLibrary(client, owner);
    assertLibraryActive(library);
    const current = (await client.query<UploadRow & { library_lifecycle_epoch: string; target_lifecycle_epoch: string | null }>(
      `SELECT ${UPLOAD_COLUMNS}, library_lifecycle_epoch::text AS library_lifecycle_epoch,
          target_lifecycle_epoch::text AS target_lifecycle_epoch
       FROM photo_uploads WHERE owner = $1 AND id = $2 FOR UPDATE`,
      [owner, uploadId.toLowerCase()],
    )).rows[0];
    if (!current) return null;

    if (current.state === "stored") {
      if (number(current.completed_lease_generation ?? "-1") !== verified.leaseGeneration || !current.result_photo_id || !current.result_asset_id) {
        throw new PhotoStoreError("upload_state_conflict");
      }
      if (current.sha256 !== verified.sha256 || number(current.declared_size_bytes) !== verified.sizeBytes
        || current.completed_object_key !== verified.objectKey || current.completed_object_generation !== verified.objectGeneration
        || current.completed_content_type !== verified.contentType || current.completed_format !== (verified.format ?? null)
        || current.completed_width !== verified.width || current.completed_height !== verified.height
        || (current.completed_captured_at?.toISOString() ?? null) !== (verified.capturedAt === undefined || verified.capturedAt === null ? null : new Date(verified.capturedAt).toISOString())) {
        throw new PhotoStoreError("upload_state_conflict");
      }
      if (!(await storedUploadResultIsCurrent(client, owner, current))) return null;
      return { replayed: true, photoId: current.result_photo_id, assetId: current.result_asset_id, deduplicated: current.deduplicated === true };
    }

    if (current.state === "expired") return "expired";
    if (current.state !== "verifying") throw new PhotoStoreError("upload_state_conflict");
    const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
    if (current.expires_at <= now) {
      await releaseUpload(client, owner, current, "expired");
      return "expired";
    }
    if (current.verification_lease_until === null || current.verification_lease_until <= now
      || number(current.lease_generation) !== verified.leaseGeneration
      || number(current.library_lifecycle_epoch ?? "-1") !== number(library.lifecycle_epoch)) {
      throw new PhotoStoreError("upload_state_conflict");
    }
    if (current.sha256 !== verified.sha256 || number(current.declared_size_bytes) !== verified.sizeBytes) {
      throw new PhotoStoreError("content_rejected");
    }
    if (current.operation === "original" && (verified.format === undefined || verified.format !== current.format)) throw new PhotoStoreError("content_rejected");
    if (current.operation === "mask" && (verified.format !== undefined || verified.contentType !== "image/png")) throw new PhotoStoreError("content_rejected");
    if (current.operation === "mask" && (verified.width > PHOTO_MAX_MASK_EDGE || verified.height > PHOTO_MAX_MASK_EDGE)) throw new PhotoStoreError("content_rejected");

    if (current.operation === "original") {
      const locator = await lockObjectLocator(client, verified.objectKey, verified.objectGeneration);
      if (locator.retired) throw new PhotoStoreError("upload_state_conflict");
      const duplicate = await existingOriginal(client, owner, verified.sha256, verified.sizeBytes);
      if (duplicate?.lifecycle === "trashed") throw new PhotoStoreError("photo_trashed");
      if (duplicate) {
        if (locator.asset && (locator.asset.owner !== owner || locator.asset.photoId !== duplicate.photoId || locator.asset.assetId !== duplicate.assetId)) {
          throw new PhotoStoreError("upload_state_conflict");
        }
        await storeUploadResult(client, owner, current.id, verified.leaseGeneration, duplicate.photoId, duplicate.assetId, verified, true);
        await client.query(
          `UPDATE photo_libraries SET reserved_bytes = reserved_bytes - $2, revision = revision + 1,
             updated_at = GREATEST(updated_at, clock_timestamp()) WHERE owner = $1`,
          [owner, verified.sizeBytes],
        );
        await insertGc(client, owner, { uploadId: current.id, objectKey: verified.objectKey, objectGeneration: verified.objectGeneration, reason: "duplicate_copy" });
        return { replayed: false, photoId: duplicate.photoId, assetId: duplicate.assetId, deduplicated: true };
      }
      if (locator.asset) throw new PhotoStoreError("upload_state_conflict");

      const photoId = randomUUID();
      const assetId = randomUUID();
      const sequence = number(library.next_photo_sequence);
      await client.query(
        `INSERT INTO photos
           (owner, id, library_id, original_asset_id, creation_sequence, file_name, format, width, height, captured_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [owner, photoId, library.id, assetId, sequence, current.file_name, verified.format, verified.width, verified.height, verified.capturedAt ?? null],
      );
      await client.query(
        `INSERT INTO photo_assets
           (owner, id, library_id, photo_id, kind, sha256, size_bytes, content_type, width, height,
            object_key, object_generation, counts_toward_quota)
         VALUES ($1, $2, $3, $4, 'original', $5, $6, $7, $8, $9, $10, $11, true)`,
        [owner, assetId, library.id, photoId, verified.sha256, verified.sizeBytes, verified.contentType,
          verified.width, verified.height, verified.objectKey, verified.objectGeneration],
      );
      const initialRecipe = verified.format === "raw"
        ? { settings: RAW_NEUTRAL_SETTINGS, settingsSha256: RAW_NEUTRAL_SETTINGS_SHA256 }
        : { settings: RASTER_NEUTRAL_SETTINGS, settingsSha256: RASTER_NEUTRAL_SETTINGS_SHA256 };
      await client.query(
        `INSERT INTO photo_recipe_revisions (owner, photo_id, revision, settings, settings_sha256, has_edits)
         VALUES ($1, $2, 0, $3::jsonb, $4, false)`,
        [owner, photoId, JSON.stringify(initialRecipe.settings), initialRecipe.settingsSha256],
      );
      await client.query(
        `INSERT INTO photo_recipes (owner, photo_id, revision, settings, settings_sha256, has_edits)
         VALUES ($1, $2, 0, $3::jsonb, $4, false)`,
        [owner, photoId, JSON.stringify(initialRecipe.settings), initialRecipe.settingsSha256],
      );
      await storeUploadResult(client, owner, current.id, verified.leaseGeneration, photoId, assetId, verified, false);
      await client.query(
        `UPDATE photo_libraries SET reserved_bytes = reserved_bytes - $2, used_bytes = used_bytes + $2,
           original_bytes = original_bytes + $2, next_photo_sequence = next_photo_sequence + 1,
           revision = revision + 1, updated_at = GREATEST(updated_at, clock_timestamp())
         WHERE owner = $1`,
        [owner, verified.sizeBytes],
      );
      return { replayed: false, photoId, assetId, deduplicated: false };
    }

    if (!current.target_photo_id || current.target_lifecycle_epoch === null) throw new PhotoStoreError("upload_state_conflict");
    const target = (await client.query<{ lifecycle: string; lifecycle_epoch: string }>(
      "SELECT lifecycle, lifecycle_epoch::text AS lifecycle_epoch FROM photos WHERE owner = $1 AND id = $2 FOR UPDATE",
      [owner, current.target_photo_id],
    )).rows[0];
    if (target?.lifecycle === "trashed") throw new PhotoStoreError("photo_trashed");
    if (!target || target.lifecycle !== "active" || number(target.lifecycle_epoch) !== number(current.target_lifecycle_epoch)) {
      throw new PhotoStoreError("upload_state_conflict");
    }
    const locator = await lockObjectLocator(client, verified.objectKey, verified.objectGeneration);
    if (locator.retired) throw new PhotoStoreError("upload_state_conflict");
    const duplicate = await existingMask(client, owner, current.target_photo_id, verified.sha256);
    if (duplicate) {
      if (locator.asset && (locator.asset.owner !== owner || locator.asset.photoId !== duplicate.photoId || locator.asset.assetId !== duplicate.assetId)) {
        throw new PhotoStoreError("upload_state_conflict");
      }
      await storeUploadResult(client, owner, current.id, verified.leaseGeneration, duplicate.photoId, duplicate.assetId, verified, true);
      await client.query(
        `UPDATE photo_libraries SET reserved_bytes = reserved_bytes - $2, revision = revision + 1,
           updated_at = GREATEST(updated_at, clock_timestamp()) WHERE owner = $1`,
        [owner, verified.sizeBytes],
      );
      await insertGc(client, owner, { uploadId: current.id, objectKey: verified.objectKey, objectGeneration: verified.objectGeneration, reason: "duplicate_copy" });
      return { replayed: false, photoId: duplicate.photoId, assetId: duplicate.assetId, deduplicated: true };
    }
    if (locator.asset) throw new PhotoStoreError("upload_state_conflict");
    const assetId = randomUUID();
    await client.query(
      `INSERT INTO photo_assets
         (owner, id, library_id, photo_id, kind, sha256, size_bytes, content_type, width, height,
          object_key, object_generation, counts_toward_quota)
       VALUES ($1, $2, $3, $4, 'mask', $5, $6, $7, $8, $9, $10, $11, true)`,
      [owner, assetId, library.id, current.target_photo_id, verified.sha256, verified.sizeBytes, verified.contentType,
        verified.width, verified.height, verified.objectKey, verified.objectGeneration],
    );
    await storeUploadResult(client, owner, current.id, verified.leaseGeneration, current.target_photo_id, assetId, verified, false);
    await client.query(
      `UPDATE photo_libraries SET reserved_bytes = reserved_bytes - $2, used_bytes = used_bytes + $2,
         mask_bytes = mask_bytes + $2, revision = revision + 1,
         updated_at = GREATEST(updated_at, clock_timestamp()) WHERE owner = $1`,
      [owner, verified.sizeBytes],
    );
    return { replayed: false, photoId: current.target_photo_id, assetId, deduplicated: false };
  });
  if (result === "expired") throw new PhotoStoreError("upload_expired");
  return result;
}

async function releaseUpload(client: Queryable, owner: OwnerId, upload: UploadRow, state: "cancelled" | "expired" | "rejected", rejectionCode?: PhotoRejectionCode): Promise<void> {
  const bytes = number(upload.reserved_bytes);
  await client.query(
    `UPDATE photo_uploads SET state = $3, reserved_bytes = 0, lease_generation = lease_generation + 1,
       verification_job_id = NULL, verification_lease_until = NULL, rejection_code = $4,
       updated_at = GREATEST(updated_at, clock_timestamp()) WHERE owner = $1 AND id = $2`,
    [owner, upload.id, state, rejectionCode ?? null],
  );
  if (bytes > 0) await client.query(
    `UPDATE photo_libraries SET reserved_bytes = reserved_bytes - $2, revision = revision + 1,
       updated_at = GREATEST(updated_at, clock_timestamp()) WHERE owner = $1`,
    [owner, bytes],
  );
}

export async function cancelPhotoUpload(db: Database, owner: OwnerId, uploadId: string): Promise<PhotoUploadRecord | null> {
  assertOwner(owner);
  if (!validUuid(uploadId)) return null;
  return transaction(db, async (client) => {
    await lockLibrary(client, owner);
    const current = (await client.query<UploadRow>(`SELECT ${UPLOAD_COLUMNS} FROM photo_uploads WHERE owner = $1 AND id = $2 FOR UPDATE`, [owner, uploadId])).rows[0];
    if (!current) return null;
    if (current.state === "cancelled") return toUpload(current);
    if (current.state !== "reserved" && current.state !== "verifying") throw new PhotoStoreError("upload_state_conflict");
    await releaseUpload(client, owner, current, "cancelled");
    const result = (await client.query<UploadRow>(`SELECT ${UPLOAD_COLUMNS} FROM photo_uploads WHERE owner = $1 AND id = $2`, [owner, uploadId])).rows[0]!;
    return toUpload(result);
  });
}

export async function rejectPhotoUpload(
  db: Database,
  owner: OwnerId,
  uploadId: string,
  leaseGeneration: number,
  code: PhotoRejectionCode,
): Promise<PhotoUploadRecord | null> {
  assertOwner(owner);
  if (!validUuid(uploadId)) return null;
  if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1 || !REJECTION_CODES.includes(code)) throw new TypeError("editor-store: invalid photo rejection");
  const result = await transaction<PhotoUploadRecord | null | "expired">(db, async (client) => {
    const library = await lockLibrary(client, owner);
    assertLibraryActive(library);
    const current = (await client.query<UploadRow & { library_lifecycle_epoch: string; target_lifecycle_epoch: string | null }>(
      `SELECT ${UPLOAD_COLUMNS}, library_lifecycle_epoch::text AS library_lifecycle_epoch,
          target_lifecycle_epoch::text AS target_lifecycle_epoch
         FROM photo_uploads WHERE owner = $1 AND id = $2 FOR UPDATE`,
      [owner, uploadId],
    )).rows[0];
    if (!current) return null;
    if (current.state === "expired") return "expired";
    if (current.state !== "verifying" || number(current.lease_generation) !== leaseGeneration) throw new PhotoStoreError("upload_state_conflict");
    const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
    if (current.expires_at <= now) {
      await releaseUpload(client, owner, current, "expired");
      return "expired";
    }
    if (current.verification_lease_until === null || current.verification_lease_until <= now
      || number(current.library_lifecycle_epoch) !== number(library.lifecycle_epoch)) {
      throw new PhotoStoreError("upload_state_conflict");
    }
    if (current.operation === "mask") {
      if (!current.target_photo_id || current.target_lifecycle_epoch === null) throw new PhotoStoreError("upload_state_conflict");
      const target = (await client.query<{ lifecycle: string; lifecycle_epoch: string }>(
        "SELECT lifecycle, lifecycle_epoch::text AS lifecycle_epoch FROM photos WHERE owner = $1 AND id = $2 FOR UPDATE",
        [owner, current.target_photo_id],
      )).rows[0];
      if (target?.lifecycle === "trashed") throw new PhotoStoreError("photo_trashed");
      if (!target || target.lifecycle !== "active" || number(target.lifecycle_epoch) !== number(current.target_lifecycle_epoch)) {
        throw new PhotoStoreError("upload_state_conflict");
      }
    }
    await releaseUpload(client, owner, current, "rejected", code);
    const result = (await client.query<UploadRow>(`SELECT ${UPLOAD_COLUMNS} FROM photo_uploads WHERE owner = $1 AND id = $2`, [owner, uploadId])).rows[0]!;
    return toUpload(result);
  });
  if (result === "expired") throw new PhotoStoreError("upload_expired");
  return result;
}

export async function expirePhotoUploads(db: Database, owner: OwnerId, limit = 100): Promise<number> {
  assertOwner(owner);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("editor-store: invalid photo expiry limit");
  return transaction(db, async (client) => {
    await lockLibrary(client, owner);
    const rows = (await client.query<UploadRow>(
      `SELECT ${UPLOAD_COLUMNS} FROM photo_uploads
        WHERE owner = $1 AND state IN ('reserved', 'verifying') AND expires_at <= clock_timestamp()
        ORDER BY expires_at, id FOR UPDATE SKIP LOCKED LIMIT $2`,
      [owner, limit],
    )).rows;
    for (const row of rows) await releaseUpload(client, owner, row, "expired");
    return rows.length;
  });
}

export type PhotoMutationInput = { idempotencyKey: string; requestHash: string };

async function mutationReplay(
  client: Queryable,
  owner: OwnerId,
  operation: "trash" | "restore" | "purge",
  photoId: string,
  input: PhotoMutationInput,
): Promise<string | null | undefined> {
  const row = (await client.query<{ request_hash: string; result_id: string | null }>(
    `SELECT request_hash, result_id FROM photo_mutations WHERE owner = $1 AND operation = $2 AND photo_id = $3 AND idempotency_key = $4`,
    [owner, operation, photoId, input.idempotencyKey],
  )).rows[0];
  if (!row) return undefined;
  if (row.request_hash !== input.requestHash) throw new PhotoStoreError("idempotency_conflict");
  return row.result_id;
}

async function recordMutation(client: Queryable, owner: OwnerId, operation: "trash" | "restore" | "purge", photoId: string, input: PhotoMutationInput, resultId: string | null): Promise<void> {
  await client.query(
    `INSERT INTO photo_mutations (owner, operation, photo_id, idempotency_key, request_hash, result_id) VALUES ($1, $2, $3, $4, $5, $6)`,
    [owner, operation, photoId, input.idempotencyKey, input.requestHash, resultId],
  );
}

async function retainedQuotaBytes(client: Queryable, owner: OwnerId, photoId: string): Promise<number> {
  const row = (await client.query<{ bytes: string }>(
    `SELECT COALESCE(sum(size_bytes) FILTER (WHERE counts_toward_quota AND deletion_state = 'retained'), 0)::text AS bytes
       FROM photo_assets WHERE owner = $1 AND photo_id = $2`,
    [owner, photoId],
  )).rows[0]!;
  return number(row.bytes);
}

export async function trashPhoto(db: Database, owner: OwnerId, photoId: string, input: PhotoMutationInput): Promise<{ replayed: boolean; photo: PhotoRecord } | null> {
  assertOwner(owner);
  if (!validUuid(photoId)) return null;
  assertIdempotency(input.idempotencyKey, input.requestHash);
  return transaction(db, async (client) => {
    const library = await lockLibrary(client, owner);
    assertLibraryActive(library);
    const replay = await mutationReplay(client, owner, "trash", photoId, input);
    if (replay !== undefined) {
      const photo = await getPhoto(client, owner, photoId);
      if (!photo || photo.lifecycle !== "trashed") throw new PhotoStoreError("upload_state_conflict");
      return { replayed: true, photo };
    }
    const current = (await client.query<{ lifecycle: string }>("SELECT lifecycle FROM photos WHERE owner = $1 AND id = $2 FOR UPDATE", [owner, photoId])).rows[0];
    if (!current || current.lifecycle !== "active") return null;
    const bytes = await retainedQuotaBytes(client, owner, photoId);
    await client.query(
      `UPDATE photos SET lifecycle = 'trashed', lifecycle_epoch = lifecycle_epoch + 1,
         trashed_at = clock_timestamp(), purge_after = clock_timestamp() + $3::int * interval '1 day'
       WHERE owner = $1 AND id = $2`,
      [owner, photoId, PHOTO_TRASH_RETENTION_DAYS],
    );
    await client.query(
      `UPDATE photo_libraries SET trash_bytes = trash_bytes + $2, revision = revision + 1,
         updated_at = GREATEST(updated_at, clock_timestamp()) WHERE owner = $1`,
      [owner, bytes],
    );
    await recordMutation(client, owner, "trash", photoId, input, null);
    const photo = await getPhoto(client, owner, photoId);
    if (!photo) throw new Error("editor-store: trashed photo disappeared");
    return { replayed: false, photo };
  });
}

export async function restorePhoto(db: Database, owner: OwnerId, photoId: string, input: PhotoMutationInput): Promise<{ replayed: boolean; photo: PhotoRecord } | null> {
  assertOwner(owner);
  if (!validUuid(photoId)) return null;
  assertIdempotency(input.idempotencyKey, input.requestHash);
  return transaction(db, async (client) => {
    const library = await lockLibrary(client, owner);
    assertLibraryActive(library);
    const replay = await mutationReplay(client, owner, "restore", photoId, input);
    if (replay !== undefined) {
      const photo = await getPhoto(client, owner, photoId);
      if (!photo || photo.lifecycle !== "active") throw new PhotoStoreError("upload_state_conflict");
      return { replayed: true, photo };
    }
    const current = (await client.query<{ lifecycle: string }>("SELECT lifecycle FROM photos WHERE owner = $1 AND id = $2 FOR UPDATE", [owner, photoId])).rows[0];
    if (!current || current.lifecycle !== "trashed") return null;
    const bytes = await retainedQuotaBytes(client, owner, photoId);
    await client.query(
      `UPDATE photos SET lifecycle = 'active', lifecycle_epoch = lifecycle_epoch + 1,
         trashed_at = NULL, purge_after = NULL WHERE owner = $1 AND id = $2`,
      [owner, photoId],
    );
    await client.query(
      `UPDATE photo_libraries SET trash_bytes = trash_bytes - $2, revision = revision + 1,
         updated_at = GREATEST(updated_at, clock_timestamp()) WHERE owner = $1`,
      [owner, bytes],
    );
    await recordMutation(client, owner, "restore", photoId, input, null);
    const photo = await getPhoto(client, owner, photoId);
    if (!photo) throw new Error("editor-store: restored photo disappeared");
    return { replayed: false, photo };
  });
}

function toPurgeJob(row: { id: string; photo_id: string; state: PhotoPurgeJob["state"]; pending_bytes: string; lifecycle_epoch: string; created_at: Date; updated_at: Date }): PhotoPurgeJob {
  return {
    id: row.id,
    photoId: row.photo_id,
    state: row.state,
    pendingBytes: number(row.pending_bytes),
    lifecycleEpoch: number(row.lifecycle_epoch),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const PURGE_COLUMNS = "id, photo_id, state, pending_bytes::text AS pending_bytes, lifecycle_epoch::text AS lifecycle_epoch, created_at, updated_at";

export async function beginPhotoPurge(db: Database, owner: OwnerId, photoId: string, input: PhotoMutationInput): Promise<{ replayed: boolean; job: PhotoPurgeJob } | null> {
  assertOwner(owner);
  if (!validUuid(photoId)) return null;
  assertIdempotency(input.idempotencyKey, input.requestHash);
  return transaction(db, async (client) => {
    const library = await lockLibrary(client, owner);
    const replay = await mutationReplay(client, owner, "purge", photoId, input);
    if (replay !== undefined) {
      if (!replay) throw new Error("editor-store: purge replay has no job");
      const row = (await client.query<Parameters<typeof toPurgeJob>[0]>(`SELECT ${PURGE_COLUMNS} FROM photo_purge_jobs WHERE owner = $1 AND id = $2`, [owner, replay])).rows[0];
      if (!row) throw new PhotoStoreError("upload_state_conflict");
      return { replayed: true, job: toPurgeJob(row) };
    }
    const current = (await client.query<{ lifecycle: string; lifecycle_epoch: string }>(
      "SELECT lifecycle, lifecycle_epoch::text AS lifecycle_epoch FROM photos WHERE owner = $1 AND id = $2 FOR UPDATE",
      [owner, photoId],
    )).rows[0];
    if (!current || (current.lifecycle !== "trashed" && !(current.lifecycle === "active" && library.state === "deleting"))) return null;
    const bytes = await retainedQuotaBytes(client, owner, photoId);
    const epoch = number(current.lifecycle_epoch) + 1;
    await client.query(
      `UPDATE photos SET lifecycle = 'purging', lifecycle_epoch = $3,
         trashed_at = COALESCE(trashed_at, clock_timestamp()),
         purge_after = COALESCE(purge_after, clock_timestamp())
       WHERE owner = $1 AND id = $2`,
      [owner, photoId, epoch],
    );
    await client.query(
      `UPDATE photo_assets SET deletion_state = 'pending', deletion_requested_at = clock_timestamp()
        WHERE owner = $1 AND photo_id = $2 AND deletion_state = 'retained'`,
      [owner, photoId],
    );
    const row = (await client.query<Parameters<typeof toPurgeJob>[0]>(
      `INSERT INTO photo_purge_jobs (owner, photo_id, lifecycle_epoch, pending_bytes)
       VALUES ($1, $2, $3, $4) RETURNING ${PURGE_COLUMNS}`,
      [owner, photoId, epoch, bytes],
    )).rows[0];
    if (!row) throw new Error("editor-store: photo purge insert returned no row");
    const trashDelta = current.lifecycle === "trashed" ? bytes : 0;
    await client.query(
      `UPDATE photo_libraries SET trash_bytes = trash_bytes - $3, pending_purge_bytes = pending_purge_bytes + $2,
         revision = revision + 1, updated_at = GREATEST(updated_at, clock_timestamp()) WHERE owner = $1`,
      [owner, bytes, trashDelta],
    );
    await recordMutation(client, owner, "purge", photoId, input, row.id);
    return { replayed: false, job: toPurgeJob(row) };
  });
}

export async function getPhotoPurgeJob(db: Queryable, owner: OwnerId, jobId: string): Promise<PhotoPurgeJob | null> {
  assertOwner(owner);
  if (!validUuid(jobId)) return null;
  const row = (await db.query<Parameters<typeof toPurgeJob>[0]>(`SELECT ${PURGE_COLUMNS} FROM photo_purge_jobs WHERE owner = $1 AND id = $2`, [owner, jobId])).rows[0];
  return row ? toPurgeJob(row) : null;
}

/** Internal deletion worklist. Locators stay behind the server boundary. */
export async function listPhotoPurgeAssets(db: Queryable, owner: OwnerId, jobId: string): Promise<PhotoAssetRecord[] | null> {
  assertOwner(owner);
  if (!validUuid(jobId)) return null;
  const job = (await db.query<{ photo_id: string }>("SELECT photo_id FROM photo_purge_jobs WHERE owner = $1 AND id = $2", [owner, jobId])).rows[0];
  if (!job) return null;
  return (await db.query<AssetRow>(
    `SELECT ${ASSET_COLUMNS} FROM photo_assets
      WHERE owner = $1 AND photo_id = $2 AND deletion_state = 'pending' ORDER BY id`,
    [owner, job.photo_id],
  )).rows.map(toAsset);
}

export async function confirmPhotoAssetDeleted(
  db: Database,
  owner: OwnerId,
  jobId: string,
  assetId: string,
  objectGeneration: string,
): Promise<PhotoPurgeJob | null> {
  assertOwner(owner);
  if (!validUuid(jobId) || !validUuid(assetId)) return null;
  if (typeof objectGeneration !== "string" || objectGeneration.length < 1 || objectGeneration.length > 255) throw new TypeError("editor-store: invalid object generation");
  return transaction(db, async (client) => {
    await lockLibrary(client, owner);
    const job = (await client.query<Parameters<typeof toPurgeJob>[0]>(
      `SELECT ${PURGE_COLUMNS} FROM photo_purge_jobs WHERE owner = $1 AND id = $2 FOR UPDATE`,
      [owner, jobId],
    )).rows[0];
    if (!job) return null;
    const asset = (await client.query<AssetRow & { counts_toward_quota: boolean }>(
      `SELECT ${ASSET_COLUMNS}, counts_toward_quota FROM photo_assets
        WHERE owner = $1 AND photo_id = $2 AND id = $3 FOR UPDATE`,
      [owner, job.photo_id, assetId],
    )).rows[0];
    if (!asset || asset.object_generation !== objectGeneration) return null;
    if (asset.deletion_state === "deleted") return toPurgeJob(job);
    if (asset.deletion_state !== "pending") return null;
    await client.query(
      `UPDATE photo_assets SET deletion_state = 'deleted', deleted_at = clock_timestamp()
        WHERE owner = $1 AND id = $2`,
      [owner, assetId],
    );
    const bytes = asset.counts_toward_quota ? number(asset.size_bytes) : 0;
    if (bytes > 0) {
      const column = asset.kind === "original" ? "original_bytes" : "mask_bytes";
      await client.query(
        `UPDATE photo_libraries SET used_bytes = used_bytes - $2, ${column} = ${column} - $2,
           pending_purge_bytes = pending_purge_bytes - $2, revision = revision + 1,
           updated_at = GREATEST(updated_at, clock_timestamp()) WHERE owner = $1`,
        [owner, bytes],
      );
      await client.query(
        `UPDATE photo_purge_jobs SET pending_bytes = pending_bytes - $3,
           updated_at = GREATEST(updated_at, clock_timestamp()) WHERE owner = $1 AND id = $2`,
        [owner, jobId, bytes],
      );
    }
    const left = (await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM photo_assets WHERE owner = $1 AND photo_id = $2 AND deletion_state = 'pending'`,
      [owner, job.photo_id],
    )).rows[0]!.count;
    if (left === 0) {
      await client.query(
        `UPDATE photos SET lifecycle = 'purged', purged_at = clock_timestamp() WHERE owner = $1 AND id = $2 AND lifecycle = 'purging'`,
        [owner, job.photo_id],
      );
      await client.query(
        `UPDATE photo_purge_jobs SET state = 'completed', pending_bytes = 0, completed_at = clock_timestamp(),
           updated_at = GREATEST(updated_at, clock_timestamp()) WHERE owner = $1 AND id = $2`,
        [owner, jobId],
      );
    }
    const updated = (await client.query<Parameters<typeof toPurgeJob>[0]>(`SELECT ${PURGE_COLUMNS} FROM photo_purge_jobs WHERE owner = $1 AND id = $2`, [owner, jobId])).rows[0]!;
    return toPurgeJob(updated);
  });
}

function toGc(row: { id: string; upload_id: string | null; object_key: string; object_generation: string; reason: PhotoGcReason; state: "pending" | "deleted"; created_at: Date; deleted_at: Date | null }): PhotoGcObject {
  return {
    id: row.id,
    uploadId: row.upload_id,
    objectKey: row.object_key,
    objectGeneration: row.object_generation,
    reason: row.reason,
    state: row.state,
    createdAt: row.created_at.toISOString(),
    deletedAt: row.deleted_at?.toISOString() ?? null,
  };
}

const GC_COLUMNS = "id, upload_id, object_key, object_generation, reason, state, created_at, deleted_at";

/** Internal reconciler worklist. */
export async function listPhotoOrphans(db: Queryable, owner: OwnerId, limit = 100): Promise<PhotoGcObject[]> {
  assertOwner(owner);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("editor-store: invalid photo orphan limit");
  return (await db.query<Parameters<typeof toGc>[0]>(
    `SELECT ${GC_COLUMNS} FROM photo_gc_objects AS gc
      WHERE gc.owner = $1 AND gc.state = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM photo_assets AS asset
           WHERE asset.object_key = gc.object_key AND asset.object_generation = gc.object_generation
        )
      ORDER BY gc.created_at, gc.id LIMIT $2`,
    [owner, limit],
  )).rows.map(toGc);
}

export async function recordPhotoOrphan(
  db: Database,
  owner: OwnerId,
  input: { uploadId?: string; objectKey: string; objectGeneration: string; reason: PhotoGcReason },
): Promise<PhotoGcObject | null> {
  assertOwner(owner);
  if (!validObjectLocator(input.objectKey, input.objectGeneration) || !GC_REASONS.includes(input.reason)) throw new TypeError("editor-store: invalid photo orphan");
  if (input.uploadId !== undefined && !validUuid(input.uploadId)) return null;
  return transaction(db, async (client) => {
    await lockLibrary(client, owner);
    if (input.uploadId !== undefined) {
      const found = (await client.query("SELECT 1 FROM photo_uploads WHERE owner = $1 AND id = $2", [owner, input.uploadId])).rowCount;
      if (!found) return null;
    }
    const id = await insertGc(client, owner, {
      uploadId: input.uploadId ?? null,
      objectKey: input.objectKey,
      objectGeneration: input.objectGeneration,
      reason: input.reason,
    });
    if (!id) return null;
    const row = (await client.query<Parameters<typeof toGc>[0]>(`SELECT ${GC_COLUMNS} FROM photo_gc_objects WHERE owner = $1 AND id = $2`, [owner, id])).rows[0]!;
    return toGc(row);
  });
}

export async function confirmPhotoOrphanDeleted(db: Database, owner: OwnerId, ledgerId: string, objectGeneration: string): Promise<PhotoGcObject | null> {
  assertOwner(owner);
  if (!validUuid(ledgerId)) return null;
  if (typeof objectGeneration !== "string" || objectGeneration.length < 1 || objectGeneration.length > 255) throw new TypeError("editor-store: invalid object generation");
  return transaction(db, async (client) => {
    await lockLibrary(client, owner);
    const row = (await client.query<Parameters<typeof toGc>[0]>(
      `SELECT ${GC_COLUMNS} FROM photo_gc_objects WHERE owner = $1 AND id = $2 FOR UPDATE`,
      [owner, ledgerId],
    )).rows[0];
    if (!row || row.object_generation !== objectGeneration) return null;
    const liveReference = (await client.query(
      "SELECT 1 FROM photo_assets WHERE object_key = $1 AND object_generation = $2",
      [row.object_key, row.object_generation],
    )).rowCount !== 0;
    if (liveReference) return null;
    if (row.state === "pending") await client.query(
      `UPDATE photo_gc_objects SET state = 'deleted', deleted_at = clock_timestamp() WHERE owner = $1 AND id = $2`,
      [owner, ledgerId],
    );
    const updated = (await client.query<Parameters<typeof toGc>[0]>(`SELECT ${GC_COLUMNS} FROM photo_gc_objects WHERE owner = $1 AND id = $2`, [owner, ledgerId])).rows[0]!;
    return toGc(updated);
  });
}

export async function markPhotoLibraryDeleting(db: Database, owner: OwnerId): Promise<PhotoLibraryRecord> {
  assertOwner(owner);
  return transaction(db, async (client) => {
    const library = await lockLibrary(client, owner);
    if (library.state === "active") {
      await client.query(
        `UPDATE photo_uploads SET state = 'cancelled', reserved_bytes = 0, lease_generation = lease_generation + 1,
           verification_job_id = NULL, verification_lease_until = NULL,
           updated_at = GREATEST(updated_at, clock_timestamp())
         WHERE owner = $1 AND state IN ('reserved', 'verifying')`,
        [owner],
      );
      await client.query(
        `UPDATE photos SET lifecycle_epoch = lifecycle_epoch + 1 WHERE owner = $1 AND lifecycle <> 'purged'`,
        [owner],
      );
      await client.query(
        `UPDATE photo_libraries SET state = 'deleting', reserved_bytes = 0, lifecycle_epoch = lifecycle_epoch + 1,
           revision = revision + 1, updated_at = GREATEST(updated_at, clock_timestamp()) WHERE owner = $1`,
        [owner],
      );
    }
    const updated = (await client.query<LibraryRow>(`SELECT ${LIBRARY_COLUMNS} FROM photo_libraries WHERE owner = $1`, [owner])).rows[0]!;
    return toLibrary(updated);
  });
}

// P02の公開可能な低層record。HTTP/SDK能力の組立てはserver adapterが担う。
export type PhotoJson = null | boolean | number | string | readonly PhotoJson[] | PhotoJsonObject;
export type PhotoJsonObject = { readonly [key: string]: PhotoJson };
export type PhotoRecipeRecord = {
  revision: number;
  settings: PhotoJsonObject & { readonly v: number; readonly engine: string };
  settingsSha256: string;
  baseVersion: string | null;
  maskSurfaceIds: readonly string[];
  updatedAt: string;
  hasEdits: boolean;
};
export type PhotoRecipeWrite = Omit<PhotoRecipeRecord, "revision" | "updatedAt" | "hasEdits"> & {
  /** Trusted pinned-SDK neutrality result. Absent values use the exact known neutral hash, otherwise edited. */
  hasEdits?: boolean;
};
export type PhotoVersionRecord = { id: string; name: string; kind: "named" | "auto"; recipe: PhotoRecipeRecord; createdAt: string };
export type PhotoVersionWrite = Pick<PhotoVersionRecord, "id" | "name" | "kind"> & { recipe: PhotoRecipeWrite };
export type PhotoVersionSetRecord = { revision: number; versions: PhotoVersionRecord[] };
export type PhotoMediaProjection = {
  id: string;
  state: "queued" | "processing" | "ready" | "failed" | "unsupported";
  recipeRevision: number;
  rendererManifestSha256: string;
  errorCode: "decoder_failed" | "renderer_unavailable" | "unsupported_settings" | null;
  ready: PhotoJsonObject | null;
  assets: PhotoAssetRecord[];
};
export type PhotoSnapshot = { library: PhotoLibraryRecord; photo: PhotoRecord; recipe: PhotoRecipeRecord; media: PhotoMediaProjection | null; hasEdits: boolean };
export type PhotoCatalogAfter =
  | { sort: "added-desc"; addedAt: string; id: string }
  | { sort: "captured-desc"; capturedAt: string | null; addedAt: string; id: string };
export type PhotoCatalogPageInput = {
  filter: {
    sort: "added-desc" | "captured-desc";
    lifecycle: "active" | "trashed";
    formats?: readonly PhotoFormat[];
    edited?: boolean;
    editable?: boolean;
    /** Trusted runtime capabilities, never public query values. Empty arrays fail closed. */
    editableEngines?: readonly string[];
    editableSettingsVersions?: readonly number[];
    editableBaseVersions?: readonly string[];
    maskSurfaces?: boolean;
  };
  watermark: number | null;
  after: PhotoCatalogAfter | null;
  limit: number;
};
export type PhotoCatalogPage = { library: PhotoLibraryRecord; watermark: number; items: PhotoSnapshot[]; hasMore: boolean };
export class PhotoRevisionConflictError extends PhotoStoreError {
  readonly currentRevision: number;
  constructor(currentRevision: number) { super("revision_conflict"); this.currentRevision = currentRevision; }
}

type RecipeRow = { revision: string; settings: PhotoRecipeRecord["settings"]; settings_sha256: string; base_version: string | null; mask_surface_ids: string[]; updated_at: Date; has_edits: boolean };
const RECIPE_COLUMNS = "revision::text AS revision, settings, settings_sha256, base_version, mask_surface_ids, updated_at, has_edits";
function toRecipe(row: RecipeRow): PhotoRecipeRecord {
  return { revision: number(row.revision), settings: row.settings, settingsSha256: row.settings_sha256, baseVersion: row.base_version,
    maskSurfaceIds: row.mask_surface_ids, updatedAt: row.updated_at.toISOString(), hasEdits: row.has_edits };
}
function photoCanonicalJson(value: PhotoJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(photoCanonicalJson).join(",")}]`;
  const object = value as PhotoJsonObject;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${photoCanonicalJson(object[key]!)}`).join(",")}}`;
}
function photoJsonHash(value: PhotoJson): string { return createHash("sha256").update(photoCanonicalJson(value)).digest("hex"); }
function assertPhotoJson(value: unknown, depth = 0): asserts value is PhotoJson {
  if (depth > 32) throw new TypeError("editor-store: photo JSON depth exceeded");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    // jsonbはU+0000と対にならないsurrogateを保持できない。DB例外の前に拒否する。
    if (value.includes("\u0000") || /[\ud800-\udfff]/u.test(value)) throw new TypeError("editor-store: invalid photo JSON scalar");
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) assertPhotoJson(item, depth + 1); return; }
  if (typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError("editor-store: invalid photo JSON");
  for (const [key, item] of Object.entries(value)) { assertPhotoJson(key, depth + 1); assertPhotoJson(item, depth + 1); }
}
function assertRecipeWrite(value: PhotoRecipeWrite): void {
  assertPhotoJson(value.settings);
  if (value.settings === null || Array.isArray(value.settings) || typeof value.settings !== "object"
    || !Number.isSafeInteger(value.settings.v) || typeof value.settings.engine !== "string"
    || !SHA256.test(value.settingsSha256) || photoJsonHash(value.settings) !== value.settingsSha256
    || Buffer.byteLength(photoCanonicalJson(value.settings)) > 1024 ** 2
    || !(value.baseVersion === null || (typeof value.baseVersion === "string" && value.baseVersion.length <= 512))
    || !Array.isArray(value.maskSurfaceIds) || value.maskSurfaceIds.some((id) => !SHA256.test(id))
    || new Set(value.maskSurfaceIds).size !== value.maskSurfaceIds.length || value.maskSurfaceIds.length > 16384
    || (value.hasEdits !== undefined && typeof value.hasEdits !== "boolean")) throw new TypeError("editor-store: invalid photo recipe");
}
function recipeWriteHasEdits(format: PhotoFormat, recipe: PhotoRecipeWrite): boolean {
  return recipe.hasEdits ?? recipe.settingsSha256 !== (format === "raw" ? RAW_NEUTRAL_SETTINGS_SHA256 : RASTER_NEUTRAL_SETTINGS_SHA256);
}
async function readPhotoSnapshot(client: Queryable, owner: OwnerId, photoId: string, library?: PhotoLibraryRecord): Promise<PhotoSnapshot | null> {
  const libraryRow = library ? undefined : (await client.query<LibraryRow>(`SELECT ${LIBRARY_COLUMNS} FROM photo_libraries WHERE owner = $1 AND state = 'active'`, [owner])).rows[0];
  if (!library && !libraryRow) return null;
  const actualLibrary = library ?? toLibrary(libraryRow!);
  if (actualLibrary.state !== "active") return null;
  const photo = await getPhoto(client, owner, photoId);
  if (!photo || photo.libraryId !== actualLibrary.id) return null;
  const row = (await client.query<RecipeRow>(`SELECT ${RECIPE_COLUMNS} FROM photo_recipes WHERE owner = $1 AND photo_id = $2 AND revision = $3`, [owner, photoId, photo.recipeRevision])).rows[0];
  if (!row) throw new Error("editor-store: photo current recipe missing");
  const recipe = toRecipe(row);
  const mediaRow = (await client.query<{ id: string; state: PhotoMediaProjection["state"]; recipe_revision: string; renderer_manifest_sha256: string; error_code: string | null; ready_media: PhotoJsonObject | null }>(
    `SELECT j.id, j.state, j.recipe_revision::text AS recipe_revision, j.renderer_manifest_sha256, j.error_code, j.ready_media
       FROM photos AS p JOIN photo_media_jobs AS j ON j.owner = p.owner AND j.id = p.current_media_job_id
      WHERE p.owner = $1 AND p.id = $2 AND j.lifecycle_epoch = p.lifecycle_epoch AND j.recipe_revision = p.recipe_revision
        AND j.settings_sha256 = $3 AND j.original_generation = $4 AND j.original_sha256 = $5 AND j.terminal_reason IS NULL`,
    [owner, photoId, recipe.settingsSha256, photo.original.objectGeneration, photo.original.sha256],
  )).rows[0];
  let media: PhotoMediaProjection | null = null;
  if (mediaRow) {
    const assetRows = mediaRow.state === "ready" ? (await client.query<AssetRow>(
      `SELECT ${ASSET_COLUMNS} FROM photo_assets WHERE owner = $1 AND photo_id = $2 AND id IN
         (SELECT id FROM photo_media_candidates WHERE owner = $1 AND job_id = $3 AND state = 'published') AND deletion_state = 'retained'`,
      [owner, photoId, mediaRow.id],
    )).rows : [];
    const publicCode = ["decoder_failed", "renderer_unavailable", "unsupported_settings"].includes(mediaRow.error_code ?? "") ? mediaRow.error_code as NonNullable<PhotoMediaProjection["errorCode"]> : null;
    media = { id: mediaRow.id, state: mediaRow.state, recipeRevision: number(mediaRow.recipe_revision), rendererManifestSha256: mediaRow.renderer_manifest_sha256,
      errorCode: publicCode, ready: mediaRow.ready_media, assets: assetRows.map(toAsset) };
  }
  return { library: actualLibrary, photo, recipe, media, hasEdits: recipe.hasEdits };
}
async function photoReadTransaction<T>(db: Database, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); try { const value = await run(client); await client.query("COMMIT"); return value; } catch (error) { await rollback(client); throw error; } }
  finally { client.release(); }
}
export async function getPhotoSnapshot(db: Database, owner: OwnerId, photoId: string): Promise<PhotoSnapshot | null> {
  assertOwner(owner); if (!validUuid(photoId)) return null;
  return photoReadTransaction(db, (client) => readPhotoSnapshot(client, owner, photoId.toLowerCase()));
}
export async function getPhotoInfo(db: Database, owner: OwnerId, photoId: string): Promise<{ capturedAt: string | null; width: number; height: number } | null> {
  const snapshot = await getPhotoSnapshot(db, owner, photoId);
  return snapshot ? { capturedAt: snapshot.photo.capturedAt, width: snapshot.photo.width, height: snapshot.photo.height } : null;
}
export async function lookupPhotoHashes(db: Queryable, owner: OwnerId, sha256s: readonly string[]): Promise<{ sha256: string; photoId: string; recipeRevision: number }[]> {
  assertOwner(owner);
  if (!Array.isArray(sha256s) || sha256s.length > 100 || sha256s.some((hash) => !SHA256.test(hash))) throw new TypeError("editor-store: invalid photo hash lookup");
  return (await db.query<{ sha256: string; id: string; recipe_revision: string }>(
    `SELECT a.sha256, p.id, p.recipe_revision::text AS recipe_revision FROM photo_assets AS a
       JOIN photos AS p ON p.owner = a.owner AND p.id = a.photo_id AND p.original_asset_id = a.id
       JOIN photo_libraries AS l ON l.owner = p.owner AND l.id = p.library_id
      WHERE a.owner = $1 AND a.sha256 = ANY($2::text[]) AND a.deletion_state = 'retained' AND p.lifecycle = 'active' AND l.state = 'active' ORDER BY a.sha256`,
    [owner, [...new Set(sha256s)]],
  )).rows.map((row) => ({ sha256: row.sha256, photoId: row.id, recipeRevision: number(row.recipe_revision) }));
}
export async function getPhotoUploadByStartKey(db: Queryable, owner: OwnerId, operation: PhotoUploadOperation, key: string): Promise<PhotoUploadRecord | null> {
  assertOwner(owner);
  if (!["original", "mask"].includes(operation) || !IDEMPOTENCY_KEY.test(key)) throw new TypeError("editor-store: invalid photo upload lookup");
  const row = (await db.query<UploadRow>(`SELECT ${UPLOAD_COLUMNS} FROM photo_uploads WHERE owner = $1 AND operation = $2 AND idempotency_key = $3 AND EXISTS (SELECT 1 FROM photo_libraries WHERE owner = $1 AND state = 'active')`, [owner, operation, key])).rows[0];
  return row ? toUpload(row) : null;
}
export async function getPhotoMaskBySurfaceId(db: Queryable, owner: OwnerId, photoId: string, surfaceId: string): Promise<PhotoAssetRecord | null> {
  assertOwner(owner); if (!validUuid(photoId) || !SHA256.test(surfaceId)) return null;
  const row = (await db.query<AssetRow>(
    `SELECT a.id, a.photo_id, a.kind, a.sha256, a.size_bytes::text AS size_bytes, a.content_type, a.width, a.height, a.object_key, a.object_generation, a.deletion_state, a.created_at
       FROM photo_assets AS a JOIN photos AS p ON p.owner = a.owner AND p.id = a.photo_id JOIN photo_libraries AS l ON l.owner = p.owner AND l.id = p.library_id
      WHERE a.owner = $1 AND a.photo_id = $2 AND a.sha256 = $3 AND a.kind = 'mask' AND a.deletion_state = 'retained' AND p.lifecycle IN ('active','trashed') AND l.state = 'active'`,
    [owner, photoId.toLowerCase(), surfaceId],
  )).rows[0]; return row ? toAsset(row) : null;
}
export async function bindPhotoRequest(db: Database, owner: OwnerId, input: { operation: "uploads.start" | "uploads.complete" | "uploads.cancel"; resourceId: string; key: string; requestHash: string }): Promise<boolean> {
  assertOwner(owner); assertIdempotency(input.key, input.requestHash);
  if (!["uploads.start", "uploads.complete", "uploads.cancel"].includes(input.operation)
    || (input.operation === "uploads.start" ? !["original", "mask"].includes(input.resourceId) : !validUuid(input.resourceId))) throw new TypeError("editor-store: invalid photo request journal resource");
  return transaction(db, async (client) => {
    assertLibraryActive(await lockLibrary(client, owner));
    if (input.operation !== "uploads.start" && !(await client.query("SELECT 1 FROM photo_uploads WHERE owner = $1 AND id = $2", [owner, input.resourceId])).rowCount) return false;
    const inserted = await client.query(`INSERT INTO photo_request_journal(owner, operation, resource_id, idempotency_key, request_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [owner, input.operation, input.resourceId.toLowerCase(), input.key, input.requestHash]);
    const row = (await client.query<{ request_hash: string }>("SELECT request_hash FROM photo_request_journal WHERE owner=$1 AND operation=$2 AND resource_id=$3 AND idempotency_key=$4", [owner, input.operation, input.resourceId.toLowerCase(), input.key])).rows[0]!;
    if (row.request_hash !== input.requestHash) throw new PhotoStoreError("idempotency_conflict");
    return inserted.rowCount === 0;
  });
}
export async function listPhotoCatalogPage(db: Database, owner: OwnerId, input: PhotoCatalogPageInput): Promise<PhotoCatalogPage | null> {
  assertOwner(owner);
  const f = input.filter;
  if (!["added-desc", "captured-desc"].includes(f.sort) || !["active", "trashed"].includes(f.lifecycle)
    || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100
    || (input.watermark !== null && (!Number.isSafeInteger(input.watermark) || input.watermark < 0))
    || (f.formats && (f.formats.length > 6 || f.formats.some((format) => !PHOTO_FORMATS.includes(format))))
    || (f.edited !== undefined && typeof f.edited !== "boolean") || (f.editable !== undefined && typeof f.editable !== "boolean")
    || (f.editableEngines && (f.editableEngines.length > 100 || f.editableEngines.some((engine) => typeof engine !== "string" || engine.length > 128)))
    || (f.editableSettingsVersions && (f.editableSettingsVersions.length > 100 || f.editableSettingsVersions.some((version) => !Number.isSafeInteger(version) || version < 0)))
    || (f.editableBaseVersions && (f.editableBaseVersions.length > 100 || f.editableBaseVersions.some((base) => typeof base !== "string" || base.length > 512)))
    || (input.after && (input.after.sort !== f.sort || !validUuid(input.after.id) || !Number.isFinite(Date.parse(input.after.addedAt))
      || (input.after.sort === "captured-desc" && input.after.capturedAt !== null && !Number.isFinite(Date.parse(input.after.capturedAt)))))) throw new TypeError("editor-store: invalid photo catalog query");
  return photoReadTransaction(db, async (client) => {
    const lib = (await client.query<LibraryRow>(`SELECT ${LIBRARY_COLUMNS} FROM photo_libraries WHERE owner=$1 AND state='active'`, [owner])).rows[0];
    if (!lib) return null;
    const library = toLibrary(lib), watermark = Math.min(input.watermark ?? library.nextPhotoSequence - 1, library.nextPhotoSequence - 1);
    const values: unknown[] = [owner, f.lifecycle, watermark];
    const where = ["p.owner=$1", "p.lifecycle=$2", "p.creation_sequence <= $3", "a.deletion_state='retained'"];
    const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
    if (f.formats) where.push(`p.format = ANY(${bind(f.formats)}::text[])`);
    if (f.edited !== undefined) where.push(`r.has_edits = ${bind(f.edited)}`);
    if (f.editable !== undefined) {
      const engines = bind(f.editableEngines ?? []), versions = bind((f.editableSettingsVersions ?? []).map(String)), bases = bind(f.editableBaseVersions ?? []), masks = bind(f.maskSurfaces === true);
      where.push(`((r.settings->>'engine') = ANY(${engines}::text[]) AND (r.settings->>'v') = ANY(${versions}::text[]) AND (r.base_version IS NULL OR r.base_version = ANY(${bases}::text[])) AND (${masks}::boolean OR jsonb_array_length(r.mask_surface_ids)=0)) = ${bind(f.editable)}`);
    }
    const addedSort = "date_trunc('milliseconds', p.added_at AT TIME ZONE 'UTC')";
    const capturedSort = "date_trunc('milliseconds', p.captured_at AT TIME ZONE 'UTC')";
    if (input.after) {
      const added = bind(input.after.addedAt), id = bind(input.after.id.toLowerCase());
      const tail = `(${addedSort}, p.id) < (${added}::timestamptz AT TIME ZONE 'UTC', ${id}::uuid)`;
      if (input.after.sort === "added-desc") where.push(tail);
      else if (input.after.capturedAt === null) where.push(`p.captured_at IS NULL AND ${tail}`);
      else { const captured = bind(input.after.capturedAt); where.push(`(p.captured_at IS NULL OR ${capturedSort} < ${captured}::timestamptz AT TIME ZONE 'UTC' OR (${capturedSort} = ${captured}::timestamptz AT TIME ZONE 'UTC' AND ${tail}))`); }
    }
    const order = f.sort === "added-desc" ? `${addedSort} DESC, p.id DESC` : `${capturedSort} DESC NULLS LAST, ${addedSort} DESC, p.id DESC`;
    const rows = (await client.query<{ id: string }>(`SELECT p.id FROM photos AS p JOIN photo_assets AS a ON a.owner=p.owner AND a.photo_id=p.id AND a.id=p.original_asset_id JOIN photo_recipes AS r ON r.owner=p.owner AND r.photo_id=p.id AND r.revision=p.recipe_revision WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${bind(input.limit + 1)}`, values)).rows;
    const items: PhotoSnapshot[] = [];
    for (const row of rows.slice(0, input.limit)) { const snapshot = await readPhotoSnapshot(client, owner, row.id, library); if (snapshot) items.push(snapshot); }
    return { library, watermark, items, hasMore: rows.length > input.limit };
  });
}
async function readPhotoVersions(client: Queryable, owner: OwnerId, photo: PhotoRecord): Promise<PhotoVersionSetRecord> {
  const rows = (await client.query<{ id: string; name: string; kind: PhotoVersionRecord["kind"]; recipe: PhotoRecipeRecord; created_at: Date }>("SELECT id,name,kind,recipe,created_at FROM photo_versions WHERE owner=$1 AND photo_id=$2 AND set_revision=$3 ORDER BY created_at,id", [owner, photo.id, photo.versionsRevision])).rows;
  return { revision: photo.versionsRevision, versions: rows.map((row) => ({ id: row.id, name: row.name, kind: row.kind, recipe: row.recipe, createdAt: row.created_at.toISOString() })) };
}
export async function getPhotoVersions(db: Database, owner: OwnerId, photoId: string): Promise<(PhotoSnapshot & { versions: PhotoVersionSetRecord }) | null> {
  assertOwner(owner); if (!validUuid(photoId)) return null;
  return photoReadTransaction(db, async (client) => { const snapshot = await readPhotoSnapshot(client, owner, photoId.toLowerCase()); return snapshot ? { ...snapshot, versions: await readPhotoVersions(client, owner, snapshot.photo) } : null; });
}
export async function listPhotoRecipeHistory(db: Database, owner: OwnerId, photoId: string, limit = 100): Promise<PhotoRecipeRecord[] | null> {
  assertOwner(owner); if (!validUuid(photoId)) return null;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("editor-store: invalid photo history limit");
  return photoReadTransaction(db, async (client) => { if (!(await readPhotoSnapshot(client, owner, photoId.toLowerCase()))) return null;
    return (await client.query<RecipeRow>(`SELECT revision::text AS revision,settings,settings_sha256,base_version,mask_surface_ids,created_at AS updated_at,has_edits FROM photo_recipe_revisions WHERE owner=$1 AND photo_id=$2 ORDER BY revision DESC LIMIT $3`, [owner, photoId, limit])).rows.map(toRecipe); });
}
async function photoWriteReplay(client: Queryable, owner: OwnerId, photoId: string, operation: "recipe" | "versions", key: string, requestHash: string): Promise<boolean> {
  const row = (await client.query<{ request_hash: string }>("SELECT request_hash FROM photo_write_receipts WHERE owner=$1 AND photo_id=$2 AND operation=$3 AND idempotency_key=$4", [owner, photoId, operation, key])).rows[0];
  if (!row) return false; if (row.request_hash !== requestHash) throw new PhotoStoreError("idempotency_conflict"); return true;
}
export async function replayPhotoWrite(db: Database, owner: OwnerId, photoId: string, operation: "recipe" | "versions", input: { key: string; requestHash: string }): Promise<(PhotoSnapshot & { versions: PhotoVersionSetRecord }) | null> {
  assertOwner(owner); assertIdempotency(input.key, input.requestHash); if (!validUuid(photoId)) return null;
  if (!["recipe", "versions"].includes(operation)) throw new TypeError("editor-store: invalid photo write operation");
  return photoReadTransaction(db, async (client) => { if (!(await photoWriteReplay(client, owner, photoId, operation, input.key, input.requestHash))) return null; const snapshot = await readPhotoSnapshot(client, owner, photoId); return snapshot ? { ...snapshot, versions: await readPhotoVersions(client, owner, snapshot.photo) } : null; });
}
async function assertPhotoMasks(client: Queryable, owner: OwnerId, photoId: string, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const count = (await client.query<{ count: number }>("SELECT count(DISTINCT sha256)::int AS count FROM photo_assets WHERE owner=$1 AND photo_id=$2 AND kind='mask' AND deletion_state='retained' AND sha256=ANY($3::text[])", [owner, photoId, ids])).rows[0]!.count;
  if (count !== ids.length) throw new PhotoStoreError("unsupported_settings");
}
export type PhotoRecipeMutationInput = { expectedRevision: number; key: string; requestHash: string; recipe: PhotoRecipeWrite };
export async function putPhotoRecipe(db: Database, owner: OwnerId, photoId: string, input: PhotoRecipeMutationInput): Promise<{ snapshot: PhotoSnapshot; replayed: boolean } | null> {
  return writePhotoRecipe(db, owner, photoId, input);
}
/** Trusted decoder only: establish a canonical base before any edit/version exists. Never exposed as a public recipe write. */
export async function bindPhotoCanonicalBase(db: Database, owner: OwnerId, photoId: string, input: PhotoRecipeMutationInput & {
  original: { assetId: string; generation: string; sha256: string };
}): Promise<{ snapshot: PhotoSnapshot; replayed: boolean } | null> {
  if (!validUuid(input.original.assetId) || !SHA256.test(input.original.sha256) || typeof input.original.generation !== "string"
    || input.original.generation.length < 1 || input.original.generation.length > 255) throw new TypeError("editor-store: invalid canonical base source");
  return writePhotoRecipe(db, owner, photoId, input, input.original);
}
async function writePhotoRecipe(db: Database, owner: OwnerId, photoId: string, input: PhotoRecipeMutationInput,
  canonicalSource?: { assetId: string; generation: string; sha256: string }): Promise<{ snapshot: PhotoSnapshot; replayed: boolean } | null> {
  assertOwner(owner); assertIdempotency(input.key, input.requestHash); assertRecipeWrite(input.recipe); if (!validUuid(photoId)) return null;
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new TypeError("editor-store: invalid expected recipe revision");
  return transaction(db, async (client) => {
    const library = await lockLibrary(client, owner); assertLibraryActive(library);
    const photo = (await client.query<{ lifecycle: string; recipe_revision: string }>("SELECT lifecycle,recipe_revision::text AS recipe_revision FROM photos WHERE owner=$1 AND id=$2 FOR UPDATE", [owner, photoId])).rows[0]; if (!photo) return null;
    if (canonicalSource) {
      const source = await getPhoto(client, owner, photoId); if (!source) return null;
      if (canonicalSource.assetId.toLowerCase() !== source.original.id || canonicalSource.generation !== source.original.objectGeneration || canonicalSource.sha256 !== source.original.sha256) throw new PhotoStoreError("upload_state_conflict");
    }
    if (await photoWriteReplay(client, owner, photoId, "recipe", input.key, input.requestHash)) { const snapshot = await readPhotoSnapshot(client, owner, photoId); return snapshot ? { snapshot, replayed: true } : null; }
    if (photo.lifecycle === "trashed") throw new PhotoStoreError("photo_trashed"); if (photo.lifecycle !== "active") return null;
    if (number(photo.recipe_revision) !== input.expectedRevision) throw new PhotoRevisionConflictError(number(photo.recipe_revision));
    const current = (await client.query<RecipeRow>(`SELECT ${RECIPE_COLUMNS} FROM photo_recipes WHERE owner=$1 AND photo_id=$2`, [owner, photoId])).rows[0]!;
    const currentPhoto = (await getPhoto(client, owner, photoId))!;
    if (canonicalSource) {
      if (input.expectedRevision !== 0 || current.has_edits || currentPhoto.versionsRevision !== 0 || current.base_version !== null
        || !["raw", "heic", "heif", "tiff"].includes(currentPhoto.format) || input.recipe.hasEdits !== false
        || typeof input.recipe.baseVersion !== "string" || input.recipe.baseVersion.length < 1 || input.recipe.maskSurfaceIds.length !== 0) throw new PhotoStoreError("unsupported_settings");
    } else if (input.recipe.baseVersion !== current.base_version) throw new PhotoStoreError("unsupported_settings");
    await assertPhotoMasks(client, owner, photoId, input.recipe.maskSurfaceIds);
    const revision = input.expectedRevision + 1; if (!Number.isSafeInteger(revision)) throw new TypeError("editor-store: photo revision overflow");
    const values = [owner, photoId, revision, JSON.stringify(input.recipe.settings), input.recipe.settingsSha256, input.recipe.baseVersion, JSON.stringify(input.recipe.maskSurfaceIds), recipeWriteHasEdits(currentPhoto.format, input.recipe)];
    await client.query("INSERT INTO photo_recipe_revisions(owner,photo_id,revision,settings,settings_sha256,base_version,mask_surface_ids,has_edits) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8)", values);
    await client.query("UPDATE photos SET recipe_revision=$3 WHERE owner=$1 AND id=$2", [owner, photoId, revision]);
    await client.query("UPDATE photo_recipes SET revision=$3,settings=$4::jsonb,settings_sha256=$5,base_version=$6,mask_surface_ids=$7::jsonb,has_edits=$8,updated_at=clock_timestamp() WHERE owner=$1 AND photo_id=$2", values);
    await client.query("INSERT INTO photo_write_receipts(owner,photo_id,operation,idempotency_key,request_hash,result_revision) VALUES($1,$2,'recipe',$3,$4,$5)", [owner, photoId, input.key, input.requestHash, revision]);
    await client.query("UPDATE photo_libraries SET revision=revision+1,updated_at=GREATEST(updated_at,clock_timestamp()) WHERE owner=$1", [owner]);
    return { snapshot: (await readPhotoSnapshot(client, owner, photoId))!, replayed: false };
  });
}
export async function putPhotoVersions(db: Database, owner: OwnerId, photoId: string, input: { expectedRevision: number; key: string; requestHash: string; versions: readonly PhotoVersionWrite[] }): Promise<{ versions: PhotoVersionSetRecord; replayed: boolean } | null> {
  assertOwner(owner); assertIdempotency(input.key, input.requestHash); if (!validUuid(photoId)) return null;
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !Array.isArray(input.versions) || input.versions.length > 100 || new Set(input.versions.map((version) => version.id.toLowerCase())).size !== input.versions.length) throw new TypeError("editor-store: invalid photo version set");
  for (const version of input.versions) { if (!validUuid(version.id) || !["named", "auto"].includes(version.kind) || typeof version.name !== "string" || Buffer.byteLength(version.name) < 1 || Buffer.byteLength(version.name) > 255) throw new TypeError("editor-store: invalid photo version"); assertRecipeWrite(version.recipe); }
  if (Buffer.byteLength(JSON.stringify(input.versions)) > 4 * 1024 ** 2) throw new TypeError("editor-store: photo version set too large");
  return transaction(db, async (client) => {
    const library = await lockLibrary(client, owner); assertLibraryActive(library);
    const photo = await getPhoto(client, owner, photoId); if (!photo) return null;
    await client.query("SELECT 1 FROM photos WHERE owner=$1 AND id=$2 FOR UPDATE", [owner, photoId]);
    if (await photoWriteReplay(client, owner, photoId, "versions", input.key, input.requestHash)) return { versions: await readPhotoVersions(client, owner, photo), replayed: true };
    if (photo.lifecycle !== "active") throw new PhotoStoreError("photo_trashed");
    if (photo.versionsRevision !== input.expectedRevision) throw new PhotoRevisionConflictError(photo.versionsRevision);
    const current = (await client.query<RecipeRow>(`SELECT ${RECIPE_COLUMNS} FROM photo_recipes WHERE owner=$1 AND photo_id=$2`, [owner, photoId])).rows[0]!;
    const maskIds = new Set<string>(); for (const version of input.versions) { if (version.recipe.baseVersion !== current.base_version) throw new PhotoStoreError("unsupported_settings"); for (const id of version.recipe.maskSurfaceIds) maskIds.add(id); }
    await assertPhotoMasks(client, owner, photoId, [...maskIds]);
    const previous = await readPhotoVersions(client, owner, photo), revision = input.expectedRevision + 1;
    if (!Number.isSafeInteger(revision)) throw new TypeError("editor-store: photo versions revision overflow");
    await client.query("DELETE FROM photo_versions WHERE owner=$1 AND photo_id=$2", [owner, photoId]);
    for (const version of input.versions) {
      const prior = previous.versions.find((item) => item.id === version.id.toLowerCase());
      const recipe: PhotoRecipeRecord = { ...version.recipe, revision: photo.recipeRevision, updatedAt: new Date().toISOString(), hasEdits: recipeWriteHasEdits(photo.format, version.recipe) };
      await client.query("INSERT INTO photo_versions(owner,photo_id,set_revision,id,name,kind,recipe,settings_sha256,base_version,mask_surface_ids,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,COALESCE($11::timestamptz,clock_timestamp()))", [owner, photoId, revision, version.id.toLowerCase(), version.name, version.kind, JSON.stringify(recipe), version.recipe.settingsSha256, version.recipe.baseVersion, JSON.stringify(version.recipe.maskSurfaceIds), prior?.createdAt ?? null]);
    }
    await client.query("UPDATE photos SET versions_revision=$3 WHERE owner=$1 AND id=$2", [owner, photoId, revision]);
    await client.query("INSERT INTO photo_write_receipts(owner,photo_id,operation,idempotency_key,request_hash,result_revision) VALUES($1,$2,'versions',$3,$4,$5)", [owner, photoId, input.key, input.requestHash, revision]);
    await client.query("UPDATE photo_libraries SET revision=revision+1,updated_at=GREATEST(updated_at,clock_timestamp()) WHERE owner=$1", [owner]);
    return { versions: await readPhotoVersions(client, owner, { ...photo, versionsRevision: revision }), replayed: false };
  });
}

export type PhotoMediaSource = {
  ownerId: string; photoId: string; lifecycle: "active" | "trashed" | "purged"; lifecycleGeneration: number;
  original: { assetId: string; generation: string; sha256: string; sizeBytes: number };
  format: PhotoFormat; width: number; height: number; baseVersion: string | null; recipe: PhotoRecipeRecord;
};
export type PhotoMediaIdentity = Omit<PhotoMediaSource, "lifecycle" | "recipe"> & {
  recipeRevision: number; settingsSha256: string; rendererManifestSha256: string;
  thumbnailMaxEdge: number; previewMaxEdge: number; workingCopyMaxEdge: number;
};
export type PhotoMediaClaim = { jobId: string; key: string; identity: PhotoMediaIdentity; generation: number; attempt: number; expiresAt: number };
export type PhotoMediaOutputSpec = { rendererManifestSha256: string; thumbnailMaxEdge: number; previewMaxEdge: number; workingCopyMaxEdge: number };
export type PhotoMediaAttemptFailure = "renderer_unavailable" | "unsupported_settings" | "decoder_failed" | "original_changed" | "timeout" | "cancelled" | "invalid_output" | "infrastructure_unavailable";
export type PhotoMediaCandidate = {
  owner: string; id: string; jobId: string; claimGeneration: number; kind: "thumbnail" | "preview" | "working-copy";
  sha256: string; sizeBytes: number; contentType: "image/jpeg" | "image/png"; width: number; height: number;
  objectKey: string; objectGeneration: string | null; state: "allocated" | "staged" | "published" | "abandoned" | "deleted";
};
export type PhotoMediaReadyWrite = {
  thumbnailId: string; previewId: string;
  workingCopy: { assetId: string; baseVersion: string; encoding: "png16" | "jpeg8"; meta: PhotoJsonObject } | null;
};
type MediaJobRow = {
  owner: string; id: string; photo_id: string; state: PhotoMediaProjection["state"]; lifecycle_epoch: string; library_lifecycle_epoch: string;
  original_asset_id: string; original_generation: string; original_sha256: string; original_size_bytes: string;
  source_format: PhotoFormat; source_width: number; source_height: number; base_version: string | null;
  recipe_revision: string; settings_sha256: string; renderer_manifest_sha256: string;
  output_spec: { thumbnailMaxEdge: number; previewMaxEdge: number; workingCopyMaxEdge: number }; output_spec_sha256: string;
  job_key: string; claim_generation: string; attempt_count: number; lease_until: Date | null; retry_at: Date | null;
  terminal_reason: string | null; error_code: string | null; now: Date;
};
const MEDIA_JOB_COLUMNS = `owner,id,photo_id,state,lifecycle_epoch::text AS lifecycle_epoch,library_lifecycle_epoch::text AS library_lifecycle_epoch,
  original_asset_id,original_generation,original_sha256,original_size_bytes::text AS original_size_bytes,source_format,source_width,source_height,
  base_version,recipe_revision::text AS recipe_revision,settings_sha256,renderer_manifest_sha256,output_spec,output_spec_sha256,
  job_key,claim_generation::text AS claim_generation,attempt_count,lease_until,retry_at,terminal_reason,error_code,clock_timestamp() AS now`;
function mediaSource(snapshot: PhotoSnapshot): PhotoMediaSource {
  const p = snapshot.photo;
  return { ownerId: snapshot.library.owner, photoId: p.id, lifecycle: p.lifecycle, lifecycleGeneration: p.lifecycleEpoch,
    original: { assetId: p.original.id, generation: p.original.objectGeneration, sha256: p.original.sha256, sizeBytes: p.original.sizeBytes },
    format: p.format, width: p.width, height: p.height, baseVersion: snapshot.recipe.baseVersion, recipe: snapshot.recipe };
}
function mediaIdentity(source: PhotoMediaSource, spec: PhotoMediaOutputSpec): PhotoMediaIdentity {
  return { ownerId: source.ownerId, photoId: source.photoId, lifecycleGeneration: source.lifecycleGeneration, original: source.original,
    format: source.format, width: source.width, height: source.height, baseVersion: source.baseVersion, recipeRevision: source.recipe.revision,
    settingsSha256: source.recipe.settingsSha256, ...spec };
}
function jobIdentity(row: MediaJobRow): PhotoMediaIdentity {
  return { ownerId: row.owner, photoId: row.photo_id, lifecycleGeneration: number(row.lifecycle_epoch),
    original: { assetId: row.original_asset_id, generation: row.original_generation, sha256: row.original_sha256, sizeBytes: number(row.original_size_bytes) },
    format: row.source_format, width: row.source_width, height: row.source_height, baseVersion: row.base_version,
    recipeRevision: number(row.recipe_revision), settingsSha256: row.settings_sha256, rendererManifestSha256: row.renderer_manifest_sha256, ...row.output_spec };
}
function mediaIdentityKey(identity: PhotoMediaIdentity): string { return photoJsonHash(identity as unknown as PhotoJson); }
function toMediaClaim(row: MediaJobRow): PhotoMediaClaim {
  return { jobId: row.id, key: row.job_key, identity: jobIdentity(row), generation: number(row.claim_generation), attempt: row.attempt_count, expiresAt: row.lease_until!.getTime() };
}
function assertMediaSpec(spec: PhotoMediaOutputSpec): void {
  if (!SHA256.test(spec.rendererManifestSha256) || !validPositiveSafeInteger(spec.thumbnailMaxEdge) || spec.thumbnailMaxEdge > 512
    || !validPositiveSafeInteger(spec.previewMaxEdge) || spec.previewMaxEdge > 1280
    || !validPositiveSafeInteger(spec.workingCopyMaxEdge) || spec.workingCopyMaxEdge > 2560) throw new TypeError("editor-store: invalid photo media output spec");
}
function assertMediaClaim(claim: PhotoMediaClaim): void {
  if (!validUuid(claim.jobId) || !SHA256.test(claim.key) || !validPositiveSafeInteger(claim.generation) || !validPositiveSafeInteger(claim.attempt)
    || !Number.isSafeInteger(claim.expiresAt) || claim.key !== mediaIdentityKey(claim.identity)) throw new TypeError("editor-store: invalid photo media claim");
}
async function sourceMatchesJob(client: Queryable, library: LibraryRow, row: MediaJobRow): Promise<boolean> {
  if (library.state !== "active" || library.lifecycle_epoch !== row.library_lifecycle_epoch) return false;
  const snapshot = await readPhotoSnapshot(client, row.owner, row.photo_id, toLibrary(library));
  if (!snapshot || snapshot.photo.lifecycle !== "active") return false;
  const current = (await client.query<{ current_media_job_id: string | null }>("SELECT current_media_job_id FROM photos WHERE owner=$1 AND id=$2", [row.owner, row.photo_id])).rows[0];
  return current?.current_media_job_id === row.id && mediaIdentityKey(mediaIdentity(mediaSource(snapshot), { rendererManifestSha256: row.renderer_manifest_sha256, ...row.output_spec })) === row.job_key;
}
async function currentClaimRow(client: Queryable, owner: OwnerId, claim: PhotoMediaClaim, requireLease: boolean): Promise<{ library: LibraryRow; row: MediaJobRow } | null> {
  const library = await lockLibrary(client, owner);
  const row = (await client.query<MediaJobRow>(`SELECT ${MEDIA_JOB_COLUMNS} FROM photo_media_jobs WHERE owner=$1 AND id=$2 FOR UPDATE`, [owner, claim.jobId])).rows[0];
  if (!row || row.job_key !== claim.key || row.state !== "processing" || row.terminal_reason !== null || number(row.claim_generation) !== claim.generation
    || row.attempt_count !== claim.attempt || row.owner !== claim.identity.ownerId || row.lease_until?.getTime() !== claim.expiresAt
    || (requireLease && row.lease_until.getTime() <= row.now.getTime())) return null;
  return { library, row };
}
export async function getPhotoMediaSource(db: Database, owner: OwnerId, photoId: string): Promise<PhotoMediaSource | null> {
  const snapshot = await getPhotoSnapshot(db, owner, photoId); return snapshot ? mediaSource(snapshot) : null;
}
export async function listPhotoMediaOutbox(db: Queryable, owner: OwnerId, limit = 100): Promise<{ photoId: string; lifecycleGeneration: number; recipeRevision: number; settingsSha256: string }[]> {
  assertOwner(owner); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("editor-store: invalid media outbox limit");
  return (await db.query<{ photo_id: string; lifecycle_epoch: string; recipe_revision: string; settings_sha256: string }>(
    `SELECT pending.photo_id,pending.lifecycle_epoch::text AS lifecycle_epoch,pending.recipe_revision::text AS recipe_revision,pending.settings_sha256
       FROM (
         SELECT o.photo_id,o.lifecycle_epoch,o.recipe_revision,o.settings_sha256,o.created_at AS queued_at
           FROM photo_media_outbox AS o JOIN photos AS p ON p.owner=o.owner AND p.id=o.photo_id
           JOIN photo_libraries AS l ON l.owner=p.owner AND l.id=p.library_id JOIN photo_recipes AS r ON r.owner=p.owner AND r.photo_id=p.id
          WHERE o.owner=$1 AND o.consumed_at IS NULL AND l.state='active' AND p.lifecycle='active'
            AND o.lifecycle_epoch=p.lifecycle_epoch AND o.recipe_revision=r.revision AND o.settings_sha256=r.settings_sha256
         UNION ALL
         SELECT p.id,p.lifecycle_epoch,r.revision,r.settings_sha256,p.added_at AS queued_at
           FROM photos AS p JOIN photo_libraries AS l ON l.owner=p.owner AND l.id=p.library_id
           JOIN photo_recipes AS r ON r.owner=p.owner AND r.photo_id=p.id
          WHERE p.owner=$1 AND l.state='active' AND p.lifecycle='active' AND p.current_media_job_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM photo_media_outbox AS o WHERE o.owner=p.owner AND o.photo_id=p.id AND o.consumed_at IS NULL
              AND o.lifecycle_epoch=p.lifecycle_epoch AND o.recipe_revision=r.revision AND o.settings_sha256=r.settings_sha256)
       ) AS pending
      ORDER BY pending.queued_at,pending.photo_id LIMIT $2`, [owner, limit],
  )).rows.map((row) => ({ photoId: row.photo_id, lifecycleGeneration: number(row.lifecycle_epoch), recipeRevision: number(row.recipe_revision), settingsSha256: row.settings_sha256 }));
}
export async function enqueuePhotoMediaJob(db: Database, owner: OwnerId, photoId: string, spec: PhotoMediaOutputSpec): Promise<{ id: string; key: string; created: boolean } | null> {
  assertOwner(owner); assertMediaSpec(spec); if (!validUuid(photoId)) return null;
  return transaction(db, async (client) => {
    const library = await lockLibrary(client, owner); assertLibraryActive(library);
    const snapshot = await readPhotoSnapshot(client, owner, photoId, toLibrary(library)); if (!snapshot) return null;
    if (snapshot.photo.lifecycle !== "active") throw new PhotoStoreError("photo_trashed");
    const identity = mediaIdentity(mediaSource(snapshot), spec), key = mediaIdentityKey(identity);
    const outputSpec = { thumbnailMaxEdge: spec.thumbnailMaxEdge, previewMaxEdge: spec.previewMaxEdge, workingCopyMaxEdge: spec.workingCopyMaxEdge };
    const inserted = (await client.query<{ id: string }>(
      `INSERT INTO photo_media_jobs(owner,photo_id,state,lifecycle_epoch,library_lifecycle_epoch,original_asset_id,original_generation,original_sha256,original_size_bytes,
        source_format,source_width,source_height,base_version,recipe_revision,settings_sha256,renderer_manifest_sha256,output_spec,output_spec_sha256,job_key)
       VALUES($1,$2,'queued',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18) ON CONFLICT DO NOTHING RETURNING id`,
      [owner, photoId, identity.lifecycleGeneration, library.lifecycle_epoch, identity.original.assetId, identity.original.generation, identity.original.sha256, identity.original.sizeBytes,
        identity.format, identity.width, identity.height, identity.baseVersion, identity.recipeRevision, identity.settingsSha256, identity.rendererManifestSha256,
        JSON.stringify(outputSpec), photoJsonHash(outputSpec), key],
    )).rows[0];
    let id = inserted?.id ?? (await client.query<{ id: string }>("SELECT id FROM photo_media_jobs WHERE owner=$1 AND job_key=$2", [owner, key])).rows[0]?.id;
    if (!id) {
      // 初期schema時代のjobにも同じconvergence identityを適用する。
      id = (await client.query<{ id: string }>(`UPDATE photo_media_jobs SET job_key=$9,state='queued',error_code=NULL,terminal_reason=NULL,ready_media=NULL
        WHERE owner=$1 AND photo_id=$2 AND lifecycle_epoch=$3 AND original_generation=$4 AND base_version IS NOT DISTINCT FROM $5
          AND recipe_revision=$6 AND settings_sha256=$7 AND renderer_manifest_sha256=$8 AND output_spec_sha256=$10 RETURNING id`,
        [owner, photoId, identity.lifecycleGeneration, identity.original.generation, identity.baseVersion, identity.recipeRevision, identity.settingsSha256, identity.rendererManifestSha256, key, photoJsonHash(outputSpec)])).rows[0]?.id;
    }
    if (!id) throw new Error("editor-store: media convergence key mismatch");
    const selected = await client.query<{ id: string }>(
      "UPDATE photos SET current_media_job_id=$3 WHERE owner=$1 AND id=$2 AND current_media_job_id IS DISTINCT FROM $3 RETURNING id",
      [owner, photoId, id],
    );
    await client.query("UPDATE photo_media_outbox SET consumed_at=COALESCE(consumed_at,clock_timestamp()) WHERE owner=$1 AND photo_id=$2 AND lifecycle_epoch=$3 AND recipe_revision=$4 AND settings_sha256=$5", [owner, photoId, identity.lifecycleGeneration, identity.recipeRevision, identity.settingsSha256]);
    if (selected.rows.length > 0) await client.query("UPDATE photo_libraries SET revision=revision+1,updated_at=GREATEST(updated_at,clock_timestamp()) WHERE owner=$1", [owner]);
    return { id, key, created: Boolean(inserted) };
  });
}
export async function listPendingPhotoMediaJobs(db: Queryable, owner: OwnerId, limit = 100): Promise<string[]> {
  assertOwner(owner); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("editor-store: invalid media job limit");
  return (await db.query<{ id: string }>(`SELECT j.id FROM photo_media_jobs AS j JOIN photos AS p ON p.owner=j.owner AND p.current_media_job_id=j.id JOIN photo_libraries AS l ON l.owner=p.owner
    WHERE j.owner=$1 AND l.state='active' AND p.lifecycle='active' AND j.terminal_reason IS NULL
      AND ((j.state='queued' AND j.attempt_count<3 AND (j.retry_at IS NULL OR j.retry_at<=clock_timestamp())) OR (j.state='processing' AND j.lease_until<=clock_timestamp()))
    ORDER BY j.created_at,j.id LIMIT $2`, [owner, limit])).rows.map((row) => row.id);
}
export async function claimPhotoMediaJob(db: Database, owner: OwnerId, jobId: string, leaseSeconds = 300): Promise<PhotoMediaClaim | null> {
  assertOwner(owner); if (!validUuid(jobId)) return null;
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 900) throw new TypeError("editor-store: invalid photo media lease");
  return transaction(db, async (client) => {
    const library = await lockLibrary(client, owner);
    const row = (await client.query<MediaJobRow>(`SELECT ${MEDIA_JOB_COLUMNS} FROM photo_media_jobs WHERE owner=$1 AND id=$2 FOR UPDATE`, [owner, jobId])).rows[0];
    if (!row || row.terminal_reason !== null || !["queued", "processing"].includes(row.state) || (row.state === "processing" && row.lease_until && row.lease_until > row.now) || (row.retry_at && row.retry_at > row.now)) return null;
    if (!(await sourceMatchesJob(client, library, row))) { await client.query("UPDATE photo_media_jobs SET state='failed',terminal_reason='superseded',claim_generation=claim_generation+1,lease_until=NULL,updated_at=clock_timestamp() WHERE owner=$1 AND id=$2", [owner, jobId]); return null; }
    if (row.attempt_count >= 3) { await client.query("UPDATE photo_media_jobs SET state='failed',error_code='renderer_unavailable',lease_until=NULL,updated_at=clock_timestamp() WHERE owner=$1 AND id=$2", [owner, jobId]);
      await client.query("UPDATE photo_libraries SET revision=revision+1,updated_at=GREATEST(updated_at,clock_timestamp()) WHERE owner=$1", [owner]); return null; }
    await client.query("UPDATE photo_media_candidates SET state='abandoned',updated_at=clock_timestamp() WHERE owner=$1 AND job_id=$2 AND state IN ('allocated','staged')", [owner, jobId]);
    const claimed = (await client.query<MediaJobRow>(`UPDATE photo_media_jobs SET state='processing',claim_generation=claim_generation+1,attempt_count=attempt_count+1,lease_until=clock_timestamp()+$3::int*interval '1 second',retry_at=NULL,error_code=NULL,updated_at=clock_timestamp() WHERE owner=$1 AND id=$2 RETURNING ${MEDIA_JOB_COLUMNS}`, [owner, jobId, leaseSeconds])).rows[0]!;
    await client.query("UPDATE photo_libraries SET revision=revision+1,updated_at=GREATEST(updated_at,clock_timestamp()) WHERE owner=$1", [owner]);
    return toMediaClaim(claimed);
  });
}
type CandidateRow = { owner: string; id: string; job_id: string; claim_generation: string; kind: PhotoMediaCandidate["kind"]; sha256: string; size_bytes: string; content_type: PhotoMediaCandidate["contentType"]; width: number; height: number; object_key: string; object_generation: string | null; state: PhotoMediaCandidate["state"] };
const CANDIDATE_COLUMNS = "owner,id,job_id,claim_generation::text AS claim_generation,kind,sha256,size_bytes::text AS size_bytes,content_type,width,height,object_key,object_generation,state";
function toCandidate(row: CandidateRow): PhotoMediaCandidate { return { owner: row.owner, id: row.id, jobId: row.job_id, claimGeneration: number(row.claim_generation), kind: row.kind, sha256: row.sha256, sizeBytes: number(row.size_bytes), contentType: row.content_type, width: row.width, height: row.height, objectKey: row.object_key, objectGeneration: row.object_generation, state: row.state }; }
export async function allocatePhotoMediaCandidate(db: Database, owner: OwnerId, claim: PhotoMediaClaim, input: Pick<PhotoMediaCandidate, "kind" | "sha256" | "sizeBytes" | "contentType" | "width" | "height" | "objectKey">): Promise<PhotoMediaCandidate | null> {
  assertOwner(owner); assertMediaClaim(claim);
  const maxEdge = input.kind === "thumbnail" ? claim.identity.thumbnailMaxEdge : input.kind === "preview" ? claim.identity.previewMaxEdge : claim.identity.workingCopyMaxEdge;
  if (!["thumbnail", "preview", "working-copy"].includes(input.kind) || !SHA256.test(input.sha256) || !validPositiveSafeInteger(input.sizeBytes) || input.sizeBytes > PHOTO_MAX_ORIGINAL_BYTES
    || !["image/jpeg", "image/png"].includes(input.contentType) || !validPositiveSafeInteger(input.width) || !validPositiveSafeInteger(input.height)
    || Math.max(input.width, input.height) > maxEdge || !validObjectLocator(input.objectKey, "pending")) throw new TypeError("editor-store: invalid media candidate");
  return transaction(db, async (client) => { const locked = await currentClaimRow(client, owner, claim, true); if (!locked || !(await sourceMatchesJob(client, locked.library, locked.row))) return null;
    const row = (await client.query<CandidateRow>(`INSERT INTO photo_media_candidates(owner,job_id,claim_generation,kind,sha256,size_bytes,content_type,width,height,object_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${CANDIDATE_COLUMNS}`, [owner, claim.jobId, claim.generation, input.kind, input.sha256, input.sizeBytes, input.contentType, input.width, input.height, input.objectKey])).rows[0]!; return toCandidate(row); });
}
export async function stagePhotoMediaCandidate(db: Database, owner: OwnerId, claim: PhotoMediaClaim, candidateId: string, generation: string): Promise<PhotoMediaCandidate | null> {
  assertOwner(owner); assertMediaClaim(claim); if (!validUuid(candidateId)) return null;
  if (typeof generation !== "string" || generation.length < 1 || generation.length > 255) throw new TypeError("editor-store: invalid media object generation");
  return transaction(db, async (client) => { const library = await lockLibrary(client, owner);
    const row = (await client.query<CandidateRow>(`SELECT ${CANDIDATE_COLUMNS} FROM photo_media_candidates WHERE owner=$1 AND id=$2 AND job_id=$3 AND claim_generation=$4 FOR UPDATE`, [owner, candidateId, claim.jobId, claim.generation])).rows[0];
    if (!row || (row.object_generation !== null && row.object_generation !== generation) || ["published", "deleted"].includes(row.state)) return row?.state === "published" && row.object_generation === generation ? toCandidate(row) : null;
    const job = (await client.query<MediaJobRow>(`SELECT ${MEDIA_JOB_COLUMNS} FROM photo_media_jobs WHERE owner=$1 AND id=$2 FOR UPDATE`, [owner, claim.jobId])).rows[0];
    const active = row.state !== "abandoned" && job && job.job_key === claim.key && number(job.claim_generation) === claim.generation && job.state === "processing" && job.lease_until && job.lease_until > job.now && await sourceMatchesJob(client, library, job);
    const updated = (await client.query<CandidateRow>(`UPDATE photo_media_candidates SET object_generation=$3,state=$4,updated_at=clock_timestamp() WHERE owner=$1 AND id=$2 RETURNING ${CANDIDATE_COLUMNS}`, [owner, candidateId, generation, active ? "staged" : "abandoned"])).rows[0]!; return toCandidate(updated); });
}
export async function abandonPhotoMediaCandidates(db: Database, owner: OwnerId, claim: PhotoMediaClaim, candidateIds?: readonly string[]): Promise<number> {
  assertOwner(owner); assertMediaClaim(claim); if (candidateIds && (candidateIds.length > 3 || candidateIds.some((id) => !validUuid(id)))) throw new TypeError("editor-store: invalid media candidate ids");
  return transaction(db, async (client) => { await lockLibrary(client, owner); return (await client.query(`UPDATE photo_media_candidates SET state='abandoned',updated_at=clock_timestamp() WHERE owner=$1 AND job_id=$2 AND claim_generation=$3 AND state IN ('allocated','staged') ${candidateIds ? "AND id=ANY($4::uuid[])" : ""}`, candidateIds ? [owner, claim.jobId, claim.generation, candidateIds] : [owner, claim.jobId, claim.generation])).rowCount ?? 0; });
}
export async function listPhotoMediaCandidateCleanup(db: Queryable, owner: OwnerId, limit = 100): Promise<PhotoMediaCandidate[]> {
  assertOwner(owner); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("editor-store: invalid media cleanup limit");
  return (await db.query<CandidateRow>(`SELECT ${CANDIDATE_COLUMNS} FROM photo_media_candidates AS c WHERE c.owner=$1 AND c.state='abandoned' AND NOT EXISTS (SELECT 1 FROM photo_assets AS a WHERE a.object_key=c.object_key AND a.object_generation=c.object_generation) ORDER BY c.created_at,c.id LIMIT $2`, [owner, limit])).rows.map(toCandidate);
}
export async function confirmPhotoMediaCandidateDeleted(db: Database, owner: OwnerId, id: string, generation: string): Promise<boolean> {
  assertOwner(owner); if (!validUuid(id)) return false;
  return transaction(db, async (client) => { await lockLibrary(client, owner); return (await client.query("UPDATE photo_media_candidates AS c SET state='deleted',updated_at=clock_timestamp() WHERE owner=$1 AND id=$2 AND object_generation=$3 AND state='abandoned' AND NOT EXISTS (SELECT 1 FROM photo_assets AS a WHERE a.object_key=c.object_key AND a.object_generation=c.object_generation)", [owner, id, generation])).rowCount === 1; });
}
export async function publishPhotoMediaJob(db: Database, owner: OwnerId, claim: PhotoMediaClaim, media: PhotoMediaReadyWrite, objects: readonly { id: string; generation: string }[], deadlineAt: number): Promise<boolean> {
  assertOwner(owner); assertMediaClaim(claim);
  const ids = [media.thumbnailId, media.previewId, ...(media.workingCopy ? [media.workingCopy.assetId] : [])];
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt > claim.expiresAt || ids.some((id) => !validUuid(id)) || new Set(ids).size !== ids.length
    || objects.length !== ids.length || new Set(objects.map((item) => item.id)).size !== objects.length || objects.some((item) => !ids.includes(item.id) || typeof item.generation !== "string" || item.generation.length < 1 || item.generation.length > 255)) throw new TypeError("editor-store: invalid photo media publication");
  if (!["jpeg", "png"].includes(claim.identity.format) && !media.workingCopy) throw new TypeError("editor-store: working copy required for photo format");
  if (media.workingCopy) { assertPhotoJson(media.workingCopy.meta); if (!['png16','jpeg8'].includes(media.workingCopy.encoding) || media.workingCopy.baseVersion !== claim.identity.baseVersion || Buffer.byteLength(photoCanonicalJson(media.workingCopy.meta)) > 64 * 1024) throw new TypeError("editor-store: invalid working copy publication"); }
  return transaction(db, async (client) => {
    const locked = await currentClaimRow(client, owner, claim, true); if (!locked || locked.row.now.getTime() >= deadlineAt || !(await sourceMatchesJob(client, locked.library, locked.row))) return false;
    const candidates = (await client.query<CandidateRow>(`SELECT ${CANDIDATE_COLUMNS} FROM photo_media_candidates WHERE owner=$1 AND job_id=$2 AND claim_generation=$3 AND id=ANY($4::uuid[]) ORDER BY id FOR UPDATE`, [owner, claim.jobId, claim.generation, ids])).rows;
    if (candidates.length !== ids.length || candidates.some((row) => row.state !== "staged" || row.object_generation !== objects.find((item) => item.id === row.id)?.generation
      || row.kind !== (row.id === media.thumbnailId ? "thumbnail" : row.id === media.previewId ? "preview" : "working-copy"))) return false;
    for (const row of candidates) {
      const locator = await lockObjectLocator(client, row.object_key, row.object_generation!); if (locator.retired || locator.asset) return false;
    }
    for (const row of candidates) await client.query(`INSERT INTO photo_assets(owner,id,library_id,photo_id,kind,sha256,size_bytes,content_type,width,height,object_key,object_generation,counts_toward_quota) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false)`, [owner, row.id, locked.library.id, claim.identity.photoId, row.kind, row.sha256, row.size_bytes, row.content_type, row.width, row.height, row.object_key, row.object_generation]);
    await client.query("UPDATE photo_media_candidates SET state='published',updated_at=clock_timestamp() WHERE owner=$1 AND id=ANY($2::uuid[])", [owner, ids]);
    await client.query("UPDATE photo_media_jobs SET state='ready',ready_media=$3::jsonb,canonical_metadata=$4::jsonb,error_code=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE owner=$1 AND id=$2", [owner, claim.jobId, JSON.stringify(media), media.workingCopy ? JSON.stringify(media.workingCopy.meta) : null]);
    await client.query("UPDATE photo_libraries SET revision=revision+1,updated_at=GREATEST(updated_at,clock_timestamp()) WHERE owner=$1", [owner]);
    return true;
  });
}
export async function supersedePhotoMediaJob(db: Database, owner: OwnerId, claim: PhotoMediaClaim): Promise<boolean> {
  assertOwner(owner); assertMediaClaim(claim);
  return transaction(db, async (client) => { const locked = await currentClaimRow(client, owner, claim, true); if (!locked) return false;
    await client.query("UPDATE photo_media_jobs SET state='failed',terminal_reason='superseded',lease_until=NULL,updated_at=clock_timestamp() WHERE owner=$1 AND id=$2", [owner, claim.jobId]);
    await client.query("UPDATE photo_media_candidates SET state='abandoned',updated_at=clock_timestamp() WHERE owner=$1 AND job_id=$2 AND claim_generation=$3 AND state IN ('allocated','staged')", [owner, claim.jobId, claim.generation]); return true; });
}
export async function failPhotoMediaJob(db: Database, owner: OwnerId, claim: PhotoMediaClaim, code: PhotoMediaAttemptFailure, retryAt: number | null): Promise<boolean> {
  assertOwner(owner); assertMediaClaim(claim);
  const retryable = ["renderer_unavailable", "timeout", "infrastructure_unavailable"].includes(code);
  if (!["renderer_unavailable", "unsupported_settings", "decoder_failed", "original_changed", "timeout", "cancelled", "invalid_output", "infrastructure_unavailable"].includes(code)
    || (retryAt !== null && (!retryable || !Number.isSafeInteger(retryAt) || Math.abs(retryAt) > 8.64e15))) throw new TypeError("editor-store: invalid media attempt failure");
  return transaction(db, async (client) => { const locked = await currentClaimRow(client, owner, claim, true); if (!locked || !(await sourceMatchesJob(client, locked.library, locked.row))) return false;
    const retry = retryAt !== null && locked.row.attempt_count < 3;
    const publicCode = code === "unsupported_settings" ? code : code === "decoder_failed" ? code : "renderer_unavailable";
    await client.query("UPDATE photo_media_jobs SET state=$3,error_code=$4,attempt_error=$5,retry_at=$6::timestamptz,lease_until=NULL,updated_at=clock_timestamp() WHERE owner=$1 AND id=$2", [owner, claim.jobId, retry ? "queued" : code === "unsupported_settings" ? "unsupported" : "failed", retry ? null : publicCode, code, retry ? new Date(Math.max(retryAt!, locked.row.now.getTime())).toISOString() : null]);
    await client.query("UPDATE photo_media_candidates SET state='abandoned',updated_at=clock_timestamp() WHERE owner=$1 AND job_id=$2 AND claim_generation=$3 AND state IN ('allocated','staged')", [owner, claim.jobId, claim.generation]);
    await client.query("UPDATE photo_libraries SET revision=revision+1,updated_at=GREATEST(updated_at,clock_timestamp()) WHERE owner=$1", [owner]); return true; });
}

/** Fence interrupted writes before the cleanup executor examines physical objects. A null generation requires provider reconciliation. */
export async function reconcilePhotoMediaCandidates(db: Database, owner: OwnerId, limit = 100): Promise<number> {
  assertOwner(owner); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("editor-store: invalid media reconcile limit");
  return transaction(db, async (client) => { await lockLibrary(client, owner);
    return (await client.query(`WITH stale AS (
      SELECT c.id FROM photo_media_candidates AS c JOIN photo_media_jobs AS j ON j.owner=c.owner AND j.id=c.job_id
        JOIN photos AS p ON p.owner=j.owner AND p.id=j.photo_id JOIN photo_libraries AS l ON l.owner=p.owner
       WHERE c.owner=$1 AND c.state IN ('allocated','staged') AND (l.state<>'active' OR p.lifecycle<>'active'
         OR p.current_media_job_id IS DISTINCT FROM j.id OR j.state<>'processing' OR j.terminal_reason IS NOT NULL
         OR j.claim_generation<>c.claim_generation OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp()
         OR p.lifecycle_epoch<>j.lifecycle_epoch OR p.recipe_revision<>j.recipe_revision)
       ORDER BY c.created_at,c.id LIMIT $2 FOR UPDATE OF c)
      UPDATE photo_media_candidates AS c SET state='abandoned',updated_at=clock_timestamp() FROM stale WHERE c.owner=$1 AND c.id=stale.id`, [owner, limit])).rowCount ?? 0;
  });
}
