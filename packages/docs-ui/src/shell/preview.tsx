import { Fragment } from "react";
import { Icon } from "./icons";
import type { ShellBodyBlock, ShellInline } from "./page";
import type { ShellDest, ShellLang } from "./types";

export type PublishPreviewDest = { id: ShellDest; host: string; path: string };

export type PublishPreviewProps = {
  title: string;
  lead?: string;
  /** 記事のカテゴリ（空なら出さない）。 */
  category?: string;
  lang: ShellLang;
  /** 公開版の本文。未確認の印（CONFIRM）は確かめ済みの文字にして渡す（ここでは印を描かない）。 */
  body: ShellBodyBlock[];
  slug: string;
  date: string;
  author: { name: string; title: string; initial: string };
  /** いま見ている発信先と、見え方を切り替えられる発信先。 */
  to: ShellDest;
  dests: PublishPreviewDest[];
  /** 公開中の版をそのまま見ているか（「公開中」）。そうでなければ「公開するとこう見えます」。 */
  live: boolean;
  /** 本人のサイトのホスト。 */
  siteHost: string;
  /** NIHO Travel のときだけ、記事の末尾に出す関連する体験。 */
  experience?: { title: string; price: string; from?: boolean };
  onBack: () => void;
  onTo: (dest: ShellDest) => void;
};

const plain = (part: ShellInline): string => (typeof part === "string" ? part : part.text);

function ArticleBody({ blocks }: { blocks: ShellBodyBlock[] }) {
  return (
    <div className="es-art-body">
      {blocks.map((block, index) => {
        if (block.type === "h2") return <h2 key={index}>{block.text}</h2>;
        if (block.type === "ul") {
          return (
            <ul key={index}>
              {block.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          );
        }
        const parts = typeof block.text === "string" ? [block.text] : block.text;
        return (
          <p key={index}>
            {parts.map((part, at) => (
              <Fragment key={at}>{typeof part !== "string" && part.kind === "strong" ? <strong>{part.text}</strong> : plain(part)}</Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

/**
 * 公開するとこう見える（モック v6 の V.preview）。上のバーで発信先ごとの見え方を切り替える
 * （沈めた --ed-track ＋ 白いピル。緑にしない）。見え方の正本は発信先側にあり、これは見本。
 * 写真は持ち込まず、仮の面で描く。
 */
export function PublishPreview(props: PublishPreviewProps) {
  const { to, dests, lang } = props;
  const dest = dests.find((item) => item.id === to);
  const host = dest?.host ?? "";
  const ja = lang === "ja";
  const by = (
    <div className="es-art-by">
      <span className="es-av es-av--md" aria-hidden="true">
        {props.author.initial}
      </span>
      <span>
        {ja ? null : "By "}
        <b>{props.author.name}</b> · {props.author.title} · {props.date}
      </span>
    </div>
  );
  const article = (
    <article className="es-art">
      <div className="es-art-crumb">
        <span>{host}</span>
        <span aria-hidden="true">›</span>
        <span>{(dest?.path ?? "").replace("/", "")}</span>
        <span aria-hidden="true">›</span>
        <span>{props.slug}</span>
      </div>
      <div className="es-art-cv" aria-hidden="true" />
      {props.category ? <p className="es-art-k">{props.category}</p> : null}
      <h1>{props.title}</h1>
      {props.lead ? <p className="es-art-lead">{props.lead}</p> : null}
      {by}
      <ArticleBody blocks={props.body} />
      {to === "exp" && props.experience && (
        <div className="es-art-cta">
          <div className="es-art-cta-ph" aria-hidden="true" />
          <div>
            <small>Experience</small>
            <b>{props.experience.title}</b>
            <span>
              {props.experience.from ? "From " : ""}¥{props.experience.price} / adult
            </span>
          </div>
        </div>
      )}
    </article>
  );
  return (
    <div className="es-root es-root--scroll" data-editor-preview>
      <header className="es-pvbar">
        <button type="button" className="es-btn es-btn--primary es-btn--sm" onClick={props.onBack}>
          <Icon name="back" />
          ページ
        </button>
        <span aria-live="polite">{props.live ? "公開中" : "公開するとこう見えます"}</span>
        <span className="es-sp" />
        <div className="es-track" role="group" aria-label="発信先ごとの見え方">
          {dests.map((item) => (
            <button key={item.id} type="button" aria-pressed={item.id === to} onClick={() => props.onTo(item.id)}>
              {item.host}
            </button>
          ))}
        </div>
      </header>
      <main className={`es-pv es-pv--${to}`} aria-label={`${host} での見え方`}>
        {to === "exp" && (
          <>
            <div className="es-pv-hd">
              <span className="es-pv-lg">
                NIHO <span>Travel</span>
              </span>
              <nav className="es-pv-nav" aria-label="見本のメニュー">
                <span>Experiences</span>
                <span className="es-pv-cur">Journal</span>
                <span>Host with NIHO</span>
              </nav>
            </div>
            {article}
          </>
        )}
        {to === "niho" && (
          <>
            <div className="es-pv-hd">
              <b>NIHO</b>
              <nav className="es-pv-nav" aria-label="見本のメニュー">
                <span>リビング</span>
                <span>体験</span>
                <span className="es-pv-cur">記事</span>
                <span>コミュニティ</span>
              </nav>
            </div>
            <div className="es-pv-wrap">{article}</div>
          </>
        )}
        {to === "site" && (
          <>
            <div className="es-pv-hd">
              <b>{props.author.name}</b>
              <span>{props.siteHost}</span>
              <span className="es-pv-nav">Posts · About</span>
            </div>
            {article}
          </>
        )}
      </main>
    </div>
  );
}
