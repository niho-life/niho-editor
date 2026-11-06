// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LAYOUT,
  LAYOUT_STORAGE_KEY,
  LAYOUT_STORAGE_KEY_V1,
  parseLayout,
  serializeLayout,
  useShellLayout,
  writeLayout,
  type ShellLayout,
  type ShellPanelFlags,
} from "./use-shell-layout";

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

const ids = (layout: Pick<ShellLayout, "docks">) => ({ left: layout.docks.left.map((item) => item.id), right: layout.docks.right.map((item) => item.id) });

describe("parseLayout（保存してあった配置の検証）", () => {
  it("無い・JSON でない・版が違う・形が違うなら既定（左＝一覧、右＝ページ＋AI、写真は閉じている）", () => {
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout("{壊れた")).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout(JSON.stringify({ v: 3, docks: { left: [], right: [] } }))).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout(JSON.stringify([1, 2]))).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout("null")).toEqual(DEFAULT_LAYOUT);
    expect(ids(DEFAULT_LAYOUT)).toEqual({ left: ["list"], right: ["page", "ai"] });
  });

  it("v2: 欄ごとに確かめ、知らない id・2 度目の id は落とし、size は正の数でなければ 1。幅は範囲に収める", () => {
    const parsed = parseLayout(
      JSON.stringify({
        v: 2,
        docks: { left: [{ id: "ai", size: 2 }, { id: "list", size: "big" }, { id: "float", size: 1 }, { id: "ai", size: 1 }], right: "x" },
        widths: { left: 9999, right: "340", side: 100 },
      }),
    );
    expect(parsed.docks).toEqual({ left: [{ id: "ai", size: 2 }, { id: "list", size: 1 }], right: [] });
    expect(parsed.widths).toEqual({ left: 480, right: 340, side: 320 });
  });

  it("v1 を読み替える: 一覧と AI は置いてあったドックへ（浮かせた AI は右の下）、ページは右の上、写真は閉じたまま", () => {
    const old = (place: unknown) => ids(parseLayout(JSON.stringify({ v: 1, place, widths: { left: 300, right: 400, side: 500 }, float: { open: true, height: 420 } })));
    expect(old({ list: "left", ai: "right" })).toEqual({ left: ["list"], right: ["page", "ai"] });
    expect(old({ list: "right", ai: "left" })).toEqual({ left: ["ai"], right: ["list", "page"] });
    expect(old({ list: "left", ai: "float" })).toEqual({ left: ["list"], right: ["page", "ai"] });
    expect(old({ list: "left", ai: "left" })).toEqual({ left: ["list", "ai"], right: ["page"] });
    expect(old(undefined)).toEqual({ left: ["list"], right: ["page", "ai"] });
    expect(parseLayout(JSON.stringify({ v: 1, place: {}, widths: { left: 300, right: 400, side: 500 } })).widths).toEqual({ left: 300, right: 400, side: 500 });
  });

  it("書いた値はそのまま読み戻せる（v2）", () => {
    const prefs = { docks: { left: [{ id: "ai" as const, size: 1.5 }], right: [{ id: "photos" as const, size: 1 }, { id: "list" as const, size: 2 }] }, widths: { left: 300, right: 400, side: 500 } };
    expect(parseLayout(serializeLayout(prefs))).toEqual(prefs);
    expect(JSON.parse(serializeLayout(prefs)).v).toBe(2);
  });
});

const ALL: ShellPanelFlags = { list: true, ai: true, page: true, photos: true };

function Probe({ shown, onLayout }: { shown: { wide: boolean; available: ShellPanelFlags; side: boolean }; onLayout: (layout: ShellLayout) => void }) {
  onLayout(useShellLayout(shown));
  return null;
}

function mountProbe(shown = { wide: true, available: ALL, side: false }) {
  let latest: ShellLayout | null = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Probe shown={shown} onLayout={(layout) => (latest = layout)} />));
  return () => latest!;
}

