//! CLI 実行基盤（S1-B の crate `niho-local-ai`・specs/initiatives/niho-docs.md §6.1）を `LlmRunner` に繋ぐ adapter。
//!
//! - `Runtime` を 1 つ持つ。一時ファイル（システムプロンプトの 0600 のファイルなど）の置き場は app data の下。CLI の場所は
//!   上書き（設定の `cliPaths`・環境変数）があるときだけ渡し、無ければ crate が探す（~/.local/bin → npm → Homebrew → ログインシェル）。
//!   診断ログは crate が指示文・本文を渡さないので、そのまま `<app_log_dir>/local-ai.log` に書く。
//! - 提供元: アプリの claude → Claude Code、gpt → Codex CLI、gemini → Antigravity CLI（agy。crate の `GeminiCli`。S2a #18383）。
//! - Codex CLI は app data の下の専用の `CODEX_HOME`（`codex-home/`）で動かす。利用者の ~/.codex/AGENTS.md は外す設定が無く
//!   工程の指示に混ざるため（#18383）。ログインもこのアプリ用になる（設定の行のログインで `codex login` をここに向ける）。
//! - 文字起こし（Gemini のサブスクリプション）: 区切りの WAV を crate の `ToolPolicy::ReadFile` で agy に読ませる（lib.rs の
//!   `transcribe_audio_part`）。使用量の残りは crate の `provider_usage`（agy の `/usage` だけ）。
//! - イベント: crate の ThinkingDelta / TextDelta / Done / Error を契約（contract.rs）の TurnEvent に写す。
//!   `Done.continuations` は Claude Code が同じ実行の中で自分で頼んだ続きの回数で、画面はこれをアプリの続きの回数に足す。
//! - 理由コード: crate の `TimedOut` → `Timeout`。`ModelNotFound` は画面の文言を「設定のモデルが使えません」にする。
//!   ほかは crate の文（提供元の名前と、ツールの気配で止めた・費用の上限など個別の理由が入る）をそのまま出す。
//! - 費用: このMacの CLI（サブスクリプション）の費用は請求の値ではない。Claude Code の `total_cost_usd` は API 料金に換算した
//!   見込みなので持ち出さない（spec §6.1「推測しない」）。費用が分かるのは提供元が請求の値を返したときだけ（`cost_known`）。
//! - `model_used`: crate が返した実際に答えたモデルの ID（Claude Code・Antigravity CLI。設定の別名 `sonnet` などで頼んでも
//!   実モデルの ID）。返さない CLI（Codex CLI）は依頼したモデル名を入れる。
//! - 本文: crate は Claude Code の `Done.text` の前後の空白を落とす。上限で止まった本文を続きと繋ぐと段落の区切り（"\n\n"）が
//!   消えるので、届いた本文の差分の前後の空白から戻す（crate がつなぐのは区間の境目だけで、先頭と末尾は差分と同じ）。
//!   修正の会話（ToolPolicy::ProjectFolder）の `Done.text` は返答（文書ではない）なので戻さない。
//! - ツール: 修正の会話だけ crate の `ToolPolicy::ProjectFolder` で隔離 workspace の中だけを読み書きさせ、`ToolUse`・`ToolResult`
//!   （ファイル名と成否）をそのまま写す。

use crate::contract::{
  ClaudeUpdate, EventSink, LlmRunner, MaintenanceError, Provider, ProviderCapabilities, ProviderStatus, ProviderUsage,
  ReasonCode, StopReason, ToolPolicy, TurnEvent, TurnHandle, TurnRequest, Usage, UsageWindow, MODEL_NOT_FOUND_MESSAGE,
};
use niho_local_ai as local;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// 開発・テストで Claude Code を差し替える環境変数（例: apps/docs/sidecar/fake/claude。`npm run dev:fake` が使う）。
pub const CLAUDE_PATH_ENV: &str = "NIHO_DOCS_CLAUDE_CLI_PATH";
/// 同じく Codex CLI。
pub const CODEX_PATH_ENV: &str = "NIHO_DOCS_CODEX_CLI_PATH";
/// 同じく Antigravity CLI（agy）。
pub const AGY_PATH_ENV: &str = "NIHO_DOCS_AGY_CLI_PATH";
/// Codex CLI の置き場（app data の下。`CODEX_HOME`）。
pub const CODEX_HOME_DIR: &str = "codex-home";
/// 診断ログの名前・大きさ（1 MB で回して 3 世代。NIHO Desktop の desktop-bridge.log と同じ）。
const LOG_FILE: &str = "local-ai.log";
const LOG_MAX_BYTES: u64 = 1_048_576;
const LOG_BACKUPS: usize = 3;

