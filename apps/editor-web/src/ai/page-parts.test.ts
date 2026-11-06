import { describe, expect, it } from "vitest";
import type { Block } from "@niho/editor-store";
import { markAiInserted } from "./block-diff";
import {
  PARTS_TEXT,
  blockToPartsMarkdown,
  checkParts,
  pageToPartsMarkdown,
  parseRemoveImages,
  partPlaceholder,
  partsMarkdownToBlocks,
  protectParts,
} from "./page-parts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const R = "33333333-3333-4333-8333-333333333333";

const p = (text: string): Block => ({ type: "paragraph", content: [{ type: "text", text }] });
const image = (assetId: string, attrs: Record<string, unknown> = {}): Block => ({ type: "image", attrs: { assetId, ...attrs } });
const recording: Block = { type: "recording", attrs: { assetId: R } };

describe("プレースホルダ（#281）", () => {
  it("画像は ![代替文](niho-asset:ID \"キャプション\")、録音は [録音](niho-asset:ID) の 1 行", () => {
    expect(partPlaceholder(image(A))).toBe(`![](niho-asset:${A})`);
    expect(partPlaceholder(image(A, { alt: "合成の海" }))).toBe(`![合成の海](niho-asset:${A})`);
    expect(partPlaceholder(image(A, { caption: "合成の朝" }))).toBe(`![](niho-asset:${A} "合成の朝")`);
    expect(partPlaceholder(recording)).toBe(`[録音](niho-asset:${R})`);
    expect(partPlaceholder(p("本文"))).toBeNull();
  });

  it("代替文・キャプションの [ ] \" \\ はエスケープし、改行は空白にして 1 行を壊さない", () => {
    const line = partPlaceholder(image(A, { alt: "合成[の]海\n二行目\\", caption: "合成\"の\"朝\r\n次" }))!;
    expect(line).toBe(`![合成\\[の\\]海 二行目\\\\](niho-asset:${A} "合成\\"の\\"朝 次")`);
    expect(line.includes("\n")).toBe(false);
    // 同じ表記のまま戻すと、改行を含む元の値をそのまま保つ（無駄な差分を作らない）
    const original = [image(A, { alt: "合成[の]海\n二行目\\", caption: "合成\"の\"朝\r\n次", credit: "合成の撮影者", consent: true })];
    expect(partsMarkdownToBlocks(line, original)).toEqual({ ok: true, value: original });
  });

  it("本文 → Markdown → 本文の往復で元と同じ（画像・録音・ふつうの段落）", () => {
    const blocks = [
      p("合成の書き出し"),
      image(A, { alt: "合成の海", caption: "合成の朝", credit: "合成の撮影者", consent: false }),
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "合成の見出し" }] },
      recording,
      { type: "bulletList", content: [{ type: "listItem", content: [p("合成の項目")] }] },
      image(B),
    ] satisfies Block[];
    const markdown = pageToPartsMarkdown(blocks);
    expect(markdown.ok).toBe(true);
    if (!markdown.ok) return;
    expect(partsMarkdownToBlocks(markdown.value, blocks)).toEqual({ ok: true, value: blocks });
  });

  it("入れ子の中（引用・箇条書き）の画像・録音は Markdown にできず、入れ子の中にあるという文で断る", () => {
    expect(blockToPartsMarkdown({ type: "blockquote", content: [image(A)] })).toEqual({ ok: false, reason: PARTS_TEXT.nested });
    expect(pageToPartsMarkdown([p("本文"), { type: "bulletList", content: [{ type: "listItem", content: [recording] }] }])).toEqual({ ok: false, reason: PARTS_TEXT.nested });
    expect(PARTS_TEXT.nested).toContain("箇条書き・引用・囲み・表の中");
  });
});

