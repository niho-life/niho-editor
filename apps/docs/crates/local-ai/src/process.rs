//! 子プロセスの扱い（起動・標準入出力・時間上限・停止・回収）と、実行中の工程の登録（このMacで同時 2 件まで）。
//! Desktop の記事エージェント（article_agent.rs の RunningTurn・run_attempt・shutdown_all_turns）と claude_update の写し。

use crate::maintenance;
use crate::turn::{StreamHandler, TurnCtx};
use crate::types::TurnEvent;
use serde_json::json;
use std::fs;
use std::io::{self, Read, Write};
#[cfg(not(unix))]
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime};

/// stderr は全部読み切るが、残すのは末尾だけ（判定とログに使う）。
pub(crate) const STDERR_TAIL_MAX_BYTES: usize = 64 * 1024;
/// このMacで同時に実行できる工程の数。
pub(crate) const MAX_RUNNING_TURNS: usize = 2;
/// アプリ終了時に SIGTERM の後で待つ時間。
const SHUTDOWN_GRACE: Duration = Duration::from_millis(800);
const POLL_INTERVAL: Duration = Duration::from_millis(20);
/// 子プロセスが終わった後、グループ外の子孫がパイプを保持している場合に出力を待つ上限。
const READER_JOIN_LIMIT: Duration = Duration::from_secs(2);
/// 改行を出さない CLI 出力でバッファが無制限に増えないようにする。
const MAX_STDOUT_LINE_BYTES: usize = 4 * 1024 * 1024;
/// 強制終了などで残った一時フォルダを消すまでの時間（ほかに実行中の工程が無いときだけ見る）。
const STALE_PRIVATE_DIR_AGE: Duration = Duration::from_secs(24 * 60 * 60);
pub(crate) const TURN_DIR_PREFIX: &str = "turn-";
pub(crate) const INSTALL_DIR_PREFIX: &str = "install-";

pub(crate) const MAINTENANCE_BUSY_MESSAGE: &str =
  "AI の CLI の更新またはログインが終わってから、もう一度実行してください。";
pub(crate) const TOO_MANY_TURNS_MESSAGE: &str =
  "このMacで実行中の工程が多すぎます。終わってからもう一度試してください。";

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// 乱数・UUID（依存を増やさず /dev/urandom から作る。Desktop の format_uuid_v4 の写し）

pub(crate) fn random_bytes<const N: usize>() -> io::Result<[u8; N]> {
  let mut bytes = [0u8; N];
  fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
  Ok(bytes)
}

pub(crate) fn hex(bytes: &[u8]) -> String {
  bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `--session-id` に渡す UUID v4。
pub(crate) fn format_uuid_v4(mut bytes: [u8; 16]) -> String {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let h = hex(&bytes);
  format!(
    "{}-{}-{}-{}-{}",
    &h[0..8],
    &h[8..12],
    &h[12..16],
    &h[16..20],
    &h[20..32]
  )
}

pub(crate) fn new_uuid_v4() -> io::Result<String> {
  Ok(format_uuid_v4(random_bytes::<16>()?))
}

/// 8-4-4-4-12 の 16 進。続きの会話の ID はこの形だけを受ける（CLI の引数に任意の文字列を渡さない）。
pub(crate) fn is_uuid(value: &str) -> bool {
  let parts: Vec<&str> = value.split('-').collect();
  parts.len() == 5
    && [8usize, 4, 4, 4, 12]
      .iter()
      .zip(parts.iter())
      .all(|(len, part)| part.len() == *len && part.chars().all(|ch| ch.is_ascii_hexdigit()))
}

// ---------------------------------------------------------------------------
// 0600 の一時ファイル

#[cfg(unix)]
pub(crate) fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
  use std::os::unix::fs::PermissionsExt;
  fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
pub(crate) fn set_mode(_path: &Path, _mode: u32) -> io::Result<()> {
  Ok(())
}

pub(crate) fn ensure_private_dir(path: &Path) -> io::Result<()> {
  fs::create_dir_all(path)?;
  set_mode(path, 0o700)
}

pub(crate) fn write_private_file(path: &Path, contents: &[u8], create_new: bool) -> io::Result<()> {
  let mut options = fs::OpenOptions::new();
  options.write(true);
  if create_new {
    options.create_new(true);
  } else {
    options.create(true).truncate(true);
  }
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  let mut file = options.open(path)?;
  file.write_all(contents)?;
  file.flush()?;
  set_mode(path, 0o600)
}

/// 1 回の実行（またはインストール）の間だけ置く 0700 のフォルダ。システムプロンプト・agy の作業フォルダと agent.md などを
/// 0600 で書き、内容はログに出さない。Drop でフォルダごと消す（成功・失敗・停止・時間切れのどれでも）。
pub(crate) struct PrivateDir {
  path: PathBuf,
}

impl PrivateDir {
  pub(crate) fn create(scratch_dir: &Path, prefix: &str) -> io::Result<Self> {
    ensure_private_dir(scratch_dir)?;
    let path = scratch_dir.join(format!("{prefix}{}", hex(&random_bytes::<8>()?)));
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
      use std::os::unix::fs::DirBuilderExt;
      builder.mode(0o700);
    }
    builder.create(&path)?;
    set_mode(&path, 0o700)?;
    Ok(Self { path })
  }

  pub(crate) fn path(&self) -> &Path {
    &self.path
  }

  pub(crate) fn write(&self, name: &str, contents: &[u8]) -> io::Result<PathBuf> {
    let path = self.path.join(name);
    write_private_file(&path, contents, true)?;
    Ok(path)
  }

  /// この中に 0700 のフォルダを作る（`a/b/c` は途中も作る。あるものはそのまま使う）。
  pub(crate) fn create_dir(&self, relative: &str) -> io::Result<PathBuf> {
    let mut path = self.path.clone();
    for part in relative.split('/').filter(|part| !part.is_empty()) {
      path.push(part);
      let mut builder = fs::DirBuilder::new();
      #[cfg(unix)]
      {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
      }
      match builder.create(&path) {
        Ok(()) => set_mode(&path, 0o700)?,
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists && path.is_dir() => {}
        Err(err) => return Err(err),
      }
    }
    Ok(path)
  }
}

