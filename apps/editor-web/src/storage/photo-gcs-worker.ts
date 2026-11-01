import "server-only";
import { PHOTO_LIMITS } from "../../../../packages/photo-library-contract/src/v1";
import type { MediaObjectStorage } from "../../../../workers/photo-media/src/p02";
import type { PhotoPurgeObjectDeletePort } from "../../../../workers/photo-purge/src/executor";
import { createMetadataTokenProvider, type AccessTokenProvider } from "./gcs";
import { PhotoStorageError, boundedPhotoStream, validPhotoKey } from "./photo-types";

const GCS_ORIGIN = "https://storage.googleapis.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_METADATA_BYTES = 64 * 1024;
const HEADER_TOKEN = /^[\x21-\x7e]+$/;
const POSITIVE_GENERATION = /^[1-9][0-9]{0,127}$/;
const DECIMAL_SIZE = /^(0|[1-9][0-9]{0,15})$/;
const CREATE_CONTENT_TYPES = new Set(["image/jpeg", "image/png"]);

type Fetch = typeof fetch;

export type GcsPhotoWorkerOptions = {
  readonly bucket: string;
  readonly fetch?: Fetch;
  readonly accessToken?: AccessTokenProvider;
  readonly timeoutMs?: number;
  readonly now?: () => number;
};

type Runtime = {
  readonly bucket: string;
  readonly fetch: Fetch;
  readonly accessToken: AccessTokenProvider;
  readonly timeoutMs: number;
};

type Operation = {
  readonly signal: AbortSignal;
  abort(): void;
};

function unavailable(): PhotoStorageError {
  return new PhotoStorageError("unavailable");
}

function conflict(): PhotoStorageError {
  return new PhotoStorageError("conflict");
}

function validFinalKey(key: unknown): key is string {
  return typeof key === "string" && key.startsWith("photo/final/") && validPhotoKey(key);
}

function validGeneration(generation: unknown): generation is string {
  return typeof generation === "string" && POSITIVE_GENERATION.test(generation);
}

function validSignal(signal: unknown): signal is AbortSignal {
  return typeof signal === "object" && signal !== null
    && typeof (signal as AbortSignal).aborted === "boolean"
    && typeof (signal as AbortSignal).addEventListener === "function"
    && typeof (signal as AbortSignal).removeEventListener === "function";
}

function runtime(options: GcsPhotoWorkerOptions): Runtime {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof options.bucket !== "string" || options.bucket.length < 1 || options.bucket.length > 1024
    || /[\u0000-\u001f\u007f]/.test(options.bucket)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
    || (options.fetch !== undefined && typeof options.fetch !== "function")
    || (options.accessToken !== undefined && typeof options.accessToken !== "function")
    || (options.now !== undefined && typeof options.now !== "function")) throw unavailable();
  const doFetch = options.fetch ?? globalThis.fetch;
  return {
    bucket: encodeURIComponent(options.bucket),
    fetch: doFetch,
    accessToken: options.accessToken ?? createMetadataTokenProvider({ fetch: doFetch, timeoutMs, now: options.now }),
    timeoutMs,
  };
}

function operation(timeoutMs: number, parent?: AbortSignal): Operation {
  const controller = new AbortController();
  let stopped = false;
  const abort = () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  };
  parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  if (parent?.aborted) abort();
  return {
    signal: controller.signal,
    abort,
  };
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw unavailable();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(unavailable());
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        reject(unavailable());
      },
    );
    if (signal.aborted) abort();
  });
}

async function authorization(provider: AccessTokenProvider, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw unavailable();
  let pending: Promise<string>;
  try { pending = provider(); } catch { throw unavailable(); }
  const token = await abortable(pending, signal);
  if (typeof token !== "string" || !HEADER_TOKEN.test(token)) throw unavailable();
  return `Bearer ${token}`;
}

function bestEffort(value: PromiseLike<unknown> | undefined): void {
  if (value === undefined) return;
  try { void Promise.resolve(value).catch(() => undefined); } catch { /* Never surface cleanup details. */ }
}

function cancelBody(response: Response): void {
  try { bestEffort(response.body?.cancel()); } catch { /* Never surface cleanup details. */ }
}

async function request(runtimeValue: Runtime, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) throw unavailable();
  let pending: Promise<Response>;
  try {
    pending = runtimeValue.fetch(url, { ...init, redirect: "error", cache: "no-store", signal });
  } catch {
    throw unavailable();
  }
  void pending.then((response) => { if (signal.aborted) cancelBody(response); }, () => undefined);
  return await abortable(pending, signal);
}

