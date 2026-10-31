//! 「AIと作る」の修正の会話（S5 #18386）の command。
//!
//! - `run_chat_turn`: 録音の正本の artifacts と工程 1 の文字起こし・文章（`artifacts/source.md` として）を会話ごとの一時
//!   workspace へ写し、そこだけを書ける形（`ToolPolicy::ProjectFolder`）で AI に送り、変更分を画面へ返す。正本への保存は画面の
//!   `save_artifact` が版として行う。CLI（Claude Code・Codex・Antigravity CLI）は workspace で動き、API キー方式は
//!   アプリの道具で workspace を読み書きする（会話の履歴は会話ごとに残すフォルダ `chat-sessions/` に置く）。
//!   `TurnEvent`（`ToolUse`・`ToolResult` を含む）を
//!   `{ turnId, seq, event }` で流す。パスは画面から受け取らず、案件と録音の id から作る。止めるのは工程の実行と同じ `stop_turn`。
//! - 版を足すのは画面（CLI が返した差分を `save_artifact`）。依頼中に人が保存した正本は CLI から隔離され、そのまま保つ。
//! - 会話は録音のフォルダの conversations/<conversationId>.json（`list_conversations`・`save_conversation`）。
//! - workspace は root の録音（今の案件）なら `chat-workspaces/<projectId>/<conversationId>`（既存の会話の resume が同じ cwd を
//!   使うので変えない）、ほかの録音は `chat-workspaces/<projectId>/<recordingId>-<conversationId>`（2 階層のまま）。
//!
//! 同じ案件の実行（工程・会話）は 1 つ。画面が `acquire_run_lock` を取ってから送る（工程の実行と同じ。ロックは案件単位）。

use crate::contract::{Effort, Provider, ToolPolicy, TurnEvent, TurnRequest};
use crate::store::{ArtifactState, Store, StoreError, ROOT_RECORDING_ID};
use crate::{safe_id, AppState, CommandError, CommandResult, MAX_SYSTEM_PROMPT_BYTES, MAX_USER_PROMPT_BYTES};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::ipc::Channel;
use tauri::State;

/// 修正の会話の 1 回の時間の上限（文書を読み書きする会話。NIHO Desktop の記事エージェントと同じ 20 分）。
/// 開発で試すときは工程の実行と同じ環境変数で縮められる。
const CHAT_TURN_TIME_LIMIT: Duration = Duration::from_secs(20 * 60);
/// AI が書ける場所（隔離 workspace の中の相対フォルダ）。工程の文書と、工程 1 の文字起こし・文章（source.md）だけ。
pub const CHAT_WRITABLE_DIR: &str = "artifacts";
const OUTSIDE_WORKSPACE: &str = "_outside";

/// 画面から受け取る修正の会話の依頼（名前は契約のまま。起動フォルダは隔離 workspace、時間の上限はこちらで決める）。
#[derive(Deserialize)]
pub struct ChatTurnWire {
  provider: Provider,
  model: String,
  effort: Option<Effort>,
  system_prompt: String,
  user_prompt: String,
  resume_session: Option<String>,
  max_budget_usd: Option<f64>,
  writable_artifact_id: Option<String>,
  /// composer（#18722）: 同じ場所のほかの文書も作業場所に写す。無ければ今までどおり開いている録音の文書だけ。
  #[serde(default)]
  composer: Option<ComposerWire>,
}

/// composer の作業場所（Cursor の composer と同じく、既存の文書を直し、新しい文書も作れる。#18722）。書けるのは今までどおり
/// artifacts/ の下だけ（Codex の workspace-write は書き先を 1 つに限るため）なので、文書ページは artifacts/pages/<pageId>.md、
/// 新しい文書は artifacts/new/、ほかの録音の成果物は読むだけの reference/<pageId>.<artifactId>.md に置く。
#[derive(Deserialize)]
pub struct ComposerWire {
  /// 開いている録音の文字起こし・成果物を artifacts/ に写すか（文書ページの会話では false。`recording_id` は文書ページの id）。
  recording: bool,
  /// 同じ場所（フォルダ、またはフォルダの外）の文書ページの id。
  pages: Vec<String>,
  /// ほかの録音の成果物（読むだけ）。
  references: Vec<ComposerReferenceWire>,
  /// 開いている録音の文書を直せるか（複数案があって案を開いていない録音ページでは false。写すが変更は受け取らない）。
  #[serde(default = "writable_by_default")]
  recording_writable: bool,
}

fn writable_by_default() -> bool {
  true
}

#[derive(Deserialize)]
pub struct ComposerReferenceWire {
  page_id: String,
  artifact_id: String,
}

/// artifacts/ の下の文書ページ・新しい文書の置き場と、読むだけの成果物の置き場。
pub const COMPOSER_PAGES_DIR: &str = "pages";
pub const COMPOSER_NEW_DIR: &str = "new";
pub const COMPOSER_REFERENCE_DIR: &str = "reference";
/// 写す文書ページ・成果物の数の上限と、1 回の依頼で受け取る新しい文書の数・1 つの文書の大きさの上限。
/// 写す数の上限は画面側（composer.ts の COMPOSER_PAGES_MAX・COMPOSER_REFERENCES_MAX）も同じ値で絞って送る
/// （開いている文書は画面側が必ず含める）。
const COMPOSER_PAGES_MAX: usize = 300;
const COMPOSER_REFERENCES_MAX: usize = 300;
const COMPOSER_NEW_MAX: usize = 10;
const COMPOSER_DOC_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// 隔離 workspace で変わった文書（工程 1 は `source`）。`markdown: None` は削除。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatArtifactChange {
  pub step_id: String,
  pub markdown: Option<String>,
}

/// composer: AI が書き換えた文書ページ（消した文書ページは返さない。文書を消す操作は受け付けない）。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatPageChange {
  pub page_id: String,
  pub markdown: String,
}

/// composer: AI が作った新しい文書（`file` は artifacts/new/ の中のファイル名。画面が題を決めて文書ページにする）。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatNewDocument {
  pub file: String,
  pub markdown: String,
}

/// 終端イベントと、画面が正本へ版として保存する差分。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurnResult {
  pub artifacts: Vec<ChatArtifactChange>,
  pub pages: Vec<ChatPageChange>,
  pub created: Vec<ChatNewDocument>,
  pub final_event: Value,
}

