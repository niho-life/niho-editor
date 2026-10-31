/**
 * ページの本文（TipTap の doc の content＝ブロックの配列）を .md に書き出す（#34）。
 *
 * 出力は niho-experience の Markdown サブセット（niho-experience `apps/web/src/lib/guide-markdown.ts` の
 * parseGuideMarkdown）として読めるものだけにする。使うのは:
 * - `## ` `### ` の見出し（h1 は出さない＝題名は本文に含めない）
 * - 段落（1 行。ブロックの間は空行）
 * - `- ` と `1. ` のリスト（1 行 1 項目・入れ子なし。入れ子は 1 段に平坦化し、項目の中の段落・改行は空白でつなぐ）
 * - `:::note` … `:::` の箱（引用・囲み。中は段落とリストだけに平坦化）
 * - `**太字**` `*斜体*` `[文字](https://…)`（https で資格情報の無いリンクだけ。それ以外のリンクは文字だけ）
 * - `![alt](photos/…)` の写真（`photoPath` を渡したときだけ。フォルダの書き出し（#37）が zip の中の相対 path を渡す）
 * 区切り線・録音は出さない。`photoPath` が無ければ画像も出さない。code・取り消し線などその他の mark は文字だけ。
 *
 * 本文の文字は、サブセットの記法として読まれないよう `\` で逃がす（日本語の文字は変えない）。
 * 規則と根拠は src/export/markdown.test.ts の oracle（guide-markdown.ts の受理規則を写したもの）に書いている。
 */

type JsonNode = { readonly [key: string]: unknown };

/** 再帰の深さの上限（壊れた・極端に深い本文で止まらないように）。 */
const MAX_DEPTH = 64;
/** 番号付きリストの番号の上限（guide-markdown.ts の NUMBERED は 3 桁まで）。超えたら 1 から別のリストにする。 */
const MAX_ORDERED_ITEMS = 999;

const BOLD = 1;
const ITALIC = 2;

/** 本文の 1 文字（code point）と、それに掛かる太字・斜体・リンク。 */
type Char = { ch: string; marks: number; href: string | null };

type TextBlock = { type: "paragraph"; inline: Char[] } | { type: "list"; ordered: boolean; items: Char[][] };
type Block =
  | { type: "heading"; level: 2 | 3; inline: Char[] }
  | TextBlock
  | { type: "note"; blocks: TextBlock[] }
  | { type: "photo"; path: string; alt: string };

export type ExportMarkdownOptions = {
  /**
   * 写真の書き出し先（資産の id → 書き出しの中の相対の path。入っていない資産は null）。
   * 渡さなければ画像は出さない（共有・公開の書き出しは今までどおり本文だけ）。
   */
  photoPath?: (assetId: string) => string | null;
};

/** 書き出さないノード（資産・区切り）。 */
const SKIPPED = new Set(["horizontalRule", "image", "docAssetImage", "recording"]);
/** 箇条書き・番号付きとして扱うリスト。 */
const LISTS = new Set(["bulletList", "orderedList", "taskList"]);
/** `:::note` にする箱。 */
const BOXES = new Set(["blockquote", "callout"]);

function isNode(value: unknown): value is JsonNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childrenOf(node: JsonNode): unknown[] {
  return Array.isArray(node.content) ? node.content : [];
}

function hasInlineChild(node: JsonNode): boolean {
  return childrenOf(node).some((child) => isNode(child) && (child.type === "text" || child.type === "hardBreak"));
}

/**
 * Markdown のリンクにしてよい先（https・資格情報なし）。guide-markdown.ts の guideLinkHref が断る文字
 * （空白・`\` `<` `>` `"` `'` バッククォート・制御文字）とリンクの終わりと読まれる `(` `)` は %XX にする。
 */
