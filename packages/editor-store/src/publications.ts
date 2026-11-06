import { InvalidPageCursorError, isPageId } from "./store.ts";
import type { Block, Database, OwnerId, PageKind, PageLang, PublishDest, PublishRange, Queryable } from "./types.ts";

/**
 * 公開（#39 公開のシート・#40 公開 API・#41 発信先の設定）の SQL。表は migrations/0009_publications.sql。
 *
 * 意味の正本は packages/editor-publish のポート（PublishTx・ConnectionTx）と、そのメモリの実装（test-support/memory-store.ts）。
 * apps/editor-web の src/publish/pg-store.ts がここの関数をポートにつなぎ、行と editor-publish のレコードを写す
 * （この package は editor-publish に依存しない。node --test の型の除去では `.js` の指定子を解決できないため）。
 *
 * - 書き込みの関数は transaction の中の接続（withTransaction の client）に渡す。失敗は例外のまま返し、呼び出し側が戻す。
 * - 行のロック: getDraftPage({ lock }) はページの行を FOR NO KEY UPDATE で押さえる（同じページの公開・ゴミ箱を直列にする）。
 *   getPublication({ lock }) と listPublicationsByHandle({ lock }) は公開の行を FOR UPDATE で、connectionLive は接続の行を
 *   FOR SHARE で押さえる（解除と公開がすれ違わない）。getConnection({ lock }) は接続の行を FOR NO KEY UPDATE で押さえる
 *   （鍵の作り直しを直列にする。公開の transaction とは「公開の行 → 接続の行」の順を変えない: 押さえる側は公開の行を持たない）。
 * - 鍵・token は SHA-256 の 16 進だけを受け、平文は扱わない。例外にもページの中身や鍵を入れない。
 * - 時刻は ISO 8601 の UTC（ミリ秒）の文字列で受け渡す（PublishService の時計の値）。
 */

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FACE_HANDLES: readonly string[] = ["exp", "niho"];
const CONNECTION_HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const RESERVED_HANDLES: readonly string[] = ["exp", "niho", "preview", "v1", "api", "admin", "editor"];

/** 公開 API の一覧の続きの位置の時刻（PostgreSQL が出した UTC の文字列。マイクロ秒まで）。 */
const CURSOR_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** 公開 API の一覧で一度に返す件数の上限と既定（契約の limit）。 */
export const PUBLISHED_LIST_LIMIT_MAX = 100;
export const PUBLISHED_LIST_LIMIT_DEFAULT = 50;

/** 本人のサイトの受け取り方（#41）。WordPress・Ghost への送信は v1 では動かさない。 */
export const SITE_CONNECTION_MODES = ["api", "wordpress", "ghost"] as const;
export type SiteConnectionMode = (typeof SITE_CONNECTION_MODES)[number];

/** 読み取り先の handle が出す発信先（契約の destOfHandle と同じ。migration の publish_dest_of_handle とも同じ）。 */
export function publishDestOfHandle(handle: unknown): PublishDest | null {
  if (typeof handle !== "string") return null;
  if (FACE_HANDLES.includes(handle)) return handle as PublishDest;
  return CONNECTION_HANDLE_PATTERN.test(handle) && !RESERVED_HANDLES.includes(handle) ? "site" : null;
}

// ---------------------------------------------------------------------------
// 行の型（editor-publish のレコードと同じ形の素のデータ）

/** 編集中のページ（公開版を作る元）。content は pages.blocks（TipTap のブロックの配列）。 */
export type DraftPageRow = {
  id: string;
  ownerId: OwnerId;
  title: string;
  lang: PageLang;
  lead: string | null;
  coverAssetId: string | null;
  content: Block[];
  /** ページの種類（フォルダは公開しない。docs/architecture/editor-recipes-and-folders.md §3.2）。 */
  kind: PageKind;
  /** 保存の版（pages.revision）と保存の時刻（pages.updated_at）。公開 API のプレビューが下書きの version・時刻に使う。 */
  revision: number;
  savedAt: string;
};

/** ページの資産（公開に要る値だけ。bucket の位置は返さない）。 */
export type DraftAssetRow = {
  id: string;
  kind: string;
  bytes: number;
  sha256: string;
  contentType: string;
  alt: string | null;
  credit: string | null;
  consent: boolean;
};

export type PublishExtras = { app: boolean; news: boolean; xp: boolean };

/** 公開（ページごとに 1 行）。公開をやめても残り、stoppedAt が入る。 */
export type PublicationRow = {
  pageId: string;
  dest: PublishDest;
  handle: string;
  slug: string;
  range: PublishRange;
  extras: PublishExtras;
  category: string | null;
  related: string[];
  /** いま出している公開版の番号。 */
  version: number;
  publishedAt: string;
  updatedAt: string;
  stoppedAt: string | null;
};

