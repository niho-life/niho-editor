import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  SHELL_DND,
  SHELL_DOCK_DEFAULT,
  SHELL_DOCK_STRIP,
  dockPanels,
  dockWidthRange,
  panelDropTarget,
  panelGhostRect,
  placeOf,
  type ShellDockFit,
  type ShellDockPlace,
  type ShellDockSide,
  type ShellDockWidthKey,
  type ShellDockWidths,
  type ShellPanelId,
  type ShellPanelTarget,
} from "./dock-layout";
import { Icon } from "./icons";

/**
 * EditorShell の分割ビュー（設計 §5.5）。渡したときだけ、一覧・AI をドックに置き、右に読むだけのページを並べる。
 * 状態はすべて呼ぶ側が持つ（置き場所・幅・浮かせた AI の開閉と高さ）。ここが持つのはドラッグ中の印だけ。
 */
export type EditorShellDock = {
  /**
   * デスクトップ（900px 以上）か。false の間は従来の 1 枚表示（一覧・ページ・レールのどれか 1 つを全画面）で、
   * 置き場所・幅・右のページは使わない。木の形は同じなので、切り替えても一覧と AI の中の状態は残る。
   */
  wide: boolean;
  /** 一覧と AI の置き場所。 */
  place: ShellDockPlace;
  /** 幅の割り当て（computeShellDock の結果）。 */
  fit: ShellDockFit;
  /** 本人が決めた幅（細い列から上に重ねて開くときの幅・落とすと入る形の幅）。 */
  widths: ShellDockWidths;
  /** 境目を動かした（範囲に収めた値）。 */
  onWidth?: (key: ShellDockWidthKey, width: number) => void;
  /** 細い列から上に重ねて開いているドック。 */
  peek?: ShellDockSide | null;
  onPeek?: (side: ShellDockSide | null) => void;
  /** パネルの見出しを掴んで、別の場所へ落とした。 */
  onMove?: (panel: ShellPanelId, to: ShellPanelTarget) => void;
  /** 右に並べたページ（ShellSidePane）。渡さなければ列を出さない。 */
  side?: ReactNode;
  /** 一覧の行（ページ用の型）を本文へ落とした。main は「ここで開く」、side は「右に並べる」。 */
  onDropPage?: (id: string, where: "main" | "side") => void;
  /** 右のページの上の帯を真ん中へ落とした（入れ替え）。 */
  onDropSide?: () => void;
  /** AI を浮かせているときの、開いているか（会話を出す）と高さ。 */
  float?: { open: boolean; height: number; max: number; onHeight: (height: number) => void };
};

const PANEL_NAME: Record<ShellPanelId, string> = { list: "一覧", ai: "AIと作る" };
const SIDE_NAME: Record<ShellDockSide, string> = { left: "左", right: "右" };

/** ドックの列（grid の 7 本の列のうち、左は 1、右は 7）。 */
export const dockColumn = (side: ShellDockSide) => (side === "left" ? 1 : 7);

export type ShellSashProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  /** ダブルクリック・Enter で戻る値。 */
  defaultValue: number;
  /** vertical は左右に動かす境目（← →）、horizontal は上下（↑ ↓）。 */
  orientation?: "vertical" | "horizontal";
  /** 右（horizontal は上）へ動かすと値が増えるなら 1、減るなら -1。 */
  grow?: 1 | -1;
  onChange: (value: number) => void;
  controls?: string;
  className?: string;
  style?: CSSProperties;
};

/**
 * 境目（role="separator"）。ドラッグ（pointer）、← →（horizontal は ↑ ↓。Shift で大きく）、Home / End で最小・最大、
 * ダブルクリックか Enter で既定の値。値はいつも min〜max に収めてから onChange へ渡す。
 */
