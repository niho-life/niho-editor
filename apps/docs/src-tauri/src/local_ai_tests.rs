//! adapter（local_ai.rs）を、crate の `Runtime.cli_paths` に偽の CLI を渡して確かめる（crate は偽の CLI をそのまま起動する）。
//! 偽物は 2 種類: 開発用の apps/docs/sidecar/fake/claude（`npm run dev:fake` と同じもの）と、共有の fixture の stdout を流すだけの台本。
//! 本物の Claude Code は `real_claude_round_trip`（#[ignore]）だけが起動する。

use super::*;
use crate::contract::Effort;
use std::sync::{mpsc, MutexGuard};
use std::time::{Duration, Instant};

/// crate の同時実行の数（このMacで 2 件）と、更新・ログインの排他はプロセスで共有される。工程・ログイン・更新を動かすテストは
/// この鍵を取って 1 つずつ動かす（crate の tests/fake_cli.rs と同じ）。
fn global_lock() -> MutexGuard<'static, ()> {
  static LOCK: Mutex<()> = Mutex::new(());
  LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn fake_claude() -> PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR")).join("../sidecar/fake/claude")
}

/// 開発用の偽物（`npm run dev:fake` と同じもの）。
fn fake_cli(name: &str) -> PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR")).join("../sidecar/fake").join(name)
}

const SYSTEM_PROMPT: &str = "固定の決まり\n## この工程\n整える";
const USER_PROMPT: &str = "## 文字起こし\n\n[00:00:01] こんにちは";

struct Harness {
  dir: PathBuf,
  logs: Arc<Mutex<Vec<String>>>,
}

impl Harness {
  fn new(name: &str) -> Self {
    let dir = std::env::temp_dir().join(format!(
      "niho-docs-local-ai-{name}-{}-{}",
      std::process::id(),
      crate::process::hex(&crate::process::random_bytes::<4>().unwrap())
    ));
    fs::create_dir_all(dir.join("work")).unwrap();
    Self {
      dir,
      logs: Arc::new(Mutex::new(Vec::new())),
    }
  }

  /// claude はこの場所、codex・agy は無い場所（本物の CLI を拾わない）。一時ファイルの置き場はこのフォルダの local-ai。
  fn runner(&self, claude: &Path) -> LocalAiRunner {
    self.runner_with(claude, &self.dir.join("missing/agy"))
  }

  /// claude と agy の場所を決めた runner（codex は無い場所）。
  fn runner_with(&self, claude: &Path, agy: &Path) -> LocalAiRunner {
    self.runner_all(claude, &self.dir.join("missing/codex"), agy)
  }

  /// 3 つの CLI の場所を決めた runner（Codex CLI の CODEX_HOME はこのフォルダの codex-home）。
  fn runner_all(&self, claude: &Path, codex: &Path, agy: &Path) -> LocalAiRunner {
    let logs = self.logs.clone();
    let mut runtime = runtime_for(
      &self.dir,
      BTreeMap::from([
        (local::Provider::ClaudeCode, claude.to_path_buf()),
        (local::Provider::CodexCli, codex.to_path_buf()),
        (local::Provider::GeminiCli, agy.to_path_buf()),
      ]),
      Some(Arc::new(move |kind: &str, payload: Value| {
        logs.lock().unwrap().push(format!("{kind} {payload}"))
      })),
    );
    runtime.kill_grace = Duration::from_millis(200);
    LocalAiRunner::new(runtime)
  }

  fn request(&self, user_prompt: &str) -> TurnRequest {
    TurnRequest {
      provider: Provider::ClaudeCode,
      model: "sonnet".into(),
      effort: Some(Effort::High),
      system_prompt: SYSTEM_PROMPT.into(),
      user_prompt: user_prompt.into(),
      resume_session: None,
      workdir: self.dir.join("work"),
      timeout: Duration::from_secs(20),
      max_budget_usd: None,
      tool_policy: ToolPolicy::None,
    }
  }

  /// `#!/bin/sh` の台本を書く（`$d` はこのフォルダ）。
  fn script(&self, name: &str, body: &str) -> PathBuf {
    let path = self.dir.join(name);
    fs::write(
      &path,
      format!("#!/bin/sh\nd={}\n{body}\n", shell_quote(&self.dir.to_string_lossy())),
    )
    .unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
  }
}

impl Drop for Harness {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.dir);
  }
}

fn shell_quote(value: &str) -> String {
  format!("'{}'", value.replace('\'', "'\\''"))
}

/// 依頼を流し、最後のイベントまで集める。`stop_after` 個のイベントが届いたら止める。
fn run_with(runner: &LocalAiRunner, request: TurnRequest, stop_after: Option<usize>) -> Vec<TurnEvent> {
  let (sender, receiver) = mpsc::channel::<TurnEvent>();
  let handle = runner.run_turn(
    request,
    Box::new(move |event| {
      let _ = sender.send(event);
    }),
  );
  let mut events = Vec::new();
  loop {
    let event = receiver
      .recv_timeout(Duration::from_secs(20))
      .expect("イベントが届かない");
    let terminal = event.is_terminal();
    events.push(event);
    if terminal {
      // 最後のイベントの後は何も届かない
      assert!(receiver.recv_timeout(Duration::from_millis(50)).is_err());
      return events;
    }
    if stop_after == Some(events.len()) {
      handle.stop();
    }
  }
}

