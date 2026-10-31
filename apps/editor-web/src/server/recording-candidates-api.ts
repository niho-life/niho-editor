import type {
  AddRecordingCandidateInput,
  AddRecordingCandidateResult,
  AdoptRecordingCandidateResult,
  DeleteRecordingCandidateResult,
  EnqueueTranscriptionInput,
  EnqueueTranscriptionResult,
  OwnerId,
  Recording,
  RecordingCandidate,
  RecordingCandidateView,
  TranscriptionErrorCode,
} from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import type { TranscriptionEngineName } from "../transcription/engine";
import { candidateEngineLabel, nextCandidateName, primaryCandidateName } from "../recording/candidate-names";
import type { TranscriptionRunnerDeps } from "./transcription-api";
import { withSpeakers } from "./recordings-api";
import { transcriptionRunBody } from "./transcription-api";
import { errorResponse, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";

/**
 * 文字起こしの案（#36 段 3b-4）の API: 案を作って実行を積む・案を読む・案を採用する・案にもう一度実行する・案を消す。
 * 旧 NIHO docs の candidateSets の工程 1（同じ音声を別のエンジンで起こして見比べ、採用する案を選ぶ）に当たる。
 *
 * - 作る: いまの文字起こしを 1 つ目の案として台帳に載せ（まだ無ければ）、空の案を足して、その案に書く実行を積む（202）。
 *   実行を積めない事情（音声が途中・期限切れ・ほかの実行が走っている）のときは、案は残して `run: null` と理由を返す
 *   （画面は「もう一度」で積み直せる）。
 * - 採用: 選んだ案を正本に写す（それまでの本文は、採用中だった案に残る）。正本の revision が進むので、開いている画面は
 *   次の書き込みで 409 を受けて最新に合わせる。
 * - エンジンは要求の `engine`（**いま使えるエンジン**だけ。鍵の無いエンジンは 400）。省けば設定の既定。
 *   Gemini を足したので、Deepgram と Gemini の案を並べて見比べられる。
 * 作法は録音の API と同じ: 未認証 401、更新系は同じ origin からだけ（403）、別の人・存在しない・不正な id・削除済み・
 * 録音や案の無いページは同じ 404、エラーの本文は短い code と理由だけ。
 */

/** 案の API が使う store の操作（packages/editor-store の関数に Pool を渡したもの）。null はページ（録音）が無い。 */
export type CandidatesStore = {
  getRecording: (owner: OwnerId, pageId: string) => Promise<Recording | null>;
  listCandidates: (owner: OwnerId, pageId: string) => Promise<RecordingCandidateView[]>;
  getCandidate: (owner: OwnerId, pageId: string, candidateId: string) => Promise<RecordingCandidate | null>;
  addCandidate: (owner: OwnerId, pageId: string, input: AddRecordingCandidateInput) => Promise<AddRecordingCandidateResult | null>;
  adoptCandidate: (owner: OwnerId, pageId: string, candidateId: string) => Promise<AdoptRecordingCandidateResult | null>;
  deleteCandidate: (owner: OwnerId, pageId: string, candidateId: string) => Promise<DeleteRecordingCandidateResult | null>;
  enqueue: (owner: OwnerId, pageId: string, input: EnqueueTranscriptionInput) => Promise<EnqueueTranscriptionResult | null>;
  failRun: (runId: string, generation: number, errorCode: TranscriptionErrorCode) => Promise<boolean>;
};

export type CandidatesApiDeps = {
  auth: () => AuthProvider;
  /** DB が使えないときは null（503 unavailable）。 */
  store: () => CandidatesStore | null;
  /** 文字起こしが使えないとき（off・呼び出し口なし・設定の誤り・保存先なし）は null（503 transcription_unavailable）。 */
  runner: () => TranscriptionRunnerDeps | null;
  env?: Readonly<Record<string, string | undefined>>;
};

/** 案を作る要求の本文の上限（今は空の本文だけ）。 */
export const CANDIDATE_BODY_MAX_BYTES = 4 * 1024;

/**
 * 想定外の失敗は 500 の汎用エラー（内部の情報は応答に出さず、ログにも名前と code だけを書く）。
 * recordings-api.ts の guarded と同じ。
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

/** 応答に載せる案（決まった項目だけ）。 */
export function candidateBody(candidate: RecordingCandidateView) {
  return {
    id: candidate.id,
    name: candidate.name,
    engine: candidate.engine,
    engineLabel: candidateEngineLabel(candidate.engine),
    language: candidate.language,
    durationSec: candidate.durationSec,
    adopted: candidate.adopted,
    state: candidate.state,
    segmentCount: candidate.segmentCount,
    preview: [...candidate.preview],
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

/** 本文つきの案（見比べる画面が読む）。 */
function fullCandidateBody(candidate: RecordingCandidate) {
  return {
    ...candidateBody(candidate),
    segments: candidate.segments.map(({ start, end, text, speaker }) => ({ start, end, text, speaker })),
    speakerNames: { ...candidate.speakerNames },
  };
}

function cannotStart(reason: string): Response {
  return jsonResponse(409, { error: "cannot_start", reason });
}

/** 案に書く実行を積む（積めなければ理由だけを返す。案は残す）。 */
async function startCandidateRun(
  store: CandidatesStore,
  runner: TranscriptionRunnerDeps,
  owner: OwnerId,
  pageId: string,
  candidateId: string,
  engine: TranscriptionEngineName = runner.engine,
): Promise<{ run: ReturnType<typeof transcriptionRunBody> | null; reason: string | null }> {
  const result = await store.enqueue(owner, pageId, { engine, diarize: true, replace: false, terms: [], candidate: candidateId });
  if (!result) return { run: null, reason: "missing" };
  if (result.status === "audio_not_ready" || result.status === "audio_expired" || result.status === "has_transcript" || result.status === "candidate_missing") {
    return { run: null, reason: result.status };
  }
  if (result.status === "existing") {
    // 同じページで走れる実行は 1 つだけ。走っているのが別の案・正本に書く実行なら、この案の実行は始まっていない
    // （「作っています」と言うと、この案はいつまでも空のまま）。この案の実行なら、積み直した扱い
    if (result.candidate !== candidateId) return { run: null, reason: "other_run_active" };
    return { run: transcriptionRunBody(result.run), reason: null };
  }
  const { run } = result;
  try {
    await runner.dispatcher.dispatch(run.id);
  } catch (error) {
    // 積めなかった run を有効なまま残さない（claim される前の世代 0 で失敗にする。案は残るので「もう一度」ができる）
    console.error("editor-web: transcription dispatch failed", { name: error instanceof Error ? error.name : "unknown" });
    await store.failRun(run.id, 0, "internal");
  }
  return { run: transcriptionRunBody(run), reason: null };
}

/**
 * POST /api/pages/{id}/recording/candidates — 別の案を作って、その案の文字起こしを始める。
 * 202 `{ candidate, candidates, run, cannotStart }`（run が null なら cannotStart に理由）。案の数の上限は 409 too_many。
 */
export function addCandidateRoute(request: Request, id: string, deps: CandidatesApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/recording/candidates", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const runner = deps.runner();
    if (!runner) return jsonResponse(503, { error: "transcription_unavailable" });
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    // 受けるのは `{ engine? }` だけ（案の名前はサーバーが決める）
    const body = await readJsonBody(request, CANDIDATE_BODY_MAX_BYTES);
    if (!body.ok) return body.response.status === 400 ? jsonResponse(400, { error: "bad_request", reason: "body" }) : body.response;
    const value: unknown = body.value ?? {};
    if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.keys(value).every((key) => key === "engine")) {
      return jsonResponse(400, { error: "bad_request", reason: "body" });
    }
    const asked = (value as { engine?: unknown }).engine;
    if (asked !== undefined && (typeof asked !== "string" || !runner.engines.includes(asked as TranscriptionEngineName))) {
      return jsonResponse(400, { error: "bad_request", reason: "engine" });
    }
    const engine = (asked as TranscriptionEngineName | undefined) ?? runner.engine;

    const owner = session.userId;
    const recording = await store.getRecording(owner, id);
    if (!recording) return notFoundResponse();
    const existing = await store.listCandidates(owner, id);
    const added = await store.addCandidate(owner, id, {
      name: nextCandidateName(
        existing.map((item) => item.name),
        engine,
      ),
      engine,
      language: recording.language,
      primaryName: primaryCandidateName(recording.engine),
    });
    if (!added) return notFoundResponse();
    if (added.status === "too_many") return jsonResponse(409, { error: "too_many" });
    const started = await startCandidateRun(store, runner, owner, id, added.candidate.id, engine);
    const candidates = await store.listCandidates(owner, id);
    return jsonResponse(202, {
      candidate: candidateBody(added.candidate),
      candidates: candidates.map(candidateBody),
      run: started.run,
      cannotStart: started.reason,
    });
  });
}

