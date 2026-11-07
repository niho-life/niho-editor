import { isLanguage } from "@niho/docs-core";
import {
  tabLabel,
  transcriptEngineLabel,
  type AudioPart,
  type CreateRecordingInput,
  type OwnerId,
  type PageLang,
  type Recording,
  type RecordingMutation,
  type RecordingPage,
  type TranscriptTabSummary,
  type TranscriptionRunView,
} from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { appendTranscript, type AppendRejection } from "../recording/append-transcript";
import { audioPartBody } from "./audio-api";
import type { TranscriptionEngineName } from "../transcription/engine";
import { SEGMENT_EDITS_MAX, editSegments, type SegmentEdit, type SegmentEditRejection } from "../recording/edit-segments";
import { mergeSpeakers, renameSpeaker, type SpeakerRejection } from "../recording/speakers";
import { VTT_IMPORT_ENGINE, VTT_IMPORT_MAX_BYTES, importVtt, readVtt, type VttImportFailure } from "../recording/vtt-import";
import { errorResponse, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";
import { transcriptionRunBody } from "./transcription-api";

/**
 * 録音と文字起こし（#36 段 1 → #310）の API: VTT の取り込み（録音ページと文字起こしのタブを作る）と、録音の読み取り（音声・実行・
 * 文字起こしのタブの一覧）。段落の編集・話者名・話者をまとめる・あとの音声の文字起こし（.vtt）を足す書き換えの要求の形
 * （`parseRecordingPatch`）は、文字起こしのタブの API（transcript-api.ts）が使う。録音そのものは段落を持たない（#310）。
 * 全て本人の・ゴミ箱でないページだけ。未認証 401、DB なし 503、別の人・存在しない・不正な id・削除済み・録音の無いページは同じ 404、
 * 更新系は同じ origin の画面からだけ（違えば 403）。エラーの本文は短い code と理由だけ（内部の情報を出さない）。
 */

export type RecordingMutationRejection = SpeakerRejection | SegmentEditRejection | AppendRejection;

/** 録音の API が使う store の操作（packages/editor-store の関数に Pool を渡したもの）。null はページ（録音）が無い。 */
export type RecordingsStore = {
  /** VTT の取り込み（`transcript` は段落を入れた文字起こしのタブ。#310）。 */
  createRecordingPage: (owner: OwnerId, input: CreateRecordingInput) => Promise<{ page: RecordingPage; recording: Recording; transcript: string }>;
  getRecording: (owner: OwnerId, pageId: string) => Promise<Recording | null>;
  /** 最新の文字起こしの run（#36 段 2b）。あれば GET の応答に `transcription`（run が無ければ null）を足す。 */
  latestTranscription?: (owner: OwnerId, pageId: string) => Promise<TranscriptionRunView | null>;
  /** 音声の列（#36 段 3b-4）。あれば GET の応答に `audios` を足す。 */
  listAudioParts?: (owner: OwnerId, pageId: string) => Promise<AudioPart[]>;
  /** この録音から作った文字起こしのタブ（#310。入れ物の中の並び）。あれば GET の応答に `transcripts` を足す。 */
  listTranscripts?: (owner: OwnerId, pageId: string) => Promise<TranscriptTabSummary[]>;
};

/** いま使えるエンジンの名前（画面が案のエンジンを選べるか決める）。 */
export type RecordingEnginesReader = () => readonly string[];
export type DefaultRecordingEngineReader = () => TranscriptionEngineName | null;

export type RecordingsApiDeps = {
  auth: () => AuthProvider;
  /** DB が使えないときは null（503）。 */
  store: () => RecordingsStore | null;
  /** いま使えるエンジン（#36 段 3b-4。無ければ空＝画面はエンジンを選ばない）。 */
  engines?: RecordingEnginesReader;
  /** 通常の文字起こしで音声を送る先。 */
  defaultEngine?: DefaultRecordingEngineReader;
  env?: Readonly<Record<string, string | undefined>>;
};

/**
 * 取り込みの要求の本文の上限。VTT（4 MiB）を JSON の文字列にすると改行・引用符が `\n`・`\"` の 2 バイトになるので、
 * その分の余裕（1 MiB）を足す。超えたら 413。VTT が 4 MiB を超えるだけなら 400（vtt_too_large）。
 */
export const VTT_IMPORT_BODY_MAX_BYTES = VTT_IMPORT_MAX_BYTES + 1024 * 1024;
/**
 * 文字起こしの書き換えの要求の本文の上限。段落 200 件 × 5,000 文字が日本語で収まる 4 MiB に、`appendVtt`（4 MiB までの VTT を
 * JSON の文字列にしたもの）が入る余裕（1 MiB）を足す（取り込みの VTT_IMPORT_BODY_MAX_BYTES と同じ）。
 */
export const RECORDING_PATCH_BODY_MAX_BYTES = VTT_IMPORT_BODY_MAX_BYTES;

export type BadRequestReason = "body" | "name" | "lang" | VttImportFailure | RecordingMutationRejection;

function badRequest(reason: BadRequestReason): Response {
  return jsonResponse(400, { error: "bad_request", reason });
}

/**
 * 想定外の失敗は 500 の汎用エラー（内部の情報は応答に出さず、ログにも名前と code だけを書く。本文・話者名を出さない）。
 * pages-api.ts の guarded と同じ（#33 と並行して触らないよう、ここに置いている）。
 */
async function guarded(route: string, handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
    console.error("editor-web: request failed", { route, name, code });
    return errorResponse("internal");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** 応答に載せる録音（決まった項目だけ。store が何を足しても他の値を出さない）。 */
function recordingBody(recording: Recording) {
  return {
    revision: recording.revision,
    source: recording.source,
    language: recording.language,
    engine: recording.engine,
    durationSec: recording.durationSec,
    sourceName: recording.sourceName,
    sourceSha256: recording.sourceSha256,
    // 音声（#36 段 2a）。音声の無い録音は null。bytes・contentType は申告の値、expiresAt は保存先から消える見込みの時刻
    audio: recording.audio
      ? { status: recording.audio.status, bytes: recording.audio.bytes, contentType: recording.audio.contentType, expiresAt: recording.audio.expiresAt }
      : null,
    createdAt: recording.createdAt,
    updatedAt: recording.updatedAt,
  };
}

/** 録音の応答（`{ recording }`。GET と同じ形。音声の API（audio-api.ts）も使う）。段落・話者は文字起こしのタブの API（`{ transcript, speakers }`）。 */
export function withRecording(recording: Recording): { recording: ReturnType<typeof recordingBody> } {
  return { recording: recordingBody(recording) };
}

/** 応答に載せる文字起こしのタブの 1 行（#310。本文は `/api/pages/{tab}/transcript`）。`label` はタブの帯と同じ札。 */
export function transcriptTabBody(tab: TranscriptTabSummary) {
  return {
    id: tab.id,
    label: tabLabel({ tabName: tab.tabName, tabPos: tab.tabPos }),
    engine: tab.engine,
    engineLabel: transcriptEngineLabel(tab.engine),
    language: tab.language,
    durationSec: tab.durationSec,
    segmentCount: tab.segmentCount,
    revision: tab.revision,
    updatedAt: tab.updatedAt,
  };
}

/** 本文を読む。JSON でない・形が違うは 400（reason: body）、大きすぎるは 413。 */
async function readBody(request: Request, limit: number): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const body = await readJsonBody(request, limit);
  if (body.ok) return body;
  return { ok: false, response: body.response.status === 400 ? badRequest("body") : body.response };
}

type ImportRequest = { name: string; vtt: string; lang: PageLang };

function parseImport(body: unknown): { ok: true; value: ImportRequest } | { ok: false; reason: BadRequestReason } {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["name", "vtt", "lang"])) return { ok: false, reason: "body" };
  if (typeof body.vtt !== "string") return { ok: false, reason: "body" };
  if (typeof body.name !== "string") return { ok: false, reason: "name" };
  let lang: PageLang = "ja";
  if (body.lang !== undefined) {
    // 言語の値の範囲は docs-core（NIHO docs の中核）と同じ ja | en
    if (!isLanguage(body.lang)) return { ok: false, reason: "lang" };
    lang = body.lang;
  }
  return { ok: true, value: { name: body.name, vtt: body.vtt, lang } };
}

