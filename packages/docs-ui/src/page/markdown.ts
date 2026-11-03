import { getSchema } from "@tiptap/core";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import MarkdownIt from "markdown-it";
import { MarkdownParser, MarkdownSerializer, type MarkdownSerializerState, type ParseSpec } from "prosemirror-markdown";
import { validateBlocks, type Block } from "./blocks";
import { CALLOUT_NODE_NAME } from "./callout";
import { buildMarkdownExtensions } from "./markdown-extensions";

/**
 * 限定 AST（blocks.ts）↔ Markdown。
 *
 * Mac（apps/docs）は本文の正本を保管庫の `pages/<id>.md` に Markdown で置く（Web の正本は Cloud SQL の blocks）。
 * 同じエディタを Mac に載せるために、ここで往復させる。**変換できないものは黙って捨てず、必ず断る**
 * （設計 §12・移行の対応表 §4「変換できない要素は取り込まずに報告する」）。
 *
 * - 読む: 対応外の記法は `{ ok: false }`。見出し 1・4 以下も断る（本文は 2・3 だけ）。
 * - 書く: 限定 AST の中だけを書き出す。画像（資産の id を持つ）は Markdown に置き場が無いので断る（#45 の相談の項目）。
 * - 囲み（`callout`）は Markdown に対応する記法が無いので、引用の中の `[!note]` の行で表す。旧い画面で開いても
 *   引用として読めるだけで、本文は欠けない。
 */

/** 囲みの目印（引用の最初の段落）。 */
const CALLOUT_MARKER = "[!note]";

/**
 * markdown-it の token と core rule の state の型（editor/markdown-it-types.ts と同じ取り出し方。
 * @types/markdown-it の版で root からの export が違うため、MarkdownIt の型から取る）。
 */
type Token = ReturnType<MarkdownIt["parse"]>[number];
type StateCore = Parameters<MarkdownIt["core"]["process"]>[0];

/**
 * 引用の最初の段落が目印だけなら、囲みの token に変える（目印の段落は落とす）。
 * **本文として打った `[!note]` は escape されて `\[!note\]` になる**ので、ここで囲みにはならない
 * （escape は parse のあとに解けるので、解けた文字では見分けられない。token の生の content で見る）。
 */
function calloutRule(state: StateCore): void {
  const tokens: Token[] = state.tokens;
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index]?.type !== "blockquote_open") continue;
    const marker = tokens[index + 2];
    if (tokens[index + 1]?.type !== "paragraph_open" || marker?.type !== "inline" || marker.content !== CALLOUT_MARKER) continue;
    if (tokens[index + 3]?.type !== "paragraph_close") continue;
    tokens[index]!.type = "callout_open";
    // 対応する閉じ（入れ子の引用・囲みを数える）
    let depth = 0;
    for (let close = index + 4; close < tokens.length; close++) {
      const type = tokens[close]!.type;
      if (type === "blockquote_open" || type === "callout_open") depth++;
      else if (type === "blockquote_close") {
        if (depth === 0) {
          tokens[close]!.type = "callout_close";
          break;
        }
        depth--;
      }
    }
    tokens.splice(index + 1, 3);
  }
}

