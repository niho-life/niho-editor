import { Fragment, type CSSProperties, type ReactNode } from "react";

/**
 * 共有ページ（`/s/{token}`）の本文を React の要素にする（#34）。HTML の文字列は作らず、注入もしない。
 * 本文は TipTap の doc の content（ブロックの配列）。描くのは:
 * paragraph・heading・リスト・表・コード・引用・区切り線・改行・文字・画像。
 * mark は bold・italic・strike・code・link。リンクは https・http・mailto の絶対 URL だけを
 * リンクにし（javascript:・data:・相対・資格情報つきは文字だけ）、常に rel="noopener noreferrer nofollow ugc" を付ける。
 * 未知のノードは投げずに子だけを描く。再帰は深さ 64 で止める。
 *
 * 画像（#33）は資産の id を持つものだけを、`assetSrc`（共有リンクの中継 `/s/{token}/a/{id}`）で描く。`assetSrc` が無い・
 * id が UUID でない・外の `src` を持つ古い形のノードは、**描かない**（読めない img を置かない。外の URL へは繋がない）。
 * 録音は描かない（資産は #36）。
 */

const MAX_DEPTH = 64;
const LINK_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);
export const SHARED_LINK_REL = "noopener noreferrer nofollow ugc";

type JsonNode = { readonly [key: string]: unknown };

