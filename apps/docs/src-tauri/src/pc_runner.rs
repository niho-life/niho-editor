//! 「この Mac で続きを受ける」（#18804 S2。owner 決定 2026-10-17）。
//!
//! ON の間、スマホで「自分の Mac で続ける」を選んだ録音の後続工程（修正・整理＝REVISION / INSIGHT）を、窓とは別の裏のループ
//! （tauri の async runtime）が NIHO API（S1 #18803。pc_runner_api.rs）から 1 件ずつ受け取り、この Mac の AI の接続
//! （サブスクリプションの CLI か API キー）で実行して、成果物を上げて提出する。スリープは止めない。
//!
//! - 設定は Rust が持つ `<data_dir>/pc-runner.json` の `{"enabled": bool}`（settings.json は画面の正規化が知らないキーを落とす）。
//! - この Mac の AI は settings.json（画面の `save_settings` が書く）の `connection` と `connections.<方式>.providers`・`profiles`。
//! - 手元の実行と同時にはしない: 受け取りに行く前に、手元が忙しければ受け取らず在席だけ送る。受け取りに行っている間・実行中は
//!   `acquire_run_lock`・`personal_run::open` が `pc_runner_busy` で断る（`Gate`。実行のロックの mutex の中で決める）。
//! - AI へ送る直前に `/dispatch`。それより後は AI を自動でやり直さない。別の AI・NIHO の API へは切り替えない。
//! - id token・署名付き URL・プロンプト・AI の出力は画面へも、ログへも出さない。

use crate::contract::{Effort, Provider, ProviderStatus, StopReason, ToolPolicy, TurnEvent, TurnRequest};
use crate::pc_runner_api::{
  AccountSession, ApiError, Claim, Connection, ContainerRef, FailReason, JobStep, LeasedJob, ModelChoice, NoTransport,
  PcRunnerApi, PcRunnerTransport, ProviderId, Registration, ReqwestTransport, SessionToken, StepEffort, StepKind,
  MAX_CANDIDATE_BYTES, MAX_SYSTEM_PROMPT_BYTES, MAX_USER_PROMPT_BYTES,
};
use crate::shell::ShellMode;
use crate::{AppState, CommandError, CommandResult};
use chrono::{DateTime, Utc};
use niho_desktop_account::AccountService;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::{Emitter, Manager, State};
use tokio::sync::Notify;

/// 状態が変わるたびに画面へ送る event（payload は `PcRunnerStatus`）。
pub(crate) const STATE_EVENT: &str = "pc-runner://state";
const SETTING_FILE: &str = "pc-runner.json";
const STANDARD_PROFILE_ID: &str = "standard";
/// 手元で実行しようとしたときに、スマホからの依頼を実行していた（design-guide-docs.md §4.1）。
pub(crate) const BUSY_MESSAGE: &str =
  "スマホから依頼された工程をこの Mac で実行しています。終わってからもう一度お試しください。";

pub(crate) type LogFn = Arc<dyn Fn(&str, Value) + Send + Sync>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

// ---------------------------------------------------------------------------
// 手元の実行との排他

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Phase {
  #[default]
  Off,
  Idle,
  /// 依頼を受け取りに行っている（手元の実行を断る）。
  Claiming,
  /// 受け取った依頼を実行している（手元の実行を断る）。
  Running,
}

/// AppState が持つ、裏のループの段階。実行のロックの mutex（`run_locks`）の中で読み書きする（順は run_locks → phase）。
#[derive(Default)]
pub(crate) struct Gate {
  phase: Mutex<Phase>,
  /// 常駐中の自動更新（#18823）が、何も動いていないことを確かめて再起動するまで、受け取りに行かない。
  /// `run_locks` の mutex の中で立てて、`begin_claim` も同じ mutex の中で見る。
  paused: AtomicBool,
}

impl Gate {
  pub(crate) fn phase(&self) -> Phase {
    *lock(&self.phase)
  }

  pub(crate) fn set(&self, phase: Phase) {
    *lock(&self.phase) = phase;
  }

  /// 受け取りに行っている・実行している（手元の実行・自動更新の再起動・接続方式の切り替えをしない）。
  pub(crate) fn blocks_local_runs(&self) -> bool {
    matches!(self.phase(), Phase::Claiming | Phase::Running)
  }

  /// 受け取りを止める（`run_locks` の mutex を持ったまま呼ぶ）。
  pub(crate) fn pause(&self) {
    self.paused.store(true, Ordering::SeqCst);
  }

  pub(crate) fn resume(&self) {
    self.paused.store(false, Ordering::SeqCst);
  }

  fn paused(&self) -> bool {
    self.paused.load(Ordering::SeqCst)
  }
}

pub(crate) fn busy_error() -> CommandError {
  CommandError::new("pc_runner_busy", BUSY_MESSAGE)
}

/// 手元の実行の開始（実行のロックの mutex を持ったまま呼ぶ）。
pub(crate) fn refuse_local_run(state: &AppState) -> CommandResult<()> {
  if state.pc_gate.blocks_local_runs() {
    Err(busy_error())
  } else {
    Ok(())
  }
}

/// 手元で工程・会話・文字起こしが動いているか（実行のロックは見ない。`begin_claim` が mutex の中で見る）。
fn locally_busy(state: &AppState) -> bool {
  fn busy(len: Option<usize>) -> bool {
    len.is_none_or(|len| len > 0)
  }
  busy(state.personal_ops.lock().ok().map(|ops| ops.len()))
    || busy(state.turns.lock().ok().map(|turns| turns.len()))
    || busy(state.speech_jobs.lock().ok().map(|jobs| jobs.len()))
    || busy(state.deepgram_jobs.lock().ok().map(|jobs| jobs.len()))
    || busy(state.audio_jobs.lock().ok().map(|jobs| jobs.len()))
    || state.runner.has_running_turns()
}

/// 手元が空いていれば、実行のロックの mutex の中で「受け取りに行っている」にする。忙しければ false（受け取らない）。
pub(crate) fn begin_claim(state: &AppState) -> bool {
  if locally_busy(state) {
    return false;
  }
  let Ok(run_locks) = state.run_locks.lock() else {
    return false;
  };
  if !run_locks.is_empty() || state.pc_gate.paused() {
    return false;
  }
  state.pc_gate.set(Phase::Claiming);
  true
}

/// 受け取り・実行が終わったら（途中で抜けても）段階を戻す。
struct PhaseReset<'a>(&'a Gate);

