import { useRef, type ReactNode } from "react";
import { Icon } from "./icons";
import { ShellMenu } from "./menu";
import { StatusDot } from "./status-dot";
import type { ShellButtonTone, ShellMenuItem, ShellStatusState } from "./types";

export type ShellHeaderProps = {
  /** 狭い幅でヘッダーに出る題名。 */
  title: string;
  /** 一覧がしまわれているときの「一覧を出す」ボタン。 */
  showListButton?: boolean;
  onToggleList?: () => void;
  /** 道具の帯（ShellTools）。 */
  tools?: ReactNode;
  status?: { state: ShellStatusState; tip: string };
  publish?: { label: string; tone: ShellButtonTone; menu?: boolean; onClick?: () => void } | null;
  /** 状態・公開ボタンのかわりに出す操作（録音からの「やめる」など）。 */
  trailing?: ReactNode;
  /** 右のレール（AIと作る）。 */
  railOpen?: boolean;
  onToggleRail?: () => void;
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
 * ヘッダーは1段: [一覧] [道具] … [状態] [公開] [レール] […]。
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
      <span className="es-ttl">{props.title || "無題"}</span>
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
