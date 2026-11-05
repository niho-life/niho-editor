/**
 * Published versions (#39). `toPublishedBlocks` turns the editor's TipTap content into the contract's
 * restricted AST; `buildSnapshot` assembles an immutable `PublishedDoc` and checks it with the contract's
 * own validator before anything is stored.
 *
 * Unknown nodes are never dropped silently: they become problems (fix: body). Recordings are dropped on
 * purpose and reported as a notice. Empty paragraphs are dropped. Links that break the contract's URL
 * rules lose their link mark (the text stays) and are reported as a notice.
 */

import {
  ASSET_ID_PATTERN,
  CONTRACT_VERSION,
  IMAGE_CONTENT_TYPES,
  MARK_TYPES,
  PUBLISHED_LIMITS,
  SHA256_PATTERN,
  canonicalJson,
  isHttpsUrl,
  isSafeLinkHref,
  parsePublishedDoc,
  renderMarkdown,
  sha256Hex,
  type Author,
  type CategoryDisplay,
  type Block,
  type Dest,
  type Extras,
  type Inline,
  type Lang,
  type ListBlock,
  type Mark,
  type MarkType,
  type NoteChild,
  type PublicationRange,
  type PublishedAsset,
  type PublishedDoc,
} from "@niho/editor-publish-contract";
import { deepFreeze } from "./freeze.js";
import { CONFIRM_MARKER, cleanLine, cleanText } from "./text.js";
import type { AssetRecord, DraftPage, Notice, Problem } from "./types.js";

// --- conversion ------------------------------------------------------------------

export interface FigureRef {
  readonly assetId: string;
  /** The image node's alt text; null when the node has none (the asset's alt is used). */
  readonly alt: string | null;
}

export interface Conversion {
  readonly blocks: readonly Block[];
  /** Each figure's asset, first occurrence only, in document order. */
  readonly figures: readonly FigureRef[];
  readonly problems: readonly Problem[];
  readonly notices: readonly Notice[];
}

export const CONVERSION_PROBLEMS = {
  unknownNode: { id: "unknown-node", message: "公開版にできない要素があります", fix: "body" },
  misplacedImage: { id: "misplaced-image", message: "箇条書きや囲みの中の写真は公開版に入れられません", fix: "body" },
  figureAsset: { id: "figure-missing", message: "写真が見つかりません", fix: "body" },
} as const satisfies Record<string, Problem>;

export const CONVERSION_NOTICES = {
  recording: { id: "recording-dropped", message: "録音は公開版に含まれません" },
  link: { id: "link-dropped", message: "公開できないリンクを外しました（文字は残ります）" },
  format: { id: "format-dropped", message: "公開版で使えない書式を外しました" },
  list: { id: "list-flattened", message: "入れ子の箇条書きを 1 段にしました" },
} as const satisfies Record<string, Notice>;

const RECORDING_NODES = new Set(["recording", "audio"]);
const NOTE_NODES = new Set(["note", "callout"]);
const LIST_NODES = new Set(["bulletList", "orderedList"]);
const TEXT_BLOCK_NODES = new Set(["paragraph", "heading"]);
const NODE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Shown for a blank `[CONFIRM: ]`; the contract needs non-blank confirm text. */
const BLANK_CONFIRM = "…";

type Fields = Readonly<Record<string, unknown>>;

function fieldsOf(value: unknown): Fields | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : null;
}

function typeOf(node: unknown): string | null {
  const type = fieldsOf(node)?.type;
  return typeof type === "string" ? type : null;
}

function childrenOf(node: unknown): readonly unknown[] {
  const content = fieldsOf(node)?.content;
  return Array.isArray(content) ? content : [];
}

function attrsOf(node: unknown): Fields {
  return fieldsOf(fieldsOf(node)?.attrs) ?? {};
}

/** Node names are schema names, but they come from stored data: only safe names are echoed. */
function nodeName(type: string | null): string {
  return type !== null && NODE_NAME.test(type) ? type : "?";
}

function meaningful(inlines: readonly Inline[]): boolean {
  return inlines.some((inline) => inline.type === "confirm" || inline.text.trim() !== "");
}

function sameMarks(a: readonly Mark[] | undefined, b: readonly Mark[] | undefined): boolean {
  return canonicalJson(a ?? []) === canonicalJson(b ?? []);
}

