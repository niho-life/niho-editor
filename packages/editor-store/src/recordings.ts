import type { PoolClient } from "pg";
import { isPageId } from "./store.ts";
import type { OwnerId, PageLang, Queryable } from "./types.ts";
import { createTranscriptTab, ensureRecordingFolder } from "./transcripts.ts";

/**
 * 録音ページ（#36 段 1）。録音ページ（kind = 'rec'）に page_recordings の 1 行（migrations/0007_page_recordings.sql）。
 * 録音の行は音声・原本の名前・長さなどの録音そのものを持つ。文字起こしの段落・話者名は持たない（#310。「文字起こし」ページのタブ＝
 * page_transcripts が持つ。transcripts.ts）。
 * 読み取りは全て本人の・ゴミ箱でないページだけ。別の人のページ・削除済み・存在しない・UUID として不正な id・録音の無いページは
 * どれも null（呼び出し側は同じ 404 にする）。
 * 段落・話者の操作そのもの（純粋な関数）は呼び出し側が持ち、ここは形の検査（recordingDataProblem）だけをする。
 * 音声から作る録音（source = 'audio'。#36 段 2a）は recording-audio.ts の startAudioRecording で作る（音声の資産と一緒に入れる）。
 */

/** 段落の数の上限（0007 の CHECK と同じ）。1 時間の録音を数秒ごとに区切っても収まり、1 行の jsonb を数 MB に抑える。 */
export const RECORDING_SEGMENTS_MAX = 20_000;
/** 1 つの段落の文字数の上限（code point の数）。 */
export const RECORDING_SEGMENT_TEXT_MAX_CHARS = 5_000;
/**
 * 全ての段落の本文の合計の上限（UTF-8 のバイト数）。docs-core の VTT_MARKDOWN_MAX_BYTES（文字起こしの本文の同期上限）と同じ 8 MiB。
 * 段落の数と 1 段落の上限だけでは、直すたびに伸ばして 1 行の jsonb が数百 MB になり得るので、合計でも止める。
 */
export const RECORDING_TEXT_MAX_BYTES = 8 * 1024 * 1024;
/** 話者の名前の文字数の上限（docs-core の TRANSCRIPT_SPEAKER_NAME_MAX_CHARS と同じ）。 */
export const RECORDING_SPEAKER_NAME_MAX_CHARS = 60;
/** engine の文字数の上限（0007 の CHECK と同じ）。 */
export const RECORDING_ENGINE_MAX_CHARS = 64;
/** 元のファイルの名前の文字数の上限（0007 の CHECK と同じ）。 */
export const RECORDING_SOURCE_NAME_MAX_CHARS = 200;
/** 録音ページの題名の上限（0001 の CHECK と同じ）。 */
const PAGE_TITLE_MAX_CHARS = 500;

export const RECORDING_SOURCES = ["vtt", "audio"] as const;
export type RecordingSource = (typeof RECORDING_SOURCES)[number];

/** 段落（docs-core の SpeechResultV1 の segments と同じ形）。時刻は秒（無ければ両方 null）、話者は 1 始まりの番号か null。 */
export type RecordingSegment = { start: number | null; end: number | null; text: string; speaker: number | null };

/** アップロードの状態（migrations/0008_recording_audio.sql の audio_status のうち、音声があるもの）。 */
export const RECORDING_AUDIO_STATUSES = ["uploading", "uploaded"] as const;
export type RecordingAudioStatus = (typeof RECORDING_AUDIO_STATUSES)[number];

/**
 * 録音の音声（#36 段 2a）。bytes と contentType はクライアントの申告の値（assets の行）。expiresAt は bucket のライフサイクル規則で
 * 消える見込みの時刻（表示のためだけ。アプリは消さない）。
 */
export type RecordingAudio = { status: RecordingAudioStatus; bytes: number; contentType: string; expiresAt: string | null };

