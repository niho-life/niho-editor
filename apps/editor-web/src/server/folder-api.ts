import type { EditorStore, OwnerId, PageFields, PageFieldsPatch } from "@niho/editor-store";
import { pageFieldsProblem } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { buildFolderExport, photoAssetIds, type FolderExportPhoto } from "../export/folder";
import { ROBOTS_HEADER_VALUE, errorResponse, guarded, isSameOriginRequest, jsonResponse, noContentResponse, notFoundResponse, readJsonBody } from "./http";
import { exportContentDisposition } from "./share-api";

/**
 * フォルダまわりの API（#37。migration 20261101013000_folder_order_fields_opens）。どれも本人のページだけで、未認証は 401、他人のページ・無いページは同じ 404。
 *
 * - `PATCH /api/pages/{id}/order` — 手動の並びを 1 つ動かす（`{ move: "up" | "down" }`）。もう端なら `{ moved: false }`。
 * - `GET /api/pages/{id}/children` — そのページの中の行（フォルダの子。自動参考ページ・書き出しの画面が読む）。
 * - `GET /api/pages/{id}/fields`・`PATCH …` — フォルダの登場人物・固有名詞（背景情報はページの本文そのもの）。
 * - `POST /api/pages/{id}/open` — 「最近」に記録する（本文は送らない。応答は 204）。
 * - `GET /api/pages/{id}/export.zip` — フォルダ単位の書き出し（.md ＋写真）。
 */

export type FolderStore = Pick<EditorStore, "getPage" | "movePageOrder" | "listPageChildren" | "listPageTree">;

export type FolderFieldsStore = {
  get: (owner: OwnerId, pageId: string) => Promise<PageFields>;
  save: (owner: OwnerId, pageId: string, patch: PageFieldsPatch) => Promise<PageFields>;
};

export type FolderPhotoSource = {
  /** 本文に出てくる資産の写真を読む（読めない・大きすぎるときは null。書き出しはその画像の行を出さない）。 */
  read: (owner: OwnerId, assetId: string) => Promise<FolderExportPhoto | null>;
};

export type FolderApiDeps = {
  auth: () => AuthProvider;
  /** DB が使えないときは null（503）。 */
  store: () => FolderStore | null;
  fields: () => FolderFieldsStore | null;
  /** 「最近」の記録（DB が使えないときは null）。 */
  opens: () => ((owner: OwnerId, pageId: string) => Promise<boolean>) | null;
  /** 書き出しの写真（保存先が使えないときは null。そのときは本文だけの zip になる）。 */
  photos: () => FolderPhotoSource | null;
  env?: Readonly<Record<string, string | undefined>>;
};

const ORDER_MOVES = ["up", "down"] as const;

/** `PATCH /api/pages/{id}/order` の本文（`{ move }` だけ）。 */
export function parseOrderMove(body: unknown): { ok: true; move: "up" | "down" } | { ok: false } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false };
  const keys = Object.keys(body);
  const { move } = body as { move?: unknown };
  if (keys.length !== 1 || typeof move !== "string" || !(ORDER_MOVES as readonly string[]).includes(move)) return { ok: false };
  return { ok: true, move: move as "up" | "down" };
}

/** PATCH /api/pages/{id}/order — 手動の並びを 1 つ動かす。本文・revision・更新時刻は変わらない。 */
export function movePageOrder(request: Request, id: string, deps: FolderApiDeps): Promise<Response> {
  return guarded("PATCH /api/pages/[id]/order", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    // 本文の検査は id の有無より先（どの id でも同じ順に判定し、存在を漏らさない）
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const input = parseOrderMove(body.value);
    if (!input.ok) return errorResponse("bad_request");
    const result = await store.movePageOrder(session.userId, id, input.move);
    if (!result) return notFoundResponse();
    return jsonResponse(200, { moved: result === "moved" });
  });
}

/** GET /api/pages/{id}/children — そのページの中の行（並びの順。本文は含めない）。 */
export function listPageChildren(request: Request, id: string, deps: FolderApiDeps): Promise<Response> {
  return guarded("GET /api/pages/[id]/children", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    // 親が本人のページであることを先に確かめる（無ければ子も見せない）
    const page = await store.getPage(session.userId, id);
    if (!page) return notFoundResponse();
    return jsonResponse(200, { pages: await store.listPageChildren(session.userId, page.id) });
  });
}

/** GET /api/pages/{id}/fields — フォルダの登場人物・固有名詞（行が無ければ空）。 */
export function getPageFields(request: Request, id: string, deps: FolderApiDeps): Promise<Response> {
  return guarded("GET /api/pages/[id]/fields", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    const fields = deps.fields();
    if (!store || !fields) return errorResponse("unavailable");
    const page = await store.getPage(session.userId, id);
    if (!page) return notFoundResponse();
    return jsonResponse(200, { fields: await fields.get(session.userId, page.id) });
  });
}

/** PATCH /api/pages/{id}/fields — 渡した項目だけを入れ替え、入れ替えた後の欄を返す。 */
export function patchPageFields(request: Request, id: string, deps: FolderApiDeps): Promise<Response> {
  return guarded("PATCH /api/pages/[id]/fields", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    const fields = deps.fields();
    if (!store || !fields) return errorResponse("unavailable");
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    if (pageFieldsProblem(body.value) !== null) return errorResponse("bad_request");
    const page = await store.getPage(session.userId, id);
    if (!page) return notFoundResponse();
    return jsonResponse(200, { fields: await fields.save(session.userId, page.id, body.value as PageFieldsPatch) });
  });
}

/** POST /api/pages/{id}/open — 「最近」に記録する（本文は送らない）。 */
export function recordPageOpen(request: Request, id: string, deps: FolderApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/open", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const record = deps.opens();
    if (!record) return errorResponse("unavailable");
    return (await record(session.userId, id)) ? noContentResponse() : notFoundResponse();
  });
}

/** 書き出しが断る理由（どれも何も作っていない）。 */
const EXPORT_PROBLEMS = { empty: "bad_request", too_many: "payload_too_large", too_large: "payload_too_large", archive: "internal" } as const;

/**
 * GET /api/pages/{id}/export.zip — そのページとその中のページを `.md` ＋写真の zip にする。
 * 件数・字数が上限を超えたら 413、組めなければ 500（どれも何も返さない）。
 */
export function exportFolder(request: Request, id: string, deps: FolderApiDeps): Promise<Response> {
  return guarded("GET /api/pages/[id]/export.zip", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    const fields = deps.fields();
    if (!store || !fields) return errorResponse("unavailable");
    const owner = session.userId;
    const pages = await store.listPageTree(owner, id);
    const folder = pages[0];
    if (!folder) return notFoundResponse();
    const photos = new Map<string, FolderExportPhoto>();
    const source = deps.photos();
    if (source) {
      for (const page of pages) {
        for (const assetId of photoAssetIds(page.blocks)) {
          if (photos.has(assetId)) continue;
          const photo = await source.read(owner, assetId);
          if (photo) photos.set(assetId, photo);
        }
      }
    }
    const archive = buildFolderExport({ pages, fields: await fields.get(owner, folder.id), photos });
    if (!archive.ok) return errorResponse(EXPORT_PROBLEMS[archive.reason]);
    return new Response(archive.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": exportContentDisposition(folder.title, "zip"),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": ROBOTS_HEADER_VALUE,
      },
    });
  });
}
