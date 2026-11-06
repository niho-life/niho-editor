//! 公開する型。S1-A（Tauri 側）がこの形で受け渡すので、JSON は camelCase に揃える。

use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

/// 使う AI の CLI。JSON は "claudeCode" | "codexCli" | "geminiCli"。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
  ClaudeCode,
  CodexCli,
  /// Gemini をこの Mac のサブスクリプションで動かす CLI。2026-06-18 に gemini CLI が個人向けの契約を終えたので、
  /// 後継の Antigravity CLI（agy）を使う（名前と JSON の "geminiCli" は S1-A との受け渡しのため変えない）。
  GeminiCli,
}

impl Provider {
  pub const ALL: [Provider; 3] = [Provider::ClaudeCode, Provider::CodexCli, Provider::GeminiCli];

  /// 画面と Error の文に出す名前。
  pub fn label(self) -> &'static str {
    match self {
      Provider::ClaudeCode => "Claude Code",
      Provider::CodexCli => "Codex CLI",
      Provider::GeminiCli => "Antigravity CLI",
    }
  }

  /// 実行ファイルの名前（CLI を探すときに使う）。
  pub fn cli_name(self) -> &'static str {
    match self {
      Provider::ClaudeCode => "claude",
      Provider::CodexCli => "codex",
      Provider::GeminiCli => "agy",
    }
  }

  /// この CLI でできること。`max_tokens_stop` は「出力の上限で止まったことを `StopReason::MaxTokens` で返せるか」。
  /// codex は上限で止まると失敗（Incomplete response returned）になり、agy は止まり方を返さない。
  pub fn capabilities(self) -> Capabilities {
    match self {
      Provider::ClaudeCode => Capabilities {
        resume: true,
        effort: true,
        max_tokens_stop: true,
      },
      Provider::CodexCli | Provider::GeminiCli => Capabilities {
        resume: true,
        effort: true,
        max_tokens_stop: false,
      },
    }
  }

  /// ログに書く名前（JSON と同じ）。
  pub(crate) fn wire_name(self) -> &'static str {
    match self {
      Provider::ClaudeCode => "claudeCode",
      Provider::CodexCli => "codexCli",
      Provider::GeminiCli => "geminiCli",
    }
  }
}

/// 考える量。JSON は "low" | "medium" | "high" | "max"。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
  Low,
  Medium,
  High,
  Max,
}

impl Effort {
  pub fn as_str(self) -> &'static str {
    match self {
      Effort::Low => "low",
      Effort::Medium => "medium",
      Effort::High => "high",
      Effort::Max => "max",
    }
  }
}

/// ツールの方針。工程の実行はツール無し（既定）。修正の会話（S5 #18386）は、呼び出し側が渡した作業フォルダ内だけを
/// 読み書きできる（シェル・MCP は使えない。Web の検索・取得は `TurnRequest.web_search` のときだけ。#283）。Codex は `writable` がちょうど 1 つのとき、その場所だけを cwd にする。
/// 音声の区切りの文字起こし（S2a #18383）は、渡した 1 つのファイルを読むだけ（Antigravity CLI だけ）。
/// JSON は `{"kind":"none"}` | `{"kind":"projectFolder","dir":"/abs/path","writable":["artifacts"]}` |
/// `{"kind":"readFile","file":"/abs/part-01.wav"}`。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ToolPolicy {
  /// ツールを全部切る（`workdir` で動く。これまでどおり）
  #[default]
  None,
  /// `dir`（絶対パスの、リンクでないフォルダ）を基準に読む。書けるのは `writable`
  /// （`dir` の中の相対フォルダ。例 `["artifacts"]`）の下だけで、空なら `dir` の中ならどこでも書ける。
  /// claude は Read・Edit・Write・Glob・Grep だけ、codex は workspace-write の sandbox の apply_patch だけ（書き込み先が 1 つ必要）。
  /// Antigravity CLI（GeminiCli）は `dir` を cwd にし、view_file・list_dir・write_to_file・replace_file_content・
  /// multi_replace_file_content だけを持つエージェント（`dir/.agents/` に置き、終わったら消す）で動かす。書けるのは `writable`
  /// の下の `.md` だけ（書き込み先が 1 つ以上必要。`dir` に `.agents`・`AGENTS.md`・`GEMINI.md` があれば起動しない）。
  ProjectFolder {
    dir: PathBuf,
    #[serde(default)]
    writable: Vec<String>,
  },
  /// `file`（絶対パスの、リンクでない普通のファイル。名前は英数字と `._-`）をその回だけの作業フォルダに写し、
  /// `view_file` だけを持つエージェントに読ませる。Antigravity CLI（GeminiCli）だけで、続き（`resume_session`）は受けない。
  /// 指示文では作業フォルダの中のファイル名（`file` の名前と同じ）で指す
  ReadFile { file: PathBuf },
}