impl Drop for PrivateDir {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.path);
  }
}

/// 強制終了などで残った一時フォルダを消す。別のプロセスが同じ置き場を使っていても巻き込まないよう、古いものだけ。
pub(crate) fn sweep_stale_private_dirs(scratch_dir: &Path) {
  let Ok(entries) = fs::read_dir(scratch_dir) else { return };
  let now = SystemTime::now();
  for entry in entries.flatten() {
    let name = entry.file_name();
    let name = name.to_string_lossy();
    if !(name.starts_with(TURN_DIR_PREFIX) || name.starts_with(INSTALL_DIR_PREFIX)) {
      continue;
    }
    let stale = entry
      .metadata()
      .and_then(|meta| meta.modified())
      .ok()
      .and_then(|modified| now.duration_since(modified).ok())
      .is_some_and(|age| age > STALE_PRIVATE_DIR_AGE);
    if stale {
      let _ = fs::remove_dir_all(entry.path());
    }
  }
}

// ---------------------------------------------------------------------------
// 実行中の工程（停止・時間切れ・アプリ終了）

const ACTIVE: u8 = 0;
const STOP_REQUESTED: u8 = 1;
const FINISHED: u8 = 2;

pub(crate) struct RunningTurn {
  /// ACTIVE → STOP_REQUESTED（stop・shutdown）→ FINISHED（終わり方を決めた後）。FINISHED の後の stop は false を返す
  state: AtomicU8,
  timed_out: AtomicBool,
  /// まだ回収していない子プロセスと、その起動の通し番号。回収したら同じロックの中で None にする
  /// （回収前ならプロセスグループ ID は再利用されない）
  child: Mutex<Option<(u64, Child)>>,
  next_generation: AtomicU64,
  /// アプリ終了時に消す一時フォルダ（スレッドの Drop を待たずに終了するため）
  private_dir: Mutex<Option<PathBuf>>,
}

impl RunningTurn {
  pub(crate) fn new() -> Self {
    Self {
      state: AtomicU8::new(ACTIVE),
      timed_out: AtomicBool::new(false),
      child: Mutex::new(None),
      next_generation: AtomicU64::new(1),
      private_dir: Mutex::new(None),
    }
  }

  /// 止める合図を出す。終わり方をもう決めていれば false。
  pub(crate) fn request_stop(&self) -> bool {
    match self
      .state
      .compare_exchange(ACTIVE, STOP_REQUESTED, Ordering::SeqCst, Ordering::SeqCst)
    {
      Ok(_) => true,
      Err(current) => current == STOP_REQUESTED,
    }
  }

  pub(crate) fn is_stop_requested(&self) -> bool {
    self.state.load(Ordering::SeqCst) == STOP_REQUESTED
  }

  /// 止める合図・時間切れの後に届いた delta は送らない。
  pub(crate) fn is_silenced(&self) -> bool {
    self.is_stop_requested() || self.is_timed_out()
  }

  /// 終わり方を決める。止める合図が出ていたら true（Desktop と同じく、停止は時間切れ・失敗より優先する）。
  pub(crate) fn settle(&self) -> bool {
    self.state.swap(FINISHED, Ordering::SeqCst) == STOP_REQUESTED
  }

  pub(crate) fn mark_finished(&self) {
    self.state.store(FINISHED, Ordering::SeqCst);
  }

  pub(crate) fn is_timed_out(&self) -> bool {
    self.timed_out.load(Ordering::SeqCst)
  }

  fn mark_timed_out(&self) {
    self.timed_out.store(true, Ordering::SeqCst);
  }

  pub(crate) fn set_private_dir(&self, path: Option<PathBuf>) {
    *lock(&self.private_dir) = path;
  }

  fn remove_private_dir(&self) {
    if let Some(path) = lock(&self.private_dir).take() {
      let _ = fs::remove_dir_all(path);
    }
  }

  fn install_child(&self, child: Child) {
    let generation = self.next_generation.fetch_add(1, Ordering::SeqCst);
    *lock(&self.child) = Some((generation, child));
  }

  fn current_generation(&self) -> Option<u64> {
    lock(&self.child).as_ref().map(|(generation, _)| *generation)
  }

  /// 子プロセスのプロセスグループ全体へシグナルを送る（`process_group(0)` で起動しているので pgid = pid）。
  /// `only` を渡したら、その起動の子プロセスがまだ回収前のときだけ送る（やり直しの次の子を巻き込まない）。
  fn signal_group(&self, signal: libc::c_int, only: Option<u64>) {
    let guard = lock(&self.child);
    if let Some((generation, child)) = guard.as_ref() {
      if only.is_none_or(|expected| expected == *generation) {
        signal_process_group(child.id(), signal);
      }
    }
  }

