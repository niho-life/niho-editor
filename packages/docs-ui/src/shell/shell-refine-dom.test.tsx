// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EditorShell,
  PublishSheet,
  ShellMobileToolbar,
  ShellPageInfo,
  ShellSheet,
  ShellSidebar,
  ShellTools,
  type PublishFormProps,
  type ShellDropTarget,
  type ShellListItem,
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

const noop = () => undefined;

describe("ShellTools compact（editor-web）", () => {
  it("compact では ＋・画像・録音だけ（書式と区切り線は出さない）。既定は今のまま", () => {
    const compact = renderToStaticMarkup(<ShellTools compact />);
    expect([...compact.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1])).toEqual(["書式とブロック", "ブロックを足す", "画像", "録音"]);
    expect(compact).not.toContain("es-sep");
    const full = renderToStaticMarkup(<ShellTools />);
    expect(full).toContain("太字");
    expect(full).toContain("es-sep");
    const mobile = renderToStaticMarkup(<ShellMobileToolbar compact />);
    expect(mobile).not.toContain("太字");
    expect(mobile).toContain('aria-label="録音"');
  });

  it("compact の録音・画像も onAction に届く", () => {
    const onAction = vi.fn();
    const host = mount(<ShellTools compact onAction={onAction} />);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="録音"]')!.click());
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="画像"]')!.click());
    expect(onAction.mock.calls.map((call) => call[0])).toEqual(["record", "image"]);
  });
});

/** jsdom は DataTransfer を持たないことがあるので、使う分だけの stub。 */
function transfer(): DataTransfer {
  if (typeof DataTransfer === "function") {
    try {
      return new DataTransfer();
    } catch {
      // 下の stub へ
    }
  }
  const data = new Map<string, string>();
  return {
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    dropEffect: "none",
    effectAllowed: "all",
  } as unknown as DataTransfer;
}

function drag(target: Element, type: string, dataTransfer: DataTransfer, clientY = 0): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  Object.defineProperty(event, "clientY", { value: clientY });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** 行の箱を 0〜40px にする（上 25% = 0〜10 は before、下 25% = 30〜40 は after）。 */
function sizeRows(host: HTMLElement) {
  for (const row of host.querySelectorAll<HTMLElement>(".es-dirow")) {
    row.getBoundingClientRect = () => ({ top: 0, bottom: 40, height: 40, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON: noop }) as DOMRect;
  }
}

const ITEMS: ShellListItem[] = [
  { id: "a", title: "A", when: "今", depth: 0, folder: true, open: true },
  { id: "a1", title: "A1", when: "今", depth: 1 },
  { id: "b", title: "B", when: "今", depth: 0 },
];

function Sidebar(props: { items?: ShellListItem[]; onDrop?: (id: string, target: ShellDropTarget) => void; canDrop?: (id: string, target: ShellDropTarget) => boolean }) {
  return (
    <ShellSidebar
      items={props.items ?? ITEMS}
      onDrop={props.onDrop}
      canDrop={props.canDrop}
      me={{ onOpen: noop }}
    />
  );
}

const rowOf = (host: HTMLElement, title: string) => [...host.querySelectorAll<HTMLElement>(".es-dirow")].find((row) => row.querySelector(".es-di-t")?.textContent === title)!;

