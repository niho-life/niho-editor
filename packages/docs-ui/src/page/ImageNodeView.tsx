"use client";

import { useCallback, useEffect, useRef } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { IMAGE_ALT_MAX_CHARS, IMAGE_CAPTION_MAX_CHARS, IMAGE_CREDIT_MAX_CHARS } from "./image-limits";
import type { ImageSrcOf, PageImages } from "./images";
import { imageAttrsOf } from "./doc";

/**
 * 本文の画像（#33）。実体は private bucket にあり、`src` はサーバーの中継（`/api/assets/{id}`）だけを指す
 * （署名付き URL はブラウザへ渡さない。CSP の `img-src 'self'` のまま）。
 *
 * **画像を選ぶと、alt・クレジット・掲載許諾の欄をここに出す**（他の部品は触らない）。直した値は
 * ノードの属性（本文の自動保存に乗る）と、資産の行（`PATCH /api/assets/{id}`。共有リンクの描画が読む正本）の両方へ書く。
 * 欄は本文の編集から切り離す（`contentEditable={false}`・キーは外に伝えない）ので、入力中の Backspace で画像が消えない。
 */

/** 欄を直してから資産の行へ書くまでの間（打っている間は送らない）。 */
const SAVE_DELAY_MS = 600;

const FIELDS_STYLE = {
  display: "grid",
  gap: "6px",
  margin: "6px 0 10px",
  padding: "10px",
  border: "1px solid var(--docs-line-firm)",
  borderRadius: "10px",
  background: "var(--niho-card)",
  maxWidth: "min(100%, 720px)",
  fontSize: "13px",
} as const;

const LABEL_STYLE = { display: "grid", gap: "2px", color: "var(--niho-text-sub)" } as const;

const INPUT_STYLE = {
  padding: "6px 8px",
  border: "1px solid var(--docs-ctl-line)",
  borderRadius: "8px",
  background: "var(--niho-card)",
  color: "var(--niho-text)",
  font: "inherit",
} as const;

const CHECK_STYLE = { display: "flex", alignItems: "center", gap: "6px", color: "var(--niho-text-sub)" } as const;

const CAPTION_STYLE = { margin: "-4px 0 10px", color: "var(--niho-text-muted)", fontSize: "12px" } as const;

const WARN_STYLE = { margin: 0, color: "var(--docs-warn-ink)", fontSize: "12px" } as const;

export function ImageNodeView(props: NodeViewProps) {
  const { node, selected, editor, updateAttributes, extension } = props;
  const attrs = imageAttrsOf(node.toJSON());
  const options = extension.options as { images?: PageImages | null; srcOf?: ImageSrcOf | null };
  const images = options.images ?? null;
  const editable = editor.isEditable;
  const timer = useRef<number | null>(null);
  const pending = useRef<{ alt?: string | null; credit?: string | null; consent?: boolean }>({});

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

  const save = useCallback(
    (patch: { alt?: string | null; caption?: string | null; credit?: string | null; consent?: boolean }) => {
      updateAttributes(patch);
      const { caption: _caption, ...assetPatch } = patch;
      pending.current = { ...pending.current, ...assetPatch };
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, SAVE_DELAY_MS);
    },
    [flush, updateAttributes],
  );

  if (!attrs) {
    // assetId の無い画像（読めない本文）。画像の枠だけを出す（壊れた src を作らない）
    return (
      <NodeViewWrapper as="figure" data-image="" contentEditable={false}>
        <p style={WARN_STYLE}>画像を読み込めませんでした。</p>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="figure" data-image="" data-selected={selected ? "" : undefined}>
      {/* 保存先の src をそのまま読む（画像の最適化・外部 loader を通さない） */}
      <img src={options.srcOf?.(attrs.assetId) ?? ""} alt={attrs.alt ?? ""} data-doc-asset="" data-drag-handle="" draggable={false} />
      {(attrs.caption || attrs.credit) && !(selected && editable) ? (
        <figcaption style={CAPTION_STYLE} contentEditable={false}>
          {attrs.caption}{attrs.caption && attrs.credit ? " — " : ""}{attrs.credit}
        </figcaption>
      ) : null}
      {selected && editable ? (
        <div
          style={FIELDS_STYLE}
          contentEditable={false}
          // 欄の操作を本文の編集に渡さない（Enter で段落が割れる・Backspace で画像が消えるのを防ぐ）
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onDragStart={(event) => event.preventDefault()}
        >
          <label style={LABEL_STYLE}>
            代替テキスト（alt）
            <input
              type="text"
              value={attrs.alt ?? ""}
              maxLength={IMAGE_ALT_MAX_CHARS}
              style={INPUT_STYLE}
              placeholder="写真の内容を短く"
              onChange={(event) => save({ alt: event.target.value === "" ? null : event.target.value })}
              onBlur={flush}
            />
          </label>
          <label style={LABEL_STYLE}>
            キャプション
            <input
              type="text"
              value={attrs.caption ?? ""}
              maxLength={IMAGE_CAPTION_MAX_CHARS}
              style={INPUT_STYLE}
              placeholder="写真と一緒に表示する説明"
              onChange={(event) => save({ caption: event.target.value === "" ? null : event.target.value })}
            />
          </label>
          <label style={LABEL_STYLE}>
            クレジット
            <input
              type="text"
              value={attrs.credit ?? ""}
              maxLength={IMAGE_CREDIT_MAX_CHARS}
              style={INPUT_STYLE}
              placeholder="撮影者・提供元"
              onChange={(event) => save({ credit: event.target.value === "" ? null : event.target.value })}
              onBlur={flush}
            />
          </label>
          <label style={CHECK_STYLE}>
            <input type="checkbox" checked={attrs.consent} onChange={(event) => save({ consent: event.target.checked })} onBlur={flush} />
            掲載許諾を得ている
          </label>
          {attrs.consent ? null : <p style={WARN_STYLE}>公開の前に掲載許諾を確かめてください。</p>}
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}
