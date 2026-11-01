import { describe, expect, it, vi } from "vitest";
import { IDS, library, pendingMediaPhoto, readyPhoto, storedPhoto } from "../../../../../packages/photo-library-contract/fixtures/v1";
import type { Photo, PhotoInfo, PhotoPage } from "../../../../../packages/photo-library-contract/src/v1";
import { catalogResponse, createPhotoCatalogApi } from "./api";
import type { PhotoCatalogAfter, PhotoCatalogFilter, PhotoCatalogStore } from "./types";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const SECRET = new Uint8Array(32).fill(19);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const SECOND_ID = "99999999-9999-4999-8999-999999999999";
const SECOND_PHOTO: Photo = { ...readyPhoto, id: SECOND_ID, fileName: "second.jpg", addedAt: "2026-11-02T00:00:00.000Z" };

function setup() {
  let currentNow = NOW;
  let rows: Array<{ sequence: number; photo: Photo }> = [
    { sequence: 1, photo: { ...readyPhoto, addedAt: "2026-10-30T00:00:00.000Z" } },
    { sequence: 2, photo: SECOND_PHOTO },
  ];
  const store: PhotoCatalogStore = {
    library: vi.fn(async (owner) => owner === IDS.userA ? { ...library } : null),
    page: vi.fn(async (owner, input) => {
      if (owner !== IDS.userA) return null;
      const watermark = input.watermark ?? Math.max(0, ...rows.map((row) => row.sequence));
      let matching = rows.filter((row) => row.sequence <= watermark).map((row) => row.photo).filter((photo) => matches(photo, input.filter));
      matching.sort((a, b) => compare(a, b, input.filter.sort));
      if (input.after) matching = matching.filter((photo) => after(photo, input.after!, input.filter.sort));
      const items = matching.slice(0, input.limit);
      return { library: { ...library }, watermark, items, hasMore: matching.length > items.length };
    }),
    photo: vi.fn(async (owner, id) => owner === IDS.userA && id === IDS.photo ? { photo: { ...readyPhoto }, library: { id: library.id, owner: library.owner, state: library.state, revision: library.revision } } : null),
    info: vi.fn(async (owner, id): Promise<PhotoInfo | null> => owner === IDS.userA && id === IDS.photo ? { camera: null, width: 3000, height: 2000 } : null),
    lookup: vi.fn(async (owner, hashes) => owner === IDS.userA && hashes.includes(HASH_A)
      ? [{ sha256: HASH_A, photoId: IDS.photo, recipeRevision: 0 }] : []),
  };
  const api = createPhotoCatalogApi({ store, cursorSecret: SECRET, now: () => currentNow });
  return { api, store, add(photo: Photo, sequence: number) { rows = [...rows, { photo, sequence }]; }, setNow(value: number) { currentNow = value; } };
}

function matches(photo: Photo, filter: PhotoCatalogFilter) {
  return photo.lifecycle === filter.lifecycle
    && (!filter.formats?.length || filter.formats.includes(photo.format))
    && (filter.edited === undefined || filter.edited === photo.hasEdits);
}

function compare(a: Photo, b: Photo, sort: PhotoCatalogFilter["sort"]) {
  if (sort === "captured-desc") {
    if (a.capturedAt === null && b.capturedAt !== null) return 1;
    if (a.capturedAt !== null && b.capturedAt === null) return -1;
    if (a.capturedAt !== b.capturedAt) return (b.capturedAt ?? "").localeCompare(a.capturedAt ?? "");
  }
  const added = b.addedAt.localeCompare(a.addedAt);
  return added || b.id.localeCompare(a.id);
}

function after(photo: Photo, cursor: PhotoCatalogAfter, sort: PhotoCatalogFilter["sort"]) {
  const cursorPhoto: Photo = cursor.sort === "added-desc"
    ? { ...storedPhoto, id: cursor.id, addedAt: cursor.addedAt }
    : { ...storedPhoto, id: cursor.id, addedAt: cursor.addedAt, capturedAt: cursor.capturedAt };
  return compare(photo, cursorPhoto, sort) > 0;
}

