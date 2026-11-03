import { IMAGE_ALT_MAX_CHARS, IMAGE_CREDIT_MAX_CHARS } from "./image-limits";

/**
 * 本文のブロック（JSON の値の配列の 1 つ）。正本の型は `@niho/editor-store` の `Block` で、同じ形をここにも置く
 * （Mac・Web のどちらからも、DB の driver を持ち込まずにこの検査を使えるように）。
 */
export type Block = { readonly [key: string]: unknown };

/**
 * ページの本文（限定 AST）。設計 §3・Issue #33。Mac（apps/docs）と Web（apps/editor-web）で同じこの実装を使う。
 *
 * 本文は TipTap の doc の content（ブロックの配列）をそのまま保存する。保存してよい形はここで決め、
 * それ以外（HTML・未知の node・mark・属性、javascript: のリンクなど）は保存前に断る。
 * 保存する値は入力をそのまま返さず、許す形だけで組み直した写し（`blocks`）にする。
 *
 * - ブロック: 段落・見出し（2・3）・箇条書き・チェックリスト・番号付き・表・コード・引用・囲み・区切り線・画像・録音
 * - 行の中: 文字（太字・斜体・取り消し線・インラインコード・リンク）・改行
 * - 画像・録音は資産の id だけを持つ（URL・HTML・外部の src は持たない）。画像の実体は private bucket で、描くときに
 *   サーバーが中継する（apps/editor-web の src/image/image-paths.ts・src/server/images-api.ts）。録音の実体の扱いは #36。
 */

/** ブロックの入れ子の深さの上限（引用の中の引用…）。 */
export const MAX_BLOCK_NESTING = 16;
/** リンク先の長さの上限。 */
export const MAX_LINK_CHARS = 2048;
/** リンクに使える scheme（相対・data・javascript は保存しない）。 */
export const LINK_PROTOCOLS: readonly string[] = ["https:", "http:", "mailto:"];

/** 画像の alt・クレジットの上限（DB の assets・画像の上限（image-limits.ts）と同じ 1 か所から）。 */
const MAX_ALT_CHARS = IMAGE_ALT_MAX_CHARS;
const MAX_CREDIT_CHARS = IMAGE_CREDIT_MAX_CHARS;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Content = "inline" | "code" | "blocks" | "listItems" | "taskItems" | "tableRows" | "tableCells" | "none";

type NodeSpec = {
  content: Content;
  /** 子が 1 つ以上いるか（空の段落は許すが、空の引用・項目は許さない）。 */
  nonEmpty?: boolean;
  attrs?: (raw: Record<string, unknown>) => Record<string, unknown>;
};

export type AstResult = { ok: true; blocks: Block[] } | { ok: false; reason: string };

class AstError extends Error {
  override readonly name = "AstError";
}