/** 不変の公開版。snapshot は editor-publish の Snapshot（契約の PublishedDoc ＋ range・fingerprint）の JSON。 */
export type PublicationVersionRow = {
  pageId: string;
  version: number;
  handle: string;
  snapshot: unknown;
};

/** 発信先の URL の場所（読み取り先の handle と slug）。 */
export type PlaceRow = { handle: string; slug: string };

/** 面の旧 URL の転送。to が "list" なら一覧へ。pageId はそこを離れたページ（from の slug を押さえる）。 */
export type RedirectRow = {
  from: PlaceRow;
  to: PlaceRow | "list";
  pageId: string;
  createdAt: string;
};

export type SiteConnectionRow = {
  id: string;
  ownerId: OwnerId;
  handle: string;
  mode: SiteConnectionMode;
  siteUrl: string;
  urlShape: { host: string; path: string };
  assetPolicy: "copy-on-import";
  pushEnabled: false;
  createdAt: string;
  removedAt: string | null;
};

/** 接続の鍵。平文は持たない（SHA-256 の 16 進と末尾 4 文字だけ）。 */
export type ConnectionKeyRow = {
  id: string;
  connectionId: string;
  sha256: string;
  last4: string;
  createdAt: string;
  revokedAt: string | null;
};

// ---------------------------------------------------------------------------
// transaction

/**
 * 1 本の接続を借りて `work` を 1 つの transaction で行う。`work` が値を返せば COMMIT、例外（COMMIT の失敗を含む）なら
 * ROLLBACK して同じ例外を投げる。戻せなかった接続は Pool に返さず捨てる。
 */
export async function withTransaction<T>(db: Database, work: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

// ---------------------------------------------------------------------------
// 共通

function iso(value: Date): string {
  return value.toISOString();
}

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function isInvalidDatetime(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === "22007" || code === "22008";
}

// ---------------------------------------------------------------------------
// 下書き（PublishTx の getPage・listAssets）

type DraftPageDbRow = {
  id: string;
  owner: string;
  kind: PageKind;
  title: string;
  lang: PageLang;
  lead: string | null;
  cover: string | null;
  blocks: Block[];
  revision: number;
  updated_at: Date;
};

/**
 * 公開版を作る元のページ（ゴミ箱のページは null）。`lock` はページの行を FOR NO KEY UPDATE で押さえる:
 * 同じページへの公開（初回を含む）を直列にし、ゴミ箱（deletePage の FOR UPDATE）とすれ違わない。
 */
export async function getDraftPage(db: Queryable, pageId: string, options: { lock?: boolean } = {}): Promise<DraftPageRow | null> {
  if (!isPageId(pageId)) return null;
  const result = await db.query<DraftPageDbRow>(
    `SELECT id, owner, kind, title, lang, lead, cover, blocks, revision, updated_at
       FROM pages
      WHERE id = $1 AND deleted_at IS NULL${options.lock === true ? "\n      FOR NO KEY UPDATE" : ""}`,
    [pageId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner,
    title: row.title,
    lang: row.lang,
    lead: row.lead,
    coverAssetId: row.cover,
    content: row.blocks,
    kind: row.kind,
    revision: row.revision,
    savedAt: iso(row.updated_at),
  };
}

type DraftAssetDbRow = {
  id: string;
  kind: string;
  bytes: string;
  sha256: string;
  content_type: string;
  alt: string | null;
  credit: string | null;
  consent: boolean;
};

/** ページの資産（作った順）。 */
export async function listDraftAssets(db: Queryable, pageId: string): Promise<DraftAssetRow[]> {
  if (!isPageId(pageId)) return [];
  const result = await db.query<DraftAssetDbRow>(
    `SELECT id, kind, bytes::text AS bytes, sha256, content_type, alt, credit, consent
       FROM assets
      WHERE page_id = $1
      ORDER BY created_at, id`,
    [pageId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    bytes: Number(row.bytes),
    sha256: row.sha256,
    contentType: row.content_type,
    alt: row.alt,
    credit: row.credit,
    consent: row.consent,
  }));
}

// ---------------------------------------------------------------------------
// 公開・公開版・転送（PublishTx）

type PublicationDbRow = {
  page_id: string;
  dest: PublishDest;
  handle: string;
  slug: string;
  range: PublishRange;
  extras_app: boolean;
  extras_news: boolean;
  extras_xp: boolean;
  category: string | null;
  related: string[];
  version: number;
  published_at: Date;
  updated_at: Date;
  stopped_at: Date | null;
};

const PUBLICATION_COLUMNS = `pub.page_id, pub.dest, pub.handle, pub.slug, pub.range, pub.extras_app, pub.extras_news, pub.extras_xp,
       pub.category, pub.related, pub.version, pub.published_at, pub.updated_at, pub.stopped_at`;

function toPublication(row: PublicationDbRow): PublicationRow {
  return {
    pageId: row.page_id,
    dest: row.dest,
    handle: row.handle,
    slug: row.slug,
    range: row.range,
    extras: { app: row.extras_app, news: row.extras_news, xp: row.extras_xp },
    category: row.category,
    related: [...row.related],
    version: row.version,
    publishedAt: iso(row.published_at),
    updatedAt: iso(row.updated_at),
    stoppedAt: isoOrNull(row.stopped_at),
  };
}

/** ページの公開（無ければ null）。`lock` は行を FOR UPDATE で押さえる（同じページの公開・停止・解除を直列にする）。 */
export async function getPublication(db: Queryable, pageId: string, options: { lock?: boolean } = {}): Promise<PublicationRow | null> {
  if (!isPageId(pageId)) return null;
  const result = await db.query<PublicationDbRow>(
    `SELECT ${PUBLICATION_COLUMNS}
       FROM publications pub
      WHERE pub.page_id = $1${options.lock === true ? "\n      FOR UPDATE" : ""}`,
    [pageId],
  );
  const row = result.rows[0];
  return row ? toPublication(row) : null;
}

/**
 * その handle の公開（公開をやめたものも含む。ページ id の順）。`lock` は行を FOR UPDATE で押さえる:
 * 接続の解除が読んだ公開を、同時の発信先の変更が書き換えたあとで古い値で上書きしない（待ったあとで handle を見直す）。
 */
export async function listPublicationsByHandle(db: Queryable, handle: string, options: { lock?: boolean } = {}): Promise<PublicationRow[]> {
  const result = await db.query<PublicationDbRow>(
    `SELECT ${PUBLICATION_COLUMNS}
       FROM publications pub
      WHERE pub.handle = $1
      ORDER BY pub.page_id${options.lock === true ? "\n      FOR UPDATE" : ""}`,
    [handle],
  );
  return result.rows.map(toPublication);
}

/**
 * **本人の**公開中（公開をやめていない）ページの数を handle ごとに数える（Issue #41 の発信先の一覧）。
 *
 * `publications` の行は handle だけでは本人のものに絞れない（NIHO の面の handle は全員で共有する）ので、
 * ページの owner で必ず絞る。渡した handle のうち 1 件も無いものは 0 として返す。
 * 他の人の公開は数にも入らない（行も読まない）。
 */
export async function countLivePublishedByHandle(db: Queryable, owner: OwnerId, handles: readonly string[]): Promise<Map<string, number>> {
  // 認証の層の誤りで空の owner が来たときに、誰のものでもない行を数えないための守り（store.ts と同じ）
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) {
    throw new TypeError("editor-store: owner must be a non-empty stable user id");
  }
  const wanted = [...new Set(handles.filter((handle) => typeof handle === "string" && handle.length > 0))];
  const counts = new Map<string, number>(wanted.map((handle) => [handle, 0]));
  if (wanted.length === 0) return counts;
  const result = await db.query<{ handle: string; n: string }>(
    `SELECT pub.handle, count(*)::text AS n
       FROM publications pub
       JOIN pages p ON p.id = pub.page_id
      WHERE p.owner = $1 AND p.deleted_at IS NULL AND pub.handle = ANY($2::text[]) AND pub.stopped_at IS NULL
      GROUP BY pub.handle`,
    [owner, wanted],
  );
  for (const row of result.rows) counts.set(row.handle, Number(row.n));
  return counts;
}

