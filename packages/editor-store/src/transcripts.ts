import type { PoolClient } from "pg";
import { isPageId } from "./store.ts";
import type { OwnerId, PageLang, Queryable } from "./types.ts";
import {
  InvalidRecordingError,
  TOUCH_PAGE_SQL,
  assertOwner,
  isInvalidTextRepresentation,
  recordingDataProblem,
  rollback,
  type Connectable,
  type RecordingData,
  type RecordingMutation,
  type RecordingSegment,
} from "./recordings.ts";

/**
 * 文字起こしのタブ（#310。migration `..._page_transcripts`）。オーナー決定 2026-11-06（#288）: 文字起こしは「文字起こし」ページ
 * （フォルダ直下の役割 `{ kind: 'transcript' }` の入れ物）のタブ（エンジンごと）。候補と「採用」はやめる。
 *
 * - タブは `pages.kind = 'note'`・題名は入れ物と同じ「文字起こし」・札（`tab_name`）はエンジンの名前・`made_from = { kind: 'transcript', recording, engine }`。
 *   本文（段落・話者名）は `page_transcripts` の 1 行（段落の形は page_recordings と同じ）。音声は録音のタブの資産のまま。
 * - 書き込みは revision を見る（別の画面で先に直されていたら上書きしない）。直す前の本文は `page_transcript_versions` に残す（100 まで）。
 * - 読み書きは全て本人の・ゴミ箱でないタブだけ（別の人・削除済み・存在しない・不正な id は null）。
 */

export const TRANSCRIPT_HOLDER_TITLE = "文字起こし";
export const TRANSCRIPT_VERSION_LIMIT = 100;

/** エンジンの表示名（タブの札。API の id は小文字）。 */
export const TRANSCRIPT_ENGINE_LABELS: Readonly<Record<string, string>> = {
  deepgram: "Deepgram",
  gemini: "Gemini",
  "gemini-cli": "Gemini（このMacのCLI）",
  "apple-local": "Apple（このMac内）",
  "vtt-import": "取り込んだ字幕",
  fake: "開発の偽物",
  import: "取り込み",
};

export function transcriptEngineLabel(engine: string): string {
  return TRANSCRIPT_ENGINE_LABELS[engine] ?? engine;
}

