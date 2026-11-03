// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parseErrorBody, parsePublishedIndex } from "@niho/editor-publish-contract";
import type { ReferenceWorld } from "@niho/editor-publish-contract/test-support";
import { decodeCursor, encodeCursor } from "./cursor";
import { createPublicApi, newRequestId, type PublicApiOptions, type PublicApiRequest } from "./handler";
import { createFixedWindowLimiter } from "./rate-limit";
import type { PublicApiSource } from "./source";
import { buildFixture, docPath, listPath, previewPath, publication, SITE_A, type Fixture } from "./testing/contract-scenarios";
import { createRng, syntheticUuid } from "./testing/synthetic";
import { worldFaces, worldSource } from "./testing/world-source";

/** 参照モデルには無い、production だけの振る舞い（rate limit・DB の失敗・cursor の改ざん・保存の都合の field・requestId）。 */

let fixture: Fixture;
beforeAll(async () => {
  fixture = await buildFixture();
});

function api(world: ReferenceWorld, overrides: Partial<PublicApiOptions> = {}) {
  return createPublicApi({ source: worldSource(world), faces: worldFaces(world), clock: { now: () => world.now }, ...overrides });
}

const get = (url: string, credential?: string, extra: Partial<PublicApiRequest> = {}): PublicApiRequest => ({
  method: "GET",
  url,
  headers: credential ? { authorization: `Bearer ${credential}` } : {},
  requestId: "req_behavior",
  ...extra,
});

function codeOf(body: string | null): string | undefined {
  return body === null ? undefined : (JSON.parse(body) as { error?: { code?: string } }).error?.code;
}

describe("rate limit (per credential hash, fixed window inside one instance)", () => {
  it("answers 429 rate_limited with Retry-After once a credential uses up its window, without touching the store", async () => {
    const calls: string[] = [];
    let now = "2026-10-01T00:00:10.000Z";
    const server = createPublicApi({
      source: worldSource(fixture.world, { calls }),
      faces: worldFaces(fixture.world),
      clock: { now: () => now },
      limiter: createFixedWindowLimiter({ limit: 3, windowMs: 60_000 }),
    });
    for (let index = 0; index < 3; index += 1) expect((await server.handle(get(listPath(SITE_A), fixture.keys.siteA))).status).toBe(200);
    const before = calls.length;
    const limited = await server.handle(get(listPath(SITE_A), fixture.keys.siteA));
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("50");
    expect(limited.headers["cache-control"]).toBe("no-store");
    expect(limited.headers.vary).toBe("Authorization");
    expect(limited.headers["x-robots-tag"]).toBe("noindex");
    expect(parseErrorBody(JSON.parse(limited.body ?? "null")).ok).toBe(true);
    expect(JSON.parse(limited.body ?? "null")).toEqual({ error: { code: "rate_limited", requestId: "req_behavior", retryable: true } });
    expect(calls.length).toBe(before);
    // 別の資格は数えが別
    expect((await server.handle(get(listPath("exp"), fixture.keys.exp))).status).toBe(200);
    // 次の窓で戻る
    now = "2026-10-01T00:01:00.000Z";
    expect((await server.handle(get(listPath(SITE_A), fixture.keys.siteA))).status).toBe(200);
  });

  it("counts invalid credentials too (a wrong key cannot hammer the store), but never a missing Authorization", async () => {
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const server = api(fixture.world, { limiter });
    expect((await server.handle(get(listPath(SITE_A), fixture.keys.unknownKey))).status).toBe(401);
    expect((await server.handle(get(listPath(SITE_A), fixture.keys.unknownKey))).status).toBe(429);
    expect((await server.handle(get(listPath(SITE_A)))).status).toBe(401);
    expect((await server.handle(get(listPath(SITE_A)))).status).toBe(401);
  });

  it("stops tracking new credentials past the cap instead of growing without bound", () => {
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 60_000 }, 2);
    expect(limiter.take("a", 0).ok).toBe(true);
    expect(limiter.take("b", 0).ok).toBe(true);
    expect(limiter.take("c", 0).ok).toBe(true);
    expect(limiter.take("c", 0).ok).toBe(true);
    expect(limiter.take("a", 0).ok).toBe(false);
  });
});

