import {
  VERSION_REASONS,
  type Block,
  type CreatePageInput,
  type Database,
  type DeleteResult,
  type MoveOrderResult,
  type MovePageResult,
  type OrderMove,
  type OwnerId,
  type Page,
  type PageChunk,
  type PageChunkOptions,
  type PageKind,
  type PageLang,
  type PagePatch,
  type PageSummary,
  type PageVersion,
  type PageVersionSummary,
  type PublishDest,
  type PublishRange,
  type PurgeResult,
  type Queryable,
  type RestoreOptions,
  type RestoreResult,
  type SaveOptions,
  type SaveResult,
  type StepStatus,
  type TrashedPage,
  type VersionReason,
} from "./types.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 一覧で一度に返す上限。 */
export const PAGE_LIST_LIMIT = 500;
/**
 * 親子の段の上限（docs/architecture/editor-recipes-and-folders.md §3）。0＝フォルダ、1＝その中のページ、
 * 2＝録音のサブページ（手順の成果物）。これより深くすると、一覧も検索も辿り切れなくなる。
 */
export const MAX_PAGE_DEPTH = 2;

/**
 * 同じ親の中の並び（docs/architecture/editor-recipes-and-folders.md §3）。手動の並び（`sort_order`。0 は並べ替えていない）が
 * 先で、同じ値なら: 上の段は**更新の新しい順**（今までの一覧と同じ）、フォルダ・録音の中は**作った順**（手順のサブページが
 * 段の順に並ぶ）。SQL と画面（apps/editor-web の sidebar-items.ts）で同じ規則にする。
 */
function orderOf(parent: string | null, prefix = ""): string {
  return parent === null ? `${prefix}sort_order, ${prefix}updated_at DESC, ${prefix}id` : `${prefix}sort_order, ${prefix}created_at, ${prefix}id`;
}
/** 版の一覧で返す上限（新しい順）。 */
export const VERSION_LIST_LIMIT = 100;
/** 1 ページに残す版の数。超えたら古い autosave の版から捨てる（autosave 以外の版は捨てない）。公開版は別の表（publication_versions）。 */
export const VERSION_KEEP_LIMIT = 200;
/** 自動保存で版を残す間隔の既定（10 分）。 */
export const DEFAULT_AUTOSAVE_VERSION_INTERVAL_MS = 10 * 60 * 1000;
/** ゴミ箱の一覧で返す上限。 */
export const TRASH_LIST_LIMIT = 500;
/** ゴミ箱に置く日数。過ぎたものは purgeTrash で完全に消す。 */
export const TRASH_RETENTION_DAYS = 30;

/** PostgreSQL の integer の上限（revision・版の番号の列）。 */
const MAX_INTEGER = 2_147_483_647;

/** listPageChunk の limit の既定。 */
const PAGE_CHUNK_DEFAULT = 100;

/**
 * 一覧の続きの位置（`<updated_at>_<id>`）。updated_at は PostgreSQL が出した UTC の文字列のまま持つ
 * （JavaScript の Date はマイクロ秒を落とすので、同じ時刻の行の境目がずれる）。
 */
const CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** cursor として読めない値（API は 400 にする）。 */
export class InvalidPageCursorError extends Error {
  override readonly name = "InvalidPageCursorError";
  constructor() {
    super("editor-store: invalid page list cursor");
  }
}

/** UUID の文字列として正しいか（正しくない id は DB に渡さず「無い」と同じに扱う）。 */
export function isPageId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** revision・版の番号として正しいか（正の整数で、DB の integer に収まる）。 */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_INTEGER;
}

export type EditorStoreOptions = {
  /** 自動保存で版を残す間隔（ミリ秒）。最新の版からこれ以上経った保存で、保存の前の本文を版にする。 */
  autosaveVersionIntervalMs?: number;
};

type PageRow = {
  id: string;
  kind: PageKind;
  title: string;
  lang: PageLang;
  blocks: Block[];
  cover: string | null;
  lead: string | null;
  parent: string | null;
  recipe: string | null;
  step_status: StepStatus | null;
  sort_order: number;
  revision: number;
  created_at: Date;
  updated_at: Date;
};

type SummaryRow = Pick<PageRow, "id" | "kind" | "title" | "lang" | "parent" | "step_status" | "sort_order" | "created_at" | "updated_at"> & {
  pub_dest: PublishDest | null;
  pub_handle: string | null;
  pub_range: PublishRange | null;
  pub_stopped: boolean | null;
};

/** 一覧の列（pages を p、公開を LEFT JOIN した publications を pub として読む）。 */
const SUMMARY_COLUMNS = `p.id, p.kind, p.title, p.lang, p.parent, p.step_status, p.sort_order, p.created_at, p.updated_at,
       pub.dest AS pub_dest, pub.handle AS pub_handle, pub.range AS pub_range, pub.stopped_at IS NOT NULL AS pub_stopped`;

const SUMMARY_FROM = "pages p LEFT JOIN publications pub ON pub.page_id = p.id";