fn stage_error() -> CommandError {
  CommandError::new("chat_workspace_io", "AI の作業場所を用意できませんでした。")
}

/// 強制終了で残った隔離 workspace を 24 時間後に掃除する。会話の resume は同じ path を次の依頼で再作成する。
pub fn cleanup_stale_chat_workspaces(data_dir: &Path) {
  let Ok(canonical_data) = data_dir.canonicalize() else {
    return;
  };
  let base = data_dir.join("local-ai").join("chat-workspaces");
  let Ok(metadata) = fs::symlink_metadata(&base) else {
    return;
  };
  if metadata.file_type().is_symlink() || !metadata.is_dir() {
    return;
  }
  let Ok(canonical_base) = base.canonicalize() else {
    return;
  };
  if !canonical_base.starts_with(&canonical_data) {
    return;
  }
  let Ok(projects) = fs::read_dir(canonical_base) else {
    return;
  };
  for project in projects.flatten() {
    let Ok(project_type) = project.file_type() else {
      continue;
    };
    if !project_type.is_dir() || project_type.is_symlink() {
      continue;
    }
    let Ok(workspaces) = fs::read_dir(project.path()) else {
      continue;
    };
    for workspace in workspaces.flatten() {
      let Ok(workspace_type) = workspace.file_type() else {
        continue;
      };
      if !workspace_type.is_dir() || workspace_type.is_symlink() {
        continue;
      }
      let stale = workspace
        .metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age >= Duration::from_secs(24 * 60 * 60));
      if stale {
        let _ = fs::remove_dir_all(workspace.path());
      }
    }
  }
}

/// 会話の workspace のフォルダ名（root は今までどおり会話の id だけ。ほかの録音は `<recordingId>-<conversationId>`）。
fn workspace_name(recording_id: &str, conversation_id: &str) -> String {
  if recording_id == ROOT_RECORDING_ID {
    conversation_id.to_string()
  } else {
    format!("{recording_id}-{conversation_id}")
  }
}

/** 会話ごとに安定した workspace path を使う（CLI の resume は cwd を引き継ぐ）。中身は毎回作り直す。 */
fn prepare_workspace(
  data_dir: &Path,
  store: &Store,
  project_id: Option<&str>,
  recording_id: &str,
  conversation_id: &str,
) -> CommandResult<(PathBuf, BTreeMap<String, String>)> {
  prepare_workspace_for(data_dir, store, project_id, recording_id, conversation_id, true)
}

/// `recording` が false（文書ページの会話）のときは、録音の文字起こし・成果物を写さず、空の artifacts/ だけを用意する。
fn prepare_workspace_for(
  data_dir: &Path,
  store: &Store,
  project_id: Option<&str>,
  recording_id: &str,
  conversation_id: &str,
  recording: bool,
) -> CommandResult<(PathBuf, BTreeMap<String, String>)> {
  if let Some(project_id) = project_id {
    safe_id(project_id)?;
  }
  safe_id(recording_id)?;
  safe_id(conversation_id)?;
  let data_dir = data_dir.canonicalize().map_err(|_| stage_error())?;
  let base = data_dir.join("local-ai").join("chat-workspaces");
  fs::create_dir_all(&base).map_err(|_| stage_error())?;
  let canonical_base = base.canonicalize().map_err(|_| stage_error())?;
  if !canonical_base.starts_with(&data_dir) {
    return Err(stage_error());
  }
  let project_dir = canonical_base.join(project_id.unwrap_or(OUTSIDE_WORKSPACE));
  fs::create_dir_all(&project_dir).map_err(|_| stage_error())?;
  if fs::symlink_metadata(&project_dir)
    .map_err(|_| stage_error())?
    .file_type()
    .is_symlink()
  {
    return Err(stage_error());
  }
  let workspace = project_dir.join(workspace_name(recording_id, conversation_id));
  if fs::symlink_metadata(&workspace)
    .map(|meta| meta.file_type().is_symlink() || !meta.is_dir())
    .unwrap_or(false)
  {
    return Err(stage_error());
  }
  if workspace.exists() {
    fs::remove_dir_all(&workspace).map_err(|_| stage_error())?;
  }
  fs::create_dir_all(workspace.join("artifacts")).map_err(|_| stage_error())?;

  let mut baseline = BTreeMap::new();
  if !recording {
    return Ok((workspace, baseline));
  }
  // 工程 1 の文字起こし・文章も工程の文書と同じ artifacts/ に置き、どの提供元でも同じ書ける場所で直せるようにする
  if let Some(transcript) = store.read_transcript_at(project_id, recording_id)? {
    fs::write(
      workspace
        .join("artifacts")
        .join(format!("{}.md", crate::store::SOURCE_STEP_ID)),
      &transcript,
    )
    .map_err(|_| stage_error())?;
    baseline.insert(crate::store::SOURCE_STEP_ID.to_string(), transcript);
  }
  for artifact in store.artifact_states_at(project_id, recording_id)? {
    if !artifact.exists || artifact.step_id == crate::store::SOURCE_STEP_ID {
      continue;
    }
    let Some(markdown) = store.read_artifact_at(project_id, recording_id, &artifact.step_id)? else {
      continue;
    };
    fs::write(
      workspace.join("artifacts").join(format!("{}.md", artifact.step_id)),
      &markdown,
    )
    .map_err(|_| stage_error())?;
    baseline.insert(artifact.step_id, markdown);
  }
  Ok((workspace, baseline))
}

