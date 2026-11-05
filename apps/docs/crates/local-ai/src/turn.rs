//! 1 回の実行（工程の 1 往復）。入力の検査 → CLI を探す → 同時実行の登録 → CLI ごとの実行 → 最後のイベントを 1 回だけ送る。

use crate::classify::error_event;
use crate::process::{
  is_uuid, register_running_turn, sanitize_stderr_tail, sweep_stale_private_dirs, ChildExit, RunningTurn,
};
use crate::runtime::{provider_command, resolve_cli, Runtime};
use crate::types::{Provider, ReasonCode, StopReason, ToolPolicy, TurnEvent, TurnRequest, Usage};
use crate::{agy, claude, codex};
use serde_json::{json, Value};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// 指示の上限（標準入力で渡す）。
pub const MAX_USER_PROMPT_BYTES: usize = 4_000_000;
/// システムプロンプトの上限（codex は argv に載るため）。
pub const MAX_SYSTEM_PROMPT_BYTES: usize = 200_000;
/// モデル名の長さの上限（文字数）。
const MAX_MODEL_CHARS: usize = 128;
/// 時間上限の上限。これより長い指定は丸める（Instant の足し算があふれないように）。
const MAX_TURN_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);
/// 書ける相対フォルダの数と長さの上限（claude の `--allowedTools` に載る）。
const MAX_WRITABLE_DIRS: usize = 8;
const MAX_WRITABLE_DIR_CHARS: usize = 128;
const PROJECT_FOLDER_MISSING_MESSAGE: &str = "作業フォルダが見つかりません。";
const CODEX_PROJECT_FOLDER_MESSAGE: &str = "Codex の書き込み先を 1 つのフォルダに限定できません。";
/// Antigravity CLI は書き先を `writable` の下の `.md` に限って確かめるので、書き込み先（`.` で始まらないフォルダ）が要る。
pub(crate) const AGY_PROJECT_FOLDER_MESSAGE: &str = "Antigravity CLI の書き込み先のフォルダを決められません。";
/// Antigravity CLI は作業フォルダの決まり（`.agents`・`AGENTS.md`・`GEMINI.md`）を読むので、あれば起動しない。
pub(crate) const AGY_FOLDER_RULES_MESSAGE: &str =
  "作業フォルダに Antigravity CLI が読む決まり（.agents・AGENTS.md・GEMINI.md）があるため起動しませんでした。";
/// ファイルを読ませる実行（音声の区切りの文字起こし）は Antigravity CLI だけ。
pub(crate) const READ_FILE_PROVIDER_MESSAGE: &str =
  "ファイルを読ませる実行は Antigravity CLI（Gemini）だけで使えます。";
const READ_FILE_MISSING_MESSAGE: &str = "読ませるファイルが見つかりません。";
const READ_FILE_RESUME_MESSAGE: &str = "ファイルを読ませる実行は、同じ会話で続けられません。";
/// 読ませるファイルの名前の長さの上限（作業フォルダに同じ名前で写し、指示文で指す）。
const MAX_READ_FILE_NAME_CHARS: usize = 128;

/// 実行中の 1 回への手綱。止める・終わったか見る・終わるまで待つ。
pub struct TurnHandle {
  running: Arc<RunningTurn>,
  kill_grace: Duration,
  thread: JoinHandle<()>,
}

impl TurnHandle {
  /// 実行中の子プロセスへ止める合図（SIGTERM → 猶予 → SIGKILL）を出せたら true（もう終わっていれば false）。
  /// 止めた実行は `Done { stop_reason: Stopped, text: ここまでの文 }` で終わる。
  pub fn stop(&self) -> bool {
    if !self.running.request_stop() {
      return false;
    }
    self.running.terminate(self.kill_grace);
    true
  }

  /// 最後のイベントを `on_event` に渡し終えたか。
  pub fn is_finished(&self) -> bool {
    self.thread.is_finished()
  }

  /// 最後のイベントを `on_event` に渡し終えるまで待つ。
  pub fn wait(self) {
    let _ = self.thread.join();
  }
}

/// 既定の実行環境で 1 回実行する。[`run_turn_with`] を見る。
pub fn run_turn(req: TurnRequest, on_event: impl FnMut(TurnEvent) + Send + 'static) -> TurnHandle {
  run_turn_with(&Runtime::default(), req, on_event)
}

/// 1 回実行する。必ず別スレッドで動き、`on_event` もそのスレッドから呼ぶ（入力の誤りでも即座には呼ばず、
/// スレッドの中で Error を 1 回送る）。最後に `Done` か `Error` がちょうど 1 回届き、その後は何も届かない。
/// 最後のイベントを送る時点で、子プロセスの回収・一時ファイルの消去・同時実行の登録の解除は済んでいる。
pub fn run_turn_with(
  runtime: &Runtime,
  req: TurnRequest,
  on_event: impl FnMut(TurnEvent) + Send + 'static,
) -> TurnHandle {
  let runtime = runtime.clone();
  let running = Arc::new(RunningTurn::new());
  let kill_grace = runtime.kill_grace;
  let thread_running = running.clone();
  let mut on_event = on_event;
  let thread = std::thread::Builder::new()
    .name("niho-local-ai-turn".to_string())
    .spawn(move || {
      let last = execute(&runtime, &req, &thread_running, &mut on_event);
      thread_running.mark_finished();
      on_event(last);
    })
    .expect("failed to spawn the niho-local-ai turn thread");
  TurnHandle {
    running,
    kill_grace,
    thread,
  }
}

