import { describe, expect, it } from "vitest";
import { exportFullMarkdown, exportMarkdown, MarkdownExportError, markdownLinkHref } from "./markdown";

describe("full page Markdown export", () => {
  it("keeps table, checklist state, code and strike in the downloaded page", () => {
    const body = [
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "項目" }] }] }] }, { type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "値" }] }] }] }] },
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "完了" }] }] }] },
      { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const x = 1;" }] },
      { type: "paragraph", content: [{ type: "text", text: "旧", marks: [{ type: "strike" }] }] },
    ];
    const markdown = exportFullMarkdown(body);
    expect(markdown).toContain("| 項目 |");
    expect(markdown).toContain("- [x] 完了");
    expect(markdown).toContain("```ts");
    expect(markdown).toContain("~~旧~~");
  });

  it("rejects a merged table cell with an explicit reason", () => {
    const body = [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", attrs: { colspan: 2 }, content: [{ type: "paragraph" }] }] }] }];
    expect(() => exportFullMarkdown(body)).toThrow(MarkdownExportError);
    expect(() => exportFullMarkdown(body)).toThrow(/結合セル/);
  });
});

/*
 * ---- oracle ----
 * niho-experience の Markdown サブセットの parser（`apps/web/src/lib/guide-markdown.ts`、origin/main 1595c134）の
 * 受理規則を写した検証関数。書き出した .md が「サブセットとして読める」ことをこれで確かめる。
 * 行番号（L…）は guide-markdown.ts の行。写真（L235-264）と表（L266-318）は書き出しが出さないので、
 * それらの行（`![` `|` で始まる行）はここでは受理せずに落とす（本物より厳しい側に倒している）。
 */

class Rejected extends Error {}

type Inline =
  | { type: "text"; value: string }
  | { type: "strong" | "em"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "confirm"; value: string };
type TextBlock = { type: "paragraph"; children: Inline[] } | { type: "list"; ordered: boolean; items: Inline[][] };
type ParsedBlock = { type: "heading"; level: number; children: Inline[] } | TextBlock | { type: "note"; blocks: TextBlock[] };

const PUNCTUATION = /[!-/:-@[-`{-~]/; // L55
const CONFIRM_OPEN = "[CONFIRM:"; // L56

/** L63-76 guideLinkHref（site path か、資格情報の無い https。safe-url.ts の safeHttpsUrl）。 */
function linkHref(value: string): string | null {
  if (!value || /[\s\\<>"'`]/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (value.startsWith("/")) return value.startsWith("//") ? null : value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** L88-99 closingBracket */
function closingBracket(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "[") throw new Rejected("Links cannot contain another [");
    if (text[i] === "]") return i;
  }
  throw new Rejected("Unclosed [");
}

function inlineText(children: readonly Inline[]): string {
  return children.map((child) => (child.type === "text" ? child.value : child.type === "confirm" ? "" : inlineText(child.children))).join("");
}

