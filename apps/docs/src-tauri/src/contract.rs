//! CLI 実行基盤の契約（specs/initiatives/niho-docs.md §6.1）のアプリ側の形。
//!
//! 本番の実装は `local_ai.rs`（S1-B の crate `niho-local-ai` の adapter）。crate の型（camelCase の JSON・`TimedOut` など）は
//! adapter がここの型に写し、Web へは `{ turnId, seq, event }` の `event` に `to_wire()` の JSON を入れて流す
//! （名前は契約のまま: `{"type":"Done","stop_reason":"MaxTokens",…}`）。イベントの schema の正は packages/docs-core の turn.ts
//! （schemaVersion 1）で、共有の fixture `apps/docs/fixtures/turn-events/` を Rust のテスト（local_ai_tests.rs）も読む。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// 提供元。サブスクリプション方式は CLI（`GeminiCli` は Antigravity CLI）、API キー方式は各社の API（S2b #18383。
/// docs-core の `ContractProvider` と同じ名前）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Provider {
  ClaudeCode,
  CodexCli,
  GeminiCli,
  /// Anthropic の Messages API。
  AnthropicApi,
  /// OpenAI の Responses API。
  OpenAiApi,
  /// Google の Gemini API（generateContent）。
  GeminiApi,
}

impl Provider {
  /// API キー方式の提供元か。
  pub fn is_api(self) -> bool {
    matches!(self, Provider::AnthropicApi | Provider::OpenAiApi | Provider::GeminiApi)
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Effort {
  Low,
  Medium,
  High,
  Max,
}

/// ツールの方針（crate の `ToolPolicy` の写し）。工程の実行はツール無し。修正の会話（S5 #18386）は隔離 workspace を
/// 作業フォルダにして、その中だけを読み、`writable`（例 artifacts）の下だけに書ける。音声の区切りの文字起こし
/// （S2a #18383。Gemini のサブスクリプション＝Antigravity CLI）は、区切りの WAV を 1 つ読むだけ（`ReadFile`）。
/// API キー方式の Gemini（`GeminiApi`）の `ReadFile` は、その WAV を Files API に上げて依頼に添える（S2b）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum ToolPolicy {
  #[default]
  None,
  ProjectFolder {
    dir: PathBuf,
    writable: Vec<String>,
    /// Web の検索を許すか（#283。Claude Code・Codex・Antigravity の CLI だけ。API の経路は見ない）。false なら CLI へ
    /// 検索の道具を渡さず、最初に `TurnEvent::Notice`（`webSearchOff`）で知らせて検索なしで続ける。
    web_search: bool,
  },
  ReadFile {
    file: PathBuf,
  },
}

#[derive(Clone, Debug)]
pub struct TurnRequest {
  pub provider: Provider,
  pub model: String,
  pub effort: Option<Effort>,
  pub system_prompt: String,
  pub user_prompt: String,
  /// 「続き」は同じ会話で（provider 固有の opaque な session ref）。
  pub resume_session: Option<String>,
  pub workdir: PathBuf,
  pub timeout: Duration,
  pub max_budget_usd: Option<f64>,
  pub tool_policy: ToolPolicy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum StopReason {
  EndTurn,
  MaxTokens,
  Stopped,
}

/// 使用量。`model_used` は実際に使ったモデル（CLI が返さなければ依頼したモデル名）、`cost_known` は費用が確かな値か
/// （`cost_usd` が無ければ false。サブスクリプションは固定費の保証ではないので費用を推測しない）。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Usage {
  pub input_tokens: u64,
  pub output_tokens: u64,
  pub cost_usd: Option<f64>,
  pub model_used: Option<String>,
  pub cost_known: bool,
}

/// 失敗の理由（Desktop の `RUNTIME_*` と同じ意味）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReasonCode {
  CliLoginRequired,
  UsageLimitReached,
  NotConfigured,
  Unreachable,
  SessionNotFound,
  /// 時間の上限で止めた。
  Timeout,
  /// CLI の出力（stream-json）を読み取れなかった（crate は使わない。壊れた出力は TransientFailure になる）。
  InvalidStream,
  /// CLI に必要なフラグが無い（crate は使わない。古い CLI は provider_status の `missing_cli_flags` で分かる）。
  CliVersionMismatch,
  TransientFailure,
  /// 設定のモデルをこの CLI で使えない。
  ModelNotFound,
}

