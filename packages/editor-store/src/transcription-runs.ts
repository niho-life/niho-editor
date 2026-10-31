import type { PoolClient } from "pg";
import { audioInfo, listAudioParts, type AudioInfo, type AudioPart } from "./recording-audio.ts";
import { writeCandidateSegments } from "./recording-candidates.ts";
import {
  CONTROL_CHARACTERS,
  InvalidRecordingError,
  TOUCH_PAGE_SQL,
  assertOwner,
  charCount,
  isInvalidTextRepresentation,
  isStorableText,
  recordingDataProblem,
  rollback,
  type Connectable,
  type RecordingSegment,
} from "./recordings.ts";
import { isPageId } from "./store.ts";
import type { OwnerId, PageLang, Queryable } from "./types.ts";

/**
 * 録音の文字起こしの実行（#36 段 2b。migrations/0012_transcription_runs.sql）。手順（#37）の実行の表とは別の経路。
 *
 * 流れ: 開始（enqueueTranscription）で run を queued で作る → 実行する側が claimRun で running にして世代を 1 つ進める →
 * 保存先の音声をエンジンに渡す → finishRun で段落を page_recordings に書き、run を succeeded にする（1 transaction）。
 * 途中の失敗は failRun（短い code だけ）。音声は消さないので、失敗しても「もう一度」（新しい run）ができる。
 *
 * 状態遷移は step-runs.ts と同じ流儀で、すべて「世代（generation）と状態を条件にした UPDATE」で行う。claim のたびに世代が進み、
 * 確定・失敗は claim のときの世代と一致して running のときだけ通る（掃除のあとに遅れて返った実行の結果で上書きしない）。
 * 掃除が積み直すときも世代を進める（requeueRun）。実行の口（Cloud Tasks）の task の名前に世代が入るので、消えた task の名前
 * （Cloud Tasks は最大 24 時間は同じ名前を作らせない）とぶつからず、取りこぼした run をすぐ積み直せる。
 * 1 つのページで有効な run（queued・running）は 1 つだけ（部分 unique index と、録音の行の FOR UPDATE）。
 * 段落を書くのは replace の run か、段落が空の録音だけ（直した文章を失わせない）。
 * 音声が複数ある録音（#36 段 3b-4）は、**すべての音声**を順に文字起こしして 1 本につなぐ（claim が音声の列を渡し、実行する側が
 * 前の音声の長さだけ時刻をずらす）。run の `candidate` が入っていれば、結果は正本ではなくその案に書く（見比べる別案）。
 * 読み書きは全て本人の・ゴミ箱でないページだけ（claimRun・finishRun・failRun は実行する側が run の id で呼ぶ）。
 * 本文・音声・エンジンの応答・鍵はこの表に持たない。
 */

/** 使えるエンジン（0012 の CHECK と、gemini を足した migration と同じ並び）。 */
export const TRANSCRIPTION_ENGINES = ["deepgram", "fake", "gemini"] as const;
export type TranscriptionEngineName = (typeof TRANSCRIPTION_ENGINES)[number];

export const TRANSCRIPTION_RUN_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type TranscriptionRunStatus = (typeof TRANSCRIPTION_RUN_STATUSES)[number];

/** 失敗の理由（0012 の CHECK と同じ）。 */
export const TRANSCRIPTION_ERROR_CODES = [
  "audio_missing",
  "audio_expired",
  "engine_unavailable",
  "engine_rejected",
  "engine_timeout",
  "engine_bad_response",
  "too_large",
  "internal",
] as const;
export type TranscriptionErrorCode = (typeof TRANSCRIPTION_ERROR_CODES)[number];

/** 固有名詞の表記の数と、1 つの文字数の上限（0012 の CHECK と API の検査と同じ）。 */
export const TRANSCRIPTION_TERMS_MAX = 100;
export const TRANSCRIPTION_TERM_MAX_CHARS = 64;