impl Drop for PhaseReset<'_> {
  fn drop(&mut self) {
    self.0.set(Phase::Idle);
  }
}

/// 作業フォルダを終わったら消す。
struct RemoveOnDrop(PathBuf);

impl Drop for RemoveOnDrop {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.0);
  }
}

// ---------------------------------------------------------------------------
// この Mac の設定

pub(crate) fn read_enabled(data_dir: &Path) -> bool {
  std::fs::read(data_dir.join(SETTING_FILE))
    .ok()
    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    .and_then(|value| value.get("enabled").and_then(Value::as_bool))
    .unwrap_or(false)
}

pub(crate) fn write_enabled(data_dir: &Path, enabled: bool) -> std::io::Result<()> {
  let bytes = serde_json::to_vec_pretty(&json!({ "enabled": enabled })).map_err(std::io::Error::other)?;
  write_atomic(&data_dir.join(SETTING_FILE), &bytes)
}

/// 一時ファイル → rename。
pub(crate) fn write_atomic(path: &Path, contents: &[u8]) -> std::io::Result<()> {
  let parent = path
    .parent()
    .ok_or_else(|| std::io::Error::other("no parent directory"))?;
  std::fs::create_dir_all(parent)?;
  let name = path
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_default();
  let suffix = crate::process::hex(&crate::process::random_bytes::<4>()?);
  let temp = parent.join(format!(".{name}.tmp-{}-{suffix}", std::process::id()));
  let written = (|| {
    let mut file = std::fs::File::create(&temp)?;
    file.write_all(contents)?;
    file.sync_all()?;
    std::fs::rename(&temp, path)
  })();
  if written.is_err() {
    let _ = std::fs::remove_file(&temp);
  }
  written
}

/// プロファイルの AI ごとのモデル（思考量は依頼のものを使うので持たない）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProfileModels {
  pub id: String,
  pub models: Vec<(ProviderId, String)>,
}

impl ProfileModels {
  fn model(&self, provider: ProviderId) -> Option<&str> {
    self
      .models
      .iter()
      .find(|(candidate, _)| *candidate == provider)
      .map(|(_, model)| model.as_str())
  }
}

/// この Mac の AI の接続（settings.json の今の方式の分）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MacAi {
  pub connection: Connection,
  pub providers: Vec<ProviderId>,
  pub profiles: Vec<ProfileModels>,
}

/// 画面（apps/docs/src/lib/settings.ts の `normalizeSettings`）と同じ規則で読む。settings.json は人が設定を変えるまで
/// 書かれないので、無い・読めないときは画面の既定（サブスクリプション・Claude）。`providers` の欄が無ければサブスクリプションは
/// Claude、API キーは無し。版 1（S1）は `connections` を持たず、サブスクリプションの `providers`・`profiles` を直に持つ。
pub(crate) fn mac_ai(settings: Option<&Value>) -> MacAi {
  let settings = settings.filter(|settings| settings.is_object());
  let connections = settings
    .and_then(|settings| settings.get("connections"))
    .filter(|connections| connections.is_object());
  let (connection, current) = match connections {
    Some(connections) => {
      let connection = settings
        .and_then(|settings| settings.get("connection"))
        .and_then(Value::as_str)
        .and_then(Connection::parse)
        .unwrap_or(Connection::Subscription);
      let key = match connection {
        Connection::Subscription => "subscription",
        Connection::ApiKey => "apiKey",
      };
      (connection, connections.get(key))
    }
    None => (Connection::Subscription, settings),
  };
  let providers = match current
    .and_then(|current| current.get("providers"))
    .and_then(Value::as_array)
  {
    Some(items) => {
      let mut providers = Vec::new();
      for provider in items
        .iter()
        .filter_map(|item| item.as_str().and_then(ProviderId::parse))
      {
        if !providers.contains(&provider) {
          providers.push(provider);
        }
      }
      providers
    }
    None => match connection {
      Connection::Subscription => vec![ProviderId::Claude],
      Connection::ApiKey => Vec::new(),
    },
  };
  let profiles = current
    .and_then(|current| current.get("profiles"))
    .and_then(Value::as_array)
    .into_iter()
    .flatten()
    .filter_map(profile_models)
    .collect();
  MacAi {
    connection,
    providers,
    profiles,
  }
}

fn profile_models(value: &Value) -> Option<ProfileModels> {
  let id = value.get("id")?.as_str()?.to_string();
  let models = value.get("models")?.as_object()?;
  let models = ProviderId::ALL
    .iter()
    .filter_map(|provider| {
      let model = models.get(provider.as_str())?.get("model")?.as_str()?.trim();
      (!model.is_empty()).then(|| (*provider, model.to_string()))
    })
    .collect();
  Some(ProfileModels { id, models })
}

fn registration(ai: &MacAi, enabled: bool) -> Registration {
  Registration {
    enabled,
    connection: ai.connection,
    providers: ai.providers.clone(),
  }
}

// ---------------------------------------------------------------------------
// モデルの決め方（packages/docs-core/src/profiles.ts の移植。この経路だけの簡略版）

/// AI ごとのモデルの控え（profiles.ts の MODEL_OPTIONS・API_MODEL_OPTIONS と同じ）。
fn fallback_models(connection: Connection, provider: ProviderId) -> &'static [&'static str] {
  match (connection, provider) {
    (Connection::Subscription, ProviderId::Claude) => &[
      "claude-sonnet-4-6",
      "claude-opus-4-8",
      "claude-fable-5",
      "sonnet",
      "opus",
      "fable",
      "haiku",
    ],
    (Connection::Subscription, ProviderId::Gpt) | (Connection::ApiKey, ProviderId::Gpt) => {
      &["gpt-5.6-terra", "gpt-5.6-luna"]
    }
    (Connection::Subscription, ProviderId::Gemini) => &[
      "gemini-3.8-flash",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
    ],
    (Connection::ApiKey, ProviderId::Claude) => &["claude-sonnet-4-6", "claude-opus-4-8", "claude-fable-5"],
    (Connection::ApiKey, ProviderId::Gemini) => &["gemini-3.8-flash", "gemini-3.1-pro-preview"],
  }
}

/// profiles.ts の THINKING_SUFFIX（`^(.+)-(low|medium|high)$`）。
fn thinking_suffix(model: &str) -> Option<StepEffort> {
  let (base, suffix) = model.rsplit_once('-')?;
  if base.is_empty() {
    return None;
  }
  match suffix {
    "low" => Some(StepEffort::Low),
    "medium" => Some(StepEffort::Medium),
    "high" => Some(StepEffort::High),
    _ => None,
  }
}