/** ページの公開を足すか置き換える。別のページの公開が同じ handle と slug を持っていれば失敗する（一意の制約）。 */
export async function putPublication(db: Queryable, row: PublicationRow): Promise<void> {
  await db.query(
    `INSERT INTO publications (page_id, dest, handle, slug, range, extras_app, extras_news, extras_xp,
                               category, related, version, published_at, updated_at, stopped_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11, $12, $13, $14)
     ON CONFLICT (page_id) DO UPDATE
       SET dest = EXCLUDED.dest,
           handle = EXCLUDED.handle,
           slug = EXCLUDED.slug,
           range = EXCLUDED.range,
           extras_app = EXCLUDED.extras_app,
           extras_news = EXCLUDED.extras_news,
           extras_xp = EXCLUDED.extras_xp,
           category = EXCLUDED.category,
           related = EXCLUDED.related,
           version = EXCLUDED.version,
           published_at = EXCLUDED.published_at,
           updated_at = EXCLUDED.updated_at,
           stopped_at = EXCLUDED.stopped_at`,
    [
      row.pageId,
      row.dest,
      row.handle,
      row.slug,
      row.range,
      row.extras.app,
      row.extras.news,
      row.extras.xp,
      row.category,
      [...row.related],
      row.version,
      row.publishedAt,
      row.updatedAt,
      row.stoppedAt,
    ],
  );
}

/**
 * handle の上で、`base` か `base-N` の slug のうち、ほかのページが押さえているもの（公開。やめたものも含む。
 * または、そのページが残した転送の from）。文字の順。
 */
