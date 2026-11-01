import { randomUUID } from "node:crypto";
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
        `INSERT INTO photo_recipe_revisions (owner, photo_id, revision, settings, settings_sha256)
         VALUES ($1, $2, 0, $3::jsonb, $4)`,
        [owner, photoId, JSON.stringify(initialRecipe.settings), initialRecipe.settingsSha256],
      );
      await client.query(
        `INSERT INTO photo_recipes (owner, photo_id, revision, settings, settings_sha256)
         VALUES ($1, $2, 0, $3::jsonb, $4)`,
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
