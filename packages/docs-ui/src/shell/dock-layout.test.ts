import { describe, expect, it } from "vitest";
import {
  SHELL_DOCKS_DEFAULT,
  SHELL_DOCK_DEFAULT,
  SHELL_DOCK_MIN,
  SHELL_DOCK_STRIP,
  clampDockWidth,
  closePanel,
  computeShellDock,
  dockOf,
  dockPanels,
  dockWidthRange,
  movePanel,
  openPanel,
  panelDropTarget,
  panelGhostRect,
  panelShares,
  resizeDockPanels,
  type ShellDockInput,
  type ShellDocks,
} from "./dock-layout";

const input = (over: Partial<ShellDockInput> = {}): ShellDockInput => ({
  width: 1680,
  widths: { ...SHELL_DOCK_DEFAULT },
  docks: { left: ["list"], right: ["page", "ai"] },
  side: false,
  ...over,
});

const ids = (docks: ShellDocks) => ({ left: docks.left.map((item) => item.id), right: docks.right.map((item) => item.id) });

describe("幅の割り当て（computeShellDock）", () => {
  it("広ければ本人の幅のまま。メインは残り", () => {
    const fit = computeShellDock(input({ side: true }));
    expect(fit).toMatchObject({ left: 272, right: 340, side: 420, main: 1680 - 272 - 340 - 420, strip: { left: false, right: false } });
  });

  it("右のページが無ければ、その列は 0", () => {
    const fit = computeShellDock(input());
    expect(fit.side).toBe(0);
    expect(fit.main).toBe(1680 - 272 - 340);
  });

  it("入りきらないときは、まず AI のないドックを細い列に畳む（本人の幅は変えない）", () => {
    // 1440: 272 + 340 + 420 + 480 = 1512 > 1440
    const widths = { ...SHELL_DOCK_DEFAULT };
    const fit = computeShellDock(input({ width: 1440, side: true, widths }));
    expect(fit.strip).toEqual({ left: true, right: false });
    expect(fit.left).toBe(SHELL_DOCK_STRIP);
    expect(fit.right).toBe(340);
    expect(fit.side).toBe(420);
    expect(fit.main).toBe(1440 - 48 - 340 - 420);
    expect(widths).toEqual(SHELL_DOCK_DEFAULT);
  });

  it("畳んでも足りなければ右のページを最小まで縮め、それでも足りなければ AI のドックを畳む", () => {
    // 1280: 48 + 340 + 480 = 868 → 右のページは 412 まで
    const squeezed = computeShellDock(input({ width: 1280, side: true }));
    expect(squeezed.strip).toEqual({ left: true, right: false });
    expect(squeezed.side).toBe(1280 - 48 - 340 - SHELL_DOCK_MIN.main);
    expect(squeezed.main).toBe(SHELL_DOCK_MIN.main);
    // 1100: 48 + 340 + 480 = 868 → 232 < 320 なので AI のドックも畳む
    const tight = computeShellDock(input({ width: 1100, side: true }));
    expect(tight.strip).toEqual({ left: true, right: true });
    expect(tight.side).toBe(Math.min(420, 1100 - 48 - 48 - SHELL_DOCK_MIN.main));
    expect(tight.main).toBe(1100 - 48 - 48 - tight.side);
  });

  it("右のページが無くても、メインが 480px を割るなら AI のないドックから畳む", () => {
    // 1024: 272 + 340 + 480 = 1092 > 1024
    const fit = computeShellDock(input({ width: 1024 }));
    expect(fit.strip).toEqual({ left: true, right: false });
    expect(fit.main).toBe(1024 - 48 - 340);
  });

  it("AI のドックが左にあるなら、右のドックから畳む（畳む順は場所でなく AI の有無で決まる）", () => {
    const fit = computeShellDock(input({ width: 1440, side: true, docks: { left: ["list", "ai"], right: ["page"] } }));
    expect(fit.strip).toEqual({ left: false, right: true });
  });

  it("何も入っていないドックは 0（畳まない）", () => {
    const fit = computeShellDock(input({ width: 1200, side: true, docks: { left: [], right: ["ai"] } }));
    expect(fit.left).toBe(0);
    expect(fit.strip.left).toBe(false);
    expect(fit.right).toBe(340);
    expect(fit.side).toBe(1200 - 340 - SHELL_DOCK_MIN.main);
  });

  it("すべて畳んでも足りないときは、右のページは 320px を割らない（メインが割る）", () => {
    const fit = computeShellDock(input({ width: 890, side: true }));
    expect(fit.strip).toEqual({ left: true, right: true });
    expect(fit.side).toBe(320);
    expect(fit.main).toBe(890 - 48 - 48 - 320);
  });

  it("本人の幅は最小・最大の中で使う（壊れた値は既定）", () => {
    const fit = computeShellDock(input({ widths: { left: 9999, right: 10, side: Number.NaN }, side: true }));
    expect(fit.left).toBe(480);
    expect(fit.right).toBe(240);
    expect(fit.side).toBe(420);
  });
});