/// `ModelNotFound` の画面の文言（docs-core の reasonMessage と同じ）。CLI ごとの文より、直す場所（設定のモデル）を先に言う。
pub const MODEL_NOT_FOUND_MESSAGE: &str =
  "設定のモデルが使えません。設定でモデルを確かめてから、もう一度実行してください。";

#[derive(Clone, Debug, PartialEq)]
pub enum TurnEvent {
  ThinkingDelta(String),
  TextDelta(String),
  /// ツールを呼んだ（修正の会話だけ）。`summary` は対象のファイル名だけ（本文・フォルダのパスは来ない）。
  ToolUse {
    id: String,
    name: String,
    summary: String,
  },
  /// ツールが終わった（成否だけ）。`id` で ToolUse と組にする。
  ToolResult {
    id: String,
    name: String,
    ok: bool,
  },
  /// 知らせ（Web の検索を切った・この CLI の版では検索できない。#283）。検索なしで続ける。`code` は
  /// "webSearchOff" | "webSearchUnsupported"、`message` は画面に出す文。終端ではない。
  Notice {
    code: String,
    message: String,
  },
  Done {
    text: String,
    stop_reason: StopReason,
    session_id: Option<String>,
    usage: Usage,
    duration_ms: u64,
    /// CLI（Claude Code）が出力の上限で止まり、同じ実行の中で自分で頼んだ続きの回数。画面はアプリの続きの回数に足す。
    continuations: u32,
  },
  Error {
    reason_code: ReasonCode,
    message: String,
  },
}

impl TurnEvent {
  pub fn is_terminal(&self) -> bool {
    matches!(self, TurnEvent::Done { .. } | TurnEvent::Error { .. })
  }

  /// Web へ流す形（`type` は契約の名前、フィールドは契約の名前のまま）。
  pub fn to_wire(&self) -> Value {
    match self {
      TurnEvent::ThinkingDelta(text) => json!({ "type": "ThinkingDelta", "text": text }),
      TurnEvent::TextDelta(text) => json!({ "type": "TextDelta", "text": text }),
      TurnEvent::ToolUse { id, name, summary } => {
        json!({ "type": "ToolUse", "id": id, "name": name, "summary": summary })
      }
      TurnEvent::ToolResult { id, name, ok } => json!({ "type": "ToolResult", "id": id, "name": name, "ok": ok }),
      TurnEvent::Notice { code, message } => json!({ "type": "Notice", "code": code, "message": message }),
      TurnEvent::Done {
        text,
        stop_reason,
        session_id,
        usage,
        duration_ms,
        continuations,
      } => json!({
        "type": "Done",
        "text": text,
        "stop_reason": stop_reason,
        "session_id": session_id,
        "usage": usage,
        "duration_ms": duration_ms,
        "continuations": continuations,
      }),
      TurnEvent::Error { reason_code, message } => json!({
        "type": "Error",
        "reason_code": reason_code,
        "message": message,
      }),
    }
  }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ProviderCapabilities {
  /// 同じ会話で続きを頼めるか。
  pub resume: bool,
  /// 思考量を指定できるか。
  pub effort: bool,
  /// ツールを切れることがテストで確かめられているか（Gemini CLI は S1-B が証明するまで出さない）。
  pub tools_off_proven: bool,
  /// トークン数を返すか。
  pub usage: bool,
  /// 費用を確かな値で返すか（サブスクリプションは false）。
  pub cost: bool,
}

/// このMacの CLI の状態（crate の `ProviderStatus` の写し。設定の行に出す）。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ProviderStatus {
  pub installed: bool,
  pub authenticated: bool,
  pub version: Option<String>,
  pub cli_path: Option<String>,
  /// ログインの方法（例 "Claude Max account"）。
  pub login_method: Option<String>,
  /// 使えないとき: "cli_not_found" | "cli_version_failed" | "cli_flags_missing" | "auth_required" | "auth_probe_failed"。
  pub reason: Option<String>,
  /// `--help` に無かった必要なフラグ（古い CLI）。
  pub missing_cli_flags: Vec<String>,
  pub capabilities: ProviderCapabilities,
  /// この CLI で使えるモデルの ID（codex はログイン後の `codex debug models` の一覧、agy は `agy models`。claude は空）。
  /// 設定のモデルの選択肢に使う（空なら画面の控えの一覧）。
  pub models: Vec<String>,
}

