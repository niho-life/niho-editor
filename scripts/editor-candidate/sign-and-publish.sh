#!/bin/bash
#
# sign-and-publish.sh — 公開 CI が作った署名前の Mac 候補（editor-mac-candidate.yml の prerelease）を、オーナーの Mac で
# 検証・再確認・署名し、このリポジトリの公開 Release docs-v<版>-<sha12> に上げる（docs/architecture/editor-release-boundary.md §4）。
# ============================================================================
#
# 何をするか（どこかで止まったら、そこまで。候補の中の binary・script は実行しない）:
#   1. 候補の tag から 版・製品 source の SHA・run id・attempt を読む。Release の target（controller の SHA）と合わせて、
#      どちらも origin/main に含まれることを確かめる。
#   2. 候補の 5 つの asset を取り、GitHub の実行証明（sigstore）を gh attestation verify で確かめる
#      （この repo の editor-mac-candidate.yml が refs/heads/main の controller SHA で、GitHub-hosted runner で作った manifest であること）。
#   3. candidate.py recheck: manifest / receipt / file hash の照合（validate）に加え、tar を展開して inventory を作り直し、
#      bundle identifier・版・codesign・dmg の中身を、この Mac の codesign / hdiutil で見る（CI の receipt を信用しない）。
#   4. 公開鍵の組: 製品 source の tauri.conf.json の pubkey の SHA-256 が manifest の updaterPublicKeySha256 と同じ。
#   5. 版: 製品 source が見る公開 Release の latest.json と、公開済みの docs-v* の tag より大きい。
#   6. 更新の鍵（minisign）で .app.tar.gz に署名し、updater-key.mjs verify で 4 の公開鍵と確かめる。
#   7. Tauri 形式の latest.json を生成し、全 asset を draft Release に置いて検証後に公開・latest 切り替えを行う。
#      NIHO-docs-<版>-<sha12>.dmg / .dmg.sha256 / .app.tar.gz / .app.tar.gz.sig と候補の manifest・実行証明も同梱する。
#
# 使い方:
#   scripts/editor-candidate/sign-and-publish.sh <候補の tag> [--dry-run]
#     <候補の tag>  editor-candidate-v<X.Y.Z>-<source の 40 桁 SHA>-run-<run id>-attempt-<attempt>
#     --dry-run     1〜6 まで行い、Release は作らない・上げない
#   環境変数:
#     GH                              gh の呼び方（既定 gh。ghN のようなラッパーでもよい）
#     NIHO_DOCS_UPDATER_KEY           minisign の秘密鍵（既定 ~/.niho/docs-updater.key。権限 600）
#     NIHO_DOCS_UPDATER_KEY_PASSWORD  鍵のパスワード（既定 空）
#     NIHO_DOCS_SKIP_FEED=1           初回移行時だけ、まだない公開 latest.json を版チェックから省く
#
# 前提: Apple Silicon の Mac（codesign・hdiutil）、python3、node 24、apps/docs の node_modules（tauri CLI。npm -C apps/docs ci）、
#       gh が niho-life/niho-editor に書ける認証。鍵は読むだけで、画面・ログ・一時ファイルに出さない。
#
set -euo pipefail

REPO_SLUG="niho-life/niho-editor"
WORKFLOW_PATH=".github/workflows/editor-mac-candidate.yml"
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
SCRIPT_DIR="${REPO_ROOT}/scripts/editor-candidate"
DOCS_DIR="${REPO_ROOT}/apps/docs"
GH="${GH:-gh}"
KEY="${NIHO_DOCS_UPDATER_KEY:-${HOME}/.niho/docs-updater.key}"
DRY_RUN=0
TAG=""

log() { printf '%s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }
usage() {
  cat >&2 <<'EOF'
sign-and-publish.sh <候補の tag> [--dry-run]
  候補の tag: editor-candidate-v<X.Y.Z>-<source の 40 桁 SHA>-run-<run id>-attempt-<attempt>
  --dry-run : 検証・再確認・署名まで行い、Release は作らない・上げない
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) log "unknown option: $arg"; usage; exit 2 ;;
    *)
      if [ -n "$TAG" ]; then log "候補の tag は 1 つだけ渡してください"; usage; exit 2; fi
      TAG="$arg"
      ;;
  esac