/// 最後のイベントを返す（送るのは呼び出し側）。登録・一時ファイルはこの関数を抜けるときに外れる。
fn execute(
  runtime: &Runtime,
  req: &TurnRequest,
  running: &Arc<RunningTurn>,
  emit: &mut dyn FnMut(TurnEvent),
) -> TurnEvent {
  let provider = req.provider;
  if let Err(invalid) = validate(req) {
    return settle_early(running, || {
      runtime.log(
        "invalid_request",
        json!({ "provider": provider.wire_name(), "field": invalid.field }),
      );
      TurnEvent::Error {
        reason_code: invalid.code,
        message: invalid.message,
      }
    });
  }
  let Some(cli) = resolve_cli(runtime, provider) else {
    return settle_early(running, || {
      runtime.log(
        "spawn_failed",
        json!({ "provider": provider.wire_name(), "details": "cli_not_found" }),
      );
      error_event(
        provider,
        ReasonCode::NotConfigured,
        Some(&format!("このMacに {} が見つかりません。", provider.label())),
      )
    });
  };
  let (_registration, was_idle) = match register_running_turn(running) {
    Ok(registered) => registered,
    Err(message) => {
      return settle_early(running, || {
        error_event(provider, ReasonCode::TransientFailure, Some(message))
      })
    }
  };
  if was_idle {
    // 強制終了などで残った一時フォルダを消す（ほかに実行中の工程が無いときだけ）
    sweep_stale_private_dirs(&runtime.scratch_dir);
  }
  // 検査済み（validate）。ここで実体のパスにする
  let folder = match folder_access(&req.tool_policy) {
    Ok(folder) => folder,
    Err(_) => {
      return settle_early(running, || {
        error_event(
          provider,
          ReasonCode::NotConfigured,
          Some(PROJECT_FOLDER_MISSING_MESSAGE),
        )
      })
    }
  };
  let started = Instant::now();
  let timeout = req.timeout.min(MAX_TURN_TIMEOUT);
  let ctx = TurnCtx {
    runtime,
    req,
    running,
    cli,
    started,
    deadline: started + timeout,
    timeout,
    folder,
  };
  match provider {
    Provider::ClaudeCode => claude::run(&ctx, emit),
    Provider::CodexCli => codex::run(&ctx, emit),
    Provider::GeminiCli => agy::run(&ctx, emit),
  }
}

/// エラーを確定する直前に停止要求と競合を閉じる。停止が先なら通常のエラーではなく Stopped を返す。
fn settle_early(running: &RunningTurn, error: impl FnOnce() -> TurnEvent) -> TurnEvent {
  if running.settle() {
    stopped_before_start()
  } else {
    error()
  }
}

fn stopped_before_start() -> TurnEvent {
  TurnEvent::Done {
    text: String::new(),
    stop_reason: StopReason::Stopped,
    session_id: None,
    usage: Usage::default(),
    duration_ms: 0,
    continuations: 0,
  }
}

// ---------------------------------------------------------------------------
// 入力の検査

struct Invalid {
  code: ReasonCode,
  message: String,
  field: &'static str,
}

fn invalid(code: ReasonCode, message: &str, field: &'static str) -> Result<(), Invalid> {
  Err(Invalid {
    code,
    message: message.to_string(),
    field,
  })
}

/// CLI の引数に載るので、使える文字を絞る（空白・制御文字なし・`-` で始まらない）。
pub(crate) fn is_valid_model(model: &str) -> bool {
  !model.is_empty()
    && model.chars().count() <= MAX_MODEL_CHARS
    && !model.starts_with('-')
    && model
      .chars()
      .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '/' | '@' | '[' | ']' | '-'))
}

