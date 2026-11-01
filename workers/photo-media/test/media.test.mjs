import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { IDS, recipe } from "../../../packages/photo-library-contract/fixtures/v1.ts";
import { MEDIA_BASELINE, verifyPinnedArtifact } from "../src/baseline.ts";
import { matchesSource, mediaIdentity, mediaJobKey } from "../src/identity.ts";
import { createMediaExecutor } from "../src/run.ts";
import { MediaProviderError } from "../src/types.ts";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
// A valid synthetic 1x1 PNG. Used as opaque original/output bytes for orchestration tests;
// the fake provider below does not establish decoder, color or SDK acceptance.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH2kAAAAASUVORK5CYII=", "base64");
const renderer = { ...MEDIA_BASELINE, settingsVersions: [1], engines: ["niho-14"], features: [], maskKinds: [], maskSurfaces: false };

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "photo-media-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = {
    source: {
      ownerId: IDS.userA, photoId: IDS.photo, lifecycle: "active", lifecycleGeneration: 1,
      original: { assetId: IDS.original, generation: "11", sha256: sha(png), sizeBytes: png.length },
      format: "png", width: 1, height: 1, baseVersion: null, recipe: structuredClone(recipe),
    },
    generation: 1, claimed: false, published: null, failures: [], staged: [], abandoned: [], superseded: [], reads: 0,
  };
  const jobs = {
    async claim(jobId) {
      if (state.claimed) return null;
      state.claimed = true;
      const identity = mediaIdentity(state.source);
      return { jobId, key: mediaJobKey(identity), identity, generation: state.generation, attempt: options.attempt ?? 1, expiresAt: Date.now() + (options.leaseMs ?? 10_000) };
    },
    async current(owner, photo) { return owner === state.source.ownerId && photo === state.source.photoId ? structuredClone(state.source) : null; },
    async publish(claim, media, objects, deadlineAt) {
      options.beforePublish?.(state);
      if (claim.generation !== state.generation || Date.now() >= Math.min(claim.expiresAt, deadlineAt) || !matchesSource(claim.identity, state.source)) return false;
      state.published = { media, objects }; return true;
    },
    async supersede(claim) {
      if (claim.generation !== state.generation) return false;
      state.superseded.push(claim.generation); return true;
    },
    async fail(claim, code, retryAt) {
      if (claim.generation !== state.generation || state.published || !matchesSource(claim.identity, state.source)) return false;
      state.failures.push({ code, retryAt }); return true;
    },
  };
  const objects = {
    async readOriginal(identity, signal) {
      state.reads++;
      assert.equal(identity.original.generation, "11");
      return (async function* () { if (signal.aborted) throw signal.reason; yield options.input ?? png; })();
    },
    async stage(claim, input, signal) {
      assert.equal(signal.aborted, false);
      assert.equal(sha(await readFile(input.path)), input.sha256);
      state.staged.push(input);
      options.afterStage?.(state);
      return { id: state.staged.length === 1 ? IDS.thumbnail : state.staged.length === 2 ? IDS.preview : IDS.mask, generation: options.invalidGeneration ? 101 : String(100 + state.staged.length) };
    },
    async abandon(_claim, objects) { state.abandoned.push(...objects); },
  };
  const provider = {
    renderer: structuredClone(renderer), acceptedFormats: ["png", "jpeg", "raw"], supports: () => true,
    async render(input) {
      assert.deepEqual(await readFile(input.originalPath), options.input ?? png);
      await options.render?.(state, input);
      const result = [];
      for (const kind of options.kinds ?? ["thumbnail", "preview"]) {
        const path = join(input.scratchDirectory, `${kind}.png`);
        await writeFile(path, png);
        result.push({ kind, path, width: 1, height: 1, contentType: "image/png", ...(kind === "working-copy" ? { workingCopy: { baseVersion: state.source.baseVersion, encoding: "png16", meta: { kind: "raw" } } } : {}) });
      }
      return options.outputs ? options.outputs(result, input) : result;
    },
    async inspect(output) {
      return { width: output.width, height: output.height, contentType: output.contentType, orientationApplied: true, colorSpace: output.kind === "working-copy" ? "canonical-working-copy" : "srgb", privateMetadataRemoved: options.metadataSafe ?? true, workingCopyCompatible: true };
    },
  };
  const execute = createMediaExecutor({ jobs, objects, provider: options.noProvider ? null : provider, scratchRoot: root, timeoutMs: options.timeoutMs ?? 5000, concurrency: options.concurrency ?? 1 });
  return { state, execute, provider, root, jobs, objects };
}

