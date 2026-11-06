import type { OwnerId, PageKind, Queryable } from "./types.ts";

/** 検索語の長さの上限（空白を詰めた後の文字数。超えたら QueryTooLongError）。画面の入力も同じ値を使う。 */
export const SEARCH_QUERY_MAX_CHARS = 100;
/** 空白で区切った語の数の上限（超えた分は捨てて、先頭からこの数だけを AND で使う）。 */
export const SEARCH_MAX_TERMS = 8;
/** 結果の数の既定と上限。 */
export const SEARCH_LIMIT_DEFAULT = 30;
export const SEARCH_LIMIT_MAX = 100;
/** snippet の長さ（本文の文字数。前後を切ったときは「…」を足す）。 */
export const SEARCH_SNIPPET_CHARS = 80;
/** snippet で当たった語の前に必ず残す文字数（語が長くても前の文脈を少し見せる）。 */
const SNIPPET_MIN_BEFORE = 10;

/** 検索の結果の 1 行。本文の全体（search_text）は返さず、当たった所の前後だけを snippet に入れる。 */
export type SearchHit = {
  id: string;
  kind: PageKind;
  title: string;
  snippet: string;
  updatedAt: string;
};

export type SearchOptions = { limit?: number };

/** 検索語が長すぎる（呼び出し側は 400 などにする）。 */
export class QueryTooLongError extends RangeError {
  override readonly name = "QueryTooLongError";
  constructor() {
    super(`editor-store: search query must be at most ${SEARCH_QUERY_MAX_CHARS} characters`);
  }
}

function assertOwner(owner: OwnerId): void {
  // store.ts と同じ守り: 認証の層の誤りで空の owner が来たときに、誰のものでもない行を読まない
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) {
    throw new TypeError("editor-store: owner must be a non-empty stable user id");
  }
}

/** 前後の空白を除き、続く空白（改行・全角の空白を含む）を 1 つの半角の空白にする。 */
export function normalizeSearchQuery(query: string): string {
  if (typeof query !== "string") throw new TypeError("editor-store: search query must be a string");
  return query.trim().replace(/\s+/g, " ");
}

/**
 * 検索語を AND で使う語に分ける。空なら []。長すぎたら QueryTooLongError。
 * 大文字小文字だけが違う同じ語は 1 つにまとめ、先頭から SEARCH_MAX_TERMS 語だけを使う。
 */
export function searchTerms(query: string): string[] {
  const normalized = normalizeSearchQuery(query);
  if (Array.from(normalized).length > SEARCH_QUERY_MAX_CHARS) throw new QueryTooLongError();
  if (normalized === "") return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of normalized.split(" ")) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === SEARCH_MAX_TERMS) break;
  }
  return terms;
}

/** ILIKE の部分一致の pattern。`\` `%` `_` を文字どおりに扱う（SQL の側は ESCAPE '\'）。 */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** SQL が返す本文の抜き出し（位置はどれも 1 始まりの文字＝code point の数。PostgreSQL の substr・strpos と同じ）。 */
export type SnippetSource = {
  /** 本文（search_text の題名の後ろ）の文字数。 */
  bodyChars: number;
  /** 最初に当たった語（語の順で最初に本文に出るもの）の本文での位置。本文に無ければ null。 */
  hitPos: number | null;
  /** その語の文字数。 */
  hitChars: number;
  /** 本文の excerptFrom 文字目からの抜き出し（snippet の窓を必ず含む長さ）。 */
  excerpt: string;
  excerptFrom: number;
};

/**
 * snippet: 本文で最初に当たった語の前後 約 SEARCH_SNIPPET_CHARS 文字。当たりが題名だけなら本文の先頭から。
 * 改行・続く空白は 1 つの空白にし、前後を切ったときは「…」を足す。
 */
export function buildSnippet(source: SnippetSource): string {
  const { bodyChars, hitPos, hitChars } = source;
  if (bodyChars <= 0) return "";
  let start = 0;
  let end = Math.min(bodyChars, SEARCH_SNIPPET_CHARS);
  if (hitPos !== null && hitPos >= 1) {
    const hit = hitPos - 1;
    const before = Math.max(SNIPPET_MIN_BEFORE, Math.floor((SEARCH_SNIPPET_CHARS - hitChars) / 2));
    start = Math.max(0, hit - before);
    end = Math.min(bodyChars, Math.max(start + SEARCH_SNIPPET_CHARS, hit + hitChars));
    // 本文の終わりに近いときは、前を広げて長さを揃える
    if (end - start < SEARCH_SNIPPET_CHARS) start = Math.max(0, end - SEARCH_SNIPPET_CHARS);
  }
  const offset = source.excerptFrom - 1;
  const chars = Array.from(source.excerpt);
  const text = chars
    .slice(Math.max(0, start - offset), Math.max(0, end - offset))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return "";
  return `${start > 0 ? "…" : ""}${text}${end < bodyChars ? "…" : ""}`;
}

