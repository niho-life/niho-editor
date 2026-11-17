// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import axe from "axe-core";
import { closeHistory } from "@tiptap/pm/history";
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
/** 画像の右上の ⋯（選んでいる間だけ）。 */
const more = () => container!.querySelector<HTMLButtonElement>('button[aria-label="画像のメニュー"]');
const imageMenu = () => container!.querySelector<HTMLElement>('[role="menu"][aria-label="画像"]');
/** メニューの項目の見える文字（補足も含む）。 */
const menuLabels = () => [...(imageMenu()?.querySelectorAll("button") ?? [])].map((button) => button.textContent ?? "");
const captionInput = () => container!.querySelector<HTMLInputElement>('input[aria-label="キャプション"]');

/**
 * 入れた画像（insertPageImage の focus）が次の描画の前にエディタへフォーカスを移し終えるのを待つ
 * （待たないと、あとで ⋯・入力へ移したフォーカスを横から取られる）。
 */
async function settleFocus() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

async function selectImage(editor: Editor) {
  await settleFocus();
  await act(async () => {
    editor.commands.setNodeSelection(0);
  });
  await flush();
}

async function openMenu() {
  await act(async () => more()!.click());
}

async function pickItem(label: string) {
  const item = [...(imageMenu()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent?.startsWith(label));
  expect(item, `the image menu has 「${label}」`).toBeDefined();
  await act(async () => item!.click());
  await flush();
}

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

  it("shows no fields when the image is selected: only the ⋯ (image menu) on the image, and no credit or consent input anywhere (#344)", async () => {
    const { images: port } = stubImages();
    const editor = await render({ images: port, pageId: () => PAGE });
    await act(async () => {
      editor.commands.insertPageImage({ assetId: ASSET, credit: "合成の提供元" });
      // 入れた直後は画像が選ばれている。いちど本文の行へ戻す
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    });
    await flush();
    // 選んでいない画像には ⋯ も欄も出さない
    expect(more()).toBeNull();
    expect(container!.querySelectorAll("input")).toHaveLength(0);
    await selectImage(editor);
    expect(more()!.getAttribute("aria-haspopup")).toBe("menu");
    expect(more()!.getAttribute("aria-expanded")).toBe("false");
    // 欄（代替テキスト・キャプション・クレジット・掲載許諾）と注意文は出ない
    expect(container!.querySelectorAll("input, label")).toHaveLength(0);
    expect(container!.textContent).not.toMatch(/掲載許諾|クレジット|公開の前に/);
    // 既にあるクレジットは属性に残す（消さない）が、figcaption にも出さない
    expect(savedBlocks(editor)[0]).toEqual({ type: "image", attrs: { assetId: ASSET, credit: "合成の提供元", consent: false } });
    expect(container!.querySelector("figcaption")).toBeNull();
  });

  it("opens the image menu from ⋯ (under the button) and from a right click (at the pointer, the default menu stopped)", async () => {
    const { images: port } = stubImages();
    const editor = await render({ images: port, pageId: () => PAGE });
    await act(async () => {
      editor.commands.insertPageImage({ assetId: ASSET });
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    });
    await flush();
    await settleFocus();
    // 右クリック: 選んでいなくても、その画像を選んで押した位置にメニュー
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 50 });
    await act(async () => {
      images()[0]!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(editor.state.selection.from).toBe(0);
    expect(menuLabels()).toEqual(["キャプションを追加", "代替テキスト…なし", "削除"]);
    expect(imageMenu()!.style.left).toBe("40px");
    expect(imageMenu()!.style.top).toBe("50px");
    expect(document.activeElement).toBe(imageMenu()!.querySelector("button"));
    // Esc で閉じて ⋯ へ戻る
    await act(async () => {
      imageMenu()!.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(imageMenu()).toBeNull();
    expect(document.activeElement).toBe(more());
    // ⋯: 押すとメニュー、もう一度押すと閉じる
    await act(async () => more()!.click());
    expect(more()!.getAttribute("aria-expanded")).toBe("true");
    expect(imageMenu()?.getAttribute("aria-label")).toBe("画像");
    await act(async () => more()!.click());
    expect(imageMenu()).toBeNull();
  });

  it("does not open the menu on a page that can only be read (the browser's menu stays)", async () => {
    const editor = await render({});
    await act(async () => {
      editor.commands.setContent({ type: "doc", content: [{ type: "image", attrs: { assetId: ASSET, caption: "読むだけのキャプション" } }, { type: "paragraph" }] });
      editor.setEditable(false);
    });
    await flush();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => {
      images()[0]!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(imageMenu()).toBeNull();
    expect(more()).toBeNull();
    // キャプションは文字だけ（押せない）
    expect(container!.querySelector("figcaption")?.textContent).toBe("読むだけのキャプション");
    expect(container!.querySelector("figcaption button")).toBeNull();
  });

  it("adds a caption from the menu (one line, Enter to set), shows it under the image, and drops it when left empty", async () => {
    const { images: port, metas } = stubImages();
    const editor = await render({ images: port, pageId: () => PAGE });
    await act(async () => {
      editor.commands.insertPageImage({ assetId: ASSET });
    });
    await selectImage(editor);
    await openMenu();
    await pickItem("キャプションを追加");
    const input = captionInput()!;
    expect(input.getAttribute("placeholder")).toBe("キャプションを入力");
    expect(input.maxLength).toBe(1000);
    expect(document.activeElement).toBe(input);
    await act(async () => typeInto(input, "合成のキャプション"));
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(captionInput()).toBeNull();
    expect(savedBlocks(editor)[0]).toEqual({ type: "image", attrs: { assetId: ASSET, caption: "合成のキャプション", consent: false } });
    expect(container!.querySelector("figcaption")?.textContent).toBe("合成のキャプション");
    // キャプションは本文の属性だけ（資産の行には送らない）
    expect(metas).toEqual([]);
    // あるときは「キャプションを外す」
    await openMenu();
    expect(menuLabels()[0]).toBe("キャプションを外す");
    await pickItem("キャプションを外す");
    expect(savedBlocks(editor)[0]).toEqual({ type: "image", attrs: { assetId: ASSET, consent: false } });
    expect(container!.querySelector("figcaption")).toBeNull();
    // 空のまま離れたら入力を消し、キャプションは null のまま
    await openMenu();
    await pickItem("キャプションを追加");
    await act(async () => captionInput()!.blur());
    expect(captionInput()).toBeNull();
    expect(savedBlocks(editor)[0]).toEqual({ type: "image", attrs: { assetId: ASSET, consent: false } });
  });

  it("edits the alt text in a small popover under the image, and saves it to the node and (after typing) to the asset row", async () => {
    const { images: port, metas } = stubImages();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const editor = await render({ images: port, pageId: () => PAGE });
    await act(async () => {
      editor.commands.insertPageImage({ assetId: ASSET });
    });
    await selectImage(editor);
    await openMenu();
    await pickItem("代替テキスト…");
    const pop = container!.querySelector<HTMLElement>('[role="dialog"][aria-label="代替テキスト"]')!;
    expect(pop.textContent).toContain("読み上げと検索で使います。ページには出ません。");
    const alt = pop.querySelector("input")!;
    expect(alt.maxLength).toBe(1000);
    expect(document.activeElement).toBe(alt);
    await act(async () => typeInto(alt, "合成の写真"));
    // 本文（AST）には入る。資産の行へは、打ち終わってから送る
    expect(savedBlocks(editor)[0]).toEqual({ type: "image", attrs: { assetId: ASSET, alt: "合成の写真", consent: false } });
    expect(images()[0]!.getAttribute("alt")).toBe("合成の写真");
    expect(metas).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(metas).toEqual([{ assetId: ASSET, patch: { alt: "合成の写真" } }]);
    // Enter で閉じる。メニューの補足は「あり」
    await act(async () => {
      alt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(container!.querySelector('[role="dialog"]')).toBeNull();
    await openMenu();
    expect(menuLabels()[1]).toBe("代替テキスト…あり");
    // Esc でも閉じる。外を押しても閉じ、まだ送っていない分を送る
    await pickItem("代替テキスト…");
    const again = container!.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    await act(async () => {
      again.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(container!.querySelector('[role="dialog"]')).toBeNull();
    await openMenu();
    await pickItem("代替テキスト…");
    await act(async () => typeInto(container!.querySelector<HTMLInputElement>('[role="dialog"] input')!, ""));
    await act(async () => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(container!.querySelector('[role="dialog"]')).toBeNull();
    expect(metas.at(-1)).toEqual({ assetId: ASSET, patch: { alt: null } });
    vi.useRealTimers();
  });

  it("deletes the image node from the menu as an ordinary edit (undo brings it back)", async () => {
    const { images: port } = stubImages();
    const editor = await render({ images: port, pageId: () => PAGE });
    await act(async () => {
      editor.commands.insertPageImage({ assetId: ASSET });
      // 入れたことと消したことを別の Undo にする（続けて行うと 1 つにまとまる）
      editor.view.dispatch(closeHistory(editor.state.tr));
    });
    await selectImage(editor);
    await openMenu();
    await pickItem("削除");
    await flush();
    expect(savedBlocks(editor).some((block) => block.type === "image")).toBe(false);
    await act(async () => {
      editor.commands.undo();
    });
    await flush();
    expect(savedBlocks(editor)[0]).toEqual({ type: "image", attrs: { assetId: ASSET, consent: false } });
  });

  it("axe: serious 以上が無い（⋯・メニュー・キャプションの入力・代替テキスト）", async () => {
    const { images: port } = stubImages();
    const editor = await render({ images: port, pageId: () => PAGE });
    await act(async () => {
      editor.commands.insertPageImage({ assetId: ASSET, caption: "合成のキャプション" });
    });
    await selectImage(editor);
    const check = async () =>
      (await axe.run(container!, { rules: { "color-contrast": { enabled: false } } })).violations
        .filter((entry) => entry.impact === "serious" || entry.impact === "critical")
        .map((entry) => [entry.id, entry.nodes.map((node) => node.html)]);
    expect(await check()).toEqual([]);
    await openMenu();
    expect(await check()).toEqual([]);
    await pickItem("代替テキスト…");
    expect(await check()).toEqual([]);
    await openMenu();
    await pickItem("キャプションを外す");
    await openMenu();
    await pickItem("キャプションを追加");
    expect(await check()).toEqual([]);
  });

  it("does not let the caption or alt inputs change the body: keys in the inputs stay in the inputs", async () => {
    const { images: port } = stubImages();
    const editor = await render({ images: port, pageId: () => PAGE });
    await act(async () => {
      editor.commands.insertPageImage({ assetId: ASSET });
    });
    await selectImage(editor);
    await openMenu();
    await pickItem("代替テキスト…");
    const before = JSON.stringify(editor.getJSON());
    const alt = container!.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    for (const key of ["Backspace", "Delete"]) {
      await act(async () => {
        alt.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    }
    expect(JSON.stringify(editor.getJSON())).toBe(before);
    await openMenu();
    await pickItem("キャプションを追加");
    for (const key of ["Backspace", "Delete"]) {
      await act(async () => {
        captionInput()!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
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
