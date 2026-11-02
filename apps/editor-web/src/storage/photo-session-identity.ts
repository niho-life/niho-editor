import { PHOTO_LIMITS } from "../../../../packages/photo-library-contract/src/v1";
import { PhotoStorageError } from "./photo-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE_CONTENT_TYPE = /^image\/[a-z0-9.+-]{1,100}$/;
const UTF8 = new TextEncoder();
const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });

export interface PhotoUploadSessionIdentity {
  readonly ownerId: string;
  readonly uploadId: string;
  readonly stageKey: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly libraryId: string;
  readonly libraryLifecycleEpoch: number;
  readonly uploadLeaseGeneration: number;
}

function canonicalUtf8(value: string, maxBytes: number): boolean {
  if (value.normalize("NFC") !== value || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  const bytes = UTF8.encode(value);
  try {
    return bytes.byteLength >= 1 && bytes.byteLength <= maxBytes && UTF8_FATAL.decode(bytes) === value;
  } catch {
    return false;
  }
}

export function validatePhotoUploadSessionIdentity(identity: PhotoUploadSessionIdentity): void {
  if (!identity || typeof identity !== "object"
    || typeof identity.ownerId !== "string" || !canonicalUtf8(identity.ownerId, 128)
    || typeof identity.uploadId !== "string" || !UUID.test(identity.uploadId)
    || identity.stageKey !== `photo/stage/${identity.uploadId}`
    || !Number.isSafeInteger(identity.sizeBytes) || identity.sizeBytes < 1 || identity.sizeBytes > PHOTO_LIMITS.maxFileBytes
    || typeof identity.contentType !== "string" || !IMAGE_CONTENT_TYPE.test(identity.contentType)
    || !canonicalUtf8(identity.contentType, 128)
    || typeof identity.libraryId !== "string" || !UUID.test(identity.libraryId)
    || !Number.isSafeInteger(identity.libraryLifecycleEpoch) || identity.libraryLifecycleEpoch < 0
    || !Number.isSafeInteger(identity.uploadLeaseGeneration) || identity.uploadLeaseGeneration < 0) {
    throw new PhotoStorageError("conflict");
  }
}

/** Stable, version-bound AAD. The array order is part of the persisted schema. */
export function photoUploadSessionAad(
  identity: PhotoUploadSessionIdentity,
  schemaVersion: number,
  keyVersion: number,
): Uint8Array {
  validatePhotoUploadSessionIdentity(identity);
  return UTF8.encode(JSON.stringify([
    "niho.photo-upload-session",
    schemaVersion,
    keyVersion,
    identity.ownerId,
    identity.uploadId,
    identity.stageKey,
    identity.sizeBytes,
    identity.contentType,
    identity.libraryId,
    identity.libraryLifecycleEpoch,
    identity.uploadLeaseGeneration,
  ]));
}
