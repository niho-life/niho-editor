import "server-only";
import { photoAuthRuntimeDeps } from "../photo-auth/runtime";
import { createPhotoTransferRoutes, type PhotoTransferRouteDeps } from "./routes";

/** P13 must wire accepted decoder, expiring ticket broker, durable reconciliation and storage.
 * No environment flag, generic ObjectStorage, fake or process-local fallback can enable transfers.
 * Keep DB/storage resolution absent until that complete production wiring is accepted.
 */
export const photoTransferRuntimeDeps: PhotoTransferRouteDeps = {
  ...photoAuthRuntimeDeps,
  transfer: () => null,
};

export const photoTransferRoutes = createPhotoTransferRoutes(photoTransferRuntimeDeps);
