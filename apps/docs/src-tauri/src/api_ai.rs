//! API キー方式（S2b #18383・spec §6.1）の adapter: crate `niho-api-ai` を契約（contract.rs）の形に写し、鍵を保存先
//! （secrets.rs。app data の api-keys/）から読んで渡す。
//!
//! - 提供元: `AnthropicApi`（Messages API）・`OpenAiApi`（Responses API）・`GeminiApi`（generateContent）。`ProviderRouter` が
//!   契約の `LlmRunner` として CLI（local_ai.rs）とこちらを振り分ける（方式は画面が決める。自動で切り替えない）。
//! - 鍵: 画面へ返さない（`ApiKeyStatus` は保存済みか・末尾 4 文字・確かめた結果だけ）。保存は 1 回の軽い呼び出し（モデルの一覧。
//!   Deepgram はプロジェクトの一覧）で確かめてから。失敗なら保存しない。ログ・エラー文に鍵を入れない。
//! - 理由コード: 鍵が無い → `NotConfigured`、鍵が無効（401・403）→ `CliLoginRequired`（文は「API キーが無効です。設定 ›
//!   接続設定で確かめてください。」）、429・残高不足 → `UsageLimitReached`、モデルが無い → `ModelNotFound`、接続できない →
//!   `Unreachable`、時間切れ → `Timeout`、続ける会話が無い → `SessionNotFound`、5xx・途中で切れた・受け付けない・断られた →
//!   `TransientFailure`（文は理由ごと）。
//! - 費用: API は 1 回ごとの請求額を返さないので `cost_usd` は null（`cost_known` false）。見込み金額は画面が docs-core の単価表で
//!   トークン数から出す。`model_used` は API が返した実際のモデル。
//! - 続き: crate が会話の履歴を workspace（app data の下・実行ごと。24 時間で掃除）に持ち、同じ会話として送る（`resume=true`）。
//!   crate は自分で続きを頼まない（`continuations` は 0。続きはアプリが MaxTokens で頼む）。
//! - 文字起こし: Gemini は `ToolPolicy::ReadFile`（区切りの WAV）を Files API に上げて添える。Deepgram は録音のファイルを送る。
//! - 修正の会話（S5 #18386）: `ToolPolicy::ProjectFolder { dir, writable }` を crate の `FolderTools` にし、crate が隔離
//!   workspace の中だけを読み、`writable` の下の `.md` だけを書ける道具（list_files・read_file・edit_file・write_file）で
//!   往復する。crate の `ToolUse`・`ToolResult`（画面の名前 Read・Edit・Write・Glob とファイル名だけ）を契約のイベントに写す。
//!   `workdir` は会話の履歴の置き場（会話ごとに残る）。

use crate::contract::{
  EventSink, LlmRunner, MaintenanceError, Provider, ProviderCapabilities, ProviderStatus, ProviderUsage, ReasonCode,
  StopReason, ToolPolicy, TurnEvent, TurnHandle, TurnRequest, Usage,
};
use crate::secrets::{SecretError, SecretStore, REENTER};
use niho_api_ai as api;
use serde::Serialize;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 鍵の状態（画面へ返す。鍵そのものは入れない）。docs-core の `ApiKeyStatus` と同じ形。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ApiKeyStatus {
  pub saved: bool,
  pub last4: Option<String>,
  /// 軽い呼び出しで確かめた結果（確かめていなければ null）。
  pub valid: Option<bool>,
  /// 確かめたときに返ったモデルの ID（工程に使える種類だけ）。
  pub models: Vec<String>,
  /// "api_key_invalid" | "api_usage_limit" | "api_unreachable" | "api_failed" | "api_key_reenter"
  pub reason: Option<String>,
  pub message: Option<String>,
}

const MAX_KEY_CHARS: usize = 512;
const KEY_FORMAT_MESSAGE: &str = "API キーの形が正しくありません。コピーし直して、もう一度貼り付けてください。";
/// Deepgram の 1 回（音声 1 つ）の時間の上限。Deepgram の録音の処理は 60 分の音声で 1 分前後（送る時間を含めて余裕を見る）。
pub const DEEPGRAM_TIME_LIMIT: Duration = Duration::from_secs(30 * 60);

fn secret_error(error: SecretError) -> MaintenanceError {
  MaintenanceError::new(error.code, error.message)
}

fn api_provider(provider: Provider) -> Option<api::ApiProvider> {
  match provider {
    Provider::AnthropicApi => Some(api::ApiProvider::Anthropic),
    Provider::OpenAiApi => Some(api::ApiProvider::OpenAi),
    Provider::GeminiApi => Some(api::ApiProvider::Gemini),
    Provider::ClaudeCode | Provider::CodexCli | Provider::GeminiCli => None,
  }
}