/// profiles.ts の `effortRule`: 選べる思考量と、モデル名で決まる思考量。
fn effort_rule(provider: ProviderId, model: &str) -> (Vec<StepEffort>, Option<StepEffort>) {
  if provider != ProviderId::Gemini {
    return (StepEffort::ALL.to_vec(), None);
  }
  match thinking_suffix(model) {
    Some(fixed) => (vec![fixed], Some(fixed)),
    None => (vec![StepEffort::Low, StepEffort::Medium, StepEffort::High], None),
  }
}

/// profiles.ts の `fitEffort`（合わなければ、それより低いうちで一番高いもの。無ければ選べる中の先頭）。
pub(crate) fn fit_effort(provider: ProviderId, model: &str, effort: StepEffort) -> StepEffort {
  let (efforts, fixed) = effort_rule(provider, model);
  if let Some(fixed) = fixed {
    return fixed;
  }
  if efforts.contains(&effort) {
    return effort;
  }
  StepEffort::ALL
    .iter()
    .take_while(|candidate| **candidate != effort)
    .filter(|candidate| efforts.contains(candidate))
    .last()
    .or_else(|| efforts.first())
    .copied()
    .unwrap_or(effort)
}

/// turn.ts の `contractProvider`。
fn contract_provider(connection: Connection, provider: ProviderId) -> Provider {
  match (connection, provider) {
    (Connection::Subscription, ProviderId::Claude) => Provider::ClaudeCode,
    (Connection::Subscription, ProviderId::Gpt) => Provider::CodexCli,
    (Connection::Subscription, ProviderId::Gemini) => Provider::GeminiCli,
    (Connection::ApiKey, ProviderId::Claude) => Provider::AnthropicApi,
    (Connection::ApiKey, ProviderId::Gpt) => Provider::OpenAiApi,
    (Connection::ApiKey, ProviderId::Gemini) => Provider::GeminiApi,
  }
}

fn contract_effort(effort: StepEffort) -> Effort {
  match effort {
    StepEffort::Low => Effort::Low,
    StepEffort::Medium => Effort::Medium,
    StepEffort::High => Effort::High,
    StepEffort::Max => Effort::Max,
  }
}

/// この Mac で実行するモデル（`/prompt` に送る値と、CLI・API への依頼の値）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Resolved {
  pub choice: ModelChoice,
  pub contract: Provider,
  /// CLI・API に渡す思考量（思考量がモデル名で決まるモデルは渡さない。profiles.ts の `requestEffort`）。
  pub request_effort: Option<Effort>,
}

/// 依頼の AI・モデル・思考量を、この Mac の登録で決め直す。使えなければ None（`provider_not_ready`）。
pub(crate) fn resolve_model(ai: &MacAi, step: &JobStep) -> Option<Resolved> {
  let provider = step.provider;
  if !ai.providers.contains(&provider) {
    return None;
  }
  let usable = fallback_models(ai.connection, provider).contains(&step.model.as_str())
    || ai
      .profiles
      .iter()
      .any(|profile| profile.model(provider) == Some(step.model.as_str()));
  let model = if usable {
    step.model.clone()
  } else {
    let profile = ai
      .profiles
      .iter()
      .find(|profile| profile.id == STANDARD_PROFILE_ID)
      .or_else(|| ai.profiles.first())?;
    profile.model(provider)?.to_string()
  };
  let effort = fit_effort(provider, &model, step.effort);
  let fixed = effort_rule(provider, &model).1.is_some();
  Some(Resolved {
    contract: contract_provider(ai.connection, provider),
    request_effort: (!fixed).then(|| contract_effort(effort)),
    choice: ModelChoice {
      provider,
      model,
      effort,
    },
  })
}

/// API キーで認証された CLI（personal-provider-readiness.ts の `/api[\s_-]*key/i`）。
fn api_key_login(method: Option<&str>) -> bool {
  method.is_some_and(|method| {
    let squashed: String = method
      .chars()
      .filter(|ch| !ch.is_whitespace() && *ch != '_' && *ch != '-')
      .collect();
    squashed.to_ascii_lowercase().contains("apikey")
  })
}

/// 送る前の確かめ（personal-provider-readiness.ts の 1〜6。契約・残量の確認は省く＝ON にしたことが本人の同意）。
/// API キー方式は、その AI の鍵が Keychain にあること（ProviderRouter の状態の `authenticated`）。
pub(crate) fn provider_ready(connection: Connection, status: &ProviderStatus) -> bool {
  match connection {
    Connection::ApiKey => status.installed && status.authenticated,
    Connection::Subscription => {
      status.installed
        && status.authenticated
        && !api_key_login(status.login_method.as_deref())
        && status.reason.is_none()
        && status.missing_cli_flags.is_empty()
        && status.capabilities.tools_off_proven
    }
  }
}

// ---------------------------------------------------------------------------
// 状態

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunnerState {
  Off,
  Starting,
  Idle,
  Running,
  NeedsLogin,
  Offline,
  StorageUnavailable,
}

/// `pc_runner_status` と `pc-runner://state` の値。`label` は実行中の工程名だけ。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcRunnerStatus {
  pub enabled: bool,
  pub state: RunnerState,
  pub label: Option<String>,
  pub runner_id: Option<String>,
}

/// 状態の 1 行（メニューバーと設定の行で同じ文。design-guide-docs.md §4.1）。
pub(crate) fn status_line(status: &PcRunnerStatus) -> String {
  match status.state {
    RunnerState::Idle => "待機中".into(),
    RunnerState::Running => match status.label.as_deref() {
      Some(label) => format!("処理中: {label}"),
      None => "処理中".into(),
    },
    RunnerState::NeedsLogin => "NIHO アカウントでのログインが必要です".into(),
    RunnerState::Offline => "NIHO に接続できません".into(),
    RunnerState::StorageUnavailable => {
      "保存先が NIHO クラウドであることを確認できません。設定の保存先を確認してください。".into()
    }
    RunnerState::Starting | RunnerState::Off => "準備中".into(),
  }
}

// ---------------------------------------------------------------------------
// 外との境目（本番は Tauri、テストは偽物）

