//! この Mac の文字起こし sidecar `niho-speech`（specs/initiatives/niho-docs.md §6.2・#18403・apps/docs/sidecar/niho-speech）の呼び出し。
//!
//! 音声ごとに `convert`（16 kHz・mono の WAV）→ 話者を分けるときだけ全体を `diarize` で一度だけ global clustering →
//! `silence`（目標 15 分・前後 60 秒の窓・最短 60 秒）→ 区切りごとに同じ `--speaker-map` を渡した `transcribe` を順に呼ぶ。
//! Markdown への整形は packages/docs-core の transcriptMarkdown。
//!
//! sidecar の場所: 同梱（.app の中。`npm run build:app` が `npm run sidecar:build` の出力を externalBin で入れる）→
//! 手元のビルド（`sidecar/niho-speech/.build/release/niho-speech`）→ 開発ビルドだけ偽物（`sidecar/fake/niho-speech`・固定の JSONL）。
//! 偽物で代わりに動くときは、設定の音声認識の行に「`npm run sidecar:build`」の案内を出す。
//! `--hints` は `term` だけを渡す（本物は reading・variants を使わず、macOS 27.0 の実測では term も効かない。契約として渡し続ける）。
//!
//! Gemini（サブスクリプション＝Antigravity CLI）の文字起こし（S2a #18383）は、`prepare_audio` で音声ごとに `convert` →
//! `silence` までを行って区切りの境目を返し、区切りごとに `slice_part` で WAV を書き出して agy に読ませる（lib.rs の
//! `transcribe_audio_part`）。指示文と結合は画面側（docs-core の audio-transcription.ts）。

use crate::process::{child_command, executable_from_env, read_tail, signal_group, PrivateTempDir, SIGKILL, SIGTERM};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

/// 開発・テストで `niho-speech` を差し替える環境変数（`npm run dev:fake` が偽物を渡す）。
pub const SPEECH_PATH_ENV: &str = "NIHO_DOCS_SPEECH_PATH";
/// 本物が見つからず、偽物で代わりに動いているときの案内（開発ビルドだけ）。
pub const STAND_IN_NOTICE: &str =
  "文字起こしの部品が見つかりません。`npm run sidecar:build` で作ってください（今は偽物の固定の文で動いています）。";
/// この Mac の区切りは15分、Gemini は10分。窓・最短は共通。
const SILENCE_TARGET_SEC: &str = "900";
/// Gemini は長い区切りでの出力省略を抑えるため、既存の Flash 15 分より短くする。
pub const GEMINI_SILENCE_TARGET_SEC: &str = "600";
const SILENCE_WINDOW_SEC: &str = "60";
const SILENCE_MIN_SEC: &str = "60";
const KILL_GRACE: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, PartialEq)]
pub struct SpeechBinary {
  pub path: PathBuf,
  /// 固定の JSONL を返す偽物か。
  pub fake: bool,
  /// 本物が見つからず、偽物で代わりに動いているか（開発ビルドだけ。`npm run dev:fake` で選んだ偽物は含めない）。
  pub stand_in: bool,
}

/// sidecar の場所。環境変数の差し替え（開発・テスト）があればそれ。無ければ
/// 同梱（Tauri の externalBin は実行ファイルと同じフォルダ、.app の Contents/MacOS/niho-speech に入る）→
/// 手元のビルド（`npm run sidecar:build` の swift build の出力）→ 開発ビルドだけ偽物。
pub fn resolve_speech_binary() -> Option<SpeechBinary> {
  if let Some(path) = executable_from_env(SPEECH_PATH_ENV) {
    let fake = path.to_string_lossy().contains("/sidecar/fake/");
    return Some(SpeechBinary {
      path,
      fake,
      stand_in: false,
    });
  }
  let bundled = std::env::current_exe()
    .ok()
    .and_then(|exe| exe.parent().map(|dir| dir.join("niho-speech")));
  let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
  let built = manifest.join("../sidecar/niho-speech/.build/release/niho-speech");
  let fake = cfg!(debug_assertions).then(|| manifest.join("../sidecar/fake/niho-speech"));
  resolve_from(bundled, built, fake)
}

pub(crate) fn resolve_from(bundled: Option<PathBuf>, built: PathBuf, fake: Option<PathBuf>) -> Option<SpeechBinary> {
  for path in bundled.into_iter().chain([built]) {
    if crate::process::is_executable(&path) {
      return Some(SpeechBinary {
        path,
        fake: false,
        stand_in: false,
      });
    }
  }
  fake
    .filter(|path| crate::process::is_executable(path))
    .map(|path| SpeechBinary {
      path,
      fake: true,
      stand_in: true,
    })
}

/// niho-speech の最低の macOS（Package.swift の `platforms`）。それより前の macOS では起動できず、この Mac の文字起こし・録音・
/// Gemini に送る音声の準備が使えない（Deepgram は sidecar を使わない。#18753）。
pub const SIDECAR_MIN_MACOS: u32 = 26;
/// 起動できない macOS での speech_status の文（設定の音声認識の行に出る）。
pub const OS_UNSUPPORTED_MESSAGE: &str = "この macOS では音声を処理できません。macOS 26 以降で使えます。";

/// この Mac の macOS で niho-speech を起動できるか（版を読めなければ起動できるとみなし、実行の失敗に任せる）。版は OS 付属の
/// `sw_vers` で読む（sysctl などは、古い SDK で作ったプロセスに互換の版を返すことがある）。動いている間は変わらないので 1 回だけ読む。
pub fn sidecar_runs_on_this_macos() -> bool {
  static RUNS: OnceLock<bool> = OnceLock::new();
  *RUNS.get_or_init(|| {
    std::process::Command::new("/usr/bin/sw_vers")
      .arg("-productVersion")
      .output()
      .ok()
      .filter(|output| output.status.success())
      .and_then(|output| macos_major(&String::from_utf8_lossy(&output.stdout)))
      .is_none_or(|major| major >= SIDECAR_MIN_MACOS)
  })
}

