/** ブラウザから `/api/pages` を呼ぶ（同じ origin。cookie・token は扱わない）。 */

import type { PageChunk, PageLang } from "@niho/editor-store";
import { PAGE_CHUNK } from "./page-limits";

export type PageBody = {
  title?: string;
  blocks?: unknown[];
  /** ページの言語（情報パネルで変えたときだけ送る）。 */
  lang?: PageLang;
  /** 公開用カバー。null で外す。 */
  cover?: string | null;
  /** 公開用リード。null で外す。 */
  lead?: string | null;
  /** 作るときだけ: 入れるフォルダ（本人の生きているフォルダ。違えば 404）。 */
  parent?: string;
  /** 作るときだけ: 種類（フォルダを作るときは `folder`）。 */
  kind?: "note" | "rec" | "folder";
};

/** サーバーが受ける言語か。 */
export function isPageLang(value: unknown): value is PageLang {
  return value === "ja" || value === "en";
}

export type SaveRequestOptions = {
  /** 画面が持っているページの revision（楽観ロック）。 */
  baseRevision: number;
  /** 「この内容で上書き」（競合の応答の revision を取り直して送る）。 */
  overwrite?: boolean;
  /**
   * タブを閉じる・隠れる瞬間の保存。`fetch` の `keepalive` で、画面が消えたあとも送り終える見込みを上げる
   * （届く保証は無い。本文が大きく keepalive の上限を超えるときは普通に送る）。
   */
  keepalive?: boolean;
};

/** keepalive の要求の本文の上限（ブラウザの 64 KiB より少し小さく）。超えると fetch がすぐ失敗するので、普通に送る。 */
export const KEEPALIVE_MAX_BYTES = 60 * 1024;
/** 応答の無い保存を待つ上限。届かないまま待ち続けて、直列の保存が詰まらないように。 */
export const SAVE_TIMEOUT_MS = 60_000;

