import type { EditorStore } from "@niho/editor-store";
import type { AuthProvider, Session } from "../auth/types";
import { exportMarkdown } from "../export/markdown";
import {
  checkExportRequest,
  googleDocTitle,
  GoogleDocsError,
  isExportId,
  type GoogleDocsCredential,
  type GoogleDocsExport,
  type GoogleDocsFailureCode,
  type GoogleDocsGateway,
} from "../google-docs/gateway";
import { errorResponse, guarded, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";

/**
 * Google ドキュメントへの書き出しの API（設計 docs/architecture/editor-google-docs-export.md）。
 *
 * editor は Google を直接呼ばない。NIHO が既に動かしている `me/docs-drive/*` を**サーバー側から本人として**呼ぶ
 * （src/google-docs/niho.ts）。本人の token はこの層から外へ出さず、ブラウザへ返すのは接続の状態・`documentId`・短い code だけ。
 *
 * - 本人のものだけ。未認証は 401、他人のページ・存在しない id は 404（同じ応答）。更新系は同じ origin からだけ（違えば 403）。
 * - 方式が閉じている・本人のDocs用tokenが出せないときは 503 `google_docs_unavailable`。
 * - **本文はサーバーが保存済みの blocks から作る**（ブラウザから本文を受け取らない）。題名はページの題名。
 * - 同じ `exportId` の書き出しは、同じ内容の再試行だけ（二重に文書を作らない仕掛けは API 側にある）。
 */

/** 書き出しが使う store の操作。 */
export type GoogleDocsPagesStore = Pick<EditorStore, "getPage">;

export type GoogleDocsApiDeps = {
  auth: () => AuthProvider;
  /** DB が使えないときは null（503）。 */
  store: () => GoogleDocsPagesStore | null;
  /** 方式が閉じているときは null（503 `google_docs_unavailable`）。 */
  gateway: () => GoogleDocsGateway | null;
  /** 本人の資格情報。出せないときは null（503 `google_docs_unavailable`）。 */
  credential: (session: Session) => Promise<GoogleDocsCredential | null>;
  env?: Readonly<Record<string, string | undefined>>;
};

type ErrorCode = GoogleDocsFailureCode | "google_docs_unavailable";

const STATUS: Record<ErrorCode, number> = {
  // NIHO editor認証は写真本人確認専用でapiTokenを発行しない。Docs用の最小権限credentialが無い間は閉じる。
  google_docs_unavailable: 503,
  signed_out: 401,
  // niho-app が editor からの呼び出しを許していない（API の niho_docs_app_required）
  app_not_allowed: 503,
  temporarily_unavailable: 503,
  drive_not_connected: 409,
  drive_reconnect_required: 409,
  drive_connection_changed: 409,
  export_payload_conflict: 409,
  export_not_found: 404,
  // 送ったが結果が分からない（同じ exportId で確かめてから再試行する）
  export_result_unknown: 502,
  invalid_export: 413,
  invalid_response: 502,
  google_docs_failed: 502,
};

/** http.ts に無いこの機能の code。header は他の応答と同じ（jsonResponse）。 */
function failure(code: ErrorCode): Response {
  return jsonResponse(STATUS[code], { error: code });
}

function failureOf(error: unknown): Response {
  return error instanceof GoogleDocsError ? failure(error.code) : failure("google_docs_failed");
}

/** 方式・本人・資格情報が揃っているか。揃っていなければ応答（401・503）。 */
type Ready = { session: Session; gateway: GoogleDocsGateway; credential: GoogleDocsCredential };

async function ready(request: Request, deps: GoogleDocsApiDeps): Promise<Ready | { response: Response }> {
  const auth = deps.auth();
  const session = await auth.getSession(request);
  if (!session) return { response: errorResponse("unauthorized") };
  const gateway = deps.gateway();
  if (!gateway) return { response: failure("google_docs_unavailable") };
  const credential = await deps.credential(session);
  if (!credential) return { response: failure("google_docs_unavailable") };
  return { session, gateway, credential };
}

function isReady(value: Ready | { response: Response }): value is Ready {
  return !("response" in value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 本人の Google ドキュメント接続の状態。 */
export function connectionRoute(request: Request, deps: GoogleDocsApiDeps): Promise<Response> {
  return guarded("GET /api/google-docs/connection", async () => {
    const state = await ready(request, deps);
    if (!isReady(state)) return state.response;
    try {
      return jsonResponse(200, { connection: await state.gateway.connection(state.credential) });
    } catch (error) {
      return failureOf(error);
    }
  });
}

/**
 * Google の同意へ送る（同じ origin の画面の form からだけ）。API から受け取った URL は host と path を確かめてから
 * `Location` に入れる（303）。開けないときは案内の画面へ code を付けて戻す。
 */
export function connectRoute(request: Request, deps: GoogleDocsApiDeps, returnPath: string): Promise<Response> {
  return guarded("POST /api/google-docs/connect", async () => {
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const state = await ready(request, deps);
    if (!isReady(state)) return state.response;
    let authorizationUrl: string;
    try {
      authorizationUrl = await state.gateway.connect(state.credential);
    } catch (error) {
      const code = error instanceof GoogleDocsError ? error.code : "google_docs_failed";
      return seeOther(withError(returnPath, code));
    }
    return seeOther(authorizationUrl);
  });
}

/** 案内の画面へ戻すときに失敗の code を付ける（値ではなく code だけ）。 */
function withError(returnPath: string, code: ErrorCode): string {
  return `${returnPath}${returnPath.includes("?") ? "&" : "?"}error=${encodeURIComponent(code)}`;
}

function seeOther(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: location, "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" },
  });
}

