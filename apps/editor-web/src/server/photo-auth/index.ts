import "server-only";
import type { VerifiedPhotoActor } from "../../../../../packages/photo-library-contract/src/v1";
import { isTrustedNihoOrigin } from "../../auth/config";
import { AuthTemporarilyUnavailable, type AuthProvider } from "../../auth/types";
import { NIHO_SESSION_COOKIE } from "../../auth/niho";
import { isSameOriginRequest } from "../http";

const MAC_SESSION_PATH = "/api/auth/editor-connect/mac-session";
const CLIENT_ID = "niho-editor";
const AUDIENCE = "niho-photo";
const MAX_RESPONSE_BYTES = 8 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_MAC_SESSION_LIFETIME_MS = 2 * 60 * 60 * 1000;
const FORBIDDEN_IDENTITY_HEADERS = ["x-photo-owner-id", "x-niho-user-id", "x-actor-id", "x-owner-id"];

export class PhotoAuthError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 503, readonly code: string, readonly retryable = false) {
    super(code);
    this.name = "PhotoAuthError";
  }
}

export type PhotoAuthResult = { actor: VerifiedPhotoActor; refreshRequired: boolean };
export type PhotoAuthDeps = {
  auth: () => AuthProvider;
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  now?: () => number;
};

function hasCookie(header: string | null, name: string): boolean {
  return (header ?? "").split(";").some((part) => {
    const separator = part.indexOf("=");
    return separator > 0 && part.slice(0, separator).trim() === name;
  });
}

function parseBearer(value: string | null): string | null {
  if (!value || value.length > 8192) return null;
  const match = /^Bearer ([^\s]+)$/.exec(value);
  return match?.[1] ?? null;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function parseMacResponse(value: unknown): PhotoAuthResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["actor", "sessionId", "expiresAt", "clientId", "audience", "refreshRequired", "sourceClientId"])) return null;
  if (record.clientId !== CLIENT_ID || record.audience !== AUDIENCE || record.sourceClientId !== "niho-camera"
    || typeof record.sessionId !== "string" || record.sessionId.length === 0 || record.sessionId.length > 128
    || typeof record.expiresAt !== "string" || !Number.isFinite(Date.parse(record.expiresAt))
    || typeof record.refreshRequired !== "boolean") return null;
  if (typeof record.actor !== "object" || record.actor === null || Array.isArray(record.actor)) return null;
  const actor = record.actor as Record<string, unknown>;
  const actorKeys = Object.keys(actor).sort();
  const validActorKeys = actorKeys.length === 1 && actorKeys[0] === "id"
    || actorKeys.length === 2 && actorKeys[0] === "displayName" && actorKeys[1] === "id";
  if (!validActorKeys || typeof actor.id !== "string" || actor.id.length === 0 || actor.id.length > 128
    || (actor.displayName !== undefined && (typeof actor.displayName !== "string" || actor.displayName.length > 200))) return null;
  return {
    actor: {
      userId: actor.id,
      sessionId: record.sessionId,
      transport: "mac-bearer",
      expiresAt: record.expiresAt,
    },
    refreshRequired: record.refreshRequired,
  };
}

async function verifyMacBearer(request: Request, token: string, deps: PhotoAuthDeps): Promise<PhotoAuthResult> {
  const origin = deps.env?.EDITOR_NIHO_ORIGIN ?? process.env.EDITOR_NIHO_ORIGIN;
  if (!isTrustedNihoOrigin(origin)) throw new PhotoAuthError(503, "photo_auth_unavailable", true);
  let response: Response;
  try {
    response = await (deps.fetch ?? globalThis.fetch)(`${origin}${MAC_SESSION_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new PhotoAuthError(503, "photo_auth_unavailable", true);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) throw new PhotoAuthError(401, "unauthorized");
    throw new PhotoAuthError(503, "photo_auth_unavailable", true);
  }
  if (!/\bapplication\/json\b/i.test(response.headers.get("content-type") ?? "")) {
    throw new PhotoAuthError(503, "photo_auth_unavailable", true);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new PhotoAuthError(503, "photo_auth_unavailable", true);
  }
  let raw: unknown;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing_body");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("body_too_large");
      }
      chunks.push(chunk.value);
    }
    const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
    raw = JSON.parse(text);
  } catch {
    throw new PhotoAuthError(503, "photo_auth_unavailable", true);
  }
  const result = parseMacResponse(raw);
  const now = deps.now?.() ?? Date.now();
  const expiresAt = result ? Date.parse(result.actor.expiresAt) : Number.NaN;
  if (!result || !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + MAX_MAC_SESSION_LIFETIME_MS) {
    throw new PhotoAuthError(503, "photo_auth_unavailable", true);
  }
  // request由来のactor/owner headerは一切投影せず、NIHO検証結果だけで構築する。
  void request;
  return result;
}

export async function verifyPhotoActor(request: Request, deps: PhotoAuthDeps): Promise<PhotoAuthResult> {
  if (FORBIDDEN_IDENTITY_HEADERS.some((name) => request.headers.has(name))) {
    throw new PhotoAuthError(400, "identity_header_forbidden");
  }
  const bearer = parseBearer(request.headers.get("authorization"));
  const hasBrowserCredential = hasCookie(request.headers.get("cookie"), NIHO_SESSION_COOKIE);
  if (bearer && hasBrowserCredential) throw new PhotoAuthError(400, "ambiguous_authentication");
  if (request.headers.has("authorization") && !bearer) throw new PhotoAuthError(401, "unauthorized");
  if (bearer) return verifyMacBearer(request, bearer, deps);
  if (hasBrowserCredential && !["GET", "HEAD", "OPTIONS"].includes(request.method)
    && !isSameOriginRequest(request, deps.env)) {
    throw new PhotoAuthError(403, "origin_rejected");
  }

  let session;
  try {
    session = await deps.auth().getSession({ headers: request.headers });
  } catch (error) {
    if (error instanceof AuthTemporarilyUnavailable) throw new PhotoAuthError(503, "photo_auth_unavailable", true);
    throw error;
  }
  if (!session || session.mode !== "niho" || !session.sessionId || !session.expiresAt) {
    throw new PhotoAuthError(401, "unauthorized");
  }
  return {
    actor: {
      userId: session.userId,
      sessionId: session.sessionId,
      transport: "browser-session",
      expiresAt: session.expiresAt,
    },
    refreshRequired: session.refreshRequired === true,
  };
}
