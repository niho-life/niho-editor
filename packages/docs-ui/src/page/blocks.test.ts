import { describe, expect, it } from "vitest";
import { MAX_BLOCK_NESTING, isSafeLinkHref, validateBlocks } from "./blocks";

const text = (value: string, marks?: unknown[]) => (marks ? { type: "text", text: value, marks } : { type: "text", text: value });
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });
const ASSET = "0b9f5c4e-6d1a-4c52-9a3e-2f7d8a1c3b40";

function ok(value: unknown) {
  const result = validateBlocks(value);
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result.blocks;
}

function reason(value: unknown): string {
  const result = validateBlocks(value);
  if (result.ok) throw new Error("expected a rejection");
  return result.reason;
}

describe("validateBlocks: what a page may contain", () => {
  it("keeps table cells, checked state, code and marks without carrying HTML attributes", () => {
    const blocks = [
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph(text("完了"))] }] },
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null }, content: [paragraph(text("列"))] }] }] },
      { type: "codeBlock", attrs: { language: "ts" }, content: [text("const x = 1;")] },
      paragraph(text("code", [{ type: "code" }]), text("old", [{ type: "strike" }])),
    ];
    expect(ok(blocks)).toEqual(blocks);
    expect(reason([{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: "yes" }, content: [paragraph()] }] }])).toMatch(/checked/);
    expect(reason([{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { onclick: "x" }, content: [paragraph()] }] }] }])).toMatch(/unknown attribute/);
    expect(reason([{ type: "codeBlock", attrs: { language: "<script>" }, content: [text("x")] }])).toMatch(/invalid language/);
  });
  it("accepts every block of the limited AST", () => {
    const blocks = [
      { type: "heading", attrs: { level: 2 }, content: [text("見出し")] },
      { type: "heading", attrs: { level: 3 } },
      paragraph(text("太字", [{ type: "bold" }]), text(" と "), text("斜体", [{ type: "italic" }]), { type: "hardBreak" }, text("次の行")),
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("a")), { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [paragraph(text("b"))] }] }] }] },
      { type: "blockquote", content: [paragraph(text("引用"))] },
      { type: "callout", content: [paragraph(text("囲み"))] },
      { type: "horizontalRule" },
      { type: "image", attrs: { assetId: ASSET, alt: "代替", credit: "撮影 NIHO", consent: true } },
      { type: "recording", attrs: { assetId: ASSET } },
      { type: "paragraph" },
    ];
    expect(ok(blocks)).toEqual(blocks);
  });

  it("keeps the marks the editor leaves on a hard break (<strong>a<br>b</strong>)", () => {
    const blocks = ok([paragraph(text("a", [{ type: "bold" }]), { type: "hardBreak", marks: [{ type: "bold" }] }, text("b", [{ type: "bold" }]))]);
    expect(blocks).toEqual([paragraph(text("a", [{ type: "bold" }]), { type: "hardBreak", marks: [{ type: "bold" }] }, text("b", [{ type: "bold" }]))]);
    expect(reason([paragraph({ type: "hardBreak", marks: [{ type: "script" }] })])).toMatch(/unknown mark/);
    expect(reason([paragraph({ type: "hardBreak", attrs: {} })])).toMatch(/unknown/);
  });

  it("rounds an out-of-range ordered-list start to the default instead of rejecting the page (start 0, negative, huge)", () => {
    const list = (start: unknown) => [{ type: "orderedList", attrs: { start }, content: [{ type: "listItem", content: [paragraph(text("a"))] }] }];
    for (const start of [0, -3, 1_000_000, 2.5]) {
      expect(ok(list(start))).toEqual([{ type: "orderedList", content: [{ type: "listItem", content: [paragraph(text("a"))] }] }]);
    }
    expect(ok(list(999_999))[0]).toMatchObject({ attrs: { start: 999_999 } });
    expect(reason(list("3"))).toMatch(/invalid start/);
  });

  it("keeps an empty document and an empty paragraph", () => {
    expect(ok([])).toEqual([]);
    expect(ok([{ type: "paragraph", content: [] }])).toEqual([{ type: "paragraph" }]);
  });

  it("returns a rebuilt copy, never the input object", () => {
    const input = [paragraph(text("a"))];
    const [block] = ok(input);
    expect(block).not.toBe(input[0]);
  });
});

