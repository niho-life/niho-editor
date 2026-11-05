import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SHARED_LINK_REL, SharedBlocks, safeShareHref } from "./render-blocks";

type Node = Record<string, unknown>;
const text = (value: string, marks?: Node[]): Node => (marks ? { type: "text", text: value, marks } : { type: "text", text: value });
const paragraph = (...content: Node[]): Node => ({ type: "paragraph", content });
const link = (href: unknown): Node => ({ type: "link", attrs: { href } });

const render = (blocks: unknown[]) => renderToStaticMarkup(<SharedBlocks blocks={blocks} />);

/** 出力に、React が組み立てた要素以外の HTML が混ざっていないこと（タグは許した名前だけ）。 */
function tagsOf(html: string): string[] {
  return [...html.matchAll(/<\/?([a-zA-Z0-9]+)/g)].map((match) => match[1]!.toLowerCase());
}
const ALLOWED_TAGS = new Set(["p", "h2", "h3", "ul", "ol", "li", "blockquote", "hr", "br", "strong", "em", "a"]);

describe("SharedBlocks", () => {
  it("renders the supported blocks as plain React elements", () => {
    const html = render([
      { type: "heading", attrs: { level: 2 }, content: [text("見出し二")] },
      { type: "heading", attrs: { level: 3 }, content: [text("見出し三")] },
      paragraph(text("一行目"), { type: "hardBreak" }, text("二行目")),
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("箇条"))] }] },
      { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [paragraph(text("番号"))] }] },
      { type: "blockquote", content: [paragraph(text("引用"))] },
      { type: "horizontalRule" },
    ]);
    expect(html).toBe(
      "<h2>見出し二</h2><h3>見出し三</h3><p>一行目<br/>二行目</p><ul><li><p>箇条</p></li></ul>" +
        '<ol start="3"><li><p>番号</p></li></ol><blockquote><p>引用</p></blockquote><hr/>',
    );
  });

  it("rounds other heading levels to h3 and never renders an h1", () => {
    const html = render([1, 4, 6, "2", undefined].map((level) => ({ type: "heading", attrs: { level }, content: [text("h")] })));
    expect(html).toBe("<h3>h</h3>".repeat(5));
  });

  it("escapes text that looks like HTML instead of injecting it", () => {
    const html = render([paragraph(text('<script>alert("x")</script><img src=x onerror=alert(1)>&amp;'))]);
    expect(html).toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;&amp;amp;</p>");
    expect(tagsOf(html)).toEqual(["p", "p"]);
  });

  it("links only https, http, and mailto URLs, always with rel, and leaves other links as text", () => {
    const html = render([
      paragraph(
        text("安全", [link("https://example.com/a?b=1#c")]),
        text("http", [link("http://example.com/")]),
        text("mail", [link("mailto:someone@example.com")]),
        text("js", [link("javascript:alert(1)")]),
        text("JS", [link(" JAVASCRIPT:alert(1)")]),
        text("data", [link("data:text/html,<script>alert(1)</script>")]),
        text("relative", [link("/p/123")]),
        text("protocol-relative", [link("//evil.example/")]),
        text("creds", [link("https://user:pass@example.com/")]),
        text("broken", [link(42)]),
        text("vbscript", [link("vbscript:msgbox(1)")]),
      ),
    ]);
    expect(html).toBe(
      `<p><a href="https://example.com/a?b=1#c" rel="${SHARED_LINK_REL}">安全</a><a href="http://example.com/" rel="${SHARED_LINK_REL}">http</a>` +
        `<a href="mailto:someone@example.com" rel="${SHARED_LINK_REL}">mail</a>jsJSdatarelativeprotocol-relativecredsbrokenvbscript</p>`,
    );
    expect(SHARED_LINK_REL).toBe("noopener noreferrer nofollow ugc");
    expect(html).not.toMatch(/javascript:|data:|vbscript:|evil\.example|user:pass/i);
  });

  it("applies bold, italic, code, strike and link and ignores unknown marks", () => {
    const html = render([
      paragraph(
        text("全部", [{ type: "bold" }, { type: "italic" }, link("https://example.com/")]),
        text("太", [{ type: "bold" }]),
        text("斜", [{ type: "italic" }]),
        text("コード", [{ type: "code" }, { type: "strike" }, { type: "underline" }, { type: "highlight", attrs: { color: "red" } }]),
        text("壊れた", ["bold" as unknown as Node, { type: "link" }]),
      ),
    ]);
    expect(html).toBe(
      `<p><a href="https://example.com/" rel="${SHARED_LINK_REL}"><strong><em>全部</em></strong></a><strong>太</strong><em>斜</em><code><s>コード</s></code>壊れた</p>`,
    );
  });

  it("does not show the editor's ai mark (AI が足した語の印) in the shared view", () => {
    const html = render([paragraph(text("前の"), text("AI の語", [{ type: "ai" }]), text("太字", [{ type: "bold" }, { type: "ai" }]))]);
    expect(html).toBe("<p>前のAI の語<strong>太字</strong></p>");
    expect(html).not.toContain("data-ai");
  });

  it("renders tables and code and skips images", () => {
    const html = render([
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [paragraph(text("表の中"))] }] }] },
      { type: "image", attrs: { src: "https://example.com/a.png", alt: "写真" } },
      { type: "docAssetImage", attrs: { name: "a.png" } },
      { type: "codeBlock", content: [text("const a = 1;")] },
      { type: "mystery" },
      null,
      "文字列",
      42,
      [paragraph(text("配列"))],
      { content: [text("型なし")] },
    ]);
    expect(html).toBe('<div class="shared-table" role="region" aria-label="本文の表" tabindex="0"><table><tbody><tr><td><p>表の中</p></td></tr></tbody></table></div><pre><code>const a = 1;</code></pre>型なし');
    expect(html).not.toMatch(/img|example\.com|写真/);
  });

  it("shows checklist state in text and escapes table and code contents", () => {
    const html = render([
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph(text("完了"))] }, { type: "taskItem", attrs: { checked: false }, content: [paragraph(text("未完了"))] }] },
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [paragraph(text("<script>"))] }] }] },
      { type: "codeBlock", content: [text("<img src=x>")] },
    ]);
    expect(html).toContain('aria-label="完了"');
    expect(html).toContain('aria-label="未完了"');
    expect(html).toContain("<th scope=\"col\"><p>&lt;script&gt;</p></th>");
    expect(html).toContain("<pre><code>&lt;img src=x&gt;</code></pre>");
    expect(html).not.toContain("<script>");
  });

  it("preserves table spans and column alignment in the shared view", () => {
    const html = render([{ type: "table", content: [
      { type: "tableRow", content: [{ type: "tableHeader", attrs: { colspan: 2, align: "center" }, content: [paragraph(text("見出し"))] }] },
      { type: "tableRow", content: [{ type: "tableCell", attrs: { rowspan: 2, align: "right" }, content: [paragraph(text("値"))] }] },
    ] }]);
    expect(html).toContain('<th scope="col" colSpan="2" style="text-align:center"><p>見出し</p></th>');
    expect(html).toContain('<td rowSpan="2" style="text-align:right"><p>値</p></td>');
  });

  it("renders a callout as aside[data-callout], with its blocks inside (#33)", () => {
    const html = render([{ type: "callout", content: [paragraph(text("囲みの中")), { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("項目"))] }] }] }]);
    expect(html).toBe('<aside data-callout=""><p>囲みの中</p><ul><li><p>項目</p></li></ul></aside>');
  });

  it("renders an image of the shared page through the token's relay, with alt and the credit as a caption", () => {
    const assetId = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
    const token = "s".repeat(43);
    const html = renderToStaticMarkup(
      <SharedBlocks
        blocks={[{ type: "image", attrs: { assetId, alt: "合成の写真", credit: "合成の提供元", consent: true } }]}
        assetSrc={(id) => `/s/${token}/a/${id}`}
      />,
    );
    expect(html).toBe(
      `<figure><img src="/s/${token}/a/${assetId}" alt="合成の写真" loading="lazy" decoding="async" data-doc-asset=""/><figcaption>合成の提供元</figcaption></figure>`,
    );
  });

  it("never renders an image that cannot be read: no relay, no asset id, or an outside src", () => {
    const token = "s".repeat(43);
    const assetSrc = (id: string) => `/s/${token}/a/${id}`;
    const blocks = [
      { type: "image", attrs: { assetId: "not-a-uuid" } },
      { type: "image", attrs: { src: "https://evil.example/pixel.gif", alt: "外" } },
      { type: "image" },
      { type: "image", attrs: { assetId: "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11" } },
    ];
    // 中継を渡さなければ 1 枚も描かない（読めない img を置かない）
    expect(render(blocks)).toBe("");
    const html = renderToStaticMarkup(<SharedBlocks blocks={blocks} assetSrc={assetSrc} />);
    expect(html).toBe(`<figure><img src="/s/${token}/a/6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11" alt="" loading="lazy" decoding="async" data-doc-asset=""/></figure>`);
    expect(html).not.toContain("evil.example");
    // 止めた共有（null を返す中継）では描かない
    expect(renderToStaticMarkup(<SharedBlocks blocks={blocks} assetSrc={() => null} />)).toBe("");
  });

  it("stops at depth 64 instead of recursing without end", () => {
    let node: Node = paragraph(text("底"));
    for (let depth = 0; depth < 200; depth++) node = { type: "blockquote", content: [node] };
    const html = render([node]);
    expect(html).not.toContain("底");
    expect(html.match(/<blockquote>/g)?.length).toBe(64);

    let shallow: Node = paragraph(text("届く"));
    for (let depth = 0; depth < 60; depth++) shallow = { type: "blockquote", content: [shallow] };
    expect(render([shallow])).toContain("届く");
  });

  it("puts no raw HTML into the output for hostile input", () => {
    const hostile = [
      { type: "paragraph", attrs: { style: "x", onclick: "alert(1)", dangerouslySetInnerHTML: { __html: "<b>x</b>" } }, content: [text("<b>太字</b>")] },
      { type: "heading", attrs: { level: 2, id: "x" }, content: [text("</h2><script>")] },
      { type: "text", text: "<iframe>", marks: [link("https://example.com/\"><script>")] },
    ];
    const html = render(hostile);
    for (const tag of tagsOf(html)) expect(ALLOWED_TAGS.has(tag), tag).toBe(true);
    expect(html).not.toMatch(/onclick|style=|<b>|<script|<iframe/);
  });

  it("keeps only absolute http(s) and mailto URLs in safeShareHref", () => {
    expect(safeShareHref("https://example.com")).toBe("https://example.com/");
    expect(safeShareHref("https://example.com/\n")).toBeNull();
    expect(safeShareHref("https://exa mple.com")).toBeNull();
    expect(safeShareHref("")).toBeNull();
    expect(safeShareHref(`https://example.com/${"a".repeat(2048)}`)).toBeNull();
  });
});
