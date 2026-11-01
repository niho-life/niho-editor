import { describe, expect, it, vi } from "vitest";
import { HASH, IDS, library, readyPhoto } from "../../../../../packages/photo-library-contract/fixtures/v1";
import type { Photo, VersionSet } from "../../../../../packages/photo-library-contract/src/v1";
import { PhotoAuthError } from "../photo-auth";
import { PhotoRecipeError } from "./api";
import { createPhotoRecipesRoutes } from "./routes";
import type { PhotoRecipeDeps, PhotoRecipeSnapshot, PhotoRecipeStore } from "./types";

const KEY = "synthetic_recipe_key_01";
const ACTOR = { userId: IDS.userA, sessionId: "synthetic-session", transport: "browser-session" as const, expiresAt: "2026-11-02T00:00:00.000Z" };

function arrange() {
  let photo: Photo = readyPhoto;
  let versions: VersionSet = { revision: 7, versions: [] };
  const snapshot = (): PhotoRecipeSnapshot => ({ photo, library: {
    id: library.id, owner: library.owner, state: library.state, revision: library.revision, capabilities: library.capabilities,
  } });
  const store: PhotoRecipeStore = {
    photo: vi.fn(async (owner, id) => owner === IDS.userA && id === IDS.photo ? snapshot() : null),
    versionSet: vi.fn(async (owner, id) => owner === IDS.userA && id === IDS.photo ? { ...snapshot(), versions } : null),
    replayRecipe: vi.fn<PhotoRecipeStore["replayRecipe"]>(async () => null),
    replayVersions: vi.fn<PhotoRecipeStore["replayVersions"]>(async () => null),
    putRecipe: vi.fn(async (owner, id, input) => {
      if (owner !== IDS.userA || id !== IDS.photo) return null;
      photo = { ...photo, recipe: { ...input.recipe, revision: input.expectedRevision + 1, updatedAt: "2026-11-01T12:00:00.000Z" } };
      return { photo, replayed: false };
    }),
    putVersions: vi.fn(async (owner, id, input) => {
      if (owner !== IDS.userA || id !== IDS.photo) return null;
      versions = { revision: input.expectedRevision + 1, versions: [] };
      return { versions, replayed: false };
    }),
  };
  const deps: PhotoRecipeDeps = {
    store,
    validator: { validate: vi.fn(async () => ({ settingsSha256: HASH.settings, maskSurfaceIds: [] })) },
  };
  const verify = vi.fn(async () => ACTOR);
  const routes = createPhotoRecipesRoutes({ recipes: () => deps, verify, now: () => Date.parse("2026-11-01T12:00:00.000Z") });
  return { routes, store, verify, setPhoto(value: Photo) { photo = value; }, setVersions(value: VersionSet) { versions = value; } };
}

function request(method: "GET" | "PUT", url: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: method === "PUT" ? {
      origin: "https://editor.niho.life",
      "content-type": "application/json; charset=utf-8",
      "idempotency-key": KEY,
    } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("photo recipe HTTP routes", () => {
  it("uses the P01 actor for version reads and keeps the response private", async () => {
    const f = arrange();
    const response = await f.routes.getVersions(request("GET", "https://editor.niho.life/api/photo/v1/photos/photo/versions"), IDS.photo);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ revision: 7, versions: [] });
    expect(f.verify).toHaveBeenCalledOnce();
    expect(f.store.versionSet).toHaveBeenCalledWith(IDS.userA, IDS.photo);
  });

  it("accepts only a bounded recipe write with an idempotency key and returns the P02 receipt", async () => {
    const f = arrange();
    const body = { expectedRevision: 0, settings: { ...readyPhoto.recipe.settings, exposure: 0.25 }, baseVersion: null };
    const response = await f.routes.putRecipe(request("PUT", "https://editor.niho.life/api/photo/v1/photos/photo/recipe", body), IDS.photo);
    expect(response.status).toBe(200);
    expect((await response.json()).value.recipe.revision).toBe(1);
    expect(f.store.putRecipe).toHaveBeenCalledWith(IDS.userA, IDS.photo, expect.objectContaining({ expectedRevision: 0, key: KEY }));
  });

  it("returns the current CAS revision without leaking the store exception", async () => {
    const f = arrange();
    vi.mocked(f.store.putRecipe).mockRejectedValue(new PhotoRecipeError("revision_conflict", 4));
    const response = await f.routes.putRecipe(request("PUT", "https://editor.niho.life/api/photo/v1/photos/photo/recipe", {
      expectedRevision: 0, settings: readyPhoto.recipe.settings, baseVersion: null,
    }), IDS.photo);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "revision_conflict", currentRevision: 4 } });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("fails closed when production recipe wiring is absent, after authenticating", async () => {
    const verify = vi.fn(async () => ACTOR);
    const routes = createPhotoRecipesRoutes({ recipes: () => null, verify });
    const response = await routes.getVersions(request("GET", "https://editor.niho.life/api/photo/v1/photos/photo/versions"), IDS.photo);
    expect(response.status).toBe(503);
    expect(verify).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({ error: { code: "temporarily_unavailable", retryable: true } });
  });

  it("rejects query strings and maps auth failures to the public contract", async () => {
    const f = arrange();
    const badQuery = await f.routes.getVersions(request("GET", "https://editor.niho.life/api/photo/v1/photos/photo/versions?owner=other"), IDS.photo);
    expect(badQuery.status).toBe(400);
    expect(await badQuery.json()).toMatchObject({ error: { code: "invalid_request" } });

    const unauthenticated = createPhotoRecipesRoutes({ recipes: () => null, verify: async () => { throw new PhotoAuthError(401, "unauthorized"); } });
    const denied = await unauthenticated.getVersions(request("GET", "https://editor.niho.life/api/photo/v1/photos/photo/versions"), IDS.photo);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: { code: "unauthenticated" } });
  });
});
