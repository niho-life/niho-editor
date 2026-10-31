import type { RecordingSegment } from "@niho/editor-store";

/**
 * 文字起こしのエンジンの接続口（#36 段 2b）。サーバーが保存先から読み出した音声をそのまま流し、話者と時刻つきの段落を受け取る。
 * 実装は Deepgram（deepgram.ts）・Gemini（gemini.ts）と、開発・CI だけの偽物（fake.ts）。
 *
 * - 音声は外部のエンジン（Deepgram・Gemini）に渡る（利用者への表示は画面の側で。README）。
 * - 段落は「生」の結果（話者番号はエンジンの番号のまま。Deepgram は 0 始まり）。保存の形への正規化は normalize.ts。
 * - 失敗は EngineError（短い code だけ）。メッセージには鍵・音声・URL・エンジンの応答の本文を入れない（固定の文だけ）。
 */

export type TranscriptionEngineName = "deepgram" | "fake" | "gemini";

export type EngineAudio = {
  /** 音声の中身（エンジンが読み終えるか、失敗したら呼び出し側が cancel する）。 */
  stream: ReadableStream<Uint8Array>;
  /** 音声の種類（資産の申告の content type。audio/mp4 など）。 */
  contentType: string;
  /** 大きさ（バイト。保存先が答えた値）。 */
  sizeBytes: number;
};

export type EngineInput = {
  audio: EngineAudio;
  language: "ja" | "en";
  /** 話者を分けるか。false なら段落の話者は null にする。 */
  diarize: boolean;
  /** 固有名詞の表記（Deepgram の keyterm・Gemini の指示の「固有名詞」）。 */
  terms: readonly string[];
  /** 呼び出し側の中断・時間切れ。 */
  signal: AbortSignal;
};

/** エンジンの生の結果。segments の話者はエンジンの番号のまま（0 始まりのことがある）、時刻は秒。 */
export type EngineResult = { segments: RecordingSegment[]; durationSec: number | null };

export type TranscriptionEngine = {
  readonly name: TranscriptionEngineName;
  transcribe(input: EngineInput): Promise<EngineResult>;
};

/**
 * unavailable: 届かない・鍵や権限・混雑（402・429・5xx）/ rejected: エンジンが音声・要求を断った（400・413・415 など）/
 * timeout: 時間切れ / bad_response: 応答の形が違う・段落が無い / too_large: 結果が大きすぎる（応答 64 MiB・段落の数・本文の合計）
 */
export type EngineErrorCode = "unavailable" | "rejected" | "timeout" | "bad_response" | "too_large";

export const ENGINE_ERROR_CODES: readonly EngineErrorCode[] = ["unavailable", "rejected", "timeout", "bad_response", "too_large"];

const MESSAGES: Record<EngineErrorCode, string> = {
  unavailable: "editor-web: transcription engine is unavailable",
  rejected: "editor-web: transcription engine rejected the audio",
  timeout: "editor-web: transcription engine timed out",
  bad_response: "editor-web: transcription engine returned an unexpected response",
  too_large: "editor-web: transcription result is too large",
};

/** エンジンの失敗。メッセージは code ごとの固定の文だけ。 */
export class EngineError extends Error {
  override readonly name = "EngineError";
  readonly code: EngineErrorCode;
  constructor(code: EngineErrorCode) {
    super(MESSAGES[code]);
    this.code = code;
  }
}

export function isEngineErrorCode(value: unknown): value is EngineErrorCode {
  return typeof value === "string" && (ENGINE_ERROR_CODES as readonly string[]).includes(value);
}