/** Adjacent text runs with the same marks become one run, so equal content has one shape. */
function mergeInlines(inlines: readonly Inline[]): Inline[] {
  const merged: Inline[] = [];
  for (const inline of inlines) {
    const last = merged[merged.length - 1];
    if (inline.type === "text" && last?.type === "text" && sameMarks(last.marks, inline.marks)) {
      merged[merged.length - 1] = last.marks === undefined
        ? { type: "text", text: last.text + inline.text }
        : { type: "text", text: last.text + inline.text, marks: last.marks };
    } else {
      merged.push(inline);
    }
  }
  return merged;
}

class Converter {
  private readonly problems = new Map<string, Problem>();
  private readonly notices = new Map<string, Notice>();
  private readonly figures = new Map<string, FigureRef>();

  result(blocks: readonly Block[]): Conversion {
    return { blocks, figures: [...this.figures.values()], problems: [...this.problems.values()], notices: [...this.notices.values()] };
  }

  problem(problem: Problem, node?: string): void {
    const value: Problem = node === undefined ? problem : { ...problem, node };
    this.problems.set(`${value.id}\u0000${value.node ?? ""}`, value);
  }

  notice(notice: Notice): void {
    this.notices.set(notice.id, notice);
  }

  unknown(node: unknown): void {
    this.problem(CONVERSION_PROBLEMS.unknownNode, nodeName(typeOf(node)));
  }

  // --- inline ---

  inlines(nodes: readonly unknown[]): Inline[] {
    const out: Inline[] = [];
    let index = 0;
    while (index < nodes.length) {
      if (typeOf(nodes[index]) !== "text") {
        this.inline(nodes[index], out);
        index += 1;
        continue;
      }
      let end = index;
      while (end < nodes.length && typeOf(nodes[end]) === "text") end += 1;
      this.textRun(nodes.slice(index, end), out);
      index = end;
    }
    return mergeInlines(out);
  }

  /**
   * Adjacent text nodes are read as one string, so a `[CONFIRM: …]` that formatting split across nodes
   * (`[CONFIRM: `, bold `hours`, `]`) is still found. Text outside a marker keeps its own node's marks.
   */
  private textRun(nodes: readonly unknown[], out: Inline[]): void {
    const runs: { start: number; text: string; marks: Mark[] }[] = [];
    let full = "";
    for (const node of nodes) {
      const raw = fieldsOf(node)?.text;
      const text = typeof raw === "string" ? cleanText(raw) : "";
      if (text === "") continue;
      runs.push({ start: full.length, text, marks: this.marks(fieldsOf(node)?.marks) });
      full += text;
    }
    for (const piece of splitConfirm(full)) {
      if (piece.confirm) {
        out.push({ type: "confirm", text: piece.text });
        continue;
      }
      for (const run of runs) {
        const from = Math.max(piece.start, run.start);
        const to = Math.min(piece.end, run.start + run.text.length);
        if (from >= to) continue;
        const text = full.slice(from, to);
        out.push(run.marks.length > 0 ? { type: "text", text, marks: run.marks } : { type: "text", text });
      }
    }
  }

  private inline(node: unknown, out: Inline[]): void {
    const type = typeOf(node);
    if (type === "hardBreak") {
      out.push({ type: "text", text: " " });
      return;
    }
    if (type === "confirm") {
      out.push({ type: "confirm", text: confirmText(node) });
      return;
    }
    if (type !== null && RECORDING_NODES.has(type)) {
      this.notice(CONVERSION_NOTICES.recording);
      return;
    }
    if (type === "image") {
      this.problem(CONVERSION_PROBLEMS.misplacedImage, "image");
      return;
    }
    this.unknown(node);
  }

  /** Keeps bold / italic / strike / code / link in the contract's order; drops other formatting (`ai` silently). */
  private marks(raw: unknown): Mark[] {
    if (!Array.isArray(raw)) return [];
    const kept = new Map<MarkType, Mark>();
    for (const entry of raw as readonly unknown[]) {
      const type = typeOf(entry);
      if (type === "bold" || type === "italic" || type === "strike" || type === "code") {
        kept.set(type, { type });
      } else if (type === "link") {
        const href = attrsOf(entry).href;
        if (isSafeLinkHref(href)) kept.set("link", { type: "link", href });
        else this.notice(CONVERSION_NOTICES.link);
      } else if (type === "ai") {
        // The editor's "written by AI" highlight is a view-only mark: published pages never show it, and it is not a lost format.
        continue;
      } else {
        this.notice(CONVERSION_NOTICES.format);
      }
    }
    return MARK_TYPES.flatMap((type) => {
      const mark = kept.get(type);
      return mark ? [mark] : [];
    });
  }