/** GFM のチェック項目を専用 node にする。混在したリストは意味を失うので断る。 */
function taskListRule(state: StateCore): void {
  const all = state.tokens;
  for (let start = 0; start < all.length; start++) {
    if (all[start]?.type !== "bullet_list_open") continue;
    let depth = 0;
    const items: Array<{ open: Token; inline: Token; checked: boolean }> = [];
    let end = start + 1;
    for (; end < all.length; end++) {
      const token = all[end]!;
      if (token.type === "bullet_list_open") depth++;
      if (token.type === "bullet_list_close") {
        if (depth === 0) break;
        depth--;
      }
      if (depth !== 0 || token.type !== "list_item_open") continue;
      const inline = all.slice(end + 1).find((candidate) => candidate.type === "inline");
      if (!inline) continue;
      const match = /^\[([ xX])\](?:[ \t]+|$)/.exec(inline.content);
      if (match) items.push({ open: token, inline, checked: match[1]!.toLowerCase() === "x" });
    }
    if (items.length === 0) continue;
    const total = all.slice(start + 1, end).filter((token) => token.type === "list_item_open" && token.level === all[start]!.level + 1).length;
    if (items.length !== total) throw new Error("チェック項目と通常の箇条書きは同じリストに混在できません");
    all[start]!.type = "task_list_open";
    all[end]!.type = "task_list_close";
    for (const item of items) {
      item.open.type = "task_item_open";
      item.open.attrSet("checked", String(item.checked));
      const close = all.findIndex((token, index) => index > all.indexOf(item.open) && token.type === "list_item_close" && token.level === item.open.level);
      if (close >= 0) all[close]!.type = "task_item_close";
      const prefix = /^\[([ xX])\](?:[ \t]+|$)/.exec(item.inline.content)![0];
      item.inline.content = item.inline.content.slice(prefix.length);
      const first = item.inline.children?.[0];
      if (first?.type === "text") first.content = first.content.slice(prefix.length);
    }
  }
}

/** table のセルは TipTap schema 上で段落を一つ持つ。Markdown の inline token を段落で包む。 */
function tableCellsRule(state: StateCore): void {
  const all = state.tokens;
  for (let index = all.length - 1; index >= 0; index--) {
    const token = all[index]!;
    if (token.type !== "th_open" && token.type !== "td_open") continue;
    const inline = all[index + 1];
    if (inline?.type !== "inline") continue;
    const open = new state.Token("paragraph_open", "p", 1);
    const close = new state.Token("paragraph_close", "p", -1);
    all.splice(index + 1, 0, open);
    all.splice(index + 3, 0, close);
  }
}

/**
 * 限定 AST と同じ範囲だけの schema（エディタと同じ素から作る。画像は Markdown に置き場が無いので入れない）。
 * 画面の部品（React）に触れないので、サーバーからも読める。
 */
export const pageMarkdownSchema: Schema = getSchema(buildMarkdownExtensions());

const tokens: Record<string, ParseSpec> = {
  paragraph: { block: "paragraph" },
  blockquote: { block: "blockquote" },
  callout: { block: CALLOUT_NODE_NAME },
  bullet_list: { block: "bulletList" },
  ordered_list: {
    block: "orderedList",
    getAttrs: (token) => {
      const start = Number(token.attrGet("start") ?? 1);
      return Number.isSafeInteger(start) && start > 1 ? { start } : {};
    },
  },
  list_item: { block: "listItem" },
  task_list: { block: "taskList" },
  task_item: { block: "taskItem", getAttrs: (token) => ({ checked: token.attrGet("checked") === "true" }) },
  table: { block: "table" },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: "tableRow" },
  th: { block: "tableHeader", getAttrs: (token) => ({ align: /text-align:\s*(left|right|center)/.exec(token.attrGet("style") ?? "")?.[1] ?? null }) },
  td: { block: "tableCell", getAttrs: (token) => ({ align: /text-align:\s*(left|right|center)/.exec(token.attrGet("style") ?? "")?.[1] ?? null }) },
  fence: { block: "codeBlock", getAttrs: (token) => ({ language: token.info.trim() }) },
  code_block: { block: "codeBlock" },
  code_inline: { mark: "code" },
  s: { mark: "strike" },
  heading: { block: "heading", getAttrs: (token) => ({ level: Number(token.tag.slice(1)) }) },
  hr: { node: "horizontalRule" },
  hardbreak: { node: "hardBreak" },
  em: { mark: "italic" },
  strong: { mark: "bold" },
  link: { mark: "link", getAttrs: (token) => ({ href: token.attrGet("href") ?? "" }) },
};

// HTML は文字として扱い実行しない。表・打消し線は token として読む。
const markdownIt = MarkdownIt("commonmark", { html: false }).enable(["table", "strikethrough"]);
markdownIt.core.ruler.push("niho_page_callout", (state) => {
  calloutRule(state);
  taskListRule(state);
  tableCellsRule(state);
  return true;
});
const parser = new MarkdownParser(pageMarkdownSchema, markdownIt, tokens);