export function ShellSash({ label, value, min, max, defaultValue, orientation = "vertical", grow = 1, onChange, controls, className, style }: ShellSashProps) {
  const drag = useRef<{ id: number; from: number; start: number } | null>(null);
  const vertical = orientation === "vertical";
  const fit = (next: number) => Math.round(Math.min(max, Math.max(min, next)));
  const shown = Math.round(value);
  const end = (element: HTMLElement) => {
    drag.current = null;
    delete element.dataset.dragging;
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={shown}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${shown}px`}
      aria-controls={controls}
      className={className ? `es-sash ${className}` : "es-sash"}
      style={style}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const element = event.currentTarget;
        element.setPointerCapture?.(event.pointerId);
        element.focus({ preventScroll: true });
        element.dataset.dragging = "true";
        drag.current = { id: event.pointerId, from: vertical ? event.clientX : event.clientY, start: value };
      }}
      onPointerMove={(event) => {
        const now = drag.current;
        if (!now || now.id !== event.pointerId) return;
        const delta = vertical ? event.clientX - now.from : now.from - event.clientY;
        onChange(fit(now.start + grow * delta));
      }}
      onPointerUp={(event) => end(event.currentTarget)}
      onPointerCancel={(event) => end(event.currentTarget)}
      onLostPointerCapture={(event) => end(event.currentTarget)}
      onDoubleClick={() => onChange(fit(defaultValue))}
      onKeyDown={(event) => {
        const step = vertical ? (event.shiftKey ? 64 : 16) : event.shiftKey ? 96 : 24;
        const more = vertical ? "ArrowRight" : "ArrowUp";
        const less = vertical ? "ArrowLeft" : "ArrowDown";
        let next: number;
        if (event.key === more) next = value + grow * step;
        else if (event.key === less) next = value - grow * step;
        else if (event.key === "Home") next = min;
        else if (event.key === "End") next = max;
        else if (event.key === "Enter") next = defaultValue;
        else return;
        event.preventDefault();
        onChange(fit(next));
      }}
    />
  );
}

export type ShellSidePaneProps = {
  /** 右のページの id（上の帯を掴んだときに運ぶ）。 */
  pageId: string;
  /** 題名。本文の先頭に 1 か所だけ、メインの題名と同じ大きさ・同じ高さで出す。読み終えるまでは渡さない。 */
  title?: string;
  /** ⇄（メインと入れ替える）。 */
  onSwap: () => void;
  /** ×（右のページを閉じる）。 */
  onClose: () => void;
  /** 本文（読み取り専用）・読み込み中・読めないときの一言。 */
  children: ReactNode;
};

/**
 * 右に並べたページの枠（読むだけ）。上の帯は掴む所（⋮⋮）・⇄・× だけで、「読むだけ」「入れ替える」の文字は出さない。
 * 帯を掴んで真ん中へ落とすと、メインと入れ替わる（EditorShellDock.onDropSide）。
 */
export function ShellSidePane({ pageId, title, onSwap, onClose, children }: ShellSidePaneProps) {
  return (
    <section className="es-side" aria-label="右に並べたページ">
      <div
        className="es-side-band"
        draggable
        onDragStart={(event) => {
          if (!event.dataTransfer) return;
          event.dataTransfer.setData(SHELL_DND.side, pageId);
          event.dataTransfer.effectAllowed = "move";
        }}
      >
        <span className="es-grip es-grip--on" aria-hidden="true">
          <Icon name="grip" />
        </span>
        <span className="es-sp" />
        <button type="button" className="es-ib es-ib--sm" aria-label="メインと入れ替える" title="メインと入れ替える" onClick={onSwap}>
          <Icon name="swap" />
        </button>
        <button type="button" className="es-ib es-ib--sm" aria-label="右のページを閉じる" title="右のページを閉じる" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="es-side-body" tabIndex={0} role="group" aria-label="右のページの中身">
        {title !== undefined && <h2 className="es-side-tt">{title || "無題"}</h2>}
        {children}
      </div>
    </section>
  );
}

/** ドラッグで運んでいるもの（独自の型から決める。どれでもなければ null）。 */
type DragKind = "page" | "side" | ShellPanelId;

function dragKindOf(types: readonly string[] | DOMStringList | undefined, accepts: { page: boolean; side: boolean; panels: boolean }): DragKind | null {
  const list = types ? Array.from(types as ArrayLike<string>) : [];
  if (accepts.page && list.includes(SHELL_DND.page)) return "page";
  if (accepts.side && list.includes(SHELL_DND.side)) return "side";
  if (accepts.panels && list.includes(SHELL_DND.ai)) return "ai";
  if (accepts.panels && list.includes(SHELL_DND.list)) return "list";
  return null;
}

type DndProps = {
  host: RefObject<HTMLElement | null>;
  dock: EditorShellDock;
};

/**
 * ドラッグ中の落とし先（ページ用の型のときの「ここで開く」「右に並べる」と、パネルを掴んだときの「落とすと入る形」）。
 * 枠（.es-root）の dragover を見て、独自の型のときだけ出す。パネルは近づけた場所に形を先に出し、そこへ落とすと移す。
 */
function ShellDockDnd({ host, dock }: DndProps) {
  const [kind, setKind] = useState<DragKind | null>(null);
  // 落とすと入る場所と、そのときの枠の高さ（形の位置は描くときに決める）
  const [ghost, setGhost] = useState<{ at: ShellPanelTarget; height: number } | null>(null);
  const [hot, setHot] = useState<"main" | "side" | null>(null);
  // ドラッグの合図（ネイティブの listener）からは、いつも今の props を読む（SSR で警告を出さないよう useEffect で写す）
  const latest = useRef(dock);
  useEffect(() => {
    latest.current = dock;
  });

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    const accepts = () => ({ page: Boolean(latest.current.onDropPage), side: Boolean(latest.current.onDropSide), panels: Boolean(latest.current.onMove) });
    const reset = () => {
      setKind(null);
      setGhost(null);
      setHot(null);
    };
    const target = (event: DragEvent, panel: ShellPanelId): { at: ShellPanelTarget; height: number } | null => {
      const box = root.getBoundingClientRect();
      const { fit, place } = latest.current;
      const at = panelDropTarget(panel, { x: event.clientX - box.left, y: event.clientY - box.top }, fit, box.height);
      if (at === null || at === placeOf(panel, place) || (panel === "list" && at === "float")) return null;
      return { at, height: box.height };
    };
    const onOver = (event: DragEvent) => {
      const found = dragKindOf(event.dataTransfer?.types, accepts());
      if (!found) return;
      setKind(found);
      if (found !== "list" && found !== "ai") return;
      const at = target(event, found);
      setGhost((current) => (current && at && current.at === at.at && current.height === at.height ? current : at));
      if (at === null) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    };
    // 落としたときの処理は、この枠の listener がすべて受ける（落とし先の React の onDrop には任せない）。
    // 本物のドラッグでは、ここで reset した描き直しが listener の合間（microtask）に走って落とし先が消え、
    // React の onDrop まで届かない（JS から送った合成のイベントでは合間が無いので起きない）
    const onDrop = (event: DragEvent) => {
      const found = dragKindOf(event.dataTransfer?.types, accepts());
      if (found === "list" || found === "ai") {
        const at = target(event, found);
        if (at !== null) {
          event.preventDefault();
          latest.current.onMove?.(found, at.at);
        }
      } else if (found === "page" || found === "side") {
        const zone = event.target instanceof Element ? event.target.closest("[data-zone]") : null;
        const where = zone && root.contains(zone) ? zone.getAttribute("data-zone") : null;
        if (where === "main" || where === "side") {
          event.preventDefault();
          if (found === "side") {
            if (where === "main") latest.current.onDropSide?.();
          } else {
            const id = event.dataTransfer?.getData(SHELL_DND.page) ?? "";
            if (id) latest.current.onDropPage?.(id, where);
          }
        }
      }
      reset();
    };
    // 窓の外へ出た（ほかの窓へ落とす・やめる）。中の要素どうしの出入りでは消さない（次の dragover ですぐ出し直すので、ちらつく）
    const onLeave = (event: DragEvent) => {
      if (event.relatedTarget) return;
      const outside = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
      if (outside) reset();
    };
    root.addEventListener("dragenter", onOver);
    root.addEventListener("dragover", onOver);
    root.addEventListener("drop", onDrop);
    root.addEventListener("dragend", reset);
    root.addEventListener("dragleave", onLeave);
    return () => {
      root.removeEventListener("dragenter", onOver);
      root.removeEventListener("dragover", onOver);
      root.removeEventListener("drop", onDrop);
      root.removeEventListener("dragend", reset);
      root.removeEventListener("dragleave", onLeave);
    };
  }, [host]);

  const { fit } = dock;
  const zone = (where: "main" | "side") => ({
    onDragEnter: (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setHot(where);
    },
    onDragOver: (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      if (hot !== where) setHot(where);
    },
    onDragLeave: (event: ReactDragEvent<HTMLDivElement>) => {
      const next = event.relatedTarget as Node | null;
      if (next && event.currentTarget.contains(next)) return;
      setHot((current) => (current === where ? null : current));
    },
    // drop は枠の listener（上の onDrop）が受ける
  });
  const hasSide = Boolean(dock.side) && fit.side > 0;
  const rect = ghost && (kind === "list" || kind === "ai") ? panelGhostRect(ghost.at, fit, ghost.height, dock.widths) : null;
  return (
    <>
      {kind === "page" && (
        <div className="es-dzs" aria-hidden="true" style={{ gridColumn: "3 / 6" }}>
          <div className={`es-dz${hot === "main" ? " es-dz--hot" : ""}`} data-zone="main" style={{ flex: hasSide ? `${fit.main} 1 0` : "3 1 0" }} {...zone("main")}>
            ここで開く
            <small>メインを替える</small>
          </div>
          <div className={`es-dz${hot === "side" ? " es-dz--hot" : ""}`} data-zone="side" style={{ flex: hasSide ? `${fit.side} 1 0` : "2 1 0" }} {...zone("side")}>
            {hasSide ? "右のページを替える" : "右に並べる"}
            {!hasSide && <small>メインはそのまま</small>}
          </div>
        </div>
      )}
      {kind === "side" && (
        <div className="es-dzs" aria-hidden="true" style={{ gridColumn: "3 / 4" }}>
          <div className={`es-dz${hot === "main" ? " es-dz--hot" : ""}`} data-zone="main" {...zone("main")}>
            メインに置く
            <small>いまのメインは右へ移ります</small>
          </div>
        </div>
      )}
      {rect && ghost && (kind === "list" || kind === "ai") && (
        <div className="es-ghost" aria-hidden="true" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
          {ghost.at === "float" ? "メインの下に浮かせる" : `${SIDE_NAME[ghost.at]}のドック`}
          {ghost.at !== "float" && <small>「{PANEL_NAME[kind]}」を入れる</small>}
        </div>
      )}
    </>
  );
}

/** 細い列（入りきらないときに畳んだドック）。アイコンを押すと、そのドックを上に重ねて開く。 */
function ShellDockStrip({ side, panels, peek, onPeek }: { side: ShellDockSide; panels: readonly ShellPanelId[]; peek: boolean; onPeek?: (side: ShellDockSide | null) => void }) {
  return (
    <div className="es-strip" data-dock={side} style={{ gridColumn: dockColumn(side) }}>
      {panels.map((panel) => (
        <button
          key={panel}
          type="button"
          className={`es-ib${peek ? " es-ib--on" : ""}`}
          aria-label={`${PANEL_NAME[panel]}を開く`}
          title={PANEL_NAME[panel]}
          aria-expanded={peek}
          onClick={() => onPeek?.(peek ? null : side)}
        >
          <Icon name={panel === "list" ? "list" : "spark"} />
        </button>
      ))}
    </div>
  );
}

/** デスクトップの分割ビューで .es-ws の末尾に足すもの（境目・右のページ・細い列・ドラッグ中の落とし先）。 */
export function ShellDockExtras({ host, dock, shown }: { host: RefObject<HTMLElement | null>; dock: EditorShellDock; shown: { list: boolean; ai: boolean } }) {
  const { fit, onWidth } = dock;
  const panels = dockPanels(dock.place, shown);
  const sash = (key: ShellDockWidthKey, column: number, label: string, value: number, grow: 1 | -1) => {
    const range = dockWidthRange(key, fit);
    return (
      <ShellSash
        key={key}
        label={label}
        value={value}
        min={range.min}
        max={range.max}
        defaultValue={SHELL_DOCK_DEFAULT[key]}
        grow={grow}
        onChange={(width) => onWidth?.(key, width)}
        style={{ gridColumn: column }}
      />
    );
  };
  return (
    <>
      {onWidth && fit.left > SHELL_DOCK_STRIP && sash("left", 2, "左のドックの幅", fit.left, 1)}
      {onWidth && dock.side && fit.side > 0 && sash("side", 4, "右に並べたページの幅", fit.side, -1)}
      {onWidth && fit.right > SHELL_DOCK_STRIP && sash("right", 6, "右のドックの幅", fit.right, -1)}
      {dock.side ? <div className="es-sidecol">{dock.side}</div> : null}
      {(["left", "right"] as const).map((side) =>
        fit.strip[side] && panels[side].length > 0 ? <ShellDockStrip key={side} side={side} panels={panels[side]} peek={dock.peek === side} onPeek={dock.onPeek} /> : null,
      )}
      <ShellDockDnd host={host} dock={dock} />
    </>
  );
}

/**
 * 細い列から上に重ねて開いたドックを、Esc と外側の押下で閉じる。Esc のあとは細い列のアイコンへフォーカスを戻す。
 * そのドックの中でメニューを開いているあいだの Esc は、メニューが受ける（ドックは閉じない）。
 */
export function useDockPeekDismiss(host: RefObject<HTMLElement | null>, peek: ShellDockSide | null | undefined, onPeek?: (side: ShellDockSide | null) => void) {
  useEffect(() => {
    const root = host.current;
    if (!root || !peek || !onPeek) return;
    const inside = (node: EventTarget | null) => node instanceof Element && node.closest(`[data-dock="${peek}"]`) !== null && root.contains(node);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const menu = root.querySelector(`[data-dock="${peek}"] [role="menu"]`);
      if (menu) return;
      onPeek(null);
      root.querySelector<HTMLButtonElement>(`.es-strip[data-dock="${peek}"] button`)?.focus();
    };
    const onDown = (event: PointerEvent) => {
      if (!inside(event.target)) onPeek(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [host, peek, onPeek]);
}

/**
 * 浮かせた AI の高さを --es-float-h として枠に書く（本文の下に、その高さぶんの余白を足して書いている位置を隠さないため）。
 * ResizeObserver が無い環境では書かない（CSS の既定の余白を使う）。
 */
export function useFloatInset(host: RefObject<HTMLElement | null>, box: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const root = host.current;
    const element = box.current;
    if (!root || !element || !active) return;
    const write = () => root.style.setProperty("--es-float-h", `${Math.round(element.offsetHeight)}px`);
    write();
    if (typeof ResizeObserver === "undefined") return () => root.style.removeProperty("--es-float-h");
    const observer = new ResizeObserver(write);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--es-float-h");
    };
  }, [host, box, active]);
}
