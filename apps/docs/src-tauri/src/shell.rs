//! Mac の殻（設計 §13・#45 の T7）。
//!
//! Mac アプリは editor.niho.life を読む殻で、端末の力（録音・端末内の文字起こし・CLI の AI）だけを bridge で足す。
//! この module は殻の入口だけを持つ：どの画面を読むか（`NIHO_DOCS_SHELL`）と、画面が殻を見分けるための
//! `shell_capabilities`。URL は**ここの定数だけ**で、環境変数やページから URL を受け取らない。
//!
//! 端末の力 ①（この段）: マイクの録音・音声ファイルの取り込み・端末内の文字起こし。**すべて id だけ**でやり取りし、
//! パスは画面に返さない（音声のバイト列は id から `shell_recording_read`・`shell_audio_read` で読む）。
//! 取り込んだ音声は一時置き場（staging.rs）に写す。結果（文字起こし・音声）はサーバーへ画面が書く。
//!
//! remote origin から呼べるコマンドは `capabilities/remote-editor.json`（本番は editor.niho.life だけ）で決まる。
//! 開発の `localhost` は `capabilities/remote-editor-dev.json` に分け、`tauri.dev.conf.json` を付けたときだけ入る
//! （配布物の `tauri.conf.json` は `default` と `remote-editor` だけを数える。acl_tests.rs が固定する）。
//! remote には core の event の購読も許さない（アプリ全体の event を聞けてしまう）。進みは command の Channel で返す。

use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tauri::ipc::{Channel, Response};
use tauri::State;

use crate::recording::RecordingError;
use crate::speech::{self, SpeechError};
use crate::staging::Staging;
use crate::store::AUDIO_EXTENSIONS;
use crate::{AppState, CommandError, CommandResult};

/// 本番の画面。配布物の殻が読むのはこれだけ。
pub const EDITOR_URL: &str = "https://editor.niho.life";
/// 開発の画面（`npm -C apps/editor-web run dev`）。開発・試験の起動でだけ使える。
pub const DEV_EDITOR_URL: &str = "http://localhost:3000";
/// どの画面を読むかの環境変数。配布版は常に editor.niho.life、`local` と `dev` は開発起動だけで使える。
pub const SHELL_ENV: &str = "NIHO_DOCS_SHELL";

/// 殻が読む画面。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellMode {
  /// 同梱の画面。開発起動の既定か、配布版で明示的に切り戻すときに使う。
  Local,
  /// editor.niho.life。
  Remote,
  /// 開発の editor（localhost）。開発・試験の起動でだけ選べる。
  Dev,
}

impl ShellMode {
  /// 旧 PC runner は同梱画面からだけ操作できる。
  pub fn allows_pc_runner(self) -> bool {
    matches!(self, Self::Local)
  }
}

/// Web の画面は HTML5 DnD を使う。Tauri のファイル用 handler は macOS でも
/// ページやパネルのドラッグを横取りするため、旧い同梱画面でだけ使う。
/// Context の設定を変えるので、常駐中に作り直す窓にも同じ設定が引き継がれる。
pub fn configure_drag_drop(config: &mut tauri::Config, mode: ShellMode) {
  for window in &mut config.app.windows {
    if window.label == "main" {
      window.drag_drop_enabled = matches!(mode, ShellMode::Local);
    }
  }
}

/// `NIHO_DOCS_SHELL` の値と、開発の起動かどうかから読む画面を決める。
/// 配布版は環境変数の値にかかわらず editor.niho.life。開発版は未指定または不正な値なら同梱画面。
pub fn shell_mode(value: Option<&str>, dev: bool) -> ShellMode {
  match value.map(str::trim) {
    Some("remote") => ShellMode::Remote,
    Some("dev") if dev => ShellMode::Dev,
    Some("local") if dev => ShellMode::Local,
    _ if !dev => ShellMode::Remote,
    _ => ShellMode::Local,
  }
}

/// 殻が開く URL。今までの画面なら None（同梱の index.html のまま）。
pub fn remote_url(mode: ShellMode) -> Option<tauri::Url> {
  let url = match mode {
    ShellMode::Local => return None,
    ShellMode::Remote => EDITOR_URL,
    ShellMode::Dev => DEV_EDITOR_URL,
  };
  // 定数なので必ず読める。万一読めなければ起動を止めず、今までの画面に落とす
  tauri::Url::parse(url).ok()
}

/// この Mac にある端末の力（画面が「この Mac で」の選択肢を出す判断に使う）。
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellFeatures {
  /// マイクの録音（`niho-speech record`）。
  pub recording: bool,
  /// 端末内の文字起こし（同梱の `niho-speech`）。
  pub local_transcription: bool,
  /// server 音声を小さい chunk で受け取り、保存待ち結果を認識し直さず再送できる端末内文字起こし。
  pub local_transcription_v2: bool,
  /// native file/mic の固定変換・chunk upload・owner scope 付き復旧。
  pub native_audio_v2: bool,
  /// CLI の AI（Claude Code・Codex CLI・Antigravity CLI）。
  pub cli_ai: bool,
  /// Antigravity CLI で録音を10分ずつ文字起こしする固定経路。
  pub gemini_cli_transcription: bool,
}

/// 殻の自己紹介。画面はこれが返ることで「Mac の殻の中にいる」と分かる（capability が無ければ呼べず、ブラウザでは無い）。
/// 鍵・パス・端末の名前は入れない。
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellCapabilities {
  /// アプリの版（Cargo.toml。配布の版と同じ）。
  pub version: String,
  /// 開発・試験の起動か。
  pub dev: bool,
  pub features: ShellFeatures,
}

/// 殻の自己紹介を組む（command と test で同じものを使う）。
pub fn capabilities(dev: bool) -> ShellCapabilities {
  ShellCapabilities {
    version: env!("CARGO_PKG_VERSION").to_string(),
    dev,
    // 第 1 段では「ある」ことだけ返す。実際に使える状態か（マイクの許可・音声モデル・CLI のログイン）は、
    // それぞれの command が呼ばれたときに今までどおり確かめる
    features: ShellFeatures {
      recording: true,
      local_transcription: true,
      local_transcription_v2: true,
      native_audio_v2: true,
      cli_ai: true,
      gemini_cli_transcription: true,
    },
  }
}

/// editor.niho.life の画面から呼ぶ、殻の自己紹介。
#[tauri::command]
pub async fn shell_capabilities() -> CommandResult<ShellCapabilities> {
  Ok(capabilities(crate::is_dev_launch()))
}

/// 画面へ 1 回で返す音声の上限（IPC は 1 つのバッファなので、ここで止める。サーバーの上限は画面が別に確かめる）。
pub const MAX_AUDIO_READ_BYTES: u64 = 512 * 1024 * 1024;

