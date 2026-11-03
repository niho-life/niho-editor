import "server-only";
import { NIHO_API_MAX_RESPONSE_BYTES, NIHO_API_TIMEOUT_MS } from "./config";
import {
  checkExportRequest,
  documentUrl,
  GoogleDocsError,
  isDocumentId,
  isExportId,
  type GoogleDocsConnection,
  type GoogleDocsCredential,
  type GoogleDocsExport,
  type GoogleDocsFailureCode,
  type GoogleDocsGateway,
} from "./gateway";

/**
 * NIHO の Editor 専用 API（`auth/experience-editor-connect/docs-drive/*`）を本人として呼ぶ実装。
 * Google接続・receipt・変換の共通serviceを使う専用caller契約と、失敗の対応づけを固定する。
 *
 * - 呼ぶのは設定で決めた起点（既定 `https://niho.life/api`）の下の決まった path だけ。転送（redirect）は追わない。
 * - 応答は 1 MiB まで・1 回 45 秒で切る。受け取った値は**形を確かめてから**使う（`authorizationUrl` の host と path、`documentId` の文字）。
 * - API が返した `url` は使わない。画面に出す URL は `documentId` から組み立てる。
 * - token・応答の本文・題名・本文は、結果・例外・ログに出さない（持つのは短い code だけ）。
 * - 自動の再試行はしない。書き出しの POST だけ、通信が切れたら `export_result_unknown`（二重に作らないため、
 *   呼び出し元は同じ `exportId` で状態を確かめてから再試行する）。
 */

type Json = Record<string, unknown>;
const EDITOR_DOCS_PREFIX = ["auth", "experience-editor-connect", "docs-drive"] as const;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** API の失敗の本文 `{ error: { details: { reason } } }` の `reason`。無ければ null。 */
function failureReason(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error) || !isRecord(body.error.details)) return null;
  const { reason } = body.error.details;
  return typeof reason === "string" ? reason : null;
}

/** HTTP ステータスと `reason` の組を editor の code にする（旧 Mac アプリの `api_error`）。 */
function apiFailure(status: number, reason: string | null): GoogleDocsFailureCode {
  // 停止スイッチ: 接続は失効していない一時停止（ログインのやり直しではなく、再開を待つ）
  if (status === 401 && reason === "app_connect_disabled") return "temporarily_unavailable";
  if (status === 401) return "signed_out";
  if (status === 403 && reason === "niho_docs_app_required") return "app_not_allowed";
  if (status === 404 && reason === "export_not_found") return "export_not_found";
  if (status === 409 && reason === "drive_not_connected") return "drive_not_connected";
  if (status === 409 && reason === "export_payload_conflict") return "export_payload_conflict";
  if (status === 409 && (reason === "google_account_changed" || reason === "drive_connection_changed")) return "drive_connection_changed";
  if (status === 422 && (reason === "credential_invalid" || reason === "auth_revoked")) return "drive_reconnect_required";
  if (status === 422 && reason === "drive_export_rejected") return "google_docs_failed";
  if (status === 429) return "temporarily_unavailable";
  if (status >= 503 && status <= 599) return "temporarily_unavailable";
  if (reason === "export_temporarily_unavailable" || reason === "access_token_failed" || reason === "oauth_config_missing") {
    return "temporarily_unavailable";
  }
  if (status === 400 || status === 413) return "invalid_export";
  return "google_docs_failed";
}

/** 応答の本文を上限つきで読む（上限を超えたら読むのをやめる）。JSON でなければ null。 */
async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > NIHO_API_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

