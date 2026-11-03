import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import {
  CONTROL_CHARACTERS,
  GET_SQL,
  InvalidRecordingError,
  RECORDING_ENGINE_MAX_CHARS,
  TOUCH_PAGE_SQL,
  assertOwner,
  charCount,
  isInvalidTextRepresentation,
  isStorableText,
  recordingDataProblem,
  rollback,
  toRecording,
  type Connectable,
  type Recording,
  type RecordingRow,
  type RecordingSegment,
} from "./recordings.ts";
import { isPageId } from "./store.ts";
import type { OwnerId, PageLang, Queryable } from "./types.ts";

/**
 * 文字起こしの案（#36 段 3b-4。migrations/20261101013351_recording_audio_parts_and_candidates.sql）。
 * 旧 NIHO docs の candidateSets の工程 1（`source`）に当たる: **同じ音声を別のエンジンで起こして見比べ、採用する案を選ぶ**。
 *
 * - 採用中の案（adopted）の本文が page_recordings.segments に入っている（正本は 1 つ。画面が直すのはそこ）。
 * - 2 つ目の案を作るときに、いまの文字起こしを 1 つ目の案として台帳に載せる（旧版の addCandidate と同じ。本文を失わせない）。
 * - 段落・話者名・長さは案ごとに持つ（エンジンごとに話者の番号の付け方が違うため。旧版の「話者名が版ごと」に当たる）。
 * - 採用を切り替えるときは、まず画面で直した今の本文を**採用中の案に書き戻し**、それから選んだ案を正本に写す（直した文章を失わせない）。
 * - 案の状態（作っている・できた・失敗した）は列に持たず、有効な run（queued・running）と段落の有無から決める
 *   （実行の表と二重に持たない）。
 * - 要らなくなった案は消せる（採用中の案と、実行が走っている案は消せない）。
 * 読み書きは全て本人の・ゴミ箱でないページだけ（別の人・存在しない・不正な id・削除済み・録音の無いページは null）。
 */

/** 1 ページに持てる案の数。 */
export const RECORDING_CANDIDATES_MAX = 8;
/** 案の名前の文字数の上限（音声と案の migration の CHECK と同じ）。 */
export const RECORDING_CANDIDATE_NAME_MAX_CHARS = 60;
/** current を含めて候補ごとに保持する版の上限。 */
export const RECORDING_CANDIDATE_VERSION_LIMIT = 100;
/** 冪等 operation receipt の候補ごとの保持上限。 */
const RECORDING_CANDIDATE_OPERATION_LIMIT = 200;

/** 案の状態（列には持たず、run と段落の有無から決める）。 */
export type RecordingCandidateState = "pending" | "ready" | "failed";

/** 一覧に出す案（本文は持たない。段落の数と先頭の数行だけ）。 */
export type RecordingCandidateView = {
  id: string;
  /** 名前・本文・話者名・文字起こしメタデータの単調増加 CAS。adopted の切替だけでは進まない。 */
  revision: number;
  name: string;
  /** 作ったエンジン（分からない案は null）。 */
  engine: string | null;
  language: PageLang;
  durationSec: number | null;
  /** 採用中（この案の本文が正本に入っている）。 */
  adopted: boolean;
  state: RecordingCandidateState;
  /** この録音ページで生成が走っている。編集・復元・採用は完了まで拒否する。 */
  busy: boolean;
  segmentCount: number;
  /** 見比べるための先頭の数行（本文の全部は getRecordingCandidate で読む）。 */
  preview: string[];
  createdAt: string;
  updatedAt: string;
};

/** 1 つの案（本文つき）。 */
export type RecordingCandidate = RecordingCandidateView & { segments: RecordingSegment[]; speakerNames: Record<string, string> };

export type RecordingCandidateVersionReason = "initial" | "edit" | "recording" | "asr" | "restore";
export type RecordingCandidateVersionSummary = {
  version: number;
  reason: RecordingCandidateVersionReason;
  name: string;
  segmentCount: number;
  createdAt: string;
};
export type RecordingCandidateVersion = RecordingCandidateVersionSummary & {
  engine: string | null;
  language: PageLang;
  durationSec: number | null;
  segments: RecordingSegment[];
  speakerNames: Record<string, string>;
};

/** 一覧の先頭の数行（画面の見比べの最初の手がかり）。 */
const PREVIEW_SEGMENTS = 3;
const PREVIEW_CHARS = 120;

export type AddRecordingCandidateInput = {
  /** 新しい案の名前（1〜60 文字・前後に空白なし・制御文字なし）。 */
  name: string;
  /** 新しい案を作るエンジン。 */
  engine: string;
  /** 音声の言語。無ければ録音の言語。 */
  language?: PageLang;
  /** 1 つ目の案（いまの文字起こし）に付ける名前。台帳がまだ無いときだけ使う。 */
  primaryName: string;
};

export type AddRecordingCandidateResult =
  | { status: "created"; candidate: RecordingCandidateView; candidates: RecordingCandidateView[] }
  /** 案の数が上限（RECORDING_CANDIDATES_MAX）。 */
  | { status: "too_many" };

