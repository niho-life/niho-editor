import { useId, type ReactNode } from "react";
import { Icon } from "./icons";
import { ShellDestPill, ShellField, ShellKv, ShellKvs, ShellPills, ShellSection, ShellSettingsPage, ShellTable } from "./settings-parts";

/**
 * editor.niho.life の発信先の設定（Issue #41。モック v6 の V.dest・V.site を、Web で本当に出せる形にしたもの）。
 * props 駆動の表示部品で、通信・保存・鍵の受け取りは呼ぶ側（apps/editor-web）が持つ。
 *
 * モックのままの `DestinationsPage`・`SitePage`（destinations.tsx）は、モックの写しとしてギャラリーに残している。
 * こちらは本人のサイトが 2 つ以上あるとき・接続を作るとき・鍵を 1 回だけ見せるときを扱う。
 *
 * 鍵の扱い: 平文は「作った・再発行した直後の 1 回だけ」`issuedKey` に渡ってきて、閉じると消える。
 * それ以外の場所に出るのは伏せ字（`ek_••••••••` ＋末尾 4 文字）だけ。URL・ログ・保存には出さない。
 */

export type EditorDestinationMode = "api" | "wordpress" | "ghost";

/** NIHO が運営する面（役割で自動に出る）。 */
export type EditorDestinationFace = {
  id: "exp" | "niho";
  label: string;
  /** 宣言から読んだ URL。読めなければ null。 */
  host: string | null;
  path: string | null;
  /** 誰向けか（旅行者向け · 英語）。 */
  who: string;
  /** 出せる理由（ライター・NIHO アカウント）。 */
  role: string;
  available: boolean;
  /** role＝役割が無い、unavailable＝宣言が無い・読めない。 */
  reason: "role" | "unavailable" | null;
  published: number;
};

/** 接続した本人のサイト。 */
export type EditorDestinationSite = {
  /** 接続の id（画面の行を開くのに使う）。 */
  id: string;
  handle: string;
  host: string;
  path: string;
  mode: EditorDestinationMode;
  published: number;
};

export type EditorSiteKeyView = {
  id: string;
  /** `ek_••••••••` ＋末尾 4 文字。 */
  masked: string;
  createdAt: string;
  active: boolean;
};

/** 作った・再発行した直後の鍵。平文はここだけに来る（閉じると消える）。 */
export type EditorIssuedKey = { masked: string; plaintext: string };

export type EditorSitePublished = {
  pageId: string;
  title: string;
  url: string;
  status: "published" | "updated" | "limited" | "stopped";
};

export type EditorAddSiteDraft = { mode: EditorDestinationMode; handle: string; siteUrl: string; path: string };

export type EditorDestinationsPageProps = {
  /** 通信の結果の一言（`role="status"` で読み上げる）。 */
  status: string;
  busy: boolean;
  faces: EditorDestinationFace[];
  sites: EditorDestinationSite[];
  onOpenSite: (id: string) => void;
  /** 「発信先を追加」の下書き（null のときはボタンだけ）。 */
  draft: EditorAddSiteDraft | null;
  onAdd: () => void;
  onDraft: (draft: EditorAddSiteDraft) => void;
  onCancelAdd: () => void;
  onCreate: () => void;
  /** 作った直後の鍵（1 回だけ）。 */
  issuedKey: EditorIssuedKey | null;
  onCopyKey: () => void;
  onCloseKey: () => void;
  /** 見出しの上の「← 設定」（設定の一覧へ戻る）。 */
  onNavigate: (href: string) => void;
};

