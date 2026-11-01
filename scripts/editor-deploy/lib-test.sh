#!/usr/bin/env bash
# Checks lib.sh without GCP (CI's editor-deploy job runs it): the deploy.env defaults and checks, and the web service's
# --set-secrets / --set-env-vars with and without an AI key version. `gcp` is replaced by a stub; nothing reaches gcloud.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

failed=0
check() {
  if [[ "$2" == "$3" ]]; then
    printf 'ok    %s\n' "$1"
  else
    printf 'FAIL  %s\n      expected: %s\n      actual:   %s\n' "$1" "$3" "$2"
    failed=1
  fi
}

# deploy.env.example without the optional AI lines: the defaults apply.
grep -v '^AI_' "$dir/deploy.env.example" > "$tmp/deploy.env"
export DEPLOY_ENV="$tmp/deploy.env"
# shellcheck source=scripts/editor-deploy/lib.sh
source "$dir/lib.sh"
load_deploy_env

# Stub: `secrets describe` succeeds when the secret exists, `secrets versions list` prints the state of the newest version.
secret_exists=1
newest_state=""
gcp() {
  case "$1 $2" in
    "secrets describe") [[ $secret_exists -eq 1 ]] ;;
    "secrets versions") printf '%s' "$newest_state" ;;
    *) printf 'unexpected gcloud call: %s\n' "$*" >&2; return 99 ;;
  esac
}

check "default AI_MODEL" "$AI_MODEL" "claude-sonnet-5-5"
check "default AI_MONTHLY_LIMIT_USD" "$AI_MONTHLY_LIMIT_USD" "10"
check "AI key secret name" "$SECRET_ANTHROPIC_KEY" "niho-editor-anthropic-key"

ready() { if ai_key_ready; then printf 1; else printf 0; fi; }
check "no AI key version: AI off" "$(ready)" 0
newest_state="enabled"
check "the newest AI key version enabled: AI on" "$(ready)" 1
newest_state="disabled"
check "the newest AI key version disabled (an older one may be enabled): AI off" "$(ready)" 0
newest_state="ENABLED"
check "the state is read in either case: AI on" "$(ready)" 1
secret_exists=0
check "no AI key secret (bootstrap not re-run): AI off" "$(ready)" 0

# Transcription (#36) reads the same rule from its own secret.
check "transcription key secret name" "$SECRET_DEEPGRAM_KEY" "niho-editor-deepgram-key"
secret_exists=1
newest_state=""
tr_ready() { if transcribe_key_ready; then printf 1; else printf 0; fi; }
check "no transcription key version: engine off" "$(tr_ready)" 0
newest_state="enabled"
check "the newest transcription key version enabled: engine on" "$(tr_ready)" 1
newest_state="disabled"
check "the newest transcription key version disabled: engine off" "$(tr_ready)" 0
secret_exists=0
check "no transcription key secret: engine off" "$(tr_ready)" 0

base_env="EDITOR_AUTH_MODE=niho,EDITOR_ORIGIN=https://editor.example.com,EDITOR_STORAGE=gcs,EDITOR_ASSETS_BUCKET=my-gcp-project-editor-assets,EDITOR_NIHO_ORIGIN=https://niho-auth.example.invalid"
check "secrets without AI: only the database URL" "$(service_secrets 0)" "DATABASE_URL=niho-editor-database-url:latest"
check "secrets with AI: the database URL stays" "$(service_secrets 1)" \
  "DATABASE_URL=niho-editor-database-url:latest,ANTHROPIC_API_KEY=niho-editor-anthropic-key:latest"
check "env without AI: no EDITOR_AI_*" "$(service_env_vars 0)" "$base_env"
check "env with AI" "$(service_env_vars 1)" \
  "$base_env,EDITOR_AI_MODE=anthropic,EDITOR_AI_MODEL=claude-sonnet-5-5,EDITOR_AI_MONTHLY_LIMIT_USD=10"

# The storage mode is not a switch: unset means `off` in production, so every deploy passes gcs.
case "$(service_env_vars 0)" in *EDITOR_STORAGE=gcs*) check "storage is always gcs" ok ok ;; *) check "storage is always gcs" missing ok ;; esac

