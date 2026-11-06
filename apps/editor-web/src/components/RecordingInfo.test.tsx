// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageFields } from "@niho/editor-store";

const loadPageFields = vi.fn<(id: string) => Promise<PageFields>>();
const savePageFieldsRequest = vi.fn<(id: string, patch: Partial<PageFields>) => Promise<PageFields>>();
vi.mock("@/lib/folder-client", () => ({
  loadPageFields: (id: string) => loadPageFields(id),
  savePageFieldsRequest: (id: string, patch: Partial<PageFields>) => savePageFieldsRequest(id, patch),
}));
vi.mock("@/lib/settings-client", () => ({
  loadSettings: async () => ({ ok: true, settings: { glossary: [{ term: "a" }, { term: "b" }, { term: "c" }] } }),
}));

import { RecordingInfo } from "./RecordingInfo";

/** 録音ページの「この録音について」。値はすべて合成。 */

const REC = "22222222-2222-4222-8222-222222222222";
const EMPTY: PageFields = { entities: [], terms: [], background: "" };
const FILLED: PageFields = {
  entities: [{ name: "田中", reading: "", role: "店主", note: "" }, { name: "佐藤", reading: "", role: "", note: "" }],
  terms: [{ term: "北鎌倉", reading: "", variants: [], note: "" }],
  background: "取材の目的",
};

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  loadPageFields.mockReset();
  savePageFieldsRequest.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const head = () => host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;

describe("RecordingInfo", () => {
  it("空のうちは開いた状態で、背景・登場人物・固有名詞の欄と「共通 N」を出す", async () => {
    loadPageFields.mockResolvedValueOnce(EMPTY);
    act(() => root.render(<RecordingInfo pageId={REC} />));
    await settle();
    expect(head().getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector("textarea")?.getAttribute("placeholder")).toBe("取材の目的、相手、場所など");
    expect(host.textContent).toContain("共通 3");
    expect(loadPageFields).toHaveBeenCalledWith(REC);
  });

  it("何か入っていれば畳んだ状態で、1 行の要約を文字で出す。見出しで開ける", async () => {
    loadPageFields.mockResolvedValueOnce(FILLED);
    act(() => root.render(<RecordingInfo pageId={REC} />));
    await settle();
    expect(head().getAttribute("aria-expanded")).toBe("false");
    expect(head().textContent).toContain("登場人物 2 · 固有名詞 1 · 背景あり");
    act(() => head().click());
    expect(head().getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("田中");
    expect(host.textContent).toContain("北鎌倉");
  });

  it("背景は欄を離れたときに録音ページの欄へ保存する", async () => {
    loadPageFields.mockResolvedValueOnce(EMPTY);
    savePageFieldsRequest.mockResolvedValueOnce({ ...EMPTY, background: "取材の目的" });
    act(() => root.render(<RecordingInfo pageId={REC} />));
    await settle();
    const area = host.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(area, "取材の目的");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      area.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await settle();
    expect(savePageFieldsRequest).toHaveBeenCalledWith(REC, { background: "取材の目的" });
  });

  it("「追加」で登場人物・固有名詞の編集を開き、保存は録音ページの欄へ送る", async () => {
    loadPageFields.mockResolvedValueOnce(EMPTY);
    savePageFieldsRequest.mockResolvedValueOnce(EMPTY);
    act(() => root.render(<RecordingInfo pageId={REC} />));
    await settle();
    act(() => host.querySelector<HTMLButtonElement>("button[aria-label='登場人物を追加・編集']")!.click());
    const save = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "登場人物を保存")!;
    await act(async () => save.click());
    await settle();
    expect(savePageFieldsRequest).toHaveBeenCalledWith(REC, { entities: [], terms: [] });
  });
});