/// API キー方式の会話の履歴の置き場（会話ごとに残す。workspace は依頼ごとに作り直して消すので、そこには置けない）。
/// 履歴が無ければ crate が `SessionNotFound` を返し、画面が資料を添えて送り直す。
/// root の録音は今までどおり `chat-sessions/<projectId>/<conversationId>`、ほかの録音は workspace と同じ
/// `<recordingId>-<conversationId>`。
fn chat_session_dir(
  data_dir: &Path,
  project_id: Option<&str>,
  recording_id: &str,
  conversation_id: &str,
) -> CommandResult<PathBuf> {
  if let Some(project_id) = project_id {
    safe_id(project_id)?;
  }
  safe_id(recording_id)?;
  safe_id(conversation_id)?;
  let data_dir = data_dir.canonicalize().map_err(|_| stage_error())?;
  let base = data_dir.join("local-ai").join("chat-sessions");
  let dir = base
    .join(project_id.unwrap_or(OUTSIDE_WORKSPACE))
    .join(workspace_name(recording_id, conversation_id));
  fs::create_dir_all(&dir).map_err(|_| stage_error())?;
  let project_dir = base.join(project_id.unwrap_or(OUTSIDE_WORKSPACE));
  for path in [&base, &project_dir, &dir] {
    if fs::symlink_metadata(path)
      .map(|meta| meta.file_type().is_symlink() || !meta.is_dir())
      .unwrap_or(true)
    {
      return Err(stage_error());
    }
  }
  let canonical = dir.canonicalize().map_err(|_| stage_error())?;
  if !canonical.starts_with(&data_dir) {
    return Err(stage_error());
  }
  Ok(canonical)
}

/// 録音を消すとき、その会話の履歴（API キー方式が app data の `chat-sessions/` に会話ごとに残す。workspace と違って期限付きの掃除は無い）も
/// 消す。履歴の置き場が無い・リンクのときは何もしない（リンクは辿らず、リンクだけを消す）。
pub fn remove_chat_sessions(
  data_dir: &Path,
  project_id: Option<&str>,
  recording_id: &str,
  conversation_ids: &[String],
) {
  if project_id.is_some_and(|id| safe_id(id).is_err()) || safe_id(recording_id).is_err() {
    return;
  }
  let Ok(data_dir) = data_dir.canonicalize() else {
    return;
  };
  let base = data_dir.join("local-ai").join("chat-sessions");
  let project_dir = base.join(project_id.unwrap_or(OUTSIDE_WORKSPACE));
  if !fs::symlink_metadata(&base).is_ok_and(|meta| meta.is_dir())
    || !fs::symlink_metadata(&project_dir).is_ok_and(|meta| meta.is_dir())
  {
    return;
  }
  for conversation_id in conversation_ids {
    if safe_id(conversation_id).is_err() {
      continue;
    }
    let dir = project_dir.join(workspace_name(recording_id, conversation_id));
    match fs::symlink_metadata(&dir) {
      Ok(meta) if meta.is_dir() => {
        let _ = fs::remove_dir_all(&dir);
      }
      Ok(_) => {
        let _ = fs::remove_file(&dir);
      }
      Err(_) => {}
    }
  }
}

/// 録音ページを別の保存場所へ移した後、旧場所の API 会話再開状態を削除する。
/// 録音内に移動した会話履歴は残るが、移動前の session は再開しない契約。
pub fn move_page_and_clean_sessions(
  store: &Store,
  data_dir: &Path,
  source_project_id: Option<&str>,
  page_id: &str,
  target_project_id: Option<&str>,
  before_page_id: Option<&str>,
) -> Result<Value, StoreError> {
  let cross_location = source_project_id != target_project_id;
  let mut session_recording_id = page_id.to_string();
  let conversation_ids = if cross_location {
    let pages = store.load_pages(source_project_id)?;
    let page = pages
      .pages
      .iter()
      .find(|page| page.get("id").and_then(Value::as_str) == Some(page_id))
      .or_else(|| {
        (page_id == ROOT_RECORDING_ID)
          .then(|| {
            pages.pages.iter().find(|page| {
              page.get("kind").and_then(Value::as_str) == Some("rec")
                && page.get("title").and_then(Value::as_str) == Some("")
                && pages
                  .project
                  .as_ref()
                  .and_then(|project| project.get("createdAt"))
                  .and_then(Value::as_str)
                  .is_some_and(|created_at| page.get("createdAt").and_then(Value::as_str) == Some(created_at))
            })
          })
          .flatten()
      })
      .ok_or_else(|| StoreError {
        code: "store_no_page".into(),
        message: "ページが見つかりません。".into(),
      })?;
    if page.get("kind").and_then(Value::as_str) != Some("rec") {
      Vec::new()
    } else {
      let recording_id = page.get("recordingId").and_then(Value::as_str).unwrap_or(page_id);
      // P1〜P5 の root 会話 workspace は recordingId 分離前の `root` で保存されている。
      // 移行済みの最初の root 録音を動かす場合も、その旧 workspace だけを削除する。
      let legacy_root = page_id == ROOT_RECORDING_ID
        || (pages
          .project
          .as_ref()
          .and_then(|project| project.get("createdAt"))
          .and_then(Value::as_str)
          .is_some_and(|created_at| {
            page.get("title").and_then(Value::as_str) == Some("")
              && page.get("createdAt").and_then(Value::as_str) == Some(created_at)
          }));
      session_recording_id = if legacy_root {
        ROOT_RECORDING_ID.to_string()
      } else {
        recording_id.to_string()
      };
      match store.conversation_ids_at(source_project_id, recording_id) {
        Ok(ids) => ids,
        Err(error) if error.code == "store_no_recording" => Vec::new(),
        Err(error) => return Err(error),
      }
    }
  } else {
    Vec::new()
  };
  let moved = store.move_page_before(source_project_id, page_id, target_project_id, before_page_id)?;
  if cross_location && !conversation_ids.is_empty() {
    remove_chat_sessions(data_dir, source_project_id, &session_recording_id, &conversation_ids);
  }
  Ok(moved)
}

/** workspace にある有効な文書差分だけを返す。CLI が作った他のファイルは正本へ移さない。 */
fn read_workspace_changes(
  workspace: &Path,
  baseline: &BTreeMap<String, String>,
  writable_artifact_id: Option<&str>,
) -> CommandResult<Vec<ChatArtifactChange>> {
  let artifacts = workspace.join("artifacts");
  if fs::symlink_metadata(&artifacts)
    .map(|meta| meta.file_type().is_symlink() || !meta.is_dir())
    .unwrap_or(true)
  {
    return Err(stage_error());
  }
  let mut current = BTreeMap::new();
  for entry in fs::read_dir(&artifacts).map_err(|_| stage_error())? {
    let entry = entry.map_err(|_| stage_error())?;
    let file_type = entry.file_type().map_err(|_| stage_error())?;
    if !file_type.is_file() {
      continue;
    }
    let Some(name) = entry.file_name().to_str().map(str::to_string) else {
      continue;
    };
    let Some(step_id) = name.strip_suffix(".md") else {
      continue;
    };
    if safe_id(step_id).is_err() {
      continue;
    }
    if writable_artifact_id.is_some_and(|allowed| allowed != step_id) {
      continue;
    }
    let markdown = fs::read_to_string(entry.path()).map_err(|_| stage_error())?;
    current.insert(step_id.to_string(), markdown);
  }
  let mut changes = Vec::new();
  for (step_id, markdown) in &current {
    if baseline.get(step_id) != Some(markdown) {
      changes.push(ChatArtifactChange {
        step_id: step_id.clone(),
        markdown: Some(markdown.clone()),
      });
    }
  }
  for step_id in baseline.keys() {
    if writable_artifact_id.is_some_and(|allowed| allowed != step_id) {
      continue;
    }
    if !current.contains_key(step_id) {
      changes.push(ChatArtifactChange {
        step_id: step_id.clone(),
        markdown: None,
      });
    }
  }
  changes.sort_by(|left, right| left.step_id.cmp(&right.step_id));
  Ok(changes)
}

