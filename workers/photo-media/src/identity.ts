import { createHash } from "node:crypto";
import { PHOTO_LIMITS } from "../../../packages/photo-library-contract/src/v1.ts";
import { MEDIA_BASELINE } from "./baseline.ts";
import type { MediaIdentity, MediaSource } from "./types.ts";

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const positive = (n: number) => Number.isSafeInteger(n) && n > 0;

export function mediaIdentity(source: MediaSource): MediaIdentity {
  if (!source.ownerId || source.ownerId.length > 512 || !UUID.test(source.photoId) || !UUID.test(source.original.assetId)
    || !Number.isSafeInteger(source.lifecycleGeneration) || source.lifecycleGeneration < 0 || !HASH.test(source.original.sha256)
    || !source.original.generation || source.original.generation.length > 128
    || !positive(source.original.sizeBytes) || source.original.sizeBytes > PHOTO_LIMITS.maxFileBytes
    || !positive(source.width) || !positive(source.height) || source.width * source.height > PHOTO_LIMITS.maxPixels
    || !Number.isSafeInteger(source.recipe.revision) || source.recipe.revision < 0 || !HASH.test(source.recipe.settingsSha256)
    || (source.baseVersion !== null && (!source.baseVersion || source.baseVersion.length > 512))
    || (source.recipe.baseVersion !== null && source.recipe.baseVersion !== source.baseVersion)) {
    throw new Error("photo-media: invalid source identity");
  }
  return {
    ownerId: source.ownerId, photoId: source.photoId, lifecycleGeneration: source.lifecycleGeneration,
    original: { ...source.original }, format: source.format, width: source.width, height: source.height,
    baseVersion: source.baseVersion, recipeRevision: source.recipe.revision, settingsSha256: source.recipe.settingsSha256,
    rendererManifestSha256: MEDIA_BASELINE.manifestSha256,
    thumbnailMaxEdge: PHOTO_LIMITS.thumbnailMaxEdge, previewMaxEdge: PHOTO_LIMITS.previewMaxEdge,
    workingCopyMaxEdge: PHOTO_LIMITS.workingCopyMaxEdge,
  };
}

/** P02 hashes the canonical identity object; property insertion order must not change the durable job key. */
export function mediaJobKey(identity: MediaIdentity): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  };
  return createHash("sha256").update(canonical(identity)).digest("hex");
}

export function matchesSource(identity: MediaIdentity, source: MediaSource | null): source is MediaSource {
  if (!source || source.lifecycle !== "active") return false;
  try { return mediaJobKey(identity) === mediaJobKey(mediaIdentity(source)); } catch { return false; }
}
