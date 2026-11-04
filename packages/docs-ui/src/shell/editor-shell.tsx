import { useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
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
   */
  sidebarOpen: boolean;
  /**
   * 右のレールを出しているか。デスクトップでは右の列、900px 未満では下からのシート（ShellRail に onClose を渡したとき。
   * 渡さなければヘッダーの下の全画面）。
   */
  railOpen: boolean;
  /** 公開のシートなど、枠の上に重ねるもの（PublishSheet）。.es-root の中に出る。 */
  overlay?: ReactNode;
  /** ページの中央（ShellPage や RecordingStart）。 */
  children: ReactNode;
  /** 本文の列の右下に小さく置くもの（文字数とページの情報。ShellPageInfo）。渡さなければ出さない。 */
  corner?: ReactNode;
};

/**
 * editor の枠。ws グリッド（一覧｜ヘッダー＋ページ＋レール）。<900px では、一覧・ページ・レールのどれかひとつを全画面で出す。
 * 状態はすべて props（呼ぶ側が持つ）。DocsHost・通信・保存は持たない。
 * 祖先に data-docs-app-root と data-docs-shared-ui が要る（shell.css は共通 UI の root の中だけに効く）。
 * 最初のフォーカス先は「本文へ移動」（skip link。普段は見えず、フォーカスで現れる）。押すと本文（main）へフォーカスを移す。
 * URL の # は変えない（呼ぶ側の hash の route を壊さない）。
 */
export function EditorShell({ sidebar, header, rail, toolbar, sidebarOpen, railOpen, overlay, children, corner }: EditorShellProps) {
  const view: ShellView = sidebarOpen ? "list" : railOpen && rail ? "rail" : "page";
  const main = useRef<HTMLElement | null>(null);
  const skip = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    main.current?.focus();
  };
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
              {rail ? (
                <div
                  ref={(node) => {
                    node?.toggleAttribute("inert", !railOpen);
                  }}
                  className="es-rail-presence"
                  hidden={!railOpen}
                  aria-hidden={!railOpen ? true : undefined}
                >
                  {rail}
                </div>
              ) : null}
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
