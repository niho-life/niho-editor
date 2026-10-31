import type { PagePublicationSummary, PageSummary } from "@niho/editor-store";
import type { ShellDest, ShellListItem } from "niho-docs-ui/shell";
import { formatWhen } from "niho-docs-ui/page/when";
import type { SearchHit } from "./search-client";

/** 一覧の時刻は共通（packages/docs-ui の page/when.ts。Mac・Web で同じ言葉）。 */
export { formatWhen };

/** 2 行目の公開先に要るもの（#39）。一覧の行（listPageChunk の PageSummary.publication）と同じ形。 */
export type SidebarPublication = PagePublicationSummary;

/** 2 行目の発信先の名前（モック v6 の DEST と同じ）。本人のサイトは「自分のサイト」。 */
const DEST_NAMES: Readonly<Record<ShellDest, string>> = { exp: "NIHO Experience", niho: "NIHO", site: "自分のサイト" };

/** 検索の結果の行。サーバーが並べた順（更新順）のまま、当たった所の一文を 2 行目に添える。入れ子にしない。 */
export function searchRows(hits: readonly SearchHit[], now: number): ShellListItem[] {
  return hits.map((hit) => {
    const item: ShellListItem = { id: hit.id, title: hit.title, when: formatWhen(hit.updatedAt, now) };
    if (hit.snippet.trim() !== "") item.sub = { text: hit.snippet };
    return item;
  });
}

/** 手順の段階の状態の言葉（#37。色・印だけでなく文字でも出す）。済みは何も出さない（ふつうのページと同じ）。 */
const STEP_SAY: Readonly<Record<string, string>> = { run: "作成中…", wait: "待機", failed: "失敗", stale: "前提変更" };

/**
 * 2 行目（モック v6 の sidebar の sub と同じ順）: 公開中（限定公開を含む）は発信先の名前と印、公開をやめたページは「公開をやめた」、
 * 録音は「録音」、手順のサブページは段階の状態（作成中…・待機・失敗・前提変更）。それ以外は出さない。
 */
function subOf(page: PageSummary): ShellListItem["sub"] {
  const publication = page.publication;
  if (publication && !publication.stopped) return { text: DEST_NAMES[publication.dest], dest: publication.dest };
  if (publication?.stopped) return { text: "公開をやめた" };
  if (page.kind === "rec") return { text: "録音" };
  const say = page.stepStatus === null ? undefined : STEP_SAY[page.stepStatus];
  return say ? { text: say } : undefined;
}

function rowOf(page: PageSummary, now: number, depth: 0 | 1 | 2, folder: boolean, open: boolean): ShellListItem {
  const item: ShellListItem = { id: page.id, title: page.title, when: formatWhen(page.updatedAt, now) };
  if (depth > 0) item.depth = depth;
  if (folder) {
    item.folder = true;
    item.open = open;
  }
  // 進行中の行は回るマーク（#37）。公開中のサブページでも、作っている間は印を出す
  if (page.stepStatus === "run") item.busy = true;
  const sub = subOf(page);
  if (sub) item.sub = sub;
  return item;
}

/** 親を辿ると自分に戻る（壊れた親子）。親を読み込んでいないところで止まるのは循環ではない。 */
function loops(page: PageSummary, byId: ReadonlyMap<string, PageSummary>): boolean {
  const seen = new Set([page.id]);
  for (let at = page; at.parent !== null; ) {
    const parent = byId.get(at.parent);
    if (!parent) return false;
    if (seen.has(parent.id)) return true;
    seen.add(parent.id);
    at = parent;
  }
  return false;
}

/**
 * 削除したページと、その子孫（読み込んである分。親を辿って届くもの）を除いた一覧。順は変えない。
 * サーバーは子孫ごとゴミ箱へ入れる（`DELETE /api/pages/{id}`）ので、一覧からも一緒に外す。
 */
