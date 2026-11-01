// @vitest-environment node
import { randomUUID } from "node:crypto";
import {
  PHOTO_MAX_ORIGINAL_BYTES,
  PHOTO_QUOTA_BYTES,
  getPhotoAsset,
  getPhotoLibrary,
  getPhotoUpload,
  getPhotoUsage,
  markPhotoLibraryDeleting,
  trashPhoto,
} from "@niho/editor-store";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  CONFORMANCE_ORIGIN,
  SYNTHETIC_JPEG,
  SYNTHETIC_PNG,
  actor,
  conformanceDatabaseUrl,
  createConformanceHarness,
  digest,
  get,
  maskRequest,
  openConformanceDatabase,
  originalRequest,
  post,
  startAndStage,
  waitForUploadState,
} from "./harness";

const databaseUrl = conformanceDatabaseUrl();
const databaseDescribe = databaseUrl ? describe : describe.skip;
const owner = (label: string) => `synthetic-${label}-${randomUUID()}`;

type TransferBody = {
  replayed: boolean;
  value: {
    kind: string;
    ticket: unknown;
    upload: { state: string };
    result: { photo: { id: string; original: { id: string } } };
  };
  error: { code: string };
};

async function json(response: Response): Promise<TransferBody> {
  return response.json() as Promise<TransferBody>;
}

