import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Pool as PgPool } from "pg";
import { duplicatePage } from "../src/duplicate.ts";
import { applyMigrations, defaultMigrationsDir, readMigrations } from "../src/migrate.ts";
import {
  audioInfo,
  audioObjectPath,
  completeAudioUpload,
  startAudioRecording,
  type StartAudioRecordingInput,
} from "../src/recording-audio.ts";
import { InvalidRecordingError, createRecordingPage, getRecording, type Connectable } from "../src/recordings.ts";
import { createTranscriptTab, ensureRecordingFolder, getTranscript, updateTranscript } from "../src/transcripts.ts";
import { EditorStore } from "../src/store.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID・ファイル名・ハッシュだけを使う（実在の人・実際の音声を入れない）
const OWNER = "synthetic-audio-owner-a";
const OTHER = "synthetic-audio-owner-b";
const DECLARED_SHA = "a".repeat(64);
const HASH_A = "1".repeat(64);
const HASH_B = "2".repeat(64);
const DAY_MS = 24 * 60 * 60 * 1000;

async function withSchema(label: string): Promise<{ pool: PgPool; drop: () => Promise<void> }> {
  const { Pool } = await import("pg");
  const schema = `editor_store_${label}_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema}` });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  return {
    pool,
    drop: async () => {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    },
  };
}

function startInput(extra: Partial<StartAudioRecordingInput> = {}): StartAudioRecordingInput {
  return {
    assetId: randomUUID(),
    title: "合成の打ち合わせ",
    lang: "ja",
    sourceName: "合成の打ち合わせ.m4a",
    contentType: "audio/mp4",
    bytes: 4096,
    sha256: DECLARED_SHA,
    durationSec: 12.5,
    uploadKey: null,
    requestHash: HASH_A,
    retentionDays: 30,
    ...extra,
  };
}

