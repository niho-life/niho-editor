/**
 * ログインの前後の戻り先。戻れるのは editor の画面の path だけ（外の URL・`/auth/*`・`/api/*` へは戻さない。open redirect を防ぐ）。
 * 読めない値・許していない path はどれも `/` にする。
 */

const MAX_RETURN_TO = 2048;
const BASE = "https://editor.invalid";
const RECORDING_START = "/p/new?from=recording";
const PHOTO_ROOT = "/photo";
const PHOTO_PATHS = [
  /^\/photo$/,
  /^\/photo\/trash$/,
  /^\/photo\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
];

const ALLOWED_PATHS = [
  /^\/$/,
  /^\/p\/new$/,
  /^\/p\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^\/destinations$/,
  /^\/destinations\/[a-z0-9-]{1,64}$/,
  /^\/account$/,
  /^\/settings$/,
  /^\/google-docs\/connect$/,
  ...PHOTO_PATHS,
];

/** 戻り先を editor の中の path にする。query と hash は落とす（`/p/new?from=recording` だけはそのまま）。 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RETURN_TO) return "/";
  // `//host`・`/\host` は別の origin になり得る。URL の解析は tab・改行を黙って消すので、制御文字は解析の前に断る
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  if (/\p{Cc}/u.test(raw)) return "/";
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return "/";
  }
  if (url.origin !== BASE) return "/";
  if (!ALLOWED_PATHS.some((pattern) => pattern.test(url.pathname))) return "/";
  if (url.pathname === "/p/new" && url.search === "?from=recording") return RECORDING_START;
  return url.pathname;
}

/** 写真ログインの戻り先。Docs の path や `/photo/auth/*` は受け付けない。 */
export function safePhotoReturnTo(raw: string | null | undefined): string {
  const returnTo = safeReturnTo(raw);
  return PHOTO_PATHS.some((pattern) => pattern.test(returnTo)) ? returnTo : PHOTO_ROOT;
}

/**
 * ログインの画面に出す失敗の種類。
 * - unavailable: いまログインできない（方式が未設定・上流の失敗・途中の cookie が無い）。
 * - forbidden: 本人は分かったが、このサイトに入れないアカウント（`google` の許可リストの外。アドレスは出さない）。
 */
export type LoginError = "unavailable" | "forbidden";

const LOGIN_ERRORS: readonly string[] = ["unavailable", "forbidden"];

/** `/auth/login?error=` の値を読む（知らない値は null）。 */
export function loginErrorOf(raw: string | string[] | undefined): LoginError | null {
  return typeof raw === "string" && LOGIN_ERRORS.includes(raw) ? (raw as LoginError) : null;
}

/** ログインの画面の path。戻り先が `/` なら `next` を付けない。 */
export function loginPath(returnTo: string, error?: LoginError): string {
  const params = new URLSearchParams();
  const next = safeReturnTo(returnTo);
  if (next !== "/") params.set("next", next);
  if (error) params.set("error", error);
  const query = params.toString();
  return query ? `/auth/login?${query}` : "/auth/login";
}

/** 写真専用ログイン画面の path。既定の `/photo` では `next` を付けない。 */
export function photoLoginPath(returnTo: string, error?: LoginError): string {
  const params = new URLSearchParams();
  const next = safePhotoReturnTo(returnTo);
  if (next !== PHOTO_ROOT) params.set("next", next);
  if (error) params.set("error", error);
  const query = params.toString();
  return query ? `/photo/auth/login?${query}` : "/photo/auth/login";
}

/** 認証の route の応答（303。Location は同じ origin の path。cache させない）。 */
export function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
}
