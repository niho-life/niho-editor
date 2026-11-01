import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { PHOTO_LIMITS, type Photo, type PhotoAsset, type PhotoErrorCode, type PhotoInfo, type PhotoLookupMatch, type PersonalPhotoLibrary, type PhotoPage } from "../../../../../packages/photo-library-contract/src/v1";
import type { PhotoCatalogAfter, PhotoCatalogFilter, PhotoCatalogPageInput, PhotoCatalogStore } from "./types";

export const PRIVATE_CATALOG_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

export class PhotoCatalogError extends Error {
  constructor(readonly code: PhotoErrorCode) { super(`photo catalog: ${code}`); }
}

export type CatalogResult<T> = { readonly status: 200; readonly etag: string; readonly value: T } | { readonly status: 304; readonly etag: string; readonly value: null };

export function catalogResponse<T>(result: CatalogResult<T>): Response {
  return new Response(result.status === 304 ? null : JSON.stringify(result.value), {
    status: result.status,
    headers: { ...PRIVATE_CATALOG_HEADERS, ETag: result.etag, ...(result.status === 200 ? { "Content-Type": "application/json; charset=utf-8" } : {}) },
  });
}

type CursorPayload = {
  readonly v: 1;
  readonly owner: string;
  readonly filter: PhotoCatalogFilter;
  readonly watermark: number;
  readonly after: PhotoCatalogAfter;
  readonly expiresAt: number;
};

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const FORMATS = new Set(["jpeg", "png", "heic", "heif", "tiff", "raw"]);
const FILTER_KEYS = ["lifecycle", "sort", "formats", "edited", "editable"] as const;
const CURSOR_AAD = Buffer.from("niho-photo-catalog-cursor-v1");

function fail(code: PhotoErrorCode): never { throw new PhotoCatalogError(code); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validInstant(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function canonicalFilter(filter: PhotoCatalogFilter): string {
  return JSON.stringify({ lifecycle: filter.lifecycle, sort: filter.sort, formats: filter.formats ?? [], edited: filter.edited ?? null, editable: filter.editable ?? null });
}

function parseFilter(url: URL): { filter: PhotoCatalogFilter; limit: number; cursor: string | null } {
  const allowed = new Set(["cursor", "limit", ...FILTER_KEYS]);
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) fail("invalid_request");
  for (const key of ["cursor", "limit", "sort", "edited", "editable", "lifecycle"]) if (url.searchParams.getAll(key).length > 1) fail("invalid_request");

  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 50 : /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PHOTO_LIMITS.listMaxCount) fail("invalid_request");

  const sortValue = url.searchParams.get("sort") ?? "added-desc";
  if (sortValue !== "added-desc" && sortValue !== "captured-desc") fail("invalid_request");
  const lifecycleValue = url.searchParams.get("lifecycle") ?? "active";
  if (lifecycleValue !== "active" && lifecycleValue !== "trashed") fail("invalid_request");

  const formats = url.searchParams.getAll("formats");
  if (formats.some((format) => !FORMATS.has(format))) fail("invalid_request");
  const normalizedFormats = [...new Set(formats)].sort() as NonNullable<PhotoCatalogFilter["formats"]>;
  const edited = parseOptionalBoolean(url.searchParams.get("edited"));
  const editable = parseOptionalBoolean(url.searchParams.get("editable"));
  const filter: PhotoCatalogFilter = {
    lifecycle: lifecycleValue,
    sort: sortValue,
    ...(normalizedFormats.length ? { formats: normalizedFormats } : {}),
    ...(edited === undefined ? {} : { edited }),
    ...(editable === undefined ? {} : { editable }),
  };
  const cursor = url.searchParams.get("cursor");
  if (cursor === "") fail("invalid_cursor");
  return { filter, limit, cursor };
}

function parseOptionalBoolean(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  fail("invalid_request");
}

function publicAsset(asset: PhotoAsset): PhotoAsset {
  return { id: asset.id, kind: asset.kind, sha256: asset.sha256, sizeBytes: asset.sizeBytes, contentType: asset.contentType, width: asset.width, height: asset.height };
}

