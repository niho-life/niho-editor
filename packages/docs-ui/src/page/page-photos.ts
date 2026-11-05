import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { IMAGE_NODE_NAME, imageNode } from "./doc";
import type { ImageMeta } from "./images";

/*
 * 「このページの写真」（パネル）と本文をつなぐ、エディタの操作（Mac・Web で共通。通信は持たない）。
 * 写真の原本はパネル（そのページの画像の資産）にあり、本文の画像ノードはその資産の id を指す。
 * - パネルのタイルを本文へドラッグすると、独自の MIME（PAGE_IMAGE_DRAG_TYPE）で資産の id と欄を渡す（image-node.ts が受ける）。
 * - 「本文に入れる」は最後にカーソルのあった段落の後ろへ入れる。
 * - パネルから外したら、本文の全ての出現を消す。
 * どれも通常の editor の transaction なので、自動保存と Undo に乗る。
 */

/** パネルのタイルのドラッグの中身の種類（中身は JSON の PagePhotoDrag）。ファイルのドロップ・本文の中の移動とは別。 */
export const PAGE_IMAGE_DRAG_TYPE = "application/x-niho-page-image";

/** タイルのドラッグで渡すもの（資産の id と、本文のノードに写す欄）。 */
export type PagePhotoDrag = { assetId: string } & ImageMeta;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ドラッグの中身を作る（dataTransfer.setData に渡す文字）。 */
export function encodePagePhotoDrag(photo: PagePhotoDrag): string {
  return JSON.stringify({ assetId: photo.assetId, alt: photo.alt, credit: photo.credit, consent: photo.consent });
}

/** ドロップの dataTransfer から、パネルのタイルの中身を読む（タイルでない・形が違えば null）。 */
export function pagePhotoFrom(data: Pick<DataTransfer, "getData" | "types"> | null | undefined): PagePhotoDrag | null {
  if (!data || typeof data.getData !== "function") return null;
  const types = data.types ? Array.from(data.types) : [];
  if (!types.includes(PAGE_IMAGE_DRAG_TYPE)) return null;
  let value: unknown;
  try {
    value = JSON.parse(data.getData(PAGE_IMAGE_DRAG_TYPE));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.assetId !== "string" || !UUID.test(raw.assetId)) return null;
  const text = (item: unknown) => (typeof item === "string" && item !== "" ? item : null);
  return { assetId: raw.assetId, alt: text(raw.alt), credit: text(raw.credit), consent: raw.consent === true };
}

/** 本文で使っている写真（資産の id を小文字にしたもの → 出てくる数）。 */
export function pageImageUses(doc: ProseMirrorNode): Map<string, number> {
  const uses = new Map<string, number>();
  doc.descendants((node) => {
    if (node.type.name !== IMAGE_NODE_NAME) return true;
    const id = node.attrs.assetId;
    if (typeof id === "string") uses.set(id.toLowerCase(), (uses.get(id.toLowerCase()) ?? 0) + 1);
    return false;
  });
  return uses;
}

/**
 * 「本文に入れる」: 最後にカーソルのあった段落（本文の直下のブロック）の後ろへ入れる。空の段落（本文の直下）にいれば、その行を
 * 画像にする（image-node.ts の insertPageImage と同じ）。入れた画像を選び、見える位置へ動かす。入れられなければ false。
 */
export function insertPageImageAfterCursor(editor: Editor, photo: PagePhotoDrag): boolean {
  if (!UUID.test(photo.assetId) || !editor.isEditable) return false;
  const { selection } = editor.state;
  const { $from, $to, empty } = selection;
  const node = imageNode(photo);
  const blank = empty && $from.depth === 1 && $from.parent.type.name === "paragraph" && $from.parent.content.size === 0;
  const at = blank ? { from: $from.before(), to: $from.after() } : $to.depth >= 1 ? $to.after(1) : selection.to;
  return editor.chain().insertContentAt(at, node, { updateSelection: true }).scrollIntoView().run();
}

