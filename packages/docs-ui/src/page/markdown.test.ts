import { describe, expect, it } from "vitest";
import { blocksToMarkdown, markdownToBlocks } from "./markdown";
import type { Block } from "./blocks";

/** 往復して同じ blocks に戻ることを確かめる（Mac の保管庫は Markdown で持つ）。 */
function roundTrip(blocks: Block[]): Block[] {
  const markdown = blocksToMarkdown(blocks);
  expect(markdown.ok, markdown.ok ? "" : markdown.reason).toBe(true);
  if (!markdown.ok) throw new Error(markdown.reason);
  const back = markdownToBlocks(markdown.markdown);
  expect(back.ok, back.ok ? "" : back.reason).toBe(true);
  if (!back.ok) throw new Error(back.reason);
  return back.blocks;
}

const text = (value: string): Block => ({ type: "text", text: value });

describe("限定 AST ↔ Markdown", () => {
  it("空の本文は空の配列", () => {
    expect(markdownToBlocks("")).toEqual({ ok: true, blocks: [] });
    expect(markdownToBlocks("\n  \n")).toEqual({ ok: true, blocks: [] });
    expect(blocksToMarkdown([])).toEqual({ ok: true, markdown: "" });
  });

  it("段落・見出し・箇条書き・番号付き・引用・区切り線が往復する", () => {
    const blocks: Block[] = [
      { type: "heading", attrs: { level: 2 }, content: [text("見出し")] },
      { type: "paragraph", content: [text("本文の段落。")] },
      { type: "heading", attrs: { level: 3 }, content: [text("小見出し")] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("ひとつめ")] }] }] },
      { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("順番")] }] }] },
      { type: "blockquote", content: [{ type: "paragraph", content: [text("引用")] }] },
      { type: "horizontalRule" },
      { type: "paragraph", content: [text("おわり")] },
    ];
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("太字・斜体・リンク・改行が往復する", () => {
    const blocks: Block[] = [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "太字", marks: [{ type: "bold" }] },
          text("と"),
          { type: "text", text: "斜体", marks: [{ type: "italic" }] },
          { type: "hardBreak" },
          { type: "text", text: "リンク", marks: [{ type: "link", attrs: { href: "https://example.com/a" } }] },
        ],
      },
    ];
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("AI が足した語の印（ai）は Markdown に記号を出さず、ほかの mark はそのまま書く", () => {
    const blocks: Block[] = [
      {
        type: "paragraph",
        content: [
          text("前の"),
          { type: "text", text: "新しい語", marks: [{ type: "ai" }] },
          { type: "text", text: "太字", marks: [{ type: "bold" }, { type: "ai" }] },
          text("の後"),
        ],
      },
    ];
    expect(blocksToMarkdown(blocks)).toEqual({ ok: true, markdown: "前の新しい語**太字**の後" });
  });

  it("囲みは引用の中の目印で往復する（旧い画面では引用として読める）", () => {
    const blocks: Block[] = [
      { type: "callout", content: [{ type: "paragraph", content: [text("囲みの中")] }] },
      { type: "blockquote", content: [{ type: "paragraph", content: [text("ふつうの引用")] }] },
    ];
    const markdown = blocksToMarkdown(blocks);
    expect(markdown.ok).toBe(true);
    if (!markdown.ok) throw new Error(markdown.reason);
    expect(markdown.markdown).toContain("> [!note]");
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("GitHub の注記の書き方（目印の次の行から本文）も囲みとして読む", () => {
    const callout = (value: string): Block => ({ type: "callout", content: [{ type: "paragraph", content: [text(value)] }] });
    for (const markdown of ["> [!note]\n> 合成の注記\n", "> [!NOTE]\n> 合成の注記\n"]) {
      const result = markdownToBlocks(markdown);
      expect(result.ok, markdown).toBe(true);
      if (!result.ok) return;
      expect(result.blocks, markdown).toEqual([callout("合成の注記")]);
    }
    // 目印の行のあとの段落も、囲みの中に入る
    const two = markdownToBlocks("> [!note]\n> 一つ目\n>\n> 二つ目\n");
    expect(two.ok && two.blocks).toEqual([
      { type: "callout", content: [{ type: "paragraph", content: [text("一つ目")] }, { type: "paragraph", content: [text("二つ目")] }] },
    ]);
    // 目印の後ろに文字が続く行は目印ではない（ふつうの引用）
    const inline = markdownToBlocks("> [!note] 合成の注記\n");
    expect(inline.ok && inline.blocks[0]?.type).toBe("blockquote");
  });

  it("番号付きの起点を保つ", () => {
    const blocks: Block[] = [
      {
        type: "orderedList",
        attrs: { start: 3 },
        content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("みっつめから")] }] }],
      },
    ];
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("表・チェック状態・コード書式が Markdown と往復する", () => {
    const markdown = "| 項目 | 状態 |\n| --- | --- |\n| 本文 | ~~旧~~ `新` |\n\n- [x] 完了\n- [ ] 未完了\n\n```ts\nconst a = 1;\n```";
    const parsed = markdownToBlocks(markdown);
    expect(parsed.ok, parsed.ok ? "" : parsed.reason).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.blocks.map((block) => block.type)).toEqual(["table", "taskList", "codeBlock"]);
    expect(JSON.stringify(parsed.blocks)).toContain('"checked":true');
    expect(JSON.stringify(parsed.blocks)).toContain('"type":"strike"');
    expect(JSON.stringify(parsed.blocks)).toContain('"type":"code"');
    const written = blocksToMarkdown(parsed.blocks);
    expect(written.ok, written.ok ? "" : written.reason).toBe(true);
    if (!written.ok) return;
    expect(markdownToBlocks(written.markdown)).toEqual(parsed);
  });

  it("表の配置と区切り文字、空のチェック項目を保つ", () => {
    const source = "| 左 | 右 |\n| :--- | ---: |\n| A\\|B | x |\n\n- [ ]\n- [x] done";
    const first = markdownToBlocks(source);
    expect(first.ok, first.ok ? "" : first.reason).toBe(true);
    if (!first.ok) return;
    const written = blocksToMarkdown(first.blocks);
    expect(written.ok, written.ok ? "" : written.reason).toBe(true);
    if (!written.ok) return;
    expect(written.markdown).toContain(":---");
    expect(written.markdown).toContain("---:");
    expect(markdownToBlocks(written.markdown)).toEqual(first);
  });

  it("内部にバックティックを含むインラインコードが往復する", () => {
    for (const value of ["a`b", "`先頭", "末尾`", "a``b", "`囲み`"]) {
      const blocks: Block[] = [{ type: "paragraph", content: [{ type: "text", text: value, marks: [{ type: "code" }] }] }];
      expect(roundTrip(blocks), value).toEqual(blocks);
    }
  });

  it("表のセルにあるインラインコードの縦線が往復する", () => {
    const blocks: Block[] = [{ type: "table", content: [
      { type: "tableRow", content: [{ type: "tableHeader", attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null }, content: [{ type: "paragraph", content: [text("式")] }] }] },
      { type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "a | b", marks: [{ type: "code" }] }] }] }] },
    ] }];
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("記号を含む本文が、往復で記号のまま残る（斜体・コードに化けない）", () => {
    for (const text of ["a * b * c", "小計 * 2 個", "値は `code` と書く", "a_b_c", "[かっこ] と ~~波~~", "# シャープ", "- ハイフン", "1. 数字"]) {
      const blocks: Block[] = [{ type: "paragraph", content: [{ type: "text", text }] }];
      expect(roundTrip(blocks), text).toEqual(blocks);
    }
  });

  it("バックティックを含む本文を保存したあと、同じページをもう一度開ける", () => {
    const blocks: Block[] = [{ type: "paragraph", content: [{ type: "text", text: "`npm ci` を実行する" }] }];
    const markdown = blocksToMarkdown(blocks);
    expect(markdown.ok).toBe(true);
    if (!markdown.ok) throw new Error(markdown.reason);
    // escape していないと markdown-it が code の token を作り、限定 AST の外なので開けなくなる
    const back = markdownToBlocks(markdown.markdown);
    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error(back.reason);
    expect(back.blocks).toEqual(blocks);
  });

  it("囲みの目印と同じ文字を打っても、囲みにならない", () => {
    const blocks: Block[] = [{ type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "[!note]" }] }] }];
    expect(roundTrip(blocks)).toEqual(blocks);
  });

  it("限定 AST の外の記法は、黙って捨てずに断る", () => {
    for (const markdown of [
      "![alt](niho-docs-asset:photo.jpg)",
      "# 見出し 1",
      "#### 見出し 4",
      "| broken |\n| --- | --- |\n| too | many | cells |",
    ]) {
      const result = markdownToBlocks(markdown);
      expect(result.ok, markdown).toBe(false);
    }
  });

  it("AI の本文向けの clamp は、見出しの段階だけを 2・3 にそろえ、ほかの対応外はそのまま断る", () => {
    const heading = (level: number, value: string): Block => ({ type: "heading", attrs: { level }, content: [text(value)] });
    const result = markdownToBlocks("# 題名\n\n段落\n\n#### 四\n\n###### 六\n\n> # 引用の中\n", { headings: "clamp" });
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
    if (!result.ok) return;
    expect(result.blocks).toEqual([
      heading(2, "題名"),
      { type: "paragraph", content: [text("段落")] },
      heading(3, "四"),
      heading(3, "六"),
      { type: "blockquote", content: [heading(2, "引用の中")] },
    ]);
    // 既定（strict）は今までどおり断る。画像は clamp でも断る
    expect(markdownToBlocks("# 題名").ok).toBe(false);
    expect(markdownToBlocks("![alt](niho-docs-asset:photo.jpg)", { headings: "clamp" }).ok).toBe(false);
  });

  it("HTML は（旧い画面と同じく）文字のまま持つ", () => {
    const result = markdownToBlocks("<div>html</div>");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(blocksToMarkdown(result.blocks)).toEqual({ ok: true, markdown: "<div>html</div>" });
  });

  it("保存できない scheme のリンクは、リンクにならず文字のまま残る", () => {
    const result = markdownToBlocks("[押す](javascript:alert(1))");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.blocks)).not.toContain("link");
    expect(JSON.stringify(result.blocks)).toContain("押す");
  });

  it("画像は Markdown に置き場が無いので、書き出しで断る", () => {
    const result = blocksToMarkdown([{ type: "image", attrs: { assetId: "9a1f3b1c-0d11-4c39-9a52-6f6c6f1d0d7c" } }]);
    expect(result.ok).toBe(false);
  });

  it("保存できない blocks は断る", () => {
    expect(blocksToMarkdown([{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [text("見出しなし")] }] }] }] }]).ok).toBe(false);
  });
});
