//! API キー方式の adapter（api_ai.rs）を、メモリの鍵の保存先と 127.0.0.1 の偽の API サーバーで確かめる。本物の鍵・本物の
//! Keychain は使わない（Keychain そのものは secrets.rs の #[ignore] のテストがテスト用の service 名で確かめる）。
//!
//! 鍵の漏れ: 偽の鍵で工程（続きを含む）・Gemini の区切り・Deepgram を通し、提供元がエラーの本文に鍵を返しても、
//! 画面へのイベント・鍵の状態・診断ログ（local-ai.log）・app data（会話の履歴を含む）のどこにも鍵の文字列が無いことを確かめる。
//! project.json・runs.jsonl・checkpoint・settings.json は画面が書く（apps/docs/test/api-key.test.tsx が同じことを確かめる）。
//!
//! 修正の会話（ProjectFolder）: crate の道具で隔離 workspace の文書を直し、ToolUse・ToolResult を契約の形で流す。

use super::*;
use crate::contract::{ClaudeUpdate, Effort};
use crate::secrets::MemoryStore;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::mpsc;

const FAKE_KEY: &str = "sk-ant-fake-LEAKCHECK-0123456789abcdefghijklmnop";
const FAKE_DEEPGRAM_KEY: &str = "dg-fake-LEAKCHECK-9876543210zyxwvutsrqponm";

struct Request {
  method: String,
  target: String,
  headers: Vec<(String, String)>,
  body: Vec<u8>,
}

impl Request {
  fn header(&self, name: &str) -> Option<&str> {
    self
      .headers
      .iter()
      .find(|(key, _)| key.eq_ignore_ascii_case(name))
      .map(|(_, value)| value.as_str())
  }
}

/// 道ごとに決まった返事をする偽の API（1 回ごとに接続を閉じる）。届いた依頼を記録する。
fn fake_api() -> (String, Arc<Mutex<Vec<(String, String, Vec<(String, String)>)>>>) {
  let listener = TcpListener::bind("127.0.0.1:0").unwrap();
  let base = format!("http://{}", listener.local_addr().unwrap());
  let seen = Arc::new(Mutex::new(Vec::new()));
  let record = seen.clone();
  let host = base.clone();
  std::thread::spawn(move || {
    for stream in listener.incoming().flatten() {
      let record = record.clone();
      let host = host.clone();
      std::thread::spawn(move || serve(stream, &host, &record));
    }
  });
  (base, seen)
}

fn read_request(stream: &TcpStream) -> Option<Request> {
  let mut reader = BufReader::new(stream.try_clone().ok()?);
  let mut line = String::new();
  reader.read_line(&mut line).ok()?;
  let mut parts = line.split_whitespace();
  let method = parts.next()?.to_string();
  let target = parts.next()?.to_string();
  let mut headers = Vec::new();
  loop {
    let mut header = String::new();
    if reader.read_line(&mut header).ok()? == 0 || header.trim_end().is_empty() {
      break;
    }
    if let Some((key, value)) = header.trim_end().split_once(':') {
      headers.push((key.trim().to_string(), value.trim().to_string()));
    }
  }
  let length: usize = headers
    .iter()
    .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
    .and_then(|(_, value)| value.parse().ok())
    .unwrap_or(0);
  let mut body = vec![0; length];
  reader.read_exact(&mut body).ok()?;
  Some(Request {
    method,
    target,
    headers,
    body,
  })
}

fn reply(stream: &mut TcpStream, status: u16, headers: &[(&str, String)], body: &str) {
  let mut head = format!(
    "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n",
    body.len()
  );
  for (key, value) in headers {
    head.push_str(&format!("{key}: {value}\r\n"));
  }
  head.push_str("\r\n");
  let _ = stream.write_all(head.as_bytes());
  let _ = stream.write_all(body.as_bytes());
}

fn sse(stream: &mut TcpStream, events: &[Value]) {
  let mut body = String::new();
  for event in events {
    body.push_str(&format!("data: {event}\n\n"));
  }
  let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n");
  let _ = stream.write_all(body.as_bytes());
}

