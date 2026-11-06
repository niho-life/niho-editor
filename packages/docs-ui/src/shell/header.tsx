import { useRef, type ReactNode } from "react";
import { SHELL_PANEL_ICON, SHELL_PANEL_NAME, type ShellPanelId } from "./dock-layout";
import { Icon } from "./icons";
import { ShellMenu } from "./menu";
import { StatusDot } from "./status-dot";
import type { ShellButtonTone, ShellMenuItem, ShellStatusState } from "./types";

/** 場所の 1 段（親のフォルダ・親の録音）。押すとそのページへ。 */
export type ShellLocationItem = { id: string; title: string; icon: "folder" | "mic" };

/**
 * 場所（パンくず）。親のフォルダ › 親の録音 だけで、**ページの題名は出さない**（題名は本文の題名にだけ。オーナー決定 2026-11-06）。
 * 上の段のページでは何も描かない。ヘッダー（`es-loc--head`。720px 以下では隠す）と、本文の題名の上（`es-loc--body`。
 * 720px 以下でだけ出す）で同じものを使う。
 */
export function ShellLocation({ items, onOpen, place }: { items: readonly ShellLocationItem[]; onOpen?: (id: string) => void; place: "head" | "body" }) {
  if (items.length === 0) return null;
  return (
    <nav className={`es-loc es-loc--${place}`} aria-label="場所">
      {items.map((item, index) => (
        <span key={item.id} className="es-loc-part">
          {index > 0 && (
            <i className="es-loc-sep" aria-hidden="true">
              ›
            </i>
          )}
          <button type="button" className="es-loc-btn" onClick={() => onOpen?.(item.id)}>
            <Icon name={item.icon} />
            <span>{item.title || "無題"}</span>
          </button>
        </span>
      ))}
    </nav>
  );
}

export type ShellHeaderProps = {
  /** 狭い幅でヘッダーに出る題名（省くと出さない。Web はページ名をヘッダーに出さず、場所だけを出す）。 */
  title?: string;
  /** 場所（親のフォルダ › 親の録音）。720px より広いときにヘッダーの左に出す。 */
  location?: readonly ShellLocationItem[];
  onOpenLocation?: (id: string) => void;
  /** 一覧がしまわれているときの、左端の「一覧を出す」ボタン（900px 未満でページの画面から一覧へ戻る。アプリ名は枠が左上端に出す）。 */
  showListButton?: boolean;
  onToggleList?: () => void;
  /** 道具の帯（ShellTools）。 */
  tools?: ReactNode;
  status?: { state: ShellStatusState; tip: string };
  publish?: { label: string; tone: ShellButtonTone; menu?: boolean; onClick?: () => void } | null;
  /** 状態・公開ボタンのかわりに出す操作（録音からの「やめる」など）。 */
  trailing?: ReactNode;
  /** 右のレール（AIと作る）の開閉のボタン（dock を使わない画面。gallery）。 */
  railOpen?: boolean;
  onToggleRail?: () => void;
  /**
   * 右上の、閉じているパネルを出すボタン（#311）。開いているパネルには × があるので出さない（4 つとも開いていれば何も出ない）。
   * 順は 一覧・AIと作る・ページ・写真（呼ぶ側が closed をその順で渡す）。
   */
  panels?: { closed: readonly ShellPanelId[]; onOpen: (panel: ShellPanelId) => void };
  more?: { open: boolean; items: ShellMenuItem[]; onToggle: () => void; onClose: () => void; onSelect: (id: string) => void };
  /** 設定系のページ用。デスクトップでは罫線を出さない（900px 未満では題名の帯として罫線が出る）。 */
  plain?: boolean;
};

/** 「…」の中身（共有・書き出し・履歴・複製・削除）。 */
export function shellMoreItems(shared?: boolean): ShellMenuItem[] {
  return [
    { id: "share", label: "リンクで共有", icon: "link", hint: shared ? "共有中" : undefined },
    { id: "export", label: "書き出し", icon: "doc", hint: ".md · Google ドキュメント" },
    { id: "history", label: "履歴", icon: "cal" },
    { id: "duplicate", label: "複製", icon: "doc" },
    { id: "delete", label: "削除", icon: "trash", danger: true },
  ];
}

/**
 * ヘッダーは1段: [一覧] [道具] … [状態] [公開] [閉じているパネル] […]。
 * 状態は丸ひとつ（言葉はホバー／フォーカスの吹き出し）。保存ボタンは持たない（自動保存）。
 */
export function ShellHeader(props: ShellHeaderProps) {
  const moreButton = useRef<HTMLButtonElement | null>(null);
  const { publish, more } = props;
  return (
    <header className={props.plain ? "es-dt es-dt--plain" : "es-dt"}>
      {props.showListButton && (
        <button type="button" className="es-ib" aria-label="一覧を出す" title="一覧を出す" onClick={props.onToggleList}>
          <Icon name="side" />
        </button>
      )}
      {props.location && props.location.length > 0 && <ShellLocation items={props.location} onOpen={props.onOpenLocation} place="head" />}
      {props.title === undefined ? (
        // 題名を出さないときも、狭い幅で右の操作を右へ寄せる場所は取る（es-ttl は 900px 未満で伸びる）
        <span className="es-ttl" aria-hidden="true" />
      ) : (
        <span className="es-ttl">{props.title || "無題"}</span>
      )}
      {props.tools}
      <span className="es-sp" />
      {props.status && <StatusDot state={props.status.state} tip={props.status.tip} />}
      {publish && (
        <button
          type="button"
          className={`es-btn es-btn--${publish.tone} es-pubbtn`}
          aria-haspopup={publish.menu ? "dialog" : undefined}
          onClick={publish.onClick}
        >
          {publish.label}
          {publish.menu && <span aria-hidden="true"> ▾</span>}
        </button>
      )}
      {props.trailing}
      {props.panels && props.panels.closed.length > 0 && (
        <span className="es-tg" role="group" aria-label="パネル">
          {props.panels.closed.map((panel) => (
            <button
              key={panel}
              type="button"
              className="es-ib"
              aria-label={`${SHELL_PANEL_NAME[panel]}を出す`}
              title={`${SHELL_PANEL_NAME[panel]}を出す`}
              onClick={() => props.panels?.onOpen(panel)}
            >
              <Icon name={SHELL_PANEL_ICON[panel]} />
            </button>
          ))}
        </span>
      )}
      {props.onToggleRail && (
        <button
          type="button"
          className={`es-ib${props.railOpen ? " es-ib--on" : ""}`}
          aria-label="AIと作る"
          title="AIと作る"
          aria-expanded={props.railOpen ?? false}
          aria-controls="es-rail"
          onClick={props.onToggleRail}
        >
          <Icon name="panel" />
        </button>
      )}
      {more && (
        <span className="es-morewrap">
          <button ref={moreButton} type="button" className="es-ib" aria-label="その他" title="その他" aria-haspopup="menu" aria-expanded={more.open} onClick={more.onToggle}>
            <Icon name="more" />
          </button>
          {more.open && (
            <ShellMenu label="その他" className="es-menu--right" items={more.items} trigger={moreButton} onSelect={more.onSelect} onClose={more.onClose} />
          )}
        </span>
      )}
    </header>
  );
}
