import { Mark } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";

/** AI が足した語の印の mark の名前（限定 AST・エディタの schema で同じ）。 */
export const AI_MARK_NAME = "ai";

/**
 * transaction に付けると、そこで入った文字から `ai` を外さない（AI の結果・版の復元を `replaceBlocks` で載せるとき）。
 */
export const PRESERVE_AI_MARKS_META = "preserveAiMarks";

const aiMarkPluginKey = new PluginKey("aiMarkStrip");

/** 人が打った・貼った transaction か（AI の結果の差し替え・Undo/Redo・履歴に残さない差し替えは除く）。 */
function isHumanEdit(tr: Transaction): boolean {
  if (!tr.docChanged) return false;
  if (tr.getMeta(PRESERVE_AI_MARKS_META) === true) return false;
  if (tr.getMeta("addToHistory") === false) return false;
  // Undo/Redo（prosemirror-history の plugin key は "history$"）。戻した文字の印は戻したまま残す
  if (tr.getMeta("history$") !== undefined) return false;
  return true;
}

/**
 * AI が足した語の印（#AI と作る）。本文では灰色で出し（editor.css）、Markdown・公開・書き出しには出さない。
 *
 * 人が打った文字には付けない: `inclusive: false` で印の端から打っても広がらず、印の中に打った文字・貼った文字からは
 * plugin が外す。AI の結果を載せるときは `replaceBlocks`（doc.ts）が `preserveAiMarks` を付けるので外れない。
 */
export const AiMark = Mark.create({
  name: AI_MARK_NAME,
  inclusive: false,

  parseHTML() {
    return [{ tag: "span[data-ai]" }];
  },

  renderHTML() {
    return ["span", { "data-ai": "", title: "AI が書いた" }, 0];
  },

  addProseMirrorPlugins() {
    const aiType = this.type;
    return [
      new Plugin({
        key: aiMarkPluginKey,
        appendTransaction(transactions, _oldState, newState) {
          // 人の編集で入った範囲を、最後の doc の位置で集める（後続の step・transaction の mapping を通す）
          const ranges: Array<[number, number]> = [];
          transactions.forEach((tr, at) => {
            if (!isHumanEdit(tr)) return;
            tr.mapping.maps.forEach((map, stepIndex) => {
              map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
                if (newEnd <= newStart) return;
                const rest = tr.mapping.slice(stepIndex + 1);
                let from = rest.map(newStart, 1);
                let to = rest.map(newEnd, -1);
                for (const later of transactions.slice(at + 1)) {
                  from = later.mapping.map(from, 1);
                  to = later.mapping.map(to, -1);
                }
                if (to > from) ranges.push([from, to]);
              });
            });
          });
          const size = newState.doc.content.size;
          const tr = newState.tr;
          let changed = false;
          for (const [rawFrom, rawTo] of ranges) {
            const from = Math.max(0, rawFrom);
            const to = Math.min(size, rawTo);
            if (to <= from || !newState.doc.rangeHasMark(from, to, aiType)) continue;
            tr.removeMark(from, to, aiType);
            changed = true;
          }
          const stored = newState.storedMarks;
          if (stored && stored.some((mark) => mark.type === aiType)) {
            tr.setStoredMarks(stored.filter((mark) => mark.type !== aiType));
            changed = true;
          }
          return changed ? tr : null;
        },
      }),
    ];
  },
});
