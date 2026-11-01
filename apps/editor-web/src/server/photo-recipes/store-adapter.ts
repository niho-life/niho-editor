import "server-only";
import {
  PhotoRevisionConflictError,
  PhotoStoreError,
  getPhotoCanonicalWorkingCopy,
  getPhotoSnapshot,
  getPhotoVersions,
  putPhotoRecipe,
  putPhotoVersions,
  replayPhotoWrite,
  type Database,
  type PhotoRecipeRecord,
  type PhotoSnapshot,
  type PhotoVersionSetRecord,
} from "@niho/editor-store";
import {
  PHOTO_ERROR_STATUS,
  type Photo,
  type PhotoCapabilities,
  type VersionSet,
} from "../../../../../packages/photo-library-contract/src/v1";
import { photoFromSnapshot } from "../photo-catalog/store-adapter";
import { PhotoRecipeError } from "./api";
import type { PhotoCanonicalContextResolver, PhotoRecipeLibrarySnapshot, PhotoRecipeSnapshot, PhotoRecipeStore } from "./types";

function recipe(value: PhotoRecipeRecord): Photo["recipe"] {
  return {
    revision: value.revision,
    settings: value.settings,
    settingsSha256: value.settingsSha256,
    baseVersion: value.baseVersion,
    maskSurfaceIds: [...value.maskSurfaceIds],
    updatedAt: value.updatedAt,
  };
}
function librarySnapshot(snapshot: PhotoSnapshot, capabilities: PhotoCapabilities): PhotoRecipeLibrarySnapshot {
  return {
    id: snapshot.library.id,
    owner: { type: "user", userId: snapshot.library.owner },
    state: snapshot.library.state,
    revision: snapshot.library.revision,
    capabilities,
  };
}

function recipeSnapshot(snapshot: PhotoSnapshot, capabilities: PhotoCapabilities): PhotoRecipeSnapshot {
  return { photo: photoFromSnapshot(snapshot), library: librarySnapshot(snapshot, capabilities) };
}

function versions(value: PhotoVersionSetRecord): VersionSet {
  return {
    revision: value.revision,
    versions: value.versions.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      createdAt: item.createdAt,
      recipe: recipe(item.recipe),
    })),
  };
}

function mapStoreError(error: unknown): never {
  if (error instanceof PhotoRevisionConflictError) throw new PhotoRecipeError("revision_conflict", error.currentRevision);
  if (error instanceof PhotoStoreError) {
    const code = error.code as keyof typeof PHOTO_ERROR_STATUS;
    if (Object.hasOwn(PHOTO_ERROR_STATUS, code)) throw new PhotoRecipeError(code);
  }
  throw error;
}

async function fromStore<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { return mapStoreError(error); }
}

export function createPhotoRecipeStore(db: Database, capabilities: PhotoCapabilities): PhotoRecipeStore {
  return {
    photo: async (owner, photoId) => {
      const snapshot = await fromStore(() => getPhotoSnapshot(db, owner, photoId));
      return snapshot ? recipeSnapshot(snapshot, capabilities) : null;
    },
    versionSet: async (owner, photoId) => {
      const snapshot = await fromStore(() => getPhotoVersions(db, owner, photoId));
      return snapshot ? { ...recipeSnapshot(snapshot, capabilities), versions: versions(snapshot.versions) } : null;
    },
    replayRecipe: async (owner, photoId, input) => {
      const snapshot = await fromStore(() => replayPhotoWrite(db, owner, photoId, "recipe", input));
      return snapshot ? recipeSnapshot(snapshot, capabilities) : null;
    },
    replayVersions: async (owner, photoId, input) => {
      const snapshot = await fromStore(() => replayPhotoWrite(db, owner, photoId, "versions", input));
      return snapshot ? { ...recipeSnapshot(snapshot, capabilities), versions: versions(snapshot.versions) } : null;
    },
    putRecipe: async (owner, photoId, input) => {
      const result = await fromStore(() => putPhotoRecipe(db, owner, photoId, input));
      return result ? { photo: photoFromSnapshot(result.snapshot), replayed: result.replayed } : null;
    },
    putVersions: async (owner, photoId, input) => {
      const result = await fromStore(() => putPhotoVersions(db, owner, photoId, input));
      return result ? { versions: versions(result.versions), replayed: result.replayed } : null;
    },
  };
}

/** Owner-scoped, read-only P02 adapter. No provider locator crosses this boundary. */
export function createPhotoCanonicalContextResolver(db: Database): PhotoCanonicalContextResolver {
  return async (expected) => {
    const found = await getPhotoCanonicalWorkingCopy(db, expected.ownerId, expected.photoId, {
      libraryId: expected.libraryId,
      originalAssetId: expected.originalAssetId,
      originalSha256: expected.originalSha256,
      baseVersion: expected.baseVersion,
      rendererManifestSha256: expected.rendererManifestSha256,
    });
    if (!found) return null;
    return {
      ownerId: found.ownerId,
      libraryId: found.libraryId,
      photoId: found.photoId,
      originalAssetId: found.originalAssetId,
      originalSha256: found.originalSha256,
      baseVersion: found.baseVersion,
      rendererManifestSha256: found.rendererManifestSha256,
      workingCopy: {
        asset: {
          id: found.workingCopy.asset.id,
          kind: found.workingCopy.asset.kind,
          sha256: found.workingCopy.asset.sha256,
          sizeBytes: found.workingCopy.asset.sizeBytes,
          contentType: found.workingCopy.asset.contentType,
          width: found.workingCopy.asset.width,
          height: found.workingCopy.asset.height,
        },
        baseVersion: found.workingCopy.baseVersion,
        encoding: found.workingCopy.encoding,
        meta: found.workingCopy.meta,
      },
    };
  };
}