/** L108-196 parseGuideInline */
function parseInline(text: string, inLink = false): Inline[] {
  type Frame = { type: "root" | "strong" | "em"; children: Inline[] };
  const stack: Frame[] = [{ type: "root", children: [] }];
  const top = () => stack.at(-1)!;
  const pushText = (children: Inline[], value: string) => {
    const last = children.at(-1);
    if (last?.type === "text") last.value += value;
    else children.push({ type: "text", value });
  };
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    const next = text[i + 1] ?? "";
    if (char === "\\") {
      if (!next || !PUNCTUATION.test(next)) throw new Rejected("A backslash must escape punctuation"); // L115-119
      pushText(top().children, next);
      i += 2;
      continue;
    }
    if (char === "`") throw new Rejected("Inline code"); // L121
    if (char === "<" && /[A-Za-z/!?]/.test(next)) throw new Rejected("Raw HTML"); // L122
    if (char === "&" && /^&#?[A-Za-z0-9]+;/.test(text.slice(i))) throw new Rejected("HTML entity"); // L123
    if (char === "!" && next === "[") throw new Rejected("Inline photo"); // L124
    if (char === "_") throw new Rejected("Underscore"); // L125
    if (char === "~" && next === "~") throw new Rejected("Strikethrough"); // L126
    if (char === "]") throw new Rejected("Unmatched ]"); // L127
    if (char === "[" && text.startsWith(CONFIRM_OPEN, i)) {
      // L128-135（中身は L101-106 plainInline: 書式なしの文字だけ）
      const close = closingBracket(text, i);
      const nodes = parseInline(text.slice(i + CONFIRM_OPEN.length, close), true);
      if (nodes.some((node) => node.type !== "text")) throw new Rejected("CONFIRM is plain text");
      const value = inlineText(nodes).replace(/\s+/g, " ").trim();
      if (!value) throw new Rejected("Empty CONFIRM");
      top().children.push({ type: "confirm", value });
      i = close + 1;
      continue;
    }
    if (char === "[") {
      // L136-152
      if (inLink) throw new Rejected("Nested link");
      const close = closingBracket(text, i);
      if (text[close + 1] !== "(") throw new Rejected("Reference link");
      const end = text.indexOf(")", close + 2);
      if (end === -1) throw new Rejected("Unclosed (");
      const target = text.slice(close + 2, end);
      if (/\s/.test(target) || target.includes("(")) throw new Rejected("Bad link target");
      const href = linkHref(target);
      if (!href) throw new Rejected(`Unsafe link ${target}`);
      const children = parseInline(text.slice(i + 1, close), true);
      if (!children.length) throw new Rejected("A link needs text");
      top().children.push({ type: "link", href, children });
      i = end + 1;
      continue;
    }
    if (char === "*") {
      // L153-190
      let run = 1;
      while (text[i + run] === "*") run++;
      if (run === 3 && stack.length === 2 && (top().type === "strong" || top().type === "em")) {
        const frame = top();
        const before = text[i - 1] ?? "";
        const after = text[i + run] ?? "";
        if (!before || /\s/.test(before) || !after || /\s/.test(after) || !frame.children.length) throw new Rejected("Adjacent marks");
        const closedType = frame.type === "strong" ? "strong" : "em";
        stack.pop();
        top().children.push({ type: closedType, children: frame.children });
        stack.push({ type: closedType === "strong" ? "em" : "strong", children: [] });
        i += run;
        continue;
      }
      if (run > 2) throw new Rejected("***");
      const type = run === 2 ? "strong" : "em";
      const before = text[i - 1] ?? "";
      const after = text[i + run] ?? "";
      const frame = top();
      if (frame.type === type) {
        if (!before || /\s/.test(before)) throw new Rejected("Closing mark after a space");
        if (!frame.children.length) throw new Rejected("Empty emphasis");
        stack.pop();
        top().children.push({ type, children: frame.children });
      } else {
        if (stack.some((open) => open.type === type)) throw new Rejected("Marks close out of order");
        if (!after || /\s/.test(after)) throw new Rejected("Opening mark before a space");
        stack.push({ type, children: [] });
      }
      i += run;
      continue;
    }
    pushText(top().children, char);
    i++;
  }
  if (stack.length > 1) throw new Rejected("Unclosed mark"); // L194
  return stack[0]!.children;
}