/** POST /api/recordings/import-vtt — VTT を取り込んで録音ページと文字起こしのタブを作る（201 で `{ page, transcript, recording }`。#310）。 */
export function importVttRoute(request: Request, deps: RecordingsApiDeps): Promise<Response> {
  return guarded("POST /api/recordings/import-vtt", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const body = await readBody(request, VTT_IMPORT_BODY_MAX_BYTES);
    if (!body.ok) return body.response;
    const parsed = parseImport(body.value);
    if (!parsed.ok) return badRequest(parsed.reason);
    const imported = importVtt(parsed.value);
    if (!imported.ok) return badRequest(imported.reason);
    const { value } = imported;
    // owner は認証の層の本人だけ（要求の値からは決めない）
    const created = await store.createRecordingPage(session.userId, {
      title: value.title,
      lang: value.language,
      source: "vtt",
      engine: VTT_IMPORT_ENGINE,
      durationSec: value.durationSec,
      sourceName: value.sourceName,
      sourceSha256: value.sourceSha256,
      segments: value.segments,
      speakerNames: value.speakerNames,
    });
    return jsonResponse(201, { page: created.page, transcript: created.transcript, ...withRecording(created.recording) });
  });
}

/**
 * GET /api/pages/{id}/recording — 録音（`{ recording, transcription, audios, transcripts, engines, defaultEngine }`）。
 * transcription は最新の文字起こしの run（#36 段 2b。無ければ null）、audios は音声の列（#36 段 3b-4。足した順）、
 * transcripts はこの録音から作った文字起こしのタブ（#310。入れ物の中の並び。無ければ空）。無ければ同じ 404。
 */
