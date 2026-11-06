//! Claude Code（`claude -p --output-format stream-json`）の起動引数と出力の読み取り。
//!
//! - 本人の設定（MCP・許可ルール・hooks・slash command）を読ませず、ツールを全部切る（`--setting-sources ""`・
//!   `--strict-mcp-config`・`--tools ""`・`--disable-slash-commands`）。init の一覧が空でなければ止める（fail closed）。
//! - システムプロンプトは 0600 のファイルにして `--system-prompt-file` で渡す（空でも渡す。Claude Code の既定の
//!   コーディング用の指示に戻さないため）。指示は標準入力で渡す。
//! - Claude Code は max_tokens で止まると同じ実行の中で自分で続きを頼む（最大 3 回。依頼文はイベントに出ない）。
//!   1 回の実行に複数のメッセージ（区間）が来るので、区間の境目の重なりを除いてつなぐ（merge.rs）。
//! - 修正の会話（`ToolPolicy::ProjectFolder`）だけは、呼び出し側の workspace を cwd にして Read・Edit・Write・Glob・Grep を許す
//!   （`--tools`・`--allowedTools`。`--restricted` で cwd の外のファイルは読み書きできず、書ける場所を決めたときは
//!   `--permission-mode dontAsk` ＋ `Edit(./<場所>/**)` でそこ以外への書き込みも断られる）。init の一覧がこの 5 つの
//!   部分集合でなければ止め、ほかのツール・サブエージェントの気配も止める（fail closed）。ツールの呼び出しと結果は
//!   `ToolUse`・`ToolResult`（ファイル名と成否だけ）で流し、`Done.text` は最後のツールの後の文（返答）にする。
//! - 修正の会話で `web_search` が true なら、Web の WebSearch・WebFetch も足す（#283。Bash は足さない）。init の一覧に
//!   Web の道具が無ければ（この版・この契約では使えない）`Notice { WebSearchUnsupported }` を出して検索なしで続け、
//!   WebSearch が 1 依頼で 5 回を超えたら止める。

use crate::classify::{
  classify_claude_process_failure, classify_claude_result, error_event, is_usage_limit_notice_only,
  normalize_for_match, ClaudeErrorSignals, REFUSAL_MESSAGE,
};
use crate::merge::merge_continuation;
use crate::process::{run_child, ChildExit, PrivateDir, TURN_DIR_PREFIX};
use crate::turn::{Breach, FolderAccess, SessionArg, StreamHandler, TurnCtx, WebSearchCount};
use crate::types::{Effort, NoticeCode, Provider, ReasonCode, StopReason, TurnEvent, Usage};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// 修正の会話で許すツール（Claude Code の組み込み。シェル・Web・サブエージェント・MCP は含めない）。
pub(crate) const FILE_TOOLS: [&str; 5] = ["Read", "Edit", "Write", "Glob", "Grep"];
/// 修正の会話で `web_search` のときだけ足す Web の道具（Claude Code の組み込み。Bash・Task・MCP は足さない。#283）。
pub(crate) const WEB_TOOLS: [&str; 2] = ["WebSearch", "WebFetch"];
/// 回数を数える検索の道具（WebFetch はページを読むだけなので数えない）。
const WEB_SEARCH_TOOL: &str = "WebSearch";
/// ツールの入力（input_json_delta）を貯める上限。Write の本文で大きくなるので、ファイル名が読めれば足りる分だけ持ち、
/// 超えたら assistant のメッセージ（入力の全体が入る）から読む。
const TOOL_INPUT_MAX_BYTES: usize = 256 * 1024;
/// 画面に出すファイル名の上限（文字数）。
const SUMMARY_MAX_CHARS: usize = 120;

const INIT_TOOLS_MESSAGE: &str =
  "Claude Code がツールを持ったまま起動したため止めました。Claude Code を最新に更新してから、もう一度試してください。";
const TOOL_USE_MESSAGE: &str =
  "Claude Code がツールを使おうとしたため止めました。Claude Code を最新に更新してから、もう一度試してください。";
const INIT_MISSING_MESSAGE: &str = "Claude Code がツールを切って起動したことを確かめられなかったため止めました。Claude Code を最新に更新してから、もう一度試してください。";
const INIT_FILE_TOOLS_MESSAGE: &str = "Claude Code が許したもの以外のツールを持ったまま起動したため止めました。Claude Code を最新に更新してから、もう一度試してください。";
const FILE_TOOL_USE_MESSAGE: &str = "Claude Code が許したもの以外のツールを使おうとしたため止めました。Claude Code を最新に更新してから、もう一度試してください。";
/// 思考だけで 1 回の出力の上限（max_tokens）に達したメッセージが、この回数だけ続いたら止める。
/// Sonnet 4.6 × 高は長い文書の書き直しで修正版を思考の中で下書きし、32,000 トークンを思考だけで使い切る。Claude Code の自動の
/// 続きでも思考がやり直しになり、12 分ずつ 3 回で 45 分の時間切れまで進まなかった（#18382 の実機）。思考量 中は 1 通目が思考
/// だけでも 2 通目で本文を書き始めたので、1 回では止めない。
const THINKING_ONLY_LIMIT: u32 = 2;
const THINKING_ONLY_MESSAGE: &str = "AI が考えるだけで出力の上限に 2 回続けて達し、本文を書けなかったため止めました。長い文書を書き直す工程は、モデルを「軽量」（思考量 低）にしてください。";

/// `--thinking-display` は `--help` に出ない隠しフラグなので、必要なフラグの確認では未対応の Claude Code を検出できない
/// （Desktop #16748）。未対応の版は「unknown option」で起動前に終わるため、実際に拒否されたら以降はこのフラグ無しで起動する
/// （思考の要約が出ないだけで、実行そのものは動く）。プロセスの間だけ覚え、Claude Code を更新したら忘れる。
static THINKING_DISPLAY_UNSUPPORTED: AtomicBool = AtomicBool::new(false);

fn thinking_display_supported() -> bool {
  !THINKING_DISPLAY_UNSUPPORTED.load(Ordering::SeqCst)
}

/// 更新した Claude Code は対応しているかもしれないので、拒否の記憶を消す。
pub(crate) fn reset_thinking_display_support() {
  THINKING_DISPLAY_UNSUPPORTED.store(false, Ordering::SeqCst);
}

/// 起動前に終わった Claude Code の stderr が、`--thinking-display` の拒否（unknown option）か。
pub(crate) fn is_unknown_thinking_display_option(stderr: &str) -> bool {
  let text = normalize_for_match(stderr);
  text.contains("--thinking-display")
    && (text.contains("unknown option") || text.contains("unrecognized option") || text.contains("unknown argument"))
}

/// 修正の会話の `--allowedTools`。書ける場所が無ければ 5 つ全部、あれば読むツールと `Edit(./<場所>/**)`（Edit の規則は
/// Write にも効く。dontAsk なので、この規則に合わない書き込みは確認なしで断られる）。
/// `folder.web` なら Web の道具（WebSearch・WebFetch）を後ろに足す。
pub(crate) fn allowed_file_tools(folder: &FolderAccess) -> String {
  let mut tools: Vec<String> = if folder.writable.is_empty() {
    FILE_TOOLS.iter().map(|tool| tool.to_string()).collect()
  } else {
    let mut tools: Vec<String> = ["Read", "Glob", "Grep"].iter().map(|tool| tool.to_string()).collect();
    tools.extend(folder.writable.iter().map(|dir| format!("Edit(./{dir}/**)")));
    tools
  };
  if folder.web {
    tools.extend(WEB_TOOLS.iter().map(|tool| tool.to_string()));
  }
  tools.join(",")
}

/// 修正の会話の `--tools`（使える道具の一覧）。ファイルの 5 つと、`folder.web` なら Web の 2 つ。
fn folder_tools(folder: &FolderAccess) -> String {
  let mut tools: Vec<&str> = FILE_TOOLS.to_vec();
  if folder.web {
    tools.extend(WEB_TOOLS);
  }
  tools.join(",")
}

/// `claude` の引数。順はこの通りで、空文字は独立した引数として渡す。
/// `folder` があれば（修正の会話）ファイルのツールを許し、無ければツールを全部切る。`--add-dir` は付けない
/// （`--restricted` は cwd と `--add-dir` の中だけを読み書きさせる）。
pub(crate) fn build_args(
  model: &str,
  effort: Option<Effort>,
  max_budget_usd: Option<f64>,
  system_prompt_path: &Path,
  session: &SessionArg,
  thinking_display: bool,
  folder: Option<&FolderAccess>,
) -> Vec<String> {
  let mut args: Vec<String> = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ]
  .iter()
  .map(|value| value.to_string())
  .collect();
  if thinking_display {
    // 思考の要約を求める。Sonnet 5 は思考表示の既定が omitted で、`thinking` ブロックは届いても本文が 0 文字になる。
    // `summarized` を明示すると要約済みの `thinking_delta` が届く（モデル内部の生の思考は対象外）。
    args.push("--thinking-display".to_string());
    args.push("summarized".to_string());
  }
  args.extend(
    [
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--restricted",
      "--tools",
    ]
    .iter()
    .map(|value| value.to_string()),
  );
  match folder {
    None => args.push(String::new()),
    Some(folder) => {
      args.push(folder_tools(folder));
      args.push("--allowedTools".to_string());
      args.push(allowed_file_tools(folder));
    }
  }
  args.push("--disable-slash-commands".to_string());
  args.push("--permission-mode".to_string());
  // 書ける場所を決めたときは、規則に合わない書き込みを確認なしで断る dontAsk。決めないときは cwd の中の編集を通す acceptEdits
  args.push(
    match folder {
      Some(folder) if folder.writable.is_empty() => "acceptEdits",
      _ => "dontAsk",
    }
    .to_string(),
  );
  args.push("--model".to_string());
  args.push(model.to_string());
  if let Some(effort) = effort {
    args.push("--effort".to_string());
    args.push(effort.as_str().to_string());
  }
  if let Some(budget) = max_budget_usd {
    args.push("--max-budget-usd".to_string());
    // f64 の Display は指数表記にならず、10.0 は "10"・0.5 は "0.5" になる
    args.push(format!("{budget}"));
  }
  args.push("--system-prompt-file".to_string());
  args.push(system_prompt_path.to_string_lossy().into_owned());
  args.extend(session.flag());
  args
}

