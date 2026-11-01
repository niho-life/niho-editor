import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDS, library } from "../../../../../packages/photo-library-contract/fixtures/v1";
import { NIHO_SESSION_COOKIE } from "../../auth/niho";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const EXPIRES_AT = new Date(NOW + 60_000).toISOString();
const EDITOR_ORIGIN = "https://editor.synthetic.invalid";

const mocks = vi.hoisted(() => ({
  photoAvailable: true,
  docsGetSession: vi.fn(),
  photoGetSession: vi.fn(),
  getAuthProvider: vi.fn(),
  getPhotoAuthProvider: vi.fn(),
  getPool: vi.fn(() => ({})),
  catalogPage: vi.fn(),
}));

vi.mock("../../auth", () => ({
  getAuthProvider: mocks.getAuthProvider,
  getPhotoAuthProvider: mocks.getPhotoAuthProvider,
}));

vi.mock("../db", () => ({ getPool: mocks.getPool }));

vi.mock("../photo-catalog/store-adapter", () => ({
  createPhotoCatalogStore: vi.fn(() => ({
    library: vi.fn(async () => library),
    page: mocks.catalogPage,
    photo: vi.fn(async () => null),
    info: vi.fn(async () => null),
    lookup: vi.fn(async () => []),
  })),
}));

import { GET as photoSession } from "../../app/api/photo/v1/auth/session/route";
import type { AuthProvider } from "../../auth/types";
import { runtimePhotoCatalogRoutes } from "../photo-catalog/routes";
import { photoLifecycleRoutes } from "../photo-lifecycle/runtime";
import { photoRecipesRoutes } from "../photo-recipes/runtime";
import { photoTransferRoutes } from "../photo-transfer/runtime";
import { PhotoAuthError, verifyPhotoActor } from "./index";
import { photoAuthRuntimeDeps } from "./runtime";

function provider(mode: "google" | "niho", getSession: AuthProvider["getSession"]): AuthProvider {
  return {
    mode,
    getSession,
    beginLogin: async () => { throw new Error("not used"); },
    completeLogin: async () => { throw new Error("not used"); },
    logout: async () => { throw new Error("not used"); },
  };
}

function browserRequest(path: string): Request {
  return new Request(`${EDITOR_ORIGIN}${path}`, {
    headers: { cookie: `editor_session=synthetic-google; ${NIHO_SESSION_COOKIE}=synthetic-niho` },
  });
}

describe("photo auth production runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.photoAvailable = true;
    mocks.docsGetSession.mockResolvedValue({ userId: IDS.userB, mode: "google" });
    mocks.photoGetSession.mockResolvedValue({
      userId: IDS.userA,
      mode: "niho",
      sessionId: "synthetic-photo-session",
      expiresAt: EXPIRES_AT,
      refreshRequired: false,
    });
    mocks.getAuthProvider.mockImplementation(() => provider("google", mocks.docsGetSession));
    mocks.getPhotoAuthProvider.mockImplementation(() => mocks.photoAvailable ? provider("niho", mocks.photoGetSession) : null);
    mocks.getPool.mockReturnValue({});
    mocks.catalogPage.mockResolvedValue({ library, watermark: 1, items: [], hasMore: false });
  });

  it("is immutable and resolves both provider factories lazily", () => {
    expect(Object.isFrozen(photoAuthRuntimeDeps)).toBe(true);
    expect(mocks.getAuthProvider).not.toHaveBeenCalled();
    expect(mocks.getPhotoAuthProvider).not.toHaveBeenCalled();
    expect(photoAuthRuntimeDeps.auth().mode).toBe("google");
    expect(photoAuthRuntimeDeps.photoAuth?.()?.mode).toBe("niho");
    expect(mocks.getAuthProvider).toHaveBeenCalledOnce();
    expect(mocks.getPhotoAuthProvider).toHaveBeenCalledOnce();
  });

  it("selects canonical NIHO actor A instead of the global Google actor B", async () => {
    const result = await verifyPhotoActor(browserRequest("/api/photo/v1/auth/session"), photoAuthRuntimeDeps);
    expect(result.actor).toMatchObject({ userId: IDS.userA, sessionId: "synthetic-photo-session", transport: "browser-session" });
    expect(mocks.photoGetSession).toHaveBeenCalledOnce();
    expect(mocks.docsGetSession).not.toHaveBeenCalled();
  });

  it("fails explicit unavailable photo auth as 503 and never calls Google getSession", async () => {
    mocks.photoAvailable = false;
    await expect(verifyPhotoActor(browserRequest("/api/photo/v1/auth/session"), photoAuthRuntimeDeps))
      .rejects.toEqual(new PhotoAuthError(503, "photo_auth_unavailable", true));
    const response = await photoSession(browserRequest("/api/photo/v1/auth/session"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "photo_auth_unavailable", retryable: true });
    expect(mocks.photoGetSession).not.toHaveBeenCalled();
    expect(mocks.docsGetSession).not.toHaveBeenCalled();
  });

  it("wires the shared NIHO seam through auth-session, catalog, transfer, recipes and lifecycle entrypoints", async () => {
    const auth = await photoSession(browserRequest("/api/photo/v1/auth/session"));
    expect(auth.status).toBe(200);
    expect(await auth.json()).toMatchObject({ userId: IDS.userA, sessionId: "synthetic-photo-session" });

    const catalog = runtimePhotoCatalogRoutes({
      EDITOR_PHOTO_CATALOG_ENABLED: "true",
      EDITOR_PHOTO_CATALOG_CURSOR_SECRET: "11".repeat(32),
      EDITOR_PHOTO_CATALOG_CAPABILITIES: JSON.stringify(library.capabilities),
    });
    const listed = await catalog.list(browserRequest("/api/photo/v1/photos"));
    expect(listed.status).toBe(200);
    expect(mocks.catalogPage).toHaveBeenCalledWith(IDS.userA, expect.any(Object));

    const transfer = await photoTransferRoutes.get(browserRequest(`/api/photo/v1/uploads/${IDS.upload}`), IDS.upload);
    const recipes = await photoRecipesRoutes.getVersions(browserRequest(`/api/photo/v1/photos/${IDS.photo}/versions`), IDS.photo);
    const lifecycle = await photoLifecycleRoutes.job(browserRequest(`/api/photo/v1/jobs/${IDS.job}`), IDS.job);
    for (const response of [transfer, recipes, lifecycle]) expect(response.status).toBe(503);

    expect(mocks.photoGetSession).toHaveBeenCalledTimes(5);
    expect(mocks.docsGetSession).not.toHaveBeenCalled();
  });
});
