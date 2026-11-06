/**
 * Runtime validation for what a destination receives. Reject when in doubt:
 * unknown blocks / inlines / marks / nested fields, unsafe URLs, recording
 * assets and anything over the limits. Unknown top-level fields of a document,
 * index item or error body are ignored and dropped (forward compatibility).
 * Issues carry a path and a reason, never the offending value.
 */

import {
  ASSET_ID_PATTERN,
  BLOCK_TYPES,
  CONTRACT_VERSION,
  CURSOR_PATTERN,
  DESTS,
  ERROR_CODES,
  FACE_DESTS,
  IMAGE_CONTENT_TYPES,
  LANGS,
  MARK_TYPES,
  PUBLISHED_LIMITS,
  RANGES,
  SHA256_PATTERN,
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  TIMESTAMP_PATTERN,
  UUID_PATTERN,
  type Author,
  type AuthorProfile,
  type Block,
  type Dest,
  type ErrorBody,
  type Extras,
  type FaceDest,
  type GoneBody,
  type Inline,
  type Mark,
  type MovedTo,
  type NoteChild,
  type PreviewDoc,
  type PreviewInfo,
  type PublishedAsset,
  type PublishedDoc,
  type PublishedIndex,
  type PublishedListItem,
} from "./v1.js";
import { canonicalJson, utf8ByteLength } from "./etag.js";
import { checkMarkdownSubset, renderMarkdown } from "./markdown.js";
import { isHttpsUrl, isSafeLinkHref } from "./url.js";

export { isHttpsUrl, isSafeLinkHref, isSitePath } from "./url.js";

export const VALIDATION_REASONS = [
  "type",
  "required",
  "unknown-field",
  "enum",
  "format",
  "range",
  "empty",
  "control-character",
  "not-json",
  "contract-version",
  "unknown-block",
  "unknown-inline",
  "unknown-mark",
  "duplicate-mark",
  "nested-list",
  "note-child",
  "heading-level",
  "unsafe-link",
  "unsafe-url",
  "missing-asset",
  "duplicate-asset",
  "unreferenced-asset",
  "recording-asset",
  "content-type",
  "block-too-long",
  "too-many-blocks",
  "too-large",
  "too-many-items",
  "markdown-subset",
  "markdown-mismatch",
  "unlisted-site",
  "date-order",
  "duplicate-id",
  "duplicate-value",
  "mixed-dest",
  "dest-mismatch",
  "order",
  "noindex",
  "moved-to",
] as const;
export type ValidationReason = (typeof VALIDATION_REASONS)[number];

export interface ValidationIssue {
  readonly path: string;
  readonly reason: ValidationReason;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ValidationIssue[] };

export const MAX_VALIDATION_ISSUES = 100;

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cs}/u;
const REQUEST_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

class Issues {
  readonly list: ValidationIssue[] = [];
  /** Every issue seen. `list` stops at MAX_VALIDATION_ISSUES, but callers compare `count` before and after a parse. */
  private seen = 0;

  add(path: string, reason: ValidationReason): undefined {
    this.seen += 1;
    if (this.list.length < MAX_VALIDATION_ISSUES) this.list.push({ path, reason });
    return undefined;
  }

  get count(): number {
    return this.seen;
  }
}

type Fields = Readonly<Record<string, unknown>>;
type TextMode = "nonblank" | "nonempty" | "any";

function finish<T>(issues: Issues, value: T | undefined): ValidationResult<T> {
  if (issues.count > 0 || value === undefined) return { ok: false, errors: issues.list };
  return { ok: true, value };
}

function isFields(value: unknown): value is Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function child(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return SAFE_KEY.test(key) ? `${path}.${key}` : `${path}[?]`;
}

/** `allowed === null` ignores unknown keys (top level); otherwise they are rejected. */
function fieldsAt(value: unknown, path: string, issues: Issues, allowed: readonly string[] | null): Fields | undefined {
  if (value === undefined) return issues.add(path, "required");
  if (!isFields(value)) return issues.add(path, "type");
  if (allowed) {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.add(child(path, key), "unknown-field");
  }
  return value;
}

function arrayAt(value: unknown, path: string, issues: Issues): readonly unknown[] | undefined {
  if (value === undefined) return issues.add(path, "required");
  return Array.isArray(value) ? value : issues.add(path, "type");
}