/**
 * 文字起こしのタブの本文（書き換えられる部分）。speakerNames のキーは話者番号の 10 進の文字列（"1"）で、segments に出てくる話者だけ。
 * durationSec は録音の長さ（秒）。**書き換えでは省略できる**（省くと今の長さのまま）。音声・字幕を足して録音が長くなるとき
 * （editor-web の appendTranscript）だけ、新しい長さを入れて返す。
 */
export type RecordingData = { segments: RecordingSegment[]; speakerNames: Record<string, string>; durationSec?: number | null };

export type Recording = {
  revision: number;
  source: RecordingSource;
  language: PageLang;
  engine: string | null;
  durationSec: number | null;
  sourceName: string | null;
  sourceSha256: string | null;
  /** 音声（#36 段 2a）。音声の無い録音（VTT の取り込み）は null。 */
  audio: RecordingAudio | null;
  createdAt: string;
  updatedAt: string;
};

/** 録音ページを作るときに渡すもの。lang はページと録音の両方の言語。 */
export type CreateRecordingInput = {
  title?: string;
  lang: PageLang;
  source: RecordingSource;
  engine?: string | null;
  durationSec?: number | null;
  sourceName?: string | null;
  sourceSha256?: string | null;
  segments: RecordingSegment[];
  speakerNames?: Record<string, string>;
};

/** 作った録音ページ（本文は空）。 */
export type RecordingPage = { id: string; kind: "rec"; title: string; lang: PageLang; page: string | null; createdAt: string; updatedAt: string };

/** 文字起こしのタブの本文の書き換え（純粋な関数）。新しい RecordingData か、断るときは `{ rejected: 理由 }` を返す。 */
export type RecordingMutation<R extends string = string> = (data: RecordingData) => RecordingData | { rejected: R };

/** トランザクションに使う 1 本の接続を借りられるもの（pg の Pool）。 */
export type Connectable = { connect: () => Promise<Pick<PoolClient, "query" | "release">> };

/** 保存する形が規則に合わない（呼び出し側の検査の漏れ。書かずに止める）。 */
export class InvalidRecordingError extends TypeError {
  override readonly name = "InvalidRecordingError";
  readonly problem: string;
  constructor(problem: string) {
    super(`editor-store: recording is not valid (${problem})`);
    this.problem = problem;
  }
}

export function assertOwner(owner: OwnerId): void {
  // store.ts と同じ守り: 認証の層の誤りで空の owner が来たときに、誰のものでもない行を読み書きしない
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) {
    throw new TypeError("editor-store: owner must be a non-empty stable user id");
  }
}

export function isInvalidTextRepresentation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "22P02";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function charCount(text: string): number {
  return Array.from(text).length;
}

/** 対になっていない surrogate（PostgreSQL の jsonb に入らない）。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** 名前に入れない制御文字（docs-core の speech-result の speakerNames と同じ範囲）。 */
export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const SPEAKER_KEY = /^[1-9]\d*$/;
export const SHA256 = /^[0-9a-f]{64}$/;

/** 保存できる文字か（NUL・対になっていない surrogate を含まない）。 */
export function isStorableText(text: string): boolean {
  return !text.includes("\u0000") && !LONE_SURROGATE.test(text);
}

function isSpeakerNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function segmentProblem(segment: unknown): string | null {
  if (!isPlainObject(segment)) return "segment";
  const keys = Object.keys(segment);
  if (keys.length !== 4 || !["start", "end", "text", "speaker"].every((key) => key in segment)) return "segment";
  const { start, end, text, speaker } = segment;
  if (start === null || end === null) {
    if (start !== null || end !== null) return "time";
  } else if (
    typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start
  ) {
    return "time";
  }
  if (typeof text !== "string" || !isStorableText(text) || charCount(text) > RECORDING_SEGMENT_TEXT_MAX_CHARS) return "text";
  if (speaker !== null && !isSpeakerNumber(speaker)) return "speaker";
  return null;
}

/** 全ての段落の本文の合計（UTF-8 のバイト数）。 */
export function recordingTextBytes(segments: readonly Pick<RecordingSegment, "text">[]): number {
  let total = 0;
  for (const segment of segments) total += Buffer.byteLength(segment.text, "utf8");
  return total;
}