done
if [ -z "$TAG" ]; then usage; exit 2; fi

# ---- 1. 候補の tag を読む（形が違えば何もしない。ネットワークにも触らない） ----
CANDIDATE_RE='^editor-candidate-v((0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))-([a-f0-9]{40})-run-([1-9][0-9]*)-attempt-([1-9][0-9]*)$'
[[ "$TAG" =~ $CANDIDATE_RE ]] || die "候補の tag の形ではありません: ${TAG}"
VERSION="${BASH_REMATCH[1]}"
SOURCE_SHA="${BASH_REMATCH[5]}"
RUN_ID="${BASH_REMATCH[6]}"
RUN_ATTEMPT="${BASH_REMATCH[7]}"
SHORT_SHA="${SOURCE_SHA:0:12}"
RELEASE_TAG="docs-v${VERSION}-${SHORT_SHA}"
ASSET_BASE="NIHO-docs-${VERSION}-${SHORT_SHA}"

# ---- 前提 ----
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "Apple Silicon の Mac で実行してください（候補の再確認に codesign・hdiutil を使う）"
for tool in python3 node curl shasum; do
  command -v "$tool" >/dev/null || die "${tool} がありません"
done
[ -x "${DOCS_DIR}/node_modules/.bin/tauri" ] || die "apps/docs の node_modules がありません（npm -C apps/docs ci）"
[ -f "$KEY" ] && [ ! -L "$KEY" ] || die "署名鍵がありません: ${KEY}（NIHO_DOCS_UPDATER_KEY で場所を指定できます）"
KEY_MODE="$(stat -f %Lp "$KEY")"
case "$KEY_MODE" in
  600|400) ;;
  *) die "署名鍵の権限が ${KEY_MODE} です（chmod 600 にしてください）: ${KEY}" ;;
esac
"$GH" auth status >/dev/null 2>&1 || die "gh が GitHub に認証されていません（${GH} auth status）"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/editor-sign-publish.XXXXXX")"
chmod 700 "$WORK"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

log "候補 ${TAG}"
log "  版 ${VERSION} / 製品 source ${SOURCE_SHA} / run ${RUN_ID} attempt ${RUN_ATTEMPT}"

git -C "$REPO_ROOT" fetch -q --no-tags origin main
git -C "$REPO_ROOT" merge-base --is-ancestor "$SOURCE_SHA" origin/main || die "製品 source ${SOURCE_SHA} は origin/main に含まれていません"

"$GH" release view "$TAG" --repo "$REPO_SLUG" --json targetCommitish,isPrerelease,isDraft,assets >"${WORK}/candidate-release.json" \
  || die "候補の Release ${TAG} を読めません"
# Release の JSON から 1 つ読む（assets は名前を並べて返す）
read_release() {
  node -e '
    const release = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const value = release[process.argv[2]];
    process.stdout.write(Array.isArray(value) ? value.map((asset) => asset.name).sort().join("\n") : String(value));
  ' "${WORK}/candidate-release.json" "$1"
}
CONTROLLER_SHA="$(read_release targetCommitish)"
[[ "$CONTROLLER_SHA" =~ ^[a-f0-9]{40}$ ]] || die "候補の Release の target が commit ではありません: ${CONTROLLER_SHA}"
git -C "$REPO_ROOT" merge-base --is-ancestor "$CONTROLLER_SHA" origin/main || die "controller ${CONTROLLER_SHA} は origin/main に含まれていません"
[ "$(read_release isPrerelease)" = true ] && [ "$(read_release isDraft)" = false ] || die "候補の Release は prerelease（draft でない）のはずです: ${TAG}"
EXPECTED_ASSETS="$(printf '%s\n' editor-candidate-mac.json editor-candidate.app.tar.gz editor-candidate.dmg editor-candidate.json editor-candidate.sigstore.json | LC_ALL=C sort)"
[ "$(read_release assets)" = "$EXPECTED_ASSETS" ] || die "候補の asset が 5 つそろっていません（別の attempt の候補を使ってください）"

