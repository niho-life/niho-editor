//! 自動更新（S4 #18385。NIHO Desktop の「更新して再起動」#16415 と同じ作法）。
//!
//! - 起動時と、その後は 1 時間ごとに `plugins.updater.endpoints`（このリポジトリの最新公開 Release にある `latest.json`）を見て、新しい版があれば
//!   取得して署名（`plugins.updater.pubkey`）を確かめ、手元に持つ。取得したら確認をやめる（開いたままの窓でも、起動後に出た版を拾う）。
//! - `.app` は動いている間は差し替えない。文字起こしは区切りごとに `.app` の中の `niho-speech` を起動するので、途中で差し替えると
//!   古い版の窓が新しい版の sidecar を起動してしまう。差し替えるのは終わるとき（`RunEvent::Exit`。工程・文字起こしを止めた後）だけで、
//!   別の NIHO docs が工程を実行している間は差し替えない（次に開いたときに取り直す）。
//! - 取得したら画面に「新しい版があります」と「更新して再起動」を出す（`update_status` と `update-staged` の event）。
//!   再起動は人が押したときだけ（`restart_to_update`。工程・会話・文字起こしが動いている間は確かめてから）。
//!   押したときはフィードを読み直し、その時点の最新公開版を取得してから再起動する（取得済みの版の次へ1段ずつ進めない）。
//!   押さなければ、閉じたときに差し替えて次に開いたときに新しい版になる。失敗しても起動・終了は止めず、診断ログ（local-ai.log）に残すだけ。
//! - 公開鍵がプレースホルダー（`PUBKEY_PLACEHOLDER`）の間は、plugin を初期化せず、画面にも出さない。開発ビルド
//!   （`tauri dev`・debug）でも確かめない（`.app` ではないので差し替えられない）。

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

/// tauri.conf.json の `plugins.updater.pubkey` の既定。owner が `tauri signer generate` で作った公開鍵に差し替えるまで、
/// 自動更新は使わない（apps/docs/scripts の updater-key.mjs も同じ値を見る）。
pub const PUBKEY_PLACEHOLDER: &str = "REPLACE_WITH_DOCS_UPDATER_PUBKEY";
/// 新しい版を取得したときに窓へ送る event（中身は `UpdateStatus`）。
pub const STAGED_EVENT: &str = "update-staged";
/// 起動後の確認の間隔（取得するまで。開いたままの窓でも、起動後に出た版を拾う）。
const RECHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// 診断ログ（`local_ai::file_log` と同じ形。`niho_local_ai::LogFn`）。
pub type LogFn = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// tauri.conf.json の `plugins.updater` の公開鍵が差し替え済みか。
pub fn pubkey_configured(updater_config: Option<&Value>) -> bool {
  updater_config
    .and_then(|config| config.get("pubkey"))
    .and_then(Value::as_str)
    .map(str::trim)
    .is_some_and(|pubkey| !pubkey.is_empty() && pubkey != PUBKEY_PLACEHOLDER)
}

/// この起動で自動更新を使うか（release ビルドで、公開鍵が差し替え済み）。
pub fn enabled(config: &tauri::Config) -> bool {
  !cfg!(debug_assertions) && pubkey_configured(config.plugins.0.get("updater"))
}

/// 画面が読む自動更新の状態。
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
  /// 自動更新を使っているか（公開鍵が未設定・開発ビルドでは false で、画面は何も出さない）。
  pub enabled: bool,
  /// 取得した新しい版（「更新して再起動」か、閉じて開き直すと切り替わる）。この起動で取得していなければ None。
  pub staged_version: Option<String>,
}

/// 取得して署名を確かめた新しい版（`.app` はまだ差し替えていない。終わるときに差し替える）。
struct Downloaded {
  update: Update,
  bytes: Vec<u8>,
}

pub struct UpdateState {
  status: Mutex<UpdateStatus>,
  downloaded: Mutex<Option<Downloaded>>,
  log: LogFn,
}

