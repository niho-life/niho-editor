import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { applyMigrations } from "../src/migrate.ts";
import { getEditorSettings, saveEditorSettings } from "../src/settings.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe("editor settings persistence (Issue #220)", { skip: databaseUrl === undefined }, () => {
  const schema = "editor_settings_" + randomUUID().replaceAll("-", "");
  let pool: PgPool;

  before(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl, max: 2, options: "-c search_path=" + schema });
    await pool.query('CREATE SCHEMA "' + schema + '"');
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
  });

  after(async () => {
    await pool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    await pool.end();
  });

  it("round-trips a per-user name and preserves the previous free-text field", async () => {
    const owner = "synthetic-about-" + randomUUID();
    await saveEditorSettings(pool, owner, { about: "既存の本人説明です。" });
    const saved = await saveEditorSettings(pool, owner, { aboutName: "合成の呼び名" });
    assert.equal(saved.aboutName, "合成の呼び名");
    assert.equal(saved.about, "既存の本人説明です。");
    assert.deepEqual(await getEditorSettings(pool, owner), saved);

    await assert.rejects(
      () => pool.query("UPDATE editor_settings SET about_name = $2 WHERE owner = $1", [owner, "あ".repeat(81)]),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "23514",
    );
  });

  it("saves the public author introduction apart from the other fields, null clearing it (and the table keeps the limits)", async () => {
    const owner = "synthetic-author-" + randomUUID();
    const fresh = await getEditorSettings(pool, owner);
    assert.deepEqual([fresh.authorRole, fresh.authorBio], [null, null]);
    // The first save of a row may carry only the introduction
    const first = await saveEditorSettings(pool, owner, { authorRole: "合成の肩書" });
    assert.deepEqual([first.authorRole, first.authorBio], ["合成の肩書", null]);
    const both = await saveEditorSettings(pool, owner, { authorBio: "合成の\n紹介文" });
    assert.deepEqual([both.authorRole, both.authorBio], ["合成の肩書", "合成の 紹介文"]);
    // Other fields leave it as it is; null clears one field only
    assert.equal((await saveEditorSettings(pool, owner, { aboutName: "合成" })).authorRole, "合成の肩書");
    const cleared = await saveEditorSettings(pool, owner, { authorRole: null });
    assert.deepEqual([cleared.authorRole, cleared.authorBio], [null, "合成の 紹介文"]);
    assert.deepEqual(await getEditorSettings(pool, owner), cleared);
    for (const [column, length] of [["author_role", 121], ["author_bio", 601]] as const) {
      await assert.rejects(
        () => pool.query(`UPDATE editor_settings SET ${column} = $2 WHERE owner = $1`, [owner, "あ".repeat(length)]),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "23514",
        column,
      );
    }
  });

  it("keeps the Web search switch on by default and saves it apart from the other fields (#283)", async () => {
    const owner = "synthetic-web-search-" + randomUUID();
    assert.equal((await getEditorSettings(pool, owner)).webSearch, true);
    assert.equal((await saveEditorSettings(pool, owner, { aboutName: "合成" })).webSearch, true);
    const off = await saveEditorSettings(pool, owner, { webSearch: false });
    assert.equal(off.webSearch, false);
    assert.equal(off.aboutName, "合成");
    assert.equal((await saveEditorSettings(pool, owner, { aiLang: "ja" })).webSearch, false);
    assert.equal((await getEditorSettings(pool, owner)).webSearch, false);
  });
});