# ---- 2. asset を取り、実行証明を確かめる ----
mkdir "${WORK}/raw"
log "asset を取ります"
"$GH" release download "$TAG" --repo "$REPO_SLUG" --dir "${WORK}/raw" --pattern 'editor-candidate*'
DOWNLOADED="$(find "${WORK}/raw" -mindepth 1 -maxdepth 1 -print | sed 's#.*/##' | LC_ALL=C sort)"
[ "$DOWNLOADED" = "$EXPECTED_ASSETS" ] || die "取得した asset が 5 つと一致しません"

log "実行証明を確かめます（${WORKFLOW_PATH} @ main, controller ${CONTROLLER_SHA:0:12}）"
"$GH" attestation verify "${WORK}/raw/editor-candidate.json" --repo "$REPO_SLUG" \
  --bundle "${WORK}/raw/editor-candidate.sigstore.json" \
  --signer-workflow "${REPO_SLUG}/${WORKFLOW_PATH}" --signer-digest "$CONTROLLER_SHA" \
  --source-ref refs/heads/main --source-digest "$CONTROLLER_SHA" \
  --deny-self-hosted-runners >/dev/null \
  || die "実行証明が確かめられません（この repo の main の editor-mac-candidate.yml が GitHub-hosted runner で作った候補ではない）"

# ---- 3. 照合と、この Mac での再確認 ----
mkdir "${WORK}/validated"
for name in editor-candidate.dmg editor-candidate.app.tar.gz editor-candidate-mac.json editor-candidate.json; do
  mv "${WORK}/raw/${name}" "${WORK}/validated/${name}"
done
log "manifest・receipt・hash を照合し、tar と dmg の中身をこの Mac で再確認します（数十秒）"
python3 "${SCRIPT_DIR}/candidate.py" recheck --directory "${WORK}/validated" --version "$VERSION" \
  --source-sha "$SOURCE_SHA" --controller-sha "$CONTROLLER_SHA" --run-id "$RUN_ID" --run-attempt "$RUN_ATTEMPT" \
  || die "候補の再確認で止まりました（上の {stage,kind}）"

# ---- 4. 公開鍵の組 ----
# 製品 source の tauri.conf.json（配る .app に入る updater の設定）。公開鍵と、各 Mac が見るフィードの URL はここから読む（直書きしない）
SOURCE_CONF="${WORK}/source-tauri.conf.json"
git -C "$REPO_ROOT" show "${SOURCE_SHA}:apps/docs/src-tauri/tauri.conf.json" >"$SOURCE_CONF" || die "製品 source の tauri.conf.json を読めません"
read_updater_conf() {
  node -e '
    const updater = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))?.plugins?.updater ?? {};
    const value = process.argv[2] === "pubkey" ? updater.pubkey : updater.endpoints?.[0];
    if (typeof value !== "string" || value.trim() === "" || value.trim() === "REPLACE_WITH_DOCS_UPDATER_PUBKEY") process.exit(1);
    process.stdout.write(value.trim());
  ' "$SOURCE_CONF" "$1"
}
PUBKEY="$(read_updater_conf pubkey)" || die "製品 source の tauri.conf.json に更新の公開鍵がありません"
PUBKEY_SHA="$(printf '%s' "$PUBKEY" | shasum -a 256 | awk '{ print $1 }')"
MANIFEST_PUBKEY_SHA="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).updaterPublicKeySha256))' "${WORK}/validated/editor-candidate.json")"
[ "$PUBKEY_SHA" = "$MANIFEST_PUBKEY_SHA" ] || die "候補に入っている公開鍵が、製品 source の tauri.conf.json の公開鍵と違います"

