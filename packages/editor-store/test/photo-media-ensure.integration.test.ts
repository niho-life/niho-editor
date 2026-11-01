import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { applyMigrations, defaultMigrationsDir } from "../src/migrate.ts";
import {
  PhotoRevisionConflictError,
  PhotoStoreError,
  claimPhotoMediaJob,
  claimPhotoUploadVerification,
  completePhotoUpload,
  enqueuePhotoMediaJob,
  ensurePhotoMediaJob,
  failPhotoMediaJob,
  getPhotoLibrary,
  getPhotoSnapshot,
  markPhotoLibraryDeleting,
  publishPhotoMediaJob,
  putPhotoRecipe,
  reservePhotoUpload,
  trashPhoto,
  type PhotoJson,
  type PhotoMediaClaim,
  type PhotoSnapshot,
} from "../src/photo-store.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const RENDERER = "e".repeat(64);
const REQUEST_HASH = (revision: number) => createHash("sha256").update(JSON.stringify({ recipeRevision: revision })).digest("hex");
const spec = { rendererManifestSha256: RENDERER, thumbnailMaxEdge: 512, previewMaxEdge: 1280, workingCopyMaxEdge: 2560 };

function canonical(value: PhotoJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as { readonly [key: string]: PhotoJson };
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key]!)}`).join(",")}}`;
}
function digest(value: PhotoJson | string): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}
function recipe(snapshot: PhotoSnapshot, exposure: number) {
  const settings = { ...snapshot.recipe.settings, exposure };
  return { settings, settingsSha256: digest(settings), baseVersion: snapshot.recipe.baseVersion, maskSurfaceIds: [] };
}
function ensureInput(recipeRevision: number, key = randomUUID()) {
  return { recipeRevision, key, requestHash: REQUEST_HASH(recipeRevision) };
}
function uploadMutation() { return { idempotencyKey: randomUUID(), requestHash: digest(randomUUID()) }; }
function lifecycleMutation() { return { idempotencyKey: randomUUID(), requestHash: digest(randomUUID()) }; }

