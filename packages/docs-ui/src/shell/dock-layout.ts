/*
 * パネルの配置（設計 §5.5・#311）の計算。描画・保存は持たない純粋な関数だけ。
 * 列は左から「左のドック｜境目｜メイン｜境目｜右のページ｜境目｜右のドック」の 7 本（境目は幅 0）。
 * ドック（左右）にはパネル（一覧・AIと作る・ページ・写真）が縦に並び、同じドックに 2 つ以上あれば高さの割合（size）で分ける。
 * 正の見本は docs/mockups/editor-folder-pages-v1.html の renderLayout()・movePanel()・placeZones()。
 */

import type { ShellIconName } from "./types";

/** ドック（左右の端の列）。 */
export type ShellDockSide = "left" | "right";
/** 動かせるパネル。 */
export type ShellPanelId = "list" | "ai" | "page" | "photos";
/**
 * @deprecated メインの下に浮かせる置き場所は無くなった（#311。AI もドックへ）。AiBox が #312 で置き換えるまで型だけ残す。
 */
export type ShellAiPlace = ShellDockSide | "float";
/** 幅を変えられる列。 */
export type ShellDockWidthKey = "left" | "right" | "side";
export type ShellDockWidths = Record<ShellDockWidthKey, number>;
/** ドックの中の 1 つのパネルと、その高さの割合（同じドックの中での比。0 より大きい）。 */
export type ShellDockPanel = { id: ShellPanelId; size: number };
/** 左右のドックの中身（上から順）。どちらにも無いパネルは閉じている。 */
export type ShellDocks = Record<ShellDockSide, readonly ShellDockPanel[]>;
/** パネルを落とす先（そのドックの上か下）。 */
export type ShellPanelTarget = { side: ShellDockSide; at: "top" | "bottom" };

/** パネルの順（ヘッダー右上のボタンの並びもこの順）。 */
export const SHELL_PANELS: readonly ShellPanelId[] = ["list", "ai", "page", "photos"];
export const SHELL_PANEL_NAME: Record<ShellPanelId, string> = { list: "一覧", ai: "AIと作る", page: "ページ", photos: "写真" };
/** ヘッダー右上の「出す」ボタンの絵。 */
export const SHELL_PANEL_ICON: Record<ShellPanelId, ShellIconName> = { list: "side", ai: "panel", page: "info", photos: "img" };
/** 閉じたパネルを出すとき戻る元のドック（その下に足す）。 */
export const SHELL_PANEL_HOME: Record<ShellPanelId, ShellDockSide> = { list: "left", ai: "right", page: "right", photos: "right" };
/** 既定の配置: 左＝一覧、右＝ページ（上）＋AI（下）。写真は閉じている。 */
export const SHELL_DOCKS_DEFAULT: ShellDocks = {
  left: [{ id: "list", size: 1 }],
  right: [
    { id: "page", size: 1 },
    { id: "ai", size: 1 },
  ],
};
/** 同じドックの上下の境目を動かすとき、パネルに残す最小の高さ。 */
export const SHELL_PANEL_MIN_HEIGHT = 90;

/** 最小の幅（メイン 480・右のページ 320・ドック 240）。 */
export const SHELL_DOCK_MIN = { main: 480, side: 320, dock: 240 } as const;
/** 最大の幅（ドック 480・右のページ 760）。 */
export const SHELL_DOCK_MAX = { side: 760, dock: 480 } as const;
/** 既定の幅（ダブルクリック・Enter で戻る幅）。 */
export const SHELL_DOCK_DEFAULT: Readonly<ShellDockWidths> = { left: 272, right: 340, side: 420 };
/** 入りきらないときに畳んだドックの幅（アイコンの列）。 */
export const SHELL_DOCK_STRIP = 48;

