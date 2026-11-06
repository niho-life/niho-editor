// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_SELECTION_TEXT_CHARS } from "@/ai/chat-limits";
import { AiSelection, aiSelectionOf, describeAiSelection } from "./ai-selection";
import { buildPageExtensions } from "./page-extensions";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

const p = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
const h = (text: string): JSONContent => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });
const list = (...items: string[]): JSONContent => ({ type: "bulletList", content: items.map((item) => ({ type: "listItem", content: [p(item)] })) });

function open(content: JSONContent[]): Editor {
  const host = document.createElement("div");
  document.body.append(host);
  editor = new Editor({ element: host, extensions: [...buildPageExtensions(), AiSelection], content: { type: "doc", content } });
  return editor;
}

/** 本文の中の文字列 `needle` の範囲（doc の位置）。 */
function find(target: Editor, needle: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  target.state.doc.descendants((node, pos) => {
    if (found || !node.isText) return;
    const at = (node.text ?? "").indexOf(needle);
    if (at >= 0) found = { from: pos + at, to: pos + at + needle.length };
  });
  if (!found) throw new Error(`not found: ${needle}`);
  return found;
}

const BLOCKS = [h("見出し"), p("一つ目の段落です。"), p("二つ目の段落です。"), list("箇条書きの 1", "箇条書きの 2"), p("最後の段落です。")];

describe("AiSelection", () => {
  it("残した範囲に下地を描き、本文は変えず、外すと消える", () => {
    const target = open(BLOCKS);
    const json = JSON.stringify(target.getJSON());
    expect(aiSelectionOf(target.state)).toBeNull();
    const range = find(target, "二つ目");
    expect(target.commands.setAiSelection(range)).toBe(true);
    expect(aiSelectionOf(target.state)).toEqual(range);
    expect([...target.view.dom.querySelectorAll(".es-ai-selection")].map((node) => node.textContent).join("")).toBe("二つ目");
    expect(JSON.stringify(target.getJSON())).toBe(json);
    target.commands.clearAiSelection();
    expect(aiSelectionOf(target.state)).toBeNull();
    expect(target.view.dom.querySelector(".es-ai-selection")).toBeNull();
  });

  it("エディタの選択が外れても残る。空の範囲は残さない", () => {
    const target = open(BLOCKS);
    const range = find(target, "一つ目");
    target.commands.setAiSelection(range);
    target.view.dispatch(target.state.tr.setSelection(TextSelection.create(target.state.doc, 1)));
    expect(aiSelectionOf(target.state)).toEqual(range);
    target.commands.setAiSelection({ from: 5, to: 5 });
    expect(aiSelectionOf(target.state)).toBeNull();
  });

  it("本文の編集で動く位置に追従し、範囲が丸ごと消えたら外れる。外側に足した文字は入れない", () => {
    const target = open(BLOCKS);
    const range = find(target, "二つ目");
    target.commands.setAiSelection(range);
    // 前に文字を足すと、範囲は後ろへずれる
    target.view.dispatch(target.state.tr.insertText("前置き。", find(target, "一つ目").from));
    const moved = aiSelectionOf(target.state)!;
    expect(moved.from).toBe(range.from + 4);
    expect(target.state.doc.textBetween(moved.from, moved.to)).toBe("二つ目");
    // 範囲の直前・直後に足した文字は範囲に入らない
    target.view.dispatch(target.state.tr.insertText("【", moved.from));
    target.view.dispatch(target.state.tr.insertText("】", aiSelectionOf(target.state)!.to));
    expect(target.state.doc.textBetween(aiSelectionOf(target.state)!.from, aiSelectionOf(target.state)!.to)).toBe("二つ目");
    // 範囲を消すと外れる
    const now = aiSelectionOf(target.state)!;
    target.view.dispatch(target.state.tr.delete(now.from, now.to));
    expect(aiSelectionOf(target.state)).toBeNull();
  });
});

