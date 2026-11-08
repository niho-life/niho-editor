#!/bin/bash
#
# build-dmg.sh — NIHO docs の配布用 .dmg を作る（S4 #18385。NIHO Desktop の build-staff-dmg.sh の写し・Apple Silicon だけ・未公証）
# ============================================================================
#
# 作るもの（apps/docs/release/。gitignore。<sha> は HEAD の 12 桁）:
#   NIHO-docs-<版>-<sha>.dmg                 NIHO editor.app と Applications へのショートカット
#   NIHO-docs-<版>-<sha>.app.tar.gz（+ .sig）  自動更新の成果物（Tauri updater の署名付き）。署名鍵があるときだけ
#
# 流れ:
#   1. 版が 5 か所でそろっているか（docs-version.mjs check）と、sidecar.lock.json が今の sidecar のソースと合うか
#      （sidecar-lock.mjs check。合わなければ lock の更新と版上げを案内して止まる）
#   2. npm run sidecar:build（swift build -c release → src-tauri/binaries/niho-speech-aarch64-apple-darwin）と
#      sidecar-lock.mjs check-binary（lock の版を答え、arm64 で、macOS の外の dylib を読まない）
#   3. tauri build --bundles app --config src-tauri/tauri.sidecar.conf.json（niho-speech を externalBin として
#      .app の Contents/MacOS/niho-speech に入れ、.app を ad-hoc で署名する）。署名鍵と公開鍵があれば updater の成果物も作る
#      （createUpdaterArtifacts）
#   4. sidecar-lock.mjs check-app（.app の niho-speech が lock どおりで、署名 ID が変わっていない）・codesign --verify・Info.plist の版
#   5. hdiutil で dmg（Tauri の dmg は Finder の AppleScript に頼り、CI・SSH では作れないので自前で作る）
#   6. updater の成果物の署名を公開鍵で確かめてから release/ へ写す（updater-key.mjs verify。各 Mac の updater と同じ検証）
#
# 使い方（Apple Silicon の Mac。Node 24・Rust・Xcode 26（Swift 6.2 以上）が要る）:
#   ./apps/docs/scripts/build-dmg.sh
#
# 自動更新の署名鍵（Tauri updater の minisign。tauri.conf.json の pubkey と組の秘密鍵）:
#   TAURI_SIGNING_PRIVATE_KEY（中身かパス）・TAURI_SIGNING_PRIVATE_KEY_PASSWORD。無ければ ~/.niho/docs-updater.key。
#   どちらも無ければ updater の成果物を作らずに dmg だけ作る（ローカル確認用。このビルドは公式配布しない）。
#   tauri build は updater の成果物を作るとき tauri.conf.json の公開鍵を読むので、公開鍵がプレースホルダーのままなら
#   鍵があっても作らない。NIHO_DOCS_UPDATER_PUBKEY を渡すと、その公開鍵で .app を作り、署名もそれで確かめる
#   （過去の private release 用の処理。この .app は配らない）。
#
# 署名と公証: Developer ID の署名と公証はまだしない（NIHO Desktop・NIHO camera と同じ。owner 2026-10-15）。.app は Tauri が
# ad-hoc で署名する（tauri.conf.json の bundle.macOS.signingIdentity "-"。linker の署名だけだと codesign --verify が通らず、
# ブラウザで落とした dmg が「壊れている」扱いになりうる）。初回だけ システム設定 →「プライバシーとセキュリティ」→
# 「このまま開く」で許可が要る。自動更新で入れ替わった版は許可が要らない（updater の取得には隔離の印が付かない）。
# 署名し直しても sidecar の署名 ID は niho-speech のまま（実行ファイルに埋め込んだ Info.plist。check-app が確かめる）。
#
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
DOCS_DIR="${REPO_ROOT}/apps/docs"
SCRIPTS_DIR="${DOCS_DIR}/scripts"
BUNDLE_DIR="${DOCS_DIR}/target/release/bundle/macos"
OUT_DIR="${DOCS_DIR}/release"
APP_NAME="NIHO editor"
TARGET_TRIPLE="aarch64-apple-darwin"
STAGED_SIDECAR="${DOCS_DIR}/src-tauri/binaries/niho-speech-${TARGET_TRIPLE}"