/// 本番の実装。`Runtime` を 1 つ持ち、crate の `*_with` を呼ぶ。
pub struct LocalAiRunner {
  runtime: local::Runtime,
}

impl LocalAiRunner {
  pub fn new(runtime: local::Runtime) -> Self {
    Self { runtime }
  }

  fn log(&self, kind: &str, payload: Value) {
    if let Some(log) = &self.runtime.log {
      log(kind, payload);
    }
  }

  fn maintenance_error(&self, action: &str, error: local::LocalAiError) -> MaintenanceError {
    // details（CLI の出力の末尾。crate が秘密に見える値を伏せたもの）は画面に出さず、ログにだけ残す
    self.log(
      "maintenance_failed",
      json!({ "action": action, "code": error.code, "details": error.details }),
    );
    MaintenanceError {
      code: error.code,
      message: error.message,
    }
  }
}

/// app data の下の一時ファイルの置き場・Codex の置き場・CLI の場所の上書き・診断ログで `Runtime` を作る。
pub fn runtime_for(
  data_dir: &Path,
  cli_paths: BTreeMap<local::Provider, PathBuf>,
  log: Option<local::LogFn>,
) -> local::Runtime {
  local::Runtime {
    cli_paths,
    scratch_dir: data_dir.join("local-ai"),
    log,
    codex_home: Some(data_dir.join(CODEX_HOME_DIR)),
    ..local::Runtime::default()
  }
}

/// CLI の場所の上書き。設定（settings.json）の `cliPaths: {"claude": "/abs/path", "gpt": "/abs/path", "gemini": "/abs/path"}`
/// と環境変数（開発・テスト。設定より優先）。絶対パスだけを受け、指定があれば crate はそこだけを見る（無ければ「見つかりません」）。
pub fn cli_path_overrides(settings: Option<&Value>) -> BTreeMap<local::Provider, PathBuf> {
  cli_path_overrides_with(settings, |key| std::env::var(key).ok())
}

pub(crate) fn cli_path_overrides_with(
  settings: Option<&Value>,
  env: impl Fn(&str) -> Option<String>,
) -> BTreeMap<local::Provider, PathBuf> {
  let absolute = |value: &str| {
    let value = value.trim();
    Path::new(value).is_absolute().then(|| PathBuf::from(value))
  };
  let mut paths = BTreeMap::new();
  for (key, provider, env_key) in [
    ("claude", local::Provider::ClaudeCode, CLAUDE_PATH_ENV),
    ("gpt", local::Provider::CodexCli, CODEX_PATH_ENV),
    ("gemini", local::Provider::GeminiCli, AGY_PATH_ENV),
  ] {
    let from_env = env(env_key).and_then(|value| absolute(&value));
    let from_settings = settings
      .and_then(|settings| settings.get("cliPaths"))
      .and_then(|paths| paths.get(key))
      .and_then(Value::as_str)
      .and_then(absolute);
    if let Some(path) = from_env.or(from_settings) {
      paths.insert(provider, path);
    }
  }
  paths
}

/// 診断ログを `<dir>/local-ai.log` に 1 行ずつ JSON で書く（書けなくても実行は止めない）。
pub fn file_log(dir: PathBuf) -> local::LogFn {
  let lock = Arc::new(Mutex::new(()));
  Arc::new(move |kind: &str, payload: Value| {
    let _guard = lock.lock();
    append_log(&dir, kind, payload);
  })
}

