/**
 * ブラウザから録音と文字起こしの API（`/api/recordings/import-vtt`・`/api/pages/{id}/recording`）を呼ぶ（同じ origin。cookie・token は扱わない）。
 * 契約は src/server/recordings-api.ts。書き込みは `baseRevision`（直前の応答の revision）を付け、別の画面が先に直していたら
 * RecordingConflictError（何も書かれていない。`snapshot` が最新）を投げる。
 */
import type { Recording, RecordingSegment } from "@niho/editor-store";
import type { AudioPartView } from "./audio-upload-client";

/** VTT のファイルの上限（server の VTT_IMPORT_MAX_BYTES と同じ。超える分は送る前に断る）。 */
export const VTT_FILE_MAX_BYTES = 4 * 1024 * 1024;
/** 1 回の `edits` の上限（server の SEGMENT_EDITS_MAX と同じ）。 */
export const SEGMENT_EDITS_MAX = 200;
/** 応答の無い要求を待つ上限。 */
const REQUEST_TIMEOUT_MS = 60_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 話者の一覧の 1 行（段落の数つき）。name が null の話者は、表示で「話者N」と呼ぶ。 */
export type RecordingSpeaker = { speaker: number; name: string | null; count: number };
/** 文字起こしの案（#36 段 3b-4。一覧に出す分。本文は getCandidate で読む）。 */
export type RecordingCandidateSummary = {
  id: string;
  name: string;
  engine: string | null;
  /** 画面に出すエンジンの名前。 */
  engineLabel: string;
  language: "ja" | "en";
  durationSec: number | null;
  /** 採用中（この案の本文が正本に入っている）。 */
  adopted: boolean;
  /** pending=作っている・ready=できた・failed=できなかった。 */
  state: "pending" | "ready" | "failed";
  segmentCount: number;
  preview: string[];
  createdAt: string;
  updatedAt: string;
};

export type RecordingCandidateFull = RecordingCandidateSummary & { segments: RecordingSegment[]; speakerNames: Record<string, string> };

/**
 * 録音の読み取りの結果。`audios`（音声の列）と `candidates`（文字起こしの案）は GET のときだけ入る
 * （書き換えの応答には入らないので、画面は前の値を残す）。
 */
export type RecordingSnapshot = {
  recording: Recording;
  speakers: RecordingSpeaker[];
  audios?: AudioPartView[];
  candidates?: RecordingCandidateSummary[];
  /** いま使えるエンジン（2 つ以上あれば、案のエンジンを選べる）。 */
  engines?: string[];
};
/** 取り込みで作った録音ページ。 */
export type ImportedRecordingPage = { id: string; title: string; lang: "ja" | "en" };
export type ImportedRecording = RecordingSnapshot & { page: ImportedRecordingPage };

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

