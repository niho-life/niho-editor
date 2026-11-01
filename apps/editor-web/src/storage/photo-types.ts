import type { UploadTicket } from "../../../../packages/photo-library-contract/src/v1";

/** Server-private locators. Never serialize one as public asset metadata. */
export type PhotoObject = { key: string; generation: string; sizeBytes: number; contentType: string };
export type PhotoRange = { start: number; end: number };
export type PhotoStageInput = { key: string; sizeBytes: number; contentType: string; origin: string | null; expiresAt: string };
export class PhotoStorageError extends Error {
  constructor(readonly code: "unavailable" | "conflict" | "not_found") { super(`photo storage: ${code}`); }
}
export interface PhotoStorage {
  /** The ticket authority must enforce expiresAt; advisory timestamps are insufficient. */
  ticket(input: PhotoStageInput, signal: AbortSignal): Promise<UploadTicket>;
  /** Storage-confirmed offset, never a client-declared progress value. */
  progress(key: string, sizeBytes: number, signal: AbortSignal): Promise<number>;
  /** Latest is permitted only to pin a stage generation before verification. */
  stat(key: string, generation: string | null, signal: AbortSignal): Promise<PhotoObject | null>;
  read(object: PhotoObject, range: PhotoRange | null, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  /** Must match source generation AND ifGenerationMatch=0 on destination. */
  copy(source: PhotoObject, destinationKey: string, signal: AbortSignal): Promise<PhotoObject>;
}

export function validPhotoKey(key: string): boolean {
  const parts = key.split("/");
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  return parts[0] === "photo" && uuid.test(parts[2] ?? "")
    && ((parts[1] === "stage" && parts.length === 3) || (parts[1] === "final" && parts.length === 4 && uuid.test(parts[3] ?? "")));
}
export function validPhotoObject(object: PhotoObject): boolean {
  return validPhotoKey(object.key) && /^[0-9]{1,128}$/.test(object.generation)
    && Number.isSafeInteger(object.sizeBytes) && object.sizeBytes > 0
    && /^image\/[a-z0-9.+-]+$/.test(object.contentType);
}

/** Propagates consumer cancellation, enforces byte count and bounds an entire read. */
export function boundedPhotoStream(source: ReadableStream<Uint8Array>, length: number, signal: AbortSignal): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let count = 0;
  let done = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => { done = true; signal.removeEventListener("abort", abort); };
  const abort = () => {
    if (done) return;
    finish();
    void reader.cancel().catch(() => undefined);
    controller.error(new PhotoStorageError("unavailable"));
  };
  return new ReadableStream({
    start(c) { controller = c; signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); },
    async pull(c) {
      try {
        const item = await reader.read();
        if (done) return;
        if (item.done) {
          if (count !== length) throw new PhotoStorageError("unavailable");
          finish(); c.close(); return;
        }
        count += item.value.byteLength;
        if (count > length) throw new PhotoStorageError("unavailable");
        c.enqueue(item.value);
      } catch {
        if (!done) { finish(); void reader.cancel().catch(() => undefined); c.error(new PhotoStorageError("unavailable")); }
      }
    },
    async cancel() { finish(); await reader.cancel().catch(() => undefined); },
  }, { highWaterMark: 0 });
}
