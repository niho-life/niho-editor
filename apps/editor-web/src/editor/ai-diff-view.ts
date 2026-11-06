/**
 * 「変更を見る」（AI と作る。設計 §6.2）。直す前の版の本文と今の本文の差分を、本文の上に decoration だけで描く。
 *
 * - 本文そのものは変えない（描くだけ）。表示中は読み取り専用（plugin の `editable`）。
 * - 変更ごとに「戻す」「これだけ残す」。戻す＝そのブロックを前の版の形に置き換える普通の編集（履歴に残り、Undo できる。
 *   自動保存もふつうに走る）。前の版の `ai` を剥がさないよう `preserveAiMarks` を付ける。
 * - 本文が変わるたび（戻した・競合で差し替わった）に差分を取り直す。
 */
import { Extension, type Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Block } from "@niho/editor-store";
import { PRESERVE_AI_MARKS_META } from "niho-docs-ui/page/ai-mark";
import { alignBlocks, blockText, diffBlocks, partLabel, type BlockHunk } from "@/ai/block-diff";

/** 表示中の差分（閉じているときは null）。`reverted` は開いてから戻した変更の数。 */
export type AiDiffViewState = { before: Block[]; hunks: BlockHunk[]; reverted: number } | null;

type Meta = { type: "show"; before: Block[] } | { type: "hide" } | { type: "reverted"; count: number };

export const aiDiffKey = new PluginKey<AiDiffViewState>("aiDiffView");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    aiDiffView: {
      /** 直す前の本文（版の blocks）と今の本文の差分を描き、読み取り専用にする。 */
      showAiDiff: (input: { before: unknown[] }) => ReturnType;
      /** 差分を閉じ、書けるように戻す。 */
      hideAiDiff: () => ReturnType;
      /** その変更を前の版の形に戻す。 */
      revertAiHunk: (index: number) => ReturnType;
      /** その変更だけを残し、ほかの変更を全部戻す。 */
      keepOnlyAiHunk: (index: number) => ReturnType;
      /** 全部の変更を戻す。 */
      revertAllAiHunks: () => ReturnType;
    };
  }
}

/** 今の表示中の差分（閉じていれば null）。 */
export function aiDiffOf(state: EditorState): AiDiffViewState {
  return aiDiffKey.getState(state) ?? null;
}

function blocksOf(doc: PmNode): Block[] {
  return (doc.toJSON() as { content?: Block[] }).content ?? [];
}

/** 最上位のブロックの開始位置。 */
function starts(doc: PmNode): number[] {
  const out: number[] = [];
  doc.forEach((_node, offset) => out.push(offset));
  return out;
}

/** 消したブロックを差し込む位置（前の対のブロックの後ろ。無ければ先頭）。beforeIndex → 今の本文の最上位の位置。 */
function deletedAnchors(before: readonly Block[], after: readonly Block[], doc: PmNode): Map<number, number> {
  const at = starts(doc);
  const anchors = new Map<number, number>();
  let last = -1;
  for (const pair of alignBlocks(before, after)) {
    if (pair.kind === "deleted") {
      const node = last >= 0 ? doc.child(last) : null;
      anchors.set(pair.beforeIndex, node ? at[last]! + node.nodeSize : 0);
    } else last = Math.max(last, pair.afterIndex);
  }
  return anchors;
}