/// `sw_vers -productVersion` の出力（`26.0.1`）のメジャー版。
fn macos_major(version: &str) -> Option<u32> {
  version.trim().split('.').next()?.parse().ok()
}

/// 語彙ヒントの hints.json（`[{"term": "…"}]`）。sidecar は reading・variants を認識に使わないので `term` だけを渡す。
pub fn hints_json(hints: &Value) -> String {
  let terms: Vec<Value> = hints
    .as_array()
    .into_iter()
    .flatten()
    .filter_map(|entry| entry.get("term").and_then(Value::as_str))
    .map(str::trim)
    .filter(|term| !term.is_empty())
    .map(|term| json!({ "term": term }))
    .collect();
  Value::Array(terms).to_string()
}

#[derive(Clone, Debug, PartialEq)]
pub enum SpeechError {
  Stopped,
  NotFound,
  ModelMissing,
  /// この Mac では SpeechTranscriber が使えない（終了コード 2 の `engine_unavailable`）。
  Unavailable,
  BadInput,
  /// 1 ファイル 2 GB・長さ 6 時間の上限を超えた（終了コード 3 の `input_too_large`）。
  TooLarge,
  /// 録音の音声の合計が 6 時間を超えた（`convert` が確かめた長さで数える。取り込みで長さが分からなかった音声の分も）。
  TooLong,
  Permission,
  Failed,
}

impl SpeechError {
  pub fn code(&self) -> &'static str {
    match self {
      SpeechError::Stopped => "speech_stopped",
      SpeechError::NotFound => "speech_not_found",
      SpeechError::ModelMissing => "speech_model_missing",
      SpeechError::Unavailable => "speech_unavailable",
      SpeechError::BadInput => "speech_bad_input",
      SpeechError::TooLarge => "speech_too_large",
      SpeechError::TooLong => "speech_too_long",
      SpeechError::Permission => "speech_permission",
      SpeechError::Failed => "speech_failed",
    }
  }

  pub fn message(&self) -> &'static str {
    match self {
      SpeechError::Stopped => "文字起こしを止めました。",
      SpeechError::NotFound if cfg!(debug_assertions) => {
        "文字起こしの部品が見つかりません。`npm run sidecar:build` で作ってから、もう一度実行してください。"
      }
      SpeechError::NotFound => "この Mac の文字起こしの部品が見つかりません。NIHO editor を入れ直してから、もう一度実行してください。",
      SpeechError::ModelMissing => "この Mac の音声認識の言語モデルがまだありません。設定で取得してから、もう一度実行してください。",
      SpeechError::Unavailable => "この Mac では音声認識を使えません。macOS 26 以降の Apple Silicon の Mac で使えます。",
      SpeechError::BadInput => "音声ファイルを読めませんでした。ファイルを確かめてから、もう一度実行してください。",
      SpeechError::TooLarge => "音声が大きすぎるか長すぎます。1 ファイル 2 GB・6 時間までです。分けてから、もう一度実行してください。",
      SpeechError::TooLong => "音声が長すぎます。1 つの録音の合計 6 時間までです。音声を減らしてから、もう一度実行してください。",
      SpeechError::Permission => "音声ファイルを開く権限がありません。システム設定の「プライバシーとセキュリティ」で NIHO editor にファイルへのアクセスを許可してから、もう一度実行してください。",
      SpeechError::Failed => "文字起こしが途中で止まりました。もう一度実行してください。",
    }
  }

  /// 終了コード（0 成功 / 1 引数・想定外 / 2 この Mac で今は使えない / 3 入力の不備 / 4 権限）と、標準出力の
  /// `{"type":"error","code":…}` の code から。2 はモデル未取得（`model_not_installed`）と、使えない Mac（`engine_unavailable`）を分ける。
  fn from_exit(code: Option<i32>, error_code: Option<&str>) -> Self {
    match code {
      Some(2) if error_code == Some("engine_unavailable") => SpeechError::Unavailable,
      Some(2) => SpeechError::ModelMissing,
      Some(3) if error_code == Some("input_too_large") => SpeechError::TooLarge,
      Some(3) => SpeechError::BadInput,
      Some(4) => SpeechError::Permission,
      _ => SpeechError::Failed,
    }
  }
}

/// 実行中の文字起こし（止められる）。
#[derive(Default)]
pub struct SpeechJob {
  stop_requested: AtomicBool,
  child: Mutex<Option<Child>>,
}

impl SpeechJob {
  pub fn new() -> Self {
    Self::default()
  }

  pub fn stop(&self) {
    self.stop_requested.store(true, Ordering::SeqCst);
    let pid = self.child.lock().ok().and_then(|guard| guard.as_ref().map(Child::id));
    if let Some(pid) = pid {
      signal_group(pid, SIGTERM);
      let deadline = Instant::now() + KILL_GRACE;
      while Instant::now() < deadline {
        if self.child.lock().map(|guard| guard.is_none()).unwrap_or(true) {
          return;
        }
        thread::sleep(Duration::from_millis(20));
      }
      if let Ok(guard) = self.child.lock() {
        if let Some(child) = guard.as_ref() {
          signal_group(child.id(), SIGKILL);
        }
      }
    }
  }

  fn stopped(&self) -> bool {
    self.stop_requested.load(Ordering::SeqCst)
  }