test("job key binds owner, immutable original, base, lifecycle, recipe and renderer", () => {
  const source = { ownerId: IDS.userA, photoId: IDS.photo, lifecycle: "active", lifecycleGeneration: 1, original: { assetId: IDS.original, generation: "11", sha256: sha(png), sizeBytes: png.length }, format: "png", width: 1, height: 1, baseVersion: null, recipe: structuredClone(recipe) };
  const identity = mediaIdentity(source);
  for (const changed of [
    { ...identity, ownerId: IDS.userB }, { ...identity, lifecycleGeneration: 2 },
    { ...identity, original: { ...identity.original, generation: "12" } },
    { ...identity, original: { ...identity.original, sha256: "c".repeat(64) } },
    { ...identity, baseVersion: "base-2" }, { ...identity, recipeRevision: 1 },
    { ...identity, settingsSha256: "d".repeat(64) }, { ...identity, rendererManifestSha256: "e".repeat(64) },
  ]) assert.notEqual(mediaJobKey(identity), mediaJobKey(changed));
  assert.equal(matchesSource(identity, { ...source, lifecycle: "trashed" }), false);
});

test("publishes distinct immutable derivatives and removes scratch files", async (t) => {
  const { execute, state, root } = await fixture(t);
  assert.equal(await execute(IDS.job), "published");
  assert.equal(state.published.media.recipeRevision, 0);
  assert.notEqual(state.published.media.thumbnail.id, state.published.media.preview.id);
  assert.equal(state.published.media.workingCopy, null);
  assert.deepEqual(state.published.objects.map((entry) => entry.generation), ["101", "102"]);
  assert.equal(state.abandoned.length, 0);
  assert.deepEqual(await readdir(root), []);
  assert.equal(await execute(IDS.job), "not_claimed");
});

test("uninstalled or old renderer and unknown settings fail closed before reading original", async (t) => {
  for (const mode of ["missing", "old", "settings", "format"]) {
    const { execute, state, provider } = await fixture(t, { noProvider: mode === "missing" });
    if (mode === "old") provider.renderer.manifestSha256 = "a".repeat(64);
    if (mode === "settings") state.source.recipe.settings.v = 999;
    if (mode === "format") state.source.format = "heic";
    assert.equal(await execute(IDS.job), mode === "settings" ? "unsupported_settings" : "renderer_unavailable");
    assert.equal(state.reads, 0);
    assert.equal(state.published, null);
  }
});

test("original checksum or length mismatch prevents decode and releases scratch", async (t) => {
  for (const input of [Buffer.from("invalid"), Buffer.concat([png, Buffer.from("x")])]) {
    let rendered = false;
    const { execute, state, root } = await fixture(t, { input, render: () => { rendered = true; } });
    assert.equal(await execute(IDS.job), "original_changed");
    assert.equal(rendered, false);
    assert.equal(state.staged.length, 0);
    assert.deepEqual(await readdir(root), []);
  }
});

test("recipe/lifecycle changed during render cannot stage or publish output", async (t) => {
  for (const change of [state => { state.source.recipe.revision++; }, state => { state.source.lifecycle = "trashed"; state.source.lifecycleGeneration++; }, state => { state.source.original.generation = "12"; }]) {
    const { execute, state } = await fixture(t, { render: change });
    assert.equal(await execute(IDS.job), "stale");
    assert.equal(state.staged.length, 0);
    assert.equal(state.published, null);
    assert.deepEqual(state.superseded, [1]);
  }
  const initial = await fixture(t);
  initial.jobs.current = async () => ({ ...structuredClone(initial.state.source), lifecycle: "trashed" });
  assert.equal(await initial.execute(IDS.job), "stale");
  assert.deepEqual(initial.state.superseded, [1]);
  assert.equal(initial.state.reads, 0);
});

test("atomic publication fence rejects deletion after staging and leaves generations for cleanup", async (t) => {
  const { execute, state } = await fixture(t, { beforePublish: state => { state.source.lifecycle = "purged"; state.source.lifecycleGeneration++; } });
  assert.equal(await execute(IDS.job), "stale");
  assert.equal(state.published, null);
  assert.equal(state.abandoned.length, 2);
  assert.deepEqual(state.superseded, [1]);
});

