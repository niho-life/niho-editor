import "server-only";
import { createHash } from "node:crypto";
import type { PhotoErrorCode } from "../../../../../packages/photo-library-contract/src/v1";
import type { PhotoMediaDeps } from "./types";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{16,128}$/;

export class PhotoMediaError extends Error {
  constructor(readonly code: PhotoErrorCode, readonly currentRevision?: number) {
    super(`photo media: ${code}`);
  }
}

function fail(code: PhotoErrorCode, currentRevision?: number): never {
  throw new PhotoMediaError(code, currentRevision);
}

function closedBody(value: unknown): value is { recipeRevision: number } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && Object.hasOwn(value, "recipeRevision");
}

export function photoMediaEnsureRequestHash(recipeRevision: number): string {
  return createHash("sha256").update(JSON.stringify({ recipeRevision }), "utf8").digest("hex");
}

export function createPhotoMediaApi(deps: PhotoMediaDeps) {
  return {
    async ensure(owner: string, photoId: string, body: unknown, idempotencyKey: unknown) {
      if (!UUID.test(photoId)) fail("not_found");
      if (typeof idempotencyKey !== "string" || !KEY.test(idempotencyKey)) fail("invalid_request");
      if (!closedBody(body) || !Number.isSafeInteger(body.recipeRevision) || body.recipeRevision < 0) fail("invalid_request");
      const normalizedPhotoId = photoId.toLowerCase();
      const result = await deps.store.ensure(owner, normalizedPhotoId, {
        recipeRevision: body.recipeRevision,
        key: idempotencyKey,
        requestHash: photoMediaEnsureRequestHash(body.recipeRevision),
      });
      if (!result || result.snapshot.ownerId !== owner || result.snapshot.photoId.toLowerCase() !== normalizedPhotoId) fail("not_found");
      return { value: result.snapshot.media, replayed: result.replayed };
    },
  };
}
