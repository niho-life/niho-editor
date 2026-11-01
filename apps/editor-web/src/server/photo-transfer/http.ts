import { createHash, randomUUID } from "node:crypto";
import { PHOTO_ERROR_STATUS, PHOTO_LIMITS, type PhotoErrorCode, type PhotoErrorEnvelope, type StartUploadRequest, type VerifiedPhotoActor } from "../../../../../packages/photo-library-contract/src/v1";
import { PhotoStorageError } from "../../storage/photo-types";

export const PRIVATE_PHOTO_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;
export class PhotoTransferError extends Error {
  constructor(readonly code: PhotoErrorCode) { super(`photo transfer: ${code}`); }
}
export function fail(code: PhotoErrorCode): never { throw new PhotoTransferError(code); }
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...PRIVATE_PHOTO_HEADERS, "Content-Type": "application/json; charset=utf-8" } });
}
export function errorResponse(error: unknown): Response {
  let code: PhotoErrorCode = "temporarily_unavailable";
  if (error instanceof PhotoTransferError) code = error.code;
  else if (error instanceof PhotoStorageError && error.code === "not_found") code = "not_found";
  // Store errors have a closed code set; never include message, cause or stack.
  else if (error instanceof Error && error.name === "PhotoStoreError" && "code" in error && typeof error.code === "string"
    && ["quota_exceeded", "idempotency_conflict", "upload_state_conflict", "upload_expired", "photo_trashed", "account_deleting", "content_rejected"].includes(error.code)) code = error.code as PhotoErrorCode;
  const retryable = code === "temporarily_unavailable" || code === "rate_limited";
  const body: PhotoErrorEnvelope = { error: { code, requestId: randomUUID(), retryable, ...(retryable ? { retryAfterSeconds: 1 } : {}) } };
  const result = json(body, PHOTO_ERROR_STATUS[code]);
  if (retryable) result.headers.set("Retry-After", "1");
  return result;
}
export function authorize(request: Request, actor: VerifiedPhotoActor | null, origins: readonly string[], now: number, mutation: boolean): VerifiedPhotoActor {
  if (!actor || !actor.userId || !actor.sessionId || !Number.isFinite(Date.parse(actor.expiresAt)) || Date.parse(actor.expiresAt) <= now
    || !["browser-session", "mac-bearer"].includes(actor.transport)) fail("unauthenticated");
  if (mutation) {
    const origin = request.headers.get("origin");
    if ((actor.transport === "browser-session" && origin === null) || (origin !== null && !origins.includes(origin))) fail("origin_rejected");
  }
  if (new URL(request.url).search) fail("invalid_request");
  return actor;
}
export const isUuid = (s: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s);
export const isDigest = (s: string) => /^[a-f0-9]{64}$/.test(s);
export function resourceId(s: string) { if (!isUuid(s)) fail("not_found"); return s.toLowerCase(); }
export function idempotency(request: Request): string {
  const key = request.headers.get("idempotency-key") ?? "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) fail("invalid_request");
  return key;
}
export function canonicalHash(value: unknown): string {
  function canonical(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v !== null && typeof v === "object") return `{${Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
    return JSON.stringify(v);
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export async function readBody(request: Request, signal: AbortSignal): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) fail("invalid_request");
  const length = request.headers.get("content-length");
  if (length !== null && !/^\d+$/.test(length)) fail("invalid_request");
  if (length !== null && Number(length) > PHOTO_LIMITS.maxOtherBodyBytes) fail("request_too_large");
  if (!request.body) fail("invalid_request");
  const reader = request.body.getReader();
  const pieces: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const item = await reader.read(); signal.throwIfAborted(); if (item.done) break;
      size += item.value.byteLength; if (size > PHOTO_LIMITS.maxOtherBodyBytes) fail("request_too_large"); pieces.push(item.value);
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pieces)));
    const stack = [{ value, depth: 0 }];
    while (stack.length) {
      const item = stack.pop()!; if (item.depth > PHOTO_LIMITS.maxJsonDepth) fail("invalid_request");
      if (item.value !== null && typeof item.value === "object") for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1 });
    }
    return value;
  } catch (error) { if (error instanceof PhotoTransferError) throw error; if (signal.aborted) throw error; fail("invalid_request"); }
  finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export function closed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail("invalid_request");
}
export function startBody(value: unknown): StartUploadRequest {
  closed(value, ["target", "sizeBytes", "sha256", "contentType"]);
  if (!Number.isSafeInteger(value.sizeBytes) || (value.sizeBytes as number) < 1 || typeof value.sha256 !== "string" || !isDigest(value.sha256)
    || typeof value.contentType !== "string" || !/^image\/[a-z0-9.+-]{1,100}$/.test(value.contentType)) fail("invalid_request");
  const target = value.target;
  if (target !== null && typeof target === "object" && "kind" in target && target.kind === "original") {
    closed(target, ["kind", "fileName", "format"]);
    const original = target as Record<string, unknown>;
    if (typeof original.fileName !== "string" || Buffer.byteLength(original.fileName) < 1 || Buffer.byteLength(original.fileName) > PHOTO_LIMITS.maxFileNameBytes
      || /[\/\\\u0000-\u001f\u007f]/.test(original.fileName) || !["jpeg", "png", "heic", "heif", "tiff", "raw"].includes(original.format as string)) fail("invalid_request");
    if ((value.sizeBytes as number) > PHOTO_LIMITS.maxFileBytes) fail("request_too_large");
  } else {
    closed(target, ["kind", "photoId"]);
    if (target.kind !== "mask" || typeof target.photoId !== "string" || !isUuid(target.photoId) || value.contentType !== "image/png") fail("invalid_request");
    if ((value.sizeBytes as number) > PHOTO_LIMITS.maxMaskBytes) fail("request_too_large");
    target.photoId = target.photoId.toLowerCase();
  }
  return value as unknown as StartUploadRequest;
}
export function parseRange(value: string | null, size: number): { start: number; end: number } | null {
  if (value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) fail("range_not_satisfiable");
  let start: number; let end: number;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix < 1) fail("range_not_satisfiable"); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) fail("range_not_satisfiable");
  return { start, end: Math.min(end, size - 1) };
}