/** markdown-it が列数の違う行を切り捨てる前に拒否する。 */
function malformedTable(markdown: string): boolean {
  const lines = markdown.split(/\r?\n/);
  let fenced = false;
  const columns = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).length;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (/^(`{3,}|~{3,})/.test(line)) { fenced = !fenced; continue; }
    if (fenced || !/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line)) continue;
    const width = columns(line);
    if (!lines[index - 1] || columns(lines[index - 1]!) !== width) return true;
    for (let row = index + 1; row < lines.length && lines[row]!.trim(); row++) {
      if (columns(lines[row]!) !== width) return true;
    }
  }
  return false;
}

function inlineMark(open: string) {
  return { open, close: open, mixable: true, expelEnclosingWhitespace: true };
}

/** インラインコード中の最長 backtick より長い囲みを使う。内部に backtick があれば両端に空白も置く。 */
function codeDelimiter(node: ProseMirrorNode, side: "open" | "close"): string {
  const longest = Math.max(0, ...(node.text?.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  return longest === 0 ? ticks : side === "open" ? `${ticks} ` : ` ${ticks}`;
}

const serializer = new MarkdownSerializer(
  {
    paragraph(state: MarkdownSerializerState, node: ProseMirrorNode) {
      state.renderInline(node);
      state.closeBlock(node);
    },
    heading(state: MarkdownSerializerState, node: ProseMirrorNode) {
      state.write(`${state.repeat("#", Number(node.attrs.level))} `);
      state.renderInline(node);
      state.closeBlock(node);
    },
    bulletList(state: MarkdownSerializerState, node: ProseMirrorNode) {
      state.renderList(node, "  ", () => "- ");
    },
    orderedList(state: MarkdownSerializerState, node: ProseMirrorNode) {
      const start = Number(node.attrs.start ?? 1);
      const width = String(start + node.childCount - 1).length;
      state.renderList(node, state.repeat(" ", width + 2), (index) => {
        const label = String(start + index);
        return `${state.repeat(" ", width - label.length)}${label}. `;
      });
    },
    listItem(state: MarkdownSerializerState, node: ProseMirrorNode) {
      state.renderContent(node);
    },
    taskList(state: MarkdownSerializerState, node: ProseMirrorNode) {
      state.renderList(node, "  ", (index) => node.child(index).attrs.checked ? "- [x] " : "- [ ] ");
    },
    taskItem(state: MarkdownSerializerState, node: ProseMirrorNode) {
      state.renderContent(node);
    },
    table(state: MarkdownSerializerState, node: ProseMirrorNode) {
      const width = node.firstChild?.childCount ?? 0;
      if (width === 0 || node.firstChild?.firstChild?.type.name !== "tableHeader") throw new Error("Markdown の表には見出し行が必要です");
      node.forEach((row, _offset, rowIndex) => {
        if (row.childCount !== width) throw new Error("列数が異なる表は Markdown にできません");
        state.write("| ");
        row.forEach((cell, _cellOffset, column) => {
          const headerAlign = node.firstChild?.child(column).attrs.align ?? null;
          if ((rowIndex === 0 ? cell.type.name !== "tableHeader" : cell.type.name !== "tableCell") || cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1 || cell.attrs.colwidth !== null || cell.attrs.align !== headerAlign || cell.childCount !== 1 || cell.firstChild?.type.name !== "paragraph" || cell.firstChild.content.toJSON()?.some((part: { type: string }) => part.type === "hardBreak")) {
            throw new Error("結合セル・列幅・行ごとに異なる配置・複数段落・改行を含む表は Markdown にできません");
          }
          const cellDoc = pageMarkdownSchema.node("doc", null, [cell.firstChild]);
          state.write(serializer.serialize(cellDoc).trimEnd().replace(/(?<!\\)\|/g, "\\|"));
          state.write(" | ");
        });
        state.write("\n");
        if (rowIndex === 0) state.write(`| ${Array.from({ length: width }, (_, column) => {
          const align = row.child(column).attrs.align;
          return align === "center" ? ":---:" : align === "right" ? "---:" : align === "left" ? ":---" : "---";
        }).join(" | ")} |\n`);
      });
      state.closeBlock(node);
    },
    tableRow() {},
    tableCell() {},
    tableHeader() {},
    codeBlock(state: MarkdownSerializerState, node: ProseMirrorNode) {
      const content = node.textContent;
      const fence = "`".repeat(Math.max(3, ...(content.match(/`+/g) ?? []).map((run) => run.length + 1)));
      state.write(`${fence}${node.attrs.language ?? ""}\n${content}${content.endsWith("\n") ? "" : "\n"}${fence}`);
      state.closeBlock(node);
    },
    blockquote(state: MarkdownSerializerState, node: ProseMirrorNode) {
      state.wrapBlock("> ", null, node, () => state.renderContent(node));
    },
    [CALLOUT_NODE_NAME](state: MarkdownSerializerState, node: ProseMirrorNode) {
      state.wrapBlock("> ", null, node, () => {
        state.write(CALLOUT_MARKER);
        state.closeBlock(node);
        state.renderContent(node);
      });
    },
    horizontalRule(state: MarkdownSerializerState, node: ProseMirrorNode) {
      state.write("---");
      state.closeBlock(node);
    },
    hardBreak(state: MarkdownSerializerState, node: ProseMirrorNode, parent: ProseMirrorNode, index: number) {
      for (let after = index + 1; after < parent.childCount; after++) {
        if (parent.child(after).type !== node.type) {
          state.write("\\\n");
          return;
        }
      }
    },
    text(state: MarkdownSerializerState, node: ProseMirrorNode) {
      // escape する（prosemirror-markdown の既定）。`a * b`・バックティック・`[`・行頭の `-` `#` をそのまま書くと、
      // 読み直しで斜体・コードになったり（コードは限定 AST の外なのでページが開けなくなる）、箇条書きに化ける
      state.text(node.text ?? "");
    },
  },
  {
    bold: inlineMark("**"),
    italic: inlineMark("*"),
    strike: inlineMark("~~"),
    code: {
      open: (_state, _mark, parent, index) => codeDelimiter(parent.child(index), "open"),
      close: (_state, _mark, parent, index) => codeDelimiter(parent.child(index - 1), "close"),
      escape: false,
    },
    link: {
      open: "[",
      close(state: MarkdownSerializerState, mark) {
        return `](${state.esc(String(mark.attrs.href ?? ""))})`;
      },
    },
  },
);

