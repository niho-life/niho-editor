/**
 * ブラウザから「…」の操作（リンクで共有・書き出し・履歴・複製・削除）の API を呼ぶ（同じ origin。cookie・token は扱わない）。
 * どれもヘッダーの「…」（src/lib/use-page-menu.ts・use-page-share.ts・use-page-history.ts）から使う。
 * 共有の url は bearer（知っている人は読める）なので、例外の文言・ログには入れない（例外は status と短い code だけ）。
 */
import type { DocsPageShareState } from "@niho/docs-core";
import type { PageKind } from "@niho/editor-store";

export type { DocsPageShareState };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** editor-store の PAGE_KINDS の写し（画面に pg を持ち込まないよう、値は import しない）。 */
const PAGE_KINDS = ["note", "rec", "article", "step"] as const satisfies readonly PageKind[];

export class PageActionError extends Error {
  override readonly name = "PageActionError";
  /** `code` はエラーの本文の短い code（`published` など。読めなければ null）。 */
  constructor(
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(`page action failed with ${status}`);
  }
}

function pagePath(id: string, suffix: string): string {
  return `/api/pages/${encodeURIComponent(id)}${suffix}`;
}

const nullableString = (value: unknown) => value === null || typeof value === "string";

function isShareState(value: unknown): value is DocsPageShareState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  if (state.status !== "PRIVATE" && state.status !== "PUBLIC") return false;
  if (!nullableString(state.publicId) || !nullableString(state.url) || !nullableString(state.updatedAt)) return false;
  return state.status === "PUBLIC" || (state.publicId === null && state.url === null);
}

async function send(path: string, method: "GET" | "PUT" | "POST" | "DELETE"): Promise<unknown> {
  const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new PageActionError(response.status);
  return response.json();
}

async function shareRequest(id: string, method: "GET" | "PUT" | "POST" | "DELETE", suffix = ""): Promise<DocsPageShareState> {
  const data = (await send(pagePath(id, `/share${suffix}`), method)) as { share?: unknown };
  if (!isShareState(data.share)) throw new PageActionError(500);
  const { status, publicId, url, updatedAt } = data.share;
  return { status, publicId, url, updatedAt };
}

/** 共有の状態を読む。 */
export function getPageShare(id: string): Promise<DocsPageShareState> {
  return shareRequest(id, "GET");
}

/** 共有を始める（共有中なら同じリンクのまま）。 */
export function startPageShare(id: string): Promise<DocsPageShareState> {
  return shareRequest(id, "PUT");
}

/** リンクを作り直す（今のリンクでは見られなくなる）。 */
export function rotatePageShare(id: string): Promise<DocsPageShareState> {
  return shareRequest(id, "POST", "/rotate");
}

/** 共有を止める（すぐ見られなくなる）。 */
export function stopPageShare(id: string): Promise<DocsPageShareState> {
  return shareRequest(id, "DELETE");
}

/** 複製してできたページ（一覧の上に足すのに要る分）。 */
export type DuplicatedPage = { id: string; title: string; kind: PageKind };

function isPageKind(value: unknown): value is PageKind {
  return typeof value === "string" && (PAGE_KINDS as readonly string[]).includes(value);
}

/** ページを複製し、新しいページの id・題名（「〜のコピー」）・種類を返す。種類が読めなければ note として扱う。 */
export async function duplicatePageRequest(id: string): Promise<DuplicatedPage> {
  const data = (await send(pagePath(id, "/duplicate"), "POST")) as { page?: { id?: unknown; title?: unknown; kind?: unknown } };
  const newId = data.page?.id;
  const title = data.page?.title;
  if (typeof newId !== "string" || !UUID_PATTERN.test(newId) || typeof title !== "string") throw new PageActionError(500);
  const kind = data.page?.kind;
  return { id: newId, title, kind: isPageKind(kind) ? kind : "note" };
}

/** Markdown の書き出しの URL（`<a href download>` か location に渡す。応答は attachment）。 */
export function pageExportUrl(id: string): string {
  return pagePath(id, "/export.md");
}

/** 削除の応答を待つ上限（届かないまま待ち続けて、確認のダイアログが閉じられなくならないように）。 */
export const DELETE_TIMEOUT_MS = 30_000;
/** 「この版に戻す」の応答を待つ上限（同上。戻している間はシートを閉じないため）。 */
export const RESTORE_TIMEOUT_MS = 30_000;

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

async function refusal(response: Response): Promise<PageActionError> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return new PageActionError(response.status, typeof body?.error === "string" ? body.error : null);
}

/**
 * ページをゴミ箱へ入れる（`DELETE /api/pages/{id}`。204。子孫のページもサーバーが一緒に入れる）。
 * 失敗は PageActionError（公開中は 409 と code `published`）。届かない・時間切れは fetch の例外のまま。
 */
export async function deletePageRequest(id: string): Promise<void> {
  const signal = timeoutSignal(DELETE_TIMEOUT_MS);
  const response = await fetch(pagePath(id, ""), { method: "DELETE", credentials: "same-origin", cache: "no-store", ...(signal ? { signal } : {}) });
  if (response.ok) return;
  throw await refusal(response);
}

/** 版の一覧の 1 行（本文は含めない）。reason は editor-store の VERSION_REASONS（知らない値もそのまま持つ）。 */
export type PageVersionRow = { version: number; reason: string; createdAt: string; blockCount: number };

const isPositiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function versionRowOf(value: unknown): PageVersionRow | null {
  if (typeof value !== "object" || value === null) return null;
  const { version, reason, createdAt, blockCount } = value as Record<string, unknown>;
  if (!isPositiveInteger(version) || typeof reason !== "string" || typeof createdAt !== "string") return null;
  if (typeof blockCount !== "number" || !Number.isSafeInteger(blockCount) || blockCount < 0) return null;
  return { version, reason, createdAt, blockCount };
}