  /// 今の子プロセスへ SIGTERM を送り、`grace` 後もその子が回収されていなければ SIGKILL を送る（呼び出し元は待たない）。
  pub(crate) fn terminate(self: &Arc<Self>, grace: Duration) {
    let Some(generation) = self.current_generation() else {
      return;
    };
    self.signal_group(libc::SIGTERM, Some(generation));
    let this = self.clone();
    std::thread::spawn(move || {
      let deadline = Instant::now() + grace;
      while Instant::now() < deadline {
        if this.current_generation() != Some(generation) {
          return;
        }
        std::thread::sleep(POLL_INTERVAL);
      }
      this.signal_group(libc::SIGKILL, Some(generation));
    });
  }
}

#[cfg(unix)]
pub(crate) fn signal_process_group(pid: u32, signal: libc::c_int) {
  // SAFETY: killpg はシグナルを送るだけで、メモリを触らない。pid は回収前の子なのでグループ ID は再利用されていない
  unsafe {
    libc::killpg(pid as libc::pid_t, signal);
  }
}

#[cfg(not(unix))]
pub(crate) fn signal_process_group(_pid: u32, _signal: i32) {}

/// 回収した直後に、同じプロセスグループに残った子孫（CLI が起動したもの・SIGTERM の行き違いで残ったもの）を止める。
/// 残りがいる間はグループ ID が再利用されない。空なら ESRCH で何もしない。
pub(crate) fn kill_leftover_group(pid: u32) {
  signal_process_group(pid, libc::SIGKILL);
}

fn running_turns() -> &'static Mutex<Vec<Arc<RunningTurn>>> {
  static TURNS: OnceLock<Mutex<Vec<Arc<RunningTurn>>>> = OnceLock::new();
  TURNS.get_or_init(|| Mutex::new(Vec::new()))
}

/// 実行中の工程の登録。Drop で外す（最後のイベントを送る前に外れるので、Done を受けてすぐ次を始められる）。
pub(crate) struct RunningTurnRegistration {
  turn: Arc<RunningTurn>,
}

impl Drop for RunningTurnRegistration {
  fn drop(&mut self) {
    lock(running_turns()).retain(|turn| !Arc::ptr_eq(turn, &self.turn));
  }
}

/// 実行中の工程として登録する。CLI の更新・ログイン・インストールの最中と、同時に `MAX_RUNNING_TURNS` 件を超える実行は断る。
/// 戻り値の 2 つめは「ほかに実行中の工程が無かったか」（古い一時フォルダの掃除に使う）。
pub(crate) fn register_running_turn(turn: &Arc<RunningTurn>) -> Result<(RunningTurnRegistration, bool), &'static str> {
  if maintenance::is_in_progress() {
    return Err(MAINTENANCE_BUSY_MESSAGE);
  }
  let mut turns = lock(running_turns());
  // 最初の確認と mutex 取得の間に更新・ログインが登録される競合もここで閉じる。
  // maintenance 側も登録後にこの mutex を確認するため、同時開始はどちらの順でも成立しない。
  if maintenance::is_in_progress() {
    return Err(MAINTENANCE_BUSY_MESSAGE);
  }
  if turns.len() >= MAX_RUNNING_TURNS {
    return Err(TOO_MANY_TURNS_MESSAGE);
  }
  let was_idle = turns.is_empty();
  turns.push(turn.clone());
  Ok((RunningTurnRegistration { turn: turn.clone() }, was_idle))
}

/// 実行中の工程があるか（CLI の更新・ログインの前の確認、アプリの「更新して再起動」の前の確認に使う）。
pub fn has_running_turns() -> bool {
  !lock(running_turns()).is_empty()
}

/// アプリ終了時に、実行中の工程のプロセスをすべて止める（SIGTERM → 少し待って SIGKILL）。一時フォルダも消す。
pub(crate) fn shutdown_turns() {
  let turns: Vec<Arc<RunningTurn>> = lock(running_turns()).clone();
  for turn in &turns {
    turn.request_stop();
    turn.signal_group(libc::SIGTERM, None);
  }
  let deadline = Instant::now() + SHUTDOWN_GRACE;
  while Instant::now() < deadline && turns.iter().any(|turn| turn.current_generation().is_some()) {
    std::thread::sleep(POLL_INTERVAL);
  }
  for turn in &turns {
    turn.signal_group(libc::SIGKILL, None);
    turn.remove_private_dir();
  }
}

// ---------------------------------------------------------------------------
// 1 回の実行の子プロセス

pub(crate) enum ChildExit {
  SpawnFailed(String),
  Exited { exit_code: Option<i32>, stderr: String },
}

/// 全部読み切る（途中で読むのをやめると子プロセスが書き込みで止まる）。残すのは末尾だけ。
fn read_tail(pipe: Option<impl Read>, max_bytes: usize) -> Vec<u8> {
  let mut tail: Vec<u8> = Vec::new();
  if let Some(mut pipe) = pipe {
    let mut chunk = [0u8; 8192];
    loop {
      match pipe.read(&mut chunk) {
        Ok(0) => break,
        Ok(read) => {
          tail.extend_from_slice(&chunk[..read]);
          if tail.len() > max_bytes * 2 {
            tail.drain(..tail.len() - max_bytes);
          }
        }
        Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
        Err(_) => break,
      }
    }
  }
  if tail.len() > max_bytes {
    tail.drain(..tail.len() - max_bytes);
  }
  tail
}

