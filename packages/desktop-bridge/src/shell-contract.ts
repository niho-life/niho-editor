/**
 * Mac の殻（`apps/docs`。設計 §13）が editor.niho.life に見せる command の契約。
 *
 * Rust 側は `apps/docs/src-tauri/src/shell.rs`・`shell_ai.rs`。remote から呼べる一覧は `permissions/docs.toml` の
 * `allow-editor-shell` で、`shell-contract.test.ts` がここの一覧と突き合わせる（片方だけ増えると落ちる）。
 *
 * 決まり：すべて **id だけ**でやり取りし、パスは画面に来ない。結果（音声・文字起こし・AI の差分）を**サーバーへ書くのは画面**。
 * 引数の key は camelCase（Tauri が Rust の snake_case に写す）。
 */

export const SHELL_COMMANDS = {
  /** 殻の自己紹介（版・開発の起動か・端末の力の有無）。これが返れば Mac の殻の中。 */
  capabilities: "shell_capabilities",
  micStatus: "shell_mic_status",
  recordingStart: "shell_recording_start",
  recordingStop: "shell_recording_stop",
  recordingDiscard: "shell_recording_discard",
  recordingRead: "shell_recording_read",
  audioPick: "shell_audio_pick",
  audioRead: "shell_audio_read",
  stagingDiscard: "shell_staging_discard",
  transcribeLocal: "shell_transcribe_local",
  transcribeStop: "shell_transcribe_stop",
  aiEngines: "shell_ai_engines",
  aiTurn: "shell_ai_turn",
  aiStop: "shell_ai_stop",
} as const;

export type ShellCommand = (typeof SHELL_COMMANDS)[keyof typeof SHELL_COMMANDS];

/** Rust の `CommandError`（`invoke` の reject に来る）。`details` は画面が文を組むための数だけで、本文・token は入らない。 */
export type ShellError = { code: string; message: string; details?: unknown };

export function isShellError(value: unknown): value is ShellError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

// ---------------------------------------------------------------------------
// 殻の自己紹介

export type ShellFeatures = {
  /** マイクの録音。 */
  recording: boolean;
  /** 端末内の文字起こし（同梱の niho-speech）。 */
  localTranscription: boolean;
  /** CLI の AI（Claude Code・Codex CLI・Antigravity CLI）。 */
  cliAi: boolean;
};

export type ShellCapabilities = {
  /** アプリの版（配布の版と同じ）。 */
  version: string;
  /** 開発・試験の起動か。 */
  dev: boolean;
  features: ShellFeatures;
};

// ---------------------------------------------------------------------------
// 録音（端末の力 ①）

export type ShellMicStatus = "authorized" | "denied" | "notDetermined" | "restricted";

/** 録音（パスは無い。`exported` が false なら書き出せず録音中の CAF のまま）。 */
export type ShellRecording = {
  recordingId: string;
  /** 「録音 10/16 15:30」 */
  name: string;
  durationSec: number | null;
  exported: boolean;
};

export type ShellRecordingEvent =
  | { type: "Started"; device: string | null }
  | { type: "Level"; db: number | null; durationSec: number | null }
  /** 画面が止めずに終わった（入力装置の切断など）。 */
  | { type: "Done"; audio: ShellRecording }
  | { type: "Error"; code: string; message: string };

// ---------------------------------------------------------------------------
// 音声ファイルの取り込み（一時置き場）

export type ShellStagedFile = {
  /** `audioRead(stagingId, index)` で読む番号。 */
  index: number;
  /** 選んだファイルの名前（パスは無い）。 */
  name: string;
  durationSec: number | null;
};

export type ShellStagedAudio = { stagingId: string; files: ShellStagedFile[] };

/** 端末内の文字起こしの出どころ。 */
export type ShellAudioSource = { kind: "recording"; recordingId: string } | { kind: "staged"; stagingId: string };

// ---------------------------------------------------------------------------
// 端末内の文字起こし

export type ShellTranscribeLanguage = "ja" | "en";
export type ShellSpeakerMode = "none" | "auto" | "2" | "3" | "4plus";
/** 固有名詞のヒント（`term` だけを使う）。 */
export type ShellTranscribeHint = { term: string };

export type ShellTranscribeOptions = {
  language: ShellTranscribeLanguage;
  speakerMode: ShellSpeakerMode;
  hints?: ShellTranscribeHint[];
};

