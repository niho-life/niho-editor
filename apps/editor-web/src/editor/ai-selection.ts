/**
 * 本文で選んだ範囲を、AI チャットへ渡すあいだ残しておく（#280。NIHOapp の「選んで指示」）。
 *
 * - 選んだ範囲を plugin の state に持ち、**薄い下地**（decoration）を描く。入力欄へ移ってエディタの選択が消えても残る。
 * - 本文は変えない（描くだけ）。範囲は編集で動く位置に追従し、範囲が丸ごと消えたら null に戻る。
 * - どの段落（最上位のブロックの番号）の何字かは `describeAiSelection` で今の本文から求める（AI への依頼の材料）。
 */
import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { MAX_SELECTION_TEXT_CHARS } from "@/ai/chat-limits";
import type { ChatSelection } from "@/ai/chat-selection";

export type AiSelectionRange = { from: number; to: number } | null;

type Meta = { type: "set"; from: number; to: number } | { type: "clear" };

export const aiSelectionKey = new PluginKey<AiSelectionRange>("aiSelection");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    aiSelection: {
      /** この範囲を AI へ渡す選択範囲として残し、下地を描く（空の範囲は残さない）。 */
      setAiSelection: (range: { from: number; to: number }) => ReturnType;
      /** 残している範囲を外す。 */
      clearAiSelection: () => ReturnType;
    };
  }
}

/** 今残している範囲（無ければ null）。 */
export function aiSelectionOf(state: EditorState): AiSelectionRange {
  return aiSelectionKey.getState(state) ?? null;
}

export const AiSelection = Extension.create({
  name: "aiSelection",
  addCommands() {
    return {
      setAiSelection: (range) => ({ tr, dispatch }) => {
        if (dispatch) dispatch(tr.setMeta(aiSelectionKey, { type: "set", from: range.from, to: range.to } satisfies Meta));
        return true;
      },
      clearAiSelection: () => ({ tr, dispatch }) => {
        if (dispatch) dispatch(tr.setMeta(aiSelectionKey, { type: "clear" } satisfies Meta));
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin<AiSelectionRange>({
        key: aiSelectionKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(aiSelectionKey) as Meta | undefined;
            if (meta?.type === "clear") return null;
            if (meta?.type === "set") {
              const from = Math.max(0, meta.from);
              const to = Math.min(tr.doc.content.size, meta.to);
              return to > from ? { from, to } : null;
            }
            if (!value || !tr.docChanged) return value;
            // 範囲の端は、内側へ寄せて動かす（外側に足された文字は範囲に入れない）。範囲が丸ごと消えたら外す
            const from = tr.mapping.map(value.from, 1);
            const to = tr.mapping.map(value.to, -1);
            return to > from ? { from, to } : null;
          },
        },
        props: {
          decorations(state) {
            const range = aiSelectionKey.getState(state);
            if (!range) return null;
            return DecorationSet.create(state.doc, [Decoration.inline(range.from, range.to, { class: "es-ai-selection" })]);
          },
        },
      }),
    ];
  },
});

/** 範囲の端（`to` は含まない位置）が最上位のどのブロックか（0 始まり）。ブロックの間の位置は、前のブロックの終わりと数える。 */
function topLevelIndex(doc: PmNode, pos: number, end: boolean): number {
  const resolved = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  if (resolved.depth === 0) return Math.max(0, end ? resolved.index(0) - 1 : resolved.index(0));
  return resolved.index(0);
}

/**
 * 選んだ範囲を、AI への依頼の形にする。段落の番号は read_page の `n` と同じ数え方（最上位のブロックの 1 始まり）。
 * 文字が無い範囲（画像だけ・空白だけ）は null。`fullText` は選んだ文字の全部（CLI に渡す）、`selection.text` は先頭
 * `MAX_SELECTION_TEXT_CHARS` 字まで。`revision` は呼ぶ側が、本文の版（依頼の直前に保存した版）を入れる。
 */
export function describeAiSelection(doc: PmNode, range: { from: number; to: number }, revision: number): { selection: ChatSelection; fullText: string } | null {
  if (range.to <= range.from) return null;
  const fullText = doc.textBetween(range.from, range.to, "\n", "\n").trim();
  if (fullText.length === 0) return null;
  const startIndex = topLevelIndex(doc, range.from, false);
  const endIndex = Math.max(startIndex, topLevelIndex(doc, range.to, true));
  const letters = Array.from(fullText.replace(/\n/g, ""));
  const text = Array.from(fullText).slice(0, MAX_SELECTION_TEXT_CHARS).join("");
  return {
    selection: { startParagraph: startIndex + 1, endParagraph: endIndex + 1, revision, chars: letters.length, text },
    fullText,
  };
}
