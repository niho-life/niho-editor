// @vitest-environment jsdom
import type { Editor, JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { validateBlocks } from "@/ast/blocks";
import { BLOCK_CHOICES, type BlockChoiceId } from "@/editor/block-types";
import { buildPageExtensions } from "@/editor/page-extensions";
import { PageChrome } from "niho-docs-ui/page/PageChrome";
import { PageEditor } from "./PageEditor";

beforeAll(() => {
  // jsdom に無い描画の API（ProseMirror・浮かぶメニューの位置の計算が読む）
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  Range.prototype.getBoundingClientRect = rect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Element.prototype.scrollIntoView = () => undefined;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Doc = JSONContent;
const paragraph = (text?: string): JSONContent => (text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" });
const doc = (...content: JSONContent[]): Doc => ({ type: "doc", content });

/**
 * 空の行（空の段落）から、それぞれの項目で作られるブロック。
 * 「画像」はファイル選択を開くだけで、本文には何も入れない（アップロードが済んでから入る。この harness は画像の口を渡して
 * いないので開かない）。行は空の段落のまま＝見出しの空の行は段落に戻る。画像のノードが入るところは src/editor の試験で見る。
 */
const MADE: Record<BlockChoiceId, JSONContent> = {
  paragraph: paragraph(),
  h2: { type: "heading", attrs: { level: 2 } },
  h3: { type: "heading", attrs: { level: 3 } },
  bullet: { type: "bulletList", content: [{ type: "listItem", content: [paragraph()] }] },
  task: { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [paragraph()] }] },
  ordered: { type: "orderedList", content: [{ type: "listItem", content: [paragraph()] }] },
  quote: { type: "blockquote", content: [paragraph()] },
  callout: { type: "callout", content: [paragraph()] },
  hr: { type: "horizontalRule" },
  image: paragraph(),
  table: { type: "table", content: Array.from({ length: 3 }, (_, row) => ({ type: "tableRow", content: Array.from({ length: 3 }, () => ({ type: row === 0 ? "tableHeader" : "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null }, content: [paragraph()] })) })) },
  codeBlock: { type: "codeBlock" },
};

/** PageEditor と同じ並び（`.be` の中に本文と PageChrome）だけを描く。 */
function Harness({ content }: { content: Doc }) {
  const editor = useEditor({
    extensions: buildPageExtensions(),
    content,
    immediatelyRender: false,
    editorProps: { attributes: { class: "doc", "aria-label": "本文" } },
  });
  return (
    <div data-docs-app-root="" data-docs-shared-ui="">
      <div className="be">
        <EditorContent editor={editor} />
        <PageChrome editor={editor} />
      </div>
    </div>
  );
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 5; index++) await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** TipTap の focus コマンドは requestAnimationFrame の中でフォーカスする。偽の時計で進められるようにする。 */
function fakeTimersWithFrames() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
}

async function renderHarness(content: Doc, options: { strict?: boolean } = {}): Promise<Editor> {
  fakeTimersWithFrames();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      options.strict ? (
        <StrictMode>
          <Harness content={content} />
        </StrictMode>
      ) : (
        <Harness content={content} />
      ),
    );
  });
  await flush();
  return bodyEditor();
}

function bodyEditor(): Editor {
  return (container!.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;
}

const chrome = () => container!.querySelector<HTMLElement>("[data-page-chrome]")!;
const formatBar = () => chrome().querySelector<HTMLElement>(":scope > .es-selbar--live");
/** aria-label が label か、「<見える文字>、label」（shell の「行の種類」は「テキスト、行の種類」のように見える文字から始まる）のボタン。 */
const labelled = (label: string) => container!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"], button[aria-label$="、${label}"]`);
const menu = (label: string) => container!.querySelector<HTMLElement>(`[role="menu"][aria-label="${label}"]`);
/** 項目の名前（右の小さな補足を除く）。 */
const itemName = (item: Element) =>
  [...item.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent)
    .join("");
const itemNames = (element: HTMLElement | null) => [...(element?.querySelectorAll('[role="menuitem"]') ?? [])].map(itemName);
const menuItem = (element: HTMLElement | null, name: string) =>
  [...(element?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])].find((item) => itemName(item) === name)!;
const slashMenu = () => container!.querySelector<HTMLElement>("[data-slash-menu]");

/** 保存の検査（限定 AST）を通る本文か。通らなければ理由つきで落とす。 */
function savedBlocks(editor: Editor) {
  const result = validateBlocks(editor.getJSON().content ?? []);
  if (!result.ok) throw new Error(`the chrome produced a body the server would refuse: ${result.reason}`);
  return result.blocks;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    element.click();
  });
  await advance(20);
}

async function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
  await advance(20);
}

async function type(editor: Editor, text: string) {
  await act(async () => {
    editor.view.dispatch(editor.state.tr.insertText(text));
  });
  await flush();
}

/** 本文にフォーカスし、from..to を選ぶ（帯は選択の 250ms あとに出る）。 */
async function select(editor: Editor, from: number, to: number) {
  await act(async () => {
    editor.view.focus();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
  });
  await advance(300);
}

async function cursorAt(editor: Editor, pos: number) {
  await select(editor, pos, pos);
}

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("the format bar above the selected text", () => {
  it("is attached inside the chrome's .es-root and only shows for a selection", async () => {
    const editor = await renderHarness(doc(paragraph("合成の本文です")));
    await cursorAt(editor, 2);
    expect(formatBar()).toBeNull();
    await select(editor, 1, 3);
    const bar = formatBar();
    expect(bar).not.toBeNull();
    expect(bar!.closest(".es-root")).toBe(chrome());
    expect(bar!.closest("[data-docs-app-root][data-docs-shared-ui]")).not.toBeNull();
    expect(bar!.getAttribute("role")).toBe("toolbar");
    // 入れ物ではなく、中のボタンだけがタブで止まる
    expect(bar!.tabIndex).toBe(-1);
  });

  it("stays inside .es-root when React re-registers the menus (StrictMode in development)", async () => {
    const editor = await renderHarness(doc(paragraph("合成の本文です")), { strict: true });
    await select(editor, 1, 3);
    expect(formatBar()?.closest(".es-root")).toBe(chrome());
    await cursorAt(editor, 7);
    expect(formatBar()).toBeNull();
    await select(editor, 2, 5);
    expect(formatBar()?.closest(".es-root")).toBe(chrome());
    expect(formatBar()!.style.flexWrap).toBe("wrap");
  });

  it("toggles bold and italic, and keeps the pressed state current as the selection moves", async () => {
    const editor = await renderHarness(doc(paragraph("合成の本文です")));
    await select(editor, 1, 3);
    expect(labelled("太字")!.getAttribute("aria-pressed")).toBe("false");

    await click(labelled("太字")!);
    expect(savedBlocks(editor)).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "合成", marks: [{ type: "bold" }] }, { type: "text", text: "の本文です" }] },
    ]);
    expect(editor.isActive("bold")).toBe(true);
    expect(labelled("太字")!.getAttribute("aria-pressed")).toBe("true");

    await click(labelled("斜体")!);
    expect(labelled("斜体")!.getAttribute("aria-pressed")).toBe("true");
    expect(savedBlocks(editor)[0]).toMatchObject({ content: [{ text: "合成", marks: [{ type: "bold" }, { type: "italic" }] }, { text: "の本文です" }] });

    // 書式の無い文字へ選択を移すと、押されていない表示に戻る
    await select(editor, 4, 6);
    expect(labelled("太字")!.getAttribute("aria-pressed")).toBe("false");
    expect(labelled("斜体")!.getAttribute("aria-pressed")).toBe("false");
    await select(editor, 1, 3);
    expect(labelled("太字")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("makes the line a heading 2 and a bullet list", async () => {
    const editor = await renderHarness(doc(paragraph("合成の本文です")));
    await select(editor, 1, 3);
    // 本文の最後が段落でなくなると、TipTap（TrailingNode）が空の段落を足す。見るのは先頭の行
    await click(labelled("見出し")!);
    expect(savedBlocks(editor)[0]).toEqual({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "合成の本文です" }] });
    await click(labelled("見出し")!);
    expect(savedBlocks(editor)[0]).toEqual(paragraph("合成の本文です"));
    await click(labelled("箇条書き")!);
    expect(savedBlocks(editor)[0]).toEqual({ type: "bulletList", content: [{ type: "listItem", content: [paragraph("合成の本文です")] }] });
  });

  it("sets the line type from the 行の種類 menu, keeping the text and its marks", async () => {
    const editor = await renderHarness(doc({ type: "paragraph", content: [{ type: "text", text: "合成", marks: [{ type: "bold" }] }, { type: "text", text: "の本文" }] }));
    const choose = async (name: string) => {
      await select(editor, 2, 4);
      await click(labelled("行の種類")!);
      const lineMenu = menu("行の種類");
      expect(itemNames(lineMenu)).toEqual(["テキスト", "見出し 2", "見出し 3", "箇条書き", "チェックリスト", "番号付き", "引用", "囲み"]);
      await click(menuItem(lineMenu, name));
      expect(menu("行の種類")).toBeNull();
      return savedBlocks(editor).slice(0, 1);
    };
    const text = [{ type: "text", text: "合成", marks: [{ type: "bold" }] }, { type: "text", text: "の本文" }];

    expect(await choose("見出し 3")).toEqual([{ type: "heading", attrs: { level: 3 }, content: text }]);
    expect(await choose("引用")).toEqual([{ type: "blockquote", content: [{ type: "heading", attrs: { level: 3 }, content: text }] }]);
    expect(await choose("番号付き")).toEqual([{ type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: text }] }] }]);
    expect(await choose("箇条書き")).toEqual([{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: text }] }] }]);
    // 同じ種類を選んでも外れない（切り替えではない）
    expect(await choose("箇条書き")).toEqual([{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: text }] }] }]);
    // リストの項目を見出しにすると、リストから出る（項目の先頭は段落だけ）
    expect(await choose("見出し 2")).toEqual([{ type: "heading", attrs: { level: 2 }, content: text }]);
    expect(await choose("見出し 2")).toEqual([{ type: "heading", attrs: { level: 2 }, content: text }]);
    expect(await choose("テキスト")).toEqual([{ type: "paragraph", content: text }]);
  });

  it("marks the current line type in words, and Esc closes the menu back to the selection in the body", async () => {
    const editor = await renderHarness(doc({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "合成の見出し" }] }));
    await select(editor, 1, 3);
    await click(labelled("行の種類")!);
    const lineMenu = menu("行の種類")!;
    expect(menuItem(lineMenu, "見出し 3").textContent).toBe("見出し 3現在");
    expect(menuItem(lineMenu, "テキスト").querySelector("small")).toBeNull();
    // 開くと先頭の項目にフォーカスがある（↑↓で動く）
    expect(document.activeElement).toBe(menuItem(lineMenu, "テキスト"));
    await press(document.activeElement as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(menuItem(lineMenu, "見出し 2"));

    await press(document.activeElement as HTMLElement, "Escape");
    expect(menu("行の種類")).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(3);
    expect(savedBlocks(editor)[0]).toMatchObject({ type: "heading", attrs: { level: 3 } });
  });

  it("closes the 行の種類 menu when its button is pressed again", async () => {
    const editor = await renderHarness(doc(paragraph("合成の本文")));
    await select(editor, 1, 3);
    await click(labelled("行の種類")!);
    expect(menu("行の種類")).not.toBeNull();
    const button = labelled("行の種類")!;
    await act(async () => {
      button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    await click(button);
    expect(menu("行の種類")).toBeNull();
  });
});