  // --- blocks ---

  top(node: unknown, out: Block[]): void {
    const type = typeOf(node);
    switch (type) {
      case "paragraph": {
        const content = this.inlines(childrenOf(node));
        if (meaningful(content)) out.push({ type: "paragraph", content });
        return;
      }
      case "heading": {
        const content = this.inlines(childrenOf(node));
        if (meaningful(content)) out.push({ type: "heading", level: headingLevel(attrsOf(node).level), content });
        return;
      }
      case "bulletList":
      case "orderedList": {
        const list = this.list(node);
        if (list) out.push(list);
        return;
      }
      case "blockquote":
        for (const child of childrenOf(node)) this.quoteChild(child, out);
        return;
      case "horizontalRule":
        out.push({ type: "divider" });
        return;
      case "image":
        this.figure(node, out);
        return;
      case "confirm":
        out.push({ type: "paragraph", content: [{ type: "confirm", text: confirmText(node) }] });
        return;
      default:
        if (type !== null && NOTE_NODES.has(type)) {
          const blocks: NoteChild[] = [];
          for (const child of childrenOf(node)) this.noteChild(child, blocks);
          if (blocks.length > 0) out.push({ type: "note", blocks });
          return;
        }
        if (type !== null && RECORDING_NODES.has(type)) {
          this.notice(CONVERSION_NOTICES.recording);
          return;
        }
        this.unknown(node);
    }
  }

  /** Each paragraph (or heading) of a quote becomes its own quote block; anything else is lifted out. */
  private quoteChild(node: unknown, out: Block[]): void {
    const type = typeOf(node);
    if (type !== null && TEXT_BLOCK_NODES.has(type)) {
      const content = this.inlines(childrenOf(node));
      if (meaningful(content)) out.push({ type: "quote", content });
      return;
    }
    if (type === "blockquote") {
      for (const child of childrenOf(node)) this.quoteChild(child, out);
      return;
    }
    this.top(node, out);
  }

  /** A note holds paragraphs and flat lists only. */
  private noteChild(node: unknown, out: NoteChild[]): void {
    const type = typeOf(node);
    if (type !== null && TEXT_BLOCK_NODES.has(type)) {
      const content = this.inlines(childrenOf(node));
      if (meaningful(content)) out.push({ type: "paragraph", content });
      return;
    }
    if (type !== null && LIST_NODES.has(type)) {
      const list = this.list(node);
      if (list) out.push(list);
      return;
    }
    if (type === "blockquote" || (type !== null && NOTE_NODES.has(type))) {
      for (const child of childrenOf(node)) this.noteChild(child, out);
      return;
    }
    if (type === "horizontalRule") return;
    if (type === "confirm") {
      out.push({ type: "paragraph", content: [{ type: "confirm", text: confirmText(node) }] });
      return;
    }
    if (type !== null && RECORDING_NODES.has(type)) {
      this.notice(CONVERSION_NOTICES.recording);
      return;
    }
    if (type === "image") {
      this.problem(CONVERSION_PROBLEMS.misplacedImage, "image");
      return;
    }
    this.unknown(node);
  }

  private list(node: unknown): ListBlock | null {
    const items: Inline[][] = [];
    this.listItems(node, items);
    return items.length > 0 ? { type: "list", ordered: typeOf(node) === "orderedList", items } : null;
  }

  /** Nested lists are flattened into the same level, right after their parent item. */
  private listItems(listNode: unknown, items: Inline[][]): void {
    for (const item of childrenOf(listNode)) {
      if (typeOf(item) !== "listItem") {
        this.unknown(item);
        continue;
      }
      const parts: Inline[][] = [];
      const nested: Inline[][] = [];
      for (const child of childrenOf(item)) this.listItemChild(child, parts, nested);
      const joined: Inline[] = [];
      for (const part of parts.filter(meaningful)) {
        if (joined.length > 0) joined.push({ type: "text", text: " " });
        joined.push(...part);
      }
      if (meaningful(joined)) items.push(mergeInlines(joined));
      items.push(...nested);
    }
  }