pub(crate) trait Host: Send + Sync + 'static {
  fn app(&self) -> &AppState;
  fn allows_cloud_jobs(&self) -> bool {
    true
  }
  /// 提出した録音の置き場を、すぐ同期する（クラウドに版ができている）。
  fn after_submit(&self, container: &ContainerRef);
  fn status_changed(&self, status: &PcRunnerStatus);
  /// ON にしたとき・ON で起動したとき（ログイン時の起動の登録とメニューバー）。ログイン時の起動を書けなければ Err。
  fn resident_on(&self, status: &PcRunnerStatus) -> std::io::Result<()>;
  /// OFF にしたとき（登録とメニューバーを外し、窓が隠れていれば出す）。
  fn resident_off(&self);
  /// 同じ保存先を開いた別の NIHO docs（別の process）が工程を実行しているか（`.run.lock` は process をまたいで見える）。
  fn other_process_running(&self) -> bool;
  /// 依頼の置き場の `.run.lock` を、依頼を終えるまで持つ（別の process の手元の実行と重ねない）。この Mac に置き場が無ければ None。
  fn lock_container(&self, container: &ContainerRef) -> Result<Option<RunLockGuard>, ContainerBusy>;
}

/// 依頼の置き場の `.run.lock`（別の process と共有する）。落とすと外す。
pub(crate) struct RunLockGuard {
  store: crate::store::Store,
  project: Option<String>,
}

impl Drop for RunLockGuard {
  fn drop(&mut self) {
    let _ = self.store.release_run_lock_at(self.project.as_deref());
  }
}

/// 別の process が依頼の置き場を実行している。
#[derive(Debug)]
pub(crate) struct ContainerBusy;

pub(crate) trait AccountGate: Send + Sync {
  /// 今のログインの session を捕まえる（ログインしていなければ None）。
  fn begin(&self) -> Option<Arc<dyn SessionToken>>;
}

struct ServiceGate(Arc<AccountService>);

impl AccountGate for ServiceGate {
  fn begin(&self) -> Option<Arc<dyn SessionToken>> {
    let ticket = self.0.session_ticket().ok()?;
    Some(Arc::new(AccountSession {
      service: self.0.clone(),
      ticket,
    }))
  }
}

struct NoAccount;

impl AccountGate for NoAccount {
  fn begin(&self) -> Option<Arc<dyn SessionToken>> {
    None
  }
}

struct TauriHost {
  app: tauri::AppHandle,
  log: LogFn,
}

impl Host for TauriHost {
  fn app(&self) -> &AppState {
    self.app.state::<AppState>().inner()
  }

  fn allows_cloud_jobs(&self) -> bool {
    self
      .app
      .try_state::<crate::cloud::Cloud>()
      .is_some_and(|cloud| cloud.allows_cloud_jobs())
  }

  fn after_submit(&self, container: &ContainerRef) {
    let Some(cloud) = self.app.try_state::<crate::cloud::Cloud>() else {
      return;
    };
    match container {
      ContainerRef::Root => cloud.sync_project_now(niho_desktop_vault::DOCS_ROOT_PROJECT_ID),
      ContainerRef::Folder { project_id } => cloud.sync_project_now(project_id),
    }
  }

  fn status_changed(&self, status: &PcRunnerStatus) {
    let _ = self.app.emit(STATE_EVENT, status);
    crate::resident::update_tray(&self.app, status);
  }

  fn resident_on(&self, status: &PcRunnerStatus) -> std::io::Result<()> {
    crate::resident::turn_on(&self.app, self.app().dev, status, &self.log)
  }

  fn resident_off(&self) {
    crate::resident::turn_off(&self.app, &self.log);
  }

  fn other_process_running(&self) -> bool {
    self.app().store().has_run_lock_of_another_process().unwrap_or(false)
  }

  fn lock_container(&self, container: &ContainerRef) -> Result<Option<RunLockGuard>, ContainerBusy> {
    let store = self.app().store();
    let project = match container {
      ContainerRef::Root => None,
      ContainerRef::Folder { project_id } => Some(project_id.clone()),
    };
    match store.acquire_run_lock_at(project.as_deref()) {
      Ok(()) => Ok(Some(RunLockGuard { store, project })),
      Err(error) if error.code == "store_busy" => Err(ContainerBusy),
      // この Mac に置き場が無い（まだ同期していない）: 重なる手元の実行も無い
      Err(_) => Ok(None),
    }
  }
}

/// 待ち時間（テストは短くする）。
#[derive(Clone, Copy, Debug)]
pub(crate) struct Timing {
  /// 依頼が無いときの受け取りの間隔。
  pub idle: Duration,
  /// 通信できないときの待ち（倍々で上限まで）。
  pub backoff_min: Duration,
  pub backoff_max: Duration,
  /// ログインが要るときに確かめ直す間隔（ログインの状態が変わればすぐ）。
  pub login_recheck: Duration,
  /// 実行中の在席（lease の延長）の間隔の上限と下限（残りの 3 分の 1 と比べる）。
  pub heartbeat_max: Duration,
  pub heartbeat_min: Duration,
  /// 成果物の上げ直し・提出のやり直しの最初の待ちと回数。
  pub retry_base: Duration,
  pub retries: u32,
  /// 止めた AI の終わりを待つ上限。
  pub stop_wait: Duration,
}

impl Default for Timing {
  fn default() -> Self {
    Self {
      idle: Duration::from_secs(20),
      backoff_min: Duration::from_secs(20),
      backoff_max: Duration::from_secs(60),
      login_recheck: Duration::from_secs(60),
      heartbeat_max: Duration::from_secs(30),
      heartbeat_min: Duration::from_secs(1),
      retry_base: Duration::from_secs(2),
      retries: 5,
      stop_wait: Duration::from_secs(15),
    }
  }
}

// ---------------------------------------------------------------------------
// 裏のループ

/// 1 件の終わり方。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum JobEnd {
  /// 提出した・失敗を届けた・サーバーが止めた（次を受け取りに行く）。
  Done,
  AuthRequired,
  SessionChanged,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Tick {
  Idle,
  Disabled,
  LocallyBusy,
  Ran(JobEnd),
  Error(ApiError),
}

#[derive(Clone, Copy)]
enum SessionEnd {
  Disabled,
  AuthRequired,
  SessionChanged,
}

enum TurnOutcome {
  Output(String),
  Failed,
  /// サーバーが止めた・ログインが変わった・lease が切れた（何も提出しない）。
  Abandoned(JobEnd),
}

/// managed state（`State<PcRunner>`）。
#[derive(Clone)]
pub struct PcRunner {
  inner: Arc<Inner>,
}

