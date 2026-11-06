// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageSummary } from "@niho/editor-store";

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
const frame = { pageCreated: vi.fn(), pageRemoved: vi.fn(), openPage: vi.fn(), pages: [] as PageSummary[], narrow: false };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./EditorFrame", () => ({ useEditorFrame: () => frame }));
vi.mock("@/lib/page-actions-client", async (original) => ({
  ...(await original<typeof import("@/lib/page-actions-client")>()),
  createTabRequest: vi.fn(),
  renameTabRequest: vi.fn(),
  moveTabRequest: vi.fn(),
  duplicatePageRequest: vi.fn(),
  deletePageRequest: vi.fn(),
}));

import { PageActionError, createTabRequest, deletePageRequest, duplicatePageRequest, moveTabRequest, renameTabRequest } from "@/lib/page-actions-client";
import { PAGE_TABS_TEXT, PageTabs, type OpenPageTab } from "./PageTabs";

const PAGE = "33333333-3333-4333-8333-333333333333";
const OTHER = "66666666-6666-4666-8666-666666666666";
const HOLDER = "55555555-5555-4555-8555-555555555555";
const FOLDER = "11111111-1111-4111-8111-111111111111";
const page = { id: PAGE, kind: "note" as const, title: "冬の鎌倉", parent: FOLDER, page: HOLDER };
const tab = (id: string, tabPos: number, tabName: string | null = null): OpenPageTab => ({ id, kind: "note", title: "冬の鎌倉", tabName, tabPos, stepStatus: null });
const summary = (id: string, over: Partial<PageSummary> = {}): PageSummary => ({
  id, kind: "note", title: id, lang: "ja", parent: FOLDER, stepStatus: null, sortOrder: 0, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-06T02:00:00.000Z", publication: null, ...over,
});

let root: Root;
let host: HTMLElement;
const saveNow = vi.fn(async () => true);
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.clearAllMocks();
  saveNow.mockResolvedValue(true);
  frame.pages = [];
  frame.narrow = false;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = (tabs: OpenPageTab[]) => act(() => root.render(<PageTabs page={page} tabs={tabs} saveNow={saveNow} />));