  private listItemChild(node: unknown, parts: Inline[][], nested: Inline[][]): void {
    const type = typeOf(node);
    if (type !== null && TEXT_BLOCK_NODES.has(type)) {
      parts.push(this.inlines(childrenOf(node)));
      return;
    }
    if (type !== null && LIST_NODES.has(type)) {
      this.notice(CONVERSION_NOTICES.list);
      this.listItems(node, nested);
      return;
    }
    if (type === "blockquote" || (type !== null && NOTE_NODES.has(type))) {
      for (const child of childrenOf(node)) this.listItemChild(child, parts, nested);
      return;
    }
    if (type === "confirm") {
      parts.push([{ type: "confirm", text: confirmText(node) }]);
      return;
    }
    if (type !== null && RECORDING_NODES.has(type)) {
      this.notice(CONVERSION_NOTICES.recording);
      return;
    }
    if (type === "image") {
      this.problem(CONVERSION_PROBLEMS.misplacedImage, "image");
      return;
    }
    this.unknown(node);
  }

  private figure(node: unknown, out: Block[]): void {
    const attrs = attrsOf(node);
    const assetId = attrs.assetId;
    if (typeof assetId !== "string" || !ASSET_ID_PATTERN.test(assetId)) {
      this.problem(CONVERSION_PROBLEMS.figureAsset);
      return;
    }
    if (!this.figures.has(assetId)) this.figures.set(assetId, { assetId, alt: cleanLine(attrs.alt) });
    out.push({ type: "figure", assetId, caption: cleanLine(attrs.caption) });
  }
}

function headingLevel(level: unknown): 2 | 3 {
  return typeof level === "number" && level >= 3 ? 3 : 2;
}

function confirmText(node: unknown): string {
  const fromAttrs = cleanLine(attrsOf(node).text);
  if (fromAttrs !== null) return fromAttrs;
  const fromContent = cleanLine(childrenOf(node).map((child) => {
    const text = fieldsOf(child)?.text;
    return typeof text === "string" ? text : "";
  }).join(""));
  return fromContent ?? BLANK_CONFIRM;
}

/** `start` / `end` are offsets into `text`; a confirm piece's `text` is the note inside the marker. */
function splitConfirm(text: string): { confirm: boolean; text: string; start: number; end: number }[] {
  const pieces: { confirm: boolean; text: string; start: number; end: number }[] = [];
  let index = 0;
  for (const match of text.matchAll(CONFIRM_MARKER)) {
    const start = match.index;
    if (start > index) pieces.push({ confirm: false, text: text.slice(index, start), start: index, end: start });
    const end = start + match[0].length;
    pieces.push({ confirm: true, text: (match[1] ?? "").trim() || BLANK_CONFIRM, start, end });
    index = end;
  }
  if (index < text.length) pieces.push({ confirm: false, text: text.slice(index), start: index, end: text.length });
  return pieces;
}

/** TipTap content (`doc` node or its top-level node list) → the contract's restricted AST. */
export function toPublishedBlocks(content: unknown): Conversion {
  const converter = new Converter();
  const blocks: Block[] = [];
  let nodes: readonly unknown[];
  if (content === null || content === undefined) nodes = [];
  else if (Array.isArray(content)) nodes = content;
  else if (typeOf(content) === "doc") nodes = childrenOf(content);
  else {
    converter.unknown(content);
    nodes = [];
  }
  for (const node of nodes) converter.top(node, blocks);
  return converter.result(blocks);
}

// --- assets -------------------------------------------------------------------------

export type AssetState = "missing" | "unusable" | "no-consent" | "ok";

/** A published image: present, an image of an allowed type with sane metadata, with 掲載許諾. */
export function assetState(asset: AssetRecord | undefined): AssetState {
  if (!asset) return "missing";
  if (
    asset.kind !== "image"
    || !(IMAGE_CONTENT_TYPES as readonly string[]).includes(asset.contentType)
    || !ASSET_ID_PATTERN.test(asset.id)
    || !SHA256_PATTERN.test(asset.sha256)
    || !Number.isSafeInteger(asset.bytes)
    || asset.bytes < 1
  ) {
    return "unusable";
  }
  return asset.consent === true ? "ok" : "no-consent";
}