impl ToolPolicy {
  pub fn is_project_folder(&self) -> bool {
    matches!(self, ToolPolicy::ProjectFolder { .. })
  }
}

/// 1 回の実行（工程の 1 往復）の依頼。JSON では `timeout` を "timeoutMs"（ミリ秒の整数）で受ける。
#[derive(Clone, Debug, Deserialize)]
#[serde(from = "TurnRequestWire")]
pub struct TurnRequest {
  pub provider: Provider,
  pub model: String,
  pub effort: Option<Effort>,
  pub system_prompt: String,
  pub user_prompt: String,
  /// 「続き」は同じ会話で。None なら新しい会話
  pub resume_session: Option<String>,
  /// 子プロセスの cwd。会話を続ける間は同じにする（呼び出し側の約束。claude・codex は会話を cwd ごとに保存する）。
  /// agy は作業フォルダの中を自動で読み書きできるので、ここではなくその回だけの空のフォルダ（修正の会話は `dir`）で動かす
  /// （存在の検査は同じ）
  pub workdir: PathBuf,
  /// 1 回の実行の上限（壁時計）
  pub timeout: Duration,
  /// claude だけ（--max-budget-usd）。ほかは無視
  pub max_budget_usd: Option<f64>,
  /// ツールの方針（既定はツール無し）。`ProjectFolder` のとき claude・agy は `dir`、codex は唯一の `writable` root で動く
  pub tool_policy: ToolPolicy,
  /// 修正の会話（`ProjectFolder`）で Web の検索・取得の道具を許すか（JSON `webSearch`。既定 true。#283）。false なら
  /// 3 つの CLI とも Web の道具を許可に入れず、最初に `Notice { code: WebSearchOff }` を送る。ほかの方針では使わない
  /// （工程・文字起こしは今まで通り Web 無し）。コマンド実行（Bash・shell）はどちらでも許さない
  pub web_search: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnRequestWire {
  provider: Provider,
  model: String,
  #[serde(default)]
  effort: Option<Effort>,
  system_prompt: String,
  user_prompt: String,
  #[serde(default)]
  resume_session: Option<String>,
  workdir: PathBuf,
  timeout_ms: u64,
  #[serde(default)]
  max_budget_usd: Option<f64>,
  #[serde(default)]
  tool_policy: ToolPolicy,
  #[serde(default = "default_web_search")]
  web_search: bool,
}

fn default_web_search() -> bool {
  true
}

impl From<TurnRequestWire> for TurnRequest {
  fn from(wire: TurnRequestWire) -> Self {
    Self {
      provider: wire.provider,
      model: wire.model,
      effort: wire.effort,
      system_prompt: wire.system_prompt,
      user_prompt: wire.user_prompt,
      resume_session: wire.resume_session,
      workdir: wire.workdir,
      timeout: Duration::from_millis(wire.timeout_ms),
      max_budget_usd: wire.max_budget_usd,
      tool_policy: wire.tool_policy,
      web_search: wire.web_search,
    }
  }
}

/// 終わり方。JSON は "endTurn" | "maxTokens" | "stopped"。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
  EndTurn,
  MaxTokens,
  Stopped,
}

