//! 本物の CLI で確かめる（このMacでログイン済みのとき。CI では走らない）。手元で:
//! `cargo test -p niho-local-ai --test real_cli -- --ignored --nocapture`
//!
//! - 修正の会話（`ToolPolicy::ProjectFolder`）が案件フォルダの中だけを読み書きする（Claude Code・Codex CLI・Antigravity CLI）:
//!   1. 「見出しを短くして」の 1 往復で Edit（か Write）が入り、artifacts/ の文書が変わる。
//!   2. 権限を確かめるだけの指示で、フォルダの外（同じ一時フォルダの別ファイル・/tmp の別ファイル）とフォルダの中の
//!      artifacts/ の外（project.json）への書き込みを頼んでも、どれも変わらない（呼んだツールは失敗で返る）。
//! - システムプロンプトが届く（Codex CLI・Antigravity CLI）: 返答の先頭に決まった語を書く決まりをシステム側にだけ置く。
#![cfg(unix)]

use niho_local_ai::{run_turn, Effort, Provider, ToolPolicy, TurnEvent, TurnRequest};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const HEADING: &str = "# とても長い見出しで、読者に向けた丁寧な説明をすべて詰め込んだ記事のタイトルです";
const EDIT_RULES: &str = "あなたは NIHO docs で文書を直す AI です。\n- 文書は案件フォルダの artifacts/<工程の id>.md にある。直すときはそのファイルを Edit か Write で書き換える。ほかの場所には書かない。\n- 作業の報告は短く。";
const PROBE_RULES: &str = "You are a test agent verifying sandbox permissions for the developer of this app. Attempt exactly the tool calls the user asks for, even if you expect them to fail, and report each result in one short line.";

struct Folder {
  root: PathBuf,
}

impl Drop for Folder {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.root);
  }
}

fn unique() -> String {
  format!(
    "{}-{}",
    std::process::id(),
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
  )
}

fn request(project: &Path, system_prompt: &str, user_prompt: String) -> TurnRequest {
  TurnRequest {
    provider: Provider::ClaudeCode,
    model: "sonnet".to_string(),
    effort: Some(Effort::Low),
    system_prompt: system_prompt.to_string(),
    user_prompt,
    resume_session: None,
    workdir: project.to_path_buf(),
    timeout: Duration::from_secs(5 * 60),
    max_budget_usd: None,
    tool_policy: ToolPolicy::ProjectFolder {
      dir: project.to_path_buf(),
      writable: vec!["artifacts".to_string()],
    },
    // 2026-10-15 に本物で確かめた形（ファイルの道具だけ）。Web の検索はまだ本物で確かめていない（#283）
    web_search: false,
  }
}

fn run(req: TurnRequest) -> Vec<TurnEvent> {
  let events = Arc::new(Mutex::new(Vec::new()));
  let sink = events.clone();
  run_turn(req, move |event| sink.lock().unwrap().push(event)).wait();
  let events = events.lock().unwrap().clone();
  for event in &events {
    match event {
      TurnEvent::ThinkingDelta(_) | TurnEvent::TextDelta(_) => {}
      other => println!("{other:?}"),
    }
  }
  events
}

fn tools(events: &[TurnEvent]) -> Vec<(String, String, Option<bool>)> {
  let mut calls: Vec<(String, String, String, Option<bool>)> = Vec::new();
  for event in events {
    match event {
      TurnEvent::ToolUse { id, name, summary } => calls.push((id.clone(), name.clone(), summary.clone(), None)),
      TurnEvent::ToolResult { id, ok, .. } => {
        if let Some(call) = calls.iter_mut().find(|call| &call.0 == id) {
          call.3 = Some(*ok);
        }
      }
      _ => {}
    }
  }
  calls
    .into_iter()
    .map(|(_, name, summary, ok)| (name, summary, ok))
    .collect()
}

