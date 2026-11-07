import { useId, type ReactNode } from "react";
import { Icon } from "./icons";
import { ShellSheet } from "./sheet";
import type { ShellDest } from "./types";

/** 公開のシートの「どこに出すか」の1行。url は {host}/{path}/{slug}。 */
export type PublishDestOption = {
  id: ShellDest;
  label: string;
  /** 誰向けか（旅行者向け · 英語）。 */
  who: string;
  url: string;
  /** 出せる理由（ライター・NIHO アカウント・接続済み）。 */
  role: string;
  /** 接続できていない発信先（本人のサイト）は「接続する ›」になり、選べない。 */
  connected: boolean;
  /** 選べない理由の一言（いまは公開できません など）。connected が false のとき「接続する ›」の代わりに出し、押せない行にする。 */
  note?: string;
};
export type PublishRange = "live" | "unlisted";
export type PublishExtras = { app: boolean; news: boolean; xp: boolean };
export type PublishExperienceSettings = {
  categories: readonly { slug: string; labelEn: string; labelJa: string }[];
  category: string | null;
  candidates: readonly { slug: string; title: string; providerName: string }[];
  related: readonly string[];
  loaded: boolean;
  unavailable?: boolean;
  query: string;
  nextCursor: string | null;
  loadingMore?: boolean;
  onCategory: (slug: string | null) => void;
  onRelated: (slug: string) => void;
  onQuery: (query: string) => void;
  onMore: () => void;
};

/** 公開のシートの URL の欄。slug は初回の公開まで変えられる（公開したあとは固定）。 */
export type PublishSlug = {
  /** slug の前（{host}/{path}/）。 */
  prefix: string;
  value: string;
  /** 初回の公開まで true。false なら URL を見せるだけ。 */
  editable: boolean;
  /** 使えない理由の一言（使われています・使えない文字 など）。 */
  error?: string | null;
  onChange?: (value: string) => void;
};

export type PublishFormProps = {
  /** 公開中の発信先があるか。あれば見出しは「公開の設定」（更新ありなら「更新を公開」）になり、「公開をやめる」が出る。 */
  current?: { updated?: boolean } | null;
  dests: PublishDestOption[];
  picked?: ShellDest;
  /** 選んだ発信先の条件で足りないもの。1つでもあれば公開は押せない。 */
  missing: { id: string; label: string }[];
  range: PublishRange;
  extras: PublishExtras;
  onPick: (dest: ShellDest) => void;
  /** 未接続の発信先の「接続する ›」。 */
  onConnect?: (dest: ShellDest) => void;
  onAddDest?: () => void;
  onRange: (range: PublishRange) => void;
  onExtra: (key: keyof PublishExtras) => void;
  /** 足りないものの「直す」。 */
  onFix: (id: string) => void;
  onPublish: () => void;
  onUnpublish?: () => void;
  onClose: () => void;
  /** 主ボタンの文言。省略すると current から決める（公開する／更新を公開／保存）。発信先を変えるときなどに渡す。 */
  action?: string;
  /** true なら主ボタンを押せない（読み込み中・送っている途中・URL が使えない・することがない）。 */
  submitDisabled?: boolean;
  /** URL の欄。省略すると出さない（足もとの URL だけ）。 */
  slug?: PublishSlug;
  /** NIHO Experience の任意設定。server が候補と現在権限を決める。 */
  experience?: PublishExperienceSettings;
  /** 公開に失敗したときなどの 1 行（role="alert"）。 */
  error?: string | null;
  /**
   * 記事の情報（リード・カバー画像・言語・英語版など。保存は呼ぶ側）。「どこに出すか」と条件の後、「範囲」の前に出す。
   * 発信先を選んでいなくても出す。見出しは付けない（欄それぞれがラベルを持つ）。
   */
  fields?: ReactNode;
};

