//! NIHO docs の Tauri 側（薄い adapter）。specs/initiatives/niho-docs.md §3・§4・§6。
//!
//! - 案件フォルダの読み書き（store.rs）
//! - お手本の文書の取り込み（samples.rs。.md・.txt・.docx・.pdf から本文を抽出して flows/samples/ に保存する）
//! - CLI 実行基盤の呼び出し（contract.rs の `LlmRunner`。本番は local_ai.rs の S1-B の crate `niho-local-ai` の adapter）
//! - 文字起こし sidecar の呼び出し（speech.rs。S1-C の niho-speech。開発ビルドだけ、本物が無ければ固定の JSONL を返す偽物）
//! - 録音（recording.rs。#18590。同じ sidecar の `record` で app data の recordings/ に録り、止めたら案件の音声に足す。
//!   録音中に窓を閉じようとしたら閉じずに画面へ知らせる（`recording-close-requested`）
//! - Gemini（サブスクリプション＝Antigravity CLI）の文字起こし（S2a #18383）: 音声を区切りの WAV にして（`prepare_audio`・
//!   区切りごとに `transcribe_audio_part` が `slice`）、crate の `ToolPolicy::ReadFile` で agy に読ませる。指示文と結合は画面側
//! - API キー方式（S2b #18383。api_ai.rs）: 鍵は app data の api-keys/ だけ（secrets.rs。画面へは返さない。#18769）。工程は crate
//!   `niho-api-ai` で Anthropic・OpenAI・Gemini の API を呼ぶ（`ProviderRouter` が CLI と振り分ける）。文字起こしは Gemini API
//!   （`transcribe_audio_part` の区切りの WAV を Files API に上げて添える）と Deepgram（`transcribe_deepgram`）
//! - ファイルの選択・書き出し・Finder で表示・コピー
//! - 自動更新（updater.rs。S4 #18385。起動時と 1 時間ごとに確かめて取得し、終わるときに差し替える。画面の「更新して再起動」か次に開いたときに新しい版になる）
//!
//! 画面（apps/docs/src）は Tauri の command だけを呼ぶ。パスは画面から受け取らず、案件・ページ・録音・工程・実行の id で指す
//! （音声とお手本の文書の元のファイルだけは、選択・ドロップで画面に渡ったパスを受け取る。音声は録音の inputs/ に写し、
//! お手本の文書は本文を抽出して flows/samples/ に保存する）。工程の成果物・版・記録・会話は録音ごと（今の案件は
//! 案件フォルダ直下が録音 `root`）、実行のロックは案件ごと。

mod api_ai;
// NIHO クラウドの保管庫（C3 #18595。保存の口・同期 engine・競合・lease・移行）
mod cloud;
mod contract;
mod conversation;
mod docs_closing;
mod docs_reopening;
mod docs_storage_api;
mod google_docs;
mod local_ai;
// この Mac で続きを受ける（#18804 S2。スマホで「自分の Mac で続ける」を選んだ後続工程を裏で受けて実行する）
mod pc_runner;
mod pc_runner_api;
// 本人 Mac 実行（R6 #18739）の Native の境界（operation・guard・intent・候補と原子公開）
mod personal_run;
mod process;
mod recording;
// 「この Mac で続きを受ける」の常駐（メニューバー・窓を閉じても続ける・Mac へのログイン時の起動）
mod resident;
mod sample_url;
mod samples;
mod secrets;
mod shell;
mod shell_ai;
#[cfg(target_os = "macos")]
mod single_instance;
mod speech;
mod staging;
mod store;
mod updater;

use base64::Engine;
use contract::{
  ClaudeUpdate, Effort, LlmRunner, MaintenanceError, Provider, ProviderStatus, ProviderUsage, TurnHandle, TurnRequest,
};
use recording::{Recorder, RecordingError, RecordingInfo};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use speech::{SpeechError, SpeechJob};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use store::{
  FlowList, FlowSample, LoadedPages, LoadedProject, LoadedRecording, ProjectEntry, RecentId, Store, StoreError,
};
use tauri::ipc::Channel;
use tauri::{Emitter, Manager, State};

/// 1 回の依頼の時間の上限。crate が同じ実行の中で頼む続き（最大 3 回）も含むので、3〜5 万字の変換を見込んで
/// 45 分にする（Desktop の記事エージェントの 20 分は会話向け。spec §6.1）。開発で試すときだけ環境変数で縮められる。
const TURN_TIME_LIMIT: Duration = Duration::from_secs(45 * 60);
const TURN_TIME_LIMIT_ENV: &str = "NIHO_DOCS_TURN_TIMEOUT_SECS";
const DOCS_ROOT_ENV: &str = "NIHO_DOCS_ROOT";
const DATA_DIR_ENV: &str = "NIHO_DOCS_DATA_DIR";
/// 開発・試験の起動の保存先の既定（~/Documents の下。本番は「NIHO docs」）。
const DEV_DOCS_ROOT_NAME: &str = "NIHO docs dev";
/// 開発・試験の起動の窓の題名（本番の窓と取り違えないため）。
const DEV_WINDOW_TITLE: &str = "NIHO editor（開発版）";
const MAX_SYSTEM_PROMPT_BYTES: usize = 400_000;
const MAX_USER_PROMPT_BYTES: usize = 8 * 1024 * 1024;
/// CLI の会話ごとの workspace を残す時間（続きの `--resume` に要る間だけ）。
const WORKSPACE_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);
/// Gemini の文字起こしの区切りの WAV を置く場所（app data の下・文字起こしごと。終わったら消す）。
const AUDIO_PARTS_DIR: &str = "speech-parts";
/// 区切り 1 つ（目安 15 分・最長でも 17 分ほど）の文字起こしの時間の上限（S0 #18381 の実測は 15 分で 70〜100 秒）。
const AUDIO_PART_TIME_LIMIT: Duration = Duration::from_secs(20 * 60);
/// 録音中に窓を閉じようとしたときに画面へ送るイベント（画面が確かめてから `close_after_recording`）。
const RECORDING_CLOSE_EVENT: &str = "recording-close-requested";
/// 録音を止めて窓を閉じるとき・アプリを終えるときに、書き出しを待つ上限（6 時間の録音で 30 秒ほど。超えても sidecar は
/// 書き出しを続け、次に開いたときに「前回の録音」になる）。
const RECORDING_CLOSE_WAIT: Duration = Duration::from_secs(2 * 60);
const RECORDING_EXIT_WAIT: Duration = Duration::from_secs(30);
use store::AUDIO_EXTENSIONS;
/// フォルダ外の録音の実行のロック鍵（同期・lease では予約の docs-root に写す。cloud.rs）。
pub(crate) const OUTSIDE_LOCK_KEY: &str = "_outside";

#[derive(Debug, Clone, Serialize)]
pub struct CommandError {
  code: String,
  message: String,
  /// 画面が文を組み立てるための数（フォルダの書き出しの上限を超えた数など）。利用者の本文・token・サーバーの本文は入れない。
  #[serde(skip_serializing_if = "Option::is_none")]
  details: Option<Value>,
}

impl CommandError {
  fn new(code: &str, message: &str) -> Self {
    Self {
      code: code.to_string(),
      message: message.to_string(),
      details: None,
    }
  }

  fn with_details(mut self, details: Value) -> Self {
    self.details = Some(details);
    self
  }
}

impl From<StoreError> for CommandError {
  fn from(error: StoreError) -> Self {
    Self {
      code: error.code,
      message: error.message,
      details: None,
    }
  }
}

impl From<SpeechError> for CommandError {
  fn from(error: SpeechError) -> Self {
    Self::new(error.code(), error.message())
  }
}

impl From<RecordingError> for CommandError {
  fn from(error: RecordingError) -> Self {
    Self::new(error.code(), error.message())
  }
}

impl From<MaintenanceError> for CommandError {
  fn from(error: MaintenanceError) -> Self {
    Self {
      code: error.code,
      message: error.message,
      details: None,
    }
  }
}

type CommandResult<T> = Result<T, CommandError>;

pub struct AppState {
  runner: Arc<dyn LlmRunner>,
  turns: Mutex<HashMap<String, Arc<dyn TurnHandle>>>,
  speech_jobs: Mutex<HashMap<String, Arc<SpeechJob>>>,
  /// この窓が実行のロックを持っている案件（終了時に放す）。
  run_locks: Mutex<HashSet<String>>,
  /// Gemini の文字起こしの準備（文字起こしの job id → 変換した WAV と区切りの境目）。
  audio_jobs: Mutex<HashMap<String, Arc<PreparedAudio>>>,
  /// API キー方式（鍵・Deepgram）。工程の実行は `runner`（ProviderRouter）から。
  api: Arc<api_ai::ApiAiRunner>,
  /// Deepgram の文字起こし（job id → 止める合図）。
  deepgram_jobs: Mutex<HashMap<String, Arc<niho_api_ai::StopSignal>>>,
  /// 録音（同時に 1 本。app data の recordings/）。
  recorder: Arc<Recorder>,
  /// 本人 Mac 実行の operation（handle → 捕捉した Store・ロック・lease。personal_run.rs）。
  personal_ops: personal_run::Operations,
  /// 「この Mac で続きを受ける」の段階（受け取りに行っている・実行している間は手元の実行を断る。pc_runner.rs）。
  pc_gate: pc_runner::Gate,
  data_dir: PathBuf,
  /// 開発・試験の起動（`is_dev_launch`）。保存先の既定を本番と分ける。
  dev: bool,
}

/// Gemini の文字起こしのために変換した音声（`speech-parts/<job id>/`）。
struct PreparedAudio {
  dir: PathBuf,
  files: Vec<speech::PreparedFile>,
  /// 本人 Mac 実行の operation で準備したときの handle。その operation でだけ使え、operation なしでは使えない
  /// （operation を閉じた後も、ここに残る限り断る）。閉じるときに WAV ごと消す（personal_run.rs）。
  owner: Option<String>,
}

impl AppState {
  fn settings_path(&self) -> PathBuf {
    self.data_dir.join("settings.json")
  }

  fn settings(&self) -> Option<Value> {
    std::fs::read_to_string(self.settings_path())
      .ok()
      .and_then(|text| serde_json::from_str(&text).ok())
  }

  /// 保存先: 環境変数（開発・テスト）→ 設定の保存先 → ~/Documents/NIHO docs（開発・試験の起動は ~/Documents/NIHO docs dev）。
  fn docs_root(&self) -> PathBuf {
    if let Ok(root) = std::env::var(DOCS_ROOT_ENV) {
      if !root.trim().is_empty() {
        return PathBuf::from(root.trim());
      }
    }
    if let Some(root) = self
      .settings()
      .and_then(|settings| settings.get("docsRoot").and_then(Value::as_str).map(str::to_string))
      .filter(|root| Path::new(root).is_absolute())
    {
      return PathBuf::from(root);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    default_docs_root(Path::new(&home), self.dev)
  }

  fn store(&self) -> Store {
    Store::new(self.docs_root())
  }
}

/// テスト（personal_run_tests.rs）の AppState（偽の runner・Keychain を使わない API キー方式）。
#[cfg(test)]
impl AppState {
  pub(crate) fn for_tests(runner: Arc<dyn LlmRunner>, data_dir: PathBuf) -> Self {
    Self {
      runner,
      turns: Mutex::new(HashMap::new()),
      speech_jobs: Mutex::new(HashMap::new()),
      run_locks: Mutex::new(HashSet::new()),
      audio_jobs: Mutex::new(HashMap::new()),
      api: Arc::new(api_ai::ApiAiRunner::new(
        niho_api_ai::Config {
          endpoints: niho_api_ai::Endpoints::default(),
          log: None,
        },
        Arc::new(secrets::MemoryStore::default()),
      )),
      deepgram_jobs: Mutex::new(HashMap::new()),
      recorder: Arc::new(Recorder::new(data_dir.join(recording::RECORDINGS_DIR))),
      personal_ops: Mutex::new(HashMap::new()),
      pc_gate: pc_runner::Gate::default(),
      data_dir,
      dev: true,
    }
  }
}

fn safe_id(value: &str) -> CommandResult<()> {
  let ok = !value.is_empty()
    && value.len() <= 64
    && value
      .chars()
      .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
  if ok {
    Ok(())
  } else {
    Err(CommandError::new("bad_id", "依頼の id が正しくありません。"))
  }
}

// ---------------------------------------------------------------------------
// 設定・フロー・案件

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppPaths {
  docs_root: String,
  data_dir: String,
}

#[tauri::command]
async fn app_paths(state: State<'_, AppState>) -> CommandResult<AppPaths> {
  Ok(AppPaths {
    docs_root: state.docs_root().to_string_lossy().into_owned(),
    data_dir: state.data_dir.to_string_lossy().into_owned(),
  })
}

#[tauri::command]
async fn load_settings(state: State<'_, AppState>) -> CommandResult<Option<Value>> {
  Ok(state.settings())
}

#[tauri::command]
async fn save_settings(
  state: State<'_, AppState>,
  cloud: State<'_, cloud::Cloud>,
  pc_runner: State<'_, pc_runner::PcRunner>,
  settings: Value,
) -> CommandResult<()> {
  let root_before = state.docs_root();
  let mut root_change = None;
  // 実行のロックの mutex は `.await` の前に放す（保存先を変えた後の保管庫の付け替えは待つ）
  {
    let run_locks = state
      .run_locks
      .lock()
      .map_err(|_| CommandError::new("run_lock", "実行状態を確認できませんでした。"))?;
    let current_root = state
      .settings()
      .and_then(|value| value.get("docsRoot").and_then(Value::as_str).map(PathBuf::from));
    let next_root = settings.get("docsRoot").and_then(Value::as_str).map(PathBuf::from);
    if current_root != next_root && (!run_locks.is_empty() || state.store().has_active_run_lock()?) {
      return Err(CommandError::new(
        "store_busy",
        "実行が終わってから保存先を変更してください。",
      ));
    }
    // NIHO クラウドに送っていない変更があるうちは保存先を変えない（C3 #18595）
    if current_root != next_root {
      let next_root = next_root
        .filter(|root| root.is_absolute())
        .ok_or_else(|| CommandError::new("settings_root", "保存先を選び直してください。"))?;
      cloud.check_root_change()?;
      root_change = Some(next_root);
    }
    // 接続方式（サブスクリプション／API キー）は実行中（工程・会話・文字起こし）には切り替えない（S2b #18383）
    let current_connection = state
      .settings()
      .and_then(|value| value.get("connection").and_then(Value::as_str).map(str::to_string))
      .unwrap_or_else(|| "subscription".into());
    let next_connection = settings
      .get("connection")
      .and_then(Value::as_str)
      .unwrap_or("subscription");
    if current_connection != next_connection && busy_running(&state, &run_locks)? {
      return Err(CommandError::new(
        "connection_busy",
        "実行が終わってから接続方式を切り替えてください。",
      ));
    }
    // vault（保存先・この Mac の名前）は保存先の command だけが書く（ディスクのものを保つ）。一時ファイル → rename
    if root_change.is_none() {
      cloud::save_window_settings(&state.data_dir, settings.clone())?;
    }
  }
  if let Some(root_after) = root_change {
    let data_dir = state.data_dir.clone();
    cloud
      .commit_root_change(&root_after, move || cloud::save_window_settings(&data_dir, settings))
      .await?;
  } else if state.docs_root() != root_before {
    return Err(CommandError::new(
      "store_context_changed",
      "保存先が変わりました。もう一度お試しください。",
    ));
  }
  // 接続方式・AI の登録が変わったかもしれない: 「この Mac で続きを受ける」の登録をし直す（ON のときだけ通信する）
  pc_runner.settings_changed();
  Ok(())
}

/// 工程・会話・文字起こしのどれかが動いているか（この窓のロック・他の窓のロック・実行中の依頼・文字起こしの job・
/// スマホから受けた工程〔pc_runner.rs〕）。
fn busy_running(state: &AppState, run_locks: &HashSet<String>) -> CommandResult<bool> {
  let turns = state.turns.lock().map(|turns| !turns.is_empty()).unwrap_or(true);
  let speech = state.speech_jobs.lock().map(|jobs| !jobs.is_empty()).unwrap_or(true);
  let deepgram = state.deepgram_jobs.lock().map(|jobs| !jobs.is_empty()).unwrap_or(true);
  Ok(
    !run_locks.is_empty()
      || turns
      || speech
      || deepgram
      || state.pc_gate.blocks_local_runs()
      || state.runner.has_running_turns()
      || state.store().has_active_run_lock()?,
  )
}

/// 画面の「更新して再起動」（updater.rs）。最新公開版を確認・取得して開き直す（`.app` の差し替えは終わるときの `RunEvent::Exit` で、
/// 工程・文字起こしを止めた後）。工程・会話・文字起こしが動いている間は `busy` を返し、画面が確かめてから `force` で頼み直す
/// （止める処理は終了時の `stop_everything` と同じ）。別の NIHO docs が工程を実行している間は、この窓からは止められないので
/// `otherAppRunning` を返し、`force` でも開き直さない。
#[tauri::command]
async fn restart_to_update(
  app: tauri::AppHandle,
  state: State<'_, AppState>,
  update: State<'_, updater::UpdateState>,
  force: bool,
) -> CommandResult<updater::RestartOutcome> {
  let outcome = updater::prepare_restart(
    || update_restart_outcome(&state, &update, force),
    || updater::refresh_for_restart(&app),
  )
  .await?;
  if outcome == updater::RestartOutcome::Restarting {
    // RunEvent::Exit（stop_everything の後で .app を差し替える）を通ってから、新しい版で開き直す
    app.request_restart();
  }
  Ok(outcome)
}

fn update_restart_outcome(
  state: &AppState,
  update: &updater::UpdateState,
  force: bool,
) -> CommandResult<updater::RestartOutcome> {
  let staged = update.staged_version().is_some();
  let other_app_running = staged && state.store().has_run_lock_of_another_process()?;
  let busy = if staged && !other_app_running && !force {
    let run_locks = state
      .run_locks
      .lock()
      .map_err(|_| CommandError::new("run_lock", "実行状態を確認できませんでした。"))?;
    // 録音も止めずに開き直さない（止めると、そこまでを保存して「前回の録音」になる）
    busy_running(state, &run_locks)? || state.recorder.is_recording()
  } else {
    false
  };
  Ok(updater::restart_outcome(staged, other_app_running, busy, force))
}

/// 常駐中の自動更新（#18823）の最初の確認（起動から。差し替えに失敗し続けても再起動を繰り返さない間隔）と、その後の間隔。
const IDLE_RESTART_FIRST_CHECK: Duration = Duration::from_secs(30 * 60);
const IDLE_RESTART_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// 「この Mac で続きを受ける」で常駐している間は、窓を隠していて何も動いていないときに、取得した新しい版へ自動で再起動する
/// （#18823・owner 2026-10-17）。窓が見えている・OFF のときは今までどおり（「更新して再起動」か、終わるときの差し替え）。
fn spawn_idle_update_restart(app: tauri::AppHandle, log: pc_runner::LogFn) {
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(IDLE_RESTART_FIRST_CHECK).await;
    loop {
      restart_if_idle(&app, &log).await;
      tokio::time::sleep(IDLE_RESTART_INTERVAL).await;
    }
  });
}