export type EditorSitePageProps = {
  status: string;
  busy: boolean;
  handle: string;
  host: string;
  path: string;
  mode: EditorDestinationMode;
  apiUrl: string;
  articleUrl: string;
  keys: EditorSiteKeyView[];
  published: EditorSitePublished[];
  /** 編集している URL の形（null のときは表示だけ）。 */
  urlDraft: { host: string; path: string } | null;
  onBack: () => void;
  onCopyApi: () => void;
  onEditUrl: () => void;
  onUrlDraft: (draft: { host: string; path: string }) => void;
  onCancelUrl: () => void;
  onSaveUrl: () => void;
  onMode: (mode: EditorDestinationMode) => void;
  onExport: () => void;
  /** 鍵の再発行（確かめてから）。 */
  confirmingKey: boolean;
  onAskKey: () => void;
  onCancelKey: () => void;
  onRotateKey: () => void;
  issuedKey: EditorIssuedKey | null;
  onCopyKey: () => void;
  onCloseKey: () => void;
  /** 接続の解除（確かめてから）。 */
  confirmingDisconnect: boolean;
  onAskDisconnect: () => void;
  onCancelDisconnect: () => void;
  onDisconnect: () => void;
};

const STACK = { display: "grid", gap: 12 } as const;
const ROW = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 } as const;
const NOTE = { margin: 0, fontSize: 12.5, lineHeight: 1.6, color: "var(--ed-ink-sub)" } as const;
const STATUS = { margin: 0, minHeight: 18, fontSize: 12.5, fontWeight: 600, color: "var(--ed-ink-sub)" } as const;
const CARD = { display: "grid", gap: 12, padding: "14px 16px", border: "1px solid var(--ed-line)", borderRadius: 16 } as const;
const EMPTY = { margin: 0, fontSize: 13, color: "var(--ed-ink-mute)" } as const;
const SUBHEAD = { fontSize: 13, fontWeight: 600 } as const;
const BUSY = { opacity: 0.4, cursor: "progress" } as const;

export const EDITOR_DESTINATIONS_TEXT = {
  modes: { api: "公開APIで受け取る", wordpress: "WordPress", ghost: "Ghost" },
  modeHints: { api: "どのサイトでも · JSON と Markdown", wordpress: "サイトのURLとアプリケーションパスワード", ghost: "Admin API キー" },
  states: { published: "公開中", updated: "更新あり", limited: "限定公開", stopped: "公開をやめた" },
  notConnected: "未接続",
  noRole: "この発信先に出す役割がありません",
  unavailable: "いまは公開できません（発信先の条件を読めません）",
  addTitle: "発信先を追加",
  addHint: "自分のサイト · WordPress · Ghost",
  pushLater: "WordPress・Ghost への送信は、まだ動きません（受け取り方として保存するだけです）",
  keyOnce: "この鍵はこの 1 回だけ出ます。コピーして、サイトの側に入れてください（あとからは見られません）",
  keyConfirm: "鍵を再発行すると、いまの鍵では読めなくなります。サイトの側を新しい鍵に替えてください。",
  disconnectConfirm: "接続を解除すると、鍵はすべて使えなくなり、このサイトに公開中のページは「公開をやめた」になります（ページは残ります）。",
  photos: "公開のときに複製されます（取り込み時に発信先がコピーします）",
  handleFixed: "handle は作ったあと変えられません（公開 API の URL に入ります）",
  exportHint: "この発信先に公開した（やめたものも含む）ページの、最後の公開版です",
  noPublished: "このサイトにはまだ公開していません",
} as const;

