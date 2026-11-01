/** Wire contract only. A client-supplied value never confers ownership. */
export const PHOTO_LIBRARY_CONTRACT_VERSION = 1 as const;
export const PHOTO_API_PREFIX = "/api/photo/v1" as const;
export const PHOTO_LIMITS = {
  quotaBytes: 5 * 1024 ** 3,
  maxFileBytes: 256 * 1024 ** 2,
  maxPixels: 100_000_000,
  browserDirectMaxPixels: 40_000_000,
  workingCopyMaxEdge: 2560,
  previewMaxEdge: 1280,
  thumbnailMaxEdge: 512,
  maxMaskBytes: 8 * 1024 ** 2,
  maxMaskEdge: 4096,
  maxRecipeBytes: 1024 ** 2,
  maxVersionsBytes: 4 * 1024 ** 2,
  maxRecipeBodyBytes: 2 * 1024 ** 2,
  maxVersionsBodyBytes: 5 * 1024 ** 2,
  maxOtherBodyBytes: 64 * 1024,
  maxVersions: 100,
  maxJsonDepth: 32,
  maxFileNameBytes: 255,
  maxVersionNameBytes: 255,
  maxIdempotencyKeyBytes: 128,
  listMaxCount: 100,
  maxPageBytes: 4 * 1024 ** 2,
  maxWorkingCopyMetaBytes: 64 * 1024,
  lookupMaxCount: 100,
  trashRetentionDays: 30,
  reservationLifetimeSeconds: 24 * 60 * 60,
  uploadTicketMaxSeconds: 15 * 60,
  cursorLifetimeSeconds: 15 * 60,
} as const;

/** Opaque stable NIHO account ID, not an email, spot ID or pairwise OAuth sub. */
export type UserId = string;
/** Server-generated UUIDs. None is an authorization capability. */
export type LibraryId = string;
export type PhotoId = string;
export type AssetId = string;
export type UploadId = string;
export type JobId = string;
/** Lowercase 64-character hex; numbers below must be finite safe integers. */
export type Sha256 = string;
export type Instant = string;
export type Json = null | boolean | number | string | readonly Json[] | JsonObject;
export type JsonObject = { readonly [key: string]: Json };

/** Server-internal port, never deserialized from the public request. */
export interface VerifiedPhotoActor {
  readonly userId: UserId;
  readonly sessionId: string;
  readonly transport: "browser-session" | "mac-bearer";
  readonly expiresAt: Instant;
}

export type PhotoFormat = "jpeg" | "png" | "heic" | "heif" | "tiff" | "raw";
export interface FormatCapability {
  readonly format: PhotoFormat;
  readonly extensions: readonly string[];
  /** True only after a server decoder/provider is installed and accepted. */
  readonly ingest: boolean;
  readonly workingCopy: boolean;
}

export interface RenderCapability {
  readonly sdkVersion: string;
  readonly crateVersion: string;
  readonly manifestSha256: Sha256;
  readonly settingsVersions: readonly number[];
  readonly engines: readonly string[];
  readonly features: readonly string[];
  readonly maskKinds: readonly string[];
  readonly maskSurfaces: boolean;
}

export interface PhotoCapabilities {
  readonly formats: readonly FormatCapability[];
  readonly renderer: RenderCapability;
  readonly edits: boolean;
  readonly versions: boolean;
  readonly maskSurfaces: boolean;
  /** Detection and native export are host/runtime capabilities, not server promises. */
  readonly albums: false;
  readonly publicSharing: false;
}

/** User-visible binary quota; reproducible derivatives and bounded JSON are overhead. */
export interface QuotaUsage {
  readonly quotaBytes: number;
  /** All retained originals + mask surfaces, including trash and pending physical purge. */
  readonly usedBytes: number;
  readonly originalBytes: number;
  readonly maskBytes: number;
  /** Included in usedBytes; not an additional charge. */
  readonly trashBytes: number;
  /** Included in usedBytes until the immutable generation is confirmed deleted. */
  readonly pendingPurgeBytes: number;
  /** Includes verification leases; never expire it while a stale worker can commit. */
  readonly reservedBytes: number;
  readonly availableBytes: number;
}

