// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageSummary } from "@niho/editor-store";

const push = vi.fn();
const attachPage = vi.fn(() => () => undefined);
const frame: Record<string, unknown> = { attachPage, pageTitleChanged: vi.fn(), pageSaved: vi.fn(), pages: [] as PageSummary[], now: Date.parse("2026-11-06T03:00:00.000Z") };
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("./EditorFrame", () => ({ useEditorFrame: () => frame }));
const savePageRequest = vi.fn(async () => 2);
vi.mock("@/lib/pages-client", async (original) => ({
  ...(await original<typeof import("@/lib/pages-client")>()),
  savePageRequest: (...args: unknown[]) => (savePageRequest as unknown as (...a: unknown[]) => Promise<number>)(...args),
}));

import { FolderPage } from "./FolderPage";

/** フォルダを開いた画面（中身の一覧と「新しいページ」「録音から」だけ）。値はすべて合成。 */

const FOLDER = "11111111-1111-4111-8111-111111111111";
const page = (id: string, over: Partial<PageSummary> = {}): PageSummary => ({
  id, kind: "note", title: id, lang: "ja", parent: null, stepStatus: null, sortOrder: 0,
  createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-06T02:00:00.000Z", publication: null, ...over,
});
const folder = page(FOLDER, { kind: "folder", title: "鎌倉の取材" });

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  push.mockReset();
  attachPage.mockClear();
  savePageRequest.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("FolderPage", () => {
  it("空のフォルダは「まだページがありません」と 2 つのボタンだけ。本文のエディタは出さない", () => {
    frame.pages = [folder];
    act(() => root.render(<FolderPage summary={folder} revision={1} />));
    expect(host.textContent).toContain("まだページがありません");
    const buttons = [...host.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toEqual(["新しいページ", "録音から"]);
    expect(host.querySelector(".ProseMirror")).toBeNull();
    expect((host.querySelector("textarea[aria-label='タイトル']") as HTMLTextAreaElement).value).toBe("鎌倉の取材");
    // 「…」（書き出し・削除）のために、開いているページとして枠に登録する
    expect(attachPage).toHaveBeenCalledWith(expect.objectContaining({ id: FOLDER, status: "saved" }));
  });

  it("「新しいページ」「録音から」はそのフォルダの中に作る（?in=）", () => {
    frame.pages = [folder];
    act(() => root.render(<FolderPage summary={folder} revision={1} />));
    const [blank, recording] = [...host.querySelectorAll("button")];
    act(() => blank!.click());
    act(() => recording!.click());
    expect(push.mock.calls.map((call) => call[0])).toEqual([`/p/new?in=${FOLDER}`, `/p/new?from=recording&in=${FOLDER}`]);
  });

  it("中身は録音の下に工程のサブページを 1 段下げて並べ、行を押すとそのページを開く", () => {
    frame.pages = [
      folder,
      page("rec", { kind: "rec", parent: FOLDER, title: "座談会" }),
      page("step", { kind: "step", parent: "rec", title: "記事本文", stepStatus: "run" }),
      page("memo", { parent: FOLDER, title: "メモ", createdAt: "2026-11-02T00:00:00.000Z" }),
      page("outside"),
    ];
    act(() => root.render(<FolderPage summary={folder} revision={1} />));
    const rows = [...host.querySelectorAll("li")];
    expect(rows.map((row) => row.querySelector("b")?.textContent)).toEqual(["座談会", "記事本文", "メモ"]);
    expect(rows.map((row) => row.querySelector("small")?.textContent ?? null)).toEqual(["録音", "作成中…", null]);
    act(() => rows[1]!.querySelector("button")!.click());
    expect(push).toHaveBeenCalledWith("/p/step");
  });

  it("題名は欄を離れたときに題名だけを保存する（変えていなければ送らない）", async () => {
    frame.pages = [folder];
    act(() => root.render(<FolderPage summary={folder} revision={3} />));
    const title = host.querySelector("textarea[aria-label='タイトル']") as HTMLTextAreaElement;
    await act(async () => {
      title.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(savePageRequest).not.toHaveBeenCalled();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(title, "新しい名前");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      title.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(savePageRequest).toHaveBeenCalledWith(FOLDER, { title: "新しい名前" }, { baseRevision: 3 });
  });
});
