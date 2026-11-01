import { describe, expect, it, vi } from "vitest";
import { confirmPhotoAssetDeleted, getPhotoPurgeJob, listPhotoPurgeAssets, type Database } from "@niho/editor-store";
import { IDS } from "../../../../../packages/photo-library-contract/fixtures/v1";
import { createP02PhotoPurgeStore } from "./purge-worker-adapter";

vi.mock("@niho/editor-store", async (importOriginal) => ({
  ...await importOriginal(),
  confirmPhotoAssetDeleted: vi.fn(),
  getPhotoPurgeJob: vi.fn(),
  listPhotoPurgeAssets: vi.fn(),
}));

const db = {} as Database;
const job = { id: IDS.job, photoId: IDS.photo, state: "running" as const, pendingBytes: 42, lifecycleEpoch: 2, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" };
const asset = {
  id: IDS.original, photoId: IDS.photo, kind: "original" as const, sha256: "a".repeat(64), sizeBytes: 42,
  contentType: "image/jpeg", width: 2, height: 2, objectKey: "private/synthetic-object", objectGeneration: "generation-7",
  deletionState: "pending" as const, createdAt: "2026-11-01T00:00:00.000Z",
};

describe("P02 photo purge worker adapter", () => {
  it("maps owner-scoped jobs and exposes only exact-generation deletion inputs", async () => {
    vi.mocked(getPhotoPurgeJob).mockResolvedValue(job);
    vi.mocked(listPhotoPurgeAssets).mockResolvedValue([asset]);
    vi.mocked(confirmPhotoAssetDeleted).mockResolvedValue({ ...job, pendingBytes: 0 });
    const store = createP02PhotoPurgeStore(db);

    expect(await store.getJob(IDS.userA, IDS.job)).toEqual({ id: IDS.job, state: "running", pendingBytes: 42 });
    expect(getPhotoPurgeJob).toHaveBeenCalledWith(db, IDS.userA, IDS.job);
    expect(await store.listPendingAssets(IDS.userA, IDS.job)).toEqual([{
      id: IDS.original, objectKey: asset.objectKey, objectGeneration: asset.objectGeneration,
    }]);
    expect(listPhotoPurgeAssets).toHaveBeenCalledWith(db, IDS.userA, IDS.job);
    expect(await store.confirmAssetDeleted(IDS.userA, IDS.job, IDS.original, asset.objectGeneration)).toEqual({
      id: IDS.job, state: "running", pendingBytes: 0,
    });
    expect(confirmPhotoAssetDeleted).toHaveBeenCalledWith(db, IDS.userA, IDS.job, IDS.original, asset.objectGeneration);
  });

  it("preserves absent owner-bound records as null", async () => {
    vi.mocked(getPhotoPurgeJob).mockResolvedValue(null);
    vi.mocked(listPhotoPurgeAssets).mockResolvedValue(null);
    vi.mocked(confirmPhotoAssetDeleted).mockResolvedValue(null);
    const store = createP02PhotoPurgeStore(db);
    expect(await store.getJob(IDS.userB, IDS.job)).toBeNull();
    expect(await store.listPendingAssets(IDS.userB, IDS.job)).toBeNull();
    expect(await store.confirmAssetDeleted(IDS.userB, IDS.job, IDS.original, asset.objectGeneration)).toBeNull();
  });
});