struct Inner {
  host: Arc<dyn Host>,
  account: Arc<dyn AccountGate>,
  api: PcRunnerApi,
  timing: Timing,
  log: LogFn,
  enabled: AtomicBool,
  state: Mutex<(RunnerState, Option<String>)>,
  runner_id: Mutex<Option<String>>,
  published: Mutex<Option<PcRunnerStatus>>,
  wake: Arc<Notify>,
  reregister: AtomicBool,
  toggle: tokio::sync::Mutex<()>,
}

impl PcRunner {
  pub(crate) fn new(
    host: Arc<dyn Host>,
    account: Arc<dyn AccountGate>,
    api: PcRunnerApi,
    timing: Timing,
    log: LogFn,
    enabled: bool,
  ) -> Self {
    Self {
      inner: Arc::new(Inner {
        host,
        account,
        api,
        timing,
        log,
        enabled: AtomicBool::new(enabled),
        state: Mutex::new((
          if enabled {
            RunnerState::Starting
          } else {
            RunnerState::Off
          },
          None,
        )),
        runner_id: Mutex::new(None),
        published: Mutex::new(None),
        wake: Arc::new(Notify::new()),
        reregister: AtomicBool::new(false),
        toggle: tokio::sync::Mutex::new(()),
      }),
    }
  }

  /// 起動時（`.setup`。AppState と Cloud を入れた後）。ON なら、ログイン時の起動の登録（実行ファイルの場所が変われば書き直す）と
  /// メニューバーを出してから、窓と関係なく裏のループを始める。
  pub(crate) fn start(app: &tauri::AppHandle, log: LogFn, shell_mode: ShellMode) -> Self {
    let service = app
      .try_state::<niho_desktop_account::tauri::AccountHandle>()
      .map(|handle| handle.service().clone());
    let transport: Arc<dyn PcRunnerTransport> = match ReqwestTransport::new() {
      Some(transport) => Arc::new(transport),
      None => Arc::new(NoTransport),
    };
    let (account, base): (Arc<dyn AccountGate>, String) = match &service {
      Some(service) => (
        Arc::new(ServiceGate(service.clone())),
        service.env().api_url(crate::pc_runner_api::API_PATH).to_string(),
      ),
      None => (Arc::new(NoAccount), String::new()),
    };
    let host: Arc<dyn Host> = Arc::new(TauriHost {
      app: app.clone(),
      log: log.clone(),
    });
    let allowed = shell_mode.allows_pc_runner();
    let enabled = allowed && read_enabled(&host.app().data_dir);
    let runner = Self::new(
      host,
      account,
      PcRunnerApi::new(transport, base),
      Timing::default(),
      log,
      enabled,
    );
    if allowed {
      if let Some(service) = service {
        // ログイン・ログアウト・オフラインからの戻りで、待っているループを起こす
        let wake = runner.inner.wake.clone();
        service.subscribe(move |_| wake.notify_one());
      }
    }
    if enabled && runner.inner.host.resident_on(&runner.status()).is_err() {
      runner.inner.log("pc_runner.login_item_failed", json!({}));
    }
    if allowed {
      runner.spawn_loop();
    }
    runner
  }

  pub(crate) fn spawn_loop(&self) {
    tauri::async_runtime::spawn(self.inner.clone().run_loop());
  }

  pub fn enabled(&self) -> bool {
    self.inner.enabled()
  }

  pub fn status(&self) -> PcRunnerStatus {
    self.inner.status()
  }

  /// 画面の設定を保存した（接続方式・AI の登録が変わったかもしれない）。次の待ちを起こして登録し直す。
  pub(crate) fn settings_changed(&self) {
    self.inner.reregister.store(true, Ordering::SeqCst);
    self.inner.wake.notify_one();
  }

  /// ON: NIHO にログイン済みで、登録が通ってから保存・ログイン時の起動・メニューバー・ループ。登録できなければ OFF のまま。
  /// OFF: 受け取りをやめる（実行中の 1 件は最後まで続け、その後にループが NIHO へ OFF を送る）。
  pub(crate) async fn set_enabled(&self, enabled: bool) -> CommandResult<PcRunnerStatus> {
    let inner = &self.inner;
    let _toggle = inner.toggle.lock().await;
    let data_dir = inner.host.app().data_dir.clone();
    if enabled {
      if !inner.host.allows_cloud_jobs() {
        return Err(CommandError::new(
          "pc_runner_storage_local",
          "NIHO クラウドの保存先を選ぶと使えます。",
        ));
      }
      let session = inner.account.begin().ok_or_else(not_signed_in)?;
      let ai = mac_ai(inner.host.app().settings().as_ref());
      match inner.api.register(session.as_ref(), &registration(&ai, true)).await {
        Ok(runner_id) => *lock(&inner.runner_id) = Some(runner_id),
        Err(error) => {
          inner.log("pc_runner.enable_failed", json!({ "error": error.kind() }));
          return Err(match error {
            ApiError::AuthRequired | ApiError::SessionChanged => not_signed_in(),
            ApiError::Offline => offline_error(),
            _ => failed_error(),
          });
        }
      }
      // ログイン時の起動を書けなければ ON にしない（次のログインで起動せず、スマホの依頼を受けられなくなる）
      if inner.host.resident_on(&inner.status()).is_err() {
        inner.host.resident_off();
        let _ = inner.api.register(session.as_ref(), &registration(&ai, false)).await;
        return Err(login_item_failed());
      }
      if write_enabled(&data_dir, true).is_err() {
        inner.host.resident_off();
        let _ = inner.api.register(session.as_ref(), &registration(&ai, false)).await;
        return Err(save_failed());
      }
      inner.enabled.store(true, Ordering::SeqCst);
      {
        let mut state = lock(&inner.state);
        if state.0 == RunnerState::Off {
          *state = (RunnerState::Starting, None);
        }
      }
      inner.log("pc_runner.enabled", json!({}));
    } else {
      // 保存できなければ OFF にしない（次の起動で古い ON を読み、依頼の受付と AI の実行が戻ってしまう）
      if write_enabled(&data_dir, false).is_err() {
        inner.log("pc_runner.save_failed", json!({}));
        return Err(save_failed());
      }
      inner.enabled.store(false, Ordering::SeqCst);
      {
        let mut state = lock(&inner.state);
        if state.0 != RunnerState::Running {
          *state = (RunnerState::Off, None);
        }
      }
      inner.host.resident_off();
      inner.log("pc_runner.disabled", json!({}));
    }
    inner.publish();
    inner.wake.notify_one();
    Ok(inner.status())
  }

  #[cfg(test)]
  pub(crate) async fn tick_for_tests(&self, session: &dyn SessionToken) -> Tick {
    self.inner.tick(session).await
  }

