import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { isAllowedEmail, parseAllowedEmails } from "./config";
import { loginPath, safeReturnTo } from "./return-to";
import type { AuthProvider, Session, SessionRequest } from "./types";
import { verifyGoogleIdToken } from "../server/google-oidc";
import { expectedOrigin } from "../server/http";

/**
 * Google のサインインでの認証（`EDITOR_AUTH_MODE=google`）。NIHO editor専用接続を有効化・受入するまでの**一時的な方式**で、
 * 出たら `niho` に戻してこのファイルを使わなくする（docs/ops/editor-deploy.md §13）。形は src/auth/niho.ts の設計に合わせる:
 *
 * - beginLogin: PKCE の state と verifier を、戻り先（returnTo）と一緒に短い期限の HttpOnly cookie に入れてから Google へ 303。
 *   scope は `openid email` だけ（Drive などは足さない）。
 * - completeLogin: state を照合し、code を token に交換し、ID トークンを Google の JWKS で検証（署名・`iss`・`aud`・`exp`・
 *   `email_verified`）してから、許可リストのアドレスだけを通す。戻り先は cookie の値を safeReturnTo でもう一度確かめる。
 * - セッションはサーバーが署名した HttpOnly cookie（`HttpOnly; Secure; SameSite=Lax; Path=/`）。Google の cookie は共有しない。
 * - token（code・access token・ID トークン）はサーバーの中だけで使い、cookie にもブラウザの JavaScript・storage にも渡さない。
 *   残すのは Google の `sub`（安定した id）とアドレスだけ。
 * - 失敗の理由・アドレス・token・鍵はログにもエラーの本文にも出さない（画面は「入れません」だけ）。
 * - logout: セッションの cookie を消して `/auth/login` へ 303。
 */

/** Google の口（ホストはコードで固定する）。 */
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Drive などは足さない。本人が分かれば十分（#47）。 */
const SCOPE = "openid email";

/** ログインの途中の cookie（state・PKCE の verifier・戻り先）。 */
export const LOGIN_COOKIE = "editor_google_login";
/** セッションの cookie。 */
export const SESSION_COOKIE = "editor_session";
const COOKIE_FLAGS = "HttpOnly; Secure; SameSite=Lax; Path=/";

/** ログインの途中の cookie の寿命（秒）。Google の画面での操作に足りる長さだけ。 */
export const LOGIN_TTL_SECONDS = 600;
/** セッションの寿命（秒）。 */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

const TOKEN_TIMEOUT_MS = 10_000;
/** cookie の値の上限（署名付きでも 1 KiB で足りる。これより長い値は読まない）。 */
const MAX_COOKIE_VALUE = 4096;
/** ID トークンの上限（google-oidc も同じ上限で断る）。 */
const MAX_ID_TOKEN = 4096;

export const CLIENT_ID_ENV = "EDITOR_GOOGLE_CLIENT_ID";
export const CLIENT_SECRET_ENV = "GOOGLE_OAUTH_CLIENT_SECRET";

type Env = Readonly<Record<string, string | undefined>>;

export type GoogleAuthDeps = {
  /** 設定（既定は process.env。要求のたびに読む）。 */
  env?: () => Env;
  /** Google の token の口と JWKS の取得（テストでは偽物に差し替える）。 */
  fetch?: typeof fetch;
  now?: () => number;
  /** state と PKCE の verifier（既定は 32 バイトの乱数）。 */
  randomValue?: () => string;
};

type GoogleConfig = {
  readonly clientId: string;
  readonly allowedEmails: readonly string[];
  /** cookie の署名の鍵（client secret から導く。secret そのものは cookie に入らない）。 */
  readonly loginKey: Buffer;
  readonly sessionKey: Buffer;
  readonly clientSecret: string;
};

type LoginState = { readonly state: string; readonly verifier: string; readonly returnTo: string };