describe("the link field of the format bar", () => {
  async function openLink(editor: Editor, from = 1, to = 3) {
    await select(editor, from, to);
    await click(labelled("リンク")!);
    const form = container!.querySelector<HTMLFormElement>('form[aria-label="リンク"]')!;
    expect(form).not.toBeNull();
    const input = form.querySelector<HTMLInputElement>("input")!;
    expect(document.activeElement).toBe(input);
    return { form, input };
  }

  async function submit(form: HTMLFormElement, input: HTMLInputElement, value: string) {
    await act(async () => setInputValue(input, value));
    await act(async () => form.requestSubmit());
    await advance(20);
  }

  const alertText = () => container!.querySelector('form[aria-label="リンク"] [role="alert"]')?.textContent ?? null;

  it("refuses an empty, javascript:, data:, relative or schemeless URL with a short reason and sets nothing", async () => {
    const editor = await renderHarness(doc(paragraph("合成の本文")));
    const { form, input } = await openLink(editor);
    const before = JSON.stringify(editor.getJSON());

    await submit(form, input, "   ");
    expect(alertText()).toBe("URL を入れてください。");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    await submit(form, input, "javascript:alert(1)");
    expect(alertText()).toBe("使えるのは https:・http:・mailto: のリンクだけです。");
    await submit(form, input, "data:text/html,<b>x</b>");
    expect(alertText()).toBe("使えるのは https:・http:・mailto: のリンクだけです。");
    await submit(form, input, "/p/123");
    expect(alertText()).toBe("https:// から始まる URL を入れてください（相対の URL は使えません）。");
    await submit(form, input, "example.com");
    expect(alertText()).toBe("https:// から始まる URL を入れてください（相対の URL は使えません）。");
    await submit(form, input, "java\tscript:alert(1)");
    expect(alertText()).toBe("空白や制御文字を含む URL は使えません。");

    expect(JSON.stringify(editor.getJSON())).toBe(before);
    // 直し始めたら理由は消える
    await act(async () => setInputValue(input, "https://"));
    expect(alertText()).toBeNull();
  });

  it("links https and mailto, prefills an existing link, and can remove it", async () => {
    const editor = await renderHarness(doc(paragraph("合成の本文です")));
    let { form, input } = await openLink(editor, 1, 3);
    expect(form.textContent).not.toContain("リンクを外す");
    await submit(form, input, "  https://example.com/a  ");
    expect(container!.querySelector('form[aria-label="リンク"]')).toBeNull();
    expect(savedBlocks(editor)[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "合成", marks: [{ type: "link", attrs: { href: "https://example.com/a" } }] }, { type: "text", text: "の本文です" }],
    });
    expect(document.activeElement).toBe(editor.view.dom);

    ({ form, input } = await openLink(editor, 4, 6));
    await submit(form, input, "mailto:someone@example.com");
    expect(savedBlocks(editor)[0]).toMatchObject({ content: [{ text: "合成" }, { text: "の" }, { text: "本文", marks: [{ type: "link", attrs: { href: "mailto:someone@example.com" } }] }, { text: "です" }] });

    ({ form, input } = await openLink(editor, 1, 2));
    expect(input.value).toBe("https://example.com/a");
    const remove = [...form.querySelectorAll("button")].find((button) => button.textContent === "リンクを外す")!;
    await click(remove);
    // 選択がリンクの一部でも、そのリンクの全体を外す
    expect(savedBlocks(editor)[0]).toMatchObject({ content: [{ text: "合成の" }, { text: "本文", marks: [{ type: "link" }] }, { text: "です" }] });
    expect((savedBlocks(editor)[0] as { content: { marks?: unknown }[] }).content[0]!.marks).toBeUndefined();
  });

  it("closes on Esc and puts the selection back in the body", async () => {
    const editor = await renderHarness(doc(paragraph("合成の本文")));
    const { input } = await openLink(editor, 2, 4);
    await act(async () => setInputValue(input, "https://example.com"));
    await press(input, "Escape");
    expect(container!.querySelector('form[aria-label="リンク"]')).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
    expect([editor.state.selection.from, editor.state.selection.to]).toEqual([2, 4]);
    expect(savedBlocks(editor)).toEqual([paragraph("合成の本文")]);
  });
});