impl UpdateState {
  pub fn new(enabled: bool, log: LogFn) -> Self {
    Self {
      status: Mutex::new(UpdateStatus {
        enabled,
        staged_version: None,
      }),
      downloaded: Mutex::new(None),
      log,
    }
  }

  fn status(&self) -> UpdateStatus {
    self.status.lock().map(|status| status.clone()).unwrap_or_default()
  }

  /// 取得した新しい版（この起動で取得していなければ None）。
  pub fn staged_version(&self) -> Option<String> {
    self.status().staged_version
  }

  fn hold(&self, downloaded: Downloaded) -> UpdateStatus {
    let version = downloaded.update.version.clone();
    if let Ok(mut slot) = self.downloaded.lock() {
      *slot = Some(downloaded);
    }
    self.staged(version)
  }

  /// 終わるとき（`RunEvent::Exit`。工程・文字起こしを止めた後）に、取得した新しい版で `.app` を差し替える。
  /// `request_restart` ならこの後で新しい版が開く。別の NIHO docs が工程を実行している間は差し替えない
  /// （その窓が新しい版の sidecar を起動しないように。次に開いたときに取り直す）。
  pub fn install_on_exit(&self, another_app_running: bool) {
    let Some(downloaded) = self.downloaded.lock().ok().and_then(|mut slot| slot.take()) else {
      return;
    };
    let version = downloaded.update.version.clone();
    if another_app_running {
      (self.log)(
        "auto_update.install_deferred",
        json!({ "latestVersion": version, "reason": "another_app_running" }),
      );
      return;
    }
    match downloaded.update.install(&downloaded.bytes) {
      Ok(()) => (self.log)("auto_update.installed", json!({ "latestVersion": version })),
      Err(error) => (self.log)(
        "auto_update.failed",
        json!({ "latestVersion": version, "code": "update_install_failed", "details": error.to_string() }),
      ),
    }
  }

  fn staged(&self, version: String) -> UpdateStatus {
    match self.status.lock() {
      Ok(mut status) => {
        status.staged_version = Some(version);
        status.clone()
      }
      Err(_) => UpdateStatus {
        enabled: true,
        staged_version: Some(version),
      },
    }
  }
}

/// 起動時と、その後 1 時間ごとの確認（裏の thread で動く。ネットワーク不通・フィード未公開でも起動は止めない）。
/// 取得したら確認をやめる（終わるときに差し替えるので、次に開けば切り替わる）。
pub fn check_in_background<R: Runtime>(app: &AppHandle<R>) {
  let app = app.clone();
  std::thread::spawn(move || {
    let installed = app.package_info().version.to_string();
    let state = app.state::<UpdateState>();
    let log = Arc::clone(&state.log);
    loop {
      match tauri::async_runtime::block_on(download(&app)) {
        Ok(Some(downloaded)) => {
          log(
            "auto_update.staged",
            json!({ "installedVersion": installed, "latestVersion": downloaded.update.version }),
          );
          let status = state.hold(downloaded);
          let _ = app.emit(STAGED_EVENT, status);
          return;
        }
        Ok(None) => {}
        Err((code, details)) => log(
          "auto_update.failed",
          json!({ "installedVersion": installed, "code": code, "details": details }),
        ),
      }
      std::thread::sleep(RECHECK_INTERVAL);
    }
  });
}

/// フィードが返す最新公開版を確認する。確認・取得を無期限には待たない。
async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Update>, (&'static str, String)> {
  let updater = app
    .updater_builder()
    .timeout(Duration::from_secs(120))
    .build()
    .map_err(|error| ("updater_unavailable", error.to_string()))?;
  updater
    .check()
    .await
    .map_err(|error| ("update_check_failed", error.to_string()))
}

async fn download_update(update: Update) -> Result<Downloaded, (&'static str, String)> {
  let bytes = update
    .download(|_chunk, _total| {}, || {})
    .await
    .map_err(|error| ("update_download_failed", error.to_string()))?;
  Ok(Downloaded { update, bytes })
}

