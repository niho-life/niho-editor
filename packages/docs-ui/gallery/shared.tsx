import { useMemo, useState, type ReactNode } from "react";
import { ShellSidebar, type ShellListItem, type ShellSettingsLink } from "../src/shell";
import { DEST, ME, PAGES, byId, isPublished, type GalleryPage } from "./data";

export const navigate = (route: string) => {
  window.location.hash = `#/${route}`;
};
export const isNarrow = () => window.matchMedia("(max-width:900px)").matches;

/** 左の一覧の行（モックの sidebar()）。2 行目は公開先・録音・作成中のときだけ。 */
export function listItems(extraNew: boolean): ShellListItem[] {
  const sub = (page: GalleryPage): ShellListItem["sub"] =>
    isPublished(page) && page.pub
      ? { text: DEST[page.pub.dest].label, dest: page.pub.dest }
      : page.pub
        ? { text: "公開をやめた" }
        : page.kind === "rec"
          ? { text: "録音" }
          : page.st === "run"
            ? { text: "作成中…" }
            : undefined;
  const item = (page: GalleryPage, depth?: 1): ShellListItem => ({ id: page.id, title: page.title, when: page.saved, depth, sub: sub(page) });
  const rows = PAGES.filter((page) => !page.parent).flatMap((page) => [
    { ...item(page), folder: (page.children ?? []).length > 0, open: true },
    ...(page.children ?? []).flatMap((childId) => {
      const child = byId(childId);
      return child ? [item(child, 1)] : [];
    }),
  ]);
  return extraNew ? [{ id: "new", title: "", when: "たった今" }, ...rows] : rows;
}

/** 発信先・役割とつながり・設定のページで使う左の一覧（ページは選ばれていない。左下の「設定」に現在地を示す）。 */
export function useSettingsSidebar(forced: boolean | undefined, pendingInvites: number): { sidebar: ReactNode; sidebarOpen: boolean; setSidebarOpen: (open: boolean) => void; settings: ShellSettingsLink } {
  const [sidebarOpen, setSidebarOpen] = useState(forced ?? !isNarrow());
  const [newMenu, setNewMenu] = useState(false);
  const [search, setSearch] = useState({ open: false, value: "" });
  const items = useMemo(() => listItems(false), []);
  const query = search.value.trim();
  const shown = query ? items.filter((item) => item.title.includes(query)) : items;
  const sidebar = (
    <ShellSidebar
      items={shown}
      onSelect={(itemId) => navigate(`page:${itemId}`)}
      onCollapse={() => setSidebarOpen(false)}
      newMenu={{
        open: newMenu,
        onToggle: () => setNewMenu((v) => !v),
        onClose: () => setNewMenu(false),
        onPick: (kind) => navigate(kind === "recording" ? "newrec" : "new"),
      }}
      search={{
        open: search.open,
        value: search.value,
        onOpen: () => setSearch({ open: true, value: "" }),
        onClose: () => setSearch({ open: false, value: "" }),
        onChange: (value) => setSearch({ open: true, value }),
      }}
    />
  );
  // 左下の「設定」（枠が出す。設定の画面なので現在地）
  const settings: ShellSettingsLink = { badge: pendingInvites || undefined, current: true, onOpen: () => navigate("settings") };
  return { sidebar, sidebarOpen, setSidebarOpen, settings };
}
