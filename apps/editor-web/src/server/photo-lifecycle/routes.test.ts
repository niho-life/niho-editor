import { describe, expect, it, vi } from "vitest";
import { IDS, readyPhoto, trashedPhoto } from "../../../../../packages/photo-library-contract/fixtures/v1";
import { PhotoAuthError } from "../photo-auth";
import type { PhotoLifecycleDeps, PhotoLifecycleStore } from "./types";
import { createPhotoLifecycleRoutes } from "./routes";

const KEY = "synthetic_lifecycle_key_01";
const ACTOR = { userId: IDS.userA, sessionId: "synthetic-session", transport: "browser-session" as const, expiresAt: "2026-11-02T00:00:00.000Z" };
const MAC_ACTOR = { userId: IDS.userA, sessionId: "synthetic-mac", transport: "mac-bearer" as const, expiresAt: "2026-11-02T00:00:00.000Z" };
const ORIGIN = "https://editor.niho.life";
const purgeJob = { id: IDS.job, state: "queued" as const, pendingBytes: readyPhoto.original.sizeBytes };

function arrange(actor: typeof ACTOR | typeof MAC_ACTOR = ACTOR) {
  const store: PhotoLifecycleStore = {
    trash: vi.fn(async () => ({ photo: trashedPhoto, replayed: false })),
    restore: vi.fn(async () => ({ photo: readyPhoto, replayed: false })),
    purge: vi.fn(async () => ({ job: purgeJob, replayed: false })),
    photo: vi.fn(async () => readyPhoto),
    job: vi.fn(async () => purgeJob),
  };
  const deps: PhotoLifecycleDeps = { store };
  const verify = vi.fn(async () => actor);
  const routes = createPhotoLifecycleRoutes({ lifecycle: () => deps, verify, origins: [ORIGIN], now: () => Date.parse("2026-11-01T12:00:00.000Z") });
  return { routes, store, verify };
}

function request(method: "GET" | "POST", path: string, options: { body?: string; query?: string; key?: string; origin?: string | null } = {}): Request {
  const url = `https://editor.niho.life${path}${options.query ?? ""}`;
  const headers = new Headers();
  if (method === "POST") {
    if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
    if (options.key !== undefined) headers.set("idempotency-key", options.key);
    if (options.body !== undefined) headers.set("content-type", "application/json");
  }
  return new Request(url, { method, headers, ...(options.body === undefined ? {} : { body: options.body }) });
}

describe("photo lifecycle HTTP routes", () => {
  it("authenticates per request and returns the private trash receipt", async () => {
    const f = arrange();
    const response = await f.routes.trash(request("POST", "/api/photo/v1/photos/photo/trash", { key: KEY }), IDS.photo);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.json()).value.lifecycle).toBe("trashed");
    expect(f.verify).toHaveBeenCalledOnce();
    expect(f.store.trash).toHaveBeenCalledWith(IDS.userA, IDS.photo, expect.objectContaining({ idempotencyKey: KEY }));
  });

  it("returns 202 for a queued purge receipt and never reports deletion itself", async () => {
    const f = arrange();
    const response = await f.routes.purge(request("POST", "/api/photo/v1/photos/photo/purge", { key: KEY }), IDS.photo);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ value: { state: "queued", pendingBytes: purgeJob.pendingBytes } });
  });

  it("rejects mutation bodies and missing idempotency keys", async () => {
    const f = arrange();
    const withBody = await f.routes.restore(request("POST", "/api/photo/v1/photos/photo/restore", { key: KEY, body: "{}" }), IDS.photo);
    expect(withBody.status).toBe(400);
    const withoutKey = await f.routes.trash(request("POST", "/api/photo/v1/photos/photo/trash"), IDS.photo);
    expect(withoutKey.status).toBe(400);
    expect(f.store.restore).not.toHaveBeenCalled();
    expect(f.store.trash).not.toHaveBeenCalled();
  });

  it("allows a non-null empty request stream", async () => {
    const f = arrange();
    const emptyStream = request("POST", "/api/photo/v1/photos/photo/trash", { key: KEY, body: "" });
    expect(emptyStream.body).not.toBeNull();
    const response = await f.routes.trash(emptyStream, IDS.photo);
    expect(response.status).toBe(200);
    expect(f.store.trash).toHaveBeenCalledOnce();
  });

  it("checks a Mac bearer Origin against the canonical allowlist when present", async () => {
    const f = arrange(MAC_ACTOR);
    const allowed = await f.routes.trash(request("POST", "/api/photo/v1/photos/photo/trash", { key: KEY }), IDS.photo);
    expect(allowed.status).toBe(200);

    const rejected = await f.routes.restore(request("POST", "/api/photo/v1/photos/photo/restore", {
      key: KEY,
      origin: "https://attacker.invalid",
    }), IDS.photo);
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ error: { code: "origin_rejected" } });
    expect(f.store.restore).not.toHaveBeenCalled();
  });

  it("allows a Mac bearer without an Origin header", async () => {
    const f = arrange(MAC_ACTOR);
    const response = await f.routes.trash(request("POST", "/api/photo/v1/photos/photo/trash", {
      key: KEY,
      origin: null,
    }), IDS.photo);
    expect(response.status).toBe(200);
  });

  it("scopes job lookup to the verified owner and rejects query parameters", async () => {
    const f = arrange();
    const response = await f.routes.job(request("GET", "/api/photo/v1/jobs/job"), IDS.job);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(purgeJob);
    expect(f.store.job).toHaveBeenCalledWith(IDS.userA, IDS.job);
    const query = await f.routes.job(request("GET", "/api/photo/v1/jobs/job", { query: "?owner=other" }), IDS.job);
    expect(query.status).toBe(400);
  });

  it("fails closed after authentication when the purge runtime is absent", async () => {
    const verify = vi.fn(async () => ACTOR);
    const lifecycle = vi.fn(() => null);
    const routes = createPhotoLifecycleRoutes({ verify, lifecycle, origins: [ORIGIN] });
    const response = await routes.purge(request("POST", "/api/photo/v1/photos/photo/purge", { key: KEY }), IDS.photo);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(verify).toHaveBeenCalledOnce();
    expect(lifecycle).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({ error: { code: "temporarily_unavailable", retryable: true } });
  });

  it("maps P01 denial to the public error envelope", async () => {
    const routes = createPhotoLifecycleRoutes({
      lifecycle: () => null,
      verify: async () => { throw new PhotoAuthError(403, "origin_rejected"); },
      origins: [],
    });
    const response = await routes.restore(request("POST", "/api/photo/v1/photos/photo/restore", { key: KEY }), IDS.photo);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "origin_rejected" } });
  });
});
