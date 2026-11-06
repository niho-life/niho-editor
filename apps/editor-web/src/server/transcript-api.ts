import {
  InvalidRecordingError,
  transcriptEngineLabel,
  type OwnerId,
  type RecordingMutation,
  type Transcript,
  type TranscriptVersion,
  type TranscriptVersionSummary,
  type TranscriptionRunView,
  type UpdateTranscriptResult,
} from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { listSpeakers, type SpeakerSummary } from "../recording/speakers";
import { errorResponse, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";
import { RECORDING_PATCH_BODY_MAX_BYTES, parseRecordingPatch, type RecordingMutationRejection } from "./recordings-api";
import { transcriptionRunBody } from "./transcription-api";

/**
 * 文字起こしのタブ（#310）の API: 本文を読む・直す（段落の編集・話者の名前・話者をまとめる・あとの .vtt を足す）・版を読む・版に戻す。
 * タブは `/api/pages/{tab}/transcript`（`tab` は「文字起こし」ページのタブの id）。音声・再生・文字起こしの開始は、
 * `made_from.recording` の録音のタブの API（recordings-api.ts・transcription-api.ts）のまま。
 *
 * 作法は録音の API と同じ: 未認証 401、更新系は同じ origin からだけ（403）、別の人・存在しない・不正な id・削除済み・
 * 文字起こしでないページは同じ 404、エラーの本文は短い code と理由だけ（本文・話者名を出さない）。
 * 書き込みは baseRevision を見る: 別の画面で先に直されていたら上書きせず 409 で最新を返す（自分の文章は呼び出し側に残る）。
 */

/** 文字起こしのタブの API が使う store の操作（packages/editor-store の関数に Pool を渡したもの）。null はタブが無い。 */
export type TranscriptStore = {
  get: (owner: OwnerId, tabId: string) => Promise<Transcript | null>;
  update: (
    owner: OwnerId,
    tabId: string,
    baseRevision: number,
    mutate: RecordingMutation<RecordingMutationRejection>,
  ) => Promise<UpdateTranscriptResult<RecordingMutationRejection> | null>;
  listVersions: (owner: OwnerId, tabId: string) => Promise<TranscriptVersionSummary[]>;
  getVersion: (owner: OwnerId, tabId: string, version: number) => Promise<TranscriptVersion | null>;
  restoreVersion: (owner: OwnerId, tabId: string, version: number, baseRevision: number) => Promise<UpdateTranscriptResult<"version_missing"> | null>;
  /** このタブに書く最新の run（server・Mac とも）。あれば GET の応答に `run`（無ければ null）を足す。 */
  run?: (owner: OwnerId, tabId: string) => Promise<TranscriptionRunView | null>;
};

export type TranscriptApiDeps = {
  auth: () => AuthProvider;
  /** DB が使えないときは null（503）。 */
  store: () => TranscriptStore | null;
  env?: Readonly<Record<string, string | undefined>>;
};

/** 版に戻す要求の本文の上限（`{ baseRevision }` だけ）。 */
export const TRANSCRIPT_RESTORE_BODY_MAX_BYTES = 4 * 1024;

/**
 * 想定外の失敗は 500 の汎用エラー（内部の情報は応答に出さず、ログにも名前と code だけを書く）。
 * 保存の形が規則に合わない（InvalidRecordingError）は 400 とその理由。
 */
async function guarded(route: string, handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof InvalidRecordingError) return jsonResponse(400, { error: "bad_request", reason: error.problem });
    const name = error instanceof Error ? error.name : "unknown";
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
    console.error("editor-web: request failed", { route, name, code });
    return errorResponse("internal");
  }
}

/** 応答に載せる文字起こし（決まった項目だけ。store が何を足しても他の値を出さない）。 */
export function transcriptBody(transcript: Transcript) {
  return {
    revision: transcript.revision,
    /** 元の録音のタブ（音声・再生はこちら）。 */
    recording: transcript.recordingPageId,
    engine: transcript.engine,
    engineLabel: transcriptEngineLabel(transcript.engine),
    language: transcript.language,
    durationSec: transcript.durationSec,
    segments: transcript.segments.map(({ start, end, text, speaker }) => ({ start, end, text, speaker })),
    speakerNames: { ...transcript.speakerNames },
    createdAt: transcript.createdAt,
    updatedAt: transcript.updatedAt,
  };
}

/** 文字起こしの応答（`{ transcript, speakers }`。GET と PATCH で同じ形）。 */
export function withTranscriptSpeakers(transcript: Transcript): { transcript: ReturnType<typeof transcriptBody>; speakers: SpeakerSummary[] } {
  return { transcript: transcriptBody(transcript), speakers: listSpeakers({ segments: transcript.segments, speakerNames: transcript.speakerNames }) };
}

function versionSummaryBody(version: TranscriptVersionSummary) {
  return {
    version: version.version,
    reason: version.reason,
    engine: version.engine,
    engineLabel: transcriptEngineLabel(version.engine),
    segmentCount: version.segmentCount,
    createdAt: version.createdAt,
  };
}

