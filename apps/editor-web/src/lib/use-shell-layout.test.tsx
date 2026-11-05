// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_LAYOUT, LAYOUT_STORAGE_KEY, parseLayout, serializeLayout, useShellLayout, writeLayout, type ShellLayout } from "./use-shell-layout";

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
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("parseLayout（保存してあった配置の検証）", () => {
  it("無い・JSON でない・版が違う・形が違うなら既定", () => {
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout("{壊れた")).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout(JSON.stringify({ v: 2, place: { list: "right", ai: "left" } }))).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout(JSON.stringify([1, 2]))).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout("null")).toEqual(DEFAULT_LAYOUT);
  });

  it("欄ごとに確かめ、外れた欄だけ既定。数は範囲に収める", () => {
    const parsed = parseLayout(
      JSON.stringify({ v: 1, place: { list: "float", ai: "left" }, widths: { left: 9999, right: "340", side: 100 }, float: { open: "yes", height: 50 } }),
    );
    // 一覧は浮かせられない
    expect(parsed.place).toEqual({ list: "left", ai: "left" });
    expect(parsed.widths).toEqual({ left: 480, right: 340, side: 320 });
    expect(parsed.float).toEqual({ open: false, height: 160 });
  });

  it("書いた値はそのまま読み戻せる", () => {
    const prefs = { place: { list: "right" as const, ai: "float" as const }, widths: { left: 300, right: 400, side: 500 }, float: { open: true, height: 420 } };
    expect(parseLayout(serializeLayout(prefs))).toEqual(prefs);
    expect(JSON.parse(serializeLayout(prefs)).v).toBe(1);
  });
});

function Probe({ shown, onLayout }: { shown: { wide: boolean; list: boolean; ai: boolean; side: boolean }; onLayout: (layout: ShellLayout) => void }) {
  onLayout(useShellLayout(shown));
  return null;
}

function mountProbe(shown = { wide: true, list: true, ai: true, side: false }) {
  let latest: ShellLayout | null = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Probe shown={shown} onLayout={(layout) => (latest = layout)} />));
  return () => latest!;
}

describe("useShellLayout", () => {
  it("はじめは既定（一覧は左・AI は右・今の幅）。広さに合わせて畳む", () => {
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1680);
    const layout = mountProbe();
    expect(layout().place).toEqual({ list: "left", ai: "right" });
    expect(layout().fit).toMatchObject({ left: 272, right: 340, strip: { left: false, right: false } });
    expect(layout().float.open).toBe(false);
  });

  it("動かした置き場所・幅・浮かせた AI の開閉と高さを、この端末の保存領域に覚える", () => {
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1680);
    const layout = mountProbe();
    act(() => layout().move("ai", "left"));
    act(() => layout().move("list", "right"));
    act(() => layout().setWidth("side", 9999));
    expect(layout().place).toEqual({ list: "right", ai: "left" });
    expect(layout().widths.side).toBe(760);
    act(() => layout().move("ai", "float"));
    act(() => layout().setFloatOpen(true));
    act(() => layout().setFloatHeight(500));
    expect(layout().float).toMatchObject({ open: true, height: 500 });
    const saved = JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY)!);
    expect(saved).toEqual({ v: 1, place: { list: "right", ai: "float" }, widths: { left: 272, right: 340, side: 760 }, float: { open: true, height: 500 } });
    // 浮かせ直したときは入力欄 1 行から
    act(() => layout().move("ai", "right"));
    act(() => layout().move("ai", "float"));
    expect(layout().float.open).toBe(false);
    // 一覧は浮かせない
    act(() => layout().move("list", "float"));
    expect(layout().place.list).toBe("right");
  });

  it("保存してあった配置で始める。壊れていたら既定", () => {
    writeLayout({ ...DEFAULT_LAYOUT, place: { list: "right", ai: "left" } });
    expect(mountProbe()().place).toEqual({ list: "right", ai: "left" });
    act(() => root?.unmount());
    root = null;
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, "{壊れた");
    expect(mountProbe()().place).toEqual(DEFAULT_LAYOUT.place);
  });

  it("保存できない（容量・プライベートモード）ときも、このタブの間は動かした配置のまま", () => {
    const layout = mountProbe();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    act(() => layout().move("ai", "left"));
    expect(layout().place.ai).toBe("left");
    // 保存できるようになったら、また保存の領域を使う
    vi.mocked(Storage.prototype.setItem).mockRestore();
    act(() => layout().move("ai", "right"));
    expect(JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY)!).place.ai).toBe("right");
  });

  it("細い列から開く（peek）は、細い列のドックだけ・デスクトップだけ", () => {
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1024);
    const layout = mountProbe();
    expect(layout().fit.strip).toEqual({ left: true, right: false });
    act(() => layout().setPeek("left"));
    expect(layout().peek).toBe("left");
    act(() => layout().setPeek("right"));
    expect(layout().peek).toBeNull();
  });

  it("浮かせた AI の高さは、画面の高さに入らない間だけ縮める（覚えた高さは変えない）", () => {
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(500);
    writeLayout({ ...DEFAULT_LAYOUT, place: { list: "left", ai: "float" }, float: { open: true, height: 800 } });
    const layout = mountProbe();
    expect(layout().float.max).toBe(500 - 48 - 120);
    expect(layout().float.height).toBe(500 - 48 - 120);
    expect(JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY)!).float.height).toBe(800);
  });
});
