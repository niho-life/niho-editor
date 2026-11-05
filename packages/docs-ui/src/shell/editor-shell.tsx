import { useRef, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { SHELL_FLOAT_HEIGHT, clampDockWidth, type ShellDockSide } from "./dock-layout";
import { ShellDockExtras, ShellSash, dockColumn, useDockPeekDismiss, useFloatInset, type EditorShellDock } from "./dock";
import { ShellViewContext, type ShellView } from "./view";

/** 本文（main）の id。skip link の移動先。 */
const SHELL_MAIN_ID = "es-main";

export type EditorShellProps = {
  /** 左の一覧（ShellSidebar）。 */
  sidebar: ReactNode;
  /** ヘッダー（ShellHeader）。 */
  header: ReactNode;
  /** 右のレール（ShellRail）。閉じている間も状態を保つため、ページがある限り渡し続ける。 */
  rail?: ReactNode;
  /** 900px 未満で下端に出る道具の帯（ShellMobileToolbar）。 */
  toolbar?: ReactNode;
  /**
   * 左の一覧を出しているか。デスクトップでは左の列、900px 未満では一覧が全画面（ページとレールは隠れる）。
   * dock を渡したときは、一覧のパネル（どのドックにいても）を出しているか。
   */
  sidebarOpen: boolean;
  /**
   * 右のレールを出しているか。デスクトップでは右の列、900px 未満では下からのシート（ShellRail に onClose を渡したとき。
   * 渡さなければヘッダーの下の全画面）。dock を渡したときは、AI のパネル（どのドックにいても・浮かせていても）を出しているか。
   */
  railOpen: boolean;
  /** 公開のシートなど、枠の上に重ねるもの（PublishSheet）。.es-root の中に出る。 */
  overlay?: ReactNode;
  /** ページの中央（ShellPage や RecordingStart）。 */
  children: ReactNode;
  /** 本文の列の右下に小さく置くもの（文字数とページの情報。ShellPageInfo）。渡さなければ出さない。 */
  corner?: ReactNode;
  /**
   * 分割ビューとパネルの配置（設計 §5.5）。渡さなければ今までと同じ DOM（一覧｜ヘッダー＋ページ＋レール）。
   * 渡すと、一覧と AI を左右のドック（AI はメインの下にも）に置き、右に読むだけのページを並べる。
   * 一覧と AI はいつも木の同じ位置に描き、置き場所は grid の列で決める（作り直さないので、AI の会話・書きかけ・実行中の依頼、
   * 一覧の検索・写真の上げている途中は、動かしても・幅が 900px をまたいでも残る）。
   */
  dock?: EditorShellDock;
};

/** grid の列: 左のドック｜境目｜メイン｜境目｜右のページ｜境目｜右のドック（境目は幅 0）。 */
function dockColumns(dock: EditorShellDock): string {
  const { fit } = dock;
  return `${fit.left}px 0px minmax(0,1fr) 0px ${fit.side}px 0px ${fit.right}px`;
}

/**
 * editor の枠。ws グリッド（一覧｜ヘッダー＋ページ＋レール）。<900px では、一覧・ページ・レールのどれかひとつを全画面で出す。
 * 状態はすべて props（呼ぶ側が持つ）。DocsHost・通信・保存は持たない。
 * 祖先に data-docs-app-root と data-docs-shared-ui が要る（shell.css は共通 UI の root の中だけに効く）。
 * 最初のフォーカス先は「本文へ移動」（skip link。普段は見えず、フォーカスで現れる）。押すと本文（main）へフォーカスを移す。
 * URL の # は変えない（呼ぶ側の hash の route を壊さない）。
 */
export function EditorShell({ sidebar, header, rail, toolbar, sidebarOpen, railOpen, overlay, children, corner, dock }: EditorShellProps) {
  const view: ShellView = sidebarOpen ? "list" : railOpen && rail ? "rail" : "page";
  const main = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const presence = useRef<HTMLDivElement | null>(null);
  const skip = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    main.current?.focus();
  };
  const wide = dock?.wide === true;
  const aiShown = railOpen && Boolean(rail);
  const listAt: ShellDockSide = dock?.place.list ?? "left";
  const aiAt = dock?.place.ai ?? "right";
  const floating = wide && aiShown && aiAt === "float";
  // 同じドックに 2 つ入ったら、一覧が上（高さの半分まで）・AI が下（残り）
  const stacked = wide && sidebarOpen && aiShown && aiAt === listAt;
  useDockPeekDismiss(root, wide ? dock?.peek : null, dock?.onPeek);
  useFloatInset(root, presence, floating);

  const stateOf = (side: ShellDockSide) => (!dock?.fit.strip[side] ? "open" : dock.peek === side ? "peek" : "strip");
  const peekWidth = (side: ShellDockSide) => `${clampDockWidth(side, dock?.widths[side])}px`;
  const wsStyle: CSSProperties | undefined =
    wide && dock
      ? {
          gridTemplateColumns: dockColumns(dock),
          gridTemplateRows: stacked ? "var(--es-header) fit-content(calc(50% - var(--es-header))) minmax(0,1fr)" : "var(--es-header) 0px minmax(0,1fr)",
        }
      : undefined;
  const listStyle = wide ? ({ gridColumn: dockColumn(listAt), gridRow: stacked ? "1 / 3" : "1 / -1", "--es-peek-w": peekWidth(listAt) } as CSSProperties) : undefined;
  const aiStyle = !wide
    ? undefined
    : aiAt === "float"
      ? ({ "--es-float-open": `${dock?.float?.height ?? SHELL_FLOAT_HEIGHT.default}px` } as CSSProperties)
      : ({ gridColumn: dockColumn(aiAt), gridRow: stacked ? "3 / 4" : "1 / -1", "--es-peek-w": peekWidth(aiAt) } as CSSProperties);
  const float = dock?.float;

  const presenceNode = rail ? (
    <div
      ref={(node) => {
        node?.toggleAttribute("inert", !railOpen);
        presence.current = node;
      }}
      className="es-rail-presence"
      hidden={!railOpen}
      aria-hidden={!railOpen ? true : undefined}
      data-dock={wide ? aiAt : undefined}
      data-state={wide && aiAt !== "float" ? stateOf(aiAt) : undefined}
      data-stack={stacked ? "below" : undefined}
      data-float={floating ? (float?.open ? "open" : "bar") : undefined}
      style={aiStyle}
    >
      {rail}
      {floating && float?.open ? (
        <ShellSash
          className="es-sash--float"
          orientation="horizontal"
          label="AIの高さ"
          value={float.height}
          min={SHELL_FLOAT_HEIGHT.min}
          max={Math.max(SHELL_FLOAT_HEIGHT.min, float.max)}
          defaultValue={SHELL_FLOAT_HEIGHT.default}
          onChange={float.onHeight}
        />
      ) : null}
    </div>
  ) : null;

  if (!dock) {
    return (
      <div className="es-root" data-editor-shell data-sidebar={sidebarOpen ? "open" : "closed"} data-rail={railOpen && rail ? "open" : "closed"} data-view={view}>
        <ShellViewContext.Provider value={view}>
          <a className="es-skip" href={`#${SHELL_MAIN_ID}`} onClick={skip}>
            本文へ移動
          </a>
          <div className="es-ws">
            {sidebar}
            <div className="es-doc">
              {header}
              <div className="es-dbody">
                <main ref={main} id={SHELL_MAIN_ID} className="es-canvas" tabIndex={-1}>
                  {children}
                </main>
                {presenceNode}
                {corner ? <div className="es-corner">{corner}</div> : null}
              </div>
              {toolbar}
            </div>
          </div>
          {overlay}
        </ShellViewContext.Provider>
      </div>
    );
  }

  return (
    <div
      ref={root}
      className="es-root"
      data-editor-shell
      data-layout="dock"
      data-wide={wide ? "true" : "false"}
      data-ai={wide && aiShown ? aiAt : undefined}
      data-sidebar={sidebarOpen ? "open" : "closed"}
      data-rail={railOpen && rail ? "open" : "closed"}
      data-view={view}
    >
      <ShellViewContext.Provider value={view}>
        <a className="es-skip" href={`#${SHELL_MAIN_ID}`} onClick={skip}>
          本文へ移動
        </a>
        <div className="es-ws" style={wsStyle}>
          {/* 一覧のパネル。900px 未満は display:contents（従来どおり一覧そのものが枠の列・全画面になる） */}
          <div
            className="es-pane"
            hidden={!sidebarOpen}
            data-dock={wide ? listAt : undefined}
            data-state={wide ? stateOf(listAt) : undefined}
            style={listStyle}
          >
            {sidebar}
          </div>
          <div className="es-doc">
            {header}
            <div className="es-dbody">
              <main ref={main} id={SHELL_MAIN_ID} className="es-canvas" tabIndex={-1}>
                {children}
              </main>
              {presenceNode}
              {corner ? <div className="es-corner">{corner}</div> : null}
            </div>
            {toolbar}
          </div>
          {wide ? <ShellDockExtras host={root} dock={dock} shown={{ list: sidebarOpen, ai: aiShown }} /> : null}
        </div>
        {overlay}
      </ShellViewContext.Provider>
    </div>
  );
}
