import type { PoolClient } from "pg";
import { audioInfo, listAudioParts, type AudioInfo, type AudioPart } from "./recording-audio.ts";
import { createTranscriptTab, ensureRecordingFolder, writeTranscriptSegments } from "./transcripts.ts";
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
 * 音声が複数ある録音（#36 段 3b-4）は、**すべての音声**を順に文字起こしして 1 本につなぐ（claim が音声の列を渡し、実行する側が
 * 前の音声の長さだけ時刻をずらす）。
 * #310: 結果の書き先は run の `target_tab`（開始のときに作る「文字起こし」ページの新しいタブ。transcripts.ts）。録音の正本
 * （page_recordings.segments）には書かない。開始後にタブが直されていれば（revision が進んでいれば）結果を捨てる。
 * `target_tab` の無い古い run（migration より前）だけは、今までどおり正本に書く。
 * 読み書きは全て本人の・ゴミ箱でないページだけ（claimRun・finishRun・failRun は実行する側が run の id で呼ぶ）。
 * 本文・音声・エンジンの応答・鍵はこの表に持たない。
 */

/** server runner で使えるエンジン。Mac CLI は専用開始口だけで作り、ここへは混ぜない。 */
export const TRANSCRIPTION_ENGINES = ["deepgram", "fake", "gemini"] as const;
export type TranscriptionEngineName = (typeof TRANSCRIPTION_ENGINES)[number];
export type TranscriptionLedgerEngineName = TranscriptionEngineName | "gemini-cli" | "apple-local";

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
  "stopped",
] as const;
export type TranscriptionErrorCode = (typeof TRANSCRIPTION_ERROR_CODES)[number];

/** 固有名詞の表記の数と、1 つの文字数の上限（0012 の CHECK と API の検査と同じ）。 */
export const TRANSCRIPTION_TERMS_MAX = 100;
export const TRANSCRIPTION_TERM_MAX_CHARS = 64;

/** 画面に出す run（決まった項目だけ）。時刻は ISO 8601。 */
export type TranscriptionRunView = {
  id: string;
  status: TranscriptionRunStatus;
  engine: TranscriptionLedgerEngineName;
  /** 古い呼び出し側では未指定＝server。API応答では常に明示する。 */
  executor?: "server" | "mac-cli" | "mac-local";
  language: PageLang;
  errorCode: TranscriptionErrorCode | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 結果を書く文字起こしのタブ（#310。migration より前の run は null＝正本に書いた）。 */
  tab: string | null;
};

export type EnqueueTranscriptionInput = {
  /** 使うエンジン（設定で決まる。要求からは選ばせない）。 */
  engine: TranscriptionEngineName;
  /** 音声の言語。無ければ録音の言語。 */
  language?: PageLang;
  /** 話者を分けるか。 */
  diarize: boolean;
  /** 固有名詞の表記（100 個まで・1 つ 64 文字まで・制御文字なし）。 */
  terms: readonly string[];
  /**
   * 書き先にする既存の文字起こしのタブ（「もう一度」。失敗した・空のタブに同じ録音で書き直す。#310）。
   * 省けば新しいタブを作る。この録音のタブでなければ tab_missing。
   */
  tab?: string;
};

export type EnqueueTranscriptionResult =
  /** run を作り、結果を書くタブ（`tab`。省略時は「文字起こし」ページに足した新しいタブ）を決めた。 */
  | { status: "created"; run: TranscriptionRunView; tab: string }
  /** 有効な run（queued・running）が既にある（新しく作らない）。`tab` はその run の書き先。 */
  | { status: "existing"; run: TranscriptionRunView; tab: string | null }
  /** 音声のアップロードが済んでいない（uploading）か、音声の無い録音。 */
  | { status: "audio_not_ready" }
  /** 音声の保持の期限を過ぎた（保存先から消えている見込み）。 */
  | { status: "audio_expired" }
  /** `tab` がこの録音の文字起こしのタブでない（別の録音・消えた・別の人）。 */
  | { status: "tab_missing" };

/** Mac の Antigravity CLI 実行で固定する設定。画面や native から任意のモデル・分割秒を渡さない。 */
export const MAC_CLI_TRANSCRIPTION_SETTINGS = Object.freeze({ model: "gemini-3.8-flash", effort: "low", targetSec: 600 } as const);
/** Apple 端末内認識で固定する設定。provider/model の課金表示とは混ぜない。 */
export const MAC_LOCAL_TRANSCRIPTION_SETTINGS = Object.freeze({ engine: "apple-speech", speakerMode: "auto" } as const);

export type MacAudioManifestPart = {
  partIndex: number;
  bytes: number;
  contentType: string;
  sha256: string;
  durationSec: number | null;
  offsetSec: number;
};

export type MacTranscriptionStartInput = {
  operationId: string;
  language?: PageLang;
  terms: readonly string[];
};

export type MacLocalTranscriptionStartInput = {
  operationId: string;
  language?: PageLang;
};

export type MacTranscriptionRun = {
  run: TranscriptionRunView;
  generation: number;
  operationId: string;
  settings: typeof MAC_CLI_TRANSCRIPTION_SETTINGS;
  audioManifest: MacAudioManifestPart[];
  /** 結果を書く文字起こしのタブ（#310）。 */
  tab: string | null;
};

export type StartMacTranscriptionResult =
  | ({ status: "created" | "existing" } & MacTranscriptionRun)
  | { status: "audio_not_ready" | "audio_expired" | "other_run_active" | "operation_conflict" };

export type MacLocalTranscriptionRun = {
  run: TranscriptionRunView;
  generation: number;
  operationId: string;
  settings: typeof MAC_LOCAL_TRANSCRIPTION_SETTINGS;
  audioManifest: MacAudioManifestPart[];
  /** 結果を書く文字起こしのタブ（#310）。 */
  tab: string | null;
};