  /// 1 つのコマンドを実行し、標準出力の行を順に `on_line` へ渡す。終了コードで成否を返す。
  fn run(&self, binary: &Path, args: &[String], on_line: &mut dyn FnMut(&str)) -> Result<(), SpeechError> {
    if self.stopped() {
      return Err(SpeechError::Stopped);
    }
    let mut child = child_command(binary, args, None)
      .spawn()
      .map_err(|_| SpeechError::NotFound)?;
    drop(child.stdin.take());
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stderr_handle = thread::spawn(move || stderr.map(|pipe| read_tail(pipe, 16 * 1024)).unwrap_or_default());
    if let Ok(mut guard) = self.child.lock() {
      *guard = Some(child);
    }
    if self.stopped() {
      if let Ok(guard) = self.child.lock() {
        if let Some(child) = guard.as_ref() {
          signal_group(child.id(), SIGKILL);
        }
      }
    }
    // 失敗の行（`{"type":"error","code":"model_not_installed","message":"…"}`）の code を覚えて、終了コードと合わせて読む
    let mut error_code: Option<String> = None;
    if let Some(stdout) = stdout {
      for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if let Some(code) = error_line_code(&line) {
          error_code = Some(code);
          continue;
        }
        on_line(&line);
      }
    }
    let code = loop {
      let waited = match self.child.lock() {
        Ok(mut guard) => match guard.as_mut().map(|child| (child.id(), child.try_wait())) {
          Some((pid, Ok(Some(status)))) => {
            guard.take();
            signal_group(pid, SIGKILL);
            Some(status.code())
          }
          Some((pid, Err(_))) => {
            guard.take();
            signal_group(pid, SIGKILL);
            Some(None)
          }
          Some((_, Ok(None))) => None,
          None => Some(None),
        },
        Err(_) => Some(None),
      };
      if let Some(code) = waited {
        break code;
      }
      thread::sleep(Duration::from_millis(20));
    };
    let _ = stderr_handle.join();
    if self.stopped() {
      return Err(SpeechError::Stopped);
    }
    if code == Some(0) {
      Ok(())
    } else {
      Err(SpeechError::from_exit(code, error_code.as_deref()))
    }
  }

  /// 1 つのコマンドを実行し、標準出力の最後の JSON の行を返す。
  fn run_json(&self, binary: &Path, args: &[String]) -> Result<Value, SpeechError> {
    let mut last: Option<Value> = None;
    self.run(binary, args, &mut |line| {
      if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
        last = Some(value);
      }
    })?;
    last.ok_or(SpeechError::Failed)
  }
}

/// `{"type":"error","code":…}` の行なら code。
fn error_line_code(line: &str) -> Option<String> {
  let value: Value = serde_json::from_str(line.trim()).ok()?;
  (value.get("type").and_then(Value::as_str) == Some("error"))
    .then(|| value.get("code").and_then(Value::as_str).unwrap_or("").to_string())
}

fn strings(args: &[&str]) -> Vec<String> {
  args.iter().map(|arg| arg.to_string()).collect()
}

/// `probe`（言語モデルの有無）。
pub fn probe(binary: &Path, language: &str) -> Result<Value, SpeechError> {
  SpeechJob::new().run_json(binary, &strings(&["probe", "--language", language]))
}

/// `mic-status`（マイクの許可。`request` なら未決定のときに聞き、答えるまで返らない）。録音（recording.rs）の前に見る。
pub fn mic_status(binary: &Path, request: bool) -> Result<String, SpeechError> {
  let mut args = strings(&["mic-status"]);
  if request {
    args.push("--request".to_string());
  }
  SpeechJob::new()
    .run_json(binary, &args)?
    .get("status")
    .and_then(Value::as_str)
    .map(str::to_string)
    .ok_or(SpeechError::Failed)
}

/// `download`（言語モデルの取得）。進みの行は `on_line` へ。
pub fn download(
  job: &SpeechJob,
  binary: &Path,
  language: &str,
  on_line: &mut dyn FnMut(Value),
) -> Result<(), SpeechError> {
  job.run(binary, &strings(&["download", "--language", language]), &mut |line| {
    if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
      on_line(value);
    }
  })
}

#[derive(Clone, Debug, PartialEq)]
pub struct FileTranscript {
  /// 区切り（`{"type":"segment",…}`）の行だけをつないだ JSONL。
  pub jsonl: String,
  pub duration_sec: f64,
}

/// 区切りの境目（0・無音の位置・長さ）。無音の位置は範囲外と重複を除く。
/// 案件の音声の合計（`convert` が確かめた長さ）。取り込み（store.rs）は afinfo で長さが分かった音声しか数えられないので、
/// 文字起こしの前にもここで録音の合計 6 時間を確かめる。
#[derive(Default)]
struct AudioTotal(f64);

impl AudioTotal {
  fn add(&mut self, duration_sec: f64) -> Result<(), SpeechError> {
    if duration_sec.is_finite() && duration_sec > 0.0 {
      self.0 += duration_sec;
    }
    if self.0 > crate::store::AUDIO_TOTAL_MAX_SEC {
      return Err(SpeechError::TooLong);
    }
    Ok(())
  }
}

pub(crate) fn part_bounds(duration_sec: f64, cuts: &[f64]) -> Vec<(f64, f64)> {
  if !(duration_sec.is_finite() && duration_sec > 0.0) {
    return vec![];
  }
  let mut points = vec![0.0];
  let mut sorted: Vec<f64> = cuts
    .iter()
    .copied()
    .filter(|cut| cut.is_finite() && *cut > 0.0 && *cut < duration_sec)
    .collect();
  sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
  for cut in sorted {
    if cut - points[points.len() - 1] > 0.5 {
      points.push(cut);
    }
  }
  points.push(duration_sec);
  points.windows(2).map(|pair| (pair[0], pair[1])).collect()
}