/// CLI を 1 回起動し、stdout を 1 行ずつ `handler` に渡す（Desktop の run_attempt の子プロセスの扱い）。
/// - 指示は標準入力へ書いて閉じる（引数に載せない。`-` で始まる指示がフラグと解釈されないように）。
/// - Unix では stdin・stdout・stderr を非ブロッキングで poll し、stderr の末尾 64KiB だけ残す。
/// - 時間上限は poll ループで見て、過ぎたらプロセスグループごと止める。
/// - ツールの気配（`handler.breach()`）を見たら工程を止め、後続 stdout は読み捨てる。停止・時間切れの後の delta は送らない。
/// - 回収は `try_wait` をロックの中で回し、回収したら同じロックの中で子を外して `kill_leftover_group` する。
#[cfg(unix)]
pub(crate) fn run_child(
  ctx: &TurnCtx,
  command: Command,
  stdin_bytes: Vec<u8>,
  handler: &mut dyn StreamHandler,
  emit: &mut dyn FnMut(TurnEvent),
) -> ChildExit {
  run_child_within(ctx, command, stdin_bytes, handler, emit, None)
}

/// [`run_child`] に、この子だけの上限 `cap` を足したもの（ターンの前の短い問い合わせ。過ぎたら子を止めるが、ターンの時間切れには
/// しない＝`ChildExit::Exited` の `exit_code` が None になる）。ターンの子として動くので、停止・ターンの時間切れ・アプリの終了でも止まる。
#[cfg(unix)]
pub(crate) fn run_child_within(
  ctx: &TurnCtx,
  mut command: Command,
  stdin_bytes: Vec<u8>,
  handler: &mut dyn StreamHandler,
  emit: &mut dyn FnMut(TurnEvent),
  cap: Option<Instant>,
) -> ChildExit {
  use std::os::unix::io::AsRawFd;

  let running = ctx.running;
  let grace = ctx.runtime.kill_grace;
  command
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  let mut child = match command.spawn() {
    Ok(child) => child,
    Err(err) => return ChildExit::SpawnFailed(format!("io error: {err}")),
  };
  let pid = child.id();
  let mut stdin = child.stdin.take();
  let mut stdout = child.stdout.take();
  let mut stderr = child.stderr.take();
  for fd in [
    stdin.as_ref().map(AsRawFd::as_raw_fd),
    stdout.as_ref().map(AsRawFd::as_raw_fd),
    stderr.as_ref().map(AsRawFd::as_raw_fd),
  ]
  .into_iter()
  .flatten()
  {
    if let Err(err) = set_nonblocking(fd) {
      signal_process_group(pid, libc::SIGKILL);
      let _ = child.kill();
      let _ = child.wait();
      kill_leftover_group(pid);
      return ChildExit::SpawnFailed(format!("could not configure nonblocking child pipes: {err}"));
    }
  }
  let mut stdin_offset = 0;
  if stdin_bytes.is_empty() {
    stdin.take();
  }
  running.install_child(child);
  if running.is_stop_requested() {
    running.terminate(grace);
  }

  let mut stdout_buffer = Vec::new();
  let mut discarding_stdout_line = false;
  let mut breach_observed = false;
  let mut stderr_tail = Vec::new();
  let mut child_reaped = false;
  let mut exit_code = None;
  let mut drain_deadline = None;
  let mut capped = false;

  loop {
    if !running.is_timed_out() && Instant::now() >= ctx.deadline {
      running.mark_timed_out();
      running.terminate(grace);
    } else if !capped && !child_reaped && cap.is_some_and(|cap| Instant::now() >= cap) {
      capped = true;
      running.terminate(grace);
    }

    let mut poll_fds = [
      libc::pollfd {
        fd: stdin
          .as_ref()
          .filter(|_| stdin_offset < stdin_bytes.len())
          .map_or(-1, AsRawFd::as_raw_fd),
        events: libc::POLLOUT,
        revents: 0,
      },
      libc::pollfd {
        fd: stdout.as_ref().map_or(-1, AsRawFd::as_raw_fd),
        events: libc::POLLIN,
        revents: 0,
      },
      libc::pollfd {
        fd: stderr.as_ref().map_or(-1, AsRawFd::as_raw_fd),
        events: libc::POLLIN,
        revents: 0,
      },
    ];
    // SAFETY: poll_fds is a live array and all listed descriptors remain owned during poll.
    unsafe {
      libc::poll(
        poll_fds.as_mut_ptr(),
        poll_fds.len() as libc::nfds_t,
        POLL_INTERVAL.as_millis() as i32,
      );
    }

    if let Some(pipe) = stdin.as_mut() {
      if stdin_offset < stdin_bytes.len() {
        match pipe.write(&stdin_bytes[stdin_offset..]) {
          Ok(0) => {
            stdin.take();
          }
          Ok(written) => {
            stdin_offset += written;
            if stdin_offset == stdin_bytes.len() {
              stdin.take();
            }
          }
          Err(err) if err.kind() == io::ErrorKind::WouldBlock || err.kind() == io::ErrorKind::Interrupted => {}
          Err(_) => {
            stdin.take();
          }
        }
      }
    }

    if let Some(pipe) = stdout.as_mut() {
      let mut eof = false;
      let mut chunk = [0u8; 8192];
      let mut read_budget = 64 * 1024usize;
      while read_budget > 0 {
        match pipe.read(&mut chunk) {
          Ok(0) => {
            eof = true;
            break;
          }
          Ok(read) => {
            read_budget = read_budget.saturating_sub(read);
            consume_stdout(
              ctx,
              running,
              handler,
              emit,
              &chunk[..read],
              &mut stdout_buffer,
              &mut discarding_stdout_line,
              &mut breach_observed,
              grace,
            )
          }
          Err(err) if err.kind() == io::ErrorKind::WouldBlock => break,
          Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
          Err(_) => {
            eof = true;
            break;
          }
        }
      }
      if eof {
        stdout.take();
        if !discarding_stdout_line && !stdout_buffer.is_empty() {
          process_stdout_line(ctx, running, handler, emit, &stdout_buffer, &mut breach_observed, grace);
        }
        stdout_buffer.clear();
      }
    }

    if let Some(pipe) = stderr.as_mut() {
      let mut eof = false;
      let mut chunk = [0u8; 8192];
      let mut read_budget = 64 * 1024usize;
      while read_budget > 0 {
        match pipe.read(&mut chunk) {
          Ok(0) => {
            eof = true;
            break;
          }
          Ok(read) => {
            read_budget = read_budget.saturating_sub(read);
            append_tail(&mut stderr_tail, &chunk[..read], STDERR_TAIL_MAX_BYTES);
          }
          Err(err) if err.kind() == io::ErrorKind::WouldBlock => break,
          Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
          Err(_) => {
            eof = true;
            break;
          }
        }
      }
      if eof {
        stderr.take();
      }
    }

    if !child_reaped {
      // stop が kill できるよう、ロックは短く取って待つ。回収したら同じロックの中で None にする。
      let waited = {
        let mut guard = lock(&running.child);
        match guard.as_mut().map(|(_, child)| (child.id(), child.try_wait())) {
          Some((pid, Ok(Some(status)))) => {
            guard.take();
            kill_leftover_group(pid);
            Some(status.code())
          }
          Some((_, Ok(None))) => None,
          Some((pid, Err(_))) => {
            guard.take();
            kill_leftover_group(pid);
            Some(None)
          }
          None => Some(None),
        }
      };
      if let Some(code) = waited {
        child_reaped = true;
        exit_code = code;
        stdin.take();
        drain_deadline = Some(Instant::now() + READER_JOIN_LIMIT);
      }
    }

    if child_reaped {
      if stdout.is_none() && stderr.is_none() {
        break;
      }
      if drain_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        // グループ外の孫がパイプを保持していても、読み取り fd を閉じて工程を返す。
        stdout.take();
        stderr.take();
        break;
      }
    }
  }

  ChildExit::Exited {
    exit_code,
    stderr: String::from_utf8_lossy(&stderr_tail).into_owned(),
  }
}