async function count(pool: PgPool, table: "pages" | "assets" | "page_recordings", owner: string): Promise<number> {
  return (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE owner = $1`, [owner])).rows[0]!.n;
}

async function recordingRow(pool: PgPool, pageId: string): Promise<Record<string, unknown> | undefined> {
  return (await pool.query("SELECT * FROM page_recordings WHERE page_id = $1", [pageId])).rows[0];
}

/** store を通さずにページの行を入れる。 */
async function insertPage(pool: PgPool, owner: string = OWNER, kind = "rec"): Promise<string> {
  const result = await pool.query<{ id: string }>("INSERT INTO pages (owner, kind) VALUES ($1, $2) RETURNING id", [owner, kind]);
  return result.rows[0]!.id;
}

/** store を通さずに VTT の録音の行を入れる（今の列。段落は文字起こしのタブが持つので録音の行には無い。#310）。 */
async function insertVttRecording(pool: PgPool, pageId: string, owner: string = OWNER): Promise<void> {
  await pool.query(`INSERT INTO page_recordings (page_id, owner, source, language, engine) VALUES ($1, $2, 'vtt', 'ja', 'vtt-import')`, [pageId, owner]);
}

/** 0007 の列だけの VTT の録音の行（0008 を当てる前の DB。段落は録音の行にあった）。 */
async function insertLegacyVttRecording(pool: PgPool, pageId: string, owner: string = OWNER): Promise<void> {
  await pool.query(
    `INSERT INTO page_recordings (page_id, owner, source, language, engine, segments, speaker_names)
     VALUES ($1, $2, 'vtt', 'ja', 'vtt-import', $3::jsonb, $4::jsonb)`,
    [pageId, owner, JSON.stringify([{ start: 0, end: 1.5, text: "合成の段落", speaker: 1 }]), JSON.stringify({ "1": "合成の話し手" })],
  );
}

/** 指定の SQL だけを失敗させる接続。 */
function failingOn(pool: PgPool, pattern: RegExp): Connectable {
  return {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: ((sql: string, values?: unknown[]) => {
          if (pattern.test(sql)) return Promise.reject(Object.assign(new Error("synthetic failure"), { code: "XX000" }));
          return client.query(sql, values);
        }) as typeof client.query,
        release: (error?: Error | boolean) => client.release(error),
      };
    },
  };
}

describe("0008 on a database that has 0001 to 0007", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;
  let dir: string;

  before(async () => {
    ({ pool, drop } = await withSchema("audio0008"));
    dir = await mkdtemp(join(tmpdir(), "editor-store-0008-"));
  });

  after(async () => {
    await drop();
    await rm(dir, { recursive: true, force: true });
  });

  it("adds the audio columns without touching existing recordings, which read back with audio: null", async () => {
    const migrations = fileURLToPath(defaultMigrationsDir);
    const dirUrl = pathToFileURL(`${dir}/`);
    // 適用済みの一覧は readMigrations() から取る
    const names = (await readMigrations()).map((file) => file.name);
    const earlier = names.filter((name) => name < "0008");
    assert.ok(earlier.includes("0001_editor_store.sql") && earlier.includes("0007_page_recordings.sql"));
    for (const name of earlier) await copyFile(join(migrations, name), join(dir, name));
    const client = await pool.connect();
    try {
      assert.deepEqual((await applyMigrations(client, dirUrl)).applied, earlier);
      const page = await insertPage(pool);
      await insertLegacyVttRecording(pool, page);
      const before = await recordingRow(pool, page);
      assert.ok(before);

      await copyFile(join(migrations, "0008_recording_audio.sql"), join(dir, "0008_recording_audio.sql"));
      const second = await applyMigrations(client, dirUrl);
      assert.deepEqual(second.applied, ["0008_recording_audio.sql"]);
      assert.deepEqual(second.skipped, earlier);

      const afterRow = await recordingRow(pool, page);
      assert.ok(afterRow);
      for (const [column, value] of Object.entries(before)) assert.deepEqual(afterRow[column], value, `${column} is unchanged`);
      assert.equal(afterRow.audio_status, "none");
      for (const column of ["audio_asset", "audio_expires_at", "audio_upload_key", "audio_request_hash"]) assert.equal(afterRow[column], null, column);
      assert.equal(await count(pool, "assets", OWNER), 0, "the migration records nothing");

      // 今のコードは後の migration も前提にするので、残りも入れてから読む
      await applyMigrations(client);
      const recording = await getRecording(pool, OWNER, page);
      assert.ok(recording);
      assert.equal(recording.audio, null);
      assert.equal(recording.source, "vtt");
      assert.equal(recording.language, "ja");
      assert.equal(await audioInfo(pool, OWNER, page), null, "a VTT recording has no audio");
    } finally {
      client.release();
    }
  });
});

describe("recording audio on PostgreSQL", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;

  before(async () => {
    ({ pool, drop } = await withSchema("audio"));
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
  });

  after(async () => {
    await drop();
  });

  it("creates the page, the audio asset and the recording together", async () => {
    const input = startInput();
    const started = await startAudioRecording(pool, OWNER, input);
    assert.equal(started.status, "created");
    assert.ok(started.status === "created");
    assert.equal(started.assetId, input.assetId);
    assert.deepEqual(started.page, { ...started.page, kind: "rec", title: "合成の打ち合わせ", lang: "ja" });

    const page = (await pool.query("SELECT kind, title, lang, blocks, created_at FROM pages WHERE id = $1", [started.page.id])).rows[0];
    assert.deepEqual({ kind: page.kind, title: page.title, lang: page.lang, blocks: page.blocks }, { kind: "rec", title: "合成の打ち合わせ", lang: "ja", blocks: [] });

    const asset = (await pool.query("SELECT * FROM assets WHERE id = $1", [input.assetId])).rows[0];
    assert.equal(asset.owner, OWNER);
    assert.equal(asset.page_id, started.page.id);
    assert.equal(asset.kind, "audio");
    assert.equal(asset.bucket_path, `audio/${input.assetId}`);
    assert.equal(asset.bucket_path, audioObjectPath(input.assetId));
    assert.equal(asset.bytes, "4096");
    assert.equal(asset.sha256, DECLARED_SHA);
    assert.equal(asset.content_type, "audio/mp4");

    const row = await recordingRow(pool, started.page.id);
    assert.ok(row);
    assert.equal(row.source, "audio");
    assert.equal(row.audio_status, "uploading");
    assert.equal(row.audio_asset, input.assetId);
    assert.equal(row.audio_request_hash, HASH_A);
    assert.equal(row.audio_upload_key, null);
    assert.equal(row.source_sha256, null, "the declared hash is not stored as a server-computed hash");
    assert.equal((row.audio_expires_at as Date).getTime() - (page.created_at as Date).getTime(), 30 * DAY_MS);

    const recording = started.recording;
    assert.equal(recording.revision, 1);
    assert.equal(recording.source, "audio");
    assert.equal(recording.engine, null);
    assert.equal(recording.durationSec, 12.5);
    assert.equal(recording.sourceName, "合成の打ち合わせ.m4a");
    assert.equal("segments" in recording, false, "the recording row holds no paragraphs");
    assert.deepEqual(recording.audio, {
      status: "uploading",
      bytes: 4096,
      contentType: "audio/mp4",
      expiresAt: (row.audio_expires_at as Date).toISOString(),
    });
    assert.deepEqual(await getRecording(pool, OWNER, started.page.id), recording, "read back from a new query");
    assert.deepEqual(await audioInfo(pool, OWNER, started.page.id), {
      assetId: input.assetId,
      objectPath: `audio/${input.assetId}`,
      status: "uploading",
      bytes: 4096,
      contentType: "audio/mp4",
      sha256: DECLARED_SHA,
      expiresAt: recording.audio?.expiresAt,
    });
  });

  it("creates none of the three rows when a later insert fails", async () => {
    const owner = `synthetic-audio-owner-${randomUUID().slice(0, 8)}`;
    for (const pattern of [/INSERT INTO assets/, /INSERT INTO page_recordings/]) {
      await assert.rejects(() => startAudioRecording(failingOn(pool, pattern), owner, startInput()), /synthetic failure/);
      for (const table of ["pages", "assets", "page_recordings"] as const) assert.equal(await count(pool, table, owner), 0, `${pattern}: ${table}`);
    }
    // DB が録音の行を断ったときも同じ（この owner の録音の INSERT だけを断る trigger）
    await pool.query(`CREATE FUNCTION refuse_synthetic_audio() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic refusal' USING ERRCODE = 'P0001'; END $$`);
    await pool.query(`CREATE TRIGGER refuse_synthetic_audio BEFORE INSERT ON page_recordings
      FOR EACH ROW WHEN (NEW.owner = '${owner}') EXECUTE FUNCTION refuse_synthetic_audio()`);
    try {
      await assert.rejects(() => startAudioRecording(pool, owner, startInput()), { code: "P0001" });
      for (const table of ["pages", "assets", "page_recordings"] as const) assert.equal(await count(pool, table, owner), 0, table);
    } finally {
      await pool.query("DROP TRIGGER refuse_synthetic_audio ON page_recordings");
      await pool.query("DROP FUNCTION refuse_synthetic_audio()");
    }
    assert.equal((await startAudioRecording(pool, owner, startInput())).status, "created", "the same owner can start one afterwards");
  });

  it("refuses input with the wrong shape without writing", async () => {
    const owner = `synthetic-audio-owner-${randomUUID().slice(0, 8)}`;
    const bad: Array<[string, Partial<StartAudioRecordingInput>]> = [
      ["asset", { assetId: "not-a-uuid" }],
      ["lang", { lang: "fr" as never }],
      ["title", { title: "あ".repeat(501) }],
      ["source_name", { sourceName: "dir/a.m4a" }],
      ["source_name", { sourceName: "a\nb.m4a" }],
      ["source_name", { sourceName: "" }],
      ["content_type", { contentType: "Audio/MP4" }],
      ["content_type", { contentType: "audio" }],
      ["bytes", { bytes: 0 }],
      ["bytes", { bytes: 1.5 }],
      ["sha256", { sha256: "A".repeat(64) }],
      ["duration", { durationSec: 0 }],
      ["duration", { durationSec: Number.POSITIVE_INFINITY }],
      ["upload_key", { uploadKey: "key" }],
      ["request_hash", { requestHash: "x" }],
      ["retention", { retentionDays: 0 }],
    ];
    for (const [problem, extra] of bad) {
      await assert.rejects(
        () => startAudioRecording(pool, owner, startInput(extra)),
        (error: unknown) => error instanceof InvalidRecordingError && error.problem === problem,
        problem,
      );
    }
    assert.equal(await count(pool, "pages", owner), 0);
    await assert.rejects(() => startAudioRecording(pool, "", startInput()), TypeError);
    // 音声の録音は資産なしでは作れない（createRecordingPage は source = 'audio' を断る）
    await assert.rejects(
      () => createRecordingPage(pool, owner, { lang: "ja", source: "audio", segments: [] }),
      (error: unknown) => error instanceof InvalidRecordingError && error.problem === "source",
    );
  });

  it("returns the existing recording for the same key and content, and a conflict for different content", async () => {
    const key = randomUUID();
    const first = await startAudioRecording(pool, OWNER, startInput({ uploadKey: key }));
    assert.equal(first.status, "created");
    assert.ok(first.status === "created");
    const pages = await count(pool, "pages", OWNER);

    const again = await startAudioRecording(pool, OWNER, startInput({ uploadKey: key }));
    assert.equal(again.status, "existing");
    assert.ok(again.status === "existing");
    assert.equal(again.page.id, first.page.id);
    assert.deepEqual(again.page, first.page);
    assert.equal(again.assetId, first.assetId, "the asset of the first request, not the new id");
    assert.deepEqual(again.recording, first.recording);

    assert.deepEqual(await startAudioRecording(pool, OWNER, startInput({ uploadKey: key, requestHash: HASH_B })), { status: "conflict" });
    assert.equal(await count(pool, "pages", OWNER), pages, "neither a replay nor a conflict writes anything");

    // 別の owner の同じキーは別の録音
    const theirs = await startAudioRecording(pool, OTHER, startInput({ uploadKey: key }));
    assert.equal(theirs.status, "created");
    assert.ok(theirs.status === "created");
    assert.notEqual(theirs.page.id, first.page.id);

    // そのキーで作ったページがゴミ箱にあれば、キーは使えない（ゴミ箱のページを返さない）
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [first.page.id]);
    assert.deepEqual(await startAudioRecording(pool, OWNER, startInput({ uploadKey: key })), { status: "conflict" });
    assert.equal(await count(pool, "pages", OWNER), pages);
  });

  it("lets only one of concurrent starts with the same key create a recording", async () => {
    const key = randomUUID();
    const owner = `synthetic-audio-owner-${randomUUID().slice(0, 8)}`;
    const results = await Promise.all(Array.from({ length: 4 }, () => startAudioRecording(pool, owner, startInput({ uploadKey: key }))));
    const statuses = results.map((result) => result.status).sort();
    assert.deepEqual(statuses, ["created", "existing", "existing", "existing"]);
    const ids = new Set(results.map((result) => (result.status === "conflict" ? null : result.page.id)));
    assert.equal(ids.size, 1, "every request gets the same page");
    // pages は入れ物（kind='page'）とタブの 2 行（#307）
    for (const table of ["pages", "assets", "page_recordings"] as const) assert.equal(await count(pool, table, owner), table === "pages" ? 2 : 1, table);
  });

  it("marks the upload done only when the stored size matches, once, and keeps the transcript revision", async () => {
    const store = new EditorStore(pool);
    const { page } = (await startAudioRecording(pool, OWNER, startInput({ bytes: 2048 }))) as { page: { id: string } };
    const pageBefore = await store.getPage(OWNER, page.id);
    const rowBefore = await recordingRow(pool, page.id);

    assert.deepEqual(await completeAudioUpload(pool, OWNER, page.id, { sizeBytes: 2047 }), { status: "size_mismatch" });
    assert.deepEqual(await completeAudioUpload(pool, OWNER, page.id, { sizeBytes: 0 }), { status: "size_mismatch" });
    assert.deepEqual(await recordingRow(pool, page.id), rowBefore, "a size mismatch writes nothing");
    assert.equal((await store.getPage(OWNER, page.id))?.updatedAt, pageBefore?.updatedAt);

    const done = await completeAudioUpload(pool, OWNER, page.id, { sizeBytes: 2048 });
    assert.equal(done?.status, "ok");
    assert.ok(done?.status === "ok");
    assert.equal(done.recording.audio?.status, "uploaded");
    assert.equal(done.recording.audio?.bytes, 2048);
    assert.equal(done.recording.revision, 1, "the transcript revision does not move");
    const pageAfter = await store.getPage(OWNER, page.id);
    assert.ok(pageAfter && pageBefore && Date.parse(pageAfter.updatedAt) > Date.parse(pageBefore.updatedAt), "pages.updated_at moved on");

    // 冪等: もう一度呼んでも成功し、何も書かない（大きさが違っても、済んだものは済んだまま）
    const rowDone = await recordingRow(pool, page.id);
    for (const sizeBytes of [2048, 1]) {
      const replay = await completeAudioUpload(pool, OWNER, page.id, { sizeBytes });
      assert.deepEqual(replay, { status: "ok", recording: done.recording });
    }
    assert.deepEqual(await recordingRow(pool, page.id), rowDone);
    assert.equal((await store.getPage(OWNER, page.id))?.updatedAt, pageAfter.updatedAt);
    await assert.rejects(() => completeAudioUpload(pool, OWNER, page.id, { sizeBytes: -1 }), TypeError);
  });

  it("updates the status only once when two completions race", async () => {
    const { page } = (await startAudioRecording(pool, OWNER, startInput({ bytes: 100 }))) as { page: { id: string } };
    await pool.query("CREATE TABLE synthetic_audio_updates (page_id uuid, n integer)");
    await pool.query(`CREATE FUNCTION count_synthetic_audio_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO synthetic_audio_updates VALUES (NEW.page_id, 1); RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER count_synthetic_audio_update AFTER UPDATE ON page_recordings
      FOR EACH ROW EXECUTE FUNCTION count_synthetic_audio_update()`);
    try {
      const results = await Promise.all([
        completeAudioUpload(pool, OWNER, page.id, { sizeBytes: 100 }),
        completeAudioUpload(pool, OWNER, page.id, { sizeBytes: 100 }),
      ]);
      assert.deepEqual(results.map((result) => result?.status), ["ok", "ok"]);
      assert.ok(results[0]?.status === "ok" && results[1]?.status === "ok");
      assert.deepEqual(results[0].recording, results[1].recording);
      const updates = (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM synthetic_audio_updates WHERE page_id = $1", [page.id])).rows[0]!.n;
      assert.equal(updates, 1);
    } finally {
      await pool.query("DROP TRIGGER count_synthetic_audio_update ON page_recordings");
      await pool.query("DROP FUNCTION count_synthetic_audio_update()");
      await pool.query("DROP TABLE synthetic_audio_updates");
    }
  });

  it("answers null for another owner's page, an unknown or malformed id, a page in the trash, and a page without audio", async () => {
    const theirs = (await startAudioRecording(pool, OTHER, startInput({ bytes: 10 }))) as { page: { id: string } };
    const trashed = (await startAudioRecording(pool, OWNER, startInput({ bytes: 10 }))) as { page: { id: string } };
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [trashed.page.id]);
    const vtt = await insertPage(pool);
    await insertVttRecording(pool, vtt);
    const plain = await insertPage(pool, OWNER, "note");
    const before = (await pool.query("SELECT page_id, audio_status, updated_at FROM page_recordings ORDER BY page_id")).rows;

    for (const id of [theirs.page.id, trashed.page.id, vtt, plain, randomUUID(), "00000000-0000-0000-0000-00000000000g", "not-a-uuid"]) {
      assert.equal(await audioInfo(pool, OWNER, id), null, id);
      assert.equal(await completeAudioUpload(pool, OWNER, id, { sizeBytes: 10 }), null, id);
    }
    assert.deepEqual((await pool.query("SELECT page_id, audio_status, updated_at FROM page_recordings ORDER BY page_id")).rows, before, "nothing changed");
    assert.equal((await audioInfo(pool, OTHER, theirs.page.id))?.status, "uploading", "the owner still reads it");
    await assert.rejects(() => audioInfo(pool, "", theirs.page.id), TypeError);
  });

  it("keeps the audio and the recording row as they are when a transcript tab of the recording is edited", async () => {
    const { page } = (await startAudioRecording(pool, OWNER, startInput())) as { page: { id: string } };
    const before = await getRecording(pool, OWNER, page.id);
    const client = await pool.connect();
    let tab: string;
    try {
      await client.query("BEGIN");
      tab = (await createTranscriptTab(client, OWNER, (await ensureRecordingFolder(client, OWNER, page.id))!, { engine: "fake", language: "ja" })).tab;
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const edited = await updateTranscript(pool, OWNER, tab, 1, (data) => ({ ...data, segments: [{ start: 0, end: 1, text: "合成の発言", speaker: null }] }));
    assert.ok(edited?.status === "ok");
    assert.equal((await getTranscript(pool, OWNER, tab))?.segments.length, 1);
    assert.deepEqual(await getRecording(pool, OWNER, page.id), before, "the audio and the recording row do not move");
  });

  it("keeps the audio invariants when the code is bypassed", async () => {
    const page = await insertPage(pool);
    const assetId = randomUUID();
    await pool.query(
      `INSERT INTO assets (id, owner, page_id, kind, bucket_path, bytes, sha256, content_type) VALUES ($1, $2, $3, 'audio', $4, 1, $5, 'audio/mp4')`,
      [assetId, OWNER, page, `audio/${assetId}`, DECLARED_SHA],
    );
    const theirPage = await insertPage(pool, OTHER);
    const theirAsset = randomUUID();
    await pool.query(
      `INSERT INTO assets (id, owner, page_id, kind, bucket_path, bytes, sha256, content_type) VALUES ($1, $2, $3, 'audio', $4, 1, $5, 'audio/mp4')`,
      [theirAsset, OTHER, theirPage, `audio/${theirAsset}`, DECLARED_SHA],
    );
    const insert = (values: Record<string, unknown>) => {
      const row = { page_id: page, owner: OWNER, source: "audio", language: "ja", audio_status: "uploading", audio_asset: assetId, ...values };
      const columns = Object.keys(row);
      return pool.query(
        `INSERT INTO page_recordings (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
        Object.values(row),
      );
    };
    for (const values of [
      { audio_status: "queued" },
      { audio_status: "uploading", audio_asset: null },
      { audio_status: "uploaded", audio_asset: null },
      { source: "vtt", audio_status: "none" },
      { audio_request_hash: "x" },
      { audio_request_hash: "A".repeat(64) },
    ]) {
      await assert.rejects(() => insert(values), { code: "23514" }, JSON.stringify(values));
    }
    // 別の人の資産・存在しない資産は指せない（検査は commit の時）
    await assert.rejects(() => insert({ audio_asset: theirAsset }), { code: "23503" });
    await assert.rejects(() => insert({ audio_asset: randomUUID() }), { code: "23503" });
    // 冪等キーは owner ごとに 1 つ
    const key = randomUUID();
    await insert({ audio_upload_key: key });
    const second = await insertPage(pool);
    await assert.rejects(() => insert({ page_id: second, audio_upload_key: key }), { code: "23505" });
    // 資産だけは消せない（録音が指している）
    await assert.rejects(() => pool.query("DELETE FROM assets WHERE id = $1", [assetId]), { code: "23503" });
    // 既に音声を持つ録音を「音声なし」にもできない
    await assert.rejects(() => pool.query("UPDATE page_recordings SET audio_status = 'none' WHERE page_id = $1", [page]), { code: "23514" });
  });

  it("removes the recording and the asset when the page itself is deleted (deferred foreign key), also by the trash purge", async () => {
    const started = (await startAudioRecording(pool, OWNER, startInput())) as { page: { id: string }; assetId: string };
    await pool.query("DELETE FROM pages WHERE id = $1", [started.page.id]);
    assert.equal(await recordingRow(pool, started.page.id), undefined);
    assert.equal((await pool.query("SELECT 1 FROM assets WHERE id = $1", [started.assetId])).rows.length, 0);

    // 検査は commit の時: 同じ transaction の中なら、資産を先に消してから録音を消しても通る
    const other = (await startAudioRecording(pool, OWNER, startInput())) as { page: { id: string }; assetId: string };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM assets WHERE id = $1", [other.assetId]);
      await client.query("DELETE FROM page_recordings WHERE page_id = $1", [other.page.id]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    assert.equal(await recordingRow(pool, other.page.id), undefined);

    const owner = `synthetic-audio-owner-${randomUUID().slice(0, 8)}`;
    const old = (await startAudioRecording(pool, owner, startInput())) as { page: { id: string }; assetId: string };
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() - interval '31 days', created_at = clock_timestamp() - interval '40 days' WHERE id = $1", [old.page.id]);
    const purged = await new EditorStore(pool).purgeTrash();
    assert.ok(purged.assetPaths.includes(`audio/${old.assetId}`), "the purge reports the object path; the object itself is left to the bucket");
    for (const table of ["pages", "assets", "page_recordings"] as const) assert.equal(await count(pool, table, owner), 0, table);
  });

  it("allows a recording from audio that has no audio (the audio expired, or the page is a copy)", async () => {
    const page = await insertPage(pool);
    await pool.query(
      `INSERT INTO page_recordings (page_id, owner, source, language, audio_status)
       VALUES ($1, $2, 'audio', 'ja', 'none')`,
      [page, OWNER],
    );
    const recording = await getRecording(pool, OWNER, page);
    assert.equal(recording?.source, "audio");
    assert.equal(recording?.audio, null);
  });

  it("duplicates an audio recording page without its audio, and a VTT recording page with audio: null", async () => {
    const started = (await startAudioRecording(pool, OWNER, startInput())) as { page: { id: string; page: string | null } };
    const assets = await count(pool, "assets", OWNER);
    const copy = await duplicatePage(pool, OWNER, started.page.id);
    assert.ok(copy);
    assert.equal(copy.kind, "rec");
    // 録音ページのタブの複製は同じ入れ物の新しいタブ: 題名はページの名前のまま、タブの名前が「のコピー」（#307 #308）
    assert.deepEqual([copy.title, copy.page, copy.tabName], ["合成の打ち合わせ", started.page.page, "1のコピー"]);
    const copiedAudioRecording = await getRecording(pool, OWNER, copy.id);
    assert.ok(copiedAudioRecording, "the recording page is copied (it is not left without a recording)");
    assert.equal(copiedAudioRecording.source, "audio");
    assert.equal(copiedAudioRecording.audio, null, "the audio is not copied (the asset belongs to one page)");
    assert.equal(copiedAudioRecording.revision, 1);
    assert.equal("segments" in copiedAudioRecording, false);
    assert.equal(await audioInfo(pool, OWNER, copy.id), null);
    assert.equal(await count(pool, "assets", OWNER), assets, "no asset is copied");
    assert.equal((await getRecording(pool, OWNER, started.page.id))?.audio?.status, "uploading", "the original keeps its audio");

    const vtt = await insertPage(pool);
    await insertVttRecording(pool, vtt);
    const vttCopy = await duplicatePage(pool, OWNER, vtt);
    assert.ok(vttCopy);
    const copied = await getRecording(pool, OWNER, vttCopy.id);
    assert.ok(copied);
    assert.equal(copied.audio, null);
    assert.equal(copied.engine, "vtt-import");
    const row = await recordingRow(pool, vttCopy.id);
    assert.equal(row?.audio_status, "none");
    assert.equal(row?.audio_upload_key, null);
  });
});