fn validate(req: &TurnRequest) -> Result<(), Invalid> {
  if !is_valid_model(&req.model) {
    return invalid(ReasonCode::ModelNotFound, "モデル名が正しくありません。", "model");
  }
  if req.user_prompt.trim().is_empty() {
    return invalid(ReasonCode::TransientFailure, "指示が空です。", "userPrompt");
  }
  if req.user_prompt.len() > MAX_USER_PROMPT_BYTES {
    return invalid(ReasonCode::TransientFailure, "指示が長すぎます。", "userPrompt");
  }
  if req.system_prompt.len() > MAX_SYSTEM_PROMPT_BYTES {
    return invalid(
      ReasonCode::TransientFailure,
      "システムプロンプトが長すぎます。",
      "systemPrompt",
    );
  }
  if req.resume_session.as_deref().is_some_and(|id| !is_uuid(id)) {
    return invalid(
      ReasonCode::SessionNotFound,
      "このMacに会話の続きが見つかりませんでした。",
      "resumeSession",
    );
  }
  if !req.workdir.is_dir() {
    return invalid(ReasonCode::NotConfigured, "作業フォルダが見つかりません。", "workdir");
  }
  if req.timeout.is_zero() {
    return invalid(
      ReasonCode::TransientFailure,
      "時間の上限が正しくありません。",
      "timeout",
    );
  }
  if req.provider == Provider::ClaudeCode
    && req
      .max_budget_usd
      .is_some_and(|budget| !(budget.is_finite() && budget > 0.0))
  {
    return invalid(
      ReasonCode::TransientFailure,
      "1 回の費用の上限が正しくありません。",
      "maxBudgetUsd",
    );
  }
  if let ToolPolicy::ReadFile { file } = &req.tool_policy {
    if req.provider != Provider::GeminiCli {
      return invalid(ReasonCode::NotConfigured, READ_FILE_PROVIDER_MESSAGE, "toolPolicy");
    }
    if req.resume_session.is_some() {
      return invalid(ReasonCode::NotConfigured, READ_FILE_RESUME_MESSAGE, "resumeSession");
    }
    if !is_readable_file(file) {
      return invalid(ReasonCode::NotConfigured, READ_FILE_MISSING_MESSAGE, "toolPolicy");
    }
  }
  if req.tool_policy.is_project_folder() {
    let folder = match folder_access(&req.tool_policy) {
      Ok(Some(folder)) => folder,
      _ => {
        return invalid(ReasonCode::NotConfigured, PROJECT_FOLDER_MISSING_MESSAGE, "toolPolicy");
      }
    };
    // Codex の workspace-write は CWD 全体を書ける。1 つの writable directory を workspace root にし、
    // 指定された範囲より広く書ける状態では起動しない。
    if req.provider == Provider::CodexCli && folder.codex_workspace().is_none() {
      return invalid(ReasonCode::NotConfigured, CODEX_PROJECT_FOLDER_MESSAGE, "toolPolicy");
    }
    if req.provider == Provider::GeminiCli {
      // 書き先は writable の下だけ。`.agents` など agy が読む場所を書き先にしない
      let writable_ok = !folder.writable.is_empty()
        && folder
          .writable
          .iter()
          .all(|name| name.split('/').all(|part| !part.starts_with('.')));
      if !writable_ok {
        return invalid(ReasonCode::NotConfigured, AGY_PROJECT_FOLDER_MESSAGE, "toolPolicy");
      }
      if agy::has_workspace_rules(&folder.dir) {
        return invalid(ReasonCode::NotConfigured, AGY_FOLDER_RULES_MESSAGE, "toolPolicy");
      }
    }
  }
  Ok(())
}

// ---------------------------------------------------------------------------
// 作業フォルダ（ToolPolicy::ProjectFolder）

/// 修正の会話の作業フォルダ。`dir` は実体の workspace（Claude・agy の cwd にする）、`given` は依頼のパス（CLI が返すパスとの比較用）、
/// `writable` は書ける相対フォルダ（空なら `dir` の中ならどこでも）。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FolderAccess {
  pub dir: PathBuf,
  pub given: PathBuf,
  pub writable: Vec<String>,
}

impl FolderAccess {
  /// Codex の workspace-write の root。workspace-write は CWD 全体を書けるので、書き込み先が 1 つのときだけ返す。
  pub(crate) fn codex_workspace(&self) -> Option<PathBuf> {
    (self.writable.len() == 1).then(|| self.dir.join(&self.writable[0]))
  }

  /// Codex の file_change path は絶対・workspace 相対・CWD 相対のいずれも受ける。
  pub(crate) fn permits_codex_write(&self, path: &str) -> bool {
    if self.permits_write(path) {
      return true;
    }
    let Some(writable) = self.writable.first().filter(|_| self.writable.len() == 1) else {
      return false;
    };
    let path = Path::new(path);
    if path.is_absolute() {
      return false;
    }
    let adjusted = Path::new(writable).join(path);
    self.permits_write(&adjusted.to_string_lossy())
  }

  /// `path`（CLI が返した絶対パスか、`dir` からの相対パス）に書いてよいか。`dir` の外・`..` を含むパスは不可で、
  /// `writable` があればその下だけ。ファイルが無くてもよい（字面で判定する）。
  pub(crate) fn permits_write(&self, path: &str) -> bool {
    let path = Path::new(path);
    let relative = if path.is_absolute() {
      match path.strip_prefix(&self.dir).or_else(|_| path.strip_prefix(&self.given)) {
        Ok(relative) => relative,
        Err(_) => return false,
      }
    } else {
      path
    };
    let mut parts = Vec::new();
    for component in relative.components() {
      match component {
        std::path::Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
        std::path::Component::CurDir => {}
        _ => return false,
      }
    }
    if parts.is_empty() {
      return false;
    }
    self.writable.is_empty()
      || self.writable.iter().any(|writable| {
        let prefix: Vec<&str> = writable.split('/').collect();
        parts.len() > prefix.len() && parts.iter().zip(&prefix).all(|(part, expected)| part == expected)
      })
  }
}