export type LockedRecordingCandidateSource = {
  language: PageLang;
  engine: string | null;
  duration_sec: number | null;
  segments: RecordingSegment[];
  speaker_names: Record<string, string>;
};

export type AdoptRecordingCandidateResult =
  | { status: "ok"; recording: Recording; candidates: RecordingCandidateView[] }
  | { status: "conflict"; recording: Recording; candidate: RecordingCandidate }
  | { status: "busy" }
  /** まだ本文ができていない案（作っている最中・失敗した）。 */
  | { status: "not_ready" };

export type UpdateRecordingCandidateInput = {
  expectedRevision: number;
  operationId: string;
  name?: string;
  segments?: readonly RecordingSegment[];
  speakerNames?: Readonly<Record<string, string>>;
};

export type UpdateRecordingCandidateResult =
  | { status: "ok"; candidate: RecordingCandidate; replayed: boolean }
  | { status: "conflict"; candidate: RecordingCandidate }
  | { status: "busy" }
  | { status: "adopted" }
  | { status: "operation_conflict" };

export type RestoreRecordingCandidateResult = UpdateRecordingCandidateResult | { status: "version_missing" };

export type AdoptRecordingCandidateInput = {
  expectedCandidateRevision: number;
  expectedRecordingRevision: number;
  operationId: string;
};

type CandidateRow = {
  id: string;
  revision: number;
  name: string;
  engine: string | null;
  language: PageLang;
  duration_sec: number | null;
  adopted: boolean;
  running: boolean;
  page_busy: boolean;
  segment_count: number;
  preview: string[] | null;
  created_at: Date;
  updated_at: Date;
};

function stateOf(row: Pick<CandidateRow, "running" | "segment_count">): RecordingCandidateState {
  if (row.running) return "pending";
  return row.segment_count > 0 ? "ready" : "failed";
}