function textAt(value: unknown, path: string, issues: Issues, mode: TextMode = "nonblank"): string | undefined {
  if (value === undefined) return issues.add(path, "required");
  if (typeof value !== "string") return issues.add(path, "type");
  if (CONTROL.test(value)) return issues.add(path, "control-character");
  if ((mode === "nonblank" && value.trim() === "") || (mode === "nonempty" && value === "")) return issues.add(path, "empty");
  return value;
}

function nullableTextAt(value: unknown, path: string, issues: Issues): string | null | undefined {
  return value === null ? null : textAt(value, path, issues);
}

function patternAt(value: unknown, pattern: RegExp, path: string, issues: Issues): string | undefined {
  if (value === undefined) return issues.add(path, "required");
  if (typeof value !== "string") return issues.add(path, "type");
  return pattern.test(value) ? value : issues.add(path, "format");
}

function enumAt<T extends string>(value: unknown, allowed: readonly T[], path: string, issues: Issues): T | undefined {
  if (value === undefined) return issues.add(path, "required");
  if (typeof value !== "string") return issues.add(path, "type");
  return (allowed as readonly string[]).includes(value) ? (value as T) : issues.add(path, "enum");
}

function booleanAt(value: unknown, path: string, issues: Issues): boolean | undefined {
  if (value === undefined) return issues.add(path, "required");
  return typeof value === "boolean" ? value : issues.add(path, "type");
}

function positiveIntegerAt(value: unknown, path: string, issues: Issues): number | undefined {
  if (value === undefined) return issues.add(path, "required");
  if (typeof value !== "number") return issues.add(path, "type");
  return Number.isSafeInteger(value) && value >= 1 ? value : issues.add(path, "range");
}

function isTimestamp(value: string): boolean {
  if (!TIMESTAMP_PATTERN.test(value)) return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
}

function timestampAt(value: unknown, path: string, issues: Issues): string | undefined {
  if (value === undefined) return issues.add(path, "required");
  if (typeof value !== "string") return issues.add(path, "type");
  return isTimestamp(value) ? value : issues.add(path, "format");
}

function httpsAt(value: unknown, path: string, issues: Issues): string | undefined {
  if (value === undefined) return issues.add(path, "required");
  if (typeof value !== "string") return issues.add(path, "type");
  return isHttpsUrl(value) ? value : issues.add(path, "unsafe-url");
}

function slugAt(value: unknown, path: string, issues: Issues): string | undefined {
  const slug = patternAt(value, SLUG_PATTERN, path, issues);
  if (slug !== undefined && slug.length > SLUG_MAX_LENGTH) return issues.add(path, "format");
  return slug;
}

function codePointLength(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
    length += 1;
  }
  return length;
}

// --- assets -------------------------------------------------------------------

const ASSET_KEYS = ["id", "url", "contentType", "bytes", "sha256", "alt", "credit"] as const;

/** Recording assets are never published; neither is anything but a raster image. */
function contentTypeAt(value: unknown, path: string, issues: Issues): string | undefined {
  if (typeof value === "string" && value.toLowerCase().startsWith("audio/")) return issues.add(path, "recording-asset");
  if (typeof value === "string" && !(IMAGE_CONTENT_TYPES as readonly string[]).includes(value)) {
    return issues.add(path, "content-type");
  }
  return enumAt(value, IMAGE_CONTENT_TYPES, path, issues);
}

function assetAt(value: unknown, path: string, issues: Issues): PublishedAsset | undefined {
  const fields = fieldsAt(value, path, issues, ASSET_KEYS);
  if (!fields) return undefined;
  const before = issues.count;
  const asset = {
    id: patternAt(fields.id, ASSET_ID_PATTERN, child(path, "id"), issues),
    url: httpsAt(fields.url, child(path, "url"), issues),
    contentType: contentTypeAt(fields.contentType, child(path, "contentType"), issues),
    bytes: positiveIntegerAt(fields.bytes, child(path, "bytes"), issues),
    sha256: patternAt(fields.sha256, SHA256_PATTERN, child(path, "sha256"), issues),
    alt: textAt(fields.alt, child(path, "alt"), issues, "any"),
    credit: nullableTextAt(fields.credit, child(path, "credit"), issues),
  };
  return issues.count === before ? (asset as PublishedAsset) : undefined;
}