fn run(runner: &LocalAiRunner, request: TurnRequest) -> Vec<TurnEvent> {
  run_with(runner, request, None)
}

fn last(events: &[TurnEvent]) -> &TurnEvent {
  events.last().expect("イベントが無い")
}

fn error_of(events: &[TurnEvent]) -> (ReasonCode, String) {
  match last(events) {
    TurnEvent::Error { reason_code, message } => (*reason_code, message.clone()),
    other => panic!("Error ではない: {other:?}"),
  }
}

fn is_uuid(value: &str) -> bool {
  value.len() == 36
    && value
      .char_indices()
      .all(|(index, ch)| matches!(index, 8 | 13 | 18 | 23) == (ch == '-') && (ch == '-' || ch.is_ascii_hexdigit()))
}

#[test]
fn dev_fake_claude_runs_through_the_crate() {
  let _lock = global_lock();
  let harness = Harness::new("fake-normal");
  let events = run(&harness.runner(&fake_claude()), harness.request(USER_PROMPT));
  assert_eq!(
    events[0],
    TurnEvent::ThinkingDelta("資料を読んで、構成を考えています。".into())
  );
  assert!(events[1..events.len() - 1]
    .iter()
    .all(|event| matches!(event, TurnEvent::TextDelta(_))));
  let TurnEvent::Done {
    text,
    stop_reason,
    session_id,
    usage,
    continuations,
    ..
  } = last(&events)
  else {
    panic!("{events:?}");
  };
  assert!(
    text.starts_with("# 偽の出力\n\nこれは偽の claude の出力です。"),
    "{text}"
  );
  assert!(text.contains("- 文字起こし"), "{text}");
  assert_eq!(*stop_reason, StopReason::EndTurn);
  assert!(session_id.as_deref().is_some_and(is_uuid), "{session_id:?}");
  assert_eq!(*continuations, 0);
  // model_used は crate が stream から取った実際のモデル（依頼した別名 `sonnet` ではない。偽の claude は claude-fake）。
  // Claude Code の total_cost_usd は持ち出さない
  assert_eq!(
    *usage,
    Usage {
      input_tokens: usage.input_tokens,
      output_tokens: 320,
      cost_usd: None,
      model_used: Some("claude-fake".into()),
      cost_known: false,
    }
  );
  assert!(usage.input_tokens > 0);
  // 一時ファイル（システムプロンプト）は app data の下の置き場に作って消す。ログに本文は出ない
  let scratch = harness.dir.join("local-ai");
  assert!(scratch.is_dir());
  assert_eq!(fs::read_dir(&scratch).unwrap().count(), 0);
  let logs = harness.logs.lock().unwrap().join("\n");
  assert!(!logs.contains("こんにちは") && !logs.contains("固定の決まり"), "{logs}");
}

#[test]
fn web_search_off_reaches_the_crate_and_its_notice_reaches_the_app() {
  // 修正の会話の `web_search: false`（設定の「Web を検索する」を切った）は crate まで届き、crate の知らせ
  // （検索は切っています）が `TurnEvent::Notice` として最初に流れる。検索なしで文書は直る（#283）
  let _lock = global_lock();
  let harness = Harness::new("fake-chat");
  let project = harness.dir.join("project");
  fs::create_dir_all(project.join("artifacts")).unwrap();
  fs::write(project.join("artifacts").join("k7m2q9xa.md"), "# 見出し\n").unwrap();
  let mut request = harness.request("見出しを短くして");
  request.workdir = project.clone();
  request.tool_policy = ToolPolicy::ProjectFolder {
    dir: project.clone(),
    writable: vec!["artifacts".into()],
    web_search: false,
  };
  let events = run(&harness.runner(&fake_claude()), request);
  assert_eq!(
    events.first(),
    Some(&TurnEvent::Notice {
      code: "webSearchOff".into(),
      message: "検索は切っています。".into()
    }),
    "{events:?}"
  );
  assert!(matches!(last(&events), TurnEvent::Done { .. }), "{events:?}");
}