function toView(row: CandidateRow): RecordingCandidateView {
  return {
    id: row.id,
    revision: row.revision,
    name: row.name,
    engine: row.engine,
    language: row.language,
    durationSec: row.duration_sec,
    adopted: row.adopted,
    state: stateOf(row),
    busy: row.page_busy,
    segmentCount: row.segment_count,
    preview: (row.preview ?? []).map((text) => Array.from(String(text)).slice(0, PREVIEW_CHARS).join("")),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// 本人の・ゴミ箱でないページの案（作った順）。$1 owner / $2 page id。
// 状態は、その案に有効な run があるか（running）と段落の数から読む側が決める。
const CANDIDATE_COLUMNS = `c.id, c.revision, c.name, c.engine, c.language, c.duration_sec::float8 AS duration_sec, c.adopted,
       EXISTS (
         SELECT 1 FROM transcription_runs AS t
          WHERE t.candidate = c.id AND t.status IN ('queued', 'running')
       ) AS running,
       EXISTS (
         SELECT 1 FROM transcription_runs AS active
          WHERE active.owner = c.owner AND active.page_id = c.page_id AND active.status IN ('queued', 'running')
       ) AS page_busy,
       jsonb_array_length(c.segments) AS segment_count,
       (
         SELECT array_agg(s.value ->> 'text' ORDER BY s.ordinality)
           FROM jsonb_array_elements(c.segments) WITH ORDINALITY AS s(value, ordinality)
          WHERE s.ordinality <= ${PREVIEW_SEGMENTS}
       ) AS preview,
       c.created_at, c.updated_at`;

const LIST_SQL = `
SELECT ${CANDIDATE_COLUMNS}
  FROM page_recording_candidates AS c
  JOIN pages AS p ON p.owner = c.owner AND p.id = c.page_id
 WHERE c.owner = $1 AND c.page_id = $2 AND p.deleted_at IS NULL
 ORDER BY c.created_at, c.id`;

const GET_CANDIDATE_SQL = `
SELECT ${CANDIDATE_COLUMNS}, c.segments, c.speaker_names
  FROM page_recording_candidates AS c
  JOIN pages AS p ON p.owner = c.owner AND p.id = c.page_id
 WHERE c.owner = $1 AND c.page_id = $2 AND c.id = $3 AND p.deleted_at IS NULL`;

/** 本人の・ゴミ箱でないページの案の一覧（作った順。案が無ければ空の配列）。 */
export async function listRecordingCandidates(db: Pick<PoolClient, "query">, owner: OwnerId, pageId: string): Promise<RecordingCandidateView[]> {
  assertOwner(owner);
  if (!isPageId(pageId)) return [];
  try {
    return (await db.query<CandidateRow>(LIST_SQL, [owner, pageId])).rows.map(toView);
  } catch (error) {
    if (isInvalidTextRepresentation(error)) return [];
    throw error;
  }
}

/** 1 つの案（本文つき）。無ければ null。 */
export async function getRecordingCandidate(db: Queryable, owner: OwnerId, pageId: string, candidateId: string): Promise<RecordingCandidate | null> {
  assertOwner(owner);
  if (!isPageId(pageId) || !isPageId(candidateId)) return null;
  try {
    const row = (await db.query<CandidateRow & { segments: RecordingSegment[]; speaker_names: Record<string, string> }>(GET_CANDIDATE_SQL, [owner, pageId, candidateId])).rows[0];
    if (!row) return null;
    return { ...toView(row), segments: row.segments, speakerNames: row.speaker_names };
  } catch (error) {
    if (isInvalidTextRepresentation(error)) return null;
    throw error;
  }
}

type CandidateVersionRow = {
  version: number;
  reason: RecordingCandidateVersionReason;
  name: string;
  engine: string | null;
  language: PageLang;
  duration_sec: number | null;
  segments: RecordingSegment[];
  speaker_names: Record<string, string>;
  segment_count: number;
  created_at: Date;
};

function toVersionSummary(row: CandidateVersionRow): RecordingCandidateVersionSummary {
  return { version: row.version, reason: row.reason, name: row.name, segmentCount: row.segment_count, createdAt: row.created_at.toISOString() };
}

const VERSION_COLUMNS = `v.version, v.reason, v.name, v.engine, v.language, v.duration_sec::float8 AS duration_sec,
       v.segments, v.speaker_names, jsonb_array_length(v.segments) AS segment_count, v.created_at`;

/** 候補の版（新しい順・current を含む最大 100 件）。候補が無ければ null。 */
export async function listRecordingCandidateVersions(
  db: Queryable,
  owner: OwnerId,
  pageId: string,
  candidateId: string,
): Promise<RecordingCandidateVersionSummary[] | null> {
  assertOwner(owner);
  if (!isPageId(pageId) || !isPageId(candidateId)) return null;
  try {
    const rows = await db.query<CandidateVersionRow>(
      `SELECT ${VERSION_COLUMNS}
         FROM page_recording_candidate_versions v
         JOIN page_recording_candidates c ON c.id = v.candidate_id
         JOIN pages p ON p.owner = c.owner AND p.id = c.page_id
        WHERE v.candidate_id = $1
          AND c.owner = $2 AND c.page_id = $3 AND p.deleted_at IS NULL
        ORDER BY v.version DESC
        LIMIT ${RECORDING_CANDIDATE_VERSION_LIMIT}`,
      [candidateId, owner, pageId],
    );
    // INSERT trigger と migration backfill により、存在する候補には必ず initial 版がある。
    return rows.rows.length > 0 ? rows.rows.map(toVersionSummary) : null;
  } catch (error) {
    if (isInvalidTextRepresentation(error)) return null;
    throw error;
  }
}

/** 候補の版 1 件（本文つき）。候補・版が無ければ同じ null。 */
export async function getRecordingCandidateVersion(
  db: Queryable,
  owner: OwnerId,
  pageId: string,
  candidateId: string,
  version: number,
): Promise<RecordingCandidateVersion | null> {
  assertOwner(owner);
  if (!isPageId(pageId) || !isPageId(candidateId) || !Number.isSafeInteger(version) || version < 1) return null;
  try {
    const row = (
      await db.query<CandidateVersionRow>(
        `SELECT ${VERSION_COLUMNS}
           FROM page_recording_candidate_versions v
           JOIN page_recording_candidates c ON c.id = v.candidate_id
           JOIN pages p ON p.owner = c.owner AND p.id = c.page_id
          WHERE c.owner = $1 AND c.page_id = $2 AND c.id = $3 AND v.version = $4 AND p.deleted_at IS NULL`,
        [owner, pageId, candidateId, version],
      )
    ).rows[0];
    return row
      ? {
          ...toVersionSummary(row),
          engine: row.engine,
          language: row.language,
          durationSec: row.duration_sec,
          segments: row.segments,
          speakerNames: row.speaker_names,
        }
      : null;
  } catch (error) {
    if (isInvalidTextRepresentation(error)) return null;
    throw error;
  }
}

function nameProblem(name: unknown): boolean {
  return (
    typeof name !== "string" ||
    name.length === 0 ||
    name !== name.trim() ||
    CONTROL_CHARACTERS.test(name) ||
    !isStorableText(name) ||
    charCount(name) > RECORDING_CANDIDATE_NAME_MAX_CHARS
  );
}

function assertAddInput(input: AddRecordingCandidateInput): void {
  if (nameProblem(input.name) || nameProblem(input.primaryName)) throw new InvalidRecordingError("name");
  if (typeof input.engine !== "string" || input.engine.length === 0 || charCount(input.engine) > RECORDING_ENGINE_MAX_CHARS || !isStorableText(input.engine)) {
    throw new InvalidRecordingError("engine");
  }
  if (input.language !== undefined && input.language !== "ja" && input.language !== "en") throw new InvalidRecordingError("lang");
}

// 本人の・ゴミ箱でないページの録音を押さえる（案の操作を直列にする）。$1 owner / $2 page id。
const LOCK_RECORDING_SQL = `
SELECT r.revision, r.language, r.engine, r.duration_sec::float8 AS duration_sec, r.segments, r.speaker_names
  FROM page_recordings AS r
  JOIN pages AS p ON p.owner = r.owner AND p.id = r.page_id
 WHERE r.owner = $1 AND r.page_id = $2 AND p.deleted_at IS NULL
   FOR UPDATE OF r`;

// $1 page id / $2 owner / $3 name / $4 engine / $5 language / $6 segments / $7 speaker names / $8 duration / $9 adopted
const INSERT_CANDIDATE_SQL = `
INSERT INTO page_recording_candidates
  (page_id, owner, name, engine, language, segments, speaker_names, duration_sec, adopted)
VALUES ($1, $2, $3::text, $4::text, $5::text, $6::jsonb, $7::jsonb, $8::numeric, $9::boolean)
RETURNING id`;

/** recording row を既に FOR UPDATE した transaction 内で使う候補作成の共通部。commit/rollback は呼び出し側が行う。 */
export async function addRecordingCandidateLocked(
  client: Pick<PoolClient, "query">,
  owner: OwnerId,
  pageId: string,
  recording: LockedRecordingCandidateSource,
  input: AddRecordingCandidateInput,
): Promise<{ status: "created"; candidateId: string } | { status: "too_many" }> {
  assertAddInput(input);
  const existing = await listRecordingCandidates(client, owner, pageId);
  if (existing.length + (existing.length === 0 ? 2 : 1) > RECORDING_CANDIDATES_MAX) return { status: "too_many" };
  if (existing.length === 0) {
    await client.query(INSERT_CANDIDATE_SQL, [
      pageId,
      owner,
      input.primaryName,
      recording.engine,
      recording.language,
      JSON.stringify(recording.segments),
      JSON.stringify(recording.speaker_names),
      recording.duration_sec,
      true,
    ]);
  }
  const inserted = await client.query<{ id: string }>(INSERT_CANDIDATE_SQL, [
    pageId,
    owner,
    input.name,
    input.engine,
    input.language ?? recording.language,
    "[]",
    "{}",
    null,
    false,
  ]);
  const candidateId = inserted.rows[0]?.id;
  if (!candidateId) throw new Error("editor-store: insert returned no candidate");
  await client.query(TOUCH_PAGE_SQL, [owner, pageId]);
  return { status: "created", candidateId };
}

/**
 * 別のエンジンの案を足す（旧版の addCandidate）。1 つの transaction で、台帳がまだ無ければ**いまの文字起こしを 1 つ目の案**
 * （採用中）として載せ、続けて新しい空の案を作る。本文は書かない（実行が入れる）。
 * - 本人の・ゴミ箱でないページの録音が無い: null / 案の数が上限: too_many
 * 形が規則に合わなければ InvalidRecordingError（何も書かない）。
 */
export async function addRecordingCandidate(
  pool: Connectable,
  owner: OwnerId,
  pageId: string,
  input: AddRecordingCandidateInput,
): Promise<AddRecordingCandidateResult | null> {
  assertOwner(owner);
  assertAddInput(input);
  if (!isPageId(pageId)) return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const recording = (
        await client.query<{ language: PageLang; engine: string | null; duration_sec: number | null; segments: RecordingSegment[]; speaker_names: Record<string, string> }>(
          LOCK_RECORDING_SQL,
          [owner, pageId],
        )
      ).rows[0];
      if (!recording) {
        await rollback(client);
        return null;
      }
      const added = await addRecordingCandidateLocked(client, owner, pageId, recording, input);
      if (added.status === "too_many") {
        await rollback(client);
        return { status: "too_many" };
      }
      await client.query("COMMIT");
      const candidates = await listRecordingCandidates(client, owner, pageId);
      const candidate = candidates.find((item) => item.id === added.candidateId);
      if (!candidate) throw new Error("editor-store: inserted candidate disappeared");
      return { status: "created", candidate, candidates };
    } catch (error) {
      await rollback(client);
      if (isInvalidTextRepresentation(error)) return null;
      throw error;
    }
  } finally {
    client.release();
  }
}