describe("useShellLayout", () => {
  it("はじめは既定（左＝一覧、右＝ページ＋AI、幅は今の幅）。出すのはドックにあって中身のあるパネルだけ。広さに合わせて畳む", () => {
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1680);
    const layout = mountProbe({ wide: true, available: { ...ALL, photos: false }, side: false });
    expect(ids(layout())).toEqual({ left: ["list"], right: ["page", "ai"] });
    expect(layout().shown).toEqual({ list: true, ai: true, page: true, photos: false });
    expect(layout().fit).toMatchObject({ left: 272, right: 340, strip: { left: false, right: false } });
    expect(layout().dockOf("ai")).toBe("right");
    expect(layout().dockOf("photos")).toBeNull();
  });

  it("中身の無いパネル（設定の画面の AI など）はドックにあっても出さず、幅にも数えない", () => {
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1680);
    const layout = mountProbe({ wide: true, available: { list: true, ai: false, page: false, photos: false }, side: false });
    expect(layout().shown).toEqual({ list: true, ai: false, page: false, photos: false });
    expect(layout().fit.right).toBe(0);
    expect(ids(layout())).toEqual({ left: ["list"], right: ["page", "ai"] });
  });

  it("動かした置き場所・高さの割合・閉じた／出した・幅を、この端末の保存領域に覚える（v2）", () => {
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1680);
    const layout = mountProbe();
    act(() => layout().move("ai", { side: "left", at: "bottom" }));
    act(() => layout().move("list", { side: "right", at: "top" }));
    act(() => layout().setWidth("side", 9999));
    expect(ids(layout())).toEqual({ left: ["ai"], right: ["list", "page"] });
    expect(layout().widths.side).toBe(760);
    act(() => layout().resize("right", 1, 0.25));
    expect(layout().docks.right.map((item) => item.size)).toEqual([0.5, 1.5]);
    act(() => layout().close("page"));
    act(() => layout().open("photos"));
    expect(ids(layout())).toEqual({ left: ["ai"], right: ["list", "photos"] });
    expect(layout().shown).toEqual({ list: true, ai: true, page: false, photos: true });
    const saved = JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY)!);
    expect(saved).toEqual({
      v: 2,
      docks: { left: [{ id: "ai", size: 1 }], right: [{ id: "list", size: 0.5 }, { id: "photos", size: 1 }] },
      widths: { left: 272, right: 340, side: 760 },
    });
    // 出すと元のドックの下に戻る
    act(() => layout().open("page"));
    expect(ids(layout())).toEqual({ left: ["ai"], right: ["list", "photos", "page"] });
    // 変わらない操作は保存しない
    const before = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    act(() => layout().open("page"));
    act(() => layout().move("page", { side: "right", at: "bottom" }));
    expect(window.localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe(before);
  });

  it("保存してあった配置で始める。v2 が無ければ v1 を読み替える。壊れていたら既定", () => {
    writeLayout({ ...DEFAULT_LAYOUT, docks: { left: [{ id: "page", size: 1 }], right: [{ id: "list", size: 1 }] } });
    expect(ids(mountProbe()())).toEqual({ left: ["page"], right: ["list"] });
    act(() => root?.unmount());
    root = null;
    window.localStorage.clear();
    window.localStorage.setItem(LAYOUT_STORAGE_KEY_V1, JSON.stringify({ v: 1, place: { list: "right", ai: "left" }, widths: { left: 300, right: 320, side: 400 }, float: { open: false, height: 360 } }));
    const fromV1 = mountProbe();
    expect(ids(fromV1())).toEqual({ left: ["ai"], right: ["list", "page"] });
    expect(fromV1().widths).toEqual({ left: 300, right: 320, side: 400 });
    // 書くのは v2 だけ（v1 は残っていても、v2 があればそちらを読む）
    act(() => fromV1().close("page"));
    expect(JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY)!).v).toBe(2);
    expect(window.localStorage.getItem(LAYOUT_STORAGE_KEY_V1)).not.toBeNull();
    act(() => root?.unmount());
    root = null;
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, "{壊れた");
    expect(ids(mountProbe()())).toEqual(ids(DEFAULT_LAYOUT));
  });

  it("保存できない（容量・プライベートモード）ときも、このタブの間は動かした配置のまま", () => {
    const layout = mountProbe();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    act(() => layout().move("ai", { side: "left", at: "bottom" }));
    expect(layout().dockOf("ai")).toBe("left");
    // 保存できるようになったら、また保存の領域を使う
    vi.mocked(Storage.prototype.setItem).mockRestore();
    act(() => layout().move("ai", { side: "right", at: "bottom" }));
    expect(JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY)!).docks.right.map((item: { id: string }) => item.id)).toEqual(["page", "ai"]);
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
});