#[test]
fn dev_fake_claude_edits_a_document_in_the_project_folder() {
  let _lock = global_lock();
  let harness = Harness::new("fake-chat");
  let project = harness.dir.join("project");
  fs::create_dir_all(project.join("artifacts")).unwrap();
  fs::write(project.join("artifacts").join("k7m2q9xa.md"), "# 見出し\n").unwrap();
  let mut request = harness.request("見出しを短くして");
  request.workdir = project.clone();
  request.tool_policy = ToolPolicy::ProjectFolder {
    dir: project.clone(),
    writable: vec!["artifacts".into()],
    web_search: true,
  };
  let events = run(&harness.runner(&fake_claude()), request);
  let tools: Vec<(String, String)> = events
    .iter()
    .filter_map(|event| match event {
      TurnEvent::ToolUse { name, summary, .. } => Some((name.clone(), summary.clone())),
      _ => None,
    })
    .collect();
  assert_eq!(
    tools,
    vec![
      ("Read".to_string(), "k7m2q9xa.md".to_string()),
      ("Edit".to_string(), "k7m2q9xa.md".to_string())
    ]
  );
  assert_eq!(
    events
      .iter()
      .filter(|event| matches!(event, TurnEvent::ToolResult { ok: true, .. }))
      .count(),
    2
  );
  // 返答は最後のツールの後の文だけ（前後の空白は戻さない）
  let TurnEvent::Done { text, .. } = last(&events) else {
    panic!("{events:?}");
  };
  assert_eq!(text, "偽の claude が文書の末尾に 1 行足しました。");
  assert!(fs::read_to_string(project.join("artifacts").join("k7m2q9xa.md"))
    .unwrap()
    .contains("（偽の修正"));
}

#[test]
fn dev_fake_agy_edits_a_document_in_the_project_folder() {
  let _lock = global_lock();
  let harness = Harness::new("fake-agy-chat");
  let runner = harness.runner_with(&fake_claude(), &fake_cli("agy"));
  let project = harness.dir.join("project");
  fs::create_dir_all(project.join("artifacts")).unwrap();
  let document = project.join("artifacts").join("k7m2q9xa.md");
  fs::write(&document, "# とても長い見出し\n\n本文。\n").unwrap();
  fs::write(project.join("transcript.md"), "文字起こし\n").unwrap();
  let request = |user_prompt: &str| {
    let mut request = harness.request(user_prompt);
    request.provider = Provider::GeminiCli;
    request.model = "gemini-3.8-flash".into();
    request.effort = Some(Effort::Low);
    request.workdir = project.clone();
    request.tool_policy = ToolPolicy::ProjectFolder {
      dir: project.clone(),
      writable: vec!["artifacts".into()],
      web_search: true,
    };
    request
  };
  let events = run(&runner, request("見出しを短くして"));
  let tools: Vec<(String, String, Option<bool>)> = events
    .iter()
    .filter_map(|event| match event {
      TurnEvent::ToolUse { name, summary, .. } => Some((name.clone(), summary.clone(), None)),
      TurnEvent::ToolResult { name, ok, .. } => Some((name.clone(), String::new(), Some(*ok))),
      _ => None,
    })
    .collect();
  assert_eq!(
    tools,
    vec![
      ("Read".to_string(), "k7m2q9xa.md".to_string(), None),
      ("Read".to_string(), String::new(), Some(true)),
      ("Edit".to_string(), "k7m2q9xa.md".to_string(), None),
      ("Edit".to_string(), String::new(), Some(true)),
    ]
  );
  // 返答は最後の道具より後の文だけ。文書は書き換わり、修正用のエージェント（.agents）は残らない
  let TurnEvent::Done { text, session_id, .. } = last(&events) else {
    panic!("{events:?}");
  };
  assert_eq!(text, "偽の agy が先頭の見出しを短くしました。");
  assert!(session_id.is_some());
  assert_eq!(fs::read_to_string(&document).unwrap(), "# 短い見出し\n\n本文。\n");
  assert!(!project.join(".agents").exists());

  // 作業フォルダの外・artifacts/ の外・シェルは止める（文書も transcript.md も変わらない）
  for (marker, part) in [
    ("[fake:outside]", "作業フォルダの外のファイル"),
    ("[fake:write_outside]", "文書（Markdown）の外"),
    ("[fake:command]", "許したもの以外のツール"),
  ] {
    let events = run(&runner, request(&format!("見出しを直して {marker}")));
    match last(&events) {
      TurnEvent::Error { reason_code, message } => {
        assert_eq!(*reason_code, ReasonCode::NotConfigured, "{marker}");
        assert!(message.contains(part), "{marker}: {message}");
      }
      other => panic!("{marker}: {other:?}"),
    }
    assert_eq!(fs::read_to_string(&document).unwrap(), "# 短い見出し\n\n本文。\n");
    assert_eq!(
      fs::read_to_string(project.join("transcript.md")).unwrap(),
      "文字起こし\n"
    );
    assert!(!project.join(".agents").exists());
  }
}

#[test]
fn max_tokens_is_continued_in_the_same_session() {
  let _lock = global_lock();
  let harness = Harness::new("fake-max-tokens");
  let runner = harness.runner(&fake_claude());
  let first = run(&runner, harness.request(&format!("{USER_PROMPT}\n\n[fake:max_tokens]")));
  let TurnEvent::Done {
    stop_reason: StopReason::MaxTokens,
    session_id: Some(session),
    text,
    continuations: 0,
    ..
  } = last(&first)
  else {
    panic!("{first:?}");
  };
  // crate が落とした末尾の改行は、届いた差分から戻す（続きと繋ぐときに段落の区切りが消えない）
  assert!(text.ends_with("ここで出力の上限に達したことにします。\n"), "{text:?}");
  let mut next = harness.request("続きを書いてください。重複せず、止まった箇所の直後から続けてください。");
  next.resume_session = Some(session.clone());
  let second = run(&runner, next);
  assert!(
    matches!(last(&second), TurnEvent::Done { stop_reason: StopReason::EndTurn, session_id: Some(id), text, .. }
      if id == session && text.starts_with("## 続き")),
    "{second:?}"
  );
}