export interface PersonalPhotoLibrary {
  readonly contractVersion: 1;
  readonly id: LibraryId;
  readonly owner: { readonly type: "user"; readonly userId: UserId };
  readonly state: "active" | "deleting";
  readonly revision: number;
  readonly usage: QuotaUsage;
  readonly limits: typeof PHOTO_LIMITS;
  readonly capabilities: PhotoCapabilities;
}

export type AssetKind = "original" | "mask" | "thumbnail" | "preview" | "working-copy";
/** Locator/credential-free metadata. Content is read through content.get. */
export interface PhotoAsset {
  readonly id: AssetId;
  readonly kind: AssetKind;
  readonly sha256: Sha256;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
}

export type MediaState =
  | { readonly state: "queued" | "processing"; readonly jobId: JobId }
  | {
      readonly state: "ready";
      readonly thumbnail: PhotoAsset;
      readonly preview: PhotoAsset;
      readonly workingCopy: WorkingCopy | null;
      readonly recipeRevision: number;
      readonly rendererManifestSha256: Sha256;
    }
  | { readonly state: "failed" | "unsupported"; readonly code: "decoder_failed" | "renderer_unavailable" | "unsupported_settings" };

export interface WorkingCopy {
  readonly asset: PhotoAsset;
  readonly baseVersion: string;
  readonly encoding: "png16" | "jpeg8";
  /** Same metadata passed to the pinned SDK's openWorkingCopy; never a preview substitute. */
  readonly meta: JsonObject;
}

/** Preserve the complete JSON. Unknown versions/features are read-only to older clients. */
export interface RecipeDocument {
  readonly revision: number;
  readonly settings: JsonObject & { readonly v: number; readonly engine: string };
  readonly settingsSha256: Sha256;
  readonly baseVersion: string | null;
  /** Hash IDs referenced by settings; all must belong to this photo and exist before CAS. */
  readonly maskSurfaceIds: readonly Sha256[];
  readonly updatedAt: Instant;
}

export interface Photo {
  readonly id: PhotoId;
  readonly libraryId: LibraryId;
  /** Original is durably verified. Media processing is an independent state. */
  readonly storageState: "stored";
  readonly lifecycle: "active" | "trashed";
  readonly fileName: string;
  readonly format: PhotoFormat;
  /** SDK-neutrality check of settings, not simply revision > 0. Unknown settings count as edited. */
  readonly hasEdits: boolean;
  readonly addedAt: Instant;
  readonly capturedAt: Instant | null;
  /** EXIF orientation applied once; original bytes and EXIF remain unchanged. */
  readonly width: number;
  readonly height: number;
  readonly original: PhotoAsset;
  readonly recipe: RecipeDocument;
  readonly media: MediaState;
  readonly trashedAt: Instant | null;
  readonly purgeAfter: Instant | null;
}

export interface PhotoListQuery {
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: "added-desc" | "captured-desc";
  /** Repeated query parameter: formats=heic&formats=heif. */
  readonly formats?: readonly PhotoFormat[];
  readonly edited?: boolean;
  readonly editable?: boolean;
  readonly lifecycle?: "active" | "trashed";
}
/** Owner-only detail, never included in list responses or derivative EXIF. */
export interface PhotoInfo {
  readonly camera?: { readonly make: string | null; readonly model: string | null } | null;
  readonly lens?: string | null;
  readonly iso?: number | null;
  readonly exposureTimeSeconds?: number | null;
  readonly fNumber?: number | null;
  readonly focalLengthMm?: number | null;
  readonly capturedAt?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly gps?: { readonly latitude: number; readonly longitude: number } | null;
}
export interface PhotoPage {
  readonly items: readonly Photo[];
  readonly nextCursor: string | null;
  readonly libraryRevision: number;
  readonly usage: QuotaUsage;
}
export interface PhotoLookupMatch {
  readonly sha256: Sha256;
  readonly photoId: PhotoId;
  readonly recipeRevision: number;
}

export type UploadTarget =
  | { readonly kind: "original"; readonly fileName: string; readonly format: PhotoFormat }
  | { readonly kind: "mask"; readonly photoId: PhotoId };