fn serve(mut stream: TcpStream, host: &str, record: &Mutex<Vec<(String, String, Vec<(String, String)>)>>) {
  let Some(request) = read_request(&stream) else { return };
  record
    .lock()
    .unwrap()
    .push((request.method.clone(), request.target.clone(), request.headers.clone()));
  let path = request.target.split('?').next().unwrap_or("").to_string();
  let key_ok = request.header("x-api-key") == Some(FAKE_KEY)
    || request.header("x-goog-api-key") == Some(FAKE_KEY)
    || request.header("authorization") == Some(&format!("Bearer {FAKE_KEY}"))
    || request.header("authorization") == Some(&format!("Token {FAKE_DEEPGRAM_KEY}"))
    || path.starts_with("/upload/v1beta/files") && request.target.contains("upload_id");
  if !key_ok {
    // 本物の API のように、送られた鍵を本文に返す（伏せられることを確かめる）
    let sent = request
      .header("x-api-key")
      .or(request.header("authorization"))
      .unwrap_or("")
      .to_string();
    reply(
      &mut stream,
      401,
      &[("Content-Type", "application/json".into())],
      &json!({ "type": "error", "error": { "type": "authentication_error", "message": format!("invalid x-api-key: {sent}") } })
        .to_string(),
    );
    return;
  }
  let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
  match (request.method.as_str(), path.as_str()) {
    ("GET", "/v1/models") => reply(
      &mut stream,
      200,
      &[],
      &json!({ "data": [{ "id": "claude-sonnet-4-6" }, { "id": "claude-opus-4-8" }] }).to_string(),
    ),
    ("GET", "/v1/projects") => reply(&mut stream, 200, &[], &json!({ "projects": [] }).to_string()),
    // 修正の会話: 1 往復目で読んで直し、2 往復目で返答する
    ("POST", "/v1/messages") if body.get("tools").is_some() => {
      let answered = body["messages"]
        .as_array()
        .map(|messages| {
          messages.iter().any(|message| {
            message["content"]
              .as_array()
              .is_some_and(|blocks| blocks.iter().any(|block| block["type"] == "tool_result"))
          })
        })
        .unwrap_or(false);
      if answered {
        sse(
          &mut stream,
          &[
            json!({"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":700}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"見出しを直しました。"}}),
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}),
            json!({"type":"message_stop"}),
          ],
        );
      } else {
        let edit = json!({ "path": "artifacts/k7m2q9xa.md", "old_text": "## はじめに", "new_text": "## 概要" });
        sse(
          &mut stream,
          &[
            json!({"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":500}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"読んでから直す"}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG"}}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"確かめます。"}}),
            json!({"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_read","name":"read_file","input":{}}}),
            json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"artifacts/k7m2q9xa.md\"}"}}),
            json!({"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"toolu_edit","name":"edit_file","input":{}}}),
            json!({"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":edit.to_string()}}),
            json!({"type":"content_block_start","index":4,"content_block":{"type":"tool_use","id":"toolu_source","name":"read_file","input":{}}}),
            json!({"type":"content_block_delta","index":4,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"artifacts/source.md\"}"}}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":80}}),
            json!({"type":"message_stop"}),
          ],
        );
      }
    }
    ("POST", "/v1/messages") => {
      let continued = body["messages"].as_array().map(|items| items.len()).unwrap_or(0) > 1;
      sse(
        &mut stream,
        &[
          json!({"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":2000}}}),
          json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":if continued { "後半。" } else { "前半" }}}),
          json!({"type":"message_delta","delta":{"stop_reason":if continued { "end_turn" } else { "max_tokens" }},"usage":{"output_tokens":120}}),
          json!({"type":"message_stop"}),
        ],
      );
    }
    ("POST", "/upload/v1beta/files") if request.header("x-goog-upload-command") == Some("start") => reply(
      &mut stream,
      200,
      &[("x-goog-upload-url", format!("{host}/upload/v1beta/files?upload_id=p1"))],
      "",
    ),
    ("POST", "/upload/v1beta/files") => reply(
      &mut stream,
      200,
      &[],
      &json!({ "file": { "name": "files/p1", "uri": format!("{host}/v1beta/files/p1"), "state": "ACTIVE" } }).to_string(),
    ),
    ("DELETE", _) => reply(&mut stream, 200, &[], "{}"),
    ("POST", path) if path.ends_with(":streamGenerateContent") => sse(
      &mut stream,
      &[
        json!({"candidates":[{"content":{"parts":[{"text":"[00:03] 話者0: 朝市に出して三年目です。"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3000,"candidatesTokenCount":30},"modelVersion":"gemini-3.8-flash"}),
      ],
    ),
    ("POST", "/v1/listen") => reply(
      &mut stream,
      200,
      &[],
      &json!({ "metadata": { "duration": 12.0 }, "results": { "channels": [], "utterances": [{ "start": 1.0, "end": 3.0, "speaker": 0, "transcript": "こんにちは" }] } })
        .to_string(),
    ),
    _ => reply(&mut stream, 404, &[], "{}"),
  }
}

struct Harness {
  dir: PathBuf,
  runner: Arc<ApiAiRunner>,
  secrets: Arc<MemoryStore>,
  seen: Arc<Mutex<Vec<(String, String, Vec<(String, String)>)>>>,
}

impl Harness {
  fn new(name: &str) -> Self {
    let dir = std::env::temp_dir().join(format!("niho-docs-api-ai-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("data/workspaces/run-1")).unwrap();
    let (base, seen) = fake_api();
    let secrets = Arc::new(MemoryStore::default());
    let config = api::Config {
      endpoints: api::Endpoints {
        anthropic: base.clone(),
        openai: base.clone(),
        gemini: base.clone(),
        deepgram: base,
      },
      // 本番と同じ書き方の診断ログ（<dir>/logs/local-ai.log）
      log: Some(crate::local_ai::file_log(dir.join("logs"))),
    };
    let runner = Arc::new(ApiAiRunner::new(config, secrets.clone()));
    Self {
      dir,
      runner,
      secrets,
      seen,
    }
  }

  fn turn(&self, provider: Provider, resume: Option<String>, policy: ToolPolicy) -> TurnRequest {
    TurnRequest {
      provider,
      model: match provider {
        Provider::GeminiApi => "gemini-3.8-flash".into(),
        _ => "claude-sonnet-4-6".into(),
      },
      effort: Some(Effort::High),
      system_prompt: "固定の決まり".into(),
      user_prompt: if resume.is_some() {
        "続きを書いてください。".into()
      } else {
        "## 文字起こし\n本文".into()
      },
      resume_session: resume,
      workdir: self.dir.join("data/workspaces/run-1"),
      timeout: Duration::from_secs(20),
      max_budget_usd: None,
      tool_policy: policy,
    }
  }

  /// 1 回流して、画面へ送るのと同じ形（`to_wire`）のイベントを返す。
  fn run(&self, runner: &dyn LlmRunner, request: TurnRequest) -> Vec<Value> {
    let (sender, receiver) = mpsc::channel();
    runner.run_turn(
      request,
      Box::new(move |event| {
        let _ = sender.send(event.to_wire());
      }),
    );
    let mut events = Vec::new();
    while let Ok(event) = receiver.recv_timeout(Duration::from_secs(20)) {
      let terminal = event["type"] == "Done" || event["type"] == "Error";
      events.push(event);
      if terminal {
        break;
      }
    }
    events
  }

  /// dir の下のすべてのファイルの中身に `needle` が無いか。
  fn assert_no_file_contains(&self, needle: &str) {
    fn walk(dir: &Path, needle: &str, checked: &mut usize) {
      for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
          walk(&path, needle, checked);
        } else {
          let bytes = std::fs::read(&path).unwrap();
          *checked += 1;
          assert!(
            !String::from_utf8_lossy(&bytes).contains(needle),
            "鍵が {path:?} に出ている"
          );
        }
      }
    }
    let mut checked = 0;
    walk(&self.dir, needle, &mut checked);
    assert!(checked > 0);
  }
}

impl Drop for Harness {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.dir);
  }
}