/** Copy only fields defined by the public contract, even if a projection carries private DB columns. */
function publicPhoto(photo: Photo): Photo {
  const media = photo.media;
  return {
    id: photo.id, libraryId: photo.libraryId, storageState: photo.storageState, lifecycle: photo.lifecycle, fileName: photo.fileName,
    format: photo.format, hasEdits: photo.hasEdits, addedAt: photo.addedAt, capturedAt: photo.capturedAt, width: photo.width, height: photo.height,
    original: publicAsset(photo.original), trashedAt: photo.trashedAt, purgeAfter: photo.purgeAfter,
    recipe: { revision: photo.recipe.revision, settings: photo.recipe.settings, settingsSha256: photo.recipe.settingsSha256, baseVersion: photo.recipe.baseVersion,
      maskSurfaceIds: photo.recipe.maskSurfaceIds, updatedAt: photo.recipe.updatedAt },
    media: media.state === "ready"
      ? { state: "ready", thumbnail: publicAsset(media.thumbnail), preview: publicAsset(media.preview),
        workingCopy: media.workingCopy ? { asset: publicAsset(media.workingCopy.asset), baseVersion: media.workingCopy.baseVersion,
          encoding: media.workingCopy.encoding, meta: media.workingCopy.meta } : null,
        recipeRevision: media.recipeRevision, rendererManifestSha256: media.rendererManifestSha256 }
      : "jobId" in media ? { state: media.state, jobId: media.jobId } : { state: media.state, code: media.code },
  };
}

function validCursorPayload(value: unknown): value is CursorPayload {
  if (!record(value) || Object.keys(value).length !== 6 || value.v !== 1 || typeof value.owner !== "string" || !value.owner
    || !Number.isSafeInteger(value.watermark) || (value.watermark as number) < 0 || !Number.isSafeInteger(value.expiresAt)
    || !record(value.filter) || !record(value.after)) return false;
  const filter = value.filter;
  if (Object.keys(filter).some((key) => !(FILTER_KEYS as readonly string[]).includes(key))
    || (filter.sort !== "added-desc" && filter.sort !== "captured-desc") || (filter.lifecycle !== "active" && filter.lifecycle !== "trashed")
    || (filter.formats !== undefined && (!Array.isArray(filter.formats) || filter.formats.some((f) => typeof f !== "string" || !FORMATS.has(f))))
    || (filter.edited !== undefined && typeof filter.edited !== "boolean") || (filter.editable !== undefined && typeof filter.editable !== "boolean")) return false;
  const after = value.after;
  if (after.sort !== filter.sort || typeof after.id !== "string" || !UUID.test(after.id) || !validInstant(after.addedAt)) return false;
  if (after.sort === "captured-desc") return after.capturedAt === null || validInstant(after.capturedAt);
  return after.sort === "added-desc";
}

function matchesEtag(header: string | null, etag: string): boolean {
  return header?.split(",").some((part) => {
    const candidate = part.trim();
    return candidate === "*" || candidate === etag || candidate === `W/${etag}`;
  }) ?? false;
}

function safeLibrary(library: PersonalPhotoLibrary): PersonalPhotoLibrary {
  return {
    contractVersion: library.contractVersion, id: library.id, owner: { type: "user", userId: library.owner.userId }, state: library.state,
    revision: library.revision, usage: { ...library.usage }, limits: { ...library.limits },
    capabilities: { formats: library.capabilities.formats.map((format) => ({ format: format.format, extensions: [...format.extensions], ingest: format.ingest, workingCopy: format.workingCopy })),
      renderer: { sdkVersion: library.capabilities.renderer.sdkVersion, crateVersion: library.capabilities.renderer.crateVersion,
        manifestSha256: library.capabilities.renderer.manifestSha256, settingsVersions: [...library.capabilities.renderer.settingsVersions],
        engines: [...library.capabilities.renderer.engines], features: [...library.capabilities.renderer.features], maskKinds: [...library.capabilities.renderer.maskKinds],
        maskSurfaces: library.capabilities.renderer.maskSurfaces }, edits: library.capabilities.edits,
      versions: library.capabilities.versions, maskSurfaces: library.capabilities.maskSurfaces, albums: false, publicSharing: false },
  };
}

function publicInfo(info: PhotoInfo | null): PhotoInfo {
  if (!info) return {};
  return {
    ...(info.camera === undefined ? {} : { camera: info.camera === null ? null : { make: info.camera.make, model: info.camera.model } }),
    ...(info.lens === undefined ? {} : { lens: info.lens }),
    ...(info.iso === undefined ? {} : { iso: info.iso }),
    ...(info.exposureTimeSeconds === undefined ? {} : { exposureTimeSeconds: info.exposureTimeSeconds }),
    ...(info.fNumber === undefined ? {} : { fNumber: info.fNumber }),
    ...(info.focalLengthMm === undefined ? {} : { focalLengthMm: info.focalLengthMm }),
    ...(info.capturedAt === undefined ? {} : { capturedAt: info.capturedAt }),
    ...(info.width === undefined ? {} : { width: info.width }),
    ...(info.height === undefined ? {} : { height: info.height }),
    ...(info.gps === undefined ? {} : { gps: info.gps === null ? null : { latitude: info.gps.latitude, longitude: info.gps.longitude } }),
  };
}