check "secrets with the transcription key only" "$(service_secrets 0 1)" \
  "DATABASE_URL=niho-editor-database-url:latest,DEEPGRAM_API_KEY=niho-editor-deepgram-key:latest"
check "secrets with both keys" "$(service_secrets 1 1)" \
  "DATABASE_URL=niho-editor-database-url:latest,ANTHROPIC_API_KEY=niho-editor-anthropic-key:latest,DEEPGRAM_API_KEY=niho-editor-deepgram-key:latest"
check "env with the transcription engine" "$(service_env_vars 0 1)" "$base_env,EDITOR_TRANSCRIBE_ENGINE=deepgram"
check "env without the transcription engine" "$(service_env_vars 0 0)" "$base_env"

# Gemini の案（#36 段 3b-4）。鍵は Secret なので env はモデルだけ（deploy.env が空ならアプリの既定）
check "secrets with the gemini key" "$(service_secrets 0 0 0 1)" \
  "DATABASE_URL=niho-editor-database-url:latest,GEMINI_API_KEY=niho-editor-gemini-key:latest"
check "secrets with every key" "$(service_secrets 1 1 1 1)" \
  "DATABASE_URL=niho-editor-database-url:latest,ANTHROPIC_API_KEY=niho-editor-anthropic-key:latest,DEEPGRAM_API_KEY=niho-editor-deepgram-key:latest,GOOGLE_OAUTH_CLIENT_SECRET=niho-editor-google-oauth-secret:latest,GEMINI_API_KEY=niho-editor-gemini-key:latest"
check "gemini key secret name" "$SECRET_GEMINI_KEY" "niho-editor-gemini-key"
# モデルを指定しなければ env は増えない（既定のエンジンも変わらない）
check "env with gemini and no model" "$(service_env_vars 0 1 1)" "$base_env,EDITOR_TRANSCRIBE_ENGINE=deepgram"
check "env with gemini and a model" "$(GEMINI_MODEL=gemini-3.1-pro-preview service_env_vars 0 1 1)" \
  "$base_env,EDITOR_TRANSCRIBE_ENGINE=deepgram,EDITOR_GEMINI_MODEL=gemini-3.1-pro-preview"
check "env without gemini ignores the model" "$(GEMINI_MODEL=gemini-3.1-pro-preview service_env_vars 0 1 0)" \
  "$base_env,EDITOR_TRANSCRIBE_ENGINE=deepgram"

# The example's own AI lines, and overrides.
DEPLOY_ENV="$dir/deploy.env.example" load_deploy_env
check "example AI_MODEL" "$AI_MODEL" "claude-sonnet-5-5"
printf 'AI_MODEL=claude-opus-5-5\nAI_MONTHLY_LIMIT_USD=2.5\n' >> "$tmp/deploy.env"
load_deploy_env
check "env with overridden AI settings" "$(service_env_vars 1)" \
  "$base_env,EDITOR_AI_MODE=anthropic,EDITOR_AI_MODEL=claude-opus-5-5,EDITOR_AI_MONTHLY_LIMIT_USD=2.5"

# Values that would add another variable to --set-env-vars (or are not what they claim) stop load_deploy_env.
refused() {
  grep -v '^AI_' "$dir/deploy.env.example" > "$tmp/bad.env"
  printf '%s\n' "$1" >> "$tmp/bad.env"
  if (DEPLOY_ENV="$tmp/bad.env" load_deploy_env) 2> /dev/null; then printf 0; else printf 1; fi
}
check "AI_MODEL with a comma is refused" "$(refused 'AI_MODEL=claude,EDITOR_AUTH_MODE=stub')" 1
check "AI_MODEL in capitals is refused" "$(refused 'AI_MODEL=Claude')" 1
check "a negative limit is refused" "$(refused 'AI_MONTHLY_LIMIT_USD=-1')" 1
check "a limit that is not a number is refused" "$(refused 'AI_MONTHLY_LIMIT_USD=10,EDITOR_AI_MODE=fake')" 1
check "a transcription timeout that is not a number is refused" "$(refused 'TRANSCRIBE_TIMEOUT_SEC=20m')" 1
check "a transcription timeout with a comma is refused" "$(refused 'TRANSCRIBE_TIMEOUT_SEC=600,EDITOR_AUTH_MODE=stub')" 1
# Outside the app's range the service would not start, so load_deploy_env refuses it here.
check "a transcription timeout below 60 is refused" "$(refused 'TRANSCRIBE_TIMEOUT_SEC=59')" 1
check "a transcription timeout above 3300 is refused" "$(refused 'TRANSCRIBE_TIMEOUT_SEC=3600')" 1
check "the lowest accepted timeout" "$(refused 'TRANSCRIBE_TIMEOUT_SEC=60')" 0
check "the highest accepted timeout" "$(refused 'TRANSCRIBE_TIMEOUT_SEC=3300')" 0

