// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageFields } from "@niho/editor-store";

const loadPageFields = vi.fn<(id: string) => Promise<PageFields>>();
const savePageFieldsRequest = vi.fn<(id: string, patch: Partial<PageFields>) => Promise<PageFields>>();
vi.mock("./folder-client", () => ({
  loadPageFields: (id: string) => loadPageFields(id),
  savePageFieldsRequest: (id: string, patch: Partial<PageFields>) => savePageFieldsRequest(id, patch),
}));

import { usePageFields, type PageFieldsState } from "./use-page-fields";

/**
 * 録音の欄（登場人物・固有名詞・背景）は、サーバーの値を読み終えるまで編集も保存もさせない。
 * 読む前に編集を開くと、空の値で始まった編集画面の保存が既存の値を丸ごと置き換えて消してしまう。合成の値だけを使う。
 */

const FOLDER = "11111111-1111-4111-8111-111111111111";
const stored: PageFields = {
  entities: [{ name: "合成の人物", role: "取材先" }],
  terms: [{ term: "北鎌倉", reading: "きたかまくら", variants: ["北鎌"], note: "" }],
  background: "合成の背景",
} as unknown as PageFields;

describe("usePageFields: 読み終えるまで編集も保存もさせない", () => {
  let root: Root;
  let container: HTMLElement;
  let fields: PageFieldsState;

  function Harness({ pageId }: { pageId: string }) {
    fields = usePageFields(pageId);
    return null;
  }

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    loadPageFields.mockReset();
    savePageFieldsRequest.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const mount = (pageId = FOLDER) => act(async () => root.render(<Harness pageId={pageId} />));
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  it("読み終える前に「編集」を押しても開かず、読み終えたら開いて、既存の値から始まる", async () => {
    let finish: (value: PageFields) => void = () => undefined;
    loadPageFields.mockReturnValueOnce(new Promise<PageFields>((resolve) => { finish = resolve; }));
    await mount();

    act(() => fields.onOpen());
    expect(fields.open).toBe(false);
    expect(fields.note).toContain("読み込んでいます");

    await act(async () => finish(stored));
    expect(fields.note).toBeNull();
    expect(fields.entities.map((entity) => entity.name)).toEqual(["合成の人物"]);

    act(() => fields.onOpen());
    expect(fields.open).toBe(true);
    expect(fields.entities.map((entity) => entity.name)).toEqual(["合成の人物"]);
    expect(fields.terms.map((term) => term.term)).toEqual(["北鎌倉"]);
  });

  it("読み終える前の保存は何も送らない（既存の値を空で置き換えない）", async () => {
    loadPageFields.mockReturnValueOnce(new Promise<PageFields>(() => undefined));
    await mount();
    act(() => fields.onSave());
    await settle();
    expect(savePageFieldsRequest).not.toHaveBeenCalled();
  });

  it("読めなかったときは編集を開かず、そう伝える。押すと読み直し、読めたら開ける", async () => {
    loadPageFields.mockRejectedValueOnce(new Error("offline"));
    await mount();
    await settle();
    expect(fields.note).toContain("読み込めませんでした");
    act(() => fields.onSave());
    expect(savePageFieldsRequest).not.toHaveBeenCalled();

    loadPageFields.mockResolvedValueOnce(stored);
    await act(async () => fields.onOpen());
    await settle();
    expect(loadPageFields).toHaveBeenCalledTimes(2);
    expect(fields.open).toBe(false);
    expect(fields.note).toBeNull();

    act(() => fields.onOpen());
    expect(fields.open).toBe(true);
    expect(fields.entities.map((entity) => entity.name)).toEqual(["合成の人物"]);
  });

  it("背景は読んだ値から始まり、欄を離れたときだけ保存する（変わっていなければ送らない）。登場人物・固有名詞は送らない", async () => {
    loadPageFields.mockResolvedValueOnce(stored);
    await mount();
    await settle();
    expect(fields.background).toBe("合成の背景");
    act(() => fields.onSaveBackground());
    expect(savePageFieldsRequest).not.toHaveBeenCalled();

    savePageFieldsRequest.mockResolvedValueOnce({ ...stored, background: "取材の目的" });
    act(() => fields.onBackground(" 取材の目的 "));
    await act(async () => fields.onSaveBackground());
    await settle();
    expect(savePageFieldsRequest).toHaveBeenCalledWith(FOLDER, { background: "取材の目的" });
    expect(fields.background).toBe("取材の目的");
  });

  it("背景を読み終える前には打てず、保存もしない", async () => {
    loadPageFields.mockReturnValueOnce(new Promise<PageFields>(() => undefined));
    await mount();
    act(() => fields.onBackground("先に打った文字"));
    act(() => fields.onSaveBackground());
    expect(fields.background).toBe("");
    expect(savePageFieldsRequest).not.toHaveBeenCalled();
  });
});
