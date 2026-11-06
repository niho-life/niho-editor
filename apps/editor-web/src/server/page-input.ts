import { isLanguage } from "@niho/docs-core";
import {
  PAGE_KINDS,
  PAGE_LIST_LIMIT,
  PAGE_MAX_BYTES,
  TAB_NAME_MAX_CHARS,
  isPageId,
  isPositiveInteger,
  type Block,
  type CreatePageInput,
  type CreateTabInput,
  type PageChunkOptions,
  type PageKind,
  type PagePatch,
} from "@niho/editor-store";
import { validateBlocks } from "../ast/blocks";

import { MAX_LEAD_CHARS, MAX_TITLE_CHARS } from "../lib/page-limits";

export { MAX_TITLE_CHARS };
/** AST 検証の安全枠。30 MiB の合計判定とエラーは store で行う。 */
export const MAX_BLOCKS_BYTES = PAGE_MAX_BYTES + 16 * 1024;
/** 本文の入れ子の深さの上限（深すぎる JSON で DB・描画を詰まらせない）。 */
export const MAX_BLOCK_DEPTH = 64;

const ALLOWED_KEYS = new Set(["kind", "title", "lang", "blocks"]);

export type InputResult<T> = { ok: true; value: T } | { ok: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPageKind(value: unknown): value is PageKind {
  return typeof value === "string" && (PAGE_KINDS as readonly string[]).includes(value);
}

/** NUL は PostgreSQL の text・jsonb に入らないので、入口で断る。 */
function hasNul(text: string): boolean {
  return text.includes("\u0000");
}

function depthWithin(value: unknown, limit: number): boolean {
  if (limit < 0) return false;
  if (Array.isArray(value)) return value.every((item) => depthWithin(item, limit - 1));
  if (isPlainObject(value)) return Object.values(value).every((item) => depthWithin(item, limit - 1));
  return true;
}

function parseTitle(value: unknown): InputResult<string> {
  if (typeof value !== "string" || hasNul(value)) return { ok: false };
  if (Array.from(value).length > MAX_TITLE_CHARS) return { ok: false };
  return { ok: true, value };
}

function parseLead(value: unknown): InputResult<string | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string" || hasNul(value) || Array.from(value).length > MAX_LEAD_CHARS) return { ok: false };
  return { ok: true, value };
}

/**
 * 本文。大きさ・深さ・NUL を見たあと、限定 AST（src/ast/blocks.ts）として保存してよいかを検査する。
 * 返すのは入力そのものではなく、許す形だけで組み直した写し。
 */
export function parseBlocks(value: unknown): InputResult<Block[]> {
  if (!Array.isArray(value)) return { ok: false };
  if (!depthWithin(value, MAX_BLOCK_DEPTH)) return { ok: false };
  const serialized = JSON.stringify(value);
  if (serialized.includes("\\u0000")) return { ok: false };
  const checked = validateBlocks(value);
  if (!checked.ok || new TextEncoder().encode(JSON.stringify(checked.blocks)).byteLength > MAX_BLOCKS_BYTES) return { ok: false };
  return { ok: true, value: checked.blocks };
}

/**
 * フォルダへ入れる・出すの本文（`{ parent: id | null }` だけ）。id の形は見るが、本人のページかは store が見る
 * （無い id・別の人のページ・ゴミ箱の中はどれも同じ 404）。
 */
export function parseMoveParent(body: unknown): InputResult<string | null> {
  if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "parent")) return { ok: false };
  const { parent } = body;
  if (parent === null) return { ok: true, value: null };
  if (typeof parent !== "string" || !isPageId(parent)) return { ok: false };
  return { ok: true, value: parent };
}