function versionBody(version: TranscriptVersion) {
  return {
    ...versionSummaryBody(version),
    language: version.language,
    durationSec: version.durationSec,
    segments: version.segments.map(({ start, end, text, speaker }) => ({ start, end, text, speaker })),
    speakerNames: { ...version.speakerNames },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function versionOf(param: string): number | null {
  const version = Number(param);
  return /^[1-9][0-9]{0,8}$/.test(param) && Number.isSafeInteger(version) ? version : null;
}

/** GET /api/pages/{tab}/transcript — 文字起こし（`{ transcript, speakers, run }`）。run はこのタブに書く最新の実行（無ければ null）。 */
export function getTranscriptRoute(request: Request, id: string, deps: Pick<TranscriptApiDeps, "auth" | "store">): Promise<Response> {
  return guarded("GET /api/pages/[id]/transcript", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const owner = session.userId;
    const [transcript, run] = await Promise.all([store.get(owner, id), store.run?.(owner, id) ?? null]);
    if (!transcript) return notFoundResponse();
    return jsonResponse(200, { ...withTranscriptSpeakers(transcript), run: run ? transcriptionRunBody(run) : null });
  });
}

/**
 * PATCH /api/pages/{tab}/transcript — 段落の編集・話者名の変更・話者をまとめる・あとの .vtt を足す（1 回に 1 つ。録音の PATCH と同じ本文）。
 * 200 `{ transcript, speakers }`。別の画面で先に直されていたら 409 `{ error: "conflict", transcript, speakers }`（最新。何も書かない）。
 */
export function patchTranscriptRoute(request: Request, id: string, deps: TranscriptApiDeps): Promise<Response> {
  return guarded("PATCH /api/pages/[id]/transcript", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    // 本文の検査は id の有無より先（どの id でも同じ順に判定し、存在を漏らさない）
    const body = await readJsonBody(request, RECORDING_PATCH_BODY_MAX_BYTES);
    if (!body.ok) return body.response.status === 400 ? jsonResponse(400, { error: "bad_request", reason: "body" }) : body.response;
    const patch = parseRecordingPatch(body.value);
    if (!patch.ok) return jsonResponse(400, { error: "bad_request", reason: patch.reason });
    const result = await store.update(session.userId, id, patch.value.baseRevision, patch.value.mutate);
    if (!result) return notFoundResponse();
    if (result.status === "rejected") return jsonResponse(400, { error: "bad_request", reason: result.reason });
    if (result.status === "conflict") return jsonResponse(409, { error: "conflict", ...withTranscriptSpeakers(result.transcript) });
    return jsonResponse(200, withTranscriptSpeakers(result.transcript));
  });
}

/** GET /api/pages/{tab}/transcript/versions — 直す前の本文の版（新しい順・最大 100 件。本文なし）。 */
export function listTranscriptVersionsRoute(request: Request, id: string, deps: Pick<TranscriptApiDeps, "auth" | "store">): Promise<Response> {
  return guarded("GET /api/pages/[id]/transcript/versions", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const owner = session.userId;
    if (!(await store.get(owner, id))) return notFoundResponse();
    const versions = await store.listVersions(owner, id);
    return jsonResponse(200, { versions: versions.map(versionSummaryBody) });
  });
}

/** GET /api/pages/{tab}/transcript/versions/{version} — 1 つの版（本文つき）。無ければ同じ 404。 */
export function getTranscriptVersionRoute(request: Request, id: string, versionParam: string, deps: Pick<TranscriptApiDeps, "auth" | "store">): Promise<Response> {
  return guarded("GET /api/pages/[id]/transcript/versions/[version]", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const version = versionOf(versionParam);
    if (version === null) return notFoundResponse();
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const found = await store.getVersion(session.userId, id, version);
    return found ? jsonResponse(200, { version: versionBody(found) }) : notFoundResponse();
  });
}

/**
 * POST /api/pages/{tab}/transcript/versions/{version}/restore — その版に戻す（`{ baseRevision }`。今の本文は版 restore に残る）。
 * 200 `{ transcript, speakers }`・409 conflict（最新を返す）・版が無ければ 404。
 */
export function restoreTranscriptVersionRoute(request: Request, id: string, versionParam: string, deps: TranscriptApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/transcript/versions/[version]/restore", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const version = versionOf(versionParam);
    if (version === null) return notFoundResponse();
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const body = await readJsonBody(request, TRANSCRIPT_RESTORE_BODY_MAX_BYTES);
    if (!body.ok) return body.response.status === 400 ? jsonResponse(400, { error: "bad_request", reason: "body" }) : body.response;
    const value = body.value;
    if (!isPlainObject(value) || Object.keys(value).join(",") !== "baseRevision" || typeof value.baseRevision !== "number" || !Number.isSafeInteger(value.baseRevision) || value.baseRevision < 1) {
      return jsonResponse(400, { error: "bad_request", reason: "body" });
    }
    const result = await store.restoreVersion(session.userId, id, version, value.baseRevision);
    if (!result || result.status === "rejected") return notFoundResponse();
    if (result.status === "conflict") return jsonResponse(409, { error: "conflict", ...withTranscriptSpeakers(result.transcript) });
    return jsonResponse(200, withTranscriptSpeakers(result.transcript));
  });
}
