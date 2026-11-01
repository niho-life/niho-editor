import { describe, expect, it, vi } from "vitest";
import { HASH, IDS, library, readyPhoto } from "../../../../../packages/photo-library-contract/fixtures/v1";
import type { NamedVersion, Photo, VersionSet } from "../../../../../packages/photo-library-contract/src/v1";
import { createPhotoRecipesApi, PhotoRecipeError } from "./api";
import type { PhotoRecipeDeps, PhotoRecipeSnapshot, PhotoRecipeStore } from "./types";

const KEY = "synthetic_recipe_key_01";
const futurePhoto: Photo = { ...readyPhoto, recipe: { ...readyPhoto.recipe, revision: 5, settings: { ...readyPhoto.recipe.settings, v: 10, futureField: { keep: true } } } };

function arrange() {
  let photo: Photo = { ...readyPhoto };
  let versions: VersionSet = { revision: 7, versions: [] };
  const snapshot = (): PhotoRecipeSnapshot => ({
    photo,
    library: { id: library.id, owner: library.owner, state: library.state, revision: library.revision, capabilities: library.capabilities },
  });
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
    putVersions: vi.fn<PhotoRecipeStore["putVersions"]>(async (owner, id, input) => {
      if (owner !== IDS.userA || id !== IDS.photo) return null;
      versions = { revision: input.expectedRevision + 1, versions: input.versions.map((item) => ({
        id: item.id, name: item.name, kind: item.kind, createdAt: "2026-11-01T12:00:00.000Z",
        recipe: { revision: 0, ...item.recipe, updatedAt: "2026-11-01T12:00:00.000Z" },
      })) };
      return { versions, replayed: false };
    }),
  };
  const validator = { validate: vi.fn<PhotoRecipeDeps["validator"]["validate"]>(async () => ({ settingsSha256: HASH.settings, maskSurfaceIds: [] })) };
  const deps: PhotoRecipeDeps = { store, validator };
  return { api: createPhotoRecipesApi(deps), store, validator, setPhoto(value: Photo) { photo = value; }, setVersions(value: VersionSet) { versions = value; } };
}

function recipeBody(expectedRevision = 0) {
  return { expectedRevision, settings: { ...readyPhoto.recipe.settings, exposure: 0.25 }, baseVersion: null };
}

function version(id: string = IDS.job): NamedVersion {
  return { id, name: "Before edit", kind: "named", createdAt: "2026-10-31T00:00:00.000Z",
    recipe: { ...readyPhoto.recipe, revision: 0, settingsSha256: "e".repeat(64), maskSurfaceIds: ["f".repeat(64)] } };
}