function parseFields(body: unknown): InputResult<PagePatch> {
  if (!isPlainObject(body)) return { ok: false };
  if (!Object.keys(body).every((key) => ALLOWED_KEYS.has(key))) return { ok: false };
  const result: PagePatch = {};
  if (body.kind !== undefined) {
    if (!isPageKind(body.kind)) return { ok: false };
    result.kind = body.kind;
  }
  if (body.title !== undefined) {
    const title = parseTitle(body.title);
    if (!title.ok) return { ok: false };
    result.title = title.value;
  }
  if (body.lang !== undefined) {
    // 言語の値の範囲は docs-core（NIHO docs の中核）と同じ ja | en
    if (!isLanguage(body.lang)) return { ok: false };
    result.lang = body.lang;
  }
  if (body.blocks !== undefined) {
    const blocks = parseBlocks(body.blocks);
    if (!blocks.ok) return { ok: false };
    result.blocks = blocks.value;
  }
  return { ok: true, value: result };
}

/**
 * 新しいページ。全て任意（`{}` で空のページ）。`parent` はフォルダの id（その中に作る。本人の生きているフォルダかは
 * store が見て、違えば同じ 404）。フォルダ（`kind: 'folder'`）は本文と `parent` を持てない（400）。
 */
export function parseCreatePage(body: unknown): InputResult<CreatePageInput> {
  if (!isPlainObject(body)) return { ok: false };
  const { lead, parent, ...fields } = body;
  const parsed = parseFields(fields);
  if (!parsed.ok) return { ok: false };
  const result: CreatePageInput = { ...parsed.value };
  if (Object.prototype.hasOwnProperty.call(body, "parent") && parent !== null) {
    if (typeof parent !== "string" || !isPageId(parent)) return { ok: false };
    result.parent = parent.toLowerCase();
  }
  if (result.kind === "folder" && (result.parent !== undefined || (result.blocks !== undefined && result.blocks.length > 0))) return { ok: false };
  // タブの入れ物（kind='page'）は 1 つ目のタブと一緒に store が作る。直には作れない（#307）
  if (result.kind === "page") return { ok: false };
  if (Object.prototype.hasOwnProperty.call(body, "lead")) {
    const checked = parseLead(lead);
    if (!checked.ok) return { ok: false };
    result.lead = checked.value;
  }
  return { ok: true, value: result };
}

/** タブの名前（#308）。文字列で、前後の空白を除いて 1〜100 字。NUL は不可。null・空白だけは「名前なし」（null）。 */
function parseTabName(value: unknown): InputResult<string | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string" || value.includes("\u0000")) return { ok: false };
  const name = value.trim();
  if (name === "") return { ok: true, value: null };
  if (Array.from(name).length > TAB_NAME_MAX_CHARS) return { ok: false };
  return { ok: true, value: name };
}

/** タブを足す（#307 #308）。`{ name?, lang? }` だけ（本文は持たない。まっさら。題名はページの名前を写す）。ほかの鍵は 400。 */
export function parseCreateTab(body: unknown): InputResult<CreateTabInput> {
  if (!isPlainObject(body)) return { ok: false };
  const result: CreateTabInput = {};
  for (const key of Object.keys(body)) if (key !== "name" && key !== "lang") return { ok: false };
  if (body.name !== undefined) {
    const name = parseTabName(body.name);
    if (!name.ok) return { ok: false };
    if (name.value !== null) result.name = name.value;
  }
  if (body.lang !== undefined) {
    if (body.lang !== "ja" && body.lang !== "en") return { ok: false };
    result.lang = body.lang;
  }
  return { ok: true, value: result };
}

/** タブの並び（#307）。`{ ids: [uuid, ...] }`（1 つ以上・重複なし）。 */
export function parseTabOrder(body: unknown): InputResult<string[]> {
  if (!isPlainObject(body) || !Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 200) return { ok: false };
  const ids: string[] = [];
  for (const id of body.ids) {
    if (typeof id !== "string" || !isPageId(id)) return { ok: false };
    ids.push(id.toLowerCase());
  }
  if (new Set(ids).size !== ids.length) return { ok: false };
  return { ok: true, value: ids };
}

/** PATCH /api/pages/{id}/tab の本文（#307 #308）: `page`（別の入れ物へ移す。タブの id でもよい）と `name`（タブの名前。null で外す）。少なくとも 1 つ。 */
export type TabPatch = { page?: string; name?: string | null };

