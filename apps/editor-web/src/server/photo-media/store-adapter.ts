import "server-only";
import {
  PhotoRevisionConflictError,
  PhotoStoreError,
  ensurePhotoMediaJob,
  type Database,
  type PhotoMediaOutputSpec,
} from "@niho/editor-store";
import { PHOTO_ERROR_STATUS } from "../../../../../packages/photo-library-contract/src/v1";
import { photoFromSnapshot } from "../photo-catalog/store-adapter";
import { PhotoMediaError } from "./api";
import type { PhotoMediaStore } from "./types";

function mapStoreError(error: unknown): never {
  if (error instanceof PhotoRevisionConflictError) throw new PhotoMediaError("revision_conflict", error.currentRevision);
  if (error instanceof PhotoStoreError) {
    const code = error.code as keyof typeof PHOTO_ERROR_STATUS;
    if (Object.hasOwn(PHOTO_ERROR_STATUS, code)) throw new PhotoMediaError(code);
  }
  throw error;
}

export function createPhotoMediaStore(db: Database, spec: PhotoMediaOutputSpec): PhotoMediaStore {
  return {
    ensure: async (owner, photoId, input) => {
      try {
        const result = await ensurePhotoMediaJob(db, owner, photoId, input, spec);
        if (!result) return null;
        const photo = photoFromSnapshot(result.snapshot);
        return {
          snapshot: { ownerId: result.snapshot.library.owner, photoId: photo.id, media: photo.media },
          replayed: result.replayed,
        };
      } catch (error) {
        return mapStoreError(error);
      }
    },
  };
}
