import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { applyMigrations, defaultMigrationsDir } from "../src/migrate.ts";
import {
  PhotoRevisionConflictError, PhotoStoreError, allocatePhotoMediaCandidate, abandonPhotoMediaCandidates,
  beginPhotoPurge, bindPhotoCanonicalBase, bindPhotoRequest, claimPhotoMediaJob, claimPhotoUploadVerification, completePhotoUpload,
  enqueuePhotoMediaJob, failPhotoMediaJob, getPhotoLibrary, getPhotoMaskBySurfaceId, getPhotoSnapshot,
  getPhotoUploadByStartKey, getPhotoVersions, listPhotoCatalogPage, listPhotoMediaCandidateCleanup,
  listPhotoMediaOutbox, listPhotoRecipeHistory, listPendingPhotoMediaJobs, lookupPhotoHashes,
  markPhotoLibraryDeleting, publishPhotoMediaJob, putPhotoRecipe, putPhotoVersions, reconcilePhotoMediaCandidates,
  replayPhotoWrite, reservePhotoUpload, restorePhoto, stagePhotoMediaCandidate, supersedePhotoMediaJob, trashPhoto,
  type PhotoJson, type PhotoMediaClaim, type PhotoRecipeWrite, type PhotoSnapshot,
} from "../src/photo-store.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const SHA = "a".repeat(64), HASH = "b".repeat(64), RENDERER = "e".repeat(64);
function canonical(value: PhotoJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as { readonly [key: string]: PhotoJson };
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key]!)}`).join(",")}}`;
}
function digest(value: PhotoJson): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function write(snapshot: PhotoSnapshot, exposure: number, extra: Record<string, PhotoJson> = {}): PhotoRecipeWrite {
  const settings = { ...snapshot.recipe.settings, exposure, ...extra };
  return { settings, settingsSha256: digest(settings), baseVersion: snapshot.recipe.baseVersion, maskSurfaceIds: [] };
}
const mutation = () => ({ idempotencyKey: randomUUID(), requestHash: HASH });
const cas = () => ({ key: randomUUID(), requestHash: HASH });
const spec = { rendererManifestSha256: RENDERER, thumbnailMaxEdge: 512, previewMaxEdge: 1280, workingCopyMaxEdge: 2560 };

