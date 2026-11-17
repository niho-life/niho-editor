"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Icon } from "../shell/icons";
import { ShellMenu, useMenuDismiss } from "../shell/menu";
import type { ShellMenuItem } from "../shell/types";
import { IMAGE_ALT_MAX_CHARS, IMAGE_CAPTION_MAX_CHARS } from "./image-limits";
import type { ImageSrcOf, PageImages } from "./images";
import { imageAttrsOf } from "./doc";

/**
 * 本文の画像（#33）。実体は private bucket にあり、`src` はサーバーの中継（`/api/assets/{id}`）だけを指す
 * （署名付き URL はブラウザへ渡さない。CSP の `img-src 'self'` のまま）。
 *
 * 画像の下に欄は出さない（#344。モック docs/mockups/editor-page-refine-v1.html の 1）。編集できるときだけ、
 * 画像の右クリック（触れる端末は、選んでいる間だけ右上に出る ⋯）でメニューを出す:
 * キャプションを追加（あれば外す）／代替テキスト…／削除。
 * - キャプション: 選んだときだけ画像の下に 1 行の入力。Enter・フォーカスが外れたら確定し、空なら消す。ノードの属性だけに書く。
 *   キャプションのある画像は、選んでいないときも下に文字で出す（編集できるときは押すと直せる）。
 * - 代替テキスト: 画像の下の小さなポップオーバー。ノードの属性（本文の自動保存に乗る）と、資産の行
 *   （`PATCH /api/assets/{id}`。共有リンクの描画が読む正本）の両方へ書く。
 * - クレジット・掲載許諾は入力も表示もしない（既にある値は属性に残す。公開と配信の条件でもない）。
 * 欄・メニューは本文の編集から切り離す（`contentEditable={false}`・キーは外に伝えない）ので、入力中の Backspace で画像が消えず、
 * Enter で段落が割れない。見た目は shell.css の `.es-img-*`（色は token）。
 */

/** 欄を直してから資産の行へ書くまでの間（打っている間は送らない）。 */
const SAVE_DELAY_MS = 600;

/** メニューの幅と、だいたいの高さ（`.es-menu--at` の幅。押した位置から画面の外へはみ出さないように詰める）。 */
const MENU_WIDTH = 230;
const MENU_HEIGHT = 170;

export const IMAGE_MENU_TEXT = {
  more: "画像のメニュー",
  menu: "画像",
  addCaption: "キャプションを追加",
  removeCaption: "キャプションを外す",
  caption: "キャプション",
  captionPlaceholder: "キャプションを入力",
  alt: "代替テキスト",
  altItem: "代替テキスト…",
  altNote: "読み上げと検索で使います。ページには出ません。",
  altOn: "あり",
  altOff: "なし",
  remove: "削除",
  unreadable: "画像を読み込めませんでした。",
} as const;

type MenuAt = { x: number; y: number };

/** 押した位置（画面の座標）から、画面の内側に収まる位置へ。 */
function menuAt(x: number, y: number): MenuAt {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - MENU_HEIGHT)),
  };
}

/** 欄の操作を本文の編集に渡さない（Enter で段落が割れる・Backspace で画像が消えるのを防ぐ）。 */
const keepInside = {
  onMouseDown: (event: ReactMouseEvent) => event.stopPropagation(),
  onKeyDown: (event: ReactKeyboardEvent) => event.stopPropagation(),
  onDragStart: (event: ReactMouseEvent) => event.preventDefault(),
} as const;

