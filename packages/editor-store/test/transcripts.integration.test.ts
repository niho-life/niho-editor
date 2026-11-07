import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import type { Pool as PgPool, PoolClient } from "pg";
import { MIGRATION_FILE_PATTERN, applyMigrations, defaultMigrationsDir } from "../src/migrate.ts";
import { duplicatePage } from "../src/duplicate.ts";
import { EditorStore } from "../src/store.ts";
import {
  createTranscriptTab,
  ensureRecordingFolder,
  getTranscript,
  getTranscriptVersion,
  listTranscriptTabs,
  listTranscriptVersions,
  restoreTranscriptVersion,
  updateTranscript,
} from "../src/transcripts.ts";
import { InvalidRecordingError, type RecordingData, type RecordingSegment } from "../src/recordings.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
// 合成のユーザー ID・段落だけを使う
const OWNER = "synthetic-transcript-owner-a";
const OTHER = "synthetic-transcript-owner-b";
const SEGMENTS: RecordingSegment[] = [
  { start: 0, end: 2, text: "合成の一つ目の段落です。", speaker: 1 },
  { start: 2, end: 4, text: "合成の二つ目の段落です。", speaker: 2 },
];

async function withSchema(label: string): Promise<{ pool: PgPool; drop: () => Promise<void> }> {
  const { Pool } = await import("pg");
  const schema = `editor_store_${label}_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  return { pool, drop: async () => { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end(); } };
}

describe("transcript tabs on PostgreSQL（#310）", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;
  let store: EditorStore;

  before(async () => {
    ({ pool, drop } = await withSchema("transcripts"));
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
    store = new EditorStore(pool);
  });

  after(async () => {
    await drop();
  });

  /** フォルダの中の録音のタブ（音声は無し。文字起こしのタブの入れ物とタブを作るのに十分）。 */
  async function recordingInFolder(owner = OWNER): Promise<{ folder: string; rec: string }> {
    const folder = (await store.createPage(owner, { kind: "folder", title: "合成の取材" })).id;
    const rec = (await store.createPage(owner, { kind: "rec", title: "合成の録音", parent: folder }))!.id;
    await pool.query("INSERT INTO page_recordings (page_id, owner, source, language) VALUES ($1, $2, 'audio', 'ja')", [rec, owner]);
    return { folder, rec };
  }

  async function withClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  it("makes the 文字起こし holder once per folder and a tab per engine (labels: engine name, then 2, 3…)", async () => {
    const { folder, rec } = await recordingInFolder();
    const first = await withClient(async (client) => {
      const home = await ensureRecordingFolder(client, OWNER, rec);
      assert.deepEqual(home, { recordingId: rec, folder, lang: "ja" });
      return createTranscriptTab(client, OWNER, home!, { engine: "gemini", language: "ja", durationSec: 42 });
    });
    const second = await withClient(async (client) => createTranscriptTab(client, OWNER, (await ensureRecordingFolder(client, OWNER, rec))!, { engine: "gemini", language: "en" }));
    const third = await withClient(async (client) => createTranscriptTab(client, OWNER, (await ensureRecordingFolder(client, OWNER, rec))!, { engine: "deepgram", language: "ja" }));
    assert.equal(second.holder, first.holder);
    assert.equal(third.holder, first.holder);
    const holder = await store.getPage(OWNER, first.holder);
    assert.deepEqual([holder?.kind, holder?.title, holder?.role, holder?.parent, holder?.lastTab], ["page", "文字起こし", { kind: "transcript" }, folder, third.tab]);
    const tabs = await listTranscriptTabs(pool, OWNER, rec);
    assert.deepEqual(tabs.map((tab) => [tab.id, tab.tabName, tab.tabPos, tab.engine, tab.language, tab.durationSec, tab.segmentCount]), [
      [first.tab, "Gemini", 1, "gemini", "ja", 42, 0],
      [second.tab, "Gemini 2", 2, "gemini", "en", null, 0],
      [third.tab, "Deepgram", 3, "deepgram", "ja", null, 0],
    ]);
    const tab = await store.getPage(OWNER, first.tab);
    assert.deepEqual([tab?.kind, tab?.title, tab?.tabName, tab?.parent, tab?.page, tab?.madeFrom], ["note", "文字起こし", "Gemini", folder, first.holder, { kind: "transcript", recording: rec, engine: "gemini" }]);
    assert.deepEqual(await listTranscriptTabs(pool, OTHER, rec), [], "another owner sees nothing");
    assert.equal(await getTranscript(pool, OTHER, first.tab), null);
  });

  it("wraps a recording outside a folder into a folder named after it (holder and tabs move together)", async () => {
    const rec = (await store.createPage(OWNER, { kind: "rec", title: "外の録音" }))!;
    await pool.query("INSERT INTO page_recordings (page_id, owner, source, language) VALUES ($1, $2, 'audio', 'ja')", [rec.id, OWNER]);
    const home = await withClient((client) => ensureRecordingFolder(client, OWNER, rec.id));
    assert.ok(home);
    const folder = await store.getPage(OWNER, home.folder);
    assert.deepEqual([folder?.kind, folder?.title, folder?.parent], ["folder", "外の録音", null]);
    assert.equal((await store.getPage(OWNER, rec.id))?.parent, home.folder);
    assert.equal((await store.getPage(OWNER, rec.page!))?.parent, home.folder);
    // もう一度呼んでも、同じフォルダ
    assert.deepEqual(await withClient((client) => ensureRecordingFolder(client, OWNER, rec.id)), home);
    assert.equal(await withClient((client) => ensureRecordingFolder(client, OTHER, rec.id)), null);
    assert.equal(await withClient((client) => ensureRecordingFolder(client, OWNER, randomUUID())), null);
  });

  it("edits a tab with optimistic locking, keeps versions (edit / restore), and refuses other owners and malformed data", async () => {
    const { rec } = await recordingInFolder();
    const { tab } = await withClient(async (client) => createTranscriptTab(client, OWNER, (await ensureRecordingFolder(client, OWNER, rec))!, { engine: "fake", language: "ja" }));
    const written = await updateTranscript(pool, OWNER, tab, 1, (data) => ({ ...data, segments: SEGMENTS, durationSec: 4 }));
    assert.ok(written?.status === "ok");
    assert.equal(written.transcript.revision, 2);
    assert.deepEqual(written.transcript.segments, SEGMENTS);
    assert.equal(written.transcript.durationSec, 4);
    const stale = await updateTranscript(pool, OWNER, tab, 1, (data) => ({ ...data, speakerNames: { "1": "古い画面" } }));
    assert.equal(stale?.status, "conflict");
    const named = await updateTranscript(pool, OWNER, tab, 2, (data) => ({ ...data, speakerNames: { "1": "合成の話し手" } }));
    assert.ok(named?.status === "ok");
    assert.deepEqual(named.transcript.speakerNames, { "1": "合成の話し手" });
    assert.equal(named.transcript.durationSec, 4, "a mutation without a duration keeps it");
    const rejected = await updateTranscript(pool, OWNER, tab, 3, () => ({ rejected: "nope" as const }));
    assert.deepEqual(rejected, { status: "rejected", reason: "nope" });
    await assert.rejects(() => updateTranscript(pool, OWNER, tab, 3, (data) => ({ ...data, speakerNames: { "9": "いない話者" } })), { name: "InvalidRecordingError" });
    assert.equal(await updateTranscript(pool, OTHER, tab, 3, (data) => data), null);
    // 版: 直す前の本文（initial の空、段落を入れる前の本文）。新しい順
    const versions = await listTranscriptVersions(pool, OWNER, tab);
    assert.deepEqual(versions.map((version) => [version.version, version.reason, version.segmentCount]), [[2, "edit", 2], [1, "edit", 0]]);
    const old = await getTranscriptVersion(pool, OWNER, tab, 2);
    assert.deepEqual(old?.speakerNames, {});
    assert.deepEqual(old?.segments, SEGMENTS);
    const restored = await restoreTranscriptVersion(pool, OWNER, tab, 1, 3);
    assert.ok(restored?.status === "ok");
    assert.deepEqual(restored.transcript.segments, []);
    assert.equal(restored.transcript.revision, 4);
    assert.deepEqual((await listTranscriptVersions(pool, OWNER, tab)).map((version) => [version.version, version.reason]), [[3, "restore"], [2, "edit"], [1, "edit"]]);
    assert.deepEqual(await restoreTranscriptVersion(pool, OWNER, tab, 9, 4), { status: "rejected", reason: "version_missing" });
    assert.equal(await restoreTranscriptVersion(pool, OTHER, tab, 1, 4), null);
    // ゴミ箱のタブは読めない
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [tab]);
    assert.equal(await getTranscript(pool, OWNER, tab), null);
    assert.deepEqual(await listTranscriptTabs(pool, OWNER, rec), []);
  });

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
  const rowOf = async (tab: string) => (await pool.query("SELECT * FROM page_transcripts WHERE page_id = $1", [tab])).rows[0] as Record<string, unknown> | undefined;

  /** 段落（SEGMENTS）・話者名（1 番）・長さ 4 秒を入れた文字起こしのタブ（revision 2）。 */
  async function seededTab(): Promise<{ rec: string; tab: string }> {
    const { rec } = await recordingInFolder();
    const { tab } = await withClient(async (client) => createTranscriptTab(client, OWNER, (await ensureRecordingFolder(client, OWNER, rec))!, { engine: "fake", language: "ja", durationSec: 4 }));
    const written = await updateTranscript(pool, OWNER, tab, 1, (data) => ({ ...data, segments: SEGMENTS, speakerNames: { "1": "司会役" } }));
    assert.ok(written?.status === "ok" && written.transcript.revision === 2);
    return { rec, tab };
  }

  it("saves with the current revision and moves it on; an old revision is a conflict that returns the latest and changes nothing", async () => {
    const { tab } = await seededTab();
    const first = await updateTranscript(pool, OWNER, tab, 2, editText(0, "合成の一つ目を直した"));
    assert.ok(first?.status === "ok");
    assert.equal(first.transcript.revision, 3);
    assert.equal(first.transcript.segments[0]?.text, "合成の一つ目を直した");
    assert.ok(Date.parse(first.transcript.updatedAt) >= Date.parse(first.transcript.createdAt));

    const before = await rowOf(tab);
    let called = false;
    const stale = await updateTranscript(pool, OWNER, tab, 2, (data) => {
      called = true;
      return editText(1, "上書き")(data);
    });
    assert.ok(stale?.status === "conflict");
    assert.deepEqual(stale.transcript, first.transcript, "the latest transcript comes back");
    assert.equal(called, false, "the change is not applied to the newer data");
    assert.deepEqual(await rowOf(tab), before, "nothing was written");
    assert.equal((await updateTranscript(pool, OWNER, tab, 99, rename(1, "先の版")))?.status, "conflict");

    const second = await updateTranscript(pool, OWNER, tab, 3, rename(2, "記録役"));
    assert.ok(second?.status === "ok");
    assert.equal(second.transcript.revision, 4);
    assert.deepEqual(second.transcript.speakerNames, { "1": "司会役", "2": "記録役" });
    assert.equal(second.transcript.segments[0]?.text, "合成の一つ目を直した", "the earlier edit is kept");
  });

  it("writes a new length only when the change returns one（音声・字幕を足して長くなるとき）", async () => {
    const { tab } = await seededTab();
    // 長さを返さない書き換え（文章・話者）は今の長さのまま
    const edited = await updateTranscript(pool, OWNER, tab, 2, editText(0, "直した"));
    assert.ok(edited?.status === "ok");
    assert.equal(edited.transcript.durationSec, 4);
    // 足す書き換えは、新しい長さ（ずらす量 ＋ 足す側の長さ）を返す
    const appended = await updateTranscript(pool, OWNER, tab, 3, (data) => ({
      segments: [...data.segments, { start: data.durationSec ?? 0, end: (data.durationSec ?? 0) + 2, text: "続きです", speaker: 1 }],
      speakerNames: data.speakerNames,
      durationSec: (data.durationSec ?? 0) + 2,
    }));
    assert.ok(appended?.status === "ok");
    assert.equal(appended.transcript.durationSec, 6);
    assert.equal(appended.transcript.segments.at(-1)?.start, 4);
    assert.equal((await getTranscript(pool, OWNER, tab))?.durationSec, 6);
    // null は「長さが分からない」
    const cleared = await updateTranscript(pool, OWNER, tab, 4, (data) => ({ segments: data.segments, speakerNames: data.speakerNames, durationSec: null }));
    assert.ok(cleared?.status === "ok");
    assert.equal(cleared.transcript.durationSec, null);
  });

  it("lets only one of two concurrent writes with the same revision through", async () => {
    const { tab } = await seededTab();
    const results = await Promise.all([
      updateTranscript(pool, OWNER, tab, 2, editText(0, "画面 A の文")),
      updateTranscript(pool, OWNER, tab, 2, editText(0, "画面 B の文")),
    ]);
    assert.deepEqual(results.map((result) => result?.status).sort(), ["conflict", "ok"]);
    const winner = results.find((result) => result?.status === "ok");
    const loser = results.find((result) => result?.status === "conflict");
    assert.ok(winner?.status === "ok" && loser?.status === "conflict");
    assert.deepEqual(loser.transcript, winner.transcript, "the loser gets the winner's text back");
    const stored = await getTranscript(pool, OWNER, tab);
    assert.equal(stored?.revision, 3);
    assert.equal(stored?.segments[0]?.text, winner.transcript.segments[0]?.text);
  });

  it("writes nothing when the change is refused or has the wrong shape", async () => {
    const { tab } = await seededTab();
    const before = await rowOf(tab);
    const refused = await updateTranscript(pool, OWNER, tab, 2, () => ({ rejected: "name" }));
    assert.deepEqual(refused, { status: "rejected", reason: "name" });
    assert.deepEqual(await rowOf(tab), before);

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
        () => updateTranscript(pool, OWNER, tab, 2, mutate),
        (error: unknown) => error instanceof InvalidRecordingError && error.problem === problem,
        problem,
      );
      assert.deepEqual(await rowOf(tab), before, `${problem}: nothing was written`);
    }
    // 断った後も同じ revision でそのまま書ける（lock・transaction が残っていない）
    assert.equal((await updateTranscript(pool, OWNER, tab, 2, rename(2, "あとから")))?.status, "ok");
  });

  it("moves the page's update time on when the transcript is edited, but not on a conflict", async () => {
    const { tab } = await seededTab();
    const before = await store.getPage(OWNER, tab);
    assert.ok(before);
    assert.equal((await updateTranscript(pool, OWNER, tab, 2, editText(0, "直した")))?.status, "ok");
    const after = await store.getPage(OWNER, tab);
    assert.ok(after && Date.parse(after.updatedAt) > Date.parse(before.updatedAt), "pages.updated_at moved on");
    assert.equal((await updateTranscript(pool, OWNER, tab, 2, (data) => data))?.status, "conflict");
    assert.equal((await store.getPage(OWNER, tab))?.updatedAt, after.updatedAt, "a conflict changes nothing");
  });

  it("copies the body with a transcript tab when it is duplicated, as an independent tab that starts again at revision 1", async () => {
    const { rec, tab } = await seededTab();
    assert.equal((await updateTranscript(pool, OWNER, tab, 2, rename(2, "聞き手")))?.status, "ok");
    const copy = await duplicatePage(pool, OWNER, tab);
    assert.ok(copy);
    assert.notEqual(copy.id, tab);
    const copied = await getTranscript(pool, OWNER, copy.id);
    assert.ok(copied);
    assert.equal(copied.revision, 1, "the copy starts again at revision 1");
    assert.deepEqual(copied.segments, SEGMENTS);
    assert.deepEqual(copied.speakerNames, { "1": "司会役", "2": "聞き手" });
    assert.equal(copied.recordingPageId, rec);
    // 別のタブになる: コピーを直しても元は変わらない
    assert.equal((await updateTranscript(pool, OWNER, copy.id, 1, editText(0, "コピーだけ直した")))?.status, "ok");
    const original = await getTranscript(pool, OWNER, tab);
    assert.equal(original?.revision, 3);
    assert.equal(original?.segments[0]?.text, SEGMENTS[0]!.text);
    assert.equal(await duplicatePage(pool, OTHER, tab), null);
  });

  it("drops the transcript rows when the tab is hard-deleted, and keeps the body when the recording is", async () => {
    const { rec } = await recordingInFolder();
    const { tab } = await withClient(async (client) => createTranscriptTab(client, OWNER, (await ensureRecordingFolder(client, OWNER, rec))!, { engine: "fake", language: "ja" }));
    await updateTranscript(pool, OWNER, tab, 1, (data) => ({ ...data, segments: SEGMENTS }));
    await pool.query("DELETE FROM pages WHERE id = $1", [rec]);
    assert.deepEqual((await getTranscript(pool, OWNER, tab))?.segments, SEGMENTS, "the transcript outlives its recording");
    await pool.query("DELETE FROM pages WHERE id = $1", [tab]);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM page_transcripts WHERE page_id = $1", [tab])).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM page_transcript_versions WHERE page_id = $1", [tab])).rows[0].n, 0);
  });
});

/** 既存のデータに migration を当てる: 正本の段落と案が文字起こしのタブになり、run はそのタブを指す（#310）。 */
describe("migration page_transcripts on existing recordings and candidates", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;
  let dir: string;
  let migration = "";

  before(async () => {
    ({ pool, drop } = await withSchema("transcripts_up"));
    dir = await mkdtemp(join(tmpdir(), "editor-store-transcripts-up-"));
    const names = (await readdir(defaultMigrationsDir)).filter((name) => MIGRATION_FILE_PATTERN.test(name)).sort();
    migration = names.find((name) => name.endsWith("_page_transcripts.sql"))!;
    assert.ok(migration);
    for (const name of names) if (name < migration) await copyFile(new URL(name, defaultMigrationsDir), join(dir, name));
  });

  after(async () => {
    await drop();
    await rm(dir, { recursive: true, force: true });
  });

  it("turns the adopted body and every candidate into tabs of a 文字起こし page, wraps recordings outside folders, and points runs at their tabs", async () => {
    const client = await pool.connect();
    try {
      await applyMigrations(client, pathToFileURL(`${dir}/`));
      const id = async (sql: string, values: unknown[]) => (await client.query<{ id: string }>(sql, values)).rows[0]!.id;
      // 1. フォルダの中の録音: 正本（採用中の案と同じ本文）＋ 案 2 つ（採用中・別案）＋ 版 ＋ run
      const folder = await id("INSERT INTO pages (owner, kind, title) VALUES ($1, 'folder', '取材') RETURNING id", [OWNER]);
      const holderA = await id("INSERT INTO pages (owner, kind, title, parent) VALUES ($1, 'page', '録音 A', $2) RETURNING id", [OWNER, folder]);
      const recA = await id("INSERT INTO pages (owner, kind, title, parent, page) VALUES ($1, 'rec', '録音 A', $2, $3) RETURNING id", [OWNER, folder, holderA]);
      await client.query("INSERT INTO page_recordings (page_id, owner, source, language, engine, duration_sec, segments, speaker_names, revision) VALUES ($1, $2, 'audio', 'ja', 'deepgram', 10, $3::jsonb, '{\"1\":\"合成の話し手\"}'::jsonb, 3)", [recA, OWNER, JSON.stringify(SEGMENTS)]);
      const adopted = await id("INSERT INTO page_recording_candidates (page_id, owner, name, engine, language, segments, speaker_names, duration_sec, adopted) VALUES ($1, $2, 'Deepgram', 'deepgram', 'ja', $3::jsonb, '{\"1\":\"合成の話し手\"}'::jsonb, 10, true) RETURNING id", [recA, OWNER, JSON.stringify(SEGMENTS)]);
      const other = await id("INSERT INTO page_recording_candidates (page_id, owner, name, engine, language, segments, speaker_names, duration_sec, adopted) VALUES ($1, $2, 'Gemini', 'gemini', 'ja', $3::jsonb, '{}'::jsonb, 9, false) RETURNING id", [recA, OWNER, JSON.stringify([SEGMENTS[0]])]);
      // 案の版（trigger が initial を入れている。もう 1 つ edit を足す）
      await client.query("SELECT set_config('niho.recording_candidate_reason', 'edit', false)");
      await client.query("UPDATE page_recording_candidates SET segments = $2::jsonb WHERE id = $1", [other, JSON.stringify([{ ...SEGMENTS[0]!, text: "直した段落" }])]);
      // 正本に書いた run（base_revision は録音の revision 3）と、別案に書いた run（candidate_revision 1）
      const serverRun = await id("INSERT INTO transcription_runs (owner, page_id, engine, status, language, base_revision, started_at, finished_at) VALUES ($1, $2, 'deepgram', 'succeeded', 'ja', 3, clock_timestamp(), clock_timestamp()) RETURNING id", [OWNER, recA]);
      const candidateRun = await id("INSERT INTO transcription_runs (owner, page_id, engine, status, language, candidate, candidate_revision, started_at, finished_at) VALUES ($1, $2, 'gemini', 'succeeded', 'ja', $3, 1, clock_timestamp(), clock_timestamp()) RETURNING id", [OWNER, recA, other]);
      // 開始後に録音が直された run（base_revision 2 ≠ 3）は、移行後も合わないまま（superseded になる）
      const staleServerRun = await id("INSERT INTO transcription_runs (owner, page_id, engine, status, language, base_revision, error_code, started_at, finished_at) VALUES ($1, $2, 'deepgram', 'failed', 'ja', 2, 'internal', clock_timestamp(), clock_timestamp()) RETURNING id", [OWNER, recA]);
      // 移行の時点で動いている run（録音ごとに 1 つ）: 別案に書くもの（candidate_revision は案の今の revision 2）
      const liveCandidateRun = await id("INSERT INTO transcription_runs (owner, page_id, engine, status, language, candidate, candidate_revision, base_revision) VALUES ($1, $2, 'gemini', 'queued', 'ja', $3, 2, 3) RETURNING id", [OWNER, recA, other]);
      // 2. フォルダの外の録音（正本だけ）
      const holderB = await id("INSERT INTO pages (owner, kind, title) VALUES ($1, 'page', '外の録音') RETURNING id", [OWNER]);
      const recB = await id("INSERT INTO pages (owner, kind, title, page) VALUES ($1, 'rec', '外の録音', $2) RETURNING id", [OWNER, holderB]);
      await client.query("INSERT INTO page_recordings (page_id, owner, source, language, engine, segments) VALUES ($1, $2, 'vtt', 'en', 'vtt-import', $3::jsonb)", [recB, OWNER, JSON.stringify(SEGMENTS)]);
      // 移行の時点で正本に書いている run（base_revision は録音の revision 1 のまま）
      const liveServerRun = await id("INSERT INTO transcription_runs (owner, page_id, engine, status, language, base_revision, started_at) VALUES ($1, $2, 'deepgram', 'running', 'en', 1, clock_timestamp()) RETURNING id", [OWNER, recB]);
      // 3. 段落も案も無い録音: 何も作らない
      const recC = await id("INSERT INTO pages (owner, kind, title, parent, page) VALUES ($1, 'rec', '空の録音', $2, $3) RETURNING id", [OWNER, folder, holderA]);
      await client.query("INSERT INTO page_recordings (page_id, owner, source, language, segments) VALUES ($1, $2, 'audio', 'ja', '[]'::jsonb)", [recC, OWNER]);

      await copyFile(new URL(migration, defaultMigrationsDir), join(dir, migration));
      assert.deepEqual((await applyMigrations(client, pathToFileURL(`${dir}/`))).applied, [migration]);

      // 録音 A: 入れ物「文字起こし」がフォルダ直下に 1 つ、タブは案ごと（採用中の案が正本を代表する）
      const tabsA = await listTranscriptTabs(client, OWNER, recA);
      assert.deepEqual(tabsA.map((tab) => [tab.tabName, tab.engine, tab.segmentCount, tab.durationSec]), [["Deepgram", "deepgram", 2, 10], ["Gemini", "gemini", 1, 9]]);
      const holder = (await client.query<{ id: string; title: string; role: unknown; parent: string; last_tab: string }>("SELECT id, title, role, parent, last_tab FROM pages WHERE owner = $1 AND parent = $2 AND kind = 'page' AND role IS NOT NULL", [OWNER, folder])).rows;
      assert.equal(holder.length, 1);
      assert.deepEqual([holder[0]!.title, holder[0]!.role], ["文字起こし", { kind: "transcript" }]);
      const deepgramTab = tabsA[0]!.id;
      const geminiTab = tabsA[1]!.id;
      const deepgram = await getTranscript(client, OWNER, deepgramTab);
      assert.deepEqual([deepgram?.recordingPageId, deepgram?.segments, deepgram?.speakerNames, deepgram?.language], [recA, SEGMENTS, { "1": "合成の話し手" }, "ja"]);
      const tabRow = (await client.query<{ kind: string; title: string; parent: string; page: string; made_from: unknown }>("SELECT kind, title, parent, page, made_from FROM pages WHERE id = $1", [deepgramTab])).rows[0];
      assert.deepEqual(tabRow, { kind: "note", title: "文字起こし", parent: folder, page: holder[0]!.id, made_from: { kind: "transcript", recording: recA, engine: "deepgram" } });
      // 版は案の版から（initial と edit）
      assert.deepEqual((await listTranscriptVersions(client, OWNER, geminiTab)).map((version) => [version.version, version.reason]), [[2, "edit"], [1, "initial"]]);
      assert.deepEqual((await getTranscript(client, OWNER, geminiTab))?.segments, [{ ...SEGMENTS[0]!, text: "直した段落" }]);
      // run は書き先のタブを指す。照合用の base_revision はタブの revision に合わせる（確定がタブの revision と比べるため）
      const runs = (await client.query<{ id: string; target_tab: string | null; base_revision: number }>("SELECT id, target_tab, base_revision FROM transcription_runs WHERE id = ANY($1::uuid[]) ORDER BY created_at", [[serverRun, candidateRun, staleServerRun, liveCandidateRun]])).rows;
      assert.deepEqual(runs.map((row) => row.target_tab), [deepgramTab, geminiTab, deepgramTab, geminiTab]);
      const tabRevisions = Object.fromEntries((await client.query<{ page_id: string; revision: number }>("SELECT page_id, revision FROM page_transcripts WHERE page_id = ANY($1::uuid[])", [[deepgramTab, geminiTab]])).rows.map((row) => [row.page_id, row.revision]));
      assert.deepEqual([tabRevisions[deepgramTab], tabRevisions[geminiTab]], [1, 2], "the tabs keep the candidates' revisions");
      assert.equal(runs[0]!.base_revision, 1, "a run on the 正本 (recording revision unchanged) now checks against the adopted candidate's tab");
      assert.equal(runs[1]!.base_revision, 1, "a run on a candidate carries its candidate_revision");
      assert.equal(runs[2]!.base_revision, 2, "a run whose recording changed after it started stays stale");
      assert.equal(runs[3]!.base_revision, 2, "a live run on a candidate carries the candidate's current revision");
      // 正本はそのまま（contract は後の migration）
      assert.deepEqual((await client.query<{ segments: unknown }>("SELECT segments FROM page_recordings WHERE page_id = $1", [recA])).rows[0]?.segments, SEGMENTS);

      // 録音 B: 題名のフォルダに包まれ、その中に入れ物とタブ（札は取り込んだ字幕）
      const recBRow = (await client.query<{ parent: string | null }>("SELECT parent FROM pages WHERE id = $1", [recB])).rows[0]!;
      assert.ok(recBRow.parent);
      const folderB = (await client.query<{ kind: string; title: string; parent: string | null }>("SELECT kind, title, parent FROM pages WHERE id = $1", [recBRow.parent])).rows[0];
      assert.deepEqual(folderB, { kind: "folder", title: "外の録音", parent: null });
      assert.equal((await client.query<{ parent: string | null }>("SELECT parent FROM pages WHERE id = $1", [holderB])).rows[0]?.parent, recBRow.parent);
      const tabsB = await listTranscriptTabs(client, OWNER, recB);
      assert.deepEqual(tabsB.map((tab) => [tab.tabName, tab.engine, tab.language, tab.segmentCount]), [["取り込んだ字幕", "vtt-import", "en", 2]]);
      // 正本に書いている run は正本のタブへ（revision 1 のまま合う）
      const liveB = (await client.query<{ target_tab: string | null; base_revision: number }>("SELECT target_tab, base_revision FROM transcription_runs WHERE id = $1", [liveServerRun])).rows[0];
      assert.deepEqual(liveB, { target_tab: tabsB[0]!.id, base_revision: 1 });
      assert.equal((await client.query<{ parent: string }>("SELECT parent FROM pages WHERE id = $1", [tabsB[0]!.id])).rows[0]?.parent, recBRow.parent);

      // 録音 C: 何も作らない
      assert.deepEqual(await listTranscriptTabs(client, OWNER, recC), []);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM pages WHERE owner = $1 AND kind = 'folder'", [OWNER])).rows[0].n, 2);
    } finally {
      client.release();
    }
  });
});
