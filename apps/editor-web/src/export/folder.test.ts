import { FOLDER_EXPORT_MAX_CHARS, FOLDER_EXPORT_MAX_TABS } from "@niho/docs-core";
import type { PageFields } from "@niho/editor-store";
import { describe, expect, it } from "vitest";
import { buildFolderExport, contextMarkdown, exportFileName, pageMarkdown, photoArchivePath, photoAssetIds, uniqueFileNames, type FolderExportPage, type FolderExportPhoto } from "./folder";

/**
 * フォルダ単位の書き出し（#37。旧 `folder-export-tree.ts` の木をページの木に作り替えたもの）。
 * zip の中身は名前だけを確かめる（バイトの形は editor-publish の zip の test が持つ）。値はすべて合成。
 */

const ASSET = "11111111-1111-4111-8111-111111111111";
const OTHER_ASSET = "22222222-2222-4222-8222-222222222222";
const noPhotos = new Map<string, FolderExportPhoto>();
const empty: PageFields = { entities: [], terms: [] };

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const image = (assetId: string, alt = "") => ({ type: "image", attrs: { assetId, alt, credit: null } });
const page = (title: string, blocks: unknown[] = [paragraph("合成の本文")]): FolderExportPage => ({ id: `id-${title}`, title, blocks });
const photo = (sha: string, contentType = "image/jpeg"): FolderExportPhoto => ({ sha256: sha.repeat(64).slice(0, 64), contentType, bytes: new Uint8Array([1, 2, 3]) });

describe("exportFileName / uniqueFileNames", () => {
  it("keeps the title and drops what a zip must not hold", () => {
    expect(exportFileName("鎌倉の記事")).toBe("鎌倉の記事");
    expect(exportFileName("a/b\\c:d*e?f\"g<h>i|j")).toBe("a-b-c-d-e-f-g-h-i-j");
    expect(exportFileName("  ..  ")).toBe("無題");
    expect(exportFileName("")).toBe("無題");
    expect(Array.from(exportFileName("あ".repeat(200))).length).toBe(80);
  });

  it("never lets two pages overwrite each other", () => {
    expect(uniqueFileNames(["a", "a", "b", "A"])).toEqual(["a.md", "a-2.md", "b.md", "A-3.md"]);
    expect(uniqueFileNames(["", ""])).toEqual(["無題.md", "無題-2.md"]);
  });
});

describe("photoAssetIds", () => {
  it("finds the asset ids of the photos in the body, in order, once each", () => {
    const blocks = [image(ASSET), paragraph("文"), { type: "callout", content: [image(OTHER_ASSET), image(ASSET)] }];
    expect(photoAssetIds(blocks)).toEqual([ASSET, OTHER_ASSET]);
  });

  it("ignores a node without a usable asset id", () => {
    expect(photoAssetIds([image("not-a-uuid"), { type: "image" }, { type: "image", attrs: {} }, paragraph("文")])).toEqual([]);
    expect(photoAssetIds("not an array" as unknown as unknown[])).toEqual([]);
  });
});

describe("contextMarkdown（背景情報）", () => {
  it("is the folder's own body, with 登場人物 and 固有名詞 under their own headings", () => {
    const fields: PageFields = {
      entities: [{ name: "田中", reading: "たなか", role: "店主", note: "" }],
      terms: [{ term: "北鎌倉", reading: "きたかまくら", variants: ["北鎌"], note: "駅名" }],
    };
    const markdown = contextMarkdown(page("鎌倉の記事", [paragraph("取材の背景")]), fields, () => null);
    expect(markdown).toBe("# 背景情報\n\n取材の背景\n\n## 登場人物\n- 田中 · たなか · 店主\n\n## 固有名詞\n- 北鎌倉 · きたかまくら · 北鎌 · 駅名\n");
  });

  it("is null when the folder has no body and no 欄 (the page is left out)", () => {
    expect(contextMarkdown(page("フォルダ", []), empty, () => null)).toBeNull();
    expect(contextMarkdown(page("フォルダ", [paragraph("  ")]), empty, () => null)).toBeNull();
  });
});

describe("pageMarkdown", () => {
  it("puts the title in an h1 and the body under it", () => {
    expect(pageMarkdown(page("取材メモ"), () => null)).toBe("# 取材メモ\n\n合成の本文\n");
    expect(pageMarkdown(page("", []), () => null)).toBe("# 無題\n");
  });

  it("points a photo at the archive path and leaves out a photo that could not be read", () => {
    const body = [image(ASSET, "店の前"), image(OTHER_ASSET, "読めない写真")];
    const text = pageMarkdown(page("写真", body), (id) => (id === ASSET ? "photos/abc.jpg" : null));
    expect(text).toBe("# 写真\n\n![店の前](photos/abc.jpg)\n");
  });
});

describe("buildFolderExport", () => {
  it("puts 背景情報 first, then one .md per page in tree order, and the photos once each", () => {
    const photos = new Map([
      [ASSET, photo("a")],
      [OTHER_ASSET, photo("b", "image/png")],
    ]);
    const result = buildFolderExport({
      pages: [page("鎌倉の記事", [paragraph("背景")]), page("取材メモ", [image(ASSET, "店")]), page("録音", [image(ASSET), image(OTHER_ASSET)])],
      fields: empty,
      photos,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toEqual(["背景情報.md", "取材メモ.md", "録音.md", photoArchivePath(photo("a")), photoArchivePath(photo("b", "image/png"))]);
    expect(result.photos).toBe(2);
    // バイトは zip（形は editor-publish の zip の test が持つ）
    expect([...result.bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(result.bytes.byteLength).toBeGreaterThan(100);
  });

  it("leaves 背景情報 out when the folder is empty, and leaves a photo out when no body points at it", () => {
    const result = buildFolderExport({ pages: [page("フォルダ", []), page("メモ")], fields: empty, photos: new Map([[ASSET, photo("a")]]) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toEqual(["メモ.md"]);
    expect(result.photos).toBe(0);
  });

  it("refuses an empty folder, too many pages and too many characters, without building anything", () => {
    expect(buildFolderExport({ pages: [], fields: empty, photos: noPhotos })).toEqual({ ok: false, reason: "empty" });
    expect(buildFolderExport({ pages: [page("フォルダ", [])], fields: empty, photos: noPhotos })).toEqual({ ok: false, reason: "empty" });

    const many = Array.from({ length: FOLDER_EXPORT_MAX_TABS + 1 }, (_, index) => page(`p${index}`));
    expect(buildFolderExport({ pages: [page("フォルダ", []), ...many], fields: empty, photos: noPhotos })).toEqual({ ok: false, reason: "too_many" });

    const long = page("長い", [paragraph("あ".repeat(FOLDER_EXPORT_MAX_CHARS + 10))]);
    expect(buildFolderExport({ pages: [page("フォルダ", []), long], fields: empty, photos: noPhotos })).toEqual({ ok: false, reason: "too_large" });
  });

  it("counts the folder's own page as 背景情報 and never as a second file", () => {
    const result = buildFolderExport({ pages: [page("背景情報", [paragraph("本文")]), page("背景情報")], fields: empty, photos: noPhotos });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // フォルダの本文は「背景情報.md」になり、同じ題名の中のページは「背景情報-2.md」になる
    expect(result.files).toEqual(["背景情報.md", "背景情報-2.md"]);
  });
});