log()  { printf '\033[36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✅ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m⚠️  %s\033[0m\n' "$*" >&2; }
err()  { printf '\033[31m❌ %s\033[0m\n' "$*" >&2; }

# --- 前提 --------------------------------------------------------------------
# 配布物は prod 固定。鍵は公開値だが、値をコマンドや診断へ出さない。
export NIHO_ACCOUNT_ENV="${NIHO_ACCOUNT_ENV:-prod}"
if [ "$NIHO_ACCOUNT_ENV" != "prod" ]; then
  err "配布用 dmg は NIHO_ACCOUNT_ENV=prod で作ってください。stg 受入は tauri build --debug を使います。"
  exit 1
fi
if [ -z "${NIHO_FIREBASE_API_KEY:-}" ]; then
  err "本番の公開 Web API key を NIHO_FIREBASE_API_KEY に設定してください。"
  exit 1
fi
if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  err "Apple Silicon の Mac 専用です（$(uname -s) $(uname -m)）。"
  exit 1
fi
node "${SCRIPTS_DIR}/docs-version.mjs" check
VERSION="$(node "${SCRIPTS_DIR}/docs-version.mjs" current)"
SHORT_SHA="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
if ! git -C "$REPO_ROOT" diff --quiet || ! git -C "$REPO_ROOT" diff --cached --quiet; then
  warn "未コミットの変更があります。この dmg は commit ${SHORT_SHA} の中身と一致しません。公式配布の候補には使わないでください。"
fi
node "${SCRIPTS_DIR}/sidecar-lock.mjs" check

if [ ! -x "${DOCS_DIR}/node_modules/.bin/tauri" ]; then
  log "依存を入れます（npm -C apps/docs ci）"
  npm -C "$DOCS_DIR" ci
fi

# --- 1. 文字起こし sidecar -----------------------------------------------------
log "niho-speech を release でビルドします（npm run sidecar:build = swift build -c release）"
npm -C "$DOCS_DIR" run sidecar:build
node "${SCRIPTS_DIR}/sidecar-lock.mjs" check-binary --binary "$STAGED_SIDECAR"

# --- 2. 自動更新の署名鍵 ---------------------------------------------------------
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ -f "${HOME}/.niho/docs-updater.key" ]; then
  TAURI_SIGNING_PRIVATE_KEY="${HOME}/.niho/docs-updater.key"
fi
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
TAURI_CONFIG_ARGS=(--config "${DOCS_DIR}/src-tauri/tauri.sidecar.conf.json")
UPDATER_ARTIFACTS=false
UPDATER_PUBKEY="${NIHO_DOCS_UPDATER_PUBKEY:-}"
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  warn "自動更新の署名鍵がありません（TAURI_SIGNING_PRIVATE_KEY・~/.niho/docs-updater.key）。updater の成果物は作りません（このビルドは配らない）。"
elif [ -z "$UPDATER_PUBKEY" ] && ! node "${SCRIPTS_DIR}/updater-key.mjs" status >/dev/null 2>&1; then
  warn "tauri.conf.json の updater の pubkey が未設定なので、updater の成果物は作れません（このビルドは配らない。README「配布」の鍵の手順）。"
else
  export TAURI_SIGNING_PRIVATE_KEY
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
  # 2 つ目の overlay（JSON の merge なので、1 つ目の externalBin は残る）。NIHO_DOCS_UPDATER_PUBKEY があれば公開鍵も差し替える
  node -e '
    const [file, pubkey] = process.argv.slice(1);
    const overlay = { bundle: { createUpdaterArtifacts: true } };
    if (pubkey) overlay.plugins = { updater: { pubkey } };
    require("node:fs").writeFileSync(file, JSON.stringify(overlay));
  ' "${STAGE}/tauri.updater.conf.json" "$UPDATER_PUBKEY"
  TAURI_CONFIG_ARGS+=(--config "${STAGE}/tauri.updater.conf.json")
  UPDATER_ARTIFACTS=true
  if [ -n "$UPDATER_PUBKEY" ]; then
    warn "NIHO_DOCS_UPDATER_PUBKEY の公開鍵で作ります（tauri.conf.json の pubkey ではない。このビルドは配らない）。"
  fi
fi