/** 別の画面が先に直していた（409）。何も書かれていない。`snapshot` は今の録音。 */
export class RecordingConflictError extends RecordingRequestError {
  override readonly name: string = "RecordingConflictError";
  constructor(readonly snapshot: RecordingSnapshot) {
    super(409, "conflict");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isSpeakerNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isRecording(value: unknown): value is Recording {
  if (!isRecord(value)) return false;
  const { revision, segments, speakerNames, source, language } = value;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return false;
  if ((source !== "vtt" && source !== "audio") || (language !== "ja" && language !== "en")) return false;
  if (!isNullableNumber(value.durationSec)) return false;
  if (!Array.isArray(segments) || !isRecord(speakerNames) || !Object.values(speakerNames).every((name) => typeof name === "string")) return false;
  return segments.every(
    (segment) => isRecord(segment) && isNullableNumber(segment.start) && isNullableNumber(segment.end) && typeof segment.text === "string" && (segment.speaker === null || isSpeakerNumber(segment.speaker)),
  );
}

function isSpeakers(value: unknown): value is RecordingSpeaker[] {
  return (
    Array.isArray(value) &&
    value.every((item) => isRecord(item) && isSpeakerNumber(item.speaker) && (item.name === null || typeof item.name === "string") && typeof item.count === "number")
  );
}

function isAudioPart(value: unknown): value is AudioPartView {
  if (!isRecord(value)) return false;
  const { partIndex, status, offsetSec } = value;
  return typeof partIndex === "number" && (status === "uploading" || status === "uploaded") && typeof offsetSec === "number";
}

function isCandidate(value: unknown): value is RecordingCandidateSummary {
  if (!isRecord(value)) return false;
  const { id, name, state, adopted } = value;
  return typeof id === "string" && typeof name === "string" && (state === "pending" || state === "ready" || state === "failed") && typeof adopted === "boolean";
}

function snapshotOf(data: unknown): RecordingSnapshot | null {
  if (!isRecord(data) || !isRecording(data.recording) || !isSpeakers(data.speakers)) return null;
  const snapshot: RecordingSnapshot = { recording: data.recording, speakers: data.speakers };
  if (Array.isArray(data.audios)) snapshot.audios = data.audios.filter(isAudioPart);
  if (Array.isArray(data.candidates)) snapshot.candidates = data.candidates.filter(isCandidate);
  if (Array.isArray(data.engines)) snapshot.engines = data.engines.filter((engine): engine is string => typeof engine === "string");
  return snapshot;
}

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;
}

async function request(path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown): Promise<unknown> {
  const signal = timeoutSignal();
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch {
    // つながらない・時間切れ
    throw new RecordingRequestError(0);
  }
  if (response.status === 409) {
    const body: unknown = await response.json().catch(() => null);
    const snapshot = snapshotOf(body);
    if (snapshot) throw new RecordingConflictError(snapshot);
    // 競合の形でない 409（案が未完成・案が多すぎる・始められない）は、短い code を reason にして返す
    const reason = isRecord(body) ? [body.reason, body.error].find((value) => typeof value === "string") : undefined;
    throw new RecordingRequestError(409, typeof reason === "string" ? reason : null);
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { reason?: unknown } | null;
    throw new RecordingRequestError(response.status, response.status === 400 && typeof data?.reason === "string" ? data.reason : null);
  }
  try {
    return await response.json();
  } catch {
    throw new RecordingRequestError(500);
  }
}

function recordingPath(pageId: string): string {
  return `/api/pages/${encodeURIComponent(pageId)}/recording`;
}

function snapshotOrThrow(data: unknown): RecordingSnapshot {
  const snapshot = snapshotOf(data);
  if (!snapshot) throw new RecordingRequestError(500);
  return snapshot;
}

/** VTT を取り込んで録音ページを作る。題名は name（ファイル名）から server が決める。 */
export async function importVtt(input: { name: string; vtt: string; lang?: "ja" | "en" }): Promise<ImportedRecording> {
  const data = await request("/api/recordings/import-vtt", "POST", input);
  const snapshot = snapshotOrThrow(data);
  const page = (data as { page?: Record<string, unknown> }).page;
  const { id, title, lang } = page ?? {};
  if (typeof id !== "string" || !UUID_PATTERN.test(id) || typeof title !== "string" || (lang !== "ja" && lang !== "en")) throw new RecordingRequestError(500);
  return { ...snapshot, page: { id, title, lang } };
}

/** 録音を読む。録音の無いページ・ほかの人のページは 404（RecordingRequestError）。 */
export async function getRecording(pageId: string): Promise<RecordingSnapshot> {
  return snapshotOrThrow(await request(recordingPath(pageId), "GET"));
}

/** 段落の文章を直す（1 回に 200 件まで）。`baseRevision` は直前の応答の revision。 */
export async function editSegments(pageId: string, baseRevision: number, edits: readonly SegmentEditRequest[]): Promise<RecordingSnapshot> {
  return snapshotOrThrow(await request(recordingPath(pageId), "PATCH", { baseRevision, edits }));
}

/** 話者の名前を変える（null は名前を外し、表示は「話者N」に戻る）。 */
export async function renameSpeaker(pageId: string, baseRevision: number, speaker: number, name: string | null): Promise<RecordingSnapshot> {
  return snapshotOrThrow(await request(recordingPath(pageId), "PATCH", { baseRevision, renameSpeaker: { speaker, name } }));
}

/** 話者 from を into にまとめる（from の段落が into になり、元には戻せない）。 */
export async function mergeSpeakers(pageId: string, baseRevision: number, from: number, into: number): Promise<RecordingSnapshot> {
  return snapshotOrThrow(await request(recordingPath(pageId), "PATCH", { baseRevision, mergeSpeakers: { from, into } }));
}

/**
 * あとの音声の文字起こし（.vtt）を、この録音ページに足す（#36 段 3b-3）。時刻は server が前の音声の長さだけずらす。
 * 4 MiB を超える .vtt は送る前に断る（VTT_FILE_MAX_BYTES）。
 */
export async function appendVtt(pageId: string, baseRevision: number, input: { name: string; vtt: string }): Promise<RecordingSnapshot> {
  return snapshotOrThrow(await request(recordingPath(pageId), "PATCH", { baseRevision, appendVtt: input }));
}

/** 文字起こしの案（#36 段 3b-4）。 */
function candidatePath(pageId: string, candidateId?: string): string {
  const base = `${recordingPath(pageId)}/candidates`;
  return candidateId === undefined ? base : `${base}/${encodeURIComponent(candidateId)}`;
}

function candidateOrThrow(data: unknown): RecordingCandidateFull {
  const candidate = isRecord(data) ? data.candidate : null;
  if (!isCandidate(candidate) || !Array.isArray((candidate as { segments?: unknown }).segments)) throw new RecordingRequestError(500);
  return candidate as RecordingCandidateFull;
}

function candidatesOf(data: unknown): RecordingCandidateSummary[] {
  const list = isRecord(data) ? data.candidates : null;
  return Array.isArray(list) ? list.filter(isCandidate) : [];
}

/** 案 1 つ（本文つき。見比べるときに読む）。 */
export async function getCandidate(pageId: string, candidateId: string): Promise<RecordingCandidateFull> {
  return candidateOrThrow(await request(candidatePath(pageId, candidateId), "GET"));
}

export type AddedCandidate = {
  candidate: RecordingCandidateSummary;
  candidates: RecordingCandidateSummary[];
  /** 積んだ実行（積めなかったときは null。`cannotStart` に理由）。 */
  started: boolean;
  cannotStart: string | null;
};

/** 別のエンジンの案を作って、その案の文字起こしを始める（engine は使えるエンジンだけ。省けばサーバーの既定）。 */
export async function addCandidate(pageId: string, engine?: string): Promise<AddedCandidate> {
  const data = await request(candidatePath(pageId), "POST", engine === undefined ? {} : { engine });
  const candidates = candidatesOf(data);
  const candidate = isRecord(data) && isCandidate(data.candidate) ? data.candidate : null;
  if (!candidate) throw new RecordingRequestError(500);
  const cannotStart = isRecord(data) && typeof data.cannotStart === "string" ? data.cannotStart : null;
  return { candidate, candidates, started: isRecord(data) && data.run !== null && data.run !== undefined, cannotStart };
}

/** その案を採用する（正本に写す）。応答は最新の録音・話者・案。 */
export async function adoptCandidate(pageId: string, candidateId: string): Promise<RecordingSnapshot & { candidates: RecordingCandidateSummary[] }> {
  const data = await request(`${candidatePath(pageId, candidateId)}/adopt`, "POST");
  return { ...snapshotOrThrow(data), candidates: candidatesOf(data) };
}

/** その案の文字起こしをもう一度始める。 */
export async function retryCandidate(pageId: string, candidateId: string): Promise<void> {
  await request(`${candidatePath(pageId, candidateId)}/transcribe`, "POST");
}

/** 要らなくなった案を消す（採用中・実行中は消せない）。応答は残った案。 */
export async function deleteCandidate(pageId: string, candidateId: string): Promise<RecordingCandidateSummary[]> {
  return candidatesOf(await request(candidatePath(pageId, candidateId), "DELETE"));
}

/** 失敗が起きた操作（同じ reason でも、何についての失敗かで文言が替わる）。 */
export type RecordingAction = "load" | "import" | "edit" | "rename" | "merge" | "append" | "candidate" | "adopt" | "delete_candidate";

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
  // 案（#36 段 3b-4）
  not_ready: "この案はまだできていません。できてから採用できます。",
  too_many: "案はこれ以上作れません。使わない案を採用し直してから試してください。",
  audio_not_ready: "音声の取り込みが終わっていません。",
  audio_expired: "音声は削除されました。",
  has_transcript: "文字起こしがすでにあります。",
  other_run_active: "ほかの文字起こしを作っている途中です。できてから、もう一度試してください。",
  adopted: "採用中の案は消せません。別の案を採用してから消してください。",
  running: "この案は作っている途中です。できてから消してください。",
  transcription_unavailable: "いまは文字起こしを始められません。少ししてから、もう一度試してください。",
};

