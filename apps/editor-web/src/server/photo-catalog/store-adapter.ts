import "server-only";
import {
  getPhotoInfo, getPhotoLibrary, getPhotoSnapshot, listPhotoCatalogPage, lookupPhotoHashes,
  type Database, type PhotoAssetRecord, type PhotoLibraryRecord, type PhotoMediaProjection, type PhotoSnapshot,
} from "@niho/editor-store";
import { PHOTO_LIMITS, type Photo, type PhotoAsset, type PhotoCapabilities, type PersonalPhotoLibrary } from "../../../../../packages/photo-library-contract/src/v1";
import type { PhotoCatalogStore } from "./types";

function unavailable(): never { throw new Error("photo catalog projection unavailable"); }

function asset(record: PhotoAssetRecord): PhotoAsset {
  if (record.deletionState !== "retained") unavailable();
  return { id: record.id, kind: record.kind, sha256: record.sha256, sizeBytes: record.sizeBytes,
    contentType: record.contentType, width: record.width, height: record.height };
}

function media(record: PhotoMediaProjection | null): Photo["media"] {
  if (!record) unavailable();
  if (record.state === "queued" || record.state === "processing") return { state: record.state, jobId: record.id };
  if (record.state === "failed" || record.state === "unsupported") {
    if (!record.errorCode) unavailable();
    return { state: record.state, code: record.errorCode };
  }
  const ready = record.ready;
  if (!ready || typeof ready.thumbnailId !== "string" || typeof ready.previewId !== "string") unavailable();
  const byId = new Map(record.assets.map((item) => [item.id, item]));
  const thumbnail = byId.get(ready.thumbnailId), preview = byId.get(ready.previewId);
  if (!thumbnail || thumbnail.kind !== "thumbnail" || !preview || preview.kind !== "preview") unavailable();
  let workingCopy: Extract<Photo["media"], { state: "ready" }>["workingCopy"] = null;
  if (ready.workingCopy !== null) {
    const copy = ready.workingCopy as Record<string, unknown> | null;
    if (!copy || typeof copy !== "object" || Array.isArray(copy) || typeof copy.assetId !== "string"
      || typeof copy.baseVersion !== "string" || (copy.encoding !== "png16" && copy.encoding !== "jpeg8")
      || !copy.meta || typeof copy.meta !== "object" || Array.isArray(copy.meta)) unavailable();
    const found = byId.get(copy.assetId);
    if (!found || found.kind !== "working-copy") unavailable();
    workingCopy = { asset: asset(found), baseVersion: copy.baseVersion, encoding: copy.encoding,
      meta: copy.meta as Record<string, never> };
  }
  return { state: "ready", thumbnail: asset(thumbnail), preview: asset(preview), workingCopy,
    recipeRevision: record.recipeRevision, rendererManifestSha256: record.rendererManifestSha256 };
}

function photo(snapshot: PhotoSnapshot): Photo {
  const p = snapshot.photo, r = snapshot.recipe;
  if (p.libraryId !== snapshot.library.id || p.original.kind !== "original" || p.original.deletionState !== "retained") unavailable();
  return { id: p.id, libraryId: p.libraryId, storageState: "stored", lifecycle: p.lifecycle,
    fileName: p.fileName, format: p.format, hasEdits: snapshot.hasEdits, addedAt: p.addedAt,
    capturedAt: p.capturedAt, width: p.width, height: p.height, original: asset(p.original),
    recipe: { revision: r.revision, settings: r.settings, settingsSha256: r.settingsSha256,
      baseVersion: r.baseVersion, maskSurfaceIds: r.maskSurfaceIds, updatedAt: r.updatedAt },
    media: media(snapshot.media), trashedAt: p.trashedAt, purgeAfter: p.purgeAfter };
}

function library(record: PhotoLibraryRecord, capabilities: PhotoCapabilities): PersonalPhotoLibrary {
  return { contractVersion: 1, id: record.id, owner: { type: "user", userId: record.owner },
    state: record.state, revision: record.revision, usage: { ...record.usage }, limits: PHOTO_LIMITS, capabilities };
}

export function createPhotoCatalogStore(db: Database, capabilities: PhotoCapabilities): PhotoCatalogStore {
  return {
    library: async (owner) => library(await getPhotoLibrary(db, owner), capabilities),
    page: async (owner, input) => {
      const result = await listPhotoCatalogPage(db, owner, { ...input, filter: {
        ...input.filter, editableEngines: capabilities.renderer.engines,
        editableSettingsVersions: capabilities.renderer.settingsVersions,
        editableBaseVersions: [], maskSurfaces: capabilities.maskSurfaces,
      } });
      return result && { library: library(result.library, capabilities), watermark: result.watermark,
        items: result.items.map(photo), hasMore: result.hasMore };
    },
    photo: async (owner, id) => {
      const result = await getPhotoSnapshot(db, owner, id);
      return result && { photo: photo(result), library: { id: result.library.id,
        owner: { type: "user" as const, userId: result.library.owner }, state: result.library.state, revision: result.library.revision } };
    },
    info: async (owner, id) => (await getPhotoInfo(db, owner, id)) ?? null,
    lookup: (owner, hashes) => lookupPhotoHashes(db, owner, hashes),
  };
}
