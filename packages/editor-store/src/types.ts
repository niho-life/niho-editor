import type { Pool } from "pg";

/**
 * ページの種類（見た目と初期値を決める。設計 §3）。`folder` は入れ物で、本文も欄も持たず、ほかの種類と行き来しない
 * （docs/architecture/editor-recipes-and-folders.md §3.2）。`page` はタブの入れ物（#307。題名・役割・並びだけを持ち、本文は持たない。
 * 本文はその入れ物を `page` で指すタブの行にある）。
 */
export const PAGE_KINDS = ["note", "rec", "article", "step", "folder", "page"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** 本文を持ち、タブになれる種類（入れ物とフォルダ以外。step は #309 までは録音のサブページのまま）。 */
export const TAB_KINDS = ["note", "rec", "article"] as const;

/**
 * 入れ物の役割（#307。同じフォルダの中で「同じ役割のページがあればタブを足す」を決める）。
 * 文字起こしは `{ kind: 'transcript' }`、手順の段階は `{ kind: 'step', recipe, stepId }`。
 */
export type PageRole = { kind: "transcript" } | { kind: "step"; recipe: string; stepId: string };

/**
 * タブが何から作られたか（#307。系譜）。文字起こしは録音のタブとエンジン、段階は run と入力のタブ（その revision）、複製は元のタブ。
 */
export type MadeFrom =
  | { kind: "transcript"; recording: string; engine: string }
  | { kind: "step"; run: string; input: string; inputRevision: number }
  | { kind: "dup"; from: string };

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
  /** タブが属する入れ物（`kind='page'` の行の id）。入れ物・フォルダ・step・入れ物の無い 1 枚だけのページは null。 */
  page: string | null;
  /** 入れ物の役割（タブ・フォルダは null）。 */
  role: PageRole | null;
  /** タブが何から作られたか（入れ物・フォルダは null。人が作ったタブも null）。 */
  madeFrom: MadeFrom | null;
  /** 入れ物で最後に開いたタブ（入れ物以外は null）。 */
  lastTab: string | null;
  /**
   * タブの名前（帯に出す短い札。#308）。名前を付けていなければ null（画面は入れ物の中の位置の番号を出す。`tabLabel`）。
   * 題名（`title`）はページの名前で、入れ物と全てのタブで同じ（タブの保存が写す）。
   */
  tabName: string | null;
  createdAt: string;
  updatedAt: string;
};

/** タブの名前の長さの上限（文字。migration 20261107003531 の CHECK と同じ）。 */
export const TAB_NAME_MAX_CHARS = 100;

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
  /** タブが属する入れ物（#307。無い・分からないときは省く）。 */
  page?: string | null;
  /** 入れ物の役割（#307。無い・分からないときは省く）。 */
  role?: PageRole | null;
  /** 何から作られたタブか（#309/#310。開いているページの行だけ。無い・分からないときは省く）。 */
  madeFrom?: MadeFrom | null;
  /** 入れ物のタブの数（入れ物の行だけ。`view: 'pages'` の一覧で添える）。 */
  tabsCount?: number;
  /** タブの名前（タブの行だけ。付けていなければ null。#308）。 */
  tabName?: string | null;
  /** 入れ物の中の位置（1 から。タブの行だけ。名前の無いタブの札に使う）。 */
  tabPos?: number;
};

/**
 * タブの帯・一覧の 2 行目・検索の結果に出すタブの札: 付けた名前か、入れ物の中の位置の番号（モック editor-folder-pages-v1 の `tl`）。
 * タブでない行（入れ物・フォルダ・入れ物の無いページ）は空。
 */
export function tabLabel(tab: Pick<PageSummary, "tabName" | "tabPos">): string {
  if (tab.tabName) return tab.tabName;
  return tab.tabPos === undefined ? "" : String(tab.tabPos);
}

/** 一覧のひと区切り。next は続きを読むときに cursor に渡す値（続きが無ければ null）。 */
export type PageChunk = { pages: PageSummary[]; next: string | null };

