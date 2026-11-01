import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { MIGRATIONS_TABLE, applyMigrations, readMigrations } from "../src/migrate.ts";
import { EditorStore, InvalidPageCursorError } from "../src/store.ts";
import type { Page, SaveResult } from "../src/types.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID だけを使う（実在の人の値を入れない）
const OWNER = "synthetic-owner-a";
const OTHER = "synthetic-owner-b";

function expectSaved(result: SaveResult | null): Page {
  assert.ok(result !== null && result.status === "saved", `expected a save, got ${result === null ? "null" : result.status}`);
  return result.page;
}

describe("PostgreSQL editor store", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_store_test_${randomUUID().replaceAll("-", "")}`;
  let pool: PgPool;

  async function newPool(): Promise<PgPool> {
    const { Pool } = await import("pg");
    return new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
  }

  before(async () => {
    pool = await newPool();
    await pool.query(`CREATE SCHEMA "${schema}"`);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("applies every migration to an empty schema once and creates exactly the documented tables without rows", async () => {
    const client = await pool.connect();
    try {
      const names = (await readMigrations()).map((file) => file.name);
      const first = await applyMigrations(client);
      assert.deepEqual(first.applied, names);
      const second = await applyMigrations(client);
      assert.deepEqual(second.applied, []);
      assert.deepEqual(second.skipped, names);
    } finally {
      client.release();
    }
    const tables = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
      [schema],
    );
    // page_shares は共有リンク（0004）、ai_usage は AI の使用量（0005）、step_runs・step_attempts は手順の実行（0006。ページの表とは別）、page_recordings は録音の文字起こし（0007）、
    // transcription_runs は文字起こしの実行（0012）、editor_settings はアカウントの設定（0013）、ai_conversations・ai_messages・ai_message_changes は AI チャット、ai_usage_device は CLI の使用量（0022・0025）
    // page_recording_audios は 2 本目以降の音声・page_recording_candidates は文字起こしの案（#36 段 3b-4）、recipes は手順（#37）
    // publications（作り直し）・publication_versions・publication_redirects・site_connections・site_connection_keys・preview_tokens は公開（0009）
    const documented = [
      "pages",
      "page_versions",
      "assets",
      "publications",
      "page_shares",
      "step_runs",
      "step_attempts",
      "ai_usage",
      "page_recordings",
      "publication_versions",
      "publication_redirects",
      "site_connections",
      "site_connection_keys",
      "preview_tokens",
      "transcription_runs",
      "editor_settings",
      "page_recording_audios",
      "page_recording_candidates",
      "ai_conversations",
      "ai_messages",
      "ai_message_changes",
      "ai_usage_device",
      "recipes",
      "page_fields",
      "page_opens",
      // P02: 本人所有の写真、容量予約、補正・版・mediaと物理削除の台帳
      "photo_libraries",
      "photos",
      "photo_assets",
      "photo_uploads",
      "photo_mutations",
      "photo_recipe_revisions",
      "photo_recipes",
      "photo_versions",
      "photo_media_jobs",
      "photo_purge_jobs",
      "photo_gc_objects",
    ];
    assert.deepEqual(tables.rows.map((row) => row.table_name), [...documented, MIGRATIONS_TABLE].sort());
    for (const table of documented) {
      const count = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
      assert.equal(count.rows[0]?.n, "0", `${table} must be empty after migration`);
    }
    const index = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'pages_owner_updated_idx'",
      [schema],
    );
    assert.match(index.rows[0]?.indexdef ?? "", /\(owner, updated_at DESC\) WHERE \(deleted_at IS NULL\)/);
  });

  it("refuses a migration that was edited after it was applied", async () => {
    const client = await pool.connect();
    try {
      await client.query(`UPDATE ${MIGRATIONS_TABLE} SET checksum = $1 WHERE name = '0001_editor_store.sql'`, ["0".repeat(64)]);
      await assert.rejects(() => applyMigrations(client), /changed after it was applied/);
    } finally {
      const [file] = await readMigrations();
      await client.query(`UPDATE ${MIGRATIONS_TABLE} SET checksum = $1 WHERE name = '0001_editor_store.sql'`, [file?.checksum]);
      client.release();
    }
  });

  it("creates an empty page, saves it, and reads it back from a new connection", async () => {
    const store = new EditorStore(pool);
    const created = await store.createPage(OWNER);
    assert.equal(created.title, "");
    assert.deepEqual(created.blocks, []);
    assert.equal(created.kind, "note");
    assert.equal(created.lang, "ja");

    assert.equal(created.revision, 1);

    const blocks = [{ type: "paragraph", content: [{ type: "text", text: "合成の本文" }] }];
    const saved = expectSaved(await store.savePage(OWNER, created.id, { title: "合成の題名", blocks }, { baseRevision: created.revision }));
    assert.ok(Date.parse(saved.updatedAt) >= Date.parse(created.updatedAt));
    assert.equal(saved.revision, 2, "every save bumps the revision");

    const again = expectSaved(await store.savePage(OWNER, created.id, { lang: "en" }, { baseRevision: saved.revision }));
    assert.equal(again.title, "合成の題名", "a partial patch keeps the other fields");
    assert.ok(Date.parse(again.updatedAt) >= Date.parse(saved.updatedAt));
    assert.equal(again.revision, 3);

    const otherPool = await newPool();
    try {
      const read = await new EditorStore(otherPool).getPage(OWNER, created.id);
      assert.ok(read);
      assert.equal(read.title, "合成の題名");
      assert.equal(read.lang, "en");
      assert.deepEqual(read.blocks, blocks);
      assert.equal(read.revision, 3);
    } finally {
      await otherPool.end();
    }
  });

  it("hides pages of another owner, deleted pages, unknown ids, and malformed ids alike", async () => {
    const store = new EditorStore(pool);
    const mine = await store.createPage(OWNER, { title: "mine" });
    const theirs = await store.createPage(OTHER, { title: "theirs" });
    const removed = await store.createPage(OWNER, { title: "removed" });
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [removed.id]);

    for (const id of [theirs.id, removed.id, randomUUID(), "not-a-uuid", "00000000-0000-0000-0000-00000000000g"]) {
      assert.equal(await store.getPage(OWNER, id), null, id);
      assert.equal(await store.savePage(OWNER, id, { title: "overwrite" }, { baseRevision: 1 }), null, id);
      assert.equal(await store.savePage(OWNER, id, { title: "overwrite" }, { baseRevision: 99 }), null, `${id} is missing, not in conflict`);
    }
    const untouched = await store.getPage(OTHER, theirs.id);
    assert.equal(untouched?.title, "theirs", "another owner's page is not changed");

    const list = await store.listPages(OWNER);
    const ids = list.map((page) => page.id);
    assert.ok(ids.includes(mine.id));
    assert.ok(!ids.includes(theirs.id));
    assert.ok(!ids.includes(removed.id));
    for (let index = 1; index < list.length; index++) {
      assert.ok(Date.parse(list[index - 1]!.updatedAt) >= Date.parse(list[index]!.updatedAt), "list is newest first");
    }
  });

  it("pages through the list in chunks, exactly once each, even when many pages share updated_at", async () => {
    const owner = "synthetic-owner-chunks";
    const store = new EditorStore(pool);
    const ids: string[] = [];
    for (let index = 0; index < 11; index++) ids.push((await store.createPage(owner, { title: `chunk ${index}` })).id);
    // 7 行を同じ時刻（マイクロ秒まで）にし、残りは別々の時刻にする
    await pool.query("UPDATE pages SET updated_at = timestamptz '2030-01-02 03:04:05.123456+00' WHERE id = ANY($1::uuid[])", [ids.slice(0, 7)]);
    await pool.query("UPDATE pages SET updated_at = timestamptz '2030-01-02 03:04:05.123457+00' WHERE id = $1", [ids[7]]);
    await pool.query("UPDATE pages SET updated_at = timestamptz '2030-01-02 03:04:05.123455+00' WHERE id = ANY($1::uuid[])", [ids.slice(8)]);
    const parent = await store.createPage(OTHER, { title: "theirs" });
    const removed = await store.createPage(owner, { title: "removed" });
    // ゴミ箱へ入れたページは一覧に出さない（#58 の deletePage と同じ規則で読む）
    assert.equal(await store.deletePage(owner, removed.id), "deleted");
    await pool.query("UPDATE pages SET parent = $2, step_status = 'run' WHERE id = $1", [ids[1], ids[0]]);

    const expected = await pool.query<{ id: string }>(
      "SELECT id FROM pages WHERE owner = $1 AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC",
      [owner],
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    let chunks = 0;
    do {
      const chunk = await store.listPageChunk(owner, { limit: 3, cursor });
      assert.ok(chunk.pages.length <= 3);
      seen.push(...chunk.pages.map((page) => page.id));
      cursor = chunk.next;
      chunks++;
      assert.ok(chunks < 20, "the cursor must advance");
    } while (cursor !== null);
    assert.equal(chunks, 4);
    assert.deepEqual(seen, expected.rows.map((row) => row.id), "every page once, newest first, ties by id");
    assert.equal(new Set(seen).size, 11);
    assert.ok(!seen.includes(removed.id), "deleted pages never appear");
    assert.ok(!seen.includes(parent.id), "another owner's pages never appear");

    const all = await store.listPageChunk(owner, { limit: 11 });
    assert.equal(all.next, null, "no next when everything fit");
    const child = all.pages.find((page) => page.id === ids[1]);
    assert.equal(child?.parent, ids[0]);
    assert.equal(child?.stepStatus, "run");
    assert.equal(all.pages.find((page) => page.id === ids[2])?.parent, null);
    const listed = await store.listPages(owner);
    assert.equal(listed.find((page) => page.id === ids[1])?.parent, ids[0]);

    assert.equal(await store.restoreFromTrash(owner, removed.id), true);
    const restored = await store.listPageChunk(owner, { limit: 20 });
    assert.ok(restored.pages.some((page) => page.id === removed.id), "a page restored from the trash is listed again");
  });

  it("rejects cursors that are not exactly what the list returned", async () => {
    const store = new EditorStore(pool);
    const id = randomUUID();
    for (const cursor of [
      "",
      "x",
      id,
      `2030-01-02T03:04:05.123Z_${id}`,
      `2030-01-02 03:04:05.123456Z_${id}`,
      `2030-01-02T03:04:05.123456Z_${id.toUpperCase()}`,
      `2030-02-30T03:04:05.123456Z_${id}`,
      `2030-13-01T03:04:05.123456Z_${id}`,
      `2030-01-02T03:04:05.123456Z_${id}' OR '1'='1`,
    ]) {
      await assert.rejects(() => store.listPageChunk(OWNER, { cursor }), InvalidPageCursorError, cursor);
    }
    const empty = await store.listPageChunk(OWNER, { cursor: `1970-01-01T00:00:00.000000Z_${id}` });
    assert.deepEqual(empty, { pages: [], next: null });
  });

  it("keeps the database invariants even when the store is bypassed", async () => {
    const page = await new EditorStore(pool).createPage(OWNER);
    await assert.rejects(() => pool.query("INSERT INTO pages (owner, blocks) VALUES ($1, '{}'::jsonb)", [OWNER]), { code: "23514" });
    await assert.rejects(() => pool.query("INSERT INTO pages (owner, kind) VALUES ($1, 'html')", [OWNER]), { code: "23514" });
    await assert.rejects(() => pool.query("INSERT INTO pages (owner, lang) VALUES ($1, 'fr')", [OWNER]), { code: "23514" });
    await assert.rejects(() => pool.query("INSERT INTO pages (owner, step_status) VALUES ($1, 'paused')", [OWNER]), { code: "23514" });
    // 別の owner のページを親にはできない
    await assert.rejects(() => pool.query("INSERT INTO pages (owner, parent) VALUES ($1, $2)", [OTHER, page.id]), { code: "23503" });
    await assert.rejects(
      () => pool.query("INSERT INTO page_versions (page_id, version, blocks, reason) VALUES ($1, 1, '[]', 'manual')", [page.id]),
      { code: "23514" },
    );
    await assert.rejects(
      () => pool.query(
        "INSERT INTO assets (owner, page_id, kind, bucket_path, bytes, sha256, content_type) VALUES ($1, $2, 'image', 'a/b.png', 1, $3, 'image/png')",
        [OTHER, page.id, "a".repeat(64)],
      ),
      { code: "23503" },
    );
    await assert.rejects(
      () => pool.query(
        "INSERT INTO assets (owner, page_id, kind, bucket_path, bytes, sha256, content_type) VALUES ($1, $2, 'image', 'https://example.com/a.png', 1, $3, 'image/png')",
        [OWNER, page.id, "a".repeat(64)],
      ),
      { code: "23514" },
    );
  });
});
