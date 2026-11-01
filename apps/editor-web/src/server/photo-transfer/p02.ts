import "server-only";
import { reservePhotoUpload, getPhotoUpload, claimPhotoUploadVerification, completePhotoUpload, cancelPhotoUpload, rejectPhotoUpload, recordPhotoOrphan, getPhotoAsset, type Database } from "@niho/editor-store";
import type { PhotoTransferStore } from "./types";

/** Only bind the P02 operations whose semantics already exist. Missing owner-bound projections
 * are REQUIRED: a placeholder Photo or unscoped digest query must never reach production.
 * P02 currently has no complete/cancel request-key ledger; the API separately requires a durable journal.
 */
export function createP02PhotoTransferStore(db: Database, projection: Pick<PhotoTransferStore, "photo" | "mask" | "uploadByStartKey">): PhotoTransferStore {
  return {
    reserve: (owner, input) => reservePhotoUpload(db, owner, input),
    upload: (owner, id) => getPhotoUpload(db, owner, id),
    claim: (owner, id) => claimPhotoUploadVerification(db, owner, id),
    complete: (owner, id, object) => completePhotoUpload(db, owner, id, object),
    cancel: (owner, id) => cancelPhotoUpload(db, owner, id),
    reject: (owner, id, lease, code) => rejectPhotoUpload(db, owner, id, lease, code),
    orphan: (owner, input) => recordPhotoOrphan(db, owner, input),
    asset: (owner, photo, id) => getPhotoAsset(db, owner, photo, id),
    photo: projection.photo,
    mask: projection.mask,
    uploadByStartKey: projection.uploadByStartKey,
  };
}
