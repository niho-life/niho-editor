"use client";

import "niho-ui/styles/tokens.css";
import "niho-docs-ui/styles/tokens.css";
import "niho-docs-ui/styles/shell.css";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { PageKind, PageLang, PageSummary, StepStatus } from "@niho/editor-store";
import { isShellWindow } from "niho-desktop-bridge/shell-bridge";
import {
  EditorShell,
  SHELL_PANELS,
  ShellHeader,
  ShellMobileToolbar,
  ShellSheet,
  ShellSidebar,
  ShellTools,
  type NewPageKind,
  type ShellDropTarget,
  type ShellPanelId,
  type ShellToolAction,
} from "niho-docs-ui/shell";
import type { PageChromeTools } from "niho-docs-ui/page/PageChrome";
import { PagePhotos } from "niho-docs-ui/page/PagePhotos";
import { pagePhotosBody } from "niho-docs-ui/page/page-photos";
import { imageAssetPath } from "@/image/image-paths";
import { pageImages } from "@/lib/image-upload-client";
import { movePageOrderRequest, recordPageOpenRequest } from "@/lib/folder-client";
import { discardLeftEmptyCandidates, dropLeftEmptyCandidate } from "@/lib/left-empty-pages";
import { createPageRequest, listPagesRequest, movePageRequest } from "@/lib/pages-client";
import { PAGE_MAX_BYTES } from "@/image/image-limits";
import { SAVE_STATUS_TEXT, headerStatus, type SaveStatus } from "@/lib/save-status";
import { useShortcuts } from "@/lib/shortcuts";
import {
  arrangeSidebarItems,
  folderOfPage,
  folderOptions,
  locationOf,
  orderNeighbours,
  reorderedPages,
  searchRows,
  siblingOrder,
  withoutPageTree,
  type SidebarPublication,
} from "@/lib/sidebar-items";
import { usePageHistory } from "@/lib/use-page-history";
import { AI_GRAY_ITEM, usePageMenu, type AttachedPage, type PageMenuLocalItem } from "@/lib/use-page-menu";
import { setAiGray, useAiGray } from "@/lib/ai-gray";
import type { AttachedAiSteps, AttachedFlow } from "@/lib/attached-page";
import { usePageSearch, type PageSearchState } from "@/lib/use-page-search";
import { usePageShare } from "@/lib/use-page-share";
import { useSearchShortcut } from "@/lib/use-search-shortcut";
import { useShellLayout } from "@/lib/use-shell-layout";
import { useRowDelete } from "@/lib/use-row-delete";
import { HistorySheet } from "./HistorySheet";
import { InfoPanel } from "./InfoPanel";
import { PagePanel } from "./PagePanel";
import { SidePage } from "./SidePage";
import { PageInfo } from "./PageInfo";
import { usePagePublish } from "./PagePublish";
import { BUSY_STYLE } from "./sheet-parts";
import { ShareSheet } from "./ShareSheet";

export type { AttachedPage };

/** shell.css と同じ境目（これ以下は一覧・ページのどちらかを全画面で出す）。 */
const NARROW_QUERY = "(max-width: 900px)";
// 殻の印は起動時に固定。SSR はブラウザとして描き、hydrate 後に端末の表示へ揃える。
const subscribeHost = () => () => undefined;
const hasWindowControls = () => typeof window !== "undefined" && isShellWindow(window);
const serverWindowControls = () => false;

const PAGE_PATH = /^\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/** 右に並べたページ（`?side=`）の id の形。 */
const SIDE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 設定系のページ（ヘッダーの題名と、左下の「設定」の現在地）。 */
const SETTINGS_ROUTES = [
  { path: "/destinations", title: "発信先" },
  { path: "/account", title: "アカウント" },
  { path: "/settings", title: "設定" },
] as const;

export type FrameMe = { name: string; caption: string; initial: string };

export type FrameInitial = {
  pages: PageSummary[];
  next: string | null;
  /** 最近開いたページ（新しい順。#37。まだ何も開いていなければ空）。 */
  recent: PageSummary[];
  /** サーバーで描いた時刻（一覧の「N分前」を、ブラウザの最初の描画でも同じにする）。 */
  now: number;
  me: FrameMe;
  /** 要求の header から推した狭い画面か（ブラウザでは matchMedia に替わる）。 */
  initialNarrow: boolean;
};

/** 開いたページの、一覧の行に無いこと（右下のページの情報に出す）。 */
export type OpenedDetails = {
  /** 録音の長さ（秒。録音ページでない・分からなければ null）。 */
  recordingSec?: number | null;
};

/** 流れ（#309。./FlowWatcher.tsx）が読んだフォルダの入れ物・タブ・フォルダ。一覧の行の印を替え、まだ無い行を足す。 */
export type FrameFlowPage = {
  id: string;
  title: string;
  kind: PageKind;
  parent: string | null;
  /** タブなら入れ物（#307）。 */
  page: string | null;
  stepStatus: StepStatus | null;
  tabName?: string | null;
  tabPos?: number;
};

/** ページの画面から枠（一覧・ヘッダー）へ知らせること。 */
export type EditorFrameApi = {
  narrow: boolean;
  /** 開いたページ。一覧に読み込んでいない古いページでも、ヘッダーに題名を出し、保存したら一覧の上に足す。 */
  pageOpened: (page: PageSummary, details?: OpenedDetails) => void;
  pageTitleChanged: (id: string, title: string) => void;
  /** 公開のシートで変えた言語を保存した。一覧（読み込んだ分と開いたページ）の言語を替える。 */
  pageLangChanged: (id: string, lang: PageLang) => void;
  /** 保存した。一覧の上へ動かし、時刻を今にする。 */
  pageSaved: (id: string) => void;
  /** 新しいページを作った（複製・タブを含む）。一覧の上に足す。種類は既定で note、親（入れたフォルダ）と入れ物（タブのとき。#308）は既定で無し。 */
  pageCreated: (id: string, title: string, kind?: PageKind, parent?: string | null, page?: string | null) => void;
  /** ページをゴミ箱へ入れた。一覧から、そのページと子孫（読み込んである分）を外す。 */
  pageRemoved: (id: string) => void;
  /**
   * 流れが進んだ（#309）。一覧の行の印（stepStatus）・親・入れ物を替え、まだ読み込んでいない入れ物・タブ・フォルダは足す
   * （段階の実行が足したタブ、フォルダに包まれた入れ物）。並びは arrangeSidebarItems が作った順に揃える。
   */
  flowPagesChanged: (pages: readonly FrameFlowPage[]) => void;
  /**
   * 開いているページ（エディタ）を枠に登録する。ヘッダーの状態の丸と「…」がこれを使う。
   * 保存の状態が変わるたびに登録し直し、画面を離れたら返す関数で外す（後から登録したページは外さない）。
   */
  attachPage: (page: AttachedPage) => () => void;
  /** 開いているページのエディタの「今すぐ保存して待つ」（公開のシートが、開く前と送る前に使う）。返す関数で外す。 */
  registerPageSaver: (saveNow: () => Promise<boolean>) => () => void;
  /**
   * 本文の操作（PageChrome）を枠に登録する。ヘッダーに常設の書式の帯（ShellTools）を出すために使う。
   * ページを閉じるときは null（帯は出したままで、押しても何もしない）。
   */
  registerTools: (tools: PageChromeTools | null) => void;
  /** 流れ（FlowWatcher）の工程の状態と開始を右レールの AI へ共有する。登録元が外れたら返す関数で外す。 */
  registerAiSteps: (steps: AttachedAiSteps) => () => void;
  /** 「ページ」パネルの流れ（#309）を登録する。登録元が外れたら返す関数で外す。 */
  registerFlow: (flow: AttachedFlow) => () => void;
  /** 公開のシートを開く（ページを開いている画面だけで出る）。 */
  openPublish: () => void;
  /** 「写真」のパネルで写真を上げている途中か（何も足していないページを捨てる判定に使う）。 */
  photosUploading?: () => boolean;
  /** 一覧に読み込んである行（フォルダを開いた画面の中身・AI の「読むもの」の数に使う）。 */
  pages?: readonly PageSummary[];
  /** 一覧の時刻の基準（サーバーで描いた時刻。フォルダの中身の時刻を一覧と同じにする）。 */
  now?: number;
  /** 場所（親のフォルダ › 親の録音）を押した。そのページへ移る。 */
  openPage?: (id: string) => void;
  /** 開いているタブの流れ（FlowWatcher が登録したもの。タブの ▾ の「作り直す（AI）」が使う。#309）。無ければ null。 */
  flow?: AttachedFlow | null;
};