/// 提供元が返す使用量の残りの枠（agy の `/usage`。crate の `UsageWindow` の写し）。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct UsageWindow {
  /// 群の名前（例 "Gemini Models"）。
  pub group: String,
  /// 枠の名前（例 "Weekly Limit Remaining"）。
  pub name: String,
  /// 期間（例 "weekly"）。
  pub window: Option<String>,
  /// 残りの割合（0〜1）。
  pub remaining_fraction: Option<f64>,
  /// 次に満たされる時刻（ISO 8601）。
  pub reset_time: Option<String>,
}

/// 使用量の残り（provider が返せる分だけ。返せないときは Err で、画面は「取得できません」）。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProviderUsage {
  pub windows: Vec<UsageWindow>,
}

/// Claude Code の更新の結果。`status` は更新後に確かめ直した状態。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ClaudeUpdate {
  pub before_version: Option<String>,
  pub after_version: Option<String>,
  pub status: ProviderStatus,
}

/// ログイン・導入・更新の失敗（`message` は画面に出せる日本語）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MaintenanceError {
  pub code: String,
  pub message: String,
}

impl MaintenanceError {
  pub fn new(code: &str, message: &str) -> Self {
    Self {
      code: code.to_string(),
      message: message.to_string(),
    }
  }
}

/// 実行中の 1 回の依頼。`stop()` で止める（止めたら `Done { stop_reason: Stopped }` が最後に 1 回だけ流れる）。
pub trait TurnHandle: Send + Sync {
  fn stop(&self);
}

/// イベントの受け口。最後のイベントは必ず `Done` か `Error` の 1 つ。
pub type EventSink = Box<dyn FnMut(TurnEvent) + Send>;

/// CLI 実行基盤（S1-B の crate）の呼び口。`run_turn` はすぐに戻り、イベントは別のスレッドから届く。
/// ログイン・導入・更新は終わるまで戻らない（呼ぶ側が blocking のスレッドで呼ぶ）。
pub trait LlmRunner: Send + Sync {
  fn run_turn(&self, request: TurnRequest, on_event: EventSink) -> Arc<dyn TurnHandle>;
  fn provider_status(&self, provider: Provider) -> ProviderStatus;
  /// 公式のログインを始め（ブラウザで本人がログインする）、終わったら状態を確かめ直して返す。
  fn start_auth(&self, provider: Provider) -> Result<ProviderStatus, MaintenanceError>;
  /// Claude Code を公式のインストーラで入れる（入っていれば何もしない）。
  fn install_claude(&self) -> Result<ProviderStatus, MaintenanceError>;
  /// Claude Code を最新にして、必要なフラグがそろっているかを確かめ直す。
  fn update_claude(&self) -> Result<ClaudeUpdate, MaintenanceError>;
  /// 実行中の工程があるか（ログイン・導入・更新の前に確かめる）。
  fn has_running_turns(&self) -> bool;
  /// 使用量の残り（Antigravity CLI の `/usage` だけ。ほかは `usage_unsupported`）。終わるまで戻らない。
  fn provider_usage(&self, provider: Provider) -> Result<ProviderUsage, MaintenanceError>;
  /// アプリ終了時に、実行中の工程とログイン待ちを止める。
  fn shutdown(&self);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn wire_format_keeps_contract_names() {
    let done = TurnEvent::Done {
      text: "本文".into(),
      stop_reason: StopReason::MaxTokens,
      session_id: Some("s".into()),
      usage: Usage {
        input_tokens: 10,
        output_tokens: 20,
        cost_usd: None,
        model_used: Some("claude-sonnet".into()),
        cost_known: false,
      },
      duration_ms: 5,
      continuations: 2,
    };
    assert_eq!(
      done.to_wire(),
      json!({
        "type": "Done",
        "text": "本文",
        "stop_reason": "MaxTokens",
        "session_id": "s",
        "usage": { "input_tokens": 10, "output_tokens": 20, "cost_usd": null, "model_used": "claude-sonnet", "cost_known": false },
        "duration_ms": 5,
        "continuations": 2,
      })
    );
    assert_eq!(
      TurnEvent::Error {
        reason_code: ReasonCode::CliLoginRequired,
        message: "m".into()
      }
      .to_wire(),
      json!({ "type": "Error", "reason_code": "CliLoginRequired", "message": "m" })
    );
    assert_eq!(
      TurnEvent::TextDelta("a".into()).to_wire(),
      json!({ "type": "TextDelta", "text": "a" })
    );
    assert_eq!(
      TurnEvent::ToolUse {
        id: "toolu_1".into(),
        name: "Edit".into(),
        summary: "abc12345.md".into()
      }
      .to_wire(),
      json!({ "type": "ToolUse", "id": "toolu_1", "name": "Edit", "summary": "abc12345.md" })
    );
    assert_eq!(
      TurnEvent::ToolResult {
        id: "toolu_1".into(),
        name: "Edit".into(),
        ok: true
      }
      .to_wire(),
      json!({ "type": "ToolResult", "id": "toolu_1", "name": "Edit", "ok": true })
    );
    assert!(!TurnEvent::ToolResult {
      id: String::new(),
      name: String::new(),
      ok: false
    }
    .is_terminal());
    // 知らせ（Web の検索を切った。#283）は終端ではなく、契約の名前のまま流れる
    let notice = TurnEvent::Notice {
      code: "webSearchOff".into(),
      message: "検索は切っています。".into(),
    };
    assert_eq!(
      notice.to_wire(),
      json!({ "type": "Notice", "code": "webSearchOff", "message": "検索は切っています。" })
    );
    assert!(!notice.is_terminal());
    assert_eq!(
      serde_json::to_value(ReasonCode::ModelNotFound).unwrap(),
      json!("ModelNotFound")
    );
    for (provider, name) in [
      (Provider::AnthropicApi, "AnthropicApi"),
      (Provider::OpenAiApi, "OpenAiApi"),
      (Provider::GeminiApi, "GeminiApi"),
    ] {
      assert_eq!(serde_json::to_value(provider).unwrap(), json!(name));
      assert!(provider.is_api());
    }
    assert!(!Provider::GeminiCli.is_api());
    assert!(done.is_terminal());
    assert!(!TurnEvent::ThinkingDelta("x".into()).is_terminal());
  }