export type StartMacLocalTranscriptionResult =
  | ({ status: "created" | "existing" } & MacLocalTranscriptionRun)
  | { status: "audio_not_ready" | "audio_expired" | "other_run_active" | "operation_conflict" };

/** 実行する側が claim した run。audio は本人の・ゴミ箱でないページの音声（無ければ null）。 */
export type ClaimedTranscription = {
  run: Omit<TranscriptionRunView, "engine" | "executor"> & {
    engine: TranscriptionEngineName;
    executor?: "server";
    owner: OwnerId;
    pageId: string;
    diarize: boolean;
    replace: boolean;
    terms: string[];
    /** 結果を書く文字起こしのタブ（#310。古い run は null＝正本）。 */
    tab: string | null;
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
 * succeeded: 段落を書いて run を確定した / superseded: 開始後にタブ（古い run なら録音）が直された・消えた（書かずに失敗）/
 * stale: 世代が古い・running でない（掃除・別の実行のあと）。何も書いていない。
 */
export type FinishTranscriptionResult = "succeeded" | "superseded" | "stale";

type RunRow = {
  /** 書き先のタブ（#310。古い run は null＝正本）。 */
  target_tab: string | null;
  id: string;
  status: TranscriptionRunStatus;
  engine: TranscriptionLedgerEngineName;
  executor: "server" | "mac-cli" | "mac-local";
  language: PageLang;
  error_code: TranscriptionErrorCode | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
};

const RUN_COLUMNS = "t.id, t.status, t.engine, t.executor, t.language, t.error_code, t.created_at, t.started_at, t.finished_at, t.target_tab";

function toView(row: RunRow): TranscriptionRunView {
  return {
    id: row.id,
    status: row.status,
    engine: row.engine,
    executor: row.executor,
    language: row.language,
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    tab: row.target_tab,
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
  if (typeof input.diarize !== "boolean") throw new TypeError("editor-store: diarize must be a boolean");
  if (!Array.isArray(input.terms) || input.terms.length > TRANSCRIPTION_TERMS_MAX || !input.terms.every(isTranscriptionTerm)) {
    throw new TypeError("editor-store: terms are not valid");
  }
  if (input.tab !== undefined && !isPageId(input.tab)) throw new TypeError("editor-store: tab must be a UUID");
}

function audioManifest(parts: readonly AudioPart[]): MacAudioManifestPart[] {
  return parts.map(({ partIndex, bytes, contentType, sha256, durationSec, offsetSec }) => ({
    partIndex,
    bytes,
    contentType,
    sha256,
    durationSec,
    offsetSec,
  }));
}

function sameManifest(left: unknown, right: readonly MacAudioManifestPart[]): boolean {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return left.every((value, index) => {
    if (typeof value !== "object" || value === null) return false;
    const part = value as Record<string, unknown>;
    const expected = right[index];
    return (
      expected !== undefined &&
      part.partIndex === expected.partIndex &&
      part.bytes === expected.bytes &&
      part.contentType === expected.contentType &&
      part.sha256 === expected.sha256 &&
      part.durationSec === expected.durationSec &&
      part.offsetSec === expected.offsetSec
    );
  });
}

function sameMacSettings(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  return (
    settings.model === MAC_CLI_TRANSCRIPTION_SETTINGS.model &&
    settings.effort === MAC_CLI_TRANSCRIPTION_SETTINGS.effort &&
    settings.targetSec === MAC_CLI_TRANSCRIPTION_SETTINGS.targetSec
  );
}

function sameMacLocalSettings(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  return settings.engine === MAC_LOCAL_TRANSCRIPTION_SETTINGS.engine && settings.speakerMode === MAC_LOCAL_TRANSCRIPTION_SETTINGS.speakerMode;
}

type LockRow = {
  base_revision: number;
  language: PageLang;
  engine: string | null;
  duration_sec: number | null;
  segments: RecordingSegment[];
  speaker_names: Record<string, string>;
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
SELECT r.language, r.engine, r.duration_sec::float8 AS duration_sec, r.segments, r.speaker_names,
       r.audio_status, r.revision AS base_revision,
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

// $1 owner / $2 page id / $3 engine / $4 language / $5 diarize / $6 terms / $7 base revision（書き先のタブの revision）/ $8 target tab
const INSERT_RUN_SQL = `
INSERT INTO transcription_runs AS t (owner, page_id, engine, status, language, diarize, replace, terms, base_revision, target_tab)
VALUES ($1, $2, $3, 'queued', $4, $5, false, $6::jsonb, $7, $8::uuid)
RETURNING ${RUN_COLUMNS}`;

// $1 owner / $2 tab id。書き先のタブ（本人の・ゴミ箱でない）の今の revision。
const TAB_REVISION_SQL = `
SELECT t.revision
  FROM page_transcripts AS t
  JOIN pages AS p ON p.owner = t.owner AND p.id = t.page_id
 WHERE t.owner = $1 AND t.page_id = $2 AND p.deleted_at IS NULL`;

// $1 owner / $2 recording id / $3 tab id。この録音の文字起こしのタブ（本人の・ゴミ箱でない）を押さえ、今の revision を読む。
const OWN_TAB_REVISION_SQL = `
SELECT t.revision
  FROM page_transcripts AS t
  JOIN pages AS p ON p.owner = t.owner AND p.id = t.page_id
 WHERE t.owner = $1 AND t.recording_page_id = $2 AND t.page_id = $3 AND p.deleted_at IS NULL
   FOR UPDATE OF t`;

const ACTIVE_INDEX = "transcription_runs_active_idx";

function isActiveRunConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === "23505" && constraint === ACTIVE_INDEX;
}

async function activeRun(db: Pick<PoolClient, "query">, owner: OwnerId, pageId: string): Promise<{ run: TranscriptionRunView; tab: string | null } | null> {
  const row = (await db.query<RunRow>(ACTIVE_RUN_SQL, [owner, pageId])).rows[0];
  return row ? { run: toView(row), tab: row.target_tab } : null;
}

/**
 * 文字起こしを始める（run を queued で作る）。録音の行を FOR UPDATE で押さえてから前提を順に見る:
 * - 本人の・ゴミ箱でないページの録音が無い（別の人・存在しない・不正な id・削除済み・録音の無いページ）: null
 * - 音声（複数あればそのどれか）のアップロードが済んでいない・音声が無い: audio_not_ready / 期限を過ぎた: audio_expired
 * - 有効な run（queued・running）がある: それを返す（existing。何も書かない）
 * - `tab` を指定した（「もう一度」）のに、この録音の文字起こしのタブでない: tab_missing
 * - それ以外: 録音がフォルダの外ならフォルダに包み、「文字起こし」ページに新しいタブ（本文なし・札はエンジンの名前）を足し
 *   （`tab` を指定していればそのタブ）、そのタブを書き先にして run を作る（created。#310）
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
      const existing = await activeRun(client, owner, pageId);
      if (existing) {
        await rollback(client);
        return { status: "existing", run: existing.run, tab: existing.tab };
      }
      const language = input.language ?? recording.language;
      let tab: string;
      let baseRevision: number;
      if (input.tab !== undefined) {
        // 「もう一度」: この録音の既存のタブに書き直す（開始後に直されたら finishRun が superseded にする）
        const own = (await client.query<{ revision: number }>(OWN_TAB_REVISION_SQL, [owner, pageId, input.tab])).rows[0];
        if (!own) {
          await rollback(client);
          return { status: "tab_missing" };
        }
        tab = input.tab;
        baseRevision = own.revision;
      } else {
        // 書き先: 「文字起こし」ページの新しいタブ（録音がフォルダの外なら、まずフォルダに包む。#310）
        const home = await ensureRecordingFolder(client, owner, pageId);
        if (!home) {
          await rollback(client);
          return null;
        }
        tab = (await createTranscriptTab(client, owner, home, { engine: input.engine, language, durationSec: recording.duration_sec })).tab;
        baseRevision = 1;
      }
      const inserted = await client.query<RunRow>(INSERT_RUN_SQL, [
        owner,
        pageId,
        input.engine,
        language,
        input.diarize,
        JSON.stringify([...input.terms]),
        baseRevision,
        tab,
      ]);
      const row = inserted.rows[0];
      if (!row) throw new Error("editor-store: insert returned no transcription run");
      await client.query("COMMIT");
      return { status: "created", run: toView(row), tab };
    } catch (error) {
      await rollback(client);
      // 録音の行の lock を通らずに同じページの run が入った（並んだ開始）: 先に入った方を返す
      if (isActiveRunConflict(error)) {
        const existing = await activeRun(client, owner, pageId);
        if (existing) return { status: "existing", run: existing.run, tab: existing.tab };
      }
      if (isInvalidTextRepresentation(error)) return null;
      throw error;
    }
  } finally {
    client.release();
  }
}

type MacRunRow = RunRow & {
  owner: string;
  base_revision: number;
  generation: number;
  operation_id: string;
  settings: unknown;
  audio_manifest: unknown;
  page_id: string;
};

const MAC_RUN_COLUMNS = `${RUN_COLUMNS}, t.base_revision, t.generation, t.operation_id, t.settings, t.audio_manifest, t.page_id, t.owner`;
const FIND_MAC_OPERATION_SQL = `SELECT ${MAC_RUN_COLUMNS} FROM transcription_runs AS t WHERE t.owner = $1 AND t.operation_id = $2 AND t.executor IN ('mac-cli', 'mac-local')`;
// $1 owner / $2 page id / $3 language / $4 terms / $5 target tab / $6 base revision（タブの revision）/ $7 operation / $8 settings / $9 manifest
const INSERT_MAC_RUN_SQL = `
INSERT INTO transcription_runs AS t
  (owner, page_id, engine, executor, status, language, diarize, replace, terms, target_tab, base_revision,
   generation, operation_id, settings, audio_manifest, started_at)
VALUES ($1, $2, 'gemini-cli', 'mac-cli', 'running', $3, true, false, $4::jsonb, $5::uuid, $6,
        1, $7::uuid, $8::jsonb, $9::jsonb, clock_timestamp())
RETURNING ${MAC_RUN_COLUMNS}`;

function macRun(row: MacRunRow): MacTranscriptionRun {
  return {
    run: toView(row),
    generation: row.generation,
    operationId: row.operation_id,
    settings: MAC_CLI_TRANSCRIPTION_SETTINGS,
    audioManifest: row.audio_manifest as MacAudioManifestPart[],
    tab: row.target_tab,
  };
}

const INSERT_MAC_LOCAL_RUN_SQL = `
INSERT INTO transcription_runs AS t
  (owner, page_id, engine, executor, status, language, diarize, replace, terms, target_tab, base_revision,
   generation, operation_id, settings, audio_manifest, started_at)
VALUES ($1, $2, 'apple-local', 'mac-local', 'running', $3, true, false, $4::jsonb, $5::uuid, $6,
        1, $7::uuid, $8::jsonb, $9::jsonb, clock_timestamp())
RETURNING ${MAC_RUN_COLUMNS}`;

function macLocalRun(row: MacRunRow): MacLocalTranscriptionRun {
  return {
    run: toView(row),
    generation: row.generation,
    operationId: row.operation_id,
    settings: MAC_LOCAL_TRANSCRIPTION_SETTINGS,
    audioManifest: row.audio_manifest as MacAudioManifestPart[],
    tab: row.target_tab,
  };
}

/**
 * Mac CLI の run を running で作る。既存 server run と同じ録音 lock / active unique indexを使うが、taskへは積まない。
 * operationId の再送は同じ page の同じ run を返し、別 page への使い回しは拒否する。
 */
export async function startMacTranscription(
  pool: Connectable,
  owner: OwnerId,
  pageId: string,
  input: MacTranscriptionStartInput,
): Promise<StartMacTranscriptionResult | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  if (!isPageId(input.operationId)) throw new TypeError("editor-store: operation id must be a UUID");
  if (input.language !== undefined && input.language !== "ja" && input.language !== "en") throw new TypeError("editor-store: language must be ja or en");
  if (!Array.isArray(input.terms) || input.terms.length > TRANSCRIPTION_TERMS_MAX || !input.terms.every(isTranscriptionTerm)) {
    throw new TypeError("editor-store: terms are not valid");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const prior = (await client.query<MacRunRow>(FIND_MAC_OPERATION_SQL, [owner, input.operationId])).rows[0];
      if (prior) {
        if (prior.page_id === pageId && !(await client.query<LockRow>(LOCK_RECORDING_SQL, [owner, pageId])).rows[0]) {
          await rollback(client);
          return null;
        }
        await rollback(client);
        return prior.page_id === pageId && prior.executor === "mac-cli" ? { status: "existing", ...macRun(prior) } : { status: "operation_conflict" };
      }
      const recording = (await client.query<LockRow>(LOCK_RECORDING_SQL, [owner, pageId])).rows[0];
      if (!recording) {
        await rollback(client);
        return null;
      }
      // 同じoperationが録音lockを待つ間に作られた場合も、競合ではなく同じrunを返す。
      const concurrent = (await client.query<MacRunRow>(FIND_MAC_OPERATION_SQL, [owner, input.operationId])).rows[0];
      if (concurrent) {
        await rollback(client);
        return concurrent.page_id === pageId && concurrent.executor === "mac-cli" ? { status: "existing", ...macRun(concurrent) } : { status: "operation_conflict" };
      }
      if (recording.audio_status !== "uploaded" || recording.parts_uploading) {
        await rollback(client);
        return { status: "audio_not_ready" };
      }
      if (recording.expired || recording.parts_expired) {
        await rollback(client);
        return { status: "audio_expired" };
      }
      if (await activeRun(client, owner, pageId)) {
        await rollback(client);
        return { status: "other_run_active" };
      }
      const parts = await listAudioParts(client, owner, pageId);
      if (parts.length === 0 || parts.some((part) => part.status !== "uploaded")) {
        await rollback(client);
        return { status: "audio_not_ready" };
      }
      const manifest = audioManifest(parts);
      // 書き先: 「文字起こし」ページの新しいタブ（#310）
      const home = await ensureRecordingFolder(client, owner, pageId);
      if (!home) {
        await rollback(client);
        return null;
      }
      const language = input.language ?? recording.language;
      const { tab } = await createTranscriptTab(client, owner, home, { engine: "gemini-cli", language, durationSec: recording.duration_sec });
      const inserted = await client.query<MacRunRow>(INSERT_MAC_RUN_SQL, [
        owner,
        pageId,
        language,
        JSON.stringify([...input.terms]),
        tab,
        1,
        input.operationId,
        JSON.stringify(MAC_CLI_TRANSCRIPTION_SETTINGS),
        JSON.stringify(manifest),
      ]);
      const row = inserted.rows[0];
      if (!row) throw new Error("editor-store: insert returned no Mac transcription run");
      await client.query("COMMIT");
      return { status: "created", ...macRun(row) };
    } catch (error) {
      await rollback(client);
      if (typeof error === "object" && error !== null &&
        (error as { code?: unknown }).code === "23505" &&
        (error as { constraint?: unknown }).constraint === "transcription_runs_mac_operation_idx") {
        const prior = (await client.query<MacRunRow>(FIND_MAC_OPERATION_SQL, [owner, input.operationId])).rows[0];
        if (prior) return prior.page_id === pageId && prior.executor === "mac-cli" ? { status: "existing", ...macRun(prior) } : { status: "operation_conflict" };
      }
      if (isInvalidTextRepresentation(error)) return null;
      throw error;
    }
  } finally {
    client.release();
  }
}

/** Apple 端末内認識の run を running で作る。Cloud Tasks には積まず、Mac 専用 route だけが確定する。 */
export async function startMacLocalTranscription(
  pool: Connectable,
  owner: OwnerId,
  pageId: string,
  input: MacLocalTranscriptionStartInput,
): Promise<StartMacLocalTranscriptionResult | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  if (!isPageId(input.operationId)) throw new TypeError("editor-store: operation id must be a UUID");
  if (input.language !== undefined && input.language !== "ja" && input.language !== "en") throw new TypeError("editor-store: language must be ja or en");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const recording = (await client.query<LockRow>(LOCK_RECORDING_SQL, [owner, pageId])).rows[0];
      if (!recording) {
        await rollback(client);
        return null;
      }
      // recording lock の内側で operation を照合する。同じページへの同時POST/応答消失後の再送は同じ run へ収束する。
      const prior = (await client.query<MacRunRow>(FIND_MAC_OPERATION_SQL, [owner, input.operationId])).rows[0];
      if (prior) {
        await rollback(client);
        return prior.page_id === pageId && prior.executor === "mac-local" ? { status: "existing", ...macLocalRun(prior) } : { status: "operation_conflict" };
      }
      if (recording.audio_status !== "uploaded" || recording.parts_uploading) {
        await rollback(client);
        return { status: "audio_not_ready" };
      }
      if (recording.expired || recording.parts_expired) {
        await rollback(client);
        return { status: "audio_expired" };
      }
      if (await activeRun(client, owner, pageId)) {
        await rollback(client);
        return { status: "other_run_active" };
      }
      const parts = await listAudioParts(client, owner, pageId);
      if (parts.length === 0 || parts.some((part) => part.status !== "uploaded")) {
        await rollback(client);
        return { status: "audio_not_ready" };
      }
      // 書き先: 「文字起こし」ページの新しいタブ（#310）
      const home = await ensureRecordingFolder(client, owner, pageId);
      if (!home) {
        await rollback(client);
        return null;
      }
      const language = input.language ?? recording.language;
      const { tab } = await createTranscriptTab(client, owner, home, { engine: "apple-local", language, durationSec: recording.duration_sec });
      const inserted = await client.query<MacRunRow>(INSERT_MAC_LOCAL_RUN_SQL, [
        owner,
        pageId,
        language,
        JSON.stringify([]),
        tab,
        1,
        input.operationId,
        JSON.stringify(MAC_LOCAL_TRANSCRIPTION_SETTINGS),
        JSON.stringify(audioManifest(parts)),
      ]);
      const row = inserted.rows[0];
      if (!row) throw new Error("editor-store: insert returned no Mac local transcription run");
      await client.query("COMMIT");
      return { status: "created", ...macLocalRun(row) };
    } catch (error) {
      await rollback(client);
      if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505") {
        const prior = (await client.query<MacRunRow>(FIND_MAC_OPERATION_SQL, [owner, input.operationId])).rows[0];
        if (prior) return prior.page_id === pageId && prior.executor === "mac-local" ? { status: "existing", ...macLocalRun(prior) } : { status: "operation_conflict" };
      }
      if (isInvalidTextRepresentation(error)) return null;
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * 再開できるか: 書き先のタブ（#310）が生きていて、開始のときから直されていない（revision が同じ）。
 * 書き先の無い古い run は、録音の正本が開始のときから変わっていないこと。
 */
