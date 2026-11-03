import type { Editor, JSONContent } from "@tiptap/core";

/**
 * 保存されている blocks（限定 AST。blocks.ts）と TipTap の doc の行き来。
 * ブロックの形は両方で同じなので、doc は content を包むだけ。画像だけは属性の既定値があるので、ここで形を揃える
 * （TipTap は宣言した属性を必ず書き出し、値の無いものは null にする。限定 AST は null を落として assetId だけを残す）。
 */

/** 画像のノードの名前（限定 AST・エディタの schema で同じ）。 */
export const IMAGE_NODE_NAME = "image";

/** 画像の属性。caption は本文、credit は撮影者・提供元で、別々に保持する。 */
export type ImageAttrs = { assetId: string; alt: string | null; caption: string | null; credit: string | null; consent: boolean };

/** 保存されている blocks を TipTap の doc にする（空のページは空の段落 1 つ）。 */
export function docFromBlocks(blocks: unknown[]): JSONContent {
  return { type: "doc", content: blocks.length > 0 ? (blocks as JSONContent[]) : [{ type: "paragraph" }] };
}

function isNode(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** 画像のノード（TipTap に入れる形。保存するときも同じ形から限定 AST の検査を通る）。 */
export function imageNode(attrs: { assetId: string; alt?: string | null; caption?: string | null; credit?: string | null; consent?: boolean }): JSONContent {
  return {
    type: IMAGE_NODE_NAME,
    attrs: { assetId: attrs.assetId, alt: text(attrs.alt), caption: text(attrs.caption), credit: text(attrs.credit), consent: attrs.consent === true },
  };
}

/** 画像のノードの属性を読む（TipTap の node・保存された block のどちらからも。画像でなければ null）。 */
export function imageAttrsOf(node: unknown): ImageAttrs | null {
  if (!isNode(node) || node.type !== IMAGE_NODE_NAME) return null;
  const attrs = isNode(node.attrs) ? node.attrs : {};
  const assetId = typeof attrs.assetId === "string" ? attrs.assetId : null;
  if (assetId === null) return null;
  return { assetId, alt: text(attrs.alt), caption: text(attrs.caption), credit: text(attrs.credit), consent: attrs.consent === true };
}

/**
 * 本文を blocks に差し替える（端末の下書き・AI の採用の結果・競合の応答のページ）。今の schema で読めなければ載せずに false。
 * 載せたこと自体は Undo の対象にしない（直後の Undo で載せた本文を消さない）。onUpdate（自動保存・下書き）も起こさない。
 */
export function replaceBlocks(editor: Editor, blocks: unknown[]): boolean {
  const doc = docFromBlocks(blocks);
  try {
    editor.schema.nodeFromJSON(doc).check();
  } catch {
    return false;
  }
  editor.chain().setMeta("addToHistory", false).setContent(doc, { emitUpdate: false }).run();
  return true;
}
