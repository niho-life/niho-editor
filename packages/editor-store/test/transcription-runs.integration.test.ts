import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Pool as PgPool } from "pg";
import { applyMigrations, defaultMigrationsDir, readMigrations } from "../src/migrate.ts";
import { completeAudioUpload, startAudioRecording, type StartAudioRecordingInput } from "../src/recording-audio.ts";
import { InvalidRecordingError, createRecordingPage, getRecording, updateRecording, type Connectable, type RecordingSegment } from "../src/recordings.ts";
import { EditorStore } from "../src/store.ts";
import {
  claimRun,
  enqueueTranscription,
  failRun,
  finishRun,
  latestRun,
  listQueuedRuns,
  requeueRun,
  sweepStaleRuns,
  transcriptionStatus,
  type EnqueueTranscriptionInput,
} from "../src/transcription-runs.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID・ファイル名・ハッシュ・段落だけを使う（実在の人・実際の音声・会話を入れない）
const OWNER = "synthetic-transcribe-owner-a";
const OTHER = "synthetic-transcribe-owner-b";
const DECLARED_SHA = "b".repeat(64);
const REQUEST_HASH = "3".repeat(64);

const RESULT: RecordingSegment[] = [
  { start: 0, end: 2.5, text: "合成の一つ目の段落です。", speaker: 1 },
  { start: 2.5, end: 5, text: "合成の二つ目の段落です。", speaker: 2 },
];