databaseDescribe("P12 PostgreSQL + P03 transfer handler conformance", () => {
  let pool: Pool;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, close } = await openConformanceDatabase(databaseUrl!));
  });

  afterAll(async () => {
    await close?.();
  });

  it("auth/schema guard: owner-in-request を拒否し、未認証と Origin 拒否を副作用前に止める", async () => {
    const harness = createConformanceHarness(pool);
    const user = owner("auth");
    const body = originalRequest();

    expect((await harness.api.start(post(body), null)).status).toBe(401);
    expect((await harness.api.start(post({ ...body, ownerId: owner("injected") }), actor(user))).status).toBe(400);
    expect((await harness.api.start(post(body, randomUUID(), "https://untrusted.example.test"), actor(user))).status).toBe(403);
    expect((await pool.query("SELECT 1 FROM photo_libraries WHERE owner = $1", [user])).rowCount).toBe(0);
  });

  it("owner-scoped content: foreign-original / revoked-content と exact generation read を区別する", async () => {
    const harness = createConformanceHarness(pool);
    const user = owner("content-a");
    const foreign = owner("content-b");
    const staged = await startAndStage(harness, user, originalRequest(), SYNTHETIC_JPEG);
    const completed = await harness.api.complete(post({}, randomUUID()), actor(user), staged.uploadId);
    expect(completed.status).toBe(200);
    const completeBody = await json(completed);
    const photo = completeBody.value.result.photo;
    const asset = await getPhotoAsset(pool, user, photo.id, photo.original.id);
    expect(asset).not.toBeNull();

    const read = vi.spyOn(harness.storage, "read");
    expect((await harness.api.content(get(), actor(foreign), photo.id, photo.original.id)).status).toBe(404);
    expect((await harness.api.content(get(), null, photo.id, photo.original.id)).status).toBe(401);
    expect(read).not.toHaveBeenCalled();

    const response = await harness.api.content(get(), actor(user), photo.id, photo.original.id);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(SYNTHETIC_JPEG);
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ generation: asset!.objectGeneration }), null, expect.any(AbortSignal));
  });

  it("owner-scoped upload mutations: foreign upload complete/cancel は同じ 404 でDB状態を変えない", async () => {
    const harness = createConformanceHarness(pool);
    const user = owner("upload-a");
    const foreign = owner("upload-b");
    const staged = await startAndStage(harness, user, originalRequest(), SYNTHETIC_JPEG);

    expect((await harness.api.complete(post({}, randomUUID()), actor(foreign), staged.uploadId)).status).toBe(404);
    expect((await harness.api.cancel(post({}, randomUUID()), actor(foreign), staged.uploadId)).status).toBe(404);
    expect((await getPhotoUpload(pool, user, staged.uploadId))?.state).toBe("reserved");
  });

  it("quota serialization: quota-boundary は成功し、同時予約は一方だけ quota-concurrent-loser になる", async () => {
    const boundaryHarness = createConformanceHarness(pool);
    const boundaryOwner = owner("quota-boundary");
    await getPhotoLibrary(pool, boundaryOwner);
    await pool.query("UPDATE photo_libraries SET used_bytes = $2, original_bytes = $2 WHERE owner = $1", [boundaryOwner, PHOTO_QUOTA_BYTES - SYNTHETIC_JPEG.length]);
    expect((await boundaryHarness.api.start(post(originalRequest()), actor(boundaryOwner))).status).toBe(201);
    expect((await getPhotoUsage(pool, boundaryOwner)).availableBytes).toBe(0);

    const concurrentHarness = createConformanceHarness(pool);
    const concurrentOwner = owner("quota-race");
    await getPhotoLibrary(pool, concurrentOwner);
    await pool.query("UPDATE photo_libraries SET used_bytes = $2, original_bytes = $2 WHERE owner = $1", [concurrentOwner, PHOTO_QUOTA_BYTES - SYNTHETIC_JPEG.length]);
    const first = originalRequest();
    const second = { ...first, sha256: "b".repeat(64), target: { ...first.target, fileName: "synthetic-b.jpg" } };
    const responses = await Promise.all([
      concurrentHarness.api.start(post(first, randomUUID()), actor(concurrentOwner)),
      concurrentHarness.api.start(post(second, randomUUID()), actor(concurrentOwner)),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect((await getPhotoUsage(pool, concurrentOwner)).reservedBytes).toBe(SYNTHETIC_JPEG.length);
  });

  it("completion replay and dedup: complete再送・same-owner existing・payload競合をDB越しに処理する", async () => {
    const harness = createConformanceHarness(pool);
    const user = owner("replay");
    const startKey = randomUUID();
    const completeKey = randomUUID();
    const body = originalRequest();
    const staged = await startAndStage(harness, user, body, SYNTHETIC_JPEG, startKey);

    const first = await harness.api.complete(post({}, completeKey), actor(user), staged.uploadId);
    expect(first.status).toBe(200);
    expect((await json(first)).replayed).toBe(false);
    const replay = await harness.api.complete(post({}, completeKey), actor(user), staged.uploadId);
    expect(replay.status).toBe(200);
    expect((await json(replay)).replayed).toBe(true);

    const existing = await harness.api.start(post(body, randomUUID()), actor(user));
    expect(existing.status).toBe(200);
    expect((await json(existing)).value.kind).toBe("existing");

    const conflictOwner = owner("idempotency");
    const conflictKey = randomUUID();
    expect((await harness.api.start(post(body, conflictKey), actor(conflictOwner))).status).toBe(201);
    expect((await harness.api.start(post({ ...body, target: { ...body.target, fileName: "changed.jpg" } }, conflictKey), actor(conflictOwner))).status).toBe(409);
  });

  it("active verification replay: complete-in-progress と start-replay-verifying は ticket を再発行しない", async () => {
    const harness = createConformanceHarness(pool);
    const user = owner("verifying");
    const key = randomUUID();
    const body = originalRequest();
    const staged = await startAndStage(harness, user, body, SYNTHETIC_JPEG, key);
    const claimed = await harness.store.claim(user, staged.uploadId);
    expect(claimed?.state).toBe("verifying");

    const complete = await harness.api.complete(post({}, randomUUID()), actor(user), staged.uploadId);
    expect(complete.status).toBe(202);
    const replay = await harness.api.start(post(body, key), actor(user));
    expect(replay.status).toBe(200);
    expect((await json(replay)).value).toMatchObject({ ticket: null, upload: { state: "verifying" } });
  });

  it("cancel versus late completion: verifying中のcancelが勝ち、late completeを409でfenceする", async () => {
    const harness = createConformanceHarness(pool);
    const user = owner("cancel-race");
    const staged = await startAndStage(harness, user, originalRequest(), SYNTHETIC_JPEG);
    let releaseProbe!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseProbe = resolve; });
    harness.setProbeImplementation(async () => {
      await blocked;
      return { format: "jpeg", contentType: "image/jpeg", width: 2, height: 1, encodedWidth: 2, encodedHeight: 1 };
    });

    const late = harness.api.complete(post({}, randomUUID()), actor(user), staged.uploadId);
    await waitForUploadState(pool, user, staged.uploadId, "verifying");
    const cancelled = await harness.api.cancel(post({}, randomUUID()), actor(user), staged.uploadId);
    expect(cancelled.status).toBe(200);
    releaseProbe();
    const completed = await late;
    expect(completed.status).toBe(409);
    expect((await json(completed)).error.code).toBe("upload_state_conflict");
    expect((await getPhotoUpload(pool, user, staged.uploadId))?.state).toBe("cancelled");
    expect((await getPhotoUsage(pool, user)).reservedBytes).toBe(0);
  });

  it("expiry fence: 期限切れuploadのcompleteを410にし、claim/copyしない", async () => {
    const harness = createConformanceHarness(pool);
    const user = owner("expiry");
    const staged = await startAndStage(harness, user, originalRequest(), SYNTHETIC_JPEG);
    await pool.query("UPDATE photo_uploads SET expires_at = clock_timestamp() - interval '1 second' WHERE owner = $1 AND id = $2", [user, staged.uploadId]);
    const copy = vi.spyOn(harness.storage, "copy");
    const response = await harness.api.complete(post({}, randomUUID()), actor(user), staged.uploadId);
    expect(response.status).toBe(410);
    expect((await json(response)).error.code).toBe("upload_expired");
    expect(copy).not.toHaveBeenCalled();
  });

  it("late lifecycle fences: trash/deleting後のlate commitとdeleting accountの新規startを拒否する", async () => {
    const trashHarness = createConformanceHarness(pool);
    const trashOwner = owner("late-trash");
    const original = await startAndStage(trashHarness, trashOwner, originalRequest(), SYNTHETIC_JPEG);
    const stored = await trashHarness.api.complete(post({}, randomUUID()), actor(trashOwner), original.uploadId);
    const photoId = (await json(stored)).value.result.photo.id as string;
    trashHarness.setProbe({ format: "png", contentType: "image/png", width: 2, height: 1, encodedWidth: 2, encodedHeight: 1, bitDepth: 8, channels: "gray" });
    const mask = await startAndStage(trashHarness, trashOwner, maskRequest(photoId), SYNTHETIC_PNG);
    let releaseMask!: () => void;
    const maskBlocked = new Promise<void>((resolve) => { releaseMask = resolve; });
    trashHarness.setProbeImplementation(async () => {
      await maskBlocked;
      return { format: "png", contentType: "image/png", width: 2, height: 1, encodedWidth: 2, encodedHeight: 1, bitDepth: 8, channels: "gray" };
    });
    const lateMask = trashHarness.api.complete(post({}, randomUUID()), actor(trashOwner), mask.uploadId);
    await waitForUploadState(pool, trashOwner, mask.uploadId, "verifying");
    await trashPhoto(pool, trashOwner, photoId, { idempotencyKey: randomUUID(), requestHash: "a".repeat(64) });
    releaseMask();
    const trashed = await lateMask;
    expect(trashed.status).toBe(409);
    expect((await json(trashed)).error.code).toBe("photo_trashed");

    const deletingHarness = createConformanceHarness(pool);
    const deletingOwner = owner("late-deleting");
    const pending = await startAndStage(deletingHarness, deletingOwner, originalRequest(), SYNTHETIC_JPEG);
    let releaseDelete!: () => void;
    const deleteBlocked = new Promise<void>((resolve) => { releaseDelete = resolve; });
    deletingHarness.setProbeImplementation(async () => {
      await deleteBlocked;
      return { format: "jpeg", contentType: "image/jpeg", width: 2, height: 1, encodedWidth: 2, encodedHeight: 1 };
    });
    const lateOriginal = deletingHarness.api.complete(post({}, randomUUID()), actor(deletingOwner), pending.uploadId);
    await waitForUploadState(pool, deletingOwner, pending.uploadId, "verifying");
    await markPhotoLibraryDeleting(pool, deletingOwner);
    releaseDelete();
    const deleted = await lateOriginal;
    expect(deleted.status).toBe(409);
    expect((await json(deleted)).error.code).toBe("account_deleting");
    expect((await deletingHarness.api.start(post(originalRequest(), randomUUID()), actor(deletingOwner))).status).toBe(409);
  });

  it("verification rejection: file/negative size と size/hash/format/pixel 不一致を区別して予約を解放する", async () => {
    const preconditionHarness = createConformanceHarness(pool);
    const preconditionOwner = owner("limits");
    const oversized = { ...originalRequest(), sizeBytes: PHOTO_MAX_ORIGINAL_BYTES + 1 };
    expect((await preconditionHarness.api.start(post(oversized), actor(preconditionOwner))).status).toBe(413);
    expect((await preconditionHarness.api.start(post({ ...originalRequest(), sizeBytes: -1 }), actor(preconditionOwner))).status).toBe(400);

    const hashHarness = createConformanceHarness(pool);
    const hashOwner = owner("hash");
    const wrongHash = { ...originalRequest(), sha256: "a".repeat(64) };
    const hashUpload = await startAndStage(hashHarness, hashOwner, wrongHash, SYNTHETIC_JPEG);
    const hashResponse = await hashHarness.api.complete(post({}, randomUUID()), actor(hashOwner), hashUpload.uploadId);
    expect(hashResponse.status).toBe(422);
    expect((await json(hashResponse)).error.code).toBe("content_rejected");
    expect((await getPhotoUpload(pool, hashOwner, hashUpload.uploadId))?.state).toBe("rejected");

    const sizeHarness = createConformanceHarness(pool);
    const sizeOwner = owner("size");
    const sizeUpload = await startAndStage(sizeHarness, sizeOwner, originalRequest(), SYNTHETIC_JPEG);
    const realStat = sizeHarness.storage.stat.bind(sizeHarness.storage);
    vi.spyOn(sizeHarness.storage, "stat").mockImplementation(async (key, generation, signal) => {
      const value = await realStat(key, generation, signal);
      return value ? { ...value, sizeBytes: value.sizeBytes + 1 } : null;
    });
    expect((await sizeHarness.api.complete(post({}, randomUUID()), actor(sizeOwner), sizeUpload.uploadId)).status).toBe(422);

    const formatHarness = createConformanceHarness(pool);
    const formatOwner = owner("format");
    const formatUpload = await startAndStage(formatHarness, formatOwner, originalRequest(), SYNTHETIC_JPEG);
    formatHarness.setProbe({ format: "png", contentType: "image/jpeg", width: 2, height: 1, encodedWidth: 2, encodedHeight: 1 });
    expect((await formatHarness.api.complete(post({}, randomUUID()), actor(formatOwner), formatUpload.uploadId)).status).toBe(422);

    const pixelHarness = createConformanceHarness(pool);
    const pixelOwner = owner("pixels");
    const pixelUpload = await startAndStage(pixelHarness, pixelOwner, originalRequest(), SYNTHETIC_JPEG);
    pixelHarness.setProbe({ format: "jpeg", contentType: "image/jpeg", width: 100_001, height: 1_000, encodedWidth: 100_001, encodedHeight: 1_000 });
    const pixels = await pixelHarness.api.complete(post({}, randomUUID()), actor(pixelOwner), pixelUpload.uploadId);
    expect(pixels.status).toBe(422);
    expect((await json(pixels)).error.code).toBe("pixel_limit_exceeded");
  });
});

