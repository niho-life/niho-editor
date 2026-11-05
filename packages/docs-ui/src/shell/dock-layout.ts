/*
 * 分割ビューとパネルの配置（設計 §5.5）の計算。描画・保存は持たない純粋な関数だけ。
 * 列は左から「左のドック｜境目｜メイン｜境目｜右のページ｜境目｜右のドック」の 7 本（境目は幅 0）。
 * 正の見本は docs/mockups/editor-split-view-v1.html の compute()・secTarget()・showGhost()。
 */

/** ドック（左右の端の列）。 */
export type ShellDockSide = "left" | "right";
/** AI の置き場所（左右のドックか、メインの下に浮かせる）。 */
export type ShellAiPlace = ShellDockSide | "float";
/** 動かせるパネル（一覧と「AIと作る」）。 */
export type ShellPanelId = "list" | "ai";
/** 幅を変えられる列。 */
export type ShellDockWidthKey = "left" | "right" | "side";
export type ShellDockWidths = Record<ShellDockWidthKey, number>;
/** パネルの置き場所。一覧は左右のドックだけ、AI はメインの下にも置ける。 */
export type ShellDockPlace = { list: ShellDockSide; ai: ShellAiPlace };

/** 最小の幅（メイン 480・右のページ 320・ドック 240）。 */
export const SHELL_DOCK_MIN = { main: 480, side: 320, dock: 240 } as const;
/** 最大の幅（ドック 480・右のページ 760）。 */
export const SHELL_DOCK_MAX = { side: 760, dock: 480 } as const;
/** 既定の幅（ダブルクリック・Enter で戻る幅）。左の一覧と右の AI は今の幅と同じ。 */
export const SHELL_DOCK_DEFAULT: Readonly<ShellDockWidths> = { left: 272, right: 340, side: 420 };
/** 入りきらないときに畳んだドックの幅（アイコンの列）。 */
export const SHELL_DOCK_STRIP = 48;
/** 既定の置き場所（今と同じ。一覧は左、AI は右）。 */
export const SHELL_DOCK_PLACE: Readonly<ShellDockPlace> = { list: "left", ai: "right" };
/** 浮かせた AI を開いたときの高さ。 */
export const SHELL_FLOAT_HEIGHT = { min: 160, default: 360, max: 1600 } as const;

/**
 * ドラッグで運ぶもの（HTML5 のドラッグ＆ドロップの独自の型）。落とし先はこの型のときだけ出す
 * （写真のタイル・本文の文字・一覧の中の並べ替えのドラッグを邪魔しない）。型の名前はブラウザが小文字にするので小文字で書く。
 */
export const SHELL_DND = {
  /** 一覧の行（ページ）。値はページの id。 */
  page: "application/x-niho-page",
  /** 右に並べたページの上の帯。値はページの id。 */
  side: "application/x-niho-side-page",
  /** 一覧のパネルの見出し。 */
  list: "application/x-niho-panel-list",
  /** 「AIと作る」の見出し（浮かせているときは入力欄の左の掴む所）。 */
  ai: "application/x-niho-panel-ai",
} as const;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const minOf = (key: ShellDockWidthKey) => (key === "side" ? SHELL_DOCK_MIN.side : SHELL_DOCK_MIN.dock);
const maxOf = (key: ShellDockWidthKey) => (key === "side" ? SHELL_DOCK_MAX.side : SHELL_DOCK_MAX.dock);

/** 本人の幅を、その列の最小・最大の中に収める（数でなければ既定の幅）。 */
export function clampDockWidth(key: ShellDockWidthKey, value: unknown): number {
  if (!finite(value)) return SHELL_DOCK_DEFAULT[key];
  return Math.round(clamp(value, minOf(key), maxOf(key)));
}

export type ShellDockInput = {
  /** 枠の幅（px）。 */
  width: number;
  /** 本人が決めた幅（覚えている幅。入らない間も変えない）。 */
  widths: ShellDockWidths;
  /** それぞれのドックに見えているパネル（隠したパネルは入れない）。 */
  docks: Record<ShellDockSide, readonly ShellPanelId[]>;
  /** 右に並べたページがあるか。 */
  side: boolean;
};

/** 幅の割り当て（px）。strip のドックは細い列（SHELL_DOCK_STRIP）。 */
export type ShellDockFit = {
  width: number;
  left: number;
  right: number;
  side: number;
  main: number;
  strip: Record<ShellDockSide, boolean>;
};

/**
 * 幅を割り当てる。本人の幅は覚えたまま、入らない間だけ「AI のないドックを細い列に畳む → 右のページを最小まで縮める →
 * AI のドックを畳む」の順に詰める（モックの compute()）。メインは最低 480px を残すように詰めるが、
 * すべて畳んでも足りないとき（900px 付近）はメインが 480px を割る。
 */