export function ImageNodeView(props: NodeViewProps) {
  const { node, selected, editor, updateAttributes, deleteNode, getPos, extension } = props;
  const attrs = imageAttrsOf(node.toJSON());
  const options = extension.options as { images?: PageImages | null; srcOf?: ImageSrcOf | null };
  const images = options.images ?? null;
  const editable = editor.isEditable;
  const timer = useRef<number | null>(null);
  const pending = useRef<{ alt?: string | null }>({});
  const moreButton = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [altOpen, setAltOpen] = useState(false);
  // キャプションの入力（開いている間の下書き）。null なら閉じている
  const [captionDraft, setCaptionDraft] = useState<string | null>(null);
  // Enter と離れたときの両方で閉じるので、1 回だけ確定する
  const captionDone = useRef(false);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const patch = pending.current;
    pending.current = {};
    const assetId = attrs?.assetId;
    if (!images || !assetId || Object.keys(patch).length === 0) return;
    void images.saveMeta(assetId, patch);
  }, [attrs?.assetId, images]);

  // 画面を離れる・選択が外れるときに、まだ送っていない欄を送る
  useEffect(() => flush, [flush]);
  useEffect(() => {
    if (!selected) flush();
  }, [selected, flush]);

  const saveAlt = useCallback(
    (alt: string | null) => {
      updateAttributes({ alt });
      pending.current = { ...pending.current, alt };
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, SAVE_DELAY_MS);
    },
    [flush, updateAttributes],
  );

  const closeMenu = useCallback(() => setMenu(null), []);
  const closeAlt = useCallback(() => {
    setAltOpen(false);
    flush();
  }, [flush]);

  if (!attrs) {
    // assetId の無い画像（読めない本文）。画像の枠だけを出す（壊れた src を作らない）
    return (
      <NodeViewWrapper as="figure" data-image="" contentEditable={false}>
        <p className="es-img-warn">{IMAGE_MENU_TEXT.unreadable}</p>
      </NodeViewWrapper>
    );
  }

  /** 画像を選ぶ（右クリックで開いたメニューの操作が、この画像に向くように）。 */
  const selectImage = () => {
    const pos = getPos();
    if (typeof pos === "number") editor.commands.setNodeSelection(pos);
  };

  const onContextMenu = (event: ReactMouseEvent) => {
    if (!editable) return;
    event.preventDefault();
    selectImage();
    setAltOpen(false);
    setMenu(menuAt(event.clientX, event.clientY));
  };

  const toggleMore = () => {
    if (menu) {
      setMenu(null);
      return;
    }
    const box = moreButton.current?.getBoundingClientRect();
    setAltOpen(false);
    setMenu(box ? menuAt(box.right - MENU_WIDTH, box.bottom + 6) : menuAt(8, 8));
  };

  const openCaption = () => {
    captionDone.current = false;
    setCaptionDraft(attrs.caption ?? "");
  };

  const finishCaption = (value: string | null) => {
    if (captionDone.current) return;
    captionDone.current = true;
    setCaptionDraft(null);
    // null は取り消し（Esc）。空のまま確定したら、キャプションを消す
    if (value === null) return;
    const caption = value.trim() === "" ? null : value.trim();
    if (caption !== attrs.caption) updateAttributes({ caption });
  };

  const items: ShellMenuItem[] = [
    { id: "caption", label: attrs.caption ? IMAGE_MENU_TEXT.removeCaption : IMAGE_MENU_TEXT.addCaption, icon: "type" },
    { id: "alt", label: IMAGE_MENU_TEXT.altItem, icon: "edit", hint: attrs.alt ? IMAGE_MENU_TEXT.altOn : IMAGE_MENU_TEXT.altOff },
    { id: "delete", label: IMAGE_MENU_TEXT.remove, icon: "trash", danger: true, separated: true },
  ];

  const pick = (id: string) => {
    setMenu(null);
    if (id === "caption") {
      if (attrs.caption) {
        updateAttributes({ caption: null });
        moreButton.current?.focus();
      } else {
        openCaption();
      }
    } else if (id === "alt") {
      setAltOpen(true);
    } else if (id === "delete") {
      // ふつうの編集（⌘Z で戻せる）。消えたあとは本文へフォーカスを戻す
      flush();
      deleteNode();
      editor.commands.focus();
    }
  };

  const showMore = editable && (selected || menu !== null);
  const editingCaption = editable && captionDraft !== null;

  return (
    <NodeViewWrapper as="figure" data-image="" className="es-img" data-selected={selected ? "" : undefined}>
      <div className="es-img-frame" onContextMenu={onContextMenu}>
        {/* 保存先の src をそのまま読む（画像の最適化・外部 loader を通さない） */}
        <img src={options.srcOf?.(attrs.assetId) ?? ""} alt={attrs.alt ?? ""} data-doc-asset="" data-drag-handle="" draggable={false} />
        {showMore && (
          <button
            ref={moreButton}
            type="button"
            className="es-img-more"
            contentEditable={false}
            aria-label={IMAGE_MENU_TEXT.more}
            title={IMAGE_MENU_TEXT.more}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={toggleMore}
          >
            <Icon name="more" />
          </button>
        )}
      </div>
      {menu && (
        <ShellMenu
          label={IMAGE_MENU_TEXT.menu}
          className="es-menu--at"
          style={{ left: menu.x, top: menu.y }}
          items={items}
          trigger={moreButton}
          onSelect={pick}
          onClose={closeMenu}
        />
      )}
      {editingCaption ? (
        <div className="es-img-cap" contentEditable={false} {...keepInside}>
          <input
            className="es-img-cap-in"
            type="text"
            aria-label={IMAGE_MENU_TEXT.caption}
            placeholder={IMAGE_MENU_TEXT.captionPlaceholder}
            maxLength={IMAGE_CAPTION_MAX_CHARS}
            autoFocus
            value={captionDraft ?? ""}
            onChange={(event) => setCaptionDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                finishCaption(event.currentTarget.value);
                moreButton.current?.focus();
              } else if (event.key === "Escape") {
                event.preventDefault();
                finishCaption(null);
                moreButton.current?.focus();
              }
            }}
            onBlur={(event) => finishCaption(event.currentTarget.value)}
          />
        </div>
      ) : attrs.caption ? (
        // キャプションだけを出す（クレジットは出さない。#344 D）。編集できるときは押すと直せる
        <figcaption className="es-img-cap" contentEditable={false}>
          {editable ? (
            <button type="button" className="es-img-cap-btn" onClick={openCaption}>
              {attrs.caption}
            </button>
          ) : (
            attrs.caption
          )}
        </figcaption>
      ) : null}
      {editable && altOpen && (
        <ImageAltPopover
          alt={attrs.alt}
          onChange={saveAlt}
          onClose={(viaKey) => {
            closeAlt();
            if (viaKey) moreButton.current?.focus();
          }}
        />
      )}
    </NodeViewWrapper>
  );
}

/**
 * 代替テキストのポップオーバー（画像の下）。入力 1 つ。Enter・Esc・外を押すと閉じる。
 * 開いている間だけ外のクリックを見る（閉じている画像は document に何も足さない）。
 */
function ImageAltPopover({ alt, onChange, onClose }: { alt: string | null; onChange: (alt: string | null) => void; onClose: (viaKey: boolean) => void }) {
  const box = useRef<HTMLDivElement | null>(null);
  const closeByPointer = useCallback(() => onClose(false), [onClose]);
  useMenuDismiss(box, closeByPointer);
  return (
    <div ref={box} className="es-img-alt" role="dialog" aria-label={IMAGE_MENU_TEXT.alt} contentEditable={false} {...keepInside}>
      <label>
        {IMAGE_MENU_TEXT.alt}
        <input
          type="text"
          value={alt ?? ""}
          maxLength={IMAGE_ALT_MAX_CHARS}
          autoFocus
          onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== "Escape") return;
            event.preventDefault();
            onClose(true);
          }}
        />
      </label>
      <p>{IMAGE_MENU_TEXT.altNote}</p>
    </div>
  );
}
