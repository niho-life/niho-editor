/**
 * 文字起こしのエンジンの表示（#36 段 3b-4 → #310）。エンジンの id → 画面の名前と、音声をどこへ送るかの短い表示。
 * 文字起こしのタブの札（`tab_name`）はサーバー（editor-store の `transcriptEngineLabel`）が同じ表から付ける。
 *
 * この関数は**画面（client）からも呼ぶ**ので、`@niho/editor-store` を読まない（store の入口は `node:crypto` を読むため、
 * client の束に入れられない）。
 */

/** エンジンの id → 画面の名前。知らないエンジン（あとで増えるもの）は id をそのまま出す。 */
const ENGINE_LABELS: Readonly<Record<string, string>> = {
  deepgram: "Deepgram",
  fake: "開発の偽物",
  "vtt-import": "取り込んだ字幕",
  import: "取り込み",
  gemini: "Gemini",
  "gemini-cli": "Gemini（このMacのCLI）",
  "apple-local": "Apple（このMac内）",
  "this-mac": "この Mac",
};

export function transcriptionEngineLabel(engine: string | null): string {
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
    case "gemini-cli":
      return "このMacのAntigravity CLIから音声をGoogle Geminiへ送ります";
    case "apple-local":
      return "Appleの端末内音声認識を使います。音声は外部providerへ送られません";
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