# The timeout is optional: empty leaves the app default out of --set-env-vars, a number is passed through.
grep -v '^AI_' "$dir/deploy.env.example" > "$tmp/timeout.env"
printf 'TRANSCRIBE_TIMEOUT_SEC=600\n' >> "$tmp/timeout.env"
DEPLOY_ENV="$tmp/timeout.env" load_deploy_env
check "env with the transcription timeout" "$(service_env_vars 0 1)" \
  "$base_env,EDITOR_TRANSCRIBE_ENGINE=deepgram,EDITOR_TRANSCRIBE_TIMEOUT_SEC=600"

# The transcription key's shape (set-transcribe-key.sh). A repetition count above 255 makes bash's regexes invalid,
# so the length is checked apart from the pattern; `{1,512}` used to reject every key on macOS.
shape() { if is_transcribe_key "$1"; then printf 1; else printf 0; fi; }
check "an ordinary key is accepted" "$(shape 'synthetic-not-a-real-key-0123456789')" 1
check "punctuation is accepted" "$(shape 'abc.DEF_ghi-123:xyz/+==')" 1
check "512 characters are accepted" "$(shape "$(printf 'a%.0s' $(seq 1 512))")" 1
check "513 characters are refused" "$(shape "$(printf 'a%.0s' $(seq 1 513))")" 0
check "a space is refused" "$(shape 'has space')" 0
check "a tab is refused" "$(shape "$(printf 'a\tb')")" 0
check "an empty key is refused" "$(shape '')" 0
check "a control character is refused" "$(shape "$(printf 'a\001b')")" 0
check "non-ASCII is refused" "$(shape 'かぎ')" 0

# The login (#47, §13): niho by default, google with a client id and an allowlist. Synthetic addresses only.
grep -v '^AI_' "$dir/deploy.env.example" > "$tmp/niho.env"
DEPLOY_ENV="$tmp/niho.env" load_deploy_env
check "default EDITOR_AUTH_MODE" "$EDITOR_AUTH_MODE" "niho"
check "google OAuth client secret name" "$SECRET_GOOGLE_OAUTH" "niho-editor-google-oauth-secret"
check "niho: the env keeps the comma form" "$(service_env_vars 0 0)" "$base_env"
check "niho: no google variables even with a client id in deploy.env" "$(service_env_vars 0 0)" "$base_env"
check "secrets without the google secret" "$(service_secrets 0 0 0)" "DATABASE_URL=niho-editor-database-url:latest"
check "secrets with the google secret" "$(service_secrets 0 0 1)" \
  "DATABASE_URL=niho-editor-database-url:latest,GOOGLE_OAUTH_CLIENT_SECRET=niho-editor-google-oauth-secret:latest"
check "secrets with every key" "$(service_secrets 1 1 1)" \
  "DATABASE_URL=niho-editor-database-url:latest,ANTHROPIC_API_KEY=niho-editor-anthropic-key:latest,DEEPGRAM_API_KEY=niho-editor-deepgram-key:latest,GOOGLE_OAUTH_CLIENT_SECRET=niho-editor-google-oauth-secret:latest"
ready_google() { if google_oauth_secret_ready; then printf 1; else printf 0; fi; }
secret_exists=1
newest_state=""
check "no google secret version: nobody can log in" "$(ready_google)" 0
newest_state="enabled"
check "the newest google secret version enabled" "$(ready_google)" 1
newest_state="disabled"
check "the newest google secret version disabled" "$(ready_google)" 0

