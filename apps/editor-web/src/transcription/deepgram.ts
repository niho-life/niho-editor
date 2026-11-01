import { deepgramKeyterms } from "@niho/docs-core";
import type { RecordingSegment } from "@niho/editor-store";
import { EngineError, type EngineErrorCode, type EngineInput, type EngineResult, type TranscriptionEngine } from "./engine";

/**
 * Deepgram の文字起こし（`EDITOR_TRANSCRIBE_ENGINE=deepgram`）。依存を足さず fetch だけで、同期の呼び出し（callback は使わない）。
 *
 * 呼び出しの形は Mac 版（apps/docs/crates/api-ai/src/deepgram.rs。NIHO 本体の写し）に合わせる:
 * - `POST https://api.deepgram.com/v1/listen?model=nova-3&language={ja|en}&smart_format=false&punctuate=true`
 *   `[&diarize_model=latest（話者を分けるときだけ）]&utterances=true&paragraphs=false[&keyterm=…（繰り返し）]`。
 *   Deepgram は `diarize_model` と `diarize=true` の併用を拒否するため、話者を分ける指定は `diarize_model` だけにする。
 * - keyterm は docs-core の deepgramKeyterms（表記だけ・重なりを除き・500 バイトの予算まで）。
 * - 本文は音声のバイト列そのまま（保存先から読み出した stream をそのまま流す。Node の fetch は `duplex: "half"` が要る）。
 *   header は `Authorization: Token <鍵>`・`Content-Type: <音声の種類>`・`Content-Length: <大きさ>`。
 * - 応答は 64 MiB まで読み、`results.utterances[]`（start・end・speaker・transcript）と `metadata.duration` を読む。
 *
 * 失敗の写し方: 届かない・401・402・403・429・5xx は unavailable、400・413・415・422 は rejected、408・時間切れ・中断は timeout、
 * JSON でない・utterances が無い／空は bad_response、応答が 64 MiB を超えたら too_large。
 * 鍵・音声・応答の本文・URL は、ログにもエラーにも出さない（このファイルはログを書かず、エラーは固定の文の EngineError だけ）。
 * リダイレクトは辿らない（鍵を別の場所へ送らない）。**実際の Deepgram では未検証**（fetch を差し替えたテストだけ）。
 */

export const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";
export const DEEPGRAM_MODEL = "nova-3";
/** 応答の本文の上限（Mac 版と同じ 64 MiB）。 */
export const DEEPGRAM_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
/** 1 回の呼び出しの時間切れの既定（20 分）。 */
export const DEEPGRAM_DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/** header に入れてよい 1 語（空白・改行・制御文字なし）。 */
const HEADER_TOKEN = /^[\x21-\x7e]+$/;

type Fetch = typeof fetch;

export type DeepgramEngineOptions = {
  /** 鍵を返す（呼ぶたびに読む。値は戻り値の外へ出さない）。 */
  apiKey: () => string;
  fetch?: Fetch;
  timeoutMs?: number;
};

/** 送る URL（鍵は入れない）。 */
export function deepgramListenUrl(input: Pick<EngineInput, "language" | "diarize" | "terms">): string {
  const url = new URL(DEEPGRAM_LISTEN_URL);
  const query = url.searchParams;
  query.append("model", DEEPGRAM_MODEL);
  query.append("language", input.language === "en" ? "en" : "ja");
  query.append("smart_format", "false");
  query.append("punctuate", "true");
  if (input.diarize) query.append("diarize_model", "latest");
  query.append("utterances", "true");
  query.append("paragraphs", "false");
  const keyterms = deepgramKeyterms(input.terms.map((term) => ({ term, reading: "", variants: [], note: "" })));
  for (const keyterm of keyterms) query.append("keyterm", keyterm);
  return url.toString();
}

function statusError(status: number): EngineErrorCode {
  if (status === 400 || status === 413 || status === 415 || status === 422) return "rejected";
  if (status === 408) return "timeout";
  return "unavailable";
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** 本文を上限まで読む。超えたら too_large、途中で切れたら（中断なら timeout）unavailable。 */
async function readLimited(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > DEEPGRAM_RESPONSE_MAX_BYTES) {
    await discard(response);
    throw new EngineError("too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new EngineError("bad_response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > DEEPGRAM_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new EngineError("too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw new EngineError(signal.aborted ? "timeout" : "unavailable");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 応答の JSON → 生の結果（話者は Deepgram の 0 始まりの番号のまま）。utterances が無い・空・形が違えば bad_response。 */
export function parseDeepgramResponse(value: unknown): EngineResult {
  const results = isRecord(value) ? value.results : undefined;
  const utterances = isRecord(results) ? results.utterances : undefined;
  if (!Array.isArray(utterances) || utterances.length === 0) throw new EngineError("bad_response");
  const segments: RecordingSegment[] = [];
  for (const utterance of utterances) {
    if (!isRecord(utterance) || typeof utterance.transcript !== "string") continue;
    const speaker = utterance.speaker;
    segments.push({
      start: finiteOrNull(utterance.start),
      end: finiteOrNull(utterance.end),
      text: utterance.transcript,
      speaker: typeof speaker === "number" && Number.isSafeInteger(speaker) && speaker >= 0 ? speaker : null,
    });
  }
  if (segments.length === 0) throw new EngineError("bad_response");
  const metadata = isRecord(value) ? value.metadata : undefined;
  const duration = isRecord(metadata) ? finiteOrNull(metadata.duration) : null;
  return { segments, durationSec: duration !== null && duration >= 0 ? duration : null };
}

export function createDeepgramEngine(options: DeepgramEngineOptions): TranscriptionEngine {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEEPGRAM_DEFAULT_TIMEOUT_MS;

  const authorization = (): string => {
    let key: string;
    try {
      key = options.apiKey();
    } catch {
      throw new EngineError("unavailable");
    }
    if (typeof key !== "string" || !HEADER_TOKEN.test(key)) throw new EngineError("unavailable");
    return `Token ${key}`;
  };

  return {
    name: "deepgram",
    async transcribe(input: EngineInput): Promise<EngineResult> {
      const { audio } = input;
      if (!HEADER_TOKEN.test(audio.contentType) || !Number.isSafeInteger(audio.sizeBytes) || audio.sizeBytes < 1) throw new EngineError("rejected");
      const headers = { Authorization: authorization(), "Content-Type": audio.contentType, "Content-Length": String(audio.sizeBytes) };
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]);
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        headers,
        body: audio.stream,
        duplex: "half",
        redirect: "error",
        signal,
      };
      let response: Response;
      try {
        response = await doFetch(deepgramListenUrl(input), init);
      } catch {
        // 中身（URL・鍵を含み得る）は捨てる
        throw new EngineError(signal.aborted ? "timeout" : "unavailable");
      }
      if (!response.ok) {
        // 失敗の本文は読まない（音声や鍵の断片を含み得る）
        await discard(response);
        throw new EngineError(statusError(response.status));
      }
      const bytes = await readLimited(response, signal);
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new EngineError("bad_response");
      }
      return parseDeepgramResponse(value);
    },
  };
}
