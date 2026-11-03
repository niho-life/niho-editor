// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { BLOCK_NODE_NAMES, INLINE_NODE_NAMES, MARK_NAMES, validateBlocks } from "./blocks";
import { normalizePastedHtml } from "./paste";
import { buildPageExtensions } from "./page-extensions";

beforeAll(() => {
  // jsdom に無い描画の API（ProseMirror が読む）
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  Range.prototype.getBoundingClientRect = rect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Element.prototype.scrollIntoView = () => undefined;
});

/** 合成の資産の id（実在の資産ではない）。 */
const ASSET_ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const text = (value: string) => ({ type: "text", text: value });
const paragraph = (value: { type: string; text: string }) => ({ type: "paragraph", content: [value] });

let editor: Editor | null = null;

function makeEditor(content?: unknown): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  editor = new Editor({
    element,
    extensions: buildPageExtensions(),
    content: content as never,
    editorProps: { transformPastedHTML: normalizePastedHtml },
  });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

function savedBlocks(current: Editor) {
  const result = validateBlocks(current.getJSON().content ?? []);
  if (!result.ok) throw new Error(`the editor produced a body the server would refuse: ${result.reason}`);
  return result.blocks;
}

function paste(current: Editor, html: string) {
  current.commands.clearContent();
  current.view.pasteHTML(html, new Event("paste") as ClipboardEvent);
  return savedBlocks(current);
}

function flatten(value: unknown): string {
  return JSON.stringify(value);
}

describe("the page editor schema matches the limited AST", () => {
  it("restores checklist state and edits table rows and columns without changing saved content", () => {
    const current = makeEditor({ type: "doc", content: [
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph(text("完了"))] }] },
      { type: "table", content: [
        { type: "tableRow", content: [{ type: "tableHeader", content: [paragraph(text("項目"))] }] },
        { type: "tableRow", content: [{ type: "tableCell", content: [paragraph(text("本文"))] }] },
      ] },
    ] });
    const before = savedBlocks(current);
    expect(JSON.stringify(before)).toContain('"checked":true');
    current.commands.setContent({ type: "doc", content: before });
    expect(savedBlocks(current).slice(0, 2)).toEqual(before.slice(0, 2));
    const table = current.state.doc.child(1);
    const cellPosition = 1 + current.state.doc.child(0).nodeSize + 1 + table.child(0).nodeSize + 1;
    current.commands.setTextSelection(cellPosition);
    expect(current.chain().focus().addRowAfter().run()).toBe(true);
    expect(current.chain().focus().addColumnAfter().run()).toBe(true);
    expect(savedBlocks(current).find((block) => block.type === "table")).toMatchObject({ content: [
      { content: [{ type: "tableHeader" }, { type: "tableHeader" }] },
      { content: [{ type: "tableCell" }, { type: "tableCell" }] },
      { content: [{ type: "tableCell" }, { type: "tableCell" }] },
    ] });
    expect(current.chain().focus().deleteRow().run()).toBe(true);
    expect(current.chain().focus().deleteColumn().run()).toBe(true);
    expect(savedBlocks(current).find((block) => block.type === "table")).toMatchObject({ content: [{ content: [{ type: "tableHeader" }] }, { content: [{ type: "tableCell" }] }] });
  });
  it("only has nodes and marks the AST allows", () => {
    const current = makeEditor();
    const nodes = Object.keys(current.schema.nodes).filter((name) => name !== "doc");
    const allowed = new Set([...BLOCK_NODE_NAMES, ...INLINE_NODE_NAMES, "listItem", "taskItem", "tableRow", "tableCell", "tableHeader"]);
    expect(nodes.filter((name) => !allowed.has(name))).toEqual([]);
    expect(Object.keys(current.schema.marks).filter((name) => !MARK_NAMES.includes(name))).toEqual([]);
  });

  it("differs from the AST only by what has no way to be created yet (recording)", () => {
    const current = makeEditor();
    const missing = [...BLOCK_NODE_NAMES, ...INLINE_NODE_NAMES, "listItem", "taskItem", "tableRow", "tableCell", "tableHeader"].filter((name) => !(name in current.schema.nodes));
    // 画像・囲み（#33）は入れ方があるので schema にある。録音はまだ作る手段が無い
    expect(missing.sort()).toEqual(["recording"]);
    expect(MARK_NAMES.filter((name) => !(name in current.schema.marks))).toEqual([]);
  });

  it("keeps a saved image through the editor with only the four attributes of the AST", () => {
    const current = makeEditor();
    const image = { type: "image", attrs: { assetId: ASSET_ID, alt: "合成の写真", credit: "合成の提供元", consent: true } };
    current.chain().setContent({ type: "doc", content: [image, { type: "paragraph" }] }).run();
    const blocks = savedBlocks(current);
    expect(blocks[0]).toEqual(image);
    // 本文に URL・外の src は入らない（描くときに中継の path を組む）
    expect(flatten(blocks)).not.toContain("http");
    expect(flatten(blocks)).not.toContain("src");
  });

  it("produces a body the server accepts for every block the editor can make", () => {
    const current = makeEditor();
    current
      .chain()
      .setContent({
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "見出し2" }] },
          { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "見出し3" }] },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "太字", marks: [{ type: "bold" }] },
              { type: "text", text: "斜体", marks: [{ type: "italic" }] },
              { type: "text", text: "リンク", marks: [{ type: "link", attrs: { href: "https://niho.life/" } }] },
              { type: "hardBreak" },
              { type: "text", text: "次の行" },
            ],
          },
          { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] }] },
          { type: "orderedList", attrs: { start: 1 }, content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] }] },
          { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "引用" }] }] },
          { type: "horizontalRule" },
          { type: "paragraph" },
        ],
      })
      .run();
    const blocks = savedBlocks(current);
    expect(blocks.map((block) => block.type)).toEqual(["heading", "heading", "paragraph", "bulletList", "orderedList", "blockquote", "horizontalRule", "paragraph"]);
  });

  it("refuses to load a body outside the AST instead of rewriting it (so the page can stay read-only)", () => {
    const element = document.createElement("div");
    let contentError = false;
    const current = new Editor({
      element,
      extensions: buildPageExtensions(),
      content: { type: "doc", content: [{ type: "unknownBlock", content: [{ type: "text", text: "x" }] }] },
      enableContentCheck: true,
      onContentError: () => {
        contentError = true;
      },
    });
    expect(contentError).toBe(true);
    current.destroy();
  });
});