/** 画面に出す run（決まった項目だけ）。時刻は ISO 8601。 */
export type TranscriptionRunView = {
  id: string;
  status: TranscriptionRunStatus;
  engine: TranscriptionEngineName;
  language: PageLang;
  errorCode: TranscriptionErrorCode | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type EnqueueTranscriptionInput = {
  /** 使うエンジン（設定で決まる。要求からは選ばせない）。 */
  engine: TranscriptionEngineName;
  /** 音声の言語。無ければ録音の言語。 */
  language?: PageLang;
  /** 話者を分けるか。 */
  diarize: boolean;
  /** 既にある段落を置き換えてよいか（false なら、段落が空の録音だけ）。 */
  replace: boolean;
  /** 固有名詞の表記（100 個まで・1 つ 64 文字まで・制御文字なし）。 */
  terms: readonly string[];
  /**
   * 結果を書く案の id（#36 段 3b-4）。入れると正本（page_recordings）には書かず、その案に書く（`replace`・段落の有無は見ない）。
   * 無ければ今までどおり正本に書く。
   */
  candidate?: string | null;
};

export type EnqueueTranscriptionResult =
  | { status: "created"; run: TranscriptionRunView }
  /**
   * 有効な run（queued・running）が既にある（新しく作らない）。`candidate` はその run の書き先（null は正本）。
   * 同じページの有効な run は 1 つだけなので、別の案・正本に書く run が走っていることもある。呼び出し側は、書き先が
   * 求めたものと同じか確かめてから「始まった」と言う。
   */
  | { status: "existing"; run: TranscriptionRunView; candidate: string | null }
  /** 音声のアップロードが済んでいない（uploading）か、音声の無い録音。 */
  | { status: "audio_not_ready" }
  /** 音声の保持の期限を過ぎた（保存先から消えている見込み）。 */
  | { status: "audio_expired" }
  /** 段落が既にあり、replace が false（直した文章を失わせない）。 */
  | { status: "has_transcript" }
  /** 指定した案がこのページに無い（#36 段 3b-4）。 */
  | { status: "candidate_missing" };

/** 実行する側が claim した run。audio は本人の・ゴミ箱でないページの音声（無ければ null）。 */
export type ClaimedTranscription = {
  run: TranscriptionRunView & {
    owner: OwnerId;
    pageId: string;
    diarize: boolean;
    replace: boolean;
    terms: string[];
    /** 結果を書く案（無ければ正本）。 */
    candidateId: string | null;
  };
  /** この実行の世代。finishRun・failRun に渡す。 */
  generation: number;
  /** 最初の音声（part 0。音声の無い録音は null）。段 2b からある口。 */
  audio: AudioInfo | null;
  /** この録音の音声の列（part 0 から）。1 本だけの録音は audio と同じものが 1 つ入る。 */
  parts: AudioPart[];
};

/** finishRun に渡す結果（段落は保存の形に正規化したもの。話者は 1 始まりの番号か null）。 */
export type TranscriptionOutput = { segments: readonly RecordingSegment[]; durationSec: number | null };

/**
 * succeeded: 段落を書いて run を確定した / superseded: replace でない run で、その間に段落が入っていた（書かずに run を failed（internal）にした）/
 * stale: 世代が古い・running でない（掃除・別の実行のあと）。何も書いていない。
 */
export type FinishTranscriptionResult = "succeeded" | "superseded" | "stale";

type RunRow = {
  /** 書き先の案（null は正本）。 */
  candidate: string | null;
  id: string;
  status: TranscriptionRunStatus;
  engine: TranscriptionEngineName;
  language: PageLang;
  error_code: TranscriptionErrorCode | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
};

const RUN_COLUMNS = "t.id, t.status, t.engine, t.language, t.error_code, t.created_at, t.started_at, t.finished_at, t.candidate";

function toView(row: RunRow): TranscriptionRunView {
  return {
    id: row.id,
    status: row.status,
    engine: row.engine,
    language: row.language,
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  };
}

export function isTranscriptionErrorCode(value: unknown): value is TranscriptionErrorCode {
  return typeof value === "string" && (TRANSCRIPTION_ERROR_CODES as readonly string[]).includes(value);
}

/** 固有名詞の表記として受け付けるか（前後の空白なし・1〜64 文字・制御文字なし・保存できる文字）。 */
export function isTranscriptionTerm(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    charCount(value) <= TRANSCRIPTION_TERM_MAX_CHARS &&
    !CONTROL_CHARACTERS.test(value) &&
    isStorableText(value)
  );
}

