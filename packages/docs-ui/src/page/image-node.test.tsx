// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import type { Plugin } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { validateBlocks } from "./blocks";
import type { ImageMeta, PageImages } from "./images";
import { IMAGE_PROBLEM_TEXT } from "./image-node";
import { buildPageExtensions, type PageExtensionsOptions } from "./page-extensions";

// 合成のページ・資産の id と、1 バイトの偽のファイルだけを使う（実在の画像は入れない）
const PAGE = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const ASSET = "9a1f3b1c-0d11-4c39-9a52-6f6c6f1d0d7c";
/** 画像を描く src を組む口（Web はサーバーの中継の path、Mac は asset protocol の URL）。 */
const srcOf = (assetId: string) => `/api/assets/${assetId}`;

beforeAll(() => {
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  Range.prototype.getBoundingClientRect = rect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Element.prototype.scrollIntoView = () => undefined;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLElement | null = null;
let mountedEditor: Editor | null = null;

afterEach(async () => {
  // Tiptap's useEditor waits one tick after unmount before destroying the editor.
  // Restore real timers first, then keep jsdom alive until that public event fires.
  vi.useRealTimers();
  const editor = mountedEditor;
  let waitForDestroy: Promise<void> | null = null;
  if (editor && !editor.isDestroyed) {
    waitForDestroy = new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const onDestroy = () => {
        if (timeout !== undefined) clearTimeout(timeout);
        resolve();
      };
      editor.on("destroy", onDestroy);
      timeout = setTimeout(() => {
        editor.off("destroy", onDestroy);
        reject(new Error("Tiptap editor was not destroyed before the test environment closed"));
      }, 1000);
    });
  }

  try {
    await act(async () => root?.unmount());
    await waitForDestroy;
  } finally {
    container?.remove();
    root = null;
    container = null;
    mountedEditor = null;
    vi.restoreAllMocks();
  }
});

type Uploaded = { file: File; pageId: string };

/** 合成のアップロードの口（本物の fetch は呼ばない）。 */
function stubImages(result?: Awaited<ReturnType<PageImages["upload"]>>) {
  const uploads: Uploaded[] = [];
  const metas: Array<{ assetId: string; patch: Partial<ImageMeta> }> = [];
  const images: PageImages = {
    upload: async (file, pageId) => {
      uploads.push({ file, pageId });
      return result ?? { ok: true, assetId: ASSET, meta: { alt: null, credit: null, consent: false } };
    },
    saveMeta: async (assetId, patch) => {
      metas.push({ assetId, patch });
      return true;
    },
  };
  return { images, uploads, metas };
}

function Harness({ options }: { options: PageExtensionsOptions }) {
  const editor = useEditor({
    extensions: buildPageExtensions({ srcOf, ...options }),
    content: { type: "doc", content: [{ type: "paragraph" }] },
    immediatelyRender: false,
    editorProps: { attributes: { class: "doc", "aria-label": "本文" } },
  });
  return (
    <div data-docs-app-root="" data-docs-shared-ui="">
      <div className="be">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 10; index++) await Promise.resolve();
  });
}

async function render(options: PageExtensionsOptions): Promise<Editor> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Harness options={options} />);
  });
  const editor = (container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;
  mountedEditor = editor;
  await flush();
  return editor;
}

/** 貼り付け・ドロップのファイルを受ける plugin（他の plugin を通さずに、この prop だけを試す）。 */
function filesPlugin(editor: Editor): Plugin {
  const plugin = editor.view.state.plugins.find((item) => String((item as { key?: unknown }).key ?? "").startsWith("pageImageFiles"));
  expect(plugin, "the image files plugin is in the editor").toBeDefined();
  return plugin!;
}

const pngFile = (name = "合成.png", type = "image/png") => new File([new Uint8Array([1])], name, { type });

function pasteFiles(editor: Editor, files: File[]): boolean {
  const event = { clipboardData: { files }, preventDefault: () => undefined } as unknown as ClipboardEvent;
  return filesPlugin(editor).props.handlePaste!.call(filesPlugin(editor), editor.view, event, Slice.empty) === true;
}