describe("P02 API writer operations on PostgreSQL", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  const schema = `photo_writer_${randomUUID().replaceAll("-", "")}`;
  before(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect(); try { await applyMigrations(client, defaultMigrationsDir); } finally { client.release(); }
  });
  after(async () => { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end(); });
  async function original(owner: string, sha256 = digest(randomUUID()), format: "jpeg" | "raw" = "jpeg") {
    const input = { operation: "original" as const, sizeBytes: 100, sha256, contentType: format === "raw" ? "image/x-adobe-dng" : "image/jpeg", fileName: "synthetic.jpg", format, ...mutation() };
    const reserved = await reservePhotoUpload(pool, owner, input); assert.ok(reserved && reserved.status === "created");
    const claimed = await claimPhotoUploadVerification(pool, owner, reserved.upload.id); assert.ok(claimed);
    const completed = await completePhotoUpload(pool, owner, claimed.id, { leaseGeneration: claimed.leaseGeneration, sha256, sizeBytes: 100,
      objectKey: `photo/synthetic/${randomUUID()}`, objectGeneration: "1", contentType: input.contentType, format, width: 10, height: 10 });
    assert.ok(completed); const snapshot = await getPhotoSnapshot(pool, owner, completed.photoId); assert.ok(snapshot); return { snapshot, uploadId: claimed.id, input };
  }
  async function mask(owner: string, photoId: string, sha256: string) {
    const reserved = await reservePhotoUpload(pool, owner, { operation: "mask", targetPhotoId: photoId, sizeBytes: 10, sha256, contentType: "image/png", ...mutation() });
    assert.ok(reserved && reserved.status === "created"); const claimed = await claimPhotoUploadVerification(pool, owner, reserved.upload.id); assert.ok(claimed);
    const stored = await completePhotoUpload(pool, owner, claimed.id, { leaseGeneration: claimed.leaseGeneration, sha256, sizeBytes: 10,
      objectKey: `photo/synthetic/mask/${randomUUID()}`, objectGeneration: "1", contentType: "image/png", width: 10, height: 10 }); assert.ok(stored); return stored;
  }
  async function candidates(owner: string, claim: PhotoMediaClaim) {
    const rows = [];
    for (const kind of ["thumbnail", "preview"] as const) {
      const allocated = await allocatePhotoMediaCandidate(pool, owner, claim, { kind, sha256: digest(kind), sizeBytes: 12, contentType: "image/jpeg", width: 8, height: 8, objectKey: `photo/synthetic/media/${randomUUID()}` }); assert.ok(allocated);
      const staged = await stagePhotoMediaCandidate(pool, owner, claim, allocated.id, "1"); assert.equal(staged?.state, "staged"); rows.push(staged!);
    }
    return { media: { thumbnailId: rows[0]!.id, previewId: rows[1]!.id, workingCopy: null }, objects: rows.map((row) => ({ id: row.id, generation: row.objectGeneration! })) };
  }

  it("persists request binding and owner-local start/mask lookups", async () => {
    const owner = `synthetic-journal-${randomUUID()}`, other = `synthetic-other-${randomUUID()}`;
    const made = await original(owner);
    assert.equal((await getPhotoUploadByStartKey(pool, owner, "original", made.input.idempotencyKey))?.id, made.uploadId);
    assert.equal(await getPhotoUploadByStartKey(pool, other, "original", made.input.idempotencyKey), null);
    const key = randomUUID(), input = { operation: "uploads.complete" as const, resourceId: made.uploadId, key, requestHash: HASH };
    assert.equal(await bindPhotoRequest(pool, owner, input), false);
    assert.equal(await bindPhotoRequest(pool, owner, input), true);
    await assert.rejects(bindPhotoRequest(pool, owner, { ...input, requestHash: SHA }), (e: unknown) => e instanceof PhotoStoreError && e.code === "idempotency_conflict");
    assert.equal(await bindPhotoRequest(pool, other, input), false);
    assert.equal((await pool.query("SELECT 1 FROM photo_request_journal WHERE owner=$1", [other])).rowCount, 0);
    await mask(owner, made.snapshot.photo.id, SHA);
    assert.ok(await getPhotoMaskBySurfaceId(pool, owner, made.snapshot.photo.id, SHA));
    assert.equal(await getPhotoMaskBySurfaceId(pool, other, made.snapshot.photo.id, SHA), null);
    assert.equal(await getPhotoMaskBySurfaceId(pool, owner, randomUUID(), SHA), null);
  });

  it("surfaces legacy active photos without migration-seeding media outbox rows", async () => {
    const owner = `synthetic-legacy-media-${randomUUID()}`, made = await original(owner), id = made.snapshot.photo.id;
    await pool.query("DELETE FROM photo_media_outbox WHERE owner=$1", [owner]);
    assert.deepEqual(await listPhotoMediaOutbox(pool, owner), [{
      photoId: id, lifecycleGeneration: made.snapshot.photo.lifecycleEpoch, recipeRevision: 0,
      settingsSha256: made.snapshot.recipe.settingsSha256,
    }]);
    assert.ok(await enqueuePhotoMediaJob(pool, owner, id, spec));
    assert.deepEqual(await listPhotoMediaOutbox(pool, owner), []);
  });

  it("uses stable keysets and a creation watermark while filtering one owner snapshot", async () => {
    const owner = `synthetic-page-${randomUUID()}`, other = `synthetic-page-other-${randomUUID()}`;
    await getPhotoLibrary(pool, owner);
    assert.deepEqual((await listPhotoCatalogPage(pool, owner, { filter: { lifecycle: "active", sort: "added-desc" }, after: null, watermark: null, limit: 2 }))?.items, []);
    const photos = await Promise.all([original(owner), original(owner), original(owner)]);
    const instant = "2026-01-01T00:00:00.000Z";
    await pool.query("UPDATE photos SET added_at=$2::timestamptz + (creation_sequence % 1000) * interval '1 microsecond',captured_at=NULL WHERE owner=$1", [owner, instant]);
    const ids = photos.map((p) => p.snapshot.photo.id).sort().reverse();
    const first = await listPhotoCatalogPage(pool, owner, { filter: { lifecycle: "active", sort: "added-desc" }, after: null, watermark: null, limit: 2 }); assert.ok(first);
    assert.deepEqual(first.items.map((p) => p.photo.id), ids.slice(0, 2)); assert.equal(first.hasMore, true);
    await original(owner);
    const last = first.items.at(-1)!.photo;
    const second = await listPhotoCatalogPage(pool, owner, { filter: { lifecycle: "active", sort: "added-desc" }, after: { sort: "added-desc", addedAt: last.addedAt, id: last.id }, watermark: first.watermark, limit: 2 }); assert.ok(second);
    assert.deepEqual(second.items.map((p) => p.photo.id), ids.slice(2)); assert.equal(second.hasMore, false);
    await pool.query("UPDATE photos SET captured_at=CASE WHEN id=$2 THEN NULL ELSE '2025-01-01T00:00:00Z'::timestamptz END WHERE owner=$1", [owner, ids[0]]);
    const captured = await listPhotoCatalogPage(pool, owner, { filter: { lifecycle: "active", sort: "captured-desc" }, after: null, watermark: first.watermark, limit: 2 }); assert.ok(captured);
    const tail = captured.items.at(-1)!.photo;
    const capturedLast = await listPhotoCatalogPage(pool, owner, { filter: { lifecycle: "active", sort: "captured-desc" }, after: { sort: "captured-desc", capturedAt: tail.capturedAt, addedAt: tail.addedAt, id: tail.id }, watermark: first.watermark, limit: 2 });
    assert.deepEqual(capturedLast?.items.map((p) => p.photo.id), [ids[0]]);
    assert.equal(await listPhotoCatalogPage(pool, other, { filter: { lifecycle: "active", sort: "added-desc" }, after: null, watermark: null, limit: 2 }), null);
    assert.deepEqual(await lookupPhotoHashes(pool, other, photos.map((p) => p.input.sha256)), []);
    assert.equal((await lookupPhotoHashes(pool, owner, photos.map((p) => p.input.sha256))).length, 3);
    const editable = await listPhotoCatalogPage(pool, owner, { filter: { lifecycle: "active", sort: "added-desc", editable: true, editableEngines: ["niho-14"], editableSettingsVersions: [1] }, after: null, watermark: first.watermark, limit: 100 });
    assert.equal(editable?.items.length, 3);
    assert.equal((await listPhotoCatalogPage(pool, owner, { filter: { lifecycle: "active", sort: "added-desc", editable: true }, after: null, watermark: null, limit: 100 }))?.items.length, 0);
  });

  it("serializes recipe CAS, preserves unknown JSON and replays the current state before stale CAS", async () => {
    const owner = `synthetic-recipe-${randomUUID()}`, made = await original(owner), id = made.snapshot.photo.id;
    const one = { expectedRevision: 0, ...cas(), recipe: write(made.snapshot, 1, { future: { values: [1, true, null] } }) };
    const two = { expectedRevision: 0, ...cas(), recipe: write(made.snapshot, 2) };
    const results = await Promise.allSettled([putPhotoRecipe(pool, owner, id, one), putPhotoRecipe(pool, owner, id, two)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected" && r.reason instanceof PhotoRevisionConflictError).length, 1);
    const winner = results[0]!.status === "fulfilled" ? one : two;
    const after = await getPhotoSnapshot(pool, owner, id); assert.ok(after); assert.equal(after.recipe.revision, 1); assert.equal(after.hasEdits, true);
    const next = await putPhotoRecipe(pool, owner, id, { expectedRevision: 1, ...cas(), recipe: write(after, 3) }); assert.ok(next);
    const replay = await putPhotoRecipe(pool, owner, id, winner); assert.equal(replay?.replayed, true); assert.equal(replay?.snapshot.recipe.revision, 2);
    assert.equal((await replayPhotoWrite(pool, owner, id, "recipe", winner))?.recipe.revision, 2);
    await assert.rejects(putPhotoRecipe(pool, owner, id, { ...winner, requestHash: SHA }), (e: unknown) => e instanceof PhotoStoreError && e.code === "idempotency_conflict");
    assert.equal((await listPhotoRecipeHistory(pool, owner, id))?.length, 3);
    assert.equal((await listPhotoMediaOutbox(pool, owner)).length, 1);
    assert.equal(await putPhotoRecipe(pool, `synthetic-foreign-${randomUUID()}`, id, one), null);
    if (winner === one) assert.deepEqual(after.recipe.settings.future, { values: [1, true, null] });
  });

  it("checks every mask digest in the same photo and rejects writes after lifecycle changes", async () => {
    const owner = `synthetic-mask-${randomUUID()}`, made = await original(owner), other = await original(owner), id = made.snapshot.photo.id;
    await mask(owner, other.snapshot.photo.id, SHA);
    const recipe = { ...write(made.snapshot, 1), maskSurfaceIds: [SHA] };
    await assert.rejects(putPhotoRecipe(pool, owner, id, { expectedRevision: 0, ...cas(), recipe }), (e: unknown) => e instanceof PhotoStoreError && e.code === "unsupported_settings");
    await mask(owner, id, SHA);
    const saved = await putPhotoRecipe(pool, owner, id, { expectedRevision: 0, ...cas(), recipe }); assert.ok(saved);
    await trashPhoto(pool, owner, id, mutation());
    await assert.rejects(putPhotoRecipe(pool, owner, id, { expectedRevision: 1, ...cas(), recipe: write(saved.snapshot, 2) }), (e: unknown) => e instanceof PhotoStoreError && e.code === "photo_trashed");
    await beginPhotoPurge(pool, owner, id, mutation());
    assert.equal(await putPhotoRecipe(pool, owner, id, { expectedRevision: 1, ...cas(), recipe }), null);
  });

  it("keeps VersionSet CAS separate, including an empty set and retry after a newer set", async () => {
    const owner = `synthetic-version-${randomUUID()}`, made = await original(owner), id = made.snapshot.photo.id;
    const key = cas(), version = { id: randomUUID(), name: "比較", kind: "named" as const, recipe: write(made.snapshot, 1) };
    const one = await putPhotoVersions(pool, owner, id, { expectedRevision: 0, ...key, versions: [version] }); assert.equal(one?.versions.revision, 1);
    assert.equal((await getPhotoSnapshot(pool, owner, id))?.recipe.revision, 0);
    const empty = await putPhotoVersions(pool, owner, id, { expectedRevision: 1, ...cas(), versions: [] }); assert.equal(empty?.versions.revision, 2);
    assert.deepEqual(empty?.versions.versions, []);
    const replay = await putPhotoVersions(pool, owner, id, { expectedRevision: 0, ...key, versions: [version] }); assert.equal(replay?.replayed, true); assert.equal(replay?.versions.revision, 2);
    await assert.rejects(putPhotoVersions(pool, owner, id, { expectedRevision: 0, ...cas(), versions: [] }), PhotoRevisionConflictError);
    assert.equal((await getPhotoVersions(pool, owner, id))?.versions.revision, 2);
  });

  it("stores trusted SDK neutrality and uses it for edited filtering", async () => {
    const owner = `synthetic-neutral-${randomUUID()}`, made = await original(owner), id = made.snapshot.photo.id;
    const recipe = { ...write(made.snapshot, 0), hasEdits: false };
    const saved = await putPhotoRecipe(pool, owner, id, { expectedRevision: 0, ...cas(), recipe }); assert.equal(saved?.snapshot.hasEdits, false);
    const page = await listPhotoCatalogPage(pool, owner, { filter: { lifecycle: "active", sort: "added-desc", edited: false }, after: null, watermark: null, limit: 100 });
    assert.deepEqual(page?.items.map((p) => p.photo.id), [id]);
  });

  it("binds a decoder canonical base only to the exact unedited revision-zero source", async () => {
    const owner = `synthetic-base-${randomUUID()}`, made = await original(owner, digest(randomUUID()), "raw"), id = made.snapshot.photo.id;
    const originalRef = { assetId: made.snapshot.photo.original.id, generation: made.snapshot.photo.original.objectGeneration, sha256: made.snapshot.photo.original.sha256 };
    const input = { expectedRevision: 0, ...cas(), recipe: { ...write(made.snapshot, 0), baseVersion: "synthetic-base-v1", hasEdits: false }, original: originalRef };
    await assert.rejects(putPhotoRecipe(pool, owner, id, input), (e: unknown) => e instanceof PhotoStoreError && e.code === "unsupported_settings");
    await assert.rejects(bindPhotoCanonicalBase(pool, owner, id, { ...input, original: { ...originalRef, generation: "wrong" } }), (e: unknown) => e instanceof PhotoStoreError && e.code === "upload_state_conflict");
    const bound = await bindPhotoCanonicalBase(pool, owner, id, input); assert.equal(bound?.snapshot.recipe.revision, 1); assert.equal(bound?.snapshot.recipe.baseVersion, "synthetic-base-v1");
    assert.equal((await bindPhotoCanonicalBase(pool, owner, id, input))?.replayed, true);
    await assert.rejects(bindPhotoCanonicalBase(pool, owner, id, { ...input, original: { ...originalRef, generation: "wrong" } }), (e: unknown) => e instanceof PhotoStoreError && e.code === "upload_state_conflict");
    await assert.rejects(bindPhotoCanonicalBase(pool, owner, id, { ...input, ...cas() }), PhotoRevisionConflictError);
    const late = await original(owner, digest(randomUUID()), "raw");
    await putPhotoRecipe(pool, owner, late.snapshot.photo.id, { expectedRevision: 0, ...cas(), recipe: write(late.snapshot, 1) });
    await assert.rejects(bindPhotoCanonicalBase(pool, owner, late.snapshot.photo.id, { ...input, ...cas(), original: { assetId: late.snapshot.photo.original.id, generation: "1", sha256: late.snapshot.photo.original.sha256 } }), PhotoRevisionConflictError);
  });

  it("converges media jobs, publishes immutable candidates and preserves ready outputs from cleanup", async () => {
    const owner = `synthetic-media-${randomUUID()}`, made = await original(owner), id = made.snapshot.photo.id;
    const job = await enqueuePhotoMediaJob(pool, owner, id, spec); assert.ok(job);
    assert.deepEqual(await enqueuePhotoMediaJob(pool, owner, id, spec), { ...job, created: false });
    assert.deepEqual(await listPendingPhotoMediaJobs(pool, owner), [job.id]);
    const claims = await Promise.all([claimPhotoMediaJob(pool, owner, job.id), claimPhotoMediaJob(pool, owner, job.id)]);
    assert.equal(claims.filter(Boolean).length, 1); const claim = claims.find(Boolean)!;
    const outputs = await candidates(owner, claim);
    assert.equal(await publishPhotoMediaJob(pool, owner, claim, outputs.media, outputs.objects, Math.min(claim.expiresAt, Date.now() + 10_000)), true);
    assert.equal(await publishPhotoMediaJob(pool, owner, claim, outputs.media, outputs.objects, Math.min(claim.expiresAt, Date.now() + 10_000)), false);
    const ready = await getPhotoSnapshot(pool, owner, id); assert.equal(ready?.media?.state, "ready"); assert.equal(ready?.media?.assets.length, 2);
    assert.equal(await abandonPhotoMediaCandidates(pool, owner, claim), 0);
    assert.deepEqual(await listPhotoMediaCandidateCleanup(pool, owner), []);
    assert.equal(await getPhotoSnapshot(pool, `synthetic-foreign-${randomUUID()}`, id), null);
  });

  it("fences late media after recipe changes and reconciles interrupted candidates", async () => {
    const owner = `synthetic-stale-${randomUUID()}`, made = await original(owner), id = made.snapshot.photo.id;
    const job = await enqueuePhotoMediaJob(pool, owner, id, spec); assert.ok(job); const claim = await claimPhotoMediaJob(pool, owner, job.id); assert.ok(claim);
    const outputs = await candidates(owner, claim);
    await putPhotoRecipe(pool, owner, id, { expectedRevision: 0, ...cas(), recipe: write(made.snapshot, 1) });
    assert.equal(await publishPhotoMediaJob(pool, owner, claim, outputs.media, outputs.objects, Math.min(claim.expiresAt, Date.now() + 10_000)), false);
    assert.equal(await failPhotoMediaJob(pool, owner, claim, "decoder_failed", null), false);
    assert.equal(await reconcilePhotoMediaCandidates(pool, owner), 2);
    assert.equal((await listPhotoMediaCandidateCleanup(pool, owner)).length, 2);
    assert.equal(await supersedePhotoMediaJob(pool, owner, claim), true);
    assert.equal((await getPhotoSnapshot(pool, owner, id))?.media, null);
  });

  it("fences old lease generations, retries durably and stops at the attempt bound", async () => {
    const owner = `synthetic-retry-${randomUUID()}`, made = await original(owner), job = await enqueuePhotoMediaJob(pool, owner, made.snapshot.photo.id, spec); assert.ok(job);
    const first = await claimPhotoMediaJob(pool, owner, job.id); assert.ok(first);
    await assert.rejects(failPhotoMediaJob(pool, owner, first, "cancelled", Date.now() + 1_000), TypeError);
    await pool.query("UPDATE photo_media_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE owner=$1 AND id=$2", [owner, job.id]);
    assert.equal(await failPhotoMediaJob(pool, owner, first, "infrastructure_unavailable", Date.now() - 1), false);
    assert.equal(await supersedePhotoMediaJob(pool, owner, first), false);
    const second = await claimPhotoMediaJob(pool, owner, job.id); assert.ok(second); assert.equal(second.attempt, 2);
    assert.equal(await failPhotoMediaJob(pool, owner, first, "decoder_failed", null), false);
    assert.equal(await failPhotoMediaJob(pool, owner, second, "timeout", Date.now() - 1), true);
    const third = await claimPhotoMediaJob(pool, owner, job.id); assert.ok(third); assert.equal(third.attempt, 3);
    await failPhotoMediaJob(pool, owner, third, "timeout", Date.now() - 1);
    assert.equal(await claimPhotoMediaJob(pool, owner, job.id), null);
    assert.equal((await getPhotoSnapshot(pool, owner, made.snapshot.photo.id))?.media?.errorCode, "renderer_unavailable");
  });

  it("rejects expired publications and fences trash/restore/account deletion", async () => {
    const owner = `synthetic-fence-${randomUUID()}`, made = await original(owner), id = made.snapshot.photo.id;
    const job = await enqueuePhotoMediaJob(pool, owner, id, spec); assert.ok(job); const claim = await claimPhotoMediaJob(pool, owner, job.id); assert.ok(claim); const outputs = await candidates(owner, claim);
    assert.equal(await publishPhotoMediaJob(pool, owner, claim, outputs.media, outputs.objects, Date.now() - 1), false);
    await trashPhoto(pool, owner, id, mutation());
    assert.equal(await publishPhotoMediaJob(pool, owner, claim, outputs.media, outputs.objects, Math.min(claim.expiresAt, Date.now() + 10_000)), false);
    await restorePhoto(pool, owner, id, mutation()); assert.equal((await listPhotoMediaOutbox(pool, owner)).length, 1);
    const newJob = await enqueuePhotoMediaJob(pool, owner, id, spec); assert.ok(newJob); assert.notEqual(newJob.id, job.id);
    await markPhotoLibraryDeleting(pool, owner);
    assert.equal(await claimPhotoMediaJob(pool, owner, newJob.id), null);
    assert.equal(await getPhotoSnapshot(pool, owner, id), null);
    assert.deepEqual(await lookupPhotoHashes(pool, owner, [made.input.sha256]), []);
    assert.deepEqual(await listPhotoMediaOutbox(pool, owner), []);
  });

  it("terminates a crashed final attempt after its lease expires", async () => {
    const owner = `synthetic-final-lease-${randomUUID()}`, made = await original(owner), job = await enqueuePhotoMediaJob(pool, owner, made.snapshot.photo.id, spec); assert.ok(job);
    await pool.query("UPDATE photo_media_jobs SET attempt_count=2 WHERE owner=$1 AND id=$2", [owner, job.id]);
    const claim = await claimPhotoMediaJob(pool, owner, job.id); assert.equal(claim?.attempt, 3);
    await pool.query("UPDATE photo_media_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE owner=$1 AND id=$2", [owner, job.id]);
    assert.deepEqual(await listPendingPhotoMediaJobs(pool, owner), [job.id]);
    assert.equal(await claimPhotoMediaJob(pool, owner, job.id), null);
    assert.equal((await getPhotoSnapshot(pool, owner, made.snapshot.photo.id))?.media?.state, "failed");
  });

  it("keeps a purge from accepting a late media publication", async () => {
    const owner = `synthetic-purge-media-${randomUUID()}`, made = await original(owner), id = made.snapshot.photo.id;
    const job = await enqueuePhotoMediaJob(pool, owner, id, spec); assert.ok(job);
    const claim = await claimPhotoMediaJob(pool, owner, job.id); assert.ok(claim); const outputs = await candidates(owner, claim);
    await trashPhoto(pool, owner, id, mutation()); await beginPhotoPurge(pool, owner, id, mutation());
    assert.equal(await publishPhotoMediaJob(pool, owner, claim, outputs.media, outputs.objects, Math.min(claim.expiresAt, Date.now() + 10_000)), false);
    assert.equal(await reconcilePhotoMediaCandidates(pool, owner), 2);
    assert.equal((await listPhotoMediaCandidateCleanup(pool, owner)).length, 2);
  });
});
