//! 録音（#18590・specs/initiatives/niho-docs.md §6.2）。sidecar の `niho-speech record` を app data の `recordings/` へ起動し、
//! 行（started・level）を画面へ流す。止めるのは SIGTERM（sidecar が CAF を閉じて AAC に書き出し、done を出す）。同時に 1 本まで。
//!
//! ```text
//! recordings/<recordingId>.m4a              止めて書き出した録音
//! recordings/<recordingId>.recording.caf    録音中の CAF（落ちたときはこれが残る。書き出しに失敗したときは done がこれを返す）
//! recordings/.<recordingId>.partial-<pid>.m4a  書き出しの途中（終われば .m4a に置き換わる）
//! recordings/.<recordingId>.owner           録音している sidecar の pid（録音が終わると消える。ほかの NIHO docs が録音中のファイルを
//!                                           「前回の録音」として出したり捨てたりしないための印。pid が居なければ残骸）
//! ```
//!
//! 案件に写した録音は、画面が保存の後で `discard` で消す（写す前に消すと、保存に失敗したときに録音を失う）。
//! 案件に写していない録音（ダイアログを閉じた・アプリが落ちた）は `leftovers` が返し、画面が「前回の録音」として出す。

use crate::process::{child_command, read_tail, signal_group, SIGKILL, SIGTERM};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const RECORDINGS_DIR: &str = "recordings";
const WORKING_SUFFIX: &str = ".recording.caf";
const OWNER_SUFFIX: &str = ".owner";
/// 録音中の CAF の頭（sidecar の CAFWriter.headerBytes）と、1 秒の大きさ（24 kHz・mono・16-bit）。
const CAF_HEADER_BYTES: u64 = 68;
const CAF_BYTES_PER_SEC: f64 = 48_000.0;
/// 起動してから started（か失敗）までの上限。マイクの許可を初めて聞くときは、本人が答えるまで待つ。
const START_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// 止めてから done までの上限。書き出しは 1 時間で数秒（AAC・モノラル 24 kHz の実測は 750 倍速）なので十分に余る。
/// 超えたら SIGKILL し、残った CAF を録音として返す。
const STOP_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug, PartialEq)]
pub enum RecordingError {
  /// sidecar が見つからない。
  NotFound,
  /// ほかの録音が動いている（同時に 1 本まで）。
  Busy,
  /// 入力の装置が無い（`no_input_device`）。
  NoDevice,
  /// マイクの許可が無い・断られた（`microphone_permission_denied`）。
  Permission,
  /// 音が 1 つも届かなかった（`input_empty`）。
  Empty,
  /// その id の録音が無い。
  Missing,
  /// ほかの NIHO docs が録音している（その録音は捨てられない）。
  InUse,
  /// 録音のファイルを消せなかった（権限・ファイルシステムの障害）。
  DiscardFailed,
  Failed,
}

impl RecordingError {
  pub fn code(&self) -> &'static str {
    match self {
      RecordingError::NotFound => "recording_not_found",
      RecordingError::Busy => "recording_busy",
      RecordingError::NoDevice => "recording_no_device",
      RecordingError::Permission => "recording_permission",
      RecordingError::Empty => "recording_empty",
      RecordingError::Missing => "recording_missing",
      RecordingError::InUse => "recording_in_use",
      RecordingError::DiscardFailed => "recording_discard_failed",
      RecordingError::Failed => "recording_failed",
    }
  }

  pub fn message(&self) -> &'static str {
    match self {
      RecordingError::NotFound => crate::speech::SpeechError::NotFound.message(),
      RecordingError::Busy => "ほかの録音が動いています。止めてから、もう一度押してください。",
      RecordingError::NoDevice => "マイクが見つかりません。マイクをつないでから、もう一度押してください。",
      RecordingError::Permission => "マイクの使用が許可されていません。システム設定で NIHO editor を許可してください。",
      RecordingError::Empty => "音が届かず、録音できませんでした。マイクを確かめてから、もう一度押してください。",
      RecordingError::Missing => "録音が見つかりません。",
      RecordingError::InUse => "ほかの NIHO editor が録音しています。録音を止めてから、もう一度捨ててください。",
      RecordingError::DiscardFailed => {
        "録音のファイルを消せませんでした。ファイルの権限を確かめてから、もう一度捨ててください。"
      }
      RecordingError::Failed => "録音が途中で止まりました。もう一度押してください。",
    }
  }

  /// 終了コードと `{"type":"error","code":…}` の code から（sidecar の README の表）。
  fn from_exit(code: Option<i32>, error_code: Option<&str>) -> Self {
    match (code, error_code) {
      (Some(2), Some("no_input_device")) => RecordingError::NoDevice,
      (Some(4), _) => RecordingError::Permission,
      (Some(3), Some("input_empty")) => RecordingError::Empty,
      _ => RecordingError::Failed,
    }
  }
}

