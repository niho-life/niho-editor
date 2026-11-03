import { useContext, useId, useSyncExternalStore, type ReactNode } from "react";
import { Icon } from "./icons";
import { ShellSheet } from "./sheet";
import type { ShellIconName } from "./types";
import { ShellViewContext } from "./view";

/** shell.css のスマホの境目（@media (max-width:900px)）と同じ。 */
const NARROW_QUERY = "(max-width:900px)";

const narrowQuery = (): MediaQueryList | null =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY) : null;

function subscribeNarrow(onChange: () => void): () => void {
  const query = narrowQuery();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

const isNarrow = () => narrowQuery()?.matches ?? false;
const isNarrowOnServer = () => false;

export type ShellRailProps = {
  children: ReactNode;
  /** レールの名前。900px 未満のシートでは、ダイアログの名前と見出しにもなる。 */
  label?: string;
  /**
   * 渡すと、900px 未満ではレールを下からのシートにする（ShellSheet と同じ: dialog、Esc・幕・「閉じる」で onClose、
   * Tab は中で回る、外は inert、閉じたら開く前の要素へフォーカスを戻す）。渡さなければ従来どおりヘッダーの下の全画面。#43。
   * 一覧が全画面のあいだ（EditorShell の view が list。レールは隠れている）はシートにしない。
   */
  onClose?: () => void;
};

/**
 * 右のレール。節は横の罫線で区切るだけ。上の節（手順・ページ設定）は押すと開閉し、下の「AIと作る」が残りの高さを使う
 * （最低 220px。開いている節は中でスクロールする）。
 */
export function ShellRail({ children, label = "このページの設定と AI", onClose }: ShellRailProps) {
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, isNarrowOnServer);
  const view = useContext(ShellViewContext);
  // 900px 未満で一覧が全画面のあいだ（view=list）は、レールを含むページ全体が隠れている。見えないダイアログで外を inert にしない
  // EditorShell は閉じたレールも state 保持のため mount する。dialog にするのは実際に rail view の間だけ。
  // 枠の外（view=null）は従来どおり onClose を持つ narrow rail を sheet として扱う。
  if (narrow && onClose && (view === null || view === "rail")) {
    return (
      <ShellSheet label={label} onClose={onClose} className="es-sheet--rail">
        <div className="es-sh-hd">
          <h2>{label}</h2>
          <span className="es-sp" />
          <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={onClose}>
            閉じる
          </button>
        </div>
        <div id="es-rail" className="es-rail">
          {children}
        </div>
      </ShellSheet>
    );
  }
  return (
    <aside id="es-rail" className="es-rail" aria-label={label}>
      {children}
    </aside>
  );
}

export type ShellRailSectionProps = {
  title: string;
  icon?: ShellIconName;
  /** 閉じているときだけ見出しの右に出す一言（例: 「自分だけ」）。 */
  summary?: string;
  /** 開閉できない節（「AIと作る」）は fill を付ける。残りの高さを使う。 */
  fill?: boolean;
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
};

export function ShellRailSection({ title, icon, summary, fill, open = true, onToggle, children }: ShellRailSectionProps) {
  const body = useId();
  const heading = (
    <>
      {icon && <Icon name={icon} />}
      {title}
    </>
  );
  return (
    <section className={`es-cd${open ? " es-cd--open" : ""}${fill ? " es-cd--fill" : ""}`}>
      <h2 className="es-ch-h">
        {fill || !onToggle ? (
          <span className="es-ch es-ch--static">{heading}</span>
        ) : (
          <button type="button" className="es-ch" aria-expanded={open} aria-controls={body} onClick={onToggle}>
            {heading}
            {!open && summary ? <span className="es-sum">{summary}</span> : null}
            <span className="es-cv" aria-hidden="true">
              ▾
            </span>
          </button>
        )}
      </h2>
      <div id={body} className="es-cb" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