# With google the whole --set-env-vars uses gcloud's escaped-list form, because the allowlist itself holds commas.
google_client="synthetic-client.apps.googleusercontent.com"
google_list="owner@example.test,owner.second@example.invalid"
grep -v '^AI_\|^GOOGLE_\|^EDITOR_AUTH_MODE' "$dir/deploy.env.example" > "$tmp/google.env"
printf 'EDITOR_AUTH_MODE=google\nGOOGLE_OAUTH_CLIENT_ID=%s\nGOOGLE_ALLOWED_EMAILS=%s\nAI_MODEL=claude-sonnet-5-5\nAI_MONTHLY_LIMIT_USD=10\n' \
  "$google_client" "$google_list" >> "$tmp/google.env"
DEPLOY_ENV="$tmp/google.env" load_deploy_env
google_env="^|^EDITOR_AUTH_MODE=google|EDITOR_ORIGIN=https://editor.example.com|EDITOR_STORAGE=gcs|EDITOR_ASSETS_BUCKET=my-gcp-project-editor-assets|EDITOR_GOOGLE_CLIENT_ID=$google_client|EDITOR_GOOGLE_ALLOWED_EMAILS=$google_list"
check "google: the client id and the allowlist go in, with the allowlist's commas kept" "$(service_env_vars 0 0)" "$google_env"
check "google: AI and the transcription engine use the same delimiter" "$(service_env_vars 1 1)" \
  "$google_env|EDITOR_AI_MODE=anthropic|EDITOR_AI_MODEL=claude-sonnet-5-5|EDITOR_AI_MONTHLY_LIMIT_USD=10|EDITOR_TRANSCRIBE_ENGINE=deepgram"

# The queues' variables follow the delimiter too (the project number comes from the stub).
gcp() {
  case "$1 $2" in
    "secrets describe") [[ $secret_exists -eq 1 ]] ;;
    "secrets versions") printf '%s' "$newest_state" ;;
    "projects describe") printf '000000000000' ;;
    *) printf 'unexpected gcloud call: %s\n' "$*" >&2; return 99 ;;
  esac
}
worker_url="https://niho-editor-000000000000.asia-northeast1.run.app"
printf 'STEPS_MODE=cloud-tasks\nTRANSCRIBE_MODE=cloud-tasks\n' >> "$tmp/google.env"
DEPLOY_ENV="$tmp/google.env" load_deploy_env
check "google: the steps queue uses the same delimiter" "$(steps_env_vars)" \
  "|EDITOR_STEPS_MODE=cloud-tasks|EDITOR_STEPS_QUEUE=projects/my-gcp-project/locations/asia-northeast1/queues/niho-editor-steps|EDITOR_STEPS_WORKER_URL=$worker_url|EDITOR_STEPS_INVOKER_SA=niho-editor-tasks@my-gcp-project.iam.gserviceaccount.com"
cp "$tmp/niho.env" "$tmp/niho-queues.env"
printf 'STEPS_MODE=cloud-tasks\nTRANSCRIBE_MODE=cloud-tasks\n' >> "$tmp/niho-queues.env"
DEPLOY_ENV="$tmp/niho-queues.env" load_deploy_env
check "niho: the transcription queue keeps the comma form" "$(transcribe_env_vars)" \
  ",EDITOR_TRANSCRIBE_MODE=cloud-tasks,EDITOR_TRANSCRIBE_QUEUE=projects/my-gcp-project/locations/asia-northeast1/queues/niho-editor-transcribe,EDITOR_TRANSCRIBE_WORKER_URL=$worker_url,EDITOR_TRANSCRIBE_INVOKER_SA=niho-editor-tasks@my-gcp-project.iam.gserviceaccount.com"

