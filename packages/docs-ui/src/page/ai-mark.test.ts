// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { validateBlocks, type Block } from "./blocks";
import { replaceBlocks } from "./doc";
import { buildPageExtensions } from "./page-extensions";

beforeAll(() => {
  // jsdom に無い描画の API（ProseMirror が読む）
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  Range.prototype.getBoundingClientRect = rect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Element.prototype.scrollIntoView = () => undefined;
});

let editor: Editor | null = null;

function makeEditor(): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  editor = new Editor({ element, extensions: buildPageExtensions() });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

const AI_BODY: Block[] = [
  { type: "paragraph", content: [{ type: "text", text: "人の" }, { type: "text", text: "AIの語", marks: [{ type: "ai" }] }] },
];

/** 段落の中の text を、`ai` の有無と一緒に並べる。 */
function runs(current: Editor): Array<[string, boolean]> {
  const result = validateBlocks(current.getJSON().content ?? []);
  if (!result.ok) throw new Error(result.reason);
  const out: Array<[string, boolean]> = [];
  for (const block of result.blocks) {
    for (const inline of (block.content ?? []) as Block[]) {
      const marks = Array.isArray(inline.marks) ? (inline.marks as Array<{ type: string }>) : [];
      out.push([String(inline.text ?? ""), marks.some((mark) => mark.type === "ai")]);
    }
  }
  return out;
}

describe("AI が足した語の印（ai）", () => {
  it("replaceBlocks で載せた本文の ai は残り、span[data-ai] で描かれる", () => {
    const current = makeEditor();
    expect(replaceBlocks(current, AI_BODY)).toBe(true);
    expect(runs(current)).toEqual([["人の", false], ["AIの語", true]]);
    expect(current.view.dom.querySelector("span[data-ai]")?.textContent).toBe("AIの語");
  });

  it("ai の中に打った文字・ai の端から打った文字には付かない", () => {
    const current = makeEditor();
    replaceBlocks(current, AI_BODY);
    // 「AIの語」の「の」の前（段落の開始 1 ＋「人の」2 ＋「AI」2）
    current.chain().insertContentAt(5, "人").run();
    expect(runs(current)).toEqual([["人の", false], ["AI", true], ["人", false], ["の語", true]]);
    // 段落の終わり（ai の右端）から打つ
    current.chain().focus("end").insertContent("末尾").run();
    expect(runs(current).at(-1)).toEqual(["末尾", false]);
  });

  it("ai の範囲を選んで打ち替えると、打った文字は ai を持たない", () => {
    const current = makeEditor();
    replaceBlocks(current, AI_BODY);
    current.chain().setTextSelection({ from: 3, to: 7 }).insertContent("置換").run();
    expect(runs(current)).toEqual([["人の置換", false]]);
  });

  it("Undo で戻した文字の ai は剥がさない", () => {
    const current = makeEditor();
    replaceBlocks(current, AI_BODY);
    // AI の語を消してから Undo で戻す
    current.chain().setTextSelection({ from: 3, to: 7 }).deleteSelection().run();
    expect(runs(current)).toEqual([["人の", false]]);
    current.commands.undo();
    expect(runs(current)).toEqual([["人の", false], ["AIの語", true]]);
  });
});
