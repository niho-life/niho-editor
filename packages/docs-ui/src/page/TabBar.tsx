import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "../shell/icons";
import { ShellMenu } from "../shell/menu";
import type { ShellMenuItem } from "../shell/types";

/**
 * タブの帯（#308。モック docs/mockups/editor-folder-pages-v1.html の .tabbar。Mac・Web で共通。Tauri-free）。
 *
 * ページ名の上、本文のコンテンツ幅いっぱいの薄い罫線。右端に ＋（まっさらなタブをすぐ足す）。
 * タブが 2 つ以上あるときだけ、左にタブの名前を並べる（押すとそのタブへ移る。開いているタブは `aria-current`。
 * 画面が替わる「タブ」なので WAI-ARIA の tablist/tab にはしない: tablist は ▾ のようなほかの部品を中に持てない）。
 * 開いているタブの右に ▾（メニュー: 名前を変える・複製・並べて開く・別のページへ移す・削除）。
 * 「作り直す」「同じ入力でもう 1 つ」は手順（#309）が足す。
 * 通信・保存は持たない（アプリの側が持つ。名前の欄はその場で開き、Enter で `onRename`）。
 */

/** 帯の 1 つのタブ（本文は持たない）。`label` は付けた名前か入れ物の中の位置の番号（editor-store の `tabLabel`）。 */
export type PageTab = { id: string; label: string; /** 手順が動いている（回るマーク）。 */ busy?: boolean };

/** 「別のページへ移す」の入れ先（同じフォルダのほかのページ）。 */
export type PageTabMoveTarget = { id: string; title: string };

/** 開いているタブの ▾ の操作。渡さなければ ▾ を出さない。 */
export type PageTabActions = {
  /** 名前を変える（空は「名前なし」＝位置の番号で呼ぶ）。 */
  onRename: (name: string) => void;
  onDuplicate: () => void;
  /** 並べて開く（デスクトップだけ渡す）。ほかのタブが 1 つ以上あるときだけ項目を出す（1 つ目のほかのタブを右に）。 */
  onSplit?: (otherId: string) => void;
  /** 別のページへ移す（入れ先が 1 つ以上あるときだけ項目を出す）。 */
  moveTargets?: readonly PageTabMoveTarget[];
  onMove?: (targetId: string) => void;
  /** 削除（ゴミ箱に 30 日。確認は呼ぶ側）。 */
  onDelete: () => void;
};

export type TabBarProps = {
  tabs: readonly PageTab[];
  currentId: string;
  onOpen: (id: string) => void;
  /** ＋（まっさらなタブを足す）。 */
  onAdd: () => void;
  /** 足している・送っている間（＋を押せなくする）。 */
  busy?: boolean;
  actions?: PageTabActions;
};

export const TAB_BAR_TEXT = {
  list: "タブ",
  add: "タブを足す",
  menu: (label: string) => `タブ「${label}」のメニュー`,
  menuLabel: "タブのメニュー",
  rename: "名前を変える",
  nameField: "タブの名前",
  duplicate: "複製",
  split: "並べて開く",
  move: "別のページへ移す",
  remove: "削除",
  removeHint: "ゴミ箱に 30 日",
  untitled: "無題",
} as const;

const MOVE_PREFIX = "to:";

