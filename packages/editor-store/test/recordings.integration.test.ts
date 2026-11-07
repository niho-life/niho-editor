import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Pool as PgPool } from "pg";
import { applyMigrations, defaultMigrationsDir, readMigrations } from "../src/migrate.ts";
import {
  InvalidRecordingError,
  createRecordingPage,
  getRecording,
  type Connectable,
  type CreateRecordingInput,
  type RecordingSegment,
} from "../src/recordings.ts";
import { duplicatePage } from "../src/duplicate.ts";
import { EditorStore } from "../src/store.ts";
import { getTranscript } from "../src/transcripts.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID と合成の文字起こしだけを使う（実在の人の名前・会話を入れない）
const OWNER = "synthetic-recording-owner-a";
const OTHER = "synthetic-recording-owner-b";
const SHA = "0".repeat(63) + "1";

async function newPool(schema: string): Promise<PgPool> {
  const { Pool } = await import("pg");
  return new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
}

async function withSchema(label: string): Promise<{ pool: PgPool; drop: () => Promise<void> }> {
  const schema = `editor_store_${label}_${randomUUID().replaceAll("-", "")}`;
  const pool = await newPool(schema);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  return {
    pool,
    drop: async () => {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    },
  };
}

const segment = (text: string, speaker: number | null, start: number | null, end: number | null): RecordingSegment => ({ start, end, text, speaker });

function input(extra: Partial<CreateRecordingInput> = {}): CreateRecordingInput {
  return {
    title: "合成の会議",
    lang: "ja",
    source: "vtt",
    engine: "vtt-import",
    durationSec: 7.5,
    sourceName: "合成の会議.vtt",
    sourceSha256: SHA,
    segments: [segment("おはようございます", 1, 0, 1.25), segment("はじめましょう", 2, 1.25, 3.9), segment("（拍手）", null, 4, 7.5)],
    speakerNames: { "1": "司会役" },
    ...extra,
  };
}

