import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isTrustedNihoOrigin } from "./config";
import { loginPath, safeReturnTo } from "./return-to";
import { AuthTemporarilyUnavailable, type AuthProvider, type Session, type SessionRequest } from "./types";

const CLIENT_ID = "niho-editor";
const AUDIENCE = "niho-photo";
const BEGIN_PATH = "/api/auth/editor-connect/begin";
const EXCHANGE_PATH = "/api/auth/editor-connect/exchange";
const INTROSPECT_PATH = "/api/auth/editor-connect/introspect";
const REFRESH_PATH = "/api/auth/editor-connect/refresh";
const REVOKE_PATH = "/api/auth/editor-connect/revoke";
const CANCEL_PATH = "/api/auth/editor-connect/cancel";
const CONFIRMATION_PATH = "/connect/niho-editor";

export const NIHO_PENDING_COOKIE = "__Host-editor-niho-pending";
export const NIHO_SESSION_COOKIE = "__Host-editor-niho-session";
const COOKIE_FLAGS = "HttpOnly; Secure; SameSite=Lax; Path=/";
const PENDING_TTL_SECONDS = 10 * 60;
const MAX_COOKIE_VALUE = 4096;
const MAX_RESPONSE_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const PENDING_COOKIE_TTL_SECONDS = PENDING_TTL_SECONDS + Math.ceil(REQUEST_TIMEOUT_MS / 1000);
const MAX_SESSION_LIFETIME_MS = 31 * 24 * 60 * 60 * 1000;
const STATE_RE = /^[A-Za-z0-9._~-]{22,128}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREDENTIAL_RE = /^v1\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/i;

type Env = Readonly<Record<string, string | undefined>>;
type Pending = { attemptId: string; state: string; verifier: string; returnTo: string; expiresAt: number };
type SessionPayload = {
  actor: { id: string; displayName?: string };
  sessionId: string;
  expiresAt: string;
  clientId: typeof CLIENT_ID;
  audience: typeof AUDIENCE;
  refreshRequired: boolean;
};
type CredentialPayload = SessionPayload & { credential: string };

export type NihoAuthDeps = {
  env?: () => Env;
  fetch?: typeof fetch;
  now?: () => number;
  randomValue?: () => string;
};

class UpstreamResponseError extends Error {
  constructor(readonly status: number) {
    super("NIHO authentication request failed");
    this.name = "UpstreamResponseError";
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function cookieValues(header: string | null, name: string): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0 || part.slice(0, index).trim() !== name) continue;
    values.push(part.slice(index + 1).trim());
  }
  return values;
}

function singletonCookie(header: string | null, name: string): string | null {
  const values = cookieValues(header, name);
  if (values.length !== 1 || values[0]!.length === 0 || values[0]!.length > MAX_COOKIE_VALUE) return null;
  return values[0]!;
}

function hasDuplicateCookie(header: string | null, name: string): boolean {
  return cookieValues(header, name).length > 1;
}

