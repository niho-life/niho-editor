import type { Block } from "@niho/editor-store";
import { diffWords, type DiffPart } from "./diff";

/**
 * 直す前と後のブロックの差分（AI と作る。設計 idea/active/2026-11-05-ai-composer-design.md）。
 *
 * - サーバー: AI の道具が保存する本文の、足した語だけに `ai` mark を付ける（`markAiInserted`）。
 * - 画面: 「変更を見る」でブロックごとの語の差分を出す（`diffBlocks`）。
 *
 * 純粋な関数だけ（DOM・Node の API を使わない）。ブラウザとサーバーの両方で読む。
 */

/** 対応付けの結果。`same` は type・attrs・平文が同じ、`changed` は対にしたが違うもの。 */
export type BlockPair =
  | { kind: "same" | "changed"; beforeIndex: number; afterIndex: number }
  | { kind: "inserted"; afterIndex: number }
  | { kind: "deleted"; beforeIndex: number };

/** 画面の「変更を見る」の単位。`parts` は type が同じ葉のテキスト容器の語の差分（それ以外は null＝全体が変わった）。 */
export type BlockHunk =
  | { kind: "changed"; beforeIndex: number; afterIndex: number; parts: DiffPart[] | null }
  | { kind: "inserted"; afterIndex: number }
  | { kind: "deleted"; beforeIndex: number; block: Block };

/** ブロックの数の LCS の上限（400 × 400。超えたら位置が同じものだけを対にする）。 */
export const MAX_BLOCK_LCS_CELLS = 400 * 400;

const AI = "ai";

/** 行の中身（text・hardBreak）を直に持つブロック。 */
const LEAF_TYPES: ReadonlySet<string> = new Set(["paragraph", "heading", "codeBlock"]);

type Mark = { type: string; attrs?: unknown };

function typeOf(block: Block): string {
  return typeof block.type === "string" ? block.type : "";
}

function contentOf(block: Block): Block[] {
  return Array.isArray(block.content) ? (block.content as Block[]) : [];
}

function marksOf(node: Block): Mark[] {
  return Array.isArray(node.marks) ? (node.marks as Mark[]) : [];
}

function isLeaf(block: Block): boolean {
  return LEAF_TYPES.has(typeOf(block));
}

/** 子のブロックを持つもの（箇条書き・引用・囲み・表とその行・項目・セル）。 */
function isContainer(block: Block): boolean {
  if (isLeaf(block)) return false;
  const content = contentOf(block);
  return content.length > 0 && content.every((child) => typeOf(child) !== "text" && typeOf(child) !== "hardBreak");
}

/** ブロックの平文。葉は行の中の文字（改行は "\n"）、容器は子を改行でつなぐ。画像・録音・区切り線は空。 */
export function blockText(block: Block): string {
  if (isLeaf(block)) {
    return contentOf(block)
      .map((inline) => (typeOf(inline) === "text" ? String(inline.text ?? "") : typeOf(inline) === "hardBreak" ? "\n" : ""))
      .join("");
  }
  if (isContainer(block)) return contentOf(block).map(blockText).join("\n");
  return "";
}

/** 鍵の順に依らない JSON（Markdown の往復で attrs の鍵の順が変わっても同じ値にする）。 */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function anchorKey(block: Block): string {
  return `${typeOf(block)}\u0000${stable(block.attrs ?? null)}\u0000${blockText(block)}`;
}

/** anchor の間に残ったブロックを順に対にする（数は min。余りは消した・足した）。 */
function pairGap(pairs: BlockPair[], before: number[], after: number[]): void {
  const count = Math.min(before.length, after.length);
  for (let index = 0; index < count; index++) pairs.push({ kind: "changed", beforeIndex: before[index]!, afterIndex: after[index]! });
  for (const beforeIndex of before.slice(count)) pairs.push({ kind: "deleted", beforeIndex });
  for (const afterIndex of after.slice(count)) pairs.push({ kind: "inserted", afterIndex });
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, index) => from + index);
}

