// @vitest-environment jsdom
import axe from "axe-core";
import { act, useState, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EditorShell,
  SHELL_DND,
  SHELL_DOCK_DEFAULT,
  ShellRail,
  ShellSidePane,
  ShellSidebar,
  computeShellDock,
  dockPanels,
  type EditorShellDock,
  type ShellDockPlace,
} from "./index";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  act(() => roots.forEach((root) => root.unmount()));
  roots.length = 0;
  document.body.innerHTML = "";
});

function mount(node: ReactNode): { host: HTMLElement; render: (next: ReactNode) => void } {
  const host = document.createElement("div");
  host.setAttribute("data-docs-app-root", "");
  host.setAttribute("data-docs-shared-ui", "");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return { host, render: (next) => act(() => root.render(next)) };
}

const key = (target: Element, name: string, init: KeyboardEventInit = {}) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
  });

/** jsdom に無い DataTransfer の代わり（型の一覧と、setData・getData）。 */
function transfer(data: Record<string, string> = {}) {
  const store = { ...data };
  return {
    get types() {
      return Object.keys(store);
    },
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    getData: (type: string) => store[type] ?? "",
    effectAllowed: "all",
    dropEffect: "none",
    store,
  };
}

/** jsdom に無い DragEvent の代わり（clientX・clientY・dataTransfer を持つ Event）。 */
function drag(target: Element, type: string, dataTransfer: ReturnType<typeof transfer>, at: { x?: number; y?: number } = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    clientX: { value: at.x ?? 0 },
    clientY: { value: at.y ?? 0 },
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** 書きかけを持つ部品（作り直されると消える）。 */
function Draft() {
  const [count, setCount] = useState(0);
  return (
    <section aria-label="AIと作る">
      <h2 className="es-ai-head">AIと作る</h2>
      <textarea aria-label="AIへのメッセージ" defaultValue="" />
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        数える {count}
      </button>
    </section>
  );
}

const sidebar = <aside className="es-sb" aria-label="ページ"><input aria-label="一覧の中の入力" defaultValue="" /></aside>;

type Over = Partial<EditorShellDock> & { width?: number };

function dockOf(over: Over = {}, shown = { list: true, ai: true }): EditorShellDock {
  const place: ShellDockPlace = over.place ?? { list: "left", ai: "right" };
  const widths = over.widths ?? { ...SHELL_DOCK_DEFAULT };
  const fit = over.fit ?? computeShellDock({ width: over.width ?? 1680, widths, docks: dockPanels(place, shown), side: Boolean(over.side) });
  const { width: _width, ...rest } = over;
  return { wide: true, onWidth: vi.fn(), onMove: vi.fn(), onPeek: vi.fn(), onDropPage: vi.fn(), onDropSide: vi.fn(), ...rest, place, widths, fit };
}

function Shell({ dock, sidebarOpen = true, railOpen = true }: { dock?: EditorShellDock; sidebarOpen?: boolean; railOpen?: boolean }) {
  return (
    <EditorShell
      sidebar={sidebar}
      header={<header className="es-dt">ヘッダー</header>}
      rail={
        <ShellRail>
          <Draft />
        </ShellRail>
      }
      corner={<span>文字数</span>}
      sidebarOpen={sidebarOpen}
      railOpen={railOpen}
      dock={dock}
    >
      <p>本文</p>
    </EditorShell>
  );
}

describe("EditorShell の分割ビュー（dock）", () => {
  it("dock を渡さなければ従来の DOM のまま（一覧｜ヘッダー＋ページ＋レール。新しい要素・属性・style は無い）", () => {
    const { host } = mount(<Shell />);
    const root = host.querySelector<HTMLElement>(".es-root")!;
    expect([...root.attributes].map((attr) => attr.name).sort()).toEqual(["class", "data-editor-shell", "data-rail", "data-sidebar", "data-view"]);
    const ws = root.querySelector<HTMLElement>(".es-ws")!;
    expect(ws.getAttribute("style")).toBeNull();
    expect([...ws.children].map((node) => node.className)).toEqual(["es-sb", "es-doc"]);
    expect([...root.querySelector(".es-dbody")!.children].map((node) => node.className)).toEqual(["es-canvas", "es-rail-presence", "es-corner"]);
    const presence = root.querySelector<HTMLElement>(".es-rail-presence")!;
    expect([...presence.attributes].map((attr) => attr.name).sort()).toEqual(["class"]);
    expect(root.querySelector(".es-pane, .es-sash, .es-strip, .es-sidecol, .es-dzs, .es-ghost")).toBeNull();
  });

  it("デスクトップでは grid の列で置く（一覧は左の列、AI は右の列）", () => {
    const { host } = mount(<Shell dock={dockOf()} />);
    const root = host.querySelector<HTMLElement>(".es-root")!;
    expect(root.dataset).toMatchObject({ layout: "dock", wide: "true", ai: "right" });
    expect(root.querySelector<HTMLElement>(".es-ws")!.style.gridTemplateColumns).toBe("272px 0px minmax(0,1fr) 0px 0px 0px 340px");
    const pane = root.querySelector<HTMLElement>(".es-pane")!;
    expect(pane.dataset).toMatchObject({ dock: "left", state: "open" });
    expect(pane.style.gridColumn).toBe("1");
    const presence = root.querySelector<HTMLElement>(".es-rail-presence")!;
    expect(presence.dataset).toMatchObject({ dock: "right", state: "open" });
    expect(presence.style.gridColumn).toBe("7");
  });

  it("同じドックに 2 つなら一覧が上の段・AI が下の段", () => {
    const { host } = mount(<Shell dock={dockOf({ place: { list: "left", ai: "left" } })} />);
    const ws = host.querySelector<HTMLElement>(".es-ws")!;
    expect(ws.style.gridTemplateRows).toContain("fit-content(");
    expect(host.querySelector<HTMLElement>(".es-pane")!.style.gridRow).toBe("1 / 3");
    const presence = host.querySelector<HTMLElement>(".es-rail-presence")!;
    expect(presence.style.gridRow).toBe("3 / 4");
    expect(presence.dataset.stack).toBe("below");
  });

  it("AI を左・浮かせる・狭い画面へ動かしても、同じ要素のまま（書きかけと中の状態が残る）", () => {
    const { host, render } = mount(<Shell dock={dockOf()} />);
    const field = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="AIへのメッセージ"]')!;
    const list = host.querySelector<HTMLInputElement>('input[aria-label="一覧の中の入力"]')!;
    field.value = "書きかけの依頼";
    list.value = "探している語";
    act(() => host.querySelector<HTMLButtonElement>("section button")!.click());

    render(<Shell dock={dockOf({ place: { list: "right", ai: "left" } })} />);
    expect(host.querySelector(".es-rail-presence")!.getAttribute("data-dock")).toBe("left");
    expect(host.querySelector(".es-pane")!.getAttribute("data-dock")).toBe("right");
    render(<Shell dock={dockOf({ place: { list: "right", ai: "float" }, float: { open: false, height: 360, max: 700, onHeight: vi.fn() } })} />);
    expect(host.querySelector<HTMLElement>(".es-rail-presence")!.dataset).toMatchObject({ dock: "float", float: "bar" });
    render(<Shell dock={{ ...dockOf(), wide: false }} />);
    render(<Shell dock={dockOf()} />);

    const after = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="AIへのメッセージ"]')!;
    expect(after).toBe(field);
    expect(after.value).toBe("書きかけの依頼");
    expect(host.querySelector('input[aria-label="一覧の中の入力"]')).toBe(list);
    expect(list.value).toBe("探している語");
    expect(host.querySelector("section button")!.textContent).toBe("数える 1");
  });

  it("900px 未満（wide=false）は従来の 1 枚表示: grid の style・境目・右のページ・細い列を出さない", () => {
    const side = <ShellSidePane pageId="b" title="右" onSwap={vi.fn()} onClose={vi.fn()}>本文</ShellSidePane>;
    const { host } = mount(<Shell dock={{ ...dockOf({ side, width: 1100 }), wide: false }} />);
    const root = host.querySelector<HTMLElement>(".es-root")!;
    expect(root.dataset.wide).toBe("false");
    expect(root.dataset.ai).toBeUndefined();
    expect(root.querySelector<HTMLElement>(".es-ws")!.getAttribute("style")).toBeNull();
    expect(root.querySelector(".es-pane")!.getAttribute("style")).toBeNull();
    expect(root.querySelector(".es-pane")!.hasAttribute("data-dock")).toBe(false);
    expect(root.querySelector(".es-rail-presence")!.hasAttribute("data-dock")).toBe(false);
    expect(root.querySelector(".es-sash, .es-strip, .es-sidecol, .es-side")).toBeNull();
  });

  it("一覧・AI を隠すと、どのドックにいても隠れる（hidden）", () => {
    const { host } = mount(<Shell dock={dockOf({ place: { list: "right", ai: "left" } }, { list: false, ai: false })} sidebarOpen={false} railOpen={false} />);
    expect(host.querySelector<HTMLElement>(".es-pane")!.hidden).toBe(true);
    expect(host.querySelector<HTMLElement>(".es-rail-presence")!.hidden).toBe(true);
    expect(host.querySelector<HTMLElement>(".es-rail-presence")!.hasAttribute("inert")).toBe(true);
  });

  it("境目: separator（縦）で aria の値を持ち、← →（Shift で大きく）・Home / End・Enter・ダブルクリックで幅を変える", () => {
    const dock = dockOf({ side: <span>右</span> });
    const { host } = mount(<Shell dock={dock} />);
    const sashes = [...host.querySelectorAll<HTMLElement>('[role="separator"]')];
    expect(sashes.map((sash) => sash.getAttribute("aria-label"))).toEqual(["左のドックの幅", "右に並べたページの幅", "右のドックの幅"]);
    const [left, side] = sashes as [HTMLElement, HTMLElement];
    expect(left.getAttribute("aria-orientation")).toBe("vertical");
    expect(left.tabIndex).toBe(0);
    expect(left.getAttribute("aria-valuenow")).toBe("272");
    expect(left.getAttribute("aria-valuemin")).toBe("240");
    // 最大は、ほかの列の今の幅を引いてメインに 480px を残す（1680 - 420 - 340 - 480）
    expect(left.getAttribute("aria-valuemax")).toBe("440");
    expect(side.getAttribute("aria-valuemin")).toBe("320");
    expect(side.getAttribute("aria-valuemax")).toBe(String(1680 - 272 - 340 - 480));

    key(left, "ArrowRight");
    expect(dock.onWidth).toHaveBeenLastCalledWith("left", 288);
    // Shift で大きく（64px）。最小（240）より下へは行かない
    key(left, "ArrowLeft", { shiftKey: true });
    expect(dock.onWidth).toHaveBeenLastCalledWith("left", 240);
    key(side, "ArrowRight", { shiftKey: true });
    expect(dock.onWidth).toHaveBeenLastCalledWith("side", 420 - 64);
    // 右のページは左へ動かすと広がる
    key(side, "ArrowLeft");
    expect(dock.onWidth).toHaveBeenLastCalledWith("side", 436);
    key(side, "Home");
    expect(dock.onWidth).toHaveBeenLastCalledWith("side", 320);
    key(side, "End");
    expect(dock.onWidth).toHaveBeenLastCalledWith("side", 1680 - 272 - 340 - 480);
    key(left, "Enter");
    expect(dock.onWidth).toHaveBeenLastCalledWith("left", 272);
    act(() => {
      side.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(dock.onWidth).toHaveBeenLastCalledWith("side", 420);
  });

  it("境目はドラッグ（pointer）でも動かせる。右のページ・右のドックは左へ動かすと広がる", () => {
    const dock = dockOf({ side: <span>右</span> });
    const { host } = mount(<Shell dock={dock} />);
    const [left, side] = [...host.querySelectorAll<HTMLElement>('[role="separator"]')] as [HTMLElement, HTMLElement];
    const pointer = (target: Element, type: string, clientX: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { button: { value: 0 }, pointerId: { value: 1 }, clientX: { value: clientX }, clientY: { value: 0 } });
      act(() => {
        target.dispatchEvent(event);
      });
    };
    pointer(left, "pointerdown", 272);
    pointer(left, "pointermove", 312);
    expect(dock.onWidth).toHaveBeenLastCalledWith("left", 312);
    pointer(left, "pointerup", 312);
    pointer(left, "pointermove", 400);
    expect(dock.onWidth).toHaveBeenCalledTimes(1);
    pointer(side, "pointerdown", 1000);
    pointer(side, "pointermove", 960);
    expect(dock.onWidth).toHaveBeenLastCalledWith("side", 460);
  });

  it("分割ビューの枠に axe の serious 以上の違反が無い（境目・細い列・右のページ）", async () => {
    const side = <ShellSidePane pageId="b" title="右" onSwap={vi.fn()} onClose={vi.fn()}><p>本文</p></ShellSidePane>;
    mount(<Shell dock={dockOf({ width: 1100, side })} />);
    const result = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.filter((entry) => entry.impact === "serious" || entry.impact === "critical")).toEqual([]);
  });

  it("入りきらないときは細い列。アイコンで上に重ねて開き、Esc・外側の押下で閉じる", () => {
    const onPeek = vi.fn();
    const { host, render } = mount(<Shell dock={dockOf({ width: 1024, onPeek })} />);
    const pane = host.querySelector<HTMLElement>(".es-pane")!;
    expect(pane.dataset.state).toBe("strip");
    const strip = host.querySelector<HTMLElement>('.es-strip[data-dock="left"]')!;
    const open = strip.querySelector<HTMLButtonElement>('button[aria-label="一覧を開く"]')!;
    expect(open.getAttribute("aria-expanded")).toBe("false");
    act(() => open.click());
    expect(onPeek).toHaveBeenLastCalledWith("left");

    render(<Shell dock={dockOf({ width: 1024, onPeek, peek: "left" })} />);
    expect(pane.dataset.state).toBe("peek");
    expect(pane.style.getPropertyValue("--es-peek-w")).toBe("272px");
    // 中を押しても閉じない
    act(() => {
      pane.querySelector("input")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(onPeek).toHaveBeenCalledTimes(1);
    key(document.body, "Escape");
    expect(onPeek).toHaveBeenLastCalledWith(null);
    expect(document.activeElement).toBe(open);
    act(() => {
      host.querySelector("main")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(onPeek).toHaveBeenCalledTimes(3);
  });

  it("浮かせた AI を開いているときは、上端に高さの取っ手（横の separator、↑↓）", () => {
    const onHeight = vi.fn();
    const { host } = mount(<Shell dock={dockOf({ place: { list: "left", ai: "float" }, float: { open: true, height: 360, max: 700, onHeight } })} />);
    const presence = host.querySelector<HTMLElement>(".es-rail-presence")!;
    expect(presence.dataset).toMatchObject({ dock: "float", float: "open" });
    expect(presence.style.getPropertyValue("--es-float-open")).toBe("360px");
    const handle = presence.querySelector<HTMLElement>('[role="separator"]')!;
    expect(handle.getAttribute("aria-label")).toBe("AIの高さ");
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    expect(handle.getAttribute("aria-valuemax")).toBe("700");
    key(handle, "ArrowUp");
    expect(onHeight).toHaveBeenLastCalledWith(384);
    key(handle, "ArrowDown", { shiftKey: true });
    expect(onHeight).toHaveBeenLastCalledWith(360 - 96);
    // 浮かせているあいだ AI は右のドックにいないので、右の境目は出さない
    expect(host.querySelector('[aria-label="右のドックの幅"]')).toBeNull();
    expect(host.querySelector<HTMLElement>(".es-root")!.dataset.ai).toBe("float");
  });

  it("本文への落とし先は、ページ用の型のときだけ出す（写真・文字のドラッグでは出さない）", () => {
    const dock = dockOf();
    const { host } = mount(<Shell dock={dock} />);
    const root = host.querySelector<HTMLElement>(".es-root")!;
    drag(root, "dragenter", transfer({ "application/x-niho-photo": "p1", "text/plain": "写真" }));
    drag(root, "dragover", transfer({ "text/plain": "文字", "text/html": "<b>文字</b>" }));
    expect(host.querySelector(".es-dzs")).toBeNull();

    const data = transfer({ [SHELL_DND.page]: "page-b", "text/plain": "page-b" });
    drag(root, "dragenter", data);
    const zones = [...host.querySelectorAll<HTMLElement>(".es-dz")];
    expect(zones.map((zone) => zone.textContent)).toEqual(["ここで開くメインを替える", "右に並べるメインはそのまま"]);
    drag(zones[1]!, "dragover", data);
    expect(zones[1]!.className).toContain("es-dz--hot");
    drag(zones[1]!, "drop", data);
    expect(dock.onDropPage).toHaveBeenCalledWith("page-b", "side");
    expect(host.querySelector(".es-dzs")).toBeNull();
  });

  it("右のページがあれば「右のページを替える」。右のページの帯は真ん中の「メインに置く」だけ", () => {
    const dock = dockOf({ side: <span>右</span> });
    const { host } = mount(<Shell dock={dock} />);
    const root = host.querySelector<HTMLElement>(".es-root")!;
    drag(root, "dragenter", transfer({ [SHELL_DND.page]: "page-c" }));
    expect([...host.querySelectorAll(".es-dz")].map((zone) => zone.textContent)).toEqual(["ここで開くメインを替える", "右のページを替える"]);
    drag(root, "dragend", transfer());
    expect(host.querySelector(".es-dzs")).toBeNull();

    const band = transfer({ [SHELL_DND.side]: "page-b" });
    drag(root, "dragenter", band);
    const zones = [...host.querySelectorAll<HTMLElement>(".es-dz")];
    expect(zones.map((zone) => zone.textContent)).toEqual(["メインに置くいまのメインは右へ移ります"]);
    drag(zones[0]!, "drop", band);
    expect(dock.onDropSide).toHaveBeenCalledTimes(1);
  });

  it("パネルを掴むと、近づけた場所に「落とすと入る形」を出し、そこへ落とすと移す（真ん中では何もしない）", () => {
    const dock = dockOf();
    const { host } = mount(<Shell dock={dock} />);
    const root = host.querySelector<HTMLElement>(".es-root")!;
    root.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1680, bottom: 900, width: 1680, height: 900, toJSON: () => ({}) }) as DOMRect;
    const ai = transfer({ [SHELL_DND.ai]: "ai" });
    // 真ん中
    const middle = drag(root, "dragover", ai, { x: 800, y: 300 });
    expect(middle.defaultPrevented).toBe(false);
    expect(host.querySelector(".es-ghost")).toBeNull();
    // 今いる右のドックでは出さない
    drag(root, "dragover", ai, { x: 1600, y: 300 });
    expect(host.querySelector(".es-ghost")).toBeNull();
    // 左の端
    const over = drag(root, "dragover", ai, { x: 30, y: 300 });
    expect(over.defaultPrevented).toBe(true);
    expect(host.querySelector(".es-ghost")!.textContent).toBe("左のドック「AIと作る」を入れる");
    // メインの下端（AI だけ）
    drag(root, "dragover", ai, { x: 800, y: 860 });
    expect(host.querySelector(".es-ghost")!.textContent).toBe("メインの下に浮かせる");
    drag(root, "drop", ai, { x: 800, y: 860 });
    expect(dock.onMove).toHaveBeenCalledWith("ai", "float");
    expect(host.querySelector(".es-ghost")).toBeNull();
    // 一覧はメインの下端では何もしない
    const list = transfer({ [SHELL_DND.list]: "list" });
    drag(root, "dragover", list, { x: 800, y: 860 });
    expect(host.querySelector(".es-ghost")).toBeNull();
    drag(root, "dragover", list, { x: 1650, y: 300 });
    drag(root, "drop", list, { x: 1650, y: 300 });
    expect(dock.onMove).toHaveBeenLastCalledWith("list", "right");
  });
});

describe("右に並べたページの枠（ShellSidePane）", () => {
  it("題名は本文の先頭に 1 か所。帯は掴む所・⇄・× だけで、文字は出さない", () => {
    const onSwap = vi.fn();
    const onClose = vi.fn();
    const { host } = mount(
      <ShellSidePane pageId="page-b" title="取材メモ" onSwap={onSwap} onClose={onClose}>
        <p>本文</p>
      </ShellSidePane>,
    );
    const pane = host.querySelector<HTMLElement>(".es-side")!;
    expect(pane.getAttribute("aria-label")).toBe("右に並べたページ");
    expect([...pane.querySelectorAll(".es-side-tt")].map((node) => node.textContent)).toEqual(["取材メモ"]);
    expect(pane.textContent?.match(/取材メモ/g)).toHaveLength(1);
    const band = pane.querySelector<HTMLElement>(".es-side-band")!;
    expect(band.textContent).toBe("");
    expect([...band.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual(["メインと入れ替える", "右のページを閉じる"]);
    act(() => band.querySelector<HTMLButtonElement>('button[aria-label="メインと入れ替える"]')!.click());
    act(() => band.querySelector<HTMLButtonElement>('button[aria-label="右のページを閉じる"]')!.click());
    expect(onSwap).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(band.getAttribute("draggable")).toBe("true");
    const data = transfer();
    drag(band, "dragstart", data);
    expect(data.store[SHELL_DND.side]).toBe("page-b");
  });

  it("題名を渡さない間（読み込み中）は題名を出さない。空の題名は「無題」", () => {
    const { host, render } = mount(<ShellSidePane pageId="b" onSwap={vi.fn()} onClose={vi.fn()}>読み込んでいます</ShellSidePane>);
    expect(host.querySelector(".es-side-tt")).toBeNull();
    render(<ShellSidePane pageId="b" title="" onSwap={vi.fn()} onClose={vi.fn()}>本文</ShellSidePane>);
    expect(host.querySelector(".es-side-tt")!.textContent).toBe("無題");
  });
});

describe("一覧の右に並べる操作・行の削除・パネルの移動（ShellSidebar）", () => {
  const items = [
    { id: "a", title: "鎌倉の朝さんぽ", when: "5分前" },
    { id: "b", title: "取材メモ", when: "昨日" },
    { id: "c", title: "写真の候補", when: "10/29" },
  ];
  const me = { onOpen: vi.fn() };
  const row = (host: HTMLElement, title: string) => [...host.querySelectorAll<HTMLElement>(".es-dirow")].find((node) => node.querySelector(".es-di-t")?.textContent === title)!;

  it("side も onDeleteRow も渡さなければ、右クリックはブラウザのまま・行はドラッグしない・「…」も無い", () => {
    const { host } = mount(<ShellSidebar items={items} currentId="a" me={me} />);
    const target = row(host, "取材メモ");
    expect(target.hasAttribute("draggable")).toBe(false);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => {
      target.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(host.querySelector(".es-di-side")).toBeNull();
    expect(host.querySelector(".es-di-more")).toBeNull();
  });

  it("⌥クリック・⌥Enter で右に並べる。右に出しているページには印。side だけではメニューを出さない", () => {
    const side = { id: "c", onOpen: vi.fn() };
    const onSelect = vi.fn();
    const { host } = mount(<ShellSidebar items={items} currentId="a" onSelect={onSelect} side={side} me={me} />);
    expect(row(host, "写真の候補").querySelector(".es-di-side")!.textContent).toBe("右に表示中");

    act(() => row(host, "取材メモ").querySelector<HTMLButtonElement>(".es-di")!.dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true })));
    expect(side.onOpen).toHaveBeenLastCalledWith("b");
    expect(onSelect).not.toHaveBeenCalled();
    key(row(host, "取材メモ").querySelector(".es-di")!, "Enter", { altKey: true });
    expect(side.onOpen).toHaveBeenCalledTimes(2);

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => {
      row(host, "取材メモ").dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(host.querySelector(".es-di-more")).toBeNull();
  });

  it("onDeleteRow を渡すと、行の「…」・右クリック・Shift+F10 のメニューは「削除」だけ。選ぶと閉じて「…」へフォーカスを戻し onDeleteRow", () => {
    const onDeleteRow = vi.fn();
    const onSelect = vi.fn();
    const { host, render } = mount(<ShellSidebar items={items} currentId="a" onSelect={onSelect} onDeleteRow={onDeleteRow} me={me} />);
    const more = row(host, "取材メモ").querySelector<HTMLButtonElement>(".es-di-more")!;
    expect(more.getAttribute("aria-label")).toBe("取材メモ のメニュー");
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    expect(more.getAttribute("aria-expanded")).toBe("false");

    act(() => more.click());
    const menu = host.querySelector<HTMLElement>('[role="menu"][aria-label="ページのメニュー"]')!;
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["削除"]);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    // もう一度押すと閉じる
    act(() => more.click());
    expect(host.querySelector('[role="menu"]')).toBeNull();

    act(() => more.click());
    act(() => host.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
    expect(onDeleteRow).toHaveBeenLastCalledWith("b");
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(more);
    expect(onSelect).not.toHaveBeenCalled();

    // メインで開いている行も同じ「削除」だけ
    key(row(host, "鎌倉の朝さんぽ").querySelector(".es-di")!, "F10", { shiftKey: true });
    expect([...host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["削除"]);
    key(document.activeElement!, "Escape");
    act(() => {
      row(host, "写真の候補").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }));
    });
    act(() => host.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
    expect(onDeleteRow).toHaveBeenLastCalledWith("c");

    // side が無い（狭い幅）ときは ⌥クリックで並べず、ふつうに開く。ドラッグも載せない
    act(() => row(host, "取材メモ").querySelector<HTMLButtonElement>(".es-di")!.dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true })));
    expect(onSelect).toHaveBeenLastCalledWith("b");
    expect(row(host, "取材メモ").hasAttribute("draggable")).toBe(false);

    // 題名のない行は「無題 のメニュー」
    render(<ShellSidebar items={[{ id: "d", title: "", when: "今" }]} onDeleteRow={onDeleteRow} me={me} />);
    expect(host.querySelector(".es-di-more")!.getAttribute("aria-label")).toBe("無題 のメニュー");
  });

  it("行のドラッグはページ用の型を載せる（検索の結果のように並べ替えない行でも）", () => {
    const { host } = mount(<ShellSidebar items={items} currentId="a" side={{ onOpen: vi.fn() }} me={me} />);
    const target = row(host, "取材メモ");
    expect(target.getAttribute("draggable")).toBe("true");
    const data = transfer();
    drag(target, "dragstart", data);
    expect(data.store).toEqual({ [SHELL_DND.page]: "b" });
    expect(data.effectAllowed).toBe("copyMove");
  });

  it("並べ替えもできる一覧では、並べ替えの値（text/plain）とページ用の型の両方を載せる", () => {
    const { host } = mount(<ShellSidebar items={items} currentId="a" onDrop={vi.fn()} side={{ onOpen: vi.fn() }} me={me} />);
    const data = transfer();
    drag(row(host, "取材メモ"), "dragstart", data);
    expect(data.store).toEqual({ "text/plain": "b", [SHELL_DND.page]: "b" });
  });

  it("panel を渡すと、上段を掴んで動かせる（移すメニューは無い。ドラッグだけ）", () => {
    const { host } = mount(<ShellSidebar items={items} panel me={me} />);
    const top = host.querySelector<HTMLElement>(".es-sb-top")!;
    expect(top.getAttribute("draggable")).toBe("true");
    expect(top.querySelector(".es-grip")).not.toBeNull();
    const data = transfer();
    drag(top, "dragstart", data);
    expect(data.store[SHELL_DND.list]).toBe("list");
    expect(host.querySelector('button[aria-label="一覧のメニュー"]')).toBeNull();
    const plain = mount(<ShellSidebar items={items} me={me} />).host.querySelector<HTMLElement>(".es-sb-top")!;
    expect(plain.hasAttribute("draggable")).toBe(false);
    expect(plain.querySelector(".es-grip")).toBeNull();
  });
});

describe("shell.css の分割ビュー", () => {
  const css = readFileSync(path.resolve(__dirname, "../styles/shell.css"), "utf8");
  const P = ":where([data-docs-app-root]):where([data-docs-shared-ui]) ";
  const D = `${P}.es-root[data-layout="dock"][data-wide="true"]`;

  it("一覧の包みは 900px 未満（wide でない）では display:contents。grid に並べるのはデスクトップだけ", () => {
    expect(css).toContain(`${P}.es-root .es-pane{display:contents}`);
    expect(css).toContain(`${D} .es-doc,${D} .es-dbody{display:contents}`);
    // 900px 未満の決まりは 1 か所のまま（分割ビューの規則は @media (max-width:900px) に入れない）
    expect(css.match(/@media \(max-width:900px\)/g)).toHaveLength(1);
  });

  it("浮かせた AI は本文と同じ幅（最大 680px）で、本文の下に浮かべた高さぶんの余白を足す", () => {
    expect(css).toMatch(/\[data-dock="float"\]\{[^}]*width:min\(680px,calc\(100% - 48px\)\)/);
    expect(css).toMatch(/\[data-ai="float"\] \.es-canvas\{padding-bottom:calc\(var\(--es-float-h,72px\) \+ 40px\)/);
  });
});