async function targetUnchanged(client: Pick<PoolClient, "query">, owner: OwnerId, row: MacRunRow): Promise<boolean> {
  if (row.target_tab !== null) {
    const current = (await client.query<{ revision: number }>(TAB_REVISION_SQL, [owner, row.target_tab])).rows[0];
    return current !== undefined && current.revision === row.base_revision;
  }
  const recording = (await client.query<LockRow>(LOCK_RECORDING_SQL, [owner, row.page_id])).rows[0];
  return recording !== undefined && recording.base_revision === row.base_revision;
}

const RESUME_MAC_SQL = `
UPDATE transcription_runs AS t
   SET status = 'running', error_code = NULL, generation = t.generation + 1,
       started_at = clock_timestamp(), finished_at = NULL
 WHERE t.id = $1 AND t.owner = $2 AND t.operation_id = $3 AND t.generation = $4
   AND t.executor = 'mac-cli' AND t.status = 'failed'
RETURNING ${MAC_RUN_COLUMNS}`;

/** 停止・CLI失敗後の同じrunを、同じ音声集合・設定のまま次の世代で再開する。 */
export async function resumeMacTranscription(
  pool: Connectable,
  owner: OwnerId,
  pageId: string,
  runId: string,
  operationId: string,
  generation: number,
): Promise<MacTranscriptionRun | null> {
  assertOwner(owner);
  if (![pageId, runId, operationId].every(isPageId) || !Number.isSafeInteger(generation) || generation < 1) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const row = (await client.query<MacRunRow>(`SELECT ${MAC_RUN_COLUMNS} FROM transcription_runs AS t WHERE t.id = $1 FOR UPDATE`, [runId])).rows[0];
      if (!row || row.owner !== owner || row.page_id !== pageId || row.operation_id !== operationId || row.generation !== generation) {
        await rollback(client);
        return null;
      }
      if (row.status === "running") {
        await rollback(client);
        return macRun(row);
      }
      if (row.status !== "failed" || row.executor !== "mac-cli" || !sameMacSettings(row.settings)) {
        await rollback(client);
        return null;
      }
      const recording = (await client.query<LockRow>(LOCK_RECORDING_SQL, [owner, pageId])).rows[0];
      if (!recording || recording.audio_status !== "uploaded" || recording.parts_uploading || recording.expired || recording.parts_expired) {
        await rollback(client);
        return null;
      }
      if (!(await targetUnchanged(client, owner, row))) {
        await rollback(client);
        return null;
      }
      if (!sameManifest(row.audio_manifest, audioManifest(await listAudioParts(client, owner, pageId)))) {
        await rollback(client);
        return null;
      }
      if (await activeRun(client, owner, pageId)) {
        await rollback(client);
        return null;
      }
      const resumed = (await client.query<MacRunRow>(RESUME_MAC_SQL, [runId, owner, operationId, generation])).rows[0];
      if (!resumed) {
        await rollback(client);
        return null;
      }
      await client.query("COMMIT");
      return macRun(resumed);
    } catch (error) {
      await rollback(client);
      throw error;
    }
  } finally {
    client.release();
  }
}