/** 起点の下に path を区切りごとに足す（文字列をつなげない。旧 Mac アプリの `api_url`）。 */
function target(apiBase: string, segments: readonly string[]): string {
  const url = new URL(apiBase);
  const base = url.pathname.replace(/\/+$/, "");
  url.pathname = `${base}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
  return url.toString();
}

/** 同意の URL（旧 Mac アプリの `validate_authorization_url`）。 */
export function isAuthorizationUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:"
    && url.hostname === "accounts.google.com"
    && (url.port === "" || url.port === "443")
    && url.pathname.startsWith("/o/oauth2/")
    && url.username === ""
    && url.password === ""
  );
}

/** 接続の状態（`CONNECTED` なのに接続先のメールが無い応答は受け付けない）。 */
function parseConnection(body: unknown): GoogleDocsConnection {
  if (!isRecord(body) || !isRecord(body.connection)) throw new GoogleDocsError("invalid_response");
  const { status, connectedEmail, reason } = body.connection;
  if (status !== "CONNECTED" && status !== "DISCONNECTED" && status !== "ERROR") throw new GoogleDocsError("invalid_response");
  const email = typeof connectedEmail === "string" && connectedEmail.trim() !== "" ? connectedEmail.trim() : null;
  if (status === "CONNECTED" && email === null) throw new GoogleDocsError("invalid_response");
  return { status, connectedEmail: email, reason: typeof reason === "string" && reason !== "" ? reason : null };
}

/** 書き出しの受付（`url` は受け取らず、確かめた `documentId` から組み立てる）。 */
function parseExport(body: unknown, exportId: string): GoogleDocsExport {
  if (!isRecord(body)) throw new GoogleDocsError("invalid_response");
  if (body.status === "completed") {
    if (!isDocumentId(body.documentId)) throw new GoogleDocsError("invalid_response");
    return { exportId, status: "completed", documentId: body.documentId, url: documentUrl(body.documentId) };
  }
  if (body.status === "pending") {
    return { exportId, status: "pending", retryable: body.retryable === true };
  }
  throw new GoogleDocsError("invalid_response");
}

export type NihoGatewayOptions = {
  apiBase: string;
  returnTo: string;
  timeoutMs?: number;
  /** テストで差し替える。既定は呼んだ時点の globalThis.fetch。 */
  fetch?: typeof fetch;
};

type CallInput = {
  method: "GET" | "POST" | "DELETE";
  segments: readonly string[];
  body?: Json;
  /** 送ったが結果が分からないときに `export_result_unknown` にする（書き出しの POST だけ）。 */
  uncertainExport?: boolean;
};

export function createNihoGoogleDocsGateway(options: NihoGatewayOptions): GoogleDocsGateway {
  const timeoutMs = options.timeoutMs ?? NIHO_API_TIMEOUT_MS;

  async function call(credential: GoogleDocsCredential, input: CallInput): Promise<unknown> {
    const fetchFn = options.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetchFn(target(options.apiBase, input.segments), {
        method: input.method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential.idToken()}`,
          ...(input.body ? { "content-type": "application/json" } : {}),
        },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // 時間切れ・通信の失敗（理由は持たない）
      throw new GoogleDocsError(input.uncertainExport ? "export_result_unknown" : "google_docs_failed");
    }
    const body = await readJson(response);
    if (response.status < 200 || response.status >= 300) throw new GoogleDocsError(apiFailure(response.status, failureReason(body)));
    if (body === null) throw new GoogleDocsError("invalid_response");
    return body;
  }

  return {
    async connection(credential) {
      return parseConnection(await call(credential, { method: "GET", segments: [...EDITOR_DOCS_PREFIX, "connection"] }));
    },
    async connect(credential) {
      const body = await call(credential, {
        method: "POST",
        segments: [...EDITOR_DOCS_PREFIX, "connect"],
        body: { returnTo: "niho-editor" },
      });
      const url = isRecord(body) ? body.authorizationUrl : null;
      // host・path を確かめられない URL へは送らない
      if (!isAuthorizationUrl(url)) throw new GoogleDocsError("invalid_response");
      return url;
    },
    async disconnect(credential) {
      return parseConnection(await call(credential, { method: "DELETE", segments: [...EDITOR_DOCS_PREFIX, "connection"] }));
    },
    async export(credential, request) {
      if (checkExportRequest(request) !== "ok") throw new GoogleDocsError("invalid_export");
      const body = await call(credential, {
        method: "POST",
        segments: [...EDITOR_DOCS_PREFIX, "exports"],
        body: { exportId: request.exportId, title: request.title.trim(), markdown: request.markdown },
        uncertainExport: true,
      });
      return parseExport(body, request.exportId);
    },
    async exportStatus(credential, exportId) {
      if (!isExportId(exportId)) throw new GoogleDocsError("invalid_export");
      const body = await call(credential, { method: "GET", segments: [...EDITOR_DOCS_PREFIX, "exports", exportId] });
      return parseExport(body, exportId);
    },
  };
}