/// CLI の側（呼ばれたら記録するだけ）。
#[derive(Default)]
struct RecordingCli {
  calls: Mutex<Vec<Provider>>,
}

impl LlmRunner for RecordingCli {
  fn run_turn(&self, request: TurnRequest, mut on_event: EventSink) -> Arc<dyn TurnHandle> {
    self.calls.lock().unwrap().push(request.provider);
    on_event(TurnEvent::Error {
      reason_code: ReasonCode::CliLoginRequired,
      message: "cli".into(),
    });
    Arc::new(FinishedTurn)
  }
  fn provider_status(&self, _provider: Provider) -> ProviderStatus {
    ProviderStatus {
      login_method: Some("cli".into()),
      ..ProviderStatus::default()
    }
  }
  fn start_auth(&self, _provider: Provider) -> Result<ProviderStatus, MaintenanceError> {
    Ok(ProviderStatus::default())
  }
  fn install_claude(&self) -> Result<ProviderStatus, MaintenanceError> {
    Ok(ProviderStatus::default())
  }
  fn update_claude(&self) -> Result<ClaudeUpdate, MaintenanceError> {
    Err(MaintenanceError::new("x", "x"))
  }
  fn has_running_turns(&self) -> bool {
    false
  }
  fn provider_usage(&self, _provider: Provider) -> Result<ProviderUsage, MaintenanceError> {
    Err(MaintenanceError::new("usage_unavailable", "x"))
  }
  fn shutdown(&self) {}
}