export function getRecordingRoute(request: Request, id: string, deps: RecordingsApiDeps): Promise<Response> {
  return guarded("GET /api/pages/[id]/recording", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const recording = await store.getRecording(session.userId, id);
    if (!recording) return notFoundResponse();
    const owner = session.userId;
    const [run, audios, transcripts] = await Promise.all([
      store.latestTranscription?.(owner, id) ?? null,
      store.listAudioParts?.(owner, id) ?? [],
      store.listTranscripts?.(owner, id) ?? [],
    ]);
    if (!store.latestTranscription && !store.listAudioParts && !store.listTranscripts && !deps.engines && !deps.defaultEngine) return jsonResponse(200, withRecording(recording));
    return jsonResponse(200, {
      ...withRecording(recording),
      transcription: run ? transcriptionRunBody(run) : null,
      audios: audios.map(audioPartBody),
      transcripts: transcripts.map(transcriptTabBody),
      engines: [...(deps.engines?.() ?? [])],
      defaultEngine: deps.defaultEngine?.() ?? null,
    });
  });
}

/**
 * 録音ページを開くとき（`/p/{id}` の RSC）に、情報パネルの「録音」の長さ（秒）だけを読む。段落・話者名は画面へ渡さない。
 * 録音が無い・長さが分からない（0 以下を含む）・DB を使えない・読めなかったときは null（「録音」の行を出さない。ページは開く）。
 */