/** store を通さずにページの行を入れる（0002 以降の列は既定値に任せる）。 */
async function insertPage(pool: PgPool, seed: { owner?: string; kind?: string; deleted?: boolean } = {}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO pages (owner, kind, deleted_at) VALUES ($1, $2, CASE WHEN $3::boolean THEN clock_timestamp() END) RETURNING id`,
    [seed.owner ?? OWNER, seed.kind ?? "rec", seed.deleted ?? false],
  );
  const id = result.rows[0]?.id;
  assert.ok(id);
  return id;
}

/** store を通さずに録音の行を入れる。 */
async function insertRecording(pool: PgPool, pageId: string, owner: string = OWNER): Promise<void> {
  await pool.query(`INSERT INTO page_recordings (page_id, owner, source, language) VALUES ($1, $2, 'vtt', 'ja')`, [pageId, owner]);
}

async function rowOf(pool: PgPool, pageId: string): Promise<Record<string, unknown> | undefined> {
  return (await pool.query("SELECT * FROM page_recordings WHERE page_id = $1", [pageId])).rows[0];
}

describe("0007 on a database that has 0001 to 0006", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;
  let dir: string;

  before(async () => {
    ({ pool, drop } = await withSchema("recordings0007"));
    dir = await mkdtemp(join(tmpdir(), "editor-store-0007-"));
  });

  after(async () => {
    await drop();
    await rm(dir, { recursive: true, force: true });
  });

  it("adds page_recordings next to existing pages without touching them, and a recording page can be made afterwards", async () => {
    const migrations = fileURLToPath(defaultMigrationsDir);
    const dirUrl = pathToFileURL(`${dir}/`);
    // 適用済みの一覧は readMigrations() から取る（0002 は別の PR。ここにあれば一緒に入る）
    const names = (await readMigrations()).map((file) => file.name);
    const earlier = names.filter((name) => name < "0007");
    assert.ok(earlier.includes("0001_editor_store.sql") && earlier.includes("0003_search_text.sql") && earlier.includes("0004_page_shares.sql"));
    for (const name of earlier) await copyFile(join(migrations, name), join(dir, name));
    const client = await pool.connect();
    try {
      assert.deepEqual((await applyMigrations(client, dirUrl)).applied, earlier);
      const page = await insertPage(pool, { kind: "note" });
      const before = (await pool.query("SELECT * FROM pages WHERE id = $1", [page])).rows[0];

      await copyFile(join(migrations, "0007_page_recordings.sql"), join(dir, "0007_page_recordings.sql"));
      const second = await applyMigrations(client, dirUrl);
      assert.deepEqual(second.applied, ["0007_page_recordings.sql"]);
      assert.deepEqual(second.skipped, earlier);

      assert.deepEqual((await pool.query("SELECT * FROM pages WHERE id = $1", [page])).rows[0], before, "existing rows are unchanged");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM page_recordings")).rows[0].n, 0, "nothing is recorded by the migration");
      // 今のコードは後の migration（0008 の音声の列など）も前提にするので、残りも入れてから読む
      await applyMigrations(client);
      assert.equal(await getRecording(pool, OWNER, page), null, "a page without a recording has none");
      const created = await createRecordingPage(pool, OWNER, input());
      assert.equal((await getRecording(pool, OWNER, created.page.id))?.revision, 1);
    } finally {
      client.release();
    }
  });
});

describe("page recordings on PostgreSQL", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;

  before(async () => {
    ({ pool, drop } = await withSchema("recordings"));
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

  it("creates a recording page in a folder of its own, with the imported transcript as a tab of the 文字起こし page (#310)", async () => {
    const created = await createRecordingPage(pool, OWNER, input());
    assert.deepEqual(Object.keys(created.page).sort(), ["createdAt", "id", "kind", "lang", "page", "title", "updatedAt"]);
    assert.ok(created.page.page, "録音のタブは入れ物（kind='page'）を指す（#307）");
    assert.equal(created.page.kind, "rec");
    assert.equal(created.page.title, "合成の会議");
    assert.equal(created.page.lang, "ja");
    const recording = created.recording;
    assert.equal(recording.revision, 1);
    assert.equal(recording.source, "vtt");
    assert.equal(recording.language, "ja");
    assert.equal(recording.engine, "vtt-import");
    assert.equal(recording.durationSec, 7.5);
    assert.equal(recording.sourceName, "合成の会議.vtt");
    assert.equal(recording.sourceSha256, SHA);
    assert.equal("segments" in recording || "speakerNames" in recording, false, "the recording row holds no transcript (the tab does)");
    assert.equal(recording.createdAt, created.page.createdAt);
    assert.deepEqual(await getRecording(pool, OWNER, created.page.id), recording, "read back from a new query");

    const store = new EditorStore(pool);
    const page = await store.getPage(OWNER, created.page.id);
    assert.equal(page?.kind, "rec");
    assert.deepEqual(page?.blocks, [], "the page body is empty");
    // 題名のフォルダに包まれ、文字起こしのタブ（札「取り込んだ字幕」）が同じフォルダの「文字起こし」ページにある
    assert.ok(page?.parent);
    const folder = await store.getPage(OWNER, page.parent);
    assert.deepEqual([folder?.kind, folder?.title], ["folder", "合成の会議"]);
    const tab = await store.getPage(OWNER, created.transcript);
    assert.deepEqual([tab?.kind, tab?.title, tab?.tabName, tab?.parent, tab?.madeFrom], ["note", "文字起こし", "取り込んだ字幕", page.parent, { kind: "transcript", recording: created.page.id, engine: "vtt-import" }]);
    const holder = await store.getPage(OWNER, tab!.page!);
    assert.deepEqual([holder?.role, holder?.parent, holder?.lastTab], [{ kind: "transcript" }, page.parent, created.transcript]);
    const transcript = await getTranscript(pool, OWNER, created.transcript);
    assert.deepEqual([transcript?.revision, transcript?.engine, transcript?.language, transcript?.durationSec, transcript?.recordingPageId], [1, "vtt-import", "ja", 7.5, created.page.id]);
    assert.deepEqual(transcript?.segments, input().segments);
    assert.deepEqual(Object.keys(transcript!.segments[0]!), ["start", "end", "text", "speaker"], "segments keep their documented field order");
    assert.deepEqual(transcript?.speakerNames, { "1": "司会役" });
  });

  it("creates neither the page nor the recording when the second insert fails", async () => {
    const count = async () => (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE owner = $1", [OTHER])).rows[0]?.n;
    const before = await count();
    // 録音の INSERT だけを失敗させる接続（ページの INSERT は成功した後）
    const failing: Connectable = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: ((sql: string, values?: unknown[]) => {
            if (/INSERT INTO page_recordings/.test(sql)) return Promise.reject(Object.assign(new Error("synthetic failure"), { code: "XX000" }));
            return client.query(sql, values);
          }) as typeof client.query,
          release: (error?: Error | boolean) => client.release(error),
        };
      },
    };
    await assert.rejects(() => createRecordingPage(failing, OTHER, input()), /synthetic failure/);
    assert.equal(await count(), before, "the page insert was rolled back");

    // DB が録音の行を断ったときも同じ（この owner の録音の INSERT だけを断る trigger。ページの INSERT は先に成功している）
    const owner = `synthetic-recording-owner-${randomUUID().slice(0, 8)}`;
    await pool.query(`CREATE FUNCTION refuse_synthetic_recording() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic refusal' USING ERRCODE = 'P0001'; END $$`);
    await pool.query(`CREATE TRIGGER refuse_synthetic_recording BEFORE INSERT ON page_recordings
      FOR EACH ROW WHEN (NEW.owner = '${owner}') EXECUTE FUNCTION refuse_synthetic_recording()`);
    try {
      await assert.rejects(() => createRecordingPage(pool, owner, input()), { code: "P0001" });
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM pages WHERE owner = $1", [owner])).rows[0].n, 0, "no page without its recording");
    } finally {
      await pool.query("DROP TRIGGER refuse_synthetic_recording ON page_recordings");
      await pool.query("DROP FUNCTION refuse_synthetic_recording()");
    }
    assert.equal((await createRecordingPage(pool, owner, input())).recording.revision, 1, "the same owner can make one afterwards");
  });

  it("answers null to another owner's page, an unknown or malformed id, a page in the trash, and a page without a recording", async () => {
    const theirs = await insertPage(pool, { owner: OTHER });
    await insertRecording(pool, theirs, OTHER);
    const trashed = (await createRecordingPage(pool, OWNER, input())).page.id;
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [trashed]);
    const plain = await insertPage(pool, { kind: "note" });

    for (const id of [theirs, trashed, plain, randomUUID(), "00000000-0000-0000-0000-00000000000g", "not-a-uuid"]) {
      assert.equal(await getRecording(pool, OWNER, id), null, id);
    }
    assert.equal((await getRecording(pool, OTHER, theirs))?.language, "ja", "the owner still reads it");
  });

  it("keeps the table's invariants when the code is bypassed", async () => {
    const page = await insertPage(pool);
    const theirs = await insertPage(pool, { owner: OTHER });
    const insert = (values: Record<string, unknown>) => {
      const row = { page_id: page, owner: OWNER, source: "vtt", language: "ja", ...values };
      const columns = Object.keys(row);
      return pool.query(
        `INSERT INTO page_recordings (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
        Object.values(row),
      );
    };
    for (const values of [
      { source: "mic" },
      { language: "fr" },
      { engine: "" },
      { engine: "e".repeat(65) },
      { duration_sec: -1 },
      { source_name: "" },
      { source_name: "dir/a.vtt" },
      { source_name: "dir\\a.vtt" },
      { source_name: "a\nb.vtt" },
      { source_name: "n".repeat(201) },
      { source_sha256: "A".repeat(64) },
      { source_sha256: "0".repeat(63) },
      { revision: 0 },
      { created_at: new Date(Date.now() + 60_000) },
    ]) {
      await assert.rejects(() => insert(values), { code: "23514" }, JSON.stringify(values).slice(0, 80));
    }
    // 別の人のページ・存在しないページには付けられない
    await assert.rejects(() => insert({ page_id: theirs }), { code: "23503" });
    await assert.rejects(() => insert({ page_id: randomUUID() }), { code: "23503" });
    // 1 ページに 1 行
    await insert({});
    await assert.rejects(() => insert({}), { code: "23505" });
    await assert.rejects(() => pool.query("UPDATE page_recordings SET updated_at = created_at - interval '1 second' WHERE page_id = $1", [page]), { code: "23514" });
  });

  it("has no paragraph columns: the transcript lives in page_transcripts (#310)", async () => {
    const columnsOf = async (table: string) =>
      (await pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1", [table])).rows.map((row) => row.column_name);
    const columns = await columnsOf("page_recordings");
    assert.ok(columns.includes("revision") && columns.includes("source_sha256") && columns.includes("audio_status"));
    assert.deepEqual(columns.filter((name) => name === "segments" || name === "speaker_names"), []);
    const runColumns = await columnsOf("transcription_runs");
    assert.deepEqual(runColumns.filter((name) => ["candidate", "candidate_revision", "replace"].includes(name)), []);
    assert.ok(runColumns.includes("target_tab"));
    assert.deepEqual((await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'page_recording_candidate%'")).rows, []);
  });

  it("removes the recording when the page itself is deleted, and keeps it while the page is in the trash", async () => {
    const { page } = await createRecordingPage(pool, OWNER, input());
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [page.id]);
    assert.ok(await rowOf(pool, page.id), "the trash keeps the recording");
    await pool.query("UPDATE pages SET deleted_at = NULL WHERE id = $1", [page.id]);
    assert.equal((await getRecording(pool, OWNER, page.id))?.revision, 1, "restoring the page brings it back");
    await pool.query("DELETE FROM pages WHERE id = $1", [page.id]);
    assert.equal(await rowOf(pool, page.id), undefined);
  });

  it("copies the recording row with a recording page when it is duplicated (the paragraphs stay with the transcript tab), as an independent recording", async () => {
    const { page, transcript } = await createRecordingPage(pool, OWNER, input());
    const copy = await duplicatePage(pool, OWNER, page.id);
    assert.ok(copy);
    assert.notEqual(copy.id, page.id);
    assert.equal(copy.kind, "rec");
    // 同じ入れ物の新しいタブ: 題名はページの名前のまま、タブの名前が「のコピー」（#307 #308）
    assert.deepEqual([copy.title, copy.page, copy.tabName], ["合成の会議", page.page, "1のコピー"]);
    const copied = await getRecording(pool, OWNER, copy.id);
    assert.ok(copied);
    assert.equal(copied.revision, 1, "the copy starts again at revision 1");
    assert.equal(copied.sourceSha256, SHA);
    assert.equal(copied.sourceName, "合成の会議.vtt");
    assert.equal(copied.createdAt, copy.createdAt);
    assert.equal("segments" in copied, false);
    // 文字起こしのタブは複製されない（録音のコピーは段落を持たない。タブを複製するのは文字起こしのタブ）
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM page_transcripts WHERE recording_page_id = $1", [page.id])).rows[0].n, 1);
    assert.equal((await getTranscript(pool, OWNER, transcript))?.segments.length, 3);

    // 録音のないページの複製は録音を作らない。別の owner は複製できず、何も作られない
    const plain = await insertPage(pool, { kind: "note" });
    const plainCopy = await duplicatePage(pool, OWNER, plain);
    assert.ok(plainCopy);
    assert.equal(await getRecording(pool, OWNER, plainCopy.id), null);
    const recordingCount = async () => (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM page_recordings")).rows[0]?.n;
    const pageCount = async () => (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM pages")).rows[0]?.n;
    const [recordingsBefore, pagesBefore] = [await recordingCount(), await pageCount()];
    assert.equal(await duplicatePage(pool, OTHER, page.id), null);
    assert.equal(await recordingCount(), recordingsBefore, "no recording is made for another owner's page");
    assert.equal(await pageCount(), pagesBefore, "no page is made either");
  });
});
