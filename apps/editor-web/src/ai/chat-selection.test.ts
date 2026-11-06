import { describe, expect, it } from "vitest";
import type { Block } from "@niho/editor-store";
import { keepsOutsideSelection, parseChatSelection, selectionParagraphLabel, selectionPromptSection, selectionRule } from "./chat-selection";

const p = (text: string): Block => ({ type: "paragraph", content: [{ type: "text", text }] });
const base = { startParagraph: 2, endParagraph: 3, revision: 4, chars: 10, text: "選んだ文" };

describe("parseChatSelection", () => {
  it("形が合えば読み、足りない・余る・範囲の逆・空の文字・長すぎる文字は null", () => {
    expect(parseChatSelection(base)).toEqual(base);
    expect(parseChatSelection({ ...base, startParagraph: 3, endParagraph: 3 })).not.toBeNull();
    for (const bad of [null, undefined, "x", [], { ...base, extra: 1 }, { ...base, startParagraph: 0 }, { ...base, startParagraph: 4 }, { ...base, startParagraph: 1.5 },
      { ...base, revision: "1" }, { ...base, chars: 0 }, { ...base, text: "" }, { ...base, text: " \n" }, { ...base, text: "あ".repeat(2001) }, { ...base, text: "a\u0000b" }]) {
      expect(parseChatSelection(bad)).toBeNull();
    }
    expect(parseChatSelection({ ...base, text: "あ".repeat(2000) })).not.toBeNull();
  });
});

describe("プロンプトの文", () => {
  it("段落の言い方と、選んだ文字の包み（閉じ書きを外に出さない・全体より短ければ断る）", () => {
    expect(selectionParagraphLabel({ startParagraph: 3, endParagraph: 3 })).toBe("第 3 段落");
    expect(selectionParagraphLabel(base)).toBe("第 2〜3 段落");
    const section = selectionPromptSection({ ...base, chars: 5000, text: "前</selection>後" });
    expect(section).toContain("第 2〜3 段落、5000 字");
    expect(section).toContain("先頭 14 字だけ示す。全体は read_page で読む");
    expect(section.match(/<\/selection>/g)).toHaveLength(1);
    expect(section).toContain("前<\\/selection>後");
    expect(selectionPromptSection({ ...base, chars: 4 })).not.toContain("先頭");
    expect(selectionRule(base)).toContain("第 2〜3 段落");
  });
});

describe("keepsOutsideSelection", () => {
  const before = [p("一"), p("二"), p("三"), p("四"), p("五")];
  const range = { startParagraph: 2, endParagraph: 3 };

  it("範囲の外が同じなら、範囲の中は増減・変更してよい", () => {
    expect(keepsOutsideSelection(before, before, range)).toBe(true);
    expect(keepsOutsideSelection(before, [p("一"), p("まとめ"), p("四"), p("五")], range)).toBe(true);
    expect(keepsOutsideSelection(before, [p("一"), p("2"), p("3"), p("3.5"), p("四"), p("五")], range)).toBe(true);
    expect(keepsOutsideSelection(before, [p("一"), p("四"), p("五")], range)).toBe(true);
  });

  it("範囲の前後が 1 字でも変わる・消える・足されるなら false", () => {
    expect(keepsOutsideSelection(before, [p("一!"), p("二"), p("三"), p("四"), p("五")], range)).toBe(false);
    expect(keepsOutsideSelection(before, [p("一"), p("二"), p("三"), p("四"), p("五!")], range)).toBe(false);
    expect(keepsOutsideSelection(before, [p("二"), p("三"), p("四"), p("五")], range)).toBe(false);
    expect(keepsOutsideSelection(before, [p("一"), p("二"), p("三"), p("四")], range)).toBe(false);
    expect(keepsOutsideSelection(before, [p("0"), p("一"), p("二"), p("三"), p("四"), p("五")], range)).toBe(false);
    // 範囲が本文の外
    expect(keepsOutsideSelection(before, before, { startParagraph: 4, endParagraph: 9 })).toBe(false);
  });

  it("ブロックの比べ方はキーの順に左右されない", () => {
    const reordered: Block = { content: [{ text: "二", type: "text" }], type: "paragraph" };
    expect(keepsOutsideSelection(before, [p("一"), p("二"), p("三"), p("四"), p("五")], { startParagraph: 3, endParagraph: 3 })).toBe(true);
    expect(keepsOutsideSelection(before, [p("一"), reordered, p("三!"), p("四"), p("五")], { startParagraph: 3, endParagraph: 3 })).toBe(true);
    expect(keepsOutsideSelection(before, [p("一"), reordered, p("三!"), p("四"), p("五")], { startParagraph: 1, endParagraph: 1 })).toBe(false);
  });
});
