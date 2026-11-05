//! 偽の CLI（`#!/bin/sh` のスクリプト）での結合テスト。本物の claude・codex・agy は起動しない。
//! CLI の場所・HOME・一時ファイルの置き場は全部テスト用のフォルダにするので、利用者の ~/.claude・~/.codex・~/.gemini も
//! 読まない。偽物は引数を 1 行 1 個で、標準入力・渡された一時ファイルの中身を `$OUT` の下へ写す。
#![cfg(unix)]

use niho_local_ai::{
  install_claude_with, provider_status_with, provider_usage_with, run_turn_with, start_auth_with, update_claude_with,
  Capabilities, InstallerConfig, Provider, ReasonCode, Runtime, StopReason, ToolPolicy, TurnEvent, TurnHandle,
  TurnRequest, Usage,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 同時実行の数・`--thinking-display` の記憶・更新とログインの排他はプロセス内で共有されるので、
/// 工程・ログイン・更新・インストールを動かすテストはすべてこの鍵を取って直列にする。
fn global_lock() -> MutexGuard<'static, ()> {
  static LOCK: Mutex<()> = Mutex::new(());
  LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

const SESSION: &str = "11111111-2222-4333-8444-555555555555";
const THREAD: &str = "01a13b6e-21d7-7093-8fc2-637efb0dd571";
const SYSTEM_PROMPT: &str = "NIHO_SYSTEM_PROMPT_MARKER あなたは編集者です。\n\"引用\" と \\ を含む";
const USER_PROMPT: &str = "NIHO_USER_PROMPT_MARKER 記事を直してください。";
const TOO_MANY: &str = "このMacで実行中の工程が多すぎます。終わってからもう一度試してください。";
const MAINTENANCE_BUSY: &str = "AI の CLI の更新またはログインが終わってから、もう一度実行してください。";

const CLAUDE_HELP_FLAGS: [&str; 15] = [
  "-p, --print",
  "--output-format <format>",
  "--verbose",
  "--include-partial-messages",
  "--setting-sources <sources>",
  "--strict-mcp-config",
  "--restricted",
  "--tools <tools...>",
  "--disable-slash-commands",
  "--permission-mode <mode>",
  "--model <model>",
  "--effort <level>",
  "--session-id <uuid>",
  "-r, --resume [value]",
  "--max-budget-usd <amount>",
];
const CODEX_HELP: &str = "Usage: codex exec [OPTIONS] [PROMPT]\n  -c, --config <key=value>\n      --enable <FEATURE>\n      --disable <FEATURE>\n  -m, --model <MODEL>\n  -s, --sandbox <SANDBOX_MODE>\n      --skip-git-repo-check\n      --ignore-user-config\n      --ignore-rules\n      --json";
const AGY_HELP: &str = "Usage: agy [flags]\nFlags:\n      --agent string\n      --conversation string\n      --dangerously-skip-permissions\n      --disable-slash-commands\n      --effort string\n      --input-format string\n      --model string\n      --output-format string\n  -p, --print string\n      --print-timeout duration";
/// 会話の ID（agy は UUID を返す）。
const CONVERSATION: &str = "5b8f0c2e-1d3a-4b5c-8d7e-9f0a1b2c3d4e";
const OTHER_CONVERSATION: &str = "0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e";
const AGY_MODEL_MESSAGE: &str =
  "Antigravity CLI でこのモデルと思考量の組み合わせを使えません。設定のモデルを確かめてください。";

// ---------------------------------------------------------------------------
// 道具

fn sh_quote(value: &str) -> String {
  format!("'{}'", value.replace('\'', "'\\''"))
}

/// 1 行ずつ stdout へ出すシェルの文（printf はバックスラッシュを解釈しない）。
fn print_lines(lines: &[String]) -> String {
  lines
    .iter()
    .map(|line| format!("printf '%s\\n' {}", sh_quote(line)))
    .collect::<Vec<_>>()
    .join("\n")
}

struct Harness {
  dir: PathBuf,
  logs: Arc<Mutex<Vec<String>>>,
}

impl Harness {
  fn new(name: &str) -> Self {
    let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("niho-local-ai-test-{name}-{}-{unique}", std::process::id()));
    for sub in ["bin", "scratch", "home", "work", "out"] {
      fs::create_dir_all(dir.join(sub)).unwrap();
    }
    Self {
      dir,
      logs: Arc::new(Mutex::new(Vec::new())),
    }
  }

  fn bin(&self, name: &str) -> PathBuf {
    self.dir.join("bin").join(name)
  }

  fn out(&self, name: &str) -> PathBuf {
    self.dir.join("out").join(name)
  }

  fn read_out(&self, name: &str) -> String {
    fs::read_to_string(self.out(name)).unwrap_or_else(|err| panic!("{name}: {err}"))
  }

  fn touch_out(&self, name: &str) {
    fs::write(self.out(name), "").unwrap();
  }

  fn scratch(&self) -> PathBuf {
    self.dir.join("scratch")
  }

  /// 偽の CLI を bin/<name> に書く。`$OUT` は記録用のフォルダ。
  fn fake(&self, name: &str, body: &str) -> PathBuf {
    let path = self.bin(name);
    // codex は起動の前に `codex features list` を読む（切る機能を版に依らず決める）。どの偽物も同じ一覧を返す
    let body = if name == "codex" {
      format!("{CODEX_FEATURES}\n{body}")
    } else {
      body.to_string()
    };
    let script = format!(
      "#!/bin/sh\nOUT={}\n{body}\n",
      sh_quote(&self.dir.join("out").to_string_lossy())
    );
    fs::write(&path, script).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
  }

  fn runtime(&self) -> Runtime {
    let logs = self.logs.clone();
    Runtime {
      cli_paths: BTreeMap::from([
        (Provider::ClaudeCode, self.bin("claude")),
        (Provider::CodexCli, self.bin("codex")),
        (Provider::GeminiCli, self.bin("agy")),
      ]),
      scratch_dir: self.scratch(),
      home_dir: Some(self.dir.join("home")),
      kill_grace: Duration::from_millis(200),
      claude_installer: InstallerConfig {
        curl: self.bin("curl"),
        shell: self.bin("shell"),
        url: "https://example.invalid/install.sh".to_string(),
      },
      log: Some(Arc::new(move |kind, payload| {
        logs.lock().unwrap().push(format!("{kind} {payload}"))
      })),
      codex_home: Some(self.codex_home()),
    }
  }

  /// codex の置き場（`CODEX_HOME`）。利用者の ~/.codex を読まないよう、テスト用のフォルダにする。
  fn codex_home(&self) -> PathBuf {
    self.dir.join("codex-home")
  }

  fn request(&self, provider: Provider, model: &str) -> TurnRequest {
    TurnRequest {
      provider,
      model: model.to_string(),
      effort: None,
      system_prompt: SYSTEM_PROMPT.to_string(),
      user_prompt: USER_PROMPT.to_string(),
      resume_session: None,
      workdir: self.dir.join("work"),
      timeout: Duration::from_secs(20),
      max_budget_usd: None,
      tool_policy: ToolPolicy::None,
    }
  }

  /// 案件フォルダ（work/project。artifacts/ と、書いてはいけない project.json を持つ）。
  fn project(&self) -> PathBuf {
    let dir = self.dir.join("work").join("project");
    fs::create_dir_all(dir.join("artifacts")).unwrap();
    fs::write(
      dir.join("artifacts").join("abc12345.md"),
      "# とても長い見出し\n\n本文。\n",
    )
    .unwrap();
    fs::write(dir.join("project.json"), "{\"id\":\"p1\"}\n").unwrap();
    dir
  }

  /// 案件フォルダの中だけを読み書きする依頼（書けるのは artifacts/ の下だけ）。
  fn folder_request(&self, provider: Provider, model: &str) -> TurnRequest {
    let dir = self.project();
    TurnRequest {
      workdir: dir.clone(),
      tool_policy: ToolPolicy::ProjectFolder {
        dir,
        writable: vec!["artifacts".to_string()],
      },
      ..self.request(provider, model)
    }
  }

  fn start(&self, req: TurnRequest) -> (TurnHandle, Arc<Mutex<Vec<TurnEvent>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let handle = run_turn_with(&self.runtime(), req, move |event| sink.lock().unwrap().push(event));
    (handle, events)
  }

  /// 1 回実行して、届いたイベントを返す。最後のイベント（Done／Error）はちょうど 1 回で、いちばん最後。
  fn run(&self, req: TurnRequest) -> Vec<TurnEvent> {
    let (handle, events) = self.start(req);
    handle.wait();
    let events = events.lock().unwrap().clone();
    assert_one_terminal_last(&events);
    events
  }

  fn scratch_is_empty(&self) -> bool {
    fs::read_dir(self.scratch())
      .map(|mut entries| entries.next().is_none())
      .unwrap_or(true)
  }

  fn logs(&self) -> Vec<String> {
    self.logs.lock().unwrap().clone()
  }
}

impl Drop for Harness {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.dir);
  }
}

struct DetachedPidCleanup(PathBuf);

impl Drop for DetachedPidCleanup {
  fn drop(&mut self) {
    if let Ok(pid) =
      fs::read_to_string(&self.0).and_then(|value| value.trim().parse::<libc::pid_t>().map_err(std::io::Error::other))
    {
      // SAFETY: the PID is written by the test's own detached child process.
      unsafe {
        libc::kill(pid, libc::SIGKILL);
      }
    }
  }
}

fn assert_one_terminal_last(events: &[TurnEvent]) {
  assert_eq!(
    events.iter().filter(|event| event.is_terminal()).count(),
    1,
    "{events:?}"
  );
  assert!(events.last().is_some_and(TurnEvent::is_terminal), "{events:?}");
}

fn error_of(events: &[TurnEvent]) -> (ReasonCode, String) {
  match events.last() {
    Some(TurnEvent::Error { reason_code, message }) => (*reason_code, message.clone()),
    other => panic!("expected an error, got {other:?} in {events:?}"),
  }
}

#[derive(Debug)]
struct DoneView {
  text: String,
  stop_reason: StopReason,
  session_id: Option<String>,
  usage: Usage,
  duration_ms: u64,
  continuations: u32,
}

fn done_of(events: &[TurnEvent]) -> DoneView {
  match events.last() {
    Some(TurnEvent::Done {
      text,
      stop_reason,
      session_id,
      usage,
      duration_ms,
      continuations,
    }) => DoneView {
      text: text.clone(),
      stop_reason: *stop_reason,
      session_id: session_id.clone(),
      usage: usage.clone(),
      duration_ms: *duration_ms,
      continuations: *continuations,
    },
    other => panic!("expected done, got {other:?} in {events:?}"),
  }
}

fn deltas(events: &[TurnEvent]) -> Vec<TurnEvent> {
  events.iter().filter(|event| !event.is_terminal()).cloned().collect()
}

fn args_of(text: &str) -> Vec<String> {
  text.lines().map(str::to_string).collect()
}

fn arg_after(args: &[String], flag: &str) -> Option<String> {
  args
    .iter()
    .position(|arg| arg == flag)
    .and_then(|index| args.get(index + 1))
    .cloned()
}

fn wait_until(limit: Duration, what: &str, mut condition: impl FnMut() -> bool) {
  let started = Instant::now();
  while !condition() {
    assert!(started.elapsed() < limit, "timed out waiting for {what}");
    std::thread::sleep(Duration::from_millis(20));
  }
}

fn same_dir(left: &Path, right: &Path) -> bool {
  fs::canonicalize(left).unwrap() == fs::canonicalize(right).unwrap()
}

/// `path` が `dir` の下か（`path` はもう消えていてよい。macOS の /var → /private/var のリンクを解いた形でも見る）。
fn is_under(path: &Path, dir: &Path) -> bool {
  path.starts_with(dir) || fs::canonicalize(dir).is_ok_and(|dir| path.starts_with(dir))
}

// --- claude の stream-json ---

fn claude_init() -> String {
  json!({"type":"system","subtype":"init","session_id":"s","tools":[],"mcp_servers":[],"model":"claude-sonnet-5"})
    .to_string()
}

fn claude_stream(event: Value) -> String {
  json!({ "type": "stream_event", "event": event, "parent_tool_use_id": null }).to_string()
}

fn claude_message_start(input: u64) -> String {
  claude_stream(
    json!({"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":input,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000,"output_tokens":1}}}),
  )
}

fn claude_text(text: &str) -> String {
  claude_stream(json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":text}}))
}

fn claude_thinking(text: &str) -> String {
  claude_stream(json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":text}}))
}

fn claude_message_delta(stop_reason: &str, output: u64) -> String {
  claude_stream(json!({"type":"message_delta","delta":{"stop_reason":stop_reason},"usage":{"output_tokens":output}}))
}

fn claude_result(extra: Value) -> String {
  let mut base = json!({"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"result":"","stop_reason":"end_turn","session_id":"s","total_cost_usd":0.25,
    "usage":{"input_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000,"output_tokens":20}});
  for (key, value) in extra.as_object().unwrap() {
    base[key] = value.clone();
  }
  base.to_string()
}

/// 標準入力・引数・system prompt のファイル（中身と場所）・cwd を写す claude の偽物の頭。
const CLAUDE_RECORD: &str = r#"cat > "$OUT/stdin.txt"
printf '%s\n' "$@" > "$OUT/args.txt"
pwd > "$OUT/pwd.txt"
prev=""
for a in "$@"; do
  if [ "$prev" = "--system-prompt-file" ]; then cp "$a" "$OUT/system-prompt-copy.txt"; printf '%s' "$a" > "$OUT/system-prompt-path.txt"; fi
  prev="$a"
done"#;

/// `--version`・`--help`・`auth status`・`auth login`・`update` と、`-p`（工程）を受ける claude の偽物。
/// ふるまいは `$OUT` の印のファイル（logged-in・login-fails・login-waits・update-fails）で変える。
fn claude_cli_body(help_flags: &[&str], turn: &str) -> String {
  let help = help_flags
    .iter()
    .map(|flag| format!("  {flag}"))
    .collect::<Vec<_>>()
    .join("\n");
  format!(
    r#"case "$1" in
  --version)
    if [ -f "$OUT/version.txt" ]; then cat "$OUT/version.txt"; else echo "2.1.267 (Claude Code)"; fi
    exit 0
    ;;
  --help)
    cat <<'HELP'
Usage: claude [options] [command] [prompt]
{help}
HELP
    exit 0
    ;;
  auth)
    if [ "$2" = status ]; then
      if [ -f "$OUT/logged-in" ]; then echo "Login method: Claude Max account"; exit 0; fi
      echo "Not logged in. Run claude auth login."
      exit 1
    fi
    if [ "$2" = login ]; then
      printf '%s\n' "$@" > "$OUT/auth-args.txt"
      if [ -f "$OUT/login-fails" ]; then exit 7; fi
      if [ -f "$OUT/login-waits" ]; then touch "$OUT/auth-started"; sleep 2; fi
      touch "$OUT/logged-in"
      exit 0
    fi
    ;;
  update)
    printf '%s\n' "$@" > "$OUT/update-args.txt"
    if [ -f "$OUT/update-fails" ]; then echo 'update failed' >&2; exit 7; fi
    echo "2.1.300 (Claude Code)" > "$OUT/version.txt"
    echo "Successfully updated"
    exit 0
    ;;
  -p)
    cat > /dev/null
{turn}
    exit 0
    ;;
esac
exit 64"#
  )
}

