/**
 * ブラウザから録音の文字起こしを始める・状態を読む薄い関数（#36 段 2b）。画面への組み込みは段 3。
 * 流れ: startTranscription（202 で run を作る。有効な run があれば 200 でそれ）→ getTranscription を数秒おきに読み、
 * status が succeeded になったら録音（GET /api/pages/{id}/recording）を読み直す。failed なら errorCode を出して「もう一度」。
 *
 * - 音声は外部のエンジン（本番は Deepgram）に渡る。そのことの表示は画面の側で行う。
 * - 段落が既にある録音は replace: true が無いと 409（reason: has_transcript）。置き換えると直した文章は残らない（画面で確かめてから送る）。
 */

export type TranscriptionRunStatus = "queued" | "running" | "succeeded" | "failed";

export type TranscriptionRun = {
  id: string;
  status: TranscriptionRunStatus;
  engine: string;
  language: "ja" | "en";
  /** 失敗の理由（audio_missing・audio_expired・engine_unavailable・engine_rejected・engine_timeout・engine_bad_response・too_large・internal）。 */
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type StartTranscriptionInput = {
  lang?: "ja" | "en";
  diarize?: boolean;
  replace?: boolean;
  terms?: string[];
  /** 使うエンジン（流れの「文字起こし 作成 ▾」。#309。無ければ設定の既定）。 */
  engine?: string;
};

/** API の失敗。`error` と `reason` はサーバーの短い code（`cannot_start`・`has_transcript`・`transcription_unavailable` など）。 */
export class TranscriptionRequestError extends Error {
  override readonly name = "TranscriptionRequestError";
  constructor(
    readonly status: number,
    readonly error: string | null = null,
    readonly reason: string | null = null,
  ) {
    super(`transcription request failed with ${status}${error ? ` (${error}${reason ? `: ${reason}` : ""})` : ""}`);
  }
}

type FetchLike = typeof fetch;

const STATUSES: readonly string[] = ["queued", "running", "succeeded", "failed"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function failure(response: Response): Promise<TranscriptionRequestError> {
  const body = await readJson(response);
  const error = isPlainObject(body) && typeof body.error === "string" ? body.error : null;
  const reason = isPlainObject(body) && typeof body.reason === "string" ? body.reason : null;
  return new TranscriptionRequestError(response.status, error, reason);
}

const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";

function toRun(value: unknown): TranscriptionRun | null {
  if (!isPlainObject(value)) return null;
  const { id, status, engine, language, errorCode, createdAt, startedAt, finishedAt } = value;
  if (typeof id !== "string" || typeof status !== "string" || !STATUSES.includes(status) || typeof engine !== "string") return null;
  if ((language !== "ja" && language !== "en") || typeof createdAt !== "string") return null;
  if (!nullableString(errorCode) || !nullableString(startedAt) || !nullableString(finishedAt)) return null;
  return { id, status: status as TranscriptionRunStatus, engine, language, errorCode, createdAt, startedAt, finishedAt };
}

function pagePath(pageId: string, rest: string): string {
  return `/api/pages/${encodeURIComponent(pageId)}/recording/${rest}`;
}

/** 文字起こしを始める（「もう一度」も同じ）。202 は作った run、200 は既に進んでいる run。 */
export async function startTranscription(
  pageId: string,
  input: StartTranscriptionInput = {},
  fetchImpl: FetchLike = fetch,
): Promise<{ status: 200 | 202; run: TranscriptionRun }> {
  const body: Record<string, unknown> = {};
  if (input.lang !== undefined) body.lang = input.lang;
  if (input.diarize !== undefined) body.diarize = input.diarize;
  if (input.replace !== undefined) body.replace = input.replace;
  if (input.terms !== undefined) body.terms = input.terms;
  if (input.engine !== undefined) body.engine = input.engine;
  const response = await fetchImpl(pagePath(pageId, "transcribe"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status !== 200 && response.status !== 202) throw await failure(response);
  const data = await readJson(response);
  const run = isPlainObject(data) ? toRun(data.run) : null;
  if (!run) throw new TranscriptionRequestError(500);
  return { status: response.status as 200 | 202, run };
}

/** 最新の run（無ければ null）。 */
export async function getTranscription(pageId: string, fetchImpl: FetchLike = fetch): Promise<TranscriptionRun | null> {
  const response = await fetchImpl(pagePath(pageId, "transcription"), { method: "GET", credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw await failure(response);
  const data = await readJson(response);
  if (!isPlainObject(data) || !("run" in data)) throw new TranscriptionRequestError(500);
  if (data.run === null) return null;
  const run = toRun(data.run);
  if (!run) throw new TranscriptionRequestError(500);
  return run;
}

/** 実行が終わったか（succeeded・failed）。 */
export function isTranscriptionDone(run: TranscriptionRun | null): boolean {
  return run !== null && (run.status === "succeeded" || run.status === "failed");
}