#[cfg(not(unix))]
pub(crate) fn run_child(
  ctx: &TurnCtx,
  command: Command,
  stdin_bytes: Vec<u8>,
  handler: &mut dyn StreamHandler,
  emit: &mut dyn FnMut(TurnEvent),
) -> ChildExit {
  run_child_within(ctx, command, stdin_bytes, handler, emit, None)
}

#[cfg(not(unix))]
pub(crate) fn run_child_within(
  ctx: &TurnCtx,
  mut command: Command,
  stdin_bytes: Vec<u8>,
  handler: &mut dyn StreamHandler,
  emit: &mut dyn FnMut(TurnEvent),
  cap: Option<Instant>,
) -> ChildExit {
  let running = ctx.running;
  let grace = ctx.runtime.kill_grace;
  command
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  let mut child = match command.spawn() {
    Ok(child) => child,
    Err(err) => return ChildExit::SpawnFailed(format!("io error: {err}")),
  };
  let stdin = child.stdin.take();
  let stdout = child.stdout.take();
  let stderr = child.stderr.take();
  let stdin_handle = std::thread::spawn(move || {
    if let Some(mut pipe) = stdin {
      let _ = pipe.write_all(&stdin_bytes);
    }
  });
  let stderr_handle = std::thread::spawn(move || read_tail(stderr, STDERR_TAIL_MAX_BYTES));
  running.install_child(child);
  if running.is_stop_requested() {
    running.terminate(grace);
  }

  // 1 回の実行の時間上限。過ぎたらプロセスグループごと止める
  let attempt_done = Arc::new(AtomicBool::new(false));
  let watchdog = {
    let done = attempt_done.clone();
    let running = running.clone();
    let deadline = ctx.deadline;
    std::thread::spawn(move || {
      while !done.load(Ordering::SeqCst) {
        if Instant::now() >= deadline {
          running.mark_timed_out();
          running.terminate(grace);
          return;
        }
        if cap.is_some_and(|cap| Instant::now() >= cap) {
          running.terminate(grace);
          return;
        }
        std::thread::sleep(POLL_INTERVAL);
      }
    })
  };

  if let Some(stdout) = stdout {
    // JSON の行は UTF-8 のはず。崩れた行があっても読むのをやめない（やめると子プロセスが書き込みで止まる）
    let mut reader = BufReader::new(stdout);
    let mut buffer = Vec::new();
    loop {
      buffer.clear();
      match reader.read_until(b'\n', &mut buffer) {
        Ok(0) | Err(_) => break,
        Ok(_) => {}
      }
      let line = String::from_utf8_lossy(&buffer);
      let events = handler.process_line(&line);
      for warning in handler.take_warnings() {
        ctx.log("cli_warning", json!({ "message": sanitize_stderr_tail(&warning, 300) }));
      }
      if let Some(breach) = handler.breach() {
        ctx.log(
          "tool_breach",
          json!({ "type": breach.kind, "reasonCode": breach.code.as_str() }),
        );
        running.terminate(grace);
        break;
      }
      if !running.is_silenced() {
        for event in events {
          emit(event);
        }
      }
    }
  }

  // stop が kill できるよう、ロックは短く取って待つ。回収したら同じロックの中で None にする
  let exit_code = loop {
    let waited = {
      let mut guard = lock(&running.child);
      match guard.as_mut().map(|(_, child)| (child.id(), child.try_wait())) {
        Some((pid, Ok(Some(status)))) => {
          guard.take();
          kill_leftover_group(pid);
          Some(status.code())
        }
        Some((_, Ok(None))) => None,
        Some((pid, Err(_))) => {
          guard.take();
          kill_leftover_group(pid);
          Some(None)
        }
        None => Some(None),
      }
    };
    if let Some(code) = waited {
      break code;
    }
    std::thread::sleep(POLL_INTERVAL);
  };
  attempt_done.store(true, Ordering::SeqCst);
  let _ = watchdog.join();
  let _ = stdin_handle.join();
  let stderr = stderr_handle.join().unwrap_or_default();
  ChildExit::Exited {
    exit_code,
    stderr: String::from_utf8_lossy(&stderr).into_owned(),
  }
}