async fn restart_if_idle(app: &tauri::AppHandle, log: &pc_runner::LogFn) {
  let (Some(state), Some(update), Some(pc)) = (
    app.try_state::<AppState>(),
    app.try_state::<updater::UpdateState>(),
    app.try_state::<pc_runner::PcRunner>(),
  ) else {
    return;
  };
  let staged = update.staged_version().is_some();
  if !resident::idle_restart_wanted(pc.enabled(), staged, resident::main_window_visible(app)) {
    return;
  }
  // 確かめている間はスマホからの依頼を受け取りに行かない（実行のロックの mutex の中で、何も動いていなければ止める）
  if !matches!(pause_runner_if_idle(&state), Ok(true)) {
    return;
  }
  // 「更新して再起動」と同じく、通信の前後で確かめ、その時点の最新公開版を取得してから（force は使わない）
  let outcome = updater::prepare_restart(
    || update_restart_outcome(&state, &update, false),
    || updater::refresh_for_restart(app),
  )
  .await;
  let still_hidden = pc.enabled() && !resident::main_window_visible(app);
  if still_hidden && matches!(outcome, Ok(updater::RestartOutcome::Restarting)) {
    log(
      "auto_update.idle_restart",
      serde_json::json!({ "latestVersion": update.staged_version() }),
    );
    // RunEvent::Exit（止める処理の後で .app を差し替える）を通ってから、窓を出さずに新しい版で起動し直す
    resident::request_background_relaunch();
    app.exit(0);
    return;
  }
  state.pc_gate.resume();
}

/// 何も動いていなければ（録音も含む）、スマホからの依頼の受け取りを止めて true（`begin_claim` と同じ mutex の中で決める）。
fn pause_runner_if_idle(state: &AppState) -> CommandResult<bool> {
  let run_locks = state
    .run_locks
    .lock()
    .map_err(|_| CommandError::new("run_lock", "実行状態を確認できませんでした。"))?;
  if busy_running(state, &run_locks)? || state.recorder.is_recording() {
    return Ok(false);
  }
  state.pc_gate.pause();
  Ok(true)
}

/// 工程（フロー）の一覧（P4 #18567。flows/index.json の並びと最後に使ったフロー。P4 より前の flows/active.json は 1 本目として読む）。
#[tauri::command]
async fn list_flows(state: State<'_, AppState>) -> CommandResult<FlowList> {
  Ok(state.store().list_flows()?)
}

/// フローを保存する（flows/<id>.json。並びに無ければ末尾に足す）。
#[tauri::command]
async fn save_flow(state: State<'_, AppState>, flow: Value) -> CommandResult<()> {
  Ok(state.store().save_flow(&flow)?)
}

/// フローを複製する（画面が作った写しを書き、お手本の本文を写し、並びの元の直後に入れる）。
#[tauri::command]
async fn duplicate_flow(state: State<'_, AppState>, source_id: String, flow: Value) -> CommandResult<()> {
  Ok(state.store().duplicate_flow(&source_id, &flow)?)
}

/// フローを消す（ファイルとお手本の本文。使っている録音は自分の snapshot で実行できる）。
#[tauri::command]
async fn delete_flow(state: State<'_, AppState>, flow_id: String) -> CommandResult<()> {
  Ok(state.store().delete_flow(&flow_id)?)
}

/// 最後に使ったフロー（新しい録音のページの既定）を変える。
#[tauri::command]
async fn set_last_used_flow(state: State<'_, AppState>, flow_id: String) -> CommandResult<()> {
  Ok(state.store().set_last_used_flow(&flow_id)?)
}

/// そのフローから作った録音の数（フローの削除の確かめに出す）。
#[tauri::command]
async fn flow_usage(state: State<'_, AppState>, flow_id: String) -> CommandResult<usize> {
  let store = state.store();
  tauri::async_runtime::spawn_blocking(move || store.flow_usage(&flow_id))
    .await
    .map_err(|_| CommandError::new("store_io", "工程を使っている録音を数えられませんでした。"))?
    .map_err(CommandError::from)
}

/// 「あなたについて」（保存先の about.json。無ければ null）。
#[tauri::command]
async fn load_about(state: State<'_, AppState>) -> CommandResult<Option<Value>> {
  Ok(state.store().load_about()?)
}

#[tauri::command]
async fn save_about(state: State<'_, AppState>, about: Value) -> CommandResult<()> {
  Ok(state.store().save_about(&about)?)
}

/// 本人共通の実行先（保存先の execution.json。無ければ null）。
#[tauri::command]
async fn load_execution(state: State<'_, AppState>) -> CommandResult<Option<Value>> {
  Ok(state.store().load_execution()?)
}

#[tauri::command]
async fn save_execution(state: State<'_, AppState>, execution: Value) -> CommandResult<()> {
  Ok(state.store().save_execution(&execution)?)
}

/// お手本の文書の取り込みの結果（ファイルごと。取り込めたら sample、駄目なら error）。画面の `SampleImport`。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SampleImportResult {
  /// 元のファイル名（表示用）。
  name: String,
  sample: Option<FlowSample>,
  error: Option<CommandError>,
}

/// お手本の文書を取り込む（本文を抽出して flows/samples/<flowId>/ に保存する）。paths の順に 1 件ずつ、1 件の失敗で止めない。
#[tauri::command]
async fn import_samples(
  state: State<'_, AppState>,
  flow_id: String,
  paths: Vec<String>,
) -> CommandResult<Vec<SampleImportResult>> {
  store::validate_id(&flow_id)?;
  let store = state.store();
  tauri::async_runtime::spawn_blocking(move || {
    paths
      .into_iter()
      .map(PathBuf::from)
      .map(|path| {
        let name = samples::display_name(&path);
        match store.import_sample(&flow_id, &path) {
          Ok(sample) => SampleImportResult {
            name,
            sample: Some(sample),
            error: None,
          },
          Err(error) => SampleImportResult {
            name,
            sample: None,
            error: Some(error.into()),
          },
        }
      })
      .collect()
  })
  .await
  .map_err(|_| CommandError::new("store_io", "お手本の文書を取り込めませんでした。"))
}

/// HTML・WordPress/AMP/RSS の補助記事を安全取得。解析は共有 TS core が担当する。
#[tauri::command]
async fn fetch_sample_url(
  url: String,
  same_origin_redirect_only: Option<String>,
  timeout_ms: u64,
) -> CommandResult<sample_url::FetchedUrlPage> {
  Ok(
    sample_url::fetch_url(&url, same_origin_redirect_only.as_deref(), timeout_ms)
      .await
      .map_err(StoreError::from)?,
  )
}

/// 共有 core の抽出した本文を、URL・本文の検証をしてからファイルと同じ場所へ保存する。
#[tauri::command]
async fn save_sample_url(
  state: State<'_, AppState>,
  flow_id: String,
  url: String,
  name: String,
  text: String,
) -> CommandResult<FlowSample> {
  Ok(state.store().save_url_sample(&flow_id, &url, &name, &text)?)
}

/// お手本の文書の本文（消えていれば store_no_sample）。
#[tauri::command]
async fn read_sample(state: State<'_, AppState>, flow_id: String, sample_id: String) -> CommandResult<String> {
  Ok(state.store().read_sample(&flow_id, &sample_id)?)
}

/// 保存したフローに無いお手本の本文を消す。
#[tauri::command]
async fn prune_samples(state: State<'_, AppState>, flow_id: String, keep: Vec<String>) -> CommandResult<()> {
  Ok(state.store().prune_samples(&flow_id, &keep)?)
}

#[tauri::command]
async fn list_projects(state: State<'_, AppState>, cloud: State<'_, cloud::Cloud>) -> CommandResult<Vec<ProjectEntry>> {
  // 起動・保存先の切り替えの直後は、途中で終わった保存（journal）を片付けてから読む
  cloud.wait_recovered().await;
  Ok(state.store().list_projects()?)
}

#[tauri::command]
async fn load_pages(state: State<'_, AppState>, project_id: Option<String>) -> CommandResult<LoadedPages> {
  Ok(state.store().load_pages(project_id.as_deref())?)
}

#[tauri::command]
async fn save_project_order(state: State<'_, AppState>, order: Vec<String>) -> CommandResult<Vec<String>> {
  Ok(state.store().save_project_order(&order)?)
}

#[tauri::command]
async fn reorder_project(
  state: State<'_, AppState>,
  project_id: String,
  before_project_id: Option<String>,
) -> CommandResult<Vec<String>> {
  Ok(
    state
      .store()
      .reorder_project(&project_id, before_project_id.as_deref())?,
  )
}

#[tauri::command]
async fn delete_empty_folder(state: State<'_, AppState>, project_id: String) -> CommandResult<()> {
  Ok(state.store().delete_empty_folder(&project_id)?)
}

#[tauri::command]
async fn load_recent(state: State<'_, AppState>) -> CommandResult<Vec<RecentId>> {
  Ok(state.store().load_recent()?)
}

#[tauri::command]
async fn touch_recent(state: State<'_, AppState>, item: Value) -> CommandResult<Vec<RecentId>> {
  let project_id = match item.get("projectId") {
    Some(Value::String(id)) => Some(id.as_str()),
    Some(Value::Null) => None,
    _ => {
      return Err(CommandError::new(
        "store_bad_json",
        "最近開いたページの形式が正しくありません。",
      ))
    }
  };
  let page_id = item
    .get("pageId")
    .and_then(Value::as_str)
    .ok_or_else(|| CommandError::new("store_bad_json", "最近開いたページの形式が正しくありません。"))?;
  let opened_at = item
    .get("openedAt")
    .and_then(Value::as_str)
    .ok_or_else(|| CommandError::new("store_bad_json", "最近開いたページの形式が正しくありません。"))?;
  Ok(state.store().touch_recent(project_id, page_id, opened_at)?)
}

/// 案件を作る（id は Rust が決める）。音声は inputs/ に写し、文章は inputs/text.md と工程 1 の版 1。保存した project.json を返す。
/// `names` は音声の表示名（同じ順。無い・空なら元のファイル名。録音は「録音 10/16 15:30」）。
#[tauri::command]
async fn create_project(
  state: State<'_, AppState>,
  project: Value,
  text: Option<String>,
  text_record: Option<Value>,
  audio: Vec<String>,
  names: Option<Vec<String>>,
) -> CommandResult<Value> {
  let audio = absolute_paths(audio)?;
  let names = names.unwrap_or_default();
  let store = state.store();
  tauri::async_runtime::spawn_blocking(move || {
    store.create_project_named(&project, text.as_deref(), text_record.as_ref(), &audio, &names)
  })
  .await
  .map_err(|_| CommandError::new("store_io", "フォルダを作れませんでした。"))?
  .map_err(CommandError::from)
}