describe("ShellSidebar のドラッグ（入れ子・並べ替え）", () => {
  it("onDrop を渡したときだけ行を draggable にする", () => {
    expect(mount(<Sidebar />).querySelector("[draggable]")).toBeNull();
    const host = mount(<Sidebar onDrop={vi.fn()} />);
    expect(host.querySelectorAll('.es-dirow[draggable="true"]')).toHaveLength(3);
  });

  it("真ん中は into、上 25% は before、下 25% は after。印を出し、drop で onDrop、dragend で印を消す", () => {
    const onDrop = vi.fn();
    const host = mount(<Sidebar onDrop={onDrop} />);
    sizeRows(host);
    const data = transfer();
    drag(rowOf(host, "B"), "dragstart", data);
    expect(data.getData("text/plain")).toBe("b");
    expect(rowOf(host, "B").classList.contains("es-di--dragging")).toBe(true);

    const over = drag(rowOf(host, "A"), "dragover", data, 20);
    expect(over.defaultPrevented).toBe(true);
    expect(rowOf(host, "A").classList.contains("es-di--drop-into")).toBe(true);
    drag(rowOf(host, "A"), "dragover", data, 4);
    expect(rowOf(host, "A").classList.contains("es-di--drop-before")).toBe(true);
    expect(rowOf(host, "A").classList.contains("es-di--drop-into")).toBe(false);
    drag(rowOf(host, "A1"), "dragover", data, 36);
    expect(rowOf(host, "A1").classList.contains("es-di--drop-after")).toBe(true);
    expect(rowOf(host, "A").className).toBe("es-dirow");

    drag(rowOf(host, "A1"), "drop", data, 36);
    expect(onDrop).toHaveBeenCalledWith("b", { id: "a1", where: "after" });
    expect(host.querySelector(".es-di--dragging, .es-di--drop-into, .es-di--drop-before, .es-di--drop-after")).toBeNull();
  });

  it("canDrop が false の位置は preventDefault せず、印も onDrop も出さない。自分の上にも落とせない", () => {
    const onDrop = vi.fn();
    const host = mount(<Sidebar onDrop={onDrop} canDrop={(_, target) => target.where !== "into"} />);
    sizeRows(host);
    const data = transfer();
    drag(rowOf(host, "B"), "dragstart", data);
    expect(drag(rowOf(host, "A"), "dragover", data, 20).defaultPrevented).toBe(false);
    expect(rowOf(host, "A").className).toBe("es-dirow");
    drag(rowOf(host, "A"), "drop", data, 20);
    expect(drag(rowOf(host, "B"), "dragover", data, 4).defaultPrevented).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
    drag(rowOf(host, "B"), "dragend", data);
    expect(host.querySelector(".es-di--dragging")).toBeNull();
  });

  it("「最近」の行はドラッグしない（木の行だけ）", () => {
    const host = mount(
      <ShellSidebar
        items={ITEMS}
        onDrop={vi.fn()}
        recent={{ items: [{ id: "r", title: "最近の行", when: "今" }], open: true, onToggle: noop }}
        me={{ onOpen: noop }}
      />,
    );
    expect(host.querySelectorAll('.es-dirow[draggable="true"]')).toHaveLength(3);
    expect(rowOf(host, "最近の行").hasAttribute("draggable")).toBe(false);
  });
});