fn append_log(dir: &Path, kind: &str, payload: Value) {
  if fs::create_dir_all(dir).is_err() {
    return;
  }
  let path = dir.join(LOG_FILE);
  if fs::metadata(&path)
    .map(|meta| meta.len() > LOG_MAX_BYTES)
    .unwrap_or(false)
  {
    for index in (1..LOG_BACKUPS).rev() {
      let _ = fs::rename(
        dir.join(format!("{LOG_FILE}.{index}")),
        dir.join(format!("{LOG_FILE}.{}", index + 1)),
      );
    }
    let _ = fs::rename(&path, dir.join(format!("{LOG_FILE}.1")));
  }
  let epoch_ms = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|elapsed| elapsed.as_millis() as u64)
    .unwrap_or_default();
  let entry = json!({ "epochMs": epoch_ms, "kind": kind, "data": payload });
  if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
    let _ = writeln!(file, "{entry}");
  }
}

// ---------------------------------------------------------------------------
// 型の写し

/// アプリの提供元 → crate の CLI（gemini は Antigravity CLI。crate の名前は `GeminiCli` のまま）。API キー方式の提供元は
/// CLI ではないので None（api_ai.rs が受け持つ。ここへは来ない）。
pub(crate) fn local_provider(provider: Provider) -> Option<local::Provider> {
  match provider {
    Provider::ClaudeCode => Some(local::Provider::ClaudeCode),
    Provider::CodexCli => Some(local::Provider::CodexCli),
    Provider::GeminiCli => Some(local::Provider::GeminiCli),
    Provider::AnthropicApi | Provider::OpenAiApi | Provider::GeminiApi => None,
  }
}

/// CLI でない提供元を渡されたとき（router の誤り）の失敗。
fn not_a_cli() -> MaintenanceError {
  MaintenanceError::new("provider_unsupported", "この提供元は この Mac の CLI ではありません。")
}

/// すぐに終わった依頼（CLI でない提供元を渡されたとき）。
struct FinishedTurn;

impl TurnHandle for FinishedTurn {
  fn stop(&self) {}
}

fn local_effort(effort: crate::contract::Effort) -> local::Effort {
  match effort {
    crate::contract::Effort::Low => local::Effort::Low,
    crate::contract::Effort::Medium => local::Effort::Medium,
    crate::contract::Effort::High => local::Effort::High,
    crate::contract::Effort::Max => local::Effort::Max,
  }
}

pub(crate) fn app_reason(code: local::ReasonCode) -> ReasonCode {
  match code {
    local::ReasonCode::CliLoginRequired => ReasonCode::CliLoginRequired,
    local::ReasonCode::UsageLimitReached => ReasonCode::UsageLimitReached,
    local::ReasonCode::NotConfigured => ReasonCode::NotConfigured,
    local::ReasonCode::Unreachable => ReasonCode::Unreachable,
    local::ReasonCode::SessionNotFound => ReasonCode::SessionNotFound,
    local::ReasonCode::TransientFailure => ReasonCode::TransientFailure,
    local::ReasonCode::ModelNotFound => ReasonCode::ModelNotFound,
    local::ReasonCode::TimedOut => ReasonCode::Timeout,
  }
}

pub(crate) fn local_tool_policy(policy: ToolPolicy) -> local::ToolPolicy {
  match policy {
    ToolPolicy::None => local::ToolPolicy::None,
    ToolPolicy::ProjectFolder { dir, writable, .. } => local::ToolPolicy::ProjectFolder { dir, writable },
    ToolPolicy::ReadFile { file } => local::ToolPolicy::ReadFile { file },
  }
}

/// 知らせの種類の名前（crate の JSON と同じ。画面の契約 `ShellAiEvent` の `Notice.code`）。
fn notice_code(code: local::NoticeCode) -> &'static str {
  match code {
    local::NoticeCode::WebSearchOff => "webSearchOff",
    local::NoticeCode::WebSearchUnsupported => "webSearchUnsupported",
  }
}

fn app_stop_reason(reason: local::StopReason) -> StopReason {
  match reason {
    local::StopReason::EndTurn => StopReason::EndTurn,
    local::StopReason::MaxTokens => StopReason::MaxTokens,
    local::StopReason::Stopped => StopReason::Stopped,
  }
}