/// 音声を順に文字起こしする。`on_event` には段階・区切り・進みを流す（画面の逐次表示）。
pub fn transcribe(
  job: &SpeechJob,
  binary: &Path,
  files: &[PathBuf],
  language: &str,
  hints_json: &str,
  speaker_mode: &str,
  on_event: &mut dyn FnMut(Value),
) -> Result<Vec<FileTranscript>, SpeechError> {
  if !matches!(speaker_mode, "none" | "auto" | "2" | "3" | "4plus") {
    return Err(SpeechError::BadInput);
  }
  let temp = PrivateTempDir::create("niho-docs-speech").map_err(|_| SpeechError::Failed)?;
  let hints_path = temp
    .write_private("hints.json", hints_json.as_bytes())
    .map_err(|_| SpeechError::Failed)?;
  let hints = hints_path.to_string_lossy().into_owned();
  let mut transcripts = Vec::new();
  let mut total = AudioTotal::default();
  for (file_index, file) in files.iter().enumerate() {
    if !file.is_file() {
      return Err(SpeechError::BadInput);
    }
    on_event(json!({ "type": "Stage", "stage": "convert", "file": file_index, "files": files.len() }));
    let wav = temp.path().join(format!("{file_index}.wav"));
    let input = file.to_string_lossy().into_owned();
    let output = wav.to_string_lossy().into_owned();
    let converted = job.run_json(binary, &strings(&["convert", "--input", &input, "--output", &output]))?;
    let duration_sec = converted.get("durationSec").and_then(Value::as_f64).unwrap_or(0.0);
    total.add(duration_sec)?;

    let speaker_map = if speaker_mode == "none" {
      None
    } else {
      on_event(json!({ "type": "Stage", "stage": "diarize", "file": file_index, "files": files.len() }));
      let map = temp.path().join(format!("{file_index}.speakers.json"));
      let map_path = map.to_string_lossy().into_owned();
      let mut args = strings(&["diarize", "--input", &output, "--output", &map_path]);
      match speaker_mode {
        "2" | "3" => args.extend(["--speakers".to_string(), speaker_mode.to_string()]),
        "4plus" => args.extend(["--minimum-speakers".to_string(), "4".to_string()]),
        _ => {}
      }
      let diarized = job.run_json(binary, &args)?;
      if diarized.get("ok").and_then(Value::as_bool) != Some(true) || !map.is_file() {
        return Err(SpeechError::Failed);
      }
      Some(map_path)
    };

    on_event(json!({ "type": "Stage", "stage": "silence", "file": file_index, "files": files.len() }));
    let silence = job.run_json(
      binary,
      &strings(&[
        "silence",
        "--input",
        &output,
        "--target",
        SILENCE_TARGET_SEC,
        "--window",
        SILENCE_WINDOW_SEC,
        "--min",
        SILENCE_MIN_SEC,
      ]),
    )?;
    let cuts: Vec<f64> = silence
      .get("cuts")
      .and_then(Value::as_array)
      .map(|cuts| cuts.iter().filter_map(Value::as_f64).collect())
      .unwrap_or_default();
    let mut bounds = part_bounds(duration_sec, &cuts);
    if bounds.is_empty() {
      bounds.push((0.0, 0.0));
    }

    let mut jsonl = String::new();
    let parts = bounds.len();
    for (part, (start, end)) in bounds.into_iter().enumerate() {
      on_event(
        json!({ "type": "Stage", "stage": "transcribe", "file": file_index, "files": files.len(), "part": part, "parts": parts }),
      );
      let mut args = strings(&[
        "transcribe",
        "--input",
        &output,
        "--language",
        language,
        "--hints",
        &hints,
      ]);
      if end > start {
        args.extend([
          "--start".to_string(),
          format!("{start:.3}"),
          "--end".to_string(),
          format!("{end:.3}"),
        ]);
      }
      if let Some(map) = &speaker_map {
        args.extend(["--speaker-map".to_string(), map.clone()]);
      }
      let mut segment_count = 0usize;
      let mut done_count = 0usize;
      let mut done_segments = None;
      let mut valid_done = true;
      job.run(binary, &args, &mut |line| {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
          return;
        };
        match value.get("type").and_then(Value::as_str) {
          Some("segment") => {
            segment_count += 1;
            jsonl.push_str(line.trim());
            jsonl.push('\n');
            let mut event = json!({
              "type": "Segment",
              "file": file_index,
              "start": value.get("start").cloned().unwrap_or(Value::Null),
              "end": value.get("end").cloned().unwrap_or(Value::Null),
              "text": value.get("text").cloned().unwrap_or(Value::Null),
            });
            if let Some(speaker) = value.get("speaker") {
              event["speaker"] = speaker.clone();
            }
            on_event(event);
          }
          Some("progress") => {
            on_event(json!({
              "type": "Progress",
              "file": file_index,
              "part": part,
              "parts": parts,
              "ratio": value.get("ratio").cloned().unwrap_or(Value::Null),
            }));
          }
          Some("done") => {
            done_count += 1;
            let count = value
              .get("segments")
              .and_then(Value::as_u64)
              .and_then(|count| usize::try_from(count).ok());
            let duration = value.get("durationMs").and_then(Value::as_u64);
            if count.is_none() || duration.is_none() {
              valid_done = false;
            }
            done_segments = count;
          }
          _ => {}
        }
      })?;
      if done_count != 1 || !valid_done || done_segments != Some(segment_count) {
        return Err(SpeechError::Failed);
      }
    }
    transcripts.push(FileTranscript { jsonl, duration_sec });
  }
  Ok(transcripts)
}

/// Gemini に渡す前の音声（`convert` の WAV と、`silence` の区切りの境目）。
#[derive(Clone, Debug, PartialEq)]
pub struct PreparedFile {
  /// `convert` の WAV（16 kHz・mono）。
  pub wav: PathBuf,
  pub duration_sec: f64,
  /// 区切りの境目（秒。元の音声の絶対秒）。
  pub bounds: Vec<(f64, f64)>,
  /// 無音検出で測った、各区切りの無音以外の秒数。
  pub sound_sec: Vec<f64>,
}