fn api_effort(effort: crate::contract::Effort) -> api::Effort {
  match effort {
    crate::contract::Effort::Low => api::Effort::Low,
    crate::contract::Effort::Medium => api::Effort::Medium,
    crate::contract::Effort::High => api::Effort::High,
    crate::contract::Effort::Max => api::Effort::Max,
  }
}

/// crate の理由 → 契約の理由コード。
pub(crate) fn app_reason(reason: api::Reason) -> ReasonCode {
  match reason {
    api::Reason::NotConfigured => ReasonCode::NotConfigured,
    // 鍵が無効はログインの代わり（画面の文は「API キーが無効です…」）
    api::Reason::KeyInvalid => ReasonCode::CliLoginRequired,
    api::Reason::UsageLimitReached => ReasonCode::UsageLimitReached,
    api::Reason::ModelNotFound => ReasonCode::ModelNotFound,
    api::Reason::SessionNotFound => ReasonCode::SessionNotFound,
    api::Reason::Unreachable => ReasonCode::Unreachable,
    api::Reason::Timeout => ReasonCode::Timeout,
    api::Reason::BadRequest | api::Reason::Refused | api::Reason::TransientFailure => ReasonCode::TransientFailure,
  }
}

fn app_event(event: api::TurnEvent) -> TurnEvent {
  match event {
    api::TurnEvent::ThinkingDelta(text) => TurnEvent::ThinkingDelta(text),
    api::TurnEvent::TextDelta(text) => TurnEvent::TextDelta(text),
    api::TurnEvent::ToolUse { id, name, summary } => TurnEvent::ToolUse { id, name, summary },
    api::TurnEvent::ToolResult { id, name, ok } => TurnEvent::ToolResult { id, name, ok },
    api::TurnEvent::Done {
      text,
      stop_reason,
      session_id,
      usage,
      duration_ms,
    } => TurnEvent::Done {
      text,
      stop_reason: match stop_reason {
        api::StopReason::EndTurn => StopReason::EndTurn,
        api::StopReason::MaxTokens => StopReason::MaxTokens,
        api::StopReason::Stopped => StopReason::Stopped,
      },
      session_id,
      usage: Usage {
        input_tokens: if usage.known { usage.input_tokens } else { 0 },
        output_tokens: if usage.known { usage.output_tokens } else { 0 },
        cost_usd: None,
        model_used: usage.model_used,
        cost_known: false,
      },
      duration_ms,
      continuations: 0,
    },
    api::TurnEvent::Error { reason, message } => TurnEvent::Error {
      reason_code: app_reason(reason),
      message,
    },
  }
}

fn status_reason(reason: api::Reason) -> &'static str {
  match reason {
    api::Reason::KeyInvalid => "api_key_invalid",
    api::Reason::UsageLimitReached => "api_usage_limit",
    api::Reason::Unreachable | api::Reason::Timeout => "api_unreachable",
    _ => "api_failed",
  }
}

/// 鍵の形（前後の空白は落とす。空・長すぎる・空白や制御文字を含むものは受けない）。
fn normalize_key(raw: &str) -> Result<api::Secret, MaintenanceError> {
  let key = raw.trim();
  if key.is_empty()
    || key.chars().count() > MAX_KEY_CHARS
    || key.chars().any(|ch| ch.is_whitespace() || ch.is_control())
  {
    return Err(MaintenanceError::new("api_key_format", KEY_FORMAT_MESSAGE));
  }
  Ok(api::Secret::new(key))
}

struct ApiTurn(api::TurnHandle);

impl TurnHandle for ApiTurn {
  fn stop(&self) {
    self.0.stop();
  }
}

struct FinishedTurn;

impl TurnHandle for FinishedTurn {
  fn stop(&self) {}
}

pub struct ApiAiRunner {
  config: api::Config,
  secrets: Arc<dyn SecretStore>,
  /// 実行中の依頼（終了時に止める）。
  running: Mutex<Vec<api::TurnHandle>>,
}

impl ApiAiRunner {
  pub fn new(config: api::Config, secrets: Arc<dyn SecretStore>) -> Self {
    Self {
      config,
      secrets,
      running: Mutex::new(Vec::new()),
    }
  }

  fn log(&self, kind: &str, payload: serde_json::Value) {
    if let Some(log) = &self.config.log {
      log(kind, payload);
    }
  }

  fn saved_status(&self, account: api::Account) -> Result<ApiKeyStatus, MaintenanceError> {
    let secret = match self.secrets.get(account) {
      Ok(secret) => secret,
      // 以前の版が Keychain に置いた鍵を読めなかった（#18769）: 未設定として入力欄を出し、入れ直しを案内する
      Err(error) if error == REENTER => {
        return Ok(ApiKeyStatus {
          reason: Some(error.code.into()),
          message: Some(error.message.into()),
          ..ApiKeyStatus::default()
        })
      }
      Err(error) => return Err(secret_error(error)),
    };
    Ok(ApiKeyStatus {
      saved: secret.is_some(),
      last4: secret.and_then(|secret| secret.last4()),
      ..ApiKeyStatus::default()
    })
  }

