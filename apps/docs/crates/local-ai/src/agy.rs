//! Antigravity CLI（`agy --input-format stream-json --output-format stream-json`）の起動引数と出力の読み取り。
//!
//! 2026-06-18 に gemini CLI が個人向けの契約の受け付けを終えたので、`Provider::GeminiCli` は後継の agy で動かす
//! （形は agy 1.3.5 の実機で確かめたもの）。
//! - ツールは独自のエージェント（`tools: []`・サブエージェントにしない・コマンドを実行しない）で切る。agent.md の本文が
//!   システムプロンプトになり、agy の既定の指示を置き換える。`--dangerously-skip-permissions` は付けない（全ツールが
//!   自動で許可される）。
//! - agy は作業フォルダ（cwd）の中の読み書きを自動で許すので、cwd は利用者の workdir ではなく、その回だけの空のフォルダ
//!   （0700 の一時フォルダの下の `ws/`）にする。会話は agy の側に保存され、`--conversation` は別の cwd からでも続けられる。
//! - 指示は標準入力に 1 行の JSON で渡す（`-p` は値を取り、標準入力を読まない。引数に載せると `ps` から見え、
//!   長さの上限もある）。
//! - init のエージェントが違う・manage_task 以外のツールの step・サブエージェント・拒否されたツールがあれば止める
//!   （fail closed）。続きのはずが別の会話になったら止める（agy は見つからない会話を新しい会話で続けてしまう）。
//! - `result.usage` は会話の累計なので、この回の分は agent_response の DONE の step の usage を足して返す。
//! - 音声の区切りの文字起こし（`ToolPolicy::ReadFile`。S2a #18383）: 渡したファイルをその回だけの作業フォルダに写し、
//!   `view_file` だけを持つ別のエージェント（niho-docs-transcriber）に読ませる。作業フォルダの外を読む step・ほかの道具は
//!   止め、拒否された道具（作業フォルダの外を読もうとした等）で終わったら一時的な失敗（やり直せる）にする。
//!   `--mode plan` は付けない（agy 1.3.5 は `--disable-slash-commands` と一緒だと「--mode plan has no effect」で効かない。
//!   道具はエージェントの `tools` で絞る）。続きは受け付けない。
//! - 修正の会話（`ToolPolicy::ProjectFolder`。S5 #18386）: 呼び出し側の隔離 workspace（`dir`）を cwd にし、`view_file`・`list_dir`
//!   と書く 3 つ（write_to_file・replace_file_content・multi_replace_file_content）だけを持つエージェント（niho-docs-editor）を
//!   `dir/.agents/agents/` に置いて `--mode accept-edits` で動かす（`.agents` は終わったら消す）。道具の step の引数のパスが
//!   `dir` の外（`..`・リンクで外へ出るものも）・書き先が `writable` の下の `.md` でない・ほかの道具は止める。道具の step は
//!   `ToolUse`・`ToolResult`（ファイル名と成否）で流し、`Done.text` は最後の道具より後の文にする。
//! - 修正の会話で `web_search` が true なら、エージェントの `tools` に Web の道具（[`WEB_TOOLS`]。search_web・
//!   read_url_content）も足す（#283。run_command などコマンド実行は足さない）。init の道具の一覧（版の全体が出る）に
//!   search_web が無ければ `Notice { WebSearchUnsupported }` を出して検索なしで続け、search_web が 1 依頼で 5 回を超えたら止める。

use crate::classify::{classify_agy_failure, error_event, reason_message};
use crate::claude::{self, file_name_only};
use crate::process::{is_uuid, run_child, set_mode, write_private_file, PrivateDir, TURN_DIR_PREFIX};
use crate::turn::{Breach, FolderAccess, StreamHandler, TurnCtx, WebSearchCount};
use crate::types::{Effort, NoticeCode, Provider, ReasonCode, StopReason, ToolPolicy, TurnEvent, Usage};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

/// 工程用のエージェントの名前（`--agent` と agent.md の name）。
pub(crate) const AGENT_NAME: &str = "niho-docs-writer";
/// agent.md の frontmatter（name は AGENT_NAME と同じ）。この後に続く本文がシステムプロンプトになる。
pub(crate) const AGENT_FRONTMATTER: &str = "---
name: niho-docs-writer
description: NIHO docs の工程を実行し、Markdown の本文だけを書く。
tools: []
mainAgent: true
subagent: false
commandExecutionPolicy: off
---
";
/// 音声の区切りを読むエージェントの名前（`--agent` と agent.md の name）。
pub(crate) const READER_AGENT_NAME: &str = "niho-docs-transcriber";
/// 読むエージェントの frontmatter（道具は `view_file` だけ）。この後に続く本文がシステムプロンプトになる。
pub(crate) const READER_FRONTMATTER: &str = "---
name: niho-docs-transcriber
description: NIHO docs の文字起こし。作業フォルダの音声ファイルを view_file で読み、書き起こしの本文だけを返す。
tools: [view_file]
mainAgent: true
subagent: false
commandExecutionPolicy: off
---
";
/// 修正の会話のエージェントの名前（`--agent` と agent.md の name）。
pub(crate) const EDITOR_AGENT_NAME: &str = "niho-docs-editor";
/// 修正の会話のエージェントの frontmatter（道具は読む 2 つと書く 3 つ）。この後に続く本文がシステムプロンプトになる。
pub(crate) const EDITOR_FRONTMATTER: &str = "---
name: niho-docs-editor
description: NIHO docs の修正の会話。作業フォルダの文書（Markdown）を読み、頼まれたところを直す。
tools: [view_file, list_dir, write_to_file, replace_file_content, multi_replace_file_content]
mainAgent: true
subagent: false
commandExecutionPolicy: off
---
";
/// その回だけの作業フォルダ（cwd）。一時フォルダ（0700）の下に作る。
const WORKSPACE_DIR: &str = "ws";
/// agy が独自のエージェント・決まり（rules・workflows・skills）を読むフォルダ。
const AGENTS_DIR: &str = ".agents";
/// 内部の作業管理（データに触れない）。エージェントのツールを空にしても残るので、これだけは許す。
const ALLOWED_TOOL: &str = "manage_task";
/// 読むエージェントにだけ許す道具（作業フォルダの中のファイルを読む）。
const READ_TOOL: &str = "view_file";
/// 修正の会話で許す道具と、画面に出す名前（claude のツール名に揃える）。
const EDITOR_TOOLS: [(&str, &str); 5] = [
  ("view_file", "Read"),
  ("list_dir", "Glob"),
  ("write_to_file", "Write"),
  ("replace_file_content", "Edit"),
  ("multi_replace_file_content", "Edit"),
];
/// 修正の会話で `web_search` のときだけ足す Web の道具と、画面に出す名前（claude のツール名に揃える）。名前は agy 1.5.1 の
/// 実行ファイルの中の道具名と、既存の init の一覧（agy 1.3.5 の実機）で確かめた（2026-11-06。本物の呼び出しの引数の形は
/// まだ確かめていない）。道具名が変わったら、ここだけを直す。
pub(crate) const WEB_TOOLS: [(&str, &str); 2] = [("search_web", "WebSearch"), ("read_url_content", "WebFetch")];
/// 回数を数える検索の道具（ページを読む方は数えない）。
const WEB_SEARCH_TOOL: &str = WEB_TOOLS[0].0;
/// 書く道具（書き先は `TargetFile`）。
const EDITOR_WRITE_TOOLS: [&str; 3] = ["write_to_file", "replace_file_content", "multi_replace_file_content"];
/// 道具の引数のうち、パスとして見る鍵（値は作業フォルダの中の絶対パスでなければ止める）。ほかの鍵も、中身・説明でなければ
/// `/`・`~`・`file:` で始まる値をパスとして見る。
const PATH_KEYS: [&str; 5] = [
  "TargetFile",
  "AbsolutePath",
  "DirectoryPath",
  "SearchPath",
  "SearchDirectory",
];

const INIT_AGENT_MESSAGE: &str = "Antigravity CLI が NIHO editor の工程用のエージェント（ツール無し）で起動しなかったため止めました。Antigravity CLI を最新に更新してから、もう一度試してください。";
const INIT_MISSING_MESSAGE: &str = "Antigravity CLI が NIHO editor の工程用のエージェント（ツール無し）で起動したことを確かめられなかったため止めました。Antigravity CLI を最新に更新してから、もう一度試してください。";
const TOOL_USE_MESSAGE: &str =
  "Antigravity CLI がツールを使おうとしたため止めました。Antigravity CLI を最新に更新してから、もう一度試してください。";
const DENIED_ACTIONS_MESSAGE: &str =
  "Antigravity CLI がツールを使おうとして止まりました。Antigravity CLI を最新に更新してから、もう一度試してください。";
const EMPTY_RESPONSE_MESSAGE: &str = "Antigravity CLI の応答が空でした。もう一度試してください。";
const READER_INIT_MESSAGE: &str = "Antigravity CLI が NIHO editor の文字起こし用のエージェント（音声を読むだけ）で起動しなかったため止めました。Antigravity CLI を最新に更新してから、もう一度試してください。";
const READ_OUTSIDE_MESSAGE: &str =
  "Antigravity CLI が渡した音声の外のファイルを読もうとしたため止めました。もう一度試してください。";
const READER_DENIED_MESSAGE: &str = "Antigravity CLI が音声を読めませんでした。もう一度実行してください。";
const EDITOR_INIT_MESSAGE: &str = "Antigravity CLI が NIHO editor の修正用のエージェント（文書を読み書きするだけ）で起動しなかったため止めました。Antigravity CLI を最新に更新してから、もう一度試してください。";
const EDITOR_INIT_MISSING_MESSAGE: &str = "Antigravity CLI が NIHO editor の修正用のエージェント（文書を読み書きするだけ）で起動したことを確かめられなかったため止めました。Antigravity CLI を最新に更新してから、もう一度試してください。";
const EDITOR_TOOL_MESSAGE: &str = "Antigravity CLI が許したもの以外のツールを使おうとしたため止めました。Antigravity CLI を最新に更新してから、もう一度試してください。";
const OUTSIDE_PATH_MESSAGE: &str =
  "Antigravity CLI が作業フォルダの外のファイルに触れようとしたため止めました。もう一度試してください。";
const OUTSIDE_WRITE_MESSAGE: &str =
  "Antigravity CLI が許可した文書（Markdown）の外に書こうとしたため止めました。もう一度試してください。";
const EDITOR_DENIED_MESSAGE: &str = "Antigravity CLI が文書の読み書きを断られて止まりました。Antigravity CLI を最新に更新してから、もう一度試してください。";

/// `agy` の引数。順はこの通り。思考量はそのまま渡す（モデルごとに受ける値が違い、合わなければ agy が起動時に断るので
/// ModelNotFound で返す。crate では直さない）。
pub(crate) fn build_args(model: &str, effort: Option<Effort>, resume_session: Option<&str>) -> Vec<String> {
  let mut args: Vec<String> = [
    "--agent",
    AGENT_NAME,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--model",
    model,
  ]
  .iter()
  .map(|value| value.to_string())
  .collect();
  if let Some(effort) = effort {
    args.push("--effort".to_string());
    args.push(effort.as_str().to_string());
  }
  args.extend(
    ["--disable-slash-commands", "--print-timeout", "0"]
      .iter()
      .map(|value| value.to_string()),
  );
  if let Some(id) = resume_session {
    args.push("--conversation".to_string());
    args.push(id.to_string());
  }
  args
}

/// 音声を読む回の `agy` の引数（道具は `view_file` だけのエージェント。続きは無い）。
pub(crate) fn build_reader_args(model: &str, effort: Option<Effort>) -> Vec<String> {
  let mut args = build_args(model, effort, None);
  args[1] = READER_AGENT_NAME.to_string();
  args
}

