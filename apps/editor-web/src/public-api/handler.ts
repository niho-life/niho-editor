import { createHash, randomBytes } from "node:crypto";
import {
  API_ORIGIN,
  CONTRACT_VERSION,
  ENDPOINTS,
  ERROR_RETRYABLE,
  ERROR_STATUS,
  HTTP_METHODS,
  PREVIEW_TOKEN_MAX_TTL_SECONDS,
  PUBLISHED_LIMITS,
  RESPONSE_HEADERS,
  UUID_PATTERN,
  canonicalJson,
  destOfHandle,
  ifNoneMatchMatches,
  isConnectionHandle,
  isConnectionKey,
  isFaceDest,
  isPreviewToken,
  parseBearer,
  parseGoneBody,
  parsePreviewDoc,
  parsePublishedDoc,
  parsePublishedIndex,
  renderMarkdown,
  type ErrorCode,
  type FaceDest,
  type MovedTo,
  type PreviewDoc,
  type PublishedDoc,
  type PublishedIndex,
  type PublishedListItem,
} from "@niho/editor-publish-contract";
import { decodeCursor, encodeCursor, type CursorScope } from "./cursor";
import type { RateLimiter } from "./rate-limit";
import type { FaceCredentialSource, ListPosition, PublicApiSource, PublishedListRow, PublishedRow } from "./source";

/**
 * 公開 API v1（#40）の handler。仕様は docs/security/editor-publish-api-v1.md、型・検証・ETag・鍵の形は @niho/editor-publish-contract。
 * 契約の参照モデル（@niho/editor-publish-contract/test-support。テスト専用）と status・header・本文がバイト単位で同じになるように書き、
 * handler.test.ts が全シナリオと合成の world で突き合わせる。参照モデルは import しない。
 *
 * - 判定の順：メソッド（400）→ DB（503）→ Authorization の有無（401）→ rate limit（429。資格の SHA-256 ごと。検証の前に数えるので、
 *   誤った資格を繰り返しても DB を引かない）→ 資格の検証（401）→ handle の認可（404）→ query・id の形（400）→ 存在（404／410）→ 304／200。
 *   資格の無い handle は id の形が不正でも 404。認証が先なので、失効した資格では If-None-Match が合っても 304 にしない。
 * - 404 は理由によらず本文も header も同じ（requestId だけが要求ごとに違う）。
 * - 資格・token は SHA-256 にしてから引く（平文どうしを比べない）。結果は保存しない（失効・解除は次の要求から効く）。
 * - 返す直前に契約の検証器で自己検証し、通らなければ 503 temporarily_unavailable（詳細は出さない）。
 * - Authorization とパスの `pv_` token は、ログ・例外・応答に入れない。想定外の失敗は error の name だけを記録して 503。
 */

export interface PublicApiRequest {
  readonly method: string;
  /** path と query（API_ORIGIN の上の絶対 URL でもよい）。 */
  readonly url: string;
  readonly headers?: Readonly<Record<string, string | readonly string[]>>;
  /** 要求ごとの id（エラーの本文に出す）。無ければ作る。 */
  readonly requestId?: string;
}

export interface PublicApiResponse {
  readonly status: number;
  /** 名前は小文字。 */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface PublicApiClock {
  /** ISO 8601 の UTC。 */
  now(): string;
}

export interface PublicApiOptions {
  /** null は DB が使えない（メソッドの検査の後、全て 503）。 */
  readonly source: PublicApiSource | null;
  readonly faces: FaceCredentialSource;
  readonly clock: PublicApiClock;
  /** 無ければ数えない。 */
  readonly limiter?: RateLimiter;
  /** 想定外の失敗（error の name だけ。値・URL・header は渡さない）。既定は console.error。 */
  readonly onUnexpected?: (name: string) => void;
}

export interface PublicApi {
  handle(request: PublicApiRequest): Promise<PublicApiResponse>;
}

export const systemClock: PublicApiClock = { now: () => new Date().toISOString() };

/** エラーの本文の requestId（契約の形：印字可能な ASCII 1〜128 文字）。 */
export function newRequestId(): string {
  return `req_${randomBytes(12).toString("base64url")}`;
}

type Principal = { readonly kind: "site"; readonly handle: string } | { readonly kind: "face"; readonly dest: FaceDest };
type Query = ReadonlyMap<string, readonly string[]>;

interface Context {
  readonly request: PublicApiRequest;
  readonly requestId: string;
}

const PREVIEW_ROUTE = /^\/v1\/preview\/([^/]+)\.json$/;
const DOC_ROUTE = /^\/v1\/([^/]+)\/published\/([^/]+)\.json$/;
const LIST_ROUTE = /^\/v1\/([^/]+)\/published\.json$/;
const LIMIT_PATTERN = /^[1-9][0-9]{0,2}$/;
const ERROR_CACHE_CONTROL = "no-store";
const ALLOW = HTTP_METHODS.join(", ");
const LIST_QUERY: readonly string[] = ENDPOINTS["published.list"].query;

const time = (iso: string): number => Date.parse(iso);

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function baseHeaders(): Record<string, string> {
  return {
    "content-type": RESPONSE_HEADERS.contentType,
    "x-robots-tag": RESPONSE_HEADERS.robotsTag,
    vary: RESPONSE_HEADERS.vary,
  };
}

function headerValues(request: PublicApiRequest, name: string): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    if (key.toLowerCase() === name) values.push(...(typeof value === "string" ? [value] : value));
  }
  return values;
}