/// 使った量。`cost_usd` は CLI が費用を返すとき（claude）だけ。
/// `model_used` は実際に答えたモデルの ID（設定の別名 `sonnet` などで頼んでも実モデルの ID が入る）。claude は
/// stream の `message_start`（無ければ init）、agy は init から取る。codex の JSON にはモデル名が無いので `None`
/// （呼ぶ側は頼んだモデル名を使う）。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
  pub input_tokens: u64,
  pub output_tokens: u64,
  pub cost_usd: Option<f64>,
  #[serde(default)]
  pub model_used: Option<String>,
}

/// `on_event` に渡すイベント。delta は表示用で、本文の正は最後の `Done.text`。
/// 1 回の実行の最後に `Done` か `Error` がちょうど 1 回届き、その後は何も届かない。
/// `ToolUse`・`ToolResult` は `ToolPolicy::ProjectFolder` のときだけ届く（CLI に隔離 workspace を渡す）。
/// ツール無しの実行でツールの気配があれば止める。
/// `ProjectFolder` のときの `Done.text` は返答（最後のツールの呼び出しより後の文）で、それより前の文（実況）は
/// `TextDelta` にだけ流れる。
#[derive(Clone, Debug, PartialEq)]
pub enum TurnEvent {
  ThinkingDelta(String),
  TextDelta(String),
  /// ツールを呼んだ。`id` は CLI の呼び出しの ID（`ToolResult` と組にする）、`name` はツール名（claude は Read・Edit・
  /// Write・Glob・Grep、codex は変更の種類で Edit・Write・Delete、agy は道具を写して Read・Glob・Write・Edit）、`summary` は
  /// 対象のファイル名だけ（パスのフォルダ・本文・検索語は流さない。無ければ空）。Web を許した修正の会話では、3 つとも
  /// Web の道具を `WebSearch`（summary は空）・`WebFetch`（summary は読むページのホスト名だけ）で流す
  ToolUse {
    id: String,
    name: String,
    summary: String,
  },
  /// ツールが終わった（成否だけ。読んだ中身・エラーの文は流さない）
  ToolResult {
    id: String,
    name: String,
    ok: bool,
  },
  /// 実行は続くが、画面に一言知らせること（Web の検索を切った・この CLI の版では検索できない。#283）。
  /// 修正の会話（`ProjectFolder`）のときだけ、`Done`・`Error` より前に届く。本文・検索語は載せない
  Notice {
    code: NoticeCode,
  },
  Done {
    text: String,
    stop_reason: StopReason,
    session_id: Option<String>,
    usage: Usage,
    duration_ms: u64,
    /// CLI が出力の上限（max_tokens）で止まり、同じ実行の中で自分で続きを頼んだ回数
    continuations: u32,
  },
  Error {
    reason_code: ReasonCode,
    message: String,
  },
}

/// `TurnEvent::Notice` の種類。JSON は "webSearchOff" | "webSearchUnsupported"。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoticeCode {
  /// 呼び出し側が Web の検索を切った（`TurnRequest.web_search == false`）。検索なしで続ける
  WebSearchOff,
  /// この CLI の版（またはログインの種類）では Web の道具が使えない。検索なしで続ける
  WebSearchUnsupported,
}

impl NoticeCode {
  /// 画面に出す文。
  pub fn message(self) -> &'static str {
    match self {
      NoticeCode::WebSearchOff => "検索は切っています。",
      NoticeCode::WebSearchUnsupported => "この CLI の版では検索できません。",
    }
  }
}