describe("clampDockWidth・dockWidthRange", () => {
  it("列ごとの最小・最大に収め、数でなければ既定", () => {
    expect(clampDockWidth("left", 100)).toBe(240);
    expect(clampDockWidth("right", 1000)).toBe(480);
    expect(clampDockWidth("side", 300)).toBe(320);
    expect(clampDockWidth("side", 900)).toBe(760);
    expect(clampDockWidth("left", "300")).toBe(272);
    expect(clampDockWidth("right", Infinity)).toBe(340);
    expect(clampDockWidth("side", 400.6)).toBe(401);
  });

  it("境目の最大は、ほかの列の今の幅を引いてメインに 480px を残す", () => {
    const fit = computeShellDock(input({ width: 1440, side: true }));
    // 左は細い列（48）。右のページの最大 = 1440 - 48 - 340 - 480
    expect(dockWidthRange("side", fit)).toEqual({ min: 320, max: Math.min(760, 1440 - 48 - 340 - 480) });
    expect(dockWidthRange("right", fit)).toEqual({ min: 240, max: Math.min(480, 1440 - 48 - 420 - 480) });
    // 狭くても最大は最小を割らない
    const tight = computeShellDock(input({ width: 901, side: true }));
    expect(dockWidthRange("left", tight)).toEqual({ min: 240, max: 240 });
  });
});

describe("ドックの中身（movePanel・closePanel・openPanel・resizeDockPanels）", () => {
  it("既定は 左＝一覧、右＝ページ（上）＋AI（下）。写真は閉じている", () => {
    expect(ids(SHELL_DOCKS_DEFAULT)).toEqual({ left: ["list"], right: ["page", "ai"] });
    expect(dockOf(SHELL_DOCKS_DEFAULT, "photos")).toBeNull();
    expect(dockOf(SHELL_DOCKS_DEFAULT, "ai")).toBe("right");
  });

  it("落とし先（ドックの上か下）へ移す。高さの割合は持っていき、閉じていたパネルは 1", () => {
    const moved = movePanel(SHELL_DOCKS_DEFAULT, "ai", { side: "left", at: "bottom" });
    expect(ids(moved)).toEqual({ left: ["list", "ai"], right: ["page"] });
    const sized = resizeDockPanels(moved, "left", 1, 0.25);
    expect(sized.left.map((item) => item.size)).toEqual([0.5, 1.5]);
    const back = movePanel(sized, "ai", { side: "right", at: "top" });
    expect(ids(back)).toEqual({ left: ["list"], right: ["ai", "page"] });
    expect(back.right[0]!.size).toBe(1.5);
    const photos = movePanel(back, "photos", { side: "left", at: "top" });
    expect(ids(photos)).toEqual({ left: ["photos", "list"], right: ["ai", "page"] });
    expect(photos.left[0]!.size).toBe(1);
  });

  it("同じドックの中の上下の入れ替えもできる。並びが変わらなければ同じ値（保存しない）", () => {
    const up = movePanel(SHELL_DOCKS_DEFAULT, "ai", { side: "right", at: "top" });
    expect(ids(up)).toEqual({ left: ["list"], right: ["ai", "page"] });
    expect(movePanel(SHELL_DOCKS_DEFAULT, "ai", { side: "right", at: "bottom" })).toBe(SHELL_DOCKS_DEFAULT);
    expect(movePanel(SHELL_DOCKS_DEFAULT, "list", { side: "left", at: "top" })).toBe(SHELL_DOCKS_DEFAULT);
  });

  it("閉じるとどちらのドックからも外れ、出すと元のドックの下に戻る（既にあれば同じ値）", () => {
    const closed = closePanel(SHELL_DOCKS_DEFAULT, "page");
    expect(ids(closed)).toEqual({ left: ["list"], right: ["ai"] });
    expect(closePanel(closed, "page")).toBe(closed);
    expect(ids(openPanel(closed, "page"))).toEqual({ left: ["list"], right: ["ai", "page"] });
    expect(ids(openPanel(closed, "photos"))).toEqual({ left: ["list"], right: ["ai", "photos"] });
    expect(openPanel(closed, "list")).toBe(closed);
    // 一覧を閉じて出すと左へ
    const noList = closePanel(SHELL_DOCKS_DEFAULT, "list");
    expect(ids(openPanel(noList, "list"))).toEqual({ left: ["list"], right: ["page", "ai"] });
  });

  it("境目: 2 つの割合の合計は変えず、0〜1 の外・無い位置は無視", () => {
    const docks: ShellDocks = { left: [], right: [{ id: "page", size: 2 }, { id: "ai", size: 2 }, { id: "photos", size: 1 }] };
    const next = resizeDockPanels(docks, "right", 2, 0.5);
    expect(next.right.map((item) => item.size)).toEqual([2, 1.5, 1.5]);
    expect(resizeDockPanels(docks, "right", 0, 0.5)).toBe(docks);
    expect(resizeDockPanels(docks, "right", 3, 0.5)).toBe(docks);
    expect(resizeDockPanels(docks, "right", 1, Number.NaN)).toBe(docks);
    // 端に寄せても 0 にはしない
    const edge = resizeDockPanels(docks, "right", 1, 2).right.map((item) => item.size);
    expect(edge[0]).toBeCloseTo(3.96);
    expect(edge[1]).toBeCloseTo(0.04);
    expect(edge[2]).toBe(1);
  });

  it("panelShares: 上から順の位置と割合。合計 0 なら等分", () => {
    expect(panelShares([{ id: "page", size: 1 }, { id: "ai", size: 3 }])).toEqual([
      { id: "page", start: 0, share: 0.25 },
      { id: "ai", start: 0.25, share: 0.75 },
    ]);
    expect(panelShares([{ id: "page", size: 0 }, { id: "ai", size: 0 }])).toEqual([
      { id: "page", start: 0, share: 0.5 },
      { id: "ai", start: 0.5, share: 0.5 },
    ]);
  });

  it("dockPanels: 隠したパネルは入れない（並びと割合はそのまま）", () => {
    const shown = { list: true, ai: true, page: false, photos: true };
    expect(dockPanels(SHELL_DOCKS_DEFAULT, shown)).toEqual({ left: [{ id: "list", size: 1 }], right: [{ id: "ai", size: 1 }] });
  });
});