/**
 * 保存する前の形の検査。問題が無ければ null、あれば短い理由（segments・segment・time・text・size・speaker・speaker_names・name）。
 * segments は上限の数まで、各段落は start・end・text・speaker の 4 つだけ、本文の合計は 8 MiB まで。長さ（durationSec）は
 * 省略できて、入れるなら 0 以上か null（duration）。speakerNames のキーは
 * segments に出てくる話者だけで、名前は前後に空白の無い 1〜60 文字（制御文字なし）。名前の規則の全体（「話者N」の形・同名の衝突）は
 * 呼び出し側（docs-core）が見る。
 */
export function recordingDataProblem(data: unknown): string | null {
  if (!isPlainObject(data) || !Array.isArray(data.segments) || !isPlainObject(data.speakerNames)) return "segments";
  if (data.segments.length > RECORDING_SEGMENTS_MAX) return "segments";
  // 長さは省略できる（書き換えないとき）。入れるなら 0 以上の有限な数か null
  if (data.durationSec !== undefined && data.durationSec !== null) {
    if (typeof data.durationSec !== "number" || !Number.isFinite(data.durationSec) || data.durationSec < 0) return "duration";
  }
  const speakers = new Set<string>();
  for (const segment of data.segments) {
    const problem = segmentProblem(segment);
    if (problem) return problem;
    const speaker = (segment as RecordingSegment).speaker;
    if (speaker !== null) speakers.add(String(speaker));
  }
  if (recordingTextBytes(data.segments as RecordingSegment[]) > RECORDING_TEXT_MAX_BYTES) return "size";
  for (const [key, name] of Object.entries(data.speakerNames)) {
    if (!SPEAKER_KEY.test(key) || !speakers.has(key)) return "speaker_names";
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name !== name.trim() ||
      CONTROL_CHARACTERS.test(name) ||
      !isStorableText(name) ||
      charCount(name) > RECORDING_SPEAKER_NAME_MAX_CHARS
    ) {
      return "name";
    }
  }
  return null;
}

/** 決まった項目だけの複製（呼び出し側が足した項目・jsonb の並びに左右されない）。長さは、持っているときだけ写す。 */
function copyData(data: RecordingData): RecordingData {
  const copy: RecordingData = {
    segments: data.segments.map(({ start, end, text, speaker }) => ({ start, end, text, speaker })),
    speakerNames: { ...data.speakerNames },
  };
  if (data.durationSec !== undefined) copy.durationSec = data.durationSec;
  return copy;
}

function assertData(data: unknown): asserts data is RecordingData {
  const problem = recordingDataProblem(data);
  if (problem) throw new InvalidRecordingError(problem);
}

function metadataProblem(input: CreateRecordingInput): string | null {
  if (input.lang !== "ja" && input.lang !== "en") return "lang";
  if (!(RECORDING_SOURCES as readonly string[]).includes(input.source)) return "source";
  // 音声の録音は資産と一緒に作る（recording-audio.ts の startAudioRecording）。ここでは作らない
  if (input.source === "audio") return "source";
  const title = input.title ?? "";
  if (typeof title !== "string" || !isStorableText(title) || charCount(title) > PAGE_TITLE_MAX_CHARS) return "title";
  const engine = input.engine ?? null;
  if (engine !== null && (typeof engine !== "string" || engine.length === 0 || !isStorableText(engine) || charCount(engine) > RECORDING_ENGINE_MAX_CHARS)) {
    return "engine";
  }
  const duration = input.durationSec ?? null;
  if (duration !== null && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)) return "duration";
  const name = input.sourceName ?? null;
  if (
    name !== null &&
    (typeof name !== "string" ||
      name.length === 0 ||
      /[/\\]/.test(name) ||
      CONTROL_CHARACTERS.test(name) ||
      !isStorableText(name) ||
      charCount(name) > RECORDING_SOURCE_NAME_MAX_CHARS)
  ) {
    return "source_name";
  }
  const sha = input.sourceSha256 ?? null;
  if (sha !== null && (typeof sha !== "string" || !SHA256.test(sha))) return "source_sha256";
  return null;
}

