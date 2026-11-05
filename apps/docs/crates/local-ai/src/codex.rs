//! Codex CLI（`codex exec --json`）の起動引数と出力（JSONL）の読み取り。
//!
//! - 本人の設定・ルール・AGENTS.md を読ませず（`--ignore-user-config`・`--ignore-rules`・`project_doc_max_bytes=0`）、
//!   読み取り専用の sandbox で、シェル・MCP・Web 検索などの機能を全部切る。切る機能は**版に依らず**決める: 起動の直前に
//!   `codex features list` を読み、今の版で有効な機能を全部（修正の会話の `code_mode_host` だけ残して）、crate が知っている
//!   一覧（`DISABLED_FEATURES`）と合わせて `-c features.<名前>=false` で切る。新しい版の機能（0.163.0 の `remote_plugin`
//!   ＝アカウントの remote plugin の同期など）も、名前を知らなくても切れる。`--disable=<名前>` は知らない名前で CLI が
//!   起動しない（Unknown feature flag）が、`-c features.<名前>=false` は知らない名前でも起動するので、古い版でも同じ形で渡せる。
//!   一覧を読めなければ起動しない（fail closed）。
//! - システムプロンプトは 0600 のファイルに書き、`-c model_instructions_file="<path>"` で Codex の既定の指示ごと置き換える
//!   （0.154.0 は `-c base_instructions` を無視して既定の指示のままだった。#18383）。指示は標準入力。
//! - codex が既定で足す指示も切る: スキルの一覧（`~/.agents/skills` と同梱のスキル。`skills.include_instructions=false`）、
//!   ツール無しの工程では権限・環境（cwd・日付）・協調モード・アプリの指示も。利用者の `$CODEX_HOME/AGENTS.md` は外す設定が
//!   無いので、呼び出し側が専用の `CODEX_HOME`（`Runtime.codex_home`）を渡す（`codex debug prompt-input` で確かめた）。
//! - それでもツールの item（command_execution・file_change・mcp_tool_call・web_search・知らない type）が来たら止める
//!   （fail closed）。
//! - 修正の会話（`ToolPolicy::ProjectFolder`）だけは、許可した書き込みフォルダだけを作業の root（`-C`・cwd）にして
//!   `--sandbox workspace-write`（/tmp と $TMPDIR は書けない設定）で動かし、apply_patch（file_change）だけを通す。
//!   apply_patch は code mode の中にあるので code_mode_host だけは切らない（シェル・exec_command は切ったまま。
//!   code mode の JS は fs もネットワークも持たない。0.154.0 で確認）。file_change は `ToolUse`・`ToolResult`
//!   （ファイル名と成否）で流し、書ける場所の外のパスが出たら止める（sandbox が先に断る想定の、もう一段の守り）。

use crate::classify::{classify_codex_failure, error_event};
use crate::claude::file_name_only;
use crate::process::{is_uuid, run_capture, run_child, PrivateDir, TURN_DIR_PREFIX};
use crate::turn::{Breach, FolderAccess, StreamHandler, TurnCtx};
use crate::types::{Effort, Provider, ReasonCode, StopReason, TurnEvent, Usage};
use serde_json::Value;
use std::collections::HashSet;
use std::fmt::Write as _;
use std::path::Path;

/// crate が知っている、いつも切る機能（0.154.0 の features の一覧から、文を書くのに要らないものを全部）。実際に切るのは、
/// これに `codex features list` で今の版に有効な機能を全部足したもの（[`features_off`]）。
pub(crate) const DISABLED_FEATURES: [&str; 18] = [
  "shell_tool",
  "unified_exec",
  "code_mode_host",
  "apps",
  "plugins",
  "image_generation",
  "goals",
  "multi_agent",
  "view_image",
  "tool_suggest",
  "browser_use",
  "computer_use",
  "in_app_browser",
  "skill_search",
  "sleep_tool",
  "hooks",
  "workspace_dependencies",
  "skill_mcp_dependency_install",
];

/// `codex features list` を待つ時間・残す出力の大きさ・読む機能の数の上限。
const FEATURES_TIME_LIMIT: std::time::Duration = std::time::Duration::from_secs(15);
const FEATURES_OUTPUT_MAX_BYTES: usize = 256 * 1024;
const MAX_FEATURES: usize = 512;
const FEATURES_UNREADABLE_MESSAGE: &str =
  "Codex CLI の機能の一覧を読めなかったため、止めました。Codex CLI を更新してから、もう一度試してください。";