  #[cfg(test)]
  pub(crate) fn needs_reregister(&self) -> bool {
    self.inner.reregister.load(Ordering::SeqCst)
  }
}

impl Inner {
  fn enabled(&self) -> bool {
    self.enabled.load(Ordering::SeqCst)
  }

  fn log(&self, kind: &str, payload: Value) {
    (self.log)(kind, payload);
  }

  fn status(&self) -> PcRunnerStatus {
    let (state, label) = lock(&self.state).clone();
    PcRunnerStatus {
      enabled: self.enabled(),
      state,
      label,
      runner_id: lock(&self.runner_id).clone(),
    }
  }

  fn state(&self) -> RunnerState {
    lock(&self.state).0
  }

  fn set_state(&self, state: RunnerState, label: Option<String>) {
    *lock(&self.state) = (state, label);
    self.publish();
  }

  /// 変わったときだけ画面とメニューバーへ（メニューバーの更新は main thread を待つので、mutex の外で）。
  fn publish(&self) {
    let status = self.status();
    {
      let mut published = lock(&self.published);
      if published.as_ref() == Some(&status) {
        return;
      }
      *published = Some(status.clone());
    }
    self.host.status_changed(&status);
  }

  fn registration(&self, enabled: bool) -> Registration {
    registration(&mac_ai(self.host.app().settings().as_ref()), enabled)
  }

  async fn sleep_or_wake(&self, duration: Duration) {
    let _ = tokio::time::timeout(duration, self.wake.notified()).await;
  }

  async fn offline_wait(&self, backoff: &mut Duration) {
    self.set_state(RunnerState::Offline, None);
    self.sleep_or_wake(*backoff).await;
    *backoff = (*backoff * 2).min(self.timing.backoff_max);
  }

  async fn run_loop(self: Arc<Self>) {
    loop {
      if !self.enabled() {
        self.host.app().pc_gate.set(Phase::Off);
        self.set_state(RunnerState::Off, None);
        self.wake.notified().await;
        continue;
      }
      if !self.host.allows_cloud_jobs() {
        self.host.app().pc_gate.set(Phase::Off);
        self.set_state(RunnerState::StorageUnavailable, None);
        self.sleep_or_wake(Duration::from_secs(30)).await;
        continue;
      }
      self.host.app().pc_gate.set(Phase::Idle);
      let Some(session) = self.account.begin() else {
        self.set_state(RunnerState::NeedsLogin, None);
        self.sleep_or_wake(self.timing.login_recheck).await;
        continue;
      };
      if matches!(
        self.state(),
        RunnerState::Off | RunnerState::NeedsLogin | RunnerState::StorageUnavailable
      ) {
        self.set_state(RunnerState::Starting, None);
      }
      let end = self.session_loop(session.as_ref()).await;
      self.clear_runner_for_session_end(end);
      match end {
        SessionEnd::Disabled => {
          if let Err(error) = self.api.register(session.as_ref(), &self.registration(false)).await {
            self.log("pc_runner.disable_unsent", json!({ "error": error.kind() }));
          }
        }
        SessionEnd::AuthRequired => {
          self.set_state(RunnerState::NeedsLogin, None);
          self.sleep_or_wake(self.timing.login_recheck).await;
        }
        SessionEnd::SessionChanged => {}
      }
    }
  }

  async fn session_loop(&self, session: &dyn SessionToken) -> SessionEnd {
    let mut backoff = self.timing.backoff_min;
    let mut registered = false;
    loop {
      if !self.enabled() {
        return SessionEnd::Disabled;
      }
      if !self.host.allows_cloud_jobs() {
        return SessionEnd::SessionChanged;
      }
      if !session.is_current() {
        return SessionEnd::SessionChanged;
      }
      if !registered || self.reregister.swap(false, Ordering::SeqCst) {
        match self.api.register(session, &self.registration(true)).await {
          Ok(runner_id) => {
            *lock(&self.runner_id) = Some(runner_id);
            registered = true;
          }
          Err(ApiError::AuthRequired) => return SessionEnd::AuthRequired,
          Err(ApiError::SessionChanged) => return SessionEnd::SessionChanged,
          Err(error) => {
            self.log("pc_runner.register_failed", json!({ "error": error.kind() }));
            registered = false;
            self.offline_wait(&mut backoff).await;
            continue;
          }
        }
      }
      match self.tick(session).await {
        Tick::Idle => {
          backoff = self.timing.backoff_min;
          self.set_state(RunnerState::Idle, None);
          self.sleep_or_wake(self.timing.idle).await;
        }
        Tick::Ran(JobEnd::Done) => {
          // 次の依頼をすぐ受け取りに行く
          backoff = self.timing.backoff_min;
          self.set_state(RunnerState::Idle, None);
        }
        Tick::Ran(JobEnd::AuthRequired) | Tick::Error(ApiError::AuthRequired) => return SessionEnd::AuthRequired,
        Tick::Ran(JobEnd::SessionChanged) | Tick::Error(ApiError::SessionChanged) => return SessionEnd::SessionChanged,
        Tick::LocallyBusy => {
          // 手元が忙しい間は受け取らず、在席だけ送る
          match self.api.register(session, &self.registration(true)).await {
            Ok(runner_id) => {
              *lock(&self.runner_id) = Some(runner_id);
              self.set_state(RunnerState::Idle, None);
            }
            Err(ApiError::AuthRequired) => return SessionEnd::AuthRequired,
            Err(ApiError::SessionChanged) => return SessionEnd::SessionChanged,
            Err(_) => self.set_state(RunnerState::Offline, None),
          }
          self.sleep_or_wake(self.timing.idle).await;
        }
        Tick::Disabled => {
          // サーバーは OFF と見ている: 次の回で登録し直す
          registered = false;
          self.sleep_or_wake(self.timing.idle).await;
        }
        Tick::Error(error) => {
          self.log("pc_runner.claim_failed", json!({ "error": error.kind() }));
          self.offline_wait(&mut backoff).await;
        }
      }
    }
  }

  fn clear_runner_for_session_end(&self, end: SessionEnd) {
    if matches!(end, SessionEnd::AuthRequired | SessionEnd::SessionChanged) {
      *lock(&self.runner_id) = None;
    }
  }

