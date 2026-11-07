import { Icon } from "./icons";
import { ShellDestPill, ShellInvite, ShellRole, ShellSection, ShellSettingsPage, ShellTable } from "./settings-parts";
import type { ShellDest } from "./types";

export type AccountRole = {
  id: string;
  name: string;
  detail: string;
  /** 持っている役割は、出せる発信先の印を右に出す。 */
  dest?: ShellDest;
  /** 持っていない役割（体験ホスト）は薄く出し、申し込みの導線を置く。 */
  off?: { action: string };
};

export type AccountLink = {
  id: string;
  provider: string;
  /** 提供者のアバターに出す 1 文字（写真は持ち込まない）。 */
  initial: string;
  experience: string;
  pages: number;
};

export type AccountPageProps = {
  account: { name: string; initial: string; email: string };
  roles: AccountRole[];
  /** 未処理の記事連携の招待。 */
  invite?: { initial: string; name: string; detail: string } | null;
  links: AccountLink[];
  onManage?: () => void;
  onApply?: (roleId: string) => void;
  onAccept?: () => void;
  onDecline?: () => void;
};

/**
 * 役割とつながり（モック v6 の V.account）。NIHO アカウント・役割・記事連携（招待の受ける／辞退と、使える体験の表）。
 * 役割は NIHO から毎回読むだけで、editor は保存しない（設計 §10）。
 */
export function AccountPage({ account, roles, invite, links, onManage, onApply, onAccept, onDecline }: AccountPageProps) {
  return (
    <ShellSettingsPage title="役割とつながり">
      <ShellSection title="NIHO アカウント">
        <div className="es-acct">
          <span className="es-av es-av--lg" aria-hidden="true">
            {account.initial}
          </span>
          <div>
            <b>{account.name}</b>
            <code>{account.email}</code>
          </div>
          <span className="es-sp" />
          <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={onManage}>
            NIHOで管理
            <Icon name="ext" />
          </button>
        </div>
      </ShellSection>
      <ShellSection title="役割">
        {roles.map((role) => (
          <ShellRole
            key={role.id}
            name={role.name}
            detail={role.detail}
            off={Boolean(role.off)}
            aside={
              role.off ? (
                <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={() => onApply?.(role.id)}>
                  {role.off.action}
                  <Icon name="ext" />
                </button>
              ) : role.dest ? (
                <ShellDestPill dest={role.dest} />
              ) : undefined
            }
          />
        ))}
      </ShellSection>
      <ShellSection title="記事連携">
        {invite && <ShellInvite initial={invite.initial} name={invite.name} detail={invite.detail} onAccept={onAccept} onDecline={onDecline} />}
        <ShellTable
          label="記事連携の提供者"
          columns={["提供者", "使える体験", "関連付けたページ"]}
          rows={links.map((link) => ({
            id: link.id,
            cells: [
              <div key="p" className="es-tbl-t">
                <span className="es-av" aria-hidden="true">
                  {link.initial}
                </span>
                <b>{link.provider}</b>
              </div>,
              <span key="e" className="es-tbl-mute">
                {link.experience}
              </span>,
              <span key="n" className="es-tbl-mute">
                {link.pages}
              </span>,
            ],
          }))}
        />
      </ShellSection>
    </ShellSettingsPage>
  );
}
