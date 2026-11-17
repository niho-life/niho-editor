import { describe, expect, it } from "vitest";
import { ADD_TAB_ITEM, AI_GRAY_ITEM, FLOW_ITEM, PUBLISH_ITEM, pageMenuItems } from "./use-page-menu";
import { googleDocsConnectPath, GOOGLE_DOCS_CONNECT_PATH } from "./google-docs-paths";

/** 「…」の項目と、Google ドキュメントの失敗の文言（code ごと）。 */

describe("「…」の項目", () => {
  it("書き出しは .md と Google ドキュメントの 2 つに分かれる", () => {
    const items = pageMenuItems(null);
    expect(items.map((item) => item.id)).toEqual(["share", "export", "export-google-docs-batch", "history", "duplicate", "delete"]);
    const [, markdown, google] = items;
    expect(markdown).toMatchObject({ label: "書き出し", hint: ".md" });
    expect(google).toMatchObject({ label: "Google ドキュメントへ" });
    expect(google!.hint).toBeUndefined();
    // Google の項目も同じ見た目の印を使う（並びの中で浮かない）
    expect(google!.icon).toBe(markdown!.icon);
  });

  it("ページに応じて足す: 移動…・ページの情報は削除の前。フォルダでは 書き出し（.zip）と削除だけ", () => {
    expect(pageMenuItems(null, { move: true, pageInfo: true }).map((item) => item.label)).toEqual([
      "リンクで共有",
      "書き出し",
      "Google ドキュメントへ",
      "履歴",
      "複製",
      "移動…",
      "ページの情報",
      "削除",
    ]);
    const folder = pageMenuItems(true, { folder: true, move: true, pageInfo: true, aiGray: true });
    expect(folder.map((item) => [item.id, item.label, item.hint])).toEqual([
      ["export-folder", "書き出し", ".zip"],
      ["delete", "削除", "中のページも"],
    ]);
    expect(pageMenuItems(null, { pageInfo: true }).map((item) => item.id)).toEqual(["share", "export", "export-google-docs-batch", "history", "duplicate", "page-info", "delete"]);
  });

  it("「AI の文を灰色で見せる」は今の値を checked に持ち、削除の前に出る（値を渡さなければ出さない）", () => {
    const on = pageMenuItems(null, { pageInfo: true, aiGray: true });
    expect(on.map((item) => item.id).slice(-3)).toEqual(["page-info", AI_GRAY_ITEM, "delete"]);
    expect(on.find((item) => item.id === AI_GRAY_ITEM)).toMatchObject({ label: "AI の文を灰色で見せる", checked: true });
    expect(pageMenuItems(null, { aiGray: false }).find((item) => item.id === AI_GRAY_ITEM)?.checked).toBe(false);
    expect(pageMenuItems(null).some((item) => item.id === AI_GRAY_ITEM)).toBe(false);
  });

  it("「公開…」は先頭、「タブを追加」は書き出しの後ろ（前後に区切り）。渡さなければ出さず、フォルダには出さない（#344）", () => {
    const items = pageMenuItems(null, { publish: { hint: "公開中 · 更新あり" }, addTab: true, pageInfo: true });
    expect(items.map((item) => item.label)).toEqual(["公開…", "リンクで共有", "書き出し", "Google ドキュメントへ", "タブを追加", "履歴", "複製", "ページの情報", "削除"]);
    expect(items[0]).toMatchObject({ id: PUBLISH_ITEM, icon: "globe", hint: "公開中 · 更新あり" });
    expect(items.filter((item) => item.separated).map((item) => item.id)).toEqual([ADD_TAB_ITEM, "history"]);
    expect(pageMenuItems(null, { publish: {} })[0]).toMatchObject({ id: PUBLISH_ITEM, label: "公開…" });
    expect(pageMenuItems(null, { publish: {} })[0]!.hint).toBeUndefined();
    expect(pageMenuItems(null).some((item) => item.id === PUBLISH_ITEM || item.id === ADD_TAB_ITEM || item.separated)).toBe(false);
    expect(pageMenuItems(null, { folder: true, publish: {}, addTab: true }).map((item) => item.id)).toEqual(["export-folder", "delete"]);
  });

  it("「手順で作る…」は「タブを追加」の後ろ（同じ区切りの間）。タブを追加が無くても区切る。渡さなければ出さず、フォルダには出さない（#344）", () => {
    const both = pageMenuItems(null, { addTab: true, flow: true });
    expect(both.map((item) => item.label)).toEqual(["リンクで共有", "書き出し", "Google ドキュメントへ", "タブを追加", "手順で作る…", "履歴", "複製", "削除"]);
    expect(both.find((item) => item.id === FLOW_ITEM)).toMatchObject({ icon: "spark" });
    expect(both.filter((item) => item.separated).map((item) => item.id)).toEqual([ADD_TAB_ITEM, "history"]);
    const alone = pageMenuItems(null, { flow: true });
    expect(alone.map((item) => item.id)).toEqual(["share", "export", "export-google-docs-batch", FLOW_ITEM, "history", "duplicate", "delete"]);
    expect(alone.filter((item) => item.separated).map((item) => item.id)).toEqual([FLOW_ITEM, "history"]);
    expect(pageMenuItems(null).some((item) => item.id === FLOW_ITEM)).toBe(false);
    expect(pageMenuItems(null, { folder: true, flow: true }).map((item) => item.id)).toEqual(["export-folder", "delete"]);
  });

  it("共有中が分かっているときだけ補足を出す", () => {
    const hintOf = (shared: boolean | null) => pageMenuItems(shared).find((item) => item.id === "share")?.hint;
    expect(hintOf(true)).toBe("共有中");
    expect(hintOf(false)).toBeUndefined();
    expect(hintOf(null)).toBeUndefined();
  });
});

describe("接続の案内の path", () => {
  it("戻り先を付ける（無ければ付けない）", () => {
    expect(googleDocsConnectPath(null)).toBe(GOOGLE_DOCS_CONNECT_PATH);
    expect(googleDocsConnectPath("/p/6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11")).toBe(
      `${GOOGLE_DOCS_CONNECT_PATH}?next=%2Fp%2F6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11`,
    );
    // query も含めて 1 つの値として逃がす
    expect(googleDocsConnectPath("/p/new?from=recording")).toBe(`${GOOGLE_DOCS_CONNECT_PATH}?next=%2Fp%2Fnew%3Ffrom%3Drecording`);
  });
});
