import { describe, expect, it, vi } from "vitest";
import { IDS } from "../../../../../packages/photo-library-contract/fixtures/v1";
import { executePhotoPurge, PhotoPurgeExecutionError, type PhotoPurgeObjectDeletePort, type PhotoPurgeStorePort } from "../../../../../workers/photo-purge/src/executor";

const job = { id: IDS.job, state: "queued" as const, pendingBytes: 100 };
const asset = { id: IDS.original, objectKey: "synthetic-object-key", objectGeneration: "42" };

function arrange() {
  const store: PhotoPurgeStorePort = {
    getJob: vi.fn(async () => job),
    listPendingAssets: vi.fn(async () => [asset]),
    confirmAssetDeleted: vi.fn(async () => ({ ...job, state: "completed" as const, pendingBytes: 0 })),
  };
  const deleteGeneration = vi.fn<PhotoPurgeObjectDeletePort["deleteGeneration"]>(async () => "deleted");
  const objects: PhotoPurgeObjectDeletePort = { deleteGeneration };
  return { store, objects, deleteGeneration };
}

describe("photo purge executor", () => {
  it("deletes one exact generation before confirming the P02 ledger", async () => {
    const f = arrange();
    const result = await executePhotoPurge(IDS.userA, IDS.job, f.store, f.objects);
    expect(f.objects.deleteGeneration).toHaveBeenCalledWith({ objectKey: asset.objectKey, ifGenerationMatch: "42" });
    expect(f.store.confirmAssetDeleted).toHaveBeenCalledWith(IDS.userA, IDS.job, IDS.original, "42");
    expect(result).toEqual({ confirmedAssets: 1, remainingAssets: 0, job: { ...job, state: "completed", pendingBytes: 0 } });
  });

  it("does not confirm if the object generation changed", async () => {
    const f = arrange();
    f.deleteGeneration.mockResolvedValue("generation_mismatch");
    await expect(executePhotoPurge(IDS.userA, IDS.job, f.store, f.objects)).rejects.toMatchObject({ code: "generation_conflict" });
    expect(f.store.confirmAssetDeleted).not.toHaveBeenCalled();
  });

  it("does not confirm a failed provider delete, even if the error contains private details", async () => {
    const f = arrange();
    f.deleteGeneration.mockRejectedValue(new Error("private locator and credentials"));
    const error = await executePhotoPurge(IDS.userA, IDS.job, f.store, f.objects).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(PhotoPurgeExecutionError);
    expect(error).toMatchObject({ code: "delete_failed" });
    expect(f.store.confirmAssetDeleted).not.toHaveBeenCalled();
  });

  it("fails closed for invalid or owner-unbound work items", async () => {
    const f = arrange();
    await expect(executePhotoPurge("", IDS.job, f.store, f.objects)).rejects.toMatchObject({ code: "invalid_work_item" });
    await expect(executePhotoPurge(IDS.userA, "bad-job", f.store, f.objects)).rejects.toMatchObject({ code: "invalid_work_item" });
    expect(f.store.getJob).not.toHaveBeenCalled();
  });
});
