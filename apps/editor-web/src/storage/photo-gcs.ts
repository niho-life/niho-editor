import "server-only";
import { createMetadataTokenProvider } from "./gcs";
import type { UploadTicket } from "../../../../packages/photo-library-contract/src/v1";
import { PhotoStorageError, boundedPhotoStream, validPhotoKey, validPhotoObject, type PhotoObject, type PhotoStageInput, type PhotoStorage } from "./photo-types";

/** The broker keeps sessionUrl private, enforces deadlines on every PUT, and never redirects to GCS.
 * It must allow only this exact stage session/size/type and return a fresh capability on renewal.
 * A raw GCS resumable URI lasts up to a week and cannot satisfy the 15-minute contract.
 */
export interface PhotoTicketBroker {
  issue(input: PhotoStageInput & { sessionUrl: string }, signal: AbortSignal): Promise<UploadTicket>;
  /** Return a fresh expiring capability for a current private session, or null if none exists.
   * Check the actual GCS offset first. A finished stage may return offset=size and must reject further PUTs.
   */
  renew(input: PhotoStageInput, signal: AbortSignal): Promise<UploadTicket | null>;
  progress(key: string, sizeBytes: number, signal: AbortSignal): Promise<number>;
}
export type PhotoGcsOptions = {
  bucket: string;
  broker: PhotoTicketBroker;
  fetch?: typeof fetch;
  accessToken?: () => Promise<string>;
  timeoutMs?: number;
  now?: () => number;
};

