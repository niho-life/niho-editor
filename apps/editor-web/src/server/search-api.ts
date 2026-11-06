import { QueryTooLongError, SEARCH_LIMIT_MAX, normalizeSearchQuery, type OwnerId, type SearchHit, type SearchOptions } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { errorResponse, guarded, jsonResponse } from "./http";

/** 本人のページを探す関数（packages/editor-store の searchPages に Pool を渡したもの）。 */
export type SearchFn = (owner: OwnerId, query: string, options: SearchOptions) => Promise<SearchHit[]>;

/** `/api/search` が使うもの。route から渡す（テストでは差し替える）。 */
export type SearchApiDeps = {
  auth: () => AuthProvider;
  /** DB が使えないときは null（503）。 */
  search: () => SearchFn | null;
};

const LIMIT_PATTERN = /^[1-9]\d{0,2}$/;

type ParsedParams = { ok: true; query: string; limit: number | undefined } | { ok: false };

/** `q` は 1 つまで（無ければ空）。`limit` は 1〜100 の整数だけ。 */
function parseParams(url: URL): ParsedParams {
  const queries = url.searchParams.getAll("q");
  const limits = url.searchParams.getAll("limit");
  if (queries.length > 1 || limits.length > 1) return { ok: false };
  const rawLimit = limits[0];
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    if (!LIMIT_PATTERN.test(rawLimit) || Number(rawLimit) > SEARCH_LIMIT_MAX) return { ok: false };
    limit = Number(rawLimit);
  }
  return { ok: true, query: queries[0] ?? "", limit };
}

/** 応答に載せるのは決まった 6 つだけ（store が何を足しても、他の列・他人の情報を出さない）。`tab` はタブの札（無ければ null。#308）。 */
function toResult(hit: SearchHit): SearchHit {
  return { id: hit.id, kind: hit.kind, title: hit.title, snippet: hit.snippet, updatedAt: hit.updatedAt, tab: typeof hit.tab === "string" ? hit.tab : null };
}

/**
 * GET /api/search?q=&limit= — 自分のページを題名と本文から探す（更新順）。
 * 未認証 401、DB が無い 503、`q` が無い・空は 200 の空の結果、`q` が 100 文字を超える・`limit` が不正は 400。
 */
export function searchPagesRoute(request: Request, deps: SearchApiDeps): Promise<Response> {
  return guarded("GET /api/search", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const search = deps.search();
    if (!search) return errorResponse("unavailable");
    const params = parseParams(new URL(request.url));
    if (!params.ok) return errorResponse("bad_request");
    if (normalizeSearchQuery(params.query) === "") return jsonResponse(200, { results: [] });
    const options: SearchOptions = params.limit === undefined ? {} : { limit: params.limit };
    try {
      // owner は認証の層の本人だけ（要求の値からは決めない）
      const hits = await search(session.userId, params.query, options);
      return jsonResponse(200, { results: hits.map(toResult) });
    } catch (error) {
      if (error instanceof QueryTooLongError) return errorResponse("bad_request");
      throw error;
    }
  });
}