// 案の行を押さえる。$1 owner / $2 page id / $3 candidate id。
const LOCK_CANDIDATE_SQL = `
SELECT c.id, c.revision, c.name, c.engine, c.language, c.duration_sec::float8 AS duration_sec, c.adopted, c.segments, c.speaker_names,
       jsonb_array_length(c.segments) AS segment_count,
       EXISTS (
         SELECT 1 FROM transcription_runs active
          WHERE active.owner = c.owner AND active.page_id = c.page_id AND active.status IN ('queued', 'running')
       ) AS page_busy
  FROM page_recording_candidates AS c
  JOIN pages AS p ON p.owner = c.owner AND p.id = c.page_id
 WHERE c.owner = $1 AND c.page_id = $2 AND c.id = $3 AND p.deleted_at IS NULL
   FOR UPDATE OF c`;

type LockedCandidate = {
  id: string;
  revision: number;
  name: string;
  engine: string | null;
  language: PageLang;
  duration_sec: number | null;
  adopted: boolean;
  segments: RecordingSegment[];
  speaker_names: Record<string, string>;
  segment_count: number;
  page_busy: boolean;
};

function assertCandidateRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`editor-store: ${label} must be a positive integer`);
}

function operationHash(operation: "edit" | "restore" | "adopt", value: unknown): string {
  return createHash("sha256").update(JSON.stringify({ operation, value })).digest("hex");
}