/** 鍵を 1 回だけ見せる箱（コピーと「閉じる」だけ。閉じると平文は画面から消える）。 */
function IssuedKeyBox({ issued, onCopy, onClose }: { issued: EditorIssuedKey; onCopy: () => void; onClose: () => void }) {
  const id = useId();
  return (
    <div style={CARD} role="group" aria-labelledby={id}>
      <h3 id={id} style={SUBHEAD}>
        新しい鍵
      </h3>
      <p style={NOTE}>{EDITOR_DESTINATIONS_TEXT.keyOnce}</p>
      <ShellKvs>
        <ShellKv label="鍵">
          <code>{issued.plaintext}</code>
        </ShellKv>
      </ShellKvs>
      <div style={ROW}>
        <button type="button" className="es-btn es-btn--primary es-btn--sm" aria-label="新しい鍵をコピー" onClick={onCopy}>
          コピー
        </button>
        <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label="新しい鍵を閉じる" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}

function card(key: string, kind: "exp" | "niho" | "site", body: ReactNode, aside: ReactNode) {
  return (
    <li key={key} className={`es-dcard es-dcard--${kind}`}>
      <i aria-hidden="true" />
      <div>{body}</div>
      {aside}
    </li>
  );
}

/** 発信先（モック v6 の V.dest）。NIHO の面は役割で自動、本人のサイトは「発信先を追加」。 */
export function EditorDestinationsPage(props: EditorDestinationsPageProps) {
  const { busy, faces, sites, draft, issuedKey } = props;
  const busyProps = busy ? { "aria-disabled": true as const, style: BUSY } : {};
  return (
    <ShellSettingsPage title="発信先" up={{ label: "設定", href: "/settings", onNavigate: props.onNavigate }}>
      <p role="status" style={STATUS}>
        {props.status}
      </p>
      {issuedKey && <IssuedKeyBox issued={issuedKey} onCopy={props.onCopyKey} onClose={props.onCloseKey} />}
      <ShellSection>
        <ul className="es-dl">
          {faces.map((face) =>
            card(
              face.id,
              face.id,
              <>
                <b>{face.label}</b>
                {face.host !== null && (
                  <code>
                    {face.host}/{face.path}
                  </code>
                )}
                <div className="es-dcard-m">
                  <span>{face.who}</span>
                  {face.available ? <span className="es-tag-ok">✓ {face.role}</span> : <span className="es-tag-no">{EDITOR_DESTINATIONS_TEXT.notConnected}</span>}
                  <span>公開中 {face.published}</span>
                </div>
              </>,
              face.available && face.host !== null ? (
                <a className="es-btn es-btn--quiet es-btn--sm" href={`https://${face.host}`} target="_blank" rel="noopener noreferrer">
                  {face.host}
                  <Icon name="ext" />
                </a>
              ) : (
                <span className="es-tag-no">{face.reason === "role" ? EDITOR_DESTINATIONS_TEXT.noRole : EDITOR_DESTINATIONS_TEXT.unavailable}</span>
              ),
            ),
          )}
          {sites.map((site) =>
            card(
              site.id,
              "site",
              <>
                <b>{site.host}</b>
                <code>
                  {site.host}/{site.path}
                </code>
                <div className="es-dcard-m">
                  <span>{EDITOR_DESTINATIONS_TEXT.modes[site.mode]}</span>
                  <span className="es-tag-ok">✓ 接続済み</span>
                  <span>公開中 {site.published}</span>
                </div>
              </>,
              <button type="button" className="es-btn es-btn--outline es-btn--sm" aria-label={`${site.host} の設定`} {...busyProps} onClick={() => !busy && props.onOpenSite(site.id)}>
                設定
              </button>,
            ),
          )}
          {draft === null && (
            <li>
              <button type="button" className="es-dcard es-dcard--add" {...busyProps} onClick={() => !busy && props.onAdd()}>
                <i aria-hidden="true" />
                <span>
                  <b>{EDITOR_DESTINATIONS_TEXT.addTitle}</b>
                  <code>{EDITOR_DESTINATIONS_TEXT.addHint}</code>
                </span>
              </button>
            </li>
          )}
        </ul>
      </ShellSection>
      {draft !== null && (
        <AddSiteForm draft={draft} busy={busy} onDraft={props.onDraft} onCancel={props.onCancelAdd} onCreate={props.onCreate} />
      )}
    </ShellSettingsPage>
  );
}

/** 発信先を追加（受け取り方・handle・サイトの URL・記事の前に付く path）。 */
function AddSiteForm({
  draft,
  busy,
  onDraft,
  onCancel,
  onCreate,
}: {
  draft: EditorAddSiteDraft;
  busy: boolean;
  onDraft: (draft: EditorAddSiteDraft) => void;
  onCancel: () => void;
  onCreate: () => void;
}) {
  const headingId = useId();
  const busyProps = busy ? { "aria-disabled": true as const, style: BUSY } : {};
  return (
    <ShellSection>
      <div style={STACK} role="group" aria-labelledby={headingId}>
        <h3 id={headingId} style={SUBHEAD}>
          {EDITOR_DESTINATIONS_TEXT.addTitle}
        </h3>
        <ShellKvs>
          <ShellKv label="受け取り方">
            <ShellPills
              label="受け取り方"
              value={draft.mode}
              onChange={(mode: EditorDestinationMode) => onDraft({ ...draft, mode })}
              options={[
                { id: "api" as const, label: EDITOR_DESTINATIONS_TEXT.modes.api },
                { id: "wordpress" as const, label: EDITOR_DESTINATIONS_TEXT.modes.wordpress },
                { id: "ghost" as const, label: EDITOR_DESTINATIONS_TEXT.modes.ghost },
              ]}
            />
            <span className="es-kvs-note">{EDITOR_DESTINATIONS_TEXT.modeHints[draft.mode]}</span>
          </ShellKv>
        </ShellKvs>
        <div className="es-form">
          <ShellField label="handle（公開 API の URL に入る）" value={draft.handle} onChange={(handle) => onDraft({ ...draft, handle })} />
          <ShellField label="サイトの URL（https）" value={draft.siteUrl} onChange={(siteUrl) => onDraft({ ...draft, siteUrl })} />
          <ShellField label="記事の前に付く path（空でもよい）" value={draft.path} onChange={(path) => onDraft({ ...draft, path })} />
        </div>
        <p style={NOTE}>{EDITOR_DESTINATIONS_TEXT.handleFixed}</p>
        {draft.mode !== "api" && <p style={NOTE}>{EDITOR_DESTINATIONS_TEXT.pushLater}</p>}
        <div style={ROW}>
          <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label="発信先を追加するのをやめる" onClick={onCancel}>
            やめる
          </button>
          <button type="button" className="es-btn es-btn--primary es-btn--sm" aria-label="この発信先を追加" {...busyProps} onClick={() => !busy && onCreate()}>
            追加
          </button>
        </div>
      </div>
    </ShellSection>
  );
}

/** 自分のサイト（モック v6 の V.site）。受け取り方・URL・公開中の一覧・接続の解除。 */
export function EditorSitePage(props: EditorSitePageProps) {
  const { busy, keys, published, urlDraft, issuedKey } = props;
  const busyProps = busy ? { "aria-disabled": true as const, style: BUSY } : {};
  const active = keys.find((key) => key.active);
  return (
    <ShellSettingsPage title={props.host} back={{ label: "発信先に戻る", onClick: props.onBack }} pill={<ShellDestPill dest="site" />}>
      <p role="status" style={STATUS}>
        {props.status}
      </p>
      {issuedKey && <IssuedKeyBox issued={issuedKey} onCopy={props.onCopyKey} onClose={props.onCloseKey} />}

      <ShellSection title="受け取り方">
        <ShellKvs>
          <ShellKv label="公開API">
            <code>{props.apiUrl}</code>
            <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label="公開APIの URL をコピー" onClick={props.onCopyApi}>
              コピー
            </button>
          </ShellKv>
          <ShellKv label="handle">
            <code>{props.handle}</code>
            <span className="es-kvs-note">{EDITOR_DESTINATIONS_TEXT.handleFixed}</span>
          </ShellKv>
          <ShellKv label="鍵">
            <code>{active ? active.masked : "—"}</code>
            {!props.confirmingKey && (
              <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label="鍵を再発行" {...busyProps} onClick={() => !busy && props.onAskKey()}>
                再発行
              </button>
            )}
            {keys.length > 1 && <span className="es-kvs-note">失効した鍵 {keys.length - 1}</span>}
          </ShellKv>
          <ShellKv label="送り方">
            <ShellPills
              label="送り方"
              value={props.mode}
              onChange={props.onMode}
              options={[
                { id: "api" as const, label: EDITOR_DESTINATIONS_TEXT.modes.api },
                { id: "wordpress" as const, label: EDITOR_DESTINATIONS_TEXT.modes.wordpress },
                { id: "ghost" as const, label: EDITOR_DESTINATIONS_TEXT.modes.ghost },
              ]}
            />
          </ShellKv>
          <ShellKv label="書き出し">
            <button type="button" className="es-btn es-btn--outline es-btn--sm" {...busyProps} onClick={() => !busy && props.onExport()}>
              Markdown + 写真（zip）
            </button>
            <span className="es-kvs-note">{EDITOR_DESTINATIONS_TEXT.exportHint}</span>
          </ShellKv>
        </ShellKvs>
        {props.confirmingKey && (
          <div style={CARD}>
            <p style={NOTE} role="alert">
              {EDITOR_DESTINATIONS_TEXT.keyConfirm}
            </p>
            <div style={ROW}>
              <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label="鍵の再発行をやめる" onClick={props.onCancelKey}>
                やめる
              </button>
              <button type="button" className="es-btn es-btn--primary es-btn--sm" aria-label="鍵を再発行する" {...busyProps} onClick={() => !busy && props.onRotateKey()}>
                再発行する
              </button>
            </div>
          </div>
        )}
        {props.mode !== "api" && <p style={NOTE}>{EDITOR_DESTINATIONS_TEXT.pushLater}</p>}
      </ShellSection>

      <ShellSection title="URL">
        <ShellKvs>
          <ShellKv label="記事">
            <code>{props.articleUrl}</code>
            {urlDraft === null && (
              <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label="URL の形を編集" {...busyProps} onClick={() => !busy && props.onEditUrl()}>
                編集
              </button>
            )}
          </ShellKv>
          <ShellKv label="写真">
            <span>{EDITOR_DESTINATIONS_TEXT.photos}</span>
          </ShellKv>
        </ShellKvs>
        {urlDraft !== null && (
          <div style={STACK}>
            <div className="es-form">
              <ShellField label="ホスト" value={urlDraft.host} onChange={(host) => props.onUrlDraft({ ...urlDraft, host })} />
              <ShellField label="記事の前に付く path（空でもよい）" value={urlDraft.path} onChange={(path) => props.onUrlDraft({ ...urlDraft, path })} />
            </div>
            <p style={NOTE}>URL の形を変えると、次の「更新を公開」から新しい URL になります（出した公開版は変わりません）。</p>
            <div style={ROW}>
              <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label="URL の形の編集をやめる" onClick={props.onCancelUrl}>
                やめる
              </button>
              <button type="button" className="es-btn es-btn--primary es-btn--sm" aria-label="URL の形を保存" {...busyProps} onClick={() => !busy && props.onSaveUrl()}>
                保存
              </button>
            </div>
          </div>
        )}
      </ShellSection>

      <ShellSection title="このサイトに公開中">
        {published.length === 0 ? (
          <p style={EMPTY}>{EDITOR_DESTINATIONS_TEXT.noPublished}</p>
        ) : (
          <ShellTable
            label="このサイトに公開中のページ"
            columns={["ページ", "URL", "状態"]}
            rows={published.map((page) => ({
              id: page.pageId,
              cells: [
                <div key="t" className="es-tbl-t">
                  <span className="es-tbl-ph" aria-hidden="true" />
                  <b>{page.title}</b>
                </div>,
                <code key="u">{page.url}</code>,
                <span key="s" className={page.status === "stopped" ? "es-tbl-mute" : undefined}>
                  {EDITOR_DESTINATIONS_TEXT.states[page.status]}
                </span>,
              ],
            }))}
          />
        )}
      </ShellSection>

      <ShellSection>
        {props.confirmingDisconnect ? (
          <div style={CARD}>
            <p style={NOTE} role="alert">
              {EDITOR_DESTINATIONS_TEXT.disconnectConfirm}
            </p>
            <div style={ROW}>
              <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label="接続の解除をやめる" onClick={props.onCancelDisconnect}>
                やめる
              </button>
              <button type="button" className="es-danger" aria-label="接続を解除する" {...busyProps} onClick={() => !busy && props.onDisconnect()}>
                解除する
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="es-danger" {...busyProps} onClick={() => !busy && props.onAskDisconnect()}>
            接続を解除
          </button>
        )}
      </ShellSection>
    </ShellSettingsPage>
  );
}
