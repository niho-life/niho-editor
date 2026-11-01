import { describe, expect, it, vi } from "vitest";
import { IDS, library, readyPhoto } from "../../../../../packages/photo-library-contract/fixtures/v1";
import { getPool } from "../db";
import { PhotoAuthError } from "../photo-auth";
import { createPhotoCatalogRoutes, runtimePhotoCatalogRoutes } from "./routes";
import type { PhotoCatalogStore } from "./types";

vi.mock("../db", () => ({ getPool: vi.fn(() => null) }));

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const URL = "https://editor.synthetic.invalid/api/photo/v1/photos";
const actor = { userId: IDS.userA, sessionId: "verified-session", transport: "browser-session" as const,
  expiresAt: new Date(NOW + 60_000).toISOString() };
function setup() {
  const store: PhotoCatalogStore = {
    library: vi.fn(async (owner) => owner === IDS.userA ? library : null),
    page: vi.fn(async (owner, input) => owner === IDS.userA ? { library, watermark: input.watermark ?? 1,
      items: input.after ? [] : [readyPhoto], hasMore: !input.after } : null),
    photo: vi.fn(async (owner, id) => owner === IDS.userA && id === IDS.photo ? { photo: readyPhoto,
      library: { id: library.id, owner: library.owner, state: library.state, revision: library.revision } } : null),
    info: vi.fn(async () => ({ width: 3000, privateField: "secret-locator" })),
    lookup: vi.fn(async (owner) => owner === IDS.userA ? [{ sha256: "a".repeat(64), photoId: IDS.photo, recipeRevision: 0 }] : []),
  };
  const verify = vi.fn(async () => actor);
  const routes = createPhotoCatalogRoutes({ enabled: true, cursorSecret: new Uint8Array(32).fill(4), store, verify, now: () => NOW });
  return { store, verify, routes };
}
async function data(response: Response) { return response.json() as Promise<Record<string, unknown>>; }

describe("photo catalog routes", () => {
  it("uses only the verified actor for every owner-scoped read and never returns private columns", async () => {
    const f = setup();
    const list = await f.routes.list(new Request(`${URL}?limit=1`));
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("private, no-store");
    const page = await data(list);
    expect(JSON.stringify(page)).not.toContain("secret-locator");
    const cursor = page.nextCursor as string;
    const second = await f.routes.list(new Request(`${URL}?limit=1&cursor=${encodeURIComponent(cursor)}`));
    expect(second.status).toBe(200);
    expect(vi.mocked(f.store.page).mock.calls[1]?.[1]).toMatchObject({ watermark: 1, filter: { lifecycle: "active", sort: "added-desc" } });
    await f.routes.library(new Request(`${URL}/../library`));
    await f.routes.photo(new Request(`${URL}/${IDS.photo}`), IDS.photo);
    const info = await f.routes.info(new Request(`${URL}/${IDS.photo}/info`), IDS.photo);
    expect(JSON.stringify(await data(info))).not.toContain("privateField");
    await f.routes.lookup(new Request(`${URL}/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha256s: ["a".repeat(64)] }) }));
    for (const name of ["library", "page", "photo", "info", "lookup"] as const) {
      expect(vi.mocked(f.store[name]).mock.calls.every((call) => call[0] === IDS.userA)).toBe(true);
    }
  });

  it("keeps missing dependencies and disabled feature closed before auth or DB access", async () => {
    const f = setup();
    for (const enabled of [false, true]) {
      const routes = createPhotoCatalogRoutes({ enabled, store: enabled ? null : f.store,
        cursorSecret: new Uint8Array(32), verify: f.verify });
      const response = await routes.list(new Request(URL));
      expect(response.status).toBe(503);
      expect((await data(response)).error).toMatchObject({ code: "temporarily_unavailable" });
    }
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.store.page).not.toHaveBeenCalled();
  });

  it("does not create the database pool until every private runtime setting is valid", async () => {
    vi.mocked(getPool).mockClear();
    const capabilities = JSON.stringify(library.capabilities);
    const missingSecret = runtimePhotoCatalogRoutes({ EDITOR_PHOTO_CATALOG_ENABLED: "true", EDITOR_PHOTO_CATALOG_CAPABILITIES: capabilities });
    expect((await missingSecret.list(new Request(URL))).status).toBe(503);
    expect(getPool).not.toHaveBeenCalled();

    const malformedSecret = runtimePhotoCatalogRoutes({ EDITOR_PHOTO_CATALOG_ENABLED: "true",
      EDITOR_PHOTO_CATALOG_CURSOR_SECRET: "1".repeat(65), EDITOR_PHOTO_CATALOG_CAPABILITIES: capabilities });
    expect((await malformedSecret.list(new Request(URL))).status).toBe(503);
    expect(getPool).not.toHaveBeenCalled();

    const malformedCapabilities = runtimePhotoCatalogRoutes({ EDITOR_PHOTO_CATALOG_ENABLED: "true",
      EDITOR_PHOTO_CATALOG_CURSOR_SECRET: "11".repeat(32),
      EDITOR_PHOTO_CATALOG_CAPABILITIES: JSON.stringify({ ...library.capabilities, formats: [{ format: "other" }] }) });
    expect((await malformedCapabilities.list(new Request(URL))).status).toBe(503);
    expect(getPool).not.toHaveBeenCalled();
  });

  it("returns the standard private error envelope for auth, invalid query and unknown owners", async () => {
    const f = setup();
    f.verify.mockRejectedValueOnce(new PhotoAuthError(401, "unauthorized"));
    const unauth = await f.routes.list(new Request(URL));
    expect(unauth.status).toBe(401);
    expect((await data(unauth)).error).toMatchObject({ code: "unauthenticated", retryable: false });
    const invalid = await f.routes.list(new Request(`${URL}?owner=${IDS.userB}`));
    expect(invalid.status).toBe(400);
    const unknown = createPhotoCatalogRoutes({ enabled: true, cursorSecret: new Uint8Array(32), store: f.store,
      verify: async () => ({ ...actor, userId: IDS.userB }), now: () => NOW });
    const missing = await unknown.photo(new Request(`${URL}/${IDS.photo}`), IDS.photo);
    expect(missing.status).toBe(404);
    for (const response of [unauth, invalid, missing]) expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
