import type {
  FinishTranscriptionResult,
  MacTranscriptionRun,
  OwnerId,
  Recording,
  StartMacTranscriptionResult,
  TranscriptionErrorCode,
  TranscriptionOutput,
} from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { EngineError } from "../transcription/engine";
import { normalizeEngineResult } from "../transcription/normalize";
import { errorResponse, guarded, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";
import { transcriptionRunBody } from "./transcription-api";

/** Mac CLI の受付は結果本文を含むため、録音本文の保存上限 8 MiB に JSON envelope の余裕を足す。 */
export const MAC_TRANSCRIPTION_BODY_MAX_BYTES = 9 * 1024 * 1024;

export type MacTranscriptionStore = {
  getRecording: (owner: OwnerId, pageId: string) => Promise<Recording | null>;
  /** 開始は「文字起こし」ページに新しいタブ（札「Gemini（このMacのCLI）」）を作り、そのタブを書き先にする（#310）。 */
  start: (owner: OwnerId, pageId: string, input: { operationId: string; terms: readonly string[] }) => Promise<StartMacTranscriptionResult | null>;
  status: (owner: OwnerId, pageId: string) => Promise<MacTranscriptionRun | null>;
  finish: (owner: OwnerId, pageId: string, runId: string, operationId: string, generation: number, output: TranscriptionOutput) => Promise<FinishTranscriptionResult>;
  resume: (owner: OwnerId, pageId: string, runId: string, operationId: string, generation: number) => Promise<MacTranscriptionRun | null>;
  fail: (owner: OwnerId, pageId: string, runId: string, operationId: string, generation: number, errorCode: TranscriptionErrorCode) => Promise<boolean>;
};

export type MacTranscriptionApiDeps = {
  auth: () => AuthProvider;
  store: () => MacTranscriptionStore | null;
  env?: Readonly<Record<string, string | undefined>>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FAILURE_CODES = new Set<TranscriptionErrorCode>([
  "audio_missing",
  "audio_expired",
  "engine_unavailable",
  "engine_rejected",
  "engine_timeout",
  "engine_bad_response",
  "too_large",
  "internal",
  "stopped",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function body(run: MacTranscriptionRun) {
  return {
    run: { ...transcriptionRunBody(run.run), executor: "mac-cli" as const },
    generation: run.generation,
    operationId: run.operationId,
    settings: run.settings,
    audioManifest: run.audioManifest.map((part) => ({ ...part })),
    /** 結果を書く文字起こしのタブ（#310）。 */
    tab: run.tab,
  };
}

function conflict(reason: string): Response {
  return jsonResponse(409, { error: "cannot_start", reason });
}

function startResponse(result: StartMacTranscriptionResult): Response {
  if (result.status === "created" || result.status === "existing") {
    return jsonResponse(result.status === "created" ? 202 : 200, body(result));
  }
  return conflict(result.status);
}

async function startFor(store: MacTranscriptionStore, owner: OwnerId, pageId: string, operationId: string): Promise<Response> {
  // タブの作成と run の作成は store の同じ transaction（既存の本文には触らない。結果は新しいタブへ）
  const started = await store.start(owner, pageId, { operationId, terms: [] });
  return started ? startResponse(started) : notFoundResponse();
}

/** POST /recording/transcription/mac — start / complete / fail / stop。server runner や API key には依存しない。 */
export function mutateMacTranscriptionRoute(request: Request, pageId: string, deps: MacTranscriptionApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/recording/transcription/mac", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const read = await readJsonBody(request, MAC_TRANSCRIPTION_BODY_MAX_BYTES);
    if (!read.ok || !isObject(read.value) || typeof read.value.action !== "string") return errorResponse("bad_request");
    const value = read.value;
    if (value.action === "start") {
      if (Object.keys(value).some((key) => !["action", "operationId"].includes(key)) || typeof value.operationId !== "string" || !UUID.test(value.operationId)) {
        return errorResponse("bad_request");
      }
      return startFor(store, session.userId, pageId, value.operationId);
    }
    if (!Object.keys(value).every((key) => ["action", "operationId", "runId", "generation", "segments", "durationSec", "errorCode"].includes(key))) {
      return errorResponse("bad_request");
    }
    if (
      typeof value.operationId !== "string" || !UUID.test(value.operationId) ||
      typeof value.runId !== "string" || !UUID.test(value.runId) ||
      typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1
    ) return errorResponse("bad_request");

    if (value.action === "complete") {
      if (!Array.isArray(value.segments) || !(value.durationSec === null || typeof value.durationSec === "number")) return errorResponse("bad_request");
      let output: TranscriptionOutput;
      try {
        output = normalizeEngineResult({ segments: [...(value.segments as TranscriptionOutput["segments"])], durationSec: value.durationSec as number | null }, { diarize: true });
      } catch (error) {
        if (error instanceof EngineError) return jsonResponse(400, { error: "bad_request", reason: error.code });
        throw error;
      }
      const result = await store.finish(session.userId, pageId, value.runId, value.operationId, value.generation, output);
      if (result === "stale") return jsonResponse(409, { error: "stale_run" });
      if (result === "superseded") return jsonResponse(409, { error: "recording_changed" });
      return jsonResponse(200, { status: "succeeded" });
    }
    if (value.action === "resume") {
      const resumed = await store.resume(session.userId, pageId, value.runId, value.operationId, value.generation);
      return resumed ? jsonResponse(200, body(resumed)) : jsonResponse(409, { error: "stale_run" });
    }
    if (value.action === "stop" || value.action === "fail") {
      const errorCode: TranscriptionErrorCode = value.action === "stop" ? "stopped" : (value.errorCode as TranscriptionErrorCode);
      if (!FAILURE_CODES.has(errorCode)) return errorResponse("bad_request");
      const changed = await store.fail(session.userId, pageId, value.runId, value.operationId, value.generation, errorCode);
      return changed ? jsonResponse(200, { status: "failed" }) : jsonResponse(409, { error: "stale_run" });
    }
    return errorResponse("bad_request");
  });
}

/** GET は本人の最新 Mac run。再起動後の checkpoint と照合するための固定設定・音声集合も返す。 */
export function getMacTranscriptionRoute(request: Request, pageId: string, deps: MacTranscriptionApiDeps): Promise<Response> {
  return guarded("GET /api/pages/[id]/recording/transcription/mac", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const run = await store.status(session.userId, pageId);
    return jsonResponse(200, run ? body(run) : { run: null });
  });
}
