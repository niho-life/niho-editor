import { useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import { SHELL_DND, type ShellDockSide } from "./dock-layout";
import { Icon } from "./icons";
import { ShellMenu } from "./menu";
import { NewPageMenu, type NewPageKind } from "./new-page-menu";
import type { ShellListItem, ShellMenuItem } from "./types";

export type ShellSidebarProps = {
  items: ShellListItem[];
  currentId?: string;
  onSelect?: (id: string) => void;
  /** フォルダの行の開閉を押した（開いているかは呼ぶ側が持ち、閉じているフォルダの中の行は渡さない）。 */
  onToggleFolder?: (id: string) => void;
  /** ＋の右隣の「一覧をしまう」。 */
  onCollapse?: () => void;
  newMenu?: { open: boolean; onToggle: () => void; onClose: () => void; onPick: (kind: NewPageKind) => void };
  search?: { open: boolean; value: string; onOpen: () => void; onClose: () => void; onChange: (value: string) => void };
  /**
   * 行をドラッグして入れ子・並べ替え（HTML5 のドラッグ＆ドロップ）。渡したときだけ行を draggable にする。
   * 行の高さの上 25% は before、下 25% は after、真ん中は into。検索の結果のように木でない並びでは渡さない（「最近」の行はドラッグしない）。
   * キーボード・スマホの代替は、呼ぶ側のメニュー（「移動…」）が持つ。
   */
  onDrop?: (dragId: string, target: ShellDropTarget) => void;
  /** その位置へ落とせるか。false なら印を出さず、落とせない。省けば全て落とせる。 */
  canDrop?: (dragId: string, target: ShellDropTarget) => boolean;
  /** 一覧の末尾（<ul> の直後、<nav> の中）に置くもの。段階読み込みの目印など。 */
  listEnd?: ReactNode;
  /**
   * 木の上に出す「最近」（旧 NIHO docs の `recent.json`）。開閉の状態は呼ぶ側が持つ。
   * 渡さなければ出さない（検索しているあいだ・まだ何も開いていない人には出さない）。
   */
  recent?: { items: ShellListItem[]; open: boolean; onToggle: () => void };
  /**
   * 一覧（nav）と左下の「設定」のあいだに置くもの（開いているページの「このページの写真」。page/PagePhotos.tsx）。
   * 渡さなければ出さない（ページを開いていない画面・設定）。
   */
  photos?: ReactNode;
  /**
   * 右に並べる（設計 §5.5。デスクトップだけ渡す）。渡すと、行を本文へドラッグできる（ページ用の型 SHELL_DND.page も載せる）・
   * ⌥クリック・行で ⌥Enter で右に並べ、行の右クリック（ContextMenu キー・Shift+F10 でも）で「開く」「右に並べて開く」のメニュー。
   * id は今右に並べているページ（その行に「右に表示中」と出し、メニューは「右を閉じる」）。
   */
  side?: { id?: string; onOpen: (id: string) => void; onClose: () => void };
  /**
   * 一覧のパネルの置き場所（設計 §5.5。デスクトップだけ渡す）。渡すと、上段（掴む所 ⋮⋮）を掴んでドックを移れ、
   * 「一覧のメニュー」に「〜のドックへ移す」を出す（ドラッグしない人の代替）。
   */
  panel?: { at: ShellDockSide; onMove: (to: ShellDockSide) => void };
  me: {
    /** 本人の名前。左下には出さず、メニューの中に出す（`shellAccountItems(…, …, name)`）。 */
    name: string;
    /** アバターの面に出す1文字（写真は持ち込まない）。 */
    initial: string;
    /** 未処理の招待の数。 */
    badge?: number;
    open: boolean;
    current?: boolean;
    items: ShellMenuItem[];
    onToggle: () => void;
    onClose: () => void;
    onSelect: (id: string) => void;
  };
};

/**
 * 本人の行のメニュー（発信先／本人の名前（役割とつながり）／設定／ログアウト）。
 * current に id（dest / account / settings）を渡すと、その項目に現在地を示す。
 * `name` を渡すと「役割とつながり」の行が本人の名前になる（左下は「設定」なので、名前はここに出す）。
 */
export function shellAccountItems(pendingInvites = 0, current?: string, name?: string): ShellMenuItem[] {
  const who = name?.trim();
  const items: ShellMenuItem[] = [
    { id: "dest", label: "発信先", icon: "ship" },
    {
      id: "account",
      label: who || "役割とつながり",
      icon: "people",
      ...(who ? { hint: "役割とつながり" } : {}),
      badge: pendingInvites > 0 ? String(pendingInvites) : undefined,
    },
    { id: "settings", label: "設定", icon: "gear" },
    { id: "logout", label: "ログアウト", icon: "back" },
  ];
  return items.map((item) => (item.id === current ? { ...item, current: true } : item));
}

/** ドロップの位置。into はその行（フォルダ）の中へ、before / after はその行の前・後（同じ階層）。 */
export type ShellDropTarget = { id: string; where: "before" | "after" | "into" };

/** ドラッグの状態（どの行を動かしているか・どこに印を出すか）。 */
type DragState = { dragId: string | null; over: ShellDropTarget | null };

/** 右に並べる操作（ShellSidebarProps.side から作る）。 */
type RowActions = {
  sideId?: string;
  onOpenSide: (id: string) => void;
  onMenu: (id: string, at: { x: number; y: number }, trigger: HTMLElement | null) => void;
};

type DragProps = {
  rowActions?: RowActions;
  drag?: {
    state: DragState;
    onStart: (id: string) => void;
    onOver: (target: ShellDropTarget | null) => void;
    onDrop: (target: ShellDropTarget) => void;
    onEnd: () => void;
    can: (target: ShellDropTarget) => boolean;
  };
};

/** 行の中の縦の位置から、落とす位置を決める（上 25% は before、下 25% は after、真ん中は into）。 */
function dropWhere(event: ReactDragEvent<HTMLElement>): ShellDropTarget["where"] {
  const box = event.currentTarget.getBoundingClientRect();
  if (box.height <= 0) return "into";
  const at = (event.clientY - box.top) / box.height;
  return at < 0.25 ? "before" : at > 0.75 ? "after" : "into";
}

/** 木の 1 つの行と、その中の行。 */
type TreeNode = { item: ShellListItem; children: TreeNode[] };

/**
 * 段（`depth`）の並びから木を組む。深い行は直前の浅い行の中に入り、段が飛んでいる並び（親を読み込んでいない行など）は
 * 届いているところまでで受ける。検索の結果のように `depth` が無い並びは、そのまま 1 段の一覧になる。
 */
export function nestListItems(items: readonly ShellListItem[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const path: TreeNode[] = [];
  for (const item of items) {
    const node: TreeNode = { item, children: [] };
    path.length = Math.min(item.depth ?? 0, path.length);
    const parent = path[path.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    path.push(node);
  }
  return roots;
}

function ShellSidebarRows({ nodes, currentId, onSelect, onToggleFolder, drag, rowActions }: { nodes: TreeNode[] } & Pick<ShellSidebarProps, "currentId" | "onSelect" | "onToggleFolder"> & DragProps) {
  const rowClass = (id: string) => {
    if (!drag) return "es-dirow";
    const { dragId, over } = drag.state;
    const marks = [dragId === id ? " es-di--dragging" : "", over?.id === id ? ` es-di--drop-${over.where}` : ""].join("");
    return `es-dirow${marks}`;
  };
  return (
    <ul>
      {nodes.map(({ item, children }) => {
        const onSide = rowActions?.sideId === item.id;
        return (
        <li key={item.id}>
          <div
            className={rowClass(item.id)}
            draggable={drag || rowActions ? true : undefined}
            onDragStart={
              drag || rowActions
                ? (event) => {
                    if (drag) event.dataTransfer?.setData("text/plain", item.id);
                    // 本文へ落とす（右に並べる・ここで開く）ためのページ用の型。並べ替え（move）と両方を許す
                    if (rowActions) event.dataTransfer?.setData(SHELL_DND.page, item.id);
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = rowActions ? "copyMove" : "move";
                    drag?.onStart(item.id);
                  }
                : undefined
            }
            onContextMenu={
              rowActions
                ? (event) => {
                    event.preventDefault();
                    rowActions.onMenu(item.id, { x: event.clientX, y: event.clientY }, event.currentTarget.querySelector<HTMLElement>(".es-di"));
                  }
                : undefined
            }
            onDragOver={
              drag
                ? (event) => {
                    if (drag.state.dragId === null) return;
                    const target: ShellDropTarget = { id: item.id, where: dropWhere(event) };
                    if (!drag.can(target)) {
                      if (drag.state.over?.id === item.id) drag.onOver(null);
                      return;
                    }
                    event.preventDefault();
                    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                    if (drag.state.over?.id !== target.id || drag.state.over.where !== target.where) drag.onOver(target);
                  }
                : undefined
            }
            onDragLeave={
              drag
                ? (event) => {
                    const next = event.relatedTarget as Node | null;
                    if (next && event.currentTarget.contains(next)) return;
                    if (drag.state.over?.id === item.id) drag.onOver(null);
                  }
                : undefined
            }
            onDrop={
              drag
                ? (event) => {
                    if (drag.state.dragId === null) return;
                    const target: ShellDropTarget = { id: item.id, where: dropWhere(event) };
                    event.preventDefault();
                    if (drag.can(target)) drag.onDrop(target);
                    drag.onEnd();
                  }
                : undefined
            }
            onDragEnd={drag ? () => drag.onEnd() : undefined}
          >
            {item.folder && onToggleFolder && (
              <button
                type="button"
                className="es-ditw"
                aria-label={`${item.title || "無題"} の中`}
                aria-expanded={item.open ?? false}
                onClick={() => onToggleFolder(item.id)}
              >
                <span aria-hidden="true">{item.open ? "▾" : "▸"}</span>
              </button>
            )}
            <button
              type="button"
              className={`es-di${item.id === currentId ? " es-di--on" : ""}${item.sub || item.busy || onSide ? "" : " es-di--one"}`}
              aria-current={item.id === currentId ? "page" : undefined}
              onClick={(event) => (event.altKey && rowActions ? rowActions.onOpenSide(item.id) : onSelect?.(item.id))}
              onKeyDown={
                rowActions
                  ? (event) => {
                      if (event.key === "Enter" && event.altKey) {
                        event.preventDefault();
                        rowActions.onOpenSide(item.id);
                      } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
                        event.preventDefault();
                        const box = event.currentTarget.getBoundingClientRect();
                        rowActions.onMenu(item.id, { x: box.left + 12, y: box.bottom + 4 }, event.currentTarget);
                      }
                    }
                  : undefined
              }
            >
              <span className={`es-di-t${item.title ? "" : " es-di-t--untitled"}`}>{item.title || "無題"}</span>
              <span className="es-when">{item.when}</span>
              {(item.sub || item.busy || onSide) && (
                <span className="es-di-sub">
                  {/* 手順が動いている行の回るマーク。状態の言葉は sub の文字が持つので、マークは支援技術から隠す */}
                  {item.busy && <i className="es-busy" aria-hidden="true" />}
                  {item.sub?.dest && <i className={`es-dest es-dest--${item.sub.dest}`} aria-hidden="true" />}
                  {item.sub?.text}
                  {onSide && <em className="es-di-side">右に表示中</em>}
                </span>
              )}
            </button>
          </div>
          {children.length > 0 && <ShellSidebarRows nodes={children} currentId={currentId} onSelect={onSelect} onToggleFolder={onToggleFolder} drag={drag} rowActions={rowActions} />}
        </li>
        );
      })}
    </ul>
  );
}

/**
 * 左の一覧。上は「一覧をしまう」と、行のボタン「検索」「新しいページ」だけ。絞り込み（すべて／公開中／録音）は持たない。
 * `onDrop` を渡すと、行をドラッグしてフォルダへ入れる・並べ替える。
 * 1行は題名と時刻。2行目は公開先・録音・作成中のときだけ。下は本人の行ひとつ。
 * 一覧は 1 本の木（フォルダ＝子を持てるページ）。段は `items` の `depth` が決め、開閉の状態は呼ぶ側が持つ。
 */
export function ShellSidebar({ items, currentId, onSelect, onToggleFolder, onCollapse, newMenu, search, onDrop, canDrop, listEnd, recent, photos, side, panel, me }: ShellSidebarProps) {
  const newButton = useRef<HTMLButtonElement | null>(null);
  const meButton = useRef<HTMLButtonElement | null>(null);
  const panelButton = useRef<HTMLButtonElement | null>(null);
  const rowMenuTrigger = useRef<HTMLElement | null>(null);
  // 行の右クリックのメニュー（どの行か・どこに出すか）と、「一覧のメニュー」
  const [rowMenu, setRowMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [panelMenu, setPanelMenu] = useState(false);
  const rowActions: RowActions | undefined = side
    ? {
        sideId: side.id,
        onOpenSide: side.onOpen,
        onMenu: (id, at, trigger) => {
          rowMenuTrigger.current = trigger;
          setRowMenu({ id, ...at });
        },
      }
    : undefined;
  const rowMenuItems = (id: string): ShellMenuItem[] => {
    const open: ShellMenuItem = { id: "open", label: "開く", icon: "doc" };
    if (id === currentId) return [open];
    if (id === side?.id) return [open, { id: "close-side", label: "右を閉じる", icon: "x" }];
    return [open, { id: "side", label: "右に並べて開く", icon: "panel", hint: "⌥クリック" }];
  };
  const pickRowMenu = (id: string, choice: string) => {
    setRowMenu(null);
    // メニューの項目は消えるので、フォーカスは行へ戻す（開いたページ・右のページへ移るのはそのあと）
    rowMenuTrigger.current?.focus();
    if (choice === "open") onSelect?.(id);
    else if (choice === "side") side?.onOpen(id);
    else if (choice === "close-side") side?.onClose();
  };
  const otherDock: ShellDockSide | null = panel ? (panel.at === "left" ? "right" : "left") : null;
  const [dragState, setDragState] = useState<DragState>({ dragId: null, over: null });
  const drag: DragProps["drag"] = onDrop
    ? {
        state: dragState,
        onStart: (id) => setDragState({ dragId: id, over: null }),
        onOver: (over) => setDragState((current) => ({ ...current, over })),
        onDrop: (target) => {
          const dragId = dragState.dragId;
          if (dragId !== null && dragId !== target.id) onDrop(dragId, target);
        },
        onEnd: () => setDragState({ dragId: null, over: null }),
        can: (target) => {
          const dragId = dragState.dragId;
          if (dragId === null || dragId === target.id) return false;
          return canDrop ? canDrop(dragId, target) : true;
        },
      }
    : undefined;
  return (
    <aside className="es-sb" aria-label="ページ">
      <div
        className="es-sb-top"
        draggable={panel && !search?.open ? true : undefined}
        onDragStart={
          panel && !search?.open
            ? (event) => {
                if (!event.dataTransfer) return;
                event.dataTransfer.setData(SHELL_DND.list, "list");
                event.dataTransfer.effectAllowed = "move";
              }
            : undefined
        }
      >
        {search?.open ? (
          <div className="es-sb-find" role="search">
            <Icon name="search" />
            <input
              type="search"
              placeholder="ページを探す"
              aria-label="ページを探す"
              value={search.value}
              onChange={(event) => search.onChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") search.onClose();
              }}
              autoFocus
            />
            <button type="button" className="es-ib es-ib--sm" aria-label="やめる" onClick={search.onClose}>
              <span aria-hidden="true">×</span>
            </button>
          </div>
        ) : (
          <>
            {panel && (
              <span className="es-grip" aria-hidden="true" title="ドラッグでドックを移す">
                <Icon name="grip" />
              </span>
            )}
            <span className="es-sp" />
            {panel && otherDock && (
              <span className="es-newwrap">
                <button
                  ref={panelButton}
                  type="button"
                  className="es-ib"
                  aria-label="一覧のメニュー"
                  title="一覧のメニュー"
                  aria-haspopup="menu"
                  aria-expanded={panelMenu}
                  onClick={() => setPanelMenu((open) => !open)}
                >
                  <Icon name="more" />
                </button>
                {panelMenu && (
                  <ShellMenu
                    label="一覧のメニュー"
                    className="es-menu--right"
                    items={[{ id: otherDock, label: `${otherDock === "left" ? "左" : "右"}のドックへ移す`, icon: otherDock === "left" ? "side" : "panel" }]}
                    trigger={panelButton}
                    onSelect={(id) => {
                      setPanelMenu(false);
                      panel.onMove(id as ShellDockSide);
                    }}
                    onClose={() => setPanelMenu(false)}
                  />
                )}
              </span>
            )}
            {onCollapse && (
              <button type="button" className="es-ib" aria-label="一覧をしまう" title="一覧をしまう" onClick={onCollapse}>
                <Icon name="side" />
              </button>
            )}
          </>
        )}
      </div>
      {(search || newMenu) && (
        <div className="es-sb-acts">
          {search && !search.open && (
            <button type="button" className="es-sb-act" onClick={search.onOpen}>
              <Icon name="search" />
              検索
              <kbd aria-hidden="true">⌘K</kbd>
            </button>
          )}
          {newMenu && (
            <span className="es-newwrap">
              <button ref={newButton} type="button" className="es-sb-act" aria-haspopup="menu" aria-expanded={newMenu.open} onClick={newMenu.onToggle}>
                <Icon name="plus" />
                新しいページ
                <kbd aria-hidden="true">⌘N</kbd>
              </button>
              {newMenu.open && <NewPageMenu trigger={newButton} onPick={newMenu.onPick} onClose={newMenu.onClose} />}
            </span>
          )}
        </div>
      )}
      <nav className="es-sb-list" aria-label="ページの一覧">
        {recent && (
          <div className="es-sb-group">
            <button type="button" className="es-sb-grouphd" aria-expanded={recent.open} onClick={recent.onToggle}>
              <span aria-hidden="true">{recent.open ? "▾" : "▸"}</span>
              最近
            </button>
            {recent.open && <ShellSidebarRows nodes={nestListItems(recent.items)} currentId={currentId} onSelect={onSelect} />}
          </div>
        )}
        <ShellSidebarRows nodes={nestListItems(items)} currentId={currentId} onSelect={onSelect} onToggleFolder={onToggleFolder} drag={drag} rowActions={rowActions} />
        {listEnd}
      </nav>
      {rowMenu && side && (
        <ShellMenu
          label="ページのメニュー"
          className="es-menu--at"
          style={{ left: Math.max(8, Math.min(rowMenu.x, window.innerWidth - 240)), top: Math.max(8, Math.min(rowMenu.y, window.innerHeight - 130)) }}
          items={rowMenuItems(rowMenu.id)}
          trigger={rowMenuTrigger}
          onSelect={(choice) => pickRowMenu(rowMenu.id, choice)}
          onClose={() => setRowMenu(null)}
        />
      )}
      {photos}
      <div className="es-sb-foot">
        {/* 左下は「設定」。1 人しか使わないアプリで一番良い場所を名前が占める理由がないので、名前はメニューの中に出す（#37 T9） */}
        <button
          ref={meButton}
          type="button"
          className={`es-sb-me${me.open || me.current ? " es-sb-me--on" : ""}`}
          aria-haspopup="menu"
          aria-expanded={me.open}
          onClick={me.onToggle}
        >
          <span className="es-av" aria-hidden="true">
            {me.initial}
          </span>
          <span className="es-sb-who">
            <b>設定</b>
          </span>
          {me.badge ? (
            <em className="es-badge" aria-label={`未処理の招待 ${me.badge} 件`}>
              {me.badge}
            </em>
          ) : null}
          <span className="es-cv" aria-hidden="true">
            ▾
          </span>
        </button>
        {me.open && <ShellMenu label="アカウント" className="es-menu--up" items={me.items} trigger={meButton} onSelect={me.onSelect} onClose={me.onClose} />}
      </div>
    </aside>
  );
}