describe("the format bar without the retired AI entry", () => {
  it("does not render an AI button and keeps the selection and text as they are", async () => {
    const editor = await renderHarness(doc(paragraph("合成の本文")));
    await select(editor, 1, 3);
    const before = JSON.stringify(editor.getJSON());
    expect(labelled("AI に頼む")).toBeNull();
    expect([editor.state.selection.from, editor.state.selection.to]).toEqual([1, 3]);
    expect(JSON.stringify(editor.getJSON())).toBe(before);
  });
});

describe("the 「/」 block list", () => {
  const ALL = ["テキスト", "見出し 2", "見出し 3", "箇条書き", "チェックリスト", "番号付き", "引用", "囲み", "区切り線", "画像", "表", "コードブロック"];

  it("opens on 「/」 in an empty line with the blocks this body can hold (no recording), keeping focus in the body", async () => {
    const editor = await renderHarness(doc(paragraph()));
    await cursorAt(editor, 1);
    await type(editor, "/");
    const list = slashMenu()!;
    expect(list.getAttribute("role")).toBe("menu");
    expect(list.getAttribute("aria-label")).toBe("ブロックを足す");
    expect(itemNames(list)).toEqual(ALL);
    expect(list.textContent).not.toMatch(/録音|音声ファイル/);
    expect(list.closest(".es-root")).toBe(chrome());
    expect(document.activeElement).toBe(editor.view.dom);
    // いまの項目は面だけでなく太字（.es-mi--on）で示し、本文の aria-activedescendant にも出す
    const first = menuItem(list, "テキスト");
    expect(first.className).toContain("es-mi--on");
    expect(editor.view.dom.getAttribute("aria-activedescendant")).toBe(first.id);
    expect(editor.view.dom.getAttribute("aria-controls")).toBe(list.id);
  });

  it("filters by what follows 「/」 (name, kana, romaji, English, Markdown), moves with ↑↓ and picks with Enter", async () => {
    const editor = await renderHarness(doc(paragraph()));
    await cursorAt(editor, 1);
    await type(editor, "/mi");
    expect(itemNames(slashMenu())).toEqual(["見出し 2", "見出し 3"]);
    await press(editor.view.dom, "ArrowDown");
    expect(menuItem(slashMenu(), "見出し 3").className).toContain("es-mi--on");
    expect(editor.view.dom.getAttribute("aria-activedescendant")).toBe(menuItem(slashMenu(), "見出し 3").id);
    await press(editor.view.dom, "ArrowDown");
    expect(menuItem(slashMenu(), "見出し 2").className).toContain("es-mi--on");
    await press(editor.view.dom, "ArrowUp");
    await press(editor.view.dom, "Enter");
    expect(slashMenu()).toBeNull();
    expect(savedBlocks(editor)).toEqual([{ type: "heading", attrs: { level: 3 } }, paragraph()]);
    expect(editor.view.dom.hasAttribute("aria-activedescendant")).toBe(false);

    const cases: Array<[string, string[]]> = [
      ["見出し", ["見出し 2", "見出し 3"]],
      ["inyou", ["引用"]],
      ["りすと", ["箇条書き"]],
      ["list", ["箇条書き", "チェックリスト", "番号付き"]],
      ["ばんごう", ["番号付き"]],
      ["---", ["区切り線"]],
      ["##", ["見出し 2"]],
      ["ｈ３", ["見出し 3"]],
    ];
    for (const [query, expected] of cases) {
      await act(async () => {
        editor.commands.setContent(doc(paragraph()));
      });
      await cursorAt(editor, 1);
      await type(editor, `/${query}`);
      expect(itemNames(slashMenu()), query).toEqual(expected);
    }
  });

  it("closes on Esc, leaving the typed 「/」 and the cursor where they were", async () => {
    const editor = await renderHarness(doc(paragraph()));
    await cursorAt(editor, 1);
    await type(editor, "/");
    await press(editor.view.dom, "ArrowUp");
    // ↑ は末尾へ回る
    expect(menuItem(slashMenu(), "コードブロック").className).toContain("es-mi--on");
    await press(editor.view.dom, "Escape");
    expect(slashMenu()).toBeNull();
    expect(savedBlocks(editor)).toEqual([paragraph("/")]);
    expect(editor.state.selection.from).toBe(2);
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it("picks with the mouse", async () => {
    const editor = await renderHarness(doc(paragraph("前の段落"), paragraph()));
    await cursorAt(editor, 7);
    await type(editor, "/");
    await click(menuItem(slashMenu(), "引用"));
    expect(slashMenu()).toBeNull();
    expect(savedBlocks(editor)).toEqual([paragraph("前の段落"), { type: "blockquote", content: [paragraph()] }, paragraph()]);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor.state.selection.$from.depth).toBe(2);
  });

  it("also opens on the full-width 「／」", async () => {
    const editor = await renderHarness(doc(paragraph()));
    await cursorAt(editor, 1);
    await type(editor, "／いんよう");
    expect(itemNames(slashMenu())).toEqual(["引用"]);
    await press(editor.view.dom, "Enter");
    expect(savedBlocks(editor)).toEqual([{ type: "blockquote", content: [paragraph()] }, paragraph()]);
  });

  it("opens only in an empty line: not after or before text, not in a list or a quote; a line of spaces counts as empty", async () => {
    const editor = await renderHarness(doc(paragraph("本文")));
    await cursorAt(editor, 3);
    await type(editor, "/");
    expect(slashMenu()).toBeNull();

    await act(async () => {
      editor.commands.setContent(doc(paragraph("本文")));
    });
    await cursorAt(editor, 1);
    await type(editor, "/");
    expect(slashMenu()).toBeNull();

    await act(async () => {
      editor.commands.setContent(doc({ type: "bulletList", content: [{ type: "listItem", content: [paragraph()] }] }));
    });
    await cursorAt(editor, 3);
    await type(editor, "/");
    expect(slashMenu()).toBeNull();

    await act(async () => {
      editor.commands.setContent(doc({ type: "blockquote", content: [paragraph()] }));
    });
    await cursorAt(editor, 2);
    await type(editor, "/");
    expect(slashMenu()).toBeNull();

    await act(async () => {
      editor.commands.setContent(doc(paragraph("　 ")));
    });
    await cursorAt(editor, 3);
    await type(editor, "/");
    expect(itemNames(slashMenu())).toEqual(ALL);
    await press(editor.view.dom, "ArrowDown");
    await press(editor.view.dom, "Enter");
    // 空白ごと消して見出しにする
    expect(savedBlocks(editor)).toEqual([{ type: "heading", attrs: { level: 2 } }, paragraph()]);
  });

  it("does not open while the IME is composing, and opens once the input is committed", async () => {
    const editor = await renderHarness(doc(paragraph()));
    await cursorAt(editor, 1);
    await act(async () => {
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    expect(editor.view.composing).toBe(true);
    await type(editor, "／");
    expect(slashMenu()).toBeNull();
    // 変換中の Enter（確定）は横取りしない
    const enter = new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true, cancelable: true });
    await act(async () => {
      editor.view.dom.dispatchEvent(enter);
    });
    expect(slashMenu()).toBeNull();

    await act(async () => {
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "／" }));
    });
    expect(editor.view.composing).toBe(false);
    await advance(50);
    expect(itemNames(slashMenu())).toEqual(ALL);
    expect(savedBlocks(editor)).toEqual([paragraph("／")]);

    // 開いたあとに変換が始まったら閉じ、Enter は確定のまま本文に渡す
    await act(async () => {
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    await type(editor, "み");
    expect(slashMenu()).toBeNull();
  });

  it("does not take Enter when nothing matches", async () => {
    const editor = await renderHarness(doc(paragraph()));
    await cursorAt(editor, 1);
    await type(editor, "/zzz");
    expect(slashMenu()).toBeNull();
    // Enter はいつもの改行のまま
    await press(editor.view.dom, "Enter");
    expect(savedBlocks(editor)).toEqual([paragraph("/zzz"), paragraph()]);
  });

  it("turns an empty line into each block, and every result passes the limited AST", async () => {
    const editor = await renderHarness(doc(paragraph()));
    for (const start of [paragraph(), { type: "heading", attrs: { level: 2 } }] satisfies JSONContent[]) {
      for (const choice of BLOCK_CHOICES) {
        await act(async () => {
          editor.commands.setContent(doc(paragraph("前"), start, paragraph("後")));
        });
        await cursorAt(editor, 4);
        await type(editor, "/");
        await click(menuItem(slashMenu(), choice.label));
        // 空の行だけが変わり、前後の行はそのまま
        expect(savedBlocks(editor), `${JSON.stringify(start)} → ${choice.id}`).toEqual([paragraph("前"), MADE[choice.id], paragraph("後")]);
        expect(slashMenu()).toBeNull();
      }
    }
  });
});