function withLargeWorkingCopy(photo: Photo, size: number, id: string): Photo {
  if (photo.media.state !== "ready") throw new Error("fixture must have ready media");
  return {
    ...photo,
    media: { ...photo.media, workingCopy: { asset: { ...photo.original, id, kind: "working-copy" }, baseVersion: "base", encoding: "jpeg8", meta: { synthetic: "x".repeat(size) } } },
  };
}

function cursorOf(result: PhotoPage) {
  if (!result.nextCursor) throw new Error("expected next page cursor");
  return result.nextCursor;
}

describe("photo catalog owner and pagination contract", () => {
  it("returns empty/single/multi-page results and carries the creation watermark through a signed cursor", async () => {
    const f = setup();
    const empty = await f.api.list(IDS.userA, new URL("https://editor.synthetic.invalid/api/photo/v1/photos?lifecycle=trashed"));
    expect(empty.value?.items).toEqual([]); expect(empty.value?.nextCursor).toBeNull();

    const first = await f.api.list(IDS.userA, new URL("https://editor.synthetic.invalid/api/photo/v1/photos?limit=1"));
    expect(first.value?.items.map((photo) => photo.id)).toEqual([SECOND_ID]);
    expect(first.value?.nextCursor).toBeTruthy();
    expect(vi.mocked(f.store.page).mock.calls[0]?.[0]).toBe(IDS.userA);

    const inserted: Photo = { ...readyPhoto, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", addedAt: "2026-11-03T00:00:00.000Z" };
    f.add(inserted, 3);
    const nextUrl = new URL("https://editor.synthetic.invalid/api/photo/v1/photos");
    nextUrl.searchParams.set("limit", "1"); nextUrl.searchParams.set("cursor", cursorOf(first.value!));
    const second = await f.api.list(IDS.userA, nextUrl);
    expect(second.value?.items.map((photo) => photo.id)).toEqual([IDS.photo]);
    expect(second.value?.nextCursor).toBeNull();
    expect(vi.mocked(f.store.page).mock.calls[2]?.[1]).toMatchObject({ watermark: 2, limit: 1, after: { id: SECOND_ID } });

    await expect(f.api.list("synthetic-user-b", new URL("https://editor.synthetic.invalid/api/photo/v1/photos"))).rejects.toMatchObject({ code: "not_found" });
  });

  it("binds cursors to owner, normalized filters, sort and expiry", async () => {
    const f = setup();
    const first = await f.api.list(IDS.userA, new URL("https://editor.synthetic.invalid/api/photo/v1/photos?limit=1&formats=jpeg&sort=added-desc"));
    const token = cursorOf(first.value!);
    expect(token).not.toContain(IDS.userA);
    const forOwnerB = new URL("https://editor.synthetic.invalid/api/photo/v1/photos"); forOwnerB.searchParams.set("cursor", token);
    await expect(f.api.list("synthetic-user-b", forOwnerB)).rejects.toMatchObject({ code: "invalid_cursor" });
    const wrongFilter = new URL("https://editor.synthetic.invalid/api/photo/v1/photos?formats=raw"); wrongFilter.searchParams.set("cursor", token);
    await expect(f.api.list(IDS.userA, wrongFilter)).rejects.toMatchObject({ code: "invalid_cursor" });
    const tampered = new URL("https://editor.synthetic.invalid/api/photo/v1/photos"); tampered.searchParams.set("cursor", `${token.slice(0, -1)}x`);
    await expect(f.api.list(IDS.userA, tampered)).rejects.toMatchObject({ code: "invalid_cursor" });

    const expiring = setup();
    const cursor = cursorOf((await expiring.api.list(IDS.userA, new URL("https://editor.synthetic.invalid/?limit=1"))).value!);
    const clock = NOW + 901_000;
    const expiredApi = createPhotoCatalogApi({ store: expiring.store, cursorSecret: SECRET, now: () => clock });
    const expiredUrl = new URL("https://editor.synthetic.invalid/"); expiredUrl.searchParams.set("cursor", cursor);
    await expect(expiredApi.list(IDS.userA, expiredUrl)).rejects.toMatchObject({ code: "cursor_expired" });
  });

  it("rejects unknown, repeated scalar, out-of-range and malformed filters", async () => {
    const f = setup();
    for (const query of ["owner=synthetic-user-a", "limit=1&limit=2", "limit=101", "sort=added", "edited=yes", "formats=gif"]) {
      await expect(f.api.list(IDS.userA, new URL(`https://editor.synthetic.invalid/?${query}`))).rejects.toMatchObject({ code: "invalid_request" });
    }
    await expect(f.api.list(IDS.userA, new URL("https://editor.synthetic.invalid/?cursor="))).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(f.store.page).not.toHaveBeenCalled();
  });

  it("uses owner-scoped ETags and private no-store responses for conditional reads", async () => {
    const f = setup();
    const url = new URL("https://editor.synthetic.invalid/api/photo/v1/photos");
    const first = await f.api.list(IDS.userA, url);
    const second = await f.api.list(IDS.userA, url, first.etag);
    expect(second.status).toBe(304); expect(second.value).toBeNull();
    expect(first.etag).toMatch(/^"photo-[a-f0-9]{32}"$/);
    const response = catalogResponse(second);
    expect(response.status).toBe(304); expect(response.body).toBeNull();
    for (const [key, value] of Object.entries({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" })) {
      expect(response.headers.get(key)).toBe(value);
    }
    expect(response.headers.get("etag")).toBe(first.etag);
  });

  it("refreshes a page representation when its short-lived next cursor changes", async () => {
    const f = setup();
    const url = new URL("https://editor.synthetic.invalid/?limit=1");
    const first = await f.api.list(IDS.userA, url);
    expect(first.value?.nextCursor).toBeTruthy();
    f.setNow(NOW + 1000);
    const refreshed = await f.api.list(IDS.userA, url, first.etag);
    expect(refreshed.status).toBe(200);
    expect(refreshed.etag).not.toBe(first.etag);
  });

  it("keeps the full response under 4 MiB by advancing from the last included row", async () => {
    const f = setup();
    let settingsSerializations = 0;
    const settings = { ...readyPhoto.recipe.settings };
    Object.defineProperty(settings, "exposure", { enumerable: true, get: () => { settingsSerializations += 1; return 0; } });
    const many = Array.from({ length: 100 }, (_, index) => withLargeWorkingCopy({ ...readyPhoto,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, recipe: { ...readyPhoto.recipe, settings } },
    58_000, `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`));
    vi.mocked(f.store.page).mockResolvedValue({ library, watermark: 100, items: many, hasMore: false });
    const result = await f.api.list(IDS.userA, new URL("https://editor.synthetic.invalid/?limit=100"));
    expect(result.value?.items.length).toBeGreaterThan(0);
    expect(result.value!.items.length).toBeLessThan(100);
    expect(result.value?.nextCursor).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(result.value))).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(settingsSerializations).toBe(100 + result.value!.items.length);
    expect(result.value?.nextCursor).toBeTruthy();
  });

  it("fails closed when one working-copy metadata object exceeds its contract cap", async () => {
    const f = setup();
    const oversized = withLargeWorkingCopy(readyPhoto, 70_000, "10000000-0000-4000-8000-000000000001");
    vi.mocked(f.store.page).mockResolvedValue({ library, watermark: 2, items: [oversized], hasMore: false });
    await expect(f.api.list(IDS.userA, new URL("https://editor.synthetic.invalid/"))).rejects.toMatchObject({ code: "temporarily_unavailable" });
  });
});

describe("photo catalog serialization and lookup", () => {
  it("whitelists photo, nested asset, library capability and info fields", async () => {
    const f = setup();
    const leakedPhoto = { ...readyPhoto, privateColumn: "synthetic-locator", original: { ...readyPhoto.original, objectKey: "photo/final/private" } } as Photo;
    vi.mocked(f.store.photo).mockResolvedValue({ photo: leakedPhoto, library: { id: library.id, owner: library.owner, state: library.state, revision: 7 } });
    const photo = await f.api.photo(IDS.userA, IDS.photo);
    expect(JSON.stringify(photo.value)).not.toContain("privateColumn"); expect(JSON.stringify(photo.value)).not.toContain("objectKey");

    vi.mocked(f.store.library).mockResolvedValue({ ...library, privateColumn: "synthetic-secret" } as typeof library);
    const personal = await f.api.library(IDS.userA);
    expect(JSON.stringify(personal.value)).not.toContain("privateColumn");

    vi.mocked(f.store.info).mockResolvedValue({ width: 3000, gps: null, privateColumn: "photo/final/private" } as PhotoInfo);
    const info = await f.api.info(IDS.userA, IDS.photo);
    expect(info.value).toEqual({ width: 3000, gps: null });
  });

  it("preserves pending media in photo detail", async () => {
    const f = setup();
    vi.mocked(f.store.photo).mockResolvedValue({ photo: pendingMediaPhoto, library: { id: library.id,
      owner: library.owner, state: library.state, revision: library.revision } });
    expect((await f.api.photo(IDS.userA, IDS.photo)).value?.media).toEqual({ state: "pending" });
  });

  it("applies the working-copy metadata contract cap to photo detail as well as lists", async () => {
    const f = setup();
    const oversized = withLargeWorkingCopy(readyPhoto, 70_000, "10000000-0000-4000-8000-000000000002");
    vi.mocked(f.store.photo).mockResolvedValue({ photo: oversized, library: { id: library.id, owner: library.owner, state: library.state, revision: library.revision } });
    await expect(f.api.photo(IDS.userA, IDS.photo)).rejects.toMatchObject({ code: "temporarily_unavailable" });
  });

  it("checks photo ownership before info lookup and preserves not-found privacy", async () => {
    const f = setup();
    await expect(f.api.photo("synthetic-user-b", IDS.photo)).rejects.toMatchObject({ code: "not_found" });
    await expect(f.api.info("synthetic-user-b", IDS.photo)).rejects.toMatchObject({ code: "not_found" });
    expect(f.store.info).not.toHaveBeenCalled();
  });

  it("blocks reads once the owner library is deleting", async () => {
    const f = setup();
    vi.mocked(f.store.library).mockResolvedValue({ ...library, state: "deleting" });
    vi.mocked(f.store.page).mockResolvedValue({ library: { ...library, state: "deleting" }, watermark: 2, items: [], hasMore: false });
    vi.mocked(f.store.photo).mockResolvedValue({ photo: readyPhoto, library: { id: library.id, owner: library.owner, state: "deleting", revision: library.revision } });

    await expect(f.api.library(IDS.userA)).rejects.toMatchObject({ code: "account_deleting" });
    await expect(f.api.list(IDS.userA, new URL("https://editor.synthetic.invalid/"))).rejects.toMatchObject({ code: "account_deleting" });
    await expect(f.api.photo(IDS.userA, IDS.photo)).rejects.toMatchObject({ code: "account_deleting" });
    await expect(f.api.info(IDS.userA, IDS.photo)).rejects.toMatchObject({ code: "account_deleting" });
    await expect(f.api.lookup(IDS.userA, { sha256s: [HASH_A] })).rejects.toMatchObject({ code: "account_deleting" });
    expect(f.store.info).not.toHaveBeenCalled(); expect(f.store.lookup).not.toHaveBeenCalled();
  });

  it("bounds hash lookup, deduplicates inputs and returns only requested metadata", async () => {
    const f = setup();
    const response = await f.api.lookup(IDS.userA, { sha256s: [HASH_A, HASH_A, HASH_B] });
    expect(f.store.lookup).toHaveBeenCalledWith(IDS.userA, [HASH_A, HASH_B]);
    expect(response).toEqual({ matches: [{ sha256: HASH_A, photoId: IDS.photo, recipeRevision: 0 }] });
    for (const body of [{ sha256s: ["bad"] }, { sha256s: Array(101).fill(HASH_A) }, { sha256s: [HASH_A], owner: IDS.userA }]) {
      await expect(f.api.lookup(IDS.userA, body)).rejects.toMatchObject({ code: "invalid_request" });
    }
  });
});