function assertEnqueueInput(input: EnqueueTranscriptionInput): void {
  if (!(TRANSCRIPTION_ENGINES as readonly string[]).includes(input.engine)) throw new TypeError("editor-store: unknown transcription engine");
  if (input.language !== undefined && input.language !== "ja" && input.language !== "en") throw new TypeError("editor-store: language must be ja or en");
  if (typeof input.diarize !== "boolean" || typeof input.replace !== "boolean") throw new TypeError("editor-store: diarize and replace must be booleans");
  if (!Array.isArray(input.terms) || input.terms.length > TRANSCRIPTION_TERMS_MAX || !input.terms.every(isTranscriptionTerm)) {
    throw new TypeError("editor-store: terms are not valid");
  }
  if (input.candidate !== undefined && input.candidate !== null && !isPageId(input.candidate)) {
    throw new TypeError("editor-store: candidate must be a UUID");
  }
}

type LockRow = {
  language: PageLang;
  audio_status: "none" | "uploading" | "uploaded";
  expired: boolean;
  has_segments: boolean;
  /** 2 本目以降（#36 段 3b-4）に、まだアップロード中のものがあるか。 */
  parts_uploading: boolean;
  /** 2 本目以降に、期限を過ぎたものがあるか。 */
  parts_expired: boolean;
};

// 本人の・ゴミ箱でないページの録音を押さえる（同じページの開始を直列にする）。$1 owner / $2 page id。
// 期限は DB の時計で比べる（期限が無い行は、期限切れとしない。消えていれば実行のときに audio_missing になる）。
const LOCK_RECORDING_SQL = `
SELECT r.language, r.audio_status,
       COALESCE(r.audio_expires_at <= clock_timestamp(), false) AS expired,
       jsonb_array_length(r.segments) > 0 AS has_segments,
       EXISTS (
         SELECT 1 FROM page_recording_audios AS m
          WHERE m.owner = r.owner AND m.page_id = r.page_id AND m.status <> 'uploaded'
       ) AS parts_uploading,
       EXISTS (
         SELECT 1 FROM page_recording_audios AS m
          WHERE m.owner = r.owner AND m.page_id = r.page_id AND m.expires_at <= clock_timestamp()
       ) AS parts_expired
  FROM page_recordings AS r
  JOIN pages AS p ON p.owner = r.owner AND p.id = r.page_id
 WHERE r.owner = $1 AND r.page_id = $2 AND p.deleted_at IS NULL
   FOR UPDATE OF r`;

// $1 owner / $2 page id。
const ACTIVE_RUN_SQL = `
SELECT ${RUN_COLUMNS}
  FROM transcription_runs AS t
 WHERE t.owner = $1 AND t.page_id = $2 AND t.status IN ('queued', 'running')`;

// $1 owner / $2 page id / $3 engine / $4 language / $5 diarize / $6 replace / $7 terms（JSON の配列）/ $8 candidate
const INSERT_RUN_SQL = `
INSERT INTO transcription_runs AS t (owner, page_id, engine, status, language, diarize, replace, terms, candidate)
VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7::jsonb, $8::uuid)
RETURNING ${RUN_COLUMNS}`;

// $1 owner / $2 page id / $3 candidate id。案がこのページのものか（案に書く run だけ）。
const CANDIDATE_EXISTS_SQL = `
SELECT 1
  FROM page_recording_candidates AS c
 WHERE c.owner = $1 AND c.page_id = $2 AND c.id = $3`;

const ACTIVE_INDEX = "transcription_runs_active_idx";

function isActiveRunConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === "23505" && constraint === ACTIVE_INDEX;
}

