// @vitest-environment jsdom
import { useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EditorShell,
  ShellAddRow,
  ShellBubbleMenu,
  ShellHeader,
  ShellMobileToolbar,
  ShellPageSettings,
  ShellSidebar,
  ShellTools,
  StatusDot,
  shellMoreItems,
} from "./index";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  act(() => roots.forEach((root) => root.unmount()));
  roots.length = 0;
  document.body.innerHTML = "";
});

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return host;
}

const key = (target: Element | Document, name: string, init: KeyboardEventInit = {}) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
  });

/**
 * Tab で順に止まる要素（jsdom は Tab でフォーカスを動かさないので、ブラウザの順序を写して数える）。
 * tabindex が 0 以上で、押せる（disabled でない）ものを DOM の順に。tabindex>0 は shell では使わない。
 */
const tabStops = (root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLElement>("a[href], button, input, textarea, select, [tabindex]")].filter(
    (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && !el.closest("[inert]"),
  );
const ME = { onOpen: () => undefined };
const nameOf = (el: Element | null | undefined) => el?.getAttribute("aria-label") ?? el?.textContent?.trim() ?? "";

describe("一覧のフォルダの行とアイコン（kind = 'folder'）", () => {
  it("トグルとその空きを出さず、フォルダのアイコン・名前で開閉する。空フォルダと通常のページは選択する", () => {
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const host = mount(
      <ShellSidebar
        items={[
          { id: "f1", title: "空のフォルダ", when: "昨日", folder: true, empty: true, icon: "folder" },
          { id: "f2", title: "取材", when: "昨日", folder: true, open: true, icon: "folder" },
          { id: "r1", title: "録音", when: "昨日", depth: 1, icon: "mic", sub: { text: "録音 · 文字起こし済み" } },
          { id: "s1", title: "記事本文", when: "昨日", depth: 2, icon: "spark", sub: { text: "記事制作" } },
        ]}
        onToggleFolder={onToggle}
        onSelect={onSelect}
       
      />,
    );
    expect(host.querySelector(".es-ditw")).toBeNull();
    const rows = [...host.querySelectorAll<HTMLButtonElement>(".es-di")];
    expect(rows.map((button) => button.getAttribute("aria-expanded"))).toEqual([null, "true", null, null]);
    act(() => rows[1]!.querySelector<SVGElement>("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onToggle).toHaveBeenCalledWith("f2");
    act(() => rows[1]!.querySelector(".es-di-t")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onSelect).not.toHaveBeenCalled();
    act(() => rows[0]!.querySelector<SVGElement>("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSelect).toHaveBeenLastCalledWith("f1");
    act(() => rows[0]!.querySelector(".es-di-t")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith("f1");
    expect(onToggle).toHaveBeenCalledTimes(2);
    act(() => rows[2]!.click());
    expect(onSelect).toHaveBeenCalledWith("r1");
    expect(host.querySelector(".es-when")).toBeNull();
    expect(host.querySelectorAll(".es-di-t .es-di-ki")).toHaveLength(4);
    expect(host.querySelector(".es-di-t--spark")?.textContent).toBe("記事本文");
  });
});

describe("ヘッダーの場所（パンくず）", () => {
  it("親のフォルダ › 親の録音だけを出し、ページの題名は出さない。押すとその場所へ。上の段では何も出さない", () => {
    const onOpen = vi.fn();
    const host = mount(
      <ShellHeader
        location={[
          { id: "f1", title: "鎌倉の取材", icon: "folder" },
          { id: "r1", title: "", icon: "mic" },
        ]}
        onOpenLocation={onOpen}
      />,
    );
    const nav = host.querySelector('nav[aria-label="場所"]')!;
    expect(nav.textContent).toBe("鎌倉の取材›無題");
    expect(host.querySelector(".es-ttl")?.textContent).toBe("");
    act(() => [...nav.querySelectorAll("button")][1]!.click());
    expect(onOpen).toHaveBeenCalledWith("r1");

    const top = mount(<ShellHeader location={[]} />);
    expect(top.querySelector('nav[aria-label="場所"]')).toBeNull();
  });
});

describe("メニュー（Esc で閉じ、キーボードで動く）", () => {
  function Sidebar({ onPick = vi.fn() }: { onPick?: (kind: string) => void }) {
    const [open, setOpen] = useState(false);
    return <ShellSidebar items={[]} newMenu={{ open, onToggle: () => setOpen((v) => !v), onClose: () => setOpen(false), onPick }} />;
  }

  it("＋で新しいページのメニュー（空のページ／録音から／フォルダ）が開き、先頭にフォーカス。Esc で閉じて＋へ戻る", () => {
    const onPick = vi.fn();
    const host = mount(<Sidebar onPick={onPick} />);
    const plus = host.querySelector<HTMLButtonElement>('button[aria-label="新しいページ（⌘N）"]')!;
    expect(host.querySelector('[role="menu"]')).toBeNull();
    act(() => plus.click());
    const menu = host.querySelector('[role="menu"]')!;
    expect(menu.getAttribute("aria-label")).toBe("新しいページ");
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["空のページ⌘N", "録音から", "フォルダ"]);
    // フォルダの前に区切り。上の段にいるときは見出しを出さない
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(menu.querySelector(".es-menu-hd")).toBeNull();
    expect(plus.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement?.textContent).toBe("空のページ⌘N");
    key(document.activeElement!, "ArrowDown");
    expect(document.activeElement?.textContent).toBe("録音から");
    key(document.activeElement!, "Escape");
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(plus);
  });

  it("フォルダの中では上に「『◯◯』の中に」の見出し。フォルダを選ぶと onPick（folder）。kinds で項目を絞れる（Mac）", () => {
    const onPick = vi.fn();
    const host = mount(
      <ShellSidebar items={[]} newMenu={{ open: true, onToggle: vi.fn(), onClose: vi.fn(), onPick, inside: { title: "鎌倉の取材" } }} />,
    );
    const menu = host.querySelector('[role="menu"]')!;
    expect(menu.querySelector(".es-menu-hd")?.textContent).toBe("「鎌倉の取材」の中に");
    expect(menu.textContent).not.toContain("上の段");
    act(() => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === "フォルダ")!.click());
    expect(onPick).toHaveBeenCalledWith("folder");

    const mac = mount(<ShellSidebar items={[]} newMenu={{ open: true, onToggle: vi.fn(), onClose: vi.fn(), onPick, kinds: ["blank", "recording"] }} />);
    expect([...mac.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["空のページ⌘N", "録音から"]);
    expect(mac.querySelectorAll('[role="separator"]')).toHaveLength(0);
  });

  it("メニューの項目を選ぶと onPick（recording）が呼ばれる", () => {
    const onPick = vi.fn();
    const host = mount(<Sidebar onPick={onPick} />);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="新しいページ（⌘N）"]')!.click());
    act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === "録音から")!.click());
    expect(onPick).toHaveBeenCalledWith("recording");
  });

  it("左下の歯車＋「設定」が、設定の callback を直接呼ぶ", () => {
    const onSettings = vi.fn();
    const host = mount(
      <EditorShell sidebar={<Sidebar />} header={null} sidebarOpen railOpen={false} settings={{ onOpen: onSettings }}>
        x
      </EditorShell>,
    );
    expect(host.querySelectorAll(".es-setbar button")).toHaveLength(1);
    const settings = host.querySelector<HTMLButtonElement>(".es-setbar .es-sb-settings")!;
    expect(settings.textContent).toBe("設定");
    expect(settings.querySelector("svg")).not.toBeNull();
    expect(settings.getAttribute("aria-label")).toBe("設定");
    expect(settings.hasAttribute("aria-haspopup")).toBe(false);
    act(() => settings.click());
    expect(onSettings).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it("ヘッダーの「…」も Esc で閉じる", () => {
    function Header() {
      const [open, setOpen] = useState(false);
      return <ShellHeader title="x" more={{ open, items: shellMoreItems(true), onToggle: () => setOpen((v) => !v), onClose: () => setOpen(false), onSelect: () => setOpen(false) }} />;
    }
    const host = mount(<Header />);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="その他"]')!.click());
    const items = [...host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
    expect(items).toEqual(["リンクで共有共有中", "書き出し.md · Google ドキュメント", "履歴", "複製", "削除"]);
    key(document.activeElement!, "Escape");
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it("ブロックの一覧（＋の行）は Esc で閉じる", () => {
    function Row() {
      const [open, setOpen] = useState(true);
      return <ShellAddRow menuOpen={open} onToggle={() => setOpen(true)} onPick={() => setOpen(false)} onClose={() => setOpen(false)} />;
    }
    const host = mount(<Row />);
    expect(host.querySelectorAll('[role="menuitem"]')).toHaveLength(7);
    key(document.activeElement!, "Escape");
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(host.querySelector('button[aria-label="ブロックを追加"]')).not.toBeNull();
  });
});

describe("状態の吹き出し", () => {
  it("フォーカスできる丸（tabindex=0）に吹き出しが結ばれ、Esc で吹き出しだけ閉じる（フォーカスを外すと戻る）", () => {
    const host = mount(<StatusDot state="updated" tip="更新あり · 直した内容はまだ読者に出ていません" />);
    const dot = host.querySelector<HTMLElement>(".es-st")!;
    const tip = host.querySelector<HTMLElement>('[role="tooltip"]')!;
    expect(dot.tabIndex).toBe(0);
    expect(dot.getAttribute("aria-describedby")).toBe(tip.id);
    expect(host.querySelector(".es-st-wrap")!.getAttribute("aria-live")).toBe("polite");
    act(() => dot.focus());
    expect(document.activeElement).toBe(dot);
    key(dot, "Escape");
    expect(host.querySelector(".es-st-wrap")!.getAttribute("data-dismissed")).toBe("true");
    act(() => dot.blur());
    expect(host.querySelector(".es-st-wrap")!.getAttribute("data-dismissed")).toBeNull();
  });

  it("状態が変わると、同じ live 領域の文が替わる（読み上げの対象）", () => {
    const host = mount(<StatusDot state="private" tip="自分だけ · 保存済み" />);
    const region = host.querySelector(".es-st-wrap")!;
    act(() => {
      roots[0]!.render(<StatusDot state="published" tip="公開中 · niho.life/article/x · 保存済み" />);
    });
    expect(host.querySelector(".es-st-wrap")).toBe(region);
    expect(region.querySelector('[role="tooltip"]')!.textContent).toBe("公開中 · niho.life/article/x · 保存済み");
  });
});

describe("道具の帯", () => {
  it("押した操作が onAction へ渡る", () => {
    const onAction = vi.fn();
    const host = mount(<ShellTools onAction={onAction} />);
    for (const label of ["ブロックを足す", "太字", "斜体", "リンク", "見出し", "箇条書き", "画像", "録音"]) {
      act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
    }
    expect(onAction.mock.calls.map(([action]) => action)).toEqual(["add-block", "bold", "italic", "link", "heading", "list", "image", "record"]);
  });
});

describe("道具の帯のキーボード（WAI-ARIA の toolbar・roving tabindex。#43）", () => {
  const ORDER = ["ブロックを足す", "テキスト、行の種類", "太字", "斜体", "取り消し線", "インラインコード", "リンク", "見出し", "箇条書き", "画像", "録音"];
  /** 帯の前後にボタンを置き、Tab の出入りを見られるようにする。 */
  const around = (toolbar: React.ReactNode) =>
    mount(
      <>
        <button type="button">前</button>
        {toolbar}
        <button type="button">後</button>
      </>,
    );
  const toolbarOf = (host: HTMLElement) => host.querySelector<HTMLElement>('[role="toolbar"]')!;
  const buttonsOf = (host: HTMLElement) => [...toolbarOf(host).querySelectorAll<HTMLButtonElement>("button")];

  it("Tab の停止点は帯の中で 1 つ（はじめは先頭）。前 → 帯 → 後 の 3 つで止まる", () => {
    const host = around(<ShellTools />);
    expect(buttonsOf(host).map((button) => nameOf(button))).toEqual(ORDER);
    expect(buttonsOf(host).map((button) => button.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1]);
    expect(tabStops(host).map((el) => nameOf(el))).toEqual(["前", "ブロックを足す", "後"]);
  });

  it("→ ← で隣へ（端では反対の端へ回る）、Home・End で先頭・最後へ。停止点も一緒に動く", () => {
    const host = around(<ShellTools />);
    const buttons = buttonsOf(host);
    act(() => buttons[0]!.focus());
    key(document.activeElement!, "ArrowRight");
    expect(nameOf(document.activeElement)).toBe("テキスト、行の種類");
    key(document.activeElement!, "ArrowRight");
    expect(nameOf(document.activeElement)).toBe("太字");
    key(document.activeElement!, "ArrowLeft");
    expect(nameOf(document.activeElement)).toBe("テキスト、行の種類");
    key(document.activeElement!, "End");
    expect(nameOf(document.activeElement)).toBe("録音");
    key(document.activeElement!, "ArrowRight");
    expect(nameOf(document.activeElement)).toBe("ブロックを足す");
    key(document.activeElement!, "ArrowLeft");
    expect(nameOf(document.activeElement)).toBe("録音");
    key(document.activeElement!, "Home");
    expect(nameOf(document.activeElement)).toBe("ブロックを足す");
    key(document.activeElement!, "ArrowRight");
    key(document.activeElement!, "ArrowRight");
    // 帯を出て戻ると、最後にいた項目に入る（停止点は動いた先の 1 つだけ）
    expect(tabStops(host).map((el) => nameOf(el))).toEqual(["前", "太字", "後"]);
    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1);
  });

  it("矢印キーは既定の動き（スクロール）を止める。修飾キーつき・↑↓・Esc は帯では扱わない", () => {
    const host = around(<ShellTools />);
    const first = buttonsOf(host)[0]!;
    act(() => first.focus());
    const arrow = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    act(() => {
      first.dispatchEvent(arrow);
    });
    expect(arrow.defaultPrevented).toBe(true);
    const at = document.activeElement;
    for (const [name, init] of [["ArrowRight", { metaKey: true }], ["ArrowDown", {}], ["ArrowUp", {}], ["Escape", {}]] as const) {
      key(document.activeElement!, name, init);
      expect(document.activeElement).toBe(at);
    }
  });

  it("クリック（フォーカス）した項目が次の停止点になる", () => {
    const host = around(<ShellTools />);
    const image = buttonsOf(host).find((button) => nameOf(button) === "画像")!;
    act(() => image.focus());
    expect(image.tabIndex).toBe(0);
    expect(tabStops(host).map((el) => nameOf(el))).toEqual(["前", "画像", "後"]);
  });

  it("描き直しても停止点は 1 つのまま（行の種類が変わっても、いた項目を保つ）", () => {
    function Tools() {
      const [type, setType] = useState("テキスト");
      return <ShellTools textType={type} onAction={(action) => action === "text-type" && setType("見出し")} />;
    }
    const host = around(<Tools />);
    const textType = buttonsOf(host)[1]!;
    act(() => textType.focus());
    act(() => textType.click());
    expect(nameOf(textType)).toBe("見出し、行の種類");
    expect(textType.textContent).toBe("見出し ▾");
    expect(buttonsOf(host).map((button) => button.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1]);
  });

  it("下端の帯（ShellMobileToolbar）も同じ動き", () => {
    const host = around(<ShellMobileToolbar />);
    expect(host.querySelector(".es-mtb")!.getAttribute("role")).toBe("region");
    expect(tabStops(host).map((el) => nameOf(el))).toEqual(["前", "ブロックを足す", "後"]);
    act(() => buttonsOf(host)[0]!.focus());
    key(document.activeElement!, "End");
    expect(nameOf(document.activeElement)).toBe("録音");
    expect(tabStops(host).map((el) => nameOf(el))).toEqual(["前", "録音", "後"]);
  });
});

describe("本文へ移動（skip link。#43）", () => {
  it("EditorShell の最初の停止点で、押すと本文（main）へフォーカスが移る。URL の # は変えない", () => {
    const before = window.location.hash;
    const host = mount(
      <EditorShell sidebar={<aside aria-label="ページ"><button type="button">一覧の項目</button></aside>} header={<header><button type="button">一覧を出す</button></header>} sidebarOpen railOpen={false}>
        <p>本文</p>
      </EditorShell>,
    );
    const stops = tabStops(host);
    expect(nameOf(stops[0])).toBe("本文へ移動");
    const main = host.querySelector<HTMLElement>("main")!;
    expect(stops[0]!.getAttribute("href")).toBe(`#${main.id}`);
    // main は Tab の停止点に入れない（skip link からだけ入る）
    expect(main.tabIndex).toBe(-1);
    act(() => (stops[0] as HTMLAnchorElement).click());
    expect(document.activeElement).toBe(main);
    expect(window.location.hash).toBe(before);
  });
});

describe("ShellPageSettings（任意の操作: 書き出し・削除・言語の一言）", () => {
  const base = { lang: "ja" as const, author: { name: "Mika Sato", title: "ライター", initial: "M" }, info: [{ label: "作成", value: "2026-10-28" }] };
  const buttonOf = (host: HTMLElement, text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text);
  const exportButtons = (host: HTMLElement) =>
    [...host.querySelectorAll("section")].find((section) => section.querySelector("h3")?.textContent === "書き出し")!.querySelectorAll("button");

  it("Markdown を押すと onExportMarkdown。Google ドキュメントは onExportGoogle を渡したときだけ出て、押すとそれを呼ぶ", () => {
    const onExportMarkdown = vi.fn();
    const onExportGoogle = vi.fn();
    const onlyMarkdown = mount(<ShellPageSettings {...base} onExportMarkdown={onExportMarkdown} />);
    expect([...exportButtons(onlyMarkdown)].map((button) => button.textContent)).toEqual(["Markdown"]);
    act(() => buttonOf(onlyMarkdown, "Markdown")!.click());
    expect(onExportMarkdown).toHaveBeenCalledTimes(1);

    const both = mount(<ShellPageSettings {...base} onExportMarkdown={onExportMarkdown} onExportGoogle={onExportGoogle} />);
    expect([...exportButtons(both)].map((button) => button.textContent)).toEqual(["Markdown", "Google ドキュメント"]);
    act(() => buttonOf(both, "Google ドキュメント")!.click());
    expect(onExportGoogle).toHaveBeenCalledTimes(1);
    expect(onExportMarkdown).toHaveBeenCalledTimes(1);
  });

  it("onDelete を渡したときだけ「ページを削除」（危険な操作の見た目）を最後に出し、押すとそれを呼ぶ", () => {
    const without = mount(<ShellPageSettings {...base} />);
    expect(buttonOf(without, "ページを削除")).toBeUndefined();

    const onDelete = vi.fn();
    const host = mount(<ShellPageSettings {...base} onDelete={onDelete} />);
    const remove = buttonOf(host, "ページを削除")!;
    expect(remove.className).toBe("es-linkrow es-danger");
    expect(remove.type).toBe("button");
    expect([...host.querySelectorAll("button")].at(-1)).toBe(remove);
    act(() => remove.click());
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("肩書が空なら肩書の行を出さない（名前だけ）", () => {
    const titled = mount(<ShellPageSettings {...base} />);
    expect(titled.querySelector(".es-me small")?.textContent).toBe("ライター");
    const untitled = mount(<ShellPageSettings {...base} author={{ name: "Mika Sato", title: "", initial: "M" }} />);
    expect(untitled.querySelector(".es-me small")).toBeNull();
    expect(untitled.querySelector(".es-me div")?.textContent).toBe("Mika Sato");
  });

  it("言語のボタンは onLang を呼び、langNote は言語の下に role=alert で出る（無ければ出さない）", () => {
    const onLang = vi.fn();
    const quiet = mount(<ShellPageSettings {...base} onLang={onLang} />);
    expect(quiet.querySelector('[role="alert"]')).toBeNull();
    act(() => buttonOf(quiet, "English")!.click());
    expect(onLang).toHaveBeenCalledWith("en");

    const noted = mount(<ShellPageSettings {...base} onLang={onLang} langNote="言語を保存できませんでした" />);
    const note = noted.querySelector('[role="alert"]')!;
    expect(note.textContent).toBe("言語を保存できませんでした");
    expect(note.closest("section")?.querySelector("h3")?.textContent).toBe("言語");
  });
});

describe("ShellBubbleMenu（TipTap の bubble-menu）", () => {
  it("BlockEditor と同じ import の BubbleMenu に editor を渡すと、書式の帯のプラグイン（shellFormatBar）が editor に付く", () => {
    const editor = new Editor({ element: document.createElement("div"), extensions: [StarterKit], content: "<p>選ぶ文字</p>" });
    const keys = () => editor.state.plugins.map((plugin) => (plugin as unknown as { key: string }).key);
    expect(keys()).not.toContain("shellFormatBar$");
    mount(<ShellBubbleMenu editor={editor} onAi={vi.fn()} />);
    expect(keys()).toContain("shellFormatBar$");
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    expect(keys()).not.toContain("shellFormatBar$");
    editor.destroy();
  });
});
