import { describe, expect, it } from "vitest";
import { pageMenuItems } from "./use-page-menu";
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
