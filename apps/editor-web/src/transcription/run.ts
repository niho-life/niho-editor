import {
  claimRun,
  failRun,
  finishRun,
  type ClaimedTranscription,
  type Connectable,
  type FinishTranscriptionResult,
  type Queryable,
  type TranscriptionErrorCode,
  type TranscriptionOutput,
} from "@niho/editor-store";
import { StorageError, type ObjectStorage, type ReadObject } from "../storage/types";
import { composeParts, type TranscribedPart } from "./compose-parts";
import { EngineError, type EngineErrorCode, type TranscriptionEngine, type TranscriptionEngineName } from "./engine";
import { normalizeEngineResult } from "./normalize";

/**
 * 1 つの run の実行（#36 段 2b）: claim → 録音の音声 → 保存先から読み出す → エンジン → 正規化 → 確定。
 * 呼ぶのは実行の呼び出し口（dispatch.ts。inline は開発と CI、本番は Cloud Tasks の worker）。
 *
 * - 音声が複数ある録音（#36 段 3b-4）は、**すべての音声を順に**文字起こしして 1 本につなぐ（compose-parts.ts。前の音声の
 *   長さだけ時刻をずらし、話者の番号は音声ごとに振り直す）。1 回の実行の時間切れ（既定 20 分）は全部で共有する
 *   （1 つの task の締め切りを超えないため。足りなければ `EDITOR_TRANSCRIBE_TIMEOUT_SEC` を上げる）。
 * - run に案（candidate）が付いていれば、確定で書くのは正本ではなくその案（store の finishRun が分ける）。
 * - エンジンは **run に記録された名前**で引く（案を別のエンジンで作れるため）。その鍵がサーバーに無ければ engine_unavailable。
 *
 * - 途中の失敗は短い code にして run を failed にする（failRun。世代が一致するときだけ）。音声は消さないので「もう一度」ができる。
 *   音声の資産が無い・アップロードが済んでいない・保存先に無い → audio_missing、期限切れ → audio_expired、
 *   保存先の失敗（StorageError）→ internal（保存先の一時的な失敗を「音声が無い」とは言わない）、エンジンの失敗 → engine_*・too_large、
 *   時間切れ（呼び出し側の AbortSignal）→ engine_timeout、想定外 → internal。
 * - 例外を外へ出さない（結果を返す）。ログには code と例外の名前だけを書く（鍵・音声・URL・保存先の場所・本文を出さない）。
 */

/** executeRun が使う store の操作（packages/editor-store の関数に Pool を渡したもの）。 */
export type TranscriptionRunStore = {
  claimRun: (runId: string) => Promise<ClaimedTranscription | null>;
  finishRun: (runId: string, generation: number, output: TranscriptionOutput) => Promise<FinishTranscriptionResult>;
  failRun: (runId: string, generation: number, errorCode: TranscriptionErrorCode) => Promise<boolean>;
};

export function pgTranscriptionRunStore(pool: Connectable & Queryable): TranscriptionRunStore {
  return {
    claimRun: (runId) => claimRun(pool, runId),
    finishRun: (runId, generation, output) => finishRun(pool, runId, generation, output),
    failRun: (runId, generation, errorCode) => failRun(pool, runId, generation, errorCode),
  };
}

export type ExecuteRunDeps = {
  store: TranscriptionRunStore;
  storage: ObjectStorage;
  /** run に記録されたエンジンの口（使えないエンジンなら null → engine_unavailable）。 */
  engines: (name: TranscriptionEngineName) => TranscriptionEngine | null;
  runId: string;
  /** 1 回の文字起こしの時間切れ（ミリ秒。設定の EDITOR_TRANSCRIBE_TIMEOUT_SEC）。 */
  timeoutMs: number;
  now?: () => number;
};

/** succeeded: 段落を書いた / failed: run を failed にした（その code）/ skipped: 他が claim 済み・終わっている・世代が古い（何もしない）。 */
export type ExecuteRunOutcome = { status: "succeeded" } | { status: "failed"; errorCode: TranscriptionErrorCode } | { status: "skipped" };

const ENGINE_CODES: Record<EngineErrorCode, TranscriptionErrorCode> = {
  unavailable: "engine_unavailable",
  rejected: "engine_rejected",
  timeout: "engine_timeout",
  bad_response: "engine_bad_response",
  too_large: "too_large",
};

