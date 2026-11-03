import type { Extensions } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import { isSafeLinkHref } from "./blocks";
import { PageCallout } from "./callout";

/**
 * 限定 AST（blocks.ts）のうち、画面の部品を持たない分（段落・見出し・箇条書き・チェックリスト・番号付き・表・コード・引用・
 * 囲み・区切り線と、行の中の太字・斜体・取り消し線・インラインコード・リンク・改行）。
 *
 * **React に触れない**ので、サーバー（editor-web の AI チャットがページを Markdown で読み書きする道具）からも読める。
 * 画像は NodeView（React）を持つのでここには無い。Markdown に画像の置き場は無く、markdown.ts は画像のある本文を
 * 断るので、往復の schema はこれで足りる（差は editor-schema.test.ts が固定している）。
 */
export function buildMarkdownExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      underline: false,
      link: {
        openOnClick: false,
        autolink: false,
        // 保存してよい scheme だけをリンクにする（貼り付けた `javascript:` も、設定した値も、文字のままになる）
        isAllowedUri: (url) => isSafeLinkHref(url),
      },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false, allowTableNodeSelection: false } }),
    PageCallout,
  ];
}
