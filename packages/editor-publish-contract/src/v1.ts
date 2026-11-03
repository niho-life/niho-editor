/**
 * editor publish API contract v1 (docs/security/editor-publish-api-v1.md).
 * Wire shapes and constants only. Nothing here confers authority; the server
 * authenticates and authorizes every request.
 */

export const CONTRACT_VERSION = "1" as const;
export const API_ORIGIN = "https://api.editor.niho.life" as const;

export const DESTS = ["exp", "niho", "site"] as const;
export type Dest = (typeof DESTS)[number];

/** Destinations operated by NIHO ("faces"). They read with service-to-service credentials. */
export const FACE_DESTS = ["exp", "niho"] as const;
export type FaceDest = (typeof FACE_DESTS)[number];

export const RANGES = ["live", "unlisted"] as const;
export type PublicationRange = (typeof RANGES)[number];

export const LANGS = ["ja", "en"] as const;
export type Lang = (typeof LANGS)[number];

/** 3–32 characters. Faces use the reserved handles `exp` / `niho`. */
export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/;
export const RESERVED_HANDLES = ["exp", "niho", "preview", "v1", "api", "admin", "editor"] as const;

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX_LENGTH = 160;
/** Lowercase canonical UUID text. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** ISO 8601 in UTC with second or millisecond precision. */
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
export const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Opaque to clients; restricted to characters that need no escaping in a query. */
export const CURSOR_PATTERN = /^[A-Za-z0-9._~-]{1,512}$/;

export const PUBLISHED_LIMITS = {
  /** Code points of text, captions and hrefs in one top-level block (note children included). */
  maxBlockChars: 20_000,
  /** Every block node, note children included. */
  maxBlocks: 2_000,
  /** UTF-8 bytes of the canonical JSON of one PublishedDoc / PreviewDoc. */
  maxDocBytes: 1_048_576,
  minLimit: 1,
  maxLimit: 100,
  defaultLimit: 50,
} as const;

/** Recording (audio) assets and SVG are never part of a publication. */
export const IMAGE_CONTENT_TYPES = ["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"] as const;
export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];

/** A preview token expires at most this long after it is issued. */
export const PREVIEW_TOKEN_MAX_TTL_SECONDS = 15 * 60;

export const INCLUDE_VALUES = ["unlisted"] as const;
export type IncludeValue = (typeof INCLUDE_VALUES)[number];

export function isFaceDest(value: unknown): value is FaceDest {
  return value === "exp" || value === "niho";
}

export function isReservedHandle(value: string): boolean {
  return (RESERVED_HANDLES as readonly string[]).includes(value);
}

/** A handle a site connection may own. */
export function isConnectionHandle(value: unknown): value is string {
  return typeof value === "string" && HANDLE_PATTERN.test(value) && !isReservedHandle(value);
}

/** The destination a readable handle serves; null for handles nobody can read. */
export function destOfHandle(handle: string): Dest | null {
  if (isFaceDest(handle)) return handle;
  return isConnectionHandle(handle) ? "site" : null;
}

// --- errors -----------------------------------------------------------------