/** The URLs the editor's asset store serves. Must be https (checked again by the contract's validator). */
export interface AssetUrls {
  urlFor(asset: { readonly id: string; readonly sha256: string; readonly contentType: string }): string;
}

// --- fingerprint --------------------------------------------------------------------

interface AssetDigest {
  readonly id: string;
  readonly missing?: true;
  readonly sha256?: string;
  readonly contentType?: string;
  readonly bytes?: number;
  readonly alt?: string;
  readonly credit?: string | null;
}

export interface ContentFingerprintInput {
  readonly title: string;
  readonly lang: Lang;
  readonly lead: string | null;
  readonly cover: AssetDigest | null;
  readonly blocks: readonly Block[];
  readonly figures: readonly AssetDigest[];
  /** Problems found while converting (only drafts have them). */
  readonly unresolved: readonly string[];
}

/** SHA-256 of the normalized content. "更新あり" means the draft's fingerprint differs from the published one. */
export async function contentFingerprint(input: ContentFingerprintInput): Promise<string> {
  return sha256Hex(canonicalJson({ v: 1, ...input }));
}

function digest(id: string, asset: AssetRecord | undefined, alt: string): AssetDigest {
  if (!asset) return { id, missing: true };
  return { id, sha256: asset.sha256, contentType: asset.contentType, bytes: asset.bytes, alt, credit: cleanLine(asset.credit) };
}

function publishedAlt(ref: FigureRef | null, asset: AssetRecord | undefined): string {
  return ref?.alt ?? cleanLine(asset?.alt) ?? "";
}

function fingerprintInput(page: DraftPage, assets: ReadonlyMap<string, AssetRecord>, conversion: Conversion): ContentFingerprintInput {
  const cover = page.coverAssetId === null ? null : digest(page.coverAssetId, assets.get(page.coverAssetId), publishedAlt(null, assets.get(page.coverAssetId)));
  return {
    title: cleanLine(page.title) ?? "",
    lang: page.lang,
    lead: cleanLine(page.lead),
    cover,
    blocks: conversion.blocks,
    figures: conversion.figures.map((ref) => digest(ref.assetId, assets.get(ref.assetId), publishedAlt(ref, assets.get(ref.assetId)))),
    unresolved: conversion.problems.map((problem) => `${problem.id}:${problem.node ?? ""}`).sort(),
  };
}

/** The fingerprint of the current draft, comparable with `Snapshot.fingerprint`. */
export async function draftFingerprint(page: DraftPage, assets: readonly AssetRecord[]): Promise<string> {
  const index = new Map(assets.map((asset) => [asset.id, asset] as const));
  return contentFingerprint(fingerprintInput(page, index, toPublishedBlocks(page.content)));
}

// --- snapshot -----------------------------------------------------------------------

export interface SnapshotInput {
  readonly page: DraftPage;
  readonly assets: readonly AssetRecord[];
  readonly dest: Dest;
  readonly slug: string;
  readonly canonicalUrl: string;
  readonly range: PublicationRange;
  readonly extras: Extras;
  readonly category: string | null;
  readonly categoryDisplay?: CategoryDisplay;
  readonly related: readonly string[];
  readonly author: Author;
  readonly version: number;
  readonly publishedAt: string;
  readonly updatedAt: string;
  readonly assetUrls: AssetUrls;
}

/** A published version: a `PublishedDoc` plus the content fingerprint. Deeply frozen. */
export type Snapshot = PublishedDoc & { readonly fingerprint: string };

export interface SnapshotIssue {
  readonly path: string;
  readonly reason: string;
}

export type SnapshotResult =
  | { readonly ok: true; readonly snapshot: Snapshot }
  | { readonly ok: false; readonly reason: "snapshot_invalid"; readonly issues: readonly SnapshotIssue[] };

function invalid(issues: readonly SnapshotIssue[]): SnapshotResult {
  return { ok: false, reason: "snapshot_invalid", issues };
}

function publishedAsset(asset: AssetRecord, alt: string, urls: AssetUrls, path: string, issues: SnapshotIssue[]): PublishedAsset | null {
  const state = assetState(asset);
  if (state !== "ok") {
    issues.push({ path, reason: state });
    return null;
  }
  const url = urls.urlFor({ id: asset.id, sha256: asset.sha256, contentType: asset.contentType });
  if (!isHttpsUrl(url)) {
    issues.push({ path: `${path}.url`, reason: "unsafe-url" });
    return null;
  }
  return {
    id: asset.id,
    url,
    contentType: asset.contentType as PublishedAsset["contentType"],
    bytes: asset.bytes,
    sha256: asset.sha256,
    alt,
    credit: cleanLine(asset.credit),
  };
}

