import type { Pool } from "pg";

/** ページの種類（見た目と初期値を決めるだけで、あとから変えられる）。設計 §3。 */
export const PAGE_KINDS = ["note", "rec", "article", "step"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export const PAGE_LANGS = ["ja", "en"] as const;
export type PageLang = (typeof PAGE_LANGS)[number];

export const STEP_STATUSES = ["done", "run", "wait", "stale", "failed"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/**
 * 本文のブロック。ここでは「JSON の値の配列」としてだけ扱う（中身の形はエディタ側の schema が決める）。
 * 限定 AST としての厳密な検証は #33 で足す。
 */
export type Block = { readonly [key: string]: unknown };

/** NIHO の安定したユーザー ID（認証の後でだけ得る）。メール・名前ではない。 */
export type OwnerId = string;

export type Page = {
  id: string;
  kind: PageKind;
  title: string;
  lang: PageLang;
  blocks: Block[];
  cover: string | null;
  lead: string | null;
  parent: string | null;
  recipe: string | null;
  stepStatus: StepStatus | null;
  /** 同じ親の中の手動の並び（小さいほど上。0 は並べ替えていない）。 */
  sortOrder: number;
  /** 楽観ロックの番号。保存のたびに +1。保存の要求はこれを `baseRevision` として持ってくる。 */
  revision: number;
  createdAt: string;
  updatedAt: string;
};

/** 公開の発信先（#39）。exp は NIHO Experience、niho は NIHO、site は本人のサイト。 */
export const PUBLISH_DESTS = ["exp", "niho", "site"] as const;
export type PublishDest = (typeof PUBLISH_DESTS)[number];

/** 公開の範囲。unlisted（限定公開）は NIHO の面だけ。 */
export const PUBLISH_RANGES = ["live", "unlisted"] as const;
export type PublishRange = (typeof PUBLISH_RANGES)[number];

/** 一覧の 2 行目に出す公開の状態（公開したことが無ければ null）。stopped は公開をやめたもの。 */
export type PagePublicationSummary = {
  dest: PublishDest;
  /** exp / niho（面）か、本人のサイトの接続の handle。 */
  handle: string;
  range: PublishRange;
  stopped: boolean;
};

/**
 * 一覧の 1 行（本文は含めない）。parent はサブページを親の下に並べるため、stepStatus は「作成中」を出すため、
 * publication は 2 行目の公開先を出すため。
 */
export type PageSummary = Pick<Page, "id" | "kind" | "title" | "lang" | "parent" | "stepStatus" | "sortOrder" | "createdAt" | "updatedAt"> & {
  publication: PagePublicationSummary | null;
};

/** 一覧のひと区切り。next は続きを読むときに cursor に渡す値（続きが無ければ null）。 */
export type PageChunk = { pages: PageSummary[]; next: string | null };

export type PageChunkOptions = {
  limit?: number;
  /** 前の区切りの next。無ければ先頭から。 */
  cursor?: string | null;
};

export type CreatePageInput = {
  kind?: PageKind;
  title?: string;
  lang?: PageLang;
  blocks?: Block[];
};

/** 部分更新。指定したものだけを変える。 */
export type PagePatch = {
  kind?: PageKind;
  title?: string;
  lang?: PageLang;
  blocks?: Block[];
};

/** 保存のしかた。`baseRevision` が今の revision と違えば何も書かずに競合を返す。 */
export type SaveOptions = {
  baseRevision: number;
  /** 「この内容で上書き」。更新の前に今の本文を版（理由 `overwrite`）として残す。 */
  overwrite?: boolean;
};

/**
 * フォルダへ入れる・出すの結果（ページか入れ先が無いときは null＝同じ 404）。
 * `too_deep` は段が深くなりすぎる移動、`cycle` は自分自身・自分の子孫の下へ入れる移動（どちらも何も書かない）。
 */
export type MovePageResult = "moved" | "too_deep" | "cycle";

/** 手動の並びを 1 つ動かす向き。 */
export type OrderMove = "up" | "down";

/**
 * 手動の並びを動かした結果（ページが無いときは null）。`edge` はもう端にいる（何も書かない）。
 * 動かすと、同じ親の中の全ての行に 1 から振り直す。
 */
export type MoveOrderResult = "moved" | "edge";

/** 保存の結果（該当するページが無いときは null）。競合のときは何も書かず、今のページを返す。 */
export type SaveResult = { status: "saved"; page: Page } | { status: "conflict"; page: Page };

/** 版を残す理由。設計 §5.1。 */
export const VERSION_REASONS = ["autosave", "ai", "publish", "overwrite", "restore"] as const;
export type VersionReason = (typeof VERSION_REASONS)[number];

/** 版の一覧の 1 行（本文は含めない）。 */
export type PageVersionSummary = {
  version: number;
  reason: VersionReason;
  createdAt: string;
  blockCount: number;
};

export type PageVersion = {
  version: number;
  reason: VersionReason;
  createdAt: string;
  blocks: Block[];
};

export type RestoreOptions = {
  baseRevision: number;
  /**
   * 戻す版の本文を、保存のときと同じ検査に通す。保存してよい形に組み直した写しを返し、通らなければ null。
   * （限定 AST の検査は Web の側が持つので、ここでは受け取って使うだけ）
   */
  accept: (blocks: unknown) => Block[] | null;
};

/** 「この版に戻す」の結果（ページか版が無いときは null）。 */
export type RestoreResult =
  | { status: "restored"; page: Page }
  | { status: "conflict"; page: Page }
  | { status: "unrestorable" };

/** ゴミ箱へ入れた結果（該当するページが無いときは null）。公開中のページは入れない。 */
export type DeleteResult = "deleted" | "published";

/** ゴミ箱の 1 行（本文は含めない）。 */
export type TrashedPage = Pick<Page, "id" | "kind" | "title"> & { deletedAt: string };

export type PurgeResult = {
  /** 完全に消したページの数。 */
  pages: number;
  /** 一緒に消えた資産の object の位置（実体の削除は別の処理）。 */
  assetPaths: string[];
};

/** pg の Pool / PoolClient のうち、このパッケージが使う部分。 */
export type Queryable = Pick<Pool, "query">;

/** transaction のために接続を 1 本借りられるもの（pg の Pool）。 */
export type Database = Pick<Pool, "query" | "connect">;