/// composer: 同じ場所の文書ページを artifacts/pages/ に、ほかの録音の成果物を読むだけの reference/ に写し、新しい文書の置き場
/// artifacts/new/ を作る。返すのは文書ページの id → 写した本文（依頼の後に比べる）。
fn prepare_composer(
  workspace: &Path,
  store: &Store,
  project_id: Option<&str>,
  composer: &ComposerWire,
) -> CommandResult<BTreeMap<String, String>> {
  let artifacts = workspace.join(CHAT_WRITABLE_DIR);
  let pages_dir = artifacts.join(COMPOSER_PAGES_DIR);
  fs::create_dir_all(&pages_dir).map_err(|_| stage_error())?;
  fs::create_dir_all(artifacts.join(COMPOSER_NEW_DIR)).map_err(|_| stage_error())?;
  let mut pages = BTreeMap::new();
  for page_id in composer.pages.iter().take(COMPOSER_PAGES_MAX) {
    safe_id(page_id)?;
    if pages.contains_key(page_id) {
      continue;
    }
    let markdown = store.read_page_at(project_id, page_id)?;
    fs::write(pages_dir.join(format!("{page_id}.md")), &markdown).map_err(|_| stage_error())?;
    pages.insert(page_id.clone(), markdown);
  }
  let reference_dir = workspace.join(COMPOSER_REFERENCE_DIR);
  fs::create_dir_all(&reference_dir).map_err(|_| stage_error())?;
  for reference in composer.references.iter().take(COMPOSER_REFERENCES_MAX) {
    safe_id(&reference.page_id)?;
    safe_id(&reference.artifact_id)?;
    let body = if reference.artifact_id == crate::store::SOURCE_STEP_ID {
      store.read_transcript_at(project_id, &reference.page_id)?
    } else {
      store.read_artifact_at(project_id, &reference.page_id, &reference.artifact_id)?
    };
    let Some(body) = body else {
      continue;
    };
    // id は英数字と `-_` だけなので `.` でつないでも一意（作業の行に出るファイル名で録音を取り違えない）
    let file = format!("{}.{}.md", reference.page_id, reference.artifact_id);
    fs::write(reference_dir.join(file), &body).map_err(|_| stage_error())?;
  }
  Ok(pages)
}

/// フォルダの中の普通の `.md` ファイル（名前の順。リンク・フォルダ・大きすぎるファイル・読めない名前は飛ばす）。
fn markdown_files(dir: &Path) -> CommandResult<Vec<(String, String)>> {
  if fs::symlink_metadata(dir)
    .map(|meta| meta.file_type().is_symlink() || !meta.is_dir())
    .unwrap_or(true)
  {
    return Ok(Vec::new());
  }
  let mut files = Vec::new();
  for entry in fs::read_dir(dir).map_err(|_| stage_error())? {
    let entry = entry.map_err(|_| stage_error())?;
    let Ok(meta) = fs::symlink_metadata(entry.path()) else {
      continue;
    };
    if !meta.is_file() || meta.len() > COMPOSER_DOC_MAX_BYTES {
      continue;
    }
    let Some(name) = entry.file_name().to_str().map(str::to_string) else {
      continue;
    };
    if !name.ends_with(".md") || name.starts_with('.') {
      continue;
    }
    let Ok(markdown) = fs::read_to_string(entry.path()) else {
      continue;
    };
    files.push((name, markdown));
  }
  files.sort_by(|left, right| left.0.cmp(&right.0));
  Ok(files)
}

/// composer: 書き換えた文書ページと、新しい文書。artifacts/pages/ は写した文書ページの編集だけを受け取り、見知らぬファイルは
/// 取り込まない（AI が既存の文書を別名に変えたときに複製ページを作らない。新しい文書の置き場は artifacts/new/）。
/// 消した・名前を変えた文書ページは返さない（文書を消す・名前を変える操作は受け付けない）。新しい文書は名前の順に
/// `COMPOSER_NEW_MAX` 件まで。
fn read_composer_changes(
  workspace: &Path,
  baseline: &BTreeMap<String, String>,
) -> CommandResult<(Vec<ChatPageChange>, Vec<ChatNewDocument>)> {
  let artifacts = workspace.join(CHAT_WRITABLE_DIR);
  let mut pages = Vec::new();
  let mut created = Vec::new();
  for (name, markdown) in markdown_files(&artifacts.join(COMPOSER_PAGES_DIR))? {
    let page_id = name.trim_end_matches(".md");
    match baseline.get(page_id) {
      Some(before) if before != &markdown => pages.push(ChatPageChange {
        page_id: page_id.to_string(),
        markdown,
      }),
      Some(_) | None => {}
    }
  }
  for (name, markdown) in markdown_files(&artifacts.join(COMPOSER_NEW_DIR))? {
    created.push(ChatNewDocument { file: name, markdown });
  }
  created.retain(|document| !document.markdown.trim().is_empty());
  created.truncate(COMPOSER_NEW_MAX);
  Ok((pages, created))
}

pub(crate) fn chat_time_limit() -> Duration {
  std::env::var(crate::TURN_TIME_LIMIT_ENV)
    .ok()
    .and_then(|value| value.trim().parse::<u64>().ok())
    .filter(|secs| *secs > 0)
    .map(Duration::from_secs)
    .unwrap_or(CHAT_TURN_TIME_LIMIT)
}

