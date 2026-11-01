// @vitest-environment node
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { VerifiedPhotoActor } from "../../../../../packages/photo-library-contract/src/v1";
import { PhotoMediaError } from "./api";
import { createPhotoMediaRoutes } from "./routes";
import type { PhotoMediaStore } from "./types";

const ORIGIN = "https://editor.synthetic.invalid";
const PHOTO_ID = randomUUID();
const KEY = "synthetic_media_key_1234";
const NOW = Date.parse("2026-11-02T00:00:00.000Z");

function actor(overrides: Partial<VerifiedPhotoActor> = {}): VerifiedPhotoActor {
  return { userId: "synthetic-owner", sessionId: "synthetic-session", transport: "browser-session",
    expiresAt: new Date(NOW + 60_000).toISOString(), ...overrides };
}

function request(body: BodyInit = JSON.stringify({ recipeRevision: 0 }), options: {
  method?: string; origin?: string | null; key?: string | null; url?: string; contentType?: string; signal?: AbortSignal;
} = {}): Request {
  const headers = new Headers({ "content-type": options.contentType ?? "application/json" });
  if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  if (options.key !== null) headers.set("idempotency-key", options.key ?? KEY);
  return new Request(options.url ?? `${ORIGIN}/api/photo/v1/photos/${PHOTO_ID}/media`, {
    method: options.method ?? "POST", headers, body, signal: options.signal,
  });
}

function fixture(overrides: { actor?: VerifiedPhotoActor; store?: PhotoMediaStore; media?: null; origins?: readonly string[] } = {}) {
  const store: PhotoMediaStore = overrides.store ?? { ensure: vi.fn(async (owner, photoId) => ({
    snapshot: { ownerId: owner, photoId, media: { state: "queued", jobId: randomUUID() } }, replayed: false,
  })) };
  const verify = vi.fn(async () => overrides.actor ?? actor());
  const media = vi.fn(() => overrides.media === null ? null : { store });
  return { store, verify, media, routes: createPhotoMediaRoutes({ media, verify, origins: overrides.origins ?? [ORIGIN], now: () => NOW }) };
}

async function error(response: Response) {
  return (await response.json() as { error: Record<string, unknown> }).error;
}