async function activeRun(db: Pick<PoolClient, "query">, owner: OwnerId, pageId: string): Promise<{ run: TranscriptionRunView; candidate: string | null } | null> {
  const row = (await db.query<RunRow>(ACTIVE_RUN_SQL, [owner, pageId])).rows[0];
  return row ? { run: toView(row), candidate: row.candidate } : null;
}

/**
 * 文字起こしを始める（run を queued で作る）。録音の行を FOR UPDATE で押さえてから前提を順に見る:
 * - 本人の・ゴミ箱でないページの録音が無い（別の人・存在しない・不正な id・削除済み・録音の無いページ）: null
 * - 音声（複数あればそのどれか）のアップロードが済んでいない・音声が無い: audio_not_ready / 期限を過ぎた: audio_expired
 * - 案を指定したが、その案がこのページに無い: candidate_missing
 * - 有効な run（queued・running）がある: それを返す（existing。何も書かない）
 * - 段落があり replace が false: has_transcript（案に書く run では見ない。何も書かない）
 * - それ以外: run を作る（created）
 * 同じページの開始が並んでも、作られる run は 1 つだけ（行の lock と部分 unique index。unique で止まった側は既存を返す）。
 */
export async function enqueueTranscription(
  pool: Connectable,
  owner: OwnerId,
  pageId: string,
  input: EnqueueTranscriptionInput,
): Promise<EnqueueTranscriptionResult | null> {
  assertOwner(owner);
  assertEnqueueInput(input);
  if (!isPageId(pageId)) return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const recording = (await client.query<LockRow>(LOCK_RECORDING_SQL, [owner, pageId])).rows[0];
      if (!recording) {
        await rollback(client);
        return null;
      }
      // 音声は 1 本でも複数でも、全部がアップロード済みで期限の前でなければ始めない（#36 段 3b-4）
      if (recording.audio_status !== "uploaded" || recording.parts_uploading) {
        await rollback(client);
        return { status: "audio_not_ready" };
      }
      if (recording.expired || recording.parts_expired) {
        await rollback(client);
        return { status: "audio_expired" };
      }
      const candidate = input.candidate ?? null;
      if (candidate !== null) {
        const found = (await client.query(CANDIDATE_EXISTS_SQL, [owner, pageId, candidate])).rowCount === 1;
        if (!found) {
          await rollback(client);
          return { status: "candidate_missing" };
        }
      }
      const existing = await activeRun(client, owner, pageId);
      if (existing) {
        await rollback(client);
        return { status: "existing", run: existing.run, candidate: existing.candidate };
      }
      // 案に書く run は、正本の段落には触らないので段落の有無を見ない
      if (candidate === null && recording.has_segments && !input.replace) {
        await rollback(client);
        return { status: "has_transcript" };
      }
      const inserted = await client.query<RunRow>(INSERT_RUN_SQL, [
        owner,
        pageId,
        input.engine,
        input.language ?? recording.language,
        input.diarize,
        input.replace,
        JSON.stringify([...input.terms]),
        candidate,
      ]);
      const row = inserted.rows[0];
      if (!row) throw new Error("editor-store: insert returned no transcription run");
      await client.query("COMMIT");
      return { status: "created", run: toView(row) };
    } catch (error) {
      await rollback(client);
      // 録音の行の lock を通らずに同じページの run が入った（並んだ開始）: 先に入った方を返す
      if (isActiveRunConflict(error)) {
        const existing = await activeRun(client, owner, pageId);
        if (existing) return { status: "existing", run: existing.run, candidate: existing.candidate };
      }
      if (isInvalidTextRepresentation(error)) return null;
      throw error;
    }
  } finally {
    client.release();
  }
}

type ClaimRow = RunRow & { owner: string; page_id: string; diarize: boolean; replace: boolean; terms: unknown; generation: number; candidate: string | null };

