import { useRef, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { ShellBrand } from "./brand";
import { SHELL_PANELS, clampDockWidth, dockPanels, panelShares, type ShellDockSide, type ShellPanelId } from "./dock-layout";
import { ShellDockExtras, panelHeight, panelTop, useBoxHeight, useDockPeekDismiss, type EditorShellDock } from "./dock";
import { Icon } from "./icons";
import { ShellListBrandContext, ShellViewContext, type ShellView } from "./view";

/** 本文（main）の id。skip link の移動先。 */
const SHELL_MAIN_ID = "es-main";

/** 左下の「設定」（押すとすぐ設定の一覧へ。メニューは無い。オーナー決定 2026-11-06）。パネルの配置に関係なく、いつも画面の左下。 */
export type ShellSettingsLink = {
  /** 未処理の招待の数（0 より大きいときだけバッジ）。 */
  badge?: number;
  /** 設定の画面を開いているとき（aria-current="page"）。 */
  current?: boolean;
  onOpen: () => void;
};

export type EditorShellProps = {
  /** ホストのウィンドウボタン用に、画面上端を空ける。 */
  windowControls?: boolean;
  /** 一覧のパネル（ShellSidebar）。 */
  sidebar: ReactNode;
  /** ヘッダー（ShellHeader）。 */
  header: ReactNode;
  /** 「AIと作る」のパネル（ShellRail）。閉じている間も状態を保つため、ページがある限り渡し続ける。 */
  rail?: ReactNode;
  /** 「ページ」のパネル（dock を渡したとき）。見出しは ShellPanelHead。 */
  page?: ReactNode;
  /** 「写真」のパネル（dock を渡したとき。PagePhotos の panel）。 */
  photos?: ReactNode;
  /** 900px 未満で下端に出る道具の帯（ShellMobileToolbar）。 */
  toolbar?: ReactNode;
  /** 一覧のパネルを出しているか。900px 未満では一覧が全画面（ページとほかのパネルは隠れる）。 */
  sidebarOpen: boolean;
  /**
   * 「AIと作る」を出しているか。900px 未満ではヘッダーの下の全画面（ShellRail に onClose を渡したときは下からのシート）。
   * dock を渡したときは、どのドックにいても。
   */
  railOpen: boolean;
  /** 「ページ」「写真」のパネルを出しているか（dock を渡したとき）。 */
  pageOpen?: boolean;
  photosOpen?: boolean;
  /** 左下の「設定」。渡さなければ出さない。 */
  settings?: ShellSettingsLink;
  /** 公開のシートなど、枠の上に重ねるもの（PublishSheet）。.es-root の中に出る。 */
  overlay?: ReactNode;
  /** ページの中央（ShellPage や RecordingStart）。 */
  children: ReactNode;
  /** 本文の列の右下に小さく置くもの（文字数とページの情報。ShellPageInfo）。渡さなければ出さない。 */
  corner?: ReactNode;
  /**
   * パネルの配置（設計 §5.5・#311）。渡さなければ今までと同じ DOM（一覧｜ヘッダー＋ページ＋レール）。
   * 渡すと、一覧・AI・ページ・写真を左右のドックに縦に並べ、右に読むだけのページを並べる。
   * パネルはいつも木の同じ位置に描き、置き場所は絶対配置の位置で決める（作り直さないので、AI の会話・書きかけ・実行中の依頼、
   * 一覧の検索・写真の上げている途中は、動かしても・幅が 900px をまたいでも残る）。
   */
  dock?: EditorShellDock;
};

/** grid の列: 左のドック｜境目｜メイン｜境目｜右のページ｜境目｜右のドック（境目は幅 0）。 */
function dockColumns(dock: EditorShellDock): string {
  const { fit } = dock;
  return `${fit.left}px 0px minmax(0,1fr) 0px ${fit.side}px 0px ${fit.right}px`;
}

function SettingsBar({ settings }: { settings: ShellSettingsLink }) {
  return (
    <div className="es-setbar">
      <button type="button" className="es-sb-me" aria-current={settings.current ? "page" : undefined} onClick={settings.onOpen}>
        <Icon name="gear" />
        <b>設定</b>
        {settings.badge && settings.badge > 0 ? (
          <em className="es-badge" aria-label={`未処理の招待 ${settings.badge} 件`}>
            {settings.badge}
          </em>
        ) : null}
      </button>
    </div>
  );
}

/**
 * editor の枠。アプリ名はいつも画面の左上端、設定はいつも左下（どちらもパネルの配置に関係なく）。
 * 一覧が枠の左上にあるとき（左のドックの一番上・900px 未満の一覧の画面・dock なしで一覧を出しているとき）は、アプリ名を一覧の上の 1 行の左に出し
 * （「Editor …… 検索 ＋ しまう」の 1 行）、枠のアプリ名の帯は出さない。それ以外は枠が左上端にアプリ名の帯を重ねる。
 * <900px では、一覧・ページ・ほかのパネルのどれかひとつを全画面で出す。
 * 状態はすべて props（呼ぶ側が持つ）。DocsHost・通信・保存は持たない。
 * 祖先に data-docs-app-root と data-docs-shared-ui が要る（shell.css は共通 UI の root の中だけに効く）。
 * 最初のフォーカス先は「本文へ移動」（skip link。普段は見えず、フォーカスで現れる）。押すと本文（main）へフォーカスを移す。
 * URL の # は変えない（呼ぶ側の hash の route を壊さない）。
 */
export function EditorShell({ windowControls, sidebar, header, rail, page, photos, toolbar, sidebarOpen, railOpen, pageOpen, photosOpen, settings, overlay, children, corner, dock }: EditorShellProps) {
  const main = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const ws = useRef<HTMLDivElement | null>(null);
  const skip = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    main.current?.focus();
  };
  const wide = dock?.wide === true;
  // 出しているパネル。デスクトップのパネルの配置では、どちらかのドックに置いてあるものだけ
  const placed = (id: ShellPanelId) => !wide || dock === undefined || dock.docks.left.some((item) => item.id === id) || dock.docks.right.some((item) => item.id === id);
  const shown: Record<ShellPanelId, boolean> = {
    list: sidebarOpen && placed("list"),
    ai: railOpen && Boolean(rail) && placed("ai"),
    page: Boolean(dock && pageOpen && page) && placed("page"),
    photos: Boolean(dock && photosOpen && photos) && placed("photos"),
  };
  const view: ShellView = shown.list ? "list" : shown.ai || shown.page || shown.photos ? "rail" : "page";
  useDockPeekDismiss(root, wide ? dock?.peek : null, dock?.onPeek);
  const wsHeight = useBoxHeight(ws, wide);

  const brand = (
    <div className="es-brandbar">
      <ShellBrand />
    </div>
  );

  if (!dock) {
    // 一覧を出しているあいだ、一覧は枠の左上（デスクトップでは左の列、900px 未満では全画面）
    const brandInList = shown.list;
    return (
      <div
        className="es-root"
        data-editor-shell
        data-window-controls={windowControls ? "true" : undefined}
        data-sidebar={sidebarOpen ? "open" : "closed"}
        data-rail={shown.ai ? "open" : "closed"}
        data-view={view}
        data-left={sidebarOpen ? "dock" : "none"}
      >
        <ShellViewContext.Provider value={view}>
          <a className="es-skip" href={`#${SHELL_MAIN_ID}`} onClick={skip}>
            本文へ移動
          </a>
          {brandInList ? null : brand}
          <div className="es-ws">
            <ShellListBrandContext.Provider value={brandInList}>{sidebar}</ShellListBrandContext.Provider>
            <div className="es-doc">
              {header}
              <div className="es-dbody">
                <main ref={main} id={SHELL_MAIN_ID} className="es-canvas" tabIndex={-1}>
                  {children}
                </main>
                {rail ? (
                  <div
                    ref={(node) => {
                      node?.toggleAttribute("inert", !shown.ai);
                    }}
                    className="es-rail-presence"
                    hidden={!shown.ai}
                    aria-hidden={!shown.ai ? true : undefined}
                  >
                    {rail}
                  </div>
                ) : null}
                {corner ? <div className="es-corner">{corner}</div> : null}
              </div>
              {toolbar}
            </div>
          </div>
          {settings && <SettingsBar settings={settings} />}
          {overlay}
        </ShellViewContext.Provider>
      </div>
    );
  }

  const panels = dockPanels(dock.docks, shown);
  const shares = { left: panelShares(panels.left), right: panelShares(panels.right) };
  const stateOf = (side: ShellDockSide) => (!dock.fit.strip[side] ? "open" : dock.peek === side ? "peek" : "strip");
  const peekWidth = (side: ShellDockSide) => `${clampDockWidth(side, dock.widths[side])}px`;
  // 左のドックにパネルがある（細い列でない）とき、アプリ名と設定の段はその幅。無ければ中央のヘッダーの左を空ける
  const leftDock = wide && panels.left.length > 0 && !dock.fit.strip.left;
  // 一覧が枠の左上にある（デスクトップでは左のドックの一番上、900px 未満では一覧の画面）。一覧が上の 1 行の左にアプリ名を出し、アプリ名の段も使う
  const brandInList = wide ? leftDock && panels.left[0]?.id === "list" : shown.list;
  const wsStyle: CSSProperties | undefined = wide ? { gridTemplateColumns: dockColumns(dock), gridTemplateRows: "var(--es-header) minmax(0,1fr)" } : undefined;
  const rootStyle = wide ? ({ "--es-left-w": `${dock.fit.left}px` } as CSSProperties) : undefined;
  const content: Record<ShellPanelId, ReactNode> = { list: sidebar, ai: rail, page, photos };

  const pane = (id: ShellPanelId) => {
    if (!content[id]) return null;
    const side: ShellDockSide | null = panels.left.some((item) => item.id === id) ? "left" : panels.right.some((item) => item.id === id) ? "right" : null;
    const share = side ? shares[side].find((item) => item.id === id) : undefined;
    const index = side ? shares[side].findIndex((item) => item.id === id) : -1;
    const style: CSSProperties | undefined =
      wide && side && share
        ? ({
            // 細い列から上に重ねて開いているときは本人の幅
            width: stateOf(side) === "peek" ? peekWidth(side) : `${dock.fit[side]}px`,
            top: panelTop(side, share.start, id === "list" && brandInList),
            height: panelHeight(side, share.share, id === "list" && brandInList),
            "--es-peek-w": peekWidth(side),
          } as CSSProperties)
        : undefined;
    const open = shown[id];
    return (
      <div
        key={id}
        ref={(node) => {
          node?.toggleAttribute("inert", !open);
        }}
        className="es-pn"
        data-panel={id}
        hidden={!open}
        aria-hidden={!open ? true : undefined}
        data-dock={wide && side ? side : undefined}
        data-state={wide && side ? stateOf(side) : undefined}
        data-index={wide && side ? index : undefined}
        style={style}
      >
        {id === "list" ? <ShellListBrandContext.Provider value={brandInList}>{content[id]}</ShellListBrandContext.Provider> : content[id]}
      </div>
    );
  };

  return (
    <div
      ref={root}
      className="es-root"
      data-editor-shell
      data-window-controls={windowControls ? "true" : undefined}
      data-layout="dock"
      data-wide={wide ? "true" : "false"}
      data-sidebar={shown.list ? "open" : "closed"}
      data-rail={shown.ai ? "open" : "closed"}
      data-view={view}
      data-left={wide ? (leftDock ? "dock" : "none") : shown.list ? "dock" : "none"}
      style={rootStyle}
    >
      <ShellViewContext.Provider value={view}>
        <a className="es-skip" href={`#${SHELL_MAIN_ID}`} onClick={skip}>
          本文へ移動
        </a>
        {brandInList ? null : brand}
        <div ref={ws} className="es-ws" style={wsStyle}>
          {SHELL_PANELS.map(pane)}
          <div className="es-doc">
            {header}
            <div className="es-dbody">
              <main ref={main} id={SHELL_MAIN_ID} className="es-canvas" tabIndex={-1}>
                {children}
              </main>
              {corner ? <div className="es-corner">{corner}</div> : null}
            </div>
            {toolbar}
          </div>
          {wide ? <ShellDockExtras host={root} dock={dock} shown={shown} height={wsHeight} /> : null}
        </div>
        {settings && <SettingsBar settings={settings} />}
        {overlay}
      </ShellViewContext.Provider>
    </div>
  );
}

