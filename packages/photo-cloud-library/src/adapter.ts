import {
  PHOTO_LIMITS,
  type JsonObject,
  type NamedVersion,
  type PersonalPhotoLibrary,
  type Photo,
  type PhotoAsset,
  type PhotoFormat,
  type QuotaUsage,
  type RecipeDocument,
  type VersionSet,
} from "@niho/photo-library-contract";
import {
  developSettingsEngineIdentifiers,
  isEditableDevelopSettings,
  readDevelopSettings,
  supportedDevelopSettingsVersions,
  type DevelopSettings,
} from "niho-photo-contract";
import type {
  PhotoLibrary,
  PhotoLibraryCapabilities,
  PhotoLibraryDevelopVersion,
  PhotoLibraryItem,
  PhotoLibraryPhoto,
  PhotoLibraryPresets,
  PhotoLibraryWorkingCopyResult,
} from "niho-photo-editing/library/photo-library";
import { CloudPhotoError, fixedMessage, isCloudPhotoError } from "./errors.ts";
import {
  createPhotoApiClient,
  type AuthenticatedFetch,
  type CloudPhotoScope,
  type PhotoApiClient,
} from "./http-client.ts";
import { isRecord, parseAsset, parseInfo, parseLibrary, parseLookup, parsePage, parsePhoto, parseVersions } from "./validate.ts";

const WORKING_COPY_MAX_BYTES = PHOTO_LIMITS.maxFileBytes;
const withSignal = (signal: AbortSignal | undefined): { signal?: AbortSignal } => signal ? { signal } : {};

export type CloudPhotoHostRuntime = Readonly<{
  settingsVersions: readonly number[];
  engines: readonly string[];
  features: readonly string[];
  acceptsRecipe: (settings: JsonObject) => boolean;
  crop: boolean;
  mobile: boolean;
  engineManifestUrl: string | null;
}>;

export type CloudPhotoLibraryOptions = Readonly<{
  scope: CloudPhotoScope;
  currentScope: () => CloudPhotoScope | null;
  authenticatedFetch: AuthenticatedFetch;
  runtime?: CloudPhotoHostRuntime;
  presets?: PhotoLibraryPresets;
  lookupConcurrency?: number;
  now?: () => Date;
  randomId?: () => string;
  idempotencyKey?: (operation: import("@niho/photo-library-contract").PhotoOperation) => string;
  subscribeScopeChange?: (listener: () => void) => () => void;
}>;

export type CloudPhotoLibrary = Readonly<{
  library: PhotoLibrary;
  client: PhotoApiClient;
  scope: CloudPhotoScope;
  dispose(): void;
  usage(options?: { signal?: AbortSignal }): Promise<QuotaUsage>;
  rawRecipe(photoId: string): RecipeDocument | null;
  rawVersions(photoId: string): VersionSet | null;
}>;

export class BrowserPhotoSourceError extends Error {
  readonly name = "BrowserPhotoSourceError";
  readonly reason: "too_large" | "fetch_failed";
  constructor(reason: "too_large" | "fetch_failed") { super(reason); this.reason = reason; }
}

type OriginalRefBinding = Readonly<{ photoId: string; asset: PhotoAsset; kind: "original" }>;
type WorkingCopyRefBinding = Readonly<{
  photoId: string;
  asset: PhotoAsset;
  kind: "working-copy";
  descriptor: Readonly<{ baseVersion: string; encoding: "png16" | "jpeg8"; metaJson: string }>;
}>;
type RefBinding = OriginalRefBinding | WorkingCopyRefBinding;

const closedCapabilities: PhotoLibraryCapabilities = {
  place: "cloud", rawWorkingCopy: false, nativeExport: false, nativeExportUpdateRequired: false,
  exportFolder: false, cutout: false, favorites: false, albums: false, articleImages: false,
  multiSelect: true, mobile: false, editedPreview: false, addFiles: false, addFromDevice: false,
  addFromDeviceFolder: false, info: false, versions: false, flags: false, maskSurfaces: false,
};

const unsupportedPresets: PhotoLibraryPresets = {
  list: async () => [],
  create: async () => { throw new CloudPhotoError("unsupported_operation", null, null, false); },
  rename: async () => { throw new CloudPhotoError("unsupported_operation", null, null, false); },
  delete: async () => { throw new CloudPhotoError("unsupported_operation", null, null, false); },
  nameMaxChars: 40,
  xmpMaxBytes: 1024 ** 2,
  describeError: (error, fallback) => fixedMessage(error, fallback),
  isNameTaken: () => false,
};