# ---- 5. 版 ----
semver_gt() {
  node -e '
    const parse = (text) => text.split(".").map(Number);
    const [a, b] = [parse(process.argv[1]), parse(process.argv[2])];
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) process.exit(a[i] > b[i] ? 0 : 1);
    process.exit(1);
  ' "$1" "$2"
}
REMOTE_TAGS="$(git -C "$REPO_ROOT" ls-remote --tags origin 'refs/tags/docs-v*')"
LATEST_TAG="$(printf '%s\n' "$REMOTE_TAGS" | node "${DOCS_DIR}/scripts/docs-version.mjs" latest)"
PREVIOUS_TAG=""
if [ -n "$LATEST_TAG" ] && [ "$LATEST_TAG" != "$RELEASE_TAG" ]; then
  LATEST_RE='^docs-v((0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))-'
  [[ "$LATEST_TAG" =~ $LATEST_RE ]] || die "公開済みの tag の形を読めません: ${LATEST_TAG}"
  semver_gt "$VERSION" "${BASH_REMATCH[1]}" || die "版 ${VERSION} は公開済みの ${LATEST_TAG} 以下です（大きい版で候補を作り直してください）"
  PREVIOUS_TAG="$LATEST_TAG"
fi
FEED_URL="$(read_updater_conf endpoint)" || die "製品 source の tauri.conf.json に更新フィードの URL がありません"
EXPECTED_FEED_URL="https://github.com/${REPO_SLUG}/releases/latest/download/latest.json"
[ "$FEED_URL" = "$EXPECTED_FEED_URL" ] || die "更新フィードはこのリポジトリの latest.json を指す必要があります: ${EXPECTED_FEED_URL}"
FEED_VERSION="$(curl -fsSL --max-time 30 "${FEED_URL}?t=$(date +%s)" 2>/dev/null \
  | node -e '
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
      try { const version = JSON.parse(text).version; process.stdout.write(typeof version === "string" ? version : ""); } catch { process.stdout.write(""); }
    });
  ' || true)"
if [ -n "$FEED_VERSION" ]; then
  if [ "$FEED_VERSION" = "$VERSION" ] && [ "$LATEST_TAG" = "$RELEASE_TAG" ]; then
    log "更新フィードはこのReleaseの版（${VERSION}）です。公開済みassetの一致を確認します"
  else
    semver_gt "$VERSION" "$FEED_VERSION" || die "版 ${VERSION} は配布済みの版（更新フィード ${FEED_VERSION}）以下です"
  fi
elif [ "${NIHO_DOCS_SKIP_FEED:-0}" = 1 ]; then
  log "更新フィードを読めませんでした。NIHO_DOCS_SKIP_FEED=1 なので、公開済みの tag とだけ比べます"
else
  die "更新フィード ${FEED_URL} から版を読めませんでした（204 か失敗）。意図どおりなら NIHO_DOCS_SKIP_FEED=1 で進めます"
fi

# ---- 6. 署名 ----
OUT="${WORK}/out"
mkdir "$OUT"
DMG="${OUT}/${ASSET_BASE}.dmg"
TARBALL="${OUT}/${ASSET_BASE}.app.tar.gz"
SIG="${TARBALL}.sig"
cp "${WORK}/validated/editor-candidate.dmg" "$DMG"
cp "${WORK}/validated/editor-candidate.app.tar.gz" "$TARBALL"
cp "${WORK}/validated/editor-candidate.json" "${OUT}/${ASSET_BASE}.candidate.json"
cp "${WORK}/raw/editor-candidate.sigstore.json" "${OUT}/${ASSET_BASE}.candidate.sigstore.json"
log "署名します（鍵: ${KEY}）"
# 鍵は path で渡す。環境に残っている別の鍵の指定は使わない（組の取り違えを防ぐ）
unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PATH
SIGN_ARGS=(--private-key-path "$KEY")
if [ -z "${NIHO_DOCS_UPDATER_KEY_PASSWORD-}" ]; then
  SIGN_ARGS+=(--password "")
else
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$NIHO_DOCS_UPDATER_KEY_PASSWORD"
fi
(cd "$DOCS_DIR" && ./node_modules/.bin/tauri signer sign "${SIGN_ARGS[@]}" "$TARBALL" >/dev/null) || die "署名に失敗しました"
[ -f "$SIG" ] || die "署名ファイルができていません: ${SIG}"
node "${DOCS_DIR}/scripts/updater-key.mjs" verify --file "$TARBALL" --sig "$SIG" --pubkey "$PUBKEY" \
  || die "署名が製品 source の公開鍵と合いません（秘密鍵と tauri.conf.json の pubkey は同じ tauri signer generate の組にする）"
