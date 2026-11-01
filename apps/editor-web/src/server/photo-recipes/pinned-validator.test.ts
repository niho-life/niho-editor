// @vitest-environment node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { supportsDevelopSettingsWrite } from "niho-photo-contract";
import {
  initSync,
  validateSettings,
  version,
} from "niho-photo-develop-engine-runtime/niho_develop_wasm-0.27.0.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { HASH, IDS, library, maskedPhoto, readyPhoto } from "../../../../../packages/photo-library-contract/fixtures/v1";
import type { Json, JsonObject, Photo, RecipeDocument } from "../../../../../packages/photo-library-contract/src/v1";
import {
  createPinnedPhotoRecipeValidator,
  type PinnedPhotoRecipeValidatorTestPorts,
  verifyPinnedPhotoRecipeRuntimeForTest,
} from "./pinned-validator";
import type { PhotoRecipeSnapshot, PhotoRecipeValidator } from "./types";

const GLUE = "niho-photo-develop-engine-runtime/niho_develop_wasm-0.27.0.js";
const WASM = "niho-photo-develop-engine-runtime/niho_develop_wasm_bg-0.27.0.wasm";
const MANIFEST = "niho-photo-develop-engine-runtime/manifest";
const ENGINE_VERSION = "niho-develop 0.27.0 (engine niho-14)";
const RASTER_BASE = "raster.ci2.p2.e2.icc-srgb";