export type RecordingRow = {
  revision: number;
  source: RecordingSource;
  language: PageLang;
  engine: string | null;
  duration_sec: number | null;
  source_name: string | null;
  source_sha256: string | null;
  audio_status: "none" | RecordingAudioStatus;
  audio_bytes: string | null;
  audio_content_type: string | null;
  audio_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

// numeric は pg が文字列で返すので、float8 にして number で受ける。bigint（assets.bytes）は文字列で受けて数にする。
// 音声の大きさと種類は assets の行から引く（UPDATE・INSERT の RETURNING でも使えるよう、join ではなく副問い合わせ）。
export const RECORDING_COLUMNS = `r.revision, r.source, r.language, r.engine, r.duration_sec::float8 AS duration_sec, r.source_name,
       r.source_sha256, r.audio_status, r.audio_expires_at,
       (SELECT a.bytes::text FROM assets AS a WHERE a.owner = r.owner AND a.id = r.audio_asset) AS audio_bytes,
       (SELECT a.content_type FROM assets AS a WHERE a.owner = r.owner AND a.id = r.audio_asset) AS audio_content_type,
       r.created_at, r.updated_at`;

function toAudio(row: RecordingRow): RecordingAudio | null {
  if (row.audio_status === "none" || row.audio_bytes === null || row.audio_content_type === null) return null;
  return {
    status: row.audio_status,
    bytes: Number(row.audio_bytes),
    contentType: row.audio_content_type,
    expiresAt: row.audio_expires_at ? row.audio_expires_at.toISOString() : null,
  };
}

export function toRecording(row: RecordingRow): Recording {
  return {
    revision: row.revision,
    source: row.source,
    language: row.language,
    engine: row.engine,
    durationSec: row.duration_sec,
    sourceName: row.source_name,
    sourceSha256: row.source_sha256,
    audio: toAudio(row),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// 本人の・ゴミ箱でないページの録音。$1 owner / $2 page id。
export const GET_SQL = `
SELECT ${RECORDING_COLUMNS}
  FROM page_recordings AS r
  JOIN pages AS p ON p.owner = r.owner AND p.id = r.page_id
 WHERE r.owner = $1 AND r.page_id = $2 AND p.deleted_at IS NULL`;

// 録音ページ＝入れ物（kind='page'。#307）＋ 1 つ目のタブ（kind='rec'）。返すのはタブの行（/p/<id> も録音もタブの id）
export const INSERT_HOLDER_SQL = `
INSERT INTO pages (owner, kind, title, lang, blocks)
VALUES ($1, 'page', $2, $3, '[]'::jsonb)
RETURNING id`;

export const INSERT_PAGE_SQL = `
INSERT INTO pages (owner, kind, title, lang, blocks, page)
VALUES ($1, 'rec', $2, $3, '[]'::jsonb, $4::uuid)
RETURNING id, kind, title, lang, page, created_at, updated_at`;

const SET_LAST_TAB_SQL = "UPDATE pages SET last_tab = $3 WHERE owner = $1 AND id = $2";

// 録音の作成時刻はページと同じにする（同じ transaction で入れたページの行から取る。JS の Date を経由しない）
const INSERT_RECORDING_SQL = `
INSERT INTO page_recordings AS r
  (page_id, owner, source, language, engine, duration_sec, source_name, source_sha256, created_at, updated_at)
SELECT p.id, p.owner, $3::text, $4::text, $5::text, $6::numeric, $7::text, $8::text, p.created_at, p.created_at
  FROM pages AS p
 WHERE p.id = $1 AND p.owner = $2
RETURNING ${RECORDING_COLUMNS}`;

// 文字起こし（タブ）を直したらページの更新時刻も進める（サイドバーの更新順に反映する）。pages.revision は #33 のページ本文の保存の番号なので触らない。
export const TOUCH_PAGE_SQL = `
UPDATE pages
   SET updated_at = GREATEST(clock_timestamp(), updated_at)
 WHERE owner = $1 AND id = $2`;

export async function rollback(client: Pick<PoolClient, "query">): Promise<void> {
  await client.query("ROLLBACK").catch(() => undefined);
}

/**
 * 録音ページを作る（VTT の取り込み）: 入れ物と録音のタブ（kind = 'rec'・本文は空）・page_recordings（段落は持たない）を入れ、
 * 題名のフォルダに包んで（#309 の wrapInFolder と同じ）、「文字起こし」ページのタブ（#310。札は「取り込んだ字幕」）に段落と話者名を入れる。
 * 1 つのトランザクション（途中で失敗したらどれも残らない）。形が規則に合わなければ InvalidRecordingError（何も書かない）。
 * `transcript` はその文字起こしのタブ（画面はこれを開く）。
 */
export async function createRecordingPage(
  pool: Connectable,
  owner: OwnerId,
  input: CreateRecordingInput,
): Promise<{ page: RecordingPage; recording: Recording; transcript: string }> {
  assertOwner(owner);
  const data = { segments: input.segments, speakerNames: input.speakerNames ?? {} };
  assertData(data);
  const problem = metadataProblem(input);
  if (problem) throw new InvalidRecordingError(problem);
  const clean = copyData(data);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const holderResult = await client.query<{ id: string }>(INSERT_HOLDER_SQL, [owner, input.title ?? "", input.lang]);
      const holder = holderResult.rows[0];
      if (!holder) throw new Error("editor-store: insert returned no holder");
      const pageResult = await client.query<{ id: string; kind: "rec"; title: string; lang: PageLang; page: string; created_at: Date; updated_at: Date }>(
        INSERT_PAGE_SQL,
        [owner, input.title ?? "", input.lang, holder.id],
      );
      const page = pageResult.rows[0];
      if (!page) throw new Error("editor-store: insert returned no page");
      await client.query(SET_LAST_TAB_SQL, [owner, holder.id, page.id]);
      const recordingResult = await client.query<RecordingRow>(INSERT_RECORDING_SQL, [
        page.id,
        owner,
        input.source,
        input.lang,
        input.engine ?? null,
        input.durationSec ?? null,
        input.sourceName ?? null,
        input.sourceSha256 ?? null,
      ]);
      const recording = recordingResult.rows[0];
      if (!recording) throw new Error("editor-store: insert returned no recording");
      // 段落は「文字起こし」ページのタブへ（#310）。録音は題名のフォルダに包む（1 フォルダ 1 手順。文字起こしのタブはフォルダの中にある）
      const home = await ensureRecordingFolder(client, owner, page.id);
      if (!home) throw new Error("editor-store: recording page vanished before wrapping");
      const engine = input.engine ?? "import";
      const { tab } = await createTranscriptTab(client, owner, home, { engine, language: input.lang, durationSec: input.durationSec ?? null });
      await client.query(
        "UPDATE page_transcripts SET segments = $3::jsonb, speaker_names = $4::jsonb WHERE owner = $1 AND page_id = $2",
        [owner, tab, JSON.stringify(clean.segments), JSON.stringify(clean.speakerNames)],
      );
      await client.query("COMMIT");
      return {
        page: {
          id: page.id,
          kind: "rec",
          title: page.title,
          lang: page.lang,
          page: page.page,
          createdAt: page.created_at.toISOString(),
          updatedAt: page.updated_at.toISOString(),
        },
        recording: toRecording(recording),
        transcript: tab,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    }
  } finally {
    client.release();
  }
}

/** 本人の・ゴミ箱でないページの録音。無ければ null（別の人・存在しない・不正な id・削除済み・録音の無いページ）。 */
export async function getRecording(db: Queryable, owner: OwnerId, pageId: string): Promise<Recording | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  try {
    const result = await db.query<RecordingRow>(GET_SQL, [owner, pageId]);
    const row = result.rows[0];
    return row ? toRecording(row) : null;
  } catch (error) {
    if (isInvalidTextRepresentation(error)) return null;
    throw error;
  }
}
