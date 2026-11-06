/**
 * ブラウザから文字起こしのタブ（#310）の API（`/api/pages/{tab}/transcript`）を呼ぶ（同じ origin。cookie・token は扱わない）。
 * 契約は src/server/transcript-api.ts。書き込みは `baseRevision`（直前の応答の revision）を付け、別の画面が先に直していたら
 * TranscriptConflictError（何も書かれていない。`snapshot` が最新）を投げる。音声・再生・開始は録音のタブの API（recording-client.ts）。
 */
import type { RecordingSegment } from "@niho/editor-store";
import { RecordingRequestError, requestJson, type RecordingSpeaker, type SegmentEditRequest } from "./recording-client";
import { parseTranscriptionRun, type TranscriptionRun } from "./transcription-client";

export type TranscriptView = {
  revision: number;
  /** 元の録音のタブ（音声・再生はこちら）。 */
  recording: string;
  engine: string;
  engineLabel: string;
  language: "ja" | "en";
  durationSec: number | null;
  segments: RecordingSegment[];
  speakerNames: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

/** 文字起こしの読み取りの結果。`run`（このタブに書く最新の実行）は GET のときだけ入る。 */
export type TranscriptSnapshot = { transcript: TranscriptView; speakers: RecordingSpeaker[]; run?: TranscriptionRun | null };

export type TranscriptVersionSummary = {
  version: number;
  reason: "initial" | "edit" | "asr" | "restore";
  engine: string;
  engineLabel: string;
  segmentCount: number;
  createdAt: string;
};

export type TranscriptVersion = TranscriptVersionSummary & {
  language: "ja" | "en";
  durationSec: number | null;
  segments: RecordingSegment[];
  speakerNames: Record<string, string>;
};

/** 別の画面が先に直していた（409）。何も書かれていない。`snapshot` は今の文字起こし。 */
export class TranscriptConflictError extends RecordingRequestError {
  override readonly name: string = "TranscriptConflictError";
  constructor(readonly snapshot: TranscriptSnapshot) {
    super(409, "conflict");
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isSegments(value: unknown): value is RecordingSegment[] {
  return Array.isArray(value) && value.every(
    (segment) => isRecord(segment) && isNullableNumber(segment.start) && isNullableNumber(segment.end) && typeof segment.text === "string"
      && (segment.speaker === null || (typeof segment.speaker === "number" && Number.isSafeInteger(segment.speaker) && segment.speaker >= 1)),
  );
}

function isNames(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((name) => typeof name === "string");
}

function isSpeakers(value: unknown): value is RecordingSpeaker[] {
  return Array.isArray(value) && value.every((item) => isRecord(item) && typeof item.speaker === "number" && (item.name === null || typeof item.name === "string") && typeof item.count === "number");
}

function transcriptOf(value: unknown): TranscriptView | null {
  if (!isRecord(value)) return null;
  const { revision, recording, engine, engineLabel, language, durationSec, segments, speakerNames, createdAt, updatedAt } = value;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return null;
  if (typeof recording !== "string" || !UUID_PATTERN.test(recording) || typeof engine !== "string" || typeof engineLabel !== "string") return null;
  if ((language !== "ja" && language !== "en") || !isNullableNumber(durationSec) || !isSegments(segments) || !isNames(speakerNames)) return null;
  if (typeof createdAt !== "string" || typeof updatedAt !== "string") return null;
  return { revision, recording, engine, engineLabel, language, durationSec, segments, speakerNames, createdAt, updatedAt };
}

function snapshotOf(data: unknown): TranscriptSnapshot | null {
  if (!isRecord(data)) return null;
  const transcript = transcriptOf(data.transcript);
  if (!transcript || !isSpeakers(data.speakers)) return null;
  const snapshot: TranscriptSnapshot = { transcript, speakers: data.speakers };
  if ("run" in data) snapshot.run = data.run === null ? null : parseTranscriptionRun(data.run);
  return snapshot;
}

function transcriptPath(tabId: string, rest = ""): string {
  return `/api/pages/${encodeURIComponent(tabId)}/transcript${rest}`;
}

async function request(path: string, method: "GET" | "POST" | "PATCH", body?: unknown): Promise<TranscriptSnapshot> {
  const { status, data } = await requestJson(path, method, body);
  const snapshot = snapshotOf(data);
  if (status === 409) {
    if (snapshot) throw new TranscriptConflictError(snapshot);
    throw new RecordingRequestError(409, isRecord(data) && typeof data.error === "string" ? data.error : null);
  }
  if (!snapshot) throw new RecordingRequestError(500);
  return snapshot;
}

/** 文字起こしを読む（本文・話者・このタブに書く最新の実行）。文字起こしでないページ・ほかの人のページは 404（RecordingRequestError）。 */
export async function getTranscript(tabId: string): Promise<TranscriptSnapshot> {
  return request(transcriptPath(tabId), "GET");
}

/** このタブに書く最新の run（無ければ null）。use-transcription の `get` に渡す。 */
export async function getTranscriptRun(tabId: string): Promise<TranscriptionRun | null> {
  return (await getTranscript(tabId)).run ?? null;
}

/** 段落の文章を直す（1 回に 200 件まで）。`baseRevision` は直前の応答の revision。 */
export async function editTranscriptSegments(tabId: string, baseRevision: number, edits: readonly SegmentEditRequest[]): Promise<TranscriptSnapshot> {
  return request(transcriptPath(tabId), "PATCH", { baseRevision, edits });
}

/** 話者の名前を変える（null は名前を外し、表示は「話者N」に戻る）。 */
export async function renameTranscriptSpeaker(tabId: string, baseRevision: number, speaker: number, name: string | null): Promise<TranscriptSnapshot> {
  return request(transcriptPath(tabId), "PATCH", { baseRevision, renameSpeaker: { speaker, name } });
}

/** 話者 from を into にまとめる（from の段落が into になり、元には戻せない）。 */
export async function mergeTranscriptSpeakers(tabId: string, baseRevision: number, from: number, into: number): Promise<TranscriptSnapshot> {
  return request(transcriptPath(tabId), "PATCH", { baseRevision, mergeSpeakers: { from, into } });
}

/** あとの音声の文字起こし（.vtt）を、このタブに足す（時刻は server が前の音声の長さだけずらす）。 */
export async function appendTranscriptVtt(tabId: string, baseRevision: number, input: { name: string; vtt: string }): Promise<TranscriptSnapshot> {
  return request(transcriptPath(tabId), "PATCH", { baseRevision, appendVtt: input });
}

function isVersionSummary(value: unknown): value is TranscriptVersionSummary {
  if (!isRecord(value)) return false;
  return typeof value.version === "number" && Number.isSafeInteger(value.version) && value.version >= 1
    && ["initial", "edit", "asr", "restore"].includes(String(value.reason))
    && typeof value.engine === "string" && typeof value.engineLabel === "string"
    && typeof value.segmentCount === "number" && Number.isSafeInteger(value.segmentCount) && value.segmentCount >= 0
    && typeof value.createdAt === "string";
}

/** 直す前の本文の版（新しい順・最大 100 件。本文なし）。 */
export async function listTranscriptVersions(tabId: string): Promise<TranscriptVersionSummary[]> {
  const { data } = await requestJson(transcriptPath(tabId, "/versions"), "GET");
  const versions = isRecord(data) ? data.versions : null;
  if (!Array.isArray(versions) || !versions.every(isVersionSummary)) throw new RecordingRequestError(500);
  return versions;
}

/** 1 つの版（本文つき）。 */
export async function getTranscriptVersion(tabId: string, version: number): Promise<TranscriptVersion> {
  const { data } = await requestJson(transcriptPath(tabId, `/versions/${version}`), "GET");
  const found: unknown = isRecord(data) ? data.version : null;
  if (!isRecord(found) || !isVersionSummary(found)) throw new RecordingRequestError(500);
  const { language, durationSec, segments, speakerNames } = found as Record<string, unknown>;
  if ((language !== "ja" && language !== "en") || !isNullableNumber(durationSec) || !isSegments(segments) || !isNames(speakerNames)) throw new RecordingRequestError(500);
  return found as unknown as TranscriptVersion;
}

/** その版に戻す（今の本文は版に残る）。`baseRevision` は直前の応答の revision。 */
export async function restoreTranscriptVersion(tabId: string, version: number, baseRevision: number): Promise<TranscriptSnapshot> {
  return request(transcriptPath(tabId, `/versions/${version}/restore`), "POST", { baseRevision });
}

/** 版の理由の短い日本語。 */
export function versionReasonLabel(reason: TranscriptVersionSummary["reason"]): string {
  return { initial: "はじめ", edit: "直す前", asr: "文字起こしの前", restore: "戻す前" }[reason];
}
