import "server-only";
import { randomUUID } from "node:crypto";
import { PHOTO_ERROR_STATUS, type PhotoErrorCode, type PhotoErrorEnvelope, type VerifiedPhotoActor } from "../../../../../packages/photo-library-contract/src/v1";
import { PhotoAuthError } from "../photo-auth";
import { authorize, idempotency, PhotoTransferError, PRIVATE_PHOTO_HEADERS } from "../photo-transfer/http";
import { PhotoLifecycleError, createPhotoLifecycleApi } from "./api";
import type { PhotoLifecycleDeps } from "./types";

type PhotoLifecycleRouteDeps = {
  /** Null until P13 accepts the purge worker and its narrowly scoped delete capability. */
  lifecycle: () => PhotoLifecycleDeps | null;
  verify: (request: Request) => Promise<VerifiedPhotoActor>;
  /** Canonical configured origins, never inferred from Host / forwarded headers. */
  origins: readonly string[];
  now?: () => number;
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...PRIVATE_PHOTO_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: unknown): Response {
  let code: PhotoErrorCode = "temporarily_unavailable";
  if (error instanceof PhotoLifecycleError || error instanceof PhotoTransferError) code = error.code;
  else if (error instanceof PhotoAuthError) {
    code = error.status === 401 ? "unauthenticated" : error.status === 403 ? "origin_rejected"
      : error.status === 400 ? "invalid_request" : "temporarily_unavailable";
  }
  const retryable = code === "temporarily_unavailable" || code === "rate_limited";
  const envelope: PhotoErrorEnvelope = {
    error: { code, requestId: randomUUID(), retryable, ...(retryable ? { retryAfterSeconds: 1 } : {}) },
  };
  const response = json(envelope, PHOTO_ERROR_STATUS[code]);
  if (retryable) response.headers.set("Retry-After", "1");
  return response;
}

function noBody(request: Request): void {
  const length = request.headers.get("content-length");
  if (request.body !== null || (length !== null && length !== "0") || request.headers.has("transfer-encoding")) {
    throw new PhotoLifecycleError("invalid_request");
  }
}

export function createPhotoLifecycleRoutes(deps: PhotoLifecycleRouteDeps) {
  async function run<T>(
    request: Request,
    method: "GET" | "POST",
    action: (owner: string, api: ReturnType<typeof createPhotoLifecycleApi>) => Promise<T>,
    options: { readonly mutation: boolean; readonly successStatus?: number },
  ): Promise<Response> {
    try {
      if (request.method !== method) throw new PhotoLifecycleError("invalid_request");
      const actor = await deps.verify(request);
      authorize(request, actor, deps.origins, deps.now?.() ?? Date.now(), options.mutation);
      const lifecycle = deps.lifecycle();
      if (!lifecycle) throw new PhotoLifecycleError("temporarily_unavailable");
      if (options.mutation) noBody(request);
      const api = createPhotoLifecycleApi(lifecycle);
      const result = await action(actor.userId, api);
      return json(result, options.successStatus ?? 200);
    } catch (error) {
      return errorResponse(error);
    }
  }

  const mutation = { mutation: true } as const;
  const read = { mutation: false } as const;
  return {
    trash: (request: Request, photoId: string) => run(request, "POST", (owner, api) =>
      api.trash(owner, photoId, idempotency(request)), mutation),
    restore: (request: Request, photoId: string) => run(request, "POST", (owner, api) =>
      api.restore(owner, photoId, idempotency(request)), mutation),
    purge: (request: Request, photoId: string) => run(request, "POST", (owner, api) =>
      api.purge(owner, photoId, idempotency(request)), { mutation: true, successStatus: 202 }),
    job: (request: Request, jobId: string) => run(request, "GET", (owner, api) => api.job(owner, jobId), read),
  };
}
