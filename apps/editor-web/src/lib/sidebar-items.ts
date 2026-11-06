import type { PagePublicationSummary, PageSummary } from "@niho/editor-store";
import type { ShellDest, ShellListItem } from "niho-docs-ui/shell";
import { formatWhen } from "niho-docs-ui/page/when";
import type { SearchHit } from "./search-client";

/** 一覧の時刻は共通（packages/docs-ui の page/when.ts。Mac・Web で同じ言葉）。 */
export { formatWhen };

/**
 * タブの札（editor-store の `tabLabel` と同じ規則。画面は pg を持ち込まないので値を import しない）:
 * 付けた名前か、入れ物の中の位置の番号。タブでない行は空。
 */
export function tabLabel(tab: Pick<PageSummary, "tabName" | "tabPos">): string {
  if (tab.tabName) return tab.tabName;
  return tab.tabPos === undefined ? "" : String(tab.tabPos);
}

/** 2 行目の公開先に要るもの（#39）。一覧の行（listPageChunk の PageSummary.publication）と同じ形。 */
export type SidebarPublication = PagePublicationSummary;

/** 2 行目の発信先の名前（モック v6 の DEST と同じ）。本人のサイトは「自分のサイト」。 */
const DEST_NAMES: Readonly<Record<ShellDest, string>> = { exp: "NIHO Experience", niho: "NIHO", site: "自分のサイト" };

/** 検索の結果の行。サーバーが並べた順（更新順）のまま、当たった所の一文を 2 行目に添える。入れ子にしない。タブなら「ページ名 › タブ名」（#308）。 */
export function searchRows(hits: readonly SearchHit[], now: number): ShellListItem[] {
  return hits.map((hit) => {
    const item: ShellListItem = { id: hit.id, title: hit.tab ? `${hit.title || "無題"} › ${hit.tab}` : hit.title, when: formatWhen(hit.updatedAt, now) };
    if (hit.snippet.trim() !== "") item.sub = { text: hit.snippet };
    return item;
  });
}

/** 手順の段階の状態の言葉（#37。色・印だけでなく文字でも出す）。済みは何も出さない（ふつうのページと同じ）。 */
const STEP_SAY: Readonly<Record<string, string>> = { run: "作成中…", wait: "待機", failed: "失敗", stale: "前提変更" };

/**
 * 一覧の 1 単位（#308）: 入れ物（`kind='page'`）とその読み込んであるタブ、またはタブを持たない行（フォルダ・手順のサブページ・
 * 入れ物の無いページ・入れ物をまだ読み込んでいないタブ）。行は単位ごとに 1 つ。
 */
type Unit = { page: PageSummary; tabs: PageSummary[]; /** 渡した並びの中の最初の位置（上の段の更新順）。 */ at: number };

/** 単位の集まり: id（入れ物・タブ・ほかの行のどれでも）→ 単位、親の単位の id → 中の単位。 */
type Units = { list: Unit[]; byId: Map<string, Unit>; children: Map<string, Unit[]> };