/// 書ける相対フォルダの名前か（英数字と `._-` の部分を `/` でつなぐ。空・`.`・`..`・先頭の `/` は不可）。
/// claude の `--allowedTools "Edit(./<名前>/**)"` に載るので、括弧・空白・`*` などを通さない。
pub(crate) fn is_safe_relative_dir(value: &str) -> bool {
  !value.is_empty()
    && value.chars().count() <= MAX_WRITABLE_DIR_CHARS
    && value.split('/').all(|part| {
      !part.is_empty()
        && part != "."
        && part != ".."
        && part
          .chars()
          .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    })
}

/// 読ませてよいファイルか: 絶対パスで、リンクでない普通のファイルで、名前が英数字と `._-`（作業フォルダに同じ名前で写し、
/// 指示文で指す。`.` で始まる名前は不可）。
pub(crate) fn is_readable_file(path: &Path) -> bool {
  let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
    return false;
  };
  path.is_absolute()
    && !name.starts_with('.')
    && name.chars().count() <= MAX_READ_FILE_NAME_CHARS
    && name
      .chars()
      .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    && std::fs::symlink_metadata(path)
      .map(|meta| meta.is_file() && !meta.file_type().is_symlink())
      .unwrap_or(false)
}

/// リンクでない、実在するフォルダか（途中のリンクは canonicalize で解く。末端のリンクだけを断る）。
fn is_plain_dir(path: &Path) -> bool {
  std::fs::symlink_metadata(path)
    .map(|meta| meta.is_dir() && !meta.file_type().is_symlink())
    .unwrap_or(false)
}

/// `ToolPolicy` を確かめ、ProjectFolder なら実体のパスにする（ツール無しは None）。
/// `dir` は絶対パスの、リンクでないフォルダ。`writable` はその中の、リンクでないフォルダ（無ければ断る）。
pub(crate) fn folder_access(policy: &ToolPolicy) -> Result<Option<FolderAccess>, ()> {
  let ToolPolicy::ProjectFolder { dir, writable } = policy else {
    return Ok(None);
  };
  if !dir.is_absolute() || !is_plain_dir(dir) || writable.len() > MAX_WRITABLE_DIRS {
    return Err(());
  }
  let canonical = dir.canonicalize().map_err(|_| ())?;
  for name in writable {
    if !is_safe_relative_dir(name) {
      return Err(());
    }
    let mut path = canonical.clone();
    for part in name.split('/') {
      path.push(part);
      if !is_plain_dir(&path) {
        return Err(());
      }
    }
  }
  Ok(Some(FolderAccess {
    dir: canonical,
    given: dir.clone(),
    writable: writable.clone(),
  }))
}

// ---------------------------------------------------------------------------
// CLI ごとの実行が使う共通の部品

/// 新しい会話（起動時に UUID を渡す）か、続き（その会話を resume する）か。
pub(crate) enum SessionArg {
  New(String),
  Resume(String),
}

impl SessionArg {
  /// `resume_session` があれば続き、無ければ新しい UUID。
  pub(crate) fn for_request(req: &TurnRequest) -> std::io::Result<Self> {
    match &req.resume_session {
      Some(id) => Ok(SessionArg::Resume(id.clone())),
      None => crate::process::new_uuid_v4().map(SessionArg::New),
    }
  }

  pub(crate) fn id(&self) -> &str {
    match self {
      SessionArg::New(id) | SessionArg::Resume(id) => id,
    }
  }

  /// `--session-id <id>` か `--resume <id>`（claude）。
  pub(crate) fn flag(&self) -> [String; 2] {
    match self {
      SessionArg::New(id) => ["--session-id".to_string(), id.clone()],
      SessionArg::Resume(id) => ["--resume".to_string(), id.clone()],
    }
  }
}

/// fail closed で止めた理由（ツールの使用・init の違反・agy の会話の ID の食い違い）。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Breach {
  /// ログに書く種類（"init"・"tool_use"・"command_execution" など）。中身は書かない
  pub kind: String,
  /// 最後に返す理由。ツールの気配・init の違反は NotConfigured、続きのはずが別の会話になったら SessionNotFound
  pub code: ReasonCode,
  pub message: String,
}

