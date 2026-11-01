import "server-only";
import { createHash } from "node:crypto";
import { PHOTO_LIMITS, type Json, type JsonObject, type PhotoErrorCode, type Photo, type RecipeDocument, type VersionSet } from "../../../../../packages/photo-library-contract/src/v1";
import type { PhotoRecipeDeps, PhotoRecipeSnapshot, ValidatedRecipeWrite, ValidatedVersionWrite } from "./types";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const KEY = /^[A-Za-z0-9_-]{16,128}$/;
const RECIPE_KEYS = ["revision", "settings", "settingsSha256", "baseVersion", "maskSurfaceIds", "updatedAt"] as const;
const VERSION_KEYS = ["id", "name", "kind", "recipe", "createdAt"] as const;

export class PhotoRecipeError extends Error {
  constructor(readonly code: PhotoErrorCode, readonly currentRevision?: number) { super(`photo recipes: ${code}`); }
}

function fail(code: PhotoErrorCode, currentRevision?: number): never { throw new PhotoRecipeError(code, currentRevision); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function scalarString(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function cloneJson(value: unknown, depth = 0): Json {
  if (depth > PHOTO_LIMITS.maxJsonDepth) fail("invalid_request");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_request");
    return value;
  }
  if (typeof value === "string") {
    if (!scalarString(value)) fail("invalid_request");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => cloneJson(item, depth + 1));
  if (!record(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail("invalid_request");
  const result: Record<string, Json> = Object.create(null) as Record<string, Json>;
  for (const [key, child] of Object.entries(value)) {
    if (!scalarString(key)) fail("invalid_request");
    result[key] = cloneJson(child, depth + 1);
  }
  return result;
}

function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(",")}}`;
}

function hash(value: Json): string { return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex"); }
function jsonBytes(value: Json): number { return Buffer.byteLength(canonicalJson(value), "utf8"); }
function validInstant(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }

function safePhoto(photo: Photo): Photo {
  const media = photo.media;
  const asset = (value: Photo["original"]) => ({ id: value.id, kind: value.kind, sha256: value.sha256, sizeBytes: value.sizeBytes,
    contentType: value.contentType, width: value.width, height: value.height });
  const value: Photo = {
    id: photo.id, libraryId: photo.libraryId, storageState: photo.storageState, lifecycle: photo.lifecycle, fileName: photo.fileName,
    format: photo.format, hasEdits: photo.hasEdits, addedAt: photo.addedAt, capturedAt: photo.capturedAt, width: photo.width, height: photo.height,
    original: asset(photo.original), trashedAt: photo.trashedAt, purgeAfter: photo.purgeAfter,
    recipe: { revision: photo.recipe.revision, settings: photo.recipe.settings, settingsSha256: photo.recipe.settingsSha256,
      baseVersion: photo.recipe.baseVersion, maskSurfaceIds: [...photo.recipe.maskSurfaceIds], updatedAt: photo.recipe.updatedAt },
    media: media.state === "ready"
      ? { state: "ready", thumbnail: asset(media.thumbnail), preview: asset(media.preview),
        workingCopy: media.workingCopy ? { asset: asset(media.workingCopy.asset), baseVersion: media.workingCopy.baseVersion,
          encoding: media.workingCopy.encoding, meta: media.workingCopy.meta } : null,
        recipeRevision: media.recipeRevision, rendererManifestSha256: media.rendererManifestSha256 }
      : "jobId" in media ? { state: media.state, jobId: media.jobId } : { state: media.state, code: media.code },
  };
  let json: Json;
  try { json = cloneJson(value); } catch { fail("temporarily_unavailable"); }
  if (jsonBytes(json) > PHOTO_LIMITS.maxPageBytes || (value.media.state === "ready" && value.media.workingCopy
    && jsonBytes(cloneJson(value.media.workingCopy.meta)) > PHOTO_LIMITS.maxWorkingCopyMetaBytes)) fail("temporarily_unavailable");
  return value;
}

function safeVersionSet(set: VersionSet): VersionSet {
  return { revision: set.revision, versions: set.versions.map((version) => ({
    id: version.id, name: version.name, kind: version.kind, createdAt: version.createdAt,
    recipe: { revision: version.recipe.revision, settings: version.recipe.settings, settingsSha256: version.recipe.settingsSha256,
      baseVersion: version.recipe.baseVersion, maskSurfaceIds: [...version.recipe.maskSurfaceIds], updatedAt: version.recipe.updatedAt },
  })) };
}

function assertSnapshot(owner: string, photoId: string, snapshot: PhotoRecipeSnapshot | null): asserts snapshot is PhotoRecipeSnapshot {
  if (!snapshot || snapshot.library.owner.userId !== owner || snapshot.library.id !== snapshot.photo.libraryId
    || snapshot.photo.id.toLowerCase() !== photoId.toLowerCase()) fail("not_found");
  if (snapshot.library.state === "deleting") fail("account_deleting");
}

function assertWritable(snapshot: PhotoRecipeSnapshot, versions = false) {
  if (snapshot.photo.lifecycle !== "active") fail("photo_trashed");
  if (!snapshot.library.capabilities.edits || (versions && !snapshot.library.capabilities.versions)) fail("unsupported_settings");
}

function parseExpectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("invalid_request");
  return value as number;
}

function parseSettings(value: unknown, maxBytes = PHOTO_LIMITS.maxRecipeBytes): RecipeDocument["settings"] {
  const cloned = cloneJson(value);
  if (!record(cloned) || typeof cloned.v !== "number" || !Number.isSafeInteger(cloned.v) || typeof cloned.engine !== "string"
    || !scalarString(cloned.engine) || jsonBytes(cloned) > maxBytes) fail("unsupported_settings");
  return cloned as RecipeDocument["settings"];
}

function validatedEnvelope(recipe: RecipeDocument["settings"], settingsSha256: string, baseVersion: string | null,
  maskSurfaceIds: readonly string[]): ValidatedRecipeWrite {
  if (!SHA256.test(settingsSha256) || maskSurfaceIds.some((id) => !SHA256.test(id)) || new Set(maskSurfaceIds).size !== maskSurfaceIds.length) fail("unsupported_settings");
  return { settings: recipe, settingsSha256, baseVersion, maskSurfaceIds: [...maskSurfaceIds].sort() };
}

async function validateRecipe(deps: PhotoRecipeDeps, recipe: RecipeDocument["settings"], snapshot: PhotoRecipeSnapshot): Promise<ValidatedRecipeWrite> {
  if (!snapshot.library.capabilities.renderer.settingsVersions.includes(recipe.v)
    || !snapshot.library.capabilities.renderer.engines.includes(recipe.engine)) fail("unsupported_settings");
  const compatible = await deps.validator.validate(recipe, snapshot);
  if (!compatible) fail("unsupported_settings");
  return validatedEnvelope(recipe, compatible.settingsSha256, snapshot.photo.recipe.baseVersion, compatible.maskSurfaceIds);
}

function parseVersionInput(value: unknown, currentBase: string | null): Omit<ValidatedVersionWrite, "recipe"> & { readonly inputSettings: RecipeDocument["settings"] } {
  if (!record(value) || !exactKeys(value, VERSION_KEYS) || typeof value.id !== "string" || !UUID.test(value.id)
    || typeof value.name !== "string" || !scalarString(value.name) || Buffer.byteLength(value.name, "utf8") > PHOTO_LIMITS.maxVersionNameBytes
    || (value.kind !== "named" && value.kind !== "auto") || !validInstant(value.createdAt) || !record(value.recipe)
    || !exactKeys(value.recipe, RECIPE_KEYS) || !Number.isSafeInteger(value.recipe.revision) || (value.recipe.revision as number) < 0
    || typeof value.recipe.settingsSha256 !== "string" || !SHA256.test(value.recipe.settingsSha256)
    || !(value.recipe.baseVersion === null || typeof value.recipe.baseVersion === "string")
    || !Array.isArray(value.recipe.maskSurfaceIds) || value.recipe.maskSurfaceIds.some((id) => typeof id !== "string" || !SHA256.test(id))
    || !validInstant(value.recipe.updatedAt) || value.recipe.baseVersion !== currentBase) fail("unsupported_settings");
  return { id: value.id.toLowerCase(), name: value.name, kind: value.kind, inputSettings: parseSettings(value.recipe.settings) };
}

export function createPhotoRecipesApi(deps: PhotoRecipeDeps) {
  const snapshotFor = async (owner: string, photoId: string): Promise<PhotoRecipeSnapshot> => {
    if (!UUID.test(photoId)) fail("not_found");
    const snapshot = await deps.store.photo(owner, photoId.toLowerCase());
    assertSnapshot(owner, photoId, snapshot);
    return snapshot;
  };
  const key = (value: unknown): string => {
    if (typeof value !== "string" || !KEY.test(value)) fail("invalid_request");
    return value;
  };

  return {
    async putRecipe(owner: string, photoId: string, body: unknown, idempotencyKey: unknown) {
      if (!UUID.test(photoId)) fail("not_found");
      const idempotency = key(idempotencyKey);
      if (!record(body) || !exactKeys(body, ["expectedRevision", "settings", "baseVersion"]) || !(body.baseVersion === null || typeof body.baseVersion === "string")) fail("invalid_request");
      const expectedRevision = parseExpectedRevision(body.expectedRevision);
      const settings = parseSettings(body.settings);
      const normalized = cloneJson(body);
      if (jsonBytes(normalized) > PHOTO_LIMITS.maxRecipeBodyBytes) fail("request_too_large");
      const requestHash = hash(normalized);
      const replay = await deps.store.replayRecipe(owner, photoId.toLowerCase(), { key: idempotency, requestHash });
      if (replay) {
        assertSnapshot(owner, photoId, replay);
        return { value: safePhoto(replay.photo), replayed: true };
      }
      const snapshot = await snapshotFor(owner, photoId);
      assertWritable(snapshot);
      if (body.baseVersion !== snapshot.photo.recipe.baseVersion) fail("unsupported_settings");
      const recipe = await validateRecipe(deps, settings, snapshot);
      const receipt = await deps.store.putRecipe(owner, photoId.toLowerCase(), {
        expectedRevision, key: idempotency, requestHash, recipe,
      });
      if (!receipt) fail("not_found");
      return { value: safePhoto(receipt.photo), replayed: receipt.replayed };
    },

    async getVersions(owner: string, photoId: string) {
      if (!UUID.test(photoId)) fail("not_found");
      const found = await deps.store.versionSet(owner, photoId.toLowerCase());
      assertSnapshot(owner, photoId, found);
      const value = safeVersionSet(found.versions);
      if (value.versions.length > PHOTO_LIMITS.maxVersions || jsonBytes(cloneJson(value)) > PHOTO_LIMITS.maxVersionsBytes) fail("temporarily_unavailable");
      return value;
    },

    async putVersions(owner: string, photoId: string, body: unknown, idempotencyKey: unknown) {
      if (!UUID.test(photoId)) fail("not_found");
      const idempotency = key(idempotencyKey);
      if (!record(body) || !exactKeys(body, ["expectedRevision", "versions"]) || !Array.isArray(body.versions)
        || body.versions.length > PHOTO_LIMITS.maxVersions) fail("invalid_request");
      const expectedRevision = parseExpectedRevision(body.expectedRevision);
      const normalized = cloneJson(body);
      if (jsonBytes(normalized) > PHOTO_LIMITS.maxVersionsBodyBytes) fail("request_too_large");
      const requestHash = hash(normalized);
      const replay = await deps.store.replayVersions(owner, photoId.toLowerCase(), { key: idempotency, requestHash });
      if (replay) {
        assertSnapshot(owner, photoId, replay);
        const value = safeVersionSet(replay.versions);
        if (value.versions.length > PHOTO_LIMITS.maxVersions || jsonBytes(cloneJson(value)) > PHOTO_LIMITS.maxVersionsBytes) fail("temporarily_unavailable");
        return { value, replayed: true };
      }
      const found = await deps.store.versionSet(owner, photoId.toLowerCase());
      assertSnapshot(owner, photoId, found);
      assertWritable(found, true);
      const requested = body.versions.map((item) => parseVersionInput(item, found.photo.recipe.baseVersion));
      if (new Set(requested.map((version) => version.id)).size !== requested.length) fail("invalid_request");
      const versions: ValidatedVersionWrite[] = [];
      for (const version of requested) {
        const recipe = await validateRecipe(deps, version.inputSettings, found);
        versions.push({ id: version.id, name: version.name, kind: version.kind, recipe });
      }
      const receipt = await deps.store.putVersions(owner, photoId.toLowerCase(), {
        expectedRevision, key: idempotency, requestHash, versions,
      });
      if (!receipt) fail("not_found");
      const value = safeVersionSet(receipt.versions);
      if (value.versions.length > PHOTO_LIMITS.maxVersions || jsonBytes(cloneJson(value)) > PHOTO_LIMITS.maxVersionsBytes) fail("temporarily_unavailable");
      return { value, replayed: receipt.replayed };
    },
  };
}