export async function takenSlugs(db: Queryable, handle: string, base: string, exceptPageId: string): Promise<string[]> {
  const result = await db.query<{ slug: string }>(
    `SELECT taken.slug
       FROM (
         SELECT slug FROM publications WHERE handle = $1 AND page_id <> $3::uuid
         UNION
         SELECT from_slug FROM publication_redirects WHERE from_handle = $1 AND page_id <> $3::uuid
       ) AS taken (slug)
      WHERE taken.slug = $2
         OR (starts_with(taken.slug, $2 || '-') AND substr(taken.slug, length($2) + 2) ~ '^[0-9]+$')
      ORDER BY taken.slug COLLATE "C"`,
    [handle, base, exceptPageId],
  );
  return result.rows.map((row) => row.slug);
}

/** ページの最新の公開版の番号（公開したことが無ければ 0）。 */
export async function latestPublicationVersion(db: Queryable, pageId: string): Promise<number> {
  if (!isPageId(pageId)) return 0;
  const result = await db.query<{ latest: number }>(
    "SELECT COALESCE(max(version), 0)::int AS latest FROM publication_versions WHERE page_id = $1",
    [pageId],
  );
  return result.rows[0]?.latest ?? 0;
}

/** 公開版を足す。同じ番号が既にあれば失敗する（公開版は書き換えない）。 */
export async function addPublicationVersion(db: Queryable, row: PublicationVersionRow): Promise<void> {
  await db.query("INSERT INTO publication_versions (page_id, version, handle, snapshot) VALUES ($1, $2, $3, $4::jsonb)", [
    row.pageId,
    row.version,
    row.handle,
    JSON.stringify(row.snapshot),
  ]);
}

/** 公開版 1 つ（無ければ null）。 */
export async function getPublicationVersion(db: Queryable, pageId: string, version: number): Promise<PublicationVersionRow | null> {
  if (!isPageId(pageId) || !Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647) return null;
  const result = await db.query<{ page_id: string; version: number; handle: string; snapshot: unknown }>(
    "SELECT page_id, version, handle, snapshot FROM publication_versions WHERE page_id = $1 AND version = $2",
    [pageId, version],
  );
  const row = result.rows[0];
  return row ? { pageId: row.page_id, version: row.version, handle: row.handle, snapshot: row.snapshot } : null;
}

type RedirectDbRow = {
  from_handle: string;
  from_slug: string;
  to_handle: string | null;
  to_slug: string | null;
  page_id: string;
  created_at: Date;
};

function toRedirect(row: RedirectDbRow): RedirectRow {
  return {
    from: { handle: row.from_handle, slug: row.from_slug },
    to: row.to_handle === null || row.to_slug === null ? "list" : { handle: row.to_handle, slug: row.to_slug },
    pageId: row.page_id,
    createdAt: iso(row.created_at),
  };
}

/** `to` の場所へ向いている転送（一覧へのものは含まない）。 */
export async function listRedirectsTo(db: Queryable, to: PlaceRow): Promise<RedirectRow[]> {
  const result = await db.query<RedirectDbRow>(
    `SELECT from_handle, from_slug, to_handle, to_slug, page_id, created_at
       FROM publication_redirects
      WHERE to_handle = $1 AND to_slug = $2
      ORDER BY from_handle, from_slug`,
    [to.handle, to.slug],
  );
  return result.rows.map(toRedirect);
}

/** 転送を足す。同じ from の転送は置き換える。 */
export async function putRedirect(db: Queryable, row: RedirectRow): Promise<void> {
  const to = row.to === "list" ? null : row.to;
  await db.query(
    `INSERT INTO publication_redirects (from_handle, from_slug, to_handle, to_slug, page_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (from_handle, from_slug) DO UPDATE
       SET to_handle = EXCLUDED.to_handle,
           to_slug = EXCLUDED.to_slug,
           page_id = EXCLUDED.page_id,
           created_at = EXCLUDED.created_at`,
    [row.from.handle, row.from.slug, to?.handle ?? null, to?.slug ?? null, row.pageId, row.createdAt],
  );
}

/** from の転送を消す（無ければ何もしない）。 */
export async function deleteRedirect(db: Queryable, from: PlaceRow): Promise<void> {
  await db.query("DELETE FROM publication_redirects WHERE from_handle = $1 AND from_slug = $2", [from.handle, from.slug]);
}

// ---------------------------------------------------------------------------
// 接続と鍵（ConnectionTx）

type ConnectionDbRow = {
  id: string;
  owner: string;
  handle: string;
  mode: SiteConnectionMode;
  site_url: string;
  url_host: string;
  url_path: string;
  created_at: Date;
  removed_at: Date | null;
};

const CONNECTION_COLUMNS = "id, owner, handle, mode, site_url, url_host, url_path, created_at, removed_at";

function toConnection(row: ConnectionDbRow): SiteConnectionRow {
  return {
    id: row.id,
    ownerId: row.owner,
    handle: row.handle,
    mode: row.mode,
    siteUrl: row.site_url,
    urlShape: { host: row.url_host, path: row.url_path },
    assetPolicy: "copy-on-import",
    pushEnabled: false,
    createdAt: iso(row.created_at),
    removedAt: isoOrNull(row.removed_at),
  };
}

