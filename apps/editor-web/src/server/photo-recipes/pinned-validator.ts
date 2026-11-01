import "server-only";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  developSettingsOnWorkingCopy,
  isEditableDevelopSettings,
  readDevelopSettings,
  signedWorkingCopyState,
  supportsDevelopSettingsWrite,
  type DevelopSettings,
} from "niho-photo-contract";
import {
  initSync,
  validateSettings,
  version,
} from "niho-photo-develop-engine-runtime/niho_develop_wasm-0.27.0.js";
import baseline from "../../../../../packages/photo-library-contract/sdk-baseline.json";
import { PHOTO_LIMITS, type PhotoAsset, type RecipeDocument, type WorkingCopy } from "../../../../../packages/photo-library-contract/src/v1";
import { clonePhotoJson, photoJsonBytes, photoJsonSha256 } from "./json";
import type { PhotoCanonicalContextResolver, PhotoRecipeValidator, PhotoRecipeSnapshot } from "./types";

const ENGINE = "niho-14";
const CRATE_VERSION = "0.27.0";
const GLUE_FILE = `niho_develop_wasm-${CRATE_VERSION}.js`;
const WASM_FILE = `niho_develop_wasm_bg-${CRATE_VERSION}.wasm`;
const SHA256 = /^[a-f0-9]{64}$/;
const JPEG_DIRECT_MAX_BYTES = 64 * 1024 ** 2;
const OTHER_DIRECT_MAX_BYTES = 10 * 1024 ** 2;
const UNAVAILABLE = "photo recipe validator unavailable";

class CanonicalContextUnavailableError extends Error {}

const ASSET_SPECIFIERS = {
  manifest: "niho-photo-develop-engine-runtime/manifest",
  glue: `niho-photo-develop-engine-runtime/${GLUE_FILE}`,
  wasm: `niho-photo-develop-engine-runtime/${WASM_FILE}`,
} as const;

type RuntimeAsset = keyof typeof ASSET_SPECIFIERS;
type RuntimePort = {
  readonly initSync: typeof initSync;
  readonly validateSettings: typeof validateSettings;
  readonly version: typeof version;
};

/** Test seam: supplied bytes still pass every production digest/size check before initSync. */
export type PinnedPhotoRecipeValidatorTestPorts = {
  readonly readAsset?: (asset: RuntimeAsset, specifier: string) => Promise<Uint8Array>;
  readonly runtime?: RuntimePort;
};

type RuntimeManifest = {
  readonly schemaVersion: number;
  readonly engine: string;
  readonly version: string;
  readonly source: { readonly commit: string };
  readonly files: Record<string, { readonly sha256: string; readonly bytes: number }>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function unavailable(): Error {
  return new Error(UNAVAILABLE);
}

function verifyBytes(bytes: Uint8Array, expected: { readonly sha256: string; readonly bytes: number }): void {
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || !SHA256.test(expected.sha256)
    || bytes.byteLength !== expected.bytes || digest(bytes) !== expected.sha256) throw unavailable();
}

function parseManifest(bytes: Uint8Array): RuntimeManifest {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw unavailable(); }
  if (!record(value) || value.schemaVersion !== 1 || value.engine !== ENGINE || value.version !== CRATE_VERSION
    || !record(value.source) || typeof value.source.commit !== "string" || !record(value.files)) throw unavailable();
  return value as RuntimeManifest;
}

function fileMetadata(manifest: RuntimeManifest, file: string): { readonly sha256: string; readonly bytes: number } {
  const value: unknown = manifest.files[file];
  if (!record(value) || typeof value.sha256 !== "string" || typeof value.bytes !== "number") throw unavailable();
  return value as { readonly sha256: string; readonly bytes: number };
}

async function defaultReadAsset(asset: RuntimeAsset, specifier: string): Promise<Uint8Array> {
  void asset;
  return readFile(new URL(import.meta.resolve(specifier)));
}

function validAsset(asset: PhotoAsset, kind: PhotoAsset["kind"], contentType: string, maxBytes: number, maxEdge?: number): boolean {
  return asset.kind === kind && typeof asset.id === "string" && asset.id.length > 0 && asset.id.length <= 512
    && SHA256.test(asset.sha256) && Number.isSafeInteger(asset.sizeBytes) && asset.sizeBytes > 0 && asset.sizeBytes <= maxBytes
    && asset.contentType === contentType && Number.isSafeInteger(asset.width) && asset.width > 0
    && Number.isSafeInteger(asset.height) && asset.height > 0
    && Number.isSafeInteger(asset.width * asset.height) && asset.width * asset.height <= PHOTO_LIMITS.maxPixels
    && (maxEdge === undefined || Math.max(asset.width, asset.height) <= maxEdge);
}

function rendererMatches(snapshot: PhotoRecipeSnapshot, sdkVersion: string): boolean {
  const renderer = snapshot.library.capabilities.renderer;
  return renderer.sdkVersion === sdkVersion && renderer.crateVersion === CRATE_VERSION
    && renderer.manifestSha256 === baseline.engine.manifest.sha256;
}

