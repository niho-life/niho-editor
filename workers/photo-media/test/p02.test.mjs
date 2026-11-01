import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, test } from "node:test";
import { applyMigrations, defaultMigrationsDir } from "../../../packages/editor-store/src/migrate.ts";
import {
  claimPhotoUploadVerification, completePhotoUpload, enqueuePhotoMediaJob, getPhotoSnapshot,
  listPhotoMediaCandidateCleanup, reservePhotoUpload, trashPhoto,
} from "../../../packages/editor-store/src/photo-store.ts";
import { MEDIA_BASELINE } from "../src/baseline.ts";
import { mediaIdentity, mediaJobKey } from "../src/identity.ts";
import { createP02MediaJobs, createP02MediaObjects } from "../src/p02.ts";
import { createMediaExecutor } from "../src/run.ts";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH2kAAAAASUVORK5CYII=", "base64");
const spec = { rendererManifestSha256: MEDIA_BASELINE.manifestSha256, thumbnailMaxEdge: 512, previewMaxEdge: 1280, workingCopyMaxEdge: 2560 };
const mutation = () => ({ idempotencyKey: randomUUID(), requestHash: hash("synthetic-request") });
const signal = () => AbortSignal.timeout(5000);

test("owner-scoped adapters refuse foreign identities before any database/storage call", async () => {
  const db = { query() { throw new Error("unexpected database access"); } };
  const jobs = createP02MediaJobs(db, "synthetic-owner");
  assert.equal(await jobs.current("synthetic-other", randomUUID()), null);
  const claim = { identity: { ownerId: "synthetic-other" } };
  assert.throws(() => jobs.fail(claim, "timeout", null), /foreign claim/);
  assert.throws(() => jobs.supersede(claim), /foreign claim/);
  await assert.rejects(createP02MediaObjects(db, "synthetic-owner", {}).readOriginal(claim.identity, signal()), /foreign original/);
  assert.throws(() => createP02MediaJobs(db, ""), /invalid owner/);
});

