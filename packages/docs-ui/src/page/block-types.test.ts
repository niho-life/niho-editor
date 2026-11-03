// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { validateBlocks } from "./blocks";
import { BLOCK_CHOICES, LINE_TYPE_CHOICES, blankLineAround, fillBlankLine, filterBlockChoices, lineTypeOf, setLineType } from "./block-types";
import type { PageImages } from "./images";
import { checkLinkInput } from "./link-href";
import { buildPageExtensions, type PageExtensionsOptions } from "./page-extensions";

beforeAll(() => {
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  Range.prototype.getBoundingClientRect = rect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Element.prototype.scrollIntoView = () => undefined;
});

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

const text = (value: string, marks?: JSONContent["marks"]): JSONContent => (marks ? { type: "text", text: value, marks } : { type: "text", text: value });
const p = (value?: string): JSONContent => (value ? { type: "paragraph", content: [text(value)] } : { type: "paragraph" });
const li = (...content: JSONContent[]): JSONContent => ({ type: "listItem", content });

/** 書式の帯・「/」・「＋」で操作する前の、いろいろな形の本文（入れ子のリスト・引用の中のリスト・見出し・区切り線・書式）。 */
const BODY: JSONContent = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [text("見出し")] },
    { type: "paragraph", content: [text("太字", [{ type: "bold" }]), text("と"), text("リンク", [{ type: "link", attrs: { href: "https://example.com" } }])] },
    { type: "bulletList", content: [li(p("一つ目"), { type: "orderedList", content: [li(p("入れ子"))] }), li(p("二つ目"))] },
    { type: "blockquote", content: [p("引用の中"), { type: "bulletList", content: [li(p("引用のリスト"))] }] },
    { type: "horizontalRule" },
    { type: "orderedList", attrs: { start: 3 }, content: [li(p("三"))] },
    p("最後"),
  ],
};

/** 画像のアップロードの口（ファイル選択を開くところまでを試すので、呼ばれない）。 */
const IMAGES: PageImages = {
  upload: async () => ({ ok: false, problem: "failed" }),
  saveMeta: async () => true,
};

function makeEditor(content: JSONContent = BODY, options: PageExtensionsOptions = {}): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  editor = new Editor({ element, extensions: buildPageExtensions(options), content });
  return editor;
}

function assertSavable(current: Editor, label: string) {
  const result = validateBlocks(current.getJSON().content ?? []);
  expect(result.ok ? null : result.reason, label).toBeNull();
}

/** 本文の中の文字の位置（textblock の中）を全て集める。 */
function textPositions(current: Editor): number[] {
  const positions: number[] = [];
  current.state.doc.descendants((node, pos) => {
    if (node.isTextblock) positions.push(pos + 1 + Math.floor(node.content.size / 2));
  });
  return positions;
}

