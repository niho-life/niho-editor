import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { applyMigrations, defaultMigrationsDir } from "../src/migrate.ts";
import { getMediaStorageUsage } from "../src/storage-usage.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const OWNER = "synthetic-storage-owner-a";
const OTHER = "synthetic-storage-owner-b";
const SHA = "a".repeat(64);

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

describe("cloud media usage on PostgreSQL", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;

  before(async () => {
    ({ pool, drop } = await withSchema("storageusage"));
    const client = await pool.connect();
    try {
      await applyMigrations(client, defaultMigrationsDir);
    } finally {
      client.release();
    }
  });

  after(async () => {
    await drop();
  });

  it("counts ready images and uploaded unexpired audio for one owner, including trash", async () => {
    const page = async (owner: string, kind = "note", trash = false): Promise<string> => {
      const row = await pool.query<{ id: string }>("INSERT INTO pages (owner, kind) VALUES ($1, $2) RETURNING id", [owner, kind]);
      const id = row.rows[0]!.id;
      if (trash) await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [id]);
      return id;
    };
    const asset = async (owner: string, pageId: string, kind: "image" | "audio", bytes: number, status = "ready"): Promise<string> => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO assets (id, owner, page_id, kind, bucket_path, bytes, sha256, content_type, upload_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, owner, pageId, kind, `${kind}/${id}`, bytes, SHA, kind === "image" ? "image/png" : "audio/mp4", status],
      );
      return id;
    };
    const recording = async (owner: string, pageId: string, assetId: string, status: "uploaded" | "uploading", expires: string | null) => {
      await pool.query(
        `INSERT INTO page_recordings (page_id, owner, source, language, segments, audio_asset, audio_status, audio_expires_at)
         VALUES ($1, $2, 'audio', 'ja', '[]'::jsonb, $3, $4, $5)`,
        [pageId, owner, assetId, status, expires],
      );
    };

    const livePage = await page(OWNER);
    await asset(OWNER, livePage, "image", 10);
    const trashedPage = await page(OWNER, "note", true);
    await asset(OWNER, trashedPage, "image", 20);
    await asset(OWNER, livePage, "image", 100, "uploading");

    const currentAudioPage = await page(OWNER, "rec");
    const currentAudio = await asset(OWNER, currentAudioPage, "audio", 30);
    await recording(OWNER, currentAudioPage, currentAudio, "uploaded", "2099-01-01T00:00:00Z");

    const expiredAudioPage = await page(OWNER, "rec");
    const expiredAudio = await asset(OWNER, expiredAudioPage, "audio", 40);
    await recording(OWNER, expiredAudioPage, expiredAudio, "uploaded", "2000-01-01T00:00:00Z");

    const uploadingAudioPage = await page(OWNER, "rec");
    const uploadingAudio = await asset(OWNER, uploadingAudioPage, "audio", 50);
    await recording(OWNER, uploadingAudioPage, uploadingAudio, "uploading", "2099-01-01T00:00:00Z");

    const partPage = await page(OWNER, "rec", true);
    const partAudio = await asset(OWNER, partPage, "audio", 60);
    await pool.query(
      `INSERT INTO page_recording_audios (page_id, owner, part_index, asset, status, offset_sec, expires_at)
       VALUES ($1, $2, 1, $3, 'uploaded', 0, NULL)`,
      [partPage, OWNER, partAudio],
    );

    const anotherOwnerPage = await page(OTHER);
    await asset(OTHER, anotherOwnerPage, "image", 999);

    assert.deepEqual(await getMediaStorageUsage(pool, OWNER), { imageBytes: "30", audioBytes: "90", totalBytes: "120" });
    assert.deepEqual(await getMediaStorageUsage(pool, OTHER), { imageBytes: "999", audioBytes: "0", totalBytes: "999" });
  });

  it("returns zeroes when the owner has no assets", async () => {
    assert.deepEqual(await getMediaStorageUsage(pool, "synthetic-empty-owner"), { imageBytes: "0", audioBytes: "0", totalBytes: "0" });
  });
});
