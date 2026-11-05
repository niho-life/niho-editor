// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { TextSelection, type Plugin } from "@tiptap/pm/state";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { validateBlocks } from "./blocks";
import type { PageImages } from "./images";
import { buildPageExtensions } from "./page-extensions";
import {
  PAGE_IMAGE_DRAG_TYPE,
  encodePagePhotoDrag,
  insertPageImageAfterCursor,
  pageImageUses,
  pagePhotoFrom,
  pagePhotosBody,
  removePageImageNodes,
  updatePageImageNodes,
} from "./page-photos";

// 合成の資産の id だけを使う（実在の画像は入れない）
const A = "9a1f3b1c-0d11-4c39-9a52-6f6c6f1d0d7c";
const B = "1b2c3d4e-0d11-4c39-9a52-6f6c6f1d0d7c";

beforeAll(() => {
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  Range.prototype.getBoundingClientRect = rect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Element.prototype.scrollIntoView = () => undefined;
});

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const p = (value?: string): JSONContent => (value ? { type: "paragraph", content: [{ type: "text", text: value }] } : { type: "paragraph" });
const img = (assetId: string): JSONContent => ({ type: "image", attrs: { assetId } });

const IMAGES: PageImages = { upload: async () => ({ ok: false, problem: "failed" }), saveMeta: async () => true };

function makeEditor(content: JSONContent[]): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  editor = new Editor({ element, extensions: buildPageExtensions({ images: IMAGES, pageId: () => null, srcOf: (id) => `/api/assets/${id}` }), content: { type: "doc", content } });
  return editor;
}

function blocks(current: Editor) {
  const result = validateBlocks(current.getJSON().content ?? []);
  if (!result.ok) throw new Error(`the editor produced a body the server would refuse: ${result.reason}`);
  return result.blocks;
}

const types = (current: Editor) => blocks(current).map((block) => (block.type === "image" ? `image:${(block.attrs as { assetId: string }).assetId.slice(0, 2)}` : `${block.type}`));

/** dataTransfer の代わり（jsdom には DataTransfer が無い）。 */
function transfer(data: Record<string, string>, files: File[] = []) {
  return { types: [...Object.keys(data), ...(files.length > 0 ? ["Files"] : [])], getData: (type: string) => data[type] ?? "", files };
}

function filesPlugin(current: Editor): Plugin {
  const plugin = current.view.state.plugins.find((item) => String((item as { key?: unknown }).key ?? "").startsWith("pageImageFiles"));
  expect(plugin).toBeDefined();
  return plugin!;
}