/** 失敗を、画面に出す日本語の短い文言にする。reason は server の 400 の reason と対応する。 */
export function recordingErrorMessage(error: unknown, action: RecordingAction): string {
  if (!(error instanceof RecordingRequestError)) return "うまくいきませんでした。もう一度試してください。";
  const { status, reason } = error;
  if (status === 409) {
    // 案の 409 は競合ではなく、始められない・採用できない理由
    const message = reason ? REASON_MESSAGES[reason] : undefined;
    if ((action === "candidate" || action === "adopt" || action === "delete_candidate") && message) return message;
    return CONFLICT_MESSAGE;
  }
  if (status === 0) return "つながりませんでした。ネットワークを確かめて、もう一度試してください。";
  if (status === 401) return "ログインが切れました。ログインし直してください。";
  if (status === 403) return "この画面からは変更できません。ページを開き直してください。";
  if (status === 404) return action === "load" ? "このページには文字起こしがありません。" : "この録音が見つかりません。ページを開き直してください。";
  if (status === 413 && action === "append") return "ファイルが大きすぎます。足せる .vtt は 4 MiB までです。";
  if (status === 413) return "ファイルが大きすぎます。.vtt は 4 MiB までです。";
  if (status === 503) {
    return action === "candidate" ? REASON_MESSAGES.transcription_unavailable! : "いまサーバーが使えません。少ししてから、もう一度試してください。";
  }
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
