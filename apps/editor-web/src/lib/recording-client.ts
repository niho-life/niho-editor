/**
 * ブラウザから録音の API（`/api/recordings/import-vtt`・`/api/pages/{id}/recording`）を呼ぶ（同じ origin。cookie・token は扱わない）。
 * 文字起こしのタブの本文（段落の編集・話者・版）は lib/transcript-client.ts（#310）。ここは録音そのもの（音声・長さ・タブの一覧）。
 * 契約は src/server/recordings-api.ts。
 */
import type { Recording } from "@niho/editor-store";
import type { AudioPartView } from "./audio-upload-client";

/** VTT のファイルの上限（server の VTT_IMPORT_MAX_BYTES と同じ。超える分は送る前に断る）。 */
export const VTT_FILE_MAX_BYTES = 4 * 1024 * 1024;
/** 1 回の `edits` の上限（server の SEGMENT_EDITS_MAX と同じ）。 */
export const SEGMENT_EDITS_MAX = 200;
/** 応答の無い要求を待つ上限。 */
const REQUEST_TIMEOUT_MS = 60_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 話者の一覧の 1 行（段落の数つき。文字起こしのタブの応答。lib/transcript-client.ts）。name が null の話者は、表示で「話者N」と呼ぶ。 */
export type RecordingSpeaker = { speaker: number; name: string | null; count: number };
/** この録音から作った文字起こしのタブ（#310。本文は lib/transcript-client.ts で読む）。 */
export type TranscriptTabView = {
  id: string;
  /** タブの帯と同じ札（付けた名前か、位置の番号）。 */
  label: string;
  engine: string;
  engineLabel: string;
  language: "ja" | "en";
  durationSec: number | null;
  segmentCount: number;
  revision: number;
  updatedAt: string;
};

/**
 * 録音の読み取りの結果。`audios`（音声の列）と `transcripts`（文字起こしのタブ）は GET のときだけ入る
 * （取り込みの応答には入らないので、画面は前の値を残す）。
 */
export type RecordingSnapshot = {
  recording: Recording;
  audios?: AudioPartView[];
  transcripts?: TranscriptTabView[];
  /** いま使えるエンジン（流れの「文字起こし 作成 ▾」の候補。「もう一度」が同じエンジンで書き直せるか）。 */
  engines?: string[];
  /** 通常の文字起こしの送信先。画面に正確な送信先を示す。 */
  defaultEngine?: string | null;
};
/** 取り込みで作った録音ページ。 */
export type ImportedRecordingPage = { id: string; title: string; lang: "ja" | "en" };
/** 取り込みの結果。`transcript` は段落を入れた文字起こしのタブ（画面はこれを開く。#310）。 */
export type ImportedRecording = RecordingSnapshot & { page: ImportedRecordingPage; transcript: string };

export type SegmentEditRequest = { index: number; text: string };