/**
 * `ownerId` がこの handle の接続を持ち、解除していないか。接続の行を FOR SHARE で押さえる:
 * 公開の transaction が終わるまで解除（removed_at の UPDATE）を待たせ、解除が先なら解除のあとの行で答える。
 * handle の行が無ければ false。
 */
export async function connectionLive(db: Queryable, ownerId: OwnerId, handle: string): Promise<boolean> {
  const result = await db.query<{ owner: string; live: boolean }>(
    "SELECT owner, removed_at IS NULL AS live FROM site_connections WHERE handle = $1 FOR SHARE",
    [handle],
  );
  const row = result.rows[0];
  return row !== undefined && row.owner === ownerId && row.live;
}

/**
 * 接続 1 つ（解除したものも含む。無ければ null）。`lock` は行を FOR NO KEY UPDATE で押さえる（同じ接続の鍵の作り直しを直列にする。
 * 待った側は、先の transaction が済んだあとの鍵を読む）。
 */
export async function getConnection(db: Queryable, connectionId: string, options: { lock?: boolean } = {}): Promise<SiteConnectionRow | null> {
  if (!isPageId(connectionId)) return null;
  const result = await db.query<ConnectionDbRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM site_connections WHERE id = $1${options.lock === true ? "\n      FOR NO KEY UPDATE" : ""}`,
    [connectionId],
  );
  const row = result.rows[0];
  return row ? toConnection(row) : null;
}

/** handle の接続（解除したものも含む。無ければ null）。 */
export async function getConnectionByHandle(db: Queryable, handle: string): Promise<SiteConnectionRow | null> {
  const result = await db.query<ConnectionDbRow>(`SELECT ${CONNECTION_COLUMNS} FROM site_connections WHERE handle = $1`, [handle]);
  const row = result.rows[0];
  return row ? toConnection(row) : null;
}

/** owner の接続（解除したものも含む。作った順）。 */
export async function listConnections(db: Queryable, ownerId: OwnerId): Promise<SiteConnectionRow[]> {
  const result = await db.query<ConnectionDbRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM site_connections WHERE owner = $1 ORDER BY created_at, id`,
    [ownerId],
  );
  return result.rows.map(toConnection);
}

/**
 * 接続を足すか、id で置き換える。別の接続が同じ handle を持っていれば（解除したものも含む）失敗する（一意の制約）。
 * id・owner・handle・作成時刻の変更と、解除の取り消しは trigger が断る。
 */
export async function putConnection(db: Queryable, row: SiteConnectionRow): Promise<void> {
  await db.query(
    `INSERT INTO site_connections (id, owner, handle, mode, site_url, url_host, url_path, asset_policy, push_enabled, created_at, removed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO UPDATE
       SET owner = EXCLUDED.owner,
           handle = EXCLUDED.handle,
           mode = EXCLUDED.mode,
           site_url = EXCLUDED.site_url,
           url_host = EXCLUDED.url_host,
           url_path = EXCLUDED.url_path,
           asset_policy = EXCLUDED.asset_policy,
           push_enabled = EXCLUDED.push_enabled,
           created_at = EXCLUDED.created_at,
           removed_at = EXCLUDED.removed_at`,
    [
      row.id,
      row.ownerId,
      row.handle,
      row.mode,
      row.siteUrl,
      row.urlShape.host,
      row.urlShape.path,
      row.assetPolicy,
      row.pushEnabled,
      row.createdAt,
      row.removedAt,
    ],
  );
}

type KeyDbRow = {
  id: string;
  connection_id: string;
  sha256: string;
  last4: string;
  created_at: Date;
  revoked_at: Date | null;
};

const KEY_COLUMNS = "id, connection_id, sha256, last4, created_at, revoked_at";

function toKey(row: KeyDbRow): ConnectionKeyRow {
  return {
    id: row.id,
    connectionId: row.connection_id,
    sha256: row.sha256,
    last4: row.last4,
    createdAt: iso(row.created_at),
    revokedAt: isoOrNull(row.revoked_at),
  };
}

/** 接続の鍵（失効したものも含む。作った順）。 */
export async function listConnectionKeys(db: Queryable, connectionId: string): Promise<ConnectionKeyRow[]> {
  if (!isPageId(connectionId)) return [];
  const result = await db.query<KeyDbRow>(
    `SELECT ${KEY_COLUMNS} FROM site_connection_keys WHERE connection_id = $1 ORDER BY created_at, id`,
    [connectionId],
  );
  return result.rows.map(toKey);
}