test("raw requires a fixed canonical base and separate working-copy metadata", async (t) => {
  const missing = await fixture(t);
  missing.state.source.format = "raw";
  assert.equal(await missing.execute(IDS.job), "unsupported_settings");
  const incomplete = await fixture(t);
  incomplete.state.source.format = "raw"; incomplete.state.source.baseVersion = "synthetic-base-1";
  assert.equal(await incomplete.execute(IDS.job), "invalid_output");
  const complete = await fixture(t, { kinds: ["thumbnail", "preview", "working-copy"] });
  complete.state.source.format = "raw"; complete.state.source.baseVersion = "synthetic-base-1";
  assert.equal(await complete.execute(IDS.job), "published");
  assert.equal(complete.state.published.media.workingCopy.baseVersion, "synthetic-base-1");
});

test("private metadata or escaped output path cannot be uploaded", async (t) => {
  const unsafe = await fixture(t, { metadataSafe: false });
  assert.equal(await unsafe.execute(IDS.job), "invalid_output");
  assert.equal(unsafe.state.staged.length, 0);
  const escaped = await fixture(t, { outputs: (outputs, input) => [{ ...outputs[0], path: join(input.scratchDirectory, "..", "outside.png") }, outputs[1]] });
  await writeFile(join(escaped.root, "outside.png"), png);
  assert.equal(await escaped.execute(IDS.job), "invalid_output");
  assert.equal(escaped.state.staged.length, 0);
});

test("working-copy metadata and derivative asset identity are validated", async (t) => {
  const invalidMeta = await fixture(t, { kinds: ["thumbnail", "preview", "working-copy"], outputs: outputs => outputs.map(output => output.kind === "working-copy" ? { ...output, workingCopy: { ...output.workingCopy, meta: null } } : output) });
  invalidMeta.state.source.format = "raw"; invalidMeta.state.source.baseVersion = "synthetic-base-1";
  assert.equal(await invalidMeta.execute(IDS.job), "invalid_output");
  assert.equal(invalidMeta.state.staged.length, 0);
  const duplicate = await fixture(t);
  const stage = duplicate.objects.stage;
  duplicate.objects.stage = async (...args) => ({ ...await stage(...args), id: IDS.thumbnail });
  assert.equal(await duplicate.execute(IDS.job), "infrastructure_unavailable");
  assert.equal(duplicate.state.published, null);
  assert.equal(duplicate.state.abandoned.length, 1);
});

test("malformed object-store generation is retryable infrastructure failure", async (t) => {
  const invalidStoreResult = await fixture(t, { invalidGeneration: true });
  assert.equal(await invalidStoreResult.execute(IDS.job), "infrastructure_unavailable");
  assert.equal(invalidStoreResult.state.published, null);
  assert.equal(invalidStoreResult.state.failures[0].code, "infrastructure_unavailable");
  assert.ok(invalidStoreResult.state.failures[0].retryAt > Date.now());
  // The stage port registered the incomplete write before returning; its durable ledger owns it.
  assert.equal(invalidStoreResult.state.staged.length, 1);
  assert.equal(invalidStoreResult.state.abandoned.length, 0);
});

test("timeout and cancellation fence late results, cap retries and clean scratch", async (t) => {
  const timed = await fixture(t, { timeoutMs: 10, render: async (_state, input) => { await delay(100, null, { signal: input.signal }); } });
  assert.equal(await timed.execute(IDS.job), "timeout");
  assert.equal(timed.state.staged.length, 0);
  assert.ok(timed.state.failures[0].retryAt > Date.now() - 100);
  assert.deepEqual(await readdir(timed.root), []);
  const finalAttempt = await fixture(t, { attempt: 3, timeoutMs: 5, render: async (_state, input) => { await delay(100, null, { signal: input.signal }); } });
  assert.equal(await finalAttempt.execute(IDS.job), "timeout");
  assert.equal(finalAttempt.state.failures[0].retryAt, null);
  const cancelled = await fixture(t, { render: async (_state, input) => { await delay(100, null, { signal: input.signal }); } });
  const abort = new AbortController();
  const running = cancelled.execute(IDS.job, abort.signal);
  setTimeout(() => abort.abort(), 5);
  assert.equal(await running, "cancelled");
  assert.ok(cancelled.state.failures[0].retryAt > Date.now());
  const fenced = await fixture(t, { render: async (state, input) => {
    state.source.lifecycle = "trashed";
    state.source.lifecycleGeneration++;
    state.generation++;
    await delay(100, null, { signal: input.signal });
  } });
  const stop = new AbortController();
  const fencedRun = fenced.execute(IDS.job, stop.signal);
  setTimeout(() => stop.abort(), 5);
  assert.equal(await fencedRun, "cancelled");
  assert.equal(fenced.state.failures.length, 0);
});

