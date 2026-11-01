import "server-only";
import {
  confirmPhotoAssetDeleted,
  getPhotoPurgeJob,
  listPhotoPurgeAssets,
  type Database,
} from "@niho/editor-store";
import type { PhotoPurgeJobReceipt, PhotoPurgeStorePort } from "../../../../../workers/photo-purge/src/executor";

function receipt(job: Awaited<ReturnType<typeof getPhotoPurgeJob>>): PhotoPurgeJobReceipt | null {
  return job ? { id: job.id, state: job.state, pendingBytes: job.pendingBytes } : null;
}

/** Internal worker adapter. P02 owner-bound queries remain the only source of purge locators. */
export function createP02PhotoPurgeStore(db: Database): PhotoPurgeStorePort {
  return {
    getJob: async (ownerId, jobId) => receipt(await getPhotoPurgeJob(db, ownerId, jobId)),
    listPendingAssets: async (ownerId, jobId) => {
      const assets = await listPhotoPurgeAssets(db, ownerId, jobId);
      return assets?.map(({ id, objectKey, objectGeneration }) => ({ id, objectKey, objectGeneration })) ?? null;
    },
    confirmAssetDeleted: async (ownerId, jobId, assetId, objectGeneration) =>
      receipt(await confirmPhotoAssetDeleted(db, ownerId, jobId, assetId, objectGeneration)),
  };
}