// queued の run だけを running にして世代を 1 つ進める（同時に何本来ても 1 本だけが通る）。$1 run id。
const CLAIM_SQL = `
UPDATE transcription_runs AS t
   SET status = 'running',
       generation = t.generation + 1,
       started_at = GREATEST(clock_timestamp(), t.created_at)
 WHERE t.id = $1 AND t.status = 'queued'
RETURNING ${RUN_COLUMNS}, t.owner, t.page_id, t.diarize, t.replace, t.terms, t.generation, t.candidate`;

/**
 * queued の run を実行中にする（世代を 1 つ進め、開始の時刻を入れる）。他が claim 済み・終わっている・無い・不正な id は null。
 * あわせて、本人の・ゴミ箱でないページの音声の資産の情報（part 0）と、音声の列（parts）を返す
 * （無ければ audio: null・parts: []。実行する側が audio_missing にする）。
 */
export async function claimRun(db: Queryable, runId: string): Promise<ClaimedTranscription | null> {
  if (typeof runId !== "string" || !isPageId(runId)) return null;
  const row = (await db.query<ClaimRow>(CLAIM_SQL, [runId])).rows[0];
  if (!row) return null;
  const terms = Array.isArray(row.terms) ? row.terms.filter(isTranscriptionTerm) : [];
  let audio: Awaited<ReturnType<typeof audioInfo>>;
  let parts: AudioPart[];
  try {
    audio = await audioInfo(db, row.owner, row.page_id);
    // 音声の列（1 本だけの録音も part 0 の 1 件になる）
    parts = await listAudioParts(db, row.owner, row.page_id);
  } catch (error) {
    // claim の UPDATE は済んでいる（running・世代 1 以上）。呼び出し側の「claim できたか分からない」の失敗（世代 0）は当たらないので、
    // claim した世代でここで失敗にする（running のまま残さない）。この更新も届かなければ、掃除（sweepStaleRuns）が拾う
    await db.query(FAIL_SQL, [runId, row.generation, "internal"]).catch(() => undefined);
    throw error;
  }
  return {
    run: { ...toView(row), owner: row.owner, pageId: row.page_id, diarize: row.diarize, replace: row.replace, terms, candidateId: row.candidate },
    generation: row.generation,
    audio,
    parts,
  };
}

type FinishLockRow = {
  owner: string;
  page_id: string;
  status: TranscriptionRunStatus;
  generation: number;
  replace: boolean;
  engine: TranscriptionEngineName;
  candidate: string | null;
};

const LOCK_RUN_SQL = "SELECT owner, page_id, status, generation, replace, engine, candidate FROM transcription_runs WHERE id = $1 FOR UPDATE";

// 録音の行を押さえる（run → 録音 の順に lock を取る。開始は録音の行だけを押さえて run の行を lock しないので、順が逆転しない）
const LOCK_SEGMENTS_SQL = `
SELECT jsonb_array_length(segments) > 0 AS has_segments
  FROM page_recordings
 WHERE owner = $1 AND page_id = $2
   FOR UPDATE`;

// 段落を書く。話者名の表は空にする（番号の付け方が変わるので、前の名前は当てはまらない）。revision を進めるので、
// 開いている画面の古い revision の書き込みは 409（最新を受け取って当て直す）になる。長さはエンジンが返したときだけ置き換える。
// $1 owner / $2 page id / $3 segments / $4 engine / $5 duration
const WRITE_SEGMENTS_SQL = `
UPDATE page_recordings AS r
   SET segments = $3::jsonb,
       speaker_names = '{}'::jsonb,
       engine = $4::text,
       duration_sec = COALESCE($5::numeric, r.duration_sec),
       revision = r.revision + 1,
       updated_at = GREATEST(clock_timestamp(), r.updated_at)
 WHERE r.owner = $1 AND r.page_id = $2`;

// $1 run id / $2 generation
const SUCCEED_SQL = `
UPDATE transcription_runs
   SET status = 'succeeded',
       finished_at = GREATEST(clock_timestamp(), started_at)
 WHERE id = $1 AND generation = $2 AND status = 'running'`;