describe("describeAiSelection", () => {
  it("最上位のブロックの番号（1 始まり）と字数を、今の本文から求める", () => {
    const target = open(BLOCKS);
    const one = find(target, "二つ目");
    expect(describeAiSelection(target.state.doc, one, 7)).toEqual({
      selection: { startParagraph: 3, endParagraph: 3, revision: 7, chars: 3, text: "二つ目" },
      fullText: "二つ目",
    });
    // 2 つの段落にまたがる（段落の間は改行。字数には数えない）
    const across = { from: find(target, "一つ目").from, to: find(target, "二つ目の段落").to };
    const two = describeAiSelection(target.state.doc, across, 7)!;
    expect(two.selection).toMatchObject({ startParagraph: 2, endParagraph: 3 });
    expect(two.fullText).toBe("一つ目の段落です。\n二つ目の段落");
    expect(two.selection.chars).toBe(Array.from("一つ目の段落です。二つ目の段落").length);
  });

  it("箇条書きは 1 つのブロック（read_page の番号と同じ）。見出しも 1 段落と数える", () => {
    const target = open(BLOCKS);
    const items = describeAiSelection(target.state.doc, { from: find(target, "箇条書きの 1").from, to: find(target, "箇条書きの 2").to }, 1)!;
    expect(items.selection).toMatchObject({ startParagraph: 4, endParagraph: 4 });
    const heading = describeAiSelection(target.state.doc, find(target, "見出し"), 1)!;
    expect(heading.selection).toMatchObject({ startParagraph: 1, endParagraph: 1 });
    const wide = describeAiSelection(target.state.doc, { from: find(target, "見出し").from, to: find(target, "最後の段落").to }, 1)!;
    expect(wide.selection).toMatchObject({ startParagraph: 1, endParagraph: 5 });
  });

  it("範囲の終わりが次のブロックの 0 字目（先頭）でも、次のブロックは含めない。入れ子の先頭も同じ", () => {
    const target = open(BLOCKS);
    const second = find(target, "二つ目の段落です。");
    const next = find(target, "箇条書きの 1");
    // 「二つ目」の途中から、次の箇条書きの先頭（1 字目の手前）まで
    const toListStart = describeAiSelection(target.state.doc, { from: second.from + 2, to: next.from }, 1)!;
    expect(toListStart.selection).toMatchObject({ startParagraph: 3, endParagraph: 3 });
    // 箇条書きの 2 つ目の項目の先頭まで → 箇条書き（4）の中なので 4 のまま
    const toSecondItem = describeAiSelection(target.state.doc, { from: second.from + 2, to: find(target, "箇条書きの 2").from }, 1)!;
    expect(toSecondItem.selection).toMatchObject({ startParagraph: 3, endParagraph: 4 });
    // 段落の先頭から次の段落の先頭まで
    const lastPara = find(target, "最後の段落です。");
    const toLast = describeAiSelection(target.state.doc, { from: find(target, "箇条書きの 2").from, to: lastPara.from }, 1)!;
    expect(toLast.selection).toMatchObject({ startParagraph: 4, endParagraph: 4 });
  });

  it("全選択（⌘A）は、全部の段落の範囲になる", () => {
    const target = open(BLOCKS);
    target.commands.selectAll();
    const all = describeAiSelection(target.state.doc, { from: target.state.selection.from, to: target.state.selection.to }, 1)!;
    expect(all.selection).toMatchObject({ startParagraph: 1, endParagraph: 5 });
  });

  it("ブロックの境目で終わる範囲は、次のブロックに入れない。文字の無い範囲は null。長い選択は先頭だけ text に入れる", () => {
    const target = open([p("あ".repeat(3000)), p("次の段落")]);
    const first = find(target, "あ");
    const wholeFirst = { from: first.from, to: first.from + 3000 };
    // 範囲の終わりが 1 つ目の段落の終わり（次の段落の手前）
    const described = describeAiSelection(target.state.doc, { from: wholeFirst.from, to: wholeFirst.to + 1 }, 2)!;
    expect(described.selection).toMatchObject({ startParagraph: 1, endParagraph: 1, chars: 3000 });
    expect(Array.from(described.selection.text)).toHaveLength(MAX_SELECTION_TEXT_CHARS);
    expect(Array.from(described.fullText)).toHaveLength(3000);
    expect(describeAiSelection(target.state.doc, { from: 3, to: 3 }, 1)).toBeNull();
    const blank = open([p("   "), p("次")]);
    expect(describeAiSelection(blank.state.doc, { from: 1, to: 4 }, 1)).toBeNull();
  });
});
