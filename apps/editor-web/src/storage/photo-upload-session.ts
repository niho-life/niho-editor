import "server-only";
import { PhotoStorageError } from "./photo-types";
import { validatePhotoUploadSessionIdentity, type PhotoUploadSessionIdentity } from "./photo-session-identity";

const STORAGE_ORIGIN = "https://storage.googleapis.com";
const MAX_SESSION_URL_BYTES = 8_192;
const MAX_METADATA_BYTES = 32 * 1_024;
const MAX_CHUNK_BYTES = 4 * 1_024 * 1_024;
const CHUNK_ALIGNMENT_BYTES = 256 * 1_024;
const UTF8 = new TextEncoder();
const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });

export type PhotoUploadSessionDriverOptions = {
  bucket: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type PhotoUploadChunk = {
  start: number;
  bytes: Uint8Array;
};

export interface PhotoUploadSessionDriver {
  progress(sessionUrl: string, identity: PhotoUploadSessionIdentity, signal: AbortSignal): Promise<number>;
  put(sessionUrl: string, identity: PhotoUploadSessionIdentity, chunk: PhotoUploadChunk, signal: AbortSignal): Promise<number>;
}

type DeadlineContext = {
  signal: AbortSignal;
  setAbortCleanup(cleanup: () => void): void;
};

function unavailable(): PhotoStorageError {
  return new PhotoStorageError("unavailable");
}

function conflict(): PhotoStorageError {
  return new PhotoStorageError("conflict");
}

function discardResponse(response: Response): void {
  if (response.body) void response.body.cancel().catch(() => undefined);
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().catch(() => undefined);
  try {
    reader.releaseLock();
  } catch {
    // A pending read is still observed by the deadline task.
  }
}

function withDeadline<T>(
  externalSignal: AbortSignal,
  timeoutMs: number,
  work: (context: DeadlineContext) => Promise<T>,
): Promise<T> {
  if (externalSignal.aborted) return Promise.reject(unavailable());
  return new Promise<T>((resolve, reject) => {
    const timeoutController = new AbortController();
    const combined = AbortSignal.any([externalSignal, timeoutController.signal]);
    let abortCleanup: () => void = () => {};
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      externalSignal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      timeoutController.abort();
      try { abortCleanup(); } catch { /* best-effort cleanup must not delay rejection */ }
      finish(() => reject(unavailable()));
    };
    externalSignal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);

    let task: Promise<T>;
    try {
      task = Promise.resolve(work({
        signal: combined,
        setAbortCleanup(cleanup) { abortCleanup = cleanup; },
      }));
    } catch {
      finish(() => reject(unavailable()));
      return;
    }
    // Attach both handlers immediately so a late rejection after timeout is always observed.
    task.then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(unavailable())),
    );
  });
}

function validateSessionUrl(sessionUrl: string, bucket: string, identity: PhotoUploadSessionIdentity): string {
  if (typeof sessionUrl !== "string") throw unavailable();
  const encoded = UTF8.encode(sessionUrl);
  if (encoded.byteLength < 1 || encoded.byteLength > MAX_SESSION_URL_BYTES) throw unavailable();
  try {
    if (UTF8_FATAL.decode(encoded) !== sessionUrl) throw unavailable();
  } catch {
    throw unavailable();
  }
  let url: URL;
  try {
    url = new URL(sessionUrl);
  } catch {
    throw unavailable();
  }
  const expectedPath = `/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`;
  if (url.protocol !== "https:" || url.origin !== STORAGE_ORIGIN || url.username || url.password || url.hash
    || url.pathname !== expectedPath) throw unavailable();
  const seen = new Set<string>();
  for (const [name, value] of url.searchParams) {
    if (seen.has(name) || !["upload_id", "uploadType", "name", "ifGenerationMatch"].includes(name)) throw unavailable();
    seen.add(name);
    if ((name === "upload_id" && value.length < 1)
      || (name === "uploadType" && value !== "resumable")
      || (name === "name" && value !== identity.stageKey)
      || (name === "ifGenerationMatch" && value !== "0")) throw unavailable();
  }
  if (!seen.has("upload_id")) throw unavailable();
  return url.href;
}

function acknowledgedOffset(response: Response, total: number): number {
  const range = response.headers.get("range");
  if (range === null) return 0;
  const match = /^bytes=0-([0-9]+)$/.exec(range);
  if (!match || !/^(0|[1-9][0-9]*)$/.test(match[1]!)) throw unavailable();
  const end = Number(match[1]);
  if (!Number.isSafeInteger(end) || end < 0 || end >= total - 1) throw unavailable();
  return end + 1;
}