const RESUME_MAC_LOCAL_SQL = `
UPDATE transcription_runs AS t
   SET status = 'running', error_code = NULL, generation = t.generation + 1,
       started_at = clock_timestamp(), finished_at = NULL
 WHERE t.id = $1 AND t.owner = $2 AND t.operation_id = $3 AND t.generation = $4
   AND t.executor = 'mac-local' AND t.status = 'failed'
RETURNING ${MAC_RUN_COLUMNS}`;

/** 停止・端末内認識失敗後の同じ run を、同じ音声集合・設定のまま次の世代で再開する。 */
export async function resumeMacLocalTranscription(
  pool: Connectable,
  owner: OwnerId,
  pageId: string,
  runId: string,
  operationId: string,
  generation: number,
): Promise<MacLocalTranscriptionRun | null> {
  assertOwner(owner);
  if (![pageId, runId, operationId].every(isPageId) || !Number.isSafeInteger(generation) || generation < 1) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const row = (await client.query<MacRunRow>(`SELECT ${MAC_RUN_COLUMNS} FROM transcription_runs AS t WHERE t.id = $1 FOR UPDATE`, [runId])).rows[0];
      if (!row || row.owner !== owner || row.page_id !== pageId || row.operation_id !== operationId || row.generation !== generation || row.executor !== "mac-local") {
        await rollback(client);
        return null;
      }
      if (row.status === "running") {
        await rollback(client);
        return macLocalRun(row);
      }
      if (row.status !== "failed" || !sameMacLocalSettings(row.settings)) {
        await rollback(client);
        return null;
      }
      const recording = (await client.query<LockRow>(LOCK_RECORDING_SQL, [owner, pageId])).rows[0];
      if (!recording || recording.audio_status !== "uploaded" || recording.parts_uploading || recording.expired || recording.parts_expired) {
        await rollback(client);
        return null;
      }
      if (!(await targetUnchanged(client, owner, row))) {
        await rollback(client);
        return null;
      }
      if (!sameManifest(row.audio_manifest, audioManifest(await listAudioParts(client, owner, pageId))) || await activeRun(client, owner, pageId)) {
        await rollback(client);
        return null;
      }
      const resumed = (await client.query<MacRunRow>(RESUME_MAC_LOCAL_SQL, [runId, owner, operationId, generation])).rows[0];
      if (!resumed) {
        await rollback(client);
        return null;
      }
      await client.query("COMMIT");
      return macLocalRun(resumed);
    } catch (error) {
      await rollback(client);
      throw error;
    }
  } finally {
    client.release();
  }
}

