import { createHash } from "node:crypto";
import type { PageLang } from "@niho/editor-store";

/**
 * 録音の音声の上限と、受け付ける形式（#36 段 2a）。純粋な関数だけ（保存先・DB に触れない）。
 * 上限は設計 §12「1 ファイルの長さと容量の上限を設定に明記し、超えたら保存前に断る」。値はここの 1 か所だけにある。
 */

/**
 * 1 ファイルの容量の上限（2 GiB）と長さの上限（6 時間）。2026-11-01 にオーナーが製品値として確定。
 * 長さはクライアントの申告（分かるときだけ）で確かめる。サーバーは音声を読まない。
 */
export const AUDIO_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const AUDIO_MAX_DURATION_SEC = 6 * 60 * 60;
/** クラウドの音声を残す日数（NIHO docs の方針を継承）。消すのは bucket のライフサイクル規則（prefix `audio/`）で、アプリは期限を出すだけ。 */
export const AUDIO_RETENTION_DAYS = 30;
/** ファイル名の上限（page_recordings.source_name の CHECK と同じ）。 */
export const AUDIO_NAME_MAX_CHARS = 200;

/**
 * 受け付ける拡張子と、それぞれに対応する content type（小文字・パラメータなし）。`.vtt` は音声ではない（VTT の取り込みを使う）。
 * `webm` はブラウザのマイク録音（MediaRecorder。Chrome・Firefox は `audio/webm;codecs=opus`）の形。
 */
export const AUDIO_FORMATS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  m4a: ["audio/mp4", "audio/x-m4a", "audio/m4a"],
  mp3: ["audio/mpeg", "audio/mp3"],
  wav: ["audio/wav", "audio/x-wav", "audio/wave"],
  aac: ["audio/aac"],
  ogg: ["audio/ogg"],
  flac: ["audio/flac", "audio/x-flac"],
  webm: ["audio/webm"],
});

export const AUDIO_EXTENSIONS: readonly string[] = Object.freeze(Object.keys(AUDIO_FORMATS));
export const AUDIO_CONTENT_TYPES: readonly string[] = Object.freeze([...new Set(Object.values(AUDIO_FORMATS).flat())]);

export type AudioStartRejection = "name" | "content_type" | "extension" | "size" | "too_large" | "sha256" | "lang" | "duration" | "too_long";

export type AudioStartInput = {
  name: unknown;
  contentType: unknown;
  sizeBytes: unknown;
  sha256: unknown;
  lang?: unknown;
  durationSec?: unknown;
};

/** 検査を通った開始の要求（正規化した値）。 */
export type AudioStart = {
  name: string;
  /** ページの題名（ファイル名から拡張子を除いたもの）。 */
  title: string;
  extension: string;
  /** 小文字にし、パラメータ（`;` から後）を除いた content type。 */
  contentType: string;
  sizeBytes: number;
  /** クライアントの申告の SHA-256（サーバーは検証しない）。 */
  sha256: string;
  lang: PageLang;
  durationSec: number | null;
};

export type AudioStartResult = { ok: true; value: AudioStart } | { ok: false; reason: AudioStartRejection };

/** 名前に入れない文字: パスの区切り・制御文字・向きを変える書式文字・行と段落の区切り。 */
const UNSAFE_NAME = /[/\\\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/;
/** 対になっていない surrogate。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const SHA256 = /^[0-9a-f]{64}$/;

/** ファイル名だけ（パス・制御文字なし）、1〜200 文字。 */
function isSafeName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.trim().length > 0 &&
    !UNSAFE_NAME.test(name) &&
    !LONE_SURROGATE.test(name) &&
    Array.from(name).length <= AUDIO_NAME_MAX_CHARS
  );
}

/** ファイル名の最後の `.` の後（小文字）。先頭の `.` だけの名前・`.` で終わる名前は拡張子なし。 */
function extensionOf(name: string): { stem: string; extension: string } | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return { stem: name.slice(0, dot).trim(), extension: name.slice(dot + 1).toLowerCase() };
}

/**
 * 開始の要求の検査（保存の前に断る）。順に name → extension（受け付ける拡張子か）→ content_type（受け付ける種類か）→
 * extension（拡張子と種類が対応するか）→ size・too_large → sha256 → lang → duration・too_long。
 */
export function validateAudioStart(input: AudioStartInput): AudioStartResult {
  const { name } = input;
  if (!isSafeName(name)) return { ok: false, reason: "name" };
  const parts = extensionOf(name);
  if (!parts || !Object.hasOwn(AUDIO_FORMATS, parts.extension)) return { ok: false, reason: "extension" };
  if (typeof input.contentType !== "string") return { ok: false, reason: "content_type" };
  // パラメータ（`;codecs=opus` など）は除いて比べ、除いた形で持つ
  const contentType = input.contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (!AUDIO_CONTENT_TYPES.includes(contentType)) return { ok: false, reason: "content_type" };
  if (!AUDIO_FORMATS[parts.extension]!.includes(contentType)) return { ok: false, reason: "extension" };

  const { sizeBytes } = input;
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1) return { ok: false, reason: "size" };
  if (sizeBytes > AUDIO_MAX_BYTES) return { ok: false, reason: "too_large" };

  if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) return { ok: false, reason: "sha256" };

  let lang: PageLang = "ja";
  if (input.lang !== undefined) {
    if (input.lang !== "ja" && input.lang !== "en") return { ok: false, reason: "lang" };
    lang = input.lang;
  }

  let durationSec: number | null = null;
  if (input.durationSec !== undefined && input.durationSec !== null) {
    const duration = input.durationSec;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return { ok: false, reason: "duration" };
    if (duration > AUDIO_MAX_DURATION_SEC) return { ok: false, reason: "too_long" };
    durationSec = duration;
  }

  return {
    ok: true,
    value: {
      name,
      title: parts.stem,
      extension: parts.extension,
      contentType,
      sizeBytes,
      sha256: input.sha256,
      lang,
      durationSec,
    },
  };
}

/**
 * 開始の要求の正規化した内容の SHA-256（冪等キーの比較用）。同じキーで同じ内容なら同じ値、項目のどれかが違えば違う値。
 * 題名・拡張子は名前から決まるので入れない。
 */
export function audioRequestHash(start: AudioStart): string {
  const canonical = JSON.stringify([start.name, start.contentType, start.sizeBytes, start.sha256, start.lang, start.durationSec]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** 画面に出す上限（`GET /api/recordings/audio/limits` の本文）。 */
export function audioLimits() {
  return {
    maxBytes: AUDIO_MAX_BYTES,
    maxDurationSec: AUDIO_MAX_DURATION_SEC,
    retentionDays: AUDIO_RETENTION_DAYS,
    extensions: [...AUDIO_EXTENSIONS],
    contentTypes: [...AUDIO_CONTENT_TYPES],
  };
}
