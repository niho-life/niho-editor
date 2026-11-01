import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { MIGRATION_FILE_PATTERN, migrationBody, readMigrations } from "../src/migrate.ts";
import { EditorStore, InvalidPageCursorError, isPageId } from "../src/store.ts";
import type { Database } from "../src/types.ts";

const TABLES = ["pages", "page_versions", "assets", "publications"] as const;

/**
 * 取り合いを見つけるための印。連番（`0008_…`）は人が選ぶ番号なので、4 桁の番号が同じなら衝突とみなす。
 * 日時（`20261101153000_…`）は取り合いが起きない作りで、同じ秒でも名前が違えば両方入る（new-migration-cli.ts）ので、
 * 名前そのものを印にする。先頭 4 文字だけを見ると、同じ年の日時の名前がすべて衝突する（`2026`）。
 */
function migrationKey(name: string): string {
  return /^\d{4}_/.test(name) ? name.slice(0, 4) : name;
}

/** SQL の行コメントを除いた本文（列の名前の検査をコメントの言葉で誤らないように）。 */
function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Remove executable bodies so trigger/function code is not mistaken for migration seed data. */
function withoutRoutineBodies(sql: string): string {
  return sql
    .replace(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b[\s\S]*?\bAS\s+(\$[A-Za-z0-9_]*\$)[\s\S]*?\1\s*;/gi, "")
    .replace(/\bDO\s+(\$[A-Za-z0-9_]*\$)[\s\S]*?\1\s*;/gi, "");
}

