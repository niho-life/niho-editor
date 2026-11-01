import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import {
  PHOTO_QUOTA_BYTES,
  PhotoStoreError,
  beginPhotoPurge,
  cancelPhotoUpload,
  claimPhotoUploadVerification,
  completePhotoUpload,
  confirmPhotoAssetDeleted,
  confirmPhotoOrphanDeleted,
  expirePhotoUploads,
  getPhoto,
  getPhotoAsset,
  getPhotoLibrary,
  getPhotoPurgeJob,
  getPhotoUsage,
  getPhotoUpload,
  listPhotoOrphans,
  listPhotoPurgeAssets,
  lookupPhotoByOriginal,
  markPhotoLibraryDeleting,
  recordPhotoOrphan,
  rejectPhotoUpload,
  reservePhotoUpload,
  restorePhoto,
  trashPhoto,
  type PhotoUploadRecord,
  type VerifiedPhotoObject,
} from "../src/photo-store.ts";
import { applyMigrations, defaultMigrationsDir } from "../src/migrate.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

async function withSchema(label: string): Promise<{ pool: PgPool; drop: () => Promise<void> }> {
  const { Pool } = await import("pg");
  const schema = `photo_store_${label}_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const client = await pool.connect();
  try {
    await applyMigrations(client, defaultMigrationsDir);
  } finally {
    client.release();
  }
  return {
    pool,
    drop: async () => {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    },
  };
}

function originalInput(sha256 = SHA_A, sizeBytes = 100) {
  return {
    operation: "original" as const,
    sizeBytes,
    sha256,
    contentType: "image/jpeg",
    fileName: "synthetic.jpg",
    format: "jpeg" as const,
    idempotencyKey: randomUUID(),
    requestHash: SHA_C,
  };
}

function verified(upload: PhotoUploadRecord, suffix: string, extra: Partial<VerifiedPhotoObject> = {}): VerifiedPhotoObject {
  return {
    leaseGeneration: upload.leaseGeneration,
    sha256: upload.sha256,
    sizeBytes: upload.sizeBytes,
    objectKey: `photo/synthetic/${suffix}`,
    objectGeneration: "1",
    contentType: upload.contentType,
    width: 10,
    height: 10,
    ...(upload.format === null ? {} : { format: upload.format }),
    ...extra,
  };
}

async function createOriginal(pool: PgPool, owner: string, sha256 = SHA_A, sizeBytes = 100, suffix: string = randomUUID()) {
  const reserved = await reservePhotoUpload(pool, owner, originalInput(sha256, sizeBytes));
  assert.equal(reserved?.status, "created");
  const claimed = await claimPhotoUploadVerification(pool, owner, reserved.upload.id);
  assert.ok(claimed);
  const object = verified(claimed, suffix);
  const completed = await completePhotoUpload(pool, owner, claimed.id, object);
  assert.ok(completed);
  return { upload: claimed, object, completed };
}

async function rejectsCode(run: () => Promise<unknown>, code: PhotoStoreError["code"]): Promise<void> {
  await assert.rejects(run, (error: unknown) => error instanceof PhotoStoreError && error.code === code);
}

describe("personal photo store on PostgreSQL", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;

  before(async () => {
    ({ pool, drop } = await withSchema("integration"));
  });

  after(async () => {
    await drop();
  });

  it("creates one owner library and serializes two reservations at the quota boundary", async () => {
    const owner = `synthetic-quota-${randomUUID()}`;
    const first = await getPhotoLibrary(pool, owner);
    const second = await getPhotoLibrary(pool, owner);
    assert.equal(first.id, second.id);
    assert.equal(first.usage.quotaBytes, PHOTO_QUOTA_BYTES);

    await pool.query(
      `UPDATE photo_libraries SET used_bytes = $2, original_bytes = $2 WHERE owner = $1`,
      [owner, PHOTO_QUOTA_BYTES - 100],
    );
    const [a, b] = await Promise.allSettled([
      reservePhotoUpload(pool, owner, originalInput(SHA_A, 80)),
      reservePhotoUpload(pool, owner, originalInput(SHA_B, 80)),
    ]);
    const fulfilled = [a, b].filter((item) => item.status === "fulfilled");
    const rejected = [a, b].filter((item) => item.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]?.status === "rejected" && rejected[0].reason instanceof PhotoStoreError && rejected[0].reason.code === "quota_exceeded");
    const usage = await getPhotoUsage(pool, owner);
    assert.equal(usage.usedBytes, PHOTO_QUOTA_BYTES - 100);
    assert.equal(usage.reservedBytes, 80);
    assert.equal(usage.availableBytes, 20);
  });

  it("scopes ids, digests and joins by owner and keeps malformed IDs indistinguishable from missing rows", async () => {
    const owner = `synthetic-owner-a-${randomUUID()}`;
    const other = `synthetic-owner-b-${randomUUID()}`;
    const made = await createOriginal(pool, owner);
    const photo = await getPhoto(pool, owner, made.completed.photoId);
    assert.ok(photo);
    assert.equal(await getPhoto(pool, other, made.completed.photoId), null);
    assert.equal(await getPhoto(pool, owner, "not-a-uuid"), null);
    assert.equal(await getPhotoAsset(pool, other, made.completed.photoId, made.completed.assetId), null);
    assert.equal(await getPhotoAsset(pool, owner, randomUUID(), made.completed.assetId), null);
    assert.equal((await lookupPhotoByOriginal(pool, owner, SHA_A, 100))?.id, made.completed.photoId);
    assert.equal(await lookupPhotoByOriginal(pool, other, SHA_A, 100), null);
    await assert.rejects(
      pool.query("UPDATE photo_assets SET object_key = $3 WHERE owner = $1 AND id = $2", [owner, made.completed.assetId, "photo/changed"]),
      (error: unknown) => (error as { code?: string }).code === "23514",
    );
    await assert.rejects(
      pool.query("UPDATE photos SET original_asset_id = gen_random_uuid() WHERE owner = $1 AND id = $2", [owner, made.completed.photoId]),
      (error: unknown) => (error as { code?: string }).code === "23514",
    );

    const otherLibrary = await getPhotoLibrary(pool, other);
    await assert.rejects(
      pool.query(
        `INSERT INTO photo_assets
           (owner, library_id, photo_id, kind, sha256, size_bytes, content_type, width, height,
            object_key, object_generation, counts_toward_quota)
         VALUES ($1, $2, $3, 'mask', $4, 1, 'image/png', 1, 1, $5, '1', true)`,
        [other, otherLibrary.id, made.completed.photoId, SHA_B, `photo/cross-owner/${randomUUID()}`],
      ),
      (error: unknown) => (error as { code?: string }).code === "23503",
    );
  });

  it("makes completion idempotent, deduplicates owner-local originals and records the surplus immutable copy", async () => {
    const owner = `synthetic-dedup-${randomUUID()}`;
    const firstReservation = await reservePhotoUpload(pool, owner, originalInput(SHA_A, 100));
    const secondReservation = await reservePhotoUpload(pool, owner, originalInput(SHA_A, 100));
    assert.equal(firstReservation?.status, "created");
    assert.equal(secondReservation?.status, "created");
    const first = await claimPhotoUploadVerification(pool, owner, firstReservation.upload.id);
    const second = await claimPhotoUploadVerification(pool, owner, secondReservation.upload.id);
    assert.ok(first && second);
    const firstObject = verified(first, "dedup-first");
    const secondObject = verified(second, "dedup-second");
    const stored = await completePhotoUpload(pool, owner, first.id, firstObject);
    const duplicate = await completePhotoUpload(pool, owner, second.id, secondObject);
    assert.ok(stored && duplicate);
    assert.equal(duplicate.photoId, stored.photoId);
    assert.equal(duplicate.assetId, stored.assetId);
    assert.equal(duplicate.deduplicated, true);
    assert.deepEqual(await completePhotoUpload(pool, owner, second.id, secondObject), { ...duplicate, replayed: true });
    const usage = await getPhotoUsage(pool, owner);
    assert.equal(usage.usedBytes, 100);
    assert.equal(usage.reservedBytes, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM photos WHERE owner = $1", [owner])).rows[0].n, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM photo_gc_objects WHERE owner = $1 AND reason = 'duplicate_copy'", [owner])).rows[0].n, 1);

    const idempotencyKey = randomUUID();
    const replay = await reservePhotoUpload(pool, owner, { ...originalInput(SHA_B, 5), idempotencyKey, requestHash: SHA_A });
    assert.equal(replay?.status, "created");
    const same = await reservePhotoUpload(pool, owner, { ...originalInput(SHA_B, 5), idempotencyKey, requestHash: SHA_A });
    assert.equal(same?.status, "replayed");
    assert.equal(same.upload.id, replay.upload.id);
    await rejectsCode(
      () => reservePhotoUpload(pool, owner, { ...originalInput(SHA_B, 5), idempotencyKey, requestHash: SHA_B }),
      "idempotency_conflict",
    );
  });

  it("persists deduplicated starts and fences their keys after original or mask deletion", async () => {
    const owner = `synthetic-dedup-start-${randomUUID()}`;
    const made = await createOriginal(pool, owner, SHA_A, 100);
    const input = originalInput(SHA_A, 100);
    const first = await reservePhotoUpload(pool, owner, input);
    assert.deepEqual(first, { status: "existing", photoId: made.completed.photoId, assetId: made.completed.assetId });
    assert.deepEqual(await reservePhotoUpload(pool, owner, input), first);
    await rejectsCode(() => reservePhotoUpload(pool, owner, { ...input, sha256: SHA_B, requestHash: SHA_B }), "idempotency_conflict");
    const maskInput = { operation: "mask" as const, targetPhotoId: made.completed.photoId,
      sizeBytes: 20, sha256: SHA_B, contentType: "image/png", idempotencyKey: randomUUID(), requestHash: SHA_A };
    const reservation = await reservePhotoUpload(pool, owner, maskInput);
    assert.equal(reservation?.status, "created");
    const claimed = await claimPhotoUploadVerification(pool, owner, reservation.upload.id);
    assert.ok(claimed);
    const maskObject = verified(claimed, "dedup-start-mask");
    const mask = await completePhotoUpload(pool, owner, claimed.id, maskObject);
    assert.ok(mask);
    const duplicateMask = { ...maskInput, idempotencyKey: randomUUID() };
    const existingMask = { status: "existing", photoId: mask.photoId, assetId: mask.assetId };
    assert.deepEqual(await reservePhotoUpload(pool, owner, duplicateMask), existingMask);
    assert.deepEqual(await reservePhotoUpload(pool, owner, duplicateMask), existingMask);
    await rejectsCode(() => reservePhotoUpload(pool, owner, { ...duplicateMask, sizeBytes: 21, requestHash: SHA_B }), "idempotency_conflict");
    const usage = await getPhotoUsage(pool, owner);
    assert.equal(usage.usedBytes, 120);
    assert.equal(usage.reservedBytes, 0);
    const records = await pool.query("SELECT state, reserved_bytes, completed_lease_generation FROM photo_uploads WHERE owner = $1 AND idempotency_key = ANY($2)",
      [owner, [input.idempotencyKey, duplicateMask.idempotencyKey]]);
    assert.equal(records.rowCount, 2);
    assert.ok(records.rows.every(row => row.state === "stored" && Number(row.reserved_bytes) === 0 && Number(row.completed_lease_generation) === 0));
    await trashPhoto(pool, owner, made.completed.photoId, { idempotencyKey: randomUUID(), requestHash: SHA_A });
    await rejectsCode(() => reservePhotoUpload(pool, owner, input), "photo_trashed");
    await rejectsCode(() => reservePhotoUpload(pool, owner, duplicateMask), "photo_trashed");
    const purge = await beginPhotoPurge(pool, owner, made.completed.photoId, { idempotencyKey: randomUUID(), requestHash: SHA_B });
    assert.ok(purge);
    await confirmPhotoAssetDeleted(pool, owner, purge.job.id, made.completed.assetId, made.object.objectGeneration);
    await confirmPhotoAssetDeleted(pool, owner, purge.job.id, mask.assetId, maskObject.objectGeneration);
    assert.equal(await reservePhotoUpload(pool, owner, input), null);
    assert.equal(await reservePhotoUpload(pool, owner, duplicateMask), null);
    assert.equal((await getPhotoUsage(pool, owner)).reservedBytes, 0);
  });

  it("never queues a live generation and converges an exact duplicate without GC", async () => {
    const owner = `synthetic-live-locator-${randomUUID()}`;
    // 二つの予約を確定前に作り、同時uploadの後着completeを再現する。
    const reservation = await reservePhotoUpload(pool, owner, originalInput(SHA_A, 100));
    assert.equal(reservation?.status, "created");
    const made = await createOriginal(pool, owner, SHA_A, 100, "live-generation");

    assert.equal(await recordPhotoOrphan(pool, owner, {
      uploadId: made.upload.id,
      objectKey: made.object.objectKey,
      objectGeneration: made.object.objectGeneration,
      reason: "copy_db_failure",
    }), null);
    assert.deepEqual(await listPhotoOrphans(pool, owner), []);
    assert.equal((await getPhotoAsset(pool, owner, made.completed.photoId, made.completed.assetId))?.objectKey, made.object.objectKey);

    const claim = await claimPhotoUploadVerification(pool, owner, reservation.upload.id);
    assert.ok(claim);
    const duplicate = await completePhotoUpload(pool, owner, claim.id, {
      ...made.object,
      leaseGeneration: claim.leaseGeneration,
    });
    assert.ok(duplicate);
    assert.equal(duplicate.photoId, made.completed.photoId);
    assert.equal(duplicate.assetId, made.completed.assetId);
    assert.equal(duplicate.deduplicated, true);
    assert.equal((await pool.query(
      "SELECT count(*)::int AS n FROM photo_gc_objects WHERE object_key = $1 AND object_generation = $2",
      [made.object.objectKey, made.object.objectGeneration],
    )).rows[0].n, 0);

    const other = `synthetic-live-locator-other-${randomUUID()}`;
    const otherReservation = await reservePhotoUpload(pool, other, originalInput(SHA_B, 100));
    assert.equal(otherReservation?.status, "created");
    const otherClaim = await claimPhotoUploadVerification(pool, other, otherReservation.upload.id);
    assert.ok(otherClaim);
    await rejectsCode(() => completePhotoUpload(pool, other, otherClaim.id, {
      ...verified(otherClaim, "unused"),
      objectKey: made.object.objectKey,
      objectGeneration: made.object.objectGeneration,
    }), "upload_state_conflict");
    assert.equal((await getPhotoUsage(pool, other)).reservedBytes, 100);
  });

  it("retires a queued orphan generation before completion without changing its reservation", async () => {
    const owner = `synthetic-retired-locator-${randomUUID()}`;
    const reservation = await reservePhotoUpload(pool, owner, originalInput(SHA_A, 77));
    assert.equal(reservation?.status, "created");
    const claim = await claimPhotoUploadVerification(pool, owner, reservation.upload.id);
    assert.ok(claim);
    const object = verified(claim, "retired-before-complete");
    assert.ok(await recordPhotoOrphan(pool, owner, {
      uploadId: claim.id,
      objectKey: object.objectKey,
      objectGeneration: object.objectGeneration,
      reason: "copy_db_failure",
    }));

    await rejectsCode(() => completePhotoUpload(pool, owner, claim.id, object), "upload_state_conflict");
    const current = await getPhotoUpload(pool, owner, claim.id);
    assert.equal(current?.state, "verifying");
    assert.equal(current?.reservedBytes, 77);
    assert.equal((await getPhotoUsage(pool, owner)).reservedBytes, 77);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM photos WHERE owner = $1", [owner])).rows[0].n, 0);
  });

  it("fences cancel, expiry and reclaimed verification workers", async () => {
    const owner = `synthetic-fence-${randomUUID()}`;

    const cancelledReservation = await reservePhotoUpload(pool, owner, originalInput(SHA_A, 10));
    assert.ok(cancelledReservation && cancelledReservation.status !== "existing");
    const cancelledClaim = await claimPhotoUploadVerification(pool, owner, cancelledReservation.upload.id);
    assert.ok(cancelledClaim);
    await cancelPhotoUpload(pool, owner, cancelledClaim.id);
    await rejectsCode(() => completePhotoUpload(pool, owner, cancelledClaim.id, verified(cancelledClaim, "cancelled")), "upload_state_conflict");

    const expiredReservation = await reservePhotoUpload(pool, owner, originalInput(SHA_B, 11));
    assert.ok(expiredReservation && expiredReservation.status !== "existing");
    const expiredClaim = await claimPhotoUploadVerification(pool, owner, expiredReservation.upload.id);
    assert.ok(expiredClaim);
    await pool.query("UPDATE photo_uploads SET expires_at = clock_timestamp() - interval '1 second' WHERE owner = $1 AND id = $2", [owner, expiredClaim.id]);
    assert.equal(await expirePhotoUploads(pool, owner), 1);
    await rejectsCode(() => claimPhotoUploadVerification(pool, owner, expiredClaim.id), "upload_expired");
    assert.equal((await getPhotoUsage(pool, owner)).reservedBytes, 0);
    await rejectsCode(() => completePhotoUpload(pool, owner, expiredClaim.id, verified(expiredClaim, "expired")), "upload_expired");

    const completeExpiredReservation = await reservePhotoUpload(pool, owner, originalInput("d".repeat(64), 13));
    assert.ok(completeExpiredReservation && completeExpiredReservation.status !== "existing");
    const completeExpiredClaim = await claimPhotoUploadVerification(pool, owner, completeExpiredReservation.upload.id);
    assert.ok(completeExpiredClaim);
    await pool.query("UPDATE photo_uploads SET expires_at = clock_timestamp() - interval '1 second' WHERE owner = $1 AND id = $2", [owner, completeExpiredClaim.id]);
    await rejectsCode(() => completePhotoUpload(pool, owner, completeExpiredClaim.id, verified(completeExpiredClaim, "complete-expired")), "upload_expired");
    assert.equal((await getPhotoUpload(pool, owner, completeExpiredClaim.id))?.state, "expired");

    const reclaimedReservation = await reservePhotoUpload(pool, owner, originalInput(SHA_C, 12));
    assert.ok(reclaimedReservation && reclaimedReservation.status !== "existing");
    const oldClaim = await claimPhotoUploadVerification(pool, owner, reclaimedReservation.upload.id);
    assert.ok(oldClaim);
    await pool.query("UPDATE photo_uploads SET verification_lease_until = clock_timestamp() - interval '1 second' WHERE owner = $1 AND id = $2", [owner, oldClaim.id]);
    const newClaim = await claimPhotoUploadVerification(pool, owner, oldClaim.id);
    assert.ok(newClaim);
    assert.equal(newClaim.leaseGeneration, oldClaim.leaseGeneration + 1);
    await rejectsCode(() => rejectPhotoUpload(pool, owner, oldClaim.id, oldClaim.leaseGeneration, "content_rejected"), "upload_state_conflict");
    assert.equal((await getPhotoUpload(pool, owner, oldClaim.id))?.leaseGeneration, newClaim.leaseGeneration);
    await rejectsCode(() => completePhotoUpload(pool, owner, oldClaim.id, verified(oldClaim, "old-worker")), "upload_state_conflict");
    const done = await completePhotoUpload(pool, owner, newClaim.id, verified(newClaim, "new-worker"));
    assert.ok(done);
    assert.equal((await getPhotoUpload(pool, owner, newClaim.id))?.state, "stored");

    const staleRejectReservation = await reservePhotoUpload(pool, owner, originalInput("e".repeat(64), 14));
    assert.ok(staleRejectReservation && staleRejectReservation.status !== "existing");
    const staleRejectClaim = await claimPhotoUploadVerification(pool, owner, staleRejectReservation.upload.id);
    assert.ok(staleRejectClaim);
    await pool.query(
      "UPDATE photo_uploads SET verification_lease_until = clock_timestamp() - interval '1 second' WHERE owner = $1 AND id = $2",
      [owner, staleRejectClaim.id],
    );
    await rejectsCode(
      () => rejectPhotoUpload(pool, owner, staleRejectClaim.id, staleRejectClaim.leaseGeneration, "content_rejected"),
      "upload_state_conflict",
    );
    assert.equal((await getPhotoUpload(pool, owner, staleRejectClaim.id))?.state, "verifying");
  });

  it("keeps quota through trash and pending physical purge, then releases only the confirmed generation", async () => {
    const owner = `synthetic-purge-${randomUUID()}`;
    const made = await createOriginal(pool, owner, SHA_A, 123);
    const trashKey = { idempotencyKey: randomUUID(), requestHash: SHA_A };
    const trashed = await trashPhoto(pool, owner, made.completed.photoId, trashKey);
    assert.equal(trashed?.photo.lifecycle, "trashed");
    assert.equal((await trashPhoto(pool, owner, made.completed.photoId, trashKey))?.replayed, true);
    assert.deepEqual(await getPhotoUsage(pool, owner), {
      quotaBytes: PHOTO_QUOTA_BYTES,
      usedBytes: 123,
      originalBytes: 123,
      maskBytes: 0,
      trashBytes: 123,
      pendingPurgeBytes: 0,
      reservedBytes: 0,
      availableBytes: PHOTO_QUOTA_BYTES - 123,
    });

    const restored = await restorePhoto(pool, owner, made.completed.photoId, { idempotencyKey: randomUUID(), requestHash: SHA_B });
    assert.equal(restored?.photo.lifecycle, "active");
    assert.equal((await getPhotoUsage(pool, owner)).usedBytes, 123);
    await trashPhoto(pool, owner, made.completed.photoId, { idempotencyKey: randomUUID(), requestHash: SHA_C });

    const purge = await beginPhotoPurge(pool, owner, made.completed.photoId, { idempotencyKey: randomUUID(), requestHash: SHA_A });
    assert.ok(purge);
    assert.equal(await getPhoto(pool, owner, made.completed.photoId), null);
    const pending = await getPhotoUsage(pool, owner);
    assert.equal(pending.usedBytes, 123);
    assert.equal(pending.trashBytes, 0);
    assert.equal(pending.pendingPurgeBytes, 123);
    assert.deepEqual((await listPhotoPurgeAssets(pool, owner, purge.job.id))?.map((asset) => asset.id), [made.completed.assetId]);
    assert.equal(await confirmPhotoAssetDeleted(pool, owner, purge.job.id, made.completed.assetId, "wrong"), null);
    assert.equal((await getPhotoUsage(pool, owner)).usedBytes, 123);
    const completed = await confirmPhotoAssetDeleted(pool, owner, purge.job.id, made.completed.assetId, made.object.objectGeneration);
    assert.equal(completed?.state, "completed");
    assert.equal(completed?.pendingBytes, 0);
    assert.equal((await getPhotoUsage(pool, owner)).usedBytes, 0);
    assert.equal((await getPhotoPurgeJob(pool, owner, purge.job.id))?.state, "completed");
  });

  it("does not replay a stored upload or start result after its photo was purged", async () => {
    const owner = `synthetic-purged-replay-${randomUUID()}`;
    const input = originalInput(SHA_A, 66);
    const reservation = await reservePhotoUpload(pool, owner, input);
    assert.equal(reservation?.status, "created");
    const claim = await claimPhotoUploadVerification(pool, owner, reservation.upload.id);
    assert.ok(claim);
    const object = verified(claim, "purged-replay");
    const completed = await completePhotoUpload(pool, owner, claim.id, object);
    assert.ok(completed);
    await trashPhoto(pool, owner, completed.photoId, { idempotencyKey: randomUUID(), requestHash: SHA_A });
    await rejectsCode(() => completePhotoUpload(pool, owner, claim.id, object), "photo_trashed");
    await rejectsCode(() => reservePhotoUpload(pool, owner, input), "photo_trashed");
    const purge = await beginPhotoPurge(pool, owner, completed.photoId, { idempotencyKey: randomUUID(), requestHash: SHA_B });
    assert.ok(purge);
    assert.equal((await confirmPhotoAssetDeleted(pool, owner, purge.job.id, completed.assetId, object.objectGeneration))?.state, "completed");

    assert.equal(await completePhotoUpload(pool, owner, claim.id, object), null);
    assert.equal(await reservePhotoUpload(pool, owner, input), null);
  });

  it("fences a mask reservation and rejection when its target lifecycle epoch changed", async () => {
    const owner = `synthetic-mask-epoch-${randomUUID()}`;
    const made = await createOriginal(pool, owner, SHA_A, 100);
    const maskInput = {
      operation: "mask" as const,
      targetPhotoId: made.completed.photoId,
      sizeBytes: 20,
      sha256: SHA_B,
      contentType: "image/png",
      idempotencyKey: randomUUID(),
      requestHash: SHA_C,
    };
    const unclaimed = await reservePhotoUpload(pool, owner, maskInput);
    assert.equal(unclaimed?.status, "created");
    await trashPhoto(pool, owner, made.completed.photoId, { idempotencyKey: randomUUID(), requestHash: SHA_A });
    await restorePhoto(pool, owner, made.completed.photoId, { idempotencyKey: randomUUID(), requestHash: SHA_B });
    await rejectsCode(() => claimPhotoUploadVerification(pool, owner, unclaimed.upload.id), "upload_state_conflict");

    const claimedReservation = await reservePhotoUpload(pool, owner, { ...maskInput, idempotencyKey: randomUUID(), requestHash: SHA_A });
    assert.equal(claimedReservation?.status, "created");
    const claim = await claimPhotoUploadVerification(pool, owner, claimedReservation.upload.id);
    assert.ok(claim);
    await trashPhoto(pool, owner, made.completed.photoId, { idempotencyKey: randomUUID(), requestHash: SHA_C });
    await restorePhoto(pool, owner, made.completed.photoId, { idempotencyKey: randomUUID(), requestHash: SHA_A });
    await rejectsCode(
      () => rejectPhotoUpload(pool, owner, claim.id, claim.leaseGeneration, "content_rejected"),
      "upload_state_conflict",
    );
    assert.equal((await getPhotoUpload(pool, owner, claim.id))?.state, "verifying");
  });

  it("seeds RAW revision zero with the SDK neutral settings and canonical hash", async () => {
    const owner = `synthetic-raw-recipe-${randomUUID()}`;
    const input = {
      ...originalInput(SHA_A, 88),
      contentType: "image/x-adobe-dng",
      fileName: "synthetic.dng",
      format: "raw" as const,
    };
    const reservation = await reservePhotoUpload(pool, owner, input);
    assert.equal(reservation?.status, "created");
    const claim = await claimPhotoUploadVerification(pool, owner, reservation.upload.id);
    assert.ok(claim);
    const completed = await completePhotoUpload(pool, owner, claim.id, verified(claim, "raw-neutral"));
    assert.ok(completed);
    const expected = {
      v: 1,
      engine: "niho-2",
      look: "niho-standard-1",
      base: null,
      exposure: 0,
      contrast: 0,
      saturation: 0,
      relativeTemperature: 0,
      relativeTint: 0,
      whiteBalance: { mode: "asShot" },
    };
    const expectedHash = createHash("sha256").update(canonicalJson(expected)).digest("hex");
    const current = (await pool.query<{ settings: unknown; settings_sha256: string }>(
      "SELECT settings, settings_sha256 FROM photo_recipes WHERE owner = $1 AND photo_id = $2",
      [owner, completed.photoId],
    )).rows[0];
    const revision = (await pool.query<{ settings: unknown; settings_sha256: string }>(
      "SELECT settings, settings_sha256 FROM photo_recipe_revisions WHERE owner = $1 AND photo_id = $2 AND revision = 0",
      [owner, completed.photoId],
    )).rows[0];
    assert.deepEqual(current?.settings, expected);
    assert.equal(current?.settings_sha256, expectedHash);
    assert.deepEqual(revision, current);
  });

  it("changes the library revision when reserved capacity changes", async () => {
    const owner = `synthetic-usage-revision-${randomUUID()}`;
    const before = await getPhotoLibrary(pool, owner);
    const reserved = await reservePhotoUpload(pool, owner, originalInput(SHA_A, 100));
    assert.ok(reserved && reserved.status === "created");
    const during = await getPhotoLibrary(pool, owner);
    assert.ok(during.revision > before.revision);
    assert.equal(during.usage.reservedBytes, 100);
    await cancelPhotoUpload(pool, owner, reserved.upload.id);
    const cancelled = await getPhotoLibrary(pool, owner);
    assert.ok(cancelled.revision > during.revision);
    assert.equal(cancelled.usage.reservedBytes, 0);
    await cancelPhotoUpload(pool, owner, reserved.upload.id);
    assert.equal((await getPhotoLibrary(pool, owner)).revision, cancelled.revision);
  });

  it("permits erasing photo metadata after physical deletion while keeping the deleting-account fence", async () => {
    const owner = `synthetic-erasure-${randomUUID()}`;
    const made = await createOriginal(pool, owner);
    await markPhotoLibraryDeleting(pool, owner);
    const purge = await beginPhotoPurge(pool, owner, made.completed.photoId, { idempotencyKey: randomUUID(), requestHash: SHA_A });
    assert.ok(purge);
    await confirmPhotoAssetDeleted(pool, owner, purge.job.id, made.completed.assetId, made.object.objectGeneration);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      for (const table of ["photo_gc_objects", "photo_mutations", "photo_uploads", "photo_recipes", "photo_recipe_revisions", "photo_versions", "photo_media_jobs", "photo_purge_jobs", "photo_assets", "photos"]) {
        await client.query(`DELETE FROM ${table} WHERE owner = $1`, [owner]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    assert.equal(await getPhoto(pool, owner, made.completed.photoId), null);
    assert.equal(await getPhotoUpload(pool, owner, made.upload.id), null);
    const tombstone = await getPhotoLibrary(pool, owner);
    assert.equal(tombstone.state, "deleting");
    assert.equal(tombstone.usage.usedBytes, 0);
    await rejectsCode(() => reservePhotoUpload(pool, owner, originalInput(SHA_A, 1)), "account_deleting");
  });

  it("stores mask bytes per photo, tracks orphan cleanup idempotently and account deletion fences late work", async () => {
    const owner = `synthetic-mask-${randomUUID()}`;
    const made = await createOriginal(pool, owner, SHA_A, 100);
    const maskReservation = await reservePhotoUpload(pool, owner, {
      operation: "mask",
      targetPhotoId: made.completed.photoId,
      sizeBytes: 20,
      sha256: SHA_B,
      contentType: "image/png",
      idempotencyKey: randomUUID(),
      requestHash: SHA_C,
    });
    assert.ok(maskReservation && maskReservation.status !== "existing");
    const maskClaim = await claimPhotoUploadVerification(pool, owner, maskReservation.upload.id);
    assert.ok(maskClaim);
    await rejectsCode(
      () => completePhotoUpload(pool, owner, maskClaim.id, verified(maskClaim, "mask-wrong-type", { contentType: "image/jpeg" })),
      "content_rejected",
    );
    const maskDone = await completePhotoUpload(pool, owner, maskClaim.id, verified(maskClaim, "mask", { contentType: "image/png" }));
    assert.ok(maskDone);
    assert.equal((await getPhotoUsage(pool, owner)).maskBytes, 20);
    assert.equal((await getPhotoAsset(pool, owner, made.completed.photoId, maskDone.assetId))?.kind, "mask");

    const orphanInput = { uploadId: maskClaim.id, objectKey: "photo/orphan/synthetic", objectGeneration: "7", reason: "copy_db_failure" as const };
    const orphan = await recordPhotoOrphan(pool, owner, orphanInput);
    const replay = await recordPhotoOrphan(pool, owner, orphanInput);
    assert.ok(orphan && replay);
    assert.equal(replay.id, orphan.id);
    assert.deepEqual((await listPhotoOrphans(pool, owner)).map((item) => item.id), [orphan.id]);
    assert.equal(await confirmPhotoOrphanDeleted(pool, `other-${randomUUID()}`, orphan.id, "7"), null);
    assert.equal(await confirmPhotoOrphanDeleted(pool, owner, orphan.id, "wrong"), null);
    assert.equal((await confirmPhotoOrphanDeleted(pool, owner, orphan.id, "7"))?.state, "deleted");

    const lateReservation = await reservePhotoUpload(pool, owner, originalInput(SHA_C, 30));
    assert.ok(lateReservation && lateReservation.status !== "existing");
    const lateClaim = await claimPhotoUploadVerification(pool, owner, lateReservation.upload.id);
    assert.ok(lateClaim);
    const deleting = await markPhotoLibraryDeleting(pool, owner);
    assert.equal(deleting.state, "deleting");
    assert.equal(deleting.usage.reservedBytes, 0);
    await rejectsCode(() => completePhotoUpload(pool, owner, lateClaim.id, verified(lateClaim, "late")), "account_deleting");
    await rejectsCode(() => reservePhotoUpload(pool, owner, originalInput(SHA_C, 1)), "account_deleting");
    const accountPurge = await beginPhotoPurge(pool, owner, made.completed.photoId, { idempotencyKey: randomUUID(), requestHash: SHA_A });
    assert.ok(accountPurge);
    assert.equal(accountPurge.job.pendingBytes, 120);
  });
});