shasum -a 256 "$DMG" | awk '{ print $1 }' >"${DMG}.sha256"
DMG_SHA="$(cat "${DMG}.sha256")"
node "${SCRIPT_DIR}/updater-manifest.mjs" create \
  --version "$VERSION" --tag "$RELEASE_TAG" --asset-name "${ASSET_BASE}.app.tar.gz" \
  --signature-file "$SIG" --output "${OUT}/latest.json" --notes "NIHO editor ${VERSION}"

log "成果物:"
for file in "$OUT"/*; do log "  $(basename "$file")"; done
log "  sha256(dmg): ${DMG_SHA}"
log "  Release    : ${RELEASE_TAG}（target ${SOURCE_SHA}）"
if [ -n "$PREVIOUS_TAG" ]; then log "  前の公開   : ${PREVIOUS_TAG}"; fi

if [ "$DRY_RUN" = 1 ]; then
  log "dry-run: Release の作成・asset の upload はしません"
  exit 0
fi

# ---- 7. 公開 ----
NOTES="${WORK}/notes.md"
cat >"$NOTES" <<EOF
NIHO editor（Apple Silicon の Mac・未公証）の配布 .dmg と自動更新の成果物。公開 CI の署名前候補をオーナーの Mac で検証・再確認し、更新の鍵で署名した（docs/architecture/editor-release-boundary.md §4）。

- version: \`${VERSION}\`
- 製品 source: \`${SOURCE_SHA}\`
- 候補: [${TAG}](https://github.com/${REPO_SLUG}/releases/tag/${TAG})（controller \`${CONTROLLER_SHA}\`・[run ${RUN_ID}](https://github.com/${REPO_SLUG}/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}) attempt ${RUN_ATTEMPT}）
- dmg: \`${ASSET_BASE}.dmg\`
- sha-256: \`${DMG_SHA}\`
EOF
if [ -n "$PREVIOUS_TAG" ]; then
  printf -- '- 前の公開（%s）からの変更: https://github.com/%s/compare/%s...%s\n' "$PREVIOUS_TAG" "$REPO_SLUG" "$PREVIOUS_TAG" "$RELEASE_TAG" >>"$NOTES"
fi
cat >>"$NOTES" <<'EOF'

入れ方は apps/docs/README.md「配布」。未公証なので、ブラウザで落とした dmg の初回だけ
システム設定 →「プライバシーとセキュリティ」→「このまま開く」で許可が要ります。
更新フィードはこの Release の latest.json です。旧フィードを使う既存インストールは、最初の一度だけ dmg の手動入れ替えが要ります。
EOF

if EXISTING_JSON="$("$GH" release view "$RELEASE_TAG" --repo "$REPO_SLUG" --json targetCommitish,isDraft,assets 2>/dev/null)"; then
  EXISTING_TARGET="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).targetCommitish)' "$EXISTING_JSON")"
  [ "$EXISTING_TARGET" = "$SOURCE_SHA" ] || die "Release ${RELEASE_TAG} は別の commit（${EXISTING_TARGET}）を指しています"
  EXISTING_DRAFT="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).isDraft))' "$EXISTING_JSON")"
  if [ "$EXISTING_DRAFT" = false ]; then
    PUBLISHED_LATEST_TAG="$("$GH" api "repos/${REPO_SLUG}/releases/latest" --jq .tag_name)"
    [ "$PUBLISHED_LATEST_TAG" = "$RELEASE_TAG" ] || die "Release ${RELEASE_TAG} は公開済みですが、現在の latest は ${PUBLISHED_LATEST_TAG} です。古い Release を再公開しません"
    EXPECTED_RELEASE_ASSETS="$(find "$OUT" -mindepth 1 -maxdepth 1 -type f -exec basename {} \; | LC_ALL=C sort)"
    ACTUAL_RELEASE_ASSETS="$(printf '%s' "$EXISTING_JSON" | node -e 'const release = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(release.assets.map((asset) => asset.name).sort().join("\n"))')"
    [ "$ACTUAL_RELEASE_ASSETS" = "$EXPECTED_RELEASE_ASSETS" ] || die "公開済み Release の asset 一覧が今回の作成物と違います。上書きせずに止めました"
    mkdir "${WORK}/published"
    "$GH" release download "$RELEASE_TAG" --repo "$REPO_SLUG" --dir "${WORK}/published" \
      --pattern "${ASSET_BASE}.app.tar.gz" --pattern "${ASSET_BASE}.app.tar.gz.sig" --pattern latest.json
    cmp -s "$TARBALL" "${WORK}/published/${ASSET_BASE}.app.tar.gz" || die "公開済み updater archive が今回の候補と異なります"
    node "${DOCS_DIR}/scripts/updater-key.mjs" verify --file "${WORK}/published/${ASSET_BASE}.app.tar.gz" \
      --sig "${WORK}/published/${ASSET_BASE}.app.tar.gz.sig" --pubkey "$PUBKEY" \
      || die "公開済み updater archive の署名が確かめられません"
    node -e '
      const fs = require("fs");
      const feed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const signature = fs.readFileSync(process.argv[2], "utf8").trim();
      const platform = feed.platforms?.["darwin-aarch64"];
      const expectedUrl = "https://github.com/niho-life/niho-editor/releases/download/" + process.argv[4] + "/" + process.argv[5];
      if (feed.version !== process.argv[3] || platform?.signature !== signature || platform?.url !== expectedUrl) process.exit(1);
    ' "${WORK}/published/latest.json" "${WORK}/published/${ASSET_BASE}.app.tar.gz.sig" "$VERSION" "$RELEASE_TAG" "${ASSET_BASE}.app.tar.gz" \
      || die "公開済み latest.json が Release の updater asset と一致しません"
    log "Release ${RELEASE_TAG} は完全で、署名・候補・latest.json が一致しています。再公開は不要です"
    exit 0
  fi
  log "未公開 draft Release ${RELEASE_TAG} を再利用します"
else
  log "draft Release ${RELEASE_TAG} を作ります"
  "$GH" release create "$RELEASE_TAG" --repo "$REPO_SLUG" --target "$SOURCE_SHA" \
    --title "NIHO editor ${VERSION} (${SHORT_SHA})" --notes-file "$NOTES" --draft --latest=false
fi
log "draft に asset を上げます"
"$GH" release upload "$RELEASE_TAG" --repo "$REPO_SLUG" --clobber "$OUT"/*

EXPECTED_RELEASE_ASSETS="$(find "$OUT" -mindepth 1 -maxdepth 1 -type f -exec basename {} \; | LC_ALL=C sort)"
ACTUAL_RELEASE_ASSETS="$("$GH" release view "$RELEASE_TAG" --repo "$REPO_SLUG" --json assets \
  | node -e 'const release = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(release.assets.map((asset) => asset.name).sort().join("\n"))')"
[ "$ACTUAL_RELEASE_ASSETS" = "$EXPECTED_RELEASE_ASSETS" ] || die "draft Release の asset 一覧が作成物と一致しません。公開せずに止めました"

log "asset を確認しました。Release を公開し、latest を切り替えます"
"$GH" release edit "$RELEASE_TAG" --repo "$REPO_SLUG" --draft=false --latest
PUBLISHED_LATEST_TAG="$("$GH" api "repos/${REPO_SLUG}/releases/latest" --jq .tag_name)"
[ "$PUBLISHED_LATEST_TAG" = "$RELEASE_TAG" ] || die "latest Release が切り替わっていません: ${PUBLISHED_LATEST_TAG}"
PUBLISHED_FEED="${WORK}/published-latest.json"
curl -fsSL --max-time 60 "${FEED_URL}?t=$(date +%s)" -o "$PUBLISHED_FEED" \
  || die "公開した updater feed を読み戻せません: ${FEED_URL}"
cmp -s "${OUT}/latest.json" "$PUBLISHED_FEED" || die "公開した latest.json が作成物と一致しません"

log ""
log "done: $("$GH" release view "$RELEASE_TAG" --repo "$REPO_SLUG" --json url --jq .url)"
log "updater feed verified: ${FEED_URL} -> ${VERSION}"