describe("every operation of the format bar and the block lists keeps the body within the limited AST", () => {
  const BAR_COMMANDS: Array<[string, (current: Editor) => unknown]> = [
    ["bold", (current) => current.chain().focus().toggleBold().run()],
    ["italic", (current) => current.chain().focus().toggleItalic().run()],
    ["heading", (current) => current.chain().focus().toggleHeading({ level: 2 }).run()],
    ["list", (current) => current.chain().focus().toggleBulletList().run()],
    ["link", (current) => current.chain().focus().setLink({ href: "https://example.com/x" }).run()],
    ["unlink", (current) => current.chain().focus().extendMarkRange("link").unsetLink().run()],
  ];

  it("for the line types and the bar's commands, on every line, and across lines", () => {
    const current = makeEditor();
    const lines = textPositions(current);
    const count = lines.length;
    // 行をまたぐ選択（見出しから最後の段落まで・リストの途中から引用まで）
    const spans: Array<[number, number]> = [
      [1, current.state.doc.content.size - 1],
      [lines[3]!, lines[6]!],
    ];
    const operations: Array<[string, (target: Editor) => unknown]> = [
      ...LINE_TYPE_CHOICES.map((choice): [string, (target: Editor) => unknown] => [`line type ${choice.id}`, (target) => setLineType(target, choice.id)]),
      ...BAR_COMMANDS,
    ];
    for (const [name, run] of operations) {
      for (let index = 0; index < count; index++) {
        current.commands.setContent(BODY);
        const pos = textPositions(current)[index]!;
        // 1 文字を選んでから（帯は選択に出る）
        current.view.dispatch(current.state.tr.setSelection(TextSelection.create(current.state.doc, pos, Math.min(pos + 1, current.state.doc.resolve(pos).end()))));
        run(current);
        assertSavable(current, `${name} at line ${index}`);
        // 同じ操作を 2 回（切り替え・入れ子が深くならない）
        run(current);
        assertSavable(current, `${name} twice at line ${index}`);
      }
      for (const [from, to] of spans) {
        current.commands.setContent(BODY);
        current.view.dispatch(current.state.tr.setSelection(TextSelection.create(current.state.doc, from, to)));
        run(current);
        assertSavable(current, `${name} across ${from}..${to}`);
      }
    }
  });

  it("keeps the inline marks when the line type changes", () => {
    const current = makeEditor({ type: "doc", content: [{ type: "paragraph", content: [text("太字", [{ type: "bold" }]), text("と斜体", [{ type: "italic" }])] }] });
    current.commands.setTextSelection({ from: 2, to: 4 });
    for (const choice of LINE_TYPE_CHOICES) {
      setLineType(current, choice.id);
      expect(lineTypeOf(current.state), choice.id).toBe(choice.id);
      expect(JSON.stringify(current.getJSON()), choice.id).toContain('"marks":[{"type":"bold"}]');
      expect(JSON.stringify(current.getJSON()), choice.id).toContain('"marks":[{"type":"italic"}]');
      assertSavable(current, choice.id);
    }
  });

  it("fills only a blank line directly in the body, and leaves everything else untouched", () => {
    // 「画像」はファイル選択を開くので、口と id を渡した状態で見る（本文に入るのはアップロードが済んでから）
    const current = makeEditor({ type: "doc", content: [p("前"), p(), p("後")] }, { images: IMAGES, pageId: () => "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11" });
    for (const choice of BLOCK_CHOICES) {
      current.commands.setContent({ type: "doc", content: [p("前"), p(), p("後")] });
      expect(fillBlankLine(current, choice.id, { at: 3 }), choice.id).toBe(true);
      assertSavable(current, choice.id);
      // 空でない段落・見出し・範囲の外は変えない
      const before = JSON.stringify(current.getJSON());
      expect(fillBlankLine(current, choice.id, { at: 0 }), `${choice.id} on text`).toBe(false);
      expect(fillBlankLine(current, choice.id, { at: 999 }), `${choice.id} outside`).toBe(false);
      expect(JSON.stringify(current.getJSON())).toBe(before);
    }
  });

  it("finds a blank line around 「/…」 only directly in the body", () => {
    const current = makeEditor({ type: "doc", content: [p(" /a "), p("x/a"), { type: "blockquote", content: [p("/a")] }, { type: "heading", attrs: { level: 3 }, content: [text("/")] }] });
    const { doc } = current.state;
    expect(blankLineAround(doc, { from: 2, to: 4 })).toEqual({ pos: 0, start: 1, end: 5 });
    expect(blankLineAround(doc, { from: 8, to: 10 })).toBeNull();
    expect(blankLineAround(doc, { from: 13, to: 15 })).toBeNull();
    expect(blankLineAround(doc, { from: 18, to: 19 })).toEqual({ pos: 17, start: 18, end: 19 });
  });
});

describe("the callout (#33)", () => {
  it("wraps the line in a callout that the AST accepts, and holds blocks", () => {
    const current = makeEditor({ type: "doc", content: [p("囲みにする")] });
    expect(setLineType(current, "callout")).toBe(true);
    expect(lineTypeOf(current.state)).toBe("callout");
    const body = current.getJSON().content ?? [];
    expect((body[0] as JSONContent).type).toBe("callout");
    const saved = validateBlocks(body);
    expect(saved.ok, saved.ok ? "" : saved.reason).toBe(true);

    // 入れ物なので、中に別のブロックを足せる
    current.commands.toggleBulletList();
    const withList = validateBlocks(current.getJSON().content ?? []);
    expect(withList.ok, withList.ok ? "" : withList.reason).toBe(true);
    expect(JSON.stringify(current.getJSON())).toContain('"type":"callout"');
  });

  it("is rendered as aside[data-callout], and parses that back", () => {
    const current = makeEditor({ type: "doc", content: [{ type: "callout", content: [p("補足")] }] });
    expect(current.getHTML()).toContain('<aside data-callout=""');
    // 同じ形の HTML を貼り直しても囲みに戻る（編集画面と共有ページで同じ DOM）
    const again = makeEditor();
    again.commands.setContent('<aside data-callout=""><p>補足</p></aside>');
    expect((again.getJSON().content?.[0] as JSONContent | undefined)?.type).toBe("callout");
  });

  it("is removed by 「テキスト」 and leaves the blocks behind", () => {
    const current = makeEditor({ type: "doc", content: [{ type: "callout", content: [p("中身")] }] });
    current.commands.setTextSelection(3);
    expect(setLineType(current, "paragraph")).toBe(true);
    expect(JSON.stringify(current.getJSON())).not.toContain('"type":"callout"');
    expect(JSON.stringify(current.getJSON())).toContain("中身");
  });

  it("never holds nothing (the AST refuses an empty callout)", () => {
    expect(validateBlocks([{ type: "callout", content: [] }]).ok).toBe(false);
  });
});