impl TurnEvent {
  /// `Done` か `Error`（最後のイベント）か。
  pub fn is_terminal(&self) -> bool {
    matches!(self, TurnEvent::Done { .. } | TurnEvent::Error { .. })
  }
}

// タプル variant を {"type": …} の形にするため手で書く。
impl Serialize for TurnEvent {
  fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
    match self {
      TurnEvent::ThinkingDelta(text) => {
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("type", "thinkingDelta")?;
        map.serialize_entry("text", text)?;
        map.end()
      }
      TurnEvent::TextDelta(text) => {
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("type", "textDelta")?;
        map.serialize_entry("text", text)?;
        map.end()
      }
      TurnEvent::ToolUse { id, name, summary } => {
        let mut map = serializer.serialize_map(Some(4))?;
        map.serialize_entry("type", "toolUse")?;
        map.serialize_entry("id", id)?;
        map.serialize_entry("name", name)?;
        map.serialize_entry("summary", summary)?;
        map.end()
      }
      TurnEvent::ToolResult { id, name, ok } => {
        let mut map = serializer.serialize_map(Some(4))?;
        map.serialize_entry("type", "toolResult")?;
        map.serialize_entry("id", id)?;
        map.serialize_entry("name", name)?;
        map.serialize_entry("ok", ok)?;
        map.end()
      }
      TurnEvent::Notice { code } => {
        let mut map = serializer.serialize_map(Some(3))?;
        map.serialize_entry("type", "notice")?;
        map.serialize_entry("code", code)?;
        map.serialize_entry("message", code.message())?;
        map.end()
      }
      TurnEvent::Done {
        text,
        stop_reason,
        session_id,
        usage,
        duration_ms,
        continuations,
      } => {
        let mut map = serializer.serialize_map(Some(7))?;
        map.serialize_entry("type", "done")?;
        map.serialize_entry("text", text)?;
        map.serialize_entry("stopReason", stop_reason)?;
        map.serialize_entry("sessionId", session_id)?;
        map.serialize_entry("usage", usage)?;
        map.serialize_entry("durationMs", duration_ms)?;
        map.serialize_entry("continuations", continuations)?;
        map.end()
      }
      TurnEvent::Error { reason_code, message } => {
        let mut map = serializer.serialize_map(Some(3))?;
        map.serialize_entry("type", "error")?;
        map.serialize_entry("reasonCode", reason_code)?;
        map.serialize_entry("message", message)?;
        map.end()
      }
    }
  }
}

/// 失敗の理由。文字列は Desktop の記事エージェント・API の reasonCode と揃える。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ReasonCode {
  CliLoginRequired,
  UsageLimitReached,
  /// CLI が無い・起動できない・この環境では安全に動かせない（ツールを切れない等）
  NotConfigured,
  /// 今は使わないが Desktop と揃えて残す
  Unreachable,
  SessionNotFound,
  TransientFailure,
  ModelNotFound,
  TimedOut,
}

impl ReasonCode {
  pub const ALL: [ReasonCode; 8] = [
    ReasonCode::CliLoginRequired,
    ReasonCode::UsageLimitReached,
    ReasonCode::NotConfigured,
    ReasonCode::Unreachable,
    ReasonCode::SessionNotFound,
    ReasonCode::TransientFailure,
    ReasonCode::ModelNotFound,
    ReasonCode::TimedOut,
  ];

  pub fn as_str(&self) -> &'static str {
    match self {
      ReasonCode::CliLoginRequired => "RUNTIME_CLI_LOGIN_REQUIRED",
      ReasonCode::UsageLimitReached => "RUNTIME_USAGE_LIMIT_REACHED",
      ReasonCode::NotConfigured => "RUNTIME_NOT_CONFIGURED",
      ReasonCode::Unreachable => "RUNTIME_UNREACHABLE",
      ReasonCode::SessionNotFound => "RUNTIME_SESSION_NOT_FOUND",
      ReasonCode::TransientFailure => "RUNTIME_TRANSIENT_FAILURE",
      ReasonCode::ModelNotFound => "RUNTIME_MODEL_NOT_FOUND",
      ReasonCode::TimedOut => "RUNTIME_TIMED_OUT",
    }
  }

  pub fn parse(value: &str) -> Option<Self> {
    Self::ALL.into_iter().find(|code| code.as_str() == value)
  }
}

