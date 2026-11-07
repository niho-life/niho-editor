import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import type { Pool as PgPool } from "pg";
import { MIGRATION_FILE_PATTERN, applyMigrations, defaultMigrationsDir } from "../src/migrate.ts";
import { getRecording } from "../src/recordings.ts";
import { EditorStore } from "../src/store.ts";
import { getTranscript, listTranscriptTabs, readTranscriptText } from "../src/transcripts.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const OWNER = "synthetic-owner-a";

describe("migration 0002 on a database that already has pages and versions", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_store_upgrade_${randomUUID().replaceAll("-", "")}`;
  let pool: PgPool;
  let onlyFirst: string;

  before(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    // 0001 だけを置いた migration の置き場（中身は同じファイルなので checksum も同じ）
    onlyFirst = await mkdtemp(join(tmpdir(), "editor-store-0001-"));
    await copyFile(new URL("0001_editor_store.sql", defaultMigrationsDir), join(onlyFirst, "0001_editor_store.sql"));
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    await rm(onlyFirst, { recursive: true, force: true });
  });

  it("keeps the rows, starts every page at revision 1, and widens the version reasons", async () => {
    const client = await pool.connect();
    try {
      const first = await applyMigrations(client, pathToFileURL(`${onlyFirst}/`));
      assert.deepEqual(first.applied, ["0001_editor_store.sql"]);

      const page = await client.query<{ id: string }>(
        `INSERT INTO pages (owner, title, blocks) VALUES ($1, '既存の題名', '[{"type":"paragraph","content":[{"type":"text","text":"既存の本文"}]}]') RETURNING id`,
        [OWNER],
      );
      const pageId = page.rows[0]!.id;
      const trashed = await client.query<{ id: string }>(
        "INSERT INTO pages (owner, title, deleted_at) VALUES ($1, 'ゴミ箱の既存', clock_timestamp()) RETURNING id",
        [OWNER],
      );
      await client.query(
        `INSERT INTO page_versions (page_id, version, blocks, reason) VALUES
           ($1, 1, '[{"type":"paragraph"}]', 'autosave'),
           ($1, 2, '[{"type":"paragraph"}]', 'ai'),
           ($1, 3, '[{"type":"paragraph"}]', 'publish')`,
        [pageId],
      );
      await client.query("INSERT INTO publications (page_id, dest, slug, range, published_version) VALUES ($1, 'synthetic', 'existing', 'live', 3)", [pageId]);
      // 0001 の CHECK は新しい理由を断る
      await assert.rejects(() => client.query("INSERT INTO page_versions (page_id, version, blocks, reason) VALUES ($1, 9, '[]', 'restore')", [pageId]), {
        code: "23514",
      });

      // 0002 のあとに足された migration（0003 の検索など）も、ここでいっしょに適用される。このテストが見るのは 0002 の上がり方。
      // 0009 は 0001 の publications を作り直す（行があれば止まる）ので、ここでは 0008 までを流す（0009 は publications.integration.test.ts）
      for (const name of await readdir(defaultMigrationsDir)) {
        if (MIGRATION_FILE_PATTERN.test(name) && name < "0009") await copyFile(new URL(name, defaultMigrationsDir), join(onlyFirst, name));
      }
      const second = await applyMigrations(client, pathToFileURL(`${onlyFirst}/`));
      assert.equal(second.applied[0], "0002_versions_and_trash.sql");
      assert.deepEqual(second.skipped, ["0001_editor_store.sql"]);

      const row = async (id: string) =>
        (await client.query<{ title: string; revision: number; deleted: boolean }>(
          "SELECT title, revision, deleted_at IS NOT NULL AS deleted FROM pages WHERE id = $1",
          [id],
        )).rows[0];
      assert.equal((await client.query("SELECT 1 FROM pages")).rows.length, 2);
      assert.deepEqual(await row(pageId), { title: "既存の題名", revision: 1, deleted: false });
      assert.deepEqual(await row(trashed.rows[0]!.id), { title: "ゴミ箱の既存", revision: 1, deleted: true });
      const versions = await client.query<{ version: number; reason: string }>("SELECT version, reason FROM page_versions WHERE page_id = $1 ORDER BY version", [pageId]);
      assert.deepEqual(versions.rows.map((row) => [row.version, row.reason]), [[1, "autosave"], [2, "ai"], [3, "publish"]]);
      assert.equal((await client.query("SELECT 1 FROM publications WHERE page_id = $1 AND published_version = 3", [pageId])).rows.length, 1);

      for (const [version, reason] of [[4, "overwrite"], [5, "restore"]] as const) {
        await client.query("INSERT INTO page_versions (page_id, version, blocks, reason) VALUES ($1, $2, '[]', $3)", [pageId, version, reason]);
      }
      await assert.rejects(() => client.query("INSERT INTO page_versions (page_id, version, blocks, reason) VALUES ($1, 9, '[]', 'manual')", [pageId]), {
        code: "23514",
      });
      await assert.rejects(() => client.query("UPDATE pages SET revision = 0 WHERE id = $1", [pageId]), { code: "23514" });

      // ここから先は store（今の schema を読む）で確かめるので、残りの migration も流す。0009 は 0001 の publications を
      // 作り直す（行があれば止まる）ので、上で確かめ終えた公開の行だけ外してから流す
      await client.query("DELETE FROM publications WHERE page_id = $1", [pageId]);
      for (const name of await readdir(defaultMigrationsDir)) {
        if (MIGRATION_FILE_PATTERN.test(name)) await copyFile(new URL(name, defaultMigrationsDir), join(onlyFirst, name));
      }
      const rest = await applyMigrations(client, pathToFileURL(`${onlyFirst}/`));
      assert.ok(rest.applied.includes("0009_publications.sql"), "0009 から先も、既存の行を持つ DB に流せる");

      // 既存のページはそのまま store で読み書きでき、版の番号は既存の続きから
      const store = new EditorStore(pool, { autosaveVersionIntervalMs: 0 });
      const read = await store.getPage(OWNER, pageId);
      assert.equal(read?.revision, 1);
      const saved = await store.savePage(OWNER, pageId, { blocks: [{ type: "paragraph", content: [{ type: "text", text: "新しい本文" }] }] }, { baseRevision: 1 });
      assert.equal(saved?.status, "saved");
      assert.equal(saved?.page.revision, 2);
      assert.equal((await store.listVersions(OWNER, pageId))?.[0]?.version, 6);
      assert.ok((await store.listTrash(OWNER)).some((item) => item.id === trashed.rows[0]!.id));
    } finally {
      client.release();
    }
  });
});

/**
 * #310 の contract（drop_recording_candidates）を、#327 の migration（page_transcripts）が当たって動いている DB に当てる。
 * 文字起こしのタブ・候補・古い run・ゴミ箱の録音を入れた状態から、止める条件（動いている古い run・タブに写されていない段落）と、
 * 落とすもの・残るものを確かめる。空の DB に全部を当てる道は、ほかの integration test が毎回通る。
 */
describe("migration drop_recording_candidates on a database that has the page_transcripts data (#310)", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_store_contract_${randomUUID().replaceAll("-", "")}`;
  const SEGMENTS = [
    { start: 0, end: 2, text: "合成の一つ目の段落です。", speaker: 1 },
    { start: 2, end: 4, text: "合成の二つ目の段落です。", speaker: null },
  ];
  let pool: PgPool;
  let dir: string;
  let migration = "";

  before(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    dir = await mkdtemp(join(tmpdir(), "editor-store-contract-"));
    const names = (await readdir(defaultMigrationsDir)).filter((name) => MIGRATION_FILE_PATTERN.test(name)).sort();
    migration = names.find((name) => name.endsWith("_drop_recording_candidates.sql"))!;
    assert.ok(migration);
    // #327 までの migration（page_transcripts を含む）。契約の migration より後のものは、この試験の時点では存在しない
    for (const name of names) if (name < migration) await copyFile(new URL(name, defaultMigrationsDir), join(dir, name));
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  });

  it("stops while an old run or a paragraph outside any tab remains, then drops the candidates and the old paragraphs and keeps the tabs, the runs and the trash", async () => {
    const client = await pool.connect();
    try {
      const upToExpand = await applyMigrations(client, pathToFileURL(`${dir}/`));
      assert.ok(upToExpand.applied.includes("20261107042444_page_transcripts.sql") && !upToExpand.applied.includes(migration));
      const id = async (sql: string, values: unknown[]) => (await client.query<{ id: string }>(sql, values)).rows[0]!.id;
      const columns = async (table: string) =>
        (await client.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1", [table])).rows.map((row) => row.column_name);
      const tables = async () => (await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'page_recording_candidate%'")).rows.map((row) => row.tablename);

      // 1. #327 の移行を終えた録音: フォルダ・入れ物・文字起こしのタブ（段落）・正本（そのまま残っている）・採用中の案・run
      const folder = await id("INSERT INTO pages (owner, kind, title) VALUES ($1, 'folder', '取材') RETURNING id", [OWNER]);
      const holder = await id("INSERT INTO pages (owner, kind, title, parent) VALUES ($1, 'page', '録音 A', $2) RETURNING id", [OWNER, folder]);
      const rec = await id("INSERT INTO pages (owner, kind, title, parent, page) VALUES ($1, 'rec', '録音 A', $2, $3) RETURNING id", [OWNER, folder, holder]);
      await client.query("INSERT INTO page_recordings (page_id, owner, source, language, engine, duration_sec, segments, speaker_names, revision) VALUES ($1, $2, 'audio', 'ja', 'deepgram', 4, $3::jsonb, '{\"1\":\"合成の話し手\"}'::jsonb, 3)", [rec, OWNER, JSON.stringify(SEGMENTS)]);
      const candidate = await id("INSERT INTO page_recording_candidates (page_id, owner, name, engine, language, segments, speaker_names, duration_sec, adopted) VALUES ($1, $2, 'Deepgram', 'deepgram', 'ja', $3::jsonb, '{\"1\":\"合成の話し手\"}'::jsonb, 4, true) RETURNING id", [rec, OWNER, JSON.stringify(SEGMENTS)]);
      const transcriptHolder = await id("INSERT INTO pages (owner, kind, title, parent, role) VALUES ($1, 'page', '文字起こし', $2, '{\"kind\":\"transcript\"}'::jsonb) RETURNING id", [OWNER, folder]);
      const tab = await id("INSERT INTO pages (owner, kind, title, parent, page, made_from, tab_name) VALUES ($1, 'note', '文字起こし', $2, $3, $4::jsonb, 'Deepgram') RETURNING id", [OWNER, folder, transcriptHolder, JSON.stringify({ kind: "transcript", recording: rec, engine: "deepgram" })]);
      await client.query("INSERT INTO page_transcripts (page_id, owner, recording_page_id, engine, language, segments, speaker_names, duration_sec, revision) VALUES ($1, $2, $3, 'deepgram', 'ja', $4::jsonb, '{\"1\":\"合成の話し手\"}'::jsonb, 4, 2)", [tab, OWNER, rec, JSON.stringify(SEGMENTS)]);
      await client.query("INSERT INTO page_transcript_versions (page_id, version, engine, language, segments, speaker_names, duration_sec, reason) VALUES ($1, 1, 'deepgram', 'ja', $2::jsonb, '{}'::jsonb, 4, 'initial')", [tab, JSON.stringify(SEGMENTS)]);
      // 終わった run: タブに書いたもの（target_tab あり）と、#310 より前に案に書いた古いもの（target_tab なし・candidate あり）
      const tabRun = await id("INSERT INTO transcription_runs (owner, page_id, engine, status, language, base_revision, target_tab, started_at, finished_at) VALUES ($1, $2, 'deepgram', 'succeeded', 'ja', 1, $3, clock_timestamp(), clock_timestamp()) RETURNING id", [OWNER, rec, tab]);
      const oldRun = await id("INSERT INTO transcription_runs (owner, page_id, engine, status, language, candidate, candidate_revision, replace, base_revision, started_at, finished_at) VALUES ($1, $2, 'deepgram', 'succeeded', 'ja', $3, 1, true, 3, clock_timestamp(), clock_timestamp()) RETURNING id", [OWNER, rec, candidate]);
      // ゴミ箱の録音（#327 の移行の対象外で、タブが無い。段落は正本にだけある）
      const trashed = await id("INSERT INTO pages (owner, kind, title, deleted_at) VALUES ($1, 'rec', 'ゴミ箱の録音', clock_timestamp()) RETURNING id", [OWNER]);
      await client.query("INSERT INTO page_recordings (page_id, owner, source, language, segments) VALUES ($1, $2, 'vtt', 'ja', $3::jsonb)", [trashed, OWNER, JSON.stringify(SEGMENTS)]);
      // 段落の無い録音（タブが無くてよい）
      const bare = await id("INSERT INTO pages (owner, kind, title) VALUES ($1, 'rec', '段落の無い録音') RETURNING id", [OWNER]);
      await client.query("INSERT INTO page_recordings (page_id, owner, source, language, segments) VALUES ($1, $2, 'audio', 'ja', '[]'::jsonb)", [bare, OWNER]);

      await copyFile(new URL(migration, defaultMigrationsDir), join(dir, migration));
      const dirUrl = pathToFileURL(`${dir}/`);
      const applied = async () => (await client.query<{ name: string }>("SELECT name FROM editor_store_migrations")).rows.map((row) => row.name);

      // 2. 動いている古い run（target_tab なしの queued）があれば止まる。何も変わらない（transaction ごと戻る）
      const live = await id("INSERT INTO transcription_runs (owner, page_id, engine, status, language, base_revision) VALUES ($1, $2, 'deepgram', 'queued', 'ja', 1) RETURNING id", [OWNER, bare]);
      await assert.rejects(() => applyMigrations(client, dirUrl), (error: unknown) => (error as { code?: string; message: string }).code === "55000" && /still queued or running/.test((error as Error).message));
      assert.ok(!(await applied()).includes(migration));
      assert.equal((await tables()).length, 3, "the candidate tables are still there");
      assert.ok((await columns("transcription_runs")).includes("candidate"));
      await client.query("UPDATE transcription_runs SET status = 'failed', error_code = 'internal', finished_at = clock_timestamp() WHERE id = $1", [live]);

      // 3. 生きている録音に、どのタブにも写されていない段落が残っていれば止まる（ゴミ箱の録音は数えない）
      const stray = await id("INSERT INTO pages (owner, kind, title) VALUES ($1, 'rec', 'タブの無い録音') RETURNING id", [OWNER]);
      await client.query("INSERT INTO page_recordings (page_id, owner, source, language, segments) VALUES ($1, $2, 'vtt', 'ja', $3::jsonb)", [stray, OWNER, JSON.stringify(SEGMENTS)]);
      await assert.rejects(() => applyMigrations(client, dirUrl), (error: unknown) => (error as { code?: string; message: string }).code === "55000" && /no transcript tab holds/.test((error as Error).message));
      assert.ok(!(await applied()).includes(migration));
      assert.ok((await columns("page_recordings")).includes("segments"), "the old paragraphs are still there");
      await client.query("UPDATE page_recordings SET segments = '[]'::jsonb WHERE page_id = $1", [stray]);

      // 4. 条件が揃えば通る
      assert.deepEqual((await applyMigrations(client, dirUrl)).applied, [migration]);
      assert.ok((await applied()).includes(migration));

      // 落としたもの: 候補の表・trigger の関数・run の宛先の列・録音の正本の段落
      assert.deepEqual(await tables(), []);
      assert.deepEqual((await client.query("SELECT proname FROM pg_proc WHERE proname LIKE '%recording_candidate%' AND pronamespace = current_schema()::regnamespace")).rows, []);
      assert.deepEqual((await columns("transcription_runs")).filter((name) => ["candidate", "candidate_revision", "replace"].includes(name)), []);
      assert.deepEqual((await columns("page_recordings")).filter((name) => ["segments", "speaker_names"].includes(name)), []);
      assert.deepEqual((await client.query("SELECT conname FROM pg_constraint WHERE conname IN ('page_recordings_segments_max', 'transcription_runs_candidate_fkey', 'transcription_runs_candidate_revision_pair')")).rows, []);
      assert.deepEqual((await client.query("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'transcription_runs_candidate_idx'")).rows, []);

      // 残るもの: 文字起こしのタブ（本文・版）、run の行（古いものも）、録音の行（revision・音声・原本の名前）、ゴミ箱の録音の行
      const kept = await getTranscript(client, OWNER, tab);
      assert.deepEqual([kept?.segments, kept?.speakerNames, kept?.revision, kept?.recordingPageId], [SEGMENTS, { "1": "合成の話し手" }, 2, rec]);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM page_transcript_versions WHERE page_id = $1", [tab])).rows[0].n, 1);
      const runs = (await client.query<{ id: string; status: string; target_tab: string | null; base_revision: number }>("SELECT id, status, target_tab, base_revision FROM transcription_runs WHERE id = ANY($1::uuid[])", [[tabRun, oldRun]])).rows;
      assert.deepEqual(Object.fromEntries(runs.map((run) => [run.id, [run.status, run.target_tab, run.base_revision]])), { [tabRun]: ["succeeded", tab, 1], [oldRun]: ["succeeded", null, 3] });
      const recording = await getRecording(client, OWNER, rec);
      assert.deepEqual([recording?.revision, recording?.engine, recording?.durationSec], [3, "deepgram", 4]);
      assert.ok(recording && !("segments" in recording));
      assert.equal((await client.query("SELECT count(*)::int AS n FROM page_recordings WHERE page_id = $1", [trashed])).rows[0].n, 1);
      assert.equal((await listTranscriptTabs(client, OWNER, rec)).length, 1);
      // 読み手は文字起こしのタブから読める。タブの無い録音は空（正本の fallback は無い）
      assert.deepEqual((await readTranscriptText(client, OWNER, rec))?.segments, SEGMENTS);
      assert.equal(await readTranscriptText(client, OWNER, bare), null);
      // 録音の行を消しても、ページごと消してもエラーにならない（外部キー・trigger が残っていない）
      await client.query("DELETE FROM pages WHERE id = $1", [rec]);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM transcription_runs WHERE id = ANY($1::uuid[])", [[tabRun, oldRun]])).rows[0].n, 0, "runs go with their recording page");
      assert.deepEqual((await getTranscript(client, OWNER, tab))?.segments, SEGMENTS, "the transcript outlives its recording");
    } finally {
      client.release();
    }
  });
});
