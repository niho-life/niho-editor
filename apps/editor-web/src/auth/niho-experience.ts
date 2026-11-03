import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { autoFormResponse } from "./auto-form";
import { isTrustedNihoOrigin } from "./config";
import { loginPath, safeReturnTo } from "./return-to";
import { AuthTemporarilyUnavailable, type AuthProvider, type Session, type SessionRequest } from "./types";

const CLIENT_ID = "niho-experience-editor";
const CONNECT_PATH = "/connect/niho-editor";
const CONNECT_START_PATH = `${CONNECT_PATH}/start`;
const EXCHANGE_PATH = "/api/auth/experience-editor-connect/exchange";
const REFRESH_PATH = "/api/auth/experience-editor-connect/refresh";
const SESSION_PATH = "/api/auth/experience-editor-connect/session";
const REVOKE_PATH = "/api/auth/experience-editor-connect/revoke";
const CALLBACK_PATH = "/editor/auth/callback";

export const EXPERIENCE_EDITOR_PENDING_COOKIE = "__Host-editor-experience-pending";
export const EXPERIENCE_EDITOR_ID_TOKEN_COOKIE = "__Host-editor-experience-id";
export const EXPERIENCE_EDITOR_FIREBASE_REFRESH_COOKIE = "__Host-editor-experience-firebase-refresh";
export const EXPERIENCE_EDITOR_REFRESH_COOKIE = "__Host-editor-experience-refresh";
export const EXPERIENCE_EDITOR_EXPIRY_COOKIE = "__Host-editor-experience-expiry";

const COOKIE_FLAGS = "HttpOnly; Secure; SameSite=Lax; Path=/";
const LOGIN_TTL_SECONDS = 10 * 60;
const COOKIE_TTL_MARGIN_SECONDS = 20;
const MAX_COOKIE_VALUE = 8192;
const MAX_RESPONSE_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const CALLBACK_BODY_TIMEOUT_MS = 2_000;
const MAX_CALLBACK_BODY_BYTES = 4 * 1024;
const MAX_CONNECTION_LIFETIME_MS = 184 * 24 * 60 * 60 * 1000;
const CONNECTION_REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_RE = /^[A-Za-z0-9._~-]{22,128}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_RE = /^[A-Za-z0-9._~-]{32,8192}$/;
const API_KEY_RE = /^[A-Za-z0-9_-]{20,128}$/;

type Env = Readonly<Record<string, string | undefined>>;
type Pending = { state: string; verifier: string; returnTo: string; expiresAt: number };
type CallbackFields = { code: string; state: string };
type FirebaseTokens = { idToken: string; refreshToken: string; expiresInSeconds: number };
type ConnectionPayload = {
  customToken: string;
  refreshToken: string;
  connectionId: string;
  connectionExpiresAt: string;
  userId: string;
};
type SessionPayload = { actorId: string; connectionId: string; expiresAt: string };

export type NihoExperienceAuthDeps = {
  env?: () => Env;
  fetch?: typeof fetch;
  now?: () => number;
  randomValue?: () => string;
};

class UpstreamResponseError extends Error {
  constructor(readonly status: number) {
    super("NIHO experience authentication request failed");
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
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) values.push(part.slice(separator + 1).trim());
  }
  return values;
}

function cookieValue(header: string | null, name: string): string | null {
  const values = cookieValues(header, name);
  if (values.length !== 1 || values[0]!.length === 0 || values[0]!.length > MAX_COOKIE_VALUE) return null;
  return values[0]!;
}

function hasDuplicateCookie(header: string | null, name: string): boolean {
  return cookieValues(header, name).length > 1;
}