type ClaimRow = RunRow & { owner: string; page_id: string; diarize: boolean; replace: boolean; terms: unknown; generation: number };

// queued の run だけを running にして世代を 1 つ進める（同時に何本来ても 1 本だけが通る）。$1 run id。
const CLAIM_SQL = `
UPDATE transcription_runs AS t
   SET status = 'running',
       generation = t.generation + 1,
       started_at = GREATEST(clock_timestamp(), t.created_at)
 WHERE t.id = $1 AND t.status = 'queued' AND t.executor = 'server'
RETURNING ${RUN_COLUMNS}, t.owner, t.page_id, t.diarize, t.replace, t.terms, t.generation`;

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
    await db.query(FAIL_SERVER_SQL, [runId, row.generation, "internal"]).catch(() => undefined);
    throw error;
  }
  return {
    run: { ...toView(row), engine: row.engine as TranscriptionEngineName, executor: "server", owner: row.owner, pageId: row.page_id, diarize: row.diarize, replace: row.replace, terms, tab: row.target_tab },
    generation: row.generation,
    audio,
    parts,
  };
}

type FinishLockRow = {
  base_revision: number;
  owner: string;
  page_id: string;
  status: TranscriptionRunStatus;
  generation: number;
  replace: boolean;
  engine: TranscriptionLedgerEngineName;
  /** 書き先のタブ（#310。古い run は null＝正本）。 */
  target_tab: string | null;
  executor: "server" | "mac-cli" | "mac-local";
  operation_id: string | null;
  audio_manifest: unknown;
};