function photoTuple(photo: Photo, sort: PhotoCatalogFilter["sort"]): PhotoCatalogAfter {
  return sort === "added-desc"
    ? { sort, addedAt: photo.addedAt, id: photo.id }
    : { sort, capturedAt: photo.capturedAt, addedAt: photo.addedAt, id: photo.id };
}

export function createPhotoCatalogApi(deps: {
  store: PhotoCatalogStore;
  /** Secret from the private runtime provider used to derive the AES-256-GCM cursor key; never serialize or log it. */
  cursorSecret: Uint8Array;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  if (deps.cursorSecret.byteLength < 32) throw new Error("photo catalog configuration invalid");
  const cursorKey = createHash("sha256").update("niho-photo-catalog-cursor-v1\0").update(deps.cursorSecret).digest();
  const makeEtag = (value: unknown) => `"photo-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32)}"`;
  const encodeCursor = (owner: string, filter: PhotoCatalogFilter, watermark: number, after: PhotoCatalogAfter) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", cursorKey, iv);
    cipher.setAAD(CURSOR_AAD);
    const plaintext = Buffer.from(JSON.stringify({ v: 1, owner, filter, watermark, after, expiresAt: now() + PHOTO_LIMITS.cursorLifetimeSeconds * 1000 } satisfies CursorPayload));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return `${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  };
  function decodeCursor(token: string, owner: string, filter: PhotoCatalogFilter): CursorPayload {
    if (token.length > 4096) fail("invalid_cursor");
    const [ivText, ciphertextText, tagText, extra] = token.split(".");
    if (!ivText || !ciphertextText || !tagText || extra !== undefined || !/^[A-Za-z0-9_-]{16}$/.test(ivText)
      || !/^[A-Za-z0-9_-]+$/.test(ciphertextText) || !/^[A-Za-z0-9_-]{22}$/.test(tagText)) fail("invalid_cursor");
    let parsed: unknown;
    try {
      const decipher = createDecipheriv("aes-256-gcm", cursorKey, Buffer.from(ivText, "base64url"));
      decipher.setAAD(CURSOR_AAD); decipher.setAuthTag(Buffer.from(tagText, "base64url"));
      parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8"));
    } catch { fail("invalid_cursor"); }
    if (!validCursorPayload(parsed) || parsed.owner !== owner || canonicalFilter(parsed.filter) !== canonicalFilter(filter)) fail("invalid_cursor");
    if (parsed.expiresAt <= now()) fail("cursor_expired");
    return parsed;
  }

  function conditional<T>(value: T, etag: string, ifNoneMatch: string | null): CatalogResult<T> {
    return matchesEtag(ifNoneMatch, etag) ? { status: 304, etag, value: null } : { status: 200, etag, value };
  }

  return {
    async library(owner: string, ifNoneMatch: string | null = null): Promise<CatalogResult<PersonalPhotoLibrary>> {
      const found = await deps.store.library(owner);
      if (!found || found.owner.userId !== owner) fail("not_found");
      if (found.state === "deleting") fail("account_deleting");
      const value = safeLibrary(found);
      return conditional(value, makeEtag({ owner, operation: "library.get", value }), ifNoneMatch);
    },
    async list(owner: string, url: URL, ifNoneMatch: string | null = null): Promise<CatalogResult<PhotoPage>> {
      const { filter, limit, cursor } = parseFilter(url);
      const decoded = cursor ? decodeCursor(cursor, owner, filter) : null;
      const input: PhotoCatalogPageInput = { filter, watermark: decoded?.watermark ?? null, after: decoded?.after ?? null, limit };
      const page = await deps.store.page(owner, input);
      if (!page || page.library.owner.userId !== owner) fail("not_found");
      if (page.library.state === "deleting") fail("account_deleting");
      if (!Number.isSafeInteger(page.watermark) || page.watermark < 0 || (decoded && page.watermark !== decoded.watermark)) fail("temporarily_unavailable");
      if (page.items.length > limit || (page.hasMore && page.items.length === 0) || page.items.some((photo) => photo.libraryId !== page.library.id || photo.lifecycle !== filter.lifecycle
        || !photo.original || photo.storageState !== "stored" || (filter.formats?.length && !filter.formats.includes(photo.format))
        || (filter.edited !== undefined && photo.hasEdits !== filter.edited))) fail("temporarily_unavailable");

      const safeItems = page.items.map(publicPhoto);
      for (const photo of safeItems) if (photo.media.state === "ready" && photo.media.workingCopy
        && jsonBytes(photo.media.workingCopy.meta) > PHOTO_LIMITS.maxWorkingCopyMetaBytes) fail("temporarily_unavailable");
      const prefixItemBytes = [0];
      for (const photo of safeItems) prefixItemBytes.push(prefixItemBytes[prefixItemBytes.length - 1]! + jsonBytes(photo));
      const etagInput = { owner, libraryId: page.library.id, revision: page.library.revision, filter: canonicalFilter(filter), watermark: page.watermark,
        after: decoded?.after ?? null, limit };

      const envelopeMetadata = (count: number) => {
        const hasMore = page.hasMore || count < safeItems.length;
        const nextCursor = hasMore && count > 0 ? encodeCursor(owner, filter, page.watermark, photoTuple(safeItems[count - 1]!, filter.sort)) : null;
        return { nextCursor, libraryRevision: page.library.revision, usage: { ...page.library.usage } };
      };
      if (safeItems.length === 0) {
        const value: PhotoPage = { items: [], ...envelopeMetadata(0) };
        if (jsonBytes(value) <= PHOTO_LIMITS.maxPageBytes) {
          const etag = makeEtag({ ...etagInput, nextCursor: value.nextCursor });
          return matchesEtag(ifNoneMatch, etag) ? { status: 304, etag, value: null } : { status: 200, etag, value };
        }
      }
      for (let count = safeItems.length; count > 0; count--) {
        const metadata = envelopeMetadata(count);
        const sizeEnvelope: PhotoPage = { items: [], ...metadata };
        const itemArrayOverhead = prefixItemBytes[count]! + Math.max(0, count - 1);
        if (jsonBytes(sizeEnvelope) + itemArrayOverhead <= PHOTO_LIMITS.maxPageBytes) {
          const value: PhotoPage = { items: safeItems.slice(0, count), ...metadata };
          // The cursor expires relative to this response, so it is part of the representation's ETag.
          const etag = makeEtag({ ...etagInput, nextCursor: value.nextCursor });
          return matchesEtag(ifNoneMatch, etag) ? { status: 304, etag, value: null } : { status: 200, etag, value };
        }
      }
      fail("temporarily_unavailable");
    },
    async photo(owner: string, photoId: string, ifNoneMatch: string | null = null): Promise<CatalogResult<Photo>> {
      if (!UUID.test(photoId)) fail("not_found");
      const found = await deps.store.photo(owner, photoId.toLowerCase());
      if (!found || found.library.owner.userId !== owner || found.library.id !== found.photo.libraryId || found.photo.id.toLowerCase() !== photoId.toLowerCase()) fail("not_found");
      if (found.library.state === "deleting") fail("account_deleting");
      const value = publicPhoto(found.photo);
      if (value.media.state === "ready" && value.media.workingCopy && jsonBytes(value.media.workingCopy.meta) > PHOTO_LIMITS.maxWorkingCopyMetaBytes) fail("temporarily_unavailable");
      const etag = makeEtag({ owner, photoId: value.id, libraryRevision: found.library.revision, recipeRevision: value.recipe.revision, media: value.media });
      return conditional(value, etag, ifNoneMatch);
    },
    async info(owner: string, photoId: string, ifNoneMatch: string | null = null): Promise<CatalogResult<PhotoInfo>> {
      if (!UUID.test(photoId)) fail("not_found");
      const found = await deps.store.photo(owner, photoId.toLowerCase());
      if (!found || found.library.owner.userId !== owner || found.library.id !== found.photo.libraryId || found.photo.id.toLowerCase() !== photoId.toLowerCase()) fail("not_found");
      if (found.library.state === "deleting") fail("account_deleting");
      const value = publicInfo(await deps.store.info(owner, photoId.toLowerCase()));
      const etag = makeEtag({ owner, photoId: found.photo.id, libraryRevision: found.library.revision, info: value });
      return conditional(value, etag, ifNoneMatch);
    },
    async lookup(owner: string, body: unknown): Promise<{ readonly matches: readonly PhotoLookupMatch[] }> {
      if (!record(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, "sha256s") || !Array.isArray(body.sha256s)
        || body.sha256s.length > PHOTO_LIMITS.lookupMaxCount || body.sha256s.some((hash) => typeof hash !== "string" || !SHA256.test(hash))) fail("invalid_request");
      const sha256s = [...new Set(body.sha256s as string[])];
      const library = await deps.store.library(owner);
      if (!library || library.owner.userId !== owner) fail("not_found");
      if (library.state === "deleting") fail("account_deleting");
      const matches = await deps.store.lookup(owner, sha256s);
      if (matches.length > sha256s.length || matches.some((match) => !sha256s.includes(match.sha256) || !UUID.test(match.photoId)
        || !Number.isSafeInteger(match.recipeRevision) || match.recipeRevision < 0)) fail("temporarily_unavailable");
      return { matches: matches.map((match) => ({ sha256: match.sha256, photoId: match.photoId, recipeRevision: match.recipeRevision })) };
    },
  };
}