/// 標準入力に書く指示。先頭が `/` だとスラッシュコマンドとして解釈されるので、改行を 1 つ前置する（実機で確認済み）。
pub(crate) fn stdin_for(user_prompt: &str) -> String {
  if user_prompt.starts_with('/') {
    format!("\n{user_prompt}")
  } else {
    user_prompt.to_string()
  }
}

/// `content_block` の種類がツールの呼び出しか（tool_use・server_tool_use・mcp_tool_use など）。
fn is_tool_block(block_type: &str) -> bool {
  block_type == "tool_use" || block_type.ends_with("_tool_use")
}

fn u64_field(value: &Value, key: &str) -> Option<u64> {
  value.get(key).and_then(Value::as_u64)
}

fn non_empty_str(value: &Value, key: &str) -> Option<String> {
  value
    .get(key)
    .and_then(Value::as_str)
    .map(str::trim)
    .filter(|text| !text.is_empty())
    .map(str::to_string)
}

fn usage_input_total(usage: &Value) -> u64 {
  ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
    .iter()
    .map(|key| u64_field(usage, key).unwrap_or(0))
    .sum()
}

/// 1 つのメッセージ（自動の続きの 1 回分）。
#[derive(Default)]
struct Segment {
  text: String,
  /// 思考でないブロック（本文・ツール）を始めた
  wrote: bool,
  stop_reason: Option<String>,
  input_tokens: u64,
  output_tokens: u64,
  /// `message_start.message.model`（このメッセージに答えた実モデルの ID）
  model: Option<String>,
}

#[derive(Default)]
struct ResultLine {
  subtype: String,
  is_error: bool,
  api_error_status: Option<u64>,
  /// 最後の 1 メッセージの文だけ
  text: String,
  errors: Vec<String>,
  stop_reason: Option<String>,
  duration_ms: Option<u64>,
  usage: Usage,
}

impl ResultLine {
  fn parse(value: &Value) -> Self {
    let str_field = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    let usage = value.get("usage");
    Self {
      subtype: str_field("subtype").unwrap_or_default(),
      is_error: value.get("is_error").and_then(Value::as_bool).unwrap_or(false),
      api_error_status: u64_field(value, "api_error_status"),
      text: str_field("result").unwrap_or_default(),
      errors: value
        .get("errors")
        .and_then(Value::as_array)
        .map(|errors| {
          errors
            .iter()
            .map(|error| error.as_str().map(str::to_string).unwrap_or_else(|| error.to_string()))
            .collect()
        })
        .unwrap_or_default(),
      stop_reason: str_field("stop_reason"),
      duration_ms: u64_field(value, "duration_ms"),
      usage: Usage {
        input_tokens: usage.map(usage_input_total).unwrap_or(0),
        output_tokens: usage.and_then(|usage| u64_field(usage, "output_tokens")).unwrap_or(0),
        cost_usd: value.get("total_cost_usd").and_then(Value::as_f64),
        // モデル名は result に無い。converter が message_start・init から足す
        model_used: None,
      },
    }
  }

  fn failed(&self) -> bool {
    self.is_error || self.subtype.starts_with("error") || self.api_error_status.is_some_and(|status| status >= 400)
  }
}

/// 流れている途中のツールの呼び出し（content_block の添字ごと）。
struct ToolBlock {
  id: String,
  name: String,
  /// input_json_delta をつないだもの（上限を超えたら捨てて assistant のメッセージから読む）
  json: String,
  overflow: bool,
}

/// ツールの入力のうち、画面に出してよいファイル名（パスの最後の部分）だけ。Read・Edit・Write は `file_path`、
/// Glob・Grep は `path`（無ければ空。検索語・パターン・本文は出さない）。
/// WebFetch は読むページのホスト名だけ（パス・クエリは出さない）、WebSearch は空（検索語は出さない）。
pub(crate) fn tool_summary(name: &str, input: &Value) -> String {
  let key = match name {
    "Read" | "Edit" | "Write" => "file_path",
    "Glob" | "Grep" => "path",
    "WebFetch" => {
      return input
        .get("url")
        .and_then(Value::as_str)
        .map(host_only)
        .unwrap_or_default()
    }
    _ => return String::new(),
  };
  input
    .get(key)
    .and_then(Value::as_str)
    .map(file_name_only)
    .unwrap_or_default()
}

/// URL のホスト名だけ（`http(s)://` の後ろから、`/`・`?`・`#` の前まで。利用者情報とポートは除く）。URL でなければ空。
pub(crate) fn host_only(url: &str) -> String {
  let lower = url.trim().to_ascii_lowercase();
  let Some(rest) = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")) else {
    return String::new();
  };
  let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
  let host = authority.rsplit('@').next().unwrap_or("");
  let host = host.split(':').next().unwrap_or("");
  host
    .chars()
    .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-'))
    .take(SUMMARY_MAX_CHARS)
    .collect()
}

/// パスの最後の部分（制御文字を除き、長すぎる名前は切る）。
pub(crate) fn file_name_only(path: &str) -> String {
  let name = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
  name
    .chars()
    .filter(|ch| !ch.is_control())
    .take(SUMMARY_MAX_CHARS)
    .collect()
}

/// stream-json → `TurnEvent`（Desktop の StreamConverter をツール無しの形に作り直したもの。修正の会話だけファイルの
/// ツールを通す）。
pub(crate) struct ClaudeConverter {
  session_id: String,
  /// ファイルのツール（FILE_TOOLS）を許すか（ToolPolicy::ProjectFolder）
  file_tools: bool,
  /// Web の道具（WEB_TOOLS）も許すか（修正の会話で `web_search` のとき）
  web_tools: bool,
  /// WebSearch の回数
  searches: WebSearchCount,
  init_seen: bool,
  /// init の `model`（message_start が来なかったときの代わり）
  init_model: Option<String>,
  segments: Vec<Segment>,
  /// 思考だけで max_tokens に達したメッセージが続いた回数（THINKING_ONLY_LIMIT で止める）
  thinking_only_streak: u32,
  auth_failed: bool,
  rate_limited: bool,
  assistant_errors: Vec<String>,
  /// error 付きの assistant の文（判定にだけ使う。本文は stream_event から取る）
  assistant_error_text: String,
  result: Option<ResultLine>,
  breach: Option<Breach>,
  tool_blocks: HashMap<u64, ToolBlock>,
  /// 呼び出しの ID → ツール名（結果の組に使う）
  tool_names: HashMap<String, String>,
  announced: HashSet<String>,
  finished: HashSet<String>,
}

impl ClaudeConverter {
  /// `session_id` は起動に使った ID（新規なら生成した UUID、続きなら resume の ID）。ツールは全部切った前提で読む。
  pub(crate) fn new(session_id: &str) -> Self {
    Self {
      session_id: session_id.to_string(),
      file_tools: false,
      web_tools: false,
      searches: WebSearchCount::default(),
      init_seen: false,
      init_model: None,
      segments: Vec::new(),
      thinking_only_streak: 0,
      auth_failed: false,
      rate_limited: false,
      assistant_errors: Vec::new(),
      assistant_error_text: String::new(),
      result: None,
      breach: None,
      tool_blocks: HashMap::new(),
      tool_names: HashMap::new(),
      announced: HashSet::new(),
      finished: HashSet::new(),
    }
  }

  /// 修正の会話（ファイルのツールを許した起動）の出力を読む。
  pub(crate) fn with_file_tools(session_id: &str) -> Self {
    Self {
      file_tools: true,
      ..Self::new(session_id)
    }
  }

  /// 修正の会話で Web の道具も許した起動（`--tools` に WebSearch・WebFetch を足した）の出力を読む。
  pub(crate) fn with_file_and_web_tools(session_id: &str) -> Self {
    Self {
      web_tools: true,
      ..Self::with_file_tools(session_id)
    }
  }

  /// 許したツールの名前か（init の一覧と呼び出しの両方に使う）。
  fn is_permitted_name(&self, name: &str) -> bool {
    self.file_tools && (FILE_TOOLS.contains(&name) || (self.web_tools && WEB_TOOLS.contains(&name)))
  }

  fn permits_tool(&self, block_type: &str, name: &str) -> bool {
    block_type == "tool_use" && self.is_permitted_name(name)
  }

  /// ツールの呼び出しを通すか。許していないツールと、上限を超えた検索は止める（breach を立てて false）。
  fn admit_tool(&mut self, block_type: &str, name: &str, id: &str) -> bool {
    if !self.permits_tool(block_type, name) {
      self.tool_breach(block_type);
      return false;
    }
    if name == WEB_SEARCH_TOOL {
      if let Some(breach) = self.searches.record(id) {
        self.breach = Some(breach);
        return false;
      }
    }
    true
  }