/// 録音のファイル（画面の `RecordedAudio`。name は「録音 10/16 15:30」）。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
  pub recording_id: String,
  pub path: String,
  pub name: String,
  pub duration_sec: Option<f64>,
}

#[derive(Default)]
struct RecState {
  /// started の行（device）か、started の前に終わった理由。
  started: Option<Result<Value, RecordingError>>,
  /// 終わった結果（録音のファイル・長さ）。
  ended: Option<Result<(PathBuf, f64), RecordingError>>,
  /// 画面が止めた（止めた・捨てた）か。自分で終わった（装置が無くなった・書けなくなった）ときだけ画面へ Done を流す。
  stop_requested: bool,
}

struct ActiveRecording {
  id: String,
  pid: u32,
  state: Mutex<RecState>,
  changed: Condvar,
}

impl ActiveRecording {
  fn running(&self) -> bool {
    self.state.lock().map(|state| state.ended.is_none()).unwrap_or(false)
  }

  /// `until` が満たされるまで待つ（上限つき）。満たされたら true。
  fn wait(&self, timeout: Duration, until: impl Fn(&RecState) -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    let Ok(mut state) = self.state.lock() else { return false };
    while !until(&state) {
      let now = Instant::now();
      if now >= deadline {
        return false;
      }
      state = match self.changed.wait_timeout(state, deadline - now) {
        Ok((state, _)) => state,
        Err(_) => return false,
      };
    }
    true
  }

  fn signal(&self, signal: i32) {
    if self.running() {
      signal_group(self.pid, signal);
    }
  }
}

/// 録音の受け持ち（AppState に 1 つ）。
pub struct Recorder {
  dir: PathBuf,
  active: Mutex<Option<Arc<ActiveRecording>>>,
}

impl Recorder {
  pub fn new(dir: PathBuf) -> Self {
    Self {
      dir,
      active: Mutex::new(None),
    }
  }

  fn output_path(&self, id: &str) -> PathBuf {
    self.dir.join(format!("{id}.m4a"))
  }

  fn working_path(&self, id: &str) -> PathBuf {
    self.dir.join(format!("{id}{WORKING_SUFFIX}"))
  }

  /// 書き出し済みの録音（`recordings/<id>.m4a`）。無い・まだ録音中なら None。殻（shell.rs）が id だけで音声を読むために使う。
  pub fn exported_file(&self, id: &str) -> Option<PathBuf> {
    if crate::store::validate_id(id).is_err() || self.in_use(id) || self.current(id).is_some() {
      return None;
    }
    let path = self.output_path(id);
    path.is_file().then_some(path)
  }

  fn owner_path(&self, id: &str) -> PathBuf {
    self.dir.join(format!(".{id}{OWNER_SUFFIX}"))
  }

  /// その id をいま録音している process（sidecar）が居るか。この process の録音も、ほかの NIHO docs の録音も含む
  /// （`.owner` の pid が生きていれば使用中。落ちた録音の pid は居ないので「前回の録音」として出せる）。
  fn in_use(&self, id: &str) -> bool {
    fs::read_to_string(self.owner_path(id))
      .ok()
      .and_then(|text| text.trim().parse::<u32>().ok())
      .is_some_and(crate::store::pid_alive)
  }

  fn current(&self, id: &str) -> Option<Arc<ActiveRecording>> {
    self
      .active
      .lock()
      .ok()
      .and_then(|active| active.as_ref().filter(|recording| recording.id == id).cloned())
  }

  /// 録音中か（窓を閉じる前の確かめ・更新して再起動の busy）。
  pub fn is_recording(&self) -> bool {
    self
      .active
      .lock()
      .ok()
      .and_then(|active| active.as_ref().map(|recording| recording.running()))
      .unwrap_or(false)
  }

