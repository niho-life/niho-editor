/**
 * 文字起こしのエンジン（`EDITOR_TRANSCRIBE_ENGINE`）・鍵（`DEEPGRAM_API_KEY`・`GEMINI_API_KEY`）・Gemini のモデル
 * （`EDITOR_GEMINI_MODEL`）・時間切れ（`EDITOR_TRANSCRIBE_TIMEOUT_SEC`）。
 * 要求のたびに読む（import 時・`next build` 時に固めない）。本番の守りは保存先（src/storage/config.ts）と同じ形:
 *
 * - `fake`: 決定的な偽物（開発と CI だけ）。`NODE_ENV=production` では受け付けない（起動を止める。偽物の文字起こしを本番のページに書かない）。
 * - `deepgram`: Deepgram（src/transcription/deepgram.ts）。`DEEPGRAM_API_KEY` が必須で、無い・形が不正（前後の空白を除いたあとに空白・改行・
 *   制御文字を含む）なら起動を止める。前後の空白（Secret Manager の値の末尾の改行など）は除いて使う（#38 の Anthropic の鍵と同じ）。
 * - `gemini`: Gemini（src/transcription/gemini.ts）。`GEMINI_API_KEY` が必須（検査は Deepgram の鍵と同じ）。モデルは
 *   `EDITOR_GEMINI_MODEL`（既定 `gemini-3.8-flash`。`[a-z0-9.-]` の 1〜64 文字だけ）。
 * - **両方の鍵が入っていれば、両方のエンジンが使える**（案を別のエンジンで作れる。`availableTranscriptionEngines`）。
 *   `EDITOR_TRANSCRIBE_ENGINE` はそのうち**既定**のエンジン（画面が選ばなかったときに使う）。
 * - `off`: 使わない（開始の API は 503 `transcription_unavailable`）。
 * - 未設定・空: 本番は `off`、それ以外は `fake`。
 * - それ以外の値: 誤り（起動を止める）。
 * - `EDITOR_TRANSCRIBE_TIMEOUT_SEC`: 1 回の文字起こしの時間切れ（秒）。既定 1200（20 分）、60〜3300 の整数。範囲の外・整数でなければ誤り。
 *
 * 本番の守りは 2 か所: 起動時の検査（src/startup-check.ts。誤りなら process を終える）と、要求ごとの解決（src/transcription/runtime.ts。
 * 誤りなら文字起こしなし＝503）。エラーのメッセージには値（鍵）を入れない。鍵は戻り値の関数の中だけに持つ
 * （戻り値を JSON.stringify・文字列にしても鍵は出ない）。
 */

export const TRANSCRIBE_ENGINE_MODES = ["fake", "deepgram", "gemini", "off"] as const;
export type TranscribeEngineMode = (typeof TRANSCRIBE_ENGINE_MODES)[number];

export const TRANSCRIBE_TIMEOUT_DEFAULT_SEC = 1200;
export const TRANSCRIBE_TIMEOUT_MIN_SEC = 60;
export const TRANSCRIBE_TIMEOUT_MAX_SEC = 3300;

export type TranscriptionEnv = {
  readonly NODE_ENV?: string | undefined;
  readonly EDITOR_TRANSCRIBE_ENGINE?: string | undefined;
  readonly DEEPGRAM_API_KEY?: string | undefined;
  readonly GEMINI_API_KEY?: string | undefined;
  readonly EDITOR_GEMINI_MODEL?: string | undefined;
  readonly EDITOR_TRANSCRIBE_TIMEOUT_SEC?: string | undefined;
};

/** Gemini のモデルの既定（apps/docs の鍵の確認が返す並びの先頭と同じもの）。 */
export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";
/** モデルの名前として受け付ける形（URL に入れるので記号を絞る）。 */
const GEMINI_MODEL = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export type TranscriptionConfig =
  | { engine: "off" }
  | { engine: "fake"; timeoutMs: number }
  /** apiKey は鍵を返す関数（値は関数の中にだけ持つ）。 */
  | { engine: "deepgram"; timeoutMs: number; apiKey: () => string }
  | { engine: "gemini"; timeoutMs: number; apiKey: () => string; model: string };

export class TranscriptionConfigError extends Error {
  override readonly name = "TranscriptionConfigError";
}

/** 鍵として受け付ける形（前後の空白を除いたあと、空白・改行・制御文字なしの 1〜512 文字）。 */
const API_KEY = /^[\x21-\x7e]{1,512}$/;

function isMode(value: string): value is TranscribeEngineMode {
  return (TRANSCRIBE_ENGINE_MODES as readonly string[]).includes(value);
}

function timeoutSec(env: TranscriptionEnv): number {
  const raw = env.EDITOR_TRANSCRIBE_TIMEOUT_SEC?.trim() ?? "";
  if (raw === "") return TRANSCRIBE_TIMEOUT_DEFAULT_SEC;
  const value = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < TRANSCRIBE_TIMEOUT_MIN_SEC || value > TRANSCRIBE_TIMEOUT_MAX_SEC) {
    throw new TranscriptionConfigError(
      `EDITOR_TRANSCRIBE_TIMEOUT_SEC must be an integer between ${TRANSCRIBE_TIMEOUT_MIN_SEC} and ${TRANSCRIBE_TIMEOUT_MAX_SEC}`,
    );
  }
  return value;
}