/// 音声を順に `convert` → `silence` して区切りの境目を決める（WAV は `dir` に `f<n>.wav` で置く。消すのは呼び出し側）。
/// `on_event` には段階（convert・silence）を流す。
pub fn prepare_audio(
  job: &SpeechJob,
  binary: &Path,
  files: &[PathBuf],
  dir: &Path,
  on_event: &mut dyn FnMut(Value),
) -> Result<Vec<PreparedFile>, SpeechError> {
  let mut prepared = Vec::new();
  let mut total = AudioTotal::default();
  for (file_index, file) in files.iter().enumerate() {
    if !file.is_file() {
      return Err(SpeechError::BadInput);
    }
    on_event(json!({ "type": "Stage", "stage": "convert", "file": file_index, "files": files.len() }));
    let wav = dir.join(format!("f{file_index}.wav"));
    let input = file.to_string_lossy().into_owned();
    let output = wav.to_string_lossy().into_owned();
    let converted = job.run_json(binary, &strings(&["convert", "--input", &input, "--output", &output]))?;
    let duration_sec = converted.get("durationSec").and_then(Value::as_f64).unwrap_or(0.0);
    total.add(duration_sec)?;
    on_event(json!({ "type": "Stage", "stage": "silence", "file": file_index, "files": files.len() }));
    let silence = job.run_json(
      binary,
      &strings(&[
        "silence",
        "--input",
        &output,
        "--target",
        GEMINI_SILENCE_TARGET_SEC,
        "--window",
        SILENCE_WINDOW_SEC,
        "--min",
        SILENCE_MIN_SEC,
      ]),
    )?;
    let cuts: Vec<f64> = silence
      .get("cuts")
      .and_then(Value::as_array)
      .map(|cuts| cuts.iter().filter_map(Value::as_f64).collect())
      .unwrap_or_default();
    let bounds = part_bounds(duration_sec, &cuts);
    if bounds.is_empty() {
      // 長さの読めない音声（0 秒）は Gemini に渡せない
      return Err(SpeechError::BadInput);
    }
    let sound_sec: Vec<f64> = silence
      .get("soundSec")
      .and_then(Value::as_array)
      .filter(|values| values.len() == bounds.len())
      .ok_or(SpeechError::Failed)?
      .iter()
      .map(|value| value.as_f64().ok_or(SpeechError::Failed))
      .collect::<Result<_, _>>()?;
    if sound_sec
      .iter()
      .zip(&bounds)
      .any(|(sound, (start, end))| !sound.is_finite() || *sound < 0.0 || *sound > end - start + 0.02)
    {
      return Err(SpeechError::Failed);
    }
    prepared.push(PreparedFile {
      wav,
      duration_sec,
      bounds,
      sound_sec,
    });
  }
  Ok(prepared)
}

/// 区切り 1 つを WAV に書き出す（`slice`。隣り合う区切りを同じ値で切ると、つなげて元と同じ標本になる）。
pub fn slice_part(
  job: &SpeechJob,
  binary: &Path,
  wav: &Path,
  start: f64,
  end: f64,
  output: &Path,
) -> Result<(), SpeechError> {
  let input = wav.to_string_lossy().into_owned();
  let output = output.to_string_lossy().into_owned();
  job.run_json(
    binary,
    &strings(&[
      "slice",
      "--input",
      &input,
      "--output",
      &output,
      "--start",
      &format!("{start:.3}"),
      "--end",
      &format!("{end:.3}"),
    ]),
  )?;
  Ok(())
}

/// 音声の長さ（秒）。macOS の afinfo の「estimated duration」を読む（読めなければ None）。
pub fn audio_duration_sec(path: &Path) -> Option<f64> {
  let output = std::process::Command::new("/usr/bin/afinfo").arg(path).output().ok()?;
  if !output.status.success() {
    return None;
  }
  let text = String::from_utf8_lossy(&output.stdout);
  text.lines().find_map(|line| {
    let rest = line.trim().strip_prefix("estimated duration:")?;
    rest.trim().split_whitespace().next()?.parse::<f64>().ok()
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;

  fn fake_binary() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../sidecar/fake/niho-speech")
  }

  fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
      "niho-docs-speech-test-{name}-{}-{}",
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

  #[test]
  fn part_bounds_follow_the_silence_cuts() {
    assert_eq!(part_bounds(95.0, &[48.0]), vec![(0.0, 48.0), (48.0, 95.0)]);
    assert_eq!(
      part_bounds(100.0, &[120.0, -1.0, 30.0, 30.2, 60.0]),
      vec![(0.0, 30.0), (30.0, 60.0), (60.0, 100.0)]
    );
    assert_eq!(part_bounds(0.0, &[1.0]), vec![]);
  }

  #[test]
  fn fake_sidecar_runs_convert_silence_and_transcribe_in_order() {
    let dir = temp_dir("fake");
    let audio = dir.join("a.m4a");
    fs::write(&audio, b"not really audio").unwrap();
    let mut events = Vec::new();
    let transcripts = transcribe(
      &SpeechJob::new(),
      &fake_binary(),
      &[audio.clone(), audio],
      "ja",
      r#"[{"term":"NIHO鎌倉","reading":"にほかまくら","variants":[]}]"#,
      "none",
      &mut |event| events.push(event),
    )
    .unwrap();
    assert_eq!(transcripts.len(), 2);
    assert_eq!(transcripts[0].duration_sec, 95.0);
    let segments: Vec<Value> = transcripts[0]
      .jsonl
      .lines()
      .map(|line| serde_json::from_str(line).unwrap())
      .collect();
    assert!(segments.len() >= 4);
    assert!(segments.iter().all(|segment| segment["type"] == "segment"));
    // 区切りごとに --start / --end の範囲の区切りだけが返り、時刻は元の音声の絶対秒
    assert!(segments
      .windows(2)
      .all(|pair| pair[0]["start"].as_f64() <= pair[1]["start"].as_f64()));
    let stages: Vec<String> = events
      .iter()
      .filter(|event| event["type"] == "Stage")
      .map(|event| event["stage"].as_str().unwrap().to_string())
      .collect();
    assert_eq!(&stages[..4], &["convert", "silence", "transcribe", "transcribe"]);
    assert!(events.iter().any(|event| event["type"] == "Segment"));
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn speaker_mode_diarizes_whole_file_once_and_reuses_one_map_for_every_chunk() {
    let dir = temp_dir("diarize-once");
    let audio = dir.join("a.m4a");
    let log = dir.join("calls.log");
    fs::write(&audio, b"x").unwrap();
    let binary = script(
      &dir,
      &format!(
        r#"printf '%s\n' "$*" >> '{}'
command="$1"; shift
output=""
map=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --speaker-map) map="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "$command" in
  convert) : > "$output"; printf '%s\n' '{{"durationSec":95}}' ;;
  diarize) printf '%s\n' '{{"version":1,"duration":95,"turns":[{{"start":0,"end":95,"id":1}}]}}' > "$output"; printf '%s\n' '{{"ok":true,"turns":1}}' ;;
  silence) printf '%s\n' '{{"cuts":[48]}}' ;;
  transcribe) [ -n "$map" ] || exit 9; printf '%s\n' '{{"type":"segment","start":1,"end":2,"text":"a","speaker":1}}' '{{"type":"done","segments":1,"durationMs":1}}' ;;
esac"#,
        log.display()
      ),
    );
    let transcripts = transcribe(&SpeechJob::new(), &binary, &[audio], "ja", "[]", "2", &mut |_| {}).unwrap();
    let calls = fs::read_to_string(log).unwrap();
    assert_eq!(calls.lines().filter(|line| line.starts_with("diarize ")).count(), 1);
    let maps: Vec<&str> = calls
      .lines()
      .filter(|line| line.starts_with("transcribe "))
      .filter_map(|line| line.split("--speaker-map ").nth(1))
      .collect();
    assert_eq!(maps.len(), 2);
    assert_eq!(maps[0], maps[1]);
    assert!(calls
      .lines()
      .any(|line| line.contains("diarize") && line.contains("--speakers 2")));
    assert!(transcripts[0]
      .jsonl
      .lines()
      .all(|line| serde_json::from_str::<Value>(line).unwrap()["speaker"] == 1));
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn speaker_none_never_runs_diarization_and_diarization_failure_is_fail_closed() {
    let dir = temp_dir("diarize-fail-closed");
    let audio = dir.join("a.m4a");
    fs::write(&audio, b"x").unwrap();
    let raw = script(
      &dir,
      r#"case "$1" in
  convert) printf '%s\n' '{"durationSec":10}' ;;
  diarize) exit 9 ;;
  silence) printf '%s\n' '{"cuts":[]}' ;;
  transcribe) printf '%s\n' '{"type":"segment","start":1,"end":2,"text":"raw"}' '{"type":"done","segments":1,"durationMs":1}' ;;
