import { FOLDER_EXPORT_MAX_CHARS, FOLDER_EXPORT_MAX_TABS } from "@niho/docs-core";
import type { PageFields } from "@niho/editor-store";
import { describe, expect, it } from "vitest";
import { buildFolderExport, exportFileName, recordingInfoMarkdown, pageMarkdown, photoArchivePath, photoAssetIds, uniqueFileNames, type FolderExportPage, type FolderExportPhoto } from "./folder";

/**
 * フォルダ単位の書き出し（#37。旧 `folder-export-tree.ts` の木をページの木に作り替えたもの）。
 * zip の中身は名前だけを確かめる（バイトの形は editor-publish の zip の test が持つ）。値はすべて合成。
 */

const ASSET = "11111111-1111-4111-8111-111111111111";
const OTHER_ASSET = "22222222-2222-4222-8222-222222222222";
const noPhotos = new Map<string, FolderExportPhoto>();
const empty: PageFields = { entities: [], terms: [], background: "" };
const noFields = new Map<string, PageFields>();

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const image = (assetId: string, alt = "") => ({ type: "image", attrs: { assetId, alt, credit: null } });
const page = (title: string, blocks: unknown[] = [paragraph("合成の本文")], kind?: string): FolderExportPage => ({ id: `id-${title}`, title, blocks, ...(kind ? { kind } : {}) });
const folder = (title: string, blocks: unknown[] = []): FolderExportPage => page(title, blocks, "folder");
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

  it("counts the numbered names it made as used: a, a, a-2 never produces a-2.md twice (zip refuses the whole export)", () => {
    expect(uniqueFileNames(["a", "a", "a-2"])).toEqual(["a.md", "a-2.md", "a-2-2.md"]);
    expect(uniqueFileNames(["a-2", "a", "a"])).toEqual(["a-2.md", "a.md", "a-3.md"]);
    expect(uniqueFileNames(["a", "A", "a-2", "A-2"])).toEqual(["a.md", "A-2.md", "a-2-2.md", "A-2-3.md"]);
    // 比べるのは zip と同じ形（NFC・小文字）。濁点を合成した字と分けた字は同じ名前
    const names = uniqueFileNames(["\u30ac", "\u30ab\u3099"]);
    expect(names[0]).toBe("\u30ac.md");
    expect(names[1]).toBe("\u30ab\u3099-2.md");
    const all = uniqueFileNames(Array.from({ length: 30 }, (_, index) => (index % 3 === 0 ? "x" : index % 3 === 1 ? "x-2" : "X-3")));
    expect(new Set(all.map((name) => name.normalize("NFC").toLowerCase())).size).toBe(all.length);
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

describe("recordingInfoMarkdown（この録音について）", () => {
  it("puts 登場人物・固有名詞・背景 under their own headings", () => {
    const fields: PageFields = {
      entities: [{ name: "田中", reading: "たなか", role: "店主", note: "" }],
      terms: [{ term: "北鎌倉", reading: "きたかまくら", variants: ["北鎌"], note: "駅名" }],
      background: " 取材の背景 ",
    };
    expect(recordingInfoMarkdown(fields)).toBe("## 登場人物\n- 田中 · たなか · 店主\n\n## 固有名詞\n- 北鎌倉 · きたかまくら · 北鎌 · 駅名\n\n## 背景\n取材の背景");
  });

  it("leaves out an empty section, and is null when everything is empty", () => {
    expect(recordingInfoMarkdown({ ...empty, background: "背景だけ" })).toBe("## 背景\n背景だけ");
    expect(recordingInfoMarkdown(empty)).toBeNull();
    expect(recordingInfoMarkdown({ ...empty, background: "  " })).toBeNull();
  });
});

describe("pageMarkdown", () => {
  it("keeps a checklist in a folder export beside a photo", () => {
    const body = [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph("確認")]}] }, image(ASSET, "合成写真")];
    expect(pageMarkdown(page("確認表", body), () => "photos/a.jpg")).toBe("# 確認表\n\n- [x] 確認\n\n![合成写真](photos/a.jpg)\n");
  });
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
  it("writes one .md per page in tree order (no 背景情報.md), and the photos once each", () => {
    const photos = new Map([
      [ASSET, photo("a")],
      [OTHER_ASSET, photo("b", "image/png")],
    ]);
    const result = buildFolderExport({
      pages: [folder("鎌倉の記事", [paragraph("旧の背景")]), page("取材メモ", [image(ASSET, "店")]), page("録音", [image(ASSET), image(OTHER_ASSET)], "rec")],
      fields: noFields,
      photos,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toEqual(["取材メモ.md", "録音.md", photoArchivePath(photo("a")), photoArchivePath(photo("b", "image/png"))]);
    expect(result.photos).toBe(2);
    // バイトは zip（形は editor-publish の zip の test が持つ）
    expect([...result.bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(result.bytes.byteLength).toBeGreaterThan(100);
  });

  it("puts この録音について at the top of a recording page only, from that recording's own fields", () => {
    const rec = page("録音", [paragraph("文字起こし")], "rec");
    const fields: PageFields = { entities: [{ name: "田中", reading: "", role: "", note: "" }], terms: [], background: "取材の目的" };
    const info = recordingInfoMarkdown(fields);
    expect(pageMarkdown(rec, () => null, info)).toBe("# 録音\n\n## 登場人物\n- 田中\n\n## 背景\n取材の目的\n\n文字起こし\n");
    const result = buildFolderExport({ pages: [folder("フォルダ"), rec, page("メモ")], fields: new Map([[rec.id, fields], ["id-メモ", fields]]), photos: noPhotos });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toEqual(["録音.md", "メモ.md"]);
  });

  it("writes the root too when it is not a folder (a recording and its step pages)", () => {
    const result = buildFolderExport({ pages: [page("録音", [paragraph("本文")], "rec"), page("記事本文", [paragraph("本文")], "step")], fields: noFields, photos: noPhotos });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toEqual(["録音.md", "記事本文.md"]);
  });

  it("leaves a photo out when no body points at it", () => {
    const result = buildFolderExport({ pages: [folder("フォルダ"), page("メモ")], fields: noFields, photos: new Map([[ASSET, photo("a")]]) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toEqual(["メモ.md"]);
    expect(result.photos).toBe(0);
  });

  it("refuses an empty folder, too many pages and too many characters, without building anything", () => {
    expect(buildFolderExport({ pages: [], fields: noFields, photos: noPhotos })).toEqual({ ok: false, reason: "empty" });
    expect(buildFolderExport({ pages: [folder("フォルダ", [paragraph("旧の本文")])], fields: noFields, photos: noPhotos })).toEqual({ ok: false, reason: "empty" });

    const many = Array.from({ length: FOLDER_EXPORT_MAX_TABS + 1 }, (_, index) => page(`p${index}`));
    expect(buildFolderExport({ pages: [folder("フォルダ"), ...many], fields: noFields, photos: noPhotos })).toEqual({ ok: false, reason: "too_many" });

    const long = page("長い", [paragraph("あ".repeat(FOLDER_EXPORT_MAX_CHARS + 10))]);
    expect(buildFolderExport({ pages: [folder("フォルダ"), long], fields: noFields, photos: noPhotos })).toEqual({ ok: false, reason: "too_large" });
  });

  it("never names a page 背景情報.md on its own account: a page titled 背景情報 is just one file", () => {
    const result = buildFolderExport({ pages: [folder("背景情報", [paragraph("本文")]), page("背景情報")], fields: noFields, photos: noPhotos });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toEqual(["背景情報.md"]);
  });
});