/** 「公開をやめる」の確認（PublishForm の「公開をやめる」から呼ぶ側が切り替える）。 */
export type PublishStopProps = {
  /** 公開をやめる発信先の名前。 */
  dest: string;
  /** やめたあとのこと（自分だけに戻る・URL は一覧へ転送 など）。 */
  detail: string;
  /** 送っている途中（「公開をやめる」を押せない）。 */
  busy?: boolean;
  /** やめられなかったときの 1 行（role="alert"）。 */
  error?: string | null;
  onConfirm: () => void;
  /** 「やめない」。公開のシートへ戻す。 */
  onCancel: () => void;
  onClose: () => void;
};

export type PublishDoneProps = {
  host: string;
  url: string;
  onView: () => void;
  onCopy?: () => void;
  onClose: () => void;
};

export type AddDestOption = { id: string; label: string; detail: string };
export type AddDestProps = {
  /** 省略すると、モックの 3 つ（公開APIで受け取る・WordPress・Ghost）。 */
  options?: AddDestOption[];
  onPick: (id: string) => void;
  onClose: () => void;
};

export const SHELL_ADD_DEST_OPTIONS: AddDestOption[] = [
  { id: "api", label: "公開APIで受け取る", detail: "どのサイトでも · JSON と Markdown" },
  { id: "wordpress", label: "WordPress", detail: "サイトのURLとアプリケーションパスワード" },
  { id: "ghost", label: "Ghost", detail: "Admin API キー" },
];

export type PublishSheetProps =
  | ({ kind: "publish" } & PublishFormProps)
  | ({ kind: "done" } & PublishDoneProps)
  | ({ kind: "addDest" } & AddDestProps)
  | ({ kind: "stop" } & PublishStopProps);

/**
 * 公開のシート（モック v6 の SHEET）。kind で 4 種: publish（どこに出すか・範囲・あわせて・足りないもの・URL）／done（公開しました）／
 * addDest（発信先を追加）／stop（公開をやめる確認。モックに無いので #39 で足した）。
 * 状態はすべて props。EditorShell の overlay に渡す。
 */
export function PublishSheet(props: PublishSheetProps) {
  if (props.kind === "done") return <PublishDone {...props} />;
  if (props.kind === "addDest") return <AddDestSheet {...props} />;
  if (props.kind === "stop") return <PublishStop {...props} />;
  return <PublishForm {...props} />;
}

