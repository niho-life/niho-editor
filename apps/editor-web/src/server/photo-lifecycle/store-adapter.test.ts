import { beforeEach, describe, expect, it, vi } from "vitest";
import { HASH, IDS, readyPhoto } from "../../../../../packages/photo-library-contract/fixtures/v1";

const p02 = vi.hoisted(() => ({
  beginPhotoPurge: vi.fn(),
  getPhotoPurgeJob: vi.fn(),
  getPhotoSnapshot: vi.fn(),
  restorePhoto: vi.fn(),
  trashPhoto: vi.fn(),
}));

vi.mock("@niho/editor-store", async () => {
  const actual = await vi.importActual<typeof import("@niho/editor-store")>("@niho/editor-store");
  return { ...actual, ...p02 };
});

import { PhotoStoreError, type Database, type PhotoSnapshot } from "@niho/editor-store";
import { createPhotoLifecycleStore } from "./store-adapter";

const object = {
  ...readyPhoto.original,
  photoId: IDS.photo,
  objectKey: "synthetic-private-object",
  objectGeneration: "42",
  deletionState: "retained" as const,
  createdAt: "2026-11-01T12:00:00.000Z",
};
const snapshot = {
  library: { id: IDS.library, owner: IDS.userA, state: "active", revision: 1, lifecycleEpoch: 1, nextPhotoSequence: 2,
    usage: { quotaBytes: 1000, usedBytes: 100, originalBytes: 100, maskBytes: 0, trashBytes: 0, pendingPurgeBytes: 0, reservedBytes: 0, availableBytes: 900 },
    createdAt: "2026-11-01T12:00:00.000Z", updatedAt: "2026-11-01T12:00:00.000Z" },
  photo: { ...readyPhoto, creationSequence: 1, lifecycleEpoch: 1, recipeRevision: 0, versionsRevision: 0, original: object },
  recipe: { ...readyPhoto.recipe, hasEdits: false },
  media: null,
  hasEdits: false,
} as unknown as PhotoSnapshot;
const db = {} as Database;

beforeEach(() => {
  vi.clearAllMocks();
  p02.getPhotoSnapshot.mockResolvedValue(snapshot);
  p02.trashPhoto.mockResolvedValue({ photo: snapshot.photo, replayed: false });
  p02.restorePhoto.mockResolvedValue({ photo: snapshot.photo, replayed: false });
  p02.beginPhotoPurge.mockResolvedValue({ replayed: false, job: {
    id: IDS.job, photoId: IDS.photo, state: "queued", pendingBytes: 100, lifecycleEpoch: 2,
    createdAt: "2026-11-01T12:00:00.000Z", updatedAt: "2026-11-01T12:00:00.000Z",
  } });
  p02.getPhotoPurgeJob.mockResolvedValue({
    id: IDS.job, photoId: IDS.photo, state: "completed", pendingBytes: 0, lifecycleEpoch: 2,
    createdAt: "2026-11-01T12:00:00.000Z", updatedAt: "2026-11-01T12:00:00.000Z",
  });
});

describe("photo lifecycle P02 adapter", () => {
  it("passes authenticated owner and idempotency input to P02 and returns only the safe Photo projection", async () => {
    const store = createPhotoLifecycleStore(db);
    const result = await store.trash(IDS.userA, IDS.photo, { idempotencyKey: "synthetic_lifecycle_key_01", requestHash: HASH.settings });
    expect(p02.trashPhoto).toHaveBeenCalledWith(db, IDS.userA, IDS.photo, expect.objectContaining({ idempotencyKey: "synthetic_lifecycle_key_01" }));
    expect(result?.photo.original).not.toHaveProperty("objectKey");
    expect(result?.photo.media).toEqual({ state: "pending" });
    expect(JSON.stringify(result)).not.toMatch(/objectGeneration|synthetic-private-object/);
  });

  it("maps P02 errors to closed photo error codes", async () => {
    p02.trashPhoto.mockRejectedValue(new PhotoStoreError("account_deleting"));
    const store = createPhotoLifecycleStore(db);
    await expect(store.trash(IDS.userA, IDS.photo, { idempotencyKey: "synthetic_lifecycle_key_01", requestHash: HASH.settings }))
      .rejects.toMatchObject({ code: "account_deleting" });
  });

  it("strips private purge ledger fields from public job responses", async () => {
    const store = createPhotoLifecycleStore(db);
    expect(await store.purge(IDS.userA, IDS.photo, { idempotencyKey: "synthetic_lifecycle_key_01", requestHash: HASH.settings }))
      .toEqual({ replayed: false, job: { id: IDS.job, state: "queued", pendingBytes: 100 } });
    expect(await store.job(IDS.userA, IDS.job)).toEqual({ id: IDS.job, state: "completed", pendingBytes: 0 });
  });
});
