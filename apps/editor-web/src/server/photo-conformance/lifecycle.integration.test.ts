// @vitest-environment node
import { randomUUID } from "node:crypto";
import { getPhotoUsage } from "@niho/editor-store";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Photo, VerifiedPhotoActor } from "../../../../../packages/photo-library-contract/src/v1";
import { createPhotoLifecycleRoutes } from "../photo-lifecycle/routes";
import { createPhotoLifecycleStore } from "../photo-lifecycle/store-adapter";
import {
  CONFORMANCE_ORIGIN,
  SYNTHETIC_JPEG,
  actor,
  conformanceDatabaseUrl,
  createConformanceHarness,
  openConformanceDatabase,
  originalRequest,
  post,
  startAndStage,
} from "./harness";

const databaseUrl = conformanceDatabaseUrl();
const databaseDescribe = databaseUrl ? describe : describe.skip;
const owner = (label: string) => `synthetic-lifecycle-${label}-${randomUUID()}`;
const key = () => `synthetic_lifecycle_${randomUUID().replaceAll("-", "")}`;

type LifecycleEnvelope = {
  readonly value: Photo;
  readonly replayed: boolean;
  readonly error: { readonly code: string };
};

function request(method: "GET" | "POST", path: string, input: {
  readonly idempotencyKey?: string;
  readonly origin?: string | null;
} = {}): Request {
  const headers = new Headers();
  if (input.idempotencyKey) headers.set("idempotency-key", input.idempotencyKey);
  if (input.origin !== null) headers.set("origin", input.origin ?? CONFORMANCE_ORIGIN);
  return new Request(`${CONFORMANCE_ORIGIN}/api/photo/v1/${path}`, { method, headers });
}

function routes(pool: Pool, user: string, transport: VerifiedPhotoActor["transport"] = "browser-session") {
  return createPhotoLifecycleRoutes({
    lifecycle: () => ({ store: createPhotoLifecycleStore(pool) }),
    verify: async () => actor(user, transport),
    origins: [CONFORMANCE_ORIGIN],
  });
}

async function seed(pool: Pool, user: string): Promise<Photo> {
  const harness = createConformanceHarness(pool);
  const staged = await startAndStage(harness, user, originalRequest(), SYNTHETIC_JPEG);
  const response = await harness.api.complete(post(), actor(user), staged.uploadId);
  expect(response.status).toBe(200);
  return (await response.json() as { value: { result: { photo: Photo } } }).value.result.photo;
}

async function lifecycleState(pool: Pool, user: string, photoId: string) {
  const photo = (await pool.query<{
    lifecycle: string;
    lifecycle_epoch: string;
    trashed_at: Date | null;
    purge_after: Date | null;
  }>(
    `SELECT lifecycle, lifecycle_epoch::text AS lifecycle_epoch, trashed_at, purge_after
       FROM photos WHERE owner = $1 AND id = $2`,
    [user, photoId],
  )).rows[0];
  const mutations = (await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM photo_mutations WHERE owner = $1 AND photo_id = $2",
    [user, photoId],
  )).rows[0]!.count;
  return { photo, mutations, usage: await getPhotoUsage(pool, user) };
}

