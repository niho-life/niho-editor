// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { AiDiffView, aiDiffOf } from "./ai-diff-view";
import { buildPageExtensions } from "./page-extensions";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

const p = (text: string, marks?: JSONContent["marks"]): JSONContent => ({ type: "paragraph", content: [{ type: "text", text, ...(marks ? { marks } : {}) }] });
const h = (text: string): JSONContent => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });

/** 直す前（版）: 0 見出し・1 段落・2 消す段落・3 段落。 */
const BEFORE: JSONContent[] = [h("鎌倉の朝"), p("海までゆっくり歩いた。"), p("消された段落です。"), p("最後の段落。")];
/** 今（AI が直した後）: 1 は語を直し、2 は消し、新しい段落を足した。 */
const AFTER: JSONContent[] = [h("鎌倉の朝"), p("海まで急いで歩いた。", [{ type: "ai" }]), p("最後の段落。"), p("足した段落です。", [{ type: "ai" }])];

function open(content: JSONContent[] = AFTER): Editor {
  const host = document.createElement("div");
  document.body.append(host);
  editor = new Editor({ element: host, extensions: [...buildPageExtensions(), AiDiffView], content: { type: "doc", content } });
  return editor;
}

const texts = (target: Editor) => (target.getJSON().content ?? []).map((block) => (block.content ?? []).map((inline) => (inline as { text?: string }).text ?? "").join(""));

describe("AiDiffView", () => {
  it("draws the hunks as decorations without changing the body", () => {
    const target = open();
    const json = JSON.stringify(target.getJSON());
    expect(target.commands.showAiDiff({ before: BEFORE })).toBe(true);
    const diff = aiDiffOf(target.state)!;
    expect(diff.hunks.map((hunk) => hunk.kind).sort()).toEqual(["changed", "deleted", "inserted"]);
    const dom = target.view.dom;
    expect(dom.querySelectorAll(".es-diff-ins").length).toBeGreaterThan(0);
    expect([...dom.querySelectorAll(".es-diff-del")].map((node) => node.textContent).join("")).toContain("ゆっくり");
    expect(dom.querySelectorAll(".es-diff-added")).toHaveLength(1);
    expect(dom.querySelector(".es-diff-del-block")?.textContent).toBe("消された段落です。");
    expect(dom.querySelectorAll(".es-diff-ctl")).toHaveLength(3);
    expect([...dom.querySelectorAll(".es-diff-ctl button")].map((node) => node.textContent).slice(0, 2)).toEqual(["戻す", "これだけ残す"]);
    expect(JSON.stringify(target.getJSON())).toBe(json);
  });

  it("shows a formatting-only change as a hunk, paints the block, and reverts it", () => {
    const target = open([p("太字にした文", [{ type: "bold" }])]);
    target.commands.showAiDiff({ before: [p("太字にした文")] });
    const diff = aiDiffOf(target.state)!;
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]).toMatchObject({ kind: "changed" });
    const dom = target.view.dom;
    expect(dom.querySelectorAll(".es-diff-changed")).toHaveLength(1);
    expect(dom.querySelector(".es-diff-changed")?.getAttribute("title")).toBe("書式が変わりました");
    // 同じ文を打ち消し線で重ねない
    expect(dom.querySelector(".es-diff-del-block")).toBeNull();
    expect(dom.querySelectorAll(".es-diff-ctl")).toHaveLength(1);
    expect(target.commands.revertAllAiHunks()).toBe(true);
    expect(target.getJSON().content?.[0]?.content?.[0]).toEqual({ type: "text", text: "太字にした文" });
    expect(aiDiffOf(target.state)!.hunks).toEqual([]);
  });

  it("is read-only while shown and editable again when hidden", () => {
    const target = open();
    target.commands.showAiDiff({ before: BEFORE });
    expect(target.isEditable).toBe(false);
    expect(target.view.dom.getAttribute("contenteditable")).toBe("false");
    target.commands.hideAiDiff();
    expect(aiDiffOf(target.state)).toBeNull();
    expect(target.isEditable).toBe(true);
    expect(target.view.dom.querySelector(".es-diff-ctl")).toBeNull();
  });

  it("reverts one hunk to the earlier version, counts it, and can be undone", () => {
    const target = open();
    target.commands.showAiDiff({ before: BEFORE });
    const index = aiDiffOf(target.state)!.hunks.findIndex((hunk) => hunk.kind === "changed");
    expect(target.commands.revertAiHunk(index)).toBe(true);
    expect(texts(target)[1]).toBe("海までゆっくり歩いた。");
    const diff = aiDiffOf(target.state)!;
    expect(diff.reverted).toBe(1);
    expect(diff.hunks.some((hunk) => hunk.kind === "changed")).toBe(false);
    // 普通の編集なので Undo で AI の文に戻る
    target.commands.undo();
    expect(texts(target)[1]).toBe("海まで急いで歩いた。");
  });

  it("reverts a deleted and an inserted block", () => {
    const target = open();
    target.commands.showAiDiff({ before: BEFORE });
    const hunks = aiDiffOf(target.state)!.hunks;
    target.commands.revertAiHunk(hunks.findIndex((hunk) => hunk.kind === "deleted"));
    expect(texts(target)).toEqual(["鎌倉の朝", "海まで急いで歩いた。", "消された段落です。", "最後の段落。", "足した段落です。"]);
    target.commands.revertAiHunk(aiDiffOf(target.state)!.hunks.findIndex((hunk) => hunk.kind === "inserted"));
    expect(texts(target)).toEqual(["鎌倉の朝", "海まで急いで歩いた。", "消された段落です。", "最後の段落。"]);
  });

  it("keeps only one hunk and reverts the rest", () => {
    const target = open();
    target.commands.showAiDiff({ before: BEFORE });
    const index = aiDiffOf(target.state)!.hunks.findIndex((hunk) => hunk.kind === "inserted");
    target.commands.keepOnlyAiHunk(index);
    expect(texts(target)).toEqual(["鎌倉の朝", "海までゆっくり歩いた。", "消された段落です。", "最後の段落。", "足した段落です。"]);
    expect(aiDiffOf(target.state)!.reverted).toBe(2);
    expect(aiDiffOf(target.state)!.hunks).toHaveLength(1);
  });

  it("reverts every hunk back to the earlier version", () => {
    const target = open();
    target.commands.showAiDiff({ before: BEFORE });
    target.commands.revertAllAiHunks();
    expect(texts(target)).toEqual(["鎌倉の朝", "海までゆっくり歩いた。", "消された段落です。", "最後の段落。"]);
    expect(aiDiffOf(target.state)!.hunks).toEqual([]);
    expect(aiDiffOf(target.state)!.reverted).toBe(3);
  });

  it("keeps the ai mark of the earlier version when reverting", () => {
    const before = [p("前の AI の文", [{ type: "ai" }])];
    const target = open([p("人が直した文")]);
    target.commands.showAiDiff({ before });
    target.commands.revertAllAiHunks();
    expect(target.getJSON().content?.[0]?.content?.[0]).toMatchObject({ text: "前の AI の文", marks: [{ type: "ai" }] });
  });

  it("closes on Escape", () => {
    const target = open();
    target.commands.showAiDiff({ before: BEFORE });
    const event = new KeyboardEvent("keydown", { key: "Escape" });
    target.view.someProp("handleKeyDown", (handle) => handle(target.view, event));
    expect(aiDiffOf(target.state)).toBeNull();
  });
});