export function markdownLinkHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  return url.href.replace(/[\s\\<>"'`()\u0000-\u001f\u007f]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

function marksOf(raw: unknown): { marks: number; href: string | null } {
  let marks = 0;
  let href: string | null = null;
  if (!Array.isArray(raw)) return { marks, href };
  for (const mark of raw) {
    if (!isNode(mark)) continue;
    if (mark.type === "bold") marks |= BOLD;
    else if (mark.type === "italic") marks |= ITALIC;
    else if (mark.type === "link" && isNode(mark.attrs)) href = markdownLinkHref(mark.attrs.href);
  }
  return { marks, href };
}

/** 改行の類は空白に、その他の制御文字は除く（行の構造を本文の文字で変えない）。 */
function pushText(out: Char[], text: string, marks: number, href: string | null): void {
  for (const ch of text) {
    if (/[\t\n\v\f\r\u0085\u2028\u2029]/.test(ch)) out.push({ ch: " ", marks, href });
    else if (!/[\u0000-\u001f\u007f]/.test(ch)) out.push({ ch, marks, href });
  }
}

function collectInline(nodes: unknown, depth: number, out: Char[]): void {
  if (!Array.isArray(nodes) || depth > MAX_DEPTH) return;
  for (const node of nodes) {
    if (!isNode(node) || SKIPPED.has(String(node.type))) continue;
    if (node.type === "text") {
      if (typeof node.text === "string") {
        const { marks, href } = marksOf(node.marks);
        pushText(out, node.text, marks, href);
      }
    } else if (node.type === "hardBreak") {
      out.push({ ch: " ", marks: 0, href: null });
    } else {
      collectInline(node.content, depth + 1, out);
    }
  }
}

function inlineOf(node: JsonNode, depth: number): Char[] {
  const out: Char[] = [];
  collectInline(node.content, depth + 1, out);
  return out;
}

/** 配列の末尾へ順に足す。引数に展開する push は、引数の数が V8 の上限を超える長さ（約 13 万字）で RangeError になるので使わない。 */
function appendAll(target: Char[], part: readonly Char[]): void {
  for (const char of part) target.push(char);
}

/** 項目の文字に足す（前に文字があれば空白でつなぐ）。 */
function appendPart(text: Char[], part: Char[]): void {
  if (part.length === 0) return;
  if (text.length > 0) text.push({ ch: " ", marks: 0, href: null });
  appendAll(text, part);
}

/** リストの項目を 1 段に平坦化する（入れ子のリストの項目は親の項目の後ろに並べる）。 */
function flattenItems(list: JsonNode, depth: number, items: Char[][]): void {
  if (depth > MAX_DEPTH) return;
  for (const item of childrenOf(list)) {
    if (!isNode(item)) continue;
    const text: Char[] = [];
    const nested: Char[][] = [];
    collectItem(childrenOf(item), depth + 1, text, nested);
    items.push(text, ...nested);
  }
}

function collectItem(nodes: unknown[], depth: number, text: Char[], nested: Char[][]): void {
  if (depth > MAX_DEPTH) return;
  for (const node of nodes) {
    if (!isNode(node) || SKIPPED.has(String(node.type))) continue;
    if (LISTS.has(String(node.type))) {
      flattenItems(node, depth + 1, nested);
    } else if (node.type === "text" || node.type === "hardBreak") {
      const part: Char[] = [];
      collectInline([node], depth, part);
      appendAll(text, part);
    } else if (node.type === "paragraph" || node.type === "heading" || hasInlineChild(node)) {
      appendPart(text, inlineOf(node, depth));
    } else {
      collectItem(childrenOf(node), depth + 1, text, nested);
    }
  }
}

/** 箱の中は段落とリストだけ（見出しは段落に、箱の中の箱は中身に平坦化）。 */
function toTextBlocks(blocks: Block[]): TextBlock[] {
  return blocks.flatMap((block): TextBlock[] => {
    if (block.type === "heading") return [{ type: "paragraph", inline: block.inline }];
    if (block.type === "note") return block.blocks;
    // 箱の中の写真は出さない（箱の中は段落とリストだけ。写真は箱の外に置く）
    if (block.type === "photo") return [];
    return [block];
  });
}

function headingLevel(attrs: unknown): 2 | 3 {
  // 見出し 2 は ##、それ以外（3・その他のレベル）は ###（共有ページの描画と同じ丸め方）
  return isNode(attrs) && attrs.level === 2 ? 2 : 3;
}

/** `![alt](path)` の alt に入れる文字（記法として読まれる文字と改行を落とす）。 */
function escapeAlt(alt: string): string {
  return alt.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\\[\]]/g, (char) => `\\${char}`).trim();
}