// $1 run id / $2 generation / $3 error code。作ったばかりの queued の run は世代 0 なので、世代 0 を渡すと「一度も claim も積み直しも
// されていない」run だけを失敗にできる（積めなかったとき）。claim のあと・掃除が積み直したあとは世代が 1 以上なので、
// 世代 0 の呼び出しは何もしない（その run は掃除が拾う）。
const FAIL_SQL = `
UPDATE transcription_runs
   SET status = 'failed',
       error_code = $3,
       finished_at = GREATEST(clock_timestamp(), COALESCE(started_at, created_at))
 WHERE id = $1 AND generation = $2 AND status IN ('queued', 'running')`;

function cleanOutput(output: TranscriptionOutput): { segments: RecordingSegment[]; durationSec: number | null } {
  if (!output || !Array.isArray(output.segments)) throw new InvalidRecordingError("segments");
  const segments = output.segments.map((segment) => {
    if (typeof segment !== "object" || segment === null) throw new InvalidRecordingError("segment");
    const { start, end, text, speaker } = segment;
    return { start, end, text, speaker };
  });
  const problem = recordingDataProblem({ segments, speakerNames: {} });
  if (problem) throw new InvalidRecordingError(problem);
  const duration = output.durationSec;
  if (duration !== null && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)) throw new InvalidRecordingError("duration");
  return { segments, durationSec: duration };
}

/**
 * 実行の結果を確定する。1 つの transaction で、run の行を FOR UPDATE で押さえ、世代が一致して running のときだけ:
 * - 案に書く run（candidate つき）: その案に段落・長さ・エンジンを書いて succeeded（正本は触らないので、開いている画面の
 *   revision は変わらない）。案が消えていたら書かずに failed（superseded）
 * - replace でない run で、その間に段落が入っていた: 書かずに run を failed（internal）にする（superseded）
 * - それ以外: page_recordings の段落・話者名（空）・エンジン・長さを書いて revision を 1 進め、ページの更新時刻も進め、run を succeeded にする
 * 世代が違う・running でない・不正な id は何もしない（stale）。結果の形が規則に合わなければ InvalidRecordingError（何も書かない）。
 */