const HEADING = /^(#+)(\s+)(.*)$/; // L216
const BULLET = /^-\s+(.*)$/; // L217
const NUMBERED = /^(\d{1,3})\.\s+(.*)$/; // L218

/** L222-232 unsupportedBlock */
function unsupportedBlock(line: string): boolean {
  return (
    /^(?:```|~~~)/.test(line) ||
    line.startsWith(">") ||
    line.startsWith("<") ||
    /^[*+]\s/.test(line) ||
    /^\d{1,3}\)\s/.test(line) ||
    /^(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,}|=+\s*)$/.test(line) ||
    /^\[[^\]]*\]:/.test(line) ||
    /^(?:-|\d{1,3}\.)$/.test(line)
  );
}

/** L328-442 parseBlocks（inNote: `:::note` の中。段落とリストだけ） */
function parseBlocks(lines: readonly string[], inNote: boolean): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let paragraph: string[] | null = null;
  let list: { ordered: boolean; items: Inline[][] } | null = null;
  const closeBlocks = () => {
    if (paragraph) blocks.push({ type: "paragraph", children: parseInline(paragraph.join(" ")) });
    if (list) blocks.push({ type: "list", ...list });
    paragraph = null;
    list = null;
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    index++;
    if (!line.trim()) {
      closeBlocks();
      continue;
    }
    if (/^(?: {4}|\t| {1,3}(?:-|\d{1,3}[.)])\s)/.test(line)) throw new Rejected("Indented line"); // L360-362
    if (line.startsWith(":::")) {
      // L364-378
      if (inNote || line.slice(3).trim() !== "note") throw new Rejected("Bad box");
      closeBlocks();
      const end = lines.findIndex((candidate, at) => at >= index && candidate.trim() === ":::");
      if (end === -1) throw new Rejected("Unclosed box");
      const inner = parseBlocks(lines.slice(index, end), true) as TextBlock[];
      if (!inner.length) throw new Rejected("Empty box");
      blocks.push({ type: "note", blocks: inner });
      index = end + 1;
      continue;
    }
    if (unsupportedBlock(line)) throw new Rejected(`Unsupported block: ${line}`); // L380-381
    if (line.startsWith("#")) {
      // L383-398
      const heading = HEADING.exec(line);
      if (!heading) throw new Rejected("Bad heading");
      const level = heading[1]!.length;
      const text = heading[3]!.trim();
      if (level === 1 || level > 3 || !text || /\s#+$/.test(text) || inNote) throw new Rejected("Bad heading");
      closeBlocks();
      blocks.push({ type: "heading", level, children: parseInline(text) });
      continue;
    }
    if (line.startsWith("![") || line.startsWith("|")) throw new Rejected("Photo or table (never exported)"); // L400-417
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      // L419-434
      const ordered = Boolean(numbered);
      const text = (bullet ? bullet[1] : numbered![2])!.trim();
      if (!text) throw new Rejected("Empty item");
      if (paragraph) blocks.push({ type: "paragraph", children: parseInline((paragraph as string[]).join(" ")) });
      paragraph = null;
      const current = list as { ordered: boolean; items: Inline[][] } | null;
      if (current && current.ordered !== ordered) throw new Rejected("Mixed list");
      const expected = (current?.items.length ?? 0) + 1;
      if (numbered && Number(numbered[1]) !== expected) throw new Rejected("Bad number");
      const items = current?.items ?? [];
      items.push(parseInline(text));
      list = current ?? { ordered, items };
      continue;
    }
    if (list) throw new Rejected("Leave a blank line after a list"); // L436
    if (paragraph) (paragraph as string[]).push(line.trimEnd());
    else paragraph = [line.trimEnd()];
  }
  closeBlocks();
  return blocks;
}

/** L445-448 parseGuideMarkdown */
function oracle(source: string): ParsedBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n").map((text) => text.trimEnd());
  return parseBlocks(lines, false);
}

/** 読んだ結果を、比べやすい形（ブロックごとの文字・入れ子の印）にする。 */
function shape(blocks: readonly ParsedBlock[]): unknown[] {
  const inline = (children: readonly Inline[]): string =>
    children
      .map((child) => {
        if (child.type === "text") return child.value;
        if (child.type === "confirm") return `{CONFIRM:${child.value}}`;
        if (child.type === "link") return `{link ${child.href}:${inline(child.children)}}`;
        return `{${child.type}:${inline(child.children)}}`;
      })
      .join("");
  return blocks.map((block) => {
    if (block.type === "heading") return { h: block.level, text: inline(block.children) };
    if (block.type === "paragraph") return { p: inline(block.children) };
    if (block.type === "list") return { [block.ordered ? "ol" : "ul"]: block.items.map(inline) };
    return { note: shape(block.blocks) };
  });
}

// ---- 合成の本文 ----

type Node = Record<string, unknown>;
const text = (value: string, ...marks: Node[]): Node => (marks.length ? { type: "text", text: value, marks } : { type: "text", text: value });
const p = (...content: Node[]): Node => ({ type: "paragraph", content });
const h = (level: unknown, ...content: Node[]): Node => ({ type: "heading", attrs: { level }, content });
const ul = (...items: Node[][]): Node => ({ type: "bulletList", content: items.map((content) => ({ type: "listItem", content })) });
const ol = (...items: Node[][]): Node => ({ type: "orderedList", attrs: { start: 1 }, content: items.map((content) => ({ type: "listItem", content })) });
const quote = (...content: Node[]): Node => ({ type: "blockquote", content });
const bold: Node = { type: "bold" };
const italic: Node = { type: "italic" };
const link = (href: string): Node => ({ type: "link", attrs: { href, target: "_blank", rel: "noopener noreferrer" } });
const br: Node = { type: "hardBreak" };

/** 書き出して oracle で読み、読めた形を返す（読めなければ Rejected で落ちる）。 */
function roundTrip(blocks: unknown[]): { markdown: string; parsed: unknown[] } {
  const markdown = exportMarkdown(blocks);
  return { markdown, parsed: shape(oracle(markdown)) };
}

describe("the oracle itself", () => {
  it("rejects hand-written Markdown with unescaped special characters", () => {
    const refused = [
      "<script>alert(1)</script>",
      "a <b>tag</b>",
      "snake_case",
      "`code`",
      "> quote",
      "# h1",
      "#### h4",
      "## closed #",
      "---",
      "***",
      "===",
      "- ",
      "* star item",
      "+ plus item",
      "1) paren item",
      "2. starts at two",
      "    indented code",
      "\tTabbed",
      "- a\n  - nested",
      "- a\nparagraph right after a list",
      "**unclosed",
      "*a **b***",
      "***x***",
      "** spaced**",
      "[not a link]",
      "[x](http://example.com/)",
      "[x](javascript:alert(1))",
      "[x](mailto:a@example.com)",
      "[x](https://user:pass@example.com/)",
      "[x](relative/path)",
      "]",
      "a & b &amp; c",
      "~~strike~~",
      "a\\b",
      "line end \\",
      ":::",
      ":::warning\nx\n:::",
      ":::note\n## heading inside\n:::",
      ":::note\n:::",
      ":::note\nnever closed",
      "![photo](https://example.com/a.png)",
      "| a | b |\n| --- | --- |\n| 1 | 2 |",
      "[ref]: https://example.com/",
      "見て![こちら](https://example.com/)",
    ];
    for (const source of refused) expect(() => oracle(source), JSON.stringify(source)).toThrow(Rejected);
  });

  it("accepts the subset, including the escaped forms of the same characters", () => {
    const accepted: Array<[string, unknown[]]> = [
      ["\\<script\\>alert(1)\\</script\\>", [{ p: "<script>alert(1)</script>" }]],
      ["snake\\_case \\`code\\` a \\& b", [{ p: "snake_case `code` a & b" }]],
      ["\\> quote\n\n\\# h1\n\n\\---\n\n1\\) x", [{ p: "> quote" }, { p: "# h1" }, { p: "---" }, { p: "1) x" }]],
      ["## 見出し\n\n### 小見出し", [{ h: 2, text: "見出し" }, { h: 3, text: "小見出し" }]],
      ["一行目\n二行目", [{ p: "一行目 二行目" }]],
      ["- a\n- b\n\n1. c\n2. d", [{ ul: ["a", "b"] }, { ol: ["c", "d"] }]],
      ["**太字** *斜体* [リンク](https://example.com/)", [{ p: "{strong:太字} {em:斜体} {link https://example.com/:リンク}" }]],
      ["**太字***斜体*", [{ p: "{strong:太字}{em:斜体}" }]],
      ["**a *b* c**", [{ p: "{strong:a {em:b} c}" }]],
      ["[CONFIRM: 確かめる]", [{ p: "{CONFIRM:確かめる}" }]],
      [":::note\n箱の中\n\n- 項目\n:::", [{ note: [{ p: "箱の中" }, { ul: ["項目"] }] }]],
      ["\\[CONFIRM: 文字\\] \\*\\* \\\\", [{ p: "[CONFIRM: 文字] ** \\" }]],
    ];
    for (const [source, expected] of accepted) expect(shape(oracle(source)), JSON.stringify(source)).toEqual(expected);
  });
});

describe("exportMarkdown", () => {
  it("returns an empty string for an empty body, and ends other output with one newline", () => {
    expect(exportMarkdown([])).toBe("");
    expect(exportMarkdown([p(), p(text("   ")), { type: "horizontalRule" }, { type: "image", attrs: { src: "https://example.com/a.png" } }])).toBe("");
    expect(exportMarkdown([p(text("本文"))])).toBe("本文\n");
  });

  it("ignores the editor's ai mark (AI が足した語の印) and keeps the other marks", () => {
    expect(exportMarkdown([p(text("前の"), { type: "text", text: "AI の語", marks: [{ type: "ai" }] }, { type: "text", text: "太字", marks: [{ type: "bold" }, { type: "ai" }] })])).toBe("前のAI の語**太字**\n");
    expect(exportFullMarkdown([p(text("前の"), { type: "text", text: "AI の語", marks: [{ type: "ai" }] })])).toBe("前のAI の語\n");
  });

  it("writes headings, paragraphs, lists, and quotes in the subset", () => {
    const { markdown, parsed } = roundTrip([
      h(2, text("見出し")),
      h(3, text("小見出し")),
      p(text("段落の一行目"), br, text("二行目")),
      { type: "horizontalRule" },
      ul([p(text("りんご"))], [p(text("みかん"))]),
      ol([p(text("一つ目"))], [p(text("二つ目"))]),
      quote(p(text("引用の文"))),
    ]);
    expect(markdown).toBe("## 見出し\n\n### 小見出し\n\n段落の一行目 二行目\n\n- りんご\n- みかん\n\n1. 一つ目\n2. 二つ目\n\n:::note\n引用の文\n:::\n");
    expect(parsed).toEqual([
      { h: 2, text: "見出し" },
      { h: 3, text: "小見出し" },
      { p: "段落の一行目 二行目" },
      { ul: ["りんご", "みかん"] },
      { ol: ["一つ目", "二つ目"] },
      { note: [{ p: "引用の文" }] },
    ]);
  });

  it("rounds other heading levels into ## and ### and never writes an h1", () => {
    const { markdown, parsed } = roundTrip([h(1, text("一")), h(2, text("二")), h(4, text("四")), h("2", text("文字列"))]);
    expect(markdown).not.toMatch(/^# /m);
    expect(parsed).toEqual([{ h: 3, text: "一" }, { h: 2, text: "二" }, { h: 3, text: "四" }, { h: 3, text: "文字列" }]);
  });

  it("leaves Japanese text exactly as it is", () => {
    const japanese = "日本語だけの文章です。「かぎ括弧」（丸括弧）、全角の＊記号＃と［角括弧］〜波線ー長音！？";
    const { markdown, parsed } = roundTrip([h(2, text(japanese)), p(text(japanese)), ul([p(text(japanese))])]);
    expect(markdown).toBe(`## ${japanese}\n\n${japanese}\n\n- ${japanese}\n`);
    expect(parsed).toEqual([{ h: 2, text: japanese }, { p: japanese }, { ul: [japanese] }]);
  });

  it("escapes text that would otherwise be read as markup", () => {
    const samples = [
      "<script>alert('x')</script>",
      "**太字ではない**",
      "*斜体ではない*",
      "[CONFIRM: 確認ではない]",
      ":::note",
      ":::",
      "# 見出しではない",
      "## 見出しではない #",
      "- リストではない",
      "+ リストではない",
      "1. 番号ではない",
      "10) 番号ではない",
      "---",
      "===",
      "> 引用ではない",
      "| 表 | ではない |",
      "![写真ではない](https://example.com/a.png)",
      "[リンクではない](https://example.com/)",
      "[ref]: https://example.com/",
      "`code` ```fence``` ~~~ ~~消し~~",
      "snake_case __dunder__",
      "&amp; &#39; & <b> <!-- --> </p>",
      "a\\b \\ end\\",
      "*** ___ * * *",
    ];
    for (const sample of samples) {
      const { parsed } = roundTrip([p(text(sample))]);
      expect(parsed, sample).toEqual([{ p: sample }]);
      expect(roundTrip([ul([p(text(sample))])]).parsed, sample).toEqual([{ ul: [sample] }]);
      expect(roundTrip([h(2, text(sample))]).parsed, sample).toEqual([{ h: 2, text: sample }]);
      expect(roundTrip([quote(p(text(sample)))]).parsed, sample).toEqual([{ note: [{ p: sample }] }]);
    }
    expect(exportMarkdown([p(text("<script>alert('x')</script>"))])).toBe("\\<script\\>alert('x')\\</script\\>\n");
    expect(exportMarkdown([p(text("# 見出しではない"))])).toBe("\\# 見出しではない\n");
    expect(exportMarkdown([p(text("1. 番号ではない"))])).toBe("1\\. 番号ではない\n");
    expect(exportMarkdown([p(text(":::"))])).toBe("\\:::\n");
  });

  it("turns line breaks inside text into spaces and drops control characters", () => {
    const { markdown, parsed } = roundTrip([p(text("一行目\n- 二行目\r\n## 三行目\u2028四\u0000\u0007行目\t終わり"))]);
    expect(markdown.trimEnd().split("\n")).toHaveLength(1);
    expect(parsed).toEqual([{ p: "一行目 - 二行目  ## 三行目 四行目 終わり" }]);
  });

  it("flattens nested lists into one level and joins paragraphs and breaks inside an item with spaces", () => {
    const { markdown, parsed } = roundTrip([
      ul(
        [p(text("親")), ol([p(text("子一"))], [p(text("子二")), ul([p(text("孫"))])])],
        [p(text("二段落の")), p(text("項目")), p(text("改行"), br, text("あり"))],
        [p()],
        [p(text("- 記号で始まる"))],
      ),
      ol([p(text("番号"))], [p(text("入れ子")), ul([p(text("箇条"))])]),
    ]);
    expect(markdown).toBe("- 親\n- 子一\n- 子二\n- 孫\n- 二段落の 項目 改行 あり\n- \\- 記号で始まる\n\n1. 番号\n2. 入れ子\n3. 箇条\n");
    expect(parsed).toEqual([{ ul: ["親", "子一", "子二", "孫", "二段落の 項目 改行 あり", "- 記号で始まる"] }, { ol: ["番号", "入れ子", "箇条"] }]);
  });

  it("writes a quote as a :::note box of paragraphs and lists only", () => {
    const { markdown, parsed } = roundTrip([
      quote(h(2, text("引用の見出し")), p(text("引用の段落")), ul([p(text("引用の項目"))], [p(text("次")), ol([p(text("入れ子"))])]), quote(p(text("引用の中の引用"))), { type: "horizontalRule" }),
      quote(p()),
      { type: "callout", content: [p(text("囲み"))] },
    ]);
    expect(markdown).toBe(
      ":::note\n引用の見出し\n\n引用の段落\n\n- 引用の項目\n- 次\n- 入れ子\n\n引用の中の引用\n:::\n\n:::note\n囲み\n:::\n",
    );
    expect(parsed).toEqual([
      { note: [{ p: "引用の見出し" }, { p: "引用の段落" }, { ul: ["引用の項目", "次", "入れ子"] }, { p: "引用の中の引用" }] },
      { note: [{ p: "囲み" }] },
    ]);
  });

  it("links only https URLs without credentials and keeps the text of every other link", () => {
    const { markdown, parsed } = roundTrip([
      p(
        text("安全", link("https://example.com/a?b=1#c")),
        text(" "),
        text("http", link("http://example.com/")),
        text(" "),
        text("js", link("javascript:alert(1)")),
        text(" "),
        text("mail", link("mailto:a@example.com")),
        text(" "),
        text("相対", link("/experiences/x")),
        text(" "),
        text("資格", link("https://user:pass@example.com/")),
        text(" "),
        text("括弧", link("https://en.wikipedia.org/wiki/Foo_(bar)")),
        text(" "),
        text("日本語", link("https://例え.jp/パス?q=値")),
      ),
    ]);
    expect(markdown).toBe(
      "[安全](https://example.com/a?b=1#c) http js mail 相対 資格 [括弧](https://en.wikipedia.org/wiki/Foo_%28bar%29) " +
        "[日本語](https://xn--r8jz45g.jp/%E3%83%91%E3%82%B9?q=%E5%80%A4)\n",
    );
    expect(parsed).toEqual([
      {
        p:
          "{link https://example.com/a?b=1#c:安全} http js mail 相対 資格 {link https://en.wikipedia.org/wiki/Foo_%28bar%29:括弧} " +
          "{link https://xn--r8jz45g.jp/%E3%83%91%E3%82%B9?q=%E5%80%A4:日本語}",
      },
    ]);
  });

  it("keeps link text that looks like markup or a CONFIRM note as text inside the link", () => {
    const { parsed } = roundTrip([
      p(text("CONFIRM: 確認", link("https://example.com/"))),
      p(text("見て!"), text("こちら", link("https://example.com/"))),
      p(text("[入れ子] *星* _下線_", link("https://example.com/"))),
      p(text("   ", link("https://example.com/")), text("空白だけのリンク")),
      p(text(" 前後に空白 ", link("https://example.com/"))),
    ]);
    expect(parsed).toEqual([
      { p: "{link https://example.com/:CONFIRM: 確認}" },
      { p: "見て!{link https://example.com/:こちら}" },
      { p: "{link https://example.com/:[入れ子] *星* _下線_}" },
      { p: "空白だけのリンク" },
      { p: "{link https://example.com/:前後に空白}" },
    ]);
  });

  it("writes bold and italic, nests them where the subset can, and drops an inner mark only where it cannot", () => {
    const cases: Array<[Node[], string, string]> = [
      [[text("太字", bold)], "**太字**", "{strong:太字}"],
      [[text("斜体", italic)], "*斜体*", "{em:斜体}"],
      [[text("前"), text("太字", bold), text("後")], "前**太字**後", "前{strong:太字}後"],
      [[text("太", bold), text("斜", italic)], "**太***斜*", "{strong:太}{em:斜}"],
      [[text("斜", italic), text("太", bold), text("斜", italic)], "*斜***太***斜*", "{em:斜}{strong:太}{em:斜}"],
      [[text("太字の", bold), text("斜体", bold, italic), text("中", bold)], "**太字の*斜体*中**", "{strong:太字の{em:斜体}中}"],
      [[text("斜体の", italic), text("太字", italic, bold), text("中", italic)], "*斜体の**太字**中*", "{em:斜体の{strong:太字}中}"],
      // 同じ文字に両方が掛かるだけのときは書けない（`***x***` は parser が断る）ので太字だけ
      [[text("両方", bold, italic)], "**両方**", "{strong:両方}"],
      [[text("両方", bold, italic), text("太", bold)], "**両方太**", "{strong:両方太}"],
      [[text("斜", italic), text("両方", bold, italic)], "*斜両方*", "{em:斜両方}"],
      // 強調の端の空白は外に出す（開く印の後・閉じる印の前に空白を置けない）
      [[text("前"), text(" 太字 ", bold), text("後")], "前 **太字** 後", "前 {strong:太字} 後"],
      [[text("a b", bold), text(" "), text("c", bold)], "**a b c**", "{strong:a b c}"],
      [[text("太字", bold), { type: "hardBreak" }, text("続き", bold)], "**太字 続き**", "{strong:太字 続き}"],
      // 文字の * や \ と強調の印が並んでも崩れない
      [[text("*", bold)], "**\\***", "{strong:*}"],
      [[text("a\\", italic), text("*b", bold)], "*a\\\\***\\*b**", "{em:a\\}{strong:*b}"],
      // 太字のリンク
      [[text("リンク", bold, link("https://example.com/"))], "**[リンク](https://example.com/)**", "{strong:{link https://example.com/:リンク}}"],
      [[text("太字の", bold), text("リンク", bold, link("https://example.com/")), text("文", bold)], "**太字の[リンク](https://example.com/)文**", "{strong:太字の{link https://example.com/:リンク}文}"],
      [[text("リ", link("https://example.com/")), text("ンク", italic, link("https://example.com/"))], "[リ*ンク*](https://example.com/)", "{link https://example.com/:リ{em:ンク}}"],
      // その他の mark は文字だけ
      [[text("code", { type: "code" }), text("消し", { type: "strike" }), text("下線", { type: "underline" })], "code消し下線", "code消し下線"],
    ];
    for (const [content, markdown, expected] of cases) {
      const result = roundTrip([p(...content)]);
      expect(result.markdown, markdown).toBe(`${markdown}\n`);
      expect(result.parsed, markdown).toEqual([{ p: expected }]);
    }
  });

  it("keeps unknown nodes' text without throwing and skips images and rules", () => {
    const { parsed } = roundTrip([
      { type: "codeBlock", attrs: { language: "js" }, content: [text("const a = `x`;\nreturn a;")] },
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [p(text("表のセル"))] }] }] },
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [p(text("やること"))] }] },
      { type: "docAssetImage", attrs: { name: "a.png", alt: "写真" } },
      { type: "recording", attrs: { asset: "x" } },
      { type: "mystery" },
      null,
      "文字列",
      text("ばらの文字"),
      { content: [p(text("型なし"))] },
    ]);
    expect(parsed).toEqual([{ p: "const a = `x`; return a;" }, { p: "表のセル" }, { ul: ["やること"] }, { p: "ばらの文字" }, { p: "型なし" }]);
  });

  it("splits a numbered list longer than 999 items, because the subset numbers up to three digits", () => {
    const items = Array.from({ length: 1001 }, (_, index) => [p(text(`項目${index + 1}`))]);
    const { parsed } = roundTrip([ol(...items)]);
    expect(parsed).toHaveLength(2);
    expect((parsed[0] as { ol: string[] }).ol).toHaveLength(999);
    expect((parsed[1] as { ol: string[] }).ol).toEqual(["項目1000", "項目1001"]);
  });

  it("stops at depth 64 instead of recursing without end", () => {
    let node: Node = p(text("底"));
    for (let depth = 0; depth < 200; depth++) node = quote(node);
    expect(() => roundTrip([node])).not.toThrow();
    expect(exportMarkdown([node])).not.toContain("底");
  });

  it("is always read by the subset for random text and marks (seeded)", () => {
    // 記号・空白・日本語を混ぜた合成の本文。決まった種で毎回同じ入力にする
    let seed = 0x5eed;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
    const alphabet = [..."\\`*_[]<>&|~#!-+=:.()1234 \u3000\t\nab日本語「」CONFIRM", "**", "[CONFIRM:", ":::", "1.", "&amp;", "<b>", "~~", "!["];
    const markSets = [[], [bold], [italic], [bold, italic], [link("https://example.com/x")], [bold, link("https://example.com/y")], [italic, link("https://example.com/x")], [{ type: "code" }]];
    const expectedText = (nodes: Node[]) =>
      nodes
        .map((node) => (node.type === "hardBreak" ? " " : String(node.text)))
        .join("")
        .replace(/[\t\n]/g, " ")
        .trim();
    for (let round = 0; round < 400; round++) {
      const content: Node[] = Array.from({ length: 1 + Math.floor(random() * 6) }, () =>
        random() < 0.1 ? br : text(Array.from({ length: 1 + Math.floor(random() * 5) }, () => pick(alphabet)).join(""), ...pick(markSets)),
      );
      const kind = pick(["p", "h", "ul", "quote"] as const);
      const block = kind === "p" ? p(...content) : kind === "h" ? h(2, ...content) : kind === "ul" ? ul([p(...content)]) : quote(p(...content));
      const markdown = exportMarkdown([block]);
      let parsed: ParsedBlock[];
      try {
        parsed = oracle(markdown);
      } catch (error) {
        throw new Error(`round ${round}: ${JSON.stringify(content)} → ${JSON.stringify(markdown)}: ${(error as Error).message}`);
      }
      const expected = expectedText(content);
      const words = (blocks: ParsedBlock[]): string =>
        blocks
          .map((parsedBlock) =>
            parsedBlock.type === "list" ? parsedBlock.items.map(inlineText).join("") : parsedBlock.type === "note" ? words(parsedBlock.blocks) : inlineText(parsedBlock.children),
          )
          .join("");
      expect(words(parsed), JSON.stringify(content)).toBe(expected);
      expect(JSON.stringify(parsed)).not.toContain('"confirm"');
    }
  });
});