function convertBlocks(nodes: unknown, depth: number, out: Block[], options?: ExportMarkdownOptions): void {
  if (!Array.isArray(nodes) || depth > MAX_DEPTH) return;
  let loose: Char[] | null = null;
  const flushLoose = () => {
    if (loose) out.push({ type: "paragraph", inline: loose });
    loose = null;
  };
  for (const node of nodes) {
    if (!isNode(node)) continue;
    const type = String(node.type);
    if (type === "text" || type === "hardBreak") {
      loose ??= [];
      collectInline([node], depth, loose);
      continue;
    }
    flushLoose();
    if (type === "image" && options?.photoPath) {
      // 写真（#33 の資産）。zip に入った写真だけを出す（読めなかった写真は出さない）
      const attrs = isNode(node.attrs) ? node.attrs : {};
      const assetId = typeof attrs.assetId === "string" ? attrs.assetId : null;
      const path = assetId === null ? null : options.photoPath(assetId);
      if (path !== null) {
        out.push({ type: "photo", path, alt: typeof attrs.alt === "string" ? attrs.alt : "" });
        continue;
      }
    }
    if (SKIPPED.has(type)) continue;
    if (type === "paragraph") out.push({ type: "paragraph", inline: inlineOf(node, depth) });
    else if (type === "heading") out.push({ type: "heading", level: headingLevel(node.attrs), inline: inlineOf(node, depth) });
    else if (LISTS.has(type)) {
      const items: Char[][] = [];
      flattenItems(node, depth + 1, items);
      out.push({ type: "list", ordered: type === "orderedList", items });
    } else if (BOXES.has(type)) {
      const inner: Block[] = [];
      convertBlocks(node.content, depth + 1, inner, options);
      out.push({ type: "note", blocks: toTextBlocks(inner) });
    } else if (hasInlineChild(node)) {
      // 未知の文字のブロック（コードのブロックなど）は段落にする
      out.push({ type: "paragraph", inline: inlineOf(node, depth) });
    } else {
      // 未知の入れ物（表など）は中身のブロックを並べる
      convertBlocks(node.content, depth + 1, out, options);
    }
  }
  flushLoose();
}

// ---- 行の中の書き出し ----

const isSpace = (ch: string) => /\s/.test(ch);

/**
 * どこにあっても `\` で逃がす文字（guide-markdown.ts の parseGuideInline・unsupportedBlock が記法として読むもの）:
 * `\`（逃がしの印）、バッククォート（code）、`*`（強調）、`_`（強調・区切り線）、`[` `]`（リンク・CONFIRM）、
 * `<`（HTML）、`>`（引用）、`&`（実体参照）、`|`（表）、`~`（取り消し線・コードの囲み）、`#`（見出し・見出しの閉じ）。
 */
const ALWAYS_ESCAPED = new Set(["\\", "`", "*", "_", "[", "]", "<", ">", "&", "|", "~", "#"]);

type Unit = { kind: "char"; char: Char; marks: number } | { kind: "link"; href: string; chars: Char[]; marks: number };

/** 前後の空白（JS の \s。parser の trimEnd・trim と同じ）を除く。 */
function trimChars(chars: Char[]): Char[] {
  let start = 0;
  let end = chars.length;
  while (start < end && isSpace(chars[start]!.ch)) start++;
  while (end > start && isSpace(chars[end - 1]!.ch)) end--;
  return chars.slice(start, end);
}

/** 同じリンク先が続く文字をリンク 1 つにまとめる。リンクの前後の空白はリンクの外に出す。空白だけのリンクは文字にする。 */
function toUnits(chars: Char[]): Unit[] {
  const units: Unit[] = [];
  let index = 0;
  while (index < chars.length) {
    const char = chars[index]!;
    if (char.href === null) {
      units.push({ kind: "char", char, marks: char.marks });
      index++;
      continue;
    }
    let end = index;
    while (end < chars.length && chars[end]!.href === char.href) end++;
    const group = chars.slice(index, end);
    const first = group.findIndex((item) => !isSpace(item.ch));
    if (first === -1) {
      for (const item of group) units.push({ kind: "char", char: item, marks: item.marks });
    } else {
      let last = group.length - 1;
      while (isSpace(group[last]!.ch)) last--;
      for (const item of group.slice(0, first)) units.push({ kind: "char", char: item, marks: item.marks });
      const inside = group.slice(first, last + 1);
      // 中の全ての文字に掛かる太字・斜体はリンクの外に出す（`**[文字](…)**`）。残りはリンクの文字の中で書く
      const hoisted = inside.filter((item) => !isSpace(item.ch)).reduce((acc, item) => acc & item.marks, BOLD | ITALIC);
      units.push({
        kind: "link",
        href: char.href,
        chars: inside.map((item) => ({ ch: item.ch, marks: item.marks & ~hoisted, href: null })),
        marks: hoisted,
      });
      for (const item of group.slice(last + 1)) units.push({ kind: "char", char: item, marks: item.marks });
    }
    index = end;
  }
  return units;
}