fn app_usage(provider: local::Provider, usage: local::Usage, model: &str) -> Usage {
  // Claude Code の total_cost_usd は、サブスクリプションでも API 料金に換算した見込み（請求額ではない）
  let cost_usd = match provider {
    local::Provider::ClaudeCode => None,
    _ => usage.cost_usd,
  };
  Usage {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cost_usd,
    model_used: usage.model_used.or_else(|| Some(model.to_string())),
    cost_known: cost_usd.is_some(),
  }
}

/// 画面に流す形。crate の知らせ（`Notice`。Web の検索を切った・この版では検索できない）は `TurnEvent::Notice` として流す
/// （#283。画面が作業の行に出す）。流さない出来事は None。
pub(crate) fn app_event(provider: local::Provider, model: &str, event: local::TurnEvent) -> Option<TurnEvent> {
  Some(match event {
    local::TurnEvent::ThinkingDelta(text) => TurnEvent::ThinkingDelta(text),
    local::TurnEvent::TextDelta(text) => TurnEvent::TextDelta(text),
    local::TurnEvent::ToolUse { id, name, summary } => TurnEvent::ToolUse { id, name, summary },
    local::TurnEvent::ToolResult { id, name, ok } => TurnEvent::ToolResult { id, name, ok },
    local::TurnEvent::Done {
      text,
      stop_reason,
      session_id,
      usage,
      duration_ms,
      continuations,
    } => TurnEvent::Done {
      text,
      stop_reason: app_stop_reason(stop_reason),
      session_id,
      usage: app_usage(provider, usage, model),
      duration_ms,
      continuations,
    },
    local::TurnEvent::Error { reason_code, message } => {
      let reason_code = app_reason(reason_code);
      let message = if reason_code == ReasonCode::ModelNotFound {
        MODEL_NOT_FOUND_MESSAGE.to_string()
      } else {
        message
      };
      TurnEvent::Error { reason_code, message }
    }
    local::TurnEvent::Notice { code } => TurnEvent::Notice {
      code: notice_code(code).to_string(),
      message: code.message().to_string(),
    },
  })
}

pub(crate) fn app_status(status: local::ProviderStatus) -> ProviderStatus {
  ProviderStatus {
    installed: status.installed,
    authenticated: status.authenticated,
    version: status.version,
    cli_path: status.cli_path,
    login_method: status.login_method,
    reason: status.reason,
    missing_cli_flags: status.missing_cli_flags,
    capabilities: ProviderCapabilities {
      resume: status.capabilities.resume,
      effort: status.capabilities.effort,
      // Claude Code・Codex CLI はフラグで、Antigravity CLI は独自のエージェント（tools: []）でツールを切り、出力にツールの
      // 気配があれば止める（crate の fake_cli のテストで確かめている）
      tools_off_proven: true,
      usage: true,
      cost: false,
    },
    models: status.models,
  }
}

fn app_provider_usage(usage: local::ProviderUsage) -> ProviderUsage {
  ProviderUsage {
    windows: usage
      .windows
      .into_iter()
      .map(|window| UsageWindow {
        group: window.group,
        name: window.name,
        window: window.window,
        remaining_fraction: window.remaining_fraction,
        reset_time: window.reset_time,
      })
      .collect(),
  }
}

/// 届いた本文の差分の前後の空白（Claude Code の `Done.text` に戻す）。
#[derive(Default)]
pub(crate) struct StreamEdges {
  /// 本文（空白でない文字）が届いたか。
  started: bool,
  leading: String,
  trailing: String,
}

impl StreamEdges {
  pub(crate) fn push(&mut self, delta: &str) {
    if !self.started {
      let rest = delta.trim_start();
      self.leading.push_str(&delta[..delta.len() - rest.len()]);
      self.started = !rest.is_empty();
    }
    let body = delta.trim_end();
    if body.is_empty() {
      self.trailing.push_str(delta);
    } else {
      self.trailing = delta[body.len()..].to_string();
    }
  }