/// フィードに新しい版があれば、取得して署名を確かめる（`.app` はまだ差し替えない）。
async fn download<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Downloaded>, (&'static str, String)> {
  match check(app).await? {
    Some(update) => download_update(update).await.map(Some),
    None => Ok(None),
  }
}

/// ボタンを押した時点の最新版へ更新する。失敗時は取得済みの古い版へ黙って再起動しない。
pub async fn refresh_for_restart<R: Runtime>(app: &AppHandle<R>) -> bool {
  let state = app.state::<UpdateState>();
  let result: Result<(), (&'static str, String)> = async {
    let update = check(app)
      .await?
      .ok_or_else(|| ("update_unavailable", "latest update is not available".to_string()))?;
    if state.staged_version().as_deref() == Some(update.version.as_str()) {
      return Ok(());
    }
    let downloaded = download_update(update).await?;
    let status = state.hold(downloaded);
    (state.log)("auto_update.staged", json!({ "latestVersion": status.staged_version }));
    let _ = app.emit(STAGED_EVENT, status);
    Ok(())
  }
  .await;
  if let Err((code, details)) = result {
    (state.log)("auto_update.failed", json!({ "code": code, "details": details }));
    return false;
  }
  true
}

/// 画面が起動時に読む今の状態（取得した後は `update-staged` の event でも届く）。
#[tauri::command]
pub fn update_status(state: tauri::State<'_, UpdateState>) -> UpdateStatus {
  state.status()
}

/// 「更新して再起動」の結果（`restart_to_update`。lib.rs）。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RestartOutcome {
  /// 再起動を始めた（窓は閉じて、`.app` を差し替えてから新しい版で開き直す）。
  Restarting,
  /// 工程・会話・文字起こしが動いているので止めた（画面が確かめてから `force` で頼み直す）。
  Busy,
  /// 別の NIHO docs が工程を実行している（この窓からは止められないので、`force` でも再起動しない）。
  OtherAppRunning,
  /// 最新版の確認・取得に失敗した（アプリを開いたまま再試行できる）。
  RefreshFailed,
  /// まだ新しい版を取得していない（何もしない）。
  NotStaged,
}

/// 通信の前後で実行状態を確認し、最新版が取得できたときだけ再起動へ進める。
pub async fn prepare_restart<E, C, F, Fut>(mut can_restart: C, refresh: F) -> Result<RestartOutcome, E>
where
  C: FnMut() -> Result<RestartOutcome, E>,
  F: FnOnce() -> Fut,
  Fut: std::future::Future<Output = bool>,
{
  let before = can_restart()?;
  if before != RestartOutcome::Restarting {
    return Ok(before);
  }
  if !refresh().await {
    return Ok(RestartOutcome::RefreshFailed);
  }
  can_restart()
}