/// 修正の会話の `agy` の引数（修正用のエージェントと `--mode accept-edits`。続きは `--conversation`）。
pub(crate) fn build_editor_args(model: &str, effort: Option<Effort>, resume_session: Option<&str>) -> Vec<String> {
  let mut args = build_args(model, effort, resume_session);
  args[1] = EDITOR_AGENT_NAME.to_string();
  args.splice(2..2, ["--mode".to_string(), "accept-edits".to_string()]);
  args
}

/// 標準入力に書く 1 行の JSON（`{"event":"user","message":{"content":…}}` と改行）。改行・`"` は JSON の中で
/// エスケープされるので 1 行に収まる。先頭が `/` の指示は claude と同じく改行を 1 つ前置する。
pub(crate) fn stdin_for(user_prompt: &str) -> Vec<u8> {
  let content = claude::stdin_for(user_prompt);
  let mut line = json!({ "event": "user", "message": { "content": content } }).to_string();
  line.push('\n');
  line.into_bytes()
}

/// 作業フォルダに置く独自のエージェント。システムプロンプトが空でもこの形で書く（既定の指示に戻さないため）。
pub(crate) fn agent_markdown(system_prompt: &str) -> String {
  format!("{AGENT_FRONTMATTER}{system_prompt}")
}

/// 音声を読むエージェント（道具は `view_file` だけ）。
pub(crate) fn reader_agent_markdown(system_prompt: &str) -> String {
  format!("{READER_FRONTMATTER}{system_prompt}")
}

/// 修正の会話のエージェント（読む 2 つと書く 3 つの道具。`web` なら Web の道具も足す）。
pub(crate) fn editor_agent_markdown(system_prompt: &str, web: bool) -> String {
  if !web {
    return format!("{EDITOR_FRONTMATTER}{system_prompt}");
  }
  let web_tools: Vec<&str> = WEB_TOOLS.iter().map(|(tool, _)| *tool).collect();
  let frontmatter = EDITOR_FRONTMATTER.replacen(
    "multi_replace_file_content]",
    &format!("multi_replace_file_content, {}]", web_tools.join(", ")),
    1,
  );
  format!("{frontmatter}{system_prompt}")
}

/// 作業フォルダに agy が決まりとして読むもの（`.agents`・`AGENTS.md`・`GEMINI.md`）があるか。修正の会話は `dir` を cwd に
/// するので、あれば起動しない（`.agents` は修正用のエージェントを置くために毎回作って消す）。
pub(crate) fn has_workspace_rules(dir: &Path) -> bool {
  [AGENTS_DIR, "AGENTS.md", "GEMINI.md"]
    .iter()
    .any(|name| std::fs::symlink_metadata(dir.join(name)).is_ok())
}

/// `path` が作業フォルダの中か。絶対パスで `..` を含まず、字句で `dir`（実体か依頼のパス）の下にあり、あるところまでの実体
/// （リンクを解いたパス）も `dir` の下にあるときだけ true（まだ無いファイルは、あるいちばん近い親で確かめる）。
fn is_inside(folder: &FolderAccess, path: &str) -> bool {
  let path = Path::new(path);
  if !path.is_absolute() || path.components().any(|part| matches!(part, Component::ParentDir)) {
    return false;
  }
  let normalized: PathBuf = path
    .components()
    .filter(|part| !matches!(part, Component::CurDir))
    .collect();
  if !(normalized.starts_with(&folder.dir) || normalized.starts_with(&folder.given)) {
    return false;
  }
  let mut existing = normalized.as_path();
  while std::fs::symlink_metadata(existing).is_err() {
    match existing.parent() {
      Some(parent) => existing = parent,
      None => return false,
    }
  }
  existing.canonicalize().is_ok_and(|real| real.starts_with(&folder.dir))
}

/// 書く道具の書き先として許すか: 作業フォルダの中で、`writable` のどれかの下の、`.` で始まる部分の無い `.md` のファイル。
fn permits_markdown_write(folder: &FolderAccess, path: &str) -> bool {
  let target = Path::new(path);
  let Some(relative) = target
    .strip_prefix(&folder.dir)
    .or_else(|_| target.strip_prefix(&folder.given))
    .ok()
  else {
    return false;
  };
  let hidden = relative
    .components()
    .any(|part| part.as_os_str().to_string_lossy().starts_with('.'));
  !hidden
    && target.extension().is_some_and(|extension| extension == "md")
    && folder.permits_write(path)
    && is_inside(folder, path)
}

/// 道具の引数のうち、中身（文書の本文）・説明の鍵（パスとしては見ない）。
fn is_content_key(key: &str) -> bool {
  key.ends_with("Content") || matches!(key, "Instruction" | "Description" | "explanation")
}

/// 道具の step が終わったか（`Some(成否)`。DONE でも error があれば失敗）。ACTIVE などはまだ途中（None）。
fn tool_outcome(step: &Value) -> Option<bool> {
  let ok = match step.get("state").and_then(Value::as_str).unwrap_or("") {
    "DONE" => true,
    "ERROR" | "CANCELED" | "CANCELLED" | "INTERRUPTED" | "HALTED" | "FAILED" => false,
    _ => return None,
  };
  let failed = |value: Option<&Value>| value.is_some_and(|value| !is_blank(value));
  Some(ok && !failed(step.get("error")) && !failed(step.get("tool_info").and_then(|info| info.get("error"))))
}

/// 修正の会話の道具の step を確かめた結果。
struct EditorStep {
  /// 画面に出す名前（Read・Glob・Write・Edit）
  label: &'static str,
  write: bool,
  /// 対象のファイル名（list_dir は無し）
  summary: Option<String>,
  /// 書き先（TargetFile）を確かめたか
  target_verified: bool,
}

/// 許した 5 つの道具か・引数のパスが作業フォルダの中か・書き先が `writable` の下の `.md` か。外れたら（ログの種類, 文）。
/// Web を許したときは Web の道具（[`WEB_TOOLS`]）も通す（書く道具ではない。引数の `/`・`~`・`file:` で始まる値は同じく
/// 作業フォルダの中でなければ止める）。
fn check_editor_step(folder: &FolderAccess, name: &str, step: &Value) -> Result<EditorStep, (String, &'static str)> {
  let web_tool = WEB_TOOLS.iter().find(|(tool, _)| folder.web && *tool == name);
  let Some(&(_, label)) = EDITOR_TOOLS.iter().find(|(tool, _)| *tool == name).or(web_tool) else {
    return Err((tool_kind(name), EDITOR_TOOL_MESSAGE));
  };
  let write = EDITOR_WRITE_TOOLS.contains(&name);
  let mut checked = EditorStep {
    label,
    write,
    summary: None,
    target_verified: false,
  };
  let Some(parameters) = step
    .get("tool_info")
    .and_then(|info| info.get("parameters"))
    .and_then(Value::as_object)
  else {
    return Ok(checked);
  };
  for (key, value) in parameters {
    let Some(text) = value.as_str().filter(|text| !text.is_empty()) else {
      continue;
    };
    let path_like = PATH_KEYS.contains(&key.as_str())
      || (!is_content_key(key) && (text.starts_with('/') || text.starts_with('~') || text.starts_with("file:")));
    if path_like && !is_inside(folder, text) {
      return Err(("path_outside".to_string(), OUTSIDE_PATH_MESSAGE));
    }
  }
  if web_tool.is_some() {
    // 検索語は出さない。ページを読む道具は、引数の URL のホスト名だけ
    checked.summary = (name != WEB_SEARCH_TOOL)
      .then(|| {
        parameters
          .values()
          .filter_map(Value::as_str)
          .map(claude::host_only)
          .find(|host| !host.is_empty())
      })
      .flatten();
    return Ok(checked);
  }
  let summary_key = match name {
    "view_file" => Some("AbsolutePath"),
    "list_dir" => None,
    _ => Some("TargetFile"),
  };
  checked.summary = summary_key
    .and_then(|key| parameters.get(key))
    .and_then(Value::as_str)
    .map(file_name_only);
  if write {
    if let Some(target) = parameters
      .get("TargetFile")
      .and_then(Value::as_str)
      .filter(|target| !target.is_empty())
    {
      if !permits_markdown_write(folder, target) {
        return Err(("write_outside".to_string(), OUTSIDE_WRITE_MESSAGE));
      }
      checked.target_verified = true;
    }
  }
  Ok(checked)
}

/// 読むエージェントの作業フォルダ（その回だけの `ws/`。実体のパスと、作ったときのパスの両方で比べる）。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ReaderWorkspace {
  pub canonical: PathBuf,
  pub given: PathBuf,
}

impl ReaderWorkspace {
  fn contains(&self, path: &str) -> bool {
    let path = std::path::Path::new(path);
    if path
      .components()
      .any(|component| matches!(component, std::path::Component::ParentDir))
    {
      return false;
    }
    path.starts_with(&self.canonical) || path.starts_with(&self.given)
  }
}

/// null・空の文字列・空の配列・空のオブジェクトか。
fn is_blank(value: &Value) -> bool {
  match value {
    Value::Null => true,
    Value::String(text) => text.is_empty(),
    Value::Array(items) => items.is_empty(),
    Value::Object(map) => map.is_empty(),
    Value::Bool(_) | Value::Number(_) => false,
  }
}

/// ログに書くツールの種類。名前が識別子の形のときだけ名前を残す（CLI の出力をそのままログに流さない）。
fn tool_kind(name: &str) -> String {
  let plain = !name.is_empty()
    && name.len() <= 64
    && name
      .chars()
      .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-');
  if plain {
    format!("tool:{name}")
  } else {
    "tool".to_string()
  }
}

struct ResultLine {
  success: bool,
  /// UUID の形のときだけ
  conversation_id: Option<String>,
  /// この回の本文
  response: String,
  /// 失敗のときの `error`（stderr と合わせて判定に使う）
  error: String,
}

/// どのエージェントで動かす回か。
enum Role {
  /// 工程の実行（道具無し）
  Writer,
  /// 音声の区切りの文字起こし（作業フォルダの中の `view_file` だけ）
  Reader(ReaderWorkspace),
  /// 修正の会話（作業フォルダの中を読み、`writable` の下の `.md` だけを書く）
  Editor(FolderAccess),
}

/// stream-json → `TurnEvent`。
pub(crate) struct AgyConverter {
  /// 続きのときに `--conversation` へ渡した会話の ID
  resume_session: Option<String>,
  /// 出力で最初に見た会話の ID（空でないもの）
  conversation_id: Option<String>,
  init_seen: bool,
  /// agent_response の text_delta を足したもの（修正の会話は最後の道具より後の分だけ）
  text: String,
  /// この回の使用量（agent_response の DONE の step の usage の和。result.usage は会話の累計なので使わない）
  usage: Usage,
  /// usage を足した step（同じ step の DONE が 2 回来ても 2 重に数えない）
  counted_steps: HashSet<u64>,
  result: Option<ResultLine>,
  breach: Option<Breach>,
  role: Role,
  /// 修正の会話で知らせた道具の step（id → 画面の名前）
  tool_names: HashMap<String, &'static str>,
  /// ToolResult を送った道具の step
  finished: HashSet<String>,
  /// 書き先（TargetFile）をまだ確かめていない書く道具の step（確かめないまま終わったら止める）
  unverified_writes: HashSet<String>,
  /// step_index の無い道具の step に振った数
  unnumbered_steps: u64,
  /// search_web の回数（修正の会話で Web を許したとき）
  searches: WebSearchCount,
}

impl AgyConverter {
  pub(crate) fn new(resume_session: Option<String>) -> Self {
    Self {
      resume_session,
      conversation_id: None,
      init_seen: false,
      text: String::new(),
      usage: Usage::default(),
      counted_steps: HashSet::new(),
      result: None,
      breach: None,
      role: Role::Writer,
      tool_names: HashMap::new(),
      finished: HashSet::new(),
      unverified_writes: HashSet::new(),
      unnumbered_steps: 0,
      searches: WebSearchCount::default(),
    }
  }

  /// 音声を読む回の出力を読む（続きは無い）。
  pub(crate) fn reader(workspace: ReaderWorkspace) -> Self {
    Self {
      role: Role::Reader(workspace),
      ..Self::new(None)
    }
  }