interface AssetIndex {
  readonly valid: ReadonlyMap<string, PublishedAsset>;
  /** Every well-formed id and its position, so one bad field does not also fail the figures that use it. */
  readonly ids: ReadonlyMap<string, number>;
}

function assetsAt(value: unknown, path: string, issues: Issues): AssetIndex | undefined {
  const list = arrayAt(value, path, issues);
  if (!list) return undefined;
  const valid = new Map<string, PublishedAsset>();
  const ids = new Map<string, number>();
  list.forEach((entry, index) => {
    const assetPath = child(path, index);
    const id = isFields(entry) && typeof entry.id === "string" && ASSET_ID_PATTERN.test(entry.id) ? entry.id : undefined;
    if (id !== undefined && ids.has(id)) return issues.add(child(assetPath, "id"), "duplicate-asset");
    if (id !== undefined) ids.set(id, index);
    const asset = assetAt(entry, assetPath, issues);
    if (asset) valid.set(asset.id, asset);
    return undefined;
  });
  return { valid, ids };
}

// --- inline / blocks ------------------------------------------------------------

interface BlockContext {
  readonly issues: Issues;
  readonly assetIds: { has(id: string): boolean };
  readonly referenced: Set<string>;
  nodes: number;
  /** Characters of the current top-level block. */
  chars: number;
}

function marksAt(value: unknown, path: string, context: BlockContext): readonly Mark[] | undefined {
  const { issues } = context;
  const list = arrayAt(value, path, issues);
  if (!list) return undefined;
  const before = issues.count;
  const seen = new Set<string>();
  const marks: Mark[] = [];
  list.forEach((entry, index) => {
    const markPath = child(path, index);
    if (!isFields(entry)) return issues.add(markPath, "type");
    const type = entry.type;
    if (typeof type !== "string" || !(MARK_TYPES as readonly string[]).includes(type)) {
      return issues.add(child(markPath, "type"), "unknown-mark");
    }
    if (seen.has(type)) return issues.add(child(markPath, "type"), "duplicate-mark");
    seen.add(type);
    if (type === "link") {
      fieldsAt(entry, markPath, issues, ["type", "href"]);
      const href = entry.href;
      if (href === undefined) return issues.add(child(markPath, "href"), "required");
      if (typeof href !== "string") return issues.add(child(markPath, "href"), "type");
      if (!isSafeLinkHref(href)) return issues.add(child(markPath, "href"), "unsafe-link");
      context.chars += codePointLength(href);
      marks.push({ type: "link", href });
      return undefined;
    }
    fieldsAt(entry, markPath, issues, ["type"]);
    marks.push({ type } as Mark);
    return undefined;
  });
  return issues.count === before ? marks : undefined;
}

function inlineAt(value: unknown, path: string, context: BlockContext, inListItem: boolean): Inline | undefined {
  const { issues } = context;
  if (!isFields(value)) return issues.add(path, value === undefined ? "required" : "type");
  const type = value.type;
  if (type === "text") {
    if (!fieldsAt(value, path, issues, ["type", "text", "marks"])) return undefined;
    const text = textAt(value.text, child(path, "text"), issues, "nonempty");
    const marks = value.marks === undefined ? undefined : marksAt(value.marks, child(path, "marks"), context);
    if (text === undefined || (value.marks !== undefined && marks === undefined)) return undefined;
    context.chars += codePointLength(text);
    return marks === undefined ? { type: "text", text } : { type: "text", text, marks };
  }
  if (type === "confirm") {
    if (!fieldsAt(value, path, issues, ["type", "text"])) return undefined;
    const text = textAt(value.text, child(path, "text"), issues);
    if (text === undefined) return undefined;
    context.chars += codePointLength(text);
    return { type: "confirm", text };
  }
  if (inListItem && type === "list") return issues.add(path, "nested-list");
  return issues.add(child(path, "type"), "unknown-inline");
}

