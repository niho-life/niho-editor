import {
  TAB_KINDS,
  VERSION_REASONS,
  type Block,
  type CreatePageInput,
  type CreateTabInput,
  type Database,
  type DeleteResult,
  type MadeFrom,
  type MoveOrderResult,
  type MovePageResult,
  type MoveTabResult,
  type OrderMove,
  type OwnerId,
  type Page,
  type PageChunk,
  type PageChunkOptions,
  type PageKind,
  type PageLang,
  type PagePatch,
  type PageRole,
  type PageSummary,
  type PageVersion,
  type PageVersionSummary,
  type PublishDest,
  type PublishRange,
  type PurgeResult,
  type Queryable,
  type ResolvedPage,
  type RestoreOptions,
  type RestoreResult,
  type SaveOptions,
  type SaveResult,
  type StepStatus,
  type TrashedPage,
  type VersionReason,
} from "./types.ts";
import { PAGE_MAX_BYTES, pageImageCharges, pageSizeBytes } from "./page-size.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 一覧で一度に返す上限。 */
export const PAGE_LIST_LIMIT = 500;
/**
 * 親子の段の上限（docs/architecture/editor-recipes-and-folders.md §3）。0＝フォルダ、1＝その中のページ、
 * 2＝録音のサブページ（手順の成果物。#309 でフォルダ直下の役割ページのタブへ移す）。これより深くすると、一覧も検索も辿り切れなくなる。
 * タブ（#307）は段ではない: 入れ物（`kind='page'`）と同じフォルダに並び、`page` で入れ物を指す。
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
  page: string | null;
  role: PageRole | null;
  made_from: MadeFrom | null;
  last_tab: string | null;
  created_at: Date;
  updated_at: Date;
};

type SummaryRow = Pick<PageRow, "id" | "kind" | "title" | "lang" | "parent" | "step_status" | "sort_order" | "page" | "role" | "created_at" | "updated_at"> & {
  pub_dest: PublishDest | null;
  pub_handle: string | null;
  pub_range: PublishRange | null;
  pub_stopped: boolean | null;
  tabs_count?: number | string | null;
};

/**
 * 一覧の列（pages を p、公開を LEFT JOIN した publications を pub、タブなら入れ物を h として読む）。
 * タブの行の `sort_order` は**入れ物の並び**（一覧の行は入れ物で、タブは入れ物と一緒に動く。#307）。タブ自身の sort_order は入れ物の中の並び。
 */
const SUMMARY_COLUMNS = `p.id, p.kind, p.title, p.lang, p.parent, p.step_status, COALESCE(h.sort_order, p.sort_order) AS sort_order, p.page, p.role, p.created_at, p.updated_at,
       pub.dest AS pub_dest, pub.handle AS pub_handle, pub.range AS pub_range, pub.stopped_at IS NOT NULL AS pub_stopped`;

const SUMMARY_FROM = "pages p LEFT JOIN publications pub ON pub.page_id = p.id LEFT JOIN pages h ON h.owner = p.owner AND h.id = p.page";

/** 入れ物のタブの一覧の列（`sort_order` はタブ自身＝入れ物の中の並び）。 */
const TAB_COLUMNS = SUMMARY_COLUMNS.replace("COALESCE(h.sort_order, p.sort_order) AS sort_order", "p.sort_order");

/**
 * 一覧の並び（`orderOf` と同じ規則を、タブなら入れ物の値で）: 手動の並び → 上の段は更新の新しい順、中は作った順 → 同じ入れ物のタブは
 * 入れ物の中の並び（タブの sort_order → 作った順）→ id。
 */
function summaryOrder(parent: string | null): string {
  const holder = parent === null ? "COALESCE(h.updated_at, p.updated_at) DESC" : "COALESCE(h.created_at, p.created_at)";
  return `COALESCE(h.sort_order, p.sort_order), ${holder}, COALESCE(h.id, p.id), p.sort_order, p.created_at, p.id`;
}

/**
 * 一覧に出す行（#307）。`tabs`（既定）は本文を持つ行＝タブと入れ物の無いページ（入れ物 `kind='page'` は出さない。今までの一覧と同じ）。
 * `pages` は入れ物・フォルダ・入れ物の無いページ（タブ＝`page IS NOT NULL` は出さない）。
 */
function viewFilter(view: "tabs" | "pages" | undefined): string {
  return view === "pages" ? "p.page IS NULL" : "p.kind <> 'page'";
}

/** `view: 'pages'` の一覧で入れ物に添えるタブの数。 */
const TABS_COUNT_COLUMN = "(SELECT count(*) FROM pages t WHERE t.owner = p.owner AND t.page = p.id AND t.deleted_at IS NULL) AS tabs_count";

/** 一覧の区切りの行。cursor_time は updated_at の UTC の文字列（マイクロ秒まで）。 */
type ChunkRow = SummaryRow & { cursor_time: string };

type VersionRow = { version: number; reason: VersionReason; created_at: Date; block_count: number };