/** 失敗した要求。status は HTTP の状態（つながらなかった・時間切れは 0）、reason は 400 の `reason`。 */
export class RecordingRequestError extends Error {
  override readonly name: string = "RecordingRequestError";
  constructor(
    readonly status: number,
    readonly reason: string | null = null,
  ) {
    super(`recording request failed with ${status}${reason ? ` (${reason})` : ""}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isRecording(value: unknown): value is Recording {
  if (!isRecord(value)) return false;
  const { revision, source, language } = value;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return false;
  if ((source !== "vtt" && source !== "audio") || (language !== "ja" && language !== "en")) return false;
  return isNullableNumber(value.durationSec);
}

function isAudioPart(value: unknown): value is AudioPartView {
  if (!isRecord(value)) return false;
  const { partIndex, status, offsetSec } = value;
  return typeof partIndex === "number" && (status === "uploading" || status === "uploaded") && typeof offsetSec === "number";
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isTranscriptTab(value: unknown): value is TranscriptTabView {
  if (!isRecord(value)) return false;
  const { id, label, engine, engineLabel, language, durationSec, segmentCount, revision, updatedAt } = value;
  return typeof id === "string" && UUID_PATTERN.test(id) && typeof label === "string" && typeof engine === "string" && typeof engineLabel === "string" &&
    (language === "ja" || language === "en") && isNullableNumber(durationSec) && typeof segmentCount === "number" && Number.isSafeInteger(segmentCount) && segmentCount >= 0 &&
    positiveInteger(revision) && typeof updatedAt === "string";
}

function snapshotOf(data: unknown): RecordingSnapshot | null {
  if (!isRecord(data) || !isRecording(data.recording)) return null;
  const snapshot: RecordingSnapshot = { recording: data.recording };
  if (Array.isArray(data.audios)) snapshot.audios = data.audios.filter(isAudioPart);
  if (Array.isArray(data.transcripts)) snapshot.transcripts = data.transcripts.filter(isTranscriptTab);
  if (Array.isArray(data.engines)) snapshot.engines = data.engines.filter((engine): engine is string => typeof engine === "string");
  if (data.defaultEngine === null || typeof data.defaultEngine === "string") snapshot.defaultEngine = data.defaultEngine;
  return snapshot;
}

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;
}

/**
 * 要求を送って JSON を読む（文字起こしのタブの API（lib/transcript-client.ts）も使う）。
 * 2xx と 409 は `{ status, data }` を返す（409 の中身は呼ぶ側が競合の形に組む）。それ以外は RecordingRequestError（400 は reason つき）。
 */
export async function requestJson(path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown, retryNetwork = false): Promise<{ status: number; data: unknown }> {
  let response: Response;
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  let attempts = retryNetwork ? 2 : 1;
  for (;;) {
    try {
      const signal = timeoutSignal();
      response = await fetch(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        ...(serialized === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: serialized }),
        ...(signal ? { signal } : {}),
      });
      break;
    } catch {
      attempts -= 1;
      if (attempts <= 0) throw new RecordingRequestError(0);
    }
  }
  if (response.status === 409) return { status: 409, data: await response.json().catch(() => null) };
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { reason?: unknown } | null;
    throw new RecordingRequestError(response.status, response.status === 400 && typeof data?.reason === "string" ? data.reason : null);
  }
  try {
    return { status: response.status, data: await response.json() };
  } catch {
    throw new RecordingRequestError(500);
  }
}

async function request(path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown, retryNetwork = false): Promise<unknown> {
  const { status, data } = await requestJson(path, method, body, retryNetwork);
  if (status === 409) {
    // 始められない 409 は、短い code を reason にして返す
    const reason = isRecord(data) ? [data.reason, data.error].find((value) => typeof value === "string") : undefined;
    throw new RecordingRequestError(409, typeof reason === "string" ? reason : null);
  }
  return data;
}

function recordingPath(pageId: string): string {
  return `/api/pages/${encodeURIComponent(pageId)}/recording`;
}

function snapshotOrThrow(data: unknown): RecordingSnapshot {
  const snapshot = snapshotOf(data);
  if (!snapshot) throw new RecordingRequestError(500);
  return snapshot;
}

/** VTT を取り込んで録音ページと文字起こしのタブを作る。題名は name（ファイル名）から server が決める。 */
export async function importVtt(input: { name: string; vtt: string; lang?: "ja" | "en" }): Promise<ImportedRecording> {
  const data = await request("/api/recordings/import-vtt", "POST", input);
  const snapshot = snapshotOrThrow(data);
  const page = (data as { page?: Record<string, unknown> }).page;
  const transcript = (data as { transcript?: unknown }).transcript;
  const { id, title, lang } = page ?? {};
  if (typeof id !== "string" || !UUID_PATTERN.test(id) || typeof title !== "string" || (lang !== "ja" && lang !== "en")) throw new RecordingRequestError(500);
  if (typeof transcript !== "string" || !UUID_PATTERN.test(transcript)) throw new RecordingRequestError(500);
  return { ...snapshot, page: { id, title, lang }, transcript };
}

/** 録音を読む。録音の無いページ・ほかの人のページは 404（RecordingRequestError）。 */
export async function getRecording(pageId: string): Promise<RecordingSnapshot> {
  return snapshotOrThrow(await request(recordingPath(pageId), "GET"));
}

/** 失敗が起きた操作（同じ reason でも、何についての失敗かで文言が替わる）。 */
export type RecordingAction = "load" | "import" | "edit" | "rename" | "merge" | "append";

export const CONFLICT_MESSAGE = "別の場所で先に直されました。最新に合わせました";

const REASON_MESSAGES: Record<string, string> = {
  body: "送る内容を読み取れませんでした。ページを開き直してください。",
  lang: "言語を読み取れませんでした。ページを開き直してください。",
  vtt_empty: "字幕の中身が空です。文字起こしのある .vtt ファイルを選んでください。",
  vtt_too_large: "ファイルが大きすぎます。.vtt は 4 MiB まで、段落は 20,000 個までです。",
  vtt_invalid: "この .vtt ファイルを読み取れませんでした。WebVTT の形式か確かめてください。",
  index: "直す段落が見つかりません。ページを開き直してください。",
  text: "段落の文章が使えません。1 段落は 5,000 字までです。",
  speaker: "この話者が見つかりません。ページを開き直してください。",
  merge: "同じ話者にはまとめられません。",
  append_empty: "この .vtt には発言がありません。文字起こしのある .vtt ファイルを選んでください。",
  append_too_large: "足すと文字起こしが大きすぎます。段落は 20,000 個まで、本文は合わせて 8 MiB までです。",
  append_invalid: "この .vtt の時刻か文字を読み取れませんでした。WebVTT の形式か確かめてください。",
  audio_not_ready: "音声の取り込みが終わっていません。",
  audio_expired: "音声は削除されました。",
  tab_missing: "この文字起こしのタブには書き直せません。ページを開き直してください。",
  transcription_unavailable: "いまは文字起こしを始められません。少ししてから、もう一度試してください。",
};

/** 失敗を、画面に出す日本語の短い文言にする。reason は server の 400 の reason と対応する。 */
export function recordingErrorMessage(error: unknown, action: RecordingAction): string {
  if (!(error instanceof RecordingRequestError)) return "うまくいきませんでした。もう一度試してください。";
  const { status, reason } = error;
  if (status === 409) return (reason && REASON_MESSAGES[reason]) || CONFLICT_MESSAGE;
  if (status === 0) return "つながりませんでした。ネットワークを確かめて、もう一度試してください。";
  if (status === 401) return "ログインが切れました。ログインし直してください。";
  if (status === 403) return "この画面からは変更できません。ページを開き直してください。";
  if (status === 404) return action === "load" ? "このページには文字起こしがありません。" : "この録音が見つかりません。ページを開き直してください。";
  if (status === 413 && action === "append") return "ファイルが大きすぎます。足せる .vtt は 4 MiB までです。";
  if (status === 413) return "ファイルが大きすぎます。.vtt は 4 MiB までです。";
  if (status === 503) return "いまサーバーが使えません。少ししてから、もう一度試してください。";
  if (status === 400) {
    if (reason === "name") {
      if (action === "append") return "ファイル名が使えません。ファイル名を変えて、もう一度選んでください。";
      return action === "import"
        ? "ファイル名が使えません。ファイル名を変えて、もう一度選んでください。"
        : "この名前は使えません。60 字まで、改行とコロンは使えません。「話者1」の形や、ほかの話者と同じ名前も使えません。";
    }
    const message = reason ? REASON_MESSAGES[reason] : undefined;
    if (message) return message;
  }
  return "サーバーで問題が起きました。少ししてから、もう一度試してください。";
}