/**
 * トップレベル（または同じ容器の子）のブロックを対応付ける。まず type・attrs・平文が同じものを LCS で anchor にし、
 * anchor の間の残りは順に対にする。大きすぎるときは位置が同じものだけを対にする。
 */
export function alignBlocks(before: readonly Block[], after: readonly Block[]): BlockPair[] {
  const a = before.map(anchorKey);
  const b = after.map(anchorKey);
  const n = a.length;
  const m = b.length;
  const pairs: BlockPair[] = [];
  if (n * m > MAX_BLOCK_LCS_CELLS) {
    const count = Math.min(n, m);
    for (let index = 0; index < count; index++) {
      pairs.push({ kind: a[index] === b[index] ? "same" : "changed", beforeIndex: index, afterIndex: index });
    }
    pairGap(pairs, range(count, n), range(count, m));
    return pairs;
  }
  const width = m + 1;
  // n, m ≦ 400 なので長さは Uint16 に収まる
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  let gapBefore: number[] = [];
  let gapAfter: number[] = [];
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairGap(pairs, gapBefore, gapAfter);
      gapBefore = [];
      gapAfter = [];
      pairs.push({ kind: "same", beforeIndex: i, afterIndex: j });
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      gapBefore.push(i++);
    } else {
      gapAfter.push(j++);
    }
  }
  pairGap(pairs, [...gapBefore, ...range(i, n)], [...gapAfter, ...range(j, m)]);
  return pairs;
}

/** 画面の「変更を見る」の差分（変わらないブロックは返さない）。 */
export function diffBlocks(before: readonly Block[], after: readonly Block[]): BlockHunk[] {
  const hunks: BlockHunk[] = [];
  for (const pair of alignBlocks(before, after)) {
    if (pair.kind === "same") continue;
    if (pair.kind === "inserted") hunks.push(pair);
    else if (pair.kind === "deleted") hunks.push({ kind: "deleted", beforeIndex: pair.beforeIndex, block: before[pair.beforeIndex]! });
    else {
      const was = before[pair.beforeIndex]!;
      const now = after[pair.afterIndex]!;
      const parts = typeOf(was) === typeOf(now) && isLeaf(was) ? diffWords(blockText(was), blockText(now)) : null;
      hunks.push({ kind: "changed", beforeIndex: pair.beforeIndex, afterIndex: pair.afterIndex, parts });
    }
  }
  return hunks;
}

function hasAi(marks: readonly Mark[]): boolean {
  return marks.some((mark) => mark.type === AI);
}

function withAi(marks: readonly Mark[]): Mark[] {
  return hasAi(marks) ? [...marks] : [...marks, { type: AI }];
}

function withMarks(node: Block, marks: readonly Mark[]): Block {
  const rest: Record<string, unknown> = { ...node };
  delete rest.marks;
  return marks.length > 0 ? { ...rest, marks } : rest;
}

/** 中の全 text に `ai` を付ける（足したブロック）。 */
function markAll(block: Block): Block {
  if (typeOf(block) === "text") return withMarks(block, withAi(marksOf(block)));
  if (!Array.isArray(block.content)) return block;
  return { ...block, content: contentOf(block).map(markAll) };
}

/** 前のブロックの文字ごとの `ai` の有無（容器は子を "\n" でつなぐ。区切りの "\n" は持たない）。 */
function aiFlags(block: Block): boolean[] {
  if (isLeaf(block)) {
    const flags: boolean[] = [];
    for (const inline of contentOf(block)) {
      if (typeOf(inline) === "text") {
        const ai = hasAi(marksOf(inline));
        for (let index = 0; index < String(inline.text ?? "").length; index++) flags.push(ai);
      } else if (typeOf(inline) === "hardBreak") flags.push(false);
    }
    return flags;
  }
  if (isContainer(block)) {
    const flags: boolean[] = [];
    contentOf(block).forEach((child, index) => {
      if (index > 0) flags.push(false);
      flags.push(...aiFlags(child));
    });
    return flags;
  }
  return [];
}

type Unit = { kind: "text"; ch: string; marks: Mark[] } | { kind: "break"; node: Block };