/** 指定した写真の画像ノードを本文から全て消す（パネルから外したあと）。消した数を返す。 */
export function removePageImageNodes(editor: Editor, assetId: string): number {
  const id = assetId.toLowerCase();
  const ranges: Array<{ from: number; to: number }> = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== IMAGE_NODE_NAME) return true;
    if (typeof node.attrs.assetId === "string" && node.attrs.assetId.toLowerCase() === id) ranges.push({ from: pos, to: pos + node.nodeSize });
    return false;
  });
  if (ranges.length === 0 || editor.isDestroyed) return 0;
  const tr = editor.state.tr;
  // 後ろから消す（前を消すと後ろの位置がずれる）
  for (const range of ranges.reverse()) tr.delete(tr.mapping.map(range.from), tr.mapping.map(range.to));
  editor.view.dispatch(tr);
  return ranges.length;
}

/** パネルで直した欄（alt・クレジット・掲載許諾）を、本文のその写真の画像ノード全てにも写す。写した数を返す。 */
export function updatePageImageNodes(editor: Editor, assetId: string, patch: Partial<ImageMeta>): number {
  const id = assetId.toLowerCase();
  const tr = editor.state.tr;
  let count = 0;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== IMAGE_NODE_NAME) return true;
    if (typeof node.attrs.assetId === "string" && node.attrs.assetId.toLowerCase() === id) {
      const attrs = { ...node.attrs };
      if (patch.alt !== undefined) attrs.alt = patch.alt === "" ? null : patch.alt;
      if (patch.credit !== undefined) attrs.credit = patch.credit === "" ? null : patch.credit;
      if (patch.consent !== undefined) attrs.consent = patch.consent;
      tr.setNodeMarkup(pos, undefined, attrs);
      count++;
    }
    return false;
  });
  if (count > 0 && !editor.isDestroyed) editor.view.dispatch(tr);
  return count;
}

/** パネル（PagePhotos.tsx）が本文に対して行うこと。host が開いているページのエディタから作る（pagePhotosBody）。 */
export type PagePhotosBody = {
  /** 本文で使っている写真（資産の id を小文字にしたもの → 出てくる数）。読むたびに今の本文を数える。 */
  uses: () => ReadonlyMap<string, number>;
  /** 本文が変わったら onChange（少しまとめて呼ぶ）。返す関数で外す。 */
  subscribe: (onChange: () => void) => () => void;
  /** 最後にカーソルのあった段落の後ろへ入れる。入れられなければ false。無ければ「本文に入れる」を出さない。 */
  insert?: (photo: PagePhotoDrag) => boolean;
  /** パネルで直した欄を、本文のその写真のノードにも写す。 */
  update?: (assetId: string, patch: Partial<ImageMeta>) => void;
  /** パネルから外した（サーバーで消えた）あとに、本文の全ての出現とカバーから消す。 */
  removed: (assetId: string) => void;
};

/** 本文の変更をまとめる間（打つたびに本文を数えない）。 */
const USES_DELAY_MS = 120;

/**
 * 開いているページのエディタから、パネルが使う本文の操作を作る。カバーを外すのは host の保存の経路（clearCover）に任せる。
 * 本文を変える操作はどれも通常の transaction（自動保存・Undo に乗る）。
 */
export function pagePhotosBody(editor: Editor, options: { clearCover?: (assetId: string) => void } = {}): PagePhotosBody {
  return {
    uses: () => (editor.isDestroyed ? new Map() : pageImageUses(editor.state.doc)),
    subscribe: (onChange) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const handler = ({ transaction }: { transaction: { docChanged: boolean } }) => {
        if (!transaction.docChanged) return;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          onChange();
        }, USES_DELAY_MS);
      };
      editor.on("transaction", handler);
      return () => {
        if (timer !== null) clearTimeout(timer);
        editor.off("transaction", handler);
      };
    },
    insert: (photo) => insertPageImageAfterCursor(editor, photo),
    update: (assetId, patch) => {
      updatePageImageNodes(editor, assetId, patch);
    },
    removed: (assetId) => {
      removePageImageNodes(editor, assetId);
      options.clearCover?.(assetId);
    },
  };
}