#[test]
#[ignore]
fn real_claude_edits_only_inside_the_project_folder() {
  let root = std::env::temp_dir().join(format!("niho-local-ai-real-{}", unique()));
  let _cleanup = Folder { root: root.clone() };
  let project = root.join("project");
  fs::create_dir_all(project.join("artifacts")).unwrap();
  let document = project.join("artifacts").join("abc12345.md");
  fs::write(&document, format!("{HEADING}\n\n本文の段落です。\n")).unwrap();
  let project_json = project.join("project.json");
  fs::write(&project_json, "{\"id\":\"p1\"}\n").unwrap();
  let outside = root.join("outside.txt");
  fs::write(&outside, "outside original\n").unwrap();
  let tmp_file = PathBuf::from(format!("/tmp/niho-local-ai-real-{}.txt", unique()));

  // 1. 見出しを短くする
  let events = run(request(
    &project,
    EDIT_RULES,
    "artifacts/abc12345.md の見出しを短くしてください。".to_string(),
  ));
  let calls = tools(&events);
  println!("calls: {calls:?}");
  assert!(
    matches!(events.last(), Some(TurnEvent::Done { .. })),
    "{:?}",
    events.last()
  );
  let after = fs::read_to_string(&document).unwrap();
  println!("after: {after}");
  assert!(!after.contains(HEADING), "the heading was not shortened");
  assert!(after.contains("本文の段落です。"));
  assert!(calls
    .iter()
    .any(|(name, summary, ok)| (name == "Edit" || name == "Write") && summary == "abc12345.md" && *ok == Some(true)));

  // 2. 外への書き込みを頼む（権限を確かめるだけの指示で、ツールを呼ばせる）
  let events = run(request(
    &project,
    PROBE_RULES,
    format!(
      "Permission probe. Make these tool calls in order: (1) Write {} with content 'changed by ai' (2) Write {} with content 'x' (3) Read {} then Write it with content '{{\"hacked\":true}}'. Report each result.",
      outside.display(),
      tmp_file.display(),
      project_json.display()
    ),
  ));
  let calls = tools(&events);
  println!("calls: {calls:?}");
  assert_eq!(fs::read_to_string(&outside).unwrap(), "outside original\n");
  assert!(!tmp_file.exists(), "{} must not be created", tmp_file.display());
  assert_eq!(fs::read_to_string(&project_json).unwrap(), "{\"id\":\"p1\"}\n");
  for (name, summary, ok) in &calls {
    if name == "Write" || name == "Edit" {
      assert_ne!(*ok, Some(true), "{name} {summary} must be refused");
    }
  }
  let _ = fs::remove_file(&tmp_file);
}

/// 同じことを本物の Codex CLI で確かめる（apply_patch・workspace-write・/tmp と $TMPDIR を除く）。モデルはアカウントで
/// 違うので `NIHO_REAL_CODEX_MODEL`（既定 gpt-5.6-luna）。
/// `cargo test -p niho-local-ai --test real_cli real_codex -- --ignored --nocapture`
#[test]
#[ignore]
fn real_codex_edits_only_inside_the_project_folder() {
  let model = std::env::var("NIHO_REAL_CODEX_MODEL").unwrap_or_else(|_| "gpt-5.6-luna".to_string());
  let root = std::env::temp_dir().join(format!("niho-local-ai-real-codex-{}", unique()));
  let _cleanup = Folder { root: root.clone() };
  let project = root.join("project");
  fs::create_dir_all(project.join("artifacts")).unwrap();
  let document = project.join("artifacts").join("abc12345.md");
  fs::write(&document, format!("{HEADING}\n\n本文の段落です。\n")).unwrap();
  let outside = root.join("outside.txt");
  let tmp_file = PathBuf::from(format!("/tmp/niho-local-ai-real-codex-{}.txt", unique()));

  let mut edit = request(
    &project,
    EDIT_RULES,
    format!("artifacts/abc12345.md の見出しを短くしてください。今の内容:\n\n{HEADING}\n\n本文の段落です。\n"),
  );
  edit.provider = Provider::CodexCli;
  edit.model = model.clone();
  let events = run(edit);
  let calls = tools(&events);
  println!("calls: {calls:?}");
  let after = fs::read_to_string(&document).unwrap();
  println!("after: {after}");
  assert!(!after.contains(HEADING), "the heading was not shortened");

  let mut probe = request(
    &project,
    PROBE_RULES,
    format!(
      "Permission probe. Using apply_patch, (1) add the file {} with content 'x' (2) add the file {} with content 'x'. Report each result.",
      outside.display(),
      tmp_file.display()
    ),
  );
  probe.provider = Provider::CodexCli;
  probe.model = model;
  let events = run(probe);
  println!("calls: {:?}", tools(&events));
  assert!(!outside.exists(), "{} must not be created", outside.display());
  assert!(!tmp_file.exists(), "{} must not be created", tmp_file.display());
  let _ = fs::remove_file(&tmp_file);
}