async function operationReplay(
  client: Pick<PoolClient, "query">,
  candidateId: string,
  operationId: string,
  operation: "edit" | "restore" | "adopt",
  requestHash: string,
): Promise<"replay" | "conflict" | null> {
  const row = (
    await client.query<{ operation: string; request_hash: string }>(
      "SELECT operation, request_hash FROM page_recording_candidate_operations WHERE candidate_id = $1 AND operation_id = $2",
      [candidateId, operationId],
    )
  ).rows[0];
  if (!row) return null;
  return row.operation === operation && row.request_hash === requestHash ? "replay" : "conflict";
}

async function rememberOperation(
  client: Pick<PoolClient, "query">,
  candidateId: string,
  operationId: string,
  operation: "edit" | "restore" | "adopt",
  requestHash: string,
  resultRevision: number,
): Promise<void> {
  await client.query(
    `INSERT INTO page_recording_candidate_operations
       (candidate_id, operation_id, operation, request_hash, result_revision)
     VALUES ($1, $2, $3, $4, $5)`,
    [candidateId, operationId, operation, requestHash, resultRevision],
  );
  await client.query(
    `DELETE FROM page_recording_candidate_operations old
      WHERE old.candidate_id = $1
        AND (old.created_at, old.operation_id) NOT IN (
          SELECT keep.created_at, keep.operation_id
            FROM page_recording_candidate_operations keep
           WHERE keep.candidate_id = $1
           ORDER BY keep.created_at DESC, keep.operation_id DESC
           LIMIT ${RECORDING_CANDIDATE_OPERATION_LIMIT}
        )`,
    [candidateId],
  );
}

async function currentCandidate(
  client: Queryable,
  owner: OwnerId,
  pageId: string,
  candidateId: string,
): Promise<RecordingCandidate> {
  const candidate = await getRecordingCandidate(client, owner, pageId, candidateId);
  if (!candidate) throw new Error("editor-store: candidate disappeared while locked");
  return candidate;
}

/**
 * 候補を CAS 保存する。採用中候補は名前だけ変更でき、本文は page_recordings の既存 editor を正本とする。
 * 同じ operationId+内容の再送、または全内容が同じ保存は revision を増やさない。
 */
export async function updateRecordingCandidate(
  pool: Connectable,
  owner: OwnerId,
  pageId: string,
  candidateId: string,
  input: UpdateRecordingCandidateInput,
): Promise<UpdateRecordingCandidateResult | null> {
  assertOwner(owner);
  assertCandidateRevision(input.expectedRevision, "expected candidate revision");
  if (!isPageId(pageId) || !isPageId(candidateId)) return null;
  if (!isPageId(input.operationId)) throw new TypeError("editor-store: operation id must be a UUID");
  const hasName = input.name !== undefined;
  const hasSegments = input.segments !== undefined || input.speakerNames !== undefined;
  if (!hasName && !hasSegments) throw new InvalidRecordingError("body");
  if (hasName && nameProblem(input.name)) throw new InvalidRecordingError("name");
  if ((input.segments === undefined) !== (input.speakerNames === undefined)) throw new InvalidRecordingError("segments");
  if (input.segments !== undefined) {
    const problem = recordingDataProblem({ segments: input.segments, speakerNames: input.speakerNames });
    if (problem) throw new InvalidRecordingError(problem);
  }
  const requestHash = operationHash("edit", {
    expectedRevision: input.expectedRevision,
    name: input.name,
    segments: input.segments,
    speakerNames: input.speakerNames,
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      // 全候補 writer は recording → candidate の順で lock する。
      const recording = (await client.query(LOCK_RECORDING_SQL, [owner, pageId])).rows[0];
      if (!recording) {
        await rollback(client);
        return null;
      }
      const row = (await client.query<LockedCandidate>(LOCK_CANDIDATE_SQL, [owner, pageId, candidateId])).rows[0];
      if (!row) {
        await rollback(client);
        return null;
      }
      const replay = await operationReplay(client, candidateId, input.operationId, "edit", requestHash);
      if (replay === "conflict") {
        await rollback(client);
        return { status: "operation_conflict" };
      }
      if (replay === "replay") {
        const candidate = await currentCandidate(client, owner, pageId, candidateId);
        await rollback(client);
        return { status: "ok", candidate, replayed: true };
      }
      if (row.page_busy) {
        await rollback(client);
        return { status: "busy" };
      }
      if (row.revision !== input.expectedRevision) {
        const candidate = await currentCandidate(client, owner, pageId, candidateId);
        await rollback(client);
        return { status: "conflict", candidate };
      }
      if (row.adopted && input.segments !== undefined) {
        await rollback(client);
        return { status: "adopted" };
      }
      await client.query("SELECT set_config('niho.recording_candidate_reason', 'edit', true)");
      await client.query(
        `UPDATE page_recording_candidates
            SET name = $4, segments = $5::jsonb, speaker_names = $6::jsonb,
                updated_at = CASE
                  WHEN ROW(name, segments, speaker_names) IS DISTINCT FROM ROW($4::text, $5::jsonb, $6::jsonb)
                  THEN GREATEST(clock_timestamp(), updated_at) ELSE updated_at END
          WHERE owner = $1 AND page_id = $2 AND id = $3 AND revision = $7`,
        [
          owner,
          pageId,
          candidateId,
          input.name ?? row.name,
          JSON.stringify(input.segments ?? row.segments),
          JSON.stringify(input.speakerNames ?? row.speaker_names),
          input.expectedRevision,
        ],
      );
      const candidate = await currentCandidate(client, owner, pageId, candidateId);
      await rememberOperation(client, candidateId, input.operationId, "edit", requestHash, candidate.revision);
      if (candidate.revision !== row.revision) await client.query(TOUCH_PAGE_SQL, [owner, pageId]);
      await client.query("COMMIT");
      return { status: "ok", candidate, replayed: false };
    } catch (error) {
      await rollback(client);
      if (isInvalidTextRepresentation(error)) return null;
      throw error;
    }
  } finally {
    client.release();
  }
}