export function withoutPageTree(pages: readonly PageSummary[], id: string): PageSummary[] {
  const removed = new Set([id]);
  // 親が先に外れていれば子も外す（並びは更新順で親子の順ではないので、外すものが増えなくなるまで繰り返す）
  for (let grew = true; grew; ) {
    grew = false;
    for (const page of pages) {
      if (page.parent !== null && removed.has(page.parent) && !removed.has(page.id)) {
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
function byOrderThenCreated(a: PageSummary, b: PageSummary): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 上の段の並び（editor-store の `orderOf` と同じ規則）: 手動の並びが先で、同じなら渡した順（サーバーの更新の新しい順）。
 * 並べ替えていない行（0）は上に来る＝新しく作ったページが先頭に出る。
 */
function byOrderThenGiven(a: PageSummary, b: PageSummary): number {
  return a.sortOrder - b.sortOrder;
}

/** 木の段の上限（editor-store の `MAX_PAGE_DEPTH` と同じ。フォルダ › ページ › 録音のサブページ）。 */
const MAX_DEPTH = 2;

/**
 * サイドバーの 1 本の木（フォルダ＝子を持てるページ。docs/architecture/editor-recipes-and-folders.md §3・§4）。
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
  const byId = new Map(pages.map((page) => [page.id, page]));
  const children = new Map<string, PageSummary[]>();
  const tops: PageSummary[] = [];
  for (const page of pages) {
    if (page.parent === null || !byId.has(page.parent) || loops(page, byId)) {
      tops.push(page);
      continue;
    }
    const list = children.get(page.parent) ?? [];
    list.push(page);
    children.set(page.parent, list);
  }
  const items: ShellListItem[] = [];
  const shown = new Set<string>();
  const walk = (page: PageSummary, depth: 0 | 1 | 2): void => {
    if (shown.has(page.id)) return;
    shown.add(page.id);
    const under = depth < MAX_DEPTH ? (children.get(page.id) ?? []).toSorted(byOrderThenCreated) : [];
    const open = under.length > 0 && collapsed?.has(page.id) !== true;
    items.push(rowOf(page, now, depth, under.length > 0, open));
    if (!open) return;
    for (const child of under) walk(child, (depth + 1) as 1 | 2);
  };
  // 手動の並び（渡した順＝更新の新しい順は、同じ並びの中でそのまま。sort は安定）
  for (const top of tops.toSorted(byOrderThenGiven)) walk(top, 0);
  return items;
}

/**
 * そのページを入れられるフォルダ（情報パネルの「フォルダ」の選択肢）。上の段のページだけを出し、
 * 自分自身・自分の子孫（読み込んである分）と、入れると段が深くなりすぎるものは出さない。
 * サーバーも同じ規則で断る（`EditorStore.movePage`。深すぎる移動は `too_deep`、自分の中は `cycle`）。
 */
export function folderOptions(pages: readonly PageSummary[], id: string): { id: string; title: string }[] {
  const children = new Map<string, PageSummary[]>();
  for (const page of pages) {
    if (page.parent === null) continue;
    const list = children.get(page.parent) ?? [];
    list.push(page);
    children.set(page.parent, list);
  }
  const height = (pageId: string, left = MAX_DEPTH): number => {
    const under = left <= 0 ? [] : (children.get(pageId) ?? []);
    return under.length === 0 ? 0 : 1 + Math.max(...under.map((child) => height(child.id, left - 1)));
  };
  // 入れ先は 0 の段なので、入れたページは 1 の段。その下の高さを足して 2 を超えるなら入れられない
  if (1 + height(id) > MAX_DEPTH) return [];
  const inside = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const page of pages) {
      if (page.parent !== null && inside.has(page.parent) && !inside.has(page.id)) {
        inside.add(page.id);
        grew = true;
      }
    }
  }
  return pages.filter((page) => page.parent === null && !inside.has(page.id)).map((page) => ({ id: page.id, title: page.title }));
}

/**
 * そのページが同じ階層の中で上へ・下へ動かせるか（情報パネルの「並び」。読み込んである行で見る）。
 * 木に出ていない行（親を読み込んでいない・段が深すぎる）は動かせない扱いにする。
 */
export function orderNeighbours(pages: readonly PageSummary[], id: string): { canUp: boolean; canDown: boolean } {
  const page = pages.find((item) => item.id === id);
  if (!page) return { canUp: false, canDown: false };
  const siblings = pages.filter((item) => item.parent === page.parent);
  const sorted = page.parent === null ? siblings.toSorted(byOrderThenGiven) : siblings.toSorted(byOrderThenCreated);
  const at = sorted.findIndex((item) => item.id === id);
  return { canUp: at > 0, canDown: at >= 0 && at < sorted.length - 1 };
}

/** 「最近」の行（木にしない。段も開閉も持たない）。 */
export function recentRows(pages: readonly PageSummary[], now: number): ShellListItem[] {
  return pages.map((page) => rowOf(page, now, 0, false, false));
}

/**
 * 並べ替えたあとの行（サーバーと同じ規則で作り直す）。同じ階層の行を今の並びで取り、1 つ動かして 1 から振り直す。
 * 動かせない（もう端・木に出ていない）ときは渡した配列をそのまま返す。
 */
export function reorderedPages(pages: readonly PageSummary[], id: string, move: "up" | "down"): PageSummary[] {
  const page = pages.find((item) => item.id === id);
  if (!page) return [...pages];
  const siblings = pages.filter((item) => item.parent === page.parent);
  const sorted = page.parent === null ? siblings.toSorted(byOrderThenGiven) : siblings.toSorted(byOrderThenCreated);
  const at = sorted.findIndex((item) => item.id === id);
  const to = move === "up" ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= sorted.length) return [...pages];
  const moved = [...sorted];
  [moved[at], moved[to]] = [moved[to]!, moved[at]!];
  const orders = new Map(moved.map((item, index) => [item.id, index + 1]));
  return pages.map((item) => {
    const order = orders.get(item.id);
    return order === undefined ? item : { ...item, sortOrder: order };
  });
}