describe("ShellPageInfo（右下の文字数）", () => {
  function Info({ onInfo = vi.fn() }: { onInfo?: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <ShellPageInfo
        count="1,240 字"
        rows={[
          { label: "作成", value: "2026-11-01" },
          { label: "文字数", value: "1,240" },
        ]}
        open={open}
        onToggle={() => setOpen((value) => !value)}
        onClose={() => setOpen(false)}
        info={{ label: "容量について", onOpen: onInfo }}
      />
    );
  }

  it("押すとページの情報が開き、最初の要素（ⓘ）へフォーカス。Esc で閉じてボタンへ戻る", () => {
    const host = mount(<Info />);
    const button = host.querySelector<HTMLButtonElement>("button.es-count")!;
    expect(button.textContent).toBe("1,240 字");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    act(() => button.click());
    const pop = host.querySelector<HTMLElement>(".es-count-pop")!;
    expect(pop.getAttribute("role")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect([...pop.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["作成", "文字数"]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("容量について");
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(host.querySelector(".es-count-pop")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("外を押すと閉じる。ⓘ は閉じてボタンへフォーカスしてから onOpen", () => {
    const onInfo = vi.fn(() => {
      expect(document.activeElement?.classList.contains("es-count")).toBe(true);
    });
    const host = mount(<Info onInfo={onInfo} />);
    act(() => host.querySelector<HTMLButtonElement>("button.es-count")!.click());
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(host.querySelector(".es-count-pop")).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>("button.es-count")!.click());
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="容量について"]')!.click());
    expect(onInfo).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".es-count-pop")).toBeNull();
  });
});

describe("EditorShell の corner", () => {
  it("渡したときだけ .es-dbody の中（レールの後）に .es-corner を出す", () => {
    const shell = (corner?: React.ReactNode) =>
      renderToStaticMarkup(
        <EditorShell sidebar={null} header={null} rail={<aside>rail</aside>} sidebarOpen={false} railOpen corner={corner}>
          本文
        </EditorShell>,
      );
    expect(shell()).not.toContain("es-corner");
    const html = shell(<span>12 字</span>);
    expect(html).toMatch(/<div class="es-rail-presence"[^>]*><aside>rail<\/aside><\/div><div class="es-corner"><span>12 字<\/span><\/div><\/div>/);
  });
});

describe("公開のシートの fields", () => {
  const base: PublishFormProps = {
    dests: [{ id: "exp", label: "NIHO Experience", who: "旅行者向け", url: "x", role: "ライター", connected: true }],
    missing: [{ id: "0", label: "リード" }],
    range: "live",
    extras: { app: false, news: false, xp: false },
    onPick: noop,
    onRange: noop,
    onExtra: noop,
    onFix: noop,
    onPublish: noop,
    onClose: noop,
  };

  it("条件の後・範囲の前に、見出しなしの節として出す。発信先を選んでいなくても出す", () => {
    const host = mount(<PublishSheet kind="publish" {...base} picked="exp" fields={<textarea aria-label="リード" data-page-lead="" />} />);
    const sections = [...host.querySelectorAll(".es-sh-body > .es-sh-sec")];
    const at = sections.findIndex((section) => section.classList.contains("es-sh-fields"));
    expect(sections[at - 1]?.textContent).toContain("に出すには");
    expect(sections[at + 1]?.querySelector("h3")?.textContent).toBe("範囲");
    expect(sections[at]?.querySelector("h3")).toBeNull();
    expect(sections[at]?.querySelector("[data-page-lead]")).not.toBeNull();

    act(() => roots.forEach((root) => root.unmount()));
    roots.length = 0;
    document.body.innerHTML = "";
    const none = mount(<PublishSheet kind="publish" {...base} fields={<span data-field="" />} />);
    expect(none.querySelector(".es-sh-fields [data-field]")).not.toBeNull();
  });
});

describe("ShellSheet の入れ子（シートの中の ⓘ の説明）", () => {
  function Nested() {
    const [outer, setOuter] = useState(true);
    const [inner, setInner] = useState(false);
    return (
      <div className="es-root">
        <button type="button">外のボタン</button>
        {outer && (
          <ShellSheet label="公開" onClose={() => setOuter(false)}>
            <button type="button" aria-label="英語版について" onClick={() => setInner(true)}>
              i
            </button>
            {inner && (
              <ShellSheet label="英語版について" onClose={() => setInner(false)}>
                <p>説明</p>
                <button type="button">閉じる</button>
              </ShellSheet>
            )}
          </ShellSheet>
        )}
      </div>
    );
  }

  it("Esc は内側のシートだけを閉じ、開いたボタンへフォーカスを戻す。もう一度の Esc で外を閉じる", () => {
    const host = mount(<Nested />);
    const info = host.querySelector<HTMLButtonElement>('button[aria-label="英語版について"]')!;
    act(() => info.focus());
    act(() => info.click());
    expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    const esc = () =>
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
    esc();
    expect([...host.querySelectorAll('[role="dialog"]')].map((node) => node.getAttribute("aria-label"))).toEqual(["公開"]);
    expect(document.activeElement).toBe(info);
    esc();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
});