export function createCloudPhotoLibrary(options: CloudPhotoLibraryOptions): CloudPhotoLibrary {
  const client = createPhotoApiClient({
    scope: options.scope,
    currentScope: options.currentScope,
    authenticatedFetch: options.authenticatedFetch,
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    ...(options.subscribeScopeChange ? { subscribeScopeChange: options.subscribeScopeChange } : {}),
  });
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const refs = new Map<string, RefBinding>();
  const rawPhotos = new Map<string, Photo>();
  const rawVersionSets = new Map<string, VersionSet>();
  let serverLibrary: PersonalPhotoLibrary | null = null;
  let disposed = false;

  const clearScopeState = () => {
    refs.clear();
    rawPhotos.clear();
    rawVersionSets.clear();
    serverLibrary = null;
  };
  const unsubscribeAdapterScope = options.subscribeScopeChange?.(clearScopeState) ?? (() => {});

  const ensureLibrary = async (signal?: AbortSignal): Promise<PersonalPhotoLibrary> => {
    const parsed = parseLibrary(await client.request("library.get", {}, withSignal(signal)), options.scope.actorId, options.scope.libraryId);
    client.assertCurrent();
    serverLibrary = parsed;
    return parsed;
  };
  const ensureServer = (signal?: AbortSignal): Promise<PersonalPhotoLibrary> => {
    client.assertCurrent();
    return serverLibrary ? Promise.resolve(serverLibrary) : ensureLibrary(signal);
  };

  const effectiveCapabilities = (server: PersonalPhotoLibrary | null): PhotoLibraryCapabilities => {
    client.assertCurrent();
    const runtime = options.runtime;
    if (!server || !runtime) return closedCapabilities;
    const versions = server.capabilities.renderer.settingsVersions.filter((v) =>
      supportedDevelopSettingsVersions.includes(v as (typeof supportedDevelopSettingsVersions)[number]) && runtime.settingsVersions.includes(v));
    const engines = server.capabilities.renderer.engines.filter((engine) =>
      developSettingsEngineIdentifiers.includes(engine as (typeof developSettingsEngineIdentifiers)[number]) && runtime.engines.includes(engine));
    const renderReady = server.capabilities.edits && versions.length > 0 && engines.length > 0;
    return {
      ...closedCapabilities,
      rawWorkingCopy: renderReady && server.capabilities.formats.some((item) => item.workingCopy && item.ingest),
      mobile: renderReady && runtime.mobile,
      info: true,
      versions: renderReady && server.capabilities.versions,
    };
  };

  const recipeWritable = (recipe: RecipeDocument, photo: Photo, server = serverLibrary, versions = false): boolean => {
    client.assertCurrent();
    const runtime = options.runtime;
    if (!runtime || !server || photo.lifecycle !== "active" || !server.capabilities.edits || (versions && !server.capabilities.versions)) return false;
    const { v, engine } = recipe.settings;
    if (!supportedDevelopSettingsVersions.includes(v as (typeof supportedDevelopSettingsVersions)[number]) ||
      !developSettingsEngineIdentifiers.includes(engine as (typeof developSettingsEngineIdentifiers)[number]) ||
      !server.capabilities.renderer.settingsVersions.includes(v) || !server.capabilities.renderer.engines.includes(engine) ||
      !runtime.settingsVersions.includes(v) || !runtime.engines.includes(engine) || !runtime.acceptsRecipe(recipe.settings)) return false;
    const surfaces = maskSurfaceIds(recipe.settings);
    if (!surfaces || surfaces.length !== recipe.maskSurfaceIds.length || surfaces.some((id) => !recipe.maskSurfaceIds.includes(id))) return false;
    return readDevelopSettings(recipe.settings) !== null && isEditableDevelopSettings(recipe.settings, { geometry: runtime.crop });
  };

  const remember = (photo: Photo): Photo => {
    client.assertCurrent();
    rawPhotos.set(photo.id, structuredClone(photo));
    return photo;
  };
  const projectSettings = (photo: Photo): DevelopSettings | null => recipeWritable(photo.recipe, photo) ? readDevelopSettings(photo.recipe.settings) : null;
  const projectPhoto = (photo: Photo): PhotoLibraryPhoto => {
    remember(photo);
    return {
      id: photo.id, fileName: photo.fileName, fileExtension: extensionFor(photo.format), sizeBytes: photo.original.sizeBytes,
      contentSha256: photo.original.sha256, createdAt: photo.addedAt, capturedAt: photo.capturedAt,
      uploadedBy: null, hasOriginal: true,
      hasPreview: photo.media.state === "ready", hasWebImage: false, hasDevelopSettings: photo.recipe.revision > 0,
      developSettings: projectSettings(photo), developSettingsUpdatedAt: photo.recipe.revision > 0 ? photo.recipe.updatedAt : null,
      developRevision: photo.recipe.revision, webRenderedRevision: null, workStatus: workStatus(photo), workQueuedAt: null,
      favorite: false, flag: null, hasEdits: photo.hasEdits, editedPreview: null,
    };
  };
  const projectItem = (photo: Photo): PhotoLibraryItem & { contentSha256: string } => ({ ...projectPhoto(photo), previewUrl: null, editedPreviewPending: false });

  const getRaw = async (photoId: string, signal?: AbortSignal): Promise<Photo | null> => {
    await ensureServer(signal);
    try {
      const photo = parsePhoto(await client.request("photos.get", { photoId }, withSignal(signal)), options.scope.libraryId, photoId);
      if (photo.id !== photoId) throw new CloudPhotoError("invalid_response", null, null, false);
      return remember(photo);
    }
    catch (error) { if (isCloudPhotoError(error) && error.code === "not_found") return null; throw error; }
  };
  const requireRaw = async (photoId: string, signal?: AbortSignal): Promise<Photo> => {
    const photo = await getRaw(photoId, signal);
    if (!photo) throw new CloudPhotoError("not_found", 404, null, false);
    return photo;
  };
  const issueRef = (binding: RefBinding): string => {
    client.assertCurrent();
    const ref = `cloud-content:${randomId()}`;
    refs.set(ref, structuredClone(binding));
    return ref;
  };
  const resolveRef = (ref: string, photoId: string, kind: RefBinding["kind"]): RefBinding => {
    client.assertCurrent();
    const binding = refs.get(ref);
    if (!binding || binding.photoId !== photoId || binding.kind !== kind) throw new CloudPhotoError("invalid_response", null, null, false);
    return binding;
  };
  const readAsset = async (binding: Readonly<{ photoId: string; asset: PhotoAsset }>, maxBytes: number, signal?: AbortSignal) => {
    if (binding.asset.sizeBytes > maxBytes) throw new CloudPhotoError("content_too_large", null, null, false);
    const result = await client.readContent({ photoId: binding.photoId, assetId: binding.asset.id }, { maxBytes, ...withSignal(signal) });
    if (result.bytes.byteLength !== binding.asset.sizeBytes) throw new CloudPhotoError("invalid_response", null, null, false);
    return { bytes: result.bytes, type: binding.asset.contentType || result.contentType };
  };

  const rejectUnsupportedFilter = (query: Parameters<PhotoLibrary["list"]>[0]): void => {
    if (query.favorite !== undefined || query.albumId !== undefined || query.flag !== undefined || query.folderId !== undefined ||
      query.localSource !== undefined || query.hasOriginal === false) throw new CloudPhotoError("unsupported_operation", null, null, false);
  };

  const openOriginal: PhotoLibrary["openOriginal"] = async (photoId, requestOptions) => {
    const photo = await requireRaw(photoId, requestOptions?.signal);
    if (!recipeWritable(photo.recipe, photo)) throw new CloudPhotoError("unsupported_settings", 422, null, false);
    return { source: { ref: issueRef({ photoId, asset: photo.original, kind: "original" }), expiresAt: null }, photo: projectPhoto(photo) };
  };

  const loadOriginal: PhotoLibrary["loadOriginal"] = async (photoId, source, loadOptions) => {
    const binding = resolveRef(source.ref, photoId, "original");
    try {
      const result = await readAsset(binding, Math.min(loadOptions.maxBytes, PHOTO_LIMITS.maxFileBytes), loadOptions.signal);
      return new File([result.bytes.slice().buffer as ArrayBuffer], loadOptions.fileName, { type: result.type });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (isCloudPhotoError(error) && error.code === "content_too_large") throw new BrowserPhotoSourceError("too_large");
      throw new BrowserPhotoSourceError("fetch_failed");
    }
  };

  const library = {
    place: "cloud",
    initialCapabilities: closedCapabilities,
    engineAssets: { manifestUrl: () => options.runtime?.engineManifestUrl ?? null },
    limits: { listPageSize: PHOTO_LIMITS.listMaxCount, lookupMaxCount: PHOTO_LIMITS.lookupMaxCount, referencesMaxCount: 0, photosPerRequest: PHOTO_LIMITS.listMaxCount },
    errors: {
      describe: (error: unknown, fallback: string) => error instanceof BrowserPhotoSourceError
        ? (error.reason === "too_large" ? "写真が読み込み上限を超えています。" : "写真を読み込めませんでした。")
        : fixedMessage(error, fallback),
      describeStorageError: (error: unknown) => isCloudPhotoError(error) ? error.message : null,
      describeDeleteFailure: (errors: readonly unknown[]) => errors.length === 1 ? fixedMessage(errors[0], "写真を削除できませんでした。") : `${errors.length}枚の写真を削除できませんでした。`,
      isNativeError: () => false,
      describeNative: () => "この端末では利用できません。",
      isPermanentSaveFailure: (error: unknown) => isCloudPhotoError(error) && ["not_found", "invalid_request", "origin_rejected", "unsupported_settings"].includes(error.code),
      isNotFound: (error: unknown) => isCloudPhotoError(error) && error.code === "not_found",
      readQuotaExceeded: (error: unknown) => {
        try {
          client.assertCurrent();
          return isCloudPhotoError(error) && error.code === "quota_exceeded" && serverLibrary
            ? { usedBytes: serverLibrary.usage.usedBytes, quotaBytes: serverLibrary.usage.quotaBytes, requiredBytes: null }
            : null;
        } catch { return null; }
      },
      describeQuotaExceeded: () => "写真の保存容量が足りません。",
      readDevelopRevisionStale: (error: unknown) => isCloudPhotoError(error) ? error.stalePhoto ?? null : null,
      isExportFolderNotFound: () => false,
    },
    async capabilities(requestOptions) { return effectiveCapabilities(await ensureLibrary(requestOptions?.signal)); },
    async rollout(requestOptions) {
      const capabilities = effectiveCapabilities(await ensureLibrary(requestOptions?.signal));
      const crop = capabilities.rawWorkingCopy && Boolean(options.runtime?.crop) &&
        Boolean(options.runtime?.features.includes("geometry")) && Boolean(serverLibrary?.capabilities.renderer.features.includes("geometry"));
      return { crop, mobileEditing: capabilities.mobile };
    },
    async list(query, requestOptions) {
      rejectUnsupportedFilter(query);
      await ensureServer(requestOptions?.signal);
      const formats = formatsForKind(query.kind);
      const wire = {
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.limit !== undefined ? { limit: Math.min(query.limit, PHOTO_LIMITS.listMaxCount) } : {}),
        sort: query.sort === "captured" ? "captured-desc" as const : "added-desc" as const,
        ...(formats ? { formats } : {}), ...(query.edited !== undefined ? { edited: query.edited } : {}), lifecycle: "active" as const,
      };
      const page = parsePage(await client.request("photos.list", wire, withSignal(requestOptions?.signal)), options.scope.libraryId);
      if (page.items.some((photo) => photo.lifecycle !== "active")) throw new CloudPhotoError("invalid_response", null, null, false);
      return { items: page.items.map(projectItem), next: page.nextCursor,
        usage: { usedBytes: page.usage.usedBytes, quotaBytes: page.usage.quotaBytes, originalBytes: page.usage.originalBytes }, counts: null };
    },
    async get(photoId, requestOptions) { const photo = await getRaw(photoId, requestOptions?.signal); return photo ? projectItem(photo) : null; },
    async lookup(hashes, requestOptions) {
      if (hashes.length > PHOTO_LIMITS.lookupMaxCount || hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
        throw new CloudPhotoError("invalid_request", 400, null, false);
      }
      await ensureServer(requestOptions?.signal);
      const matches = parseLookup(await client.request("photos.lookup", { sha256s: [...hashes] }, withSignal(requestOptions?.signal)));
      const requested = new Set(hashes);
      if (matches.some((match) => !requested.has(match.sha256))) throw new CloudPhotoError("invalid_response", null, null, false);
      const limit = Math.max(1, Math.min(options.lookupConcurrency ?? 4, 8));
      const output: { contentSha256: string; photo: PhotoLibraryPhoto }[] = [];
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(limit, matches.length) }, async () => {
        while (cursor < matches.length) {
          const index = cursor++;
          const match = matches[index];
          if (!match) continue;
          const photo = await requireRaw(match.photoId, requestOptions?.signal);
          if (photo.original.sha256 !== match.sha256 || photo.recipe.revision !== match.recipeRevision) throw new CloudPhotoError("invalid_response", null, null, false);
          output[index] = { contentSha256: match.sha256, photo: projectPhoto(photo) };
        }
      }));
      return output;
    },
    async info(photoId, requestOptions) {
      await requireRaw(photoId, requestOptions?.signal);
      return parseInfo(await client.request("photos.info", { photoId }, withSignal(requestOptions?.signal)));
    },
    openOriginal,
    loadOriginal,
    async ensureWorkingCopy(photoId, requestOptions) {
      let photo = await requireRaw(photoId, requestOptions?.signal);
      if (!recipeWritable(photo.recipe, photo)) return { kind: "incompatible", message: "この補正は現在の環境では変更できません。" };
      if (photo.media.state !== "ready" || !photo.media.workingCopy || photo.media.recipeRevision !== photo.recipe.revision) {
        const receipt = await client.request("media.ensure", { photoId, recipeRevision: photo.recipe.revision }, withSignal(requestOptions?.signal));
        if (!isRecord(receipt) || !isRecord(receipt.value)) throw new CloudPhotoError("invalid_response", null, null, false);
        photo = await requireRaw(photoId, requestOptions?.signal);
      }
      return workingResult(photo, issueRef, now);
    },
    async loadWorkingCopy(photoId, download, loadOptions) {
      const binding = resolveRef(download.ref, photoId, "working-copy");
      if (binding.kind !== "working-copy") throw new CloudPhotoError("invalid_response", null, null, false);
      const result = await readAsset(binding, WORKING_COPY_MAX_BYTES, loadOptions.signal);
      client.assertCurrent();
      return { photoId, baseVersion: binding.descriptor.baseVersion, bytes: result.bytes.slice().buffer as ArrayBuffer,
        encoding: binding.descriptor.encoding, metaJson: binding.descriptor.metaJson };
    },
    async retryWorkingCopy(photoId) {
      const photo = await requireRaw(photoId);
      if (photo.media.state !== "failed") return { kind: "notFailed", workStatus: workStatus(photo) };
      if (!recipeWritable(photo.recipe, photo)) return { kind: "notApplicable" };
      await client.request("media.ensure", { photoId, recipeRevision: photo.recipe.revision });
      return { kind: "queued", workQueuedAt: now().toISOString() };
    },
    async saveDevelopSettings(photoId, settings, saveOptions) {
      if (saveOptions?.expectedRevision === undefined || !Number.isSafeInteger(saveOptions.expectedRevision) || saveOptions.expectedRevision < 0) {
        throw new CloudPhotoError("invalid_request", 400, null, false);
      }
      const current = await requireRaw(photoId);
      if (!recipeWritable(current.recipe, current) || !settingsWritable(settings, current.recipe.baseVersion, current, serverLibrary, options.runtime)) {
        throw new CloudPhotoError("unsupported_settings", 422, null, false);
      }
      try {
        const response = await client.request("recipes.put", { photoId, expectedRevision: saveOptions.expectedRevision,
          settings: toJsonObject(settings), baseVersion: current.recipe.baseVersion });
        if (!isRecord(response) || !Object.hasOwn(response, "value")) throw new CloudPhotoError("invalid_response", null, null, false);
        return { kind: "saved", photo: projectPhoto(parsePhoto(response.value, options.scope.libraryId, photoId)) };
      } catch (error) {
        if (isCloudPhotoError(error) && error.code === "revision_conflict") return { kind: "stale", photo: projectPhoto(await requireRaw(photoId)) };
        throw error;
      }
    },
    async developVersions(photoId, requestOptions) {
      const photo = await requireRaw(photoId, requestOptions?.signal);
      const set = parseVersions(await client.request("versions.get", { photoId }, withSignal(requestOptions?.signal)));
      client.assertCurrent();
      rawVersionSets.set(photoId, structuredClone(set));
      return projectVersionSet(set, (recipe) => recipeWritable(recipe, photo));
    },
    async saveDevelopVersions(photoId, versions, saveOptions) {
      if (!Number.isSafeInteger(saveOptions.expectedRevision) || saveOptions.expectedRevision < 0) {
        throw new CloudPhotoError("invalid_request", 400, null, false);
      }
      const currentPhoto = await requireRaw(photoId);
      if (!recipeWritable(currentPhoto.recipe, currentPhoto, serverLibrary, true)) throw new CloudPhotoError("unsupported_settings", 422, null, false);
      const current = rawVersionSets.get(photoId) ?? parseVersions(await client.request("versions.get", { photoId }));
      const writableVersion = (recipe: RecipeDocument) => recipeWritable(recipe, currentPhoto, serverLibrary, true);
      if (!current.versions.every((version) => writableVersion(version.recipe))) {
        throw new CloudPhotoError("unsupported_settings", 422, null, false);
      }
      if (current.revision !== saveOptions.expectedRevision) return { kind: "stale", ...projectVersionSet(current, writableVersion) };
      const wire = await Promise.all(versions.map((version) => wireVersion(version, current, currentPhoto, options.runtime, serverLibrary, now)));
      try {
        const response = await client.request("versions.put", { photoId, expectedRevision: saveOptions.expectedRevision, versions: wire });
        if (!isRecord(response) || !Object.hasOwn(response, "value")) throw new CloudPhotoError("invalid_response", null, null, false);
        const set = parseVersions(response.value);
        client.assertCurrent();
        rawVersionSets.set(photoId, structuredClone(set));
        return { kind: "saved", ...projectVersionSet(set, writableVersion) };
      } catch (error) {
        if (isCloudPhotoError(error) && error.code === "revision_conflict") {
          const latest = parseVersions(await client.request("versions.get", { photoId }));
          client.assertCurrent();
          rawVersionSets.set(photoId, structuredClone(latest));
          return { kind: "stale", ...projectVersionSet(latest, writableVersion) };
        }
        throw error;
      }
    },
    async loadMaskSurface(photoId, surfaceId) {
      if (!/^[a-f0-9]{64}$/.test(surfaceId)) throw new CloudPhotoError("invalid_request", 400, null, false);
      await requireRaw(photoId);
      // 過去の版だけが参照するsurfaceも、本人とphotoを検証するAPIで照合する。
      try {
        const asset = parseAsset(await client.request("masks.get", { photoId, surfaceId }), { kind: "mask", sha256: surfaceId });
        return (await readAsset({ photoId, asset }, PHOTO_LIMITS.maxMaskBytes)).bytes;
      } catch (error) { if (isCloudPhotoError(error) && error.code === "not_found") return null; throw error; }
    },
    async downloadOriginal(photo, requestOptions) {
      if (!photo.hasOriginal) throw new CloudPhotoError("not_found", 404, null, false);
      const raw = await requireRaw(photo.id, requestOptions?.signal);
      const source = { ref: issueRef({ photoId: raw.id, asset: raw.original, kind: "original" }), expiresAt: null };
      const file: File = await loadOriginal(raw.id, source, { signal: requestOptions?.signal ?? new AbortController().signal,
        fileName: raw.fileName, maxBytes: Math.min(raw.original.sizeBytes, PHOTO_LIMITS.maxFileBytes) });
      return { blob: file, fileName: raw.fileName };
    },
    async delete(photoIds) {
      const deleted: string[] = [];
      const errors: unknown[] = [];
      for (const photoId of photoIds) {
        client.assertCurrent();
        try {
          const response = await client.request("photos.trash", { photoId });
          if (!isRecord(response) || !Object.hasOwn(response, "value")) throw new CloudPhotoError("invalid_response", null, null, false);
          parsePhoto(response.value, options.scope.libraryId, photoId);
          deleted.push(photoId);
        } catch (error) { if (isCloudPhotoError(error) && error.code === "not_found") deleted.push(photoId); else errors.push(error); }
      }
      return { deleted, errors };
    },
    presets: options.presets ?? unsupportedPresets,
  } satisfies PhotoLibrary;

  return {
    library, client, scope: options.scope,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeAdapterScope();
      client.dispose();
      clearScopeState();
    },
    async usage(requestOptions) { return (await ensureLibrary(requestOptions?.signal)).usage; },
    rawRecipe(photoId) { client.assertCurrent(); const value = rawPhotos.get(photoId)?.recipe; return value ? structuredClone(value) : null; },
    rawVersions(photoId) { client.assertCurrent(); const value = rawVersionSets.get(photoId); return value ? structuredClone(value) : null; },
  };
}

