import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import type { Pool as PgPool } from "pg";
import { applyMigrations, defaultMigrationsDir } from "../src/migrate.ts";
import { applyAppGrants, ensureAppRole } from "../src/provision.ts";
import { EditorStore } from "../src/store.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const PHOTO_MIGRATION = "20261101155422_personal_photo_library.sql";

describe("personal photo schema upgrade on PostgreSQL", { skip: databaseUrl === undefined }, () => {
  const schema = `photo_upgrade_${randomUUID().replaceAll("-", "")}`;
  let pool: PgPool;
  let earlierDir: string;

  before(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    earlierDir = await mkdtemp(join(tmpdir(), "editor-photo-upgrade-"));
    for (const name of await readdir(defaultMigrationsDir)) {
      if (name.endsWith(".sql") && name !== PHOTO_MIGRATION) await copyFile(new URL(name, defaultMigrationsDir), join(earlierDir, name));
    }
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    await rm(earlierDir, { recursive: true, force: true });
  });

  it("adds every photo table to an existing database without changing existing pages", async () => {
    const client = await pool.connect();
    try {
      await applyMigrations(client, pathToFileURL(`${earlierDir}/`));
      const store = new EditorStore(pool);
      const page = await store.createPage("synthetic-existing-owner", { title: "既存ページ", blocks: [{ type: "paragraph", text: "維持" }] });
      const before = await store.getPage("synthetic-existing-owner", page.id);

      await copyFile(new URL(PHOTO_MIGRATION, defaultMigrationsDir), join(earlierDir, PHOTO_MIGRATION));
      const result = await applyMigrations(client, pathToFileURL(`${earlierDir}/`));
      assert.deepEqual(result.applied, [PHOTO_MIGRATION]);
      assert.deepEqual(await store.getPage("synthetic-existing-owner", page.id), before);

      const expected = [
        "photo_libraries", "photos", "photo_assets", "photo_uploads", "photo_mutations", "photo_recipe_revisions",
        "photo_recipes", "photo_versions", "photo_media_jobs", "photo_purge_jobs", "photo_gc_objects",
      ];
      const tables = await pool.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[]) ORDER BY table_name",
        [schema, expected],
      );
      assert.deepEqual(tables.rows.map((row) => row.table_name), [...expected].sort());
    } finally {
      client.release();
    }
  });
});

describe("photo tables through the application role", { skip: databaseUrl === undefined }, () => {
  const schema = `photo_privileges_${randomUUID().replaceAll("-", "")}`;
  const role = `photo_app_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  let admin: PgPool;
  let app: PgPool;

  before(async () => {
    const { Pool } = await import("pg");
    admin = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const client = await admin.connect();
    try {
      await applyMigrations(client);
      await ensureAppRole(client, { role, password });
      await applyAppGrants(client, role, schema);
    } finally {
      client.release();
    }
    const url = new URL(databaseUrl ?? "");
    url.username = role;
    url.password = password;
    app = new Pool({ connectionString: url.toString(), max: 2, options: `-c search_path=${schema}` });
  });

  after(async () => {
    await app?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(`DROP OWNED BY ${role}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it("allows photo DML but rejects DDL and migration-record writes", async () => {
    const owner = `synthetic-role-owner-${randomUUID()}`;
    const created = await app.query<{ id: string }>("INSERT INTO photo_libraries (owner) VALUES ($1) RETURNING id", [owner]);
    assert.ok(created.rows[0]?.id);
    await app.query("UPDATE photo_libraries SET revision = revision + 1 WHERE owner = $1", [owner]);
    assert.equal((await app.query("SELECT revision FROM photo_libraries WHERE owner = $1", [owner])).rows[0].revision, "1");
    await app.query("DELETE FROM photo_libraries WHERE owner = $1", [owner]);
    assert.equal((await app.query("SELECT 1 FROM photo_libraries WHERE owner = $1", [owner])).rowCount, 0);

    await assert.rejects(app.query("ALTER TABLE photo_libraries ADD COLUMN intruder text"), /must be owner|permission denied/);
    await assert.rejects(app.query("CREATE TABLE photo_intruder (id int)"), /permission denied/);
    await assert.rejects(app.query("DELETE FROM editor_store_migrations"), /permission denied/);
  });
});
