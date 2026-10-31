import { createHash } from "node:crypto";
import type { DocsPageShareState } from "@niho/docs-core";
import type { Block, DuplicatedPage, OwnerId, PageShareState } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { exportMarkdown } from "../export/markdown";
import { ROBOTS_HEADER_VALUE, errorResponse, expectedOrigin, guarded, isSameOriginRequest, jsonResponse, notFoundResponse } from "./http";

/**
 * 「…」の操作のうちサーバーで行うもの（#34）: リンクで共有（状態・開始・作り直し・停止）、複製、Markdown の書き出し。
 * 全て本人の・ゴミ箱でないページだけ。未認証 401、DB なし 503、別の人・存在しない・不正な id・削除済みは同じ 404。
 * 更新系（PUT・POST・DELETE）は同じ origin の画面からだけ（違えば 403）。
 */

/** 共有・複製・書き出しが使う store の操作（packages/editor-store の関数に Pool を渡したもの）。null はページが無い。 */
export type PageActionsStore = {
  getShare: (owner: OwnerId, pageId: string) => Promise<PageShareState | null>;
  enableShare: (owner: OwnerId, pageId: string) => Promise<PageShareState | null>;
  rotateShare: (owner: OwnerId, pageId: string) => Promise<PageShareState | null>;
  stopShare: (owner: OwnerId, pageId: string) => Promise<PageShareState | null>;
  duplicatePage: (owner: OwnerId, pageId: string) => Promise<DuplicatedPage | null>;
  /** 書き出しに使う題名と本文（最新の保存版）。 */
  getPage: (owner: OwnerId, pageId: string) => Promise<{ title: string; blocks: Block[] } | null>;
};

export type ShareApiDeps = {
  auth: () => AuthProvider;
  /** DB が使えないときは null（503）。 */
  store: () => PageActionsStore | null;
  env?: Readonly<Record<string, string | undefined>>;
};

/**
 * 共有の状態の公開してよい識別子（docs-core の publicId）。token そのものは url の中だけに出し、ここには
 * token から一方向に作った値を入れる（作り直すと変わる。画面が「どのリンクか」を比べるため）。
 */
export function sharePublicId(token: string): string {
  return createHash("sha256").update(`niho-editor-share:${token}`).digest("base64url").slice(0, 22);
}

/** store の状態を docs-core の DocsPageShareState にする。url は `${origin}/s/${token}`（origin が決まらなければ null）。 */
export function toShareState(state: PageShareState, origin: string | null): DocsPageShareState {
  if (!state.shared) return { status: "PRIVATE", publicId: null, url: null, updatedAt: null };
  return {
    status: "PUBLIC",
    publicId: sharePublicId(state.token),
    url: origin ? `${origin}/s/${state.token}` : null,
    updatedAt: state.rotatedAt ?? state.createdAt,
  };
}

/**
 * ページを開くとき（`/p/{id}` の RSC）に、「…」の「共有中」の印のためだけに共有しているかを読む。リンク（token）は返さない
 * （共有のシートを開いたときに API で読む）。ページが無い・DB を使えない・読めなかったときは null（印を出さない。ページは開く）。
 */
export async function readShareFlag(store: Pick<PageActionsStore, "getShare"> | null, owner: OwnerId, pageId: string): Promise<boolean | null> {
  if (!store) return null;
  try {
    const state = await store.getShare(owner, pageId);
    return state ? state.shared : null;
  } catch (error) {
    // 値（token・SQL）は出さない
    console.error("editor-web: share state read failed", { name: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

type ShareOperation = "getShare" | "enableShare" | "rotateShare" | "stopShare";

function shareRoute(route: string, operation: ShareOperation, write: boolean) {
  return (request: Request, id: string, deps: ShareApiDeps): Promise<Response> =>
    guarded(route, async () => {
      const session = await deps.auth().getSession(request);
      if (!session) return errorResponse("unauthorized");
      if (write && !isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
      const store = deps.store();
      if (!store) return errorResponse("unavailable");
      // owner は認証の層の本人だけ（要求の値からは決めない）
      const state = await store[operation](session.userId, id);
      if (!state) return notFoundResponse();
      return jsonResponse(200, { share: toShareState(state, expectedOrigin(request, deps.env)) });
    });
}

/** GET /api/pages/{id}/share — 共有の状態。 */
export const getShareRoute = shareRoute("GET /api/pages/[id]/share", "getShare", false);
/** PUT /api/pages/{id}/share — 共有を始める（冪等: 共有中なら同じリンク）。 */
export const enableShareRoute = shareRoute("PUT /api/pages/[id]/share", "enableShare", true);
/** POST /api/pages/{id}/share/rotate — リンクを作り直す（古いリンクはすぐ 404）。共有していなければ始める。 */
export const rotateShareRoute = shareRoute("POST /api/pages/[id]/share/rotate", "rotateShare", true);
/** DELETE /api/pages/{id}/share — 共有を止める（すぐ 404。冪等）。 */
export const stopShareRoute = shareRoute("DELETE /api/pages/[id]/share", "stopShare", true);

/** POST /api/pages/{id}/duplicate — 複製（201 で新しいページ）。 */
export function duplicatePageRoute(request: Request, id: string, deps: ShareApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/duplicate", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const page = await store.duplicatePage(session.userId, id);
    return page ? jsonResponse(201, { page }) : notFoundResponse();
  });
}

/** 書き出しのファイル名の上限（文字数。拡張子を除く）。 */
export const EXPORT_FILENAME_MAX_CHARS = 80;

/** ファイル名に使えない文字（制御文字・向きを変える書式文字・パスや引用の記号）を除き、80 文字までにする。空なら page。 */
export function exportFileBaseName(title: string): string {
  const cleaned = title
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  const name = Array.from(cleaned).slice(0, EXPORT_FILENAME_MAX_CHARS).join("").replace(/[\s.]+$/, "");
  return name === "" ? "page" : name;
}

/**
 * RFC 6266 / 5987。ASCII の filename は常に `page.{拡張子}`、filename* に UTF-8 の題名。
 * 拡張子は本文の書き出しが `md`、フォルダの書き出し（#37）が `zip`。
 */
export function exportContentDisposition(title: string, extension: "md" | "zip" = "md"): string {
  const fallback = `page.${extension}`;
  let encoded: string;
  try {
    encoded = encodeURIComponent(`${exportFileBaseName(title)}.${extension}`).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch {
    encoded = fallback;
  }
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** GET /api/pages/{id}/export.md — 本文を niho-experience の Markdown サブセットで書き出す（最新の保存版）。 */
export function exportMarkdownRoute(request: Request, id: string, deps: ShareApiDeps): Promise<Response> {
  return guarded("GET /api/pages/[id]/export.md", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const page = await store.getPage(session.userId, id);
    if (!page) return notFoundResponse();
    return new Response(exportMarkdown(page.blocks), {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": exportContentDisposition(page.title),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": ROBOTS_HEADER_VALUE,
      },
    });
  });
}
