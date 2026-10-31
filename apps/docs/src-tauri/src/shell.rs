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
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
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
/// どの画面を読むかの環境変数。`remote`＝editor.niho.life、`dev`＝開発の画面（開発の起動だけ）、それ以外＝今までの画面。
pub const SHELL_ENV: &str = "NIHO_DOCS_SHELL";

/// 殻が読む画面。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellMode {
  /// 今までの画面（同梱の index.html。旧 NIHO docs。殻に置き換わるまでの既定）。
  Local,
  /// editor.niho.life。
  Remote,
  /// 開発の editor（localhost）。開発・試験の起動でだけ選べる。
  Dev,
}

/// `NIHO_DOCS_SHELL` の値と、開発の起動かどうかから、読む画面を決める。知らない値・本番での `dev` は今までの画面。
pub fn shell_mode(value: Option<&str>, dev: bool) -> ShellMode {
  match value.map(str::trim) {
    Some("remote") => ShellMode::Remote,
    Some("dev") if dev => ShellMode::Dev,
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
  /// CLI の AI（Claude Code・Codex CLI・Antigravity CLI）。
  pub cli_ai: bool,
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
      cli_ai: true,
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
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShellTranscript {
  /// 区切り（`{"type":"segment",…}`）の行だけをつないだ JSONL。
  pub jsonl: String,
  pub duration_sec: f64,
}

fn audio_paths(state: &AppState, source: &ShellAudioSource) -> CommandResult<Vec<PathBuf>> {
  match source {
    ShellAudioSource::Recording { recording_id } => {
      crate::safe_id(recording_id)?;
      let path = state
        .recorder
        .exported_file(recording_id)
        .ok_or(RecordingError::Missing)?;
      Ok(vec![path])
    }
    ShellAudioSource::Staged { staging_id } => Ok(
      staged_audio_files(&Staging::new(&state.data_dir), staging_id)?
        .into_iter()
        .map(|(_, path)| path)
        .collect(),
    ),
  }
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
  let paths = audio_paths(&state, &source)?;
  if paths.is_empty()
    || !matches!(language.as_str(), "ja" | "en")
    || !matches!(speaker_mode.as_str(), "none" | "auto" | "2" | "3" | "4plus")
  {
    return Err(SpeechError::BadInput.into());
  }
  let binary = speech::resolve_speech_binary().ok_or(SpeechError::NotFound)?;
  let hints_json = speech::hints_json(&hints);
  let job = crate::register_job(&state, &job_id)?;
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
  crate::forget_job(&state, &job_id);
  Ok(
    result?
      .into_iter()
      .map(|file| ShellTranscript {
        jsonl: file.jsonl,
        duration_sec: file.duration_sec,
      })
      .collect(),
  )
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
    assert_eq!(shell_mode(Some("remote"), false), ShellMode::Remote);
    assert_eq!(shell_mode(Some("remote"), true), ShellMode::Remote);
    assert_eq!(
      remote_url(ShellMode::Remote).unwrap().as_str(),
      "https://editor.niho.life/"
    );
  }

  #[test]
  fn dev_editor_is_only_for_dev_launches() {
    assert_eq!(shell_mode(Some("dev"), true), ShellMode::Dev);
    assert_eq!(remote_url(ShellMode::Dev).unwrap().as_str(), "http://localhost:3000/");
    // 本番の起動で dev を指定しても、開発の画面は読まない
    assert_eq!(shell_mode(Some("dev"), false), ShellMode::Local);
  }

  #[test]
  fn anything_else_keeps_the_bundled_screen() {
    for value in [
      None,
      Some(""),
      Some("local"),
      Some("https://example.com"),
      Some("REMOTE"),
    ] {
      assert_eq!(shell_mode(value, true), ShellMode::Local, "{value:?}");
    }
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
      serde_json::json!({ "recording": true, "localTranscription": true, "cliAi": true })
    );
    assert_eq!(json["version"], serde_json::json!(env!("CARGO_PKG_VERSION")));
    assert_eq!(json.as_object().unwrap().len(), 3);
  }
}
