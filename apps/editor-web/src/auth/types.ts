import type { AuthMode } from "./config";

/** 認証済みの本人。userId は NIHO の安定したユーザー ID（stub では合成の値）。token・cookie の値は持たない。 */
export type Session = {
  readonly userId: string;
  readonly mode: AuthMode;
  /** NIHO管理sessionの識別子。Google/stubでは省略する。 */
  readonly sessionId?: string;
  /** NIHO管理sessionの期限。tokenやcookie値ではない安全なmetadata。 */
  readonly expiresAt?: string;
  readonly refreshRequired?: boolean;
  /** 一覧の下の本人の行に出す名前（NIHO から読む。stub では合成の値）。 */
  readonly profile?: { readonly name: string; readonly email?: string };
};

/** getSession が読むのは要求の header だけ（route handler の Request と、server component の headers() の両方を渡せる）。 */
export type SessionRequest = { readonly headers: Pick<Headers, "get"> };

export interface AuthProvider {
  readonly mode: AuthMode;
  getSession(request: SessionRequest): Promise<Session | null>;
  /** `/auth/login/start`。returnTo は safeReturnTo を通した editor の中の path。 */
  beginLogin(input: { request: Request; returnTo: string }): Promise<Response>;
  /** `/auth/callback`。 */
  completeLogin(request: Request): Promise<Response>;
  /** `/auth/logout`（POST・同じ origin だけ）。 */
  logout(request: Request): Promise<Response>;
  /** `/auth/refresh`。cookieを書き替えられるRoute Handlerからだけ呼ぶ。未対応providerは省略する。 */
  refresh?(request: Request): Promise<Response>;
  /**
   * NIHO の API（`me/docs-drive/*` など）を**本人として**呼ぶための ID token。サーバーの中だけで使い、
   * ブラウザの JavaScript・storage には渡さない。NIHO editor認証は写真本人確認専用なのでnullのまま
   * （Google ドキュメントの書き出しは 503 `google_docs_unavailable` のまま）。
   */
  apiToken?(session: Session): Promise<string | null>;
}

/** 上流NIHOが一時的に確認不能。未認証(null)へ降格させず、API routeは503として再試行可能にし、SSRではエラー境界へ伝える。 */
export class AuthTemporarilyUnavailable extends Error {
  override readonly name = "AuthTemporarilyUnavailable";
  constructor(readonly reason: string) {
    super("authentication is temporarily unavailable");
  }
}