/// 機能の名前の形（設定のキー `features.<名前>` に使うので、英小文字で始まる英小文字・数字・`_` の 64 文字までだけ）。
fn is_feature_name(name: &str) -> bool {
  name.len() <= 64
    && name.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
    && name
      .bytes()
      .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

/// `codex features list` の出力から、今の版で有効な機能の名前を取る（行は「名前 段階 有効」。段階は 2 語のこともある）。
/// 形の合う行が 1 つも無い・多すぎるときは None（一覧を読めなかったとして起動しない）。
pub(crate) fn enabled_features(list: &str) -> Option<Vec<String>> {
  let mut rows = 0usize;
  let mut enabled = Vec::new();
  for line in list.lines() {
    let words: Vec<&str> = line.split_whitespace().collect();
    let (Some(name), Some(state)) = (words.first(), words.last()) else {
      continue;
    };
    if words.len() < 2 || !is_feature_name(name) || !matches!(*state, "true" | "false") {
      continue;
    }
    rows += 1;
    if *state == "true" {
      enabled.push((*name).to_string());
    }
  }
  (rows > 0 && rows <= MAX_FEATURES).then_some(enabled)
}

/// 切る機能（名前の順）: crate が知っている一覧と、今の版で有効な機能の全部。修正の会話（`folder`）だけ、apply_patch の
/// ある `code_mode_host` を残す。
pub(crate) fn features_off(enabled: &[String], folder: bool) -> Vec<String> {
  let mut off: std::collections::BTreeSet<String> =
    DISABLED_FEATURES.iter().map(|feature| feature.to_string()).collect();
  off.extend(enabled.iter().filter(|feature| is_feature_name(feature)).cloned());
  if folder {
    off.remove(PROJECT_FOLDER_KEPT_FEATURE);
  }
  off.into_iter().collect()
}

/// 引数の合計の上限。macOS の ARG_MAX（1MiB。環境変数も含む）を超えると起動できないので、その手前で断る。
const MAX_ARGV_BYTES: usize = 768 * 1024;
const MAX_FAILURE_ERROR_EVENTS: usize = 32;
const MAX_FAILURE_ERROR_BYTES: usize = 2048;

const TOOL_USE_MESSAGE: &str =
  "Codex CLI がツールを使おうとしたため止めました。Codex CLI を最新に更新してから、もう一度試してください。";
const OUTSIDE_WRITE_MESSAGE: &str =
  "Codex CLI が許可した文書フォルダの外に書こうとしたため止めました。もう一度試してください。";
/// 修正の会話で切らない機能（apply_patch は code mode の中にある）。
const PROJECT_FOLDER_KEPT_FEATURE: &str = "code_mode_host";
/// システムプロンプトのファイル（その回だけの 0700 のフォルダの中・0600）。
const INSTRUCTIONS_FILE: &str = "instructions.md";
/// ツール無しの工程で、codex が既定で足す指示を切る設定（0.154.0。どれも `-c` で渡す）。
/// スキルの一覧・権限と sandbox の説明・環境（cwd・日付・時刻）・協調モード・アプリの説明。
pub(crate) const QUIET_CONFIG: [&str; 5] = [
  "skills.include_instructions=false",
  "include_permissions_instructions=false",
  "include_environment_context=false",
  "include_collaboration_mode_instructions=false",
  "include_apps_instructions=false",
];
/// 修正の会話（workspace-write で apply_patch を使う）では、権限（書ける場所）と環境（cwd）の説明は残し、スキルの一覧と
/// アプリの説明だけを切る。
pub(crate) const QUIET_CONFIG_FOR_FOLDER: [&str; 2] =
  ["skills.include_instructions=false", "include_apps_instructions=false"];

/// TOML の basic string（`"` で囲む）。`\` と `"` と制御文字をエスケープし、それ以外（日本語を含む）はそのまま。
pub(crate) fn toml_basic_string(value: &str) -> String {
  let mut out = String::with_capacity(value.len() + 2);
  out.push('"');
  for ch in value.chars() {
    match ch {
      '\\' => out.push_str("\\\\"),
      '"' => out.push_str("\\\""),
      '\n' => out.push_str("\\n"),
      '\t' => out.push_str("\\t"),
      '\r' => out.push_str("\\r"),
      '\u{8}' => out.push_str("\\b"),
      '\u{c}' => out.push_str("\\f"),
      ch if (ch as u32) < 0x20 || ch == '\u{7f}' => {
        let _ = write!(out, "\\u{:04X}", ch as u32);
      }
      ch => out.push(ch),
    }
  }
  out.push('"');
  out
}

/// `codex` の引数。新しい会話は `exec`、続きは `exec resume <id>`（resume には --sandbox・-C が無いので -c で渡し、
/// cwd で作業の root を決める）。プロンプトは標準入力だけで渡す（位置引数も `-` も付けない）。
/// `folder` があれば（修正の会話）workspace-write の sandbox で許可した書き込みフォルダだけを root にし、無ければ read-only。
/// `instructions` はシステムプロンプトのファイル（無ければ Codex の既定の指示のまま。空のシステムプロンプト）。
/// `off` は切る機能（[`features_off`]）。`-c features.<名前>=false` で渡す（知らない名前でも CLI は起動する）。
pub(crate) fn build_args(
  model: &str,
  effort: Option<Effort>,
  instructions: Option<&Path>,
  resume: Option<&str>,
  folder: Option<&FolderAccess>,
  off: &[String],
) -> Vec<String> {
  let sandbox = if folder.is_some() {
    "workspace-write"
  } else {
    "read-only"
  };
  let mut args: Vec<String> = Vec::new();
  match resume {
    Some(id) => {
      args.extend(["exec", "resume", id, "--json", "-c"].iter().map(|v| v.to_string()));
      args.push(format!("sandbox_mode=\"{sandbox}\""));
    }
    None => {
      args.extend(["exec", "--json", "--sandbox", sandbox].iter().map(|v| v.to_string()));
      if let Some(folder) = folder {
        args.push("-C".to_string());
        args.push(
          folder
            .codex_workspace()
            .expect("Codex ProjectFolder is validated to one writable root")
            .to_string_lossy()
            .into_owned(),
        );
      }
    }
  }
  args.extend(
    ["--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"]
      .iter()
      .map(|v| v.to_string()),
  );
  for feature in off {
    args.push("-c".to_string());
    args.push(format!("features.{feature}=false"));
  }
  args.extend(
    ["-c", "web_search=\"disabled\"", "-c", "project_doc_max_bytes=0"]
      .iter()
      .map(|v| v.to_string()),
  );
  if folder.is_some() {
    // workspace-write は既定で /tmp と $TMPDIR にも書けるので、許可した writable root だけにする
    args.extend(
      [
        "-c",
        "sandbox_workspace_write.exclude_slash_tmp=true",
        "-c",
        "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      ]
      .iter()
      .map(|v| v.to_string()),
    );
  }
  let quiet: &[&str] = if folder.is_some() {
    &QUIET_CONFIG_FOR_FOLDER
  } else {
    &QUIET_CONFIG
  };
  for setting in quiet {
    args.push("-c".to_string());
    args.push(setting.to_string());
  }
  if let Some(path) = instructions {
    args.push("-c".to_string());
    args.push(format!(
      "model_instructions_file={}",
      toml_basic_string(&path.to_string_lossy())
    ));
  }
  args.push("-m".to_string());
  args.push(model.to_string());
  if let Some(effort) = effort {
    args.push("-c".to_string());
    args.push(format!("model_reasoning_effort=\"{}\"", effort.as_str()));
  }
  args
}

enum Terminal {
  Completed(Usage),
  Failed(String),
}

/// JSONL → `TurnEvent`。
pub(crate) struct CodexConverter {
  /// 修正の会話の作業フォルダ（あれば file_change を通す）
  folder: Option<FolderAccess>,
  /// 知らせた file_change（item の ID と変更の番号）
  announced: HashSet<String>,
  finished: HashSet<String>,
  /// 続きのときの resume の ID（thread.started が来なかったときに使う）
  resume_session: Option<String>,
  thread_id: Option<String>,
  /// Done.text は最後の agent_message（複数あれば最後のもの）
  last_agent_message: Option<String>,
  terminal: Option<Terminal>,
  /// `{"type":"error"}`（Reconnecting… など。終わりではない）
  errors: Vec<String>,
  warnings: Vec<String>,
  breach: Option<Breach>,
}

impl CodexConverter {
  pub(crate) fn new(resume_session: Option<String>) -> Self {
    Self {
      folder: None,
      announced: HashSet::new(),
      finished: HashSet::new(),
      resume_session,
      thread_id: None,
      last_agent_message: None,
      terminal: None,
      errors: Vec::new(),
      warnings: Vec::new(),
      breach: None,
    }
  }

  /// 修正の会話（許可した workspace root の apply_patch を通す）の出力を読む。
  pub(crate) fn with_folder(resume_session: Option<String>, folder: FolderAccess) -> Self {
    Self {
      folder: Some(folder),
      ..Self::new(resume_session)
    }
  }

  fn session_id(&self) -> Option<String> {
    self.thread_id.clone().or_else(|| self.resume_session.clone())
  }

  /// file_change（apply_patch）を `ToolUse`・`ToolResult` にする。変更 1 つが 1 組（ID は item の ID と番号）。
  /// 書ける場所の外のパスがあれば止める。
  fn handle_file_change(&mut self, completed: bool, item: &Value, events: &mut Vec<TurnEvent>) {
    let Some(folder) = &self.folder else {
      return;
    };
    let item_id = item.get("id").and_then(Value::as_str).unwrap_or("item");
    let ok = item.get("status").and_then(Value::as_str) == Some("completed");
    let changes = item
      .get("changes")
      .and_then(Value::as_array)
      .cloned()
      .unwrap_or_default();
    let mut pending = Vec::new();
    for (index, change) in changes.iter().enumerate() {
      let path = change.get("path").and_then(Value::as_str).unwrap_or("");
      if !folder.permits_codex_write(path) {
        self.breach = Some(Breach {
          kind: "file_change_outside".to_string(),
          code: ReasonCode::NotConfigured,
          message: OUTSIDE_WRITE_MESSAGE.to_string(),
        });
        return;
      }
      let name = match change.get("kind").and_then(Value::as_str) {
        Some("add") => "Write",
        Some("delete") => "Delete",
        _ => "Edit",
      };
      pending.push((format!("{item_id}:{index}"), name, file_name_only(path)));
    }
    for (id, name, summary) in pending {
      if self.announced.insert(id.clone()) {
        events.push(TurnEvent::ToolUse {
          id: id.clone(),
          name: name.to_string(),
          summary,
        });
      }
      if completed && self.finished.insert(id.clone()) {
        events.push(TurnEvent::ToolResult {
          id,
          name: name.to_string(),
          ok,
        });
      }
    }
  }

  fn handle_item(&mut self, phase: &str, item: &Value, events: &mut Vec<TurnEvent>) {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
    let completed = phase == "item.completed";
    match item_type {
      "agent_message" => {
        if completed {
          let text = item.get("text").and_then(Value::as_str).unwrap_or("").to_string();
          if !text.is_empty() {
            events.push(TurnEvent::TextDelta(text.clone()));
          }
          self.last_agent_message = Some(text);
        }
      }
      "reasoning" => {
        if let Some(text) = item
          .get("text")
          .and_then(Value::as_str)
          .filter(|text| completed && !text.is_empty())
        {
          events.push(TurnEvent::ThinkingDelta(text.to_string()));
        }
      }
      // 例「Model metadata for `x` not found…」「Code Mode is unavailable because code-mode host is disabled…」
      "error" => {
        if completed {
          let message = item.get("message").and_then(Value::as_str).unwrap_or("");
          self.warnings.push(message.to_string());
        }
      }
      "todo_list" | "user_message" => {}
      "file_change" if self.folder.is_some() => self.handle_file_change(completed, item, events),
      // command_execution・file_change・mcp_tool_call・web_search・知らない type
      other => {
        let kind = if other.is_empty() { "unknown" } else { other };
        self.breach = Some(Breach {
          kind: kind.to_string(),
          code: ReasonCode::NotConfigured,
          message: TOOL_USE_MESSAGE.to_string(),
        });
      }
    }
  }

  fn failure_text(&self, primary: Option<&str>, stderr: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if let Some(primary) = primary {
      parts.push(primary);
    }
    parts.extend(self.errors.iter().map(String::as_str));
    parts.push(stderr);
    parts.join("\n")
  }

  fn push_error(&mut self, message: &str) {
    if self.errors.len() >= MAX_FAILURE_ERROR_EVENTS {
      return;
    }
    let mut message = message.to_string();
    if message.len() > MAX_FAILURE_ERROR_BYTES {
      let mut end = MAX_FAILURE_ERROR_BYTES;
      while !message.is_char_boundary(end) {
        end -= 1;
      }
      message.truncate(end);
    }
    self.errors.push(message);
  }
}

impl StreamHandler for CodexConverter {
  fn process_line(&mut self, line: &str) -> Vec<TurnEvent> {
    let mut events = Vec::new();
    let trimmed = line.trim();
    if trimmed.is_empty() || self.breach.is_some() {
      return events;
    }
    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
      return events;
    };
    match value.get("type").and_then(Value::as_str) {
      Some("thread.started") => {
        // 続きは --resume と同じく UUID の形だけを受けるので、それ以外は返さない
        if let Some(id) = value.get("thread_id").and_then(Value::as_str).filter(|id| is_uuid(id)) {
          self.thread_id = Some(id.to_string());
        }
      }
      Some(phase @ ("item.started" | "item.updated" | "item.completed")) => {
        if let Some(item) = value.get("item") {
          self.handle_item(phase, item, &mut events);
        }
      }
      Some("error") => {
        let message = value.get("message").and_then(Value::as_str).unwrap_or("");
        self.push_error(message);
      }
      Some("turn.completed") => {
        let usage = value.get("usage");
        let field = |key: &str| {
          usage
            .and_then(|usage| usage.get(key))
            .and_then(Value::as_u64)
            .unwrap_or(0)
        };
        self.terminal = Some(Terminal::Completed(Usage {
          input_tokens: field("input_tokens"),
          output_tokens: field("output_tokens"),
          cost_usd: None,
          model_used: None,
        }));
      }
      Some("turn.failed") => {
        let message = value
          .get("error")
          .and_then(|error| error.get("message"))
          .and_then(Value::as_str)
          .unwrap_or("");
        self.terminal = Some(Terminal::Failed(message.to_string()));
      }
      _ => {}
    }
    if self.breach.is_some() {
      return Vec::new();
    }
    events
  }

  fn breach(&self) -> Option<&Breach> {
    self.breach.as_ref()
  }

  fn take_warnings(&mut self) -> Vec<String> {
    std::mem::take(&mut self.warnings)
  }

  fn stopped(&self, elapsed_ms: u64) -> TurnEvent {
    let usage = match &self.terminal {
      Some(Terminal::Completed(usage)) => usage.clone(),
      _ => Usage::default(),
    };
    TurnEvent::Done {
      text: self.last_agent_message.as_deref().unwrap_or("").trim().to_string(),
      stop_reason: StopReason::Stopped,
      session_id: self.session_id(),
      usage,
      duration_ms: elapsed_ms,
      continuations: 0,
    }
  }

  fn conclude(&self, stderr: &str, elapsed_ms: u64) -> TurnEvent {
    let provider = Provider::CodexCli;
    let (code, message) = match &self.terminal {
      Some(Terminal::Completed(usage)) => {
        return TurnEvent::Done {
          text: self.last_agent_message.as_deref().unwrap_or("").trim().to_string(),
          stop_reason: StopReason::EndTurn,
          session_id: self.session_id(),
          usage: usage.clone(),
          duration_ms: elapsed_ms,
          continuations: 0,
        };
      }
      Some(Terminal::Failed(message)) => classify_codex_failure(&self.failure_text(Some(message), stderr)),
      // turn.completed も turn.failed も来ないまま終わった（会話なし・起動前の失敗など）
      None => classify_codex_failure(&self.failure_text(None, stderr)),
    };
    error_event(provider, code, message)
  }
}

pub(crate) fn run(ctx: &TurnCtx, emit: &mut dyn FnMut(TurnEvent)) -> TurnEvent {
  let dir = match PrivateDir::create(&ctx.runtime.scratch_dir, TURN_DIR_PREFIX) {
    Ok(dir) => dir,
    Err(err) => return ctx.setup_failed(format!("scratch dir: {err}")),
  };
  ctx.running.set_private_dir(Some(dir.path().to_path_buf()));
  // 空のシステムプロンプトはファイルにしない（Codex の既定の指示のまま）
  let instructions = if ctx.req.system_prompt.trim().is_empty() {
    None
  } else {
    match dir.write(INSTRUCTIONS_FILE, ctx.req.system_prompt.as_bytes()) {
      Ok(path) => Some(path),
      Err(err) => return ctx.setup_failed(format!("instructions file: {err}")),
    }
  };
  // 今の版で有効な機能を読む（読めなければ起動しない）。切る機能は版に依らずここで決める
  let listed = run_capture(
    ctx.command(&["features".to_string(), "list".to_string()], &[]),
    FEATURES_TIME_LIMIT,
    ctx.runtime.kill_grace,
    FEATURES_OUTPUT_MAX_BYTES,
  );
  let enabled = match listed {
    Ok(output) if output.status.success() => enabled_features(&String::from_utf8_lossy(&output.stdout)),
    _ => None,
  };
  let Some(enabled) = enabled else {
    ctx.log("features_unreadable", serde_json::json!({}));
    return ctx.error(ReasonCode::NotConfigured, Some(FEATURES_UNREADABLE_MESSAGE));
  };
  let off = features_off(&enabled, ctx.folder.is_some());
  let args = build_args(
    &ctx.req.model,
    ctx.req.effort,
    instructions.as_deref(),
    ctx.req.resume_session.as_deref(),
    ctx.folder.as_ref(),
    &off,
  );
  if args.iter().map(String::len).sum::<usize>() > MAX_ARGV_BYTES {
    return ctx.error(ReasonCode::TransientFailure, Some("依頼の引数が長すぎます。"));
  }
  let mut converter = match &ctx.folder {
    Some(folder) => CodexConverter::with_folder(ctx.req.resume_session.clone(), folder.clone()),
    None => CodexConverter::new(ctx.req.resume_session.clone()),
  };
  if ctx.running.is_stop_requested() {
    return ctx.finish(&converter, None);
  }
  let exit = run_child(
    ctx,
    ctx.command(&args, &[]),
    ctx.req.user_prompt.as_bytes().to_vec(),
    &mut converter,
    emit,
  );
  ctx.finish(&converter, Some(exit))
}

#[cfg(test)]
mod tests {
  use super::*;

  const THREAD: &str = "01a13b6e-21d7-7093-8fc2-637efb0dd571";

  fn feed(converter: &mut CodexConverter, lines: &[&str]) -> Vec<TurnEvent> {
    lines.iter().flat_map(|line| converter.process_line(line)).collect()
  }

  fn error_code(event: &TurnEvent) -> Option<ReasonCode> {
    match event {
      TurnEvent::Error { reason_code, .. } => Some(*reason_code),
      _ => None,
    }
  }

  #[test]
  fn converts_agent_messages_reasoning_and_usage() {
    let mut converter = CodexConverter::new(None);
    let events = feed(
      &mut converter,
      &[
        r#"{"type":"thread.started","thread_id":"01a13b6e-21d7-7093-8fc2-637efb0dd571"}"#,
        r#"{"type":"turn.started"}"#,
        r#"{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"**考え中**"}}"#,
        r#"{"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":""}}"#,
        r#"{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"下書きです。"}}"#,
        r#"{"type":"item.completed","item":{"id":"item_3","type":"todo_list","items":[]}}"#,
        r#"{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"  完成です。  "}}"#,
        r#"{"type":"turn.completed","usage":{"input_tokens":15779,"cached_input_tokens":0,"output_tokens":202,"reasoning_output_tokens":18}}"#,
      ],
    );
    assert_eq!(
      events,
      vec![
        TurnEvent::ThinkingDelta("**考え中**".into()),
        TurnEvent::TextDelta("下書きです。".into()),
        TurnEvent::TextDelta("  完成です。  ".into()),
      ]
    );
    assert_eq!(
      converter.conclude("", 321),
      TurnEvent::Done {
        text: "完成です。".into(),
        stop_reason: StopReason::EndTurn,
        session_id: Some(THREAD.into()),
        usage: Usage {
          input_tokens: 15779,
          output_tokens: 202,
          cost_usd: None,
          model_used: None,
        },
        duration_ms: 321,
        continuations: 0,
      }
    );
  }

  #[test]
  fn reconnecting_errors_do_not_end_the_turn() {
    let mut converter = CodexConverter::new(None);
    feed(
      &mut converter,
      &[
        r#"{"type":"thread.started","thread_id":"01a13b6e-21d7-7093-8fc2-637efb0dd571"}"#,
        r#"{"type":"error","message":"Reconnecting... 2/5 (stream disconnected before completion)"}"#,
        r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"届きました"}}"#,
        r#"{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}"#,
      ],
    );
    assert!(matches!(
      converter.conclude("", 0),
      TurnEvent::Done {
        stop_reason: StopReason::EndTurn,
        ..
      }
    ));
  }

  #[test]
  fn failure_text_keeps_early_auth_errors_before_later_reconnect_events() {
    let mut converter = CodexConverter::new(None);
    feed(
      &mut converter,
      &[
        r#"{"type":"error","message":"401 Unauthorized: authentication_required"}"#,
        r#"{"type":"error","message":"Reconnecting…"}"#,
      ],
    );
    let text = converter.failure_text(None, "");
    assert!(text.contains("401 Unauthorized"));
    assert!(text.contains("Reconnecting"));
    assert_eq!(classify_codex_failure(&text).0, ReasonCode::CliLoginRequired);

    for _ in 0..MAX_FAILURE_ERROR_EVENTS + 1 {
      converter.push_error(&"x".repeat(MAX_FAILURE_ERROR_BYTES + 1));
    }
    assert_eq!(converter.errors.len(), MAX_FAILURE_ERROR_EVENTS);
    assert!(converter
      .errors
      .iter()
      .all(|error| error.len() <= MAX_FAILURE_ERROR_BYTES));
  }

  #[test]
  fn turn_failed_is_classified_by_its_message() {
    let cases = [
      (
        "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
        ReasonCode::CliLoginRequired,
      ),
      (
        "{\"detail\":\"The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.\"}",
        ReasonCode::ModelNotFound,
      ),
      (
        "You've hit your usage limit. Upgrade to Pro",
        ReasonCode::UsageLimitReached,
      ),
      (
        "stream error: Incomplete response returned",
        ReasonCode::TransientFailure,
      ),
    ];
    for (message, expected) in cases {
      let mut converter = CodexConverter::new(None);
      let line = serde_json::json!({"type":"turn.failed","error":{"message":message}}).to_string();
      feed(&mut converter, &[&line]);
      assert_eq!(error_code(&converter.conclude("", 0)), Some(expected), "{message}");
    }
    // JSON が無く stderr だけ（会話なし）
    let converter = CodexConverter::new(Some(THREAD.into()));
    assert_eq!(
      error_code(&converter.conclude(
        &format!("Error: thread/resume: thread/resume failed: no rollout found for thread id {THREAD}"),
        0
      )),
      Some(ReasonCode::SessionNotFound)
    );
  }

  #[test]
  fn tool_items_are_breaches_and_error_items_are_warnings() {
    for item_type in [
      "command_execution",
      "file_change",
      "mcp_tool_call",
      "web_search",
      "something_new",
    ] {
      for phase in ["item.started", "item.updated", "item.completed"] {
        let mut converter = CodexConverter::new(None);
        let line = serde_json::json!({"type":phase,"item":{"id":"item_1","type":item_type}}).to_string();
        let events = feed(&mut converter, &[&line]);
        assert!(events.is_empty());
        assert_eq!(converter.breach().map(|breach| breach.kind.as_str()), Some(item_type));
      }
    }
    let mut converter = CodexConverter::new(None);
    feed(
      &mut converter,
      &[
        r#"{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `x` not found."}}"#,
      ],
    );
    assert!(converter.breach().is_none());
    assert_eq!(
      converter.take_warnings(),
      vec!["Model metadata for `x` not found.".to_string()]
    );
    assert!(converter.take_warnings().is_empty());
  }

  #[test]
  fn stopped_returns_the_last_agent_message_and_thread_id() {
    let mut converter = CodexConverter::new(None);
    feed(
      &mut converter,
      &[
        r#"{"type":"thread.started","thread_id":"01a13b6e-21d7-7093-8fc2-637efb0dd571"}"#,
        r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"途中"}}"#,
      ],
    );
    assert_eq!(
      converter.stopped(5),
      TurnEvent::Done {
        text: "途中".into(),
        stop_reason: StopReason::Stopped,
        session_id: Some(THREAD.into()),
        usage: Usage::default(),
        duration_ms: 5,
        continuations: 0,
      }
    );
    // thread.started が来ない続きは resume の ID を返す。UUID でない thread_id は返さない
    let mut resumed = CodexConverter::new(Some("11111111-2222-4333-8444-555555555555".into()));
    feed(&mut resumed, &[r#"{"type":"thread.started","thread_id":"not-a-uuid"}"#]);
    assert!(
      matches!(resumed.stopped(0), TurnEvent::Done { session_id: Some(id), .. } if id == "11111111-2222-4333-8444-555555555555")
    );
  }

  #[test]
  fn toml_basic_string_escapes_quotes_backslashes_and_controls() {
    assert_eq!(
      toml_basic_string("あなたは \"編集者\" です"),
      "\"あなたは \\\"編集者\\\" です\""
    );
    assert_eq!(toml_basic_string("C:\\path"), "\"C:\\\\path\"");
    assert_eq!(toml_basic_string("1行目\n2行目\tタブ\r"), "\"1行目\\n2行目\\tタブ\\r\"");
    assert_eq!(
      toml_basic_string("\u{8}\u{c}\u{1}\u{1f}\u{7f}"),
      "\"\\b\\f\\u0001\\u001F\\u007F\""
    );
    assert_eq!(toml_basic_string("日本語のまま"), "\"日本語のまま\"");
    assert_eq!(toml_basic_string(""), "\"\"");
  }

  const INSTRUCTIONS: &str = "/Users/me/Library/Application Support/life.niho.docs/local-ai/turn-1/instructions.md";

  #[test]
  fn args_for_new_and_resume_differ_only_in_the_head_and_sandbox() {
    let instructions = Path::new(INSTRUCTIONS);
    let off = features_off(&[], false);
    let new = build_args("gpt-5.5", None, Some(instructions), None, None, &off);
    assert_eq!(
      &new[..4],
      ["exec", "--json", "--sandbox", "read-only"].map(String::from)
    );
    assert!(!new.iter().any(|arg| arg == "resume"));
    assert!(!new.iter().any(|arg| arg.starts_with("sandbox_mode=")));
    let after =
      |args: &[String], flag: &str, value: &str| args.windows(2).any(|pair| pair[0] == flag && pair[1] == value);
    // 機能は `-c features.<名前>=false` で切る（`--disable=` は知らない名前で CLI が起動しない）
    assert!(!new.iter().any(|arg| arg.starts_with("--disable")));
    assert_eq!(new.iter().filter(|arg| arg.starts_with("features.")).count(), 18);
    for feature in DISABLED_FEATURES {
      assert!(after(&new, "-c", &format!("features.{feature}=false")), "{feature}");
    }
    assert!(after(&new, "-c", "web_search=\"disabled\""));
    assert!(after(&new, "-c", "project_doc_max_bytes=0"));
    // システムプロンプトはファイルで渡し（-c base_instructions は 0.154.0 で無視される）、既定で足される指示を切る
    assert!(after(
      &new,
      "-c",
      &format!("model_instructions_file=\"{INSTRUCTIONS}\"")
    ));
    assert!(!new.iter().any(|arg| arg.starts_with("base_instructions")));
    for setting in QUIET_CONFIG {
      assert!(after(&new, "-c", setting), "{setting}");
    }
    assert!(after(&new, "-m", "gpt-5.5"));
    assert!(!new.iter().any(|arg| arg.starts_with("model_reasoning_effort")));
    assert!(!new.iter().any(|arg| arg == "-" || arg == "-o"));
    assert_eq!(new.last().map(String::as_str), Some("gpt-5.5"));

    let resume = build_args(
      "gpt-5.5",
      Some(Effort::High),
      Some(instructions),
      Some(THREAD),
      None,
      &off,
    );
    assert_eq!(
      &resume[..6],
      ["exec", "resume", THREAD, "--json", "-c", "sandbox_mode=\"read-only\""].map(String::from)
    );
    assert!(!resume.iter().any(|arg| arg == "--sandbox"));
    assert!(after(&resume, "-c", "model_reasoning_effort=\"high\""));
    // 頭と sandbox の渡し方の他は同じ
    assert_eq!(&new[4..], &resume[6..resume.len() - 2]);

    // 空のシステムプロンプト（ファイル無し）は Codex の既定の指示のまま
    let bare = build_args("gpt-5.5", None, None, None, None, &off);
    assert!(!bare.iter().any(|arg| arg.starts_with("model_instructions_file")));
  }

  fn folder() -> FolderAccess {
    FolderAccess {
      dir: std::path::PathBuf::from("/private/tmp/p"),
      given: std::path::PathBuf::from("/tmp/p"),
      writable: vec!["artifacts".into()],
    }
  }

  #[test]
  fn args_for_the_project_folder_use_workspace_write_in_the_folder() {
    let folder = folder();
    let after =
      |args: &[String], flag: &str, value: &str| args.windows(2).any(|pair| pair[0] == flag && pair[1] == value);
    let off = features_off(&[], true);
    let new = build_args(
      "gpt-5.6-luna",
      None,
      Some(Path::new(INSTRUCTIONS)),
      None,
      Some(&folder),
      &off,
    );
    assert_eq!(
      &new[..6],
      [
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "-C",
        "/private/tmp/p/artifacts"
      ]
      .map(String::from)
    );
    // apply_patch は code mode の中にあるので code_mode_host だけを残し、シェルは切ったまま
    assert!(!new.iter().any(|arg| arg == "features.code_mode_host=false"));
    for feature in [
      "shell_tool",
      "unified_exec",
      "multi_agent",
      "browser_use",
      "computer_use",
      "hooks",
    ] {
      assert!(after(&new, "-c", &format!("features.{feature}=false")), "{feature}");
    }
    assert_eq!(new.iter().filter(|arg| arg.starts_with("features.")).count(), 17);
    assert!(after(&new, "-c", "sandbox_workspace_write.exclude_slash_tmp=true"));
    assert!(after(&new, "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true"));
    assert!(after(&new, "-c", "web_search=\"disabled\""));
    assert!(!new.iter().any(|arg| arg == "--add-dir"));
    // 書ける場所（権限）と cwd の説明は残し、スキルとアプリの説明だけを切る
    for setting in QUIET_CONFIG_FOR_FOLDER {
      assert!(after(&new, "-c", setting), "{setting}");
    }
    assert!(!after(&new, "-c", "include_permissions_instructions=false"));
    assert!(!after(&new, "-c", "include_environment_context=false"));
    assert!(after(
      &new,
      "-c",
      &format!("model_instructions_file=\"{INSTRUCTIONS}\"")
    ));
    // 続きは -C も --sandbox も無い（cwd が許可した書き込みフォルダ）
    let resume = build_args(
      "gpt-5.6-luna",
      None,
      Some(Path::new(INSTRUCTIONS)),
      Some(THREAD),
      Some(&folder),
      &off,
    );
    assert_eq!(
      &resume[..6],
      [
        "exec",
        "resume",
        THREAD,
        "--json",
        "-c",
        "sandbox_mode=\"workspace-write\""
      ]
      .map(String::from)
    );
    assert!(!resume.iter().any(|arg| arg == "-C" || arg == "--sandbox"));
    assert!(after(&resume, "-c", "sandbox_workspace_write.exclude_slash_tmp=true"));
  }

  /// 0.163.0 の `codex features list` の一部（段階は 2 語のこともある）。
  const FEATURES_0_163: &str = "agent_message_board                      under development  false
apps                                     stable             true
code_mode_host                           stable             true
collaboration_modes                      removed            true
plugins                                  stable             true
remote_plugin                            stable             true
realtime_conversation                    stable             true
shell_tool                               stable             true
worktrees                                stable             true
web_search_cached                        deprecated         false
";

  #[test]
  fn enabled_features_reads_only_well_formed_rows() {
    let enabled = enabled_features(FEATURES_0_163).unwrap();
    assert_eq!(
      enabled,
      [
        "apps",
        "code_mode_host",
        "collaboration_modes",
        "plugins",
        "remote_plugin",
        "realtime_conversation",
        "shell_tool",
        "worktrees"
      ]
      .map(String::from)
    );
    // 設定のキーにならない名前・形の違う行は読まない
    let odd =
      "Bad-Name stable true\nx.y stable true\n\"q\" stable true\nok_one stable maybe\nshort\nfine_one stable true\n";
    assert_eq!(enabled_features(odd).unwrap(), vec!["fine_one".to_string()]);
    // 1 行も読めない（別の出力・空）なら None（起動しない）
    assert_eq!(enabled_features(""), None);
    assert_eq!(enabled_features("Usage: codex [OPTIONS]\nerror: unknown command"), None);
    // 多すぎる一覧も読めなかったとする
    let many: String = (0..=MAX_FEATURES)
      .map(|index| format!("f{index} stable true\n"))
      .collect();
    assert_eq!(enabled_features(&many), None);
  }

  #[test]
  fn features_off_adds_every_enabled_feature_of_this_version() {
    let enabled = enabled_features(FEATURES_0_163).unwrap();
    // 知らない新しい機能（remote_plugin・realtime_conversation・worktrees など）も切る
    let off = features_off(&enabled, false);
    for feature in [
      "remote_plugin",
      "realtime_conversation",
      "worktrees",
      "collaboration_modes",
      "code_mode_host",
    ] {
      assert!(off.contains(&feature.to_string()), "{feature}");
    }
    for feature in DISABLED_FEATURES {
      assert!(off.contains(&feature.to_string()), "{feature}");
    }
    // 名前の順で、重ならない
    let mut sorted = off.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(off, sorted);
    // 修正の会話だけ code_mode_host を残す（apply_patch がある）
    let folder_off = features_off(&enabled, true);
    assert!(!folder_off.contains(&"code_mode_host".to_string()));
    assert!(folder_off.contains(&"remote_plugin".to_string()));
    // 設定のキーにならない名前は渡さない
    let odd = features_off(&["ok".to_string(), "a=b".to_string(), "x.y".to_string()], false);
    assert!(odd.contains(&"ok".to_string()));
    assert!(!odd.iter().any(|feature| feature.contains('=') || feature.contains('.')));
  }

  #[test]
  fn file_changes_in_the_folder_become_tool_events() {
    let mut converter = CodexConverter::with_folder(None, folder());
    let events = feed(
      &mut converter,
      &[
        r#"{"type":"thread.started","thread_id":"01a13b6e-21d7-7093-8fc2-637efb0dd571"}"#,
        r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"見出しを短くします。"}}"#,
        r#"{"type":"item.started","item":{"id":"item_1","type":"file_change","changes":[{"path":"/private/tmp/p/artifacts/abc12345.md","kind":"update"}],"status":"in_progress"}}"#,
        r#"{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"/private/tmp/p/artifacts/abc12345.md","kind":"update"}],"status":"completed"}}"#,
        // item.started の無い完了・失敗した変更・新しいファイル
        r#"{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"artifacts/new.md","kind":"add"},{"path":"/tmp/p/artifacts/old.md","kind":"delete"}],"status":"failed"}}"#,
        r#"{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"見出しを短くしました。"}}"#,
        r#"{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}"#,
      ],
    );
    let tool = |id: &str, name: &str, summary: &str| TurnEvent::ToolUse {
      id: id.into(),
      name: name.into(),
      summary: summary.into(),
    };
    let result = |id: &str, name: &str, ok: bool| TurnEvent::ToolResult {
      id: id.into(),
      name: name.into(),
      ok,
    };
    assert_eq!(
      events,
      vec![
        TurnEvent::TextDelta("見出しを短くします。".into()),
        tool("item_1:0", "Edit", "abc12345.md"),
        result("item_1:0", "Edit", true),
        tool("item_2:0", "Write", "new.md"),
        result("item_2:0", "Write", false),
        tool("item_2:1", "Delete", "old.md"),
        result("item_2:1", "Delete", false),
        TurnEvent::TextDelta("見出しを短くしました。".into()),
      ]
    );
    match converter.conclude("", 0) {
      TurnEvent::Done { text, .. } => assert_eq!(text, "見出しを短くしました。"),
      other => panic!("unexpected {other:?}"),
    }
  }

  #[test]
  fn writes_outside_the_writable_folder_and_other_tools_are_breaches() {
    for path in ["/private/tmp/p/project.json", "/tmp/elsewhere.txt", "../outside.md"] {
      let mut converter = CodexConverter::with_folder(None, folder());
      let line = serde_json::json!({"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":path,"kind":"add"}],"status":"completed"}}).to_string();
      let events = feed(&mut converter, &[&line]);
      assert!(events.is_empty(), "{path}");
      assert_eq!(
        converter
          .breach()
          .map(|breach| (breach.kind.as_str(), breach.message.as_str())),
        Some(("file_change_outside", OUTSIDE_WRITE_MESSAGE)),
        "{path}"
      );
    }
    for item_type in [
      "command_execution",
      "mcp_tool_call",
      "web_search",
      "collab_tool_call",
      "something_new",
    ] {
      let mut converter = CodexConverter::with_folder(None, folder());
      let line = serde_json::json!({"type":"item.started","item":{"id":"item_1","type":item_type}}).to_string();
      feed(&mut converter, &[&line]);
      assert_eq!(converter.breach().map(|breach| breach.kind.as_str()), Some(item_type));
    }
    // ツール無しの起動では、file_change も違反（これまでどおり）
    let mut converter = CodexConverter::new(None);
    feed(
      &mut converter,
      &[
        r#"{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"/private/tmp/p/artifacts/a.md","kind":"update"}],"status":"completed"}}"#,
      ],
    );
    assert_eq!(
      converter.breach().map(|breach| breach.kind.as_str()),
      Some("file_change")
    );
  }
}