  /// 修正の会話（作業フォルダの中を読み書きする回）の出力を読む。
  pub(crate) fn editor(resume_session: Option<String>, folder: FolderAccess) -> Self {
    Self {
      role: Role::Editor(folder),
      ..Self::new(resume_session)
    }
  }

  fn agent_name(&self) -> &'static str {
    match self.role {
      Role::Writer => AGENT_NAME,
      Role::Reader(_) => READER_AGENT_NAME,
      Role::Editor(_) => EDITOR_AGENT_NAME,
    }
  }

  fn is_editor(&self) -> bool {
    matches!(self.role, Role::Editor(_))
  }

  /// `view_file` の step の読む先が作業フォルダの中か（`tool_info.parameters` の絶対パスの値を全部見る。無ければ通す。
  /// 外は agy の許可が要り、非対話では断られるが、もう一段の守りとして止める）。
  fn reads_inside_workspace(&self, step: &Value) -> bool {
    let Role::Reader(workspace) = &self.role else {
      return false;
    };
    let Some(parameters) = step
      .get("tool_info")
      .and_then(|info| info.get("parameters"))
      .and_then(Value::as_object)
    else {
      return true;
    };
    parameters
      .values()
      .filter_map(Value::as_str)
      .filter(|value| value.starts_with('/'))
      .all(|path| workspace.contains(path))
  }

  /// Done に返す会話の ID。続きは `--conversation` に渡した ID（違う会話になったら止めているので、別の会話の ID を
  /// 渡さない）。新しい会話は result → 最初に見た step の順で、UUID の形のものだけ。
  fn session_id(&self) -> Option<String> {
    if let Some(resume) = &self.resume_session {
      return Some(resume.clone());
    }
    self
      .result
      .as_ref()
      .and_then(|result| result.conversation_id.clone())
      .or_else(|| self.conversation_id.clone().filter(|id| is_uuid(id)))
  }

  fn not_configured(&mut self, kind: &str, message: &str) {
    self.breach = Some(Breach {
      kind: kind.to_string(),
      code: ReasonCode::NotConfigured,
      message: message.to_string(),
    });
  }

  /// 会話の ID を最初に見たとき、続きなのに違う ID なら止める（agy は見つからない会話を `--conversation` に渡しても
  /// エラーにせず、新しい会話で答えてしまう）。user_input の step が先に来るので、本文の delta より前に気づける。
  fn observe_conversation(&mut self, body: &Value) {
    if self.conversation_id.is_some() {
      return;
    }
    let Some(id) = body
      .get("conversation_id")
      .and_then(Value::as_str)
      .filter(|id| !id.is_empty())
    else {
      return;
    };
    self.conversation_id = Some(id.to_string());
    if self
      .resume_session
      .as_deref()
      .is_some_and(|resume| !resume.eq_ignore_ascii_case(id))
    {
      self.breach = Some(Breach {
        kind: "conversation_mismatch".to_string(),
        code: ReasonCode::SessionNotFound,
        message: reason_message(Provider::GeminiCli, ReasonCode::SessionNotFound),
      });
    }
  }

  /// init のエージェントが工程用（音声を読む回は文字起こし用、修正の会話は修正用）のものか。ツールの一覧（init.tools）は
  /// 独自のエージェントでも全体が出るので、数は問わない。
  fn check_init(&mut self, init: &Value, events: &mut Vec<TurnEvent>) {
    // 実際に使うモデルの ID（`gemini-3.8-flash` に `--effort low` を付けると `gemini-3.8-flash-low` と出る）
    self.usage.model_used = init
      .get("model")
      .and_then(Value::as_str)
      .map(str::trim)
      .filter(|model| !model.is_empty())
      .map(str::to_string);
    if init.get("agent").and_then(Value::as_str) == Some(self.agent_name()) {
      self.init_seen = true;
      // Web を許した修正の会話で、版の道具の一覧に search_web が無い（この版では検索できない）。黙って落とさず、検索なしで
      // 続ける。一覧が無ければ見分けられないので知らせない
      let web = matches!(&self.role, Role::Editor(folder) if folder.web);
      let lacks_search = init
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| !tools.iter().any(|tool| tool.as_str() == Some(WEB_SEARCH_TOOL)));
      if web && lacks_search {
        events.push(TurnEvent::Notice {
          code: NoticeCode::WebSearchUnsupported,
        });
      }
      return;
    }
    let message = match self.role {
      Role::Writer => INIT_AGENT_MESSAGE,
      Role::Reader(_) => READER_INIT_MESSAGE,
      Role::Editor(_) => EDITOR_INIT_MESSAGE,
    };
    self.not_configured("init", message);
  }

  /// 修正の会話の道具の step。確かめて（check_editor_step）、はじめて見たら `ToolUse`、終わったら `ToolResult` を流す。
  /// id は step_index（ACTIVE と DONE で同じ）。
  fn handle_editor_tool(&mut self, name: &str, step: &Value, events: &mut Vec<TurnEvent>) {
    let Role::Editor(folder) = &self.role else {
      return;
    };
    let checked = match check_editor_step(folder, name, step) {
      Ok(checked) => checked,
      Err((kind, message)) => {
        self.not_configured(&kind, message);
        return;
      }
    };
    let id = match step.get("step_index").and_then(Value::as_u64) {
      Some(index) => format!("step-{index}"),
      None => {
        self.unnumbered_steps += 1;
        format!("tool-{}", self.unnumbered_steps)
      }
    };
    if !self.tool_names.contains_key(&id) {
      if name == WEB_SEARCH_TOOL {
        if let Some(breach) = self.searches.record(&id) {
          self.breach = Some(breach);
          return;
        }
      }
      self.tool_names.insert(id.clone(), checked.label);
      if checked.write {
        self.unverified_writes.insert(id.clone());
      }
      // 道具より前の文は実況。Done.text は最後の道具より後の文だけにする
      self.text.clear();
      events.push(TurnEvent::ToolUse {
        id: id.clone(),
        name: checked.label.to_string(),
        summary: checked.summary.unwrap_or_default(),
      });
    }
    if checked.target_verified {
      self.unverified_writes.remove(&id);
    }
    let Some(ok) = tool_outcome(step) else {
      return;
    };
    if !self.finished.insert(id.clone()) {
      return;
    }
    if self.unverified_writes.contains(&id) {
      self.not_configured("write_target_unknown", OUTSIDE_WRITE_MESSAGE);
      return;
    }
    events.push(TurnEvent::ToolResult {
      id,
      name: checked.label.to_string(),
      ok,
    });
  }

  /// 最後に返す文。修正の会話で道具を使った回は最後の道具より後の文（delta）だけ、ほかは result の response（無ければ delta）。
  fn reply(&self, response: &str) -> String {
    if !self.tool_names.is_empty() {
      return self.text.trim().to_string();
    }
    match response.trim() {
      "" => self.text.trim().to_string(),
      text => text.to_string(),
    }
  }

  fn handle_step(&mut self, step: &Value, events: &mut Vec<TurnEvent>) {
    // サブエージェントの起動
    if step.get("subagent_info").is_some_and(|info| !is_blank(info)) {
      self.not_configured("subagent", TOOL_USE_MESSAGE);
      return;
    }
    match step.get("step_type").and_then(Value::as_str) {
      Some("agent_response") => {
        if let Some(delta) = step
          .get("text_delta")
          .and_then(Value::as_str)
          .filter(|delta| !delta.is_empty())
        {
          self.text.push_str(delta);
          events.push(TurnEvent::TextDelta(delta.to_string()));
        }
        if step.get("state").and_then(Value::as_str) == Some("DONE") {
          self.add_usage(step);
        }
      }
      // manage_task だけを許す（音声を読む回は作業フォルダの中の view_file も、修正の会話は読み書きの 5 つも）。
      // 名前の無いものも止める
      Some("tool") => {
        let name = step.get("tool_name").and_then(Value::as_str).unwrap_or("");
        if name == ALLOWED_TOOL {
          return;
        }
        match self.role {
          Role::Reader(_) if name == READ_TOOL => {
            if !self.reads_inside_workspace(step) {
              self.not_configured("read_outside", READ_OUTSIDE_MESSAGE);
            }
          }
          Role::Editor(_) => self.handle_editor_tool(name, step, events),
          _ => self.not_configured(&tool_kind(name), TOOL_USE_MESSAGE),
        }
      }
      // user_input・system_message・checkpoint・知らないもの
      _ => {}
    }
  }

  /// この回の使用量に、DONE の step の usage を足す（input はキャッシュから読んだ分も含める）。
  fn add_usage(&mut self, step: &Value) {
    let Some(usage) = step.get("usage").filter(|usage| usage.is_object()) else {
      return;
    };
    if let Some(index) = step.get("step_index").and_then(Value::as_u64) {
      if !self.counted_steps.insert(index) {
        return;
      }
    }
    let field = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    self.usage.input_tokens = self
      .usage
      .input_tokens
      .saturating_add(field("input_tokens").saturating_add(field("cache_read_tokens")));
    self.usage.output_tokens = self.usage.output_tokens.saturating_add(field("output_tokens"));
  }

  fn handle_result(&mut self, result: &Value) {
    let text = |key: &str| result.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let success = result.get("status").and_then(Value::as_str) == Some("SUCCESS");
    // 拒否されたツールがあると、本文が空のまま SUCCESS で終わる。音声を読む回は、読めなかった（作業フォルダの外を読もうと
    // して断られた等）としてやり直せる失敗にする（S0 #18381: 応答が空ならやり直す）。修正の会話は、返答があれば（断られた
    // ことを AI が書いた）そのまま返し、空なら失敗にする
    if success
      && result
        .get("denied_actions")
        .and_then(Value::as_array)
        .is_some_and(|actions| !actions.is_empty())
    {
      match self.role {
        Role::Writer => {
          self.not_configured("denied_actions", DENIED_ACTIONS_MESSAGE);
          return;
        }
        Role::Reader(_) => {
          self.breach = Some(Breach {
            kind: "denied_actions".to_string(),
            code: ReasonCode::TransientFailure,
            message: READER_DENIED_MESSAGE.to_string(),
          });
          return;
        }
        Role::Editor(_) if self.reply(&text("response")).is_empty() => {
          self.not_configured("denied_actions", EDITOR_DENIED_MESSAGE);
          return;
        }
        Role::Editor(_) => {}
      }
    }
    // 書き先を確かめられないまま終わった書く道具があれば止める
    if !self.unverified_writes.is_empty() {
      self.not_configured("write_target_unknown", OUTSIDE_WRITE_MESSAGE);
      return;
    }
    self.result = Some(ResultLine {
      success,
      conversation_id: Some(text("conversation_id")).filter(|id| is_uuid(id)),
      response: text("response"),
      error: text("error"),
    });
  }
}

