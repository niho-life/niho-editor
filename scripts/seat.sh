#!/usr/bin/env bash
# 既存の niho-editor-N seat を安全に再利用する。worktree の作成・削除はしない。
set -euo pipefail

top="$(git rev-parse --show-toplevel)"
top_name="$(basename "$top")"
if [[ "$top_name" =~ ^niho-editor-[0-9]+$ ]]; then
  repo_root="$(dirname "$top")/niho-editor"
else
  repo_root="$top"
fi
repo_root="$(cd "$repo_root" && pwd)"

is_seat() {
  [[ "$(basename "$1")" =~ ^niho-editor-[0-9]+$ ]]
}

dirty_count() {
  git -C "$1" status --porcelain | wc -l | tr -d ' '
}

branch_name() {
  git -C "$1" branch --show-current
}

detached_unreachable_count() {
  git -C "$1" rev-list --count HEAD --not --remotes
}

show_status() {
  local path branch dirty unreachable label found=0
  for path in "$(dirname "$repo_root")"/niho-editor-[0-9]*; do
    [[ -d "$path" ]] || continue
    is_seat "$path" || continue
    git -C "$path" rev-parse --is-inside-work-tree >/dev/null 2>&1 || continue
    found=1
    branch="$(branch_name "$path")"
    dirty="$(dirty_count "$path")"
    unreachable=0
    if [[ -z "$branch" ]]; then
      unreachable="$(detached_unreachable_count "$path")"
    fi
    if (( dirty > 0 )); then
      label="変更あり・保護"
    elif [[ -n "$branch" ]]; then
      label="再利用可・branch保持"
    elif (( unreachable > 0 )); then
      label="要確認・branchなしcommit $unreachable 件"
    else
      label="空き"
    fi
    printf '%-20s %-23s %s\n' "$(basename "$path")" "$label" "${branch:-（detached）}"
  done
  (( found == 1 )) || echo "既存の niho-editor-N seat が見つかりませんでした。新設しません。"
}

require_seat() {
  if ! is_seat "$top"; then
    echo "start/release は既存の niho-editor-N seat 内で実行してください。" >&2
    exit 1
  fi
  printf '%s' "$top"
}

start_topic() {
  local branch path
  branch="$1"
  path="$(require_seat)"
  git check-ref-format --branch "$branch" >/dev/null 2>&1 || {
    echo "branch 名が不正です: $branch" >&2
    exit 2
  }
  [[ "$(dirty_count "$path")" == "0" ]] || {
    echo "作業差分があります。内容を保護するため中断しました。" >&2
    git status -sb
    exit 1
  }
  git fetch --quiet origin
  if git show-ref --verify --quiet "refs/heads/$branch" ||
     git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    echo "branch が既にあります: $branch（既存 ref は自動で上書きしません）" >&2
    exit 1
  fi
  if [[ -z "$(branch_name "$path")" ]] && (( $(detached_unreachable_count "$path") > 0 )); then
    echo "detached HEAD に remote 未到達の commit があります。branch を付けて保護してください。" >&2
    exit 1
  fi
  git switch --quiet --no-track -c "$branch" origin/main
  echo "$branch を origin/main から作成しました。前の branch ref は残しています。"
}

release_seat() {
  local path
  path="$(require_seat)"
  [[ "$(dirty_count "$path")" == "0" ]] || {
    echo "作業差分があります。内容を保護するため中断しました。" >&2
    git status -sb
    exit 1
  }
  git fetch --quiet origin
  if [[ -z "$(branch_name "$path")" ]] && (( $(detached_unreachable_count "$path") > 0 )); then
    echo "detached HEAD に remote 未到達の commit があります。branch を付けて保護してください。" >&2
    exit 1
  fi
  git switch --quiet --detach origin/main
  echo "$(basename "$path") を origin/main に戻しました。既存 branch ref は削除していません。"
}

case "${1:-status}" in
  status)
    [[ $# -eq 1 ]] || { echo "usage: scripts/seat.sh status" >&2; exit 2; }
    show_status
    ;;
  start)
    [[ $# -eq 2 ]] || { echo "usage: scripts/seat.sh start <branch>" >&2; exit 2; }
    start_topic "$2"
    ;;
  release)
    [[ $# -eq 1 ]] || { echo "usage: scripts/seat.sh release" >&2; exit 2; }
    release_seat
    ;;
  *)
    echo "usage: scripts/seat.sh status | start <branch> | release" >&2
    exit 2
    ;;
esac