  /// 録音を始める。started の行が来たら `{"device": …}` を返す（それまで待つ。初めてならマイクの許可を聞いている間も）。
  /// 行は `on_event` へ: `Started`（装置が変わったときも）・`Level`、画面が止めずに終わったら `Done`（`audio`）か `Error`。
  pub fn start(
    &self,
    binary: &Path,
    id: &str,
    on_event: impl FnMut(Value) + Send + 'static,
  ) -> Result<Value, RecordingError> {
    crate::store::validate_id(id).map_err(|_| RecordingError::Failed)?;
    let mut active = self.active.lock().map_err(|_| RecordingError::Failed)?;
    if active.as_ref().is_some_and(|recording| recording.running()) {
      return Err(RecordingError::Busy);
    }
    fs::create_dir_all(&self.dir).map_err(|_| RecordingError::Failed)?;
    let output = self.output_path(id);
    if output.exists() || self.working_path(id).exists() {
      return Err(RecordingError::Failed);
    }
    let args = vec![
      "record".to_string(),
      "--output".to_string(),
      output.to_string_lossy().into_owned(),
    ];
    let mut child = child_command(binary, &args, None)
      .spawn()
      .map_err(|_| RecordingError::NotFound)?;
    drop(child.stdin.take());
    // 録音している間の持ち主の印（ほかの NIHO docs が録音中のファイルに触らないように。書けなくても録音は続ける）
    let owner = self.owner_path(id);
    let _ = fs::write(&owner, child.id().to_string());
    let recording = Arc::new(ActiveRecording {
      id: id.to_string(),
      pid: child.id(),
      state: Mutex::new(RecState::default()),
      changed: Condvar::new(),
    });
    *active = Some(recording.clone());
    drop(active);

    let dir = self.dir.clone();
    let working = self.working_path(id);
    let reader = recording.clone();
    let mut on_event = on_event;
    thread::spawn(move || {
      let stderr = child.stderr.take();
      let stderr_handle = thread::spawn(move || stderr.map(|pipe| read_tail(pipe, 16 * 1024)).unwrap_or_default());
      let mut done: Option<(PathBuf, f64)> = None;
      let mut error_code: Option<String> = None;
      if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines() {
          let Ok(line) = line else { break };
          let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
          };
          match value.get("type").and_then(Value::as_str) {
            Some("started") => {
              let device = value.get("device").cloned().unwrap_or(Value::Null);
              if let Ok(mut state) = reader.state.lock() {
                if state.started.is_none() {
                  state.started = Some(Ok(json!({ "device": device })));
                  reader.changed.notify_all();
                }
              }
              on_event(json!({ "type": "Started", "device": device }));
            }
            Some("level") => on_event(json!({
              "type": "Level",
              "db": value.get("db").cloned().unwrap_or(Value::Null),
              "durationSec": value.get("durationSec").cloned().unwrap_or(Value::Null),
            })),
            Some("done") => {
              let file = value.get("file").and_then(Value::as_str).map(PathBuf::from);
              let duration = value.get("durationSec").and_then(Value::as_f64).unwrap_or(0.0);
              // sidecar に渡した場所（recordings/）のファイルだけを受け取る
              done = file
                .filter(|file| file.parent() == Some(dir.as_path()) && file.is_file())
                .map(|file| (file, duration));
            }
            Some("error") => {
              error_code = value.get("code").and_then(Value::as_str).map(str::to_string);
            }
            _ => {}
          }
        }
      }
      let code = child.wait().ok().and_then(|status| status.code());
      let _ = fs::remove_file(&owner);
      let _ = stderr_handle.join();
      // done が無くても、CAF に音が残っていれば録音として返す（SIGKILL・書き出しの前に落ちたとき）
      let result = match done {
        Some(done) => Ok(done),
        None => working_duration(&working)
          .map(|duration| (working.clone(), duration))
          .ok_or_else(|| RecordingError::from_exit(code, error_code.as_deref())),
      };
      let stop_requested = match reader.state.lock() {
        Ok(mut state) => {
          if state.started.is_none() {
            state.started = Some(Err(result.clone().err().unwrap_or(RecordingError::Failed)));
          }
          state.ended = Some(result.clone());
          reader.changed.notify_all();
          state.stop_requested
        }
        Err(_) => true,
      };
      if !stop_requested {
        on_event(match result {
          Ok((path, duration)) => json!({ "type": "Done", "audio": info(&reader.id, &path, Some(duration)) }),
          Err(error) => json!({ "type": "Error", "code": error.code(), "message": error.message() }),
        });
      }
    });

    if !recording.wait(START_TIMEOUT, |state| state.started.is_some()) {
      recording.signal(SIGKILL);
      recording.wait(Duration::from_secs(5), |state| state.ended.is_some());
      return Err(RecordingError::Failed);
    }
    let started = recording
      .state
      .lock()
      .ok()
      .and_then(|state| state.started.clone())
      .unwrap_or(Err(RecordingError::Failed));
    if started.is_err() {
      // started の前に終わった（装置が無い・許可が無い）。次の録音を止めないよう外す
      self.forget(&recording);
    }
    started
  }

  /// 止めて（SIGTERM）書き出しを待ち、録音のファイルを返す。自分で終わっていた録音もここで受け取れる。
  pub fn stop(&self, id: &str) -> Result<RecordingInfo, RecordingError> {
    let Some(recording) = self.current(id) else {
      return Err(RecordingError::Missing);
    };
    if let Ok(mut state) = recording.state.lock() {
      state.stop_requested = true;
    }
    recording.signal(SIGTERM);
    if !recording.wait(STOP_TIMEOUT, |state| state.ended.is_some()) {
      recording.signal(SIGKILL);
      recording.wait(Duration::from_secs(10), |state| state.ended.is_some());
    }
    let ended = recording.state.lock().ok().and_then(|state| state.ended.clone());
    self.forget(&recording);
    match ended {
      Some(Ok((path, duration))) => Ok(info(id, &path, Some(duration))),
      Some(Err(error)) => Err(error),
      None => working_duration(&self.working_path(id))
        .map(|duration| info(id, &self.working_path(id), Some(duration)))
        .ok_or(RecordingError::Failed),
    }
  }

  /// 録音を捨てる（録音中なら止めてから）。`recordings/` のその id のファイルをすべて消す。
  pub fn discard(&self, id: &str) -> Result<(), RecordingError> {
    crate::store::validate_id(id).map_err(|_| RecordingError::Missing)?;
    if let Some(recording) = self.current(id) {
      if let Ok(mut state) = recording.state.lock() {
        state.stop_requested = true;
      }
      // 書き出しは要らないので待たずに止める
      recording.signal(SIGKILL);
      recording.wait(Duration::from_secs(10), |state| state.ended.is_some());
      self.forget(&recording);
    }
    // ほかの NIHO docs が録音している間は捨てない（録音側が書き出しもフォールバックもできず、それまでの音声を失う）
    if self.in_use(id) {
      return Err(RecordingError::InUse);
    }
    let entries = match fs::read_dir(&self.dir) {
      Ok(entries) => entries,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
      Err(_) => return Err(RecordingError::DiscardFailed),
    };
    let partial = format!(".{id}.partial-");
    let mut failed = false;
    for entry in entries.flatten() {
      let name = entry.file_name().to_string_lossy().into_owned();
      if name == format!("{id}.m4a") || name == format!("{id}{WORKING_SUFFIX}") || name.starts_with(&partial) {
        // 消せなかったものを成功として返さない（画面が行を消すと、音声がディスクに残ったまま次に「前回の録音」として戻る）
        if let Err(error) = fs::remove_file(entry.path()) {
          if error.kind() != std::io::ErrorKind::NotFound {
            failed = true;
          }
        }
      }
    }
    let _ = fs::remove_file(self.owner_path(id));
    if failed {
      return Err(RecordingError::DiscardFailed);
    }
    Ok(())
  }

  /// 案件に写していない録音（古い順）。書き出した .m4a があればそれ、無ければ CAF。録音中のもの（ほかの NIHO docs が録音しているものも）は入れない。
  /// 音の無いもの（長さ 0）と、動いていない書き出しの途中のファイルは消す。
  pub fn leftovers(&self) -> Vec<RecordingInfo> {
    let running = self.active.lock().ok().and_then(|active| {
      active
        .as_ref()
        .filter(|recording| recording.running())
        .map(|recording| recording.id.clone())
    });
    let Ok(entries) = fs::read_dir(&self.dir) else {
      return vec![];
    };
    let mut ids: Vec<String> = Vec::new();
    for entry in entries.flatten() {
      let name = entry.file_name().to_string_lossy().into_owned();
      if let Some(rest) = name.strip_prefix('.') {
        // 書き出しの途中（.<id>.partial-<pid>.m4a）。動いている録音（ほかの NIHO docs の録音も）のもの以外は残骸
        let owner = rest.split(".partial-").next().unwrap_or("");
        if name.contains(".partial-") && running.as_deref() != Some(owner) && !self.in_use(owner) {
          let _ = fs::remove_file(entry.path());
        }
        // 持ち主の居ない印（落ちた録音の残り）
        if let Some(id) = rest.strip_suffix(OWNER_SUFFIX) {
          if !self.in_use(id) {
            let _ = fs::remove_file(entry.path());
          }
        }
        continue;
      }
      let id = name
        .strip_suffix(WORKING_SUFFIX)
        .or_else(|| name.strip_suffix(".m4a"))
        .filter(|id| crate::store::validate_id(id).is_ok());
      if let Some(id) = id {
        if running.as_deref() != Some(id) && !self.in_use(id) && !ids.iter().any(|known| known == id) {
          ids.push(id.to_string());
        }
      }
    }
    let mut found: Vec<(SystemTime, RecordingInfo)> = Vec::new();
    for id in ids {
      let output = self.output_path(&id);
      let working = self.working_path(&id);
      let (path, duration) = if output.is_file() {
        (output.clone(), crate::speech::audio_duration_sec(&output))
      } else {
        let duration = crate::speech::audio_duration_sec(&working).or_else(|| working_duration(&working));
        (working.clone(), duration)
      };
      if !duration.is_some_and(|sec| sec.is_finite() && sec > 0.0) {
        // 音の無い録音（始めてすぐ落ちた）は残しても足せない
        let _ = fs::remove_file(&output);
        let _ = fs::remove_file(&working);
        continue;
      }
      let modified = fs::metadata(&path)
        .and_then(|meta| meta.modified())
        .unwrap_or(UNIX_EPOCH);
      found.push((modified, info(&id, &path, duration)));
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found.into_iter().map(|(_, info)| info).collect()
  }

  /// アプリを終えるとき: 録音中なら止めて書き出しを `timeout` まで待つ（待ち切れなくても sidecar は書き出しを続け、
  /// 次に開いたときに「前回の録音」になる）。
  pub fn stop_for_exit(&self, timeout: Duration) {
    let recording = self.active.lock().ok().and_then(|active| active.clone());
    if let Some(recording) = recording.filter(|recording| recording.running()) {
      if let Ok(mut state) = recording.state.lock() {
        state.stop_requested = true;
      }
      recording.signal(SIGTERM);
      recording.wait(timeout, |state| state.ended.is_some());
    }
  }

  fn forget(&self, recording: &Arc<ActiveRecording>) {
    if let Ok(mut active) = self.active.lock() {
      if active.as_ref().is_some_and(|current| Arc::ptr_eq(current, recording)) {
        *active = None;
      }
    }
  }
}

