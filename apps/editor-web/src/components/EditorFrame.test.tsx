// @vitest-environment jsdom
import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SHELL_DND } from "niho-docs-ui/shell";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageSummary } from "@niho/editor-store";
import { IDBFactory } from "fake-indexeddb";
import { createIndexedDbDraftStorage } from "@/lib/drafts";
import { SAVE_STATUS_TEXT, type SaveStatus } from "@/lib/save-status";
import { isMacPlatform } from "@/lib/use-search-shortcut";
import { COPIED_NOTE_MS } from "./ShareSheet";
import { EditorFrame, SWAP_UNSAVED_TEXT, useEditorFrame, type AttachedPage, type FrameInitial } from "./EditorFrame";
import { COUNT_DELAY_MS } from "./PageInfo";
import { LANG_NOT_SAVED, PageEditor } from "./PageEditor";
import { NewPage } from "./FramePages";
import { LEFT_EMPTY_PAGES_KEY, TAB_CREATED_PAGES_KEY } from "@/lib/left-empty-pages";

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

// AI の通信・race は AiBox.test.tsx で本物を検証する。枠のテストでは常設の境界だけを見る。
// 分割ビューのテストのため、枠が渡した props（置き場所・AI がページを直した知らせ）を覚えておく
type AiMockProps = {
  placement?: { at: string; onMove: (to: "left" | "right" | "float") => void; open: boolean; onOpenChange: (open: boolean) => void };
  onPagesChanged?: (ids: readonly string[]) => void;
};
const aiMock = vi.hoisted(() => ({ props: null as AiMockProps | null }));
vi.mock("./AiBox", () => ({
  AiPanel: (props: AiMockProps) => {
    aiMock.props = props;
    return (
      <section aria-label="AIとの会話">
        <h2>AIと作る</h2>
        <textarea aria-label="AIへのメッセージ" />
      </section>
    );
  },
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
/** 左の一覧の上の 1 行のアイコン（「検索」「新しいページ」。名前は aria-label の先頭）。 */
const clickSidebarAct = (label: string) =>
  act(async () => [...container!.querySelectorAll<HTMLButtonElement>(".es-sb-top button.es-ib")].find((button) => button.getAttribute("aria-label")?.startsWith(label))!.click());
/** ヘッダーの「⋯」の項目を選ぶ。 */
const chooseMore = async (label: string) => {
  await act(async () => container!.querySelector<HTMLButtonElement>('.es-dt button[aria-label="その他"]')!.click());
  await act(async () => [...container!.querySelectorAll<HTMLButtonElement>('[role="menu"][aria-label="その他"] [role="menuitem"]')].find((item) => item.textContent?.startsWith(label))!.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};
/** ヘッダーの「⋯」の項目の名前（開いて読み、閉じる）。 */
const moreLabels = async () => {
  const more = container!.querySelector<HTMLButtonElement>('.es-dt button[aria-label="その他"]')!;
  await act(async () => more.click());
  const labels = [...container!.querySelectorAll('[role="menu"][aria-label="その他"] [role="menuitem"]')].map((item) => item.textContent);
  await act(async () => more.click());
  return labels;
};
const sheetNamed = (label: string) => container!.querySelector<HTMLElement>(`[role="dialog"][aria-label="${label}"]`);
const intersect = () => act(async () => observers.filter((entry) => !entry.disconnected).at(-1)!.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));

function chunkResponse(pages: PageSummary[], next: string | null): Response {
  return new Response(JSON.stringify({ pages, next }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("EditorFrame", () => {
  it.each([false, true])("Mac の殻のときだけウィンドウボタンの余白を渡す（shell=%s）", async (shell) => {
    if (shell) Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    try {
      await mount({ pages: [page(PAGE_ID, "合成のページ")] });
      expect(container!.querySelector(".es-root")!.getAttribute("data-window-controls")).toBe(shell ? "true" : null);
      expect(container!.querySelector(".es-when")).toBeNull();
    } finally {
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    }
  });
  it("写真への導線や空のアプリ欄を出さず、ページ一覧を表示する", async () => {
    await mount({ pages: [page(PAGE_ID, "合成のページ")] });
    const sidebar = container!.querySelector('aside[aria-label="ページ"]')!;
    expect(sidebar.querySelector('nav[aria-label="アプリ"]')).toBeNull();
    expect(buttonByText("写真", sidebar)).toBeUndefined();
    expect(rows()).toEqual(["合成のページ"]);
  });

  it("空の新規ページでも、入力せずに公開と右側の設定を使える", async () => {
    nav.pathname = "/p/new";
    window.history.replaceState(null, "", "/p/new");
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ page: { id: PAGE_ID, revision: 1 } }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    await mount({}, <NewPage />);
    // Next は replaceState のあと usePathname を更新する。ここでは navigation のモックを追従させる。
    nav.pathname = window.location.pathname;
    await rerender(<NewPage />);
    expect(container!.querySelector<HTMLTextAreaElement>("textarea.page-title")?.value).toBe("");
    expect(container!.querySelector(".ProseMirror")?.textContent).toBe("");
    expect(window.location.pathname).toBe(`/p/${PAGE_ID}`);
    expect(buttonByText("公開")).toBeDefined();
    // 文字数は本文の列の右下。言語は公開のシートの中
    expect(container!.querySelector(".es-corner .es-count")?.textContent).toBe("0 字");
    await act(async () => buttonByText("公開")!.click());
    expect(buttonByText("日本語", dialog()!)?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => buttonByText("閉じる", dialog()!)!.click());
    // ページを作るのは 1 回だけ（ほかは公開のシートの英語版の状態を読むだけ）
    const calls = fetcher.mock.calls as unknown as [string, RequestInit | undefined][];
    expect(calls.filter(([, init]) => init?.method !== undefined)).toEqual([["/api/pages", expect.objectContaining({ method: "POST" })]]);
    expect(calls.filter(([, init]) => init?.method === undefined).map(([url]) => url)).toEqual([`/api/pages/${PAGE_ID}/translation`]);
  });

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
      expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/pages?limit=100&view=all&cursor=cursor-1");
      await act(async () => release(chunkResponse([page("b"), page("c")], "cursor-2")));
      expect(rows()).toEqual(["a", "b", "c"]);

      await intersect();
      expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/pages?limit=100&view=all&cursor=cursor-2");
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

  describe("フォルダ（kind = 'folder'）", () => {
    const FOLDER = "00000000-0000-4000-8000-0000000000f1";
    const INSIDE = "00000000-0000-4000-8000-0000000000f2";
    const folderPages = () => [
      { ...page(FOLDER, "鎌倉の取材"), kind: "folder" as const },
      { ...page(INSIDE, "取材メモ"), parent: FOLDER },
      page("00000000-0000-4000-8000-000000000001", "上の段"),
    ];

    it("フォルダの中のページでは、新しいページのメニューの上に「『◯◯』の中に」を出し、その中に作る（?in=）", async () => {
      nav.pathname = `/p/${INSIDE}`;
      await mount({ pages: folderPages() });
      await clickSidebarAct("新しいページ");
      const menu = container!.querySelector('[role="menu"]')!;
      expect(menu.querySelector(".es-menu-hd")?.textContent).toBe("「鎌倉の取材」の中に");
      await act(async () => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.includes("空のページ"))!.click());
      expect(nav.push).toHaveBeenLastCalledWith(`/p/new?in=${FOLDER}`);
      await clickSidebarAct("新しいページ");
      await act(async () => [...container!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.includes("録音から"))!.click());
      expect(nav.push).toHaveBeenLastCalledWith(`/p/new?from=recording&in=${FOLDER}`);
      // 上の段のページでは見出しを出さない
      await moveTo("/p/00000000-0000-4000-8000-000000000001");
      await clickSidebarAct("新しいページ");
      expect(container!.querySelector('[role="menu"] .es-menu-hd')).toBeNull();
    });

    it("「フォルダ」はいつも上の段に空のフォルダを作って開き、一覧にフォルダの行として出す", async () => {
      const NEW = "00000000-0000-4000-8000-0000000000f9";
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/pages" && init?.method === "POST") return new Response(JSON.stringify({ page: { id: NEW, revision: 1 } }), { status: 201, headers: { "content-type": "application/json" } });
        return new Response(null, { status: 204 });
      });
      const previous = globalThis.fetch;
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      nav.pathname = `/p/${INSIDE}`;
      await mount({ pages: folderPages() });
      await clickSidebarAct("新しいページ");
      await act(async () => [...container!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "フォルダ")!.click());
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      const post = fetchMock.mock.calls.find(([url, init]) => url === "/api/pages" && init?.method === "POST")!;
      expect(JSON.parse(String(post[1]!.body))).toEqual({ kind: "folder" });
      expect(nav.push).toHaveBeenLastCalledWith(`/p/${NEW}`);
      expect(container!.querySelector(".es-sb-list .es-di-t--folder")).not.toBeNull();
      globalThis.fetch = previous;
    });

    it("ヘッダーの場所は親のフォルダだけ（ページ名は出さない）。押すとそのフォルダへ", async () => {
      nav.pathname = `/p/${INSIDE}`;
      await mount({ pages: folderPages() });
      const nav2 = container!.querySelector('.es-dt nav[aria-label="場所"]')!;
      expect(nav2.textContent).toBe("鎌倉の取材");
      expect(container!.querySelector(".es-dt")?.textContent).not.toContain("取材メモ");
      await act(async () => nav2.querySelector("button")!.click());
      expect(nav.push).toHaveBeenLastCalledWith(`/p/${FOLDER}`);
    });

    it("まだ作っていないページ・録音からは、フォルダの中から開いたときだけ、入れ先のフォルダをヘッダーの場所に出す（上の段から開いたときは空）", async () => {
      nav.pathname = "/p/new";
      await mount({ pages: folderPages() });
      // 上の段から開いた新しいページ・録音からは、他の上の段のページと同じく場所を出さない
      expect(container!.querySelector('.es-dt nav[aria-label="場所"]')).toBeNull();
      await moveTo("/p/new", "from=recording");
      expect(container!.querySelector('.es-dt nav[aria-label="場所"]')).toBeNull();
      // フォルダの中から開いた録音から（?in=）: 入れ先のフォルダ。押すとそのフォルダへ戻れる
      await moveTo("/p/new", `from=recording&in=${FOLDER}`);
      const place = container!.querySelector('.es-dt nav[aria-label="場所"]')!;
      expect(place.textContent).toBe("鎌倉の取材");
      await act(async () => place.querySelector("button")!.click());
      expect(nav.push).toHaveBeenLastCalledWith(`/p/${FOLDER}`);
      // 空の新しいページ（?in=）も同じ
      await moveTo("/p/new", `in=${FOLDER}`);
      expect(container!.querySelector('.es-dt nav[aria-label="場所"]')?.textContent).toBe("鎌倉の取材");
      // フォルダでないページの id や、一覧に無い id を渡されても場所は出さない
      await moveTo("/p/new", `in=${INSIDE}`);
      expect(container!.querySelector('.es-dt nav[aria-label="場所"]')).toBeNull();
      await moveTo("/p/new", "in=00000000-0000-4000-8000-0000000000ff");
      expect(container!.querySelector('.es-dt nav[aria-label="場所"]')).toBeNull();
    });
  });

  it("moves to a page, a new page, the recording start, and the settings from the sidebar", async () => {
    nav.pathname = "/p/00000000-0000-4000-8000-000000000001";
    await mount({ pages: [page("00000000-0000-4000-8000-000000000001", "合成の題名"), page("00000000-0000-4000-8000-000000000002")] });
    // ページ名はヘッダーに出さない（本文の題名にだけ）。上の段のページなので場所も出ない
    expect(container!.querySelector(".es-dt .es-ttl")?.textContent ?? null).toBe("");
    expect(container!.querySelector('.es-dt nav[aria-label="場所"]') === null).toBe(true);
    expect(container!.querySelector('[aria-current="page"]')?.textContent).toContain("合成の題名");

    await act(async () => container!.querySelectorAll<HTMLButtonElement>(".es-sb-list li button.es-di")[1]!.click());
    expect(nav.push).toHaveBeenLastCalledWith("/p/00000000-0000-4000-8000-000000000002");

    await clickSidebarAct("新しいページ");
    await act(async () => [...container!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.includes("空のページ"))!.click());
    expect(nav.push).toHaveBeenLastCalledWith("/p/new");
    expect(container!.querySelector('[role="menu"]')).toBeNull();
    await clickSidebarAct("新しいページ");
    await act(async () => [...container!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.includes("録音から"))!.click());
    expect(nav.push).toHaveBeenLastCalledWith("/p/new?from=recording");

    // 左下は「設定」の直リンク（メニューは無い。本人の名前は設定の一覧の「アカウント」に出る）
    expect(container!.querySelector(".es-sb-me")?.textContent).toBe("設定");
    expect(container!.querySelector(".es-sb-me")?.hasAttribute("aria-haspopup")).toBe(false);
    await click(".es-sb-me");
    expect(container!.querySelector('[role="menu"]')).toBeNull();
    expect(nav.push).toHaveBeenLastCalledWith("/settings");

    // 左上はアプリ名。一覧が左上にあるあいだは一覧の上の 1 行の左（「Editor …… 検索 ＋ しまう」。枠の帯・ヘッダーには無い）。
    // デスクトップ: 一覧をしまうと右上に「一覧を出す」が出て、押すと戻る。しまったあいだのアプリ名は枠の帯
    expect(container!.querySelector('.es-sb-top [aria-label="Editor"]')).not.toBeNull();
    expect(container!.querySelector(".es-brandbar")).toBeNull();
    expect(container!.querySelector('.es-dt [aria-label="Editor"]')).toBeNull();
    await click('button[aria-label="一覧をしまう"]');
    expect(shell().sidebar).toBe("closed");
    expect(container!.querySelector('.es-brandbar [aria-label="Editor"]')).not.toBeNull();
    expect(container!.querySelectorAll('[aria-label="Editor"]')).toHaveLength(1);
    expect(container!.querySelector('.es-dt .es-tg button[aria-label="一覧を出す"]')).not.toBeNull();
    await click('button[aria-label="一覧を出す"]');
    expect(shell().sidebar).toBe("open");
    expect(container!.querySelector('.es-dt button[aria-label="一覧を出す"]')).toBeNull();
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
      expect(container!.querySelector('.es-sb-list > [aria-hidden="true"]')).not.toBeNull();

      await clickSidebarAct("検索");
      await type("朝");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toMatch(/^\/api\/search\?q=/);
      expect(rows()).toEqual(["鎌倉の朝", "メモ"]);
      expect([...container!.querySelectorAll(".es-sb-list .es-di-sub")].map((node) => node.textContent)).toEqual(["…江ノ電の音で目が覚めた…", "朝の散歩の前に"]);
      expect(note()).toBe("2 件");
      // 検索中は続きを読まない
      expect(container!.querySelector('.es-sb-list > [aria-hidden="true"]')).toBeNull();

      await type("");
      expect(rows()).toEqual(["日記", "録音"]);
      expect(note()).toBeUndefined();
      expect(container!.querySelector('.es-sb-list > [aria-hidden="true"]')).not.toBeNull();
    });

    it("says so when nothing is found, and when the search fails", async () => {
      const fetchMock = vi.fn<(url: string) => Promise<Response>>().mockResolvedValueOnce(searchResponse([])).mockResolvedValueOnce(searchResponse([], 503));
      vi.stubGlobal("fetch", fetchMock);
      await mount({ pages: [page("a", "日記")] });
      await clickSidebarAct("検索");
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
    // ヘッダーの左は「‹ 一覧」（上の段のページ）。押すと `/` へ移る（状態の切り替えでなく URL。OS の戻るで戻れる。#320 A1・A2）
    expect(container!.querySelector('button[aria-label="一覧を出す"]')).toBeNull();
    expect(container!.querySelector('button[aria-label="一覧へ戻る"]')?.textContent).toBe("一覧");
    expect(container!.querySelector('.es-dt nav[aria-label="場所"]')).toBeNull();
    await click('button[aria-label="一覧へ戻る"]');
    expect(nav.push).toHaveBeenLastCalledWith("/");
    // ⌘K は一覧を今のページの上に重ねて出す。今の行を押すと一覧が閉じてページに戻る（移動はしない）
    const pushes = nav.push.mock.calls.length;
    await shortcut("k");
    expect(shell().view).toBe("list");
    await click('[aria-current="page"]');
    expect(shell().view).toBe("page");
    expect(nav.push.mock.calls.length).toBe(pushes);

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

  it("narrow: a page inside a folder goes back to the folder (the header's left is the folder's name; no breadcrumb). A new page in a folder too", async () => {
    narrow = true;
    const folderId = "00000000-0000-4000-8000-00000000f01d";
    nav.pathname = `/p/${PAGE_ID}`;
    await mount({ pages: [{ ...page(folderId, "鎌倉の取材"), kind: "folder" }, { ...page(PAGE_ID, "合成の題名"), parent: folderId }], initialNarrow: true });
    expect(shell().view).toBe("page");
    expect(container!.querySelector('button[aria-label="鎌倉の取材へ戻る"]')?.textContent).toBe("鎌倉の取材");
    expect(container!.querySelector('button[aria-label="一覧へ戻る"]')).toBeNull();
    expect(container!.querySelector('nav[aria-label="場所"]')).toBeNull();
    await click('button[aria-label="鎌倉の取材へ戻る"]');
    expect(nav.push).toHaveBeenLastCalledWith(`/p/${folderId}`);
    // フォルダの中に作る新しいページ（/p/new?in=）も、そのフォルダへ戻る
    await moveTo("/p/new", `in=${folderId}`);
    expect(container!.querySelector('button[aria-label="鎌倉の取材へ戻る"]')).not.toBeNull();
    // 設定は「‹ 一覧」
    await moveTo("/settings");
    expect(container!.querySelector('button[aria-label="一覧へ戻る"]')).not.toBeNull();
    await click('button[aria-label="一覧へ戻る"]');
    expect(nav.push).toHaveBeenLastCalledWith("/");
  });

  it("narrow: ⌘⇧P does nothing while the list is shown over the page", async () => {
    narrow = true;
    nav.pathname = `/p/${PAGE_ID}`;
    await mount({ pages: [page(PAGE_ID, "合成の題名")], initialNarrow: true });
    await shortcut("k");
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

  describe("流れの入れ物とタブ（#309 の flowPagesChanged）", () => {
    const FOLDER = "00000000-0000-4000-8000-0000000000f0";
    const HOLDER = "00000000-0000-4000-8000-0000000000aa";
    const TAB_1 = "00000000-0000-4000-8000-0000000000b1";
    const TAB_2 = "00000000-0000-4000-8000-0000000000b2";
    type Row = { id: string; title: string; kind: "folder" | "page" | "note" | "rec"; parent: string | null; page: string | null; stepStatus: "done" | "run" | "wait" | "stale" | "failed" | null; tabPos?: number };
    let send: (pages: Row[]) => void = () => undefined;
    let remove: (id: string) => void = () => undefined;

    function FromFlow() {
      const { flowPagesChanged, pageRemoved } = useEditorFrame();
      send = flowPagesChanged;
      remove = pageRemoved;
      return <p>合成の中身</p>;
    }

    const folder = (): PageSummary => ({ ...page(FOLDER, "取材"), kind: "folder" });
    const holder = (): Row => ({ id: HOLDER, title: "記事方針", kind: "page", parent: FOLDER, page: null, stepStatus: null });

    it("まだ一覧に無い入れ物とタブを、フォルダの下に足す（タブは入れ物の行にまとまり、作成中は言葉と回るマーク）", async () => {
      await mount({ pages: [folder()] }, <FromFlow />);
      await act(async () =>
        send([
          holder(),
          { id: TAB_1, title: "記事方針", kind: "note", parent: FOLDER, page: HOLDER, stepStatus: "done", tabPos: 1 },
          { id: TAB_2, title: "記事方針", kind: "note", parent: FOLDER, page: HOLDER, stepStatus: "run", tabPos: 2 },
        ]),
      );
      // 入れ物の行は「題名 ＋ タブの数の印」（#308）
      expect(rows()).toEqual(["取材", "記事方針タブ 2"]);
      expect([...container!.querySelectorAll(".es-sb-list .es-di-sub")].map((node) => node.textContent)).toEqual(["作成中…"]);
      expect(container!.querySelectorAll(".es-sb-list .es-busy")).toHaveLength(1);
    });

    it("ゴミ箱に入れた行は作り直さない", async () => {
      await mount({ pages: [folder(), { ...page(TAB_1, "記事方針"), parent: FOLDER }] }, <FromFlow />);
      await act(async () => remove(TAB_1));
      await act(async () => send([holder(), { id: TAB_1, title: "記事方針", kind: "note", parent: FOLDER, page: HOLDER, stepStatus: "done", tabPos: 1 }]));
      expect(rows()).toEqual(["取材", "記事方針"]);
    });

    it("同じ知らせを繰り返しても、行は増えず、状態だけが替わる。入れ物がフォルダに包まれたら親が替わる", async () => {
      await mount({ pages: [{ ...page(HOLDER, "記事方針"), kind: "page" }, { ...page(TAB_1, "記事方針"), page: HOLDER, tabPos: 1 }] }, <FromFlow />);
      const running: Row[] = [{ ...holder(), parent: null }, { id: TAB_1, title: "記事方針", kind: "note", parent: null, page: HOLDER, stepStatus: "run", tabPos: 1 }];
      await act(async () => send(running));
      await act(async () => send(running));
      expect(rows()).toEqual(["記事方針"]);
      expect([...container!.querySelectorAll(".es-sb-list .es-di-sub")].map((node) => node.textContent)).toEqual(["作成中…"]);
      // フォルダに包まれた（親が付いた）: フォルダの行ができ、入れ物はその下
      await act(async () => send([{ id: FOLDER, title: "記事方針", kind: "folder", parent: null, page: null, stepStatus: null }, holder(), { id: TAB_1, title: "記事方針", kind: "note", parent: FOLDER, page: HOLDER, stepStatus: "done", tabPos: 1 }]));
      expect(rows()).toEqual(["記事方針", "記事方針"]);
      expect([...container!.querySelectorAll(".es-sb-list .es-di-sub")].map((node) => node.textContent)).toEqual([]);
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
  // 「AIと作る」のパネル（#34 第 3 段 → #311）。右上のボタンは閉じているときだけ、開いているときはパネルの ×
  const railButton = () => container!.querySelector<HTMLButtonElement>('.es-dt button[aria-label="AIと作るを出す"]');
  const railClose = () => container!.querySelector<HTMLButtonElement>('#es-rail button[aria-label="AIと作るを閉じる"]');
  const mountedRail = () => container!.querySelector<HTMLElement>("#es-rail");
  const railPane = () => container!.querySelector<HTMLElement>('.es-pn[data-panel="ai"]');
  const rail = () => {
    const presence = railPane();
    return presence && !presence.hidden ? presence.querySelector<HTMLElement>("#es-rail") : null;
  };
  /** 端末の日付（YYYY-MM-DD。情報パネルの作成・更新の期待値）。 */
  const localDay = (iso: string) => {
    const date = new Date(iso);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const openRail = () => (railButton() ? act(async () => railButton()!.click()) : Promise.resolve());

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

    // 保存済み・保存中は見える文字を出さない（読み上げは丸の live region）。失敗のときだけヘッダーに琥珀の小さな文字
    const saveNote = () => container!.querySelector(".es-dt [data-save-note]");
    expect(saveNote()).toBeNull();
    await rerender(<FakePage page={{ ...a, status: "saving" }} />);
    expect(tip()).toBe("自分だけ · 保存中");
    expect(saveNote()).toBeNull();
    await rerender(<FakePage page={{ ...a, status: "offline" }} />);
    expect(tip()).toBe("自分だけ · オフライン・この端末に保持");
    expect(saveNote()?.textContent).toBe("オフライン・この端末に保持");
    for (const status of ["error", "conflict", "signedOut"] as SaveStatus[]) {
      await rerender(<FakePage page={{ ...a, status }} />);
      expect(tip()).toBe(`自分だけ · ${SAVE_STATUS_TEXT[status]}`);
      expect(saveNote()?.textContent).toBe(SAVE_STATUS_TEXT[status]);
      // 新しい live region・role は足さない
      expect(saveNote()?.getAttribute("role")).toBeNull();
      // 公開していないので丸は出さない（出すのは公開中・限定公開・更新ありだけ）
      expect(dot()).toBeNull();
    }

    // ページを離れたら（設定）、状態も「…」も出さない
    nav.pathname = "/settings";
    await rerender(null);
    expect(dot()).toBeNull();
    expect(moreButton()).toBeNull();
  });

  it("opens and closes the … menu with リンクで共有, 書き出し (.md), Google ドキュメントへ, 履歴, 複製 and 削除, moved by the keyboard; none for a page not created yet", async () => {
    await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A)} />);
    expect(moreButton()?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => moreButton()!.click());
    expect(moreButton()?.getAttribute("aria-expanded")).toBe("true");
    // 書き出しは .md と Google ドキュメントの 2 項目。共有しているか分からないときは「共有中」を出さない
    // 移動できない（入れ先も並べ替える相手も無い）ページには「移動…」を出さない。「ページの情報」は削除の前
    expect(menuItems().map((item) => item.textContent)).toEqual(["リンクで共有", "書き出し.md", "Google ドキュメントへ", "履歴", "複製", "ページの情報", "削除"]);
    const [shareItem, exportItem, , , , , deleteItem] = menuItems();
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
    // 既定で開くレールがフォルダ背景を読む初期 GET は、削除確認の検査対象ではない。
    calls.length = 0;
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

  /** 一覧の行の「…」を押して「削除」を選ぶ。 */
  const deleteRow = async (title: string) => {
    const row = [...container!.querySelectorAll<HTMLElement>(".es-sb-list .es-dirow")].find((node) => node.querySelector(".es-di-t")?.textContent === title)!;
    await act(async () => row.querySelector<HTMLButtonElement>(".es-di-more")!.click());
    const items = [...container!.querySelectorAll<HTMLButtonElement>('[role="menu"][aria-label="ページのメニュー"] [role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(["削除"]);
    await act(async () => items[0]!.click());
  };

  it("row delete: the row's … has only 削除; it asks with the title, DELETEs without touching the open page, and keeps the open page", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(`${init.method} ${url}`);
        return new Response(null, { status: 204 });
      }),
    );
    await mount({ pages: [page(A, "合成の題名"), page(D, "別のページ")] }, <FakePage page={fakePage(A, { flush: vi.fn(async () => (calls.push("flush"), true)) })} />);
    calls.length = 0;
    await deleteRow("別のページ");
    expect(calls).toEqual([]);
    expect(dialog()?.getAttribute("aria-label")).toBe("ページの削除");
    expect(dialog()?.querySelector("h2")?.textContent).toBe("「別のページ」を削除しますか？");
    expect(dialog()?.textContent).toContain("ゴミ箱に 30 日残ります。");
    await act(async () => dialogButton("削除する").click());
    await tick();
    // 開いていないページなので、開いているページの保存は待たない
    expect(calls).toEqual([`DELETE /api/pages/${D}`]);
    expect(dialog()).toBeNull();
    expect(rows()).toEqual(["合成の題名"]);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("row delete: the open page's row saves first, goes to / after deleting, and a refusal stays in the dialog", async () => {
    const calls: string[] = [];
    let answer = json(409, { error: "published" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(`${init.method} ${url}`);
        return answer;
      }),
    );
    await mount({ pages: [page(A, "")] }, <FakePage page={fakePage(A, { flush: vi.fn(async () => (calls.push("flush"), true)) })} />);
    calls.length = 0;
    await deleteRow("無題");
    // 無題は「このページ」
    expect(dialog()?.querySelector("h2")?.textContent).toBe("このページを削除しますか？");
    await act(async () => dialogButton("削除する").click());
    await tick();
    expect(calls).toEqual(["flush", `DELETE /api/pages/${A}`]);
    expect(dialogAlert()).toBe("公開中のページは、先に公開をやめてください");
    expect(rows()).toEqual(["無題"]);
    answer = new Response(null, { status: 204 });
    await act(async () => dialogButton("削除する").click());
    await tick();
    expect(dialog()).toBeNull();
    expect(rows()).toEqual([]);
    expect(nav.push).toHaveBeenCalledWith("/");
  });

  it("row delete: a folder's row while one of its subpages is open saves that subpage first (and stops if it cannot), then goes to /", async () => {
    const calls: string[] = [];
    let saved = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(`${init.method} ${url}`);
        return new Response(null, { status: 204 });
      }),
    );
    nav.pathname = `/p/${C}`;
    const pages = [{ ...page(C, "手順の結果"), parent: A }, page(A, "フォルダ"), page(D, "別のページ")];
    await mount({ pages }, <FakePage page={fakePage(C, { flush: vi.fn(async () => (calls.push("flush"), saved)) })} />);
    calls.length = 0;
    await deleteRow("フォルダ");
    await act(async () => dialogButton("削除する").click());
    await tick();
    // 開いているのは中のページ。保存できないまま消すと、その変更を失うので、削除は送らない
    expect(calls).toEqual(["flush"]);
    expect(dialogAlert()).toBe("削除の前に変更を保存できませんでした");
    expect(rows()).toEqual(["フォルダ", "手順の結果", "別のページ"]);
    expect(nav.push).not.toHaveBeenCalled();

    saved = true;
    await act(async () => dialogButton("削除する").click());
    await tick();
    expect(calls).toEqual(["flush", "flush", `DELETE /api/pages/${A}`]);
    expect(dialog()).toBeNull();
    // 中のページも一覧から外れ、開いていた画面は閉じる
    expect(rows()).toEqual(["別のページ"]);
    expect(nav.push).toHaveBeenCalledWith("/");
  });

  it("row delete: a row of an unrelated page does not save or close the open page, even when the open page is inside another folder", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(`${init.method} ${url}`);
        return new Response(null, { status: 204 });
      }),
    );
    nav.pathname = `/p/${C}`;
    const pages = [{ ...page(C, "手順の結果"), parent: A }, page(A, "フォルダ"), page(D, "別のページ")];
    await mount({ pages }, <FakePage page={fakePage(C, { flush: vi.fn(async () => (calls.push("flush"), true)) })} />);
    calls.length = 0;
    await deleteRow("別のページ");
    await act(async () => dialogButton("削除する").click());
    await tick();
    expect(calls).toEqual([`DELETE /api/pages/${D}`]);
    expect(rows()).toEqual(["フォルダ", "手順の結果"]);
    expect(nav.push).not.toHaveBeenCalled();
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
    await clickSidebarAct("検索");
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
    await clickSidebarAct("検索");
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
    // 2 ページあるので「移動…」も出る（共有・書き出し 2・履歴・複製・移動…・ページの情報・削除）
    expect(menuItems()).toHaveLength(8);
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
      expect(reopen).toHaveBeenCalledWith({ id: A, title: "合成の題名", blocks: RESTORED.blocks, cover: null, lead: null, revision: 8, updatedAt: RESTORED.updatedAt });
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
    const countButton = () => container!.querySelector<HTMLButtonElement>(".es-corner button.es-count");
    const infoPop = () => container!.querySelector<HTMLElement>(".es-count-pop");
    const popRows = () => [...(infoPop()?.querySelectorAll(".es-kv > div") ?? [])].map((row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent]);

    it("the rail is AIと作る only (no page settings, no publish items); closes from its ×, comes back from the header button, and keeps the AI draft", async () => {
      await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={fakePage(A)} />);
      // 開いているパネルのボタンは右上に出さない（× がある）
      expect(railButton()).toBeNull();
      expect(railClose()?.getAttribute("title")).toBe("閉じる");
      expect(rail()?.tagName).toBe("ASIDE");
      expect(rail()?.getAttribute("aria-label")).toBe("AIと作る");
      expect(shell().rail).toBe("open");
      expect([...rail()!.querySelectorAll("h2, h3")].map((heading) => heading.textContent)).toEqual(["AIと作る"]);
      expect(rail()!.textContent).not.toMatch(/ページ設定|言語|著者|書き出し|削除|発信先|公開|Google/);
      expect(container!.querySelector(".es-pubbtn")).not.toBeNull();

      const draft = rail()!.querySelector<HTMLTextAreaElement>('textarea[aria-label="AIへのメッセージ"]')!;
      draft.value = "閉じても残す draft";
      await act(async () => railClose()!.click());
      expect(rail()).toBeNull();
      expect(mountedRail()).not.toBeNull();
      expect(railPane()?.hidden).toBe(true);
      expect(railButton()).not.toBeNull();
      expect(shell().rail).toBe("closed");
      await openRail();
      expect(rail()!.querySelector<HTMLTextAreaElement>('textarea[aria-label="AIへのメッセージ"]')?.value).toBe("閉じても残す draft");
      expect(railButton()).toBeNull();
    });

    it("desktop: stays open when another page opens (as the mock v6), is not there on the settings, and is back on a page", async () => {
      await mount({ pages: [page(A, "合成の題名"), page(B, "別のページ")] }, <FakePage page={fakePage(A)} />);
      await openRail();
      nav.pathname = `/p/${B}`;
      await rerender(<FakePage page={fakePage(B, { lang: "en" })} />);
      expect(rail()).not.toBeNull();
      expect(railButton()).toBeNull();

      nav.pathname = "/settings";
      await rerender(null);
      expect(railButton()).toBeNull();
      expect(rail()).toBeNull();
      expect(shell().rail).toBe("closed");
      expect(countButton()).toBeNull();

      nav.pathname = `/p/${A}`;
      await rerender(<FakePage page={fakePage(A)} />);
      expect(rail()).not.toBeNull();
    });

    it("narrow: the rail is the whole screen under the header, its × closes it, and opening another page closes it", async () => {
      narrow = true;
      await mount({ pages: [page(A, "合成の題名"), page(B, "別のページ")], initialNarrow: true }, <FakePage page={fakePage(A)} />);
      expect(shell().view).toBe("page");
      expect(railButton()).not.toBeNull();
      await openRail();
      expect(shell().view).toBe("rail");
      expect(railButton()).toBeNull();
      await act(async () => railClose()!.click());
      expect(shell().view).toBe("page");
      expect(rail()).toBeNull();
      expect(railButton()).not.toBeNull();

      await openRail();
      nav.pathname = `/p/${B}`;
      await rerender(<FakePage page={fakePage(B)} />);
      expect(rail()).toBeNull();
      expect(shell().view).toBe("page");
      expect(railButton()).not.toBeNull();
    });

    it("has no rail button or count on a page not created yet, the recording start, the settings, or a page with no editor; while the drafts are read the count waits", async () => {
      nav.pathname = "/p/new";
      const uncreated = fakePage(null);
      await mount({ pages: [page(A, "合成の題名")] }, <FakePage page={uncreated} />);
      expect(railButton()).toBeNull();
      expect(countButton()).toBeNull();
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
      expect(countButton()).toBeNull();

      // 端末の下書きを読んでいる間（id はまだ無い）: パネルと右下は出すが、まだ数えない
      await rerender(<FakePage page={fakePage(null, { lang: "en" })} />);
      expect(rail()).not.toBeNull();
      expect(countButton()?.textContent).toBe("… 字");
      await act(async () => countButton()!.click());
      expect(popRows().map(([label]) => label)).toEqual(["作成", "更新"]);
      // 読み終えた
      await rerender(<FakePage page={fakePage(A, { lang: "en" })} />);
      expect(countButton()?.textContent).toBe("0 words");
      expect(popRows().map(([label]) => label)).toEqual(["作成", "更新", "文字数"]);
    });

    it("the corner shows the count (字 in ja, words in en) that follows the body; it opens the page info (dates, recording, count), from the … too", async () => {
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
      expect(countButton()?.textContent).toBe("7 字");
      expect(countButton()?.getAttribute("aria-expanded")).toBe("false");
      await act(async () => countButton()!.click());
      expect(infoPop()?.getAttribute("role")).toBe("dialog");
      expect(popRows()).toEqual([
        ["作成", localDay(summary.createdAt)],
        ["更新", localDay(summary.updatedAt)],
        ["録音", "14:38"],
        ["文字数", "7"],
      ]);
      // 説明は置かない（ⓘ のシートだけ）
      expect(infoPop()?.textContent).not.toContain("MiB");

      // 本文が変わったら、少し待ってから数え直す（打つたびには数えない）
      body = "合成の本文です。続き";
      await act(async () => listeners.forEach((listener) => listener()));
      expect(countButton()?.textContent).toBe("7 字");
      await act(async () => new Promise((resolve) => setTimeout(resolve, COUNT_DELAY_MS + 50)));
      expect(countButton()?.textContent).toBe("10 字");
      expect(popRows().at(-1)).toEqual(["文字数", "10"]);

      // 英語のページは語数
      body = "A synthetic body";
      await act(async () => listeners.forEach((listener) => listener()));
      await act(async () => new Promise((resolve) => setTimeout(resolve, COUNT_DELAY_MS + 50)));
      await rerender(<OpenedFake summary={summary} page={{ ...a, lang: "en" }} recordingSec={878} />);
      expect(countButton()?.textContent).toBe("3 words");

      // Esc で閉じてボタンへ戻る
      await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(infoPop()).toBeNull();
      expect(document.activeElement).toBe(countButton());

      // 「…」の「ページの情報」でも開き、最初の要素（ⓘ）へフォーカス
      await choose("ページの情報");
      expect(infoPop()).not.toBeNull();
      expect(document.activeElement?.getAttribute("aria-label")).toBe("容量について");

      // ⓘ は容量の説明のシート（閉じたら右下のボタンへ戻る）
      await act(async () => (document.activeElement as HTMLButtonElement).click());
      expect(dialog()?.getAttribute("aria-label")).toBe("容量について");
      expect(dialog()?.textContent).toContain("1 ページ 30 MiB まで（題名・リード・本文・本文とカバーの画像・アップロード中の画像）。");
      expect(dialog()?.textContent).toContain("録音の音声は別枠で、ページの容量には数えません。");
      await act(async () => dialogButton("閉じる").click());
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(countButton());

      // ページを離れたら、本文の知らせを受けない
      nav.pathname = "/settings";
      await rerender(null);
      expect(listeners.size).toBe(0);
    });

    it("the … has 書き出し and 削除 (the rail no longer does); 削除 asks first and leaves the page", async () => {
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          calls.push(`${init.method} ${url}`);
          return new Response(null, { status: 204 });
        }),
      );
      await mount({ pages: [page(A, "合成の題名"), page(D, "別のページ")] }, <FakePage page={fakePage(A, { flush: vi.fn(async () => (calls.push("flush"), true)) })} />);
      await choose("削除");
      expect(dialog()?.getAttribute("aria-label")).toBe("ページの削除");
      await act(async () => dialogButton("やめる").click());
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(moreButton());
      await choose("削除");
      await act(async () => dialogButton("削除する").click());
      await tick();
      expect(calls).toEqual(["flush", `DELETE /api/pages/${A}`]);
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
      // 保存済みは見える文字にしない（本文の上の表示は無く、状態は属性だけ。失敗だけヘッダーに出す）
      expect(container!.querySelector("[data-save-state]")?.getAttribute("data-save-state")).toBe("saved");
      expect(container!.querySelector("#es-main")?.textContent).not.toContain("保存済み");
      expect(container!.querySelector(".es-dt [data-save-note]")).toBeNull();

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
      let serverRevision = 4;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          const sent = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
          calls.push({ method: init.method ?? "GET", url, body: sent });
          if (url.endsWith("/versions")) return json(200, { versions: [{ version: 1, reason: "autosave", createdAt: UPDATED_AT, blockCount: 1 }] });
          if (url.endsWith("/restore")) {
            serverRevision = 5;
            return json(200, { page: { id: A, kind: "note", title: "合成の題名", lang: "ja", blocks: paragraph("戻した本文"), revision: 5, createdAt: UPDATED_AT, updatedAt: "2026-10-31T02:59:00.000Z" } });
          }
          if (url.endsWith("/translation")) {
            return json(200, {
              page: { id: A, lang: "en", revision: serverRevision },
              relation: null,
              proposal: null,
              provider: { destination: "Anthropic API", metered: true },
            });
          }
          if (url.endsWith("/share")) return json(200, { share: { status: "PRIVATE", publicId: null, url: null, updatedAt: null } });
          if (init.method === "PATCH") {
            serverRevision = (sent!.baseRevision as number) + 1;
            return json(200, { page: { id: A, revision: serverRevision } });
          }
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

    describe("the language in the publish sheet (#34 第 3 段 → 公開のシートの記事の情報)", () => {
      type Call = { method: string; url: string; body: Record<string, unknown> | null };
      // 言語は公開のシートの中（記事の情報）。シートを開いて、その中の言語の欄を見る
      const sheetLang = () => container!.querySelector<HTMLElement>('[role="dialog"][aria-label="公開"] [data-page-lang]');
      const openRail = async () => {
        if (!sheetLang()) await act(async () => container!.querySelector<HTMLButtonElement>(".es-dt .es-pubbtn")!.click());
        await tick();
      };
      const closeSheet = async () => {
        const close = [...(container!.querySelector('[role="dialog"][aria-label="公開"]')?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent === "閉じる");
        if (close) await act(async () => close.click());
      };
      const inRail = (label: string) => [...(sheetLang()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent?.trim() === label);
      const pressedLang = () => [...(sheetLang()?.querySelectorAll('button[aria-pressed="true"]') ?? [])].map((button) => button.textContent);
      const railAlert = () => sheetLang()?.querySelector('[role="alert"]')?.textContent;
      const patches = <T extends { method: string }>(calls: T[]) => calls.filter((call) => call.method === "PATCH");
      /** 保存（PATCH）を受ける合成のサーバー。`answer` で応答を差し替える（既定は revision を 1 つ進める）。 */
      function savingServer(calls: Call[], answer?: (body: Record<string, unknown>) => Response | undefined | Promise<Response | undefined>) {
        let serverRevision = 1;
        vi.stubGlobal(
          "fetch",
          vi.fn(async (url: string, init: RequestInit) => {
            const sent = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
            calls.push({ method: init.method ?? "GET", url, body: sent });
            if (init.method === undefined && url.endsWith("/translation")) {
              return json(200, {
                page: { id: A, lang: "en", revision: serverRevision },
                relation: null,
                proposal: null,
                provider: { destination: "Anthropic API", metered: true },
              });
            }
            const custom = sent ? await answer?.(sent) : undefined;
            if (custom) {
              if (custom.status === 409) {
                const conflict = await custom.clone().json() as { page?: { revision?: unknown } };
                if (typeof conflict.page?.revision === "number") serverRevision = conflict.page.revision;
              } else if (custom.ok && init.method === "PATCH") {
                serverRevision = (sent!.baseRevision as number) + 1;
              }
              return custom;
            }
            if (init.method === "PATCH") {
              serverRevision = (sent!.baseRevision as number) + 1;
              return json(200, { page: { id: A, revision: serverRevision } });
            }
            return json(500, { error: "unexpected" });
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
        expect(patches(calls)).toEqual([{ method: "PATCH", url: `/api/pages/${A}`, body: { lang: "en", baseRevision: 1 } }]);
        await act(async () => answered.resolve());
        await tick();
        expect(tip()).toBe("自分だけ · 保存済み");
        expect(railAlert()).toBeUndefined();
        expect(calls).toContainEqual({ method: "GET", url: `/api/pages/${A}/translation`, body: null });

        // 次の保存は、言語を保存したあとの revision の上に（revision をずらさない・競合にしない）
        await typeTitle("合成の題名 2");
        await saveNow();
        await tick();
        expect(calls.filter((call) => call.method === "PATCH").at(-1)).toEqual({ method: "PATCH", url: `/api/pages/${A}`, body: { title: "合成の題名 2", baseRevision: 2 } });

        // 一覧の行の言語も替わった（エディタが下書きを読み直している間は、一覧の行の言語で右下を数える）
        await closeSheet();
        await rerender(<FakePage page={fakePage(null)} />);
        expect(container!.querySelector(".es-corner .es-count")?.textContent).toBe("… words");
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
        expect(patches(calls).map((call) => call.body)).toEqual([{ lang: "en", baseRevision: 1 }]);
        expect(pressedLang()).toEqual(["日本語"]);
        expect(railAlert()).toBe(LANG_NOT_SAVED);
        expect(tip()).toBe("自分だけ · 保存に失敗しました。もう一度試します");

        // 届いたか分からない失敗だったので、戻した言語も送る
        fail = false;
        await saveNow();
        await tick();
        expect(patches(calls).at(-1)?.body).toEqual({ lang: "ja", baseRevision: 1 });
        expect(tip()).toBe("自分だけ · 保存済み");
        expect(railAlert()).toBe(LANG_NOT_SAVED);
        // 次に変えたら一言は消える
        await act(async () => inRail("English")!.click());
        await tick();
        expect(railAlert()).toBeUndefined();
        expect(calls.filter((call) => call.method === "PATCH").at(-1)?.body).toEqual({ lang: "en", baseRevision: 2 });
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
        expect(patches(calls)).toHaveLength(1);
        expect(pressedLang()).toEqual(["日本語"]);

        await act(async () => [...container!.querySelectorAll<HTMLButtonElement>("[data-conflict-band] button")].find((item) => item.textContent === "この内容で上書き")!.click());
        await tick();
        expect(patches(calls).at(-1)?.body).toMatchObject({ title: "合成の題名", lang: "ja", baseRevision: 3, overwrite: true });
        expect(container!.querySelector("[data-conflict-band]")).toBeNull();
        expect(tip()).toBe("自分だけ · 保存済み");
        // 上書きのあとは普通に変えられる
        await act(async () => inRail("English")!.click());
        await tick();
        expect(calls.filter((call) => call.method === "PATCH").at(-1)?.body).toEqual({ lang: "en", baseRevision: 4 });
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
        expect(calls.filter((call) => call.method === "PATCH").at(-1)).toEqual({ method: "PATCH", url: `/api/pages/${A}`, body: { lang: "en", baseRevision: 4 } });
        await closeSheet();
        await restoreFirstVersion();
        // 戻すのは言語を保存したあとの revision の上に
        expect(calls.find((call) => call.url.endsWith("/restore"))?.body).toEqual({ baseRevision: 5 });
        expect(body()).toBe("戻した本文");
        await openRail();
        expect(pressedLang()).toEqual(["English"]);
        await closeSheet();
        // 合成のサーバーは戻したあとの revision を 5 で返す。言語は送り直さない
        await typeTitle("合成の題名 2");
        await saveNow();
        await tick();
        expect(calls.filter((call) => call.method === "PATCH").at(-1)).toEqual({ method: "PATCH", url: `/api/pages/${A}`, body: { title: "合成の題名 2", baseRevision: 5 } });
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
        await untilAsync(async () => patches(calls).length > 0);
        expect(patches(calls)[0]?.body).toMatchObject({ title: "合成の題名", lang: "en", baseRevision: 1 });
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
  const twisty = (title: string) => [...container!.querySelectorAll<HTMLButtonElement>(".es-sb-list .es-di[aria-expanded]")].find((button) => button.querySelector(".es-di-t")?.textContent === title);

  it("出すのは 1 本の木（フォルダ › ページ › 録音のサブページ）。フォルダ（kind）の行で開閉できる", async () => {
    await mount({ pages: [{ ...page(PARENT, "鎌倉の記事"), kind: "folder" as const }, { ...inside(PARENT, CHILD, "取材メモ"), kind: "rec" as const }, { ...inside(CHILD, SUB, "文字起こし修正"), kind: "step" as const }] });
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

  it("「⋯」の「移動…」の「フォルダ」で入れる・出す（本文・revision は送らない）", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    nav.pathname = `/p/${CHILD}`;
    await mount({ pages: [{ ...page(PARENT, "鎌倉の記事"), kind: "folder" as const }, page(CHILD, "取材メモ")] }, <FakePage page={fakePage(CHILD)} />);
    await chooseMore("移動…");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("フォルダ");
    const select = sheetNamed("移動")!.querySelector<HTMLSelectElement>('select[aria-label="フォルダ"]')!;
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
      sheetNamed("移動")!.querySelector<HTMLSelectElement>('select[aria-label="フォルダ"]')!.value = "";
      sheetNamed("移動")!.querySelector<HTMLSelectElement>('select[aria-label="フォルダ"]')!.dispatchEvent(new Event("change", { bubbles: true }));
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
    await mount({ pages: [{ ...page(PARENT, "鎌倉の記事"), kind: "folder" as const }, page(CHILD, "取材メモ")] }, <FakePage page={fakePage(CHILD)} />);
    await chooseMore("移動…");
    const select = () => sheetNamed("移動")!.querySelector<HTMLSelectElement>('select[aria-label="フォルダ"]')!;
    await act(async () => {
      select().value = PARENT;
      select().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(sheetNamed("移動")!.querySelector('[role="alert"]')?.textContent).toBe("このフォルダには入れられませんでした");
    expect(select().value).toBe("");
    expect(tree()).toEqual([
      ["鎌倉の記事", 0],
      ["取材メモ", 0],
    ]);
  });

  it("「移動…」は、入れ先が無く上の段にいて、並びも動かせないページには出さない", async () => {
    nav.pathname = `/p/${CHILD}`;
    await mount({ pages: [page(CHILD, "取材メモ")] }, <FakePage page={fakePage(CHILD)} />);
    expect(await moreLabels()).not.toContain("移動…");
  });

  it("「移動…」は Esc で閉じて「⋯」へフォーカスを戻す", async () => {
    nav.pathname = `/p/${CHILD}`;
    await mount({ pages: [{ ...page(PARENT, "鎌倉の記事"), kind: "folder" as const }, page(CHILD, "取材メモ")] }, <FakePage page={fakePage(CHILD)} />);
    await chooseMore("移動…");
    expect(sheetNamed("移動")).not.toBeNull();
    await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(sheetNamed("移動")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("その他");
  });

  it("書式の帯はヘッダーに常設で（＋・画像・録音だけ。書式は選んだ文字の上）、録音は枠が受けて録音から始める画面へ移る", async () => {
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
    expect([...bar.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual(["ブロックを足す", "画像", "録音"]);
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
  async function until(condition: () => boolean) {
    for (let tries = 0; tries < 200 && !condition(); tries++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 5)));
    expect(condition()).toBe(true);
  }

  /** 「最近」の節の行（無ければ null）。 */
  const recentRows = () => {
    const group = container!.querySelector(".es-sb-group");
    return group ? [...group.querySelectorAll(".es-di-t")].map((node) => node.textContent) : null;
  };
  const railButton = (label: string) => [...container!.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => (button.getAttribute("aria-label") ?? button.textContent)?.includes(label));

  it("「最近」を隠し、ページの木と最後に開いたページの記録を残す", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(null, { status: 204 });
    }));
    nav.pathname = `/p/${OTHER}`;
    await mount({ pages: [page(FOLDER, "鎌倉の記事"), page(OTHER, "別のページ")], recent: [page(FOLDER, "鎌倉の記事")] }, <p>本文</p>);
    expect(recentRows()).toBeNull();
    expect(rows()).toEqual(["鎌倉の記事", "別のページ"]);
    await rerender(<OpenedPage summary={page(OTHER, "別のページ")} />);
    await until(() => calls.some((call) => call.includes("/open")));
    expect(calls.filter((call) => call.includes("/open"))).toEqual([`POST /api/pages/${OTHER}/open`]);
    expect(recentRows()).toBeNull();
  });

  it("「⋯」の「移動…」の「並び」で 1 つ動かし、木の順が変わる", async () => {
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
    await chooseMore("移動…");

    const up = railButton("1 つ上へ")!;
    expect(up.getAttribute("aria-disabled")).toBeNull();
    expect(railButton("1 つ下へ")?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => up.click());
    await until(() => rows()[0] === "別のページ");
    expect(calls.filter((call) => call.url.includes("/order"))).toEqual([{ url: `/api/pages/${OTHER}/order`, body: { move: "up" } }]);
    // 端に来たので「上へ」が押せなくなる
    await until(() => railButton("1 つ上へ")?.getAttribute("aria-disabled") === "true");
  });

  it("一覧を一部しか読み込んでいなくても、並びはサーバーが確定した値で入れ替える（読み込んでいない兄弟とずれない）", async () => {
    // 保存の順は A（1）・B（2、まだ読み込んでいない）・C（3）。画面には A と C だけがある
    const A = FOLDER;
    const C = OTHER;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/order")) {
          // A を 1 つ下へ: サーバーでは B と入れ替わる（B・A・C）。画面の持っていない B も含めて確定した値を返す
          return new Response(JSON.stringify({ moved: true, orders: [{ id: "unloaded-B", sortOrder: 1 }, { id: A, sortOrder: 2 }, { id: C, sortOrder: 3 }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    nav.pathname = `/p/${A}`;
    await mount({ pages: [{ ...page(A, "A の記事"), sortOrder: 1 }, { ...page(C, "C の記事"), sortOrder: 3 }] }, <FakePage page={fakePage(A)} />);
    expect(rows()).toEqual(["A の記事", "C の記事"]);
    await chooseMore("移動…");

    await act(async () => railButton("1 つ下へ")!.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // 持っている行だけで入れ替えると C・A になってしまう。サーバーでは A は B の後ろに行っただけで、C の前のまま
    expect(rows()).toEqual(["A の記事", "C の記事"]);
  });

  it("フォルダの「⋯」は 書き出し（.zip）・削除 だけ。フォルダでないページに「フォルダの背景…」は無い", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
    nav.pathname = `/p/${FOLDER}`;
    await mount({ pages: [{ ...page(FOLDER, "鎌倉の記事"), kind: "folder" }, inside(FOLDER, INSIDE, "取材メモ")] }, <FakePage page={fakePage(FOLDER)} />);
    expect(await moreLabels()).toEqual(["書き出し.zip", "削除中のページも"]);
    // AI・ページ・公開は出さない（パネルも、右上のボタンも）
    expect(container!.querySelector('.es-dt button[aria-label="AIと作るを出す"], .es-dt button[aria-label="ページを出す"]')).toBeNull();
    expect(container!.querySelector<HTMLElement>('.es-pn[data-panel="ai"]')?.hidden ?? true).toBe(true);
    nav.pathname = `/p/${INSIDE}`;
    await rerender(<FakePage page={fakePage(INSIDE)} />);
    const labels = await moreLabels();
    expect(labels).not.toContain("フォルダの背景…");
    expect(labels).not.toContain("書き出し.zip");
  });

  it("フォルダを削除するときは中のページの数を言う", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
    nav.pathname = `/p/${FOLDER}`;
    await mount({ pages: [{ ...page(FOLDER, "鎌倉の記事"), kind: "folder" }, inside(FOLDER, INSIDE, "取材メモ"), inside(FOLDER, OTHER, "別のメモ")] }, <FakePage page={fakePage(FOLDER)} />);
    await chooseMore("削除");
    expect(sheetNamed("フォルダの削除")?.querySelector("h2")?.textContent).toBe("「鎌倉の記事」と中の 2 ページを削除しますか？");
  });

  it("フォルダの書き出しは、まだ届いていない本文の変更を保存してから始める（保存できなければ始めない）", async () => {
    const clicked: string[] = [];
    const click_ = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      clicked.push(this.getAttribute("href") ?? "");
    };
    try {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ fields: { entities: [], terms: [] } }), { status: 200, headers: { "content-type": "application/json" } })));
      nav.pathname = `/p/${FOLDER}`;
      let finishSave: (saved: boolean) => void = () => undefined;
      const flush = vi.fn(() => new Promise<boolean>((resolve) => { finishSave = resolve; }));
      await mount({ pages: [{ ...page(FOLDER, "鎌倉の記事"), kind: "folder" }, inside(FOLDER, INSIDE, "取材メモ")] }, <FakePage page={fakePage(FOLDER, { flush })} />);
      // 保存を待っているあいだは、ダウンロードを始めない
      await chooseMore("書き出し");
      expect(flush).toHaveBeenCalledTimes(1);
      expect(clicked).toEqual([]);
      // 保存できたら始める
      await act(async () => finishSave(true));
      expect(clicked).toEqual([`/api/pages/${FOLDER}/export.zip`]);

      // 保存できなければ始めず、理由を出す
      await chooseMore("書き出し");
      await act(async () => finishSave(false));
      expect(clicked).toHaveLength(1);
      expect(container!.textContent).toContain("書き出しの前に変更を保存できませんでした");
    } finally {
      HTMLAnchorElement.prototype.click = click_;
    }
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
      await mount({ pages: [{ ...page(FOLDER, "鎌倉の記事"), kind: "folder" }, inside(FOLDER, INSIDE, "取材メモ")] }, <FakePage page={fakePage(FOLDER)} />);
      await chooseMore("書き出し");
      expect(clicked).toEqual([`/api/pages/${FOLDER}/export.zip`]);
    } finally {
      HTMLAnchorElement.prototype.click = click_;
    }
  });
});

describe("EditorFrame: 左の一覧のドラッグで入れ子・並べ替え", () => {
  const F = "00000000-0000-4000-8000-0000000000d0";
  const X = "00000000-0000-4000-8000-0000000000d1";
  const T1 = "00000000-0000-4000-8000-0000000000d2";
  const T2 = "00000000-0000-4000-8000-0000000000d3";
  const T3 = "00000000-0000-4000-8000-0000000000d4";
  const top = (id: string, title: string, sortOrder: number): PageSummary => ({ ...page(id, title), sortOrder });
  const calls: { url: string; method?: string; body?: unknown }[] = [];

  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
        const body = url.includes("/order") ? { moved: true } : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });

  const rowOf = (title: string) => [...container!.querySelectorAll<HTMLElement>(".es-sb-list .es-dirow")].find((row) => row.querySelector(".es-di-t")?.textContent === title)!;
  const tree = () =>
    [...container!.querySelectorAll(".es-sb-list li")].map((li) => {
      let depth = 0;
      for (let at = li.parentElement; at && !at.classList.contains("es-sb-list"); at = at.parentElement) if (at.tagName === "UL") depth++;
      return [li.querySelector(".es-di-t")?.textContent, depth - 1];
    });
  /** 行の箱を 0〜40px に（上 10px は before、下 10px は after、真ん中は into）。 */
  const sizeRows = () => {
    for (const row of container!.querySelectorAll<HTMLElement>(".es-dirow")) {
      row.getBoundingClientRect = () => ({ top: 0, bottom: 40, height: 40, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    }
  };
  const data = new Map<string, string>();
  const transfer = { setData: (type: string, value: string) => void data.set(type, value), getData: (type: string) => data.get(type) ?? "", dropEffect: "none", effectAllowed: "all" };
  const fire = async (target: Element, type: string, clientY = 20) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    Object.defineProperty(event, "clientY", { value: clientY });
    await act(async () => {
      target.dispatchEvent(event);
    });
    return event;
  };
  /** 行をつかんで、別の行の上（y）で落とす。落とせたか（dragover が preventDefault されたか）を返す。 */
  const dragTo = async (from: string, to: string, clientY: number) => {
    sizeRows();
    await fire(rowOf(from), "dragstart");
    const over = await fire(rowOf(to), "dragover", clientY);
    if (over.defaultPrevented) await fire(rowOf(to), "drop", clientY);
    await fire(rowOf(from), "dragend");
    for (let tries = 0; tries < 20; tries++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    return over.defaultPrevented;
  };

  it("真ん中に落とすとそのフォルダへ入れる（PATCH parent）。自分の中には落とせない", async () => {
    await mount({ pages: [{ ...top(F, "鎌倉の記事", 1), kind: "folder" as const }, top(X, "取材メモ", 2)] });
    expect(rowOf("取材メモ").getAttribute("draggable")).toBe("true");
    expect(await dragTo("取材メモ", "鎌倉の記事", 20)).toBe(true);
    expect(calls).toEqual([{ url: `/api/pages/${X}/parent`, method: "PATCH", body: { parent: F } }]);
    expect(tree()).toEqual([
      ["鎌倉の記事", 0],
      ["取材メモ", 1],
    ]);
    // フォルダはどこへも入れられない（入れ子にしない）
    calls.length = 0;
    expect(await dragTo("鎌倉の記事", "取材メモ", 20)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("前・後に落とすと、同じ階層の並びを 1 歩ずつ動かして、落とした行の前・後にする", async () => {
    await mount({ pages: [top(T1, "一", 1), top(T2, "二", 2), top(T3, "三", 3)] });
    expect(await dragTo("三", "一", 4)).toBe(true);
    expect(calls).toEqual([
      { url: `/api/pages/${T3}/order`, method: "PATCH", body: { move: "up" } },
      { url: `/api/pages/${T3}/order`, method: "PATCH", body: { move: "up" } },
    ]);
    expect(tree().map(([title]) => title)).toEqual(["三", "一", "二"]);

    calls.length = 0;
    expect(await dragTo("三", "二", 36)).toBe(true);
    expect(calls.map((call) => call.body)).toEqual([{ move: "down" }, { move: "down" }]);
    expect(tree().map(([title]) => title)).toEqual(["一", "二", "三"]);
  });

  it("フォルダの中の行を上の段の行の後に落とすと、先にフォルダから出してから並べる", async () => {
    await mount({ pages: [{ ...top(F, "鎌倉の記事", 1), kind: "folder" as const }, { ...page(X, "取材メモ"), parent: F }, top(T1, "一", 2)] });
    expect(tree()).toEqual([
      ["鎌倉の記事", 0],
      ["取材メモ", 1],
      ["一", 0],
    ]);
    expect(await dragTo("取材メモ", "鎌倉の記事", 36)).toBe(true);
    expect(calls[0]).toEqual({ url: `/api/pages/${X}/parent`, method: "PATCH", body: { parent: null } });
    expect(calls.slice(1).every((call) => call.url === `/api/pages/${X}/order`)).toBe(true);
    expect(tree()).toEqual([
      ["鎌倉の記事", 0],
      ["取材メモ", 0],
      ["一", 0],
    ]);
  });

  it("並びが届かなければ止めて一言（ヘッダー。「移動…」のシートを開いているときはシートの中）", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return new Response(JSON.stringify({ error: "internal" }), { status: 500, headers: { "content-type": "application/json" } });
    }));
    nav.pathname = `/p/${T3}`;
    await mount({ pages: [top(T1, "一", 1), top(T2, "二", 2), top(T3, "三", 3)] }, <p>本文</p>);
    expect(await dragTo("三", "一", 4)).toBe(true);
    expect(calls.filter((call) => call.url.includes("/order"))).toHaveLength(1);
    expect(tree().map(([title]) => title)).toEqual(["一", "二", "三"]);
    expect(container!.querySelector('.es-dt [role="alert"]')?.textContent).toBe("並びを変えられませんでした");
  });
});

describe("EditorFrame: 「写真」のパネルと、何も足していない新しいページ", () => {
  const A = "00000000-0000-4000-8000-0000000000a1";
  const NEW = "00000000-0000-4000-8000-0000000000b2";
  const SECOND_TAB = "00000000-0000-4000-8000-0000000000b3";
  const NEW_HOLDER = "00000000-0000-4000-8000-0000000000b4";
  const PHOTO = "00000000-0000-4000-8000-0000000000c3";
  const OTHER_PHOTO = "00000000-0000-4000-8000-0000000000c4";
  const UPDATED = "2026-10-31T02:00:00.000Z";
  type Call = { url: string; method: string; body: Record<string, unknown> | null; keepalive: boolean };
  const calls: Call[] = [];
  // 写真のパネルは既定で閉じている（右上の「写真を出す」で元のドック（右）の下に出る）
  const photosButton = () => container!.querySelector<HTMLButtonElement>('.es-dt button[aria-label="写真を出す"]');
  const photosPane = () => container!.querySelector<HTMLElement>('.es-pn[data-panel="photos"]');
  const openPhotos = () => act(async () => photosButton()!.click());
  const tick = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const sends = () => calls.filter((call) => call.method !== "GET");

  /** 合成のサーバー（ページの作成・保存・写真の一覧・外す・捨てる）。 */
  function server(options: { photos?: string[]; discarded?: boolean; discard?: (id: string) => Response | undefined } = {}) {
    let revision = 1;
    const photos = [...(options.photos ?? [PHOTO])];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET";
        calls.push({ url, method, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null, keepalive: init.keepalive === true });
        const ok = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (url === "/api/pages" && method === "POST") return ok(201, { page: { id: NEW, revision: 1 } });
        // タブを足す（新しいタブの id と、入れ物の id）
        if (/\/api\/pages\/[^/]+\/tabs$/.test(url) && method === "POST") return ok(201, { page: { id: SECOND_TAB, page: NEW_HOLDER } });
        if (/\/api\/pages\/[^/]+$/.test(url) && method === "PATCH") return ok(200, { page: { id: url.split("/").at(-1), revision: ++revision } });
        if (url.endsWith("/images") && method === "GET") {
          return ok(200, { images: photos.map((assetId) => ({ assetId, bytes: 2048, contentType: "image/png", alt: null, credit: null, consent: false, createdAt: UPDATED })) });
        }
        if (/\/images\/[^/]+$/.test(url) && method === "DELETE") {
          photos.splice(photos.indexOf(url.split("/").at(-1)!), 1);
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/discard") && method === "POST") return options.discard?.(url.split("/").at(-2)!) ?? ok(200, { discarded: options.discarded ?? true });
        return ok(404, { error: "not_found" });
      }),
    );
  }

  beforeEach(() => {
    calls.length = 0;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });
  const candidates = () => JSON.parse(window.localStorage.getItem(LEFT_EMPTY_PAGES_KEY) ?? "[]") as string[];

  it("is a closed 写真 panel on an open page (a header button that opens it in the right dock), reads nothing until opened, and is absent elsewhere", async () => {
    server();
    nav.pathname = "/settings";
    await mount({ pages: [page(A, "合成の題名")] });
    expect(photosButton()).toBeNull();
    expect(photosPane()).toBeNull();
    nav.pathname = `/p/${A}`;
    await rerender(<PageEditor page={{ id: A, title: "合成の題名", blocks: [], revision: 1, updatedAt: UPDATED }} drafts={null} />);
    expect(photosButton()).not.toBeNull();
    expect(photosPane()?.hidden).toBe(true);
    expect(calls.filter((call) => call.url.endsWith("/images"))).toEqual([]);
    await openPhotos();
    await tick();
    expect(photosPane()?.hidden).toBe(false);
    expect(photosPane()?.dataset).toMatchObject({ dock: "right", index: "2" });
    expect(photosPane()!.querySelector(".es-pn-hd h2")?.textContent).toBe("写真");
    expect(photosButton()).toBeNull();
    expect(calls.filter((call) => call.url.endsWith("/images")).map((call) => call.url)).toEqual([`/api/pages/${A}/images`]);
    expect(container!.querySelector(`.es-ph-tile[data-asset-id="${PHOTO}"]`)).not.toBeNull();
    // × で閉じると、右上にまたボタン
    await act(async () => photosPane()!.querySelector<HTMLButtonElement>('button[aria-label="写真を閉じる"]')!.click());
    expect(photosPane()?.hidden).toBe(true);
    expect(photosButton()).not.toBeNull();
  });

  it("removes a photo on the server first, then from every place in the body and from the cover, through the autosave", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    server({ photos: [PHOTO, OTHER_PHOTO] });
    nav.pathname = `/p/${A}`;
    const image = (assetId: string) => ({ type: "image", attrs: { assetId, alt: null, caption: null, credit: null, consent: false } });
    const blocks = [image(PHOTO), { type: "paragraph", content: [{ type: "text", text: "本文" }] }, image(PHOTO), image(OTHER_PHOTO), { type: "paragraph" }];
    await mount({ pages: [page(A, "合成の題名")] }, <PageEditor page={{ id: A, title: "合成の題名", blocks, cover: PHOTO, revision: 1, updatedAt: UPDATED }} drafts={null} />);
    await openPhotos();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const tile = container!.querySelector<HTMLButtonElement>(`.es-ph-tile[data-asset-id="${PHOTO}"]`)!;
    expect(tile.getAttribute("aria-label")).toContain("本文で使っています");
    await act(async () => tile.click());
    await act(async () => buttonByText("パネルから外す", dialog()!)!.click());
    expect(dialog()!.textContent).toContain("本文の 2 か所からも消えます。元に戻せません。");
    await act(async () => buttonByText("外す", dialog()!)!.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    const remove = sends().findIndex((call) => call.method === "DELETE");
    const save = sends().findIndex((call) => call.method === "PATCH");
    expect(sends()[remove]?.url).toBe(`/api/pages/${A}/images/${PHOTO}`);
    expect(save).toBeGreaterThan(remove);
    const saved = sends()[save]!.body!;
    expect(saved.cover).toBeNull();
    expect(JSON.stringify(saved.blocks)).not.toContain(PHOTO);
    expect(JSON.stringify(saved.blocks)).toContain(OTHER_PHOTO);
    expect(container!.querySelector(`.es-ph-tile[data-asset-id="${PHOTO}"]`)).toBeNull();
  });

  it("narrow: the panel is the whole screen without dragging; tapping 本文に入れる goes back to the page with the photo in it", async () => {
    narrow = true;
    server();
    nav.pathname = `/p/${A}`;
    await mount({ pages: [page(A, "合成の題名")], initialNarrow: true }, <PageEditor page={{ id: A, title: "合成の題名", blocks: [{ type: "paragraph", content: [{ type: "text", text: "本文" }] }], revision: 1, updatedAt: UPDATED }} drafts={null} />);
    expect(shell().view).toBe("page");
    await openPhotos();
    expect(shell().view).toBe("rail");
    await tick();
    const tile = container!.querySelector<HTMLButtonElement>(`.es-ph-tile[data-asset-id="${PHOTO}"]`)!;
    expect(tile.getAttribute("draggable")).toBe("false");
    await act(async () => tile.click());
    await act(async () => buttonByText("本文に入れる", dialog()!)!.click());
    expect(shell().view).toBe("page");
    expect(container!.querySelector(`.ProseMirror img[src="/api/assets/${PHOTO}"]`)).not.toBeNull();
  });

  it("works on a page made the moment it opens, and discards it when left without anything added", async () => {
    server();
    nav.pathname = "/p/new";
    window.history.replaceState(null, "", "/p/new");
    await mount({}, <NewPage />);
    nav.pathname = window.location.pathname;
    await rerender(<NewPage />);
    expect(window.location.pathname).toBe(`/p/${NEW}`);
    expect(sends().filter((call) => call.url === "/api/pages")).toHaveLength(1);
    // このタブで作ったページの印（再読み込みのあとも分かる）
    expect(JSON.parse(window.sessionStorage.getItem(TAB_CREATED_PAGES_KEY)!)).toEqual([NEW]);
    // 作ったばかりのページでも、写真をすぐ上げられる（パネルはそのページの id で読む）
    await openPhotos();
    await tick();
    expect(calls.some((call) => call.url === `/api/pages/${NEW}/images`)).toBe(true);
    expect(rows()).toEqual(["無題"]);
    // 別の画面へ移る（この下書きのエディタが外れる）
    nav.pathname = "/settings";
    await rerender(<p>設定</p>);
    await tick();
    expect(sends().filter((call) => call.url.endsWith("/discard"))).toEqual([{ url: `/api/pages/${NEW}/discard`, method: "POST", body: null, keepalive: false }]);
    expect(rows()).toEqual([]);
  });

  it("shows the tab bar on a page made the moment it opens (＋ is held while it is made), and adding a tab keeps the blank page", async () => {
    // 作る間（POST が返るまで）は ＋ を押せない。帯の場所は先に取ってある
    let release: () => void = () => undefined;
    const made = new Promise<void>((resolve) => {
      release = resolve;
    });
    server();
    const send = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/pages" && init?.method === "POST") await made;
      return send(url, init);
    }));
    nav.pathname = "/p/new";
    window.history.replaceState(null, "", "/p/new");
    await mount({}, <NewPage />);
    const add = () => container!.querySelector<HTMLButtonElement>(".es-tabbar .es-tab-add");
    expect(add()).not.toBeNull();
    expect(add()!.disabled).toBe(true);
    await act(async () => release());
    nav.pathname = window.location.pathname;
    await rerender(<NewPage />);
    await tick();
    // 作ったあと: 帯の ＋ が押せる（再読み込みして /p/{id} を開き直さなくても、タブを足せる）
    expect(window.location.pathname).toBe(`/p/${NEW}`);
    expect(add()!.disabled).toBe(false);
    await act(async () => add()!.click());
    await tick();
    expect(sends().filter((call) => call.url === `/api/pages/${NEW}/tabs`)).toHaveLength(1);
    expect(nav.push).toHaveBeenCalledWith(`/p/${SECOND_TAB}`);
    // タブを足したページは、何も足していない新しいページではない: 印が外れ、次のタブへ移っても捨てない
    expect(window.sessionStorage.getItem(TAB_CREATED_PAGES_KEY)).toBeNull();
    nav.pathname = `/p/${SECOND_TAB}`;
    await rerender(<p>次のタブ</p>);
    await tick();
    expect(sends().filter((call) => call.url.endsWith("/discard"))).toEqual([]);
  });

  it("a page made inside a folder (/p/new?in=) keeps that folder for the tab bar, so the tab added from it lands in the same folder", async () => {
    const FOLDER = "00000000-0000-4000-8000-0000000000f5";
    server();
    nav.pathname = "/p/new";
    nav.search = `in=${FOLDER}`;
    window.history.replaceState(null, "", `/p/new?in=${FOLDER}`);
    await mount({ pages: [{ ...page(FOLDER, "鎌倉の取材"), kind: "folder" as const }] }, <NewPage />);
    // 作ったあとの URL の置換で ?in= は消える（useSearchParams も空になる）
    nav.pathname = window.location.pathname;
    nav.search = "";
    await rerender(<NewPage />);
    await tick();
    expect(window.location.pathname).toBe(`/p/${NEW}`);
    await act(async () => container!.querySelector<HTMLButtonElement>(".es-tabbar .es-tab-add")!.click());
    await tick();
    // 足したタブの行も、フォルダの中（深さ 1）に出る。ルート（深さ 0）には出ない
    const depths = [...container!.querySelectorAll(".es-sb-list li")].map((li) => {
      let depth = 0;
      for (let at = li.parentElement; at && !at.classList.contains("es-sb-list"); at = at.parentElement) if (at.tagName === "UL") depth++;
      return [li.querySelector(".es-di-t")?.textContent, depth - 1] as const;
    });
    expect(depths.filter(([title]) => title === "無題").every(([, depth]) => depth === 1)).toBe(true);
    expect(depths.some(([title]) => title === "無題")).toBe(true);
  });

  it("on pagehide (close, reload) does not discard: it only leaves the page as a candidate, and the row stays", async () => {
    server();
    nav.pathname = "/p/new";
    window.history.replaceState(null, "", "/p/new");
    await mount({}, <NewPage />);
    nav.pathname = window.location.pathname;
    await rerender(<NewPage />);
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await tick();
    expect(sends().filter((call) => call.url.endsWith("/discard"))).toEqual([]);
    expect(candidates()).toEqual([NEW]);
    expect(rows()).toEqual(["無題"]);
  });

  it("on start, discards the candidates except the page being opened, and keeps those that did not get through", async () => {
    const X = "00000000-0000-4000-8000-0000000000d5";
    const Y = "00000000-0000-4000-8000-0000000000d6";
    const Z = "00000000-0000-4000-8000-0000000000d7";
    window.localStorage.setItem(LEFT_EMPTY_PAGES_KEY, JSON.stringify([NEW, X, Y, Z]));
    server({
      discard: (id) =>
        id === Y
          ? new Response(JSON.stringify({ error: "internal" }), { status: 500, headers: { "content-type": "application/json" } })
          : id === Z
            ? new Response(JSON.stringify({ discarded: false }), { status: 200, headers: { "content-type": "application/json" } })
            : undefined,
    });
    // 再読み込みで、捨てる候補の NEW を開き直した
    nav.pathname = `/p/${NEW}`;
    await mount({ pages: [page(NEW, ""), page(X, ""), page(Y, ""), page(Z, "")] }, <p>合成の中身</p>);
    await tick();
    await tick();
    expect(sends().filter((call) => call.url.endsWith("/discard")).map((call) => call.url).sort()).toEqual([X, Y, Z].map((id) => `/api/pages/${id}/discard`).sort());
    // 消えた X だけ一覧から外れる。今開いている NEW は捨てない（候補からも外す）。届かなかった Y は候補に戻す
    expect(rows()).toEqual(["無題", "無題", "無題"]);
    expect(candidates()).toEqual([Y]);
  });

  it("on the desktop home it waits for where the home goes, then spares that page (the redirect target is not deleted under it)", async () => {
    const X = "00000000-0000-4000-8000-0000000000d5";
    window.localStorage.setItem(LEFT_EMPTY_PAGES_KEY, JSON.stringify([NEW, X]));
    server();
    nav.pathname = "/";
    await mount({ pages: [page(NEW, ""), page(X, "")] }, <p>ホーム</p>);
    await tick();
    await tick();
    // `/` のあいだは頼まない（最後に開いたページへ移る途中で、移り先がまだ決まっていない）
    expect(sends().filter((call) => call.url.endsWith("/discard"))).toEqual([]);
    expect(candidates()).toEqual([NEW, X]);
    // 最後に開いたページ NEW へ移った: NEW は捨てず（候補からも外す）、ほかの X だけ捨てる
    nav.pathname = `/p/${NEW}`;
    await rerender(<p>合成の中身</p>);
    await tick();
    await tick();
    expect(sends().filter((call) => call.url.endsWith("/discard")).map((call) => call.url)).toEqual([`/api/pages/${X}/discard`]);
    expect(rows()).toEqual(["無題"]);
    expect(candidates()).toEqual([]);
  });

  it("on the narrow home (the list screen, nothing redirects) it discards the candidates right away", async () => {
    narrow = true;
    const X = "00000000-0000-4000-8000-0000000000d5";
    window.localStorage.setItem(LEFT_EMPTY_PAGES_KEY, JSON.stringify([NEW, X]));
    server();
    nav.pathname = "/";
    await mount({ pages: [page(NEW, ""), page(X, "")], initialNarrow: true }, <p>ホーム</p>);
    await tick();
    await tick();
    expect(sends().filter((call) => call.url.endsWith("/discard")).map((call) => call.url).sort()).toEqual([NEW, X].map((id) => `/api/pages/${id}/discard`).sort());
    expect(rows()).toEqual([]);
    expect(candidates()).toEqual([]);
  });

  it("does not ask when the new page got a title, nor for a page this tab did not create", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    server();
    nav.pathname = "/p/new";
    window.history.replaceState(null, "", "/p/new");
    await mount({}, <NewPage />);
    nav.pathname = window.location.pathname;
    await rerender(<NewPage />);
    const title = container!.querySelector<HTMLTextAreaElement>("textarea.page-title")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(title, "合成の題名");
      title.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(1500);
    });
    nav.pathname = "/settings";
    await rerender(<p>設定</p>);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(sends().filter((call) => call.url.endsWith("/discard"))).toEqual([]);

    // このタブで作っていない既存のページは、空でも頼まない
    nav.pathname = `/p/${A}`;
    await rerender(<PageEditor page={{ id: A, title: "", blocks: [], revision: 1, updatedAt: UPDATED }} drafts={null} />);
    nav.pathname = "/settings";
    await rerender(<p>設定</p>);
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(sends().filter((call) => call.url.endsWith("/discard"))).toEqual([]);
  });
});