#[test]
fn keys_are_checked_before_saving_and_never_returned() {
  let harness = Harness::new("keys");
  let runner = &harness.runner;
  assert_eq!(
    runner.key_status(api::Account::Anthropic).unwrap(),
    ApiKeyStatus::default()
  );
  // 無効な鍵は保存しない
  let error = runner
    .save_key(api::Account::Anthropic, "sk-ant-wrong-000000000000000000000000")
    .unwrap_err();
  assert_eq!(error.code, "api_key_invalid");
  assert_eq!(error.message, "API キーが無効です。設定 › 接続設定で確かめてください。");
  assert!(!error.message.contains("sk-ant-wrong"));
  assert_eq!(harness.secrets.get(api::Account::Anthropic).unwrap(), None);
  // 形の合わない鍵は呼び出しもしない
  let before = harness.seen.lock().unwrap().len();
  assert_eq!(
    runner.save_key(api::Account::Anthropic, "sk ant").unwrap_err().code,
    "api_key_format"
  );
  assert_eq!(harness.seen.lock().unwrap().len(), before);
  // 正しい鍵（前後の空白は落とす）は 1 回確かめてから保存し、末尾 4 文字だけ返す
  let saved = runner
    .save_key(api::Account::Anthropic, &format!("  {FAKE_KEY}\n"))
    .unwrap();
  assert_eq!(
    (saved.saved, saved.last4.as_deref(), saved.valid),
    (true, Some("mnop"), Some(true))
  );
  assert_eq!(saved.models, vec!["claude-sonnet-4-6", "claude-opus-4-8"]);
  assert_eq!(
    harness.secrets.get(api::Account::Anthropic).unwrap().unwrap().expose(),
    FAKE_KEY
  );
  let wire = serde_json::to_string(&saved).unwrap();
  assert!(!wire.contains(FAKE_KEY), "{wire}");
  let status = runner.key_status(api::Account::Anthropic).unwrap();
  assert_eq!((status.saved, status.valid), (true, None));
  assert!(!serde_json::to_string(&status).unwrap().contains(FAKE_KEY));
  let checked = runner.check_key(api::Account::Anthropic).unwrap();
  assert_eq!(checked.valid, Some(true));
  // 保存済みの鍵が無効になった（別の鍵に差し替えた）とき
  harness
    .secrets
    .set(
      api::Account::Anthropic,
      &api::Secret::new("sk-ant-revoked-00000000000000000000"),
    )
    .unwrap();
  let revoked = runner.check_key(api::Account::Anthropic).unwrap();
  assert_eq!(
    (revoked.saved, revoked.valid, revoked.reason.as_deref()),
    (true, Some(false), Some("api_key_invalid"))
  );
  assert_eq!(
    revoked.message.as_deref(),
    Some("API キーが無効です。設定 › 接続設定で確かめてください。")
  );
  assert_eq!(
    runner.delete_key(api::Account::Anthropic).unwrap(),
    ApiKeyStatus::default()
  );
  assert_eq!(runner.key_status(api::Account::Anthropic).unwrap().saved, false);
  // Deepgram はプロジェクトの一覧で確かめる
  let deepgram = runner.save_key(api::Account::Deepgram, FAKE_DEEPGRAM_KEY).unwrap();
  assert!(deepgram.saved && deepgram.models.is_empty());
  assert!(harness
    .seen
    .lock()
    .unwrap()
    .iter()
    .any(|(_, target, _)| target == "/v1/projects"));
}