/** 一覧の区切りの行。cursor_time は updated_at の UTC の文字列（マイクロ秒まで）。 */
type ChunkRow = SummaryRow & { cursor_time: string };

type VersionRow = { version: number; reason: VersionReason; created_at: Date; block_count: number };

const PAGE_COLUMNS = "id, kind, title, lang, blocks, cover, lead, parent, recipe, step_status, sort_order, revision, created_at, updated_at";

function toPage(row: PageRow): Page {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    lang: row.lang,
    blocks: row.blocks,
    cover: row.cover,
    lead: row.lead,
    parent: row.parent,
    recipe: row.recipe,
    stepStatus: row.step_status,
    sortOrder: row.sort_order,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toSummary(row: SummaryRow): PageSummary {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    lang: row.lang,
    parent: row.parent,
    stepStatus: row.step_status,
    sortOrder: row.sort_order,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    publication:
      row.pub_dest === null || row.pub_handle === null || row.pub_range === null
        ? null
        : { dest: row.pub_dest, handle: row.pub_handle, range: row.pub_range, stopped: row.pub_stopped === true },
  };
}

function parseCursor(cursor: string): { time: string; id: string } {
  const match = CURSOR_PATTERN.exec(cursor);
  if (!match) throw new InvalidPageCursorError();
  return { time: match[1]!, id: match[2]! };
}

function isInvalidDatetime(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === "22007" || code === "22008";
}

function toVersionSummary(row: VersionRow): PageVersionSummary {
  return { version: row.version, reason: row.reason, createdAt: row.created_at.toISOString(), blockCount: row.block_count };
}

function assertOwner(owner: OwnerId): void {
  // 認証の層の誤りで空の owner が来たときに、誰のものでもない行を読み書きしないための守り
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) {
    throw new TypeError("editor-store: owner must be a non-empty stable user id");
  }
}

function assertBaseRevision(value: unknown): void {
  // 楽観ロックの番号を持たない保存は、黙って上書きになるので受けない（入口の検査の漏れを store でも止める）
  if (!isPositiveInteger(value)) throw new TypeError("editor-store: baseRevision must be a positive integer");
}

function isInvalidTextRepresentation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "22P02";
}

/** 版を残す規則。ai・publish は同じ本文でも必ず残し、それ以外は空の本文と直前の版と同じ本文を残さない。 */
function rulesFor(reason: VersionReason): { skipEmpty: boolean; skipSame: boolean } {
  const always = reason === "ai" || reason === "publish";
  return { skipEmpty: !always, skipSame: !always };
}

type SnapshotRules = {
  skipEmpty: boolean;
  skipSame: boolean;
  /** 保存しようとしている本文（JSON）。今の本文と JSON として等しければ残さない。 */
  unlessSameAs?: string;
  /** 最新の版からこの時間が経っていなければ残さない。 */
  minIntervalMs?: number;
};

/**
 * ページの読み書き。全てのクエリを `owner = $n AND deleted_at IS NULL` で絞る（ゴミ箱の読み書きだけ `deleted_at IS NOT NULL`）。
 * 該当が無いとき（別の人のページ・削除済み・存在しない・UUID として不正な id）はどれも null を返す。
 * 呼び出し側はそれを同じ 404 にする（列挙を防ぐ）。
 *
 * 保存・版・ゴミ箱の更新は 1 つの transaction の中で、ページの行を `FOR UPDATE` で押さえてから行う
 * （revision の比較と版の番号の採番が、同時の保存で食い違わない）。
 */
export class EditorStore {
  readonly #db: Database;
  readonly #autosaveVersionIntervalMs: number;

  constructor(db: Database, options: EditorStoreOptions = {}) {
    this.#db = db;
    const interval = options.autosaveVersionIntervalMs ?? DEFAULT_AUTOSAVE_VERSION_INTERVAL_MS;
    if (!Number.isFinite(interval) || interval < 0) throw new RangeError("editor-store: autosaveVersionIntervalMs must be >= 0");
    this.#autosaveVersionIntervalMs = interval;
  }