  /// 1 回の受け取り（手元が忙しければ受け取らない）。受け取れたら最後まで実行する。
  async fn tick(&self, session: &dyn SessionToken) -> Tick {
    let app = self.host.app();
    if !self.host.allows_cloud_jobs() {
      return Tick::LocallyBusy;
    }
    // 同じ保存先を開いた別の NIHO docs（別の process）が実行している間も受け取らない
    if self.host.other_process_running() || !begin_claim(app) {
      return Tick::LocallyBusy;
    }
    let _phase = PhaseReset(&app.pc_gate);
    match self.api.claim(session).await {
      Ok(Claim::Leased(job)) => {
        // 受け取りを待つ間に OFF にされたら、AI へ送らずに返す（OFF の後に新しい外部送信を始めない）
        if !self.enabled() {
          self.fail(session, &job, FailReason::NotSent).await;
          return Tick::Ran(JobEnd::Done);
        }
        app.pc_gate.set(Phase::Running);
        self.set_state(RunnerState::Running, Some(job.step.label.clone()));
        self.log(
          "pc_runner.job_started",
          json!({ "kind": match job.step.kind { StepKind::Revision => "revision", StepKind::Insight => "insight" } }),
        );
        let end = self.run_job(session, &job).await;
        self.log("pc_runner.job_finished", json!({ "end": format!("{end:?}") }));
        Tick::Ran(end)
      }
      Ok(Claim::Idle | Claim::Busy) => Tick::Idle,
      Ok(Claim::Disabled) => Tick::Disabled,
      Err(error) => Tick::Error(error),
    }
  }

  async fn fail(&self, session: &dyn SessionToken, job: &LeasedJob, reason: FailReason) {
    if let Err(error) = self.api.fail(session, job, reason).await {
      self.log(
        "pc_runner.fail_unsent",
        json!({ "reason": reason, "error": error.kind() }),
      );
    }
  }

  /// AI へ送る前の失敗（409・413 はサーバーがもう止めた。ほかは「送っていない」を届ける）。
  async fn before_dispatch(&self, session: &dyn SessionToken, job: &LeasedJob, error: ApiError) -> JobEnd {
    self.log(
      "pc_runner.before_dispatch_failed",
      json!({ "error": error.kind(), "status": error.status() }),
    );
    match error {
      ApiError::AuthRequired => JobEnd::AuthRequired,
      ApiError::SessionChanged => JobEnd::SessionChanged,
      ApiError::Rejected { status: 409 | 413, .. } => {
        if error.reason() == Some("pc_provider_not_registered") {
          self.reregister.store(true, Ordering::SeqCst);
        }
        JobEnd::Done
      }
      _ => {
        self.fail(session, job, FailReason::NotSent).await;
        JobEnd::Done
      }
    }
  }

  async fn run_job(&self, session: &dyn SessionToken, job: &LeasedJob) -> JobEnd {
    let app = self.host.app();
    let ai = mac_ai(app.settings().as_ref());
    let Some(resolved) = resolve_model(&ai, &job.step) else {
      self.fail(session, job, FailReason::ProviderNotReady).await;
      return JobEnd::Done;
    };
    let runner = app.runner.clone();
    let contract = resolved.contract;
    let status = tauri::async_runtime::spawn_blocking(move || runner.provider_status(contract))
      .await
      .ok();
    if !status.is_some_and(|status| provider_ready(ai.connection, &status)) {
      self.fail(session, job, FailReason::ProviderNotReady).await;
      return JobEnd::Done;
    }
    // 依頼の置き場の実行のロックを、終えるまで持つ（同じ保存先を開いた別の process の手元の実行と重ねない）
    let _container_lock = match self.host.lock_container(&job.container) {
      Ok(guard) => guard,
      Err(ContainerBusy) => {
        self.fail(session, job, FailReason::NotSent).await;
        return JobEnd::Done;
      }
    };
    let prompt = match self.api.prompt(session, job, &resolved.choice).await {
      Ok(prompt) => prompt,
      Err(error) => return self.before_dispatch(session, job, error).await,
    };
    if prompt.system_prompt.len() > MAX_SYSTEM_PROMPT_BYTES || prompt.user_prompt.len() > MAX_USER_PROMPT_BYTES {
      self.fail(session, job, FailReason::NotSent).await;
      return JobEnd::Done;
    }
    // 空の作業フォルダ（終わったら消す）
    let workdir = app.data_dir.join("workspaces").join(format!("pc-{}", job.attempt_id));
    let _ = std::fs::remove_dir_all(&workdir);
    if std::fs::create_dir_all(&workdir).is_err() {
      self.fail(session, job, FailReason::NotSent).await;
      return JobEnd::Done;
    }
    let _cleanup = RemoveOnDrop(workdir.clone());
    if !session.is_current() {
      return JobEnd::SessionChanged;
    }
    // AI へ渡す直前に NIHO へ「送る」と届ける（これより後は AI を自動でやり直さない）
    if let Err(error) = self.api.dispatch(session, job).await {
      return self.before_dispatch(session, job, error).await;
    }
    // dispatch を待つ間にログアウト・別のアカウントへの切り替えがあれば、前の本人の prompt を AI へ送らない
    if !session.is_current() {
      return JobEnd::SessionChanged;
    }
    let request = TurnRequest {
      provider: resolved.contract,
      model: resolved.choice.model.clone(),
      effort: resolved.request_effort,
      system_prompt: prompt.system_prompt,
      user_prompt: prompt.user_prompt,
      resume_session: None,
      workdir,
      timeout: crate::turn_time_limit(),
      max_budget_usd: None,
      tool_policy: ToolPolicy::None,
    };
    let mut lease_until = job.lease_until;
    match self.drive_turn(session, job, request, &mut lease_until).await {
      TurnOutcome::Output(text) => {
        self
          .deliver(session, job, prompt.max_output_bytes, text, lease_until)
          .await
      }
      TurnOutcome::Failed => {
        self.fail(session, job, FailReason::ProviderFailed).await;
        JobEnd::Done
      }
      TurnOutcome::Abandoned(end) => end,
    }
  }

  fn heartbeat_wait(&self, lease_until: DateTime<Utc>) -> Duration {
    let remaining = (lease_until - Utc::now()).to_std().unwrap_or(Duration::ZERO);
    (remaining / 3)
      .min(self.timing.heartbeat_max)
      .max(self.timing.heartbeat_min)
  }