impl StreamHandler for AgyConverter {
  fn process_line(&mut self, line: &str) -> Vec<TurnEvent> {
    let mut events = Vec::new();
    let trimmed = line.trim();
    if trimmed.is_empty() || self.breach.is_some() {
      return events;
    }
    // JSON でない行（起動時の案内など）は無視する
    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
      return events;
    };
    // 1 行 1 イベントで、中身は `event` と同名のキーにある
    let Some(kind) = value.get("event").and_then(Value::as_str) else {
      return events;
    };
    let body = value.get(kind).unwrap_or(&Value::Null);
    self.observe_conversation(body);
    if self.breach.is_none() {
      match kind {
        "init" => self.check_init(body, &mut events),
        "step_update" => self.handle_step(body, &mut events),
        "result" => self.handle_result(body),
        _ => {}
      }
    }
    // 工程用のエージェントで起動したことを init で確かめるまでは流さない（init は最初に来る）
    if self.init_seen && self.breach.is_none() {
      events
    } else {
      Vec::new()
    }
  }

  fn breach(&self) -> Option<&Breach> {
    self.breach.as_ref()
  }

  fn stopped(&self, elapsed_ms: u64) -> TurnEvent {
    TurnEvent::Done {
      text: self.text.trim().to_string(),
      stop_reason: StopReason::Stopped,
      session_id: self.session_id(),
      usage: self.usage.clone(),
      duration_ms: elapsed_ms,
      continuations: 0,
    }
  }

  fn conclude(&self, stderr: &str, elapsed_ms: u64) -> TurnEvent {
    let provider = Provider::GeminiCli;
    let Some(result) = &self.result else {
      // result が来ないまま終わった（起動前の失敗・未ログイン・異常終了）は stderr で判定する
      let (code, message) = classify_agy_failure(stderr);
      return error_event(provider, code, message);
    };
    if !result.success {
      let (code, message) = classify_agy_failure(&format!("{}\n{stderr}", result.error));
      return error_event(provider, code, message);
    }
    if !self.init_seen {
      // 工程用のエージェントで起動したことを確かめられないまま成功した。ツールを切れていた保証が無いので失敗にする
      let message = if self.is_editor() {
        EDITOR_INIT_MISSING_MESSAGE
      } else {
        INIT_MISSING_MESSAGE
      };
      return error_event(provider, ReasonCode::NotConfigured, Some(message));
    }
    let text = self.reply(&result.response);
    // 修正の会話で道具を使った回は、返答が空でも文書は直っている
    if text.is_empty() && self.tool_names.is_empty() {
      return error_event(provider, ReasonCode::TransientFailure, Some(EMPTY_RESPONSE_MESSAGE));
    }
    TurnEvent::Done {
      text,
      stop_reason: StopReason::EndTurn,
      session_id: self.session_id(),
      usage: self.usage.clone(),
      // result の duration_seconds は会話の累計なので、この回の実測を返す
      duration_ms: elapsed_ms,
      continuations: 0,
    }
  }
}

/// その回だけの空の作業フォルダ（`ws/`）と、その中の `.agents/agents/<name>/agent.md`（0600）を作り、作業フォルダを返す。
/// 音声を読む回（`read_file`）は、エージェントを文字起こし用にし、そのファイルを `ws/<同じ名前>`（0600）に写す。
fn write_workspace(
  dir: &PrivateDir,
  system_prompt: &str,
  read_file: Option<&std::path::Path>,
) -> std::io::Result<PathBuf> {
  let workspace = dir.create_dir(WORKSPACE_DIR)?;
  let (name, markdown) = match read_file {
    Some(_) => (READER_AGENT_NAME, reader_agent_markdown(system_prompt)),
    None => (AGENT_NAME, agent_markdown(system_prompt)),
  };
  let agent_dir = format!("{WORKSPACE_DIR}/.agents/agents/{name}");
  dir.create_dir(&agent_dir)?;
  dir.write(&format!("{agent_dir}/agent.md"), markdown.as_bytes())?;
  if let Some(file) = read_file {
    let file_name = file
      .file_name()
      .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no file name"))?;
    let copied = workspace.join(file_name);
    std::fs::copy(file, &copied)?;
    crate::process::set_mode(&copied, 0o600)?;
  }
  Ok(workspace)
}

/// 0700 のフォルダを 1 つ作る（あれば失敗する。リンクも辿らない）。
fn create_private_dir(path: &Path) -> std::io::Result<()> {
  let mut builder = std::fs::DirBuilder::new();
  #[cfg(unix)]
  {
    use std::os::unix::fs::DirBuilderExt;
    builder.mode(0o700);
  }
  builder.create(path)?;
  set_mode(path, 0o700)
}

/// 修正の会話で作業フォルダ（呼び出し側のもの）に置く修正用のエージェント（`.agents/agents/niho-docs-editor/agent.md`。
/// フォルダは 0700、agent.md は 0600）。Drop で `.agents` ごと消す（成功・失敗・停止・時間切れのどれでも）。
struct EditorAgent {
  root: PathBuf,
}

impl EditorAgent {
  /// `.agents` が無いこと（入力の検査で確かめている）。あれば作らずに失敗する（前からあるものは消さない）。
  fn write(dir: &Path, system_prompt: &str, web: bool) -> std::io::Result<Self> {
    let root = dir.join(AGENTS_DIR);
    create_private_dir(&root)?;
    let agent = Self { root };
    let mut path = agent.root.clone();
    for part in ["agents", EDITOR_AGENT_NAME] {
      path.push(part);
      create_private_dir(&path)?;
    }
    write_private_file(
      &path.join("agent.md"),
      editor_agent_markdown(system_prompt, web).as_bytes(),
      true,
    )?;
    Ok(agent)
  }
}

impl Drop for EditorAgent {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.root);
  }
}

/// 修正の会話: 作業フォルダ（`dir` の実体）に修正用のエージェントを置き、そこを cwd にして動かす。
fn run_editor(ctx: &TurnCtx, folder: &FolderAccess, emit: &mut dyn FnMut(TurnEvent)) -> TurnEvent {
  let _agent = match EditorAgent::write(&folder.dir, &ctx.req.system_prompt, folder.web) {
    Ok(agent) => agent,
    Err(err) => return ctx.setup_failed(format!("agy editor agent: {err}")),
  };
  let args = build_editor_args(&ctx.req.model, ctx.req.effort, ctx.req.resume_session.as_deref());
  let mut converter = AgyConverter::editor(ctx.req.resume_session.clone(), folder.clone());
  if ctx.running.is_stop_requested() {
    return ctx.finish(&converter, None);
  }
  let exit = run_child(
    ctx,
    ctx.command_in(&folder.dir, &args, &[]),
    stdin_for(&ctx.req.user_prompt),
    &mut converter,
    emit,
  );
  ctx.finish(&converter, Some(exit))
}

