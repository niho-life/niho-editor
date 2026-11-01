import {
  PHOTO_ERROR_STATUS,
  PHOTO_LIMITS,
  type JsonObject,
  type PersonalPhotoLibrary,
  type Photo,
  type PhotoAsset,
  type PhotoErrorCode,
  type PhotoErrorEnvelope,
  type PhotoInfo,
  type PhotoLookupMatch,
  type PhotoOperation,
  type PhotoOperationMap,
  type PhotoPage,
  type VersionSet,
} from "@niho/photo-library-contract";
import { CloudPhotoError } from "./errors.ts";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const positiveInteger = (value: unknown): value is number => integer(value) && value > 0;
const format = (value: unknown): boolean => ["jpeg", "png", "heic", "heif", "tiff", "raw"].includes(String(value));

function quota(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const fields = ["quotaBytes", "usedBytes", "originalBytes", "maskBytes", "trashBytes", "pendingPurgeBytes", "reservedBytes", "availableBytes"];
  if (!fields.every((field) => integer(value[field]))) return false;
  return value.usedBytes === Number(value.originalBytes) + Number(value.maskBytes) &&
    value.availableBytes === Number(value.quotaBytes) - Number(value.usedBytes) - Number(value.reservedBytes) &&
    Number(value.trashBytes) <= Number(value.usedBytes) && Number(value.pendingPurgeBytes) <= Number(value.usedBytes);
}

function limits(value: unknown): boolean {
  return isRecord(value) && Object.entries(PHOTO_LIMITS).every(([key, expected]) => value[key] === expected);
}

function asset(value: unknown, kind?: PhotoAsset["kind"]): value is PhotoAsset {
  return isRecord(value) && string(value.id) && string(value.kind) && (!kind || value.kind === kind) &&
    /^[a-f0-9]{64}$/.test(String(value.sha256)) && integer(value.sizeBytes) && string(value.contentType) &&
    positiveInteger(value.width) && positiveInteger(value.height);
}

function recipe(value: unknown): boolean {
  return isRecord(value) && integer(value.revision) && isRecord(value.settings) &&
    integer(value.settings.v) && string(value.settings.engine) && /^[a-f0-9]{64}$/.test(String(value.settingsSha256)) &&
    (value.baseVersion === null || string(value.baseVersion)) && Array.isArray(value.maskSurfaceIds) &&
    value.maskSurfaceIds.every((item) => string(item) && /^[a-f0-9]{64}$/.test(item)) && string(value.updatedAt);
}

function media(value: unknown): boolean {
  if (!isRecord(value) || !string(value.state)) return false;
  if (value.state === "queued" || value.state === "processing") return string(value.jobId);
  if (value.state === "failed" || value.state === "unsupported") {
    return ["decoder_failed", "renderer_unavailable", "unsupported_settings"].includes(String(value.code));
  }
  return value.state === "ready" && asset(value.thumbnail, "thumbnail") && asset(value.preview, "preview") &&
    (value.workingCopy === null || (isRecord(value.workingCopy) && asset(value.workingCopy.asset, "working-copy") &&
      string(value.workingCopy.baseVersion) && (value.workingCopy.encoding === "png16" || value.workingCopy.encoding === "jpeg8") &&
      isRecord(value.workingCopy.meta))) && integer(value.recipeRevision) && /^[a-f0-9]{64}$/.test(String(value.rendererManifestSha256));
}

export function parsePhoto(value: unknown, libraryId: string, photoId?: string): Photo {
  assertPhoto(value, libraryId, photoId);
  return value;
}

function assertPhoto(value: unknown, libraryId: string, photoId?: string): asserts value is Photo {
  if (!isRecord(value) || !string(value.id) || (photoId !== undefined && value.id !== photoId) || value.libraryId !== libraryId || value.storageState !== "stored" ||
    (value.lifecycle !== "active" && value.lifecycle !== "trashed") || !string(value.fileName) || !format(value.format) ||
    typeof value.hasEdits !== "boolean" || !string(value.addedAt) || !(value.capturedAt === null || string(value.capturedAt)) ||
    !positiveInteger(value.width) || !positiveInteger(value.height) || !asset(value.original, "original") || !recipe(value.recipe) ||
    !media(value.media) || !(value.trashedAt === null || string(value.trashedAt)) || !(value.purgeAfter === null || string(value.purgeAfter))) {
    throw new CloudPhotoError("invalid_response", null, null, false);
  }
}