fn staging_failed() -> CommandError {
  CommandError::new("shell_staging_failed", "一時置き場を用意できませんでした。")
}

fn staging_missing() -> CommandError {
  CommandError::new(
    "shell_staging_missing",
    "取り込んだ音声が見つかりません。もう一度選んでください。",
  )
}

fn audio_too_large() -> CommandError {
  CommandError::new("shell_audio_too_large", "音声が大きすぎて、この画面へ渡せません。")
}

fn blocking_failed() -> CommandError {
  CommandError::new("shell_failed", "この Mac の処理を終えられませんでした。")
}

fn owner_scope_required() -> CommandError {
  CommandError::new(
    "shell_audio_owner_scope_required",
    "この一時音声にはログイン所有者の確認が必要です。",
  )
}

/// マイクの許可（旧い画面の mic_status と同じ）。
#[tauri::command]
pub async fn shell_mic_status(request: bool) -> CommandResult<String> {
  let binary = speech::resolve_speech_binary().ok_or(RecordingError::NotFound)?;
  tauri::async_runtime::spawn_blocking(move || speech::mic_status(&binary.path, request))
    .await
    .map_err(|_| blocking_failed())?
    .map_err(CommandError::from)
}

/// マイクで録音を始める（id だけ。音声は app data の recordings/ に入る）。
#[tauri::command]
pub async fn shell_recording_start(
  state: State<'_, AppState>,
  recording_id: String,
  on_event: Channel<Value>,
) -> CommandResult<Value> {
  crate::safe_id(&recording_id)?;
  let binary = speech::resolve_speech_binary().ok_or(RecordingError::NotFound)?;
  let recorder = state.recorder.clone();
  tauri::async_runtime::spawn_blocking(move || {
    recorder.start(&binary.path, &recording_id, move |value| {
      let _ = on_event.send(shell_recording_event(value));
    })
  })
  .await
  .map_err(|_| blocking_failed())?
  .map_err(CommandError::from)
}

/// 止めた録音（パスは返さない。`exported` が false なら書き出せず録音中の CAF のまま）。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShellRecording {
  pub recording_id: String,
  /// 「録音 10/16 15:30」
  pub name: String,
  pub duration_sec: Option<f64>,
  pub exported: bool,
}

/// 書き出せたか（書き出せなければ録音中の CAF のまま）。
fn exported(path: &str) -> bool {
  path.ends_with(".m4a")
}

/// 録音のイベントを remote の画面へ渡す前に、パスを落とす。画面が止めずに終わったとき（入力装置の切断など）の
/// `Done.audio` は `RecordingInfo`（app data の絶対パスを含む）なので、`ShellRecording` と同じ形に変える。
/// ほかのイベント（Started・Level・Error）にパスは無い。
pub fn shell_recording_event(mut value: Value) -> Value {
  if value.get("type").and_then(Value::as_str) == Some("Done") {
    let audio = value.get("audio").cloned().unwrap_or(Value::Null);
    let shaped = ShellRecording {
      recording_id: audio["recordingId"].as_str().unwrap_or_default().to_string(),
      name: audio["name"].as_str().unwrap_or_default().to_string(),
      duration_sec: audio["durationSec"].as_f64(),
      exported: audio["path"].as_str().is_some_and(exported),
    };
    value["audio"] = serde_json::to_value(shaped).unwrap_or(Value::Null);
  }
  value
}

/// 録音を止める。
#[tauri::command]
pub async fn shell_recording_stop(state: State<'_, AppState>, recording_id: String) -> CommandResult<ShellRecording> {
  crate::safe_id(&recording_id)?;
  let recorder = state.recorder.clone();
  let info = tauri::async_runtime::spawn_blocking(move || recorder.stop(&recording_id))
    .await
    .map_err(|_| blocking_failed())?
    .map_err(CommandError::from)?;
  Ok(ShellRecording {
    exported: exported(&info.path),
    recording_id: info.recording_id,
    name: info.name,
    duration_sec: info.duration_sec,
  })
}

/// 録音を捨てる（録音中なら止めてから）。
#[tauri::command]
pub async fn shell_recording_discard(state: State<'_, AppState>, recording_id: String) -> CommandResult<()> {
  crate::safe_id(&recording_id)?;
  if recording_is_recovery_protected(&state.data_dir, &recording_id) {
    return Err(owner_scope_required());
  }
  let recorder = state.recorder.clone();
  tauri::async_runtime::spawn_blocking(move || recorder.discard(&recording_id))
    .await
    .map_err(|_| blocking_failed())?
    .map_err(CommandError::from)
}

/// ファイルを丸ごと読んで画面へ渡す（上限あり）。
async fn read_audio(path: PathBuf) -> CommandResult<Response> {
  tauri::async_runtime::spawn_blocking(move || {
    let size = fs::metadata(&path).map_err(|_| staging_missing())?.len();
    if size > MAX_AUDIO_READ_BYTES {
      return Err(audio_too_large());
    }
    fs::read(&path).map(Response::new).map_err(|_| staging_missing())
  })
  .await
  .map_err(|_| blocking_failed())?
}

/// 書き出した録音のバイト列（画面がサーバーへ上げる）。録音中・無いものは断る。
#[tauri::command]
pub async fn shell_recording_read(state: State<'_, AppState>, recording_id: String) -> CommandResult<Response> {
  crate::safe_id(&recording_id)?;
  if recording_is_recovery_protected(&state.data_dir, &recording_id) {
    return Err(owner_scope_required());
  }
  let path = state
    .recorder
    .exported_file(&recording_id)
    .ok_or(RecordingError::Missing)?;
  read_audio(path).await
}

/// 取り込んだ音声（一時置き場の中。パスは返さない）。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShellStagedAudio {
  pub staging_id: String,
  pub files: Vec<ShellStagedFile>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShellStagedFile {
  /// `shell_audio_read`・文字起こしの順に使う番号。
  pub index: usize,
  /// 元のファイル名（表示用）。
  pub name: String,
  pub duration_sec: Option<f64>,
}

/// 選んだ音声を一時置き場に写す（音声でないものは外す。1 つも無ければ None）。
fn stage_audio(staging: &Staging, picked: Vec<PathBuf>) -> CommandResult<Option<ShellStagedAudio>> {
  let staged = staging.create().map_err(|_| staging_failed())?;
  let mut files = Vec::new();
  for (index, path) in picked.iter().enumerate() {
    let ext = path
      .extension()
      .map(|ext| ext.to_string_lossy().to_lowercase())
      .unwrap_or_default();
    if !path.is_file() || !AUDIO_EXTENSIONS.contains(&ext.as_str()) {
      continue;
    }
    staged
      .copy_in("audio", &format!("{index}.{ext}"), path)
      .map_err(|_| staging_failed())?;
    files.push(ShellStagedFile {
      index,
      name: path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default(),
      duration_sec: speech::audio_duration_sec(path),
    });
  }
  if files.is_empty() {
    let _ = staged.remove();
    return Ok(None);
  }
  Ok(Some(ShellStagedAudio {
    staging_id: staged.id().to_string(),
    files,
  }))
}