/** 文字起こしの方式を決める。誤りは TranscriptionConfigError（値を含めない）。 */
export function resolveTranscriptionConfig(env: TranscriptionEnv): TranscriptionConfig {
  const raw = env.EDITOR_TRANSCRIBE_ENGINE?.trim() ?? "";
  if (raw !== "" && !isMode(raw)) throw new TranscriptionConfigError(`EDITOR_TRANSCRIBE_ENGINE must be one of: ${TRANSCRIBE_ENGINE_MODES.join(", ")}`);
  const production = env.NODE_ENV === "production";
  if (raw === "fake" && production) {
    throw new TranscriptionConfigError(
      "EDITOR_TRANSCRIBE_ENGINE=fake is not allowed when NODE_ENV=production (the fake engine is for development and CI only)",
    );
  }
  // 時間切れの誤りは、使わない設定（off）でも誤り（設定の間違いを黙って通さない）
  const timeoutMs = timeoutSec(env) * 1000;
  if (raw === "deepgram") {
    const key = env.DEEPGRAM_API_KEY?.trim() ?? "";
    if (key === "") throw new TranscriptionConfigError("DEEPGRAM_API_KEY is required when EDITOR_TRANSCRIBE_ENGINE=deepgram");
    if (!API_KEY.test(key)) throw new TranscriptionConfigError("DEEPGRAM_API_KEY is not a valid key");
    return { engine: "deepgram", timeoutMs, apiKey: () => key };
  }
  if (raw === "gemini") return { engine: "gemini", timeoutMs, apiKey: geminiKey(env), model: geminiModel(env) };
  if (raw === "off") return { engine: "off" };
  if (raw === "fake") return { engine: "fake", timeoutMs };
  return production ? { engine: "off" } : { engine: "fake", timeoutMs };
}

/** Gemini の鍵（無い・形が不正なら設定の誤り）。 */
function geminiKey(env: TranscriptionEnv): () => string {
  const key = env.GEMINI_API_KEY?.trim() ?? "";
  if (key === "") throw new TranscriptionConfigError("GEMINI_API_KEY is required when EDITOR_TRANSCRIBE_ENGINE=gemini");
  if (!API_KEY.test(key)) throw new TranscriptionConfigError("GEMINI_API_KEY is not a valid key");
  return () => key;
}

function geminiModel(env: TranscriptionEnv): string {
  const model = env.EDITOR_GEMINI_MODEL?.trim() ?? "";
  if (model === "") return GEMINI_DEFAULT_MODEL;
  if (!GEMINI_MODEL.test(model)) throw new TranscriptionConfigError("EDITOR_GEMINI_MODEL is not a valid model name");
  return model;
}

/** エンジンの名前（editor-web の engine.ts と同じ並び。ここは config だけで使う）。 */
export type TranscribeEngine = "deepgram" | "fake" | "gemini";

/**
 * 使えるエンジンと、その呼び出しに要るもの（鍵・モデル）。`off`・設定の誤りは null（文字起こしを開かない）。
 * `default` は `EDITOR_TRANSCRIBE_ENGINE` のエンジン（画面が選ばなかったときに使う）。鍵が入っていれば、既定でないエンジンも
 * 使える（**案を別のエンジンで作れる**）。偽物は既定のときだけ（本番では resolveTranscriptionConfig が止める）。
 */
export type TranscriptionEngines = {
  default: TranscribeEngine;
  timeoutMs: number;
  deepgram: (() => string) | null;
  gemini: { apiKey: () => string; model: string } | null;
  fake: boolean;
};

export function resolveTranscriptionEngines(env: TranscriptionEnv): TranscriptionEngines | null {
  let config: TranscriptionConfig;
  try {
    config = resolveTranscriptionConfig(env);
  } catch {
    return null;
  }
  if (config.engine === "off") return null;
  const engines: TranscriptionEngines = { default: config.engine, timeoutMs: config.timeoutMs, deepgram: null, gemini: null, fake: config.engine === "fake" };
  if (config.engine === "deepgram") engines.deepgram = config.apiKey;
  if (config.engine === "gemini") engines.gemini = { apiKey: config.apiKey, model: config.model };
  if (!engines.deepgram) {
    const key = env.DEEPGRAM_API_KEY?.trim() ?? "";
    if (key !== "" && API_KEY.test(key)) engines.deepgram = () => key;
  }
  if (!engines.gemini) {
    const key = env.GEMINI_API_KEY?.trim() ?? "";
    // モデルの名前が不正なら Gemini は使えない（送る URL を組めない）
    if (key !== "" && API_KEY.test(key)) {
      try {
        engines.gemini = { apiKey: () => key, model: geminiModel(env) };
      } catch {
        engines.gemini = null;
      }
    }
  }
  return engines;
}

/** いま使えるエンジンの名前（画面が「別のエンジンの案」を選べるかを決める）。`off`・設定の誤りは空。 */
export function availableTranscriptionEngines(env: TranscriptionEnv): TranscribeEngine[] {
  const engines = resolveTranscriptionEngines(env);
  if (!engines) return [];
  const names: TranscribeEngine[] = [];
  if (engines.deepgram) names.push("deepgram");
  if (engines.gemini) names.push("gemini");
  if (engines.fake) names.push("fake");
  return names;
}
