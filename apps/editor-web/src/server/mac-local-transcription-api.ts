import type {
  FinishTranscriptionResult,
  MacLocalTranscriptionRun,
  OwnerId,
  Recording,
  StartMacLocalTranscriptionResult,
  TranscriptionErrorCode,
  TranscriptionOutput,
} from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { EngineError } from "../transcription/engine";
import { normalizeEngineResult } from "../transcription/normalize";
import { errorResponse, guarded, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";
import { transcriptionRunBody } from "./transcription-api";

const BODY_MAX_BYTES = 9 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FAILURE_CODES = new Set<TranscriptionErrorCode>([
  "audio_missing", "audio_expired", "engine_unavailable", "engine_rejected", "engine_timeout",
  "engine_bad_response", "too_large", "internal", "stopped",
]);

export type MacLocalTranscriptionStore = {
  getRecording: (owner: OwnerId, pageId: string) => Promise<Recording | null>;
  /** 開始は「文字起こし」ページに新しいタブ（札「Apple（このMac内）」）を作り、そのタブを書き先にする（#310）。 */
  start: (owner: OwnerId, pageId: string, input: { operationId: string }) => Promise<StartMacLocalTranscriptionResult | null>;
  status: (owner: OwnerId, pageId: string) => Promise<MacLocalTranscriptionRun | null>;
  finish: (owner: OwnerId, pageId: string, runId: string, operationId: string, generation: number, output: TranscriptionOutput) => Promise<FinishTranscriptionResult>;
  resume: (owner: OwnerId, pageId: string, runId: string, operationId: string, generation: number) => Promise<MacLocalTranscriptionRun | null>;
  fail: (owner: OwnerId, pageId: string, runId: string, operationId: string, generation: number, errorCode: TranscriptionErrorCode) => Promise<boolean>;
};

export type MacLocalTranscriptionApiDeps = {
  auth: () => AuthProvider;
  store: () => MacLocalTranscriptionStore | null;
  env?: Readonly<Record<string, string | undefined>>;
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function body(run: MacLocalTranscriptionRun) {
  return {
    run: { ...transcriptionRunBody(run.run), executor: "mac-local" as const },
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

function startResponse(result: StartMacLocalTranscriptionResult): Response {
  return result.status === "created" || result.status === "existing"
    ? jsonResponse(result.status === "created" ? 202 : 200, body(result))
    : conflict(result.status);
}

async function startFor(store: MacLocalTranscriptionStore, owner: OwnerId, pageId: string, operationId: string): Promise<Response> {
  // タブの作成と run の作成は store の同じ transaction。route はタブを先に永続化しない。
  const started = await store.start(owner, pageId, { operationId });
  return started ? startResponse(started) : notFoundResponse();
}

/** Apple 端末内認識専用。Gemini route / server worker / provider 課金とは別の受付。 */
export function mutateMacLocalTranscriptionRoute(request: Request, pageId: string, deps: MacLocalTranscriptionApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/recording/transcription/mac-local", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const read = await readJsonBody(request, BODY_MAX_BYTES);
    if (!read.ok || !object(read.value) || typeof read.value.action !== "string") return errorResponse("bad_request");
    const value = read.value;
    if (value.action === "start") {
      if (Object.keys(value).some((key) => !["action", "operationId"].includes(key)) || typeof value.operationId !== "string" || !UUID.test(value.operationId)) return errorResponse("bad_request");
      return startFor(store, session.userId, pageId, value.operationId);
    }
    if (!Object.keys(value).every((key) => ["action", "operationId", "runId", "generation", "segments", "durationSec", "errorCode"].includes(key)) ||
      typeof value.operationId !== "string" || !UUID.test(value.operationId) || typeof value.runId !== "string" || !UUID.test(value.runId) ||
      typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 1) return errorResponse("bad_request");

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
      const errorCode: TranscriptionErrorCode = value.action === "stop" ? "stopped" : value.errorCode as TranscriptionErrorCode;
      if (!FAILURE_CODES.has(errorCode)) return errorResponse("bad_request");
      const changed = await store.fail(session.userId, pageId, value.runId, value.operationId, value.generation, errorCode);
      return changed ? jsonResponse(200, { status: "failed" }) : jsonResponse(409, { error: "stale_run" });
    }
    return errorResponse("bad_request");
  });
}

export function getMacLocalTranscriptionRoute(request: Request, pageId: string, deps: MacLocalTranscriptionApiDeps): Promise<Response> {
  return guarded("GET /api/pages/[id]/recording/transcription/mac-local", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const run = await store.status(session.userId, pageId);
    if (run) return jsonResponse(200, body(run));
    // status の null は「run なし」と「他 owner / 存在しない page」の両方を表す。
    // page を owner scope で再確認し、他人の page を run なしとして漏らさない。
    const recording = await store.getRecording(session.userId, pageId);
    return recording ? jsonResponse(200, { run: null }) : notFoundResponse();
  });
}