const noop = () => undefined;

const FrameContext = createContext<EditorFrameApi>({
  narrow: false,
  pageOpened: noop,
  pageTitleChanged: noop,
  pageLangChanged: noop,
  pageSaved: noop,
  pageCreated: noop,
  registerPageSaver: () => noop,
  registerTools: noop,
  registerAiSteps: () => noop,
  registerFlow: () => noop,
  pageRemoved: noop,
  flowPagesChanged: noop,
  attachPage: () => noop,
  openPublish: noop,
  photosUploading: () => false,
});

export function useEditorFrame(): EditorFrameApi {
  return useContext(FrameContext);
}

/** 今、狭い画面か（effect の中で読む。描画には useEditorFrame().narrow を使う）。 */
export function isNarrowNow(): boolean {
  return window.matchMedia(NARROW_QUERY).matches;
}

function subscribeNarrow(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** 一覧（読み込んだ分）と、開いているページ（一覧に無いこともある）。 */
type ListState = {
  pages: PageSummary[];
  next: string | null;
  opened: PageSummary | null;
  /** 開いたページの、一覧の行に無いこと（opened と同じページの分だけ）。 */
  details: { id: string; recordingSec: number | null } | null;
  /** この画面でゴミ箱へ入れたページ（検索の結果からも外す。結果はサーバーの、削除の前の答えのことがある）。 */
  gone: ReadonlySet<string>;
};

function samePublication(a: SidebarPublication | null, b: SidebarPublication | null): boolean {
  return a === b || (a !== null && b !== null && a.dest === b.dest && a.handle === b.handle && a.range === b.range && a.stopped === b.stopped);
}

/** 読み込んである行と、開いているページ（一覧に無いこともある）を合わせたもの（所属フォルダ・場所を辿るため）。 */
function openedForFolder(list: Pick<ListState, "pages" | "opened">): PageSummary[] {
  return list.opened && !list.pages.some((page) => page.id === list.opened!.id) ? [...list.pages, list.opened] : list.pages;
}

function toTop(pages: PageSummary[], page: PageSummary): PageSummary[] {
  return [page, ...pages.filter((item) => item.id !== page.id)];
}

/** 検索の状況を一言で（読み上げにも使う）。count は出している結果の数。 */
function searchMessage(found: PageSearchState, count: number): string {
  if (found.status === "error") {
    if (found.error === "too_long") return "検索の語が長すぎます（100 文字まで）";
    if (found.error === "unauthorized") return "ログインし直してください";
    if (found.error === "unavailable") return "いま検索できません。しばらくしてからもう一度";
    return "検索できませんでした";
  }
  if (found.status === "ready") return count === 0 ? "見つかりませんでした" : `${count} 件`;
  return "探しています…";
}

/** 一覧の下に出す検索の状況（枠の文言なので shell の色の token だけを使う）。 */
const SEARCH_NOTE_STYLE = { margin: 0, padding: "10px 16px", fontSize: 13, color: "var(--ed-ink-mute)" } as const;
/** 「…」の左に出す、直前の操作の失敗（削除の確認の中の理由と同じ色。shell の色の token だけを使う）。 */
const MENU_NOTE_STYLE = { fontSize: 12.5, lineHeight: 1.3, fontWeight: 600, color: "var(--ed-amber-ink)" } as const;
/** 版に戻したことの見える知らせ（読み上げは下の、いつもある role="status" が持つ）。 */
const RESTORED_NOTE_STYLE = { fontSize: 12.5, lineHeight: 1.3, fontWeight: 600, color: "var(--ed-accent-ink)" } as const;
/** 見えないが読み上げる（ヘッダーの並びの間隔を取らないよう、絶対配置）。 */
const VISUALLY_HIDDEN_STYLE = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  border: 0,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
} as const;

/**
 * 削除の確認（docs-ui の ShellSheet。外は inert、Esc・外の押下・「やめる」で閉じ、閉じたら「…」へフォーカスが戻る）。
 * 送っている間は閉じず、2 回目を送らない。失敗の理由はダイアログの中に出し、閉じない。
 */
function DeleteConfirm(props: { title?: string; busy: boolean; error: string | null; onConfirm: () => void; onCancel: () => void; folder?: { title: string; count: number } | null }) {
  const { busy, folder } = props;
  return (
    <ShellSheet label={folder ? "フォルダの削除" : "ページの削除"} onClose={props.onCancel}>
      <div className="es-sh-hd">
        {/* どのページかを見出しで言う（無題なら「このページ」）。フォルダは中のページの数も言う */}
        <h2>
          {folder
            ? folder.count > 0
              ? `「${folder.title || "無題"}」と中の ${folder.count} ページを削除しますか？`
              : `「${folder.title || "無題"}」を削除しますか？`
            : props.title
              ? `「${props.title}」を削除しますか？`
              : "このページを削除しますか？"}
        </h2>
      </div>
      <div className="es-sh-body">
        <div className="es-sh-sec">
          <p>ゴミ箱に 30 日残ります。</p>
        </div>
      </div>
      <div className="es-sh-foot">
        {props.error && (
          <span role="alert" className="es-sh-note es-sh-left">
            {props.error}
          </span>
        )}
        <span className="es-sh-acts">
          <button type="button" className="es-btn es-btn--quiet" data-autofocus="" aria-disabled={busy || undefined} style={busy ? BUSY_STYLE : undefined} onClick={props.onCancel}>
            やめる
          </button>
          <button type="button" className="es-btn es-btn--primary" aria-disabled={busy || undefined} style={busy ? BUSY_STYLE : undefined} onClick={props.onConfirm}>
            削除する
          </button>
        </span>
      </div>
    </ShellSheet>
  );
}

/** 保存の失敗だけをヘッダーに文字で出す（保存済み・保存中は状態の丸だけ。読み上げは丸の live region が持つ）。 */
const SAVE_FAILURES: ReadonlySet<SaveStatus> = new Set<SaveStatus>(["offline", "error", "conflict", "signedOut"]);

/** 右のページと入れ替える前に、いまのメインの変更を保存できなかったときの一言（入れ替えはしない）。 */
export const SWAP_UNSAVED_TEXT = "入れ替える前に変更を保存できませんでした";

/** 並べ替えを 1 歩ずつ送る上限（左の一覧のドラッグ）。 */
const MAX_ORDER_STEPS = 50;

/** その行が、別の行（ancestor）の中（子孫）にあるか。 */
function isInside(pages: readonly PageSummary[], id: string, ancestor: string): boolean {
  const byId = new Map(pages.map((page) => [page.id, page]));
  // 入れ物のタブは入れ物の中（#308。入れ物を消すとタブも消える）
  if (byId.get(id)?.page === ancestor) return true;
  for (let at = byId.get(id)?.parent ?? null, guard = 0; at !== null && guard < 10; at = byId.get(at)?.parent ?? null, guard++) {
    if (at === ancestor) return true;
  }
  return false;
}

/** `id` のページが `root` のページ自身か、その子孫か（サーバーの削除は子孫ごとゴミ箱へ入れる。大文字小文字は区別しない）。 */
function inPageTree(pages: readonly PageSummary[], id: string, root: string): boolean {
  const [at, top] = [id.toLowerCase(), root.toLowerCase()];
  if (at === top) return true;
  const lowered = pages.map((page) => ({ ...page, id: page.id.toLowerCase(), parent: page.parent?.toLowerCase() ?? null, page: page.page?.toLowerCase() ?? null }));
  return isInside(lowered, at, top);
}

/** 並びを 1 つ動かした結果を行に入れる（サーバーが確定した値があればそれを、無ければ同じ規則で作り直す）。 */
function applyOrder(pages: PageSummary[], id: string, move: "up" | "down", orders: ReadonlyMap<string, number>): PageSummary[] {
  return orders.size > 0 ? pages.map((page) => (orders.has(page.id) ? { ...page, sortOrder: orders.get(page.id)! } : page)) : reorderedPages(pages, id, move);
}

/**
 * 「⋯」の「移動…」: フォルダへ入れる・出す、同じ階層の中で上へ・下へ（左の一覧のドラッグのキーボード・スマホの代替）。
 */
