import { describe, expect, it, vi } from "vitest";
import { IDS, readyPhoto, trashedPhoto } from "../../../../../packages/photo-library-contract/fixtures/v1";
import { createPhotoLifecycleApi, PhotoLifecycleError } from "./api";
import type { PhotoLifecycleStore } from "./types";

const KEY = "synthetic_lifecycle_key_01";
const purgeJob = { id: IDS.job, state: "queued" as const, pendingBytes: readyPhoto.original.sizeBytes };

function arrange() {
  const store: PhotoLifecycleStore = {
    trash: vi.fn(async () => ({ photo: trashedPhoto, replayed: false })),
    restore: vi.fn(async () => ({ photo: readyPhoto, replayed: false })),
    purge: vi.fn(async () => ({ job: purgeJob, replayed: false })),
    photo: vi.fn(async () => readyPhoto),
    job: vi.fn(async () => purgeJob),
  };
  return { api: createPhotoLifecycleApi({ store }), store };
}

describe("photo lifecycle API", () => {
  it("uses P02 mutation idempotency and returns the authoritative trash snapshot", async () => {
    const f = arrange();
    const result = await f.api.trash(IDS.userA, IDS.photo, KEY);
    expect(result.value.lifecycle).toBe("trashed");
    expect(f.store.trash).toHaveBeenCalledWith(IDS.userA, IDS.photo, {
      idempotencyKey: KEY,
      requestHash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    });
  });

  it("returns only a purge receipt; it does not claim objects were deleted", async () => {
    const f = arrange();
    expect(await f.api.purge(IDS.userA, IDS.photo, KEY)).toEqual({ value: purgeJob, replayed: false });
    expect(f.store.purge).toHaveBeenCalledOnce();
  });

  it("keeps restore and purge owner-scoped and returns the job by the authenticated owner", async () => {
    const f = arrange();
    expect((await f.api.restore(IDS.userA, IDS.photo, KEY)).value.lifecycle).toBe("active");
    expect(await f.api.job(IDS.userA, IDS.job)).toEqual(purgeJob);
    expect(f.store.restore).toHaveBeenCalledWith(IDS.userA, IDS.photo, expect.any(Object));
    expect(f.store.job).toHaveBeenCalledWith(IDS.userA, IDS.job);
  });

  it("returns conflicts for wrong lifecycle and missing photos without a second mutation", async () => {
    const f = arrange();
    vi.mocked(f.store.trash).mockResolvedValue(null);
    vi.mocked(f.store.photo).mockResolvedValue(trashedPhoto);
    await expect(f.api.trash(IDS.userA, IDS.photo, KEY)).rejects.toMatchObject({ code: "photo_trashed" });
    expect(f.store.photo).toHaveBeenCalledWith(IDS.userA, IDS.photo);

    vi.mocked(f.store.purge).mockResolvedValue(null);
    vi.mocked(f.store.photo).mockResolvedValue(null);
    await expect(f.api.purge(IDS.userA, IDS.photo, KEY)).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects malformed keys and ids before the P02 writer", async () => {
    const f = arrange();
    await expect(f.api.restore(IDS.userA, "bad", KEY)).rejects.toBeInstanceOf(PhotoLifecycleError);
    await expect(f.api.trash(IDS.userA, IDS.photo, "short")).rejects.toMatchObject({ code: "invalid_request" });
    expect(f.store.trash).not.toHaveBeenCalled();
    expect(f.store.restore).not.toHaveBeenCalled();
  });
});