esac"#,
    );
    let raw_result = transcribe(
      &SpeechJob::new(),
      &raw,
      &[audio.clone()],
      "ja",
      "[]",
      "none",
      &mut |_| {},
    )
    .unwrap();
    assert!(!raw_result[0].jsonl.contains("speaker"));

    let failed = transcribe(&SpeechJob::new(), &raw, &[audio], "ja", "[]", "auto", &mut |_| {});
    assert_eq!(failed, Err(SpeechError::Failed));
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn stop_cancels_the_whole_file_diarization() {
    let dir = temp_dir("stop-diarize");
    let audio = dir.join("a.m4a");
    fs::write(&audio, b"x").unwrap();
    let binary = script(
      &dir,
      r#"case "$1" in
  convert) printf '%s\n' '{"durationSec":10}' ;;
  diarize) sleep 30 ;;
esac"#,
    );
    let job = std::sync::Arc::new(SpeechJob::new());
    let worker = {
      let job = job.clone();
      thread::spawn(move || transcribe(&job, &binary, &[audio], "ja", "[]", "auto", &mut |_| {}))
    };
    thread::sleep(Duration::from_millis(200));
    job.stop();
    assert_eq!(worker.join().unwrap(), Err(SpeechError::Stopped));
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn fake_sidecar_prepares_the_parts_and_slices_one() {
    let dir = temp_dir("prepare");
    let audio = dir.join("a.m4a");
    fs::write(&audio, b"not really audio").unwrap();
    let mut events = Vec::new();
    let prepared = prepare_audio(
      &SpeechJob::new(),
      &fake_binary(),
      &[audio.clone(), audio],
      &dir,
      &mut |event| events.push(event),
    )
    .unwrap();
    assert_eq!(prepared.len(), 2);
    assert_eq!(prepared[0].duration_sec, 95.0);
    assert_eq!(prepared[0].bounds, vec![(0.0, 48.0), (48.0, 95.0)]);
    assert_eq!(prepared[0].sound_sec, vec![48.0, 47.0]);
    assert_eq!(prepared[1].wav, dir.join("f1.wav"));
    let stages: Vec<&str> = events.iter().filter_map(|event| event["stage"].as_str()).collect();
    assert_eq!(stages, ["convert", "silence", "convert", "silence"]);
    let part = dir.join("f0-p1.wav");
    slice_part(&SpeechJob::new(), &fake_binary(), &prepared[0].wav, 48.0, 95.0, &part).unwrap();
    assert!(part.is_file());
    // 区切りの範囲は sidecar に渡した値（偽物は書いた範囲を中身に残す）
    assert_eq!(fs::read_to_string(&part).unwrap().trim(), "slice 48.000 95.000");
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn gemini_preparation_uses_ten_minute_parts_and_passes_sound_metadata() {
    let dir = temp_dir("gemini-short-parts");
    let audio = dir.join("a.m4a");
    fs::write(&audio, b"x").unwrap();
    let binary = script(
      &dir,
      r#"case "$1" in
  convert) printf '%s\n' '{"durationSec":1200.0}' ;;
  silence)
    case " $* " in
      *" --target 600 "*) printf '%s\n' '{"cuts":[600.0],"soundSec":[500.0,550.0]}' ;;
      *) exit 1 ;;
    esac ;;
esac"#,
    );
    let files = prepare_audio(&SpeechJob::new(), &binary, &[audio], &dir, &mut |_| {}).unwrap();
    assert_eq!(files[0].bounds, vec![(0.0, 600.0), (600.0, 1200.0)]);
    assert_eq!(files[0].sound_sec, vec![500.0, 550.0]);
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn the_project_total_is_checked_with_the_lengths_convert_confirms() {
    // 取り込みで長さが分からなかった音声も、convert が確かめた長さで録音の合計 6 時間を数える（4 時間 × 2 本で止める）
    let dir = temp_dir("total");
    let audio = dir.join("a.mov");
    fs::write(&audio, b"x").unwrap();
    let binary = script(
      &dir,
      r#"case "$1" in
  convert) printf '%s\n' '{"durationSec":14400.0}' ;;
  silence) printf '%s\n' '{"cuts":[],"soundSec":[14400.0]}' ;;
  transcribe) printf '%s\n' '{"type":"done","segments":0,"durationMs":1}' ;;
