// @vitest-environment node
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPhotoMediaApi, PhotoMediaError, photoMediaEnsureRequestHash } from "./api";
import type { PhotoMediaStore } from "./types";

const OWNER = "synthetic-owner";
const PHOTO_ID = randomUUID();
const KEY = "synthetic_media_key_1234";

function store(media: { state: "pending" | "queued" } = { state: "pending" }) {
  const ensure = vi.fn<PhotoMediaStore["ensure"]>(async (owner, photoId) => ({
    snapshot: {
      ownerId: owner,
      photoId,
      media: media.state === "queued" ? { state: "queued", jobId: randomUUID() } : { state: "pending" },
    },
    replayed: false,
  }));
  return { ensure } satisfies PhotoMediaStore;
}

describe("photo media API", () => {
  it("returns accepted and replayed current media without accepting renderer metadata", async () => {
    const acceptedStore = store({ state: "queued" });
    const accepted = await createPhotoMediaApi({ store: acceptedStore }).ensure(OWNER, PHOTO_ID.toUpperCase(), { recipeRevision: 7 }, KEY);
    expect(accepted).toMatchObject({ value: { state: "queued" }, replayed: false });
    expect(acceptedStore.ensure).toHaveBeenCalledWith(OWNER, PHOTO_ID, {
      recipeRevision: 7,
      key: KEY,
      requestHash: photoMediaEnsureRequestHash(7),
    });

    acceptedStore.ensure.mockResolvedValueOnce({
      snapshot: { ownerId: OWNER, photoId: PHOTO_ID, media: { state: "failed", code: "decoder_failed" } },
      replayed: true,
    });
    await expect(createPhotoMediaApi({ store: acceptedStore }).ensure(OWNER, PHOTO_ID, { recipeRevision: 7 }, KEY))
      .resolves.toEqual({ value: { state: "failed", code: "decoder_failed" }, replayed: true });
  });

  it("derives a closed body hash and rejects malformed identity, key and body before the store", async () => {
    expect(photoMediaEnsureRequestHash(1)).not.toBe(photoMediaEnsureRequestHash(2));
    expect(photoMediaEnsureRequestHash(1)).toMatch(/^[0-9a-f]{64}$/);
    const mediaStore = store();
    const api = createPhotoMediaApi({ store: mediaStore });
    for (const input of [
      ["not-a-uuid", { recipeRevision: 0 }, KEY, "not_found"],
      [PHOTO_ID, { recipeRevision: 0 }, "short", "invalid_request"],
      [PHOTO_ID, {}, KEY, "invalid_request"],
      [PHOTO_ID, { recipeRevision: -1 }, KEY, "invalid_request"],
      [PHOTO_ID, { recipeRevision: 1, renderer: "client" }, KEY, "invalid_request"],
    ] as const) {
      await expect(api.ensure(OWNER, input[0], input[1], input[2])).rejects.toMatchObject({ code: input[3] });
    }
    expect(mediaStore.ensure).not.toHaveBeenCalled();
  });

  it("collapses missing and foreign results to not_found", async () => {
    const missing: PhotoMediaStore = { ensure: vi.fn(async () => null) };
    await expect(createPhotoMediaApi({ store: missing }).ensure(OWNER, PHOTO_ID, { recipeRevision: 0 }, KEY))
      .rejects.toMatchObject({ code: "not_found" });
    const foreign: PhotoMediaStore = { ensure: vi.fn(async () => ({
      snapshot: { ownerId: "foreign", photoId: PHOTO_ID, media: { state: "pending" } }, replayed: false,
    })) };
    await expect(createPhotoMediaApi({ store: foreign }).ensure(OWNER, PHOTO_ID, { recipeRevision: 0 }, KEY))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("preserves typed revision conflicts", async () => {
    const mediaStore: PhotoMediaStore = { ensure: vi.fn(async () => { throw new PhotoMediaError("revision_conflict", 9); }) };
    await expect(createPhotoMediaApi({ store: mediaStore }).ensure(OWNER, PHOTO_ID, { recipeRevision: 8 }, KEY))
      .rejects.toMatchObject({ code: "revision_conflict", currentRevision: 9 });
  });
});