/**
 * 接続をやめる（同じ origin だけ）。Google 側の取り消しも API が行う。
 * `returnPath` を渡すと、JSON ではなくその path へ 303 で戻す（画面の form から押したとき）。
 */
export function disconnectRoute(request: Request, deps: GoogleDocsApiDeps, returnPath?: string): Promise<Response> {
  return guarded("POST /api/google-docs/disconnect", async () => {
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const state = await ready(request, deps);
    if (!isReady(state)) return state.response;
    try {
      const connection = await state.gateway.disconnect(state.credential);
      return returnPath ? seeOther(returnPath) : jsonResponse(200, { connection });
    } catch (error) {
      if (!returnPath) return failureOf(error);
      const code = error instanceof GoogleDocsError ? error.code : "google_docs_failed";
      return seeOther(withError(returnPath, code));
    }
  });
}

function exportResponse(result: GoogleDocsExport): Response {
  return jsonResponse(result.status === "completed" ? 200 : 202, result);
}

/**
 * ページ 1 つを Google ドキュメントへ書き出す（同じ origin だけ）。本文はここで作る。
 * 本文が空（書き出せるブロックが無い）ときは 400、長すぎるときは 413（どちらも API を呼ばない）。
 * 題名は API の上限（200）で切る（`googleDocTitle`。ページの題名は 500 文字まで入る）。
 */
export function exportPageRoute(request: Request, id: string, deps: GoogleDocsApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/export/google-doc", async () => {
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const state = await ready(request, deps);
    if (!isReady(state)) return state.response;
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const input = body.value;
    if (!isPlainObject(input) || Object.keys(input).some((key) => key !== "exportId") || !isExportId(input.exportId)) {
      return errorResponse("bad_request");
    }
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const page = await store.getPage(state.session.userId, id);
    if (!page) return notFoundResponse();
    // `:::note` を知らない読み手へ渡すので、箱は引用にする
    const markdown = exportMarkdown(page.blocks, { boxes: "quote" });
    // 書き出せるブロックが無いページは、送る前に断る（API を呼ばない）
    if (markdown === "") return errorResponse("bad_request");
    // 題名はページの題名（API の上限で切る。断らない）
    const exportRequest = { exportId: input.exportId, title: googleDocTitle(page.title), markdown };
    if (checkExportRequest(exportRequest) !== "ok") return errorResponse("payload_too_large");
    try {
      return exportResponse(await state.gateway.export(state.credential, exportRequest));
    } catch (error) {
      return failureOf(error);
    }
  });
}

/** 受付の状態（`export_result_unknown` のあとに確かめる）。 */
export function exportStatusRoute(request: Request, exportId: string, deps: GoogleDocsApiDeps): Promise<Response> {
  return guarded("GET /api/google-docs/exports/[exportId]", async () => {
    const state = await ready(request, deps);
    if (!isReady(state)) return state.response;
    if (!isExportId(exportId)) return notFoundResponse();
    try {
      return exportResponse(await state.gateway.exportStatus(state.credential, exportId));
    } catch (error) {
      return failureOf(error);
    }
  });
}