function inlinesAt(value: unknown, path: string, context: BlockContext, inListItem = false): readonly Inline[] | undefined {
  const { issues } = context;
  const list = arrayAt(value, path, issues);
  if (!list) return undefined;
  if (list.length === 0) return issues.add(path, "empty");
  const before = issues.count;
  const inlines = list.map((entry, index) => inlineAt(entry, child(path, index), context, inListItem));
  if (issues.count !== before) return undefined;
  const valid = inlines as readonly Inline[];
  if (!valid.some((inline) => inline.type === "confirm" || inline.text.trim() !== "")) return issues.add(path, "empty");
  return valid;
}

function blockAt(value: unknown, path: string, context: BlockContext, inNote: boolean): Block | undefined {
  const { issues } = context;
  if (!isFields(value)) return issues.add(path, value === undefined ? "required" : "type");
  context.nodes += 1;
  const type = value.type;
  if (typeof type !== "string" || !(BLOCK_TYPES as readonly string[]).includes(type)) {
    return issues.add(child(path, "type"), "unknown-block");
  }
  if (inNote && type !== "paragraph" && type !== "list") return issues.add(child(path, "type"), "note-child");
  const before = issues.count;
  let block: Block | undefined;
  switch (type) {
    case "paragraph":
    case "quote": {
      fieldsAt(value, path, issues, ["type", "content"]);
      const content = inlinesAt(value.content, child(path, "content"), context);
      block = content && (type === "paragraph" ? { type, content } : { type: "quote", content });
      break;
    }
    case "heading": {
      fieldsAt(value, path, issues, ["type", "level", "content"]);
      const level = value.level === 2 || value.level === 3 ? value.level : issues.add(child(path, "level"), "heading-level");
      const content = inlinesAt(value.content, child(path, "content"), context);
      block = level && content && { type: "heading", level, content };
      break;
    }
    case "list": {
      fieldsAt(value, path, issues, ["type", "ordered", "items"]);
      const ordered = booleanAt(value.ordered, child(path, "ordered"), issues);
      const itemsPath = child(path, "items");
      const list = arrayAt(value.items, itemsPath, issues);
      if (list && list.length === 0) issues.add(itemsPath, "empty");
      const items = list?.map((item, index) => {
        const itemPath = child(itemsPath, index);
        if (isFields(item) && item.type === "list") return issues.add(itemPath, "nested-list");
        return inlinesAt(item, itemPath, context, true);
      });
      block = ordered !== undefined && items ? { type: "list", ordered, items: items as readonly (readonly Inline[])[] } : undefined;
      break;
    }
    case "figure": {
      fieldsAt(value, path, issues, ["type", "assetId", "caption"]);
      const assetPath = child(path, "assetId");
      const assetId = patternAt(value.assetId, ASSET_ID_PATTERN, assetPath, issues);
      if (assetId !== undefined) {
        if (context.assetIds.has(assetId)) context.referenced.add(assetId);
        else issues.add(assetPath, "missing-asset");
      }
      const caption = value.caption === undefined
        ? issues.add(child(path, "caption"), "required")
        : nullableTextAt(value.caption, child(path, "caption"), issues);
      if (typeof caption === "string") context.chars += codePointLength(caption);
      block = assetId !== undefined && caption !== undefined ? { type: "figure", assetId, caption } : undefined;
      break;
    }
    case "divider":
      fieldsAt(value, path, issues, ["type"]);
      block = { type: "divider" };
      break;
    case "note": {
      fieldsAt(value, path, issues, ["type", "blocks"]);
      const childrenPath = child(path, "blocks");
      const list = arrayAt(value.blocks, childrenPath, issues);
      if (list && list.length === 0) issues.add(childrenPath, "empty");
      const children = list?.map((entry, index) => blockAt(entry, child(childrenPath, index), context, true));
      block = children ? { type: "note", blocks: children as readonly NoteChild[] } : undefined;
      break;
    }
  }
  return issues.count === before ? block : undefined;
}

function blocksAt(value: unknown, path: string, context: BlockContext): readonly Block[] | undefined {
  const { issues } = context;
  const list = arrayAt(value, path, issues);
  if (!list) return undefined;
  if (list.length > PUBLISHED_LIMITS.maxBlocks) return issues.add(path, "too-many-blocks");
  const before = issues.count;
  const blocks = list.map((entry, index) => {
    context.chars = 0;
    const blockPath = child(path, index);
    const block = blockAt(entry, blockPath, context, false);
    if (context.chars > PUBLISHED_LIMITS.maxBlockChars) issues.add(blockPath, "block-too-long");
    return block;
  });
  if (context.nodes > PUBLISHED_LIMITS.maxBlocks) issues.add(path, "too-many-blocks");
  return issues.count === before ? (blocks as readonly Block[]) : undefined;
}