export type ShellTranscribeEvent =
  | {
      type: "Stage";
      stage: "convert" | "diarize" | "silence" | "transcribe";
      /** 何番目のファイルか（0 から）。 */
      file: number;
      files: number;
      part?: number;
      parts?: number;
    }
  | { type: "Segment"; file: number; start: number | null; end: number | null; text: string | null; speaker?: unknown }
  | { type: "Progress"; file: number; part: number; parts: number; ratio: number | null };

/** ファイルごとの結果（区切りの JSONL。画面がサーバーの録音 API に書く）。 */
export type ShellTranscript = { jsonl: string; durationSec: number | null };

// ---------------------------------------------------------------------------
// CLI の AI（端末の力 ②）

/** 設計 §6.1 の engine（T5 の `chat/turns` にそのまま送る名前）。殻で動くのは CLI だけ。 */
export type ShellAiEngineName = "cli:claude-code" | "cli:codex" | "cli:antigravity";

export type ShellAiEngine = {
  engine: ShellAiEngineName;
  installed: boolean;
  authenticated: boolean;
  /** 使えないとき: "cli_not_found" | "cli_version_failed" | "cli_flags_missing" | "auth_required" | "auth_probe_failed"。 */
  reason: string | null;
  /** この CLI で使えるモデルの ID（codex・agy はログイン後の一覧。claude は空＝画面の控えの一覧）。 */
  models: string[];
  /** 思考量を指定できるか。 */
  effort: boolean;
  /** 同じ会話で続きを頼めるか。 */
  resume: boolean;
};

export type ShellAiEffort = "low" | "medium" | "high" | "max";

/** 直すページ（1 つ）。本文は限定 AST から Markdown にして渡す（`niho-docs-ui/page/markdown.ts`）。 */
export type ShellAiDocument = { pageId: string; title: string; markdown: string };

/** 参照（読むだけ）。`name` は小文字の英数字とハイフン（`context/<name>.md`。`body` は使えない）。 */
export type ShellAiContext = { name: string; title: string; markdown: string };

/** 固定の形の依頼。これ以外の項目は Rust が形ごと断る。 */
export type ShellAiTurnRequest = {
  engine: ShellAiEngineName;
  /** モデルの ID（`aiEngines()` の `models`、または画面の控えの一覧から）。 */
  model: string;
  effort?: ShellAiEffort;
  /** サーバーの会話の id。同じ会話は同じ一時置き場の path を使う（CLI の続きのため）。 */
  conversationId?: string;
  /** 前の依頼の `Done.session_id`。 */
  resumeSession?: string;
  /** 人の指示（標準入力で CLI に渡る）。 */
  instruction: string;
  page: ShellAiDocument;
  context?: ShellAiContext[];
};

export type ShellAiStopReason = "EndTurn" | "MaxTokens" | "Stopped";

export type ShellAiUsage = {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  model_used: string | null;
  cost_known: boolean;
};

/** CLI の進み（`niho-local-ai` の wire。docs-core の `TurnEvent` と同じ形）。 */
export type ShellAiEvent =
  | { type: "ThinkingDelta"; text: string }
  | { type: "TextDelta"; text: string }
  /** `summary` は対象のファイル名だけ（パス・本文は来ない）。 */
  | { type: "ToolUse"; id: string; name: string; summary: string }
  | { type: "ToolResult"; id: string; name: string; ok: boolean }
  | {
      type: "Done";
      /** 返答（会話 API の `reply` に送る）。 */
      text: string;
      stop_reason: ShellAiStopReason;
      /** 次の `resumeSession`。 */
      session_id: string | null;
      usage: ShellAiUsage;
      duration_ms: number;
      continuations: number;
    }
  | { type: "Error"; reason_code: string; message: string };

export type ShellAiEnvelope = { turnId: string; seq: number; event: ShellAiEvent };

/** 書き戻し（T5 の `chat/turns` の `writes[]` の 1 件と同じ形）。 */
export type ShellAiWrite = { pageId: string; markdown: string };

export type ShellAiTurn = {
  /** 最後のイベント（`Done` か `Error`）。 */
  finalEvent: ShellAiEvent;
  /** 本文が変わっていればその Markdown。 */
  page: ShellAiWrite | null;
  /** CLI が本文を消してしまった（反映しない。画面が知らせる）。 */
  pageRemoved: boolean;
  /** CLI が `page/` に作ったほかのファイルの数（反映しない）。 */
  extraFiles: number;
};
