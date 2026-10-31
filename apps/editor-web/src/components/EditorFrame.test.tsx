// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageSummary } from "@niho/editor-store";
import { IDBFactory } from "fake-indexeddb";
import { createIndexedDbDraftStorage } from "@/lib/drafts";
import { SAVE_STATUS_TEXT, type SaveStatus } from "@/lib/save-status";
import { isMacPlatform } from "@/lib/use-search-shortcut";
import { COPIED_NOTE_MS } from "./ShareSheet";
import { EditorFrame, useEditorFrame, type AttachedPage, type FrameInitial } from "./EditorFrame";
import { COUNT_DELAY_MS } from "./InfoPanel";
import { LANG_NOT_SAVED, PageEditor } from "./PageEditor";

// 公開のシートの読み込み（#39）は PagePublish.test.tsx で本物の fetch の形で確かめる。ここでは、ページを開くたびに出る読み込みが
// fetch の呼び出しの順や回数（複製・削除・書き出しの検査）を乱さないよう、読めなかったことにする
vi.mock("@/lib/publish-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/publish-client")>()),
  loadPublishSheet: vi.fn(async () => ({ ok: false as const, retryable: true, message: "合成: 読み込まない" })),
}));

const nav = vi.hoisted(() => ({ pathname: "/", search: "", push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: nav.refresh }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

/** jsdom に無い IntersectionObserver の代わり。callback を手で呼んで「末尾が見えた」にする。 */
const observers: { callback: IntersectionObserverCallback; disconnected: boolean }[] = [];
class FakeIntersectionObserver {
  readonly entry: { callback: IntersectionObserverCallback; disconnected: boolean };
  constructor(callback: IntersectionObserverCallback) {
    this.entry = { callback, disconnected: false };
    observers.push(this.entry);
  }
  observe() {}
  disconnect() {
    this.entry.disconnected = true;
  }
}

let narrow = false;
let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom に無い描画の API（本物の PageEditor を枠に入れるテストで、ProseMirror と浮かぶメニューが読む）
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  Range.prototype.getBoundingClientRect = rect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Element.prototype.scrollIntoView = () => undefined;
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  window.matchMedia = ((query: string) => ({ matches: narrow, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  nav.pathname = "/";
  nav.search = "";
  narrow = false;
  observers.length = 0;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

const NOW = Date.parse("2026-10-31T03:00:00.000Z");

function page(id: string, title = id): PageSummary {
  return { id, kind: "note", title, lang: "ja", parent: null, stepStatus: null, sortOrder: 0, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-31T02:00:00.000Z", publication: null };
}

let mounted: FrameInitial | null = null;

async function mount(initial: Partial<FrameInitial> = {}, children: ReactNode = <p>合成の中身</p>) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mounted = { pages: [], next: null, recent: [], now: NOW, me: { name: "開発ユーザー", caption: "stub", initial: "開" }, initialNarrow: false, ...initial };
  await rerender(children);
  return container;
}

/** 同じ枠のまま中身（ページ）だけを替える（一覧などの枠の状態は残る）。 */
async function rerender(children: ReactNode) {
  await act(async () => root!.render(<EditorFrame initial={mounted!}>{children}</EditorFrame>));
}

/** 同じ枠のまま、nav.pathname・nav.search を替えて描き直す（画面の移動）。 */
async function moveTo(pathname: string, search = "") {
  nav.pathname = pathname;
  nav.search = search;
  await rerender(<p>合成の中身</p>);
}

/** ショートカットを押す（jsdom の platform は Mac ではないので Ctrl）。 */
async function shortcut(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

const PAGE_ID = "00000000-0000-4000-8000-000000000001";
const dialog = () => container!.querySelector<HTMLElement>('[role="dialog"]');
const buttonByText = (text: string, scope: ParentNode = container!) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text);

const rows = () => [...container!.querySelectorAll(".es-sb-list li .es-di-t")].map((node) => node.textContent);
const shell = () => container!.querySelector<HTMLElement>("[data-editor-shell]")!.dataset;
const click = (selector: string) => act(async () => container!.querySelector<HTMLElement>(selector)!.click());
const intersect = () => act(async () => observers.filter((entry) => !entry.disconnected).at(-1)!.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));

function chunkResponse(pages: PageSummary[], next: string | null): Response {
  return new Response(JSON.stringify({ pages, next }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("EditorFrame", () => {
  it("loads the next chunk when the end of the list comes near, one request at a time, deduped, until next is null", async () => {
    let release: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await mount({ pages: [page("a"), page("b")], next: "cursor-1" });
      expect(rows()).toEqual(["a", "b"]);
      await intersect();
      await intersect();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/pages?limit=100&cursor=cursor-1");
      await act(async () => release(chunkResponse([page("b"), page("c")], "cursor-2")));
      expect(rows()).toEqual(["a", "b", "c"]);

      await intersect();
      expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/pages?limit=100&cursor=cursor-2");
      await act(async () => release(chunkResponse([page("d")], null)));
      expect(rows()).toEqual(["a", "b", "c", "d"]);
      expect(observers.every((entry) => entry.disconnected)).toBe(true);
      expect(container!.querySelector('.es-sb-list > [aria-hidden="true"]')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    }
  });

  it("stops after a failed request and tries again on the next intersection", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(chunkResponse([page("b")], null));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await mount({ pages: [page("a")], next: "cursor-1" });
      await intersect();
      expect(rows()).toEqual(["a"]);
      await intersect();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(rows()).toEqual(["a", "b"]);
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    }
  });

  it("moves to a page, a new page, the recording start, and the settings from the sidebar", async () => {
    nav.pathname = "/p/00000000-0000-4000-8000-000000000001";
    await mount({ pages: [page("00000000-0000-4000-8000-000000000001", "合成の題名"), page("00000000-0000-4000-8000-000000000002")] });
    expect(container!.querySelector(".es-ttl")?.textContent).toBe("合成の題名");
    expect(container!.querySelector('[aria-current="page"]')?.textContent).toContain("合成の題名");

    await act(async () => container!.querySelectorAll<HTMLButtonElement>(".es-sb-list li button")[1]!.click());
    expect(nav.push).toHaveBeenLastCalledWith("/p/00000000-0000-4000-8000-000000000002");

    await click('button[aria-label="新しいページ"]');
    await act(async () => [...container!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.includes("空のページ"))!.click());
    expect(nav.push).toHaveBeenLastCalledWith("/p/new");
    expect(container!.querySelector('[role="menu"]')).toBeNull();
    await click('button[aria-label="新しいページ"]');
    await act(async () => [...container!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.includes("録音から"))!.click());
    expect(nav.push).toHaveBeenLastCalledWith("/p/new?from=recording");

    await click(".es-sb-me");
    const items = [...container!.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')];
    // 左下は「設定」。本人の名前は「役割とつながり」の行に出る（#37 T9）
    expect(container!.querySelector(".es-sb-me")?.textContent).toContain("設定");
    expect(container!.querySelector(".es-sb-me")?.textContent).not.toContain("開発ユーザー");
    expect(items.map((item) => item.textContent)).toEqual(["発信先", "開発ユーザー役割とつながり", "設定", "ログアウト"]);
    await act(async () => items[2]!.click());
    expect(nav.push).toHaveBeenLastCalledWith("/settings");

    // デスクトップ: 一覧をしまうとヘッダーの左に「一覧を出す」
    await click('button[aria-label="一覧をしまう"]');
    expect(shell().sidebar).toBe("closed");
    await click('button[aria-label="一覧を出す"]');
    expect(shell().sidebar).toBe("open");
  });

  describe("search (#35)", () => {
    const hit = (id: string, title: string, snippet: string) => ({ id, kind: "note", title, snippet, updatedAt: "2026-10-31T02:30:00.000Z" });
    const searchResponse = (results: unknown[], status = 200): Response =>
      new Response(JSON.stringify(status === 200 ? { results } : { error: "unavailable" }), { status, headers: { "content-type": "application/json" } });
    const type = async (value: string) => {
      const input = container!.querySelector<HTMLInputElement>('input[type="search"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      // usePageSearch の待ち（150ms）と、その応答
      await act(async () => new Promise((resolve) => setTimeout(resolve, 260)));
    };
    const pressK = (init: KeyboardEventInit = { ctrlKey: true }) => act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true, ...init })));
    const note = () => container!.querySelector(".es-sb-list [role=\"status\"]")?.textContent;
    const searchInput = () => container!.querySelector<HTMLInputElement>('[role="search"] input[type="search"]');

    afterEach(() => vi.unstubAllGlobals());

    it("searches the server (title and body) while typing and shows the matched sentence; the plain list returns when the query is cleared", async () => {
      const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => searchResponse([hit("h1", "鎌倉の朝", "…江ノ電の音で目が覚めた…"), hit("h2", "メモ", "朝の散歩の前に")]));
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
      await mount({ pages: [page("a", "日記"), page("b", "録音")], next: "cursor-1" });
      expect(rows()).toEqual(["日記", "録音"]);
      expect(container!.querySelector('.es-sb-list [aria-hidden="true"]')).not.toBeNull();

      await click('button[aria-label="探す"]');
      await type("朝");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toMatch(/^\/api\/search\?q=/);
      expect(rows()).toEqual(["鎌倉の朝", "メモ"]);
      expect([...container!.querySelectorAll(".es-sb-list .es-di-sub")].map((node) => node.textContent)).toEqual(["…江ノ電の音で目が覚めた…", "朝の散歩の前に"]);
      expect(note()).toBe("2 件");
      // 検索中は続きを読まない
      expect(container!.querySelector('.es-sb-list [aria-hidden="true"]')).toBeNull();

      await type("");
      expect(rows()).toEqual(["日記", "録音"]);
      expect(note()).toBeUndefined();
      expect(container!.querySelector('.es-sb-list [aria-hidden="true"]')).not.toBeNull();
    });

    it("says so when nothing is found, and when the search fails", async () => {
      const fetchMock = vi.fn<(url: string) => Promise<Response>>().mockResolvedValueOnce(searchResponse([])).mockResolvedValueOnce(searchResponse([], 503));
      vi.stubGlobal("fetch", fetchMock);
      await mount({ pages: [page("a", "日記")] });
      await click('button[aria-label="探す"]');
      await type("ない");
      expect(rows()).toEqual([]);
      expect(note()).toBe("見つかりませんでした");
      await type("ない2");
      expect(note()).toBe("いま検索できません。しばらくしてからもう一度");
    });

    it("opens and focuses the search with the keyboard (Ctrl+K here; ⌘K on a Mac), also when it is already open", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => searchResponse([])));
      await mount({ pages: [page("a", "日記")] });
      expect(searchInput()).toBeNull();
      await pressK();
      expect(searchInput()).not.toBeNull();
      expect(document.activeElement).toBe(searchInput());

      await act(async () => searchInput()!.blur());
      expect(document.activeElement).not.toBe(searchInput());
      await pressK();
      expect(document.activeElement).toBe(searchInput());
      // 他の組み合わせでは開かない
      await click('button[aria-label="やめる"]');
      await pressK({ ctrlKey: true, shiftKey: true });
      await pressK({ metaKey: true });
      expect(searchInput()).toBeNull();
    });

    it("shows a folded list first: desktop (list closed) and narrow (page open)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => searchResponse([])));
      await mount({ pages: [page("a", "日記")] });
      await click('button[aria-label="一覧をしまう"]');
      expect(shell().sidebar).toBe("closed");
      await pressK();
      expect(shell().sidebar).toBe("open");
      expect(document.activeElement).toBe(searchInput());
      await act(async () => root!.unmount());

      narrow = true;
      nav.pathname = "/p/00000000-0000-4000-8000-000000000001";
      await mount({ pages: [page("00000000-0000-4000-8000-000000000001", "合成の題名")], initialNarrow: true });
      expect(shell().view).toBe("page");
      await pressK();
      expect(shell().view).toBe("list");
      expect(document.activeElement).toBe(searchInput());
    });
  });

  it("narrow: / is the list, a page is full screen with a list button, and picking the current row closes the list", async () => {
    narrow = true;
    await mount({ pages: [page("00000000-0000-4000-8000-000000000001", "合成の題名")], initialNarrow: true });
    expect(shell().view).toBe("list");
    expect(container!.querySelector('button[aria-label="一覧をしまう"]')).toBeNull();
    await act(async () => root!.unmount());

    nav.pathname = "/p/00000000-0000-4000-8000-000000000001";
    await mount({ pages: [page("00000000-0000-4000-8000-000000000001", "合成の題名")], initialNarrow: true });
    expect(shell().view).toBe("page");
    await click('button[aria-label="一覧を出す"]');
    expect(shell().view).toBe("list");
    await click('[aria-current="page"]');
    expect(shell().view).toBe("page");
    expect(nav.push).not.toHaveBeenCalled();

    nav.pathname = "/settings";
    await act(async () => root!.render(<EditorFrame initial={{ pages: [], next: null, recent: [], now: NOW, me: { name: "x", caption: "", initial: "x" }, initialNarrow: true }}>{null}</EditorFrame>));
    expect(container!.querySelector(".es-ttl")?.textContent).toBe("設定");
    expect(container!.querySelector(".es-dt--plain")).not.toBeNull();
  });

  it("⌘N (Ctrl+N) opens a blank new page like the menu, once until it gets there, and not again on the new page", async () => {
    nav.pathname = `/p/${PAGE_ID}`;
    await mount({ pages: [page(PAGE_ID, "合成の題名")] });
    const first = await shortcut("n");
    expect(first.defaultPrevented).toBe(true);
    expect(nav.push).toHaveBeenCalledWith("/p/new");
    await shortcut("n");
    expect(nav.push).toHaveBeenCalledTimes(1);

    // 新しいページ（作っている途中を含む）では作り直さない。録音からの画面からは新しいページへ
    await moveTo("/p/new");
    await shortcut("n");
    expect(nav.push).toHaveBeenCalledTimes(1);
    await moveTo("/p/new", "from=recording");
    await shortcut("n");
    expect(nav.push).toHaveBeenCalledTimes(2);

    // 移ったあと、もとのページに戻れば、また押せる
    await moveTo(`/p/${PAGE_ID}`);
    await shortcut("n");
    expect(nav.push).toHaveBeenCalledTimes(3);
    // ⇧・⌥ 付き、IME の変換中は対象にしない
    await shortcut("N", { shiftKey: true });
    await shortcut("n", { altKey: true });
    await moveTo("/settings");
    await shortcut("n", { isComposing: true });
    expect(nav.push).toHaveBeenCalledTimes(3);
  });

  it("⌘K (Ctrl+K) brings the list back and focuses the search field, also when the search is already open", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } })));
    await mount({ pages: [page("a", "NIHO 録音"), page("b", "日記")] });
    await click('button[aria-label="一覧をしまう"]');
    expect(shell().sidebar).toBe("closed");
    const event = await shortcut("k");
    expect(event.defaultPrevented).toBe(true);
    expect(shell().sidebar).toBe("open");
    const input = container!.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(document.activeElement).toBe(input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "日記");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.blur());
    await shortcut("k");
    // 開いていた検索の入力を残したまま、もう一度フォーカスする（検索の結果はサーバーが返す。ここでは絞り込まない）
    const again = container!.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(document.activeElement).toBe(again);
    expect(again.value).toBe("日記");
    vi.unstubAllGlobals();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });

  it("narrow: ⌘K on a page shows the list screen with the search field focused", async () => {
    narrow = true;
    nav.pathname = `/p/${PAGE_ID}`;
    await mount({ pages: [page(PAGE_ID, "合成の題名")], initialNarrow: true });
    expect(shell().view).toBe("page");
    await shortcut("k");
    expect(shell().view).toBe("list");
    expect(document.activeElement).toBe(container!.querySelector('input[type="search"]'));
  });

  it("⌘⇧P and the header's 公開 open the publish sheet on a page only, and Esc closes it back to where it was opened", async () => {
    await mount({ pages: [page(PAGE_ID, "合成の題名")] });
    // 一覧・設定・新しいページ・録音からでは出さず、キーはブラウザに任せる
    for (const [path, search] of [["/", ""], ["/settings", ""], ["/p/new", ""], ["/p/new", "from=recording"]] as const) {
      await moveTo(path, search);
      expect(buttonByText("公開"), path).toBeUndefined();
      const ignored = await shortcut("P", { shiftKey: true });
      expect(ignored.defaultPrevented, path).toBe(false);
      expect(dialog(), path).toBeNull();
    }

    await moveTo(`/p/${PAGE_ID}`);
    const opener = buttonByText("公開")!;
    await act(async () => opener.focus());
    const event = await shortcut("P", { shiftKey: true }, opener);
    expect(event.defaultPrevented).toBe(true);
    expect(dialog()?.getAttribute("aria-label")).toBe("公開");
    expect(container!.querySelector(".es-root")!.contains(dialog())).toBe(true);
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);

    await act(async () => opener.click());
    expect(dialog()?.getAttribute("aria-label")).toBe("公開");
    // 開いているあいだ、⌘N・⌘K は使わない
    await shortcut("n");
    await shortcut("k");
    expect(nav.push).not.toHaveBeenCalled();
    expect(container!.querySelector('input[type="search"]')).toBeNull();
    // 別の画面へ移ったら閉じる
    await moveTo("/settings");
    await moveTo(`/p/${PAGE_ID}`);
    expect(dialog()).toBeNull();
  });

  it("narrow: ⌘⇧P does nothing while the list is shown over the page", async () => {
    narrow = true;
    nav.pathname = `/p/${PAGE_ID}`;
    await mount({ pages: [page(PAGE_ID, "合成の題名")], initialNarrow: true });
    await click('button[aria-label="一覧を出す"]');
    expect(shell().view).toBe("list");
    expect((await shortcut("P", { shiftKey: true })).defaultPrevented).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("a page opens the publish sheet through useEditorFrame().openPublish", async () => {
    function OpenFromPage() {
      const { openPublish } = useEditorFrame();
      return (
        <button type="button" onClick={openPublish}>
          ページから公開
        </button>
      );
    }
    nav.pathname = `/p/${PAGE_ID}`;
    await mount({ pages: [page(PAGE_ID, "合成の題名")] }, <OpenFromPage />);
    await act(async () => buttonByText("ページから公開")!.click());
    expect(dialog()?.getAttribute("aria-label")).toBe("公開");
  });

  describe("手順のサブページ（#37 の stepPagesChanged）", () => {
    const REC = "00000000-0000-4000-8000-0000000000aa";
    const STEP_1 = "00000000-0000-4000-8000-0000000000b1";
    const STEP_2 = "00000000-0000-4000-8000-0000000000b2";
    type Step = { id: string; title: string; stepStatus: "done" | "run" | "wait" | "stale" | "failed" | null };
    let send: (parentId: string, steps: Step[]) => void = () => undefined;

    function FromBand() {
      const { stepPagesChanged } = useEditorFrame();
      send = stepPagesChanged;
      return <p>合成の中身</p>;
    }

    const recording = (): PageSummary => ({ ...page(REC, "録音"), kind: "rec" });

    it("まだ一覧に無いサブページを、親の下に段階の順で足す", async () => {
      await mount({ pages: [recording()] }, <FromBand />);
      await act(async () =>
        send(REC, [
          { id: STEP_1, title: "文字起こし修正", stepStatus: "done" },
          { id: STEP_2, title: "記事方針", stepStatus: "run" },
        ]),
      );
      expect(rows()).toEqual(["録音", "文字起こし修正", "記事方針"]);
      // 済みの段階は 2 行目を出さず、作成中の段階は言葉（と回るマーク）を出す
      expect([...container!.querySelectorAll(".es-sb-list .es-di-sub")].map((node) => node.textContent)).toEqual(["録音", "作成中…"]);
      expect(container!.querySelectorAll(".es-sb-list .es-busy")).toHaveLength(1);
    });

    it("サブページがゴミ箱に入っている段階（stepStatus が null）の行は作らない", async () => {
      await mount({ pages: [recording()] }, <FromBand />);
      await act(async () =>
        send(REC, [
          { id: STEP_1, title: "文字起こし修正", stepStatus: "done" },
          // 実行の記録（attempt）は残るので run から届くが、押しても 404 のページへ行くだけ
          { id: STEP_2, title: "記事方針", stepStatus: null },
        ]),
      );
      expect(rows()).toEqual(["録音", "文字起こし修正"]);
    });

    it("同じ知らせを繰り返しても、行は増えず、状態だけが替わる", async () => {
      await mount({ pages: [recording()] }, <FromBand />);
      const run: Step[] = [{ id: STEP_1, title: "文字起こし修正", stepStatus: "run" }];
      await act(async () => send(REC, run));
      await act(async () => send(REC, run));
      expect(rows()).toEqual(["録音", "文字起こし修正"]);
      expect([...container!.querySelectorAll(".es-sb-list .es-di-sub")].map((node) => node.textContent)).toEqual(["録音", "作成中…"]);
      await act(async () => send(REC, [{ id: STEP_1, title: "文字起こし修正", stepStatus: "done" }]));
      expect(rows()).toEqual(["録音", "文字起こし修正"]);
      expect([...container!.querySelectorAll(".es-sb-list .es-di-sub")].map((node) => node.textContent)).toEqual(["録音"]);
    });
  });
});