# --- 3. Tauri のビルド ---------------------------------------------------------
log "NIHO docs ${VERSION}（${SHORT_SHA}）をビルドします（.app・niho-speech 同梱・updater の成果物=${UPDATER_ARTIFACTS}）… 数分かかります"
# 前のビルドの updater の成果物を拾わない（このビルドが作ったものだけを確かめて配る）
rm -f "${BUNDLE_DIR}/${APP_NAME}.app.tar.gz" "${BUNDLE_DIR}/${APP_NAME}.app.tar.gz.sig"
npm -C "$DOCS_DIR" run tauri -- build --bundles app "${TAURI_CONFIG_ARGS[@]}"

APP_PATH="${BUNDLE_DIR}/${APP_NAME}.app"
if [ ! -d "$APP_PATH" ]; then
  err "ビルドの成果物がありません: ${APP_PATH}"
  exit 1
fi
node "${SCRIPTS_DIR}/sidecar-lock.mjs" check-app --app "$APP_PATH"
# ad-hoc の署名が .app 全体（Info.plist と中のファイル）に掛かっているか。linker の署名だけに戻ると、落とした dmg が開けなくなりうる
if ! codesign --verify --deep --strict "$APP_PATH"; then
  err ".app の署名が正しくありません（tauri.conf.json の bundle.macOS.signingIdentity \"-\" を確かめてください）。"
  exit 1
fi
APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${APP_PATH}/Contents/Info.plist")"
if [ "$APP_VERSION" != "$VERSION" ]; then
  err ".app の版が ${APP_VERSION} です（期待は ${VERSION}）。"
  exit 1
fi
ok "アプリをビルドしました: ${APP_PATH}"

# --- 4. dmg ------------------------------------------------------------------
BASE_NAME="NIHO-docs-${VERSION}-${SHORT_SHA}"
OUT_DMG="${OUT_DIR}/${BASE_NAME}.dmg"
OUT_TARBALL="${OUT_DIR}/${BASE_NAME}.app.tar.gz"
mkdir -p "$OUT_DIR"
rm -f "$OUT_DMG" "$OUT_TARBALL" "${OUT_TARBALL}.sig"

DMG_ROOT="${STAGE}/dmg"
mkdir -p "$DMG_ROOT"
cp -R "$APP_PATH" "$DMG_ROOT/"
ln -s /Applications "$DMG_ROOT/Applications"
log "dmg を作ります: ${OUT_DMG}"
hdiutil create -volname "$APP_NAME" -srcfolder "$DMG_ROOT" -ov -format UDZO "$OUT_DMG" >/dev/null

# --- 5. 自動更新の成果物 -----------------------------------------------------------
if $UPDATER_ARTIFACTS; then
  UPDATER_SRC="${BUNDLE_DIR}/${APP_NAME}.app.tar.gz"
  if [ ! -f "$UPDATER_SRC" ] || [ ! -f "${UPDATER_SRC}.sig" ]; then
    err "updater の成果物（.app.tar.gz・.sig）がありません。署名鍵とパスワードを確認してください。"
    exit 1
  fi
  # 各 Mac の updater と同じ検証（.app に入れた公開鍵で .sig を確かめる）。tauri build は秘密鍵と公開鍵の組を確かめないので、
  # 取り違えた組はここで止める（release/ には確かめた成果物だけを置く）
  if [ -n "$UPDATER_PUBKEY" ]; then
    node "${SCRIPTS_DIR}/updater-key.mjs" verify --file "$UPDATER_SRC" --sig "${UPDATER_SRC}.sig" --pubkey "$UPDATER_PUBKEY"
  else
    node "${SCRIPTS_DIR}/updater-key.mjs" verify --file "$UPDATER_SRC" --sig "${UPDATER_SRC}.sig"
  fi
  cp "$UPDATER_SRC" "$OUT_TARBALL"
  cp "${UPDATER_SRC}.sig" "${OUT_TARBALL}.sig"
  ok "updater の成果物: ${OUT_TARBALL}（+ .sig）"
fi

ok "できました: ${OUT_DMG}"
echo "これはローカル確認用のdmgです。公式公開は editor-mac-candidate.yml の候補と scripts/editor-candidate/sign-and-publish.sh を使ってください。"
echo "未公証なので、ブラウザで落とした dmg の初回だけ システム設定 →「プライバシーとセキュリティ」→「このまま開く」で許可が要ります。"