/** Validates an AST. Figures must refer to one of `assets`. */
export function parseBlocks(input: unknown, assets: readonly PublishedAsset[] = []): ValidationResult<readonly Block[]> {
  const issues = new Issues();
  const context: BlockContext = {
    issues,
    assetIds: new Set(assets.map((asset) => asset.id)),
    referenced: new Set(),
    nodes: 0,
    chars: 0,
  };
  return finish(issues, blocksAt(input, "$", context));
}

// --- documents -------------------------------------------------------------------

function authorAt(value: unknown, path: string, issues: Issues): Author | undefined {
  const fields = fieldsAt(value, path, issues, ["name", "handle", "url"]);
  if (!fields) return undefined;
  const before = issues.count;
  const author = {
    name: textAt(fields.name, child(path, "name"), issues),
    handle: fields.handle === undefined ? issues.add(child(path, "handle"), "required") : nullableTextAt(fields.handle, child(path, "handle"), issues),
    url: fields.url === null ? null : httpsAt(fields.url, child(path, "url"), issues),
  };
  return issues.count === before ? (author as Author) : undefined;
}

function extrasAt(value: unknown, path: string, issues: Issues): Extras | undefined {
  const fields = fieldsAt(value, path, issues, ["app", "news", "xp"]);
  if (!fields) return undefined;
  const before = issues.count;
  const extras = {
    app: booleanAt(fields.app, child(path, "app"), issues),
    news: booleanAt(fields.news, child(path, "news"), issues),
    xp: booleanAt(fields.xp, child(path, "xp"), issues),
  };
  return issues.count === before ? (extras as Extras) : undefined;
}

function relatedAt(value: unknown, path: string, issues: Issues): readonly string[] | undefined {
  const list = arrayAt(value, path, issues);
  if (!list) return undefined;
  const before = issues.count;
  const seen = new Set<string>();
  const related = list.map((entry, index) => {
    const slug = slugAt(entry, child(path, index), issues);
    if (slug !== undefined && seen.has(slug)) issues.add(child(path, index), "duplicate-value");
    if (slug !== undefined) seen.add(slug);
    return slug;
  });
  return issues.count === before ? (related as readonly string[]) : undefined;
}

function categoryDisplayAt(value: unknown, path: string, issues: Issues): import("./v1.js").CategoryDisplay | undefined {
  if (value === undefined) return undefined;
  const fields = fieldsAt(value, path, issues, ["labelEn", "labelJa", "displayOrder", "revision"]);
  if (!fields) return undefined;
  const before = issues.count;
  const labelEn = textAt(fields.labelEn, child(path, "labelEn"), issues);
  const labelJa = textAt(fields.labelJa, child(path, "labelJa"), issues);
  const displayOrder = Number.isSafeInteger(fields.displayOrder) && (fields.displayOrder as number) >= 0
    ? fields.displayOrder as number
    : issues.add(child(path, "displayOrder"), "range");
  const revision = positiveIntegerAt(fields.revision, child(path, "revision"), issues);
  if (typeof labelEn === "string" && labelEn.length > 120) issues.add(child(path, "labelEn"), "too-large");
  if (typeof labelJa === "string" && labelJa.length > 120) issues.add(child(path, "labelJa"), "too-large");
  if (typeof displayOrder === "number" && displayOrder > 1_000_000) issues.add(child(path, "displayOrder"), "too-large");
  return issues.count === before && labelEn !== undefined && labelJa !== undefined && displayOrder !== undefined && revision !== undefined
    ? { labelEn, labelJa, displayOrder, revision }
    : undefined;
}

/** Optional; when present it is exactly `true` (absence means "not confirmed"). */
function coverShareableAt(value: unknown, path: string, issues: Issues): true | undefined {
  if (value === undefined || value === true) return value;
  return issues.add(path, typeof value === "boolean" ? "enum" : "type");
}

