//! `generate_handler!` に登録したコマンドと ACL（`permissions/`・`capabilities/`）の突き合わせ。
//! アプリが自前の permission を持つと、Tauri 2 は app コマンドも ACL で判定し、許可の無いコマンドは実行前に拒否する。
//! 登録だけして permission・capability へ足し忘れると、画面から呼べない（NIHO Desktop の command_acl_tests.rs と同じ考え）。

use std::collections::BTreeSet;

fn registered_commands() -> BTreeSet<String> {
  const HANDLER: &str = "tauri::generate_handler![";
  let source = include_str!("lib.rs");
  let start = source.find(HANDLER).expect("generate_handler! が無い") + HANDLER.len();
  let end = start + source[start..].find(']').expect("generate_handler! の閉じ括弧が無い");
  source[start..end]
    .split(',')
    .map(|entry| entry.trim().rsplit("::").next().unwrap_or("").to_string())
    .filter(|name| !name.is_empty())
    .collect()
}

/// permissions/docs.toml の identifier → commands.allow。
fn permissions() -> Vec<(String, BTreeSet<String>)> {
  let source = include_str!("../permissions/docs.toml");
  let mut result = Vec::new();
  let mut identifier: Option<String> = None;
  for line in source.lines() {
    let line = line.trim();
    if let Some(value) = line.strip_prefix("identifier = ") {
      identifier = Some(value.trim_matches('"').to_string());
    }
    if let Some(value) = line.strip_prefix("commands.allow = ") {
      let commands = value
        .trim_matches(|ch| ch == '[' || ch == ']')
        .split(',')
        .map(|name| name.trim().trim_matches('"').to_string())
        .filter(|name| !name.is_empty())
        .collect();
      result.push((
        identifier.take().expect("identifier の後に commands.allow を書く"),
        commands,
      ));
    }
  }
  result
}

#[test]
fn every_registered_command_is_allowed_by_the_main_window_capability() {
  let capability: serde_json::Value =
    serde_json::from_str(include_str!("../capabilities/default.json")).expect("capabilities/default.json");
  assert_eq!(capability["windows"], serde_json::json!(["main"]));
  let granted: BTreeSet<String> = capability["permissions"]
    .as_array()
    .expect("permissions")
    .iter()
    .filter_map(|value| value.as_str().map(str::to_string))
    .collect();
  let mut allowed = BTreeSet::new();
  for (identifier, commands) in permissions() {
    assert!(
      granted.contains(&identifier),
      "{identifier} が capabilities/default.json に無い"
    );
    allowed.extend(commands);
  }
  let registered = registered_commands();
  assert!(
    registered.contains("run_turn") && registered.contains("transcribe"),
    "{registered:?}"
  );
  assert_eq!(registered, allowed, "登録したコマンドと permission の許可が食い違う");
}

/// capability の JSON を読む。
fn capability(source: &str) -> serde_json::Value {
  serde_json::from_str(source).expect("capability の JSON")
}

fn granted(capability: &serde_json::Value) -> BTreeSet<String> {
  capability["permissions"]
    .as_array()
    .expect("permissions")
    .iter()
    .filter_map(|value| value.as_str().map(str::to_string))
    .collect()
}

/// その capability が許す permission から届くコマンド（permissions/docs.toml で引く）。
fn reachable_commands(capability: &serde_json::Value) -> BTreeSet<String> {
  let granted = granted(capability);
  permissions()
    .into_iter()
    .filter(|(identifier, _)| granted.contains(identifier))
    .flat_map(|(_, commands)| commands)
    .collect()
}

/// 殻（remote）から届いてよいコマンド。**全部 `shell_` で始まり、id だけでやり取りする。** ここに足すときは、
/// パス・引数・環境・CLI の場所を画面から受け取らないこと（設計 §13）。
fn shell_commands() -> BTreeSet<String> {
  [
    "shell_capabilities",
    "shell_mic_status",
    "shell_recording_start",
    "shell_recording_stop",
    "shell_recording_discard",
    "shell_recording_read",
    "shell_audio_pick",
    "shell_audio_read",
    "shell_staging_discard",
    "shell_transcribe_local",
    "shell_transcribe_stop",
    "shell_ai_engines",
    "shell_ai_turn",
    "shell_ai_stop",
  ]
  .into_iter()
  .map(String::from)
  .collect()
}

/// Mac の殻（設計 §13）: editor.niho.life から呼べるのは端末の力だけ。保管庫・設定・鍵・CLI の起動には届かない。
#[test]
fn the_remote_editor_capability_reaches_only_the_shell_commands() {
  let remote = capability(include_str!("../capabilities/remote-editor.json"));
  assert_eq!(remote["windows"], serde_json::json!(["main"]));
  assert_eq!(
    remote["remote"]["urls"],
    serde_json::json!(["https://editor.niho.life"])
  );
  // 端末の力の permission だけ。core のイベント購読（アプリ全体の event を remote が聞ける）も許さない
  assert_eq!(
    granted(&remote),
    BTreeSet::from(["allow-editor-shell".to_string()]),
    "remote の capability に端末の力以外の permission がある"
  );
  let reachable = reachable_commands(&remote);
  assert_eq!(reachable, shell_commands());
  assert!(reachable.iter().all(|name| name.starts_with("shell_")), "{reachable:?}");
  // 保管庫・会話・鍵・本人実行・保存先のコマンドは、1 つも remote から届かない
  for forbidden in [
    "load_pages",
    "write_page",
    "read_page",
    "run_turn",
    "run_chat_turn",
    "stop_turn",
    "provider_status",
    "save_api_key",
    "personal_open",
    "cloud_state",
    "load_settings",
  ] {
    assert!(!reachable.contains(forbidden), "{forbidden} が remote から届く");
  }
}

/// 開発の localhost は別の capability で、配布物の tauri.conf.json には入らない。
#[test]
fn the_dev_editor_capability_is_not_shipped() {
  let dev = capability(include_str!("../capabilities/remote-editor-dev.json"));
  assert_eq!(dev["remote"]["urls"], serde_json::json!(["http://localhost:3000"]));
  assert_eq!(granted(&dev), BTreeSet::from(["allow-editor-shell".to_string()]));
  assert_eq!(reachable_commands(&dev), shell_commands());
  let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
  assert_eq!(
    conf["app"]["security"]["capabilities"],
    serde_json::json!(["default", "remote-editor"])
  );
  let dev_conf: serde_json::Value =
    serde_json::from_str(include_str!("../tauri.dev.conf.json")).expect("tauri.dev.conf.json");
  assert_eq!(
    dev_conf["app"]["security"]["capabilities"],
    serde_json::json!(["default", "remote-editor", "remote-editor-dev"])
  );
}