describe("markdownLinkHref", () => {
  it("accepts https only and encodes the characters the subset refuses in a link target", () => {
    expect(markdownLinkHref("https://example.com")).toBe("https://example.com/");
    expect(markdownLinkHref(" https://example.com/a b ")).toBe("https://example.com/a%20b");
    expect(markdownLinkHref("https://example.com/it's(1)")).toBe("https://example.com/it%27s%281%29");
    for (const href of ["http://example.com/", "mailto:a@example.com", "javascript:alert(1)", "data:text/html,x", "/relative", "//host/x", "https://u:p@example.com/", "", 42, null]) {
      expect(markdownLinkHref(href), String(href)).toBeNull();
    }
  });
});

describe("exportMarkdown: a large but valid body", () => {
  it("exports a list item whose paragraph is far longer than V8's argument limit (parseBlocks accepts ~1 MiB)", () => {
    const long = "あ".repeat(130_000);
    const item = (content: unknown[]) => ({ type: "listItem", content });
    const body = [
      { type: "bulletList", content: [item([{ type: "paragraph", content: [{ type: "text", text: long }] }])] },
      { type: "orderedList", content: [item([{ type: "text", text: long }])] },
    ];
    const out = exportMarkdown(body);
    expect(out.startsWith("- あ")).toBe(true);
    expect(out.length).toBeGreaterThan(260_000);
  });
});

