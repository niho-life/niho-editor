/**
 * TEST-ONLY reference model of the editor publish API v1.
 *
 * This is NOT the production authorization implementation and must never be
 * used to authorize real requests. It runs the public contract against a
 * synthetic, immutable "world" so that destinations and the private server can
 * share the same scenarios and negative cases. It never logs, and responses
 * never contain a credential.
 */

import {
  API_ORIGIN,
  CONTRACT_VERSION,
  ENDPOINTS,
  ERROR_RETRYABLE,
  ERROR_STATUS,
  PREVIEW_TOKEN_MAX_TTL_SECONDS,
  PUBLISHED_LIMITS,
  RESPONSE_HEADERS,
  UUID_PATTERN,
  destOfHandle,
  isConnectionHandle,
  isFaceDest,
  type ErrorCode,
  type FaceDest,
  type MovedTo,
  type PreviewDoc,
  type PublicationRange,
  type PublishedDoc,
  type PublishedIndex,
  type PublishedListItem,
} from "../src/v1.js";
import { canonicalJson, computeEtag, ifNoneMatchMatches, sha256Hex } from "../src/etag.js";
import { isConnectionKey, isPreviewToken, parseBearer } from "../src/keys.js";
import { renderMarkdown } from "../src/markdown.js";
import { parseUrl } from "../src/runtime.js";
import { parseGoneBody, parsePreviewDoc, parsePublishedDoc, parsePublishedIndex } from "../src/validate.js";

/** Immutable published content. `range` is a publication setting kept beside it. */
export type PublishedSnapshot = Omit<PublishedDoc, "range">;

/** Current draft of a page. Published endpoints never read it. */
export type DraftContent = Omit<
  PublishedDoc,
  "id" | "dest" | "version" | "publishedAt" | "updatedAt" | "markdown" | "contractVersion"
>;

export interface WorldPage {
  readonly id: string;
  readonly ownerId: string;
  readonly draft: {
    readonly revision: number;
    readonly savedAt: string;
    readonly content: DraftContent;
  };
}

export interface WorldPublication {
  readonly pageId: string;
  /** `exp` / `niho` for faces, otherwise a connection handle. */
  readonly handle: string;
  readonly range: PublicationRange;
  /** Set when the page stopped being published here (unpublished or moved). */
  readonly stoppedAt: string | null;
  /** Where the page went when the destination was changed. */
  readonly movedToHandle: string | null;
  readonly snapshot: PublishedSnapshot;
}

/** Only SHA-256 hashes of credentials are stored. */
export interface WorldKey {
  readonly sha256: string;
  readonly revokedAt: string | null;
}

export interface WorldConnection {
  readonly id: string;
  readonly handle: string;
  readonly ownerId: string;
  readonly removedAt: string | null;
  readonly keys: readonly WorldKey[];
}