export function parseLibrary(value: unknown, actorId: string, libraryId: string): PersonalPhotoLibrary {
  assertLibrary(value, actorId, libraryId);
  return value;
}

function assertLibrary(value: unknown, actorId: string, libraryId: string): asserts value is PersonalPhotoLibrary {
  if (!isRecord(value) || value.contractVersion !== 1 || value.id !== libraryId || !isRecord(value.owner) ||
    value.owner.type !== "user" || value.owner.userId !== actorId || value.state !== "active" || !integer(value.revision) ||
    !quota(value.usage) || !isRecord(value.capabilities) || !Array.isArray(value.capabilities.formats) ||
    !value.capabilities.formats.every((item) => isRecord(item) && format(item.format) && Array.isArray(item.extensions) &&
      item.extensions.every(string) && typeof item.ingest === "boolean" && typeof item.workingCopy === "boolean") ||
    typeof value.capabilities.edits !== "boolean" || typeof value.capabilities.versions !== "boolean" ||
    typeof value.capabilities.maskSurfaces !== "boolean" ||
    !isRecord(value.capabilities.renderer) || !Array.isArray(value.capabilities.renderer.settingsVersions) ||
    !value.capabilities.renderer.settingsVersions.every(integer) || !Array.isArray(value.capabilities.renderer.engines) ||
    !value.capabilities.renderer.engines.every(string) || !string(value.capabilities.renderer.manifestSha256) ||
    !limits(value.limits)) {
    throw new CloudPhotoError("invalid_response", null, null, false);
  }
}

export function parsePage(value: unknown, libraryId: string): PhotoPage {
  assertPage(value, libraryId);
  return value;
}

function assertPage(value: unknown, libraryId: string): asserts value is PhotoPage {
  if (!isRecord(value) || !Array.isArray(value.items) || !(value.nextCursor === null || string(value.nextCursor)) ||
    !integer(value.libraryRevision) || !quota(value.usage)) throw new CloudPhotoError("invalid_response", null, null, false);
  for (const item of value.items) assertPhoto(item, libraryId);
}

export function parseLookup(value: unknown): readonly PhotoLookupMatch[] {
  if (!isRecord(value) || !Array.isArray(value.matches) || !value.matches.every((match) => isRecord(match) &&
    /^[a-f0-9]{64}$/.test(String(match.sha256)) && string(match.photoId) && integer(match.recipeRevision))) {
    throw new CloudPhotoError("invalid_response", null, null, false);
  }
  return value.matches as readonly PhotoLookupMatch[];
}

export function parseInfo(value: unknown): PhotoInfo {
  assertInfo(value);
  return value;
}

function assertInfo(value: unknown): asserts value is PhotoInfo {
  if (!isRecord(value)) invalid();
  const nullableStrings = ["lens", "capturedAt"];
  const nullableNumbers = ["iso", "exposureTimeSeconds", "fNumber", "focalLengthMm", "width", "height"];
  if (nullableStrings.some((key) => value[key] !== undefined && value[key] !== null && !string(value[key])) ||
    nullableNumbers.some((key) => value[key] !== undefined && value[key] !== null && typeof value[key] !== "number") ||
    (value.camera !== undefined && value.camera !== null && (!isRecord(value.camera) ||
      ![value.camera.make, value.camera.model].every((item) => item === null || string(item)))) ||
    (value.gps !== undefined && value.gps !== null && (!isRecord(value.gps) || typeof value.gps.latitude !== "number" || typeof value.gps.longitude !== "number"))) invalid();
}

export function parseVersions(value: unknown): VersionSet {
  assertVersions(value);
  return value;
}