/** 競合の応答が持つ、今のページ（別の画面・端末が保存したもの）。 */
export type ConflictPage = {
  title: string;
  blocks: unknown[];
  revision: number;
  updatedAt: string;
  /** 今のページの言語（応答に無い・読めないときは持たない。そのときは言語を比べない）。 */
  lang?: PageLang;
  /** 古い応答では省略されることがある。 */
  cover?: string | null;
  lead?: string | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PageRequestError extends Error {
  override readonly name: string = "PageRequestError";
  constructor(readonly status: number) {
    super(`page request failed with ${status}`);
  }
}

/** 別の画面・端末が先に保存していた（409）。何も保存されていない。`page` は今のページ。 */
export class PageConflictError extends PageRequestError {
  override readonly name: string = "PageConflictError";
  constructor(readonly page: ConflictPage) {
    super(409);
  }
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** 競合の応答（`{ error: "conflict", page }`）・AI の採用の応答（`{ page }`）のページ。形が違えば null。 */
export function conflictPageOf(data: unknown): ConflictPage | null {
  const page = (data as { page?: Record<string, unknown> } | null)?.page;
  if (typeof page !== "object" || page === null) return null;
  const { title, blocks, revision, updatedAt, lang, cover, lead } = page;
  if (typeof title !== "string" || !Array.isArray(blocks) || !isRevision(revision) || typeof updatedAt !== "string") return null;
  if (cover !== undefined && cover !== null && !isUuid(cover)) return null;
  if (lead !== undefined && lead !== null && typeof lead !== "string") return null;
  return {
    title,
    blocks,
    revision,
    updatedAt,
    ...(isPageLang(lang) ? { lang } : {}),
    ...(cover !== undefined ? { cover } : {}),
    ...(lead !== undefined ? { lead } : {}),
  };
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

async function send(path: string, method: "POST" | "PATCH", body: unknown, options: { keepalive?: boolean } = {}): Promise<unknown> {
  const text = JSON.stringify(body);
  const keepalive = options.keepalive === true && new TextEncoder().encode(text).byteLength <= KEEPALIVE_MAX_BYTES;
  const signal = timeoutSignal(SAVE_TIMEOUT_MS);
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: text,
    credentials: "same-origin",
    cache: "no-store",
    ...(keepalive ? { keepalive: true } : {}),
    ...(signal ? { signal } : {}),
  });
  if (response.status === 409) {
    const page = conflictPageOf(await response.json().catch(() => null));
    // 競合の形でない 409 はただの失敗として扱う
    throw page ? new PageConflictError(page) : new PageRequestError(409);
  }
  if (!response.ok) throw new PageRequestError(response.status);
  return response.json();
}

/** 保存先のページ（id と、次の保存で `baseRevision` に使う revision）。 */
export type SavedPage = { id: string; revision: number };

/**
 * 新しいページを作り（題名・本文を渡せば、それで作る）、その id と revision を返す。
 * `keepalive` は保存（PATCH）と同じく、タブを閉じる・隠れる瞬間の作成。
 */
export async function createPageRequest(body: PageBody = {}, options: { keepalive?: boolean } = {}): Promise<SavedPage> {
  const data = (await send("/api/pages", "POST", body, { keepalive: options.keepalive })) as { page?: { id?: unknown; revision?: unknown } };
  const id = data.page?.id;
  const revision = data.page?.revision;
  if (typeof id !== "string" || !UUID_PATTERN.test(id) || !isRevision(revision)) throw new PageRequestError(500);
  return { id, revision };
}

/**
 * ページの部分更新。`baseRevision` を付けて送り、保存後の revision を返す。
 * 別の画面・端末が先に保存していたら PageConflictError（何も保存されていない）。
 */
export async function savePageRequest(id: string, body: PageBody, options: SaveRequestOptions): Promise<number> {
  const payload = { ...body, baseRevision: options.baseRevision, ...(options.overwrite === true ? { overwrite: true } : {}) };
  const data = (await send(`/api/pages/${encodeURIComponent(id)}`, "PATCH", payload, { keepalive: options.keepalive })) as { page?: { revision?: unknown } };
  const revision = data.page?.revision;
  if (!isRevision(revision)) throw new PageRequestError(500);
  return revision;
}

/**
 * ページをフォルダへ入れる・出す（`parent` に `null` で上の段へ）。本文・revision は変わらない。
 * 段が深くなりすぎる・自分の中へ入れる移動は PageRequestError（409。何も保存されていない）。
 */
export async function movePageRequest(id: string, parent: string | null): Promise<void> {
  await send(`/api/pages/${encodeURIComponent(id)}/parent`, "PATCH", { parent });
}

/**
 * ページの今の中身（題名・本文・revision・言語）。手順の worker がサブページの本文を入れ替えたあと、開いている
 * エディタを今の内容で開き直すために読む（#37）。自分のページでなければ・無ければ PageRequestError(404)。
 */
export async function readPageRequest(id: string): Promise<ConflictPage> {
  const response = await fetch(`/api/pages/${encodeURIComponent(id)}`, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new PageRequestError(response.status);
  const page = conflictPageOf(await response.json().catch(() => null));
  if (!page) throw new PageRequestError(500);
  return page;
}

/** 一覧の続き（cursor は前の応答の next）。 */
export async function listPagesRequest(cursor: string): Promise<PageChunk> {
  const response = await fetch(`/api/pages?limit=${PAGE_CHUNK}&cursor=${encodeURIComponent(cursor)}`, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new PageRequestError(response.status);
  const data = (await response.json()) as { pages?: unknown; next?: unknown };
  if (!Array.isArray(data.pages) || (data.next !== null && typeof data.next !== "string")) throw new PageRequestError(500);
  return { pages: data.pages as PageChunk["pages"], next: data.next };
}

/**
 * 何も足していないページを捨てるよう頼む（「新しいページ」で作って、そのまま離れたとき）。空かどうかはサーバーが確かめ、
 * 空でなければ何もしない。消したら true。`keepalive` はタブを閉じる・隠れる瞬間（pagehide）に送るとき（本文は送らない）。
 */
export async function discardPageRequest(id: string, options: { keepalive?: boolean } = {}): Promise<boolean> {
  const response = await fetch(`/api/pages/${encodeURIComponent(id)}/discard`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    ...(options.keepalive ? { keepalive: true } : {}),
  });
  if (!response.ok) throw new PageRequestError(response.status);
  const data = (await response.json().catch(() => null)) as { discarded?: unknown } | null;
  return data?.discarded === true;
}