/// 修正の会話を 1 回送る。差分を採取してから最後のイベント（Done / Error）を流す。
#[tauri::command]
pub async fn run_chat_turn(
  state: State<'_, AppState>,
  turn_id: String,
  project_id: Option<String>,
  recording_id: String,
  conversation_id: String,
  request: ChatTurnWire,
  on_event: Channel<Value>,
) -> CommandResult<ChatTurnResult> {
  safe_id(&turn_id)?;
  safe_id(&conversation_id)?;
  if request.system_prompt.len() > MAX_SYSTEM_PROMPT_BYTES || request.user_prompt.len() > MAX_USER_PROMPT_BYTES {
    return Err(CommandError::new("turn_too_large", "送る量が多すぎます。"));
  }
  if let Some(session) = &request.resume_session {
    safe_id(session)?;
  }
  if let Some(artifact_id) = &request.writable_artifact_id {
    safe_id(artifact_id)?;
  }
  // 正本の文書を会話ごとの隔離 workspace へ写す。CLI の直接編集が未版の正本に残らない。
  let store = state.store();
  // 文書ページの会話（composer の recording が false）は、`recording_id` が文書ページの id
  let recording = request.composer.as_ref().is_none_or(|composer| composer.recording);
  if recording {
    store.chat_folder_at(project_id.as_deref(), &recording_id)?;
  } else {
    store.read_page_at(project_id.as_deref(), &recording_id)?;
  }
  let (dir, baseline) = prepare_workspace_for(
    &state.data_dir,
    &store,
    project_id.as_deref(),
    &recording_id,
    &conversation_id,
    recording,
  )?;
  let page_baseline = match &request.composer {
    Some(composer) => prepare_composer(&dir, &store, project_id.as_deref(), composer)?,
    None => BTreeMap::new(),
  };
  // CLI は workspace で動く（claude・codex は会話を cwd ごとに保存する）。API キー方式の workdir は履歴の置き場。
  let workdir = if request.provider.is_api() {
    chat_session_dir(&state.data_dir, project_id.as_deref(), &recording_id, &conversation_id)?
  } else {
    dir.clone()
  };
  let turn = TurnRequest {
    provider: request.provider,
    model: request.model,
    effort: request.effort,
    system_prompt: request.system_prompt,
    user_prompt: request.user_prompt,
    resume_session: request.resume_session,
    workdir,
    timeout: chat_time_limit(),
    max_budget_usd: request.max_budget_usd,
    tool_policy: ToolPolicy::ProjectFolder {
      dir: dir.clone(),
      // 両 provider adapter とも writable は実在するフォルダ prefix を要求する。
      // 正本へ反映する対象は read_workspace_changes で選択成果物だけに限定する。
      writable: vec![CHAT_WRITABLE_DIR.to_string()],
    },
  };
  let (done_sender, done_receiver) = std::sync::mpsc::channel::<(u64, TurnEvent)>();
  let envelope_turn_id = turn_id.clone();
  let terminal_channel = on_event.clone();
  let mut seq: u64 = 0;
  let handle = state.runner.run_turn(
    turn,
    Box::new(move |event| {
      let terminal = event.is_terminal();
      let event_seq = seq;
      seq += 1;
      if terminal {
        let _ = done_sender.send((event_seq, event));
      } else {
        let _ = on_event.send(json!({ "turnId": envelope_turn_id, "seq": event_seq, "event": event.to_wire() }));
      }
    }),
  );
  if let Ok(mut turns) = state.turns.lock() {
    turns.insert(turn_id.clone(), handle);
  }
  let terminal = tauri::async_runtime::spawn_blocking(move || done_receiver.recv()).await;
  if let Ok(mut turns) = state.turns.lock() {
    turns.remove(&turn_id);
  }
  let recording_writable = request
    .composer
    .as_ref()
    .is_none_or(|composer| composer.recording_writable);
  let changes = if recording && recording_writable {
    read_workspace_changes(&dir, &baseline, request.writable_artifact_id.as_deref())
  } else {
    Ok(Vec::new())
  };
  let composer_changes = if request.composer.is_some() {
    read_composer_changes(&dir, &page_baseline)
  } else {
    Ok((Vec::new(), Vec::new()))
  };
  let _ = fs::remove_dir_all(&dir);
  let terminal = terminal
    .map_err(|_| CommandError::new("chat_turn_failed", "依頼を終えられませんでした。"))?
    .map_err(|_| CommandError::new("chat_turn_failed", "依頼を終えられませんでした。"))?;
  let artifacts = changes?;
  let (pages, created) = composer_changes?;
  let (terminal_seq, terminal_event) = terminal;
  let final_event = terminal_event.to_wire();
  let _ = terminal_channel.send(json!({ "turnId": turn_id, "seq": terminal_seq, "event": final_event.clone() }));
  Ok(ChatTurnResult {
    artifacts,
    pages,
    created,
    final_event,
  })
}

/// 工程の文書の状態（mtime・大きさ・SHA-256・最後の版）。依頼の前後に比べる。
#[tauri::command]
pub async fn artifact_states(
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
) -> CommandResult<Vec<ArtifactState>> {
  Ok(state.store().artifact_states_at(project_id.as_deref(), &recording_id)?)
}

/// 工程の文書の今の中身（AI が書き換えた文書を版にするときに読む）。
#[tauri::command]
pub async fn read_artifact(
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
  step_id: String,
) -> CommandResult<Option<String>> {
  Ok(
    state
      .store()
      .read_artifact_at(project_id.as_deref(), &recording_id, &step_id)?,
  )
}

/// 工程の文書を最後の版の中身に戻す（版は足さない）。戻した版の番号を返す。
#[tauri::command]
pub async fn revert_artifact(
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
  step_id: String,
) -> CommandResult<u32> {
  Ok(
    state
      .store()
      .revert_artifact_at(project_id.as_deref(), &recording_id, &step_id)?,
  )
}

/// 録音の会話（新しい順）。
#[tauri::command]
pub async fn list_conversations(
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
) -> CommandResult<Vec<Value>> {
  Ok(
    state
      .store()
      .list_conversations_at(project_id.as_deref(), &recording_id)?,
  )
}

