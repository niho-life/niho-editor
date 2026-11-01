import { beforeEach, describe, expect, it, vi } from "vitest";
import { HASH, IDS, library as publicLibrary, readyPhoto } from "../../../../../packages/photo-library-contract/fixtures/v1";
import type { Database, PhotoLibraryRecord, PhotoSnapshot } from "@niho/editor-store";
import { getPhotoInfo, getPhotoLibrary, getPhotoSnapshot, listPhotoCatalogPage, lookupPhotoHashes } from "@niho/editor-store";
import { createPhotoCatalogStore } from "./store-adapter";

vi.mock("@niho/editor-store", () => ({
  getPhotoInfo: vi.fn(), getPhotoLibrary: vi.fn(), getPhotoSnapshot: vi.fn(),
  listPhotoCatalogPage: vi.fn(), lookupPhotoHashes: vi.fn(),
}));
const db = {} as Database;
const rawLibrary: PhotoLibraryRecord = { id: IDS.library, owner: IDS.userA, state: "active", revision: 3,
  lifecycleEpoch: 1, nextPhotoSequence: 2, usage: { ...publicLibrary.usage }, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" };
const original = { ...readyPhoto.original, photoId: IDS.photo, objectKey: "private/final/object", objectGeneration: "42", deletionState: "retained" as const, createdAt: "2026-11-01T00:00:00.000Z" };
const thumbnail = { ...readyPhoto.original, id: IDS.thumbnail, kind: "thumbnail" as const, photoId: IDS.photo, objectKey: "private/thumb", objectGeneration: "43", deletionState: "retained" as const, createdAt: "2026-11-01T00:00:00.000Z" };
const preview = { ...thumbnail, id: IDS.preview, kind: "preview" as const, objectKey: "private/preview" };
const snapshot: PhotoSnapshot = { library: rawLibrary,
  photo: { id: IDS.photo, libraryId: IDS.library, creationSequence: 1, lifecycle: "active", lifecycleEpoch: 1,
    fileName: "synthetic.jpg", format: "jpeg", width: 3000, height: 2000, capturedAt: null, addedAt: "2026-11-01T00:00:00.000Z",
    trashedAt: null, purgeAfter: null, recipeRevision: 0, versionsRevision: 0, original },
  recipe: { revision: 0, settings: { v: 1, engine: "niho-14" }, settingsSha256: HASH.settings,
    baseVersion: null, maskSurfaceIds: [], updatedAt: "2026-11-01T00:00:00.000Z", hasEdits: false },
  media: { id: IDS.job, state: "ready", recipeRevision: 0, rendererManifestSha256: HASH.manifest,
    errorCode: null, ready: { thumbnailId: IDS.thumbnail, previewId: IDS.preview, workingCopy: null, privateLocator: "private/hidden" },
    assets: [thumbnail, preview] }, hasEdits: false };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getPhotoLibrary).mockResolvedValue(rawLibrary);
  vi.mocked(listPhotoCatalogPage).mockResolvedValue({ library: rawLibrary, watermark: 1, items: [snapshot], hasMore: false });
  vi.mocked(getPhotoSnapshot).mockResolvedValue(snapshot);
  vi.mocked(getPhotoInfo).mockResolvedValue({ capturedAt: null, width: 3000, height: 2000 });
  vi.mocked(lookupPhotoHashes).mockResolvedValue([{ sha256: HASH.original, photoId: IDS.photo, recipeRevision: 0 }]);
});

describe("P02 catalog adapter", () => {
  it("forwards owner, cursor and trusted editable filters, and allowlists snapshot fields", async () => {
    const store = createPhotoCatalogStore(db, publicLibrary.capabilities);
    const input = { filter: { sort: "added-desc" as const, lifecycle: "active" as const, editable: true },
      watermark: 5, after: { sort: "added-desc" as const, id: IDS.photo, addedAt: snapshot.photo.addedAt }, limit: 10 };
    const page = await store.page(IDS.userA, input);
    expect(getPhotoLibrary).not.toHaveBeenCalled();
    expect(listPhotoCatalogPage).toHaveBeenCalledWith(db, IDS.userA, expect.objectContaining({
      watermark: 5, after: input.after, filter: expect.objectContaining({ editable: true,
        editableEngines: publicLibrary.capabilities.renderer.engines,
        editableSettingsVersions: publicLibrary.capabilities.renderer.settingsVersions }),
    }));
    expect(page?.items[0]?.id).toBe(IDS.photo);
    expect(JSON.stringify(page)).not.toMatch(/objectKey|objectGeneration|privateLocator/);
    const detail = await store.photo(IDS.userA, IDS.photo);
    expect(JSON.stringify(detail)).not.toMatch(/objectKey|objectGeneration|privateLocator/);
    expect(await store.info(IDS.userA, IDS.photo)).toEqual({ capturedAt: null, width: 3000, height: 2000 });
    expect(await store.lookup(IDS.userA, [HASH.original])).toHaveLength(1);
    for (const method of [getPhotoSnapshot, getPhotoInfo, lookupPhotoHashes]) expect(method).toHaveBeenCalledWith(db, IDS.userA, expect.anything());
  });

  it("fails closed if a ready projection is missing an asset", async () => {
    vi.mocked(getPhotoSnapshot).mockResolvedValue({ ...snapshot, media: { ...snapshot.media!, assets: [] } });
    const store = createPhotoCatalogStore(db, publicLibrary.capabilities);
    await expect(store.photo(IDS.userA, IDS.photo)).rejects.toThrow("projection unavailable");
  });

  it("returns pending media for durable originals before the outbox job exists", async () => {
    const pending = { ...snapshot, media: null };
    vi.mocked(listPhotoCatalogPage).mockResolvedValue({ library: rawLibrary, watermark: 1, items: [pending], hasMore: false });
    vi.mocked(getPhotoSnapshot).mockResolvedValue(pending);
    const store = createPhotoCatalogStore(db, publicLibrary.capabilities);
    const page = await store.page(IDS.userA, { filter: { sort: "added-desc", lifecycle: "active" }, watermark: null, after: null, limit: 10 });
    expect(page?.items[0]?.media).toEqual({ state: "pending" });
    expect((await store.photo(IDS.userA, IDS.photo))?.photo.media).toEqual({ state: "pending" });
  });
});
