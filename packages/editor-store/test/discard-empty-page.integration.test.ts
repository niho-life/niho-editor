import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { completeImageUpload, startImageUpload } from "../src/images.ts";
import { applyMigrations, defaultMigrationsDir } from "../src/migrate.ts";
import { savePageFields } from "../src/page-fields.ts";
import { enableShare } from "../src/shares.ts";
import { DISCARD_GUARDED_TABLES, DISCARD_IGNORED_TABLES, EditorStore } from "../src/store.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID・ダミーのハッシュだけを使う（実在の人・実際の画像を入れない）
const OWNER = "synthetic-discard-owner-a";
const OTHER = "synthetic-discard-owner-b";
const SHA = "c".repeat(64);
const HASH = "3".repeat(64);

describe("discardEmptyPage on PostgreSQL", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let store: EditorStore;
  let schema: string;

  before(async () => {
    const { Pool } = await import("pg");
    schema = `editor_store_discard_${randomUUID().replaceAll("-", "")}`;
    pool = new Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await applyMigrations(client, defaultMigrationsDir);
    } finally {
      client.release();
    }
    store = new EditorStore(pool);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  const blank = async (owner = OWNER) => (await store.createPage(owner, {})).id;
  const exists = async (id: string) => (await pool.query("SELECT 1 FROM pages WHERE id = $1", [id])).rows.length > 0;
  const startImage = (pageId: string, owner = OWNER) =>
    startImageUpload(pool, owner, { assetId: randomUUID(), pageId, contentType: "image/png", bytes: 10, sha256: SHA, uploadKey: null, requestHash: HASH });

  it("checks every table that references pages (a new table must be added to the discard check or knowingly ignored)", async () => {
    const result = await pool.query<{ table: string }>(
      "SELECT DISTINCT c.conrelid::regclass::text AS table FROM pg_constraint c WHERE c.contype = 'f' AND c.confrelid = 'pages'::regclass ORDER BY 1",
    );
    const referencing = result.rows.map((row) => row.table);
    assert.ok(referencing.length > 0);
    const known = new Set([...DISCARD_GUARDED_TABLES, ...DISCARD_IGNORED_TABLES]);
    assert.deepEqual(
      referencing.filter((table) => !known.has(table)),
      [],
      "add the table to DISCARD_RELATED_ROWS in src/store.ts (or to DISCARD_IGNORED_TABLES if its rows are not content)",
    );
    // 並びに書いた表が実在する（名前の書き間違い・消した表を残さない）
    assert.deepEqual(
      [...known].filter((table) => !referencing.includes(table)),
      [],
    );
  });

  it("deletes an untouched page completely (not into the trash), along with its opened record", async () => {
    const id = await blank();
    await pool.query("INSERT INTO page_opens (owner, page_id) VALUES ($1, $2)", [OWNER, id]);
    assert.deepEqual(await store.discardEmptyPage(OWNER, id), { discarded: true });
    assert.equal(await exists(id), false);
    assert.deepEqual((await store.listTrash(OWNER)).filter((page) => page.id === id), []);
    // もう無いページは同じ 404
    assert.equal(await store.discardEmptyPage(OWNER, id), null);
  });

  it("treats a title of only spaces and a body of empty paragraphs as empty", async () => {
    const id = await blank();
    const page = (await store.getPage(OWNER, id))!;
    const saved = await store.savePage(OWNER, id, { title: " 　\t", blocks: [{ type: "paragraph" }, { type: "paragraph", content: [] }] }, { baseRevision: page.revision });
    assert.equal(saved?.status, "saved");
    assert.deepEqual(await store.discardEmptyPage(OWNER, id), { discarded: true });
    assert.equal(await exists(id), false);
  });

  it("keeps a page with a title, body text, a lead or a non-note kind", async () => {
    const cases: Array<[string, (id: string, revision: number) => Promise<unknown>]> = [
      ["title", (id, revision) => store.savePage(OWNER, id, { title: "合成の題名" }, { baseRevision: revision })],
      ["body", (id, revision) => store.savePage(OWNER, id, { blocks: [{ type: "paragraph", content: [{ type: "text", text: "合成" }] }] }, { baseRevision: revision })],
      ["divider", (id, revision) => store.savePage(OWNER, id, { blocks: [{ type: "horizontalRule" }] }, { baseRevision: revision })],
      ["lead", (id, revision) => store.savePage(OWNER, id, { lead: "合成のリード" }, { baseRevision: revision })],
      ["kind", (id, revision) => store.savePage(OWNER, id, { kind: "article" }, { baseRevision: revision })],
    ];
    for (const [label, change] of cases) {
      const id = await blank();
      const page = (await store.getPage(OWNER, id))!;
      await change(id, page.revision);
      assert.deepEqual(await store.discardEmptyPage(OWNER, id), { discarded: false }, label);
      assert.equal(await exists(id), true, label);
    }
  });

  it("discards an untouched page made inside a folder (the parent alone does not make it non-empty)", async () => {
    const folder = (await store.createPage(OWNER, { kind: "folder", title: "合成のフォルダ" })).id;
    const inside = await store.createPage(OWNER, { parent: folder });
    assert.ok(inside);
    assert.deepEqual(await store.discardEmptyPage(OWNER, inside.id), { discarded: true });
    assert.equal(await exists(inside.id), false);
    // 空のフォルダは note でないので捨てない
    assert.deepEqual(await store.discardEmptyPage(OWNER, folder), { discarded: false });
  });

  it("keeps a page that has an image (ready or still uploading), an audio asset or a cover", async () => {
    const ready = await blank();
    const started = await startImage(ready);
    assert.equal(started?.status, "created");
    await completeImageUpload(pool, OWNER, started?.status === "created" ? started.assetId : "", { sizeBytes: 10 });
    const uploading = await blank();
    assert.equal((await startImage(uploading))?.status, "created");
    const audio = await blank();
    const audioId = randomUUID();
    await pool.query(
      `INSERT INTO assets (id, owner, page_id, kind, bucket_path, bytes, sha256, content_type) VALUES ($1, $2, $3, 'audio', $4, 10, $5, 'audio/mp4')`,
      [audioId, OWNER, audio, `audio/${audioId}`, SHA],
    );
    for (const [label, id] of [["ready image", ready], ["uploading image", uploading], ["audio", audio]] as const) {
      assert.deepEqual(await store.discardEmptyPage(OWNER, id), { discarded: false }, label);
      assert.equal(await exists(id), true, label);
    }
  });

  it("keeps a page with a child page (even in the trash), a share, a version, page fields or a publication version", async () => {
    const parent = await blank();
    const child = await blank();
    // 旧データの親ページ（note のまま子を持つ）。movePage はフォルダにしか入れないので直に書く
    await pool.query("UPDATE pages SET parent = $2 WHERE id = $1", [child, parent]);
    assert.equal(await store.deletePage(OWNER, child), "deleted");

    const shared = await blank();
    assert.ok((await enableShare(pool, OWNER, shared))?.shared);

    const versioned = await blank();
    await pool.query("INSERT INTO page_versions (page_id, version, blocks, reason) VALUES ($1, 1, '[]'::jsonb, 'ai')", [versioned]);

    const fielded = await blank();
    await savePageFields(pool, OWNER, fielded, { terms: [{ term: "合成の語", reading: "", variants: [], note: "" }] });

    const published = await blank();
    await pool.query(
      `INSERT INTO publication_versions (page_id, version, handle, snapshot) VALUES ($1::uuid, 1, 'exp', jsonb_build_object('id', $1::text, 'version', 1, 'dest', 'exp'))`,
      [published],
    );

    for (const [label, id] of [["child", parent], ["share", shared], ["version", versioned], ["fields", fielded], ["publication", published]] as const) {
      assert.deepEqual(await store.discardEmptyPage(OWNER, id), { discarded: false }, label);
      assert.equal(await exists(id), true, label);
    }
  });

  it("answers null for someone else's page, a trashed page and ids that are not pages", async () => {
    const theirs = await blank(OTHER);
    assert.equal(await store.discardEmptyPage(OWNER, theirs), null);
    assert.equal(await exists(theirs), true);
    const trashed = await blank();
    assert.equal(await store.deletePage(OWNER, trashed), "deleted");
    assert.equal(await store.discardEmptyPage(OWNER, trashed), null);
    assert.equal(await exists(trashed), true, "a trashed page waits for the trash purge");
    assert.equal(await store.discardEmptyPage(OWNER, randomUUID()), null);
    assert.equal(await store.discardEmptyPage(OWNER, "not-a-uuid"), null);
  });

  it("does not discard when an image upload starts at the same moment (the page lock serializes them)", async () => {
    const id = await blank();
    const [started, discarded] = await Promise.all([startImage(id), store.discardEmptyPage(OWNER, id)]);
    if (discarded?.discarded) {
      // 先に消えた: 画像の開始はページが無いので null（何も書かない）
      assert.equal(started, null);
      assert.equal(await exists(id), false);
    } else {
      assert.equal(started?.status, "created");
      assert.equal(await exists(id), true);
    }
  });
});