describe("photo recipe CAS contract", () => {
  it("validates with the pinned SDK port and commits only server-computed recipe metadata", async () => {
    const f = arrange();
    const receipt = await f.api.putRecipe(IDS.userA, IDS.photo, recipeBody(), KEY);
    expect(receipt.replayed).toBe(false);
    expect(receipt.value.recipe.revision).toBe(1);
    expect(receipt.value.recipe.settingsSha256).toBe(HASH.settings);
    expect(f.validator.validate).toHaveBeenCalledWith(recipeBody().settings, expect.objectContaining({ photo: readyPhoto, library: expect.any(Object) }));
    expect(f.store.putRecipe).toHaveBeenCalledWith(IDS.userA, IDS.photo, expect.objectContaining({
      expectedRevision: 0, key: KEY, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      recipe: expect.objectContaining({ settingsSha256: HASH.settings, baseVersion: null, maskSurfaceIds: [] }),
    }));
  });

  it("rejects invalid envelope, key, depth, and oversized recipe before a write", async () => {
    const f = arrange();
    const invalid = [
      [{ ...recipeBody(), ownerId: IDS.userB }, KEY],
      [{ ...recipeBody(), baseVersion: "stale" }, KEY],
      [{ ...recipeBody(), settings: { ...recipeBody().settings, value: "x".repeat(1_100_000) } }, KEY],
      [{ ...recipeBody(), settings: { ...recipeBody().settings, invalidUnicode: "\ud800" } }, KEY],
      [recipeBody(), "short"],
    ] as const;
    for (const [body, key] of invalid) await expect(f.api.putRecipe(IDS.userA, IDS.photo, body, key)).rejects.toBeInstanceOf(PhotoRecipeError);
    let deep: unknown = true;
    for (let i = 0; i < 35; i += 1) deep = { nested: deep };
    await expect(f.api.putRecipe(IDS.userA, IDS.photo, { ...recipeBody(), settings: { ...recipeBody().settings, deep } }, KEY))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(f.store.putRecipe).not.toHaveBeenCalled();
  });

  it("returns the current recipe revision on a stale write without validating or mutating", async () => {
    const f = arrange();
    vi.mocked(f.store.putRecipe).mockRejectedValue(new PhotoRecipeError("revision_conflict", 4));
    await expect(f.api.putRecipe(IDS.userA, IDS.photo, recipeBody(3), KEY)).rejects.toMatchObject({ code: "revision_conflict", currentRevision: 4 });
    expect(f.validator.validate).toHaveBeenCalledOnce(); expect(f.store.putRecipe).toHaveBeenCalledOnce();
  });

  it("replays the current photo for a successful idempotent retry before stale revision validation", async () => {
    const f = arrange();
    const current = { ...readyPhoto, recipe: { ...readyPhoto.recipe, revision: 1 } };
    vi.mocked(f.store.replayRecipe).mockResolvedValue({
      photo: current, library: { id: library.id, owner: library.owner, state: library.state, revision: library.revision, capabilities: library.capabilities },
    });
    const result = await f.api.putRecipe(IDS.userA, IDS.photo, recipeBody(0), KEY);
    expect(result.replayed).toBe(true); expect(result.value.recipe.revision).toBe(1);
    expect(f.store.photo).not.toHaveBeenCalled(); expect(f.validator.validate).not.toHaveBeenCalled(); expect(f.store.putRecipe).not.toHaveBeenCalled();
  });

  it("fails closed for foreign, trashed, deleting, and SDK-incompatible photos", async () => {
    const foreign = arrange();
    await expect(foreign.api.putRecipe(IDS.userB, IDS.photo, recipeBody(), KEY)).rejects.toMatchObject({ code: "not_found" });

    const trashed = arrange(); trashed.setPhoto({ ...readyPhoto, lifecycle: "trashed" });
    await expect(trashed.api.putRecipe(IDS.userA, IDS.photo, recipeBody(), KEY)).rejects.toMatchObject({ code: "photo_trashed" });

    const deleting = arrange(); deleting.setPhoto(readyPhoto);
    vi.mocked(deleting.store.photo).mockImplementation(async () => ({ photo: readyPhoto, library: { ...library, state: "deleting" } }));
    await expect(deleting.api.putRecipe(IDS.userA, IDS.photo, recipeBody(), KEY)).rejects.toMatchObject({ code: "account_deleting" });

    const incompatible = arrange(); vi.mocked(incompatible.validator.validate).mockResolvedValue(null);
    await expect(incompatible.api.putRecipe(IDS.userA, IDS.photo, recipeBody(), KEY)).rejects.toMatchObject({ code: "unsupported_settings" });
    expect(incompatible.store.putRecipe).not.toHaveBeenCalled();
  });

  it("requires complete valid SDK mask references and passes them to the atomic P02 writer", async () => {
    const f = arrange();
    vi.mocked(f.validator.validate).mockResolvedValue({ settingsSha256: HASH.maskedSettings, maskSurfaceIds: ["d".repeat(64)] });
    const receipt = await f.api.putRecipe(IDS.userA, IDS.photo, recipeBody(), KEY);
    expect(receipt.value.recipe.maskSurfaceIds).toEqual(["d".repeat(64)]);
    expect(f.store.putRecipe).toHaveBeenCalledWith(IDS.userA, IDS.photo, expect.objectContaining({
      recipe: expect.objectContaining({ maskSurfaceIds: ["d".repeat(64)], settingsSha256: HASH.maskedSettings }),
    }));

    const invalid = arrange(); vi.mocked(invalid.validator.validate).mockResolvedValue({ settingsSha256: HASH.settings, maskSurfaceIds: ["bad"] });
    await expect(invalid.api.putRecipe(IDS.userA, IDS.photo, recipeBody(), KEY)).rejects.toMatchObject({ code: "unsupported_settings" });
    expect(invalid.store.putRecipe).not.toHaveBeenCalled();
  });
});

