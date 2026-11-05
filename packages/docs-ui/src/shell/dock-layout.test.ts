import { describe, expect, it } from "vitest";
import {
  SHELL_DOCK_DEFAULT,
  SHELL_DOCK_MIN,
  SHELL_DOCK_STRIP,
  clampDockWidth,
  computeShellDock,
  dockPanels,
  dockWidthRange,
  panelDropTarget,
  panelGhostRect,
  type ShellDockInput,
} from "./dock-layout";

const input = (over: Partial<ShellDockInput> = {}): ShellDockInput => ({
  width: 1680,
  widths: { ...SHELL_DOCK_DEFAULT },
  docks: { left: ["list"], right: ["ai"] },
  side: false,
  ...over,
});

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
    const fit = computeShellDock(input({ width: 1440, side: true, docks: { left: ["list", "ai"], right: ["list"] } }));
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

describe("パネルを近づけた場所（panelDropTarget）", () => {
  const fit = computeShellDock(input({ side: true }));
  const H = 900;

  it("左右の端ならそのドック、真ん中では何もしない", () => {
    expect(panelDropTarget("list", { x: 20, y: 400 }, fit, H)).toBe("left");
    expect(panelDropTarget("list", { x: 250, y: 400 }, fit, H)).toBe("left");
    expect(panelDropTarget("list", { x: 1670, y: 400 }, fit, H)).toBe("right");
    expect(panelDropTarget("list", { x: 800, y: 400 }, fit, H)).toBeNull();
  });

  it("AI だけはメインの下端で「浮かせる」。一覧はメインの下端でも何もしない", () => {
    expect(panelDropTarget("ai", { x: 600, y: 850 }, fit, H)).toBe("float");
    expect(panelDropTarget("list", { x: 600, y: 850 }, fit, H)).toBeNull();
    // 右のページの下端は浮かせる場所ではない
    expect(panelDropTarget("ai", { x: fit.left + fit.main + 10, y: 850 }, fit, H)).toBeNull();
  });

  it("ドックが無い・細いときも、端の 140px ならそのドック", () => {
    const empty = computeShellDock(input({ docks: { left: [], right: ["ai"] } }));
    expect(panelDropTarget("list", { x: 100, y: 300 }, empty, H)).toBe("left");
    expect(panelDropTarget("list", { x: 160, y: 300 }, empty, H)).toBeNull();
  });
});

describe("落とすと入る形（panelGhostRect）", () => {
  const fit = computeShellDock(input({ width: 1440, side: true }));

  it("浮かせる形はメインの下端の中央に、本文と同じ幅（最大 680px）", () => {
    const rect = panelGhostRect("float", fit, 900, SHELL_DOCK_DEFAULT);
    expect(rect.width).toBe(Math.min(680, fit.main - 48));
    expect(rect.left).toBe(fit.left + (fit.main - rect.width) / 2);
    expect(rect.top + rect.height).toBe(900 - 16);
  });

  it("ドックの形は、細い列のときは本人の幅で出す", () => {
    expect(panelGhostRect("left", fit, 900, SHELL_DOCK_DEFAULT)).toEqual({ left: 6, top: 6, width: 272, height: 888 });
    expect(panelGhostRect("right", fit, 900, SHELL_DOCK_DEFAULT)).toEqual({ left: 1440 - 340 - 6, top: 6, width: 340, height: 888 });
  });
});

describe("dockPanels", () => {
  it("同じドックに 2 つなら一覧が上。隠したパネルと浮かせた AI は入れない", () => {
    expect(dockPanels({ list: "left", ai: "left" }, { list: true, ai: true })).toEqual({ left: ["list", "ai"], right: [] });
    expect(dockPanels({ list: "right", ai: "float" }, { list: true, ai: true })).toEqual({ left: [], right: ["list"] });
    expect(dockPanels({ list: "left", ai: "right" }, { list: false, ai: true })).toEqual({ left: [], right: ["ai"] });
  });
});
