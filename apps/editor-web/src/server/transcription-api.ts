import { isLanguage } from "@niho/docs-core";
import {
  TRANSCRIPTION_TERMS_MAX,
  isTranscriptionTerm,
  type EnqueueTranscriptionInput,
  type EnqueueTranscriptionResult,
  type OwnerId,
  type PageLang,
  type TranscriptionErrorCode,
  type TranscriptionRunView,
} from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import type { TranscriptionDispatcher } from "../transcription/dispatch";
import type { TranscriptionEngineName } from "../transcription/engine";
import { errorResponse, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";

/**
 * 録音の文字起こし（#36 段 2b）の API: 開始（「もう一度」を含む）と状態の取得。
 *
 * - 開始: 本人の・ゴミ箱でないページの、アップロード済みの音声の録音に run（queued）を作り、応答のあとに実行の呼び出し口へ渡す。
 *   エンジンは設定（`EDITOR_TRANSCRIBE_ENGINE`）で決まり、要求からは選ばせない。有効な run があればそれを返す（200。積み直さない）。
 *   段落が既にある録音は、`replace: true` が無ければ 409（直した文章を失わせない）。
 * - 作法は録音の API（recordings-api.ts）と同じ: 未認証 401、更新系は同じ origin からだけ（403）、別の人・存在しない・不正な id・
 *   削除済み・録音の無いページは同じ 404、エラーの本文は短い code と理由だけ。音声・鍵・bucket 名・object の場所は出さない。
 * - 呼び出し口が無いときは 503 `transcription_unavailable`（本番は `EDITOR_TRANSCRIBE_MODE=cloud-tasks` と
 *   キュー・worker の URL・OIDC の身元が揃ったときだけ開く。inline は開発と CI だけ。src/transcription/dispatch.ts）。
 */

/** 文字起こしの API が使う store の操作（packages/editor-store の関数に Pool を渡したもの）。null はページ（録音）が無い。 */
export type TranscriptionStore = {
  enqueue: (owner: OwnerId, pageId: string, input: EnqueueTranscriptionInput) => Promise<EnqueueTranscriptionResult | null>;
  status: (owner: OwnerId, pageId: string) => Promise<{ run: TranscriptionRunView | null } | null>;
  failRun: (runId: string, generation: number, errorCode: TranscriptionErrorCode) => Promise<boolean>;
};

/**
 * 実行の準備（run に記録する**既定の**エンジンの名前、いま使えるエンジンの名前、実行の呼び出し口）。
 * `engines` が 2 つ以上なら、画面は案のエンジンを選べる（#36。Gemini を足したときから）。
 */
export type TranscriptionRunnerDeps = { engine: TranscriptionEngineName; engines: TranscriptionEngineName[]; dispatcher: TranscriptionDispatcher };

export type TranscriptionApiDeps = {
  auth: () => AuthProvider;
  /** DB が使えないときは null（503 unavailable）。 */
  store: () => TranscriptionStore | null;
  /** 文字起こしが使えないとき（off・呼び出し口なし・設定の誤り・保存先なし）は null（503 transcription_unavailable）。 */
  runner: () => TranscriptionRunnerDeps | null;
  env?: Readonly<Record<string, string | undefined>>;
};

/** 開始の要求の本文の上限（固有名詞 100 個 × 64 文字を JSON にしても収まる）。超えたら 413。 */
export const TRANSCRIBE_BODY_MAX_BYTES = 64 * 1024;

const START_KEYS = ["lang", "diarize", "replace", "terms", "engine"] as const;

export type TranscribeBadRequestReason = "body" | "lang" | "diarize" | "replace" | "terms" | "engine";

/** 開始できない理由（409）。candidate_missing は、案に書く実行で案が見つからないとき（#36 段 3b-4）。 */
export type TranscribeConflictReason = "audio_not_ready" | "audio_expired" | "has_transcript" | "candidate_missing";

/** 応答に載せる run（決まった項目だけ。store が何を足しても他の値を出さない）。録音の GET（recordings-api.ts）も使う。 */
export function transcriptionRunBody(run: TranscriptionRunView) {
  return {
    id: run.id,
    status: run.status,
    engine: run.engine,
    language: run.language,
    errorCode: run.errorCode,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

function badRequest(reason: TranscribeBadRequestReason): Response {
  return jsonResponse(400, { error: "bad_request", reason });
}

function cannotStart(reason: TranscribeConflictReason): Response {
  return jsonResponse(409, { error: "cannot_start", reason });
}

function unavailable(): Response {
  return jsonResponse(503, { error: "transcription_unavailable" });
}

/**
 * 想定外の失敗は 500 の汎用エラー（内部の情報は応答に出さず、ログにも名前と code だけを書く）。
 * recordings-api.ts の guarded と同じ（他の PR と並行して触らないよう、ここに置いている）。
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

type StartRequest = { language?: PageLang; diarize: boolean; replace: boolean; terms: string[]; engine?: TranscriptionEngineName };

/**
 * `{ lang?, diarize?, replace?, terms?, engine? }` だけを受ける。既定は diarize: true・replace: false・terms: []・
 * 言語は録音の言語・エンジンは設定の既定。`engine` は**いま使えるエンジン**だけ（鍵の無いエンジンは 400 engine）。
 */
function parseStart(body: unknown, engines: readonly TranscriptionEngineName[]): { ok: true; value: StartRequest } | { ok: false; reason: TranscribeBadRequestReason } {
  if (!isPlainObject(body) || !Object.keys(body).every((key) => (START_KEYS as readonly string[]).includes(key))) return { ok: false, reason: "body" };
  let language: PageLang | undefined;
  if (body.lang !== undefined) {
    // 言語の値の範囲は docs-core（NIHO docs の中核）と同じ ja | en
    if (!isLanguage(body.lang)) return { ok: false, reason: "lang" };
    language = body.lang;
  }
  if (body.diarize !== undefined && typeof body.diarize !== "boolean") return { ok: false, reason: "diarize" };
  if (body.replace !== undefined && typeof body.replace !== "boolean") return { ok: false, reason: "replace" };
  let terms: string[] = [];
  if (body.terms !== undefined) {
    if (!Array.isArray(body.terms) || body.terms.length > TRANSCRIPTION_TERMS_MAX) return { ok: false, reason: "terms" };
    terms = [];
    for (const item of body.terms) {
      const term = typeof item === "string" ? item.trim() : item;
      if (!isTranscriptionTerm(term)) return { ok: false, reason: "terms" };
      terms.push(term);
    }
  }
  let engine: TranscriptionEngineName | undefined;
  if (body.engine !== undefined) {
    if (typeof body.engine !== "string" || !engines.includes(body.engine as TranscriptionEngineName)) return { ok: false, reason: "engine" };
    engine = body.engine as TranscriptionEngineName;
  }
  return {
    ok: true,
    value: {
      ...(language === undefined ? {} : { language }),
      diarize: body.diarize ?? true,
      replace: body.replace ?? false,
      terms,
      ...(engine === undefined ? {} : { engine }),
    },
  };
}

/**
 * POST /api/pages/{id}/recording/transcribe — 文字起こしを始める（「もう一度」も同じ）。
 * 202 `{ run }`（作った。応答のあとに実行を始める）・200 `{ run }`（有効な run が既にある）。
 * 409 `{ error: "cannot_start", reason }`（audio_not_ready・audio_expired・has_transcript）。
 */
export function startTranscriptionRoute(request: Request, id: string, deps: TranscriptionApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/recording/transcribe", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const runner = deps.runner();
    if (!runner) return unavailable();
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    // 本文の検査は id の有無より先（どの id でも同じ順に判定し、存在を漏らさない）
    const body = await readJsonBody(request, TRANSCRIBE_BODY_MAX_BYTES);
    if (!body.ok) return body.response.status === 400 ? badRequest("body") : body.response;
    const parsed = parseStart(body.value, runner.engines);
    if (!parsed.ok) return badRequest(parsed.reason);
    const { engine = runner.engine, ...start } = parsed.value;

    // owner は認証の層の本人だけ（要求の値からは決めない）
    const owner = session.userId;
    const result = await store.enqueue(owner, id, { engine, ...start });
    if (!result) return notFoundResponse();
    switch (result.status) {
      case "audio_not_ready":
      case "audio_expired":
      case "has_transcript":
      case "candidate_missing":
        return cannotStart(result.status);
      case "existing":
        // 有効な run が既にある: 積み直さない
        return jsonResponse(200, { run: transcriptionRunBody(result.run) });
      case "created":
        break;
    }
    const { run } = result;
    try {
      await runner.dispatcher.dispatch(run.id);
    } catch (error) {
      // 積めなかった run を有効なまま残さない（claim される前の世代 0 で失敗にする。音声は残るので「もう一度」ができる）
      console.error("editor-web: transcription dispatch failed", { name: error instanceof Error ? error.name : "unknown" });
      await store.failRun(run.id, 0, "internal");
      const current = (await store.status(owner, id))?.run;
      return jsonResponse(202, { run: transcriptionRunBody(current && current.id === run.id ? current : run) });
    }
    return jsonResponse(202, { run: transcriptionRunBody(run) });
  });
}

/** GET /api/pages/{id}/recording/transcription — 最新の run（`{ run }`。無ければ run: null）。録音が無ければ同じ 404。 */
export function getTranscriptionRoute(request: Request, id: string, deps: Pick<TranscriptionApiDeps, "auth" | "store">): Promise<Response> {
  return guarded("GET /api/pages/[id]/recording/transcription", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const status = await store.status(session.userId, id);
    if (!status) return notFoundResponse();
    return jsonResponse(200, { run: status.run ? transcriptionRunBody(status.run) : null });
  });
}