function dropFiles(editor: Editor, files: File[], moved = false): boolean {
  const event = { dataTransfer: { files }, preventDefault: () => undefined, clientX: 0, clientY: 0 } as unknown as DragEvent;
  return filesPlugin(editor).props.handleDrop!.call(filesPlugin(editor), editor.view, event, Slice.empty, moved) === true;
}

function savedBlocks(editor: Editor) {
  const result = validateBlocks(editor.getJSON().content ?? []);
  if (!result.ok) throw new Error(`the editor produced a body the server would refuse: ${result.reason}`);
  return result.blocks;
}

/** React が見ている value を変えて input を起こす（素の代入では onChange が走らない）。 */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const problem = () => container!.querySelector("[data-image-problem]")?.textContent ?? null;
const images = () => [...container!.querySelectorAll("img")];
const field = (label: string) =>
  [...container!.querySelectorAll("label")].find((item) => item.textContent?.includes(label))?.querySelector("input") ?? null;

describe("the image node", () => {
  it("uploads a pasted file and inserts only the asset id, with the relay as the src", async () => {
    const { images: port, uploads } = stubImages();
    const editor = await render({ images: port, pageId: () => PAGE });
    expect(pasteFiles(editor, [pngFile()])).toBe(true);
    await flush();
    expect(uploads).toEqual([{ file: expect.any(File), pageId: PAGE }]);
    // 本文に入るのは資産の id だけ（URL は入らない）
    expect(savedBlocks(editor)).toEqual([{ type: "image", attrs: { assetId: ASSET, consent: false } }, { type: "paragraph" }]);
    expect(JSON.stringify(editor.getJSON())).not.toContain("/api/assets");
    // 描くときだけ中継の path を使う
    expect(images().map((item) => item.getAttribute("src"))).toEqual([srcOf(ASSET)]);
    expect(images()[0]!.getAttribute("alt")).toBe("");
  });

  it("uploads a dropped file, and leaves a drag inside the body and a drop without files alone", async () => {
    const { images: port, uploads } = stubImages();
    const editor = await render({ images: port, pageId: () => PAGE });
    expect(dropFiles(editor, [pngFile()])).toBe(true);
    await flush();
    expect(uploads).toHaveLength(1);
    expect(savedBlocks(editor).map((block) => block.type)).toEqual(["image", "paragraph"]);
    // 本文のノードを動かしているとき・ファイルが無いときは、ProseMirror の既定に任せる
    expect(dropFiles(editor, [pngFile()], true)).toBe(false);
    expect(dropFiles(editor, [])).toBe(false);
    expect(pasteFiles(editor, [])).toBe(false);
    // 画像でないファイルは受け取らない（文字として貼られる）
    expect(pasteFiles(editor, [new File(["x"], "a.txt", { type: "text/plain" })])).toBe(false);
    await flush();
    expect(uploads).toHaveLength(1);
  });

  it("puts nothing in the body when the upload is refused, and says why", async () => {
    const { images: port } = stubImages({ ok: false, problem: "too_large" });
    const editor = await render({ images: port, pageId: () => PAGE });
    expect(pasteFiles(editor, [pngFile()])).toBe(true);
    await flush();
    expect(savedBlocks(editor)).toEqual([{ type: "paragraph" }]);
    expect(problem()).toBe(IMAGE_PROBLEM_TEXT.too_large);
    expect(images()).toHaveLength(0);
  });

  it("shows a cancel control while upload is pending and leaves the body unchanged after cancellation", async () => {
    let finish: ((value: Awaited<ReturnType<PageImages["upload"]>>) => void) | undefined;
    let signal: AbortSignal | undefined;
    const port: PageImages = {
      upload: async (_file, _pageId, received) => {
        signal = received;
        return new Promise((resolve) => { finish = resolve; });
      },
      saveMeta: async () => true,
    };
    const editor = await render({ images: port, pageId: () => PAGE });
    expect(pasteFiles(editor, [pngFile()])).toBe(true);
    await flush();
    const cancel = container!.querySelector<HTMLButtonElement>("[data-image-uploading] button");
    expect(cancel?.textContent).toBe("アップロードを中止");
    await act(async () => cancel!.click());
    expect(signal?.aborted).toBe(true);
    finish!({ ok: false, problem: "failed" });
    await flush();
    expect(container!.querySelector("[data-image-uploading]")).toBeNull();
    expect(problem()).toBeNull();
    expect(savedBlocks(editor)).toEqual([{ type: "paragraph" }]);
  });

  it("says to write something first when the page is not created yet, and does not upload", async () => {
    const { images: port, uploads } = stubImages();
    const editor = await render({ images: port, pageId: () => null });
    expect(pasteFiles(editor, [pngFile()])).toBe(true);
    await flush();
    expect(uploads).toHaveLength(0);
    expect(problem()).toBe(IMAGE_PROBLEM_TEXT.no_page);
    expect(savedBlocks(editor)).toEqual([{ type: "paragraph" }]);
  });

  it("shows the alt, credit and consent fields when the image is selected, and saves what is typed", async () => {
    const { images: port, metas } = stubImages();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const editor = await render({ images: port, pageId: () => PAGE });
    await act(async () => {
      editor.commands.insertPageImage({ assetId: ASSET });
      // 入れた直後は画像が選ばれている。いちど本文の行へ戻す
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    });
    await flush();
    // 選んでいない画像には欄を出さない
    expect(field("代替テキスト")).toBeNull();
    await act(async () => {
      editor.commands.setNodeSelection(0);
    });
    await flush();
    const alt = field("代替テキスト")!;
    const credit = field("クレジット")!;
    const consent = field("掲載許諾")!;
    expect(alt.value).toBe("");
    expect(consent.type).toBe("checkbox");

    await act(async () => typeInto(alt, "合成の写真"));
    await act(async () => typeInto(credit, "合成の提供元"));
    await act(async () => consent.click());
    // 本文（AST）には 3 つとも入る
    expect(savedBlocks(editor)[0]).toEqual({ type: "image", attrs: { assetId: ASSET, alt: "合成の写真", credit: "合成の提供元", consent: true } });
    // 資産の行へは、打ち終わってから送る
    expect(metas).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(metas).toEqual([{ assetId: ASSET, patch: { alt: "合成の写真", credit: "合成の提供元", consent: true } }]);
    vi.useRealTimers();
  });

  it("does not let the fields change the body: keys in the inputs stay in the inputs", async () => {
    const { images: port } = stubImages();
    const editor = await render({ images: port, pageId: () => PAGE });
    await act(async () => {
      editor.commands.insertPageImage({ assetId: ASSET });
      editor.commands.setNodeSelection(0);
    });
    await flush();
    const alt = field("代替テキスト")!;
    const before = JSON.stringify(editor.getJSON());
    for (const key of ["Backspace", "Enter", "Delete"]) {
      await act(async () => {
        alt.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    }
    expect(JSON.stringify(editor.getJSON())).toBe(before);
  });

  it("reads back a saved image and never reads an outside <img src>", async () => {
    const editor = await render({});
    await act(async () => {
      editor.commands.setContent({
        type: "doc",
        content: [{ type: "image", attrs: { assetId: ASSET, alt: "保存済み", credit: "提供元", consent: true } }, { type: "paragraph" }],
      });
    });
    await flush();
    expect(images().map((item) => item.getAttribute("src"))).toEqual([srcOf(ASSET)]);
    expect(savedBlocks(editor)[0]).toEqual({ type: "image", attrs: { assetId: ASSET, alt: "保存済み", credit: "提供元", consent: true } });
    // 外の画像の HTML は読み取らない（id を持たない img・外の src は本文に入らない）
    await act(async () => {
      editor.commands.setContent("<p>前</p>");
      editor.view.pasteHTML('<img src="https://evil.example/pixel.gif"><img data-asset-id="not-a-uuid"><img data-asset-id="../etc">', new Event("paste") as ClipboardEvent);
    });
    await flush();
    const text = JSON.stringify(editor.getJSON());
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("not-a-uuid");
    expect(savedBlocks(editor).every((block) => block.type === "paragraph")).toBe(true);
  });
});
