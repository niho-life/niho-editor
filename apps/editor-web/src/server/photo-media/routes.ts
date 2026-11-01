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
import { createPhotoMediaApi, PhotoMediaError } from "./api";
import type { PhotoMediaDeps } from "./types";

const MAX_BODY_BYTES = Math.min(PHOTO_LIMITS.maxOtherBodyBytes, 4 * 1024);
const BODY_DEADLINE_MS = 2_000;

export type PhotoMediaRouteDeps = {
  /** Resolved only after P01 verifies the request. Null keeps incomplete production wiring closed. */
  media: () => PhotoMediaDeps | null;
  verify: (request: Request) => Promise<VerifiedPhotoActor>;
  /** Canonical configured origins, never inferred from request forwarding headers. */
  origins: readonly string[];
  now?: () => number;
};

function errorResponse(error: unknown): Response {
  let code: PhotoErrorCode = "temporarily_unavailable";
  let currentRevision: number | undefined;
  if (error instanceof PhotoMediaError) {
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

async function readJsonBody(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) {
    throw new PhotoMediaError("invalid_request");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && !/^\d+$/.test(declaredLength)) throw new PhotoMediaError("invalid_request");
  if (declaredLength !== null && Number(declaredLength) > MAX_BODY_BYTES) throw new PhotoMediaError("request_too_large");
  if (!request.body) throw new PhotoMediaError("invalid_request");

  const reader = request.body.getReader();
  const pieces: Uint8Array[] = [];
  let size = 0;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(BODY_DEADLINE_MS)]);
  let rejectAbort: ((reason: PhotoMediaError) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
    rejectAbort?.(new PhotoMediaError("temporarily_unavailable"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const consume = (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new PhotoMediaError("request_too_large");
      pieces.push(chunk.value);
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pieces)));
    } catch {
      throw new PhotoMediaError("invalid_request");
    }
    const stack = [{ value, depth: 0 }];
    while (stack.length) {
      const item = stack.pop()!;
      if (item.depth > PHOTO_LIMITS.maxJsonDepth) throw new PhotoMediaError("invalid_request");
      if (item.value !== null && typeof item.value === "object") {
        for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1 });
      }
    }
    return value;
  })();
  try {
    signal.throwIfAborted();
    return await Promise.race([consume, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    rejectAbort = undefined;
    void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A hostile pending read is fenced by the deadline race. */ }
  }
}

export function createPhotoMediaRoutes(deps: PhotoMediaRouteDeps) {
  return {
    ensure: async (request: Request, photoId: string): Promise<Response> => {
      try {
        if (request.method !== "POST") throw new PhotoMediaError("invalid_request");
        const actor = await deps.verify(request);
        const now = deps.now?.() ?? Date.now();
        authorize(request, actor, deps.origins, now, true);
        const mediaDeps = deps.media();
        if (!mediaDeps) throw new PhotoMediaError("temporarily_unavailable");
        const body = await readJsonBody(request);
        const receipt = await createPhotoMediaApi(mediaDeps).ensure(
          actor.userId,
          photoId,
          body,
          request.headers.get("idempotency-key"),
        );
        return json(receipt);
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