export interface WorldFaceCredential {
  readonly sha256: string;
  /** The verified audience decides which face the caller is. */
  readonly audience: FaceDest;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface WorldPreviewToken {
  readonly sha256: string;
  readonly pageId: string;
  /** Binds the destination; for a site, the exact connection. */
  readonly handle: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface ReferenceWorld {
  readonly now: string;
  readonly pages: readonly WorldPage[];
  readonly publications: readonly WorldPublication[];
  readonly connections: readonly WorldConnection[];
  readonly faceCredentials: readonly WorldFaceCredential[];
  readonly previewTokens: readonly WorldPreviewToken[];
}

export interface ReferenceRequest {
  readonly method: string;
  /** Path and query, or an absolute URL on API_ORIGIN. */
  readonly url: string;
  readonly headers?: Readonly<Record<string, string | readonly string[]>>;
  /** Fixed per request so responses can be compared byte for byte. */
  readonly requestId?: string;
}

export interface ReferenceResponse {
  readonly status: number;
  /** Lowercase names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface ReferenceServer {
  handle(request: ReferenceRequest): Promise<ReferenceResponse>;
}

/** Hash used for stored credentials in synthetic worlds. */
export const hashCredential = sha256Hex;

type Principal =
  | { readonly kind: "site"; readonly handle: string }
  | { readonly kind: "face"; readonly dest: FaceDest };

type Query = ReadonlyMap<string, readonly string[]>;

const PREVIEW_ROUTE = /^\/v1\/preview\/([^/]+)\.json$/;
const DOC_ROUTE = /^\/v1\/([^/]+)\/published\/([^/]+)\.json$/;
const LIST_ROUTE = /^\/v1\/([^/]+)\/published\.json$/;
const LIMIT_PATTERN = /^[1-9][0-9]{0,2}$/;
const CURSOR = /^c1\.([0-9]{1,16})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const ERROR_CACHE_CONTROL = "no-store";

const time = (iso: string): number => Date.parse(iso);

function baseHeaders(): Record<string, string> {
  return {
    "content-type": RESPONSE_HEADERS.contentType,
    "x-robots-tag": RESPONSE_HEADERS.robotsTag,
    vary: RESPONSE_HEADERS.vary,
  };
}

function headerValues(request: ReferenceRequest, name: string): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    if (key.toLowerCase() === name) values.push(...(typeof value === "string" ? [value] : value));
  }
  return values;
}

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

function single(query: Query, key: string): string | null | undefined {
  const values = query.get(key);
  if (values === undefined) return undefined;
  return values.length === 1 ? (values[0] ?? null) : null;
}

function toListItem(doc: PublishedDoc): PublishedListItem {
  return {
    id: doc.id,
    slug: doc.slug,
    dest: doc.dest,
    lang: doc.lang,
    title: doc.title,
    lead: doc.lead,
    cover: doc.cover,
    ...(doc.coverShareable === undefined ? {} : { coverShareable: doc.coverShareable }),
    category: doc.category,
    ...(doc.categoryDisplay === undefined ? {} : { categoryDisplay: doc.categoryDisplay }),
    author: doc.author,
    ...(doc.authorProfile === undefined ? {} : { authorProfile: doc.authorProfile }),
    range: doc.range,
    version: doc.version,
    publishedAt: doc.publishedAt,
    updatedAt: doc.updatedAt,
    canonicalUrl: doc.canonicalUrl,
    extras: doc.extras,
    related: doc.related,
  };
}

export function createReferenceServer(world: ReferenceWorld): ReferenceServer {
  const now = time(world.now);
  const isActive = (revokedAt: string | null): boolean => revokedAt === null || time(revokedAt) > now;
  const isStopped = (publication: WorldPublication): boolean =>
    publication.stoppedAt !== null && time(publication.stoppedAt) <= now;

  const detail = (code: ErrorCode, request: ReferenceRequest) =>
    ({ code, requestId: request.requestId ?? "req_reference", retryable: ERROR_RETRYABLE[code] });

  /** Every 404 is byte-identical for the same requestId, whatever the reason. */
  function error(code: ErrorCode, request: ReferenceRequest, movedTo?: MovedTo): ReferenceResponse {
    const headers = { ...baseHeaders(), "cache-control": ERROR_CACHE_CONTROL };
    if (code === "unauthenticated") Object.assign(headers, { "www-authenticate": RESPONSE_HEADERS.wwwAuthenticate });
    const body = canonicalJson(movedTo ? { error: detail(code, request), movedTo } : { error: detail(code, request) });
    return { status: ERROR_STATUS[code], headers, body: request.method === "HEAD" ? null : body };
  }

  async function ok(
    payload: PublishedIndex | PublishedDoc | PreviewDoc,
    cacheControl: string,
    request: ReferenceRequest,
  ): Promise<ReferenceResponse> {
    const json = canonicalJson(payload);
    const etag = await computeEtag(payload);
    const headers = { ...baseHeaders(), "cache-control": cacheControl, etag };
    if (ifNoneMatchMatches(headerValues(request, "if-none-match").join(", ") || null, etag)) {
      return { status: 304, headers, body: null };
    }
    return { status: 200, headers, body: request.method === "HEAD" ? null : json };
  }

  /** Every request re-checks hashes, revocation, expiry and connection removal. */
  async function authenticate(request: ReferenceRequest): Promise<Principal | null> {
    const credential = parseBearer(headerValues(request, "authorization"));
    if (credential === null) return null;
    const digest = await sha256Hex(credential);
    if (isConnectionKey(credential)) {
      for (const connection of world.connections) {
        if (!isActive(connection.removedAt) || !isConnectionHandle(connection.handle)) continue;
        if (connection.keys.some((key) => key.sha256 === digest && isActive(key.revokedAt))) {
          return { kind: "site", handle: connection.handle };
        }
      }
      return null;
    }
    const face = world.faceCredentials.find((candidate) => candidate.sha256 === digest);
    if (face && isActive(face.revokedAt) && time(face.expiresAt) > now) return { kind: "face", dest: face.audience };
    return null;
  }

  function canRead(principal: Principal, handle: string): boolean {
    return principal.kind === "site"
      ? isConnectionHandle(handle) && handle === principal.handle
      : handle === principal.dest;
  }

  function movedTo(principal: Principal, publication: WorldPublication): MovedTo | undefined {
    const target = publication.movedToHandle;
    if (principal.kind !== "face" || !isFaceDest(publication.handle) || !isFaceDest(target) || target === publication.handle) {
      return undefined;
    }
    const next = world.publications.find((candidate) =>
      candidate.pageId === publication.pageId && candidate.handle === target
      && candidate.snapshot.dest === target && !isStopped(candidate));
    return next && { dest: target, canonicalUrl: next.snapshot.canonicalUrl };
  }

  async function list(principal: Principal, handle: string, query: Query, request: ReferenceRequest): Promise<ReferenceResponse> {
    if (!canRead(principal, handle)) return error("not_found", request);
    const dest = destOfHandle(handle);
    if (dest === null) return error("not_found", request);
    if ([...query.keys()].some((key) => !(ENDPOINTS["published.list"].query as readonly string[]).includes(key))) {
      return error("invalid_request", request);
    }
    const limitValue = single(query, "limit");
    const cursorValue = single(query, "cursor");
    const includeValue = single(query, "include");
    if (limitValue === null || cursorValue === null || includeValue === null) return error("invalid_request", request);
    let limit: number = PUBLISHED_LIMITS.defaultLimit;
    if (limitValue !== undefined) {
      if (!LIMIT_PATTERN.test(limitValue) || Number(limitValue) > PUBLISHED_LIMITS.maxLimit) return error("invalid_request", request);
      limit = Number(limitValue);
    }
    let after: { readonly at: number; readonly id: string } | undefined;
    if (cursorValue !== undefined) {
      const match = CURSOR.exec(cursorValue);
      if (!match?.[1] || !match[2]) return error("invalid_request", request);
      after = { at: Number(match[1]), id: match[2] };
    }
    if (includeValue !== undefined && (includeValue !== "unlisted" || principal.kind !== "face")) {
      return error("invalid_request", request);
    }
    const docs = world.publications
      .filter((publication) =>
        publication.handle === handle && publication.snapshot.dest === dest && !isStopped(publication)
        && (publication.range === "live" || (includeValue === "unlisted" && publication.range === "unlisted")))
      .map((publication): PublishedDoc => ({ ...publication.snapshot, range: publication.range }))
      .sort((a, b) => time(b.updatedAt) - time(a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .filter((doc) => !after || time(doc.updatedAt) < after.at || (time(doc.updatedAt) === after.at && doc.id > after.id));
    const page = docs.slice(0, limit);
    const last = page.at(-1);
    const payload: PublishedIndex = {
      contractVersion: CONTRACT_VERSION,
      items: page.map(toListItem),
      nextCursor: docs.length > page.length && last ? `c1.${time(last.updatedAt)}.${last.id}` : null,
    };
    // Fail closed: never serve what a destination must reject.
    if (!parsePublishedIndex(payload, { dest }).ok) return error("temporarily_unavailable", request);
    return ok(payload, ENDPOINTS["published.list"].cacheControl, request);
  }

  async function document(principal: Principal, handle: string, id: string, query: Query, request: ReferenceRequest): Promise<ReferenceResponse> {
    if (!canRead(principal, handle)) return error("not_found", request);
    const dest = destOfHandle(handle);
    if (dest === null) return error("not_found", request);
    if (!UUID_PATTERN.test(id) || query.size > 0) return error("invalid_request", request);
    const candidates = world.publications.filter((publication) =>
      publication.pageId === id && publication.handle === handle && publication.snapshot.dest === dest);
    const publication = candidates.find((candidate) => !isStopped(candidate)) ?? candidates[0];
    if (!publication) return error("not_found", request);
    if (publication.range === "unlisted" && principal.kind !== "face") return error("not_found", request);
    if (isStopped(publication)) {
      const target = movedTo(principal, publication);
      // Fail closed to a plain 410 if the move target would not validate.
      const valid = target !== undefined
        && parseGoneBody({ error: detail("gone", request), movedTo: target }, { from: publication.handle as FaceDest }).ok;
      return error("gone", request, valid ? target : undefined);
    }
    const payload: PublishedDoc = { ...publication.snapshot, range: publication.range };
    if (!parsePublishedDoc(payload, { requireProjection: true }).ok) return error("temporarily_unavailable", request);
    return ok(payload, ENDPOINTS["published.get"].cacheControl, request);
  }

  async function preview(principal: Principal, token: string, query: Query, request: ReferenceRequest): Promise<ReferenceResponse> {
    if (!isPreviewToken(token)) return error("not_found", request);
    const digest = await sha256Hex(token);
    const record = world.previewTokens.find((candidate) => candidate.sha256 === digest);
    if (
      !record
      || time(record.expiresAt) <= now
      || time(record.expiresAt) - time(record.issuedAt) > PREVIEW_TOKEN_MAX_TTL_SECONDS * 1000
      || !canRead(principal, record.handle)
    ) return error("not_found", request);
    const page = world.pages.find((candidate) => candidate.id === record.pageId);
    const dest = destOfHandle(record.handle);
    if (!page || dest === null) return error("not_found", request);
    if (query.size > 0) return error("invalid_request", request);
    const { content, revision, savedAt } = page.draft;
    const payload: PreviewDoc = {
      ...content,
      id: page.id,
      dest,
      version: revision,
      publishedAt: savedAt,
      updatedAt: savedAt,
      markdown: renderMarkdown(content.blocks, content.assets),
      contractVersion: CONTRACT_VERSION,
      preview: { expiresAt: record.expiresAt, dest, noindex: true },
    };
    if (!parsePreviewDoc(payload, { requireProjection: true }).ok) return error("temporarily_unavailable", request);
    return ok(payload, ENDPOINTS["preview.get"].cacheControl, request);
  }

  return {
    async handle(request) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        const response = error("invalid_request", request);
        return { ...response, headers: { ...response.headers, allow: "GET, HEAD" } };
      }
      // Authentication comes first: no 304, 404 or 410 without a valid credential.
      const principal = await authenticate(request);
      if (!principal) return error("unauthenticated", request);
      let url: ReturnType<typeof parseUrl>;
      try {
        url = parseUrl(request.url, API_ORIGIN);
      } catch {
        return error("not_found", request);
      }
      const query = parseQuery(url.search);
      if (!query) return error("invalid_request", request);
      const previewMatch = PREVIEW_ROUTE.exec(url.pathname);
      if (previewMatch?.[1]) return preview(principal, previewMatch[1], query, request);
      const docMatch = DOC_ROUTE.exec(url.pathname);
      if (docMatch?.[1] && docMatch[2]) return document(principal, docMatch[1], docMatch[2], query, request);
      const listMatch = LIST_ROUTE.exec(url.pathname);
      if (listMatch?.[1]) return list(principal, listMatch[1], query, request);
      return error("not_found", request);
    },
  };
}