type SearchRow = {
  id: string;
  kind: PageKind;
  title: string;
  updated_at: Date;
  body_chars: number;
  hit_pos: number | null;
  hit_chars: number | null;
  excerpt_from: number;
  excerpt: string;
};

/**
 * 検索の SQL（固定の文字列。語は全てパラメータで渡し、SQL に連結しない）。
 * $1 owner / $2 limit / $3 snippet の長さ / $4 語の配列（snippet の位置を探す）/ $5〜$12 語ごとの ILIKE の pattern（使わない枠は NULL）。
 * 語の数の枠（8）は SEARCH_MAX_TERMS と同じ。node-pg の名前の無い文は値を入れて計画するので、NULL の枠の条件は計画の時に消える。
 * 本文は search_text の「題名の文字数 + 2」文字目から（migrations/0003_search_text.sql の page_search_text）。
 */
const SEARCH_SQL = String.raw`
SELECT p.id, p.kind, p.title, p.updated_at,
       char_length(b.body) AS body_chars,
       h.pos AS hit_pos,
       h.chars AS hit_chars,
       greatest(coalesce(h.pos, 1) - $3::int, 1) AS excerpt_from,
       substr(b.body, greatest(coalesce(h.pos, 1) - $3::int, 1), $3::int * 2 + coalesce(h.chars, 0)) AS excerpt
  FROM (
        SELECT id, kind, title, updated_at, search_text
          FROM pages
         WHERE owner = $1
           AND deleted_at IS NULL
           AND kind <> 'page'
           AND search_text ILIKE $5::text ESCAPE '\'
           AND ($6::text IS NULL OR search_text ILIKE $6::text ESCAPE '\')
           AND ($7::text IS NULL OR search_text ILIKE $7::text ESCAPE '\')
           AND ($8::text IS NULL OR search_text ILIKE $8::text ESCAPE '\')
           AND ($9::text IS NULL OR search_text ILIKE $9::text ESCAPE '\')
           AND ($10::text IS NULL OR search_text ILIKE $10::text ESCAPE '\')
           AND ($11::text IS NULL OR search_text ILIKE $11::text ESCAPE '\')
           AND ($12::text IS NULL OR search_text ILIKE $12::text ESCAPE '\')
         ORDER BY updated_at DESC, id
         LIMIT $2::int
       ) AS p
 CROSS JOIN LATERAL (SELECT substr(p.search_text, char_length(p.title) + 2) AS body) AS b
  LEFT JOIN LATERAL (
        SELECT strpos(lower(b.body), lower(t.term)) AS pos, char_length(t.term) AS chars
          FROM unnest($4::text[]) WITH ORDINALITY AS t (term, ord)
         WHERE strpos(lower(b.body), lower(t.term)) > 0
         ORDER BY t.ord
         LIMIT 1
       ) AS h ON true
 ORDER BY p.updated_at DESC, p.id`;

/** SEARCH_SQL の pattern の枠の数（$5〜$12。test/search.test.ts が SQL の枠の数と合っていることを確かめる）。 */
const PATTERN_SLOTS = SEARCH_MAX_TERMS;

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return SEARCH_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) {
    throw new RangeError(`editor-store: search limit must be an integer between 1 and ${SEARCH_LIMIT_MAX}`);
  }
  return limit;
}

/**
 * 自分のページを題名と本文から探す（更新順、空白で区切った語の AND、大文字小文字を区別しない部分一致）。
 * 全てのクエリを `owner = $1 AND deleted_at IS NULL` で絞る（別の人のページ・ゴミ箱のページは出ない）。
 * 空の検索語は DB に問い合わせず []。長すぎる検索語は QueryTooLongError。
 */
export async function searchPages(db: Queryable, owner: OwnerId, query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  assertOwner(owner);
  const limit = resolveLimit(options.limit);
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  // NUL は題名にも本文にも入らない（PostgreSQL の text に入らない）ので、含む語はどのページにも当たらない
  if (terms.some((term) => term.includes("\u0000"))) return [];
  const patterns = Array.from({ length: PATTERN_SLOTS }, (_, index) => {
    const term = terms[index];
    return term === undefined ? null : likePattern(term);
  });
  const result = await db.query<SearchRow>(SEARCH_SQL, [owner, limit, SEARCH_SNIPPET_CHARS, terms, ...patterns]);
  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    snippet: buildSnippet({
      bodyChars: row.body_chars,
      hitPos: row.hit_pos,
      hitChars: row.hit_chars ?? 0,
      excerpt: row.excerpt,
      excerptFrom: row.excerpt_from,
    }),
    updatedAt: row.updated_at.toISOString(),
  }));
}