/// 再起動してよいか（取得済みで、別の NIHO docs が実行しておらず、動いている処理が無いか止めてよいと確かめた）。
pub fn restart_outcome(staged: bool, other_app_running: bool, busy: bool, force: bool) -> RestartOutcome {
  if !staged {
    RestartOutcome::NotStaged
  } else if other_app_running {
    RestartOutcome::OtherAppRunning
  } else if busy && !force {
    RestartOutcome::Busy
  } else {
    RestartOutcome::Restarting
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::cell::Cell;

  #[test]
  fn refreshing_keeps_the_app_open_on_failure_and_can_be_retried() {
    let restart = || Ok::<_, ()>(RestartOutcome::Restarting);
    assert_eq!(
      tauri::async_runtime::block_on(prepare_restart(restart, || async { false })),
      Ok(RestartOutcome::RefreshFailed)
    );
    assert_eq!(
      tauri::async_runtime::block_on(prepare_restart(restart, || async { true })),
      Ok(RestartOutcome::Restarting)
    );
  }

  #[test]
  fn refreshing_does_not_bypass_busy_work_or_another_process() {
    for outcome in [
      RestartOutcome::Busy,
      RestartOutcome::OtherAppRunning,
      RestartOutcome::NotStaged,
    ] {
      let result = tauri::async_runtime::block_on(prepare_restart(
        || Ok::<_, ()>(outcome),
        || async { panic!("blocked restart must not fetch or restart") },
      ));
      assert_eq!(result, Ok(outcome));
    }
  }

  #[test]
  fn work_started_while_downloading_is_checked_before_restarting() {
    for during_download in [RestartOutcome::Busy, RestartOutcome::OtherAppRunning] {
      let outcome = Cell::new(RestartOutcome::Restarting);
      let result = tauri::async_runtime::block_on(prepare_restart(
        || Ok::<_, ()>(outcome.get()),
        || async {
          outcome.set(during_download);
          true
        },
      ));
      assert_eq!(result, Ok(during_download));
    }
  }

  #[test]
  fn a_failed_run_lock_check_never_restarts() {
    let result = tauri::async_runtime::block_on(prepare_restart(
      || Err::<RestartOutcome, _>("run lock unavailable"),
      || async { panic!("unreadable execution state must not restart") },
    ));
    assert_eq!(result, Err("run lock unavailable"));
  }

  #[test]
  fn the_placeholder_and_blank_keys_turn_the_updater_off() {
    assert!(!pubkey_configured(None));
    assert!(!pubkey_configured(Some(&json!({ "endpoints": [] }))));
    assert!(!pubkey_configured(Some(&json!({ "pubkey": PUBKEY_PLACEHOLDER }))));
    assert!(!pubkey_configured(Some(&json!({ "pubkey": "  " }))));
    assert!(pubkey_configured(Some(
      &json!({ "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6" })
    )));
  }

  #[test]
  fn the_feed_is_the_public_editor_release_manifest() {
    let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
    assert_eq!(
      conf["plugins"]["updater"]["endpoints"],
      json!(["https://github.com/niho-life/niho-editor/releases/latest/download/latest.json"])
    );
    assert!(conf["plugins"]["updater"]["pubkey"].is_string());
  }

  #[test]
  fn restarting_waits_for_the_staged_update_and_asks_before_stopping_work() {
    assert_eq!(restart_outcome(false, false, false, false), RestartOutcome::NotStaged);
    assert_eq!(restart_outcome(false, true, true, true), RestartOutcome::NotStaged);
    assert_eq!(restart_outcome(true, false, false, false), RestartOutcome::Restarting);
    assert_eq!(restart_outcome(true, false, true, false), RestartOutcome::Busy);
    assert_eq!(restart_outcome(true, false, true, true), RestartOutcome::Restarting);
    // 別の NIHO docs の実行はこの窓から止められないので、force でも開き直さない
    assert_eq!(
      restart_outcome(true, true, false, false),
      RestartOutcome::OtherAppRunning
    );
    assert_eq!(restart_outcome(true, true, true, true), RestartOutcome::OtherAppRunning);
    assert_eq!(
      serde_json::to_value(RestartOutcome::NotStaged).unwrap(),
      json!("notStaged")
    );
    assert_eq!(
      serde_json::to_value(RestartOutcome::OtherAppRunning).unwrap(),
      json!("otherAppRunning")
    );
    assert_eq!(
      serde_json::to_value(RestartOutcome::RefreshFailed).unwrap(),
      json!("refreshFailed")
    );
  }

  #[test]
  fn the_status_uses_the_web_field_names() {
    let state = UpdateState::new(true, Arc::new(|_, _| {}));
    assert_eq!(
      serde_json::to_value(state.status()).unwrap(),
      json!({ "enabled": true, "stagedVersion": null })
    );
    assert_eq!(
      serde_json::to_value(state.staged("0.1.1".into())).unwrap(),
      json!({ "enabled": true, "stagedVersion": "0.1.1" })
    );
    assert_eq!(state.status().staged_version.as_deref(), Some("0.1.1"));
  }
}
