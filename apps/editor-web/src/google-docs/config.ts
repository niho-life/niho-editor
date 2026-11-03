/**
 * Google ドキュメント書き出しの方式（`EDITOR_GOOGLE_DOCS_MODE=niho`）。
 *
 * editor は Google を直接呼ばない。NIHO の Editor 専用 `auth/experience-editor-connect/docs-drive/*` を本人として呼ぶ。
 * 設計は docs/architecture/editor-google-docs-export.md、配備は docs/ops/editor-google-docs.md。
 *
 * - `niho`: NIHO の API を使う。API の起点（`EDITOR_NIHO_API_ORIGIN`）と `returnTo`（`EDITOR_NIHO_RETURN_TO`）は既定を持つ。
 * - `off`・未設定・空: 使わない（API は 503 `google_docs_unavailable`）。**既定は閉じたまま。**
 * - それ以外の値: 誤り（起動を止める）。
 *
 * 本番の守りは AI（src/ai/config.ts）・文字起こし（src/transcription/config.ts）と同じ 2 か所:
 * 起動時の検査（src/startup-check.ts）と、要求ごとの解決（src/google-docs/runtime.ts。誤りなら null＝503）。
 * エラーのメッセージに値を入れない。
 */

export const GOOGLE_DOCS_MODES = ["niho", "off"] as const;
export type GoogleDocsMode = (typeof GOOGLE_DOCS_MODES)[number];

/** NIHO の API の起点。専用 path は runtime 側で固定して足す。 */
export const DEFAULT_NIHO_API_ORIGIN = "https://niho.life/api";
/** Google の同意のあとに固定 Editor connect 面へ戻す閉じた値。 */
export const DEFAULT_NIHO_RETURN_TO = "niho-editor";
/** 1 回の呼び出しの時間切れ（旧 Mac アプリと同じ 45 秒）。 */
export const NIHO_API_TIMEOUT_MS = 45_000;
/** 応答の本文の上限（旧 Mac アプリと同じ 1 MiB）。 */
export const NIHO_API_MAX_RESPONSE_BYTES = 1024 * 1024;

export type GoogleDocsEnv = {
  readonly NODE_ENV?: string | undefined;
  readonly EDITOR_GOOGLE_DOCS_MODE?: string | undefined;
  readonly EDITOR_NIHO_API_ORIGIN?: string | undefined;
  readonly EDITOR_NIHO_RETURN_TO?: string | undefined;
};

export type GoogleDocsConfig =
  | { mode: "off" }
  | { mode: "niho"; apiBase: string; returnTo: string; timeoutMs: number };

export class GoogleDocsConfigError extends Error {
  override readonly name = "GoogleDocsConfigError";
}

function isMode(value: string): value is GoogleDocsMode {
  return (GOOGLE_DOCS_MODES as readonly string[]).includes(value);
}

/** 開発と CI だけで許す起点（偽の API を手元で動かすため）。 */
function isLocalHttp(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

/**
 * API の起点。`https` だけ（開発と CI では localhost の `http` も許す）。資格情報・query・fragment は受け付けない。
 * 末尾の `/` は落として返す（path を区切りごとに足すため）。
 */
function apiBase(env: GoogleDocsEnv): string {
  const raw = env.EDITOR_NIHO_API_ORIGIN?.trim() ?? "";
  if (raw === "") return DEFAULT_NIHO_API_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GoogleDocsConfigError("EDITOR_NIHO_API_ORIGIN must be an absolute https URL");
  }
  const production = env.NODE_ENV === "production";
  if (url.protocol !== "https:" && !(!production && isLocalHttp(url))) {
    throw new GoogleDocsConfigError("EDITOR_NIHO_API_ORIGIN must use https");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new GoogleDocsConfigError("EDITOR_NIHO_API_ORIGIN must not carry credentials, a query or a fragment");
  }
  return url.href.replace(/\/+$/, "");
}

function returnTo(env: GoogleDocsEnv): string {
  const raw = env.EDITOR_NIHO_RETURN_TO?.trim() ?? "";
  if (raw === "" || raw === DEFAULT_NIHO_RETURN_TO) return DEFAULT_NIHO_RETURN_TO;
  throw new GoogleDocsConfigError("EDITOR_NIHO_RETURN_TO must be niho-editor");
}

/** 方式を決める。誤りは GoogleDocsConfigError（値を含めない）。 */
export function resolveGoogleDocsConfig(env: GoogleDocsEnv): GoogleDocsConfig {
  const raw = env.EDITOR_GOOGLE_DOCS_MODE?.trim() ?? "";
  if (raw !== "" && !isMode(raw)) throw new GoogleDocsConfigError("EDITOR_GOOGLE_DOCS_MODE must be one of: niho, off");
  // 起点と returnTo の誤りは、使わない設定（off）でも誤り（設定の間違いを黙って通さない）
  const base = apiBase(env);
  const target = returnTo(env);
  if (raw !== "niho") return { mode: "off" };
  return { mode: "niho", apiBase: base, returnTo: target, timeoutMs: NIHO_API_TIMEOUT_MS };
}
