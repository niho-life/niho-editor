//! NIHO docs の「このMacの AI」の実行基盤（Issue #18402・Epic #18380 の S1-B）。
//!
//! - Claude Code・Codex CLI・Antigravity CLI（agy。Gemini を動かす。`Provider::GeminiCli`）を「文を書くだけの AI」として
//!   1 回ずつ起動し、それぞれの出力（stream-json / JSONL）を共通の [`TurnEvent`] に直して返す。Tauri には依存しない
//!   （S1-A の Tauri 側がこれを呼ぶ）。
//! - 子プロセスの環境・プロセスグループ・停止と時間切れ・同時 2 件・0600 の一時ファイル・上限と未ログインの判定は、
//!   NIHO Desktop の記事エージェント（apps/desktop/src-tauri/src/article_agent.rs ほか）から写した。
//! - ツールは CLI ごとのフラグ（agy は独自のエージェント）で切る。そのうえで出力にツールの気配（init のツール一覧・
//!   tool_use・command_execution・agy の tool の step など）があれば、子プロセスを止めて `RUNTIME_NOT_CONFIGURED` にする
//!   （fail closed）。
//! - 修正の会話（[`ToolPolicy::ProjectFolder`]。S5 #18386）だけは、呼び出し側の workspace の中だけを読み書きできるファイルの
//!   ツールを許し（claude は Read・Edit・Write・Glob・Grep、codex は workspace-write の apply_patch、agy は view_file・
//!   list_dir と書き先を `.md` に限った write_to_file・replace_file_content・multi_replace_file_content）、呼び出しと結果を
//!   [`TurnEvent::ToolUse`]・[`TurnEvent::ToolResult`]（ファイル名と成否だけ）で流す。
//! - 音声の区切りの文字起こし（[`ToolPolicy::ReadFile`]。S2a #18383）は、agy の `view_file` だけを持つエージェントに、
//!   その回だけの作業フォルダに写したファイルを読ませる。
//! - 使用量の残り（[`provider_usage`]）は agy の `/usage` だけが返す。
//! - 指示文・システムプロンプト・本文はログ（[`Runtime::log`]）へ渡さない。

mod agy;
mod classify;
mod claude;
mod codex;
mod maintenance;
pub mod merge;
mod process;
mod runtime;
mod status;
mod turn;
mod types;
mod usage;

pub use maintenance::{
  install_claude, install_claude_with, start_auth, start_auth_with, update_claude, update_claude_with,
};
pub use merge::merge_continuation;
pub use process::has_running_turns;
pub use runtime::{InstallerConfig, LogFn, Runtime};
pub use status::{provider_status, provider_status_with};
pub use turn::{run_turn, run_turn_with, TurnHandle, MAX_SYSTEM_PROMPT_BYTES, MAX_USER_PROMPT_BYTES};
pub use types::{
  Capabilities, ClaudeUpdateResult, Effort, LocalAiError, Provider, ProviderStatus, ReasonCode, StopReason, ToolPolicy,
  TurnEvent, TurnRequest, Usage,
};
pub use usage::{provider_usage, provider_usage_with, ProviderUsage, UsageWindow};

/// アプリ終了時に呼ぶ。実行中の工程（SIGTERM → 800ms → SIGKILL）と、ブラウザ待ちのログインを止める。
/// 止めないと、閉じたアプリの CLI が孤児として残り、後から完了したり待ち続けたりする。
pub fn shutdown() {
  process::shutdown_turns();
  maintenance::shutdown_running_auth();
}