describe("P06 adapter on P02 PostgreSQL transactions", { skip: process.env.TEST_DATABASE_URL === undefined }, () => {
  let pool;
  let scratch;
  const schema = `media_adapter_${randomUUID().replaceAll("-", "")}`;
  before(async () => {
    const { Pool } = createRequire(new URL("../../../packages/editor-store/package.json", import.meta.url))("pg");
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try { await applyMigrations(client, defaultMigrationsDir); } finally { client.release(); }
    scratch = await mkdtemp(join(tmpdir(), "media-adapter-test-"));
  });
  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    await rm(scratch, { recursive: true, force: true });
  });
  async function fixture() {
    const owner = `synthetic-media-adapter-${randomUUID()}`;
    const reserved = await reservePhotoUpload(pool, owner, { operation: "original", sizeBytes: png.length, sha256: hash(png), contentType: "image/png", fileName: "synthetic.png", format: "png", ...mutation() });
    assert.equal(reserved.status, "created");
    const upload = await claimPhotoUploadVerification(pool, owner, reserved.upload.id);
    const key = `photo/final/${randomUUID()}/${randomUUID()}`;
    const complete = await completePhotoUpload(pool, owner, upload.id, { leaseGeneration: upload.leaseGeneration, sha256: hash(png), sizeBytes: png.length, contentType: "image/png", format: "png", width: 1, height: 1, objectKey: key, objectGeneration: "1" });
    const job = await enqueuePhotoMediaJob(pool, owner, complete.photoId, spec);
    const stored = new Map([[key, { object: { key, generation: "1", sizeBytes: png.length, contentType: "image/png" }, bytes: png }]]);
    let generation = 1;
    const events = [];
    const storage = {
      async read(object, abort) {
        abort.throwIfAborted();
        const found = stored.get(object.key);
        assert.equal(found.object.generation, object.generation);
        return (async function* () { yield found.bytes; })();
      },
      async create(input, abort) {
        abort.throwIfAborted();
        assert.equal(input.ifGenerationMatch, 0);
        assert.equal(stored.has(input.key), false);
        const ledger = await pool.query("SELECT state FROM photo_media_candidates WHERE owner=$1 AND object_key=$2", [owner, input.key]);
        assert.equal(ledger.rows[0].state, "allocated");
        events.push("allocated-before-create");
        const chunks = [];
        for await (const chunk of input.bytes) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        const object = { key: input.key, generation: String(++generation), sizeBytes: bytes.length, contentType: input.contentType };
        stored.set(input.key, { object, bytes });
        return { generation: object.generation, sizeBytes: object.sizeBytes, contentType: object.contentType };
      },
    };
    const jobs = createP02MediaJobs(pool, owner);
    const objects = createP02MediaObjects(pool, owner, storage);
    const path = join(scratch, randomUUID());
    await writeFile(path, png);
    const input = { path, kind: "thumbnail", sha256: hash(png), sizeBytes: png.length, contentType: "image/png", width: 1, height: 1 };
    return { owner, photoId: complete.photoId, job, jobs, objects, storage, stored, events, input };
  }

  it("accepts the P02 canonical key and publishes separate derivatives through the executor", async () => {
    const f = await fixture();
    const source = await f.jobs.current(f.owner, f.photoId);
    assert.equal(mediaJobKey(mediaIdentity(source)), f.job.key);
    const provider = {
      renderer: { ...MEDIA_BASELINE, settingsVersions: [1], engines: ["niho-14"], features: [], maskKinds: [], maskSurfaces: false },
      acceptedFormats: ["png"], supports: () => true,
      async render({ scratchDirectory }) {
        const outputs = [];
        for (const kind of ["thumbnail", "preview"]) {
          const path = join(scratchDirectory, `${kind}.png`);
          await writeFile(path, png);
          outputs.push({ kind, path, width: 1, height: 1, contentType: "image/png" });
        }
        return outputs;
      },
      async inspect() { return { width: 1, height: 1, contentType: "image/png", orientationApplied: true, colorSpace: "srgb", privateMetadataRemoved: true }; },
    };
    let publishedClaim;
    const claim = f.jobs.claim;
    f.jobs.claim = async (id) => { publishedClaim = await claim(id); return publishedClaim; };
    const execute = createMediaExecutor({ jobs: f.jobs, objects: f.objects, provider, scratchRoot: scratch });
    assert.equal(await execute(f.job.id), "published");
    const ready = await getPhotoSnapshot(pool, f.owner, f.photoId);
    assert.equal(ready.media.state, "ready");
    assert.equal(ready.media.assets.length, 2);
    assert.notEqual(ready.media.ready.thumbnailId, ready.media.ready.previewId);
    assert.deepEqual(f.events, ["allocated-before-create", "allocated-before-create"]);
    // A caller uncertain about the publish response cannot abandon referenced generations.
    await f.objects.abandon(publishedClaim, []);
    assert.deepEqual(await listPhotoMediaCandidateCleanup(pool, f.owner), []);
  });

  it("records known generations before rejecting wrong metadata or committed bytes", async () => {
    for (const mode of ["metadata", "bytes", "source", "unconsumed"]) {
      const f = await fixture();
      const claim = await f.jobs.claim(f.job.id);
      const create = f.storage.create;
      f.storage.create = async (input, abort) => {
        if (mode === "unconsumed") return { generation: "999", sizeBytes: input.sizeBytes, contentType: input.contentType };
        const object = await create(input, abort);
        if (mode === "metadata") return { ...object, sizeBytes: object.sizeBytes + 1 };
        if (mode === "bytes") f.stored.get(input.key).bytes = Buffer.from("corrupted");
        return object;
      };
      if (mode === "source") await writeFile(f.input.path, Buffer.from("modified"));
      await assert.rejects(f.objects.stage(claim, f.input, signal()));
      const cleanup = await listPhotoMediaCandidateCleanup(pool, f.owner);
      assert.equal(cleanup.length, 1);
      assert.equal(cleanup[0].state, "abandoned");
      assert.ok(cleanup[0].objectGeneration);
      assert.equal((await getPhotoSnapshot(pool, f.owner, f.photoId)).media.assets.length, 0);
    }
  });

  it("pins ledger and readback to the allocated key without accepting a create response locator", async () => {
    const f = await fixture(), claim = await f.jobs.claim(f.job.id), create = f.storage.create, read = f.storage.read;
    let allocatedKey;
    f.storage.create = async (input, abort) => {
      allocatedKey = input.key;
      // Extra fields from a nonconforming JS backend cannot redirect the pinned locator.
      return { ...await create(input, abort), key: `photo/final/${randomUUID()}/${randomUUID()}` };
    };
    f.storage.read = async (object, abort) => {
      assert.equal(object.key, allocatedKey);
      return read(object, abort);
    };
    const staged = await f.objects.stage(claim, f.input, signal());
    await f.objects.abandon(claim, []);
    const cleanup = await listPhotoMediaCandidateCleanup(pool, f.owner);
    assert.equal(cleanup[0].objectKey, allocatedKey);
    assert.equal(cleanup[0].objectGeneration, staged.generation);
    assert.equal(f.stored.has(cleanup[0].objectKey), true);
  });

  it("retains an allocated cleanup record when create succeeds but its response is lost", async () => {
    const f = await fixture(), claim = await f.jobs.claim(f.job.id), create = f.storage.create;
    f.storage.create = async (input, abort) => { await create(input, abort); throw new Error("synthetic response loss"); };
    await assert.rejects(f.objects.stage(claim, f.input, signal()));
    const cleanup = await listPhotoMediaCandidateCleanup(pool, f.owner);
    assert.equal(cleanup.length, 1);
    assert.equal(cleanup[0].objectGeneration, null);
    assert.equal(f.stored.has(cleanup[0].objectKey), true);
    await f.objects.abandon(claim, []);
    assert.equal(f.stored.has(cleanup[0].objectKey), true);
  });

  it("ledgers a known generation even if create returns after cancellation", async () => {
    const f = await fixture(), claim = await f.jobs.claim(f.job.id), create = f.storage.create;
    const controller = new AbortController();
    f.storage.create = async (input, abort) => {
      const object = await create(input, abort);
      controller.abort();
      return object;
    };
    await assert.rejects(f.objects.stage(claim, f.input, controller.signal));
    const cleanup = await listPhotoMediaCandidateCleanup(pool, f.owner);
    assert.equal(cleanup.length, 1);
    assert.ok(cleanup[0].objectGeneration);
  });

  it("fences a trash racing with object creation and preserves its known generation for cleanup", async () => {
    const f = await fixture(), claim = await f.jobs.claim(f.job.id), create = f.storage.create;
    f.storage.create = async (input, abort) => {
      const object = await create(input, abort);
      await trashPhoto(pool, f.owner, f.photoId, mutation());
      return object;
    };
    await assert.rejects(f.objects.stage(claim, f.input, signal()));
    const cleanup = await listPhotoMediaCandidateCleanup(pool, f.owner);
    assert.equal(cleanup.length, 1);
    assert.ok(cleanup[0].objectGeneration);
    await assert.rejects(f.objects.readOriginal(claim.identity, signal()));
  });

  it("maps cancellation retries and decoder terminal failure to P02's accepted attempt policy", async () => {
    const cancelled = await fixture(), claim = await cancelled.jobs.claim(cancelled.job.id);
    assert.equal(await cancelled.jobs.fail(claim, "cancelled", Date.now() + 1000), true);
    assert.equal((await getPhotoSnapshot(pool, cancelled.owner, cancelled.photoId)).media.state, "queued");
    const failed = await fixture(), failedClaim = await failed.jobs.claim(failed.job.id);
    assert.equal(await failed.jobs.fail(failedClaim, "decoder_failed", Date.now() + 1000), true);
    assert.equal((await getPhotoSnapshot(pool, failed.owner, failed.photoId)).media.errorCode, "decoder_failed");
  });
});