/// 音声を録音の inputs/ に写す（source.audio に入れる形を返す。保存は save_project〔root〕か save_recording）。
/// `keep` は同じ編集で残す音声の `file`、`names` は表示名（同じ順。無い・空なら元ファイル名）。
#[tauri::command]
async fn import_audio(
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
  paths: Vec<String>,
  names: Option<Vec<String>>,
  keep: Vec<String>,
) -> CommandResult<Vec<Value>> {
  let paths = absolute_paths(paths)?;
  let names = names.unwrap_or_default();
  let store = state.store();
  tauri::async_runtime::spawn_blocking(move || {
    store.import_audio_at_named(project_id.as_deref(), &recording_id, &paths, &names, &keep)
  })
  .await
  .map_err(|_| CommandError::new("store_io", "音声を写せませんでした。"))?
  .map_err(CommandError::from)
}

fn absolute_paths(paths: Vec<String>) -> CommandResult<Vec<PathBuf>> {
  let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
  if paths.iter().any(|path| !path.is_absolute()) {
    return Err(CommandError::new("store_bad_audio", "音声ファイルを読めませんでした。"));
  }
  Ok(paths)
}

/// 案件とページの一覧の様子（録音のページの成果物の有無・文書のページの更新時刻）。中身は load_recording・read_page。
#[tauri::command]
async fn load_project(state: State<'_, AppState>, project_id: String) -> CommandResult<LoadedProject> {
  Ok(state.store().load_project(&project_id)?)
}

/// 案件情報を保存する（ページの一覧はディスクのものを保つ。root の録音の flowSnapshot・source・refs・info.speakers・
/// info.language もここで書く）。
#[tauri::command]
async fn save_project(state: State<'_, AppState>, project_id: String, project: Value) -> CommandResult<()> {
  Ok(state.store().save_project(&project_id, &project)?)
}

/// 録音 1 つの中身（recording.json・工程 1 の成果物・最新版・記録）。
#[tauri::command]
async fn load_recording(
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
) -> CommandResult<LoadedRecording> {
  Ok(state.store().load_recording_at(project_id.as_deref(), &recording_id)?)
}

/// 録音のページの recording.json を保存する（root は save_project）。
#[tauri::command]
async fn save_recording(
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
  recording: Value,
) -> CommandResult<()> {
  Ok(
    state
      .store()
      .save_recording_at(project_id.as_deref(), &recording_id, &recording)?,
  )
}

#[tauri::command]
async fn create_candidate(
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
  step_id: String,
  candidate_set: Value,
  new_artifact_id: String,
  duplicate_markdown: Option<String>,
  record: Option<Value>,
) -> CommandResult<()> {
  Ok(state.store().create_candidate_at(
    project_id.as_deref(),
    &recording_id,
    &step_id,
    &candidate_set,
    &new_artifact_id,
    duplicate_markdown.as_deref(),
    record.as_ref(),
  )?)
}

#[tauri::command]
async fn rename_candidate(
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
  step_id: String,
  candidate_id: String,
  name: String,
) -> CommandResult<()> {
  Ok(
    state
      .store()
      .rename_candidate_at(project_id.as_deref(), &recording_id, &step_id, &candidate_id, &name)?,
  )
}

/// 後工程に使う文字起こしの案を変える（#19108。`expected` は画面が知っている今の指定）。
#[tauri::command]
async fn set_source_candidate(
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
  candidate_id: String,
  expected: Option<String>,
) -> CommandResult<()> {
  Ok(
    state
      .store()
      .set_source_candidate_at(project_id.as_deref(), &recording_id, &candidate_id, expected.as_deref())?,
  )
}

/// 素材の無い録音に文章を貼る（工程 1 の版 1 にする）。
#[tauri::command]
async fn set_recording_text(
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
  text: String,
  record: Value,
) -> CommandResult<()> {
  Ok(
    state
      .store()
      .set_recording_text_at(project_id.as_deref(), &recording_id, &text, &record)?,
  )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptImportWire {
  name: String,
  original_base64: String,
  markdown: String,
}

/// 共通UIで検証したVTT原本と派生Markdownを、空の録音へ原子的に取り込む。
#[tauri::command]
async fn import_transcript(
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
  transcript: TranscriptImportWire,
  record: Value,
) -> CommandResult<()> {
  let original = base64::engine::general_purpose::STANDARD
    .decode(&transcript.original_base64)
    .map_err(|_| CommandError::new("bad_vtt", "VTTファイルを読み取れませんでした。"))?;
  Ok(state.store().import_transcript_at(
    project_id.as_deref(),
    &recording_id,
    &transcript.name,
    &original,
    &transcript.markdown,
    &record,
  )?)
}

/// ページを足す（文書か録音。id は Rust が決める）。足した pages の 1 行を返す。
#[tauri::command]
async fn create_page(
  state: State<'_, AppState>,
  project_id: Option<String>,
  kind: String,
  title: String,
  created_at: String,
  recording: Option<Value>,
  after_page_id: Option<String>,
) -> CommandResult<Value> {
  if let Some(after_page_id) = after_page_id {
    if kind != "doc" {
      return Err(
        StoreError {
          code: "store_bad_page".into(),
          message: "録音の下には文書を追加してください。".into(),
        }
        .into(),
      );
    }
    return Ok(
      state
        .store()
        .create_document_after_at(project_id.as_deref(), &after_page_id, &title, &created_at)?,
    );
  }
  Ok(
    state
      .store()
      .create_page_at(project_id.as_deref(), &kind, &title, &created_at, recording.as_ref())?,
  )
}

#[tauri::command]
async fn rename_page(
  state: State<'_, AppState>,
  project_id: Option<String>,
  page_id: String,
  title: String,
) -> CommandResult<()> {
  Ok(state.store().rename_page_at(project_id.as_deref(), &page_id, &title)?)
}

/// ページを消す（文書は本文、録音は成果物・版・記録・会話・音声の写しと、API キー方式が app data に残す会話の履歴も。録音は案件の実行中なら断る）。
#[tauri::command]
async fn delete_page(state: State<'_, AppState>, project_id: Option<String>, page_id: String) -> CommandResult<()> {
  let store = state.store();
  // 録音を消すと会話の一覧（conversations/）も消えるので、先に会話の id を控える（消せたあとで、app data に残る会話の履歴も消す）
  let conversation_ids = store
    .conversation_ids_at(project_id.as_deref(), &page_id)
    .unwrap_or_default();
  store.delete_page_at(project_id.as_deref(), &page_id)?;
  if !conversation_ids.is_empty() {
    conversation::remove_chat_sessions(&state.data_dir, project_id.as_deref(), &page_id, &conversation_ids);
  }
  Ok(())
}

#[tauri::command]
async fn read_page(state: State<'_, AppState>, project_id: Option<String>, page_id: String) -> CommandResult<String> {
  Ok(state.store().read_page_at(project_id.as_deref(), &page_id)?)
}

/// 文書の本文を書く。保管庫の journal を通れば、この Mac の保存の世代を返す（無ければ null）。
#[tauri::command]
async fn write_page(
  state: State<'_, AppState>,
  project_id: Option<String>,
  page_id: String,
  markdown: String,
) -> CommandResult<Option<u64>> {
  Ok(
    state
      .store()
      .write_page_at(project_id.as_deref(), &page_id, &markdown)?,
  )
}

#[tauri::command]
async fn move_page(
  state: State<'_, AppState>,
  source_project_id: Option<String>,
  page_id: String,
  target_project_id: Option<String>,
  before_page_id: Option<String>,
) -> CommandResult<Value> {
  Ok(conversation::move_page_and_clean_sessions(
    &state.store(),
    &state.data_dir,
    source_project_id.as_deref(),
    &page_id,
    target_project_id.as_deref(),
    before_page_id.as_deref(),
  )?)
}

#[tauri::command]
async fn save_artifact(
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
  step_id: String,
  source: bool,
  markdown: String,
  record: Value,
) -> CommandResult<u32> {
  Ok(state.store().save_artifact_at(
    project_id.as_deref(),
    &recording_id,
    &step_id,
    source,
    &markdown,
    &record,
  )?)
}

#[tauri::command]
async fn append_run(
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
  record: Value,
) -> CommandResult<()> {
  Ok(
    state
      .store()
      .append_run_at(project_id.as_deref(), &recording_id, &record)?,
  )
}

/// 版の本文（`version_path` は runs の行の versionPath。無ければ表示の番号から）。
#[tauri::command]
async fn read_version(
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
  step_id: String,
  version: u32,
  version_path: Option<String>,
) -> CommandResult<String> {
  Ok(state.store().read_version_at(
    project_id.as_deref(),
    &recording_id,
    &step_id,
    version,
    version_path.as_deref(),
  )?)
}

/// 実行の checkpoint（録音の runs/<runId>.json）。
#[tauri::command]
async fn save_checkpoint(
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
  run_id: String,
  checkpoint: Value,
) -> CommandResult<()> {
  Ok(
    state
      .store()
      .save_checkpoint_at(project_id.as_deref(), &recording_id, &run_id, &checkpoint)?,
  )
}

#[tauri::command]
async fn read_checkpoint(
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
  run_id: String,
) -> CommandResult<Option<Value>> {
  Ok(
    state
      .store()
      .read_checkpoint_at(project_id.as_deref(), &recording_id, &run_id)?,
  )
}

/// 同じ案件の実行を 1 つにする（別の窓・別のアプリからも。NIHO クラウドでは別の Mac も lease で。C3 #18595）。
#[tauri::command]
async fn acquire_run_lock(
  state: State<'_, AppState>,
  cloud: State<'_, cloud::Cloud>,
  project_id: Option<String>,
) -> CommandResult<()> {
  // lease は通信するので、実行のロックの mutex の外で先に取る。フォルダ外の録音は予約の docs-root の lease を取り、別の Mac での
  // 同時実行（成果物の競合と重複した実行の費用）を防ぐ（#18721）
  let lease_project = project_id
    .as_deref()
    .unwrap_or(niho_desktop_vault::DOCS_ROOT_PROJECT_ID);
  let leased = cloud.acquire_lease(lease_project).await?;
  let lock_key = project_id.clone().unwrap_or_else(|| OUTSIDE_LOCK_KEY.to_string());
  let locked = (|| -> CommandResult<()> {
    let mut locks = state
      .run_locks
      .lock()
      .map_err(|_| CommandError::new("run_lock", "実行状態を確認できませんでした。"))?;
    // スマホから受けた工程を実行している間は、手元の実行を始めない（同じ mutex の中で決める）
    pc_runner::refuse_local_run(&state)?;
    state.store().acquire_run_lock_at(project_id.as_deref())?;
    locks.insert(lock_key);
    Ok(())
  })();
  if locked.is_err() && leased {
    cloud.abandon_lease(lease_project).await;
  }
  locked
}

#[tauri::command]
async fn release_run_lock(
  state: State<'_, AppState>,
  cloud: State<'_, cloud::Cloud>,
  project_id: Option<String>,
) -> CommandResult<()> {
  let lock_key = project_id.clone().unwrap_or_else(|| OUTSIDE_LOCK_KEY.to_string());
  {
    let mut locks = state
      .run_locks
      .lock()
      .map_err(|_| CommandError::new("run_lock", "実行状態を確認できませんでした。"))?;
    state.store().release_run_lock_at(project_id.as_deref())?;
    locks.remove(&lock_key);
  }
  // lease を返して、実行の結果をすぐ同期する（フォルダ外は docs-root）
  cloud
    .release_lease(
      project_id
        .as_deref()
        .unwrap_or(niho_desktop_vault::DOCS_ROOT_PROJECT_ID),
    )
    .await;
  Ok(())
}

#[tauri::command]
async fn list_all_runs(state: State<'_, AppState>) -> CommandResult<Vec<Value>> {
  Ok(state.store().list_all_runs()?)
}

// ---------------------------------------------------------------------------
// 工程の実行（CLI 実行基盤）

/// 画面から受け取る依頼（起動フォルダと時間の上限はこちらで決める）。名前は契約のまま。
#[derive(Deserialize)]
struct TurnRequestWire {
  provider: Provider,
  model: String,
  effort: Option<Effort>,
  system_prompt: String,
  user_prompt: String,
  resume_session: Option<String>,
  /// 会話ごとの workspace の id（起動フォルダは app data の下。案件フォルダではない）。
  workspace: String,
  max_budget_usd: Option<f64>,
}

fn turn_time_limit() -> Duration {
  std::env::var(TURN_TIME_LIMIT_ENV)
    .ok()
    .and_then(|value| value.trim().parse::<u64>().ok())
    .filter(|secs| *secs > 0)
    .map(Duration::from_secs)
    .unwrap_or(TURN_TIME_LIMIT)
}

/// `run_turn`・`transcribe_audio_part` の戻り値。終端イベント（Done / Error）を Channel とは別に戻り値でも返す。
/// Tauri の Channel は 8,192 バイト以上のメッセージを画面が fetch で後から取りに行くので、本文の全文を載せた Done は
/// command の戻りより後に届くことがある（日本語で約 2,700 字を超える成果物。#18382 の実機で記事方針が「途中で止まりました」に
/// なった）。画面は Channel で受けた終端イベントより、この値を使う（`run_chat_turn` の `ChatTurnResult` と同じ）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnResult {
  /// 終端イベントの wire 形（`TurnEvent::to_wire`）。届かずに終わったときは null。
  final_event: Value,
}

/// `TurnEvent` を `{ turnId, seq, event }` で流す。最後のイベント（Done / Error）を送ったら、それを戻り値にも載せて戻る。
/// `operation`（本人 Mac 実行の handle。personal_run.rs）を渡したら、turn をその operation に束縛し、送信の直前に Native の
/// guard を通す（無ければ今までどおり）。
#[tauri::command]
async fn run_turn(
  state: State<'_, AppState>,
  cloud: State<'_, cloud::Cloud>,
  turn_id: String,
  request: TurnRequestWire,
  operation: Option<String>,
  on_event: Channel<Value>,
) -> CommandResult<TurnResult> {
  run_turn_with(&state, &cloud, turn_id, request, operation, on_event).await
}

