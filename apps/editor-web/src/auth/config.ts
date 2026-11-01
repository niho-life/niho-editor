/**
 * 認証の方式（#47）。`EDITOR_AUTH_MODE=stub|niho|google`。
 *
 * - stub: 固定の合成ユーザー 1 人。開発と CI だけ。
 * - niho: NIHO editor専用のopaque browser session（src/auth/niho.ts）。
 * - google: Google のサインイン ＋ 許可リスト（src/auth/google.ts）。niho の実環境接続を受入するまでの一時的な方式で、
 *   `EDITOR_GOOGLE_ALLOWED_EMAILS` に挙げたアドレスだけが入れる（docs/ops/editor-deploy.md §13）。
 *
 * 本番の守り：NODE_ENV=production で niho・google 以外（未設定を含む）は stub へ落とさずに throw する。
 * google は許可リストが空なら本番で throw する（設定の誤りで誰でも入れる状態にしない）。
 * この関数は import しただけでは何もしない。呼ぶのは次の 3 か所で、`next build`（これも NODE_ENV=production）の途中では呼ばない:
 * - scripts/server-entry.mjs: server を読み込む前（port を開く前）。Node がこのファイルを直接読むので、
 *   このファイルは依存を持たず、型を消すだけで動く TypeScript（erasable syntax）だけで書く。
 * - src/instrumentation.ts: `next start`・`next dev` の起動時。
 * - src/auth/index.ts: 要求ごとの方式の選択。
 */

export const AUTH_MODES = ["stub", "niho", "google"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/** google の許可リスト（コンマ区切りのアドレス）。値はコードに書かず、配備の設定から渡す。 */
export const GOOGLE_ALLOWED_EMAILS_ENV = "EDITOR_GOOGLE_ALLOWED_EMAILS";

export type AuthEnv = {
  readonly NODE_ENV?: string | undefined;
  readonly EDITOR_AUTH_MODE?: string | undefined;
  readonly EDITOR_GOOGLE_ALLOWED_EMAILS?: string | undefined;
  readonly EDITOR_NIHO_ORIGIN?: string | undefined;
};

export class AuthConfigError extends Error {
  override readonly name = "AuthConfigError";
}

/** NIHO接続先はpath/query/fragment/credentialsを持たないexact HTTPS originだけ。 */
export function isTrustedNihoOrigin(value: string | undefined): boolean {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:"
    && parsed.username === ""
    && parsed.password === ""
    && parsed.pathname === "/"
    && parsed.search === ""
    && parsed.hash === ""
    && parsed.origin === value;
}

function isAuthMode(value: string): value is AuthMode {
  return (AUTH_MODES as readonly string[]).includes(value);
}

/** アドレス 1 つの上限（local 64 ＋ `@` ＋ domain 255）。 */
const MAX_EMAIL_LENGTH = 320;

/**
 * 許可リストを読む。コンマ区切りで、前後の空白を落として小文字にし、同じものは 1 つにする。
 * 空の要素・`@` が無い／端にある値・中に空白がある値は貼り間違いなので捨てる（部分一致・ドメイン一致はしない）。
 */
export function parseAllowedEmails(raw: string | undefined): readonly string[] {
  const emails = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const email = part.trim().toLowerCase();
    if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) continue;
    if (/\s/.test(email)) continue;
    const at = email.indexOf("@");
    if (at <= 0 || at !== email.lastIndexOf("@") || at === email.length - 1) continue;
    emails.add(email);
  }
  return Object.freeze([...emails]);
}

/** このアドレスが許可リストにあるか（小文字に正規化して完全一致。部分一致・ドメイン一致では通らない）。 */
export function isAllowedEmail(email: string | undefined, allowed: readonly string[]): boolean {
  const normalized = (email ?? "").trim().toLowerCase();
  if (normalized.length === 0) return false;
  return allowed.includes(normalized);
}

export function resolveAuthMode(env: AuthEnv): AuthMode {
  const raw = env.EDITOR_AUTH_MODE?.trim() ?? "";
  if (raw !== "" && !isAuthMode(raw)) {
    throw new AuthConfigError("EDITOR_AUTH_MODE must be one of: stub, niho, google");
  }
  if (env.NODE_ENV === "production" && raw !== "niho" && raw !== "google") {
    throw new AuthConfigError("EDITOR_AUTH_MODE=niho or EDITOR_AUTH_MODE=google is required when NODE_ENV=production (stub is for development and CI only)");
  }
  // 許可リストが空なら誰も入れないが、その設定の誤りを本番で動かさない（port を開く前に落とす）
  if (raw === "google" && env.NODE_ENV === "production" && parseAllowedEmails(env.EDITOR_GOOGLE_ALLOWED_EMAILS).length === 0) {
    throw new AuthConfigError(`${GOOGLE_ALLOWED_EMAILS_ENV} must list at least one address when EDITOR_AUTH_MODE=google and NODE_ENV=production`);
  }
  if (raw === "niho" && !isTrustedNihoOrigin(env.EDITOR_NIHO_ORIGIN)) {
    throw new AuthConfigError("EDITOR_NIHO_ORIGIN must be an exact HTTPS origin when EDITOR_AUTH_MODE=niho");
  }
  return raw === "" ? "stub" : raw;
}