  #[test]
  fn provider_status_uses_snake_case_names() {
    let status = ProviderStatus {
      installed: true,
      authenticated: true,
      version: Some("2.1.267 (Claude Code)".into()),
      cli_path: Some("/opt/homebrew/bin/claude".into()),
      login_method: Some("Claude Max account".into()),
      reason: None,
      missing_cli_flags: vec![],
      capabilities: ProviderCapabilities {
        resume: true,
        effort: true,
        tools_off_proven: true,
        usage: true,
        cost: false,
      },
      models: vec![],
    };
    assert_eq!(
      serde_json::to_value(&status).unwrap(),
      json!({
        "installed": true,
        "authenticated": true,
        "version": "2.1.267 (Claude Code)",
        "cli_path": "/opt/homebrew/bin/claude",
        "login_method": "Claude Max account",
        "reason": null,
        "missing_cli_flags": [],
        "capabilities": { "resume": true, "effort": true, "tools_off_proven": true, "usage": true, "cost": false },
        "models": [],
      })
    );
    let usage = ProviderUsage {
      windows: vec![UsageWindow {
        group: "Gemini Models".into(),
        name: "Weekly Limit Remaining".into(),
        window: Some("weekly".into()),
        remaining_fraction: Some(0.59),
        reset_time: Some("2026-10-21T19:12:26Z".into()),
      }],
    };
    assert_eq!(
      serde_json::to_value(&usage).unwrap(),
      json!({ "windows": [{ "group": "Gemini Models", "name": "Weekly Limit Remaining", "window": "weekly", "remaining_fraction": 0.59, "reset_time": "2026-10-21T19:12:26Z" }] })
    );
    let update = ClaudeUpdate {
      before_version: Some("2.1.267".into()),
      after_version: Some("2.1.300".into()),
      status: ProviderStatus::default(),
    };
    let value = serde_json::to_value(&update).unwrap();
    assert_eq!(value["before_version"], json!("2.1.267"));
    assert_eq!(value["after_version"], json!("2.1.300"));
    assert_eq!(value["status"]["installed"], json!(false));
  }
}