/**
 * Builds an immutable published version from the draft. Fails (`snapshot_invalid`) when the body has
 * conversion problems, an image is missing / unusable / without consent, or the result does not pass
 * the contract's `parsePublishedDoc(doc, { requireProjection: true })`.
 */
export async function buildSnapshot(input: SnapshotInput): Promise<SnapshotResult> {
  const conversion = toPublishedBlocks(input.page.content);
  if (conversion.problems.length > 0) {
    return invalid(conversion.problems.map((problem) => ({ path: "$.blocks", reason: problem.id })));
  }
  const index = new Map(input.assets.map((asset) => [asset.id, asset] as const));
  const issues: SnapshotIssue[] = [];
  const assets: PublishedAsset[] = [];
  conversion.figures.forEach((ref, position) => {
    const asset = index.get(ref.assetId);
    const path = `$.assets[${position}]`;
    if (!asset) {
      issues.push({ path, reason: "missing" });
      return;
    }
    const published = publishedAsset(asset, publishedAlt(ref, asset), input.assetUrls, path, issues);
    if (published) assets.push(published);
  });
  let cover: PublishedAsset | null = null;
  if (input.page.coverAssetId !== null) {
    const asset = index.get(input.page.coverAssetId);
    if (!asset) issues.push({ path: "$.cover", reason: "missing" });
    else cover = publishedAsset(asset, publishedAlt(null, asset), input.assetUrls, "$.cover", issues);
  }
  if (issues.length > 0) return invalid(issues);

  const doc = {
    contractVersion: CONTRACT_VERSION,
    id: input.page.id,
    slug: input.slug,
    dest: input.dest,
    lang: input.page.lang,
    title: cleanLine(input.page.title) ?? "",
    lead: cleanLine(input.page.lead),
    cover,
    category: cleanLine(input.category),
    ...(input.categoryDisplay === undefined ? {} : { categoryDisplay: input.categoryDisplay }),
    author: input.author,
    range: input.range,
    version: input.version,
    publishedAt: input.publishedAt,
    updatedAt: input.updatedAt,
    canonicalUrl: input.canonicalUrl,
    extras: input.extras,
    related: input.related,
    blocks: conversion.blocks,
    markdown: renderMarkdown(conversion.blocks, assets),
    assets,
  };
  const parsed = parsePublishedDoc(doc, { requireProjection: true });
  if (!parsed.ok) return invalid(parsed.errors);
  const fingerprint = await contentFingerprint(fingerprintInput(input.page, index, conversion));
  // Copy before freezing so the caller's inputs (author, extras, related) are never frozen in place.
  const snapshot = JSON.parse(canonicalJson({ ...parsed.value, fingerprint })) as Snapshot;
  return { ok: true, snapshot: deepFreeze(snapshot) };
}

/** Limits a body must respect (counted the way the contract's validator counts them). */
export function exceedsLimits(blocks: readonly Block[]): boolean {
  let nodes = 0;
  for (const block of blocks) {
    nodes += block.type === "note" ? 1 + block.blocks.length : 1;
    if (blockChars(block) > PUBLISHED_LIMITS.maxBlockChars) return true;
  }
  return nodes > PUBLISHED_LIMITS.maxBlocks;
}

function inlineChars(inlines: readonly Inline[]): number {
  let chars = 0;
  for (const inline of inlines) {
    chars += Array.from(inline.text).length;
    if (inline.type === "text") for (const mark of inline.marks ?? []) if (mark.type === "link") chars += Array.from(mark.href).length;
  }
  return chars;
}

function blockChars(block: Block): number {
  switch (block.type) {
    case "paragraph":
    case "quote":
    case "heading":
      return inlineChars(block.content);
    case "list":
      return block.items.reduce((sum, item) => sum + inlineChars(item), 0);
    case "figure":
      return block.caption === null ? 0 : Array.from(block.caption).length;
    case "divider":
      return 0;
    case "note":
      return block.blocks.reduce((sum, child) => sum + blockChars(child), 0);
  }
}
