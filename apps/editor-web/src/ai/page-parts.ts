import type { Block } from "@niho/editor-store";
import { blocksToMarkdown, markdownToBlocks } from "niho-docs-ui/page/markdown";

/**
 * 文字にできないブロック（画像・録音）を AI の道具で扱う（#281）。docs-ui の Markdown の往復は画像・録音を断るので、
 * 本文の最上位の画像・録音は **1 行のプレースホルダ** にして AI に読ませ、書き戻しで元のブロックに戻す。
 *
 * - 画像: `![代替文](niho-asset:ID "キャプション")`（代替文・キャプションが無ければ `![](niho-asset:ID)`）。
 * - 録音: `[録音](niho-asset:ID)`。
 * - 画像は AI から見えず作り直せないので、**書き込み側で守る**: 画像が 1 つでも消える書き込みは断る。消せるのは
 *   `remove_images` で明示した画像だけ。録音は位置だけ動かせて、書き換えも削除もできない。元のページに無い画像・録音は足せない。
 * - 最上位以外（箇条書き・引用・囲み・表の中）にある画像・録音は、1 行にできないので従来どおり断る。
 *
 * 純粋な関数だけ（DOM・Node の API を使わない）。サーバーの道具（chat-api.ts）と画面の Mac CLI の経路（AiBox.tsx）で使う。
 */

export const ASSET_SCHEME = "niho-asset:";

/** 断る理由（AI に返す文。道具の結果になる）。 */
export const PARTS_TEXT = {
  nested: "このページには、箇条書き・引用・囲み・表の中に画像や録音があり、1 行の印にできないので、この会話では直せません。",
  unknownPart: "このページに無い画像・録音は足せません。niho-asset: の行は、read_page で読んだものだけを使ってください。",
  duplicatePart: "同じ画像・録音（niho-asset: の行）が 2 回出ています。1 つの画像・録音は 1 回だけ置いてください。",
  misplacedPart: "niho-asset: の行は、前後を空行で区切った 1 行に置いてください（箇条書き・引用・囲み・表の中には置けません）。",
  recordingChanged: "録音は書き換えも削除もできません。[録音](niho-asset:…) の行はそのまま残してください。",
  removeUnknown: "remove_images に、このページの画像ではない id が入っています。read_page で読んだ画像の id だけを渡してください。",
  repeatedPart: "このページは、同じ画像・録音を 2 か所以上に置いているので、この会話では書き換えられません（どの 1 か所を消したのか見分けられず、画像が黙って減るおそれがあるため）。画面で 1 か所にしてから頼んでください。",
} as const;

