import "server-only";
import { reservePhotoUpload, getPhotoUpload, claimPhotoUploadVerification, completePhotoUpload, cancelPhotoUpload, rejectPhotoUpload, recordPhotoOrphan, getPhotoAsset, getPhotoUploadByStartKey, getPhotoMaskBySurfaceId, getPhotoSnapshot, bindPhotoRequest, type Database, type PhotoJson, type PhotoJsonObject, type PhotoSnapshot } from "@niho/editor-store";
import type { Photo } from "../../../../../packages/photo-library-contract/src/v1";
import { publicPhotoAsset } from "./api";
import { fail } from "./http";
import type { PhotoMutationJournal, PhotoTransferStore } from "./types";

function jsonObject(value: PhotoJson | undefined): value is PhotoJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Narrow transfer projection; can share P04's projection after the catalog adapter lands. */
export function photoTransferSnapshot(snapshot: PhotoSnapshot): Photo {
  const { photo, recipe, media } = snapshot;
  if (photo.original.kind !== "original" || photo.original.deletionState !== "retained") fail("temporarily_unavailable");
  let visibleMedia: Photo["media"];
  if (!media) visibleMedia = { state: "pending" };
  else if (media.state === "queued" || media.state === "processing") visibleMedia = { state: media.state, jobId: media.id };
  else if (media.state === "failed" || media.state === "unsupported") {
    if (!media.errorCode) fail("temporarily_unavailable");
    visibleMedia = { state: media.state, code: media.errorCode };
  } else {
    const ready = media.ready;
    if (!ready) fail("temporarily_unavailable");
    const asset = (id: unknown, kind: "thumbnail" | "preview" | "working-copy") => {
      const found = media.assets.find((item) => item.id === id && item.photoId === photo.id && item.kind === kind && item.deletionState === "retained");
      if (!found) fail("temporarily_unavailable");
      return publicPhotoAsset(found);
    };
    const working = ready.workingCopy;
    let workingCopy: Extract<Photo["media"], { state: "ready" }>["workingCopy"] = null;
    if (working !== null) {
      if (!jsonObject(working)
        || typeof working.baseVersion !== "string" || !["png16", "jpeg8"].includes(working.encoding as string)
        || !jsonObject(working.meta)
        || Buffer.byteLength(JSON.stringify(working.meta)) > 64 * 1024) fail("temporarily_unavailable");
      workingCopy = { asset: asset(working.assetId, "working-copy"), baseVersion: working.baseVersion,
        encoding: working.encoding as "png16" | "jpeg8", meta: working.meta };
    }
    visibleMedia = { state: "ready", thumbnail: asset(ready.thumbnailId, "thumbnail"), preview: asset(ready.previewId, "preview"),
      workingCopy, recipeRevision: media.recipeRevision, rendererManifestSha256: media.rendererManifestSha256 };
  }
  return {
    id: photo.id, libraryId: photo.libraryId, storageState: "stored", lifecycle: photo.lifecycle,
    fileName: photo.fileName, format: photo.format, hasEdits: snapshot.hasEdits, addedAt: photo.addedAt,
    capturedAt: photo.capturedAt, width: photo.width, height: photo.height, original: publicPhotoAsset(photo.original),
    recipe: { revision: recipe.revision, settings: recipe.settings, settingsSha256: recipe.settingsSha256,
      baseVersion: recipe.baseVersion, maskSurfaceIds: recipe.maskSurfaceIds, updatedAt: recipe.updatedAt },
    media: visibleMedia, trashedAt: photo.trashedAt, purgeAfter: photo.purgeAfter,
  };
}

export function createP02PhotoMutationJournal(db: Database): PhotoMutationJournal {
  return { bind: ({ owner, ...input }) => bindPhotoRequest(db, owner, input) };
}

/** Every lookup delegates to P02's owner-bound API; no SQL or unscoped lookup is added here. */
export function createP02PhotoTransferStore(db: Database): PhotoTransferStore {
  return {
    reserve: (owner, input) => reservePhotoUpload(db, owner, input),
    upload: (owner, id) => getPhotoUpload(db, owner, id),
    claim: (owner, id) => claimPhotoUploadVerification(db, owner, id),
    complete: (owner, id, object) => completePhotoUpload(db, owner, id, object),
    cancel: (owner, id) => cancelPhotoUpload(db, owner, id),
    reject: (owner, id, lease, code) => rejectPhotoUpload(db, owner, id, lease, code),
    orphan: (owner, input) => recordPhotoOrphan(db, owner, input),
    asset: (owner, photo, id) => getPhotoAsset(db, owner, photo, id),
    photo: async (owner, id) => { const snapshot = await getPhotoSnapshot(db, owner, id); return snapshot ? photoTransferSnapshot(snapshot) : null; },
    mask: (owner, photoId, surfaceId) => getPhotoMaskBySurfaceId(db, owner, photoId, surfaceId),
    uploadByStartKey: (owner, operation, key) => getPhotoUploadByStartKey(db, owner, operation, key),
  };
}