async function withSchema(label: string): Promise<{ pool: PgPool; drop: () => Promise<void> }> {
  const { Pool } = await import("pg");
  const schema = `editor_store_${label}_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
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
    bytes: 64,
    sha256: DECLARED_SHA,
    durationSec: 30,
    uploadKey: null,
    requestHash: REQUEST_HASH,
    retentionDays: 30,
    ...extra,
  };
}

const run = (extra: Partial<EnqueueTranscriptionInput> = {}): EnqueueTranscriptionInput => ({
  engine: "fake",
  diarize: true,
  replace: false,
  terms: [],
  ...extra,
});

/** アップロード済みの音声の録音ページを作り、page id を返す。 */
async function uploadedRecording(pool: PgPool, owner: string = OWNER, extra: Partial<StartAudioRecordingInput> = {}): Promise<string> {
  const started = await startAudioRecording(pool, owner, startInput(extra));
  assert.ok(started.status === "created");
  const done = await completeAudioUpload(pool, owner, started.page.id, { sizeBytes: started.recording.audio!.bytes });
  assert.equal(done?.status, "ok");
  return started.page.id;
}

/**
 * 0011 までの schema（音声と案の migration より前の DB）に、アップロード済みの音声の録音を直に入れる。store の startAudioRecording は
 * 今の列を書くので、古い schema の「既にある行」はここで作る。
 */
async function legacyUploadedRecording(pool: PgPool, owner: string = OWNER): Promise<string> {
  const assetId = randomUUID();
  const page = (
    await pool.query<{ id: string }>("INSERT INTO pages (owner, kind, title, lang, blocks) VALUES ($1, 'rec', $2, 'ja', '[]'::jsonb) RETURNING id", [
      owner,
      "合成の打ち合わせ",
    ])
  ).rows[0]!;
  await pool.query(
    `INSERT INTO assets (id, owner, page_id, kind, bucket_path, bytes, sha256, content_type)
     VALUES ($1, $2, $3, 'audio', $4, 64, $5, 'audio/mp4')`,
    [assetId, owner, page.id, `audio/${assetId}`, DECLARED_SHA],
  );
  await pool.query(
    `INSERT INTO page_recordings
       (page_id, owner, source, language, engine, duration_sec, source_name, segments, speaker_names, audio_asset, audio_status, audio_expires_at)
     VALUES ($1, $2, 'audio', 'ja', NULL, 30, $3, '[]'::jsonb, '{}'::jsonb, $4, 'uploaded', clock_timestamp() + make_interval(hours => 720))`,
    [page.id, owner, "合成の打ち合わせ.m4a", assetId],
  );
  return page.id;
}

async function runRow(pool: PgPool, id: string): Promise<Record<string, unknown> | undefined> {
  return (await pool.query("SELECT * FROM transcription_runs WHERE id = $1", [id])).rows[0];
}

async function recordingRow(pool: PgPool, pageId: string): Promise<Record<string, unknown> | undefined> {
  return (await pool.query("SELECT * FROM page_recordings WHERE page_id = $1", [pageId])).rows[0];
}

async function countRuns(pool: PgPool, pageId: string): Promise<number> {
  return (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM transcription_runs WHERE page_id = $1", [pageId])).rows[0]!.n;
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

/** run を作って claim し、id と世代を返す。 */
async function claimed(pool: PgPool, pageId: string, extra: Partial<EnqueueTranscriptionInput> = {}): Promise<{ id: string; generation: number }> {
  const created = await enqueueTranscription(pool, OWNER, pageId, run(extra));
  assert.equal(created?.status, "created");
  assert.ok(created?.status === "created");
  const claim = await claimRun(pool, created.run.id);
  assert.ok(claim);
  return { id: created.run.id, generation: claim.generation };
}

describe("transcription runs without a database", () => {
  const untouchable = {
    query: () => {
      throw new Error("must not reach the database");
    },
    connect: () => {
      throw new Error("must not reach the database");
    },
  } as unknown as PgPool;

  it("treats malformed ids as missing and refuses bad arguments without querying", async () => {
    for (const id of ["", "not-a-uuid", "00000000-0000-0000-0000-00000000000g", "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11' OR '1'='1"]) {
      assert.equal(await enqueueTranscription(untouchable, OWNER, id, run()), null, id);
      assert.equal(await claimRun(untouchable, id), null, id);
      assert.equal(await finishRun(untouchable, id, 1, { segments: RESULT, durationSec: null }), "stale", id);
      assert.equal(await failRun(untouchable, id, 1, "internal"), false, id);
      assert.equal(await requeueRun(untouchable, id, 0), null, id);
      assert.equal(await transcriptionStatus(untouchable, OWNER, id), null, id);
      assert.equal(await latestRun(untouchable, OWNER, id), null, id);
    }
    const id = randomUUID();
    await assert.rejects(() => enqueueTranscription(untouchable, "", id, run()), TypeError);
    await assert.rejects(() => latestRun(untouchable, "", id), TypeError);
    await assert.rejects(() => enqueueTranscription(untouchable, OWNER, id, run({ engine: "whisper" as never })), TypeError);
    await assert.rejects(() => enqueueTranscription(untouchable, OWNER, id, run({ language: "fr" as never })), TypeError);
    await assert.rejects(() => enqueueTranscription(untouchable, OWNER, id, run({ terms: Array.from({ length: 101 }, (_, index) => `語${index}`) })), TypeError);
    for (const term of ["", " 前後に空白", "a".repeat(65), "改\n行", "\u0000"]) {
      await assert.rejects(() => enqueueTranscription(untouchable, OWNER, id, run({ terms: [term] })), TypeError, JSON.stringify(term));
    }
    await assert.rejects(() => failRun(untouchable, id, 1, "superseded" as never), TypeError);
    await assert.rejects(() => failRun(untouchable, id, -1, "internal"), TypeError);
    await assert.rejects(() => finishRun(untouchable, id, 0, { segments: RESULT, durationSec: null }), TypeError);
    // 保存の形に合わない結果は DB に触れずに断る（話者 0・空の段落の数の上限は呼び出し側の正規化が先に直す）
    await assert.rejects(
      () => finishRun(untouchable, id, 1, { segments: [{ start: 0, end: 1, text: "合成", speaker: 0 }], durationSec: null }),
      (error: unknown) => error instanceof InvalidRecordingError && error.problem === "speaker",
    );
    await assert.rejects(() => finishRun(untouchable, id, 1, { segments: RESULT, durationSec: -1 }), InvalidRecordingError);
    await assert.rejects(() => sweepStaleRuns(untouchable, new Date(), 0), RangeError);
    await assert.rejects(() => sweepStaleRuns(untouchable, new Date(Number.NaN), 60), TypeError);
    await assert.rejects(() => listQueuedRuns(untouchable, { olderThan: new Date(Number.NaN) }), TypeError);
    await assert.rejects(() => listQueuedRuns(untouchable, { olderThan: "2026-10-31" as never }), TypeError);
    await assert.rejects(() => requeueRun(untouchable, id, -1), TypeError);
    await assert.rejects(() => requeueRun(untouchable, id, 1.5), TypeError);
  });
});

describe("0012 on a database that has 0001 to 0011", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;
  let dir: string;

  before(async () => {
    ({ pool, drop } = await withSchema("transcribe0012"));
    dir = await mkdtemp(join(tmpdir(), "editor-store-0012-"));
  });

  after(async () => {
    await drop();
    await rm(dir, { recursive: true, force: true });
  });

  it("adds the table without touching existing recordings, and existing audio can be transcribed", async () => {
    const migrations = fileURLToPath(defaultMigrationsDir);
    const dirUrl = pathToFileURL(`${dir}/`);
    // 適用済みの一覧は readMigrations() から取る
    const names = (await readMigrations()).map((file) => file.name);
    const earlier = names.filter((name) => name < "0012");
    assert.ok(earlier.includes("0001_editor_store.sql") && earlier.includes("0008_recording_audio.sql"));
    for (const name of earlier) await copyFile(join(migrations, name), join(dir, name));
    const client = await pool.connect();
    try {
      assert.deepEqual((await applyMigrations(client, dirUrl)).applied, earlier);
      // 0008 までの DB にある録音: アップロード済みの音声と VTT。音声の行は**当時の形の SQL** で入れる
      // （store の INSERT は今の列〔音声と案の migration の audio_duration_sec〕を書くので、0011 までの schema には入らない）
      const audioPage = await legacyUploadedRecording(pool);
      const vtt = await createRecordingPage(pool, OWNER, {
        lang: "ja",
        source: "vtt",
        engine: "vtt-import",
        segments: [{ start: 0, end: 1, text: "合成の既存の段落", speaker: 1 }],
      });
      const before = [await recordingRow(pool, audioPage), await recordingRow(pool, vtt.page.id)];

      await copyFile(join(migrations, "0012_transcription_runs.sql"), join(dir, "0012_transcription_runs.sql"));
      const second = await applyMigrations(client, dirUrl);
      assert.deepEqual(second.applied, ["0012_transcription_runs.sql"]);
      assert.deepEqual(second.skipped, earlier);
      assert.deepEqual([await recordingRow(pool, audioPage), await recordingRow(pool, vtt.page.id)], before, "existing recordings are unchanged");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM transcription_runs")).rows[0].n, 0, "the migration records nothing");

      await applyMigrations(client);
      assert.deepEqual(await transcriptionStatus(pool, OWNER, audioPage), { run: null });
      const created = await enqueueTranscription(pool, OWNER, audioPage, run());
      assert.equal(created?.status, "created");
      assert.deepEqual(await enqueueTranscription(pool, OWNER, vtt.page.id, run()), { status: "audio_not_ready" }, "a VTT recording has no audio to transcribe");
    } finally {
      client.release();
    }
  });
});

describe("transcription runs on PostgreSQL", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;

  before(async () => {
    ({ pool, drop } = await withSchema("transcribe"));
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

  it("creates a queued run for an uploaded recording, and returns it while it is active", async () => {
    const pageId = await uploadedRecording(pool, OWNER, { lang: "en" });
    const created = await enqueueTranscription(pool, OWNER, pageId, run({ terms: ["合成語", "Synthetic"] }));
    assert.ok(created?.status === "created");
    assert.equal(created.run.status, "queued");
    assert.equal(created.run.engine, "fake");
    assert.equal(created.run.language, "en", "the recording's language when none is asked for");
    assert.equal(created.run.errorCode, null);
    assert.equal(created.run.startedAt, null);
    assert.equal(created.run.finishedAt, null);
    const row = await runRow(pool, created.run.id);
    assert.ok(row);
    assert.equal(row.owner, OWNER);
    assert.equal(row.page_id, pageId);
    assert.equal(row.generation, 0);
    assert.equal(row.diarize, true);
    assert.equal(row.replace, false);
    assert.deepEqual(row.terms, ["合成語", "Synthetic"]);

    const again = await enqueueTranscription(pool, OWNER, pageId, run({ language: "ja", replace: true }));
    assert.deepEqual(again, { status: "existing", run: created.run, candidate: null }, "an active run is returned as it is, with where it writes");
    assert.equal(await countRuns(pool, pageId), 1);
    assert.deepEqual(await latestRun(pool, OWNER, pageId), created.run);
    const ja = await uploadedRecording(pool);
    const asked = await enqueueTranscription(pool, OWNER, ja, run({ language: "en", diarize: false }));
    assert.ok(asked?.status === "created");
    assert.equal(asked.run.language, "en");
    assert.equal((await runRow(pool, asked.run.id))?.diarize, false);
  });

  it("refuses audio that is not uploaded or has expired, and answers null for others, the trash and pages without a recording", async () => {
    const uploading = await startAudioRecording(pool, OWNER, startInput());
    assert.ok(uploading.status === "created");
    assert.deepEqual(await enqueueTranscription(pool, OWNER, uploading.page.id, run()), { status: "audio_not_ready" });

    const expired = await uploadedRecording(pool);
    await pool.query("UPDATE page_recordings SET audio_expires_at = clock_timestamp() - interval '1 second' WHERE page_id = $1", [expired]);
    assert.deepEqual(await enqueueTranscription(pool, OWNER, expired, run()), { status: "audio_expired" });

    const theirs = await uploadedRecording(pool, OTHER);
    const trashed = await uploadedRecording(pool);
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [trashed]);
    const plain = (await pool.query<{ id: string }>("INSERT INTO pages (owner, kind) VALUES ($1, 'note') RETURNING id", [OWNER])).rows[0]!.id;
    for (const id of [theirs, trashed, plain, randomUUID()]) {
      assert.equal(await enqueueTranscription(pool, OWNER, id, run()), null, id);
      assert.equal(await transcriptionStatus(pool, OWNER, id), null, id);
    }
    for (const id of [uploading.page.id, expired, theirs, trashed]) assert.equal(await countRuns(pool, id), 0, "nothing is written");
    assert.equal((await enqueueTranscription(pool, OTHER, theirs, run()))?.status, "created", "the owner can start it");
  });

  it("keeps a transcript that is already there unless replace is asked for", async () => {
    const pageId = await uploadedRecording(pool);
    const first = await claimed(pool, pageId);
    assert.equal(await finishRun(pool, first.id, first.generation, { segments: RESULT, durationSec: 5 }), "succeeded");
    // 直した文章
    const edited = await updateRecording(pool, OWNER, pageId, 2, (data) => ({ ...data, segments: [{ ...data.segments[0]!, text: "直した段落" }, data.segments[1]!] }));
    assert.equal(edited?.status, "ok");
    const before = await recordingRow(pool, pageId);

    assert.deepEqual(await enqueueTranscription(pool, OWNER, pageId, run()), { status: "has_transcript" });
    assert.deepEqual(await recordingRow(pool, pageId), before, "the edited transcript is untouched");
    assert.equal(await countRuns(pool, pageId), 1);
    const replace = await enqueueTranscription(pool, OWNER, pageId, run({ replace: true }));
    assert.ok(replace?.status === "created");
    assert.equal((await runRow(pool, replace.run.id))?.replace, true);
  });

  it("lets only one of concurrent starts on the same page create a run", async () => {
    const pageId = await uploadedRecording(pool);
    const results = await Promise.all(Array.from({ length: 5 }, () => enqueueTranscription(pool, OWNER, pageId, run())));
    assert.deepEqual(results.map((result) => result?.status).sort(), ["created", "existing", "existing", "existing", "existing"]);
    const ids = new Set(results.map((result) => (result && "run" in result ? result.run.id : null)));
    assert.equal(ids.size, 1, "every request gets the same run");
    assert.equal(await countRuns(pool, pageId), 1);
  });

  it("fails the run it just claimed when the audio lookup fails right after (it is not left running, so a restart is not blocked)", async () => {
    const pageId = await uploadedRecording(pool);
    const created = await enqueueTranscription(pool, OWNER, pageId, run());
    assert.ok(created?.status === "created");
    // claim の UPDATE は通り、そのあとの音声の問い合わせだけが失敗する
    const flaky = {
      query: ((sql: string, values?: unknown[]) =>
        /JOIN assets AS a ON a\.owner = r\.owner/.test(sql) ? Promise.reject(new Error("synthetic failure")) : pool.query(sql, values)) as typeof pool.query,
    };
    await assert.rejects(() => claimRun(flaky, created.run.id), /synthetic failure/);
    const failed = await latestRun(pool, OWNER, pageId);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.errorCode, "internal");
    // 終わっているので、もう一度始められる
    const again = await enqueueTranscription(pool, OWNER, pageId, run());
    assert.equal(again?.status, "created");
  });

  it("claims a queued run only once, moves the generation, and returns the audio of the page", async () => {
    const pageId = await uploadedRecording(pool);
    const created = await enqueueTranscription(pool, OWNER, pageId, run({ terms: ["合成語"], diarize: false }));
    assert.ok(created?.status === "created");
    const claims = await Promise.all([claimRun(pool, created.run.id), claimRun(pool, created.run.id), claimRun(pool, created.run.id)]);
    const won = claims.filter((claim) => claim !== null);
    assert.equal(won.length, 1, "exactly one claim wins");
    const claim = won[0]!;
    assert.equal(claim.generation, 1);
    assert.equal(claim.run.status, "running");
    assert.ok(claim.run.startedAt);
    assert.equal(claim.run.owner, OWNER);
    assert.equal(claim.run.pageId, pageId);
    assert.equal(claim.run.diarize, false);
    assert.equal(claim.run.replace, false);
    assert.deepEqual(claim.run.terms, ["合成語"]);
    assert.equal(claim.audio?.status, "uploaded");
    assert.equal(claim.audio?.objectPath, `audio/${claim.audio?.assetId}`);
    assert.equal(claim.audio?.contentType, "audio/mp4");
    assert.equal(claim.audio?.bytes, 64);
    assert.equal(await claimRun(pool, created.run.id), null, "a running run is not claimed again");
    assert.equal(await claimRun(pool, randomUUID()), null);
    assert.equal((await latestRun(pool, OWNER, pageId))?.status, "running");

    // ゴミ箱に入れたページの run を claim すると、音声は無いものとして返る（実行する側が audio_missing にする）
    const trashed = await uploadedRecording(pool);
    const queued = await enqueueTranscription(pool, OWNER, trashed, run());
    assert.ok(queued?.status === "created");
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [trashed]);
    const late = await claimRun(pool, queued.run.id);
    assert.ok(late);
    assert.equal(late.audio, null);
  });

  it("writes the transcript, the page time and the run together, and only for the current generation", async () => {
    const store = new EditorStore(pool);
    const pageId = await uploadedRecording(pool);
    const recordingBefore = await getRecording(pool, OWNER, pageId);
    const pageBefore = await store.getPage(OWNER, pageId);
    const { id, generation } = await claimed(pool, pageId);

    assert.equal(await finishRun(pool, id, generation + 1, { segments: RESULT, durationSec: 5 }), "stale", "a newer generation is not ours");
    assert.deepEqual(await getRecording(pool, OWNER, pageId), recordingBefore, "a stale finish writes nothing");

    // 途中で失敗したら、段落も run も書かない（1 transaction）
    await assert.rejects(() => finishRun(failingOn(pool, /SET status = 'succeeded'/), id, generation, { segments: RESULT, durationSec: 5 }), /synthetic failure/);
    assert.deepEqual(await getRecording(pool, OWNER, pageId), recordingBefore);
    assert.equal((await runRow(pool, id))?.status, "running");
    await assert.rejects(() => finishRun(failingOn(pool, /UPDATE pages/), id, generation, { segments: RESULT, durationSec: 5 }), /synthetic failure/);
    assert.deepEqual(await getRecording(pool, OWNER, pageId), recordingBefore);

    assert.equal(await finishRun(pool, id, generation, { segments: RESULT, durationSec: 5.25 }), "succeeded");
    const recording = await getRecording(pool, OWNER, pageId);
    assert.ok(recording && recordingBefore);
    assert.deepEqual(recording.segments, RESULT);
    assert.deepEqual(recording.speakerNames, {});
    assert.equal(recording.engine, "fake");
    assert.equal(recording.durationSec, 5.25);
    assert.equal(recording.revision, recordingBefore.revision + 1);
    assert.deepEqual(recording.audio, recordingBefore.audio, "the audio stays");
    const pageAfter = await store.getPage(OWNER, pageId);
    assert.ok(pageAfter && pageBefore && Date.parse(pageAfter.updatedAt) > Date.parse(pageBefore.updatedAt), "pages.updated_at moved on");
    assert.equal(pageAfter.revision, pageBefore.revision, "the page body revision is not touched");
    const done = await latestRun(pool, OWNER, pageId);
    assert.equal(done?.status, "succeeded");
    assert.ok(done?.finishedAt && done.startedAt && Date.parse(done.finishedAt) >= Date.parse(done.startedAt));
    // 確定したあとは何をしても変わらない
    assert.equal(await finishRun(pool, id, generation, { segments: [], durationSec: null }), "stale");
    assert.equal(await failRun(pool, id, generation, "internal"), false);
    assert.deepEqual((await getRecording(pool, OWNER, pageId))?.segments, RESULT);
  });

  it("keeps the duration when the engine does not tell it, and replaces the transcript and the speaker names for a replace run", async () => {
    const pageId = await uploadedRecording(pool);
    const first = await claimed(pool, pageId);
    assert.equal(await finishRun(pool, first.id, first.generation, { segments: RESULT, durationSec: null }), "succeeded");
    assert.equal((await getRecording(pool, OWNER, pageId))?.durationSec, 30, "the declared duration stays");
    const named = await updateRecording(pool, OWNER, pageId, 2, (data) => ({ ...data, speakerNames: { "1": "合成の話し手" } }));
    assert.equal(named?.status, "ok");

    const second = await claimed(pool, pageId, { replace: true });
    const next: RecordingSegment[] = [{ start: 1, end: 2, text: "合成の置き換えた段落", speaker: null }];
    assert.equal(await finishRun(pool, second.id, second.generation, { segments: next, durationSec: 2 }), "succeeded");
    const replaced = await getRecording(pool, OWNER, pageId);
    assert.deepEqual(replaced?.segments, next);
    assert.deepEqual(replaced?.speakerNames, {});
    assert.equal(replaced?.revision, 4);
  });

  it("does not overwrite a transcript that appeared while a run without replace was running", async () => {
    const pageId = await uploadedRecording(pool);
    const { id, generation } = await claimed(pool, pageId);
    // 誰かが先に段落を書いた（並んだ別の経路の代わりに直接入れる）
    await pool.query("UPDATE page_recordings SET segments = $2::jsonb WHERE page_id = $1", [pageId, JSON.stringify([{ start: 0, end: 1, text: "先に書かれた段落", speaker: 1 }])]);
    const before = await recordingRow(pool, pageId);
    assert.equal(await finishRun(pool, id, generation, { segments: RESULT, durationSec: 5 }), "superseded");
    assert.deepEqual(await recordingRow(pool, pageId), before, "nothing is overwritten");
    const failed = await latestRun(pool, OWNER, pageId);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.errorCode, "internal");
  });

  it("fails a run only for the current generation, or a queued run before it is claimed, and keeps the audio for another try", async () => {
    const pageId = await uploadedRecording(pool);
    const { id, generation } = await claimed(pool, pageId);
    assert.equal(await failRun(pool, id, generation + 1, "engine_unavailable"), false);
    assert.equal(await failRun(pool, id, 0, "engine_unavailable"), false, "generation 0 only matches a run that was never claimed");
    assert.equal(await failRun(pool, id, generation, "engine_unavailable"), true);
    assert.equal(await failRun(pool, id, generation, "internal"), false, "a failed run stays as it failed");
    const failed = await latestRun(pool, OWNER, pageId);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.errorCode, "engine_unavailable");
    assert.ok(failed?.finishedAt);
    assert.equal(await finishRun(pool, id, generation, { segments: RESULT, durationSec: 5 }), "stale", "a late result after the failure is ignored");
    assert.deepEqual((await getRecording(pool, OWNER, pageId))?.segments, []);
    assert.equal((await getRecording(pool, OWNER, pageId))?.audio?.status, "uploaded", "the audio is kept");

    // もう一度: 新しい run を作れる
    const retry = await enqueueTranscription(pool, OWNER, pageId, run());
    assert.ok(retry?.status === "created");
    assert.notEqual(retry.run.id, id);
    assert.equal(await failRun(pool, retry.run.id, 0, "internal"), true, "a queued run that could not be dispatched fails with generation 0");
    const notClaimed = await runRow(pool, retry.run.id);
    assert.equal(notClaimed?.status, "failed");
    assert.equal(notClaimed?.started_at, null);
    assert.equal(await claimRun(pool, retry.run.id), null);
    assert.equal((await latestRun(pool, OWNER, pageId))?.id, retry.run.id, "the latest run is the newest one");
    assert.equal(await countRuns(pool, pageId), 2);
  });

  it("sweeps runs that stayed running or queued for too long, and ignores their late results", async () => {
    const stuck = await uploadedRecording(pool);
    const running = await claimed(pool, stuck);
    const waiting = await uploadedRecording(pool);
    const queued = await enqueueTranscription(pool, OWNER, waiting, run());
    assert.ok(queued?.status === "created");
    const fresh = await uploadedRecording(pool);
    const freshRun = await claimed(pool, fresh);

    await pool.query("UPDATE transcription_runs SET created_at = created_at - interval '2 hours', started_at = started_at - interval '1 hour' WHERE id = $1", [running.id]);
    await pool.query("UPDATE transcription_runs SET created_at = created_at - interval '2 hours' WHERE id = $1", [queued.run.id]);
    const swept = await sweepStaleRuns(pool, new Date(), 30 * 60);
    assert.deepEqual([...swept].sort(), [running.id, queued.run.id].sort());
    const timedOut = await latestRun(pool, OWNER, stuck);
    assert.equal(timedOut?.status, "failed");
    assert.equal(timedOut?.errorCode, "engine_timeout");
    const lost = await latestRun(pool, OWNER, waiting);
    assert.equal(lost?.status, "failed");
    assert.equal(lost?.errorCode, "internal");
    assert.equal((await latestRun(pool, OWNER, fresh))?.status, "running", "a fresh run is left alone");

    assert.equal(await finishRun(pool, running.id, running.generation, { segments: RESULT, durationSec: 5 }), "stale");
    assert.deepEqual((await getRecording(pool, OWNER, stuck))?.segments, []);
    assert.deepEqual(await sweepStaleRuns(pool, new Date(), 30 * 60), [], "nothing is swept twice");
    assert.equal(await finishRun(pool, freshRun.id, freshRun.generation, { segments: RESULT, durationSec: 5 }), "succeeded");
  });

  it("lists the runs that are still queued, oldest first, without the ones a start may still be enqueueing", async () => {
    // 掃除は表の全体を読む（1 人のページに絞らない）ので、前のテストが残した queued の run もいっしょに返る。
    // ここで確かめるのは、このテストが作った run についての並びと有無。2 時間・1 時間前にずらすので、
    // この 2 つがいちばん古い queued になる（他のテストの run はこの実行の中で作られた＝数分以内）。
    const olderPage = await uploadedRecording(pool);
    const older = await enqueueTranscription(pool, OWNER, olderPage, run());
    assert.ok(older?.status === "created");
    const newerPage = await uploadedRecording(pool);
    const newer = await enqueueTranscription(pool, OWNER, newerPage, run());
    assert.ok(newer?.status === "created");
    await pool.query("UPDATE transcription_runs SET created_at = created_at - interval '2 hours' WHERE id = $1", [older.run.id]);
    await pool.query("UPDATE transcription_runs SET created_at = created_at - interval '1 hour' WHERE id = $1", [newer.run.id]);
    const runningPage = await uploadedRecording(pool);
    const running = await claimed(pool, runningPage);
    const mine = new Set([older.run.id, newer.run.id, running.id]);
    const minesOf = (rows: { id: string }[]) => rows.filter((item) => mine.has(item.id)).map((item) => item.id);

    const queued = await listQueuedRuns(pool, { olderThan: new Date(), limit: 1000 });
    assert.deepEqual(minesOf(queued), [older.run.id, newer.run.id], "oldest first, and a claimed run is not in the list");
    // まだ claim も積み直しもされていないので世代 0（開始が積んだ task と同じ名前）
    assert.deepEqual(
      queued.filter((item) => mine.has(item.id)).map((item) => item.generation),
      [0, 0],
    );

    // 積んでいる最中（olderThan より後に作られた）run は触らない
    const grace = new Date(Date.now() - 90 * 60 * 1000);
    assert.deepEqual((await listQueuedRuns(pool, { olderThan: grace, limit: 1000 })).map((item) => item.id), [older.run.id], "newer than the grace period is left alone");
    assert.deepEqual((await listQueuedRuns(pool, { olderThan: new Date(), limit: 1 })).map((item) => item.id), [older.run.id], "the limit takes the oldest");

    // 失敗・成功した run は積み直さない
    assert.equal(await failRun(pool, older.run.id, 0, "internal"), true);
    assert.deepEqual(minesOf(await listQueuedRuns(pool, { olderThan: new Date(), limit: 1000 })), [newer.run.id]);
    // 後ろのテストに、時刻をずらした queued の run を残さない
    assert.equal(await failRun(pool, newer.run.id, 0, "internal"), true);
  });

  it("moves the generation of a queued run on so the sweep can enqueue it under a name the deleted task does not hold", async () => {
    const pageId = await uploadedRecording(pool);
    const created = await enqueueTranscription(pool, OWNER, pageId, run());
    assert.ok(created?.status === "created");
    const runId = created.run.id;

    // 1 度目: 世代 0 → 1（開始が積んだ task の名前 <run>-0 は、消えても最大 24 時間ふさがる）
    assert.equal(await requeueRun(pool, runId, 1), null, "the generation has to match");
    assert.equal(await requeueRun(pool, runId, 0), 1);
    assert.equal(await requeueRun(pool, runId, 1), 2, "every sweep gives a name that was never used");
    assert.deepEqual((await listQueuedRuns(pool, { olderThan: new Date(Date.now() + 1000), limit: 1000 })).find((item) => item.id === runId)?.generation, 2);
    // 状態は queued のままなので、積んだ task はそのまま claim できる（世代は claim でさらに進む）
    assert.equal((await latestRun(pool, OWNER, pageId))?.status, "queued");
    const claim = await claimRun(pool, runId);
    assert.equal(claim?.generation, 3);

    // claim 済み・終わった run は積み直さない
    assert.equal(await requeueRun(pool, runId, 3), null);
    assert.equal(await failRun(pool, runId, 3, "internal"), true);
    assert.equal(await requeueRun(pool, runId, 3), null);
    assert.equal(await requeueRun(pool, randomUUID(), 0), null, "a run that is not there");
  });

  it("keeps the invariants when the code is bypassed", async () => {
    const pageId = await uploadedRecording(pool);
    const now = new Date();
    // 作成の時刻は少し前にしておく（時刻の順の検査が、ここで見たい検査より先に断らないように）
    const earlier = new Date(now.getTime() - 60_000);
    const insert = (values: Record<string, unknown>) => {
      const row = { owner: OWNER, page_id: pageId, engine: "fake", status: "queued", language: "ja", created_at: earlier, ...values };
      const columns = Object.keys(row);
      return pool.query(
        `INSERT INTO transcription_runs (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
        Object.values(row),
      );
    };
    for (const values of [
      { engine: "whisper" },
      { status: "canceled" },
      { language: "fr" },
      { generation: -1 },
      { status: "failed", finished_at: now },
      { status: "failed", finished_at: now, error_code: "superseded" },
      { status: "succeeded", started_at: now, finished_at: now, error_code: "internal" },
      { status: "queued", error_code: "internal" },
      { status: "queued", started_at: now },
      { status: "running" },
      { status: "running", started_at: now, finished_at: now },
      { status: "succeeded", finished_at: now },
      { status: "failed", error_code: "internal" },
      { status: "running", started_at: new Date(now.getTime() - 3600_000), created_at: now },
      { terms: JSON.stringify(Array.from({ length: 101 }, () => "語")) },
      { terms: JSON.stringify({ term: "語" }) },
    ]) {
      await assert.rejects(() => insert(values), { code: "23514" }, JSON.stringify(values));
    }
    // 別の人のページ・存在しないページには付かない
    await assert.rejects(() => insert({ owner: OTHER }), { code: "23503" });
    await assert.rejects(() => insert({ page_id: randomUUID() }), { code: "23503" });
    // 有効な run は 1 ページに 1 つ（終わった run はいくつでも）
    await insert({});
    await assert.rejects(() => insert({ status: "running", started_at: now }), { code: "23505" });
    await insert({ status: "failed", error_code: "internal", finished_at: now });
    await insert({ status: "succeeded", started_at: now, finished_at: now });
    assert.equal(await countRuns(pool, pageId), 3);
    // 開始の関数も、lock を通らずに入った有効な run を返す
    assert.equal((await enqueueTranscription(pool, OWNER, pageId, run()))?.status, "existing");
  });

  it("removes the runs when the page is deleted, also by the trash purge", async () => {
    const pageId = await uploadedRecording(pool);
    await claimed(pool, pageId);
    await pool.query("DELETE FROM pages WHERE id = $1", [pageId]);
    assert.equal(await countRuns(pool, pageId), 0);

    const owner = `synthetic-transcribe-owner-${randomUUID().slice(0, 8)}`;
    const old = await uploadedRecording(pool, owner);
    const created = await enqueueTranscription(pool, owner, old, run());
    assert.equal(created?.status, "created");
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() - interval '31 days', created_at = clock_timestamp() - interval '40 days' WHERE id = $1", [old]);
    const purged = await new EditorStore(pool).purgeTrash();
    assert.ok(purged.pages >= 1);
    assert.equal(await countRuns(pool, old), 0);
  });
});
