"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import {
  SHELL_DOCKS_DEFAULT,
  SHELL_DOCK_DEFAULT,
  SHELL_PANELS,
  clampDockWidth,
  closePanel,
  computeShellDock,
  dockOf,
  dockPanels,
  isShellDockSide,
  isShellPanelId,
  movePanel,
  openPanel,
  resizeDockPanels,
  type ShellDockFit,
  type ShellDockPanel,
  type ShellDockSide,
  type ShellDockWidthKey,
  type ShellDockWidths,
  type ShellDocks,
  type ShellPanelId,
  type ShellPanelTarget,
} from "niho-docs-ui/shell";

/**
 * パネルの配置（ドックの中身と高さの割合）と幅（設計 §5.5・#311）。端末ごとに覚える（ブラウザの保存領域。サーバーには置かない。
 * 画面の大きさが端末ごとに違うため）。読み書きは失敗しても画面を止めず、形が違う・壊れた値は既定に戻す。
 * v2: `{v:2, docks:{left:[{id,size}], right:[{id,size}]}, widths:{left,right,side}}`。v1（置き場所 place と浮かせた AI）からは読み替える。
 */
export const LAYOUT_STORAGE_KEY = "niho-editor:layout:v2";
/** 前の版（#311 まで）。v2 が無いときだけ読み、書くのは v2 だけ。 */
export const LAYOUT_STORAGE_KEY_V1 = "niho-editor:layout:v1";

export type ShellLayoutPrefs = {
  docks: ShellDocks;
  widths: ShellDockWidths;
};

/** 既定: 左＝一覧、右＝ページ（上）＋AI（下）。写真は閉じている。幅は今の幅。 */
export const DEFAULT_LAYOUT: ShellLayoutPrefs = {
  docks: SHELL_DOCKS_DEFAULT,
  widths: { ...SHELL_DOCK_DEFAULT },
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const sizeOf = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1);

/** ドックの中身を形で確かめる（知らない id・2 度目の id は落とし、size は正の数でなければ 1）。 */
function parseDocks(raw: unknown): ShellDocks {
  const seen = new Set<ShellPanelId>();
  const side = (value: unknown): ShellDockPanel[] => {
    if (!Array.isArray(value)) return [];
    const out: ShellDockPanel[] = [];
    for (const item of value) {
      if (!isObject(item) || !isShellPanelId(item.id) || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push({ id: item.id, size: sizeOf(item.size) });
    }
    return out;
  };
  const data = isObject(raw) ? raw : {};
  return { left: side(data.left), right: side(data.right) };
}

/**
 * v1（`{place:{list,ai}, widths, float}`）を読み替える: 一覧と AI は置いてあったドックへ（浮かせた AI は右の下）、
 * 「ページ」は右の上に足す（新しいパネル）、写真は閉じたまま。
 */
function docksFromV1(place: unknown): ShellDocks {
  const data = isObject(place) ? place : {};
  const list: ShellDockSide = isShellDockSide(data.list) ? data.list : "left";
  const ai: ShellDockSide = isShellDockSide(data.ai) ? data.ai : "right";
  const docks: Record<ShellDockSide, ShellDockPanel[]> = { left: [], right: [] };
  if (list === "left") docks.left.push({ id: "list", size: 1 });
  if (ai === "left") docks.left.push({ id: "ai", size: 1 });
  if (list === "right") docks.right.push({ id: "list", size: 1 });
  docks.right.push({ id: "page", size: 1 });
  if (ai === "right") docks.right.push({ id: "ai", size: 1 });
  return docks;
}

/** 保存してあった文字列を読む。版が 2 か 1 でなければ既定。欄ごとに形を確かめ、外れた欄だけ既定、数は範囲に収める。 */
export function parseLayout(raw: string | null): ShellLayoutPrefs {
  if (raw === null) return DEFAULT_LAYOUT;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return DEFAULT_LAYOUT;
  }
  if (!isObject(data) || (data.v !== 1 && data.v !== 2)) return DEFAULT_LAYOUT;
  const widths = isObject(data.widths) ? data.widths : {};
  return {
    docks: data.v === 2 ? parseDocks(data.docks) : docksFromV1(data.place),
    widths: { left: clampDockWidth("left", widths.left), right: clampDockWidth("right", widths.right), side: clampDockWidth("side", widths.side) },
  };
}

export function serializeLayout(prefs: ShellLayoutPrefs): string {
  return JSON.stringify({ v: 2, docks: prefs.docks, widths: prefs.widths });
}

// 保存の領域（localStorage）を外の store として読む。描くたびに読み、文字列が同じなら前と同じ値を返す
const listeners = new Set<() => void>();
/** 保存できなかったとき（容量・プライベートモード）の、このタブだけの値。undefined は保存の領域を読む。 */
let memory: string | undefined;
let cached: { raw: string | null; value: ShellLayoutPrefs } | null = null;

function readRaw(): string | null {
  if (memory !== undefined) return memory;
  try {
    return window.localStorage.getItem(LAYOUT_STORAGE_KEY) ?? window.localStorage.getItem(LAYOUT_STORAGE_KEY_V1);
  } catch {
    return null;
  }
}

function layoutSnapshot(): ShellLayoutPrefs {
  const raw = readRaw();
  if (cached && cached.raw === raw) return cached.value;
  cached = { raw, value: parseLayout(raw) };
  return cached.value;
}

const serverLayout = () => DEFAULT_LAYOUT;