describe("failures", () => {
  it("answers 503 temporarily_unavailable after the method check when there is no store", async () => {
    const server = createPublicApi({ source: null, faces: worldFaces(fixture.world), clock: { now: () => fixture.world.now } });
    const response = await server.handle(get(listPath(SITE_A), fixture.keys.siteA));
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body ?? "null")).toEqual({ error: { code: "temporarily_unavailable", requestId: "req_behavior", retryable: true } });
    const post = await server.handle(get(listPath(SITE_A), fixture.keys.siteA, { method: "POST" }));
    expect(post.status).toBe(400);
    expect(post.headers.allow).toBe("GET, HEAD");
    const head = await server.handle(get(listPath(SITE_A), fixture.keys.siteA, { method: "HEAD" }));
    expect(head).toMatchObject({ status: 503, body: null });
  });

  it("turns a store failure into 503 and records only the error name (never the credential, token or URL)", async () => {
    const recorded: string[] = [];
    const failing = new Error(`connection refused for ${fixture.keys.siteA} ${fixture.keys.previewExp}`);
    failing.name = "StoreDown";
    const source: PublicApiSource = {
      ...worldSource(fixture.world),
      siteHandleByKeyHash: async () => { throw failing; },
      previewTokenByHash: async () => { throw failing; },
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const server = createPublicApi({ source, faces: worldFaces(fixture.world), clock: { now: () => fixture.world.now }, onUnexpected: (name) => recorded.push(name) });
      const list = await server.handle(get(listPath(SITE_A), fixture.keys.siteA));
      const preview = await server.handle(get(previewPath(fixture.keys.previewExp), fixture.keys.exp));
      for (const response of [list, preview]) {
        expect(response.status).toBe(503);
        expect(codeOf(response.body)).toBe("temporarily_unavailable");
        expect(JSON.stringify(response)).not.toContain(fixture.keys.siteA);
        expect(JSON.stringify(response)).not.toContain("connection refused");
      }
      expect(recorded).toEqual(["StoreDown", "StoreDown"]);
      // 既定の記録（console.error）も name だけ
      const defaults = createPublicApi({ source, faces: worldFaces(fixture.world), clock: { now: () => fixture.world.now } });
      await defaults.handle(get(previewPath(fixture.keys.previewExp), fixture.keys.exp));
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).toContain("StoreDown");
      for (const secret of Object.values(fixture.keys)) expect(logged).not.toContain(secret);
      expect(logged).not.toContain("/v1/");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("stored snapshots", () => {
  it("serves only the contract's fields (a stored fingerprint never reaches a destination)", async () => {
    const world: ReferenceWorld = {
      ...fixture.world,
      publications: fixture.world.publications.map((item) => item.pageId !== fixture.ids.siteLive ? item : {
        ...item,
        snapshot: Object.assign({ ...item.snapshot }, { fingerprint: "f".repeat(64), range: "unlisted" }),
      }),
    };
    const response = await api(world).handle(get(docPath(SITE_A, fixture.ids.siteLive), fixture.keys.siteA));
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body ?? "null") as Record<string, unknown>;
    expect(body.fingerprint).toBeUndefined();
    // range は公開の行のいまの値（公開版の中の値ではない）
    expect(body.range).toBe("live");
  });

  it("projects category display metadata through list, document and preview without leaking stored fields", async () => {
    const categoryDisplay = { labelEn: "Walks", labelJa: "散策", displayOrder: 4, revision: 7 };
    const world: ReferenceWorld = {
      ...fixture.world,
      publications: fixture.world.publications.map((item) => item.pageId !== fixture.ids.expLive ? item : {
        ...item,
        snapshot: { ...item.snapshot, category: "walks", categoryDisplay },
      }),
    };
    const source = worldSource(world);
    const basePreview = source.previewDraft.bind(source);
    const server = createPublicApi({
      source: {
        ...source,
        previewDraft: async (binding) => {
          const draft = await basePreview(binding);
          return draft ? { ...draft, content: { ...draft.content, category: "walks", categoryDisplay } } : null;
        },
      },
      faces: worldFaces(world),
      clock: { now: () => world.now },
    });

    const list = await server.handle(get(listPath("exp"), fixture.keys.exp));
    const document = await server.handle(get(docPath("exp", fixture.ids.expLive), fixture.keys.exp));
    const preview = await server.handle(get(previewPath(fixture.keys.previewExp), fixture.keys.exp));
    expect(list.status).toBe(200);
    expect((JSON.parse(list.body ?? "null") as { items: { id: string; categoryDisplay?: unknown }[] }).items
      .find((item) => item.id === fixture.ids.expLive)?.categoryDisplay).toEqual(categoryDisplay);
    expect(JSON.parse(document.body ?? "null")).toMatchObject({ category: "walks", categoryDisplay });
    expect(JSON.parse(preview.body ?? "null")).toMatchObject({ category: "walks", categoryDisplay });
  });
});

describe("cursor", () => {
  const position = { updatedAt: "2026-09-01T03:00:00.000Z", id: "0f0e0d0c-0b0a-4908-8706-050403020100" };
  const scope = { handle: SITE_A, includeUnlisted: false };

  it("round-trips a position and stays inside the contract's cursor alphabet", () => {
    const cursor = encodeCursor(position, scope);
    expect(cursor).toMatch(/^[A-Za-z0-9._~-]{1,512}$/);
    expect(cursor).not.toContain(position.id);
    expect(decodeCursor(cursor, scope)).toEqual(position);
  });

  it("rejects an edited cursor, one from another handle or include, and malformed ones", () => {
    const cursor = encodeCursor(position, scope);
    const [version, payload, seal] = cursor.split(".") as [string, string, string];
    const edited = `${version}.${Buffer.from(`${Date.parse(position.updatedAt) + 1}.${position.id}`).toString("base64url")}.${seal}`;
    expect(decodeCursor(edited, scope)).toBeNull();
    expect(decodeCursor(`${version}.${payload}.${seal.slice(0, -1)}${seal.endsWith("A") ? "B" : "A"}`, scope)).toBeNull();
    expect(decodeCursor(cursor, { handle: "site-beta", includeUnlisted: false })).toBeNull();
    expect(decodeCursor(cursor, { handle: SITE_A, includeUnlisted: true })).toBeNull();
    for (const value of ["", "v1", "v1..", "c1.1.0f0e0d0c-0b0a-4908-8706-050403020100", `${cursor}x`, `v2.${payload}.${seal}`]) {
      expect(decodeCursor(value, scope), value).toBeNull();
    }
  });

  it("answers 400 for a tampered cursor on the list, and walks with the cursors it issued", async () => {
    const rng = createRng(3);
    const bulk = Array.from({ length: 5 }, (_, index) => publication(syntheticUuid(rng), SITE_A, `bulk-${index}`, "2026-09-01T00:00:00.000Z"));
    const server = api({ ...fixture.world, publications: bulk });
    const first = await server.handle(get(listPath(SITE_A, "?limit=2"), fixture.keys.siteA));
    const next = (JSON.parse(first.body ?? "null") as { nextCursor: string }).nextCursor;
    expect(parsePublishedIndex(JSON.parse(first.body ?? "null")).ok).toBe(true);
    const second = await server.handle(get(listPath(SITE_A, `?limit=2&cursor=${next}`), fixture.keys.siteA));
    expect(second.status).toBe(200);
    const tampered = await server.handle(get(listPath(SITE_A, `?limit=2&cursor=${next.slice(0, -2)}AA`), fixture.keys.siteA));
    expect(tampered.status).toBe(400);
    expect(codeOf(tampered.body)).toBe("invalid_request");
  });
});

describe("request ids", () => {
  it("makes a fresh printable id per request when none is given", async () => {
    const ids = new Set<string>();
    for (let index = 0; index < 20; index += 1) ids.add(newRequestId());
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id).toMatch(/^req_[A-Za-z0-9_-]{16}$/);
    const response = await api(fixture.world).handle({ method: "GET", url: listPath(SITE_A) });
    expect((JSON.parse(response.body ?? "null") as { error: { requestId: string } }).error.requestId).toMatch(/^req_/);
  });
});
