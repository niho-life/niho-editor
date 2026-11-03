import { Node, mergeAttributes, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { IMAGE_ACCEPT, IMAGE_MAX_BYTES, IMAGE_PAGE_MAX_COUNT, PAGE_MAX_BYTES } from "./image-limits";
import type { ImageProblem, ImageSrcOf, PageImages } from "./images";
import { ImageNodeView } from "./ImageNodeView";
import { IMAGE_NODE_NAME, imageNode } from "./doc";
import { imageFilesFrom } from "./paste";

/**
 * 本文の画像のノード（#33）。限定 AST（blocks.ts の `image`）と同じ属性だけを持つ。
 *
 * - 置けるのはブロックの位置（block・atom・draggable）。描くのは React の NodeView（ImageNodeView.tsx）で、
 *   `src` はサーバーの中継（`/api/assets/{id}`）。**外の `<img src>` は読み取らない**（本文に URL を持たせない。hotlink を作らない）。
 * - 入れ方は 3 つ: 貼り付け・ドロップ（ファイル）と、「/」「＋」の一覧の「画像」（ファイル選択）。どれも先に private bucket へ
 *   アップロードし、済んでから資産の id でノードを入れる（アップロードできなかったものは本文に入れない）。
 * - 上限を超えた・ページがまだ無いなどで入れられないときは、本文を変えずに、本文のすぐ下に理由を出す（下の showImageProblem）。
 *
 * 口（`images`）と `pageId` は `buildPageExtensions()` から渡す。渡されていなければ画像は入れられない（schema は同じ）。
 */

export type PageImageOptions = {
  /** アップロードと欄の保存の口（null なら入れられない）。 */
  images: PageImages | null;
  /** 今のページの id を返す（まだ作っていなければ null）。 */
  pageId: (() => string | null) | null;
  /** 画像を描く src を組む口（ImageNodeView が読む）。無ければ画像は描けない。 */
  srcOf: ImageSrcOf | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 入れられなかった理由（画面に出す文。英語の code はログ・API 側）。 */
export const IMAGE_PROBLEM_TEXT: Record<ImageProblem, string> = {
  no_page: "先に題名か本文を少し書いてください（ページができてから画像を入れられます）。",
  content_type: "入れられるのは JPEG・PNG・WebP・AVIF・GIF の画像です。",
  too_large: `画像は 1 枚 ${Math.round(IMAGE_MAX_BYTES / (1024 * 1024))}MB までです。`,
  too_many: `1 ページに入れられる画像は ${IMAGE_PAGE_MAX_COUNT} 枚までです。`,
  page_full: `ページの${PAGE_MAX_BYTES / (1024 * 1024)} MiB上限を超えます。不要な画像を本文から外すか、アップロード中の画像を中止してください。録音音声は別枠です。`,
  failed: "画像を入れられませんでした。もう一度試してください。",
};

/** 理由を出しておく時間。 */
const PROBLEM_VISIBLE_MS = 8000;

const problemTimers = new WeakMap<Editor, number>();

/**
 * 本文のすぐ下に理由を出す（本文（AST）には何も書かない）。同じ場所を使い回し、しばらくして消す。
 * 色は docs-ui の token から引く（生の色を増やさない）。
 */
export function showImageProblem(editor: Editor, message: string): void {
  const host = editor.view.dom.parentElement;
  if (!host) return;
  let notice = host.querySelector<HTMLElement>("[data-image-problem]");
  if (!notice) {
    notice = host.ownerDocument.createElement("p");
    notice.setAttribute("data-image-problem", "");
    notice.setAttribute("role", "status");
    notice.style.cssText =
      "margin:8px 0 0;padding:6px 10px;border-radius:8px;font-size:13px;background:var(--docs-warn-bg);color:var(--docs-warn-ink)";
    host.appendChild(notice);
  }
  notice.textContent = message;
  const previous = problemTimers.get(editor);
  if (previous !== undefined) window.clearTimeout(previous);
  problemTimers.set(
    editor,
    window.setTimeout(() => {
      notice?.remove();
      problemTimers.delete(editor);
    }, PROBLEM_VISIBLE_MS),
  );
}

/** アップロードして、済んだものだけを順に入れる。1 つでも断られたら、その理由を出してやめる。 */
async function uploadAndInsert(editor: Editor, images: PageImages, pageId: string, files: readonly File[]): Promise<void> {
  for (const file of files) {
    const controller = new AbortController();
    const host = editor.view.dom.parentElement;
    const progress = host?.ownerDocument.createElement("p");
    if (progress && host) {
      progress.setAttribute("data-image-uploading", "");
      progress.style.cssText = "margin:8px 0 0;font-size:13px;line-height:1.5;overflow-wrap:anywhere";
      progress.append("画像をアップロード中（ページ容量に予約中） ");
      const cancel = progress.ownerDocument.createElement("button");
      cancel.type = "button";
      cancel.textContent = "アップロードを中止";
      cancel.style.cssText = "font-size:13px;color:var(--niho-accent-ink);text-decoration:underline";
      cancel.addEventListener("click", () => controller.abort());
      progress.append(cancel);
      host.append(progress);
    }
    let result;
    try {
      result = await images.upload(file, pageId, controller.signal);
    } finally {
      progress?.remove();
    }
    if (editor.isDestroyed) return;
    if (controller.signal.aborted) return;
    if (!result.ok) {
      showImageProblem(editor, IMAGE_PROBLEM_TEXT[result.problem]);
      return;
    }
    editor.commands.insertPageImage({ assetId: result.assetId, ...result.meta });
  }
}

/** ファイル選択を開く（押した操作の中で開く必要があるので、同期で click する）。 */
function openImagePicker(editor: Editor, images: PageImages, pageId: string): void {
  const doc = editor.view.dom.ownerDocument;
  const input = doc.createElement("input");
  input.type = "file";
  input.accept = IMAGE_ACCEPT;
  input.multiple = true;
  input.style.display = "none";
  doc.body.appendChild(input);
  input.addEventListener("change", () => {
    const files = input.files ? Array.from(input.files) : [];
    input.remove();
    if (files.length > 0) void uploadAndInsert(editor, images, pageId, files);
  });
  // 選ばずに閉じたときも要素を残さない
  input.addEventListener("cancel", () => input.remove());
  input.click();
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pageImage: {
      /** 済んだ資産の画像を入れる（空の段落の上なら、その行を画像にする）。 */
      insertPageImage: (attrs: { assetId: string; alt?: string | null; caption?: string | null; credit?: string | null; consent?: boolean }) => ReturnType;
      /** ファイル選択を開く（「/」「＋」の一覧の「画像」）。口・ページが無ければ理由を出して false。 */
      choosePageImage: () => ReturnType;
    };
  }
}

export const PageImage = Node.create<PageImageOptions>({
  name: IMAGE_NODE_NAME,
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { images: null, pageId: null, srcOf: null };
  },

  addAttributes() {
    return {
      assetId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-asset-id"),
        renderHTML: (attributes) => (typeof attributes.assetId === "string" ? { "data-asset-id": attributes.assetId } : {}),
      },
      alt: {
        default: null,
        parseHTML: (element) => element.getAttribute("alt") || null,
        renderHTML: (attributes) => (typeof attributes.alt === "string" && attributes.alt !== "" ? { alt: attributes.alt } : {}),
      },
      caption: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-caption") || null,
        renderHTML: (attributes) => (typeof attributes.caption === "string" && attributes.caption !== "" ? { "data-caption": attributes.caption } : {}),
      },
      credit: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-credit") || null,
        renderHTML: (attributes) => (typeof attributes.credit === "string" && attributes.credit !== "" ? { "data-credit": attributes.credit } : {}),
      },
      consent: {
        default: false,
        parseHTML: (element) => element.getAttribute("data-consent") === "true",
        renderHTML: (attributes) => (attributes.consent === true ? { "data-consent": "true" } : {}),
      },
    };
  },

  /**
   * 読み取るのは、このエディタが書き出した `img[data-asset-id]`（資産の id が UUID のもの）だけ。
   * 外のサイトの `<img src>` は paste.ts が貼り付けの時点で落とすが、ここでも受け取らない。
   */
  parseHTML() {
    return [
      {
        tag: "img[data-asset-id]",
        getAttrs: (element) => {
          const assetId = element instanceof HTMLElement ? element.getAttribute("data-asset-id") : null;
          return assetId !== null && UUID.test(assetId) ? null : false;
        },
      },
    ];
  },

  /** 書き出し（コピー・`getHTML`）は資産の id だけ。中継の URL は入れない（外に貼ったときに読める値を残さない）。 */
  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes({ "data-doc-asset": "" }, HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView);
  },

  addCommands() {
    return {
      insertPageImage:
        (attrs) =>
        ({ state, chain }) => {
          if (typeof attrs.assetId !== "string" || !UUID.test(attrs.assetId)) return false;
          const { $from, empty } = state.selection;
          const parent = $from.parent;
          // 空の段落（本文の直下）にいるなら、その行を画像に置き換える。そうでなければ選択の後ろに入れる
          const blank = empty && $from.depth === 1 && parent.type.name === "paragraph" && parent.content.size === 0;
          const at = blank ? { from: $from.before(), to: $from.after() } : state.selection.to;
          return chain()
            .insertContentAt(at, imageNode(attrs), { updateSelection: true })
            .focus()
            .run();
        },
      choosePageImage:
        () =>
        ({ editor }) => {
          const { images, pageId } = this.options;
          if (!images) return false;
          const id = pageId?.() ?? null;
          if (id === null) {
            showImageProblem(editor, IMAGE_PROBLEM_TEXT.no_page);
            return false;
          }
          openImagePicker(editor, images, id);
          return true;
        },
    };
  },

  /** 貼り付けとドロップのファイル（画像）を受け取る。アップロードしてから入れるので、本文の変更は済んだ後。 */
  addProseMirrorPlugins() {
    const options = this.options;
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("pageImageFiles"),
        props: {
          handlePaste: (_view, event) => {
            const files = imageFilesFrom(event.clipboardData);
            if (files.length === 0) return false;
            // 口が無ければ既定の扱いに任せる（画像の HTML は paste.ts が落とすので、本文には入らない）
            if (!options.images) return false;
            event.preventDefault();
            const id = options.pageId?.() ?? null;
            if (id === null) {
              showImageProblem(editor, IMAGE_PROBLEM_TEXT.no_page);
              return true;
            }
            void uploadAndInsert(editor, options.images, id, files);
            return true;
          },
          handleDrop: (view, event, _slice, moved) => {
            // エディタの中のノードを動かしているときは files が無い（ProseMirror に任せる）
            if (moved) return false;
            const files = imageFilesFrom(event.dataTransfer);
            if (files.length === 0) return false;
            if (!options.images) return false;
            event.preventDefault();
            const id = options.pageId?.() ?? null;
            if (id === null) {
              showImageProblem(editor, IMAGE_PROBLEM_TEXT.no_page);
              return true;
            }
            // 落とした場所に入れる（アップロードの前にカーソルを移しておく）。位置が分からない環境では今の位置のまま
            try {
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (at) editor.commands.setTextSelection(at.pos);
            } catch {
              // 置き場の計算ができない（描画の API が無い）: 今の選択のままにする
            }
            void uploadAndInsert(editor, options.images, id, files);
            return true;
          },
        },
      }),
    ];
  },
});