#[test]
fn the_router_sends_api_providers_to_the_api_and_clis_to_the_cli() {
  let harness = Harness::new("router");
  let cli = Arc::new(RecordingCli::default());
  let router = ProviderRouter {
    local: cli.clone(),
    api: harness.runner.clone(),
  };
  // 鍵が無い → NotConfigured（CLI へ回さない＝自動で別の方式にしない）
  let events = harness.run(&router, harness.turn(Provider::AnthropicApi, None, ToolPolicy::None));
  assert_eq!(events.last().unwrap()["reason_code"], json!("NotConfigured"));
  assert_eq!(
    events.last().unwrap()["message"],
    json!("Anthropic の API キーが保存されていません。設定 › 接続設定で API キーを保存してください。")
  );
  assert!(cli.calls.lock().unwrap().is_empty());
  // 無効な鍵 → ログインの代わりの文（CliLoginRequired）
  harness
    .secrets
    .set(
      api::Account::Anthropic,
      &api::Secret::new("sk-ant-wrong-111111111111111111111111"),
    )
    .unwrap();
  let events = harness.run(&router, harness.turn(Provider::AnthropicApi, None, ToolPolicy::None));
  assert_eq!(events.last().unwrap()["reason_code"], json!("CliLoginRequired"));
  assert_eq!(
    events.last().unwrap()["message"],
    json!("API キーが無効です。設定 › 接続設定で確かめてください。")
  );
  // CLI の提供元は CLI へ
  let events = harness.run(&router, harness.turn(Provider::ClaudeCode, None, ToolPolicy::None));
  assert_eq!(events.last().unwrap()["message"], json!("cli"));
  assert_eq!(*cli.calls.lock().unwrap(), vec![Provider::ClaudeCode]);
  // 状態: API は鍵の有無だけ（呼び出さない）、CLI は CLI
  let status = router.provider_status(Provider::OpenAiApi);
  assert_eq!(
    (status.installed, status.authenticated, status.reason.as_deref()),
    (true, false, Some("api_key_missing"))
  );
  assert!(status.capabilities.resume);
  assert_eq!(
    router.provider_status(Provider::CodexCli).login_method.as_deref(),
    Some("cli")
  );
  assert_eq!(
    router.start_auth(Provider::GeminiApi).unwrap_err().code,
    "auth_unsupported"
  );
}

