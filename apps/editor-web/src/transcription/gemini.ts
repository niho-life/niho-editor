import {
  buildAudioTranscriptionPrompt,
  parseAudioTranscriptParagraphs,
  type GlossaryEntry,
  type SpeakerMode,
} from "@niho/docs-core";
import type { RecordingSegment } from "@niho/editor-store";
import { EngineError, type EngineErrorCode, type EngineInput, type EngineResult, type TranscriptionEngine } from "./engine";

/**
 * Gemini の文字起こし（`EDITOR_TRANSCRIBE_ENGINE=gemini`）。依存を足さず fetch だけ。
 *
 * 呼び出しの形は Mac 版（apps/docs/crates/api-ai/src/turn.rs の upload_audio と providers.rs の fileData）に合わせる:
 * 1. `POST {base}/upload/v1beta/files`（`X-Goog-Upload-Protocol: resumable`・`X-Goog-Upload-Command: start`・
 *    `X-Goog-Upload-Header-Content-Length`・`X-Goog-Upload-Header-Content-Type`、本文は `{"file":{"display_name":…}}`）
 *    → 応答の header `x-goog-upload-url`（**base で始まる URL だけを使う**。鍵は付けない）
 * 2. その URL へ `POST`（`X-Goog-Upload-Offset: 0`・`X-Goog-Upload-Command: upload, finalize`、本文は音声のバイト列そのまま。
 *    保存先から読み出した stream をそのまま流す〔Node の fetch は `duplex: "half"` が要る〕）→ `{file:{name,uri,state}}`
 * 3. `state` が `ACTIVE` になるまで `GET {base}/v1beta/{name}` を 1 秒ごとに見る（`FAILED`・待ちすぎ・時間切れは失敗）
 * 4. `POST {base}/v1beta/models/{model}:generateContent` に 指示文 ＋ `fileData`（アップロードした音声）を送る
 * 5. 終わったら（失敗しても）`DELETE {base}/v1beta/{name}` で消す（Gemini 側に音声を残さない）
 *
 * 鍵は `x-goog-api-key` の header（URL に入れない）。指示文と返事の読み取りは **docs-core の audio-transcription.ts**
 * （旧 NIHO docs と同じ指示・同じ読み取り）。返事は `[mm:ss] 話者N: 本文` の行なので、段落の始まりの時刻だけが分かる
 * （終わりは次の段落の始まり。最後の段落は始まりと同じ）。話者は「話者N」のラベルを初出の順に 1 から振る。
 *
 * 失敗の写し方: 届かない・401・403・429・5xx は unavailable、400・413・415・422 は rejected、408・時間切れ・中断は timeout、
 * JSON でない・候補が無い・段落が取れないは bad_response、応答が 16 MiB を超えたら too_large。
 * 鍵・音声・応答の本文・URL は、ログにもエラーにも出さない（このファイルはログを書かず、エラーは固定の文の EngineError だけ）。
 * リダイレクトは辿らない（鍵を別の場所へ送らない）。**実際の Gemini では未検証**（fetch を差し替えたテストだけ）。
 */

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
/** 返事の本文の上限（文字起こしの Markdown なので 16 MiB で足りる）。 */
export const GEMINI_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
/** アップロードした音声が使えるようになるまで待つ上限。 */
export const GEMINI_FILE_WAIT_MS = 10 * 60 * 1000;
/** 使えるようになったかを見る間隔。 */
export const GEMINI_FILE_POLL_MS = 1000;
/** 1 回の呼び出しの時間切れの既定（20 分）。 */
export const GEMINI_DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
/** 出力の上限（長い録音の全文が出るように大きく取る）。 */
export const GEMINI_MAX_OUTPUT_TOKENS = 65_536;

/** header に入れてよい 1 語（空白・改行・制御文字なし）。 */
const HEADER_TOKEN = /^[\x21-\x7e]+$/;
/** Gemini が返すファイルの名前（`files/xxxx`）。 */
const FILE_NAME = /^files\/[a-z0-9-]{1,128}$/;

type Fetch = typeof fetch;

