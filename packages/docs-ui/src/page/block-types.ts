import type { Editor, Range } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection, type EditorState } from "@tiptap/pm/state";
import { matchesSlashQuery } from "../lib/block-editor/blocks";
import type { ShellIconName } from "../shell/types";

/**
 * 本文のブロックの種類（「/」と「＋」のブロックの一覧、書式の帯の「行の種類」で共有する）。
 * 限定 AST（blocks.ts）とこのエディタの schema（page-extensions.ts）で作れるものだけを並べる。
 * 見出し 1・録音・音声ファイルは出さない（録音は作る手段がまだ無い）。
 * 画像（#33）はファイル選択を開く（選んだ画像を private bucket に入れてから、その行に入れる）。
 */

export type BlockChoiceId = "paragraph" | "h2" | "h3" | "bullet" | "task" | "ordered" | "quote" | "callout" | "hr" | "image" | "table" | "codeBlock";
/** 行の種類（区切り線・画像・表・コードブロックは行の種類ではないので除く）。 */
export type LineTypeId = Exclude<BlockChoiceId, "hr" | "image" | "table" | "codeBlock">;

export type BlockChoice = {
  id: BlockChoiceId;
  label: string;
  /** docs-ui の Icon に絵の無いもの（引用）は持たない。 */
  icon?: ShellIconName;
  /** 行頭に打つ書き始め（一覧の右に小さく出す。「/」のあとにそのまま打っても絞れる）。 */
  hint: string;
  /** 絞り込みの別名（英語・ローマ字・かな）。 */
  aliases: readonly string[];
};

export const BLOCK_CHOICES: readonly BlockChoice[] = [
  { id: "paragraph", label: "テキスト", icon: "type", hint: "", aliases: ["text", "paragraph", "tekisuto", "てきすと"] },
  { id: "h2", label: "見出し 2", icon: "h", hint: "##", aliases: ["h2", "heading", "midashi", "みだし", "見出し2"] },
  { id: "h3", label: "見出し 3", icon: "h", hint: "###", aliases: ["h3", "heading", "midashi", "みだし", "見出し3"] },
  { id: "bullet", label: "箇条書き", icon: "list", hint: "-", aliases: ["bullet", "list", "ul", "kajougaki", "risuto", "りすと", "かじょうがき"] },
  { id: "task", label: "チェックリスト", hint: "- [ ]", aliases: ["task", "check", "checklist", "todo", "checklist", "ちぇっく", "チェック"] },
  { id: "ordered", label: "番号付き", icon: "list", hint: "1.", aliases: ["number", "numbered", "ordered", "list", "ol", "bangou", "ばんごう", "番号"] },
  { id: "quote", label: "引用", hint: ">", aliases: ["quote", "blockquote", "inyou", "いんよう"] },
  // ローマ字は「kakoi」。「kakomi」にすると「mi」を含むので /mi（見出し）に混ざる（別名は部分一致なので「kako」で当たる）
  { id: "callout", label: "囲み", hint: "", aliases: ["callout", "note", "box", "aside", "kakoi", "かこみ", "囲い", "メモ", "補足"] },
  { id: "hr", label: "区切り線", icon: "minus", hint: "---", aliases: ["divider", "hr", "line", "rule", "kugiri", "くぎり", "くぎりせん"] },
  { id: "image", label: "画像", icon: "img", hint: "", aliases: ["image", "img", "photo", "picture", "gazou", "がぞう", "しゃしん", "写真"] },
  { id: "table", label: "表", hint: "", aliases: ["table", "grid", "hyō", "hyou", "ひょう", "表"] },
  { id: "codeBlock", label: "コードブロック", hint: "```", aliases: ["code", "codeblock", "fence", "コード", "こーど"] },
];

export const LINE_TYPE_CHOICES: readonly (BlockChoice & { id: LineTypeId })[] = BLOCK_CHOICES.filter(
  (choice): choice is BlockChoice & { id: LineTypeId } => choice.id !== "hr" && choice.id !== "image" && choice.id !== "table" && choice.id !== "codeBlock",
);

/** 「/」のあとに打った文字で絞る（docs-ui の「/」と同じ規則: 名前・別名に含む、または書き始めと一致。全角・大文字も同じに扱う）。 */
export function filterBlockChoices(query: string): BlockChoice[] {
  return BLOCK_CHOICES.filter((choice) => matchesSlashQuery({ name: choice.label, aliases: choice.aliases, hint: choice.hint }, query));
}