#[test]
fn claude_code_auto_continuation_is_counted_once() {
  let _lock = global_lock();
  let harness = Harness::new("fake-auto");
  let events = run(
    &harness.runner(&fake_claude()),
    harness.request(&format!("{USER_PROMPT}\n\n[fake:auto_continue]")),
  );
  let TurnEvent::Done {
    text,
    stop_reason,
    continuations,
    ..
  } = last(&events)
  else {
    panic!("{events:?}");
  };
  assert_eq!(*stop_reason, StopReason::EndTurn);
  assert_eq!(*continuations, 1);
  // 続きの先頭の重なりは crate が除いてつなぐ
  assert_eq!(text.matches("続きを頼むところです。").count(), 1, "{text}");
  assert!(text.ends_with("自分で続きを頼むところです。\n同じ実行の中で書き終えました（偽の出力）。\n"));
}

#[test]
fn failures_map_to_the_app_reason_codes() {
  let _lock = global_lock();
  let harness = Harness::new("fake-failures");
  let runner = harness.runner(&fake_claude());
  let reason = |marker: &str| error_of(&run(&runner, harness.request(&format!("{USER_PROMPT}\n{marker}"))));
  assert_eq!(reason("[fake:login]").0, ReasonCode::CliLoginRequired);
  assert_eq!(reason("[fake:limit]").0, ReasonCode::UsageLimitReached);
  assert_eq!(
    reason("[fake:model]"),
    (ReasonCode::ModelNotFound, MODEL_NOT_FOUND_MESSAGE.to_string())
  );
  // 壊れた出力のまま result が来なければ、途中の本文を流したあと失敗（crate は TransientFailure にする）
  let broken = run(&runner, harness.request(&format!("{USER_PROMPT}\n[fake:broken]")));
  assert!(
    broken.contains(&TurnEvent::TextDelta("途中まで\n".into())),
    "{broken:?}"
  );
  assert_eq!(
    error_of(&broken),
    (
      ReasonCode::TransientFailure,
      "Claude Code の実行に失敗しました。".into()
    )
  );
}

#[test]
fn stop_and_time_limit_keep_the_partial_text() {
  let _lock = global_lock();
  let harness = Harness::new("fake-stop");
  let runner = harness.runner(&fake_claude());
  let started = Instant::now();
  let stopped = run_with(
    &runner,
    harness.request(&format!("{USER_PROMPT}\n[fake:slow]")),
    Some(2),
  );
  assert!(started.elapsed() < Duration::from_secs(5), "止まるのが遅い");
  assert!(
    matches!(last(&stopped), TurnEvent::Done { stop_reason: StopReason::Stopped, text, .. } if text.starts_with("# 偽の出力")),
    "{stopped:?}"
  );

  let mut request = harness.request(&format!("{USER_PROMPT}\n[fake:slow]"));
  request.timeout = Duration::from_secs(1);
  let timed_out = run(&runner, request);
  assert_eq!(
    error_of(&timed_out),
    (ReasonCode::Timeout, "1秒以内に終わらなかったため止めました。".into())
  );
}

#[test]
fn gemini_runs_on_antigravity_cli_and_a_missing_codex_is_not_configured() {
  let _lock = global_lock();
  let harness = Harness::new("providers");
  let runner = harness.runner(&fake_claude());
  let mut gemini = harness.request(USER_PROMPT);
  gemini.provider = Provider::GeminiCli;
  gemini.model = "gemini-3.8-flash".into();
  // Gemini は Antigravity CLI（agy）で動く。この Mac に無ければ見つからないと返す
  assert_eq!(
    error_of(&run(&runner, gemini)),
    (
      ReasonCode::NotConfigured,
      "このMacに Antigravity CLI が見つかりません。".into()
    )
  );
  let status = runner.provider_status(Provider::GeminiCli);
  assert!(!status.installed);
  assert_eq!(status.reason.as_deref(), Some("cli_not_found"));
  // agy のログインはターミナルで（画面からは始められない）
  assert_eq!(
    runner.start_auth(Provider::GeminiCli).unwrap_err().code,
    "auth_unsupported"
  );

  let mut codex = harness.request(USER_PROMPT);
  codex.provider = Provider::CodexCli;
  codex.model = "gpt-5.6-luna".into();
  assert_eq!(
    error_of(&run(&runner, codex)),
    (
      ReasonCode::NotConfigured,
      "このMacに Codex CLI が見つかりません。".into()
    )
  );
  assert_eq!(
    runner.provider_status(Provider::CodexCli).reason.as_deref(),
    Some("cli_not_found")
  );
}