function MoveSheet(props: {
  folder?: { value: string | null; options: { id: string; title: string }[]; note: string | null; onPick: (parent: string | null) => void };
  order?: { canUp: boolean; canDown: boolean; busy: boolean; note: string | null; onUp: () => void; onDown: () => void };
  onClose: () => void;
}) {
  const { folder, order } = props;
  return (
    <ShellSheet label="移動" onClose={props.onClose}>
      <div className="es-sh-hd">
        <h2>移動</h2>
      </div>
      <div className="es-sh-body">
        {folder && (
          <div className="es-sh-sec">
            <h3>フォルダ</h3>
            <select
              className="es-input"
              aria-label="フォルダ"
              data-autofocus=""
              value={folder.value ?? ""}
              onChange={(event) => folder.onPick(event.target.value === "" ? null : event.target.value)}
            >
              <option value="">フォルダに入れない</option>
              {folder.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title || "無題"}
                </option>
              ))}
            </select>
            {folder.note && (
              <p role="alert" className="es-upnote">
                {folder.note}
              </p>
            )}
          </div>
        )}
        {order && (
          <div className="es-sh-sec">
            <h3>並び</h3>
            <div className="es-pills">
              <button
                type="button"
                aria-label="このページを 1 つ上へ"
                data-autofocus={folder ? undefined : ""}
                aria-disabled={!order.canUp || order.busy || undefined}
                onClick={() => order.canUp && !order.busy && order.onUp()}
              >
                上へ
              </button>
              <button type="button" aria-label="このページを 1 つ下へ" aria-disabled={!order.canDown || order.busy || undefined} onClick={() => order.canDown && !order.busy && order.onDown()}>
                下へ
              </button>
            </div>
            {order.note && (
              <p role="alert" className="es-upnote">
                {order.note}
              </p>
            )}
          </div>
        )}
      </div>
      <div className="es-sh-foot">
        <span className="es-sp" />
        <button type="button" className="es-btn es-btn--quiet" onClick={props.onClose}>
          閉じる
        </button>
      </div>
    </ShellSheet>
  );
}


/** 右下のページの情報の ⓘ: 容量の説明（説明文はここだけに置く）。 */
function CapacitySheet({ onClose }: { onClose: () => void }) {
  return (
    <ShellSheet label="容量について" onClose={onClose}>
      <div className="es-sh-hd">
        <h2>容量について</h2>
      </div>
      <div className="es-sh-body">
        <div className="es-sh-sec">
          <p className="es-sh-text">1 ページ {PAGE_MAX_BYTES / (1024 * 1024)} MiB まで（題名・リード・本文・本文とカバーの画像・アップロード中の画像）。</p>
          <p className="es-sh-text" style={{ marginTop: 8 }}>
            録音の音声は別枠で、ページの容量には数えません。
          </p>
        </div>
      </div>
      <div className="es-sh-foot">
        <span className="es-sp" />
        <button type="button" className="es-btn es-btn--quiet" data-autofocus="" onClick={onClose}>
          閉じる
        </button>
      </div>
    </ShellSheet>
  );
}

/** 枠が出すシート（「⋯」の移動・フォルダの背景と、ページの情報の ⓘ）。開いたページの id で持ち、ページが替わったら出さない。 */
type FrameSheet = { kind: "move" | "capacity"; id: string };

/**
 * editor の枠（一覧＋ヘッダー＋ページ）。見た目は niho-docs-ui の shell（#48）。ここは状態と移動だけを持つ。
 * - 一覧は最初の区切りをサーバーから受け、末尾が近づいたら続きを読む。
 * - 900px 以下では `/` が一覧の画面。ページと設定は全画面で、ヘッダーの左の「‹ 一覧」（親があればその名前）で戻る。戻るは URL へ移る
 *   （`/` か親のページ。状態の切り替えでなく履歴に乗せるので、OS の戻る・端のスワイプでアプリを抜けない。#320 A1・A2）。
 *   一覧を今のページの上に重ねて出すのは ⌘K（検索）だけ（`listFor`）。
 * - ヘッダーの右上は、開いているページ（`attachPage` で登録されたもの）の状態の丸（いつも「自分だけ」＋保存の状態。保存の失敗だけ
 *   見える文字を添える）と、「…」（リンクで共有・書き出し・Google ドキュメント・[フォルダを書き出し]・履歴・複製・[移動…]・
 *   [フォルダの背景…]・ページの情報・削除。src/lib/use-page-menu.ts・use-page-share.ts・use-page-history.ts）。
 *   まだ作っていないページでは「…」を出さない。削除の確認・共有・履歴・移動・フォルダの背景は ShellSheet で overlay に出す。
 *   ヘッダーの左の場所は、まだ作っていないページ（`/p/new`。録音からを含む）では、フォルダの中から開いたとき（`?in=`）だけ入れ先のフォルダ。
 * - ショートカット（設計 §11）: ⌘N 新しいページ、⌘K 検索、⌘⇧P 公開のシート（⌘S はページ、⌘/ は本文が持つ）。
 * - パネル（#311）: 一覧・AIと作る（./InfoPanel.tsx）・ページ（./PagePanel.tsx）・写真（PagePhotos）を左右のドックに置く。
 *   AI・ページ・写真は保存したページ（`/p/{id}`。フォルダ以外）だけで、まだ作っていないページ（`/p/new`）・録音から・設定系の画面では無い。
 *   ヘッダー右上のボタンは閉じているパネルの分だけ（押すと元のドックの下に戻る）。開いているパネルは × で閉じる。
 *   デスクトップではページを替えても配置はそのまま（端末に覚える。src/lib/use-shell-layout.ts）。狭い画面（900px 以下）は
 *   パネルを 1 つずつ全画面で、開いたページでだけ出す（一覧から別のページを開いたら閉じる）。
 *   アプリ名はいつも画面の左上端、「設定」はいつも左下（EditorShell）。
 * - 公開に関する欄（リード・カバー画像・言語・英語版）は公開のシートの中だけ。文字数とページの情報は本文の列の右下（./PageInfo.tsx）。
 * - フォルダへの出し入れと並びは、左の一覧のドラッグ（キーボード・スマホは「…」の「移動…」）。
 * - 分割ビュー（設計 §5.5。900px 以上だけ）: `/p/{メイン}?side={右}` で右に読むだけのページ（./SidePage.tsx）を並べる。付け外しは
 *   `history.replaceState`（履歴に積まない）、入れ替えはメインの移動（push）。パネルの配置と幅は src/lib/use-shell-layout.ts が
 *   端末ごとに覚え、EditorShell の dock に渡す（パネルは作り直さない）。
 */