describe("EditorFrame: 分割ビュー（右に並べたページ・パネルの配置。設計 §5.5）", () => {
  const A = "00000000-0000-4000-8000-0000000000a1";
  const B = "00000000-0000-4000-8000-0000000000b1";
  const C = "00000000-0000-4000-8000-0000000000c1";
  const UPDATED_AT = "2026-11-05T01:00:00.000Z";
  const LAYOUT_KEY = "niho-editor:layout:v2";
  const LAYOUT_KEY_V1 = "niho-editor:layout:v1";
  const pane = (id: string) => container!.querySelector<HTMLElement>(`.es-pn[data-panel="${id}"]`)!;
  const savedDocks = () => {
    const saved = JSON.parse(window.localStorage.getItem(LAYOUT_KEY)!) as { docks: Record<"left" | "right", { id: string }[]> };
    return { left: saved.docks.left.map((item) => item.id), right: saved.docks.right.map((item) => item.id) };
  };

  /** ページの中の PageEditor の代わり（枠に登録すると、AI のレールが出る）。 */
  function FakePage({ id }: { id: string }) {
    const { attachPage } = useEditorFrame();
    useEffect(
      () =>
        attachPage({
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
        }),
      [attachPage, id],
    );
    return <p>合成の本文</p>;
  }
  const sideJson = (title: string, text: string, revision = 2) =>
    new Response(JSON.stringify({ page: { id: B, title, blocks: [{ type: "paragraph", content: [{ type: "text", text }] }], revision, updatedAt: UPDATED_AT } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const pages = () => [page(A, "メインのページ"), page(B, "右のページ"), page(C, "三つ目")];
  const sideReads = (fetcher: ReturnType<typeof vi.fn>) => (fetcher.mock.calls as unknown as [string][]).filter(([url]) => url === `/api/pages/${B}`).length;
  const rowButton = (title: string) => [...container!.querySelectorAll<HTMLButtonElement>(".es-sb-list .es-di")].find((button) => button.querySelector(".es-di-t")?.textContent === title)!;
  const tick = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const shellRoot = () => container!.querySelector<HTMLElement>("[data-editor-shell]")!;
  /** パネルの見出しを掴んで、窓の横の位置 x に落とす（ドックを移すのはドラッグだけ。jsdom の枠の箱は 0 なので y は効かない）。 */
  const dropPanel = async (type: string, clientX: number) => {
    for (const name of ["dragover", "drop"]) {
      const event = new Event(name, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        clientX: { value: clientX },
        clientY: { value: 10 },
        dataTransfer: { value: { types: [type], getData: () => "", dropEffect: "none" } },
      });
      await act(async () => void shellRoot().dispatchEvent(event));
    }
  };
  let fetcher: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    nav.pathname = `/p/${A}`;
    window.history.replaceState(null, "", `/p/${A}`);
    window.localStorage.clear();
    // 広い画面（1680px）。jsdom の既定（1024px）では一覧が細い列に畳まれる
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1680);
    fetcher = vi.fn(async (url: string) => (url === `/api/pages/${B}` ? sideJson("右のページ", "取材メモの本文") : new Response("{}", { status: 404 })));
    vi.stubGlobal("fetch", fetcher);
  });
  afterEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.restoreAllMocks();
  });

  it("?side= に別のページの UUID があれば、右に読むだけのページを出す（題名は 1 か所、一覧の行に「右に表示中」）", async () => {
    nav.search = `side=${B}`;
    await mount({ pages: pages() }, <FakePage id={A} />);
    await tick();
    expect(shellRoot().dataset).toMatchObject({ layout: "dock", wide: "true" });
    const side = container!.querySelector<HTMLElement>(".es-side")!;
    expect(side.getAttribute("aria-label")).toBe("右に並べたページ");
    expect([...side.querySelectorAll(".es-side-tt")].map((node) => node.textContent)).toEqual(["右のページ"]);
    expect(side.querySelector('[aria-label="右のページの本文"]')!.textContent).toBe("取材メモの本文");
    expect(side.querySelector('[aria-label="右のページの本文"]')!.getAttribute("contenteditable")).toBe("false");
    expect(sideReads(fetcher)).toBe(1);
    expect(rowButton("右のページ").querySelector(".es-di-side")?.textContent).toBe("右に表示中");
    // 境目（左のドック｜メイン｜右のページ｜右のドック）と、右のドックの中の上下（ページ｜AI）
    expect([...container!.querySelectorAll('[role="separator"]')].map((node) => node.getAttribute("aria-label"))).toEqual([
      "左のドックの幅",
      "右に並べたページの幅",
      "右のドックの幅",
      "「ページ」と「AIと作る」の境目",
    ]);
  });

  it("side がメインと同じ・UUID の形でない・900px 未満なら出さない（URL は消さない）", async () => {
    nav.search = `side=${A}`;
    await mount({ pages: pages() }, <FakePage id={A} />);
    await tick();
    expect(container!.querySelector(".es-side")).toBeNull();
    await moveTo(`/p/${A}`, "side=not-a-page");
    await tick();
    expect(container!.querySelector(".es-side")).toBeNull();
    expect(sideReads(fetcher)).toBe(0);
    await act(async () => root!.unmount());
    root = null;
    container!.remove();

    narrow = true;
    nav.search = `side=${B}`;
    await mount({ pages: pages(), initialNarrow: true }, <FakePage id={A} />);
    await tick();
    expect(shellRoot().dataset.wide).toBe("false");
    expect(container!.querySelector(".es-side, .es-sash, [role=\"separator\"]")).toBeNull();
    expect(sideReads(fetcher)).toBe(0);
    expect(nav.replace).not.toHaveBeenCalled();
    // 狭い画面では、置き場所の操作も出さない（AI の置き場所・一覧の掴む所）。行の「…」は削除だけなので狭くても出す
    expect(aiMock.props?.placement).toBeUndefined();
    expect(container!.querySelector(".es-sb-top")!.hasAttribute("draggable")).toBe(false);
    expect(rowButton("三つ目").closest(".es-dirow")!.querySelector(".es-di-more")).not.toBeNull();
  });

  it("一覧でメインを替えても右のページは残す。右のページを一覧で開くとメインと入れ替える", async () => {
    nav.search = `side=${B}`;
    await mount({ pages: pages() }, <FakePage id={A} />);
    await tick();
    await act(async () => rowButton("三つ目").click());
    expect(nav.push).toHaveBeenLastCalledWith(`/p/${C}?side=${B}`);
    await act(async () => rowButton("右のページ").click());
    await tick();
    expect(nav.push).toHaveBeenLastCalledWith(`/p/${B}?side=${A}`);
  });

  it("行の「…」の削除で、右に並べたページがその中のページなら右を閉じる（メインは動かさない）", async () => {
    nav.search = `side=${B}`;
    window.history.replaceState(null, "", `/p/${A}?side=${B}`);
    const replaceState = vi.spyOn(window.history, "replaceState");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        return url === `/api/pages/${B}` ? sideJson("右のページ", "取材メモの本文") : new Response("{}", { status: 404 });
      }),
    );
    // 「三つ目」(C) の中に、右のページ (B) がある
    await mount({ pages: [page(A, "メインのページ"), page(C, "三つ目"), { ...page(B, "右のページ"), parent: C }] }, <FakePage id={A} />);
    await tick();
    expect(container!.querySelector(".es-side")).not.toBeNull();
    const row = rowButton("三つ目").closest<HTMLElement>(".es-dirow")!;
    await act(async () => row.querySelector<HTMLButtonElement>(".es-di-more")!.click());
    await act(async () => container!.querySelector<HTMLButtonElement>('[role="menu"][aria-label="ページのメニュー"] [role="menuitem"]')!.click());
    const confirm = [...container!.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === "削除する")!;
    await act(async () => confirm.click());
    await tick();
    expect(replaceState).toHaveBeenLastCalledWith(null, "", `/p/${A}`);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("⇄ は入れ替え（画面の移動）、× と ⌥クリックは履歴に積まずに ?side= を付け外す", async () => {
    nav.search = `side=${B}`;
    window.history.replaceState(null, "", `/p/${A}?side=${B}`);
    const replaceState = vi.spyOn(window.history, "replaceState");
    await mount({ pages: pages() }, <FakePage id={A} />);
    await tick();
    await act(async () => container!.querySelector<HTMLButtonElement>('button[aria-label="メインと入れ替える"]')!.click());
    await tick();
    expect(nav.push).toHaveBeenLastCalledWith(`/p/${B}?side=${A}`);
    await act(async () => container!.querySelector<HTMLButtonElement>('button[aria-label="右のページを閉じる"]')!.click());
    expect(replaceState).toHaveBeenLastCalledWith(null, "", `/p/${A}`);
    expect(nav.push).toHaveBeenCalledTimes(1);

    // 行の ⌥クリックで右に並べる（メインは替えない。メニューからは並べない）
    await act(async () => void rowButton("三つ目").dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true })));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", `/p/${A}?side=${C}`);
    await act(async () => void rowButton("右のページ").dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true })));
    expect(replaceState).toHaveBeenLastCalledWith(null, "", `/p/${A}?side=${B}`);
    expect(nav.push).toHaveBeenCalledTimes(1);
  });

  it("入れ替える前に保存できなければ移らず、ヘッダーに一言出す（保存できたら入れ替える）", async () => {
    nav.search = `side=${B}`;
    window.history.replaceState(null, "", `/p/${A}?side=${B}`);
    const save = vi.fn(async () => false);
    /** 保存に失敗しているメイン（競合・通信の失敗）。「今すぐ保存」は false を返す。 */
    function FailingPage() {
      const { attachPage, registerPageSaver } = useEditorFrame();
      const [status, setStatus] = useState<"error" | "saved">("error");
      useEffect(() => registerPageSaver(async () => {
        const ok = await save();
        if (ok) setStatus("saved");
        return ok;
      }), [registerPageSaver]);
      useEffect(
        () =>
          attachPage({
            id: A,
            status,
            flush: vi.fn(async () => true),
            revision: () => 1,
            reopen: vi.fn(),
            shared: null,
            setShared: vi.fn(),
            lang: "ja",
            setLang: vi.fn(),
            langNote: null,
            text: { read: () => "", subscribe: () => () => undefined },
          }),
        [attachPage, status],
      );
      return <p>合成の本文</p>;
    }
    await mount({ pages: pages() }, <FailingPage />);
    await tick();
    const swap = () => container!.querySelector<HTMLButtonElement>('button[aria-label="メインと入れ替える"]')!;
    await act(async () => swap().click());
    await tick();
    expect(save).toHaveBeenCalledTimes(1);
    expect(nav.push).not.toHaveBeenCalled();
    expect([...container!.querySelectorAll('[role="alert"]')].map((node) => node.textContent)).toContain(SWAP_UNSAVED_TEXT);
    // 一覧で右のページを開く（入れ替え）も同じく止まる
    await act(async () => rowButton("右のページ").click());
    await tick();
    expect(nav.push).not.toHaveBeenCalled();
    // 保存できたら入れ替え、一言は消える
    save.mockResolvedValue(true);
    await act(async () => swap().click());
    await tick();
    expect(nav.push).toHaveBeenLastCalledWith(`/p/${B}?side=${A}`);
    expect([...container!.querySelectorAll('[role="alert"]')].map((node) => node.textContent)).not.toContain(SWAP_UNSAVED_TEXT);
  });

  it("AI を左のドックへ（見出しのドラッグで）移しても、作り直さず書きかけが残る。置き場所は端末に覚える（v2）", async () => {
    await mount({ pages: pages() }, <FakePage id={A} />);
    await tick();
    expect(pane("ai").dataset).toMatchObject({ dock: "right", index: "1" });
    const draft = pane("ai").querySelector<HTMLTextAreaElement>('textarea[aria-label="AIへのメッセージ"]')!;
    draft.value = "動かしても残す書きかけ";
    expect(aiMock.props?.placement?.at).toBe("right");
    // 会話メニューの「〜へ移す」は無い（ドラッグだけ）
    expect(aiMock.props?.placement).not.toHaveProperty("onMove");

    // 左の端（一覧がいるので、その下）
    await dropPanel(SHELL_DND.ai, 10);
    expect(pane("ai").dataset).toMatchObject({ dock: "left", index: "1" });
    expect(savedDocks()).toEqual({ left: ["list", "ai"], right: ["page"] });
    expect(aiMock.props?.placement?.at).toBe("left");
    expect(container!.querySelector('[role="separator"][aria-label="「一覧」と「AIと作る」の境目"]')).not.toBeNull();

    const after = container!.querySelector<HTMLTextAreaElement>('textarea[aria-label="AIへのメッセージ"]')!;
    expect(after).toBe(draft);
    expect(after.value).toBe("動かしても残す書きかけ");
  });

  it("一覧は上の 1 行を掴んで右のドックへ移せる。× で閉じると右上にそのボタンだけ出て、押すと元のドックの下に戻る。全部開いていればボタンは無い", async () => {
    await mount({ pages: pages() }, <FakePage id={A} />);
    await tick();
    expect(container!.querySelector(".es-sb-top")!.getAttribute("draggable")).toBe("true");
    expect(container!.querySelector('button[aria-label="一覧のメニュー"]')).toBeNull();
    // 一覧・AI・ページが開いている（写真はこのページに無い）ので、右上のボタンの組は無い
    expect(container!.querySelector(".es-dt .es-tg")).toBeNull();
    // 右の端の帯（枠の幅は jsdom では測れないので、どの幅でも右端より右になる位置）。ページと AI の下に入る
    await dropPanel(SHELL_DND.list, 100_000);
    expect(pane("list").dataset).toMatchObject({ dock: "right", index: "2" });
    expect(savedDocks()).toEqual({ left: [], right: ["page", "ai", "list"] });
    expect(shellRoot().dataset.left).toBe("none");
    // 「一覧をしまう」は右のドックにいても効き、右上に「一覧を出す」だけが出る。押すと元のドック（左）へ
    await act(async () => container!.querySelector<HTMLButtonElement>('button[aria-label="一覧をしまう"]')!.click());
    expect(pane("list").hidden).toBe(true);
    expect([...container!.querySelectorAll(".es-dt .es-tg button")].map((button) => button.getAttribute("aria-label"))).toEqual(["一覧を出す"]);
    await act(async () => container!.querySelector<HTMLButtonElement>('.es-dt button[aria-label="一覧を出す"]')!.click());
    expect(pane("list").hidden).toBe(false);
    expect(pane("list").dataset).toMatchObject({ dock: "left", index: "0" });
    expect(container!.querySelector(".es-dt .es-tg")).toBeNull();
    // 「ページ」の × も同じ（順は 一覧・AI・ページ・写真）
    await act(async () => pane("page").querySelector<HTMLButtonElement>('button[aria-label="ページを閉じる"]')!.click());
    expect(pane("page").hidden).toBe(true);
    await act(async () => pane("ai").querySelector<HTMLButtonElement>('button[aria-label="AIと作るを閉じる"]')!.click());
    expect([...container!.querySelectorAll(".es-dt .es-tg button")].map((button) => button.getAttribute("aria-label"))).toEqual(["AIと作るを出す", "ページを出す"]);
    expect(savedDocks()).toEqual({ left: ["list"], right: [] });
    await act(async () => container!.querySelector<HTMLButtonElement>('.es-dt button[aria-label="ページを出す"]')!.click());
    expect(savedDocks()).toEqual({ left: ["list"], right: ["page"] });
    expect(pane("page").dataset).toMatchObject({ dock: "right", index: "0" });
  });

  it("覚えた配置で始める（v2）。v1 の保存は読み替える。壊れた値なら既定", async () => {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({ v: 2, docks: { left: [{ id: "ai", size: 1 }], right: [{ id: "list", size: 1 }] }, widths: { left: 300, right: 320, side: 400 } }));
    await mount({ pages: pages() }, <FakePage id={A} />);
    await tick();
    expect(pane("list").dataset.dock).toBe("right");
    expect(pane("ai").dataset.dock).toBe("left");
    expect(pane("page").hidden).toBe(true);
    expect([...container!.querySelectorAll(".es-dt .es-tg button")].map((button) => button.getAttribute("aria-label"))).toEqual(["ページを出す"]);
    await act(async () => root!.unmount());
    root = null;
    container!.remove();

    window.localStorage.clear();
    window.localStorage.setItem(LAYOUT_KEY_V1, JSON.stringify({ v: 1, place: { list: "right", ai: "left" }, widths: { left: 300, right: 320, side: 400 }, float: { open: false, height: 360 } }));
    await mount({ pages: pages() }, <FakePage id={A} />);
    await tick();
    expect(pane("list").dataset).toMatchObject({ dock: "right", index: "0" });
    expect(pane("page").dataset).toMatchObject({ dock: "right", index: "1" });
    expect(pane("ai").dataset.dock).toBe("left");
    await act(async () => root!.unmount());
    root = null;
    container!.remove();

    window.localStorage.clear();
    window.localStorage.setItem(LAYOUT_KEY, "{壊れた");
    await mount({ pages: pages() }, <FakePage id={A} />);
    await tick();
    expect(pane("list").dataset.dock).toBe("left");
    expect(pane("ai").dataset).toMatchObject({ dock: "right", index: "1" });
    expect(pane("page").dataset).toMatchObject({ dock: "right", index: "0" });
  });

  it("AI が右のページを書き換えたら読み直す（ほかのページなら読まない）", async () => {
    nav.search = `side=${B}`;
    await mount({ pages: pages() }, <FakePage id={A} />);
    await tick();
    expect(sideReads(fetcher)).toBe(1);
    await act(async () => aiMock.props!.onPagesChanged!([C]));
    await tick();
    expect(sideReads(fetcher)).toBe(1);
    await act(async () => aiMock.props!.onPagesChanged!([A, B]));
    await tick();
    expect(sideReads(fetcher)).toBe(2);
  });
});

