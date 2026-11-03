import { hasAbout, type About, type GlossaryEntry } from "@niho/docs-core";
import type { Block, Page } from "@niho/editor-store";
import { validateBlocks, type AstResult } from "../ast/blocks";
import { diffWords, type DiffPart } from "./diff";
import type { AiInsertKind, AiOutput, AiParagraph, AiRequest } from "./model";
import { intentLabel, intentMode, type AiIntent } from "./presets";

/**
 * AI の提案エンジン（設計 §6・Issue #38）。ページを書き換えず、提案を返すだけ。保存は採用のときだけ（ai-api.ts）。
 *
 * 本文 → 段落の一覧（buildRequest）→ モデル → 構造化出力の検証（parseAiOutput）→ 提案（buildProposal）→ 採用の適用（applyAdoptions）。
 *
 * - 編集の対象は最上位の paragraph と heading だけ。箇条書き・引用・囲み・画像などは文脈として送るだけ。
 * - ブロックに安定した id は無いので、段落は最上位の配列の位置（index）で指す。
 * - 変更した段落の太字・斜体・リンクは外れてプレーンテキストになる（v1 の制限）。変更しない段落には触れない。
 */

export type { DiffPart };

/**
 * 1 回の要求に入れる本文の目安（文字）。超えたら段落の切れ目で次の要求に分ける。日本語は 1 字 1〜1.5 トークンなので、
 * 1 回の出力が数千トークンに収まり、1 回の呼び出しの時間切れ（既定 120 秒）の中で終わる大きさにしている。
 */
export const MAX_REQUEST_CHARS = 4_000;
/** 1 回の提案で送る本文の上限（文字）。超えたら 413 `too_large`（範囲を選んで頼む）。分けた要求は約 8 回まで（Cloud Run の 300 秒の中）。 */
export const MAX_PAGE_CHARS = 30_000;
/** モデルが返す 1 つの文の上限（文字）。 */
export const MAX_OUTPUT_TEXT_CHARS = 20_000;
/** モデルの 1 回の出力の件数（edits と inserts の合計）の上限。 */
export const MAX_OUTPUT_ITEMS = 200;

const INSERT_KINDS: readonly AiInsertKind[] = ["paragraph", "heading", "callout"];

export type AiScope = { fromIndex: number; toIndex: number };

export type ProposalChange = { index: number; before: string; after: string; parts: DiffPart[] };
export type ProposalInsert = { afterIndex: number; kind: AiInsertKind; text: string };

export type Proposal = {
  label: string;
  baseRevision: number;
  changes: ProposalChange[];
  inserts: ProposalInsert[];
  /** 送った編集できる段落のうち、変更の無いものの数。 */
  unchanged: number;
};