describe("photo conformance database policy", () => {
  it("localではDB未設定をskipし、専用loopback fixtureだけを許可する", () => {
    const localUrl = "postgres://synthetic@127.0.0.1:56542/synthetic";

    expect(conformanceDatabaseUrl({})).toBeUndefined();
    expect(conformanceDatabaseUrl({ TEST_DATABASE_URL: localUrl })).toBe(localUrl);
    expect(CONFORMANCE_ORIGIN).toBe("https://editor.synthetic.invalid");
    expect(digest(SYNTHETIC_JPEG)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("CIではDB未設定を拒否し、正確な使い捨てfixtureだけを許可する", () => {
    const ciUrl = "postgres://editor_ci:synthetic@127.0.0.1:5432/editor_ci";

    expect(() => conformanceDatabaseUrl({ CI: "true" })).toThrow("CI requires TEST_DATABASE_URL");
    expect(conformanceDatabaseUrl({ CI: "true", TEST_DATABASE_URL: ciUrl })).toBe(ciUrl);
  });

  it.each([
    ["外部host", { TEST_DATABASE_URL: "postgres://synthetic@db.example.test:56542/synthetic" }],
    ["localからCI fixture", { TEST_DATABASE_URL: "postgres://editor_ci@127.0.0.1:5432/editor_ci" }],
    ["CIからlocal fixture", { CI: "true", TEST_DATABASE_URL: "postgres://editor_ci@127.0.0.1:56542/editor_ci" }],
    ["CIの別user", { CI: "true", TEST_DATABASE_URL: "postgres://other@127.0.0.1:5432/editor_ci" }],
    ["CIの別database", { CI: "true", TEST_DATABASE_URL: "postgres://editor_ci@127.0.0.1:5432/other" }],
    ["CIの外部host", { CI: "true", TEST_DATABASE_URL: "postgres://editor_ci@db.example.test:5432/editor_ci" }],
    ["query parameterによるhost上書き", { CI: "true", TEST_DATABASE_URL: "postgres://editor_ci@127.0.0.1:5432/editor_ci?host=db.example.test" }],
  ])("%sを拒否する", (_label, env) => {
    expect(() => conformanceDatabaseUrl(env)).toThrow("refuses a non-ephemeral database target");
  });
});