const LOCK_RUN_SQL = "SELECT owner, page_id, status, generation, replace, engine, target_tab, base_revision, executor, operation_id, audio_manifest FROM transcription_runs WHERE id = $1 FOR UPDATE";

// 録音の行を押さえる（run → 録音 の順に lock を取る。開始は録音の行だけを押さえて run の行を lock しないので、順が逆転しない）
const LOCK_SEGMENTS_SQL = `
SELECT jsonb_array_length(segments) > 0 AS has_segments, revision AS current_revision
  FROM page_recordings
 WHERE owner = $1 AND page_id = $2
   FOR UPDATE`;

const LOCK_ACTIVE_PAGE_SQL = `
SELECT 1
  FROM pages
 WHERE owner = $1 AND id = $2 AND deleted_at IS NULL
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
const FAIL_SERVER_SQL = `
UPDATE transcription_runs
   SET status = 'failed',
       error_code = $3,
       finished_at = GREATEST(clock_timestamp(), COALESCE(started_at, created_at))
 WHERE id = $1 AND generation = $2 AND executor = 'server' AND status IN ('queued', 'running')`;

// Mac の確定 transaction 内部で、照合に失敗した同じ世代だけを終える。server worker の失敗口とは混ぜない。
const FAIL_MAC_INTERNAL_SQL = `
UPDATE transcription_runs
   SET status = 'failed',
       error_code = $3,
       finished_at = GREATEST(clock_timestamp(), COALESCE(started_at, created_at))
 WHERE id = $1 AND generation = $2 AND executor = $4 AND status = 'running'`;

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
 * - 書き先のタブがある run（#310）: そのタブ（page_transcripts）に段落・長さ・エンジンを書いて succeeded。タブが消えた・開始後に
 *   直されていた（revision が進んだ）なら書かずに failed（superseded）
 * - 古い run（書き先なし）で開始時revisionと現在revisionが違う: replace指定でも書かずに run を failed（internal）にする（superseded）
 * - それ以外の古い run: page_recordings の段落・話者名（空）・エンジン・長さを書いて revision を 1 進め、ページの更新時刻も進め、run を succeeded にする
 * 世代が違う・running でない・不正な id は何もしない（stale）。結果の形が規則に合わなければ InvalidRecordingError（何も書かない）。
 */
type MacFinishGuard = { owner: OwnerId; pageId: string; operationId: string; executor: "mac-cli" | "mac-local" };

async function finishRunChecked(
  pool: Connectable,
  runId: string,
  generation: number,
  output: TranscriptionOutput,
  mac: MacFinishGuard | null,
): Promise<FinishTranscriptionResult> {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError("editor-store: generation must be a positive integer");
  const clean = cleanOutput(output);
  if (typeof runId !== "string" || !isPageId(runId)) return "stale";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const run = (await client.query<FinishLockRow>(LOCK_RUN_SQL, [runId])).rows[0];
      if (
        mac && run?.status === "succeeded" && run.generation === generation && run.executor === mac.executor &&
        run.owner === mac.owner && run.page_id === mac.pageId && run.operation_id === mac.operationId
      ) {
        // 保存応答だけ失われた再送。本文は再反映せず、同じ成功を返す。
        await rollback(client);
        return "succeeded";
      }
      if (!run || run.status !== "running" || run.generation !== generation) {
        await rollback(client);
        return "stale";
      }
      let macRecording: LockRow | null = null;
      if (mac) {
        if (run.executor !== mac.executor || run.owner !== mac.owner || run.page_id !== mac.pageId || run.operation_id !== mac.operationId) {
          await rollback(client);
          return "stale";
        }
        macRecording = (await client.query<LockRow>(LOCK_RECORDING_SQL, [run.owner, run.page_id])).rows[0] ?? null;
        const pageExists = macRecording && (await client.query(LOCK_ACTIVE_PAGE_SQL, [run.owner, run.page_id])).rowCount === 1;
        if (!macRecording || !pageExists) {
          await client.query(FAIL_MAC_INTERNAL_SQL, [runId, generation, "internal", mac.executor]);
          await client.query("COMMIT");
          return "superseded";
        }
        const current = audioManifest(await listAudioParts(client, run.owner, run.page_id));
        if (!sameManifest(run.audio_manifest, current)) {
          await client.query(FAIL_MAC_INTERNAL_SQL, [runId, generation, "internal", mac.executor]);
          await client.query("COMMIT");
          return "superseded";
        }
      } else if (run.executor !== "server") {
        // worker 側の確定口から Mac run を触らない。
        await rollback(client);
        return "stale";
      }
      const serverRecording = mac
        ? null
        : (await client.query<{ has_segments: boolean; current_revision: number }>(LOCK_SEGMENTS_SQL, [run.owner, run.page_id])).rows[0] ?? null;
      if (!mac && (!serverRecording || (await client.query(LOCK_ACTIVE_PAGE_SQL, [run.owner, run.page_id])).rowCount !== 1)) {
        await client.query(FAIL_SERVER_SQL, [runId, generation, "internal"]);
        await client.query("COMMIT");
        return "superseded";
      }
      if (run.target_tab !== null) {
        // 書き先のタブ（#310）に書く。正本（page_recordings）には触らない
        const written = await writeTranscriptSegments(client, run.owner, run.target_tab, run.base_revision, { segments: clean.segments, durationSec: clean.durationSec, engine: run.engine });
        if (written !== "written") {
          // タブが消えた、または開始後に直された: 遅れて届いた結果を書かずに失敗にする
          await client.query(mac ? FAIL_MAC_INTERNAL_SQL : FAIL_SERVER_SQL, mac ? [runId, generation, "internal", mac.executor] : [runId, generation, "internal"]);
          await client.query("COMMIT");
          return "superseded";
        }
        await client.query(TOUCH_PAGE_SQL, [run.owner, run.page_id]);
        const finished = await client.query(SUCCEED_SQL, [runId, generation]);
        if (finished.rowCount !== 1) throw new Error("editor-store: transcription run disappeared");
        await client.query("COMMIT");
        return "succeeded";
      }
      const recording = mac
        ? macRecording && { has_segments: macRecording.has_segments, current_revision: macRecording.base_revision }
        : serverRecording;
      if (!recording || recording.current_revision !== run.base_revision || (recording.has_segments && !run.replace)) {
        // 開始後に録音・段落が変わった（または録音が無くなった）: replace指定でも利用者の編集を上書きしない
        await client.query(mac ? FAIL_MAC_INTERNAL_SQL : FAIL_SERVER_SQL, mac ? [runId, generation, "internal", mac.executor] : [runId, generation, "internal"]);
        await client.query("COMMIT");
        return "superseded";
      }
      await client.query("SELECT set_config('niho.recording_candidate_reason', 'asr', true)");
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

export function finishRun(pool: Connectable, runId: string, generation: number, output: TranscriptionOutput): Promise<FinishTranscriptionResult> {
  return finishRunChecked(pool, runId, generation, output, null);
}

/** 本人の同一 operation だけが Mac run を確定できる。 */
export function finishMacTranscription(
  pool: Connectable,
  owner: OwnerId,
  pageId: string,
  runId: string,
  operationId: string,
  generation: number,
  output: TranscriptionOutput,
): Promise<FinishTranscriptionResult> {
  assertOwner(owner);
  if (!isPageId(pageId) || !isPageId(operationId)) return Promise.resolve("stale");
  return finishRunChecked(pool, runId, generation, output, { owner, pageId, operationId, executor: "mac-cli" });
}

/** 本人の同一 operation だけが Apple 端末内認識 run を確定できる。 */
export function finishMacLocalTranscription(
  pool: Connectable,
  owner: OwnerId,
  pageId: string,
  runId: string,
  operationId: string,
  generation: number,
  output: TranscriptionOutput,
): Promise<FinishTranscriptionResult> {
  assertOwner(owner);
  if (!isPageId(pageId) || !isPageId(operationId)) return Promise.resolve("stale");
  return finishRunChecked(pool, runId, generation, output, { owner, pageId, operationId, executor: "mac-local" });
}

/**
 * 実行の失敗。世代が一致して running のとき（または世代 0 で、まだ claim されていない queued のとき）だけ failed にする。
 * 失敗にしたら true、何もしなかったら false（掃除・別の実行のあと・不正な id）。
 */
export async function failRun(db: Queryable, runId: string, generation: number, errorCode: TranscriptionErrorCode): Promise<boolean> {
  if (!isTranscriptionErrorCode(errorCode)) throw new TypeError("editor-store: unknown transcription error code");
  if (!Number.isSafeInteger(generation) || generation < 0) throw new TypeError("editor-store: generation must be a non-negative integer");
  if (typeof runId !== "string" || !isPageId(runId)) return false;
  const result = await db.query(FAIL_SERVER_SQL, [runId, generation, errorCode]);
  return result.rowCount === 1;
}

const FAIL_MAC_SQL = `
UPDATE transcription_runs
   SET status = 'failed', error_code = $6,
       finished_at = GREATEST(clock_timestamp(), COALESCE(started_at, created_at))
 WHERE id = $1 AND owner = $2 AND page_id = $3 AND operation_id = $4 AND generation = $5
   AND executor = $7 AND status = 'running'`;

/** Mac からの停止・失敗。owner / page / operation / generation が一致する実行中の行だけを終える。 */
export async function failMacTranscription(
  db: Queryable,
  owner: OwnerId,
  pageId: string,
  runId: string,
  operationId: string,
  generation: number,
  errorCode: TranscriptionErrorCode,
): Promise<boolean> {
  assertOwner(owner);
  if (!isPageId(pageId) || !isPageId(runId) || !isPageId(operationId) || !Number.isSafeInteger(generation) || generation < 1 || !isTranscriptionErrorCode(errorCode)) return false;
  const result = await db.query(FAIL_MAC_SQL, [runId, owner, pageId, operationId, generation, errorCode, "mac-cli"]);
  return result.rowCount === 1;
}

/** Apple 端末内認識からの停止・失敗。正確な owner / page / operation / generation だけを終える。 */
export async function failMacLocalTranscription(
  db: Queryable,
  owner: OwnerId,
  pageId: string,
  runId: string,
  operationId: string,
  generation: number,
  errorCode: TranscriptionErrorCode,
): Promise<boolean> {
  assertOwner(owner);
  if (!isPageId(pageId) || !isPageId(runId) || !isPageId(operationId) || !Number.isSafeInteger(generation) || generation < 1 || !isTranscriptionErrorCode(errorCode)) return false;
  const result = await db.query(FAIL_MAC_SQL, [runId, owner, pageId, operationId, generation, errorCode, "mac-local"]);
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
     WHERE x.owner = r.owner AND x.page_id = r.page_id AND x.executor = 'server'
     ORDER BY x.created_at DESC, x.id DESC
     LIMIT 1
  ) AS t ON true
 WHERE r.owner = $1 AND r.page_id = $2 AND p.deleted_at IS NULL`;

