//! editor.niho.life 用の Gemini CLI 文字起こし。remote から受けるのは UUID・part番号・上限付き音声chunkと
//! docs-core が作った上限付きpromptだけ。URL・資格情報・パス・CLI引数・環境は受け取らない。

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;

use crate::contract::{Effort, Provider, ToolPolicy, TurnRequest};
use crate::process::{hex, set_mode};
use crate::shell::ShellAudioSource;
use crate::speech::{self, PreparedFile, SpeechError, SpeechJob};
use crate::{AppState, CommandError, CommandResult};

const ROOT_DIR: &str = "gemini-transcription";
const MODEL: &str = "gemini-3.8-flash";
const CHUNK_MAX: usize = 4 * 1024 * 1024;
const FILE_MAX: u64 = 2 * 1024 * 1024 * 1024;
// 完了区間と結合後の保存待ち結果を両方保持する。本文8MiBずつにJSON・参考文の余裕を持たせる。
const CHECKPOINT_MAX: usize = 32 * 1024 * 1024;
const PROMPT_MAX: usize = 1024 * 1024;
const PART_LIMIT: Duration = Duration::from_secs(20 * 60);

fn bad_request() -> CommandError {
  CommandError::new("shell_gemini_bad_request", "文字起こしの依頼の形が正しくありません。")
}

fn failed() -> CommandError {
  CommandError::new("shell_gemini_failed", "この Mac で文字起こしを続けられませんでした。")
}

fn missing() -> CommandError {
  CommandError::new(
    "shell_gemini_missing",
    "文字起こしの準備が見つかりません。もう一度始めてください。",
  )
}

fn uuid(value: &str) -> bool {
  let bytes = value.as_bytes();
  bytes.len() == 36
    && matches!(bytes[14], b'1'..=b'5')
    && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
    && bytes.iter().enumerate().all(|(index, byte)| match index {
      8 | 13 | 18 | 23 => *byte == b'-',
      _ => byte.is_ascii_hexdigit(),
    })
}

fn job_dir(state: &AppState, job_id: &str) -> CommandResult<PathBuf> {
  if !uuid(job_id) {
    return Err(bad_request());
  }
  Ok(state.data_dir.join(ROOT_DIR).join(job_id.to_ascii_lowercase()))
}

fn job_key(job_id: &str) -> CommandResult<String> {
  if !uuid(job_id) {
    return Err(bad_request());
  }
  Ok(job_id.to_ascii_lowercase())
}

fn private_dir(path: &Path) -> CommandResult<()> {
  fs::create_dir_all(path).map_err(|_| failed())?;
  set_mode(path, 0o700).map_err(|_| failed())
}

fn content_extension(content_type: &str) -> Option<&'static str> {
  match content_type.split(';').next()?.trim().to_ascii_lowercase().as_str() {
    "audio/mp4" | "audio/x-m4a" => Some("m4a"),
    "audio/mpeg" => Some("mp3"),
    "audio/wav" | "audio/x-wav" => Some("wav"),
    "audio/aac" => Some("aac"),
    "audio/flac" | "audio/x-flac" => Some("flac"),
    "audio/ogg" => Some("ogg"),
    "audio/webm" => Some("webm"),
    _ => None,
  }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioMeta {
  part_index: usize,
  bytes: u64,
  content_type: String,
  sha256: String,
  extension: String,
}

fn meta_path(audio: &Path, part: usize) -> PathBuf {
  audio.join(format!("{part}.json"))
}

fn partial_path(audio: &Path, part: usize) -> PathBuf {
  audio.join(format!("{part}.part"))
}

fn final_path(audio: &Path, meta: &AudioMeta) -> PathBuf {
  audio.join(format!("{}.{}", meta.part_index, meta.extension))
}

fn read_meta(audio: &Path, part: usize) -> CommandResult<AudioMeta> {
  let bytes = fs::read(meta_path(audio, part)).map_err(|_| missing())?;
  serde_json::from_slice(&bytes).map_err(|_| missing())
}