pub(crate) fn run(ctx: &TurnCtx, emit: &mut dyn FnMut(TurnEvent)) -> TurnEvent {
  if let Some(folder) = &ctx.folder {
    return run_editor(ctx, folder, emit);
  }
  let dir = match PrivateDir::create(&ctx.runtime.scratch_dir, TURN_DIR_PREFIX) {
    Ok(dir) => dir,
    Err(err) => return ctx.setup_failed(format!("scratch dir: {err}")),
  };
  ctx.running.set_private_dir(Some(dir.path().to_path_buf()));
  let read_file = match &ctx.req.tool_policy {
    ToolPolicy::ReadFile { file } => Some(file.as_path()),
    _ => None,
  };
  let workspace = match write_workspace(&dir, &ctx.req.system_prompt, read_file) {
    Ok(workspace) => workspace,
    Err(err) => return ctx.setup_failed(format!("agy workspace: {err}")),
  };
  let (args, mut converter) = match read_file {
    Some(_) => {
      let canonical = workspace.canonicalize().unwrap_or_else(|_| workspace.clone());
      (
        build_reader_args(&ctx.req.model, ctx.req.effort),
        AgyConverter::reader(ReaderWorkspace {
          canonical,
          given: workspace.clone(),
        }),
      )
    }
    None => (
      build_args(&ctx.req.model, ctx.req.effort, ctx.req.resume_session.as_deref()),
      AgyConverter::new(ctx.req.resume_session.clone()),
    ),
  };
  if ctx.running.is_stop_requested() {
    return ctx.finish(&converter, None);
  }
  // 利用者の workdir を渡さない（agy は作業フォルダの中を自動で読み書きできる）
  let exit = run_child(
    ctx,
    ctx.command_in(&workspace, &args, &[]),
    stdin_for(&ctx.req.user_prompt),
    &mut converter,
    emit,
  );
  ctx.finish(&converter, Some(exit))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::classify::AGY_MODEL_MESSAGE;

  const CONVERSATION: &str = "5b8f0c2e-1d3a-4b5c-8d7e-9f0a1b2c3d4e";
  const OTHER: &str = "0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e";

  fn init_line(agent: &str) -> String {
    json!({"event":"init","init":{"model":"gemini-3.8-flash-low","cwd":"/tmp/turn-x/ws","tools":["manage_task","view_file","run_command"],"permission_mode":"request-review","agent":agent}}).to_string()
  }

  fn step_line(conversation: &str, index: u64, state: &str, step_type: &str, extra: Value) -> String {
    let mut body = json!({"conversation_id":conversation,"step_index":index,"state":state,"step_type":step_type});
    for (key, value) in extra.as_object().unwrap() {
      body[key] = value.clone();
    }
    json!({"event":"step_update","step_update":body}).to_string()
  }

  fn user_input(conversation: &str) -> String {
    step_line(conversation, 0, "DONE", "user_input", json!({}))
  }

  fn result_line(extra: Value) -> String {
    let mut body = json!({"conversation_id":CONVERSATION,"status":"SUCCESS","response":"","duration_seconds":1.72,"num_turns":1,
      "usage":{"input_tokens":4524,"output_tokens":40,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":4564}});
    for (key, value) in extra.as_object().unwrap() {
      body[key] = value.clone();
    }
    json!({"event":"result","result":body}).to_string()
  }

  fn feed(converter: &mut AgyConverter, lines: &[String]) -> Vec<TurnEvent> {
    lines.iter().flat_map(|line| converter.process_line(line)).collect()
  }

  fn error_of(event: TurnEvent) -> (ReasonCode, String) {
    match event {
      TurnEvent::Error { reason_code, message } => (reason_code, message),
      other => panic!("expected an error, got {other:?}"),
    }
  }

  #[test]
  fn args_follow_the_contract_without_skipping_permissions() {
    let args = build_args("gemini-3.8-flash", None, None);
    let expected: Vec<String> = [
      "--agent",
      "niho-docs-writer",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      "gemini-3.8-flash",
      "--disable-slash-commands",
      "--print-timeout",
      "0",
    ]
    .iter()
    .map(|value| value.to_string())
    .collect();
    assert_eq!(args, expected);

    let resumed = build_args("gemini-3.8-flash", Some(Effort::Low), Some(CONVERSATION));
    let expected: Vec<String> = [
      "--agent",
      "niho-docs-writer",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      "gemini-3.8-flash",
      "--effort",
      "low",
      "--disable-slash-commands",
      "--print-timeout",
      "0",
      "--conversation",
      CONVERSATION,
    ]
    .iter()
    .map(|value| value.to_string())
    .collect();
    assert_eq!(resumed, expected);
    // 思考量は直さずにそのまま渡す
    for (effort, value) in [
      (Effort::Low, "low"),
      (Effort::Medium, "medium"),
      (Effort::High, "high"),
      (Effort::Max, "max"),
    ] {
      let args = build_args("gemini-3.8-flash-high", Some(effort), None);
      assert!(args.windows(2).any(|pair| pair[0] == "--effort" && pair[1] == value));
    }
    for args in [args, resumed] {
      assert!(!args
        .iter()
        .any(|arg| arg == "--dangerously-skip-permissions" || arg == "-p"));
    }
  }

  #[test]
  fn reader_args_use_the_transcriber_agent_without_resume_or_plan_mode() {
    let args = build_reader_args("gemini-3.8-flash", Some(Effort::Low));
    let expected: Vec<String> = [
      "--agent",
      "niho-docs-transcriber",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      "gemini-3.8-flash",
      "--effort",
      "low",
      "--disable-slash-commands",
      "--print-timeout",
      "0",
    ]
    .iter()
    .map(|value| value.to_string())
    .collect();
    assert_eq!(args, expected);
    // agy 1.3.5 は --disable-slash-commands と一緒だと --mode plan が効かないので付けない（道具はエージェントで絞る）
    assert!(!args.iter().any(|arg| arg == "--mode" || arg == "--conversation"));
    assert!(reader_agent_markdown("書き起こす").starts_with(READER_FRONTMATTER));
    assert!(READER_FRONTMATTER.contains("\ntools: [view_file]\n"));
    assert!(READER_FRONTMATTER.contains(&format!("\nname: {READER_AGENT_NAME}\n")));
    assert!(READER_FRONTMATTER.contains("\ncommandExecutionPolicy: off\n"));
  }

  fn reader() -> AgyConverter {
    AgyConverter::reader(ReaderWorkspace {
      canonical: PathBuf::from("/private/var/x/turn-1/ws"),
      given: PathBuf::from("/var/x/turn-1/ws"),
    })
  }

  fn view_file(index: u64, state: &str, path: &str) -> String {
    step_line(
      CONVERSATION,
      index,
      state,
      "tool",
      json!({"tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":path}}}),
    )
  }

  #[test]
  fn reader_allows_view_file_inside_the_workspace_and_returns_the_transcript() {
    let mut converter = reader();
    let events = feed(
      &mut converter,
      &[
        init_line(READER_AGENT_NAME),
        user_input(CONVERSATION),
        view_file(1, "ACTIVE", "/private/var/x/turn-1/ws/part-01.wav"),
        view_file(1, "DONE", "/private/var/x/turn-1/ws/part-01.wav"),
        step_line(
          CONVERSATION,
          2,
          "DONE",
          "agent_response",
          json!({"text_delta":"[00:00] こんにちは。","usage":{"input_tokens":3463,"output_tokens":38}}),
        ),
        result_line(json!({"response":"[00:00] こんにちは。"})),
      ],
    );
    assert_eq!(events, vec![TurnEvent::TextDelta("[00:00] こんにちは。".into())]);
    assert!(converter.breach().is_none());
    match converter.conclude("", 9) {
      TurnEvent::Done { text, usage, .. } => {
        assert_eq!(text, "[00:00] こんにちは。");
        assert_eq!(usage.input_tokens, 3463);
      }
      other => panic!("{other:?}"),
    }
    // 作ったときのパス（リンクを解く前）でもよい
    let mut given = reader();
    feed(
      &mut given,
      &[
        init_line(READER_AGENT_NAME),
        view_file(1, "ACTIVE", "/var/x/turn-1/ws/part-01.wav"),
      ],
    );
    assert!(given.breach().is_none());
  }

  #[test]
  fn reader_stops_reads_outside_other_tools_and_the_writer_agent() {
    for path in [
      "/Users/me/.ssh/id_ed25519",
      "/private/var/x/turn-1/ws/../secret.txt",
      "/private/var/x/turn-1/ws-other/a.wav",
    ] {
      let mut converter = reader();
      feed(
        &mut converter,
        &[init_line(READER_AGENT_NAME), view_file(1, "ACTIVE", path)],
      );
      assert_eq!(
        converter.breach().map(|breach| (breach.kind.as_str(), breach.code)),
        Some(("read_outside", ReasonCode::NotConfigured)),
        "{path}"
      );
    }
    let mut converter = reader();
    feed(
      &mut converter,
      &[
        init_line(READER_AGENT_NAME),
        step_line(CONVERSATION, 1, "ACTIVE", "tool", json!({"tool_name":"run_command"})),
      ],
    );
    assert_eq!(
      converter.breach().map(|breach| breach.kind.as_str()),
      Some("tool:run_command")
    );
    // 工程用のエージェントで起動したら止める
    let mut converter = reader();
    feed(&mut converter, &[init_line(AGENT_NAME)]);
    assert_eq!(converter.breach().map(|breach| breach.kind.as_str()), Some("init"));
    // 工程の実行（書くだけ）では view_file も止める
    let mut writer = AgyConverter::new(None);
    feed(
      &mut writer,
      &[
        init_line(AGENT_NAME),
        view_file(1, "ACTIVE", "/private/var/x/turn-1/ws/part-01.wav"),
      ],
    );
    assert_eq!(
      writer.breach().map(|breach| breach.kind.as_str()),
      Some("tool:view_file")
    );
  }

  #[test]
  fn reader_denied_actions_are_a_retryable_failure() {
    let mut converter = reader();
    feed(
      &mut converter,
      &[
        init_line(READER_AGENT_NAME),
        result_line(json!({"response":"","denied_actions":["view_file"]})),
      ],
    );
    let breach = converter.breach().unwrap();
    assert_eq!(breach.code, ReasonCode::TransientFailure);
    assert_eq!(breach.message, READER_DENIED_MESSAGE);
  }

  // --- 修正の会話（ToolPolicy::ProjectFolder）

  /// テスト用の修正の会話の作業フォルダ（artifacts/abc12345.md と transcript.md を持つ。書けるのは artifacts/）。Drop で消す。
  struct EditorDir {
    folder: FolderAccess,
  }

  impl Drop for EditorDir {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.folder.given);
    }
  }

  fn editor_dir(name: &str) -> EditorDir {
    let dir = std::env::temp_dir().join(format!(
      "niho-local-ai-agy-{name}-{}-{}",
      std::process::id(),
      crate::process::hex(&crate::process::random_bytes::<4>().unwrap())
    ));
    std::fs::create_dir_all(dir.join("artifacts")).unwrap();
    std::fs::write(dir.join("artifacts").join("abc12345.md"), "# とても長い見出し\n").unwrap();
    std::fs::write(dir.join("transcript.md"), "文字起こし\n").unwrap();
    let folder = crate::turn::folder_access(&ToolPolicy::ProjectFolder {
      dir,
      writable: vec!["artifacts".into()],
    })
    .unwrap()
    .unwrap();
    EditorDir { folder }
  }

  fn tool_step(index: u64, state: &str, name: &str, parameters: Value) -> String {
    step_line(
      CONVERSATION,
      index,
      state,
      "tool",
      json!({"tool_name":name,"tool_info":{"name":name,"parameters":parameters}}),
    )
  }

  fn editor_breach(converter: &AgyConverter) -> Option<(&str, ReasonCode, &str)> {
    converter
      .breach()
      .map(|breach| (breach.kind.as_str(), breach.code, breach.message.as_str()))
  }

  #[test]
  fn editor_args_and_agent_use_the_editor_agent_in_accept_edits_mode() {
    let args = build_editor_args("gemini-3.8-flash", Some(Effort::Medium), Some(CONVERSATION));
    let expected: Vec<String> = [
      "--agent",
      "niho-docs-editor",
      "--mode",
      "accept-edits",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--model",
      "gemini-3.8-flash",
      "--effort",
      "medium",
      "--disable-slash-commands",
      "--print-timeout",
      "0",
      "--conversation",
      CONVERSATION,
    ]
    .iter()
    .map(|value| value.to_string())
    .collect();
    assert_eq!(args, expected);
    let new = build_editor_args("gemini-3.8-flash", None, None);
    assert_eq!(new.len(), 13);
    assert!(!new
      .iter()
      .any(|arg| arg == "--conversation" || arg == "--dangerously-skip-permissions" || arg == "-p"));

    let markdown = editor_agent_markdown("あなたは編集者です。", false);
    assert!(markdown.starts_with(EDITOR_FRONTMATTER));
    assert!(markdown.ends_with("---\nあなたは編集者です。"));
    assert!(EDITOR_FRONTMATTER.contains(&format!("\nname: {EDITOR_AGENT_NAME}\n")));
    assert!(EDITOR_FRONTMATTER
      .contains("\ntools: [view_file, list_dir, write_to_file, replace_file_content, multi_replace_file_content]\n"));
    assert!(EDITOR_FRONTMATTER.contains("\nsubagent: false\n"));
    assert!(EDITOR_FRONTMATTER.contains("\ncommandExecutionPolicy: off\n"));
  }

  #[test]
  fn editor_agent_is_written_privately_and_removed_with_dot_agents() {
    let work = editor_dir("agent");
    let dir = &work.folder.dir;
    assert!(!has_workspace_rules(dir));
    let path = dir.join(".agents/agents/niho-docs-editor/agent.md");
    {
      let _agent = EditorAgent::write(dir, "あなたは編集者です。", false).unwrap();
      assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        editor_agent_markdown("あなたは編集者です。", false)
      );
      #[cfg(unix)]
      {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        for folder in [".agents", ".agents/agents", ".agents/agents/niho-docs-editor"] {
          assert_eq!(mode(&dir.join(folder)), 0o700, "{folder}");
        }
        assert_eq!(mode(&path), 0o600);
      }
      assert!(has_workspace_rules(dir));
      // あれば作らずに失敗し、前からあるものは消さない
      assert!(EditorAgent::write(dir, "別の指示", false).is_err());
      assert!(path.exists());
    }
    assert!(!dir.join(".agents").exists());
    assert!(dir.join("artifacts").join("abc12345.md").exists());
    for rules in ["AGENTS.md", "GEMINI.md"] {
      std::fs::write(dir.join(rules), "決まり").unwrap();
      assert!(has_workspace_rules(dir), "{rules}");
      std::fs::remove_file(dir.join(rules)).unwrap();
    }
  }

  #[test]
  fn editor_tools_become_tool_events_and_done_text_is_the_reply() {
    let work = editor_dir("events");
    let folder = &work.folder;
    let document = folder.dir.join("artifacts").join("abc12345.md");
    // 依頼のパス（リンクを解く前）でもよい
    let given = folder.given.join("artifacts").join("abc12345.md");
    let replace = json!({"TargetFile":given,"TargetContent":"# とても長い見出し","ReplacementContent":"/ 中身は / で始まってもよい","StartLine":1,"EndLine":1,"AllowMultiple":false});
    let multi = json!({"TargetFile":document,"ReplacementChunks":[{"TargetContent":"a","ReplacementContent":"/b"}]});
    let created = json!({"TargetFile":folder.dir.join("artifacts").join("new12345.md"),"CodeContent":"# 新しい文書","Overwrite":false});
    let mut converter = AgyConverter::editor(None, folder.clone());
    let events = feed(
      &mut converter,
      &[
        init_line(EDITOR_AGENT_NAME),
        user_input(CONVERSATION),
        step_line(
          CONVERSATION,
          1,
          "DONE",
          "agent_response",
          json!({"text_delta":"確かめます。","usage":{"input_tokens":10,"output_tokens":2}}),
        ),
        step_line(CONVERSATION, 2, "DONE", "tool", json!({"tool_name":"manage_task"})),
        tool_step(
          3,
          "ACTIVE",
          "list_dir",
          json!({"DirectoryPath":folder.dir.join("artifacts")}),
        ),
        tool_step(
          3,
          "DONE",
          "list_dir",
          json!({"DirectoryPath":folder.dir.join("artifacts")}),
        ),
        tool_step(4, "ACTIVE", "view_file", json!({"AbsolutePath":document})),
        tool_step(4, "DONE", "view_file", json!({"AbsolutePath":document})),
        step_line(
          CONVERSATION,
          5,
          "DONE",
          "agent_response",
          json!({"text_delta":"直します。"}),
        ),
        tool_step(6, "ACTIVE", "replace_file_content", replace.clone()),
        tool_step(6, "DONE", "replace_file_content", replace),
        tool_step(7, "ACTIVE", "multi_replace_file_content", multi.clone()),
        tool_step(7, "ERROR", "multi_replace_file_content", multi),
        // 引数が後から届く ACTIVE と、error の付いた DONE
        tool_step(8, "ACTIVE", "write_to_file", json!({})),
        step_line(
          CONVERSATION,
          8,
          "DONE",
          "tool",
          json!({"tool_name":"write_to_file","tool_info":{"name":"write_to_file","parameters":created,"error":"file exists"}}),
        ),
        step_line(
          CONVERSATION,
          9,
          "DONE",
          "agent_response",
          json!({"text_delta":"見出しを短くしました。","usage":{"input_tokens":20,"output_tokens":5}}),
        ),
        result_line(json!({"response":"確かめます。直します。見出しを短くしました。"})),
      ],
    );
    let tool_use = |id: &str, name: &str, summary: &str| TurnEvent::ToolUse {
      id: id.into(),
      name: name.into(),
      summary: summary.into(),
    };
    let tool_result = |id: &str, name: &str, ok: bool| TurnEvent::ToolResult {
      id: id.into(),
      name: name.into(),
      ok,
    };
    assert_eq!(
      events,
      vec![
        TurnEvent::TextDelta("確かめます。".into()),
        tool_use("step-3", "Glob", ""),
        tool_result("step-3", "Glob", true),
        tool_use("step-4", "Read", "abc12345.md"),
        tool_result("step-4", "Read", true),
        TurnEvent::TextDelta("直します。".into()),
        tool_use("step-6", "Edit", "abc12345.md"),
        tool_result("step-6", "Edit", true),
        tool_use("step-7", "Edit", "abc12345.md"),
        tool_result("step-7", "Edit", false),
        tool_use("step-8", "Write", ""),
        tool_result("step-8", "Write", false),
        TurnEvent::TextDelta("見出しを短くしました。".into()),
      ]
    );
    assert!(converter.breach().is_none());
    // 返答は最後の道具より後の文だけ（result の response はこの回の文を全部含むので使わない）。使用量はこの回の step の和
    match converter.conclude("", 7) {
      TurnEvent::Done {
        text,
        usage,
        session_id,
        stop_reason,
        ..
      } => {
        assert_eq!(text, "見出しを短くしました。");
        assert_eq!((usage.input_tokens, usage.output_tokens), (30, 7));
        assert_eq!(session_id.as_deref(), Some(CONVERSATION));
        assert_eq!(stop_reason, StopReason::EndTurn);
      }
      other => panic!("{other:?}"),
    }
    // 止めたときも、最後の道具より後の文だけ
    assert!(matches!(converter.stopped(0), TurnEvent::Done { text, .. } if text == "見出しを短くしました。"));
    // フォルダのパスと中身は流れない
    let relayed = format!("{events:?}");
    assert!(!relayed.contains(&*folder.dir.to_string_lossy()) && !relayed.contains("新しい文書"));
  }

  #[test]
  fn editor_stops_paths_outside_writes_outside_markdown_and_other_tools() {
    let work = editor_dir("breach");
    let folder = &work.folder;
    let dir = folder.dir.to_string_lossy().into_owned();
    #[cfg(unix)]
    {
      std::os::unix::fs::symlink("/etc/hosts", folder.dir.join("artifacts").join("link.md")).unwrap();
      std::os::unix::fs::symlink(std::env::temp_dir(), folder.dir.join("outside-link")).unwrap();
    }
    let cases: Vec<(&str, Value, &str, &str)> = vec![
      (
        "view_file",
        json!({"AbsolutePath":"/etc/passwd"}),
        "path_outside",
        OUTSIDE_PATH_MESSAGE,
      ),
      (
        "view_file",
        json!({"AbsolutePath":format!("{dir}/artifacts/../../secret.md")}),
        "path_outside",
        OUTSIDE_PATH_MESSAGE,
      ),
      (
        "view_file",
        json!({"AbsolutePath":format!("{dir}-other/a.md")}),
        "path_outside",
        OUTSIDE_PATH_MESSAGE,
      ),
      (
        "view_file",
        json!({"AbsolutePath":"artifacts/abc12345.md"}),
        "path_outside",
        OUTSIDE_PATH_MESSAGE,
      ),
      (
        "view_file",
        json!({"AbsolutePath":"~/.ssh/id_ed25519"}),
        "path_outside",
        OUTSIDE_PATH_MESSAGE,
      ),
      (
        "view_file",
        json!({"AbsolutePath":format!("{dir}/transcript.md"),"Extra":"/etc/hosts"}),
        "path_outside",
        OUTSIDE_PATH_MESSAGE,
      ),
      (
        "list_dir",
        json!({"DirectoryPath":"/"}),
        "path_outside",
        OUTSIDE_PATH_MESSAGE,
      ),
      (
        "list_dir",
        json!({"DirectoryPath":format!("{dir}/outside-link")}),
        "path_outside",
        OUTSIDE_PATH_MESSAGE,
      ),
      (
        "multi_replace_file_content",
        json!({"TargetFile":format!("{dir}/artifacts/link.md")}),
        "path_outside",
        OUTSIDE_PATH_MESSAGE,
      ),
      (
        "write_to_file",
        json!({"TargetFile":"/tmp/niho-docs-outside.md","CodeContent":"x"}),
        "path_outside",
        OUTSIDE_PATH_MESSAGE,
      ),
      (
        "write_to_file",
        json!({"TargetFile":format!("{dir}/transcript.md"),"CodeContent":"x"}),
        "write_outside",
        OUTSIDE_WRITE_MESSAGE,
      ),
      (
        "write_to_file",
        json!({"TargetFile":format!("{dir}/artifacts/notes.txt"),"CodeContent":"x"}),
        "write_outside",
        OUTSIDE_WRITE_MESSAGE,
      ),
      (
        "replace_file_content",
        json!({"TargetFile":format!("{dir}/artifacts/.hidden.md")}),
        "write_outside",
        OUTSIDE_WRITE_MESSAGE,
      ),
      (
        "replace_file_content",
        json!({"TargetFile":format!("{dir}/artifacts")}),
        "write_outside",
        OUTSIDE_WRITE_MESSAGE,
      ),
      (
        "write_to_file",
        json!({"TargetFile":format!("{dir}/.agents/rules/x.md")}),
        "write_outside",
        OUTSIDE_WRITE_MESSAGE,
      ),
      (
        "run_command",
        json!({"CommandLine":"ls"}),
        "tool:run_command",
        EDITOR_TOOL_MESSAGE,
      ),
      (
        "search_web",
        json!({"query":"x"}),
        "tool:search_web",
        EDITOR_TOOL_MESSAGE,
      ),
      (
        "read_url_content",
        json!({"Url":"https://example.com"}),
        "tool:read_url_content",
        EDITOR_TOOL_MESSAGE,
      ),
      (
        "browser_subagent",
        json!({}),
        "tool:browser_subagent",
        EDITOR_TOOL_MESSAGE,
      ),
      ("", json!({}), "tool", EDITOR_TOOL_MESSAGE),
    ];
    for (name, parameters, kind, message) in cases {
      let mut converter = AgyConverter::editor(None, folder.clone());
      let events = feed(
        &mut converter,
        &[
          init_line(EDITOR_AGENT_NAME),
          user_input(CONVERSATION),
          tool_step(1, "ACTIVE", name, parameters.clone()),
          step_line(
            CONVERSATION,
            2,
            "DONE",
            "agent_response",
            json!({"text_delta":"後の文"}),
          ),
        ],
      );
      assert!(events.is_empty(), "{name} {parameters}: {events:?}");
      assert_eq!(
        editor_breach(&converter),
        Some((kind, ReasonCode::NotConfigured, message)),
        "{name} {parameters}"
      );
    }
    // 名前の無い step・サブエージェントも止める
    let mut converter = AgyConverter::editor(None, folder.clone());
    feed(
      &mut converter,
      &[
        init_line(EDITOR_AGENT_NAME),
        step_line(CONVERSATION, 1, "ACTIVE", "tool", json!({})),
      ],
    );
    assert_eq!(editor_breach(&converter).map(|breach| breach.0), Some("tool"));
    let mut converter = AgyConverter::editor(None, folder.clone());
    feed(
      &mut converter,
      &[
        init_line(EDITOR_AGENT_NAME),
        step_line(
          CONVERSATION,
          1,
          "ACTIVE",
          "agent_response",
          json!({"subagent_info":{"name":"browser"}}),
        ),
      ],
    );
    assert_eq!(editor_breach(&converter).map(|breach| breach.0), Some("subagent"));
  }

  fn web_editor_dir(name: &str) -> EditorDir {
    let mut dir = editor_dir(name);
    dir.folder.web = true;
    dir
  }

  fn init_with_tools(tools: &[&str]) -> String {
    json!({"event":"init","init":{"model":"gemini-3.8-flash-low","cwd":"/x","tools":tools,"permission_mode":"request-review","agent":EDITOR_AGENT_NAME}}).to_string()
  }

  #[test]
  fn editor_agent_with_web_search_adds_only_the_web_tools() {
    let markdown = editor_agent_markdown("あなたは編集者です。", true);
    assert!(markdown.contains(
      "\ntools: [view_file, list_dir, write_to_file, replace_file_content, multi_replace_file_content, search_web, read_url_content]\n"
    ));
    assert!(markdown.contains("\nsubagent: false\n"));
    assert!(markdown.contains("\ncommandExecutionPolicy: off\n"));
    assert!(markdown.ends_with("あなたは編集者です。"));
    for denied in ["run_command", "browser", "send_command_input"] {
      assert!(!markdown.contains(denied), "{denied}");
    }
    // Web を切ったときは今までどおり
    assert!(editor_agent_markdown("x", false).starts_with(EDITOR_FRONTMATTER));
    assert!(!editor_agent_markdown("x", false).contains("search_web"));
  }

  #[test]
  fn editor_web_tools_become_tool_events_and_other_tools_still_stop() {
    let dir = web_editor_dir("web");
    let mut converter = AgyConverter::editor(None, dir.folder.clone());
    let events = feed(
      &mut converter,
      &[
        init_with_tools(&[
          "manage_task",
          "view_file",
          "run_command",
          "search_web",
          "read_url_content",
        ]),
        user_input(CONVERSATION),
        tool_step(1, "ACTIVE", "search_web", json!({"query":"秘密の検索語"})),
        tool_step(1, "DONE", "search_web", json!({"query":"秘密の検索語"})),
        tool_step(
          2,
          "DONE",
          "read_url_content",
          json!({"Url":"https://Shop.Example.jp/hours?id=1"}),
        ),
      ],
    );
    assert_eq!(
      events,
      vec![
        TurnEvent::ToolUse {
          id: "step-1".into(),
          name: "WebSearch".into(),
          summary: String::new()
        },
        TurnEvent::ToolResult {
          id: "step-1".into(),
          name: "WebSearch".into(),
          ok: true
        },
        TurnEvent::ToolUse {
          id: "step-2".into(),
          name: "WebFetch".into(),
          summary: "shop.example.jp".into()
        },
        TurnEvent::ToolResult {
          id: "step-2".into(),
          name: "WebFetch".into(),
          ok: true
        },
      ]
    );
    assert!(!format!("{events:?}").contains("秘密の検索語"));
    assert!(converter.breach().is_none());
    // Web を許しても、コマンド実行・ブラウザ・サブエージェントの道具と、ローカルのファイルを指す URL は止める
    let cases = [
      ("run_command", json!({"CommandLine":"ls"}), "tool:run_command"),
      ("browser_subagent", json!({}), "tool:browser_subagent"),
      ("read_url_content", json!({"Url":"file:///etc/passwd"}), "path_outside"),
      ("search_web", json!({"query":"x","Path":"/etc"}), "path_outside"),
    ];
    for (name, parameters, kind) in cases {
      let mut converter = AgyConverter::editor(None, dir.folder.clone());
      let events = feed(
        &mut converter,
        &[
          init_with_tools(&["run_command", "search_web", "read_url_content"]),
          user_input(CONVERSATION),
          tool_step(3, "ACTIVE", name, parameters),
        ],
      );
      assert!(events.is_empty(), "{name}");
      assert_eq!(
        converter.breach().map(|breach| breach.kind.as_str()),
        Some(kind),
        "{name}"
      );
    }
  }

  #[test]
  fn editor_init_without_search_web_is_a_notice_and_the_turn_goes_on() {
    let dir = web_editor_dir("web-missing");
    let mut converter = AgyConverter::editor(None, dir.folder.clone());
    let events = feed(
      &mut converter,
      &[init_line(EDITOR_AGENT_NAME), user_input(CONVERSATION)],
    );
    assert_eq!(
      events,
      vec![TurnEvent::Notice {
        code: NoticeCode::WebSearchUnsupported
      }]
    );
    assert!(converter.breach().is_none());
    // 一覧に search_web があれば知らせない。Web を切った回も知らせない
    let mut converter = AgyConverter::editor(None, dir.folder.clone());
    assert!(feed(&mut converter, &[init_with_tools(&["view_file", "search_web"])]).is_empty());
    let plain = editor_dir("web-off");
    let mut converter = AgyConverter::editor(None, plain.folder.clone());
    assert!(feed(&mut converter, &[init_line(EDITOR_AGENT_NAME)]).is_empty());
  }

  #[test]
  fn the_sixth_agy_search_web_stops_the_turn() {
    let dir = web_editor_dir("web-limit");
    let mut converter = AgyConverter::editor(None, dir.folder.clone());
    let mut lines = vec![
      init_with_tools(&["search_web", "read_url_content"]),
      user_input(CONVERSATION),
    ];
    for index in 1..=5 {
      lines.push(tool_step(index, "ACTIVE", "search_web", json!({"query":"q"})));
      lines.push(tool_step(index, "DONE", "search_web", json!({"query":"q"})));
    }
    lines.push(tool_step(
      9,
      "DONE",
      "read_url_content",
      json!({"Url":"https://a.example/"}),
    ));
    feed(&mut converter, &lines);
    assert!(converter.breach().is_none());
    feed(
      &mut converter,
      &[tool_step(10, "ACTIVE", "search_web", json!({"query":"q"}))],
    );
    assert_eq!(
      converter.breach().map(|breach| (breach.kind.as_str(), breach.code)),
      Some(("web_search_limit", ReasonCode::TransientFailure))
    );
  }

  #[test]
  fn editor_writes_without_a_known_target_are_stopped() {
    let work = editor_dir("unknown-target");
    // 書き先の無いまま終わった
    let mut converter = AgyConverter::editor(None, work.folder.clone());
    let events = feed(
      &mut converter,
      &[
        init_line(EDITOR_AGENT_NAME),
        tool_step(1, "ACTIVE", "write_to_file", json!({"CodeContent":"x"})),
        tool_step(1, "DONE", "write_to_file", json!({"CodeContent":"x"})),
      ],
    );
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(
      editor_breach(&converter),
      Some(("write_target_unknown", ReasonCode::NotConfigured, OUTSIDE_WRITE_MESSAGE))
    );
    // 終わりの step が来ないまま result が来た
    let mut converter = AgyConverter::editor(None, work.folder.clone());
    feed(
      &mut converter,
      &[
        init_line(EDITOR_AGENT_NAME),
        step_line(
          CONVERSATION,
          1,
          "ACTIVE",
          "tool",
          json!({"tool_name":"replace_file_content","tool_info":{"name":"replace_file_content","parameters":"{}"}}),
        ),
        result_line(json!({"response":"直しました。"})),
      ],
    );
    assert_eq!(
      editor_breach(&converter).map(|breach| breach.0),
      Some("write_target_unknown")
    );
  }

  #[test]
  fn editor_denied_actions_without_a_reply_and_the_wrong_agent_fail() {
    let work = editor_dir("denied");
    let folder = &work.folder;
    let document = folder.dir.join("artifacts").join("abc12345.md");
    let denied = json!([{"action":"read_file","display_name":"ViewFile"}]);
    // 返答が空なら失敗（道具を使った回は、道具より前の文と result の response は返答に数えない）
    for (mut lines, response) in [
      (vec![init_line(EDITOR_AGENT_NAME), user_input(CONVERSATION)], ""),
      (
        vec![
          init_line(EDITOR_AGENT_NAME),
          step_line(
            CONVERSATION,
            1,
            "DONE",
            "agent_response",
            json!({"text_delta":"読みます。"}),
          ),
          tool_step(2, "DONE", "view_file", json!({"AbsolutePath":document})),
        ],
        "読みます。",
      ),
    ] {
      let mut converter = AgyConverter::editor(None, folder.clone());
      lines.push(result_line(json!({"response":response,"denied_actions":denied})));
      feed(&mut converter, &lines);
      assert_eq!(
        editor_breach(&converter),
        Some(("denied_actions", ReasonCode::NotConfigured, EDITOR_DENIED_MESSAGE))
      );
    }
    // 返答があれば（断られたことを AI が書いた）そのまま返す
    let mut converter = AgyConverter::editor(None, folder.clone());
    feed(
      &mut converter,
      &[
        init_line(EDITOR_AGENT_NAME),
        step_line(
          CONVERSATION,
          1,
          "DONE",
          "agent_response",
          json!({"text_delta":"作業フォルダの外は読めませんでした。"}),
        ),
        result_line(json!({"response":"作業フォルダの外は読めませんでした。","denied_actions":denied})),
      ],
    );
    assert!(converter.breach().is_none());
    assert!(
      matches!(converter.conclude("", 0), TurnEvent::Done { text, .. } if text == "作業フォルダの外は読めませんでした。")
    );
    // 道具を使って返答が空なら、文書は直っているので空の返答で終わる。道具も返答も無ければ失敗
    let mut converter = AgyConverter::editor(None, folder.clone());
    feed(
      &mut converter,
      &[
        init_line(EDITOR_AGENT_NAME),
        tool_step(1, "DONE", "replace_file_content", json!({"TargetFile":document})),
        result_line(json!({"response":""})),
      ],
    );
    assert!(matches!(converter.conclude("", 0), TurnEvent::Done { text, .. } if text.is_empty()));
    let mut converter = AgyConverter::editor(None, folder.clone());
    feed(&mut converter, &[init_line(EDITOR_AGENT_NAME), result_line(json!({}))]);
    assert_eq!(
      error_of(converter.conclude("", 0)),
      (ReasonCode::TransientFailure, EMPTY_RESPONSE_MESSAGE.to_string())
    );
    // 工程用・文字起こし用のエージェントで起動したら止める。init が無いまま成功しても失敗
    for agent in [AGENT_NAME, READER_AGENT_NAME] {
      let mut converter = AgyConverter::editor(None, folder.clone());
      feed(&mut converter, &[init_line(agent)]);
      assert_eq!(
        editor_breach(&converter),
        Some(("init", ReasonCode::NotConfigured, EDITOR_INIT_MESSAGE))
      );
    }
    let mut converter = AgyConverter::editor(None, folder.clone());
    feed(&mut converter, &[result_line(json!({"response":"init 無し"}))]);
    assert_eq!(
      error_of(converter.conclude("", 0)),
      (ReasonCode::NotConfigured, EDITOR_INIT_MISSING_MESSAGE.to_string())
    );
    // 続きのはずが別の会話になったら、これまでどおり会話なし
    let mut converter = AgyConverter::editor(Some(OTHER.to_string()), folder.clone());
    feed(
      &mut converter,
      &[init_line(EDITOR_AGENT_NAME), user_input(CONVERSATION)],
    );
    assert_eq!(
      editor_breach(&converter).map(|breach| (breach.0, breach.1)),
      Some(("conversation_mismatch", ReasonCode::SessionNotFound))
    );
    // 工程の実行（書くだけ）では修正の道具も止める
    let mut writer = AgyConverter::new(None);
    feed(
      &mut writer,
      &[
        init_line(AGENT_NAME),
        tool_step(1, "ACTIVE", "replace_file_content", json!({"TargetFile":document})),
      ],
    );
    assert_eq!(
      writer.breach().map(|breach| breach.kind.as_str()),
      Some("tool:replace_file_content")
    );
  }

  #[test]
  fn stdin_is_one_json_line_with_the_prompt() {
    let bytes = stdin_for("記事を\n直して \"引用\" と \\ を含む");
    let text = String::from_utf8(bytes).unwrap();
    assert!(text.ends_with('\n'));
    assert_eq!(text.matches('\n').count(), 1, "the prompt stays on one line: {text}");
    // 日本語はそのまま、改行と `"` はエスケープする
    assert!(text.contains("記事を\\n直して \\\"引用\\\" と \\\\ を含む"));
    let value: Value = serde_json::from_str(text.trim_end()).unwrap();
    assert_eq!(
      value,
      json!({"event":"user","message":{"content":"記事を\n直して \"引用\" と \\ を含む"}})
    );
    // 先頭が `/` の指示は改行を 1 つ前置する
    let slash: Value = serde_json::from_slice(&stdin_for("/review この記事")).unwrap();
    assert_eq!(slash["message"]["content"], "\n/review この記事");
    let plain: Value = serde_json::from_slice(&stdin_for("a/b")).unwrap();
    assert_eq!(plain["message"]["content"], "a/b");
  }

  #[test]
  fn agent_markdown_has_the_tool_less_frontmatter_and_the_system_prompt() {
    assert_eq!(
      agent_markdown("あなたは編集者です。\n--- は区切りではない"),
      "---\nname: niho-docs-writer\ndescription: NIHO docs の工程を実行し、Markdown の本文だけを書く。\ntools: []\nmainAgent: true\nsubagent: false\ncommandExecutionPolicy: off\n---\nあなたは編集者です。\n--- は区切りではない"
    );
    // 空でもこの形で書く
    assert_eq!(agent_markdown(""), AGENT_FRONTMATTER);
    assert!(AGENT_FRONTMATTER.contains(&format!("\nname: {AGENT_NAME}\n")));
  }

  #[test]
  fn converts_deltas_and_sums_this_turns_usage() {
    let mut converter = AgyConverter::new(None);
    let events = feed(
      &mut converter,
      &[
        "Starting Antigravity CLI...".to_string(),
        init_line(AGENT_NAME),
        user_input(CONVERSATION),
        step_line(
          CONVERSATION,
          1,
          "ACTIVE",
          "agent_response",
          json!({"text_delta":"一\n"}),
        ),
        step_line(CONVERSATION, 1, "ACTIVE", "agent_response", json!({"text_delta":""})),
        step_line(
          CONVERSATION,
          1,
          "DONE",
          "agent_response",
          json!({"text_delta":"二\n","usage":{"input_tokens":2149,"output_tokens":15,"thinking_tokens":0,"cache_read_tokens":100,"total_tokens":2264},"duration_seconds":1.71}),
        ),
        // 同じ step の DONE が 2 回来ても 2 重に数えない
        step_line(
          CONVERSATION,
          1,
          "DONE",
          "agent_response",
          json!({"usage":{"input_tokens":2149,"output_tokens":15}}),
        ),
        step_line(CONVERSATION, 2, "DONE", "checkpoint", json!({})),
        step_line(
          CONVERSATION,
          3,
          "DONE",
          "agent_response",
          json!({"text_delta":"三","usage":{"input_tokens":10,"output_tokens":5,"cache_read_tokens":0}}),
        ),
        result_line(json!({"response":"一\n二\n三\n","duration_seconds":99.0})),
      ],
    );
    assert_eq!(
      events,
      vec![
        TurnEvent::TextDelta("一\n".into()),
        TurnEvent::TextDelta("二\n".into()),
        TurnEvent::TextDelta("三".into()),
      ]
    );
    assert!(converter.breach().is_none());
    // usage は step の和（result の累計 4524 / 40 は使わない）。duration は実測
    assert_eq!(
      converter.conclude("", 321),
      TurnEvent::Done {
        text: "一\n二\n三".into(),
        stop_reason: StopReason::EndTurn,
        session_id: Some(CONVERSATION.into()),
        usage: Usage {
          input_tokens: 2259,
          output_tokens: 20,
          cost_usd: None,
          model_used: Some("gemini-3.8-flash-low".into()),
        },
        duration_ms: 321,
        continuations: 0,
      }
    );
  }

  #[test]
  fn falls_back_to_the_deltas_and_rejects_an_empty_response() {
    let mut converter = AgyConverter::new(None);
    feed(
      &mut converter,
      &[
        init_line(AGENT_NAME),
        user_input(CONVERSATION),
        step_line(
          CONVERSATION,
          1,
          "DONE",
          "agent_response",
          json!({"text_delta":" 本文だけ \n"}),
        ),
        result_line(json!({"response":"  "})),
      ],
    );
    assert!(matches!(converter.conclude("", 0), TurnEvent::Done { text, .. } if text == "本文だけ"));

    let mut empty = AgyConverter::new(None);
    feed(
      &mut empty,
      &[init_line(AGENT_NAME), user_input(CONVERSATION), result_line(json!({}))],
    );
    assert_eq!(
      error_of(empty.conclude("", 0)),
      (ReasonCode::TransientFailure, EMPTY_RESPONSE_MESSAGE.to_string())
    );
  }

  #[test]
  fn init_must_name_the_writer_agent() {
    let mut converter = AgyConverter::new(None);
    let events = feed(
      &mut converter,
      &[
        init_line("default"),
        step_line(
          CONVERSATION,
          1,
          "ACTIVE",
          "agent_response",
          json!({"text_delta":"後の文"}),
        ),
      ],
    );
    assert!(events.is_empty());
    let breach = converter.breach().unwrap();
    assert_eq!(
      (breach.kind.as_str(), breach.code, breach.message.as_str()),
      ("init", ReasonCode::NotConfigured, INIT_AGENT_MESSAGE)
    );
    // agent の無い init も止める
    let mut converter = AgyConverter::new(None);
    feed(
      &mut converter,
      &[r#"{"event":"init","init":{"model":"m"}}"#.to_string()],
    );
    assert_eq!(converter.breach().map(|breach| breach.kind.as_str()), Some("init"));
  }

  #[test]
  fn success_without_init_is_not_configured_and_nothing_is_relayed() {
    let mut converter = AgyConverter::new(None);
    let events = feed(
      &mut converter,
      &[
        user_input(CONVERSATION),
        step_line(
          CONVERSATION,
          1,
          "DONE",
          "agent_response",
          json!({"text_delta":"init 無し"}),
        ),
        result_line(json!({"response":"init 無し"})),
      ],
    );
    assert!(events.is_empty(), "nothing is relayed before init is verified");
    assert_eq!(
      error_of(converter.conclude("", 0)),
      (ReasonCode::NotConfigured, INIT_MISSING_MESSAGE.to_string())
    );
  }

  #[test]
  fn a_different_conversation_on_resume_is_session_not_found_before_any_text() {
    let mut converter = AgyConverter::new(Some(CONVERSATION.to_string()));
    let events = feed(
      &mut converter,
      &[
        init_line(AGENT_NAME),
        user_input(OTHER),
        step_line(
          OTHER,
          1,
          "DONE",
          "agent_response",
          json!({"text_delta":"新しい会話の文"}),
        ),
        result_line(json!({"conversation_id":OTHER,"response":"新しい会話の文"})),
      ],
    );
    assert!(events.is_empty());
    let breach = converter.breach().unwrap();
    assert_eq!(breach.kind, "conversation_mismatch");
    assert_eq!(breach.code, ReasonCode::SessionNotFound);
    assert_eq!(breach.message, "このMacに会話の続きが見つかりませんでした。");
    // 止める合図と行き違っても、別の会話の ID は返さない
    assert!(matches!(converter.stopped(0), TurnEvent::Done { session_id: Some(id), .. } if id == CONVERSATION));

    // 同じ会話なら続きとして終わる（system_message の step は無視する）
    let mut converter = AgyConverter::new(Some(CONVERSATION.to_string()));
    let events = feed(
      &mut converter,
      &[
        init_line(AGENT_NAME),
        step_line(CONVERSATION, 4, "DONE", "system_message", json!({})),
        user_input(CONVERSATION),
        step_line(CONVERSATION, 6, "DONE", "agent_response", json!({"text_delta":"続き"})),
        result_line(json!({"response":"続き"})),
      ],
    );
    assert_eq!(events, vec![TurnEvent::TextDelta("続き".into())]);
    assert!(matches!(converter.conclude("", 0), TurnEvent::Done { session_id: Some(id), .. } if id == CONVERSATION));

    // 失敗の result の空の ID は食い違いとみなさない（モデル名違いを会話なしにしない）
    let mut converter = AgyConverter::new(Some(CONVERSATION.to_string()));
    feed(
      &mut converter,
      &[result_line(
        json!({"conversation_id":"","status":"ERROR","error":"invalid model selection (--model \"x\" --effort \"\")"}),
      )],
    );
    assert!(converter.breach().is_none());
    assert_eq!(error_of(converter.conclude("", 0)).0, ReasonCode::ModelNotFound);
  }

  #[test]
  fn tool_steps_other_than_manage_task_are_breaches() {
    let mut converter = AgyConverter::new(None);
    let events = feed(
      &mut converter,
      &[
        init_line(AGENT_NAME),
        user_input(CONVERSATION),
        step_line(
          CONVERSATION,
          1,
          "DONE",
          "tool",
          json!({"tool_name":"manage_task","tool_info":{"name":"manage_task","parameters":{},"output":"ok"}}),
        ),
        step_line(
          CONVERSATION,
          2,
          "ACTIVE",
          "agent_response",
          json!({"text_delta":"読みます"}),
        ),
        step_line(
          CONVERSATION,
          3,
          "ACTIVE",
          "tool",
          json!({"tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"path":"a"}}}),
        ),
        step_line(
          CONVERSATION,
          4,
          "ACTIVE",
          "agent_response",
          json!({"text_delta":"後の文"}),
        ),
      ],
    );
    assert_eq!(events, vec![TurnEvent::TextDelta("読みます".into())]);
    let breach = converter.breach().unwrap();
    assert_eq!(
      (breach.kind.as_str(), breach.code, breach.message.as_str()),
      ("tool:view_file", ReasonCode::NotConfigured, TOOL_USE_MESSAGE)
    );

    // 名前の無いツール・識別子でない名前も止める（名前はログに流さない）
    for extra in [json!({}), json!({"tool_name":"rm -rf /"})] {
      let mut converter = AgyConverter::new(None);
      feed(
        &mut converter,
        &[
          init_line(AGENT_NAME),
          step_line(CONVERSATION, 1, "ACTIVE", "tool", extra),
        ],
      );
      assert_eq!(converter.breach().map(|breach| breach.kind.as_str()), Some("tool"));
    }
  }

  #[test]
  fn subagents_and_denied_actions_are_breaches() {
    let mut converter = AgyConverter::new(None);
    feed(
      &mut converter,
      &[
        init_line(AGENT_NAME),
        step_line(
          CONVERSATION,
          1,
          "ACTIVE",
          "agent_response",
          json!({"subagent_info":{"name":"researcher"}}),
        ),
      ],
    );
    assert_eq!(converter.breach().map(|breach| breach.kind.as_str()), Some("subagent"));
    // 空の subagent_info はサブエージェントではない
    let mut converter = AgyConverter::new(None);
    feed(
      &mut converter,
      &[
        init_line(AGENT_NAME),
        step_line(
          CONVERSATION,
          1,
          "DONE",
          "agent_response",
          json!({"text_delta":"x","subagent_info":{}}),
        ),
        step_line(CONVERSATION, 2, "DONE", "agent_response", json!({"subagent_info":null})),
      ],
    );
    assert!(converter.breach().is_none());

    let mut converter = AgyConverter::new(None);
    feed(
      &mut converter,
      &[
        init_line(AGENT_NAME),
        user_input(CONVERSATION),
        result_line(json!({"denied_actions":[{"action":"read_file","display_name":"ViewFile"}]})),
      ],
    );
    let breach = converter.breach().unwrap();
    assert_eq!(
      (breach.kind.as_str(), breach.code, breach.message.as_str()),
      ("denied_actions", ReasonCode::NotConfigured, DENIED_ACTIONS_MESSAGE)
    );
    // 空の denied_actions は成功のまま
    let mut converter = AgyConverter::new(None);
    feed(
      &mut converter,
      &[
        init_line(AGENT_NAME),
        result_line(json!({"response":"本文","denied_actions":[]})),
      ],
    );
    assert!(converter.breach().is_none());
    assert!(matches!(converter.conclude("", 0), TurnEvent::Done { .. }));
  }

  #[test]
  fn error_results_follow_the_real_examples() {
    let model_error = "invalid model selection (--model \"gemini-nonexistent-9\" --effort \"\"): model gemini-nonexistent-9 is not recognized as a known model or custom model in settings\nAvailable models:\n  Gemini 3.8 Flash (High)\n  Gemini 3.8 Flash (Medium)";
    let mut converter = AgyConverter::new(None);
    feed(
      &mut converter,
      &[
        json!({"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":model_error}})
          .to_string(),
      ],
    );
    assert_eq!(
      error_of(converter.conclude(&format!("error: {model_error}"), 0)),
      (ReasonCode::ModelNotFound, AGY_MODEL_MESSAGE.to_string())
    );
    // 思考量の違い（結果の error が無くても stderr で判定する）
    for stderr in [
      "error: invalid model selection (--model \"gemini-3.8-flash\" --effort \"max\"): gemini-3.8-flash has no \"max\" effort (available: low, medium, high)",
      "error: invalid model selection (--model \"gemini-3.8-flash-medium\" --effort \"low\"): --model gemini-3.8-flash-medium conflicts with --effort=low",
      "error: invalid model selection (--model \"claude-sonnet-4-6\" --effort \"high\"): --effort is not supported for model \"claude-sonnet-4-6\"",
    ] {
      let mut converter = AgyConverter::new(None);
      feed(
        &mut converter,
        &[result_line(json!({"conversation_id":"","status":"ERROR"}))],
      );
      assert_eq!(error_of(converter.conclude(stderr, 0)).0, ReasonCode::ModelNotFound, "{stderr}");
    }
    // result が来ないまま終わった
    let converter = AgyConverter::new(None);
    assert_eq!(
      error_of(converter.conclude("error: authentication required", 0)).0,
      ReasonCode::CliLoginRequired
    );
    let converter = AgyConverter::new(Some(CONVERSATION.to_string()));
    assert_eq!(
      error_of(converter.conclude(
        &format!("warning: conversation \"{CONVERSATION}\" not found\nerror: boom"),
        0
      ))
      .0,
      ReasonCode::SessionNotFound
    );
    let converter = AgyConverter::new(None);
    assert_eq!(
      error_of(converter.conclude("panic: something", 0)),
      (
        ReasonCode::TransientFailure,
        "Antigravity CLI の実行に失敗しました。".to_string()
      )
    );
    // CANCELED などの成功でない status も判定にまわす
    let mut converter = AgyConverter::new(None);
    feed(
      &mut converter,
      &[
        init_line(AGENT_NAME),
        result_line(json!({"status":"CANCELED","response":"途中","error":"quota exceeded"})),
      ],
    );
    assert_eq!(error_of(converter.conclude("", 0)).0, ReasonCode::UsageLimitReached);
  }

  #[test]
  fn stopped_keeps_the_text_so_far_and_this_turns_usage() {
    let mut converter = AgyConverter::new(None);
    feed(
      &mut converter,
      &[
        init_line(AGENT_NAME),
        user_input(CONVERSATION),
        step_line(
          CONVERSATION,
          1,
          "DONE",
          "agent_response",
          json!({"text_delta":" 途中 ","usage":{"input_tokens":7,"output_tokens":3}}),
        ),
      ],
    );
    assert_eq!(
      converter.stopped(3),
      TurnEvent::Done {
        text: "途中".into(),
        stop_reason: StopReason::Stopped,
        session_id: Some(CONVERSATION.into()),
        usage: Usage {
          input_tokens: 7,
          output_tokens: 3,
          cost_usd: None,
          model_used: Some("gemini-3.8-flash-low".into()),
        },
        duration_ms: 3,
        continuations: 0,
      }
    );
    // 会話の ID を見ないまま止めたら、続きの ID（新しい会話なら無し）を返す。UUID でない ID は返さない
    assert!(matches!(
      AgyConverter::new(None).stopped(0),
      TurnEvent::Done { session_id: None, .. }
    ));
    let mut converter = AgyConverter::new(None);
    feed(&mut converter, &[init_line(AGENT_NAME), user_input("not-a-uuid")]);
    assert!(matches!(converter.stopped(0), TurnEvent::Done { session_id: None, .. }));
    let resumed = AgyConverter::new(Some(CONVERSATION.to_string()));
    assert!(matches!(resumed.stopped(0), TurnEvent::Done { session_id: Some(id), .. } if id == CONVERSATION));
  }
}