/** 採用するものだけ（index・afterIndex は今の本文の位置）。 */
export type Adoptions = {
  changes: { index: number; text: string }[];
  inserts: ProposalInsert[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 文字数（code point。サロゲートペアの絵文字も 1 文字）。 */
function countChars(text: string): number {
  return Array.from(text).length;
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isEditableBlock(block: Block | undefined): boolean {
  return block?.type === "paragraph" || block?.type === "heading";
}

function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((node: unknown) => {
      if (!isPlainObject(node)) return "";
      if (node.type === "hardBreak") return "\n";
      return node.type === "text" && typeof node.text === "string" ? node.text : "";
    })
    .join("");
}

/** 文脈のブロックの文字（入れ子の段落を改行でつなぐ。画像は代替の文字だけ）。 */
function contextText(block: unknown): string {
  if (!isPlainObject(block)) return "";
  if (block.type === "paragraph" || block.type === "heading") return inlineText(block.content);
  if (block.type === "image") {
    const attrs = isPlainObject(block.attrs) ? block.attrs : {};
    return typeof attrs.alt === "string" ? attrs.alt : "";
  }
  if (!Array.isArray(block.content)) return "";
  return block.content
    .map((child: unknown) => contextText(child))
    .filter((text) => text.length > 0)
    .join("\n");
}

/** 段落・見出しの文字（改行は `\n`）。それ以外のブロックは文脈の文字。 */
export function blockText(block: Block): string {
  return isEditableBlock(block) ? inlineText(block.content) : contextText(block);
}

export type RequestPlan = { ok: true; requests: AiRequest[] } | { ok: false; error: "bad_scope" | "too_large" };

/**
 * 設定（#108）と周りのページから来る、要求ごとに同じ値。`glossary` は固有名詞と誤りやすい表記、
 * `lang` は提案の言語（無ければ本文の言語）、`about` は「あなたについて」、`references` は自動参考ページ。
 */
export type AiPreferences = {
  glossary?: readonly GlossaryEntry[];
  lang?: AiRequest["lang"];
  about?: About;
  references?: readonly { title: string; text: string }[];
};

/**
 * ページ（または選択した範囲。`toIndex` を含む）からモデルへの要求を作る。編集できる段落は空でも送り、文脈のブロックは文字のあるものだけ送る。
 * 段落の切れ目で 1 回あたり約 MAX_REQUEST_CHARS 文字に分ける（1 つの段落がそれより長いときは、その段落だけで 1 回）。
 * 送る文字の合計が MAX_PAGE_CHARS を超えたら `too_large`。範囲が本文の外なら `bad_scope`。
 * 固有名詞と提案の言語は設定から（`preferences`。渡さなければ語彙なし・本文の言語のまま）。
 */
export function buildRequest(
  page: Pick<Page, "blocks" | "lang">,
  intent: AiIntent,
  scope?: AiScope,
  preferences: AiPreferences = {},
): RequestPlan {
  const blocks = page.blocks;
  let from = 0;
  let to = blocks.length - 1;
  if (scope) {
    if (!isIndex(scope.fromIndex) || !isIndex(scope.toIndex)) return { ok: false, error: "bad_scope" };
    if (scope.fromIndex < 0 || scope.fromIndex > scope.toIndex || scope.toIndex >= blocks.length) return { ok: false, error: "bad_scope" };
    from = scope.fromIndex;
    to = scope.toIndex;
  }
  const paragraphs: AiParagraph[] = [];
  let total = 0;
  for (let index = from; index <= to; index++) {
    const block = blocks[index]!;
    const kind = block.type === "paragraph" ? "paragraph" : block.type === "heading" ? "heading" : "context";
    const text = blockText(block);
    if (kind === "context" && text.length === 0) continue;
    total += countChars(text);
    if (total > MAX_PAGE_CHARS) return { ok: false, error: "too_large" };
    paragraphs.push({ index, kind, text });
  }
  const requests: AiRequest[] = [];
  // 語彙は要求をまたいで同じ配列を渡さない（モデルの呼び出し側が書き換えても他の要求に影響しない）
  const glossary = (preferences.glossary ?? []).map((entry) => ({ ...entry, variants: [...entry.variants] }));
  let current: AiParagraph[] = [];
  let size = 0;
  // 「あなたについて」と参考は、分けた要求のどれにも同じものを付ける（どの要求も同じ文脈で書く）
  const about = preferences.about;
  const references = (preferences.references ?? []).map((reference) => ({ ...reference }));
  const flush = () => {
    if (current.length > 0) {
      requests.push({
        intent,
        paragraphs: current,
        glossary,
        lang: preferences.lang ?? page.lang,
        ...(about && hasAbout(about) ? { about: { ...about } } : {}),
        ...(references.length > 0 ? { references: references.map((reference) => ({ ...reference })) } : {}),
      });
    }
    current = [];
    size = 0;
  };
  for (const paragraph of paragraphs) {
    const length = countChars(paragraph.text);
    if (current.length > 0 && size + length > MAX_REQUEST_CHARS) flush();
    current.push(paragraph);
    size += length;
  }
  flush();
  return { ok: true, requests };
}

function outputText(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("\u0000")) return null;
  const text = value.replace(/\r\n?/g, "\n");
  const length = countChars(text);
  return length >= 1 && length <= MAX_OUTPUT_TEXT_CHARS ? text : null;
}

export type ParsedOutput = { ok: true; output: AiOutput } | { ok: false; reason: string };

/**
 * モデルの出力を検証し、知っている欄だけで組み直す（モデルの出力は信用しない）。
 * edits の index はその要求で送った編集できる段落だけ・重複なし。inserts の afterIndex は −1（先頭）〜本文の最後のブロック。
 * 文は 1〜MAX_OUTPUT_TEXT_CHARS 文字・NUL なし。件数は合わせて MAX_OUTPUT_ITEMS まで。`edits`・`inserts` が無いのは空と同じ。
 */
export function parseAiOutput(value: unknown, request: AiRequest, blockCount: number): ParsedOutput {
  if (!isPlainObject(value)) return { ok: false, reason: "output must be an object" };
  const rawEdits = value.edits ?? [];
  const rawInserts = value.inserts ?? [];
  if (!Array.isArray(rawEdits) || !Array.isArray(rawInserts)) return { ok: false, reason: "edits and inserts must be arrays" };
  if (rawEdits.length + rawInserts.length > MAX_OUTPUT_ITEMS) return { ok: false, reason: "too many items" };
  const editable = new Set(request.paragraphs.filter((paragraph) => paragraph.kind !== "context").map((paragraph) => paragraph.index));
  const seen = new Set<number>();
  const edits: AiOutput["edits"] = [];
  for (const [position, raw] of rawEdits.entries()) {
    if (!isPlainObject(raw) || !isIndex(raw.index)) return { ok: false, reason: `edits[${position}]: invalid index` };
    if (!editable.has(raw.index)) return { ok: false, reason: `edits[${position}]: index is not an editable paragraph of the request` };
    if (seen.has(raw.index)) return { ok: false, reason: `edits[${position}]: duplicate index` };
    const text = outputText(raw.text);
    if (text === null) return { ok: false, reason: `edits[${position}]: invalid text` };
    seen.add(raw.index);
    edits.push({ index: raw.index, text });
  }
  const inserts: AiOutput["inserts"] = [];
  for (const [position, raw] of rawInserts.entries()) {
    if (!isPlainObject(raw) || !isIndex(raw.afterIndex) || raw.afterIndex < -1 || raw.afterIndex >= blockCount) {
      return { ok: false, reason: `inserts[${position}]: invalid afterIndex` };
    }
    if (!INSERT_KINDS.includes(raw.kind as AiInsertKind)) return { ok: false, reason: `inserts[${position}]: invalid kind` };
    const text = outputText(raw.text);
    if (text === null) return { ok: false, reason: `inserts[${position}]: invalid text` };
    inserts.push({ afterIndex: raw.afterIndex, kind: raw.kind as AiInsertKind, text });
  }
  return { ok: true, output: { edits, inserts } };
}

/** 1 回の要求と、そのモデルの出力（検証の前）。 */
export type AiRun = { request: AiRequest; output: unknown };

export type ProposalResult = { ok: true; proposal: Proposal } | { ok: false; reason: string };

/**
 * 要求ごとの出力を検証して 1 つの提案にまとめる。insert の preset では edits を捨てる（足すだけの提案は既存の文を変えない）。
 * 元と同じ文の edit も捨てる（変更なし）。並びは index・afterIndex の順（同じ afterIndex はモデルが返した順）。
 */
export function buildProposal(blocks: readonly Block[], runs: readonly AiRun[], intent: AiIntent, baseRevision: number): ProposalResult {
  const edits: AiOutput["edits"] = [];
  const inserts: ProposalInsert[] = [];
  const seen = new Set<number>();
  let editable = 0;
  for (const run of runs) {
    const parsed = parseAiOutput(run.output, run.request, blocks.length);
    if (!parsed.ok) return parsed;
    for (const edit of parsed.output.edits) {
      if (seen.has(edit.index)) return { ok: false, reason: "duplicate index across requests" };
      seen.add(edit.index);
      edits.push(edit);
    }
    inserts.push(...parsed.output.inserts);
    editable += run.request.paragraphs.filter((paragraph) => paragraph.kind !== "context").length;
  }
  const changes: ProposalChange[] = [];
  if (intentMode(intent) === "edit") {
    for (const edit of edits) {
      const before = blockText(blocks[edit.index]!);
      if (before === edit.text) continue;
      changes.push({ index: edit.index, before, after: edit.text, parts: diffWords(before, edit.text) });
    }
  }
  changes.sort((a, b) => a.index - b.index);
  // Array.prototype.sort は安定（同じ afterIndex はモデルが返した順のまま）
  inserts.sort((a, b) => a.afterIndex - b.afterIndex);
  return { ok: true, proposal: { label: intentLabel(intent), baseRevision, changes, inserts, unchanged: editable - changes.length } };
}

/** プレーンテキストを行の中身にする（`\n` は改行。marks は付けない）。空なら undefined（空の段落）。 */
function inlineContent(text: string): Block[] | undefined {
  const content: Block[] = [];
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((line, position) => {
      if (position > 0) content.push({ type: "hardBreak" });
      if (line.length > 0) content.push({ type: "text", text: line });
    });
  return content.length > 0 ? content : undefined;
}

function withContent(block: Record<string, unknown>, content: Block[] | undefined): Block {
  return content ? { ...block, content } : block;
}

function changedBlock(block: Block, text: string): Block {
  const content = inlineContent(text);
  if (block.type === "heading") {
    const attrs = isPlainObject(block.attrs) ? block.attrs : {};
    return withContent({ type: "heading", attrs: { level: attrs.level } }, content);
  }
  return withContent({ type: "paragraph" }, content);
}

function insertedBlock(insert: ProposalInsert): Block {
  const content = inlineContent(insert.text);
  if (insert.kind === "heading") return withContent({ type: "heading", attrs: { level: 2 } }, content);
  if (insert.kind === "callout") return { type: "callout", content: [withContent({ type: "paragraph" }, content)] };
  return withContent({ type: "paragraph" }, content);
}

/**
 * 採用したものを今の本文に当てる。changes は paragraph・heading の index（文をプレーンテキストに置き換え、見出しの level は保つ）、
 * inserts は afterIndex の後ろ（−1 は先頭）に paragraph・heading（level 2）・callout（中に段落 1 つ）を足す。
 * index と afterIndex はどちらも元の本文の位置で解決する（並べる順で結果は変わらない。同じ afterIndex の差し込みは渡した順）。
 * 結果は必ず validateBlocks を通す。不正な位置・重複・文・検査に通らない結果は ok:false。
 */
export function applyAdoptions(blocks: readonly Block[], adoptions: Adoptions): AstResult {
  const changes = new Map<number, string>();
  for (const change of adoptions.changes) {
    if (!isIndex(change.index) || change.index < 0 || change.index >= blocks.length) return { ok: false, reason: "change index out of range" };
    if (!isEditableBlock(blocks[change.index])) return { ok: false, reason: "change index is not a paragraph or heading" };
    if (changes.has(change.index)) return { ok: false, reason: "duplicate change index" };
    const text = outputText(change.text);
    if (text === null) return { ok: false, reason: "invalid change text" };
    changes.set(change.index, text);
  }
  const inserts = new Map<number, Block[]>();
  for (const insert of adoptions.inserts) {
    if (!isIndex(insert.afterIndex) || insert.afterIndex < -1 || insert.afterIndex >= blocks.length) return { ok: false, reason: "insert afterIndex out of range" };
    if (!INSERT_KINDS.includes(insert.kind)) return { ok: false, reason: "invalid insert kind" };
    const text = outputText(insert.text);
    if (text === null) return { ok: false, reason: "invalid insert text" };
    const list = inserts.get(insert.afterIndex) ?? [];
    list.push(insertedBlock({ afterIndex: insert.afterIndex, kind: insert.kind, text }));
    inserts.set(insert.afterIndex, list);
  }
  const result: Block[] = [...(inserts.get(-1) ?? [])];
  blocks.forEach((block, index) => {
    const text = changes.get(index);
    result.push(text === undefined ? block : changedBlock(block, text));
    result.push(...(inserts.get(index) ?? []));
  });
  return validateBlocks(result);
}