/** 葉の行の中身を、変更の後の文字ごとに `ai` を付け直す（足した語は `ai`、変わらない語は前の `ai` を引き継ぐ）。 */
function mergeLeaf(before: Block, after: Block): Block {
  const units: Unit[] = [];
  for (const inline of contentOf(after)) {
    if (typeOf(inline) === "text") {
      const marks = marksOf(inline);
      for (const ch of String(inline.text ?? "").split("")) units.push({ kind: "text", ch, marks });
    } else units.push({ kind: "break", node: inline });
  }
  if (units.length === 0) return after;
  const beforeAi = aiFlags(before);
  const ai: boolean[] = new Array<boolean>(units.length).fill(false);
  let at = 0;
  let from = 0;
  for (const part of diffWords(blockText(before), blockText(after))) {
    if (typeof part === "string") {
      for (let index = 0; index < part.length; index++) ai[at + index] = beforeAi[from + index] === true;
      at += part.length;
      from += part.length;
    } else if ("ins" in part) {
      for (let index = 0; index < part.ins.length; index++) ai[at + index] = true;
      at += part.ins.length;
    } else from += part.del.length;
  }
  const content: Block[] = [];
  let run: { text: string; marks: Mark[]; key: string } | null = null;
  const flush = () => {
    if (run) content.push(withMarks({ type: "text", text: run.text }, run.marks));
    run = null;
  };
  units.forEach((unit, index) => {
    if (unit.kind === "break") {
      flush();
      content.push(unit.node);
      return;
    }
    const marks = ai[index] ? withAi(unit.marks) : unit.marks;
    const key = stable(marks);
    if (run && run.key === key) run.text += unit.ch;
    else {
      flush();
      run = { text: unit.ch, marks, key };
    }
  });
  flush();
  return { ...after, content };
}

/** 対にした 2 つのブロックを、変更の後の形で `ai` を付け直す。 */
function mergeBlock(before: Block, after: Block): Block {
  if (isLeaf(after)) return mergeLeaf(before, after);
  if (isContainer(after)) {
    return { ...after, content: mergeList(isContainer(before) ? contentOf(before) : [before], contentOf(after)) };
  }
  // 画像・録音・区切り線（行の中身が無い）はそのまま
  return after;
}

function mergeList(before: readonly Block[], after: readonly Block[]): Block[] {
  const out: Block[] = [...after];
  for (const pair of alignBlocks(before, after)) {
    if (pair.kind === "deleted") continue;
    if (pair.kind === "inserted") out[pair.afterIndex] = markAll(after[pair.afterIndex]!);
    else out[pair.afterIndex] = mergeBlock(before[pair.beforeIndex]!, after[pair.afterIndex]!);
  }
  return out;
}

/**
 * `after` に、足した文字だけ `ai` mark を付けて返す。足したブロックは中の全部、直したブロックは足した語だけ。
 * 変わらない文字は `before` の同じ位置の `ai` を引き継ぐ（AI の道具は Markdown で読み書きし、往復で `ai` が落ちるため）。
 */
export function markAiInserted(before: readonly Block[], after: readonly Block[]): Block[] {
  return mergeList(before, after);
}

/**
 * `ai` mark を外し、それで隣り合った同じ mark の text を 1 つにまとめる（翻訳など、印の要らない経路の前処理）。
 * `ai` の無い本文は同じ形のまま返る。
 */
export function stripAiMarks(blocks: readonly Block[]): Block[] {
  const strip = (node: Block): Block => {
    let out: Block = node;
    if (Array.isArray(node.marks) && hasAi(marksOf(node))) out = withMarks(node, marksOf(node).filter((mark) => mark.type !== AI));
    if (!Array.isArray(node.content)) return out;
    const content: Block[] = [];
    for (const child of contentOf(node).map(strip)) {
      const last = content.at(-1);
      if (last && typeOf(last) === "text" && typeOf(child) === "text" && stable(marksOf(last)) === stable(marksOf(child)) && Object.keys(last).length === Object.keys(child).length) {
        content[content.length - 1] = { ...last, text: String(last.text ?? "") + String(child.text ?? "") };
      } else content.push(child);
    }
    return { ...out, content };
  };
  return blocks.map(strip);
}