/** 旧版を新しい current revision として復元する。採用中本文は録音 editor が正本なので、別案へ切り替えるまで復元しない。 */
export async function restoreRecordingCandidateVersion(
  pool: Connectable,
  owner: OwnerId,
  pageId: string,
  candidateId: string,
  version: number,
  input: { expectedRevision: number; operationId: string },
): Promise<RestoreRecordingCandidateResult | null> {
  assertOwner(owner);
  assertCandidateRevision(input.expectedRevision, "expected candidate revision");
  if (!isPageId(pageId) || !isPageId(candidateId) || !Number.isSafeInteger(version) || version < 1) return null;
  if (!isPageId(input.operationId)) throw new TypeError("editor-store: operation id must be a UUID");
  const requestHash = operationHash("restore", { expectedRevision: input.expectedRevision, version });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      if (!(await client.query(LOCK_RECORDING_SQL, [owner, pageId])).rows[0]) {
        await rollback(client);
        return null;
      }
      const row = (await client.query<LockedCandidate>(LOCK_CANDIDATE_SQL, [owner, pageId, candidateId])).rows[0];
      if (!row) {
        await rollback(client);
        return null;
      }
      const replay = await operationReplay(client, candidateId, input.operationId, "restore", requestHash);
      if (replay === "conflict") {
        await rollback(client);
        return { status: "operation_conflict" };
      }
      if (replay === "replay") {
        const candidate = await currentCandidate(client, owner, pageId, candidateId);
        await rollback(client);
        return { status: "ok", candidate, replayed: true };
      }
      if (row.page_busy) {
        await rollback(client);
        return { status: "busy" };
      }
      if (row.revision !== input.expectedRevision) {
        const candidate = await currentCandidate(client, owner, pageId, candidateId);
        await rollback(client);
        return { status: "conflict", candidate };
      }
      if (row.adopted) {
        await rollback(client);
        return { status: "adopted" };
      }
      const saved = (
        await client.query<{
          name: string;
          engine: string | null;
          language: PageLang;
          duration_sec: number | null;
          segments: RecordingSegment[];
          speaker_names: Record<string, string>;
        }>(
          `SELECT name, engine, language, duration_sec::float8 AS duration_sec, segments, speaker_names
             FROM page_recording_candidate_versions
            WHERE candidate_id = $1 AND version = $2`,
          [candidateId, version],
        )
      ).rows[0];
      if (!saved) {
        await rollback(client);
        return { status: "version_missing" };
      }
      const problem = recordingDataProblem({ segments: saved.segments, speakerNames: saved.speaker_names, durationSec: saved.duration_sec });
      if (problem || nameProblem(saved.name)) throw new InvalidRecordingError(problem ?? "name");
      await client.query("SELECT set_config('niho.recording_candidate_reason', 'restore', true)");
      // 復元は、対象と現行の内容が偶然同じでも明示操作を immutable な新版として残す。
      await client.query("SELECT set_config('niho.recording_candidate_force_revision', 'true', true)");
      await client.query(
        `UPDATE page_recording_candidates
            SET name = $4, engine = $5::text, language = $6::text, duration_sec = $7::numeric,
                segments = $8::jsonb, speaker_names = $9::jsonb,
                updated_at = GREATEST(clock_timestamp(), updated_at)
          WHERE owner = $1 AND page_id = $2 AND id = $3 AND revision = $10`,
        [owner, pageId, candidateId, saved.name, saved.engine, saved.language, saved.duration_sec, JSON.stringify(saved.segments), JSON.stringify(saved.speaker_names), input.expectedRevision],
      );
      const candidate = await currentCandidate(client, owner, pageId, candidateId);
      await rememberOperation(client, candidateId, input.operationId, "restore", requestHash, candidate.revision);
      await client.query(TOUCH_PAGE_SQL, [owner, pageId]);
      await client.query("COMMIT");
      return { status: "ok", candidate, replayed: false };
    } catch (error) {
      await rollback(client);
      if (isInvalidTextRepresentation(error)) return null;
      throw error;
    }
  } finally {
    client.release();
  }
}