/** 失敗の code（保存先の失敗は internal。audio_missing にしない）。 */
export function errorCodeFor(error: unknown, signal: AbortSignal): TranscriptionErrorCode {
  if (error instanceof EngineError) return ENGINE_CODES[error.code];
  if (signal.aborted) return "engine_timeout";
  if (error instanceof StorageError) return "internal";
  return "internal";
}

function logFailure(code: TranscriptionErrorCode, error?: unknown): void {
  const fields: Record<string, string> = { code };
  if (error !== undefined) fields.name = error instanceof Error ? error.name : "unknown";
  console.error("editor-web: transcription failed", fields);
}

/** run を実行する。例外は外へ出さない。 */
export async function executeRun(deps: ExecuteRunDeps): Promise<ExecuteRunOutcome> {
  const now = deps.now ?? Date.now;
  let claim: ClaimedTranscription | null;
  try {
    claim = await deps.store.claimRun(deps.runId);
  } catch (error) {
    // claim できたか分からない: 一度も claim も積み直しもされていない（世代 0）なら失敗にする。claim 済み・掃除が積み直したあとは世代が合わず何もしない（掃除が拾う）
    logFailure("internal", error);
    await deps.store.failRun(deps.runId, 0, "internal").catch(() => false);
    return { status: "failed", errorCode: "internal" };
  }
  if (!claim) return { status: "skipped" };
  const { generation, audio, run } = claim;

  const fail = async (code: TranscriptionErrorCode, error?: unknown): Promise<ExecuteRunOutcome> => {
    logFailure(code, error);
    try {
      await deps.store.failRun(deps.runId, generation, code);
    } catch (failure) {
      logFailure("internal", failure);
    }
    return { status: "failed", errorCode: code };
  };

  // run に記録されたエンジン（案を別のエンジンで作れるので、run ごとに違う）
  const engine = deps.engines(run.engine);
  if (!engine) return fail("engine_unavailable");
  // 音声の列（part 0 から。古い claim の口しか無いときは part 0 だけ）
  const parts = claim.parts.length > 0 ? claim.parts : audio ? [{ ...audio, partIndex: 0, offsetSec: 0, durationSec: null, sourceName: null }] : [];
  if (parts.length === 0) return fail("audio_missing");
  if (parts.some((part) => part.status !== "uploaded")) return fail("audio_missing");
  if (parts.some((part) => part.expiresAt !== null && Date.parse(part.expiresAt) <= now())) return fail("audio_expired");

  const signal = AbortSignal.timeout(deps.timeoutMs);
  let opened: ReadObject | null = null;
  try {
    const transcribed: TranscribedPart[] = [];
    for (const part of parts) {
      opened = await deps.storage.readObject(part.objectPath);
      if (!opened) return await fail("audio_missing");
      const raw = await engine.transcribe({
        audio: { stream: opened.body, contentType: part.contentType, sizeBytes: opened.sizeBytes },
        language: run.language,
        diarize: run.diarize,
        terms: run.terms,
        signal,
      });
      // エンジンが読まなかった音声は、次の音声へ進む前に閉じる
      if (!opened.body.locked) await opened.body.cancel().catch(() => undefined);
      opened = null;
      const normalizedPart = normalizeEngineResult(raw, { diarize: run.diarize });
      transcribed.push({ offsetSec: part.offsetSec, segments: normalizedPart.segments, durationSec: normalizedPart.durationSec });
    }
    // 前の音声の長さだけずらして 1 本につなぐ（1 本だけの録音は、ずらす量 0 でそのまま）
    const normalized = composeParts(transcribed);
    const finished = await deps.store.finishRun(deps.runId, generation, normalized);
    if (finished === "succeeded") return { status: "succeeded" };
    if (finished === "superseded") {
      // replace でない run の間に段落が入っていた: store が書かずに failed（internal）にした
      logFailure("internal");
      return { status: "failed", errorCode: "internal" };
    }
    return { status: "skipped" };
  } catch (error) {
    return await fail(errorCodeFor(error, signal), error);
  } finally {
    // エンジンが読まなかった音声は閉じる（保存先との接続を残さない）
    if (opened && !opened.body.locked) await opened.body.cancel().catch(() => undefined);
  }
}
