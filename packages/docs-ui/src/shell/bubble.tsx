import { useEffect, type MouseEvent as ReactMouseEvent } from "react";
import type { Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
// editor.chain() の toggleBold などの型は、StarterKit の型から入る（これだけを読む検査でも型が揃うように）。
import type {} from "@tiptap/starter-kit";
import { Icon } from "./icons";

/** 選んだ文字の上の書式の帯の操作。 */
export type ShellSelectionActions = {
  onTextType?: () => void;
  onBold?: () => void;
  onItalic?: () => void;
  onStrike?: () => void;
  onCode?: () => void;
  onLink?: () => void;
  onHeading?: () => void;
  onList?: () => void;
  onAi?: () => void;
};

const keepFocus = (event: ReactMouseEvent) => event.preventDefault();

function SelectionButtons({
  actions,
  pressed,
  textType = "テキスト",
}: {
  actions: ShellSelectionActions;
  pressed?: { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean };
  textType?: string;
}) {
  return (
    <>
      {/* 名前は見える文字（いまの行の種類）から始める（WCAG 2.5.3。#43） */}
      <button type="button" aria-label={`${textType}、行の種類`} aria-haspopup="menu" onMouseDown={keepFocus} onClick={actions.onTextType}>
        {textType} <span aria-hidden="true">▾</span>
      </button>
      <span className="es-sep" aria-hidden="true" />
      <button type="button" aria-label="太字" aria-pressed={pressed?.bold} onMouseDown={keepFocus} onClick={actions.onBold}>
        <b>B</b>
      </button>
      <button type="button" aria-label="斜体" aria-pressed={pressed?.italic} onMouseDown={keepFocus} onClick={actions.onItalic}>
        <i>I</i>
      </button>
      <button type="button" aria-label="取り消し線" aria-pressed={pressed?.strike} onMouseDown={keepFocus} onClick={actions.onStrike}>
        <s>S</s>
      </button>
      <button type="button" aria-label="インラインコード" aria-pressed={pressed?.code} onMouseDown={keepFocus} onClick={actions.onCode}>
        <code>&lt;/&gt;</code>
      </button>
      <button type="button" aria-label="リンク" onMouseDown={keepFocus} onClick={actions.onLink}>
        <Icon name="link" />
      </button>
      <span className="es-sep" aria-hidden="true" />
      <button type="button" aria-label="見出し" onMouseDown={keepFocus} onClick={actions.onHeading}>
        <Icon name="h" />
      </button>
      <button type="button" aria-label="箇条書き" onMouseDown={keepFocus} onClick={actions.onList}>
        <Icon name="list" />
      </button>
      <span className="es-sep" aria-hidden="true" />
      <button type="button" className="es-aibtn" aria-label="AI に頼む" onMouseDown={keepFocus} onClick={actions.onAi}>
        <Icon name="spark" />
        AI
      </button>
    </>
  );
}

/**
 * 静的な見た目の書式の帯。ギャラリーとテストで、TipTap を起動せずに「文字を選んだとき」を描く。
 * 選んだ文字（.es-sel）を包む .es-selwrap の中に置くと、文字の上に出る。
 */
export function ShellSelectionBar({ actions = {}, textType }: { actions?: ShellSelectionActions; textType?: string }) {
  return (
    <span className="es-selbar" role="toolbar" aria-label="書式">
      <SelectionButtons actions={actions} textType={textType} />
    </span>
  );
}

export type ShellBubbleMenuProps = {
  editor: Editor;
  /** 行の種類・リンク・AI は呼ぶ側の画面が持つ（このラッパーは編集コマンドだけを TipTap へつなぐ）。 */
  onTextType?: () => void;
  onLink?: () => void;
  onAi?: () => void;
  /** 「行の種類」のボタンに見せる、いまの行の種類（既定は「テキスト」）。 */
  textType?: string;
};

/**
 * 選んだ文字の上に出る書式の帯（TipTap の bubble-menu）。BlockEditor の BubbleMenu と同じ import で、editor を props で受ける。
 * 太字・斜体・見出し・箇条書きは editor のコマンドへ、行の種類・リンク・AI は props の関数へ渡す。
 */
export function ShellBubbleMenu({ editor, onTextType, onLink, onAi, textType }: ShellBubbleMenuProps) {
  useEffect(() => {
    const update = () => {
      const bar = editor.view.dom.closest(".be")?.querySelector(".es-selbar--live");
      for (const [name, mark] of [["太字", "bold"], ["斜体", "italic"], ["取り消し線", "strike"], ["インラインコード", "code"]] as const) {
        bar?.querySelector(`button[aria-label="${name}"]`)?.setAttribute("aria-pressed", String(editor.isActive(mark)));
      }
    };
    editor.on("transaction", update);
    update();
    return () => { editor.off("transaction", update); };
  }, [editor]);
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="shellFormatBar"
      className="es-selbar es-selbar--live"
      role="toolbar"
      aria-label="書式"
      options={{ placement: "top", offset: 11 }}
    >
      <SelectionButtons
        textType={textType}
        pressed={{ bold: editor.isActive("bold"), italic: editor.isActive("italic"), strike: editor.isActive("strike"), code: editor.isActive("code") }}
        actions={{
          onTextType,
          onLink,
          onAi,
          onBold: () => editor.chain().focus().toggleBold().run(),
          onItalic: () => editor.chain().focus().toggleItalic().run(),
          onStrike: () => editor.chain().focus().toggleStrike().run(),
          onCode: () => editor.chain().focus().toggleCode().run(),
          onHeading: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
          onList: () => editor.chain().focus().toggleBulletList().run(),
        }}
      />
    </BubbleMenu>
  );
}