export interface StartUploadRequest {
  readonly target: UploadTarget;
  readonly sizeBytes: number;
  readonly sha256: Sha256;
  readonly contentType: string;
}
/** Bearer material: response memory only. Never persist/log/cache this object. */
export interface UploadTicket {
  readonly url: string;
  readonly method: "PUT";
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Instant;
  readonly resumeOffsetBytes: number;
}
export type StoredUploadResult =
  | { readonly kind: "original"; readonly photo: Photo }
  | { readonly kind: "mask"; readonly photoId: PhotoId; readonly asset: PhotoAsset };
export type Upload = {
  readonly id: UploadId;
  readonly target: UploadTarget;
  readonly sizeBytes: number;
  readonly sha256: Sha256;
  readonly expiresAt: Instant;
} & (
  | { readonly state: "reserved"; readonly uploadedBytes: number }
  | { readonly state: "verifying"; readonly jobId: JobId }
  | { readonly state: "stored"; readonly result: StoredUploadResult }
  | { readonly state: "cancelled" | "expired" }
  | { readonly state: "rejected"; readonly code: "content_rejected" | "unsupported_format" | "pixel_limit_exceeded" }
);
export type StartUploadResponse =
  /** On replay the current upload may be verifying/stored; no stale bearer is replayed. */
  | { readonly kind: "upload"; readonly upload: Upload; readonly ticket: UploadTicket | null }
  | { readonly kind: "existing"; readonly photo: Photo };
export interface MutationReceipt<T> {
  readonly value: T;
  readonly replayed: boolean;
}
export interface NamedVersion {
  readonly id: string;
  readonly name: string;
  readonly kind: "named" | "auto";
  readonly recipe: RecipeDocument;
  readonly createdAt: Instant;
}
export interface VersionSet {
  readonly revision: number;
  readonly versions: readonly NamedVersion[];
}
export interface PurgeJob {
  readonly id: JobId;
  readonly state: "queued" | "running" | "completed" | "retrying";
  readonly pendingBytes: number;
}

export const PHOTO_ERROR_STATUS = {
  invalid_request: 400,
  invalid_cursor: 400,
  unauthenticated: 401,
  origin_rejected: 403,
  not_found: 404,
  quota_exceeded: 409,
  revision_conflict: 409,
  idempotency_conflict: 409,
  upload_state_conflict: 409,
  photo_trashed: 409,
  account_deleting: 409,
  upload_expired: 410,
  cursor_expired: 410,
  request_too_large: 413,
  unsupported_format: 415,
  range_not_satisfiable: 416,
  content_rejected: 422,
  pixel_limit_exceeded: 422,
  unsupported_settings: 422,
  missing_mask_surface: 422,
  rate_limited: 429,
  temporarily_unavailable: 503,
} as const;
export type PhotoErrorCode = keyof typeof PHOTO_ERROR_STATUS;
export interface PhotoErrorEnvelope {
  readonly error: {
    readonly code: PhotoErrorCode;
    readonly requestId: string;
    readonly retryable: boolean;
    readonly currentRevision?: number;
    readonly retryAfterSeconds?: number;
  };
}

/** Arrange values are synthetic inputs for future HTTP/DB conformance runners. */
export interface PhotoContractCase {
  readonly id: string;
  readonly operation: PhotoOperation;
  readonly actor: "user-a" | "user-b" | "none" | "revoked";
  readonly request: JsonObject;
  readonly arrange: JsonObject;
  readonly expected: {
    readonly status: number;
    readonly code?: PhotoErrorCode;
    readonly invariants: readonly string[];
  };
}