describe("パネルを近づけた場所（panelDropTarget）", () => {
  const fit = computeShellDock(input({ side: true }));
  const H = 900;
  const now = { left: ["list"] as const, right: ["page", "ai"] as const };

  it("左右の端ならそのドック。ほかのパネルがあれば上半分は上・下半分は下、無ければ上。真ん中では何もしない", () => {
    expect(panelDropTarget("ai", { x: 20, y: 400 }, fit, H, now)).toEqual({ side: "left", at: "top" });
    expect(panelDropTarget("ai", { x: 250, y: 600 }, fit, H, now)).toEqual({ side: "left", at: "bottom" });
    expect(panelDropTarget("list", { x: 1670, y: 400 }, fit, H, now)).toEqual({ side: "right", at: "top" });
    expect(panelDropTarget("list", { x: 1670, y: 800 }, fit, H, now)).toEqual({ side: "right", at: "bottom" });
    expect(panelDropTarget("list", { x: 800, y: 400 }, fit, H, now)).toBeNull();
    // 空のドックへは、下半分でも「上」（ドック全体）
    expect(panelDropTarget("list", { x: 1670, y: 800 }, fit, H, { left: ["list"], right: [] })).toEqual({ side: "right", at: "top" });
  });

  it("今いる場所と同じなら何もしない（いちばん上にいて「上」、いちばん下にいて「下」）", () => {
    expect(panelDropTarget("list", { x: 20, y: 100 }, fit, H, now)).toBeNull();
    expect(panelDropTarget("ai", { x: 1670, y: 800 }, fit, H, now)).toBeNull();
    // 上下の入れ替えはできる
    expect(panelDropTarget("ai", { x: 1670, y: 100 }, fit, H, now)).toEqual({ side: "right", at: "top" });
    expect(panelDropTarget("page", { x: 1670, y: 800 }, fit, H, now)).toEqual({ side: "right", at: "bottom" });
  });

  it("ドックが無い・細いときも、端の 140px ならそのドック", () => {
    const empty = computeShellDock(input({ docks: { left: [], right: ["ai"] } }));
    expect(panelDropTarget("list", { x: 100, y: 300 }, empty, H, { left: [], right: ["ai"] })).toEqual({ side: "left", at: "top" });
    expect(panelDropTarget("list", { x: 160, y: 300 }, empty, H, { left: [], right: ["ai"] })).toBeNull();
  });
});

describe("落とすと入る形（panelGhostRect）", () => {
  const fit = computeShellDock(input({ width: 1440, side: true }));
  const now = { left: ["list"] as const, right: ["page", "ai"] as const };

  it("ほかのパネルがあるドックは上半分・下半分、無ければドック全体", () => {
    expect(panelGhostRect("ai", { side: "right", at: "top" }, fit, 900, SHELL_DOCK_DEFAULT, now)).toEqual({ left: 1440 - 340 - 6, top: 6, width: 340, height: 441 });
    expect(panelGhostRect("list", { side: "right", at: "bottom" }, fit, 900, SHELL_DOCK_DEFAULT, now)).toEqual({ left: 1440 - 340 - 6, top: 453, width: 340, height: 441 });
    // 右のドックにいる ai と page のうち page だけが残るなら半分
    expect(panelGhostRect("ai", { side: "right", at: "bottom" }, fit, 900, SHELL_DOCK_DEFAULT, { left: [], right: ["ai"] })).toEqual({
      left: 1440 - 340 - 6,
      top: 6,
      width: 340,
      height: 888,
    });
  });

  it("ドックの形は、細い列のときは本人の幅で出す", () => {
    expect(panelGhostRect("ai", { side: "left", at: "top" }, fit, 900, SHELL_DOCK_DEFAULT, { left: [], right: ["page", "ai"] })).toEqual({ left: 6, top: 6, width: 272, height: 888 });
  });
});