function libraryAllows(settings: RecipeDocument["settings"], snapshot: PhotoRecipeSnapshot): boolean {
  const renderer = snapshot.library.capabilities.renderer;
  if (!renderer.settingsVersions.includes(settings.v) || !renderer.engines.includes(settings.engine)) return false;
  if (Object.hasOwn(settings, "geometry") && !renderer.features.includes("geometry")) return false;
  if (Object.hasOwn(settings, "masks") && !renderer.features.includes("masks")) return false;
  return true;
}

function maskSurfaceIds(settings: RecipeDocument["settings"], snapshot: PhotoRecipeSnapshot): readonly string[] | null {
  if (!Object.hasOwn(settings, "masks")) return [];
  if (!Array.isArray(settings.masks)) return null;
  const ids = new Set<string>();
  for (const item of settings.masks) {
    if (!record(item) || typeof item.kind !== "string" || !snapshot.library.capabilities.renderer.maskKinds.includes(item.kind)) return null;
    if (!Object.hasOwn(item, "surface")) continue;
    if (!snapshot.library.capabilities.maskSurfaces || !snapshot.library.capabilities.renderer.maskSurfaces || !record(item.surface)
      || typeof item.surface.id !== "string" || !SHA256.test(item.surface.id)) return null;
    ids.add(item.surface.id.toLowerCase());
  }
  return [...ids].sort();
}

function validNullBase(snapshot: PhotoRecipeSnapshot, settings: DevelopSettings): boolean {
  const { photo } = snapshot;
  if (photo.recipe.baseVersion !== null || settings.base !== null || (photo.format !== "jpeg" && photo.format !== "png")) return false;
  const contentType = photo.format === "jpeg" ? "image/jpeg" : "image/png";
  const maxBytes = photo.format === "jpeg" ? JPEG_DIRECT_MAX_BYTES : OTHER_DIRECT_MAX_BYTES;
  if (!validAsset(photo.original, "original", contentType, maxBytes)
    || photo.original.width !== photo.width || photo.original.height !== photo.height
    || photo.width * photo.height > PHOTO_LIMITS.browserDirectMaxPixels
    || signedWorkingCopyState("", undefined) !== "unsigned") return false;
  developSettingsOnWorkingCopy(settings, "", undefined);
  return true;
}

function validWorkingCopy(working: WorkingCopy, settings: DevelopSettings, baseVersion: string): boolean {
  if (working.baseVersion !== baseVersion) return false;
  const contentType = working.encoding === "png16" ? "image/png" : working.encoding === "jpeg8" ? "image/jpeg" : null;
  if (!contentType || !validAsset(working.asset, "working-copy", contentType, PHOTO_LIMITS.maxFileBytes, PHOTO_LIMITS.workingCopyMaxEdge)) return false;

  const metaValue = clonePhotoJson(working.meta);
  if (!record(metaValue) || photoJsonBytes(metaValue) > PHOTO_LIMITS.maxWorkingCopyMetaBytes
    || (metaValue.kind !== "raw" && metaValue.kind !== "raster")
    || signedWorkingCopyState(baseVersion, metaValue) === "mismatch") return false;
  if ((metaValue.kind === "raw" && working.encoding !== "png16")
    || (metaValue.kind === "raster" && working.encoding !== "jpeg8")) return false;
  developSettingsOnWorkingCopy(settings, baseVersion, metaValue);
  return true;
}

function currentWorkingCopy(snapshot: PhotoRecipeSnapshot): WorkingCopy | null {
  const media = snapshot.photo.media;
  return media.state === "ready" && media.rendererManifestSha256 === baseline.engine.manifest.sha256
    ? media.workingCopy : null;
}

async function canonicalWorkingCopy(
  resolver: PhotoCanonicalContextResolver,
  snapshot: PhotoRecipeSnapshot,
  baseVersion: string,
): Promise<WorkingCopy | null> {
  const expected = {
    ownerId: snapshot.library.owner.userId,
    libraryId: snapshot.library.id,
    photoId: snapshot.photo.id,
    originalAssetId: snapshot.photo.original.id,
    originalSha256: snapshot.photo.original.sha256,
    baseVersion,
    rendererManifestSha256: baseline.engine.manifest.sha256,
  } as const;
  let context: Awaited<ReturnType<PhotoCanonicalContextResolver>>;
  try {
    context = await resolver(expected);
  } catch {
    throw new CanonicalContextUnavailableError();
  }
  if (!context || context.ownerId !== expected.ownerId || context.libraryId !== expected.libraryId
    || context.photoId !== expected.photoId || context.originalAssetId !== expected.originalAssetId
    || context.originalSha256 !== expected.originalSha256 || context.baseVersion !== expected.baseVersion
    || context.rendererManifestSha256 !== expected.rendererManifestSha256) return null;
  return context.workingCopy;
}