/// 録音中の CAF の長さ（データの大きさから。音が無ければ None）。
fn working_duration(path: &Path) -> Option<f64> {
  let len = fs::metadata(path).ok()?.len();
  let seconds = len.checked_sub(CAF_HEADER_BYTES)? as f64 / CAF_BYTES_PER_SEC;
  (seconds > 0.0).then_some(seconds)
}

fn info(id: &str, path: &Path, duration_sec: Option<f64>) -> RecordingInfo {
  RecordingInfo {
    recording_id: id.to_string(),
    path: path.to_string_lossy().into_owned(),
    name: recording_name(path, duration_sec),
    duration_sec,
  }
}

/// 「録音 10/16 15:30」（録り始めた時刻＝ファイルを最後に書いた時刻 − 長さ。この Mac の時刻帯）。
pub fn recording_name(path: &Path, duration_sec: Option<f64>) -> String {
  let modified = fs::metadata(path)
    .and_then(|meta| meta.modified())
    .unwrap_or_else(|_| SystemTime::now());
  let back = Duration::from_secs_f64(duration_sec.filter(|sec| sec.is_finite() && *sec > 0.0).unwrap_or(0.0));
  let started = modified.checked_sub(back).unwrap_or(modified);
  let secs = started
    .duration_since(UNIX_EPOCH)
    .map(|elapsed| elapsed.as_secs())
    .unwrap_or(0);
  match local_time(secs as i64) {
    Some((month, day, hour, minute)) => format_name(month, day, hour, minute),
    None => "録音".to_string(),
  }
}