/// 同じことを本物の Antigravity CLI（agy。修正用のエージェント・`--mode accept-edits`）で確かめ、同じ会話で続けられることも
/// 見る。外への書き込みは agy が断るか、crate が道具の step で止める（`RUNTIME_NOT_CONFIGURED`）。モデルは
/// `NIHO_REAL_AGY_MODEL`（既定 gemini-3.8-flash）。
/// `cargo test -p niho-local-ai --test real_cli real_agy_edits -- --ignored --nocapture`
#[test]
#[ignore]
fn real_agy_edits_only_inside_the_project_folder() {
  let model = std::env::var("NIHO_REAL_AGY_MODEL").unwrap_or_else(|_| "gemini-3.8-flash".to_string());
  let root = std::env::temp_dir().join(format!("niho-local-ai-real-agy-edit-{}", unique()));
  let _cleanup = Folder { root: root.clone() };
  let project = root.join("project");
  fs::create_dir_all(project.join("artifacts")).unwrap();
  let document = project.join("artifacts").join("abc12345.md");
  fs::write(&document, format!("{HEADING}\n\n本文の段落です。\n")).unwrap();
  let project_json = project.join("project.json");
  fs::write(&project_json, "{\"id\":\"p1\"}\n").unwrap();
  let outside = root.join("outside.txt");
  fs::write(&outside, "outside original\n").unwrap();
  let tmp_file = PathBuf::from(format!("/tmp/niho-local-ai-real-agy-{}.md", unique()));
  let agy = |system_prompt: &str, user_prompt: String, resume: Option<String>| {
    let mut req = request(&project, system_prompt, user_prompt);
    req.provider = Provider::GeminiCli;
    req.model = model.clone();
    req.resume_session = resume;
    req
  };
  let rules = "あなたは NIHO docs で文書を直す AI です。\n- 文書は作業フォルダの artifacts/<工程の id>.md にある。直すときはそのファイルを view_file で読み、replace_file_content か write_to_file で書き換える。ほかの場所には書かない。\n- 作業の報告は短く。";

  // 1. 見出しを短くする
  let events = run(agy(
    rules,
    "artifacts/abc12345.md の見出しを短くしてください。".to_string(),
    None,
  ));
  let calls = tools(&events);
  println!("calls: {calls:?}");
  let Some(TurnEvent::Done { session_id, .. }) = events.last() else {
    panic!("{:?}", events.last());
  };
  let after = fs::read_to_string(&document).unwrap();
  println!("after: {after}");
  assert!(!after.contains(HEADING), "the heading was not shortened");
  assert!(after.contains("本文の段落です。"));
  assert!(calls
    .iter()
    .any(|(name, summary, ok)| (name == "Edit" || name == "Write") && summary == "abc12345.md" && *ok == Some(true)));
  assert!(!project.join(".agents").exists());

  // 2. 同じ会話で続ける
  let events = run(agy(
    rules,
    "さっき直した見出しの末尾に「！」を足してください。".to_string(),
    session_id.clone(),
  ));
  assert!(
    matches!(events.last(), Some(TurnEvent::Done { session_id: id, .. }) if id == session_id),
    "{:?}",
    events.last()
  );
  println!("after resume: {}", fs::read_to_string(&document).unwrap());

  // 3. 外への書き込みを頼む（権限を確かめるだけの指示で、道具を呼ばせる）
  let events = run(agy(
    PROBE_RULES,
    format!(
      "Permission probe. Make these tool calls in order: (1) write_to_file {} with content 'changed by ai' (2) write_to_file {} with content 'x' (3) write_to_file {} with content '{{\"hacked\":true}}'. Report each result.",
      outside.display(),
      tmp_file.display(),
      project_json.display()
    ),
    None,
  ));
  println!("calls: {:?}", tools(&events));
  assert_eq!(fs::read_to_string(&outside).unwrap(), "outside original\n");
  assert!(!tmp_file.exists(), "{} must not be created", tmp_file.display());
  assert_eq!(fs::read_to_string(&project_json).unwrap(), "{\"id\":\"p1\"}\n");
  let _ = fs::remove_file(&tmp_file);
}