function profileTextAt(value: unknown, path: string, issues: Issues, max: number): string | null | undefined {
  if (value === undefined) return issues.add(path, "required");
  const text = nullableTextAt(value, path, issues);
  if (typeof text === "string" && codePointLength(text) > max) return issues.add(path, "too-large");
  return text;
}

/** Optional; `role` and `bio` only, each null or a non-blank single line within its limit, not both null. */
function authorProfileAt(value: unknown, path: string, issues: Issues): AuthorProfile | undefined {
  if (value === undefined) return undefined;
  const fields = fieldsAt(value, path, issues, ["role", "bio"]);
  if (!fields) return undefined;
  const before = issues.count;
  const role = profileTextAt(fields.role, child(path, "role"), issues, PUBLISHED_LIMITS.maxAuthorRoleChars);
  const bio = profileTextAt(fields.bio, child(path, "bio"), issues, PUBLISHED_LIMITS.maxAuthorBioChars);
  if (issues.count !== before || role === undefined || bio === undefined) return undefined;
  if (role === null && bio === null) return issues.add(path, "empty");
  return { role, bio };
}

function listItemAt(fields: Fields, path: string, issues: Issues): PublishedListItem | undefined {
  const before = issues.count;
  const categoryDisplay = categoryDisplayAt(fields.categoryDisplay, child(path, "categoryDisplay"), issues);
  const coverShareable = coverShareableAt(fields.coverShareable, child(path, "coverShareable"), issues);
  const authorProfile = authorProfileAt(fields.authorProfile, child(path, "authorProfile"), issues);
  const item = {
    id: patternAt(fields.id, UUID_PATTERN, child(path, "id"), issues),
    slug: slugAt(fields.slug, child(path, "slug"), issues),
    dest: enumAt(fields.dest, DESTS, child(path, "dest"), issues),
    lang: enumAt(fields.lang, LANGS, child(path, "lang"), issues),
    title: textAt(fields.title, child(path, "title"), issues),
    lead: fields.lead === undefined ? issues.add(child(path, "lead"), "required") : nullableTextAt(fields.lead, child(path, "lead"), issues),
    cover: fields.cover === null ? null : assetAt(fields.cover, child(path, "cover"), issues),
    ...(coverShareable === undefined ? {} : { coverShareable }),
    category: fields.category === undefined
      ? issues.add(child(path, "category"), "required")
      : nullableTextAt(fields.category, child(path, "category"), issues),
    ...(categoryDisplay === undefined ? {} : { categoryDisplay }),
    author: authorAt(fields.author, child(path, "author"), issues),
    ...(authorProfile === undefined ? {} : { authorProfile }),
    range: enumAt(fields.range, RANGES, child(path, "range"), issues),
    version: positiveIntegerAt(fields.version, child(path, "version"), issues),
    publishedAt: timestampAt(fields.publishedAt, child(path, "publishedAt"), issues),
    updatedAt: timestampAt(fields.updatedAt, child(path, "updatedAt"), issues),
    canonicalUrl: httpsAt(fields.canonicalUrl, child(path, "canonicalUrl"), issues),
    extras: extrasAt(fields.extras, child(path, "extras"), issues),
    related: relatedAt(fields.related, child(path, "related"), issues),
  };
  if (fields.categoryDisplay !== undefined && categoryDisplay === undefined) issues.add(child(path, "categoryDisplay"), "format");
  if (categoryDisplay !== undefined && item.category === null) issues.add(child(path, "categoryDisplay"), "required");
  // The share permission is the cover's: there is nothing to share without one.
  if (coverShareable !== undefined && fields.cover === null) issues.add(child(path, "coverShareable"), "required");
  // Limited release ("unlisted") exists only on NIHO-operated faces.
  if (item.dest === "site" && item.range === "unlisted") issues.add(child(path, "range"), "unlisted-site");
  if (item.publishedAt && item.updatedAt && Date.parse(item.updatedAt) < Date.parse(item.publishedAt)) {
    issues.add(child(path, "updatedAt"), "date-order");
  }
  return issues.count === before ? (item as PublishedListItem) : undefined;
}

function contractVersionAt(value: unknown, path: string, issues: Issues): typeof CONTRACT_VERSION | undefined {
  if (value === undefined) return issues.add(path, "required");
  return value === CONTRACT_VERSION ? CONTRACT_VERSION : issues.add(path, "contract-version");
}