function mediaUrl(runtimeValue: Runtime, key: string, query: string): string {
  return `${GCS_ORIGIN}/storage/v1/b/${runtimeValue.bucket}/o/${encodeURIComponent(key)}?${query}`;
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) throw unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { try { bestEffort(reader.cancel()); } catch { /* Best effort only. */ } };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw unavailable();
      const item = await abortable(reader.read(), signal);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_METADATA_BYTES) throw unavailable();
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch {
    try { bestEffort(reader.cancel()); } catch { /* Best effort only. */ }
    throw unavailable();
  } finally {
    signal.removeEventListener("abort", abort);
    try { reader.releaseLock(); } catch { /* A pending read may retain the lock until it settles. */ }
  }
}

function parseCreatedMetadata(bytes: Uint8Array): { generation: string; sizeBytes: number; contentType: string } {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw unavailable(); }
  if (typeof value !== "object" || value === null) throw unavailable();
  const metadata = value as { generation?: unknown; size?: unknown; contentType?: unknown };
  if (!validGeneration(metadata.generation) || typeof metadata.size !== "string" || !DECIMAL_SIZE.test(metadata.size)
    || typeof metadata.contentType !== "string" || metadata.contentType.length > 512
    || /[\u0000-\u001f\u007f]/.test(metadata.contentType)) throw unavailable();
  const sizeBytes = Number(metadata.size);
  if (!Number.isSafeInteger(sizeBytes)) throw unavailable();
  return { generation: metadata.generation, sizeBytes, contentType: metadata.contentType };
}

function createUploadBody(
  iterator: AsyncIterator<Uint8Array>,
  expectedBytes: number,
  signal: AbortSignal,
): { readonly body: ReadableStream<Uint8Array>; readonly consumed: () => boolean; close(): void } {
  let count = 0;
  let complete = false;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { bestEffort(iterator.return?.()); } catch { /* Never surface iterator details. */ }
  };
  const abort = () => close();
  signal.addEventListener("abort", abort, { once: true });
  const finish = () => signal.removeEventListener("abort", abort);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (signal.aborted) throw unavailable();
        const item = await abortable(Promise.resolve(iterator.next()), signal);
        if (item.done) {
          if (count !== expectedBytes) throw unavailable();
          complete = true;
          finish();
          controller.close();
          return;
        }
        if (!(item.value instanceof Uint8Array)) throw unavailable();
        count += item.value.byteLength;
        if (count > expectedBytes || count > PHOTO_LIMITS.maxFileBytes) throw unavailable();
        controller.enqueue(item.value);
      } catch {
        finish();
        close();
        controller.error(unavailable());
      }
    },
    cancel() { finish(); close(); },
  }, { highWaterMark: 0 });
  return { body, consumed: () => complete, close: () => { finish(); close(); } };
}

/**
 * P02 worker-only GCS capability. It can read and create immutable final objects, but cannot delete.
 * Construction is intentionally explicit; no route or default storage selection installs it.
 */