/** 版の一覧（`GET /api/pages/{id}/versions`。新しい順・最大 100）。形の違う応答は 500 の PageActionError。 */
export async function listPageVersions(id: string): Promise<PageVersionRow[]> {
  const data = (await send(pagePath(id, "/versions"), "GET")) as { versions?: unknown };
  if (!Array.isArray(data.versions)) throw new PageActionError(500);
  const rows = data.versions.map(versionRowOf);
  if (rows.some((row) => row === null)) throw new PageActionError(500);
  return rows as PageVersionRow[];
}

/**
 * 1 つの版の本文（`GET /api/pages/{id}/versions/{n}`）。AI と作るの「変更を見る」が直す前の本文として読む。
 * 形が違えば PageActionError 500。
 */
export async function getPageVersion(id: string, version: number): Promise<{ version: number; blocks: unknown[] }> {
  const data = (await send(pagePath(id, `/versions/${encodeURIComponent(String(version))}`), "GET")) as { version?: unknown };
  const row = data.version;
  if (typeof row !== "object" || row === null) throw new PageActionError(500);
  const { version: number, blocks } = row as Record<string, unknown>;
  if (!isPositiveInteger(number) || !Array.isArray(blocks)) throw new PageActionError(500);
  return { version: number, blocks };
}

/** 版に戻したあとのページ（エディタを開き直すのに要る分）。 */
export type RestoredPage = { id: string; title: string; blocks: unknown[]; revision: number; updatedAt: string; cover: string | null; lead: string | null };

/**
 * 「この版に戻す」（`POST /api/pages/{id}/versions/{n}/restore`、本文 `{ baseRevision }`）。戻したあとのページを返す。
 * サーバーは戻す前の本文を版（restore）に残してから、その版の本文を書き、revision を進める（題名は変えない）。
 * 失敗は PageActionError: 409 `conflict`（別の画面が先に保存した。何も書いていない）、422 `unrestorable`（今の形では保存できない古い版）、
 * 404（ページか版が無い）など。届かない・時間切れは fetch の例外のまま（そのときサーバーで戻ったかは分からない）。
 */
export async function restorePageVersion(id: string, version: number, baseRevision: number): Promise<RestoredPage> {
  const signal = timeoutSignal(RESTORE_TIMEOUT_MS);
  const response = await fetch(pagePath(id, `/versions/${encodeURIComponent(String(version))}/restore`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseRevision }),
    credentials: "same-origin",
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw await refusal(response);
  const data = (await response.json().catch(() => null)) as { page?: Record<string, unknown> } | null;
  const page = data?.page;
  if (typeof page !== "object" || page === null) throw new PageActionError(500);
  const { title, blocks, revision, updatedAt, cover, lead } = page;
  if (page.id !== id || typeof title !== "string" || !Array.isArray(blocks) || !isPositiveInteger(revision) || typeof updatedAt !== "string") {
    throw new PageActionError(500);
  }
  if (cover !== undefined && cover !== null && typeof cover !== "string") throw new PageActionError(500);
  if (lead !== undefined && lead !== null && typeof lead !== "string") throw new PageActionError(500);
  return { id, title, blocks, revision, updatedAt, cover: (cover as string | null | undefined) ?? null, lead: (lead as string | null | undefined) ?? null };
}

/**
 * Google ドキュメントへの書き出し（docs/architecture/editor-google-docs-export.md）。
 *
 * 本文は送らない（サーバーが保存済みの blocks から作る）。送るのは受付の id だけで、同じ id の呼び出しは
 * **同じ内容の再試行**に使う（二重に文書を作らないため）。`pending` は受け付けたがまだできていない（202）。
 */
export type GoogleDocExportResult =
  | { status: "completed"; documentId: string; url: string }
  | { status: "pending"; retryable: boolean };

/** 受付の id（小文字の UUID。サーバーもこの形だけを受ける）。 */
export function newGoogleDocExportId(): string {
  return crypto.randomUUID().toLowerCase();
}

function googleDocExportOf(value: unknown): GoogleDocExportResult | null {
  if (typeof value !== "object" || value === null) return null;
  const result = value as Record<string, unknown>;
  if (result.status === "completed") {
    const { documentId, url } = result;
    // url はサーバーが documentId から組み立てたもの（Google の応答そのままではない）
    if (typeof documentId !== "string" || typeof url !== "string") return null;
    if (url !== `https://docs.google.com/document/d/${documentId}/edit`) return null;
    return { status: "completed", documentId, url };
  }
  if (result.status === "pending") return { status: "pending", retryable: result.retryable === true };
  return null;
}

async function googleDocExportRequest(path: string, method: "GET" | "POST", body?: unknown): Promise<GoogleDocExportResult> {
  const response = await fetch(path, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw await refusal(response);
  const result = googleDocExportOf(await response.json().catch(() => null));
  if (!result) throw new PageActionError(500);
  return result;
}

/** このページを Google ドキュメントへ書き出す。 */
export function exportPageToGoogleDoc(id: string, exportId: string): Promise<GoogleDocExportResult> {
  return googleDocExportRequest(pagePath(id, "/export/google-doc"), "POST", { exportId });
}

/** 受け付けた書き出しの状態（結果が分からなかったときに確かめる）。 */
export function googleDocExportStatus(exportId: string): Promise<GoogleDocExportResult> {
  return googleDocExportRequest(`/api/google-docs/exports/${encodeURIComponent(exportId)}`, "GET");
}