describe("EditorFrame: the header's state and the … menu (#34)", () => {
  const A = "00000000-0000-4000-8000-00000000000a";
  const B = "00000000-0000-4000-8000-00000000000b";
  const C = "00000000-0000-4000-8000-00000000000c";
  const D = "00000000-0000-4000-8000-00000000000d";
  const COPY = "00000000-0000-4000-8000-0000000000c0";
  const UPDATED_AT = "2026-10-31T02:00:00.000Z";

  /** ページの中の PageEditor の代わり。渡した状態のまま枠に登録する。 */
  function FakePage({ page: attached }: { page: AttachedPage }) {
    const { attachPage } = useEditorFrame();
    useEffect(() => attachPage(attached), [attachPage, attached]);
    return <p>合成の本文</p>;
  }
  function fakePage(id: string | null, over: Partial<AttachedPage> = {}): AttachedPage {
    return {
      id,
      status: "saved",
      flush: vi.fn(async () => true),
      revision: () => 1,
      reopen: vi.fn(),
      shared: null,
      setShared: vi.fn(),
      lang: "ja",
      setLang: vi.fn(),
      langNote: null,
      text: { read: () => "", subscribe: () => () => undefined },
      ...over,
    };
  }
  function deferred<T>() {
    let resolve: (value: T) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<T>((ok, ng) => {
      resolve = ok;
      reject = ng;
    });
    return { promise, resolve, reject };
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  // 状態の丸は公開中だけ出す（#37 T9）。非公開のときは、保存の状態を読み上げる見えない live region が同じ文を持つ
  const tip = () => (container!.querySelector(".es-dt .es-st-tip") ?? container!.querySelector(".es-dt .es-st-wrap--quiet"))?.textContent;
  const dot = () => container!.querySelector(".es-dt .es-st");
  const moreButton = () => container!.querySelector<HTMLButtonElement>('.es-dt button[aria-label="その他"]');
  const menu = () => container!.querySelector<HTMLElement>('[role="menu"][aria-label="その他"]');
  const menuItems = () => [...(menu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
  const headerAlert = () => container!.querySelector(".es-dt [role=\"alert\"]")?.textContent;
  const dialog = () => container!.querySelector<HTMLElement>('[role="dialog"]');
  const dialogAlert = () => dialog()?.querySelector('[role="alert"]')?.textContent;
  const dialogButton = (label: string) => [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent === label)!;
  const press = (target: Element, key: string) => act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
  const tick = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  async function choose(label: string) {
    await act(async () => moreButton()!.click());
    await act(async () => menuItems().find((item) => item.textContent?.startsWith(label))!.click());
    await tick();
  }
  // 情報パネル（#34 第 3 段）
  const railButton = () => container!.querySelector<HTMLButtonElement>('.es-dt button[aria-label="このページの設定と AI"]');
  const rail = () => container!.querySelector<HTMLElement>("#es-rail");
  const inRail = (label: string) => [...(rail()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent?.trim() === label);
  const pressedLang = () => [...(rail()?.querySelectorAll('button[aria-pressed="true"]') ?? [])].map((button) => button.textContent);
  const railAlert = () => rail()?.querySelector('[role="alert"]')?.textContent;
  const infoRows = () => [...(rail()?.querySelectorAll(".es-kv > div") ?? [])].map((row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent]);
  /** 端末の日付（YYYY-MM-DD。情報パネルの作成・更新の期待値）。 */
  const localDay = (iso: string) => {
    const date = new Date(iso);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const openRail = () => act(async () => railButton()!.click());

  beforeEach(() => {
    nav.pathname = `/p/${A}`;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.restoreAllMocks();
  });

  it("shows the open page's save state as 「自分だけ」 (no publish state; the 公開 button is the frame's, #43), and nothing outside a page", async () => {
    const a = fakePage(A);
    await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={a} />);
    // 非公開のページには丸を出さない（公開ボタンの文言で分かる）。文は読み上げのための live region に残る
    expect(dot()).toBeNull();
    expect(tip()).toBe("自分だけ · 保存済み");
    expect(container!.querySelector(".es-dt .es-st-wrap")?.getAttribute("aria-live")).toBe("polite");
    // 公開ボタンは枠（#43）が出す。公開のシートが読めていない（この suite では読み込みを無効にしている）間は、丸は「自分だけ」
    expect(container!.querySelector(".es-pubbtn")).not.toBeNull();

    await rerender(<FakePage page={{ ...a, status: "saving" }} />);
    expect(tip()).toBe("自分だけ · 保存中");
    await rerender(<FakePage page={{ ...a, status: "offline" }} />);
    expect(tip()).toBe("自分だけ · オフライン・この端末に保持");
    for (const status of ["error", "conflict", "signedOut"] as SaveStatus[]) {
      await rerender(<FakePage page={{ ...a, status }} />);
      expect(tip()).toBe(`自分だけ · ${SAVE_STATUS_TEXT[status]}`);
      // 公開していないので丸は出さない（出すのは公開中・限定公開・更新ありだけ）
      expect(dot()).toBeNull();
    }

    // ページを離れたら（設定）、状態も「…」も出さない
    nav.pathname = "/settings";
    await rerender(null);
    expect(dot()).toBeNull();
    expect(moreButton()).toBeNull();
  });

  it("opens and closes the … menu with リンクで共有, 書き出し (.md), 履歴, 複製 and 削除, moved by the keyboard; none for a page not created yet", async () => {
    await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A)} />);
    expect(moreButton()?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => moreButton()!.click());
    expect(moreButton()?.getAttribute("aria-expanded")).toBe("true");
    // Google ドキュメントは出さない。共有しているか分からないときは「共有中」を出さない
    expect(menuItems().map((item) => item.textContent)).toEqual(["リンクで共有", "書き出し.md", "履歴", "複製", "削除"]);
    const [shareItem, exportItem, , , deleteItem] = menuItems();
    expect(document.activeElement).toBe(shareItem);
    await press(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(exportItem);
    await press(document.activeElement!, "End");
    expect(document.activeElement).toBe(deleteItem);
    await press(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(shareItem);
    await press(document.activeElement!, "Escape");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(moreButton());
    await act(async () => moreButton()!.click());
    await act(async () => moreButton()!.click());
    expect(menu()).toBeNull();

    // まだ作っていない新しいページ（/p/new）: 状態は出し、「…」は出さない
    nav.pathname = "/p/new";
    await rerender(<FakePage page={fakePage(null)} />);
    expect(tip()).toBe("自分だけ · 保存済み");
    expect(moreButton()).toBeNull();
  });

  it("duplicate: saves first, then POSTs, puts the copy on top of the list and moves to it", async () => {
    const calls: string[] = [];
    const a = fakePage(A, { flush: vi.fn(async () => (calls.push("flush"), true)) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(`${init.method} ${url}`);
        return json(201, { page: { id: COPY, kind: "note", title: "合成の題名のコピー", lang: "ja", blocks: [], parent: null, createdAt: UPDATED_AT, updatedAt: UPDATED_AT } });
      }),
    );
    await mount({ pages: [page(A, "合成の題名"), page(D, "別のページ")] }, <FakePage page={a} />);
    await choose("複製");
    expect(calls).toEqual(["flush", `POST /api/pages/${A}/duplicate`]);
    expect(rows()).toEqual(["合成の題名のコピー", "合成の題名", "別のページ"]);
    expect(nav.push).toHaveBeenCalledWith(`/p/${COPY}`);
    expect(document.activeElement).toBe(moreButton());
    expect(headerAlert()).toBeUndefined();
  });

  it("duplicate: a failure says so next to …, stays on the page, and the note goes when the menu opens again", async () => {
    const fetchMock = vi.fn(async () => json(500, { error: "internal" })).mockResolvedValueOnce(json(500, { error: "internal" })).mockResolvedValueOnce(json(401, { error: "unauthorized" }));
    vi.stubGlobal("fetch", fetchMock);
    await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A)} />);
    await choose("複製");
    expect(headerAlert()).toBe("複製できませんでした");
    expect(rows()).toEqual(["合成の題名"]);
    expect(nav.push).not.toHaveBeenCalled();
    await act(async () => moreButton()!.click());
    expect(headerAlert()).toBeUndefined();
    await act(async () => menuItems().find((item) => item.textContent === "複製")!.click());
    await tick();
    expect(headerAlert()).toBe("ログインし直してください");
  });

  it("does one action at a time on a page: a second 複製 while the first is saving is not sent", async () => {
    const saving = deferred<boolean>();
    const flush = vi.fn(() => saving.promise);
    const fetchMock = vi.fn(async () => json(201, { page: { id: COPY, title: "合成の題名のコピー", kind: "note" } }));
    vi.stubGlobal("fetch", fetchMock);
    await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A, { flush })} />);
    await choose("複製");
    await choose("複製");
    expect(flush).toHaveBeenCalledTimes(1);
    await act(async () => saving.resolve(true));
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(nav.push).toHaveBeenCalledTimes(1);
  });

  it("export: saves first, then clicks a same-origin download link to export.md (the body is not fetched)", async () => {
    const calls: string[] = [];
    const links: Array<{ href: string | null; download: string | null; connected: boolean }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      calls.push("click");
      links.push({ href: this.getAttribute("href"), download: this.getAttribute("download"), connected: this.isConnected });
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A, { flush: vi.fn(async () => (calls.push("flush"), true)) })} />);
    await choose("書き出し");
    expect(calls).toEqual(["flush", "click"]);
    expect(links).toEqual([{ href: `/api/pages/${A}/export.md`, download: "", connected: true }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("stops every action when the unsaved edits cannot be saved, and says why (nothing is sent, the list stays)", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A, { status: "offline", flush: vi.fn(async () => false) })} />);
    await choose("書き出し");
    expect(headerAlert()).toBe("書き出しの前に変更を保存できませんでした");
    expect(click).not.toHaveBeenCalled();
    await choose("複製");
    expect(headerAlert()).toBe("複製の前に変更を保存できませんでした");
    await choose("削除");
    await act(async () => dialogButton("削除する").click());
    await tick();
    expect(dialogAlert()).toBe("削除の前に変更を保存できませんでした");
    expect(dialog()).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows()).toEqual(["合成の題名"]);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("delete: asks first, then saves and DELETEs, takes the page and its loaded subpages out of the list, and goes to /", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(`${init.method} ${url}`);
        return new Response(null, { status: 204 });
      }),
    );
    const pages = [{ ...page(C, "手順の結果"), parent: A }, page(A, "合成の題名"), page(D, "別のページ")];
    await mount({ pages }, <FakePage page={fakePage(A, { flush: vi.fn(async () => (calls.push("flush"), true)) })} />);
    expect(rows()).toEqual(["合成の題名", "手順の結果", "別のページ"]);
    await choose("削除");
    // 確認だけでは何も送らない
    expect(calls).toEqual([]);
    expect(dialog()?.getAttribute("aria-label")).toBe("ページの削除");
    expect(dialog()?.getAttribute("aria-modal")).toBe("true");
    expect(dialog()?.querySelector("h2")?.textContent).toBe("このページを削除しますか？");
    expect(dialog()?.textContent).toContain("ゴミ箱に 30 日残ります。");
    expect(document.activeElement).toBe(dialogButton("やめる"));
    expect(container!.querySelector(".es-ws")?.hasAttribute("inert")).toBe(true);

    await act(async () => dialogButton("削除する").click());
    await tick();
    expect(calls).toEqual(["flush", `DELETE /api/pages/${A}`]);
    expect(dialog()).toBeNull();
    expect(rows()).toEqual(["別のページ"]);
    expect(nav.push).toHaveBeenCalledWith("/");
  });

  it("delete: sends once while waiting (Esc and やめる do not close it then), and a refusal stays in the dialog with the list unchanged", async () => {
    const answers = [deferred<Response>(), deferred<Response>(), deferred<Response>(), deferred<Response>()];
    let call = 0;
    const fetchMock = vi.fn(() => answers[call++]!.promise);
    vi.stubGlobal("fetch", fetchMock);
    await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A)} />);
    await choose("削除");
    await act(async () => dialogButton("削除する").click());
    await tick();
    await act(async () => dialogButton("削除する").click());
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dialogButton("削除する").getAttribute("aria-disabled")).toBe("true");
    await press(document.activeElement!, "Escape");
    await act(async () => dialogButton("やめる").click());
    expect(dialog()).not.toBeNull();

    // 公開中のページは消さない（設計 §12）
    await act(async () => answers[0]!.resolve(json(409, { error: "published" })));
    await tick();
    expect(dialogAlert()).toBe("公開中のページは、先に公開をやめてください");
    expect(dialogButton("削除する").getAttribute("aria-disabled")).toBeNull();
    expect(rows()).toEqual(["合成の題名"]);
    expect(nav.push).not.toHaveBeenCalled();

    await act(async () => dialogButton("削除する").click());
    await act(async () => answers[1]!.resolve(json(500, { error: "internal" })));
    await tick();
    expect(dialogAlert()).toBe("削除できませんでした");
    await act(async () => dialogButton("削除する").click());
    await act(async () => answers[2]!.reject(new TypeError("Failed to fetch")));
    await tick();
    expect(dialogAlert()).toBe("削除できませんでした");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // やめる: 閉じて「…」へフォーカスが戻り、外の inert も外れる
    await act(async () => dialogButton("やめる").click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(moreButton());
    expect(container!.querySelector(".es-ws")?.hasAttribute("inert")).toBe(false);
    expect(rows()).toEqual(["合成の題名"]);

    // Esc でも閉じる
    await choose("削除");
    await press(document.activeElement!, "Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(moreButton());
  });

  it("delete: also takes the page out of the search results on screen", async () => {
    const hit = (id: string, title: string) => ({ id, kind: "note", title, snippet: "朝", updatedAt: UPDATED_AT });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.startsWith("/api/search") ? json(200, { results: [hit(A, "合成の題名"), hit(D, "別のページ")] }) : new Response(null, { status: 204 }))),
    );
    await mount({ pages: [page(A, "合成の題名"), page(D, "別のページ")] }, <FakePage page={fakePage(A)} />);
    await act(async () => container!.querySelector<HTMLButtonElement>('button[aria-label="探す"]')!.click());
    const input = container!.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "朝");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 260)));
    expect(rows()).toEqual(["合成の題名", "別のページ"]);
    await choose("削除");
    await act(async () => dialogButton("削除する").click());
    await tick();
    expect(rows()).toEqual(["別のページ"]);
    expect(container!.querySelector('.es-sb-list [role="status"]')?.textContent).toBe("1 件");
  });

  it("delete: asks the server for the search results again, so a subpage that was never loaded goes too", async () => {
    const E = "00000000-0000-4000-8000-00000000000e";
    const hit = (id: string, title: string) => ({ id, kind: "note", title, snippet: "朝", updatedAt: UPDATED_AT });
    let deleted = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      // サーバーは、削除したページの下のページも削除済み。削除の前の答えには E（読み込んでいない子ページ）が載っている
      return json(200, { results: deleted ? [hit(D, "別のページ")] : [hit(A, "合成の題名"), hit(E, "手順の結果"), hit(D, "別のページ")] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await mount({ pages: [page(A, "合成の題名"), page(D, "別のページ")] }, <FakePage page={fakePage(A)} />);
    await act(async () => container!.querySelector<HTMLButtonElement>('button[aria-label="探す"]')!.click());
    const input = container!.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "朝");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 260)));
    expect(rows()).toEqual(["合成の題名", "手順の結果", "別のページ"]);
    await choose("削除");
    await act(async () => dialogButton("削除する").click());
    await tick();
    // 消したと分かっているページはすぐ外れ、そのあとサーバーの新しい答えで、読み込んでいなかった子ページも外れる
    expect(rows()).toContain("別のページ");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 260)));
    expect(rows()).toEqual(["別のページ"]);
    expect(container!.querySelector('.es-sb-list [role="status"]')?.textContent).toBe("1 件");
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith("/api/search"))).toHaveLength(2);
  });

  it("delete: a page chunk requested before the delete does not bring the page or its subpages back", async () => {
    const E = "00000000-0000-4000-8000-00000000000e";
    const F = "00000000-0000-4000-8000-00000000000f";
    const chunk = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => (init?.method === "DELETE" ? new Response(null, { status: 204 }) : chunk.promise)),
    );
    await mount({ pages: [page(A, "合成の題名"), page(D, "別のページ")], next: "cursor-1" }, <FakePage page={fakePage(A)} />);
    await intersect();
    // 要求の途中で A を削除する
    await choose("削除");
    await act(async () => dialogButton("削除する").click());
    await tick();
    expect(rows()).toEqual(["別のページ"]);
    // 削除の前の一覧が返ってくる: A、A の子 E、E の子 F（子が親より先に並ぶこともある）、関係ない C
    await act(async () =>
      chunk.resolve(chunkResponse([{ ...page(F, "孫"), parent: E }, { ...page(E, "子"), parent: A }, page(A, "合成の題名"), page(C, "関係ないページ")], null)),
    );
    expect(rows()).toEqual(["別のページ", "関係ないページ"]);
  });

  it("acts on the page the … belongs to: after moving to another page, an old result neither moves nor shows there", async () => {
    const answer = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => answer.promise));
    await mount({ pages: [page(A, "合成の題名"), page(B, "次のページ")] }, <FakePage page={fakePage(A)} />);
    await choose("複製");
    nav.pathname = `/p/${B}`;
    const b = fakePage(B);
    await rerender(<FakePage page={b} />);
    await act(async () => answer.resolve(json(201, { page: { id: COPY, title: "合成の題名のコピー", kind: "note" } })));
    await tick();
    // 複製はできているので一覧には足す。移動はしない
    expect(rows()).toEqual(["合成の題名のコピー", "合成の題名", "次のページ"]);
    expect(nav.push).not.toHaveBeenCalled();

    // 失敗も、移った先のページには出さない
    const failing = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => failing.promise));
    await choose("複製");
    nav.pathname = `/p/${A}`;
    await rerender(<FakePage page={fakePage(A)} />);
    await act(async () => failing.resolve(json(500, { error: "internal" })));
    await tick();
    expect(headerAlert()).toBeUndefined();

    // 削除の確認は、そのページを離れたら消える。送った削除の結果は一覧には出すが、移った先から動かない
    const deleting = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => deleting.promise));
    await choose("削除");
    await act(async () => dialogButton("削除する").click());
    await tick();
    nav.pathname = `/p/${B}`;
    await rerender(<FakePage page={b} />);
    expect(dialog()).toBeNull();
    await act(async () => deleting.resolve(new Response(null, { status: 204 })));
    await tick();
    expect(rows()).toEqual(["合成の題名のコピー", "次のページ"]);
    expect(nav.push).not.toHaveBeenCalled();
    // 移った先の「…」はふつうに使える
    await act(async () => moreButton()!.click());
    expect(menuItems()).toHaveLength(5);
  });

  describe("リンクで共有 (#34 第 2 段)", () => {
    // 合成の値（実在の token・origin ではない）
    const LINK = `https://editor.test/s/${"t".repeat(43)}`;
    const LINK_2 = `https://editor.test/s/${"u".repeat(43)}`;
    const PRIVATE = { share: { status: "PRIVATE", publicId: null, url: null, updatedAt: null } };
    const shared = (url: string) => ({ share: { status: "PUBLIC", publicId: "p".repeat(22), url, updatedAt: UPDATED_AT } });
    const sheetStatus = () => dialog()?.querySelector('[role="status"]')?.textContent;
    const linkInput = () => dialog()?.querySelector<HTMLInputElement>("input") ?? null;
    const heading = () => dialog()?.querySelector("h2")?.textContent;
    const sends = (calls: string[], method: string) => calls.filter((call) => call.startsWith(`${method} `));

    afterEach(() => {
      delete (navigator as { clipboard?: unknown }).clipboard;
    });

    it("saves first, says 読み込み中 while reading, offers リンクを作る, sends it once, then shows the link with 共有中", async () => {
      const calls: string[] = [];
      const reading = deferred<Response>();
      const starting = deferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init: RequestInit) => {
          calls.push(`${init.method} ${url}`);
          return init.method === "GET" ? reading.promise : starting.promise;
        }),
      );
      const setShared = vi.fn();
      await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A, { flush: vi.fn(async () => (calls.push("flush"), true)), setShared })} />);
      await choose("リンクで共有");
      expect(calls).toEqual(["flush", `GET /api/pages/${A}/share`]);
      expect(dialog()?.getAttribute("aria-label")).toBe("リンクで共有");
      expect(dialog()?.getAttribute("aria-modal")).toBe("true");
      expect(sheetStatus()).toBe("読み込み中");
      expect(container!.querySelector(".es-ws")?.hasAttribute("inert")).toBe(true);

      await act(async () => reading.resolve(json(200, PRIVATE)));
      await tick();
      expect(setShared).toHaveBeenLastCalledWith(false);
      expect(heading()).toBe("リンクで共有");
      expect(dialog()?.textContent).toContain("リンクを知っている人は、このページを読めます（ログイン不要・読み取り専用）。");
      expect(linkInput()).toBeNull();
      expect(sheetStatus()).toBe("");

      const start = dialogButton("リンクを作る");
      await act(async () => start.click());
      await act(async () => start.click());
      expect(sends(calls, "PUT")).toEqual([`PUT /api/pages/${A}/share`]);
      expect(start.getAttribute("aria-disabled")).toBe("true");

      await act(async () => starting.resolve(json(200, shared(LINK))));
      await tick();
      expect(setShared).toHaveBeenLastCalledWith(true);
      expect(heading()).toBe("リンクで共有中");
      const input = linkInput()!;
      expect(input.readOnly).toBe(true);
      expect(input.value).toBe(LINK);
      expect(dialog()!.querySelector(`label[for="${input.id}"]`)?.textContent).toBe("共有のリンク");
      expect(dialog()?.textContent).toContain("止めるとすぐに読めなくなります。");
      expect(sheetStatus()).toBe("リンクを作りました");
      // 押した「リンクを作る」は無くなったので、フォーカスは「コピー」へ
      expect(document.activeElement).toBe(dialogButton("コピー"));
      expect(dialogAlert()).toBeUndefined();

      await act(async () => dialogButton("閉じる").click());
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(moreButton());
      expect(container!.querySelector(".es-ws")?.hasAttribute("inert")).toBe(false);
    });

    it("shows 共有中 in the … only when the page is known to be shared", async () => {
      vi.stubGlobal("fetch", vi.fn());
      const shareItem = async () => {
        await act(async () => moreButton()!.click());
        const text = menuItems()[0]!.textContent;
        await act(async () => moreButton()!.click());
        return text;
      };
      const a = fakePage(A, { shared: true });
      await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={a} />);
      expect(await shareItem()).toBe("リンクで共有共有中");
      await rerender(<FakePage page={{ ...a, shared: false }} />);
      expect(await shareItem()).toBe("リンクで共有");
      await rerender(<FakePage page={{ ...a, shared: null }} />);
      expect(await shareItem()).toBe("リンクで共有");
    });

    it("copies the link, or selects it and says which key to press when the clipboard cannot be used", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => json(200, shared(LINK))));
      const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A, { shared: true })} />);
      await choose("リンクで共有");
      expect(linkInput()!.value).toBe(LINK);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await act(async () => dialogButton("コピー").click());
        expect(writeText).toHaveBeenCalledWith(LINK);
        expect(sheetStatus()).toBe("コピーしました");
        // 短く出して消す
        await act(async () => {
          await vi.advanceTimersByTimeAsync(COPIED_NOTE_MS);
        });
        expect(sheetStatus()).toBe("");
      } finally {
        vi.useRealTimers();
      }

      const byKey = isMacPlatform() ? "⌘C でコピー" : "Ctrl+C でコピー";
      writeText.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
      await act(async () => dialogButton("コピー").click());
      const input = linkInput()!;
      expect(document.activeElement).toBe(input);
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, LINK.length]);
      expect(sheetStatus()).toBe(byKey);

      // クリップボードが無い（http など）
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      dialogButton("コピー").focus();
      await act(async () => dialogButton("コピー").click());
      expect(document.activeElement).toBe(input);
      expect(sheetStatus()).toBe(byKey);
    });

    it("作り直す asks first (やめる and Esc keep the link), then rotates once; 共有を止める stops and offers リンクを作る again", async () => {
      const calls: string[] = [];
      const rotating = deferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init: RequestInit) => {
          calls.push(`${init.method} ${url}`);
          if (init.method === "GET") return Promise.resolve(json(200, shared(LINK)));
          if (init.method === "POST") return rotating.promise;
          return Promise.resolve(json(200, PRIVATE));
        }),
      );
      const setShared = vi.fn();
      await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A, { shared: true, setShared })} />);
      await choose("リンクで共有");
      const confirmText = "作り直すと、古いリンクは読めなくなります。";

      await act(async () => dialogButton("作り直す").click());
      expect(sends(calls, "POST")).toEqual([]);
      expect(dialog()?.textContent).toContain(confirmText);
      expect(dialog()?.querySelector('[role="group"]')?.getAttribute("aria-labelledby")).toBeTruthy();
      expect(document.activeElement).toBe(dialogButton("やめる"));
      await act(async () => dialogButton("やめる").click());
      expect(dialog()?.textContent).not.toContain(confirmText);
      expect(document.activeElement).toBe(dialogButton("作り直す"));
      // 確かめている間の Esc は、確かめるのをやめるだけ（シートは閉じない）
      await act(async () => dialogButton("作り直す").click());
      await press(document.activeElement!, "Escape");
      expect(dialog()).not.toBeNull();
      expect(dialog()?.textContent).not.toContain(confirmText);
      expect(sends(calls, "POST")).toEqual([]);

      await act(async () => dialogButton("作り直す").click());
      await act(async () => dialogButton("作り直す").click());
      await act(async () => dialogButton("作り直す").click());
      expect(sends(calls, "POST")).toEqual([`POST /api/pages/${A}/share/rotate`]);
      await act(async () => rotating.resolve(json(200, shared(LINK_2))));
      await tick();
      expect(linkInput()!.value).toBe(LINK_2);
      expect(sheetStatus()).toBe("リンクを作り直しました");

      await act(async () => dialogButton("共有を止める").click());
      await tick();
      expect(calls.at(-1)).toBe(`DELETE /api/pages/${A}/share`);
      expect(linkInput()).toBeNull();
      expect(dialog()?.textContent).not.toContain(LINK_2);
      expect(heading()).toBe("リンクで共有");
      expect(sheetStatus()).toBe("共有を止めました");
      expect(setShared).toHaveBeenLastCalledWith(false);
      expect(document.activeElement).toBe(dialogButton("リンクを作る"));
    });

    it("a read failure offers 読み直す; a refused change says so in the sheet and keeps it open", async () => {
      const answers = [json(500, { error: "internal" }), json(200, PRIVATE), json(500, { error: "internal" }), json(401, { error: "unauthorized" })];
      vi.stubGlobal("fetch", vi.fn(async () => answers.shift()!));
      await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A)} />);
      await choose("リンクで共有");
      expect(dialogAlert()).toBe("共有の状態を読み込めませんでした");
      expect(document.activeElement).toBe(dialogButton("読み直す"));
      await act(async () => dialogButton("読み直す").click());
      await tick();
      expect(dialogAlert()).toBeUndefined();
      await act(async () => dialogButton("リンクを作る").click());
      await tick();
      expect(dialogAlert()).toBe("リンクを作れませんでした");
      expect(linkInput()).toBeNull();
      await act(async () => dialogButton("リンクを作る").click());
      await tick();
      expect(dialogAlert()).toBe("ログインし直してください");
      expect(dialog()).not.toBeNull();
    });

    it("can be closed while a change is being sent; opening it again waits for that change and sends no second one", async () => {
      const calls: string[] = [];
      const starting = deferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init: RequestInit) => {
          calls.push(`${init.method} ${url}`);
          return init.method === "GET" ? Promise.resolve(json(200, PRIVATE)) : starting.promise;
        }),
      );
      await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A)} />);
      await choose("リンクで共有");
      await act(async () => dialogButton("リンクを作る").click());
      await act(async () => dialogButton("閉じる").click());
      expect(dialog()).toBeNull();
      await choose("リンクで共有");
      expect(sends(calls, "GET")).toHaveLength(1);
      expect(dialogButton("リンクを作る").getAttribute("aria-disabled")).toBe("true");
      await act(async () => dialogButton("リンクを作る").click());
      expect(sends(calls, "PUT")).toHaveLength(1);
      await act(async () => starting.resolve(json(200, shared(LINK))));
      await tick();
      expect(linkInput()!.value).toBe(LINK);
    });
  });

  describe("履歴 (#34 第 2 段)", () => {
    const VERSIONS = [
      { version: 5, reason: "restore", createdAt: "2026-10-31T02:59:30.000Z", blockCount: 4 },
      { version: 4, reason: "ai", createdAt: "2026-10-31T02:30:00.000Z", blockCount: 1 },
      { version: 3, reason: "overwrite", createdAt: "2026-10-31T00:00:00.000Z", blockCount: 2 },
      { version: 2, reason: "autosave", createdAt: "2026-10-29T01:00:00.000Z", blockCount: 0 },
      { version: 1, reason: "publish", createdAt: "2026-10-20T00:00:00.000Z", blockCount: 5 },
    ];
    const RESTORED = { id: A, kind: "note", title: "合成の題名", lang: "ja", blocks: [{ type: "paragraph", content: [{ type: "text", text: "戻した本文" }] }], revision: 8, createdAt: UPDATED_AT, updatedAt: "2026-10-31T02:59:59.000Z" };
    const rowTexts = () => [...(dialog()?.querySelectorAll("ol li") ?? [])].map((row) => [...row.querySelectorAll("span[id] > span")].map((part) => part.textContent));
    const rowButtons = () => [...(dialog()?.querySelectorAll<HTMLButtonElement>("ol li button") ?? [])];
    const sheetStatus = () => dialog()?.querySelector('[role="status"]')?.textContent;
    const headerStatus = () => container!.querySelector('.es-dt [role="status"]')?.textContent;

    it("saves first, then lists the versions newest first with when, why and how many blocks; an empty history says so", async () => {
      const calls: string[] = [];
      const listing = deferred<Response>();
      const answers = [listing.promise, Promise.resolve(json(200, { versions: [] }))];
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init: RequestInit) => {
          calls.push(`${init.method} ${url}`);
          return answers.shift()!;
        }),
      );
      await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A, { flush: vi.fn(async () => (calls.push("flush"), true)) })} />);
      await choose("履歴");
      expect(calls).toEqual(["flush", `GET /api/pages/${A}/versions`]);
      expect(dialog()?.getAttribute("aria-label")).toBe("履歴");
      expect(sheetStatus()).toBe("読み込み中");
      await act(async () => listing.resolve(json(200, { versions: VERSIONS })));
      await tick();
      expect(sheetStatus()).toBe("");
      expect(dialog()?.querySelector("ol")?.getAttribute("aria-label")).toBe("版の一覧");
      expect(rowTexts()).toEqual([
        ["たった今", "戻す前 · 4 ブロック"],
        ["30分前", "AI の提案の前 · 1 ブロック"],
        ["3時間前", "上書きの前 · 2 ブロック"],
        ["2日前", "自動保存 · 0 ブロック"],
        ["10月20日", "公開 · 5 ブロック"],
      ]);
      // どの「この版に戻す」も、その行の時刻と理由で説明される
      for (const button of rowButtons()) {
        expect(button.textContent).toBe("この版に戻す");
        expect(dialog()!.querySelector(`[id="${button.getAttribute("aria-describedby")}"]`)?.closest("li")).toBe(button.closest("li"));
      }
      await press(document.activeElement!, "Escape");
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(moreButton());

      await choose("履歴");
      expect(sheetStatus()).toBe("まだ履歴がありません");
      expect(dialog()?.querySelector("ol")).toBeNull();
    });

    it("この版に戻す asks first; 戻す saves again, sends the base revision once, closes, reopens the editor with the restored page and says so", async () => {
      const calls: Array<{ call: string; body: unknown }> = [];
      const restoring = deferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init: RequestInit) => {
          calls.push({ call: `${init.method} ${url}`, body: init.body ? JSON.parse(String(init.body)) : null });
          return init.method === "GET" ? Promise.resolve(json(200, { versions: VERSIONS })) : restoring.promise;
        }),
      );
      const flush = vi.fn(async () => (calls.push({ call: "flush", body: null }), true));
      const reopen = vi.fn();
      await mount({ pages: [page(D, "別のページ"), page(A, "合成の題名")] }, <FakePage page={fakePage(A, { flush, reopen, revision: () => 7 })} />);
      await choose("履歴");
      await act(async () => rowButtons()[1]!.click());
      expect(dialog()?.getAttribute("aria-label")).toBe("この版に戻す");
      expect(dialog()?.querySelector("h2")?.textContent).toBe("この版に戻しますか？");
      expect(dialog()?.textContent).toContain("30分前");
      expect(dialog()?.textContent).toContain("AI の提案の前 · 1 ブロック");
      expect(dialog()?.textContent).toContain("本文がこの版になります（題名はそのまま）。いまの本文は、戻したあとも履歴から戻せます。");
      expect(document.activeElement).toBe(dialogButton("やめる"));
      // やめる: 一覧へ戻り、押した行の「この版に戻す」へフォーカスが戻る（何も送らない）
      await act(async () => dialogButton("やめる").click());
      expect(dialog()?.getAttribute("aria-label")).toBe("履歴");
      expect(document.activeElement).toBe(rowButtons()[1]);
      // 確かめている間の Esc も一覧へ戻るだけ
      await act(async () => rowButtons()[1]!.click());
      await press(document.activeElement!, "Escape");
      expect(dialog()?.getAttribute("aria-label")).toBe("履歴");
      expect(calls.map((entry) => entry.call)).toEqual(["flush", `GET /api/pages/${A}/versions`]);

      await act(async () => rowButtons()[1]!.click());
      await act(async () => dialogButton("戻す").click());
      await tick();
      await act(async () => dialogButton("戻す").click());
      await tick();
      expect(calls.slice(2)).toEqual([
        { call: "flush", body: null },
        { call: `POST /api/pages/${A}/versions/4/restore`, body: { baseRevision: 7 } },
      ]);
      expect(dialogButton("戻す").getAttribute("aria-disabled")).toBe("true");
      // 戻している間は閉じない
      await press(document.activeElement!, "Escape");
      await act(async () => dialogButton("やめる").click());
      expect(dialog()).not.toBeNull();

      await act(async () => restoring.resolve(json(200, { page: RESTORED })));
      await tick();
      expect(dialog()).toBeNull();
      expect(reopen).toHaveBeenCalledTimes(1);
      expect(reopen).toHaveBeenCalledWith({ id: A, title: "合成の題名", blocks: RESTORED.blocks, revision: 8, updatedAt: RESTORED.updatedAt });
      expect(headerStatus()).toBe("この版の本文に戻しました");
      expect(document.activeElement).toBe(moreButton());
    });

    it("a conflict, a version that cannot be restored and a failure say so in the sheet, which stays open; unsaved edits stop it", async () => {
      const answers = [
        json(200, { versions: VERSIONS }),
        json(409, { error: "conflict", page: { ...RESTORED, revision: 9 } }),
        json(422, { error: "unrestorable" }),
        json(500, { error: "internal" }),
      ];
      const fetchMock = vi.fn(async () => answers.shift() ?? json(500, { error: "internal" }));
      vi.stubGlobal("fetch", fetchMock);
      let saves = true;
      const reopen = vi.fn();
      await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A, { flush: vi.fn(async () => saves), reopen })} />);
      await choose("履歴");
      await act(async () => rowButtons()[0]!.click());
      for (const said of ["別の画面で保存されました。開き直してからもう一度", "この版には戻せません", "戻せませんでした"]) {
        await act(async () => dialogButton("戻す").click());
        await tick();
        expect(dialogAlert()).toBe(said);
        expect(dialog()?.getAttribute("aria-label")).toBe("この版に戻す");
      }
      expect(fetchMock).toHaveBeenCalledTimes(4);
      // 送る前に保存できなければ、送らない
      saves = false;
      await act(async () => dialogButton("戻す").click());
      await tick();
      expect(dialogAlert()).toBe("戻す前に変更を保存できませんでした");
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(reopen).not.toHaveBeenCalled();
      expect(headerStatus()).toBe("");
    });

    it("a list that cannot be read offers 読み直す", async () => {
      const answers = [json(500, { error: "internal" }), json(200, { versions: VERSIONS })];
      vi.stubGlobal("fetch", vi.fn(async () => answers.shift()!));
      await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A)} />);
      await choose("履歴");
      expect(dialogAlert()).toBe("履歴を読み込めませんでした");
      expect(document.activeElement).toBe(dialogButton("読み直す"));
      await act(async () => dialogButton("読み直す").click());
      await tick();
      expect(dialogAlert()).toBeUndefined();
      expect(rowButtons()).toHaveLength(5);
    });
  });

  it("共有・履歴 stop without opening when the unsaved edits cannot be saved, and say why (nothing is sent)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A, { status: "offline", flush: vi.fn(async () => false) })} />);
    await choose("リンクで共有");
    expect(dialog()).toBeNull();
    expect(headerAlert()).toBe("共有の前に変更を保存できませんでした");
    await choose("履歴");
    expect(dialog()).toBeNull();
    expect(headerAlert()).toBe("履歴を開く前に変更を保存できませんでした");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("共有・履歴 belong to the page they were opened on: after moving to another page, an old result neither shows nor restores there", async () => {
    const reading = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => reading.promise));
    const setSharedA = vi.fn();
    await mount({ pages: [page(A, "合成の題名"), page(B, "次のページ")] }, <FakePage page={fakePage(A, { setShared: setSharedA })} />);
    await choose("リンクで共有");
    expect(dialog()).not.toBeNull();
    nav.pathname = `/p/${B}`;
    const reopenB = vi.fn();
    const b = fakePage(B, { reopen: reopenB });
    await rerender(<FakePage page={b} />);
    expect(dialog()).toBeNull();
    await act(async () => reading.resolve(json(200, { share: { status: "PUBLIC", publicId: "p".repeat(22), url: `https://editor.test/s/${"t".repeat(43)}`, updatedAt: UPDATED_AT } })));
    await tick();
    expect(dialog()).toBeNull();
    expect(setSharedA).not.toHaveBeenCalled();
    expect(b.setShared).not.toHaveBeenCalled();

    // 履歴: 戻している間に別のページへ移ったら、戻った結果をそのページに入れない
    const restoring = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => (init.method === "GET" ? Promise.resolve(json(200, { versions: [{ version: 1, reason: "autosave", createdAt: UPDATED_AT, blockCount: 1 }] })) : restoring.promise)));
    nav.pathname = `/p/${A}`;
    const reopenA = vi.fn();
    await rerender(<FakePage page={fakePage(A, { reopen: reopenA })} />);
    await choose("履歴");
    await act(async () => dialog()!.querySelector<HTMLButtonElement>("ol li button")!.click());
    await act(async () => dialogButton("戻す").click());
    await tick();
    nav.pathname = `/p/${B}`;
    await rerender(<FakePage page={b} />);
    expect(dialog()).toBeNull();
    await act(async () => restoring.resolve(json(200, { page: { id: A, title: "合成の題名", blocks: [], revision: 3, updatedAt: UPDATED_AT } })));
    await tick();
    expect(reopenA).not.toHaveBeenCalled();
    expect(reopenB).not.toHaveBeenCalled();
    expect(container!.querySelector('.es-dt [role="status"]')?.textContent).toBe("");
  });

  describe("情報パネル (#34 第 3 段)", () => {
    /** 開いたページ（OpenPage と同じく、一覧の行と録音の長さを枠に知らせ、エディタの代わりを登録する）。 */
    function OpenedFake({ summary, page: attached, recordingSec = null }: { summary: PageSummary; page: AttachedPage; recordingSec?: number | null }) {
      const { attachPage, pageOpened } = useEditorFrame();
      useEffect(() => pageOpened(summary, { recordingSec }), [pageOpened, summary, recordingSec]);
      useEffect(() => attachPage(attached), [attachPage, attached]);
      return <p>合成の本文</p>;
    }
    const headings = () => [...rail()!.querySelectorAll("h2, h3")].map((heading) => `${heading.tagName}:${heading.textContent?.replace("▾", "")}`);

    it("opens and closes from the header (aria-expanded, aria-controls, a named rail, h2 then h3); the rail has no publish items (the 公開 button is the frame header's)", async () => {
      await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A)} />);
      const button = railButton()!;
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(button.getAttribute("aria-controls")).toBe("es-rail");
      expect(rail()).toBeNull();
      expect(shell().rail).toBe("closed");

      await openRail();
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(rail()?.tagName).toBe("ASIDE");
      expect(rail()?.getAttribute("aria-label")).toBe("このページの設定");
      expect(shell().rail).toBe("open");
      expect(headings()).toEqual(["H2:ページ設定", "H3:言語", "H3:著者", "H3:ページ", "H3:書き出し"]);
      // 公開の項目（発信先・カテゴリ・関連する体験）・Google ドキュメントはレールに出さない。公開ボタンは枠のヘッダーのもの（#39）
      expect(rail()!.textContent).not.toMatch(/発信先|カテゴリ|関連する体験|公開|Google/);
      expect(container!.querySelector(".es-pubbtn")).not.toBeNull();
      expect([...rail()!.querySelectorAll("button")].map((item) => item.textContent?.replace("▾", "").trim())).toEqual(["ページ設定", "日本語", "English", "Markdown", "ページを削除"]);

      // 節を閉じると、見出しに「自分だけ」
      const section = rail()!.querySelector<HTMLButtonElement>("h2 button")!;
      await act(async () => section.click());
      expect(section.getAttribute("aria-expanded")).toBe("false");
      expect(section.textContent).toContain("自分だけ");
      await act(async () => section.click());
      expect(section.textContent).not.toContain("自分だけ");

      await act(async () => button.click());
      expect(rail()).toBeNull();
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(shell().rail).toBe("closed");
    });

    it("desktop: stays open when another page opens (as the mock v6), is not there on the settings, and is back on a page", async () => {
      await mount({ pages: [page(A, "合成の題名"), page(B, "別のページ")] }, <FakePage page={fakePage(A)} />);
      await openRail();
      nav.pathname = `/p/${B}`;
      await rerender(<FakePage page={fakePage(B, { lang: "en" })} />);
      expect(rail()).not.toBeNull();
      expect(pressedLang()).toEqual(["English"]);
      expect(railButton()?.getAttribute("aria-expanded")).toBe("true");

      nav.pathname = "/settings";
      await rerender(null);
      expect(railButton()).toBeNull();
      expect(rail()).toBeNull();
      expect(shell().rail).toBe("closed");

      nav.pathname = `/p/${A}`;
      await rerender(<FakePage page={fakePage(A)} />);
      expect(rail()).not.toBeNull();
      expect(pressedLang()).toEqual(["日本語"]);
    });

    it("narrow: the rail is the whole screen under the header, the same button closes it, and opening another page closes it", async () => {
      narrow = true;
      await mount({ pages: [page(A, "合成の題名"), page(B, "別のページ")], initialNarrow: true }, <FakePage page={fakePage(A)} />);
      expect(shell().view).toBe("page");
      await openRail();
      expect(shell().view).toBe("rail");
      expect(railButton()?.getAttribute("aria-expanded")).toBe("true");
      await act(async () => railButton()!.click());
      expect(shell().view).toBe("page");
      expect(rail()).toBeNull();

      await openRail();
      nav.pathname = `/p/${B}`;
      await rerender(<FakePage page={fakePage(B)} />);
      expect(rail()).toBeNull();
      expect(shell().view).toBe("page");
      expect(railButton()?.getAttribute("aria-expanded")).toBe("false");
    });

    it("has no button on a page not created yet, the recording start, the settings, or a page with no editor; while the drafts are read it shows but does nothing", async () => {
      nav.pathname = "/p/new";
      const uncreated = fakePage(null);
      await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={uncreated} />);
      expect(railButton()).toBeNull();
      nav.search = "from=recording";
      await rerender(null);
      expect(railButton()).toBeNull();
      nav.search = "";
      nav.pathname = "/account";
      await rerender(null);
      expect(railButton()).toBeNull();
      // 開けなかったページ（404。一覧に行があってもエディタが無い）
      nav.pathname = `/p/${A}`;
      await rerender(null);
      expect(railButton()).toBeNull();

      // 端末の下書きを読んでいる間（id はまだ無い）: レールは出せるが、押しても何もしない。文字数はまだ数えない
      const loading = fakePage(null, { lang: "en" });
      await rerender(<FakePage page={loading} />);
      await openRail();
      expect(rail()).not.toBeNull();
      expect(pressedLang()).toEqual(["日本語"]);
      await act(async () => inRail("English")!.click());
      await act(async () => inRail("ページを削除")!.click());
      expect(loading.setLang).not.toHaveBeenCalled();
      expect(dialog()).toBeNull();
      expect(infoRows().map(([label]) => label)).toEqual(["作成", "更新"]);
      // 読み終えた
      await rerender(<FakePage page={fakePage(A, { lang: "en" })} />);
      expect(pressedLang()).toEqual(["English"]);
      expect(infoRows().map(([label]) => label)).toEqual(["作成", "更新", "文字数"]);
    });

    it("shows the signed-in name without a title, the dates, the recording length and the count (characters in ja, words in en) that follows the body", async () => {
      const listeners = new Set<() => void>();
      let body = "合成の 本文です";
      const text = {
        read: () => body,
        subscribe: (onChange: () => void) => {
          listeners.add(onChange);
          return () => {
            listeners.delete(onChange);
          };
        },
      };
      const summary: PageSummary = { ...page(A, "合成の録音"), kind: "rec", createdAt: "2026-10-28T09:00:00.000Z", updatedAt: "2026-10-30T18:00:00.000Z" };
      const a = fakePage(A, { text });
      await mount({ pages: [summary] }, <OpenedFake summary={summary} page={a} recordingSec={878} />);
      await openRail();
      const me = rail()!.querySelector(".es-me")!;
      expect(me.querySelector("div")?.textContent).toBe("開発ユーザー");
      expect(me.querySelector("small")).toBeNull();
      expect(me.querySelector(".es-av")?.textContent).toBe("開");
      expect(infoRows()).toEqual([
        ["作成", localDay(summary.createdAt)],
        ["更新", localDay(summary.updatedAt)],
        ["録音", "14:38"],
        ["文字数", "7"],
      ]);

      // 本文が変わったら、少し待ってから数え直す（打つたびには数えない）
      body = "合成の本文です。続き";
      await act(async () => listeners.forEach((listener) => listener()));
      expect(infoRows().at(-1)).toEqual(["文字数", "7"]);
      await act(async () => new Promise((resolve) => setTimeout(resolve, COUNT_DELAY_MS + 50)));
      expect(infoRows().at(-1)).toEqual(["文字数", "10"]);

      // 英語のページは語数
      body = "A synthetic body";
      await act(async () => listeners.forEach((listener) => listener()));
      await act(async () => new Promise((resolve) => setTimeout(resolve, COUNT_DELAY_MS + 50)));
      await rerender(<OpenedFake summary={summary} page={{ ...a, lang: "en" }} recordingSec={878} />);
      expect(infoRows().at(-1)).toEqual(["文字数", "3 words"]);

      // パネルを閉じたら、本文の知らせを受けない
      await act(async () => railButton()!.click());
      expect(listeners.size).toBe(0);
    });

    it("shows the language note the page gives, under 言語", async () => {
      await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A, { langNote: LANG_NOT_SAVED })} />);
      await openRail();
      expect(railAlert()).toBe("言語を保存できませんでした");
      expect(rail()!.querySelector('[role="alert"]')?.closest("section")?.querySelector("h3")?.textContent).toBe("言語");
    });

    it("Markdown saves first, then clicks the same export.md link as the … (the focus stays on the button); unsaved edits stop it with a reason", async () => {
      const calls: string[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
        calls.push(`click ${this.getAttribute("href")} ${this.getAttribute("download")}`);
      });
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A, { flush: vi.fn(async () => (calls.push("flush"), true)) })} />);
      await openRail();
      const markdown = inRail("Markdown")!;
      markdown.focus();
      await act(async () => markdown.click());
      await tick();
      expect(calls).toEqual(["flush", `click /api/pages/${A}/export.md `]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(markdown);

      calls.length = 0;
      await rerender(<FakePage page={fakePage(A, { status: "offline", flush: vi.fn(async () => (calls.push("flush"), false)) })} />);
      await act(async () => inRail("Markdown")!.click());
      await tick();
      expect(calls).toEqual(["flush"]);
      expect(headerAlert()).toBe("書き出しの前に変更を保存できませんでした");
    });

    it("ページを削除 opens the same confirmation as the …; やめる gives the focus back to it; 削除する saves, DELETEs and leaves the page", async () => {
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          calls.push(`${init.method} ${url}`);
          return new Response(null, { status: 204 });
        }),
      );
      await mount({ pages: [page(A, "合成の題名"), page(D, "別のページ")] }, <FakePage page={fakePage(A, { flush: vi.fn(async () => (calls.push("flush"), true)) })} />);
      await openRail();
      const remove = inRail("ページを削除")!;
      expect(remove.className).toContain("es-danger");
      remove.focus();
      await act(async () => remove.click());
      expect(dialog()?.getAttribute("aria-label")).toBe("ページの削除");
      expect(document.activeElement).toBe(dialogButton("やめる"));
      expect(calls).toEqual([]);
      await act(async () => dialogButton("やめる").click());
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(remove);

      await act(async () => remove.click());
      await act(async () => dialogButton("削除する").click());
      await tick();
      expect(calls).toEqual(["flush", `DELETE /api/pages/${A}`]);
      expect(dialog()).toBeNull();
      expect(rows()).toEqual(["別のページ"]);
      expect(nav.push).toHaveBeenCalledWith("/");
    });
  });

  describe("with the real PageEditor", () => {
    const typeTitle = async (value: string) => {
      const title = container!.querySelector<HTMLTextAreaElement>("textarea.page-title")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(title, value);
        title.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    it("registers the page: the dot follows the real save state and is the only live region saying it; 複製 sends the unsaved title first", async () => {
      const calls: Array<{ method: string; url: string; body: unknown }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          const body = init.body ? JSON.parse(String(init.body)) : null;
          calls.push({ method: String(init.method), url, body });
          if (init.method === "PATCH") return json(200, { page: { id: A, revision: 2 } });
          return json(201, { page: { id: COPY, title: "合成の題名 2のコピー", kind: "note" } });
        }),
      );
      await mount(
        { pages: [page(A, "合成の題名")] },
        <PageEditor page={{ id: A, title: "合成の題名", blocks: [], revision: 1, updatedAt: UPDATED_AT }} drafts={null} />,
      );
      await tick();
      expect(tip()).toBe("自分だけ · 保存済み");
      const saying = [...container!.querySelectorAll('[aria-live], [role="status"], [role="alert"], [role="log"]')].filter((node) => node.textContent?.includes("保存済み"));
      expect(saying).toEqual([container!.querySelector(".es-dt .es-st-wrap")]);
      // 本文の上の表示は残す（見える文字だけ）
      expect(container!.querySelector("[data-save-state]")?.textContent).toBe("保存済み");

      await typeTitle("合成の題名 2");
      expect(tip()).toBe("自分だけ · 保存中");
      // 1 秒の自動保存を待たずに、複製の前に送る
      await choose("複製");
      await tick();
      expect(calls).toEqual([
        { method: "PATCH", url: `/api/pages/${A}`, body: { title: "合成の題名 2", baseRevision: 1 } },
        { method: "POST", url: `/api/pages/${A}/duplicate`, body: null },
      ]);
      expect(tip()).toBe("自分だけ · 保存済み");
      expect(nav.push).toHaveBeenCalledWith(`/p/${COPY}`);
    });

    const paragraph = (text: string) => [{ type: "paragraph", content: [{ type: "text", text }] }];
    const body = () => container!.querySelector(".doc")?.textContent;
    const titleValue = () => container!.querySelector<HTMLTextAreaElement>("textarea.page-title")?.value;
    const saveNow = () => act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, ctrlKey: !isMacPlatform(), bubbles: true, cancelable: true })));
    async function until(condition: () => boolean) {
      for (let attempt = 0; attempt < 50 && !condition(); attempt++) await tick();
      expect(condition()).toBe(true);
    }
    /** 版の一覧・戻す・保存を受ける合成のサーバー（戻したあとの本文は「戻した本文」、revision は 5）。 */
    function restoringServer(calls: Array<{ method: string; url: string; body: unknown }>) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          const sent = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
          calls.push({ method: String(init.method), url, body: sent });
          if (url.endsWith("/versions")) return json(200, { versions: [{ version: 1, reason: "autosave", createdAt: UPDATED_AT, blockCount: 1 }] });
          if (url.endsWith("/restore")) {
            return json(200, { page: { id: A, kind: "note", title: "合成の題名", lang: "ja", blocks: paragraph("戻した本文"), revision: 5, createdAt: UPDATED_AT, updatedAt: "2026-10-31T02:59:00.000Z" } });
          }
          if (url.endsWith("/share")) return json(200, { share: { status: "PRIVATE", publicId: null, url: null, updatedAt: null } });
          if (init.method === "PATCH") return json(200, { page: { id: A, revision: (sent!.baseRevision as number) + 1 } });
          return json(500, { error: "internal" });
        }),
      );
    }
    async function restoreFirstVersion() {
      await choose("履歴");
      await act(async () => dialog()!.querySelector<HTMLButtonElement>("ol li button")!.click());
      await act(async () => dialogButton("戻す").click());
      await tick();
    }

    it("history: restoring puts the restored body into the open editor, keeps the title, and the next save builds on the restored revision", async () => {
      const calls: Array<{ method: string; url: string; body: unknown }> = [];
      restoringServer(calls);
      // OpenPage と同じく、保存（戻したときも）を一覧へ知らせる
      function Opened() {
        const frame = useEditorFrame();
        return <PageEditor page={{ id: A, title: "合成の題名", blocks: paragraph("今の本文"), revision: 4, updatedAt: UPDATED_AT }} drafts={null} onSaved={() => frame.pageSaved(A)} />;
      }
      await mount({ pages: [page(D, "別のページ"), page(A, "合成の題名")] }, <Opened />);
      await tick();
      expect(body()).toBe("今の本文");
      await restoreFirstVersion();
      expect(calls).toEqual([
        { method: "GET", url: `/api/pages/${A}/versions`, body: null },
        { method: "POST", url: `/api/pages/${A}/versions/1/restore`, body: { baseRevision: 4 } },
      ]);
      expect(dialog()).toBeNull();
      expect(body()).toBe("戻した本文");
      expect(titleValue()).toBe("合成の題名");
      expect(tip()).toBe("自分だけ · 保存済み");
      expect(container!.querySelector('.es-dt [role="status"]')?.textContent).toBe("この版の本文に戻しました");
      // 戻したページは一覧の上へ
      expect(rows()).toEqual(["合成の題名", "別のページ"]);
      expect(document.activeElement).toBe(moreButton());

      // 次の保存は、戻したあとの revision の上に送る（競合にしない）
      await typeTitle("合成の題名 2");
      await saveNow();
      await tick();
      expect(calls.at(-1)).toEqual({ method: "PATCH", url: `/api/pages/${A}`, body: { title: "合成の題名 2", baseRevision: 5 } });
      expect(tip()).toBe("自分だけ · 保存済み");
      expect(container!.querySelector("[data-save-state]")?.getAttribute("data-save-state")).toBe("saved");
    });

    it("history: with drafts on the device, the reopened editor reads them again, and the … comes back with the focus", async () => {
      const calls: Array<{ method: string; url: string; body: unknown }> = [];
      restoringServer(calls);
      const drafts = createIndexedDbDraftStorage(new IDBFactory())!;
      await mount({ pages: [page(A, "合成の題名")] }, <PageEditor page={{ id: A, title: "合成の題名", blocks: paragraph("今の本文"), revision: 4, updatedAt: UPDATED_AT }} drafts={drafts} />);
      await until(() => moreButton() !== null);
      await restoreFirstVersion();
      await until(() => moreButton() !== null && body() === "戻した本文");
      expect(document.activeElement).toBe(moreButton());
      expect(await drafts.get(A)).toBeNull();
      await typeTitle("合成の題名 2");
      await saveNow();
      await until(() => calls.at(-1)?.method === "PATCH");
      expect(calls.at(-1)?.body).toEqual({ title: "合成の題名 2", baseRevision: 5 });
    });

    it("share: the … says 共有中 from what the server read when the page opened, follows the sheet, and keeps it after a restore", async () => {
      const calls: Array<{ method: string; url: string; body: unknown }> = [];
      restoringServer(calls);
      const shareItem = async () => {
        await act(async () => moreButton()!.click());
        const text = menuItems()[0]!.textContent;
        await act(async () => moreButton()!.click());
        return text;
      };
      await mount({ pages: [page(A, "合成の題名")] }, <PageEditor page={{ id: A, title: "合成の題名", blocks: [], revision: 4, updatedAt: UPDATED_AT }} drafts={null} shared />);
      await tick();
      expect(await shareItem()).toBe("リンクで共有共有中");
      // 別の画面で止められていた: シートで読み直すと、印も替わる
      await choose("リンクで共有");
      expect(dialog()?.querySelector("h2")?.textContent).toBe("リンクで共有");
      await act(async () => dialogButton("閉じる").click());
      expect(await shareItem()).toBe("リンクで共有");
      // 版に戻して開き直しても、開いたときの値（共有中）に戻らない
      await restoreFirstVersion();
      expect(body()).toBe("戻した本文");
      expect(await shareItem()).toBe("リンクで共有");
    });

    it("a new page shows the state but no … until the first save has created it", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const NEW = "00000000-0000-4000-8000-0000000000ee";
        vi.stubGlobal("fetch", vi.fn(async () => json(201, { page: { id: NEW, revision: 1 } })));
        nav.pathname = "/p/new";
        await mount({ pages: [] }, <PageEditor page={{ id: null, title: "", blocks: [], revision: null }} drafts={null} />);
        expect(tip()).toBe("自分だけ · 保存済み");
        expect(moreButton()).toBeNull();
        await typeTitle("合成の新しいページ");
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        expect(tip()).toBe("自分だけ · 保存済み");
        expect(moreButton()).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    describe("the language in the info panel (#34 第 3 段)", () => {
      type Call = { method: string; url: string; body: Record<string, unknown> | null };
      /** 保存（PATCH）を受ける合成のサーバー。`answer` で応答を差し替える（既定は revision を 1 つ進める）。 */
      function savingServer(calls: Call[], answer?: (body: Record<string, unknown>) => Response | undefined | Promise<Response | undefined>) {
        vi.stubGlobal(
          "fetch",
          vi.fn(async (url: string, init: RequestInit) => {
            const sent = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
            calls.push({ method: String(init.method), url, body: sent });
            const custom = sent ? await answer?.(sent) : undefined;
            return custom ?? json(200, { page: { id: A, revision: (sent!.baseRevision as number) + 1 } });
          }),
        );
      }
      /** OpenPage と同じく、保存と言語を一覧へ知らせるエディタ。 */
      function Opened({ lang = "ja", drafts = null }: { lang?: "ja" | "en"; drafts?: ReturnType<typeof createIndexedDbDraftStorage> }) {
        const frame = useEditorFrame();
        return (
          <PageEditor
            page={{ id: A, title: "合成の題名", blocks: [], revision: 1, updatedAt: UPDATED_AT, lang }}
            drafts={drafts}
            onSaved={() => frame.pageSaved(A)}
            onLangChange={(next) => frame.pageLangChanged(A, next)}
          />
        );
      }
      async function untilAsync(condition: () => Promise<boolean>) {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await condition()) return;
          await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
        }
        expect(await condition()).toBe(true);
      }

      it("sends the language at once on the same autosave (baseRevision), the dot says 保存中 then 保存済み, the next save builds on it, and the list gets it", async () => {
        const calls: Call[] = [];
        const answered = deferred<void>();
        savingServer(calls, async (body) => {
          if (body.lang !== undefined) await answered.promise;
          return undefined;
        });
        await mount({ pages: [page(A, "合成の題名")] }, <Opened />);
        await until(() => moreButton() !== null);
        await openRail();
        expect(pressedLang()).toEqual(["日本語"]);

        await act(async () => inRail("English")!.click());
        expect(pressedLang()).toEqual(["English"]);
        expect(tip()).toBe("自分だけ · 保存中");
        // 1 秒の自動保存を待たずに送る
        expect(calls).toEqual([{ method: "PATCH", url: `/api/pages/${A}`, body: { lang: "en", baseRevision: 1 } }]);
        await act(async () => answered.resolve());
        await tick();
        expect(tip()).toBe("自分だけ · 保存済み");
        expect(railAlert()).toBeUndefined();

        // 次の保存は、言語を保存したあとの revision の上に（revision をずらさない・競合にしない）
        await typeTitle("合成の題名 2");
        await saveNow();
        await tick();
        expect(calls.at(-1)).toEqual({ method: "PATCH", url: `/api/pages/${A}`, body: { title: "合成の題名 2", baseRevision: 2 } });

        // 一覧の行の言語も替わった（エディタが下書きを読み直している間は、一覧の行の言語を出す）
        await rerender(<FakePage page={fakePage(null)} />);
        expect(pressedLang()).toEqual(["English"]);
      });

      it("a failed save puts the language the server has back with a short note, and sends that one too (the server ends as the screen says)", async () => {
        const calls: Call[] = [];
        let fail = true;
        savingServer(calls, () => (fail ? json(500, { error: "internal" }) : undefined));
        await mount({ pages: [page(A, "合成の題名")] }, <Opened />);
        await until(() => moreButton() !== null);
        await openRail();
        await act(async () => inRail("English")!.click());
        await tick();
        expect(calls.map((call) => call.body)).toEqual([{ lang: "en", baseRevision: 1 }]);
        expect(pressedLang()).toEqual(["日本語"]);
        expect(railAlert()).toBe(LANG_NOT_SAVED);
        expect(tip()).toBe("自分だけ · 保存に失敗しました。もう一度試します");

        // 届いたか分からない失敗だったので、戻した言語も送る
        fail = false;
        await saveNow();
        await tick();
        expect(calls.at(-1)?.body).toEqual({ lang: "ja", baseRevision: 1 });
        expect(tip()).toBe("自分だけ · 保存済み");
        expect(railAlert()).toBe(LANG_NOT_SAVED);
        // 次に変えたら一言は消える
        await act(async () => inRail("English")!.click());
        await tick();
        expect(railAlert()).toBeUndefined();
        expect(calls.at(-1)?.body).toEqual({ lang: "en", baseRevision: 2 });
        expect(pressedLang()).toEqual(["English"]);
      });

      it("another screen saved first: the band stops the save (not taken as its own even with the same title and body), the language goes back, and この内容で上書き carries it", async () => {
        const calls: Call[] = [];
        // 別の画面が revision 3 まで進めていた（題名・本文は同じ。言語は日本語のまま）
        savingServer(calls, (body) =>
          body.baseRevision === 1
            ? json(409, { error: "conflict", page: { id: A, kind: "note", title: "合成の題名", lang: "ja", blocks: [], revision: 3, updatedAt: UPDATED_AT } })
            : undefined,
        );
        await mount({ pages: [page(A, "合成の題名")] }, <Opened />);
        await until(() => moreButton() !== null);
        await openRail();
        await act(async () => inRail("English")!.click());
        await tick();
        expect(container!.querySelector("[data-conflict-band]")).not.toBeNull();
        expect(tip()).toBe("自分だけ · 保存を止めています");
        expect(pressedLang()).toEqual(["日本語"]);
        expect(railAlert()).toBe(LANG_NOT_SAVED);

        // 帯が出ている間に変えても、保存は止まったまま（戻して一言）
        await act(async () => inRail("English")!.click());
        await tick();
        expect(calls).toHaveLength(1);
        expect(pressedLang()).toEqual(["日本語"]);

        await act(async () => [...container!.querySelectorAll<HTMLButtonElement>("[data-conflict-band] button")].find((item) => item.textContent === "この内容で上書き")!.click());
        await tick();
        expect(calls.at(-1)?.body).toMatchObject({ title: "合成の題名", lang: "ja", baseRevision: 3, overwrite: true });
        expect(container!.querySelector("[data-conflict-band]")).toBeNull();
        expect(tip()).toBe("自分だけ · 保存済み");
        // 上書きのあとは普通に変えられる
        await act(async () => inRail("English")!.click());
        await tick();
        expect(calls.at(-1)?.body).toEqual({ lang: "en", baseRevision: 4 });
        expect(pressedLang()).toEqual(["English"]);
      });

      it("keeps the language when a version is restored (the reopened editor says English and does not send it again)", async () => {
        const calls: Array<{ method: string; url: string; body: unknown }> = [];
        restoringServer(calls);
        await mount({ pages: [page(A, "合成の題名")] }, <PageEditor page={{ id: A, title: "合成の題名", blocks: paragraph("今の本文"), revision: 4, updatedAt: UPDATED_AT, lang: "ja" }} drafts={null} />);
        await until(() => moreButton() !== null);
        await openRail();
        await act(async () => inRail("English")!.click());
        await tick();
        expect(calls.at(-1)).toEqual({ method: "PATCH", url: `/api/pages/${A}`, body: { lang: "en", baseRevision: 4 } });
        await restoreFirstVersion();
        // 戻すのは言語を保存したあとの revision の上に
        expect(calls.find((call) => call.url.endsWith("/restore"))?.body).toEqual({ baseRevision: 5 });
        expect(body()).toBe("戻した本文");
        expect(pressedLang()).toEqual(["English"]);
        // 合成のサーバーは戻したあとの revision を 5 で返す。言語は送り直さない
        await typeTitle("合成の題名 2");
        await saveNow();
        await tick();
        expect(calls.at(-1)).toEqual({ method: "PATCH", url: `/api/pages/${A}`, body: { title: "合成の題名 2", baseRevision: 5 } });
      });

      it("keeps the language in the device's draft until it reaches the server, and a draft with another language opens in that language and saves it", async () => {
        const calls: Call[] = [];
        const answered = deferred<void>();
        savingServer(calls, async () => {
          await answered.promise;
          return undefined;
        });
        const drafts = createIndexedDbDraftStorage(new IDBFactory())!;
        await mount({ pages: [page(A, "合成の題名")] }, <Opened drafts={drafts} />);
        await until(() => moreButton() !== null);
        await openRail();
        await act(async () => inRail("English")!.click());
        await untilAsync(async () => (await drafts.get(A))?.lang === "en");
        expect(await drafts.get(A)).toMatchObject({ baseRevision: 1, title: "合成の題名", lang: "en" });
        await act(async () => answered.resolve());
        await untilAsync(async () => (await drafts.get(A)) === null);

        // 届く前に閉じた下書き（同じ revision・言語だけ違う）を持って開き直す
        await act(async () => root!.unmount());
        container!.remove();
        await drafts.put(A, { baseRevision: 1, title: "合成の題名", blocks: [], lang: "en", savedAt: "2026-10-31T02:30:00.000Z" });
        calls.length = 0;
        await mount({ pages: [page(A, "合成の題名")] }, <Opened drafts={drafts} />);
        await until(() => moreButton() !== null);
        await openRail();
        expect(pressedLang()).toEqual(["English"]);
        await saveNow();
        await untilAsync(async () => calls.length > 0);
        expect(calls[0]?.body).toMatchObject({ title: "合成の題名", lang: "en", baseRevision: 1 });
      });
    });
  });
});