/** GET /api/pages/{id}/recording/candidates/{candidateId} — 案 1 つ（本文つき）。無ければ同じ 404。 */
export function getCandidateRoute(request: Request, id: string, candidateId: string, deps: Pick<CandidatesApiDeps, "auth" | "store">): Promise<Response> {
  return guarded("GET /api/pages/[id]/recording/candidates/[candidateId]", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const candidate = await store.getCandidate(session.userId, id, candidateId);
    return candidate ? jsonResponse(200, { candidate: fullCandidateBody(candidate) }) : notFoundResponse();
  });
}

/**
 * POST /api/pages/{id}/recording/candidates/{candidateId}/adopt — その案を採用する（正本に写す）。
 * 200 `{ recording, speakers, candidates }`。本文のできていない案は 409 `{ error: "not_ready" }`。
 */
export function adoptCandidateRoute(request: Request, id: string, candidateId: string, deps: CandidatesApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/recording/candidates/[candidateId]/adopt", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const result = await store.adoptCandidate(session.userId, id, candidateId);
    if (!result) return notFoundResponse();
    if (result.status === "not_ready") return jsonResponse(409, { error: "not_ready" });
    return jsonResponse(200, { ...withSpeakers(result.recording), candidates: result.candidates.map(candidateBody) });
  });
}