describe("EditorFrame: 題名の変更は、一覧の入れ物と兄弟のタブの行にも反映する（#308 レビュー）", () => {
  const HOLDER = "00000000-0000-4000-8000-0000000000a1";
  const TAB_A = "00000000-0000-4000-8000-0000000000a2";
  const TAB_B = "00000000-0000-4000-8000-0000000000a3";
  const OTHER_HOLDER = "00000000-0000-4000-8000-0000000000b1";
  const OTHER_TAB = "00000000-0000-4000-8000-0000000000b2";
  const rows = () => [
    { ...page(HOLDER, "旧題"), kind: "page" as const },
    { ...page(TAB_A, "旧題"), page: HOLDER },
    { ...page(TAB_B, "旧題"), page: HOLDER },
    { ...page(OTHER_HOLDER, "別のページ"), kind: "page" as const },
    { ...page(OTHER_TAB, "別のページ"), page: OTHER_HOLDER },
  ];
  /** 開いたタブで題名を打った知らせ（PageEditor の題名の欄と同じ呼び方）。 */
  function Retitle({ id, title }: { id: string; title: string }) {
    const { pageTitleChanged } = useEditorFrame();
    useEffect(() => pageTitleChanged(id, title), [pageTitleChanged, id, title]);
    return <p>合成の本文</p>;
  }
  // 入れ物の行は「題名 ＋ タブの数の印」（例: 旧題タブ 2）なので、題名で始まる行があるかで見る
  const titles = () => [...container!.querySelectorAll(".es-di-t")].map((node) => node.textContent ?? "");
  const has = (title: string) => titles().some((text) => text.startsWith(title));

  it("タブで題名を変えると、一覧が出す入れ物の行も新しい題名になる（ほかのページは変えない）", async () => {
    await mount({ pages: rows() });
    expect(has("旧題")).toBe(true);
    expect(has("別のページ")).toBe(true);
    await rerender(<Retitle id={TAB_A} title="新しい題名" />);
    expect(has("新しい題名")).toBe(true);
    expect(has("旧題")).toBe(false);
    expect(has("別のページ")).toBe(true);
  });
});
