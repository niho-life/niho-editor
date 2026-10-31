import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import type { Pool as PgPool } from "pg";
import { MIGRATION_FILE_PATTERN, applyMigrations, defaultMigrationsDir } from "../src/migrate.ts";
import { EditorStore } from "../src/store.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const OWNER = "synthetic-owner-a";

describe("migration 0002 on a database that already has pages and versions", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_store_upgrade_${randomUUID().replaceAll("-", "")}`;
  let pool: PgPool;
  let onlyFirst: string;

  before(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    // 0001 だけを置いた migration の置き場（中身は同じファイルなので checksum も同じ）
    onlyFirst = await mkdtemp(join(tmpdir(), "editor-store-0001-"));
    await copyFile(new URL("0001_editor_store.sql", defaultMigrationsDir), join(onlyFirst, "0001_editor_store.sql"));
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    await rm(onlyFirst, { recursive: true, force: true });
  });

  it("keeps the rows, starts every page at revision 1, and widens the version reasons", async () => {
    const client = await pool.connect();
    try {
      const first = await applyMigrations(client, pathToFileURL(`${onlyFirst}/`));
      assert.deepEqual(first.applied, ["0001_editor_store.sql"]);

      const page = await client.query<{ id: string }>(
        `INSERT INTO pages (owner, title, blocks) VALUES ($1, '既存の題名', '[{"type":"paragraph","content":[{"type":"text","text":"既存の本文"}]}]') RETURNING id`,
        [OWNER],
      );
      const pageId = page.rows[0]!.id;
      const trashed = await client.query<{ id: string }>(
        "INSERT INTO pages (owner, title, deleted_at) VALUES ($1, 'ゴミ箱の既存', clock_timestamp()) RETURNING id",
        [OWNER],
      );
      await client.query(
        `INSERT INTO page_versions (page_id, version, blocks, reason) VALUES
           ($1, 1, '[{"type":"paragraph"}]', 'autosave'),
           ($1, 2, '[{"type":"paragraph"}]', 'ai'),
           ($1, 3, '[{"type":"paragraph"}]', 'publish')`,
        [pageId],
      );
      await client.query("INSERT INTO publications (page_id, dest, slug, range, published_version) VALUES ($1, 'synthetic', 'existing', 'live', 3)", [pageId]);
      // 0001 の CHECK は新しい理由を断る
      await assert.rejects(() => client.query("INSERT INTO page_versions (page_id, version, blocks, reason) VALUES ($1, 9, '[]', 'restore')", [pageId]), {
        code: "23514",
      });

      // 0002 のあとに足された migration（0003 の検索など）も、ここでいっしょに適用される。このテストが見るのは 0002 の上がり方。
      // 0009 は 0001 の publications を作り直す（行があれば止まる）ので、ここでは 0008 までを流す（0009 は publications.integration.test.ts）
      for (const name of await readdir(defaultMigrationsDir)) {
        if (MIGRATION_FILE_PATTERN.test(name) && name < "0009") await copyFile(new URL(name, defaultMigrationsDir), join(onlyFirst, name));
      }
      const second = await applyMigrations(client, pathToFileURL(`${onlyFirst}/`));
      assert.equal(second.applied[0], "0002_versions_and_trash.sql");
      assert.deepEqual(second.skipped, ["0001_editor_store.sql"]);

      const row = async (id: string) =>
        (await client.query<{ title: string; revision: number; deleted: boolean }>(
          "SELECT title, revision, deleted_at IS NOT NULL AS deleted FROM pages WHERE id = $1",
          [id],
        )).rows[0];
      assert.equal((await client.query("SELECT 1 FROM pages")).rows.length, 2);
      assert.deepEqual(await row(pageId), { title: "既存の題名", revision: 1, deleted: false });
      assert.deepEqual(await row(trashed.rows[0]!.id), { title: "ゴミ箱の既存", revision: 1, deleted: true });
      const versions = await client.query<{ version: number; reason: string }>("SELECT version, reason FROM page_versions WHERE page_id = $1 ORDER BY version", [pageId]);
      assert.deepEqual(versions.rows.map((row) => [row.version, row.reason]), [[1, "autosave"], [2, "ai"], [3, "publish"]]);
      assert.equal((await client.query("SELECT 1 FROM publications WHERE page_id = $1 AND published_version = 3", [pageId])).rows.length, 1);

      for (const [version, reason] of [[4, "overwrite"], [5, "restore"]] as const) {
        await client.query("INSERT INTO page_versions (page_id, version, blocks, reason) VALUES ($1, $2, '[]', $3)", [pageId, version, reason]);
      }
      await assert.rejects(() => client.query("INSERT INTO page_versions (page_id, version, blocks, reason) VALUES ($1, 9, '[]', 'manual')", [pageId]), {
        code: "23514",
      });
      await assert.rejects(() => client.query("UPDATE pages SET revision = 0 WHERE id = $1", [pageId]), { code: "23514" });

      // ここから先は store（今の schema を読む）で確かめるので、残りの migration も流す。0009 は 0001 の publications を
      // 作り直す（行があれば止まる）ので、上で確かめ終えた公開の行だけ外してから流す
      await client.query("DELETE FROM publications WHERE page_id = $1", [pageId]);
      for (const name of await readdir(defaultMigrationsDir)) {
        if (MIGRATION_FILE_PATTERN.test(name)) await copyFile(new URL(name, defaultMigrationsDir), join(onlyFirst, name));
      }
      const rest = await applyMigrations(client, pathToFileURL(`${onlyFirst}/`));
      assert.ok(rest.applied.includes("0009_publications.sql"), "0009 から先も、既存の行を持つ DB に流せる");

      // 既存のページはそのまま store で読み書きでき、版の番号は既存の続きから
      const store = new EditorStore(pool, { autosaveVersionIntervalMs: 0 });
      const read = await store.getPage(OWNER, pageId);
      assert.equal(read?.revision, 1);
      const saved = await store.savePage(OWNER, pageId, { blocks: [{ type: "paragraph", content: [{ type: "text", text: "新しい本文" }] }] }, { baseRevision: 1 });
      assert.equal(saved?.status, "saved");
      assert.equal(saved?.page.revision, 2);
      assert.equal((await store.listVersions(OWNER, pageId))?.[0]?.version, 6);
      assert.ok((await store.listTrash(OWNER)).some((item) => item.id === trashed.rows[0]!.id));
    } finally {
      client.release();
    }
  });
});