function isSpaceUnit(unit: Unit): boolean {
  return unit.kind === "char" && isSpace(unit.char.ch);
}

/**
 * 空白には、前後の空白でない文字の両方に掛かる強調だけを掛ける（片側が無ければ掛けない）。
 * これで強調の印は必ず空白でない文字に接する（guide-markdown.ts の `*` の規則: 開く印の後・閉じる印の前に空白を置けない）。
 */
function settleSpaces(units: Unit[]): void {
  const marksBefore: number[] = [];
  let previous = 0;
  let seen = false;
  for (const unit of units) {
    marksBefore.push(seen ? previous : 0);
    if (!isSpaceUnit(unit)) {
      previous = unit.marks;
      seen = true;
    }
  }
  let next = 0;
  seen = false;
  for (let index = units.length - 1; index >= 0; index--) {
    const unit = units[index]!;
    if (isSpaceUnit(unit)) unit.marks = seen ? marksBefore[index]! & next : 0;
    else {
      next = unit.marks;
      seen = true;
    }
  }
}

type Segment = { marks: number; units: Unit[] };

function segmentsOf(units: Unit[]): Segment[] {
  const segments: Segment[] = [];
  for (const unit of units) {
    const last = segments.at(-1);
    if (last && last.marks === unit.marks) last.units.push(unit);
    else segments.push({ marks: unit.marks, units: [unit] });
  }
  return segments;
}

const MARKER: Record<number, string> = { [BOLD]: "**", [ITALIC]: "*" };

/** 強調の塊: segments[start, end) に外側の強調 outer が続き、内側の強調は塊の端に接しない。 */
type EmphasisRun = { start: number; end: number; outer: number };

/**
 * 強調の置き方を決める。guide-markdown.ts の parseGuideInline は `***` を「片方を閉じてもう片方を開く」ときにしか許さず、
 * 2 つの強調を同じ所で開く・閉じることや、交差すること（`*a**b*c**`）を書けない。そこで続く強調の文字を
 * 「外側の強調 1 つ＋その内側の強調」の塊に分け、内側の強調が塊の端に接するところだけ内側を落とす
 * （例: 太字と斜体が同じ文字に掛かるだけなら太字だけになる）。塊どうしが接するところは `***`（閉じて開く）になり、
 * parser の特別な場合に当たる。落としたら changed を返す（空白の強調を決め直して、もう一度決める）。
 */
function planEmphasis(segments: Segment[]): { runs: EmphasisRun[]; changed: boolean } {
  const runs: EmphasisRun[] = [];
  let changed = false;
  let index = 0;
  while (index < segments.length) {
    const segment = segments[index]!;
    if (segment.marks === 0) {
      index++;
      continue;
    }
    let outer: number;
    if (segment.marks !== (BOLD | ITALIC)) outer = segment.marks;
    else {
      // 両方が掛かる所から始まるときは、長く続く方を外側にする（同じなら太字）
      const runOf = (mark: number) => {
        let end = index;
        while (end < segments.length && (segments[end]!.marks & mark) !== 0) end++;
        return end - index;
      };
      outer = runOf(ITALIC) > runOf(BOLD) ? ITALIC : BOLD;
    }
    const inner = outer === BOLD ? ITALIC : BOLD;
    let end = index;
    while (end < segments.length && (segments[end]!.marks & outer) !== 0) end++;
    for (const at of new Set([index, end - 1])) {
      const part = segments[at]!;
      if ((part.marks & inner) === 0) continue;
      for (const unit of part.units) unit.marks &= ~inner;
      changed = true;
    }
    runs.push({ start: index, end, outer });
    index = end;
  }
  return { runs, changed };
}

