//! 本物の CLI で 1 往復＋続き 1 回を通して確かめる（`cargo test` では動かさない）。
//!
//! ```sh
//! cargo run --example smoke -- <claude|codex|gemini> <model> [low|medium|high|max]
//! ```
//!
//! `gemini` は Antigravity CLI（agy）で動く（Provider は同じ `GeminiCli`。例 `gemini gemini-3.8-flash low`）。
//! 一時フォルダを作業フォルダにして、30 までの漢数字を書かせ、同じ会話で 40 までの続きを頼む。
//! 本文は先頭 200 文字だけ、イベントは種類ごとの数だけを表示する。最後に `provider_status` も表示する。

use niho_local_ai::{provider_status, run_turn, Effort, Provider, ToolPolicy, TurnEvent, TurnRequest};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const SYSTEM_PROMPT: &str = "あなたは短い文を書くアシスタントです。";
const FIRST_PROMPT: &str = "1 から 30 までの数を漢数字で 1 行ずつ書いてください。";
const NEXT_PROMPT: &str = "続けて 31 から 40 までを書いてください。";
const USAGE: &str = "usage: cargo run --example smoke -- <claude|codex|gemini> <model> [low|medium|high|max]";

#[derive(Default)]
struct Outcome {
  counts: BTreeMap<&'static str, usize>,
  last: Option<TurnEvent>,
}

fn parse_provider(value: &str) -> Option<Provider> {
  match value {
    "claude" => Some(Provider::ClaudeCode),
    "codex" => Some(Provider::CodexCli),
    "gemini" => Some(Provider::GeminiCli),
    _ => None,
  }
}

fn parse_effort(value: &str) -> Option<Effort> {
  match value {
    "low" => Some(Effort::Low),
    "medium" => Some(Effort::Medium),
    "high" => Some(Effort::High),
    "max" => Some(Effort::Max),
    _ => None,
  }
}

fn run_once(
  provider: Provider,
  model: &str,
  effort: Option<Effort>,
  workdir: &Path,
  prompt: &str,
  resume_session: Option<String>,
) -> Outcome {
  let request = TurnRequest {
    provider,
    model: model.to_string(),
    effort,
    system_prompt: SYSTEM_PROMPT.to_string(),
    user_prompt: prompt.to_string(),
    resume_session,
    workdir: workdir.to_path_buf(),
    timeout: Duration::from_secs(10 * 60),
    max_budget_usd: None,
    tool_policy: ToolPolicy::None,
    web_search: true,
  };
  let state = Arc::new(Mutex::new(Outcome::default()));
  let sink = state.clone();
  let handle = run_turn(request, move |event| {
    let mut outcome = sink.lock().unwrap();
    let kind = match &event {
      TurnEvent::ThinkingDelta(_) => "thinkingDelta",
      TurnEvent::TextDelta(_) => "textDelta",
      TurnEvent::ToolUse { .. } => "toolUse",
      TurnEvent::ToolResult { .. } => "toolResult",
      TurnEvent::Notice { .. } => "notice",
      TurnEvent::Done { .. } => "done",
      TurnEvent::Error { .. } => "error",
    };
    *outcome.counts.entry(kind).or_default() += 1;
    if event.is_terminal() {
      outcome.last = Some(event);
    }
  });
  handle.wait();
  let mut outcome = state.lock().unwrap();
  std::mem::take(&mut *outcome)
}

fn report(label: &str, outcome: &Outcome) {
  println!("== {label}");
  println!("events: {:?}", outcome.counts);
  match &outcome.last {
    Some(TurnEvent::Done {
      text,
      stop_reason,
      session_id,
      usage,
      duration_ms,
      continuations,
    }) => {
      println!("stop_reason: {stop_reason:?}");
      println!("session_id: {session_id:?}");
      println!("usage: {usage:?}");
      println!("duration_ms: {duration_ms}");
      println!("continuations: {continuations}");
      let head: String = text.chars().take(200).collect();
      println!("text（先頭 200 文字）:\n{head}");
    }
    Some(TurnEvent::Error { reason_code, message }) => println!("error: {reason_code} {message}"),
    _ => println!("最後のイベントが届きませんでした"),
  }
}

fn main() {
  let args: Vec<String> = std::env::args().skip(1).collect();
  let (Some(provider), Some(model)) = (args.first().and_then(|value| parse_provider(value)), args.get(1)) else {
    eprintln!("{USAGE}");
    std::process::exit(2);
  };
  let effort = match args.get(2) {
    None => None,
    Some(value) => match parse_effort(value) {
      Some(effort) => Some(effort),
      None => {
        eprintln!("{USAGE}");
        std::process::exit(2);
      }
    },
  };
  // claude・codex は会話を cwd ごとに保存するので、続きも同じフォルダで動かす（agy はその回だけの空のフォルダで動く）
  let workdir = std::env::temp_dir().join(format!("niho-local-ai-smoke-{}", std::process::id()));
  std::fs::create_dir_all(&workdir).expect("create the smoke workdir");

  let first = run_once(provider, model, effort, &workdir, FIRST_PROMPT, None);
  report("1 回目", &first);
  match &first.last {
    Some(TurnEvent::Done {
      session_id: Some(session_id),
      ..
    }) => {
      let next = run_once(provider, model, effort, &workdir, NEXT_PROMPT, Some(session_id.clone()));
      report("続き", &next);
    }
    _ => println!("== 続き\n会話の ID が無いので送りませんでした"),
  }

  let status = provider_status(provider);
  println!(
    "== provider_status\n{}",
    serde_json::to_string_pretty(&status).unwrap_or_default()
  );
  let _ = std::fs::remove_dir_all(&workdir);
}