pub(crate) fn format_name(month: i32, day: i32, hour: i32, minute: i32) -> String {
  format!("録音 {month}/{day} {hour:02}:{minute:02}")
}

/// この Mac の時刻帯の 月・日・時・分。
fn local_time(epoch_secs: i64) -> Option<(i32, i32, i32, i32)> {
  #[cfg(unix)]
  {
    let time = epoch_secs as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let result = unsafe { libc::localtime_r(&time, &mut tm) };
    if result.is_null() {
      return None;
    }
    Some((tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min))
  }
  #[cfg(not(unix))]
  {
    let _ = epoch_secs;
    None
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::mpsc;

  fn fake_binary() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../sidecar/fake/niho-speech")
  }

  fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
      "niho-docs-recording-test-{name}-{}-{}",
      std::process::id(),
      crate::process::hex(&crate::process::random_bytes::<4>().unwrap())
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
  }

  fn script(dir: &Path, body: &str) -> PathBuf {
    let path = dir.join("niho-speech");
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
  }

  /// 録音中の CAF の頭（sidecar と同じ 68 バイト）＋ `seconds` 秒の無音。
  fn caf(seconds: f64) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"caff\x00\x01\x00\x00desc");
    bytes.extend_from_slice(&32u64.to_be_bytes());
    bytes.extend_from_slice(&24_000f64.to_bits().to_be_bytes());
    bytes.extend_from_slice(b"lpcm");
    for value in [2u32, 2, 1, 1, 16] {
      bytes.extend_from_slice(&value.to_be_bytes());
    }
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&u64::MAX.to_be_bytes());
    bytes.extend_from_slice(&0u32.to_be_bytes());
    assert_eq!(bytes.len() as u64, CAF_HEADER_BYTES);
    bytes.resize(bytes.len() + (seconds * CAF_BYTES_PER_SEC) as usize, 0);
    bytes
  }

  #[test]
  fn the_fake_records_until_stopped_and_returns_the_m4a() {
    let dir = temp_dir("fake");
    let recorder = Recorder::new(dir.join(RECORDINGS_DIR));
    let (send, events) = mpsc::channel();
    let started = recorder
      .start(&fake_binary(), "rec-1", move |event| {
        let _ = send.send(event);
      })
      .unwrap();
    assert_eq!(started, json!({ "device": "偽のマイク" }));
    assert!(recorder.is_recording());
    // 同時に 1 本まで
    assert_eq!(
      recorder.start(&fake_binary(), "rec-2", |_| {}),
      Err(RecordingError::Busy)
    );
    // 音量の行が届く
    let level = (0..50)
      .filter_map(|_| events.recv_timeout(Duration::from_secs(2)).ok())
      .find(|event| event["type"] == "Level")
      .expect("no level line");
    assert!(level["db"].as_f64().unwrap() < 0.0);
    let info = recorder.stop("rec-1").unwrap();
    assert!(!recorder.is_recording());
    assert_eq!(info.recording_id, "rec-1");
    assert_eq!(Path::new(&info.path), dir.join("recordings/rec-1.m4a"));
    assert_eq!(info.duration_sec, Some(13.35));
    assert!(info.name.starts_with("録音 "), "{}", info.name);
    // 止めたのは画面なので Done は流さない
    assert!(events.try_iter().all(|event| event["type"] != "Done"));
    // CAF は消え、m4a が残る（案件に写すまで「前回の録音」）
    assert!(!dir.join("recordings/rec-1.recording.caf").exists());
    let leftovers = recorder.leftovers();
    assert_eq!(leftovers.len(), 1);
    assert_eq!(leftovers[0].recording_id, "rec-1");
    assert_eq!(leftovers[0].path, info.path);
    recorder.discard("rec-1").unwrap();
    assert!(recorder.leftovers().is_empty());
    assert!(!dir.join("recordings/rec-1.m4a").exists());
    // 終わった録音はもう止められない
    assert_eq!(recorder.stop("rec-1"), Err(RecordingError::Missing));
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn no_device_and_no_permission_fail_before_started() {
    let dir = temp_dir("errors");
    let recorder = Recorder::new(dir.join(RECORDINGS_DIR));
    for (line, code, expected) in [
      (
        r#"{"type":"error","code":"no_input_device","message":"no input device"}"#,
        2,
        RecordingError::NoDevice,
      ),
      (
        r#"{"type":"error","code":"microphone_permission_denied","message":"denied"}"#,
        4,
        RecordingError::Permission,
      ),
      (
        r#"{"type":"error","code":"internal_error","message":"x"}"#,
        1,
        RecordingError::Failed,
      ),
    ] {
      let binary = script(&dir, &format!("printf '%s\\n' '{line}'\nexit {code}"));
      assert_eq!(recorder.start(&binary, "rec-1", |_| {}), Err(expected));
      // 次の録音を止めない
      assert!(!recorder.is_recording());
    }
    assert_eq!(
      recorder.start(&dir.join("missing"), "rec-1", |_| {}),
      Err(RecordingError::NotFound)
    );
    assert_eq!(
      recorder.start(&fake_binary(), "../x", |_| {}),
      Err(RecordingError::Failed)
    );
    assert_eq!(RecordingError::NoDevice.code(), "recording_no_device");
    assert!(RecordingError::NoDevice.message().contains("マイクが見つかりません"));
    assert!(RecordingError::Permission.message().contains("システム設定"));
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn a_recording_that_ends_by_itself_is_sent_to_the_window() {
    // 装置が無くなった・書けなくなった: sidecar が自分で done を出して終わる。画面へ Done（audio）を流す
    let dir = temp_dir("ended");
    let recordings = dir.join(RECORDINGS_DIR);
    let recorder = Recorder::new(recordings.clone());
    let binary = script(
      &dir,
      r#"out="$3"
printf '%s\n' '{"type":"started","device":"USB マイク","sampleRate":24000}'
sleep 0.3
printf 'x' > "$out"
printf '{"type":"done","file":"%s","durationSec":0.3,"bytes":1}\n' "$out""#,
    );
    let (send, events) = mpsc::channel();
    recorder
      .start(&binary, "rec-1", move |event| {
        let _ = send.send(event);
      })
      .unwrap();
    let done = (0..10)
      .filter_map(|_| events.recv_timeout(Duration::from_secs(3)).ok())
      .find(|event| event["type"] == "Done")
      .expect("no Done");
    assert_eq!(done["audio"]["recordingId"], "rec-1");
    assert_eq!(done["audio"]["durationSec"], 0.3);
    assert!(!recorder.is_recording());
    // 画面が後から止めても同じ録音を受け取れる
    assert_eq!(
      recorder.stop("rec-1").unwrap().path,
      recordings.join("rec-1.m4a").to_string_lossy()
    );
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn a_killed_recording_returns_its_caf() {
    // done を出さずに落ちた（SIGKILL・書き出しの前）: 録音中の CAF に音があれば、それを録音として返す
    let dir = temp_dir("killed");
    let recordings = dir.join(RECORDINGS_DIR);
    fs::create_dir_all(&recordings).unwrap();
    let recorder = Recorder::new(recordings.clone());
    let wav_bytes = caf(1.5);
    let source = dir.join("audio.bin");
    fs::write(&source, &wav_bytes).unwrap();
    let binary = script(
      &dir,
      &format!(
        r#"cp '{}' "${{3%.m4a}}.recording.caf"
printf '%s\n' '{{"type":"started","device":null,"sampleRate":24000}}'
trap 'exit 9' TERM
while :; do sleep 0.1; done"#,
        source.display()
      ),
    );
    assert_eq!(
      recorder.start(&binary, "rec-1", |_| {}).unwrap(),
      json!({ "device": null })
    );
    let info = recorder.stop("rec-1").unwrap();
    assert_eq!(Path::new(&info.path), recordings.join("rec-1.recording.caf"));
    assert_eq!(info.duration_sec, Some(1.5));
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn leftovers_prefer_the_m4a_and_skip_empty_and_partial_files() {
    let dir = temp_dir("leftovers");
    let recordings = dir.join(RECORDINGS_DIR);
    fs::create_dir_all(&recordings).unwrap();
    // 落ちた録音（CAF だけ・afinfo が長さを読む）
    fs::write(recordings.join("rec-a.recording.caf"), caf(2.0)).unwrap();
    // 書き出した後に CAF を消す前で落ちた（m4a を使う）
    fs::copy(
      Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/audio/synthetic-tone.m4a"),
      recordings.join("rec-b.m4a"),
    )
    .unwrap();
    fs::write(recordings.join("rec-b.recording.caf"), caf(1.0)).unwrap();
    // 音の無い CAF・書き出しの途中・関係の無いファイル
    fs::write(recordings.join("rec-c.recording.caf"), caf(0.0)).unwrap();
    fs::write(recordings.join(".rec-d.partial-123.m4a"), b"x").unwrap();
    fs::write(recordings.join("memo.txt"), b"x").unwrap();
    let recorder = Recorder::new(recordings.clone());
    let leftovers = recorder.leftovers();
    let ids: Vec<&str> = leftovers.iter().map(|info| info.recording_id.as_str()).collect();
    assert_eq!(ids.len(), 2, "{leftovers:?}");
    assert!(ids.contains(&"rec-a") && ids.contains(&"rec-b"));
    let a = leftovers.iter().find(|info| info.recording_id == "rec-a").unwrap();
    assert!((a.duration_sec.unwrap() - 2.0).abs() < 0.01, "{a:?}");
    let b = leftovers.iter().find(|info| info.recording_id == "rec-b").unwrap();
    assert!(b.path.ends_with("rec-b.m4a"));
    assert!((b.duration_sec.unwrap() - 13.35).abs() < 0.1, "{b:?}");
    assert!(!recordings.join("rec-c.recording.caf").exists());
    assert!(!recordings.join(".rec-d.partial-123.m4a").exists());
    assert!(recordings.join("memo.txt").exists());
    // 捨てると m4a と CAF の両方が消える
    recorder.discard("rec-b").unwrap();
    assert!(!recordings.join("rec-b.m4a").exists() && !recordings.join("rec-b.recording.caf").exists());
    assert!(recorder.discard("../x").is_err());
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn a_recording_in_another_process_is_not_a_leftover_and_is_not_discarded() {
    let dir = temp_dir("other-process");
    let recordings = dir.join(RECORDINGS_DIR);
    fs::create_dir_all(&recordings).unwrap();
    fs::write(recordings.join("rec-live.recording.caf"), caf(2.0)).unwrap();
    fs::write(recordings.join(".rec-live.partial-1.m4a"), b"x").unwrap();
    fs::write(recordings.join("rec-dead.recording.caf"), caf(2.0)).unwrap();
    // ほかの NIHO docs の sidecar の代わり（生きている別の process）が rec-live を録音している
    let mut other = std::process::Command::new("sleep").arg("30").spawn().unwrap();
    fs::write(recordings.join(".rec-live.owner"), other.id().to_string()).unwrap();
    // 落ちた録音の印（pid はもう居ない）
    let mut finished = std::process::Command::new("true").spawn().unwrap();
    finished.wait().unwrap();
    fs::write(recordings.join(".rec-dead.owner"), finished.id().to_string()).unwrap();
    let recorder = Recorder::new(recordings.clone());

    let ids: Vec<String> = recorder.leftovers().into_iter().map(|info| info.recording_id).collect();
    assert_eq!(ids, vec!["rec-dead"]);
    // 録音中のファイルも書き出しの途中も消さず、落ちた録音の古い印だけ消える
    assert!(recordings.join("rec-live.recording.caf").exists());
    assert!(recordings.join(".rec-live.partial-1.m4a").exists());
    assert!(recordings.join(".rec-live.owner").exists());
    assert!(!recordings.join(".rec-dead.owner").exists());
    // 捨てられない
    assert_eq!(recorder.discard("rec-live"), Err(RecordingError::InUse));
    assert!(recordings.join("rec-live.recording.caf").exists());

    // 録音が終われば（pid が居なくなれば）前回の録音として出て、捨てられる
    other.kill().unwrap();
    other.wait().unwrap();
    let mut ids: Vec<String> = recorder.leftovers().into_iter().map(|info| info.recording_id).collect();
    ids.sort();
    assert_eq!(ids, vec!["rec-dead", "rec-live"]);
    recorder.discard("rec-live").unwrap();
    assert!(!recordings.join("rec-live.recording.caf").exists());
    assert!(!recordings.join(".rec-live.owner").exists());
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn the_owner_mark_follows_a_recording_and_is_gone_when_it_ends() {
    let dir = temp_dir("owner-mark");
    let recordings = dir.join(RECORDINGS_DIR);
    let recorder = Recorder::new(recordings.clone());
    recorder.start(&fake_binary(), "rec-own", |_| {}).unwrap();
    assert!(recorder.in_use("rec-own"));
    assert!(recordings.join(".rec-own.owner").exists());
    // 録音している間は、この process でも捨てる前に止められる（discard は止めてから消す）
    recorder.discard("rec-own").unwrap();
    assert!(!recorder.in_use("rec-own"));
    assert!(!recordings.join(".rec-own.owner").exists());
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn a_file_that_cannot_be_removed_is_not_reported_as_discarded() {
    let dir = temp_dir("discard-failure");
    let recordings = dir.join(RECORDINGS_DIR);
    fs::create_dir_all(&recordings).unwrap();
    // 消せないファイルの代わり（remove_file で消せないフォルダ）
    fs::create_dir_all(recordings.join("rec-x.m4a")).unwrap();
    fs::write(recordings.join("rec-x.recording.caf"), caf(1.0)).unwrap();
    let recorder = Recorder::new(recordings.clone());
    assert_eq!(recorder.discard("rec-x"), Err(RecordingError::DiscardFailed));
    // 消せたものは消え、消せなかったものは残る（次の「前回の録音」にも出うる）
    assert!(!recordings.join("rec-x.recording.caf").exists());
    assert!(recordings.join("rec-x.m4a").exists());
    // 何もない id は成功（もう消えている）
    assert_eq!(recorder.discard("rec-none"), Ok(()));
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn names_read_like_the_list() {
    assert_eq!(format_name(10, 16, 15, 30), "録音 10/16 15:30");
    assert_eq!(format_name(1, 2, 3, 4), "録音 1/2 03:04");
    let info = serde_json::to_value(RecordingInfo {
      recording_id: "rec-1".into(),
      path: "/d/recordings/rec-1.m4a".into(),
      name: "録音 10/16 15:30".into(),
      duration_sec: Some(12.5),
    })
    .unwrap();
    assert_eq!(
      info,
      json!({ "recordingId": "rec-1", "path": "/d/recordings/rec-1.m4a", "name": "録音 10/16 15:30", "durationSec": 12.5 })
    );
  }
}