#[tauri::command]
pub async fn save_conversation(
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
  conversation_id: String,
  conversation: Value,
) -> CommandResult<()> {
  Ok(
    state
      .store()
      .save_conversation_at(project_id.as_deref(), &recording_id, &conversation_id, &conversation)?,
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn chat_turn_from_the_web_uses_contract_names_without_a_folder() {
    let request: ChatTurnWire = serde_json::from_value(json!({
      "provider": "ClaudeCode",
      "model": "sonnet",
      "effort": "High",
      "system_prompt": "決まり",
      "user_prompt": "見出しを短くして",
      "resume_session": null,
      "max_budget_usd": null,
    }))
    .unwrap();
    assert_eq!(request.provider, Provider::ClaudeCode);
    assert_eq!(request.effort, Some(Effort::High));
    // 起動フォルダ・ツールの方針は画面から受け取らない（知らない名前は無視する）
    let with_path: ChatTurnWire = serde_json::from_value(json!({
      "provider": "CodexCli", "model": "gpt-5.6-luna", "effort": null, "system_prompt": "", "user_prompt": "x",
      "resume_session": "01a13b6e-21d7-7093-8fc2-637efb0dd571", "max_budget_usd": null,
      "workdir": "/etc", "tool_policy": "none"
    }))
    .unwrap();
    assert_eq!(
      with_path.resume_session.as_deref(),
      Some("01a13b6e-21d7-7093-8fc2-637efb0dd571")
    );
    assert_eq!(CHAT_WRITABLE_DIR, "artifacts");
  }

  fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
      "niho-docs-chat-{name}-{}-{}",
      std::process::id(),
      SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
  }

  fn text_project(store: &Store) -> String {
    let created = store
      .create_project(
        &json!({ "version": 1, "id": "", "name": "会話", "createdAt": "2026-10-16T00:00:00.000Z", "flowSnapshot": { "steps": [] }, "source": { "kind": "text" } }),
        Some("話者A: こんにちは"),
        Some(&json!({ "id": "s1", "kind": "save", "stepId": "source", "stepName": "文章", "result": "saved" })),
        &[],
      )
      .unwrap();
    created["id"].as_str().unwrap().to_string()
  }

  #[test]
  fn composer_request_is_optional_and_reads_pages_and_references() {
    let without: ChatTurnWire = serde_json::from_value(json!({
      "provider": "ClaudeCode", "model": "sonnet", "effort": null, "system_prompt": "", "user_prompt": "x",
      "resume_session": null, "max_budget_usd": null,
    }))
    .unwrap();
    assert!(without.composer.is_none());
    let with: ChatTurnWire = serde_json::from_value(json!({
      "provider": "ClaudeCode", "model": "sonnet", "effort": null, "system_prompt": "", "user_prompt": "x",
      "resume_session": null, "max_budget_usd": null, "writable_artifact_id": null,
      "composer": { "recording": false, "pages": ["pg1"], "references": [{ "page_id": "rec1", "artifact_id": "s1" }] }
    }))
    .unwrap();
    let composer = with.composer.unwrap();
    assert!(!composer.recording);
    assert_eq!(composer.pages, vec!["pg1"]);
    assert_eq!(composer.references[0].page_id, "rec1");
    assert_eq!(composer.references[0].artifact_id, "s1");
    // 無ければ録音の文書を直せる。複数案で案を開いていない録音ページは false（読むだけ）
    assert!(composer.recording_writable);
    let read_only: ComposerWire = serde_json::from_value(json!({
      "recording": true, "pages": [], "references": [], "recording_writable": false
    }))
    .unwrap();
    assert!(!read_only.recording_writable);
  }

  #[test]
  fn composer_stages_place_documents_and_returns_page_edits_and_new_documents() {
    let root = temp_dir("composer-root");
    let data = temp_dir("composer-data");
    let store = Store::new(root.clone());
    let id = text_project(&store);
    store.chat_folder(&id, ROOT_RECORDING_ID).unwrap();
    let run = json!({ "id": "r1", "kind": "run", "stepId": "k7m2q9xa", "stepName": "議事録", "result": "saved" });
    store
      .save_artifact(&id, ROOT_RECORDING_ID, "k7m2q9xa", false, "# 議事録", &run)
      .unwrap();
    let page = store.create_page_at(Some(&id), "doc", "事前メモ", "", None).unwrap()["id"]
      .as_str()
      .unwrap()
      .to_string();
    store.write_page_at(Some(&id), &page, "# 事前メモ\n\n問い 1").unwrap();

    // 文書ページの会話: 録音の文書は写さず、文書ページ・読むだけの成果物・新しい文書の置き場だけ
    let (workspace, baseline) = prepare_workspace_for(&data, &store, Some(&id), &page, "c2", false).unwrap();
    assert!(baseline.is_empty());
    assert!(!workspace.join("artifacts").join("source.md").exists());
    let composer = ComposerWire {
      recording: false,
      pages: vec![page.clone()],
      references: vec![ComposerReferenceWire {
        page_id: ROOT_RECORDING_ID.to_string(),
        artifact_id: "k7m2q9xa".to_string(),
      }],
      recording_writable: true,
    };
    let pages = prepare_composer(&workspace, &store, Some(&id), &composer).unwrap();
    assert_eq!(
      fs::read_to_string(workspace.join("artifacts/pages").join(format!("{page}.md"))).unwrap(),
      "# 事前メモ\n\n問い 1"
    );
    assert_eq!(
      fs::read_to_string(
        workspace
          .join("reference")
          .join(format!("{ROOT_RECORDING_ID}.k7m2q9xa.md"))
      )
      .unwrap(),
      "# 議事録"
    );
    assert!(workspace.join("artifacts/new").is_dir());
    assert_eq!(
      read_composer_changes(&workspace, &pages).unwrap(),
      (Vec::new(), Vec::new())
    );

    // AI が文書ページを直し、新しい文書を 2 つ作り、読むだけの成果物も書き換え、文書ページを 1 つ消した
    fs::write(
      workspace.join("artifacts/pages").join(format!("{page}.md")),
      "# 事前メモ\n\n問い 1・2",
    )
    .unwrap();
    fs::write(workspace.join("artifacts/new/english.md"), "# Memo\n\nQ1").unwrap();
    fs::write(workspace.join("artifacts/new/empty.md"), " \n").unwrap();
    fs::write(workspace.join("artifacts/pages/unknown.md"), "# 別の文書").unwrap();
    fs::write(workspace.join("artifacts/new/notes.txt"), "x").unwrap();
    fs::write(
      workspace
        .join("reference")
        .join(format!("{ROOT_RECORDING_ID}.k7m2q9xa.md")),
      "書き換え",
    )
    .unwrap();
    let (edited, created) = read_composer_changes(&workspace, &pages).unwrap();
    assert_eq!(
      edited,
      vec![ChatPageChange {
        page_id: page.clone(),
        markdown: "# 事前メモ\n\n問い 1・2".to_string()
      }]
    );
    // 新しい文書は artifacts/new/ のものだけ。pages/ に足された見知らぬファイル（既存の文書の別名など）・空の文書・
    // .md でないファイルは受け取らない
    assert_eq!(
      created,
      vec![ChatNewDocument {
        file: "english.md".to_string(),
        markdown: "# Memo\n\nQ1".to_string()
      }]
    );
    // 消された文書ページは返さない
    fs::remove_file(workspace.join("artifacts/pages").join(format!("{page}.md"))).unwrap();
    assert!(read_composer_changes(&workspace, &pages).unwrap().0.is_empty());
    let _ = fs::remove_dir_all(root);
    let _ = fs::remove_dir_all(data);
  }

  #[test]
  fn workspace_puts_the_transcript_beside_the_documents_and_returns_its_changes() {
    let root = temp_dir("root");
    let data = temp_dir("data");
    let store = Store::new(root.clone());
    let id = text_project(&store);
    store.chat_folder(&id, ROOT_RECORDING_ID).unwrap();
    let run = json!({ "id": "r1", "kind": "run", "stepId": "k7m2q9xa", "stepName": "議事録", "result": "saved" });
    store
      .save_artifact(&id, ROOT_RECORDING_ID, "k7m2q9xa", false, "# 議事録", &run)
      .unwrap();

    let (workspace, baseline) = prepare_workspace(&data, &store, Some(&id), ROOT_RECORDING_ID, "c1").unwrap();
    assert!(workspace.starts_with(data.canonicalize().unwrap()));
    // 文字起こし・文章は artifacts/source.md（workspace の直下には置かない）
    assert_eq!(
      fs::read_to_string(workspace.join("artifacts").join("source.md")).unwrap(),
      "話者A: こんにちは"
    );
    assert!(!workspace.join("transcript.md").exists());
    assert_eq!(baseline.keys().collect::<Vec<_>>(), vec!["k7m2q9xa", "source"]);
    // 変わらなければ差分は無い
    assert!(read_workspace_changes(&workspace, &baseline, None).unwrap().is_empty());

    // AI が文字起こしと文書を書き換え、ほかの場所にもファイルを作った
    fs::write(
      workspace.join("artifacts").join("source.md"),
      "話者A（山田）: こんにちは",
    )
    .unwrap();
    fs::write(workspace.join("artifacts").join("k7m2q9xa.md"), "# 議事録（短く）").unwrap();
    fs::write(workspace.join("project.json"), "{}").unwrap();
    fs::write(workspace.join("artifacts").join("notes.txt"), "x").unwrap();
    let changes = read_workspace_changes(&workspace, &baseline, None).unwrap();
    let changed: Vec<(&str, Option<&str>)> = changes
      .iter()
      .map(|change| (change.step_id.as_str(), change.markdown.as_deref()))
      .collect();
    assert_eq!(
      changed,
      vec![
        ("k7m2q9xa", Some("# 議事録（短く）")),
        ("source", Some("話者A（山田）: こんにちは"))
      ]
    );
    // provider には artifacts/ フォルダを書ける形で渡すが、正本へ返すのは選択した成果物だけ。
    // 兄弟案を同時に書き換えたり消したりしても、候補境界の外は差分として返さない。
    let selected = read_workspace_changes(&workspace, &baseline, Some("k7m2q9xa")).unwrap();
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].step_id, "k7m2q9xa");
    assert_eq!(selected[0].markdown.as_deref(), Some("# 議事録（短く）"));
    // 消された文字起こしは削除として返す（画面が正本に反映せず知らせる）
    fs::remove_file(workspace.join("artifacts").join("source.md")).unwrap();
    let removed = read_workspace_changes(&workspace, &baseline, None).unwrap();
    assert!(removed
      .iter()
      .any(|change| change.step_id == "source" && change.markdown.is_none()));

    // 次の依頼で workspace は正本から作り直す
    let (again, _) = prepare_workspace(&data, &store, Some(&id), ROOT_RECORDING_ID, "c1").unwrap();
    assert_eq!(again, workspace);
    assert_eq!(
      fs::read_to_string(again.join("artifacts").join("source.md")).unwrap(),
      "話者A: こんにちは"
    );
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&data);
  }

  #[test]
  fn api_history_stays_per_conversation_outside_the_workspace() {
    let data = temp_dir("sessions");
    let dir = chat_session_dir(&data, Some("p1"), ROOT_RECORDING_ID, "c1").unwrap();
    assert!(dir.ends_with("local-ai/chat-sessions/p1/c1"));
    // root 以外の録音は録音の id を前に付ける（workspace と同じ名前）
    assert!(chat_session_dir(&data, Some("p1"), "k7m2q9xa3b", "c1")
      .unwrap()
      .ends_with("local-ai/chat-sessions/p1/k7m2q9xa3b-c1"));
    fs::write(dir.join("api-session-x.json"), "{}").unwrap();
    // 2 回目も同じ場所で、中身は残る
    assert_eq!(
      chat_session_dir(&data, Some("p1"), ROOT_RECORDING_ID, "c1").unwrap(),
      dir
    );
    assert!(dir.join("api-session-x.json").is_file());
    // id でないものは断る
    assert!(chat_session_dir(&data, Some("../p1"), ROOT_RECORDING_ID, "c1").is_err());
    assert!(chat_session_dir(&data, Some("p1"), ROOT_RECORDING_ID, "c/1").is_err());
    assert!(chat_session_dir(&data, Some("p1"), "r/1", "c1").is_err());
    // リンクに差し替えられた会話のフォルダは使わない
    let outside = temp_dir("outside");
    fs::remove_dir_all(&dir).unwrap();
    std::os::unix::fs::symlink(&outside, &dir).unwrap();
    assert!(chat_session_dir(&data, Some("p1"), ROOT_RECORDING_ID, "c1").is_err());
    let _ = fs::remove_dir_all(&data);
    let _ = fs::remove_dir_all(&outside);
  }

  #[test]
  fn outside_recordings_use_the_reserved_internal_workspace_only() {
    let root = temp_dir("outside-root");
    let data = temp_dir("outside-data");
    let store = Store::new(root.clone());
    let page = store
      .create_page_at(
        None,
        "rec",
        "",
        "2026-10-16T00:00:00.000Z",
        Some(&json!({
          "version": 1, "id": "", "createdAt": "2026-10-16T00:00:00.000Z",
          "flowSnapshot": { "steps": [] }, "source": { "kind": "audio", "audio": [] }
        })),
      )
      .unwrap();
    let recording_id = page["id"].as_str().unwrap();
    store
      .set_recording_text_at(
        None,
        recording_id,
        "外の文章",
        &json!({ "id": "s1", "kind": "save", "stepId": "source", "stepName": "文章", "result": "saved" }),
      )
      .unwrap();

    let (workspace, baseline) = prepare_workspace(&data, &store, None, recording_id, "c1").unwrap();
    assert!(workspace.ends_with(format!("local-ai/chat-workspaces/_outside/{recording_id}-c1")));
    assert_eq!(baseline.get("source").map(String::as_str), Some("外の文章"));
    assert!(chat_session_dir(&data, None, recording_id, "c1")
      .unwrap()
      .ends_with(format!("local-ai/chat-sessions/_outside/{recording_id}-c1")));
    assert!(!root.join("projects/_outside").exists());
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&data);
  }

  #[test]
  fn deleting_a_recording_removes_only_its_api_conversation_histories() {
    let data = temp_dir("sessions-delete");
    let first = chat_session_dir(&data, Some("p1"), "k7m2q9xa3b", "c1").unwrap();
    let second = chat_session_dir(&data, Some("p1"), "k7m2q9xa3b", "c2").unwrap();
    let other = chat_session_dir(&data, Some("p1"), "m3n4p5q6r7", "c1").unwrap();
    let root = chat_session_dir(&data, Some("p1"), ROOT_RECORDING_ID, "c1").unwrap();
    fs::write(first.join("api-session-x.json"), "{}").unwrap();
    let ids = ["c1".to_string(), "c2".to_string(), "c9".to_string()];
    remove_chat_sessions(&data, Some("p1"), "k7m2q9xa3b", &ids);
    // その録音の会話だけ消える（ほかの録音・root の同じ会話 id は残る。履歴の無い会話があっても落ちない）
    assert!(!first.exists());
    assert!(!second.exists());
    assert!(other.is_dir());
    assert!(root.is_dir());
    // root の録音は会話の id そのものの名前
    remove_chat_sessions(&data, Some("p1"), ROOT_RECORDING_ID, &["c1".to_string()]);
    assert!(!root.exists());
    assert!(other.is_dir());
    // 履歴の置き場が無い案件・id でないものは何もしない
    remove_chat_sessions(&data, Some("p-none"), "k7m2q9xa3b", &["c1".to_string()]);
    remove_chat_sessions(&data, Some("../p1"), "m3n4p5q6r7", &["c1".to_string()]);
    remove_chat_sessions(&data, Some("p1"), "m3n4p5q6r7", &["../c1".to_string()]);
    assert!(other.is_dir());
    // リンクに差し替えられた履歴はリンクだけを消し、先は残す
    let outside = temp_dir("sessions-delete-outside");
    fs::write(outside.join("keep.txt"), "x").unwrap();
    fs::remove_dir_all(&other).unwrap();
    std::os::unix::fs::symlink(&outside, &other).unwrap();
    remove_chat_sessions(&data, Some("p1"), "m3n4p5q6r7", &["c1".to_string()]);
    assert!(fs::symlink_metadata(&other).is_err());
    assert!(outside.join("keep.txt").is_file());
    let _ = fs::remove_dir_all(&data);
    let _ = fs::remove_dir_all(&outside);
  }

  #[test]
  fn moving_a_recording_removes_old_api_sessions_and_keeps_the_conversation_file() {
    let root = temp_dir("move-sessions-root");
    let data = temp_dir("move-sessions-data");
    let store = Store::new(root.clone());
    let source = text_project(&store);
    let target = store
      .create_project(
        &json!({ "version": 1, "id": "", "name": "移動先", "createdAt": "2026-10-16T00:00:00.000Z", "info": { "terms": [], "background": "" }, "pages": [] }),
        None,
        None,
        &[],
      )
      .unwrap()["id"]
      .as_str()
      .unwrap()
      .to_string();
    store
      .save_conversation_at(
        Some(&source),
        ROOT_RECORDING_ID,
        "c1",
        &json!({ "id": "c1", "locationGeneration": 0, "turns": [] }),
      )
      .unwrap();
    let old_session = chat_session_dir(&data, Some(&source), ROOT_RECORDING_ID, "c1").unwrap();
    let unrelated_session = chat_session_dir(&data, Some(&source), ROOT_RECORDING_ID, "c2").unwrap();
    fs::write(old_session.join("api-session-x.json"), "{} ").unwrap();
    fs::write(unrelated_session.join("api-session-x.json"), "{} ").unwrap();

    let moved =
      move_page_and_clean_sessions(&store, &data, Some(&source), ROOT_RECORDING_ID, Some(&target), None).unwrap();
    let moved_id = moved["id"].as_str().unwrap();

    assert!(!old_session.exists());
    assert!(unrelated_session.is_dir());
    assert_eq!(
      store
        .list_conversations_at(Some(&target), moved_id)
        .unwrap()
        .iter()
        .map(|conversation| conversation["id"].as_str().unwrap())
        .collect::<Vec<_>>(),
      vec!["c1"]
    );
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&data);
  }

  #[test]
  fn root_conversations_keep_their_workspace_and_other_recordings_get_their_own() {
    // root（今の案件）は既存の会話の resume と同じ cwd。ほかの録音は録音の id を前に付ける（2 階層のまま）
    assert_eq!(workspace_name("root", "conv-a"), "conv-a");
    assert_eq!(workspace_name("k7m2q9xa3b", "conv-a"), "k7m2q9xa3b-conv-a");
  }
}
