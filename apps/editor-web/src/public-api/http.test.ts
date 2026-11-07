// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import type { PublicApiRouteDeps } from "./http";
import { servePublicApi } from "./http";
import { createFixedWindowLimiter } from "./rate-limit";
import { buildFixture, docPath, listPath, previewPath, SITE_A, type Fixture } from "./testing/contract-scenarios";
import { worldFaces, worldSource } from "./testing/world-source";

/** Next の Request ⇄ handler の受け渡し（path と query・header をそのまま渡し、応答の header を変えない）。 */

let fixture: Fixture;
let deps: PublicApiRouteDeps;
beforeAll(async () => {
  fixture = await buildFixture();
  const limiter = createFixedWindowLimiter({ limit: 1000, windowMs: 60_000 });
  deps = {
    source: () => worldSource(fixture.world),
    faces: () => worldFaces(fixture.world),
    limiter: () => limiter,
    clock: { now: () => fixture.world.now },
  };
});

const ORIGIN = "https://api.editor.niho.life";

function request(path: string, init: RequestInit & { credential?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.credential) headers.set("authorization", `Bearer ${init.credential}`);
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

describe("servePublicApi", () => {
  it("passes path, query and headers through and returns the contract's headers unchanged", async () => {
    const response = await servePublicApi(request(listPath(SITE_A, "?limit=2"), { credential: fixture.keys.siteA }), deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("vary")).toBe("Authorization");
    const etag = response.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const body = (await response.json()) as { items: { id: string }[] };
    expect(body.items.map((item) => item.id)).toContain(fixture.ids.siteLive);

    const again = await servePublicApi(
      request(listPath(SITE_A, "?limit=2"), { credential: fixture.keys.siteA, headers: { "if-none-match": etag ?? "" } }),
      deps,
    );
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(await again.text()).toBe("");
  });

  it("answers HEAD without a body, other methods with 400 and Allow, and a preview with no-store", async () => {
    const head = await servePublicApi(request(docPath(SITE_A, fixture.ids.siteLive), { method: "HEAD", credential: fixture.keys.siteA }), deps);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await servePublicApi(request(listPath(SITE_A), { method, credential: fixture.keys.siteA }), deps);
      expect(response.status, method).toBe(400);
      expect(response.headers.get("allow"), method).toBe("GET, HEAD");
    }
    const preview = await servePublicApi(request(previewPath(fixture.keys.previewSiteA), { credential: fixture.keys.siteA }), deps);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toBe("no-store");
  });

  it("combines repeated Authorization headers (so two credentials are refused) and gives each request its own requestId", async () => {
    const headers = new Headers();
    headers.append("authorization", `Bearer ${fixture.keys.siteA}`);
    headers.append("authorization", `Bearer ${fixture.keys.siteB}`);
    const first = await servePublicApi(new Request(`${ORIGIN}${listPath(SITE_A)}`, { headers }), deps);
    const second = await servePublicApi(new Request(`${ORIGIN}${listPath(SITE_A)}`, { headers }), deps);
    expect(first.status).toBe(401);
    expect(first.headers.get("www-authenticate")).toBe("Bearer");
    const id = (response: string) => (JSON.parse(response) as { error: { requestId: string } }).error.requestId;
    const [a, b] = [id(await first.text()), id(await second.text())];
    expect(a).toMatch(/^req_/);
    expect(a).not.toBe(b);
  });

  it("answers 503 when the store is not configured or cannot be opened", async () => {
    for (const source of [() => null, () => { throw new Error("bad DATABASE_URL"); }]) {
      const response = await servePublicApi(request(listPath(SITE_A), { credential: fixture.keys.siteA }), { ...deps, source });
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("temporarily_unavailable");
    }
  });
});