/** 設定が足りなければ null（ログインは `unavailable`、セッションは無し。誰も入れない）。 */
function readConfig(env: Env): GoogleConfig | null {
  const clientId = env[CLIENT_ID_ENV]?.trim() ?? "";
  const clientSecret = env[CLIENT_SECRET_ENV]?.trim() ?? "";
  const allowedEmails = parseAllowedEmails(env.EDITOR_GOOGLE_ALLOWED_EMAILS);
  if (clientId === "" || clientSecret === "" || allowedEmails.length === 0) return null;
  return {
    clientId,
    clientSecret,
    allowedEmails,
    loginKey: deriveKey(clientSecret, "niho-editor google login v1"),
    sessionKey: deriveKey(clientSecret, "niho-editor google session v1"),
  };
}

/** cookie の署名の鍵を client secret から導く（用途ごとに別の鍵。鍵そのものは外に出ない）。 */
function deriveKey(clientSecret: string, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", clientSecret, "niho-editor-auth", info, 32));
}

function sign(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("base64url");
}

/** `<payload>.<署名>`。payload は JSON（Base64URL）で、期限を中に持つ。 */
function seal(key: Buffer, payload: Record<string, unknown>, expiresAtMs: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, e: expiresAtMs })).toString("base64url");
  return `${body}.${sign(key, body)}`;
}

