import type { Block } from "@niho/editor-store";
import { describe, expect, it } from "vitest";
import { alignBlocks, blockText, diffBlocks, markAiInserted, partLabel, stripAiMarks } from "./block-diff";

const t = (text: string, ...marks: string[]): Block => (marks.length > 0 ? { type: "text", text, marks: marks.map((type) => ({ type })) } : { type: "text", text });
const p = (...content: Block[]): Block => ({ type: "paragraph", content });
const h = (level: number, text: string): Block => ({ type: "heading", attrs: { level }, content: [t(text)] });
const li = (text: string): Block => ({ type: "listItem", content: [p(t(text))] });
const ul = (...items: string[]): Block => ({ type: "bulletList", content: items.map(li) });

/** 段落の中を [文字, ai か] の並びにする。 */
function runs(block: Block): Array<[string, boolean]> {
  return ((block.content ?? []) as Block[]).map((inline) => [
    String(inline.text ?? ""),
    Array.isArray(inline.marks) && (inline.marks as Array<{ type: string }>).some((mark) => mark.type === "ai"),
  ]);
}

describe("blockText", () => {
  it("葉は行の中の文字（改行は \\n）、容器は子を改行でつなぐ", () => {
    expect(blockText(p(t("a"), { type: "hardBreak" }, t("b")))).toBe("a\nb");
    expect(blockText(ul("one", "two"))).toBe("one\ntwo");
    expect(blockText({ type: "horizontalRule" })).toBe("");
  });
});

describe("alignBlocks", () => {
  it("同じブロックを anchor にし、間の残りを順に対にする", () => {
    const before = [p(t("A")), p(t("B")), p(t("C"))];
    const after = [p(t("A")), p(t("B2")), p(t("C")), p(t("D"))];
    expect(alignBlocks(before, after)).toEqual([
      { kind: "same", beforeIndex: 0, afterIndex: 0 },
      { kind: "changed", beforeIndex: 1, afterIndex: 1 },
      { kind: "same", beforeIndex: 2, afterIndex: 2 },
      { kind: "inserted", afterIndex: 3 },
    ]);
  });

  it("段落の削除と順序の入れ替えを anchor で見分ける", () => {
    expect(alignBlocks([p(t("A")), p(t("B")), p(t("C"))], [p(t("A")), p(t("C"))])).toEqual([
      { kind: "same", beforeIndex: 0, afterIndex: 0 },
      { kind: "deleted", beforeIndex: 1 },
      { kind: "same", beforeIndex: 2, afterIndex: 1 },
    ]);
    // 入れ替え: B を残し A は消して後ろに足した扱い
    expect(alignBlocks([p(t("A")), p(t("B"))], [p(t("B")), p(t("A"))]).filter((pair) => pair.kind === "same")).toHaveLength(1);
  });

  it("大きすぎる本文は位置が同じものだけを対にする", () => {
    const before = Array.from({ length: 401 }, (_, index) => p(t(`b${index}`)));
    const after = Array.from({ length: 402 }, (_, index) => p(t(index === 0 ? "b0" : `x${index}`)));
    const pairs = alignBlocks(before, after);
    expect(pairs[0]).toEqual({ kind: "same", beforeIndex: 0, afterIndex: 0 });
    expect(pairs[1]).toEqual({ kind: "changed", beforeIndex: 1, afterIndex: 1 });
    expect(pairs.at(-1)).toEqual({ kind: "inserted", afterIndex: 401 });
  });
});

describe("diffBlocks", () => {
  it("同じ type の葉は語の差分、type が違えば parts は null、消したブロックは中身を返す", () => {
    const hunks = diffBlocks([p(t("the quick fox")), h(2, "title"), p(t("gone"))], [p(t("the slow fox")), h(3, "title")]);
    expect(hunks[0]).toEqual({ kind: "changed", beforeIndex: 0, afterIndex: 0, parts: ["the ", { del: "quick" }, { ins: "slow" }, " fox"] });
    // 見出しの level の変更は同じ type なので parts がある（文は同じ）
    expect(hunks[1]).toEqual({ kind: "changed", beforeIndex: 1, afterIndex: 1, parts: ["title"] });
    expect(hunks[2]).toEqual({ kind: "deleted", beforeIndex: 2, block: p(t("gone")) });
    expect(diffBlocks([p(t("a"))], [ul("a")])).toEqual([{ kind: "changed", beforeIndex: 0, afterIndex: 0, parts: null }]);
  });

  describe("文字が同じで書式・構造だけ違う変更", () => {
    const link = (href: string, text: string): Block => ({ type: "text", text, marks: [{ type: "link", attrs: { href } }] });
    const quote = (...content: Block[]): Block => ({ type: "blockquote", content });

    it("太字を付けただけでも changed になり、語の差分は無い（parts は文字だけ）", () => {
      const hunks = diffBlocks([p(t("a b"))], [p(t("a "), t("b", "bold"))]);
      expect(hunks).toEqual([{ kind: "changed", beforeIndex: 0, afterIndex: 0, parts: ["a b"] }]);
      expect(alignBlocks([p(t("a b"))], [p(t("a "), t("b", "bold"))])).toEqual([{ kind: "changed", beforeIndex: 0, afterIndex: 0 }]);
    });

    it("リンク先だけ変えても changed になる", () => {
      const hunks = diffBlocks([p(link("https://a.example/", "here"))], [p(link("https://b.example/", "here"))]);
      expect(hunks).toHaveLength(1);
      expect(hunks[0]).toMatchObject({ kind: "changed", beforeIndex: 0, afterIndex: 0 });
    });

    it("引用の中の段落を同じ文字の見出しにしただけでも changed になる（容器は parts が null）", () => {
      const hunks = diffBlocks([quote(p(t("quoted")))], [quote(h(2, "quoted"))]);
      expect(hunks).toEqual([{ kind: "changed", beforeIndex: 0, afterIndex: 0, parts: null }]);
    });

    it("anchor を使わない大きい本文でも、書式だけ違うブロックを見逃さない", () => {
      const before = Array.from({ length: 401 }, (_, index) => p(t(`b${index}`)));
      const after = before.map((block, index) => (index === 6 ? p(t("b6", "bold")) : block));
      const hunks = diffBlocks(before, after);
      expect(hunks).toEqual([{ kind: "changed", beforeIndex: 6, afterIndex: 6, parts: ["b6"] }]);
    });

    it("ai だけの違い・mark の並び・text の分かれ方・null の attrs は変更にしない", () => {
      expect(diffBlocks([p(t("kept", "ai"), t(" text"))], [p(t("kept text"))])).toEqual([]);
      expect(diffBlocks([p(t("ab", "bold", "italic"))], [p(t("a", "italic", "bold"), t("b", "bold", "italic"))])).toEqual([]);
      const code = (attrs?: Record<string, unknown>): Block => ({ type: "codeBlock", ...(attrs ? { attrs } : {}), content: [t("x")] });
      expect(diffBlocks([code({ language: null })], [code()])).toEqual([]);
    });
  });
});

