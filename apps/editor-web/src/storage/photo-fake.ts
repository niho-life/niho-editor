import { randomUUID } from "node:crypto";
import type { PhotoStorage, PhotoObject, PhotoStageInput } from "./photo-types";
import { PhotoStorageError, boundedPhotoStream, validPhotoKey } from "./photo-types";

/** Development/test only. No runtime factory selects this for production. */
export function createFakePhotoStorage(now: () => number = Date.now) {
  let generation = 0;
  const objects = new Map<string, { object: PhotoObject; bytes: Uint8Array }>();
  const tickets = new Map<string, PhotoStageInput>();
  const storage: PhotoStorage = {
    async ticket(input, signal) {
      signal.throwIfAborted();
      if (!validPhotoKey(input.key) || Date.parse(input.expiresAt) <= now() || Date.parse(input.expiresAt) > now() + 900_000) throw new PhotoStorageError("conflict");
      const url = `https://photo-upload.invalid/${randomUUID()}`;
      tickets.set(url, { ...input });
      return { url, method: "PUT", headers: { "Content-Type": input.contentType }, expiresAt: input.expiresAt, resumeOffsetBytes: objects.get(input.key)?.object.sizeBytes ?? 0 };
    },
    async progress(key, size, signal) {
      signal.throwIfAborted(); const stored = objects.get(key)?.object;
      if (stored && stored.sizeBytes !== size) throw new PhotoStorageError("conflict");
      return stored?.sizeBytes ?? 0;
    },
    async stat(key, version, signal) {
      signal.throwIfAborted();
      const found = objects.get(key)?.object;
      return found && (version === null || found.generation === version) ? { ...found } : null;
    },
    async read(object, range, signal) {
      signal.throwIfAborted();
      const found = objects.get(object.key);
      if (!found || found.object.generation !== object.generation) throw new PhotoStorageError("not_found");
      const start = range?.start ?? 0; const end = (range?.end ?? found.bytes.length - 1) + 1;
      let offset = start;
      return boundedPhotoStream(new ReadableStream<Uint8Array>({
        pull(c) { if (offset >= end) { c.close(); return; } const next = Math.min(offset + 4096, end); c.enqueue(found.bytes.slice(offset, next)); offset = next; },
      }, { highWaterMark: 0 }), end - start, signal);
    },
    async copy(source, destinationKey, signal) {
      signal.throwIfAborted();
      const found = objects.get(source.key);
      if (!found || found.object.generation !== source.generation) throw new PhotoStorageError("not_found");
      if (!validPhotoKey(destinationKey) || !destinationKey.startsWith("photo/final/") || objects.has(destinationKey)) throw new PhotoStorageError("conflict");
      const object = { ...found.object, key: destinationKey, generation: String(++generation) };
      objects.set(destinationKey, { object, bytes: found.bytes.slice() });
      return { ...object };
    },
  };
  return {
    storage,
    /** Simulates the ticket authority and create-only PUT, including real deadline enforcement. */
    put(url: string, bytes: Uint8Array) {
      const input = tickets.get(url);
      if (!input || Date.parse(input.expiresAt) <= now() || objects.has(input.key) || bytes.byteLength !== input.sizeBytes) throw new PhotoStorageError("conflict");
      const object = { key: input.key, generation: String(++generation), sizeBytes: bytes.byteLength, contentType: input.contentType };
      objects.set(input.key, { object, bytes: bytes.slice() });
      return { ...object };
    },
  };
}
