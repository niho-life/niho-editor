import { afterEach, describe, expect, it, vi } from "vitest";
import * as p02 from "@niho/editor-store";
import type { Database, PhotoAssetRecord, PhotoSnapshot } from "@niho/editor-store";
import { IDS, library, storedPhoto, thumbnail, preview } from "../../../../../packages/photo-library-contract/fixtures/v1";
import { createP02PhotoMutationJournal, createP02PhotoTransferStore, photoTransferSnapshot } from "./p02";

vi.mock("@niho/editor-store", async (original) => ({ ...await original<typeof import("@niho/editor-store")>() }));
const db = {} as Database;
const asset = (value = storedPhoto.original): PhotoAssetRecord => ({ ...value, photoId: IDS.photo, objectKey: "private/synthetic", objectGeneration: "7", deletionState: "retained", createdAt: storedPhoto.addedAt });
function snapshot(): PhotoSnapshot {
  return { library: { id: library.id, owner: IDS.userA, state: "active", revision: 8, lifecycleEpoch: 2, nextPhotoSequence: 5,
    usage: library.usage, createdAt: storedPhoto.addedAt, updatedAt: storedPhoto.addedAt },
  photo: { ...storedPhoto, original: asset(), creationSequence: 4, lifecycleEpoch: 2, recipeRevision: 5, versionsRevision: 6 },
  recipe: { ...storedPhoto.recipe, revision: 5, hasEdits: true }, hasEdits: true, media: null };
}
afterEach(() => vi.restoreAllMocks());

describe("P02 transfer adapters", () => {
  it("delegates journal binding to P02 on each adapter instance, preserving scope and conflicts", async () => {
    const bind = vi.spyOn(p02, "bindPhotoRequest").mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const input = { owner: IDS.userA, operation: "uploads.complete" as const, resourceId: IDS.upload, key: "synthetic_key_0001", requestHash: "a".repeat(64) };
    expect(await createP02PhotoMutationJournal(db).bind(input)).toBe(false);
    expect(await createP02PhotoMutationJournal(db).bind(input)).toBe(true);
    const { owner, ...payload } = input;
    expect(bind.mock.calls).toEqual([[db, owner, payload], [db, owner, payload]]);
    bind.mockRejectedValueOnce(new p02.PhotoStoreError("idempotency_conflict"));
    await expect(createP02PhotoMutationJournal(db).bind({ ...input, requestHash: "b".repeat(64) })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("uses only owner-bound snapshot, upload start key, mask and asset APIs", async () => {
    const photo = vi.spyOn(p02, "getPhotoSnapshot").mockResolvedValue(snapshot());
    const upload = vi.spyOn(p02, "getPhotoUploadByStartKey").mockResolvedValue(null);
    const mask = vi.spyOn(p02, "getPhotoMaskBySurfaceId").mockResolvedValue(null);
    const original = vi.spyOn(p02, "getPhotoAsset").mockResolvedValue(null);
    const store = createP02PhotoTransferStore(db);
    const result = await store.photo(IDS.userA, IDS.photo);
    expect(result).toMatchObject({ id: IDS.photo, recipe: { revision: 5 }, hasEdits: true });
    expect(JSON.stringify(result)).not.toMatch(/objectKey|objectGeneration|lifecycleEpoch|creationSequence/);
    await store.uploadByStartKey(IDS.userA, "mask", "synthetic_key_0001");
    await store.mask(IDS.userA, IDS.photo, "a".repeat(64)); await store.asset(IDS.userA, IDS.photo, IDS.original);
    expect(photo).toHaveBeenCalledWith(db, IDS.userA, IDS.photo);
    expect(upload).toHaveBeenCalledWith(db, IDS.userA, "mask", "synthetic_key_0001");
    expect(mask).toHaveBeenCalledWith(db, IDS.userA, IDS.photo, "a".repeat(64));
    expect(original).toHaveBeenCalledWith(db, IDS.userA, IDS.photo, IDS.original);
    photo.mockResolvedValueOnce(null); expect(await store.photo(IDS.userB, IDS.photo)).toBeNull();
  });
  it("projects current media without leaking stored locators", () => {
    const value = snapshot();
    expect(photoTransferSnapshot(value).media).toEqual({ state: "pending" });
    value.media = { id: IDS.job, state: "processing", recipeRevision: 5, rendererManifestSha256: "a".repeat(64), errorCode: null, ready: null, assets: [] };
    expect(photoTransferSnapshot(value).media).toEqual({ state: "processing", jobId: IDS.job });
    value.media.state = "failed"; value.media.errorCode = "decoder_failed";
    expect(photoTransferSnapshot(value).media).toEqual({ state: "failed", code: "decoder_failed" });
    value.media.state = "ready"; value.media.ready = { thumbnailId: thumbnail.id, previewId: preview.id, workingCopy: null, privateField: "hidden" };
    value.media.assets = [asset(thumbnail), asset(preview)];
    const result = photoTransferSnapshot(value);
    expect(result.media).toEqual({ state: "ready", thumbnail, preview, workingCopy: null, recipeRevision: 5, rendererManifestSha256: "a".repeat(64) });
    expect(JSON.stringify(result)).not.toMatch(/privateField|private\/synthetic|objectGeneration/);
    value.media.assets[0]!.photoId = "foreign-photo";
    expect(() => photoTransferSnapshot(value)).toThrow("temporarily_unavailable");
  });
  it("does not project a non-original or deleted asset as the stored original", () => {
    for (const invalidOriginal of [
      { ...asset(), kind: "thumbnail" as const },
      { ...asset(), deletionState: "deleted" as const },
    ]) {
      const value = { ...snapshot(), photo: { ...snapshot().photo, original: invalidOriginal } };
      expect(() => photoTransferSnapshot(value)).toThrow("temporarily_unavailable");
    }
  });
  it("requires a retained working copy and bounded metadata before projecting ready media", () => {
    const value = snapshot();
    value.media = { id: IDS.job, state: "ready", recipeRevision: 5, rendererManifestSha256: "a".repeat(64), errorCode: null,
      ready: { thumbnailId: thumbnail.id, previewId: preview.id, workingCopy: { assetId: IDS.mask, baseVersion: "base", encoding: "png16", meta: { v: 1 } } },
      assets: [asset(thumbnail), asset(preview), { ...asset(), id: IDS.mask, kind: "working-copy" }] };
    expect(photoTransferSnapshot(value).media).toMatchObject({ workingCopy: { asset: { id: IDS.mask }, meta: { v: 1 } } });
    value.media.ready = { ...value.media.ready, workingCopy: { assetId: IDS.mask, baseVersion: "base", encoding: "png16", meta: { large: "x".repeat(65536) } } };
    expect(() => photoTransferSnapshot(value)).toThrow("temporarily_unavailable");
  });
});