export function createGcsPhotoMediaStorage(options: GcsPhotoWorkerOptions): MediaObjectStorage {
  const runtimeValue = runtime(options);
  return {
    async read(object, parentSignal) {
      if (!validFinalKey(object?.key) || !validGeneration(object?.generation)
        || !Number.isSafeInteger(object?.sizeBytes) || object.sizeBytes < 1 || object.sizeBytes > PHOTO_LIMITS.maxFileBytes
        || typeof object?.contentType !== "string" || object.contentType.length > 512 || !HEADER_TOKEN.test(object.contentType)
        || !validSignal(parentSignal)) throw conflict();
      const current = operation(runtimeValue.timeoutMs, parentSignal);
      try {
        if (current.signal.aborted) throw unavailable();
        const auth = await authorization(runtimeValue.accessToken, current.signal);
        const generation = encodeURIComponent(object.generation);
        const response = await request(runtimeValue, mediaUrl(runtimeValue, object.key,
          `alt=media&generation=${generation}&ifGenerationMatch=${generation}`), {
          method: "GET",
          headers: { Authorization: auth, "Accept-Encoding": "identity" },
        }, current.signal);
        const lengthHeader = response.headers.get("content-length");
        const length = lengthHeader !== null && DECIMAL_SIZE.test(lengthHeader) ? Number(lengthHeader) : Number.NaN;
        const responseGeneration = response.headers.get("x-goog-generation");
        const contentEncoding = response.headers.get("content-encoding");
        const storedEncoding = response.headers.get("x-goog-stored-content-encoding");
        if (response.status !== 200 || !response.body || length !== object.sizeBytes
          || response.headers.has("content-range")
          || (responseGeneration !== null && responseGeneration !== object.generation)
          || (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity")
          || (storedEncoding !== null && storedEncoding.toLowerCase() !== "identity")) {
          cancelBody(response);
          throw unavailable();
        }
        const bounded = boundedPhotoStream(response.body, object.sizeBytes, current.signal);
        return {
          async *[Symbol.asyncIterator]() {
            let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
            try {
              reader = bounded.getReader();
              while (true) {
                const item = await abortable(reader.read(), current.signal);
                if (item.done) return;
                yield item.value;
              }
            } catch {
              throw unavailable();
            } finally {
              current.abort();
              if (reader) {
                try { bestEffort(reader.cancel()); } catch { /* Best effort only. */ }
                try { reader.releaseLock(); } catch { /* A pending read may retain the lock. */ }
              }
            }
          },
        };
      } catch {
        current.abort();
        throw unavailable();
      }
    },

    async create(input, parentSignal) {
      if (!validFinalKey(input?.key) || !Number.isSafeInteger(input?.sizeBytes)
        || input.sizeBytes < 1 || input.sizeBytes > PHOTO_LIMITS.maxFileBytes
        || !CREATE_CONTENT_TYPES.has(input?.contentType) || input?.ifGenerationMatch !== 0
        || typeof input?.bytes !== "object" || input.bytes === null
        || typeof input.bytes[Symbol.asyncIterator] !== "function" || !validSignal(parentSignal)) throw conflict();
      let iterator: AsyncIterator<Uint8Array>;
      try { iterator = input.bytes[Symbol.asyncIterator](); } catch { throw conflict(); }
      if (!iterator || typeof iterator.next !== "function") throw conflict();
      const current = operation(runtimeValue.timeoutMs, parentSignal);
      const upload = createUploadBody(iterator, input.sizeBytes, current.signal);
      try {
        if (current.signal.aborted) throw unavailable();
        const auth = await authorization(runtimeValue.accessToken, current.signal);
        const url = `${GCS_ORIGIN}/upload/storage/v1/b/${runtimeValue.bucket}/o?uploadType=media&name=${encodeURIComponent(input.key)}&ifGenerationMatch=0`;
        const init = {
          method: "POST",
          headers: {
            Authorization: auth,
            "Content-Type": input.contentType,
            "Content-Length": String(input.sizeBytes),
          },
          body: upload.body,
          duplex: "half",
        } as RequestInit & { duplex: "half" };
        const response = await request(runtimeValue, url, init, current.signal);
        if (response.status !== 200) {
          cancelBody(response);
          if (response.status === 412) throw conflict();
          throw unavailable();
        }
        if (!upload.consumed()) {
          cancelBody(response);
          throw unavailable();
        }
        const metadata = parseCreatedMetadata(await readBoundedBody(response, current.signal));
        return metadata;
      } catch (error) {
        if (error instanceof PhotoStorageError && error.code === "conflict") throw error;
        throw unavailable();
      } finally {
        current.abort();
        upload.close();
      }
    },
  };
}

async function requireAbsent(runtimeValue: Runtime, url: string, auth: string, signal: AbortSignal): Promise<void> {
  const response = await request(runtimeValue, url, { method: "GET", headers: { Authorization: auth } }, signal);
  cancelBody(response);
  if (response.status !== 404) throw unavailable();
}

/**
 * Purge worker-only GCS capability. It can delete one named immutable generation, but cannot read
 * media or create objects. Logical DELETE is not success until both live and soft-deleted metadata
 * for that same generation are absent.
 */
export function createGcsPhotoPurgeObjects(options: GcsPhotoWorkerOptions): PhotoPurgeObjectDeletePort {
  const runtimeValue = runtime(options);
  return {
    async deleteGeneration(input) {
      if (!validFinalKey(input?.objectKey) || !validGeneration(input?.ifGenerationMatch)) throw conflict();
      const current = operation(runtimeValue.timeoutMs);
      try {
        const auth = await authorization(runtimeValue.accessToken, current.signal);
        const generation = encodeURIComponent(input.ifGenerationMatch);
        const base = mediaUrl(runtimeValue, input.objectKey, `generation=${generation}`);
        const response = await request(runtimeValue, `${base}&ifGenerationMatch=${generation}`, {
          method: "DELETE",
          headers: { Authorization: auth },
        }, current.signal);
        const status = response.status;
        cancelBody(response);
        if (status === 412) return "generation_mismatch";
        if (status !== 204 && status !== 404) throw unavailable();
        await requireAbsent(runtimeValue, base, auth, current.signal);
        await requireAbsent(runtimeValue, `${base}&softDeleted=true`, auth, current.signal);
        return status === 204 ? "deleted" : "already_absent";
      } catch (error) {
        if (error instanceof PhotoStorageError && error.code === "conflict") throw error;
        throw unavailable();
      } finally {
        current.abort();
      }
    },
  };
}
