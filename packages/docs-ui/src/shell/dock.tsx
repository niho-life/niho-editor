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
  SHELL_PANEL_MIN_HEIGHT,
  SHELL_PANEL_NAME,
  dockPanels,
  dockWidthRange,
  panelDropTarget,
  panelGhostRect,
  panelShares,
  type ShellDockFit,
  type ShellDockSide,
  type ShellDockWidthKey,
  type ShellDockWidths,
  type ShellDocks,
  type ShellPanelId,
  type ShellPanelShare,
  type ShellPanelTarget,
} from "./dock-layout";
import { Icon } from "./icons";
import type { ShellIconName } from "./types";

/**
 * EditorShell のパネルの配置（設計 §5.5・#311）。渡したときだけ、一覧・AI・ページ・写真を左右のドックに置き、右に読むだけのページを並べる。
 * 状態はすべて呼ぶ側が持つ（ドックの中身と高さの割合・幅）。ここが持つのはドラッグ中の印だけ。
 */
export type EditorShellDock = {
  /**
   * デスクトップ（900px 以上）か。false の間は 1 枚表示（一覧は最初の画面、ほかのパネルは 1 つずつ全画面）で、
   * ドックの並び・幅・右のページは使わない。木の形は同じなので、切り替えてもパネルの中の状態は残る。
   */
  wide: boolean;
  /** 左右のドックの中身（上から順）と高さの割合。 */
  docks: ShellDocks;
  /** 幅の割り当て（computeShellDock の結果）。 */
  fit: ShellDockFit;
  /** 本人が決めた幅（細い列から上に重ねて開くときの幅・落とすと入る形の幅）。 */
  widths: ShellDockWidths;
  /** 境目を動かした（範囲に収めた値）。 */
  onWidth?: (key: ShellDockWidthKey, width: number) => void;
  /** 細い列から上に重ねて開いているドック。 */
  peek?: ShellDockSide | null;
  onPeek?: (side: ShellDockSide | null) => void;
  /** パネルの見出しを掴んで、落とし先（ドックの上か下）へ落とした。 */
  onMove?: (panel: ShellPanelId, to: ShellPanelTarget) => void;
  /** 同じドックの上下の境目を動かした。index は下のパネルの位置（1〜）、fraction は上のパネルが 2 つの合計に占める割合。 */
  onResize?: (side: ShellDockSide, index: number, fraction: number) => void;
  /** 右に並べたページ（ShellSidePane）。渡さなければ列を出さない。 */
  side?: ReactNode;
  /** 一覧の行（ページ用の型）を本文へ落とした。main は「ここで開く」、side は「右に並べる」。 */
  onDropPage?: (id: string, where: "main" | "side") => void;
  /** 右のページの上の帯を真ん中へ落とした（入れ替え）。 */
  onDropSide?: () => void;
};

const SIDE_NAME: Record<ShellDockSide, string> = { left: "左", right: "右" };
/** 細い列のアイコン。 */
const STRIP_ICON: Record<ShellPanelId, ShellIconName> = { list: "list", ai: "spark", page: "info", photos: "img" };

/** ドックの列（grid の 7 本の列のうち、左は 1、右は 7）。 */
export const dockColumn = (side: ShellDockSide) => (side === "left" ? 1 : 7);

/**
 * ドックの中のパネルの縦の位置（枠の高さに対する calc）。左のドックは上にアプリ名の段・下に設定の段があるので、その間。
 * 右のドックは枠の全高。
 * `head` は左のドックの一番上の一覧（アプリ名を自分の上の 1 行の左に出す）。アプリ名の段も使うので、上端は 0 で、その段の分だけ高い。
 */
export function panelTop(side: ShellDockSide, start: number, head = false): string {
  if (side === "left" && head) return "0px";
  return side === "left" ? `calc(var(--es-header) + (100% - 2 * var(--es-header)) * ${start})` : `${start * 100}%`;
}
export function panelHeight(side: ShellDockSide, share: number, head = false): string {
  if (side === "left" && head) return `calc(var(--es-header) + (100% - 2 * var(--es-header)) * ${share})`;
  return side === "left" ? `calc((100% - 2 * var(--es-header)) * ${share})` : `${share * 100}%`;
}

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

