// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { library as fixtureLibrary } from "../../../../../packages/photo-library-contract/fixtures/v1";
import type { Photo, PhotoPage } from "../../../../../packages/photo-library-contract/src/v1";
import { PhotoAuthError } from "../photo-auth";
import { createPhotoCatalogRoutes } from "../photo-catalog/routes";
import { createPhotoCatalogStore } from "../photo-catalog/store-adapter";
import {
  CONFORMANCE_ORIGIN, SYNTHETIC_JPEG, actor, conformanceDatabaseUrl,
  createConformanceHarness, digest, openConformanceDatabase, originalRequest, post, startAndStage,
} from "./harness";

const databaseUrl = conformanceDatabaseUrl();
const request = (path: string) => new Request(`${CONFORMANCE_ORIGIN}/api/photo/v1/${path}`);
const lookup = (body: unknown) => new Request(`${CONFORMANCE_ORIGIN}/api/photo/v1/photos/lookup`, {
  method: "POST", headers: { origin: CONFORMANCE_ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body),
});

(databaseUrl ? describe : describe.skip)("P12 catalog routes + production PostgreSQL adapter", () => {
  let pool: Pool;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => { ({ pool, close } = await openConformanceDatabase(databaseUrl!)); });
  afterAll(async () => { await close?.(); });

  function routes(owner: string | null) {
    return createPhotoCatalogRoutes({
      enabled: true, cursorSecret: Buffer.alloc(32, 7),
      store: createPhotoCatalogStore(pool, fixtureLibrary.capabilities),
      verify: async () => {
        if (owner === null) throw new PhotoAuthError(401, "unauthenticated");
        return actor(owner);
      },
    });
  }

  async function seed(owner: string, marker = 0): Promise<Photo> {
    const harness = createConformanceHarness(pool);
    const bytes = Buffer.concat([SYNTHETIC_JPEG, Buffer.from([marker])]);
    const staged = await startAndStage(harness, owner, originalRequest(bytes), bytes);
    const result = await harness.api.complete(post(), actor(owner), staged.uploadId);
    expect(result.status).toBe(200);
    return (await result.json() as { value: { result: { photo: Photo } } }).value.result.photo;
  }

  it("catalog snapshot: same-owner pending photo has no invented job or object locator", async () => {
    const owner = `synthetic-catalog-${randomUUID()}`;
    const photo = await seed(owner);
    const own = routes(owner);
    const library = await own.library(request("library"));
    expect(library.status).toBe(200);
    expect(await library.json()).toMatchObject({ owner: { type: "user", userId: owner } });
    const response = await own.photo(request(`photos/${photo.id}`), photo.id);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ id: photo.id, media: { state: "pending" } });
    expect(body.media).not.toHaveProperty("jobId");
    expect(JSON.stringify(body)).not.toMatch(/objectKey|objectGeneration|photo\/final\//);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("foreign-photo: another owner and a missing ID return the same rejection without bytes", async () => {
    const owner = `synthetic-detail-a-${randomUUID()}`, other = `synthetic-detail-b-${randomUUID()}`;
    const photo = await seed(owner);
    const foreign = await routes(other).photo(request(`photos/${photo.id}`), photo.id);
    const missing = await routes(other).photo(request("photos/missing"), randomUUID());
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ error: { code: "not_found" } });
    expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("foreign-hash: lookup sees only the verified owner's originals and rejects body ownership", async () => {
    const owner = `synthetic-lookup-a-${randomUUID()}`, other = `synthetic-lookup-b-${randomUUID()}`;
    const photo = await seed(owner);
    const hash = digest(Buffer.concat([SYNTHETIC_JPEG, Buffer.from([0])]));
    const own = await routes(owner).lookup(lookup({ sha256s: [hash] }));
    expect(await own.json()).toMatchObject({ matches: [{ sha256: hash, photoId: photo.id }] });
    const foreign = await routes(other).lookup(lookup({ sha256s: [hash] }));
    expect(foreign.status).toBe(200);
    expect(await foreign.json()).toEqual({ matches: [] });
    expect((await routes(other).lookup(lookup({ sha256s: [hash], ownerId: owner }))).status).toBe(400);
  });

  it("foreign-cursor: owner-bound cursor rejects a different owner and preserves its creation watermark", async () => {
    const owner = `synthetic-cursor-a-${randomUUID()}`, other = `synthetic-cursor-b-${randomUUID()}`;
    await seed(owner, 1); await seed(owner, 2);
    const first = await routes(owner).list(request("photos?limit=1"));
    expect(first.status).toBe(200);
    const page = await first.json() as PhotoPage;
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const next = `photos?limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`;
    const foreign = await routes(other).list(request(next));
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toMatchObject({ error: { code: "invalid_cursor" } });
    expect((await pool.query("SELECT 1 FROM photo_libraries WHERE owner=$1", [other])).rowCount).toBe(0);
    const inserted = await seed(owner, 3);
    const second = await routes(owner).list(request(next));
    expect(second.status).toBe(200);
    const tail = await second.json() as PhotoPage;
    expect(tail.items).toHaveLength(1);
    expect(tail.items[0]!.id).not.toBe(page.items[0]!.id);
    expect(tail.items[0]!.id).not.toBe(inserted.id);
    expect(tail.nextCursor).toBeNull();
  });

  it("unauthenticated-library: route rejects before creating a library (synthetic auth port)", async () => {
    const count = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM photo_libraries");
    const response = await routes(null).library(request("library"));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthenticated" } });
    expect((await pool.query("SELECT count(*)::text AS count FROM photo_libraries")).rows).toEqual(count.rows);
  });
});
