import type { CompletePhotoUploadResult, PhotoAssetRecord, PhotoGcReason, PhotoRejectionCode, PhotoUploadRecord, ReservePhotoUploadInput, ReservePhotoUploadResult, VerifiedPhotoObject } from "@niho/editor-store";
import type { Photo, VerifiedPhotoActor } from "../../../../../packages/photo-library-contract/src/v1";
import type { PhotoStorage } from "../../storage/photo-types";

/** All owner arguments derive exclusively from the request's already verified actor. */
export interface PhotoTransferStore {
  reserve(owner: string, input: ReservePhotoUploadInput): Promise<ReservePhotoUploadResult | null>;
  upload(owner: string, id: string): Promise<PhotoUploadRecord | null>;
  /** Owner + operation + idempotency key lookup, including stored mask dedup starts. */
  uploadByStartKey(owner: string, operation: "original" | "mask", key: string): Promise<PhotoUploadRecord | null>;
  claim(owner: string, id: string): Promise<PhotoUploadRecord | null>;
  complete(owner: string, id: string, object: VerifiedPhotoObject): Promise<CompletePhotoUploadResult | null>;
  cancel(owner: string, id: string): Promise<PhotoUploadRecord | null>;
  reject(owner: string, id: string, lease: number, code: PhotoRejectionCode): Promise<PhotoUploadRecord | null>;
  orphan(owner: string, input: { uploadId: string; objectKey: string; objectGeneration: string; reason: PhotoGcReason }): Promise<unknown>;
  photo(owner: string, id: string): Promise<Photo | null>;
  asset(owner: string, photoId: string, id: string): Promise<PhotoAssetRecord | null>;
  mask(owner: string, photoId: string, surfaceId: string): Promise<PhotoAssetRecord | null>;
}

/** Durable request binding, scoped by actor + operation + upload. NOT a cached response.
 * Atomically insert/compare canonical request hash, return true if already bound; conflicting hash throws.
 * It must survive process restarts. Never implement this port as an in-memory production map.
 * The actual operation remains retryable; its current owner-bound state is always reloaded.
 */
export interface PhotoMutationJournal {
  bind(input: { owner: string; operation: "uploads.start" | "uploads.complete" | "uploads.cancel"; resourceId: string; key: string; requestHash: string }): Promise<boolean>;
}
export type ProbeResult = {
  format: "jpeg" | "png" | "heic" | "heif" | "tiff" | "raw";
  contentType: string;
  width: number;
  height: number;
  bitDepth?: number;
  channels?: "gray" | "rgb" | "rgba" | "other";
};
/** Trusted accepted decoder: validates the complete file, magic and actual encoded format;
 * checks dimensions BEFORE allocation, applies EXIF orientation once, rejects malformed/truncated
 * images and decompression bombs. Must respect signal and never buffer the whole original.
 * No default provider is enabled until P06/P13 installs and accepts one.
 */
export interface PhotoProbe {
  inspect(path: string, limits: { maxPixels: number; maxEdge: number | null }, signal: AbortSignal): Promise<ProbeResult>;
}
export interface PhotoTransferDeps {
  store: PhotoTransferStore;
  storage: PhotoStorage;
  journal: PhotoMutationJournal;
  probe: PhotoProbe;
  /** Canonical configured origins, never inferred from Host / forwarded headers. */
  origins: readonly string[];
  now?: () => number;
  timeoutMs?: number;
}
export type PhotoTransferActor = VerifiedPhotoActor | null;