function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; ${COOKIE_FLAGS}`;
}

function clearCookie(name: string): string {
  return `${name}=; Max-Age=0; ${COOKIE_FLAGS}`;
}

function redirectTo(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function unavailableResponse(returnTo: string): Response {
  return redirectTo(loginPath(returnTo, "unavailable"));
}

function temporaryUnavailable(): Response {
  return Response.json(
    { error: "temporarily_unavailable", retryable: true },
    { status: 503, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
  );
}

function encodePending(pending: Pending): string {
  return Buffer.from(JSON.stringify(pending)).toString("base64url");
}

function parsePending(raw: string | null): Pending | null {
  if (!raw || raw.length > MAX_COOKIE_VALUE) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["attemptId", "state", "verifier", "returnTo", "expiresAt"])) return null;
  if (typeof record.attemptId !== "string" || !UUID_RE.test(record.attemptId)
    || typeof record.state !== "string" || !STATE_RE.test(record.state)
    || typeof record.verifier !== "string" || !VERIFIER_RE.test(record.verifier)
    || typeof record.returnTo !== "string" || safeReturnTo(record.returnTo) !== record.returnTo
    || typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) return null;
  return record as Pending;
}

function readPending(raw: string | null, nowMs: number): Pending | null {
  const pending = parsePending(raw);
  return pending && pending.expiresAt > nowMs ? pending : null;
}

function readCancelablePending(raw: string | null, nowMs: number): Pending | null {
  const pending = parsePending(raw);
  return pending && pending.expiresAt + REQUEST_TIMEOUT_MS > nowMs ? pending : null;
}

function safeCredential(raw: string | null): string | null {
  return raw && raw.length <= 96 && CREDENTIAL_RE.test(raw) ? raw : null;
}

function sameValue(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/\bapplication\/json\b/i.test(contentType)) throw new UpstreamResponseError(response.status || 502);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamResponseError(502);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new UpstreamResponseError(502);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new UpstreamResponseError(502);
    }
    chunks.push(chunk.value);
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamResponseError(502);
  }
}

async function callNiho(fetchFn: typeof fetch, origin: string, path: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new AuthTemporarilyUnavailable("niho_request_failed");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status >= 500 || response.status === 404 || response.status === 429) {
      throw new AuthTemporarilyUnavailable("niho_temporarily_unavailable");
    }
    throw new UpstreamResponseError(response.status);
  }
  if (response.status === 204) return null;
  return readJsonResponse(response);
}

function parseSessionPayload(value: unknown): SessionPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["actor", "sessionId", "expiresAt", "clientId", "audience", "refreshRequired"])) return null;
  if (record.clientId !== CLIENT_ID || record.audience !== AUDIENCE || typeof record.refreshRequired !== "boolean"
    || typeof record.sessionId !== "string" || record.sessionId.length === 0 || record.sessionId.length > 128
    || typeof record.expiresAt !== "string" || !Number.isFinite(Date.parse(record.expiresAt))) return null;
  if (typeof record.actor !== "object" || record.actor === null || Array.isArray(record.actor)) return null;
  const actor = record.actor as Record<string, unknown>;
  const actorKeys = Object.keys(actor).sort();
  const validActorKeys = actorKeys.length === 1 && actorKeys[0] === "id"
    || actorKeys.length === 2 && actorKeys[0] === "displayName" && actorKeys[1] === "id";
  if (!validActorKeys || typeof actor.id !== "string" || actor.id.length === 0 || actor.id.length > 128
    || (actor.displayName !== undefined && (typeof actor.displayName !== "string" || actor.displayName.length > 200))) return null;
  return record as SessionPayload;
}

function parseCredentialPayload(value: unknown): CredentialPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["actor", "sessionId", "expiresAt", "clientId", "audience", "refreshRequired", "credential"])) return null;
  const { credential, ...session } = record;
  const parsed = parseSessionPayload(session);
  return parsed && typeof credential === "string" && safeCredential(credential) ? { ...parsed, credential } : null;
}

function validSessionExpiry(value: string, nowMs: number): number | null {
  const expiresAt = Date.parse(value);
  return Number.isFinite(expiresAt)
    && expiresAt > nowMs
    && expiresAt <= nowMs + MAX_SESSION_LIFETIME_MS
    ? expiresAt
    : null;
}

function sessionFromPayload(payload: SessionPayload): Session {
  return {
    userId: payload.actor.id,
    mode: "niho",
    sessionId: payload.sessionId,
    expiresAt: payload.expiresAt,
    refreshRequired: payload.refreshRequired,
    ...(payload.actor.displayName ? { profile: { name: payload.actor.displayName } } : {}),
  };
}

function logFailure(step: string): void {
  console.error("editor-web: NIHO authentication failed", { step });
}

export function createNihoAuthProvider(deps: NihoAuthDeps = {}): AuthProvider {
  const readEnv = deps.env ?? (() => process.env as Env);
  const fetchFn = deps.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const now = deps.now ?? (() => Date.now());
  const randomValue = deps.randomValue ?? (() => randomBytes(32).toString("base64url"));

  function origin(): string | null {
    const value = readEnv().EDITOR_NIHO_ORIGIN;
    return isTrustedNihoOrigin(value) ? value! : null;
  }

  async function cancelPending(nihoOrigin: string, pending: Pending | null): Promise<void> {
    if (!pending) return;
    await callNiho(fetchFn, nihoOrigin, CANCEL_PATH, {
      clientId: CLIENT_ID,
      attemptId: pending.attemptId,
      codeVerifier: pending.verifier,
    });
  }

  return {
    mode: "niho",

    async getSession(request: SessionRequest): Promise<Session | null> {
      const nihoOrigin = origin();
      if (!nihoOrigin) throw new AuthTemporarilyUnavailable("niho_config_invalid");
      const header = request.headers.get("cookie");
      if (hasDuplicateCookie(header, NIHO_SESSION_COOKIE)) return null;
      const credential = safeCredential(singletonCookie(header, NIHO_SESSION_COOKIE));
      if (!credential) return null;
      let raw: unknown;
      try {
        raw = await callNiho(fetchFn, nihoOrigin, INTROSPECT_PATH, {
          clientId: CLIENT_ID,
          audience: AUDIENCE,
          credential,
        });
      } catch (error) {
        if (error instanceof UpstreamResponseError && [400, 401, 403].includes(error.status)) return null;
        throw error;
      }
      const payload = parseSessionPayload(raw);
      if (!payload) throw new AuthTemporarilyUnavailable("niho_response_invalid");
      if (validSessionExpiry(payload.expiresAt, now()) === null) throw new AuthTemporarilyUnavailable("niho_response_invalid");
      return sessionFromPayload(payload);
    },

    async beginLogin({ request, returnTo }): Promise<Response> {
      const nihoOrigin = origin();
      if (!nihoOrigin) return unavailableResponse(returnTo);
      const cookieHeader = request.headers.get("cookie");
      if (hasDuplicateCookie(cookieHeader, NIHO_PENDING_COOKIE)
        || hasDuplicateCookie(cookieHeader, NIHO_SESSION_COOKIE)) return unavailableResponse(returnTo);
      // attempt期限後もrequest timeout margin中はproofを保持し、遅着exchangeをcancelで閉じる。
      const previous = readCancelablePending(singletonCookie(cookieHeader, NIHO_PENDING_COOKIE), now());
      try {
        await cancelPending(nihoOrigin, previous);
      } catch {
        logFailure("cancel_previous");
        return unavailableResponse(returnTo);
      }
      const state = randomValue();
      const verifier = randomValue();
      if (!STATE_RE.test(state) || !VERIFIER_RE.test(verifier)) return unavailableResponse(returnTo);
      const codeChallenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
      try {
        const raw = await callNiho(fetchFn, nihoOrigin, BEGIN_PATH, {
          clientId: CLIENT_ID,
          state,
          codeChallenge,
          codeChallengeMethod: "S256",
        });
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("shape");
        const value = raw as Record<string, unknown>;
        if (!exactKeys(value, ["attemptId", "expiresAt", "confirmationPath"])
          || typeof value.attemptId !== "string" || !UUID_RE.test(value.attemptId)
          || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
          || typeof value.confirmationPath !== "string" || value.confirmationPath.length > 1024
          || !value.confirmationPath.startsWith("/") || value.confirmationPath.startsWith("//")) throw new Error("shape");
        const confirmation = new URL(value.confirmationPath, nihoOrigin);
        if (confirmation.origin !== nihoOrigin || confirmation.pathname !== CONFIRMATION_PATH
          || confirmation.searchParams.size !== 2
          || confirmation.searchParams.get("attempt_id") !== value.attemptId
          || confirmation.searchParams.get("state") !== state) throw new Error("shape");
        const expiresAt = Math.min(Date.parse(value.expiresAt), now() + PENDING_TTL_SECONDS * 1000);
        if (expiresAt <= now()) throw new Error("shape");
        const pending = encodePending({
          attemptId: value.attemptId,
          state,
          verifier,
          returnTo: safeReturnTo(returnTo),
          expiresAt,
        });
        return redirectTo(confirmation.toString(), [setCookie(NIHO_PENDING_COOKIE, pending, PENDING_COOKIE_TTL_SECONDS)]);
      } catch {
        logFailure("begin");
        return unavailableResponse(returnTo);
      }
    },

    async completeLogin(request: Request): Promise<Response> {
      const nihoOrigin = origin();
      if (!nihoOrigin) return unavailableResponse("/");
      const cookieHeader = request.headers.get("cookie");
      if (hasDuplicateCookie(cookieHeader, NIHO_PENDING_COOKIE)
        || hasDuplicateCookie(cookieHeader, NIHO_SESSION_COOKIE)) return unavailableResponse("/");
      const pending = readPending(singletonCookie(cookieHeader, NIHO_PENDING_COOKIE), now());
      const returnTo = pending?.returnTo ?? "/";
      const params = new URL(request.url).searchParams;
      const keys = [...params.keys()].sort();
      const state = params.get("state");
      const code = params.get("code");
      if (!pending || keys.length !== 2 || keys[0] !== "code" || keys[1] !== "state"
        || !state || !code || !CODE_RE.test(code) || !sameValue(state, pending.state)) {
        logFailure("callback_validation");
        return unavailableResponse(returnTo);
      }
      const existingCredential = safeCredential(singletonCookie(cookieHeader, NIHO_SESSION_COOKIE));
      try {
        const raw = await callNiho(fetchFn, nihoOrigin, EXCHANGE_PATH, {
          clientId: CLIENT_ID,
          audience: AUDIENCE,
          attemptId: pending.attemptId,
          code,
          codeVerifier: pending.verifier,
          ...(existingCredential ? { replaceCredential: existingCredential } : {}),
        });
        const payload = parseCredentialPayload(raw);
        if (!payload) throw new AuthTemporarilyUnavailable("niho_response_invalid");
        const at = now();
        const expiresAt = validSessionExpiry(payload.expiresAt, at);
        if (expiresAt === null) throw new AuthTemporarilyUnavailable("niho_response_invalid");
        const maxAge = Math.max(1, Math.floor((expiresAt - at) / 1000));
        return redirectTo(safeReturnTo(pending.returnTo), [
          clearCookie(NIHO_PENDING_COOKIE),
          setCookie(NIHO_SESSION_COOKIE, payload.credential, maxAge),
        ]);
      } catch {
        logFailure("exchange");
        return unavailableResponse(returnTo);
      }
    },

    async refresh(request: Request): Promise<Response> {
      const nihoOrigin = origin();
      if (!nihoOrigin) return temporaryUnavailable();
      const cookieHeader = request.headers.get("cookie");
      if (hasDuplicateCookie(cookieHeader, NIHO_SESSION_COOKIE)) return new Response(null, { status: 401 });
      const credential = safeCredential(singletonCookie(cookieHeader, NIHO_SESSION_COOKIE));
      if (!credential) return new Response(null, { status: 401, headers: { "Cache-Control": "no-store" } });
      try {
        const raw = await callNiho(fetchFn, nihoOrigin, REFRESH_PATH, {
          clientId: CLIENT_ID,
          audience: AUDIENCE,
          credential,
        });
        const payload = parseCredentialPayload(raw);
        if (!payload) throw new AuthTemporarilyUnavailable("niho_response_invalid");
        const at = now();
        const expiresAt = validSessionExpiry(payload.expiresAt, at);
        if (expiresAt === null) throw new AuthTemporarilyUnavailable("niho_response_invalid");
        const maxAge = Math.max(1, Math.floor((expiresAt - at) / 1000));
        const headers = new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
        headers.append("Set-Cookie", setCookie(NIHO_SESSION_COOKIE, payload.credential, maxAge));
        return Response.json({
          sessionId: payload.sessionId,
          userId: payload.actor.id,
          expiresAt: payload.expiresAt,
          refreshRequired: payload.refreshRequired,
        }, { headers });
      } catch (error) {
        if (error instanceof UpstreamResponseError && error.status === 401) {
          return new Response(null, { status: 401, headers: { "Cache-Control": "no-store" } });
        }
        return temporaryUnavailable();
      }
    },

    async logout(request: Request): Promise<Response> {
      const nihoOrigin = origin();
      if (!nihoOrigin) return temporaryUnavailable();
      const cookieHeader = request.headers.get("cookie");
      if (hasDuplicateCookie(cookieHeader, NIHO_PENDING_COOKIE)
        || hasDuplicateCookie(cookieHeader, NIHO_SESSION_COOKIE)) return temporaryUnavailable();
      const pending = readCancelablePending(singletonCookie(cookieHeader, NIHO_PENDING_COOKIE), now());
      const credential = safeCredential(singletonCookie(cookieHeader, NIHO_SESSION_COOKIE));
      try {
        await Promise.all([
          cancelPending(nihoOrigin, pending),
          credential ? callNiho(fetchFn, nihoOrigin, REVOKE_PATH, {
            clientId: CLIENT_ID,
            audience: AUDIENCE,
            credential,
          }) : Promise.resolve(),
        ]);
      } catch {
        logFailure("logout_remote");
        return temporaryUnavailable();
      }
      return redirectTo("/auth/login", [clearCookie(NIHO_PENDING_COOKIE), clearCookie(NIHO_SESSION_COOKIE)]);
    },

    async apiToken() {
      return null;
    },
  };
}

export const nihoAuthProvider: AuthProvider = createNihoAuthProvider();