# What load_deploy_env refuses for the login. Every value is written quoted, so a value with a space or a '|' is tested
# as a value and not run by the shell that sources the file, and both google variables start empty on every case.
refused_lines() {
  grep -v '^AI_\|^GOOGLE_\|^EDITOR_AUTH_MODE\|^EDITOR_NIHO_ORIGIN' "$dir/deploy.env.example" > "$tmp/login.env"
  printf "GOOGLE_OAUTH_CLIENT_ID=''\nGOOGLE_ALLOWED_EMAILS=''\nEDITOR_NIHO_ORIGIN=''\n" >> "$tmp/login.env"
  local pair
  for pair in "$@"; do printf "%s='%s'\n" "${pair%%=*}" "${pair#*=}" >> "$tmp/login.env"; done
  if (DEPLOY_ENV="$tmp/login.env" load_deploy_env) 2> /dev/null; then printf 0; else printf 1; fi
}
google_pair="GOOGLE_OAUTH_CLIENT_ID=$google_client"
check "stub is refused in deploy.env" "$(refused_lines 'EDITOR_AUTH_MODE=stub')" 1
check "an unknown mode is refused" "$(refused_lines 'EDITOR_AUTH_MODE=none')" 1
check "niho without its trusted origin is refused" "$(refused_lines 'EDITOR_AUTH_MODE=niho')" 1
check "niho accepts an exact synthetic HTTPS origin" \
  "$(refused_lines 'EDITOR_AUTH_MODE=niho' 'EDITOR_NIHO_ORIGIN=https://niho-auth.example.invalid')" 0
for bad_origin in 'http://niho-auth.example.invalid' 'https://niho-auth.example.invalid/' \
  'https://user@niho-auth.example.invalid' 'https://niho-auth.example.invalid/connect' \
  'https://niho-auth.example.invalid?x=1' 'https://niho-auth.example.invalid#x' \
  'https://niho-auth.example.invalid:0' 'https://niho-auth.example.invalid:99999'; do
  check "niho refuses a non-origin upstream: $bad_origin" \
    "$(refused_lines 'EDITOR_AUTH_MODE=niho' "EDITOR_NIHO_ORIGIN=$bad_origin")" 1
done
check "google without a client id is refused" "$(refused_lines 'EDITOR_AUTH_MODE=google' "GOOGLE_ALLOWED_EMAILS=$google_list")" 1
check "google with an empty allowlist is refused" "$(refused_lines 'EDITOR_AUTH_MODE=google' "$google_pair")" 1
check "google with one address is accepted" "$(refused_lines 'EDITOR_AUTH_MODE=google' "$google_pair" 'GOOGLE_ALLOWED_EMAILS=owner@example.test')" 0
check "google with two addresses is accepted" "$(refused_lines 'EDITOR_AUTH_MODE=google' "$google_pair" "GOOGLE_ALLOWED_EMAILS=$google_list")" 0
# The redirect URI the app sends is https://<APP_DOMAIN>/auth/callback, and Google only accepts the registered one.
check "google without APP_DOMAIN is refused" \
  "$(refused_lines 'EDITOR_AUTH_MODE=google' "$google_pair" "GOOGLE_ALLOWED_EMAILS=$google_list" 'APP_DOMAIN=')" 1
check "niho without APP_DOMAIN is accepted (the run.app URL)" \
  "$(refused_lines 'EDITOR_AUTH_MODE=niho' 'EDITOR_NIHO_ORIGIN=https://niho-auth.example.invalid' 'APP_DOMAIN=')" 0
for bad in 'owner@example.test, owner.second@example.invalid' 'owner@example.test|EDITOR_AUTH_MODE=stub' \
  'owner@example.test=x' 'example.test' '@example.test' 'owner@' 'owner@example' 'owner name@example.test' ' '; do
  check "an allowlist that is not addresses is refused: $bad" \
    "$(refused_lines 'EDITOR_AUTH_MODE=google' "$google_pair" "GOOGLE_ALLOWED_EMAILS=$bad")" 1
done
for bad in 'client,EDITOR_AUTH_MODE=stub' 'client id' 'client|x' 'client=x'; do
  check "a client id that could add another variable is refused: $bad" \
    "$(refused_lines 'EDITOR_AUTH_MODE=google' "GOOGLE_OAUTH_CLIENT_ID=$bad" "GOOGLE_ALLOWED_EMAILS=$google_list")" 1
done

[[ $failed -eq 0 ]] || { printf 'lib-test: failed\n' >&2; exit 1; }
printf 'lib-test: all passed\n'