  /// ツールの呼び出しより前の文は実況。`Done.text` は最後のツールの呼び出しより後の文（返答）だけにする。
  fn cut_narration(&mut self) {
    for segment in &mut self.segments {
      segment.text.clear();
    }
  }

  fn announce_tool(&mut self, id: &str, name: &str, input: &Value, events: &mut Vec<TurnEvent>) {
    if id.is_empty() || !self.announced.insert(id.to_string()) {
      return;
    }
    self.tool_names.insert(id.to_string(), name.to_string());
    events.push(TurnEvent::ToolUse {
      id: id.to_string(),
      name: name.to_string(),
      summary: tool_summary(name, input),
    });
  }

  fn handle_user(&mut self, value: &Value, events: &mut Vec<TurnEvent>) {
    if !self.file_tools {
      return;
    }
    let Some(content) = value
      .get("message")
      .and_then(|message| message.get("content"))
      .and_then(Value::as_array)
    else {
      return;
    };
    for block in content {
      if block.get("type").and_then(Value::as_str) != Some("tool_result") {
        continue;
      }
      let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else {
        continue;
      };
      let Some(name) = self.tool_names.get(id).cloned() else {
        continue;
      };
      if !self.finished.insert(id.to_string()) {
        continue;
      }
      events.push(TurnEvent::ToolResult {
        id: id.to_string(),
        name,
        ok: !block.get("is_error").and_then(Value::as_bool).unwrap_or(false),
      });
    }
  }

  /// `--thinking-display` を拒否されて起動前に終わったか（init も result も無く、stderr が unknown option）。
  fn rejected_thinking_display(&self, exit: &ChildExit) -> bool {
    matches!(exit, ChildExit::Exited { stderr, .. }
      if !self.init_seen && self.result.is_none() && self.breach.is_none() && is_unknown_thinking_display_option(stderr))
  }

  fn current_segment(&mut self) -> &mut Segment {
    if self.segments.is_empty() {
      self.segments.push(Segment::default());
    }
    let last = self.segments.len() - 1;
    &mut self.segments[last]
  }

  /// 区間の文をつないだもの（max_tokens で終わった境目は重なりを除く）と、自動の続きの回数。
  /// 続きの回数は「max_tokens で終わり、後ろに区間が続いた」境目の数（思考だけで文が空の区間も数える）。
  fn assembled(&self) -> (String, u32) {
    let mut text = String::new();
    let mut continuations = 0;
    let mut previous_hit_max_tokens = false;
    for segment in &self.segments {
      if previous_hit_max_tokens {
        continuations += 1;
        text = merge_continuation(&text, &segment.text).0;
      } else {
        text.push_str(&segment.text);
      }
      previous_hit_max_tokens = segment.stop_reason.as_deref() == Some("max_tokens");
    }
    (text.trim().to_string(), continuations)
  }

  /// 実際に答えたモデルの ID（最後に答えたメッセージの `message_start`、無ければ init の `model`）。
  fn model_used(&self) -> Option<String> {
    self
      .segments
      .iter()
      .rev()
      .find_map(|segment| segment.model.clone())
      .or_else(|| self.init_model.clone())
  }

  /// 分かっている分の使用量（result があればそれ、無ければ区間の合計）。
  fn known_usage(&self) -> Usage {
    if let Some(result) = &self.result {
      return Usage {
        model_used: self.model_used(),
        ..result.usage.clone()
      };
    }
    Usage {
      input_tokens: self.segments.iter().map(|segment| segment.input_tokens).sum(),
      output_tokens: self.segments.iter().map(|segment| segment.output_tokens).sum(),
      cost_usd: None,
      model_used: self.model_used(),
    }
  }

  fn check_init(&mut self, value: &Value, events: &mut Vec<TurnEvent>) {
    self.init_model = non_empty_str(value, "model");
    let is_empty = |key: &str| value.get(key).and_then(Value::as_array).is_some_and(Vec::is_empty);
    // 修正の会話: ツールの一覧が許したもの（ファイルの 5 つと、許したときは Web の 2 つ）の部分集合
    // （一覧が無い・名前でないものがあれば違反）
    let tools = value.get("tools").and_then(Value::as_array);
    let tools_ok = if self.file_tools {
      tools.is_some_and(|tools| {
        tools
          .iter()
          .all(|tool| tool.as_str().is_some_and(|name| self.is_permitted_name(name)))
      })
    } else {
      is_empty("tools")
    };
    if tools_ok && is_empty("mcp_servers") {
      self.init_seen = true;
      // Web を頼んだのに一覧に Web の道具が 1 つも無い（この版・この契約では使えない）。黙って落とさず、検索なしで続ける
      let has_web = tools.is_some_and(|tools| {
        tools
          .iter()
          .any(|tool| tool.as_str().is_some_and(|name| WEB_TOOLS.contains(&name)))
      });
      if self.web_tools && !has_web {
        events.push(TurnEvent::Notice {
          code: NoticeCode::WebSearchUnsupported,
        });
      }
    } else {
      self.breach = Some(Breach {
        kind: "init".to_string(),
        code: ReasonCode::NotConfigured,
        message: if self.file_tools {
          INIT_FILE_TOOLS_MESSAGE
        } else {
          INIT_TOOLS_MESSAGE
        }
        .to_string(),
      });
    }
  }

  fn tool_breach(&mut self, block_type: &str) {
    self.breach = Some(Breach {
      kind: block_type.to_string(),
      code: ReasonCode::NotConfigured,
      message: if self.file_tools {
        FILE_TOOL_USE_MESSAGE
      } else {
        TOOL_USE_MESSAGE
      }
      .to_string(),
    });
  }

