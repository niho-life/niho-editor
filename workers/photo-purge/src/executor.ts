const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export type PhotoPurgeAsset = {
  readonly id: string;
  /** P02-only locator. This value must never enter public responses or logs. */
  readonly objectKey: string;
  readonly objectGeneration: string;
};

export type PhotoPurgeJobState = "queued" | "running" | "completed" | "retrying";
export type PhotoPurgeJobReceipt = { readonly id: string; readonly state: PhotoPurgeJobState; readonly pendingBytes: number };

export interface PhotoPurgeStorePort {
  getJob(ownerId: string, jobId: string): Promise<PhotoPurgeJobReceipt | null>;
  listPendingAssets(ownerId: string, jobId: string): Promise<readonly PhotoPurgeAsset[] | null>;
  confirmAssetDeleted(ownerId: string, jobId: string, assetId: string, objectGeneration: string): Promise<PhotoPurgeJobReceipt | null>;
}

export interface PhotoPurgeObjectDeletePort {
  /** Must delete only this immutable generation (for example with ifGenerationMatch). */
  deleteGeneration(input: { readonly objectKey: string; readonly ifGenerationMatch: string }): Promise<"deleted" | "already_absent" | "generation_mismatch">;
}

export type PhotoPurgeExecutionResult = {
  readonly confirmedAssets: number;
  readonly remainingAssets: number;
  readonly job: PhotoPurgeJobReceipt;
};

export class PhotoPurgeExecutionError extends Error {
  constructor(readonly code: "invalid_work_item" | "job_not_found" | "store_unavailable" | "delete_failed" | "generation_conflict" | "confirmation_failed") {
    super(`photo purge executor: ${code}`);
    this.name = "PhotoPurgeExecutionError";
  }
}

/**
 * Internal worker primitive only. P02 supplies owner-bound work items and records a deletion only
 * after the provider confirms the exact object generation is absent. Repeated/concurrent runs are
 * safe only when the provider honors ifGenerationMatch and treats the same generation as idempotent.
 */
export async function executePhotoPurge(
  ownerId: string,
  jobId: string,
  store: PhotoPurgeStorePort,
  objects: PhotoPurgeObjectDeletePort,
): Promise<PhotoPurgeExecutionResult> {
  if (typeof ownerId !== "string" || ownerId.length < 1 || ownerId.length > 256 || !UUID.test(jobId)) {
    throw new PhotoPurgeExecutionError("invalid_work_item");
  }
  let job: PhotoPurgeJobReceipt | null;
  try { job = await store.getJob(ownerId, jobId); } catch { throw new PhotoPurgeExecutionError("store_unavailable"); }
  if (!job) throw new PhotoPurgeExecutionError("job_not_found");
  let assets: readonly PhotoPurgeAsset[] | null;
  try { assets = await store.listPendingAssets(ownerId, jobId); } catch { throw new PhotoPurgeExecutionError("store_unavailable"); }
  if (assets === null) throw new PhotoPurgeExecutionError("job_not_found");

  if (assets.length > 0 && job.state === "completed") throw new PhotoPurgeExecutionError("confirmation_failed");
  if (assets.length === 0 && job.state !== "completed") throw new PhotoPurgeExecutionError("confirmation_failed");
  let confirmedAssets = 0;
  const seen = new Set<string>();
  for (const asset of assets) {
    if (!UUID.test(asset.id) || seen.has(asset.id) || typeof asset.objectKey !== "string" || asset.objectKey.length < 1
      || asset.objectKey.length > 2048 || typeof asset.objectGeneration !== "string" || asset.objectGeneration.length < 1
      || asset.objectGeneration.length > 255) throw new PhotoPurgeExecutionError("invalid_work_item");
    seen.add(asset.id);

    let deleted: "deleted" | "already_absent" | "generation_mismatch";
    try {
      deleted = await objects.deleteGeneration({ objectKey: asset.objectKey, ifGenerationMatch: asset.objectGeneration });
    } catch {
      throw new PhotoPurgeExecutionError("delete_failed");
    }
    if (deleted === "generation_mismatch") throw new PhotoPurgeExecutionError("generation_conflict");
    if (deleted !== "deleted" && deleted !== "already_absent") throw new PhotoPurgeExecutionError("delete_failed");

    try {
      const confirmed = await store.confirmAssetDeleted(ownerId, jobId, asset.id, asset.objectGeneration);
      if (!confirmed) throw new PhotoPurgeExecutionError("confirmation_failed");
      job = confirmed;
      confirmedAssets += 1;
    } catch (error) {
      if (error instanceof PhotoPurgeExecutionError) throw error;
      throw new PhotoPurgeExecutionError("confirmation_failed");
    }
  }

  return { confirmedAssets, remainingAssets: Math.max(0, assets.length - confirmedAssets), job };
}