/** タブの並び（editor-store の `#tabsOf` と同じ: 入れ物の中の位置 → 作った順 → id）。 */
function byTabPos(a: PageSummary, b: PageSummary): number {
  const pa = a.tabPos ?? Number.MAX_SAFE_INTEGER;
  const pb = b.tabPos ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 親の単位（親が入れ物のタブなら、その入れ物の単位）。親を読み込んでいなければ null。 */
function parentUnitOf(unit: Unit, byId: ReadonlyMap<string, Unit>): Unit | null {
  const parent = unit.page.parent;
  if (parent === null) return null;
  const found = byId.get(parent);
  return found && found !== unit ? found : null;
}

/**
 * 行を単位にまとめる。タブ（`page` が読み込んである入れ物を指す）は入れ物の単位に入れ、行にしない。
 * 入れ物を読み込んでいないタブは、それ自身を 1 単位にする（行が消えない。入れ物が読み込まれたら合流する）。
 */
function unitsOf(pages: readonly PageSummary[]): Units {
  const rows = new Map(pages.map((page) => [page.id, page]));
  const holderOf = (page: PageSummary): string | null => {
    const holder = page.page ? rows.get(page.page) : undefined;
    return holder && holder.kind === "page" ? holder.id : null;
  };
  const byId = new Map<string, Unit>();
  const list: Unit[] = [];
  pages.forEach((page, at) => {
    if (holderOf(page) !== null) return;
    const unit: Unit = { page, tabs: [], at };
    list.push(unit);
    byId.set(page.id, unit);
  });
  pages.forEach((page, at) => {
    const holder = holderOf(page);
    if (holder === null) return;
    const unit = byId.get(holder)!;
    unit.tabs.push(page);
    unit.at = Math.min(unit.at, at);
    byId.set(page.id, unit);
  });
  for (const unit of list) unit.tabs.sort(byTabPos);
  const children = new Map<string, Unit[]>();
  for (const unit of list) {
    const parent = parentUnitOf(unit, byId);
    // 親子が壊れている行（親を辿ると自分に戻る）は上の段に出す（中に入れない）
    if (parent === null || loops(unit, byId)) continue;
    const under = children.get(parent.page.id) ?? [];
    under.push(unit);
    children.set(parent.page.id, under);
  }
  return { list, byId, children };
}

/** 親を辿ると自分に戻る（壊れた親子）。親を読み込んでいないところで止まるのは循環ではない。 */
function loops(unit: Unit, byId: ReadonlyMap<string, Unit>): boolean {
  const seen = new Set([unit]);
  for (let at = parentUnitOf(unit, byId); at !== null; at = parentUnitOf(at, byId)) {
    if (seen.has(at)) return true;
    seen.add(at);
  }
  return false;
}

/** 単位の中の行（入れ物とタブ、または 1 行）。2 行目・印・時刻はこの中で見る。 */
const rowsOf = (unit: Unit): PageSummary[] => [unit.page, ...unit.tabs];

/**
 * 2 行目（モック v6 の sidebar の sub と同じ順）: 公開中（限定公開を含む）は発信先の名前と印、公開をやめたページは「公開をやめた」、
 * 手順の段階は状態（作成中…・待機・失敗・前提変更）。それ以外は出さない（録音の「録音」はマイクの印で足りる。オーナー決定 2026-11-06）。
 * 入れ物の行はタブのどれかの公開・状態。
 */
function subOf(unit: Unit): ShellListItem["sub"] {
  const rows = rowsOf(unit);
  const live = rows.find((row) => row.publication && !row.publication.stopped)?.publication;
  if (live) return { text: DEST_NAMES[live.dest], dest: live.dest };
  if (rows.some((row) => row.publication?.stopped)) return { text: "公開をやめた" };
  const status = rows.find((row) => row.stepStatus !== null && STEP_SAY[row.stepStatus] !== undefined)?.stepStatus;
  return status ? { text: STEP_SAY[status]! } : undefined;
}

/** 題名の前のアイコン（フォルダ・録音・工程のサブページの ✦）。入れ物は、タブに録音があれば録音。ほかの種類は出さない。 */
function iconOf(unit: Unit): ShellListItem["icon"] {
  const kind = unit.page.kind;
  if (kind === "folder") return "folder";
  if (kind === "step") return "spark";
  return rowsOf(unit).some((row) => row.kind === "rec") ? "mic" : undefined;
}

/** 単位の更新の時刻（入れ物とタブのいちばん新しいもの）。 */
function whenOf(unit: Unit): string {
  return rowsOf(unit).reduce((latest, row) => (row.updatedAt > latest ? row.updatedAt : latest), unit.page.updatedAt);
}

function rowOf(unit: Unit, now: number, depth: 0 | 1 | 2, folder: boolean, open: boolean, empty = false): ShellListItem {
  const { page } = unit;
  const item: ShellListItem = { id: page.id, title: page.title, when: formatWhen(whenOf(unit), now) };
  if (depth > 0) item.depth = depth;
  if (folder) {
    item.folder = true;
    item.open = open;
    if (empty) item.empty = true;
  }
  const icon = iconOf(unit);
  if (icon) item.icon = icon;
  // 進行中の行は回るマーク（#37）。公開中のサブページでも、作っている間は印を出す
  if (rowsOf(unit).some((row) => row.stepStatus === "run")) item.busy = true;
  const sub = subOf(unit);
  if (sub) item.sub = sub;
  // 入れ物の行: タブの id（開いているタブで今の行を決める）と数（2 つ以上で印。#308）
  if (page.kind === "page") {
    item.tabs = unit.tabs.map((tab) => tab.id);
    item.count = unit.tabs.length;
  }
  return item;
}

/**
 * 削除したページと、その子孫（読み込んである分。親を辿って届くもの）を除いた一覧。順は変えない。
 * サーバーは子孫ごとゴミ箱へ入れる（`DELETE /api/pages/{id}`）ので、一覧からも一緒に外す。
 * 入れ物を消したらそのタブも、最後のタブを消したら入れ物も外す（#307 #308）。
 */
export function withoutPageTree(pages: readonly PageSummary[], id: string): PageSummary[] {
  const removed = new Set([id]);
  const gone = pages.find((page) => page.id === id);
  // 最後のタブを消したら入れ物も（サーバーも同じ。ほかのタブをまだ読み込んでいないときも、入れ物の行は次の読み込みで戻る）
  if (gone?.page && !pages.some((page) => page.page === gone.page && page.id !== id)) removed.add(gone.page);
  // 入れ物を消したらタブも、親が先に外れていれば子も外す（並びは更新順で親子の順ではないので、外すものが増えなくなるまで繰り返す）
  for (let grew = true; grew; ) {
    grew = false;
    for (const page of pages) {
      if (removed.has(page.id)) continue;
      if ((page.parent !== null && removed.has(page.parent)) || (typeof page.page === "string" && removed.has(page.page))) {
        removed.add(page.id);
        grew = true;
      }
    }
  }
  return pages.filter((page) => !removed.has(page.id));
}

/**
 * フォルダ・録音の中の並び（editor-store の `orderOf` と同じ規則）: 手動の並びが先で、同じなら作った順。
 * ISO 8601 の UTC の文字列は文字の順が時刻の順。
 */
function byOrderThenCreated(a: Unit, b: Unit): number {
  if (a.page.sortOrder !== b.page.sortOrder) return a.page.sortOrder - b.page.sortOrder;
  if (a.page.createdAt !== b.page.createdAt) return a.page.createdAt < b.page.createdAt ? -1 : 1;
  return a.page.id < b.page.id ? -1 : a.page.id > b.page.id ? 1 : 0;
}

/**
 * 上の段の並び（editor-store の `orderOf` と同じ規則）: 手動の並びが先で、同じなら渡した順（サーバーの更新の新しい順）。
 * 並べ替えていない行（0）は上に来る＝新しく作ったページが先頭に出る。
 */
function byOrderThenGiven(a: Unit, b: Unit): number {
  if (a.page.sortOrder !== b.page.sortOrder) return a.page.sortOrder - b.page.sortOrder;
  return a.at - b.at;
}

/** 同じ親の中の並び（上の段は渡した順、中は作った順）。 */
function sortedSiblings(units: readonly Unit[], top: boolean): Unit[] {
  return units.toSorted(top ? byOrderThenGiven : byOrderThenCreated);
}

/** 木の段の上限（editor-store の `MAX_PAGE_DEPTH` と同じ。フォルダ › ページ › 録音のサブページ）。 */
const MAX_DEPTH = 2;

/**
 * サイドバーの 1 本の木（フォルダ＝`kind = 'folder'` の入れ物。docs/architecture/editor-recipes-and-folders.md §3・§4）。
 *
 * - 行はページ（入れ物 `kind = 'page'`）・フォルダ・入れ物の無い行。タブは行にせず、入れ物の行に集める（`tabs`・`count`。#308）。
 *   入れ物をまだ読み込んでいないタブは、それ自身の行で出す（消えない）。
 * - フォルダかどうかは `kind` で決める（子の有無でなく）。空のフォルダも開閉の場所を取るフォルダの行で出る（押せない）。
 * - 録音の下の工程のサブページは、いつも録音（のページ）の下に出す（録音は開閉を持たない）。
 *
 * - 並びは手動の並び（`sortOrder`）が先。同じなら上の段は渡した順（更新順）、その中の行は作った順
 *   （手順のサブページが段の順に並ぶ）。読み込んだ分の中で並べ替えるので、まだ読んでいないページは続きを読んだときに入る。
 * - 親を読み込んでいない行・親子が壊れている行は上の段に出す（行が消えない）。
 * - `collapsed` のフォルダは、中の行を出さない（`folder` の行の `open` が false になる）。
 * - 段は 2 まで（フォルダ › ページ › 録音のサブページ）。それより深い行は出さない（サーバーもその移動を断る）。
 * - 検索の結果は `searchRows`（サーバーの検索）で出す。木にしない。
 */
export function arrangeSidebarItems(pages: readonly PageSummary[], options: { now: number; collapsed?: ReadonlySet<string> }): ShellListItem[] {
  const { now, collapsed } = options;
  const units = unitsOf(pages);
  const tops = units.list.filter((unit) => parentUnitOf(unit, units.byId) === null || loops(unit, units.byId));
  const items: ShellListItem[] = [];
  const shown = new Set<Unit>();
  const walk = (unit: Unit, depth: 0 | 1 | 2): void => {
    if (shown.has(unit)) return;
    shown.add(unit);
    const under = depth < MAX_DEPTH ? sortedSiblings(units.children.get(unit.page.id) ?? [], false) : [];
    const folder = unit.page.kind === "folder";
    const open = under.length > 0 && collapsed?.has(unit.page.id) !== true;
    items.push(rowOf(unit, now, depth, folder, folder && open, folder && under.length === 0));
    if (under.length === 0 || (folder && !open)) return;
    for (const child of under) walk(child, (depth + 1) as 1 | 2);
  };
  // 手動の並び（渡した順＝更新の新しい順は、同じ並びの中でそのまま。sort は安定）
  for (const top of sortedSiblings(tops, true)) walk(top, 0);
  return items;
}

/**
 * そのページを入れられるフォルダ（「移動…」の選択肢）。上の段のフォルダ（`kind = 'folder'`）だけを出し、
 * 自分自身・自分の子孫（読み込んである分）と、入れると段が深くなりすぎるものは出さない。フォルダはどこへも入れない（空）。
 * サーバーも同じ規則で断る（`EditorStore.movePage`。深すぎる移動は `too_deep`、自分の中は `cycle`、フォルダでない入れ先は `not_folder`）。
 * id はタブでもよい（入れ物ごと動く）。
 */
export function folderOptions(pages: readonly PageSummary[], id: string): { id: string; title: string }[] {
  const units = unitsOf(pages);
  const self = units.byId.get(id);
  if (self?.page.kind === "folder") return [];
  const height = (unit: Unit, left = MAX_DEPTH): number => {
    const under = left <= 0 ? [] : (units.children.get(unit.page.id) ?? []);
    return under.length === 0 ? 0 : 1 + Math.max(...under.map((child) => height(child, left - 1)));
  };
  // 入れ先は 0 の段なので、入れたページは 1 の段。その下の高さを足して 2 を超えるなら入れられない
  if (self && 1 + height(self) > MAX_DEPTH) return [];
  const inside = new Set<Unit>(self ? [self] : []);
  for (let grew = true; grew; ) {
    grew = false;
    for (const unit of units.list) {
      const parent = parentUnitOf(unit, units.byId);
      if (parent !== null && inside.has(parent) && !inside.has(unit)) {
        inside.add(unit);
        grew = true;
      }
    }
  }
  return units.list
    .filter((unit) => unit.page.parent === null && unit.page.kind === "folder" && !inside.has(unit))
    .map((unit) => ({ id: unit.page.id, title: unit.page.title }));
}

/** そのページ（タブでもよい）と同じ階層の単位を、一覧の並びで。無ければ null。 */
function siblingsOf(pages: readonly PageSummary[], id: string): { self: Unit; sorted: Unit[] } | null {
  const units = unitsOf(pages);
  const self = units.byId.get(id);
  if (!self) return null;
  const parent = parentUnitOf(self, units.byId);
  const siblings = parent === null ? units.list.filter((unit) => parentUnitOf(unit, units.byId) === null) : (units.children.get(parent.page.id) ?? []);
  return { self, sorted: sortedSiblings(siblings, parent === null) };
}

/**
 * そのページが同じ階層の中で上へ・下へ動かせるか（情報パネルの「並び」。読み込んである行で見る）。
 * 木に出ていない行（親を読み込んでいない・段が深すぎる）は動かせない扱いにする。id はタブでもよい（入れ物ごと動く）。
 */
export function orderNeighbours(pages: readonly PageSummary[], id: string): { canUp: boolean; canDown: boolean } {
  const found = siblingsOf(pages, id);
  if (!found) return { canUp: false, canDown: false };
  const at = found.sorted.indexOf(found.self);
  return { canUp: at > 0, canDown: at >= 0 && at < found.sorted.length - 1 };
}

/**
 * そのページと同じ階層の行の id（入れ物の id。タブは入れ物に数える）を、一覧の並び（木と同じ規則）で返す。読み込んである行で見る。無ければ空。
 * 左の一覧のドラッグで、落とした位置まで 1 歩ずつ並びを動かすのに使う。
 */
export function siblingOrder(pages: readonly PageSummary[], id: string): string[] {
  const found = siblingsOf(pages, id);
  return found ? found.sorted.map((unit) => unit.page.id) : [];
}

/**
 * フォルダを開いた画面の中身（読み込んである分。サイドバーと同じ並びの規則）。フォルダの直下のページを並べ、録音の下には
 * 工程のサブページを 1 段下げて続ける。2 行目は一覧と同じ言葉。タブが 2 つ以上あるページは 2 行目にタブの名前（#308）。
 * フォルダの行を作らない（開閉も持たない）。
 */
export function folderContents(pages: readonly PageSummary[], folderId: string, now: number): ShellListItem[] {
  const units = unitsOf(pages);
  const rows: ShellListItem[] = [];
  for (const unit of sortedSiblings(units.children.get(folderId) ?? [], false)) {
    const row = rowOf(unit, now, 0, false, false);
    if (unit.tabs.length >= 2) row.sub = { text: unit.tabs.map((tab) => tabLabel(tab)).join(" · ") };
    rows.push(row);
    for (const step of sortedSiblings(units.children.get(unit.page.id) ?? [], false)) rows.push(rowOf(step, now, 1, false, false));
  }
  return rows;
}

/**
 * 開いているページの所属フォルダ（開いているのがフォルダならそれ、フォルダの直下のページならその親、工程のサブページなら
 * 録音の親）。読み込んである行で見る。上の段のページは null。
 */
export function folderOfPage(pages: readonly PageSummary[], id: string | null): PageSummary | null {
  if (id === null) return null;
  const byId = new Map(pages.map((page) => [page.id, page]));
  for (let at = byId.get(id), steps = 0; at && steps <= MAX_DEPTH; at = at.parent ? byId.get(at.parent) : undefined, steps++) {
    if (at.kind === "folder") return at;
  }
  return null;
}

/**
 * ヘッダーのパンくず（場所）。親のフォルダ › 親の録音 だけで、そのページ自身は入れない。上の段のページは空。
 */
export function locationOf(pages: readonly PageSummary[], id: string | null): { id: string; title: string; icon: "folder" | "mic" }[] {
  if (id === null) return [];
  const byId = new Map(pages.map((page) => [page.id, page]));
  const parts: { id: string; title: string; icon: "folder" | "mic" }[] = [];
  const self = byId.get(id);
  for (let at = self?.parent ? byId.get(self.parent) : undefined, steps = 0; at && steps < MAX_DEPTH; at = at.parent ? byId.get(at.parent) : undefined, steps++) {
    parts.unshift({ id: at.id, title: at.title, icon: at.kind === "folder" ? "folder" : "mic" });
  }
  return parts;
}

/** 「最近」の行（木にしない。段も開閉も持たない。行は開いたタブ）。 */
export function recentRows(pages: readonly PageSummary[], now: number): ShellListItem[] {
  return pages.map((page) => rowOf({ page, tabs: [], at: 0 }, now, 0, false, false));
}

/**
 * 並べ替えたあとの行（サーバーと同じ規則で作り直す）。同じ階層の単位を今の並びで取り、1 つ動かして 1 から振り直す。
 * 入れ物のタブにも同じ値を書く（タブの行の `sortOrder` は入れ物の並び。#307）。
 * 動かせない（もう端・木に出ていない）ときは渡した配列をそのまま返す。
 */
export function reorderedPages(pages: readonly PageSummary[], id: string, move: "up" | "down"): PageSummary[] {
  const found = siblingsOf(pages, id);
  if (!found) return [...pages];
  const at = found.sorted.indexOf(found.self);
  const to = move === "up" ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= found.sorted.length) return [...pages];
  const moved = [...found.sorted];
  [moved[at], moved[to]] = [moved[to]!, moved[at]!];
  const orders = new Map<string, number>();
  moved.forEach((unit, index) => {
    for (const row of rowsOf(unit)) orders.set(row.id, index + 1);
  });
  return pages.map((item) => {
    const order = orders.get(item.id);
    return order === undefined ? item : { ...item, sortOrder: order };
  });
}