describe("P00 media.ensure PostgreSQL operation", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  const schema = `photo_media_ensure_${randomUUID().replaceAll("-", "")}`;

  before(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl, max: 12, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try { await applyMigrations(client, defaultMigrationsDir); } finally { client.release(); }
  });
  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  async function original(owner: string): Promise<PhotoSnapshot> {
    const sha256 = digest(`synthetic-original-${randomUUID()}`);
    const reserved = await reservePhotoUpload(pool, owner, {
      operation: "original", sizeBytes: 100, sha256, contentType: "image/jpeg",
      fileName: "synthetic.jpg", format: "jpeg", ...uploadMutation(),
    });
    assert.ok(reserved && reserved.status === "created");
    const claim = await claimPhotoUploadVerification(pool, owner, reserved.upload.id);
    assert.ok(claim);
    const completed = await completePhotoUpload(pool, owner, claim.id, {
      leaseGeneration: claim.leaseGeneration,
      sha256,
      sizeBytes: 100,
      objectKey: `photo/synthetic/${randomUUID()}`,
      objectGeneration: "1",
      contentType: "image/jpeg",
      format: "jpeg",
      width: 10,
      height: 10,
    });
    assert.ok(completed);
    const snapshot = await getPhotoSnapshot(pool, owner, completed.photoId);
    assert.ok(snapshot);
    return snapshot;
  }

  async function jobRow(owner: string, photoId: string) {
    return (await pool.query<{
      id: string; state: string; attempt_count: number; claim_generation: string;
      terminal_reason: string | null; lease_until: Date | null; retry_at: Date | null;
      error_code: string | null; attempt_error: string | null; ready_media: unknown;
    }>(`SELECT j.id,j.state,j.attempt_count,j.claim_generation::text AS claim_generation,j.terminal_reason,
              j.lease_until,j.retry_at,j.error_code,j.attempt_error,j.ready_media
           FROM photos AS p JOIN photo_media_jobs AS j ON j.owner=p.owner AND j.id=p.current_media_job_id
          WHERE p.owner=$1 AND p.id=$2`, [owner, photoId])).rows[0];
  }

  async function failThreeAttempts(owner: string, jobId: string): Promise<PhotoMediaClaim> {
    let last: PhotoMediaClaim | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      last = await claimPhotoMediaJob(pool, owner, jobId);
      assert.ok(last);
      assert.equal(last.attempt, attempt);
      assert.equal(await failPhotoMediaJob(pool, owner, last, "timeout", Date.now() - 1), true);
    }
    return last!;
  }

  it("binds only successful current-revision requests and keeps replay owner-scoped", async () => {
    const owner = `synthetic-ensure-a-${randomUUID()}`;
    const foreign = `synthetic-ensure-b-${randomUUID()}`;
    const snapshot = await original(owner);
    await getPhotoLibrary(pool, foreign);
    const id = snapshot.photo.id;

    const stale = ensureInput(1);
    await assert.rejects(ensurePhotoMediaJob(pool, owner, id, stale, spec), (error: unknown) =>
      error instanceof PhotoRevisionConflictError && error.currentRevision === 0);
    assert.equal((await pool.query("SELECT 1 FROM photo_media_ensure_receipts WHERE owner=$1", [owner])).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM photo_media_jobs WHERE owner=$1", [owner])).rowCount, 0);

    assert.equal(await ensurePhotoMediaJob(pool, foreign, id, ensureInput(0), spec), null);
    assert.equal((await pool.query("SELECT 1 FROM photo_media_ensure_receipts WHERE owner=$1", [foreign])).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM photo_media_jobs WHERE owner=$1", [foreign])).rowCount, 0);

    const accepted = ensureInput(0);
    const first = await ensurePhotoMediaJob(pool, owner, id.toUpperCase(), accepted, spec);
    assert.ok(first);
    assert.equal(first.replayed, false);
    assert.equal(first.snapshot.media?.state, "queued");
    const beforeRecipe = await jobRow(owner, id);
    assert.ok(beforeRecipe);
    await assert.rejects(
      ensurePhotoMediaJob(pool, owner, id, { ...accepted, requestHash: digest("different-body") }, spec),
      (error: unknown) => error instanceof PhotoStoreError && error.code === "idempotency_conflict",
    );

    const changed = await putPhotoRecipe(pool, owner, id, {
      expectedRevision: 0, key: randomUUID(), requestHash: digest("recipe-change"), recipe: recipe(snapshot, 0.5),
    });
    assert.ok(changed);
    const replay = await ensurePhotoMediaJob(pool, owner, id, accepted, spec);
    assert.ok(replay);
    assert.equal(replay.replayed, true);
    assert.equal(replay.snapshot.recipe.revision, 1);
    assert.equal(replay.snapshot.media, null);
    const oldJob = (await pool.query("SELECT state,attempt_count,claim_generation FROM photo_media_jobs WHERE owner=$1 AND id=$2", [owner, beforeRecipe.id])).rows[0];
    assert.deepEqual(oldJob, { state: beforeRecipe.state, attempt_count: beforeRecipe.attempt_count, claim_generation: beforeRecipe.claim_generation });

    const receiptsBefore = (await pool.query("SELECT 1 FROM photo_media_ensure_receipts WHERE owner=$1", [owner])).rowCount;
    await assert.rejects(ensurePhotoMediaJob(pool, owner, id, ensureInput(0), spec), PhotoRevisionConflictError);
    assert.equal((await pool.query("SELECT 1 FROM photo_media_ensure_receipts WHERE owner=$1", [owner])).rowCount, receiptsBefore);
    assert.equal((await pool.query("SELECT 1 FROM photo_media_jobs WHERE owner=$1", [owner])).rowCount, 1);
  });

  it("serializes concurrent same and distinct keys onto one convergence job", async () => {
    const owner = `synthetic-converge-${randomUUID()}`;
    const snapshot = await original(owner);
    const same = ensureInput(0);
    const distinctA = ensureInput(0);
    const distinctB = ensureInput(0);
    const results = await Promise.all([
      ensurePhotoMediaJob(pool, owner, snapshot.photo.id, same, spec),
      ensurePhotoMediaJob(pool, owner, snapshot.photo.id, same, spec),
      ensurePhotoMediaJob(pool, owner, snapshot.photo.id, distinctA, spec),
      ensurePhotoMediaJob(pool, owner, snapshot.photo.id, distinctB, spec),
    ]);
    assert.equal(results.filter((result) => result?.replayed).length, 1);
    assert.equal(results.filter((result) => result && !result.replayed).length, 3);
    assert.equal((await pool.query("SELECT 1 FROM photo_media_jobs WHERE owner=$1", [owner])).rowCount, 1);
    assert.equal((await pool.query("SELECT 1 FROM photo_media_ensure_receipts WHERE owner=$1", [owner])).rowCount, 3);
    assert.equal((await jobRow(owner, snapshot.photo.id))?.state, "queued");
  });

  it("uses one new accepted key to requeue a terminal failed job and fence the old claim", async () => {
    const owner = `synthetic-retry-${randomUUID()}`;
    const snapshot = await original(owner);
    const usageBefore = (await getPhotoLibrary(pool, owner)).usage;
    const originalKey = ensureInput(0);
    const accepted = await ensurePhotoMediaJob(pool, owner, snapshot.photo.id, originalKey, spec);
    assert.ok(accepted?.snapshot.media && accepted.snapshot.media.state === "queued");
    const jobId = accepted.snapshot.media.id;
    const oldClaim = await failThreeAttempts(owner, jobId);
    const failed = await jobRow(owner, snapshot.photo.id);
    assert.ok(failed);
    assert.equal(failed.state, "failed");
    assert.equal(failed.attempt_count, 3);
    assert.equal(failed.terminal_reason, null);

    assert.deepEqual(await enqueuePhotoMediaJob(pool, owner, snapshot.photo.id, spec), { id: jobId, key: oldClaim.key, created: false });
    assert.deepEqual(await jobRow(owner, snapshot.photo.id), failed);
    const replay = await ensurePhotoMediaJob(pool, owner, snapshot.photo.id, originalKey, spec);
    assert.equal(replay?.replayed, true);
    assert.deepEqual(await jobRow(owner, snapshot.photo.id), failed);

    const retryA = ensureInput(0), retryB = ensureInput(0);
    const retried = await Promise.all([
      ensurePhotoMediaJob(pool, owner, snapshot.photo.id, retryA, spec),
      ensurePhotoMediaJob(pool, owner, snapshot.photo.id, retryB, spec),
    ]);
    assert.ok(retried.every((result) => result && !result.replayed && result.snapshot.media?.state === "queued"));
    const queued = await jobRow(owner, snapshot.photo.id);
    assert.ok(queued);
    assert.equal(queued.id, jobId);
    assert.equal(queued.state, "queued");
    assert.equal(queued.attempt_count, 0);
    assert.equal(Number(queued.claim_generation), Number(failed.claim_generation) + 1);
    assert.equal(queued.lease_until, null);
    assert.equal(queued.retry_at, null);
    assert.equal(queued.error_code, null);
    assert.equal(queued.attempt_error, null);
    assert.equal(queued.ready_media, null);

    const newClaim = await claimPhotoMediaJob(pool, owner, jobId);
    assert.ok(newClaim);
    assert.equal(newClaim.attempt, 1);
    assert.equal(newClaim.generation, Number(failed.claim_generation) + 2);
    const processing = await jobRow(owner, snapshot.photo.id);
    assert.ok(processing);
    assert.equal(processing.state, "processing");
    assert.equal(processing.attempt_count, 1);
    assert.equal(Number(processing.claim_generation), newClaim.generation);
    assert.ok(processing.lease_until);

    const processingReplay = await ensurePhotoMediaJob(pool, owner, snapshot.photo.id, retryA, spec);
    assert.equal(processingReplay?.replayed, true);
    assert.deepEqual(await jobRow(owner, snapshot.photo.id), processing);
    assert.equal(await failPhotoMediaJob(pool, owner, oldClaim, "decoder_failed", null), false);
    const thumbnailId = randomUUID(), previewId = randomUUID();
    assert.equal(await publishPhotoMediaJob(pool, owner, oldClaim, {
      thumbnailId,
      previewId,
      workingCopy: null,
    }, [
      { id: thumbnailId, generation: "1" },
      { id: previewId, generation: "1" },
    ], oldClaim.expiresAt - 1), false);
    assert.deepEqual(await jobRow(owner, snapshot.photo.id), processing);
    assert.deepEqual((await getPhotoLibrary(pool, owner)).usage, usageBefore);
  });

  it("does not reset unsupported or ready convergence jobs for a new accepted key", async () => {
    const unsupportedOwner = `synthetic-unsupported-${randomUUID()}`;
    const unsupportedPhoto = await original(unsupportedOwner);
    const unsupportedAccepted = await ensurePhotoMediaJob(pool, unsupportedOwner, unsupportedPhoto.photo.id, ensureInput(0), spec);
    assert.ok(unsupportedAccepted?.snapshot.media);
    const unsupportedClaim = await claimPhotoMediaJob(pool, unsupportedOwner, unsupportedAccepted.snapshot.media.id);
    assert.ok(unsupportedClaim);
    assert.equal(await failPhotoMediaJob(pool, unsupportedOwner, unsupportedClaim, "unsupported_settings", null), true);
    const unsupportedBefore = await jobRow(unsupportedOwner, unsupportedPhoto.photo.id);
    assert.ok(unsupportedBefore);
    assert.equal(unsupportedBefore.state, "unsupported");
    const unsupportedEnsure = await ensurePhotoMediaJob(pool, unsupportedOwner, unsupportedPhoto.photo.id, ensureInput(0), spec);
    assert.equal(unsupportedEnsure?.replayed, false);
    assert.deepEqual(await jobRow(unsupportedOwner, unsupportedPhoto.photo.id), unsupportedBefore);

    const readyOwner = `synthetic-ready-${randomUUID()}`;
    const readyPhoto = await original(readyOwner);
    const readyAccepted = await ensurePhotoMediaJob(pool, readyOwner, readyPhoto.photo.id, ensureInput(0), spec);
    assert.ok(readyAccepted?.snapshot.media);
    await pool.query(
      "UPDATE photo_media_jobs SET state='ready',attempt_count=1,claim_generation=5,lease_until=NULL,error_code=NULL,attempt_error=NULL,ready_media='{}'::jsonb WHERE owner=$1 AND id=$2",
      [readyOwner, readyAccepted.snapshot.media.id],
    );
    const readyBefore = await jobRow(readyOwner, readyPhoto.photo.id);
    assert.ok(readyBefore);
    assert.equal(readyBefore.state, "ready");
    const readyEnsure = await ensurePhotoMediaJob(pool, readyOwner, readyPhoto.photo.id, ensureInput(0), spec);
    assert.equal(readyEnsure?.replayed, false);
    assert.deepEqual(await jobRow(readyOwner, readyPhoto.photo.id), readyBefore);
  });

  it("closes replay after trash and account deletion without creating receipts", async () => {
    const trashedOwner = `synthetic-trash-${randomUUID()}`;
    const trashed = await original(trashedOwner);
    await trashPhoto(pool, trashedOwner, trashed.photo.id, lifecycleMutation());
    await assert.rejects(ensurePhotoMediaJob(pool, trashedOwner, trashed.photo.id, ensureInput(0), spec),
      (error: unknown) => error instanceof PhotoStoreError && error.code === "photo_trashed");
    assert.equal((await pool.query("SELECT 1 FROM photo_media_ensure_receipts WHERE owner=$1", [trashedOwner])).rowCount, 0);

    const deletingOwner = `synthetic-deleting-${randomUUID()}`;
    const deleting = await original(deletingOwner);
    await markPhotoLibraryDeleting(pool, deletingOwner);
    await assert.rejects(ensurePhotoMediaJob(pool, deletingOwner, deleting.photo.id, ensureInput(0), spec),
      (error: unknown) => error instanceof PhotoStoreError && error.code === "account_deleting");
    assert.equal((await pool.query("SELECT 1 FROM photo_media_ensure_receipts WHERE owner=$1", [deletingOwner])).rowCount, 0);
  });

  it("serializes a real recipe-vs-ensure race without binding a stale successful receipt", async () => {
    const owner = `synthetic-race-${randomUUID()}`;
    const snapshot = await original(owner);
    const ensure = ensureInput(0);
    const [recipeResult, ensureResult] = await Promise.allSettled([
      putPhotoRecipe(pool, owner, snapshot.photo.id, {
        expectedRevision: 0, key: randomUUID(), requestHash: digest("race-recipe"), recipe: recipe(snapshot, 0.75),
      }),
      ensurePhotoMediaJob(pool, owner, snapshot.photo.id, ensure, spec),
    ]);
    assert.equal(recipeResult.status, "fulfilled");
    const receipts = (await pool.query("SELECT request_hash FROM photo_media_ensure_receipts WHERE owner=$1 AND photo_id=$2", [owner, snapshot.photo.id])).rows;
    if (ensureResult.status === "rejected") {
      assert.ok(ensureResult.reason instanceof PhotoRevisionConflictError);
      assert.equal(receipts.length, 0);
    } else {
      assert.equal(ensureResult.value?.replayed, false);
      assert.deepEqual(receipts, [{ request_hash: ensure.requestHash }]);
    }
    assert.equal((await getPhotoSnapshot(pool, owner, snapshot.photo.id))?.recipe.revision, 1);
  });
});