describe("pasting HTML", () => {
  it("turns formatted HTML into blocks of the AST", () => {
    const current = makeEditor();
    const blocks = paste(
      current,
      `<h1>大見出し</h1><p>本文 <strong>太字</strong> と <em>斜体</em> と <a href="https://niho.life/x">リンク</a></p>
       <ul><li>りんご</li><li>みかん</li></ul><ol start="3"><li>三</li></ol><blockquote><p>引用</p></blockquote><hr><h4>小見出し</h4>`,
    );
    // 末尾の空の段落はエディタが常に 1 つ置く（trailing node）
    expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "bulletList", "orderedList", "blockquote", "horizontalRule", "heading", "paragraph"]);
    expect(blocks[0]).toMatchObject({ type: "heading", attrs: { level: 2 } });
    expect(flatten(blocks)).toContain('"href":"https://niho.life/x"');
    expect(flatten(blocks)).toContain('"type":"bold"');
    expect(flatten(blocks)).toContain('"type":"italic"');
    expect(flatten(blocks)).toContain('"start":3');
    expect(blocks.find((block) => block.type === "heading" && flatten(block).includes("小見出し"))).toMatchObject({ attrs: { level: 3 } });
  });

  it("never leaves a body the server would refuse: marked hard breaks and out-of-range list starts", () => {
    // paste() はサーバーの検査（validateBlocks）を通らなければ throw する
    const blocks = paste(makeEditor(), `<p><strong>一行目<br>二行目</strong></p>`);
    expect(flatten(blocks)).toContain('"type":"hardBreak"');
    for (const start of ["0", "-2", "1000000", "x"]) {
      expect(paste(makeEditor(), `<ol start="${start}"><li>番号</li></ol>`).some((block) => block.type === "orderedList")).toBe(true);
    }
  });

  it("keeps bold and italic that Word and Google Docs write as inline styles", () => {
    const blocks = paste(makeEditor(), `<p><span style="font-weight:700;color:red;background:url(javascript:x)">強い</span><span style="font-style:italic">傾き</span></p>`);
    expect(flatten(blocks)).toContain('"type":"bold"');
    expect(flatten(blocks)).toContain('"type":"italic"');
  });

  it("does not bring in script, style, iframe, svg, forms, comments, event handlers or images", () => {
    const html = `
      <!-- <script>alert('comment')</script> -->
      <style>body { background: url(https://evil.example/track.gif) }</style>
      <script>alert('script')</script>
      <p onclick="alert('click')" style="position:fixed" class="evil" id="x">安全な文章<script>alert('inline')</script></p>
      <iframe src="https://evil.example/"></iframe>
      <svg><text>svg-text</text><script>alert('svg')</script></svg>
      <form action="https://evil.example/"><input name="q" value="form-value"><button>send</button></form>
      <img src="https://evil.example/pixel.gif" onerror="alert('img')">
      <object data="x"></object><embed src="x"><template><p>template-text</p></template>
      <math><mi>math-text</mi></math>`;
    const blocks = paste(makeEditor(), html);
    const text = flatten(blocks);
    expect(text).toContain("安全な文章");
    for (const leaked of ["alert", "comment", "svg-text", "form-value", "send", "template-text", "math-text", "evil", "onclick", "position", "script", "style", "iframe"]) {
      expect(text, leaked).not.toContain(leaked);
    }
    expect(validateBlocks(blocks).ok).toBe(true);
  });

  it("keeps links only for http, https and mailto, and leaves the text of the others", () => {
    const blocks = paste(
      makeEditor(),
      `<p><a href="javascript:alert(1)">js</a> <a href="JaVaScRiPt:alert(1)">JS</a> <a href="data:text/html,x">data</a> <a href="/relative">rel</a> <a href="mailto:hello@example.com">mail</a></p>`,
    );
    const text = flatten(blocks);
    expect(text).toContain('"href":"mailto:hello@example.com"');
    expect(text).not.toContain("javascript");
    expect(text).not.toContain("data:text");
    expect(text).not.toContain('"href":"/relative"');
    for (const label of ["js", "JS", "data", "rel", "mail"]) expect(text).toContain(label);
  });

  it("keeps code, tables and task lists as editable nodes", () => {
    const blocks = paste(
      makeEditor(),
      `<pre><code>const a = 1;</code></pre><table><tr><td>セル</td></tr></table><ul><li><input type="checkbox" checked> やること</li></ul>`,
    );
    const text = flatten(blocks);
    expect(blocks.map((block) => block.type)).toEqual(["codeBlock", "table", "taskList", "paragraph"]);
    expect(text).toContain('"checked":true');
    expect(text).toContain("セル");
    expect(text).toContain("やること");
    expect(validateBlocks(blocks).ok).toBe(true);
  });

  it("pastes plain text as paragraphs, never as HTML", () => {
    const current = makeEditor();
    current.commands.clearContent();
    current.view.pasteHTML("", new Event("paste") as ClipboardEvent);
    const sample = "<script>alert(1)</script>\n\n二つ目";
    // プレーンテキストの貼り付け（クリップボードに HTML が無い場合）は文字のまま
    current.commands.insertContent({ type: "paragraph", content: [{ type: "text", text: sample }] });
    const blocks = savedBlocks(current);
    expect(flatten(blocks)).toContain("<script>alert(1)</script>");
    expect(blocks.every((block) => block.type === "paragraph")).toBe(true);
  });
});

