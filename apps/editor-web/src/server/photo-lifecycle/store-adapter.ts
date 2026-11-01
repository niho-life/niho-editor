import "server-only";
import {
  PhotoStoreError,
  beginPhotoPurge,
  getPhotoPurgeJob,
  getPhotoSnapshot,
  restorePhoto,
  trashPhoto,
  type Database,
  type PhotoPurgeJob,
} from "@niho/editor-store";
import { PHOTO_ERROR_STATUS, type PurgeJob } from "../../../../../packages/photo-library-contract/src/v1";
import { photoFromSnapshot } from "../photo-catalog/store-adapter";
import { PhotoLifecycleError } from "./api";
import type { PhotoLifecycleMutation, PhotoLifecycleStore } from "./types";

function mapStoreError(error: unknown): never {
  if (error instanceof PhotoStoreError) {
    const code = error.code as keyof typeof PHOTO_ERROR_STATUS;
    if (Object.hasOwn(PHOTO_ERROR_STATUS, code)) throw new PhotoLifecycleError(code);
  }
  throw error;
}

async function fromStore<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { return mapStoreError(error); }
}

function purgeJob(job: PhotoPurgeJob): PurgeJob {
  return { id: job.id, state: job.state, pendingBytes: job.pendingBytes };
}

export function createPhotoLifecycleStore(db: Database): PhotoLifecycleStore {
  async function photo(owner: string, photoId: string) {
    const snapshot = await fromStore(() => getPhotoSnapshot(db, owner, photoId));
    return snapshot ? photoFromSnapshot(snapshot) : null;
  }

  async function mutatePhoto(
    owner: string,
    photoId: string,
    input: PhotoLifecycleMutation,
    operation: typeof trashPhoto | typeof restorePhoto,
  ) {
    const result = await fromStore(() => operation(db, owner, photoId, input));
    if (!result) return null;
    const current = await photo(owner, photoId);
    if (!current) throw new PhotoLifecycleError("temporarily_unavailable");
    return { photo: current, replayed: result.replayed };
  }

  return {
    photo,
    trash: (owner, photoId, input) => mutatePhoto(owner, photoId, input, trashPhoto),
    restore: (owner, photoId, input) => mutatePhoto(owner, photoId, input, restorePhoto),
    purge: async (owner, photoId, input) => {
      const result = await fromStore(() => beginPhotoPurge(db, owner, photoId, input));
      return result ? { job: purgeJob(result.job), replayed: result.replayed } : null;
    },
    job: async (owner, jobId) => {
      const result = await fromStore(() => getPhotoPurgeJob(db, owner, jobId));
      return result ? purgeJob(result) : null;
    },
  };
}