function PublishForm(props: PublishFormProps) {
  const destId = useId();
  const rangeId = useId();
  const extraId = useId();
  const needId = useId();
  const noteId = useId();
  const slugId = useId();
  const slugNoteId = useId();
  const categoryId = useId();
  const relatedId = useId();
  const { current, dests, picked, missing, range, extras, slug } = props;
  const chosen = dests.find((dest) => dest.id === picked);
  const blocked = !chosen || !chosen.connected || missing.length > 0 || Boolean(props.submitDisabled);
  const heading = current ? (current.updated ? "更新を公開" : "公開の設定") : "公開";
  const action = props.action ?? (current?.updated ? "更新を公開" : current ? "保存" : "公開する");
  const focusId = chosen && chosen.connected ? chosen.id : dests.find((dest) => dest.connected)?.id;
  return (
    <ShellSheet label="公開" onClose={props.onClose}>
      <div className="es-sh-hd">
        <h2>{heading}</h2>
        <span className="es-sp" />
        {current && (
          <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={props.onUnpublish}>
            公開をやめる
          </button>
        )}
      </div>
      <div className="es-sh-body">
        <div className="es-sh-sec">
          <h3 id={destId}>どこに出すか</h3>
          <div role="radiogroup" aria-labelledby={destId}>
            {dests.map((dest) =>
              dest.connected ? (
                <button
                  key={dest.id}
                  type="button"
                  role="radio"
                  aria-checked={dest.id === picked}
                  className={`es-dst es-dst--${dest.id}${dest.id === picked ? " es-dst--on" : ""}`}
                  data-autofocus={dest.id === focusId ? "" : undefined}
                  onClick={() => props.onPick(dest.id)}
                >
                  <i aria-hidden="true" />
                  <span>
                    <b>{dest.label}</b>
                    <small>{dest.who}</small>
                    <small>{dest.url}</small>
                  </span>
                  <span className="es-tag-ok">{dest.role}</span>
                </button>
              ) : dest.note ? (
                // 選べない（宣言が読めない など）。押してもすることが無いので、ボタンにしない
                <div key={dest.id} className={`es-dst es-dst--${dest.id} es-dst--off`}>
                  <i aria-hidden="true" />
                  <span>
                    <b>{dest.label}</b>
                    <small>{dest.who}</small>
                    {dest.url && <small>{dest.url}</small>}
                  </span>
                  <span className="es-tag-no">{dest.note}</span>
                </div>
              ) : (
                // 名前は見えている文字そのもの（発信先・説明・URL・「接続する」）。aria-label で別の文に置き換えない（WCAG 2.5.3。#43）
                <button key={dest.id} type="button" className={`es-dst es-dst--${dest.id}`} onClick={() => props.onConnect?.(dest.id)}>
                  <i aria-hidden="true" />
                  <span>
                    <b>{dest.label}</b>
                    <small>{dest.who}</small>
                    <small>{dest.url}</small>
                  </span>
                  <span className="es-tag-no">
                    接続する<span aria-hidden="true"> ›</span>
                  </span>
                </button>
              ),
            )}
          </div>
          <button type="button" className="es-dst es-dst--add" onClick={props.onAddDest}>
            <i aria-hidden="true" />
            <span>
              <b>発信先を追加</b>
            </span>
          </button>
        </div>
        {chosen &&
          (missing.length > 0 ? (
            <div className="es-sh-sec">
              <h3 id={needId}>{chosen.label} に出すには</h3>
              <ul className="es-need" aria-labelledby={needId}>
                {missing.map((item) => (
                  <li key={item.id}>
                    {item.label}
                    <button type="button" aria-label={`${item.label} を直す`} onClick={() => props.onFix(item.id)}>
                      直す
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="es-sh-sec">
              <p className="es-ready">
                <Icon name="check" />
                {chosen.label} の条件はそろっています
              </p>
            </div>
          ))}
        {props.fields ? <div className="es-sh-sec es-sh-fields">{props.fields}</div> : null}
        {chosen && chosen.id !== "site" && (
          <div className="es-sh-sec">
            <h3 id={rangeId}>範囲</h3>
            <div role="radiogroup" aria-labelledby={rangeId}>
              <button type="button" role="radio" aria-checked={range === "live"} className={`es-opt${range === "live" ? " es-opt--on" : ""}`} onClick={() => props.onRange("live")}>
                <i aria-hidden="true" />
                公開<small>一覧・検索に出る</small>
              </button>
              <button type="button" role="radio" aria-checked={range === "unlisted"} className={`es-opt${range === "unlisted" ? " es-opt--on" : ""}`} onClick={() => props.onRange("unlisted")}>
                <i aria-hidden="true" />
                限定公開<small>URLを知っている人だけ</small>
              </button>
            </div>
          </div>
        )}
        {chosen?.id === "exp" && props.experience && (
          <div className="es-sh-sec">
            <h3>記事の設定</h3>
            {!props.experience.loaded ? (
              <p className="es-sh-sub">現在のカテゴリと体験を確認しています。</p>
            ) : props.experience.unavailable ? (
              <p role="alert" className="es-sh-err">カテゴリと関連する体験を確認できません。接続が戻ってから再読み込みしてください。</p>
            ) : props.experience.categories.length === 0 ? (
              <p className="es-sh-sub">管理者のカテゴリ設定が必要です。設定されるまで公開条件は緩められません。</p>
            ) : (
              <>
                <label htmlFor={categoryId}>カテゴリ</label>
                <select id={categoryId} data-publish-field="category" className="es-input" value={props.experience.category ?? ""} onChange={(event) => props.experience?.onCategory(event.target.value || null)}>
                  <option value="">選んでください</option>
                  {props.experience.categories.map((item) => <option key={item.slug} value={item.slug}>{item.labelJa} / {item.labelEn}</option>)}
                </select>
                <h3 id={relatedId}>関連する体験</h3>
                <label htmlFor={`${relatedId}-query`}>体験を検索</label>
                <input
                  id={`${relatedId}-query`}
                  type="search"
                  className="es-input"
                  value={props.experience.query}
                  maxLength={100}
                  onChange={(event) => props.experience?.onQuery(event.target.value)}
                />
                <div role="group" aria-labelledby={relatedId} data-publish-field="related" tabIndex={-1}>
                  {props.experience.related.filter((slug) => !props.experience?.candidates.some((item) => item.slug === slug)).map((slug) => (
                    <button key={slug} type="button" role="checkbox" aria-checked="true" className="es-chk es-chk--on" onClick={() => props.experience?.onRelated(slug)}>
                      <i aria-hidden="true" />選択中の体験<small>{slug} · 現在の掲載・権限は公開時に再確認します</small>
                    </button>
                  ))}
                  {props.experience.candidates.map((item) => {
                    const checked = props.experience?.related.includes(item.slug) ?? false;
                    return <button key={item.slug} type="button" role="checkbox" aria-checked={checked} className={`es-chk${checked ? " es-chk--on" : ""}`} onClick={() => props.experience?.onRelated(item.slug)}><i aria-hidden="true" />{item.title}<small>{item.providerName}</small></button>;
                  })}
                </div>
                {props.experience.nextCursor && (
                  <button type="button" className="es-btn es-btn--quiet es-btn--sm" disabled={props.experience.loadingMore} onClick={props.experience.onMore}>
                    {props.experience.loadingMore ? "読み込み中…" : "さらに表示"}
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {chosen && chosen.id !== "site" && (
          <div className="es-sh-sec">
            <h3 id={extraId}>あわせて</h3>
            <div role="group" aria-labelledby={extraId}>
              <button type="button" role="checkbox" aria-checked={extras.app} className={`es-chk${extras.app ? " es-chk--on" : ""}`} onClick={() => props.onExtra("app")}>
                <i aria-hidden="true" />
                NIHOアプリに載せる
              </button>
              <button type="button" role="checkbox" aria-checked={extras.news} className={`es-chk${extras.news ? " es-chk--on" : ""}`} onClick={() => props.onExtra("news")}>
                <i aria-hidden="true" />
                ニュースレター<small>次号</small>
              </button>
              <button
                type="button"
                role="checkbox"
                aria-checked={extras.xp}
                aria-disabled={chosen.id !== "exp"}
                className={`es-chk${extras.xp ? " es-chk--on" : ""}${chosen.id === "exp" ? "" : " es-chk--off"}`}
                onClick={() => {
                  if (chosen.id === "exp") props.onExtra("xp");
                }}
              >
                <i aria-hidden="true" />
                体験ページに載せる<small>{chosen.id === "exp" ? "関連する体験の末尾" : "NIHO Experience のときだけ"}</small>
              </button>
            </div>
          </div>
        )}
        {chosen && chosen.connected && slug && (
          <div className="es-sh-sec">
            {slug.editable ? (
              <>
                <h3>
                  <label htmlFor={slugId}>URL</label>
                </h3>
                <div className="es-slug">
                  <span>{slug.prefix}</span>
                  <input
                    id={slugId}
                    className="es-input"
                    value={slug.value}
                    spellCheck={false}
                    autoCapitalize="none"
                    autoComplete="off"
                    aria-invalid={slug.error ? true : undefined}
                    aria-describedby={slugNoteId}
                    onChange={(event) => slug.onChange?.(event.target.value)}
                  />
                </div>
                <p id={slugNoteId} className={slug.error ? "es-sh-err" : "es-sh-sub"}>
                  {slug.error || "公開するまで変えられます"}
                </p>
              </>
            ) : (
              <>
                <h3>URL</h3>
                <code className="es-sh-url">
                  {slug.prefix}
                  {slug.value}
                </code>
                <p className="es-sh-sub">公開したあとは変えられません</p>
              </>
            )}
          </div>
        )}
      </div>
      <div className="es-sh-foot">
        {props.error && (
          <p role="alert" className="es-sh-err">
            {props.error}
          </p>
        )}
        {chosen ? (
          !chosen.connected ? (
            <span id={noteId} className="es-sh-note es-sh-left">
              {chosen.label} に接続すると公開できます
            </span>
          ) : missing.length > 0 ? (
            <span id={noteId} className="es-sh-note es-sh-left">
              あと {missing.length} つ
            </span>
          ) : (
            <code id={noteId} className="es-sh-note">
              {chosen.url}
            </code>
          )
        ) : (
          <span id={noteId} className="es-sh-note es-sh-hint">
            発信先を選ぶと条件が出ます
          </span>
        )}
        <span className="es-sh-acts">
          <button type="button" className="es-btn es-btn--quiet" onClick={props.onClose}>
            閉じる
          </button>
          <button type="button" className="es-btn es-btn--primary" disabled={blocked} aria-describedby={noteId} onClick={props.onPublish}>
            {action}
          </button>
        </span>
      </div>
    </ShellSheet>
  );
}

function PublishDone({ host, url, onView, onCopy, onClose }: PublishDoneProps) {
  return (
    <ShellSheet label="公開しました" onClose={onClose}>
      <div className="es-donebox">
        <div className="es-donebox-mk" aria-hidden="true">
          ✓
        </div>
        <h2>{host} に公開しました</h2>
        <code>{url}</code>
      </div>
      <div className="es-sh-foot es-sh-foot--center">
        <button type="button" className="es-btn es-btn--primary" data-autofocus="" onClick={onView}>
          見る
        </button>
        <button type="button" className="es-btn es-btn--outline" onClick={onCopy}>
          リンクをコピー
        </button>
        <button type="button" className="es-btn es-btn--quiet" onClick={onClose}>
          閉じる
        </button>
      </div>
    </ShellSheet>
  );
}

/** 公開をやめる確認。最初のフォーカスは「やめない」（Enter で取り消さない）。 */
function PublishStop({ dest, detail, busy, error, onConfirm, onCancel, onClose }: PublishStopProps) {
  return (
    <ShellSheet label="公開をやめる" onClose={onClose}>
      <div className="es-sh-hd">
        <h2>{dest} での公開をやめますか</h2>
      </div>
      <div className="es-sh-body">
        <div className="es-sh-sec">
          <p className="es-sh-text">{detail}</p>
        </div>
      </div>
      <div className="es-sh-foot">
        {error && (
          <p role="alert" className="es-sh-err">
            {error}
          </p>
        )}
        <span className="es-sh-acts">
          <button type="button" className="es-btn es-btn--quiet" data-autofocus="" onClick={onCancel}>
            やめない
          </button>
          <button type="button" className="es-btn es-btn--primary" disabled={busy} onClick={onConfirm}>
            公開をやめる
          </button>
        </span>
      </div>
    </ShellSheet>
  );
}

function AddDestSheet({ options = SHELL_ADD_DEST_OPTIONS, onPick, onClose }: AddDestProps) {
  return (
    <ShellSheet label="発信先を追加" onClose={onClose}>
      <div className="es-sh-hd">
        <h2>発信先を追加</h2>
      </div>
      <div className="es-sh-sec es-sh-sec--list">
        {options.map((option, index) => (
          <button key={option.id} type="button" className="es-dst es-dst--site" data-autofocus={index === 0 ? "" : undefined} onClick={() => onPick(option.id)}>
            <i aria-hidden="true" />
            <span>
              <b>{option.label}</b>
              <small>{option.detail}</small>
            </span>
            <span className="es-tag-no" aria-hidden="true">
              ›
            </span>
          </button>
        ))}
      </div>
      <div className="es-sh-foot">
        <span className="es-sp" />
        <button type="button" className="es-btn es-btn--quiet" onClick={onClose}>
          閉じる
        </button>
      </div>
    </ShellSheet>
  );
}