export type PartsResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const IMAGE_LINE = new RegExp(`^[ \\t]*!\\[((?:\\\\.|[^\\\\\\[\\]])*)\\]\\(${ASSET_SCHEME}(${UUID})(?: "((?:\\\\.|[^\\\\"])*)")?\\)[ \\t]*$`, "u");
const RECORDING_LINE = new RegExp(`^[ \\t]*\\[録音\\]\\(${ASSET_SCHEME}(${UUID})\\)[ \\t]*$`, "u");
const FENCE = /^[ \t]{0,3}(?:```|~~~)/u;

function typeOf(block: Block): string {
  return typeof block.type === "string" ? block.type : "";
}

function attrsOf(block: Block): Record<string, unknown> {
  return typeof block.attrs === "object" && block.attrs !== null && !Array.isArray(block.attrs) ? (block.attrs as Record<string, unknown>) : {};
}

function isPart(block: Block): boolean {
  const type = typeOf(block);
  return type === "image" || type === "recording";
}

function assetIdOf(block: Block): string {
  const id = attrsOf(block).assetId;
  return typeof id === "string" ? id : "";
}

/** 1 行を壊さない形（改行は空白にする）。 */
function oneLine(value: string): string {
  return value.replace(/\r\n|[\r\n\u2028\u2029]/gu, " ");
}

function escapeAlt(value: string): string {
  return oneLine(value).replace(/[\\[\]]/gu, (ch) => `\\${ch}`);
}

function escapeCaption(value: string): string {
  return oneLine(value).replace(/[\\"]/gu, (ch) => `\\${ch}`);
}

function unescape(value: string): string {
  return value.replace(/\\(.)/gu, "$1");
}

function textAttr(attrs: Record<string, unknown>, key: string): string {
  const value = attrs[key];
  return typeof value === "string" ? value : "";
}

/** 画像・録音のブロックのプレースホルダ（1 行）。それ以外は null。 */
export function partPlaceholder(block: Block): string | null {
  const type = typeOf(block);
  if (type === "recording") return `[録音](${ASSET_SCHEME}${assetIdOf(block)})`;
  if (type !== "image") return null;
  const attrs = attrsOf(block);
  const caption = textAttr(attrs, "caption");
  return `![${escapeAlt(textAttr(attrs, "alt"))}](${ASSET_SCHEME}${assetIdOf(block)}${caption ? ` "${escapeCaption(caption)}"` : ""})`;
}

/** 中（子のブロック・行の中）に画像・録音があるか。 */
function hasNestedPart(block: Block): boolean {
  const content = Array.isArray(block.content) ? (block.content as Block[]) : [];
  return content.some((child) => isPart(child) || hasNestedPart(child));
}

/** 最上位のブロック 1 つを Markdown にする（画像・録音はプレースホルダ）。入れ子の中に画像・録音があれば断る。 */
export function blockToPartsMarkdown(block: Block): PartsResult<string> {
  const placeholder = partPlaceholder(block);
  if (placeholder !== null) return { ok: true, value: placeholder };
  if (hasNestedPart(block)) return { ok: false, reason: PARTS_TEXT.nested };
  const one = blocksToMarkdown([block]);
  if (!one.ok) return { ok: false, reason: PARTS_TEXT.nested };
  return { ok: true, value: one.markdown.replace(/\n+$/u, "") };
}

/** 段落（最上位のブロック）ごとの Markdown と、それを空行でつないだ本文。 */
export function pageParagraphs(blocks: readonly Block[]): PartsResult<{ parts: string[]; joined: string }> {
  const parts: string[] = [];
  for (const block of blocks) {
    const one = blockToPartsMarkdown(block);
    if (!one.ok) return one;
    parts.push(one.value);
  }
  return { ok: true, value: { parts, joined: parts.join("\n\n") } };
}

/** 本文の全体の Markdown（画像・録音はプレースホルダ。Mac CLI に渡す文書）。 */
export function pageToPartsMarkdown(blocks: readonly Block[]): PartsResult<string> {
  const paragraphs = pageParagraphs(blocks);
  return paragraphs.ok ? { ok: true, value: paragraphs.value.joined } : paragraphs;
}

type Placeholder = { kind: "image"; assetId: string; alt: string; caption: string } | { kind: "recording"; assetId: string };

/** 目印の接頭辞（英数字だけ。Markdown の記号として読まれない）。 */
const MARKER_PREFIX = "NIHOASSETPART";

function defaultNonce(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

/**
 * Markdown のプレースホルダの行を、一意な目印の段落に置き換える（パースの前）。囲みのコードの中の行は触らない。
 * 目印は「接頭辞 + nonce + 連番」で、本文に接頭辞 + nonce が現れない nonce を選ぶ。
 */
export function protectParts(markdown: string, nonce: () => string = defaultNonce): PartsResult<{ markdown: string; stem: string; markers: Map<string, Placeholder> }> {
  let stem = `${MARKER_PREFIX}${nonce()}`;
  for (let tries = 0; markdown.includes(stem); tries++) {
    if (tries >= 8) return { ok: false, reason: PARTS_TEXT.misplacedPart };
    stem = `${MARKER_PREFIX}${nonce()}`;
  }
  const markers = new Map<string, Placeholder>();
  const seen = new Set<string>();
  let fenced = false;
  const lines: string[] = [];
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const image = fenced ? null : IMAGE_LINE.exec(line);
    const recording = fenced || image ? null : RECORDING_LINE.exec(line);
    const found: Placeholder | null = image
      ? { kind: "image", assetId: image[2]!.toLowerCase(), alt: unescape(image[1]!), caption: unescape(image[3] ?? "") }
      : recording
        ? { kind: "recording", assetId: recording[1]!.toLowerCase() }
        : null;
    if (!found) {
      lines.push(line);
      continue;
    }
    if (seen.has(found.assetId)) return { ok: false, reason: PARTS_TEXT.duplicatePart };
    seen.add(found.assetId);
    const marker = `${stem}N${markers.size + 1}Z`;
    markers.set(marker, found);
    // 前後を空行にして、目印を独立した段落にする（行の字下げはそのまま。箇条書きの中なら入れ子になり、あとで断る）
    const indent = /^[ \t]*/u.exec(line)![0];
    lines.push("", `${indent}${marker}`, "");
  }
  return { ok: true, value: { markdown: lines.join("\n"), stem, markers } };
}

/** 段落のテキストが目印だけか（mark 無しの text 1 つ）。 */
function markerOf(block: Block): string | null {
  if (typeOf(block) !== "paragraph" || !Array.isArray(block.content) || block.content.length !== 1) return null;
  const only = block.content[0] as Block;
  if (typeOf(only) !== "text" || (Array.isArray(only.marks) && only.marks.length > 0)) return null;
  return typeof only.text === "string" ? only.text : null;
}

function containsStem(value: unknown, stem: string): boolean {
  if (typeof value === "string") return value.includes(stem);
  if (Array.isArray(value)) return value.some((child) => containsStem(child, stem));
  if (typeof value === "object" && value !== null) return Object.values(value).some((child) => containsStem(child, stem));
  return false;
}

/** 元の値と同じ表記（1 行にした形）なら元の値を保つ。空なら外す。 */
function keepOrReplace(out: Record<string, unknown>, key: "alt" | "caption", original: Record<string, unknown>, next: string): void {
  const before = textAttr(original, key);
  if (oneLine(before) === next) {
    if (original[key] === undefined) delete out[key];
    else out[key] = original[key];
    return;
  }
  if (next.length === 0) delete out[key];
  else out[key] = next;
}

/**
 * パースしたブロック列の目印の段落を、元の画像・録音のブロックに戻す。`originals` は元のページの本文。
 * 目印が最上位以外に残った・見つからない・元に無い assetId・種類が違うものは断る。
 * 画像は代替文とキャプションだけ新しい値（元と同じ表記なら元の値）。credit・consent・assetId は元のまま。
 */
export function restoreParts(
  blocks: readonly Block[],
  protectedParts: { stem: string; markers: ReadonlyMap<string, Placeholder> },
  originals: readonly Block[],
): PartsResult<Block[]> {
  const byId = new Map<string, Block>();
  for (const block of originals) if (isPart(block)) byId.set(assetIdOf(block).toLowerCase(), block);
  const out: Block[] = [];
  const used = new Set<string>();
  for (const block of blocks) {
    const marker = markerOf(block);
    const found = marker === null ? undefined : protectedParts.markers.get(marker);
    if (!found) {
      if (containsStem(block, protectedParts.stem)) return { ok: false, reason: PARTS_TEXT.misplacedPart };
      out.push(block);
      continue;
    }
    used.add(marker!);
    const original = byId.get(found.assetId);
    if (!original || typeOf(original) !== found.kind) return { ok: false, reason: PARTS_TEXT.unknownPart };
    if (found.kind === "recording") {
      out.push(original);
      continue;
    }
    const before = attrsOf(original);
    const attrs: Record<string, unknown> = { ...before };
    keepOrReplace(attrs, "alt", before, found.alt);
    keepOrReplace(attrs, "caption", before, found.caption);
    out.push({ ...original, attrs });
  }
  if (used.size !== protectedParts.markers.size) return { ok: false, reason: PARTS_TEXT.misplacedPart };
  return { ok: true, value: out };
}

/** 本文のどこか（入れ子を含む）にある画像・録音（assetId → ブロック）。 */
function partsIn(blocks: readonly Block[], into: Block[] = []): Block[] {
  for (const block of blocks) {
    if (isPart(block)) into.push(block);
    if (Array.isArray(block.content)) partsIn(block.content as Block[], into);
  }
  return into;
}

/** 同じ画像・録音（assetId）が本文に 2 か所以上あるか。assetId ごとの Map にまとめると出現数が失われるので、先に断る。 */
function hasRepeatedPart(blocks: readonly Block[]): boolean {
  const seen = new Set<string>();
  for (const block of partsIn(blocks)) {
    const id = assetIdOf(block).toLowerCase();
    if (seen.has(id)) return true;
    seen.add(id);
  }
  return false;
}

function sameAttrs(a: Block, b: Block): boolean {
  const x = attrsOf(a);
  const y = attrsOf(b);
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const key of keys) if ((x[key] ?? null) !== (y[key] ?? null)) return false;
  return true;
}

/**
 * 書き込みの検査（保存の前）。元の本文と書いたあとの本文の画像・録音を比べる。
 * - 録音は全部残り、属性も同じ（位置は動いてよい）。
 * - 元の画像が無くなっていれば、`removeImages` に入っているものだけ許す。
 * - `removeImages` は元の画像の id だけ。元に無い画像・録音は足せない。同じものが 2 回出るのも断る。
 * - 元の本文が同じ画像・録音を 2 か所以上に置いているページは、どれが消えたか見分けられないので書き換えを断る。
 */
export function checkParts(before: readonly Block[], after: readonly Block[], removeImages: readonly string[]): PartsResult<null> {
  if (hasRepeatedPart(before)) return { ok: false, reason: PARTS_TEXT.repeatedPart };
  const was = new Map<string, Block>();
  for (const block of partsIn(before)) was.set(assetIdOf(block).toLowerCase(), block);
  const remove = new Set(removeImages.map((id) => id.toLowerCase()));
  for (const id of remove) if (typeOf(was.get(id) ?? {}) !== "image") return { ok: false, reason: PARTS_TEXT.removeUnknown };
  const now = new Map<string, Block>();
  for (const block of partsIn(after)) {
    const id = assetIdOf(block).toLowerCase();
    if (now.has(id)) return { ok: false, reason: PARTS_TEXT.duplicatePart };
    const original = was.get(id);
    if (!original || typeOf(original) !== typeOf(block)) return { ok: false, reason: PARTS_TEXT.unknownPart };
    now.set(id, block);
  }
  for (const id of remove) {
    if (now.has(id)) return { ok: false, reason: `remove_images の画像 ${id} が本文に残っています。edit_page で消せるのは、置き換える範囲（find が掛かる段落）の中の画像だけです。` };
  }
  for (const [id, block] of was) {
    const next = now.get(id);
    if (typeOf(block) === "recording") {
      if (!next || !sameAttrs(block, next)) return { ok: false, reason: PARTS_TEXT.recordingChanged };
      continue;
    }
    if (!next && !remove.has(id)) {
      const alt = textAttr(attrsOf(block), "alt").trim();
      return { ok: false, reason: `画像 ${assetIdOf(block)}${alt ? `（${alt}）` : ""}が消えるので保存しませんでした。画像の行（![…](niho-asset:…)）を残して書き直してください。消すなら remove_images で明示してください。` };
    }
  }
  return { ok: true, value: null };
}

/**
 * AI が書いた Markdown（プレースホルダ込み）を blocks にする: 目印に置き換え → `markdownToBlocks`（見出しは clamp）→
 * 元の画像・録音に戻す → `remove_images` の画像を外す。保存の検査（parseBlocks・checkParts）は呼ぶ側が行う。
 * `parseFailed` は Markdown として読めなかったとき（理由は docs-ui の文）。
 */
export function partsMarkdownToBlocks(
  markdown: string,
  originals: readonly Block[],
  removeImages: readonly string[] = [],
  nonce?: () => string,
): PartsResult<Block[]> & { parseFailed?: true } {
  const parsed = parsePartsMarkdown(markdown, nonce);
  return parsed.ok ? finishParts(parsed.value, originals, removeImages) : parsed;
}

/** パースまで（元のページを読む前に、本文の形だけを確かめる）。 */
export type ParsedPartsMarkdown = { blocks: Block[]; stem: string; markers: Map<string, Placeholder> };

export function parsePartsMarkdown(markdown: string, nonce?: () => string): PartsResult<ParsedPartsMarkdown> & { parseFailed?: true } {
  const protectedParts = protectParts(markdown, nonce);
  if (!protectedParts.ok) return protectedParts;
  const parsed = markdownToBlocks(protectedParts.value.markdown, { headings: "clamp" });
  if (!parsed.ok) return { ok: false, reason: parsed.reason, parseFailed: true };
  return { ok: true, value: { blocks: parsed.blocks, stem: protectedParts.value.stem, markers: protectedParts.value.markers } };
}

/** パースした本文の目印を元の画像・録音に戻し、`remove_images` の画像を外す。 */
export function finishParts(parsed: ParsedPartsMarkdown, originals: readonly Block[], removeImages: readonly string[] = []): PartsResult<Block[]> {
  // 元のページが同じ画像・録音を複数置いていると、assetId で元のブロックを引けない（保存の検査 checkParts でも断る）
  if (hasRepeatedPart(originals)) return { ok: false, reason: PARTS_TEXT.repeatedPart };
  const restored = restoreParts(parsed.blocks, parsed, originals);
  if (!restored.ok) return restored;
  const remove = new Set(removeImages.map((id) => id.toLowerCase()));
  return { ok: true, value: restored.value.filter((block) => !(typeOf(block) === "image" && remove.has(assetIdOf(block).toLowerCase()))) };
}

/** 道具の入力の `remove_images`（無ければ空。形が違えば null）。 */
export function parseRemoveImages(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200 || value.some((id) => typeof id !== "string" || !new RegExp(`^${UUID}$`, "u").test(id))) return null;
  return value as string[];
}