export interface IndexOptions {
  /** The destination of the handle that was read; every item must belong to it. */
  readonly dest?: Dest;
}

export function parsePublishedIndex(input: unknown, options: IndexOptions = {}): ValidationResult<PublishedIndex> {
  const issues = new Issues();
  const fields = fieldsAt(input, "$", issues, null);
  if (!fields) return finish<PublishedIndex>(issues, undefined);
  const contractVersion = contractVersionAt(fields.contractVersion, "$.contractVersion", issues);
  const list = arrayAt(fields.items, "$.items", issues);
  if (list && list.length > PUBLISHED_LIMITS.maxLimit) {
    issues.add("$.items", "too-many-items");
    return finish<PublishedIndex>(issues, undefined);
  }
  const items: (PublishedListItem | undefined)[] = (list ?? []).map((entry, index) => {
    const path = child("$.items", index);
    const itemFields = fieldsAt(entry, path, issues, null);
    return itemFields && listItemAt(itemFields, path, issues);
  });
  const nextCursor = fields.nextCursor === null ? null : patternAt(fields.nextCursor, CURSOR_PATTERN, "$.nextCursor", issues);
  const seen = new Set<string>();
  const first = items.find((candidate) => candidate !== undefined);
  let previous: PublishedListItem | undefined;
  items.forEach((item, index) => {
    if (!item) return;
    const path = child("$.items", index);
    if (seen.has(item.id)) issues.add(child(path, "id"), "duplicate-id");
    seen.add(item.id);
    if (options.dest !== undefined && item.dest !== options.dest) issues.add(child(path, "dest"), "dest-mismatch");
    else if (first && item.dest !== first.dest) issues.add(child(path, "dest"), "mixed-dest");
    if (previous) {
      const before = Date.parse(previous.updatedAt);
      const current = Date.parse(item.updatedAt);
      if (current > before || (current === before && item.id < previous.id)) issues.add(path, "order");
    }
    previous = item;
  });
  if (!list || contractVersion === undefined || nextCursor === undefined) return finish<PublishedIndex>(issues, undefined);
  return finish(issues, { contractVersion, items: items as readonly PublishedListItem[], nextCursor });
}

export interface DocOptions {
  /**
   * Also require `markdown` to equal the projection of `blocks` (`renderMarkdown`). Servers use this to check what
   * they are about to serve; destinations leave it off, so a snapshot stored under an older projection stays readable
   * while its Markdown is still checked against the subset.
   */
  readonly requireProjection?: boolean;
}

function docAt(input: unknown, issues: Issues, options: DocOptions): PublishedDoc | undefined {
  const fields = fieldsAt(input, "$", issues, null);
  if (!fields) return undefined;
  let canonical: string;
  try {
    canonical = canonicalJson(fields);
  } catch {
    return issues.add("$", "not-json");
  }
  if (utf8ByteLength(canonical) > PUBLISHED_LIMITS.maxDocBytes) return issues.add("$", "too-large");
  const before = issues.count;
  const item = listItemAt(fields, "$", issues);
  const assetsBefore = issues.count;
  const index = assetsAt(fields.assets, "$.assets", issues);
  const assets = index && issues.count === assetsBefore ? [...index.valid.values()] : undefined;
  const context: BlockContext = { issues, assetIds: index?.ids ?? new Set<string>(), referenced: new Set(), nodes: 0, chars: 0 };
  const blocks = blocksAt(fields.blocks, "$.blocks", context);
  if (index && blocks) {
    for (const id of index.valid.keys()) {
      if (!context.referenced.has(id)) issues.add(child(child("$.assets", index.ids.get(id) ?? 0), "id"), "unreferenced-asset");
    }
  }
  // Newlines are part of Markdown; the subset checker rejects every other control character.
  const markdown = fields.markdown === undefined
    ? issues.add("$.markdown", "required")
    : typeof fields.markdown === "string" ? fields.markdown : issues.add("$.markdown", "type");
  if (markdown !== undefined && blocks && assets) {
    if (checkMarkdownSubset(markdown).length > 0) issues.add("$.markdown", "markdown-subset");
    else if (options.requireProjection === true && markdown !== renderMarkdown(blocks, assets)) {
      issues.add("$.markdown", "markdown-mismatch");
    }
  }
  const contractVersion = contractVersionAt(fields.contractVersion, "$.contractVersion", issues);
  if (issues.count !== before || !item || !assets || !blocks || markdown === undefined || !contractVersion) return undefined;
  return { ...item, blocks, markdown, assets, contractVersion };
}