/*
 * ---- 箱の書き方の変種（`{ boxes: "quote" }`）----
 * Google ドキュメントへの書き出し（src/google-docs/）は `:::note` を知らない読み手に渡すので、箱を `> ` にする。
 * ほかの記法はまったく同じであること（変えたのは箱だけ）を、上と同じ本文で確かめる。
 */
describe("exportMarkdown with { boxes: 'quote' }", () => {
  it("writes boxes as blockquotes, keeping blank lines inside the quote", () => {
    const body = [
      quote(h(2, text("引用の見出し")), p(text("引用の段落")), ul([p(text("引用の項目"))], [p(text("次"))]), quote(p(text("引用の中の引用")))),
      quote(p()),
      { type: "callout", content: [p(text("囲み"))] },
    ];
    expect(exportMarkdown(body, { boxes: "quote" })).toBe(
      "> 引用の見出し\n>\n> 引用の段落\n>\n> - 引用の項目\n> - 次\n>\n> 引用の中の引用\n\n> 囲み\n",
    );
    // 既定（.md の書き出し）は今まで通り :::note
    expect(exportMarkdown(body)).toBe(":::note\n引用の見出し\n\n引用の段落\n\n- 引用の項目\n- 次\n\n引用の中の引用\n:::\n\n:::note\n囲み\n:::\n");
    expect(exportMarkdown(body, { boxes: "note" })).toBe(exportMarkdown(body));
  });

  it("changes nothing outside boxes", () => {
    const body = [
      h(2, text("見出し")),
      h(3, text("小見出し")),
      p(text("段落と"), { type: "text", text: "太字", marks: [{ type: "bold" }] }),
      ul([p(text("項目"))]),
      ol([p(text("番号"))]),
      p({ type: "text", text: "リンク", marks: [{ type: "link", attrs: { href: "https://example.com/a" } }] }),
      { type: "horizontalRule" },
      { type: "image", attrs: { src: "https://example.com/a.png" } },
    ];
    expect(exportMarkdown(body, { boxes: "quote" })).toBe(exportMarkdown(body));
  });

  it("writes an empty body as an empty string in both styles", () => {
    expect(exportMarkdown([], { boxes: "quote" })).toBe("");
    expect(exportMarkdown([quote(p())], { boxes: "quote" })).toBe("");
  });
});