fn codex_cli_body(help: &str) -> String {
  format!(
    r#"case "$1" in
  --version) echo "codex-cli 0.154.0"; exit 0;;
  exec)
    if [ "$2" = "--help" ]; then
      cat <<'HELP'
{help}
HELP
      exit 0
    fi
    ;;
  login)
    if [ "$2" = status ]; then
      if [ -f "$OUT/codex-logged-in" ]; then echo "Logged in using ChatGPT" >&2; exit 0; fi
      echo "Not logged in" >&2
      exit 1
    fi
    printf '%s\n' "$@" > "$OUT/codex-login-args.txt"
    printf '%s' "${{CODEX_HOME:-}}" > "$OUT/codex-login-home.txt"
    touch "$OUT/codex-logged-in"
    exit 0
    ;;
  debug)
    if [ "$2" = models ]; then
      printf '%s' "${{CODEX_HOME:-}}" > "$OUT/codex-models-home.txt"
      if [ -f "$OUT/codex-models-large" ]; then
        # 実機（0.163.0）のカタログはモデルごとの長い指示を含み、256 KiB を超える
        pad=$(head -c 400000 /dev/zero | tr '\0' x)
        printf '{{"models":[{{"slug":"gpt-6.1-sol","visibility":"list","base_instructions":"%s"}},{{"slug":"gpt-6-astra","visibility":"list"}}]}}\n' "$pad"
        exit 0
      fi
      echo '{{"models":[{{"slug":"gpt-6-astra","visibility":"list"}},{{"slug":"gpt-reserve","visibility":"hide"}},{{"slug":"gpt-5.6-sol","visibility":"list"}}]}}'
      exit 0
    fi
    ;;
esac
exit 64"#
  )
}

/// `--version`・`--help`・`models` を受ける agy の偽物。ふるまいは `$OUT` の印のファイル（agy-logged-in・
/// agy-models-broken・agy-old-help）で変える。ログインしていない `models` は端末が無いときの実機と同じく待たずに終わる。
fn agy_cli_body() -> String {
  format!(
    r#"case "$1" in
  --version) echo "1.3.5"; exit 0;;
  --help)
    if [ -f "$OUT/agy-old-help" ]; then
      printf 'Flags:\n  -p, --print string\n      --model string\n      --output-format string\n'
      exit 0
    fi
    cat <<'HELP'
{AGY_HELP}
HELP
    exit 0
    ;;
  models)
    if [ -f "$OUT/agy-models-broken" ]; then echo "error: could not reach the model service" >&2; exit 1; fi
    if [ -f "$OUT/agy-logged-in" ]; then
      echo "Fetching available models..."
      printf 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n'
      printf 'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n'
      printf 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n'
      printf 'claude-sonnet-4-6\tClaude Sonnet 4.6\n'
      printf 'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n'
      printf 'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n'
      exit 0
    fi
    echo "error: authentication required" >&2
    exit 1
    ;;
esac
exit 64"#
  )
}

// --- agy の stream-json ---

fn agy_init(agent: &str) -> String {
  json!({"event":"init","init":{"model":"gemini-3.8-flash-low","cwd":"/x","tools":["manage_task","view_file","run_command"],"permission_mode":"request-review","agent":agent}})
    .to_string()
}

fn agy_step(conversation: &str, index: u64, state: &str, step_type: &str, extra: Value) -> String {
  let mut body = json!({"conversation_id":conversation,"step_index":index,"state":state,"step_type":step_type});
  for (key, value) in extra.as_object().unwrap() {
    body[key] = value.clone();
  }
  json!({"event":"step_update","step_update":body}).to_string()
}

fn agy_user_input(conversation: &str) -> String {
  agy_step(conversation, 0, "DONE", "user_input", json!({}))
}

/// SUCCESS の result（usage・duration_seconds・num_turns は会話の累計）。
fn agy_result(conversation: &str, extra: Value) -> String {
  let mut body = json!({"conversation_id":conversation,"status":"SUCCESS","response":"","duration_seconds":99.0,"num_turns":2,
    "usage":{"input_tokens":4524,"output_tokens":40,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":4564}});
  for (key, value) in extra.as_object().unwrap() {
    body[key] = value.clone();
  }
  json!({"event":"result","result":body}).to_string()
}

/// 標準入力（そのまま）・引数・cwd と、cwd の中の agent.md（中身と権限）・cwd に置かれたものを写す agy の偽物の頭。
const AGY_RECORD: &str = r#"cat > "$OUT/stdin.txt"
printf '%s\n' "$@" > "$OUT/args.txt"
pwd > "$OUT/pwd.txt"
cp .agents/agents/niho-docs-writer/agent.md "$OUT/agent-copy.md"
ls -ld . | cut -c1-10 > "$OUT/ws-mode.txt"
ls -l .agents/agents/niho-docs-writer/agent.md | cut -c1-10 > "$OUT/agent-mode.txt"
ls -A > "$OUT/ws-entries.txt""#;

// ---------------------------------------------------------------------------
// claude

#[test]
fn claude_success_passes_args_stdin_and_a_removed_system_prompt_file() {
  let _guard = global_lock();
  let h = Harness::new("claude-success");
  let lines = vec![
    claude_init(),
    claude_message_start(10),
    claude_stream(json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}})),
    claude_thinking("考え中"),
    claude_stream(json!({"type":"content_block_stop","index":0})),
    claude_text("こんに"),
    claude_text("ちは"),
    claude_message_delta("end_turn", 20),
    json!({"type":"assistant","message":{"content":[{"type":"text","text":"こんにちは"}]},"parent_tool_use_id":null})
      .to_string(),
    claude_result(json!({"result":"こんにちは"})),
  ];
  h.fake("claude", &format!("{CLAUDE_RECORD}\n{}", print_lines(&lines)));
  let events = h.run(h.request(Provider::ClaudeCode, "claude-sonnet-5"));

  assert_eq!(
    deltas(&events),
    vec![
      TurnEvent::ThinkingDelta("考え中".into()),
      TurnEvent::TextDelta("こんに".into()),
      TurnEvent::TextDelta("ちは".into()),
    ]
  );
  let mut args = args_of(&h.read_out("args.txt"));
  // `--thinking-display` の有無はプロセス内の記憶による（拒否のテストが先に走ると付かない）
  if args.get(5).map(String::as_str) == Some("--thinking-display") {
    assert_eq!(args[6], "summarized");
    args.drain(5..7);
  }
  let prompt_path = h.read_out("system-prompt-path.txt");
  let session_id = arg_after(&args, "--session-id").expect("new session id");
  let expected: Vec<String> = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
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
    prompt_path.as_str(),
    "--session-id",
    session_id.as_str(),
  ]
  .iter()
  .map(|value| value.to_string())
  .collect();
  assert_eq!(args, expected);
  assert!(!args.iter().any(|arg| arg == "--resume"));

  let done = done_of(&events);
  assert_eq!(done.text, "こんにちは");
  assert_eq!(done.stop_reason, StopReason::EndTurn);
  assert_eq!(done.session_id.as_deref(), Some(session_id.as_str()));
  assert_eq!(
    done.usage,
    Usage {
      input_tokens: 1110,
      output_tokens: 20,
      cost_usd: Some(0.25),
      model_used: Some("claude-sonnet-5".into()),
    }
  );
  assert_eq!(done.duration_ms, 1234);
  assert_eq!(done.continuations, 0);

  assert_eq!(h.read_out("stdin.txt"), USER_PROMPT);
  assert_eq!(h.read_out("system-prompt-copy.txt"), SYSTEM_PROMPT);
  assert!(!Path::new(&prompt_path).exists(), "system prompt file is removed");
  assert!(Path::new(&prompt_path).starts_with(h.scratch()));
  assert!(h.scratch_is_empty());
  assert!(same_dir(Path::new(h.read_out("pwd.txt").trim()), &h.dir.join("work")));
  // 指示文・システムプロンプトはログにもイベントにも出ない
  for line in h.logs() {
    assert!(
      !line.contains("NIHO_SYSTEM_PROMPT_MARKER") && !line.contains("NIHO_USER_PROMPT_MARKER"),
      "{line}"
    );
  }
  assert!(events
    .iter()
    .all(|event| !format!("{event:?}").contains("NIHO_SYSTEM_PROMPT_MARKER")));
}

#[test]
fn claude_resume_uses_resume_without_session_id() {
  let _guard = global_lock();
  let h = Harness::new("claude-resume");
  let lines = vec![
    claude_init(),
    claude_message_start(1),
    claude_text("続き"),
    claude_result(json!({"result":"続き"})),
  ];
  h.fake("claude", &format!("{CLAUDE_RECORD}\n{}", print_lines(&lines)));
  let mut req = h.request(Provider::ClaudeCode, "claude-sonnet-5");
  req.resume_session = Some(SESSION.to_string());
  req.effort = Some(niho_local_ai::Effort::High);
  req.max_budget_usd = Some(2.5);
  let events = h.run(req);
  let args = args_of(&h.read_out("args.txt"));
  assert_eq!(arg_after(&args, "--resume").as_deref(), Some(SESSION));
  assert!(!args.iter().any(|arg| arg == "--session-id"));
  assert_eq!(arg_after(&args, "--effort").as_deref(), Some("high"));
  assert_eq!(arg_after(&args, "--max-budget-usd").as_deref(), Some("2.5"));
  let done = done_of(&events);
  assert_eq!(done.session_id.as_deref(), Some(SESSION));
  assert_eq!(done.text, "続き");
}

#[test]
fn claude_auto_continuations_are_merged_without_the_overlap() {
  let _guard = global_lock();
  let h = Harness::new("claude-continuations");
  let lines = vec![
    claude_init(),
    claude_message_start(10),
    claude_text("43: 四十三\n44: 四十四\n45: 四十"),
    claude_message_delta("max_tokens", 5),
    claude_message_start(20),
    claude_text("5: 四十五\n46: 四十六\n47: 四"),
    claude_message_delta("max_tokens", 6),
    claude_message_start(30),
    claude_text("47: 四十七\n"),
    claude_message_delta("end_turn", 7),
    claude_result(json!({"result":"47: 四十七\n"})),
  ];
  h.fake("claude", &format!("{CLAUDE_RECORD}\n{}", print_lines(&lines)));
  let events = h.run(h.request(Provider::ClaudeCode, "claude-sonnet-5"));
  // delta は届いたまま（重なりごと）流し、Done.text だけをつなぎ直す
  assert_eq!(deltas(&events).len(), 3);
  let done = done_of(&events);
  assert_eq!(done.text, "43: 四十三\n44: 四十四\n45: 四十五\n46: 四十六\n47: 四十七");
  assert_eq!(done.continuations, 2);
  assert_eq!(done.stop_reason, StopReason::EndTurn);
}

#[test]
fn claude_last_segment_at_max_tokens_is_max_tokens() {
  let _guard = global_lock();
  let h = Harness::new("claude-max-tokens");
  let lines = vec![
    claude_init(),
    claude_message_start(1),
    claude_text("途中まで"),
    claude_message_delta("max_tokens", 5),
    claude_result(json!({"result":"途中まで","stop_reason":"max_tokens"})),
  ];
  h.fake("claude", &format!("{CLAUDE_RECORD}\n{}", print_lines(&lines)));
  let done = done_of(&h.run(h.request(Provider::ClaudeCode, "claude-sonnet-5")));
  assert_eq!(done.stop_reason, StopReason::MaxTokens);
  assert_eq!(done.text, "途中まで");
  assert_eq!(done.continuations, 0);
}

#[test]
fn claude_slash_prompt_reaches_stdin_after_a_newline() {
  let _guard = global_lock();
  let h = Harness::new("claude-slash");
  let lines = vec![claude_init(), claude_result(json!({"result":"はい"}))];
  h.fake("claude", &format!("{CLAUDE_RECORD}\n{}", print_lines(&lines)));
  let mut req = h.request(Provider::ClaudeCode, "claude-sonnet-5");
  req.user_prompt = "/review この記事".to_string();
  let done = done_of(&h.run(req));
  assert_eq!(done.text, "はい");
  assert_eq!(h.read_out("stdin.txt"), "\n/review この記事");
}

#[test]
fn claude_thinking_display_rejection_is_retried_once_and_remembered() {
  let _guard = global_lock();
  let h = Harness::new("claude-thinking-display");
  let lines = vec![
    claude_init(),
    claude_message_start(1),
    claude_text("ok"),
    claude_result(json!({"result":"ok"})),
  ];
  h.fake(
    "claude",
    &format!(
      r#"cat > /dev/null
printf '%s\n' "$*" >> "$OUT/invocations.txt"
case " $* " in
  *" --thinking-display "*)
    echo "error: unknown option '--thinking-display'" >&2
    exit 1
    ;;
esac
{}"#,
      print_lines(&lines)
    ),
  );
  // 1 回目: フラグ付きで拒否 → 同じ依頼をフラグ無しでやり直して完了する（利用者には失敗を見せない）
  let events = h.run(h.request(Provider::ClaudeCode, "claude-sonnet-5"));
  assert_eq!(done_of(&events).text, "ok");
  assert!(!events.iter().any(|event| matches!(event, TurnEvent::Error { .. })));
  let invocations = h.read_out("invocations.txt");
  let lines: Vec<&str> = invocations.lines().collect();
  assert_eq!(lines.len(), 2, "rejected once, then relaunched once");
  assert!(lines[0].contains("--thinking-display summarized"));
  assert!(!lines[1].contains("--thinking-display"));
  assert!(h
    .logs()
    .iter()
    .any(|line| line.starts_with("thinking_display_unsupported")));

  // 覚えているので、次の実行は最初からフラグ無しで 1 回だけ起動する
  let events = h.run(h.request(Provider::ClaudeCode, "claude-sonnet-5"));
  assert_eq!(done_of(&events).text, "ok");
  let invocations = h.read_out("invocations.txt");
  let lines: Vec<&str> = invocations.lines().collect();
  assert_eq!(lines.len(), 3);
  assert!(!lines[2].contains("--thinking-display"));
}

#[test]
fn claude_not_logged_in_is_login_required() {
  let _guard = global_lock();
  let h = Harness::new("claude-login");
  let lines = vec![
    claude_init(),
    r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Not logged in · Please run /login"}]},"error":"authentication_failed"}"#.to_string(),
    r#"{"type":"result","subtype":"success","is_error":true,"api_error_status":null,"result":"Not logged in · Please run /login","stop_reason":"stop_sequence"}"#.to_string(),
  ];
  h.fake("claude", &format!("cat > /dev/null\n{}\nexit 1", print_lines(&lines)));
  let events = h.run(h.request(Provider::ClaudeCode, "claude-sonnet-5"));
  assert_eq!(
    error_of(&events),
    (
      ReasonCode::CliLoginRequired,
      "このMacの Claude Code にログインしてください。".to_string()
    )
  );
  assert!(h
    .logs()
    .iter()
    .any(|line| line.starts_with("turn_failed") && line.contains("RUNTIME_CLI_LOGIN_REQUIRED")));
}

