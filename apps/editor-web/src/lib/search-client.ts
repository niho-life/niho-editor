/** ブラウザから `/api/search` を呼ぶ（同じ origin。cookie・token は扱わない）。 */
import type { SearchHit } from "@niho/editor-store";

export type { SearchHit };

/** 検索語の長さの上限（packages/editor-store の SEARCH_QUERY_MAX_CHARS と同じ。src/server/search-api.test.ts が確かめる）。 */
export const SEARCH_QUERY_MAX_CHARS = 100;

export class SearchRequestError extends Error {
  override readonly name = "SearchRequestError";
  constructor(readonly status: number) {
    super(`search request failed with ${status}`);
  }
}

/** サーバーと同じ詰め方（前後の空白を除き、続く空白を 1 つに）。 */
export function normalizeSearchInput(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

function isHit(value: unknown): value is SearchHit {
  if (typeof value !== "object" || value === null) return false;
  const hit = value as Record<string, unknown>;
  // `tab`（タブの札。#308）は無い・null でもよい（古いサーバーの応答も読める）
  if (hit.tab !== undefined && hit.tab !== null && typeof hit.tab !== "string") return false;
  return ["id", "kind", "title", "snippet", "updatedAt"].every((key) => typeof hit[key] === "string");
}

/** 自分のページを探す。`signal` で中止できる（中止したときは AbortError で reject する）。 */
export async function searchRequest(query: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: query });
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const response = await fetch(`/api/search?${params.toString()}`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal: options.signal ?? null,
  });
  if (!response.ok) throw new SearchRequestError(response.status);
  const data = (await response.json()) as { results?: unknown };
  if (!Array.isArray(data.results) || !data.results.every(isHit)) throw new SearchRequestError(500);
  return data.results.map(({ id, kind, title, snippet, updatedAt, tab }) => ({ id, kind, title, snippet, updatedAt, tab: typeof tab === "string" ? tab : null }));
}