export async function finishRun(pool: Connectable, runId: string, generation: number, output: TranscriptionOutput): Promise<FinishTranscriptionResult> {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError("editor-store: generation must be a positive integer");
  const clean = cleanOutput(output);
  if (typeof runId !== "string" || !isPageId(runId)) return "stale";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const run = (await client.query<FinishLockRow>(LOCK_RUN_SQL, [runId])).rows[0];
      if (!run || run.status !== "running" || run.generation !== generation) {
        await rollback(client);
        return "stale";
      }
      if (run.candidate !== null) {
        // 案に書く run: 正本（page_recordings）には触らない（採用のときに写す）
        const written = await writeCandidateSegments(client, run.candidate, { segments: clean.segments, durationSec: clean.durationSec, engine: run.engine });
        if (written === "missing") {
          // 案が消えた: 書かずに失敗にする
          await client.query(FAIL_SQL, [runId, generation, "internal"]);
          await client.query("COMMIT");
          return "superseded";
        }
        await client.query(TOUCH_PAGE_SQL, [run.owner, run.page_id]);
        const finished = await client.query(SUCCEED_SQL, [runId, generation]);
        if (finished.rowCount !== 1) throw new Error("editor-store: transcription run disappeared");
        await client.query("COMMIT");
        return "succeeded";
      }
      const recording = (await client.query<{ has_segments: boolean }>(LOCK_SEGMENTS_SQL, [run.owner, run.page_id])).rows[0];
      if (!recording || (recording.has_segments && !run.replace)) {
        // 誰かが先に段落を書いた（または録音が無くなった）: 上書きしない
        await client.query(FAIL_SQL, [runId, generation, "internal"]);
        await client.query("COMMIT");
        return "superseded";
      }
      await client.query(WRITE_SEGMENTS_SQL, [run.owner, run.page_id, JSON.stringify(clean.segments), run.engine, clean.durationSec]);
      await client.query(TOUCH_PAGE_SQL, [run.owner, run.page_id]);
      const done = await client.query(SUCCEED_SQL, [runId, generation]);
      if (done.rowCount !== 1) throw new Error("editor-store: transcription run disappeared");
      await client.query("COMMIT");
      return "succeeded";
    } catch (error) {
      await rollback(client);
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * 実行の失敗。世代が一致して running のとき（または世代 0 で、まだ claim されていない queued のとき）だけ failed にする。
 * 失敗にしたら true、何もしなかったら false（掃除・別の実行のあと・不正な id）。
 */
export async function failRun(db: Queryable, runId: string, generation: number, errorCode: TranscriptionErrorCode): Promise<boolean> {
  if (!isTranscriptionErrorCode(errorCode)) throw new TypeError("editor-store: unknown transcription error code");
  if (!Number.isSafeInteger(generation) || generation < 0) throw new TypeError("editor-store: generation must be a non-negative integer");
  if (typeof runId !== "string" || !isPageId(runId)) return false;
  const result = await db.query(FAIL_SQL, [runId, generation, errorCode]);
  return result.rowCount === 1;
}

type StatusRow = { [K in keyof RunRow]: RunRow[K] | null };

// 本人の・ゴミ箱でないページの録音と、その最新の run。$1 owner / $2 page id。
const STATUS_SQL = `
SELECT ${RUN_COLUMNS}
  FROM page_recordings AS r
  JOIN pages AS p ON p.owner = r.owner AND p.id = r.page_id
  LEFT JOIN LATERAL (
    SELECT * FROM transcription_runs AS x
     WHERE x.owner = r.owner AND x.page_id = r.page_id
     ORDER BY x.created_at DESC, x.id DESC
     LIMIT 1
  ) AS t ON true
 WHERE r.owner = $1 AND r.page_id = $2 AND p.deleted_at IS NULL`;

/**
 * 本人の・ゴミ箱でないページの録音の、文字起こしの状態（`{ run }`。run が無ければ run: null）。
 * 録音が無ければ null（別の人・存在しない・不正な id・削除済み・録音の無いページ。呼び出し側は同じ 404 にする）。
 */
export async function transcriptionStatus(db: Queryable, owner: OwnerId, pageId: string): Promise<{ run: TranscriptionRunView | null } | null> {
  assertOwner(owner);
  if (typeof pageId !== "string" || !isPageId(pageId)) return null;
  try {
    const row = (await db.query<StatusRow>(STATUS_SQL, [owner, pageId])).rows[0];
    if (!row) return null;
    return { run: row.id === null ? null : toView(row as RunRow) };
  } catch (error) {
    if (isInvalidTextRepresentation(error)) return null;
    throw error;
  }
}

/** 本人の・ゴミ箱でないページの最新の run。無ければ null（run が無い・別の人・存在しない・不正な id・削除済み・録音の無いページ）。 */
export async function latestRun(db: Queryable, owner: OwnerId, pageId: string): Promise<TranscriptionRunView | null> {
  return (await transcriptionStatus(db, owner, pageId))?.run ?? null;
}

// $1 now / $2 olderThanSec
const SWEEP_SQL = `
UPDATE transcription_runs
   SET status = 'failed',
       error_code = CASE WHEN status = 'running' THEN 'engine_timeout' ELSE 'internal' END,
       finished_at = GREATEST($1::timestamptz, COALESCE(started_at, created_at))
 WHERE (status = 'running' AND started_at < $1::timestamptz - make_interval(secs => $2::double precision))
    OR (status = 'queued' AND created_at < $1::timestamptz - make_interval(secs => $2::double precision))
RETURNING id`;

/** 積み直しの対象（queued の run。世代は task の名前に入れる）。 */
export type QueuedTranscriptionRun = { id: string; generation: number };

/** $1 olderThan / $2 limit。transcription_runs_queued_idx（0014）の並び。 */
const LIST_QUEUED_SQL = `
SELECT id, generation
  FROM transcription_runs
 WHERE status = 'queued' AND created_at < $1::timestamptz
 ORDER BY created_at, id
 LIMIT $2`;

/** 1 回の読み込みで拾う数の上限。 */
export const LIST_QUEUED_LIMIT_MAX = 1000;

/**
 * まだ queued の run（古い順・上限つき）。定期の掃除が、同じ task の名前（世代を含む）で積み直す対象
 * （積み込みの失敗・失われた task を拾う。まだ積まれていれば、名前の重複で無視される）。読むだけ。
 * `olderThan` より後に作られた run は返さない（開始の API が積んでいる最中の run を掃除が二重に積まないため）。
 * 上限に達したら、残りは次の掃除が拾う（この表は 1 ページで有効な run が 1 つだけなので、queued が積み上がるのは異常）。
 */
export async function listQueuedRuns(db: Queryable, options: { olderThan: Date; limit?: number }): Promise<QueuedTranscriptionRun[]> {
  const { olderThan } = options;
  if (!(olderThan instanceof Date) || Number.isNaN(olderThan.getTime())) throw new TypeError("editor-store: olderThan must be a valid Date");
  const limit = Math.max(1, Math.min(options.limit ?? 100, LIST_QUEUED_LIMIT_MAX));
  const result = await db.query<{ id: string; generation: number }>(LIST_QUEUED_SQL, [olderThan.toISOString(), limit]);
  return result.rows.map((row) => ({ id: row.id, generation: row.generation }));
}

// $1 run id / $2 generation。まだ claim されていない run の世代だけを 1 つ進める（状態は queued のまま）。
const REQUEUE_SQL = `
UPDATE transcription_runs
   SET generation = generation + 1
 WHERE id = $1 AND generation = $2 AND status = 'queued'
RETURNING generation`;

/**
 * 掃除が積み直す前に、まだ claim されていない run の世代を 1 つ進める。新しい世代を返す（queued でない・世代が違う・無い・
 * 不正な id なら null＝積み直さない）。状態は queued のままなので、積んだ task は今までと同じように claim できる。
 *
 * 世代を進めるのは、task の名前（`<run>-<世代>`）を前の task と別にするため。**Cloud Tasks は消した task の名前を最大 24 時間
 * 使わせない**ので、同じ名前で積み直すと「まだ積まれている」と区別がつかず、取りこぼした run がその間だまって止まる
 * （試行を使い切って task が消えた・積み込みが途中で落ちた、など）。世代が進めば名前が変わるので、次の掃除でそのまま拾える。
 * 手順（step-runs.ts）の attempt も、同じ理由で世代を task の名前に入れている。
 */
export async function requeueRun(db: Queryable, runId: string, generation: number): Promise<number | null> {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new TypeError("editor-store: generation must be a non-negative integer");
  if (typeof runId !== "string" || !isPageId(runId)) return null;
  const row = (await db.query<{ generation: number }>(REQUEUE_SQL, [runId, generation])).rows[0];
  return row ? row.generation : null;
}

/**
 * 古くなった有効な run の掃除（DB だけ。呼ぶのは worker の `/api/internal/transcription/sweep`。定期の実行は Cloud Scheduler）:
 * - running のまま started_at が now − olderThanSec より前: failed（engine_timeout）。実行する側が落ちた・時間切れ
 * - queued のまま created_at が now − olderThanSec より前: failed（internal）。積めなかった・実行する側が claim の前に落ちた
 * 失敗にした run の id を返す。遅れて返った実行の確定・失敗は、running でなくなったので通らない。
 */
export async function sweepStaleRuns(db: Queryable, now: Date, olderThanSec: number): Promise<string[]> {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("editor-store: now must be a valid Date");
  if (typeof olderThanSec !== "number" || !Number.isFinite(olderThanSec) || olderThanSec <= 0) throw new RangeError("editor-store: olderThanSec must be > 0");
  const result = await db.query<{ id: string }>(SWEEP_SQL, [now.toISOString(), olderThanSec]);
  return result.rows.map((row) => row.id);
}