describe("validateBlocks: what a page may not contain", () => {
  it("rejects HTML and anything that is not an array of nodes", () => {
    for (const value of ["<p>x</p>", { type: "doc" }, null, 1, ["<script>alert(1)</script>"], [null], [[]], [{ text: "no type" }]]) {
      expect(validateBlocks(value).ok).toBe(false);
    }
  });

  it("rejects nodes outside the AST (script, style, iframe, raw html, h1)", () => {
    for (const type of ["script", "style", "iframe", "html", "rawHtml", "markdownRaw", "doc", "text", "hardBreak", "listItem"]) {
      expect(validateBlocks([{ type }]).ok, type).toBe(false);
    }
    expect(validateBlocks([{ type: "heading", attrs: { level: 1 }, content: [text("題名")] }]).ok).toBe(false);
    expect(validateBlocks([{ type: "heading", attrs: { level: 4 }, content: [text("x")] }]).ok).toBe(false);
    expect(validateBlocks([{ type: "heading", content: [text("x")] }]).ok).toBe(false);
  });

  it("rejects unknown keys and attributes (style, class, innerHTML, event handlers)", () => {
    for (const block of [
      { type: "paragraph", style: "color:red" },
      { type: "paragraph", html: "<b>x</b>", content: [text("x")] },
      { type: "paragraph", attrs: { class: "x" } },
      { type: "paragraph", attrs: { onclick: "alert(1)" } },
      { type: "image", attrs: { assetId: ASSET, src: "https://example.com/a.png" } },
      { type: "paragraph", content: [{ type: "text", text: "x", html: "<i>x</i>" }] },
      { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "bold", attrs: { style: "x" } }] }] },
      JSON.parse('{"type":"paragraph","__proto__":{"polluted":true}}'),
    ]) {
      expect(validateBlocks([block]).ok, JSON.stringify(block)).toBe(false);
    }
  });

  it("rejects unknown marks, duplicate marks, empty text and NUL", () => {
    expect(ok([paragraph(text("x", [{ type: "code" }]), text("y", [{ type: "strike" }]))])).toEqual([paragraph(text("x", [{ type: "code" }]), text("y", [{ type: "strike" }]))]);
    expect(validateBlocks([paragraph(text("x", [{ type: "bold" }, { type: "bold" }]))]).ok).toBe(false);
    expect(validateBlocks([paragraph(text(""))]).ok).toBe(false);
    expect(validateBlocks([paragraph(text("a\u0000b"))]).ok).toBe(false);
    expect(validateBlocks([{ type: "image", attrs: { assetId: ASSET, alt: "a\u0000b" } }]).ok).toBe(false);
  });

  it("rejects structure ProseMirror would not accept", () => {
    expect(validateBlocks([{ type: "bulletList", content: [paragraph(text("x"))] }]).ok).toBe(false);
    expect(validateBlocks([{ type: "bulletList", content: [] }]).ok).toBe(false);
    expect(validateBlocks([{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "horizontalRule" }] }] }]).ok).toBe(false);
    expect(validateBlocks([{ type: "blockquote", content: [] }]).ok).toBe(false);
    expect(validateBlocks([{ type: "blockquote", content: [text("x")] }]).ok).toBe(false);
    expect(validateBlocks([{ type: "paragraph", content: [paragraph(text("nested"))] }]).ok).toBe(false);
    expect(validateBlocks([{ type: "horizontalRule", content: [text("x")] }]).ok).toBe(false);
  });

  it("rejects images and recordings that do not point at an asset id", () => {
    for (const attrs of [{}, { assetId: "https://example.com/a.png" }, { assetId: "not-a-uuid" }, { assetId: 1 }]) {
      expect(validateBlocks([{ type: "image", attrs }]).ok).toBe(false);
      expect(validateBlocks([{ type: "recording", attrs }]).ok).toBe(false);
    }
    expect(validateBlocks([{ type: "image" }]).ok).toBe(false);
    expect(validateBlocks([{ type: "image", attrs: { assetId: ASSET, consent: "yes" } }]).ok).toBe(false);
    expect(validateBlocks([{ type: "image", attrs: { assetId: ASSET, alt: "あ".repeat(1001) } }]).ok).toBe(false);
    expect(validateBlocks([{ type: "image", attrs: { assetId: ASSET, credit: "あ".repeat(501) } }]).ok).toBe(false);
  });

  it("limits how deeply blocks nest", () => {
    let node: Record<string, unknown> = paragraph(text("x"));
    for (let level = 1; level < MAX_BLOCK_NESTING; level++) node = { type: "blockquote", content: [node] };
    expect(validateBlocks([node]).ok).toBe(true);
    expect(validateBlocks([{ type: "blockquote", content: [node] }]).ok).toBe(false);
  });

  it("gives a reason that names the place (for logs, not for the response)", () => {
    expect(reason([{ type: "script" }])).toContain("blocks[0](script)");
    expect(reason([paragraph(text("x", [{ type: "underline" }]))])).toContain('unknown mark "underline"');
  });
});

describe("links", () => {
  it("keeps only href and drops the display defaults TipTap adds", () => {
    const [block] = ok([paragraph(text("NIHO", [{ type: "link", attrs: { href: "https://niho.life/", target: "_blank", rel: "noopener noreferrer nofollow", class: null } }]))]);
    expect(block).toEqual(paragraph(text("NIHO", [{ type: "link", attrs: { href: "https://niho.life/" } }])));
  });

  it("accepts http, https and mailto only", () => {
    for (const href of ["https://niho.life/a?b=1#c", "http://example.com", "mailto:hello@example.com"]) expect(isSafeLinkHref(href), href).toBe(true);
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\tscript:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      "file:///etc/passwd",
      "//evil.example.com",
      "/relative",
      "tel:+81000000000",
      "https://example.com/" + "a".repeat(3000),
      "",
      "https://exa mple.com",
    ]) {
      expect(isSafeLinkHref(href), href).toBe(false);
    }
    expect(validateBlocks([paragraph(text("x", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]))]).ok).toBe(false);
    expect(validateBlocks([paragraph(text("x", [{ type: "link" }]))]).ok).toBe(false);
  });
});
