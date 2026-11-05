//! このMacの CLI の状態（入っているか・版・ログイン・必要なフラグ）。
//! Desktop の build_claude_setup_status と get_article_agent_capabilities の写しを 3 つの CLI に広げたもの。

use crate::classify::is_agy_login_required;
use crate::codex::DISABLED_FEATURES;
use crate::process::{run_capture, CaptureError, Captured};
use crate::runtime::{provider_command, resolve_cli, Runtime};
use crate::turn::is_valid_model;
use crate::types::{Provider, ProviderStatus};
use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

/// `--version`・`--help`・`auth status`・`agy models` の上限（CLI が止まっても状態の確認を待ち続けない）。
const STATUS_TIME_LIMIT: Duration = Duration::from_secs(20);
const STATUS_KILL_GRACE: Duration = Duration::from_millis(500);
const STATUS_OUTPUT_MAX_BYTES: usize = 256 * 1024;
/// `codex debug models` の出力の上限。カタログはモデルごとの長い指示・説明を含み、0.163.0 では約 630 KiB あった
/// （2026-11-05。STATUS_OUTPUT_MAX_BYTES では末尾だけが残って JSON が読めず、一覧が空になり、画面が古い控えの一覧に戻っていた）。
const CODEX_MODELS_OUTPUT_MAX_BYTES: usize = 8 * 1024 * 1024;

/// `claude --help` で確かめるフラグ。`--system-prompt-file` と `--thinking-display` は Claude Code が `--help` から
/// 隠している（Desktop #15707・#16748）ので含めない（含めると絶対に検出できない）。
pub(crate) const CLAUDE_REQUIRED_FLAGS: [&str; 14] = [
  "--output-format",
  "--verbose",
  "--include-partial-messages",
  "--setting-sources",
  "--strict-mcp-config",
  "--restricted",
  "--tools",
  "--disable-slash-commands",
  "--permission-mode",
  "--model",
  "--effort",
  "--session-id",
  "--resume",
  "--max-budget-usd",
];
/// `codex exec --help` で確かめるフラグ（`-c` は `--config` の短い形）。
pub(crate) const CODEX_REQUIRED_FLAGS: [&str; 7] = [
  "--json",
  "--sandbox",
  "--skip-git-repo-check",
  "--ignore-user-config",
  "--ignore-rules",
  "--disable",
  "--config",
];
/// `agy --help` で確かめるフラグ（起動に使うもの全部）。
pub(crate) const AGY_REQUIRED_FLAGS: [&str; 8] = [
  "--agent",
  "--conversation",
  "--input-format",
  "--output-format",
  "--model",
  "--effort",
  "--disable-slash-commands",
  "--print-timeout",
];

pub(crate) fn required_flags(provider: Provider) -> &'static [&'static str] {
  match provider {
    Provider::ClaudeCode => &CLAUDE_REQUIRED_FLAGS,
    Provider::CodexCli => &CODEX_REQUIRED_FLAGS,
    Provider::GeminiCli => &AGY_REQUIRED_FLAGS,
  }
}

fn help_args(provider: Provider) -> &'static [&'static str] {
  match provider {
    Provider::ClaudeCode | Provider::GeminiCli => &["--help"],
    Provider::CodexCli => &["exec", "--help"],
  }
}

/// `--help` の文に無い必要なフラグ（`--flag=<値>`・`-c, --config` の形も拾う）。
pub(crate) fn missing_cli_flags(help_text: &str, required: &[&str]) -> Vec<String> {
  let words: HashSet<&str> = help_text
    .split(|ch: char| ch.is_whitespace() || matches!(ch, ',' | '[' | ']' | '(' | ')'))
    .map(|word| word.split('=').next().unwrap_or(word))
    .collect();
  required
    .iter()
    .copied()
    .filter(|flag| !words.contains(flag))
    .map(str::to_string)
    .collect()
}

/// `codex features list` に無い、crate が `--disable=` で切る機能（`--disable=<名前>` の形）。古い codex は知らない機能名を
/// 「Unknown feature flag」で断って起動しないが、`exec --help` にはフラグがそろって見えるので、ここで古い版と分かるようにする。
/// 一覧の行は「名前 段階 有効」で、先頭の語だけを見る。一覧を取れなければ空（ほかの確かめに任せる）。
pub(crate) fn unknown_codex_features(features_list: &str) -> Vec<String> {
  let known: HashSet<&str> = features_list
    .lines()
    .filter_map(|line| line.split_whitespace().next())
    .collect();
  if known.is_empty() {
    return Vec::new();
  }
  DISABLED_FEATURES
    .iter()
    .filter(|feature| !known.contains(*feature))
    .map(|feature| format!("--disable={feature}"))
    .collect()
}