describe("normalizePastedHtml", () => {
  it("drops everything that is not a text-level element and keeps the readable text", () => {
    const html = normalizePastedHtml(`<div class="a"><script>x</script><p style="color:red; font-weight: bold">t</p></div>`);
    expect(html).not.toContain("script");
    expect(html).not.toContain("color");
    expect(html).toContain("font-weight: bold");
    expect(html).toContain(">t<");
  });

  describe("images", () => {
    const ID = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";

    it("keeps an image the editor itself wrote (copy or cut in the editor) with only its asset id, alt, credit and consent", () => {
      const html = normalizePastedHtml(
        `<p>a</p><img data-doc-asset="" data-asset-id="${ID}" alt="朝の海" data-credit="Example Photographer" data-consent="true" src="https://evil.example/x.png" srcset="https://evil.example/y.png 2x" onerror="alert(1)" style="position:fixed">`,
      );
      const doc = new DOMParser().parseFromString(html, "text/html");
      const image = doc.querySelector("img")!;
      expect([...image.attributes].map((attribute) => attribute.name).sort()).toEqual(["alt", "data-asset-id", "data-consent", "data-credit"]);
      expect(image.getAttribute("data-asset-id")).toBe(ID);
      expect(html).not.toContain("evil");
      expect(html).not.toContain("onerror");
    });

    it("still drops outside images: no data-asset-id, one that is not a UUID, and images inside picture", () => {
      const html = normalizePastedHtml(
        `<img src="https://evil.example/a.png"><img data-asset-id="not-a-uuid" src="https://evil.example/b.png"><img data-asset-id="" src="https://evil.example/c.png"><picture><img data-asset-id="${ID}"></picture>`,
      );
      expect(html).not.toContain("<img");
      expect(html).not.toContain("evil");
    });

    it("an image copied in the editor comes back as the same image when pasted (the body keeps only the asset id and fields)", () => {
      const source = makeEditor({ type: "doc", content: [{ type: "image", attrs: { assetId: ID, alt: "朝の海", credit: "Example Photographer", consent: true } }] });
      const copied = source.getHTML();
      expect(copied).toContain(ID);
      const target = makeEditor();
      const blocks = paste(target, copied);
      expect(JSON.stringify(blocks)).toContain(ID);
      expect(JSON.stringify(blocks)).toContain("朝の海");
      expect(JSON.stringify(blocks)).not.toContain("evil");
    });
  });
});
