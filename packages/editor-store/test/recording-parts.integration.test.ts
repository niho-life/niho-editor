import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { applyMigrations } from "../src/migrate.ts";
import {
  AUDIO_PARTS_MAX,
  completeAudioPart,
  completeAudioUpload,
  discardAudioPart,
  listAudioParts,
  startAudioPart,
  startAudioRecording,
  type StartAudioPartInput,
  type StartAudioRecordingInput,
} from "../src/recording-audio.ts";
import { InvalidRecordingError, createRecordingPage, getRecording } from "../src/recordings.ts";
import { claimRun, enqueueTranscription, finishRun, type EnqueueTranscriptionInput } from "../src/transcription-runs.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID・ファイル名・ハッシュだけを使う（実在の人・実際の音声を入れない）
const OWNER = "synthetic-parts-owner-a";
const OTHER = "synthetic-parts-owner-b";
const DECLARED_SHA = "a".repeat(64);
const HASH_A = "1".repeat(64);
const HASH_B = "2".repeat(64);

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
    sourceName: "音声 1.m4a",
    contentType: "audio/mp4",
    bytes: 4096,
    sha256: DECLARED_SHA,
    durationSec: 600,
    uploadKey: null,
    requestHash: HASH_A,
    retentionDays: 30,
    ...extra,
  };
}

function partInput(extra: Partial<StartAudioPartInput> = {}): StartAudioPartInput {
  return {
    assetId: randomUUID(),
    sourceName: "音声 2.m4a",
    contentType: "audio/mp4",
    bytes: 2048,
    sha256: DECLARED_SHA,
    durationSec: 300,
    uploadKey: null,
    requestHash: HASH_A,
    retentionDays: 30,
    ...extra,
  };
}

const run = (extra: Partial<EnqueueTranscriptionInput> = {}): EnqueueTranscriptionInput => ({
  engine: "fake",
  diarize: true,
  terms: [],
  ...extra,
});

/** アップロード済みの音声 1 本の録音ページ（part 0）。 */
async function audioRecording(pool: PgPool, owner: string = OWNER, extra: Partial<StartAudioRecordingInput> = {}): Promise<string> {
  const started = await startAudioRecording(pool, owner, startInput(extra));
  assert.ok(started.status === "created");
  const done = await completeAudioUpload(pool, owner, started.page.id, { sizeBytes: started.recording.audio!.bytes });
  assert.equal(done?.status, "ok");
  return started.page.id;
}

/** 音声を 1 本足して、アップロードも済ませる。 */
async function addPart(pool: PgPool, pageId: string, extra: Partial<StartAudioPartInput> = {}, owner: string = OWNER): Promise<number> {
  const input = partInput(extra);
  const started = await startAudioPart(pool, owner, pageId, input);
  assert.ok(started && started.status === "created", JSON.stringify(started));
  const done = await completeAudioPart(pool, owner, pageId, started.part.partIndex, { sizeBytes: input.bytes });
  assert.equal(done?.status, "ok");
  return started.part.partIndex;
}