/// CLI ごとの出力の読み取り。`run_child` が stdout の 1 行ずつを渡し、子プロセスが終わったら最後のイベントを作る。
pub(crate) trait StreamHandler {
  /// 1 行を読み、送る delta を返す（JSON でない行は無視する）。
  fn process_line(&mut self, line: &str) -> Vec<TurnEvent>;
  /// ツールの気配を見たら Some（読むのをやめて子プロセスを止める）。
  fn breach(&self) -> Option<&Breach>;
  /// ログだけに残す CLI の警告（読んだ分を渡して空にする）。
  fn take_warnings(&mut self) -> Vec<String> {
    Vec::new()
  }
  /// 止めたときの Done（ここまでの文）。
  fn stopped(&self, elapsed_ms: u64) -> TurnEvent;
  /// 子プロセスが終わった後の最後のイベント（停止・時間切れ・起動の失敗・違反は先に扱う）。
  fn conclude(&self, stderr: &str, elapsed_ms: u64) -> TurnEvent;
}

pub(crate) struct TurnCtx<'a> {
  pub runtime: &'a Runtime,
  pub req: &'a TurnRequest,
  pub running: &'a Arc<RunningTurn>,
  pub cli: PathBuf,
  pub started: Instant,
  pub deadline: Instant,
  pub timeout: Duration,
  /// `ToolPolicy::ProjectFolder` の workspace（Claude・agy はここ、Codex は唯一の writable root で動く）
  pub folder: Option<FolderAccess>,
}

impl TurnCtx<'_> {
  pub(crate) fn provider(&self) -> Provider {
    self.req.provider
  }

  pub(crate) fn elapsed_ms(&self) -> u64 {
    self.started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
  }

  /// ログ（provider を足す）。指示文・システムプロンプト・本文は渡さない。
  pub(crate) fn log(&self, kind: &str, mut payload: Value) {
    if let Some(object) = payload.as_object_mut() {
      object.insert("provider".into(), json!(self.provider().wire_name()));
    }
    self.runtime.log(kind, payload);
  }

  /// 子プロセスの起動コマンド。cwd は会話を続ける間同じ場所（claude・codex は会話を cwd ごとに保存する）。
  /// `ProjectFolder` のとき Claude は workspace、Codex は唯一の writable root、ツール無しのときは `workdir`。
  pub(crate) fn command(&self, args: &[String], extra_env: &[(&str, OsString)]) -> Command {
    let cwd = match self.folder.as_ref() {
      Some(folder) if self.provider() == Provider::CodexCli => folder
        .codex_workspace()
        .expect("Codex ProjectFolder is validated to one writable root"),
      Some(folder) => folder.dir.clone(),
      None => self.req.workdir.clone(),
    };
    self.command_in(&cwd, args, extra_env)
  }

  /// cwd を `workdir` 以外にする起動コマンド（agy は作業フォルダの中を自動で読み書きできるので、その回だけの空の
  /// フォルダか、修正の会話の workspace で動かす）。
  pub(crate) fn command_in(&self, cwd: &Path, args: &[String], extra_env: &[(&str, OsString)]) -> Command {
    let mut command = provider_command(self.runtime, self.provider(), &self.cli, args, extra_env);
    command.current_dir(cwd);
    command
  }

  pub(crate) fn error(&self, code: ReasonCode, message: Option<&str>) -> TurnEvent {
    error_event(self.provider(), code, message)
  }

  /// 起動の前の準備（一時ファイル・UUID）に失敗した。
  pub(crate) fn setup_failed(&self, details: String) -> TurnEvent {
    settle_early(self.running, || {
      self.log("spawn_failed", json!({ "details": details }));
      self.error(ReasonCode::NotConfigured, None)
    })
  }

  /// 最後のイベントを決める。停止 → 時間切れ → 起動の失敗 → 違反（ツール・会話の ID） → CLI ごとの判定 の順
  /// （Desktop と同じく、止める合図が出ていれば時間切れや失敗より停止を優先する）。
  pub(crate) fn finish(&self, handler: &dyn StreamHandler, exit: Option<ChildExit>) -> TurnEvent {
    let elapsed_ms = self.elapsed_ms();
    if self.running.settle() {
      return handler.stopped(elapsed_ms);
    }
    if self.running.is_timed_out() {
      self.log(
        "timed_out",
        json!({ "timeoutMs": self.timeout.as_millis().min(u128::from(u64::MAX)) as u64 }),
      );
      return TurnEvent::Error {
        reason_code: ReasonCode::TimedOut,
        message: timed_out_message(self.timeout),
      };
    }
    let Some(exit) = exit else {
      // 起動しないまま終わるのは止める合図のときだけ（上で返している）
      return self.error(ReasonCode::TransientFailure, None);
    };
    let (exit_code, stderr) = match exit {
      ChildExit::SpawnFailed(details) => {
        self.log("spawn_failed", json!({ "details": details }));
        return self.error(ReasonCode::NotConfigured, None);
      }
      ChildExit::Exited { exit_code, stderr } => (exit_code, stderr),
    };
    if let Some(breach) = handler.breach() {
      return self.error(breach.code, Some(&breach.message));
    }
    let event = handler.conclude(&stderr, elapsed_ms);
    if let TurnEvent::Error { reason_code, .. } = &event {
      self.log(
        "turn_failed",
        json!({
          "reasonCode": reason_code.as_str(),
          "exitCode": exit_code,
          "stderrTail": sanitize_stderr_tail(&stderr, 1024),
        }),
      );
    }
    event
  }
}