#[test]
fn claude_missing_conversation_is_session_not_found() {
  let _guard = global_lock();
  let h = Harness::new("claude-session");
  let message = format!("No conversation found with session ID: {SESSION}");
  let lines =
    vec![json!({"type":"result","subtype":"error_during_execution","is_error":true,"errors":[message]}).to_string()];
  h.fake(
    "claude",
    &format!(
      "cat > /dev/null\n{}\necho {} >&2\nexit 1",
      print_lines(&lines),
      sh_quote(&message)
    ),
  );
  let mut req = h.request(Provider::ClaudeCode, "claude-sonnet-5");
  req.resume_session = Some(SESSION.to_string());
  let events = h.run(req);
  assert_eq!(
    error_of(&events),
    (
      ReasonCode::SessionNotFound,
      "このMacに会話の続きが見つかりませんでした。".to_string()
    )
  );
  assert!(h.scratch_is_empty());
}

#[test]
fn claude_wrong_model_is_model_not_found() {
  let _guard = global_lock();
  let h = Harness::new("claude-model");
  let text = "There's an issue with the selected model (x). It may not exist or you may not have access to it.";
  let lines = vec![
    claude_init(),
    json!({"type":"assistant","message":{"content":[{"type":"text","text":text}]},"error":"model_not_found"})
      .to_string(),
    json!({"type":"result","subtype":"success","is_error":true,"api_error_status":404,"result":text}).to_string(),
  ];
  h.fake("claude", &format!("cat > /dev/null\n{}\nexit 1", print_lines(&lines)));
  let events = h.run(h.request(Provider::ClaudeCode, "x"));
  assert_eq!(
    error_of(&events),
    (
      ReasonCode::ModelNotFound,
      "Claude Code でこのモデルを使えません。設定のモデルを確かめてください。".to_string()
    )
  );
}

#[test]
fn claude_usage_limit_notice_only_is_usage_limit_reached() {
  let _guard = global_lock();
  let h = Harness::new("claude-limit");
  let notice = "You've hit your weekly limit · resets Sep 18 at 10pm (Asia/Tokyo)";
  let lines = vec![
    claude_init(),
    claude_message_start(1),
    claude_text(notice),
    claude_result(json!({"result":notice})),
  ];
  h.fake("claude", &format!("cat > /dev/null\n{}", print_lines(&lines)));
  let events = h.run(h.request(Provider::ClaudeCode, "claude-sonnet-5"));
  assert_eq!(error_of(&events).0, ReasonCode::UsageLimitReached);
}

#[test]
fn claude_thinking_only_max_tokens_twice_stops_early_with_a_reason() {
  // 思考だけで出力の上限に 2 回続けて達したら、時間切れまで待たずに止めて理由を返す（#18382 の実機では 45 分待った）
  let _guard = global_lock();
  let h = Harness::new("claude-thinking-only");
  let lines = vec![
    claude_init(),
    claude_message_start(10),
    claude_thinking("修正版を思考の中で下書きする"),
    claude_message_delta("max_tokens", 32000),
    claude_message_start(20),
    claude_thinking("また最初から下書きする"),
    claude_message_delta("max_tokens", 32000),
  ];
  h.fake("claude", &format!("cat > /dev/null\n{}\nsleep 30", print_lines(&lines)));
  let started = Instant::now();
  let events = h.run(h.request(Provider::ClaudeCode, "claude-sonnet-4-6"));
  assert!(
    started.elapsed() < Duration::from_secs(10),
    "stops without waiting for the CLI"
  );
  let (code, message) = error_of(&events);
  assert_eq!(code, ReasonCode::TransientFailure);
  assert!(message.contains("考えるだけで出力の上限に 2 回続けて達し"), "{message}");
  assert!(message.contains("軽量"), "{message}");
}

#[test]
fn claude_init_with_tools_is_stopped() {
  let _guard = global_lock();
  let h = Harness::new("claude-init-tools");
  let lines = vec![
    json!({"type":"system","subtype":"init","tools":["Bash","Read"],"mcp_servers":[]}).to_string(),
    claude_message_start(1),
    claude_text("ツール付きで動いた分"),
  ];
  h.fake("claude", &format!("cat > /dev/null\n{}\nsleep 30", print_lines(&lines)));
  let started = Instant::now();
  let events = h.run(h.request(Provider::ClaudeCode, "claude-sonnet-5"));
  assert!(
    started.elapsed() < Duration::from_secs(10),
    "the breach stops the process group"
  );
  assert_eq!(
    events.len(),
    1,
    "nothing from the tool-enabled run is relayed: {events:?}"
  );
  let (code, message) = error_of(&events);
  assert_eq!(code, ReasonCode::NotConfigured);
  assert!(message.contains("ツールを持ったまま"));
  assert!(h
    .logs()
    .iter()
    .any(|line| line.starts_with("tool_breach") && line.contains("\"init\"")));
  assert!(h.scratch_is_empty());
}

#[test]
fn claude_exit_before_start_is_a_transient_failure_with_a_masked_log() {
  let _guard = global_lock();
  let h = Harness::new("claude-early-exit");
  h.fake(
    "claude",
    "cat > /dev/null\necho 'boom sk-ant-api03-SECRETSECRETSECRET' >&2\nexit 1",
  );
  let events = h.run(h.request(Provider::ClaudeCode, "claude-sonnet-5"));
  assert_eq!(events.len(), 1);
  assert_eq!(
    error_of(&events),
    (
      ReasonCode::TransientFailure,
      "Claude Code の実行に失敗しました。".to_string()
    )
  );
  let logs = h.logs();
  assert!(
    logs
      .iter()
      .any(|line| line.starts_with("turn_failed") && line.contains("boom sk-***")),
    "{logs:?}"
  );
  assert!(logs.iter().all(|line| !line.contains("SECRETSECRET")));
  assert!(h.scratch_is_empty());
}

#[test]
fn claude_missing_cli_is_not_configured() {
  let _guard = global_lock();
  let h = Harness::new("claude-missing");
  let events = h.run(h.request(Provider::ClaudeCode, "claude-sonnet-5"));
  assert_eq!(
    error_of(&events),
    (
      ReasonCode::NotConfigured,
      "このMacに Claude Code が見つかりません。".to_string()
    )
  );
  assert!(h.scratch_is_empty());
}

#[test]
fn invalid_requests_fail_inside_the_thread_once() {
  let _guard = global_lock();
  let h = Harness::new("invalid");
  h.fake("claude", "echo x > \"$OUT/ran\"");
  let mut req = h.request(Provider::ClaudeCode, "--model");
  req.resume_session = Some("not-a-uuid".to_string());
  let events = h.run(req);
  assert_eq!(
    error_of(&events),
    (ReasonCode::ModelNotFound, "モデル名が正しくありません。".to_string())
  );
  let mut req = h.request(Provider::GeminiCli, "gemini-3.8-flash");
  req.resume_session = Some("not-a-uuid".to_string());
  assert_eq!(error_of(&h.run(req)).0, ReasonCode::SessionNotFound);
  let mut req = h.request(Provider::CodexCli, "gpt-5.5");
  req.user_prompt = "   ".to_string();
  assert_eq!(
    error_of(&h.run(req)),
    (ReasonCode::TransientFailure, "指示が空です。".to_string())
  );
  assert!(!h.out("ran").exists(), "the CLI must not be started");
  assert!(h.logs().iter().any(|line| line.starts_with("invalid_request")));
}

// ---------------------------------------------------------------------------
// 停止・時間切れ・同時実行

#[test]
fn stop_ends_with_done_stopped_and_the_text_so_far() {
  let _guard = global_lock();
  let h = Harness::new("stop");
  let lines = vec![claude_init(), claude_message_start(10), claude_text("hello")];
  h.fake(
    "claude",
    &format!(
      "cat > /dev/null\n{}\nsleep 30\n{}",
      print_lines(&lines),
      print_lines(&[claude_result(json!({}))])
    ),
  );
  let started = Instant::now();
  let (handle, events) = h.start(h.request(Provider::ClaudeCode, "claude-sonnet-5"));
  wait_until(Duration::from_secs(10), "a delta from the fake claude", || {
    !events.lock().unwrap().is_empty()
  });
  assert!(handle.stop());
  wait_until(Duration::from_secs(10), "the stopped turn", || handle.is_finished());
  assert!(!handle.stop(), "a finished turn cannot be stopped again");
  handle.wait();
  assert!(started.elapsed() < Duration::from_secs(10));
  let events = events.lock().unwrap().clone();
  assert_one_terminal_last(&events);
  assert_eq!(deltas(&events), vec![TurnEvent::TextDelta("hello".into())]);
  let done = done_of(&events);
  assert_eq!(done.stop_reason, StopReason::Stopped);
  assert_eq!(done.text, "hello");
  assert!(done.session_id.is_some());
  assert_eq!(
    done.usage,
    Usage {
      input_tokens: 1110,
      output_tokens: 0,
      cost_usd: None,
      model_used: Some("claude-sonnet-5".into()),
    }
  );
  assert!(h.scratch_is_empty());
  assert!(!niho_local_ai::has_running_turns());
}

#[test]
fn turn_returns_when_an_escaped_grandchild_keeps_stdout_open() {
  let _guard = global_lock();
  let h = Harness::new("escaped-stdout");
  let pid_file = h.out("detached.pid");
  let _cleanup = DetachedPidCleanup(pid_file.clone());
  let python = format!(
    "import os,time\npid=os.fork()\nif pid:\n open({:?}, 'w').write(str(pid))\n time.sleep(0.2)\n os._exit(0)\nos.setsid()\ntime.sleep(10)\n",
    pid_file.to_string_lossy().as_ref()
  );
  h.fake("claude", &format!("python3 -c {}", sh_quote(&python)));

  let started = Instant::now();
  let (handle, events) = h.start(h.request(Provider::ClaudeCode, "claude-sonnet-5"));
  wait_until(Duration::from_secs(5), "the turn with an escaped stdout holder", || {
    handle.is_finished()
  });
  handle.wait();
  // The detached grandchild holds stdout for 10 seconds; allow CI scheduling jitter
  // while still verifying that the turn completes before that holder exits.
  assert!(
    started.elapsed() < Duration::from_secs(8),
    "turn took {:?}",
    started.elapsed()
  );
  assert_one_terminal_last(&events.lock().unwrap());
}

#[test]
fn time_limit_kills_the_group_even_when_sigterm_is_ignored() {
  let _guard = global_lock();
  let h = Harness::new("timeout");
  let lines = vec![claude_init(), claude_message_start(1), claude_text("hello")];
  h.fake(
    "claude",
    &format!(
      // 孫の sleep の pid を最初に書く（Mac が忙しくても、時間切れの前に必ず書けるように）
      "trap '' TERM\nsleep 30 &\necho $! > \"$OUT/sleep.pid\"\ncat > /dev/null\n{}\nwait",
      print_lines(&lines)
    ),
  );
  let mut req = h.request(Provider::ClaudeCode, "claude-sonnet-5");
  req.timeout = Duration::from_millis(2000);
  let started = Instant::now();
  let events = h.run(req);
  assert!(
    started.elapsed() < Duration::from_secs(10),
    "SIGKILL escalation must end the turn"
  );
  assert_eq!(
    error_of(&events),
    (
      ReasonCode::TimedOut,
      "2秒以内に終わらなかったため止めました。".to_string()
    )
  );
  assert!(deltas(&events)
    .iter()
    .all(|event| matches!(event, TurnEvent::TextDelta(_))));
  let pid = h.read_out("sleep.pid").trim().to_string();
  let alive = || {
    Command::new("/bin/kill")
      .args(["-0", pid.as_str()])
      .status()
      .map(|status| status.success())
      .unwrap_or(false)
  };
  wait_until(Duration::from_secs(5), "the child sleep to be killed", || !alive());
  assert!(h.logs().iter().any(|line| line.starts_with("timed_out")));
  assert!(h.scratch_is_empty());
}