async function readMetadata(
  response: Response,
  identity: PhotoUploadSessionIdentity,
  bucket: string,
  context: DeadlineContext,
): Promise<void> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^(0|[1-9][0-9]*)$/.test(declaredLength)
    || Number(declaredLength) > MAX_METADATA_BYTES)) throw unavailable();
  if (!response.body) throw unavailable();
  const reader = response.body.getReader();
  context.setAbortCleanup(() => cancelReader(reader));
  const pieces: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      context.signal.throwIfAborted();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_METADATA_BYTES) throw unavailable();
      pieces.push(item.value);
    }
  } catch {
    cancelReader(reader);
    throw unavailable();
  } finally {
    try { reader.releaseLock(); } catch { /* cleanup path already owns the reader */ }
  }
  context.setAbortCleanup(() => discardResponse(response));
  let value: unknown;
  try {
    const bytes = Buffer.concat(pieces, length);
    value = JSON.parse(UTF8_FATAL.decode(bytes));
  } catch {
    throw unavailable();
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") throw unavailable();
  const metadata = value as Record<string, unknown>;
  if (metadata.name !== identity.stageKey || metadata.bucket !== bucket
    || metadata.size !== String(identity.sizeBytes) || metadata.contentType !== identity.contentType
    || typeof metadata.generation !== "string" || !/^[1-9][0-9]{0,127}$/.test(metadata.generation)) throw unavailable();
}

export function createGcsPhotoUploadSessionDriver(options: PhotoUploadSessionDriverOptions): PhotoUploadSessionDriver {
  if (!options || typeof options !== "object") throw unavailable();
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (typeof options.bucket !== "string" || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(options.bucket)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
    || (options.fetch !== undefined && typeof options.fetch !== "function")) throw unavailable();
  const bucket = options.bucket;
  const doFetch = options.fetch ?? fetch;

  async function request(
    sessionUrl: string,
    identity: PhotoUploadSessionIdentity,
    init: RequestInit,
    signal: AbortSignal,
    acceptComplete: boolean,
  ): Promise<number> {
    return withDeadline(signal, timeoutMs, async (context) => {
      const response = await doFetch(sessionUrl, {
        ...init,
        cache: "no-store",
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: context.signal,
      });
      context.setAbortCleanup(() => discardResponse(response));
      if (context.signal.aborted) {
        discardResponse(response);
        throw unavailable();
      }
      try {
        if (response.status === 308) {
          const offset = acknowledgedOffset(response, identity.sizeBytes);
          discardResponse(response);
          return offset;
        }
        if (response.status === 200 || response.status === 201) {
          if (!acceptComplete) {
            discardResponse(response);
            throw unavailable();
          }
          await readMetadata(response, identity, bucket, context);
          return identity.sizeBytes;
        }
        discardResponse(response);
        throw unavailable();
      } catch {
        discardResponse(response);
        throw unavailable();
      }
    });
  }

  async function progress(sessionUrl: string, identity: PhotoUploadSessionIdentity, signal: AbortSignal): Promise<number> {
    validatePhotoUploadSessionIdentity(identity);
    const url = validateSessionUrl(sessionUrl, bucket, identity);
    const headers = new Headers({
      "Content-Length": "0",
      "Content-Range": `bytes */${identity.sizeBytes}`,
    });
    return request(url, identity, { method: "PUT", headers }, signal, true);
  }

  return {
    progress,
    async put(sessionUrl, identity, input, signal) {
      validatePhotoUploadSessionIdentity(identity);
      const url = validateSessionUrl(sessionUrl, bucket, identity);
      if (!input || typeof input !== "object" || !Number.isSafeInteger(input.start) || input.start < 0
        || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_CHUNK_BYTES) throw conflict();
      const bytes = Uint8Array.from(input.bytes);
      const end = input.start + bytes.byteLength - 1;
      if (!Number.isSafeInteger(end) || end >= identity.sizeBytes
        || (end + 1 < identity.sizeBytes && bytes.byteLength % CHUNK_ALIGNMENT_BYTES !== 0)) throw conflict();

      const actual = await progress(url, identity, signal);
      if (actual === identity.sizeBytes || actual !== input.start) throw conflict();
      const headers = new Headers({
        "Content-Length": String(bytes.byteLength),
        "Content-Range": `bytes ${input.start}-${end}/${identity.sizeBytes}`,
        "Content-Type": identity.contentType,
      });
      const finalChunk = end + 1 === identity.sizeBytes;
      const acknowledged = await request(url, identity, { method: "PUT", headers, body: bytes as BodyInit }, signal, finalChunk);
      if (acknowledged === identity.sizeBytes) {
        return acknowledged;
      }
      if (acknowledged < input.start || acknowledged > end + 1) throw unavailable();
      return acknowledged;
    },
  };
}