fn run_cli(runtime: &Runtime, provider: Provider, cli: &Path, args: &[&str]) -> Result<Captured, CaptureError> {
  run_cli_capped(runtime, provider, cli, args, STATUS_OUTPUT_MAX_BYTES)
}

/// 出力の上限を決めて CLI を動かす（出力は末尾 `max_bytes` だけ残る）。
fn run_cli_capped(
  runtime: &Runtime,
  provider: Provider,
  cli: &Path,
  args: &[&str],
  max_bytes: usize,
) -> Result<Captured, CaptureError> {
  let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
  run_capture(
    provider_command(runtime, provider, cli, &args, &[]),
    STATUS_TIME_LIMIT,
    STATUS_KILL_GRACE,
    max_bytes,
  )
}

fn first_line(bytes: &[u8]) -> Option<String> {
  String::from_utf8_lossy(bytes)
    .lines()
    .map(str::trim)
    .find(|line| !line.is_empty())
    .map(str::to_string)
}

fn combined_output(output: &Captured) -> String {
  format!(
    "{}\n{}",
    String::from_utf8_lossy(&output.stdout),
    String::from_utf8_lossy(&output.stderr)
  )
}

/// `claude auth status --text` の「Login method: Claude Max account」。
pub(crate) fn parse_claude_login_method(text: &str) -> Option<String> {
  text.lines().find_map(|line| {
    let line = line.trim();
    let (label, value) = line.split_once(':')?;
    (label.trim().eq_ignore_ascii_case("login method") && !value.trim().is_empty()).then(|| value.trim().to_string())
  })
}

/// `codex login status` の「Logged in using ChatGPT」。API キーの断片（"- sk-…"）は持ち出さない。
pub(crate) fn parse_codex_login_method(text: &str) -> Option<String> {
  const PREFIX: &str = "logged in using ";
  text.lines().find_map(|line| {
    let line = line.trim();
    let start = line.to_ascii_lowercase().find(PREFIX)? + PREFIX.len();
    let rest = &line[start..];
    let rest = rest.split(" - ").next().unwrap_or(rest).trim().trim_end_matches('.');
    let rest = rest
      .strip_prefix("an ")
      .or_else(|| rest.strip_prefix("a "))
      .unwrap_or(rest)
      .trim();
    (!rest.is_empty()).then(|| rest.to_string())
  })
}

/// `codex debug models` の JSON（`{"models":[{"slug":…,"visibility":"list"|"hide",…}]}`）から、一覧に出すモデル
/// （visibility が list）の slug を出た順に取る。アカウントで使えるモデルが違うので、設定のモデルの選択肢に使う
/// （ログイン後は codex がアカウントの一覧を取り直す）。読めなければ空。
pub(crate) fn parse_codex_models(text: &str) -> Vec<String> {
  let Ok(value) = serde_json::from_str::<serde_json::Value>(text.trim()) else {
    return Vec::new();
  };
  let mut models: Vec<String> = Vec::new();
  for model in value
    .get("models")
    .and_then(serde_json::Value::as_array)
    .into_iter()
    .flatten()
  {
    let listed = model.get("visibility").and_then(serde_json::Value::as_str) == Some("list");
    let Some(slug) = model.get("slug").and_then(serde_json::Value::as_str) else {
      continue;
    };
    if listed && is_valid_model(slug) && !models.iter().any(|known| known == slug) {
      models.push(slug.to_string());
    }
  }
  models
}

/// `agy models` の出力（`<モデル ID>\t<表示名>` が 1 行ずつ）から、1 列目のモデル ID を出た順に取る。
/// 「Fetching available models...」の行と、`--model` に渡せない形（`is_valid_model` に合わないもの）は飛ばす。
pub(crate) fn parse_agy_models(text: &str) -> Vec<String> {
  let mut models: Vec<String> = Vec::new();
  for line in text.lines() {
    let line = line.trim();
    if line.is_empty() || line.to_ascii_lowercase().starts_with("fetching") {
      continue;
    }
    let id = line.split('\t').next().unwrap_or(line).trim();
    if is_valid_model(id) && !models.iter().any(|model| model == id) {
      models.push(id.to_string());
    }
  }
  models
}