const openMenu = () => act(() => host.querySelector<HTMLButtonElement>(".es-tab-menu")!.click());
const pick = async (label: string) => {
  const item = [...host.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find((button) => button.textContent?.startsWith(label))!;
  await act(async () => item.click());
};

describe("PageTabs（本文の上のタブの帯。#308）", () => {
  it("＋: まっさらなタブを足し、一覧に知らせて（同じ入れ物）開く。届かなければ一言", async () => {
    vi.mocked(createTabRequest).mockResolvedValue({ id: OTHER, page: HOLDER });
    mount([tab(PAGE, 1)]);
    await act(async () => host.querySelector<HTMLButtonElement>(".es-tab-add")!.click());
    expect(createTabRequest).toHaveBeenCalledWith(PAGE);
    expect(frame.pageCreated).toHaveBeenCalledWith(OTHER, "冬の鎌倉", "note", FOLDER, HOLDER);
    expect(router.push).toHaveBeenCalledWith(`/p/${OTHER}`);
    vi.mocked(createTabRequest).mockRejectedValue(new PageActionError(503));
    await act(async () => host.querySelector<HTMLButtonElement>(".es-tab-add")!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(PAGE_TABS_TEXT.addFailed);
  });

  it("▾ 名前を変える: 送って読み直す。空は名前なし（null）", async () => {
    vi.mocked(renameTabRequest).mockResolvedValue(undefined);
    mount([tab(PAGE, 1, "下書き"), tab(OTHER, 2)]);
    openMenu();
    await pick("名前を変える");
    const field = host.querySelector<HTMLInputElement>(".es-tab-name")!;
    act(() => {
      field.value = "第一稿";
    });
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(renameTabRequest).toHaveBeenCalledWith(PAGE, "第一稿");
    expect(router.refresh).toHaveBeenCalledTimes(1);
    openMenu();
    await pick("名前を変える");
    const again = host.querySelector<HTMLInputElement>(".es-tab-name")!;
    act(() => {
      again.value = "";
    });
    await act(async () => again.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(renameTabRequest).toHaveBeenLastCalledWith(PAGE, null);
  });

  it("▾ 複製: まず保存してから複製し、同じ入れ物のタブとして一覧に知らせて開く。保存できなければ一言", async () => {
    vi.mocked(duplicatePageRequest).mockResolvedValue({ id: OTHER, title: "冬の鎌倉", kind: "note", parent: FOLDER, page: HOLDER, tabName: "1のコピー" });
    mount([tab(PAGE, 1), tab(OTHER, 2)]);
    openMenu();
    await pick("複製");
    expect(saveNow).toHaveBeenCalledTimes(1);
    expect(frame.pageCreated).toHaveBeenCalledWith(OTHER, "冬の鎌倉", "note", FOLDER, HOLDER);
    expect(router.push).toHaveBeenCalledWith(`/p/${OTHER}`);
    saveNow.mockResolvedValue(false);
    openMenu();
    await pick("複製");
    expect(duplicatePageRequest).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("複製の前に変更を保存できませんでした");
  });

  it("▾ 並べて開く（デスクトップだけ）は ?side= で右に。狭い画面では出さない", async () => {
    mount([tab(PAGE, 1), tab(OTHER, 2, "英語版")]);
    openMenu();
    await pick("並べて開く");
    expect(router.replace).toHaveBeenCalledWith(`/p/${PAGE}?side=${OTHER}`);
    act(() => root.unmount());
    host.remove();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    frame.narrow = true;
    mount([tab(PAGE, 1), tab(OTHER, 2)]);
    openMenu();
    expect([...host.querySelectorAll('[role="menu"] button')].map((button) => button.textContent)).not.toContain("並べて開く英語版");
  });

  it("▾ 別のページへ移す: 同じフォルダのページ（入れ物と入れ物の無いページ。自分の入れ物は除く）へ。一覧は外して足し直す", async () => {
    vi.mocked(moveTabRequest).mockResolvedValue(undefined);
    const other = "77777777-7777-4777-8777-777777777777";
    frame.pages = [
      summary(FOLDER, { kind: "folder", parent: null }),
      summary(HOLDER, { kind: "page", title: "冬の鎌倉" }),
      summary(PAGE, { page: HOLDER, title: "冬の鎌倉" }),
      summary(other, { kind: "page", title: "文体のメモ" }),
      summary("t-of-other", { page: other, title: "文体のメモ" }),
      summary("lone", { title: "入れ物なし" }),
      summary("elsewhere", { kind: "page", parent: null, title: "別のフォルダ" }),
    ];
    mount([tab(PAGE, 1), tab(OTHER, 2)]);
    openMenu();
    await pick("別のページへ移す");
    expect([...host.querySelectorAll('[role="menu"] button')].map((button) => button.textContent)).toEqual(["文体のメモ", "入れ物なし"]);
    await pick("文体のメモ");
    expect(moveTabRequest).toHaveBeenCalledWith(PAGE, other);
    expect(frame.pageRemoved).toHaveBeenCalledWith(PAGE);
    expect(frame.pageCreated).toHaveBeenCalledWith(PAGE, "冬の鎌倉", "note", FOLDER, other);
    expect(router.refresh).toHaveBeenCalled();
  });

  it("▾ 削除: 確認してから消し、一覧に知らせて入れ物（最後に開いたタブ）へ。最後のタブならホームへ。失敗は確認の中に", async () => {
    vi.mocked(deletePageRequest).mockResolvedValue(undefined);
    mount([tab(PAGE, 1, "下書き"), tab(OTHER, 2)]);
    openMenu();
    await pick("削除");
    expect(host.querySelector("h2")?.textContent).toBe(PAGE_TABS_TEXT.confirmTab("下書き"));
    expect(deletePageRequest).not.toHaveBeenCalled();
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "削除する")!.click());
    expect(saveNow).toHaveBeenCalled();
    expect(deletePageRequest).toHaveBeenCalledWith(PAGE);
    expect(frame.pageRemoved).toHaveBeenCalledWith(PAGE);
    expect(router.push).toHaveBeenCalledWith(`/p/${HOLDER}`);
    expect(host.querySelector("h2")).toBeNull();
    // 最後のタブ（1 つだけ）: 入れ物ごと消えるのでホームへ。消せなければ閉じずに理由
    act(() => root.unmount());
    host.remove();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.mocked(deletePageRequest).mockRejectedValueOnce(new PageActionError(409, "published"));
    mount([tab(PAGE, 1), tab(OTHER, 2)]);
    openMenu();
    await pick("削除");
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "削除する")!.click());
    expect(host.querySelector(".es-sh-note")?.textContent).toBe("公開中のページは、先に公開をやめてください");
    expect(host.querySelector("h2")).not.toBeNull();
  });
});