impl fmt::Display for ReasonCode {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str(self.as_str())
  }
}

impl Serialize for ReasonCode {
  fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(self.as_str())
  }
}

impl<'de> Deserialize<'de> for ReasonCode {
  fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
    let value = String::deserialize(deserializer)?;
    ReasonCode::parse(&value).ok_or_else(|| serde::de::Error::custom(format!("unknown reason code: {value}")))
  }
}

/// この CLI でできること（画面の選択肢を出し分けるのに使う）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
  pub resume: bool,
  pub effort: bool,
  pub max_tokens_stop: bool,
}

/// このMacの CLI の状態（入っているか・ログインしているか・必要なフラグがあるか）。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
  pub provider: Provider,
  pub installed: bool,
  pub authenticated: bool,
  pub version: Option<String>,
  pub cli_path: Option<String>,
  /// 例 "Claude Max account" / "ChatGPT"（agy は返さない）
  pub login_method: Option<String>,
  /// 使えないとき: "cli_not_found" | "cli_version_failed" | "cli_flags_missing" | "auth_required" | "auth_probe_failed"
  pub reason: Option<String>,
  pub missing_cli_flags: Vec<String>,
  pub capabilities: Capabilities,
  /// この CLI で使えるモデルの ID。agy は `agy models` の 1 列目（ログインの確認を兼ねる）、codex はログイン後の
  /// `codex debug models` の一覧に出るもの（アカウントで違う）。claude は空（`--model` は別名を受ける）
  pub models: Vec<String>,
}

/// ログイン・更新・インストールの失敗。`message` は画面に出せる日本語、`details` は CLI の出力の末尾など。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAiError {
  pub code: String,
  pub message: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub details: Option<String>,
}

impl LocalAiError {
  pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
    Self {
      code: code.to_string(),
      message: message.into(),
      details: None,
    }
  }

  pub(crate) fn with_details(mut self, details: Option<String>) -> Self {
    self.details = details.filter(|value| !value.trim().is_empty());
    self
  }
}

impl fmt::Display for LocalAiError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "{} ({})", self.message, self.code)
  }
}

impl std::error::Error for LocalAiError {}