function renderUnits(units: Unit[]): string {
  // 落とす強調が無くなるまで決め直す（強調は減る一方なので必ず止まる）。止まったとき、全ての印は
  // 空白でない文字に接し（settleSpaces）、内側の強調は塊の端に接しない（planEmphasis）
  let segments: Segment[];
  let runs: EmphasisRun[];
  for (;;) {
    settleSpaces(units);
    segments = segmentsOf(units);
    const plan = planEmphasis(segments);
    runs = plan.runs;
    if (!plan.changed) break;
  }
  const nextOf = new Map<Unit, Unit | undefined>(units.map((unit, index) => [unit, units[index + 1]]));
  const emit = (part: Unit[]): string =>
    part
      .map((unit) => {
        if (unit.kind === "link") return renderLink(unit);
        const { ch } = unit.char;
        // `![` は写真の行（parseGuideInline は文の中の `![` を断る）。リンクの直前の `!` は逃がす
        if (ch === "!" && nextOf.get(unit)?.kind === "link") return "\\!";
        return ALWAYS_ESCAPED.has(ch) ? `\\${ch}` : ch;
      })
      .join("");
  let out = "";
  let index = 0;
  for (const run of runs) {
    for (; index < run.start; index++) out += emit(segments[index]!.units);
    const inner = run.outer === BOLD ? ITALIC : BOLD;
    out += MARKER[run.outer];
    for (; index < run.end; index++) {
      const part = segments[index]!;
      out += (part.marks & inner) !== 0 ? `${MARKER[inner]}${emit(part.units)}${MARKER[inner]}` : emit(part.units);
    }
    out += MARKER[run.outer];
  }
  for (; index < segments.length; index++) out += emit(segments[index]!.units);
  return out;
}

function renderLink(unit: Extract<Unit, { kind: "link" }>): string {
  const inner = renderUnits(unit.chars.map((char) => ({ kind: "char", char, marks: char.marks })));
  // `[CONFIRM:` で始まると確認の印として読まれる（parseGuideInline はリンクより先に見る）
  const text = inner.startsWith("CONFIRM:") ? `CONFIRM\\:${inner.slice("CONFIRM:".length)}` : inner;
  return `[${text}](${unit.href})`;
}

/**
 * 行の頭でだけ記法になる文字を逃がす（guide-markdown.ts の parseBlocks・unsupportedBlock・BULLET・NUMBERED）:
 * `-`（リスト・区切り線）、`+`（リスト）、`=`（下線の見出し）、`:`（`:::` の箱。箱の中の `:::` だけの行は箱の終わり）、
 * `数字.` `数字)`（番号付きリスト）。
 */
function escapeLineStart(line: string): string {
  if (/^[-+=:]/.test(line)) return `\\${line}`;
  return line.replace(/^(\d+)([.)])/, "$1\\$2");
}

function renderInline(chars: Char[]): string {
  const trimmed = trimChars(chars);
  if (trimmed.length === 0) return "";
  return escapeLineStart(renderUnits(toUnits(trimmed)));
}

function renderList(block: Extract<TextBlock, { type: "list" }>): string[] {
  const lines = block.items.map(renderInline).filter((line) => line !== "");
  const chunks: string[] = [];
  for (let start = 0; start < lines.length; start += MAX_ORDERED_ITEMS) {
    const chunk = lines.slice(start, block.ordered ? start + MAX_ORDERED_ITEMS : lines.length);
    chunks.push(chunk.map((line, index) => (block.ordered ? `${index + 1}. ${line}` : `- ${line}`)).join("\n"));
    if (!block.ordered) break;
  }
  return chunks;
}

function renderTextBlock(block: TextBlock): string[] {
  if (block.type === "list") return renderList(block);
  const line = renderInline(block.inline);
  return line === "" ? [] : [line];
}

function renderBlock(block: Block): string[] {
  if (block.type === "photo") return [`![${escapeAlt(block.alt)}](${block.path})`];
  if (block.type === "heading") {
    const line = renderInline(block.inline);
    return line === "" ? [] : [`${"#".repeat(block.level)} ${line}`];
  }
  if (block.type === "note") {
    const inner = block.blocks.flatMap(renderTextBlock);
    // 空の箱は parser が断るので出さない
    return inner.length === 0 ? [] : [`:::note\n${inner.join("\n\n")}\n:::`];
  }
  return renderTextBlock(block);
}

/**
 * 本文（TipTap の doc の content）を Markdown にする。空の本文は空文字列、それ以外は末尾に改行 1 つ。
 * 未知のノードは投げずに、文字のブロックなら段落、入れ物なら中身を書き出す。
 */
export function exportMarkdown(blocks: readonly unknown[], options?: ExportMarkdownOptions): string {
  const converted: Block[] = [];
  convertBlocks(Array.isArray(blocks) ? blocks : [], 0, converted, options);
  const parts = converted.flatMap(renderBlock);
  return parts.length === 0 ? "" : `${parts.join("\n\n")}\n`;
}
