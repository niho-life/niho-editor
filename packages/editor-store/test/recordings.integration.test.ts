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
  updateRecording,
  type Connectable,
  type CreateRecordingInput,
  type RecordingData,
  type RecordingSegment,
} from "../src/recordings.ts";
import { duplicatePage } from "../src/duplicate.ts";
import { EditorStore } from "../src/store.ts";

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
  await pool.query(
    `INSERT INTO page_recordings (page_id, owner, source, language, segments, speaker_names)
     VALUES ($1, $2, 'vtt', 'ja', $3::jsonb, $4::jsonb)`,
    [pageId, owner, JSON.stringify([segment("他の行", 1, 0, 1)]), JSON.stringify({ "1": "他の話し手" })],
  );
}

async function rowOf(pool: PgPool, pageId: string): Promise<Record<string, unknown> | undefined> {
  return (await pool.query("SELECT * FROM page_recordings WHERE page_id = $1", [pageId])).rows[0];
}

const rename = (speaker: number, name: string | null) => (data: RecordingData): RecordingData => {
  const speakerNames = { ...data.speakerNames };
  if (name === null) delete speakerNames[String(speaker)];
  else speakerNames[String(speaker)] = name;
  return { segments: data.segments, speakerNames };
};

const editText = (index: number, text: string) => (data: RecordingData): RecordingData => ({
  segments: data.segments.map((item, at) => (at === index ? { ...item, text } : item)),
  speakerNames: data.speakerNames,
});

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

  it("creates a recording page and its transcript together, and reads them back", async () => {
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
    assert.deepEqual(recording.segments, input().segments);
    assert.deepEqual(Object.keys(recording.segments[0]!), ["start", "end", "text", "speaker"], "segments keep their documented field order");
    assert.deepEqual(recording.speakerNames, { "1": "司会役" });
    assert.equal(recording.createdAt, created.page.createdAt);

    assert.deepEqual(await getRecording(pool, OWNER, created.page.id), recording, "read back from a new query");
    const page = await new EditorStore(pool).getPage(OWNER, created.page.id);
    assert.equal(page?.kind, "rec");
    assert.deepEqual(page?.blocks, [], "the page body is empty");
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
    const rowsBefore = (await pool.query("SELECT page_id, revision, segments, speaker_names FROM page_recordings ORDER BY page_id")).rows;

    for (const id of [theirs, trashed, plain, randomUUID(), "00000000-0000-0000-0000-00000000000g", "not-a-uuid"]) {
      assert.equal(await getRecording(pool, OWNER, id), null, id);
      assert.equal(await updateRecording(pool, OWNER, id, 1, rename(1, "書き換え")), null, id);
    }
    assert.deepEqual((await pool.query("SELECT page_id, revision, segments, speaker_names FROM page_recordings ORDER BY page_id")).rows, rowsBefore, "nothing changed");
    assert.equal((await getRecording(pool, OTHER, theirs))?.speakerNames["1"], "他の話し手", "the owner still reads it");
  });

  it("saves with the current revision and moves it on; an old revision is a conflict that returns the latest and changes nothing", async () => {
    const { page, recording } = await createRecordingPage(pool, OWNER, input());
    const first = await updateRecording(pool, OWNER, page.id, 1, editText(0, "おはようございます。直した"));
    assert.equal(first?.status, "ok");
    assert.ok(first?.status === "ok");
    assert.equal(first.recording.revision, 2);
    assert.equal(first.recording.segments[0]?.text, "おはようございます。直した");
    assert.ok(Date.parse(first.recording.updatedAt) >= Date.parse(recording.updatedAt));
    assert.equal(first.recording.createdAt, recording.createdAt);

    const before = await rowOf(pool, page.id);
    let called = false;
    const stale = await updateRecording(pool, OWNER, page.id, 1, (data) => {
      called = true;
      return editText(1, "上書き")(data);
    });
    assert.equal(stale?.status, "conflict");
    assert.ok(stale?.status === "conflict");
    assert.deepEqual(stale.recording, first.recording, "the latest recording comes back");
    assert.equal(called, false, "the change is not applied to the newer data");
    assert.deepEqual(await rowOf(pool, page.id), before, "nothing was written");

    const ahead = await updateRecording(pool, OWNER, page.id, 99, rename(1, "先の版"));
    assert.equal(ahead?.status, "conflict");

    const second = await updateRecording(pool, OWNER, page.id, 2, rename(2, "記録役"));
    assert.ok(second?.status === "ok");
    assert.equal(second.recording.revision, 3);
    assert.deepEqual(second.recording.speakerNames, { "1": "司会役", "2": "記録役" });
    assert.equal(second.recording.segments[0]?.text, "おはようございます。直した", "the earlier edit is kept");
  });

  it("writes a new length only when the change returns one（音声・字幕を足して長くなるとき）", async () => {
    const { page } = await createRecordingPage(pool, OWNER, input());
    // 長さを返さない書き換え（文章・話者）は今の長さのまま
    const edited = await updateRecording(pool, OWNER, page.id, 1, editText(0, "直した"));
    assert.ok(edited?.status === "ok");
    assert.equal(edited.recording.durationSec, 7.5);

    // 足す書き換えは、新しい長さ（ずらす量 ＋ 足す側の長さ）を返す
    const appended = await updateRecording(pool, OWNER, page.id, 2, (data) => ({
      segments: [...data.segments, segment("続きです", 1, (data.durationSec ?? 0) + 0, (data.durationSec ?? 0) + 2)],
      speakerNames: data.speakerNames,
      durationSec: (data.durationSec ?? 0) + 2,
    }));
    assert.ok(appended?.status === "ok");
    assert.equal(appended.recording.durationSec, 9.5);
    assert.equal(appended.recording.segments.at(-1)?.start, 7.5);
    assert.equal((await getRecording(pool, OWNER, page.id))?.durationSec, 9.5);

    // null は「長さが分からない」（0007 の CHECK は null を許す）
    const cleared = await updateRecording(pool, OWNER, page.id, 3, (data) => ({ segments: data.segments, speakerNames: data.speakerNames, durationSec: null }));
    assert.ok(cleared?.status === "ok");
    assert.equal(cleared.recording.durationSec, null);
  });

  it("lets only one of two concurrent writes with the same revision through", async () => {
    const { page } = await createRecordingPage(pool, OWNER, input());
    const results = await Promise.all([
      updateRecording(pool, OWNER, page.id, 1, editText(0, "画面 A の文")),
      updateRecording(pool, OWNER, page.id, 1, editText(0, "画面 B の文")),
    ]);
    const statuses = results.map((result) => result?.status).sort();
    assert.deepEqual(statuses, ["conflict", "ok"]);
    const winner = results.find((result) => result?.status === "ok");
    const loser = results.find((result) => result?.status === "conflict");
    assert.ok(winner?.status === "ok" && loser?.status === "conflict");
    assert.deepEqual(loser.recording, winner.recording, "the loser gets the winner's text back");
    const stored = await getRecording(pool, OWNER, page.id);
    assert.equal(stored?.revision, 2);
    assert.equal(stored?.segments[0]?.text, winner.recording.segments[0]?.text);
  });

  it("writes nothing when the change is refused or has the wrong shape", async () => {
    const { page } = await createRecordingPage(pool, OWNER, input());
    const before = await rowOf(pool, page.id);
    const refused = await updateRecording(pool, OWNER, page.id, 1, () => ({ rejected: "name" }));
    assert.deepEqual(refused, { status: "rejected", reason: "name" });
    assert.deepEqual(await rowOf(pool, page.id), before);

    const bad: Array<[string, (data: RecordingData) => RecordingData]> = [
      ["text", editText(0, "a\u0000b")],
      ["text", editText(0, "あ".repeat(5001))],
      ["speaker_names", rename(3, "いない話者")],
      ["name", rename(1, " 前後に空白 ")],
      ["segments", (data) => ({ segments: Array.from({ length: 20_001 }, () => data.segments[0]!), speakerNames: data.speakerNames })],
      ["speaker", (data) => ({ segments: [{ ...data.segments[0]!, speaker: 0 }], speakerNames: {} })],
      ["time", (data) => ({ segments: [{ ...data.segments[0]!, start: 2, end: 1 }], speakerNames: {} })],
    ];
    for (const [problem, mutate] of bad) {
      await assert.rejects(
        () => updateRecording(pool, OWNER, page.id, 1, mutate),
        (error: unknown) => error instanceof InvalidRecordingError && error.problem === problem,
        problem,
      );
      assert.deepEqual(await rowOf(pool, page.id), before, `${problem}: nothing was written`);
    }
    // 断った後も同じ revision でそのまま書ける（lock・transaction が残っていない）
    assert.equal((await updateRecording(pool, OWNER, page.id, 1, rename(2, "あとから")))?.status, "ok");
  });

  it("keeps the table's invariants when the code is bypassed", async () => {
    const page = await insertPage(pool);
    const theirs = await insertPage(pool, { owner: OTHER });
    const insert = (values: Record<string, unknown>) => {
      const row = { page_id: page, owner: OWNER, source: "vtt", language: "ja", segments: "[]", speaker_names: "{}", ...values };
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
      { segments: "{}" },
      { segments: "\"text\"" },
      { segments: JSON.stringify(Array.from({ length: 20_001 }, () => 0)) },
      { speaker_names: "[]" },
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

  it("removes the recording when the page itself is deleted, and keeps it while the page is in the trash", async () => {
    const { page } = await createRecordingPage(pool, OWNER, input());
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [page.id]);
    assert.ok(await rowOf(pool, page.id), "the trash keeps the recording");
    await pool.query("UPDATE pages SET deleted_at = NULL WHERE id = $1", [page.id]);
    assert.equal((await getRecording(pool, OWNER, page.id))?.revision, 1, "restoring the page brings it back");
    await pool.query("DELETE FROM pages WHERE id = $1", [page.id]);
    assert.equal(await rowOf(pool, page.id), undefined);
  });

  it("moves the page's update time on when the transcript is edited, but not on a conflict", async () => {
    const { page, recording } = await createRecordingPage(pool, OWNER, input());
    const store = new EditorStore(pool);
    const before = await store.getPage(OWNER, page.id);
    assert.ok(before);
    const edited = await updateRecording(pool, OWNER, page.id, recording.revision, (data) => ({
      segments: data.segments.map((item, index) => (index === 0 ? { ...item, text: "直した" } : item)),
      speakerNames: data.speakerNames,
    }));
    assert.equal(edited?.status, "ok");
    const after = await store.getPage(OWNER, page.id);
    assert.ok(after && Date.parse(after.updatedAt) > Date.parse(before.updatedAt), "pages.updated_at moved on");

    const stale = await updateRecording(pool, OWNER, page.id, recording.revision, (data) => data);
    assert.equal(stale?.status, "conflict");
    assert.equal((await store.getPage(OWNER, page.id))?.updatedAt, after.updatedAt, "a conflict changes nothing");
  });

  it("copies the transcript with a recording page when it is duplicated, as an independent recording", async () => {
    const { page, recording } = await createRecordingPage(pool, OWNER, input());
    const edited = await updateRecording(pool, OWNER, page.id, recording.revision, (data) => ({
      segments: data.segments,
      speakerNames: { ...data.speakerNames, "2": "聞き手" },
    }));
    assert.equal(edited?.status, "ok");

    const copy = await duplicatePage(pool, OWNER, page.id);
    assert.ok(copy);
    assert.notEqual(copy.id, page.id);
    assert.equal(copy.kind, "rec");
    assert.equal(copy.title, "合成の会議のコピー");
    const copied = await getRecording(pool, OWNER, copy.id);
    assert.ok(copied);
    assert.equal(copied.revision, 1, "the copy starts again at revision 1");
    assert.deepEqual(copied.segments, input().segments);
    assert.deepEqual(copied.speakerNames, { "1": "司会役", "2": "聞き手" });
    assert.equal(copied.sourceSha256, SHA);
    assert.equal(copied.createdAt, copy.createdAt);

    // 別の録音になる: コピーを直しても元は変わらない
    const changed = await updateRecording(pool, OWNER, copy.id, 1, (data) => ({
      segments: data.segments.map((item, index) => (index === 0 ? { ...item, text: "コピーだけ直した" } : item)),
      speakerNames: data.speakerNames,
    }));
    assert.equal(changed?.status, "ok");
    const original = await getRecording(pool, OWNER, page.id);
    assert.equal(original?.revision, 2);
    assert.equal(original?.segments[0]?.text, "おはようございます");

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