export function createGcsPhotoStorage(options: PhotoGcsOptions): PhotoStorage {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000 || !options.bucket) throw new PhotoStorageError("unavailable");
  const token = options.accessToken ?? createMetadataTokenProvider({ fetch: doFetch, timeoutMs: timeout, now });
  const base = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(options.bucket)}/o`;
  const objectUrl = (key: string) => {
    if (!validPhotoKey(key)) throw new PhotoStorageError("conflict");
    return `${base}/${encodeURIComponent(key)}`;
  };
  async function send(url: string, init: RequestInit, signal: AbortSignal) {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
    try {
      const credential = await token();
      if (!/^[\x21-\x7e]+$/.test(credential)) throw new PhotoStorageError("unavailable");
      const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${credential}`);
      return await doFetch(url, { ...init, headers, redirect: "error", signal: combined, cache: "no-store" });
    } catch { throw new PhotoStorageError("unavailable"); }
  }
  async function discard(response: Response) { await response.body?.cancel().catch(() => undefined); }
  async function metadata(response: Response, key: string): Promise<PhotoObject> {
    if (!response.ok) { await discard(response); throw new PhotoStorageError(response.status === 412 ? "conflict" : "unavailable"); }
    try {
      const body = await response.json();
      if (!body || typeof body !== "object" || typeof body.size !== "string" || !/^\d{1,16}$/.test(body.size)) throw new Error();
      const object = { key, generation: body.generation, sizeBytes: Number(body.size), contentType: body.contentType };
      if (!validPhotoObject(object)) throw new Error();
      return object;
    } catch { throw new PhotoStorageError("unavailable"); }
  }
  function validateTicket(result: UploadTicket, input: PhotoStageInput): UploadTicket {
    let url: URL;
    try { url = new URL(result.url); } catch { throw new PhotoStorageError("unavailable"); }
    if (url.protocol !== "https:" || url.origin === "https://storage.googleapis.com" || url.username || url.password || url.hash
      || result.method !== "PUT" || result.expiresAt !== input.expiresAt || !Number.isSafeInteger(result.resumeOffsetBytes)
      || result.resumeOffsetBytes < 0 || result.resumeOffsetBytes > input.sizeBytes) throw new PhotoStorageError("unavailable");
    return result;
  }
  return {
    async ticket(input, signal) {
      if (!validPhotoKey(input.key) || !input.key.startsWith("photo/stage/") || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1
        || !/^image\/[a-z0-9.+-]+$/.test(input.contentType) || Date.parse(input.expiresAt) <= now()
        || Date.parse(input.expiresAt) > now() + 900_000) throw new PhotoStorageError("conflict");
      const renewed = await options.broker.renew(input, signal);
      if (renewed) return validateTicket(renewed, input);
      const headers = new Headers({ "X-Upload-Content-Type": input.contentType, "X-Upload-Content-Length": String(input.sizeBytes) });
      if (input.origin !== null) {
        try { if (new URL(input.origin).origin !== input.origin) throw new Error(); } catch { throw new PhotoStorageError("conflict"); }
        headers.set("Origin", input.origin);
      }
      const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(options.bucket)}/o?uploadType=resumable&name=${encodeURIComponent(input.key)}&ifGenerationMatch=0`;
      const response = await send(url, { method: "POST", headers }, signal);
      await discard(response);
      if (!response.ok) throw new PhotoStorageError(response.status === 412 ? "conflict" : "unavailable");
      let session: URL;
      try { session = new URL(response.headers.get("location") ?? ""); } catch { throw new PhotoStorageError("unavailable"); }
      if (session.origin !== "https://storage.googleapis.com" || session.username || session.password || session.hash) throw new PhotoStorageError("unavailable");
      return validateTicket(await options.broker.issue({ ...input, sessionUrl: session.href }, signal), input);
    },
    async progress(key, sizeBytes, signal) {
      if (!validPhotoKey(key) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1) throw new PhotoStorageError("conflict");
      const response = await send(`${objectUrl(key)}?fields=size%2CcontentType%2Cgeneration`, { method: "GET" }, signal);
      let offset: number;
      if (response.status === 404) { await discard(response); offset = await options.broker.progress(key, sizeBytes, signal); }
      else { const object = await metadata(response, key); if (object.sizeBytes !== sizeBytes) throw new PhotoStorageError("conflict"); offset = object.sizeBytes; }
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > sizeBytes) throw new PhotoStorageError("unavailable");
      return offset;
    },
    async stat(key, generation, signal) {
      const query = new URLSearchParams({ fields: "size,contentType,generation" });
      if (generation !== null) { if (!/^\d{1,128}$/.test(generation)) throw new PhotoStorageError("conflict"); query.set("generation", generation); }
      const response = await send(`${objectUrl(key)}?${query}`, { method: "GET" }, signal);
      if (response.status === 404) { await discard(response); return null; }
      const object = await metadata(response, key);
      if (generation !== null && object.generation !== generation) throw new PhotoStorageError("unavailable");
      return object;
    },
    async read(object, range, signal) {
      if (!validPhotoObject(object)) throw new PhotoStorageError("conflict");
      const headers = new Headers({ "Accept-Encoding": "identity" });
      if (range) {
        if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end >= object.sizeBytes) throw new PhotoStorageError("conflict");
        headers.set("Range", `bytes=${range.start}-${range.end}`);
      }
      const response = await send(`${objectUrl(object.key)}?alt=media&generation=${object.generation}&ifGenerationMatch=${object.generation}`, { method: "GET", headers }, signal);
      const length = range ? range.end - range.start + 1 : object.sizeBytes;
      const expectedRange = range ? `bytes ${range.start}-${range.end}/${object.sizeBytes}` : null;
      if (response.status !== (range ? 206 : 200) || !response.body || response.headers.get("content-length") !== String(length)
        || (range && response.headers.get("content-range") !== expectedRange)
        || (response.headers.has("x-goog-generation") && response.headers.get("x-goog-generation") !== object.generation)
        || (response.headers.has("content-encoding") && response.headers.get("content-encoding") !== "identity")) {
        await discard(response); throw new PhotoStorageError(response.status === 404 ? "not_found" : "unavailable");
      }
      return boundedPhotoStream(response.body, length, AbortSignal.any([signal, AbortSignal.timeout(timeout)]));
    },
    async copy(source, destinationKey, signal) {
      if (!validPhotoObject(source) || !destinationKey.startsWith("photo/final/")) throw new PhotoStorageError("conflict");
      objectUrl(destinationKey);
      const destination = `/b/${encodeURIComponent(options.bucket)}/o/${encodeURIComponent(destinationKey)}`;
      const url = `${objectUrl(source.key)}/copyTo${destination}?sourceGeneration=${source.generation}&ifSourceGenerationMatch=${source.generation}&ifGenerationMatch=0`;
      // Return the known generation even if metadata differs: the caller can ledger it before rejecting.
      return metadata(await send(url, { method: "POST" }, signal), destinationKey);
    },
  };
}
