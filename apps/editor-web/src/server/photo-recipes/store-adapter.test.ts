import { beforeEach, describe, expect, it, vi } from "vitest";
import { HASH, IDS, readyPhoto } from "../../../../../packages/photo-library-contract/fixtures/v1";
import type { PhotoCapabilities } from "../../../../../packages/photo-library-contract/src/v1";

const storeMocks = vi.hoisted(() => ({
  getPhotoCanonicalWorkingCopy: vi.fn(),
  getPhotoSnapshot: vi.fn(),
  getPhotoVersions: vi.fn(),
  putPhotoRecipe: vi.fn(),
  putPhotoVersions: vi.fn(),
  replayPhotoWrite: vi.fn(),
}));

vi.mock("@niho/editor-store", async () => {
  const actual = await vi.importActual<typeof import("@niho/editor-store")>("@niho/editor-store");
  return { ...actual, ...storeMocks };
});

import { PhotoRevisionConflictError, type Database, type PhotoSnapshot } from "@niho/editor-store";
import { createPhotoCanonicalContextResolver, createPhotoRecipeStore } from "./store-adapter";

const capabilities: PhotoCapabilities = {
  formats: [],
  renderer: { sdkVersion: "synthetic", crateVersion: "synthetic", manifestSha256: HASH.settings,
    settingsVersions: [readyPhoto.recipe.settings.v], engines: [readyPhoto.recipe.settings.engine], features: [], maskKinds: [], maskSurfaces: false },
  edits: true,
  versions: true,
  maskSurfaces: false,
  albums: false,
  publicSharing: false,
};

const snapshot: PhotoSnapshot = {
  library: {
    id: readyPhoto.libraryId,
    owner: IDS.userA,
    state: "active",
    revision: 9,
    lifecycleEpoch: 1,
    nextPhotoSequence: 2,
    usage: { quotaBytes: 1000, usedBytes: 100, originalBytes: 100, maskBytes: 0, trashBytes: 0, pendingPurgeBytes: 0, reservedBytes: 0, availableBytes: 900 },
    createdAt: "2026-11-01T12:00:00.000Z",
    updatedAt: "2026-11-01T12:00:00.000Z",
  },
  photo: {
    id: readyPhoto.id,
    libraryId: readyPhoto.libraryId,
    creationSequence: 1,
    lifecycle: "active",
    lifecycleEpoch: 1,
    fileName: readyPhoto.fileName,
    format: "jpeg",
    width: readyPhoto.width,
    height: readyPhoto.height,
    capturedAt: null,
    addedAt: "2026-11-01T12:00:00.000Z",
    trashedAt: null,
    purgeAfter: null,
    recipeRevision: 0,
    versionsRevision: 7,
    original: {
      id: readyPhoto.original.id,
      photoId: readyPhoto.id,
      kind: "original",
      sha256: HASH.original,
      sizeBytes: 100,
      contentType: "image/jpeg",
      width: readyPhoto.width,
      height: readyPhoto.height,
      objectKey: "synthetic-original-object",
      objectGeneration: "1",
      deletionState: "retained",
      createdAt: "2026-11-01T12:00:00.000Z",
    },
  },
  recipe: {
    revision: 0,
    settings: readyPhoto.recipe.settings,
    settingsSha256: HASH.settings,
    baseVersion: null,
    maskSurfaceIds: [],
    updatedAt: "2026-11-01T12:00:00.000Z",
    hasEdits: false,
  },
  media: null,
  hasEdits: false,
};

describe("photo recipe P02 store adapter", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("uses the transactional P02 writer and maps the returned current photo without exposing object locators", async () => {
    storeMocks.putPhotoRecipe.mockResolvedValue({ snapshot, replayed: false });
    const db = {} as Database;
    const store = createPhotoRecipeStore(db, capabilities);
    const result = await store.putRecipe(IDS.userA, IDS.photo, {
      expectedRevision: 0,
      key: "synthetic_recipe_key_01",
      requestHash: HASH.settings,
      recipe: { settings: readyPhoto.recipe.settings, settingsSha256: HASH.settings, baseVersion: null, maskSurfaceIds: [] },
    });

    expect(result?.photo.media).toEqual({ state: "pending" });
    expect(result?.photo.original).not.toHaveProperty("objectKey");
    expect(result?.photo.recipe.settings).toEqual(readyPhoto.recipe.settings);
    expect(storeMocks.putPhotoRecipe).toHaveBeenCalledWith(db, IDS.userA, IDS.photo, expect.objectContaining({ expectedRevision: 0 }));
  });

  it("returns current CAS revision from the durable P02 conflict", async () => {
    storeMocks.putPhotoRecipe.mockRejectedValue(new PhotoRevisionConflictError(5));
    const store = createPhotoRecipeStore({} as Database, capabilities);
    await expect(store.putRecipe(IDS.userA, IDS.photo, {
      expectedRevision: 0,
      key: "synthetic_recipe_key_01",
      requestHash: HASH.settings,
      recipe: { settings: readyPhoto.recipe.settings, settingsSha256: HASH.settings, baseVersion: null, maskSurfaceIds: [] },
    })).rejects.toMatchObject({ code: "revision_conflict", currentRevision: 5 });
  });

  it("maps only credential-free canonical context from the owner-scoped P02 lookup", async () => {
    storeMocks.getPhotoCanonicalWorkingCopy.mockResolvedValue({
      ownerId: IDS.userA,
      libraryId: readyPhoto.libraryId,
      photoId: readyPhoto.id,
      originalAssetId: readyPhoto.original.id,
      originalSha256: readyPhoto.original.sha256,
      baseVersion: "raster.ci2.p2.e2.icc-srgb",
      rendererManifestSha256: capabilities.renderer.manifestSha256,
      workingCopy: {
        asset: {
          id: IDS.mask, kind: "working-copy", sha256: HASH.mask, sizeBytes: 12,
          contentType: "image/jpeg", width: 2, height: 1,
          objectKey: "must-not-cross-adapter", objectGeneration: "9",
        },
        baseVersion: "raster.ci2.p2.e2.icc-srgb",
        encoding: "jpeg8",
        meta: { kind: "raster", encoding: "jpeg8" },
      },
    });
    const db = {} as Database;
    const resolver = createPhotoCanonicalContextResolver(db);
    const expected = {
      ownerId: IDS.userA,
      libraryId: readyPhoto.libraryId,
      photoId: readyPhoto.id,
      originalAssetId: readyPhoto.original.id,
      originalSha256: readyPhoto.original.sha256,
      baseVersion: "raster.ci2.p2.e2.icc-srgb",
      rendererManifestSha256: capabilities.renderer.manifestSha256,
    };
    const result = await resolver(expected);

    expect(storeMocks.getPhotoCanonicalWorkingCopy).toHaveBeenCalledWith(db, IDS.userA, readyPhoto.id, {
      libraryId: readyPhoto.libraryId,
      originalAssetId: readyPhoto.original.id,
      originalSha256: readyPhoto.original.sha256,
      baseVersion: expected.baseVersion,
      rendererManifestSha256: expected.rendererManifestSha256,
    });
    expect(result).toMatchObject({ ...expected, workingCopy: { asset: { id: IDS.mask, kind: "working-copy" } } });
    expect(result?.workingCopy.asset).not.toHaveProperty("objectKey");
    expect(result?.workingCopy.asset).not.toHaveProperty("objectGeneration");
  });
});