/** 描かないノード（まだ扱えない資産）。 */
const SKIPPED = new Set(["docAssetImage", "recording"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 画像の中継の path を作る関数（共有ページが渡す）。null を返した画像は描かない。 */
export type AssetSrc = (assetId: string) => string | null;

function isNode(value: unknown): value is JsonNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** リンクにしてよい先（https・http・mailto の絶対 URL。資格情報・制御文字・空白を含むものは断る）。 */
export function safeShareHref(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  if (/[\u0000-\u0020\u007f-\u009f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!LINK_PROTOCOLS.has(url.protocol) || url.username || url.password) return null;
  return url.href;
}

function renderChildren(node: JsonNode, depth: number, assetSrc: AssetSrc | null): ReactNode[] {
  if (!Array.isArray(node.content)) return [];
  return node.content.map((child, index) => renderNode(child, index, depth + 1, assetSrc));
}

/**
 * 画像。alt は本文の attrs の値（無ければ空の alt）、クレジットがあれば figcaption に出す。
 * 大きさ・読み込みの指示は付けない（元の大きさで、遅延読み込み）。
 */
function renderImage(node: JsonNode, key: number, assetSrc: AssetSrc | null): ReactNode {
  if (!assetSrc || !isNode(node.attrs)) return null;
  const { assetId, alt, credit } = node.attrs;
  if (typeof assetId !== "string" || !UUID.test(assetId)) return null;
  const src = assetSrc(assetId);
  if (src === null) return null;
  const caption = typeof credit === "string" && credit !== "" ? credit : null;
  return (
    <figure key={key}>
      {/* eslint-disable-next-line @next/next/no-img-element -- 中継の path をそのまま読む（next/image の最適化・外部 loader を通さない） */}
      <img src={src} alt={typeof alt === "string" ? alt : ""} loading="lazy" decoding="async" data-doc-asset="" />
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

function renderText(node: JsonNode, key: number): ReactNode {
  if (typeof node.text !== "string" || node.text === "") return null;
  let element: ReactNode = node.text;
  let href: string | null = null;
  let bold = false;
  let italic = false;
  let strike = false;
  let code = false;
  if (Array.isArray(node.marks)) {
    for (const mark of node.marks) {
      if (!isNode(mark)) continue;
      if (mark.type === "bold") bold = true;
      else if (mark.type === "italic") italic = true;
      else if (mark.type === "strike") strike = true;
      else if (mark.type === "code") code = true;
      else if (mark.type === "link" && isNode(mark.attrs)) href = safeShareHref(mark.attrs.href);
    }
  }
  if (italic) element = <em>{element}</em>;
  if (bold) element = <strong>{element}</strong>;
  if (strike) element = <s>{element}</s>;
  if (code) element = <code>{element}</code>;
  if (href) {
    element = (
      <a href={href} rel={SHARED_LINK_REL}>
        {element}
      </a>
    );
  }
  return <Fragment key={key}>{element}</Fragment>;
}

function tableCellProps(node: JsonNode): { colSpan?: number; rowSpan?: number; style?: CSSProperties } {
  const attrs = isNode(node.attrs) ? node.attrs : {};
  const span = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 100 ? value as number : undefined;
  const align = attrs.align === "left" || attrs.align === "center" || attrs.align === "right" ? attrs.align : null;
  return { colSpan: span(attrs.colspan), rowSpan: span(attrs.rowspan), style: align ? { textAlign: align } : undefined };
}

function renderNode(value: unknown, key: number, depth: number, assetSrc: AssetSrc | null): ReactNode {
  if (depth > MAX_DEPTH || !isNode(value)) return null;
  switch (value.type) {
    case "text":
      return renderText(value, key);
    case "hardBreak":
      return <br key={key} />;
    case "horizontalRule":
      return <hr key={key} />;
    case "image":
      return renderImage(value, key, assetSrc);
    case "paragraph":
      return <p key={key}>{renderChildren(value, depth, assetSrc)}</p>;
    case "heading":
      return isNode(value.attrs) && value.attrs.level === 2 ? (
        <h2 key={key}>{renderChildren(value, depth, assetSrc)}</h2>
      ) : (
        <h3 key={key}>{renderChildren(value, depth, assetSrc)}</h3>
      );
    case "bulletList":
      return <ul key={key}>{renderChildren(value, depth, assetSrc)}</ul>;
    case "taskList":
      return <ul key={key} data-type="taskList">{renderChildren(value, depth, assetSrc)}</ul>;
    case "taskItem": {
      const checked = isNode(value.attrs) && value.attrs.checked === true;
      return <li key={key} data-checked={checked}><span aria-label={checked ? "完了" : "未完了"}>{checked ? "☑" : "☐"}</span>{renderChildren(value, depth, assetSrc)}</li>;
    }
    case "table":
      return <div key={key} className="shared-table" role="region" aria-label="本文の表" tabIndex={0}><table><tbody>{renderChildren(value, depth, assetSrc)}</tbody></table></div>;
    case "tableRow":
      return <tr key={key}>{renderChildren(value, depth, assetSrc)}</tr>;
    case "tableHeader":
      return <th key={key} scope="col" {...tableCellProps(value)}>{renderChildren(value, depth, assetSrc)}</th>;
    case "tableCell":
      return <td key={key} {...tableCellProps(value)}>{renderChildren(value, depth, assetSrc)}</td>;
    case "codeBlock":
      return <pre key={key}><code>{typeof value.content === "string" ? value.content : Array.isArray(value.content) ? value.content.filter(isNode).map((part) => typeof part.text === "string" ? part.text : "").join("") : ""}</code></pre>;
    case "orderedList": {
      const start = isNode(value.attrs) && Number.isInteger(value.attrs.start) && (value.attrs.start as number) > 1 ? (value.attrs.start as number) : undefined;
      return (
        <ol key={key} start={start}>
          {renderChildren(value, depth, assetSrc)}
        </ol>
      );
    }
    case "listItem":
      return <li key={key}>{renderChildren(value, depth, assetSrc)}</li>;
    case "blockquote":
      return <blockquote key={key}>{renderChildren(value, depth, assetSrc)}</blockquote>;
    case "callout":
      // 囲み（#33）。編集画面と同じ `aside[data-callout]` で出す（見た目は docs-ui の editor.css）
      return (
        <aside key={key} data-callout="">
          {renderChildren(value, depth, assetSrc)}
        </aside>
      );
    default:
      if (SKIPPED.has(String(value.type))) return null;
      // 未知のノードは子だけを描く
      return <Fragment key={key}>{renderChildren(value, depth, assetSrc)}</Fragment>;
  }
}

/** 本文のブロックの配列を描く。`assetSrc` を渡さなければ画像は描かない。 */
export function SharedBlocks(props: { blocks: readonly unknown[]; assetSrc?: AssetSrc }): ReactNode {
  const blocks = Array.isArray(props.blocks) ? props.blocks : [];
  const assetSrc = props.assetSrc ?? null;
  return <>{blocks.map((block, index) => renderNode(block, index, 1, assetSrc))}</>;
}