esac"#,
    );
    let mut stages = Vec::new();
    let result = prepare_audio(
      &SpeechJob::new(),
      &binary,
      &[audio.clone(), audio.clone()],
      &dir,
      &mut |event| stages.extend(event["stage"].as_str().map(str::to_string)),
    );
    assert!(matches!(result, Err(SpeechError::TooLong)));
    // 2 本目の convert の後で止め、silence に進まない
    assert_eq!(stages, ["convert", "silence", "convert"]);
    assert_eq!(
      transcribe(
        &SpeechJob::new(),
        &binary,
        &[audio.clone(), audio.clone()],
        "ja",
        "[]",
        "none",
        &mut |_| {}
      )
      .map(|_| ()),
      Err(SpeechError::TooLong)
    );
    // 1 本（4 時間）なら通る
    assert_eq!(
      prepare_audio(&SpeechJob::new(), &binary, &[audio], &dir, &mut |_| {})
        .unwrap()
        .len(),
      1
    );
    assert_eq!(SpeechError::TooLong.code(), "speech_too_long");
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn prepare_rejects_a_missing_file_and_a_zero_length_audio() {
    let dir = temp_dir("prepare-bad");
    assert_eq!(
      prepare_audio(
        &SpeechJob::new(),
        &fake_binary(),
        &[dir.join("missing.m4a")],
        &dir,
        &mut |_| {}
      ),
      Err(SpeechError::BadInput)
    );
    let audio = dir.join("a.m4a");
    fs::write(&audio, b"x").unwrap();
    let binary = script(
      &dir,
      r#"case "$1" in
  convert) printf '%s\n' '{"durationSec":0}' ;;
  silence) printf '%s\n' '{"cuts":[]}' ;;