const PANEL_DND: Record<ShellPanelId, string> = {
  list: "application/x-niho-panel-list",
  ai: "application/x-niho-panel-ai",
  page: "application/x-niho-panel-page",
  photos: "application/x-niho-panel-photos",
};

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
  list: PANEL_DND.list,
  /** 「AIと作る」の見出し。 */
  ai: PANEL_DND.ai,
  /** パネルの見出し（id ごと）。値はパネルの id。 */
  panel: PANEL_DND,
} as const;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const isShellPanelId = (value: unknown): value is ShellPanelId => typeof value === "string" && (SHELL_PANELS as readonly string[]).includes(value);
export const isShellDockSide = (value: unknown): value is ShellDockSide => value === "left" || value === "right";

const minOf = (key: ShellDockWidthKey) => (key === "side" ? SHELL_DOCK_MIN.side : SHELL_DOCK_MIN.dock);
const maxOf = (key: ShellDockWidthKey) => (key === "side" ? SHELL_DOCK_MAX.side : SHELL_DOCK_MAX.dock);

/** 本人の幅を、その列の最小・最大の中に収める（数でなければ既定の幅）。 */
export function clampDockWidth(key: ShellDockWidthKey, value: unknown): number {
  if (!finite(value)) return SHELL_DOCK_DEFAULT[key];
  return Math.round(clamp(value, minOf(key), maxOf(key)));
}

/** パネルの今のドック（どちらにも無ければ null）。 */
export function dockOf(docks: ShellDocks, panel: ShellPanelId): ShellDockSide | null {
  if (docks.left.some((item) => item.id === panel)) return "left";
  if (docks.right.some((item) => item.id === panel)) return "right";
  return null;
}

const without = (panels: readonly ShellDockPanel[], panel: ShellPanelId) => panels.filter((item) => item.id !== panel);
const sameOrder = (a: readonly ShellDockPanel[], b: readonly ShellDockPanel[]) => a.length === b.length && a.every((item, index) => item.id === b[index]!.id);

/**
 * パネルを落とし先（ドックの上か下）へ移す。今いるドックの中での上下の入れ替えもこれ。
 * 高さの割合はそのまま持っていく（閉じていたパネルは 1）。並びが変わらなければ同じ値を返す（保存しない）。
 */
export function movePanel(docks: ShellDocks, panel: ShellPanelId, to: ShellPanelTarget): ShellDocks {
  const entry = [...docks.left, ...docks.right].find((item) => item.id === panel) ?? { id: panel, size: 1 };
  const left = without(docks.left, panel);
  const right = without(docks.right, panel);
  const next = { left, right };
  next[to.side] = to.at === "top" ? [entry, ...next[to.side]] : [...next[to.side], entry];
  return sameOrder(next.left, docks.left) && sameOrder(next.right, docks.right) ? docks : next;
}

/** パネルを閉じる（どちらのドックからも外す）。無ければ同じ値。 */
export function closePanel(docks: ShellDocks, panel: ShellPanelId): ShellDocks {
  if (dockOf(docks, panel) === null) return docks;
  return { left: without(docks.left, panel), right: without(docks.right, panel) };
}

/** 閉じているパネルを出す（元のドックの下に足す）。すでにあれば同じ値。 */
export function openPanel(docks: ShellDocks, panel: ShellPanelId): ShellDocks {
  if (dockOf(docks, panel) !== null) return docks;
  const side = SHELL_PANEL_HOME[panel];
  return { ...docks, [side]: [...docks[side], { id: panel, size: 1 }] };
}

/**
 * 同じドックの上下の境目を動かす。index は下のパネルの位置（1〜）、fraction は上のパネルが 2 つの合計に占める割合（0〜1）。
 * 2 つの割合の合計は変えない（ほかのパネルの高さは動かない）。
 */