  /// 前後の空白を落とした本文に、差分の前後の空白を戻す（本文が無い・差分が届いていなければそのまま）。
  pub(crate) fn restore(&self, text: String) -> String {
    if !self.started || text.trim().is_empty() || text.trim() != text {
      return text;
    }
    format!("{}{text}{}", self.leading, self.trailing)
  }
}

// ---------------------------------------------------------------------------

struct LocalTurn(local::TurnHandle);

impl TurnHandle for LocalTurn {
  fn stop(&self) {
    self.0.stop();
  }
}

impl LlmRunner for LocalAiRunner {
  fn run_turn(&self, request: TurnRequest, mut on_event: EventSink) -> Arc<dyn TurnHandle> {
    let Some(provider) = local_provider(request.provider) else {
      on_event(TurnEvent::Error {
        reason_code: ReasonCode::NotConfigured,
        message: not_a_cli().message,
      });
      return Arc::new(FinishedTurn);
    };
    let model = request.model.clone();
    // 修正の会話の返答は文書ではないので、前後の空白を差分から戻さない
    let restore_edges = request.tool_policy == ToolPolicy::None;
    // Web の検索は、修正の会話（ProjectFolder）が許したときだけ（#283）。ほかの方針は crate が見ない
    let web_search = matches!(request.tool_policy, ToolPolicy::ProjectFolder { web_search: true, .. });
    let turn = local::TurnRequest {
      provider,
      model: request.model,
      effort: request.effort.map(local_effort),
      system_prompt: request.system_prompt,
      user_prompt: request.user_prompt,
      resume_session: request.resume_session,
      workdir: request.workdir,
      timeout: request.timeout,
      max_budget_usd: request.max_budget_usd,
      tool_policy: local_tool_policy(request.tool_policy),
      web_search,
    };
    let mut edges = StreamEdges::default();
    let handle = local::run_turn_with(&self.runtime, turn, move |event| {
      if let local::TurnEvent::TextDelta(delta) = &event {
        edges.push(delta);
      }
      let Some(mut event) = app_event(provider, &model, event) else {
        return;
      };
      // Codex は最後のメッセージだけが本文で、差分（途中のメッセージも流れる）と一致しないので戻さない
      if let (local::Provider::ClaudeCode, true, TurnEvent::Done { text, .. }) = (provider, restore_edges, &mut event) {
        *text = edges.restore(std::mem::take(text));
      }
      on_event(event)
    });
    Arc::new(LocalTurn(handle))
  }

  fn provider_status(&self, provider: Provider) -> ProviderStatus {
    match local_provider(provider) {
      Some(provider) => app_status(local::provider_status_with(&self.runtime, provider)),
      None => ProviderStatus {
        reason: Some("cli_not_found".into()),
        ..ProviderStatus::default()
      },
    }
  }

  fn start_auth(&self, provider: Provider) -> Result<ProviderStatus, MaintenanceError> {
    let provider = local_provider(provider).ok_or_else(not_a_cli)?;
    local::start_auth_with(&self.runtime, provider)
      .map(app_status)
      .map_err(|error| self.maintenance_error("auth", error))
  }

  fn provider_usage(&self, provider: Provider) -> Result<ProviderUsage, MaintenanceError> {
    let provider = local_provider(provider).ok_or_else(not_a_cli)?;
    local::provider_usage_with(&self.runtime, provider)
      .map(app_provider_usage)
      .map_err(|error| self.maintenance_error("usage", error))
  }

  fn install_claude(&self) -> Result<ProviderStatus, MaintenanceError> {
    local::install_claude_with(&self.runtime)
      .map(app_status)
      .map_err(|error| self.maintenance_error("install", error))
  }

  fn update_claude(&self) -> Result<ClaudeUpdate, MaintenanceError> {
    local::update_claude_with(&self.runtime)
      .map(|result| ClaudeUpdate {
        before_version: result.before_version,
        after_version: result.after_version,
        status: app_status(result.status),
      })
      .map_err(|error| self.maintenance_error("update", error))
  }

  fn has_running_turns(&self) -> bool {
    local::has_running_turns()
  }

  fn shutdown(&self) {
    local::shutdown();
  }
}

#[cfg(test)]
#[path = "local_ai_tests.rs"]
mod tests;
