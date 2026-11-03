/**
 * 録音の音声として取り込めるファイルの形式（ブラウザ側。#36 段 3b-1）。
 * 正は server の `AUDIO_FORMATS`（src/recording/audio-limits.ts）で、ここはその写し（server の方は node:crypto を読むので、
 * ブラウザの bundle に入れない）。一致はテスト（audio-formats.test.ts）で確かめる。受け付けるかの最後の判断は、
 * `GET /api/recordings/audio/limits` の値（拡張子・種類・上限）と server の検査。
 */

export const AUDIO_FILE_FORMATS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  m4a: ["audio/mp4", "audio/x-m4a", "audio/m4a"],
  mp3: ["audio/mpeg", "audio/mp3"],
  wav: ["audio/wav", "audio/x-wav", "audio/wave"],
  aac: ["audio/aac"],
  ogg: ["audio/ogg"],
  flac: ["audio/flac", "audio/x-flac"],
  webm: ["audio/webm"],
});

export const AUDIO_FILE_EXTENSIONS: readonly string[] = Object.freeze(Object.keys(AUDIO_FILE_FORMATS));

/** サーバーが取り込める形式の accept（拡張子と種類）。 */
export const AUDIO_FILE_ACCEPT = [...AUDIO_FILE_EXTENSIONS.map((extension) => `.${extension}`), ...new Set(Object.values(AUDIO_FILE_FORMATS).flat())].join(",");

const GUIDANCE_ONLY_AUDIO_EXTENSIONS = ["aif", "aiff", "aifc", "caf"] as const;
const GUIDANCE_ONLY_AUDIO_EXTENSION_SET: ReadonlySet<string> = new Set(GUIDANCE_ONLY_AUDIO_EXTENSIONS);
const GUIDANCE_ONLY_AUDIO_MIME_TYPES = ["audio/aiff", "audio/x-aiff", "audio/aifc", "audio/x-aifc", "audio/caf", "audio/x-caf"] as const;

/** 形式の説明を表示できるよう、未対応形式も選べる欄の accept。アップロード許可の一覧には使わない。 */
export const AUDIO_FILE_PICKER_ACCEPT = [
  ...AUDIO_FILE_ACCEPT.split(","),
  ...GUIDANCE_ONLY_AUDIO_EXTENSIONS.map((extension) => `.${extension}`),
  ...GUIDANCE_ONLY_AUDIO_MIME_TYPES,
].join(",");

/** 画面に出す拡張子の並び（例: `.m4a .mp3 .wav .aac .ogg .flac .webm`）。 */
export const AUDIO_FILE_EXTENSIONS_LABEL = AUDIO_FILE_EXTENSIONS.map((extension) => `.${extension}`).join(" ");

/** 名前の上限（server の AUDIO_NAME_MAX_CHARS と同じ）。 */
export const AUDIO_NAME_MAX_CHARS = 200;

/** server と同じ: パスの区切り・制御文字・向きを変える書式文字・行と段落の区切り。 */
const UNSAFE_NAME = /[/\\\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** server と同じ規則のファイル名（パス・制御文字なし、1〜200 文字）。 */
export function isSafeAudioName(name: string): boolean {
  return name.trim().length > 0 && !UNSAFE_NAME.test(name) && !LONE_SURROGATE.test(name) && Array.from(name).length <= AUDIO_NAME_MAX_CHARS;
}

/** ファイル名の拡張子（小文字。最後の `.` の後）。先頭の `.` だけ・`.` で終わる名前は null。 */
export function extensionOfName(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/** Webからの取込は未対応だが、選択時に説明を出す形式。 */
export function unsupportedAudioExtension(name: string): string | null {
  const extension = extensionOfName(name);
  return extension !== null && GUIDANCE_ONLY_AUDIO_EXTENSION_SET.has(extension) ? extension : null;
}

/** Webで直接取り込めない音声形式の説明。端末内で変換して再選択できるよう案内する。 */
export function unsupportedAudioFormatMessage(fileNames: readonly string[]): string | null {
  const formats = [...new Set(fileNames.map(unsupportedAudioExtension).filter((extension): extension is string => extension !== null))];
  if (formats.length === 0) return null;
  return `${formats.map((extension) => extension.toUpperCase()).join("・")}はWeb版では直接取り込めません。端末内の音声変換アプリでPCM WAVまたはFLACに変換してから選び直してください。`;
}

/** content type からパラメータ（`;codecs=opus` など）を除き、小文字にする。 */
export function baseContentType(type: string): string {
  return type.split(";", 1)[0]!.trim().toLowerCase();
}

/** 取り込める音声の拡張子か（形式の写しにあるか）。 */
export function isAudioFileName(name: string): boolean {
  const extension = extensionOfName(name);
  return extension !== null && Object.hasOwn(AUDIO_FILE_FORMATS, extension);
}

/**
 * 申告する content type。ファイルの種類がその拡張子に対応していればそれ（パラメータを除く）、違う・空なら拡張子の代表の種類。
 * 取り込めない拡張子なら null。
 */
export function contentTypeForAudio(name: string, type: string): string | null {
  const extension = extensionOfName(name);
  if (extension === null || !Object.hasOwn(AUDIO_FILE_FORMATS, extension)) return null;
  const types = AUDIO_FILE_FORMATS[extension]!;
  const declared = baseContentType(type);
  return types.includes(declared) ? declared : types[0]!;
}