/** ハッシュ（SHA-256 の 16 進）の鍵（失効したものも含む。無い・形が違えば null）。 */
export async function findConnectionKeyBySha256(db: Queryable, sha256: string): Promise<ConnectionKeyRow | null> {
  if (!SHA256_PATTERN.test(sha256)) return null;
  const result = await db.query<KeyDbRow>(`SELECT ${KEY_COLUMNS} FROM site_connection_keys WHERE sha256 = $1`, [sha256]);
  const row = result.rows[0];
  return row ? toKey(row) : null;
}

/**
 * 鍵を足すか、id で置き換える。別の鍵が同じハッシュを持っていれば失敗する（一意の制約）。
 * 決まった値（接続・ハッシュ・末尾・作成時刻）の変更と、失効の取り消しは trigger が断る。
 */
export async function putConnectionKey(db: Queryable, row: ConnectionKeyRow): Promise<void> {
  await db.query(
    `INSERT INTO site_connection_keys (id, connection_id, sha256, last4, created_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE
       SET connection_id = EXCLUDED.connection_id,
           sha256 = EXCLUDED.sha256,
           last4 = EXCLUDED.last4,
           created_at = EXCLUDED.created_at,
           revoked_at = EXCLUDED.revoked_at`,
    [row.id, row.connectionId, row.sha256, row.last4, row.createdAt, row.revokedAt],
  );
}

// ---------------------------------------------------------------------------
// 公開 API v1 の読み取り（docs/security/editor-publish-api-v1.md）。認証・認可は呼び出し側が先に行う。

/** 鍵の接続（鍵が失効しておらず、接続が解除されていないときだけ）。それ以外（形の不正・未知を含む）は区別せず null。 */
export async function connectionByKeySha256(db: Queryable, sha256: string): Promise<{ connectionId: string; handle: string } | null> {
  if (!SHA256_PATTERN.test(sha256)) return null;
  const result = await db.query<{ id: string; handle: string }>(
    `SELECT c.id, c.handle
       FROM site_connection_keys k
       JOIN site_connections c ON c.id = k.connection_id
      WHERE k.sha256 = $1 AND k.revoked_at IS NULL AND c.removed_at IS NULL`,
    [sha256],
  );
  const row = result.rows[0];
  return row ? { connectionId: row.id, handle: row.handle } : null;
}

/** 公開 API の一覧の続きの位置。updatedAt は UTC のマイクロ秒までの文字列（`2026-10-01T09:00:00.000000Z`）。 */
export type PublishedCursor = { updatedAt: string; pageId: string };

export type LivePublishedOptions = {
  /** 限定公開（unlisted）も載せる（NIHO の面の `include=unlisted` だけ）。 */
  includeUnlisted?: boolean;
  /** 1〜100（既定 50）。 */
  limit?: number;
  /** 前の区切りの next。無ければ先頭から。 */
  after?: PublishedCursor | null;
};

export type LivePublishedItem = {
  publication: PublicationRow;
  /** いまの公開版の snapshot から本文（blocks・markdown・assets）を除いたもの（一覧の項目に要る値）。 */
  listing: unknown;
  /** この行の位置（次の区切りの after に使える）。 */
  cursor: PublishedCursor;
};

export type LivePublishedChunk = { items: LivePublishedItem[]; next: PublishedCursor | null };

/**
 * その handle の公開中（stopped_at が無い）の公開を、updatedAt の新しい順・同じ時刻はページ id の昇順で limit 件。
 * 範囲が live のものだけ（includeUnlisted なら unlisted も）。after は時刻をマイクロ秒まで文字列のまま比べる。
 * 形の不正な after は InvalidPageCursorError。handle として不正な値は空。
 */
export async function listLivePublished(db: Queryable, handle: string, options: LivePublishedOptions = {}): Promise<LivePublishedChunk> {
  if (publishDestOfHandle(handle) === null) return { items: [], next: null };
  const requested = options.limit !== undefined && Number.isFinite(options.limit) ? Math.trunc(options.limit) : PUBLISHED_LIST_LIMIT_DEFAULT;
  const limit = Math.max(1, Math.min(requested, PUBLISHED_LIST_LIMIT_MAX));
  const after = options.after ?? null;
  if (after !== null && (!CURSOR_TIME_PATTERN.test(after.updatedAt) || !isPageId(after.pageId))) throw new InvalidPageCursorError();
  // 1 件多く読んで、続きがあるかを知る
  const params: unknown[] = [handle, options.includeUnlisted === true, limit + 1];
  if (after) params.push(after.updatedAt, after.pageId);
  let rows: Array<PublicationDbRow & { listing: unknown; cursor_time: string }>;
  try {
    const result = await db.query<PublicationDbRow & { listing: unknown; cursor_time: string }>(
      `SELECT ${PUBLICATION_COLUMNS},
              v.snapshot - 'blocks' - 'markdown' - 'assets' AS listing,
              to_char(pub.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
         FROM publications pub
         JOIN publication_versions v ON v.page_id = pub.page_id AND v.version = pub.version
        WHERE pub.handle = $1 AND pub.stopped_at IS NULL
          AND (pub.range = 'live' OR ($2::boolean AND pub.range = 'unlisted'))${
            after ? "\n          AND (pub.updated_at < $4::timestamptz OR (pub.updated_at = $4::timestamptz AND pub.page_id > $5::uuid))" : ""
          }
        ORDER BY pub.updated_at DESC, pub.page_id
        LIMIT $3`,
      params,
    );
    rows = result.rows;
  } catch (error) {
    // 形は合っていても日付として無い値（2 月 30 日など）
    if (after && isInvalidDatetime(error)) throw new InvalidPageCursorError();
    throw error;
  }
  const items = rows.slice(0, limit).map((row) => ({
    publication: toPublication(row),
    listing: row.listing,
    cursor: { updatedAt: row.cursor_time, pageId: row.page_id },
  }));
  const last = items[items.length - 1];
  return { items, next: rows.length > limit && last ? last.cursor : null };
}