/** 未知・重複の判定のため、同じ名前の値を全て残す。percent-encoding が読めなければ null（400）。 */
function parseQuery(search: string): Query | null {
  const query = new Map<string, string[]>();
  if (search === "" || search === "?") return query;
  for (const part of search.slice(1).split("&")) {
    const separator = part.indexOf("=");
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(separator === -1 ? part : part.slice(0, separator));
      value = separator === -1 ? "" : decodeURIComponent(part.slice(separator + 1));
    } catch {
      return null;
    }
    query.set(key, [...(query.get(key) ?? []), value]);
  }
  return query;
}

/** 1 つだけの値。無ければ undefined、重複は null。 */
function single(query: Query, key: string): string | null | undefined {
  const values = query.get(key);
  if (values === undefined) return undefined;
  return values.length === 1 ? (values[0] ?? null) : null;
}

/** 公開版の行 → 一覧の項目（契約の field だけ。range は公開の行の値）。 */
function listItem(row: PublishedListRow): PublishedListItem {
  const { snapshot } = row;
  return {
    id: snapshot.id,
    slug: snapshot.slug,
    dest: snapshot.dest,
    lang: snapshot.lang,
    title: snapshot.title,
    lead: snapshot.lead,
    cover: snapshot.cover,
    // 任意の項目は値があるときだけ出す（無い公開版の応答・ETag は前と同じ）
    ...(snapshot.coverShareable === undefined ? {} : { coverShareable: snapshot.coverShareable }),
    category: snapshot.category,
    ...(snapshot.categoryDisplay === undefined ? {} : { categoryDisplay: snapshot.categoryDisplay }),
    author: snapshot.author,
    ...(snapshot.authorProfile === undefined ? {} : { authorProfile: snapshot.authorProfile }),
    range: row.range,
    version: snapshot.version,
    publishedAt: snapshot.publishedAt,
    updatedAt: snapshot.updatedAt,
    canonicalUrl: snapshot.canonicalUrl,
    extras: snapshot.extras,
    related: snapshot.related,
  };
}

/** 公開版の行 → PublishedDoc（契約の field だけ。fingerprint など保存の都合の field は出さない）。 */
function publishedDoc(row: PublishedRow): PublishedDoc {
  const { snapshot } = row;
  return {
    ...listItem(row),
    blocks: snapshot.blocks,
    markdown: snapshot.markdown,
    assets: snapshot.assets,
    contractVersion: snapshot.contractVersion,
  };
}