describe("EditorFrame: フォルダの木と、常設の書式の帯（#37 T2・T9）", () => {
  /** ページの中の PageEditor の代わり（枠に登録するだけ）。 */
  function FakePage({ page: attached }: { page: AttachedPage }) {
    const { attachPage } = useEditorFrame();
    useEffect(() => attachPage(attached), [attachPage, attached]);
    return <p>合成の本文</p>;
  }
  function fakePage(id: string | null): AttachedPage {
    return {
      id,
      status: "saved",
      flush: vi.fn(async () => true),
      revision: () => 1,
      reopen: vi.fn(),
      shared: null,
      setShared: vi.fn(),
      lang: "ja",
      setLang: vi.fn(),
      langNote: null,
      text: { read: () => "", subscribe: () => () => undefined },
    };
  }
  async function until(condition: () => boolean) {
    for (let tries = 0; tries < 200 && !condition(); tries++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 5)));
    expect(condition()).toBe(true);
  }

  const PARENT = "00000000-0000-4000-8000-00000000000a";
  const CHILD = "00000000-0000-4000-8000-00000000000b";
  const SUB = "00000000-0000-4000-8000-00000000000c";
  const inside = (parent: string, id: string, title: string): PageSummary => ({ ...page(id, title), parent });

  /** 木の行（段つき）。段は入れ子の <ul> の深さで数える。 */
  const tree = () =>
    [...container!.querySelectorAll(".es-sb-list li")].map((li) => {
      let depth = 0;
      for (let at = li.parentElement; at && !at.classList.contains("es-sb-list"); at = at.parentElement) if (at.tagName === "UL") depth++;
      return [li.querySelector(".es-di-t")?.textContent, depth - 1];
    });
  const twisty = (title: string) => container!.querySelector<HTMLButtonElement>(`.es-sb-list button[aria-label="${title} の中"]`);

  it("出すのは 1 本の木（フォルダ › ページ › 録音のサブページ）。フォルダの行で開閉できる", async () => {
    await mount({ pages: [page(PARENT, "鎌倉の記事"), inside(PARENT, CHILD, "取材メモ"), inside(CHILD, SUB, "文字起こし修正")] });
    expect(tree()).toEqual([
      ["鎌倉の記事", 0],
      ["取材メモ", 1],
      ["文字起こし修正", 2],
    ]);
    expect(twisty("鎌倉の記事")?.getAttribute("aria-expanded")).toBe("true");

    // 閉じると中の行が消え、もう一度押すと戻る（ページは失われない）
    await act(async () => twisty("鎌倉の記事")!.click());
    expect(tree()).toEqual([["鎌倉の記事", 0]]);
    expect(twisty("鎌倉の記事")?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => twisty("鎌倉の記事")!.click());
    expect(tree()).toHaveLength(3);
  });

  it("情報パネルの「フォルダ」で入れる・出す（本文・revision は送らない）", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    nav.pathname = `/p/${CHILD}`;
    await mount({ pages: [page(PARENT, "鎌倉の記事"), page(CHILD, "取材メモ")] }, <FakePage page={fakePage(CHILD)} />);
    await click('.es-dt button[aria-label="このページの設定と AI"]');
    const select = container!.querySelector<HTMLSelectElement>('.es-rail select[aria-label="フォルダ"]')!;
    expect([...select.options].map((option) => option.textContent)).toEqual(["フォルダに入れない", "鎌倉の記事"]);
    expect(select.value).toBe("");

    await act(async () => {
      select.value = PARENT;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(calls).toEqual([{ url: `/api/pages/${CHILD}/parent`, method: "PATCH", body: { parent: PARENT } }]);
    // 一覧の行はすぐ動く（木の中へ）
    expect(tree()).toEqual([
      ["鎌倉の記事", 0],
      ["取材メモ", 1],
    ]);

    await act(async () => {
      container!.querySelector<HTMLSelectElement>('.es-rail select[aria-label="フォルダ"]')!.value = "";
      container!.querySelector<HTMLSelectElement>('.es-rail select[aria-label="フォルダ"]')!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(calls.at(-1)).toEqual({ url: `/api/pages/${CHILD}/parent`, method: "PATCH", body: { parent: null } });
    expect(tree()).toEqual([
      ["鎌倉の記事", 0],
      ["取材メモ", 0],
    ]);
  });

  it("入れられなかったときは行を戻して一言（ページは失われない）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "too_deep" }), { status: 409, headers: { "content-type": "application/json" } })));
    nav.pathname = `/p/${CHILD}`;
    await mount({ pages: [page(PARENT, "鎌倉の記事"), page(CHILD, "取材メモ")] }, <FakePage page={fakePage(CHILD)} />);
    await click('.es-dt button[aria-label="このページの設定と AI"]');
    const select = () => container!.querySelector<HTMLSelectElement>('.es-rail select[aria-label="フォルダ"]')!;
    await act(async () => {
      select().value = PARENT;
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container!.querySelector('.es-rail [role="alert"]')?.textContent).toBe("このフォルダには入れられませんでした");
    expect(select().value).toBe("");
    expect(tree()).toEqual([
      ["鎌倉の記事", 0],
      ["取材メモ", 0],
    ]);
  });

  it("「フォルダ」の節は、入れ先が無く上の段にいるページには出さない", async () => {
    nav.pathname = `/p/${CHILD}`;
    await mount({ pages: [page(CHILD, "取材メモ")] }, <FakePage page={fakePage(CHILD)} />);
    await click('.es-dt button[aria-label="このページの設定と AI"]');
    expect(container!.querySelector('.es-rail select[aria-label="フォルダ"]')).toBeNull();
  });

  it("書式の帯はヘッダーに常設で、録音は枠が受けて録音から始める画面へ移る", async () => {
    nav.pathname = `/p/${PAGE_ID}`;
    const drafts = createIndexedDbDraftStorage(new IDBFactory())!;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
    await mount(
      { pages: [page(PAGE_ID, "合成の題名")] },
      <PageEditor page={{ id: PAGE_ID, title: "合成の題名", blocks: [{ type: "paragraph", content: [{ type: "text", text: "本文" }] }], revision: 1, updatedAt: "2026-10-31T02:00:00.000Z" }} drafts={drafts} />,
    );
    await until(() => container!.querySelector('.es-dt [role="toolbar"]') !== null);
    const bar = container!.querySelector<HTMLElement>('.es-dt [role="toolbar"]')!;
    expect(bar.getAttribute("aria-label")).toBe("書式とブロック");
    expect([...bar.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual([
      "ブロックを足す",
      "テキスト、行の種類",
      "太字",
      "斜体",
      "リンク",
      "見出し",
      "箇条書き",
      "画像",
      "録音",
    ]);
    await act(async () => bar.querySelector<HTMLButtonElement>('button[aria-label="録音"]')!.click());
    expect(nav.push).toHaveBeenLastCalledWith("/p/new?from=recording");
  });
});

describe("EditorFrame: 「最近」・手動の並び・フォルダの背景・フォルダの書き出し（#37）", () => {
  const FOLDER = "00000000-0000-4000-8000-0000000000f0";
  const INSIDE = "00000000-0000-4000-8000-0000000000f1";
  const OTHER = "00000000-0000-4000-8000-0000000000f2";
  const inside = (parent: string, id: string, title: string): PageSummary => ({ ...page(id, title), parent });

  function FakePage({ page: attached }: { page: AttachedPage }) {
    const { attachPage } = useEditorFrame();
    useEffect(() => attachPage(attached), [attachPage, attached]);
    return <p>合成の本文</p>;
  }
  /** 開いたページ（OpenPage と同じく、一覧の行を枠に知らせる）。 */
  function OpenedPage({ summary }: { summary: PageSummary }) {
    const { pageOpened } = useEditorFrame();
    useEffect(() => pageOpened(summary), [pageOpened, summary]);
    return <p>合成の本文</p>;
  }
  function fakePage(id: string | null): AttachedPage {
    return {
      id,
      status: "saved",
      flush: vi.fn(async () => true),
      revision: () => 1,
      reopen: vi.fn(),
      shared: null,
      setShared: vi.fn(),
      lang: "ja",
      setLang: vi.fn(),
      langNote: null,
      text: { read: () => "", subscribe: () => () => undefined },
    };
  }
  async function until(condition: () => boolean) {
    for (let tries = 0; tries < 200 && !condition(); tries++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 5)));
    expect(condition()).toBe(true);
  }

  /** 「最近」の節の行（無ければ null）。 */
  const recentRows = () => {
    const group = container!.querySelector(".es-sb-group");
    return group ? [...group.querySelectorAll(".es-di-t")].map((node) => node.textContent) : null;
  };
  const railButton = (label: string) => [...container!.querySelectorAll<HTMLButtonElement>(".es-rail button")].find((button) => (button.getAttribute("aria-label") ?? button.textContent)?.includes(label));

  it("「最近」は木の上に出て、開閉でき、ページを開くとサーバーに記録して前に出る", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return new Response(null, { status: 204 });
      }),
    );
    nav.pathname = `/p/${OTHER}`;
    await mount({ pages: [page(FOLDER, "鎌倉の記事"), page(OTHER, "別のページ")], recent: [page(FOLDER, "鎌倉の記事")] }, <p>本文</p>);
    expect(recentRows()).toEqual(["鎌倉の記事"]);

    // 開閉（開いているのが既定）
    const head = container!.querySelector<HTMLButtonElement>(".es-sb-grouphd")!;
    expect(head.getAttribute("aria-expanded")).toBe("true");
    await act(async () => head.click());
    expect(recentRows()).toEqual([]);
    await act(async () => container!.querySelector<HTMLButtonElement>(".es-sb-grouphd")!.click());

    // ページを開くと記録し、「最近」の先頭に出る
    await rerender(<OpenedPage summary={page(OTHER, "別のページ")} />);
    await until(() => calls.some((call) => call.includes("/open")));
    expect(calls.filter((call) => call.includes("/open"))).toEqual([`POST /api/pages/${OTHER}/open`]);
    expect(recentRows()).toEqual(["別のページ", "鎌倉の記事"]);
  });

  it("「最近」は検索しているあいだ出さない", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ hits: [] }), { status: 200, headers: { "content-type": "application/json" } })));
    await mount({ pages: [page(FOLDER, "鎌倉の記事")], recent: [page(FOLDER, "鎌倉の記事")] });
    expect(recentRows()).toEqual(["鎌倉の記事"]);
    await click('button[aria-label="探す"]');
    await act(async () => {
      const input = container!.querySelector<HTMLInputElement>('[role="search"] input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "鎌倉");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(recentRows()).toBeNull();
  });

  it("情報パネルの「並び」で 1 つ動かし、木の順が変わる", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ moved: true }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    nav.pathname = `/p/${OTHER}`;
    // 上の段は渡した順（更新の新しい順）。別のページが下
    await mount({ pages: [page(FOLDER, "鎌倉の記事"), page(OTHER, "別のページ")] }, <FakePage page={fakePage(OTHER)} />);
    expect(rows()).toEqual(["鎌倉の記事", "別のページ"]);
    await click('.es-dt button[aria-label="このページの設定と AI"]');

    const up = railButton("1 つ上へ")!;
    expect(up.getAttribute("aria-disabled")).toBeNull();
    expect(railButton("1 つ下へ")?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => up.click());
    await until(() => rows()[0] === "別のページ");
    expect(calls.filter((call) => call.url.includes("/order"))).toEqual([{ url: `/api/pages/${OTHER}/order`, body: { move: "up" } }]);
    // 端に来たので「上へ」が押せなくなる
    await until(() => railButton("1 つ上へ")?.getAttribute("aria-disabled") === "true");
  });

  it("「このフォルダの背景」はフォルダのページでだけ出し、登場人物と固有名詞を保存する", async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
        const fields = init?.method === "PATCH" ? JSON.parse(String(init.body)) : { entities: [], terms: [] };
        return new Response(JSON.stringify({ fields }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    nav.pathname = `/p/${FOLDER}`;
    await mount({ pages: [page(FOLDER, "鎌倉の記事"), inside(FOLDER, INSIDE, "取材メモ")] }, <FakePage page={fakePage(FOLDER)} />);
    await click('.es-dt button[aria-label="このページの設定と AI"]');
    await until(() => calls.some((call) => call.url.includes("/fields")));
    expect(container!.querySelector(".es-psfields")?.textContent).toContain("このフォルダの背景");

    await act(async () => railButton("編集")!.click());
    await act(async () => [...container!.querySelectorAll<HTMLButtonElement>(".es-rail button")].find((button) => button.textContent === "行を追加")!.click());
    await act(async () => {
      const input = container!.querySelector<HTMLInputElement>(".es-psfields input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "田中");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => railButton("登場人物を保存")!.click());
    await until(() => calls.some((call) => call.method === "PATCH"));
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ entities: [{ name: "田中", reading: "", role: "", note: "" }], terms: [] });

    // フォルダでないページには節を出さない
    nav.pathname = `/p/${INSIDE}`;
    await rerender(<FakePage page={fakePage(INSIDE)} />);
    expect(container!.querySelector(".es-psfields")).toBeNull();
  });

  it("フォルダの書き出しは zip の URL を押す（フォルダでないページには出さない）", async () => {
    const clicked: string[] = [];
    const click_ = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      clicked.push(this.getAttribute("href") ?? "");
    };
    try {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ fields: { entities: [], terms: [] } }), { status: 200, headers: { "content-type": "application/json" } })));
      nav.pathname = `/p/${FOLDER}`;
      await mount({ pages: [page(FOLDER, "鎌倉の記事"), inside(FOLDER, INSIDE, "取材メモ")] }, <FakePage page={fakePage(FOLDER)} />);
      await click('.es-dt button[aria-label="このページの設定と AI"]');
      const button = [...container!.querySelectorAll<HTMLButtonElement>(".es-rail button")].find((item) => item.textContent?.includes("このフォルダの中をまとめて"))!;
      await act(async () => button.click());
      expect(clicked).toEqual([`/api/pages/${FOLDER}/export.zip`]);
    } finally {
      HTMLAnchorElement.prototype.click = click_;
    }
  });
});