/// 「〈n〉分以内に終わらなかったため止めました。」（1 分未満は秒）。
pub(crate) fn timed_out_message(timeout: Duration) -> String {
  let seconds = timeout.as_secs();
  if seconds >= 60 {
    format!("{}分以内に終わらなかったため止めました。", seconds / 60)
  } else {
    let seconds = timeout.as_millis().div_ceil(1000).max(1);
    format!("{seconds}秒以内に終わらなかったため止めました。")
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::process::RunningTurn;
  use crate::types::Effort;

  fn request(provider: Provider) -> TurnRequest {
    TurnRequest {
      provider,
      model: "claude-sonnet-5".to_string(),
      effort: Some(Effort::High),
      system_prompt: "あなたは編集者です。".to_string(),
      user_prompt: "直して".to_string(),
      resume_session: None,
      workdir: std::env::temp_dir(),
      timeout: Duration::from_secs(60),
      max_budget_usd: None,
      tool_policy: ToolPolicy::None,
    }
  }

  /// テスト用の案件フォルダ（artifacts/ を持つ）。消すのは呼び出し側。
  fn project_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
      "niho-local-ai-folder-{name}-{}-{}",
      std::process::id(),
      crate::process::hex(&crate::process::random_bytes::<4>().unwrap())
    ));
    std::fs::create_dir_all(dir.join("artifacts")).unwrap();
    dir
  }

  #[test]
  fn project_folder_requests_are_checked_and_resolved() {
    let dir = project_dir("check");
    let mut req = request(Provider::ClaudeCode);
    req.tool_policy = ToolPolicy::ProjectFolder {
      dir: dir.clone(),
      writable: vec!["artifacts".into()],
    };
    assert!(rejected(&req).is_none());
    let folder = folder_access(&req.tool_policy).unwrap().unwrap();
    assert_eq!(folder.dir, dir.canonicalize().unwrap());
    assert_eq!(folder.given, dir);
    assert_eq!(folder.writable, vec!["artifacts".to_string()]);
    assert_eq!(folder_access(&ToolPolicy::None), Ok(None));

    // Antigravity CLI は書き込み先（`.` で始まらないフォルダ）が要り、agy が読む決まりのある作業フォルダでは起動しない
    let mut agy = req.clone();
    agy.provider = Provider::GeminiCli;
    agy.model = "gemini-3.8-flash".to_string();
    assert!(rejected(&agy).is_none());
    for writable in [
      vec![],
      vec![".agents".to_string()],
      vec!["artifacts/.hidden".to_string()],
    ] {
      if let Some(name) = writable.first() {
        std::fs::create_dir_all(dir.join(name)).unwrap();
      }
      let mut bad = agy.clone();
      bad.tool_policy = ToolPolicy::ProjectFolder {
        dir: dir.clone(),
        writable: writable.clone(),
      };
      assert_eq!(
        rejected(&bad),
        Some((
          ReasonCode::NotConfigured,
          AGY_PROJECT_FOLDER_MESSAGE.to_string(),
          "toolPolicy"
        )),
        "{writable:?}"
      );
      if let Some(name) = writable.first() {
        std::fs::remove_dir_all(dir.join(name)).unwrap();
      }
    }
    for rules in [".agents", "AGENTS.md", "GEMINI.md"] {
      std::fs::write(dir.join(rules), "決まり").unwrap();
      assert_eq!(
        rejected(&agy),
        Some((
          ReasonCode::NotConfigured,
          AGY_FOLDER_RULES_MESSAGE.to_string(),
          "toolPolicy"
        )),
        "{rules}"
      );
      std::fs::remove_file(dir.join(rules)).unwrap();
    }
    assert!(rejected(&agy).is_none());

    // 相対パス・無いフォルダ・リンク・書ける場所の名前の誤り・無い書ける場所は断る
    let cases: Vec<ToolPolicy> = vec![
      ToolPolicy::ProjectFolder {
        dir: PathBuf::from("relative/dir"),
        writable: vec![],
      },
      ToolPolicy::ProjectFolder {
        dir: dir.join("missing"),
        writable: vec![],
      },
      ToolPolicy::ProjectFolder {
        dir: dir.clone(),
        writable: vec!["../outside".into()],
      },
      ToolPolicy::ProjectFolder {
        dir: dir.clone(),
        writable: vec!["a b".into()],
      },
      ToolPolicy::ProjectFolder {
        dir: dir.clone(),
        writable: vec!["Edit(*)".into()],
      },
      ToolPolicy::ProjectFolder {
        dir: dir.clone(),
        writable: vec!["versions".into()],
      },
    ];
    for policy in cases {
      let mut bad = request(Provider::CodexCli);
      bad.tool_policy = policy.clone();
      assert_eq!(
        rejected(&bad).map(|(code, _, field)| (code, field)),
        Some((ReasonCode::NotConfigured, "toolPolicy")),
        "{policy:?}"
      );
    }
    #[cfg(unix)]
    {
      let link = dir.with_extension("link");
      std::os::unix::fs::symlink(&dir, &link).unwrap();
      let mut linked = request(Provider::ClaudeCode);
      linked.tool_policy = ToolPolicy::ProjectFolder {
        dir: link.clone(),
        writable: vec![],
      };
      assert!(rejected(&linked).is_some(), "the folder itself must not be a link");
      std::os::unix::fs::symlink(std::env::temp_dir(), dir.join("artifacts-link")).unwrap();
      linked.tool_policy = ToolPolicy::ProjectFolder {
        dir: dir.clone(),
        writable: vec!["artifacts-link".into()],
      };
      assert!(rejected(&linked).is_some(), "a writable folder must not be a link");
      let _ = std::fs::remove_file(&link);
    }
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn writes_are_permitted_only_inside_the_writable_folders() {
    let folder = FolderAccess {
      dir: PathBuf::from("/private/tmp/p"),
      given: PathBuf::from("/tmp/p"),
      writable: vec!["artifacts".into()],
    };
    assert!(folder.permits_write("/private/tmp/p/artifacts/abc.md"));
    assert!(folder.permits_write("/tmp/p/artifacts/abc.md"));
    assert!(folder.permits_write("artifacts/abc.md"));
    assert!(folder.permits_write("./artifacts/sub/abc.md"));
    for path in [
      "/private/tmp/p/project.json",
      "/private/tmp/p/artifacts",
      "/private/tmp/p/artifacts/../project.json",
      "/private/tmp/p/artifactsx/abc.md",
      "/tmp/other/artifacts/abc.md",
      "/etc/passwd",
      "../p/artifacts/abc.md",
      "project.json",
      "",
    ] {
      assert!(!folder.permits_write(path), "{path}");
    }
    let anywhere = FolderAccess {
      writable: Vec::new(),
      ..folder
    };
    assert!(anywhere.permits_write("/private/tmp/p/notes.md"));
    assert!(!anywhere.permits_write("/private/tmp/notes.md"));
    assert!(is_safe_relative_dir("artifacts"));
    assert!(is_safe_relative_dir("a/b-c_d.e"));
    for name in ["", ".", "..", "a/../b", "/abs", "a//b", "a b", "a*", "a(b)", "日本"] {
      assert!(!is_safe_relative_dir(name), "{name}");
    }
  }

  fn rejected(req: &TurnRequest) -> Option<(ReasonCode, String, &'static str)> {
    validate(req)
      .err()
      .map(|invalid| (invalid.code, invalid.message, invalid.field))
  }

  #[test]
  fn read_file_requests_are_only_for_agy_and_a_plain_file() {
    let dir = project_dir("read-file");
    let file = dir.join("part-01.wav");
    std::fs::write(&file, b"RIFF").unwrap();
    let mut req = request(Provider::GeminiCli);
    req.model = "gemini-3.8-flash".to_string();
    req.tool_policy = ToolPolicy::ReadFile { file: file.clone() };
    assert!(rejected(&req).is_none());
    // claude・codex は受けない
    for provider in [Provider::ClaudeCode, Provider::CodexCli] {
      let mut other = req.clone();
      other.provider = provider;
      assert_eq!(
        rejected(&other),
        Some((
          ReasonCode::NotConfigured,
          READ_FILE_PROVIDER_MESSAGE.to_string(),
          "toolPolicy"
        ))
      );
    }
    // 続きは受けない
    let mut resumed = req.clone();
    resumed.resume_session = Some("11111111-2222-4333-8444-555555555555".to_string());
    assert_eq!(
      rejected(&resumed).map(|(code, _, field)| (code, field)),
      Some((ReasonCode::NotConfigured, "resumeSession"))
    );
    // 無い・相対・フォルダ・リンク・使えない名前
    let link = dir.join("link.wav");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&file, &link).unwrap();
    let odd = dir.join("区切り 1.wav");
    std::fs::write(&odd, b"RIFF").unwrap();
    let hidden = dir.join(".part.wav");
    std::fs::write(&hidden, b"RIFF").unwrap();
    for bad in [
      dir.join("missing.wav"),
      PathBuf::from("part-01.wav"),
      dir.join("artifacts"),
      link,
      odd,
      hidden,
    ] {
      let mut bad_req = req.clone();
      bad_req.tool_policy = ToolPolicy::ReadFile { file: bad.clone() };
      assert_eq!(
        rejected(&bad_req).map(|(code, _, field)| (code, field)),
        Some((ReasonCode::NotConfigured, "toolPolicy")),
        "{}",
        bad.display()
      );
    }
    let _ = std::fs::remove_dir_all(dir);
  }

  #[test]
  fn model_names_are_restricted_to_safe_characters() {
    for model in [
      "claude-sonnet-5",
      "gpt-5.5",
      "gemini-2.5-pro",
      "openai/gpt-oss:20b",
      "model@2026",
      "x[1m]",
    ] {
      assert!(is_valid_model(model), "{model}");
    }
    for model in [
      "",
      "-p",
      "--resume",
      "a b",
      "a\nb",
      "モデル",
      "a;b",
      "a\"b",
      &"m".repeat(129),
    ] {
      assert!(!is_valid_model(model), "{model:?}");
    }
    assert!(is_valid_model(&"m".repeat(128)));
  }

  #[test]
  fn validation_rejects_bad_requests_with_the_listed_reasons() {
    assert!(rejected(&request(Provider::ClaudeCode)).is_none());

    let mut req = request(Provider::ClaudeCode);
    req.model = "--dangerously".into();
    assert_eq!(rejected(&req).unwrap().0, ReasonCode::ModelNotFound);
    assert_eq!(rejected(&req).unwrap().1, "モデル名が正しくありません。");

    let mut req = request(Provider::ClaudeCode);
    req.user_prompt = "  \n ".into();
    assert_eq!(
      rejected(&req).unwrap(),
      (ReasonCode::TransientFailure, "指示が空です。".to_string(), "userPrompt")
    );

    let mut req = request(Provider::ClaudeCode);
    req.user_prompt = "x".repeat(MAX_USER_PROMPT_BYTES + 1);
    assert_eq!(rejected(&req).unwrap().0, ReasonCode::TransientFailure);

    let mut req = request(Provider::CodexCli);
    req.system_prompt = "x".repeat(MAX_SYSTEM_PROMPT_BYTES + 1);
    assert_eq!(rejected(&req).unwrap().2, "systemPrompt");

    let mut req = request(Provider::GeminiCli);
    req.resume_session = Some("not-a-uuid".into());
    assert_eq!(rejected(&req).unwrap().0, ReasonCode::SessionNotFound);
    req.resume_session = Some("11111111-2222-4333-8444-555555555555".into());
    assert!(rejected(&req).is_none());

    let mut req = request(Provider::ClaudeCode);
    req.workdir = PathBuf::from("/nonexistent/niho-local-ai/work");
    assert_eq!(
      rejected(&req).unwrap(),
      (
        ReasonCode::NotConfigured,
        "作業フォルダが見つかりません。".to_string(),
        "workdir"
      )
    );

    let mut req = request(Provider::ClaudeCode);
    req.timeout = Duration::ZERO;
    assert_eq!(rejected(&req).unwrap().0, ReasonCode::TransientFailure);

    let mut req = request(Provider::ClaudeCode);
    req.max_budget_usd = Some(0.0);
    assert_eq!(rejected(&req).unwrap().2, "maxBudgetUsd");
    req.max_budget_usd = Some(f64::NAN);
    assert_eq!(rejected(&req).unwrap().2, "maxBudgetUsd");
    // claude 以外は費用の上限を無視する
    let mut req = request(Provider::CodexCli);
    req.max_budget_usd = Some(-1.0);
    assert!(rejected(&req).is_none());
  }

  #[test]
  fn timed_out_message_uses_minutes_or_seconds() {
    assert_eq!(
      timed_out_message(Duration::from_secs(20 * 60)),
      "20分以内に終わらなかったため止めました。"
    );
    assert_eq!(
      timed_out_message(Duration::from_secs(90)),
      "1分以内に終わらなかったため止めました。"
    );
    assert_eq!(
      timed_out_message(Duration::from_secs(30)),
      "30秒以内に終わらなかったため止めました。"
    );
    assert_eq!(
      timed_out_message(Duration::from_millis(400)),
      "1秒以内に終わらなかったため止めました。"
    );
  }

  #[test]
  fn accepted_stop_wins_over_an_early_error() {
    let running = RunningTurn::new();
    assert!(running.request_stop());
    let event = settle_early(&running, || panic!("early error must not win after stop"));
    assert_eq!(
      event,
      TurnEvent::Done {
        text: String::new(),
        stop_reason: StopReason::Stopped,
        session_id: None,
        usage: Usage::default(),
        duration_ms: 0,
        continuations: 0,
      }
    );
    assert!(!running.request_stop());
  }

  #[test]
  fn session_flag_is_session_id_or_resume() {
    let new = SessionArg::New("11111111-2222-4333-8444-555555555555".into());
    assert_eq!(
      new.flag(),
      [
        "--session-id".to_string(),
        "11111111-2222-4333-8444-555555555555".to_string()
      ]
    );
    let resume = SessionArg::Resume("01a13b6e-21d7-7093-8fc2-637efb0dd571".into());
    assert_eq!(resume.flag()[0], "--resume");
    assert_eq!(resume.id(), "01a13b6e-21d7-7093-8fc2-637efb0dd571");
    let generated = SessionArg::for_request(&request(Provider::ClaudeCode)).unwrap();
    assert!(matches!(generated, SessionArg::New(_)));
    assert!(is_uuid(generated.id()));
  }
}
