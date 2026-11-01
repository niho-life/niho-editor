import "server-only";
import { createHash } from "node:crypto";
import type { PhotoErrorCode } from "../../../../../packages/photo-library-contract/src/v1";
import type { PhotoLifecycleDeps } from "./types";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{16,128}$/;
const EMPTY_REQUEST_HASH = createHash("sha256").update("{}", "utf8").digest("hex");

export class PhotoLifecycleError extends Error {
  constructor(readonly code: PhotoErrorCode) { super(`photo lifecycle: ${code}`); }
}

function fail(code: PhotoErrorCode): never { throw new PhotoLifecycleError(code); }
function key(value: unknown): string {
  if (typeof value !== "string" || !KEY.test(value)) fail("invalid_request");
  return value;
}

export function createPhotoLifecycleApi(deps: PhotoLifecycleDeps) {
  return {
    async trash(owner: string, photoId: string, idempotencyKey: unknown) {
      if (!UUID.test(photoId)) fail("not_found");
      const mutation = { idempotencyKey: key(idempotencyKey), requestHash: EMPTY_REQUEST_HASH };
      const result = await deps.store.trash(owner, photoId.toLowerCase(), mutation);
      if (result) return { value: result.photo, replayed: result.replayed };
      const current = await deps.store.photo(owner, photoId.toLowerCase());
      if (!current) fail("not_found");
      if (current.lifecycle === "trashed") fail("photo_trashed");
      fail("upload_state_conflict");
    },

    async restore(owner: string, photoId: string, idempotencyKey: unknown) {
      if (!UUID.test(photoId)) fail("not_found");
      const mutation = { idempotencyKey: key(idempotencyKey), requestHash: EMPTY_REQUEST_HASH };
      const result = await deps.store.restore(owner, photoId.toLowerCase(), mutation);
      if (result) return { value: result.photo, replayed: result.replayed };
      const current = await deps.store.photo(owner, photoId.toLowerCase());
      if (!current) fail("not_found");
      fail("upload_state_conflict");
    },

    async purge(owner: string, photoId: string, idempotencyKey: unknown) {
      if (!UUID.test(photoId)) fail("not_found");
      const mutation = { idempotencyKey: key(idempotencyKey), requestHash: EMPTY_REQUEST_HASH };
      const result = await deps.store.purge(owner, photoId.toLowerCase(), mutation);
      if (result) return { value: result.job, replayed: result.replayed };
      const current = await deps.store.photo(owner, photoId.toLowerCase());
      if (!current) fail("not_found");
      fail("upload_state_conflict");
    },

    async job(owner: string, jobId: string) {
      if (!UUID.test(jobId)) fail("not_found");
      const job = await deps.store.job(owner, jobId.toLowerCase());
      if (!job) fail("not_found");
      return job;
    },
  };
}