#[test]
fn chats_edit_the_isolated_workspace_with_the_folder_tools() {
  let harness = Harness::new("chat");
  harness
    .secrets
    .set(api::Account::Anthropic, &api::Secret::new(FAKE_KEY))
    .unwrap();
  let router = ProviderRouter {
    local: Arc::new(RecordingCli::default()),
    api: harness.runner.clone(),
  };
  let workspace = harness.dir.join("data/chat-workspace");
  std::fs::create_dir_all(workspace.join("artifacts")).unwrap();
  std::fs::write(workspace.join("artifacts/k7m2q9xa.md"), "# 議事録\n\n## はじめに\n").unwrap();
  // 文書に鍵が貼られていても、画面・履歴・ログへ出さない
  std::fs::write(workspace.join("artifacts/source.md"), format!("メモ {FAKE_KEY}")).unwrap();
  let mut request = harness.turn(
    Provider::AnthropicApi,
    None,
    ToolPolicy::ProjectFolder {
      dir: workspace.clone(),
      writable: vec!["artifacts".into()],
      web_search: true,
    },
  );
  request.user_prompt = "「はじめに」を「概要」に直してください。".into();
  let events = harness.run(&router, request);
  let kinds: Vec<&str> = events.iter().map(|event| event["type"].as_str().unwrap()).collect();
  assert_eq!(
    kinds,
    vec![
      "ThinkingDelta",
      "TextDelta",
      "ToolUse",
      "ToolResult",
      "ToolUse",
      "ToolResult",
      "ToolUse",
      "ToolResult",
      "TextDelta",
      "Done"
    ]
  );
  assert_eq!(
    events[2],
    json!({ "type": "ToolUse", "id": "toolu_read", "name": "Read", "summary": "k7m2q9xa.md" })
  );
  assert_eq!(
    events[5],
    json!({ "type": "ToolResult", "id": "toolu_edit", "name": "Edit", "ok": true })
  );
  let done = events.last().unwrap();
  assert_eq!(done["text"], json!("見出しを直しました。"));
  assert_eq!(done["stop_reason"], json!("EndTurn"));
  assert_eq!(
    (
      done["usage"]["input_tokens"].clone(),
      done["usage"]["output_tokens"].clone()
    ),
    (json!(1200), json!(100))
  );
  assert!(done["session_id"].is_string());
  assert_eq!(
    std::fs::read_to_string(workspace.join("artifacts/k7m2q9xa.md")).unwrap(),
    "# 議事録\n\n## 概要\n"
  );
  // 履歴は workdir（会話の履歴の置き場）に残り、workspace には書かない
  assert!(std::fs::read_dir(harness.dir.join("data/workspaces/run-1"))
    .unwrap()
    .flatten()
    .any(|entry| entry.file_name().to_string_lossy().starts_with("api-session-")));
  assert_eq!(std::fs::read_dir(workspace.join("artifacts")).unwrap().count(), 2);
  assert!(!serde_json::to_string(&events).unwrap().contains(FAKE_KEY));
  let log = std::fs::read_to_string(harness.dir.join("logs/local-ai.log")).unwrap();
  assert!(log.contains("api_tool"));
  assert!(!log.contains(FAKE_KEY));
  for entry in std::fs::read_dir(harness.dir.join("data/workspaces/run-1"))
    .unwrap()
    .flatten()
  {
    assert!(!std::fs::read_to_string(entry.path())
      .unwrap_or_default()
      .contains(FAKE_KEY));
  }
}