  async createPage(owner: OwnerId, input: CreatePageInput = {}): Promise<Page> {
    assertOwner(owner);
    const result = await this.#db.query<PageRow>(
      `INSERT INTO pages (owner, kind, title, lang, blocks)
       VALUES ($1, COALESCE($2, 'note'), COALESCE($3, ''), COALESCE($4, 'ja'), COALESCE($5::jsonb, '[]'::jsonb))
       RETURNING ${PAGE_COLUMNS}`,
      [owner, input.kind ?? null, input.title ?? null, input.lang ?? null, input.blocks === undefined ? null : JSON.stringify(input.blocks)],
    );
    const row = result.rows[0];
    if (!row) throw new Error("editor-store: insert returned no row");
    return toPage(row);
  }

  async listPages(owner: OwnerId, options: { limit?: number } = {}): Promise<PageSummary[]> {
    assertOwner(owner);
    const limit = Math.max(1, Math.min(options.limit ?? PAGE_LIST_LIMIT, PAGE_LIST_LIMIT));
    const result = await this.#db.query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS}
         FROM ${SUMMARY_FROM}
        WHERE p.owner = $1 AND p.deleted_at IS NULL
        ORDER BY p.updated_at DESC, p.id
        LIMIT $2`,
      [owner, limit],
    );
    return result.rows.map(toSummary);
  }

  /**
   * 一覧を limit 件ずつ（更新順。同じ時刻は id の降順）。cursor は前の区切りの next。
   * 読めない cursor は InvalidPageCursorError。
   */
  async listPageChunk(owner: OwnerId, options: PageChunkOptions = {}): Promise<PageChunk> {
    assertOwner(owner);
    const requested = options.limit !== undefined && Number.isFinite(options.limit) ? Math.trunc(options.limit) : PAGE_CHUNK_DEFAULT;
    const limit = Math.max(1, Math.min(requested, PAGE_LIST_LIMIT));
    const after = options.cursor === undefined || options.cursor === null ? null : parseCursor(options.cursor);
    // 1 件多く読んで、続きがあるかを知る
    const params: unknown[] = [owner, limit + 1];
    if (after) params.push(after.time, after.id);
    let rows: ChunkRow[];
    try {
      const result = await this.#db.query<ChunkRow>(
        `SELECT ${SUMMARY_COLUMNS},
                to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
           FROM ${SUMMARY_FROM}
          WHERE p.owner = $1 AND p.deleted_at IS NULL${after ? " AND (p.updated_at, p.id) < ($3::timestamptz, $4::uuid)" : ""}
          ORDER BY p.updated_at DESC, p.id DESC
          LIMIT $2`,
        params,
      );
      rows = result.rows;
    } catch (error) {
      // 形は合っていても日付として無い値（2 月 30 日など）
      if (after && isInvalidDatetime(error)) throw new InvalidPageCursorError();
      throw error;
    }
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      pages: page.map(toSummary),
      next: rows.length > limit && last ? `${last.cursor_time}_${last.id}` : null,
    };
  }

  async getPage(owner: OwnerId, id: string): Promise<Page | null> {
    assertOwner(owner);
    if (!isPageId(id)) return null;
    return this.#orNull(async () => {
      const result = await this.#db.query<PageRow>(
        `SELECT ${PAGE_COLUMNS}
           FROM pages
          WHERE owner = $1 AND deleted_at IS NULL AND id = $2`,
        [owner, id],
      );
      const row = result.rows[0];
      return row ? toPage(row) : null;
    });
  }

  /**
   * 指定したものだけを変え、revision を +1 して updated_at を進める。
   * `baseRevision` が今の revision と違えば何も書かずに `conflict` と今のページを返す。
   * 本文が実際に変わる保存では、最新の版から間隔が空いていれば保存の前の本文を版（autosave）に残す。
   * `overwrite` のときは、間隔によらず保存の前の本文を版（overwrite）に残す。
   */
  async savePage(owner: OwnerId, id: string, patch: PagePatch, options: SaveOptions): Promise<SaveResult | null> {
    assertOwner(owner);
    assertBaseRevision(options.baseRevision);
    if (!isPageId(id)) return null;
    const blocksJson = patch.blocks === undefined ? null : JSON.stringify(patch.blocks);
    return this.#orNull(() =>
      this.#transaction(async (client): Promise<SaveResult | null> => {
        const current = await lockPage(client, owner, id);
        if (!current) return null;
        if (current.revision !== options.baseRevision) return { status: "conflict", page: toPage(current) };
        if (options.overwrite === true) {
          await this.#snapshot(client, owner, id, "overwrite", rulesFor("overwrite"));
        } else if (blocksJson !== null) {
          await this.#snapshot(client, owner, id, "autosave", {
            ...rulesFor("autosave"),
            unlessSameAs: blocksJson,
            minIntervalMs: this.#autosaveVersionIntervalMs,
          });
        }
        const result = await client.query<PageRow>(
          `UPDATE pages
              SET kind = COALESCE($3, kind),
                  title = COALESCE($4, title),
                  lang = COALESCE($5, lang),
                  blocks = COALESCE($6::jsonb, blocks),
                  revision = revision + 1,
                  updated_at = GREATEST(clock_timestamp(), updated_at)
            WHERE owner = $1 AND deleted_at IS NULL AND id = $2
            RETURNING ${PAGE_COLUMNS}`,
          [owner, id, patch.kind ?? null, patch.title ?? null, patch.lang ?? null, blocksJson],
        );
        const row = result.rows[0];
        if (!row) throw new Error("editor-store: locked page vanished during save");
        return { status: "saved", page: toPage(row) };
      }),
    );
  }

  /**
   * ページをフォルダへ入れる・出す（`parent` を変える。フォルダは子を持てるふつうのページ。設計の規則は
   * docs/architecture/editor-recipes-and-folders.md §3）。
   *
   * - `parent` に `null` を渡すと上の段へ出す。
   * - 親も本人のページだけ（別の人のページ・ゴミ箱の中・無い id はどれも null＝同じ 404）。
   * - 段が深くなりすぎる移動は `too_deep`、自分自身・自分の子孫の下へ入れる移動は `cycle`（どちらも何も書かない）。
   * - 変えるのは `parent` だけ。本文・`revision`・`updated_at` は動かさない（移動は編集ではないので、開いている
   *   エディタの楽観ロックも一覧の並びも壊さない）。
   */
  async movePage(owner: OwnerId, id: string, parent: string | null): Promise<MovePageResult | null> {
    assertOwner(owner);
    if (!isPageId(id)) return null;
    if (parent !== null && !isPageId(parent)) return null;
    if (parent === id) return "cycle";
    return this.#orNull(() =>
      this.#transaction(async (client): Promise<MovePageResult | null> => {
        const current = await lockPage(client, owner, id);
        if (!current) return null;
        if (current.parent === parent) return "moved";
        // 入れ先の段（上へ辿る）。上の段へ出すなら -1（入れたページが 0 の段になる）
        let parentDepth = -1;
        if (parent !== null) {
          const up = await client.query<{ depth: number | null }>(
            `WITH RECURSIVE up AS (
               SELECT id, parent, 0 AS depth FROM pages WHERE owner = $1 AND deleted_at IS NULL AND id = $2
               UNION ALL
               SELECT p.id, p.parent, up.depth + 1
                 FROM pages p JOIN up ON p.id = up.parent
                WHERE p.owner = $1 AND p.deleted_at IS NULL
             )
             SELECT max(depth) AS depth FROM up`,
            [owner, parent],
          );
          const depth = up.rows[0]?.depth;
          // 入れ先が無い・別の人のもの・ゴミ箱の中なら、ページが無いときと同じ
          if (depth === null || depth === undefined) return null;
          parentDepth = Number(depth);
        }
        // 動かすページの下の高さと、入れ先がその中にあるか（下へ辿る）。ゴミ箱の中の子も数える:
        // 戻す（restoreFromTrash）と親を保ったまま木に帰るので、数えないと動かしたあとに戻して上限を超える
        const down = await client.query<{ height: number | null; inside: boolean | null }>(
          `WITH RECURSIVE down AS (
             SELECT id, 0 AS height FROM pages WHERE owner = $1 AND deleted_at IS NULL AND id = $2
             UNION ALL
             SELECT c.id, down.height + 1
               FROM pages c JOIN down ON c.parent = down.id
              WHERE c.owner = $1
           )
           SELECT max(height) AS height, bool_or(id = $3::uuid) AS inside FROM down`,
          [owner, id, parent],
        );
        if (down.rows[0]?.inside === true) return "cycle";
        const height = Number(down.rows[0]?.height ?? 0);
        if (parentDepth + 1 + height > MAX_PAGE_DEPTH) return "too_deep";
        const moved = await client.query(
          "UPDATE pages SET parent = $3 WHERE owner = $1 AND deleted_at IS NULL AND id = $2",
          [owner, id, parent],
        );
        if (moved.rowCount !== 1) throw new Error("editor-store: locked page vanished during move");
        return "moved";
      }),
    );
  }

  /**
   * 同じ親の中の手動の並びを 1 つ動かす（上へ・下へ。docs/architecture/editor-recipes-and-folders.md §3）。
   *
   * - 並びは `sort_order` が小さいほど上。同じ値なら更新の新しい順（0 は「並べ替えていない」で、今までの一覧と同じ）。
   * - 動かすと、同じ親の全ての行に 1 から振り直す（0 のままの行が混ざって並びが決まらなくなるのを防ぐ）。
   * - もう端にいるときは `edge`（何も書かない）。ページが無いときは null（同じ 404）。
   * - 変えるのは `sort_order` だけ（`revision`・`updated_at`・本文は動かさない）。
   */
  async movePageOrder(owner: OwnerId, id: string, move: OrderMove): Promise<MoveOrderResult | null> {
    assertOwner(owner);
    if (!isPageId(id)) return null;
    return this.#orNull(() =>
      this.#transaction(async (client): Promise<MoveOrderResult | null> => {
        const current = await lockPage(client, owner, id);
        if (!current) return null;
        // 同じ親の行を今の並びで（親が無い行どうしも「同じ親」）
        const siblings = await client.query<{ id: string }>(
          `SELECT id
             FROM pages
            WHERE owner = $1 AND deleted_at IS NULL AND parent IS NOT DISTINCT FROM $2::uuid
            ORDER BY ${orderOf(current.parent)}`,
          [owner, current.parent],
        );
        const ids = siblings.rows.map((row) => row.id);
        const at = ids.indexOf(id);
        const to = move === "up" ? at - 1 : at + 1;
        if (at < 0 || to < 0 || to >= ids.length) return "edge";
        [ids[at], ids[to]] = [ids[to]!, ids[at]!];
        // 1 から振り直す（0 は「並べ替えていない」に残しておく）
        await client.query(
          `UPDATE pages AS p
              SET sort_order = next.ord
             FROM unnest($2::uuid[], $3::int[]) AS next(id, ord)
            WHERE p.owner = $1 AND p.id = next.id`,
          [owner, ids, ids.map((_, index) => index + 1)],
        );
        return "moved";
      }),
    );
  }

  /**
   * そのページの中の行（同じ親の並びの順）。フォルダの子を列挙する口（自動参考ページ・書き出し・画面が使う）。
   * `parent` に null を渡すと上の段。ページが無い・別の人のものなら空（親が本人のものかは呼ぶ側が先に確かめる）。
   */
  async listPageChildren(owner: OwnerId, parent: string | null, options: { limit?: number } = {}): Promise<PageSummary[]> {
    assertOwner(owner);
    if (parent !== null && !isPageId(parent)) return [];
    const limit = Math.max(1, Math.min(options.limit ?? PAGE_LIST_LIMIT, PAGE_LIST_LIMIT));
    const result = await this.#db.query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS}
         FROM ${SUMMARY_FROM}
        WHERE p.owner = $1 AND p.deleted_at IS NULL AND p.parent IS NOT DISTINCT FROM $2::uuid
        ORDER BY ${orderOf(parent, "p.")}
        LIMIT $3`,
      [owner, parent, limit],
    );
    return result.rows.map(toSummary);
  }

  /**
   * そのページとその下のページ（本文つき。書き出しが使う）。並びは、親のすぐ後ろにその中の行（並びの順）。
   * 段は `MAX_PAGE_DEPTH` まで（それより深い行は読まない）。ページが無い・別の人のものなら空。
   */
  async listPageTree(owner: OwnerId, rootId: string, options: { limit?: number } = {}): Promise<Page[]> {
    assertOwner(owner);
    if (!isPageId(rootId)) return [];
    const limit = Math.max(1, Math.min(options.limit ?? PAGE_LIST_LIMIT, PAGE_LIST_LIMIT));
    const result = await this.#db.query<PageRow & { depth: number }>(
      `WITH RECURSIVE tree AS (
         SELECT ${PAGE_COLUMNS}, 0 AS depth, ARRAY[]::text[] AS path
           FROM pages
          WHERE owner = $1 AND deleted_at IS NULL AND id = $2
         UNION ALL
         SELECT ${PAGE_COLUMNS.split(", ").map((column) => `c.${column}`).join(", ")}, t.depth + 1,
                -- 中の行は「手動の並び → 作った順 → id」（orderOf の親ありと同じ規則）を 1 つの文字列に畳んで並べる
                t.path || to_char(c.sort_order, 'FM0000000000') || to_char(c.created_at, 'YYYYMMDDHH24MISSUS') || c.id::text
           FROM pages c JOIN tree t ON c.parent = t.id
          WHERE c.owner = $1 AND c.deleted_at IS NULL AND t.depth < $3
       )
       SELECT ${PAGE_COLUMNS}, depth FROM tree ORDER BY path LIMIT $4`,
      [owner, rootId, MAX_PAGE_DEPTH, limit],
    );
    return result.rows.map(toPage);
  }

  /**
   * 今の本文を 1 つ版に残す（AI の変更・公開の前など）。ai・publish は同じ本文でも必ず残す。
   * autosave・overwrite・restore は、空の本文と直前の版と同じ本文を残さない（そのときも null）。
   * ページが無いときは null。
   */
  async createVersion(owner: OwnerId, id: string, reason: VersionReason): Promise<PageVersionSummary | null> {
    assertOwner(owner);
    if (!(VERSION_REASONS as readonly string[]).includes(reason)) throw new TypeError("editor-store: unknown version reason");
    if (!isPageId(id)) return null;
    return this.#orNull(() =>
      this.#transaction(async (client) => {
        const current = await lockPage(client, owner, id);
        if (!current) return null;
        return this.#snapshot(client, owner, id, reason, rulesFor(reason));
      }),
    );
  }

  /** 版の一覧（新しい順・本文は含めない）。ページが無いときは null、版が無いときは []。 */
  async listVersions(owner: OwnerId, id: string): Promise<PageVersionSummary[] | null> {
    assertOwner(owner);
    if (!isPageId(id)) return null;
    return this.#orNull(async () => {
      const result = await this.#db.query<{ version: number | null; reason: VersionReason | null; created_at: Date | null; block_count: number | null }>(
        `SELECT v.version, v.reason, v.created_at, v.block_count
           FROM pages p
           LEFT JOIN LATERAL (
             SELECT version, reason, created_at, jsonb_array_length(blocks) AS block_count
               FROM page_versions
              WHERE page_id = p.id
              ORDER BY version DESC
              LIMIT $3
           ) v ON true
          WHERE p.owner = $1 AND p.deleted_at IS NULL AND p.id = $2
          ORDER BY v.version DESC NULLS LAST`,
        [owner, id, VERSION_LIST_LIMIT],
      );
      if (result.rows.length === 0) return null;
      return result.rows.flatMap((row) =>
        row.version === null || row.reason === null || row.created_at === null || row.block_count === null
          ? []
          : [toVersionSummary({ version: row.version, reason: row.reason, created_at: row.created_at, block_count: row.block_count })],
      );
    });
  }

  /** 版 1 つ（本文を含む）。ページか版が無いとき・番号が正の整数でないときは null。 */
  async getVersion(owner: OwnerId, id: string, version: number): Promise<PageVersion | null> {
    assertOwner(owner);
    if (!isPageId(id) || !isPositiveInteger(version)) return null;
    return this.#orNull(async () => {
      const result = await this.#db.query<{ version: number; reason: VersionReason; created_at: Date; blocks: Block[] }>(
        `SELECT v.version, v.reason, v.created_at, v.blocks
           FROM pages p
           JOIN page_versions v ON v.page_id = p.id
          WHERE p.owner = $1 AND p.deleted_at IS NULL AND p.id = $2 AND v.version = $3`,
        [owner, id, version],
      );
      const row = result.rows[0];
      return row ? { version: row.version, reason: row.reason, createdAt: row.created_at.toISOString(), blocks: row.blocks } : null;
    });
  }

  /**
   * 「この版に戻す」。今の本文を版（restore）に残してから、その版の本文を blocks に書き、revision を +1 する。
   * ページか版が無いときは null。`baseRevision` が違えば何も書かずに conflict。
   * 版の本文が `accept` を通らなければ（今の形では保存できない古い版）何も書かずに unrestorable。
   */
  async restoreVersion(owner: OwnerId, id: string, version: number, options: RestoreOptions): Promise<RestoreResult | null> {
    assertOwner(owner);
    assertBaseRevision(options.baseRevision);
    if (!isPageId(id) || !isPositiveInteger(version)) return null;
    return this.#orNull(() =>
      this.#transaction(async (client): Promise<RestoreResult | null> => {
        const current = await lockPage(client, owner, id);
        if (!current) return null;
        const target = await client.query<{ blocks: unknown }>(
          "SELECT blocks FROM page_versions WHERE page_id = $1 AND version = $2",
          [id, version],
        );
        const stored = target.rows[0];
        if (!stored) return null;
        if (current.revision !== options.baseRevision) return { status: "conflict", page: toPage(current) };
        const accepted = options.accept(stored.blocks);
        if (accepted === null) return { status: "unrestorable" };
        await this.#snapshot(client, owner, id, "restore", rulesFor("restore"));
        const result = await client.query<PageRow>(
          `UPDATE pages
              SET blocks = $3::jsonb,
                  revision = revision + 1,
                  updated_at = GREATEST(clock_timestamp(), updated_at)
            WHERE owner = $1 AND deleted_at IS NULL AND id = $2
            RETURNING ${PAGE_COLUMNS}`,
          [owner, id, JSON.stringify(accepted)],
        );
        const row = result.rows[0];
        if (!row) throw new Error("editor-store: locked page vanished during restore");
        return { status: "restored", page: toPage(row) };
      }),
    );
  }

  /**
   * ページをゴミ箱へ入れる（論理削除）。子孫のページ（parent をたどる）も同じ deleted_at で一緒に入れる。
   * 自分か子孫のどれかが公開中なら何も書かずに `published`（先に公開をやめる。設計 §12）。ページが無いときは null。
   */
  async deletePage(owner: OwnerId, id: string): Promise<DeleteResult | null> {
    assertOwner(owner);
    if (!isPageId(id)) return null;
    return this.#orNull(() =>
      this.#transaction(async (client): Promise<DeleteResult | null> => {
        // 自分と子孫の行を id の順に 1 文で押さえる（親と子の同時の削除・purge と lock の順が食い違って deadlock しない）
        const tree = await client.query<{ id: string }>(
          `WITH RECURSIVE tree AS (
             SELECT id FROM pages WHERE owner = $1 AND deleted_at IS NULL AND id = $2
             UNION
             SELECT c.id FROM pages c JOIN tree t ON c.parent = t.id
              WHERE c.owner = $1 AND c.deleted_at IS NULL
           )
           SELECT p.id FROM pages p JOIN tree t ON t.id = p.id
            WHERE p.owner = $1 AND p.deleted_at IS NULL
            ORDER BY p.id
            FOR UPDATE OF p`,
          [owner, id],
        );
        const ids = tree.rows.map((row) => row.id);
        if (!ids.includes(id)) return null;
        // 公開の transaction もページの行を押さえてから公開を書く（publications.ts の getDraftPage）ので、同時の公開とすれ違わない
        const published = await client.query(
          "SELECT 1 FROM publications WHERE page_id = ANY($1::uuid[]) AND stopped_at IS NULL LIMIT 1",
          [ids],
        );
        if (published.rows.length > 0) return "published";
        // 同じ時刻を全ての行に入れる（clock_timestamp() を行ごとに呼ぶと、一緒に入れた子を見分けられない）。
        // MATERIALIZED の CTE は 1 度だけ評価される
        await client.query(
          `WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS now)
           UPDATE pages
              SET deleted_at = (SELECT now FROM stamp)
            WHERE owner = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`,
          [owner, ids],
        );
        return "deleted";
      }),
    );
  }

  /** 自分のゴミ箱（削除の新しい順・本文は含めない）。 */
  async listTrash(owner: OwnerId, options: { limit?: number } = {}): Promise<TrashedPage[]> {
    assertOwner(owner);
    const limit = Math.max(1, Math.min(options.limit ?? TRASH_LIST_LIMIT, TRASH_LIST_LIMIT));
    const result = await this.#db.query<{ id: string; kind: PageKind; title: string; deleted_at: Date }>(
      `SELECT id, kind, title, deleted_at
         FROM pages
        WHERE owner = $1 AND deleted_at IS NOT NULL
        ORDER BY deleted_at DESC, id
        LIMIT $2`,
      [owner, limit],
    );
    return result.rows.map((row) => ({ id: row.id, kind: row.kind, title: row.title, deletedAt: row.deleted_at.toISOString() }));
  }

  /**
   * ゴミ箱の自分のページを戻す。一緒にゴミ箱へ入った子孫（同じ deleted_at）も戻す。
   * ゴミ箱に無い・別の人の・存在しない・不正な id はどれも false。
   */
  async restoreFromTrash(owner: OwnerId, id: string): Promise<boolean> {
    assertOwner(owner);
    if (!isPageId(id)) return false;
    const restored = await this.#orNull(() =>
      this.#transaction(async (client) => {
        // 自分と、一緒にゴミ箱へ入った子孫（同じ deleted_at）の行を id の順に 1 文で押さえる（purge と同じ順。deadlock しない）。
        // deleted_at は µs まで持つので、JS の Date（ms）に戻さず SQL の中で比べる
        const tree = await client.query<{ id: string }>(
          `WITH RECURSIVE root AS (
             SELECT id, deleted_at FROM pages WHERE owner = $1 AND deleted_at IS NOT NULL AND id = $2
           ), tree AS (
             SELECT id FROM root
             UNION
             SELECT c.id FROM pages c JOIN tree t ON c.parent = t.id
              WHERE c.owner = $1 AND c.deleted_at = (SELECT deleted_at FROM root)
           )
           SELECT p.id FROM pages p JOIN tree t ON t.id = p.id
            WHERE p.owner = $1 AND p.deleted_at IS NOT NULL
            ORDER BY p.id
            FOR UPDATE OF p`,
          [owner, id],
        );
        const ids = tree.rows.map((row) => row.id);
        if (!ids.includes(id)) return null;
        await client.query(
          `UPDATE pages
              SET deleted_at = NULL
            WHERE owner = $1 AND id = ANY($3::uuid[])
              AND deleted_at = (SELECT deleted_at FROM pages WHERE owner = $1 AND id = $2)`,
          [owner, id, ids],
        );
        return true;
      }),
    );
    return restored === true;
  }

  /**
   * ゴミ箱に `olderThanDays` 日より長くあるページを、全ての owner について完全に消す（版・資産の行は FK の CASCADE で消える）。
   * - 親子は子から先に消す（`pages (owner, parent)` の FK は RESTRICT。1 文の DELETE の中の順序に頼らない）。
   * - 消すページを親にしている残るページ（先に戻された子など）は、親を外して残す。
   * - 公開の行（publications。公開をやめたものも含む）があるページ・残るページのカバーに資産が使われているページは消さない（ゴミ箱に残す）。
   * - 資産の実体（bucket の object）は消さない。消した行の bucket_path を返す。
   */
  async purgeTrash(options: { olderThanDays?: number } = {}): Promise<PurgeResult> {
    const days = options.olderThanDays ?? TRASH_RETENTION_DAYS;
    if (!Number.isSafeInteger(days) || days < 1) throw new RangeError("editor-store: olderThanDays must be a positive integer");
    return this.#transaction(async (client) => {
      const due = await client.query<{ id: string }>(
        `SELECT id
           FROM pages
          WHERE deleted_at IS NOT NULL
            AND deleted_at < clock_timestamp() - make_interval(days => $1::int)
            AND NOT EXISTS (SELECT 1 FROM publications pub WHERE pub.page_id = pages.id)
          ORDER BY id
          FOR UPDATE`,
        [days],
      );
      let ids = due.rows.map((row) => row.id);
      // 残るページのカバーが使っている資産を持つページは消さない（外すと残るページが変わる）。外した分で残るページが増えるので、変わらなくなるまで繰り返す
      for (;;) {
        if (ids.length === 0) return { pages: 0, assetPaths: [] };
        const blocked = await client.query<{ id: string }>(
          `SELECT DISTINCT a.page_id AS id
             FROM assets a
             JOIN pages p ON p.owner = a.owner AND p.cover = a.id
            WHERE a.page_id = ANY($1::uuid[]) AND NOT (p.id = ANY($1::uuid[]))`,
          [ids],
        );
        if (blocked.rows.length === 0) break;
        const keep = new Set(blocked.rows.map((row) => row.id));
        ids = ids.filter((id) => !keep.has(id));
      }
      // 残る子は親を外す（消える親を指したままでは FK が親の削除を止める）
      await client.query("UPDATE pages SET parent = NULL WHERE parent = ANY($1::uuid[]) AND NOT (id = ANY($1::uuid[]))", [ids]);
      const assets = await client.query<{ bucket_path: string }>(
        "SELECT bucket_path FROM assets WHERE page_id = ANY($1::uuid[]) ORDER BY bucket_path COLLATE \"C\"",
        [ids],
      );
      // 消えるページ同士のカバーの参照（RESTRICT）が、資産の CASCADE の順序で削除を止めないように先に外す
      await client.query("UPDATE pages SET cover = NULL WHERE id = ANY($1::uuid[]) AND cover IS NOT NULL", [ids]);
      // 子を持たないページから消す（1 回の DELETE には親子の組を入れない）
      const remaining = new Set(ids);
      while (remaining.size > 0) {
        const deleted = await client.query<{ id: string }>(
          `DELETE FROM pages p
            WHERE p.id = ANY($1::uuid[])
              AND NOT EXISTS (SELECT 1 FROM pages c WHERE c.owner = p.owner AND c.parent = p.id)
            RETURNING p.id`,
          [[...remaining]],
        );
        if (deleted.rows.length === 0) {
          // 親子が輪になっている（API では作れない）: 残りの親を外してから消す
          await client.query("UPDATE pages SET parent = NULL WHERE id = ANY($1::uuid[])", [[...remaining]]);
          continue;
        }
        for (const row of deleted.rows) remaining.delete(row.id);
      }
      return { pages: ids.length, assetPaths: assets.rows.map((row) => row.bucket_path) };
    });
  }

  /**
   * 今の本文を版に残す（ページの行を押さえた transaction の中で呼ぶ）。番号はページごとの連番（最新 +1）。
   * 残したら上限を超えた古い autosave の版を捨てる。残さなかったときは null。
   */
  async #snapshot(client: Queryable, owner: OwnerId, id: string, reason: VersionReason, rules: SnapshotRules): Promise<PageVersionSummary | null> {
    const inserted = await client.query<VersionRow>(
      `WITH latest AS (
         SELECT version, blocks, created_at FROM page_versions WHERE page_id = $2 ORDER BY version DESC LIMIT 1
       )
       INSERT INTO page_versions (page_id, version, blocks, reason)
       SELECT p.id, COALESCE((SELECT version FROM latest), 0) + 1, p.blocks, $3
         FROM pages p
        WHERE p.owner = $1 AND p.deleted_at IS NULL AND p.id = $2
          AND ($4::jsonb IS NULL OR p.blocks IS DISTINCT FROM $4::jsonb)
          AND (NOT $5::boolean OR jsonb_array_length(p.blocks) > 0)
          AND (NOT $6::boolean OR NOT EXISTS (SELECT 1 FROM latest l WHERE l.blocks = p.blocks))
          AND ($7::float8 IS NULL OR NOT EXISTS (
                SELECT 1 FROM latest l WHERE l.created_at > clock_timestamp() - $7::float8 * interval '1 millisecond'))
       RETURNING version, reason, created_at, jsonb_array_length(blocks) AS block_count`,
      [owner, id, reason, rules.unlessSameAs ?? null, rules.skipEmpty, rules.skipSame, rules.minIntervalMs ?? null],
    );
    const row = inserted.rows[0];
    if (!row) return null;
    // 上限を超えた分だけ、古い autosave の版から捨てる（今残した版は捨てない。公開版は publication_versions にあり、ここは指さない）
    await client.query(
      `WITH victims AS (
         SELECT v.version
           FROM page_versions v
          WHERE v.page_id = $1 AND v.reason = 'autosave' AND v.version < $2
          ORDER BY v.version
          LIMIT GREATEST((SELECT count(*) FROM page_versions WHERE page_id = $1) - $3, 0)
       )
       DELETE FROM page_versions d USING victims
        WHERE d.page_id = $1 AND d.version = victims.version`,
      [id, row.version, VERSION_KEEP_LIMIT],
    );
    return toVersionSummary(row);
  }

  async #transaction<T>(work: (client: Queryable) => Promise<T>): Promise<T> {
    const client = await this.#db.connect();
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
        // 戻せない接続は Pool に返さず捨てる
        broken = true;
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }

  async #orNull<T>(work: () => Promise<T | null>): Promise<T | null> {
    try {
      return await work();
    } catch (error) {
      if (isInvalidTextRepresentation(error)) return null;
      throw error;
    }
  }
}

/** 自分の（削除されていない）ページの行を押さえて読む。無ければ null。 */
async function lockPage(client: Queryable, owner: OwnerId, id: string): Promise<PageRow | null> {
  const result = await client.query<PageRow>(
    `SELECT ${PAGE_COLUMNS}
       FROM pages
      WHERE owner = $1 AND deleted_at IS NULL AND id = $2
      FOR UPDATE`,
    [owner, id],
  );
  return result.rows[0] ?? null;
}