export function resizeDockPanels(docks: ShellDocks, side: ShellDockSide, index: number, fraction: number): ShellDocks {
  const panels = docks[side];
  if (!finite(fraction) || index < 1 || index >= panels.length) return docks;
  const upper = panels[index - 1]!;
  const lower = panels[index]!;
  const total = upper.size + lower.size;
  const share = clamp(fraction, 0.01, 0.99);
  const next = panels.map((item, at) => (at === index - 1 ? { ...item, size: total * share } : at === index ? { ...item, size: total * (1 - share) } : item));
  return { ...docks, [side]: next };
}

/** ドックの中のパネルの位置と高さ（ドックの高さに対する割合。上から順）。 */
export type ShellPanelShare = { id: ShellPanelId; start: number; share: number };

/** 見えているパネルの高さの割合（上から順）。合計が 0 なら等分。 */
export function panelShares(panels: readonly ShellDockPanel[]): ShellPanelShare[] {
  const total = panels.reduce((sum, item) => sum + (finite(item.size) && item.size > 0 ? item.size : 0), 0);
  let start = 0;
  return panels.map((item) => {
    const share = total > 0 ? (finite(item.size) && item.size > 0 ? item.size : 0) / total : 1 / panels.length;
    const result = { id: item.id, start, share };
    start += share;
    return result;
  });
}

/** それぞれのドックに見えているパネル（上から順。隠しているパネルは入れない）。 */
export function dockPanels(docks: ShellDocks, shown: Readonly<Record<ShellPanelId, boolean>>): Record<ShellDockSide, ShellDockPanel[]> {
  return { left: docks.left.filter((item) => shown[item.id]), right: docks.right.filter((item) => shown[item.id]) };
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

/** 左右の端の、近づけたらそのドックに入る幅（ドックが細い・無いときの最低）。 */
const EDGE = 140;

/**
 * 掴んだパネルを近づけた場所から、落とすと入る場所を決める（モックの placeZones()）。
 * 左右の端ならそのドック。そのドックにほかのパネルがあれば上半分は「上に」、下半分は「下に」、無ければドック全体。
 * 真ん中では何もしない（null）。今いる場所と同じ（いちばん上にいて「上に」など）なら null。
 * x・y は枠の左上からの位置、height は枠の高さ、ids はそれぞれのドックに見えているパネル。
 */
export function panelDropTarget(
  panel: ShellPanelId,
  point: { x: number; y: number },
  fit: ShellDockFit,
  height: number,
  ids: Record<ShellDockSide, readonly ShellPanelId[]>,
): ShellPanelTarget | null {
  const { x, y } = point;
  const side: ShellDockSide | null = x < Math.max(fit.left, EDGE) ? "left" : x > fit.width - Math.max(fit.right, EDGE) ? "right" : null;
  if (side === null) return null;
  const others = ids[side].filter((id) => id !== panel);
  const at: ShellPanelTarget["at"] = others.length > 0 && y > height / 2 ? "bottom" : "top";
  const now = ids[side];
  const index = now.indexOf(panel);
  if (index >= 0 && ((at === "top" && index === 0) || (at === "bottom" && index === now.length - 1))) return null;
  return { side, at };
}

/** 「落とすと入る形」（ghost）の位置と大きさ（枠の左上から。モックの placeZones()）。 */
export function panelGhostRect(
  panel: ShellPanelId,
  target: ShellPanelTarget,
  fit: ShellDockFit,
  height: number,
  widths: ShellDockWidths,
  ids: Record<ShellDockSide, readonly ShellPanelId[]>,
): { left: number; top: number; width: number; height: number } {
  const now = target.side === "left" ? fit.left : fit.right;
  const width = now > SHELL_DOCK_STRIP ? now : clampDockWidth(target.side, widths[target.side]);
  const left = target.side === "left" ? 6 : fit.width - width - 6;
  const others = ids[target.side].filter((id) => id !== panel).length;
  if (others === 0) return { left, top: 6, width, height: Math.max(0, height - 12) };
  const half = height / 2;
  return target.at === "top" ? { left, top: 6, width, height: Math.max(0, half - 9) } : { left, top: half + 3, width, height: Math.max(0, half - 9) };
}