function fail(path: string, message: string): never {
  throw new AstError(`${path}: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  // JSON.parse の値は Object.prototype、ProseMirror の attrs は prototype を持たない
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && Array.from(value).length <= max && !value.includes("\u0000");
}

/** 属性は許す名前だけ。それ以外が 1 つでもあれば断る（`ignored` は TipTap が付ける既定値で、保存しない）。 */
function pick(path: string, raw: Record<string, unknown>, allowed: readonly string[], ignored: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (allowed.includes(key)) out[key] = raw[key];
    else if (!ignored.includes(key)) fail(path, `unknown attribute "${key}"`);
  }
  return out;
}

const NODES: Record<string, NodeSpec> = {
  paragraph: { content: "inline", attrs: (raw) => pick("paragraph", raw, []) },
  heading: {
    content: "inline",
    attrs: (raw) => {
      const { level } = pick("heading", raw, ["level"]);
      // 見出し 1 は題名の役。本文は 2・3 だけ。
      if (level !== 2 && level !== 3) fail("heading", "level must be 2 or 3");
      return { level };
    },
  },
  bulletList: { content: "listItems", nonEmpty: true, attrs: (raw) => pick("bulletList", raw, []) },
  taskList: { content: "taskItems", nonEmpty: true, attrs: (raw) => pick("taskList", raw, []) },
  taskItem: {
    content: "blocks",
    nonEmpty: true,
    attrs: (raw) => {
      const { checked } = pick("taskItem", raw, ["checked"]);
      if (checked !== undefined && typeof checked !== "boolean") fail("taskItem", "checked must be a boolean");
      return { checked: checked === true };
    },
  },
  orderedList: {
    content: "listItems",
    nonEmpty: true,
    attrs: (raw) => {
      const { start } = pick("orderedList", raw, ["start"], ["type"]);
      if (start === undefined || start === null || start === 1) return {};
      if (typeof start !== "number") fail("orderedList", "invalid start");
      // 貼り付けた <ol start="0"> や「0. 」の入力規則はエディタが 0・負・巨大な番号を作る。番号の起点にすぎないので、
      // 範囲外は既定（1）へ丸める。断ると自動保存が 400 で止まり続ける。
      if (!Number.isInteger(start) || start < 1 || start > 999_999) return {};
      return { start };
    },
  },
  listItem: { content: "blocks", nonEmpty: true, attrs: (raw) => pick("listItem", raw, []) },
  table: { content: "tableRows", nonEmpty: true, attrs: (raw) => pick("table", raw, []) },
  tableRow: { content: "tableCells", nonEmpty: true, attrs: (raw) => pick("tableRow", raw, []) },
  tableCell: { content: "blocks", nonEmpty: true, attrs: tableCellAttrs },
  tableHeader: { content: "blocks", nonEmpty: true, attrs: tableCellAttrs },
  codeBlock: {
    content: "code",
    attrs: (raw) => {
      const { language } = pick("codeBlock", raw, ["language"]);
      if (language === undefined || language === null || language === "") return {};
      if (typeof language !== "string" || language.length > 32 || !/^[a-zA-Z0-9_+#.-]+$/.test(language)) fail("codeBlock", "invalid language");
      return { language };
    },
  },
  blockquote: { content: "blocks", nonEmpty: true, attrs: (raw) => pick("blockquote", raw, []) },
  callout: { content: "blocks", nonEmpty: true, attrs: (raw) => pick("callout", raw, []) },
  horizontalRule: { content: "none", attrs: (raw) => pick("horizontalRule", raw, []) },
  image: {
    content: "none",
    attrs: (raw) => {
      const { assetId, alt, credit, consent } = pick("image", raw, ["assetId", "alt", "credit", "consent"]);
      if (typeof assetId !== "string" || !UUID_PATTERN.test(assetId)) fail("image", "assetId must be a uuid");
      const out: Record<string, unknown> = { assetId };
      if (alt !== undefined && alt !== null) {
        if (!isText(alt, MAX_ALT_CHARS)) fail("image", "invalid alt");
        out.alt = alt;
      }
      if (credit !== undefined && credit !== null) {
        if (!isText(credit, MAX_CREDIT_CHARS)) fail("image", "invalid credit");
        out.credit = credit;
      }
      if (consent !== undefined && consent !== null) {
        if (typeof consent !== "boolean") fail("image", "invalid consent");
        out.consent = consent;
      }
      return out;
    },
  },
  recording: {
    content: "none",
    attrs: (raw) => {
      const { assetId } = pick("recording", raw, ["assetId"]);
      if (typeof assetId !== "string" || !UUID_PATTERN.test(assetId)) fail("recording", "assetId must be a uuid");
      return { assetId };
    },
  },
};

function tableCellAttrs(raw: Record<string, unknown>): Record<string, unknown> {
  const { colspan = 1, rowspan = 1, colwidth = null, align = null } = pick("tableCell", raw, ["colspan", "rowspan", "colwidth", "align"]);
  if (!Number.isSafeInteger(colspan) || (colspan as number) < 1 || (colspan as number) > 100) fail("tableCell", "invalid colspan");
  if (!Number.isSafeInteger(rowspan) || (rowspan as number) < 1 || (rowspan as number) > 100) fail("tableCell", "invalid rowspan");
  if (colwidth !== null && (!Array.isArray(colwidth) || colwidth.length !== colspan || colwidth.some((width) => width !== null && (!Number.isSafeInteger(width) || (width as number) < 1 || (width as number) > 10_000)))) {
    fail("tableCell", "invalid colwidth");
  }
  if (align !== null && align !== "left" && align !== "center" && align !== "right") fail("tableCell", "invalid align");
  return { colspan, rowspan, colwidth, align };
}

/** doc の直下・引用・囲み・項目の中に置けるブロック。 */
const BLOCK_TYPES: ReadonlySet<string> = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "taskList",
  "orderedList",
  "table",
  "codeBlock",
  "blockquote",
  "callout",
  "horizontalRule",
  "image",
  "recording",
]);

/** 本文のブロックとして使える node の名前（エディタの schema との突き合わせ用）。 */
export const BLOCK_NODE_NAMES: readonly string[] = [...BLOCK_TYPES];
/** 行の中に置ける node の名前。 */
export const INLINE_NODE_NAMES: readonly string[] = ["text", "hardBreak"];
export const MARK_NAMES: readonly string[] = ["bold", "italic", "strike", "code", "link"];

/** リンク先として保存してよいか。 */
export function isSafeLinkHref(href: unknown): href is string {
  if (typeof href !== "string" || href.length === 0 || href.length > MAX_LINK_CHARS) return false;
  // 制御文字・空白を含む値は URL の解釈がずれる（`java\tscript:` など）ので断る
  if (/[\u0000- \u007f-\u009f]/.test(href)) return false;
  try {
    return LINK_PROTOCOLS.includes(new URL(href).protocol);
  } catch {
    return false;
  }
}

function keysWithin(path: string, node: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(node)) if (!allowed.includes(key)) fail(path, `unknown key "${key}"`);
}

function parseMarks(path: string, raw: unknown): { type: string; attrs?: { href: string } }[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) fail(path, "marks must be an array");
  const seen = new Set<string>();
  const marks = raw.map((mark, index) => {
    const here = `${path}.marks[${index}]`;
    if (!isPlainObject(mark) || typeof mark.type !== "string") fail(here, "mark must have a type");
    keysWithin(here, mark, ["type", "attrs"]);
    if (!MARK_NAMES.includes(mark.type)) fail(here, `unknown mark "${mark.type}"`);
    if (seen.has(mark.type)) fail(here, `duplicate mark "${mark.type}"`);
    seen.add(mark.type);
    const attrs = mark.attrs === undefined || mark.attrs === null ? {} : mark.attrs;
    if (!isPlainObject(attrs)) fail(here, "attrs must be an object");
    if (mark.type !== "link") {
      pick(here, attrs, []);
      return { type: mark.type };
    }
    // target・rel・class・title は TipTap の Link が付ける表示用の値。保存せず、開くときに付け直す。
    const { href } = pick(here, attrs, ["href"], ["target", "rel", "class", "title"]);
    if (!isSafeLinkHref(href)) fail(here, "link href must be an http(s) or mailto URL");
    return { type: "link", attrs: { href } };
  });
  return marks.length > 0 ? marks : undefined;
}

function parseInline(path: string, raw: unknown): Block {
  if (!isPlainObject(raw) || typeof raw.type !== "string") fail(path, "inline node must have a type");
  if (raw.type === "hardBreak") {
    // `<strong>a<br>b</strong>` の貼り付けで、エディタは改行にも太字などの mark を残す。text と同じ検査で保つ
    keysWithin(path, raw, ["type", "marks"]);
    const marks = parseMarks(path, raw.marks);
    return marks ? { type: "hardBreak", marks } : { type: "hardBreak" };
  }
  if (raw.type !== "text") fail(path, `unknown inline node "${raw.type}"`);
  keysWithin(path, raw, ["type", "text", "marks"]);
  if (typeof raw.text !== "string" || raw.text.length === 0 || raw.text.includes("\u0000")) fail(path, "text must be a non-empty string");
  const marks = parseMarks(path, raw.marks);
  return marks ? { type: "text", text: raw.text, marks } : { type: "text", text: raw.text };
}

function parseChildren(path: string, spec: NodeSpec, raw: unknown, depth: number): Block[] | undefined {
  if (spec.content === "none") {
    if (raw !== undefined) fail(path, "node cannot have content");
    return undefined;
  }
  if (raw === undefined) {
    if (spec.nonEmpty) fail(path, "content is required");
    return undefined;
  }
  if (!Array.isArray(raw)) fail(path, "content must be an array");
  if (raw.length === 0) {
    if (spec.nonEmpty) fail(path, "content must not be empty");
    return undefined;
  }
  if (spec.content === "inline") return raw.map((child, index) => parseInline(`${path}.content[${index}]`, child));
  if (spec.content === "code") {
    return raw.map((child, index) => {
      const here = `${path}.content[${index}]`;
      if (!isPlainObject(child) || child.type !== "text" || typeof child.text !== "string" || child.text.length === 0 || child.text.includes("\u0000")) fail(here, "code block content must be plain text");
      keysWithin(here, child, ["type", "text"]);
      return { type: "text", text: child.text };
    });
  }
  const role = spec.content === "listItems" ? "listItem"
    : spec.content === "taskItems" ? "taskItem"
      : spec.content === "tableRows" ? "tableRow"
        : spec.content === "tableCells" ? "tableCell" : "block";
  return raw.map((child, index) => parseNode(`${path}.content[${index}]`, child, depth + 1, role));
}

function parseNode(path: string, raw: unknown, depth: number, role: "block" | "listItem" | "taskItem" | "tableRow" | "tableCell"): Block {
  if (depth > MAX_BLOCK_NESTING) fail(path, "nested too deeply");
  if (!isPlainObject(raw) || typeof raw.type !== "string") fail(path, "node must have a type");
  const type = raw.type;
  const here = `${path}(${type})`;
  const allowed = role === "listItem" ? type === "listItem"
    : role === "taskItem" ? type === "taskItem"
      : role === "tableRow" ? type === "tableRow"
        : role === "tableCell" ? type === "tableCell" || type === "tableHeader"
          : BLOCK_TYPES.has(type);
  if (!allowed) fail(here, `"${type}" is not allowed here`);
  const spec = NODES[type];
  if (!spec) fail(here, "unknown node");
  keysWithin(here, raw, ["type", "attrs", "content"]);
  const attrsRaw = raw.attrs === undefined || raw.attrs === null ? {} : raw.attrs;
  if (!isPlainObject(attrsRaw)) fail(here, "attrs must be an object");
  const attrs = spec.attrs ? spec.attrs(attrsRaw) : {};
  const content = parseChildren(here, spec, raw.content, depth);
  if (type === "listItem" && content?.[0]?.type !== "paragraph") fail(here, "a list item starts with a paragraph");
  if (type === "taskItem" && content?.[0]?.type !== "paragraph") fail(here, "a task item starts with a paragraph");
  if ((type === "tableCell" || type === "tableHeader") && content?.[0]?.type !== "paragraph") fail(here, "a table cell starts with a paragraph");
  const out: Record<string, unknown> = { type };
  if (Object.keys(attrs).length > 0) out.attrs = attrs;
  if (content) out.content = content;
  return out;
}

/**
 * 本文として保存してよいかを検査し、許す形だけで組み直した写しを返す。
 * 失敗の `reason` は開発者向け（応答には出さない）。
 */
export function validateBlocks(value: unknown): AstResult {
  try {
    if (!Array.isArray(value)) fail("blocks", "must be an array");
    return { ok: true, blocks: value.map((node, index) => parseNode(`blocks[${index}]`, node, 1, "block")) };
  } catch (error) {
    if (error instanceof AstError) return { ok: false, reason: error.message };
    throw error;
  }
}