function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(",")}}`;
}

function settingsSha256(settings: RecipeDocument["settings"]): string {
  return createHash("sha256").update(canonicalJson(settings)).digest("hex");
}

function snapshot(photo: Photo = readyPhoto, source = library): PhotoRecipeSnapshot {
  return {
    photo,
    library: { id: source.id, owner: source.owner, state: source.state, revision: source.revision, capabilities: source.capabilities },
  };
}

function canonicalRaster(settings: RecipeDocument["settings"] = { ...readyPhoto.recipe.settings, base: RASTER_BASE }): PhotoRecipeSnapshot {
  const media = readyPhoto.media;
  if (media.state !== "ready") throw new Error("synthetic fixture media must be ready");
  const workingAsset = {
    ...readyPhoto.original,
    id: IDS.mask,
    kind: "working-copy" as const,
    sizeBytes: 2 * 1024 ** 2,
    contentType: "image/jpeg",
    width: 2560,
    height: 1707,
  };
  return snapshot({
    ...readyPhoto,
    recipe: { ...readyPhoto.recipe, settings, baseVersion: RASTER_BASE },
    media: {
      ...media,
      state: "ready",
      workingCopy: {
        asset: workingAsset,
        baseVersion: RASTER_BASE,
        encoding: "jpeg8",
        meta: { kind: "raster", encoding: "jpeg8" },
      },
    },
  });
}

async function actualAsset(_asset: string, specifier: string): Promise<Uint8Array> {
  return readFile(new URL(import.meta.resolve(specifier)));
}

function fakeRuntime(reportedVersion = ENGINE_VERSION): NonNullable<PinnedPhotoRecipeValidatorTestPorts["runtime"]> {
  return {
    initSync: vi.fn((input: Parameters<typeof initSync>[0]) => {
      void input;
      return {} as ReturnType<typeof initSync>;
    }),
    validateSettings,
    version: vi.fn(() => reportedVersion),
  };
}

describe("pinned PhotoRecipeValidator with real SDK 0.1.7 runtime", () => {
  let validator: PhotoRecipeValidator;

  beforeAll(async () => { validator = await createPinnedPhotoRecipeValidator(); });

  it("caches the verified real runtime and accepts neutral/edited small direct JPEG settings", async () => {
    expect(await createPinnedPhotoRecipeValidator()).toBe(validator);
    await expect(validator.validate(readyPhoto.recipe.settings, snapshot())).resolves.toEqual({
      settingsSha256: HASH.settings,
      maskSurfaceIds: [],
    });
    const edited = { ...readyPhoto.recipe.settings, exposure: 0.25 };
    await expect(validator.validate(edited, snapshot())).resolves.toEqual({
      settingsSha256: settingsSha256(edited),
      maskSurfaceIds: [],
    });
    const png = {
      ...readyPhoto,
      format: "png" as const,
      fileName: "synthetic-photo.png",
      original: { ...readyPhoto.original, contentType: "image/png" },
    };
    await expect(validator.validate(edited, snapshot(png))).resolves.toEqual({
      settingsSha256: settingsSha256(edited),
      maskSurfaceIds: [],
    });
    const legacyNiho3Raster = { ...readyPhoto.recipe.settings, engine: "niho-3", look: "niho-standard-2" };
    await expect(validator.validate(legacyNiho3Raster, snapshot())).resolves.toEqual({
      settingsSha256: settingsSha256(legacyNiho3Raster),
      maskSurfaceIds: [],
    });
  });

  it("passes original JSON to real WASM without normalizing absent look or mutating -0", async () => {
    const settings: RecipeDocument["settings"] = {
      v: 1, engine: "niho-14", base: null, exposure: -0, contrast: 0, saturation: 0,
      relativeTemperature: 0, relativeTint: 0, whiteBalance: { mode: "asShot" },
    };
    const before = structuredClone(settings);
    const result = await validator.validate(settings, snapshot());
    expect(result).toEqual({ settingsSha256: settingsSha256(settings), maskSurfaceIds: [] });
    expect(settings).toEqual(before);
    expect(Object.hasOwn(settings, "look")).toBe(false);
    expect(Object.is(settings.exposure, -0)).toBe(true);
  });

  it("accepts canonical raster metadata and preserves the original canonical hash", async () => {
    const settings = { ...readyPhoto.recipe.settings, base: RASTER_BASE, exposure: -0.5 };
    const result = await validator.validate(settings, canonicalRaster(settings));
    expect(result).toEqual({ settingsSha256: settingsSha256(settings), maskSurfaceIds: [] });
  });

  it("extracts unique sorted lowercase external mask surface IDs without changing the settings hash", async () => {
    const second = "0".repeat(64);
    const settings: RecipeDocument["settings"] = {
      ...maskedPhoto.recipe.settings,
      masks: [
        ...(maskedPhoto.recipe.settings.masks as Json[]),
        { id: "synthetic-subject", kind: "subject", surface: { id: second, width: 2, height: 1 }, adjust: { contrast: 2 } },
        { id: "synthetic-brush", kind: "brush", surface: { id: HASH.mask, width: 2, height: 1 }, adjust: { exposure: 0.25 } },
      ],
    };
    const result = await validator.validate(settings, snapshot(maskedPhoto));
    expect(result).toEqual({ settingsSha256: settingsSha256(settings), maskSurfaceIds: [second, HASH.mask].sort() });
    await expect(validator.validate(maskedPhoto.recipe.settings, snapshot(maskedPhoto))).resolves.toEqual({
      settingsSha256: HASH.maskedSettings,
      maskSurfaceIds: [HASH.mask],
    });
  });

  it.each([
    ["unknown root", { ...readyPhoto.recipe.settings, futureFeature: { amount: 1 } }],
    ["unknown nested", { ...readyPhoto.recipe.settings, whiteBalance: { mode: "asShot", future: true } }],
    ["unknown variant", { ...readyPhoto.recipe.settings, whiteBalance: { mode: "future" } }],
    ["unknown geometry.aspect", { ...readyPhoto.recipe.settings, v: 2, geometry: { aspect: "future:1" } }],
    ["future version", { ...readyPhoto.recipe.settings, v: 10 }],
    ["future engine", { ...readyPhoto.recipe.settings, engine: "niho-99" }],
  ])("rejects %s settings", async (_name, settings) => {
    await expect(validator.validate(settings, snapshot())).resolves.toBeNull();
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["out-of-range", 1_000_000],
  ])("rejects %s numeric input; the SDK write gate is not treated as the numeric validator", async (name, exposure) => {
    const settings = { ...readyPhoto.recipe.settings, exposure };
    if (name === "out-of-range") expect(supportsDevelopSettingsWrite(settings)).toBe(true);
    await expect(validator.validate(settings, snapshot())).resolves.toBeNull();
  });

  it("fails closed for missing/mismatched working copy, unavailable/future metadata, and signed RAW mismatch", async () => {
    const settings = { ...readyPhoto.recipe.settings, base: RASTER_BASE };
    const valid = canonicalRaster(settings);
    const ready = valid.photo.media.state === "ready" ? valid.photo.media : undefined;
    expect(ready?.workingCopy).not.toBeNull();
    const cases: Photo[] = [
      { ...valid.photo, media: { ...ready!, workingCopy: null } },
      { ...valid.photo, media: { ...ready!, workingCopy: { ...ready!.workingCopy!, baseVersion: "raster.other" } } },
      { ...valid.photo, media: { ...ready!, workingCopy: { ...ready!.workingCopy!, meta: {} } } },
      { ...valid.photo, media: { ...ready!, workingCopy: { ...ready!.workingCopy!, meta: { kind: "raster", encoding: "jpeg8", large: "x".repeat(65_536) } } } },
      { ...valid.photo, media: { ...ready!, workingCopy: { ...ready!.workingCopy!, meta: { kind: "raster", encoding: "future" } } } },
      {
        ...valid.photo,
        recipe: { ...valid.photo.recipe, baseVersion: "raw-apple.d8.p3.e4.cal" },
        media: {
          ...ready!,
          workingCopy: {
            ...ready!.workingCopy!, baseVersion: "raw-apple.d8.p3.e4.cal", encoding: "png16",
            asset: { ...ready!.workingCopy!.asset, contentType: "image/png" },
            meta: { kind: "raster", encoding: "jpeg8" },
          },
        },
      },
    ];
    for (const photo of cases) {
      const input = photo.recipe.baseVersion === RASTER_BASE ? settings : { ...settings, base: photo.recipe.baseVersion };
      await expect(validator.validate(input, snapshot(photo))).resolves.toBeNull();
    }
    await expect(validator.validate(readyPhoto.recipe.settings, valid)).resolves.toBeNull();
  });

  it("fails closed for mixed renderer identity and incompatible direct-original paths", async () => {
    for (const renderer of [
      { ...library.capabilities.renderer, sdkVersion: "0.1.8" },
      { ...library.capabilities.renderer, crateVersion: "0.27.1" },
      { ...library.capabilities.renderer, manifestSha256: "f".repeat(64) },
    ]) {
      const mixed = { ...library, capabilities: { ...library.capabilities, renderer } };
      await expect(validator.validate(readyPhoto.recipe.settings, snapshot(readyPhoto, mixed))).resolves.toBeNull();
    }
    const noGeometry = {
      ...library,
      capabilities: {
        ...library.capabilities,
        renderer: { ...library.capabilities.renderer, features: ["masks"] },
      },
    };
    const geometry = { ...readyPhoto.recipe.settings, v: 2, geometry: { rotate: 90 } };
    await expect(validator.validate(geometry, snapshot(readyPhoto, noGeometry))).resolves.toBeNull();
    const tooLarge = { ...readyPhoto, original: { ...readyPhoto.original, sizeBytes: 64 * 1024 ** 2 + 1 } };
    const pngTooLarge = {
      ...readyPhoto,
      format: "png" as const,
      original: { ...readyPhoto.original, contentType: "image/png", sizeBytes: 10 * 1024 ** 2 + 1 },
    };
    const tooManyPixels = {
      ...readyPhoto,
      width: 10_000,
      height: 4_001,
      original: { ...readyPhoto.original, width: 10_000, height: 4_001 },
    };
    const heic = { ...readyPhoto, format: "heic" as const };
    const signedOnly = { ...readyPhoto.recipe.settings, engine: "niho-11", look: "niho-standard-5" };
    await expect(validator.validate(readyPhoto.recipe.settings, snapshot(tooLarge))).resolves.toBeNull();
    await expect(validator.validate(readyPhoto.recipe.settings, snapshot(pngTooLarge))).resolves.toBeNull();
    await expect(validator.validate(readyPhoto.recipe.settings, snapshot(tooManyPixels))).resolves.toBeNull();
    await expect(validator.validate(readyPhoto.recipe.settings, snapshot(heic))).resolves.toBeNull();
    await expect(validator.validate(signedOnly, snapshot())).resolves.toBeNull();
  });
});

describe("pinned runtime verification failure paths", () => {
  it.each(["manifest", "glue", "wasm"] as const)("rejects corrupt %s bytes before WASM initialization", async (corrupt) => {
    const runtime = fakeRuntime();
    const readAsset: NonNullable<PinnedPhotoRecipeValidatorTestPorts["readAsset"]> = async (asset, specifier) => {
      const bytes = await actualAsset(asset, specifier);
      if (asset !== corrupt) return bytes;
      const changed = Uint8Array.from(bytes);
      if (asset === "manifest") return Uint8Array.from([...changed, 0x20]);
      changed[0] = (changed[0] ?? 0) ^ 0xff;
      return changed;
    };
    await expect(verifyPinnedPhotoRecipeRuntimeForTest({ readAsset, runtime }))
      .rejects.toThrow("photo recipe validator unavailable");
    expect(runtime.initSync).not.toHaveBeenCalled();
  });

  it("rejects an engine version mismatch after verified bytes and initialization", async () => {
    const runtime = fakeRuntime("niho-develop 0.27.0 (engine niho-future)");
    await expect(verifyPinnedPhotoRecipeRuntimeForTest({ readAsset: actualAsset, runtime }))
      .rejects.toThrow("photo recipe validator unavailable");
    expect(runtime.initSync).toHaveBeenCalledOnce();
    expect(runtime.version).toHaveBeenCalledOnce();
  });

  it("uses only exported runtime asset specifiers", () => {
    expect([MANIFEST, GLUE, WASM].every((specifier) => specifier.startsWith("niho-photo-develop-engine-runtime/"))).toBe(true);
    expect(version()).toBe(ENGINE_VERSION);
  });
});