function extensionFor(format: PhotoFormat): string { return format === "jpeg" ? "jpg" : format === "tiff" ? "tif" : format; }
function formatsForKind(kind: "raw" | "jpeg" | "heic" | undefined): readonly PhotoFormat[] | undefined {
  if (kind === "jpeg") return ["jpeg"]; if (kind === "heic") return ["heic", "heif"]; if (kind === "raw") return ["raw"]; return undefined;
}
function workStatus(photo: Photo): "queued" | "rendering" | "ready" | "failed" | null {
  if (photo.media.state === "ready") return photo.media.workingCopy ? "ready" : null;
  if (photo.media.state === "processing") return "rendering"; if (photo.media.state === "queued") return "queued";
  if (photo.media.state === "failed") return "failed"; return null;
}
function workingResult(photo: Photo, issueRef: (binding: RefBinding) => string, now: () => Date): PhotoLibraryWorkingCopyResult {
  if (photo.media.state === "ready" && photo.media.workingCopy) {
    if (photo.media.recipeRevision !== photo.recipe.revision) throw new CloudPhotoError("invalid_response", null, null, false);
    const work = photo.media.workingCopy;
    if (work.asset.sizeBytes > WORKING_COPY_MAX_BYTES || work.asset.width > PHOTO_LIMITS.workingCopyMaxEdge ||
      work.asset.height > PHOTO_LIMITS.workingCopyMaxEdge ||
      (work.encoding === "png16" ? work.asset.contentType !== "image/png" : work.asset.contentType !== "image/jpeg")) {
      throw new CloudPhotoError("invalid_response", null, null, false);
    }
    let meta: import("@niho/photo-library-contract").JsonObject;
    let metaJson: string;
    try {
      meta = cloneJson(work.meta) as import("@niho/photo-library-contract").JsonObject;
      metaJson = canonicalJson(meta);
    } catch {
      throw new CloudPhotoError("invalid_response", null, null, false);
    }
    if (new TextEncoder().encode(metaJson).byteLength > PHOTO_LIMITS.maxWorkingCopyMetaBytes) {
      throw new CloudPhotoError("invalid_response", null, null, false);
    }
    return { kind: "ready", download: { ref: issueRef({ photoId: photo.id, asset: work.asset, kind: "working-copy",
      descriptor: { baseVersion: work.baseVersion, encoding: work.encoding, metaJson } }),
      expiresAt: new Date(now().getTime() + 5 * 60_000).toISOString(), work: { baseVersion: work.baseVersion,
        sizeBytes: work.asset.sizeBytes, width: work.asset.width, height: work.asset.height,
        meta, renderedAt: photo.recipe.updatedAt } } };
  }
  if (photo.media.state === "failed") return { kind: "notReady", workStatus: "failed", workQueuedAt: null, lastErrorCode: photo.media.code };
  if (photo.media.state === "unsupported") return { kind: "notApplicable" };
  return { kind: "notReady", workStatus: photo.media.state === "processing" ? "rendering" : "queued", workQueuedAt: null, lastErrorCode: null };
}
function toJsonObject(settings: DevelopSettings): RecipeDocument["settings"] {
  const value: unknown = cloneJson(settings);
  if (!isRecord(value) || typeof value.v !== "number" || typeof value.engine !== "string") {
    throw new CloudPhotoError("unsupported_settings", 422, null, false);
  }
  return value as RecipeDocument["settings"];
}
function settingsWritable(settings: DevelopSettings, baseVersion: string | null, photo: Photo, server: PersonalPhotoLibrary | null,
  runtime: CloudPhotoHostRuntime | undefined, versions = false): boolean {
  let json: RecipeDocument["settings"];
  try { json = toJsonObject(settings); } catch { return false; }
  if (!runtime || !server || photo.lifecycle !== "active" || !server.capabilities.edits || (versions && !server.capabilities.versions) ||
    json.base !== baseVersion || !runtime.acceptsRecipe(json) || !isEditableDevelopSettings(settings, { geometry: runtime.crop }) ||
    maskSurfaceIds(json) === null) return false;
  return server.capabilities.renderer.settingsVersions.includes(settings.v) && server.capabilities.renderer.engines.includes(settings.engine) &&
    runtime.settingsVersions.includes(settings.v) && runtime.engines.includes(settings.engine);
}
function projectVersion(version: NamedVersion, writable: (recipe: RecipeDocument) => boolean): PhotoLibraryDevelopVersion {
  if (!writable(version.recipe)) throw new CloudPhotoError("unsupported_settings", 422, null, false);
  const settings = readDevelopSettings(version.recipe.settings);
  if (!settings) throw new CloudPhotoError("unsupported_settings", 422, null, false);
  return { id: version.id, name: version.name, createdAt: version.createdAt, kind: version.kind, developSettings: settings };
}
function projectVersionSet(set: VersionSet, writable: (recipe: RecipeDocument) => boolean) {
  return { revision: set.revision, versions: set.versions.map((version) => projectVersion(version, writable)) };
}
async function wireVersion(version: PhotoLibraryDevelopVersion, current: VersionSet, photo: Photo, runtime: CloudPhotoHostRuntime | undefined,
  server: PersonalPhotoLibrary | null, now: () => Date): Promise<NamedVersion> {
  if (!settingsWritable(version.developSettings, photo.recipe.baseVersion, photo, server, runtime, true)) {
    throw new CloudPhotoError("unsupported_settings", 422, null, false);
  }
  const settings = toJsonObject(version.developSettings);
  const surfaces = maskSurfaceIds(settings);
  if (!surfaces) throw new CloudPhotoError("unsupported_settings", 422, null, false);
  const settingsSha256 = await canonicalSha256(settings);
  const existing = current.versions.find((item) => item.id === version.id);
  return { id: version.id, name: version.name, kind: version.kind, createdAt: existing?.createdAt ?? version.createdAt,
    recipe: { revision: existing?.recipe.revision ?? 0, settings,
      settingsSha256, baseVersion: photo.recipe.baseVersion,
      maskSurfaceIds: surfaces, updatedAt: existing?.recipe.updatedAt ?? now().toISOString() } };
}