describe("markAiInserted", () => {
  it("1 語だけ変えた段落は、その語だけ ai になり、前からあった ai は残る", () => {
    const before = [p(t("the "), t("old", "ai"), t(" quick fox"))];
    const after = [p(t("the old slow fox"))];
    expect(runs(markAiInserted(before, after)[0]!)).toEqual([["the ", false], ["old", true], [" ", false], ["slow", true], [" fox", false]]);
  });

  it("ほかの mark はそのまま保ち、ai を足した文字は ai を最後に持つ", () => {
    const [out] = markAiInserted([p(t("a b"))], [p(t("a "), t("new", "bold"), t(" b"))]);
    // 語の差分は「new 」（語と後ろの空白）を足した扱いになる
    expect(out!.content).toEqual([t("a "), t("new", "bold", "ai"), t(" ", "ai"), t("b")]);
  });

  it("足した段落は全部 ai、消した段落は出ない", () => {
    const out = markAiInserted([p(t("A")), p(t("B"))], [p(t("A")), p(t("added words"))]);
    expect(runs(out[0]!)).toEqual([["A", false]]);
    expect(runs(out[1]!)).toEqual([["added words", true]]);
  });

  it("same の対は Markdown の往復で落ちた前の ai を引き継ぐ", () => {
    const out = markAiInserted([p(t("kept", "ai"), t(" text"))], [p(t("kept text"))]);
    expect(runs(out[0]!)).toEqual([["kept", true], [" text", false]]);
  });

  it("空から全部書いたときは全部 ai（入れ子の容器の中も）", () => {
    const out = markAiInserted([], [h(2, "title"), ul("one", "two"), { type: "horizontalRule" }]);
    expect(runs(out[0]!)).toEqual([["title", true]]);
    expect(out[1]).toEqual({ type: "bulletList", content: [
      { type: "listItem", content: [p(t("one", "ai"))] },
      { type: "listItem", content: [p(t("two", "ai"))] },
    ] });
    expect(out[2]).toEqual({ type: "horizontalRule" });
  });

  it("箇条書きの中の 1 項目だけ変えると、その項目の足した語だけ ai", () => {
    const out = markAiInserted([ul("first item", "second item")], [ul("first item", "second new item")]);
    expect(out[0]).toEqual({ type: "bulletList", content: [
      li("first item"),
      { type: "listItem", content: [p(t("second "), t("new ", "ai"), t("item"))] },
    ] });
  });

  it("見出しの level だけ変えたときは文字に ai を付けない", () => {
    const out = markAiInserted([h(2, "title")], [h(3, "title")]);
    expect(out[0]).toEqual(h(3, "title"));
  });

  it("書式だけ変えたときは文字に ai を付けない（足した語ではない）", () => {
    const out = markAiInserted([p(t("a b"))], [p(t("a "), t("b", "bold"))]);
    expect(out[0]).toEqual(p(t("a "), t("b", "bold")));
  });

  it("改行は 1 文字として扱い、そのまま残す", () => {
    const out = markAiInserted([p(t("a"), { type: "hardBreak" }, t("b"))], [p(t("a"), { type: "hardBreak" }, t("b c"))]);
    expect(out[0]!.content).toEqual([t("a"), { type: "hardBreak" }, t("b"), t(" c", "ai")]);
  });
});

describe("stripAiMarks", () => {
  it("ai を外して隣り合った同じ mark の text をまとめ、ai の無い本文は同じ形のまま", () => {
    expect(stripAiMarks([p(t("a"), t("b", "ai"), t("c", "bold", "ai"), t("d", "bold"))])).toEqual([p(t("ab"), t("cd", "bold"))]);
    const plainBody = [ul("one"), p(t("x"), { type: "hardBreak" }, t("y"))];
    expect(stripAiMarks(plainBody)).toEqual(plainBody);
  });
});

describe("partLabel（#281）", () => {
  it("画像は「（画像）」、録音は「（録音）」、それ以外は null", () => {
    expect(partLabel({ type: "image", attrs: { assetId: "11111111-1111-4111-8111-111111111111" } })).toBe("（画像）");
    expect(partLabel({ type: "recording", attrs: { assetId: "11111111-1111-4111-8111-111111111111" } })).toBe("（録音）");
    expect(partLabel({ type: "paragraph", content: [] })).toBeNull();
  });
});
