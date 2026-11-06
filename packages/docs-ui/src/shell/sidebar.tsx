import { useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import { ShellBrand } from "./brand";
import { SHELL_DND } from "./dock-layout";
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
  /** 上の 1 行の右端の「一覧をしまう」。 */
  onCollapse?: () => void;
  /** 上の 1 行の「＋」（空のページ／録音から／フォルダ のメニュー）。 */
  newMenu?: {
    open: boolean;
    onToggle: () => void;
    onClose: () => void;
    onPick: (kind: NewPageKind) => void;
    /** 出す項目（既定は 空のページ・録音から・フォルダ）。 */
    kinds?: readonly NewPageKind[];
    /** 開いているページがフォルダか、フォルダの中のとき、そのフォルダ（メニューの上に「『◯◯』の中に」）。 */
    inside?: { title: string } | null;
  };
  /** 上の 1 行の「検索」。押すとその行が検索欄に変わる。 */
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
   * ⌥クリック・行で ⌥Enter で右に並べる。メニューからは並べない（オーナー決定 2026-11-06。⌥クリックとドラッグに任せる）。
   * id は今右に並べているページ（その行に「右に表示中」と出す）。
   */
  side?: { id?: string; onOpen: (id: string) => void };
  /**
   * 行の「…」・右クリック（ContextMenu キー・Shift+F10 でも）の「削除」。渡したときだけ「…」とメニューを出す（狭い幅でも渡す）。
   * 確認は呼ぶ側が出す（ゴミ箱に 30 日。ヘッダーの「…」の削除と同じ）。
   */
  onDeleteRow?: (id: string) => void;
  /** true なら上の 1 行（掴む所 ⋮⋮）を掴んで一覧のパネルをドックへ移せる（設計 §5.5。デスクトップだけ）。移すメニューは無い（ドラッグだけ）。 */
  panel?: boolean;
  /** 左下の「設定」（押すとすぐ設定の一覧へ。メニューは無い）。 */
  me: {
    /** 未処理の招待の数（0 より大きいときだけバッジ）。 */
    badge?: number;
    /** 設定の画面を開いているとき（aria-current="page"）。 */
    current?: boolean;
    onOpen: () => void;
  };
};

/** ドロップの位置。into はその行（フォルダ）の中へ、before / after はその行の前・後（同じ階層）。 */
export type ShellDropTarget = { id: string; where: "before" | "after" | "into" };

/** ドラッグの状態（どの行を動かしているか・どこに印を出すか）。 */
type DragState = { dragId: string | null; over: ShellDropTarget | null };

/** 行の操作（ShellSidebarProps.side・onDeleteRow から作る）。 */
type RowActions = {
  sideId?: string;
  /** 今メニューを開いている行（その行の「…」を aria-expanded にする）。 */
  menuId?: string;
  /** 右に並べる（⌥クリック・⌥Enter・本文へのドラッグ）。side を渡したときだけ。 */
  onOpenSide?: (id: string) => void;
  /** 「…」と右クリックのメニューを出すか（onDeleteRow を渡したときだけ）。 */
  menu: boolean;
  onMenu: (id: string, at: { x: number; y: number }, trigger: HTMLElement | null) => void;
  onMenuClose: () => void;
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
  const sideOpen = rowActions?.onOpenSide;
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
            draggable={drag || sideOpen ? true : undefined}
            onDragStart={
              drag || sideOpen
                ? (event) => {
                    if (drag) event.dataTransfer?.setData("text/plain", item.id);
                    // 本文へ落とす（右に並べる・ここで開く）ためのページ用の型。並べ替え（move）と両方を許す
                    if (sideOpen) event.dataTransfer?.setData(SHELL_DND.page, item.id);
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = sideOpen ? "copyMove" : "move";
                    drag?.onStart(item.id);
                  }
                : undefined
            }
            onContextMenu={
              rowActions?.menu
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
            {item.folder && onToggleFolder && item.empty === true && (
              // 中身の無いフォルダ: 開閉は押せない。幅だけ取って、中身のあるフォルダと題名の位置を揃える
              <span className="es-ditw es-ditw--none" aria-hidden="true">
                ▾
              </span>
            )}
            {item.folder && onToggleFolder && item.empty !== true && (
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
              onClick={(event) => (event.altKey && sideOpen ? sideOpen(item.id) : onSelect?.(item.id))}
              onKeyDown={
                rowActions
                  ? (event) => {
                      if (event.key === "Enter" && event.altKey && sideOpen) {
                        event.preventDefault();
                        sideOpen(item.id);
                      } else if (rowActions.menu && (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) {
                        event.preventDefault();
                        const box = event.currentTarget.getBoundingClientRect();
                        rowActions.onMenu(item.id, { x: box.left + 12, y: box.bottom + 4 }, event.currentTarget);
                      }
                    }
                  : undefined
              }
            >
              <span className={`es-di-t${item.title ? "" : " es-di-t--untitled"}${item.icon ? ` es-di-t--${item.icon}` : ""}`}>
                {item.icon && <Icon name={item.icon} className="es-di-ki" />}
                {item.title || "無題"}
              </span>
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
            {rowActions?.menu && (
              // 行の「…」（中身は「削除」だけ）。右クリックを知らない人・iPad の入り口。ふだんは隠し、行に乗る・フォーカスすると出す（触れる端末では常に出す）
              <button
                type="button"
                className="es-ib es-ib--sm es-di-more"
                aria-label={`${item.title || "無題"} のメニュー`}
                aria-haspopup="menu"
                aria-expanded={rowActions.menuId === item.id}
                onClick={(event) => {
                  // 開いているときにもう一度押すと閉じる（外のクリックとしては閉じない。menu.tsx の useMenuDismiss）
                  if (rowActions.menuId === item.id) return rowActions.onMenuClose();
                  const box = event.currentTarget.getBoundingClientRect();
                  rowActions.onMenu(item.id, { x: box.left, y: box.bottom + 4 }, event.currentTarget);
                }}
              >
                <Icon name="more" />
              </button>
            )}
          </div>
          {children.length > 0 && <ShellSidebarRows nodes={children} currentId={currentId} onSelect={onSelect} onToggleFolder={onToggleFolder} drag={drag} rowActions={rowActions} />}
        </li>
        );
      })}
    </ul>
  );
}