export function parseTabPatch(body: unknown): InputResult<TabPatch> {
  if (!isPlainObject(body)) return { ok: false };
  const result: TabPatch = {};
  for (const key of Object.keys(body)) if (key !== "page" && key !== "name") return { ok: false };
  if (body.page !== undefined) {
    if (typeof body.page !== "string" || !isPageId(body.page)) return { ok: false };
    result.page = body.page.toLowerCase();
  }
  if (body.name !== undefined) {
    const name = parseTabName(body.name);
    if (!name.ok) return { ok: false };
    result.name = name.value;
  }
  if (result.page === undefined && result.name === undefined) return { ok: false };
  return { ok: true, value: result };
}

/** 部分更新。少なくとも 1 つは指定する。 */
export function parsePagePatch(body: unknown): InputResult<PagePatch> {
  if (!isPlainObject(body)) return { ok: false };
  const { cover, lead, ...fields } = body;
  const parsed = parseFields(fields);
  if (!parsed.ok) return { ok: false };
  const result: PagePatch = { ...parsed.value };
  if (Object.prototype.hasOwnProperty.call(body, "cover")) {
    if (cover !== null && (typeof cover !== "string" || !isPageId(cover))) return { ok: false };
    result.cover = typeof cover === "string" ? cover.toLowerCase() : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "lead")) {
    const checked = parseLead(lead);
    if (!checked.ok) return { ok: false };
    result.lead = checked.value;
  }
  if (Object.keys(result).length === 0) return { ok: false };
  return { ok: true, value: result };
}

/** 一覧の query。limit は 1〜PAGE_LIST_LIMIT の整数、cursor は前の応答の next（形の検査は store。空は不可）。どちらも任意。 */
export function parseListQuery(params: URLSearchParams): InputResult<PageChunkOptions> {
  const result: PageChunkOptions = {};
  const limit = params.get("limit");
  if (limit !== null) {
    if (!/^[1-9]\d{0,3}$/.test(limit) || Number(limit) > PAGE_LIST_LIMIT) return { ok: false };
    result.limit = Number(limit);
  }
  const cursor = params.get("cursor");
  if (cursor !== null) {
    if (cursor.length === 0 || cursor.length > 128) return { ok: false };
    result.cursor = cursor;
  }
  // 何を 1 行にするか（#307 #308）。無ければ今までどおりタブ（本文を持つ行）
  const view = params.get("view");
  if (view !== null) {
    if (view !== "tabs" && view !== "pages" && view !== "all") return { ok: false };
    result.view = view;
  }
  return { ok: true, value: result };
}

/** PATCH /api/pages/{id} の本文。`baseRevision` は必須（楽観ロック）。`overwrite` は「この内容で上書き」。 */
export type PageSave = { patch: PagePatch; baseRevision: number; overwrite: boolean };

/** 部分更新の欄に、`baseRevision`（正の整数・必須）と `overwrite`（真偽・任意）を足したもの。 */
export function parsePageSave(body: unknown): InputResult<PageSave> {
  if (!isPlainObject(body)) return { ok: false };
  const { baseRevision, overwrite, ...fields } = body;
  if (!isPositiveInteger(baseRevision)) return { ok: false };
  if (overwrite !== undefined && typeof overwrite !== "boolean") return { ok: false };
  const patch = parsePagePatch(fields);
  if (!patch.ok) return { ok: false };
  return { ok: true, value: { patch: patch.value, baseRevision, overwrite: overwrite === true } };
}

/** POST /api/pages/{id}/versions/{n}/restore の本文（`baseRevision` だけ）。 */
export function parseRestoreBody(body: unknown): InputResult<{ baseRevision: number }> {
  if (!isPlainObject(body)) return { ok: false };
  if (!Object.keys(body).every((key) => key === "baseRevision")) return { ok: false };
  return isPositiveInteger(body.baseRevision) ? { ok: true, value: { baseRevision: body.baseRevision } } : { ok: false };
}

/** URL の版の番号（`1` 以上の 10 進の整数だけ。`01`・`1.0`・`+1` は受けない）。正しくなければ null（ページの 404 と同じに扱う）。 */
export function parseVersionNumber(value: string): number | null {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) return null;
  const version = Number(value);
  return isPositiveInteger(version) ? version : null;
}