export async function readRecordingSeconds(store: Pick<RecordingsStore, "getRecording"> | null, owner: OwnerId, pageId: string): Promise<number | null> {
  if (!store) return null;
  try {
    const recording = await store.getRecording(owner, pageId);
    const seconds = recording?.durationSec;
    return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch (error) {
    // 値（本文・SQL）は出さない
    console.error("editor-web: recording length read failed", { name: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

type Patch = { baseRevision: number; mutate: RecordingMutation<RecordingMutationRejection> };
type PatchResult = { ok: true; value: Patch } | { ok: false; reason: BadRequestReason };

const PATCH_OPERATIONS = ["edits", "renameSpeaker", "mergeSpeakers", "appendVtt"] as const;

function parseEdits(value: unknown): SegmentEdit[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > SEGMENT_EDITS_MAX) return null;
  const edits: SegmentEdit[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || !hasOnlyKeys(item, ["index", "text"])) return null;
    if (typeof item.index !== "number" || typeof item.text !== "string") return null;
    edits.push({ index: item.index, text: item.text });
  }
  return edits;
}

/**
 * 文字起こしのタブの書き換えの要求（transcript-api.ts が使う）: `baseRevision` と、edits・renameSpeaker・mergeSpeakers・appendVtt の
 * ちょうど 1 つ。形が違えば body（400）。
 * 値の中身（範囲の外の index・規則に合わない名前・存在しない話者・足せない段落）は mutate が断る
 * （400 index・text・name・speaker・merge・append_*）。
 * appendVtt の VTT は、ここ（DB に触る前）で段落にする: 読めなければ取り込みと同じ理由で 400、読めたら mutate は純粋な結合だけ。
 */
export function parseRecordingPatch(body: unknown): PatchResult {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["baseRevision", ...PATCH_OPERATIONS])) return { ok: false, reason: "body" };
  const { baseRevision } = body;
  if (typeof baseRevision !== "number" || !Number.isSafeInteger(baseRevision) || baseRevision < 1) return { ok: false, reason: "body" };
  const present = PATCH_OPERATIONS.filter((operation) => body[operation] !== undefined);
  if (present.length !== 1) return { ok: false, reason: "body" };
  if (body.edits !== undefined) {
    const edits = parseEdits(body.edits);
    return edits ? { ok: true, value: { baseRevision, mutate: (data) => editSegments(data, edits) } } : { ok: false, reason: "body" };
  }
  if (body.renameSpeaker !== undefined) {
    const rename = body.renameSpeaker;
    if (!isPlainObject(rename) || !hasOnlyKeys(rename, ["speaker", "name"]) || !("name" in rename)) return { ok: false, reason: "body" };
    const { speaker, name } = rename;
    if (typeof speaker !== "number" || (name !== null && typeof name !== "string")) return { ok: false, reason: "body" };
    return { ok: true, value: { baseRevision, mutate: (data) => renameSpeaker(data, speaker, name) } };
  }
  if (body.appendVtt !== undefined) {
    const append = body.appendVtt;
    if (!isPlainObject(append) || !hasOnlyKeys(append, ["name", "vtt"])) return { ok: false, reason: "body" };
    if (typeof append.vtt !== "string") return { ok: false, reason: "body" };
    if (typeof append.name !== "string") return { ok: false, reason: "name" };
    const read = readVtt({ name: append.name, vtt: append.vtt });
    if (!read.ok) return { ok: false, reason: read.reason };
    const { segments, speakerNames, durationSec } = read.value;
    return { ok: true, value: { baseRevision, mutate: (data) => appendTranscript(data, { segments, speakerNames, durationSec }) } };
  }
  const merge = body.mergeSpeakers;
  if (!isPlainObject(merge) || !hasOnlyKeys(merge, ["from", "into"])) return { ok: false, reason: "body" };
  const { from, into } = merge;
  if (typeof from !== "number" || typeof into !== "number") return { ok: false, reason: "body" };
  return { ok: true, value: { baseRevision, mutate: (data) => mergeSpeakers(data, from, into) } };
}