/** 面から面へ移した公開版の移動先（契約の 410 の movedTo の元）。 */
export type PublishedMovedTo = { handle: string; dest: PublishDest; canonicalUrl: string };

export type PublishedForHandle =
  /** この handle に公開中。snapshot はいまの公開版（範囲は publication.range を使う）。 */
  | { status: "live"; publication: PublicationRow; snapshot: unknown }
  /**
   * この handle で公開をやめた、または発信先の変更でこの handle を離れた。version・slug・range はこの handle での最後の版の値。
   * stoppedAt はやめた時刻（離れたときは、次の版を出した時刻）。movedTo は面から面への転送があり、移動先で公開中のときだけ
   * （本人のサイトの資格には返さない。それは呼び出し側が決める）。
   */
  | {
      status: "left";
      pageId: string;
      handle: string;
      dest: PublishDest;
      slug: string;
      range: PublishRange;
      version: number;
      stoppedAt: string;
      movedTo: PublishedMovedTo | null;
    };

type ReadPublishedDbRow = PublicationDbRow & {
  snapshot: unknown;
  current_url: string | null;
  here_version: number | null;
  here_slug: string | null;
  here_range: string | null;
  left_at: string | null;
  moved_handle: string | null;
};

/**
 * 公開 API の単体（`/v1/{handle}/published/{id}.json`）の元。意味は editor-publish の test-support/reference-world.ts と同じ:
 * いまの公開がこの handle にあれば、公開中なら live、やめていれば left。別の handle に移っていれば、この handle に出した
 * 最後の版で left（転送が面から面で、移動先で公開中なら movedTo）。この handle に出したことが無ければ null。
 * 1 文で読む（同時の書き込みがあっても、ひとつの時点の値で答える）。
 */