export type ShellPanelHeadProps = {
  panel: ShellPanelId;
  /** 見出しの文字（省くとパネルの名前）。 */
  title?: string;
  /** × を出す（押すとパネルを閉じる）。 */
  onClose?: () => void;
  /** true なら見出しを掴んでドックへ移せる（デスクトップだけ）。移すメニューは無い（ドラッグだけ）。 */
  drag?: boolean;
  /** 見出しの右に置く操作（写真の ＋ など）。× はその右。 */
  children?: ReactNode;
};

/**
 * パネルの見出しの行: [掴む所] 名前 …… [操作] [×]（モック editor-folder-pages-v1 の .ph）。
 * 一覧は上の 1 行（ShellSidebar）、AI は自分の見出し（AiBox）が同じ役を持つので、これを使うのは「ページ」と「写真」。
 */
export function ShellPanelHead({ panel, title, onClose, drag, children }: ShellPanelHeadProps) {
  const name = SHELL_PANEL_NAME[panel];
  return (
    <div
      className="es-pn-hd"
      draggable={drag ? true : undefined}
      onDragStart={
        drag
          ? (event) => {
              if (!event.dataTransfer) return;
              event.dataTransfer.setData(SHELL_DND.panel[panel], panel);
              event.dataTransfer.effectAllowed = "move";
            }
          : undefined
      }
    >
      {drag && (
        <span className="es-grip" aria-hidden="true" title="ドラッグでドックを移す">
          <Icon name="grip" />
        </span>
      )}
      <h2 className="es-pn-tt">{title ?? name}</h2>
      <span className="es-sp" />
      {children}
      {onClose && <ShellPanelClose panel={panel} onClose={onClose} />}
    </div>
  );
}