#[cfg(unix)]
fn set_nonblocking(fd: std::os::unix::io::RawFd) -> io::Result<()> {
  // SAFETY: fcntl reads and updates flags for a live descriptor owned by this function.
  let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
  if flags < 0 {
    return Err(io::Error::last_os_error());
  }
  // SAFETY: the descriptor is still owned here and flags came from F_GETFL.
  if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
    return Err(io::Error::last_os_error());
  }
  Ok(())
}

#[cfg(unix)]
fn append_tail(tail: &mut Vec<u8>, bytes: &[u8], max_bytes: usize) {
  tail.extend_from_slice(bytes);
  if tail.len() > max_bytes {
    tail.drain(..tail.len() - max_bytes);
  }
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn consume_stdout(
  ctx: &TurnCtx,
  running: &Arc<RunningTurn>,
  handler: &mut dyn StreamHandler,
  emit: &mut dyn FnMut(TurnEvent),
  bytes: &[u8],
  line: &mut Vec<u8>,
  discarding: &mut bool,
  breach_observed: &mut bool,
  grace: Duration,
) {
  for byte in bytes {
    if *byte == b'\n' {
      if *discarding {
        ctx.log(
          "cli_warning",
          json!({ "message": "stdout line exceeded the size limit" }),
        );
        *discarding = false;
        line.clear();
      } else {
        process_stdout_line(ctx, running, handler, emit, line, breach_observed, grace);
        line.clear();
      }
    } else if !*discarding {
      if line.len() < MAX_STDOUT_LINE_BYTES {
        line.push(*byte);
      } else {
        line.clear();
        *discarding = true;
      }
    }
  }
}

#[cfg(unix)]
fn process_stdout_line(
  ctx: &TurnCtx,
  running: &Arc<RunningTurn>,
  handler: &mut dyn StreamHandler,
  emit: &mut dyn FnMut(TurnEvent),
  line: &[u8],
  breach_observed: &mut bool,
  grace: Duration,
) {
  if *breach_observed {
    return;
  }
  let events = handler.process_line(&String::from_utf8_lossy(line));
  for warning in handler.take_warnings() {
    ctx.log("cli_warning", json!({ "message": sanitize_stderr_tail(&warning, 300) }));
  }
  if let Some(breach) = handler.breach() {
    ctx.log(
      "tool_breach",
      json!({ "type": breach.kind, "reasonCode": breach.code.as_str() }),
    );
    *breach_observed = true;
    running.terminate(grace);
    return;
  }
  if !running.is_silenced() {
    for event in events {
      emit(event);
    }
  }
}

// ---------------------------------------------------------------------------
// 短い CLI の呼び出し（--version・auth status・update・インストーラ）

#[derive(Debug)]
pub(crate) struct Captured {
  pub status: ExitStatus,
  pub stdout: Vec<u8>,
  pub stderr: Vec<u8>,
}

#[derive(Debug)]
pub(crate) enum CaptureError {
  Spawn(io::Error),
  TimedOut,
  Wait(io::Error),
}

fn spawn_reader(pipe: Option<impl Read + Send + 'static>, max_bytes: usize) -> mpsc::Receiver<Vec<u8>> {
  let (sender, receiver) = mpsc::channel();
  std::thread::spawn(move || {
    let _ = sender.send(read_tail(pipe, max_bytes));
  });
  receiver
}

/// 標準入力は渡さず、出力は末尾 `max_bytes` だけ残す。時間上限を過ぎたらプロセスグループへ SIGTERM → 猶予 → SIGKILL
/// （Desktop の claude_update の run_update_at の写し）。プロセスグループは `command` の側で分けておく。
pub(crate) fn run_capture(
  mut command: Command,
  time_limit: Duration,
  kill_grace: Duration,
  max_bytes: usize,
) -> Result<Captured, CaptureError> {
  command
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  let mut child = command.spawn().map_err(CaptureError::Spawn)?;
  let pid = child.id();
  let stdout = spawn_reader(child.stdout.take(), max_bytes);
  let stderr = spawn_reader(child.stderr.take(), max_bytes);
  let deadline = Instant::now() + time_limit;
  let status = loop {
    match child.try_wait() {
      Ok(Some(status)) => break status,
      Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
      Ok(None) => {
        signal_process_group(pid, libc::SIGTERM);
        let kill_deadline = Instant::now() + kill_grace;
        let mut exited = false;
        while Instant::now() < kill_deadline {
          if matches!(child.try_wait(), Ok(Some(_))) {
            exited = true;
            break;
          }
          std::thread::sleep(Duration::from_millis(50));
        }
        if !exited {
          signal_process_group(pid, libc::SIGKILL);
          let _ = child.kill();
          let _ = child.wait();
        }
        kill_leftover_group(pid);
        return Err(CaptureError::TimedOut);
      }
      Err(error) => {
        signal_process_group(pid, libc::SIGKILL);
        let _ = child.kill();
        let _ = child.wait();
        return Err(CaptureError::Wait(error));
      }
    }
  };
  kill_leftover_group(pid);
  Ok(Captured {
    status,
    stdout: stdout.recv_timeout(READER_JOIN_LIMIT).unwrap_or_default(),
    stderr: stderr.recv_timeout(READER_JOIN_LIMIT).unwrap_or_default(),
  })
}

// ---------------------------------------------------------------------------
// ログに出す CLI の出力

/// 秘密に見える値を先に伏せてから末尾（最後の `max_bytes`、UTF-8 の境目で切る）を取る。
/// 切ってから伏せると、境目で割れた `sk-` の値を伏せられないため。
pub(crate) fn sanitize_stderr_tail(raw: &str, max_bytes: usize) -> String {
  let trimmed = raw.trim_end();
  let masked = mask_secrets(trimmed);
  if masked.len() <= max_bytes {
    return masked;
  }
  let start = masked.len().saturating_sub(max_bytes);
  let safe_start = (start..=masked.len())
    .find(|index| masked.is_char_boundary(*index))
    .unwrap_or(masked.len());
  format!("…{}", &masked[safe_start..])
}

/// CLI の診断出力に混ざる API key・Bearer/OAuth token・JWT を伏せる。
pub(crate) fn mask_secrets(input: &str) -> String {
  let bytes = input.as_bytes();
  let mut output = String::with_capacity(input.len());
  let mut copied_through = 0;
  let mut index = 0;
  while index < bytes.len() {
    if index > 0 && (bytes[index - 1].is_ascii_alphanumeric() || bytes[index - 1] == b'_') {
      index += 1;
      continue;
    }

    let bearer = bytes[index..].len() >= 6 && bytes[index..index + 6].eq_ignore_ascii_case(b"bearer");
    if bearer && bytes.get(index + 6).is_some_and(u8::is_ascii_whitespace) {
      let mut token_start = index + 6;
      while bytes.get(token_start).is_some_and(u8::is_ascii_whitespace) {
        token_start += 1;
      }
      let token_end = scan_token(bytes, token_start, is_token_byte);
      if token_end > token_start {
        output.push_str(&input[copied_through..token_start]);
        output.push_str("***");
        copied_through = token_end;
        index = token_end;
        continue;
      }
    }

    let remainder = &bytes[index..];
    let prefix_len = if remainder.starts_with(b"sk-") {
      Some((3, 8))
    } else if remainder.starts_with(b"ya29.") {
      Some((5, 12))
    } else if remainder.starts_with(b"1//0") {
      Some((4, 16))
    } else if remainder.starts_with(b"AIza") {
      Some((4, 28))
    } else if remainder.starts_with(b"github_pat_") {
      Some((11, 16))
    } else if [b"ghp_".as_slice(), b"gho_", b"ghu_", b"ghs_", b"ghr_"]
      .iter()
      .any(|prefix| remainder.starts_with(prefix))
    {
      Some((4, 16))
    } else {
      None
    };
    if let Some((prefix_len, min_len)) = prefix_len {
      let token_end = scan_token(bytes, index + prefix_len, is_token_byte);
      if token_end.saturating_sub(index) >= min_len {
        output.push_str(&input[copied_through..index]);
        output.push_str(&input[index..index + prefix_len]);
        output.push_str("***");
        copied_through = token_end;
        index = token_end;
        continue;
      }
    }

    if remainder.starts_with(b"eyJ") {
      let scanned_end = scan_token(bytes, index, |byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
      });
      let mut token_end = scanned_end;
      while token_end > index && bytes[token_end - 1] == b'.' {
        token_end -= 1;
      }
      let token = &bytes[index..token_end];
      let segments: Vec<&[u8]> = token.split(|byte| *byte == b'.').collect();
      let valid_jwt = segments.len() == 3
        && segments.iter().all(|segment| {
          !segment.is_empty()
            && segment
              .iter()
              .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        });
      if token.len() >= 30 && valid_jwt {
        output.push_str(&input[copied_through..index]);
        output.push_str("***");
        copied_through = token_end;
        index = token_end;
        continue;
      }
    }
    index += 1;
  }
  output.push_str(&input[copied_through..]);
  output
}

