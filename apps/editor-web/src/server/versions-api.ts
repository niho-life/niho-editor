import { conflictResponse, errorResponse, guarded, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";
import { parseBlocks, parseRestoreBody, parseVersionNumber } from "./page-input";
import { sessionOf, type PagesApiDeps } from "./pages-api";

/** GET /api/pages/{id}/versions — 版の一覧（新しい順・最大 100・本文は含めない）。 */
export function listVersions(request: Request, id: string, deps: PagesApiDeps): Promise<Response> {
  return guarded("GET /api/pages/[id]/versions", async () => {
    const session = await sessionOf(request, deps);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const versions = await store.listVersions(session.userId, id);
    return versions ? jsonResponse(200, { versions }) : notFoundResponse();
  });
}

/** GET /api/pages/{id}/versions/{n} — 版 1 つ（本文を含む）。番号が正の整数でない・版が無いときもページと同じ 404。 */
export function getVersion(request: Request, id: string, versionParam: string, deps: PagesApiDeps): Promise<Response> {
  return guarded("GET /api/pages/[id]/versions/[version]", async () => {
    const session = await sessionOf(request, deps);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const number = parseVersionNumber(versionParam);
    if (number === null) return notFoundResponse();
    const version = await store.getVersion(session.userId, id, number);
    return version ? jsonResponse(200, { version }) : notFoundResponse();
  });
}

/**
 * POST /api/pages/{id}/versions/{n}/restore — 「この版に戻す」。今の本文を版（restore）に残してから、その版の本文を書く。
 * `baseRevision` が違えば 409 と今のページ。版の本文が今の限定 AST の検査を通らなければ 422 `unrestorable`（何も書かない）。
 */
export function restoreVersion(request: Request, id: string, versionParam: string, deps: PagesApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/versions/[version]/restore", async () => {
    const session = await sessionOf(request, deps);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    // 本文の検査は id・番号の有無より先（どの id でも同じ順に判定する）
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const input = parseRestoreBody(body.value);
    if (!input.ok) return errorResponse("bad_request");
    const number = parseVersionNumber(versionParam);
    if (number === null) return notFoundResponse();
    const result = await store.restoreVersion(session.userId, id, number, {
      baseRevision: input.value.baseRevision,
      // 保存のときと同じ検査（大きさ・深さ・NUL・限定 AST）。通った写しを書く
      accept: (blocks) => {
        const checked = parseBlocks(blocks);
        return checked.ok ? checked.value : null;
      },
    });
    if (!result) return notFoundResponse();
    if (result.status === "conflict") return conflictResponse(result.page);
    if (result.status === "unrestorable") return errorResponse("unrestorable");
    if (result.status === "page_full") return errorResponse("page_full");
    return jsonResponse(200, { page: result.page });
  });
}
