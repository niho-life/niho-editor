import { stepBlockText, type Block } from "@niho/editor-store";

/**
 * 全文を書き直す段階（`chunked` が ON）の入力を区切る（#277。純粋関数）。
 *
 * - 区切るのは段階の「書き直す対象の資料」1 つだけ（段階 0 は録音ページの本文、段階 1 以降は直前の段階の結果）。
 * - 対象のテキスト（`stepBlocksText` と同じ形。ブロックを空行でつなぐ）が CHUNK_THRESHOLD_CHARS を超えたときだけ区切る。
 * - ブロック（段落）の切れ目で約 CHUNK_TARGET_CHARS ずつ。1 ブロックがそれより長いときは文末（。！？・改行）で、
 *   それも無ければ字数で切る。字数はすべて code point。
 * - 同じ入力からは必ず同じ区切り（順序・内容とも）。再試行・やり直しで終えた区切りを再利用する前提。
 */

/** これを超えたら区切る（code point）。 */
export const CHUNK_THRESHOLD_CHARS = 18_000;
/** 1 区切りの目安（code point）。 */
export const CHUNK_TARGET_CHARS = 16_000;
/** 区切りの数の上限。超える入力は `input_too_long`（非再試行）。 */
export const MAX_CHUNKS = 60;
/** 次の区切りに添える、直前の区切りの出力の末尾（code point）。 */
export const CHUNK_TAIL_CHARS = 400;

const PARAGRAPH_SEPARATOR = "\n\n";
const SENTENCE_ENDS = new Set(["。", "！", "？", "\n"]);

export type ChunkPlan =
  /** `chunks` が null なら区切らない（今までと同じ 1 回）。 */
  | { ok: true; chunks: string[] | null }
  | { ok: false; reason: "too_long" };

function chars(text: string): string[] {
  return Array.from(text);
}

/** 長すぎる 1 段落を、文末（無ければ字数）で CHUNK_TARGET_CHARS 以下の断片にする。 */
export function splitLongParagraph(text: string, limit = CHUNK_TARGET_CHARS): string[] {
  const all = chars(text);
  const pieces: string[] = [];
  let start = 0;
  while (all.length - start > limit) {
    let cut = -1;
    // 上限の中で、いちばん後ろの文末の直後で切る
    for (let index = start + limit - 1; index > start; index--) {
      if (SENTENCE_ENDS.has(all[index]!)) {
        cut = index + 1;
        break;
      }
    }
    if (cut <= start) cut = start + limit;
    const piece = all.slice(start, cut).join("").trim();
    if (piece) pieces.push(piece);
    start = cut;
  }
  const rest = all.slice(start).join("").trim();
  if (rest) pieces.push(rest);
  return pieces;
}

/** 段落の並びを、段落の切れ目で CHUNK_TARGET_CHARS 以下にまとめる（長すぎる段落は先に割る）。 */
export function packParagraphs(paragraphs: readonly string[], limit = CHUNK_TARGET_CHARS): string[] {
  const units = paragraphs.flatMap((paragraph) => (chars(paragraph).length > limit ? splitLongParagraph(paragraph, limit) : [paragraph]));
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const unit of units) {
    const size = chars(unit).length;
    const added = current.length === 0 ? size : length + PARAGRAPH_SEPARATOR.length + size;
    if (current.length > 0 && added > limit) {
      chunks.push(current.join(PARAGRAPH_SEPARATOR));
      current = [unit];
      length = size;
      continue;
    }
    current.push(unit);
    length = added;
  }
  if (current.length > 0) chunks.push(current.join(PARAGRAPH_SEPARATOR));
  return chunks;
}

/** 対象のブロックの段落（`stepBlocksText` と同じ取り出し方。空の段落は落とす）。 */
export function chunkParagraphs(blocks: readonly Block[]): string[] {
  return blocks.map((block) => stepBlockText(block).trim()).filter(Boolean);
}

/** 対象のブロックを区切る。閾値以下なら `chunks: null`（区切らない）、MAX_CHUNKS を超えれば `too_long`。 */
export function planChunks(blocks: readonly Block[]): ChunkPlan {
  const paragraphs = chunkParagraphs(blocks);
  if (chars(paragraphs.join(PARAGRAPH_SEPARATOR)).length <= CHUNK_THRESHOLD_CHARS) return { ok: true, chunks: null };
  const chunks = packParagraphs(paragraphs);
  if (chunks.length > MAX_CHUNKS) return { ok: false, reason: "too_long" };
  return { ok: true, chunks };
}

/** 直前の区切りの出力の末尾（話者名・文体をそろえるため）。 */
export function chunkTail(text: string, max = CHUNK_TAIL_CHARS): string {
  const all = chars(text.trim());
  return all.slice(Math.max(0, all.length - max)).join("");
}