function subscribeLayout(listener: () => void): () => void {
  listeners.add(listener);
  // ほかのタブで変えた配置も同じ端末の配置なので、すぐに合わせる
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === LAYOUT_STORAGE_KEY || event.key === LAYOUT_STORAGE_KEY_V1) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** 配置を書く（保存できなければ、このタブの間だけ覚える）。 */
export function writeLayout(prefs: ShellLayoutPrefs): void {
  const raw = serializeLayout(prefs);
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, raw);
    memory = undefined;
  } catch {
    memory = raw;
  }
  listeners.forEach((listener) => listener());
}

/** 枠の大きさ（枠は position:fixed; inset:0 なので、表示領域と同じ）。 */
type Viewport = { width: number; height: number };
/** サーバーで描くとき（大きさが分からない）は、広い画面として描く。ブラウザで描き直すときに実際の大きさになる。 */
const SERVER_VIEWPORT: Viewport = { width: 1680, height: 1000 };
let viewportCache: Viewport = SERVER_VIEWPORT;

function viewportSnapshot(): Viewport {
  const root = document.documentElement;
  const width = root.clientWidth || window.innerWidth;
  const height = root.clientHeight || window.innerHeight;
  if (viewportCache.width !== width || viewportCache.height !== height) viewportCache = { width, height };
  return viewportCache;
}

const serverViewport = () => SERVER_VIEWPORT;

function subscribeViewport(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

export type ShellPanelFlags = Record<ShellPanelId, boolean>;

export type ShellLayout = {
  docks: ShellDocks;
  widths: ShellDockWidths;
  fit: ShellDockFit;
  /** 今出しているパネル（ドックに置いてあり、かつ中身がある）。 */
  shown: ShellPanelFlags;
  /** そのパネルの今のドック（閉じていれば null）。 */
  dockOf: (panel: ShellPanelId) => ShellDockSide | null;
  /** 細い列から上に重ねて開いているドック（細い列でなくなったら null）。 */
  peek: ShellDockSide | null;
  setPeek: (side: ShellDockSide | null) => void;
  move: (panel: ShellPanelId, to: ShellPanelTarget) => void;
  /** 同じドックの上下の境目を動かした（index は下のパネルの位置、fraction は上のパネルの分）。 */
  resize: (side: ShellDockSide, index: number, fraction: number) => void;
  /** パネルを閉じる（×）・出す（ヘッダー右上のボタン。元のドックの下に戻る）。 */
  close: (panel: ShellPanelId) => void;
  open: (panel: ShellPanelId) => void;
  setWidth: (key: ShellDockWidthKey, width: number) => void;
};

/**
 * パネルの配置の状態（EditorFrame が EditorShell の dock に渡す）。available は中身のあるパネル（ページを開いていなければ AI・ページ・写真は無い）。
 * side は右に並べたページを出しているか。900px 未満（wide=false）でも覚えた値は持つが、細い列から開く（peek）は使わない。
 */
export function useShellLayout(input: { wide: boolean; available: ShellPanelFlags; side: boolean }): ShellLayout {
  const prefs = useSyncExternalStore(subscribeLayout, layoutSnapshot, serverLayout);
  const viewport = useSyncExternalStore(subscribeViewport, viewportSnapshot, serverViewport);
  const [peeked, setPeek] = useState<ShellDockSide | null>(null);
  const { wide, side } = input;
  const { list, ai, page, photos } = input.available;
  const docks = prefs.docks;
  const shown = useMemo<ShellPanelFlags>(() => {
    const available = { list, ai, page, photos };
    const flags = { list: false, ai: false, page: false, photos: false };
    for (const id of SHELL_PANELS) flags[id] = available[id] && dockOf(docks, id) !== null;
    return flags;
  }, [docks, list, ai, page, photos]);
  const fit = useMemo(() => {
    const panels = dockPanels(docks, shown);
    return computeShellDock({ width: viewport.width, widths: prefs.widths, docks: { left: panels.left.map((item) => item.id), right: panels.right.map((item) => item.id) }, side });
  }, [viewport.width, prefs.widths, docks, shown, side]);
  const peek = wide && peeked && fit.strip[peeked] ? peeked : null;
  const update = useCallback((change: (current: ShellLayoutPrefs) => ShellLayoutPrefs) => {
    const current = layoutSnapshot();
    const next = change(current);
    if (next !== current) writeLayout(next);
  }, []);
  const move = useCallback(
    (panel: ShellPanelId, to: ShellPanelTarget) => {
      setPeek(null);
      update((current) => {
        const next = movePanel(current.docks, panel, to);
        return next === current.docks ? current : { ...current, docks: next };
      });
    },
    [update],
  );
  const resize = useCallback(
    (dockSide: ShellDockSide, index: number, fraction: number) =>
      update((current) => {
        const next = resizeDockPanels(current.docks, dockSide, index, fraction);
        return next === current.docks ? current : { ...current, docks: next };
      }),
    [update],
  );
  const close = useCallback(
    (panel: ShellPanelId) =>
      update((current) => {
        const next = closePanel(current.docks, panel);
        return next === current.docks ? current : { ...current, docks: next };
      }),
    [update],
  );
  const open = useCallback(
    (panel: ShellPanelId) => {
      setPeek(null);
      update((current) => {
        const next = openPanel(current.docks, panel);
        return next === current.docks ? current : { ...current, docks: next };
      });
    },
    [update],
  );
  const setWidth = useCallback(
    (key: ShellDockWidthKey, width: number) => update((current) => ({ ...current, widths: { ...current.widths, [key]: clampDockWidth(key, width) } })),
    [update],
  );
  const dockOfPanel = useCallback((panel: ShellPanelId) => dockOf(docks, panel), [docks]);
  return { docks, widths: prefs.widths, fit, shown, dockOf: dockOfPanel, peek, setPeek, move, resize, close, open, setWidth };
}