// 本人の・ゴミ箱でないタブに書く最新の run（server・Mac とも）。$1 owner / $2 tab id。
const TAB_RUN_SQL = `
SELECT ${RUN_COLUMNS}
  FROM transcription_runs AS t
  JOIN pages AS p ON p.owner = t.owner AND p.id = t.target_tab
 WHERE t.owner = $1 AND t.target_tab = $2 AND p.deleted_at IS NULL
 ORDER BY t.created_at DESC, t.id DESC
 LIMIT 1`;

/** 文字起こしのタブ（#310）に書く最新の run（server・Mac とも）。無ければ null（run の無いタブ・別の人・消えたタブ）。 */
export async function tabRun(db: Queryable, owner: OwnerId, tabId: string): Promise<TranscriptionRunView | null> {
  assertOwner(owner);
  if (typeof tabId !== "string" || !isPageId(tabId)) return null;
  const row = (await db.query<RunRow>(TAB_RUN_SQL, [owner, tabId])).rows[0];
  return row ? toView(row) : null;
}

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

const MAC_STATUS_SQL = `
SELECT ${MAC_RUN_COLUMNS}
  FROM page_recordings AS r
  JOIN pages AS p ON p.owner = r.owner AND p.id = r.page_id
  JOIN LATERAL (
    SELECT * FROM transcription_runs AS x
     WHERE x.owner = r.owner AND x.page_id = r.page_id AND x.executor = 'mac-cli'
     ORDER BY x.created_at DESC, x.id DESC LIMIT 1
  ) AS t ON true
 WHERE r.owner = $1 AND r.page_id = $2 AND p.deleted_at IS NULL`;

