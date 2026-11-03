import { InvalidPageCursorError, type EditorStore } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import {
  conflictResponse,
  errorResponse,
  guarded,
  isSameOriginRequest,
  jsonResponse,
  noContentResponse,
  notFoundResponse,
  PAGE_BODY_MAX_BYTES,
  readJsonBody,
} from "./http";
import { parseCreatePage, parseListQuery, parseMoveParent, parsePageSave } from "./page-input";

/** API の route が使う store の操作。 */
export type PagesStore = Pick<
  EditorStore,
  | "createPage"
  | "listPageChunk"
  | "getPage"
  | "savePage"
  | "movePage"
  | "deletePage"
  | "listVersions"
  | "getVersion"
  | "restoreVersion"
  | "listTrash"
  | "restoreFromTrash"
>;

/** `/api/pages`・`/api/trash` が使うもの。route から渡す（テストでは差し替える）。 */
export type PagesApiDeps = {
  auth: () => AuthProvider;
  store: () => PagesStore | null;
  env?: Readonly<Record<string, string | undefined>>;
};

/** route の要求の session（無ければ null）。versions-api・trash-api も使う。 */
export async function sessionOf(request: Request, deps: PagesApiDeps) {
  return deps.auth().getSession(request);
}

/**
 * GET /api/pages?limit=&cursor= — 自分のページの一覧（更新順）を limit 件（既定 100）ずつ。
 * 応答は `{ pages, next }`。続きは next を cursor に渡して読む（無ければ null）。limit・cursor が読めなければ 400。
 */
export function listPages(request: Request, deps: PagesApiDeps): Promise<Response> {
  return guarded("GET /api/pages", async () => {
    const session = await sessionOf(request, deps);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const query = parseListQuery(new URL(request.url).searchParams);
    if (!query.ok) return errorResponse("bad_request");
    try {
      return jsonResponse(200, await store.listPageChunk(session.userId, query.value));
    } catch (error) {
      if (error instanceof InvalidPageCursorError) return errorResponse("bad_request");
      throw error;
    }
  });
}

/** POST /api/pages — 新しいページ（`{}` で空のページ）。 */
export function createPage(request: Request, deps: PagesApiDeps): Promise<Response> {
  return guarded("POST /api/pages", async () => {
    const session = await sessionOf(request, deps);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const body = await readJsonBody(request, PAGE_BODY_MAX_BYTES);
    if (!body.ok) return body.response;
    const input = parseCreatePage(body.value);
    if (!input.ok) return errorResponse("bad_request");
    try {
      return jsonResponse(201, { page: await store.createPage(session.userId, input.value) });
    } catch (error) {
      if (error instanceof RangeError && error.message === "editor-store: page is too large") return errorResponse("page_full");
      throw error;
    }
  });
}

/** GET /api/pages/{id} — 自分のページ。それ以外は全て同じ 404。 */
export function getPage(request: Request, id: string, deps: PagesApiDeps): Promise<Response> {
  return guarded("GET /api/pages/[id]", async () => {
    const session = await sessionOf(request, deps);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const page = await store.getPage(session.userId, id);
    return page ? jsonResponse(200, { page }) : notFoundResponse();
  });
}

/**
 * PATCH /api/pages/{id} — 題名・本文・言語などの部分更新。`baseRevision`（必須）が今の revision と違えば
 * 何も書かずに 409 と今のページ。自分のページでなければ（revision によらず）同じ 404。
 */
export function patchPage(request: Request, id: string, deps: PagesApiDeps): Promise<Response> {
  return guarded("PATCH /api/pages/[id]", async () => {
    const session = await sessionOf(request, deps);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    // 本文の検査は id の有無より先（どの id でも同じ順に判定し、存在を漏らさない）
    const body = await readJsonBody(request, PAGE_BODY_MAX_BYTES);
    if (!body.ok) return body.response;
    const input = parsePageSave(body.value);
    if (!input.ok) return errorResponse("bad_request");
    const { patch, baseRevision, overwrite } = input.value;
    // 404 の判定（自分のページか）は store が revision の比較より先に行う
    const result = await store.savePage(session.userId, id, patch, { baseRevision, overwrite });
    if (!result) return notFoundResponse();
    if (result.status === "page_full") return errorResponse("page_full");
    return result.status === "saved" ? jsonResponse(200, { page: result.page }) : conflictResponse(result.page);
  });
}

/**
 * PATCH /api/pages/{id}/parent — フォルダへ入れる・出す（`{ parent: id | null }`。`null` で上の段へ出す）。
 * 変わるのは親だけで、本文・`revision`・`updated_at` は動かない（移動は編集ではない）。
 * 段が深くなりすぎる移動は 409 `too_deep`、自分自身・自分の子孫の下へ入れる移動は 409 `cycle`（どちらも何も書かない）。
 * 自分のページでない・入れ先が自分のページでないときは、どれも同じ 404。
 */
export function movePage(request: Request, id: string, deps: PagesApiDeps): Promise<Response> {
  return guarded("PATCH /api/pages/[id]/parent", async () => {
    const session = await sessionOf(request, deps);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    // 本文の検査は id の有無より先（どの id でも同じ順に判定し、存在を漏らさない）
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const parent = parseMoveParent(body.value);
    if (!parent.ok) return errorResponse("bad_request");
    const result = await store.movePage(session.userId, id, parent.value);
    if (!result) return notFoundResponse();
    if (result === "moved") return jsonResponse(200, { parent: parent.value });
    return errorResponse(result === "too_deep" ? "too_deep" : "cycle");
  });
}

/**
 * DELETE /api/pages/{id} — ゴミ箱へ入れる（30 日後に完全に消える）。子孫のページも一緒に入る。
 * 公開中のページ（子孫を含む）は 409 `published`（先に公開をやめる）。
 */
export function deletePage(request: Request, id: string, deps: PagesApiDeps): Promise<Response> {
  return guarded("DELETE /api/pages/[id]", async () => {
    const session = await sessionOf(request, deps);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const result = await store.deletePage(session.userId, id);
    if (!result) return notFoundResponse();
    return result === "deleted" ? noContentResponse() : errorResponse("published");
  });
}