export function createPublicApi(options: PublicApiOptions): PublicApi {
  const { source, faces, clock, limiter } = options;
  const onUnexpected = options.onUnexpected ?? ((name: string) => console.error("editor-web: public api failed", { name }));

  const detail = (code: ErrorCode, context: Context) => ({ code, requestId: context.requestId, retryable: ERROR_RETRYABLE[code] });

  /** 同じ requestId なら、404 は理由によらずバイト単位で同じ。 */
  function error(code: ErrorCode, context: Context, movedTo?: MovedTo): PublicApiResponse {
    const headers = { ...baseHeaders(), "cache-control": ERROR_CACHE_CONTROL };
    if (code === "unauthenticated") Object.assign(headers, { "www-authenticate": RESPONSE_HEADERS.wwwAuthenticate });
    const body = canonicalJson(movedTo ? { error: detail(code, context), movedTo } : { error: detail(code, context) });
    return { status: ERROR_STATUS[code], headers, body: context.request.method === "HEAD" ? null : body };
  }

  function ok(payload: PublishedIndex | PublishedDoc | PreviewDoc, cacheControl: string, context: Context): PublicApiResponse {
    const json = canonicalJson(payload);
    // 強い ETag（正規化した JSON の SHA-256。契約の computeEtag と同じ値）
    const etag = `"${sha256Hex(json)}"`;
    const headers = { ...baseHeaders(), "cache-control": cacheControl, etag };
    if (ifNoneMatchMatches(headerValues(context.request, "if-none-match").join(", ") || null, etag)) {
      return { status: 304, headers, body: null };
    }
    return { status: 200, headers, body: context.request.method === "HEAD" ? null : json };
  }

  /** 要求のたびにハッシュ・失効・期限・接続の解除を確かめる（結果を保存しない）。 */
  async function authenticate(api: PublicApiSource, credential: string, digest: string, now: string): Promise<Principal | null> {
    if (isConnectionKey(credential)) {
      const handle = await api.siteHandleByKeyHash(digest, now);
      return handle !== null && isConnectionHandle(handle) ? { kind: "site", handle } : null;
    }
    const audience = faces.audienceByHash(digest, now);
    return isFaceDest(audience) ? { kind: "face", dest: audience } : null;
  }

  /** 本人のサイトの鍵は自分の接続の handle だけ、面の資格は自分の面の handle だけ。 */
  function canRead(principal: Principal, handle: string): boolean {
    return principal.kind === "site" ? isConnectionHandle(handle) && handle === principal.handle : handle === principal.dest;
  }

  async function list(api: PublicApiSource, principal: Principal, handle: string, query: Query, now: string, context: Context) {
    if (!canRead(principal, handle)) return error("not_found", context);
    const dest = destOfHandle(handle);
    if (dest === null) return error("not_found", context);
    if ([...query.keys()].some((key) => !LIST_QUERY.includes(key))) return error("invalid_request", context);
    const limitValue = single(query, "limit");
    const cursorValue = single(query, "cursor");
    const includeValue = single(query, "include");
    if (limitValue === null || cursorValue === null || includeValue === null) return error("invalid_request", context);
    let limit: number = PUBLISHED_LIMITS.defaultLimit;
    if (limitValue !== undefined) {
      if (!LIMIT_PATTERN.test(limitValue) || Number(limitValue) > PUBLISHED_LIMITS.maxLimit) return error("invalid_request", context);
      limit = Number(limitValue);
    }
    const includeUnlisted = includeValue === "unlisted";
    const scope: CursorScope = { handle, includeUnlisted };
    let after: ListPosition | null = null;
    if (cursorValue !== undefined) {
      after = decodeCursor(cursorValue, scope);
      if (after === null) return error("invalid_request", context);
    }
    // 本人のサイトの資格は include を付けられない（unlisted は面だけ）
    if (includeValue !== undefined && (!includeUnlisted || principal.kind !== "face")) return error("invalid_request", context);
    const rows = await api.listPublished({ handle, includeUnlisted, after, limit: limit + 1, now });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const payload: PublishedIndex = {
      contractVersion: CONTRACT_VERSION,
      items: page.map(listItem),
      nextCursor: rows.length > page.length && last ? encodeCursor({ updatedAt: last.snapshot.updatedAt, id: last.snapshot.id }, scope) : null,
    };
    // 発信先が拒むものは出さない
    if (!parsePublishedIndex(payload, { dest }).ok) return error("temporarily_unavailable", context);
    return ok(payload, ENDPOINTS["published.list"].cacheControl, context);
  }

  async function document(api: PublicApiSource, principal: Principal, handle: string, id: string, query: Query, now: string, context: Context) {
    if (!canRead(principal, handle)) return error("not_found", context);
    const dest = destOfHandle(handle);
    if (dest === null) return error("not_found", context);
    if (!UUID_PATTERN.test(id) || query.size > 0) return error("invalid_request", context);
    const found = await api.getPublished(handle, id, now);
    if (found.state === "none") return error("not_found", context);
    const range = found.state === "published" ? found.row.range : found.range;
    // 限定公開は面の資格でだけ読める（公開をやめたものも同じ）
    if (range === "unlisted" && principal.kind !== "face") return error("not_found", context);
    if (found.state === "left") {
      // movedTo は面 → 別の面の移動を、元の面の資格で読んだときだけ。移動先が契約に合わなければ付けずに 410
      const target = principal.kind === "face" && isFaceDest(handle) && found.movedTo
        ? { dest: found.movedTo.dest, canonicalUrl: found.movedTo.canonicalUrl }
        : undefined;
      const valid = target !== undefined && parseGoneBody({ error: detail("gone", context), movedTo: target }, { from: handle as FaceDest }).ok;
      return error("gone", context, valid ? target : undefined);
    }
    const payload = publishedDoc(found.row);
    if (!parsePublishedDoc(payload, { requireProjection: true }).ok) return error("temporarily_unavailable", context);
    return ok(payload, ENDPOINTS["published.get"].cacheControl, context);
  }

  async function preview(api: PublicApiSource, principal: Principal, token: string, query: Query, now: string, context: Context) {
    if (!isPreviewToken(token)) return error("not_found", context);
    const record = await api.previewTokenByHash(sha256Hex(token), now);
    // 期限切れ・未知・15 分を超える有効期限・別の dest の資格は、全て同じ 404
    if (
      !record
      || time(record.expiresAt) <= time(now)
      || time(record.expiresAt) - time(record.issuedAt) > PREVIEW_TOKEN_MAX_TTL_SECONDS * 1000
      || !canRead(principal, record.handle)
    ) return error("not_found", context);
    const draft = await api.previewDraft(record);
    const dest = destOfHandle(record.handle);
    if (!draft || dest === null) return error("not_found", context);
    if (query.size > 0) return error("invalid_request", context);
    const { content, revision, savedAt } = draft;
    const payload: PreviewDoc = {
      id: record.pageId,
      slug: content.slug,
      dest,
      lang: content.lang,
      title: content.title,
      lead: content.lead,
      cover: content.cover,
      ...(content.coverShareable === undefined ? {} : { coverShareable: content.coverShareable }),
      category: content.category,
      ...(content.categoryDisplay === undefined ? {} : { categoryDisplay: content.categoryDisplay }),
      author: content.author,
      ...(content.authorProfile === undefined ? {} : { authorProfile: content.authorProfile }),
      range: content.range,
      // 公開前の下書きには公開日時が無いので、保存時刻と下書きの版
      version: revision,
      publishedAt: savedAt,
      updatedAt: savedAt,
      canonicalUrl: content.canonicalUrl,
      extras: content.extras,
      related: content.related,
      blocks: content.blocks,
      markdown: renderMarkdown(content.blocks, content.assets),
      assets: content.assets,
      contractVersion: CONTRACT_VERSION,
      preview: { expiresAt: record.expiresAt, dest, noindex: true },
    };
    if (!parsePreviewDoc(payload, { requireProjection: true }).ok) return error("temporarily_unavailable", context);
    return ok(payload, ENDPOINTS["preview.get"].cacheControl, context);
  }

  async function route(context: Context): Promise<PublicApiResponse> {
    const { request } = context;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const response = error("invalid_request", context);
      return { ...response, headers: { ...response.headers, allow: ALLOW } };
    }
    if (!source) return error("temporarily_unavailable", context);
    const now = clock.now();
    // 認証が先：有効な資格が無ければ 304・404・410 を返さない
    const credential = parseBearer(headerValues(request, "authorization"));
    if (credential === null) return error("unauthenticated", context);
    const digest = sha256Hex(credential);
    const decision = limiter?.take(digest, time(now));
    if (decision && !decision.ok) {
      const response = error("rate_limited", context);
      return { ...response, headers: { ...response.headers, "retry-after": String(decision.retryAfterSeconds) } };
    }
    const principal = await authenticate(source, credential, digest, now);
    if (!principal) return error("unauthenticated", context);
    let url: URL;
    try {
      url = new URL(request.url, API_ORIGIN);
    } catch {
      return error("not_found", context);
    }
    const query = parseQuery(url.search);
    if (!query) return error("invalid_request", context);
    const previewMatch = PREVIEW_ROUTE.exec(url.pathname);
    if (previewMatch?.[1]) return preview(source, principal, previewMatch[1], query, now, context);
    const docMatch = DOC_ROUTE.exec(url.pathname);
    if (docMatch?.[1] && docMatch[2]) return document(source, principal, docMatch[1], docMatch[2], query, now, context);
    const listMatch = LIST_ROUTE.exec(url.pathname);
    if (listMatch?.[1]) return list(source, principal, listMatch[1], query, now, context);
    return error("not_found", context);
  }

  return {
    async handle(request) {
      const context: Context = { request, requestId: request.requestId ?? newRequestId() };
      try {
        return await route(context);
      } catch (thrown) {
        // 値・URL・header は記録しない（Authorization と pv_ token を残さない）
        onUnexpected(thrown instanceof Error ? thrown.name : "unknown");
        return error("temporarily_unavailable", context);
      }
    },
  };
}
