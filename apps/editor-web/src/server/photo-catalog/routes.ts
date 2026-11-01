import "server-only";
import { randomUUID } from "node:crypto";
import { PHOTO_ERROR_STATUS, type PhotoCapabilities, type PhotoErrorCode, type PhotoErrorEnvelope, type VerifiedPhotoActor } from "../../../../../packages/photo-library-contract/src/v1";
import { getAuthProvider } from "../../auth";
import { getPool } from "../db";
import { PhotoAuthError, verifyPhotoActor } from "../photo-auth";
import { PhotoTransferError, readBody } from "../photo-transfer/http";
import { PRIVATE_CATALOG_HEADERS, PhotoCatalogError, catalogResponse, createPhotoCatalogApi } from "./api";
import { createPhotoCatalogStore } from "./store-adapter";
import type { PhotoCatalogStore } from "./types";

type RouteDeps = {
  enabled: boolean;
  cursorSecret: Uint8Array | null;
  store: PhotoCatalogStore | null;
  verify: (request: Request) => Promise<VerifiedPhotoActor>;
  now?: () => number;
};

function errorResponse(error: unknown): Response {
  let code: PhotoErrorCode = "temporarily_unavailable";
  if (error instanceof PhotoCatalogError || error instanceof PhotoTransferError) code = error.code;
  else if (error instanceof PhotoAuthError) {
    code = error.status === 401 ? "unauthenticated" : error.status === 403 ? "origin_rejected"
      : error.status === 400 ? "invalid_request" : "temporarily_unavailable";
  }
  const retryable = code === "temporarily_unavailable" || code === "rate_limited";
  const envelope: PhotoErrorEnvelope = { error: { code, requestId: randomUUID(), retryable,
    ...(retryable ? { retryAfterSeconds: 1 } : {}) } };
  return new Response(JSON.stringify(envelope), { status: PHOTO_ERROR_STATUS[code], headers: {
    ...PRIVATE_CATALOG_HEADERS, "Content-Type": "application/json; charset=utf-8", ...(retryable ? { "Retry-After": "1" } : {}),
  } });
}

function noQuery(request: Request): void {
  if (new URL(request.url).search) throw new PhotoCatalogError("invalid_request");
}

export function createPhotoCatalogRoutes(deps: RouteDeps) {
  async function run(request: Request, method: "GET" | "POST", action: (owner: string, api: ReturnType<typeof createPhotoCatalogApi>) => Promise<Response>): Promise<Response> {
    try {
      if (!deps.enabled || !deps.store || !deps.cursorSecret) throw new PhotoCatalogError("temporarily_unavailable");
      if (request.method !== method) throw new PhotoCatalogError("invalid_request");
      const actor = await deps.verify(request);
      if (!actor.userId || !actor.sessionId || !Number.isFinite(Date.parse(actor.expiresAt))
        || Date.parse(actor.expiresAt) <= (deps.now?.() ?? Date.now())) throw new PhotoCatalogError("unauthenticated");
      return await action(actor.userId, createPhotoCatalogApi({ store: deps.store, cursorSecret: deps.cursorSecret, now: deps.now }));
    } catch (error) { return errorResponse(error); }
  }
  return {
    library: (request: Request) => run(request, "GET", async (owner, api) => { noQuery(request); return catalogResponse(await api.library(owner, request.headers.get("if-none-match"))); }),
    list: (request: Request) => run(request, "GET", async (owner, api) => catalogResponse(await api.list(owner, new URL(request.url), request.headers.get("if-none-match")))),
    photo: (request: Request, id: string) => run(request, "GET", async (owner, api) => { noQuery(request); return catalogResponse(await api.photo(owner, id, request.headers.get("if-none-match"))); }),
    info: (request: Request, id: string) => run(request, "GET", async (owner, api) => { noQuery(request); return catalogResponse(await api.info(owner, id, request.headers.get("if-none-match"))); }),
    lookup: (request: Request) => run(request, "POST", async (owner, api) => {
      noQuery(request);
      const body = await readBody(request, AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]));
      return new Response(JSON.stringify(await api.lookup(owner, body)), { status: 200,
        headers: { ...PRIVATE_CATALOG_HEADERS, "Content-Type": "application/json; charset=utf-8" } });
    }),
  };
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

function capabilitiesFromEnv(value: string | undefined): PhotoCapabilities | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!record(parsed)) return null;
    const caps = parsed as unknown as PhotoCapabilities;
    const formats = caps.formats;
    const renderer = caps.renderer;
    const stringList = (items: unknown): items is string[] => Array.isArray(items)
      && items.length <= 128 && items.every((item) => typeof item === "string" && item.length > 0 && item.length <= 128);
    const versionList = (items: unknown): items is number[] => Array.isArray(items)
      && items.length <= 32 && items.every((item) => Number.isSafeInteger(item) && item > 0);
    const knownFormats = new Set(["jpeg", "png", "heic", "heif", "tiff", "raw"]);
    if (!Array.isArray(formats) || formats.length > knownFormats.size || formats.some((item) =>
      !record(item) || !knownFormats.has(String(item.format)) || !Array.isArray(item.extensions) || item.extensions.length === 0
        || item.extensions.length > 16 || !item.extensions.every((extension) => typeof extension === "string" && /^[a-z0-9]{1,12}$/i.test(extension))
        || typeof item.ingest !== "boolean" || typeof item.workingCopy !== "boolean")
      || new Set(formats.map((item) => item.format)).size !== formats.length
      || !record(renderer) || !stringList(renderer.engines) || !versionList(renderer.settingsVersions)
      || !stringList(renderer.features) || !stringList(renderer.maskKinds)
      || typeof renderer.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(renderer.manifestSha256)
      || typeof renderer.sdkVersion !== "string" || renderer.sdkVersion.length < 1 || renderer.sdkVersion.length > 128
      || typeof renderer.crateVersion !== "string" || renderer.crateVersion.length < 1 || renderer.crateVersion.length > 128
      || typeof renderer.maskSurfaces !== "boolean"
      || typeof caps.edits !== "boolean" || typeof caps.versions !== "boolean" || typeof caps.maskSurfaces !== "boolean"
      || caps.albums !== false || caps.publicSharing !== false) return null;
    return caps;
  } catch { return null; }
}

/** Runtime dependencies are resolved for each request; missing configuration keeps the private API closed. */
export function runtimePhotoCatalogRoutes(env: Readonly<Record<string, string | undefined>> = process.env) {
  const enabled = env.EDITOR_PHOTO_CATALOG_ENABLED === "true";
  const secret = env.EDITOR_PHOTO_CATALOG_CURSOR_SECRET;
  const cursorSecret = secret && secret.length % 2 === 0 && /^[a-f0-9]{64,}$/i.test(secret) ? Buffer.from(secret, "hex") : null;
  const capabilities = capabilitiesFromEnv(env.EDITOR_PHOTO_CATALOG_CAPABILITIES);
  const pool = enabled && cursorSecret && capabilities ? getPool(env) : null;
  return createPhotoCatalogRoutes({ enabled, cursorSecret,
    store: pool && capabilities ? createPhotoCatalogStore(pool, capabilities) : null,
    verify: async (request) => (await verifyPhotoActor(request, { auth: () => getAuthProvider() })).actor });
}