export type PageChunkOptions = {
  limit?: number;
  /** 前の区切りの next。無ければ先頭から。 */
  cursor?: string | null;
  /**
   * 何を 1 行にするか。`tabs`（既定。今までの一覧）: 本文を持つ行（タブと入れ物の無いページ）。入れ物は出さない。
   * `pages`: 入れ物・フォルダ・入れ物の無いページ（タブは出さず、入れ物に `tabsCount`）。
   * `all`: 入れ物もタブも全部（画面の一覧が使う。入れ物の行にして、タブは `page` で入れ物に集める。#308）。
   */
  view?: "tabs" | "pages" | "all";
};

/**
 * ページを開くときの解決（#307）。id がタブならその入れ物と自分、入れ物なら最後に開いたタブ（無ければ 1 つ目）。
 * 入れ物の無い 1 枚だけのページは `page` が null で `tab` がそのページ、`tabs` はそれ 1 つ。
 */
export type ResolvedPage = { page: Page | null; tab: Page; tabs: PageSummary[] };

export type CreatePageInput = {
  kind?: PageKind;
  title?: string;
  lang?: PageLang;
  blocks?: Block[];
  lead?: string | null;
  /** 作るときに入れるフォルダ（本人の生きている `kind='folder'` だけ。`kind='folder'` には付けられない）。 */
  parent?: string | null;
  /** 入れ物の役割（本文を持つ種類のとき。フォルダ・step には付けられない）。 */
  role?: PageRole | null;
};

/**
 * タブを足す入力（#307）。本文は持たない（まっさら。複製は duplicatePage）。題名はページの名前（入れ物の題名）を写す。
 * `name` はタブの名前（無ければ付けない＝位置の番号で呼ぶ）。
 */
export type CreateTabInput = {
  name?: string;
  lang?: PageLang;
};

/**
 * タブを別の入れ物へ移す結果（タブか入れ先が無いときは null＝同じ 404）。
 * `not_page` は入れ先が入れ物でない・動かすものがタブでない、`same_folder_only` は別のフォルダの入れ物へは移せない（まず入れ物を移す）。
 */
export type MoveTabResult = "moved" | "not_page";

/** 部分更新。指定したものだけを変える。 */
export type PagePatch = {
  kind?: PageKind;
  title?: string;
  lang?: PageLang;
  blocks?: Block[];
  /** 公開用カバー。本人のこのページに属する ready 画像だけを指定でき、null で外す。 */
  cover?: string | null;
  /** 公開用リード（160 字まで）。null で外す。 */
  lead?: string | null;
};

/** 保存のしかた。`baseRevision` が今の revision と違えば何も書かずに競合を返す。 */
export type SaveOptions = {
  baseRevision: number;
  /** 「この内容で上書き」。更新の前に今の本文を版（理由 `overwrite`）として残す。 */
  overwrite?: boolean;
};

/**
 * フォルダへ入れる・出すの結果（ページか入れ先が無いときは null＝同じ 404）。
 * `too_deep` は段が深くなりすぎる移動、`cycle` は自分自身・自分の子孫の下へ入れる移動、
 * `not_folder` は入れ先がフォルダでない・フォルダをフォルダへ入れる移動（どれも何も書かない）。
 */
export type MovePageResult = "moved" | "too_deep" | "cycle" | "not_folder";

/** 手動の並びを 1 つ動かす向き。 */
export type OrderMove = "up" | "down";

/**
 * 手動の並びを動かした結果（ページが無いときは null）。`edge` はもう端にいる（何も書かない）。
 * 動かすと、同じ親の中の全ての行に 1 から振り直す。
 */
export type MoveOrderResult = "moved" | "edge";

/** 保存の結果（該当するページが無いときは null）。競合のときは何も書かず、今のページを返す。 */
export type SaveResult = { status: "saved"; page: Page } | { status: "conflict"; page: Page } | { status: "page_full" };

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
  | { status: "unrestorable" }
  | { status: "page_full" };

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