async fn run_turn_with(
  state: &AppState,
  cloud: &cloud::Cloud,
  turn_id: String,
  request: TurnRequestWire,
  operation: Option<String>,
  on_event: Channel<Value>,
) -> CommandResult<TurnResult> {
  safe_id(&turn_id)?;
  let personal = match &operation {
    Some(handle) => {
      let op = personal_run::operation_for(state, handle)?;
      personal_run::bind_turn(state, handle, &op, &turn_id)?;
      Some(op)
    }
    None => None,
  };
  if request.system_prompt.len() > MAX_SYSTEM_PROMPT_BYTES || request.user_prompt.len() > MAX_USER_PROMPT_BYTES {
    return Err(CommandError::new("turn_too_large", "送る量が多すぎます。"));
  }
  if let Some(session) = &request.resume_session {
    safe_id(session)?;
  }
  safe_id(&request.workspace)?;
  let workspaces = state.data_dir.join("workspaces");
  sweep_workspaces(&workspaces, &request.workspace);
  // CLI は会話を起動フォルダごとに保存するので、続きも同じフォルダで起動する（crate は無いフォルダを受け付けない）
  let workdir = workspaces.join(&request.workspace);
  std::fs::create_dir_all(&workdir)
    .map_err(|_| CommandError::new("turn_workspace", "AI の作業フォルダを作れませんでした。"))?;
  let turn = TurnRequest {
    provider: request.provider,
    model: request.model,
    effort: request.effort,
    system_prompt: request.system_prompt,
    user_prompt: request.user_prompt,
    resume_session: request.resume_session,
    workdir,
    timeout: turn_time_limit(),
    max_budget_usd: request.max_budget_usd,
    tool_policy: contract::ToolPolicy::None,
  };
  // 本人 Mac 実行の送信直前の guard（workspace の準備の後・runner の呼び出しの直前。ここから runner までは `.await` を挟まない）。
  // 取消が guard と runner の登録の間に入っても、登録の直後に確かめて止める。
  if let Some(op) = &personal {
    personal_run::send_guard(cloud, op, personal_run::SendKind::Turn).await?;
  }
  let final_event = drive_turn_with(state, turn_id, turn, on_event, personal).await;
  Ok(TurnResult { final_event })
}

/// 1 回の依頼を流す: `TurnEvent` を `{ turnId, seq, event }` で送り、`stop_turn` で止められるよう登録する。最後のイベント
/// （Done / Error）を送ったら、その wire 形を返す（届かずに終わったら null）。本人 Mac 実行の operation を添えたら、runner に
/// 渡した直後（`stop_turn` で止められるよう登録した後）に、その operation が取り消されていれば止める（取消と登録の行き違いで
/// 送り続けない）。
async fn drive_turn_with(
  state: &AppState,
  turn_id: String,
  turn: TurnRequest,
  on_event: Channel<Value>,
  personal: Option<Arc<personal_run::PersonalOperation>>,
) -> Value {
  let (done_sender, done_receiver) = std::sync::mpsc::channel::<Value>();
  let envelope_turn_id = turn_id.clone();
  let mut seq: u64 = 0;
  let handle = state.runner.run_turn(
    turn,
    Box::new(move |event| {
      let terminal = event.is_terminal();
      let wire = event.to_wire();
      let _ = on_event.send(json!({ "turnId": envelope_turn_id, "seq": seq, "event": wire.clone() }));
      seq += 1;
      if terminal {
        let _ = done_sender.send(wire);
      }
    }),
  );
  if let Ok(mut turns) = state.turns.lock() {
    turns.insert(turn_id.clone(), handle.clone());
  }
  if personal.as_ref().is_some_and(|op| op.stop_requested()) {
    handle.stop();
  }
  let final_event = tauri::async_runtime::spawn_blocking(move || done_receiver.recv())
    .await
    .ok()
    .and_then(|received| received.ok())
    .unwrap_or(Value::Null);
  if let Ok(mut turns) = state.turns.lock() {
    turns.remove(&turn_id);
  }
  final_event
}

/// 24 時間使われていない workspace を消す（今の会話のものは残す）。
fn sweep_workspaces(root: &Path, keep: &str) {
  let Ok(entries) = std::fs::read_dir(root) else { return };
  for entry in entries.filter_map(|entry| entry.ok()) {
    if entry.file_name().to_string_lossy() == keep {
      continue;
    }
    let stale = entry
      .metadata()
      .and_then(|meta| meta.modified())
      .ok()
      .and_then(|modified| modified.elapsed().ok())
      .map(|age| age > WORKSPACE_RETENTION)
      .unwrap_or(false);
    if stale && entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
      let _ = std::fs::remove_dir_all(entry.path());
    }
  }
}

#[tauri::command]
async fn stop_turn(state: State<'_, AppState>, turn_id: String) -> CommandResult<bool> {
  let handle = state.turns.lock().ok().and_then(|turns| turns.get(&turn_id).cloned());
  match handle {
    Some(handle) => {
      handle.stop();
      Ok(true)
    }
    None => Ok(false),
  }
}

#[tauri::command]
async fn provider_status(state: State<'_, AppState>, provider: Provider) -> CommandResult<ProviderStatus> {
  let runner = state.runner.clone();
  tauri::async_runtime::spawn_blocking(move || runner.provider_status(provider))
    .await
    .map_err(|_| CommandError::new("status_failed", "状態を確かめられませんでした。"))
}

/// 使用量の残り（Antigravity CLI の `/usage` だけ。ほかの提供元・取れないときは Err で、画面は「取得できません」）。
#[tauri::command]
async fn provider_usage(state: State<'_, AppState>, provider: Provider) -> CommandResult<ProviderUsage> {
  let runner = state.runner.clone();
  tauri::async_runtime::spawn_blocking(move || runner.provider_usage(provider))
    .await
    .map_err(|_| CommandError::new("usage_unavailable", "使用量を取得できませんでした。"))?
    .map_err(CommandError::from)
}

/// ログイン・導入・更新の前に、実行中の工程が無いことを確かめる（crate も確かめるが、待たせずに断る）。
fn ensure_no_running_turns(state: &AppState) -> CommandResult<()> {
  if state.runner.has_running_turns() {
    return Err(CommandError::new(
      "turn_running",
      "実行中の工程が終わってから、もう一度お試しください。",
    ));
  }
  Ok(())
}

/// 公式のログインを始める（CLI がブラウザを開き、本人がログインする。最長 10 分待つ）。終わったら状態を返す。
#[tauri::command]
async fn start_auth(state: State<'_, AppState>, provider: Provider) -> CommandResult<ProviderStatus> {
  ensure_no_running_turns(&state)?;
  let runner = state.runner.clone();
  tauri::async_runtime::spawn_blocking(move || runner.start_auth(provider))
    .await
    .map_err(|_| CommandError::new("auth_failed", "ログインを確かめられませんでした。"))?
    .map_err(CommandError::from)
}

/// Claude Code を公式のインストーラで入れる（入っていれば何もしない）。
#[tauri::command]
async fn install_claude(state: State<'_, AppState>) -> CommandResult<ProviderStatus> {
  ensure_no_running_turns(&state)?;
  let runner = state.runner.clone();
  tauri::async_runtime::spawn_blocking(move || runner.install_claude())
    .await
    .map_err(|_| CommandError::new("install_failed", "Claude Code を入れられませんでした。"))?
    .map_err(CommandError::from)
}

/// Claude Code を最新にする。
#[tauri::command]
async fn update_claude(state: State<'_, AppState>) -> CommandResult<ClaudeUpdate> {
  ensure_no_running_turns(&state)?;
  let runner = state.runner.clone();
  tauri::async_runtime::spawn_blocking(move || runner.update_claude())
    .await
    .map_err(|_| CommandError::new("update_failed", "Claude Code を更新できませんでした。"))?
    .map_err(CommandError::from)
}

// ---------------------------------------------------------------------------
// API キー（S2b #18383。鍵は app data の api-keys/ だけ（#18769）。画面へは返さない）

fn api_account(account: &str) -> CommandResult<niho_api_ai::Account> {
  niho_api_ai::Account::parse(account)
    .ok_or_else(|| CommandError::new("bad_account", "API キーの種類が正しくありません。"))
}

/// 保存済みか・末尾 4 文字（呼び出しはしない）。
#[tauri::command]
async fn api_key_status(state: State<'_, AppState>, account: String) -> CommandResult<api_ai::ApiKeyStatus> {
  let account = api_account(&account)?;
  let api = state.api.clone();
  tauri::async_runtime::spawn_blocking(move || api.key_status(account))
    .await
    .map_err(|_| CommandError::new("api_key_read_failed", "API キーの状態を確かめられませんでした。"))?
    .map_err(CommandError::from)
}

/// 1 回の軽い呼び出しで確かめてからこの Mac に保存する（失敗なら保存しない）。鍵は返さない。
#[tauri::command]
async fn save_api_key(state: State<'_, AppState>, account: String, key: String) -> CommandResult<api_ai::ApiKeyStatus> {
  let account = api_account(&account)?;
  let api = state.api.clone();
  tauri::async_runtime::spawn_blocking(move || api.save_key(account, &key))
    .await
    .map_err(|_| CommandError::new("api_failed", "API キーを保存できませんでした。"))?
    .map_err(CommandError::from)
}

/// 保存済みの鍵で 1 回の軽い呼び出しをする（無効なら `valid: false`）。
#[tauri::command]
async fn check_api_key(state: State<'_, AppState>, account: String) -> CommandResult<api_ai::ApiKeyStatus> {
  let account = api_account(&account)?;
  let api = state.api.clone();
  tauri::async_runtime::spawn_blocking(move || api.check_key(account))
    .await
    .map_err(|_| CommandError::new("api_failed", "API キーを確かめられませんでした。"))?
    .map_err(CommandError::from)
}

#[tauri::command]
async fn delete_api_key(state: State<'_, AppState>, account: String) -> CommandResult<api_ai::ApiKeyStatus> {
  let account = api_account(&account)?;
  let api = state.api.clone();
  tauri::async_runtime::spawn_blocking(move || api.delete_key(account))
    .await
    .map_err(|_| CommandError::new("api_key_delete_failed", "API キーを削除できませんでした。"))?
    .map_err(CommandError::from)
}

