import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { applyMigrations } from "../src/migrate.ts";
import { EditorStore, MAX_PAGE_DEPTH } from "../src/store.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID と合成の本文だけを使う
const OWNER = "synthetic-folder-owner-a";
const OTHER = "synthetic-folder-owner-b";
const blocks = [{ type: "paragraph", content: [{ type: "text", text: "合成の本文" }] }];

/**
 * フォルダ（`kind = 'folder'` の入れ物）の運用規則（docs/architecture/editor-recipes-and-folders.md §3.2）を実 PostgreSQL で確かめる。
 * 段は フォルダ（0）› ページ（1）› 録音のサブページ（2）まで。入れる・出すでページは失われない。親になれるのはフォルダだけ。
 */
describe("folders are kind = 'folder' containers (pages.parent)", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_store_folders_${randomUUID().replaceAll("-", "")}`;
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

  const page = async (title: string, owner = OWNER) => (await store.createPage(owner, { title, blocks })).id;
  const folderOf = async (title: string, owner = OWNER) => (await store.createPage(owner, { kind: "folder", title })).id;
  /** 録音のサブページ（step_runs.createRun が親＝録音で作る行の代わり。movePage を通らない）。 */
  const stepUnder = async (rec: string, title: string) => {
    const id = (await store.createPage(OWNER, { kind: "step", title, blocks })).id;
    await pool.query("UPDATE pages SET parent = $2 WHERE id = $1", [id, rec]);
    return id;
  };

  /** 読めるページの id と親（ゴミ箱は含まない）。 */
  async function tree(owner = OWNER): Promise<[string, string | null][]> {
    return (await store.listPages(owner)).map((item) => [item.title, item.parent]);
  }

  it("creates an empty folder with no body, and refuses a folder with a body or inside a folder", async () => {
    const folder = await store.createPage(OWNER, { kind: "folder", title: "空のフォルダ" });
    assert.equal(folder.kind, "folder");
    assert.deepEqual(folder.blocks, []);
    assert.equal(folder.parent, null);
    assert.deepEqual(await tree(), [["空のフォルダ", null]]);
    assert.equal((await store.listPages(OWNER))[0]?.kind, "folder");

    await assert.rejects(store.createPage(OWNER, { kind: "folder", title: "本文つき", blocks }), TypeError);
    await assert.rejects(store.createPage(OWNER, { kind: "folder", title: "入れ子", parent: folder.id }), TypeError);
    assert.equal((await tree()).length, 1, "断った作成は何も書かない");
  });

  it("creates a page inside a folder, and answers the same 404 (null) when the parent is not a living folder of mine", async () => {
    const folder = await folderOf("フォルダ");
    const inside = await store.createPage(OWNER, { kind: "rec", title: "中の録音", parent: folder });
    assert.equal(inside?.parent, folder);
    assert.equal(inside?.kind, "rec");

    const note = await page("ふつうのページ");
    const theirs = await folderOf("別の人のフォルダ", OTHER);
    const trashed = await folderOf("ゴミ箱のフォルダ");
    assert.equal(await store.deletePage(OWNER, trashed), "deleted");
    assert.equal(await store.createPage(OWNER, { title: "x", parent: note }), null, "フォルダでない親");
    assert.equal(await store.createPage(OWNER, { title: "x", parent: theirs }), null, "別の人のフォルダ");
    assert.equal(await store.createPage(OWNER, { title: "x", parent: trashed }), null, "ゴミ箱のフォルダ");
    assert.equal(await store.createPage(OWNER, { title: "x", parent: randomUUID() }), null, "無い id");
    assert.equal(await store.createPage(OWNER, { title: "x", parent: "not-a-uuid" }), null, "UUID でない id");
    assert.equal((await tree()).length, 3);
  });

  it("does not store a body for a folder and never changes kind to or from folder", async () => {
    const folder = await store.createPage(OWNER, { kind: "folder", title: "フォルダ" });
    await assert.rejects(store.savePage(OWNER, folder.id, { blocks }, { baseRevision: folder.revision }), /folder has no body/);
    await assert.rejects(store.savePage(OWNER, folder.id, { kind: "note" }, { baseRevision: folder.revision }), TypeError);
    const note = await store.createPage(OWNER, { title: "ページ", blocks });
    await assert.rejects(store.savePage(OWNER, note.id, { kind: "folder" }, { baseRevision: note.revision }), TypeError);
    // 題名だけの保存は通る
    const renamed = await store.savePage(OWNER, folder.id, { title: "新しい名前" }, { baseRevision: folder.revision });
    assert.equal(renamed?.status, "saved");
    const after = await store.getPage(OWNER, folder.id);
    assert.equal(after?.title, "新しい名前");
    assert.deepEqual(after?.blocks, []);
    assert.equal(after?.kind, "folder");
    // 旧「親ページ」の版があっても、フォルダの本文へは戻さない
    await pool.query("INSERT INTO page_versions (page_id, version, blocks, reason) VALUES ($1, 1, $2::jsonb, 'autosave')", [folder.id, JSON.stringify(blocks)]);
    const restored = await store.restoreVersion(OWNER, folder.id, 1, { baseRevision: after!.revision, accept: (value) => value as typeof blocks });
    assert.deepEqual(restored, { status: "unrestorable" });
    assert.deepEqual((await store.getPage(OWNER, folder.id))?.blocks, []);
  });

  it("puts a page into a folder and takes it out again, without losing a page", async () => {
    const folder = await folderOf("鎌倉の記事");
    const note = await page("取材メモ");
    assert.deepEqual((await tree()).length, 2);

    assert.equal(await store.movePage(OWNER, note, folder), "moved");
    const inside = await tree();
    assert.equal(inside.length, 2, "フォルダに入れてもページは減らない");
    assert.deepEqual(
      inside.find(([title]) => title === "取材メモ"),
      ["取材メモ", folder],
    );

    assert.equal(await store.movePage(OWNER, note, null), "moved");
    const outside = await tree();
    assert.equal(outside.length, 2, "フォルダから出してもページは減らない");
    assert.deepEqual(
      outside.find(([title]) => title === "取材メモ"),
      ["取材メモ", null],
    );
  });

  it("only a folder can be a parent, and a folder is never put into a folder (not_folder writes nothing)", async () => {
    const folder = await folderOf("フォルダ");
    const other = await folderOf("別のフォルダ");
    const note = await page("ページ");
    const rec = (await store.createPage(OWNER, { kind: "rec", title: "録音", blocks })).id;
    assert.equal(await store.movePage(OWNER, rec, note), "not_folder");
    assert.equal(await store.movePage(OWNER, note, rec), "not_folder");
    assert.equal(await store.movePage(OWNER, other, folder), "not_folder");
    assert.equal((await store.getPage(OWNER, rec))?.parent, null);
    assert.equal((await store.getPage(OWNER, note))?.parent, null);
    assert.equal((await store.getPage(OWNER, other))?.parent, null);
    assert.equal(await store.movePage(OWNER, note, folder), "moved");
  });

  it("allows フォルダ › 録音 › 録音のサブページ and refuses one more 段", async () => {
    const folder = await folderOf("フォルダ");
    const rec = (await store.createPage(OWNER, { kind: "rec", title: "録音", blocks })).id;
    assert.equal(await store.movePage(OWNER, rec, folder), "moved");
    const sub = await stepUnder(rec, "録音のサブページ");
    const deeper = await page("その下");
    assert.equal(MAX_PAGE_DEPTH, 2);

    assert.equal(await store.movePage(OWNER, deeper, sub), "too_deep");
    // 断られた移動は何も書かない
    assert.equal((await store.getPage(OWNER, deeper))?.parent, null);
    assert.equal((await tree()).length, 4);
  });

  it("refuses to put a page that already has 段 under a folder when it would be too deep", async () => {
    // 上の段の録音にサブページが 1 段、そのサブページにさらに子（旧データ）がある木をフォルダへ入れると 3 段になる
    const folder = await folderOf("フォルダ");
    const rec = (await store.createPage(OWNER, { kind: "rec", title: "録音", blocks })).id;
    const sub = await stepUnder(rec, "サブページ");
    await stepUnder(sub, "旧データの孫");
    assert.equal(await store.movePage(OWNER, rec, folder), "too_deep");
    assert.equal((await store.getPage(OWNER, rec))?.parent, null);
  });

  it("counts a 子孫 in the trash toward the depth limit, so restoring it later cannot exceed the limit", async () => {
    const folder = await folderOf("フォルダ");
    const rec = (await store.createPage(OWNER, { kind: "rec", title: "録音", blocks })).id;
    const sub = await stepUnder(rec, "録音のサブページ");
    const grand = await stepUnder(sub, "旧データの孫");
    assert.equal(await store.deletePage(OWNER, grand), "deleted");

    // 見えている高さは 1 段だけだが、戻せば 2 段になる。フォルダの下へ入れると 3 段になるので断る
    assert.equal(await store.movePage(OWNER, rec, folder), "too_deep");
    assert.equal((await store.getPage(OWNER, rec))?.parent, null);

    assert.equal(await store.restoreFromTrash(OWNER, grand), true);
    assert.equal((await store.getPage(OWNER, grand))?.parent, sub);
  });

  it("refuses a move into itself or into its own 子孫", async () => {
    const folder = await folderOf("フォルダ");
    const note = await page("ページ");
    assert.equal(await store.movePage(OWNER, note, folder), "moved");
    assert.equal(await store.movePage(OWNER, folder, folder), "cycle");
    assert.equal(await store.movePage(OWNER, folder, note), "cycle");
    assert.equal((await store.getPage(OWNER, folder))?.parent, null);
    assert.equal((await store.getPage(OWNER, note))?.parent, folder);
  });

  it("answers the same 404 for another person's page, a trashed page and an id that is not a page", async () => {
    const mine = await page("自分のページ");
    const theirs = await folderOf("別の人のフォルダ", OTHER);
    const trashed = await folderOf("ゴミ箱のフォルダ");
    assert.equal(await store.deletePage(OWNER, trashed), "deleted");

    // 入れ先が別の人のもの・ゴミ箱の中・無い id
    assert.equal(await store.movePage(OWNER, mine, theirs), null);
    assert.equal(await store.movePage(OWNER, mine, trashed), null);
    assert.equal(await store.movePage(OWNER, mine, randomUUID()), null);
    assert.equal(await store.movePage(OWNER, mine, "not-a-uuid"), null);
    // 動かすページが別の人のもの・無い id
    assert.equal(await store.movePage(OTHER, mine, null), null);
    assert.equal(await store.movePage(OWNER, randomUUID(), null), null);
    assert.equal((await store.getPage(OWNER, mine))?.parent, null);
  });

  it("changes only the parent: the body, the revision and the 時刻 stay as they are", async () => {
    const folder = await folderOf("フォルダ");
    const note = await page("ページ");
    const before = await store.getPage(OWNER, note);
    assert.ok(before);
    assert.equal(await store.movePage(OWNER, note, folder), "moved");
    const after = await store.getPage(OWNER, note);
    assert.deepEqual({ ...after, parent: null }, { ...before, parent: null });
    assert.equal(after?.parent, folder);
    // 同じ入れ先へもう一度は何もしない
    assert.equal(await store.movePage(OWNER, note, folder), "moved");
  });

  it("keeps the children with the folder in the trash, and brings them back together", async () => {
    const folder = await folderOf("フォルダ");
    const rec = (await store.createPage(OWNER, { kind: "rec", title: "録音", blocks })).id;
    assert.equal(await store.movePage(OWNER, rec, folder), "moved");
    await stepUnder(rec, "サブページ");

    assert.equal(await store.deletePage(OWNER, folder), "deleted");
    assert.deepEqual(await tree(), []);
    assert.deepEqual((await store.listTrash(OWNER)).map((item) => item.title).sort(), ["サブページ", "フォルダ", "録音"]);

    assert.equal(await store.restoreFromTrash(OWNER, folder), true);
    assert.deepEqual((await tree()).sort(), [
      ["サブページ", rec],
      ["フォルダ", null],
      ["録音", folder],
    ]);
  });
});