/**
 * 左の一覧。上は 1 行: [掴む所（panel）] [アプリ名] …… [検索] [＋] [一覧をしまう]（検索を押すとその行が検索欄に変わる）。
 * 絞り込み（すべて／公開中／録音）は持たない。`onDrop` を渡すと、行をドラッグしてフォルダへ入れる・並べ替える。
 * 1行は題名と時刻。2行目は公開先・録音・作成中のときだけ。行の「…」は「削除」だけ（`onDeleteRow`）。
 * 下は「設定」の直リンクひとつ（発信先・役割とつながり・ログアウトは設定の一覧の中。オーナー決定 2026-11-06）。
 * 一覧は 1 本の木（フォルダ＝`kind = 'folder'` の入れ物。空でも開閉の場所を取る）。段は `items` の `depth` が決め、開閉の状態は呼ぶ側が持つ。
 */
export function ShellSidebar({ items, currentId, onSelect, onToggleFolder, onCollapse, newMenu, search, onDrop, canDrop, listEnd, recent, photos, side, onDeleteRow, panel, me }: ShellSidebarProps) {
  const newButton = useRef<HTMLButtonElement | null>(null);
  const rowMenuTrigger = useRef<HTMLElement | null>(null);
  // 行の「…」・右クリックのメニュー（どの行か・どこに出すか）
  const [rowMenu, setRowMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const rowActions: RowActions | undefined =
    side || onDeleteRow
      ? {
          sideId: side?.id,
          menuId: rowMenu?.id,
          onOpenSide: side?.onOpen,
          menu: Boolean(onDeleteRow),
          onMenu: (id, at, trigger) => {
            rowMenuTrigger.current = trigger;
            setRowMenu({ id, ...at });
          },
          onMenuClose: () => setRowMenu(null),
        }
      : undefined;
  const rowMenuItems: ShellMenuItem[] = [{ id: "delete", label: "削除", icon: "trash", danger: true }];
  const pickRowMenu = (id: string, choice: string) => {
    setRowMenu(null);
    // メニューの項目は消えるので、フォーカスは行へ戻す（確認のシートが開くのはそのあと）
    rowMenuTrigger.current?.focus();
    if (choice === "delete") onDeleteRow?.(id);
  };
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
            <ShellBrand />
            <span className="es-sp" />
            {search && (
              <button type="button" className="es-ib" aria-label="検索（⌘K）" title="検索（⌘K）" onClick={search.onOpen}>
                <Icon name="search" />
              </button>
            )}
            {newMenu && (
              <span className="es-newwrap">
                <button
                  ref={newButton}
                  type="button"
                  className="es-ib"
                  aria-label="新しいページ（⌘N）"
                  title="新しいページ（⌘N）"
                  aria-haspopup="menu"
                  aria-expanded={newMenu.open}
                  onClick={newMenu.onToggle}
                >
                  <Icon name="plus" />
                </button>
                {newMenu.open && <NewPageMenu trigger={newButton} onPick={newMenu.onPick} onClose={newMenu.onClose} kinds={newMenu.kinds} inside={newMenu.inside} />}
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
      {rowMenu && onDeleteRow && (
        <ShellMenu
          label="ページのメニュー"
          className="es-menu--at"
          style={{ left: Math.max(8, Math.min(rowMenu.x, window.innerWidth - 240)), top: Math.max(8, Math.min(rowMenu.y, window.innerHeight - 80)) }}
          items={rowMenuItems}
          trigger={rowMenuTrigger}
          onSelect={(choice) => pickRowMenu(rowMenu.id, choice)}
          onClose={() => setRowMenu(null)}
        />
      )}
      {photos}
      <div className="es-sb-foot">
        {/* 左下は「設定」の直リンク。押すとすぐ設定の一覧（メニューは無い。オーナー決定 2026-11-06） */}
        <button type="button" className="es-sb-me" aria-current={me.current ? "page" : undefined} onClick={me.onOpen}>
          <Icon name="gear" />
          <b>設定</b>
          {me.badge && me.badge > 0 ? (
            <em className="es-badge" aria-label={`未処理の招待 ${me.badge} 件`}>
              {me.badge}
            </em>
          ) : null}
        </button>
      </div>
    </aside>
  );
}