/// 一時置き場の音声（番号で引く。`<index>.<ext>`）。
fn staged_audio_files(staging: &Staging, staging_id: &str) -> CommandResult<Vec<(usize, PathBuf)>> {
  let staged = staging.open(staging_id).ok_or_else(staging_missing)?;
  let dir = staged.path().join("audio");
  let mut files: Vec<(usize, PathBuf)> = fs::read_dir(&dir)
    .map_err(|_| staging_missing())?
    .flatten()
    .filter_map(|entry| {
      let path = entry.path();
      let stem = path.file_stem()?.to_str()?.parse::<usize>().ok()?;
      path.is_file().then_some((stem, path))
    })
    .collect();
  files.sort_by_key(|(index, _)| *index);
  Ok(files)
}

/// Mac のファイル選択で音声を選び、一時置き場に写す。
#[tauri::command]
pub async fn shell_audio_pick(state: State<'_, AppState>) -> CommandResult<Option<ShellStagedAudio>> {
  let picked = rfd::AsyncFileDialog::new()
    .set_title("音声を追加")
    .add_filter("音声", &AUDIO_EXTENSIONS)
    .pick_files()
    .await
    .map(|files| files.iter().map(|file| file.path().to_path_buf()).collect::<Vec<_>>())
    .unwrap_or_default();
  if picked.is_empty() {
    return Ok(None);
  }
  let staging = Staging::new(&state.data_dir);
  tauri::async_runtime::spawn_blocking(move || stage_audio(&staging, picked))
    .await
    .map_err(|_| blocking_failed())?
}

/// 取り込んだ音声のバイト列（画面がサーバーへ上げる）。
#[tauri::command]
pub async fn shell_audio_read(state: State<'_, AppState>, staging_id: String, index: usize) -> CommandResult<Response> {
  let staging = Staging::new(&state.data_dir);
  if staging
    .open(&staging_id)
    .is_some_and(|staged| staged.path().join("audio-recovery.json").is_file())
  {
    return Err(owner_scope_required());
  }
  let path = staged_audio_files(&staging, &staging_id)?
    .into_iter()
    .find(|(found, _)| *found == index)
    .map(|(_, path)| path)
    .ok_or_else(staging_missing)?;
  read_audio(path).await
}

/// 一時置き場を消す（やめた・サーバーに書けた）。
#[tauri::command]
pub async fn shell_staging_discard(state: State<'_, AppState>, staging_id: String) -> CommandResult<()> {
  let staged = Staging::new(&state.data_dir)
    .open(&staging_id)
    .ok_or_else(staging_missing)?;
  if staged.path().join("audio-recovery.json").is_file() {
    return Err(owner_scope_required());
  }
  staged.remove().map_err(|_| staging_failed())
}

/// 文字起こしする音声の出どころ（id だけ）。
#[derive(Deserialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ShellAudioSource {
  /// この Mac で録った録音（`shell_recording_stop` の id）。
  #[serde(rename_all = "camelCase")]
  Recording { recording_id: String },
  /// 取り込んだ音声（`shell_audio_pick` の id）。
  #[serde(rename_all = "camelCase")]
  Staged { staging_id: String },
  /// server 正本の音声を job id 配下へ検証済み chunk として置いたもの。
  Server { files: usize },
}