/** 本人の最新 Mac run。operation は本人にだけ返り、別 owner / 削除済みページでは見えない。 */
export async function macTranscriptionStatus(db: Queryable, owner: OwnerId, pageId: string): Promise<MacTranscriptionRun | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  try {
    const row = (await db.query<MacRunRow>(MAC_STATUS_SQL, [owner, pageId])).rows[0];
    return row ? macRun(row) : null;
  } catch (error) {
    if (isInvalidTextRepresentation(error)) return null;
    throw error;
  }
}

const MAC_LOCAL_STATUS_SQL = `
SELECT ${MAC_RUN_COLUMNS}
  FROM page_recordings AS r
  JOIN pages AS p ON p.owner = r.owner AND p.id = r.page_id
  JOIN LATERAL (
    SELECT * FROM transcription_runs AS x
     WHERE x.owner = r.owner AND x.page_id = r.page_id AND x.executor = 'mac-local'
     ORDER BY x.created_at DESC, x.id DESC LIMIT 1
  ) AS t ON true
 WHERE r.owner = $1 AND r.page_id = $2 AND p.deleted_at IS NULL`;

/** 本人の最新 Apple 端末内認識 run。別 owner / 削除済みページでは見えない。 */
export async function macLocalTranscriptionStatus(db: Queryable, owner: OwnerId, pageId: string): Promise<MacLocalTranscriptionRun | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  try {
    const row = (await db.query<MacRunRow>(MAC_LOCAL_STATUS_SQL, [owner, pageId])).rows[0];
    return row ? macLocalRun(row) : null;
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
 WHERE executor = 'server'
   AND ((status = 'running' AND started_at < $1::timestamptz - make_interval(secs => $2::double precision))
    OR (status = 'queued' AND created_at < $1::timestamptz - make_interval(secs => $2::double precision)))
RETURNING id`;

/** 積み直しの対象（queued の run。世代は task の名前に入れる）。 */
export type QueuedTranscriptionRun = { id: string; generation: number };

/** $1 olderThan / $2 limit。transcription_runs_queued_idx（0014）の並び。 */
const LIST_QUEUED_SQL = `
SELECT id, generation
  FROM transcription_runs
 WHERE status = 'queued' AND executor = 'server' AND created_at < $1::timestamptz
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
 WHERE id = $1 AND generation = $2 AND status = 'queued' AND executor = 'server'
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