  /// 保存済みか・末尾 4 文字（呼び出しはしない）。
  pub fn key_status(&self, account: api::Account) -> Result<ApiKeyStatus, MaintenanceError> {
    self.saved_status(account)
  }

  /// 1 回の軽い呼び出しで確かめてからこの Mac に保存する（失敗なら保存しない）。
  pub fn save_key(&self, account: api::Account, raw: &str) -> Result<ApiKeyStatus, MaintenanceError> {
    let secret = normalize_key(raw)?;
    match api::check_key(&self.config, account, &secret) {
      Ok(check) => {
        self.secrets.set(account, &secret).map_err(secret_error)?;
        self.log("api_key_saved", serde_json::json!({ "account": account.as_str() }));
        Ok(ApiKeyStatus {
          saved: true,
          last4: secret.last4(),
          valid: Some(true),
          models: check.models,
          reason: None,
          message: None,
        })
      }
      // 鍵は正しいが上限・残高（保存する。実行のときにも同じ理由で止まる）
      Err(error) if error.reason == api::Reason::UsageLimitReached => {
        self.secrets.set(account, &secret).map_err(secret_error)?;
        Ok(ApiKeyStatus {
          saved: true,
          last4: secret.last4(),
          valid: Some(true),
          models: Vec::new(),
          reason: Some(status_reason(error.reason).into()),
          message: Some(error.message),
        })
      }
      Err(error) => Err(MaintenanceError::new(status_reason(error.reason), &error.message)),
    }
  }

  /// 保存済みの鍵で 1 回の軽い呼び出しをする。
  pub fn check_key(&self, account: api::Account) -> Result<ApiKeyStatus, MaintenanceError> {
    let Some(secret) = self.secrets.get(account).map_err(secret_error)? else {
      return Ok(ApiKeyStatus::default());
    };
    let last4 = secret.last4();
    Ok(match api::check_key(&self.config, account, &secret) {
      Ok(check) => ApiKeyStatus {
        saved: true,
        last4,
        valid: Some(true),
        models: check.models,
        reason: None,
        message: None,
      },
      Err(error) => ApiKeyStatus {
        saved: true,
        last4,
        valid: match error.reason {
          api::Reason::KeyInvalid => Some(false),
          api::Reason::UsageLimitReached => Some(true),
          _ => None,
        },
        models: Vec::new(),
        reason: Some(status_reason(error.reason).into()),
        message: Some(error.message),
      },
    })
  }

  pub fn delete_key(&self, account: api::Account) -> Result<ApiKeyStatus, MaintenanceError> {
    self.secrets.delete(account).map_err(secret_error)?;
    self.log("api_key_deleted", serde_json::json!({ "account": account.as_str() }));
    Ok(ApiKeyStatus::default())
  }

  /// API キー方式の提供元の状態（呼び出しはしない。鍵が保存されていれば authenticated）。
  pub fn status(&self, provider: Provider) -> ProviderStatus {
    let Some(provider) = api_provider(provider) else {
      return ProviderStatus::default();
    };
    let saved = self.secrets.get(provider.account()).ok().flatten().is_some();
    ProviderStatus {
      installed: true,
      authenticated: saved,
      version: None,
      cli_path: None,
      login_method: Some("API キー".into()),
      reason: (!saved).then(|| "api_key_missing".into()),
      missing_cli_flags: Vec::new(),
      capabilities: ProviderCapabilities {
        resume: true,
        effort: true,
        // 工程の実行はツールを渡さない（依頼にツールの定義を入れない）。道具は修正の会話（ProjectFolder）だけ
        tools_off_proven: true,
        usage: true,
        cost: false,
      },
      models: Vec::new(),
    }
  }

  fn forget_finished(&self) {
    if let Ok(mut running) = self.running.lock() {
      running.retain(|handle| !handle.is_finished());
    }
  }

