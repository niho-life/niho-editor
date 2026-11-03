import type { Extensions } from "@tiptap/core";
import type { ImageSrcOf, PageImages } from "./images";
import { PageImage } from "./image-node";
import { buildMarkdownExtensions } from "./markdown-extensions";
import { PageSlashMenu } from "./slash-menu";

/**
 * ページの本文のエディタの schema。限定 AST（blocks.ts）と同じ範囲だけを作れる。
 *
 * 段落・見出し 2・3・箇条書き・チェックリスト・番号付き・表・コード・引用・囲み・区切り線・画像、行の中は太字・斜体・
 * 取り消し線・インラインコード・リンク・改行。
 * 録音は AST では許すが、作る手段がまだ無いので、この schema には入れていない
 * （`editor-schema.test.ts` が差を固定している。足すときは両方を揃える）。
 *
 * 画像（#33。image-node.ts）は実体を private bucket に置くので、アップロードの口（`images`）と、
 * 入れる先のページ（`pageId`。新しいページは最初の保存まで null）を渡したときだけ入れられる。渡さなくても schema は同じ
 * （保存されている画像は読めて描ける）。
 *
 * 空の行の「/」（全角の「／」も）でブロックの一覧を開く（slash-menu.ts。ノード・mark は足さない。
 * 一覧で作れるのも、この schema の範囲だけ: block-types.ts）。
 */
export type PageExtensionsOptions = {
  /** 画像のアップロードと欄の保存の口（images.ts）。 */
  images?: PageImages | null;
  /** 今のページの id を返す（まだ作っていなければ null）。 */
  pageId?: () => string | null;
  /** 保存済みの画像を描く src を組む口（Web はサーバーの中継の path、Mac は asset protocol の URL）。 */
  srcOf?: ImageSrcOf | null;
};

export function buildPageExtensions(options: PageExtensionsOptions = {}): Extensions {
  return [
    ...buildMarkdownExtensions(),
    PageSlashMenu,
    PageImage.configure({ images: options.images ?? null, pageId: options.pageId ?? null, srcOf: options.srcOf ?? null }),
  ];
}