/** 選択のある行の種類（区切り線などのノードを選んでいるときは null）。 */
export function lineTypeOf(state: EditorState): LineTypeId | null {
  const { selection } = state;
  if (selection instanceof NodeSelection) return null;
  const { $from } = selection;
  if ($from.parent.type.name === "heading") return $from.parent.attrs.level === 3 ? "h3" : "h2";
  for (let depth = $from.depth - 1; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === "blockquote") return "quote";
    if (node.type.name === "callout") return "callout";
    if (node.type.name === "listItem") return $from.node(depth - 1).type.name === "orderedList" ? "ordered" : "bullet";
    if (node.type.name === "taskItem") return "task";
  }
  return "paragraph";
}

/**
 * 書式の帯の「行の種類」: 選んだ行を、その種類にする（切り替えではなく「その種類にする」。すでにその種類なら変えない）。
 * 行の中の太字・斜体・リンクは残す。リストの項目を見出しにするときは、リストから出す（項目の先頭は段落だけ）。
 */
export function setLineType(editor: Editor, id: LineTypeId): boolean {
  const chain = editor.chain().focus();
  switch (id) {
    case "paragraph":
      // 見出しは段落に、リスト・引用からは出す
      return chain.clearNodes().run();
    case "h2":
    case "h3": {
      const level = id === "h2" ? 2 : 3;
      // 同じ見出しに setHeading すると、TipTap は「変えられない」とみなしてリスト・引用から出してしまう
      if (editor.isActive("heading", { level })) return chain.run();
      return chain.setHeading({ level }).run();
    }
    case "bullet":
      return editor.isActive("bulletList") ? chain.run() : chain.toggleBulletList().run();
    case "task":
      return editor.isActive("taskList") ? chain.run() : chain.toggleTaskList().run();
    case "ordered":
      return editor.isActive("orderedList") ? chain.run() : chain.toggleOrderedList().run();
    case "quote":
      if (editor.isActive("blockquote")) return chain.run();
      // リストの項目の中だけを包むと項目の先頭が段落でなくなるので、包めないときは先に段落へ戻す
      return chain
        .command(({ can, commands }) => can().setBlockquote() || commands.clearNodes())
        .setBlockquote()
        .run();
    case "callout":
      if (editor.isActive("callout")) return chain.run();
      // 引用と同じ: 包めないときは先に段落へ戻す
      return chain
        .command(({ can, commands }) => can().setCallout() || commands.clearNodes())
        .setCallout()
        .run();
  }
}

/** 空の行（本文の直下の段落・見出しで、range の外が空白だけ）の位置。そうでなければ null。 */
export type BlankLine = { pos: number; start: number; end: number };

function isLineNode(node: ProseMirrorNode): boolean {
  return node.type.name === "paragraph" || node.type.name === "heading";
}

/**
 * range（「/」と絞り込みの文字）を除くと空白だけの、本文の直下の行か。
 * リスト・引用の中の行は対象にしない（項目の先頭を見出しにはできないなど、限定 AST の形を壊さないため）。
 */
export function blankLineAround(doc: ProseMirrorNode, range: Range): BlankLine | null {
  if (range.from < 0 || range.to > doc.content.size || range.from > range.to) return null;
  const $from = doc.resolve(range.from);
  if ($from.depth !== 1 || !isLineNode($from.parent)) return null;
  const start = $from.start();
  const end = $from.end();
  if (range.to > end) return null;
  // 改行などの葉は空白とみなさない（"￼" で数える）
  const rest = doc.textBetween(start, range.from, undefined, "￼") + doc.textBetween(range.to, end, undefined, "￼");
  if (!/^\s*$/u.test(rest)) return null;
  return { pos: $from.before(), start, end };
}

/** pos（本文の直下のノードの前）が、空の段落か。「＋」を出す行。 */
export function isEmptyParagraphAt(doc: ProseMirrorNode, pos: number): boolean {
  if (pos < 0 || pos >= doc.content.size) return false;
  const $pos = doc.resolve(pos);
  const node = $pos.nodeAfter;
  return $pos.depth === 0 && node !== null && node.type.name === "paragraph" && node.childCount === 0;
}