const NATIVE_AUDIO_CHUNK_MAX: usize = 4 * 1024 * 1024;
const AUDIO_RECOVERY_FILE: &str = "audio-recovery.json";

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum NativeAudioSource {
  #[serde(rename_all = "camelCase")]
  Recording { recording_id: String },
  #[serde(rename_all = "camelCase")]
  Staged { staging_id: String },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellPreparedAudioFile {
  index: usize,
  name: String,
  bytes: u64,
  content_type: String,
  sha256: String,
  duration_sec: f64,
  offset_sec: f64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellAudioRecovery {
  staging_id: String,
  owner_scope: String,
  /// 30 日保持を再開のたびに延長しないための、最初に一時音声を作った時刻。
  created_at_ms: u64,
  state: String,
  source: NativeAudioSource,
  files: Vec<ShellPreparedAudioFile>,
}

fn now_ms() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis()
    .min(u64::MAX as u128) as u64
}

fn valid_owner_scope(value: &str) -> bool {
  value.len() == 64
    && value
      .bytes()
      .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn recovery_path(staged: &crate::staging::Staged) -> PathBuf {
  staged.path().join(AUDIO_RECOVERY_FILE)
}

fn read_recovery_raw(staged: &crate::staging::Staged) -> CommandResult<ShellAudioRecovery> {
  let bytes = fs::read(recovery_path(staged)).map_err(|_| staging_missing())?;
  serde_json::from_slice(&bytes).map_err(|_| staging_failed())
}

fn cleanup_audio_recovery(
  staged: &crate::staging::Staged,
  recovery: &ShellAudioRecovery,
  recorder: &crate::recording::Recorder,
) -> bool {
  if let NativeAudioSource::Recording { recording_id } = &recovery.source {
    if let Err(error) = recorder.discard(recording_id) {
      // 録音本体を消せなかったときに metadata だけ消すと、旧 read/discard の保護が外れる。Missing だけは掃除済みとして進める。
      if error != RecordingError::Missing {
        return false;
      }
    }
  }
  fs::remove_dir_all(staged.path()).is_ok()
}

fn read_recovery_for_use(
  staged: &crate::staging::Staged,
  recorder: &crate::recording::Recorder,
) -> CommandResult<ShellAudioRecovery> {
  let recovery = read_recovery_raw(staged)?;
  if crate::staging::audio_recovery_timestamp_is_current(recovery.created_at_ms, now_ms()) {
    return Ok(recovery);
  }
  // sourceが読める無効metadataは、録音本体を含む正規cleanupへ渡す。壊れて読めないmetadataは呼び出し側でfail closedのまま残す。
  let _ = cleanup_audio_recovery(staged, &recovery, recorder);
  Err(staging_missing())
}

fn write_recovery(staged: &crate::staging::Staged, value: &ShellAudioRecovery) -> CommandResult<()> {
  let bytes = serde_json::to_vec(value).map_err(|_| staging_failed())?;
  let temporary = staged.path().join("audio-recovery.json.part");
  fs::write(&temporary, bytes).map_err(|_| staging_failed())?;
  crate::process::set_mode(&temporary, 0o600).map_err(|_| staging_failed())?;
  fs::rename(temporary, recovery_path(staged)).map_err(|_| staging_failed())
}

fn recording_is_recovery_protected(data_dir: &std::path::Path, recording_id: &str) -> bool {
  let root = data_dir.join(crate::staging::STAGING_DIR);
  fs::read_dir(root).into_iter().flatten().flatten().any(|entry| {
    let id = entry.file_name().to_string_lossy().into_owned();
    let Some(staged) = Staging::new(data_dir).open(&id) else {
      return false;
    };
    if !recovery_path(&staged).is_file() {
      return false;
    }
    match read_recovery_raw(&staged) {
      Ok(recovery) => matches!(recovery.source, NativeAudioSource::Recording { recording_id: ref protected } if protected == recording_id),
      // 壊れたowner-scope metadataが旧read/discard保護を解除しないよう、対象を特定できない間は全録音を保護する。
      Err(_) => true,
    }
  })
}

/// 30 日を超えた owner scope 付き一時音声（録音本体を含む）と保存応答待ちの端末内認識結果を起動時に掃除する。
pub(crate) fn sweep_expired_audio_recovery(data_dir: &std::path::Path, recorder: &crate::recording::Recorder) -> usize {
  let staging = Staging::new(data_dir);
  let root = data_dir.join(crate::staging::STAGING_DIR);
  let now = now_ms();
  let mut removed = 0;
  for entry in fs::read_dir(root).into_iter().flatten().flatten() {
    let id = entry.file_name().to_string_lossy().into_owned();
    let Some(staged) = staging.open(&id) else { continue };
    let Ok(recovery) = read_recovery_raw(&staged) else {
      // mtimeへfallbackすると壊れたmetadataの書き直しで期限が延びるため、読めないものはfail closedで残す。
      continue;
    };
    if crate::staging::audio_recovery_timestamp_is_current(recovery.created_at_ms, now) {
      continue;
    }
    if cleanup_audio_recovery(&staged, &recovery, recorder) {
      removed += 1;
    }
  }
  removed + crate::shell_gemini_transcription::sweep_expired_local_audio(data_dir, now)
}

fn sha256_file(path: &std::path::Path) -> CommandResult<String> {
  use sha2::{Digest, Sha256};
  let mut file = fs::File::open(path).map_err(|_| staging_failed())?;
  let mut hash = Sha256::new();
  let mut chunk = [0u8; 1024 * 1024];
  loop {
    let read = file.read(&mut chunk).map_err(|_| staging_failed())?;
    if read == 0 {
      break;
    }
    hash.update(&chunk[..read]);
  }
  Ok(format!("{:x}", hash.finalize()))
}

fn prepared_recovery_intact(staged: &crate::staging::Staged, recovery: &ShellAudioRecovery) -> bool {
  if recovery.files.is_empty() || recovery.files.len() > 256 {
    return false;
  }
  let mut offset = 0.0;
  for (index, file) in recovery.files.iter().enumerate() {
    if file.index != index
      || file.content_type != "audio/wav"
      || file.bytes == 0
      || file.bytes > crate::store::AUDIO_FILE_MAX_BYTES
      || !file.duration_sec.is_finite()
      || file.duration_sec <= 0.0
      || file.offset_sec != offset
    {
      return false;
    }
    let path = staged.path().join("prepared").join(format!("f{index}.wav"));
    if fs::metadata(&path).map(|meta| meta.len()).ok() != Some(file.bytes)
      || sha256_file(&path).ok().as_deref() != Some(file.sha256.as_str())
    {
      return false;
    }
    offset += file.duration_sec;
  }
  offset <= crate::store::AUDIO_TOTAL_MAX_SEC
}

fn prepare_native_audio(
  data_dir: PathBuf,
  recorder: std::sync::Arc<crate::recording::Recorder>,
  job: std::sync::Arc<speech::SpeechJob>,
  source: NativeAudioSource,
  owner_scope: String,
  reuse_staging_id: Option<String>,
) -> CommandResult<ShellAudioRecovery> {
  if !valid_owner_scope(&owner_scope) {
    return Err(SpeechError::BadInput.into());
  }
  let staging = Staging::new(&data_dir);
  let staged = if let Some(staging_id) = reuse_staging_id {
    staging.open(&staging_id).ok_or_else(staging_missing)?
  } else {
    match &source {
      NativeAudioSource::Staged { staging_id } => staging.open(staging_id).ok_or_else(staging_missing)?,
      NativeAudioSource::Recording { recording_id } => {
        crate::safe_id(recording_id)?;
        // owner付き録音は既存の復旧metadataを通って再開する。別scopeの新stagingへ包み直せない。
        if recording_is_recovery_protected(&data_dir, recording_id) {
          return Err(owner_scope_required());
        }
        let input = recorder.recoverable_file(recording_id).ok_or(RecordingError::Missing)?;
        let staged = staging.create().map_err(|_| staging_failed())?;
        let ext = input
          .extension()
          .and_then(|value| value.to_str())
          .unwrap_or("caf")
          .to_ascii_lowercase();
        staged
          .copy_in("audio", &format!("0.{ext}"), &input)
          .map_err(|_| staging_failed())?;
        staged
      }
    }
  };
  if let NativeAudioSource::Recording { recording_id } = &source {
    let has_input = staged_audio_files(&staging, staged.id()).is_ok_and(|files| !files.is_empty());
    if !has_input {
      let input = recorder.recoverable_file(recording_id).ok_or(RecordingError::Missing)?;
      let ext = input
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("caf")
        .to_ascii_lowercase();
      staged
        .copy_in("audio", &format!("0.{ext}"), &input)
        .map_err(|_| staging_failed())?;
    }
  }
  let existing = if recovery_path(&staged).is_file() {
    let current = read_recovery_for_use(&staged, &recorder)?;
    if current.owner_scope != owner_scope {
      return Err(CommandError::new(
        "shell_audio_owner_changed",
        "別のログインの一時音声です。",
      ));
    }
    if current.state == "ready" && prepared_recovery_intact(&staged, &current) {
      return Ok(current);
    }
    Some(current)
  } else {
    None
  };
  let mut recovery = ShellAudioRecovery {
    staging_id: staged.id().to_string(),
    owner_scope,
    created_at_ms: existing.map(|value| value.created_at_ms).unwrap_or_else(now_ms),
    state: "preparing".to_string(),
    source,
    files: vec![],
  };
  write_recovery(&staged, &recovery)?;
  let inputs = staged_audio_files(&staging, staged.id())?
    .into_iter()
    .map(|(_, path)| path)
    .collect::<Vec<_>>();
  let prepared_dir = staged.path().join("prepared");
  let _ = fs::remove_dir_all(&prepared_dir);
  fs::create_dir(&prepared_dir).map_err(|_| staging_failed())?;
  crate::process::set_mode(&prepared_dir, 0o700).map_err(|_| staging_failed())?;
  let binary = speech::resolve_speech_binary().ok_or(SpeechError::NotFound)?;
  let converted = match speech::convert_audio(&job, &binary.path, &inputs, &prepared_dir, &mut |_| {}) {
    Ok(value) => value,
    Err(error) => {
      recovery.state = "failed".to_string();
      let _ = write_recovery(&staged, &recovery);
      return Err(error.into());
    }
  };
  let mut offset = 0.0;
  for (index, item) in converted.iter().enumerate() {
    let bytes = fs::metadata(&item.wav).map_err(|_| staging_failed())?.len();
    recovery.files.push(ShellPreparedAudioFile {
      index,
      name: format!("このMacの音声 {}.wav", index + 1),
      bytes,
      content_type: "audio/wav".to_string(),
      sha256: sha256_file(&item.wav)?,
      duration_sec: item.duration_sec,
      offset_sec: offset,
    });
    offset += item.duration_sec;
  }
  recovery.state = "ready".to_string();
  write_recovery(&staged, &recovery)?;
  Ok(recovery)
}

/// native 選択・録音を固定 WAV に変換し、owner scope に結び付けて復旧可能にする。
#[tauri::command]
pub async fn shell_audio_prepare(
  state: State<'_, AppState>,
  job_id: String,
  source: ShellAudioSource,
  owner_scope: String,
) -> CommandResult<ShellAudioRecovery> {
  let source = match source {
    ShellAudioSource::Recording { recording_id } => NativeAudioSource::Recording { recording_id },
    ShellAudioSource::Staged { staging_id } => NativeAudioSource::Staged { staging_id },
    ShellAudioSource::Server { .. } => return Err(SpeechError::BadInput.into()),
  };
  let data_dir = state.data_dir.clone();
  let recorder = state.recorder.clone();
  let job = crate::register_job(&state, &job_id)?;
  let result = match tauri::async_runtime::spawn_blocking(move || {
    prepare_native_audio(data_dir, recorder, job, source, owner_scope, None)
  })
  .await
  {
    Ok(result) => result,
    Err(_) => Err(blocking_failed()),
  };
  crate::forget_job(&state, &job_id);
  result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellRecordingStartV2 {
  staging_id: String,
  device: Value,
}

/// 録音開始前に owner scope 付き復旧 metadata を作る。異常終了後も同じ staging id から CAF を救出できる。
#[tauri::command]
pub async fn shell_recording_start_recoverable(
  state: State<'_, AppState>,
  recording_id: String,
  owner_scope: String,
  on_event: Channel<Value>,
) -> CommandResult<ShellRecordingStartV2> {
  crate::safe_id(&recording_id)?;
  if !valid_owner_scope(&owner_scope) {
    return Err(SpeechError::BadInput.into());
  }
  let staged = Staging::new(&state.data_dir).create().map_err(|_| staging_failed())?;
  let recovery = ShellAudioRecovery {
    staging_id: staged.id().to_string(),
    owner_scope,
    created_at_ms: now_ms(),
    state: "recording".to_string(),
    source: NativeAudioSource::Recording {
      recording_id: recording_id.clone(),
    },
    files: vec![],
  };
  write_recovery(&staged, &recovery)?;
  match shell_recording_start(state, recording_id, on_event).await {
    Ok(value) => Ok(ShellRecordingStartV2 {
      staging_id: staged.id().to_string(),
      device: value.get("device").cloned().unwrap_or(Value::Null),
    }),
    Err(error) => {
      let _ = staged.remove();
      Err(error)
    }
  }
}

#[tauri::command]
pub async fn shell_audio_prepare_resume(
  state: State<'_, AppState>,
  job_id: String,
  staging_id: String,
  owner_scope: String,
) -> CommandResult<ShellAudioRecovery> {
  let staged = Staging::new(&state.data_dir)
    .open(&staging_id)
    .ok_or_else(staging_missing)?;
  let current = read_recovery_for_use(&staged, &state.recorder)?;
  if current.owner_scope != owner_scope || !valid_owner_scope(&owner_scope) {
    return Err(CommandError::new(
      "shell_audio_owner_changed",
      "別のログインの一時音声です。",
    ));
  }
  let data_dir = state.data_dir.clone();
  let recorder = state.recorder.clone();
  let job = crate::register_job(&state, &job_id)?;
  let result = match tauri::async_runtime::spawn_blocking(move || {
    prepare_native_audio(data_dir, recorder, job, current.source, owner_scope, Some(staging_id))
  })
  .await
  {
    Ok(result) => result,
    Err(_) => Err(blocking_failed()),
  };
  crate::forget_job(&state, &job_id);
  result
}

#[tauri::command]
pub async fn shell_audio_prepared_chunk(
  state: State<'_, AppState>,
  staging_id: String,
  owner_scope: String,
  index: usize,
  offset: u64,
) -> CommandResult<Response> {
  if !valid_owner_scope(&owner_scope) {
    return Err(SpeechError::BadInput.into());
  }
  let staged = Staging::new(&state.data_dir)
    .open(&staging_id)
    .ok_or_else(staging_missing)?;
  let recovery = read_recovery_for_use(&staged, &state.recorder)?;
  if recovery.owner_scope != owner_scope {
    return Err(CommandError::new(
      "shell_audio_owner_changed",
      "別のログインの一時音声です。",
    ));
  }
  let file = recovery
    .files
    .iter()
    .find(|file| file.index == index)
    .ok_or_else(staging_missing)?
    .clone();
  if recovery.state != "ready" || offset >= file.bytes {
    return Err(SpeechError::BadInput.into());
  }
  let path = staged.path().join("prepared").join(format!("f{index}.wav"));
  tauri::async_runtime::spawn_blocking(move || {
    let mut source = fs::File::open(path).map_err(|_| staging_missing())?;
    source.seek(SeekFrom::Start(offset)).map_err(|_| staging_failed())?;
    let length =
      usize::try_from((file.bytes - offset).min(NATIVE_AUDIO_CHUNK_MAX as u64)).map_err(|_| staging_failed())?;
    let mut bytes = vec![0; length];
    source.read_exact(&mut bytes).map_err(|_| staging_failed())?;
    Ok(Response::new(bytes))
  })
  .await
  .map_err(|_| blocking_failed())?
}

#[tauri::command]
pub async fn shell_audio_recovery(
  state: State<'_, AppState>,
  owner_scope: String,
) -> CommandResult<Vec<ShellAudioRecovery>> {
  if !valid_owner_scope(&owner_scope) {
    return Err(SpeechError::BadInput.into());
  }
  let root = state.data_dir.join(crate::staging::STAGING_DIR);
  let mut found = Vec::new();
  for entry in fs::read_dir(root).into_iter().flatten().flatten() {
    let id = entry.file_name().to_string_lossy().into_owned();
    let Some(staged) = Staging::new(&state.data_dir).open(&id) else {
      continue;
    };
    let Ok(mut recovery) = read_recovery_raw(&staged) else {
      continue;
    };
    if recovery.owner_scope != owner_scope {
      continue;
    }
    if !crate::staging::audio_recovery_timestamp_is_current(recovery.created_at_ms, now_ms()) {
      let _ = cleanup_audio_recovery(&staged, &recovery, &state.recorder);
      continue;
    }
    if recovery.state == "preparing" || recovery.state == "recording" {
      recovery.state = "failed".to_string();
    }
    found.push(recovery);
  }
  Ok(found)
}

fn finish_audio_recovery(state: &AppState, staging_id: &str, owner_scope: &str) -> CommandResult<()> {
  let staged = Staging::new(&state.data_dir)
    .open(staging_id)
    .ok_or_else(staging_missing)?;
  let recovery = read_recovery_raw(&staged)?;
  if recovery.owner_scope != owner_scope || !valid_owner_scope(owner_scope) {
    return Err(CommandError::new(
      "shell_audio_owner_changed",
      "別のログインの一時音声です。",
    ));
  }
  if let NativeAudioSource::Recording { recording_id } = &recovery.source {
    if let Err(error) = state.recorder.discard(recording_id) {
      if error != RecordingError::Missing {
        return Err(CommandError::from(error));
      }
    }
  }
  staged.remove().map_err(|_| staging_failed())
}

/// server 保存成功後の片付け。
#[tauri::command]
pub async fn shell_audio_prepared_commit(
  state: State<'_, AppState>,
  staging_id: String,
  owner_scope: String,
) -> CommandResult<()> {
  finish_audio_recovery(&state, &staging_id, &owner_scope)
}

/// 本人が明示した破棄。成功保存と同じ対象だけを消す。
#[tauri::command]
pub async fn shell_audio_recovery_discard(
  state: State<'_, AppState>,
  staging_id: String,
  owner_scope: String,
) -> CommandResult<()> {
  finish_audio_recovery(&state, &staging_id, &owner_scope)
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShellTranscript {
  /// 区切り（`{"type":"segment",…}`）の行だけをつないだ JSONL。
  pub jsonl: String,
  pub duration_sec: f64,
}

pub(crate) fn audio_paths(state: &AppState, source: &ShellAudioSource) -> CommandResult<Vec<PathBuf>> {
  match source {
    ShellAudioSource::Recording { recording_id } => {
      crate::safe_id(recording_id)?;
      if recording_is_recovery_protected(&state.data_dir, recording_id) {
        return Err(owner_scope_required());
      }
      let path = state
        .recorder
        .exported_file(recording_id)
        .ok_or(RecordingError::Missing)?;
      Ok(vec![path])
    }
    ShellAudioSource::Staged { staging_id } => {
      let staging = Staging::new(&state.data_dir);
      if staging
        .open(staging_id)
        .is_some_and(|staged| recovery_path(&staged).is_file())
      {
        return Err(owner_scope_required());
      }
      Ok(
        staged_audio_files(&staging, staging_id)?
          .into_iter()
          .map(|(_, path)| path)
          .collect(),
      )
    }
    ShellAudioSource::Server { .. } => Err(SpeechError::BadInput.into()),
  }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedLocalTranscription {
  schema_version: u8,
  created_at_ms: u64,
  language: String,
  speaker_mode: String,
  files: usize,
  transcripts: Vec<ShellTranscript>,
}

const LOCAL_RESULT_MAX: u64 = 9 * 1024 * 1024;
const LOCAL_RESULT_FILE: &str = "local-result.json";

fn cached_local_result(
  state: &AppState,
  job_id: &str,
  language: &str,
  speaker_mode: &str,
  files: usize,
  created_at_ms: u64,
) -> CommandResult<Option<Vec<ShellTranscript>>> {
  let root = crate::shell_gemini_transcription::job_dir(state, job_id)?;
  let path = root.join(LOCAL_RESULT_FILE);
  let meta = match fs::metadata(&path) {
    Ok(meta) if meta.len() <= LOCAL_RESULT_MAX => meta,
    Ok(_) => return Err(blocking_failed()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(_) => return Err(blocking_failed()),
  };
  if meta.len() == 0 {
    return Err(blocking_failed());
  }
  let cached: CachedLocalTranscription =
    serde_json::from_slice(&fs::read(path).map_err(|_| blocking_failed())?).map_err(|_| blocking_failed())?;
  if cached.schema_version != 1
    || cached.created_at_ms != created_at_ms
    || cached.language != language
    || cached.speaker_mode != speaker_mode
    || cached.files != files
  {
    return Err(CommandError::new(
      "shell_local_result_changed",
      "保存待ちの文字起こしと設定が一致しません。",
    ));
  }
  if !crate::staging::audio_recovery_timestamp_is_current(cached.created_at_ms, now_ms()) {
    let _ = fs::remove_dir_all(root);
    return Err(staging_missing());
  }
  Ok(Some(cached.transcripts))
}

fn save_local_result(
  state: &AppState,
  job_id: &str,
  language: String,
  speaker_mode: String,
  files: usize,
  created_at_ms: u64,
  transcripts: &[ShellTranscript],
) -> CommandResult<()> {
  let root = crate::shell_gemini_transcription::job_dir(state, job_id)?;
  fs::create_dir_all(&root).map_err(|_| blocking_failed())?;
  crate::process::set_mode(&root, 0o700).map_err(|_| blocking_failed())?;
  let bytes = serde_json::to_vec(&CachedLocalTranscription {
    schema_version: 1,
    created_at_ms,
    language,
    speaker_mode,
    files,
    transcripts: transcripts.to_vec(),
  })
  .map_err(|_| blocking_failed())?;
  if bytes.is_empty() || bytes.len() as u64 > LOCAL_RESULT_MAX {
    return Err(blocking_failed());
  }
  let temporary = root.join("local-result.json.part");
  let final_path = root.join(LOCAL_RESULT_FILE);
  let mut file = fs::OpenOptions::new()
    .create(true)
    .truncate(true)
    .write(true)
    .open(&temporary)
    .map_err(|_| blocking_failed())?;
  file.write_all(&bytes).map_err(|_| blocking_failed())?;
  file.sync_all().map_err(|_| blocking_failed())?;
  crate::process::set_mode(&temporary, 0o600).map_err(|_| blocking_failed())?;
  fs::rename(temporary, final_path).map_err(|_| blocking_failed())
}

/// 端末内の文字起こし（同梱の niho-speech）。音声は id で引く。結果はサーバーへ画面が書く。
#[tauri::command]
pub async fn shell_transcribe_local(
  state: State<'_, AppState>,
  job_id: String,
  source: ShellAudioSource,
  language: String,
  speaker_mode: String,
  hints: Value,
  on_event: Channel<Value>,
) -> CommandResult<Vec<ShellTranscript>> {
  let server_files = match &source {
    ShellAudioSource::Server { files } => Some(*files),
    _ => None,
  };
  let server_created_at_ms = if let Some(files) = server_files {
    let root = crate::shell_gemini_transcription::job_dir(&state, &job_id)?;
    Some(crate::shell_gemini_transcription::server_audio_created_at_ms(
      &root, files,
    )?)
  } else {
    None
  };
  if let Some(files) = server_files {
    // Apple の server 正本経路は ledger の固定設定だけ。既存の録音/staged 経路の設定自由度は変えない。
    if !matches!(language.as_str(), "ja" | "en")
      || speaker_mode != "auto"
      || !hints.as_array().is_some_and(Vec::is_empty)
    {
      return Err(SpeechError::BadInput.into());
    }
    if let Some(cached) = cached_local_result(
      &state,
      &job_id,
      &language,
      &speaker_mode,
      files,
      server_created_at_ms.ok_or_else(staging_missing)?,
    )? {
      return Ok(cached);
    }
  }
  let paths = match source {
    ShellAudioSource::Server { files } => {
      let root = crate::shell_gemini_transcription::job_dir(&state, &job_id)?;
      crate::shell_gemini_transcription::server_audio_paths(&root, files)?
    }
    source => audio_paths(&state, &source)?,
  };
  if paths.is_empty()
    || !matches!(language.as_str(), "ja" | "en")
    || !matches!(speaker_mode.as_str(), "none" | "auto" | "2" | "3" | "4plus")
  {
    return Err(SpeechError::BadInput.into());
  }
  let binary = speech::resolve_speech_binary().ok_or(SpeechError::NotFound)?;
  let hints_json = speech::hints_json(&hints);
  let transcribe_language = language.clone();
  let transcribe_speaker_mode = speaker_mode.clone();
  let job = crate::register_job(&state, &job_id)?;
  let result = tauri::async_runtime::spawn_blocking(move || {
    speech::transcribe(
      &job,
      &binary.path,
      &paths,
      &transcribe_language,
      &hints_json,
      &transcribe_speaker_mode,
      &mut |value| {
        let _ = on_event.send(value);
      },
    )
  })
  .await
  .unwrap_or(Err(SpeechError::Failed));
  crate::forget_job(&state, &job_id);
  let transcripts = result?
    .into_iter()
    .map(|file| ShellTranscript {
      jsonl: file.jsonl,
      duration_sec: file.duration_sec,
    })
    .collect::<Vec<_>>();
  if let Some(files) = server_files {
    save_local_result(
      &state,
      &job_id,
      language,
      speaker_mode,
      files,
      server_created_at_ms.ok_or_else(staging_missing)?,
      &transcripts,
    )?;
  }
  Ok(transcripts)
}

/// Apple 端末内文字起こし専用名。実装は検証済み server staging を Gemini と共有するが、engine/route は共有しない。
#[tauri::command]
pub async fn shell_local_audio_begin(
  state: State<'_, AppState>,
  job_id: String,
  part_index: usize,
  bytes: u64,
  content_type: String,
  sha256: String,
) -> CommandResult<crate::shell_gemini_transcription::AudioStageState> {
  crate::shell_gemini_transcription::shell_gemini_audio_begin(state, job_id, part_index, bytes, content_type, sha256)
    .await
}

#[tauri::command]
pub async fn shell_local_audio_chunk(
  state: State<'_, AppState>,
  job_id: String,
  part_index: usize,
  offset: u64,
  chunk: Vec<u8>,
) -> CommandResult<u64> {
  crate::shell_gemini_transcription::shell_gemini_audio_chunk(state, job_id, part_index, offset, chunk).await
}

#[tauri::command]
pub async fn shell_local_audio_finish(
  state: State<'_, AppState>,
  job_id: String,
  part_index: usize,
) -> CommandResult<()> {
  crate::shell_gemini_transcription::shell_gemini_audio_finish(state, job_id, part_index).await
}

/// server 保存成功後だけ呼ぶ。保存不明・失敗時は音声と結果を残す。
#[tauri::command]
pub async fn shell_local_discard(state: State<'_, AppState>, job_id: String) -> CommandResult<()> {
  crate::shell_gemini_transcription::shell_gemini_discard(state, job_id).await
}

/// 端末内の文字起こしを止める（走っていなければ false）。
#[tauri::command]
pub async fn shell_transcribe_stop(state: State<'_, AppState>, job_id: String) -> CommandResult<bool> {
  let job = state
    .speech_jobs
    .lock()
    .ok()
    .and_then(|jobs| jobs.get(&job_id).cloned());
  match job {
    Some(job) => {
      job.stop();
      Ok(true)
    }
    None => Ok(false),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn web_screens_receive_dom_drags_and_legacy_local_keeps_native_file_drops() {
    let mut config: tauri::Config = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    assert!(
      !config.app.windows[0].drag_drop_enabled,
      "配布設定で HTML5 DnD を遮らない"
    );
    for mode in [ShellMode::Local, ShellMode::Remote, ShellMode::Dev, ShellMode::Local] {
      configure_drag_drop(&mut config, mode);
      // resident::recreate_main_window は app.config() の窓を clone して使う。
      let recreated = config
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .unwrap()
        .clone();
      assert_eq!(recreated.drag_drop_enabled, mode == ShellMode::Local, "{mode:?}");
    }
  }

  #[test]
  fn recovery_source_uses_the_browser_contract_field_names() {
    let recording = serde_json::to_value(NativeAudioSource::Recording {
      recording_id: "rec-1".to_string(),
    })
    .unwrap();
    assert_eq!(
      recording,
      serde_json::json!({ "kind": "recording", "recordingId": "rec-1" })
    );
    let staged = serde_json::to_value(NativeAudioSource::Staged {
      staging_id: "stage-1".to_string(),
    })
    .unwrap();
    assert_eq!(staged, serde_json::json!({ "kind": "staged", "stagingId": "stage-1" }));
    assert!(serde_json::from_value::<NativeAudioSource>(recording).is_ok());
    assert!(serde_json::from_value::<NativeAudioSource>(staged).is_ok());
  }

  fn temp_data_dir() -> PathBuf {
    let suffix = crate::process::hex(&crate::process::random_bytes::<6>().unwrap());
    let dir = std::env::temp_dir().join(format!("niho-shell-audio-test-{suffix}"));
    fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn owner_scoped_recovery_blocks_legacy_recording_access() {
    let data = temp_data_dir();
    let staged = Staging::new(&data).create().unwrap();
    write_recovery(
      &staged,
      &ShellAudioRecovery {
        staging_id: staged.id().to_string(),
        owner_scope: "a".repeat(64),
        created_at_ms: 1,
        state: "failed".to_string(),
        source: NativeAudioSource::Recording {
          recording_id: "rec-1".to_string(),
        },
        files: vec![],
      },
    )
    .unwrap();
    assert!(recording_is_recovery_protected(&data, "rec-1"));
    assert!(!recording_is_recovery_protected(&data, "rec-2"));
    let attempted = prepare_native_audio(
      data.clone(),
      Arc::new(crate::recording::Recorder::new(data.join("recordings"))),
      Arc::new(speech::SpeechJob::new()),
      NativeAudioSource::Recording {
        recording_id: "rec-1".to_string(),
      },
      "b".repeat(64),
      None,
    );
    assert_eq!(attempted.err().unwrap().code, "shell_audio_owner_scope_required");
    staged.remove().unwrap();
    let _ = fs::remove_dir_all(data);
  }

  #[test]
  fn recording_events_carry_no_paths() {
    let done = shell_recording_event(serde_json::json!({
      "type": "Done",
      "audio": {
        "recordingId": "rec-1",
        "path": "/Users/someone/Library/Application Support/life.niho.docs/recordings/rec-1.m4a",
        "name": "録音 10/16 15:30",
        "durationSec": 12.5
      }
    }));
    assert_eq!(
      done,
      serde_json::json!({
        "type": "Done",
        "audio": { "recordingId": "rec-1", "name": "録音 10/16 15:30", "durationSec": 12.5, "exported": true }
      })
    );
    assert!(!done.to_string().contains("/Users"));
    let caf = shell_recording_event(serde_json::json!({
      "type": "Done",
      "audio": { "recordingId": "rec-1", "path": "/d/recordings/rec-1.caf", "name": "n", "durationSec": null }
    }));
    assert_eq!(caf["audio"]["exported"], serde_json::json!(false));
    assert!(caf["audio"].get("path").is_none());
    for other in [
      serde_json::json!({ "type": "Started", "device": "USB マイク" }),
      serde_json::json!({ "type": "Level", "rms": 0.1, "peak": 0.2 }),
      serde_json::json!({ "type": "Error", "code": "no_input_device", "message": "x" }),
    ] {
      assert_eq!(shell_recording_event(other.clone()), other);
    }
  }

  #[test]
  fn remote_is_the_production_editor_only() {
    assert_eq!(shell_mode(None, false), ShellMode::Remote);
    assert_eq!(shell_mode(Some("remote"), false), ShellMode::Remote);
    assert_eq!(shell_mode(Some("remote"), true), ShellMode::Remote);
    assert_eq!(
      remote_url(ShellMode::Remote).unwrap().as_str(),
      "https://editor.niho.life/"
    );
  }

  #[test]
  fn pc_runner_is_only_available_to_the_bundled_screen() {
    assert!(ShellMode::Local.allows_pc_runner());
    assert!(!ShellMode::Remote.allows_pc_runner());
    assert!(!ShellMode::Dev.allows_pc_runner());
  }

  #[test]
  fn dev_editor_is_only_for_dev_launches() {
    assert_eq!(shell_mode(None, true), ShellMode::Local);
    assert_eq!(shell_mode(Some("dev"), true), ShellMode::Dev);
    assert_eq!(remote_url(ShellMode::Dev).unwrap().as_str(), "http://localhost:3000/");
    // 本番の起動で dev を指定しても、開発の画面は読まない
    assert_eq!(shell_mode(Some("dev"), false), ShellMode::Remote);
  }

  #[test]
  fn invalid_overrides_never_select_local_in_release() {
    for value in [Some(""), Some("https://example.com"), Some("REMOTE")] {
      assert_eq!(shell_mode(value, true), ShellMode::Local, "dev: {value:?}");
      assert_eq!(shell_mode(value, false), ShellMode::Remote, "release: {value:?}");
    }
    assert_eq!(shell_mode(Some("local"), false), ShellMode::Remote);
    assert_eq!(shell_mode(Some("local"), true), ShellMode::Local);
    assert_eq!(remote_url(ShellMode::Local), None);
  }

  #[test]
  fn audio_source_is_id_only() {
    let recording: ShellAudioSource =
      serde_json::from_value(serde_json::json!({ "kind": "recording", "recordingId": "rec-1" })).unwrap();
    assert_eq!(
      recording,
      ShellAudioSource::Recording {
        recording_id: "rec-1".into()
      }
    );
    let staged: ShellAudioSource =
      serde_json::from_value(serde_json::json!({ "kind": "staged", "stagingId": "0123456789abcdef" })).unwrap();
    assert_eq!(
      staged,
      ShellAudioSource::Staged {
        staging_id: "0123456789abcdef".into()
      }
    );
    // パスは受け取らない
    assert!(
      serde_json::from_value::<ShellAudioSource>(serde_json::json!({ "kind": "path", "path": "/tmp/a.m4a" })).is_err()
    );
  }

  #[test]
  fn staged_audio_keeps_only_audio_files_and_no_paths() {
    let data = std::env::temp_dir().join(format!(
      "niho-docs-shell-test-{}",
      crate::process::hex(&crate::process::random_bytes::<6>().unwrap())
    ));
    fs::create_dir_all(&data).unwrap();
    let audio = data.join("talk.m4a");
    fs::write(&audio, b"not really audio").unwrap();
    let text = data.join("notes.txt");
    fs::write(&text, b"text").unwrap();
    let staging = Staging::new(&data);
    let staged = stage_audio(&staging, vec![audio.clone(), text.clone()])
      .unwrap()
      .expect("1 つは音声");
    assert_eq!(staged.files.len(), 1);
    assert_eq!(staged.files[0].index, 0);
    assert_eq!(staged.files[0].name, "talk.m4a");
    let json = serde_json::to_value(&staged).unwrap();
    assert!(
      !json.to_string().contains(data.to_string_lossy().as_ref()),
      "パスが混ざっている"
    );
    let files = staged_audio_files(&staging, &staged.staging_id).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(fs::read(&files[0].1).unwrap(), b"not really audio");
    // 音声でないものだけなら置き場を作らない
    assert!(stage_audio(&staging, vec![text]).unwrap().is_none());
    let _ = fs::remove_dir_all(&data);
  }

  #[test]
  fn capabilities_carry_no_paths_or_secrets() {
    let json = serde_json::to_value(capabilities(false)).unwrap();
    assert_eq!(json["dev"], serde_json::json!(false));
    assert_eq!(
      json["features"],
      serde_json::json!({
        "recording": true,
        "localTranscription": true,
        "localTranscriptionV2": true,
        "nativeAudioV2": true,
        "cliAi": true,
        "geminiCliTranscription": true
      })
    );
    assert_eq!(json["version"], serde_json::json!(env!("CARGO_PKG_VERSION")));
    assert_eq!(json.as_object().unwrap().len(), 3);
  }
}
