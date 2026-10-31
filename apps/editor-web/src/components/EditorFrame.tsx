"use client";

import "niho-ui/styles/tokens.css";
import "niho-docs-ui/styles/tokens.css";
import "niho-docs-ui/styles/shell.css";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { PageKind, PageLang, PageSummary, StepStatus } from "@niho/editor-store";
import { EditorShell, ShellHeader, ShellMobileToolbar, ShellSheet, ShellSidebar, ShellTools, shellAccountItems, type NewPageKind, type ShellToolAction } from "niho-docs-ui/shell";
import type { PageChromeTools } from "niho-docs-ui/page/PageChrome";
import { folderExportUrl, movePageOrderRequest, recordPageOpenRequest } from "@/lib/folder-client";
import { listPagesRequest, movePageRequest } from "@/lib/pages-client";
import { headerStatus } from "@/lib/save-status";
import { useShortcuts } from "@/lib/shortcuts";
import { arrangeSidebarItems, folderOptions, orderNeighbours, recentRows, reorderedPages, searchRows, withoutPageTree, type SidebarPublication } from "@/lib/sidebar-items";
import { usePageHistory } from "@/lib/use-page-history";
import { clickDownload, usePageMenu, type AttachedPage } from "@/lib/use-page-menu";
import { usePageSearch, type PageSearchState } from "@/lib/use-page-search";
import { useFolderFields } from "@/lib/use-folder-fields";
import { usePageShare } from "@/lib/use-page-share";
import { useSearchShortcut } from "@/lib/use-search-shortcut";
import { HistorySheet } from "./HistorySheet";
import { InfoPanel } from "./InfoPanel";
import { usePagePublish } from "./PagePublish";
import { BUSY_STYLE } from "./sheet-parts";
import { ShareSheet } from "./ShareSheet";

export type { AttachedPage };

/** shell.css と同じ境目（これ以下は一覧・ページのどちらかを全画面で出す）。 */
const NARROW_QUERY = "(max-width: 900px)";

/** 「最近」に出す件数（サーバーの `RECENT_LIMIT` と同じ）。 */
const RECENT_SHOWN = 10;

