// @vitest-environment jsdom
import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TAB_BAR_TEXT, TabBar, type PageTab, type PageTabActions } from "./TabBar";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const TABS: PageTab[] = [
  { id: "t1", label: "下書き" },
  { id: "t2", label: "英語版", busy: true },
  { id: "t3", label: "3" },
];

function actions(over: Partial<PageTabActions> = {}): PageTabActions {
  return { onRename: vi.fn(), onDuplicate: vi.fn(), onDelete: vi.fn(), ...over };
}

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement("div");
  host.setAttribute("data-docs-app-root", "");
  host.setAttribute("data-docs-shared-ui", "");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click());
const key = (el: Element, name: string) => act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
const menuLabels = (el: ParentNode) => [...el.querySelectorAll<HTMLElement>('[role="menu"] button')].map((button) => button.textContent?.trim() ?? "");

describe("TabBar（タブの帯。#308）", () => {
  it("タブが 1 つなら罫線と ＋ だけ（名前の並びも ▾ も無い）。＋ で足す", () => {
    const onAdd = vi.fn();
    const el = mount(<TabBar tabs={[TABS[0]!]} currentId="t1" onOpen={vi.fn()} onAdd={onAdd} actions={actions()} />);
    expect(el.querySelector(".es-tabbar-tabs")).toBeNull();
    expect(el.querySelector(".es-tab")).toBeNull();
    expect(el.querySelector(".es-tab-menu")).toBeNull();
    const add = el.querySelector<HTMLButtonElement>(".es-tab-add")!;
    expect(add.getAttribute("aria-label")).toBe(TAB_BAR_TEXT.add);
    click(add);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("2 つ以上なら左に名前。開いているタブだけ aria-current と ▾。押すと開く。← → で動く", () => {
    const onOpen = vi.fn();
    const el = mount(<TabBar tabs={TABS} currentId="t2" onOpen={onOpen} onAdd={vi.fn()} actions={actions()} />);
    expect(el.querySelector(".es-tabbar-tabs")?.getAttribute("aria-label")).toBe(TAB_BAR_TEXT.list);
    const tabs = [...el.querySelectorAll<HTMLButtonElement>(".es-tab")];
    expect(tabs.map((tab) => [tab.textContent, tab.getAttribute("aria-current")])).toEqual([
      ["下書き", null],
      ["英語版", "true"],
      ["3", null],
    ]);
    // 動いているタブの回るマークは支援技術から隠す
    expect(tabs[1]!.querySelector(".es-busy")?.getAttribute("aria-hidden")).toBe("true");
    expect([...el.querySelectorAll(".es-tab-menu")].map((button) => button.getAttribute("aria-label"))).toEqual([TAB_BAR_TEXT.menu("英語版")]);
    click(tabs[0]);
    expect(onOpen).toHaveBeenCalledWith("t1");
    tabs[1]!.focus();
    key(tabs[1]!, "ArrowRight");
    expect(document.activeElement).toBe(tabs[2]);
    key(tabs[2]!, "ArrowRight");
    expect(document.activeElement).toBe(tabs[0]);
    key(tabs[0]!, "ArrowLeft");
    expect(document.activeElement).toBe(tabs[2]);
    // ＋ は名前の並びの外（右端）
    expect(el.querySelector(".es-tabbar-tabs .es-tab-add")).toBeNull();
  });

  it("▾ のメニュー: 名前を変える・複製・並べて開く・別のページへ移す・削除。並べて開くはデスクトップ、移すは入れ先があるときだけ", () => {
    const acts = actions({ onSplit: vi.fn(), onMove: vi.fn(), moveTargets: [{ id: "p2", title: "別のページ" }, { id: "p3", title: "" }] });
    const el = mount(<TabBar tabs={TABS} currentId="t1" onOpen={vi.fn()} onAdd={vi.fn()} actions={acts} />);
    const menuButton = el.querySelector<HTMLButtonElement>(".es-tab-menu")!;
    expect(menuButton.getAttribute("aria-expanded")).toBe("false");
    click(menuButton);
    expect(menuButton.getAttribute("aria-expanded")).toBe("true");
    expect(menuLabels(el)).toEqual([TAB_BAR_TEXT.rename, TAB_BAR_TEXT.duplicate, `${TAB_BAR_TEXT.split}英語版`, TAB_BAR_TEXT.move, `${TAB_BAR_TEXT.remove}${TAB_BAR_TEXT.removeHint}`]);
    const item = (label: string) => [...el.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find((button) => button.textContent?.startsWith(label));
    click(item(TAB_BAR_TEXT.split));
    expect(acts.onSplit).toHaveBeenCalledWith("t2");
    expect(el.querySelector('[role="menu"]')).toBeNull();
    click(menuButton);
    click(item(TAB_BAR_TEXT.duplicate));
    expect(acts.onDuplicate).toHaveBeenCalledTimes(1);
    click(menuButton);
    click(item(TAB_BAR_TEXT.remove));
    expect(acts.onDelete).toHaveBeenCalledTimes(1);
    // 移す: 入れ先の一覧（無題は「無題」）
    click(menuButton);
    click(item(TAB_BAR_TEXT.move));
    expect(menuLabels(el)).toEqual(["別のページ", TAB_BAR_TEXT.untitled]);
    click(el.querySelector('[role="menu"] button'));
    expect(acts.onMove).toHaveBeenCalledWith("p2");
    expect(el.querySelector('[role="menu"]')).toBeNull();
  });

  it("並べて開く・移すは、渡さなければ出さない", () => {
    const el = mount(<TabBar tabs={TABS} currentId="t1" onOpen={vi.fn()} onAdd={vi.fn()} actions={actions({ moveTargets: [] })} />);
    click(el.querySelector(".es-tab-menu"));
    expect(menuLabels(el)).toEqual([TAB_BAR_TEXT.rename, TAB_BAR_TEXT.duplicate, `${TAB_BAR_TEXT.remove}${TAB_BAR_TEXT.removeHint}`]);
  });

  it("名前を変える: その場の欄。Enter で送り（変えていなければ送らない）、Esc でやめる。空は「名前なし」", () => {
    const acts = actions();
    const el = mount(<TabBar tabs={TABS} currentId="t1" onOpen={vi.fn()} onAdd={vi.fn()} actions={acts} />);
    const open = () => {
      click(el.querySelector(".es-tab-menu"));
      click([...el.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find((button) => button.textContent === TAB_BAR_TEXT.rename));
      return el.querySelector<HTMLInputElement>(".es-tab-name")!;
    };
    let field = open();
    expect(field.getAttribute("aria-label")).toBe(TAB_BAR_TEXT.nameField);
    expect(field.value).toBe("下書き");
    expect(el.querySelectorAll(".es-tab")).toHaveLength(2);
    act(() => {
      field.value = " 第一稿 ";
    });
    key(field, "Enter");
    expect(acts.onRename).toHaveBeenCalledWith("第一稿");
    expect(el.querySelector(".es-tab-name")).toBeNull();
    expect(el.querySelectorAll(".es-tab")).toHaveLength(3);
    // Esc はやめる（送らない）
    field = open();
    act(() => {
      field.value = "x";
    });
    key(field, "Escape");
    expect(acts.onRename).toHaveBeenCalledTimes(1);
    expect(el.querySelector(".es-tab-name")).toBeNull();
    // 同じ名前は送らない。空は送る（名前なし）
    field = open();
    key(field, "Enter");
    expect(acts.onRename).toHaveBeenCalledTimes(1);
    field = open();
    act(() => {
      field.value = "";
    });
    key(field, "Enter");
    expect(acts.onRename).toHaveBeenLastCalledWith("");
  });

  it("axe: serious 以上が無い（1 つ・3 つ・メニューを開いた状態）", async () => {
    const el = mount(<TabBar tabs={TABS} currentId="t1" onOpen={vi.fn()} onAdd={vi.fn()} actions={actions({ onSplit: vi.fn() })} />);
    const check = async () =>
      (await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } })).violations
        .filter((entry) => entry.impact === "serious" || entry.impact === "critical")
        .map((entry) => [entry.id, entry.nodes.map((node) => node.html)]);
    expect(await check()).toEqual([]);
    click(el.querySelector(".es-tab-menu"));
    expect(await check()).toEqual([]);
  });
});