fn is_token_byte(byte: u8) -> bool {
  byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'~' | b'+' | b'/' | b'=')
}

fn scan_token(bytes: &[u8], start: usize, allowed: impl Fn(u8) -> bool) -> usize {
  let mut end = start;
  while bytes.get(end).is_some_and(|byte| allowed(*byte)) {
    end += 1;
  }
  end
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn uuid_v4_has_version_and_variant_bits() {
    let id = format_uuid_v4([0xff; 16]);
    assert_eq!(id, "ffffffff-ffff-4fff-bfff-ffffffffffff");
    assert!(is_uuid(&id));
    let random = new_uuid_v4().unwrap();
    assert!(is_uuid(&random));
    assert_eq!(&random[14..15], "4");
    assert_ne!(random, new_uuid_v4().unwrap());
  }

  #[test]
  fn is_uuid_accepts_only_the_8_4_4_4_12_hex_shape() {
    assert!(is_uuid("11111111-2222-4333-8444-555555555555"));
    assert!(is_uuid("01a13b6e-21d7-7093-8fc2-637efb0dd571"));
    assert!(!is_uuid("11111111-2222-4333-8444-55555555555"));
    assert!(!is_uuid("1111111g-2222-4333-8444-555555555555"));
    assert!(!is_uuid("--resume"));
    assert!(!is_uuid(""));
  }

  #[test]
  fn private_dir_files_are_0600_and_removed_on_drop() {
    let scratch = std::env::temp_dir().join(format!(
      "niho-local-ai-unit-{}-{}",
      std::process::id(),
      hex(&random_bytes::<4>().unwrap())
    ));
    let dir = PrivateDir::create(&scratch, TURN_DIR_PREFIX).unwrap();
    let file = dir.write("system-prompt.txt", "秘密の指示".as_bytes()).unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
      assert_eq!(fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777, 0o700);
      assert_eq!(fs::metadata(&scratch).unwrap().permissions().mode() & 0o777, 0o700);
    }
    assert_eq!(fs::read_to_string(&file).unwrap(), "秘密の指示");
    // 同じ名前は上書きしない（create_new）
    assert!(dir.write("system-prompt.txt", b"x").is_err());
    // 入れ子のフォルダは途中も 0700 で作り、その中にも 0600 で書ける
    let nested = dir.create_dir("ws/.agents/agents/x").unwrap();
    assert_eq!(nested, dir.path().join("ws/.agents/agents/x"));
    assert_eq!(dir.create_dir("ws").unwrap(), dir.path().join("ws"));
    let agent = dir.write("ws/.agents/agents/x/agent.md", b"---\n").unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      for sub in ["ws", "ws/.agents", "ws/.agents/agents", "ws/.agents/agents/x"] {
        let mode = fs::metadata(dir.path().join(sub)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "{sub}");
      }
      assert_eq!(fs::metadata(&agent).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // ファイルのある場所にはフォルダを作らない
    assert!(dir.create_dir("system-prompt.txt/x").is_err());
    let path = dir.path().to_path_buf();
    drop(dir);
    assert!(!path.exists());
    let _ = fs::remove_dir_all(scratch);
  }

  #[test]
  fn masks_long_secret_tokens_before_truncating() {
    assert_eq!(mask_secrets("key sk-ant-api03-abcdefghijkl end"), "key sk-*** end");
    assert_eq!(mask_secrets("short sk-foo stays"), "short sk-foo stays");
    assert_eq!(mask_secrets("skip sky sk"), "skip sky sk");
    assert_eq!(
      mask_secrets("Authorization: Bearer ya29.access-token-value"),
      "Authorization: Bearer ***"
    );
    assert_eq!(
      mask_secrets("refresh token 1//0abcdef0123456789"),
      "refresh token 1//0***"
    );
    assert_eq!(mask_secrets("AIza123456789012345678901234567890"), "AIza***");
    assert_eq!(
      mask_secrets("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456789"),
      "***"
    );
    assert_eq!(
      mask_secrets("received eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456789."),
      "received ***."
    );
    assert_eq!(mask_secrets("ghp_123456789012345678901234567890"), "ghp_***");
    let raw = format!("{}sk-proj-ABCDEFGHIJKLMNOP", "x".repeat(40));
    let tail = sanitize_stderr_tail(&raw, 12);
    assert!(!tail.contains("ABCDEFGH"));
    assert!(tail.starts_with('…'));
    // 末尾 6 バイト＝「えお」。文字の途中では切らない
    assert_eq!(sanitize_stderr_tail("  あいうえお\n", 6), "…えお");
    assert_eq!(sanitize_stderr_tail("あいうえお", 7), "…えお");
  }

  #[test]
  fn read_tail_keeps_only_the_last_bytes() {
    let data = vec![b'a'; 100].into_iter().chain(vec![b'b'; 10]).collect::<Vec<u8>>();
    assert_eq!(read_tail(Some(&data[..]), 10), vec![b'b'; 10]);
    assert_eq!(read_tail(None::<&[u8]>, 10), Vec::<u8>::new());
  }

  #[test]
  fn capture_returns_output_and_stops_after_its_time_limit() {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "printf out; printf err >&2; exit 3"]);
    let output = run_capture(command, Duration::from_secs(5), Duration::from_millis(100), 1024).unwrap();
    assert_eq!(output.status.code(), Some(3));
    assert_eq!(output.stdout, b"out");
    assert_eq!(output.stderr, b"err");

    let mut command = Command::new("/bin/sh");
    command.args(["-c", "trap '' TERM; sleep 30"]);
    #[cfg(unix)]
    {
      use std::os::unix::process::CommandExt;
      command.process_group(0);
    }
    let started = Instant::now();
    let error = run_capture(command, Duration::from_millis(100), Duration::from_millis(100), 1024).unwrap_err();
    assert!(matches!(error, CaptureError::TimedOut));
    assert!(started.elapsed() < Duration::from_secs(5));
  }

  #[test]
  fn running_turn_stop_is_refused_after_it_settles() {
    let turn = RunningTurn::new();
    assert!(!turn.is_stop_requested());
    assert!(turn.request_stop());
    assert!(turn.request_stop(), "a second stop while still running is accepted");
    assert!(turn.is_silenced());
    assert!(turn.settle());
    assert!(!turn.request_stop());
    let other = RunningTurn::new();
    assert!(!other.settle());
    assert!(!other.request_stop());
  }
}
