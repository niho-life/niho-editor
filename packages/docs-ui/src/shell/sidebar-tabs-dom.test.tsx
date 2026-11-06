// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellSidebar } from "./index";

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

/** ページ（入れ物）の行: タブの id を持ち、開いているタブがその中なら今の行（#308）。 */
describe("一覧のページ（入れ物）の行とタブ（#308）", () => {
  it("開いているタブを持つ行が今の行（太字）。押すとそのタブ（一覧をしまうだけ）、ほかの行は行の id。タブの数は 2 つ以上で印", () => {
    const onSelect = vi.fn();
    const host = mount(
      <ShellSidebar
        items={[
          { id: "p1", title: "鎌倉の朝の散歩", when: "昨日", tabs: ["t1", "t2"], count: 2 },
          { id: "p2", title: "円覚寺の資料", when: "昨日", tabs: ["t3"], count: 1 },
          { id: "n1", title: "入れ物の無いページ", when: "昨日" },
        ]}
        currentId="t2"
        onSelect={onSelect}
      />,
    );
    const rows = [...host.querySelectorAll<HTMLButtonElement>(".es-di")];
    expect(rows.map((row) => row.classList.contains("es-di--on"))).toEqual([true, false, false]);
    expect(rows.map((row) => row.getAttribute("aria-current"))).toEqual(["page", null, null]);
    expect(rows.map((row) => row.querySelector(".es-di-n")?.textContent ?? null)).toEqual(["タブ 2", null, null]);
    act(() => rows[0]!.click());
    expect(onSelect).toHaveBeenLastCalledWith("t2");
    act(() => rows[1]!.click());
    expect(onSelect).toHaveBeenLastCalledWith("p2");
    act(() => rows[2]!.click());
    expect(onSelect).toHaveBeenLastCalledWith("n1");
  });

  it("右に並べる（⌥クリック）は 1 つ目のタブで開き、右に並べているタブを持つ行に「右に表示中」", () => {
    const onOpenSide = vi.fn();
    const host = mount(
      <ShellSidebar
        items={[
          { id: "p1", title: "A", when: "昨日", tabs: ["t1", "t2"], count: 2 },
          { id: "p2", title: "B", when: "昨日", tabs: ["t3"], count: 1 },
        ]}
        currentId="t1"
        onSelect={() => undefined}
        side={{ id: "t3", onOpen: onOpenSide }}
      />,
    );
    const rows = [...host.querySelectorAll<HTMLButtonElement>(".es-di")];
    expect(rows.map((row) => row.textContent?.includes("右に表示中"))).toEqual([false, true]);
    act(() => rows[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true })));
    expect(onOpenSide).toHaveBeenCalledWith("t1");
  });
});