#[test]
fn provider_status_and_maintenance_go_through_the_crate() {
  let _lock = global_lock();
  let harness = Harness::new("status");
  let runner = harness.runner(&fake_claude());
  let status = runner.provider_status(Provider::ClaudeCode);
  assert_eq!(
    status,
    ProviderStatus {
      installed: true,
      authenticated: true,
      version: Some("fake (Claude Code)".into()),
      cli_path: Some(fake_claude().to_string_lossy().into_owned()),
      login_method: Some("偽物（開発用）".into()),
      reason: None,
      missing_cli_flags: vec![],
      capabilities: ProviderCapabilities {
        resume: true,
        effort: true,
        tools_off_proven: true,
        usage: true,
        cost: false,
      },
      models: vec![],
    }
  );
  assert!(!runner.has_running_turns());
  // ログイン済み・導入済みなら何もしない。更新は `claude update` だけを渡して確かめ直す
  assert_eq!(runner.start_auth(Provider::ClaudeCode).unwrap(), status);
  assert_eq!(runner.install_claude().unwrap(), status);
  let update = runner.update_claude().unwrap();
  assert_eq!(update.before_version.as_deref(), Some("fake (Claude Code)"));
  assert_eq!(update.status, status);

  // 更新に失敗したら、画面の文と code だけを返し、CLI の出力はログにだけ残す
  let failing = harness.script(
    "claude-update-fails",
    r#"case "$1" in
  --version) echo "2.1.267 (Claude Code)" ;;
  update) echo "token=sk-ant-secret network down" >&2; exit 7 ;;
  *) exit 0 ;;
esac"#,
  );
  let error = harness.runner(&failing).update_claude().unwrap_err();
  assert_eq!(error.code, "update_failed");
  assert!(error.message.contains("Claude Code を更新できませんでした"));
  let logs = harness.logs.lock().unwrap().join("\n");
  assert!(
    logs.contains("maintenance_failed") && logs.contains("network down"),
    "{logs}"
  );
}

