// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Editor } from "@tiptap/react";
import { projectPages } from "@niho/docs-core";
import { MAC_DOCS_CAPABILITIES } from "niho-docs-ui/host/DocsHost";
import { click, renderApp, settle, typeInto, type Screen } from "./dom";
import { FakeBridge } from "./fake-bridge";

/**
 * 新しい editor の画面（#45 第 1 段）: Web と同じ shell の枠と同じ本文のエディタで、保管庫のページを一覧して書く。
 * 旧い画面は既定のまま（capability を立てたときだけ新しい画面になる）。
 */

let screen: Screen | null = null;

afterEach(() => {
  screen?.unmount();
  screen = null;
});

function editorBridge(): FakeBridge {
  const bridge = new FakeBridge();
  bridge.capabilities = { ...MAC_DOCS_CAPABILITIES, editorShell: true };
  return bridge;
}

async function render(bridge: FakeBridge): Promise<Screen> {
  screen = await renderApp(bridge, { autoOpen: false, openChat: false });
  return screen;
}

function shell(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>(".es-root[data-editor-shell]");
  if (!root) throw new Error("新しい画面の枠が出ていません");
  return root;
}

function rows(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(".es-sb-list .es-di")];
}

function title(container: HTMLElement): HTMLTextAreaElement {
  const element = container.querySelector<HTMLTextAreaElement>("textarea.page-title");
  if (!element) throw new Error("題名の欄が出ていません");
  return element;
}

function body(container: HTMLElement): Editor {
  const element = container.querySelector(".be .ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
  if (!element?.editor) throw new Error("本文のエディタが出ていません");
  return element.editor;
}

/** 左の一覧の上の 1 行のアイコン（「検索」「新しいページ」）。名前は `aria-label`（「検索（⌘K）」のように ⌘ の案内が付く）。 */
function sidebarAction(container: HTMLElement, label: string): HTMLButtonElement | null {
  return [...container.querySelectorAll<HTMLButtonElement>(".es-sb button.es-ib")].find((candidate) => candidate.getAttribute("aria-label")?.startsWith(label)) ?? null;
}

/** 「新しいページ」›「空のページ」。 */
async function newPage(container: HTMLElement) {
  await click(sidebarAction(container, "新しいページ")!);
  const item = [...container.querySelectorAll<HTMLButtonElement>('[role="menu"] button, [role="menuitem"]')].find(
    (candidate) => candidate.textContent?.includes("空のページ"),
  );
  if (!item) throw new Error("「空のページ」が出ていません");
  await click(item);
}

/** 自動保存（250ms・最大 1 秒）を待つ。 */
async function waitSave() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
  });
  await settle();
}

/** 本文の末尾に段落を足す。 */
async function appendBody(container: HTMLElement, text: string) {
  await act(async () => {
    const editor = body(container);
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: "paragraph", content: [{ type: "text", text }] });
  });
}

/** 保管庫の、フォルダの外の文書のページ 1 枚（id と本文）。 */
function savedDoc(bridge: FakeBridge): { id: string; markdown: string } {
  const page = projectPages(bridge.outside.project).find((candidate) => candidate.kind === "doc");
  if (!page) throw new Error("保管庫に文書のページがありません");
  return { id: page.id, markdown: bridge.outside.docs[page.id] ?? "" };
}

/** ⌘S（保存を今すぐにする）。 */
async function pressSave() {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }));
  });
  await waitSave();
}

/** 保存の 1 回目を止めておく（止めている間に編集できる）。返す関数で通す。 */
function holdFirstSave(bridge: FakeBridge): () => void {
  const original = bridge.saveOpenedDocument.bind(bridge);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  bridge.saveOpenedDocument = async (handle: string, markdown: string) => {
    calls += 1;
    if (calls === 1) await held;
    return original(handle, markdown);
  };
  return release;
}

/** 保存を失敗させる（返す関数で元に戻す）。 */
function failSaves(bridge: FakeBridge, error: unknown): () => void {
  const original = bridge.saveOpenedDocument.bind(bridge);
  bridge.saveOpenedDocument = async () => {
    throw error;
  };
  return () => {
    bridge.saveOpenedDocument = original;
  };
}

