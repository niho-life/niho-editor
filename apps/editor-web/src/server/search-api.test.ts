import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { QueryTooLongError, SEARCH_QUERY_MAX_CHARS, type SearchHit, type SearchOptions } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { SEARCH_QUERY_MAX_CHARS as CLIENT_SEARCH_QUERY_MAX_CHARS } from "../lib/search-client";
import { searchPagesRoute, type SearchApiDeps, type SearchFn } from "./search-api";

const ORIGIN = "http://editor.test";

type Row = SearchHit & { owner: string; deleted: boolean; body: string };

/** owner ごとに分けた、メモリの中だけの合成の検索（searchPages と同じ約束: 自分の・ゴミ箱でない行だけ、長すぎる語は QueryTooLongError）。 */
function memorySearch(rows: Row[]) {
  const calls: Array<{ owner: string; query: string; options: SearchOptions }> = [];
  const search: SearchFn = async (owner, query, options) => {
    calls.push({ owner, query, options });
    if (Array.from(query.trim()).length > SEARCH_QUERY_MAX_CHARS) throw new QueryTooLongError();
    const term = query.trim().toLowerCase();
    return rows
      .filter((row) => row.owner === owner && !row.deleted && `${row.title}\n${row.body}`.toLowerCase().includes(term))
      .slice(0, options.limit ?? 30)
      .map(({ id, kind, title, snippet, updatedAt, tab }) => ({ id, kind, title, snippet, updatedAt, tab }));
  };
  return { search, calls };
}

function row(owner: string, title: string, body: string, extra: Partial<Row> = {}): Row {
  return { id: randomUUID(), kind: "note", title, snippet: body.slice(0, 80), updatedAt: new Date().toISOString(), tab: null, owner, deleted: false, body, ...extra };
}

/** 検索の API が呼ぶのは getSession だけ。ログインの経路（AuthProvider の残り）は使わない。 */
const notUsed = async (): Promise<Response> => {
  throw new Error("the search API never calls the login routes");
};

function authAs(userId: string | null): AuthProvider {
  return {
    mode: "stub",
    getSession: async () => (userId ? { userId, mode: "stub" } : null),
    beginLogin: notUsed,
    completeLogin: notUsed,
    logout: notUsed,
  };
}

function deps(userId: string | null, search: SearchFn | null): SearchApiDeps {
  return { auth: () => authAs(userId), search: () => search };
}

function get(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/search${query}`, { method: "GET", headers: { host: "editor.test", ...headers } });
}

describe("GET /api/search", () => {
  it("returns only the signed-in owner's live pages, with exactly the five result fields", async () => {
    const mine = row("user-a", "合成の題名", "合成の本文 quokka");
    const theirs = row("user-b", "他人の題名", "他人の本文 quokka");
    const removed = row("user-a", "削除済み", "quokka", { deleted: true });
    const { search, calls } = memorySearch([mine, theirs, removed]);

    const response = await searchPagesRoute(get("?q=quokka&owner=user-b"), deps("user-a", search));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: SearchHit[] };
    expect(body.results.map((hit) => hit.id)).toEqual([mine.id]);
    expect(Object.keys(body.results[0]!).sort()).toEqual(["id", "kind", "snippet", "tab", "title", "updatedAt"]);
    expect(calls).toEqual([{ owner: "user-a", query: "quokka", options: {} }]);
  });

  it("does not pass through anything the store adds beyond the six fields", async () => {
    const leaky: SearchFn = async () => [
      { id: randomUUID(), kind: "note", title: "t", snippet: "s", updatedAt: new Date(0).toISOString(), tab: "英語版", owner: "user-b", search_text: "他人の本文", blocks: [] } as unknown as SearchHit,
    ];
    const response = await searchPagesRoute(get("?q=x"), deps("user-a", leaky));
    const text = await response.text();
    expect(text).not.toContain("user-b");
    expect(text).not.toContain("他人の本文");
    expect(text).not.toContain("search_text");
    expect(text).not.toContain("blocks");
  });

  it("answers 401 without a session and 503 without a database, before reading the query", async () => {
    const { search, calls } = memorySearch([]);
    const unauthorized = await searchPagesRoute(get("?q=x"), deps(null, search));
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.text()).toBe('{"error":"unauthorized"}');
    const unavailable = await searchPagesRoute(get("?q=x"), deps("user-a", null));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).toBe('{"error":"unavailable"}');
    expect((await searchPagesRoute(get(`?q=${"a".repeat(101)}`), deps(null, search))).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("answers 200 with no results for a missing or blank query without searching", async () => {
    const { search, calls } = memorySearch([row("user-a", "t", "b")]);
    for (const query of ["", "?q=", "?q=%20%E3%80%80%0A", "?limit=5"]) {
      const response = await searchPagesRoute(get(query), deps("user-a", search));
      expect(response.status, query).toBe(200);
      expect(await response.text()).toBe('{"results":[]}');
    }
    expect(calls).toEqual([]);
  });

  it("answers 400 to a query longer than 100 characters and to an invalid limit", async () => {
    const { search, calls } = memorySearch([]);
    expect((await searchPagesRoute(get(`?q=${encodeURIComponent("あ".repeat(100))}`), deps("user-a", search))).status).toBe(200);
    const tooLong = await searchPagesRoute(get(`?q=${encodeURIComponent("あ".repeat(101))}`), deps("user-a", search));
    expect(tooLong.status).toBe(400);
    expect(await tooLong.text()).toBe('{"error":"bad_request"}');
    for (const limit of ["0", "-1", "1.5", "101", "abc", "", "01", "1e2", "999"]) {
      const response = await searchPagesRoute(get(`?q=x&limit=${encodeURIComponent(limit)}`), deps("user-a", search));
      expect(response.status, limit).toBe(400);
      expect(await response.text()).toBe('{"error":"bad_request"}');
    }
    expect((await searchPagesRoute(get("?q=x&q=y"), deps("user-a", search))).status).toBe(400);
    expect((await searchPagesRoute(get("?q=x&limit=1&limit=2"), deps("user-a", search))).status).toBe(400);
    const ok = await searchPagesRoute(get("?q=x&limit=100"), deps("user-a", search));
    expect(ok.status).toBe(200);
    expect(calls.at(-1)).toEqual({ owner: "user-a", query: "x", options: { limit: 100 } });
  });

  it("answers 500 without internal details when the search fails", async () => {
    const failing: SearchFn = async () => {
      throw Object.assign(new Error("syntax error at or near SELECT search_text FROM pages"), { code: "42601" });
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await searchPagesRoute(get("?q=x"), deps("user-a", failing));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":"internal"}');
    expect(JSON.stringify(log.mock.calls)).not.toContain("SELECT");
    log.mockRestore();
  });

  it("marks every response noindex, nofollow and uncacheable", async () => {
    const { search } = memorySearch([row("user-a", "t", "x")]);
    const responses = [
      await searchPagesRoute(get("?q=x"), deps("user-a", search)),
      await searchPagesRoute(get("?q="), deps("user-a", search)),
      await searchPagesRoute(get("?q=x&limit=0"), deps("user-a", search)),
      await searchPagesRoute(get("?q=x"), deps(null, search)),
      await searchPagesRoute(get("?q=x"), deps("user-a", null)),
    ];
    for (const response of responses) {
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    }
  });

  it("uses the same query length limit in the browser as on the server", () => {
    expect(CLIENT_SEARCH_QUERY_MAX_CHARS).toBe(SEARCH_QUERY_MAX_CHARS);
  });
});