describe("the block choices", () => {
  it("offers the supported blocks, including checklists, tables, and code blocks", () => {
    expect(BLOCK_CHOICES.map((choice) => choice.id)).toEqual(["paragraph", "h2", "h3", "bullet", "task", "ordered", "quote", "callout", "hr", "image", "table", "codeBlock"]);
    expect(filterBlockChoices("").map((choice) => choice.label)).toEqual(["テキスト", "見出し 2", "見出し 3", "箇条書き", "チェックリスト", "番号付き", "引用", "囲み", "区切り線", "画像", "表", "コードブロック"]);
    for (const query of ["録音", "h1"]) expect(filterBlockChoices(query), query).toEqual([]);
    expect(filterBlockChoices("code").map((choice) => choice.id)).toEqual(["codeBlock"]);
    expect(filterBlockChoices("todo").map((choice) => choice.id)).toEqual(["task"]);
    expect(filterBlockChoices("表").map((choice) => choice.id)).toEqual(["table"]);
    // 画像は一覧にあり、日本語でも英語でも絞れる。行の種類ではない
    for (const query of ["画像", "image", "がぞう"]) expect(filterBlockChoices(query).map((choice) => choice.id), query).toEqual(["image"]);
    expect(LINE_TYPE_CHOICES.map((choice) => choice.id)).not.toContain("image");
    // 囲みは一覧にあり、日本語でも英語でも絞れる。引用と同じく行の種類でもある
    for (const query of ["囲み", "callout", "かこみ", "補足"]) expect(filterBlockChoices(query).map((choice) => choice.id), query).toEqual(["callout"]);
    expect(LINE_TYPE_CHOICES.map((choice) => choice.id)).toContain("callout");
  });

  it("opens the file picker for 画像 only when the page and the upload port are there", () => {
    const line = { type: "doc", content: [p("前"), p(), p("後")] } satisfies JSONContent;
    // 口が無い（画像を入れる手段が無い）
    const without = makeEditor(line);
    expect(fillBlankLine(without, "image", { at: 3 })).toBe(false);
    without.destroy();
    // まだ作っていないページ（最初の保存の前）
    const uncreated = makeEditor(line, { images: IMAGES, pageId: () => null });
    expect(fillBlankLine(uncreated, "image", { at: 3 })).toBe(false);
    // 理由は本文の下に出す（本文は変えない）
    expect(uncreated.view.dom.parentElement?.querySelector("[data-image-problem]")?.textContent).toContain("ページができてから");
    expect(validateBlocks(uncreated.getJSON().content ?? []).ok).toBe(true);
    uncreated.destroy();
    const ready = makeEditor(line, { images: IMAGES, pageId: () => "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11" });
    const clicks: string[] = [];
    const click = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function patched(this: HTMLInputElement) {
      clicks.push(this.accept);
    };
    try {
      expect(fillBlankLine(ready, "image", { at: 3 })).toBe(true);
    } finally {
      HTMLInputElement.prototype.click = click;
    }
    // 受け付ける種類だけを選べる選択を開き、本文にはまだ何も入れない
    expect(clicks).toEqual(["image/jpeg,image/png,image/webp,image/avif,image/gif"]);
    expect(ready.getJSON().content?.map((node) => node.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
  });
});

describe("the link field's check", () => {
  it("accepts what the saved body accepts, and says why it refuses the rest", () => {
    expect(checkLinkInput(" https://example.com/a ")).toEqual({ ok: true, href: "https://example.com/a" });
    expect(checkLinkInput("http://example.com")).toEqual({ ok: true, href: "http://example.com" });
    expect(checkLinkInput("mailto:someone@example.com")).toEqual({ ok: true, href: "mailto:someone@example.com" });
    for (const value of ["", "  ", "javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "vbscript:x", "/relative", "./a", "#top", "example.com", "java\nscript:x", `https://example.com/${"a".repeat(2100)}`]) {
      const result = checkLinkInput(value);
      expect(result.ok, value).toBe(false);
      expect(!result.ok && result.reason.length > 0, value).toBe(true);
    }
  });
});