function createValidator(runtime: RuntimePort, sdkVersion: string, resolver?: PhotoCanonicalContextResolver): PhotoRecipeValidator {
  return {
    async validate(settings, snapshot) {
      try {
        const original = clonePhotoJson(settings);
        if (!record(original) || photoJsonBytes(original) > PHOTO_LIMITS.maxRecipeBytes) return null;
        const recipe = original as RecipeDocument["settings"];
        if (!rendererMatches(snapshot, sdkVersion) || !libraryAllows(recipe, snapshot)
          || !supportsDevelopSettingsWrite(recipe) || !readDevelopSettings(recipe) || !isEditableDevelopSettings(recipe)) return null;

        const wasmErrors: unknown = JSON.parse(runtime.validateSettings(JSON.stringify(recipe)));
        if (!Array.isArray(wasmErrors) || wasmErrors.length !== 0) return null;
        if (recipe.base !== snapshot.photo.recipe.baseVersion) return null;
        const parsed = recipe as unknown as DevelopSettings;
        let compatible: boolean;
        if (recipe.base === null) {
          compatible = validNullBase(snapshot, parsed);
        } else if (typeof recipe.base === "string" && recipe.base.length > 0) {
          const working = resolver
            ? await canonicalWorkingCopy(resolver, snapshot, recipe.base)
            : currentWorkingCopy(snapshot);
          compatible = working !== null && validWorkingCopy(working, parsed, recipe.base);
        } else {
          compatible = false;
        }
        if (!compatible) return null;

        const surfaces = maskSurfaceIds(recipe, snapshot);
        if (!surfaces) return null;
        return { settingsSha256: photoJsonSha256(original), maskSurfaceIds: surfaces };
      } catch (error) {
        if (error instanceof CanonicalContextUnavailableError) throw unavailable();
        return null;
      }
    },
  };
}

async function verifyRuntime(ports: PinnedPhotoRecipeValidatorTestPorts = {}): Promise<{ readonly runtime: RuntimePort; readonly sdkVersion: string }> {
  try {
    const sdkMatch = /^photo-sdk-v(\d+\.\d+\.\d+)$/.exec(baseline.releaseTag);
    if (!sdkMatch || baseline.sourceCommit.length !== 40 || baseline.engine.version !== ENGINE
      || baseline.engine.crateVersion !== CRATE_VERSION || !SHA256.test(baseline.engine.manifest.sha256)) throw unavailable();
    const readAsset = ports.readAsset ?? defaultReadAsset;
    const runtime = ports.runtime ?? { initSync, validateSettings, version };
    const manifestBytes = await readAsset("manifest", ASSET_SPECIFIERS.manifest);
    verifyBytes(manifestBytes, { sha256: baseline.engine.manifest.sha256, bytes: baseline.engine.manifest.size });
    const manifest = parseManifest(manifestBytes);
    if (manifest.source.commit !== baseline.sourceCommit) throw unavailable();

    const [glueBytes, wasmBytes] = await Promise.all([
      readAsset("glue", ASSET_SPECIFIERS.glue),
      readAsset("wasm", ASSET_SPECIFIERS.wasm),
    ]);
    verifyBytes(glueBytes, fileMetadata(manifest, GLUE_FILE));
    verifyBytes(wasmBytes, fileMetadata(manifest, WASM_FILE));
    runtime.initSync({ module: wasmBytes });
    if (runtime.version() !== `niho-develop ${CRATE_VERSION} (engine ${ENGINE})`) throw unavailable();
    return { runtime, sdkVersion: sdkMatch[1]! };
  } catch {
    throw unavailable();
  }
}

type VerifiedRuntime = Awaited<ReturnType<typeof verifyRuntime>>;
let cachedRuntime: Promise<VerifiedRuntime> | undefined;
let cachedValidator: Promise<PhotoRecipeValidator> | undefined;

async function verifiedRuntime(): Promise<VerifiedRuntime> {
  if (cachedRuntime) return cachedRuntime;
  const pending = verifyRuntime();
  cachedRuntime = pending;
  try { return await pending; } catch (error) {
    if (cachedRuntime === pending) cachedRuntime = undefined;
    throw error;
  }
}

export type PinnedPhotoRecipeValidatorOptions = {
  readonly canonicalContextResolver?: PhotoCanonicalContextResolver;
};

/** Verify and initialize the immutable pinned SDK once. This factory is intentionally not wired to routes yet. */
export async function createPinnedPhotoRecipeValidator(options: PinnedPhotoRecipeValidatorOptions = {}): Promise<PhotoRecipeValidator> {
  if (options.canonicalContextResolver) {
    const verified = await verifiedRuntime();
    return createValidator(verified.runtime, verified.sdkVersion, options.canonicalContextResolver);
  }
  if (cachedValidator) return cachedValidator;
  const pending = verifiedRuntime().then((verified) => createValidator(verified.runtime, verified.sdkVersion));
  cachedValidator = pending;
  try { return await pending; } catch (error) {
    if (cachedValidator === pending) cachedValidator = undefined;
    throw error;
  }
}

/** Isolated verification seam for corruption/version tests; it cannot produce an injected validator. */
export async function verifyPinnedPhotoRecipeRuntimeForTest(ports: PinnedPhotoRecipeValidatorTestPorts): Promise<void> {
  await verifyRuntime(ports);
}