type Id = { readonly photoId: PhotoId };
type UploadRef = { readonly uploadId: UploadId };
type Empty = Readonly<Record<string, never>>;
type Operation<Request, Response> = { readonly request: Request; readonly response: Response };
/** All request objects are closed except opaque recipe/working-copy JSON. */
export interface PhotoOperationMap {
  readonly "library.get": Operation<Empty, PersonalPhotoLibrary>;
  readonly "photos.list": Operation<PhotoListQuery, PhotoPage>;
  readonly "photos.get": Operation<Id, Photo>;
  readonly "photos.info": Operation<Id, PhotoInfo>;
  readonly "photos.lookup": Operation<{ readonly sha256s: readonly Sha256[] }, { readonly matches: readonly PhotoLookupMatch[] }>;
  readonly "uploads.start": Operation<StartUploadRequest, MutationReceipt<StartUploadResponse>>;
  readonly "uploads.get": Operation<UploadRef, Upload>;
  readonly "uploads.renew": Operation<UploadRef, { readonly upload: Extract<Upload, { readonly state: "reserved" }>; readonly ticket: UploadTicket }>;
  readonly "uploads.complete": Operation<UploadRef, MutationReceipt<Upload>>;
  readonly "uploads.cancel": Operation<UploadRef, MutationReceipt<Upload>>;
  /** HTTP response is a stream (200/206), not a JSON serialization of Uint8Array. */
  readonly "content.get": Operation<Id & { readonly assetId: AssetId; readonly range?: string }, Uint8Array>;
  readonly "masks.get": Operation<Id & { readonly surfaceId: Sha256 }, PhotoAsset>;
  readonly "recipes.put": Operation<Id & {
    readonly expectedRevision: number;
    readonly settings: RecipeDocument["settings"];
    readonly baseVersion: string | null;
  }, MutationReceipt<Photo>>;
  readonly "versions.get": Operation<Id, VersionSet>;
  readonly "versions.put": Operation<Id & {
    readonly expectedRevision: number;
    readonly versions: readonly NamedVersion[];
  }, MutationReceipt<VersionSet>>;
  readonly "media.ensure": Operation<Id & { readonly recipeRevision: number }, MutationReceipt<MediaState>>;
  readonly "photos.trash": Operation<Id, MutationReceipt<Photo>>;
  readonly "photos.restore": Operation<Id, MutationReceipt<Photo>>;
  readonly "photos.purge": Operation<Id, MutationReceipt<PurgeJob>>;
  readonly "jobs.get": Operation<{ readonly jobId: JobId }, PurgeJob>;
}
export type PhotoOperation = keyof PhotoOperationMap;
type Transport = {
  readonly method: "GET" | "POST" | "PUT";
  /** Relative to PHOTO_API_PREFIX. */
  readonly path: string;
  readonly idempotency: "required" | "none";
};
export const PHOTO_ROUTES = {
  "library.get": { method: "GET", path: "/library", idempotency: "none" },
  "photos.list": { method: "GET", path: "/photos", idempotency: "none" },
  "photos.get": { method: "GET", path: "/photos/{photoId}", idempotency: "none" },
  "photos.info": { method: "GET", path: "/photos/{photoId}/info", idempotency: "none" },
  "photos.lookup": { method: "POST", path: "/photos/lookup", idempotency: "none" },
  "uploads.start": { method: "POST", path: "/uploads", idempotency: "required" },
  "uploads.get": { method: "GET", path: "/uploads/{uploadId}", idempotency: "none" },
  "uploads.renew": { method: "POST", path: "/uploads/{uploadId}/renew", idempotency: "none" },
  "uploads.complete": { method: "POST", path: "/uploads/{uploadId}/complete", idempotency: "required" },
  "uploads.cancel": { method: "POST", path: "/uploads/{uploadId}/cancel", idempotency: "required" },
  "content.get": { method: "GET", path: "/photos/{photoId}/content/{assetId}", idempotency: "none" },
  "masks.get": { method: "GET", path: "/photos/{photoId}/masks/{surfaceId}", idempotency: "none" },
  "recipes.put": { method: "PUT", path: "/photos/{photoId}/recipe", idempotency: "required" },
  "versions.get": { method: "GET", path: "/photos/{photoId}/versions", idempotency: "none" },
  "versions.put": { method: "PUT", path: "/photos/{photoId}/versions", idempotency: "required" },
  "media.ensure": { method: "POST", path: "/photos/{photoId}/media", idempotency: "required" },
  "photos.trash": { method: "POST", path: "/photos/{photoId}/trash", idempotency: "required" },
  "photos.restore": { method: "POST", path: "/photos/{photoId}/restore", idempotency: "required" },
  "photos.purge": { method: "POST", path: "/photos/{photoId}/purge", idempotency: "required" },
  "jobs.get": { method: "GET", path: "/jobs/{jobId}", idempotency: "none" },
} as const satisfies Readonly<Record<PhotoOperation, Transport>>;