function cloneJson(value: unknown): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CloudPhotoError("unsupported_settings", 422, null, false);
    return value;
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return value;
  }
  if (Array.isArray(value)) return value.map(cloneJson);
  if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new CloudPhotoError("unsupported_settings", 422, null, false);
  }
  const result: Record<string, import("@niho/photo-library-contract").Json> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    assertUnicodeScalarString(key);
    result[key] = cloneJson(item) as import("@niho/photo-library-contract").Json;
  }
  return result;
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) throw new CloudPhotoError("unsupported_settings", 422, null, false);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CloudPhotoError("unsupported_settings", 422, null, false);
    }
  }
}

function canonicalJson(value: import("@niho/photo-library-contract").Json): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new CloudPhotoError("unsupported_settings", 422, null, false);
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as import("@niho/photo-library-contract").JsonObject;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(",")}}`;
}

async function canonicalSha256(settings: RecipeDocument["settings"]): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(settings));
  if (bytes.byteLength > PHOTO_LIMITS.maxRecipeBytes) throw new CloudPhotoError("unsupported_settings", 422, null, false);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function maskSurfaceIds(settings: RecipeDocument["settings"]): string[] | null {
  const masks = settings.masks;
  if (masks === undefined) return [];
  if (!Array.isArray(masks)) return null;
  const ids = new Set<string>();
  for (const mask of masks) {
    if (!isRecord(mask) || typeof mask.kind !== "string") return null;
    if (mask.kind === "linear" || mask.kind === "radial") continue;
    if (mask.kind !== "brush" && mask.kind !== "subject" && mask.kind !== "sky") return null;
    if (!isRecord(mask.surface) || typeof mask.surface.id !== "string" || !/^[a-f0-9]{64}$/.test(mask.surface.id)) return null;
    ids.add(mask.surface.id);
  }
  return [...ids];
}