describe("the block list without an inline add button", () => {
  it("keeps the inline add button hidden when an empty paragraph has focus", async () => {
    const editor = await renderHarness(doc(paragraph(), paragraph("本文")));
    await cursorAt(editor, 1);
    expect(chrome().querySelector('button[aria-label="ブロックを追加"]')).toBeNull();
  });

  it("opens the same block list, focuses it, and turns the empty paragraph into the picked block", async () => {
    const editor = await renderHarness(doc(paragraph("前"), paragraph(), paragraph("後")));
    await cursorAt(editor, 4);
    await press(editor.view.dom, "/", { ctrlKey: true });
    const list = menu("ブロックを足す")!;
    expect(itemNames(list)).toEqual(BLOCK_CHOICES.map((choice) => choice.label));
    expect(document.activeElement).toBe(menuItem(list, "テキスト"));
    await click(menuItem(list, "番号付き"));
    expect(menu("ブロックを足す")).toBeNull();
    expect(savedBlocks(editor)).toEqual([paragraph("前"), MADE.ordered, paragraph("後")]);
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it("closes on Esc back to the empty line in the body", async () => {
    const editor = await renderHarness(doc(paragraph()));
    await cursorAt(editor, 1);
    await press(editor.view.dom, "/", { ctrlKey: true });
    await press(document.activeElement as HTMLElement, "Escape");
    expect(menu("ブロックを足す")).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.from).toBe(1);
    expect(savedBlocks(editor)).toEqual([paragraph()]);
  });

  it("makes every block from an empty paragraph within the limited AST", async () => {
    const editor = await renderHarness(doc(paragraph()));
    for (const choice of BLOCK_CHOICES) {
      await act(async () => {
        editor.commands.setContent(doc(paragraph(), paragraph("後")));
      });
      await cursorAt(editor, 1);
      await press(editor.view.dom, "/", { ctrlKey: true });
      await click(menuItem(menu("ブロックを足す"), choice.label));
      // 空の段落だけが変わり、次の行はそのまま
      expect(savedBlocks(editor), choice.id).toEqual([MADE[choice.id], paragraph("後")]);
    }
  });
});

describe("⌘/ (Ctrl+/ off a Mac): the block list from the keyboard (design §11)", () => {
  const heading2: JSONContent = { type: "heading", attrs: { level: 2 } };
  /** 本文で ⌘/ を押す（jsdom の platform は Mac ではないので Ctrl）。 */
  async function blockShortcut(editor: Editor) {
    const event = new KeyboardEvent("keydown", { key: "/", code: "Slash", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => {
      editor.view.dom.dispatchEvent(event);
    });
    await advance(20);
    return event;
  }

  it("in an empty line, opens the same list as 「＋」 with focus on it, and ↑↓ and Enter turn that line into the block", async () => {
    const editor = await renderHarness(doc(paragraph("前"), paragraph(), paragraph("後")));
    await cursorAt(editor, 4);
    const event = await blockShortcut(editor);
    expect(event.defaultPrevented).toBe(true);
    const list = menu("ブロックを足す")!;
    expect(itemNames(list)).toEqual(BLOCK_CHOICES.map((choice) => choice.label));
    expect(document.activeElement).toBe(menuItem(list, "テキスト"));
    await press(document.activeElement as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(menuItem(list, "見出し 2"));
    // Enter はボタンの click になる（jsdom はキーから click を起こさないので、フォーカスのある項目を押す）
    await click(document.activeElement as HTMLElement);
    expect(menu("ブロックを足す")).toBeNull();
    expect(savedBlocks(editor)).toEqual([paragraph("前"), heading2, paragraph("後")]);
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it("in a line with text, keeps that line and makes the picked block on a new line below it, undone in one step", async () => {
    const editor = await renderHarness(doc(paragraph("前"), paragraph("後")));
    await cursorAt(editor, 2);
    await blockShortcut(editor);
    // 選ぶまでは何も足さない
    expect(savedBlocks(editor)).toEqual([paragraph("前"), paragraph("後")]);
    await click(menuItem(menu("ブロックを足す"), "箇条書き"));
    expect(savedBlocks(editor)).toEqual([paragraph("前"), MADE.bullet, paragraph("後")]);
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.$anchor.parent.type.name).toBe("paragraph");
    expect(editor.state.selection.$anchor.node(1).type.name).toBe("bulletList");
    await act(async () => {
      editor.commands.undo();
    });
    expect(savedBlocks(editor)).toEqual([paragraph("前"), paragraph("後")]);
  });

  it("adds below the whole list when the cursor is in a list item", async () => {
    const list: JSONContent = { type: "bulletList", content: [{ type: "listItem", content: [paragraph("項目")] }] };
    const editor = await renderHarness(doc(list, paragraph("後")));
    await cursorAt(editor, 4);
    await blockShortcut(editor);
    await click(menuItem(menu("ブロックを足す"), "区切り線"));
    expect(savedBlocks(editor)).toEqual([list, MADE.hr, paragraph("後")]);
  });

  it("closes on Esc back to where the cursor was, adding nothing", async () => {
    const editor = await renderHarness(doc(paragraph("前"), paragraph("後")));
    await cursorAt(editor, 2);
    await blockShortcut(editor);
    await press(document.activeElement as HTMLElement, "Escape");
    expect(menu("ブロックを足す")).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.from).toBe(2);
    expect(savedBlocks(editor)).toEqual([paragraph("前"), paragraph("後")]);
  });

  it("leaves the key to the browser when the body does not have focus", async () => {
    const editor = await renderHarness(doc(paragraph("前")));
    const outside = document.createElement("button");
    document.body.append(outside);
    await act(async () => outside.focus());
    const event = await blockShortcut(editor);
    expect(event.defaultPrevented).toBe(false);
    expect(menu("ブロックを足す")).toBeNull();
    outside.remove();
  });
});

describe("PageEditor with the chrome", () => {
  it("puts the chrome in the body's .be and saves what the 「/」 list makes", async () => {
    fakeTimersWithFrames();
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        return new Response(JSON.stringify({ page: { id: "p", revision: (body.baseRevision as number) + 1 } }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <PageEditor page={{ id: "00000000-0000-4000-8000-000000000001", title: "合成の題名", blocks: [], revision: 1, updatedAt: "2026-10-31T03:40:00.000Z" }} drafts={null} />,
      );
    });
    await flush();
    expect(container.querySelector(".be > [data-page-chrome].es-root")).not.toBeNull();
    // 保存状態の表示は今まで通りページの先頭（読み上げはヘッダーの状態の丸が持つので、ここは live region ではない）
    expect(container.querySelector("[data-save-state]")?.textContent).toBe("保存済み");
    expect(container.querySelector("[data-save-state]")?.getAttribute("role")).toBeNull();

    const editor = bodyEditor();
    await cursorAt(editor, 1);
    await type(editor, "/h2");
    await press(editor.view.dom, "Enter");
    await advance(1000);
    expect(bodies.at(-1)).toEqual({ blocks: [{ type: "heading", attrs: { level: 2 } }, { type: "paragraph" }], baseRevision: 1 });
    expect(validateBlocks(bodies.at(-1)!.blocks).ok).toBe(true);
  });

  it("works on a new page before it exists: the block the 「＋」 list makes creates the page, and the format bar then PATCHes it", async () => {
    fakeTimersWithFrames();
    const created = "00000000-0000-4000-8000-0000000000c1";
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push({ url, method: String(init.method), body });
        const creating = init.method === "POST";
        const page = { id: created, revision: creating ? 1 : (body.baseRevision as number) + 1 };
        return new Response(JSON.stringify({ page }), { status: creating ? 201 : 200, headers: { "content-type": "application/json" } });
      }),
    );
    const onCreated = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<PageEditor page={{ id: null, title: "", blocks: [], revision: null }} drafts={null} onCreated={onCreated} />);
    });
    await flush();

    const editor = bodyEditor();
    await cursorAt(editor, 1);
    await press(editor.view.dom, "/", { ctrlKey: true });
    await click(menuItem(menu("ブロックを足す"), "見出し 2"));
    await type(editor, "合成の見出し");
    await advance(1000);
    const heading = { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "合成の見出し" }] };
    expect(calls).toEqual([{ url: "/api/pages", method: "POST", body: { blocks: [heading, { type: "paragraph" }] } }]);
    expect(onCreated).toHaveBeenCalledWith(created);

    // 作ったあとも同じエディタのまま。帯の太字は、作ったページへの PATCH（作ったときの revision から）に乗る
    expect(bodyEditor()).toBe(editor);
    await select(editor, 1, 3);
    await click(labelled("太字")!);
    await advance(1000);
    expect(calls.at(-1)).toEqual({
      url: `/api/pages/${created}`,
      method: "PATCH",
      body: {
        blocks: [
          { ...heading, content: [{ type: "text", text: "合成", marks: [{ type: "bold" }] }, { type: "text", text: "の見出し" }] },
          { type: "paragraph" },
        ],
        baseRevision: 1,
      },
    });
    expect(calls).toHaveLength(2);
  });
});