esac"#,
    );
    assert_eq!(
      prepare_audio(&SpeechJob::new(), &binary, &[audio], &dir, &mut |_| {}),
      Err(SpeechError::BadInput)
    );
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn exit_codes_map_to_errors() {
    let dir = temp_dir("codes");
    let audio = dir.join("a.m4a");
    fs::write(&audio, b"x").unwrap();
    for (code, expected) in [
      (2, SpeechError::ModelMissing),
      (3, SpeechError::BadInput),
      (4, SpeechError::Permission),
      (9, SpeechError::Failed),
    ] {
      let binary = script(&dir, &format!("exit {code}"));
      let result = transcribe(
        &SpeechJob::new(),
        &binary,
        &[audio.clone()],
        "ja",
        "[]",
        "none",
        &mut |_| {},
      );
      assert_eq!(result, Err(expected));
    }
    let binary = script(&dir, "exit 0");
    assert_eq!(
      transcribe(
        &SpeechJob::new(),
        &binary,
        &[dir.join("missing.m4a")],
        "ja",
        "[]",
        "none",
        &mut |_| {}
      ),
      Err(SpeechError::BadInput)
    );
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn transcribe_rejects_missing_duplicate_or_mismatched_done_events() {
    let dir = temp_dir("done-contract");
    let audio = dir.join("a.m4a");
    fs::write(&audio, b"x").unwrap();
    for (name, events) in [
      (
        "missing",
        r#"printf '%s\n' '{"type":"segment","start":1,"end":2,"text":"a"}'"#,
      ),
      (
        "mismatch",
        r#"printf '%s\n' '{"type":"segment","start":1,"end":2,"text":"a"}' '{"type":"done","segments":2,"durationMs":1}'"#,
      ),
      (
        "duplicate",
        r#"printf '%s\n' '{"type":"done","segments":0,"durationMs":1}' '{"type":"done","segments":0,"durationMs":1}'"#,
      ),
    ] {
      let binary = script(
        &dir,
        &format!(
          r#"case "$1" in
  convert) printf '%s\n' '{{"durationSec":95.0}}' ;;
  silence) printf '%s\n' '{{"cuts":[]}}' ;;
  transcribe) {events} ;;
esac"#
        ),
      );
      let result = transcribe(
        &SpeechJob::new(),
        &binary,
        &[audio.clone()],
        "ja",
        "[]",
        "none",
        &mut |_| {},
      );
      assert_eq!(result, Err(SpeechError::Failed), "{name}");
    }
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn stop_ends_the_running_command() {
    let dir = temp_dir("stop");
    let audio = dir.join("a.m4a");
    fs::write(&audio, b"x").unwrap();
    let binary = script(&dir, "sleep 30 & wait");
    let job = std::sync::Arc::new(SpeechJob::new());
    let worker = {
      let job = job.clone();
      let audio = audio.clone();
      thread::spawn(move || transcribe(&job, &binary, &[audio], "ja", "[]", "none", &mut |_| {}))
    };
    thread::sleep(Duration::from_millis(200));
    let started = Instant::now();
    job.stop();
    assert_eq!(worker.join().unwrap(), Err(SpeechError::Stopped));
    assert!(started.elapsed() < Duration::from_secs(5));
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn mic_status_reads_the_fake_status() {
    assert_eq!(mic_status(&fake_binary(), false).unwrap(), "authorized");
    assert_eq!(mic_status(&fake_binary(), true).unwrap(), "authorized");
  }

  #[test]
  fn probe_reads_the_fake_status() {
    let status = probe(&fake_binary(), "ja").unwrap();
    assert_eq!(status["available"], true);
    assert_eq!(status["needsDownload"], false);
  }

  #[test]
  fn macos_major_reads_the_product_version() {
    assert_eq!(macos_major("26.0.1\n"), Some(26));
    assert_eq!(macos_major("15.6"), Some(15));
    assert_eq!(macos_major("27"), Some(27));
    assert_eq!(macos_major(""), None);
    assert_eq!(macos_major("x.y"), None);
  }

  #[test]
  fn sidecar_is_found_bundled_then_built_then_the_stand_in_fake() {
    let dir = temp_dir("resolve");
    fs::create_dir_all(dir.join("bundled")).unwrap();
    fs::create_dir_all(dir.join("built")).unwrap();
    let bundled = script(&dir.join("bundled"), "exit 0");
    let built = script(&dir.join("built"), "exit 0");
    let missing = dir.join("missing/niho-speech");
    assert_eq!(
      resolve_from(Some(bundled.clone()), built.clone(), Some(fake_binary())),
      Some(SpeechBinary {
        path: bundled,
        fake: false,
        stand_in: false
      })
    );
    assert_eq!(
      resolve_from(Some(missing.clone()), built.clone(), Some(fake_binary())),
      Some(SpeechBinary {
        path: built,
        fake: false,
        stand_in: false
      })
    );
    // 本物が無ければ、開発ビルドだけ偽物で代わりに動く（設定に npm run sidecar:build の案内を出す）
    assert_eq!(
      resolve_from(Some(missing.clone()), missing.clone(), Some(fake_binary())),
      Some(SpeechBinary {
        path: fake_binary(),
        fake: true,
        stand_in: true
      })
    );
    assert_eq!(resolve_from(None, missing, None), None);
    assert!(STAND_IN_NOTICE.contains("npm run sidecar:build"));
    assert!(SpeechError::NotFound.message().contains("npm run sidecar:build"));
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn hints_pass_only_the_terms() {
    let hints = json!([
      { "term": " NIHO鎌倉 ", "reading": "にほかまくら", "variants": ["NIHO 鎌倉"] },
      { "term": "", "reading": "x" },
      { "reading": "termなし" },
      { "term": "材木座" }
    ]);
    assert_eq!(hints_json(&hints), r#"[{"term":"NIHO鎌倉"},{"term":"材木座"}]"#);
    assert_eq!(hints_json(&json!(null)), "[]");
  }

  #[test]
  fn error_lines_tell_apart_a_missing_model_and_an_unusable_mac() {
    let dir = temp_dir("error-lines");
    let audio = dir.join("a.m4a");
    fs::write(&audio, b"x").unwrap();
    for (line, code, expected) in [
      (
        r#"{"type":"error","code":"model_not_installed","message":"run niho-speech download --language ja"}"#,
        2,
        SpeechError::ModelMissing,
      ),
      (
        r#"{"type":"error","code":"engine_unavailable","message":"SpeechTranscriber is not available"}"#,
        2,
        SpeechError::Unavailable,
      ),
      (
        r#"{"type":"error","code":"permission_denied","message":"EACCES"}"#,
        4,
        SpeechError::Permission,
      ),
      (
        r#"{"type":"error","code":"input_unreadable","message":"no audio track"}"#,
        3,
        SpeechError::BadInput,
      ),
      (
        r#"{"type":"error","code":"input_too_large","message":"longer than 6 hours"}"#,
        3,
        SpeechError::TooLarge,
      ),
    ] {
      let binary = script(&dir, &format!("printf '%s\\n' '{line}'\nexit {code}"));
      let result = transcribe(
        &SpeechJob::new(),
        &binary,
        &[audio.clone()],
        "ja",
        "[]",
        "none",
        &mut |_| {},
      );
      assert_eq!(result, Err(expected), "{line}");
    }
    let _ = fs::remove_dir_all(dir);
  }

  /// 本物の niho-speech（`npm run sidecar:build` の出力）で、固定サンプルを convert → silence → transcribe に通す。
  /// CI では走らない（macOS 26 の SDK と日本語のモデルが要る）。手元で:
  /// `cargo test -p niho_docs real_sidecar -- --ignored --nocapture`
  /// `NIHO_DOCS_SPEECH_JSONL_OUT=<file>` を渡すと、区切りの JSONL をそのファイルに書く（docs-core の transcriptMarkdown で確かめる）。
  #[test]
  #[ignore]
  fn real_sidecar_transcribes_the_fixture() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let binary = [
      manifest.join("binaries/niho-speech-aarch64-apple-darwin"),
      manifest.join("../sidecar/niho-speech/.build/release/niho-speech"),
    ]
    .into_iter()
    .find(|path| crate::process::is_executable(path))
    .expect("niho-speech が無い。npm -C apps/docs run sidecar:build で作る");
    let job = SpeechJob::new();
    let version = job.run_json(&binary, &strings(&["version"])).unwrap();
    println!("version: {version}");
    assert_eq!(version["name"], "niho-speech");
    let status = probe(&binary, "ja").unwrap();
    println!("probe: {status}");
    assert_eq!(status["available"], true);
    assert_eq!(
      status["needsDownload"], false,
      "日本語のモデルが未取得（niho-speech download --language ja）"
    );

    let audio = PathBuf::from(
      std::env::var("NIHO_SPEECH_TEST_FIXTURE").expect("NIHO_SPEECH_TEST_FIXTURE に非公開の日本語音声を指定する"),
    );
    let mut events = Vec::new();
    let hints = hints_json(&json!([{ "term": "鎌倉", "reading": "かまくら", "variants": [] }]));
    let transcripts = transcribe(&job, &binary, &[audio], "ja", &hints, "none", &mut |event| {
      events.push(event)
    })
    .unwrap();
    assert_eq!(transcripts.len(), 1);
    println!("durationSec: {}", transcripts[0].duration_sec);
    println!("jsonl:\n{}", transcripts[0].jsonl);
    assert!((transcripts[0].duration_sec - 13.35).abs() < 0.2);
    let segments: Vec<Value> = transcripts[0]
      .jsonl
      .lines()
      .map(|line| serde_json::from_str(line).unwrap())
      .collect();
    assert!(!segments.is_empty());
    assert!(segments.iter().all(|segment| segment["type"] == "segment"));
    let text: String = segments.iter().filter_map(|segment| segment["text"].as_str()).collect();
    assert!(text.contains("鎌倉"), "{text}");
    let stages: Vec<&str> = events
      .iter()
      .filter(|event| event["type"] == "Stage")
      .filter_map(|event| event["stage"].as_str())
      .collect();
    assert_eq!(stages, ["convert", "silence", "transcribe"]);
    if let Ok(out) = std::env::var("NIHO_DOCS_SPEECH_JSONL_OUT") {
      fs::write(out, &transcripts[0].jsonl).unwrap();
    }
  }
}
