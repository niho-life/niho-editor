import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { duplicatePage } from "../src/duplicate.ts";
import { applyMigrations } from "../src/migrate.ts";
import { enableShare, getShare } from "../src/shares.ts";
import { EditorStore } from "../src/store.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID と合成の本文だけを使う（実在の人の値を入れない）
const OWNER = "synthetic-duplicate-owner-a";
const OTHER = "synthetic-duplicate-owner-b";

const BLOCKS = [
  { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "合成の見出し" }] },
  { type: "paragraph", content: [{ type: "text", text: "合成の", marks: [{ type: "bold" }] }, { type: "text", text: "本文" }] },
  { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "項目" }] }] }] },
];

describe("duplicatePage on PostgreSQL", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_store_duplicate_${randomUUID().replaceAll("-", "")}`;
  let pool: PgPool;

  before(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  async function insertPage(values: { owner?: string; title?: string; deleted?: boolean } = {}): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO pages (owner, kind, title, lang, blocks, lead, deleted_at)
       VALUES ($1, 'article', $2, 'en', $3::jsonb, '合成のリード', CASE WHEN $4::boolean THEN clock_timestamp() END)
       RETURNING id`,
      [values.owner ?? OWNER, values.title ?? "合成の題名", JSON.stringify(BLOCKS), values.deleted ?? false],
    );
    const id = result.rows[0]?.id;
    assert.ok(id);
    return id;
  }

  async function count(owner: string): Promise<number> {
    return Number((await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM pages WHERE owner = $1", [owner])).rows[0]?.n);
  }

  it("copies kind, language, blocks, and lead into a new page of the same owner, and leaves the original as it was", async () => {
    const parent = await insertPage({ title: "親" });
    const source = await insertPage();
    // 写さないもの: 親・カバー・レシピ・手順の状態・共有
    const asset = await pool.query<{ id: string }>(
      "INSERT INTO assets (owner, page_id, kind, bucket_path, bytes, sha256, content_type) VALUES ($1, $2, 'image', $3, 1, $4, 'image/png') RETURNING id",
      [OWNER, source, `synthetic/${randomUUID()}.png`, "a".repeat(64)],
    );
    await pool.query("UPDATE pages SET parent = $2, cover = $3, recipe = 'synthetic-recipe', step_status = 'run' WHERE id = $1", [source, parent, asset.rows[0]?.id]);
    await enableShare(pool, OWNER, source);
    const original = (await pool.query("SELECT * FROM pages WHERE id = $1", [source])).rows[0];

    const copy = await duplicatePage(pool, OWNER, source);
    assert.ok(copy);
    assert.notEqual(copy.id, source);
    assert.deepEqual(Object.keys(copy).sort(), ["blocks", "cover", "createdAt", "id", "kind", "lang", "lead", "page", "parent", "recipe", "stepStatus", "tabName", "title", "updatedAt"]);
    assert.equal(copy.page, null, "入れ物の無い行の複製は入れ物の無い 1 枚（タブの複製は tabs.integration.test）");
    assert.equal(copy.tabName, null, "入れ物の無い行にタブの名前は無い");
    assert.equal(copy.title, "合成の題名のコピー");
    assert.equal(copy.kind, "article");
    assert.equal(copy.lang, "en");
    assert.equal(copy.lead, "合成のリード");
    assert.deepEqual(copy.blocks, BLOCKS);
    assert.equal(copy.parent, null);
    assert.equal(copy.cover, null);
    assert.equal(copy.recipe, null);
    assert.equal(copy.stepStatus, null);
    assert.deepEqual(await getShare(pool, OWNER, copy.id), { shared: false }, "the share is not copied");
    assert.ok(Date.parse(copy.createdAt) >= Date.parse(original.created_at.toISOString()));

    // 本人の 1 ページとして読める（EditorStore の getPage と同じ値）
    const read = await new EditorStore(pool).getPage(OWNER, copy.id);
    assert.ok(read);
    for (const key of Object.keys(copy) as Array<keyof typeof copy>) assert.deepEqual(read[key], copy[key], key);

    assert.deepEqual((await pool.query("SELECT * FROM pages WHERE id = $1", [source])).rows[0], original, "the original page is unchanged");
    const owner = await pool.query<{ owner: string; deleted_at: Date | null }>("SELECT owner, deleted_at FROM pages WHERE id = $1", [copy.id]);
    assert.deepEqual(owner.rows[0], { owner: OWNER, deleted_at: null });
  });

  it("keeps an empty title empty and fits a long title into 500 characters by code points", async () => {
    const cases: Array<[string, string]> = [
      ["", ""],
      ["短い", "短いのコピー"],
      ["あ".repeat(496), `${"あ".repeat(496)}のコピー`],
      ["い".repeat(497), `${"い".repeat(496)}のコピー`],
      ["う".repeat(500), `${"う".repeat(496)}のコピー`],
      ["😀".repeat(500), `${"😀".repeat(496)}のコピー`],
    ];
    for (const [title, expected] of cases) {
      const source = await insertPage({ title });
      const copy = await duplicatePage(pool, OWNER, source);
      assert.ok(copy);
      assert.equal(copy.title, expected, `title of ${Array.from(title).length} characters`);
      assert.ok(Array.from(copy.title).length <= 500);
    }
  });

  it("answers null to another owner's page, a page in the trash, an unknown id, and a malformed id, and inserts nothing", async () => {
    const theirs = await insertPage({ owner: OTHER });
    const removed = await insertPage({ deleted: true });
    const before = { mine: await count(OWNER), theirs: await count(OTHER) };
    for (const id of [theirs, removed, randomUUID(), "not-a-uuid", "00000000-0000-0000-0000-00000000000g"]) {
      assert.equal(await duplicatePage(pool, OWNER, id), null, id);
    }
    assert.deepEqual({ mine: await count(OWNER), theirs: await count(OTHER) }, before);
  });
});
