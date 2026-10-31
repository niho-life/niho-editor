import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { applyMigrations } from "../src/migrate.ts";
import { getPageFields, hasPageFields, pageFieldsProblem, savePageFields, type PageFieldsPatch } from "../src/page-fields.ts";
import { RECENT_LIMIT, listRecentPages, recordPageOpen } from "../src/page-opens.ts";
import { EditorStore } from "../src/store.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID と合成の本文だけを使う
const OWNER = "synthetic-order-owner-a";
const OTHER = "synthetic-order-owner-b";
const blocks = [{ type: "paragraph", content: [{ type: "text", text: "合成の本文" }] }];

/**
 * 20261101013000_folder_order_fields_opens の 3 つ（手動の並び・フォルダの欄・「最近」）を実 PostgreSQL で確かめる。
 * 規則は docs/architecture/editor-recipes-and-folders.md §3・§5。
 */
describe("manual order, folder fields and 最近 (20261101013000)", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_store_order_${randomUUID().replaceAll("-", "")}`;
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

  /** 作った順に、少しずつ新しい更新時刻で（並べ替える前は更新の新しい順に出る）。 */
  async function pages(...titles: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const [index, title] of titles.entries()) {
      const page = await store.createPage(OWNER, { title, blocks });
      await pool.query("UPDATE pages SET updated_at = created_at + make_interval(secs => $2) WHERE id = $1", [page.id, index]);
      ids.push(page.id);
    }
    return ids;
  }

  const titles = async () => (await store.listPageChildren(OWNER, null)).map((page) => page.title);

  describe("manual order", () => {
    it("starts as the update order (sort_order 0) and moves one step at a time", async () => {
      await pages("a", "b", "c");
      // 並べ替える前は更新の新しい順
      assert.deepEqual(await titles(), ["c", "b", "a"]);
      assert.deepEqual((await store.listPageChildren(OWNER, null)).map((page) => page.sortOrder), [0, 0, 0]);

      const [, b] = await store.listPageChildren(OWNER, null);
      assert.equal(await store.movePageOrder(OWNER, b!.id, "up"), "moved");
      assert.deepEqual(await titles(), ["b", "c", "a"]);
      // 動かすと、同じ親の全ての行に 1 から振り直す
      assert.deepEqual((await store.listPageChildren(OWNER, null)).map((page) => page.sortOrder), [1, 2, 3]);

      assert.equal(await store.movePageOrder(OWNER, b!.id, "down"), "moved");
      assert.deepEqual(await titles(), ["c", "b", "a"]);
    });

    it("answers edge at the ends and writes nothing", async () => {
      const [a, b] = await pages("a", "b");
      // 並べ替える前は更新の新しい順（b が上）
      assert.deepEqual(await titles(), ["b", "a"]);
      assert.equal(await store.movePageOrder(OWNER, b!, "up"), "edge");
      assert.equal(await store.movePageOrder(OWNER, a!, "down"), "edge");
      assert.deepEqual(await titles(), ["b", "a"]);
      assert.equal(await store.movePageOrder(OWNER, a!, "up"), "moved");
      assert.deepEqual(await titles(), ["a", "b"]);
      assert.equal(await store.movePageOrder(OWNER, a!, "up"), "edge");
    });

    it("orders inside a folder on its own, and never mixes two folders", async () => {
      const [folder, other] = await pages("フォルダ", "別のフォルダ");
      const [one, two] = await pages("1", "2");
      for (const id of [one!, two!]) assert.equal(await store.movePage(OWNER, id, folder!), "moved");
      const inOther = (await pages("3"))[0]!;
      assert.equal(await store.movePage(OWNER, inOther, other!), "moved");

      // フォルダの中は作った順
      assert.deepEqual((await store.listPageChildren(OWNER, folder!)).map((page) => page.title), ["1", "2"]);
      assert.equal(await store.movePageOrder(OWNER, two!, "up"), "moved");
      assert.deepEqual((await store.listPageChildren(OWNER, folder!)).map((page) => page.title), ["2", "1"]);
      // 別のフォルダの中は 1 行だけなので端
      assert.equal(await store.movePageOrder(OWNER, inOther, "up"), "edge");
      assert.deepEqual((await store.listPageChildren(OWNER, other!)).map((page) => page.title), ["3"]);
    });

    it("changes only the order: the body, the revision and the 時刻 stay as they are", async () => {
      const [a, b] = await pages("a", "b");
      const before = await store.getPage(OWNER, a!);
      assert.equal(await store.movePageOrder(OWNER, a!, "up"), "moved");
      const after = await store.getPage(OWNER, a!);
      // 変わるのは並びだけ
      assert.deepEqual({ ...after, sortOrder: 0 }, { ...before, sortOrder: 0 });
      assert.equal(after?.sortOrder, 1);
      assert.ok(b);
    });

    it("answers the same 404 for another person's page and an id that is not a page", async () => {
      const [mine] = await pages("a");
      assert.equal(await store.movePageOrder(OTHER, mine!, "up"), null);
      assert.equal(await store.movePageOrder(OWNER, randomUUID(), "up"), null);
      assert.equal(await store.movePageOrder(OWNER, "not-a-uuid", "up"), null);
    });
  });

  describe("listPageTree（書き出しが読む木）", () => {
    it("reads the folder and everything under it, each parent followed by its own rows in order", async () => {
      const [folder] = await pages("フォルダ");
      const [note, rec] = await pages("メモ", "録音");
      for (const id of [note!, rec!]) assert.equal(await store.movePage(OWNER, id, folder!), "moved");
      const [step] = await pages("文字起こし修正");
      assert.equal(await store.movePage(OWNER, step!, rec!), "moved");

      // フォルダ・録音の中は作った順（上の段だけが更新の新しい順）
      const tree = await store.listPageTree(OWNER, folder!);
      assert.deepEqual(tree.map((page) => page.title), ["フォルダ", "メモ", "録音", "文字起こし修正"]);
      // 本文も読む（書き出しが使う）
      assert.deepEqual(tree[0]?.blocks, blocks);

      // 並べ替えると木の順も変わる
      assert.equal(await store.movePageOrder(OWNER, note!, "down"), "moved");
      assert.deepEqual((await store.listPageTree(OWNER, folder!)).map((page) => page.title), ["フォルダ", "録音", "文字起こし修正", "メモ"]);
    });

    it("is empty for another person's page, a trashed page and an id that is not a page", async () => {
      const [mine] = await pages("a");
      assert.equal(await store.deletePage(OWNER, mine!), "deleted");
      assert.deepEqual(await store.listPageTree(OWNER, mine!), []);
      assert.deepEqual(await store.listPageTree(OTHER, mine!), []);
      assert.deepEqual(await store.listPageTree(OWNER, "not-a-uuid"), []);
    });
  });

  describe("folder fields", () => {
    it("is empty without a row, and replaces each passed field as a whole", async () => {
      const [folder] = await pages("フォルダ");
      assert.deepEqual(await getPageFields(pool, OWNER, folder!), { entities: [], terms: [] });
      assert.equal(hasPageFields(await getPageFields(pool, OWNER, folder!)), false);

      const saved = await savePageFields(pool, OWNER, folder!, {
        entities: [{ name: " 田中 ", reading: "たなか", role: "店主", note: "" }],
        terms: [{ term: "北鎌倉", reading: "きたかまくら", variants: ["北鎌", " "], note: "" }],
      });
      // 前後の空白は落ち、空の誤りやすい表記は消える
      assert.deepEqual(saved.entities, [{ name: "田中", reading: "たなか", role: "店主", note: "" }]);
      assert.deepEqual(saved.terms, [{ term: "北鎌倉", reading: "きたかまくら", variants: ["北鎌"], note: "" }]);
      assert.deepEqual(await getPageFields(pool, OWNER, folder!), saved);
      assert.equal(hasPageFields(saved), true);

      // 渡した項目だけを入れ替える
      const after = await savePageFields(pool, OWNER, folder!, { entities: [] });
      assert.deepEqual(after.entities, []);
      assert.equal(after.terms.length, 1);
    });

    it("keeps each person's fields to themselves and goes away with the page", async () => {
      const [folder] = await pages("フォルダ");
      await savePageFields(pool, OWNER, folder!, { entities: [{ name: "田中", reading: "", role: "", note: "" }] });
      assert.deepEqual(await getPageFields(pool, OTHER, folder!), { entities: [], terms: [] });
      // ゴミ箱の間は残る
      assert.equal(await store.deletePage(OWNER, folder!), "deleted");
      assert.equal((await getPageFields(pool, OWNER, folder!)).entities.length, 1);
      // 完全に消すと一緒に消える
      await pool.query("DELETE FROM pages WHERE id = $1", [folder]);
      assert.deepEqual(await getPageFields(pool, OWNER, folder!), { entities: [], terms: [] });
    });

    it("refuses what the screen could not have sent, writing nothing", async () => {
      const [folder] = await pages("フォルダ");
      const bad: { why: string; patch: PageFieldsPatch }[] = [
        { why: "名前が空", patch: { entities: [{ name: "  ", reading: "", role: "", note: "" }] } },
        { why: "同じ名前が 2 つ", patch: { entities: [{ name: "田中", reading: "", role: "", note: "" }, { name: "田中", reading: "", role: "", note: "" }] } },
        { why: "件数の上限", patch: { entities: Array.from({ length: 201 }, (_, index) => ({ name: `人${index}`, reading: "", role: "", note: "" })) } },
        { why: "固有名詞の形", patch: { terms: [{ term: "", reading: "", variants: [], note: "" }] } },
        { why: "知らない項目", patch: { background: "" } as unknown as PageFieldsPatch },
      ];
      for (const { why, patch } of bad) {
        assert.ok(pageFieldsProblem(patch) !== null, why);
        await assert.rejects(() => savePageFields(pool, OWNER, folder!, patch), TypeError, why);
      }
      assert.deepEqual(await getPageFields(pool, OWNER, folder!), { entities: [], terms: [] });
    });
  });

  describe("最近", () => {
    it("lists what was opened, newest first, and moves a page up when it is opened again", async () => {
      const [a, b, c] = await pages("a", "b", "c");
      for (const id of [a!, b!, c!]) assert.equal(await recordPageOpen(pool, OWNER, id), true);
      assert.deepEqual((await listRecentPages(pool, OWNER)).map((page) => page.title), ["c", "b", "a"]);
      assert.equal(await recordPageOpen(pool, OWNER, a!), true);
      assert.deepEqual((await listRecentPages(pool, OWNER)).map((page) => page.title), ["a", "c", "b"]);
    });

    it("never records another person's page, a trashed page or an id that is not a page", async () => {
      const [mine, trashed] = await pages("a", "b");
      assert.equal(await store.deletePage(OWNER, trashed!), "deleted");
      assert.equal(await recordPageOpen(pool, OTHER, mine!), false);
      assert.equal(await recordPageOpen(pool, OWNER, trashed!), false);
      assert.equal(await recordPageOpen(pool, OWNER, randomUUID()), false);
      assert.deepEqual(await listRecentPages(pool, OTHER), []);
    });

    it("drops a page that went to the trash and brings it back when it is restored", async () => {
      const [a, b] = await pages("a", "b");
      await recordPageOpen(pool, OWNER, a!);
      await recordPageOpen(pool, OWNER, b!);
      assert.equal(await store.deletePage(OWNER, a!), "deleted");
      assert.deepEqual((await listRecentPages(pool, OWNER)).map((page) => page.title), ["b"]);
      assert.equal(await store.restoreFromTrash(OWNER, a!), true);
      assert.deepEqual((await listRecentPages(pool, OWNER)).map((page) => page.title), ["b", "a"]);
    });

    it("answers at most RECENT_LIMIT rows", async () => {
      const ids = await pages(...Array.from({ length: RECENT_LIMIT + 3 }, (_, index) => `p${index}`));
      for (const id of ids) await recordPageOpen(pool, OWNER, id);
      assert.equal((await listRecentPages(pool, OWNER)).length, RECENT_LIMIT);
      assert.equal((await listRecentPages(pool, OWNER, { limit: 3 })).length, 3);
    });

    it("refuses an empty owner before reaching the database", async () => {
      await assert.rejects(() => listRecentPages(pool, ""), TypeError);
      await assert.rejects(() => recordPageOpen(pool, "", randomUUID()), TypeError);
      await assert.rejects(() => getPageFields(pool, "", randomUUID()), TypeError);
      await assert.rejects(() => savePageFields(pool, "", randomUUID(), { terms: [] }), TypeError);
    });
  });
});