describe("audio parts on PostgreSQL（1 ページに音声を複数）", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;

  before(async () => {
    ({ pool, drop } = await withSchema("parts"));
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

  it("足した音声は part 1 から並び、ずらす量はそれまでの長さの合計になる", async () => {
    const page = await audioRecording(pool);
    // part 0 は page_recordings の音声（長さ 600 秒）
    const first = await listAudioParts(pool, OWNER, page);
    assert.equal(first.length, 1);
    assert.deepEqual(
      first.map((part) => [part.partIndex, part.status, part.durationSec, part.offsetSec, part.sourceName]),
      [[0, "uploaded", 600, 0, "音声 1.m4a"]],
    );
    assert.match(first[0]!.objectPath, /^audio\//);

    await addPart(pool, page, { durationSec: 300, sourceName: "音声 2.m4a" });
    await addPart(pool, page, { durationSec: 120, sourceName: "音声 3.m4a" });
    const parts = await listAudioParts(pool, OWNER, page);
    assert.deepEqual(
      parts.map((part) => [part.partIndex, part.durationSec, part.offsetSec, part.sourceName]),
      [
        [0, 600, 0, "音声 1.m4a"],
        // 1 本目の長さだけ後ろ
        [1, 300, 600, "音声 2.m4a"],
        // 1 本目 ＋ 2 本目
        [2, 120, 900, "音声 3.m4a"],
      ],
    );
    // 期限とアップロードの状態も持つ
    assert.ok(parts.every((part) => part.status === "uploaded" && part.expiresAt !== null && part.bytes > 0));
  });

  it("アップロードの完了は、大きさが申告どおりのときだけ（何度呼んでも同じ）", async () => {
    const page = await audioRecording(pool);
    const input = partInput({ bytes: 2048 });
    const started = await startAudioPart(pool, OWNER, page, input);
    assert.ok(started && started.status === "created");
    const index = started.part.partIndex;
    assert.equal(started.part.status, "uploading");
    assert.deepEqual(await completeAudioPart(pool, OWNER, page, index, { sizeBytes: 2047 }), { status: "size_mismatch" });
    assert.equal((await listAudioParts(pool, OWNER, page)).find((part) => part.partIndex === index)?.status, "uploading");
    const done = await completeAudioPart(pool, OWNER, page, index, { sizeBytes: 2048 });
    assert.equal(done?.status, "ok");
    const again = await completeAudioPart(pool, OWNER, page, index, { sizeBytes: 999 });
    assert.equal(again?.status, "ok", "済んだものは大きさを見ない（冪等）");
    assert.equal((await listAudioParts(pool, OWNER, page)).find((part) => part.partIndex === index)?.status, "uploaded");
    // 無い番号・別の人・存在しないページ
    assert.equal(await completeAudioPart(pool, OWNER, page, 9, { sizeBytes: 1 }), null);
    assert.equal(await completeAudioPart(pool, OTHER, page, index, { sizeBytes: 1 }), null);
    assert.equal(await completeAudioPart(pool, OWNER, randomUUID(), 1, { sizeBytes: 1 }), null);
    assert.equal(await completeAudioPart(pool, OWNER, "not-a-uuid", 1, { sizeBytes: 1 }), null);
  });

  it("同じ冪等キーの再送は同じ音声を返し、内容が違えば conflict", async () => {
    const page = await audioRecording(pool);
    const key = randomUUID();
    const input = partInput({ uploadKey: key, requestHash: HASH_A });
    const first = await startAudioPart(pool, OWNER, page, input);
    assert.ok(first && first.status === "created");
    const again = await startAudioPart(pool, OWNER, page, { ...input, assetId: randomUUID() });
    assert.ok(again && again.status === "existing");
    assert.equal(again.part.partIndex, first.part.partIndex, "新しい音声は増えない");
    assert.equal((await listAudioParts(pool, OWNER, page)).length, 2);
    // 同じキーで内容が違う
    assert.deepEqual(await startAudioPart(pool, OWNER, page, { ...input, assetId: randomUUID(), requestHash: HASH_B }), { status: "conflict" });
    // 同じキーで別のページ
    const other = await audioRecording(pool);
    assert.deepEqual(await startAudioPart(pool, OWNER, other, input), { status: "conflict" });
  });

  it("2 本目のずらす量は、1 本目の音声そのものの長さを下限にする（文字起こしが短くても、無音で終わる音声でも 1 本目の中にずれ込まない）", async () => {
    // 1 本目は 600 秒の音声。文字起こしは 10 秒までしか無い（末尾が無音）
    const page = await audioRecording(pool, OWNER, { durationSec: 600 });
    await pool.query("UPDATE page_recordings SET duration_sec = 10 WHERE page_id = $1", [page]);
    const index = await addPart(pool, page, { durationSec: 60 });
    assert.equal(index, 1);
    const parts = await listAudioParts(pool, OWNER, page);
    assert.deepEqual(
      parts.map((part) => [part.partIndex, part.offsetSec]),
      [
        [0, 0],
        [1, 600],
      ],
    );
  });

  it("文章（VTT）の録音にも音声を足せる（ずらす量は文字起こしの長さ）", async () => {
    const created = await createRecordingPage(pool, OWNER, {
      lang: "ja",
      source: "vtt",
      engine: "vtt-import",
      durationSec: 42,
      segments: [{ start: 0, end: 42, text: "合成の字幕", speaker: 1 }],
    });
    const index = await addPart(pool, created.page.id, { durationSec: 60 });
    assert.equal(index, 1);
    const parts = await listAudioParts(pool, OWNER, created.page.id);
    assert.deepEqual(
      parts.map((part) => [part.partIndex, part.offsetSec]),
      [[1, 42]],
      "part 0 は無く、字幕の長さだけずらす",
    );
  });

  it("別の人・存在しないページ・ゴミ箱・録音の無いページには足せない", async () => {
    const page = await audioRecording(pool);
    assert.equal(await startAudioPart(pool, OTHER, page, partInput()), null);
    assert.equal(await startAudioPart(pool, OWNER, randomUUID(), partInput()), null);
    assert.equal(await startAudioPart(pool, OWNER, "not-a-uuid", partInput()), null);
    const plain = (await pool.query<{ id: string }>("INSERT INTO pages (owner, kind) VALUES ($1, 'note') RETURNING id", [OWNER])).rows[0]!.id;
    assert.equal(await startAudioPart(pool, OWNER, plain, partInput()), null);
    const trashed = await audioRecording(pool);
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [trashed]);
    assert.equal(await startAudioPart(pool, OWNER, trashed, partInput()), null);
    assert.deepEqual(await listAudioParts(pool, OWNER, trashed), [], "ゴミ箱のページの音声は読めない");
    // 形が規則に合わない
    await assert.rejects(() => startAudioPart(pool, OWNER, page, partInput({ contentType: "audio/mp4; codecs=opus" })), InvalidRecordingError);
    await assert.rejects(() => startAudioPart(pool, OWNER, page, partInput({ sha256: "zz" })), InvalidRecordingError);
    await assert.rejects(() => startAudioPart(pool, OWNER, page, partInput({ sourceName: "だめ/な/名前.m4a" })), InvalidRecordingError);
  });

  it("本数の上限を超えたら too_many（何も書かない）", async () => {
    const page = await audioRecording(pool);
    for (let index = 1; index < AUDIO_PARTS_MAX; index += 1) await addPart(pool, page, { durationSec: 1 });
    assert.equal((await listAudioParts(pool, OWNER, page)).length, AUDIO_PARTS_MAX);
    assert.deepEqual(await startAudioPart(pool, OWNER, page, partInput()), { status: "too_many" });
    assert.equal((await listAudioParts(pool, OWNER, page)).length, AUDIO_PARTS_MAX);
  });

  it("取り込みを途中でやめた音声は取り除け、そのあと文字起こしを始められる（やめた行が録音を止め続けない）", async () => {
    const page = await audioRecording(pool);
    const started = await startAudioPart(pool, OWNER, page, partInput({ uploadKey: randomUUID() }));
    assert.ok(started && started.status === "created");
    const index = started.part.partIndex;
    assert.deepEqual(await enqueueTranscription(pool, OWNER, page, run()), { status: "audio_not_ready" }, "やめた取り込みの行が残っているあいだは始められない");

    assert.equal(await discardAudioPart(pool, OWNER, page, index), "discarded");
    assert.deepEqual(
      (await listAudioParts(pool, OWNER, page)).map((part) => part.partIndex),
      [0],
      "音声の行も assets の行も無くなり、1 本目だけが残る",
    );
    const assets = await pool.query("SELECT 1 FROM assets WHERE owner = $1 AND id = $2", [OWNER, started.part.assetId]);
    assert.equal(assets.rowCount, 0);
    assert.equal((await enqueueTranscription(pool, OWNER, page, run()))?.status, "created");
    // もう無い番号は null（同じ取り消しを 2 回押しても壊れない）
    assert.equal(await discardAudioPart(pool, OWNER, page, index), null);
  });

  it("取り除けるのは途中の音声だけ: アップロードの済んだ音声・1 本目・別の人・ゴミ箱のページは断る", async () => {
    const page = await audioRecording(pool);
    const done = await addPart(pool, page, { durationSec: 60 });
    assert.equal(await discardAudioPart(pool, OWNER, page, done), "not_unfinished", "済んだ音声は消さない");
    assert.equal((await listAudioParts(pool, OWNER, page)).length, 2);
    assert.equal(await discardAudioPart(pool, OWNER, page, 0), null, "1 本目（part 0）は対象外");

    const started = await startAudioPart(pool, OWNER, page, partInput());
    assert.ok(started && started.status === "created");
    assert.equal(await discardAudioPart(pool, OTHER, page, started.part.partIndex), null, "別の人のページは無いのと同じ");
    assert.equal(await discardAudioPart(pool, OWNER, "not-a-uuid", 1), null);
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE owner = $1 AND id = $2", [OWNER, page]);
    assert.equal(await discardAudioPart(pool, OWNER, page, started.part.partIndex), null, "ゴミ箱の中のページは無いのと同じ");
  });

  it("文字起こしは、どれか 1 本でも途中・期限切れなら始めない", async () => {
    const page = await audioRecording(pool);
    const started = await startAudioPart(pool, OWNER, page, partInput());
    assert.ok(started && started.status === "created");
    assert.deepEqual(await enqueueTranscription(pool, OWNER, page, run()), { status: "audio_not_ready" }, "足した音声がまだ途中");
    await completeAudioPart(pool, OWNER, page, started.part.partIndex, { sizeBytes: partInput().bytes });
    const created = await enqueueTranscription(pool, OWNER, page, run());
    assert.equal(created?.status, "created");
    // claim は音声の列を渡す（実行する側が前の音声の長さだけずらす）
    assert.ok(created?.status === "created");
    const claimed = await claimRun(pool, created.run.id);
    assert.deepEqual(
      claimed?.parts.map((part) => [part.partIndex, part.offsetSec]),
      [
        [0, 0],
        [1, 600],
      ],
    );
    assert.ok(claimed?.run.tab, "the run writes to a transcript tab (#310)");

    // 期限切れ
    await pool.query("UPDATE page_recording_audios SET expires_at = clock_timestamp() - make_interval(hours => 1) WHERE page_id = $1", [page]);
    await pool.query("UPDATE transcription_runs SET status = 'failed', error_code = 'internal', finished_at = clock_timestamp() WHERE page_id = $1", [page]);
    assert.deepEqual(await enqueueTranscription(pool, OWNER, page, run()), { status: "audio_expired" });
  });
});
