/** API の応答と要求の読み取り。エラーの本文は固定の短い code だけにする（内部の情報・SQL・stack を出さない）。 */

import { AuthTemporarilyUnavailable } from "../auth/types";

export const ROBOTS_HEADER_VALUE = "noindex, nofollow";

/** 要求の本文の上限（1 MiB）。 */
export const MAX_BODY_BYTES = 1024 * 1024;

const BASE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": ROBOTS_HEADER_VALUE,
});

const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  ...BASE_HEADERS,
});

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "published"
  | "too_deep"
  | "cycle"
  | "payload_too_large"
  | "unrestorable"
  | "unavailable"
  | "internal";

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  // 公開中のページは削除しない（先に公開をやめる。設計 §12）
  published: 409,
  // フォルダの段の上限（フォルダ › ページ › 録音のサブページ）を超える移動
  too_deep: 409,
  // 自分自身・自分の子孫の下へ入れる移動
  cycle: 409,
  payload_too_large: 413,
  // 今の形では保存できない古い版には戻さない
  unrestorable: 422,
  unavailable: 503,
  internal: 500,
};

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function errorResponse(code: ApiErrorCode): Response {
  return jsonResponse(STATUS[code], { error: code });
}

/**
 * 別の人のページ・存在しない id・UUID として不正な id のどれにも同じこの応答を返す（本文・header とも同じ。列挙を防ぐ）。
 */
export function notFoundResponse(): Response {
  return errorResponse("not_found");
}

/**
 * 保存の要求の `baseRevision` が今の revision と違った（別の画面・端末が先に保存した）。何も書いていない。
 * 自分のページにだけ返す（それ以外は notFoundResponse）。今のページを全て付ける。
 */
export function conflictResponse(page: unknown): Response {
  return jsonResponse(409, { error: "conflict", page });
}

/** 本文の無い成功（削除・ゴミ箱から戻す）。 */
export function noContentResponse(): Response {
  return new Response(null, { status: 204, headers: BASE_HEADERS });
}

export type BodyResult = { ok: true; value: unknown } | { ok: false; response: Response };

function isJsonContentType(value: string | null): boolean {
  return value !== null && /^application\/json\s*(;|$)/i.test(value.trim());
}

/** JSON の本文を上限つきで読む。上限を超えたら読むのをやめて 413。JSON でなければ 400。 */
export async function readJsonBody(request: Request, limit: number = MAX_BODY_BYTES): Promise<BodyResult> {
  if (!isJsonContentType(request.headers.get("content-type"))) return { ok: false, response: errorResponse("bad_request") };
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    return { ok: false, response: errorResponse("payload_too_large") };
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, response: errorResponse("bad_request") };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, response: errorResponse("payload_too_large") };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, response: errorResponse("bad_request") };
  }
}

/** 想定外の失敗は 500 の汎用エラー（内部の情報は応答に出さず、ログにも名前と code だけを書く）。 */
export async function guarded(route: string, handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof AuthTemporarilyUnavailable) {
      console.error("editor-web: request failed", { route, name: error.name, category: "authentication_unavailable" });
      return errorResponse("unavailable");
    }
    const name = error instanceof Error ? error.name : "unknown";
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
    console.error("editor-web: request failed", { route, name, code });
    return errorResponse("internal");
  }
}

/** この要求が来た origin（`EDITOR_ORIGIN` があればそれ。無ければ Host と転送の header から）。 */
export function expectedOrigin(request: Request, env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  if (env.EDITOR_ORIGIN) {
    try {
      return new URL(env.EDITOR_ORIGIN).origin;
    } catch {
      return null;
    }
  }
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host") || url.host;
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(/:$/, "");
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return null;
  }
}

/**
 * 更新系の要求が同じ origin の画面から来たか。Origin が無い・null・違う origin はどれも拒む
 * （今は cookie を使わないが、niho の cookie 認証になっても CSRF にならないように先に入れておく）。
 */
export function isSameOriginRequest(request: Request, env?: Readonly<Record<string, string | undefined>>): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  const expected = expectedOrigin(request, env);
  return expected !== null && origin === expected;
}
