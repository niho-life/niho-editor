import "server-only";
import { failRun, listQueuedRuns, requeueRun, sweepStaleRuns, type Connectable, type Queryable } from "@niho/editor-store";
import type { TranscriptionWorkerRunner } from "../server/transcription-worker-api";
import { getStorage } from "../storage/runtime";
import type { ObjectStorage } from "../storage/types";
import {
  CloudTasksTranscriptionQueue,
  resolveTranscriptionTasksConfig,
  type TranscriptionQueue,
  type TranscriptionTasksConfig,
} from "./cloud-tasks";
import { resolveTranscriptionEngines, type TranscriptionEnv } from "./config";
import { createDeepgramEngine } from "./deepgram";
import { createGeminiEngine } from "./gemini";
import { createCloudTasksDispatcher, createInlineDispatcher, resolveDispatcherKind, type TranscriptionDispatcher } from "./dispatch";
import type { TranscriptionEngine, TranscriptionEngineName } from "./engine";
import { createFakeEngine, fakeFailFromEnv } from "./fake";
import { executeRun, pgTranscriptionRunStore, type TranscriptionRunStore } from "./run";

/**
 * 開始の API が使うもの: run に記録する**既定の**エンジンの名前、いま使えるエンジンの名前（画面が案のエンジンを選べる）、
 * 実行の呼び出し口。
 */
export type TranscriptionRunner = { engine: TranscriptionEngineName; engines: TranscriptionEngineName[]; dispatcher: TranscriptionDispatcher };

type Env = TranscriptionEnv & Readonly<Record<string, string | undefined>>;

/** 1 つの run を実行するのに要るもの。エンジンは run に記録された名前で引く（案を別のエンジンで作れるため）。 */
type ExecutionParts = {
  /** 使えるエンジン（名前 → 口）。 */
  engines: Map<TranscriptionEngineName, TranscriptionEngine>;
  /** 既定のエンジンの名前（開始の API が run に記録する）。 */
  engine: TranscriptionEngineName;
  storage: ObjectStorage;
  store: TranscriptionRunStore;
  timeoutMs: number;
};

// Cloud Tasks のキューは設定と時間切れごとに 1 つ（メタデータサーバーのアクセストークンを要求の間で使い回す）
let cloudTasks: { key: string; queue: TranscriptionQueue } | undefined;

function transcriptionQueue(config: TranscriptionTasksConfig, timeoutMs: number): TranscriptionQueue {
  const key = `${config.queue}\n${config.workerUrl}\n${config.invokerServiceAccount}\n${timeoutMs}`;
  if (cloudTasks?.key !== key) cloudTasks = { key, queue: new CloudTasksTranscriptionQueue(config, { timeoutMs }) };
  return cloudTasks.queue;
}

/**
 * エンジン・保存先・store・時間切れ。使えないときは null: `off`・設定の誤り・保存先を使わない設定。
 * 設定の誤りは起動時の検査（src/startup-check.ts）が先に止めるので、ここは後ろの守り（値を出さずに null）。
 */
function executionParts(pool: Connectable & Queryable, env: Env): ExecutionParts | null {
  const available = resolveTranscriptionEngines(env);
  if (!available) return null;
  const storage = getStorage(env);
  if (!storage) return null;
  const engines = new Map<TranscriptionEngineName, TranscriptionEngine>();
  if (available.fake) engines.set("fake", createFakeEngine({ failWith: fakeFailFromEnv(env) }));
  if (available.deepgram) engines.set("deepgram", createDeepgramEngine({ apiKey: available.deepgram, timeoutMs: available.timeoutMs }));
  if (available.gemini) engines.set("gemini", createGeminiEngine({ apiKey: available.gemini.apiKey, model: available.gemini.model, timeoutMs: available.timeoutMs }));
  if (engines.size === 0) return null;
  return { engines, engine: available.default, storage, store: pgTranscriptionRunStore(pool), timeoutMs: available.timeoutMs };
}

function execute(parts: ExecutionParts, runId: string) {
  return executeRun({
    store: parts.store,
    storage: parts.storage,
    // run に記録されたエンジンで実行する（無ければ engine_unavailable）
    engines: (name) => parts.engines.get(name) ?? null,
    runId,
    timeoutMs: parts.timeoutMs,
  });
}

/**
 * 要求ごとの文字起こしの実行の準備（`EDITOR_TRANSCRIBE_ENGINE` などを毎回読む）。使えないときは null（開始の API は 503
 * `transcription_unavailable`）: `off`・設定の誤り・保存先を使わない設定・呼び出し口が無い（`EDITOR_TRANSCRIBE_MODE` が
 * 未設定の本番・設定の揃わない cloud-tasks）。
 */
export function getTranscriptionRunner(pool: Connectable & Queryable, env: Env = process.env): TranscriptionRunner | null {
  const kind = resolveDispatcherKind(env);
  if (!kind) return null;
  const parts = executionParts(pool, env);
  if (!parts) return null;
  let dispatcher: TranscriptionDispatcher;
  if (kind === "cloud-tasks") {
    const config = resolveTranscriptionTasksConfig(env);
    // resolveDispatcherKind が cloud-tasks を返した時点で揃っている（後ろの守り）
    if (!config) return null;
    dispatcher = createCloudTasksDispatcher({ queue: transcriptionQueue(config, parts.timeoutMs) });
  } else {
    dispatcher = createInlineDispatcher({
      execute: (runId) => execute(parts, runId),
      failQueued: (runId) => failRun(pool, runId, 0, "internal"),
    });
  }
  return { engine: parts.engine, engines: [...parts.engines.keys()], dispatcher };
}

/**
 * worker の route（`/api/internal/transcription/**`）の実行の準備。方式が cloud-tasks のときだけ開く
 * （inline は要求の中で走るので worker を使わない）。使えないときは null（503。Cloud Tasks が再試行する）。
 */
export function getTranscriptionWorkerRunner(pool: Connectable & Queryable, env: Env = process.env): TranscriptionWorkerRunner | null {
  if (resolveDispatcherKind(env) !== "cloud-tasks") return null;
  const config = resolveTranscriptionTasksConfig(env);
  if (!config) return null;
  const parts = executionParts(pool, env);
  if (!parts) return null;
  return {
    execute: (runId) => execute(parts, runId),
    sweep: {
      failStale: ({ olderThanSec, now }) => sweepStaleRuns(pool, now, olderThanSec),
      listQueued: (options) => listQueuedRuns(pool, options),
      requeue: (runId, generation) => requeueRun(pool, runId, generation),
    },
    queue: transcriptionQueue(config, parts.timeoutMs),
    timeoutSec: Math.ceil(parts.timeoutMs / 1000),
  };
}
