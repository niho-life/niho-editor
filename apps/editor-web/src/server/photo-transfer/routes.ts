import "server-only";
import { PhotoAuthError, verifyPhotoActor, type PhotoAuthDeps } from "../photo-auth";
import { createPhotoTransferApi } from "./api";
import { authorize, errorResponse, PhotoTransferError } from "./http";
import type { PhotoTransferDeps } from "./types";

export type PhotoTransferRouteDeps = PhotoAuthDeps & {
  /** Resolved only after request authentication. Null means required production capabilities are absent. */
  transfer: () => PhotoTransferDeps | null;
};

/** HTTP boundary: identity is always resolved by P01, never supplied by the caller. */
export function createPhotoTransferRoutes(deps: PhotoTransferRouteDeps) {
  async function run(request: Request, action: (api: ReturnType<typeof createPhotoTransferApi>, actor: Awaited<ReturnType<typeof verifyPhotoActor>>["actor"]) => Promise<Response>) {
    try {
      const { actor } = await verifyPhotoActor(request, deps);
      authorize(request, actor, [], deps.now?.() ?? Date.now(), false);
      const transfer = deps.transfer();
      if (!transfer) throw new PhotoTransferError("temporarily_unavailable");
      return await action(createPhotoTransferApi(transfer), actor);
    } catch (error) {
      if (error instanceof PhotoAuthError) {
        const code = error.status === 401 ? "unauthenticated" : error.status === 403 ? "origin_rejected"
          : error.status === 400 ? "invalid_request" : "temporarily_unavailable";
        return errorResponse(new PhotoTransferError(code));
      }
      return errorResponse(error);
    }
  }
  return {
    start: (request: Request) => run(request, (api, actor) => api.start(request, actor)),
    get: (request: Request, uploadId: string) => run(request, (api, actor) => api.get(request, actor, uploadId)),
    renew: (request: Request, uploadId: string) => run(request, (api, actor) => api.renew(request, actor, uploadId)),
    complete: (request: Request, uploadId: string) => run(request, (api, actor) => api.complete(request, actor, uploadId)),
    cancel: (request: Request, uploadId: string) => run(request, (api, actor) => api.cancel(request, actor, uploadId)),
    content: (request: Request, photoId: string, assetId: string) => run(request, (api, actor) => api.content(request, actor, photoId, assetId)),
    mask: (request: Request, photoId: string, surfaceId: string) => run(request, (api, actor) => api.mask(request, actor, photoId, surfaceId)),
  };
}