export type MarkdownToBlocks = { ok: true; blocks: Block[] } | { ok: false; reason: string };
export type BlocksToMarkdown = { ok: true; markdown: string } | { ok: false; reason: string };

/**
 * Markdown を限定 AST の blocks にする。対応外の記法（画像・見出し 1 と 4 以下など）があれば断る。
 * 空の本文は空の配列（エディタは空の段落 1 つを置く）。
 */
export function markdownToBlocks(markdown: string): MarkdownToBlocks {
  if (markdown.trim().length === 0) return { ok: true, blocks: [] };
  if (malformedTable(markdown)) return { ok: false, reason: "表の列数が揃っていません" };
  let doc: ProseMirrorNode | null;
  try {
    doc = parser.parse(markdown);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Markdown を読めませんでした" };
  }
  if (doc === null) return { ok: false, reason: "Markdown を読めませんでした" };
  const json = doc.toJSON() as { content?: unknown[] };
  // 保存してよい形だけで組み直す（見出しの深さ・リンクの scheme・入れ子の深さはここで断られる）
  return validateBlocks(json.content ?? []);
}

/** 限定 AST の blocks を Markdown にする。Markdown に置き場の無いもの（画像・録音）があれば断る。 */
export function blocksToMarkdown(blocks: readonly Block[]): BlocksToMarkdown {
  if (blocks.length === 0) return { ok: true, markdown: "" };
  const checked = validateBlocks(blocks);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  let doc: ProseMirrorNode;
  try {
    doc = pageMarkdownSchema.nodeFromJSON({ type: "doc", content: checked.blocks });
    doc.check();
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "本文を読めませんでした" };
  }
  try {
    return { ok: true, markdown: serializer.serialize(doc, { tightLists: true }) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "本文を Markdown にできませんでした" };
  }
}