function assertVersions(value: unknown): asserts value is VersionSet {
  if (!isRecord(value) || !integer(value.revision) || !Array.isArray(value.versions) || value.versions.length > PHOTO_LIMITS.maxVersions ||
    !value.versions.every((version) => isRecord(version) && string(version.id) && string(version.name) &&
      (version.kind === "named" || version.kind === "auto") && recipe(version.recipe) && string(version.createdAt))) {
    throw new CloudPhotoError("invalid_response", null, null, false);
  }
}

export function parseAsset(value: unknown, expected: { kind: PhotoAsset["kind"]; sha256?: string }): PhotoAsset {
  if (!asset(value, expected.kind) || (expected.sha256 && value.sha256 !== expected.sha256)) {
    throw new CloudPhotoError("invalid_response", null, null, false);
  }
  return value;
}

export function parseErrorEnvelope(value: unknown): PhotoErrorEnvelope["error"] | null {
  if (!isRecord(value) || !isRecord(value.error) || !string(value.error.code) ||
    !Object.hasOwn(PHOTO_ERROR_STATUS, value.error.code) || !string(value.error.requestId) ||
    typeof value.error.retryable !== "boolean") return null;
  const error = value.error;
  const code = error.code;
  const requestId = error.requestId;
  const result: PhotoErrorEnvelope["error"] = {
    code: code as PhotoErrorCode,
    requestId: String(requestId),
    retryable: Boolean(error.retryable),
    ...(integer(error.currentRevision) ? { currentRevision: error.currentRevision } : {}),
    ...(integer(error.retryAfterSeconds) ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  };
  return result;
}

export function cloneJsonObject(value: JsonObject): JsonObject {
  return structuredClone(value);
}

export function assertOperationResponse<K extends Exclude<PhotoOperation, "content.get">>(
  operation: K,
  value: unknown,
  scope: { actorId: string; libraryId: string },
  request: PhotoOperationMap[K]["request"],
): asserts value is PhotoOperationMap[K]["response"] {
  const identifiers = request as Record<string, unknown>;
  switch (operation) {
    case "library.get": parseLibrary(value, scope.actorId, scope.libraryId); return;
    case "photos.list": parsePage(value, scope.libraryId); return;
    case "photos.get": parsePhoto(value, scope.libraryId, string(identifiers.photoId) ? identifiers.photoId : undefined); return;
    case "photos.info": parseInfo(value); return;
    case "photos.lookup": {
      const matches = parseLookup(value);
      const hashes = Array.isArray(identifiers.sha256s) ? new Set(identifiers.sha256s.filter(string)) : null;
      if (!hashes || matches.some((match) => !hashes.has(match.sha256))) invalid();
      return;
    }
    case "masks.get": parseAsset(value, { kind: "mask", ...(string(identifiers.surfaceId) ? { sha256: identifiers.surfaceId } : {}) }); return;
    case "versions.get": parseVersions(value); return;
    case "recipes.put":
    case "photos.trash":
    case "photos.restore":
      if (!isRecord(value) || !Object.hasOwn(value, "value")) invalid();
      parsePhoto(value.value, scope.libraryId, string(identifiers.photoId) ? identifiers.photoId : undefined);
      return;
    case "versions.put":
      if (!isRecord(value) || !Object.hasOwn(value, "value")) invalid();
      parseVersions(value.value);
      return;
    case "media.ensure":
      if (!isRecord(value) || !Object.hasOwn(value, "value") || !media(value.value)) invalid();
      return;
    case "uploads.start":
    case "uploads.complete":
    case "uploads.cancel":
      if (!isRecord(value) || !Object.hasOwn(value, "value")) invalid();
      return;
    case "uploads.get":
      if (!isRecord(value) || !string(value.id) || !string(value.state)) invalid();
      return;
    case "uploads.renew":
      if (!isRecord(value) || !isRecord(value.upload) || !isRecord(value.ticket)) invalid();
      return;
    case "photos.purge":
      if (!isRecord(value) || !isRecord(value.value) || !string(value.value.id) || !string(value.value.state)) invalid();
      return;
    case "jobs.get":
      if (!isRecord(value) || !string(value.id) || !string(value.state) || !integer(value.pendingBytes)) invalid();
      return;
  }
}

function invalid(): never {
  throw new CloudPhotoError("invalid_response", null, null, false);
}
