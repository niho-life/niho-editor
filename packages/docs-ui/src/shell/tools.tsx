import { Icon } from "./icons";
import { useRovingFocus } from "./roving-focus";

/** 道具の帯の操作。呼ぶ側が TipTap（または別の保存先）につなぐ。 */
export type ShellToolAction = "add-block" | "text-type" | "bold" | "italic" | "strike" | "code" | "link" | "heading" | "list" | "image" | "record";

export type ShellToolsProps = {
  onAction?: (action: ShellToolAction) => void;
  /** ＋（ブロックを足す）でブロックの一覧が開いているか。 */
  blockMenuOpen?: boolean;
  /** 「行の種類」のボタンに見せる、いまの行の種類（既定は「テキスト」）。見える文字はボタンの名前にも入る。 */
  textType?: string;
  /**
   * 書式（行の種類・B・I・リンク・見出し・箇条書き）を出さず、＋（ブロックを足す）・画像・録音だけにする。
   * 書式は選んだ文字の上（ShellBubbleMenu）が持つ。既定は false（全部）。
   */
  compact?: boolean;
};

/**
 * 道具: ＋ ／ テキスト B I リンク ／ 見出し 箇条書き 画像 録音。ヘッダーの中に並べる（狭い幅では ShellMobileToolbar が下端へ出す）。
 * 書式は選んだ文字の上にも出る（ShellBubbleMenu / ShellSelectionBar）。
 * キーボードは WAI-ARIA の toolbar（Tab の停止点は 1 つ、← → と Home・End で中を動く。useRovingFocus）。
 */
export function ShellTools({ onAction, blockMenuOpen, textType = "テキスト", compact = false }: ShellToolsProps) {
  const roving = useRovingFocus<HTMLDivElement>();
  const fire = (action: ShellToolAction) => () => onAction?.(action);
  if (compact) {
    return (
      <div ref={roving.ref} className="es-tools" data-hscroll role="toolbar" aria-label="書式とブロック" onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
        <button type="button" className="es-tb" aria-label="ブロックを足す" title="ブロックを足す" aria-haspopup="menu" aria-expanded={blockMenuOpen ?? false} onClick={fire("add-block")}>
          <Icon name="plus" />
        </button>
        <button type="button" className="es-tb" aria-label="画像" onClick={fire("image")}>
          <Icon name="img" />
        </button>
        <button type="button" className="es-tb" aria-label="録音" onClick={fire("record")}>
          <Icon name="mic" />
        </button>
      </div>
    );
  }
  return (
    <div ref={roving.ref} className="es-tools" data-hscroll role="toolbar" aria-label="書式とブロック" onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
      <button type="button" className="es-tb" aria-label="ブロックを足す" title="ブロックを足す" aria-haspopup="menu" aria-expanded={blockMenuOpen ?? false} onClick={fire("add-block")}>
        <Icon name="plus" />
      </button>
      <span className="es-sep" aria-hidden="true" />
      {/* 名前は見える文字（いまの行の種類）から始める（WCAG 2.5.3。#43） */}
      <button type="button" className="es-tb" aria-label={`${textType}、行の種類`} aria-haspopup="menu" onClick={fire("text-type")}>
        {textType} <span aria-hidden="true">▾</span>
      </button>
      <button type="button" className="es-tb" aria-label="太字" onClick={fire("bold")}>
        <b>B</b>
      </button>
      <button type="button" className="es-tb" aria-label="斜体" onClick={fire("italic")}>
        <i>I</i>
      </button>
      <button type="button" className="es-tb" aria-label="取り消し線" onClick={fire("strike")}><s>S</s></button>
      <button type="button" className="es-tb" aria-label="インラインコード" onClick={fire("code")}><code>&lt;/&gt;</code></button>
      <button type="button" className="es-tb" aria-label="リンク" onClick={fire("link")}>
        <Icon name="link" />
      </button>
      <span className="es-sep" aria-hidden="true" />
      <button type="button" className="es-tb" aria-label="見出し" onClick={fire("heading")}>
        <Icon name="h" />
      </button>
      <button type="button" className="es-tb" aria-label="箇条書き" onClick={fire("list")}>
        <Icon name="list" />
      </button>
      <button type="button" className="es-tb" aria-label="画像" onClick={fire("image")}>
        <Icon name="img" />
      </button>
      <button type="button" className="es-tb" aria-label="録音" onClick={fire("record")}>
        <Icon name="mic" />
      </button>
    </div>
  );
}

/**
 * 900px 未満で、道具を画面の下端に出す帯（右のレールを開いているあいだは隠れる）。
 * ヘッダー・本文の外に出るので、名前つきの region（ランドマーク）にする（帯の中身が、どのランドマークにも属さないままにならないように）。
 */
export function ShellMobileToolbar(props: ShellToolsProps) {
  return (
    <div className="es-mtb" role="region" aria-label="道具の帯">
      <ShellTools {...props} />
    </div>
  );
}