export const ERROR_CODES = [
  "invalid_request",
  "unauthenticated",
  "not_found",
  "gone",
  "rate_limited",
  "temporarily_unavailable",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** 403 is never used: authorization failures are 404 so existence cannot be inferred. */
export const ERROR_STATUS = {
  invalid_request: 400,
  unauthenticated: 401,
  not_found: 404,
  gone: 410,
  rate_limited: 429,
  temporarily_unavailable: 503,
} as const satisfies { readonly [K in ErrorCode]: number };

export const ERROR_RETRYABLE = {
  invalid_request: false,
  unauthenticated: false,
  not_found: false,
  gone: false,
  rate_limited: true,
  temporarily_unavailable: true,
} as const satisfies { readonly [K in ErrorCode]: boolean };

export interface ErrorDetail {
  readonly code: ErrorCode;
  readonly requestId: string;
  readonly retryable: boolean;
}

/** Never carries internal configuration, other parties' existence, keys or tokens. */
export interface ErrorBody {
  readonly error: ErrorDetail;
}

/** Where a face-to-face move went. Only on 410 to the original face's credential. */
export interface MovedTo {
  readonly dest: FaceDest;
  readonly canonicalUrl: string;
}

export interface GoneBody {
  readonly error: ErrorDetail & { readonly code: "gone" };
  readonly movedTo?: MovedTo;
}

// --- transport --------------------------------------------------------------

export const HTTP_METHODS = ["GET", "HEAD"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type EndpointName = "published.list" | "published.get" | "preview.get";

export interface EndpointTransport {
  readonly methods: readonly HttpMethod[];
  readonly path: string;
  readonly query: readonly string[];
  readonly response: "PublishedIndex" | "PublishedDoc" | "PreviewDoc";
  readonly cacheControl: string;
}

/** Paths are relative to API_ORIGIN. */
export const ENDPOINTS = {
  "published.list": {
    methods: ["GET", "HEAD"],
    path: "/v1/{handle}/published.json",
    query: ["limit", "cursor", "include"],
    response: "PublishedIndex",
    cacheControl: "private, no-cache",
  },
  "published.get": {
    methods: ["GET", "HEAD"],
    path: "/v1/{handle}/published/{id}.json",
    query: [],
    response: "PublishedDoc",
    cacheControl: "private, no-cache",
  },
  "preview.get": {
    methods: ["GET", "HEAD"],
    path: "/v1/preview/{token}.json",
    query: [],
    response: "PreviewDoc",
    cacheControl: "no-store",
  },
} as const satisfies { readonly [K in EndpointName]: EndpointTransport };

/** Sent on every response. 200 / 304 add `ETag` and the endpoint's Cache-Control. */
export const RESPONSE_HEADERS = {
  contentType: "application/json; charset=utf-8",
  robotsTag: "noindex",
  vary: "Authorization",
  wwwAuthenticate: "Bearer",
} as const;

export interface PublishedListQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly include?: IncludeValue;
}

// --- body AST -----------------------------------------------------------------

export const MARK_TYPES = ["bold", "italic", "strike", "code", "link"] as const;
export type MarkType = (typeof MARK_TYPES)[number];

export type Mark =
  | { readonly type: "bold" }
  | { readonly type: "italic" }
  | { readonly type: "strike" }
  | { readonly type: "code" }
  | { readonly type: "link"; readonly href: string };

export interface TextInline {
  readonly type: "text";
  readonly text: string;
  readonly marks?: readonly Mark[];
}

/** Unconfirmed marker; projected to `[CONFIRM: …]`. */
export interface ConfirmInline {
  readonly type: "confirm";
  readonly text: string;
}

export const INLINE_TYPES = ["text", "confirm"] as const;
export type Inline = TextInline | ConfirmInline;

export interface ParagraphBlock {
  readonly type: "paragraph";
  readonly content: readonly Inline[];
}

export interface HeadingBlock {
  readonly type: "heading";
  readonly level: 2 | 3;
  readonly content: readonly Inline[];
}

/** Flat: items are inline runs, never blocks. */
export interface ListBlock {
  readonly type: "list";
  readonly ordered: boolean;
  readonly items: readonly (readonly Inline[])[];
}

export interface QuoteBlock {
  readonly type: "quote";
  readonly content: readonly Inline[];
}

/** Refers to `assets[].id`; alt text lives on the asset. */
export interface FigureBlock {
  readonly type: "figure";
  readonly assetId: string;
  readonly caption: string | null;
}

export interface DividerBlock {
  readonly type: "divider";
}

export type NoteChild = ParagraphBlock | ListBlock;

export interface NoteBlock {
  readonly type: "note";
  readonly blocks: readonly NoteChild[];
}

export const BLOCK_TYPES = ["paragraph", "heading", "list", "quote", "figure", "divider", "note"] as const;
export type Block = ParagraphBlock | HeadingBlock | ListBlock | QuoteBlock | FigureBlock | DividerBlock | NoteBlock;

// --- documents --------------------------------------------------------------

export interface PublishedAsset {
  readonly id: string;
  /** https URL served from the editor's asset store. Sites copy it and verify sha256. */
  readonly url: string;
  readonly contentType: ImageContentType;
  readonly bytes: number;
  readonly sha256: string;
  readonly alt: string;
  readonly credit: string | null;
}

/** Snapshot of the profile at publish time. */
export interface Author {
  readonly name: string;
  readonly handle: string | null;
  readonly url: string | null;
}

export interface Extras {
  readonly app: boolean;
  readonly news: boolean;
  readonly xp: boolean;
}

/** Publish-time category presentation snapshot supplied by the destination server. */
export interface CategoryDisplay {
  readonly labelEn: string;
  readonly labelJa: string;
  readonly displayOrder: number;
  readonly revision: number;
}

export interface PublishedListItem {
  readonly id: string;
  readonly slug: string;
  readonly dest: Dest;
  readonly lang: Lang;
  readonly title: string;
  readonly lead: string | null;
  readonly cover: PublishedAsset | null;
  readonly category: string | null;
  readonly categoryDisplay?: CategoryDisplay;
  readonly author: Author;
  readonly range: PublicationRange;
  readonly version: number;
  readonly publishedAt: string;
  /** When the current snapshot was published. Draft edits never change it. */
  readonly updatedAt: string;
  readonly canonicalUrl: string;
  readonly extras: Extras;
  /** A declaration only; faces re-check it and never treat it as authorization. */
  readonly related: readonly string[];
}

export interface PublishedIndex {
  readonly contractVersion: typeof CONTRACT_VERSION;
  /** updatedAt descending, then id ascending. */
  readonly items: readonly PublishedListItem[];
  readonly nextCursor: string | null;
}

export interface PublishedDoc extends PublishedListItem {
  /** Source of truth. */
  readonly blocks: readonly Block[];
  /** Deterministic projection of blocks (see markdown.ts). */
  readonly markdown: string;
  readonly assets: readonly PublishedAsset[];
  readonly contractVersion: typeof CONTRACT_VERSION;
}

export interface PreviewInfo {
  readonly expiresAt: string;
  readonly dest: Dest;
  readonly noindex: true;
}

export interface PreviewDoc extends PublishedDoc {
  readonly preview: PreviewInfo;
}