/// 音声の区切りを読む agy の偽物（作業フォルダの中身を写し、文字起こし用のエージェントの init と結果を出す）。
fn fake_reader_agy(harness: &Harness) -> PathBuf {
  let init =
    json!({"event":"init","init":{"model":"gemini-3.8-flash","agent":"niho-docs-transcriber","tools":["view_file"]}});
  let result = json!({"event":"result","result":{"conversation_id":"5b8f0c2e-1d3a-4b5c-8d7e-9f0a1b2c3d4e","status":"SUCCESS","response":"[00:01] こんにちは。","usage":{}}});
  let usage = json!({"status":"SUCCESS","command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.59,"reset_time":"2026-10-21T19:12:26Z"}]}]}}});
  harness.script(
    "agy",
    &format!(
      r#"if [ "$1" = "-p" ]; then printf '%s\n' {usage}; exit 0; fi
cat > /dev/null
ls -A > "$d/ws-entries.txt"
printf '%s\n' "$@" > "$d/agy-args.txt"
printf '%s\n' {init}
printf '%s\n' {result}"#,
      usage = shell_quote(&usage.to_string()),
      init = shell_quote(&init.to_string()),
      result = shell_quote(&result.to_string()),
    ),
  )
}

#[test]
fn gemini_reads_one_audio_part_and_reports_usage_through_the_crate() {
  let _lock = global_lock();
  let harness = Harness::new("agy-reader");
  let agy = fake_reader_agy(&harness);
  let runner = harness.runner_with(&fake_claude(), &agy);
  let part = harness.dir.join("work").join("f0-p1.wav");
  fs::write(&part, b"RIFF").unwrap();
  let mut request = harness.request("part を読む");
  request.provider = Provider::GeminiCli;
  request.model = "gemini-3.8-flash".into();
  request.effort = Some(Effort::Low);
  request.tool_policy = ToolPolicy::ReadFile { file: part.clone() };
  let events = run(&runner, request);
  match last(&events) {
    TurnEvent::Done { text, usage, .. } => {
      assert_eq!(text, "[00:01] こんにちは。");
      assert_eq!(usage.model_used.as_deref(), Some("gemini-3.8-flash"));
      assert!(!usage.cost_known);
    }
    other => panic!("{other:?}"),
  }
  // crate の ReadFile に写る: 作業フォルダにはエージェントと区切りの WAV だけがあり、文字起こし用のエージェントで起動する
  assert_eq!(
    fs::read_to_string(harness.dir.join("ws-entries.txt")).unwrap(),
    ".agents\nf0-p1.wav\n"
  );
  let args = fs::read_to_string(harness.dir.join("agy-args.txt")).unwrap();
  assert!(args.contains("niho-docs-transcriber\n"), "{args}");
  // 使用量の残り（agy の /usage）
  let usage = runner.provider_usage(Provider::GeminiCli).unwrap();
  assert_eq!(usage.windows.len(), 1);
  assert_eq!(usage.windows[0].remaining_fraction, Some(0.59));
  assert_eq!(
    runner.provider_usage(Provider::ClaudeCode).unwrap_err().code,
    "usage_unsupported"
  );
}

#[test]
fn dev_fake_codex_and_agy_show_their_rows_and_run_through_the_crate() {
  let _lock = global_lock();
  let harness = Harness::new("dev-fakes");
  let runner = harness.runner_all(&fake_claude(), &fake_cli("codex"), &fake_cli("agy"));

  // Codex CLI はアプリ用の CODEX_HOME（app data の codex-home）でログインする。初めは未ログイン
  let codex = runner.provider_status(Provider::CodexCli);
  assert!(codex.installed && !codex.authenticated, "{codex:?}");
  assert_eq!(codex.reason.as_deref(), Some("auth_required"));
  assert_eq!(codex.version.as_deref(), Some("codex-cli 0.154.0 (fake)"));
  assert!(codex.models.is_empty());
  let logged_in = runner.start_auth(Provider::CodexCli).unwrap();
  assert!(logged_in.authenticated);
  assert_eq!(logged_in.login_method.as_deref(), Some("ChatGPT"));
  assert_eq!(logged_in.models, ["gpt-5.6-terra", "gpt-5.6-luna"]);
  assert!(harness.dir.join(CODEX_HOME_DIR).join("fake-logged-in").is_file());

  // Antigravity CLI: 状態（agy models の一覧）・週の残り・ログインは画面から始めない
  let agy = runner.provider_status(Provider::GeminiCli);
  assert!(agy.installed && agy.authenticated, "{agy:?}");
  assert_eq!(agy.models[0], "gemini-3.8-flash-high");
  let usage = runner.provider_usage(Provider::GeminiCli).unwrap();
  assert_eq!(usage.windows[0].group, "Gemini Models");
  assert_eq!(usage.windows[0].remaining_fraction, Some(0.59));
  assert_eq!(
    runner.start_auth(Provider::GeminiCli).unwrap_err().code,
    "auth_unsupported"
  );

  // 区切りの WAV を読む 1 往復（偽の niho-speech の slice は範囲を書いたファイルを置く）
  let part = harness.dir.join("work").join("f0-p1.wav");
  fs::write(&part, "slice 48.000 95.000\n").unwrap();
  let mut request = harness.request("view_file で f0-p1.wav を読む");
  request.provider = Provider::GeminiCli;
  request.model = "gemini-3.8-flash".into();
  request.effort = Some(Effort::Low);
  request.tool_policy = ToolPolicy::ReadFile { file: part };
  match last(&run(&runner, request)) {
    TurnEvent::Done { text, usage, .. } => {
      assert!(
        text.starts_with("[00:01] 話者0: これは偽の agy の文字起こしです（f0-p1.wav・48.000 95.000）。"),
        "{text}"
      );
      assert!(usage.output_tokens > 0);
    }
    other => panic!("{other:?}"),
  }
  // 工程の 1 往復（ツール無しのエージェント）
  let mut request = harness.request(USER_PROMPT);
  request.provider = Provider::GeminiCli;
  request.model = "gemini-3.8-flash".into();
  request.effort = Some(Effort::Medium);
  match last(&run(&runner, request)) {
    TurnEvent::Done { text, .. } => assert!(text.starts_with("# 偽の出力"), "{text}"),
    other => panic!("{other:?}"),
  }
}

#[test]
fn stop_after_the_end_and_shutdown_are_harmless() {
  let _lock = global_lock();
  let harness = Harness::new("shutdown");
  let runner = harness.runner(&fake_claude());
  let (sender, receiver) = mpsc::channel();
  let handle = runner.run_turn(
    harness.request(USER_PROMPT),
    Box::new(move |event| {
      let _ = sender.send(event);
    }),
  );
  while !receiver.recv_timeout(Duration::from_secs(20)).unwrap().is_terminal() {}
  handle.stop();
  runner.shutdown();
  assert!(!runner.has_running_turns());
}

#[test]
fn paragraph_breaks_at_the_edges_survive_for_the_app_continuation() {
  let _lock = global_lock();
  let harness = Harness::new("edges");
  let stream = |event: Value| json!({ "type": "stream_event", "event": event }).to_string();
  let text =
    |text: &str| stream(json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":text}}));
  let lines = [
    json!({"type":"system","subtype":"init","session_id":"s","tools":[],"mcp_servers":[]}).to_string(),
    stream(json!({"type":"message_start","message":{"usage":{"input_tokens":1}}})),
    text("前半の段落です。"),
    text("\n\n"),
    stream(json!({"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":5}})),
    json!({"type":"result","subtype":"success","is_error":false,"result":"","stop_reason":"max_tokens","duration_ms":3,"usage":{"input_tokens":1,"output_tokens":5}}).to_string(),
  ];
  fs::write(harness.dir.join("stdout.jsonl"), format!("{}\n", lines.join("\n"))).unwrap();
  let claude = harness.script("claude", "cat > /dev/null\ncat \"$d/stdout.jsonl\"");
  let events = run(&harness.runner(&claude), harness.request(USER_PROMPT));
  assert!(
    matches!(last(&events), TurnEvent::Done { stop_reason: StopReason::MaxTokens, text, .. } if text == "前半の段落です。\n\n"),
    "{events:?}"
  );

  let mut edges = StreamEdges::default();
  for delta in ["\n", "\n## 見出し", "\n本文", " \n"] {
    edges.push(delta);
  }
  assert_eq!(edges.restore("## 見出し\n本文".into()), "\n\n## 見出し\n本文 \n");
  // 差分が無い・本文が空・もう空白が付いているときはそのまま
  assert_eq!(StreamEdges::default().restore("本文".into()), "本文");
  assert_eq!(edges.restore(String::new()), "");
  assert_eq!(edges.restore("本文\n".into()), "本文\n");
}

#[test]
fn cli_paths_come_from_the_settings_and_the_environment() {
  let settings =
    json!({ "cliPaths": { "claude": "/opt/fake/claude", "gpt": "relative/codex", "gemini": "/opt/fake/agy" } });
  let env = |_: &str| None;
  assert_eq!(
    cli_path_overrides_with(Some(&settings), env),
    BTreeMap::from([
      (local::Provider::ClaudeCode, PathBuf::from("/opt/fake/claude")),
      (local::Provider::GeminiCli, PathBuf::from("/opt/fake/agy")),
    ])
  );
  let settings = json!({ "cliPaths": { "claude": "/opt/fake/claude", "gpt": "relative/codex" } });
  // 環境変数（開発・テスト）は設定より優先する
  let env = |key: &str| (key == CODEX_PATH_ENV || key == CLAUDE_PATH_ENV).then(|| format!("/env/{key}"));
  assert_eq!(
    cli_path_overrides_with(Some(&settings), env),
    BTreeMap::from([
      (
        local::Provider::ClaudeCode,
        PathBuf::from(format!("/env/{CLAUDE_PATH_ENV}"))
      ),
      (
        local::Provider::CodexCli,
        PathBuf::from(format!("/env/{CODEX_PATH_ENV}"))
      ),
    ])
  );
  assert!(cli_path_overrides_with(None, |_| None).is_empty());
  // Codex は app data の下の専用の CODEX_HOME で動く（~/.codex/AGENTS.md を混ぜない・ログインもこのアプリ用）
  let runtime = runtime_for(Path::new("/data"), BTreeMap::new(), None);
  assert_eq!(runtime.codex_home, Some(PathBuf::from("/data/codex-home")));
  assert_eq!(runtime.scratch_dir, PathBuf::from("/data/local-ai"));
}

#[test]
fn usage_keeps_a_provider_cost_but_not_the_claude_code_estimate() {
  let usage = local::Usage {
    input_tokens: 10,
    output_tokens: 20,
    cost_usd: Some(0.25),
    model_used: None,
  };
  // crate が実モデルを返さない（Codex CLI など）ときは依頼したモデル名
  assert_eq!(
    app_usage(local::Provider::ClaudeCode, usage.clone(), "opus"),
    Usage {
      input_tokens: 10,
      output_tokens: 20,
      cost_usd: None,
      model_used: Some("opus".into()),
      cost_known: false,
    }
  );
  // crate が実モデルを返したときは、設定の別名ではなくその ID
  let answered = local::Usage {
    model_used: Some("claude-opus-4-8".into()),
    ..usage.clone()
  };
  assert_eq!(
    app_usage(local::Provider::ClaudeCode, answered, "opus")
      .model_used
      .as_deref(),
    Some("claude-opus-4-8")
  );
  let codex = app_usage(local::Provider::CodexCli, usage, "gpt-5.5");
  assert_eq!((codex.cost_usd, codex.cost_known), (Some(0.25), true));
  assert_eq!(app_reason(local::ReasonCode::TimedOut), ReasonCode::Timeout);
}

#[test]
fn the_log_file_rotates_at_one_megabyte() {
  let harness = Harness::new("log");
  let dir = harness.dir.join("logs");
  let log = file_log(dir.clone());
  log("turn_failed", json!({ "reasonCode": "RUNTIME_TIMED_OUT" }));
  let first = fs::read_to_string(dir.join(LOG_FILE)).unwrap();
  let entry: Value = serde_json::from_str(first.trim()).unwrap();
  assert_eq!(entry["kind"], "turn_failed");
  assert_eq!(entry["data"]["reasonCode"], "RUNTIME_TIMED_OUT");
  fs::write(dir.join(LOG_FILE), vec![b'x'; LOG_MAX_BYTES as usize + 1]).unwrap();
  log("spawn_failed", json!({}));
  assert!(dir.join(format!("{LOG_FILE}.1")).is_file());
  assert!(fs::metadata(dir.join(LOG_FILE)).unwrap().len() < 1024);
}

// ---------------------------------------------------------------------------
// 共有の fixture（apps/docs/fixtures/turn-events/。docs-core の turn.test.ts も同じものを読む）

fn fixture_dir() -> PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/turn-events")
}

/// fixture の `ignore` に挙げたフィールド（値が実行ごとに変わる）を比べない。
fn without_ignored(mut event: Value, ignore: &[String]) -> Value {
  if let Value::Object(map) = &mut event {
    for key in ignore {
      map.remove(key);
    }
  }
  event
}

#[test]
fn shared_turn_event_fixtures() {
  let _lock = global_lock();
  let mut names: Vec<PathBuf> = fs::read_dir(fixture_dir())
    .unwrap()
    .filter_map(|entry| entry.ok().map(|entry| entry.path()))
    .filter(|path| path.extension().map(|ext| ext == "json").unwrap_or(false))
    .collect();
  names.sort();
  assert_eq!(names.len(), 5, "正常・停止・時間切れ・壊れた JSONL・修正の会話のツール");
  for path in names {
    let fixture: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    let scenario = fixture["scenario"].as_str().unwrap().to_string();
    assert_eq!(fixture["schemaVersion"], 1, "{scenario}");
    let harness = Harness::new(&format!("fixture-{scenario}"));
    let lines: Vec<&str> = fixture["cli"]["stdout"]
      .as_array()
      .unwrap()
      .iter()
      .map(|line| line.as_str().unwrap())
      .collect();
    fs::write(harness.dir.join("stdout.jsonl"), format!("{}\n", lines.join("\n"))).unwrap();
    let hang = fixture["cli"]["then"] == "hang";
    let claude = harness.script(
      "claude",
      &format!(
        "cat > /dev/null\ncat \"$d/stdout.jsonl\"\n{}",
        if hang { "sleep 30 &\nwait" } else { "exit 0" }
      ),
    );
    let mut request = harness.request(USER_PROMPT);
    request.model = fixture["request"]["model"].as_str().unwrap().to_string();
    if fixture["request"]["toolPolicy"] == "projectFolder" {
      // 修正の会話: 案件フォルダ（artifacts/ を持つ）の中だけを読み書きさせる
      let dir = harness.dir.join("work");
      fs::create_dir_all(dir.join("artifacts")).unwrap();
      request.tool_policy = ToolPolicy::ProjectFolder {
        dir,
        writable: vec!["artifacts".into()],
        web_search: true,
      };
    }
    let control = &fixture["control"];
    if control["action"] == "timeout" {
      request.timeout = Duration::from_millis(control["timeoutMs"].as_u64().unwrap());
    }
    let stop_after = (control["action"] == "stop").then(|| control["afterEvents"].as_u64().unwrap() as usize);
    let events = run_with(&harness.runner(&claude), request, stop_after);
    let ignore: Vec<String> = fixture["ignore"]
      .as_array()
      .unwrap()
      .iter()
      .map(|key| key.as_str().unwrap().to_string())
      .collect();
    // 共有の期待は `Notice`（#283）を持たない。この疑似 CLI は Web の道具を持たないので、`webSearchUnsupported` が先に流れる。
    // それだけを取り除いて比べる（ほかの知らせが混ざれば、そのまま差になって落ちる）
    let actual: Vec<Value> = events
      .iter()
      .filter(|event| !matches!(event, TurnEvent::Notice { code, .. } if code == "webSearchUnsupported"))
      .map(|event| without_ignored(event.to_wire(), &ignore))
      .collect();
    let expected: Vec<Value> = fixture["events"]
      .as_array()
      .unwrap()
      .iter()
      .map(|event| without_ignored(event.clone(), &ignore))
      .collect();
    assert_eq!(actual, expected, "{scenario}");
  }
}

// ---------------------------------------------------------------------------
// 本物

/// 本物の Claude Code で 1 往復する（このMacでログイン済みのとき）。CI では走らない。手元で:
/// `cargo test -p niho_docs real_claude -- --ignored --nocapture`
#[test]
#[ignore]
fn real_claude_round_trip() {
  let _lock = global_lock();
  let harness = Harness::new("real-claude");
  let runner = LocalAiRunner::new(runtime_for(&harness.dir, BTreeMap::new(), None));
  let status = runner.provider_status(Provider::ClaudeCode);
  println!("status: {}", serde_json::to_string(&status).unwrap());
  assert!(status.installed && status.authenticated, "{status:?}");
  let mut request = harness.request("こんにちはと 1 語で返してください。");
  request.system_prompt = "あなたは短く答えるアシスタントです。".into();
  request.effort = Some(Effort::Low);
  request.timeout = Duration::from_secs(5 * 60);
  let events = run(&runner, request);
  let deltas = events.iter().filter(|event| !event.is_terminal()).count();
  println!("deltas: {deltas}");
  println!("done: {}", last(&events).to_wire());
  let TurnEvent::Done {
    text,
    stop_reason,
    session_id,
    usage,
    ..
  } = last(&events)
  else {
    panic!("{events:?}");
  };
  assert_eq!(*stop_reason, StopReason::EndTurn);
  assert!(text.contains("こんにちは"), "{text}");
  assert!(session_id.as_deref().is_some_and(is_uuid));
  assert!(usage.input_tokens > 0 && usage.output_tokens > 0, "{usage:?}");
  assert_eq!((usage.cost_usd, usage.cost_known), (None, false));
}
