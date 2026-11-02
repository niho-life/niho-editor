import { PHOTO_LIMITS, type PersonalPhotoLibrary } from "@niho/photo-library-contract";

export type PhotoSession = Readonly<{ userId: string; sessionId: string; expiresAt: string; refreshRequired: boolean }>;
export type PhotoSessionResult =
  | { kind: "ready"; session: PhotoSession; library: PersonalPhotoLibrary; scopeKey: string }
  | { kind: "login" | "unavailable" | "error" };

const MAX_SESSION_TIMER_DELAY_MS = 2_147_483_647;

/** Long sessions need chained timers because browsers clamp setTimeout delays above 2^31-1 ms. */
export function schedulePhotoSessionExpiry(expiresAt: string, onExpire: () => void): () => void {
  const expiry = Date.parse(expiresAt);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  const check = () => {
    if (cancelled) return;
    const remaining = expiry - Date.now();
    if (!Number.isFinite(expiry) || remaining <= 0) {
      onExpire();
      return;
    }
    timer = setTimeout(check, Math.min(remaining, MAX_SESSION_TIMER_DELAY_MS));
  };
  check();
  return () => {
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
  };
}

const photoFetch = (input: string, signal: AbortSignal) => fetch(input, {
  credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" }, signal,
});

export async function loadPhotoSession(signal: AbortSignal, onSession?: (session: PhotoSession) => void): Promise<PhotoSessionResult> {
  try {
    let sessionResult = await readPhotoSession(signal);
    if (sessionResult.kind !== "ready") return sessionResult;
    onSession?.(sessionResult.session);
    if (sessionResult.session.refreshRequired) {
      const refreshResponse = await fetch("/photo/auth/refresh", {
        method: "POST", credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" }, signal,
      });
      if (refreshResponse.status === 401) return { kind: "login" };
      if (refreshResponse.status === 503 || !refreshResponse.ok) return { kind: "unavailable" };
      sessionResult = await readPhotoSession(signal);
      if (sessionResult.kind !== "ready") return sessionResult;
      onSession?.(sessionResult.session);
      // A provider that still requires refresh has not established a usable session.
      if (sessionResult.session.refreshRequired) return { kind: "login" };
    }
    const session = sessionResult.session;
    const libraryResponse = await photoFetch("/api/photo/v1/library", signal);
    if (libraryResponse.status === 401) return { kind: "login" };
    if (libraryResponse.status === 503) return { kind: "unavailable" };
    if (!libraryResponse.ok) return { kind: "error" };
    const library: unknown = await libraryResponse.json();
    if (!isPersonalPhotoLibrary(library, session.userId)) return { kind: "error" };
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${session.userId}\0${library.id}\0${session.sessionId}`));
    const scopeKey = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { kind: "ready", session, library, scopeKey };
  } catch (error) {
    if (signal.aborted) throw error;
    return { kind: "unavailable" };
  }
}

async function readPhotoSession(signal: AbortSignal): Promise<{ kind: "ready"; session: PhotoSession } | { kind: "login" | "unavailable" | "error" }> {
  const response = await photoFetch("/api/photo/v1/auth/session", signal);
  if (response.status === 401) return { kind: "login" };
  if (response.status === 503) return { kind: "unavailable" };
  if (!response.ok) return { kind: "error" };
  const value: unknown = await response.json();
  const expiresAt = isRecord(value) && typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : Number.NaN;
  if (!isRecord(value) || typeof value.userId !== "string" || !value.userId ||
    typeof value.sessionId !== "string" || !value.sessionId || typeof value.expiresAt !== "string" ||
    !Number.isFinite(expiresAt) || expiresAt <= Date.now() || typeof value.refreshRequired !== "boolean") {
    return { kind: "login" };
  }
  if (signal.aborted) throw signal.reason;
  return { kind: "ready", session: {
    userId: value.userId, sessionId: value.sessionId, expiresAt: value.expiresAt,
    refreshRequired: value.refreshRequired,
  } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSafeBytes(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPersonalPhotoLibrary(value: unknown, userId: string): value is PersonalPhotoLibrary {
  if (!isRecord(value) || value.contractVersion !== 1 || typeof value.id !== "string" || value.id.length === 0 ||
    !isRecord(value.owner) || value.owner.type !== "user" || value.owner.userId !== userId ||
    value.state !== "active" || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    !isRecord(value.usage) || !isRecord(value.capabilities) || !isRecord(value.capabilities.renderer) ||
    !Array.isArray(value.capabilities.formats) || typeof value.capabilities.edits !== "boolean" ||
    typeof value.capabilities.versions !== "boolean" || typeof value.capabilities.maskSurfaces !== "boolean" ||
    value.capabilities.albums !== false || value.capabilities.publicSharing !== false) return false;

  const usage = value.usage;
  const usageFields = ["quotaBytes", "usedBytes", "originalBytes", "maskBytes", "trashBytes", "pendingPurgeBytes", "reservedBytes", "availableBytes"];
  if (!usageFields.every((field) => isSafeBytes(usage[field])) ||
    usage.usedBytes !== Number(usage.originalBytes) + Number(usage.maskBytes) ||
    usage.availableBytes !== Number(usage.quotaBytes) - Number(usage.usedBytes) - Number(usage.reservedBytes) ||
    Number(usage.trashBytes) > Number(usage.usedBytes) || Number(usage.pendingPurgeBytes) > Number(usage.usedBytes)) return false;

  const formats = value.capabilities.formats;
  const supportedFormats = new Set(["jpeg", "png", "heic", "heif", "tiff", "raw"]);
  if (!formats.every((item) => isRecord(item) && supportedFormats.has(String(item.format)) &&
    isStringList(item.extensions) && typeof item.ingest === "boolean" && typeof item.workingCopy === "boolean")) return false;

  const renderer = value.capabilities.renderer;
  if (typeof renderer.sdkVersion !== "string" || renderer.sdkVersion.length === 0 ||
    typeof renderer.crateVersion !== "string" || renderer.crateVersion.length === 0 ||
    typeof renderer.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(renderer.manifestSha256) ||
    !Array.isArray(renderer.settingsVersions) || !renderer.settingsVersions.every((item) => Number.isSafeInteger(item) && Number(item) >= 0) ||
    !isStringList(renderer.engines) || !isStringList(renderer.features) || !isStringList(renderer.maskKinds) ||
    typeof renderer.maskSurfaces !== "boolean") return false;

  const limits = value.limits;
  if (!isRecord(limits) || !Object.entries(PHOTO_LIMITS).every(([key, expected]) => limits[key] === expected)) return false;
  return true;
}