describe("Markdown → 本文の復元", () => {
  const originals = [p("本文"), image(A, { alt: "合成の海", credit: "合成の撮影者" }), recording];

  it("段落の途中に書かれた行も独立した段落として戻し、代替文・キャプションだけ新しい値になる", () => {
    const result = partsMarkdownToBlocks(`前の文\n![合成の青い海](niho-asset:${A} "合成の朝")\n後の文\n\n[録音](niho-asset:${R})`, originals);
    expect(result).toEqual({ ok: true, value: [p("前の文"), image(A, { alt: "合成の青い海", caption: "合成の朝", credit: "合成の撮影者" }), p("後の文"), recording] });
  });

  it("代替文を空にすると alt を外す。大文字の id も同じ画像として扱う", () => {
    expect(partsMarkdownToBlocks(`![](niho-asset:${A.toUpperCase()})`, originals)).toEqual({ ok: true, value: [image(A, { credit: "合成の撮影者" })] });
  });

  it("元に無い assetId・種類の違う行・同じ行の 2 回目・入れ子の中の行は断る", () => {
    expect(partsMarkdownToBlocks(`![](niho-asset:${B})`, originals)).toEqual({ ok: false, reason: PARTS_TEXT.unknownPart });
    expect(partsMarkdownToBlocks(`![](niho-asset:${R})`, originals)).toEqual({ ok: false, reason: PARTS_TEXT.unknownPart });
    expect(partsMarkdownToBlocks(`![](niho-asset:${A})\n\n![](niho-asset:${A})`, originals)).toEqual({ ok: false, reason: PARTS_TEXT.duplicatePart });
    expect(partsMarkdownToBlocks(`- 項目\n\n  ![](niho-asset:${A})`, originals)).toEqual({ ok: false, reason: PARTS_TEXT.misplacedPart });
  });

  it("囲みのコードの中の行はプレースホルダとして読まない", () => {
    const protectedParts = protectParts("```\n![](niho-asset:" + A + ")\n```");
    expect(protectedParts.ok && protectedParts.value.markers.size).toBe(0);
  });

  it("目印は本文の文字と衝突しない（本文に同じ接頭辞 + nonce があれば別の nonce を選ぶ）", () => {
    const nonces = ["aaaa", "bbbb"];
    const markdown = `NIHOASSETPARTaaaaN1Z を含む本文\n\n![](niho-asset:${A})`;
    const protectedParts = protectParts(markdown, () => nonces.shift()!);
    expect(protectedParts.ok).toBe(true);
    if (!protectedParts.ok) return;
    expect(protectedParts.value.stem).toBe("NIHOASSETPARTbbbb");
    // 本文に目印と同じ文字があっても、その段落は本文のまま残る
    expect(partsMarkdownToBlocks(markdown, originals)).toEqual({ ok: true, value: [p("NIHOASSETPARTaaaaN1Z を含む本文"), image(A, { credit: "合成の撮影者" })] });
    // nonce を選び直せなければ（いつも衝突する）、推し量らずに断る
    expect(partsMarkdownToBlocks(markdown, originals, [], () => "aaaa").ok).toBe(false);
  });

  it("remove_images の画像は行が残っていても外す", () => {
    expect(partsMarkdownToBlocks(`本文\n\n![合成の海](niho-asset:${A})`, originals, [A])).toEqual({ ok: true, value: [p("本文")] });
  });
});

describe("書き込みの検査（checkParts）", () => {
  const before = [p("本文"), image(A, { alt: "合成の海" }), image(B), recording];

  it("画像・録音が全部残れば通る（位置の移動・代替文の変更は可）", () => {
    expect(checkParts(before, [recording, image(B), p("直した"), image(A, { alt: "合成の青い海" })], [])).toEqual({ ok: true, value: null });
  });

  it("画像が消えたら、id と代替文を入れて断る。remove_images にあれば通る", () => {
    const result = checkParts(before, [p("本文"), image(B), recording], []);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain(`画像 ${A}（合成の海）が消えるので保存しませんでした`);
    expect(!result.ok && result.reason).toContain("remove_images");
    expect(checkParts(before, [p("本文"), image(B), recording], [A])).toEqual({ ok: true, value: null });
  });

  it("録音は消せず、属性も変えられない（remove_images でも消せない）", () => {
    expect(checkParts(before, [p("本文"), image(A), image(B)], [])).toEqual({ ok: false, reason: PARTS_TEXT.recordingChanged });
    expect(checkParts(before, [p("本文"), image(A), image(B)], [R])).toEqual({ ok: false, reason: PARTS_TEXT.removeUnknown });
  });

  it("remove_images に元に無い id、新しい画像、同じ画像の 2 回目は断る", () => {
    expect(checkParts(before, before, ["44444444-4444-4444-8444-444444444444"])).toEqual({ ok: false, reason: PARTS_TEXT.removeUnknown });
    expect(checkParts(before, [...before, image("44444444-4444-4444-8444-444444444444")], [])).toEqual({ ok: false, reason: PARTS_TEXT.unknownPart });
    expect(checkParts(before, [...before, image(A)], [])).toEqual({ ok: false, reason: PARTS_TEXT.duplicatePart });
  });

  it("remove_images の画像が本文に残っていれば断る（edit_page の範囲の外）", () => {
    const result = checkParts(before, before, [A]);
    expect(result.ok).toBe(false);
  });

  it("parseRemoveImages は uuid の配列だけ受ける", () => {
    expect(parseRemoveImages(undefined)).toEqual([]);
    expect(parseRemoveImages([A])).toEqual([A]);
    expect(parseRemoveImages("x")).toBeNull();
    expect(parseRemoveImages(["not-a-uuid"])).toBeNull();
  });
});

describe("ai mark（markAiInserted）は画像・録音を壊さない", () => {
  it("動かした・そのままの画像・録音は同じ形のまま", () => {
    const before = [p("本文"), image(A, { alt: "合成の海", consent: true }), recording];
    const after = [image(A, { alt: "合成の海", consent: true }), p("本文を直した"), recording];
    const marked = markAiInserted(before, after);
    expect(marked[0]).toEqual(after[0]);
    expect(marked[2]).toEqual(recording);
  });
});