export function parsePublishedDoc(input: unknown, options: DocOptions = {}): ValidationResult<PublishedDoc> {
  const issues = new Issues();
  const doc = docAt(input, issues, options);
  return finish(issues, doc);
}

export function parsePreviewDoc(input: unknown, options: DocOptions = {}): ValidationResult<PreviewDoc> {
  const issues = new Issues();
  const doc = docAt(input, issues, options);
  const raw = isFields(input) ? input.preview : undefined;
  const fields = fieldsAt(raw, "$.preview", issues, ["expiresAt", "dest", "noindex"]);
  let preview: PreviewInfo | undefined;
  if (fields) {
    const before = issues.count;
    const expiresAt = timestampAt(fields.expiresAt, "$.preview.expiresAt", issues);
    const dest = enumAt(fields.dest, DESTS, "$.preview.dest", issues);
    if (fields.noindex !== true) issues.add("$.preview.noindex", fields.noindex === undefined ? "required" : "noindex");
    if (doc && dest !== undefined && dest !== doc.dest) issues.add("$.preview.dest", "dest-mismatch");
    if (issues.count === before && expiresAt !== undefined && dest !== undefined) preview = { expiresAt, dest, noindex: true };
  }
  return finish(issues, doc && preview && { ...doc, preview });
}

// --- error bodies ------------------------------------------------------------------

export interface ErrorBodyOptions {
  /** The face whose handle was read. `movedTo` must point elsewhere. */
  readonly from?: FaceDest;
}

function errorBodyAt(input: unknown, issues: Issues, options: ErrorBodyOptions): (ErrorBody & { readonly movedTo?: MovedTo }) | undefined {
  const fields = fieldsAt(input, "$", issues, null);
  if (!fields) return undefined;
  const before = issues.count;
  const errorFields = fieldsAt(fields.error, "$.error", issues, ["code", "requestId", "retryable"]);
  const code = errorFields && enumAt(errorFields.code, ERROR_CODES, "$.error.code", issues);
  const requestId = errorFields && patternAt(errorFields.requestId, REQUEST_ID_PATTERN, "$.error.requestId", issues);
  const retryable = errorFields && booleanAt(errorFields.retryable, "$.error.retryable", issues);
  let movedTo: MovedTo | undefined;
  if (fields.movedTo !== undefined) {
    // Only a 410 after a face-to-face move may say where the page went.
    if (code !== undefined && code !== "gone") issues.add("$.movedTo", "moved-to");
    const movedFields = fieldsAt(fields.movedTo, "$.movedTo", issues, ["dest", "canonicalUrl"]);
    const dest = movedFields && enumAt(movedFields.dest, FACE_DESTS, "$.movedTo.dest", issues);
    const canonicalUrl = movedFields && httpsAt(movedFields.canonicalUrl, "$.movedTo.canonicalUrl", issues);
    if (dest !== undefined && dest === options.from) issues.add("$.movedTo.dest", "dest-mismatch");
    if (dest !== undefined && canonicalUrl !== undefined) movedTo = { dest, canonicalUrl };
  }
  if (issues.count !== before || code === undefined || requestId === undefined || retryable === undefined) return undefined;
  const error = { code, requestId, retryable };
  return movedTo ? { error, movedTo } : { error };
}

export function parseErrorBody(input: unknown, options: ErrorBodyOptions = {}): ValidationResult<ErrorBody & { readonly movedTo?: MovedTo }> {
  const issues = new Issues();
  return finish(issues, errorBodyAt(input, issues, options));
}

/** For faces handling a 410: `movedTo` is present only after a face-to-face move. */
export function parseGoneBody(input: unknown, options: ErrorBodyOptions = {}): ValidationResult<GoneBody> {
  const issues = new Issues();
  const body = errorBodyAt(input, issues, options);
  if (body && body.error.code !== "gone") issues.add("$.error.code", "enum");
  return finish(issues, body as GoneBody | undefined);
}