/** 「＋」を出すか: 書ける状態で、本文にフォーカスがあり、カーソルが本文の直下の空の段落にある。 */
export function addButtonVisible(state: EditorState, editable: boolean, focused: boolean): boolean {
  const { selection } = state;
  if (!editable || !focused || !selection.empty || selection.$anchor.depth !== 1) return false;
  return isEmptyParagraphAt(state.doc, selection.$anchor.before());
}

/**
 * 空の行を、選んだブロックにする（「/」と「＋」）。
 * - 「/」: `range` に「/」と絞り込みの文字を渡す。行の中身（空白だけ）ごと消してから変える。
 * - 「＋」: `at` に空の段落の位置を渡す。
 * どちらも、行が空でなくなっていたら（別の操作で変わったら）何もしない。消すのと変えるのは 1 回の取引にまとめる。
 */
export function fillBlankLine(editor: Editor, id: BlockChoiceId, target: { range: Range } | { at: number }): boolean {
  const { doc, schema } = editor.state;
  let line: BlankLine | null;
  if ("range" in target) {
    line = blankLineAround(doc, target.range);
  } else {
    line = isEmptyParagraphAt(doc, target.at) ? { pos: target.at, start: target.at + 1, end: target.at + 1 } : null;
  }
  if (!line) return false;
  const { pos, start, end } = line;
  const paragraph = schema.nodes.paragraph!;
  const heading = schema.nodes.heading!;

  const chain = editor
    .chain()
    .focus()
    .command(({ tr }) => {
      if (end > start) tr.delete(start, end);
      // 見出しの空の行で、見出し以外を選んだら段落に戻してから包む
      const node = tr.doc.nodeAt(pos);
      if (node && node.type !== paragraph && id !== "h2" && id !== "h3") tr.setNodeMarkup(pos, paragraph);
      tr.setSelection(TextSelection.create(tr.doc, pos + 1));
      return true;
    });

  switch (id) {
    case "paragraph":
      return chain.run();
    case "h2":
    case "h3":
      return chain
        .command(({ tr }) => {
          tr.setNodeMarkup(pos, heading, { level: id === "h2" ? 2 : 3 });
          return true;
        })
        .run();
    case "bullet":
      return chain.toggleBulletList().run();
    case "task":
      return chain.toggleTaskList().run();
    case "ordered":
      return chain.toggleOrderedList().run();
    case "quote":
      return chain.setBlockquote().run();
    case "callout":
      return chain.setCallout().run();
    case "hr":
      // 空の段落を区切り線に置き換え、次の行（無ければ空の段落を足す）へカーソルを移す
      return chain.setHorizontalRule().run();
    case "image":
      // 行は空の段落のままにして、ファイル選択を開く（選んだ画像はアップロードが済んでから、この行に入る）。
      // 画像の口・ページが無ければ false（画像のノードが理由を本文の下に出す）
      return chain.command(({ commands }) => (typeof commands.choosePageImage === "function" ? commands.choosePageImage() : false)).run();
    case "table":
      return chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    case "codeBlock":
      return chain.setCodeBlock().run();
  }
}

/**
 * ⌘/（ブロックの一覧）で、いまの行を変えずに足す位置: カーソルのある本文の直下のブロック（リスト・引用なら全体）の後ろ。
 * いまの行が本文の直下の空の段落なら、その行を変える（「＋」と同じ）ので null。
 */
export function blankLineAfterCursor(state: EditorState): number | null {
  const { selection, doc } = state;
  const { $anchor } = selection;
  if (selection.empty && $anchor.depth === 1 && isEmptyParagraphAt(doc, $anchor.before())) return null;
  return $anchor.depth >= 1 ? $anchor.after(1) : selection.to;
}

/** 本文の直下の at（ブロックの境目）に空の段落を足す（このあと fillBlankLine で変える。同じ Undo のまとまりになる）。境目でなければ何もしない。 */
export function insertBlankLine(editor: Editor, at: number): boolean {
  const { doc, schema, tr } = editor.state;
  if (at < 0 || at > doc.content.size || doc.resolve(at).depth !== 0) return false;
  editor.view.dispatch(tr.insert(at, schema.nodes.paragraph!.create()));
  return true;
}