fn write_private(path: &Path, bytes: &[u8]) -> CommandResult<()> {
  fs::write(path, bytes).map_err(|_| failed())?;
  set_mode(path, 0o600).map_err(|_| failed())
}

fn valid_sha256(value: &str) -> bool {
  value.len() == 64
    && value
      .bytes()
      .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_chunk_append(current: u64, offset: u64, chunk_len: usize, total: u64, finished: bool) -> bool {
  current == offset
    && !finished
    && chunk_len > 0
    && chunk_len <= CHUNK_MAX
    && offset.saturating_add(chunk_len as u64) <= total
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStageState {
  received_bytes: u64,
  complete: bool,
}

/// server音声1本の受け入れを開始/再開する。既存のpartialは同じmanifestのときだけ使う。
#[tauri::command]
pub async fn shell_gemini_audio_begin(
  state: State<'_, AppState>,
  job_id: String,
  part_index: usize,
  bytes: u64,
  content_type: String,
  sha256: String,
) -> CommandResult<AudioStageState> {
  if part_index > 255 || bytes == 0 || bytes > FILE_MAX || !valid_sha256(&sha256) {
    return Err(bad_request());
  }
  let extension = content_extension(&content_type).ok_or_else(bad_request)?;
  let (key, operation) = job_operation(&job_id)?;
  let _operation = operation.lock().await;
  if let Some(job) = jobs().lock().unwrap_or_else(PoisonError::into_inner).get_mut(&key) {
    if job.cancelled.swap(false, Ordering::SeqCst) {
      job.speech = Some(Arc::new(SpeechJob::new()));
    }
  }
  let root = job_dir(&state, &key)?;
  let audio = root.join("audio");
  private_dir(&audio)?;
  let requested = AudioMeta {
    part_index,
    bytes,
    content_type,
    sha256,
    extension: extension.to_string(),
  };
  let meta_file = meta_path(&audio, part_index);
  if meta_file.is_file() {
    let current = read_meta(&audio, part_index)?;
    if current.bytes != requested.bytes
      || current.content_type != requested.content_type
      || current.sha256 != requested.sha256
      || current.extension != requested.extension
    {
      return Err(CommandError::new(
        "shell_gemini_audio_changed",
        "音声が変わりました。もう一度始めてください。",
      ));
    }
  } else {
    write_private(&meta_file, &serde_json::to_vec(&requested).map_err(|_| failed())?)?;
  }
  let complete = final_path(&audio, &requested).is_file();
  let received_bytes = if complete {
    bytes
  } else {
    fs::metadata(partial_path(&audio, part_index))
      .map(|meta| meta.len())
      .unwrap_or(0)
  };
  if received_bytes > bytes {
    return Err(failed());
  }
  Ok(AudioStageState {
    received_bytes,
    complete,
  })
}

/// 最大4MiBの連番chunkを追記する。offsetが違えば拒否し、巨大number[]や一括2GiBを作らない。
#[tauri::command]
pub async fn shell_gemini_audio_chunk(
  state: State<'_, AppState>,
  job_id: String,
  part_index: usize,
  offset: u64,
  chunk: Vec<u8>,
) -> CommandResult<u64> {
  if part_index > 255 || chunk.is_empty() || chunk.len() > CHUNK_MAX {
    return Err(bad_request());
  }
  let (key, operation) = job_operation(&job_id)?;
  let _operation = operation.lock().await;
  let root = job_dir(&state, &key)?;
  let audio = root.join("audio");
  let meta = read_meta(&audio, part_index)?;
  let path = partial_path(&audio, part_index);
  let current = fs::metadata(&path).map(|item| item.len()).unwrap_or(0);
  if !valid_chunk_append(
    current,
    offset,
    chunk.len(),
    meta.bytes,
    final_path(&audio, &meta).exists(),
  ) {
    return Err(bad_request());
  }
  let mut file = OpenOptions::new()
    .create(true)
    .append(true)
    .open(&path)
    .map_err(|_| failed())?;
  file.write_all(&chunk).map_err(|_| failed())?;
  file.sync_data().map_err(|_| failed())?;
  set_mode(&path, 0o600).map_err(|_| failed())?;
  Ok(offset + chunk.len() as u64)
}

/// 長さとSHA-256を照合してから確定名へrenameする。
#[tauri::command]
pub async fn shell_gemini_audio_finish(
  state: State<'_, AppState>,
  job_id: String,
  part_index: usize,
) -> CommandResult<()> {
  if part_index > 255 {
    return Err(bad_request());
  }
  let (key, operation) = job_operation(&job_id)?;
  let _operation = operation.lock().await;
  let root = job_dir(&state, &key)?;
  let audio = root.join("audio");
  let meta = read_meta(&audio, part_index)?;
  let target = final_path(&audio, &meta);
  if target.is_file() {
    return Ok(());
  }
  let partial = partial_path(&audio, part_index);
  let mut file = fs::File::open(&partial).map_err(|_| missing())?;
  let mut hasher = Sha256::new();
  let mut buffer = [0u8; 64 * 1024];
  let mut size = 0u64;
  loop {
    let read = file.read(&mut buffer).map_err(|_| failed())?;
    if read == 0 {
      break;
    }
    size += read as u64;
    hasher.update(&buffer[..read]);
  }
  if size != meta.bytes || hex(&hasher.finalize()) != meta.sha256 {
    return Err(CommandError::new(
      "shell_gemini_audio_invalid",
      "音声を正しく受け取れませんでした。もう一度お試しください。",
    ));
  }
  fs::rename(partial, target).map_err(|_| failed())
}

struct RuntimeJob {
  operation: Arc<AsyncMutex<()>>,
  speech: Option<Arc<SpeechJob>>,
  prepared: Vec<PreparedFile>,
  active_turn: Option<String>,
  cancelled: Arc<AtomicBool>,
}

impl RuntimeJob {
  fn new() -> Self {
    Self {
      operation: Arc::new(AsyncMutex::new(())),
      speech: None,
      prepared: Vec::new(),
      active_turn: None,
      cancelled: Arc::new(AtomicBool::new(false)),
    }
  }
}

fn jobs() -> &'static Mutex<HashMap<String, RuntimeJob>> {
  static JOBS: OnceLock<Mutex<HashMap<String, RuntimeJob>>> = OnceLock::new();
  JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn job_operation(job_id: &str) -> CommandResult<(String, Arc<AsyncMutex<()>>)> {
  let key = job_key(job_id)?;
  let operation = jobs()
    .lock()
    .unwrap_or_else(PoisonError::into_inner)
    .entry(key.clone())
    .or_insert_with(RuntimeJob::new)
    .operation
    .clone();
  Ok((key, operation))
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GeminiAudioSource {
  Server { files: usize },
  Recording { recording_id: String },
  Staged { staging_id: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioPartDto {
  start_sec: f64,
  end_sec: f64,
  sound_sec: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedFileDto {
  duration_sec: f64,
  parts: Vec<AudioPartDto>,
}

fn prepared_dto(prepared: &[PreparedFile]) -> Vec<PreparedFileDto> {
  prepared
    .iter()
    .map(|file| PreparedFileDto {
      duration_sec: file.duration_sec,
      parts: file
        .bounds
        .iter()
        .zip(&file.sound_sec)
        .map(|((start_sec, end_sec), sound_sec)| AudioPartDto {
          start_sec: *start_sec,
          end_sec: *end_sec,
          sound_sec: *sound_sec,
        })
        .collect(),
    })
    .collect()
}

fn prepared_part(prepared: &[PreparedFile], file: usize, part: usize) -> CommandResult<(PathBuf, (f64, f64))> {
  prepared
    .get(file)
    .and_then(|item| item.bounds.get(part).map(|bounds| (item.wav.clone(), *bounds)))
    .ok_or_else(missing)
}

fn server_audio_paths(root: &Path, files: usize) -> CommandResult<Vec<PathBuf>> {
  if files == 0 || files > 256 {
    return Err(bad_request());
  }
  let audio = root.join("audio");
  (0..files)
    .map(|part| {
      let meta = read_meta(&audio, part)?;
      let path = final_path(&audio, &meta);
      path.is_file().then_some(path).ok_or_else(missing)
    })
    .collect()
}

/// server stagingまたは既存ShellAudioSourceをprepare_audioへ渡す。Geminiのtargetはspeech.rsの固定600秒。
#[tauri::command]
pub async fn shell_gemini_prepare(
  state: State<'_, AppState>,
  job_id: String,
  source: GeminiAudioSource,
  on_event: Channel<Value>,
) -> CommandResult<Vec<PreparedFileDto>> {
  let (key, operation) = job_operation(&job_id)?;
  let _operation = operation.lock().await;
  let root = job_dir(&state, &key)?;
  private_dir(&root)?;
  {
    let guard = jobs().lock().unwrap_or_else(PoisonError::into_inner);
    let job = guard.get(&key).ok_or_else(missing)?;
    if job.cancelled.load(Ordering::SeqCst) {
      return Err(SpeechError::Stopped.into());
    }
    if !job.prepared.is_empty() {
      return Ok(prepared_dto(&job.prepared));
    }
  }
  let paths = match source {
    GeminiAudioSource::Server { files } => server_audio_paths(&root, files)?,
    GeminiAudioSource::Recording { recording_id } => {
      crate::shell::audio_paths(&state, &ShellAudioSource::Recording { recording_id })?
    }
    GeminiAudioSource::Staged { staging_id } => {
      crate::shell::audio_paths(&state, &ShellAudioSource::Staged { staging_id })?
    }
  };
  let prepared_dir = root.join("prepared");
  let _ = fs::remove_dir_all(&prepared_dir);
  private_dir(&prepared_dir)?;
  let binary = speech::resolve_speech_binary().ok_or(SpeechError::NotFound)?;
  let speech_job = Arc::new(SpeechJob::new());
  {
    let mut guard = jobs().lock().unwrap_or_else(PoisonError::into_inner);
    let job = guard.get_mut(&key).ok_or_else(missing)?;
    job.speech = Some(speech_job.clone());
  }
  let worker = speech_job.clone();
  let dir = prepared_dir.clone();
  let prepared = tauri::async_runtime::spawn_blocking(move || {
    speech::prepare_audio(&worker, &binary.path, &paths, &dir, &mut |event| {
      let _ = on_event.send(event);
    })
  })
  .await
  .unwrap_or(Err(SpeechError::Failed))?;
  let dto = prepared_dto(&prepared);
  if let Some(job) = jobs().lock().unwrap_or_else(PoisonError::into_inner).get_mut(&key) {
    if job.cancelled.load(Ordering::SeqCst) {
      return Err(SpeechError::Stopped.into());
    }
    job.prepared = prepared;
  }
  Ok(dto)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiTurnResult {
  final_event: Value,
}

/// 固定のGeminiCli/3.8 Flash/lowとReadFileだけで1区間を実行する。
#[tauri::command]
pub async fn shell_gemini_transcribe_part(
  state: State<'_, AppState>,
  job_id: String,
  turn_id: String,
  file: usize,
  part: usize,
  system_prompt: String,
  user_prompt: String,
  on_event: Channel<Value>,
) -> CommandResult<GeminiTurnResult> {
  if !uuid(&job_id) || !uuid(&turn_id) || system_prompt.len() > PROMPT_MAX || user_prompt.len() > PROMPT_MAX {
    return Err(bad_request());
  }
  let (key, operation) = job_operation(&job_id)?;
  let _operation = operation.lock().await;
  let root = job_dir(&state, &key)?;
  let (speech_job, prepared, cancelled) = {
    let mut guard = jobs().lock().unwrap_or_else(PoisonError::into_inner);
    let job = guard.get_mut(&key).ok_or_else(missing)?;
    if job.cancelled.load(Ordering::SeqCst) {
      return Err(SpeechError::Stopped.into());
    }
    if job.active_turn.is_some() {
      return Err(CommandError::new(
        "shell_gemini_busy",
        "この文字起こしはまだ動いています。",
      ));
    }
    let speech = job.speech.clone().ok_or_else(missing)?;
    let prepared = job.prepared.clone();
    job.active_turn = Some(turn_id.clone());
    (speech, prepared, job.cancelled.clone())
  };
  let result = async {
    let (wav, (start, end)) = prepared_part(&prepared, file, part)?;
    let binary = speech::resolve_speech_binary().ok_or(SpeechError::NotFound)?;
    let slice = root.join("prepared").join(format!("f{file}-p{part}.wav"));
    let target = slice.clone();
    tauri::async_runtime::spawn_blocking(move || {
      speech::slice_part(&speech_job, &binary.path, &wav, start, end, &target)
    })
    .await
    .unwrap_or(Err(SpeechError::Failed))?;
    if cancelled.load(Ordering::SeqCst) {
      return Err(SpeechError::Stopped.into());
    }
    let turn = TurnRequest {
      provider: Provider::GeminiCli,
      model: MODEL.to_string(),
      effort: Some(Effort::Low),
      system_prompt,
      user_prompt,
      resume_session: None,
      workdir: root.join("prepared"),
      timeout: PART_LIMIT,
      max_budget_usd: None,
      tool_policy: ToolPolicy::ReadFile { file: slice.clone() },
    };
    let final_event =
      crate::drive_turn_with(&state, turn_id.clone(), turn, on_event, None, Some(cancelled.clone())).await;
    let _ = fs::remove_file(slice);
    Ok(GeminiTurnResult { final_event })
  }
  .await;
  if let Some(job) = jobs().lock().unwrap_or_else(PoisonError::into_inner).get_mut(&key) {
    if job.active_turn.as_deref() == Some(&turn_id) {
      job.active_turn = None;
    }
  }
  result
}

#[tauri::command]
pub async fn shell_gemini_checkpoint_read(state: State<'_, AppState>, job_id: String) -> CommandResult<Option<Value>> {
  let (key, operation) = job_operation(&job_id)?;
  let _operation = operation.lock().await;
  let path = job_dir(&state, &key)?.join("checkpoint.json");
  let bytes = match fs::read(path) {
    Ok(bytes) => bytes,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(_) => return Err(failed()),
  };
  if bytes.len() > CHECKPOINT_MAX {
    return Err(failed());
  }
  serde_json::from_slice(&bytes).map(Some).map_err(|_| failed())
}

fn checkpoint_version(value: &Value, job_id: &str) -> CommandResult<(u64, u64, u64)> {
  let object = value.as_object().ok_or_else(bad_request)?;
  if object
    .get("runId")
    .and_then(Value::as_str)
    .and_then(|value| job_key(value).ok())
    .as_deref()
    != Some(job_id)
  {
    return Err(bad_request());
  }
  let generation = object
    .get("generation")
    .and_then(Value::as_u64)
    .filter(|value| *value > 0)
    .ok_or_else(bad_request)?;
  let revision = object.get("revision").and_then(Value::as_u64).ok_or_else(bad_request)?;
  let previous_revision = object
    .get("previousRevision")
    .and_then(Value::as_u64)
    .ok_or_else(bad_request)?;
  if previous_revision.checked_add(1) != Some(revision) {
    return Err(bad_request());
  }
  Ok((generation, revision, previous_revision))
}

fn checkpoint_can_replace(incoming: (u64, u64, u64), existing: (u64, u64, u64)) -> bool {
  incoming.0 >= existing.0 && incoming.1 > existing.1 && incoming.2 == existing.1
}

#[tauri::command]
pub async fn shell_gemini_checkpoint_write(
  state: State<'_, AppState>,
  job_id: String,
  checkpoint: Value,
) -> CommandResult<()> {
  let (key, operation) = job_operation(&job_id)?;
  let _operation = operation.lock().await;
  let root = job_dir(&state, &key)?;
  private_dir(&root)?;
  let bytes = serde_json::to_vec(&checkpoint).map_err(|_| bad_request())?;
  if bytes.len() > CHECKPOINT_MAX || !checkpoint.is_object() {
    return Err(bad_request());
  }
  let incoming = checkpoint_version(&checkpoint, &key)?;
  let checkpoint_path = root.join("checkpoint.json");
  match fs::read(&checkpoint_path) {
    Ok(current_bytes) => {
      if current_bytes.len() > CHECKPOINT_MAX {
        return Err(failed());
      }
      let current: Value = serde_json::from_slice(&current_bytes).map_err(|_| failed())?;
      let existing = checkpoint_version(&current, &key).map_err(|_| failed())?;
      if !checkpoint_can_replace(incoming, existing) {
        return Err(CommandError::new(
          "shell_gemini_checkpoint_stale",
          "古い文字起こしの保存状態は反映しませんでした。",
        ));
      }
    }
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
      if incoming.1 != 1 || incoming.2 != 0 {
        return Err(bad_request());
      }
    }
    Err(_) => return Err(failed()),
  }
  let temp = root.join("checkpoint.tmp");
  write_private(&temp, &bytes)?;
  fs::rename(temp, checkpoint_path).map_err(|_| failed())
}

#[tauri::command]
pub async fn shell_gemini_stop(state: State<'_, AppState>, job_id: String) -> CommandResult<bool> {
  let (key, _) = job_operation(&job_id)?;
  let (speech, turn) = {
    let guard = jobs().lock().unwrap_or_else(PoisonError::into_inner);
    let job = guard.get(&key).ok_or_else(missing)?;
    job.cancelled.store(true, Ordering::SeqCst);
    (job.speech.clone(), job.active_turn.clone())
  };
  let found = speech.is_some() || turn.is_some();
  if let Some(job) = speech {
    job.stop();
  }
  if let Some(turn_id) = turn {
    if let Some(handle) = state.turns.lock().ok().and_then(|turns| turns.get(&turn_id).cloned()) {
      handle.stop();
    }
  }
  Ok(found)
}

/// server保存成功後だけ呼ぶ。失敗・停止・保存待ちは音声とcheckpointを残す。
#[tauri::command]
pub async fn shell_gemini_discard(state: State<'_, AppState>, job_id: String) -> CommandResult<()> {
  let (key, operation) = job_operation(&job_id)?;
  let _operation = operation
    .try_lock()
    .map_err(|_| CommandError::new("shell_gemini_busy", "この文字起こしはまだ動いています。"))?;
  let root = job_dir(&state, &key)?;
  if let Some(job) = jobs().lock().unwrap_or_else(PoisonError::into_inner).remove(&key) {
    job.cancelled.store(true, Ordering::SeqCst);
    if let Some(speech) = job.speech {
      speech.stop();
    }
    if let Some(turn_id) = job.active_turn {
      if let Some(handle) = state.turns.lock().ok().and_then(|turns| turns.get(&turn_id).cloned()) {
        handle.stop();
      }
    }
  }
  match fs::remove_dir_all(root) {
    Ok(()) => Ok(()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(_) => Err(failed()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn accepts_only_uuid_ids_and_fixed_audio_types() {
    assert!(uuid("00000000-0000-4000-8000-000000000001"));
    for value in [
      "../audio",
      "https://example.invalid/a",
      "/tmp/a",
      "00000000-0000-0000-0000-000000000000",
      "00000000-0000-4000-8000-000000000001/x",
    ] {
      assert!(!uuid(value), "{value}");
    }
    assert_eq!(content_extension("audio/mp4; codecs=mp4a"), Some("m4a"));
    assert_eq!(content_extension("text/plain"), None);
  }

  #[test]
  fn limits_match_bounded_ipc_contract() {
    assert_eq!(CHUNK_MAX, 4 * 1024 * 1024);
    assert_eq!(speech::GEMINI_SILENCE_TARGET_SEC, "600");
    assert_eq!(MODEL, "gemini-3.8-flash");
  }

  #[test]
  fn decodes_camel_case_audio_source_fields() {
    let recording: GeminiAudioSource =
      serde_json::from_value(json!({ "kind": "recording", "recordingId": "rec-1" })).unwrap();
    assert!(matches!(recording, GeminiAudioSource::Recording { recording_id } if recording_id == "rec-1"));
    let staged: GeminiAudioSource =
      serde_json::from_value(json!({ "kind": "staged", "stagingId": "stage-1" })).unwrap();
    assert!(matches!(staged, GeminiAudioSource::Staged { staging_id } if staging_id == "stage-1"));
    assert!(
      serde_json::from_value::<GeminiAudioSource>(json!({ "kind": "recording", "recording_id": "rec-1" })).is_err()
    );
  }

  #[test]
  fn normalizes_job_aliases_and_shares_the_same_exclusion_lock() {
    let lower = "abcdefab-cdef-4abc-8abc-abcdefabcdef";
    let upper = lower.to_ascii_uppercase();
    let (lower_key, lower_lock) = job_operation(lower).unwrap();
    let (upper_key, upper_lock) = job_operation(&upper).unwrap();
    assert_eq!(lower_key, upper_key);
    assert!(Arc::ptr_eq(&lower_lock, &upper_lock));
    let held = lower_lock.try_lock().unwrap();
    assert!(upper_lock.try_lock().is_err());
    drop(held);
  }

  #[test]
  fn rejects_invalid_chunk_offsets_sizes_and_finished_files() {
    assert!(valid_chunk_append(4, 4, 4, 8, false));
    assert!(!valid_chunk_append(4, 3, 4, 8, false));
    assert!(!valid_chunk_append(4, 4, 5, 8, false));
    assert!(!valid_chunk_append(0, 0, 0, 8, false));
    assert!(!valid_chunk_append(0, 0, 4, 8, true));
  }

  #[test]
  fn rejects_invalid_prepared_file_and_part_indexes() {
    let prepared = vec![PreparedFile {
      wav: PathBuf::from("synthetic.wav"),
      duration_sec: 10.0,
      bounds: vec![(0.0, 10.0)],
      sound_sec: vec![8.0],
    }];
    assert_eq!(prepared_part(&prepared, 0, 0).unwrap().1, (0.0, 10.0));
    assert!(prepared_part(&prepared, 1, 0).is_err());
    assert!(prepared_part(&prepared, 0, 1).is_err());
  }

  #[test]
  fn validates_checkpoint_job_generation_and_revision_order() {
    let job = "00000000-0000-4000-8000-000000000001";
    assert_eq!(
      checkpoint_version(
        &json!({ "runId": job, "generation": 2, "revision": 3, "previousRevision": 2 }),
        job
      )
      .unwrap(),
      (2, 3, 2)
    );
    assert!(checkpoint_version(
      &json!({ "runId": job, "generation": 0, "revision": 3, "previousRevision": 2 }),
      job
    )
    .is_err());
    assert!(checkpoint_version(
      &json!({ "runId": "00000000-0000-4000-8000-000000000002", "generation": 2, "revision": 3, "previousRevision": 2 }),
      job
    )
    .is_err());
    assert!(checkpoint_can_replace((2, 4, 3), (2, 3, 2)));
    assert!(checkpoint_can_replace((3, 4, 3), (2, 3, 2)));
    assert!(!checkpoint_can_replace((2, 4, 2), (2, 3, 2)));
    assert!(!checkpoint_can_replace((1, 4, 3), (2, 3, 2)));
  }
}
