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
  SHELL_DOCKS_DEFAULT,
  SHELL_DOCK_DEFAULT,
  ShellPanelHead,
  ShellRail,
  ShellSidePane,
  ShellSidebar,
  computeShellDock,
  dockPanels,
  type EditorShellDock,
  type ShellDocks,
  type ShellPanelId,
} from "./index";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  act(() => roots.forEach((root) => root.unmount()));
  roots.length = 0;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
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

const rectOf = (width: number, height: number) => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) }) as DOMRect;

/** 枠（.es-ws）と .es-root の大きさを jsdom で測れるようにする（ほかの要素は 0）。 */
function sizeBox(width = 1680, height = 900) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("es-ws") || this.classList.contains("es-root") ? rectOf(width, height) : rectOf(0, 0);
  });
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
type Shown = Record<ShellPanelId, boolean>;
const ALL: Shown = { list: true, ai: true, page: true, photos: true };

function dockOf(over: Over = {}, shown: Shown = ALL): EditorShellDock {
  const docks: ShellDocks = over.docks ?? SHELL_DOCKS_DEFAULT;
  const widths = over.widths ?? { ...SHELL_DOCK_DEFAULT };
  const panels = dockPanels(docks, shown);
  const fit =
    over.fit ??
    computeShellDock({ width: over.width ?? 1680, widths, docks: { left: panels.left.map((item) => item.id), right: panels.right.map((item) => item.id) }, side: Boolean(over.side) });
  const { width: _width, ...rest } = over;
  return { wide: true, onWidth: vi.fn(), onMove: vi.fn(), onResize: vi.fn(), onPeek: vi.fn(), onDropPage: vi.fn(), onDropSide: vi.fn(), ...rest, docks, widths, fit };
}

type ShellProps = { dock?: EditorShellDock; sidebarOpen?: boolean; railOpen?: boolean; pageOpen?: boolean; photosOpen?: boolean; onClosePage?: () => void; settings?: boolean };

function Shell({ dock, sidebarOpen = true, railOpen = true, pageOpen = true, photosOpen = true, onClosePage, settings }: ShellProps) {
  return (
    <EditorShell
      sidebar={sidebar}
      header={<header className="es-dt">ヘッダー</header>}
      rail={
        <ShellRail>
          <Draft />
        </ShellRail>
      }
      page={
        <>
          <ShellPanelHead panel="page" drag onClose={onClosePage ?? (() => undefined)} />
          <div className="es-pn-body">ページのパネル</div>
        </>
      }
      photos={<div className="es-pn-body">写真のパネル</div>}
      corner={<span>文字数</span>}
      sidebarOpen={sidebarOpen}
      railOpen={railOpen}
      pageOpen={pageOpen}
      photosOpen={photosOpen}
      settings={settings ? { onOpen: () => undefined } : undefined}
      dock={dock}
    >
      <p>本文</p>
    </EditorShell>
  );
}

const pane = (host: HTMLElement, id: ShellPanelId) => host.querySelector<HTMLElement>(`.es-pn[data-panel="${id}"]`)!;