const PAGE_PATH = /^\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** 設定系のページ（本人の行のメニューの項目と、ヘッダーの題名）。 */
const SETTINGS_ROUTES = [
  { path: "/destinations", item: "dest", title: "発信先" },
  { path: "/account", item: "account", title: "役割とつながり" },
  { path: "/settings", item: "settings", title: "設定" },
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

/** 開いたページの、一覧の行に無いこと（情報パネルに出す）。 */
export type OpenedDetails = {
  /** 録音の長さ（秒。録音ページでない・分からなければ null）。 */
  recordingSec?: number | null;
};

/** 手順（#37）のサブページ。帯（./PageSteps.tsx）が読んだ run から渡す。 */
export type FrameStepPage = { id: string; title: string; stepStatus: StepStatus | null };

/** ページの画面から枠（一覧・ヘッダー）へ知らせること。 */
export type EditorFrameApi = {
  narrow: boolean;
  /** 開いたページ。一覧に読み込んでいない古いページでも、ヘッダーに題名を出し、保存したら一覧の上に足す。 */
  pageOpened: (page: PageSummary, details?: OpenedDetails) => void;
  pageTitleChanged: (id: string, title: string) => void;
  /** 情報パネルで変えた言語を保存した。一覧（読み込んだ分と開いたページ）の言語を替える。 */
  pageLangChanged: (id: string, lang: PageLang) => void;
  /** 保存した。一覧の上へ動かし、時刻を今にする。 */
  pageSaved: (id: string) => void;
  /** 新しいページを作った（複製を含む）。一覧の上に足す。種類は既定で note。 */
  pageCreated: (id: string, title: string, kind?: PageKind) => void;
  /** ページをゴミ箱へ入れた。一覧から、そのページと子孫（読み込んである分）を外す。 */
  pageRemoved: (id: string) => void;
  /**
   * 手順が進んだ（#37）。一覧の行の印（stepStatus）を替え、まだ読み込んでいないサブページは親の下に足す。
   * 並びは arrangeSidebarItems が作った順に揃える（段階の順になるよう、足す行の createdAt を段階の順にする）。
   */
  stepPagesChanged: (parentId: string, steps: readonly FrameStepPage[]) => void;
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
  /** 公開のシートを開く（ページを開いている画面だけで出る）。 */
  openPublish: () => void;
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
  pageRemoved: noop,
  stepPagesChanged: noop,
  attachPage: () => noop,
  openPublish: noop,
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
function DeleteConfirm(props: { busy: boolean; error: string | null; onConfirm: () => void; onCancel: () => void }) {
  const { busy } = props;
  return (
    <ShellSheet label="ページの削除" onClose={props.onCancel}>
      <div className="es-sh-hd">
        <h2>このページを削除しますか？</h2>
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

/**
 * editor の枠（一覧＋ヘッダー＋ページ）。見た目は niho-docs-ui の shell（#48）。ここは状態と移動だけを持つ。
 * - 一覧は最初の区切りをサーバーから受け、末尾が近づいたら続きを読む。
 * - 900px 以下では `/` が一覧の画面。ページと設定は全画面で、ヘッダーの左のボタンで一覧を出す。
 * - ヘッダーの右上は、開いているページ（`attachPage` で登録されたもの）の状態の丸（いつも「自分だけ」＋保存の状態）と、
 *   「…」（リンクで共有・書き出し・履歴・複製・削除。src/lib/use-page-menu.ts・use-page-share.ts・use-page-history.ts）。
 *   まだ作っていないページでは「…」を出さない。削除の確認・共有・履歴は ShellSheet で overlay に出す。
 * - ショートカット（設計 §11）: ⌘N 新しいページ、⌘K 検索、⌘⇧P 公開のシート（⌘S はページ、⌘/ は本文が持つ）。
 * - ヘッダーの「このページの設定と AI」で右のレールに情報パネル（./InfoPanel.tsx）を出す。保存したページ（`/p/{id}`）だけで、
 *   まだ作っていないページ（`/p/new`）・録音から・設定系の画面ではボタンを出さない。デスクトップではページを替えても開いたまま
 *   （モック v6 と同じ。画面の移動でレールを閉じない）、狭い画面（900px 以下）は全画面のレールで、開いたページでだけ出す
 *   （一覧から別のページを開いたら閉じる。閉じるのはヘッダーの同じボタン）。
 */
export function EditorFrame({ initial, children }: { initial: FrameInitial; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrowNow, () => initial.initialNarrow);

  const [list, setList] = useState<ListState>({ pages: initial.pages, next: initial.next, opened: null, details: null, gone: new Set() });
  const [now, setNow] = useState(initial.now);
  const [collapsed, setCollapsed] = useState(false);
  // 閉じているフォルダ（木の段。開いているのが既定）
  const [closedFolders, setClosedFolders] = useState<ReadonlySet<string>>(() => new Set());
  // フォルダへ入れられなかったときの一言（情報パネルのフォルダの下）
  const [moveNote, setMoveNote] = useState<string | null>(null);
  // 「最近」（サーバーが読んだ分を、この画面で開いたページで前に出す）
  const [recent, setRecent] = useState<PageSummary[]>(initial.recent);
  const [recentOpen, setRecentOpen] = useState(true);
  // 並べ替えが届かなかったときの一言と、送っているあいだ
  const [orderNote, setOrderNote] = useState<string | null>(null);
  const [ordering, setOrdering] = useState(false);
  // 狭い画面で一覧を出している path（path が変われば閉じる）
  const [listFor, setListFor] = useState<string | null>(null);
  // 情報パネル: デスクトップで開いているか（ページを替えても持つ）と、狭い画面で開いている path（path が変われば閉じる）
  const [railOpenWide, setRailOpenWide] = useState(false);
  const [railFor, setRailFor] = useState<string | null>(null);
  // 情報パネルの「ページ設定」の節を開いているか（ページを替えても持つ）
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [meOpen, setMeOpen] = useState(false);
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
  // 版に戻して開き直したページ。そのページが登録し直したとき、フォーカスが外れていたら「…」へ戻す
  const refocusRef = useRef<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const currentId = PAGE_PATH.exec(pathname)?.[1];
  const settings = SETTINGS_ROUTES.find((route) => pathname === route.path || pathname.startsWith(`${route.path}/`));
  const sidebarOpen = narrow ? pathname === "/" || listFor === pathname : !collapsed;

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
        // 「最近」はこの画面でも前に出す（サーバーにも記録する。届かなくても画面は止めない）
        setRecent((current) => [page, ...current.filter((item) => item.id !== page.id)].slice(0, RECENT_SHOWN));
        void recordPageOpenRequest(page.id).catch(() => undefined);
      },
      pageTitleChanged: (id, title) =>
        setList((current) => ({
          ...current,
          pages: current.pages.map((page) => (page.id === id ? { ...page, title } : page)),
          opened: current.opened?.id === id ? { ...current.opened, title } : current.opened,
        })),
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
      pageCreated: (id, title, kind = "note") => {
        const at = new Date().toISOString();
        // 作ったばかりのページは公開していない
        const page: PageSummary = { id, kind, title, lang: "ja", parent: null, stepStatus: null, sortOrder: 0, createdAt: at, updatedAt: at, publication: null };
        setList((current) => ({ ...current, pages: toTop(current.pages, page) }));
      },
      registerPageSaver: (saveNow) => {
        pageSaver.current = saveNow;
        return () => {
          if (pageSaver.current === saveNow) pageSaver.current = null;
        };
      },
      registerTools: (next) => setTools(next),
      pageRemoved: (id) => {
        setRemovedTick((tick) => tick + 1);
        setList((current) => {
          const pages = withoutPageTree(current.pages, id);
          const kept = new Set(pages.map((page) => page.id));
          const gone = new Set([...current.gone, id, ...current.pages.filter((page) => !kept.has(page.id)).map((page) => page.id)]);
          return { ...current, pages, gone, opened: current.opened && gone.has(current.opened.id) ? null : current.opened };
        });
      },
      stepPagesChanged: (parentId, steps) =>
        setList((current) => {
          const known = new Map(current.pages.map((page) => [page.id, page]));
          const parent = known.get(parentId);
          let moved = false;
          const pages = current.pages.map((page) => {
            const step = steps.find((item) => item.id === page.id);
            if (!step || page.stepStatus === step.stepStatus) return page;
            moved = true;
            return { ...page, stepStatus: step.stepStatus };
          });
          const at = Date.now();
          const added = steps
            // サブページがゴミ箱に入っている段階（stepStatus が null）の行は作らない。実行の記録（attempt）は残るので
            // 再読み込みのあとに run から届くが、押しても 404 のページへ行くだけ。作り直しの導線は帯が持つ
            .filter((step) => step.stepStatus !== null && !known.has(step.id) && !current.gone.has(step.id))
            .map((step, index): PageSummary => {
              const created = new Date(at + index).toISOString();
              return {
                id: step.id,
                kind: "step",
                title: step.title,
                lang: parent?.lang ?? "ja",
                parent: parentId,
                stepStatus: step.stepStatus,
                // 手順のサブページは段の順（作った順）に並ぶので、手動の並びは持たない
                sortOrder: 0,
                createdAt: created,
                updatedAt: created,
                publication: null,
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
    }),
    [],
  );
  const frame = useMemo<EditorFrameApi>(() => ({ narrow, ...api }), [narrow, api]);

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

  // 右上の「…」（リンクで共有・書き出し・履歴・複製・削除）。操作の前に、開いているページのまだ届いていない変更を保存する
  const menu = usePageMenu({
    page: attached,
    current: () => attachedRef.current,
    onDuplicated: (copy, stillOpen) => {
      api.pageCreated(copy.id, copy.title, copy.kind);
      if (stillOpen) router.push(`/p/${copy.id}`);
    },
    onDeleted: (id, stillOpen) => {
      api.pageRemoved(id);
      // 最後に開いたページの cookie が消したページを指していても、`/` はサーバーで確かめて新しいページへ移す
      if (stillOpen) router.push("/");
    },
    openSheet: (sheet, owner) => (sheet === "share" ? share.open(owner) : history.open(owner)),
    focusMore,
  });
  const restoredNote = history.notice && history.notice.id === currentId ? history.notice.text : "";

  // 打つたびにサーバーで探す（題名と本文）。検索語が空のあいだは、ふつうの一覧のまま
  const searching = search.open && search.value.trim() !== "";
  const found = usePageSearch(search.open ? search.value : "", { refresh: removedTick });
  const hits = useMemo(() => found.results.filter((hit) => !list.gone.has(hit.id)), [found.results, list.gone]);
  const items = useMemo(
    () => (searching ? searchRows(hits, now) : arrangeSidebarItems(list.pages, { now, collapsed: closedFolders })),
    [searching, hits, list.pages, now, closedFolders],
  );
  const recentItems = useMemo(() => recentRows(recent, now), [recent, now]);
  const toggleFolder = useCallback(
    (id: string) =>
      setClosedFolders((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );

  const select = (id: string) => {
    if (id === currentId) setListFor(null);
    else router.push(`/p/${id}`);
  };

  const pickNew = (kind: NewPageKind) => {
    setNewMenuOpen(false);
    router.push(kind === "recording" ? "/p/new?from=recording" : "/p/new");
  };

  const selectAccount = (item: string) => {
    setMeOpen(false);
    const route = SETTINGS_ROUTES.find((candidate) => candidate.item === item);
    if (route) {
      router.push(route.path);
      return;
    }
    if (item === "logout") {
      // 結果に関わらずログインの画面へ。この画面の状態（一覧など）を残さないよう、読み込み直す
      void fetch("/auth/logout", { method: "POST", credentials: "same-origin" })
        .catch(() => undefined)
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- 読み込み直すため
        .finally(() => window.location.assign("/auth/login"));
    }
  };

  const opened = currentId ? (list.pages.find((page) => page.id === currentId) ?? (list.opened?.id === currentId ? list.opened : undefined)) : undefined;
  const recordingStart = pathname === "/p/new" && searchParams.get("from") === "recording";
  const title = currentId ? (opened?.title ?? "") : recordingStart ? "録音から" : (settings?.title ?? "");

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
  /** 手動の並びを 1 つ動かす（情報パネルの「並び」）。届いたら一覧を読み直さず、行の `sortOrder` を入れ替える。 */
  const moveOrder = useCallback(
    async (id: string, move: "up" | "down") => {
      setOrderNote(null);
      setOrdering(true);
      try {
        // 並びはサーバーが 1 から振り直すので、読み込んである行も同じ規則で作り直す（読み直さない）
        if (await movePageOrderRequest(id, move)) setList((current) => ({ ...current, pages: reorderedPages(current.pages, id, move) }));
      } catch {
        setOrderNote("並びを変えられませんでした");
      } finally {
        setOrdering(false);
      }
    },
    [],
  );
  const saveFirst = useCallback(() => pageSaver.current?.() ?? Promise.resolve(true), []);
  /**
   * ページをフォルダへ入れる・出す（情報パネルの「フォルダ」）。先に一覧の行を動かし、届かなければ戻して一言。
   * 本文・revision は変わらないので、開いているエディタには触らない。
   */
  const movePage = useCallback(async (id: string, parent: string | null) => {
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
    } catch {
      const back = before ?? null;
      setList((current) => ({
        ...current,
        pages: current.pages.map((page) => (page.id === id ? { ...page, parent: back } : page)),
        opened: current.opened?.id === id ? { ...current.opened, parent: back } : current.opened,
      }));
      setMoveNote("このフォルダには入れられませんでした");
    }
  }, []);
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
    pageId: openPage?.id ?? null,
    isArticle: openPage?.kind === "article",
    onPublication,
    onNavigate: (path) => router.push(path),
    saveFirst,
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
    else setCollapsed(false);
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
  const collapse = narrow ? (pathname === "/" ? undefined : () => setListFor(null)) : () => setCollapsed(true);

  // 情報パネルのページ: 開いているエディタのページ（作ったばかりで URL がまだ `/p/new` のときも）か、URL のページ。
  // 一覧の行（作成・更新）が分かり、エディタが画面にあるときだけボタンを出す（`/p/new` の作る前・設定系・ページが無い 404 では出さない）。
  // エディタが下書きを読み終えるまでは、レールは出したまま中のボタンは何もしない（ページを替えるたびにレールが消えて戻らないように）
  const railId = attached?.id ?? (attached ? currentId : undefined);
  const railSummary = railId
    ? (list.pages.find((page) => page.id === railId) ?? (list.opened?.id === railId ? list.opened : undefined))
    : undefined;
  const railPage = attached && attached.id !== null && attached.id === railId ? attached : null;
  const railShown = railSummary !== undefined && (narrow ? railFor === pathname : railOpenWide);
  // 入れられるフォルダ（読み込んである上の段のページ）。入れ先が無く、いま上の段にいるなら「フォルダ」の節を出さない
  const railFolders = useMemo(() => (railSummary ? folderOptions(list.pages, railSummary.id) : []), [railSummary, list.pages]);
  // フォルダ（＝子を持つ上の段のページ）でだけ「このフォルダの背景」とフォルダの書き出しを出す。
  // 欄を読むのはレールを開いているあいだだけ（閉じているページで要求を出さない）
  const railIsFolder = railSummary !== undefined && railSummary.parent === null && list.pages.some((page) => page.parent === railSummary.id);
  const folderFields = useFolderFields(railShown && railIsFolder && railSummary ? railSummary.id : null);
  // 「並び」は動かせるときだけ出す（同じ階層に 1 つしか無いページには出さない）
  const railOrder = railSummary ? orderNeighbours(list.pages, railSummary.id) : { canUp: false, canDown: false };
  const toggleRail = () => {
    if (narrow) setRailFor(railShown ? null : pathname);
    else setRailOpenWide(!railShown);
  };

  return (
    <FrameContext.Provider value={frame}>
      <div ref={frameRoot} data-docs-app-root="" data-docs-shared-ui="" style={{ position: "fixed", inset: 0 }}>
        <EditorShell
          sidebarOpen={sidebarOpen}
          railOpen={railShown}
          toolbar={editorBar && narrow ? <ShellMobileToolbar {...editorBar} /> : undefined}
          rail={
            railShown && railSummary ? (
              <InfoPanel
                summary={railSummary}
                page={railPage}
                author={initial.me}
                folders={railFolders.length > 0 || railSummary.parent !== null ? railFolders : undefined}
                folderNote={moveNote}
                onFolder={(parent) => void movePage(railSummary.id, parent)}
                order={
                  railOrder.canUp || railOrder.canDown
                    ? { ...railOrder, busy: ordering, note: orderNote ?? undefined, onUp: () => void moveOrder(railSummary.id, "up"), onDown: () => void moveOrder(railSummary.id, "down") }
                    : undefined
                }
                fields={railIsFolder ? folderFields : undefined}
                onExportFolder={railIsFolder ? () => clickDownload(folderExportUrl(railSummary.id)) : undefined}
                recordingSec={list.details?.id === railSummary.id ? list.details.recordingSec : null}
                open={settingsOpen}
                onToggle={() => setSettingsOpen((open) => !open)}
                onExportMarkdown={menu.exportMarkdown}
                onDelete={menu.askDelete}
              />
            ) : undefined
          }
          sidebar={
            <ShellSidebar
              items={items}
              currentId={currentId}
              onSelect={select}
              onToggleFolder={toggleFolder}
              recent={searching || recentItems.length === 0 ? undefined : { items: recentItems, open: recentOpen, onToggle: () => setRecentOpen((open) => !open) }}
              onCollapse={collapse}
              newMenu={{ open: newMenuOpen, onToggle: () => setNewMenuOpen((open) => !open), onClose: () => setNewMenuOpen(false), onPick: pickNew }}
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
              me={{
                ...initial.me,
                open: meOpen,
                current: settings !== undefined,
                items: shellAccountItems(0, settings?.item, initial.me.name),
                onToggle: () => setMeOpen((open) => !open),
                onClose: () => setMeOpen(false),
                onSelect: selectAccount,
              }}
            />
          }
          header={
            <ShellHeader
              title={title}
              plain={settings !== undefined}
              tools={editorBar && !narrow ? <ShellTools {...editorBar} /> : undefined}
              showListButton={!sidebarOpen}
              onToggleList={() => (narrow ? setListFor(pathname) : setCollapsed(false))}
              status={attached ? headerStatus(attached.status, publishing.status) : publishing.status}
              trailing={
                <>
                  {menu.note && (
                    <span role="alert" style={MENU_NOTE_STYLE}>
                      {menu.note}
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
              railOpen={railShown}
              onToggleRail={railSummary ? toggleRail : undefined}
              more={menu.more}
              publish={publishing.publish}
            />
          }
          overlay={
            <>
              {menu.confirm ? <DeleteConfirm {...menu.confirm} /> : share.sheet ? <ShareSheet {...share.sheet} /> : history.sheet ? <HistorySheet {...history.sheet} now={now} /> : null}
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