export type GeminiEngineOptions = {
  /** 鍵を返す（呼ぶたびに読む。値は戻り値の外へ出さない）。 */
  apiKey: () => string;
  model: string;
  fetch?: Fetch;
  timeoutMs?: number;
  /** 使えるようになるまで待つ（テストで差し替える）。 */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 音声の長さ（秒）が分かれば、最後の段落の終わりに使う。 */
  now?: () => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusError(status: number): EngineErrorCode {
  if (status === 400 || status === 413 || status === 415 || status === 422) return "rejected";
  if (status === 408) return "timeout";
  return "unavailable";
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** 本文を上限まで読む。超えたら too_large。 */
async function readLimited(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new EngineError("bad_response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > GEMINI_RESPONSE_MAX_BYTES) {
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
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new EngineError("bad_response");
  }
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const text = await readLimited(response, signal);
  try {
    return JSON.parse(text);
  } catch {
    throw new EngineError("bad_response");
  }
}

/** 返事の本文（候補の最初のテキスト部分をつなぐ）。無ければ bad_response。 */
export function geminiReplyText(value: unknown): string {
  const candidates = isRecord(value) ? value.candidates : undefined;
  const first = Array.isArray(candidates) ? candidates[0] : undefined;
  const content = isRecord(first) ? first.content : undefined;
  const parts = isRecord(content) ? content.parts : undefined;
  if (!Array.isArray(parts)) throw new EngineError("bad_response");
  const text = parts
    // 考えている途中の文（thought）は本文に入れない
    .filter((part): part is { text: string } => isRecord(part) && typeof part.text === "string" && part.thought !== true)
    .map((part) => part.text)
    .join("");
  if (text.trim() === "") throw new EngineError("bad_response");
  return text;
}

/** 話者を分けるか → docs-core の話者の指定。 */
function speakerMode(diarize: boolean): SpeakerMode {
  return diarize ? "auto" : "none";
}

function glossary(terms: readonly string[]): GlossaryEntry[] {
  return terms.map((term) => ({ term, reading: "", variants: [], note: "" }));
}

/**
 * 返事の本文 → エンジンの生の結果。`[mm:ss] 話者N: 本文` の段落を、時刻の順にそろえ（戻らない）、
 * 終わりは次の段落の始まり（最後は始まりと同じ）にする。話者のラベルは初出の順に 1 から。
 */
export function parseGeminiTranscript(text: string, input: { diarize: boolean; language: "ja" | "en" }): EngineResult {
  const paragraphs = parseAudioTranscriptParagraphs({ text, speakers: speakerMode(input.diarize), language: input.language });
  if (paragraphs.length === 0) throw new EngineError("bad_response");
  const numbers = new Map<string, number>();
  const starts: (number | null)[] = [];
  const draft: { text: string; speaker: number | null }[] = [];
  let last = 0;
  for (const paragraph of paragraphs) {
    let speaker: number | null = null;
    if (paragraph.rawLabel !== null) {
      speaker = numbers.get(paragraph.rawLabel) ?? numbers.size + 1;
      numbers.set(paragraph.rawLabel, speaker);
    }
    if (paragraph.offsetSec === null) {
      // 時刻の無い段落は、直前の段落と同じ時刻（先頭なら 0 秒）
      starts.push(draft.length === 0 ? 0 : last);
    } else {
      // 時刻は戻さない（返事が前後したら直前に合わせる）
      last = Math.max(last, paragraph.offsetSec);
      starts.push(last);
    }
    draft.push({ text: paragraph.text, speaker });
  }
  const segments: RecordingSegment[] = draft.map((paragraph, index) => {
    const start = starts[index] ?? null;
    const next = starts[index + 1] ?? null;
    return { start, end: start === null ? null : Math.max(start, next ?? start), text: paragraph.text, speaker: paragraph.speaker };
  });
  return { segments, durationSec: last > 0 ? last : null };
}

const sleepMs = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new EngineError("timeout"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export function createGeminiEngine(options: GeminiEngineOptions): TranscriptionEngine {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? GEMINI_DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep ?? sleepMs;
  const base = GEMINI_API_BASE;

  const key = (): string => {
    let value: string;
    try {
      value = options.apiKey();
    } catch {
      throw new EngineError("unavailable");
    }
    if (typeof value !== "string" || !HEADER_TOKEN.test(value)) throw new EngineError("unavailable");
    return value;
  };

  /** 音声をアップロードする（resumable の 2 段）。返すのは `files/xxx` と、指示文に付ける uri。 */
  const upload = async (input: EngineInput, signal: AbortSignal): Promise<{ name: string; uri: string }> => {
    const start = await doFetch(`${base}/upload/v1beta/files`, {
      method: "POST",
      headers: {
        "x-goog-api-key": key(),
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(input.audio.sizeBytes),
        "X-Goog-Upload-Header-Content-Type": input.audio.contentType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: "niho-editor-audio" } }),
      redirect: "error",
      signal,
    }).catch(() => {
      throw new EngineError(signal.aborted ? "timeout" : "unavailable");
    });
    if (!start.ok) {
      await discard(start);
      throw new EngineError(statusError(start.status));
    }
    const uploadUrl = start.headers.get("x-goog-upload-url");
    await discard(start);
    // 上げ先は Gemini の中だけ（別の場所へ音声を送らない）
    if (!uploadUrl || !uploadUrl.startsWith(`${base}/`)) throw new EngineError("unavailable");

    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize", "Content-Length": String(input.audio.sizeBytes) },
      body: input.audio.stream,
      duplex: "half",
      redirect: "error",
      signal,
    };
    const sent = await doFetch(uploadUrl, init).catch(() => {
      throw new EngineError(signal.aborted ? "timeout" : "unavailable");
    });
    if (!sent.ok) {
      await discard(sent);
      throw new EngineError(statusError(sent.status));
    }
    const body = await readJson(sent, signal);
    const file = isRecord(body) ? body.file : undefined;
    const name = isRecord(file) && typeof file.name === "string" && FILE_NAME.test(file.name) ? file.name : null;
    if (!name) throw new EngineError("bad_response");
    return { name, uri: isRecord(file) && typeof file.uri === "string" ? file.uri : "" };
  };

  const remove = async (name: string): Promise<void> => {
    if (!FILE_NAME.test(name)) return;
    // 消せなくても結果は返す（Gemini 側は 48 時間で消える）。応答は読まない
    const response = await doFetch(`${base}/v1beta/${name}`, { method: "DELETE", headers: { "x-goog-api-key": key() }, redirect: "error" }).catch(() => null);
    if (response) await discard(response);
  };

  /** 使えるようになるまで待つ（PROCESSING → ACTIVE）。 */
  const waitActive = async (file: { name: string; uri: string }, signal: AbortSignal): Promise<string> => {
    let uri = file.uri;
    const deadline = Date.now() + GEMINI_FILE_WAIT_MS;
    for (;;) {
      const response = await doFetch(`${base}/v1beta/${file.name}`, {
        method: "GET",
        headers: { "x-goog-api-key": key() },
        redirect: "error",
        signal,
      }).catch(() => {
        throw new EngineError(signal.aborted ? "timeout" : "unavailable");
      });
      if (!response.ok) {
        await discard(response);
        throw new EngineError(statusError(response.status));
      }
      const body = await readJson(response, signal);
      const state = isRecord(body) && typeof body.state === "string" ? body.state : "ACTIVE";
      if (isRecord(body) && typeof body.uri === "string" && body.uri !== "") uri = body.uri;
      if (state === "ACTIVE") {
        if (uri === "") throw new EngineError("bad_response");
        return uri;
      }
      if (state === "FAILED") throw new EngineError("rejected");
      if (Date.now() >= deadline) throw new EngineError("timeout");
      await sleep(GEMINI_FILE_POLL_MS, signal);
    }
  };

  return {
    name: "gemini",
    async transcribe(input: EngineInput): Promise<EngineResult> {
      const { audio } = input;
      if (!HEADER_TOKEN.test(audio.contentType) || !Number.isSafeInteger(audio.sizeBytes) || audio.sizeBytes < 1) throw new EngineError("rejected");
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]);
      const file = await upload(input, signal);
      try {
        const uri = await waitActive(file, signal);
        // 指示文は旧 NIHO docs と同じもの（docs-core）。区切りは 1 つ（音声ごとに 1 回呼ぶ）
        const prompt = buildAudioTranscriptionPrompt(
          { title: null, language: input.language, speakers: speakerMode(input.diarize), terms: glossary(input.terms) },
          { index: 0, count: 1, speakers: speakerMode(input.diarize), fileName: null, referenceLines: [] },
        );
        const response = await doFetch(`${base}/v1beta/models/${options.model}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": key(), "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }, { fileData: { mimeType: audio.contentType, fileUri: uri } }] }],
            generationConfig: { temperature: 0, maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS },
          }),
          redirect: "error",
          signal,
        }).catch(() => {
          throw new EngineError(signal.aborted ? "timeout" : "unavailable");
        });
        if (!response.ok) {
          // 失敗の本文は読まない（音声や鍵の断片を含み得る）
          await discard(response);
          throw new EngineError(statusError(response.status));
        }
        return parseGeminiTranscript(geminiReplyText(await readJson(response, signal)), input);
      } finally {
        // 成功しても失敗しても、Gemini 側の音声は消す
        await remove(file.name);
      }
    },
  };
}
