// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchHit } from "./search-client";
import { SEARCH_DEBOUNCE_MS, usePageSearch, type PageSearchState } from "./use-page-search";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

type Pending = { url: URL; signal: AbortSignal; resolve: (results: SearchHit[]) => void; fail: (status: number) => void };

/** fetch の代わり: 要求を覚えておき、テストが答えを返す。中止されたら AbortError で reject する。 */
function fakeFetch() {
  const requests: Pending[] = [];
  const fetchMock = vi.fn((input: string, init: RequestInit) => {
    const signal = init.signal as AbortSignal;
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      requests.push({
        url: new URL(input, "http://editor.test"),
        signal,
        resolve: (results) => resolve({ ok: true, status: 200, json: async () => ({ results }) }),
        fail: (status) => resolve({ ok: false, status, json: async () => ({ error: "x" }) }),
      });
    });
  });
  return { fetchMock, requests };
}

const hit = (title: string): SearchHit => ({ id: `00000000-0000-4000-8000-${String(title.length).padStart(12, "0")}`, kind: "note", title, snippet: `${title} の本文`, updatedAt: new Date(0).toISOString(), tab: null });

let root: Root | null = null;
let container: HTMLElement | null = null;

/** 今の状態を DOM に書き出す（テストは描画の結果だけを読む）。 */
function Harness({ query }: { query: string }) {
  const state = usePageSearch(query);
  return <output>{JSON.stringify(state)}</output>;
}

/** 最後に描画した状態。 */
function current(): PageSearchState | null {
  const text = container?.querySelector("output")?.textContent;
  return text ? (JSON.parse(text) as PageSearchState) : null;
}

async function render(query: string) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => root!.render(<Harness query={query} />));
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("usePageSearch", () => {
  it("does not request anything for an empty or blank query", async () => {
    const { fetchMock } = fakeFetch();
    vi.stubGlobal("fetch", fetchMock);
    await render("");
    expect(current()).toMatchObject({ status: "idle", results: [], error: null });
    await render("  　 ");
    await advance(1000);
    expect(current()?.status).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits 150 ms after the last keystroke and sends one request for the latest query", async () => {
    const { fetchMock, requests } = fakeFetch();
    vi.stubGlobal("fetch", fetchMock);
    await render("q");
    expect(current()?.status).toBe("loading");
    await advance(100);
    await render("qu");
    await advance(100);
    await render(" quo  kka ");
    await advance(SEARCH_DEBOUNCE_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requests[0]?.url.pathname).toBe("/api/search");
    expect(requests[0]?.url.searchParams.get("q")).toBe("quo kka");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });

    await act(async () => requests[0]!.resolve([hit("quokka")]));
    expect(current()).toMatchObject({ status: "ready", results: [hit("quokka")], error: null });
  });

  it("aborts the request of an older query and ignores its late answer", async () => {
    const { fetchMock, requests } = fakeFetch();
    vi.stubGlobal("fetch", fetchMock);
    await render("a");
    await advance(SEARCH_DEBOUNCE_MS);
    expect(requests).toHaveLength(1);
    const first = requests[0]!;

    await render("ab");
    expect(first.signal.aborted).toBe(true);
    await act(async () => first.resolve([hit("old")]));
    expect(current()?.status).toBe("loading");
    expect(current()?.results).toEqual([]);

    await advance(SEARCH_DEBOUNCE_MS);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url.searchParams.get("q")).toBe("ab");
    await act(async () => requests[1]!.resolve([hit("abc")]));
    expect(current()).toMatchObject({ status: "ready", results: [hit("abc")] });

    // 次の語の結果が来るまでは前の結果を出したまま
    await render("abc");
    expect(current()).toMatchObject({ status: "loading", results: [hit("abc")] });
  });

  it("aborts the request in flight when unmounted", async () => {
    const { fetchMock, requests } = fakeFetch();
    vi.stubGlobal("fetch", fetchMock);
    await render("a");
    await advance(SEARCH_DEBOUNCE_MS);
    await act(async () => root?.unmount());
    root = null;
    expect(requests[0]?.signal.aborted).toBe(true);
  });

  it("reports errors and does not send a query longer than 100 characters", async () => {
    const { fetchMock, requests } = fakeFetch();
    vi.stubGlobal("fetch", fetchMock);
    await render("a".repeat(101));
    await advance(1000);
    expect(current()).toMatchObject({ status: "error", error: "too_long", results: [] });
    expect(fetchMock).not.toHaveBeenCalled();

    await render("a");
    await advance(SEARCH_DEBOUNCE_MS);
    await act(async () => requests[0]!.fail(503));
    expect(current()).toMatchObject({ status: "error", error: "unavailable", results: [] });

    await render("b");
    await advance(SEARCH_DEBOUNCE_MS);
    await act(async () => requests[1]!.fail(401));
    expect(current()).toMatchObject({ status: "error", error: "unauthorized" });

    await render("c");
    await advance(SEARCH_DEBOUNCE_MS);
    await act(async () => requests[2]!.resolve([{ id: 1 } as unknown as SearchHit]));
    expect(current(), "a malformed answer is an error").toMatchObject({ status: "error", error: "failed" });
  });
});
