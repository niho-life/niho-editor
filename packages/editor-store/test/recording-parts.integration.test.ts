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
import {
  RECORDING_CANDIDATES_MAX,
  addRecordingCandidate,
  adoptRecordingCandidate,
  deleteRecordingCandidate,
  getRecordingCandidate,
  listRecordingCandidates,
} from "../src/recording-candidates.ts";
import { InvalidRecordingError, createRecordingPage, getRecording, updateRecording } from "../src/recordings.ts";
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
  replace: false,
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
    assert.equal(claimed?.run.candidateId, null);

    // 期限切れ
    await pool.query("UPDATE page_recording_audios SET expires_at = clock_timestamp() - make_interval(hours => 1) WHERE page_id = $1", [page]);
    await pool.query("UPDATE transcription_runs SET status = 'failed', error_code = 'internal', finished_at = clock_timestamp() WHERE page_id = $1", [page]);
    assert.deepEqual(await enqueueTranscription(pool, OWNER, page, run()), { status: "audio_expired" });
  });
});

describe("transcript candidates on PostgreSQL（別のエンジンの案）", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;

  before(async () => {
    ({ pool, drop } = await withSchema("candidates"));
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

  /** 文字起こしのある音声の録音ページ。 */
  async function transcribed(owner: string = OWNER): Promise<string> {
    const page = await audioRecording(pool, owner);
    const written = await updateRecording(pool, owner, page, 1, (data) => ({
      segments: [
        { start: 0, end: 5, text: "はじめの案の段落", speaker: 1 },
        { start: 5, end: 10, text: "もう 1 つの段落", speaker: 2 },
      ],
      speakerNames: { ...data.speakerNames, "1": "司会役" },
      durationSec: 600,
    }));
    assert.equal(written?.status, "ok");
    return page;
  }

  const add = (page: string, name: string, engine = "fake", owner: string = OWNER) =>
    addRecordingCandidate(pool, owner, page, { name, engine, primaryName: "Deepgram" });

  it("2 つ目の案を足すと、いまの文字起こしが 1 つ目の案（採用中）として台帳に載る", async () => {
    const page = await transcribed();
    const result = await add(page, "Fake");
    assert.ok(result && result.status === "created");
    assert.equal(result.candidates.length, 2);
    const [primary, second] = result.candidates;
    assert.deepEqual(
      [primary?.name, primary?.adopted, primary?.state, primary?.segmentCount, primary?.durationSec],
      ["Deepgram", true, "ready", 2, 600],
      "1 つ目の案はいまの本文の写し（採用中）",
    );
    assert.deepEqual([primary?.preview, primary?.engine], [["はじめの案の段落", "もう 1 つの段落"], null]);
    assert.deepEqual([second?.name, second?.adopted, second?.state, second?.segmentCount, second?.engine], ["Fake", false, "failed", 0, "fake"]);
    // 本文つきで読むと、話者名も案ごとに持っている
    const full = await getRecordingCandidate(pool, OWNER, page, primary!.id);
    assert.deepEqual(full?.speakerNames, { "1": "司会役" });
    assert.equal(full?.segments.length, 2);
    // 正本は変わっていない（案を足しただけ）
    assert.equal((await getRecording(pool, OWNER, page))?.revision, 2);
  });

  it("案に書く実行は正本に触らず、案の状態が 作っている → できた に変わる", async () => {
    const page = await transcribed();
    const added = await add(page, "Fake");
    assert.ok(added && added.status === "created");
    const candidate = added.candidate.id;
    const before = await getRecording(pool, OWNER, page);

    const created = await enqueueTranscription(pool, OWNER, page, run({ candidate }));
    assert.ok(created?.status === "created", JSON.stringify(created));
    // 段落があっても replace は要らない（正本には書かないので）
    const pending = (await listRecordingCandidates(pool, OWNER, page)).find((item) => item.id === candidate);
    assert.equal(pending?.state, "pending");

    const claimed = await claimRun(pool, created.run.id);
    assert.equal(claimed?.run.candidateId, candidate);
    assert.equal(
      await finishRun(pool, created.run.id, claimed!.generation, {
        segments: [{ start: 0, end: 7, text: "別のエンジンの段落", speaker: 1 }],
        durationSec: 610,
      }),
      "succeeded",
    );
    const ready = (await listRecordingCandidates(pool, OWNER, page)).find((item) => item.id === candidate);
    assert.deepEqual([ready?.state, ready?.segmentCount, ready?.durationSec, ready?.adopted], ["ready", 1, 610, false]);
    assert.deepEqual(await getRecording(pool, OWNER, page), before, "正本は変わらない（revision も進まない）");
    // 案を指定しない実行は、段落があるので今までどおり断る
    assert.deepEqual(await enqueueTranscription(pool, OWNER, page, run()), { status: "has_transcript" });
    // 無い案は candidate_missing
    assert.deepEqual(await enqueueTranscription(pool, OWNER, page, run({ candidate: randomUUID() })), { status: "candidate_missing" });
  });

  it("有効な実行が既にあるときは、その書き先（案か正本）を返す: 別の案の実行を、求めた案の実行と取り違えない", async () => {
    const page = await transcribed();
    const first = await add(page, "Fake");
    const second = await add(page, "Fake");
    assert.ok(first && first.status === "created" && second && second.status === "created");
    const running = await enqueueTranscription(pool, OWNER, page, run({ candidate: first.candidate.id }));
    assert.ok(running?.status === "created", JSON.stringify(running));

    // 同じ案を求めると、その実行（書き先は同じ案）
    const same = await enqueueTranscription(pool, OWNER, page, run({ candidate: first.candidate.id }));
    assert.deepEqual(same, { status: "existing", run: running.run, candidate: first.candidate.id });
    // 別の案を求めても、走っているのは最初の案の実行（呼び出し側が書き先を見て、始まっていないと分かる）
    const other = await enqueueTranscription(pool, OWNER, page, run({ candidate: second.candidate.id }));
    assert.deepEqual(other, { status: "existing", run: running.run, candidate: first.candidate.id });
    // 正本に書く実行を求めても同じ
    const canonical = await enqueueTranscription(pool, OWNER, page, run({ replace: true }));
    assert.deepEqual(canonical, { status: "existing", run: running.run, candidate: first.candidate.id });
  });

  it("採用すると正本が入れ替わり、それまでの本文は採用中だった案に残る", async () => {
    const page = await transcribed();
    const added = await add(page, "Fake");
    assert.ok(added && added.status === "created");
    const primary = added.candidates[0]!.id;
    const second = added.candidate.id;
    // 2 つ目の案に本文を入れる
    const created = await enqueueTranscription(pool, OWNER, page, run({ candidate: second }));
    assert.ok(created?.status === "created");
    const claimed = await claimRun(pool, created.run.id);
    await finishRun(pool, created.run.id, claimed!.generation, { segments: [{ start: 0, end: 7, text: "別のエンジンの段落", speaker: 1 }], durationSec: 610 });
    // 採用中の案の本文を、画面で直した（正本を直した）
    await updateRecording(pool, OWNER, page, 2, (data) => ({
      segments: data.segments.map((segment, index) => (index === 0 ? { ...segment, text: "直したはじめの段落" } : segment)),
      speakerNames: data.speakerNames,
    }));

    const adopted = await adoptRecordingCandidate(pool, OWNER, page, second);
    assert.ok(adopted && adopted.status === "ok");
    assert.deepEqual(
      adopted.recording.segments.map((segment) => segment.text),
      ["別のエンジンの段落"],
      "選んだ案が正本になる",
    );
    assert.deepEqual(adopted.recording.speakerNames, {}, "話者名も案のもの");
    assert.equal(adopted.recording.durationSec, 610);
    assert.equal(adopted.recording.engine, "fake");
    assert.equal(adopted.recording.revision, 4, "正本の revision が進む（開いている画面は 409 で最新に合わせる）");
    assert.deepEqual(
      adopted.candidates.map((item) => [item.name, item.adopted]),
      [
        ["Deepgram", false],
        ["Fake", true],
      ],
    );
    // 直した文章は、採用中だった案に残っている
    const kept = await getRecordingCandidate(pool, OWNER, page, primary);
    assert.deepEqual(
      kept?.segments.map((segment) => segment.text),
      ["直したはじめの段落", "もう 1 つの段落"],
    );
    assert.deepEqual(kept?.speakerNames, { "1": "司会役" });

    // もう一度採用し直すと、1 つ目の案に戻る（今の本文は Fake の案に残る）
    const back = await adoptRecordingCandidate(pool, OWNER, page, primary);
    assert.ok(back && back.status === "ok");
    assert.deepEqual(
      back.recording.segments.map((segment) => segment.text),
      ["直したはじめの段落", "もう 1 つの段落"],
    );
    assert.deepEqual(back.recording.speakerNames, { "1": "司会役" });
  });

  it("本文のできていない案は採用できない。別の人・無い案・ゴミ箱は null", async () => {
    const page = await transcribed();
    const added = await add(page, "Fake");
    assert.ok(added && added.status === "created");
    assert.deepEqual(await adoptRecordingCandidate(pool, OWNER, page, added.candidate.id), { status: "not_ready" });
    assert.equal(await adoptRecordingCandidate(pool, OTHER, page, added.candidate.id), null);
    assert.equal(await adoptRecordingCandidate(pool, OWNER, page, randomUUID()), null);
    assert.equal(await adoptRecordingCandidate(pool, OWNER, page, "not-a-uuid"), null);
    // 別のページの案は、このページからは採用できない
    const other = await transcribed();
    assert.equal(await adoptRecordingCandidate(pool, OWNER, other, added.candidate.id), null);
    await pool.query("UPDATE pages SET deleted_at = clock_timestamp() WHERE id = $1", [page]);
    assert.equal(await adoptRecordingCandidate(pool, OWNER, page, added.candidates[0]!.id), null);
    assert.deepEqual(await listRecordingCandidates(pool, OWNER, page), [], "ゴミ箱のページの案は読めない");
  });

  it("別の人・存在しないページには案を足せない。数の上限は too_many", async () => {
    const page = await transcribed();
    assert.equal(await add(page, "Fake", "fake", OTHER), null);
    assert.equal(await add(randomUUID(), "Fake"), null);
    assert.equal(await add("not-a-uuid", "Fake"), null);
    await assert.rejects(() => add(page, " 前後に空白 "), InvalidRecordingError);
    await assert.rejects(() => add(page, "改\n行"), InvalidRecordingError);
    await assert.rejects(() => add(page, "あ".repeat(61)), InvalidRecordingError);
    await assert.rejects(() => add(page, "Fake", ""), InvalidRecordingError);
    // 1 回目で 2 つ（1 つ目の案＋新しい案）。そのあとは 1 つずつ
    assert.ok((await add(page, "案 2"))?.status === "created");
    for (let n = 3; n <= RECORDING_CANDIDATES_MAX; n += 1) assert.ok((await add(page, `案 ${n}`))?.status === "created", `案 ${n}`);
    assert.deepEqual(await add(page, "溢れる案"), { status: "too_many" });
    assert.equal((await listRecordingCandidates(pool, OWNER, page)).length, RECORDING_CANDIDATES_MAX);
  });

  it("要らない案は消せる（採用中・実行中は消せない。実行の行も一緒に消える）", async () => {
    const page = await transcribed();
    const added = await add(page, "Fake");
    assert.ok(added?.status === "created");
    const primary = added.candidates[0]!.id;
    const second = added.candidate.id;

    // 実行が走っている間は消せない
    const created = await enqueueTranscription(pool, OWNER, page, run({ candidate: second }));
    assert.ok(created?.status === "created");
    assert.deepEqual(await deleteRecordingCandidate(pool, OWNER, page, second), { status: "running" });
    // 採用中は消せない
    assert.deepEqual(await deleteRecordingCandidate(pool, OWNER, page, primary), { status: "adopted" });

    const claimed = await claimRun(pool, created.run.id);
    await finishRun(pool, created.run.id, claimed!.generation, { segments: [{ start: 0, end: 7, text: "別のエンジンの段落", speaker: 1 }], durationSec: 610 });
    const removed = await deleteRecordingCandidate(pool, OWNER, page, second);
    assert.ok(removed && removed.status === "ok");
    assert.deepEqual(
      removed.candidates.map((item) => item.id),
      [primary],
    );
    // その案に書く実行の行も消える（FK の CASCADE）
    assert.equal((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM transcription_runs WHERE id = $1", [created.run.id])).rows[0]!.n, 0);
    // 正本は触らない
    assert.equal((await getRecording(pool, OWNER, page))?.revision, 2);

    // 別の人・無い案・不正な id・ゴミ箱
    assert.equal(await deleteRecordingCandidate(pool, OTHER, page, primary), null);
    assert.equal(await deleteRecordingCandidate(pool, OWNER, page, randomUUID()), null);
    assert.equal(await deleteRecordingCandidate(pool, OWNER, page, "not-a-uuid"), null);
  });

  it("ページを消すと、音声の行と案も消える", async () => {
    const page = await transcribed();
    await addPart(pool, page, { durationSec: 30 });
    const added = await add(page, "Fake");
    assert.ok(added?.status === "created");
    const store = (await import("../src/store.ts")).EditorStore;
    await new store(pool).deletePage(OWNER, page);
    await pool.query("DELETE FROM pages WHERE id = $1 AND owner = $2", [page, OWNER]);
    assert.equal((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM page_recording_audios WHERE page_id = $1", [page])).rows[0]!.n, 0);
    assert.equal((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM page_recording_candidates WHERE page_id = $1", [page])).rows[0]!.n, 0);
  });
});