describe("photo recipe version CAS contract", () => {
  it("reads unsupported historical settings without dropping unknown fields", async () => {
    const f = arrange();
    f.setVersions({ revision: 2, versions: [{ ...version(), recipe: futurePhoto.recipe }] });
    const result = await f.api.getVersions(IDS.userA, IDS.photo);
    expect(result.versions[0]?.recipe.settings).toMatchObject({ v: 10, futureField: { keep: true } });
    expect(f.validator.validate).not.toHaveBeenCalled();
  });

  it("uses VersionSet.revision, ignores client hash/ref metadata, and delegates atomic fences to P02", async () => {
    const f = arrange();
    const receipt = await f.api.putVersions(IDS.userA, IDS.photo, { expectedRevision: 7, versions: [version()] }, KEY);
    expect(receipt.replayed).toBe(false); expect(receipt.value.revision).toBe(8);
    expect(f.store.putVersions).toHaveBeenCalledWith(IDS.userA, IDS.photo, expect.objectContaining({
      expectedRevision: 7, key: KEY, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      versions: [expect.objectContaining({ recipe: expect.objectContaining({ settingsSha256: HASH.settings, maskSurfaceIds: [] }) })],
    }));
  });

  it("rejects an oversized combined VersionSet before the P02 write", async () => {
    const f = arrange();
    const settings = { ...readyPhoto.recipe.settings, note: "x".repeat(900_000) };
    const versions = Array.from({ length: 5 }, (_, index) => {
      const id: string = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      return { ...version(id), recipe: { ...version().recipe, settings } };
    });

    await expect(f.api.putVersions(IDS.userA, IDS.photo, { expectedRevision: 7, versions }, KEY))
      .rejects.toMatchObject({ code: "request_too_large" });
    expect(f.store.putVersions).not.toHaveBeenCalled();
  });

  it("returns version revision conflicts and rejects duplicate IDs/unsupported recipes before write", async () => {
    const stale = arrange();
    vi.mocked(stale.store.putVersions).mockRejectedValue(new PhotoRecipeError("revision_conflict", 9));
    await expect(stale.api.putVersions(IDS.userA, IDS.photo, { expectedRevision: 8, versions: [] }, KEY))
      .rejects.toMatchObject({ code: "revision_conflict", currentRevision: 9 });
    expect(stale.store.putVersions).toHaveBeenCalledOnce();

    const duplicate = arrange();
    await expect(duplicate.api.putVersions(IDS.userA, IDS.photo, { expectedRevision: 7, versions: [version(), version()] }, KEY))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(duplicate.store.putVersions).not.toHaveBeenCalled();

    const emptyName = arrange();
    await expect(emptyName.api.putVersions(IDS.userA, IDS.photo, {
      expectedRevision: 7, versions: [{ ...version(), name: "" }],
    }, KEY)).rejects.toMatchObject({ code: "invalid_request" });
    expect(emptyName.store.putVersions).not.toHaveBeenCalled();

    const future = arrange(); vi.mocked(future.validator.validate).mockResolvedValue(null);
    await expect(future.api.putVersions(IDS.userA, IDS.photo, { expectedRevision: 7, versions: [version()] }, KEY))
      .rejects.toMatchObject({ code: "unsupported_settings" });
    expect(future.store.putVersions).not.toHaveBeenCalled();
  });
});