describe("Mac の新しい editor の画面", () => {
  it("枠（1 段のヘッダー・左の一覧・本人の行）を出す", async () => {
    const { container } = await render(editorBridge());
    expect(shell(container).querySelector(".es-sb")).not.toBeNull();
    expect(shell(container).querySelector(".es-dt")).not.toBeNull();
    expect(sidebarAction(container, "新しいページ")).not.toBeNull();
    expect(sidebarAction(container, "検索")).not.toBeNull();
    // 「新しいページ」と「検索」の他に、絞り込みの帯（すべて／公開中／録音）は持たない
    expect(container.textContent).not.toContain("公開中");
  });

  it("空のページを作り、題名と本文を保管庫の Markdown に保存する", async () => {
    const bridge = editorBridge();
    const { container } = await render(bridge);
    await newPage(container);
    await typeInto(title(container), "新しい下書き");
    await act(async () => {
      body(container).commands.insertContent("保管庫に入る本文");
    });
    await waitSave();

    const page = projectPages(bridge.outside.project).find((candidate) => candidate.kind === "doc");
    expect(page?.title).toBe("新しい下書き");
    expect(bridge.outside.docs[page!.id]).toContain("保管庫に入る本文");
    expect(rows(container)[0]?.textContent).toContain("新しい下書き");
  });

  it("見出し・箇条書き・囲みを Markdown にして保存する", async () => {
    const bridge = editorBridge();
    const { container } = await render(bridge);
    await newPage(container);
    await act(async () => {
      const editor = body(container);
      editor.commands.insertContent("見出し");
      editor.commands.setNode("heading", { level: 2 });
      editor.commands.insertContentAt(editor.state.doc.content.size, { type: "callout", content: [{ type: "paragraph", content: [{ type: "text", text: "囲みの中" }] }] });
    });
    await waitSave();

    const page = projectPages(bridge.outside.project).find((candidate) => candidate.kind === "doc");
    const markdown = bridge.outside.docs[page!.id] ?? "";
    expect(markdown).toContain("## 見出し");
    expect(markdown).toContain("> [!note]");
    expect(markdown).toContain("囲みの中");
  });

  it("保管庫のページを開いて本文を読み、続きを同じファイルに保存する", async () => {
    const bridge = editorBridge();
    const created = await bridge.createPage(null, { kind: "doc", title: "前に書いた", createdAt: new Date(Date.now() - 60_000).toISOString() });
    await bridge.writePage(null, created.id, "## もとの見出し\n\nもとの本文\n");
    const { container } = await render(bridge);
    expect(rows(container).length).toBe(1);

    await click(rows(container)[0]!);
    expect(body(container).getText()).toContain("もとの本文");

    await act(async () => {
      body(container).commands.insertContentAt(body(container).state.doc.content.size, { type: "paragraph", content: [{ type: "text", text: "足した段落" }] });
    });
    await waitSave();
    const markdown = bridge.outside.docs[created.id] ?? "";
    expect(markdown).toContain("## もとの見出し");
    expect(markdown).toContain("足した段落");
  });

  it("表を本文として開いて、保管庫の Markdown を変えない", async () => {
    const bridge = editorBridge();
    const created = await bridge.createPage(null, { kind: "doc", title: "表のあるページ", createdAt: new Date().toISOString() });
    await bridge.writePage(null, created.id, "| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    const { container } = await render(bridge);
    await click(rows(container)[0]!);

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(title(container).value).toBe("表のあるページ");
    expect(body(container).state.doc.firstChild?.type.name).toBe("table");
    // 開いただけでは本文のファイルを変えない
    expect(bridge.outside.docs[created.id]).toContain("| a | b |");
  });

  it("保存の最中に来た編集も、成功を報告する前に書き切る", async () => {
    const bridge = editorBridge();
    const release = holdFirstSave(bridge);
    const { container } = await render(bridge);
    await newPage(container);
    await appendBody(container, "はじめの本文");
    // 1 回目の保存が走り出すまで待ち、その最中に続きを書く
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    await appendBody(container, "あとの本文");
    // 2 回目の自動保存の timer が、1 回目の保存の最中に来る（ここで取りこぼすと「あとの本文」が書かれない）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await act(async () => {
      release();
    });
    await waitSave();

    const saved = savedDoc(bridge);
    expect(saved.markdown).toContain("はじめの本文");
    expect(saved.markdown).toContain("あとの本文");
    expect(container.querySelector("[data-save-state]")?.getAttribute("data-save-state")).toBe("saved");
  });

  it("保存が失敗した変更は捨てず、ページも替えずに、⌘S で書き直せる", async () => {
    const bridge = editorBridge();
    const other = await bridge.createPage(null, { kind: "doc", title: "別のページ", createdAt: new Date(Date.now() - 60_000).toISOString() });
    const restore = failSaves(bridge, { code: "store_stale_document", message: "文書が変わっています。" });
    const { container } = await render(bridge);
    await newPage(container);
    await appendBody(container, "消えない本文");
    await waitSave();

    expect(container.querySelector("[data-save-state]")?.getAttribute("data-save-state")).toBe("error");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("別の所で変わりました");

    // 保存できていないのでページを替えない（替えると本文が置き換わって消える）
    const another = rows(container).find((row) => row.textContent?.includes("別のページ"));
    await click(another!);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("ページを替えませんでした");
    expect(body(container).getText()).toContain("消えない本文");
    expect(bridge.outside.docs[other.id]).toBe("");

    // 書けるようになったら、⌘S で同じ変更を書ける
    restore();
    await pressSave();
    const page = projectPages(bridge.outside.project).find((candidate) => candidate.id !== other.id && candidate.kind === "doc");
    expect(bridge.outside.docs[page!.id]).toContain("消えない本文");
    expect(container.querySelector("[data-save-state]")?.getAttribute("data-save-state")).toBe("saved");
  });

  it("窓を閉じる要求では、書きかけを書き終えてから閉じる", async () => {
    const bridge = editorBridge();
    const { container } = await render(bridge);
    await newPage(container);
    // 自動保存（250ms）を待たずに閉じる要求が来る
    await appendBody(container, "閉じる前の本文");

    let closes = false;
    await act(async () => {
      closes = await bridge.requestClose();
    });
    expect(closes).toBe(true);
    expect(savedDoc(bridge).markdown).toContain("閉じる前の本文");
  });

  it("書きかけを保存できないときは、一度閉じるのを止めて知らせる", async () => {
    const bridge = editorBridge();
    const restore = failSaves(bridge, { code: "store_stale_document", message: "文書が変わっています。" });
    const { container } = await render(bridge);
    await newPage(container);
    await appendBody(container, "保存できない本文");

    let closes = true;
    await act(async () => {
      closes = await bridge.requestClose();
    });
    expect(closes).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("もう一度閉じると");

    // もう一度閉じれば閉じる（窓が閉じられなくならないように）
    await act(async () => {
      closes = await bridge.requestClose();
    });
    expect(closes).toBe(true);
    restore();
  });

  it("capability が無ければ旧い画面のまま", async () => {
    const { container } = await render(new FakeBridge());
    expect(container.querySelector(".es-root[data-editor-shell]")).toBeNull();
    expect(container.querySelector(".rail")).not.toBeNull();
  });
});