export type Transcript = {
  revision: number;
  /** 録音のタブ（消えていれば画面が「再生できません」と出す。本文は残る）。 */
  recordingPageId: string;
  engine: string;
  language: PageLang;
  durationSec: number | null;
  segments: RecordingSegment[];
  speakerNames: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

/** 録音のタブの本文に出す、文字起こしのタブの一覧の 1 行。 */
export type TranscriptTabSummary = {
  id: string;
  /** 札（付けた名前。無ければ位置の番号で呼ぶ）。 */
  tabName: string | null;
  tabPos: number;
  engine: string;
  language: PageLang;
  durationSec: number | null;
  segmentCount: number;
  revision: number;
  updatedAt: string;
};

export const TRANSCRIPT_VERSION_REASONS = ["initial", "edit", "asr", "restore"] as const;
export type TranscriptVersionReason = (typeof TRANSCRIPT_VERSION_REASONS)[number];

export type TranscriptVersionSummary = { version: number; reason: TranscriptVersionReason; engine: string; segmentCount: number; createdAt: string };
export type TranscriptVersion = TranscriptVersionSummary & { language: PageLang; segments: RecordingSegment[]; speakerNames: Record<string, string>; durationSec: number | null };

export type UpdateTranscriptResult<R extends string = string> =
  | { status: "ok"; transcript: Transcript }
  | { status: "conflict"; transcript: Transcript }
  | { status: "rejected"; reason: R };

type TranscriptRow = {
  revision: number;
  recording_page_id: string;
  engine: string;
  language: PageLang;
  duration_sec: number | null;
  segments: RecordingSegment[];
  speaker_names: Record<string, string>;
  created_at: Date;
  updated_at: Date;
};

const TRANSCRIPT_COLUMNS = "t.revision, t.recording_page_id, t.engine, t.language, t.duration_sec::float8 AS duration_sec, t.segments, t.speaker_names, t.created_at, t.updated_at";

// 本人の・ゴミ箱でないタブの文字起こし。$1 owner / $2 tab id。
const GET_SQL = `
SELECT ${TRANSCRIPT_COLUMNS}
  FROM page_transcripts AS t
  JOIN pages AS p ON p.owner = t.owner AND p.id = t.page_id
 WHERE t.owner = $1 AND t.page_id = $2 AND p.deleted_at IS NULL`;

const LOCK_SQL = `${GET_SQL}
   FOR UPDATE OF t`;

function copyData(data: RecordingData): RecordingData {
  const copy: RecordingData = {
    segments: data.segments.map(({ start, end, text, speaker }) => ({ start, end, text, speaker })),
    speakerNames: { ...data.speakerNames },
  };
  if (data.durationSec !== undefined) copy.durationSec = data.durationSec;
  return copy;
}

function toTranscript(row: TranscriptRow): Transcript {
  const data = copyData({ segments: row.segments, speakerNames: row.speaker_names });
  return {
    revision: row.revision,
    recordingPageId: row.recording_page_id,
    engine: row.engine,
    language: row.language,
    durationSec: row.duration_sec,
    segments: data.segments,
    speakerNames: data.speakerNames,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** 文字起こしのタブ（本文 `page_transcripts` を持つタブ。複製したタブも）なら、元の録音のタブの id。それ以外・別の人・ゴミ箱は null。 */
export async function transcriptRecordingOf(db: Queryable, owner: OwnerId, tabId: string): Promise<string | null> {
  assertOwner(owner);
  if (!isPageId(tabId)) return null;
  const row = (await db.query<{ recording_page_id: string }>(
    "SELECT t.recording_page_id FROM page_transcripts t JOIN pages p ON p.owner = t.owner AND p.id = t.page_id WHERE t.owner = $1 AND t.page_id = $2 AND p.deleted_at IS NULL",
    [owner, tabId],
  )).rows[0];
  return row?.recording_page_id ?? null;
}

/** 本人の・ゴミ箱でないタブの文字起こし。無ければ null。 */
export async function getTranscript(db: Queryable, owner: OwnerId, tabId: string): Promise<Transcript | null> {
  assertOwner(owner);
  if (!isPageId(tabId)) return null;
  try {
    const row = (await db.query<TranscriptRow>(GET_SQL, [owner, tabId])).rows[0];
    return row ? toTranscript(row) : null;
  } catch (error) {
    if (isInvalidTextRepresentation(error)) return null;
    throw error;
  }
}

type SummaryRow = { id: string; tab_name: string | null; tab_pos: number | string; engine: string; language: PageLang; duration_sec: number | null; segment_count: number | string; revision: number; updated_at: Date };

// 録音のタブから作った文字起こしのタブ（生きているもの。入れ物の中の並び）。$1 owner / $2 recording tab id。
const LIST_SQL = `
SELECT p.id, p.tab_name, t.engine, t.language, t.duration_sec::float8 AS duration_sec, jsonb_array_length(t.segments) AS segment_count, t.revision, t.updated_at,
       (SELECT count(*) FROM pages o WHERE o.owner = p.owner AND o.page = p.page AND o.deleted_at IS NULL
          AND (o.sort_order, o.created_at, o.id) <= (p.sort_order, p.created_at, p.id)) AS tab_pos
  FROM page_transcripts AS t
  JOIN pages AS p ON p.owner = t.owner AND p.id = t.page_id
 WHERE t.owner = $1 AND t.recording_page_id = $2 AND p.deleted_at IS NULL
 ORDER BY p.sort_order, p.created_at, p.id`;

/** 録音のタブから作った文字起こしのタブ（生きているもの。入れ物の中の並び）。録音が本人のものでなくても空（呼ぶ側が録音を確かめる）。 */
export async function listTranscriptTabs(db: Queryable, owner: OwnerId, recordingId: string): Promise<TranscriptTabSummary[]> {
  assertOwner(owner);
  if (!isPageId(recordingId)) return [];
  const result = await db.query<SummaryRow>(LIST_SQL, [owner, recordingId]);
  return result.rows.map((row) => ({
    id: row.id,
    tabName: row.tab_name,
    tabPos: Number(row.tab_pos),
    engine: row.engine,
    language: row.language,
    durationSec: row.duration_sec,
    segmentCount: Number(row.segment_count),
    revision: row.revision,
    updatedAt: row.updated_at.toISOString(),
  }));
}

/** 直す前の本文を版に残す（100 を超えた古い版は消す）。$1 tab id / $2 reason。 */
const SAVE_VERSION_SQL = `
WITH saved AS (
  INSERT INTO page_transcript_versions (page_id, version, engine, language, segments, speaker_names, duration_sec, reason)
  SELECT t.page_id, COALESCE((SELECT max(v.version) FROM page_transcript_versions v WHERE v.page_id = t.page_id), 0) + 1,
         t.engine, t.language, t.segments, t.speaker_names, t.duration_sec, $2
    FROM page_transcripts t
   WHERE t.page_id = $1
  RETURNING version
)
DELETE FROM page_transcript_versions v
 WHERE v.page_id = $1 AND v.version <= (SELECT version FROM saved) - $3`;

// $1 owner / $2 tab id / $3 segments / $4 speaker names / $5 duration
const UPDATE_SQL = `
UPDATE page_transcripts AS t
   SET segments = $3::jsonb,
       speaker_names = $4::jsonb,
       duration_sec = $5::numeric,
       revision = t.revision + 1,
       updated_at = GREATEST(clock_timestamp(), t.updated_at)
 WHERE t.owner = $1 AND t.page_id = $2
RETURNING ${TRANSCRIPT_COLUMNS}`;

/**
 * 文字起こしのタブを書き換える（段落の編集・話者の名前・つなぎ足し）。行を FOR UPDATE で押さえてから revision を比べる。
 * - タブが無い: null / baseRevision が違う: conflict（最新を返す）/ mutate が断った: rejected / それ以外: 直す前の本文を版（edit）に残して保存
 */
export async function updateTranscript<R extends string>(
  pool: Connectable,
  owner: OwnerId,
  tabId: string,
  baseRevision: number,
  mutate: RecordingMutation<R>,
): Promise<UpdateTranscriptResult<R> | null> {
  assertOwner(owner);
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 1) throw new TypeError("editor-store: baseRevision must be a positive integer");
  if (!isPageId(tabId)) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const row = (await client.query<TranscriptRow>(LOCK_SQL, [owner, tabId])).rows[0];
      if (!row) {
        await rollback(client);
        return null;
      }
      const current = toTranscript(row);
      if (current.revision !== baseRevision) {
        await rollback(client);
        return { status: "conflict", transcript: current };
      }
      const next = mutate(copyData({ segments: current.segments, speakerNames: current.speakerNames, durationSec: current.durationSec }));
      if ("rejected" in next) {
        await rollback(client);
        return { status: "rejected", reason: next.rejected };
      }
      const problem = recordingDataProblem(next);
      if (problem) throw new InvalidRecordingError(problem);
      const clean = copyData(next);
      await client.query(SAVE_VERSION_SQL, [tabId, "edit", TRANSCRIPT_VERSION_LIMIT]);
      const updated = await client.query<TranscriptRow>(UPDATE_SQL, [
        owner,
        tabId,
        JSON.stringify(clean.segments),
        JSON.stringify(clean.speakerNames),
        clean.durationSec === undefined ? current.durationSec : clean.durationSec,
      ]);
      const saved = updated.rows[0];
      if (!saved) throw new Error("editor-store: update returned no transcript");
      await client.query(TOUCH_PAGE_SQL, [owner, tabId]);
      await client.query("COMMIT");
      return { status: "ok", transcript: toTranscript(saved) };
    } catch (error) {
      await rollback(client);
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * 文字起こしの実行の結果を書く（transcription-runs.ts の確定から、同じ transaction で呼ぶ）。revision が合うときだけ書き、
 * 直す前の本文（空でなければ）を版（asr）に残す。話者名の表は空にする（番号の付け方がエンジンで変わる）。
 * `written`: 書いた / `conflict`: 開始後に直されていた（書かない）/ `missing`: タブが消えている。
 */
export async function writeTranscriptSegments(
  client: Pick<PoolClient, "query">,
  owner: OwnerId,
  tabId: string,
  expectedRevision: number,
  output: { segments: RecordingSegment[]; durationSec: number | null; engine: string },
): Promise<"written" | "conflict" | "missing"> {
  const row = (await client.query<TranscriptRow>(LOCK_SQL, [owner, tabId])).rows[0];
  if (!row) return "missing";
  if (row.revision !== expectedRevision) return "conflict";
  if (row.segments.length > 0) await client.query(SAVE_VERSION_SQL, [tabId, "asr", TRANSCRIPT_VERSION_LIMIT]);
  await client.query(
    `UPDATE page_transcripts AS t
        SET segments = $3::jsonb, speaker_names = '{}'::jsonb, engine = $4::text,
            duration_sec = COALESCE($5::numeric, t.duration_sec),
            revision = t.revision + 1, updated_at = GREATEST(clock_timestamp(), t.updated_at)
      WHERE t.owner = $1 AND t.page_id = $2`,
    [owner, tabId, JSON.stringify(output.segments), output.engine, output.durationSec],
  );
  await client.query(TOUCH_PAGE_SQL, [owner, tabId]);
  return "written";
}

type VersionRow = { version: number; reason: TranscriptVersionReason; engine: string; language: PageLang; segments: RecordingSegment[]; speaker_names: Record<string, string>; duration_sec: number | null; segment_count: number | string; created_at: Date };

/** タブの版（新しい順）。タブが本人のものでなければ空。 */
export async function listTranscriptVersions(db: Queryable, owner: OwnerId, tabId: string): Promise<TranscriptVersionSummary[]> {
  assertOwner(owner);
  if (!isPageId(tabId)) return [];
  const result = await db.query<VersionRow>(
    `SELECT v.version, v.reason, v.engine, v.language, '[]'::jsonb AS segments, '{}'::jsonb AS speaker_names, NULL::float8 AS duration_sec,
            jsonb_array_length(v.segments) AS segment_count, v.created_at
       FROM page_transcript_versions v
       JOIN page_transcripts t ON t.page_id = v.page_id
       JOIN pages p ON p.owner = t.owner AND p.id = t.page_id
      WHERE t.owner = $1 AND v.page_id = $2 AND p.deleted_at IS NULL
      ORDER BY v.version DESC`,
    [owner, tabId],
  );
  return result.rows.map((row) => ({ version: row.version, reason: row.reason, engine: row.engine, segmentCount: Number(row.segment_count), createdAt: row.created_at.toISOString() }));
}

/** 1 つの版の本文。無ければ null。 */
export async function getTranscriptVersion(db: Queryable, owner: OwnerId, tabId: string, version: number): Promise<TranscriptVersion | null> {
  assertOwner(owner);
  if (!isPageId(tabId) || !Number.isSafeInteger(version) || version < 1) return null;
  const row = (await db.query<VersionRow>(
    `SELECT v.version, v.reason, v.engine, v.language, v.segments, v.speaker_names, v.duration_sec::float8 AS duration_sec,
            jsonb_array_length(v.segments) AS segment_count, v.created_at
       FROM page_transcript_versions v
       JOIN page_transcripts t ON t.page_id = v.page_id
       JOIN pages p ON p.owner = t.owner AND p.id = t.page_id
      WHERE t.owner = $1 AND v.page_id = $2 AND v.version = $3 AND p.deleted_at IS NULL`,
    [owner, tabId, version],
  )).rows[0];
  if (!row) return null;
  const data = copyData({ segments: row.segments, speakerNames: row.speaker_names });
  return { version: row.version, reason: row.reason, engine: row.engine, language: row.language, segments: data.segments, speakerNames: data.speakerNames, durationSec: row.duration_sec, segmentCount: Number(row.segment_count), createdAt: row.created_at.toISOString() };
}

/** 版に戻す（今の本文を版 restore に残してから、その版の段落・話者名・長さに置き換える）。 */
export async function restoreTranscriptVersion(pool: Connectable & Queryable, owner: OwnerId, tabId: string, version: number, baseRevision: number): Promise<UpdateTranscriptResult<"version_missing"> | null> {
  const target = await getTranscriptVersion(pool, owner, tabId, version);
  if (!target) {
    return (await getTranscript(pool, owner, tabId)) ? { status: "rejected", reason: "version_missing" } : null;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const row = (await client.query<TranscriptRow>(LOCK_SQL, [owner, tabId])).rows[0];
      if (!row) {
        await rollback(client);
        return null;
      }
      const current = toTranscript(row);
      if (current.revision !== baseRevision) {
        await rollback(client);
        return { status: "conflict", transcript: current };
      }
      await client.query(SAVE_VERSION_SQL, [tabId, "restore", TRANSCRIPT_VERSION_LIMIT]);
      const updated = await client.query<TranscriptRow>(UPDATE_SQL, [owner, tabId, JSON.stringify(target.segments), JSON.stringify(target.speakerNames), target.durationSec]);
      const saved = updated.rows[0];
      if (!saved) throw new Error("editor-store: restore returned no transcript");
      await client.query(TOUCH_PAGE_SQL, [owner, tabId]);
      await client.query("COMMIT");
      return { status: "ok", transcript: toTranscript(saved) };
    } catch (error) {
      await rollback(client);
      throw error;
    }
  } finally {
    client.release();
  }
}

export type TranscriptText = { segments: RecordingSegment[]; speakerNames: Record<string, string> };

// $1 owner / $2 page id（文字起こしのタブか録音のタブ）。タブ自身を最優先、録音なら段落のある最新のタブ。
const TEXT_SQL = `
SELECT t.segments, t.speaker_names
  FROM page_transcripts AS t
  JOIN pages AS p ON p.owner = t.owner AND p.id = t.page_id
 WHERE t.owner = $1 AND p.deleted_at IS NULL AND (t.page_id = $2 OR t.recording_page_id = $2)
 ORDER BY (t.page_id = $2) DESC, (jsonb_array_length(t.segments) > 0) DESC, p.updated_at DESC, p.id DESC
 LIMIT 1`;

/**
 * 読むための文字起こしの本文（AI チャットの read_page・search_transcript）: 文字起こしのタブならその本文、録音のタブなら
 * その録音の段落のある最新の文字起こしのタブ。本人の・ゴミ箱でないものだけ。文字起こしのタブが無ければ null。
 */
export async function readTranscriptText(db: Queryable, owner: OwnerId, pageId: string): Promise<TranscriptText | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  const row = (await db.query<{ segments: RecordingSegment[]; speaker_names: Record<string, string> }>(TEXT_SQL, [owner, pageId])).rows[0];
  if (!row) return null;
  const data = copyData({ segments: row.segments, speakerNames: row.speaker_names });
  return { segments: data.segments, speakerNames: data.speakerNames };
}

// ---------------------------------------------------------------------------
// 入れ物とタブを作る（文字起こしの開始・VTT の取り込みが transaction の中で呼ぶ）

export type RecordingHome = { recordingId: string; folder: string; lang: PageLang };

/**
 * 録音のタブの居場所（フォルダ）。フォルダの外なら、その入れ物の題名でフォルダを作って入れ物ごと入れる（#309 の wrapInFolder と同じ）。
 * 録音が本人の生きているタブでなければ null。transaction の中で呼ぶ（録音の行は呼ぶ側が押さえている）。
 */
export async function ensureRecordingFolder(client: Pick<PoolClient, "query">, owner: OwnerId, recordingId: string): Promise<RecordingHome | null> {
  const rec = (await client.query<{ id: string; page: string | null; lang: PageLang; title: string; folder: string | null }>(
    `SELECT r.id, r.page, r.lang, r.title,
            (SELECT f.id FROM pages f WHERE f.owner = r.owner AND f.id = r.parent AND f.kind = 'folder' AND f.deleted_at IS NULL) AS folder
       FROM pages r
      WHERE r.owner = $1 AND r.id = $2 AND r.kind = 'rec' AND r.deleted_at IS NULL`,
    [owner, recordingId],
  )).rows[0];
  if (!rec) return null;
  if (rec.folder) return { recordingId: rec.id, folder: rec.folder, lang: rec.lang };
  const made = (await client.query<{ id: string }>(
    "INSERT INTO pages (owner, kind, title, lang, blocks) VALUES ($1, 'folder', $2, $3, '[]'::jsonb) RETURNING id",
    [owner, rec.title, rec.lang],
  )).rows[0];
  if (!made) throw new Error("editor-store: insert returned no folder");
  // 入れ物と、そのタブを新しいフォルダへ（入れ物の無い 1 枚だけの録音は、その行だけ）
  await client.query(
    "UPDATE pages SET parent = $3 WHERE owner = $1 AND deleted_at IS NULL AND (id = $2 OR ($4::uuid IS NOT NULL AND (id = $4 OR page = $4)))",
    [owner, rec.id, made.id, rec.page],
  );
  return { recordingId: rec.id, folder: made.id, lang: rec.lang };
}

/**
 * 「文字起こし」の入れ物（フォルダ直下・役割 transcript。無ければ作る）に、新しいタブ（本文なし）を足し、page_transcripts の行を入れる。
 * 札はエンジンの名前（同じ札が既にあれば「Gemini 2」）。transaction の中で呼ぶ。
 */
export async function createTranscriptTab(
  client: Pick<PoolClient, "query">,
  owner: OwnerId,
  home: RecordingHome,
  input: { engine: string; language: PageLang; durationSec?: number | null },
): Promise<{ tab: string; holder: string }> {
  const role = JSON.stringify({ kind: "transcript" });
  const found = (await client.query<{ id: string }>(
    `SELECT id FROM pages WHERE owner = $1 AND parent = $2 AND kind = 'page' AND deleted_at IS NULL AND role = $3::jsonb
      ORDER BY created_at, id LIMIT 1 FOR UPDATE`,
    [owner, home.folder, role],
  )).rows[0];
  let holder = found?.id ?? null;
  if (holder === null) {
    const made = (await client.query<{ id: string }>(
      "INSERT INTO pages (owner, kind, title, lang, blocks, parent, role) VALUES ($1, 'page', $2, $3, '[]'::jsonb, $4, $5::jsonb) RETURNING id",
      [owner, TRANSCRIPT_HOLDER_TITLE, home.lang, home.folder, role],
    )).rows[0];
    if (!made) throw new Error("editor-store: insert returned no transcript holder");
    holder = made.id;
  }
  const label = transcriptEngineLabel(input.engine);
  const names = (await client.query<{ tab_name: string | null }>("SELECT tab_name FROM pages WHERE owner = $1 AND page = $2 AND deleted_at IS NULL", [owner, holder])).rows.map((row) => row.tab_name);
  let tabName = label;
  for (let suffix = 2; names.includes(tabName); suffix += 1) tabName = `${label} ${suffix}`;
  const tab = (await client.query<{ id: string }>(
    `INSERT INTO pages (owner, kind, title, lang, blocks, parent, page, made_from, sort_order, tab_name)
     SELECT $1, 'note', h.title, h.lang, '[]'::jsonb, h.parent, h.id, $3::jsonb,
            COALESCE((SELECT max(t.sort_order) FROM pages t WHERE t.owner = h.owner AND t.page = h.id AND t.deleted_at IS NULL), 0) + 1, $4
       FROM pages h WHERE h.owner = $1 AND h.id = $2
     RETURNING id`,
    [owner, holder, JSON.stringify({ kind: "transcript", recording: home.recordingId, engine: input.engine }), tabName.slice(0, 100)],
  )).rows[0];
  if (!tab) throw new Error("editor-store: insert returned no transcript tab");
  await client.query(
    "INSERT INTO page_transcripts (page_id, owner, recording_page_id, engine, language, duration_sec) VALUES ($1, $2, $3, $4, $5, $6::numeric)",
    [tab.id, owner, home.recordingId, input.engine, input.language, input.durationSec ?? null],
  );
  await client.query("UPDATE pages SET last_tab = $3, updated_at = GREATEST(clock_timestamp(), updated_at) WHERE owner = $1 AND id = $2", [owner, holder, tab.id]);
  return { tab: tab.id, holder };
}