export function EditorFrame({ initial, children }: { initial: FrameInitial; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrowNow, () => initial.initialNarrow);
  const windowControls = useSyncExternalStore(subscribeHost, hasWindowControls, serverWindowControls);

  const [list, setList] = useState<ListState>({ pages: initial.pages, next: initial.next, opened: null, details: null, gone: new Set() });
  // 非同期の操作（ドラッグの並べ替え）が、描画を待たずに今の一覧を読む
  const listNow = useRef(list);
  useEffect(() => {
    listNow.current = list;
  });
  const [now, setNow] = useState(initial.now);
  // 閉じているフォルダ（木の段。開いているのが既定）
  const [closedFolders, setClosedFolders] = useState<ReadonlySet<string>>(() => new Set());
  // フォルダへ入れられなかったときの一言（「移動…」のフォルダの下、閉じていればヘッダー）
  const [moveNote, setMoveNote] = useState<string | null>(null);
  // 並べ替えが届かなかったときの一言と、送っているあいだ
  const [orderNote, setOrderNote] = useState<string | null>(null);
  const [ordering, setOrdering] = useState(false);
  // 狭い画面で一覧を出している path（path が変われば閉じる）
  const [listFor, setListFor] = useState<string | null>(null);
  // 狭い画面で全画面に出しているパネル（AI・ページ・写真のどれか 1 つ）と、その path（path が変われば閉じる）。デスクトップの配置は use-shell-layout
  const [panelFor, setPanelFor] = useState<{ id: Exclude<ShellPanelId, "list">; path: string } | null>(null);
  // 「⋯」の移動・フォルダの背景と、ページの情報の ⓘ のシート
  const [frameSheet, setFrameSheet] = useState<FrameSheet | null>(null);
  // 右下のページの情報を開いているページ
  const [infoFor, setInfoFor] = useState<string | null>(null);
  // 並べ替えを送っているあいだ（描画を待たずに読む。ドラッグの次のドロップを受けない）
  const orderingRef = useRef(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [search, setSearch] = useState({ open: false, value: "" });
  const publishSaved = useRef<(id: string) => void>(() => undefined);
  const publishOpen = useRef<() => void>(() => undefined);
  const pageSaver = useRef<(() => Promise<boolean>) | null>(null);
  // 本文の操作（PageChrome が登録する。ヘッダーの常設の帯が使う）
  const [tools, setTools] = useState<PageChromeTools | null>(null);
  // ページを削除するたびに増やす。検索の結果は削除の前の答えのことがあり、読み込んでいない子ページはここでは分からないので、
  // サーバーにもう一度聞く（その間も、この画面で消したと分かっているページは結果から外す）
  const [removedTick, setRemovedTick] = useState(0);
  // ⌘K で検索の入力欄へフォーカスを移す回数（開いていても移す）
  const [searchFocus, setSearchFocus] = useState(0);
  const frameRoot = useRef<HTMLDivElement | null>(null);
  // ⌘N で移り始めた元の path（移り終わるまで二度は押さない）
  const newFrom = useRef<string | null>(null);
  // 開いているページ（ページの中の PageEditor が登録する）。ref は非同期の操作のあとに今の値を読むため（描画を待たない）
  const [attached, setAttached] = useState<AttachedPage | null>(null);
  const attachedRef = useRef<AttachedPage | null>(null);
  const [aiSteps, setAiSteps] = useState<AttachedAiSteps | null>(null);
  const aiStepsRef = useRef<AttachedAiSteps | null>(null);
  // 「ページ」パネルの流れ（開いているタブの FlowWatcher が登録する）
  const [flow, setFlow] = useState<AttachedFlow | null>(null);
  const flowRef = useRef<AttachedFlow | null>(null);
  // 版に戻して開き直したページ。そのページが登録し直したとき、フォーカスが外れていたら「…」へ戻す
  const refocusRef = useRef<string | null>(null);
  // 「写真」のパネルで上げている途中か
  const photosUploadingRef = useRef(false);
  const setPhotosUploading = useCallback((uploading: boolean) => {
    photosUploadingRef.current = uploading;
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const currentId = PAGE_PATH.exec(pathname)?.[1];
  const settings = SETTINGS_ROUTES.find((route) => pathname === route.path || pathname.startsWith(`${route.path}/`));
  // 右に並べたページ（設計 §5.5。`/p/{メイン}?side={右}`）。デスクトップで、ページを開いていて、UUID の形で、メインと違うときだけ出す。
  // 900px 未満では出さない（URL はそのまま）
  const sideParam = searchParams.get("side")?.toLowerCase() ?? null;
  const sideId = !narrow && currentId && sideParam && SIDE_ID.test(sideParam) && sideParam !== currentId.toLowerCase() ? sideParam : null;

  // AI・ページ・右下のページの情報のページ: 開いているエディタのページ（作ったばかりで URL がまだ `/p/new` のときも）か、URL のページ。
  // 一覧の行（作成・更新）が分かり、エディタが画面にあるときだけ出す（`/p/new` の作る前・設定系・ページが無い 404 では出さない）。
  // エディタが下書きを読み終えるまでは、パネルは出したまま中のボタンは何もしない（ページを替えるたびにパネルが消えて戻らないように）
  const railId = attached?.id ?? (attached ? currentId : undefined);
  const railSummary = railId
    ? (list.pages.find((page) => page.id === railId) ?? (list.opened?.id === railId ? list.opened : undefined))
    : undefined;
  const railPage = attached && attached.id !== null && attached.id === railId ? attached : null;
  // フォルダ（kind = 'folder'）では「…」を「書き出し（.zip）」「削除」だけにし、AI・ページ・写真・公開・挿入の道具・ページの情報を出さない
  const railIsFolder = railSummary?.kind === "folder";
  const aiAvailable = railSummary !== undefined && !railIsFolder;
  // 「写真」のパネル: ページを開いていて（作ってあり、エディタが下書きを読み終えた）、設定などの画面でないときだけ。
  // 本文との橋渡し（✓・本文に入れる・外したら本文とカバーから消す）は、開いているページのエディタで行う
  const photoEditor = attached?.ai?.editor ?? null;
  const photoClearCover = attached?.clearCover;
  const photosBody = useMemo(() => (photoEditor ? pagePhotosBody(photoEditor, { clearCover: photoClearCover }) : null), [photoEditor, photoClearCover]);
  const photoPageId = attached?.id ?? null;
  const photosAvailable = Boolean(photoPageId && photosBody && !settings);
  // パネルの配置（#311）: 中身のあるパネルのうちドックに置いてあるものを出す。端末ごとに覚える（src/lib/use-shell-layout.ts）。
  // 900px 未満は 1 つずつ全画面（EditorShell が 1 枚表示にする。覚えた配置は使わない）
  const available: Record<ShellPanelId, boolean> = { list: true, ai: aiAvailable, page: aiAvailable, photos: photosAvailable };
  const layout = useShellLayout({ wide: !narrow, available, side: sideId !== null });
  const narrowPanel = (id: ShellPanelId) => panelFor !== null && panelFor.id === id && panelFor.path === pathname;
  const shownPanel = (id: ShellPanelId) =>
    narrow ? (id === "list" ? pathname === "/" || listFor === pathname : available[id] && narrowPanel(id)) : layout.shown[id];
  const sidebarOpen = shownPanel("list");
  const railShown = shownPanel("ai");
  const pageShown = shownPanel("page");
  const photosShown = shownPanel("photos");
  const openPanel = (id: ShellPanelId) => {
    if (!narrow) layout.open(id);
    else if (id === "list") setListFor(pathname);
    else setPanelFor({ id, path: pathname });
  };
  const closePanel = (id: ShellPanelId) => {
    if (!narrow) layout.close(id);
    else if (id === "list") setListFor(null);
    else setPanelFor(null);
  };
  // ヘッダー右上に出す、閉じているパネル（順は 一覧・AI・ページ・写真）。狭い画面の一覧は左の「一覧を出す」が持つ
  const closedPanels = SHELL_PANELS.filter((id) => available[id] && (narrow ? id !== "list" && !narrowPanel(id) : !layout.shown[id]));
  // AI が書き換えたのが右のページなら読み直す（AI の依頼は終わるまでに右のページが替わることがあるので、今の id で比べる）
  const [sideRefresh, setSideRefresh] = useState(0);
  const sideIdRef = useRef(sideId);
  useEffect(() => {
    sideIdRef.current = sideId;
  });
  const onAiPagesChanged = useCallback((ids: readonly string[]) => {
    const side = sideIdRef.current;
    if (side && ids.some((id) => id.toLowerCase() === side)) setSideRefresh((count) => count + 1);
  }, []);

  // 続きを読む（1 回に 1 つ。失敗したら止め、次に末尾が見えたときにもう一度）
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const loading = useRef(false);
  const loadMore = useCallback(async (cursor: string) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const chunk = await listPagesRequest(cursor);
      setList((current) => {
        if (current.next !== cursor) return current;
        const known = new Set(current.pages.map((page) => page.id));
        // 要求を出してから削除した場合、返ってきた区切りは削除の前の一覧のこと。削除したページと、その下のページ（この区切りに
        // 載っているもの。親が区切りの中で先に出るとは限らないので、増えなくなるまで）は戻さない
        const dead = new Set(current.gone);
        for (let grew = true; grew; ) {
          grew = false;
          for (const page of chunk.pages) {
            if (!dead.has(page.id) && page.parent !== null && dead.has(page.parent)) {
              dead.add(page.id);
              grew = true;
            }
          }
        }
        const fresh = chunk.pages.filter((page) => !known.has(page.id) && !dead.has(page.id));
        return { ...current, pages: [...current.pages, ...fresh], next: chunk.next, gone: dead.size === current.gone.size ? current.gone : dead };
      });
    } catch {
      // 次に末尾が見えたときにもう一度
    } finally {
      loading.current = false;
    }
  }, []);
  useEffect(() => {
    const cursor = list.next;
    if (!sentinel || cursor === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore(cursor);
      },
      { root: sentinel.closest("nav"), rootMargin: "600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, list.next, loadMore]);

  const api = useMemo<Omit<EditorFrameApi, "narrow">>(
    () => ({
      pageOpened: (page, details = {}) => {
        setList((current) => ({ ...current, opened: page, details: { id: page.id, recordingSec: details.recordingSec ?? null } }));
        // 最後に開いたページをサーバーに記録する。届かなくても画面は止めない
        void recordPageOpenRequest(page.id).catch(() => undefined);
      },
      // 題名はページの名前で、入れ物と全てのタブで同じ（サーバーの savePage が入れ物と兄弟のタブへ写す。#308）。
      // 一覧の行は入れ物の題名を出すので、編集したタブの行だけでなく、入れ物と兄弟のタブの行も同じに揃える
      pageTitleChanged: (id, title) =>
        setList((current) => {
          const edited = current.pages.find((page) => page.id === id) ?? (current.opened?.id === id ? current.opened : undefined);
          const holder = edited?.page ?? null;
          const same = (page: PageSummary) => page.id === id || (holder !== null && (page.id === holder || page.page === holder));
          return {
            ...current,
            pages: current.pages.map((page) => (same(page) ? { ...page, title } : page)),
            opened: current.opened && same(current.opened) ? { ...current.opened, title } : current.opened,
          };
        }),
      pageLangChanged: (id, lang) =>
        setList((current) => ({
          ...current,
          pages: current.pages.map((page) => (page.id === id ? { ...page, lang } : page)),
          opened: current.opened?.id === id ? { ...current.opened, lang } : current.opened,
        })),
      pageSaved: (id) => {
        setList((current) => {
          const page = current.pages.find((item) => item.id === id) ?? (current.opened?.id === id ? current.opened : undefined);
          return page ? { ...current, pages: toTop(current.pages, { ...page, updatedAt: new Date().toISOString() }) } : current;
        });
        // 公開中なら「更新あり」を確かめ直す
        publishSaved.current(id);
      },
      pageCreated: (id, title, kind = "note", parent = null, holder = null) => {
        const at = new Date().toISOString();
        // 作ったばかりのページは公開していない
        const page: PageSummary = { id, kind, title, lang: "ja", parent, stepStatus: null, sortOrder: 0, page: holder, createdAt: at, updatedAt: at, publication: null };
        setList((current) => ({ ...current, pages: toTop(current.pages, page) }));
      },
      registerPageSaver: (saveNow) => {
        pageSaver.current = saveNow;
        return () => {
          if (pageSaver.current === saveNow) pageSaver.current = null;
        };
      },
      registerTools: (next) => setTools(next),
      registerAiSteps: (steps) => {
        aiStepsRef.current = steps;
        setAiSteps(steps);
        return () => {
          if (aiStepsRef.current !== steps) return;
          aiStepsRef.current = null;
          setAiSteps(null);
        };
      },
      registerFlow: (next) => {
        flowRef.current = next;
        setFlow(next);
        return () => {
          if (flowRef.current !== next) return;
          flowRef.current = null;
          setFlow(null);
        };
      },
      pageRemoved: (id) => {
        setRemovedTick((tick) => tick + 1);
        setList((current) => {
          const pages = withoutPageTree(current.pages, id);
          const kept = new Set(pages.map((page) => page.id));
          const gone = new Set([...current.gone, id, ...current.pages.filter((page) => !kept.has(page.id)).map((page) => page.id)]);
          return { ...current, pages, gone, opened: current.opened && gone.has(current.opened.id) ? null : current.opened };
        });
      },
      flowPagesChanged: (flowPages) =>
        setList((current) => {
          const known = new Map(current.pages.map((page) => [page.id, page]));
          let moved = false;
          const pages = current.pages.map((page) => {
            const next = flowPages.find((item) => item.id === page.id);
            if (!next) return page;
            const samePlace = (page.parent ?? null) === next.parent && (page.page ?? null) === next.page;
            if (page.stepStatus === next.stepStatus && samePlace) return page;
            moved = true;
            return { ...page, stepStatus: next.stepStatus, parent: next.parent, page: next.page };
          });
          const at = Date.now();
          const added = flowPages
            // ゴミ箱に入れた行は作り直さない
            .filter((item) => !known.has(item.id) && !current.gone.has(item.id))
            .map((item, index): PageSummary => {
              const created = new Date(at + index).toISOString();
              return {
                id: item.id,
                kind: item.kind,
                title: item.title,
                lang: known.get(item.parent ?? "")?.lang ?? "ja",
                parent: item.parent,
                page: item.page,
                stepStatus: item.stepStatus,
                // 段階の出力は作った順に並ぶので、手動の並びは持たない
                sortOrder: 0,
                createdAt: created,
                updatedAt: created,
                publication: null,
                ...(item.tabName === undefined ? {} : { tabName: item.tabName }),
                ...(item.tabPos === undefined ? {} : { tabPos: item.tabPos }),
              };
            });
          if (!moved && added.length === 0) return current;
          return { ...current, pages: [...pages, ...added] };
        }),
      attachPage: (page) => {
        attachedRef.current = page;
        setAttached(page);
        return () => {
          if (attachedRef.current !== page) return;
          attachedRef.current = null;
          setAttached(null);
        };
      },
      openPublish: () => publishOpen.current(),
      photosUploading: () => photosUploadingRef.current,
    }),
    [],
  );
  // 場所（パンくず）を押したときの移動。router の値が描くたびに替わっても frame（context）を作り直さない
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);
  const openFromLocation = useCallback((id: string) => routerRef.current.push(`/p/${id}`), []);
  // 読み込んである一覧の行（フォルダの画面の中身・場所・AI の「読むもの」が使う）。依存は値そのもので書く（React Compiler の規則）
  const listPages = list.pages;
  // ヘッダーの場所（親のフォルダ › 親の録音）。上の段のページでは空。
  // まだ作っていないページ（`/p/new`。録音からを含む）は、フォルダの中から開いたとき（`?in=`）だけ、その入れ先のフォルダを出す
  // （どこに作られるかが見える。押すとそのフォルダへ戻れる）。上の段から開いたときは他のページと同じく空
  // frame の useMemo より前で計算する（React Compiler は、memo のあとに list.pages を外の関数へ渡す呼び出しがあると memo を保てない）
  const newInside = pathname === "/p/new" ? searchParams.get("in") : null;
  const newFolder = newInside ? listPages.find((page) => page.id === newInside && page.kind === "folder") : undefined;
  const location = currentId
    ? locationOf(openedForFolder(list), currentId)
    : newFolder
      ? [{ id: newFolder.id, title: newFolder.title, icon: "folder" as const }]
      : [];
  // 狭い画面のヘッダー左の「‹ 行き先」: 場所の末尾（親の録音か親のフォルダ。新しいページならその入れ先のフォルダ）、無ければ一覧（`/`）
  const backTo = location.length > 0 ? location[location.length - 1]! : null;
  const frame = useMemo<EditorFrameApi>(
    () => ({ narrow, ...api, pages: listPages, now, openPage: openFromLocation, flow }),
    [narrow, api, listPages, now, openFromLocation, flow],
  );

  // 前に `pagehide`（タブを閉じる・再読み込み）で離れた、何も足していないページを捨てる（src/lib/left-empty-pages.ts）。
  // 開いたときに 1 回だけ。今開いているページ（再読み込み・最後に開いたページへ戻った）は候補から外すだけで捨てない。
  // デスクトップの `/` は最後に開いたページへ移る途中（HomeRedirect。移り先はサーバーが先に読んでいる）なので、
  // 移り先が決まって pathname が変わるまで待つ（待たずに捨てると、移り先の空のページを消して 404 にしてしまう）
  const discardedOnOpen = useRef(false);
  useEffect(() => {
    if (discardedOnOpen.current) return;
    if (pathname === "/" && !isNarrowNow()) return;
    discardedOnOpen.current = true;
    const opened = PAGE_PATH.exec(pathname)?.[1] ?? null;
    void discardLeftEmptyCandidates(opened, api.pageRemoved);
  }, [pathname, api]);
  useEffect(() => {
    // 戻る（bfcache）でこの画面がそのまま戻ってきたら、開いているページを候補から外す（別のタブが捨てないように）
    const onShow = (event: PageTransitionEvent) => {
      const current = PAGE_PATH.exec(window.location.pathname)?.[1];
      if (event.persisted && current) dropLeftEmptyCandidate(current);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  // 常設の書式の帯にも aria-haspopup="menu" のボタンがあるので、「その他」は名前で選ぶ
  const focusMore = useCallback(() => frameRoot.current?.querySelector<HTMLButtonElement>('.es-dt button[aria-label="その他"]')?.focus(), []);
  // 「…」の「リンクで共有」と「履歴」のシート（保存してから開く）
  const share = usePageShare({ page: attached, current: () => attachedRef.current });
  const history = usePageHistory({
    page: attached,
    current: () => attachedRef.current,
    onRestored: (id) => {
      refocusRef.current = id;
    },
  });
  // 開き直したエディタが端末の下書きを読む間は「…」を出さない。出し直したとき、フォーカスが外れていたら戻す
  useEffect(() => {
    const id = refocusRef.current;
    if (id === null || !attached || attached.id === null) return;
    refocusRef.current = null;
    const active = document.activeElement;
    if (attached.id === id && (!active || active === document.body || !active.isConnected)) focusMore();
  }, [attached, focusMore]);

  const restoredNote = history.notice && history.notice.id === currentId ? history.notice.text : "";

  // 打つたびにサーバーで探す（題名と本文）。検索語が空のあいだは、ふつうの一覧のまま
  const searching = search.open && search.value.trim() !== "";
  const found = usePageSearch(search.open ? search.value : "", { refresh: removedTick });
  const hits = useMemo(() => found.results.filter((hit) => !list.gone.has(hit.id)), [found.results, list.gone]);
  const items = useMemo(
    () => (searching ? searchRows(hits, now) : arrangeSidebarItems(list.pages, { now, collapsed: closedFolders })),
    [searching, hits, list.pages, now, closedFolders],
  );
  const toggleFolder = useCallback(
    (id: string) =>
      setClosedFolders((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );

  // 右の付け外しは履歴に積まない（`history.replaceState` は Next の router に入り、useSearchParams も替わる。ページは読み直さない）
  const setSideUrl = useCallback((id: string | null) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("side", id);
    else url.searchParams.delete("side");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);
  const openSide = (id: string) => {
    if (!currentId || id.toLowerCase() === currentId.toLowerCase()) return;
    setSideUrl(id);
  };
  const closeSide = () => setSideUrl(null);
  // メインと入れ替える（⇄・右のページの帯を真ん中へ・一覧で右のページを開く）。いまのメインの届いていない変更を保存してから移る
  // （右に移ったページはサーバーから読むので）。メインが替わるのは画面の移動なので、履歴に積む。
  // 保存できなかった（通信の失敗・競合など）ときは移らない: 移ると元のメインは右で読むだけになり、直前の変更ではなく古い本文が出て、
  // 保存の失敗や競合を直す画面からも離れてしまう。ヘッダーに一言出し、保存できたら消す（どのページの一言かも持つ）
  const [swapNote, setSwapNote] = useState<string | null>(null);
  const swapping = useRef(false);
  const swapSide = async () => {
    if (!sideId || !currentId || swapping.current) return;
    const [main, side] = [currentId, sideId];
    swapping.current = true;
    try {
      if (!(await saveFirst())) {
        setSwapNote(main);
        return;
      }
      setSwapNote(null);
      router.push(`/p/${side}?side=${main}`);
    } finally {
      swapping.current = false;
    }
  };

  const select = (id: string) => {
    if (id === currentId) setListFor(null);
    else if (sideId && id.toLowerCase() === sideId) void swapSide();
    // 右に並べているページは、メインを替えても残す
    else router.push(`/p/${id}${sideId ? `?side=${sideId}` : ""}`);
  };

  // 開いているページの所属フォルダ（フォルダそのもの・その中のページ・その中の録音の工程のサブページ）。新しいページはその中に作る
  const hereFolder = folderOfPage(openedForFolder(list), currentId ?? null);
  const [folderNote, setFolderNote] = useState<string | null>(null);
  const pickNew = (kind: NewPageKind) => {
    setNewMenuOpen(false);
    if (kind === "folder") {
      // フォルダは入れ子にしないので、いつも上の段に作る。作ったらそのフォルダを開く（題名はその場で直す）
      setFolderNote(null);
      void createPageRequest({ kind: "folder" }).then(
        (created) => {
          api.pageCreated(created.id, "", "folder");
          router.push(`/p/${created.id}`);
        },
        () => setFolderNote("フォルダを作れませんでした"),
      );
      return;
    }
    const inside = hereFolder ? `in=${encodeURIComponent(hereFolder.id)}` : "";
    router.push(kind === "recording" ? `/p/new?from=recording${inside ? `&${inside}` : ""}` : `/p/new${inside ? `?${inside}` : ""}`);
  };

  // 一覧の行の「…」→「削除」（確認のシートはヘッダーの「…」の削除と同じ）。消したページ（フォルダなら中のページも）を開いていればホームへ、右に並べていれば閉じる
  const treePages = list.opened && !list.pages.some((page) => page.id === list.opened!.id) ? [...list.pages, list.opened] : list.pages;
  const rowDelete = useRowDelete({
    current: () => attachedRef.current,
    inTree: (id, root) => inPageTree(treePages, id, root),
    onDeleted: (id) => {
      // 一覧から外す前に、開いているページが消す木の中か見る（外した後は親が分からない）
      const mainGone = !!currentId && inPageTree(treePages, currentId, id);
      const sideGone = !!sideId && inPageTree(treePages, sideId, id);
      api.pageRemoved(id);
      if (mainGone) router.push("/");
      else if (sideGone) closeSide();
    },
  });
  const rowTitle = (id: string) =>
    items.find((item) => item.id === id)?.title ?? list.pages.find((page) => page.id === id)?.title ?? "";

  const recordingStart = pathname === "/p/new" && searchParams.get("from") === "recording";
  // ページの題名はヘッダーに出さない（本文の題名にだけ。オーナー決定 2026-11-06）。ページでない画面（録音から・設定）は出す
  const title = currentId ? undefined : recordingStart ? "録音から" : (settings?.title ?? "");

  // 公開の状態・ボタン・シートは、開いている（一覧か開いたページで分かっている）自分のページにだけ出す
  const openPage = currentId ? (list.opened?.id === currentId ? list.opened : list.pages.find((page) => page.id === currentId)) : undefined;
  // シートが読んだ公開の状態で、その行の 2 行目を替える（公開・やめる・発信先を変えたあと、読み直さずに）
  const onPublication = useCallback(
    (id: string, publication: SidebarPublication | null) =>
      setList((current) => {
        const row = current.pages.find((page) => page.id === id) ?? (current.opened?.id === id ? current.opened : undefined);
        if (!row || samePublication(row.publication, publication)) return current;
        return {
          ...current,
          pages: current.pages.map((page) => (page.id === id ? { ...page, publication } : page)),
          opened: current.opened?.id === id ? { ...current.opened, publication } : current.opened,
        };
      }),
    [],
  );
  /**
   * 手動の並びを 1 歩動かす（送って、届いたら行の `sortOrder` を入れ替える）。届かなければ一言を出して null。
   * 並びはサーバーが同じ親の全ての兄弟に 1 から振り直す。一覧は一部しか読み込んでいないことがあるので、持っている行で
   * 入れ替えず、サーバーが確定した値を行に入れる（読み込んでいない兄弟との並びがずれない）。
   */
  const stepOrder = useCallback(async (id: string, move: "up" | "down"): Promise<{ moved: boolean; orders: ReadonlyMap<string, number> } | null> => {
    try {
      const { moved, orders } = await movePageOrderRequest(id, move);
      if (moved) setList((current) => ({ ...current, pages: applyOrder(current.pages, id, move, orders) }));
      return { moved, orders };
    } catch {
      setOrderNote("並びを変えられませんでした");
      return null;
    }
  }, []);
  /** 手動の並びを 1 つ動かす（「移動…」の「上へ」「下へ」）。 */
  const moveOrder = useCallback(
    async (id: string, move: "up" | "down") => {
      if (orderingRef.current) return;
      setOrderNote(null);
      orderingRef.current = true;
      setOrdering(true);
      try {
        await stepOrder(id, move);
      } finally {
        orderingRef.current = false;
        setOrdering(false);
      }
    },
    [stepOrder],
  );
  const saveFirst = useCallback(() => pageSaver.current?.() ?? Promise.resolve(true), []);
  /**
   * ページをフォルダへ入れる・出す（「移動…」と左の一覧のドラッグ）。先に一覧の行を動かし、届かなければ戻して一言（false）。
   * 本文・revision は変わらないので、開いているエディタには触らない。
   */
  const movePage = useCallback(async (id: string, parent: string | null): Promise<boolean> => {
    setMoveNote(null);
    let before: string | null | undefined;
    setList((current) => {
      before = current.pages.find((page) => page.id === id)?.parent ?? current.opened?.parent ?? null;
      return {
        ...current,
        pages: current.pages.map((page) => (page.id === id ? { ...page, parent } : page)),
        opened: current.opened?.id === id ? { ...current.opened, parent } : current.opened,
      };
    });
    try {
      await movePageRequest(id, parent);
      return true;
    } catch {
      const back = before ?? null;
      setList((current) => ({
        ...current,
        pages: current.pages.map((page) => (page.id === id ? { ...page, parent: back } : page)),
        opened: current.opened?.id === id ? { ...current.opened, parent: back } : current.opened,
      }));
      setMoveNote("このフォルダには入れられませんでした");
      return false;
    }
  }, []);
  /** 左の一覧のドラッグで落とせるか（into は入れられるフォルダ、before / after は入れ先の階層に入れられ、自分の中でない行）。 */
  const canDrop = useCallback(
    (dragId: string, target: ShellDropTarget): boolean => {
      if (ordering) return false;
      const pages = list.pages;
      if (target.id === dragId || !pages.some((page) => page.id === dragId)) return false;
      if (target.where === "into") return folderOptions(pages, dragId).some((option) => option.id === target.id);
      const row = pages.find((page) => page.id === target.id);
      if (!row || isInside(pages, target.id, dragId)) return false;
      return row.parent === null || folderOptions(pages, dragId).some((option) => option.id === row.parent);
    },
    [list.pages, ordering],
  );
  /**
   * 左の一覧のドラッグを落とした。into はそのフォルダへ入れる。before / after は、入れ先の階層が今と違えば先に入れ直し、
   * そのあと同じ階層の並びを、落とした行の前・後になるまで 1 歩ずつ動かす（既存の `PATCH /order { move }`。各歩で行を入れ替える）。
   * 途中で届かなければ止めて一言。動かしている間は次のドロップを受けない。
   */
  const dropPage = useCallback(
    async (dragId: string, target: ShellDropTarget) => {
      if (orderingRef.current) return;
      if (target.where === "into") {
        void movePage(dragId, target.id);
        return;
      }
      let pages = listNow.current.pages;
      const row = pages.find((page) => page.id === target.id);
      const dragged = pages.find((page) => page.id === dragId);
      if (!row || !dragged) return;
      const parent = row.parent;
      orderingRef.current = true;
      setOrdering(true);
      setOrderNote(null);
      try {
        if (dragged.parent !== parent) {
          if (!(await movePage(dragId, parent))) return;
          pages = pages.map((page) => (page.id === dragId ? { ...page, parent } : page));
        }
        for (let step = 0; step < MAX_ORDER_STEPS; step++) {
          const order = siblingOrder(pages, dragId);
          const at = order.indexOf(dragId);
          const to = order.indexOf(target.id);
          if (at < 0 || to < 0) break;
          const want = target.where === "before" ? (at < to ? to - 1 : to) : at < to ? to : to + 1;
          if (at === want) break;
          const move = at > want ? "up" : "down";
          const result = await stepOrder(dragId, move);
          if (!result || !result.moved) break;
          pages = applyOrder(pages, dragId, move, result.orders);
        }
      } finally {
        orderingRef.current = false;
        setOrdering(false);
      }
    },
    [movePage, stepOrder],
  );
  /**
   * ヘッダーに常設する書式の帯（ShellTools）。開いているページの本文の操作（PageChrome が登録したもの）につなぐ。
   * 「録音」は本文の操作ではないので枠が受け、録音から始める画面へ移る。ページを開いていないあいだは出さない。
   */
  const editorBar = useMemo(
    () =>
      tools
        ? {
            textType: tools.textType,
            blockMenuOpen: tools.blockMenuOpen,
            onAction: (action: ShellToolAction) => {
              if (action === "record") router.push("/p/new?from=recording");
              else tools.run(action);
            },
          }
        : null,
    [tools, router],
  );

  const publishing = usePagePublish({
    // フォルダは公開しない（公開のボタン・状態を出さない）
    pageId: openPage && openPage.kind !== "folder" ? openPage.id : null,
    isArticle: openPage?.kind === "article",
    onPublication,
    onNavigate: (path) => router.push(path),
    saveFirst,
    // 記事の情報（リード・カバー画像・言語・英語版）は、開いているページのエディタが持つ欄を公開のシートの中に出す
    fields: attached && (attached.id ?? currentId) === openPage?.id ? attached.publicationFields : undefined,
  });
  useEffect(() => {
    publishSaved.current = publishing.pageSaved;
    publishOpen.current = publishing.open;
  }, [publishing.pageSaved, publishing.open]);

  // 公開のシートはページを開いている画面だけ（一覧・設定・新しいページ・録音からでは出さない）。開いているあいだは ⌘N・⌘K を効かせない
  const sheetShown = publishing.shown;
  const openPublish = publishing.open;

  const openSearch = () => {
    if (sheetShown) return;
    if (narrow) setListFor(pathname);
    else layout.open("list");
    setSearch((current) => (current.open ? current : { open: true, value: "" }));
    setSearchFocus((count) => count + 1);
  };
  useEffect(() => {
    if (searchFocus === 0) return;
    const input = frameRoot.current?.querySelector<HTMLInputElement>('[role="search"] input');
    input?.focus();
    input?.select();
  }, [searchFocus]);
  useSearchShortcut(openSearch);

  useEffect(() => {
    newFrom.current = null;
  }, [pathname]);
  useShortcuts({
    newPage: () => {
      if (sheetShown) return false;
      // 新しいページを開いている（作っている）とき・⌘N で移っている最中は、二つ目を作らない
      if ((pathname === "/p/new" && !recordingStart) || newFrom.current === pathname) return;
      newFrom.current = pathname;
      pickNew("blank");
    },
    publish: () => {
      if (!currentId || (narrow && sidebarOpen)) return false;
      if (!sheetShown) openPublish();
    },
  });

  // 一覧をしまう: デスクトップでは列を閉じ、狭い画面ではページへ戻る（`/` では一覧がその画面なので出さない）
  const collapse = narrow ? (pathname === "/" ? undefined : () => setListFor(null)) : () => layout.close("list");

  // 入れられるフォルダ（読み込んである上の段のページ）。入れ先が無く、いま上の段にいるなら「移動…」の「フォルダ」を出さない
  const railFolders = useMemo(() => (railSummary ? folderOptions(list.pages, railSummary.id) : []), [railSummary, list.pages]);
  const canFolder = railSummary !== undefined && (railFolders.length > 0 || railSummary.parent !== null);
  // 「並び」は動かせるときだけ出す（同じ階層に 1 つしか無いページには出さない）
  const railOrder = railSummary ? orderNeighbours(list.pages, railSummary.id) : { canUp: false, canDown: false };
  const canOrder = railOrder.canUp || railOrder.canDown;
  // 枠のシートとページの情報は、開いたときのページでだけ出す（ページが替わったら出さない）
  const sheetFor = frameSheet && railSummary && frameSheet.id === railSummary.id ? frameSheet.kind : null;
  const infoOpen = railSummary !== undefined && infoFor === railSummary.id;
  // フォルダを削除するときの確認の言葉（中のページの数。読み込んである分）。ヘッダーの「…」と一覧の行の「…」の両方で使う
  const folderDeleteInfo = (id: string): { title: string; count: number } | null => {
    const page = list.pages.find((item) => item.id === id);
    if (page?.kind !== "folder") return null;
    return { title: page.title, count: list.pages.length - withoutPageTree(list.pages, id).length - 1 };
  };
  const deleteFolder = railIsFolder && railSummary ? folderDeleteInfo(railSummary.id) : null;
  // 右上の「…」（リンクで共有・書き出し・履歴・複製・移動・ページの情報・削除）。操作の前に、開いているページのまだ届いていない変更を保存する
  // 「…」の「AI の文を灰色で見せる」（この端末の表示だけ。PageEditor が本文に当てる）
  const aiGray = useAiGray();
  const menu = usePageMenu({
    page: attached,
    current: () => attachedRef.current,
    onDuplicated: (copy, stillOpen) => {
      api.pageCreated(copy.id, copy.title, copy.kind, copy.parent, copy.page);
      if (stillOpen) router.push(`/p/${copy.id}`);
    },
    onDeleted: (id, stillOpen) => {
      api.pageRemoved(id);
      // 最後に開いたページの cookie が消したページを指していても、`/` はサーバーで確かめて新しいページへ移す
      if (stillOpen) router.push("/");
    },
    openSheet: (sheet, owner) => (sheet === "share" ? share.open(owner) : history.open(owner)),
    focusMore,
    goToGoogleDocsBatch: (path) => router.push(path),
    extras: railIsFolder ? { folder: true } : { move: canFolder || canOrder, pageInfo: railSummary !== undefined, aiGray },
    // 「移動…」はシート、「ページの情報」は右下のポップオーバー。開いたときのページの id で持つ
    onLocal: (item: PageMenuLocalItem) => {
      if (item === AI_GRAY_ITEM) {
        setAiGray(!aiGray);
        return;
      }
      const id = railSummary?.id;
      if (!id) return;
      if (item === "page-info") setInfoFor(id);
      else setFrameSheet({ kind: "move", id });
    },
  });
  const closeFrameSheet = useCallback(() => setFrameSheet(null), []);
  const closeInfo = useCallback(() => setInfoFor(null), []);

  // 「写真」のパネルの中身（閉じている間も mount したまま、上げている途中の写真を保つ）
  const photos =
    photoPageId && photosBody && !settings ? (
      <PagePhotos
        pageId={photoPageId}
        images={pageImages}
        srcOf={imageAssetPath}
        body={photosBody}
        // 閉じている間は読まない（出したときに読む）
        open={photosShown}
        panel={{ onClose: () => closePanel("photos"), drag: !narrow }}
        narrow={narrow}
        // 狭い画面ではパネル（全画面）からページへ戻って、入れた写真を見せる
        onInserted={narrow ? () => setPanelFor(null) : undefined}
        onUploadingChange={setPhotosUploading}
      />
    ) : undefined;

  return (
    <FrameContext.Provider value={frame}>
      <div ref={frameRoot} data-docs-app-root="" data-docs-shared-ui="" style={{ position: "fixed", inset: 0 }}>
        <EditorShell
          windowControls={windowControls}
          sidebarOpen={sidebarOpen}
          railOpen={railShown}
          pageOpen={pageShown}
          photosOpen={photosShown}
          // 左下の「設定」の直リンク。押すとすぐ設定の一覧（メニューは無い。オーナー決定 2026-11-06）
          settings={{
            current: pathname === "/settings" || pathname.startsWith("/settings/"),
            account: { ...initial.me, current: pathname === "/account", onOpen: () => router.push("/account") },
            onOpen: () => router.push("/settings"),
          }}
          toolbar={editorBar && narrow ? <ShellMobileToolbar {...editorBar} compact /> : undefined}
          rail={
            railSummary ? (
              <InfoPanel
                page={railPage}
                aiSteps={aiSteps?.ownerId === railId ? aiSteps : null}
                placement={narrow ? undefined : { at: layout.dockOf("ai") ?? "right", open: true, onOpenChange: noop }}
                onClose={() => closePanel("ai")}
                onPagesChanged={onAiPagesChanged}
              />
            ) : undefined
          }
          page={railSummary ? <PagePanel flow={flow?.ownerId === railId ? flow : null} onClose={() => closePanel("page")} drag={!narrow} /> : undefined}
          photos={photos}
          dock={{
            wide: !narrow,
            docks: layout.docks,
            fit: layout.fit,
            widths: layout.widths,
            onWidth: layout.setWidth,
            peek: layout.peek,
            onPeek: layout.setPeek,
            onMove: layout.move,
            onResize: layout.resize,
            side: sideId ? <SidePage key={sideId} id={sideId} refresh={sideRefresh} onSwap={() => void swapSide()} onClose={closeSide} /> : undefined,
            onDropPage: (id, where) => (where === "side" ? openSide(id) : select(id)),
            onDropSide: () => void swapSide(),
          }}
          corner={
            railSummary && !railIsFolder ? (
              <PageInfo
                summary={railSummary}
                text={railPage?.text ?? null}
                lang={railPage?.lang ?? railSummary.lang}
                recordingSec={list.details?.id === railSummary.id ? list.details.recordingSec : null}
                open={infoOpen}
                onToggle={() => setInfoFor(infoOpen ? null : railSummary.id)}
                onClose={closeInfo}
                onInfo={() => setFrameSheet({ kind: "capacity", id: railSummary.id })}
              />
            ) : undefined
          }
          sidebar={
            <ShellSidebar
              items={items}
              currentId={currentId}
              onSelect={select}
              onToggleFolder={toggleFolder}
              onCollapse={collapse}
              onDrop={searching ? undefined : (dragId, target) => void dropPage(dragId, target)}
              canDrop={canDrop}
              newMenu={{
                open: newMenuOpen,
                onToggle: () => setNewMenuOpen((open) => !open),
                onClose: () => setNewMenuOpen(false),
                onPick: pickNew,
                inside: hereFolder ? { title: hereFolder.title } : null,
              }}
              search={{
                open: search.open,
                value: search.value,
                onOpen: () => setSearch({ open: true, value: "" }),
                onClose: () => setSearch({ open: false, value: "" }),
                onChange: (value) => setSearch({ open: true, value }),
              }}
              listEnd={
                searching ? (
                  <p role="status" style={SEARCH_NOTE_STYLE}>
                    {searchMessage(found, hits.length)}
                  </p>
                ) : list.next !== null ? (
                  <div ref={setSentinel} aria-hidden="true" style={{ height: 1 }} />
                ) : null
              }
              side={!narrow && currentId ? { id: sideId ?? undefined, onOpen: openSide } : undefined}
              onDeleteRow={(id) => rowDelete.open(id, rowTitle(id))}
              panel={!narrow}
            />
          }
          header={
            <ShellHeader
              title={title}
              // 場所（パンくず）はデスクトップだけ。狭い画面は左の「‹ 行き先」が親（新しいページは入れ先のフォルダ）を示す
              location={narrow ? undefined : location}
              onOpenLocation={openFromLocation}
              plain={settings !== undefined}
              tools={editorBar && !narrow && !railIsFolder ? <ShellTools {...editorBar} compact /> : undefined}
              // 狭い画面のページ・設定の画面で戻る（URL へ。`/` か親のページ）。デスクトップの一覧は右上の「一覧を出す」（閉じているパネルの組）
              back={narrow && !sidebarOpen ? { label: backTo ? backTo.title || "無題" : "一覧", onClick: () => router.push(backTo ? `/p/${backTo.id}` : "/") } : undefined}
              status={attached ? headerStatus(attached.status, publishing.status) : publishing.status}
              trailing={
                <>
                  {attached && SAVE_FAILURES.has(attached.status) && (
                    <span data-save-note="" style={MENU_NOTE_STYLE}>
                      {SAVE_STATUS_TEXT[attached.status]}
                    </span>
                  )}
                  {/* 左の一覧のドラッグが届かなかったときの一言（「移動…」のシートを開いているあいだは、シートの中に出す） */}
                  {sheetFor !== "move" && (orderNote ?? moveNote) && (
                    <span role="alert" style={MENU_NOTE_STYLE}>
                      {orderNote ?? moveNote}
                    </span>
                  )}
                  {folderNote && (
                    <span role="alert" style={MENU_NOTE_STYLE}>
                      {folderNote}
                    </span>
                  )}
                  {menu.note && (
                    <span role="alert" style={MENU_NOTE_STYLE}>
                      {menu.note}
                    </span>
                  )}
                  {swapNote !== null && swapNote === currentId && attached?.status !== "saved" && (
                    <span role="alert" style={MENU_NOTE_STYLE}>
                      {SWAP_UNSAVED_TEXT}
                    </span>
                  )}
                  {restoredNote && (
                    <span aria-hidden="true" style={RESTORED_NOTE_STYLE}>
                      {restoredNote}
                    </span>
                  )}
                  {/* 版に戻した（エディタの中身が替わった）ことを読み上げる。いつも置いておく（出したときに読まれるように） */}
                  <span role="status" style={VISUALLY_HIDDEN_STYLE}>
                    {restoredNote}
                  </span>
                </>
              }
              panels={{ closed: closedPanels, onOpen: openPanel }}
              more={menu.more}
              publish={publishing.publish}
            />
          }
          overlay={
            <>
              {menu.confirm ? (
                <DeleteConfirm {...menu.confirm} folder={deleteFolder} />
              ) : rowDelete.confirm ? (
                <DeleteConfirm {...rowDelete.confirm} folder={folderDeleteInfo(rowDelete.confirm.id)} />
              ) : share.sheet ? (
                <ShareSheet {...share.sheet} />
              ) : history.sheet ? (
                <HistorySheet {...history.sheet} now={now} />
              ) : sheetFor === "move" && railSummary ? (
                <MoveSheet
                  folder={canFolder ? { value: railSummary.parent, options: railFolders, note: moveNote, onPick: (parent) => void movePage(railSummary.id, parent) } : undefined}
                  order={
                    canOrder
                      ? { ...railOrder, busy: ordering, note: orderNote, onUp: () => void moveOrder(railSummary.id, "up"), onDown: () => void moveOrder(railSummary.id, "down") }
                      : undefined
                  }
                  onClose={closeFrameSheet}
                />
              ) : sheetFor === "capacity" ? (
                <CapacitySheet onClose={closeFrameSheet} />
              ) : null}
              {publishing.overlay}
            </>
          }
        >
          {children}
        </EditorShell>
      </div>
    </FrameContext.Provider>
  );
}