export async function readPublishedForHandle(db: Queryable, handle: string, pageId: string): Promise<PublishedForHandle | null> {
  const dest = publishDestOfHandle(handle);
  if (dest === null || !isPageId(pageId)) return null;
  const result = await db.query<ReadPublishedDbRow>(
    `SELECT ${PUBLICATION_COLUMNS},
            CASE WHEN pub.handle = $1 AND pub.stopped_at IS NULL THEN cur.snapshot END AS snapshot,
            cur.snapshot ->> 'canonicalUrl' AS current_url,
            here.version AS here_version,
            here.slug AS here_slug,
            here.range AS here_range,
            nxt.left_at,
            r.to_handle AS moved_handle
       FROM publications pub
       JOIN publication_versions cur ON cur.page_id = pub.page_id AND cur.version = pub.version
       LEFT JOIN LATERAL (
         SELECT v.version, v.snapshot ->> 'slug' AS slug, v.snapshot ->> 'range' AS range
           FROM publication_versions v
          WHERE v.page_id = pub.page_id AND v.handle = $1 AND pub.handle <> $1
          ORDER BY v.version DESC
          LIMIT 1
       ) here ON true
       LEFT JOIN LATERAL (
         SELECT v.snapshot ->> 'updatedAt' AS left_at
           FROM publication_versions v
          WHERE v.page_id = pub.page_id AND v.version > here.version
          ORDER BY v.version
          LIMIT 1
       ) nxt ON true
       LEFT JOIN publication_redirects r
         ON r.from_handle = $1 AND r.from_slug = here.slug AND r.page_id = pub.page_id
      WHERE pub.page_id = $2`,
    [handle, pageId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const publication = toPublication(row);
  if (publication.handle === handle) {
    if (publication.stoppedAt === null) return { status: "live", publication, snapshot: row.snapshot };
    return {
      status: "left",
      pageId,
      handle,
      dest,
      slug: publication.slug,
      range: publication.range,
      version: publication.version,
      stoppedAt: publication.stoppedAt,
      movedTo: null,
    };
  }
  if (row.here_version === null || row.here_slug === null || row.left_at === null) return null;
  const range = row.here_range === "unlisted" ? "unlisted" : "live";
  const target = row.moved_handle;
  const moved =
    target !== null && FACE_HANDLES.includes(handle) && FACE_HANDLES.includes(target) && target !== handle
    && publication.handle === target && publication.dest === target && publication.stoppedAt === null && row.current_url !== null;
  return {
    status: "left",
    pageId,
    handle,
    dest,
    slug: row.here_slug,
    range,
    version: row.here_version,
    stoppedAt: row.left_at,
    movedTo: moved ? { handle: target, dest: publication.dest, canonicalUrl: row.current_url as string } : null,
  };
}

// ---------------------------------------------------------------------------
// プレビューの token（平文は持たない。SHA-256 の 16 進だけ）

/** token に結んだ著者（契約の Author と同じ形。0010）。名前は空白だけでなく 256 文字まで、url は https。 */
export type PreviewTokenAuthor = { name: string; handle: string | null; url: string | null };

export type PreviewTokenRow = {
  sha256: string;
  pageId: string;
  ownerId: OwnerId;
  /** 拘束する読み取り先（面は exp / niho、本人のサイトは接続の handle）。 */
  handle: string;
  issuedAt: string;
  /** 発行から 15 分以内（表の CHECK）。 */
  expiresAt: string;
  /** 発行したときの本人の著者。無い（0010 より前の token・名前の無い本人）は null。 */
  author: PreviewTokenAuthor | null;
};

type PreviewTokenDbRow = {
  sha256: string;
  page_id: string;
  owner: string;
  handle: string;
  issued_at: Date;
  expires_at: Date;
  author_name: string | null;
  author_handle: string | null;
  author_url: string | null;
};

const PREVIEW_TOKEN_COLUMNS = "sha256, page_id, owner, handle, issued_at, expires_at, author_name, author_handle, author_url";

function toPreviewToken(row: PreviewTokenDbRow): PreviewTokenRow {
  return {
    sha256: row.sha256,
    pageId: row.page_id,
    ownerId: row.owner,
    handle: row.handle,
    issuedAt: iso(row.issued_at),
    expiresAt: iso(row.expires_at),
    author: row.author_name === null ? null : { name: row.author_name, handle: row.author_handle, url: row.author_url },
  };
}

/**
 * プレビューの token を記録する。ページが owner の（ゴミ箱に無い）ページでなければ何も書かずに null。
 * 有効期限が発行から 15 分を超える・発行より前、著者の形が表の CHECK（0009）に合わないなら失敗する。
 */
export async function createPreviewToken(db: Queryable, row: PreviewTokenRow): Promise<PreviewTokenRow | null> {
  if (!SHA256_PATTERN.test(row.sha256)) throw new TypeError("editor-store: preview token hash must be a SHA-256 hex digest");
  if (publishDestOfHandle(row.handle) === null) throw new TypeError("editor-store: preview token handle is not a readable handle");
  if (!isPageId(row.pageId)) return null;
  const result = await db.query<PreviewTokenDbRow>(
    `INSERT INTO preview_tokens (${PREVIEW_TOKEN_COLUMNS})
     SELECT $1, p.id, p.owner, $4, $5, $6, $7, $8, $9
       FROM pages p
      WHERE p.id = $2 AND p.owner = $3 AND p.deleted_at IS NULL
     RETURNING ${PREVIEW_TOKEN_COLUMNS}`,
    [row.sha256, row.pageId, row.ownerId, row.handle, row.issuedAt, row.expiresAt, row.author?.name ?? null, row.author?.handle ?? null, row.author?.url ?? null],
  );
  const inserted = result.rows[0];
  return inserted ? toPreviewToken(inserted) : null;
}

/**
 * ハッシュの token（期限内で、ページがゴミ箱に無いものだけ。それ以外は区別せず null）。
 * 期限は `now`（ISO 8601。省略すると DB の時計）と比べる。
 */
export async function findPreviewToken(db: Queryable, sha256: string, now?: string): Promise<PreviewTokenRow | null> {
  if (!SHA256_PATTERN.test(sha256)) return null;
  const result = await db.query<PreviewTokenDbRow>(
    `SELECT t.sha256, t.page_id, t.owner, t.handle, t.issued_at, t.expires_at, t.author_name, t.author_handle, t.author_url
       FROM preview_tokens t
       JOIN pages p ON p.id = t.page_id AND p.owner = t.owner
      WHERE t.sha256 = $1 AND t.expires_at > COALESCE($2::timestamptz, clock_timestamp()) AND p.deleted_at IS NULL`,
    [sha256, now ?? null],
  );
  const row = result.rows[0];
  return row ? toPreviewToken(row) : null;
}

/** 期限切れの token を消す（`now` を省略すると DB の時計）。消した数を返す。 */
export async function deleteExpiredPreviewTokens(db: Queryable, now?: string): Promise<number> {
  const result = await db.query("DELETE FROM preview_tokens WHERE expires_at <= COALESCE($1::timestamptz, clock_timestamp())", [now ?? null]);
  return result.rowCount ?? 0;
}
