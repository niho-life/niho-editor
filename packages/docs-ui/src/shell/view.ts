import { createContext } from "react";

/** EditorShell が今出している画面。list は一覧（900px 未満では全画面で、ページとレールは隠れる）、rail は右のレール、page はページ。 */
export type ShellView = "list" | "rail" | "page";

/** EditorShell が値を入れる。枠の外（null）では、ShellRail は従来どおり（隠れているかどうかを知らない）。 */
export const ShellViewContext = createContext<ShellView | null>(null);

/**
 * EditorShell が値を入れる。true のあいだ、一覧（ShellSidebar）が上の 1 行の左にアプリ名を出す（一覧が枠の左上にあるとき。枠はアプリ名の帯を出さない）。
 * 枠の外（false）では一覧はアプリ名を出さない。
 */
export const ShellListBrandContext = createContext(false);