function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Max-Age=${Math.max(1, Math.floor(maxAge))}; ${COOKIE_FLAGS}`;
}

function clearCookie(name: string): string {
  return `${name}=; Max-Age=0; ${COOKIE_FLAGS}`;
}

const ALL_COOKIES = [
  EXPERIENCE_EDITOR_PENDING_COOKIE,
  EXPERIENCE_EDITOR_ID_TOKEN_COOKIE,
  EXPERIENCE_EDITOR_FIREBASE_REFRESH_COOKIE,
  EXPERIENCE_EDITOR_REFRESH_COOKIE,
  EXPERIENCE_EDITOR_EXPIRY_COOKIE,
] as const;

function clearAllCookies(): string[] {
  return ALL_COOKIES.map(clearCookie);
}

function redirectTo(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function unavailableResponse(returnTo: string): Response {
  return redirectTo(loginPath(returnTo, "unavailable"), [clearCookie(EXPERIENCE_EDITOR_PENDING_COOKIE)]);
}

function unauthorizedResponse(): Response {
  const headers = new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  for (const cookie of clearAllCookies()) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 401, headers });
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
  if (!exactKeys(record, ["state", "verifier", "returnTo", "expiresAt"])
    || typeof record.state !== "string" || !STATE_RE.test(record.state)
    || typeof record.verifier !== "string" || !VERIFIER_RE.test(record.verifier)
    || typeof record.returnTo !== "string" || safeReturnTo(record.returnTo) !== record.returnTo
    || typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) return null;
  return record as Pending;
}

function readPending(raw: string | null, now: number): Pending | null {
  const pending = parsePending(raw);
  return pending && pending.expiresAt > now ? pending : null;
}

function sameValue(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function isUrlEncoded(value: string | null): boolean {
  return value !== null && /^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(value.trim());
}

function badCallback(status = 400, step = "callback_body"): Response {
  console.error("editor-web: NIHO Experience authentication failed", { step, status });
  return Response.json({ error: status === 413 ? "payload_too_large" : "bad_request" }, {
    status,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

type CallbackOriginClass = "missing" | "opaque" | "niho" | "editor" | "niho_alias" | "external" | "invalid";

function callbackOriginClass(value: string | null, nihoOrigin: string, editorOrigin: string): CallbackOriginClass {
  if (value === null) return "missing";
  if (value === "null") return "opaque";
  if (value === nihoOrigin) return "niho";
  if (value === editorOrigin) return "editor";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.origin !== value) return "invalid";
    const nihoHost = new URL(nihoOrigin).hostname;
    return parsed.hostname.endsWith(`.${nihoHost}`) ? "niho_alias" : "external";
  } catch {
    return "invalid";
  }
}

async function readCallbackFields(request: Request): Promise<CallbackFields | Response> {
  if (request.signal.aborted) return badCallback(400, "callback_aborted");
  if (!isUrlEncoded(request.headers.get("content-type"))) return badCallback(400, "callback_content_type");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_CALLBACK_BODY_BYTES)) {
    return badCallback(Number(declared) > MAX_CALLBACK_BODY_BYTES ? 413 : 400, "callback_content_length");
  }
  const reader = request.body?.getReader();
  if (!reader) return badCallback(400, "callback_body_missing");
  let rejectAbort!: () => void;
  const abortGate = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(new Error("aborted")); });
  const onAbort = () => rejectAbort();
  request.signal.addEventListener("abort", onAbort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("timeout")), CALLBACK_BODY_TIMEOUT_MS);
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline, abortGate]);
      if (done) { complete = true; break; }
      total += value.byteLength;
      if (total > MAX_CALLBACK_BODY_BYTES) return badCallback(413, "callback_body_size");
      chunks.push(value);
    }
  } catch {
    return badCallback(400, "callback_body_read");
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    request.signal.removeEventListener("abort", onAbort);
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return badCallback(400, "callback_body_encoding"); }
  const fields = new Map<string, string>();
  const parts = text.split("&");
  if (parts.length !== 2) return badCallback(400, "callback_body_fields");
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator <= 0) return badCallback(400, "callback_body_field_name");
    const key = part.slice(0, separator);
    if ((key !== "code" && key !== "state") || fields.has(key)) return badCallback(400, "callback_body_field_name");
    try { fields.set(key, decodeURIComponent(part.slice(separator + 1).replace(/\+/g, " "))); } catch { return badCallback(400, "callback_body_encoding"); }
  }
  const code = fields.get("code");
  const state = fields.get("state");
  return code && CODE_RE.test(code) && state && STATE_RE.test(state)
    ? { code, state }
    : badCallback(400, "callback_field_format");
}

async function readJson(response: Response): Promise<unknown> {
  if (!/\bapplication\/json\b/i.test(response.headers.get("content-type") ?? "")) throw new UpstreamResponseError(response.status || 502);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamResponseError(502);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new UpstreamResponseError(502);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new UpstreamResponseError(502);
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try { return JSON.parse(body); } catch { throw new UpstreamResponseError(502); }
}

function expiryMs(raw: unknown, now: number): number | null {
  if (typeof raw !== "string") return null;
  const value = Date.parse(raw);
  return Number.isFinite(value) && value > now && value <= now + MAX_CONNECTION_LIFETIME_MS ? value : null;
}

function parseConnectionPayload(value: unknown, now: number): ConnectionPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["customToken", "refreshToken", "connectionId", "connectionExpiresAt", "user"])) return null;
  if (typeof record.customToken !== "string" || record.customToken.length < 32 || record.customToken.length > 8192
    || typeof record.refreshToken !== "string" || !TOKEN_RE.test(record.refreshToken)
    || typeof record.connectionId !== "string" || record.connectionId.length === 0 || record.connectionId.length > 128
    || expiryMs(record.connectionExpiresAt, now) === null
    || typeof record.user !== "object" || record.user === null || Array.isArray(record.user)) return null;
  const user = record.user as Record<string, unknown>;
  if (!exactKeys(user, ["id", "displayName", "handle", "iconImage"])
    || typeof user.id !== "string" || user.id.length === 0 || user.id.length > 128
    || (user.displayName !== null && typeof user.displayName !== "string")
    || (user.handle !== null && typeof user.handle !== "string")
    || (user.iconImage !== null && (typeof user.iconImage !== "object" || Array.isArray(user.iconImage)))) return null;
  return {
    customToken: record.customToken,
    refreshToken: record.refreshToken,
    connectionId: record.connectionId,
    connectionExpiresAt: record.connectionExpiresAt as string,
    userId: user.id,
  };
}

function parseRefreshPayload(value: unknown, now: number): { customToken: string; refreshToken: string; connectionExpiresAt: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["customToken", "expiresAt", "refreshToken", "connectionExpiresAt"])
    || typeof record.customToken !== "string" || record.customToken.length < 32 || record.customToken.length > 8192
    || typeof record.expiresAt !== "string" || !Number.isFinite(Date.parse(record.expiresAt))
    || typeof record.refreshToken !== "string" || !TOKEN_RE.test(record.refreshToken)
    || expiryMs(record.connectionExpiresAt, now) === null) return null;
  return {
    customToken: record.customToken,
    refreshToken: record.refreshToken,
    connectionExpiresAt: record.connectionExpiresAt as string,
  };
}

function parseSessionPayload(value: unknown, now: number): SessionPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["actor", "connection", "account"])
    || typeof record.actor !== "object" || record.actor === null || Array.isArray(record.actor)
    || typeof record.connection !== "object" || record.connection === null || Array.isArray(record.connection)
    || typeof record.account !== "object" || record.account === null || Array.isArray(record.account)) return null;
  const actor = record.actor as Record<string, unknown>;
  const connection = record.connection as Record<string, unknown>;
  const account = record.account as Record<string, unknown>;
  if (!exactKeys(actor, ["id"]) || typeof actor.id !== "string" || actor.id.length === 0 || actor.id.length > 128
    || !exactKeys(connection, ["id", "expiresAt"]) || typeof connection.id !== "string" || connection.id.length === 0
    || connection.id.length > 128 || expiryMs(connection.expiresAt, now) === null
    || !exactKeys(account, ["active"]) || account.active !== true) return null;
  return { actorId: actor.id, connectionId: connection.id, expiresAt: connection.expiresAt as string };
}

function parseFirebaseTokens(value: unknown): FirebaseTokens | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const expires = typeof record.expiresIn === "string" ? Number(record.expiresIn) : NaN;
  return typeof record.idToken === "string" && TOKEN_RE.test(record.idToken)
    && typeof record.refreshToken === "string" && TOKEN_RE.test(record.refreshToken)
    && Number.isInteger(expires) && expires >= 60 && expires <= 3600
    ? { idToken: record.idToken, refreshToken: record.refreshToken, expiresInSeconds: expires }
    : null;
}

function parseFirebaseRefreshTokens(value: unknown): FirebaseTokens | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const expires = typeof record.expires_in === "string" ? Number(record.expires_in) : NaN;
  return typeof record.id_token === "string" && TOKEN_RE.test(record.id_token)
    && typeof record.refresh_token === "string" && TOKEN_RE.test(record.refresh_token)
    && Number.isInteger(expires) && expires >= 60 && expires <= 3600
    ? { idToken: record.id_token, refreshToken: record.refresh_token, expiresInSeconds: expires }
    : null;
}

function validApiKey(value: string | undefined): value is string {
  return typeof value === "string" && API_KEY_RE.test(value);
}

function logFailure(step: string): void {
  console.error("editor-web: NIHO Experience authentication failed", { step });
}

export function createNihoExperienceAuthProvider(deps: NihoExperienceAuthDeps = {}): AuthProvider {
  const readEnv = deps.env ?? (() => process.env as Env);
  const fetchFn = deps.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const now = deps.now ?? (() => Date.now());
  const randomValue = deps.randomValue ?? (() => randomBytes(32).toString("base64url"));

  function origin(): string | null {
    const value = readEnv().EDITOR_NIHO_ORIGIN;
    return isTrustedNihoOrigin(value) ? value! : null;
  }

  function editorOrigin(): string | null {
    const value = readEnv().EDITOR_ORIGIN;
    return isTrustedNihoOrigin(value) ? value! : null;
  }

  function firebaseKey(): string | null {
    const value = readEnv().EDITOR_NIHO_FIREBASE_API_KEY;
    return validApiKey(value) ? value : null;
  }

  async function callNiho(path: string, input: { method?: "GET" | "POST"; body?: unknown; bearer?: string } = {}): Promise<unknown> {
    const nihoOrigin = origin();
    if (!nihoOrigin) throw new AuthTemporarilyUnavailable("niho_config_invalid");
    const headers = new Headers({ accept: "application/json" });
    if (input.body !== undefined) headers.set("content-type", "application/json");
    if (input.bearer) headers.set("authorization", `Bearer ${input.bearer}`);
    let response: Response;
    try {
      response = await fetchFn(`${nihoOrigin}${path}`, {
        method: input.method ?? "POST",
        headers,
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
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
    try { return await readJson(response); } catch { throw new AuthTemporarilyUnavailable("niho_response_invalid"); }
  }

  async function callFirebase(path: string, body: unknown, form = false): Promise<unknown> {
    const key = firebaseKey();
    if (!key) throw new AuthTemporarilyUnavailable("firebase_config_invalid");
    let response: Response;
    try {
      const endpoint = path === "securetoken.googleapis.com/v1/token"
        ? `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(key)}`
        : `https://identitytoolkit.googleapis.com/v1/${path}?key=${encodeURIComponent(key)}`;
      response = await fetchFn(endpoint, {
        method: "POST",
        headers: { accept: "application/json", "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
        body: form ? String(body) : JSON.stringify(body),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new AuthTemporarilyUnavailable("firebase_request_failed");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 500 || response.status === 429) throw new AuthTemporarilyUnavailable("firebase_temporarily_unavailable");
      throw new UpstreamResponseError(response.status);
    }
    try { return await readJson(response); } catch { throw new AuthTemporarilyUnavailable("firebase_response_invalid"); }
  }

  async function signInWithCustomToken(customToken: string): Promise<FirebaseTokens> {
    const raw = await callFirebase("accounts:signInWithCustomToken", { token: customToken, returnSecureToken: true });
    const tokens = parseFirebaseTokens(raw);
    if (!tokens) throw new AuthTemporarilyUnavailable("firebase_response_invalid");
    return tokens;
  }

  async function refreshFirebaseToken(refreshToken: string): Promise<FirebaseTokens> {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
    const raw = await callFirebase("securetoken.googleapis.com/v1/token", body.toString(), true);
    const tokens = parseFirebaseRefreshTokens(raw);
    if (!tokens) throw new AuthTemporarilyUnavailable("firebase_response_invalid");
    return tokens;
  }

  async function readSession(idToken: string): Promise<SessionPayload | null> {
    let raw: unknown;
    try {
      raw = await callNiho(SESSION_PATH, { method: "GET", bearer: idToken });
    } catch (error) {
      if (error instanceof UpstreamResponseError && [400, 401, 403].includes(error.status)) return null;
      throw error;
    }
    const payload = parseSessionPayload(raw, now());
    if (!payload) throw new AuthTemporarilyUnavailable("niho_response_invalid");
    return payload;
  }

  async function exchangeCustomCode(code: string, verifier: string): Promise<{ payload: ConnectionPayload; firebase: FirebaseTokens; session: SessionPayload }> {
    const raw = await callNiho(EXCHANGE_PATH, { body: { clientId: CLIENT_ID, code, codeVerifier: verifier } });
    const payload = parseConnectionPayload(raw, now());
    if (!payload) throw new AuthTemporarilyUnavailable("niho_response_invalid");
    const firebase = await signInWithCustomToken(payload.customToken);
    const session = await readSession(firebase.idToken);
    if (!session || session.actorId !== payload.userId || session.connectionId !== payload.connectionId
      || session.expiresAt !== payload.connectionExpiresAt) throw new AuthTemporarilyUnavailable("niho_session_invalid");
    return { payload, firebase, session };
  }

  async function refreshConnection(refreshToken: string): Promise<{ payload: ReturnType<typeof parseRefreshPayload> & {}; firebase: FirebaseTokens; session: SessionPayload }> {
    const raw = await callNiho(REFRESH_PATH, { body: { clientId: CLIENT_ID, refreshToken } });
    const payload = parseRefreshPayload(raw, now());
    if (!payload) throw new AuthTemporarilyUnavailable("niho_response_invalid");
    const firebase = await signInWithCustomToken(payload.customToken);
    const session = await readSession(firebase.idToken);
    if (!session || session.expiresAt !== payload.connectionExpiresAt) throw new AuthTemporarilyUnavailable("niho_session_invalid");
    return { payload, firebase, session };
  }

  function sessionFromPayload(payload: SessionPayload): Session {
    return {
      userId: payload.actorId,
      mode: "niho",
      sessionId: payload.connectionId,
      expiresAt: payload.expiresAt,
    };
  }

  async function currentRestrictedApiToken(session: Session, request: SessionRequest): Promise<string | null> {
    if (session.mode !== "niho" || !session.sessionId) return null;
    const header = request.headers.get("cookie");
    if (hasDuplicateCookie(header, EXPERIENCE_EDITOR_ID_TOKEN_COOKIE)) return null;
    const idToken = cookieValue(header, EXPERIENCE_EDITOR_ID_TOKEN_COOKIE);
    if (!idToken || !TOKEN_RE.test(idToken)) return null;
    const current = await readSession(idToken);
    if (!current || current.actorId !== session.userId || current.connectionId !== session.sessionId || current.expiresAt !== session.expiresAt) return null;
    return idToken;
  }

  return {
    mode: "niho",

    async getSession(request: SessionRequest): Promise<Session | null> {
      const header = request.headers.get("cookie");
      if (hasDuplicateCookie(header, EXPERIENCE_EDITOR_ID_TOKEN_COOKIE)) return null;
      const idToken = cookieValue(header, EXPERIENCE_EDITOR_ID_TOKEN_COOKIE);
      if (!idToken || !TOKEN_RE.test(idToken)) return null;
      const payload = await readSession(idToken);
      if (!payload) return null;
      return sessionFromPayload(payload);
    },

    async beginLogin({ request, returnTo }): Promise<Response> {
      const nihoOrigin = origin();
      const callbackOrigin = editorOrigin();
      if (!nihoOrigin || !callbackOrigin || nihoOrigin === callbackOrigin || !firebaseKey()) return unavailableResponse(returnTo);
      const cookieHeader = request.headers.get("cookie");
      if (hasDuplicateCookie(cookieHeader, EXPERIENCE_EDITOR_PENDING_COOKIE)) return unavailableResponse(returnTo);
      const state = randomValue();
      const verifier = randomValue();
      if (!STATE_RE.test(state) || !VERIFIER_RE.test(verifier)) return unavailableResponse(returnTo);
      const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
      const pending = encodePending({ state, verifier, returnTo: safeReturnTo(returnTo), expiresAt: now() + LOGIN_TTL_SECONDS * 1000 });
      const response = autoFormResponse({
        target: `${nihoOrigin}${CONNECT_START_PATH}`,
        formAction: nihoOrigin,
        fields: {
          v: "1",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
        },
        title: "NIHOアカウントへ接続",
        message: "NIHOの接続画面へ移動しています。",
        submitLabel: "続ける",
      });
      response.headers.append("Set-Cookie", setCookie(
        EXPERIENCE_EDITOR_PENDING_COOKIE,
        pending,
        LOGIN_TTL_SECONDS + COOKIE_TTL_MARGIN_SECONDS,
      ));
      return response;
    },

    async completeLogin(request: Request): Promise<Response> {
      const nihoOrigin = origin();
      const callbackOrigin = editorOrigin();
      if (!nihoOrigin || !callbackOrigin || nihoOrigin === callbackOrigin) return badCallback(400, "callback_config");
      if (request.method !== "POST") return badCallback(400, "callback_method");
      const callbackUrl = new URL(request.url);
      if (callbackUrl.pathname !== CALLBACK_PATH || callbackUrl.search !== "" || callbackUrl.hash !== "") return badCallback(400, "callback_path");
      const host = request.headers.get("host");
      if (host === null ? callbackUrl.origin !== callbackOrigin : host.toLowerCase() !== new URL(callbackOrigin).host) {
        return badCallback(400, "callback_host");
      }
      const requestOrigin = request.headers.get("origin");
      if (requestOrigin !== nihoOrigin && requestOrigin !== callbackOrigin) {
        return badCallback(400, `callback_origin_${callbackOriginClass(requestOrigin, nihoOrigin, callbackOrigin)}`);
      }
      const fields = await readCallbackFields(request);
      if (fields instanceof Response) return fields;
      if (requestOrigin === nihoOrigin) {
        return autoFormResponse({
          target: `${callbackOrigin}${CALLBACK_PATH}`,
          formAction: "'self'",
          fields,
          title: "NIHO editor に戻る",
          message: "NIHO editor に戻っています。",
          submitLabel: "戻る",
        });
      }
      const cookieHeader = request.headers.get("cookie");
      if (hasDuplicateCookie(cookieHeader, EXPERIENCE_EDITOR_PENDING_COOKIE)) return unavailableResponse("/");
      const pending = readPending(cookieValue(cookieHeader, EXPERIENCE_EDITOR_PENDING_COOKIE), now());
      if (!pending || !sameValue(fields.state, pending.state)) {
        logFailure("callback_validation");
        return unavailableResponse(pending?.returnTo ?? "/");
      }
      const oldRefreshToken = cookieValue(cookieHeader, EXPERIENCE_EDITOR_REFRESH_COOKIE);
      try {
        const result = await exchangeCustomCode(fields.code, pending.verifier);
        if (oldRefreshToken && TOKEN_RE.test(oldRefreshToken)) {
          await callNiho(REVOKE_PATH, { body: { clientId: CLIENT_ID, refreshToken: oldRefreshToken } }).catch(() => logFailure("revoke_previous"));
        }
        const maxConnectionAge = Math.floor((Date.parse(result.session.expiresAt) - now()) / 1000);
        const headers = [
          clearCookie(EXPERIENCE_EDITOR_PENDING_COOKIE),
          setCookie(EXPERIENCE_EDITOR_ID_TOKEN_COOKIE, result.firebase.idToken, result.firebase.expiresInSeconds),
          setCookie(EXPERIENCE_EDITOR_FIREBASE_REFRESH_COOKIE, result.firebase.refreshToken, maxConnectionAge),
          setCookie(EXPERIENCE_EDITOR_REFRESH_COOKIE, result.payload.refreshToken, maxConnectionAge),
          setCookie(EXPERIENCE_EDITOR_EXPIRY_COOKIE, String(Date.parse(result.session.expiresAt)), maxConnectionAge),
        ];
        return redirectTo(safeReturnTo(pending.returnTo), headers);
      } catch {
        logFailure("exchange");
        return unavailableResponse(pending.returnTo);
      }
    },

    async refresh(request: Request): Promise<Response> {
      const header = request.headers.get("cookie");
      if (ALL_COOKIES.some((name) => hasDuplicateCookie(header, name))) return unauthorizedResponse();
      const firebaseRefresh = cookieValue(header, EXPERIENCE_EDITOR_FIREBASE_REFRESH_COOKIE);
      const nihoRefresh = cookieValue(header, EXPERIENCE_EDITOR_REFRESH_COOKIE);
      const expiry = Number(cookieValue(header, EXPERIENCE_EDITOR_EXPIRY_COOKIE));
      if (!firebaseRefresh || !TOKEN_RE.test(firebaseRefresh) || !nihoRefresh || !TOKEN_RE.test(nihoRefresh)) return unauthorizedResponse();

      try {
        let tokens: FirebaseTokens;
        let session: SessionPayload | null = null;
        let rotatedConnection: { refreshToken: string; connectionExpiresAt: string } | null = null;
        if (Number.isFinite(expiry) && expiry > now() && expiry - now() <= CONNECTION_REFRESH_WINDOW_MS) {
          const refreshed = await refreshConnection(nihoRefresh);
          tokens = refreshed.firebase;
          session = refreshed.session;
          rotatedConnection = {
            refreshToken: refreshed.payload.refreshToken,
            connectionExpiresAt: refreshed.payload.connectionExpiresAt,
          };
        } else {
          try {
            tokens = await refreshFirebaseToken(firebaseRefresh);
          } catch (error) {
            if (!(error instanceof UpstreamResponseError) || ![400, 401, 403].includes(error.status)) throw error;
            const refreshed = await refreshConnection(nihoRefresh);
            tokens = refreshed.firebase;
            session = refreshed.session;
            rotatedConnection = {
              refreshToken: refreshed.payload.refreshToken,
              connectionExpiresAt: refreshed.payload.connectionExpiresAt,
            };
          }
          session ??= await readSession(tokens.idToken);
        }
        if (!session) return unauthorizedResponse();
        const maxConnectionAge = Math.floor((Date.parse(session.expiresAt) - now()) / 1000);
        const headers = new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
        headers.append("Set-Cookie", setCookie(EXPERIENCE_EDITOR_ID_TOKEN_COOKIE, tokens.idToken, tokens.expiresInSeconds));
        headers.append("Set-Cookie", setCookie(EXPERIENCE_EDITOR_FIREBASE_REFRESH_COOKIE, tokens.refreshToken, maxConnectionAge));
        if (rotatedConnection) {
          headers.append("Set-Cookie", setCookie(EXPERIENCE_EDITOR_REFRESH_COOKIE, rotatedConnection.refreshToken, maxConnectionAge));
          headers.append("Set-Cookie", setCookie(EXPERIENCE_EDITOR_EXPIRY_COOKIE, String(Date.parse(rotatedConnection.connectionExpiresAt)), maxConnectionAge));
        }
        return Response.json({ sessionId: session.connectionId, userId: session.actorId, expiresAt: session.expiresAt }, { headers });
      } catch (error) {
        if (error instanceof UpstreamResponseError && [400, 401, 403].includes(error.status)) return unauthorizedResponse();
        logFailure("refresh");
        return temporaryUnavailable();
      }
    },

    async logout(request: Request): Promise<Response> {
      const header = request.headers.get("cookie");
      const token = cookieValue(header, EXPERIENCE_EDITOR_REFRESH_COOKIE);
      if (token && TOKEN_RE.test(token) && !hasDuplicateCookie(header, EXPERIENCE_EDITOR_REFRESH_COOKIE)) {
        await callNiho(REVOKE_PATH, { body: { clientId: CLIENT_ID, refreshToken: token } }).catch(() => logFailure("revoke"));
      }
      return redirectTo("/auth/login", clearAllCookies());
    },

    async apiToken(): Promise<string | null> {
      return null;
    },

    async articleApiToken(session: Session, request: SessionRequest, purpose: "roles" | "article-links"): Promise<string | null> {
      if (purpose !== "roles" && purpose !== "article-links") return null;
      return currentRestrictedApiToken(session, request);
    },

    async docsApiToken(session: Session, request: SessionRequest): Promise<string | null> {
      return currentRestrictedApiToken(session, request);
    },
  };
}

export const nihoExperienceAuthProvider: AuthProvider = createNihoExperienceAuthProvider();