// 採用の印を付け替える。$1 owner / $2 page id / $3 candidate id
const CLEAR_ADOPTED_SQL = "UPDATE page_recording_candidates SET adopted = false WHERE owner = $1 AND page_id = $2 AND adopted";
const SET_ADOPTED_SQL = "UPDATE page_recording_candidates SET adopted = true WHERE owner = $1 AND page_id = $2 AND id = $3";

// 選んだ案を正本に写す。revision を進めるので、開いている画面の古い revision の書き込みは 409 になる。
// $1 owner / $2 page id / $3 segments / $4 speaker names / $5 engine / $6 duration / $7 expected recording revision
const WRITE_ADOPTED_SQL = `
UPDATE page_recordings AS r
   SET segments = $3::jsonb,
       speaker_names = $4::jsonb,
       engine = $5::text,
       duration_sec = $6::numeric,
       revision = r.revision + 1,
       updated_at = GREATEST(clock_timestamp(), r.updated_at)
 WHERE r.owner = $1 AND r.page_id = $2 AND r.revision = $7`;

/**
 * 選んだ案を採用する（正本に写す）。1 つの transaction で:
 * candidate revision と recording revision の両方を CAS し、採用印を先に付け替えてから選んだ本文を recording に写す。
 * recording → adopted candidate の DB trigger は新しい採用先だけを見るため、旧案を選択案の本文で上書きしない。
 * - その案が無い（別の人・存在しない・不正な id・削除済み）: null / 本文がまだ無い案: not_ready
 * 既に採用中の案を選んだときは本文を再反映せず成功（冪等）。
 */
export async function adoptRecordingCandidate(
  pool: Connectable,
  owner: OwnerId,
  pageId: string,
  candidateId: string,
  input: AdoptRecordingCandidateInput,
): Promise<AdoptRecordingCandidateResult | null> {
  assertOwner(owner);
  assertCandidateRevision(input.expectedCandidateRevision, "expected candidate revision");
  assertCandidateRevision(input.expectedRecordingRevision, "expected recording revision");
  if (!isPageId(pageId) || !isPageId(candidateId)) return null;
  if (!isPageId(input.operationId)) throw new TypeError("editor-store: operation id must be a UUID");
  const requestHash = operationHash("adopt", input);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      // 録音 → 案 の順に押さえる（ほかの操作と同じ順）
      const recording = (await client.query<{ revision: number }>(LOCK_RECORDING_SQL, [owner, pageId])).rows[0];
      if (!recording) {
        await rollback(client);
        return null;
      }
      const candidate = (
        await client.query<LockedCandidate>(LOCK_CANDIDATE_SQL, [owner, pageId, candidateId])
      ).rows[0];
      if (!candidate) {
        await rollback(client);
        return null;
      }
      const replay = await operationReplay(client, candidateId, input.operationId, "adopt", requestHash);
      if (replay === "conflict") {
        await rollback(client);
        const currentRecording = (await client.query<RecordingRow>(GET_SQL, [owner, pageId])).rows[0];
        if (!currentRecording) return null;
        return { status: "conflict", recording: toRecording(currentRecording), candidate: await currentCandidate(client, owner, pageId, candidateId) };
      }
      if (replay === "replay") {
        const saved = (await client.query<RecordingRow>(GET_SQL, [owner, pageId])).rows[0];
        if (!saved) throw new Error("editor-store: recording disappeared while replaying adoption");
        await rollback(client);
        return { status: "ok", recording: toRecording(saved), candidates: await listRecordingCandidates(client, owner, pageId) };
      }
      if (candidate.page_busy) {
        await rollback(client);
        return { status: "busy" };
      }
      if (candidate.revision !== input.expectedCandidateRevision || recording.revision !== input.expectedRecordingRevision) {
        const saved = (await client.query<RecordingRow>(GET_SQL, [owner, pageId])).rows[0];
        if (!saved) throw new Error("editor-store: recording disappeared while checking adoption");
        const current = await currentCandidate(client, owner, pageId, candidateId);
        await rollback(client);
        return { status: "conflict", recording: toRecording(saved), candidate: current };
      }
      if (candidate.segment_count === 0) {
        await rollback(client);
        return { status: "not_ready" };
      }
      const problem = recordingDataProblem({ segments: candidate.segments, speakerNames: candidate.speaker_names, durationSec: candidate.duration_sec });
      if (problem) throw new InvalidRecordingError(problem);
      if (!candidate.adopted) {
        // 採用印を先に付け替える。続く recording UPDATE の一方向同期先は新しい案になる。
        await client.query(CLEAR_ADOPTED_SQL, [owner, pageId]);
        await client.query(SET_ADOPTED_SQL, [owner, pageId, candidateId]);
        await client.query(WRITE_ADOPTED_SQL, [
          owner,
          pageId,
          JSON.stringify(candidate.segments),
          JSON.stringify(candidate.speaker_names),
          candidate.engine,
          candidate.duration_sec,
          input.expectedRecordingRevision,
        ]);
      }
      await rememberOperation(client, candidateId, input.operationId, "adopt", requestHash, candidate.revision);
      await client.query(TOUCH_PAGE_SQL, [owner, pageId]);
      const saved = (await client.query<RecordingRow>(GET_SQL, [owner, pageId])).rows[0];
      if (!saved) throw new Error("editor-store: recording disappeared while adopting a candidate");
      await client.query("COMMIT");
      return { status: "ok", recording: toRecording(saved), candidates: await listRecordingCandidates(client, owner, pageId) };
    } catch (error) {
      await rollback(client);
      if (isInvalidTextRepresentation(error)) return null;
      throw error;
    }
  } finally {
    client.release();
  }
}

