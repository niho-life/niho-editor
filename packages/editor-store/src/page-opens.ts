import type { OwnerId, PageSummary, Queryable } from "./types.ts";

/**
 * 「最近」（表 page_opens。migration 20261101013000_folder_order_fields_opens。旧 NIHO docs の `recent.json`）。
 *
 * - owner ごとに 1 ページ 1 行で、**開いた時刻だけ**を持つ（回数・端末・滞在時間は持たない）。
 * - ゴミ箱に入れたページは一覧から外す（行は残り、戻せばまた出る）。完全に消すと外部キーで一緒に消える。
 * - 一覧は新しく開いた順。更新順の一覧（`listPageChunk`）とは別で、手動の並びにしても「最近」は時刻の順。
 */

/** 「最近」に出す件数の上限（旧 `recent.json` と同じ 10 件）。 */
export const RECENT_LIMIT = 10;

function assertOwner(owner: OwnerId): void {
  // store.ts と同じ守り（空の owner で誰のものでもない行を読み書きしない）
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) {
    throw new TypeError("editor-store: owner must be a non-empty stable user id");
  }
}

/**
 * ページを開いたことを記録する（開くたびに時刻を進める）。本人のページでなければ何も書かず false
 * （外部キーで断られるのを待たずに、先に本人のページかを見る）。
 */
export async function recordPageOpen(db: Queryable, owner: OwnerId, pageId: string): Promise<boolean> {
  assertOwner(owner);
  const result = await db.query(
    `INSERT INTO page_opens (owner, page_id)
     SELECT $1, p.id FROM pages p WHERE p.owner = $1 AND p.deleted_at IS NULL AND p.id = $2
     ON CONFLICT (owner, page_id) DO UPDATE SET opened_at = clock_timestamp()`,
    [owner, pageId],
  );
  return result.rowCount === 1;
}

type RecentRow = {
  id: string;
  kind: PageSummary["kind"];
  title: string;
  lang: PageSummary["lang"];
  parent: string | null;
  step_status: PageSummary["stepStatus"];
  sort_order: number;
  created_at: Date;
  updated_at: Date;
  opened_at: Date;
};

/** 最近開いたページ（新しい順。ゴミ箱のページは出さない）。公開の状態は持たない（2 行目は出さない）。 */
export async function listRecentPages(db: Queryable, owner: OwnerId, options: { limit?: number } = {}): Promise<PageSummary[]> {
  assertOwner(owner);
  const limit = Math.max(1, Math.min(options.limit ?? RECENT_LIMIT, RECENT_LIMIT));
  const result = await db.query<RecentRow>(
    `SELECT p.id, p.kind, p.title, p.lang, p.parent, p.step_status, p.sort_order, p.created_at, p.updated_at, o.opened_at
       FROM page_opens o JOIN pages p ON p.owner = o.owner AND p.id = o.page_id
      WHERE o.owner = $1 AND p.deleted_at IS NULL
      ORDER BY o.opened_at DESC, p.id
      LIMIT $2`,
    [owner, limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    lang: row.lang,
    parent: row.parent,
    stepStatus: row.step_status,
    sortOrder: row.sort_order,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    publication: null,
  }));
}