describe("photo media routes", () => {
  it("returns an owner-bound receipt with private JSON headers", async () => {
    const f = fixture();
    const response = await f.routes.ensure(request(), PHOTO_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ value: { state: "queued" }, replayed: false });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(f.store.ensure).toHaveBeenCalledOnce();
  });

  it("rejects method, query, origin and expired actors without touching the store", async () => {
    const cases = [
      fixture(),
      fixture(),
      fixture(),
      fixture({ actor: actor({ expiresAt: new Date(NOW).toISOString() }) }),
    ];
    const responses = [
      await cases[0]!.routes.ensure(request(undefined, { method: "PUT" }), PHOTO_ID),
      await cases[1]!.routes.ensure(request(undefined, { url: `${ORIGIN}/api/photo/v1/photos/${PHOTO_ID}/media?x=1` }), PHOTO_ID),
      await cases[2]!.routes.ensure(request(undefined, { origin: "https://other.synthetic.invalid" }), PHOTO_ID),
      await cases[3]!.routes.ensure(request(), PHOTO_ID),
    ];
    expect(responses.map((item) => item.status)).toEqual([400, 400, 403, 401]);
    for (const item of cases) expect(item.store.ensure).not.toHaveBeenCalled();
  });

  it("keeps native bearer mutation behavior while browser origin is exact", async () => {
    const native = fixture({ actor: actor({ transport: "mac-bearer" }) });
    expect((await native.routes.ensure(request(undefined, { origin: null }), PHOTO_ID)).status).toBe(200);
    const browser = fixture();
    expect((await browser.routes.ensure(request(undefined, { origin: null }), PHOTO_ID)).status).toBe(403);
    expect(browser.media).not.toHaveBeenCalled();
  });

  it("never resolves media dependencies before rejecting browser Origin, including an empty allowlist", async () => {
    const cases = [
      { fixture: fixture(), request: request(undefined, { origin: "https://other.synthetic.invalid" }) },
      { fixture: fixture(), request: request(undefined, { origin: null }) },
      { fixture: fixture({ origins: [] }), request: request() },
      { fixture: fixture({ origins: [] }), request: request(undefined, { origin: null }) },
    ];
    for (const item of cases) {
      expect((await item.fixture.routes.ensure(item.request, PHOTO_ID)).status).toBe(403);
      expect(item.fixture.verify).toHaveBeenCalledOnce();
      expect(item.fixture.media).not.toHaveBeenCalled();
      expect(item.fixture.store.ensure).not.toHaveBeenCalled();
    }
  });

  it("rejects bad JSON, key, unknown fields, content type and oversized bodies", async () => {
    let tooDeep: unknown = { recipeRevision: 0 };
    for (let depth = 0; depth < 34; depth += 1) tooDeep = { nested: tooDeep };
    const bad = [
      request("{"),
      request(new Uint8Array([0xc3, 0x28])),
      request(undefined, { key: null }),
      request(JSON.stringify({ recipeRevision: 0, extra: true })),
      request(JSON.stringify({ recipeRevision: 0.5 })),
      request(JSON.stringify(tooDeep)),
      request(JSON.stringify({ recipeRevision: 0 }), { contentType: "application/json; charset=shift_jis" }),
      request(JSON.stringify({ recipeRevision: 0, padding: "x".repeat(4096) })),
    ];
    const statuses = [];
    for (const item of bad) {
      const f = fixture();
      statuses.push((await f.routes.ensure(item, PHOTO_ID)).status);
      expect(f.store.ensure).not.toHaveBeenCalled();
    }
    expect(statuses).toEqual([400, 400, 400, 400, 400, 400, 400, 413]);
  });

  it("returns canonical revision, foreign and unavailable errors only after verification", async () => {
    const conflict = fixture({ store: { ensure: vi.fn(async () => { throw new PhotoMediaError("revision_conflict", 4); }) } });
    const conflictResponse = await conflict.routes.ensure(request(), PHOTO_ID);
    expect(conflictResponse.status).toBe(409);
    expect(await error(conflictResponse)).toEqual({ code: "revision_conflict", requestId: expect.any(String), retryable: false, currentRevision: 4 });

    const foreign = fixture({ store: { ensure: vi.fn(async () => null) } });
    const foreignResponse = await foreign.routes.ensure(request(), PHOTO_ID);
    expect(foreignResponse.status).toBe(404);
    expect(await error(foreignResponse)).toMatchObject({ code: "not_found", retryable: false });

    const unavailable = fixture({ media: null });
    const unavailableResponse = await unavailable.routes.ensure(request(), PHOTO_ID);
    expect(unavailable.verify).toHaveBeenCalledOnce();
    expect(unavailable.media).toHaveBeenCalledOnce();
    expect(unavailableResponse.status).toBe(503);
    expect(await error(unavailableResponse)).toEqual({ code: "temporarily_unavailable", requestId: expect.any(String), retryable: true, retryAfterSeconds: 1 });
  });

  it("does not leak thrown messages, stacks or paths", async () => {
    const f = fixture({ store: { ensure: vi.fn(async () => { throw new Error("secret /tmp/original-path token"); }) } });
    const response = await f.routes.ensure(request(), PHOTO_ID);
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(text).not.toMatch(/secret|original-path|stack|token/i);
  });

  it("returns within the two-second deadline even when stream cancellation never settles", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => new Promise<void>(() => undefined),
    });
    const headers = { origin: ORIGIN, "content-type": "application/json", "idempotency-key": KEY };
    const stalled = new Request(`${ORIGIN}/api/photo/v1/photos/${PHOTO_ID}/media`, {
      method: "POST", headers, body: stream, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const f = fixture();
    const started = Date.now();
    const response = await f.routes.ensure(stalled, PHOTO_ID);
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(response.status).toBe(503);
    expect(f.store.ensure).not.toHaveBeenCalled();
  }, 4_000);
});