/** 署名と期限を確かめて中身を返す（合わなければ null。理由は返さない）。 */
function unseal(key: Buffer, raw: string | undefined, nowMs: number): Record<string, unknown> | null {
  if (!raw || raw.length === 0 || raw.length > MAX_COOKIE_VALUE) return null;
  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts as [string, string];
  const expected = Buffer.from(sign(key, body), "utf8");
  const given = Buffer.from(mac, "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const expiresAt = (value as { e?: unknown }).e;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || nowMs >= expiresAt) return null;
  return value as Record<string, unknown>;
}

function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; ${COOKIE_FLAGS}`;
}

function clearCookie(name: string): string {
  return `${name}=; Max-Age=0; ${COOKIE_FLAGS}`;
}

/** 要求の cookie の header から 1 つの値を読む（名前が同じものが複数あれば最初の 1 つ）。 */
function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return part.slice(index + 1).trim();
  }
  return undefined;
}

/** 303（Location と Set-Cookie。cache させない）。 */
function redirectTo(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

/** 失敗は種類だけを書く（token・アドレス・state・鍵は出さない）。 */
function logFailure(step: string): void {
  console.error("editor-web: google login failed", { step });
}

/** `/auth/callback` の URL（Google のコンソールに登録したものと同じ文字列になるように `EDITOR_ORIGIN` から作る）。 */
function callbackUrl(request: Request, env: Env): string | null {
  const origin = expectedOrigin(request, env);
  return origin ? `${origin}/auth/callback` : null;
}

function readLoginState(value: Record<string, unknown> | null): LoginState | null {
  if (!value) return null;
  const { s, v, r } = value;
  if (typeof s !== "string" || s.length === 0 || typeof v !== "string" || v.length === 0) return null;
  return { state: s, verifier: v, returnTo: safeReturnTo(typeof r === "string" ? r : null) };
}

function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** code を ID トークンに替える（access token は使わないので捨てる）。失敗は null。 */
async function exchangeCode(
  input: { code: string; verifier: string; redirectUri: string; config: GoogleConfig },
  fetchFn: typeof fetch,
): Promise<string | null> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
  });
  let response: Response;
  try {
    response = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    logFailure("token_request");
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    logFailure("token_status");
    return null;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    logFailure("token_body");
    return null;
  }
  const idToken = typeof payload === "object" && payload !== null ? (payload as { id_token?: unknown }).id_token : undefined;
  if (typeof idToken !== "string" || idToken.length === 0 || idToken.length > MAX_ID_TOKEN) {
    logFailure("token_body");
    return null;
  }
  return idToken;
}

export function createGoogleAuthProvider(deps: GoogleAuthDeps = {}): AuthProvider {
  const readEnv = deps.env ?? (() => process.env as Env);
  const now = deps.now ?? (() => Date.now());
  const randomValue = deps.randomValue ?? (() => randomBytes(32).toString("base64url"));
  const fetchFn = deps.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));

  return {
    mode: "google",

    async getSession(request: SessionRequest): Promise<Session | null> {
      const config = readConfig(readEnv());
      if (!config) return null;
      const payload = unseal(config.sessionKey, cookieValue(request.headers.get("cookie"), SESSION_COOKIE), now());
      if (!payload) return null;
      const { u, m } = payload;
      if (typeof u !== "string" || u.length === 0 || typeof m !== "string") return null;
      // 許可リストから外したアドレスは、cookie が残っていても次の要求で入れない
      if (!isAllowedEmail(m, config.allowedEmails)) return null;
      return { userId: u, mode: "google", profile: { name: m, email: m } };
    },

    async beginLogin({ request, returnTo }): Promise<Response> {
      const env = readEnv();
      const config = readConfig(env);
      const redirectUri = callbackUrl(request, env);
      if (!config || !redirectUri) {
        logFailure("config");
        return redirectTo(loginPath(returnTo, "unavailable"));
      }
      const state = randomValue();
      const verifier = randomValue();
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", SCOPE);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      // 許可リストに複数のアドレスがあるので、どのアカウントで入るかは毎回選ばせる（黙って別の人で入らない）
      url.searchParams.set("prompt", "select_account");
      const cookie = seal(config.loginKey, { s: state, v: verifier, r: safeReturnTo(returnTo) }, now() + LOGIN_TTL_SECONDS * 1000);
      return redirectTo(url.toString(), [setCookie(LOGIN_COOKIE, cookie, LOGIN_TTL_SECONDS)]);
    },

    async completeLogin(request: Request): Promise<Response> {
      const env = readEnv();
      const config = readConfig(env);
      const forget = clearCookie(LOGIN_COOKIE);
      if (!config) {
        logFailure("config");
        return redirectTo(loginPath("/", "unavailable"), [forget]);
      }
      const login = readLoginState(unseal(config.loginKey, cookieValue(request.headers.get("cookie"), LOGIN_COOKIE), now()));
      // 戻り先は cookie の値だけ（callback の query からは取らない）
      const returnTo = login?.returnTo ?? "/";
      const refuse = (step: string, error: "unavailable" | "forbidden" = "unavailable") => {
        logFailure(step);
        return redirectTo(loginPath(returnTo, error), [forget]);
      };
      if (!login) return refuse("login_cookie");
      const redirectUri = callbackUrl(request, env);
      if (!redirectUri) return refuse("config");
      const params = new URL(request.url).searchParams;
      if (params.get("error")) return refuse("provider_error");
      const state = params.get("state");
      const code = params.get("code");
      if (!state || !code || !sameValue(state, login.state)) return refuse("state");
      const idToken = await exchangeCode({ code, verifier: login.verifier, redirectUri, config }, fetchFn);
      if (!idToken) return refuse("token");
      const verified = await verifyGoogleIdToken(idToken, { audience: config.clientId, fetch: fetchFn, now });
      if (!verified.ok) return refuse(`id_token:${verified.code}`);
      if (!isAllowedEmail(verified.claims.email, config.allowedEmails)) return refuse("not_allowed", "forbidden");
      // 残すのは `sub`（安定した id）と小文字にしたアドレスだけ。token は捨てる
      const email = verified.claims.email.trim().toLowerCase();
      const session = seal(config.sessionKey, { u: verified.claims.subject, m: email }, now() + SESSION_TTL_SECONDS * 1000);
      return redirectTo(returnTo, [forget, setCookie(SESSION_COOKIE, session, SESSION_TTL_SECONDS)]);
    },

    async logout(): Promise<Response> {
      return redirectTo("/auth/login", [clearCookie(SESSION_COOKIE), clearCookie(LOGIN_COOKIE)]);
    },
  };
}

/** 要求のたびに `process.env` を読む方式（src/auth/index.ts が選ぶ）。 */
export const googleAuthProvider: AuthProvider = createGoogleAuthProvider();