/** 葉のブロックの平文の offset → doc の位置（text は 1 文字 1 位置、hardBreak は "\n" の 1 文字）。 */
function inlinePositions(node: PmNode, start: number): number[] {
  const out: number[] = [];
  let pos = start + 1;
  node.forEach((child) => {
    if (child.isText) {
      for (let index = 0; index < (child.text ?? "").length; index++) out.push(pos + index);
    } else if (child.type.name === "hardBreak") out.push(pos);
    pos += child.nodeSize;
  });
  out.push(pos);
  return out;
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 変更ごとの「戻す」「これだけ残す」。 */
function controls(editor: Editor, index: number): HTMLElement {
  const box = element("span", "es-diff-ctl");
  box.contentEditable = "false";
  const button = (label: string, run: () => void) => {
    const node = element("button", "", label) as HTMLButtonElement;
    node.type = "button";
    node.addEventListener("mousedown", (event) => event.preventDefault());
    node.addEventListener("click", (event) => {
      event.preventDefault();
      run();
    });
    box.append(node);
  };
  button("戻す", () => editor.commands.revertAiHunk(index));
  button("これだけ残す", () => editor.commands.keepOnlyAiHunk(index));
  return box;
}

const WIDGET = { ignoreSelection: true, stopEvent: () => true } as const;

function decorations(editor: Editor, state: EditorState, diff: NonNullable<AiDiffViewState>): DecorationSet {
  const { doc } = state;
  const at = starts(doc);
  const decos: Decoration[] = [];
  const anchors = diff.hunks.some((hunk) => hunk.kind === "deleted") ? deletedAnchors(diff.before, blocksOf(doc), doc) : new Map<number, number>();
  diff.hunks.forEach((hunk, index) => {
    if (hunk.kind === "deleted") {
      const pos = anchors.get(hunk.beforeIndex) ?? 0;
      const text = blockText(hunk.block);
      decos.push(Decoration.widget(pos, () => {
        const box = element("span", "es-diff-deleted");
        box.append(element("del", "es-diff-del-block", text || partLabel(hunk.block) || "（消したブロック）"), controls(editor, index));
        return box;
      }, { ...WIDGET, side: -1, key: `deleted-${index}-${text}` }));
      return;
    }
    const start = at[hunk.afterIndex];
    if (start === undefined) return;
    const node = doc.child(hunk.afterIndex);
    const end = start + node.nodeSize;
    // ブロックの末尾（行の中身を持つブロックは中身の最後、それ以外はブロックの後ろ）に操作を置く
    const ctlPos = node.isTextblock ? end - 1 : end;
    const ctlSide = node.isTextblock ? 1 : -1;
    if (hunk.kind === "inserted") {
      decos.push(Decoration.node(start, end, { class: "es-diff-added" }));
    } else if (hunk.parts && node.isTextblock) {
      // 文は同じで、太字・リンク先・見出しの段階などだけが変わった（語の差分が無いので、ブロックを塗って気づけるようにする）
      if (hunk.parts.every((part) => typeof part === "string")) decos.push(Decoration.node(start, end, { class: "es-diff-changed", title: "書式が変わりました" }));
      const positions = inlinePositions(node, start);
      const posAt = (offset: number) => positions[Math.min(offset, positions.length - 1)]!;
      let offset = 0;
      hunk.parts.forEach((part, partIndex) => {
        if (typeof part === "string") offset += part.length;
        else if ("ins" in part) {
          decos.push(Decoration.inline(posAt(offset), posAt(offset + part.ins.length), { class: "es-diff-ins" }));
          offset += part.ins.length;
        } else {
          const text = part.del;
          decos.push(Decoration.widget(posAt(offset), () => element("del", "es-diff-del", text), { ...WIDGET, side: -1, key: `del-${index}-${partIndex}-${text}` }));
        }
      });
    } else {
      const text = blockText(diff.before[hunk.beforeIndex] ?? {});
      // 文が同じで構造・書式だけ違う（入れ子の段落を見出しにした等）ときは、同じ文を打ち消し線で重ねず、ブロックを塗るだけにする
      const same = text !== "" && text === blockText(node.toJSON() as Block);
      decos.push(Decoration.node(start, end, same ? { class: "es-diff-changed", title: "書式が変わりました" } : { class: "es-diff-changed" }));
      if (!same) decos.push(Decoration.widget(start, () => element("del", "es-diff-del-block", text || partLabel(diff.before[hunk.beforeIndex] ?? {}) || "（前のブロック）"), { ...WIDGET, side: -1, key: `was-${index}-${text}` }));
    }
    decos.push(Decoration.widget(ctlPos, () => controls(editor, index), { ...WIDGET, side: ctlSide, key: `ctl-${index}` }));
  });
  return DecorationSet.create(doc, decos);
}

type Op = { from: number; to: number; node: PmNode | null; order: number };

/** 選んだ変更を前の版に戻す transaction を組む（戻した数を返す。組めなければ 0）。 */
function revert(state: EditorState, tr: Transaction, diff: NonNullable<AiDiffViewState>, indexes: readonly number[]): number {
  const { doc, schema } = state;
  const at = starts(doc);
  const anchors = deletedAnchors(diff.before, blocksOf(doc), doc);
  const ops: Op[] = [];
  for (const index of indexes) {
    const hunk = diff.hunks[index];
    if (!hunk) continue;
    try {
      if (hunk.kind === "deleted") {
        ops.push({ from: anchors.get(hunk.beforeIndex) ?? 0, to: anchors.get(hunk.beforeIndex) ?? 0, node: schema.nodeFromJSON(hunk.block), order: hunk.beforeIndex });
        continue;
      }
      const start = at[hunk.afterIndex];
      if (start === undefined) continue;
      const end = start + doc.child(hunk.afterIndex).nodeSize;
      if (hunk.kind === "inserted") ops.push({ from: start, to: end, node: null, order: 0 });
      else ops.push({ from: start, to: end, node: schema.nodeFromJSON(diff.before[hunk.beforeIndex]), order: 0 });
    } catch {
      // 今の schema で読めない前のブロックは戻さない
    }
  }
  // 後ろから当てる（前の位置がずれない）。同じ位置なら、範囲の置き換えを先に、差し込みは前の版の後ろのものから
  ops.sort((a, b) => b.from - a.from || (b.to - b.from) - (a.to - a.from) || b.order - a.order);
  for (const op of ops) {
    if (op.from === op.to) {
      if (op.node) tr.insert(op.from, op.node);
    } else if (op.node) tr.replaceWith(op.from, op.to, op.node);
    else tr.delete(op.from, op.to);
  }
  return ops.length;
}

export const AiDiffView = Extension.create({
  name: "aiDiffView",

  addCommands() {
    const run = (pick: (diff: NonNullable<AiDiffViewState>) => number[]) =>
      ({ state, tr, dispatch }: { state: EditorState; tr: Transaction; dispatch?: (tr: Transaction) => void }) => {
        const diff = aiDiffOf(state);
        if (!diff) return false;
        const indexes = pick(diff);
        if (indexes.length === 0) return false;
        if (!dispatch) return true;
        const count = revert(state, tr, diff, indexes);
        if (count === 0) return false;
        tr.setMeta(PRESERVE_AI_MARKS_META, true).setMeta(aiDiffKey, { type: "reverted", count } satisfies Meta);
        return true;
      };
    return {
      showAiDiff:
        ({ before }) =>
        ({ tr, dispatch }) => {
          if (!Array.isArray(before)) return false;
          if (dispatch) tr.setMeta(aiDiffKey, { type: "show", before: before as Block[] } satisfies Meta).setMeta("addToHistory", false);
          return true;
        },
      hideAiDiff:
        () =>
        ({ state, tr, dispatch }) => {
          if (!aiDiffOf(state)) return false;
          if (dispatch) tr.setMeta(aiDiffKey, { type: "hide" } satisfies Meta).setMeta("addToHistory", false);
          return true;
        },
      revertAiHunk: (index) => run((diff) => (diff.hunks[index] ? [index] : [])),
      keepOnlyAiHunk: (index) => run((diff) => (diff.hunks[index] ? diff.hunks.map((_hunk, at) => at).filter((at) => at !== index) : [])),
      revertAllAiHunks: () => run((diff) => diff.hunks.map((_hunk, at) => at)),
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin<AiDiffViewState>({
        key: aiDiffKey,
        state: {
          init: () => null,
          apply(tr, value, _old, next) {
            const meta = tr.getMeta(aiDiffKey) as Meta | undefined;
            if (meta?.type === "hide") return null;
            if (meta?.type === "show") return { before: meta.before, hunks: diffBlocks(meta.before, blocksOf(next.doc)), reverted: 0 };
            if (!value) return null;
            const reverted = value.reverted + (meta?.type === "reverted" ? meta.count : 0);
            if (!tr.docChanged) return reverted === value.reverted ? value : { ...value, reverted };
            return { before: value.before, hunks: diffBlocks(value.before, blocksOf(next.doc)), reverted };
          },
        },
        props: {
          decorations(state) {
            const diff = aiDiffOf(state);
            return diff ? decorations(editor, state, diff) : null;
          },
          // 表示中は読み取り専用（閉じたら元の editable に戻る。PageEditor の setEditable とぶつからない）
          editable: (state) => !aiDiffOf(state),
          handleKeyDown(view, event) {
            if (event.key !== "Escape" || !aiDiffOf(view.state)) return false;
            view.dispatch(view.state.tr.setMeta(aiDiffKey, { type: "hide" } satisfies Meta).setMeta("addToHistory", false));
            return true;
          },
        },
      }),
    ];
  },
});