describe("page photos in the body", () => {
  it("counts every use of a photo, nested ones too", () => {
    const current = makeEditor([img(A), p("一"), { type: "blockquote", content: [img(A), p("引用")] }, img(B)]);
    const uses = pageImageUses(current.state.doc);
    expect(uses.get(A)).toBe(2);
    expect(uses.get(B)).toBe(1);
    expect(uses.size).toBe(2);
  });

  it("inserts after the block where the cursor was, and replaces an empty line", () => {
    const current = makeEditor([p("一"), p("二"), p()]);
    // 「一」の途中にカーソル（段落を割らず、その段落の後ろに入る）
    current.view.dispatch(current.state.tr.setSelection(TextSelection.create(current.state.doc, 2)));
    expect(insertPageImageAfterCursor(current, { assetId: A, alt: "合成", credit: null, consent: true })).toBe(true);
    expect(types(current)).toEqual(["paragraph", "image:9a", "paragraph", "paragraph"]);
    expect(blocks(current)[1]).toEqual({ type: "image", attrs: { assetId: A, alt: "合成", consent: true } });
    // 空の行にいれば、その行を画像にする
    const end = current.state.doc.content.size - 1;
    current.view.dispatch(current.state.tr.setSelection(TextSelection.create(current.state.doc, end)));
    expect(insertPageImageAfterCursor(current, { assetId: B, alt: null, credit: null, consent: false })).toBe(true);
    // 最後の画像の後ろには、書き続けられるよう空の段落が足される（schema の既定）
    expect(types(current)).toEqual(["paragraph", "image:9a", "paragraph", "image:1b", "paragraph"]);
    // 形の違う id は入れない
    expect(insertPageImageAfterCursor(current, { assetId: "x", alt: null, credit: null, consent: false })).toBe(false);
  });

  it("removes every use of a photo in one transaction and leaves a valid body", () => {
    const current = makeEditor([img(A), p("一"), { type: "blockquote", content: [p("引用"), img(A)] }, img(B)]);
    const updates = vi.fn();
    current.on("update", updates);
    expect(removePageImageNodes(current, A.toUpperCase())).toBe(2);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(pageImageUses(current.state.doc).has(A)).toBe(false);
    expect(types(current)).toEqual(["paragraph", "blockquote", "image:1b", "paragraph"]);
    expect(removePageImageNodes(current, A)).toBe(0);
    // 最後の 1 枚を消しても、本文は空の段落になる（保存できる形のまま）
    const only = makeEditor([img(B)]);
    expect(removePageImageNodes(only, B)).toBe(1);
    expect(blocks(only)).toEqual([{ type: "paragraph" }]);
  });

  it("copies the panel's fields into every use of the photo", () => {
    const current = makeEditor([img(A), p("一"), img(A), img(B)]);
    expect(updatePageImageNodes(current, A, { alt: "合成の写真", consent: true })).toBe(2);
    const images = blocks(current).filter((block) => block.type === "image");
    expect(images.map((block) => block.attrs)).toEqual([
      { assetId: A, alt: "合成の写真", consent: true },
      { assetId: A, alt: "合成の写真", consent: true },
      { assetId: B, consent: false },
    ]);
  });

  it("reads only a well-formed panel tile from a drop", () => {
    const photo = { assetId: A, alt: "合成", credit: "合成の提供元", consent: true };
    expect(pagePhotoFrom(transfer({ [PAGE_IMAGE_DRAG_TYPE]: encodePagePhotoDrag(photo) }) as never)).toEqual(photo);
    expect(pagePhotoFrom(transfer({ [PAGE_IMAGE_DRAG_TYPE]: "{" }) as never)).toBeNull();
    expect(pagePhotoFrom(transfer({ [PAGE_IMAGE_DRAG_TYPE]: JSON.stringify({ assetId: "../x" }) }) as never)).toBeNull();
    expect(pagePhotoFrom(transfer({ "text/plain": A }) as never)).toBeNull();
    expect(pagePhotoFrom({ files: [] } as never)).toBeNull();
    expect(pagePhotoFrom(null)).toBeNull();
  });

  it("puts a dropped panel tile into the body without uploading, and keeps file drops and moves as they were", () => {
    const upload = vi.fn(async () => ({ ok: false as const, problem: "failed" as const }));
    const element = document.createElement("div");
    document.body.appendChild(element);
    const current = new Editor({ element, extensions: buildPageExtensions({ images: { ...IMAGES, upload }, pageId: () => "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11" }), content: { type: "doc", content: [p("一")] } });
    editor = current;
    const plugin = filesPlugin(current);
    const drop = (dataTransfer: unknown, moved = false) =>
      plugin.props.handleDrop!.call(plugin, current.view, { dataTransfer, preventDefault: () => undefined, clientX: 0, clientY: 0 } as unknown as DragEvent, Slice.empty, moved);
    expect(drop(transfer({ [PAGE_IMAGE_DRAG_TYPE]: encodePagePhotoDrag({ assetId: A, alt: "合成", credit: null, consent: false }) }))).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    expect(blocks(current).filter((block) => block.type === "image")).toEqual([{ type: "image", attrs: { assetId: A, alt: "合成", consent: false } }]);
    // 本文の中の移動は ProseMirror に任せる・何も無いドロップは受けない
    expect(drop(transfer({ [PAGE_IMAGE_DRAG_TYPE]: encodePagePhotoDrag({ assetId: B, alt: null, credit: null, consent: false }) }), true)).toBe(false);
    expect(drop(transfer({}))).toBe(false);
    // ファイルのドロップは今まで通りアップロードする
    expect(drop(transfer({}, [new File([new Uint8Array([1])], "合成.png", { type: "image/png" })]))).toBe(true);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("bridges the editor for the panel: counts after changes, inserts, removes with the cover", async () => {
    vi.useFakeTimers();
    const current = makeEditor([p("一")]);
    const clearCover = vi.fn();
    const body = pagePhotosBody(current, { clearCover });
    const changed = vi.fn();
    const stop = body.subscribe(changed);
    expect(body.insert?.({ assetId: A, alt: null, credit: null, consent: false })).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(body.uses().get(A)).toBe(1);
    body.removed(A);
    expect(body.uses().has(A)).toBe(false);
    expect(clearCover).toHaveBeenCalledWith(A);
    // 外したら、まとめていた分も含めて知らせない
    stop();
    body.insert?.({ assetId: B, alt: null, credit: null, consent: false });
    await vi.advanceTimersByTimeAsync(200);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
