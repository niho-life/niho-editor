/**
 * 文字起こしの案の名前（#36 段 3b-4）。旧 NIHO docs の candidates.ts の sourceCandidateName と同じ規則:
 * **エンジンの名前**。同じ名前の案があれば「Deepgram 2」のように数を足す（エンジンは案の一意キーにしない）。
 * 画面に出すエンジンの名前も、設定・案の名前・一覧で同じものを使う。
 *
 * この関数は**画面（client）からも呼ぶ**ので、`@niho/editor-store` を読まない（store の入口は `node:crypto` を読むため、
 * client の束に入れられない）。名前の上限は store の CHECK と同じ値をここに持つ（recording-client.ts の上限と同じ作法）。
 */

/** 案の名前の文字数の上限（store の RECORDING_CANDIDATE_NAME_MAX_CHARS・migration の CHECK と同じ）。 */
export const CANDIDATE_NAME_MAX_CHARS = 60;

/** エンジンの id → 画面の名前。知らないエンジン（あとで増えるもの）は id をそのまま出す。 */
const ENGINE_LABELS: Readonly<Record<string, string>> = {
  deepgram: "Deepgram",
  fake: "開発の偽物",
  "vtt-import": "取り込んだ字幕",
  gemini: "Gemini",
  "this-mac": "この Mac",
};

export function candidateEngineLabel(engine: string | null): string {
  if (engine === null) return "文字起こし";
  return ENGINE_LABELS[engine] ?? engine;
}

/** 音声をどこへ送るか、実行前に使う短い表示。未知の provider は推測しない。 */
export function transcriptionServiceNote(engine: string | null): string {
  switch (engine) {
    case "deepgram":
      return "文字起こしを始めると、音声は Deepgram に送られます";
    case "gemini":
      return "文字起こしを始めると、音声は Google Gemini に送られます";
    case "fake":
      return "開発用エンジンで文字起こしします。音声は外部サービスへ送られません";
    case "this-mac":
      return "この Mac で文字起こしします。音声は外部サービスへ送られません";
    default:
      return "文字起こしの送信先を確認できません。現在、文字起こしを開始できません";
  }
}

/** 設定された送信先を表示できる engine か。未知の id は開始前に止める。 */
export function canDiscloseTranscriptionEngine(engine: string | null | undefined): engine is "deepgram" | "gemini" | "fake" | "this-mac" {
  return engine === "deepgram" || engine === "gemini" || engine === "fake" || engine === "this-mac";
}

/** 1 つ目の案（いまの文字起こし）に付ける名前。何で作ったか分からない録音は「はじめの案」。 */
export function primaryCandidateName(engine: string | null): string {
  return engine === null ? "はじめの案" : candidateEngineLabel(engine);
}

/** 新しい案の名前（エンジンの名前。同じ名前があれば 2・3… を足す）。 */
export function nextCandidateName(existing: readonly string[], engine: string): string {
  const label = candidateEngineLabel(engine);
  const names = new Set(existing);
  if (!names.has(label)) return label;
  for (let n = 2; ; n += 1) {
    const name = `${label} ${n}`;
    // 名前の上限（store の CHECK と同じ）を超えないよう、長いエンジン名は数だけで区別する
    if (Array.from(name).length > CANDIDATE_NAME_MAX_CHARS) return `案 ${n}`;
    if (!names.has(name)) return name;
  }
}