export type DeleteRecordingCandidateResult =
  | { status: "ok"; candidates: RecordingCandidateView[] }
  /** 採用中の案は消せない（正本の出どころなので、別の案を採用してから消す）。 */
  | { status: "adopted" }
  /** その案の文字起こしが走っている（終わるか失敗するまで消せない）。 */
  | { status: "running" };

// $1 owner / $2 page id / $3 candidate id。採用中でない案だけを消す（実行は FK の CASCADE で消える）。
const DELETE_CANDIDATE_SQL = "DELETE FROM page_recording_candidates WHERE owner = $1 AND page_id = $2 AND id = $3 AND NOT adopted";

/**
 * 案を消す（旧版に無い操作。見比べて要らなくなった案を片づける）。
 * - その案が無い（別の人・存在しない・不正な id・削除済みのページ）: null
 * - 採用中: adopted（何も消さない）/ その案の実行が走っている: running（何も消さない）
 * 消すと、その案に書く実行の行も一緒に消える（0024 の FK の CASCADE）。正本（page_recordings）は触らない。
 */
export async function deleteRecordingCandidate(
  pool: Connectable,
  owner: OwnerId,
  pageId: string,
  candidateId: string,
): Promise<DeleteRecordingCandidateResult | null> {
  assertOwner(owner);
  if (!isPageId(pageId) || !isPageId(candidateId)) return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const candidate = (
        await client.query<{ adopted: boolean; running: boolean }>(
          `SELECT c.adopted,
                  EXISTS (
                    SELECT 1 FROM transcription_runs AS t
                     WHERE t.candidate = c.id AND t.status IN ('queued', 'running')
                  ) AS running
             FROM page_recording_candidates AS c
             JOIN pages AS p ON p.owner = c.owner AND p.id = c.page_id
            WHERE c.owner = $1 AND c.page_id = $2 AND c.id = $3 AND p.deleted_at IS NULL
              FOR UPDATE OF c`,
          [owner, pageId, candidateId],
        )
      ).rows[0];
      if (!candidate) {
        await rollback(client);
        return null;
      }
      if (candidate.adopted) {
        await rollback(client);
        return { status: "adopted" };
      }
      if (candidate.running) {
        await rollback(client);
        return { status: "running" };
      }
      await client.query(DELETE_CANDIDATE_SQL, [owner, pageId, candidateId]);
      await client.query(TOUCH_PAGE_SQL, [owner, pageId]);
      await client.query("COMMIT");
      return { status: "ok", candidates: await listRecordingCandidates(client, owner, pageId) };
    } catch (error) {
      await rollback(client);
      if (isInvalidTextRepresentation(error)) return null;
      throw error;
    }
  } finally {
    client.release();
  }
}

export type FinishCandidateResult = "written" | "missing" | "conflict";

// 実行の結果を案に書く。$1 candidate id / $2 expected revision / $3 segments / $4 duration / $5 engine
const WRITE_CANDIDATE_SQL = `
UPDATE page_recording_candidates
   SET segments = $3::jsonb,
       speaker_names = '{}'::jsonb,
       duration_sec = COALESCE($4::numeric, duration_sec),
       engine = COALESCE($5::text, engine),
       updated_at = GREATEST(clock_timestamp(), updated_at)
 WHERE id = $1 AND revision = $2
 RETURNING id`;

/**
 * 実行の結果を案に書く（finishRun から、同じ transaction の中で呼ぶ）。話者名の表は空にする
 * （番号の付け方はエンジンごとに違うので、前の名前は当てはまらない）。採用中の案でも、正本には写さない（採用のときに写す）。
 */
export async function writeCandidateSegments(
  client: Pick<PoolClient, "query">,
  candidateId: string,
  expectedRevision: number,
  output: { segments: readonly RecordingSegment[]; durationSec: number | null; engine: string | null },
): Promise<FinishCandidateResult> {
  await client.query("SELECT set_config('niho.recording_candidate_reason', 'asr', true)");
  const result = await client.query(WRITE_CANDIDATE_SQL, [candidateId, expectedRevision, JSON.stringify(output.segments), output.durationSec, output.engine]);
  if (result.rowCount === 1) return "written";
  return (await client.query("SELECT 1 FROM page_recording_candidates WHERE id = $1", [candidateId])).rowCount === 1 ? "conflict" : "missing";
}