  /// AI の 1 回を流し、実行中は在席を送る。サーバーが止めた（409）・ログインが変わった・lease が切れたら AI を止める。
  async fn drive_turn(
    &self,
    session: &dyn SessionToken,
    job: &LeasedJob,
    request: TurnRequest,
    lease_until: &mut DateTime<Utc>,
  ) -> TurnOutcome {
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<TurnEvent>();
    let handle = self.host.app().runner.run_turn(
      request,
      Box::new(move |event| {
        if event.is_terminal() {
          let _ = sender.send(event);
        }
      }),
    );
    loop {
      let wait = self.heartbeat_wait(*lease_until);
      let event = match tokio::time::timeout(wait, receiver.recv()).await {
        Ok(event) => event,
        Err(_) => {
          let abandon = if !session.is_current() {
            Some(JobEnd::SessionChanged)
          } else {
            match self.api.heartbeat(session, job).await {
              Ok(until) => {
                *lease_until = until;
                None
              }
              Err(ApiError::AuthRequired) => Some(JobEnd::AuthRequired),
              Err(ApiError::SessionChanged) => Some(JobEnd::SessionChanged),
              Err(error) if error.status() == Some(409) => Some(JobEnd::Done),
              Err(error) => {
                self.log("pc_runner.heartbeat_failed", json!({ "error": error.kind() }));
                (Utc::now() > *lease_until).then_some(JobEnd::Done)
              }
            }
          };
          if let Some(end) = abandon {
            handle.stop();
            let _ = tokio::time::timeout(self.timing.stop_wait, receiver.recv()).await;
            return TurnOutcome::Abandoned(end);
          }
          continue;
        }
      };
      return match event {
        // 出し切ったときだけ成果物にする（出力の上限で止まった途中までの本文は公開しない）
        Some(TurnEvent::Done { text, stop_reason, .. }) if stop_reason == StopReason::EndTurn => {
          TurnOutcome::Output(text)
        }
        _ => TurnOutcome::Failed,
      };
    }
  }

  /// lease を延ばす（成果物の上げ直し・提出の前）。409 は止める、通信の失敗はそのまま進む。
  async fn keep_lease(
    &self,
    session: &dyn SessionToken,
    job: &LeasedJob,
    lease_until: &mut DateTime<Utc>,
  ) -> Result<(), JobEnd> {
    match self.api.heartbeat(session, job).await {
      Ok(until) => {
        *lease_until = until;
        Ok(())
      }
      Err(ApiError::AuthRequired) => Err(JobEnd::AuthRequired),
      Err(ApiError::SessionChanged) => Err(JobEnd::SessionChanged),
      Err(error) if error.status() == Some(409) => Err(JobEnd::Done),
      Err(_) => Ok(()),
    }
  }

  fn retry_wait(&self, attempt: u32) -> Duration {
    self.timing.retry_base * 2u32.saturating_pow(attempt.saturating_sub(1).min(5))
  }

  /// 成果物を候補として上げて、提出する（提出は同じ候補の id で、通信の失敗だけやり直す）。
  async fn deliver(
    &self,
    session: &dyn SessionToken,
    job: &LeasedJob,
    max_output_bytes: usize,
    text: String,
    mut lease_until: DateTime<Utc>,
  ) -> JobEnd {
    let bytes = text.into_bytes();
    if bytes.is_empty() || bytes.len() > max_output_bytes || bytes.len() > MAX_CANDIDATE_BYTES {
      self.fail(session, job, FailReason::ProviderFailed).await;
      return JobEnd::Done;
    }
    let mut candidate_id: Option<String> = None;
    let mut uploaded = false;
    for attempt in 0..self.timing.retries {
      if attempt > 0 {
        tokio::time::sleep(self.retry_wait(attempt)).await;
        if let Err(end) = self.keep_lease(session, job, &mut lease_until).await {
          return end;
        }
      }
      let candidate = match self
        .api
        .candidate(session, job, bytes.len(), candidate_id.as_deref())
        .await
      {
        Ok(candidate) => candidate,
        Err(ApiError::AuthRequired) => return JobEnd::AuthRequired,
        Err(ApiError::SessionChanged) => return JobEnd::SessionChanged,
        Err(ApiError::Rejected { .. }) => return JobEnd::Done,
        Err(error) => {
          self.log("pc_runner.candidate_failed", json!({ "error": error.kind() }));
          continue;
        }
      };
      candidate_id = Some(candidate.candidate_id.clone());
      match self.api.upload(&candidate, &bytes).await {
        Ok(_) => {
          uploaded = true;
          break;
        }
        Err(error) => self.log("pc_runner.upload_failed", json!({ "error": error.kind() })),
      }
    }
    let (true, Some(candidate_id)) = (uploaded, candidate_id) else {
      return JobEnd::Done;
    };
    for attempt in 0..self.timing.retries {
      if attempt > 0 {
        tokio::time::sleep(self.retry_wait(attempt)).await;
      }
      match self.api.submit(session, job, &candidate_id).await {
        Ok(()) => {
          self.host.after_submit(&job.container);
          return JobEnd::Done;
        }
        Err(ApiError::AuthRequired) => return JobEnd::AuthRequired,
        Err(ApiError::SessionChanged) => return JobEnd::SessionChanged,
        Err(ApiError::Rejected { .. }) => return JobEnd::Done,
        Err(error) => self.log("pc_runner.submit_failed", json!({ "error": error.kind() })),
      }
    }
    JobEnd::Done
  }
}

fn not_signed_in() -> CommandError {
  CommandError::new("pc_runner_not_signed_in", "NIHO アカウントでログインすると使えます")
}

fn offline_error() -> CommandError {
  CommandError::new(
    "pc_runner_offline",
    "NIHO に接続できません。接続を確かめてから、もう一度お試しください。",
  )
}

fn failed_error() -> CommandError {
  CommandError::new(
    "pc_runner_failed",
    "うまくいきませんでした。時間をおいてもう一度お試しください。",
  )
}

fn login_item_failed() -> CommandError {
  CommandError::new(
    "pc_runner_login_item_failed",
    "ログイン時に起動する設定を保存できませんでした。もう一度お試しください。",
  )
}

fn save_failed() -> CommandError {
  CommandError::new(
    "pc_runner_save_failed",
    "設定を保存できませんでした。もう一度お試しください。",
  )
}

// ---------------------------------------------------------------------------
// commands

#[tauri::command]
pub async fn pc_runner_status(runner: State<'_, PcRunner>) -> CommandResult<PcRunnerStatus> {
  Ok(runner.status())
}

#[tauri::command]
pub async fn pc_runner_set_enabled(runner: State<'_, PcRunner>, enabled: bool) -> CommandResult<PcRunnerStatus> {
  runner.set_enabled(enabled).await
}

#[cfg(test)]
#[path = "pc_runner_tests.rs"]
mod tests;