describe("EditorShell のパネルの配置（dock）", () => {
  it("dock を渡さなければ従来の DOM のまま（一覧｜ヘッダー＋ページ＋レール。一覧を出しているのでアプリ名は一覧の上の行で、枠の帯は無い。パネルの要素・style は無い）", () => {
    const { host, render } = mount(<Shell />);
    const root = host.querySelector<HTMLElement>(".es-root")!;
    expect([...root.attributes].map((attr) => attr.name).sort()).toEqual(["class", "data-editor-shell", "data-left", "data-rail", "data-sidebar", "data-view"]);
    expect([...root.children].map((node) => node.className)).toEqual(["es-skip", "es-ws"]);
    const ws = root.querySelector<HTMLElement>(".es-ws")!;
    expect(ws.getAttribute("style")).toBeNull();
    expect([...ws.children].map((node) => node.className)).toEqual(["es-sb", "es-doc"]);
    expect([...root.querySelector(".es-dbody")!.children].map((node) => node.className)).toEqual(["es-canvas", "es-rail-presence", "es-corner"]);
    const presence = root.querySelector<HTMLElement>(".es-rail-presence")!;
    expect([...presence.attributes].map((attr) => attr.name).sort()).toEqual(["class"]);
    expect(root.querySelector(".es-pn, .es-sash, .es-strip, .es-sidecol, .es-dzs, .es-ghost")).toBeNull();
    // 「ページ」「写真」のパネルは dock のときだけ
    expect(root.textContent).not.toContain("ページのパネル");
    // 一覧をしまうと、アプリ名は枠の帯（skip link の次）
    render(<Shell sidebarOpen={false} />);
    expect([...root.children].map((node) => node.className)).toEqual(["es-skip", "es-brandbar", "es-ws"]);
  });

  it("既定の配置: 左＝一覧、右＝ページ（上）＋AI（下）。パネルは絶対配置で、位置は割合", () => {
    const { host } = mount(<Shell dock={dockOf()} />);
    const root = host.querySelector<HTMLElement>(".es-root")!;
    expect(root.dataset).toMatchObject({ layout: "dock", wide: "true", left: "dock" });
    expect(root.style.getPropertyValue("--es-left-w")).toBe("272px");
    expect(root.querySelector<HTMLElement>(".es-ws")!.style.gridTemplateColumns).toBe("272px 0px minmax(0,1fr) 0px 0px 0px 340px");
    // 木の順はいつも 一覧・AI・ページ・写真（置き場所に関係なく）
    expect([...root.querySelectorAll<HTMLElement>(".es-pn")].map((node) => node.dataset.panel)).toEqual(["list", "ai", "page", "photos"]);
    const list = pane(host, "list");
    expect(list.dataset).toMatchObject({ dock: "left", state: "open", index: "0" });
    expect(list.style.width).toBe("272px");
    // 左のドックの一番上の一覧は、アプリ名の段も使う（上端 0。上の 1 行の左にアプリ名を出す）
    expect(list.style.top).toBe("0px");
    expect(list.style.height).toBe("calc(var(--es-header) + (100% - 2 * var(--es-header)) * 1)");
    const page = pane(host, "page");
    expect(page.dataset).toMatchObject({ dock: "right", index: "0" });
    expect(page.style.top).toBe("0%");
    expect(page.style.height).toBe("50%");
    const ai = pane(host, "ai");
    expect(ai.dataset).toMatchObject({ dock: "right", index: "1" });
    expect(ai.style.top).toBe("50%");
    expect(ai.style.height).toBe("50%");
    expect(ai.style.width).toBe("340px");
    // 写真は閉じている（どちらのドックにも無い）
    const photos = pane(host, "photos");
    expect(photos.hidden).toBe(true);
    expect(photos.hasAttribute("data-dock")).toBe(false);
    expect(photos.hasAttribute("inert")).toBe(true);
  });

  it("高さの割合は docks の size から（3 つなら 3 段）。隠したパネルは数えない", () => {
    const docks: ShellDocks = { left: [], right: [{ id: "list", size: 1 }, { id: "page", size: 2 }, { id: "ai", size: 1 }] };
    const { host, render } = mount(<Shell dock={dockOf({ docks })} />);
    expect(host.querySelector<HTMLElement>(".es-root")!.dataset.left).toBe("none");
    expect(pane(host, "list").style.top).toBe("0%");
    expect(pane(host, "page").style.top).toBe("25%");
    expect(pane(host, "page").style.height).toBe("50%");
    expect(pane(host, "ai").style.top).toBe("75%");
    render(<Shell dock={dockOf({ docks }, { ...ALL, page: false })} pageOpen={false} />);
    expect(pane(host, "page").hidden).toBe(true);
    expect(pane(host, "ai").style.top).toBe("50%");
    expect(pane(host, "ai").dataset.index).toBe("1");
  });

  it("AI を左へ・一覧を右へ・狭い画面へ動かしても、同じ要素のまま（書きかけと中の状態が残る）", () => {
    const { host, render } = mount(<Shell dock={dockOf()} />);
    const field = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="AIへのメッセージ"]')!;
    const list = host.querySelector<HTMLInputElement>('input[aria-label="一覧の中の入力"]')!;
    field.value = "書きかけの依頼";
    list.value = "探している語";
    act(() => host.querySelector<HTMLButtonElement>("section button")!.click());

    const swapped: ShellDocks = { left: [{ id: "ai", size: 1 }], right: [{ id: "page", size: 1 }, { id: "list", size: 1 }] };
    render(<Shell dock={dockOf({ docks: swapped })} />);
    expect(pane(host, "ai").dataset.dock).toBe("left");
    expect(pane(host, "list").dataset).toMatchObject({ dock: "right", index: "1" });
    render(<Shell dock={{ ...dockOf(), wide: false }} />);
    render(<Shell dock={dockOf()} />);

    const after = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="AIへのメッセージ"]')!;
    expect(after).toBe(field);
    expect(after.value).toBe("書きかけの依頼");
    expect(host.querySelector('input[aria-label="一覧の中の入力"]')).toBe(list);
    expect(list.value).toBe("探している語");
    expect(host.querySelector("section button")!.textContent).toBe("数える 1");
  });

  it("900px 未満（wide=false）は 1 枚表示: grid の style・位置・境目・右のページ・細い列を出さない。一覧 > ほかのパネル > ページ", () => {
    const side = <ShellSidePane pageId="b" title="右" onSwap={vi.fn()} onClose={vi.fn()}>本文</ShellSidePane>;
    const { host, render } = mount(<Shell dock={{ ...dockOf({ side, width: 1100 }), wide: false }} />);
    const root = host.querySelector<HTMLElement>(".es-root")!;
    expect(root.dataset.wide).toBe("false");
    expect(root.dataset.view).toBe("list");
    expect(root.querySelector<HTMLElement>(".es-ws")!.getAttribute("style")).toBeNull();
    expect(root.getAttribute("style")).toBeNull();
    for (const id of ["list", "ai", "page", "photos"] as const) {
      expect(pane(host, id).getAttribute("style")).toBeNull();
      expect(pane(host, id).hasAttribute("data-dock")).toBe(false);
    }
    expect(root.querySelector(".es-sash, .es-strip, .es-sidecol, .es-side")).toBeNull();
    render(<Shell dock={{ ...dockOf(), wide: false }} sidebarOpen={false} railOpen={false} pageOpen photosOpen={false} />);
    expect(root.dataset.view).toBe("rail");
    expect(pane(host, "page").hidden).toBe(false);
    expect(pane(host, "ai").hidden).toBe(true);
    render(<Shell dock={{ ...dockOf(), wide: false }} sidebarOpen={false} railOpen={false} pageOpen={false} photosOpen={false} />);
    expect(root.dataset.view).toBe("page");
  });

  it("閉じたパネルは、どのドックにいても hidden と inert（中の状態は残す）", () => {
    const docks: ShellDocks = { left: [{ id: "ai", size: 1 }, { id: "photos", size: 1 }], right: [{ id: "list", size: 1 }, { id: "page", size: 1 }] };
    const { host } = mount(<Shell dock={dockOf({ docks }, { list: false, ai: false, page: false, photos: false })} sidebarOpen={false} railOpen={false} pageOpen={false} photosOpen={false} />);
    for (const id of ["list", "ai", "page", "photos"] as const) {
      expect(pane(host, id).hidden).toBe(true);
      expect(pane(host, id).hasAttribute("inert")).toBe(true);
      expect(pane(host, id).getAttribute("aria-hidden")).toBe("true");
    }
    expect(host.querySelector<HTMLElement>(".es-root")!.dataset).toMatchObject({ sidebar: "closed", rail: "closed", left: "none" });
    expect(host.querySelector<HTMLElement>(".es-ws")!.style.gridTemplateColumns).toBe("0px 0px minmax(0,1fr) 0px 0px 0px 0px");
  });

  it("アプリ名は左上端、設定は左下（settings を渡したとき）。左上が一覧なら一覧の上の 1 行の左、それ以外は枠の帯（skip link の次）。左のドックが細い列なら中央のヘッダーの左を空ける（data-left=none）", () => {
    const real = (dock: EditorShellDock) => (
      <EditorShell sidebar={<ShellSidebar items={[]} search={{ open: false, value: "", onOpen: vi.fn(), onClose: vi.fn(), onChange: vi.fn() }} panel />} header={<header className="es-dt">ヘッダー</header>} rail={<ShellRail>AI</ShellRail>} sidebarOpen railOpen settings={{ onOpen: () => undefined }} dock={dock}>
        <p>本文</p>
      </EditorShell>
    );
    const brands = (root: HTMLElement) => [...root.querySelectorAll(".es-brand")].map((node) => node.parentElement!.className);
    const { host, render } = mount(real(dockOf()));
    const root = host.querySelector<HTMLElement>(".es-root")!;
    // 既定（左の一番上が一覧）: 「Editor ⋮⋮ …… 検索」の 1 行。枠の帯は出さない
    expect([...root.children].map((node) => node.className)).toEqual(["es-skip", "es-ws", "es-setbar"]);
    expect(brands(root)).toEqual(["es-sb-top"]);
    expect([...root.querySelector(".es-sb-top")!.children].map((node) => node.className)).toEqual(["es-brand", "es-grip", "es-sp", "es-ib"]);
    expect(root.querySelector(".es-sb")!.getAttribute("data-brand")).toBe("true");
    expect(root.querySelector(".es-setbar .es-sb-me")?.textContent).toBe("設定");
    expect(root.dataset.left).toBe("dock");
    // 検索を開いたら行は検索欄だけ（アプリ名も隠す）
    render(
      <EditorShell sidebar={<ShellSidebar items={[]} search={{ open: true, value: "", onOpen: vi.fn(), onClose: vi.fn(), onChange: vi.fn() }} />} header={null} sidebarOpen railOpen={false} dock={dockOf()}>
        x
      </EditorShell>,
    );
    expect(brands(root)).toEqual([]);
    expect(root.querySelector(".es-sb-top .es-sb-find")).not.toBeNull();
    // 一覧を右のドックへ移した・左の一番上が AI: アプリ名は枠の帯。一覧は上の行にアプリ名を出さない
    for (const docks of [
      { left: [], right: [{ id: "list", size: 1 }, { id: "ai", size: 1 }] },
      { left: [{ id: "ai", size: 1 }, { id: "list", size: 1 }], right: [] },
    ] satisfies ShellDocks[]) {
      render(real(dockOf({ docks })));
      expect(brands(root)).toEqual(["es-brandbar"]);
      expect(root.querySelector(".es-sb")!.hasAttribute("data-brand")).toBe(false);
      expect(pane(host, "list").style.top).not.toBe("0px");
    }
    // 左のドックが細い列: 枠の帯が中央のヘッダーの左に重なる
    render(real(dockOf({ width: 1024 })));
    expect(pane(host, "list").dataset.state).toBe("strip");
    expect(root.dataset.left).toBe("none");
    expect(brands(root)).toEqual(["es-brandbar"]);
    // 900px 未満（wide でない）: 一覧の画面なら一覧の上の行、ページの画面なら枠の帯（CSS が隠す）
    render(real({ ...dockOf(), wide: false }));
    expect(brands(root)).toEqual(["es-sb-top"]);
  });

  it("境目: separator（縦）で aria の値を持ち、← →（Shift で大きく）・Home / End・Enter・ダブルクリックで幅を変える", () => {
    const dock = dockOf({ side: <span>右</span> });
    const { host } = mount(<Shell dock={dock} />);
    const sashes = [...host.querySelectorAll<HTMLElement>('[role="separator"][aria-orientation="vertical"]')];
    expect(sashes.map((sash) => sash.getAttribute("aria-label"))).toEqual(["左のドックの幅", "右に並べたページの幅", "右のドックの幅"]);
    const [left, side] = sashes as [HTMLElement, HTMLElement];
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
    const [left, side] = [...host.querySelectorAll<HTMLElement>('[role="separator"][aria-orientation="vertical"]')] as [HTMLElement, HTMLElement];
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

  it("同じドックの上下の境目: 横の separator。値は上のパネルの高さ（px。最小 90）、↑↓・Enter（半々）・ドラッグで割合（fraction）を知らせる", () => {
    sizeBox(1680, 900);
    const dock = dockOf();
    const { host } = mount(<Shell dock={dock} />);
    const splits = [...host.querySelectorAll<HTMLElement>('[role="separator"][aria-orientation="horizontal"]')];
    expect(splits.map((split) => split.getAttribute("aria-label"))).toEqual(["「ページ」と「AIと作る」の境目"]);
    const split = splits[0]!;
    expect(split.className).toBe("es-sash es-sash--split");
    expect(split.style.top).toBe("50%");
    expect(split.style.width).toBe("340px");
    expect(split.getAttribute("aria-valuenow")).toBe("450");
    expect(split.getAttribute("aria-valuemin")).toBe("90");
    expect(split.getAttribute("aria-valuemax")).toBe("810");
    // ↓ で境目が下がり、上のパネルが広がる（24px。Shift で 96px）
    key(split, "ArrowDown");
    expect(dock.onResize).toHaveBeenLastCalledWith("right", 1, 474 / 900);
    key(split, "ArrowUp", { shiftKey: true });
    expect(dock.onResize).toHaveBeenLastCalledWith("right", 1, 354 / 900);
    key(split, "Home");
    expect(dock.onResize).toHaveBeenLastCalledWith("right", 1, 90 / 900);
    key(split, "Enter");
    expect(dock.onResize).toHaveBeenLastCalledWith("right", 1, 0.5);
    const pointer = (type: string, clientY: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { button: { value: 0 }, pointerId: { value: 1 }, clientX: { value: 0 }, clientY: { value: clientY } });
      act(() => {
        split.dispatchEvent(event);
      });
    };
    // 下へ 40px 動かすと上のパネルが 40px 広がる
    pointer("pointerdown", 500);
    pointer("pointermove", 540);
    expect(dock.onResize).toHaveBeenLastCalledWith("right", 1, 490 / 900);
    pointer("pointerup", 540);
    // 左のドック（アプリ名と設定の段を除いた高さ 804）に 2 つなら、そこにも
    const docks: ShellDocks = { left: [{ id: "list", size: 3 }, { id: "photos", size: 1 }], right: [{ id: "page", size: 1 }, { id: "ai", size: 1 }] };
    const { host: more } = mount(<Shell dock={dockOf({ docks })} />);
    const leftSplit = more.querySelector<HTMLElement>('[role="separator"][aria-label="「一覧」と「写真」の境目"]')!;
    expect(leftSplit.style.top).toBe("calc(var(--es-header) + (100% - 2 * var(--es-header)) * 0.75)");
    expect(leftSplit.style.width).toBe("272px");
    expect(leftSplit.getAttribute("aria-valuenow")).toBe("603");
  });

  it("パネルの配置の枠に axe の serious 以上の違反が無い（境目・細い列・右のページ・パネルの見出し）", async () => {
    const side = <ShellSidePane pageId="b" title="右" onSwap={vi.fn()} onClose={vi.fn()}><p>本文</p></ShellSidePane>;
    mount(<Shell dock={dockOf({ width: 1100, side })} settings />);
    const result = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.filter((entry) => entry.impact === "serious" || entry.impact === "critical")).toEqual([]);
  });

  it("入りきらないときは細い列（パネルごとのアイコン）。アイコンで上に重ねて開き、Esc・外側の押下で閉じる", () => {
    const onPeek = vi.fn();
    const docks: ShellDocks = { left: [{ id: "list", size: 1 }, { id: "photos", size: 1 }], right: [{ id: "page", size: 1 }, { id: "ai", size: 1 }] };
    const { host, render } = mount(<Shell dock={dockOf({ docks, width: 1024, onPeek })} />);
    const list = pane(host, "list");
    expect(list.dataset.state).toBe("strip");
    const strip = host.querySelector<HTMLElement>('.es-strip[data-dock="left"]')!;
    expect([...strip.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual(["一覧を開く", "写真を開く"]);
    const open = strip.querySelector<HTMLButtonElement>('button[aria-label="一覧を開く"]')!;
    expect(open.getAttribute("aria-expanded")).toBe("false");
    act(() => open.click());
    expect(onPeek).toHaveBeenLastCalledWith("left");

    render(<Shell dock={dockOf({ docks, width: 1024, onPeek, peek: "left" })} />);
    expect(list.dataset.state).toBe("peek");
    expect(list.style.width).toBe("272px");
    expect(list.style.getPropertyValue("--es-peek-w")).toBe("272px");
    // 中を押しても閉じない
    act(() => {
      list.querySelector("input")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
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
    expect(zones.map((zone) => zone.textContent)).toEqual(["", ""]);
    drag(zones[1]!, "dragover", data);
    expect(zones[1]!.className).toContain("es-dz--hot");
    drag(zones[1]!, "drop", data);
    expect(dock.onDropPage).toHaveBeenCalledWith("page-b", "side");
    expect(host.querySelector(".es-dzs")).toBeNull();
  });

  it("ページの落とし先は文字の無い枠だけ。右のページの帯は真ん中だけに落とせる", () => {
    const dock = dockOf({ side: <span>右</span> });
    const { host } = mount(<Shell dock={dock} />);
    const root = host.querySelector<HTMLElement>(".es-root")!;
    drag(root, "dragenter", transfer({ [SHELL_DND.page]: "page-c" }));
    expect([...host.querySelectorAll(".es-dz")].map((zone) => zone.textContent)).toEqual(["", ""]);
    drag(root, "dragend", transfer());
    expect(host.querySelector(".es-dzs")).toBeNull();

    const band = transfer({ [SHELL_DND.side]: "page-b" });
    drag(root, "dragenter", band);
    const zones = [...host.querySelectorAll<HTMLElement>(".es-dz")];
    expect(zones.map((zone) => zone.textContent)).toEqual([""]);
    drag(zones[0]!, "drop", band);
    expect(dock.onDropSide).toHaveBeenCalledTimes(1);
  });

  it("パネルを掴むと、近づけたドックの上半分・下半分に「落とすと入る形」を出し、そこへ落とすと移す（真ん中・今いる場所では何もしない）", () => {
    sizeBox(1680, 900);
    const dock = dockOf();
    const { host } = mount(<Shell dock={dock} />);
    const root = host.querySelector<HTMLElement>(".es-root")!;
    const ai = transfer({ [SHELL_DND.ai]: "ai" });
    // 真ん中
    const middle = drag(root, "dragover", ai, { x: 800, y: 300 });
    expect(middle.defaultPrevented).toBe(false);
    expect(host.querySelector(".es-ghost")).toBeNull();
    // 今いる右のドックの下（いちばん下にいる）では出さない
    drag(root, "dragover", ai, { x: 1600, y: 800 });
    expect(host.querySelector(".es-ghost")).toBeNull();
    // 右の上半分なら「上に」（ページと入れ替わる）
    drag(root, "dragover", ai, { x: 1600, y: 100 });
    expect(host.querySelector(".es-ghost")!.textContent).toBe("");
    // 左の端の上半分（一覧がいる）
    const over = drag(root, "dragover", ai, { x: 30, y: 300 });
    expect(over.defaultPrevented).toBe(true);
    const ghost = host.querySelector<HTMLElement>(".es-ghost")!;
    expect(ghost.textContent).toBe("");
    expect(ghost.style.height).toBe("441px");
    drag(root, "dragover", ai, { x: 30, y: 700 });
    expect(host.querySelector(".es-ghost")!.textContent).toBe("");
    expect(host.querySelector<HTMLElement>(".es-ghost")!.style.top).toBe("453px");
    drag(root, "drop", ai, { x: 30, y: 700 });
    expect(dock.onMove).toHaveBeenCalledWith("ai", { side: "left", at: "bottom" });
    expect(host.querySelector(".es-ghost")).toBeNull();
    // 写真（閉じている）を右の端へ: 右にはページと AI がいる
    const photos = transfer({ [SHELL_DND.panel.photos]: "photos" });
    drag(root, "dragover", photos, { x: 1650, y: 800 });
    expect(host.querySelector(".es-ghost")!.textContent).toBe("");
    drag(root, "drop", photos, { x: 1650, y: 800 });
    expect(dock.onMove).toHaveBeenLastCalledWith("photos", { side: "right", at: "bottom" });
    // 一覧を空のドックへ（ほかのパネルが無ければドック全体）
    const empty = dockOf({ docks: { left: [{ id: "list", size: 1 }], right: [] } }, { list: true, ai: false, page: false, photos: false });
    const { host: lone } = mount(<Shell dock={empty} railOpen={false} pageOpen={false} photosOpen={false} />);
    const list = transfer({ [SHELL_DND.list]: "list" });
    drag(lone.querySelector(".es-root")!, "dragover", list, { x: 1650, y: 800 });
    expect(lone.querySelector(".es-ghost")!.textContent).toBe("");
    expect(lone.querySelector<HTMLElement>(".es-ghost")!.style.height).toBe("888px");
    drag(lone.querySelector(".es-root")!, "drop", list, { x: 1650, y: 800 });
    expect(empty.onMove).toHaveBeenLastCalledWith("list", { side: "right", at: "top" });
  });
});

describe("パネルの見出し（ShellPanelHead）と ×", () => {
  it("[掴む所] 名前 …… [操作] [×]。drag のときだけ掴めて、パネルの型を載せる。× は「◯◯を閉じる」", () => {
    const onClose = vi.fn();
    const { host } = mount(
      <ShellPanelHead panel="photos" drag onClose={onClose}>
        <button type="button" aria-label="写真を足す">＋</button>
      </ShellPanelHead>,
    );
    const head = host.querySelector<HTMLElement>(".es-pn-hd")!;
    expect(head.getAttribute("draggable")).toBe("true");
    expect(head.querySelector(".es-grip")).not.toBeNull();
    expect(head.querySelector("h2.es-pn-tt")?.textContent).toBe("写真");
    expect([...head.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual(["写真を足す", "写真を閉じる"]);
    const data = transfer();
    drag(head, "dragstart", data);
    expect(data.store[SHELL_DND.panel.photos]).toBe("photos");
    act(() => head.querySelector<HTMLButtonElement>('button[aria-label="写真を閉じる"]')!.click());
    expect(onClose).toHaveBeenCalledTimes(1);

    const plain = mount(<ShellPanelHead panel="page" title="流れ" />).host.querySelector<HTMLElement>(".es-pn-hd")!;
    expect(plain.hasAttribute("draggable")).toBe(false);
    expect(plain.querySelector(".es-grip")).toBeNull();
    expect(plain.querySelector(".es-pn-tt")?.textContent).toBe("流れ");
    expect(plain.querySelector("button")).toBeNull();
  });

  it("ShellRail に onClosePanel を渡すと、レールの右上に「AIと作るを閉じる」を重ねる（シートのときは出さない）", () => {
    const onClosePanel = vi.fn();
    const { host } = mount(
      <ShellRail onClosePanel={onClosePanel}>
        <Draft />
      </ShellRail>,
    );
    const close = host.querySelector<HTMLButtonElement>('aside.es-rail > button.es-pn-x--over')!;
    expect(close.getAttribute("aria-label")).toBe("AIと作るを閉じる");
    expect(close).toBe(host.querySelector("aside.es-rail")!.lastElementChild);
    act(() => close.click());
    expect(onClosePanel).toHaveBeenCalledTimes(1);
    expect(mount(<ShellRail><Draft /></ShellRail>).host.querySelector(".es-pn-x")).toBeNull();
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
    const { host } = mount(<ShellSidebar items={items} currentId="a" />);
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
    const { host } = mount(<ShellSidebar items={items} currentId="a" onSelect={onSelect} side={side} />);
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
    const { host, render } = mount(<ShellSidebar items={items} currentId="a" onSelect={onSelect} onDeleteRow={onDeleteRow} />);
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
    render(<ShellSidebar items={[{ id: "d", title: "", when: "今" }]} onDeleteRow={onDeleteRow} />);
    expect(host.querySelector(".es-di-more")!.getAttribute("aria-label")).toBe("無題 のメニュー");
  });

  it("行のドラッグはページ用の型を載せる（検索の結果のように並べ替えない行でも）", () => {
    const { host } = mount(<ShellSidebar items={items} currentId="a" side={{ onOpen: vi.fn() }} />);
    const target = row(host, "取材メモ");
    expect(target.getAttribute("draggable")).toBe("true");
    const data = transfer();
    drag(target, "dragstart", data);
    expect(data.store).toEqual({ [SHELL_DND.page]: "b" });
    expect(data.effectAllowed).toBe("copyMove");
  });

  it("並べ替えもできる一覧では、並べ替えの値（text/plain）とページ用の型の両方を載せる", () => {
    const { host } = mount(<ShellSidebar items={items} currentId="a" onDrop={vi.fn()} side={{ onOpen: vi.fn() }} />);
    const data = transfer();
    drag(row(host, "取材メモ"), "dragstart", data);
    expect(data.store).toEqual({ "text/plain": "b", [SHELL_DND.page]: "b" });
  });

  it("panel を渡すと、上段を掴んで動かせる（移すメニューは無い。ドラッグだけ）", () => {
    const { host } = mount(<ShellSidebar items={items} panel />);
    const top = host.querySelector<HTMLElement>(".es-sb-top")!;
    expect(top.getAttribute("draggable")).toBe("true");
    expect(top.querySelector(".es-grip")).not.toBeNull();
    const data = transfer();
    drag(top, "dragstart", data);
    expect(data.store[SHELL_DND.list]).toBe("list");
    expect(host.querySelector('button[aria-label="一覧のメニュー"]')).toBeNull();
    const plain = mount(<ShellSidebar items={items} />).host.querySelector<HTMLElement>(".es-sb-top")!;
    expect(plain.hasAttribute("draggable")).toBe(false);
    expect(plain.querySelector(".es-grip")).toBeNull();
  });
});

describe("shell.css のパネルの配置", () => {
  const css = readFileSync(path.resolve(__dirname, "../styles/shell.css"), "utf8");
  const P = ":where([data-docs-app-root]):where([data-docs-shared-ui]) ";
  const D = `${P}.es-root[data-layout="dock"][data-wide="true"]`;

  it("デスクトップのパネルは .es-ws の中の絶対配置（位置は style）。900px 未満の決まりは 1 か所のまま", () => {
    expect(css).toContain(`${D} .es-ws{position:relative}`);
    expect(css).toContain(`${D} .es-doc,${D} .es-dbody{display:contents}`);
    expect(css).toMatch(/\[data-wide="true"\] \.es-pn\{position:absolute;/);
    expect(css).toContain(`${D} .es-pn[data-dock="left"]{left:0;`);
    expect(css).toContain(`${D} .es-pn[data-dock="right"]{right:0;`);
    expect(css.match(/@media \(max-width:900px\)/g)).toHaveLength(1);
    // 900px 未満: 一覧は従来どおり一覧そのものが全画面、ほかのパネルはヘッダーの下の全画面
    const narrow = css.slice(css.indexOf("@media (max-width:900px)"));
    expect(narrow).toContain(`${P}.es-root[data-layout="dock"] .es-pn[data-panel="list"]{display:contents}`);
    expect(narrow).toMatch(/\[data-layout="dock"\] \.es-pn\{position:absolute;left:0;right:0;top:var\(--es-header\);bottom:0;/);
    // 一覧が全画面のあいだ（view=list）は、開いているほかのパネルを一覧の上に重ねない
    expect(narrow).toContain(`${P}.es-root[data-layout="dock"][data-view="list"] .es-pn:not([data-panel="list"]){display:none}`);
  });

  it("アプリ名の帯は左上端、設定の帯は左下。左のドックが無いときは中央のヘッダーの左を空ける（900px 未満は空けない）", () => {
    expect(css).toMatch(/\.es-root \.es-brandbar\{position:absolute;left:0;top:0;/);
    expect(css).toMatch(/\.es-root \.es-setbar\{position:absolute;left:0;bottom:0;/);
    expect(css).toContain(`${P}.es-root[data-left="none"] .es-dt{padding-left:112px}`);
    const narrow = css.slice(css.indexOf("@media (max-width:900px)"));
    expect(narrow).toContain(`${P}.es-root[data-left="none"] .es-dt{padding-left:6px}`);
    expect(narrow).toContain(`${P}.es-root[data-view="list"] .es-brandbar{display:flex;width:100%;border-right:0}`);
    // 浮かせた AI の規則は無い
    expect(css).not.toContain('[data-dock="float"]');
    expect(css).not.toContain("--es-float-h");
  });
});
