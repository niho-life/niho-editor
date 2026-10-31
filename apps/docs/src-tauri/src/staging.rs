//! 一時置き場（設計 §13）。端末内の文字起こしと CLI の AI で **1 つの仕組み**（2 つ作らない）。
//!
//! app data の `staging/<操作の id>/`（0700）に、その操作の間だけ音声・本文を置く。中のファイルは 0600。
//! 結果をサーバーに書けたら消し、書けなかったら残して「もう一度」に使う。起動時に古い残骸を掃く。
//! `~/Documents/NIHO docs`（旧い保管庫）は使わない。パスは画面に返さず、id だけでやり取りする。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::process::{hex, random_bytes, set_mode};

/// app data の下の置き場の名前。
pub const STAGING_DIR: &str = "staging";
/// 起動時に掃く古さ（これより古い操作の残骸は、もう「もう一度」に使えないとみなす）。
pub const SWEEP_AFTER: Duration = Duration::from_secs(24 * 60 * 60);

/// 操作の id（16 桁の hex）。画面から受け取る id はこの形だけを通す。
pub fn is_staging_id(value: &str) -> bool {
  value.len() == 16
    && value
      .bytes()
      .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// 置き場の根（app data の `staging/`）。
pub struct Staging {
  root: PathBuf,
}

/// 1 つの操作の置き場。消すのは明示的に（command をまたいで残すため、Drop では消さない）。
pub struct Staged {
  id: String,
  path: PathBuf,
}

impl Staging {
  pub fn new(data_dir: &Path) -> Self {
    Self {
      root: data_dir.join(STAGING_DIR),
    }
  }

  /// 新しい操作の置き場を作る（0700）。
  pub fn create(&self) -> io::Result<Staged> {
    fs::create_dir_all(&self.root)?;
    set_mode(&self.root, 0o700)?;
    let id = hex(&random_bytes::<8>()?);
    let path = self.root.join(&id);
    fs::create_dir(&path)?;
    set_mode(&path, 0o700)?;
    Ok(Staged { id, path })
  }

  /// 既にある操作の置き場（id の形が違う・無ければ None）。
  pub fn open(&self, id: &str) -> Option<Staged> {
    if !is_staging_id(id) {
      return None;
    }
    let path = self.root.join(id);
    path.is_dir().then(|| Staged {
      id: id.to_string(),
      path,
    })
  }

  /// 古い残骸を消す（起動時）。消せないものは残す。
  pub fn sweep(&self, older_than: Duration) -> usize {
    let Ok(entries) = fs::read_dir(&self.root) else {
      return 0;
    };
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
      let path = entry.path();
      let stale = entry
        .metadata()
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| now.duration_since(modified).ok())
        .is_some_and(|age| age > older_than);
      if path.is_dir() && stale && fs::remove_dir_all(&path).is_ok() {
        removed += 1;
      }
    }
    removed
  }
}

impl Staged {
  pub fn id(&self) -> &str {
    &self.id
  }

  pub fn path(&self) -> &Path {
    &self.path
  }

  /// 置き場の中のフォルダ（`audio`・`page`・`context`）。無ければ作る（0700）。
  pub fn dir(&self, name: &str) -> io::Result<PathBuf> {
    let path = self.path.join(name);
    if !path.is_dir() {
      fs::create_dir(&path)?;
      set_mode(&path, 0o700)?;
    }
    Ok(path)
  }

  /// 手元のファイルを写す（0600）。選んだ音声など。本文を書く口（0600 で書く）は CLI の AI の段で足す。
  pub fn copy_in(&self, dir: &str, name: &str, from: &Path) -> io::Result<PathBuf> {
    let path = self.dir(dir)?.join(name);
    fs::copy(from, &path)?;
    set_mode(&path, 0o600)?;
    Ok(path)
  }

  /// 置き場ごと消す。
  pub fn remove(self) -> io::Result<()> {
    fs::remove_dir_all(&self.path)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::time::Duration;

  fn temp_data_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("niho-docs-staging-test-{}", hex(&random_bytes::<6>().unwrap())));
    fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn creates_private_dirs_and_files() {
    let data = temp_data_dir();
    let staging = Staging::new(&data);
    let staged = staging.create().unwrap();
    assert!(is_staging_id(staged.id()));
    let source = data.join("source.m4a");
    fs::write(&source, b"hello").unwrap();
    let copied = staged.copy_in("audio", "0.m4a", &source).unwrap();
    assert_eq!(fs::read(&copied).unwrap(), b"hello");
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(fs::metadata(staged.path()).unwrap().permissions().mode() & 0o777, 0o700);
      assert_eq!(
        fs::metadata(staged.path().join("audio")).unwrap().permissions().mode() & 0o777,
        0o700
      );
      assert_eq!(fs::metadata(&copied).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // 開き直せる
    assert!(staging.open(staged.id()).is_some());
    let id = staged.id().to_string();
    staged.remove().unwrap();
    assert!(staging.open(&id).is_none());
    let _ = fs::remove_dir_all(&data);
  }

  #[test]
  fn rejects_ids_that_are_not_ours() {
    let data = temp_data_dir();
    let staging = Staging::new(&data);
    for bad in [
      "",
      "..",
      "../etc",
      "0123456789abcdeF",
      "0123456789abcde",
      "zzzzzzzzzzzzzzzz",
    ] {
      assert!(!is_staging_id(bad), "{bad}");
      assert!(staging.open(bad).is_none(), "{bad}");
    }
    let _ = fs::remove_dir_all(&data);
  }

  #[test]
  fn sweeps_only_old_dirs() {
    let data = temp_data_dir();
    let staging = Staging::new(&data);
    let fresh = staging.create().unwrap();
    assert_eq!(staging.sweep(Duration::from_secs(3600)), 0);
    assert!(staging.open(fresh.id()).is_some());
    // 0 秒より古いものは全部（作った直後でも経過は 0 以上）
    assert_eq!(staging.sweep(Duration::ZERO), 1);
    assert!(staging.open(fresh.id()).is_none());
    let _ = fs::remove_dir_all(&data);
  }
}