function tableBody(sql: string, table: string): string {
  return sql.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`))?.[1] ?? "";
}

/**
 * 秘密の列の検査から外す、ただ 1 つの列: 0004 の共有リンクの token（#34）。256 bit の乱数で、形をこの CHECK に限っている
 * （任意の秘密・資格情報を入れられない）。リンクを何度も表示するため平文で持つ（設計の決定）。この定義と完全に同じときだけ外す。
 */
const SHARE_TOKEN_COLUMN = "token text NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{43}$')";

describe("migration files", () => {
  it("are numbered, unique, sorted .sql files wrapped in one transaction", async () => {
    const names = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => !name.startsWith("."));
    assert.ok(names.length > 0);
    for (const name of names) assert.match(name, MIGRATION_FILE_PATTERN, `${name} does not follow NNNN_name.sql`);
    const keys = names.map(migrationKey);
    assert.equal(new Set(keys).size, keys.length, "migration numbers (or timestamps) must be unique");
    const files = await readMigrations();
    assert.deepEqual(files.map((file) => file.name), [...names].sort());
    for (const file of files) assert.doesNotThrow(() => migrationBody(file));
  });

  it("tells numbered and timestamped names apart: same-year timestamps do not collide, a taken number does", () => {
    const unique = (names: string[]) => new Set(names.map(migrationKey)).size === names.length;
    assert.ok(unique(["0001_init.sql", "0020_remove_journal_kind.sql", "20261101153000_recipes.sql", "20261102090000_folders.sql"]));
    // 同じ秒でも名前が違えば別の migration（どちらも入る）
    assert.ok(unique(["20261101153000_recipes.sql", "20261101153000_folders.sql"]));
    // 人が選ぶ連番の取り合いは、これまでどおり見つける
    assert.ok(!unique(["0008_a.sql", "0008_b.sql"]));
  });

  it("0020 drops the journal kind:the check is replaced and existing journal rows become note, nothing else is touched", async () => {
    const file = (await readMigrations()).find((item) => item.name === "0020_remove_journal_kind.sql");
    assert.ok(file, "0020 is in the ordered list");
    const sql = withoutComments(file.sql);
    assert.match(sql, /ALTER TABLE pages DROP CONSTRAINT pages_kind_check;/);
    assert.match(sql, /UPDATE pages SET kind = 'note' WHERE kind = 'journal';/);
    assert.match(sql, /ADD CONSTRAINT pages_kind_check CHECK \(kind IN \('note', 'rec', 'article', 'step'\)\)/);
    // 行は kind しか書き換えない
    assert.equal((sql.match(/\bUPDATE\b/g) ?? []).length, 1);
    assert.doesNotMatch(sql, /\b(DELETE|TRUNCATE|DROP TABLE|DROP COLUMN)\b/);
  });

  it("refuses a migration that is not wrapped in BEGIN/COMMIT", () => {
    assert.throws(() => migrationBody({ name: "0099_bad.sql", sql: "CREATE TABLE x (id int);\n" }), /BEGIN/);
  });

  it("declares the four tables with the documented columns and checks", async () => {
    const [first] = await readMigrations();
    assert.ok(first);
    const sql = withoutComments(first.sql);
    for (const table of TABLES) assert.ok(tableBody(sql, table).length > 0, `missing table ${table}`);

    const pages = tableBody(sql, "pages");
    for (const column of ["id uuid PRIMARY KEY DEFAULT gen_random_uuid()", "owner text NOT NULL", "kind text", "title text", "lang text", "blocks jsonb", "cover uuid", "lead text", "parent uuid", "recipe text", "step_status text", "created_at timestamptz", "updated_at timestamptz", "deleted_at timestamptz"]) {
      assert.ok(pages.includes(column), `pages.${column}`);
    }
    assert.match(pages, /kind IN \('note', 'journal', 'rec', 'article', 'step'\)/);
    assert.match(pages, /lang IN \('ja', 'en'\)/);
    assert.match(pages, /step_status IN \('done', 'run', 'wait', 'stale'\)/);
    assert.match(pages, /jsonb_typeof\(blocks\) = 'array'/);
    assert.match(pages, /FOREIGN KEY \(owner, parent\) REFERENCES pages \(owner, id\)/);
    assert.match(sql, /CREATE INDEX pages_owner_updated_idx\s+ON pages \(owner, updated_at DESC\)\s+WHERE deleted_at IS NULL;/);

    const versions = tableBody(sql, "page_versions");
    assert.match(versions, /reason IN \('autosave', 'ai', 'publish'\)/);
    assert.match(versions, /PRIMARY KEY \(page_id, version\)/);

    const assets = tableBody(sql, "assets");
    for (const column of ["id uuid", "owner text", "page_id uuid", "kind text", "bucket_path text", "bytes bigint", "sha256 text", "content_type text", "alt text", "credit text", "consent boolean"]) {
      assert.ok(assets.includes(column), `assets.${column}`);
    }
    assert.match(assets, /kind IN \('image', 'audio'\)/);
    assert.match(assets, /FOREIGN KEY \(owner, page_id\) REFERENCES pages \(owner, id\)/);

    const publications = tableBody(sql, "publications");
    for (const column of ["page_id uuid PRIMARY KEY", "dest text", "slug text", "range text", "published_version integer", "category text", "related jsonb", "extras jsonb", "published_at timestamptz", "stopped_at timestamptz"]) {
      assert.ok(publications.includes(column), `publications.${column}`);
    }
    assert.match(publications, /range IN \('live', 'unlisted'\)/);
    assert.match(publications, /UNIQUE \(dest, slug\)/);
  });

  it("adds the revision, widens the version reasons, and indexes the trash in 0002 without touching 0001", async () => {
    const files = await readMigrations();
    const second = files.find((file) => file.name === "0002_versions_and_trash.sql");
    assert.ok(second);
    const sql = withoutComments(second.sql);
    assert.match(sql, /ALTER TABLE pages\s+ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK \(revision > 0\);/);
    assert.match(sql, /DROP CONSTRAINT page_versions_reason_check;/);
    assert.match(sql, /CHECK \(reason IN \('autosave', 'ai', 'publish', 'overwrite', 'restore'\)\)/);
    assert.match(sql, /CREATE INDEX pages_owner_deleted_idx\s+ON pages \(owner, deleted_at DESC\)\s+WHERE deleted_at IS NOT NULL;/);
    assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN)\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b/i, "0002 must keep every existing row");
  });

  it("contains no records, secrets, credentials, real addresses, or token columns", async () => {
    for (const file of await readMigrations()) {
      const sql = file.sql;
      // COPY は文としてだけ見る（0009 の値 'copy-on-import' は文ではない）
      assert.doesNotMatch(withoutRoutineBodies(sql), /\bINSERT\s+INTO\b|\bCOPY\s/i, `${file.name} must not carry records`);
      assert.doesNotMatch(sql, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      assert.doesNotMatch(sql, /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, "credential URL");
      assert.doesNotMatch(sql, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, "e-mail address");
      assert.doesNotMatch(sql, /\/Users\/|\/home\//, "absolute user path");
      const columns = withoutComments(sql).replace(SHARE_TOKEN_COLUMN, "");
      assert.doesNotMatch(columns, /\b(email|password|secret|token|cookie|access_key)\w*\s+(text|bytea|jsonb)/i, "secret-bearing column");
    }
  });
});

describe("EditorStore without a database", () => {
  const untouchable: Database = {
    query: (() => {
      throw new Error("must not reach the database");
    }) as unknown as Database["query"],
    connect: (() => {
      throw new Error("must not reach the database");
    }) as unknown as Database["connect"],
  };

  it("treats ids that are not UUIDs as missing without querying", async () => {
    const store = new EditorStore(untouchable);
    for (const id of ["", "not-a-uuid", "123", "{6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11}", "6f1d0d7c6f6c4c399a526a1f3b1c0d11", "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11' OR '1'='1"]) {
      assert.equal(isPageId(id), false, id);
      assert.equal(await store.getPage("stub-user", id), null);
      assert.equal(await store.savePage("stub-user", id, { title: "x" }, { baseRevision: 1 }), null);
      assert.equal(await store.createVersion("stub-user", id, "ai"), null);
      assert.equal(await store.listVersions("stub-user", id), null);
      assert.equal(await store.getVersion("stub-user", id, 1), null);
      assert.equal(await store.restoreVersion("stub-user", id, 1, { baseRevision: 1, accept: () => [] }), null);
      assert.equal(await store.deletePage("stub-user", id), null);
      assert.equal(await store.restoreFromTrash("stub-user", id), false);
    }
    assert.equal(isPageId("6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11"), true);
  });

  it("rejects a malformed list cursor without querying", async () => {
    const store = new EditorStore(untouchable);
    for (const cursor of ["", "next", "2030-01-02T03:04:05.123456Z_not-a-uuid", "2030-01-02T03:04:05Z_6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11"]) {
      await assert.rejects(() => store.listPageChunk("stub-user", { cursor }), InvalidPageCursorError);
    }
  });

  it("refuses an empty owner instead of reading rows of nobody", async () => {
    const store = new EditorStore(untouchable);
    await assert.rejects(() => store.listPages(""), TypeError);
    await assert.rejects(() => store.listPageChunk(""), TypeError);
    await assert.rejects(() => store.getPage("", "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11"), TypeError);
    await assert.rejects(() => store.createPage(""), TypeError);
    await assert.rejects(() => store.listTrash(""), TypeError);
    await assert.rejects(() => store.deletePage("", "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11"), TypeError);
  });

  it("refuses a save or a restore without a positive integer baseRevision, and version numbers that are not positive integers", async () => {
    const store = new EditorStore(untouchable);
    const id = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
    for (const baseRevision of [0, -1, 1.5, Number.NaN, 2 ** 31, "1" as unknown as number, undefined as unknown as number]) {
      await assert.rejects(() => store.savePage("stub-user", id, { title: "x" }, { baseRevision }), TypeError, String(baseRevision));
      await assert.rejects(() => store.restoreVersion("stub-user", id, 1, { baseRevision, accept: () => [] }), TypeError, String(baseRevision));
    }
    for (const version of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
      assert.equal(await store.getVersion("stub-user", id, version), null, String(version));
      assert.equal(await store.restoreVersion("stub-user", id, version, { baseRevision: 1, accept: () => [] }), null, String(version));
    }
    await assert.rejects(() => store.createVersion("stub-user", id, "manual" as never), TypeError);
    await assert.rejects(() => store.purgeTrash({ olderThanDays: 0 }), RangeError);
    await assert.rejects(() => store.purgeTrash({ olderThanDays: 1.5 }), RangeError);
    assert.throws(() => new EditorStore(untouchable, { autosaveVersionIntervalMs: -1 }), RangeError);
  });
});