const PAGE_COLUMNS = "id, kind, title, lang, blocks, cover, lead, parent, recipe, step_status, sort_order, revision, page, role, made_from, last_tab, created_at, updated_at";

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
    page: row.page,
    role: row.role,
    madeFrom: row.made_from,
    lastTab: row.last_tab,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toSummary(row: SummaryRow): PageSummary {
  const summary: PageSummary = {
    id: row.id,
    kind: row.kind,
    title: row.title,
    lang: row.lang,
    parent: row.parent,
    stepStatus: row.step_status,
    sortOrder: row.sort_order,
    page: row.page,
    role: row.role,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    publication:
      row.pub_dest === null || row.pub_handle === null || row.pub_range === null
        ? null
        : { dest: row.pub_dest, handle: row.pub_handle, range: row.pub_range, stopped: row.pub_stopped === true },
  };
  if (row.tabs_count !== undefined && row.tabs_count !== null) summary.tabsCount = Number(row.tabs_count);
  return summary;
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
  /** 保存しようとしている本文と公開情報。現在と全て同じなら履歴を増やさない。 */
  unlessSameAs?: { blocks: string; cover: string | null; lead: string | null };
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

  /**
   * ページを作る。`parent` を渡すと、そのフォルダの中に作る（docs/architecture/editor-recipes-and-folders.md §3.2）。
   *
   * - `parent` は本人の生きている `kind='folder'` だけ。それ以外（別の人・ゴミ箱・無い id・フォルダでない）は null（同じ 404）。
   * - `kind='folder'` は本文を持たず（`blocks` は空だけ）、`parent` も付けられない（入れ子にしない）。どちらも TypeError。
   * - 本文を持つ種類（note・rec・article）は、入れ物（`kind='page'`。題名・役割・並び）と 1 つ目のタブを 1 つの transaction で作り、
   *   **タブの行**を返す（#307。`page` が入れ物の id。`/p/<id>` も公開も共有もタブの id）。`kind='page'` を直に作ることはできない。
   * - `kind='step'` は入れ物を作らない（手順のサブページ。#309 まで）。
   */
  async createPage(owner: OwnerId, input?: Omit<CreatePageInput, "parent"> & { parent?: null }): Promise<Page>;
  async createPage(owner: OwnerId, input: CreatePageInput): Promise<Page | null>;
  async createPage(owner: OwnerId, input: CreatePageInput = {}): Promise<Page | null> {
    assertOwner(owner);
    if (input.lead !== undefined && input.lead !== null && (typeof input.lead !== "string" || Array.from(input.lead).length > 160 || input.lead.includes("\u0000"))) {
      throw new TypeError("editor-store: lead must be at most 160 characters or null");
    }
    const parent = input.parent ?? null;
    const kind: PageKind = input.kind ?? "note";
    if (kind === "page") throw new TypeError("editor-store: a tab holder is made with its first tab");
    if (kind === "folder") {
      if (parent !== null) throw new TypeError("editor-store: a folder cannot be inside a folder");
      if (input.blocks !== undefined && input.blocks.length > 0) throw new TypeError("editor-store: folder has no body");
    }
    const role = input.role ?? null;
    if (role !== null && !(TAB_KINDS as readonly string[]).includes(kind)) throw new TypeError("editor-store: only a page with a body has a role");
    if (pageSizeBytes(input.title ?? "", input.blocks ?? [], [], null, input.lead ?? null) > PAGE_MAX_BYTES) throw new RangeError("editor-store: page is too large");
    const withHolder = (TAB_KINDS as readonly string[]).includes(kind);
    const insert = async (client: Queryable): Promise<Page> => {
      // 入れ物（題名・言語・親・役割だけ。本文は空のまま）
      let holder: string | null = null;
      if (withHolder) {
        const made = await client.query<{ id: string }>(
          `INSERT INTO pages (owner, kind, title, lang, blocks, parent, role)
           VALUES ($1, 'page', COALESCE($2, ''), COALESCE($3, 'ja'), '[]'::jsonb, $4::uuid, $5::jsonb)
           RETURNING id`,
          [owner, input.title ?? null, input.lang ?? null, parent, role === null ? null : JSON.stringify(role)],
        );
        holder = made.rows[0]?.id ?? null;
        if (!holder) throw new Error("editor-store: insert returned no holder");
      }
      const result = await client.query<PageRow>(
        `INSERT INTO pages (owner, kind, title, lang, blocks, lead, parent, page)
         VALUES ($1, $2, COALESCE($3, ''), COALESCE($4, 'ja'), COALESCE($5::jsonb, '[]'::jsonb), $6, $7::uuid, $8::uuid)
         RETURNING ${PAGE_COLUMNS}`,
        [owner, kind, input.title ?? null, input.lang ?? null, input.blocks === undefined ? null : JSON.stringify(input.blocks), input.lead ?? null, parent, holder],
      );
      const row = result.rows[0];
      if (!row) throw new Error("editor-store: insert returned no row");
      if (holder !== null) await client.query("UPDATE pages SET last_tab = $2 WHERE owner = $1 AND id = $3", [owner, row.id, holder]);
      return toPage(row);
    };
    if (parent === null && !withHolder) return insert(this.#db);
    if (parent !== null && !isPageId(parent)) return null;
    return this.#orNull(() =>
      this.#transaction(async (client): Promise<Page | null> => {
        if (parent !== null) {
          // 入れ先のフォルダを押さえる（作る間にゴミ箱へ入る・別の種類に変わるのを防ぐ）
          const folder = await client.query<{ kind: PageKind }>(
            "SELECT kind FROM pages WHERE owner = $1 AND deleted_at IS NULL AND id = $2 FOR SHARE",
            [owner, parent],
          );
          if (folder.rows[0]?.kind !== "folder") return null;
        }
        return insert(client);
      }),
    );
  }

  /**
   * 入れ物にタブを足す（#307。帯の右端の ＋）。まっさら（本文なし）。入れ物と同じフォルダに並び、`page` で入れ物を指す。
   * `pageId` はタブの id でもよい（その入れ物に足す）。入れ物の無い 1 枚だけのページに足すときは、先に入れ物を作って両方を結ぶ。
   * 本人の生きているページでなければ null（同じ 404）。フォルダには足せない（TypeError）。
   */
  async createTab(owner: OwnerId, pageId: string, input: CreateTabInput = {}): Promise<Page | null> {
    assertOwner(owner);
    if (!isPageId(pageId)) return null;
    return this.#orNull(() =>
      this.#transaction(async (client): Promise<Page | null> => {
        const holder = await this.#lockHolder(client, owner, pageId);
        if (!holder) return null;
        const result = await client.query<PageRow>(
          `INSERT INTO pages (owner, kind, title, lang, blocks, parent, page, sort_order)
           SELECT $1, 'note', COALESCE($3, ''), COALESCE($4, h.lang), '[]'::jsonb, h.parent, h.id,
                  COALESCE((SELECT max(t.sort_order) FROM pages t WHERE t.owner = h.owner AND t.page = h.id AND t.deleted_at IS NULL), 0) + 1
             FROM pages h
            WHERE h.owner = $1 AND h.id = $2
           RETURNING ${PAGE_COLUMNS}`,
          [owner, holder.id, input.title ?? null, input.lang ?? null],
        );
        const row = result.rows[0];
        if (!row) throw new Error("editor-store: insert returned no tab");
        await client.query("UPDATE pages SET last_tab = $3, updated_at = GREATEST(clock_timestamp(), updated_at) WHERE owner = $1 AND id = $2", [owner, holder.id, row.id]);
        return toPage(row);
      }),
    );
  }

  /** 入れ物のタブ（並びの順。本文は含めない）。`pageId` はタブの id でもよい。本人の生きているページでなければ null。 */
  async listTabs(owner: OwnerId, pageId: string): Promise<PageSummary[] | null> {
    assertOwner(owner);
    if (!isPageId(pageId)) return null;
    return this.#orNull(async () => {
      const target = await this.#db.query<{ id: string; kind: PageKind; page: string | null }>(
        "SELECT id, kind, page FROM pages WHERE owner = $1 AND deleted_at IS NULL AND id = $2",
        [owner, pageId],
      );
      const row = target.rows[0];
      if (!row) return null;
      const holder = row.kind === "page" ? row.id : row.page;
      // 入れ物の無い 1 枚だけのページは、それ自身が唯一のタブ
      if (holder === null) {
        if (row.kind === "folder") return [];
        const only = await this.#db.query<SummaryRow>(`SELECT ${SUMMARY_COLUMNS} FROM ${SUMMARY_FROM} WHERE p.owner = $1 AND p.deleted_at IS NULL AND p.id = $2`, [owner, row.id]);
        return only.rows.map(toSummary);
      }
      return this.#tabsOf(this.#db, owner, holder);
    });
  }

  /**
   * ページを開くときの解決（#307）。id がタブならその入れ物と自分、入れ物なら最後に開いたタブ（無ければ 1 つ目）。
   * 入れ物の無い 1 枚だけのページ・フォルダは `page` が null で `tab` がその行。本人の生きているページでなければ null。
   */
  async resolvePage(owner: OwnerId, id: string): Promise<ResolvedPage | null> {
    assertOwner(owner);
    if (!isPageId(id)) return null;
    return this.#orNull(async () => {
      const row = await this.getPage(owner, id);
      if (!row) return null;
      if (row.kind === "page") {
        const tabs = await this.#tabsOf(this.#db, owner, row.id);
        const chosen = (row.lastTab !== null && tabs.find((tab) => tab.id === row.lastTab)) || tabs[0];
        if (!chosen) return null; // タブの無い入れ物（途中の状態）。無いページと同じ
        const tab = await this.getPage(owner, chosen.id);
        if (!tab) return null;
        return { page: row, tab, tabs };
      }
      if (row.page !== null) {
        const holder = await this.getPage(owner, row.page);
        if (holder && holder.kind === "page") return { page: holder, tab: row, tabs: await this.#tabsOf(this.#db, owner, holder.id) };
      }
      const only = await this.listTabs(owner, row.id);
      return { page: null, tab: row, tabs: only ?? [] };
    });
  }

  /** 入れ物の「最後に開いたタブ」を進める（タブを開いたとき）。本人の生きているタブでなければ false。 */
  async touchLastTab(owner: OwnerId, tabId: string): Promise<boolean> {
    assertOwner(owner);
    if (!isPageId(tabId)) return false;
    const result = await this.#db.query(
      `UPDATE pages h
          SET last_tab = t.id
         FROM pages t
        WHERE t.owner = $1 AND t.deleted_at IS NULL AND t.id = $2 AND t.page IS NOT NULL
          AND h.owner = t.owner AND h.id = t.page AND h.deleted_at IS NULL`,
      [owner, tabId],
    );
    return result.rowCount === 1;
  }

  /**
   * 入れ物のタブの並びを決める（`ids` は入れ物の生きているタブ全部を望む順に）。1 から振り直す。
   * 足りない・余計な id・別の入れ物のタブが混ざれば何も書かず false。入れ物が無ければ null。
   */
  async reorderTabs(owner: OwnerId, pageId: string, ids: readonly string[]): Promise<boolean | null> {
    assertOwner(owner);
    if (!isPageId(pageId) || !ids.every((id) => typeof id === "string" && isPageId(id))) return null;
    return this.#orNull(() =>
      this.#transaction(async (client): Promise<boolean | null> => {
        const holder = await this.#lockHolder(client, owner, pageId);
        if (!holder) return null;
        const tabs = await this.#tabsOf(client, owner, holder.id);
        const want = ids.map((id) => id.toLowerCase());
        if (want.length !== tabs.length || new Set(want).size !== want.length || !tabs.every((tab) => want.includes(tab.id))) return false;
        await client.query(
          `UPDATE pages AS p
              SET sort_order = next.ord
             FROM unnest($3::uuid[], $4::int[]) AS next(id, ord)
            WHERE p.owner = $1 AND p.page = $2 AND p.id = next.id`,
          [owner, holder.id, want, want.map((_, index) => index + 1)],
        );
        return true;
      }),
    );
  }

  /**
   * タブを別の入れ物へ移す（タブの ▾「別のページへ移す」）。入れ先と同じフォルダに並べ直す（`parent` も入れ先に合わせる）。
   * 元の入れ物にタブが残らなければ、元の入れ物は消す（空の入れ物は残さない）。
   * 動かすものがタブでない・入れ先が入れ物でない（タブの id なら、その入れ物）ときは `not_page`。タブか入れ先が無ければ null。
   */
  async moveTab(owner: OwnerId, tabId: string, toPageId: string): Promise<MoveTabResult | null> {
    assertOwner(owner);
    if (!isPageId(tabId) || !isPageId(toPageId)) return null;
    return this.#orNull(() =>
      this.#transaction(async (client): Promise<MoveTabResult | null> => {
        const tab = await lockPage(client, owner, tabId);
        if (!tab) return null;
        if (tab.page === null || tab.kind === "page" || tab.kind === "folder") return "not_page";
        const to = await this.#lockHolder(client, owner, toPageId);
        if (!to) return null;
        if (to.id === tab.page) return "moved";
        await client.query(
          `UPDATE pages
              SET page = $3, parent = $4,
                  sort_order = COALESCE((SELECT max(t.sort_order) FROM pages t WHERE t.owner = $1 AND t.page = $3 AND t.deleted_at IS NULL), 0) + 1
            WHERE owner = $1 AND id = $2`,
          [owner, tab.id, to.id, to.parent],
        );
        await client.query("UPDATE pages SET last_tab = $3, updated_at = GREATEST(clock_timestamp(), updated_at) WHERE owner = $1 AND id = $2", [owner, to.id, tab.id]);
        await this.#dropEmptyHolder(client, owner, tab.page);
        return "moved";
      }),
    );
  }

  /** 入れ物のタブ（並びの順。ここでの `sortOrder` はタブ自身＝入れ物の中の並び）。 */
  async #tabsOf(client: Queryable, owner: OwnerId, holder: string): Promise<PageSummary[]> {
    const result = await client.query<SummaryRow>(
      `SELECT ${TAB_COLUMNS}
         FROM ${SUMMARY_FROM}
        WHERE p.owner = $1 AND p.deleted_at IS NULL AND p.page = $2
        ORDER BY p.sort_order, p.created_at, p.id`,
      [owner, holder],
    );
    return result.rows.map(toSummary);
  }

  /**
   * タブを足す・並べる先の入れ物を押さえる。`id` が入れ物ならそれ、タブならその入れ物、入れ物の無い 1 枚だけのページなら
   * その場で入れ物を作って結ぶ（移行前に作られた行や、入れ物が完全に消えた行）。フォルダは TypeError。無ければ null。
   */
  async #lockHolder(client: Queryable, owner: OwnerId, id: string): Promise<PageRow | null> {
    const row = await lockPage(client, owner, id);
    if (!row) return null;
    if (row.kind === "folder") throw new TypeError("editor-store: a folder has no tabs");
    if (row.kind === "page") return row;
    if (row.page !== null) {
      const holder = await lockPage(client, owner, row.page);
      if (holder && holder.kind === "page") return holder;
    }
    if (row.kind === "step") throw new TypeError("editor-store: a step page has no tabs");
    const made = await client.query<PageRow>(
      `INSERT INTO pages (owner, kind, title, lang, blocks, parent, sort_order, last_tab, created_at, updated_at)
       VALUES ($1, 'page', $3, $4, '[]'::jsonb, $5::uuid, $6, $2::uuid, $7, $8)
       RETURNING ${PAGE_COLUMNS}`,
      [owner, row.id, row.title, row.lang, row.parent, row.sort_order, row.created_at, row.updated_at],
    );
    const holder = made.rows[0];
    if (!holder) throw new Error("editor-store: insert returned no holder");
    await client.query("UPDATE pages SET page = $3, sort_order = 0 WHERE owner = $1 AND id = $2", [owner, row.id, holder.id]);
    return holder;
  }

  /** タブが 1 つも残らない入れ物を消す（ゴミ箱に入れない。入れ物は本文を持たない）。 */
  async #dropEmptyHolder(client: Queryable, owner: OwnerId, holder: string): Promise<void> {
    await client.query(
      `DELETE FROM pages h
        WHERE h.owner = $1 AND h.id = $2 AND h.kind = 'page'
          AND NOT EXISTS (SELECT 1 FROM pages t WHERE t.owner = h.owner AND t.page = h.id)`,
      [owner, holder],
    );
  }

  async listPages(owner: OwnerId, options: { limit?: number; view?: PageChunkOptions["view"] } = {}): Promise<PageSummary[]> {
    assertOwner(owner);
    const limit = Math.max(1, Math.min(options.limit ?? PAGE_LIST_LIMIT, PAGE_LIST_LIMIT));
    const result = await this.#db.query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS}${options.view === "pages" ? `, ${TABS_COUNT_COLUMN}` : ""}
         FROM ${SUMMARY_FROM}
        WHERE p.owner = $1 AND p.deleted_at IS NULL AND ${viewFilter(options.view)}
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
        `SELECT ${SUMMARY_COLUMNS}${options.view === "pages" ? `, ${TABS_COUNT_COLUMN}` : ""},
                to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
           FROM ${SUMMARY_FROM}
          WHERE p.owner = $1 AND p.deleted_at IS NULL AND ${viewFilter(options.view)}${after ? " AND (p.updated_at, p.id) < ($3::timestamptz, $4::uuid)" : ""}
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
    const hasCover = Object.prototype.hasOwnProperty.call(patch, "cover");
    const hasLead = Object.prototype.hasOwnProperty.call(patch, "lead");
    if (hasCover && patch.cover !== null && (typeof patch.cover !== "string" || !isPageId(patch.cover))) throw new TypeError("editor-store: cover must be a UUID or null");
    if (hasLead && patch.lead !== null && (typeof patch.lead !== "string" || Array.from(patch.lead).length > 160 || patch.lead.includes("\u0000"))) {
      throw new TypeError("editor-store: lead must be at most 160 characters or null");
    }
    const blocksJson = patch.blocks === undefined ? null : JSON.stringify(patch.blocks);
    return this.#orNull(() =>
      this.#transaction(async (client): Promise<SaveResult | null> => {
        const current = await lockPage(client, owner, id);
        if (!current) return null;
        // フォルダ・タブの入れ物は、ほかの種類と行き来せず、本文を持たない（§3.2。API はこれを bad_request にする）
        if (patch.kind !== undefined && patch.kind !== current.kind && (patch.kind === "folder" || current.kind === "folder")) {
          throw new TypeError("editor-store: kind cannot change to or from folder");
        }
        if (patch.kind !== undefined && patch.kind !== current.kind && (patch.kind === "page" || current.kind === "page")) {
          throw new TypeError("editor-store: kind cannot change to or from folder");
        }
        if ((current.kind === "folder" || current.kind === "page") && patch.blocks !== undefined && patch.blocks.length > 0) throw new TypeError("editor-store: folder has no body");
        if (current.revision !== options.baseRevision) return { status: "conflict", page: toPage(current) };
        const candidateTitle = patch.title ?? current.title;
        const candidateBlocks = patch.blocks ?? current.blocks;
        const candidateCover = hasCover ? patch.cover! : current.cover;
        const candidateLead = hasLead ? patch.lead! : current.lead;
        const metadataChanged = candidateCover !== current.cover || candidateLead !== current.lead;
        if (candidateCover !== null) {
          const cover = await client.query(
            "SELECT 1 FROM assets WHERE owner = $1 AND page_id = $2 AND id = $3 AND kind = 'image' AND upload_status = 'ready'",
            [owner, id, candidateCover],
          );
          if (cover.rows.length === 0) return null;
        }
        const charges = await pageImageCharges(client, owner, id);
        if (pageSizeBytes(candidateTitle, candidateBlocks, charges, candidateCover, candidateLead) > PAGE_MAX_BYTES) {
          return { status: "page_full" };
        }
        if (options.overwrite === true) {
          await this.#snapshot(client, owner, id, "overwrite", { ...rulesFor("overwrite"), skipEmpty: !metadataChanged });
        } else if (blocksJson !== null || hasCover || hasLead) {
          await this.#snapshot(client, owner, id, "autosave", {
            ...rulesFor("autosave"),
            skipEmpty: !metadataChanged,
            unlessSameAs: { blocks: JSON.stringify(candidateBlocks), cover: candidateCover, lead: candidateLead },
            ...(metadataChanged ? {} : { minIntervalMs: this.#autosaveVersionIntervalMs }),
          });
        }
        const result = await client.query<PageRow>(
          `UPDATE pages
              SET kind = COALESCE($3, kind),
                  title = COALESCE($4, title),
                  lang = COALESCE($5, lang),
                  blocks = COALESCE($6::jsonb, blocks),
                  cover = CASE WHEN $7::boolean THEN $8::uuid ELSE cover END,
                  lead = CASE WHEN $9::boolean THEN $10::text ELSE lead END,
                  revision = revision + 1,
                  updated_at = GREATEST(clock_timestamp(), updated_at)
            WHERE owner = $1 AND deleted_at IS NULL AND id = $2
            RETURNING ${PAGE_COLUMNS}`,
          [owner, id, patch.kind ?? null, patch.title ?? null, patch.lang ?? null, blocksJson, hasCover, patch.cover ?? null, hasLead, patch.lead ?? null],
        );
        const row = result.rows[0];
        if (!row) throw new Error("editor-store: locked page vanished during save");
        // タブの保存は入れ物の更新時刻も進める（一覧は入れ物の順で出す。#307）。入れ物が 1 つのタブだけなら題名も揃える
        if (row.page !== null) {
          await client.query(
            `UPDATE pages h
                SET updated_at = GREATEST(clock_timestamp(), h.updated_at),
                    title = CASE WHEN $4::boolean AND NOT EXISTS (SELECT 1 FROM pages t WHERE t.owner = h.owner AND t.page = h.id AND t.deleted_at IS NULL AND t.id <> $2)
                                 THEN $3::text ELSE h.title END
              WHERE h.owner = $1 AND h.id = $5 AND h.deleted_at IS NULL`,
            [owner, row.id, row.title, patch.title !== undefined, row.page],
          );
        }
        return { status: "saved", page: toPage(row) };
      }),
    );
  }

  /**
   * ページをフォルダへ入れる・出す（`parent` を変える唯一の所。フォルダは `kind='folder'` の入れ物。設計の規則は
   * docs/architecture/editor-recipes-and-folders.md §3.2）。
   *
   * - `parent` に `null` を渡すと上の段へ出す。
   * - 親も本人のページだけ（別の人のページ・ゴミ箱の中・無い id はどれも null＝同じ 404）。
   * - 段が深くなりすぎる移動は `too_deep`、自分自身・自分の子孫の下へ入れる移動は `cycle`、入れ先がフォルダでない・
   *   フォルダをフォルダへ入れる移動は `not_folder`（どれも何も書かない）。
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
        let current = await lockPage(client, owner, id);
        if (!current) return null;
        // タブを動かす要求は、その入れ物ごと動かす（タブは入れ物と同じフォルダに並ぶ。#307）
        if (current.page !== null) {
          const holder = await lockPage(client, owner, current.page);
          if (holder && holder.kind === "page") current = holder;
        }
        if (current.parent === parent) return "moved";
        // 入れ先の段（上へ辿る）。上の段へ出すなら -1（入れたページが 0 の段になる）
        let parentDepth = -1;
        let parentKind: PageKind | null = null;
        if (parent !== null) {
          const target = await client.query<{ kind: PageKind }>(
            "SELECT kind FROM pages WHERE owner = $1 AND deleted_at IS NULL AND id = $2 FOR SHARE",
            [owner, parent],
          );
          // 入れ先が無い・別の人のもの・ゴミ箱の中なら、ページが無いときと同じ
          if (!target.rows[0]) return null;
          parentKind = target.rows[0].kind;
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
        // 入れ物を動かすなら、そのタブ（と、タブの下の手順のサブページ）も同じ高さの木として数える
        const down = await client.query<{ height: number | null; inside: boolean | null }>(
          `WITH RECURSIVE down AS (
             SELECT id, 0 AS height FROM pages WHERE owner = $1 AND ((deleted_at IS NULL AND id = $2) OR page = $2)
             UNION ALL
             SELECT c.id, down.height + 1
               FROM pages c JOIN down ON c.parent = down.id
              WHERE c.owner = $1
           )
           SELECT max(height) AS height, bool_or(id = $3::uuid) AS inside FROM down`,
          [owner, current.id, parent],
        );
        if (down.rows[0]?.inside === true) return "cycle";
        const height = Number(down.rows[0]?.height ?? 0);
        if (parentDepth + 1 + height > MAX_PAGE_DEPTH) return "too_deep";
        // 親になれるのはフォルダだけ。フォルダは入れ子にしない（§3.2 の 4・5。cycle / too_deep の判定のあと）
        if (parent !== null && (parentKind !== "folder" || current.kind === "folder")) return "not_folder";
        const moved = await client.query(
          "UPDATE pages SET parent = $3 WHERE owner = $1 AND deleted_at IS NULL AND id = $2",
          [owner, current.id, parent],
        );
        if (moved.rowCount !== 1) throw new Error("editor-store: locked page vanished during move");
        // 入れ物のタブも一緒に（ゴミ箱のタブも。戻したときに別のフォルダに現れない）
        if (current.kind === "page") await client.query("UPDATE pages SET parent = $3 WHERE owner = $1 AND page = $2", [owner, current.id, parent]);
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
        let current = await lockPage(client, owner, id);
        if (!current) return null;
        // タブの並びは入れ物の並び（タブは一覧の行ではない。#307）
        if (current.page !== null) {
          const holder = await lockPage(client, owner, current.page);
          if (holder && holder.kind === "page") current = holder;
        }
        // 同じ親の行を今の並びで（親が無い行どうしも「同じ親」。タブは数えない）
        const siblings = await client.query<{ id: string }>(
          `SELECT id
             FROM pages
            WHERE owner = $1 AND deleted_at IS NULL AND parent IS NOT DISTINCT FROM $2::uuid AND page IS NULL
            ORDER BY ${orderOf(current.parent)}`,
          [owner, current.parent],
        );
        const ids = siblings.rows.map((row) => row.id);
        const at = ids.indexOf(current.id);
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
   * そのページと同じ親の全ての行の、いまの `sort_order`（並びの順）。並べ替えのあと、画面が**サーバーが確定した値**で行を更新するための読み取り。
   * 画面は一覧を一部だけ読み込んでいることがあり、自分の持っている行だけで入れ替えると、読み込んでいない兄弟との並びがずれる。
   * ページが無い・別の人のものなら空。
   */
  async pageSiblingOrders(owner: OwnerId, id: string): Promise<{ id: string; sortOrder: number }[]> {
    assertOwner(owner);
    if (!isPageId(id)) return [];
    // 並びは入れ物（と、入れ物の無いページ）の間で決まる。返す行は一覧の行＝タブ（入れ物の並びを添える）と入れ物の無いページ
    // （画面が持つ行はタブの id。#307。入れ物そのものは返さない）
    const result = await this.#db.query<{ id: string; sort_order: number }>(
      `SELECT COALESCE(t.id, s.id) AS id, s.sort_order
         FROM pages AS me
         JOIN pages AS s ON s.owner = me.owner AND s.deleted_at IS NULL AND s.parent IS NOT DISTINCT FROM me.parent AND s.page IS NULL
         LEFT JOIN pages AS t ON t.owner = s.owner AND t.page = s.id AND t.deleted_at IS NULL
        WHERE me.owner = $1 AND me.id = $2 AND me.deleted_at IS NULL AND (s.kind <> 'page' OR t.id IS NOT NULL)
        ORDER BY 1`,
      [owner, id],
    );
    return result.rows.map((row) => ({ id: row.id, sortOrder: row.sort_order }));
  }

  /**
   * そのページの中の行（同じ親の並びの順）。フォルダの子を列挙する口（自動参考ページ・書き出し・画面が使う）。
   * `parent` に null を渡すと上の段。ページが無い・別の人のものなら空（親が本人のものかは呼ぶ側が先に確かめる）。
   */
  async listPageChildren(owner: OwnerId, parent: string | null, options: { limit?: number; view?: PageChunkOptions["view"] } = {}): Promise<PageSummary[]> {
    assertOwner(owner);
    if (parent !== null && !isPageId(parent)) return [];
    const limit = Math.max(1, Math.min(options.limit ?? PAGE_LIST_LIMIT, PAGE_LIST_LIMIT));
    const result = await this.#db.query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS}${options.view === "pages" ? `, ${TABS_COUNT_COLUMN}` : ""}
         FROM ${SUMMARY_FROM}
        WHERE p.owner = $1 AND p.deleted_at IS NULL AND p.parent IS NOT DISTINCT FROM $2::uuid AND ${viewFilter(options.view)}
        ORDER BY ${summaryOrder(parent)}
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
                -- 中の行は「手動の並び → 作った順 → id」（orderOf の親ありと同じ規則）を 1 つの文字列に畳んで並べる。
                -- タブは入れ物の並びの後ろに（入れ物の並び ＋ タブの並び）
                t.path || COALESCE((SELECT to_char(h.sort_order, 'FM0000000000') || to_char(h.created_at, 'YYYYMMDDHH24MISSUS') || h.id::text
                                       FROM pages h WHERE h.owner = c.owner AND h.id = c.page), '')
                       || to_char(c.sort_order, 'FM0000000000') || to_char(c.created_at, 'YYYYMMDDHH24MISSUS') || c.id::text
           FROM pages c JOIN tree t ON c.parent = t.id
          WHERE c.owner = $1 AND c.deleted_at IS NULL AND t.depth < $3
       )
       -- 入れ物（kind='page'）は本文を持たないので出さない（書き出しはタブの本文）
       SELECT ${PAGE_COLUMNS}, depth FROM tree WHERE kind <> 'page' OR depth = 0 ORDER BY path LIMIT $4`,
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
        // フォルダは本文を持たない（旧「親ページ」の版も本文へは戻さない）
        if (current.kind === "folder") return { status: "unrestorable" };
        const target = await client.query<{ blocks: unknown; cover: string | null; lead: string | null; metadata_tracked: boolean }>(
          "SELECT blocks, cover, lead, metadata_tracked FROM page_versions WHERE page_id = $1 AND version = $2",
          [id, version],
        );
        const stored = target.rows[0];
        if (!stored) return null;
        if (current.revision !== options.baseRevision) return { status: "conflict", page: toPage(current) };
        const accepted = options.accept(stored.blocks);
        if (accepted === null) return { status: "unrestorable" };
        let restoredCover = stored.metadata_tracked ? stored.cover : current.cover;
        const restoredLead = stored.metadata_tracked ? stored.lead : current.lead;
        if (restoredCover !== null) {
          const cover = await client.query(
            "SELECT 1 FROM assets WHERE owner = $1 AND page_id = $2 AND id = $3 AND kind = 'image' AND upload_status = 'ready'",
            [owner, id, restoredCover],
          );
          // カバーの写真がもう無い（パネルから外した）: カバー無しで戻す（その写真が欠けるのは許容。オーナー決定 2026-11-05）
          if (cover.rows.length === 0) restoredCover = null;
        }
        const charges = await pageImageCharges(client, owner, id);
        if (pageSizeBytes(current.title, accepted, charges, restoredCover, restoredLead) > PAGE_MAX_BYTES) return { status: "page_full" };
        const metadataChanged = restoredCover !== current.cover || restoredLead !== current.lead;
        await this.#snapshot(client, owner, id, "restore", { ...rulesFor("restore"), skipEmpty: !metadataChanged });
        const result = await client.query<PageRow>(
          `UPDATE pages
              SET blocks = $3::jsonb,
                  cover = $4::uuid,
                  lead = $5::text,
                  revision = revision + 1,
                  updated_at = GREATEST(clock_timestamp(), updated_at)
            WHERE owner = $1 AND deleted_at IS NULL AND id = $2
            RETURNING ${PAGE_COLUMNS}`,
          [owner, id, JSON.stringify(accepted), restoredCover, restoredLead],
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
        // 自分と子孫の行を id の順に 1 文で押さえる（親と子の同時の削除・purge と lock の順が食い違って deadlock しない）。
        // 入れ物（kind='page'）ならそのタブも、最後のタブならその入れ物も一緒に（#307。タブとその子孫は parent で辿る）
        const tree = await client.query<{ id: string }>(
          `WITH RECURSIVE tree AS (
             SELECT id FROM pages WHERE owner = $1 AND deleted_at IS NULL AND id = $2
             UNION
             SELECT c.id FROM pages c JOIN tree t ON c.parent = t.id OR c.page = t.id
              WHERE c.owner = $1 AND c.deleted_at IS NULL
           ), holder AS (
             -- 最後のタブを消すときは入れ物も
             SELECT h.id FROM pages me JOIN pages h ON h.owner = me.owner AND h.id = me.page AND h.deleted_at IS NULL
              WHERE me.owner = $1 AND me.id = $2 AND me.page IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM pages t WHERE t.owner = h.owner AND t.page = h.id AND t.deleted_at IS NULL AND t.id <> me.id)
           )
           SELECT p.id FROM pages p JOIN (SELECT id FROM tree UNION SELECT id FROM holder) t ON t.id = p.id
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
        // A root is authoritative even when it was not selected as an export item. Removing any
        // source tree page atomically fences future Google creates and cascades encrypted payload/outbox.
        await client.query(
          `DELETE FROM google_docs_batch_jobs j
            WHERE j.owner = $1
              AND (j.root_page_id = ANY($2::uuid[])
                   OR EXISTS (
                     SELECT 1 FROM google_docs_batch_items i
                      WHERE i.job_id = j.id AND i.owner = $1 AND i.page_id = ANY($2::uuid[])
                   ))`,
          [owner, ids],
        );
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

  /**
   * 何も足していないページを捨てる（「新しいページ」で作って、そのまま離れたとき。オーナー決定 2026-11-05）。
   * ページの行を `FOR UPDATE` で押さえてから空かを確かめ、空ならゴミ箱に入れずに完全に消す（同じ transaction。保存・画像の開始・
   * 録音などページを書く処理は同じ行を押さえるか FK でこの行を参照するので、確かめてから消すまでの間に中身は増えない）。
   *
   * 空とみなすのは次の全てが揃うときだけ（迷うものは空でないとみなし、消さない）:
   * - 種類はメモ（note）、親・レシピ・手順の状態・手動の並び・カバーが無い
   * - 題名とリードは空白だけ、本文は空（中身の無い段落だけ）
   * - そのページを指す行が無い（資産（画像・録音のどの種類も）・子ページ（ゴミ箱を含む）・版・公開・公開の版・転送・プレビュー・
   *   共有・手順・録音・文字起こし・AI の会話と変更・ページの欄・翻訳の対応と候補・Google ドキュメントの書き出し）
   *   「最近開いた」の記録（page_opens）は中身ではないので数えない（一緒に消える）。
   *
   * 空でなければ何もしない（`{ discarded: false }`）。本人の・ゴミ箱でないページが無ければ null（同じ 404）。
   */
  async discardEmptyPage(owner: OwnerId, id: string): Promise<{ discarded: boolean } | null> {
    assertOwner(owner);
    if (!isPageId(id)) return null;
    return this.#orNull(() =>
      this.#transaction(async (client): Promise<{ discarded: boolean } | null> => {
        const current = await lockPage(client, owner, id);
        if (!current) return null;
        if (!isBlankPageRow(current)) return { discarded: false };
        // 行は押さえてあるので、ここから中身（題名・本文など）は変わらない。関わる行が無いことを、新しい snapshot の 1 文で確かめて消す
        const deleted = await client.query(`DELETE FROM pages p WHERE p.owner = $1 AND p.id = $2 AND p.deleted_at IS NULL AND ${NO_RELATED_ROWS} RETURNING p.id`, [owner, id]);
        // 最後のタブだったら入れ物も（入れ物は本文を持たない。#307）
        if (deleted.rows.length > 0 && current.page !== null) await this.#dropEmptyHolder(client, owner, current.page);
        return { discarded: deleted.rows.length > 0 };
      }),
    );
  }

  /** 自分のゴミ箱（削除の新しい順・本文は含めない）。 */
  async listTrash(owner: OwnerId, options: { limit?: number } = {}): Promise<TrashedPage[]> {
    assertOwner(owner);
    const limit = Math.max(1, Math.min(options.limit ?? TRASH_LIST_LIMIT, TRASH_LIST_LIMIT));
    // 入れ物（kind='page'）は出さない（タブを戻せば一緒に戻る。#307）
    const result = await this.#db.query<{ id: string; kind: PageKind; title: string; deleted_at: Date }>(
      `SELECT id, kind, title, deleted_at
         FROM pages
        WHERE owner = $1 AND deleted_at IS NOT NULL AND kind <> 'page'
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
        // 一緒に入ったもの＝同じ deleted_at の 子孫（parent）・入れ物のタブ（page）・タブの入れ物（タブから上へ）
        const tree = await client.query<{ id: string }>(
          `WITH RECURSIVE root AS (
             SELECT id, deleted_at FROM pages WHERE owner = $1 AND deleted_at IS NOT NULL AND id = $2
           ), tree AS (
             SELECT id FROM root
             UNION
             SELECT c.id FROM pages c JOIN tree t ON c.parent = t.id OR c.page = t.id OR (c.kind = 'page' AND c.id = (SELECT page FROM pages x WHERE x.id = t.id))
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
      const due = await client.query<{ id: string; kind: PageKind }>(
        `SELECT id, kind
           FROM pages
          WHERE deleted_at IS NOT NULL
            AND deleted_at < clock_timestamp() - make_interval(days => $1::int)
            AND NOT EXISTS (SELECT 1 FROM publications pub WHERE pub.page_id = pages.id)
          ORDER BY id
          FOR UPDATE`,
        [days],
      );
      // 数えるのは本文を持つ行とフォルダ（タブの入れ物は数えない。#307）
      const holders = new Set(due.rows.filter((row) => row.kind === "page").map((row) => row.id));
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
      // 残るタブは入れ物を外す（入れ物の無い 1 枚だけのページになる。#307。消えるタブどうしの参照も、1 文の DELETE に順序を持たせないよう先に外す）
      await client.query("UPDATE pages SET page = NULL WHERE page = ANY($1::uuid[])", [ids]);
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
      // タブを 1 つも持たない入れ物（kind='page'）は意味を持たないので、ついでに消す（タブだけが直に消されたとき。#307）
      await client.query("DELETE FROM pages h WHERE h.kind = 'page' AND NOT EXISTS (SELECT 1 FROM pages t WHERE t.owner = h.owner AND t.page = h.id)");
      return { pages: ids.filter((id) => !holders.has(id)).length, assetPaths: assets.rows.map((row) => row.bucket_path) };
    });
  }

  /**
   * 今の本文を版に残す（ページの行を押さえた transaction の中で呼ぶ）。番号はページごとの連番（最新 +1）。
   * 残したら上限を超えた古い autosave の版を捨てる。残さなかったときは null。
   */
  async #snapshot(client: Queryable, owner: OwnerId, id: string, reason: VersionReason, rules: SnapshotRules): Promise<PageVersionSummary | null> {
    const inserted = await client.query<VersionRow>(
      `WITH latest AS (
         SELECT version, blocks, cover, lead, metadata_tracked, created_at FROM page_versions WHERE page_id = $2 ORDER BY version DESC LIMIT 1
       )
       INSERT INTO page_versions (page_id, version, blocks, reason, cover, lead, metadata_tracked)
       SELECT p.id, COALESCE((SELECT version FROM latest), 0) + 1, p.blocks, $3, p.cover, p.lead, true
         FROM pages p
        WHERE p.owner = $1 AND p.deleted_at IS NULL AND p.id = $2
          AND (NOT $4::boolean OR p.blocks IS DISTINCT FROM $8::jsonb OR p.cover IS DISTINCT FROM $9::uuid OR p.lead IS DISTINCT FROM $10::text)
          AND (NOT $5::boolean OR jsonb_array_length(p.blocks) > 0)
          AND (NOT $6::boolean OR NOT EXISTS (
                SELECT 1 FROM latest l WHERE l.metadata_tracked AND l.blocks = p.blocks
                  AND l.cover IS NOT DISTINCT FROM p.cover AND l.lead IS NOT DISTINCT FROM p.lead))
          AND ($7::float8 IS NULL OR NOT EXISTS (
                SELECT 1 FROM latest l WHERE l.created_at > clock_timestamp() - $7::float8 * interval '1 millisecond'))
       RETURNING version, reason, created_at, jsonb_array_length(blocks) AS block_count`,
      [
        owner,
        id,
        reason,
        rules.unlessSameAs !== undefined,
        rules.skipEmpty,
        rules.skipSame,
        rules.minIntervalMs ?? null,
        rules.unlessSameAs?.blocks ?? null,
        rules.unlessSameAs?.cover ?? null,
        rules.unlessSameAs?.lead ?? null,
      ],
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

/** 中身の無い段落（`{ type: "paragraph" }`・content が空）。空のページの本文はこれだけを含んでよい。 */
function isBlankParagraph(block: Block): boolean {
  if (block.type !== "paragraph") return false;
  const content = block.content;
  return content === undefined || content === null || (Array.isArray(content) && content.length === 0);
}

/** 押さえたページの行が「何も足していない」か（関わる行の有無は NO_RELATED_ROWS が見る）。 */
function isBlankPageRow(row: PageRow): boolean {
  return (
    row.kind === "note" &&
    row.recipe === null &&
    row.step_status === null &&
    // タブの並び（2 つ目以降は 1 から）は中身ではない
    (row.sort_order === 0 || row.page !== null) &&
    row.made_from === null &&
    row.cover === null &&
    row.title.trim() === "" &&
    (row.lead === null || row.lead.trim() === "") &&
    Array.isArray(row.blocks) &&
    row.blocks.every(isBlankParagraph)
  );
}

/**
 * ページ（p）を指す行が 1 つも無い（discardEmptyPage）。pages を参照する表を migrations から全て並べる。
 * 表を足したらここにも足す（足し忘れると、その行がある「空でない」ページを消して CASCADE で行も消してしまう）。
 * `test/discard-empty-page.integration.test.ts` が、DB の外部キーの一覧とこの並び（と DISCARD_IGNORED_TABLES）を突き合わせる。
 */
const DISCARD_RELATED_ROWS = [
  "assets a WHERE a.owner = p.owner AND a.page_id = p.id",
  "pages c WHERE c.owner = p.owner AND c.parent = p.id",
  "pages tb WHERE tb.owner = p.owner AND tb.page = p.id",
  "page_versions v WHERE v.page_id = p.id",
  "publications pub WHERE pub.page_id = p.id",
  "publication_versions pv WHERE pv.page_id = p.id",
  "publication_redirects pr WHERE pr.page_id = p.id",
  "preview_tokens pt WHERE pt.page_id = p.id",
  "page_shares s WHERE s.page_id = p.id",
  "step_runs sr WHERE sr.owner = p.owner AND sr.parent = p.id",
  "step_attempts sa WHERE sa.page_id = p.id",
  "page_recordings r WHERE r.page_id = p.id",
  "page_recording_audios ra WHERE ra.page_id = p.id",
  "page_recording_candidates rc WHERE rc.page_id = p.id",
  "transcription_runs tr WHERE tr.page_id = p.id",
  "ai_conversations ac WHERE ac.page_id = p.id",
  "ai_message_changes am WHERE am.page_id = p.id",
  "page_fields pf WHERE pf.owner = p.owner AND pf.page_id = p.id",
  "page_translation_relations tl WHERE tl.source_page_id = p.id OR tl.target_page_id = p.id",
  "page_translation_proposals tp WHERE tp.source_page_id = p.id OR tp.target_page_id = p.id",
  "google_docs_batch_jobs gj WHERE gj.root_page_id = p.id",
  "google_docs_batch_items gi WHERE gi.page_id = p.id",
];
const NO_RELATED_ROWS = DISCARD_RELATED_ROWS.map((from) => `NOT EXISTS (SELECT 1 FROM ${from})`).join("\n   AND ");

/** 空のページを捨てる前に、行が無いことを確かめる表（pages を参照する表）。 */
export const DISCARD_GUARDED_TABLES: readonly string[] = Object.freeze(DISCARD_RELATED_ROWS.map((from) => from.split(" ")[0]!));
/** pages を参照するが、空かどうかに数えない表（「最近開いた」の記録。ページと一緒に消える）。 */
export const DISCARD_IGNORED_TABLES: readonly string[] = Object.freeze(["page_opens"]);
