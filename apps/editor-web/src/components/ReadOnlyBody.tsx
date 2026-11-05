"use client";

import { useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { docFromBlocks } from "@/editor/doc";
import { buildPageExtensions } from "@/editor/page-extensions";

/**
 * ページの本文を、同じ schema の読み取り専用の TipTap で描く（競合の帯の「最新版を見る」と、右に並べたページ）。
 * 本文が schema に合わなければ描かずに一言を出す（読めない本文で画面を止めない）。blocks が替われば描き直す。
 */
export function ReadOnlyBody(props: { blocks: unknown[]; label: string; className?: string }) {
  const [unreadable, setUnreadable] = useState(false);
  const editor = useEditor(
    {
      extensions: buildPageExtensions(),
      content: docFromBlocks(props.blocks),
      editable: false,
      immediatelyRender: false,
      enableContentCheck: true,
      onContentError: () => setUnreadable(true),
      // aria-readonly は役割の無い div には付けられない（axe の aria-allowed-attr）。読み取り専用の複数行の文として読ませる
      editorProps: { attributes: { class: "doc", role: "textbox", "aria-multiline": "true", "aria-label": props.label, "aria-readonly": "true" } },
    },
    [props.blocks, props.label],
  );
  if (unreadable) return <p>この本文はここでは表示できません。</p>;
  return (
    <div className={props.className ?? "be"}>
      <EditorContent editor={editor} />
    </div>
  );
}