#[test]
fn steps_audio_parts_and_deepgram_run_without_the_key_leaving_the_keychain() {
  let harness = Harness::new("leak");
  harness
    .secrets
    .set(api::Account::Anthropic, &api::Secret::new(FAKE_KEY))
    .unwrap();
  harness
    .secrets
    .set(api::Account::Gemini, &api::Secret::new(FAKE_KEY))
    .unwrap();
  harness
    .secrets
    .set(api::Account::Deepgram, &api::Secret::new(FAKE_DEEPGRAM_KEY))
    .unwrap();
  let router = ProviderRouter {
    local: Arc::new(RecordingCli::default()),
    api: harness.runner.clone(),
  };
  // 工程: 上限で止まる → 同じ会話で続き
  let first = harness.run(&router, harness.turn(Provider::AnthropicApi, None, ToolPolicy::None));
  let done = first.last().unwrap();
  assert_eq!(done["type"], json!("Done"));
  assert_eq!(done["stop_reason"], json!("MaxTokens"));
  assert_eq!(done["continuations"], json!(0));
  assert_eq!(
    done["usage"],
    json!({ "input_tokens": 2000, "output_tokens": 120, "cost_usd": null, "model_used": "claude-sonnet-4-6", "cost_known": false })
  );
  let session = done["session_id"].as_str().unwrap().to_string();
  let second = harness.run(
    &router,
    harness.turn(Provider::AnthropicApi, Some(session), ToolPolicy::None),
  );
  assert_eq!(second.last().unwrap()["stop_reason"], json!("EndTurn"));
  assert_eq!(second.last().unwrap()["text"], json!("後半。"));
  // Gemini の区切り（区切りの WAV を Files API に上げて添える）
  let wav = harness.dir.join("data/speech-parts-f0-p0.wav");
  std::fs::write(&wav, b"RIFF-fake").unwrap();
  let part = harness.run(
    &router,
    harness.turn(Provider::GeminiApi, None, ToolPolicy::ReadFile { file: wav }),
  );
  assert_eq!(
    part.last().unwrap()["text"],
    json!("[00:03] 話者0: 朝市に出して三年目です。")
  );
  // Deepgram
  let audio = harness.dir.join("data/a1.m4a");
  std::fs::write(&audio, b"fake").unwrap();
  let result = harness
    .runner
    .transcribe_deepgram(
      &audio,
      &api::DeepgramRequest {
        language: "ja".into(),
        diarize: true,
        keyterms: vec!["NIHO鎌倉".into()],
      },
      &api::StopSignal::new(),
    )
    .unwrap()
    .unwrap();
  assert_eq!(result.utterances.len(), 1);
  // 提供元が鍵を本文に返す失敗（鍵を差し替えて 401 にする）
  harness
    .secrets
    .set(
      api::Account::Anthropic,
      &api::Secret::new("sk-ant-echoed-ABCDEFGHIJ0123456789xyz"),
    )
    .unwrap();
  let failed = harness.run(&router, harness.turn(Provider::AnthropicApi, None, ToolPolicy::None));
  let wire = serde_json::to_string(&failed).unwrap();
  assert!(!wire.contains("sk-ant-echoed-ABCDEFGHIJ0123456789xyz"), "{wire}");

  // 画面へ送ったイベント・診断ログ・app data（会話の履歴を含む）に鍵が無い
  for events in [&first, &second, &part] {
    let wire = serde_json::to_string(events).unwrap();
    assert!(!wire.contains(FAKE_KEY) && !wire.contains(FAKE_DEEPGRAM_KEY));
  }
  let log = std::fs::read_to_string(harness.dir.join("logs/local-ai.log")).unwrap();
  assert!(log.contains("api_turn_ended") && log.contains("deepgram_done") && log.contains("gemini_file_deleted"));
  assert!(log.contains("authentication_error"), "失敗の要旨は残る");
  for key in [FAKE_KEY, FAKE_DEEPGRAM_KEY, "sk-ant-echoed-ABCDEFGHIJ0123456789xyz"] {
    harness.assert_no_file_contains(key);
  }
  // 会話の履歴は workspace に残る（続きに使う。鍵は無い）
  assert!(std::fs::read_dir(harness.dir.join("data/workspaces/run-1"))
    .unwrap()
    .flatten()
    .any(|entry| entry.file_name().to_string_lossy().starts_with("api-session-")));
  // 鍵はヘッダーだけで、URL には無い
  for (_, target, _) in harness.seen.lock().unwrap().iter() {
    assert!(
      !target.contains(FAKE_KEY) && !target.contains(FAKE_DEEPGRAM_KEY),
      "{target}"
    );
  }
}

/// 以前の版が Keychain に置いた鍵を移せなかった（確認の拒否。#18769）保存先。
struct Reenter;

impl SecretStore for Reenter {
  fn get(&self, _account: api::Account) -> Result<Option<api::Secret>, SecretError> {
    Err(REENTER)
  }
  fn set(&self, _account: api::Account, _secret: &api::Secret) -> Result<(), SecretError> {
    Ok(())
  }
  fn delete(&self, _account: api::Account) -> Result<(), SecretError> {
    Ok(())
  }
}

#[test]
fn a_key_the_old_version_could_not_hand_over_asks_to_be_entered_again() {
  let harness = Harness::new("reenter");
  let api = Arc::new(ApiAiRunner::new(
    api::Config {
      endpoints: api::Endpoints::default(),
      log: None,
    },
    Arc::new(Reenter),
  ));
  // 設定の行: 未設定として入力欄を出し、入れ直しを案内する（「読めません」で止めない）
  assert_eq!(
    api.key_status(api::Account::Gemini).unwrap(),
    ApiKeyStatus {
      reason: Some("api_key_reenter".into()),
      message: Some(REENTER.message.into()),
      ..ApiKeyStatus::default()
    }
  );
  assert!(!api.status(Provider::GeminiApi).authenticated);
  // 工程の実行: 黙って「未設定」にせず、入れ直しを案内する
  let router = ProviderRouter {
    local: Arc::new(RecordingCli::default()),
    api,
  };
  let events = harness.run(&router, harness.turn(Provider::GeminiApi, None, ToolPolicy::None));
  assert_eq!(events.last().unwrap()["reason_code"], json!("NotConfigured"));
  assert_eq!(events.last().unwrap()["message"], json!(REENTER.message));
}
