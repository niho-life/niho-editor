import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { getOrCreateNativeAudioCacheNamespace } from "../src/native-audio-cache.ts";
import { applyMigrations } from "../src/migrate.ts";
import type { Pool as PgPool } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
let pool: PgPool;
let schema = "";

describe("native audio cache namespace", { skip: !databaseUrl }, () => {
  before(async () => {
    const { Pool } = await import("pg");
    schema = `editor_store_native_audio_cache_${randomUUID().replaceAll("-", "")}`;
    pool = new Pool({ connectionString: databaseUrl, max: 12, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
  });

  after(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("converges concurrent first requests and remains stable", async () => {
    const owner = `synthetic-native-cache-${randomUUID()}`;
    const first = await Promise.all(Array.from({ length: 8 }, () => getOrCreateNativeAudioCacheNamespace(pool, owner, "niho")));
    assert.equal(new Set(first).size, 1);
    assert.match(first[0]!, /^[0-9a-f-]{36}$/);
    assert.equal(await getOrCreateNativeAudioCacheNamespace(pool, owner, "niho"), first[0]);
  });

  it("separates owner and auth mode", async () => {
    const owner = `synthetic-native-cache-${randomUUID()}`;
    const other = `synthetic-native-cache-${randomUUID()}`;
    const [niho, google, anotherOwner] = await Promise.all([
      getOrCreateNativeAudioCacheNamespace(pool, owner, "niho"),
      getOrCreateNativeAudioCacheNamespace(pool, owner, "google"),
      getOrCreateNativeAudioCacheNamespace(pool, other, "niho"),
    ]);
    assert.equal(new Set([niho, google, anotherOwner]).size, 3);
  });
});
