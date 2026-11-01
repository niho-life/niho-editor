import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  PHOTO_MAX_MASK_EDGE,
  PHOTO_MAX_MASK_BYTES,
  PHOTO_MAX_ORIGINAL_BYTES,
  PHOTO_MAX_PIXELS,
  PHOTO_QUOTA_BYTES,
  PHOTO_RESERVATION_SECONDS,
  PHOTO_TRASH_RETENTION_DAYS,
  PHOTO_VERIFICATION_LEASE_MAX_SECONDS,
  completePhotoUpload,
  getPhoto,
  getPhotoAsset,
  getPhotoPurgeJob,
  getPhotoUpload,
  reservePhotoUpload,
} from "../src/photo-store.ts";
import type { Database } from "../src/types.ts";
import { PHOTO_LIMITS } from "../../photo-library-contract/src/v1.ts";

const SHA = "a".repeat(64);
const HASH = "b".repeat(64);

const untouchable: Database = {
  query: (() => {
    throw new Error("must not query");
  }) as unknown as Database["query"],
  connect: (() => {
    throw new Error("must not connect");
  }) as unknown as Database["connect"],
};

describe("photo store validation without a database", () => {
  it("keeps duplicated store limits equal to the wire contract", () => {
    assert.deepEqual({
      quotaBytes: PHOTO_QUOTA_BYTES,
      maxFileBytes: PHOTO_MAX_ORIGINAL_BYTES,
      maxPixels: PHOTO_MAX_PIXELS,
      maxMaskBytes: PHOTO_MAX_MASK_BYTES,
      maxMaskEdge: PHOTO_MAX_MASK_EDGE,
      trashRetentionDays: PHOTO_TRASH_RETENTION_DAYS,
      reservationLifetimeSeconds: PHOTO_RESERVATION_SECONDS,
      uploadTicketMaxSeconds: PHOTO_VERIFICATION_LEASE_MAX_SECONDS,
    }, {
      quotaBytes: PHOTO_LIMITS.quotaBytes,
      maxFileBytes: PHOTO_LIMITS.maxFileBytes,
      maxPixels: PHOTO_LIMITS.maxPixels,
      maxMaskBytes: PHOTO_LIMITS.maxMaskBytes,
      maxMaskEdge: PHOTO_LIMITS.maxMaskEdge,
      trashRetentionDays: PHOTO_LIMITS.trashRetentionDays,
      reservationLifetimeSeconds: PHOTO_LIMITS.reservationLifetimeSeconds,
      uploadTicketMaxSeconds: PHOTO_LIMITS.uploadTicketMaxSeconds,
    });
  });

  it("treats malformed resource IDs like missing rows without touching PostgreSQL", async () => {
    for (const id of ["", "not-a-uuid", `${randomUUID()}' OR '1'='1`]) {
      assert.equal(await getPhoto(untouchable, "synthetic-owner", id), null);
      assert.equal(await getPhotoAsset(untouchable, "synthetic-owner", id, randomUUID()), null);
      assert.equal(await getPhotoAsset(untouchable, "synthetic-owner", randomUUID(), id), null);
      assert.equal(await getPhotoUpload(untouchable, "synthetic-owner", id), null);
      assert.equal(await getPhotoPurgeJob(untouchable, "synthetic-owner", id), null);
      assert.equal(await completePhotoUpload(untouchable, "synthetic-owner", id, {
        leaseGeneration: 1,
        sha256: SHA,
        sizeBytes: 1,
        objectKey: "photo/synthetic",
        objectGeneration: "1",
        contentType: "image/jpeg",
        width: 1,
        height: 1,
      }), null);
    }
  });

  it("rejects client-shaped owner, idempotency, digest and object values before connecting", async () => {
    await assert.rejects(() => reservePhotoUpload(untouchable, "", {
      operation: "original", sizeBytes: 1, sha256: SHA, contentType: "image/jpeg", fileName: "a.jpg", format: "jpeg",
      idempotencyKey: randomUUID(), requestHash: HASH,
    }), TypeError);
    await assert.rejects(() => reservePhotoUpload(untouchable, "synthetic-owner", {
      operation: "original", sizeBytes: 1, sha256: "A".repeat(64), contentType: "image/jpeg", fileName: "a.jpg", format: "jpeg",
      idempotencyKey: "short", requestHash: HASH,
    }), TypeError);
    await assert.rejects(() => reservePhotoUpload(untouchable, "synthetic-owner", {
      operation: "mask", targetPhotoId: randomUUID(), sizeBytes: PHOTO_MAX_MASK_BYTES + 1, sha256: SHA, contentType: "image/png",
      idempotencyKey: randomUUID(), requestHash: HASH,
    }), TypeError);
    await assert.rejects(() => reservePhotoUpload(untouchable, "synthetic-owner", {
      operation: "mask", targetPhotoId: randomUUID(), sizeBytes: 1, sha256: SHA, contentType: "image/jpeg",
      idempotencyKey: randomUUID(), requestHash: HASH,
    }), TypeError);
    await assert.rejects(() => reservePhotoUpload(untouchable, "synthetic-owner", {
      operation: "original", sizeBytes: PHOTO_MAX_ORIGINAL_BYTES + 1, sha256: SHA, contentType: "image/jpeg", fileName: "a.jpg", format: "jpeg",
      idempotencyKey: randomUUID(), requestHash: HASH,
    }), TypeError);
    await assert.rejects(() => reservePhotoUpload(untouchable, "synthetic-owner", {
      operation: "original", sizeBytes: 1, sha256: SHA, contentType: "image/jpeg", fileName: "../a.jpg", format: "jpeg",
      idempotencyKey: randomUUID(), requestHash: HASH,
    }), TypeError);
    await assert.rejects(() => completePhotoUpload(untouchable, "synthetic-owner", randomUUID(), {
      leaseGeneration: 1,
      sha256: SHA,
      sizeBytes: 1,
      objectKey: "https://example.invalid/object",
      objectGeneration: "1",
      contentType: "image/jpeg",
      width: 1,
      height: 1,
    }), TypeError);
  });
});