test("cancellation during a port call observes its later rejection", async (t) => {
  const current = await fixture(t);
  const abort = new AbortController();
  current.jobs.current = async () => {
    abort.abort();
    throw new Error("synthetic rejected port after cancellation");
  };
  assert.equal(await current.execute(IDS.job, abort.signal), "cancelled");
  // Node's test runner fails on an unhandled rejection; let that event run before this test ends.
  await delay(0);
  assert.equal(current.state.staged.length, 0);
  assert.equal(current.state.failures[0].code, "cancelled");
  assert.deepEqual(await readdir(current.root), []);
});

test("new lease generation is not modified by old worker failure or terminal CAS", async (t) => {
  const { execute, state } = await fixture(t, { render: state => { state.generation++; throw new MediaProviderError("decoder_failed"); } });
  assert.equal(await execute(IDS.job), "decoder_failed");
  assert.equal(state.failures.length, 0);
  assert.equal(state.published, null);
  const stale = await fixture(t, { beforePublish: state => { state.generation++; } });
  assert.equal(await stale.execute(IDS.job), "stale");
  assert.equal(stale.state.superseded.length, 0);
  assert.equal(stale.state.abandoned.length, 2);
});

test("delayed store publication cannot commit after the execution deadline", async (t) => {
  // Freeze the deadline while real file I/O stages both outputs, then expire it
  // only once publication is actually waiting. CI load must not choose the race.
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const delayed = await fixture(t, { timeoutMs: 10 });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const completed = Promise.withResolvers();
  t.after(() => release.resolve());
  const publish = delayed.jobs.publish;
  delayed.jobs.publish = async (...args) => {
    entered.resolve();
    await release.promise;
    const committed = await publish(...args);
    completed.resolve(committed);
    return committed;
  };
  const running = delayed.execute(IDS.job);
  await entered.promise;
  assert.equal(delayed.state.staged.length, 2);
  t.mock.timers.tick(11);
  assert.equal(await running, "timeout");
  release.resolve();
  assert.equal(await completed.promise, false);
  assert.equal(delayed.state.published, null);
  assert.equal(delayed.state.abandoned.length, 2);
});

test("unknown provider/storage failures use bounded infrastructure retry, never decoder failure", async (t) => {
  const unknown = await fixture(t, { render: () => { throw new Error("synthetic infrastructure exception"); } });
  assert.equal(await unknown.execute(IDS.job), "infrastructure_unavailable");
  assert.equal(unknown.state.failures[0].code, "infrastructure_unavailable");
  assert.ok(unknown.state.failures[0].retryAt > Date.now());
  const unavailable = await fixture(t, { attempt: 3 });
  unavailable.objects.readOriginal = async () => { throw new Error("synthetic storage exception"); };
  assert.equal(await unavailable.execute(IDS.job), "infrastructure_unavailable");
  assert.equal(unavailable.state.failures[0].retryAt, null);
  const failedStore = await fixture(t);
  failedStore.jobs.current = async () => { throw new Error("synthetic store exception"); };
  failedStore.jobs.fail = async () => { throw new Error("synthetic store exception"); };
  assert.equal(await failedStore.execute(IDS.job), "infrastructure_unavailable");
});

test("unknown publication result preserves a committed result for reconciliation", async (t) => {
  const uncertain = await fixture(t);
  const publish = uncertain.jobs.publish;
  uncertain.jobs.publish = async (...args) => {
    assert.equal(await publish(...args), true);
    throw new Error("synthetic lost publication response");
  };
  assert.equal(await uncertain.execute(IDS.job), "infrastructure_unavailable");
  assert.equal(uncertain.state.published.media.state, "ready");
  assert.equal(uncertain.state.failures.length, 0);
  // Candidates must be reconciled against references by the P03/P07 adapter, never directly deleted.
  assert.equal(uncertain.state.abandoned.length, 2);
});

test("per-process concurrency bound rejects extra work before claim", async (t) => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const { execute } = await fixture(t, { concurrency: 1, render: async () => waiting });
  const first = execute(IDS.job);
  await delay(10);
  assert.equal(await execute(IDS.job), "not_claimed");
  release();
  assert.equal(await first, "published");
  assert.throws(() => createMediaExecutor({ jobs: {}, objects: {}, provider: null, concurrency: 2 }), /invalid worker limits/);
});

test("release artifacts with incorrect bytes or unknown names are rejected", () => {
  assert.throws(() => verifyPinnedArtifact("manifest-0.27.0.json", Buffer.from("{}")), /pinned artifact verification failed/);
  assert.throws(() => verifyPinnedArtifact("unlisted.wasm", png), /pinned artifact verification failed/);
});
