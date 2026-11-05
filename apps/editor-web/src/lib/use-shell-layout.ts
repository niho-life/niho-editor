"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import {
  SHELL_DOCK_DEFAULT,
  SHELL_DOCK_PLACE,
  SHELL_FLOAT_HEIGHT,
  clampDockWidth,
  computeShellDock,
  dockPanels,
  type ShellAiPlace,
  type ShellDockFit,
  type ShellDockPlace,
  type ShellDockSide,
  type ShellDockWidthKey,
  type ShellDockWidths,
  type ShellPanelId,
  type ShellPanelTarget,
} from "niho-docs-ui/shell";

/**
 * 分割ビューの配置・幅・浮かせた AI の開閉と高さ（設計 §5.5）。端末ごとに覚える（ブラウザの保存領域。サーバーには置かない。
 * 画面の大きさが端末ごとに違うため）。読み書きは失敗しても画面を止めず、形が違う・壊れた値は既定に戻す。
 */
export const LAYOUT_STORAGE_KEY = "niho-editor:layout:v1";

export type ShellLayoutPrefs = {
  place: ShellDockPlace;
  widths: ShellDockWidths;
  /** 浮かせた AI を開いているか（会話を出す）と、開いたときの高さ。 */
  float: { open: boolean; height: number };
};

/** 既定（今と同じ。一覧は左、AI は右。幅は今の幅）。 */
export const DEFAULT_LAYOUT: ShellLayoutPrefs = {
  place: { ...SHELL_DOCK_PLACE },
  widths: { ...SHELL_DOCK_DEFAULT },
  float: { open: false, height: SHELL_FLOAT_HEIGHT.default },
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isSide = (value: unknown): value is ShellDockSide => value === "left" || value === "right";
const isAiPlace = (value: unknown): value is ShellAiPlace => isSide(value) || value === "float";
const clampFloat = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(Math.min(SHELL_FLOAT_HEIGHT.max, Math.max(SHELL_FLOAT_HEIGHT.min, value))) : SHELL_FLOAT_HEIGHT.default;

/** 保存してあった文字列を読む。版（v: 1）が違う・JSON でないなら既定。欄ごとに形を確かめ、外れた欄だけ既定、数は範囲に収める。 */
export function parseLayout(raw: string | null): ShellLayoutPrefs {
  if (raw === null) return DEFAULT_LAYOUT;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return DEFAULT_LAYOUT;
  }
  if (!isObject(data) || data.v !== 1) return DEFAULT_LAYOUT;
  const place = isObject(data.place) ? data.place : {};
  const widths = isObject(data.widths) ? data.widths : {};
  const float = isObject(data.float) ? data.float : {};
  return {
    place: { list: isSide(place.list) ? place.list : DEFAULT_LAYOUT.place.list, ai: isAiPlace(place.ai) ? place.ai : DEFAULT_LAYOUT.place.ai },
    widths: { left: clampDockWidth("left", widths.left), right: clampDockWidth("right", widths.right), side: clampDockWidth("side", widths.side) },
    float: { open: typeof float.open === "boolean" ? float.open : DEFAULT_LAYOUT.float.open, height: clampFloat(float.height) },
  };
}

export function serializeLayout(prefs: ShellLayoutPrefs): string {
  return JSON.stringify({ v: 1, place: prefs.place, widths: prefs.widths, float: prefs.float });
}

// 保存の領域（localStorage）を外の store として読む。描くたびに読み、文字列が同じなら前と同じ値を返す
const listeners = new Set<() => void>();
/** 保存できなかったとき（容量・プライベートモード）の、このタブだけの値。undefined は保存の領域を読む。 */
let memory: string | undefined;
let cached: { raw: string | null; value: ShellLayoutPrefs } | null = null;

function readRaw(): string | null {
  if (memory !== undefined) return memory;
  try {
    return window.localStorage.getItem(LAYOUT_STORAGE_KEY);
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
    if (event.key === null || event.key === LAYOUT_STORAGE_KEY) listener();
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

export type ShellLayout = {
  place: ShellDockPlace;
  widths: ShellDockWidths;
  fit: ShellDockFit;
  /** 細い列から上に重ねて開いているドック（細い列でなくなったら null）。 */
  peek: ShellDockSide | null;
  setPeek: (side: ShellDockSide | null) => void;
  move: (panel: ShellPanelId, to: ShellPanelTarget) => void;
  setWidth: (key: ShellDockWidthKey, width: number) => void;
  float: { open: boolean; height: number; max: number };
  setFloatOpen: (open: boolean) => void;
  setFloatHeight: (height: number) => void;
};

/**
 * 分割ビューの状態（EditorFrame が EditorShell の dock に渡す）。shown は今見せているもの（一覧・AI・右のページ）。
 * 900px 未満（wide=false）でも覚えた値は持つが、細い列から開く（peek）は使わない。
 */
export function useShellLayout(shown: { wide: boolean; list: boolean; ai: boolean; side: boolean }): ShellLayout {
  const prefs = useSyncExternalStore(subscribeLayout, layoutSnapshot, serverLayout);
  const viewport = useSyncExternalStore(subscribeViewport, viewportSnapshot, serverViewport);
  const [peeked, setPeek] = useState<ShellDockSide | null>(null);
  const { list, ai, side, wide } = shown;
  const fit = useMemo(
    () => computeShellDock({ width: viewport.width, widths: prefs.widths, docks: dockPanels(prefs.place, { list, ai }), side }),
    [viewport.width, prefs.widths, prefs.place, list, ai, side],
  );
  const peek = wide && peeked && fit.strip[peeked] ? peeked : null;
  const update = useCallback((change: (current: ShellLayoutPrefs) => ShellLayoutPrefs) => writeLayout(change(layoutSnapshot())), []);
  const move = useCallback(
    (panel: ShellPanelId, to: ShellPanelTarget) => {
      setPeek(null);
      update((current) => {
        if (panel === "list") return isSide(to) && current.place.list !== to ? { ...current, place: { ...current.place, list: to } } : current;
        if (current.place.ai === to) return current;
        // 浮かせたときは入力欄 1 行から（送るか ⌃ で開く）
        return { ...current, place: { ...current.place, ai: to }, float: to === "float" ? { ...current.float, open: false } : current.float };
      });
    },
    [update],
  );
  const setWidth = useCallback(
    (key: ShellDockWidthKey, width: number) => update((current) => ({ ...current, widths: { ...current.widths, [key]: clampDockWidth(key, width) } })),
    [update],
  );
  const setFloatOpen = useCallback(
    (open: boolean) => update((current) => (current.float.open === open ? current : { ...current, float: { ...current.float, open } })),
    [update],
  );
  const setFloatHeight = useCallback((height: number) => update((current) => ({ ...current, float: { ...current.float, height: clampFloat(height) } })), [update]);
  // 開いたときの高さの最大（ヘッダーと本文の上の余白を残す）。覚えた高さは変えず、入らない間だけ縮める
  const floatMax = Math.max(SHELL_FLOAT_HEIGHT.min, viewport.height - 48 - 120);
  return {
    place: prefs.place,
    widths: prefs.widths,
    fit,
    peek,
    setPeek,
    move,
    setWidth,
    float: { open: prefs.float.open, height: Math.min(prefs.float.height, floatMax), max: floatMax },
    setFloatOpen,
    setFloatHeight,
  };
}