export function computeShellDock(input: ShellDockInput): ShellDockFit {
  const W = Math.max(0, finite(input.width) ? input.width : 0);
  const strip: Record<ShellDockSide, boolean> = { left: false, right: false };
  const has = (side: ShellDockSide) => input.docks[side].length > 0;
  const hasAi = (side: ShellDockSide) => input.docks[side].includes("ai");
  const dockWidth = (side: ShellDockSide) => (!has(side) ? 0 : strip[side] ? SHELL_DOCK_STRIP : clampDockWidth(side, input.widths[side]));
  const room = () => W - SHELL_DOCK_MIN.main - dockWidth("left") - dockWidth("right");
  const want = input.side ? clampDockWidth("side", input.widths.side) : 0;
  let side = want;
  const fitSide = () => {
    if (input.side) side = Math.max(SHELL_DOCK_MIN.side, Math.min(want, room()));
  };
  const sides: ShellDockSide[] = ["left", "right"];
  for (const dock of sides.filter((item) => !hasAi(item))) if (room() < side && has(dock)) strip[dock] = true;
  fitSide();
  for (const dock of sides.filter(hasAi)) {
    if (room() < side && has(dock)) {
      strip[dock] = true;
      fitSide();
    }
  }
  const left = dockWidth("left");
  const right = dockWidth("right");
  return { width: W, left, right, side, main: W - left - right - side, strip };
}

/** 境目を動かせる範囲（ほかの列の今の幅を引いて、メインに 480px を残す）。 */
export function dockWidthRange(key: ShellDockWidthKey, fit: ShellDockFit): { min: number; max: number } {
  const others = key === "left" ? fit.right + fit.side : key === "right" ? fit.left + fit.side : fit.left + fit.right;
  const min = minOf(key);
  return { min, max: Math.max(min, Math.min(maxOf(key), fit.width - others - SHELL_DOCK_MIN.main)) };
}

/** パネルを落とす先。 */
export type ShellPanelTarget = ShellAiPlace;

/** パネルの今の置き場所。 */
export function placeOf(panel: ShellPanelId, place: ShellDockPlace): ShellPanelTarget {
  return panel === "list" ? place.list : place.ai;
}

/** 左右の端の、近づけたらそのドックに入る幅（ドックが細い・無いときの最低）。 */
const EDGE = 140;
/** AI を浮かせる、メインの下端からの高さ。 */
const FLOAT_ZONE = 200;

/**
 * 掴んだパネルを近づけた場所から、落とすと入る場所を決める（モックの secTarget()）。
 * 左右の端ならそのドック、AI だけはメインの下端で「メインの下に浮かせる」。真ん中では何もしない（null）。
 * x・y は枠の左上からの位置、height は枠の高さ。
 */
export function panelDropTarget(panel: ShellPanelId, point: { x: number; y: number }, fit: ShellDockFit, height: number): ShellPanelTarget | null {
  const { x, y } = point;
  if (panel === "ai" && x > fit.left && x < fit.left + fit.main && y > height - FLOAT_ZONE) return "float";
  if (x < Math.max(fit.left, EDGE)) return "left";
  if (x > fit.width - Math.max(fit.right, EDGE)) return "right";
  return null;
}

/** 浮かせた AI の、閉じているとき（入力欄 1 行）の高さのめやす。 */
const FLOAT_BAR = 76;

/** 「落とすと入る形」（ghost）の位置と大きさ（枠の左上から。モックの showGhost()）。 */
export function panelGhostRect(target: ShellPanelTarget, fit: ShellDockFit, height: number, widths: ShellDockWidths): { left: number; top: number; width: number; height: number } {
  if (target === "float") {
    const width = Math.max(0, Math.min(680, fit.main - 48));
    return { left: fit.left + (fit.main - width) / 2, top: height - 16 - FLOAT_BAR, width, height: FLOAT_BAR };
  }
  const now = target === "left" ? fit.left : fit.right;
  const width = now > SHELL_DOCK_STRIP ? now : clampDockWidth(target, widths[target]);
  return { left: target === "left" ? 6 : fit.width - width - 6, top: 6, width, height: Math.max(0, height - 12) };
}

/** それぞれのドックに見えているパネル（同じドックに 2 つなら一覧が上、AI が下）。 */
export function dockPanels(place: ShellDockPlace, shown: { list: boolean; ai: boolean }): Record<ShellDockSide, ShellPanelId[]> {
  const docks: Record<ShellDockSide, ShellPanelId[]> = { left: [], right: [] };
  if (shown.list) docks[place.list].push("list");
  if (shown.ai && place.ai !== "float") docks[place.ai].push("ai");
  return docks;
}
