import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { applyMigrations, defaultMigrationsDir } from "../src/migrate.ts";
import {
  allocatePhotoMediaCandidate,
  bindPhotoCanonicalBase,
  claimPhotoMediaJob,
  claimPhotoUploadVerification,
  completePhotoUpload,
  enqueuePhotoMediaJob,
  getPhotoCanonicalWorkingCopy,
  getPhotoLibrary,
  getPhotoSnapshot,
  markPhotoLibraryDeleting,
  publishPhotoMediaJob,
  putPhotoRecipe,
  reservePhotoUpload,
  stagePhotoMediaCandidate,
  trashPhoto,
  type PhotoJson,
  type PhotoMediaClaim,
  type PhotoSnapshot,
} from "../src/photo-store.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const BASE = "raw-apple.d8.p2.e1.synthetic";
const RENDERER = "e".repeat(64);
const spec = {
  rendererManifestSha256: RENDERER,
  thumbnailMaxEdge: 512,
  previewMaxEdge: 1280,
  workingCopyMaxEdge: 2560,
};

function canonical(value: PhotoJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as { readonly [key: string]: PhotoJson };
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key]!)}`).join(",")}}`;
}

function digest(value: PhotoJson | string): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

describe("P02 canonical working-copy lookup on PostgreSQL", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  const schema = `photo_canonical_context_${randomUUID().replaceAll("-", "")}`;

  before(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try { await applyMigrations(client, defaultMigrationsDir); } finally { client.release(); }
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  async function original(owner: string): Promise<PhotoSnapshot> {
    const sha256 = digest(`synthetic-raw-${randomUUID()}`);
    const reserved = await reservePhotoUpload(pool, owner, {
      operation: "original",
      sizeBytes: 100,
      sha256,
      contentType: "image/x-adobe-dng",
      fileName: "synthetic.dng",
      format: "raw",
      idempotencyKey: randomUUID(),
      requestHash: digest(randomUUID()),
    });
    assert.ok(reserved && reserved.status === "created");
    const claimed = await claimPhotoUploadVerification(pool, owner, reserved.upload.id);
    assert.ok(claimed);
    const completed = await completePhotoUpload(pool, owner, claimed.id, {
      leaseGeneration: claimed.leaseGeneration,
      sha256,
      sizeBytes: 100,
      objectKey: `photo/synthetic/original/${randomUUID()}`,
      objectGeneration: "1",
      contentType: "image/x-adobe-dng",
      format: "raw",
      width: 10,
      height: 10,
    });
    assert.ok(completed);
    const initial = await getPhotoSnapshot(pool, owner, completed.photoId);
    assert.ok(initial);
    const settings = { ...initial.recipe.settings, base: BASE };
    const bound = await bindPhotoCanonicalBase(pool, owner, initial.photo.id, {
      expectedRevision: 0,
      key: randomUUID(),
      requestHash: digest("bind-canonical-base"),
      recipe: { settings, settingsSha256: digest(settings), baseVersion: BASE, maskSurfaceIds: [], hasEdits: false },
      original: {
        assetId: initial.photo.original.id,
        generation: initial.photo.original.objectGeneration,
        sha256: initial.photo.original.sha256,
      },
    });
    assert.ok(bound);
    return bound.snapshot;
  }

  async function staged(owner: string, claim: PhotoMediaClaim, kind: "thumbnail" | "preview" | "working-copy") {
    const candidate = await allocatePhotoMediaCandidate(pool, owner, claim, {
      kind,
      sha256: digest(`${kind}-${randomUUID()}`),
      sizeBytes: 12,
      contentType: kind === "working-copy" ? "image/png" : "image/jpeg",
      width: 8,
      height: 8,
      objectKey: `photo/synthetic/media/${randomUUID()}`,
    });
    assert.ok(candidate);
    const result = await stagePhotoMediaCandidate(pool, owner, claim, candidate.id, "1");
    assert.ok(result && result.state === "staged" && result.objectGeneration);
    return result;
  }

  async function ready(owner: string) {
    const snapshot = await original(owner);
    const job = await enqueuePhotoMediaJob(pool, owner, snapshot.photo.id, spec);
    assert.ok(job);
    const claim = await claimPhotoMediaJob(pool, owner, job.id);
    assert.ok(claim);
    const thumbnail = await staged(owner, claim, "thumbnail");
    const preview = await staged(owner, claim, "preview");
    const workingCopy = await staged(owner, claim, "working-copy");
    const meta = { kind: "raw", source: "synthetic-only" } as const;
    assert.equal(await publishPhotoMediaJob(pool, owner, claim, {
      thumbnailId: thumbnail.id,
      previewId: preview.id,
      workingCopy: { assetId: workingCopy.id, baseVersion: BASE, encoding: "png16", meta },
    }, [thumbnail, preview, workingCopy].map((item) => ({ id: item.id, generation: item.objectGeneration! })),
    Math.min(claim.expiresAt - 1, Date.now() + 10_000)), true);
    return { snapshot, jobId: job.id, workingCopyId: workingCopy.id, meta };
  }

  function identity(snapshot: PhotoSnapshot) {
    return {
      libraryId: snapshot.library.id,
      originalAssetId: snapshot.photo.original.id,
      originalSha256: snapshot.photo.original.sha256,
      baseVersion: BASE,
      rendererManifestSha256: RENDERER,
    };
  }

  it("returns locator-free ready history while a newer preview job is queued", async () => {
    const owner = `synthetic-canonical-ready-${randomUUID()}`;
    const published = await ready(owner);
    const settings = { ...published.snapshot.recipe.settings, exposure: 0.5 };
    const edited = await putPhotoRecipe(pool, owner, published.snapshot.photo.id, {
      expectedRevision: published.snapshot.recipe.revision,
      key: randomUUID(),
      requestHash: digest("canonical-edit"),
      recipe: { settings, settingsSha256: digest(settings), baseVersion: BASE, maskSurfaceIds: [] },
    });
    assert.ok(edited);
    const pending = await enqueuePhotoMediaJob(pool, owner, published.snapshot.photo.id, spec);
    assert.ok(pending && pending.id !== published.jobId);
    assert.equal((await getPhotoSnapshot(pool, owner, published.snapshot.photo.id))?.media?.state, "queued");

    const found = await getPhotoCanonicalWorkingCopy(pool, owner, published.snapshot.photo.id, identity(edited.snapshot));
    assert.ok(found);
    assert.equal(found.workingCopy.asset.id, published.workingCopyId);
    assert.deepEqual(found.workingCopy.meta, published.meta);
    assert.equal(found.baseVersion, BASE);
    assert.equal(JSON.stringify(found).includes("objectKey"), false);
    assert.equal(JSON.stringify(found).includes("objectGeneration"), false);
    assert.deepEqual(Object.keys(found.workingCopy.asset).sort(),
      ["contentType", "height", "id", "kind", "sha256", "sizeBytes", "width"].sort());
  });

  it("keeps canonical history scoped to its owner, library and photo", async () => {
    const owner = `synthetic-canonical-owner-${randomUUID()}`;
    const foreign = `synthetic-canonical-foreign-${randomUUID()}`;
    const published = await ready(owner);
    const other = await original(owner);
    await getPhotoLibrary(pool, foreign);
    const expected = identity(published.snapshot);
    assert.equal(await getPhotoCanonicalWorkingCopy(pool, foreign, published.snapshot.photo.id, expected), null);
    assert.equal(await getPhotoCanonicalWorkingCopy(pool, owner, other.photo.id, expected), null);
    assert.equal(await getPhotoCanonicalWorkingCopy(pool, owner, published.snapshot.photo.id, { ...expected, libraryId: randomUUID() }), null);
    assert.equal(await getPhotoCanonicalWorkingCopy(pool, owner, published.snapshot.photo.id, { ...expected, originalAssetId: randomUUID() }), null);
    assert.equal(await getPhotoCanonicalWorkingCopy(pool, owner, published.snapshot.photo.id, { ...expected, originalSha256: "0".repeat(64) }), null);
  });

  it("rejects stale generation, base and renderer identities", async () => {
    const owner = `synthetic-canonical-stale-${randomUUID()}`;
    const published = await ready(owner);
    const expected = identity(published.snapshot);
    assert.ok(await getPhotoCanonicalWorkingCopy(pool, owner, published.snapshot.photo.id, expected));

    await pool.query("UPDATE photo_media_jobs SET original_generation='stale-generation' WHERE owner=$1 AND id=$2", [owner, published.jobId]);
    assert.equal(await getPhotoCanonicalWorkingCopy(pool, owner, published.snapshot.photo.id, expected), null);
    await pool.query("UPDATE photo_media_jobs SET original_generation='1',base_version='stale-base' WHERE owner=$1 AND id=$2", [owner, published.jobId]);
    assert.equal(await getPhotoCanonicalWorkingCopy(pool, owner, published.snapshot.photo.id, expected), null);
    await pool.query("UPDATE photo_media_jobs SET base_version=$3,renderer_manifest_sha256=$4 WHERE owner=$1 AND id=$2", [owner, published.jobId, BASE, "f".repeat(64)]);
    assert.equal(await getPhotoCanonicalWorkingCopy(pool, owner, published.snapshot.photo.id, expected), null);
    await pool.query("UPDATE photo_media_jobs SET renderer_manifest_sha256=$3,canonical_metadata='{}'::jsonb WHERE owner=$1 AND id=$2", [owner, published.jobId, RENDERER]);
    assert.equal(await getPhotoCanonicalWorkingCopy(pool, owner, published.snapshot.photo.id, expected), null);
  });

  it("rejects stale source descriptors and active lifecycle epochs", async () => {
    const owner = `synthetic-canonical-source-${randomUUID()}`;
    const published = await ready(owner);
    const expected = identity(published.snapshot);
    assert.ok(await getPhotoCanonicalWorkingCopy(pool, owner, published.snapshot.photo.id, expected));

    await pool.query("UPDATE photo_media_jobs SET source_format='png' WHERE owner=$1 AND id=$2", [owner, published.jobId]);
    assert.equal(await getPhotoCanonicalWorkingCopy(pool, owner, published.snapshot.photo.id, expected), null);
    await pool.query("UPDATE photo_media_jobs SET source_format=$3,source_width=source_width+1 WHERE owner=$1 AND id=$2", [owner, published.jobId, published.snapshot.photo.format]);
    assert.equal(await getPhotoCanonicalWorkingCopy(pool, owner, published.snapshot.photo.id, expected), null);
    await pool.query("UPDATE photo_media_jobs SET source_width=$3,source_height=source_height+1 WHERE owner=$1 AND id=$2", [owner, published.jobId, published.snapshot.photo.width]);
    assert.equal(await getPhotoCanonicalWorkingCopy(pool, owner, published.snapshot.photo.id, expected), null);
    await pool.query("UPDATE photo_media_jobs SET source_height=$3,lifecycle_epoch=lifecycle_epoch+1 WHERE owner=$1 AND id=$2", [owner, published.jobId, published.snapshot.photo.height]);
    assert.equal(await getPhotoCanonicalWorkingCopy(pool, owner, published.snapshot.photo.id, expected), null);
    await pool.query("UPDATE photo_media_jobs SET lifecycle_epoch=$3,library_lifecycle_epoch=library_lifecycle_epoch+1 WHERE owner=$1 AND id=$2", [owner, published.jobId, published.snapshot.photo.lifecycleEpoch]);
    assert.equal(await getPhotoCanonicalWorkingCopy(pool, owner, published.snapshot.photo.id, expected), null);
  });

  it("closes lookup after trash or account deletion", async () => {
    const trashedOwner = `synthetic-canonical-trash-${randomUUID()}`;
    const trashed = await ready(trashedOwner);
    await trashPhoto(pool, trashedOwner, trashed.snapshot.photo.id, { idempotencyKey: randomUUID(), requestHash: digest("trash") });
    assert.equal(await getPhotoCanonicalWorkingCopy(pool, trashedOwner, trashed.snapshot.photo.id, identity(trashed.snapshot)), null);

    const deletingOwner = `synthetic-canonical-deleting-${randomUUID()}`;
    const deleting = await ready(deletingOwner);
    await markPhotoLibraryDeleting(pool, deletingOwner);
    assert.equal(await getPhotoCanonicalWorkingCopy(pool, deletingOwner, deleting.snapshot.photo.id, identity(deleting.snapshot)), null);
  });
});
