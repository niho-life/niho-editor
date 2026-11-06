import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import type { Pool as PgPool } from "pg";
import { duplicatePage } from "../src/duplicate.ts";
import { readGoogleDocsBatchTree } from "../src/google-docs-batches.ts";
import { MIGRATION_FILE_PATTERN, applyMigrations, defaultMigrationsDir } from "../src/migrate.ts";
import { searchPages } from "../src/search.ts";
import { EditorStore } from "../src/store.ts";
import { tabLabel } from "../src/types.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID と合成の本文だけを使う
const OWNER = "synthetic-tabs-owner-a";
const OTHER = "synthetic-tabs-owner-b";
const blocks = [{ type: "paragraph", content: [{ type: "text", text: "合成の本文" }] }];
const TABS_MIGRATION = "20261106234701_pages_tabs.sql";

/**
 * フォルダ › ページ › タブ（#307）。本文を持つ行はそのままタブで、入れ物（kind='page'）が題名と役割を持つ。
 * 入れ物とタブは同じフォルダに並び、タブは `page` で入れ物を指す。
 */
describe("pages have a holder (kind='page') and tabs (#307)", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_store_tabs_${randomUUID().replaceAll("-", "")}`;
  let pool: PgPool;
  let store: EditorStore;

  before(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
    store = new EditorStore(pool);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM pages WHERE owner = ANY($1::text[])", [[OWNER, OTHER]]);
  });

  type Row = { kind: string; title: string; parent: string | null; page: string | null; last_tab: string | null; deleted: boolean; sort_order: number };
  /** 行（無ければ undefined。「消えた」ことを確かめるときは `=== undefined`）。 */
  const rowOf = async (id: string): Promise<Row> =>
    (await pool.query<Row>("SELECT kind, title, parent, page, last_tab, deleted_at IS NOT NULL AS deleted, sort_order FROM pages WHERE id = $1", [id])).rows[0] as Row;

  it("creates a holder and the first tab together, and returns the tab", async () => {
    const tab = await store.createPage(OWNER, { title: "題名", blocks });
    assert.equal(tab.kind, "note");
    assert.ok(tab.page, "タブは入れ物を指す");
    const holder = await rowOf(tab.page!);
    assert.deepEqual([holder.kind, holder.title, holder.parent, holder.last_tab], ["page", "題名", null, tab.id]);
    // 一覧（既定）は本文を持つ行だけ。入れ物は `view: 'pages'` で、タブの数つき
    assert.deepEqual((await store.listPages(OWNER)).map((p) => p.id), [tab.id]);
    const pages = await store.listPages(OWNER, { view: "pages" });
    assert.deepEqual(pages.map((p) => [p.id, p.kind, p.tabsCount]), [[tab.page, "page", 1]]);
    assert.deepEqual((await store.listPageChunk(OWNER)).pages.map((p) => p.id), [tab.id]);
    assert.deepEqual((await store.listPageChunk(OWNER, { view: "pages" })).pages.map((p) => p.id), [tab.page]);
    // getPage はどちらの行も返す
    assert.equal((await store.getPage(OWNER, tab.page!))?.kind, "page");
    await assert.rejects(store.createPage(OWNER, { kind: "page", title: "直に" }), TypeError);
  });

  it("puts holder and tabs in the same folder, with a role on the holder", async () => {
    const folder = await store.createPage(OWNER, { kind: "folder", title: "フォルダ" });
    const tab = await store.createPage(OWNER, { title: "記事本文", parent: folder.id, role: { kind: "step", recipe: "tpl-1", stepId: "body" } });
    assert.ok(tab);
    const holder = await store.getPage(OWNER, tab!.page!);
    assert.deepEqual([holder?.parent, tab?.parent], [folder.id, folder.id]);
    assert.deepEqual(holder?.role, { kind: "step", recipe: "tpl-1", stepId: "body" });
    assert.equal(tab?.role, null);
    assert.deepEqual((await store.listPageChildren(OWNER, folder.id)).map((p) => p.id), [tab!.id]);
    assert.deepEqual((await store.listPageChildren(OWNER, folder.id, { view: "pages" })).map((p) => [p.id, p.tabsCount]), [[holder!.id, 1]]);
    await assert.rejects(store.createPage(OWNER, { kind: "folder", title: "x", role: { kind: "transcript" } }), TypeError);
  });

  it("adds a blank tab, lists and resolves tabs, remembers the last opened tab", async () => {
    const first = await store.createPage(OWNER, { title: "記事本文", blocks });
    const second = await store.createTab(OWNER, first.id, { name: "英語版" });
    assert.ok(second);
    // まっさらなタブ: 本文なし、題名はページの名前（入れ物と同じ）、名前は付けたもの（#308）
    assert.deepEqual([second!.page, second!.parent, second!.blocks, second!.title, second!.tabName], [first.page, null, [], "記事本文", "英語版"]);
    const tabs = await store.listTabs(OWNER, first.page!);
    assert.deepEqual(tabs?.map((t) => t.id), [first.id, second!.id]);
    // 札: 名前の無いタブは入れ物の中の位置の番号
    assert.deepEqual(tabs?.map((t) => [t.tabName, t.tabPos, tabLabel(t)]), [[null, 1, "1"], ["英語版", 2, "英語版"]]);
    assert.deepEqual((await store.listTabs(OWNER, second!.id))?.map((t) => t.id), [first.id, second!.id], "タブの id でも同じ入れ物");
    // 名前を変える・外す。タブでない行には付かない
    assert.equal(await store.renameTab(OWNER, first.id, " 下書き "), true);
    assert.equal((await store.getPage(OWNER, first.id))?.tabName, "下書き");
    assert.equal(await store.renameTab(OWNER, first.id, ""), true);
    assert.equal((await store.getPage(OWNER, first.id))?.tabName, null);
    assert.equal(await store.renameTab(OWNER, first.page!, "x"), false, "入れ物には付かない");
    assert.equal(await store.renameTab(OWNER, randomUUID(), "x"), null);
    assert.equal(await store.renameTab(OTHER, first.id, "x"), null);
    await assert.rejects(store.renameTab(OWNER, first.id, "あ".repeat(101)), TypeError);
    // 足したタブが「最後に開いたタブ」
    let resolved = await store.resolvePage(OWNER, first.page!);
    assert.deepEqual([resolved?.page?.id, resolved?.tab.id, resolved?.tabs.length], [first.page, second!.id, 2]);
    assert.equal(await store.touchLastTab(OWNER, first.id), true);
    resolved = await store.resolvePage(OWNER, first.page!);
    assert.equal(resolved?.tab.id, first.id);
    resolved = await store.resolvePage(OWNER, second!.id);
    assert.deepEqual([resolved?.page?.id, resolved?.tab.id], [first.page, second!.id]);
    // 入れ物は一覧に 1 行、タブの数は 2。`all` は入れ物もタブも（画面の一覧。#308）
    assert.deepEqual((await store.listPages(OWNER, { view: "pages" })).map((p) => p.tabsCount), [2]);
    assert.equal((await store.listPages(OWNER)).length, 2);
    const all = await store.listPages(OWNER, { view: "all" });
    assert.deepEqual(all.map((p) => [p.kind, p.page ?? null, p.tabPos ?? null]).sort(), [["note", first.page, 1], ["note", first.page, 2], ["page", null, null]].sort());
    assert.deepEqual((await store.listPageChunk(OWNER, { view: "all" })).pages.length, 3);
    // 別の人・フォルダ・無い id
    assert.equal(await store.createTab(OTHER, first.id), null);
    const folder = await store.createPage(OWNER, { kind: "folder", title: "フォルダ" });
    await assert.rejects(store.createTab(OWNER, folder.id), TypeError);
    assert.equal(await store.createTab(OWNER, randomUUID()), null);
  });

  it("duplicates a tab into the same holder (made_from dup), after the others", async () => {
    const folder = await store.createPage(OWNER, { kind: "folder", title: "フォルダ" });
    const first = await store.createPage(OWNER, { title: "記事本文", blocks, parent: folder.id });
    const copy = await duplicatePage(pool, OWNER, first!.id);
    assert.ok(copy);
    // 題名はページの名前のまま。タブの名前（無ければ位置の番号）に「のコピー」（#308）
    assert.deepEqual([copy!.page, copy!.parent, copy!.title, copy!.tabName, copy!.blocks], [first!.page, folder.id, "記事本文", "1のコピー", blocks]);
    const got = await store.getPage(OWNER, copy!.id);
    assert.deepEqual(got?.madeFrom, { kind: "dup", from: first!.id });
    assert.deepEqual((await store.listTabs(OWNER, first!.id))?.map((t) => t.id), [first!.id, copy!.id]);
    await store.renameTab(OWNER, copy!.id, "英語版");
    assert.equal((await duplicatePage(pool, OWNER, copy!.id))?.tabName, "英語版のコピー");
    // 入れ物は複製されない
    assert.equal(await duplicatePage(pool, OWNER, first!.page!), null);
  });

  it("reorders and moves tabs; an empty holder is dropped", async () => {
    const a = await store.createPage(OWNER, { title: "A", blocks });
    const a2 = await store.createTab(OWNER, a.id, { name: "A2" });
    const b = await store.createPage(OWNER, { title: "B", blocks });
    assert.equal(await store.reorderTabs(OWNER, a.page!, [a2!.id, a.id]), true);
    assert.deepEqual((await store.listTabs(OWNER, a.id))?.map((t) => t.id), [a2!.id, a.id]);
    assert.equal(await store.reorderTabs(OWNER, a.page!, [a.id]), false, "足りない");
    assert.equal(await store.reorderTabs(OWNER, a.page!, [a.id, a2!.id, b.id]), false, "別の入れ物のタブ");
    // A2 を B の入れ物へ（題名は移り先のページの名前に。#308）
    assert.equal(await store.moveTab(OWNER, a2!.id, b.id), "moved");
    assert.deepEqual((await store.listTabs(OWNER, b.id))?.map((t) => t.id), [b.id, a2!.id]);
    assert.deepEqual([(await rowOf(a2!.id)).page, (await rowOf(a2!.id)).title], [b.page, "B"]);
    // A の最後のタブも B へ → A の入れ物は消える
    assert.equal(await store.moveTab(OWNER, a.id, b.page!), "moved");
    assert.equal(await rowOf(a.page!), undefined, "空の入れ物は残さない");
    assert.equal(await store.moveTab(OWNER, b.page!, b.id), "not_page", "入れ物は動かせない");
    const folder = await store.createPage(OWNER, { kind: "folder", title: "フォルダ" });
    await assert.rejects(store.moveTab(OWNER, b.id, folder.id), TypeError);
  });

  it("trashes a holder with its tabs, a last tab with its holder, and restores them together", async () => {
    const a = await store.createPage(OWNER, { title: "A", blocks });
    const a2 = await store.createTab(OWNER, a.id, { name: "A2" });
    assert.equal(await store.deletePage(OWNER, a.page!), "deleted");
    assert.deepEqual([(await rowOf(a.id)).deleted, (await rowOf(a2!.id)).deleted, (await rowOf(a.page!)).deleted], [true, true, true]);
    assert.equal(await store.restoreFromTrash(OWNER, a.page!), true);
    assert.deepEqual([(await rowOf(a.id)).deleted, (await rowOf(a2!.id)).deleted, (await rowOf(a.page!)).deleted], [false, false, false]);
    // タブを 1 つ消す → 入れ物は残る。最後のタブを消す → 入れ物も
    assert.equal(await store.deletePage(OWNER, a2!.id), "deleted");
    assert.deepEqual([(await rowOf(a2!.id)).deleted, (await rowOf(a.page!)).deleted], [true, false]);
    assert.equal(await store.deletePage(OWNER, a.id), "deleted");
    assert.equal((await rowOf(a.page!)).deleted, true);
    // タブから戻すと入れ物も戻る（一緒に入ったものだけ。先に消した A2 は残る）
    assert.equal(await store.restoreFromTrash(OWNER, a.id), true);
    assert.deepEqual([(await rowOf(a.id)).deleted, (await rowOf(a.page!)).deleted, (await rowOf(a2!.id)).deleted], [false, false, true]);
    assert.deepEqual((await store.listTrash(OWNER)).map((t) => t.id), [a2!.id]);
  });

  it("moves a holder with its tabs into a folder when a tab is moved, and orders holders (not tabs) among siblings", async () => {
    const folder = await store.createPage(OWNER, { kind: "folder", title: "フォルダ" });
    const a = await store.createPage(OWNER, { title: "A", blocks });
    const a2 = await store.createTab(OWNER, a.id, { name: "A2" });
    assert.equal(await store.movePage(OWNER, a2!.id, folder.id), "moved");
    assert.deepEqual([(await rowOf(a.id)).parent, (await rowOf(a2!.id)).parent, (await rowOf(a.page!)).parent], [folder.id, folder.id, folder.id]);
    const b = await store.createPage(OWNER, { title: "B", blocks, parent: folder.id });
    assert.equal(await store.movePageOrder(OWNER, b!.id, "up"), "moved");
    assert.deepEqual((await store.listPageChildren(OWNER, folder.id, { view: "pages" })).map((p) => p.title), ["B", "A"]);
    assert.equal(await store.movePageOrder(OWNER, b!.id, "up"), "edge");
    // 並びは入れ物の間で決まり、返す行は入れ物と、そのタブ（入れ物の並びを添えたもの。画面の一覧は両方を持つ。#308）
    assert.deepEqual(
      (await store.pageSiblingOrders(OWNER, b!.id)).map((o) => [o.id, o.sortOrder]).sort(),
      [[a.page!, 2], [a.id, 2], [a2!.id, 2], [b!.page!, 1], [b!.id, 1]].sort(),
    );
  });

  it("discards a blank second tab and, when it was the last tab, its holder", async () => {
    const a = await store.createPage(OWNER, { title: "", blocks: [] });
    const a2 = await store.createTab(OWNER, a.id);
    assert.deepEqual(await store.discardEmptyPage(OWNER, a2!.id), { discarded: true });
    assert.equal(await rowOf(a2!.id), undefined);
    assert.ok(await rowOf(a.page!), "まだ A が残っている");
    assert.deepEqual(await store.discardEmptyPage(OWNER, a.id), { discarded: true });
    assert.equal(await rowOf(a.page!), undefined, "最後のタブを捨てたら入れ物も");
  });

  it("saving a tab touches the holder; the title is the page's name and is copied to the holder and the other tabs", async () => {
    const a = await store.createPage(OWNER, { title: "前", blocks });
    const saved = await store.savePage(OWNER, a.id, { title: "後" }, { baseRevision: a.revision });
    assert.equal(saved?.status, "saved");
    assert.equal((await rowOf(a.page!)).title, "後");
    const a2 = await store.createTab(OWNER, a.id, { name: "2" });
    assert.equal(a2!.title, "後", "まっさらなタブの題名はページの名前");
    const again = await store.savePage(OWNER, a.id, { title: "三" }, { baseRevision: a.revision + 1 });
    assert.equal(again?.status, "saved");
    assert.deepEqual([(await rowOf(a.page!)).title, (await rowOf(a2!.id)).title], ["三", "三"], "題名は入れ物と全てのタブで同じ（#308）");
    // 兄弟のタブの revision は進めない（開いているエディタと競合させない）
    assert.equal((await store.getPage(OWNER, a2!.id))?.revision, a2!.revision);
    // 本文だけの保存は題名に触れない
    const body = await store.savePage(OWNER, a2!.id, { blocks }, { baseRevision: a2!.revision });
    assert.equal(body?.status, "saved");
    assert.equal((await rowOf(a.id)).title, "三");
    // 検索の結果はページの名前と、タブが 2 つ以上あるときの札（#308）
    const hits = await searchPages(pool, OWNER, "三");
    assert.deepEqual(hits.map((h) => [h.id, h.title, h.tab]).sort(), [[a.id, "三", "1"], [a2!.id, "三", "2"]].sort());
    assert.equal(await store.deletePage(OWNER, a2!.id), "deleted");
    assert.deepEqual((await searchPages(pool, OWNER, "三")).map((h) => h.tab), [null], "1 つだけなら札は無い");
    // 入れ物に本文は書けない
    const holder = await store.getPage(OWNER, a.page!);
    await assert.rejects(store.savePage(OWNER, holder!.id, { blocks }, { baseRevision: holder!.revision }), TypeError);
  });

  it("restoring a tab also restores its holder, even when the holder went to the trash at another time", async () => {
    const a = await store.createPage(OWNER, { title: "A", blocks });
    const a2 = await store.createTab(OWNER, a.id, { name: "A2" });
    assert.equal(await store.deletePage(OWNER, a.id), "deleted"); // 入れ物は A2 が残るので生きている
    assert.equal(await store.deletePage(OWNER, a2!.id), "deleted"); // 最後のタブ A2 と一緒に入れ物が、A とは別の時刻で入る
    assert.equal((await rowOf(a.page!)).deleted, true);
    // A だけ戻す → 入れ物も戻る（戻さないと A は消えた入れ物を指したまま、一覧にも入れ物の URL にも現れない）
    assert.equal(await store.restoreFromTrash(OWNER, a.id), true);
    assert.deepEqual([(await rowOf(a.id)).deleted, (await rowOf(a.page!)).deleted, (await rowOf(a2!.id)).deleted], [false, false, true]);
    assert.deepEqual((await store.listPages(OWNER, { view: "pages" })).map((p) => p.id), [a.page]);
    assert.equal((await store.resolvePage(OWNER, a.page!))?.tab.id, a.id);
    assert.deepEqual((await store.listTrash(OWNER)).map((t) => t.id), [a2!.id]);
    // 残った A2 も戻せる（入れ物は生きたまま、2 つのタブが揃う）
    assert.equal(await store.restoreFromTrash(OWNER, a2!.id), true);
    assert.deepEqual((await store.listTabs(OWNER, a.page!))?.map((t) => t.id), [a.id, a2!.id]);
  });

  it("search returns a page once: the holder is not a hit", async () => {
    const a = await store.createPage(OWNER, { title: "合成の検索題名", blocks });
    // まっさらなタブの題名はページの名前（#308）なので、2 つ目も同じ語で当たる
    await store.createTab(OWNER, a.id, { name: "二枚目" });
    const hits = await searchPages(pool, OWNER, "合成の検索題名");
    assert.equal(hits.length, 2, "入れ物は数えない（タブ 2 つだけ）");
    assert.ok(hits.every((hit) => hit.kind !== "page"));
  });

  it("the Google Docs batch tree counts the tabs, not the holders", async () => {
    const folder = await store.createPage(OWNER, { kind: "folder", title: "F" });
    const x = await store.createPage(OWNER, { title: "X", blocks, parent: folder.id });
    const y = await store.createPage(OWNER, { title: "Y", blocks, parent: folder.id });
    const tree = await readGoogleDocsBatchTree(pool, OWNER, folder.id);
    assert.deepEqual(tree?.map((row) => row.id), [folder.id, x!.id, y!.id], "フォルダとタブだけ（件数の上限 200 にも入れ物を数えない）");
  });
});

/** 既存のデータに migration を当てる: 本文を持つ行ごとに入れ物ができ、id は変わらず、step のサブページは触らない。 */
describe("migration 20261106234701_pages_tabs on existing pages", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_store_tabs_up_${randomUUID().replaceAll("-", "")}`;
  let pool: PgPool;
  let dir: string;

  before(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    dir = await mkdtemp(join(tmpdir(), "editor-store-tabs-"));
    for (const name of await readdir(defaultMigrationsDir)) {
      if (MIGRATION_FILE_PATTERN.test(name) && name < TABS_MIGRATION) await copyFile(new URL(name, defaultMigrationsDir), join(dir, name));
    }
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  });

  it("gives every body page a holder in the same folder, keeps ids, and leaves step subpages alone", async () => {
    const client = await pool.connect();
    try {
      await applyMigrations(client, pathToFileURL(`${dir}/`));
      const folder = (await client.query<{ id: string }>("INSERT INTO pages (owner, kind, title) VALUES ($1, 'folder', 'フォルダ') RETURNING id", [OWNER])).rows[0]!.id;
      const note = (await client.query<{ id: string }>("INSERT INTO pages (owner, title, parent, sort_order, blocks) VALUES ($1, 'メモ', $2, 3, $3) RETURNING id", [OWNER, folder, JSON.stringify(blocks)])).rows[0]!.id;
      const rec = (await client.query<{ id: string }>("INSERT INTO pages (owner, kind, title, parent) VALUES ($1, 'rec', '録音', $2) RETURNING id", [OWNER, folder])).rows[0]!.id;
      const step = (await client.query<{ id: string }>("INSERT INTO pages (owner, kind, title, parent, recipe, step_status) VALUES ($1, 'step', '記事本文', $2, 'tpl-1', 'done') RETURNING id", [OWNER, rec])).rows[0]!.id;
      const top = (await client.query<{ id: string }>("INSERT INTO pages (owner, title) VALUES ($1, '上の段') RETURNING id", [OWNER])).rows[0]!.id;
      const trashed = (await client.query<{ id: string }>("INSERT INTO pages (owner, title, deleted_at) VALUES ($1, 'ゴミ箱', clock_timestamp()) RETURNING id", [OWNER])).rows[0]!.id;

      await copyFile(new URL(TABS_MIGRATION, defaultMigrationsDir), join(dir, TABS_MIGRATION));
      const result = await applyMigrations(client, pathToFileURL(`${dir}/`));
      assert.deepEqual(result.applied, [TABS_MIGRATION]);

      const row = async (id: string) =>
        (await client.query<{ kind: string; title: string; parent: string | null; page: string | null; sort_order: number; deleted: boolean }>(
          "SELECT kind, title, parent, page, sort_order, deleted_at IS NOT NULL AS deleted FROM pages WHERE id = $1",
          [id],
        )).rows[0]!;
      const holderOf = async (id: string) => {
        const tab = await row(id);
        assert.ok(tab.page, `${tab.title} は入れ物を指す`);
        const holder = await row(tab.page!);
        assert.equal(holder.kind, "page");
        return { tab, holder };
      };
      const n = await holderOf(note);
      assert.deepEqual([n.holder.title, n.holder.parent, n.holder.sort_order, n.tab.parent], ["メモ", folder, 3, folder]);
      const r = await holderOf(rec);
      assert.deepEqual([r.holder.title, r.holder.parent], ["録音", folder]);
      const t = await holderOf(top);
      assert.deepEqual([t.holder.parent, t.tab.parent], [null, null]);
      const g = await holderOf(trashed);
      assert.deepEqual([g.holder.deleted, g.tab.deleted], [true, true]);
      const s = await row(step);
      assert.deepEqual([s.kind, s.page, s.parent], ["step", null, rec], "step のサブページは録音のタブの下のまま");
      assert.equal((await row(folder)).page, null);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM pages WHERE kind = 'page'")).rows[0]!.n, 4);
      // last_tab は 1 つ目のタブ
      assert.equal((await client.query<{ last_tab: string }>("SELECT last_tab FROM pages WHERE id = $1", [n.tab.page])).rows[0]!.last_tab, note);
    } finally {
      client.release();
    }
  });
});