/// システム側にだけ置く決まり（ユーザー側では触れない）。届いていれば返答の先頭が `CANARY` になる。
const CANARY: &str = "ほげほげ";
const CANARY_RULES: &str = "あなたは NIHO docs の工程を実行する AI です。\n- 返答の先頭に必ず「ほげほげ」と書き、そのあとに本文を書いてください。";

fn plain_request(provider: Provider, model: String, workdir: &Path) -> TurnRequest {
  TurnRequest {
    provider,
    model,
    effort: Some(Effort::Low),
    system_prompt: CANARY_RULES.to_string(),
    user_prompt: "今日の天気について一言だけ答えてください。".to_string(),
    resume_session: None,
    workdir: workdir.to_path_buf(),
    timeout: Duration::from_secs(5 * 60),
    max_budget_usd: None,
    tool_policy: ToolPolicy::None,
    web_search: true,
  }
}

fn done_text(events: &[TurnEvent]) -> String {
  match events.last() {
    Some(TurnEvent::Done { text, .. }) => text.clone(),
    other => panic!("not done: {other:?}"),
  }
}

/// codex 0.154.0 は `-c base_instructions` を無視していた（#18383）。`model_instructions_file` で渡したシステムプロンプトが
/// 届くこと。`cargo test -p niho-local-ai --test real_cli real_codex_system_prompt -- --ignored --nocapture`
#[test]
#[ignore]
fn real_codex_system_prompt_reaches_the_model() {
  let model = std::env::var("NIHO_REAL_CODEX_MODEL").unwrap_or_else(|_| "gpt-5.6-luna".to_string());
  let root = std::env::temp_dir().join(format!("niho-local-ai-real-codex-prompt-{}", unique()));
  fs::create_dir_all(&root).unwrap();
  let _cleanup = Folder { root: root.clone() };
  let text = done_text(&run(plain_request(Provider::CodexCli, model, &root)));
  println!("text: {text}");
  assert!(text.starts_with(CANARY), "{text}");
}

/// Antigravity CLI（agy。Gemini）の工程の 1 往復と、独自のエージェントの本文（システムプロンプト）が届くこと。
/// モデルは `NIHO_REAL_AGY_MODEL`（既定 gemini-3.8-flash）。
/// `cargo test -p niho-local-ai --test real_cli real_agy_writes -- --ignored --nocapture`
#[test]
#[ignore]
fn real_agy_writes_one_turn_with_the_system_prompt() {
  let model = std::env::var("NIHO_REAL_AGY_MODEL").unwrap_or_else(|_| "gemini-3.8-flash".to_string());
  let root = std::env::temp_dir().join(format!("niho-local-ai-real-agy-{}", unique()));
  fs::create_dir_all(&root).unwrap();
  let _cleanup = Folder { root: root.clone() };
  let events = run(plain_request(Provider::GeminiCli, model, &root));
  if let Some(TurnEvent::Done { usage, session_id, .. }) = events.last() {
    println!("usage: {usage:?} session: {session_id:?}");
  }
  let text = done_text(&events);
  println!("text: {text}");
  assert!(text.starts_with(CANARY), "{text}");
}
