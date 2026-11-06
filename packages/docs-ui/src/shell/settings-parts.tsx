import { useId, type MouseEvent, type ReactNode } from "react";
import { Icon } from "./icons";
import type { ShellDest } from "./types";

/* 設定系ページ（発信先・自分のサイト・役割とつながり・設定）の共有部品。props 駆動。 */

export const SHELL_DEST_PILL: Record<ShellDest, string> = { exp: "experience.niho.life", niho: "niho.life", site: "自分のサイト" };

/** `<a href>` のまま、普通のクリックだけを onNavigate へ回す（修飾キー・中クリックはブラウザに任せる）。 */
export function linkTo(href: string, onNavigate: (href: string) => void) {
  return {
    href,
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onNavigate(href);
    },
  };
}

/** 設定系ページの枠。EditorShell の children に入れる。h1 と、あれば戻るボタン・小さな印（pill）。 */
export function ShellSettingsPage({
  title,
  back,
  up,
  pill,
  nav,
  children,
}: {
  title: string;
  back?: { label: string; onClick: () => void };
  /** 見出しの上の「← 設定」のような戻るリンク（設定の一覧から入るページ。href 付きで、普通のクリックは onNavigate）。 */
  up?: { label: string; href: string; onNavigate: (href: string) => void };
  pill?: ReactNode;
  /** ページ内の節へ飛ぶ帯（設定）。 */
  nav?: { id: string; label: string }[];
  children: ReactNode;
}) {
  return (
    <div className="es-page">
      {up && (
        <a className="es-back" {...linkTo(up.href, up.onNavigate)}>
          <Icon name="back" />
          {up.label}
        </a>
      )}
      {back || pill ? (
        <div className="es-page-hd">
          {back && (
            <button type="button" className="es-ib" aria-label={back.label} onClick={back.onClick}>
              <Icon name="back" />
            </button>
          )}
          <h1>{title}</h1>
          {pill}
        </div>
      ) : (
        <h1>{title}</h1>
      )}
      {nav && (
        <nav className="es-secnav" aria-label={`${title}の項目`}>
          {nav.map((item) => (
            <button key={item.id} type="button" onClick={() => document.getElementById(item.id)?.scrollIntoView({ block: "start" })}>
              {item.label}
            </button>
          ))}
        </nav>
      )}
      {children}
    </div>
  );
}

/** 節。見出しは小さな淡色の h2。title を省くと見出しなし（発信先の一覧）。 */
export function ShellSection({ id, title, children }: { id?: string; title?: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="es-sect" id={id} aria-labelledby={title ? headingId : undefined}>
      {title && <h2 id={headingId}>{title}</h2>}
      {children}
    </section>
  );
}

/** 左に項目名・右に値の組（dl）。 */
export function ShellKvs({ children }: { children: ReactNode }) {
  return <dl className="es-kvs">{children}</dl>;
}
export function ShellKv({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** スイッチ。押すと onChange。名前は label（aria-label）。 */
export function ShellToggle({ checked, onChange, label }: { checked: boolean; onChange?: (next: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`es-toggle${checked ? " es-toggle--on" : ""}`} onClick={() => onChange?.(!checked)} />
  );
}

/** 選択チップの並び（ひとつだけ選ぶ）。選んだものは淡色面＋濃い緑文字。 */
export function ShellPills<T extends string>({ label, options, value, onChange }: { label: string; options: { id: T; label: string }[]; value: T; onChange?: (id: T) => void }) {
  return (
    <div className="es-pills" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" className={option.id === value ? "es-on" : undefined} aria-pressed={option.id === value} onClick={() => onChange?.(option.id)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** ラベル付きの入力（1 行）。 */
export function ShellField({ label, value, onChange, multiline, error }: { label: string; value: string; onChange?: (value: string) => void; multiline?: boolean; error?: string }) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="es-field">
      <label htmlFor={id}>{label}</label>
      {multiline ? (
        <textarea id={id} className="es-area" value={value} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} onChange={(event) => onChange?.(event.target.value)} />
      ) : (
        <input id={id} className="es-input" value={value} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} onChange={(event) => onChange?.(event.target.value)} />
      )}
      {error && <small id={errorId} className="es-danger">{error}</small>}
    </div>
  );
}

/** 発信先の小さな印（色の四角＋名前）。 */
export function ShellDestPill({ dest, children }: { dest: ShellDest; children?: ReactNode }) {
  return (
    <span className={`es-pill es-pill--${dest}`}>
      <i aria-hidden="true" />
      {children ?? SHELL_DEST_PILL[dest]}
    </span>
  );
}

/** 役割の 1 行。off は持っていない役割（薄く出し、申し込みの導線を右に置く）。 */
export function ShellRole({ name, detail, off, aside }: { name: string; detail: string; off?: boolean; aside?: ReactNode }) {
  return (
    <div className={`es-role${off ? " es-role--off" : ""}`}>
      <div>
        <b>{name}</b>
        <small>{detail}</small>
      </div>
      {aside}
    </div>
  );
}

/** 記事連携の招待（受ける／辞退）。 */
export function ShellInvite({ initial, name, detail, onAccept, onDecline }: { initial: string; name: string; detail: string; onAccept?: () => void; onDecline?: () => void }) {
  return (
    <div className="es-inv">
      <span className="es-av es-av--md" aria-hidden="true">
        {initial}
      </span>
      <div>
        <b>{name}</b>
        <small>{detail}</small>
      </div>
      <div className="es-inv-acts">
        <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label={`${name} の招待を辞退`} onClick={onDecline}>
          辞退
        </button>
        <button type="button" className="es-btn es-btn--primary es-btn--sm" aria-label={`${name} の招待を受ける`} onClick={onAccept}>
          受ける
        </button>
      </div>
    </div>
  );
}

/**
 * 表。900px 未満では 1 行を 1 枚のカードにして、横にはみ出さない（各セルの上に列の名前を出す）。
 * セマンティクスは role で保つ（display を替えても表のまま読み上げられる）。
 * hideHead: 見出しの行を画面に出さない（モックの「このサイトに公開中」）。読み上げには残る。
 */
export function ShellTable({ label, columns, rows, hideHead }: { label: string; columns: string[]; rows: { id: string; cells: ReactNode[] }[]; hideHead?: boolean }) {
  return (
    <table className={hideHead ? "es-tbl es-tbl--nohead" : "es-tbl"} role="table" aria-label={label}>
      <thead role="rowgroup">
        <tr role="row">
          {columns.map((column) => (
            <th key={column} role="columnheader" scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody role="rowgroup">
        {rows.map((row) => (
          <tr key={row.id} role="row">
            {row.cells.map((cell, index) => (
              <td key={columns[index]} role="cell" data-label={hideHead ? undefined : columns[index]}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