/// `update_claude` の結果。`status` は更新後に確かめ直した状態。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUpdateResult {
  pub before_version: Option<String>,
  pub after_version: Option<String>,
  pub status: ProviderStatus,
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn turn_event_json_has_the_four_shapes() {
    assert_eq!(
      serde_json::to_value(TurnEvent::ThinkingDelta("考え中".into())).unwrap(),
      json!({"type":"thinkingDelta","text":"考え中"})
    );
    assert_eq!(
      serde_json::to_value(TurnEvent::TextDelta("本文".into())).unwrap(),
      json!({"type":"textDelta","text":"本文"})
    );
    let done = TurnEvent::Done {
      text: "おわり".into(),
      stop_reason: StopReason::EndTurn,
      session_id: Some("11111111-2222-4333-8444-555555555555".into()),
      usage: Usage {
        input_tokens: 1,
        output_tokens: 2,
        cost_usd: Some(0.1),
        model_used: Some("claude-sonnet-5".into()),
      },
      duration_ms: 5,
      continuations: 0,
    };
    assert_eq!(
      serde_json::to_value(&done).unwrap(),
      json!({
        "type":"done","text":"おわり","stopReason":"endTurn","sessionId":"11111111-2222-4333-8444-555555555555",
        "usage":{"inputTokens":1,"outputTokens":2,"costUsd":0.1,"modelUsed":"claude-sonnet-5"},"durationMs":5,"continuations":0
      })
    );
    let stopped = TurnEvent::Done {
      text: String::new(),
      stop_reason: StopReason::MaxTokens,
      session_id: None,
      usage: Usage::default(),
      duration_ms: 0,
      continuations: 3,
    };
    assert_eq!(
      serde_json::to_value(&stopped).unwrap(),
      json!({
        "type":"done","text":"","stopReason":"maxTokens","sessionId":null,
        "usage":{"inputTokens":0,"outputTokens":0,"costUsd":null,"modelUsed":null},"durationMs":0,"continuations":3
      })
    );
    assert_eq!(
      serde_json::to_value(TurnEvent::Error {
        reason_code: ReasonCode::CliLoginRequired,
        message: "ログイン".into()
      })
      .unwrap(),
      json!({"type":"error","reasonCode":"RUNTIME_CLI_LOGIN_REQUIRED","message":"ログイン"})
    );
    assert_eq!(serde_json::to_value(StopReason::Stopped).unwrap(), json!("stopped"));
  }

  #[test]
  fn reason_codes_round_trip_as_runtime_strings() {
    let expected = [
      (ReasonCode::CliLoginRequired, "RUNTIME_CLI_LOGIN_REQUIRED"),
      (ReasonCode::UsageLimitReached, "RUNTIME_USAGE_LIMIT_REACHED"),
      (ReasonCode::NotConfigured, "RUNTIME_NOT_CONFIGURED"),
      (ReasonCode::Unreachable, "RUNTIME_UNREACHABLE"),
      (ReasonCode::SessionNotFound, "RUNTIME_SESSION_NOT_FOUND"),
      (ReasonCode::TransientFailure, "RUNTIME_TRANSIENT_FAILURE"),
      (ReasonCode::ModelNotFound, "RUNTIME_MODEL_NOT_FOUND"),
      (ReasonCode::TimedOut, "RUNTIME_TIMED_OUT"),
    ];
    for (code, text) in expected {
      assert_eq!(code.as_str(), text);
      assert_eq!(serde_json::to_value(code).unwrap(), json!(text));
      assert_eq!(serde_json::from_value::<ReasonCode>(json!(text)).unwrap(), code);
    }
    assert!(serde_json::from_value::<ReasonCode>(json!("RUNTIME_SOMETHING_ELSE")).is_err());
  }

  #[test]
  fn provider_and_effort_use_camel_case_names() {
    assert_eq!(serde_json::to_value(Provider::ClaudeCode).unwrap(), json!("claudeCode"));
    assert_eq!(serde_json::to_value(Provider::CodexCli).unwrap(), json!("codexCli"));
    assert_eq!(serde_json::to_value(Provider::GeminiCli).unwrap(), json!("geminiCli"));
    for provider in Provider::ALL {
      assert_eq!(serde_json::to_value(provider).unwrap(), json!(provider.wire_name()));
    }
    // GeminiCli の中身は Antigravity CLI（agy）
    assert_eq!(Provider::GeminiCli.label(), "Antigravity CLI");
    assert_eq!(Provider::GeminiCli.cli_name(), "agy");
    assert_eq!(serde_json::to_value(Effort::Max).unwrap(), json!("max"));
    assert_eq!(
      serde_json::from_value::<Effort>(json!("medium")).unwrap(),
      Effort::Medium
    );
  }

  #[test]
  fn turn_request_deserializes_timeout_ms_and_optional_fields() {
    let request: TurnRequest = serde_json::from_value(json!({
      "provider": "codexCli",
      "model": "gpt-5.5",
      "effort": "high",
      "systemPrompt": "あなたは編集者です。",
      "userPrompt": "直して",
      "resumeSession": "11111111-2222-4333-8444-555555555555",
      "workdir": "/tmp/work",
      "timeoutMs": 1500,
      "maxBudgetUsd": 2.5
    }))
    .unwrap();
    assert_eq!(request.provider, Provider::CodexCli);
    assert_eq!(request.effort, Some(Effort::High));
    assert_eq!(request.timeout, Duration::from_millis(1500));
    assert_eq!(
      request.resume_session.as_deref(),
      Some("11111111-2222-4333-8444-555555555555")
    );
    assert_eq!(request.workdir, PathBuf::from("/tmp/work"));
    assert_eq!(request.max_budget_usd, Some(2.5));

    let minimal: TurnRequest = serde_json::from_value(json!({
      "provider": "claudeCode",
      "model": "claude-sonnet-5",
      "systemPrompt": "",
      "userPrompt": "書いて",
      "workdir": "/tmp/work",
      "timeoutMs": 60000
    }))
    .unwrap();
    assert_eq!(minimal.effort, None);
    assert_eq!(minimal.resume_session, None);
    assert_eq!(minimal.max_budget_usd, None);
    assert_eq!(minimal.timeout, Duration::from_secs(60));
    // ツールの方針の既定はツール無し
    assert_eq!(minimal.tool_policy, ToolPolicy::None);
    // Web の検索の既定は許す（#283。設定のスイッチが false を渡す）
    assert!(minimal.web_search);
    let off: TurnRequest = serde_json::from_value(json!({
      "provider": "claudeCode", "model": "m", "systemPrompt": "", "userPrompt": "x", "workdir": "/tmp",
      "timeoutMs": 5, "webSearch": false
    }))
    .unwrap();
    assert!(!off.web_search);

    // timeout は timeoutMs でだけ受ける
    assert!(serde_json::from_value::<TurnRequest>(json!({
      "provider": "claudeCode", "model": "m", "systemPrompt": "", "userPrompt": "x", "workdir": "/tmp", "timeout": 5
    }))
    .is_err());
  }

  #[test]
  fn tool_policy_and_tool_events_use_tagged_camel_case_json() {
    assert_eq!(serde_json::to_value(ToolPolicy::None).unwrap(), json!({"kind":"none"}));
    let folder = ToolPolicy::ProjectFolder {
      dir: PathBuf::from("/Users/me/Documents/NIHO docs/projects/p1"),
      writable: vec!["artifacts".into()],
    };
    let value = serde_json::to_value(&folder).unwrap();
    assert_eq!(
      value,
      json!({"kind":"projectFolder","dir":"/Users/me/Documents/NIHO docs/projects/p1","writable":["artifacts"]})
    );
    assert_eq!(serde_json::from_value::<ToolPolicy>(value).unwrap(), folder);
    // writable は省略できる（フォルダの中ならどこでも書ける）
    assert_eq!(
      serde_json::from_value::<ToolPolicy>(json!({"kind":"projectFolder","dir":"/tmp/p"})).unwrap(),
      ToolPolicy::ProjectFolder {
        dir: PathBuf::from("/tmp/p"),
        writable: Vec::new()
      }
    );
    assert!(folder.is_project_folder());
    assert!(!ToolPolicy::None.is_project_folder());
    let read = ToolPolicy::ReadFile {
      file: PathBuf::from("/tmp/parts/part-01.wav"),
    };
    let value = serde_json::to_value(&read).unwrap();
    assert_eq!(value, json!({"kind":"readFile","file":"/tmp/parts/part-01.wav"}));
    assert_eq!(serde_json::from_value::<ToolPolicy>(value).unwrap(), read);
    assert!(!read.is_project_folder());
    let request: TurnRequest = serde_json::from_value(json!({
      "provider": "claudeCode", "model": "sonnet", "systemPrompt": "", "userPrompt": "直して",
      "workdir": "/tmp/p", "timeoutMs": 1000, "toolPolicy": {"kind":"projectFolder","dir":"/tmp/p","writable":["artifacts"]}
    }))
    .unwrap();
    assert!(request.tool_policy.is_project_folder());

    assert_eq!(
      serde_json::to_value(TurnEvent::ToolUse {
        id: "toolu_1".into(),
        name: "Read".into(),
        summary: "abc12345.md".into()
      })
      .unwrap(),
      json!({"type":"toolUse","id":"toolu_1","name":"Read","summary":"abc12345.md"})
    );
    assert_eq!(
      serde_json::to_value(TurnEvent::ToolResult {
        id: "toolu_1".into(),
        name: "Read".into(),
        ok: false
      })
      .unwrap(),
      json!({"type":"toolResult","id":"toolu_1","name":"Read","ok":false})
    );
    assert!(!TurnEvent::ToolUse {
      id: String::new(),
      name: String::new(),
      summary: String::new()
    }
    .is_terminal());
  }

  #[test]
  fn notice_events_carry_only_the_code_and_the_fixed_message() {
    assert_eq!(
      serde_json::to_value(TurnEvent::Notice {
        code: NoticeCode::WebSearchOff
      })
      .unwrap(),
      json!({"type":"notice","code":"webSearchOff","message":"検索は切っています。"})
    );
    assert_eq!(
      serde_json::to_value(TurnEvent::Notice {
        code: NoticeCode::WebSearchUnsupported
      })
      .unwrap(),
      json!({"type":"notice","code":"webSearchUnsupported","message":"この CLI の版では検索できません。"})
    );
    assert!(!TurnEvent::Notice {
      code: NoticeCode::WebSearchOff
    }
    .is_terminal());
  }

  #[test]
  fn capabilities_follow_what_each_cli_can_report() {
    assert_eq!(
      Provider::ClaudeCode.capabilities(),
      Capabilities {
        resume: true,
        effort: true,
        max_tokens_stop: true
      }
    );
    assert_eq!(
      Provider::CodexCli.capabilities(),
      Capabilities {
        resume: true,
        effort: true,
        max_tokens_stop: false
      }
    );
    assert_eq!(
      Provider::GeminiCli.capabilities(),
      Capabilities {
        resume: true,
        effort: true,
        max_tokens_stop: false
      }
    );
    assert_eq!(
      serde_json::to_value(Provider::ClaudeCode.capabilities()).unwrap(),
      json!({"resume":true,"effort":true,"maxTokensStop":true})
    );
  }

  #[test]
  fn provider_status_json_lists_models() {
    let status = ProviderStatus {
      provider: Provider::GeminiCli,
      installed: true,
      authenticated: true,
      version: Some("1.3.5".into()),
      cli_path: None,
      login_method: None,
      reason: None,
      missing_cli_flags: Vec::new(),
      capabilities: Provider::GeminiCli.capabilities(),
      models: vec!["gemini-3.8-flash-low".into(), "claude-sonnet-4-6".into()],
    };
    let value = serde_json::to_value(&status).unwrap();
    assert_eq!(value["provider"], json!("geminiCli"));
    assert_eq!(value["models"], json!(["gemini-3.8-flash-low", "claude-sonnet-4-6"]));
    assert_eq!(value["missingCliFlags"], json!([]));
    assert_eq!(value["loginMethod"], json!(null));
  }

  #[test]
  fn local_ai_error_serializes_camel_case_and_displays_message() {
    let error = LocalAiError::new("auth_failed", "ログインできませんでした。").with_details(Some("exit code 7".into()));
    assert_eq!(
      serde_json::to_value(&error).unwrap(),
      json!({"code":"auth_failed","message":"ログインできませんでした。","details":"exit code 7"})
    );
    assert_eq!(error.to_string(), "ログインできませんでした。 (auth_failed)");
    let blank = LocalAiError::new("x", "y").with_details(Some("  ".into()));
    assert_eq!(serde_json::to_value(&blank).unwrap(), json!({"code":"x","message":"y"}));
  }
}
