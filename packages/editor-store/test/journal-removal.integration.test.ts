import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Pool as PgPool } from "pg";
import { applyMigrations, defaultMigrationsDir, readMigrations } from "../src/migrate.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID と合成の本文だけを使う
const OWNER = "synthetic-journal-owner";
const KINDS_AT_0020 = ["note", "rec", "article", "step"] as const;

async function withSchema(label: string): Promise<{ pool: PgPool; drop: () => Promise<void> }> {
  const { Pool } = await import("pg");
  const schema = `editor_store_${label}_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  return {
    pool,
    drop: async () => {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    },
  };
}

const insert = async (pool: PgPool, kind: string, title: string): Promise<string> =>
  (
    await pool.query<{ id: string }>(
      `INSERT INTO pages (owner, kind, title, blocks) VALUES ($1, $2, $3, '[{"type":"paragraph","content":[{"type":"text","text":"合成の本文"}]}]'::jsonb) RETURNING id`,
      [OWNER, kind, title],
    )
  ).rows[0]!.id;

describe("0020 removes the journal kind", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;
  let dir: string;

  before(async () => {
    ({ pool, drop } = await withSchema("journal0020"));
    dir = await mkdtemp(join(tmpdir(), "editor-store-0020-"));
  });

  after(async () => {
    await drop();
    await rm(dir, { recursive: true, force: true });
  });

  it("turns journal rows into note without touching anything else, and the check refuses journal afterwards", async () => {
    const migrations = fileURLToPath(defaultMigrationsDir);
    const dirUrl = pathToFileURL(`${dir}/`);
    const names = (await readMigrations()).map((file) => file.name);
    const earlier = names.filter((name) => name < "0020");
    assert.ok(earlier.includes("0001_editor_store.sql") && earlier.includes("0008_recording_audio.sql"));
    for (const name of earlier) await copyFile(join(migrations, name), join(dir, name));
    const client = await pool.connect();
    try {
      assert.deepEqual((await applyMigrations(client, dirUrl)).applied, earlier);
      const journal = await insert(pool, "journal", "10月30日（木）");
      const kept = await insert(pool, "article", "記事");
      const note = await insert(pool, "note", "メモ");
      const before = new Map((await pool.query("SELECT * FROM pages")).rows.map((row) => [row.id as string, row as Record<string, unknown>]));

      await copyFile(join(migrations, "0020_remove_journal_kind.sql"), join(dir, "0020_remove_journal_kind.sql"));
      const second = await applyMigrations(client, dirUrl);
      assert.deepEqual(second.applied, ["0020_remove_journal_kind.sql"]);
      assert.deepEqual(second.skipped, earlier);

      const after = new Map((await pool.query("SELECT * FROM pages")).rows.map((row) => [row.id as string, row as Record<string, unknown>]));
      assert.equal(after.size, 3, "no row is added or removed");
      assert.equal(after.get(journal)!.kind, "note");
      assert.deepEqual({ ...after.get(journal)!, kind: "journal" }, before.get(journal), "only kind changed (title, blocks, times stay)");
      assert.deepEqual(after.get(kept), before.get(kept));
      assert.deepEqual(after.get(note), before.get(note));

      await assert.rejects(insert(pool, "journal", "x"), (error: { code?: string }) => error.code === "23514");
      // 0020 の時点の種類の集合（folder は後の 20261106161433 で足す）
      for (const kind of KINDS_AT_0020) await insert(pool, kind, `kind ${kind}`);
    } finally {
      client.release();
    }
  });
});