// ---------------------------------------------------------------------------
// 文字起こし（niho-speech）

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeechStatus {
  found: bool,
  fake: bool,
  available: bool,
  needs_download: bool,
  engine: Option<String>,
  error: Option<String>,
  /// 本物が無く偽物で代わりに動いているときの案内（開発ビルドだけ。`npm run sidecar:build`）。
  notice: Option<String>,
  diarization: DiarizationStatus,
  /// この Mac で動かない文字起こし（`os`＝macOS 26 より前で sidecar を起動できない・`engine`＝音声認識を使えない。#18753）。
  /// 確かめられなかったときは None（実行の失敗に任せる）。
  unsupported: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiarizationStatus {
  state: String,
  detail: Option<String>,
}

#[tauri::command]
async fn speech_status(language: String) -> CommandResult<SpeechStatus> {
  tauri::async_runtime::spawn_blocking(move || {
    let Some(binary) = speech::resolve_speech_binary() else {
      return SpeechStatus {
        found: false,
        fake: false,
        available: false,
        needs_download: false,
        engine: None,
        error: Some(SpeechError::NotFound.message().to_string()),
        notice: None,
        diarization: DiarizationStatus {
          state: "missing".to_string(),
          detail: None,
        },
        unsupported: None,
      };
    };
    let notice = binary.stand_in.then(|| speech::STAND_IN_NOTICE.to_string());
    // 本物の sidecar は macOS 26 より前では起動できない（偽物は動く）。起動して「途中で止まりました」になる前に、使えないと返す
    if !binary.fake && !speech::sidecar_runs_on_this_macos() {
      return SpeechStatus {
        found: true,
        fake: false,
        available: false,
        needs_download: false,
        engine: None,
        error: Some(speech::OS_UNSUPPORTED_MESSAGE.to_string()),
        notice,
        diarization: DiarizationStatus {
          state: "missing".to_string(),
          detail: None,
        },
        unsupported: Some("os"),
      };
    }
    match speech::probe(&binary.path, &language) {
      Ok(value) => {
        let diarization = value.get("diarization").cloned().unwrap_or(Value::Null);
        let diarization_state = diarization
          .get("state")
          .and_then(Value::as_str)
          .unwrap_or("missing")
          .to_string();
        let diarization_detail = diarization.get("detail").and_then(Value::as_str).map(str::to_string);
        // probe は SpeechTranscriber を使えて、言語（日本語・英語。どちらも対応）を扱えるときだけ available
        let available = value.get("available").and_then(Value::as_bool).unwrap_or(false);
        SpeechStatus {
          found: true,
          fake: binary.fake,
          available,
          needs_download: value.get("needsDownload").and_then(Value::as_bool).unwrap_or(false),
          engine: value.get("engine").and_then(Value::as_str).map(str::to_string),
          error: (diarization_state == "corrupt").then(|| {
            diarization_detail
              .clone()
              .unwrap_or_else(|| "話者分離モデルが壊れています。再取得してください。".to_string())
          }),
          notice,
          diarization: DiarizationStatus {
            state: diarization_state,
            detail: diarization_detail,
          },
          unsupported: (!available).then_some("engine"),
        }
      }
      Err(error) => SpeechStatus {
        found: true,
        fake: binary.fake,
        available: false,
        needs_download: error == SpeechError::ModelMissing,
        engine: None,
        error: Some(error.message().to_string()),
        notice,
        diarization: DiarizationStatus {
          state: "missing".to_string(),
          detail: None,
        },
        unsupported: None,
      },
    }
  })
  .await
  .map_err(|_| CommandError::new("speech_failed", SpeechError::Failed.message()))
}

fn register_job(state: &AppState, job_id: &str) -> CommandResult<Arc<SpeechJob>> {
  safe_id(job_id)?;
  let job = Arc::new(SpeechJob::new());
  if let Ok(mut jobs) = state.speech_jobs.lock() {
    jobs.insert(job_id.to_string(), job.clone());
  }
  Ok(job)
}

fn forget_job(state: &AppState, job_id: &str) {
  if let Ok(mut jobs) = state.speech_jobs.lock() {
    jobs.remove(job_id);
  }
}

#[tauri::command]
async fn speech_download(
  state: State<'_, AppState>,
  job_id: String,
  language: String,
  on_event: Channel<Value>,
) -> CommandResult<()> {
  let binary = speech::resolve_speech_binary().ok_or(SpeechError::NotFound)?;
  let job = register_job(&state, &job_id)?;
  let result = tauri::async_runtime::spawn_blocking(move || {
    speech::download(&job, &binary.path, &language, &mut |value| {
      let _ = on_event.send(value);
    })
  })
  .await
  .unwrap_or(Err(SpeechError::Failed));
  forget_job(&state, &job_id);
  Ok(result?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileTranscriptDto {
  jsonl: String,
  duration_sec: f64,
}

/// `operation`（本人 Mac 実行の handle）を渡したら、音声は operation が material で照合した写し（捕捉した Store）から読み、
/// job をその operation に束縛し、sidecar を起動する直前に Native の guard を通す（無ければ今までどおり）。
#[tauri::command]
async fn transcribe(
  state: State<'_, AppState>,
  cloud: State<'_, cloud::Cloud>,
  job_id: String,
  project_id: Option<String>,
  recording_id: String,
  language: String,
  speaker_mode: String,
  hints: Value,
  operation: Option<String>,
  on_event: Channel<Value>,
) -> CommandResult<Vec<FileTranscriptDto>> {
  let request = TranscribeRequest {
    job_id,
    project_id,
    recording_id,
    language,
    speaker_mode,
    hints,
  };
  transcribe_with(&state, &cloud, request, operation, on_event).await
}

/// `transcribe` の引数（画面から受け取るまま）。
struct TranscribeRequest {
  job_id: String,
  project_id: Option<String>,
  recording_id: String,
  language: String,
  speaker_mode: String,
  hints: Value,
}

async fn transcribe_with(
  state: &AppState,
  cloud: &cloud::Cloud,
  request: TranscribeRequest,
  operation: Option<String>,
  on_event: Channel<Value>,
) -> CommandResult<Vec<FileTranscriptDto>> {
  let TranscribeRequest {
    job_id,
    project_id,
    recording_id,
    language,
    speaker_mode,
    hints,
  } = request;
  // operation に束縛した job id は、ほかの operation・operation なしでは使えない（登録し直すと元の job を止められなくなる）
  let owner = personal_run::job_owner(state, &job_id);
  let personal = match &operation {
    Some(handle) => {
      let op = personal_run::operation_for(state, handle)?;
      if op.stop_requested()
        || !op.matches_recording(project_id.as_deref(), &recording_id)
        || owner.as_ref().is_some_and(|owner| owner != handle)
      {
        return Err(personal_run::guard_failed());
      }
      Some((handle.clone(), op))
    }
    None if owner.is_some() => return Err(personal_run::guard_failed()),
    None => None,
  };
  let binary = speech::resolve_speech_binary().ok_or(SpeechError::NotFound)?;
  // 音声は録音の inputs/ の写しだけを読む（画面からパスを受け取らない）。本人 Mac 実行は operation が照合した写しだけ
  let paths = match &personal {
    Some((_, op)) => op.audio_paths()?,
    None => state.store().audio_paths_at(project_id.as_deref(), &recording_id)?,
  };
  if paths.is_empty() {
    return Err(SpeechError::BadInput.into());
  }
  if !matches!(language.as_str(), "ja" | "en")
    || !matches!(speaker_mode.as_str(), "none" | "auto" | "2" | "3" | "4plus")
  {
    return Err(SpeechError::BadInput.into());
  }
  let hints_json = speech::hints_json(&hints);
  let job = register_job(state, &job_id)?;
  // 本人 Mac 実行の送信直前の guard（sidecar の起動の直前。job は登録済みなので、この後の取消は sidecar を止める）
  if let Some((handle, op)) = &personal {
    let guarded = match personal_run::bind_job(state, handle, op, &job_id) {
      Ok(()) => personal_run::send_guard(cloud, op, personal_run::SendKind::ThisMacTranscribe).await,
      Err(error) => Err(error),
    };
    if let Err(error) = guarded {
      forget_job(state, &job_id);
      return Err(error);
    }
    if op.stop_requested() {
      job.stop();
    }
  }
  let result = tauri::async_runtime::spawn_blocking(move || {
    speech::transcribe(
      &job,
      &binary.path,
      &paths,
      &language,
      &hints_json,
      &speaker_mode,
      &mut |value| {
        let _ = on_event.send(value);
      },
    )
  })
  .await
  .unwrap_or(Err(SpeechError::Failed));
  forget_job(state, &job_id);
  Ok(
    result?
      .into_iter()
      .map(|file| FileTranscriptDto {
        jsonl: file.jsonl,
        duration_sec: file.duration_sec,
      })
      .collect(),
  )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioFilePathDto {
  file: String,
  path: Option<String>,
}

/// 録音の source.audio と同じ順で実ファイルを返す。画面から path は受け取らず、Store の ID・file 検証と
/// symlink 境界を通した実在ファイルだけを、その exact path で asset protocol scope に足す。
#[tauri::command]
async fn audio_file_paths(
  app: tauri::AppHandle,
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
) -> CommandResult<Vec<AudioFilePathDto>> {
  let paths = state.store().audio_paths_at(project_id.as_deref(), &recording_id)?;
  paths
    .into_iter()
    .map(|path| {
      let file = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| CommandError::new("audio_unavailable", "音声を開けませんでした。"))?
        .to_string();
      let path = if path.is_file() {
        app
          .asset_protocol_scope()
          .allow_file(&path)
          .map_err(|_| CommandError::new("audio_unavailable", "音声を開けませんでした。"))?;
        Some(
          path
            .into_os_string()
            .into_string()
            .map_err(|_| CommandError::new("audio_unavailable", "音声を開けませんでした。"))?,
        )
      } else {
        None
      };
      Ok(AudioFilePathDto { file, path })
    })
    .collect()
}

/// Gemini の文字起こしの区切り（元の音声の絶対秒）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioPartDto {
  start_sec: f64,
  end_sec: f64,
  sound_sec: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedFileDto {
  duration_sec: f64,
  parts: Vec<AudioPartDto>,
}

/// Gemini の文字起こしの準備: 録音の音声の写しを順に `convert` → `silence` し、区切りの境目を返す（WAV は app data の
/// `speech-parts/<job id>/`。`release_audio` で消す）。段階は `on_event` へ。止めるのは `stop_transcribe(job_id)`。
/// `operation`（本人 Mac 実行の handle）を渡したら、音声は operation が照合した写しから読み、job をその operation に束縛し
/// （区切りの文字起こしは同じ operation でだけ使える）、変換の直前に Native の guard を通す。
#[tauri::command]
async fn prepare_audio(
  state: State<'_, AppState>,
  cloud: State<'_, cloud::Cloud>,
  job_id: String,
  project_id: Option<String>,
  recording_id: String,
  operation: Option<String>,
  on_event: Channel<Value>,
) -> CommandResult<Vec<PreparedFileDto>> {
  safe_id(&job_id)?;
  let binary = speech::resolve_speech_binary().ok_or(SpeechError::NotFound)?;
  // operation に束縛した job id は、ほかの operation・operation なしでは使えない（登録し直すと元の job を止められなくなる）
  let owner = personal_run::job_owner(&state, &job_id);
  let personal = match &operation {
    Some(handle) => {
      let op = personal_run::operation_for(&state, handle)?;
      if !op.matches_recording(project_id.as_deref(), &recording_id)
        || owner.as_ref().is_some_and(|owner| owner != handle)
      {
        return Err(personal_run::guard_failed());
      }
      Some((handle.clone(), op))
    }
    None if owner.is_some() => return Err(personal_run::guard_failed()),
    None => None,
  };
  let paths = match &personal {
    Some((_, op)) => op.audio_paths()?,
    None => state.store().audio_paths_at(project_id.as_deref(), &recording_id)?,
  };
  if paths.is_empty() {
    return Err(SpeechError::BadInput.into());
  }
  let root = state.data_dir.join(AUDIO_PARTS_DIR);
  // 強制終了などで残った前の文字起こしの WAV を消す（24 時間より古いもの）
  sweep_workspaces(&root, &job_id);
  let dir = root.join(&job_id);
  std::fs::create_dir_all(&dir).map_err(|_| CommandError::from(SpeechError::Failed))?;
  let job = register_job(&state, &job_id)?;
  // 本人 Mac 実行の guard（変換の sidecar の起動の直前）
  if let Some((handle, op)) = &personal {
    let guarded = match personal_run::bind_job(&state, handle, op, &job_id) {
      Ok(()) => personal_run::send_guard(&cloud, op, personal_run::SendKind::AudioPrepare).await,
      Err(error) => Err(error),
    };
    if let Err(error) = guarded {
      forget_job(&state, &job_id);
      let _ = std::fs::remove_dir_all(&dir);
      return Err(error);
    }
    if op.stop_requested() {
      job.stop();
    }
  }
  let work_dir = dir.clone();
  let result = tauri::async_runtime::spawn_blocking(move || {
    speech::prepare_audio(&job, &binary.path, &paths, &work_dir, &mut |value| {
      let _ = on_event.send(value);
    })
  })
  .await
  .unwrap_or(Err(SpeechError::Failed));
  forget_job(&state, &job_id);
  let files = match result {
    Ok(files) => files,
    Err(error) => {
      let _ = std::fs::remove_dir_all(&dir);
      return Err(error.into());
    }
  };
  let dto = files
    .iter()
    .map(|file| PreparedFileDto {
      duration_sec: file.duration_sec,
      parts: file
        .bounds
        .iter()
        .zip(file.sound_sec.iter())
        .map(|((start, end), sound_sec)| AudioPartDto {
          start_sec: *start,
          end_sec: *end,
          sound_sec: *sound_sec,
        })
        .collect(),
    })
    .collect();
  register_prepared_audio(
    &state,
    job_id,
    dir,
    files,
    personal.as_ref().map(|(handle, op)| (handle.as_str(), op.as_ref())),
  )?;
  Ok(dto)
}

/// 準備した音声を登録する。本人 Mac 実行の operation で準備したら、その handle を持ち主にする。準備の間に operation が
/// 取り消された・閉じたら登録せずに WAV を消す（close の後始末と同じ lock の中で確かめるので、閉じた後に登録が残らない）。
fn register_prepared_audio(
  state: &AppState,
  job_id: String,
  dir: PathBuf,
  files: Vec<speech::PreparedFile>,
  personal: Option<(&str, &personal_run::PersonalOperation)>,
) -> CommandResult<()> {
  let Ok(mut jobs) = state.audio_jobs.lock() else {
    return Ok(());
  };
  if personal.is_some_and(|(_, op)| op.stop_requested()) {
    drop(jobs);
    let _ = std::fs::remove_dir_all(&dir);
    return Err(personal_run::guard_failed());
  }
  let owner = personal.map(|(handle, _)| handle.to_string());
  jobs.insert(job_id, Arc::new(PreparedAudio { dir, files, owner }));
  Ok(())
}

/// 区切り 1 つの文字起こしの依頼（指示文は画面が docs-core で組み立てる。提供元は Gemini＝Antigravity CLI だけ）。
#[derive(Deserialize)]
struct AudioPartRequestWire {
  provider: Provider,
  model: String,
  effort: Option<Effort>,
  system_prompt: String,
  user_prompt: String,
}

const AUDIO_NOT_PREPARED_MESSAGE: &str = "音声の準備が見つかりません。もう一度実行してください。";

/// Gemini の文字起こしの区切り 1 つ: その区切りを WAV に書き出し、agy に `view_file` で読ませる（crate の `ReadFile`）。
/// API キー方式（`GeminiApi`）は同じ WAV を Files API に上げて依頼に添える（終わったら Files API からも消す）。
/// `TurnEvent` を `run_turn` と同じ形で流し（終端イベントは戻り値にも載せる）、`stop_turn(turn_id)` で止められる。WAV は
/// 終わったら消す。
/// `operation`（本人 Mac 実行の handle）を渡したら、`prepare_audio` を同じ operation で準備した job だけを使い、turn をその
/// operation に束縛し、区切りの書き出しの後・送信の直前に Native の guard を通す。operation に束縛した job は、operation なしでは
/// 使えない。
#[tauri::command]
async fn transcribe_audio_part(
  state: State<'_, AppState>,
  cloud: State<'_, cloud::Cloud>,
  turn_id: String,
  job_id: String,
  file: usize,
  part: usize,
  request: AudioPartRequestWire,
  operation: Option<String>,
  on_event: Channel<Value>,
) -> CommandResult<TurnResult> {
  let part = AudioPartRef { job_id, file, part };
  transcribe_audio_part_with(&state, &cloud, turn_id, part, request, operation, on_event).await
}

/// 区切りの位置（`prepare_audio` の job と、その結果の音声・区切りの番号）。
struct AudioPartRef {
  job_id: String,
  file: usize,
  part: usize,
}

async fn transcribe_audio_part_with(
  state: &AppState,
  cloud: &cloud::Cloud,
  turn_id: String,
  part: AudioPartRef,
  request: AudioPartRequestWire,
  operation: Option<String>,
  on_event: Channel<Value>,
) -> CommandResult<TurnResult> {
  let AudioPartRef { job_id, file, part } = part;
  safe_id(&turn_id)?;
  safe_id(&job_id)?;
  // 準備した音声の持ち主（operation で準備したものは、その operation でだけ使える。閉じた後も operation なしでは使えない）
  let prepared_owner = state
    .audio_jobs
    .lock()
    .ok()
    .and_then(|jobs| jobs.get(&job_id).map(|prepared| prepared.owner.clone()))
    .flatten();
  let personal = match &operation {
    Some(handle) => {
      let op = personal_run::operation_for(state, handle)?;
      if !personal_run::owns_job(&op, &job_id) || prepared_owner.as_ref().is_some_and(|owner| owner != handle) {
        return Err(personal_run::guard_failed());
      }
      personal_run::precheck(&op)?;
      personal_run::bind_turn(state, handle, &op, &turn_id)?;
      Some(op)
    }
    None => {
      if prepared_owner.is_some() || personal_run::job_owner(state, &job_id).is_some() {
        return Err(personal_run::guard_failed());
      }
      None
    }
  };
  // Gemini だけ（サブスクリプションは Antigravity CLI が読み、API キー方式は Gemini API の Files API に上げて添える）
  if request.provider != Provider::GeminiCli && request.provider != Provider::GeminiApi {
    return Err(CommandError::new(
      "audio_provider",
      "音声を読ませる文字起こしは Gemini だけで使えます。",
    ));
  }
  // 本人 Mac の実行は、開始時に固定した文字起こしの方式（サブスクリプション／API キー）の Gemini でだけ送る
  if let Some(op) = &personal {
    if !personal_run::gemini_transcription_matches(op, request.provider == Provider::GeminiApi) {
      return Err(personal_run::guard_failed());
    }
  }
  if request.system_prompt.len() > MAX_SYSTEM_PROMPT_BYTES || request.user_prompt.len() > MAX_USER_PROMPT_BYTES {
    return Err(CommandError::new("turn_too_large", "送る量が多すぎます。"));
  }
  let prepared = state
    .audio_jobs
    .lock()
    .ok()
    .and_then(|jobs| jobs.get(&job_id).cloned())
    .ok_or_else(|| CommandError::new("audio_not_prepared", AUDIO_NOT_PREPARED_MESSAGE))?;
  // 準備した operation と同じ operation だけが使える。close の後は operation が無く `job_owner` が空になるので、持ち主は音声側に持つ
  if prepared.owner != operation {
    return Err(personal_run::guard_failed());
  }
  let (wav, (start, end)) = prepared
    .files
    .get(file)
    .and_then(|prepared_file| {
      prepared_file
        .bounds
        .get(part)
        .map(|bounds| (prepared_file.wav.clone(), *bounds))
    })
    .ok_or_else(|| CommandError::new("audio_not_prepared", AUDIO_NOT_PREPARED_MESSAGE))?;
  let binary = speech::resolve_speech_binary().ok_or(SpeechError::NotFound)?;
  let slice = prepared.dir.join(format!("f{file}-p{part}.wav"));
  let target = slice.clone();
  tauri::async_runtime::spawn_blocking(move || {
    speech::slice_part(&SpeechJob::new(), &binary.path, &wav, start, end, &target)
  })
  .await
  .unwrap_or(Err(SpeechError::Failed))?;
  let turn = TurnRequest {
    provider: request.provider,
    model: request.model,
    effort: request.effort,
    system_prompt: request.system_prompt,
    user_prompt: request.user_prompt,
    resume_session: None,
    workdir: prepared.dir.clone(),
    timeout: AUDIO_PART_TIME_LIMIT,
    max_budget_usd: None,
    tool_policy: contract::ToolPolicy::ReadFile { file: slice.clone() },
  };
  // 本人 Mac 実行の送信直前の guard（区切りの書き出しの await の後・runner の呼び出しの直前。ここから runner までは `.await` を
  // 挟まない）
  if let Some(op) = &personal {
    if let Err(error) = personal_run::send_guard(cloud, op, personal_run::SendKind::AudioPart).await {
      let _ = std::fs::remove_file(&slice);
      return Err(error);
    }
  }
  let final_event = drive_turn_with(state, turn_id, turn, on_event, personal).await;
  let _ = std::fs::remove_file(&slice);
  Ok(TurnResult { final_event })
}

/// Deepgram の文字起こしの依頼（固有名詞の表記は画面が docs-core の `deepgramKeyterms` で選ぶ）。
#[derive(Deserialize)]
struct DeepgramRequestWire {
  language: String,
  diarize: bool,
  keyterms: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeepgramUtteranceDto {
  start: f64,
  end: f64,
  speaker: Option<u32>,
  transcript: String,
}

/// 音声 1 つの Deepgram の結果（docs-core の `DeepgramFileResult`）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeepgramFileDto {
  duration_sec: Option<f64>,
  utterances: Vec<DeepgramUtteranceDto>,
  transcript: String,
}

const MAX_KEYTERMS: usize = 300;

/// paid HTTPの直前にoperationのleaseと同期guardを再検査してから、ちょうど1回だけ送る。テストは`send`をstubにして送信0/1を数える。
async fn guarded_deepgram_http<T>(
  cloud: &cloud::Cloud,
  personal: Option<&personal_run::PersonalOperation>,
  send: impl FnOnce() -> CommandResult<T>,
) -> CommandResult<T> {
  if let Some(op) = personal {
    personal_run::send_guard(cloud, op, personal_run::SendKind::Deepgram).await?;
  }
  send()
}

/// Deepgram（API キー方式だけ）: 録音の音声の写しを順に送り、utterances を返す（Markdown は画面が組む）。段階は
/// `on_event` の Stage。止めるのは `stop_transcribe(job_id)`（止めたら speech_stopped）。
#[tauri::command]
async fn transcribe_deepgram(
  state: State<'_, AppState>,
  cloud: State<'_, cloud::Cloud>,
  job_id: String,
  project_id: Option<String>,
  recording_id: String,
  request: DeepgramRequestWire,
  on_event: Channel<Value>,
  operation: Option<String>,
) -> CommandResult<Vec<DeepgramFileDto>> {
  safe_id(&job_id)?;
  if !matches!(request.language.as_str(), "ja" | "en")
    || request.keyterms.len() > MAX_KEYTERMS
    || request.keyterms.iter().any(|term| term.chars().count() > 100)
  {
    return Err(SpeechError::BadInput.into());
  }
  // operationに束縛したjobは別operation・operation無しから再利用できない。音声も画面のproject/ridから引き直さず、
  // operationがmaterial読取時に捕捉・SHA照合した実体だけを使う。
  let owner = personal_run::job_owner(&state, &job_id);
  let personal = match operation.as_deref() {
    Some(handle) => {
      let op = personal_run::operation_for(&state, handle)?;
      if op.stop_requested()
        || !op.matches_recording(project_id.as_deref(), &recording_id)
        || owner.as_deref().is_some_and(|owner| owner != handle)
      {
        return Err(personal_run::guard_failed());
      }
      personal_run::bind_job(&state, handle, &op, &job_id)?;
      Some(op)
    }
    None if owner.is_some() => return Err(personal_run::guard_failed()),
    None => None,
  };
  let paths_result: CommandResult<Vec<PathBuf>> = match personal.as_deref() {
    Some(op) => op.audio_paths(),
    None => state
      .store()
      .audio_paths_at(project_id.as_deref(), &recording_id)
      .map_err(CommandError::from),
  };
  let paths = match paths_result {
    Ok(paths) => paths,
    Err(error) => {
      if let Some(op) = personal.as_deref() {
        personal_run::unbind_job(op, &job_id);
      }
      return Err(error);
    }
  };
  if paths.is_empty() {
    if let Some(op) = personal.as_deref() {
      personal_run::unbind_job(op, &job_id);
    }
    return Err(SpeechError::BadInput.into());
  }
  let stop = niho_api_ai::StopSignal::new();
  if let Ok(mut jobs) = state.deepgram_jobs.lock() {
    jobs.insert(job_id.clone(), stop.clone());
  }
  let options = Arc::new(niho_api_ai::DeepgramRequest {
    language: request.language,
    diarize: request.diarize,
    keyterms: request.keyterms,
  });
  let mut files = Vec::new();
  let mut result: CommandResult<()> = Ok(());
  let file_count = paths.len();
  for (index, path) in paths.into_iter().enumerate() {
    if let Some(op) = personal.as_deref() {
      if let Err(error) = personal_run::send_guard(&cloud, op, personal_run::SendKind::Deepgram).await {
        result = Err(error);
        break;
      }
    }
    let api = state.api.clone();
    let options = options.clone();
    let stop_for_file = stop.clone();
    let personal_for_file = personal.clone();
    let cloud_for_file = cloud.inner().clone();
    let event_for_file = on_event.clone();
    let file_result = tauri::async_runtime::spawn_blocking(move || {
      // spawn待ちの間にもlease失効・本人切替・取消・音声変更があり得る。worker内でleaseも再検査し、guard完了からHTTPまでawaitを挟まない。
      tauri::async_runtime::block_on(guarded_deepgram_http(
        &cloud_for_file,
        personal_for_file.as_deref(),
        || {
          let _ =
            event_for_file.send(json!({ "type": "Stage", "stage": "transcribe", "file": index, "files": file_count }));
          match api.transcribe_deepgram(&path, &options, &stop_for_file)? {
            Some(result) => Ok(result),
            None => Err(SpeechError::Stopped.into()),
          }
        },
      ))
    })
    .await
    .unwrap_or_else(|_| Err(CommandError::from(SpeechError::Failed)));
    match file_result {
      Ok(file) if !stop.is_stopped() => files.push(file),
      Ok(_) => {
        result = Err(SpeechError::Stopped.into());
        break;
      }
      Err(error) => {
        result = Err(error);
        break;
      }
    }
  }
  if let Ok(mut jobs) = state.deepgram_jobs.lock() {
    jobs.remove(&job_id);
  }
  if let Some(op) = personal.as_deref() {
    personal_run::unbind_job(op, &job_id);
  }
  result?;
  Ok(
    files
      .into_iter()
      .map(|file| DeepgramFileDto {
        duration_sec: file.duration_sec,
        utterances: file
          .utterances
          .into_iter()
          .map(|utterance| DeepgramUtteranceDto {
            start: utterance.start,
            end: utterance.end,
            speaker: utterance.speaker,
            transcript: utterance.transcript,
          })
          .collect(),
        transcript: file.transcript,
      })
      .collect(),
  )
}

/// Gemini の文字起こしの後片付け（変換した WAV と区切りを消す）。
#[tauri::command]
async fn release_audio(state: State<'_, AppState>, job_id: String) -> CommandResult<()> {
  safe_id(&job_id)?;
  if let Ok(mut jobs) = state.audio_jobs.lock() {
    jobs.remove(&job_id);
  }
  let dir = state.data_dir.join(AUDIO_PARTS_DIR).join(&job_id);
  let _ = tauri::async_runtime::spawn_blocking(move || std::fs::remove_dir_all(dir)).await;
  Ok(())
}

#[tauri::command]
async fn stop_transcribe(state: State<'_, AppState>, job_id: String) -> CommandResult<bool> {
  let deepgram = state
    .deepgram_jobs
    .lock()
    .ok()
    .and_then(|jobs| jobs.get(&job_id).cloned());
  if let Some(stop) = deepgram {
    stop.stop();
    return Ok(true);
  }
  let job = state
    .speech_jobs
    .lock()
    .ok()
    .and_then(|jobs| jobs.get(&job_id).cloned());
  match job {
    Some(job) => {
      tauri::async_runtime::spawn_blocking(move || job.stop()).await.ok();
      Ok(true)
    }
    None => Ok(false),
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioInfo {
  path: String,
  name: String,
  duration_sec: Option<f64>,
}

fn audio_infos(paths: Vec<PathBuf>) -> Vec<AudioInfo> {
  paths
    .into_iter()
    .filter(|path| path.is_file())
    .filter(|path| {
      path
        .extension()
        .map(|ext| AUDIO_EXTENSIONS.contains(&ext.to_string_lossy().to_lowercase().as_str()))
        .unwrap_or(false)
    })
    .map(|path| AudioInfo {
      name: path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default(),
      duration_sec: speech::audio_duration_sec(&path),
      path: path.to_string_lossy().into_owned(),
    })
    .collect()
}

/// ドロップされたファイルのうち音声だけの長さ。
#[tauri::command]
async fn audio_info(paths: Vec<String>) -> CommandResult<Vec<AudioInfo>> {
  let paths: Vec<PathBuf> = paths
    .into_iter()
    .map(PathBuf::from)
    .filter(|path| path.is_absolute())
    .collect();
  tauri::async_runtime::spawn_blocking(move || audio_infos(paths))
    .await
    .map_err(|_| CommandError::new("audio_failed", "音声を読めませんでした。"))
}

// ---------------------------------------------------------------------------
// 録音（#18590。recording.rs）

/// マイクの許可（`authorized`・`denied`・`notDetermined`・`restricted`）。`request` なら未決定のときに聞く（答えるまで返らない）。
#[tauri::command]
async fn mic_status(request: bool) -> CommandResult<String> {
  let binary = speech::resolve_speech_binary().ok_or(RecordingError::NotFound)?;
  tauri::async_runtime::spawn_blocking(move || speech::mic_status(&binary.path, request))
    .await
    .map_err(|_| CommandError::from(RecordingError::Failed))?
    .map_err(|_| RecordingError::Failed.into())
}

/// 録音を始める（app data の `recordings/<recordingId>.m4a`）。録り始めたら `{"device"}` を返す。行は `on_event`
/// （Started・Level。画面が止めずに終わったら Done か Error）。同時に 1 本まで（`recording_busy`）。
#[tauri::command]
async fn start_recording(
  state: State<'_, AppState>,
  recording_id: String,
  on_event: Channel<Value>,
) -> CommandResult<Value> {
  safe_id(&recording_id)?;
  let binary = speech::resolve_speech_binary().ok_or(RecordingError::NotFound)?;
  let recorder = state.recorder.clone();
  tauri::async_runtime::spawn_blocking(move || {
    recorder.start(&binary.path, &recording_id, move |value| {
      let _ = on_event.send(value);
    })
  })
  .await
  .map_err(|_| CommandError::from(RecordingError::Failed))?
  .map_err(CommandError::from)
}

/// 録音を止め、書き出した音声（名前は「録音 10/16 15:30」）を返す。書き出せなかったときは録音中の CAF を返す。
#[tauri::command]
async fn stop_recording(state: State<'_, AppState>, recording_id: String) -> CommandResult<RecordingInfo> {
  safe_id(&recording_id)?;
  let recorder = state.recorder.clone();
  tauri::async_runtime::spawn_blocking(move || recorder.stop(&recording_id))
    .await
    .map_err(|_| CommandError::from(RecordingError::Failed))?
    .map_err(CommandError::from)
}

/// 録音を捨てる（録音中なら止める）。案件に写した録音も、保存の後で画面がこれで消す。
#[tauri::command]
async fn discard_recording(state: State<'_, AppState>, recording_id: String) -> CommandResult<()> {
  safe_id(&recording_id)?;
  let recorder = state.recorder.clone();
  tauri::async_runtime::spawn_blocking(move || recorder.discard(&recording_id))
    .await
    .map_err(|_| CommandError::from(RecordingError::Failed))?
    .map_err(CommandError::from)
}

/// 案件に写していない録音（前回の録音。古い順）。
#[tauri::command]
async fn leftover_recordings(state: State<'_, AppState>) -> CommandResult<Vec<RecordingInfo>> {
  let recorder = state.recorder.clone();
  tauri::async_runtime::spawn_blocking(move || recorder.leftovers())
    .await
    .map_err(|_| CommandError::from(RecordingError::Failed))
}

/// システム設定のマイクの許可の画面を開く（固定の URL だけ。画面から URL を受け取らない）。
#[tauri::command]
async fn open_microphone_settings() -> CommandResult<()> {
  std::process::Command::new("/usr/bin/open")
    .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
    .status()
    .ok()
    .filter(|status| status.success())
    .map(|_| ())
    .ok_or_else(|| CommandError::new("open_failed", "システム設定を開けませんでした。"))
}

/// 録音中に窓を閉じようとして、画面で「止めて閉じる」を選んだとき: 録音を止めて書き出してから窓を閉じる
/// （録音は次に録音ページを開いたときに「前回の録音」として足せる）。
#[tauri::command]
async fn close_after_recording(window: tauri::Window, state: State<'_, AppState>) -> CommandResult<()> {
  let recorder = state.recorder.clone();
  let _ = tauri::async_runtime::spawn_blocking(move || recorder.stop_for_exit(RECORDING_CLOSE_WAIT)).await;
  window
    .close()
    .map_err(|_| CommandError::new("close_failed", "窓を閉じられませんでした。"))
}

// ---------------------------------------------------------------------------
// ファイルの選択・書き出し・Finder・コピー

#[tauri::command]
async fn pick_audio_files() -> CommandResult<Vec<AudioInfo>> {
  let picked = rfd::AsyncFileDialog::new()
    .set_title("音声を追加")
    .add_filter("音声", &AUDIO_EXTENSIONS)
    .pick_files()
    .await
    .map(|files| files.iter().map(|file| file.path().to_path_buf()).collect::<Vec<_>>())
    .unwrap_or_default();
  tauri::async_runtime::spawn_blocking(move || audio_infos(picked))
    .await
    .map_err(|_| CommandError::new("audio_failed", "音声を読めませんでした。"))
}

#[tauri::command]
async fn pick_image_asset(state: State<'_, AppState>, project_id: Option<String>) -> CommandResult<Option<String>> {
  let picked = rfd::AsyncFileDialog::new()
    .set_title("画像を追加")
    .add_filter("画像", &["jpg", "jpeg", "png", "webp"])
    .pick_file()
    .await;
  let Some(file) = picked else {
    return Ok(None);
  };
  let source = file.path().to_path_buf();
  let store = state.store();
  tauri::async_runtime::spawn_blocking(move || store.import_page_image_asset(project_id.as_deref(), &source))
    .await
    .map_err(|_| CommandError::new("store_io", "画像を追加できませんでした。"))?
    .map(Some)
    .map_err(CommandError::from)
}

#[tauri::command]
async fn read_image_asset(
  state: State<'_, AppState>,
  project_id: Option<String>,
  name: String,
) -> CommandResult<String> {
  let store = state.store();
  tauri::async_runtime::spawn_blocking(move || store.read_page_image_asset(project_id.as_deref(), &name))
    .await
    .map_err(|_| CommandError::new("store_io", "画像を読めませんでした。"))?
    .map_err(CommandError::from)
}

/// お手本の文書を選ぶ（複数。取り消しは空）。
#[tauri::command]
async fn pick_sample_files() -> CommandResult<Vec<String>> {
  Ok(
    rfd::AsyncFileDialog::new()
      .set_title("お手本の文書を追加")
      .add_filter("文書", &samples::SAMPLE_EXTENSIONS)
      .pick_files()
      .await
      .map(|files| {
        files
          .iter()
          .map(|file| file.path().to_string_lossy().into_owned())
          .collect()
      })
      .unwrap_or_default(),
  )
}

#[tauri::command]
async fn pick_docs_root() -> CommandResult<Option<String>> {
  Ok(
    rfd::AsyncFileDialog::new()
      .set_title("保存先")
      .pick_folder()
      .await
      .map(|folder| folder.path().to_string_lossy().into_owned()),
  )
}

#[tauri::command]
async fn save_markdown_as(file_name: String, markdown: String) -> CommandResult<Option<String>> {
  let Some(file) = rfd::AsyncFileDialog::new()
    .set_title("書き出し")
    .set_file_name(&file_name)
    .add_filter("Markdown", &["md"])
    .save_file()
    .await
  else {
    return Ok(None);
  };
  let mut path = file.path().to_path_buf();
  if path.extension().map(|ext| ext != "md").unwrap_or(true) {
    path.set_extension("md");
  }
  std::fs::write(&path, markdown).map_err(|_| CommandError::new("export_failed", "書き出せませんでした。"))?;
  Ok(Some(path.to_string_lossy().into_owned()))
}

fn open_in_finder(args: &[&std::ffi::OsStr]) -> CommandResult<()> {
  std::process::Command::new("/usr/bin/open")
    .args(args)
    .status()
    .ok()
    .filter(|status| status.success())
    .map(|_| ())
    .ok_or_else(|| CommandError::new("reveal_failed", "Finder で表示できませんでした。"))
}

#[tauri::command]
async fn reveal_root(state: State<'_, AppState>) -> CommandResult<()> {
  let root = state.docs_root();
  std::fs::create_dir_all(&root).map_err(|_| CommandError::new("reveal_failed", "Finder で表示できませんでした。"))?;
  open_in_finder(&[root.as_os_str()])
}

#[tauri::command]
async fn reveal_artifact(
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
  step_id: String,
  source: bool,
) -> CommandResult<()> {
  let path = state
    .store()
    .artifact_path_at(project_id.as_deref(), &recording_id, &step_id, source)?;
  open_in_finder(&[std::ffi::OsStr::new("-R"), path.as_os_str()])
}

/// 文書のページの .md を Finder で表示する（「書き出し › Finder で表示」）。
#[tauri::command]
async fn reveal_page(state: State<'_, AppState>, project_id: Option<String>, page_id: String) -> CommandResult<()> {
  let path = state.store().page_markdown_path_at(project_id.as_deref(), &page_id)?;
  open_in_finder(&[std::ffi::OsStr::new("-R"), path.as_os_str()])
}

#[tauri::command]
async fn copy_text(text: String) -> CommandResult<()> {
  use std::io::Write;
  let mut child = std::process::Command::new("/usr/bin/pbcopy")
    .stdin(std::process::Stdio::piped())
    .spawn()
    .map_err(|_| CommandError::new("copy_failed", "コピーできませんでした。"))?;
  if let Some(mut stdin) = child.stdin.take() {
    stdin
      .write_all(text.as_bytes())
      .map_err(|_| CommandError::new("copy_failed", "コピーできませんでした。"))?;
  }
  child
    .wait()
    .ok()
    .filter(|status| status.success())
    .map(|_| ())
    .ok_or_else(|| CommandError::new("copy_failed", "コピーできませんでした。"))
}

// ---------------------------------------------------------------------------

/// 開発・試験の起動か: debug ビルド（`tauri dev`）か、CLI・音声認識を環境変数で差し替えた起動（`dev:fake`・偽物を指す
/// 試験用のビルド）。本番の app data（設定・アプリ用の CODEX_HOME・会話の作業フォルダ）と保存先（~/Documents/NIHO docs）・
/// ログ・旧い Keychain の鍵を使わない。2026-10-16 に偽物を指す開発版が本番の app data の codex-home に書き、owner が本番の窓で
/// 進めていた Codex のログインと重なった（#18385）。
fn is_dev_launch() -> bool {
  cfg!(debug_assertions)
    || [
      local_ai::CLAUDE_PATH_ENV,
      local_ai::CODEX_PATH_ENV,
      local_ai::AGY_PATH_ENV,
      speech::SPEECH_PATH_ENV,
    ]
    .iter()
    .any(|key| std::env::var(key).is_ok_and(|value| !value.trim().is_empty()))
}

/// app data: 環境変数 → OS の app data（`life.niho.docs`）。開発・試験の起動は隣の `life.niho.docs.dev`。
fn data_dir_for(env_dir: Option<&str>, app_data_dir: PathBuf, dev: bool) -> PathBuf {
  if let Some(dir) = env_dir.map(str::trim).filter(|dir| !dir.is_empty()) {
    return PathBuf::from(dir);
  }
  if !dev {
    return app_data_dir;
  }
  let name = app_data_dir
    .file_name()
    .map(|name| format!("{}.dev", name.to_string_lossy()))
    .unwrap_or_else(|| "life.niho.docs.dev".to_string());
  app_data_dir.with_file_name(name)
}

/// 保存先の既定（設定・環境変数で決めていないとき）。
fn default_docs_root(home: &Path, dev: bool) -> PathBuf {
  home
    .join("Documents")
    .join(if dev { DEV_DOCS_ROOT_NAME } else { "NIHO docs" })
}

fn resolve_data_dir(app: &tauri::App, dev: bool) -> PathBuf {
  let app_data_dir = app
    .path()
    .app_data_dir()
    .unwrap_or_else(|_| std::env::temp_dir().join("life.niho.docs"));
  data_dir_for(std::env::var(DATA_DIR_ENV).ok().as_deref(), app_data_dir, dev)
}

fn stop_everything(state: &AppState) {
  // 録音は止めて書き出しを待つ（待ち切れなくても sidecar は書き出しを続け、次に開いたときに「前回の録音」になる）
  state.recorder.stop_for_exit(RECORDING_EXIT_WAIT);
  // 実行中の工程（SIGTERM → 800ms → SIGKILL）とブラウザ待ちのログインを止める。止めないと閉じたアプリの CLI が孤児として残る
  state.runner.shutdown();
  let jobs: Vec<Arc<SpeechJob>> = state
    .speech_jobs
    .lock()
    .map(|jobs| jobs.values().cloned().collect())
    .unwrap_or_default();
  for job in jobs {
    job.stop();
  }
  if let Ok(jobs) = state.deepgram_jobs.lock() {
    for stop in jobs.values() {
      stop.stop();
    }
  }
  // 本人 Mac 実行の operation の実行のロックは、捕捉した Store で放す（通信はしない）
  personal_run::release_on_exit(state);
  // この窓が持っていた実行のロックを放す
  let locks: Vec<String> = state
    .run_locks
    .lock()
    .map(|locks| locks.iter().cloned().collect())
    .unwrap_or_default();
  let store = state.store();
  for project_id in locks {
    let _ = if project_id == OUTSIDE_LOCK_KEY {
      store.release_run_lock_at(None)
    } else {
      store.release_run_lock_at(Some(&project_id))
    };
  }
  // Gemini の文字起こしの WAV を消す
  let audio: Vec<PathBuf> = state
    .audio_jobs
    .lock()
    .map(|mut jobs| jobs.drain().map(|(_, prepared)| prepared.dir.clone()).collect())
    .unwrap_or_default();
  for dir in audio {
    let _ = std::fs::remove_dir_all(dir);
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let context = tauri::generate_context!();
  let dev = is_dev_launch();
  // 自動更新は release ビルドで、tauri.conf.json の updater の公開鍵を差し替えてから（それまでは plugin を入れない）。
  // 開発・試験の起動は本番の版へ差し替わらないよう切る
  let updates = updater::enabled(context.config()) && !dev;
  // Mac へのログイン時の起動（「この Mac で続きを受ける」。resident.rs）は窓を出さない
  let background = resident::is_background_launch(std::env::args());
  let account_env = niho_desktop_account::Environment::new(
    niho_desktop_account::ClientId::Docs,
    niho_desktop_account::EnvKind::from_build_env(option_env!("NIHO_ACCOUNT_ENV")),
    env!("NIHO_FIREBASE_API_KEY"),
  );
  // deep link の起動時 URL だけ先に読む。認証と同期は排他が決まるまで始めない。
  let builder = tauri::Builder::default().plugin(niho_desktop_account::tauri::deep_link());
  // 同じ保存領域を使うコピー・旧版も含めて 1 つだけ。
  #[cfg(target_os = "macos")]
  let builder = builder.plugin(single_instance::init(dev));
  let mut builder = builder.plugin(niho_desktop_account::tauri::init(account_env));
  if updates {
    builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
  }
  builder
    .setup(move |app| {
      let data_dir = resolve_data_dir(app, dev);
      let _ = std::fs::create_dir_all(&data_dir);
      // 一時置き場（設計 §13）の古い残骸を掃く
      let _ = staging::Staging::new(&data_dir).sweep(staging::SWEEP_AFTER);
      if dev {
        if let Some(window) = app.get_webview_window("main") {
          let _ = window.set_title(DEV_WINDOW_TITLE);
        }
      }
      // Mac の殻（設計 §13）: 配布版は editor.niho.life を既定で読む。NIHO_DOCS_SHELL=local で同梱画面へ戻せる。
      // URL は shell.rs の定数だけ。remote から呼べるコマンドは capabilities/remote-editor.json で決まる。
      let shell_mode = shell::shell_mode(std::env::var(shell::SHELL_ENV).ok().as_deref(), dev);
      if let Some(url) = shell::remote_url(shell_mode) {
        if let Some(window) = app.get_webview_window("main") {
          if let Err(error) = window.navigate(url) {
            eprintln!("shell: could not open the editor screen: {error}");
          }
        }
      }
      conversation::cleanup_stale_chat_workspaces(&data_dir);
      // CLI 実行基盤は起動時に 1 つ作る（CLI の場所の上書きは設定の cliPaths と環境変数。変えたらアプリを開き直す）
      let settings = std::fs::read_to_string(data_dir.join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
      // 開発・試験の起動のログは本番の local-ai.log に混ぜない
      let log_dir = if dev {
        data_dir.join("logs")
      } else {
        app.path().app_log_dir().unwrap_or_else(|_| data_dir.join("logs"))
      };
      let log = local_ai::file_log(log_dir);
      let runtime = local_ai::runtime_for(
        &data_dir,
        local_ai::cli_path_overrides(settings.as_ref()),
        Some(log.clone()),
      );
      // API キー方式: 鍵は app data の api-keys/（0600。以前の版の Keychain の鍵は初めて要るときに 1 回だけ移す。#18769）。
      // 診断ログは CLI と同じ local-ai.log
      let api = Arc::new(api_ai::ApiAiRunner::new(
        niho_api_ai::Config {
          endpoints: niho_api_ai::Endpoints::default(),
          log: Some(log.clone()),
        },
        Arc::new(secrets::app_store(&data_dir, dev, Some(log.clone()))),
      ));
      app.manage(AppState {
        runner: Arc::new(api_ai::ProviderRouter {
          local: Arc::new(local_ai::LocalAiRunner::new(runtime)),
          api: api.clone(),
        }),
        turns: Mutex::new(HashMap::new()),
        speech_jobs: Mutex::new(HashMap::new()),
        run_locks: Mutex::new(HashSet::new()),
        audio_jobs: Mutex::new(HashMap::new()),
        api,
        deepgram_jobs: Mutex::new(HashMap::new()),
        recorder: Arc::new(Recorder::new(data_dir.join(recording::RECORDINGS_DIR))),
        personal_ops: Mutex::new(HashMap::new()),
        pc_gate: pc_runner::Gate::default(),
        data_dir: data_dir.clone(),
        dev,
      });
      // NIHO クラウドの保管庫（C3 #18595）: 保存の口を画面の最初の書き込みより前に入れ、journal の回復を始める
      let docs_root = app.state::<AppState>().docs_root();
      app.manage(cloud::Cloud::start(app.handle(), &data_dir, &docs_root, dev));
      app.manage(updater::UpdateState::new(updates, log.clone()));
      if updates {
        updater::check_in_background(app.handle());
      }
      // この Mac で続きを受ける（#18804）: ON ならメニューバーとログイン時の起動を入れ、窓と関係なく裏で受け取りを始める
      app.manage(resident::Tray::default());
      let pc = pc_runner::PcRunner::start(app.handle(), log.clone());
      let resident_on = pc.enabled();
      app.manage(pc);
      if updates {
        // 常駐中は、窓を隠していて何も動いていないときに取得した新しい版へ自動で再起動する（#18823）
        spawn_idle_update_restart(app.handle().clone(), log.clone());
      }
      if background && !resident_on {
        // OFF にした後に残っていたログイン時の起動: 登録を外して、窓を出さずに終える
        resident::remove_launch_agent(dev, &log);
        app.handle().exit(0);
      } else if background {
        resident::stay_in_menu_bar(app.handle());
      } else if let Some(window) = app.get_webview_window("main") {
        // 窓は設定で隠して作る（ログイン時の起動では出さない）。ふつうの起動はここで出す
        let _ = window.show();
      }
      Ok(())
    })
    .on_window_event(|window, event| {
      // 録音中は窓を閉じずに画面へ知らせる（画面が確かめて、止めるなら close_after_recording）
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let recording = window
          .app_handle()
          .try_state::<AppState>()
          .is_some_and(|state| state.recorder.is_recording());
        if recording {
          api.prevent_close();
          let _ = window.emit(RECORDING_CLOSE_EVENT, ());
          return;
        }
        // この Mac で続きを受けている間は終えずに、窓を隠してメニューバーに残る（resident.rs）
        let resident_on = window
          .app_handle()
          .try_state::<pc_runner::PcRunner>()
          .is_some_and(|pc| pc.enabled());
        if resident_on && window.label() == "main" {
          api.prevent_close();
          resident::hide_to_menu_bar(window);
        }
      }
    })
    .invoke_handler(tauri::generate_handler![
      shell::shell_capabilities,
      shell::shell_mic_status,
      shell::shell_recording_start,
      shell::shell_recording_stop,
      shell::shell_recording_discard,
      shell::shell_recording_read,
      shell::shell_audio_pick,
      shell::shell_audio_read,
      shell::shell_staging_discard,
      shell::shell_transcribe_local,
      shell::shell_transcribe_stop,
      shell_ai::shell_ai_engines,
      shell_ai::shell_ai_turn,
      shell_ai::shell_ai_stop,
      app_paths,
      load_settings,
      save_settings,
      list_flows,
      save_flow,
      duplicate_flow,
      delete_flow,
      set_last_used_flow,
      flow_usage,
      load_about,
      save_about,
      load_execution,
      save_execution,
      import_samples,
      fetch_sample_url,
      save_sample_url,
      read_sample,
      prune_samples,
      list_projects,
      load_pages,
      save_project_order,
      reorder_project,
      delete_empty_folder,
      load_recent,
      touch_recent,
      create_project,
      import_audio,
      load_project,
      save_project,
      load_recording,
      save_recording,
      create_candidate,
      rename_candidate,
      set_source_candidate,
      set_recording_text,
      import_transcript,
      create_page,
      rename_page,
      delete_page,
      read_page,
      write_page,
      move_page,
      save_artifact,
      append_run,
      read_version,
      save_checkpoint,
      read_checkpoint,
      acquire_run_lock,
      release_run_lock,
      list_all_runs,
      run_turn,
      stop_turn,
      provider_status,
      provider_usage,
      conversation::run_chat_turn,
      conversation::artifact_states,
      conversation::read_artifact,
      conversation::revert_artifact,
      conversation::list_conversations,
      conversation::save_conversation,
      start_auth,
      install_claude,
      update_claude,
      api_key_status,
      save_api_key,
      check_api_key,
      delete_api_key,
      speech_status,
      speech_download,
      transcribe,
      prepare_audio,
      transcribe_audio_part,
      release_audio,
      transcribe_deepgram,
      stop_transcribe,
      audio_info,
      audio_file_paths,
      mic_status,
      start_recording,
      stop_recording,
      discard_recording,
      leftover_recordings,
      open_microphone_settings,
      close_after_recording,
      pick_audio_files,
      pick_image_asset,
      read_image_asset,
      pick_sample_files,
      pick_docs_root,
      save_markdown_as,
      reveal_root,
      reveal_artifact,
      reveal_page,
      copy_text,
      google_docs::docs_account_available,
      google_docs::docs_drive_connection,
      google_docs::docs_drive_connect,
      google_docs::docs_drive_disconnect,
      google_docs::docs_drive_export,
      google_docs::docs_drive_export_status,
      google_docs::docs_drive_open_document,
      google_docs::docs_drive_folder_export_plan,
      google_docs::docs_drive_folder_export_local_plan,
      google_docs::docs_drive_folder_export_local_snapshot,
      google_docs::docs_drive_folder_export_local_text,
      google_docs::docs_drive_folder_export_local,
      google_docs::docs_drive_folder_export,
      google_docs::docs_drive_folder_export_status,
      google_docs::docs_drive_folder_export_resume,
      updater::update_status,
      restart_to_update,
      cloud::cloud_state,
      cloud::cloud_storage_select,
      cloud::cloud_storage_reopening_preview,
      cloud::cloud_storage_reopen,
      cloud::cloud_storage_closing_preview,
      cloud::cloud_storage_closing_prepare,
      cloud::cloud_storage_closing_confirm,
      cloud::cloud_storage_closing_cancel,
      cloud::open_page_document,
      cloud::open_artifact_document,
      cloud::save_opened_document,
      cloud::save_opened_artifact,
      cloud::release_opened_document,
      cloud::cloud_set_provider,
      cloud::cloud_set_device_name,
      cloud::cloud_project_status,
      cloud::cloud_page_share_get,
      cloud::cloud_page_share_set,
      cloud::cloud_page_share_rotate,
      cloud::cloud_page_share_open,
      cloud::cloud_remote_projects,
      cloud::cloud_deleted_projects,
      cloud::cloud_open_project,
      cloud::cloud_restore_project,
      cloud::cloud_tombstone_choice,
      cloud::cloud_sync_now,
      cloud::cloud_focus,
      cloud::cloud_protect,
      cloud::cloud_release,
      cloud::cloud_conflicts,
      cloud::cloud_conflict_copy,
      cloud::cloud_resolve_conflict,
      cloud::cloud_usage,
      cloud::cloud_migration_start,
      cloud::cloud_migration_cancel,
      cloud::write_artifact_draft,
      personal_run::personal_open,
      personal_run::personal_cancel,
      personal_run::personal_close,
      personal_run::personal_guard,
      personal_run::personal_reserve_intent,
      personal_run::personal_mark_dispatch,
      personal_run::personal_mark_intent,
      personal_run::personal_save_private,
      personal_run::personal_read_material,
      personal_run::personal_swap_models,
      personal_run::personal_verify_inputs,
      personal_run::personal_persist_candidate,
      personal_run::personal_publish,
      personal_run::personal_record,
      personal_run::niho::personal_niho_ensure_idle,
      personal_run::niho::personal_niho_access,
      personal_run::niho::personal_niho_submit,
      personal_run::niho::personal_niho_confirm,
      personal_run::niho::personal_niho_pending,
      personal_run::device::personal_device_generate,
      personal_run::device::personal_device_ack,
      personal_run::device::personal_device_recover_acks,
      pc_runner::pc_runner_status,
      pc_runner::pc_runner_set_enabled
    ])
    .build(context)
    .expect("error while building NIHO docs")
    .run(|app, event| match event {
      // 最後の窓が閉じた（画面が書きかけを保存してから窓を壊した）: 続きを受けている間は終えずにメニューバーに残る。
      // ⌘Q（RunEvent::Exit へ直接）・「終了」（code あり）・更新の再起動は止めない
      tauri::RunEvent::ExitRequested { code: None, api, .. } => {
        if app.try_state::<pc_runner::PcRunner>().is_some_and(|pc| pc.enabled()) {
          api.prevent_exit();
          resident::stay_in_menu_bar(app);
        }
      }
      // Dock・Finder からもう一度開いた: 窓を出す（壊れていれば作り直す）
      #[cfg(target_os = "macos")]
      tauri::RunEvent::Reopen { .. } => resident::show_main_window(app),
      tauri::RunEvent::Exit => {
        // 別の NIHO docs が工程を実行しているか（読めなければ実行中とみなし、.app を差し替えない）
        let mut another_app_running = true;
        if let Some(state) = app.try_state::<AppState>() {
          stop_everything(&state);
          another_app_running = state.store().has_run_lock_of_another_process().unwrap_or(true);
        }
        // 同期 engine を止める（通信は待たない。送っていない変更は次に開いたときに送る）
        if let Some(cloud) = app.try_state::<cloud::Cloud>() {
          cloud.shutdown();
        }
        // 取得した新しい版は、工程・文字起こしを止めた後で .app を差し替える（request_restart ならこの後で新しい版が開く）
        if let Some(update) = app.try_state::<updater::UpdateState>() {
          update.install_on_exit(another_app_running);
        }
        // 常駐中の自動更新（#18823）: 差し替えた新しい版を、窓を出さずに起動し直す
        if resident::take_background_relaunch() {
          #[cfg(target_os = "macos")]
          single_instance::release_for_background_relaunch(app);
          resident::relaunch_in_background();
        }
      }
      _ => {}
    });
}

#[cfg(test)]
mod acl_tests;

/// 画面（apps/docs/src/lib/bridge.ts と packages/docs-core の turn.ts）が送る・受け取る JSON の形。
#[cfg(test)]
mod wire_tests {
  use super::*;

  #[test]
  fn turn_request_from_the_web_uses_contract_names() {
    let request: TurnRequestWire = serde_json::from_value(json!({
      "provider": "ClaudeCode",
      "model": "sonnet",
      "effort": "High",
      "system_prompt": "決まり",
      "user_prompt": "## 文章",
      "resume_session": null,
      "workspace": "run-abc",
      "max_budget_usd": null,
    }))
    .unwrap();
    assert_eq!(request.provider, Provider::ClaudeCode);
    assert_eq!(request.effort, Some(Effort::High));
    assert_eq!(request.resume_session, None);
    let resumed: TurnRequestWire = serde_json::from_value(json!({
      "provider": "ClaudeCode",
      "model": "opus",
      "effort": null,
      "system_prompt": "",
      "user_prompt": "続き",
      "resume_session": "11111111-2222-4333-8444-555555555555",
      "workspace": "run-abc",
      "max_budget_usd": 1.5,
    }))
    .unwrap();
    assert_eq!(resumed.effort, None);
    assert_eq!(resumed.max_budget_usd, Some(1.5));
  }

  #[test]
  fn audio_part_requests_and_prepared_files_use_the_web_field_names() {
    let request: AudioPartRequestWire = serde_json::from_value(json!({
      "provider": "GeminiCli",
      "model": "gemini-3.8-flash",
      "effort": "Low",
      "system_prompt": "あなたは録音を正確に書き起こす担当者です。",
      "user_prompt": "part を読む",
    }))
    .unwrap();
    assert_eq!(request.provider, Provider::GeminiCli);
    assert_eq!(request.effort, Some(Effort::Low));
    let prepared = serde_json::to_value(vec![PreparedFileDto {
      duration_sec: 95.0,
      parts: vec![AudioPartDto {
        start_sec: 0.0,
        end_sec: 48.0,
        sound_sec: 42.0,
      }],
    }])
    .unwrap();
    assert_eq!(
      prepared,
      json!([{ "durationSec": 95.0, "parts": [{ "startSec": 0.0, "endSec": 48.0, "soundSec": 42.0 }] }])
    );
  }

  #[test]
  fn api_key_and_deepgram_payloads_use_the_web_field_names() {
    let request: AudioPartRequestWire = serde_json::from_value(json!({
      "provider": "GeminiApi",
      "model": "gemini-3.8-flash",
      "effort": "Low",
      "system_prompt": "s",
      "user_prompt": "添付の音声を書き起こしてください。",
    }))
    .unwrap();
    assert_eq!(request.provider, Provider::GeminiApi);
    let deepgram: DeepgramRequestWire = serde_json::from_value(json!({
      "language": "ja",
      "diarize": true,
      "keyterms": ["NIHO鎌倉"],
    }))
    .unwrap();
    assert!(deepgram.diarize && deepgram.keyterms == vec!["NIHO鎌倉".to_string()]);
    let result = serde_json::to_value(DeepgramFileDto {
      duration_sec: Some(12.0),
      utterances: vec![DeepgramUtteranceDto {
        start: 1.0,
        end: 3.0,
        speaker: Some(0),
        transcript: "こんにちは".into(),
      }],
      transcript: String::new(),
    })
    .unwrap();
    assert_eq!(
      result,
      json!({ "durationSec": 12.0, "utterances": [{ "start": 1.0, "end": 3.0, "speaker": 0, "transcript": "こんにちは" }], "transcript": "" })
    );
    let status = serde_json::to_value(api_ai::ApiKeyStatus {
      saved: true,
      last4: Some("abcd".into()),
      valid: Some(true),
      models: vec!["claude-sonnet-4-6".into()],
      reason: None,
      message: None,
    })
    .unwrap();
    assert_eq!(
      status,
      json!({ "saved": true, "last4": "abcd", "valid": true, "models": ["claude-sonnet-4-6"], "reason": null, "message": null })
    );
    assert!(api_account("openai").is_ok());
    assert!(api_account("../x").is_err());
  }

  #[test]
  fn responses_use_the_web_field_names() {
    let status = serde_json::to_value(SpeechStatus {
      found: true,
      fake: true,
      available: true,
      needs_download: false,
      engine: Some("fake".into()),
      error: None,
      notice: Some(speech::STAND_IN_NOTICE.into()),
      diarization: DiarizationStatus {
        state: "ready".into(),
        detail: None,
      },
      unsupported: None,
    })
    .unwrap();
    assert_eq!(
      status,
      json!({ "found": true, "fake": true, "available": true, "needsDownload": false, "engine": "fake", "error": null, "notice": speech::STAND_IN_NOTICE, "diarization": { "state": "ready", "detail": null }, "unsupported": null })
    );
    let transcript = serde_json::to_value(FileTranscriptDto {
      jsonl: "{}".into(),
      duration_sec: 95.0,
    })
    .unwrap();
    assert_eq!(transcript, json!({ "jsonl": "{}", "durationSec": 95.0 }));
    let paths = serde_json::to_value(AppPaths {
      docs_root: "/r".into(),
      data_dir: "/d".into(),
    })
    .unwrap();
    assert_eq!(paths, json!({ "docsRoot": "/r", "dataDir": "/d" }));
    let error = serde_json::to_value(CommandError::new("c", "m")).unwrap();
    assert_eq!(error, json!({ "code": "c", "message": "m" }));
  }

  #[test]
  fn sample_imports_use_the_web_field_names() {
    let sample = |truncated_from| FlowSample {
      id: "k7m2q9xa".into(),
      name: "記事.docx".into(),
      chars: 30_000,
      truncated_from,
      source_url: None,
    };
    let imported = serde_json::to_value(SampleImportResult {
      name: "記事.docx".into(),
      sample: Some(sample(None)),
      error: None,
    })
    .unwrap();
    assert_eq!(
      imported,
      json!({ "name": "記事.docx", "sample": { "id": "k7m2q9xa", "name": "記事.docx", "chars": 30000 }, "error": null })
    );
    let truncated = serde_json::to_value(sample(Some(41_000))).unwrap();
    assert_eq!(truncated["truncatedFrom"], 41_000);
    let failed = serde_json::to_value(SampleImportResult {
      name: "古い.doc".into(),
      sample: None,
      error: Some(StoreError::from(samples::UNSUPPORTED).into()),
    })
    .unwrap();
    assert_eq!(
      failed,
      json!({ "name": "古い.doc", "sample": null, "error": { "code": "sample_unsupported", "message": samples::UNSUPPORTED.message } })
    );
  }

  #[test]
  fn ids_are_limited_to_safe_characters() {
    assert!(safe_id("turn-0b6c6d1e-6a8e-4c4a-9f5b-2b2f4f0e8c11").is_ok());
    assert!(safe_id("../x").is_err());
    assert!(safe_id("").is_err());
  }
}

/// 開発・試験の起動の置き場（本番の app data・保存先を使わない）。
#[cfg(test)]
mod dev_launch_tests {
  use super::*;

  #[test]
  fn dev_launches_use_a_sibling_app_data_dir_and_a_separate_docs_root() {
    let app_data = PathBuf::from("/Users/u/Library/Application Support/life.niho.docs");
    // 本番: OS の app data と ~/Documents/NIHO docs
    assert_eq!(data_dir_for(None, app_data.clone(), false), app_data);
    assert_eq!(
      default_docs_root(Path::new("/Users/u"), false),
      PathBuf::from("/Users/u/Documents/NIHO docs")
    );
    // 開発・試験: 隣の life.niho.docs.dev と ~/Documents/NIHO docs dev
    assert_eq!(
      data_dir_for(None, app_data.clone(), true),
      PathBuf::from("/Users/u/Library/Application Support/life.niho.docs.dev")
    );
    assert_eq!(
      default_docs_root(Path::new("/Users/u"), true),
      PathBuf::from("/Users/u/Documents/NIHO docs dev")
    );
    // 環境変数で決めたら、どちらでもそれを使う（空白だけは無視）
    assert_eq!(
      data_dir_for(Some(" /tmp/docs-data "), app_data.clone(), true),
      PathBuf::from("/tmp/docs-data")
    );
    assert_eq!(data_dir_for(Some("  "), app_data.clone(), false), app_data);
  }
}