#[test]
fn only_two_turns_run_at_once() {
  let _guard = global_lock();
  let h = Harness::new("concurrency");
  let lines = vec![claude_init(), claude_message_start(1), claude_text("running")];
  h.fake(
    "claude",
    &format!(
      "cat > /dev/null\necho x >> \"$OUT/runs\"\n{}\nsleep 30",
      print_lines(&lines)
    ),
  );
  let codex_lines = vec![
    json!({"type":"thread.started","thread_id":THREAD}).to_string(),
    json!({"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"空きました"}}).to_string(),
    json!({"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}).to_string(),
  ];
  h.fake("codex", &format!("cat > /dev/null\n{}", print_lines(&codex_lines)));

  let (first, first_events) = h.start(h.request(Provider::ClaudeCode, "claude-sonnet-5"));
  let (second, second_events) = h.start(h.request(Provider::ClaudeCode, "claude-sonnet-5"));
  wait_until(Duration::from_secs(10), "two running turns", || {
    !first_events.lock().unwrap().is_empty() && !second_events.lock().unwrap().is_empty()
  });
  assert!(niho_local_ai::has_running_turns());

  let started = Instant::now();
  let third = h.run(h.request(Provider::ClaudeCode, "claude-sonnet-5"));
  assert!(
    started.elapsed() < Duration::from_secs(5),
    "the third turn is refused right away"
  );
  assert_eq!(error_of(&third), (ReasonCode::TransientFailure, TOO_MANY.to_string()));
  assert_eq!(
    h.read_out("runs").lines().count(),
    2,
    "the third turn never starts the CLI"
  );

  assert!(first.stop());
  first.wait();
  assert_eq!(done_of(&first_events.lock().unwrap()).stop_reason, StopReason::Stopped);
  let fourth = h.run(h.request(Provider::CodexCli, "gpt-5.5"));
  assert_eq!(done_of(&fourth).text, "空きました");

  assert!(second.stop());
  second.wait();
  assert_one_terminal_last(&second_events.lock().unwrap());
  assert!(!niho_local_ai::has_running_turns());
}

#[test]
fn shutdown_stops_running_turns() {
  let _guard = global_lock();
  let h = Harness::new("shutdown");
  let lines = vec![claude_init(), claude_message_start(1), claude_text("running")];
  h.fake(
    "claude",
    &format!("trap '' TERM\ncat > /dev/null\n{}\nsleep 30", print_lines(&lines)),
  );
  let (handle, events) = h.start(h.request(Provider::ClaudeCode, "claude-sonnet-5"));
  wait_until(Duration::from_secs(10), "a running turn", || {
    !events.lock().unwrap().is_empty()
  });
  let started = Instant::now();
  niho_local_ai::shutdown();
  assert!(started.elapsed() < Duration::from_secs(3), "SIGTERM → 800ms → SIGKILL");
  handle.wait();
  let events = events.lock().unwrap().clone();
  assert_one_terminal_last(&events);
  assert_eq!(done_of(&events).stop_reason, StopReason::Stopped);
  assert!(h.scratch_is_empty());
}

// ---------------------------------------------------------------------------
// codex

/// `codex features list` の偽物（0.163.0 の形。段階は 2 語のこともある）。`$OUT/codex-features-broken` があれば読めない一覧
/// （別の出力と exit 2）を返す。どの `CODEX_HOME` で読んだかを写す。
const CODEX_FEATURES: &str = r#"if [ "$1" = features ] && [ "$2" = list ]; then
  printf '%s' "${CODEX_HOME:-}" > "$OUT/codex-features-home.txt"
  if [ -f "$OUT/codex-features-broken" ]; then echo "error: unrecognized subcommand 'features'" >&2; exit 2; fi
  cat <<'FEATURES'
agent_message_board                      under development  false
apps                                     stable             true
code_mode_host                           stable             true
realtime_conversation                    stable             true
remote_plugin                            stable             true
shell_tool                               stable             true
FEATURES
  exit 0
fi"#;

/// 今の版で有効な機能（偽物の一覧の true）と crate の一覧を合わせ、名前の順に `-c features.<名前>=false` にしたもの。
fn features_off_args(keep: &[&str]) -> Vec<String> {
  let mut off: std::collections::BTreeSet<&str> = [
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
  ]
  .into_iter()
  .collect();
  off.extend(["realtime_conversation", "remote_plugin"]);
  off
    .into_iter()
    .filter(|feature| !keep.contains(feature))
    .flat_map(|feature| ["-c".to_string(), format!("features.{feature}=false")])
    .collect()
}

/// 標準入力・引数・cwd・`CODEX_HOME` と、`model_instructions_file` に渡されたファイル（中身・権限・パス）を写す codex の偽物の頭。
const CODEX_RECORD: &str = r#"cat > "$OUT/stdin.txt"
printf '%s\n' "$@" > "$OUT/args.txt"
pwd > "$OUT/pwd.txt"
printf '%s' "${CODEX_HOME:-}" > "$OUT/codex-home.txt"
for arg in "$@"; do
  case "$arg" in
    model_instructions_file=*)
      f=${arg#model_instructions_file=}
      f=${f#\"}
      f=${f%\"}
      printf '%s' "$f" > "$OUT/instructions-path.txt"
      cp "$f" "$OUT/instructions-copy.md"
      ls -l "$f" | cut -c1-10 > "$OUT/instructions-mode.txt"
      ;;
  esac
done"#;

#[test]
fn codex_success_passes_args_and_stdin() {
  let _guard = global_lock();
  let h = Harness::new("codex-success");
  let lines = vec![
    json!({"type":"thread.started","thread_id":THREAD}).to_string(),
    json!({"type":"turn.started"}).to_string(),
    json!({"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `gpt-5.5` not found."}}).to_string(),
    json!({"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"**考え中**"}}).to_string(),
    json!({"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"下書きです。"}}).to_string(),
    json!({"type":"error","message":"Reconnecting... 2/5 (stream disconnected before completion)"}).to_string(),
    json!({"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"完成です。"}}).to_string(),
    json!({"type":"turn.completed","usage":{"input_tokens":15779,"cached_input_tokens":0,"output_tokens":202,"reasoning_output_tokens":18}}).to_string(),
  ];
  h.fake("codex", &format!("{CODEX_RECORD}\n{}", print_lines(&lines)));
  let events = h.run(h.request(Provider::CodexCli, "gpt-5.5"));
  assert_eq!(
    deltas(&events),
    vec![
      TurnEvent::ThinkingDelta("**考え中**".into()),
      TurnEvent::TextDelta("下書きです。".into()),
      TurnEvent::TextDelta("完成です。".into()),
    ]
  );
  let done = done_of(&events);
  assert_eq!(done.text, "完成です。");
  assert_eq!(done.stop_reason, StopReason::EndTurn);
  assert_eq!(done.session_id.as_deref(), Some(THREAD));
  assert_eq!(
    done.usage,
    Usage {
      input_tokens: 15779,
      output_tokens: 202,
      cost_usd: None,
      model_used: None,
    }
  );
  assert_eq!(done.continuations, 0);

  let args = args_of(&h.read_out("args.txt"));
  let mut expected: Vec<String> = [
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
  ]
  .iter()
  .map(|value| value.to_string())
  .collect();
  // 機能は、今の版で有効な機能（偽物の一覧の remote_plugin・realtime_conversation など）も合わせて -c で切る
  expected.extend(features_off_args(&[]));
  // システムプロンプトは 0600 のファイルで渡す（-c base_instructions は codex 0.154.0 が無視する）
  let instructions = h.read_out("instructions-path.txt");
  expected.extend(
    [
      "-c",
      "web_search=\"disabled\"",
      "-c",
      "project_doc_max_bytes=0",
      "-c",
      "skills.include_instructions=false",
      "-c",
      "include_permissions_instructions=false",
      "-c",
      "include_environment_context=false",
      "-c",
      "include_collaboration_mode_instructions=false",
      "-c",
      "include_apps_instructions=false",
      "-c",
      &format!("model_instructions_file=\"{instructions}\""),
      "-m",
      "gpt-5.5",
    ]
    .iter()
    .map(|value| value.to_string()),
  );
  assert_eq!(args, expected);
  assert!(!args.iter().any(|arg| arg.contains("NIHO_SYSTEM_PROMPT_MARKER")));
  assert_eq!(h.read_out("instructions-copy.md"), SYSTEM_PROMPT);
  assert_eq!(h.read_out("instructions-mode.txt").trim(), "-rw-------");
  assert!(Path::new(&instructions).starts_with(h.scratch()));
  assert!(
    !Path::new(&instructions).exists(),
    "the instructions file is removed after the turn"
  );
  assert!(h.scratch_is_empty());
  // 利用者の ~/.codex ではなく、アプリの置き場で動く（~/.codex/AGENTS.md を混ぜない・ログインもこのアプリ用）
  assert_eq!(h.read_out("codex-home.txt"), h.codex_home().to_string_lossy());
  assert!(h.codex_home().is_dir());
  assert_eq!(h.read_out("stdin.txt"), USER_PROMPT);
  assert!(same_dir(Path::new(h.read_out("pwd.txt").trim()), &h.dir.join("work")));
  // error の item は警告としてログにだけ残る
  assert!(h
    .logs()
    .iter()
    .any(|line| line.starts_with("cli_warning") && line.contains("Model metadata")));
  for line in h.logs() {
    assert!(
      !line.contains("NIHO_SYSTEM_PROMPT_MARKER") && !line.contains("NIHO_USER_PROMPT_MARKER"),
      "{line}"
    );
  }
}

#[test]
fn codex_resume_puts_exec_resume_first_without_sandbox_flag() {
  let _guard = global_lock();
  let h = Harness::new("codex-resume");
  let lines = vec![
    json!({"type":"thread.started","thread_id":THREAD}).to_string(),
    json!({"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"続きです"}}).to_string(),
    json!({"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}).to_string(),
  ];
  h.fake("codex", &format!("{CODEX_RECORD}\n{}", print_lines(&lines)));
  let mut req = h.request(Provider::CodexCli, "gpt-5.5");
  req.resume_session = Some(THREAD.to_string());
  req.effort = Some(niho_local_ai::Effort::Low);
  let events = h.run(req);
  let args = args_of(&h.read_out("args.txt"));
  assert_eq!(&args[..3], ["exec", "resume", THREAD].map(String::from));
  assert!(args
    .windows(2)
    .any(|pair| pair[0] == "-c" && pair[1] == "sandbox_mode=\"read-only\""));
  assert!(args
    .windows(2)
    .any(|pair| pair[0] == "-c" && pair[1] == "model_reasoning_effort=\"low\""));
  assert!(!args.iter().any(|arg| arg == "--sandbox"));
  assert_eq!(done_of(&events).session_id.as_deref(), Some(THREAD));
}

#[test]
fn codex_command_execution_is_stopped() {
  let _guard = global_lock();
  let h = Harness::new("codex-tool");
  let lines = vec![
    json!({"type":"thread.started","thread_id":THREAD}).to_string(),
    json!({"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"ls","status":"in_progress"}})
      .to_string(),
  ];
  h.fake("codex", &format!("cat > /dev/null\n{}\nsleep 30", print_lines(&lines)));
  let started = Instant::now();
  let events = h.run(h.request(Provider::CodexCli, "gpt-5.5"));
  assert!(started.elapsed() < Duration::from_secs(10));
  let (code, message) = error_of(&events);
  assert_eq!(code, ReasonCode::NotConfigured);
  assert!(message.contains("Codex CLI がツールを使おうとした"));
  assert!(h
    .logs()
    .iter()
    .any(|line| line.starts_with("tool_breach") && line.contains("command_execution")));
}

#[test]
fn codex_does_not_start_when_the_features_list_cannot_be_read() {
  // 切る機能を決められないときは起動しない（fail closed）。exec は 1 回も動かない
  let _guard = global_lock();
  let h = Harness::new("codex-features-broken");
  fs::write(h.dir.join("out").join("codex-features-broken"), "").unwrap();
  h.fake("codex", "touch \"$OUT/codex-exec-ran\"\nexit 0");
  let events = h.run(h.request(Provider::CodexCli, "gpt-5.5"));
  let (code, message) = error_of(&events);
  assert_eq!(code, ReasonCode::NotConfigured);
  assert!(message.contains("Codex CLI の機能の一覧を読めなかった"), "{message}");
  assert!(!h.dir.join("out").join("codex-exec-ran").exists());
  assert!(h.logs().iter().any(|line| line.starts_with("features_unreadable")));
  // 一覧はアプリの置き場（CODEX_HOME）で読む
  assert_eq!(h.read_out("codex-features-home.txt"), h.codex_home().to_string_lossy());
}

#[test]
fn codex_unauthorized_is_login_required() {
  let _guard = global_lock();
  let h = Harness::new("codex-401");
  let lines = vec![
    json!({"type":"thread.started","thread_id":THREAD}).to_string(),
    json!({"type":"turn.started"}).to_string(),
    json!({"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"}}).to_string(),
  ];
  h.fake("codex", &format!("cat > /dev/null\n{}\nexit 1", print_lines(&lines)));
  let events = h.run(h.request(Provider::CodexCli, "gpt-5.5"));
  assert_eq!(
    error_of(&events),
    (
      ReasonCode::CliLoginRequired,
      "このMacの Codex CLI にログインしてください。".to_string()
    )
  );
}

#[test]
fn codex_missing_rollout_is_session_not_found() {
  let _guard = global_lock();
  let h = Harness::new("codex-rollout");
  h.fake(
    "codex",
    &format!(
      "cat > /dev/null\necho 'Error: thread/resume: thread/resume failed: no rollout found for thread id {THREAD}' >&2\nexit 1"
    ),
  );
  let mut req = h.request(Provider::CodexCli, "gpt-5.5");
  req.resume_session = Some(THREAD.to_string());
  assert_eq!(error_of(&h.run(req)).0, ReasonCode::SessionNotFound);
}

#[test]
fn codex_unsupported_model_is_model_not_found() {
  let _guard = global_lock();
  let h = Harness::new("codex-model");
  let lines = vec![json!({"type":"turn.failed","error":{"message":"{\"detail\":\"The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.\"}"}}).to_string()];
  h.fake("codex", &format!("cat > /dev/null\n{}\nexit 1", print_lines(&lines)));
  let events = h.run(h.request(Provider::CodexCli, "gpt-6-luna"));
  assert_eq!(error_of(&events).0, ReasonCode::ModelNotFound);
}

// ---------------------------------------------------------------------------
// agy（Provider::GeminiCli）

#[test]
fn agy_success_runs_in_an_empty_workspace_with_the_agent_and_stdin_json() {
  let _guard = global_lock();
  let h = Harness::new("agy-success");
  let lines = vec![
    "Starting Antigravity CLI...".to_string(),
    agy_init("niho-docs-writer"),
    agy_user_input(CONVERSATION),
    agy_step(
      CONVERSATION,
      1,
      "ACTIVE",
      "agent_response",
      json!({"text_delta":"こんに"}),
    ),
    agy_step(
      CONVERSATION,
      1,
      "DONE",
      "agent_response",
      json!({"text_delta":"ちは","usage":{"input_tokens":2149,"output_tokens":15,"thinking_tokens":0,"cache_read_tokens":100,"total_tokens":2264},"duration_seconds":1.71}),
    ),
    agy_result(CONVERSATION, json!({"response":"こんにちは\n"})),
  ];
  h.fake("agy", &format!("{AGY_RECORD}\n{}", print_lines(&lines)));
  let mut req = h.request(Provider::GeminiCli, "gemini-3.8-flash");
  req.effort = Some(niho_local_ai::Effort::High);
  let events = h.run(req);

  assert_eq!(
    deltas(&events),
    vec![
      TurnEvent::TextDelta("こんに".into()),
      TurnEvent::TextDelta("ちは".into())
    ]
  );
  let args = args_of(&h.read_out("args.txt"));
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
    "high",
    "--disable-slash-commands",
    "--print-timeout",
    "0",
  ]
  .iter()
  .map(|value| value.to_string())
  .collect();
  assert_eq!(args, expected);
  assert!(!args.iter().any(|arg| arg == "--dangerously-skip-permissions"));

  // 指示は標準入力に 1 行の JSON（引数には載せない）
  let stdin = h.read_out("stdin.txt");
  assert!(stdin.ends_with('\n') && stdin.matches('\n').count() == 1, "{stdin:?}");
  assert_eq!(
    serde_json::from_str::<Value>(stdin.trim_end()).unwrap(),
    json!({"event":"user","message":{"content":USER_PROMPT}})
  );
  assert!(!args.iter().any(|arg| arg.contains("NIHO_USER_PROMPT_MARKER")));

  // cwd は利用者の workdir ではなく、scratch の下のその回だけの作業フォルダ（0700）。中は agent.md（0600）だけ
  let pwd = PathBuf::from(h.read_out("pwd.txt").trim());
  assert_eq!(pwd.file_name().and_then(|name| name.to_str()), Some("ws"));
  let turn_dir = pwd.parent().unwrap();
  assert!(turn_dir
    .file_name()
    .and_then(|name| name.to_str())
    .is_some_and(|name| name.starts_with("turn-")));
  assert!(is_under(&pwd, &h.scratch()), "{pwd:?}");
  assert!(!is_under(&pwd, &h.dir.join("work")), "{pwd:?}");
  assert_eq!(h.read_out("ws-mode.txt").trim(), "drwx------");
  assert_eq!(h.read_out("agent-mode.txt").trim(), "-rw-------");
  assert_eq!(h.read_out("ws-entries.txt").trim(), ".agents");
  assert_eq!(
    h.read_out("agent-copy.md"),
    format!(
      "---\nname: niho-docs-writer\ndescription: NIHO docs の工程を実行し、Markdown の本文だけを書く。\ntools: []\nmainAgent: true\nsubagent: false\ncommandExecutionPolicy: off\n---\n{SYSTEM_PROMPT}"
    )
  );
  // 終わったら作業フォルダごと消え、利用者の workdir には何も置かない
  assert!(!pwd.exists(), "{pwd:?} is removed after the turn");
  assert!(h.scratch_is_empty());
  assert!(fs::read_dir(h.dir.join("work")).unwrap().next().is_none());

  // usage はこの回の step の和（result の累計は使わない）、時間は実測
  let done = done_of(&events);
  assert_eq!(done.text, "こんにちは");
  assert_eq!(done.stop_reason, StopReason::EndTurn);
  assert_eq!(done.session_id.as_deref(), Some(CONVERSATION));
  assert_eq!(
    done.usage,
    Usage {
      input_tokens: 2249,
      output_tokens: 15,
      cost_usd: None,
      model_used: Some("gemini-3.8-flash-low".into()),
    }
  );
  assert!(done.duration_ms < 20_000, "{}", done.duration_ms);
  assert_eq!(done.continuations, 0);
  for line in h.logs() {
    assert!(
      !line.contains("NIHO_SYSTEM_PROMPT_MARKER") && !line.contains("NIHO_USER_PROMPT_MARKER"),
      "{line}"
    );
  }
}

#[test]
fn agy_resume_passes_the_conversation_and_continues_it() {
  let _guard = global_lock();
  let h = Harness::new("agy-resume");
  let lines = vec![
    agy_init("niho-docs-writer"),
    agy_step(CONVERSATION, 2, "DONE", "system_message", json!({})),
    agy_user_input(CONVERSATION),
    agy_step(
      CONVERSATION,
      4,
      "DONE",
      "agent_response",
      json!({"text_delta":"続きです","usage":{"input_tokens":2375,"output_tokens":25,"cache_read_tokens":0}}),
    ),
    agy_result(CONVERSATION, json!({"response":"続きです"})),
  ];
  h.fake("agy", &format!("{AGY_RECORD}\n{}", print_lines(&lines)));
  let mut req = h.request(Provider::GeminiCli, "gemini-3.8-flash-low");
  req.resume_session = Some(CONVERSATION.to_string());
  let events = h.run(req);
  let args = args_of(&h.read_out("args.txt"));
  assert_eq!(
    &args[args.len() - 2..],
    ["--conversation".to_string(), CONVERSATION.to_string()]
  );
  assert!(!args.iter().any(|arg| arg == "--effort"));
  let done = done_of(&events);
  assert_eq!(done.text, "続きです");
  assert_eq!(done.session_id.as_deref(), Some(CONVERSATION));
  assert_eq!(
    done.usage,
    Usage {
      input_tokens: 2375,
      output_tokens: 25,
      cost_usd: None,
      model_used: Some("gemini-3.8-flash-low".into()),
    }
  );
  assert!(h.scratch_is_empty());
}

#[test]
fn agy_resume_that_starts_another_conversation_is_session_not_found() {
  let _guard = global_lock();
  let h = Harness::new("agy-other-conversation");
  // 見つからない会話は警告だけで、新しい会話（違う ID）で答えてしまう
  let lines = vec![
    agy_init("niho-docs-writer"),
    agy_user_input(OTHER_CONVERSATION),
    agy_step(
      OTHER_CONVERSATION,
      1,
      "DONE",
      "agent_response",
      json!({"text_delta":"新しい会話の文"}),
    ),
    agy_result(OTHER_CONVERSATION, json!({"response":"新しい会話の文"})),
  ];
  h.fake(
    "agy",
    &format!(
      "cat > /dev/null\necho 'warning: conversation \"{CONVERSATION}\" not found' >&2\n{}\nsleep 30",
      print_lines(&lines)
    ),
  );
  let mut req = h.request(Provider::GeminiCli, "gemini-3.8-flash");
  req.resume_session = Some(CONVERSATION.to_string());
  let started = Instant::now();
  let events = h.run(req);
  assert!(started.elapsed() < Duration::from_secs(10));
  assert_eq!(
    error_of(&events),
    (
      ReasonCode::SessionNotFound,
      "このMacに会話の続きが見つかりませんでした。".to_string()
    )
  );
  assert!(
    deltas(&events).is_empty(),
    "no text of the new conversation: {events:?}"
  );
  assert!(h.logs().iter().any(|line| line.starts_with("tool_breach")
    && line.contains("conversation_mismatch")
    && line.contains("RUNTIME_SESSION_NOT_FOUND")));
  assert!(h.scratch_is_empty());
}

#[test]
fn agy_tool_step_stops_the_cli_but_manage_task_is_allowed() {
  let _guard = global_lock();
  let h = Harness::new("agy-tool");
  let lines = vec![
    agy_init("niho-docs-writer"),
    agy_user_input(CONVERSATION),
    agy_step(
      CONVERSATION,
      1,
      "DONE",
      "tool",
      json!({"tool_name":"manage_task","tool_info":{"name":"manage_task","parameters":{},"output":"ok"}}),
    ),
    agy_step(
      CONVERSATION,
      2,
      "ACTIVE",
      "agent_response",
      json!({"text_delta":"読みます"}),
    ),
    agy_step(
      CONVERSATION,
      3,
      "ACTIVE",
      "tool",
      json!({"tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/etc/hosts"}}}),
    ),
  ];
  h.fake("agy", &format!("cat > /dev/null\n{}\nsleep 30", print_lines(&lines)));
  let started = Instant::now();
  let events = h.run(h.request(Provider::GeminiCli, "gemini-3.8-flash"));
  assert!(started.elapsed() < Duration::from_secs(10), "the CLI is stopped");
  assert_eq!(deltas(&events), vec![TurnEvent::TextDelta("読みます".into())]);
  let (code, message) = error_of(&events);
  assert_eq!(code, ReasonCode::NotConfigured);
  assert!(message.contains("Antigravity CLI がツールを使おうとした"), "{message}");
  assert!(h
    .logs()
    .iter()
    .any(|line| line.starts_with("tool_breach") && line.contains("tool:view_file")));
  assert!(h.scratch_is_empty());

  // manage_task（内部の作業管理）だけなら最後まで通る
  let h = Harness::new("agy-manage-task");
  let lines = vec![
    agy_init("niho-docs-writer"),
    agy_user_input(CONVERSATION),
    agy_step(
      CONVERSATION,
      1,
      "DONE",
      "tool",
      json!({"tool_name":"manage_task","tool_info":{"name":"manage_task","parameters":{},"output":"ok"}}),
    ),
    agy_step(
      CONVERSATION,
      2,
      "DONE",
      "agent_response",
      json!({"text_delta":"本文です","usage":{"input_tokens":5,"output_tokens":6}}),
    ),
    agy_result(CONVERSATION, json!({"response":"本文です"})),
  ];
  h.fake("agy", &format!("cat > /dev/null\n{}", print_lines(&lines)));
  let events = h.run(h.request(Provider::GeminiCli, "gemini-3.8-flash"));
  let done = done_of(&events);
  assert_eq!(done.text, "本文です");
  assert_eq!(done.stop_reason, StopReason::EndTurn);
}

#[test]
fn agy_started_with_another_agent_is_not_configured() {
  let _guard = global_lock();
  let h = Harness::new("agy-init");
  let lines = vec![
    agy_init("default"),
    agy_user_input(CONVERSATION),
    agy_step(
      CONVERSATION,
      1,
      "ACTIVE",
      "agent_response",
      json!({"text_delta":"後の文"}),
    ),
  ];
  h.fake("agy", &format!("cat > /dev/null\n{}\nsleep 30", print_lines(&lines)));
  let started = Instant::now();
  let events = h.run(h.request(Provider::GeminiCli, "gemini-3.8-flash"));
  assert!(started.elapsed() < Duration::from_secs(10));
  assert!(deltas(&events).is_empty());
  assert_eq!(
    error_of(&events),
    (
      ReasonCode::NotConfigured,
      "Antigravity CLI が NIHO editor の工程用のエージェント（ツール無し）で起動しなかったため止めました。Antigravity CLI を最新に更新してから、もう一度試してください。".to_string()
    )
  );
  assert!(h.scratch_is_empty());
}

#[test]
fn agy_unknown_model_is_model_not_found() {
  let _guard = global_lock();
  let h = Harness::new("agy-model");
  let error = "invalid model selection (--model \"gemini-nonexistent-9\" --effort \"\"): model gemini-nonexistent-9 is not recognized as a known model or custom model in settings\nAvailable models:\n  Gemini 3.8 Flash (High)\n  Gemini 3.8 Flash (Medium)";
  // init も step も来ず、result だけで終了コード 1（stderr にも同じ文）
  let lines = vec![
    json!({"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":error}}).to_string(),
  ];
  h.fake(
    "agy",
    &format!(
      "cat > /dev/null\n{}\nprintf 'error: %s\\n' {} >&2\nexit 1",
      print_lines(&lines),
      sh_quote(error)
    ),
  );
  let events = h.run(h.request(Provider::GeminiCli, "gemini-nonexistent-9"));
  assert_eq!(
    error_of(&events),
    (ReasonCode::ModelNotFound, AGY_MODEL_MESSAGE.to_string())
  );
  assert!(h
    .logs()
    .iter()
    .any(|line| line.starts_with("turn_failed") && line.contains("\"exitCode\":1")));
  assert!(h.scratch_is_empty());
}

// ---------------------------------------------------------------------------
// 修正の会話（ToolPolicy::ProjectFolder。案件フォルダの中だけを読み書きする）

fn claude_file_init() -> String {
  json!({"type":"system","subtype":"init","session_id":"s","tools":["Edit","Glob","Grep","Read","Write"],"mcp_servers":[],"model":"claude-sonnet-5"})
    .to_string()
}

fn claude_tool_use(id: &str, name: &str, file_path: &str) -> String {
  json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":name,"input":{"file_path":file_path}}]},"parent_tool_use_id":null})
    .to_string()
}

fn claude_tool_result(id: &str, is_error: bool) -> String {
  json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":"中身","is_error":is_error}]},"parent_tool_use_id":null})
    .to_string()
}

#[test]
fn claude_project_folder_runs_in_the_folder_with_only_the_file_tools() {
  let _guard = global_lock();
  let h = Harness::new("claude-folder");
  let req = h.folder_request(Provider::ClaudeCode, "sonnet");
  let dir = fs::canonicalize(h.dir.join("work").join("project")).unwrap();
  let target = dir.join("artifacts").join("abc12345.md");
  let lines = vec![
    claude_file_init(),
    claude_message_start(10),
    claude_text("確かめます。"),
    claude_tool_use("toolu_1", "Read", &target.to_string_lossy()),
    claude_tool_result("toolu_1", false),
    claude_message_start(20),
    claude_tool_use("toolu_2", "Edit", &target.to_string_lossy()),
    claude_tool_result("toolu_2", false),
    claude_message_start(30),
    claude_text("見出しを短くしました。"),
    claude_message_delta("end_turn", 5),
    claude_result(json!({"result":"見出しを短くしました。"})),
  ];
  h.fake("claude", &format!("{CLAUDE_RECORD}\n{}", print_lines(&lines)));
  let events = h.run(req);

  let args = args_of(&h.read_out("args.txt"));
  assert_eq!(
    arg_after(&args, "--tools").as_deref(),
    Some("Read,Edit,Write,Glob,Grep")
  );
  assert_eq!(
    arg_after(&args, "--allowedTools").as_deref(),
    Some("Read,Glob,Grep,Edit(./artifacts/**)")
  );
  assert_eq!(arg_after(&args, "--permission-mode").as_deref(), Some("dontAsk"));
  for kept in ["--restricted", "--strict-mcp-config", "--disable-slash-commands"] {
    assert!(args.iter().any(|arg| arg == kept), "{kept}");
  }
  assert_eq!(arg_after(&args, "--setting-sources").as_deref(), Some(""));
  assert!(!args.iter().any(|arg| arg == "--add-dir"));
  // cwd は案件フォルダ（実体のパス）
  assert!(same_dir(Path::new(h.read_out("pwd.txt").trim()), &dir));
  assert_eq!(
    deltas(&events),
    vec![
      TurnEvent::TextDelta("確かめます。".into()),
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
  // 本文は返答だけ（ツールの前の実況は差分にだけ流れる）
  assert_eq!(done_of(&events).text, "見出しを短くしました。");
  assert!(h.scratch_is_empty());
}

/// Write の path を案件フォルダの artifacts/ の下だけで受ける偽の claude（`--restricted` と dontAsk ＋
/// `Edit(./artifacts/**)` の Claude Code のふるまいの写し）。指示の各行 `WRITE <path> <中身>` を Write として扱い、
/// `--restricted` が無ければどこにでも書いてしまう（フラグが要ることを確かめるため）。
const CLAUDE_WRITER: &str = r#"cat > "$OUT/stdin.txt"
printf '%s\n' "$@" > "$OUT/args.txt"
pwd > "$OUT/pwd.txt"
restricted=0
for a in "$@"; do if [ "$a" = "--restricted" ]; then restricted=1; fi; done
root=$(pwd -P)
printf '%s\n' '{"type":"system","subtype":"init","session_id":"s","tools":["Edit","Glob","Grep","Read","Write"],"mcp_servers":[]}'
n=0
while IFS=' ' read -r verb path content; do
  [ "$verb" = "WRITE" ] || continue
  n=$((n+1))
  printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_%s","name":"Write","input":{"file_path":"%s","content":"%s"}}]},"parent_tool_use_id":null}\n' "$n" "$path" "$content"
  parent=$(cd "$(dirname "$path")" 2>/dev/null && pwd -P)
  allowed=0
  if [ "$restricted" = 1 ]; then
    case "$parent/" in "$root"/artifacts/*) allowed=1 ;; esac
  else
    allowed=1
  fi
  if [ "$allowed" = 1 ] && [ -n "$parent" ]; then
    printf '%s' "$content" > "$path"
    printf '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_%s","content":"File created successfully","is_error":false}]},"parent_tool_use_id":null}\n' "$n"
  else
    printf '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_%s","content":"%s is outside %s; --restricted confines the file tools to the working directory.","is_error":true}]},"parent_tool_use_id":null}\n' "$n" "$path" "$root"
  fi
done < "$OUT/stdin.txt"
printf '%s\n' '{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":1}}},"parent_tool_use_id":null}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"書ける所だけ書きました。"}},"parent_tool_use_id":null}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"duration_ms":5,"result":"書ける所だけ書きました。","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}'
exit 0"#;

#[test]
fn claude_project_folder_writes_outside_the_folder_are_refused() {
  let _guard = global_lock();
  let h = Harness::new("claude-folder-outside");
  let mut req = h.folder_request(Provider::ClaudeCode, "sonnet");
  let outside = h.dir.join("outside.txt");
  fs::write(&outside, "そのまま").unwrap();
  let inside = h.dir.join("work").join("project").join("artifacts").join("abc12345.md");
  let project_json = h.dir.join("work").join("project").join("project.json");
  req.user_prompt = format!(
    "WRITE {} 外への書き込み\nWRITE {} 案件の情報\nWRITE {} 短い見出し\n",
    outside.display(),
    project_json.display(),
    inside.display()
  );
  h.fake("claude", CLAUDE_WRITER);
  let events = h.run(req);
  // フォルダの外と、フォルダの中でも artifacts/ の外は変わらず、artifacts/ の文書だけが変わる
  assert_eq!(fs::read_to_string(&outside).unwrap(), "そのまま");
  assert_eq!(fs::read_to_string(&project_json).unwrap(), "{\"id\":\"p1\"}\n");
  assert_eq!(fs::read_to_string(&inside).unwrap(), "短い見出し");
  let results: Vec<(String, bool)> = events
    .iter()
    .filter_map(|event| match event {
      TurnEvent::ToolResult { id, ok, .. } => Some((id.clone(), *ok)),
      _ => None,
    })
    .collect();
  assert_eq!(
    results,
    vec![
      ("toolu_1".to_string(), false),
      ("toolu_2".to_string(), false),
      ("toolu_3".to_string(), true)
    ]
  );
  let summaries: Vec<String> = events
    .iter()
    .filter_map(|event| match event {
      TurnEvent::ToolUse { summary, .. } => Some(summary.clone()),
      _ => None,
    })
    .collect();
  assert_eq!(summaries, vec!["outside.txt", "project.json", "abc12345.md"]);
  // 中身（content）とフォルダのパスは流れない
  assert!(!format!("{events:?}").contains("外への書き込み"));
  assert!(!format!("{events:?}").contains(&*h.dir.to_string_lossy()));
  assert_eq!(done_of(&events).text, "書ける所だけ書きました。");

  // `--restricted` が無い起動（ツール無しの工程の実行の引数ではない、仮の誤り）なら外にも書けてしまう偽物であること
  let h2 = Harness::new("claude-folder-unrestricted");
  let leak = h2.dir.join("leak.txt");
  h2.fake(
    "claude",
    &CLAUDE_WRITER.replace(
      "restricted=0\n",
      "restricted=0\nset -- $(printf '%s\\n' \"$@\" | grep -v -- '--restricted')\n",
    ),
  );
  let mut req = h2.folder_request(Provider::ClaudeCode, "sonnet");
  req.user_prompt = format!("WRITE {} 漏れ\n", leak.display());
  h2.run(req);
  assert_eq!(fs::read_to_string(&leak).unwrap(), "漏れ");
}

#[test]
fn claude_project_folder_stops_when_the_cli_starts_with_other_tools() {
  let _guard = global_lock();
  let h = Harness::new("claude-folder-bash");
  let lines = vec![
    json!({"type":"system","subtype":"init","tools":["Read","Edit","Bash"],"mcp_servers":[]}).to_string(),
    claude_message_start(1),
    claude_text("シェルで動いた分"),
  ];
  h.fake("claude", &format!("cat > /dev/null\n{}\nsleep 30", print_lines(&lines)));
  let started = Instant::now();
  let events = h.run(h.folder_request(Provider::ClaudeCode, "sonnet"));
  assert!(started.elapsed() < Duration::from_secs(10));
  let (code, message) = error_of(&events);
  assert_eq!(code, ReasonCode::NotConfigured);
  assert!(message.contains("許したもの以外のツール"), "{message}");
  assert!(deltas(&events).is_empty());
}

#[test]
fn codex_project_folder_uses_workspace_write_in_the_folder() {
  let _guard = global_lock();
  let h = Harness::new("codex-folder");
  let req = h.folder_request(Provider::CodexCli, "gpt-5.6-luna");
  let dir = fs::canonicalize(h.dir.join("work").join("project")).unwrap();
  let target = dir.join("artifacts").join("abc12345.md");
  let change = |phase: &str, status: &str| {
    json!({"type":phase,"item":{"id":"item_1","type":"file_change","changes":[{"path":target.to_string_lossy(),"kind":"update"}],"status":status}})
      .to_string()
  };
  let lines = vec![
    json!({"type":"thread.started","thread_id":THREAD}).to_string(),
    change("item.started", "in_progress"),
    change("item.completed", "completed"),
    json!({"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"見出しを短くしました。"}})
      .to_string(),
    json!({"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}).to_string(),
  ];
  h.fake("codex", &format!("{CODEX_RECORD}\n{}", print_lines(&lines)));
  let events = h.run(req);
  let args = args_of(&h.read_out("args.txt"));
  assert_eq!(
    &args[..4],
    ["exec", "--json", "--sandbox", "workspace-write"].map(String::from)
  );
  // 書き込みを許したフォルダが 1 つなので、その文書フォルダ（artifacts）を作業の root（-C と cwd）にする（spec §6.1）
  let writable_root = dir.join("artifacts");
  assert!(same_dir(Path::new(&arg_after(&args, "-C").unwrap()), &writable_root));
  assert!(same_dir(Path::new(h.read_out("pwd.txt").trim()), &writable_root));
  // apply_patch のある code_mode_host だけ残し、ほかは今の版で有効な機能（remote_plugin など）も切る
  assert!(!args.iter().any(|arg| arg == "features.code_mode_host=false"));
  for feature in [
    "shell_tool",
    "remote_plugin",
    "realtime_conversation",
    "apps",
    "plugins",
  ] {
    assert!(
      args
        .windows(2)
        .any(|pair| pair[0] == "-c" && pair[1] == format!("features.{feature}=false")),
      "{feature}"
    );
  }
  assert!(!args.iter().any(|arg| arg.starts_with("--disable")));
  assert!(args
    .windows(2)
    .any(|pair| pair[0] == "-c" && pair[1] == "sandbox_workspace_write.exclude_slash_tmp=true"));
  assert_eq!(
    deltas(&events),
    vec![
      TurnEvent::ToolUse {
        id: "item_1:0".into(),
        name: "Edit".into(),
        summary: "abc12345.md".into()
      },
      TurnEvent::ToolResult {
        id: "item_1:0".into(),
        name: "Edit".into(),
        ok: true
      },
      TurnEvent::TextDelta("見出しを短くしました。".into()),
    ]
  );
  assert_eq!(done_of(&events).text, "見出しを短くしました。");
}

#[test]
fn codex_project_folder_writes_outside_the_writable_folder_are_stopped() {
  let _guard = global_lock();
  let h = Harness::new("codex-folder-outside");
  let req = h.folder_request(Provider::CodexCli, "gpt-5.6-luna");
  let lines = vec![
    json!({"type":"thread.started","thread_id":THREAD}).to_string(),
    json!({"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"/tmp/niho-docs-outside.txt","kind":"add"}],"status":"completed"}}).to_string(),
  ];
  h.fake("codex", &format!("cat > /dev/null\n{}\nsleep 30", print_lines(&lines)));
  let started = Instant::now();
  let events = h.run(req);
  assert!(started.elapsed() < Duration::from_secs(10));
  let (code, message) = error_of(&events);
  assert_eq!(code, ReasonCode::NotConfigured);
  assert!(message.contains("文書フォルダの外に書こうとした"), "{message}");
  assert!(h
    .logs()
    .iter()
    .any(|line| line.starts_with("tool_breach") && line.contains("file_change_outside")));
}

/// 音声の区切り（`ToolPolicy::ReadFile`）を読む agy の偽物の頭。引数・cwd・作業フォルダの中身・agent.md・写したファイル
/// （中身と権限）を写し、作業フォルダの実体のパスの `view_file` の step を出す。
const AGY_READER_RECORD: &str = r#"cat > "$OUT/stdin.txt"
printf '%s\n' "$@" > "$OUT/args.txt"
pwd > "$OUT/pwd.txt"
ls -A > "$OUT/ws-entries.txt"
cp .agents/agents/niho-docs-transcriber/agent.md "$OUT/agent-copy.md"
cp part-01.wav "$OUT/part-copy.wav"
ls -l part-01.wav | cut -c1-10 > "$OUT/part-mode.txt"
here=$(pwd -P)"#;

fn agy_view_file_step(state: &str, path_expr: &str) -> String {
  // path_expr はシェルで展開する（"$here/part-01.wav" など）
  format!(
    "printf '%s\\n' \"{{\\\"event\\\":\\\"step_update\\\",\\\"step_update\\\":{{\\\"conversation_id\\\":\\\"{CONVERSATION}\\\",\\\"step_index\\\":1,\\\"state\\\":\\\"{state}\\\",\\\"step_type\\\":\\\"tool\\\",\\\"tool_name\\\":\\\"view_file\\\",\\\"tool_info\\\":{{\\\"name\\\":\\\"view_file\\\",\\\"parameters\\\":{{\\\"AbsolutePath\\\":\\\"{path_expr}\\\"}}}}}}}}\""
  )
}

fn read_file_request(h: &Harness) -> TurnRequest {
  let parts = h.dir.join("work").join("parts");
  fs::create_dir_all(&parts).unwrap();
  let file = parts.join("part-01.wav");
  fs::write(&file, b"RIFF....WAVEfmt fake audio").unwrap();
  TurnRequest {
    effort: Some(niho_local_ai::Effort::Low),
    system_prompt: "NIHO_SYSTEM_PROMPT_MARKER あなたは録音を正確に書き起こす担当者です。".to_string(),
    user_prompt: "NIHO_USER_PROMPT_MARKER part-01.wav を view_file で読み、書き起こしてください。".to_string(),
    tool_policy: ToolPolicy::ReadFile { file },
    ..h.request(Provider::GeminiCli, "gemini-3.8-flash")
  }
}

#[test]
fn agy_read_file_copies_the_file_and_lets_the_transcriber_view_only_it() {
  let _guard = global_lock();
  let h = Harness::new("agy-read-file");
  let lines = vec![agy_init("niho-docs-transcriber"), agy_user_input(CONVERSATION)];
  let after = vec![
    agy_step(
      CONVERSATION,
      2,
      "DONE",
      "agent_response",
      json!({"text_delta":"[00:00] こんにちは。\n\n[00:06] 来月から記事を作ります。","usage":{"input_tokens":3463,"output_tokens":38,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":3501}}),
    ),
    agy_result(
      CONVERSATION,
      json!({"response":"[00:00] こんにちは。\n\n[00:06] 来月から記事を作ります。"}),
    ),
  ];
  h.fake(
    "agy",
    &format!(
      "{AGY_READER_RECORD}\n{}\n{}\n{}\n{}",
      print_lines(&lines),
      agy_view_file_step("ACTIVE", "$here/part-01.wav"),
      agy_view_file_step("DONE", "$here/part-01.wav"),
      print_lines(&after)
    ),
  );
  let events = h.run(read_file_request(&h));
  let done = done_of(&events);
  assert_eq!(done.text, "[00:00] こんにちは。\n\n[00:06] 来月から記事を作ります。");
  assert_eq!(done.usage.input_tokens, 3463);

  let args = args_of(&h.read_out("args.txt"));
  assert_eq!(arg_after(&args, "--agent").as_deref(), Some("niho-docs-transcriber"));
  assert_eq!(arg_after(&args, "--effort").as_deref(), Some("low"));
  assert!(args.iter().any(|arg| arg == "--disable-slash-commands"));
  assert!(!args
    .iter()
    .any(|arg| arg == "--conversation" || arg == "--dangerously-skip-permissions" || arg == "--mode"));
  // 作業フォルダはその回だけ: エージェントと写したファイルだけがある。写しは 0600 で中身は同じ
  assert_eq!(h.read_out("ws-entries.txt"), ".agents\npart-01.wav\n");
  assert_eq!(fs::read(h.out("part-copy.wav")).unwrap(), b"RIFF....WAVEfmt fake audio");
  assert_eq!(h.read_out("part-mode.txt").trim(), "-rw-------");
  let agent = h.read_out("agent-copy.md");
  assert!(agent.contains("\ntools: [view_file]\n"), "{agent}");
  assert!(agent.ends_with("NIHO_SYSTEM_PROMPT_MARKER あなたは録音を正確に書き起こす担当者です。"));
  assert_eq!(
    serde_json::from_str::<Value>(h.read_out("stdin.txt").trim_end()).unwrap()["message"]["content"],
    "NIHO_USER_PROMPT_MARKER part-01.wav を view_file で読み、書き起こしてください。"
  );
  // 終わったら写しごと消える。ログに指示文・本文は出ない
  assert!(h.scratch_is_empty());
  for line in h.logs() {
    assert!(
      !line.contains("NIHO_SYSTEM_PROMPT_MARKER") && !line.contains("NIHO_USER_PROMPT_MARKER"),
      "{line}"
    );
  }
}

#[test]
fn agy_read_file_outside_the_workspace_or_other_tools_are_stopped() {
  let _guard = global_lock();
  let h = Harness::new("agy-read-outside");
  h.fake(
    "agy",
    &format!(
      "cat > /dev/null\n{}\n{}\nsleep 30",
      print_lines(&[agy_init("niho-docs-transcriber"), agy_user_input(CONVERSATION)]),
      agy_view_file_step("ACTIVE", "/etc/passwd")
    ),
  );
  let started = Instant::now();
  let events = h.run(read_file_request(&h));
  assert!(started.elapsed() < Duration::from_secs(10));
  let (code, message) = error_of(&events);
  assert_eq!(code, ReasonCode::NotConfigured);
  assert!(message.contains("渡した音声の外のファイル"), "{message}");

  // 工程用（書くだけ）のエージェントで起動したら止める
  let h = Harness::new("agy-read-writer-agent");
  h.fake(
    "agy",
    &format!(
      "cat > /dev/null\n{}\nsleep 30",
      print_lines(&[agy_init("niho-docs-writer")])
    ),
  );
  let (code, message) = error_of(&h.run(read_file_request(&h)));
  assert_eq!(code, ReasonCode::NotConfigured);
  assert!(message.contains("文字起こし用のエージェント"), "{message}");
}

#[test]
fn agy_read_file_that_was_denied_is_a_retryable_failure() {
  let _guard = global_lock();
  let h = Harness::new("agy-read-denied");
  let lines = vec![
    agy_init("niho-docs-transcriber"),
    agy_user_input(CONVERSATION),
    agy_result(CONVERSATION, json!({"response":"","denied_actions":["view_file"]})),
  ];
  h.fake("agy", &format!("cat > /dev/null\n{}", print_lines(&lines)));
  assert_eq!(
    error_of(&h.run(read_file_request(&h))),
    (
      ReasonCode::TransientFailure,
      "Antigravity CLI が音声を読めませんでした。もう一度実行してください。".to_string()
    )
  );
}

#[test]
fn read_file_is_only_for_agy_without_starting_other_clis() {
  let _guard = global_lock();
  let h = Harness::new("read-file-others");
  h.fake("claude", "touch \"$OUT/claude-ran\"\nexit 0");
  h.fake("codex", "touch \"$OUT/codex-ran\"\nexit 0");
  for provider in [Provider::ClaudeCode, Provider::CodexCli] {
    let mut req = read_file_request(&h);
    req.provider = provider;
    req.model = "sonnet".to_string();
    assert_eq!(error_of(&h.run(req)).0, ReasonCode::NotConfigured);
  }
  assert!(!h.out("claude-ran").exists() && !h.out("codex-ran").exists());
}

#[test]
fn agy_usage_runs_slash_usage_in_an_empty_folder_with_stdin_closed() {
  let _guard = global_lock();
  let h = Harness::new("agy-usage");
  let usage = json!({"conversation_id":"","status":"SUCCESS","response":"Gemini Models\tWeekly Limit Remaining\t59%\n","usage":{},
    "command":{"name":"usage","data":{"groups":[
      {"name":"Gemini Models","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.59,"reset_time":"2026-10-21T19:12:26Z"}]},
      {"name":"Claude and GPT models","buckets":[{"id":"3p-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":1,"reset_time":"2026-10-22T03:21:42Z"}]}]}}})
  .to_string();
  h.fake(
    "agy",
    &format!(
      "cat > \"$OUT/usage-stdin.txt\"\nprintf '%s\\n' \"$@\" > \"$OUT/usage-args.txt\"\npwd > \"$OUT/usage-pwd.txt\"\nls -A > \"$OUT/usage-entries.txt\"\nprintf '%s\\n' {}",
      sh_quote(&usage)
    ),
  );
  let result = provider_usage_with(&h.runtime(), Provider::GeminiCli).unwrap();
  assert_eq!(result.provider, Provider::GeminiCli);
  assert_eq!(result.windows.len(), 2);
  assert_eq!(result.windows[0].group, "Gemini Models");
  assert_eq!(result.windows[0].remaining_fraction, Some(0.59));
  assert_eq!(result.windows[0].reset_time.as_deref(), Some("2026-10-21T19:12:26Z"));
  assert_eq!(
    args_of(&h.read_out("usage-args.txt")),
    ["-p", "/usage", "--output-format", "json"].map(String::from)
  );
  assert_eq!(h.read_out("usage-stdin.txt"), "");
  assert_eq!(h.read_out("usage-entries.txt"), "");
  assert!(is_under(Path::new(h.read_out("usage-pwd.txt").trim()), &h.scratch()));
  assert!(h.scratch_is_empty());

  // ログインしていないときと、形の違う出力
  h.fake("agy", "echo 'error: authentication required' >&2\nexit 1");
  assert_eq!(
    provider_usage_with(&h.runtime(), Provider::GeminiCli).unwrap_err().code,
    "auth_required"
  );
  h.fake("agy", "echo '{\"status\":\"SUCCESS\"}'");
  assert_eq!(
    provider_usage_with(&h.runtime(), Provider::GeminiCli).unwrap_err().code,
    "usage_unavailable"
  );
}

/// 修正の会話（`ToolPolicy::ProjectFolder`）の agy の偽物の頭。引数・cwd・cwd の中身・agent.md（中身と権限）を写し、
/// `$here` に作業フォルダ（cwd）の実体のパスを置く。
const AGY_EDITOR_RECORD: &str = r#"cat > "$OUT/stdin.txt"
printf '%s\n' "$@" > "$OUT/args.txt"
pwd > "$OUT/pwd.txt"
here=$(pwd -P)
ls -A > "$OUT/ws-entries.txt"
cp .agents/agents/niho-docs-editor/agent.md "$OUT/agent-copy.md"
ls -ld .agents .agents/agents .agents/agents/niho-docs-editor .agents/agents/niho-docs-editor/agent.md | cut -c1-10 > "$OUT/agent-modes.txt""#;

/// 道具の step を出すシェルの文。`parameters` の中の `$here`（作業フォルダの実体のパス）だけをシェルで展開する。
fn agy_tool_step_sh(index: u64, state: &str, name: &str, parameters: Value) -> String {
  let line = agy_step(
    CONVERSATION,
    index,
    state,
    "tool",
    json!({"tool_name":name,"tool_info":{"name":name,"parameters":parameters}}),
  );
  let escaped = line
    .replace('\\', "\\\\")
    .replace('"', "\\\"")
    .replace('`', "\\`")
    .replace('$', "\\$")
    .replace("\\$here", "$here");
  format!("printf '%s\\n' \"{escaped}\"")
}

#[test]
fn agy_project_folder_runs_in_the_folder_with_the_editor_agent() {
  let _guard = global_lock();
  let h = Harness::new("agy-folder");
  let mut req = h.folder_request(Provider::GeminiCli, "gemini-3.8-flash");
  req.effort = Some(niho_local_ai::Effort::Low);
  let dir = fs::canonicalize(h.dir.join("work").join("project")).unwrap();
  let document = dir.join("artifacts").join("abc12345.md");
  let read = json!({"AbsolutePath":"$here/artifacts/abc12345.md"});
  let edit = json!({"TargetFile":"$here/artifacts/abc12345.md","TargetContent":"# とても長い見出し","ReplacementContent":"# 短い見出し","StartLine":1,"EndLine":1,"AllowMultiple":false});
  let script = [
    AGY_EDITOR_RECORD.to_string(),
    print_lines(&[
      agy_init("niho-docs-editor"),
      agy_user_input(CONVERSATION),
      agy_step(
        CONVERSATION,
        1,
        "DONE",
        "agent_response",
        json!({"text_delta":"確かめます。","usage":{"input_tokens":100,"output_tokens":5}}),
      ),
    ]),
    agy_tool_step_sh(2, "ACTIVE", "view_file", read.clone()),
    agy_tool_step_sh(2, "DONE", "view_file", read),
    agy_tool_step_sh(3, "ACTIVE", "replace_file_content", edit.clone()),
    "printf '# 短い見出し\\n\\n本文。\\n' > artifacts/abc12345.md".to_string(),
    agy_tool_step_sh(3, "DONE", "replace_file_content", edit),
    print_lines(&[
      agy_step(
        CONVERSATION,
        4,
        "DONE",
        "agent_response",
        json!({"text_delta":"見出しを短くしました。","usage":{"input_tokens":200,"output_tokens":10}}),
      ),
      agy_result(CONVERSATION, json!({"response":"確かめます。見出しを短くしました。"})),
    ]),
  ]
  .join("\n");
  h.fake("agy", &script);
  let events = h.run(req.clone());

  let args = args_of(&h.read_out("args.txt"));
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
    "low",
    "--disable-slash-commands",
    "--print-timeout",
    "0",
  ]
  .iter()
  .map(|value| value.to_string())
  .collect();
  assert_eq!(args, expected);
  // 指示は標準入力に 1 行の JSON
  assert_eq!(
    serde_json::from_str::<Value>(h.read_out("stdin.txt").trim_end()).unwrap()["message"]["content"],
    USER_PROMPT
  );
  // cwd は作業フォルダ（実体のパス）。修正用のエージェント（0700 のフォルダと 0600 の agent.md）を置き、終わったら消す
  assert!(same_dir(Path::new(h.read_out("pwd.txt").trim()), &dir));
  assert_eq!(h.read_out("ws-entries.txt"), ".agents\nartifacts\nproject.json\n");
  assert_eq!(
    h.read_out("agent-copy.md"),
    format!(
      "---\nname: niho-docs-editor\ndescription: NIHO docs の修正の会話。作業フォルダの文書（Markdown）を読み、頼まれたところを直す。\ntools: [view_file, list_dir, write_to_file, replace_file_content, multi_replace_file_content]\nmainAgent: true\nsubagent: false\ncommandExecutionPolicy: off\n---\n{SYSTEM_PROMPT}"
    )
  );
  assert_eq!(
    h.read_out("agent-modes.txt"),
    "drwx------\ndrwx------\ndrwx------\n-rw-------\n"
  );
  assert!(!dir.join(".agents").exists());
  assert!(h.scratch_is_empty());
  // 文書は agy が書き換えたまま（取り込むのは呼び出し側）
  assert_eq!(fs::read_to_string(&document).unwrap(), "# 短い見出し\n\n本文。\n");
  assert_eq!(
    deltas(&events),
    vec![
      TurnEvent::TextDelta("確かめます。".into()),
      TurnEvent::ToolUse {
        id: "step-2".into(),
        name: "Read".into(),
        summary: "abc12345.md".into()
      },
      TurnEvent::ToolResult {
        id: "step-2".into(),
        name: "Read".into(),
        ok: true
      },
      TurnEvent::ToolUse {
        id: "step-3".into(),
        name: "Edit".into(),
        summary: "abc12345.md".into()
      },
      TurnEvent::ToolResult {
        id: "step-3".into(),
        name: "Edit".into(),
        ok: true
      },
      TurnEvent::TextDelta("見出しを短くしました。".into()),
    ]
  );
  // 本文は返答だけ（道具の前の実況は差分にだけ流れる）。使用量はこの回の step の和
  let done = done_of(&events);
  assert_eq!(done.text, "見出しを短くしました。");
  assert_eq!(done.session_id.as_deref(), Some(CONVERSATION));
  assert_eq!((done.usage.input_tokens, done.usage.output_tokens), (300, 15));
  for line in h.logs() {
    assert!(
      !line.contains("NIHO_SYSTEM_PROMPT_MARKER") && !line.contains("NIHO_USER_PROMPT_MARKER"),
      "{line}"
    );
  }

  // 続きは同じ会話の ID を --conversation で渡す
  let mut resumed = req;
  resumed.resume_session = Some(CONVERSATION.to_string());
  let events = h.run(resumed);
  assert_eq!(done_of(&events).session_id.as_deref(), Some(CONVERSATION));
  let args = args_of(&h.read_out("args.txt"));
  assert_eq!(arg_after(&args, "--conversation").as_deref(), Some(CONVERSATION));
  assert_eq!(arg_after(&args, "--mode").as_deref(), Some("accept-edits"));
  assert!(!dir.join(".agents").exists());
}

#[test]
fn agy_project_folder_stops_paths_outside_writes_outside_markdown_and_other_tools() {
  let _guard = global_lock();
  let cases = [
    (
      "outside",
      "view_file",
      json!({"AbsolutePath":"/etc/passwd"}),
      "作業フォルダの外のファイル",
      "path_outside",
    ),
    (
      "dotdot",
      "view_file",
      json!({"AbsolutePath":"$here/artifacts/../../outside.txt"}),
      "作業フォルダの外のファイル",
      "path_outside",
    ),
    (
      "project-json",
      "write_to_file",
      json!({"TargetFile":"$here/project.json","CodeContent":"{}"}),
      "文書（Markdown）の外",
      "write_outside",
    ),
    (
      "txt",
      "write_to_file",
      json!({"TargetFile":"$here/artifacts/notes.txt","CodeContent":"x"}),
      "文書（Markdown）の外",
      "write_outside",
    ),
    (
      "command",
      "run_command",
      json!({"CommandLine":"cat /etc/passwd"}),
      "許したもの以外のツール",
      "tool:run_command",
    ),
    (
      "web",
      "search_web",
      json!({"query":"NIHO"}),
      "許したもの以外のツール",
      "tool:search_web",
    ),
  ];
  for (name, tool, parameters, message_part, kind) in cases {
    let h = Harness::new(&format!("agy-folder-{name}"));
    let req = h.folder_request(Provider::GeminiCli, "gemini-3.8-flash");
    let project = h.dir.join("work").join("project");
    h.fake(
      "agy",
      &format!(
        "cat > /dev/null\nhere=$(pwd -P)\n{}\n{}\nsleep 30",
        print_lines(&[agy_init("niho-docs-editor"), agy_user_input(CONVERSATION)]),
        agy_tool_step_sh(1, "ACTIVE", tool, parameters)
      ),
    );
    let started = Instant::now();
    let events = h.run(req);
    assert!(started.elapsed() < Duration::from_secs(10), "{name}");
    let (code, message) = error_of(&events);
    assert_eq!(code, ReasonCode::NotConfigured, "{name}");
    assert!(message.contains(message_part), "{name}: {message}");
    assert!(deltas(&events).is_empty(), "{name}: {events:?}");
    assert!(!project.join(".agents").exists(), "{name}");
    assert_eq!(
      fs::read_to_string(project.join("project.json")).unwrap(),
      "{\"id\":\"p1\"}\n"
    );
    assert!(
      h.logs()
        .iter()
        .any(|line| line.starts_with("tool_breach") && line.contains(&format!("\"{kind}\""))),
      "{name}: {:?}",
      h.logs()
    );
  }
}

#[test]
fn agy_project_folder_with_rules_or_without_a_writable_folder_does_not_start_the_cli() {
  let _guard = global_lock();
  let h = Harness::new("agy-folder-rules");
  h.fake("agy", "touch \"$OUT/agy-ran\"\nexit 0");
  // 作業フォルダに agy が読む決まりがある
  let req = h.folder_request(Provider::GeminiCli, "gemini-3.8-flash");
  let project = h.dir.join("work").join("project");
  for rules in ["AGENTS.md", "GEMINI.md", ".agents"] {
    fs::write(project.join(rules), "決まり").unwrap();
    let (code, message) = error_of(&h.run(req.clone()));
    assert_eq!(code, ReasonCode::NotConfigured);
    assert!(message.contains("決まり"), "{rules}: {message}");
    // 前からあるものは消さない
    assert!(project.join(rules).exists());
    fs::remove_file(project.join(rules)).unwrap();
  }
  // 書き込み先が無い
  let mut anywhere = req;
  anywhere.tool_policy = ToolPolicy::ProjectFolder {
    dir: project,
    writable: Vec::new(),
  };
  let (code, message) = error_of(&h.run(anywhere));
  assert_eq!(code, ReasonCode::NotConfigured);
  assert!(message.contains("書き込み先"), "{message}");
  assert!(!h.out("agy-ran").exists());
}

#[test]
fn project_folder_that_is_missing_is_not_configured() {
  let _guard = global_lock();
  let h = Harness::new("folder-missing");
  h.fake("claude", "touch \"$OUT/claude-ran\"\nexit 0");
  let mut req = h.request(Provider::ClaudeCode, "sonnet");
  req.tool_policy = ToolPolicy::ProjectFolder {
    dir: h.dir.join("no-such-project"),
    writable: vec!["artifacts".to_string()],
  };
  let events = h.run(req);
  assert_eq!(error_of(&events).0, ReasonCode::NotConfigured);
  assert!(!h.out("claude-ran").exists());
}

// ---------------------------------------------------------------------------
// 状態・ログイン・更新・インストール

#[test]
fn status_reads_version_login_and_flags_for_claude() {
  let h = Harness::new("status-claude");
  h.fake("claude", &claude_cli_body(&CLAUDE_HELP_FLAGS, ""));
  h.touch_out("logged-in");
  let status = provider_status_with(&h.runtime(), Provider::ClaudeCode);
  assert!(status.installed);
  assert!(status.authenticated);
  assert_eq!(status.version.as_deref(), Some("2.1.267 (Claude Code)"));
  assert_eq!(status.cli_path, Some(h.bin("claude").to_string_lossy().into_owned()));
  assert_eq!(status.login_method.as_deref(), Some("Claude Max account"));
  assert_eq!(status.reason, None);
  assert!(status.missing_cli_flags.is_empty());
  assert_eq!(
    status.capabilities,
    Capabilities {
      resume: true,
      effort: true,
      max_tokens_stop: true
    }
  );
  assert_eq!(
    serde_json::to_value(&status).unwrap()["capabilities"],
    json!({"resume":true,"effort":true,"maxTokensStop":true})
  );

  // ログインしていない
  fs::remove_file(h.out("logged-in")).unwrap();
  let status = provider_status_with(&h.runtime(), Provider::ClaudeCode);
  assert!(status.installed && !status.authenticated);
  assert_eq!(status.reason.as_deref(), Some("auth_required"));
  assert_eq!(status.login_method, None);
}

#[test]
fn status_reports_missing_flags_from_help() {
  let h = Harness::new("status-flags");
  let without_effort: Vec<&str> = CLAUDE_HELP_FLAGS
    .iter()
    .copied()
    .filter(|flag| !flag.starts_with("--effort"))
    .collect();
  h.fake("claude", &claude_cli_body(&without_effort, ""));
  h.touch_out("logged-in");
  let status = provider_status_with(&h.runtime(), Provider::ClaudeCode);
  assert!(status.installed && status.authenticated);
  assert_eq!(status.missing_cli_flags, vec!["--effort".to_string()]);
  assert_eq!(status.reason.as_deref(), Some("cli_flags_missing"));
}

#[test]
fn status_reads_codex_login_status() {
  let h = Harness::new("status-codex");
  h.fake("codex", &codex_cli_body(CODEX_HELP));
  let status = provider_status_with(&h.runtime(), Provider::CodexCli);
  assert!(status.installed);
  assert!(!status.authenticated);
  assert_eq!(status.reason.as_deref(), Some("auth_required"));
  h.touch_out("codex-logged-in");
  let status = provider_status_with(&h.runtime(), Provider::CodexCli);
  assert!(status.authenticated);
  assert_eq!(status.version.as_deref(), Some("codex-cli 0.154.0"));
  assert_eq!(status.login_method.as_deref(), Some("ChatGPT"));
  // ログイン後は `codex debug models` の一覧（visibility が list のもの）を返す。アプリの CODEX_HOME で見る
  assert_eq!(status.models, ["gpt-6-astra", "gpt-5.6-sol"].map(String::from));
  assert_eq!(h.read_out("codex-models-home.txt"), h.codex_home().to_string_lossy());
  // カタログが状態の確認の出力の上限（256 KiB）を超えても、一覧を頭から読める（末尾だけ残ると JSON が読めず空になっていた）
  h.touch_out("codex-models-large");
  let large = provider_status_with(&h.runtime(), Provider::CodexCli);
  assert_eq!(large.models, ["gpt-6.1-sol", "gpt-6-astra"].map(String::from));
  fs::remove_file(h.out("codex-models-large")).unwrap();
  assert!(status.missing_cli_flags.is_empty(), "{:?}", status.missing_cli_flags);
  assert_eq!(status.reason, None);
  assert_eq!(
    status.capabilities,
    Capabilities {
      resume: true,
      effort: true,
      max_tokens_stop: false
    }
  );
}

#[test]
fn status_reads_agy_version_models_and_flags() {
  let h = Harness::new("status-agy");
  h.fake("agy", &agy_cli_body());
  // ログインしていない（`agy models` が authentication required で終わる）
  let status = provider_status_with(&h.runtime(), Provider::GeminiCli);
  assert!(status.installed);
  assert_eq!(status.version.as_deref(), Some("1.3.5"));
  assert_eq!(status.cli_path, Some(h.bin("agy").to_string_lossy().into_owned()));
  assert!(!status.authenticated);
  assert_eq!(status.reason.as_deref(), Some("auth_required"));
  assert!(status.models.is_empty());
  assert!(status.missing_cli_flags.is_empty(), "{:?}", status.missing_cli_flags);

  // ログイン済み: models の 1 列目が入る（Fetching の行は飛ばす）
  h.touch_out("agy-logged-in");
  let status = provider_status_with(&h.runtime(), Provider::GeminiCli);
  assert!(status.authenticated);
  assert_eq!(status.reason, None);
  assert_eq!(status.login_method, None);
  assert_eq!(
    status.models,
    [
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]
    .map(String::from)
  );
  assert_eq!(
    serde_json::to_value(&status).unwrap()["models"][0],
    json!("gemini-3.8-flash-high")
  );
  assert_eq!(
    status.capabilities,
    Capabilities {
      resume: true,
      effort: true,
      max_tokens_stop: false
    }
  );

  // 古い agy: 起動に使うフラグが --help に無い
  h.touch_out("agy-old-help");
  let status = provider_status_with(&h.runtime(), Provider::GeminiCli);
  assert!(status.installed && status.authenticated);
  assert_eq!(
    status.missing_cli_flags,
    [
      "--agent",
      "--conversation",
      "--input-format",
      "--effort",
      "--disable-slash-commands",
      "--print-timeout",
    ]
    .map(String::from)
  );
  assert_eq!(status.reason.as_deref(), Some("cli_flags_missing"));

  // ログイン以外の理由で `agy models` が失敗したら、確かめられなかったとする
  fs::remove_file(h.out("agy-old-help")).unwrap();
  h.touch_out("agy-models-broken");
  let status = provider_status_with(&h.runtime(), Provider::GeminiCli);
  assert!(!status.authenticated);
  assert_eq!(status.reason.as_deref(), Some("auth_probe_failed"));
  assert!(status.models.is_empty());

  // codex はログインしているときだけ `codex debug models` の一覧を返す（status_reads_codex_login_status）
  h.fake("codex", &codex_cli_body(CODEX_HELP));
  assert!(provider_status_with(&h.runtime(), Provider::CodexCli).models.is_empty());
  h.touch_out("codex-logged-in");
  assert!(!provider_status_with(&h.runtime(), Provider::CodexCli).models.is_empty());
}

#[test]
fn status_without_the_cli_is_cli_not_found() {
  let h = Harness::new("status-missing");
  for provider in Provider::ALL {
    let status = provider_status_with(&h.runtime(), provider);
    assert!(!status.installed);
    assert!(!status.authenticated);
    assert_eq!(status.reason.as_deref(), Some("cli_not_found"));
    assert_eq!(status.cli_path, None);
  }
}

#[test]
fn start_auth_passes_only_auth_login_to_claude() {
  let _guard = global_lock();
  let h = Harness::new("auth-claude");
  h.fake("claude", &claude_cli_body(&CLAUDE_HELP_FLAGS, ""));
  let status = start_auth_with(&h.runtime(), Provider::ClaudeCode).unwrap();
  assert!(status.authenticated);
  assert_eq!(status.login_method.as_deref(), Some("Claude Max account"));
  assert_eq!(h.read_out("auth-args.txt"), "auth\nlogin\n");
  // すでにログインしていれば何もしない
  fs::remove_file(h.out("auth-args.txt")).unwrap();
  assert!(
    start_auth_with(&h.runtime(), Provider::ClaudeCode)
      .unwrap()
      .authenticated
  );
  assert!(!h.out("auth-args.txt").exists());
}

#[test]
fn start_auth_reports_the_exit_code_when_login_fails() {
  let _guard = global_lock();
  let h = Harness::new("auth-fails");
  h.fake("claude", &claude_cli_body(&CLAUDE_HELP_FLAGS, ""));
  h.touch_out("login-fails");
  let error = start_auth_with(&h.runtime(), Provider::ClaudeCode).unwrap_err();
  assert_eq!(error.code, "auth_failed");
  assert_eq!(error.details.as_deref(), Some("exit code 7"));
  // CLI が無い
  let missing = Harness::new("auth-missing");
  assert_eq!(
    start_auth_with(&missing.runtime(), Provider::ClaudeCode)
      .unwrap_err()
      .code,
    "cli_not_found"
  );
}

#[test]
fn start_auth_passes_only_login_to_codex_and_refuses_agy() {
  let _guard = global_lock();
  let h = Harness::new("auth-codex");
  h.fake("codex", &codex_cli_body(CODEX_HELP));
  let status = start_auth_with(&h.runtime(), Provider::CodexCli).unwrap();
  assert!(status.authenticated);
  assert_eq!(h.read_out("codex-login-args.txt"), "login\n");
  // このアプリ用のログイン（利用者の ~/.codex ではなく、アプリの CODEX_HOME に入る）
  assert_eq!(h.read_out("codex-login-home.txt"), h.codex_home().to_string_lossy());
  h.fake("agy", &agy_cli_body());
  let error = start_auth_with(&h.runtime(), Provider::GeminiCli).unwrap_err();
  assert_eq!(error.code, "auth_unsupported");
  assert_eq!(
    error.message,
    "Antigravity CLI のログインは、ターミナルで agy を起動して行ってください（初回は Google のアカウントでログインします）。"
  );
}

#[test]
fn maintenance_and_turns_exclude_each_other() {
  let _guard = global_lock();
  let h = Harness::new("exclusive");
  let turn = print_lines(&[claude_init(), claude_message_start(1), claude_text("running")]) + "\nsleep 30";
  h.fake("claude", &claude_cli_body(&CLAUDE_HELP_FLAGS, &turn));

  // 工程の実行中は、更新・ログイン・インストールを断る
  let (handle, events) = h.start(h.request(Provider::ClaudeCode, "claude-sonnet-5"));
  wait_until(Duration::from_secs(10), "a running turn", || {
    !events.lock().unwrap().is_empty()
  });
  assert_eq!(update_claude_with(&h.runtime()).unwrap_err().code, "turn_running");
  assert_eq!(
    start_auth_with(&h.runtime(), Provider::ClaudeCode).unwrap_err().code,
    "turn_running"
  );
  assert_eq!(install_claude_with(&h.runtime()).unwrap_err().code, "turn_running");
  assert!(!h.out("update-args.txt").exists() && !h.out("auth-args.txt").exists());
  assert!(handle.stop());
  handle.wait();

  // ログインの最中は、工程を断る
  h.touch_out("login-waits");
  let runtime = h.runtime();
  let auth = std::thread::spawn(move || start_auth_with(&runtime, Provider::ClaudeCode));
  wait_until(Duration::from_secs(10), "the login to start", || {
    h.out("auth-started").exists()
  });
  let events = h.run(h.request(Provider::ClaudeCode, "claude-sonnet-5"));
  assert_eq!(
    error_of(&events),
    (ReasonCode::TransientFailure, MAINTENANCE_BUSY.to_string())
  );
  assert!(auth.join().unwrap().unwrap().authenticated);
}

#[test]
fn update_claude_passes_only_update_and_reports_versions() {
  let _guard = global_lock();
  let h = Harness::new("update");
  h.fake("claude", &claude_cli_body(&CLAUDE_HELP_FLAGS, ""));
  h.touch_out("logged-in");
  let result = update_claude_with(&h.runtime()).unwrap();
  assert_eq!(h.read_out("update-args.txt"), "update\n");
  assert_eq!(result.before_version.as_deref(), Some("2.1.267 (Claude Code)"));
  assert_eq!(result.after_version.as_deref(), Some("2.1.300 (Claude Code)"));
  assert!(result.status.installed && result.status.missing_cli_flags.is_empty());
  assert_eq!(
    serde_json::to_value(&result).unwrap()["afterVersion"],
    json!("2.1.300 (Claude Code)")
  );
}

#[test]
fn update_claude_failure_keeps_the_output_tail() {
  let _guard = global_lock();
  let h = Harness::new("update-fails");
  h.fake("claude", &claude_cli_body(&CLAUDE_HELP_FLAGS, ""));
  h.touch_out("update-fails");
  let error = update_claude_with(&h.runtime()).unwrap_err();
  assert_eq!(error.code, "update_failed");
  assert_eq!(error.details.as_deref(), Some("update failed"));
  let missing = Harness::new("update-missing");
  assert_eq!(
    update_claude_with(&missing.runtime()).unwrap_err().code,
    "cli_not_found"
  );
}

#[test]
fn install_claude_downloads_runs_and_removes_the_installer() {
  let _guard = global_lock();
  let h = Harness::new("install");
  // インストーラは bin/claude（Runtime の CLI の場所）に偽の claude を置く
  fs::write(
    h.out("claude-to-install"),
    format!(
      "#!/bin/sh\nOUT={}\n{}\n",
      sh_quote(&h.dir.join("out").to_string_lossy()),
      claude_cli_body(&CLAUDE_HELP_FLAGS, "")
    ),
  )
  .unwrap();
  fs::write(
    h.out("installer.sh"),
    format!(
      "#!/bin/sh\ncp {} {}\nchmod 755 {}\necho installed\n",
      sh_quote(&h.out("claude-to-install").to_string_lossy()),
      sh_quote(&h.bin("claude").to_string_lossy()),
      sh_quote(&h.bin("claude").to_string_lossy())
    ),
  )
  .unwrap();
  h.fake(
    "curl",
    r#"printf '%s\n' "$@" > "$OUT/curl-args.txt"
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output" ]; then out="$a"; fi
  prev="$a"
done
printf '%s' "$out" > "$OUT/installer-path.txt"
cat "$OUT/installer.sh" > "$out""#,
  );
  h.fake(
    "shell",
    "printf '%s\\n' \"$@\" > \"$OUT/shell-args.txt\"\nexec /bin/sh \"$@\"",
  );

  let status = install_claude_with(&h.runtime()).unwrap();
  assert!(status.installed);
  assert_eq!(status.version.as_deref(), Some("2.1.267 (Claude Code)"));
  let curl_args = args_of(&h.read_out("curl-args.txt"));
  let installer_path = h.read_out("installer-path.txt");
  assert_eq!(
    curl_args,
    [
      "-fsSL",
      "--proto",
      "=https",
      "--tlsv1.2",
      "--output",
      installer_path.as_str(),
      "https://example.invalid/install.sh"
    ]
    .map(String::from)
  );
  assert_eq!(h.read_out("shell-args.txt"), format!("{installer_path}\n"));
  assert!(Path::new(&installer_path).starts_with(h.scratch()));
  assert!(
    !Path::new(&installer_path).exists(),
    "the downloaded installer is removed"
  );
  assert!(h.scratch_is_empty());

  // すでに入っていれば何もしない
  fs::remove_file(h.out("curl-args.txt")).unwrap();
  assert!(install_claude_with(&h.runtime()).unwrap().installed);
  assert!(!h.out("curl-args.txt").exists());
}

#[test]
fn install_claude_download_failure_is_an_error() {
  let _guard = global_lock();
  let h = Harness::new("install-fails");
  h.fake(
    "curl",
    "echo 'curl: (22) The requested URL returned error: 404' >&2\nexit 22",
  );
  h.fake("shell", "touch \"$OUT/shell-ran\"");
  let error = install_claude_with(&h.runtime()).unwrap_err();
  assert_eq!(error.code, "install_download_failed");
  assert!(error.details.as_deref().is_some_and(|details| details.contains("404")));
  assert!(!h.out("shell-ran").exists(), "nothing is run when the download fails");
  assert!(h.scratch_is_empty());
}