  pub fn run_turn(&self, request: TurnRequest, mut on_event: EventSink) -> Arc<dyn TurnHandle> {
    let Some(provider) = api_provider(request.provider) else {
      on_event(TurnEvent::Error {
        reason_code: ReasonCode::NotConfigured,
        message: "この提供元は API キーの方式ではありません。".into(),
      });
      return Arc::new(FinishedTurn);
    };
    let fail = |code: ReasonCode, message: String, on_event: &mut EventSink| {
      on_event(TurnEvent::Error {
        reason_code: code,
        message,
      });
      Arc::new(FinishedTurn) as Arc<dyn TurnHandle>
    };
    let (audio, tools) = match &request.tool_policy {
      ToolPolicy::None => (None, None),
      ToolPolicy::ReadFile { file } if provider == api::ApiProvider::Gemini => (Some(file.clone()), None),
      ToolPolicy::ReadFile { .. } => {
        return fail(
          ReasonCode::NotConfigured,
          "音声を添える文字起こしは Gemini だけで使えます。".into(),
          &mut on_event,
        )
      }
      ToolPolicy::ProjectFolder { dir, writable, .. } => (
        None,
        Some(api::FolderTools {
          dir: dir.clone(),
          writable: writable.clone(),
        }),
      ),
    };
    let account = provider.account();
    let secret = match self.secrets.get(account) {
      Ok(Some(secret)) => secret,
      Ok(None) => {
        return fail(
          ReasonCode::NotConfigured,
          api::reason_message(api::Reason::NotConfigured, account),
          &mut on_event,
        )
      }
      Err(error) => return fail(ReasonCode::NotConfigured, error.message.into(), &mut on_event),
    };
    let turn = api::TurnRequest {
      provider,
      api_key: secret,
      model: request.model,
      effort: request.effort.map(api_effort),
      system_prompt: request.system_prompt,
      user_prompt: request.user_prompt,
      resume_session: request.resume_session,
      session_dir: request.workdir,
      timeout: request.timeout,
      max_output_tokens: api::default_max_output_tokens(provider),
      audio,
      tools,
    };
    self.forget_finished();
    let handle = api::run_turn(&self.config, turn, move |event| on_event(app_event(event)));
    if let Ok(mut running) = self.running.lock() {
      running.push(handle.clone());
    }
    Arc::new(ApiTurn(handle))
  }

  /// Deepgram で音声 1 つを文字起こしする（終わるまで戻らない。止めたら Ok(None)）。
  pub fn transcribe_deepgram(
    &self,
    audio: &Path,
    request: &api::DeepgramRequest,
    stop: &api::StopSignal,
  ) -> Result<Option<api::DeepgramResult>, MaintenanceError> {
    let secret = self
      .secrets
      .get(api::Account::Deepgram)
      .map_err(secret_error)?
      .ok_or_else(|| {
        MaintenanceError::new(
          "api_key_missing",
          &api::reason_message(api::Reason::NotConfigured, api::Account::Deepgram),
        )
      })?;
    api::deepgram::transcribe(&self.config, &secret, audio, request, DEEPGRAM_TIME_LIMIT, stop)
      .map_err(|error| MaintenanceError::new(status_reason(error.reason), &error.message))
  }

  pub fn has_running_turns(&self) -> bool {
    api::running_turns() > 0
  }

  pub fn shutdown(&self) {
    if let Ok(mut running) = self.running.lock() {
      for handle in running.drain(..) {
        handle.stop();
      }
    }
  }
}

/// 契約の `LlmRunner`: CLI の提供元は local_ai.rs、API キー方式の提供元は ApiAiRunner へ。
pub struct ProviderRouter {
  pub local: Arc<dyn LlmRunner>,
  pub api: Arc<ApiAiRunner>,
}

impl LlmRunner for ProviderRouter {
  fn run_turn(&self, request: TurnRequest, on_event: EventSink) -> Arc<dyn TurnHandle> {
    if request.provider.is_api() {
      self.api.run_turn(request, on_event)
    } else {
      self.local.run_turn(request, on_event)
    }
  }

  fn provider_status(&self, provider: Provider) -> ProviderStatus {
    if provider.is_api() {
      self.api.status(provider)
    } else {
      self.local.provider_status(provider)
    }
  }

  fn start_auth(&self, provider: Provider) -> Result<ProviderStatus, MaintenanceError> {
    if provider.is_api() {
      return Err(MaintenanceError::new(
        "auth_unsupported",
        "API キーの方式はログインしません。設定 › 接続設定で API キーを保存してください。",
      ));
    }
    self.local.start_auth(provider)
  }

  fn install_claude(&self) -> Result<ProviderStatus, MaintenanceError> {
    self.local.install_claude()
  }

  fn update_claude(&self) -> Result<crate::contract::ClaudeUpdate, MaintenanceError> {
    self.local.update_claude()
  }

  fn has_running_turns(&self) -> bool {
    self.local.has_running_turns() || self.api.has_running_turns()
  }

  fn provider_usage(&self, provider: Provider) -> Result<ProviderUsage, MaintenanceError> {
    if provider.is_api() {
      return Err(MaintenanceError::new(
        "usage_unsupported",
        "使用量を取得できませんでした。",
      ));
    }
    self.local.provider_usage(provider)
  }

  fn shutdown(&self) {
    self.local.shutdown();
    self.api.shutdown();
  }
}

#[cfg(test)]
#[path = "api_ai_tests.rs"]
mod tests;