databaseDescribe("P12 lifecycle routes + production PostgreSQL adapter", () => {
  let pool: Pool;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => { ({ pool, close } = await openConformanceDatabase(databaseUrl!)); });
  afterAll(async () => { await close?.(); });

  it("cookie-origin: 本番trash routeはbrowserのmissing/untrusted OriginとMacの未許可Originを副作用前に拒否する", async () => {
    const user = owner("origin");
    const photo = await seed(pool, user);
    const before = await lifecycleState(pool, user, photo.id);

    const missing = await routes(pool, user).trash(request("POST", `photos/${photo.id}/trash`, {
      idempotencyKey: key(), origin: null,
    }), photo.id);
    const untrusted = await routes(pool, user).trash(request("POST", `photos/${photo.id}/trash`, {
      idempotencyKey: key(), origin: "https://untrusted.example.test",
    }), photo.id);
    const macUntrusted = await routes(pool, user, "mac-bearer").trash(request("POST", `photos/${photo.id}/trash`, {
      idempotencyKey: key(), origin: "https://untrusted.example.test",
    }), photo.id);

    for (const response of [missing, untrusted, macUntrusted]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "origin_rejected" } });
    }
    expect(await lifecycleState(pool, user, photo.id)).toEqual(before);

    const allowed = await routes(pool, user).trash(request("POST", `photos/${photo.id}/trash`, {
      idempotencyKey: key(),
    }), photo.id);
    expect(allowed.status).toBe(200);
    expect((await allowed.json() as LifecycleEnvelope).value.lifecycle).toBe("trashed");
  });

  it("trash-retains-quota: 実uploadのphotoをtrash/restoreしてquotaを保持し、同一keyだけをreplayする", async () => {
    const user = owner("trash-quota");
    const photo = await seed(pool, user);
    const lifecycle = routes(pool, user);
    const before = await getPhotoUsage(pool, user);
    const trashKey = key();

    const trashed = await lifecycle.trash(request("POST", `photos/${photo.id}/trash`, {
      idempotencyKey: trashKey,
    }), photo.id);
    expect(trashed.status).toBe(200);
    const trashedBody = await trashed.json() as LifecycleEnvelope;
    expect(trashedBody).toMatchObject({ replayed: false, value: { lifecycle: "trashed" } });
    expect(trashedBody.value.trashedAt).not.toBeNull();
    expect(trashedBody.value.purgeAfter).not.toBeNull();
    expect(Date.parse(trashedBody.value.purgeAfter!) - Date.parse(trashedBody.value.trashedAt!))
      .toBeGreaterThanOrEqual(30 * 24 * 60 * 60_000 - 1_000);
    expect(await getPhotoUsage(pool, user)).toMatchObject({
      usedBytes: before.usedBytes,
      originalBytes: before.originalBytes,
      trashBytes: before.usedBytes,
    });
    expect((await pool.query(
      "SELECT 1 FROM photos WHERE owner = $1 AND id = $2 AND lifecycle = 'active'",
      [user, photo.id],
    )).rowCount).toBe(0);

    const replay = await lifecycle.trash(request("POST", `photos/${photo.id}/trash`, {
      idempotencyKey: trashKey,
    }), photo.id);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, value: { lifecycle: "trashed" } });
    const duplicate = await lifecycle.trash(request("POST", `photos/${photo.id}/trash`, {
      idempotencyKey: key(),
    }), photo.id);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: "photo_trashed" } });

    const restoreKey = key();
    const restored = await lifecycle.restore(request("POST", `photos/${photo.id}/restore`, {
      idempotencyKey: restoreKey,
    }), photo.id);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ replayed: false, value: { lifecycle: "active" } });
    const restoreReplay = await lifecycle.restore(request("POST", `photos/${photo.id}/restore`, {
      idempotencyKey: restoreKey,
    }), photo.id);
    expect(restoreReplay.status).toBe(200);
    expect(await restoreReplay.json()).toMatchObject({ replayed: true, value: { lifecycle: "active" } });
    expect(await getPhotoUsage(pool, user)).toMatchObject({
      usedBytes: before.usedBytes,
      originalBytes: before.originalBytes,
      trashBytes: 0,
      pendingPurgeBytes: 0,
    });
  });

  it("pending-purge-retains-quota / restore-after-purge: 202 receiptはdelete確認前のbytesを保持しrestoreで復活しない", async () => {
    const user = owner("pending-purge");
    const photo = await seed(pool, user);
    const lifecycle = routes(pool, user);
    const initial = await getPhotoUsage(pool, user);

    expect((await lifecycle.trash(request("POST", `photos/${photo.id}/trash`, {
      idempotencyKey: key(),
    }), photo.id)).status).toBe(200);
    const purgeKey = key();
    const purge = await lifecycle.purge(request("POST", `photos/${photo.id}/purge`, {
      idempotencyKey: purgeKey,
    }), photo.id);
    expect(purge.status).toBe(202);
    const receipt = await purge.json() as { value: { id: string; state: string; pendingBytes: number }; replayed: boolean };
    expect(receipt).toMatchObject({ replayed: false, value: { state: "queued", pendingBytes: initial.usedBytes } });
    const pending = await getPhotoUsage(pool, user);
    expect(pending).toMatchObject({
      usedBytes: initial.usedBytes,
      originalBytes: initial.originalBytes,
      trashBytes: 0,
      pendingPurgeBytes: initial.usedBytes,
    });
    expect((await pool.query<{ lifecycle: string }>(
      "SELECT lifecycle FROM photos WHERE owner = $1 AND id = $2",
      [user, photo.id],
    )).rows[0]?.lifecycle).toBe("purging");
    expect((await pool.query<{ deletion_state: string }>(
      "SELECT deletion_state FROM photo_assets WHERE owner = $1 AND photo_id = $2",
      [user, photo.id],
    )).rows.every((row) => row.deletion_state === "pending")).toBe(true);

    const purgeReplay = await lifecycle.purge(request("POST", `photos/${photo.id}/purge`, {
      idempotencyKey: purgeKey,
    }), photo.id);
    expect(purgeReplay.status).toBe(202);
    expect(await purgeReplay.json()).toMatchObject({ replayed: true, value: { id: receipt.value.id } });

    const restore = await lifecycle.restore(request("POST", `photos/${photo.id}/restore`, {
      idempotencyKey: key(),
    }), photo.id);
    expect(restore.status).toBe(404);
    expect(await restore.json()).toMatchObject({ error: { code: "not_found" } });
    expect(await getPhotoUsage(pool, user)).toEqual(pending);
    expect((await pool.query(
      "SELECT 1 FROM photos WHERE owner = $1 AND id = $2 AND lifecycle = 'active'",
      [user, photo.id],
    )).rowCount).toBe(0);
  });

  it("foreign-purge-job: Bにはowner Aのjobをmissingと同じ404にし、Aには公開receiptだけを返す", async () => {
    const user = owner("job-a");
    const foreign = owner("job-b");
    const photo = await seed(pool, user);
    const own = routes(pool, user);
    expect((await own.trash(request("POST", `photos/${photo.id}/trash`, {
      idempotencyKey: key(),
    }), photo.id)).status).toBe(200);
    const purge = await own.purge(request("POST", `photos/${photo.id}/purge`, {
      idempotencyKey: key(),
    }), photo.id);
    const jobId = (await purge.json() as { value: { id: string } }).value.id;
    const before = await lifecycleState(pool, user, photo.id);

    const foreignResponse = await routes(pool, foreign).job(request("GET", `jobs/${jobId}`, { origin: null }), jobId);
    const missingJobId = randomUUID();
    const missingResponse = await routes(pool, foreign).job(request("GET", `jobs/${missingJobId}`, { origin: null }), missingJobId);
    expect(foreignResponse.status).toBe(404);
    expect(missingResponse.status).toBe(404);
    const foreignBody = await foreignResponse.json() as { error: Record<string, unknown> };
    const missingBody = await missingResponse.json() as { error: Record<string, unknown> };
    expect(foreignBody).toMatchObject({ error: { code: "not_found", retryable: false } });
    expect(missingBody).toMatchObject({ error: { code: "not_found", retryable: false } });
    expect(Object.keys(foreignBody.error).sort()).toEqual(Object.keys(missingBody.error).sort());
    expect(JSON.stringify(foreignBody)).not.toMatch(/snapshot|object|generation|photo\/final|path/i);
    expect(await lifecycleState(pool, user, photo.id)).toEqual(before);

    const ownResponse = await own.job(request("GET", `jobs/${jobId}`, { origin: null }), jobId);
    expect(ownResponse.status).toBe(200);
    expect(await ownResponse.json()).toEqual({ id: jobId, state: "queued", pendingBytes: SYNTHETIC_JPEG.length });
  });
});