/** パネルの ×。`over` は見出しを持つ部品（AI）の右上に重ねて置く。 */
export function ShellPanelClose({ panel, onClose, over }: { panel: ShellPanelId; onClose: () => void; over?: boolean }) {
  return (
    <button
      type="button"
      className={over ? "es-ib es-ib--sm es-pn-x es-pn-x--over" : "es-ib es-ib--sm es-pn-x"}
      aria-label={`${SHELL_PANEL_NAME[panel]}を閉じる`}
      title="閉じる"
      onClick={onClose}
    >
      <Icon name="x" />
    </button>
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

/** ドラッグで運んでいるもの（独自の型から決める。どれでもなければ null）。row は一覧の行（ページ）、band は右のページの帯。 */
type DragKind = { what: "row" } | { what: "band" } | { what: "panel"; panel: ShellPanelId };

function dragKindOf(types: readonly string[] | DOMStringList | undefined, accepts: { page: boolean; side: boolean; panels: boolean }): DragKind | null {
  const list = types ? Array.from(types as ArrayLike<string>) : [];
  if (accepts.page && list.includes(SHELL_DND.page)) return { what: "row" };
  if (accepts.side && list.includes(SHELL_DND.side)) return { what: "band" };
  if (accepts.panels) {
    for (const panel of Object.keys(SHELL_DND.panel) as ShellPanelId[]) if (list.includes(SHELL_DND.panel[panel])) return { what: "panel", panel };
  }
  return null;
}

const panelOf = (kind: DragKind | null): ShellPanelId | null => (kind && kind.what === "panel" ? kind.panel : null);

type Shown = Readonly<Record<ShellPanelId, boolean>>;

type DndProps = {
  host: RefObject<HTMLElement | null>;
  dock: EditorShellDock;
  shown: Shown;
};

const idsOf = (docks: ShellDocks, shown: Shown): Record<ShellDockSide, ShellPanelId[]> => {
  const panels = dockPanels(docks, shown);
  return { left: panels.left.map((item) => item.id), right: panels.right.map((item) => item.id) };
};

/**
 * ドラッグ中の落とし先（ページ用の型のときの「ここで開く」「右に並べる」と、パネルを掴んだときの「落とすと入る形」）。
 * 枠（.es-root）の dragover を見て、独自の型のときだけ出す。パネルは近づけた場所に形を先に出し、そこへ落とすと移す。
 */
function ShellDockDnd({ host, dock, shown }: DndProps) {
  const [kind, setKind] = useState<DragKind | null>(null);
  // 落とすと入る場所と、そのときの枠の高さ（形の位置は描くときに決める）
  const [ghost, setGhost] = useState<{ at: ShellPanelTarget; height: number } | null>(null);
  const [hot, setHot] = useState<"main" | "side" | null>(null);
  // ドラッグの合図（ネイティブの listener）からは、いつも今の props を読む（SSR で警告を出さないよう useEffect で写す）
  const latest = useRef({ dock, shown });
  useEffect(() => {
    latest.current = { dock, shown };
  });

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    const accepts = () => ({
      page: Boolean(latest.current.dock.onDropPage),
      side: Boolean(latest.current.dock.onDropSide),
      panels: Boolean(latest.current.dock.onMove),
    });
    const reset = () => {
      setKind(null);
      setGhost(null);
      setHot(null);
    };
    const target = (event: DragEvent, panel: ShellPanelId): { at: ShellPanelTarget; height: number } | null => {
      const box = root.getBoundingClientRect();
      const { fit, docks } = latest.current.dock;
      const at = panelDropTarget(panel, { x: event.clientX - box.left, y: event.clientY - box.top }, fit, box.height, idsOf(docks, latest.current.shown));
      return at === null ? null : { at, height: box.height };
    };
    const onOver = (event: DragEvent) => {
      const found = dragKindOf(event.dataTransfer?.types, accepts());
      if (!found) return;
      setKind(found);
      const panel = panelOf(found);
      if (panel === null) return;
      const at = target(event, panel);
      setGhost((current) =>
        current && at && current.at.side === at.at.side && current.at.at === at.at.at && current.height === at.height ? current : at,
      );
      if (at === null) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    };
    // 落としたときの処理は、この枠の listener がすべて受ける（落とし先の React の onDrop には任せない）。
    // 本物のドラッグでは、ここで reset した描き直しが listener の合間（microtask）に走って落とし先が消え、
    // React の onDrop まで届かない（JS から送った合成のイベントでは合間が無いので起きない）
    const onDrop = (event: DragEvent) => {
      const found = dragKindOf(event.dataTransfer?.types, accepts());
      const panel = panelOf(found);
      if (panel !== null) {
        const at = target(event, panel);
        if (at !== null) {
          event.preventDefault();
          latest.current.dock.onMove?.(panel, at.at);
        }
      } else if (found) {
        const zone = event.target instanceof Element ? event.target.closest("[data-zone]") : null;
        const where = zone && root.contains(zone) ? zone.getAttribute("data-zone") : null;
        if (where === "main" || where === "side") {
          event.preventDefault();
          if (found.what === "band") {
            if (where === "main") latest.current.dock.onDropSide?.();
          } else {
            const id = event.dataTransfer?.getData(SHELL_DND.page) ?? "";
            if (id) latest.current.dock.onDropPage?.(id, where);
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
  const ids = idsOf(dock.docks, shown);
  const dragged = panelOf(kind);
  const rect = ghost && dragged ? panelGhostRect(dragged, ghost.at, fit, ghost.height, dock.widths, ids) : null;
  const others = ghost && dragged ? ids[ghost.at.side].filter((id) => id !== dragged).length : 0;
  return (
    <>
      {kind?.what === "row" && (
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
      {kind?.what === "band" && (
        <div className="es-dzs" aria-hidden="true" style={{ gridColumn: "3 / 4" }}>
          <div className={`es-dz${hot === "main" ? " es-dz--hot" : ""}`} data-zone="main" {...zone("main")}>
            メインに置く
            <small>いまのメインは右へ移ります</small>
          </div>
        </div>
      )}
      {rect && ghost && dragged && (
        <div className="es-ghost" aria-hidden="true" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
          {`${SIDE_NAME[ghost.at.side]}のドック`}
          <small>{others > 0 ? `「${SHELL_PANEL_NAME[dragged]}」を${ghost.at.at === "top" ? "上" : "下"}に置く` : `「${SHELL_PANEL_NAME[dragged]}」を入れる`}</small>
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
          aria-label={`${SHELL_PANEL_NAME[panel]}を開く`}
          title={SHELL_PANEL_NAME[panel]}
          aria-expanded={peek}
          onClick={() => onPeek?.(peek ? null : side)}
        >
          <Icon name={STRIP_ICON[panel]} />
        </button>
      ))}
    </div>
  );
}

/** ドックの中のパネルの高さ（px。左のドックはアプリ名と設定の段を除く）。 */
export const dockHeight = (side: ShellDockSide, wsHeight: number, header: number) => Math.max(0, side === "left" ? wsHeight - 2 * header : wsHeight);

/**
 * 同じドックの上下の境目（横の separator）。値は上のパネルの高さ（px）。下へ動かすと上のパネルが広がる。
 * 最小は SHELL_PANEL_MIN_HEIGHT、最大は 2 つの合計からその分を引いたもの。Enter・ダブルクリックで半々。
 */
function ShellDockSplit({
  side,
  index,
  upper,
  lower,
  height,
  width,
  onResize,
}: {
  side: ShellDockSide;
  index: number;
  upper: ShellPanelShare;
  lower: ShellPanelShare;
  /** ドックの中のパネルの高さ（px）。 */
  height: number;
  width: number;
  onResize: (side: ShellDockSide, index: number, fraction: number) => void;
}) {
  const total = (upper.share + lower.share) * height;
  const min = SHELL_PANEL_MIN_HEIGHT;
  const max = Math.max(min, total - min);
  const style: CSSProperties = side === "left" ? { left: 0, width, top: panelTop(side, lower.start) } : { right: 0, width, top: panelTop(side, lower.start) };
  return (
    <ShellSash
      className="es-sash--split"
      orientation="horizontal"
      grow={-1}
      label={`「${SHELL_PANEL_NAME[upper.id]}」と「${SHELL_PANEL_NAME[lower.id]}」の境目`}
      value={Math.min(max, Math.max(min, upper.share * height))}
      min={min}
      max={max}
      defaultValue={total / 2}
      onChange={(px) => {
        if (total > 0) onResize(side, index, px / total);
      }}
      style={style}
    />
  );
}

/** デスクトップのパネルの配置で .es-ws の末尾に足すもの（境目・右のページ・細い列・ドラッグ中の落とし先）。 */
export function ShellDockExtras({ host, dock, shown, height }: { host: RefObject<HTMLElement | null>; dock: EditorShellDock; shown: Shown; height: number }) {
  const { fit, onWidth, onResize } = dock;
  const panels = dockPanels(dock.docks, shown);
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
        fit.strip[side] && panels[side].length > 0 ? (
          <ShellDockStrip key={side} side={side} panels={panels[side].map((item) => item.id)} peek={dock.peek === side} onPeek={dock.onPeek} />
        ) : null,
      )}
      {onResize &&
        (["left", "right"] as const).flatMap((side) => {
          if (fit.strip[side] && dock.peek !== side) return [];
          const shares = panelShares(panels[side]);
          const width = fit.strip[side] ? dock.widths[side] : fit[side];
          return shares.slice(1).map((lower, at) => (
            <ShellDockSplit
              key={`${side}:${lower.id}`}
              side={side}
              index={at + 1}
              upper={shares[at]!}
              lower={lower}
              height={dockHeight(side, height, headerPx(host.current))}
              width={width}
              onResize={onResize}
            />
          ));
        })}
      <ShellDockDnd host={host} dock={dock} shown={shown} />
    </>
  );
}

/** ヘッダーの高さ（--es-header。読めなければ 48）。 */
export function headerPx(root: HTMLElement | null): number {
  if (!root || typeof getComputedStyle !== "function") return 48;
  const value = parseFloat(getComputedStyle(root).getPropertyValue("--es-header"));
  return Number.isFinite(value) && value > 0 ? value : 48;
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
 * 枠（.es-ws）の高さを測る（同じドックの上下の境目の値を px で出すため）。ResizeObserver が無い環境では窓の resize で測り直す。
 * active が false の間（900px 未満・dock 無し）は測らない（0）。
 */
export function useBoxHeight(box: RefObject<HTMLElement | null>, active: boolean): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const element = box.current;
    if (!element || !active) return;
    const measure = () => setHeight((current) => {
      const next = Math.round(element.getBoundingClientRect().height);
      return next === current ? current : next;
    });
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [box, active]);
  return active ? height : 0;
}
