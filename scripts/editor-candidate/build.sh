#!/bin/bash
# Build an unsigned public editor candidate on GitHub-hosted Apple Silicon.
set -euo pipefail

fail() { printf '{"stage":"build","kind":"%s"}\n' "$1" >&2; exit 1; }

[ "$#" -eq 7 ] || { printf 'usage: build.sh PRODUCT_DIR OUTPUT_DIR VERSION SOURCE_SHA CONTROLLER_SHA RUN_ID RUN_ATTEMPT\n' >&2; exit 2; }
PRODUCT_DIR="$(cd "$1" && pwd -P)"
CONTROL_DIR="$(git -C "$(dirname "$0")/../.." rev-parse --show-toplevel)"
OUTPUT_DIR="$2"
VERSION="$3"
SOURCE_SHA="$4"
CONTROLLER_SHA="$5"
RUN_ID="$6"
RUN_ATTEMPT="$7"

[[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || fail InvalidVersion
[[ "$SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]] || fail InvalidSourceSha
[[ "$CONTROLLER_SHA" =~ ^[a-f0-9]{40}$ ]] || fail InvalidControllerSha
[[ "$RUN_ID" =~ ^[1-9][0-9]*$ ]] && [[ "$RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]] || fail InvalidRun
[ "${GITHUB_ACTIONS:-}" = true ] && [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] || fail WrongRunner
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] && [ "$(id -u)" != 0 ] || fail WrongPlatform
[ "${GITHUB_REPOSITORY:-}" = niho-life/niho-editor ] || fail WrongRepository
[ "${GITHUB_REF:-}" = refs/heads/main ] || fail WrongRef
[ "${GITHUB_SHA:-}" = "$CONTROLLER_SHA" ] || fail WrongController
[ "${GITHUB_RUN_ID:-}" = "$RUN_ID" ] && [ "${GITHUB_RUN_ATTEMPT:-}" = "$RUN_ATTEMPT" ] || fail WrongRun
case "${GITHUB_WORKFLOW_REF:-}" in
  "niho-life/niho-editor/.github/workflows/editor-mac-candidate.yml@refs/heads/main") ;;
  *) fail WrongWorkflow ;;
esac
[ "$(git -C "$CONTROL_DIR" rev-parse HEAD)" = "$CONTROLLER_SHA" ] || fail WrongControllerCheckout
[ "$CONTROL_DIR" != "$PRODUCT_DIR" ] || fail CheckoutIsolation
[ "$(git -C "$PRODUCT_DIR" rev-parse HEAD)" = "$SOURCE_SHA" ] || fail WrongSource

for key in TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD NIHO_DOCS_UPDATER_PUBKEY APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH AC_PASSWORD AC_USERNAME AC_TEAM_ID; do
  if declare -p "$key" >/dev/null 2>&1; then fail SigningEnvironment; fi
done
[ -n "${NIHO_FIREBASE_API_KEY:-}" ] && [ "$NIHO_FIREBASE_API_KEY" != ci-not-for-login ] || fail InvalidClientConfig
case "$OUTPUT_DIR" in /*) ;; *) OUTPUT_DIR="${PRODUCT_DIR}/${OUTPUT_DIR}" ;; esac
[ ! -e "$OUTPUT_DIR" ] || fail ExistingOutput
mkdir -p "$(dirname "$OUTPUT_DIR")"

REAL_HOME="${HOME:?HOME is required}"
case "${RUSTUP_HOME:-${REAL_HOME}/.rustup}" in /*) BUILD_RUSTUP_HOME="${RUSTUP_HOME:-${REAL_HOME}/.rustup}" ;; *) fail InvalidRustupHome ;; esac
case "${CARGO_HOME:-${REAL_HOME}/.cargo}" in /*) BUILD_CARGO_HOME="${CARGO_HOME:-${REAL_HOME}/.cargo}" ;; *) fail InvalidCargoHome ;; esac
TEMP_ROOT="$(mktemp -d "${RUNNER_TEMP:?RUNNER_TEMP is required}/editor-public-candidate.XXXXXX")"
cleanup() { rm -rf "$TEMP_ROOT"; }
trap cleanup EXIT
export HOME="$TEMP_ROOT/home" RUSTUP_HOME="$BUILD_RUSTUP_HOME" CARGO_HOME="$BUILD_CARGO_HOME"
mkdir -p "$HOME"
unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD NIHO_DOCS_UPDATER_PUBKEY GH_TOKEN GITHUB_TOKEN

node "$PRODUCT_DIR/apps/docs/scripts/docs-version.mjs" apply "$VERSION"
npm -C "$PRODUCT_DIR/apps/docs" ci
"$PRODUCT_DIR/apps/docs/scripts/build-dmg.sh"

SHORT_SHA="${SOURCE_SHA:0:12}"
SOURCE_DMG="$PRODUCT_DIR/apps/docs/release/NIHO-docs-${VERSION}-${SHORT_SHA}.dmg"
APP="$PRODUCT_DIR/apps/docs/target/release/bundle/macos/NIHO editor.app"
[ -f "$SOURCE_DMG" ] && [ ! -L "$SOURCE_DMG" ] && [ -d "$APP" ] && [ ! -L "$APP" ] || fail MissingBuildOutput
STAGE="$TEMP_ROOT/output"
mkdir "$STAGE"
cp "$SOURCE_DMG" "$STAGE/editor-candidate.dmg"
COPYFILE_DISABLE=1 /usr/bin/tar --no-xattrs -czf "$STAGE/editor-candidate.app.tar.gz" -C "$(dirname "$APP")" "$(basename "$APP")"

export CANDIDATE_PRODUCT_DIR="$PRODUCT_DIR" CANDIDATE_STAGE="$STAGE" CANDIDATE_VERSION="$VERSION" CANDIDATE_SOURCE_SHA="$SOURCE_SHA"
export CANDIDATE_CONTROLLER_SHA="$CONTROLLER_SHA" CANDIDATE_RUN_ID="$RUN_ID" CANDIDATE_RUN_ATTEMPT="$RUN_ATTEMPT"
python3 - <<'PY'
import hashlib, json, os
from pathlib import Path

root = Path(os.environ["CANDIDATE_PRODUCT_DIR"])
stage = Path(os.environ["CANDIDATE_STAGE"])
config_bytes = (root / "apps/docs/src-tauri/tauri.conf.json").read_bytes()
config = json.loads(config_bytes)
lock_bytes = (root / "apps/docs/sidecar.lock.json").read_bytes()
pubkey = config["plugins"]["updater"]["pubkey"].strip().encode()
value = {
    "sourceSha": os.environ["CANDIDATE_SOURCE_SHA"],
    "controllerSha": os.environ["CANDIDATE_CONTROLLER_SHA"],
    "version": os.environ["CANDIDATE_VERSION"],
    "run": {"id": os.environ["CANDIDATE_RUN_ID"], "attempt": os.environ["CANDIDATE_RUN_ATTEMPT"]},
    "app": {"identifier": config["identifier"], "name": config["productName"]},
    "sidecarLockSha256": hashlib.sha256(lock_bytes).hexdigest(),
    "updaterPublicKeySha256": hashlib.sha256(pubkey).hexdigest(),
    "clientConfigSha256": hashlib.sha256(os.environ["NIHO_FIREBASE_API_KEY"].encode()).hexdigest(),
}
(stage / "editor-candidate-build.json").write_bytes((json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode())
PY

FILES="$(find "$STAGE" -mindepth 1 -maxdepth 1 -type f -print | wc -l | tr -d ' ')"
[ "$FILES" = 3 ] || fail UnexpectedOutput
mv "$STAGE" "$OUTPUT_DIR"