/**
 * DELETE /api/pages/{id}/recording/candidates/{candidateId} — 要らなくなった案を消す。
 * 200 `{ candidates }`。採用中は 409 `{ error: "adopted" }`、実行が走っていれば 409 `{ error: "running" }`。
 */
export function deleteCandidateRoute(request: Request, id: string, candidateId: string, deps: CandidatesApiDeps): Promise<Response> {
  return guarded("DELETE /api/pages/[id]/recording/candidates/[candidateId]", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const result = await store.deleteCandidate(session.userId, id, candidateId);
    if (!result) return notFoundResponse();
    if (result.status !== "ok") return jsonResponse(409, { error: result.status });
    return jsonResponse(200, { candidates: result.candidates.map(candidateBody) });
  });
}

/**
 * POST /api/pages/{id}/recording/candidates/{candidateId}/transcribe — その案の文字起こしをもう一度始める。
 * 202 `{ run }`・409 `{ error: "cannot_start", reason }`。案が無ければ同じ 404。
 */
export function retryCandidateRoute(request: Request, id: string, candidateId: string, deps: CandidatesApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/recording/candidates/[candidateId]/transcribe", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const runner = deps.runner();
    if (!runner) return jsonResponse(503, { error: "transcription_unavailable" });
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const candidate = await store.getCandidate(session.userId, id, candidateId);
    if (!candidate) return notFoundResponse();
    // その案を作ったエンジンでもう一度（いま使えなければ設定の既定）
    const engine = candidate.engine !== null && runner.engines.includes(candidate.engine as TranscriptionEngineName) ? (candidate.engine as TranscriptionEngineName) : runner.engine;
    const started = await startCandidateRun(store, runner, session.userId, id, candidateId, engine);
    if (!started.run) return started.reason === "missing" ? notFoundResponse() : cannotStart(started.reason ?? "internal");
    return jsonResponse(202, { run: started.run });
  });
}