  fn handle_stream_event(&mut self, event: &Value, events: &mut Vec<TurnEvent>) {
    match event.get("type").and_then(Value::as_str) {
      Some("message_start") => {
        let input_tokens = event
          .get("message")
          .and_then(|message| message.get("usage"))
          .map(usage_input_total)
          .unwrap_or(0);
        self.segments.push(Segment {
          input_tokens,
          model: event.get("message").and_then(|message| non_empty_str(message, "model")),
          ..Segment::default()
        });
      }
      Some("content_block_start") => {
        let block = event.get("content_block");
        let block_type = block
          .and_then(|block| block.get("type"))
          .and_then(Value::as_str)
          .unwrap_or("");
        if !block_type.is_empty() && block_type != "thinking" && block_type != "redacted_thinking" {
          self.current_segment().wrote = true;
        }
        if is_tool_block(block_type) {
          let name = block
            .and_then(|block| block.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("");
          let id = block
            .and_then(|block| block.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
          if !self.admit_tool(block_type, name, &id) {
            return;
          }
          self.cut_narration();
          self.tool_blocks.insert(
            u64_field(event, "index").unwrap_or(0),
            ToolBlock {
              id,
              name: name.to_string(),
              json: String::new(),
              overflow: false,
            },
          );
        }
      }
      Some("content_block_stop") => {
        if let Some(block) = self.tool_blocks.remove(&u64_field(event, "index").unwrap_or(0)) {
          let input = if block.overflow || block.json.trim().is_empty() {
            None
          } else {
            serde_json::from_str::<Value>(&block.json).ok()
          };
          // 入力が読めなかった（大きすぎる・壊れた）ときは assistant のメッセージで知らせる
          if let Some(input) = input {
            self.announce_tool(&block.id, &block.name, &input, events);
          }
        }
      }
      Some("content_block_delta") => {
        let Some(delta) = event.get("delta") else { return };
        match delta.get("type").and_then(Value::as_str) {
          Some("input_json_delta") => {
            let index = u64_field(event, "index").unwrap_or(0);
            if let (Some(block), Some(part)) = (
              self.tool_blocks.get_mut(&index),
              delta.get("partial_json").and_then(Value::as_str),
            ) {
              if block.json.len() + part.len() > TOOL_INPUT_MAX_BYTES {
                block.overflow = true;
                block.json.clear();
              } else if !block.overflow {
                block.json.push_str(part);
              }
            }
          }
          Some("text_delta") => {
            if let Some(text) = delta
              .get("text")
              .and_then(Value::as_str)
              .filter(|text| !text.is_empty())
            {
              let segment = self.current_segment();
              segment.text.push_str(text);
              segment.wrote = true;
              events.push(TurnEvent::TextDelta(text.to_string()));
            }
          }
          Some("thinking_delta") => {
            if let Some(text) = delta
              .get("thinking")
              .and_then(Value::as_str)
              .filter(|text| !text.is_empty())
            {
              events.push(TurnEvent::ThinkingDelta(text.to_string()));
            }
          }
          _ => {}
        }
      }
      Some("message_delta") => {
        let stop_reason = event
          .get("delta")
          .and_then(|delta| delta.get("stop_reason"))
          .and_then(Value::as_str)
          .map(str::to_string);
        let output_tokens = event.get("usage").and_then(|usage| u64_field(usage, "output_tokens"));
        let segment = self.current_segment();
        let thinking_only = stop_reason
          .as_deref()
          .map(|reason| reason == "max_tokens" && !segment.wrote);
        if let Some(stop_reason) = stop_reason {
          segment.stop_reason = Some(stop_reason);
        }
        if let Some(output_tokens) = output_tokens {
          segment.output_tokens = output_tokens;
        }
        match thinking_only {
          Some(true) => self.thinking_only_streak += 1,
          Some(false) => self.thinking_only_streak = 0,
          None => {}
        }
        if self.thinking_only_streak >= THINKING_ONLY_LIMIT && self.breach.is_none() {
          self.breach = Some(Breach {
            kind: "thinking_only".to_string(),
            code: ReasonCode::TransientFailure,
            message: THINKING_ONLY_MESSAGE.to_string(),
          });
        }
      }
      _ => {}
    }
  }

  fn handle_assistant(&mut self, value: &Value, events: &mut Vec<TurnEvent>) {
    let content = value
      .get("message")
      .and_then(|message| message.get("content"))
      .and_then(Value::as_array);
    // 部分メッセージを取りこぼしたときの保険（許していないツールの気配は fail closed。許したツールは呼び出しを知らせる）
    for block in content.into_iter().flatten() {
      let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
      if !is_tool_block(block_type) {
        continue;
      }
      let name = block.get("name").and_then(Value::as_str).unwrap_or("");
      let id = block.get("id").and_then(Value::as_str).unwrap_or("");
      if !self.admit_tool(block_type, name, id) {
        return;
      }
      if !self.announced.contains(id) {
        self.cut_narration();
      }
      let input = block.get("input").cloned().unwrap_or(Value::Null);
      self.announce_tool(id, name, &input, events);
    }
    // 本文は stream_event から取る（assistant の content を足すと重複になる）。error 付きの文は判定にだけ使う
    if let Some(error) = value.get("error").and_then(Value::as_str) {
      self.assistant_errors.push(error.to_string());
      for block in content.into_iter().flatten() {
        if let Some(text) = block.get("text").and_then(Value::as_str) {
          self.assistant_error_text.push('\n');
          self.assistant_error_text.push_str(text);
        }
      }
    }
  }
}

impl StreamHandler for ClaudeConverter {
  fn process_line(&mut self, line: &str) -> Vec<TurnEvent> {
    let mut events = Vec::new();
    let trimmed = line.trim();
    if trimmed.is_empty() || self.breach.is_some() {
      return events;
    }
    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
      return events;
    };
    // 親ツール由来のイベント自体が、ツールまたはサブエージェント実行の証拠なので fail closed にする。
    if value.get("parent_tool_use_id").is_some_and(|id| !id.is_null()) {
      self.tool_breach("nested_tool_use");
      return events;
    }
    match value.get("type").and_then(Value::as_str) {
      Some("system") => match value.get("subtype").and_then(Value::as_str) {
        Some("init") => self.check_init(&value, &mut events),
        Some("api_retry") if value.get("error").and_then(Value::as_str) == Some("authentication_failed") => {
          self.auth_failed = true;
        }
        _ => {}
      },
      Some("rate_limit_event") => {
        let status = value
          .get("rate_limit_info")
          .and_then(|info| info.get("status"))
          .or_else(|| value.get("status"))
          .and_then(Value::as_str);
        if status == Some("rejected") {
          self.rate_limited = true;
        }
      }
      Some("stream_event") => {
        if let Some(event) = value.get("event") {
          self.handle_stream_event(event, &mut events);
        }
      }
      Some("assistant") => self.handle_assistant(&value, &mut events),
      Some("user") => self.handle_user(&value, &mut events),
      Some("result") => self.result = Some(ResultLine::parse(&value)),
      _ => {}
    }
    // ツールが無いことを init で確かめるまでは流さない（init は最初に来る）
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
    let (text, continuations) = self.assembled();
    TurnEvent::Done {
      text,
      stop_reason: StopReason::Stopped,
      session_id: Some(self.session_id.clone()),
      usage: self.known_usage(),
      duration_ms: elapsed_ms,
      continuations,
    }
  }

  fn conclude(&self, stderr: &str, elapsed_ms: u64) -> TurnEvent {
    let provider = Provider::ClaudeCode;
    let Some(result) = &self.result else {
      // result が出ないまま終わった（起動前の失敗・会話なし・異常終了）は stderr で判定する
      return error_event(provider, classify_claude_process_failure(stderr), None);
    };
    if result.failed() {
      let mut text = result.text.clone();
      for error in &result.errors {
        text.push('\n');
        text.push_str(error);
      }
      text.push_str(&self.assistant_error_text);
      let (code, message) = classify_claude_result(&ClaudeErrorSignals {
        api_error_status: result.api_error_status,
        auth_failed: self.auth_failed,
        rate_limited: self.rate_limited,
        assistant_errors: &self.assistant_errors,
        subtype: &result.subtype,
        text: &text,
      });
      return error_event(provider, code, message);
    }
    if !self.init_seen {
      // init を検査できないまま成功した。ツールを切れていた保証が無いので失敗にする
      return error_event(provider, ReasonCode::NotConfigured, Some(INIT_MISSING_MESSAGE));
    }
    if result.stop_reason.as_deref() == Some("refusal") {
      return error_event(provider, ReasonCode::TransientFailure, Some(REFUSAL_MESSAGE));
    }
    let (mut text, continuations) = self.assembled();
    if text.is_empty() {
      text = result.text.trim().to_string();
    }
    // 正常終了に見えて、本文が上限の通知だけ（自動の続きの途中で上限に達した場合は最後のメッセージが通知になる）
    if is_usage_limit_notice_only(&result.text) || is_usage_limit_notice_only(&text) {
      return error_event(provider, ReasonCode::UsageLimitReached, None);
    }
    TurnEvent::Done {
      text,
      stop_reason: if result.stop_reason.as_deref() == Some("max_tokens") {
        StopReason::MaxTokens
      } else {
        StopReason::EndTurn
      },
      session_id: Some(self.session_id.clone()),
      usage: self.known_usage(),
      duration_ms: result.duration_ms.unwrap_or(elapsed_ms),
      continuations,
    }
  }
}

pub(crate) fn run(ctx: &TurnCtx, emit: &mut dyn FnMut(TurnEvent)) -> TurnEvent {
  let session = match SessionArg::for_request(ctx.req) {
    Ok(session) => session,
    Err(err) => return ctx.setup_failed(format!("session id: {err}")),
  };
  let dir = match PrivateDir::create(&ctx.runtime.scratch_dir, TURN_DIR_PREFIX) {
    Ok(dir) => dir,
    Err(err) => return ctx.setup_failed(format!("scratch dir: {err}")),
  };
  ctx.running.set_private_dir(Some(dir.path().to_path_buf()));
  // 空でも必ず書いて渡す（省くと Claude Code の既定のコーディング用の指示に戻る）
  let prompt_path = match dir.write("system-prompt.txt", ctx.req.system_prompt.as_bytes()) {
    Ok(path) => path,
    Err(err) => return ctx.setup_failed(format!("system prompt file: {err}")),
  };
  let stdin = stdin_for(&ctx.req.user_prompt).into_bytes();
  let mut thinking_display = thinking_display_supported();
  loop {
    let mut converter = match &ctx.folder {
      Some(folder) if folder.web => ClaudeConverter::with_file_and_web_tools(session.id()),
      Some(_) => ClaudeConverter::with_file_tools(session.id()),
      None => ClaudeConverter::new(session.id()),
    };
    if ctx.running.is_stop_requested() {
      return ctx.finish(&converter, None);
    }
    let args = build_args(
      &ctx.req.model,
      ctx.req.effort,
      ctx.req.max_budget_usd,
      &prompt_path,
      &session,
      thinking_display,
      ctx.folder.as_ref(),
    );
    let exit = run_child(ctx, ctx.command(&args, &[]), stdin.clone(), &mut converter, emit);
    // 未対応の Claude Code は隠しフラグを unknown option で拒否して、init の前（何も流す前）に終わる。フラグ無しで
    // 同じ依頼を 1 回だけやり直す（会話は作られる前なので同じ ID でよい）。以降の実行も付けない。
    if thinking_display && !ctx.running.is_silenced() && converter.rejected_thinking_display(&exit) {
      THINKING_DISPLAY_UNSUPPORTED.store(true, Ordering::SeqCst);
      ctx.log("thinking_display_unsupported", json!({}));
      thinking_display = false;
      continue;
    }
    return ctx.finish(&converter, Some(exit));
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::classify::MAX_BUDGET_MESSAGE;
  use std::path::PathBuf;

  const SESSION: &str = "11111111-2222-4333-8444-555555555555";
  const INIT: &str =
    r#"{"type":"system","subtype":"init","session_id":"s","tools":[],"mcp_servers":[],"model":"claude-sonnet-5"}"#;

  fn stream(event: Value) -> String {
    json!({ "type": "stream_event", "event": event, "parent_tool_use_id": null }).to_string()
  }

  fn message_start(input: u64) -> String {
    stream(
      json!({"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":input,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}),
    )
  }

  fn text(text: &str) -> String {
    stream(json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}}))
  }

  fn thinking(text: &str) -> String {
    stream(json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":text}}))
  }

  fn message_delta(stop_reason: &str, output: u64) -> String {
    stream(json!({"type":"message_delta","delta":{"stop_reason":stop_reason},"usage":{"output_tokens":output}}))
  }

  fn result(extra: Value) -> String {
    let mut base = json!({"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"result":"","stop_reason":"end_turn","session_id":"s","total_cost_usd":0.25,
      "usage":{"input_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000,"output_tokens":20}});
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
      for (key, value) in extra {
        base.insert(key.clone(), value.clone());
      }
    }
    base.to_string()
  }

  fn feed(converter: &mut ClaudeConverter, lines: &[String]) -> Vec<TurnEvent> {
    lines.iter().flat_map(|line| converter.process_line(line)).collect()
  }

  fn error_code(event: &TurnEvent) -> Option<ReasonCode> {
    match event {
      TurnEvent::Error { reason_code, .. } => Some(*reason_code),
      _ => None,
    }
  }

  #[test]
  fn converts_thinking_and_text_deltas_and_skips_empty_ones() {
    let mut converter = ClaudeConverter::new(SESSION);
    let events = feed(
      &mut converter,
      &[
        INIT.to_string(),
        message_start(10),
        stream(json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}})),
        thinking(""),
        thinking("見出しを整えます。"),
        stream(json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}})),
        stream(json!({"type":"content_block_stop","index":0})),
        stream(json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}})),
        text("こんに"),
        text(""),
        text("ちは"),
        message_delta("end_turn", 20),
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"こんにちは"}]},"parent_tool_use_id":null}"#
          .to_string(),
        "not json".to_string(),
        result(json!({"result":"こんにちは"})),
      ],
    );
    assert_eq!(
      events,
      vec![
        TurnEvent::ThinkingDelta("見出しを整えます。".into()),
        TurnEvent::TextDelta("こんに".into()),
        TurnEvent::TextDelta("ちは".into()),
      ]
    );
    assert_eq!(
      converter.conclude("", 99),
      TurnEvent::Done {
        text: "こんにちは".into(),
        stop_reason: StopReason::EndTurn,
        session_id: Some(SESSION.into()),
        usage: Usage {
          input_tokens: 1110,
          output_tokens: 20,
          cost_usd: Some(0.25),
          model_used: Some("claude-sonnet-5".into()),
        },
        duration_ms: 1234,
        continuations: 0,
      }
    );
  }

  #[test]
  fn three_segments_are_merged_at_max_tokens_boundaries() {
    let mut converter = ClaudeConverter::new(SESSION);
    feed(
      &mut converter,
      &[
        INIT.to_string(),
        message_start(10),
        text("1: 一\n2: 二\n3: 三"),
        message_delta("max_tokens", 5),
        message_start(20),
        text("2: 二\n3: 三\n4: 四\n5: 五"),
        message_delta("max_tokens", 6),
        message_start(30),
        text("5: 五\n6: 六\n"),
        message_delta("end_turn", 7),
        result(json!({"result":"5: 五\n6: 六\n","duration_ms":4321})),
      ],
    );
    match converter.conclude("", 0) {
      TurnEvent::Done {
        text,
        continuations,
        stop_reason,
        duration_ms,
        ..
      } => {
        assert_eq!(text, "1: 一\n2: 二\n3: 三\n4: 四\n5: 五\n6: 六");
        assert_eq!(continuations, 2);
        assert_eq!(stop_reason, StopReason::EndTurn);
        assert_eq!(duration_ms, 4321);
      }
      other => panic!("unexpected {other:?}"),
    }
  }

  #[test]
  fn thinking_only_segment_that_hits_max_tokens_is_counted() {
    let mut converter = ClaudeConverter::new(SESSION);
    feed(
      &mut converter,
      &[
        INIT.to_string(),
        message_start(10),
        thinking("長く考えた"),
        message_delta("max_tokens", 5),
        message_start(20),
        text("本文"),
        message_delta("end_turn", 6),
        result(json!({"result":"本文"})),
      ],
    );
    match converter.conclude("", 0) {
      TurnEvent::Done {
        text, continuations, ..
      } => {
        assert_eq!(text, "本文");
        assert_eq!(continuations, 1);
      }
      other => panic!("unexpected {other:?}"),
    }
    // 最後の区間が max_tokens なら、後ろに区間が続かないので数えない
    let mut converter = ClaudeConverter::new(SESSION);
    feed(
      &mut converter,
      &[
        INIT.to_string(),
        message_start(10),
        text("途中"),
        message_delta("max_tokens", 5),
      ],
    );
    assert_eq!(converter.assembled(), ("途中".to_string(), 0));
  }

  #[test]
  fn two_thinking_only_max_tokens_messages_in_a_row_stop_the_turn() {
    // 思考だけで上限に達したメッセージが 2 回続いたら止める（自動の続きでも思考がやり直しになり、本文が出ない）
    let mut converter = ClaudeConverter::new(SESSION);
    feed(
      &mut converter,
      &[
        INIT.to_string(),
        message_start(10),
        stream(json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}})),
        thinking("修正版を思考の中で下書きする"),
        message_delta("max_tokens", 32000),
      ],
    );
    assert!(converter.breach().is_none(), "1 回目では止めない");
    feed(
      &mut converter,
      &[
        message_start(20),
        stream(json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}})),
        thinking("また最初から下書きする"),
        message_delta("max_tokens", 32000),
      ],
    );
    let breach = converter.breach().expect("2 回続いたら止める");
    assert_eq!(breach.kind, "thinking_only");
    assert_eq!(breach.code, ReasonCode::TransientFailure);
    assert!(breach.message.contains("軽量"));
  }

  #[test]
  fn a_thinking_only_message_followed_by_text_does_not_stop() {
    // 思考量 中の実測: 1 通目は思考だけで上限、2 通目で本文を書き始める。本文やツールを始めたメッセージは数えない
    let mut converter = ClaudeConverter::new(SESSION);
    feed(
      &mut converter,
      &[
        INIT.to_string(),
        message_start(10),
        thinking("長く考えた"),
        message_delta("max_tokens", 32000),
        message_start(20),
        thinking("少し考えた"),
        stream(json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}})),
        text("本文の途中"),
        message_delta("max_tokens", 32000),
        message_start(30),
        thinking("考えた"),
        message_delta("max_tokens", 32000),
      ],
    );
    assert!(converter.breach().is_none());
  }

  #[test]
  fn result_stop_reason_max_tokens_becomes_max_tokens() {
    let mut converter = ClaudeConverter::new(SESSION);
    feed(
      &mut converter,
      &[
        INIT.to_string(),
        message_start(1),
        text("途中まで"),
        result(json!({"stop_reason":"max_tokens"})),
      ],
    );
    match converter.conclude("", 0) {
      TurnEvent::Done { stop_reason, text, .. } => {
        assert_eq!(stop_reason, StopReason::MaxTokens);
        assert_eq!(text, "途中まで");
      }
      other => panic!("unexpected {other:?}"),
    }
  }

  #[test]
  fn refusal_becomes_an_error() {
    let mut converter = ClaudeConverter::new(SESSION);
    feed(
      &mut converter,
      &[
        INIT.to_string(),
        result(json!({"stop_reason":"refusal","result":"..."})),
      ],
    );
    assert_eq!(
      converter.conclude("", 0),
      TurnEvent::Error {
        reason_code: ReasonCode::TransientFailure,
        message: REFUSAL_MESSAGE.into()
      }
    );
  }

  #[test]
  fn falls_back_to_the_result_text_when_no_delta_arrives() {
    let mut converter = ClaudeConverter::new(SESSION);
    feed(
      &mut converter,
      &[INIT.to_string(), result(json!({"result":"  おわり  "}))],
    );
    match converter.conclude("", 0) {
      TurnEvent::Done { text, .. } => assert_eq!(text, "おわり"),
      other => panic!("unexpected {other:?}"),
    }
  }

  #[test]
  fn real_failure_examples_are_classified() {
    // 未ログイン
    let mut converter = ClaudeConverter::new(SESSION);
    feed(
      &mut converter,
      &[
        INIT.to_string(),
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Not logged in · Please run /login"}]},"error":"authentication_failed"}"#.to_string(),
        r#"{"type":"result","subtype":"success","is_error":true,"api_error_status":null,"result":"Not logged in · Please run /login","stop_reason":"stop_sequence"}"#.to_string(),
      ],
    );
    assert_eq!(
      converter.conclude("", 0),
      TurnEvent::Error {
        reason_code: ReasonCode::CliLoginRequired,
        message: "このMacの Claude Code にログインしてください。".into()
      }
    );

    // 会話なし（init は来ない）
    let mut converter = ClaudeConverter::new(SESSION);
    feed(
      &mut converter,
      &[format!(
        r#"{{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["No conversation found with session ID: {SESSION}"]}}"#
      )],
    );
    assert_eq!(
      error_code(&converter.conclude("", 0)),
      Some(ReasonCode::SessionNotFound)
    );

    // モデル名違い
    let mut converter = ClaudeConverter::new(SESSION);
    feed(
      &mut converter,
      &[
        INIT.to_string(),
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"There's an issue with the selected model (x). It may not exist or you may not have access to it."}]},"error":"model_not_found"}"#.to_string(),
        r#"{"type":"result","subtype":"success","is_error":true,"api_error_status":404,"result":"There's an issue with the selected model (x). It may not exist or you may not have access to it."}"#.to_string(),
      ],
    );
    assert_eq!(error_code(&converter.conclude("", 0)), Some(ReasonCode::ModelNotFound));

    // 費用の上限
    let mut converter = ClaudeConverter::new(SESSION);
    feed(
      &mut converter,
      &[
        INIT.to_string(),
        r#"{"type":"result","subtype":"error_max_budget_usd","is_error":true}"#.to_string(),
      ],
    );
    assert_eq!(
      converter.conclude("", 0),
      TurnEvent::Error {
        reason_code: ReasonCode::TransientFailure,
        message: MAX_BUDGET_MESSAGE.into()
      }
    );

    // api_retry の authentication_failed
    let mut converter = ClaudeConverter::new(SESSION);
    feed(
      &mut converter,
      &[
        INIT.to_string(),
        r#"{"type":"system","subtype":"api_retry","attempt":1,"error":"authentication_failed","error_status":401}"#
          .to_string(),
        r#"{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate."}"#.to_string(),
      ],
    );
    assert_eq!(
      error_code(&converter.conclude("", 0)),
      Some(ReasonCode::CliLoginRequired)
    );

    // rate_limit_event が rejected のあとのエラー
    let mut converter = ClaudeConverter::new(SESSION);
    feed(
      &mut converter,
      &[
        INIT.to_string(),
        r#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1758200000}}"#.to_string(),
        r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":""}"#.to_string(),
      ],
    );
    assert_eq!(
      error_code(&converter.conclude("", 0)),
      Some(ReasonCode::UsageLimitReached)
    );
  }

  #[test]
  fn usage_limit_notice_only_is_an_error_even_when_successful() {
    let mut converter = ClaudeConverter::new(SESSION);
    let notice = "You've hit your weekly limit · resets Sep 18 at 10pm (Asia/Tokyo)";
    feed(
      &mut converter,
      &[
        INIT.to_string(),
        message_start(1),
        text(notice),
        result(json!({"result":notice})),
      ],
    );
    assert_eq!(
      error_code(&converter.conclude("", 0)),
      Some(ReasonCode::UsageLimitReached)
    );
  }

  #[test]
  fn init_with_tools_or_mcp_servers_is_a_breach() {
    let mut converter = ClaudeConverter::new(SESSION);
    let events = feed(
      &mut converter,
      &[
        r#"{"type":"system","subtype":"init","tools":["Bash"],"mcp_servers":[]}"#.to_string(),
        message_start(1),
        text("ツール付きで動いた分"),
      ],
    );
    assert!(events.is_empty());
    assert_eq!(converter.breach().map(|breach| breach.kind.as_str()), Some("init"));
    assert_eq!(
      converter.breach().map(|breach| breach.message.as_str()),
      Some(INIT_TOOLS_MESSAGE)
    );

    let mut converter = ClaudeConverter::new(SESSION);
    feed(
      &mut converter,
      &[
        r#"{"type":"system","subtype":"init","tools":[],"mcp_servers":[{"name":"x","status":"connected"}]}"#
          .to_string(),
      ],
    );
    assert!(converter.breach().is_some());

    // 一覧が無い init も fail closed
    let mut converter = ClaudeConverter::new(SESSION);
    feed(&mut converter, &[r#"{"type":"system","subtype":"init"}"#.to_string()]);
    assert!(converter.breach().is_some());
  }

  #[test]
  fn success_without_init_is_not_configured() {
    let mut converter = ClaudeConverter::new(SESSION);
    let events = feed(
      &mut converter,
      &[
        message_start(1),
        text("init 無し"),
        result(json!({"result":"init 無し"})),
      ],
    );
    assert!(events.is_empty(), "nothing is relayed before init is verified");
    assert_eq!(
      converter.conclude("", 0),
      TurnEvent::Error {
        reason_code: ReasonCode::NotConfigured,
        message: INIT_MISSING_MESSAGE.into()
      }
    );
  }

  #[test]
  fn tool_use_blocks_are_breaches() {
    for block_type in ["tool_use", "server_tool_use", "mcp_tool_use"] {
      let mut converter = ClaudeConverter::new(SESSION);
      feed(
        &mut converter,
        &[
          INIT.to_string(),
          message_start(1),
          stream(
            json!({"type":"content_block_start","index":0,"content_block":{"type":block_type,"id":"toolu_1","name":"Bash","input":{}}}),
          ),
        ],
      );
      assert_eq!(converter.breach().map(|breach| breach.kind.as_str()), Some(block_type));
      assert_eq!(
        converter.breach().map(|breach| breach.message.as_str()),
        Some(TOOL_USE_MESSAGE)
      );
    }
    // assistant の content に tool_use があっても止める（部分メッセージの取りこぼしの保険）
    let mut converter = ClaudeConverter::new(SESSION);
    feed(
      &mut converter,
      &[
        INIT.to_string(),
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}]}}"#
          .to_string(),
      ],
    );
    assert!(converter.breach().is_some());
  }

  #[test]
  fn nested_tool_events_are_breaches() {
    let mut converter = ClaudeConverter::new(SESSION);
    let line = text("サブエージェント").replace("\"parent_tool_use_id\":null", "\"parent_tool_use_id\":\"toolu_x\"");
    let events = feed(&mut converter, &[INIT.to_string(), message_start(1), line]);
    assert!(events.is_empty());
    assert_eq!(
      converter.breach().map(|breach| breach.kind.as_str()),
      Some("nested_tool_use")
    );
    assert_eq!(converter.assembled().0, "");
  }

  #[test]
  fn stopped_keeps_the_text_so_far_and_known_usage() {
    let mut converter = ClaudeConverter::new(SESSION);
    feed(
      &mut converter,
      &[
        INIT.to_string(),
        message_start(40),
        text("ここまでの文"),
        message_delta("max_tokens", 9),
        message_start(50),
        text("までの文の続き"),
      ],
    );
    assert_eq!(
      converter.stopped(77),
      TurnEvent::Done {
        text: "ここまでの文の続き".into(),
        stop_reason: StopReason::Stopped,
        session_id: Some(SESSION.into()),
        usage: Usage {
          input_tokens: 90,
          output_tokens: 9,
          cost_usd: None,
          model_used: Some("claude-sonnet-5".into()),
        },
        duration_ms: 77,
        continuations: 1,
      }
    );
  }

  #[test]
  fn process_failure_without_result_uses_stderr() {
    let converter = ClaudeConverter::new(SESSION);
    assert_eq!(
      error_code(&converter.conclude("boom", 0)),
      Some(ReasonCode::TransientFailure)
    );
    assert_eq!(
      error_code(&converter.conclude("No conversation found with session ID: x", 0)),
      Some(ReasonCode::SessionNotFound)
    );
  }

  #[test]
  fn thinking_display_rejection_is_detected_only_before_start() {
    assert!(is_unknown_thinking_display_option(
      "error: unknown option '--thinking-display'"
    ));
    assert!(!is_unknown_thinking_display_option("error: unknown option '--other'"));
    let converter = ClaudeConverter::new(SESSION);
    let exit = ChildExit::Exited {
      exit_code: Some(1),
      stderr: "error: unknown option '--thinking-display'".into(),
    };
    assert!(converter.rejected_thinking_display(&exit));
    let mut started = ClaudeConverter::new(SESSION);
    feed(&mut started, &[INIT.to_string()]);
    assert!(!started.rejected_thinking_display(&exit));
  }

  fn arg_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args
      .iter()
      .position(|arg| arg == flag)
      .and_then(|index| args.get(index + 1))
      .map(String::as_str)
  }

  #[test]
  fn args_for_a_new_session_follow_the_contract_order() {
    let path = PathBuf::from("/tmp/turn-x/system-prompt.txt");
    let session = SessionArg::New(SESSION.into());
    let args = build_args("claude-sonnet-5", None, None, &path, &session, true, None);
    let expected: Vec<String> = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--thinking-display",
      "summarized",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--restricted",
      "--tools",
      "",
      "--disable-slash-commands",
      "--permission-mode",
      "dontAsk",
      "--model",
      "claude-sonnet-5",
      "--system-prompt-file",
      "/tmp/turn-x/system-prompt.txt",
      "--session-id",
      SESSION,
    ]
    .iter()
    .map(|value| value.to_string())
    .collect();
    assert_eq!(args, expected);
    assert_eq!(arg_after(&args, "--tools"), Some(""));
    assert_eq!(arg_after(&args, "--setting-sources"), Some(""));
  }

  #[test]
  fn args_for_resume_effort_budget_and_without_thinking_display() {
    let path = PathBuf::from("/tmp/p.txt");
    let session = SessionArg::Resume(SESSION.into());
    let args = build_args(
      "claude-opus-5",
      Some(Effort::Max),
      Some(2.5),
      &path,
      &session,
      false,
      None,
    );
    assert!(!args.iter().any(|arg| arg == "--thinking-display"));
    assert_eq!(arg_after(&args, "--effort"), Some("max"));
    assert_eq!(arg_after(&args, "--max-budget-usd"), Some("2.5"));
    assert_eq!(arg_after(&args, "--resume"), Some(SESSION));
    assert!(!args.iter().any(|arg| arg == "--session-id"));
    assert_eq!(&args[args.len() - 2..], ["--resume".to_string(), SESSION.to_string()]);
    let whole = build_args("m", Some(Effort::Low), Some(10.0), &path, &session, false, None);
    assert_eq!(arg_after(&whole, "--max-budget-usd"), Some("10"));
    assert_eq!(arg_after(&whole, "--effort"), Some("low"));
  }

  fn folder(writable: &[&str]) -> FolderAccess {
    FolderAccess {
      dir: PathBuf::from("/private/tmp/p"),
      given: PathBuf::from("/tmp/p"),
      writable: writable.iter().map(|dir| dir.to_string()).collect(),
      web: false,
    }
  }

  fn web_folder(writable: &[&str]) -> FolderAccess {
    FolderAccess {
      web: true,
      ..folder(writable)
    }
  }

  #[test]
  fn args_with_web_search_add_only_web_search_and_web_fetch() {
    let path = PathBuf::from("/tmp/p.txt");
    let session = SessionArg::New(SESSION.into());
    let args = build_args(
      "sonnet",
      None,
      None,
      &path,
      &session,
      false,
      Some(&web_folder(&["artifacts"])),
    );
    assert_eq!(
      arg_after(&args, "--tools"),
      Some("Read,Edit,Write,Glob,Grep,WebSearch,WebFetch")
    );
    assert_eq!(
      arg_after(&args, "--allowedTools"),
      Some("Read,Glob,Grep,Edit(./artifacts/**),WebSearch,WebFetch")
    );
    assert_eq!(arg_after(&args, "--permission-mode"), Some("dontAsk"));
    let anywhere = build_args("sonnet", None, None, &path, &session, false, Some(&web_folder(&[])));
    assert_eq!(
      arg_after(&anywhere, "--allowedTools"),
      Some("Read,Edit,Write,Glob,Grep,WebSearch,WebFetch")
    );
    // コマンド実行・サブエージェントは、Web を許しても足さない
    for args in [&args, &anywhere] {
      for tool in ["--tools", "--allowedTools"] {
        let value = arg_after(args, tool).unwrap();
        for denied in ["Bash", "Task", "NotebookEdit", "mcp__"] {
          assert!(!value.contains(denied), "{tool} {value}");
        }
      }
    }
    // web_search が false なら Web の道具は無い（今までどおり）
    let off = build_args(
      "sonnet",
      None,
      None,
      &path,
      &session,
      false,
      Some(&folder(&["artifacts"])),
    );
    assert_eq!(arg_after(&off, "--tools"), Some("Read,Edit,Write,Glob,Grep"));
    assert!(!arg_after(&off, "--allowedTools").unwrap().contains("Web"));
  }

  const WEB_INIT: &str = r#"{"type":"system","subtype":"init","session_id":"s","tools":["Edit","Glob","Grep","Read","Write","WebSearch","WebFetch"],"mcp_servers":[],"model":"claude-sonnet-5"}"#;

  #[test]
  fn web_tools_become_tool_events_without_queries_or_paths() {
    let mut converter = ClaudeConverter::with_file_and_web_tools(SESSION);
    let events = feed(
      &mut converter,
      &[
        WEB_INIT.to_string(),
        message_start(10),
        tool_start(0, "toolu_s", "WebSearch"),
        tool_input(0, r#"{"query": "秘密の検索語 営業時間"}"#),
        tool_stop(0),
        message_delta("tool_use", 5),
        tool_result("toolu_s", false),
        message_start(20),
        tool_start(0, "toolu_f", "WebFetch"),
        tool_input(
          0,
          r#"{"url": "https://user:pw@Shop.Example.jp:8443/menu/hours?id=1", "prompt": "営業時間を抜き出す"}"#,
        ),
        tool_stop(0),
        message_delta("tool_use", 5),
        tool_result("toolu_f", false),
        message_start(30),
        text("営業時間を確かめました。"),
        message_delta("end_turn", 7),
        result(json!({"result":"営業時間を確かめました。"})),
      ],
    );
    assert_eq!(
      events,
      vec![
        TurnEvent::ToolUse {
          id: "toolu_s".into(),
          name: "WebSearch".into(),
          summary: String::new()
        },
        TurnEvent::ToolResult {
          id: "toolu_s".into(),
          name: "WebSearch".into(),
          ok: true
        },
        TurnEvent::ToolUse {
          id: "toolu_f".into(),
          name: "WebFetch".into(),
          summary: "shop.example.jp".into()
        },
        TurnEvent::ToolResult {
          id: "toolu_f".into(),
          name: "WebFetch".into(),
          ok: true
        },
        TurnEvent::TextDelta("営業時間を確かめました。".into()),
      ]
    );
    let shown = format!("{events:?}");
    for hidden in ["秘密の検索語", "menu", "hours", "pw", "8443", "営業時間を抜き出す"] {
      assert!(!shown.contains(hidden), "{hidden}");
    }
    assert!(converter.breach().is_none());
    match converter.conclude("", 0) {
      TurnEvent::Done { text, .. } => assert_eq!(text, "営業時間を確かめました。"),
      other => panic!("unexpected {other:?}"),
    }
  }

  #[test]
  fn with_web_tools_other_tools_are_still_breaches() {
    // init に Web 以外の許していないツール（Bash）がある
    let mut converter = ClaudeConverter::with_file_and_web_tools(SESSION);
    feed(
      &mut converter,
      &[r#"{"type":"system","subtype":"init","tools":["Read","WebSearch","Bash"],"mcp_servers":[]}"#.to_string()],
    );
    assert_eq!(converter.breach().map(|breach| breach.kind.as_str()), Some("init"));
    // 呼び出し（シェル・サブエージェント・MCP・サーバーのツール）
    for (block_type, name) in [
      ("tool_use", "Bash"),
      ("tool_use", "Task"),
      ("tool_use", "mcp__x__y"),
      ("server_tool_use", "web_search"),
      ("server_tool_use", "WebSearch"),
    ] {
      let mut converter = ClaudeConverter::with_file_and_web_tools(SESSION);
      let events = feed(
        &mut converter,
        &[
          WEB_INIT.to_string(),
          message_start(1),
          stream(
            json!({"type":"content_block_start","index":0,"content_block":{"type":block_type,"id":"toolu_x","name":name,"input":{}}}),
          ),
        ],
      );
      assert!(events.is_empty(), "{name}");
      assert_eq!(
        converter.breach().map(|breach| breach.message.as_str()),
        Some(FILE_TOOL_USE_MESSAGE),
        "{block_type} {name}"
      );
    }
    let mut converter = ClaudeConverter::with_file_and_web_tools(SESSION);
    feed(
      &mut converter,
      &[
        WEB_INIT.to_string(),
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]}}"#
          .to_string(),
      ],
    );
    assert!(converter.breach().is_some());
    // Web を切った起動では、WebSearch の init も呼び出しも違反
    let mut converter = ClaudeConverter::with_file_tools(SESSION);
    feed(&mut converter, &[WEB_INIT.to_string()]);
    assert_eq!(converter.breach().map(|breach| breach.kind.as_str()), Some("init"));
    let mut converter = ClaudeConverter::with_file_tools(SESSION);
    feed(
      &mut converter,
      &[
        FILE_INIT.to_string(),
        message_start(1),
        tool_start(0, "toolu_s", "WebSearch"),
      ],
    );
    assert_eq!(
      converter.breach().map(|breach| breach.message.as_str()),
      Some(FILE_TOOL_USE_MESSAGE)
    );
  }

  #[test]
  fn web_tools_missing_from_init_are_a_notice_and_the_turn_goes_on() {
    let mut converter = ClaudeConverter::with_file_and_web_tools(SESSION);
    let events = feed(
      &mut converter,
      &[FILE_INIT.to_string(), message_start(1), text("検索なしで直します。")],
    );
    assert_eq!(
      events,
      vec![
        TurnEvent::Notice {
          code: NoticeCode::WebSearchUnsupported
        },
        TurnEvent::TextDelta("検索なしで直します。".into()),
      ]
    );
    assert!(converter.breach().is_none());
    // Web の道具が 1 つでもあれば知らせない
    let mut converter = ClaudeConverter::with_file_and_web_tools(SESSION);
    let events = feed(&mut converter, &[WEB_INIT.to_string()]);
    assert!(events.is_empty());
  }

  #[test]
  fn the_sixth_web_search_stops_the_turn() {
    let mut converter = ClaudeConverter::with_file_and_web_tools(SESSION);
    let mut lines = vec![WEB_INIT.to_string()];
    for index in 1..=5 {
      let id = format!("toolu_{index}");
      lines.push(message_start(1));
      lines.push(tool_start(0, &id, "WebSearch"));
      // 同じ呼び出しが assistant のメッセージにも出る（2 回と数えない）
      lines.push(
        json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":"WebSearch","input":{"query":"q"}}]},"parent_tool_use_id":null})
          .to_string(),
      );
      lines.push(tool_stop(0));
      lines.push(tool_result(&id, false));
    }
    // 取得（WebFetch）は数えない
    lines.push(message_start(1));
    lines.push(tool_start(0, "toolu_f", "WebFetch"));
    feed(&mut converter, &lines);
    assert!(converter.breach().is_none());
    feed(
      &mut converter,
      &[message_start(1), tool_start(0, "toolu_6", "WebSearch")],
    );
    let breach = converter.breach().expect("the sixth search must stop the turn");
    assert_eq!(breach.kind, "web_search_limit");
    assert_eq!(breach.code, ReasonCode::TransientFailure);
  }

  #[test]
  fn args_for_the_project_folder_allow_only_the_file_tools() {
    let path = PathBuf::from("/tmp/p.txt");
    let session = SessionArg::New(SESSION.into());
    let scoped = folder(&["artifacts"]);
    let args = build_args("sonnet", None, None, &path, &session, false, Some(&scoped));
    assert_eq!(arg_after(&args, "--tools"), Some("Read,Edit,Write,Glob,Grep"));
    assert_eq!(
      arg_after(&args, "--allowedTools"),
      Some("Read,Glob,Grep,Edit(./artifacts/**)")
    );
    assert_eq!(arg_after(&args, "--permission-mode"), Some("dontAsk"));
    for kept in ["--restricted", "--strict-mcp-config", "--disable-slash-commands"] {
      assert!(args.iter().any(|arg| arg == kept), "{kept}");
    }
    assert_eq!(arg_after(&args, "--setting-sources"), Some(""));
    assert!(!args.iter().any(|arg| arg == "--add-dir"));
    // 書ける場所を決めないときは 5 つを許し、cwd の中の編集を通す
    let anywhere = folder(&[]);
    let args = build_args("sonnet", None, None, &path, &session, false, Some(&anywhere));
    assert_eq!(arg_after(&args, "--allowedTools"), Some("Read,Edit,Write,Glob,Grep"));
    assert_eq!(arg_after(&args, "--permission-mode"), Some("acceptEdits"));
    // ツール無しの起動には --allowedTools が無く、--tools は空
    let none = build_args("sonnet", None, None, &path, &session, false, None);
    assert!(!none.iter().any(|arg| arg == "--allowedTools"));
    assert_eq!(arg_after(&none, "--tools"), Some(""));
  }

  fn tool_start(index: u64, id: &str, name: &str) -> String {
    stream(
      json!({"type":"content_block_start","index":index,"content_block":{"type":"tool_use","id":id,"name":name,"input":{}}}),
    )
  }

  fn tool_input(index: u64, partial: &str) -> String {
    stream(
      json!({"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":partial}}),
    )
  }

  fn tool_stop(index: u64) -> String {
    stream(json!({"type":"content_block_stop","index":index}))
  }

  fn tool_result(id: &str, is_error: bool) -> String {
    json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":"本文の中身","is_error":is_error}]},"parent_tool_use_id":null}).to_string()
  }

  const FILE_INIT: &str = r#"{"type":"system","subtype":"init","session_id":"s","tools":["Edit","Glob","Grep","Read","Write"],"mcp_servers":[],"model":"claude-sonnet-5"}"#;

  #[test]
  fn file_tools_become_tool_events_and_done_text_is_the_reply() {
    let mut converter = ClaudeConverter::with_file_tools(SESSION);
    let events = feed(
      &mut converter,
      &[
        FILE_INIT.to_string(),
        message_start(10),
        text("見出しを確かめます。"),
        tool_start(1, "toolu_1", "Read"),
        tool_input(1, r#"{"file_path": "/private/tmp/p/arti"#),
        tool_input(1, r#"facts/abc12345.md"}"#),
        tool_stop(1),
        message_delta("tool_use", 5),
        tool_result("toolu_1", false),
        message_start(20),
        thinking("短くする"),
        tool_start(0, "toolu_2", "Edit"),
        tool_input(0, r#"{"file_path": "/private/tmp/p/artifacts/abc12345.md", "old_string": "長い見出し", "new_string": "短い見出し"}"#),
        // assistant のメッセージ（同じ呼び出し）は二重に知らせない
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_2","name":"Edit","input":{"file_path":"/private/tmp/p/artifacts/abc12345.md","old_string":"長い見出し","new_string":"短い見出し"}}]},"parent_tool_use_id":null}"#.to_string(),
        tool_stop(0),
        message_delta("tool_use", 6),
        tool_result("toolu_2", false),
        tool_result("toolu_2", false),
        message_start(30),
        text("見出しを短くしました。"),
        message_delta("end_turn", 7),
        result(json!({"result":"見出しを短くしました。"})),
      ],
    );
    assert_eq!(
      events,
      vec![
        TurnEvent::TextDelta("見出しを確かめます。".into()),
        TurnEvent::ToolUse {
          id: "toolu_1".into(),
          name: "Read".into(),
          summary: "abc12345.md".into()
        },
        TurnEvent::ToolResult {
          id: "toolu_1".into(),
          name: "Read".into(),
          ok: true
        },
        TurnEvent::ThinkingDelta("短くする".into()),
        TurnEvent::ToolUse {
          id: "toolu_2".into(),
          name: "Edit".into(),
          summary: "abc12345.md".into()
        },
        TurnEvent::ToolResult {
          id: "toolu_2".into(),
          name: "Edit".into(),
          ok: true
        },
        TurnEvent::TextDelta("見出しを短くしました。".into()),
      ]
    );
    // 本文（old_string・new_string・読んだ中身）とフォルダのパスはイベントに出ない
    let shown = format!("{events:?}");
    for hidden in ["長い見出し", "短い見出し", "本文の中身", "/private/tmp/p"] {
      assert!(!shown.contains(hidden), "{hidden}");
    }
    match converter.conclude("", 0) {
      TurnEvent::Done { text, .. } => assert_eq!(text, "見出しを短くしました。"),
      other => panic!("unexpected {other:?}"),
    }
  }

  #[test]
  fn file_tool_failures_and_large_inputs_are_reported_by_name_only() {
    let mut converter = ClaudeConverter::with_file_tools(SESSION);
    let big = "x".repeat(TOOL_INPUT_MAX_BYTES + 10);
    let events = feed(
      &mut converter,
      &[
        FILE_INIT.to_string(),
        message_start(10),
        tool_start(0, "toolu_w", "Write"),
        tool_input(0, &format!(r#"{{"file_path": "/etc/passwd", "content": "{big}"}}"#)),
        // 入力が大きすぎて読めない呼び出しは assistant のメッセージから知らせる
        json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_w","name":"Write","input":{"file_path":"/etc/passwd","content":"x"}}]},"parent_tool_use_id":null}).to_string(),
        tool_stop(0),
        tool_result("toolu_w", true),
        // 知らない呼び出しの結果は出さない
        tool_result("toolu_unknown", false),
      ],
    );
    assert_eq!(
      events,
      vec![
        TurnEvent::ToolUse {
          id: "toolu_w".into(),
          name: "Write".into(),
          summary: "passwd".into()
        },
        TurnEvent::ToolResult {
          id: "toolu_w".into(),
          name: "Write".into(),
          ok: false
        },
      ]
    );
    assert!(converter.breach().is_none());
  }

  #[test]
  fn other_tools_are_breaches_even_in_the_project_folder() {
    // init に許していないツールがある
    let mut converter = ClaudeConverter::with_file_tools(SESSION);
    feed(
      &mut converter,
      &[r#"{"type":"system","subtype":"init","tools":["Read","Bash"],"mcp_servers":[]}"#.to_string()],
    );
    assert_eq!(converter.breach().map(|breach| breach.kind.as_str()), Some("init"));
    assert_eq!(
      converter.breach().map(|breach| breach.message.as_str()),
      Some(INIT_FILE_TOOLS_MESSAGE)
    );
    // 一覧の無い init・MCP のある init
    for init in [
      r#"{"type":"system","subtype":"init","mcp_servers":[]}"#,
      r#"{"type":"system","subtype":"init","tools":["Read"],"mcp_servers":[{"name":"x"}]}"#,
    ] {
      let mut converter = ClaudeConverter::with_file_tools(SESSION);
      feed(&mut converter, &[init.to_string()]);
      assert!(converter.breach().is_some(), "{init}");
    }
    // 許していないツールの呼び出し（シェル・Web・サブエージェント・MCP・サーバーのツール）
    for (block_type, name) in [
      ("tool_use", "Bash"),
      ("tool_use", "WebFetch"),
      ("tool_use", "Task"),
      ("tool_use", "mcp__x__y"),
      ("server_tool_use", "web_search"),
    ] {
      let mut converter = ClaudeConverter::with_file_tools(SESSION);
      let events = feed(
        &mut converter,
        &[
          FILE_INIT.to_string(),
          message_start(1),
          stream(
            json!({"type":"content_block_start","index":0,"content_block":{"type":block_type,"id":"toolu_x","name":name,"input":{}}}),
          ),
        ],
      );
      assert!(events.is_empty(), "{name}");
      assert_eq!(
        converter.breach().map(|breach| breach.message.as_str()),
        Some(FILE_TOOL_USE_MESSAGE),
        "{name}"
      );
    }
    // assistant のメッセージだけに出た許していないツール
    let mut converter = ClaudeConverter::with_file_tools(SESSION);
    feed(
      &mut converter,
      &[
        FILE_INIT.to_string(),
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]}}"#
          .to_string(),
      ],
    );
    assert!(converter.breach().is_some());
    // サブエージェントの内側のイベント
    let mut converter = ClaudeConverter::with_file_tools(SESSION);
    let nested = text("内側").replace("\"parent_tool_use_id\":null", "\"parent_tool_use_id\":\"toolu_x\"");
    feed(&mut converter, &[FILE_INIT.to_string(), nested]);
    assert_eq!(
      converter.breach().map(|breach| breach.kind.as_str()),
      Some("nested_tool_use")
    );
    // ツール無しの起動では、ファイルのツールも違反（これまでどおり）
    let mut converter = ClaudeConverter::new(SESSION);
    feed(
      &mut converter,
      &[INIT.to_string(), message_start(1), tool_start(0, "toolu_1", "Read")],
    );
    assert_eq!(
      converter.breach().map(|breach| breach.message.as_str()),
      Some(TOOL_USE_MESSAGE)
    );
    let mut converter = ClaudeConverter::new(SESSION);
    feed(&mut converter, &[FILE_INIT.to_string()]);
    assert_eq!(converter.breach().map(|breach| breach.kind.as_str()), Some("init"));
  }

  #[test]
  fn summaries_are_file_names_only() {
    assert_eq!(
      tool_summary(
        "Read",
        &json!({"file_path":"/Users/a/NIHO docs/projects/p/artifacts/abc.md"})
      ),
      "abc.md"
    );
    assert_eq!(
      tool_summary("Grep", &json!({"pattern":"秘密の語","path":"/p/artifacts"})),
      "artifacts"
    );
    assert_eq!(tool_summary("Glob", &json!({"pattern":"**/*.md"})), "");
    assert_eq!(tool_summary("Bash", &json!({"command":"cat /etc/passwd"})), "");
    assert_eq!(tool_summary("WebSearch", &json!({"query":"秘密の語"})), "");
    assert_eq!(
      tool_summary("WebFetch", &json!({"url":"http://example.com"})),
      "example.com"
    );
    assert_eq!(tool_summary("WebFetch", &json!({"url":"file:///etc/passwd"})), "");
    assert_eq!(file_name_only("a/b\u{7}c.md"), "bc.md");
    assert_eq!(file_name_only("/p/dir/"), "dir");
    assert_eq!(file_name_only(&"名".repeat(200)).chars().count(), SUMMARY_MAX_CHARS);
  }

  #[test]
  fn slash_prompts_get_a_leading_newline() {
    assert_eq!(stdin_for("/help me"), "\n/help me");
    assert_eq!(stdin_for("直して /help"), "直して /help");
  }
}
