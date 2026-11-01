import "server-only";
import { randomUUID } from "node:crypto";
import {
  PHOTO_ERROR_STATUS,
  PHOTO_LIMITS,
  type PhotoErrorCode,
  type PhotoErrorEnvelope,
  type VerifiedPhotoActor,
} from "../../../../../packages/photo-library-contract/src/v1";
import { PhotoAuthError } from "../photo-auth";
import { authorize, PhotoTransferError, PRIVATE_PHOTO_HEADERS } from "../photo-transfer/http";
import { PhotoRecipeError, createPhotoRecipesApi } from "./api";
import type { PhotoRecipeDeps } from "./types";

type PhotoRecipeRouteDeps = {
  /** Resolved only after P01 verifies the current request. Null keeps incomplete production wiring closed. */
  recipes: () => PhotoRecipeDeps | null;
  verify: (request: Request) => Promise<VerifiedPhotoActor>;
  /** Canonical configured origins, never inferred from Host / forwarded headers. */
  origins: readonly string[];
  now?: () => number;
};

function errorResponse(error: unknown): Response {
  let code: PhotoErrorCode = "temporarily_unavailable";
  let currentRevision: number | undefined;
  if (error instanceof PhotoRecipeError) {
    code = error.code;
    currentRevision = error.currentRevision;
  } else if (error instanceof PhotoTransferError) {
    code = error.code;
  } else if (error instanceof PhotoAuthError) {
    code = error.status === 401 ? "unauthenticated" : error.status === 403 ? "origin_rejected"
      : error.status === 400 ? "invalid_request" : "temporarily_unavailable";
  }
  const retryable = code === "temporarily_unavailable" || code === "rate_limited";
  const envelope: PhotoErrorEnvelope = {
    error: {
      code,
      requestId: randomUUID(),
      retryable,
      ...(currentRevision === undefined ? {} : { currentRevision }),
      ...(retryable ? { retryAfterSeconds: 1 } : {}),
    },
  };
  return new Response(JSON.stringify(envelope), {
    status: PHOTO_ERROR_STATUS[code],
    headers: {
      ...PRIVATE_PHOTO_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      ...(retryable ? { "Retry-After": "1" } : {}),
    },
  });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { ...PRIVATE_PHOTO_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) {
    throw new PhotoRecipeError("invalid_request");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && !/^\d+$/.test(declaredLength)) throw new PhotoRecipeError("invalid_request");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) throw new PhotoRecipeError("request_too_large");
  if (!request.body) throw new PhotoRecipeError("invalid_request");

  const reader = request.body.getReader();
  const pieces: Uint8Array[] = [];
  let size = 0;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new PhotoRecipeError("request_too_large");
      pieces.push(chunk.value);
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pieces)));
    const stack = [{ value, depth: 0 }];
    while (stack.length) {
      const item = stack.pop()!;
      if (item.depth > PHOTO_LIMITS.maxJsonDepth) throw new PhotoRecipeError("invalid_request");
      if (item.value !== null && typeof item.value === "object") {
        for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1 });
      }
    }
    return value;
  } catch (error) {
    if (error instanceof PhotoRecipeError || signal.aborted) throw error;
    throw new PhotoRecipeError("invalid_request");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createPhotoRecipesRoutes(deps: PhotoRecipeRouteDeps) {
  async function run(
    request: Request,
    method: "GET" | "PUT",
    action: (owner: string, api: ReturnType<typeof createPhotoRecipesApi>) => Promise<Response>,
  ): Promise<Response> {
    try {
      if (request.method !== method) throw new PhotoRecipeError("invalid_request");
      const actor = await deps.verify(request);
      authorize(request, actor, deps.origins, deps.now?.() ?? Date.now(), method === "PUT");
      const recipeDeps = deps.recipes();
      if (!recipeDeps) throw new PhotoRecipeError("temporarily_unavailable");
      return await action(actor.userId, createPhotoRecipesApi(recipeDeps));
    } catch (error) {
      return errorResponse(error);
    }
  }

  return {
    putRecipe: (request: Request, photoId: string) => run(request, "PUT", async (owner, api) => {
      const body = await readJsonBody(request, PHOTO_LIMITS.maxRecipeBodyBytes);
      const receipt = await api.putRecipe(owner, photoId, body, request.headers.get("idempotency-key"));
      return json(receipt);
    }),
    getVersions: (request: Request, photoId: string) => run(request, "GET", async (owner, api) => {
      return json(await api.getVersions(owner, photoId));
    }),
    putVersions: (request: Request, photoId: string) => run(request, "PUT", async (owner, api) => {
      const body = await readJsonBody(request, PHOTO_LIMITS.maxVersionsBodyBytes);
      const receipt = await api.putVersions(owner, photoId, body, request.headers.get("idempotency-key"));
      return json(receipt);
    }),
  };
}