/// 既定の実行環境で CLI の状態を確かめる。[`provider_status_with`] を見る。
pub fn provider_status(provider: Provider) -> ProviderStatus {
  provider_status_with(&Runtime::default(), provider)
}

/// CLI の状態を確かめる（`--version` → `--help` の必要なフラグ → ログイン）。使えないときは `reason` に理由を入れる。
/// 理由の順は Desktop と同じ（入っていない → ログイン → フラグ）。
pub fn provider_status_with(runtime: &Runtime, provider: Provider) -> ProviderStatus {
  let mut status = ProviderStatus {
    provider,
    installed: false,
    authenticated: false,
    version: None,
    cli_path: None,
    login_method: None,
    reason: None,
    missing_cli_flags: Vec::new(),
    capabilities: provider.capabilities(),
    models: Vec::new(),
  };
  let Some(cli) = resolve_cli(runtime, provider) else {
    status.reason = Some("cli_not_found".to_string());
    return status;
  };
  status.cli_path = Some(cli.to_string_lossy().into_owned());
  match run_cli(runtime, provider, &cli, &["--version"]) {
    Ok(output) if output.status.success() => status.version = first_line(&output.stdout),
    Err(CaptureError::Spawn(_)) => {
      status.reason = Some("cli_not_found".to_string());
      return status;
    }
    Ok(_) | Err(_) => {
      status.reason = Some("cli_version_failed".to_string());
      return status;
    }
  }
  status.installed = true;
  status.missing_cli_flags = match run_cli(runtime, provider, &cli, help_args(provider)) {
    Ok(output) => missing_cli_flags(&combined_output(&output), required_flags(provider)),
    Err(_) => required_flags(provider).iter().map(|flag| flag.to_string()).collect(),
  };
  if provider == Provider::CodexCli {
    if let Ok(output) = run_cli(runtime, provider, &cli, &["features", "list"]) {
      if output.status.success() {
        status
          .missing_cli_flags
          .extend(unknown_codex_features(&String::from_utf8_lossy(&output.stdout)));
      }
    }
  }
  let auth_reason = match provider {
    Provider::ClaudeCode | Provider::CodexCli => {
      let args: &[&str] = if provider == Provider::ClaudeCode {
        &["auth", "status", "--text"]
      } else {
        &["login", "status"]
      };
      match run_cli(runtime, provider, &cli, args) {
        Ok(output) if output.status.success() => {
          status.authenticated = true;
          let text = combined_output(&output);
          status.login_method = if provider == Provider::ClaudeCode {
            parse_claude_login_method(&text)
          } else {
            parse_codex_login_method(&text)
          };
          if provider == Provider::CodexCli {
            // 使えるモデルの一覧（取れなければ空。画面は控えの一覧を出す）
            status.models = match run_cli_capped(
              runtime,
              provider,
              &cli,
              &["debug", "models"],
              CODEX_MODELS_OUTPUT_MAX_BYTES,
            ) {
              Ok(output) if output.status.success() => parse_codex_models(&String::from_utf8_lossy(&output.stdout)),
              _ => Vec::new(),
            };
          }
          None
        }
        Ok(_) => Some("auth_required"),
        Err(_) => Some("auth_probe_failed"),
      }
    }
    // ログインは `agy models` で確かめる。ログインしていないと（端末が無ければ待たずに）authentication required で
    // 終わるので、成功したらログイン済みとし、使えるモデルの ID も取る。それ以外の失敗は確かめられなかったとする
    // （login_method は返さない）
    Provider::GeminiCli => match run_cli(runtime, provider, &cli, &["models"]) {
      Ok(output) if output.status.success() => {
        status.authenticated = true;
        status.models = parse_agy_models(&String::from_utf8_lossy(&output.stdout));
        None
      }
      Ok(output) if is_agy_login_required(&combined_output(&output)) => Some("auth_required"),
      Ok(_) | Err(_) => Some("auth_probe_failed"),
    },
  };
  status.reason = auth_reason
    .map(str::to_string)
    .or_else(|| (!status.missing_cli_flags.is_empty()).then(|| "cli_flags_missing".to_string()));
  status
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn codex_features_unknown_to_an_old_cli_are_reported_as_missing_flags() {
    // 0.151.0 の `codex features list` には sleep_tool などが無い（`--disable=sleep_tool` で起動しない）
    let all: String = DISABLED_FEATURES
      .iter()
      .map(|feature| format!("{feature:<40} stable             true\n"))
      .collect();
    assert!(unknown_codex_features(&all).is_empty());
    let old: String = DISABLED_FEATURES
      .iter()
      .filter(|feature| **feature != "sleep_tool" && **feature != "goals")
      .map(|feature| format!("{feature:<40} under development  false\n"))
      .collect();
    let mut missing = unknown_codex_features(&old);
    missing.sort();
    assert_eq!(missing, vec!["--disable=goals", "--disable=sleep_tool"]);
    // 一覧が取れない（空）ときは決めつけない
    assert!(unknown_codex_features("").is_empty());
  }

  #[test]
  fn missing_flags_are_read_from_help_text() {
    let help = "Usage: claude [options]\n  -p, --print\n  --output-format <format>\n  --verbose\n  --include-partial-messages\n  --setting-sources <sources>\n  --strict-mcp-config\n  --restricted\n  --tools <tools...>\n  --disable-slash-commands\n  --permission-mode <mode>\n  --model <model>\n  --session-id <uuid>\n  -r, --resume [value]\n  --max-budget-usd <amount>";
    assert_eq!(
      missing_cli_flags(help, &CLAUDE_REQUIRED_FLAGS),
      vec!["--effort".to_string()]
    );
    let codex = "Options:\n  -c, --config <key=value>\n  --enable <FEATURE>\n  --disable <FEATURE>\n  -s, --sandbox <SANDBOX_MODE>\n  --skip-git-repo-check\n  --ignore-user-config\n  --ignore-rules\n  --json";
    assert!(missing_cli_flags(codex, &CODEX_REQUIRED_FLAGS).is_empty());
    assert_eq!(
      missing_cli_flags("--output-format=json", &["--output-format"]),
      Vec::<String>::new()
    );
    assert_eq!(missing_cli_flags("", &AGY_REQUIRED_FLAGS).len(), 8);
    let agy = "Flags:\n      --agent string\n      --conversation string\n      --disable-slash-commands\n      --effort string\n      --input-format string\n      --model string\n      --output-format string\n  -p, --print string\n      --print-timeout duration";
    assert!(missing_cli_flags(agy, &AGY_REQUIRED_FLAGS).is_empty());
    // `--print` があっても `--print-timeout` の代わりにはならない
    assert_eq!(
      missing_cli_flags("--print string\n--agent", &["--print-timeout", "--agent"]),
      vec!["--print-timeout".to_string()]
    );
  }

  #[test]
  fn login_methods_are_parsed_without_secrets() {
    assert_eq!(
      parse_claude_login_method("Login method: Claude Max account\nOrganization: x").as_deref(),
      Some("Claude Max account")
    );
    assert_eq!(parse_claude_login_method("Email: a@example.com"), None);
    assert_eq!(
      parse_codex_login_method("Logged in using ChatGPT").as_deref(),
      Some("ChatGPT")
    );
    assert_eq!(
      parse_codex_login_method("Logged in using an API key - sk-proj-***ABCDE").as_deref(),
      Some("API key")
    );
    assert_eq!(parse_codex_login_method("Not logged in"), None);
  }

  #[test]
  fn codex_models_are_the_listed_slugs_of_the_catalog() {
    let catalog = r#"{"models":[
      {"slug":"gpt-6-astra","visibility":"list","supported_reasoning_levels":[{"effort":"low"}]},
      {"slug":"gpt-reserve","visibility":"hide"},
      {"slug":"gpt-5.6-sol","visibility":"list"},
      {"slug":"gpt-5.6-sol","visibility":"list"},
      {"slug":"-bad","visibility":"list"},
      {"visibility":"list"},
      {"slug":"codex-auto-review","visibility":"hide"}
    ]}"#;
    assert_eq!(
      parse_codex_models(catalog),
      ["gpt-6-astra", "gpt-5.6-sol"].map(String::from)
    );
    assert!(parse_codex_models("not json").is_empty());
    assert!(parse_codex_models("{}").is_empty());
  }

  #[test]
  fn agy_models_are_the_first_tab_separated_column() {
    let output = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n\nclaude-sonnet-4-6\tClaude Sonnet 4.6\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n";
    assert_eq!(
      parse_agy_models(output),
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
    // タブの無い行は行全体を ID として見て、`--model` に渡せない形・重複・Fetching の行は飛ばす
    assert_eq!(
      parse_agy_models(
        "FETCHING models\nAvailable models:\ngemini-3.8-flash-low\ngemini-3.8-flash-low\tdup\n\t\n-x\tbad"
      ),
      vec!["gemini-3.8-flash-low".to_string()]
    );
    assert!(parse_agy_models("").is_empty());
  }
}