export function TabBar({ tabs, currentId, onOpen, onAdd, busy = false, actions }: TabBarProps) {
  const [menu, setMenu] = useState<"main" | "move" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const menuButton = useRef<HTMLButtonElement | null>(null);
  // 名前の欄は Enter と欄を離れたときの両方で閉じるので、1 回だけ送る
  const committed = useRef(false);
  // 別のタブへ替わったら、開いていたメニュー・名前の欄は閉じる
  useEffect(() => {
    setMenu(null);
    setRenaming(false);
  }, [currentId]);

  const current = tabs.find((tab) => tab.id === currentId);
  const others = tabs.filter((tab) => tab.id !== currentId);
  const moveTargets = actions?.moveTargets ?? [];
  const items: ShellMenuItem[] = [
    { id: "rename", label: TAB_BAR_TEXT.rename, icon: "edit" },
    { id: "duplicate", label: TAB_BAR_TEXT.duplicate, icon: "copy" },
    ...(actions?.onSplit && others[0] ? [{ id: "split", label: TAB_BAR_TEXT.split, icon: "side" as const, hint: others[0].label }] : []),
    ...(actions?.onMove && moveTargets.length > 0 ? [{ id: "move", label: TAB_BAR_TEXT.move, icon: "doc" as const }] : []),
    { id: "delete", label: TAB_BAR_TEXT.remove, icon: "trash", danger: true, hint: TAB_BAR_TEXT.removeHint, separated: true },
  ];
  const pick = (id: string) => {
    if (id === "move") {
      setMenu("move");
      return;
    }
    setMenu(null);
    if (id === "rename") {
      committed.current = false;
      setRenaming(true);
      return;
    }
    // 項目は消えるので、フォーカスは ▾ へ戻す（確認のシートが開くのはそのあと）
    menuButton.current?.focus();
    if (id === "duplicate") actions?.onDuplicate();
    else if (id === "split" && others[0]) actions?.onSplit?.(others[0].id);
    else if (id === "delete") actions?.onDelete();
  };
  const commitName = (value: string) => {
    if (committed.current) return;
    committed.current = true;
    setRenaming(false);
    const name = value.trim();
    if (current && name !== current.label) actions?.onRename(name);
  };
  const cancelName = () => {
    committed.current = true;
    setRenaming(false);
    menuButton.current?.focus();
  };
  // ← → でタブの間を動く（開くのは Enter・クリック）
  const onListKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".es-tab")];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    buttons[(at + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };

  return (
    <div className="es-tabbar">
      {tabs.length >= 2 && (
        <div className="es-tabbar-tabs" role="group" aria-label={TAB_BAR_TEXT.list} onKeyDown={onListKey}>
          {tabs.map((tab) => {
            const on = tab.id === currentId;
            return (
              <span key={tab.id} className={`es-tab-w${on ? " es-tab-w--on" : ""}`}>
                {on && renaming ? (
                  <input
                    className="es-tab-name"
                    aria-label={TAB_BAR_TEXT.nameField}
                    defaultValue={tab.label}
                    maxLength={100}
                    autoFocus
                    onFocus={(event) => event.currentTarget.select()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitName(event.currentTarget.value);
                        menuButton.current?.focus();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        cancelName();
                      }
                    }}
                    onBlur={(event) => commitName(event.currentTarget.value)}
                  />
                ) : (
                  <button type="button" className="es-tab" aria-current={on ? "true" : undefined} onClick={() => onOpen(tab.id)}>
                    {/* 手順が動いている印。状態の言葉はページの側（パネル）が持つので、マークは支援技術から隠す */}
                    {tab.busy && <i className="es-busy" aria-hidden="true" />}
                    {tab.label}
                  </button>
                )}
                {on && actions && !renaming && (
                  <button
                    ref={menuButton}
                    type="button"
                    className="es-tab-menu"
                    aria-label={TAB_BAR_TEXT.menu(tab.label)}
                    aria-haspopup="menu"
                    aria-expanded={menu !== null}
                    onClick={() => setMenu((open) => (open ? null : "main"))}
                  >
                    <Icon name="down" />
                  </button>
                )}
                {on && menu === "main" && <ShellMenu label={TAB_BAR_TEXT.menuLabel} className="es-menu--tab" items={items} trigger={menuButton} onSelect={pick} onClose={() => setMenu(null)} />}
                {on && menu === "move" && (
                  <ShellMenu
                    label={TAB_BAR_TEXT.move}
                    className="es-menu--tab"
                    heading={TAB_BAR_TEXT.move}
                    items={moveTargets.map((target) => ({ id: `${MOVE_PREFIX}${target.id}`, label: target.title || TAB_BAR_TEXT.untitled, icon: "doc" as const }))}
                    trigger={menuButton}
                    onSelect={(id) => {
                      setMenu(null);
                      menuButton.current?.focus();
                      actions?.onMove?.(id.slice(MOVE_PREFIX.length));
                    }}
                    onClose={() => setMenu(null)}
                  />
                )}
              </span>
            );
          })}
        </div>
      )}
      <button type="button" className="es-tab-add" aria-label={TAB_BAR_TEXT.add} title={TAB_BAR_TEXT.add} disabled={busy || undefined} onClick={onAdd}>
        <Icon name="plus" />
      </button>
    </div>
  );
}
