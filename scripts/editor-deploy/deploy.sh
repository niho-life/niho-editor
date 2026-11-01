#!/usr/bin/env bash
# Deploys the current HEAD to Cloud Run (docs/ops/editor-deploy.md §4):
#   1. Cloud Build builds the web and migrate images (cloudbuild.yaml), tagged with the git SHA
#   2. the migrate job applies the migrations and the app role's privileges with the new image (stops on failure)
#   3. the web service is deployed with the new image
#   4. smoke checks: every response is noindex, and the API refuses a caller with no session
#      (with STEPS_MODE / TRANSCRIBE_MODE = cloud-tasks, also the worker routes refuse a caller with no OIDC token)
# Usage: scripts/editor-deploy/deploy.sh [--no-build] [--allow-dirty]
#   --no-build  redeploys the image that is serving now (picks up new secret versions and turns AI on or off; no build)
# Needs scripts/editor-deploy/deploy.env (see deploy.env.example) and a gcloud login with access to the project.
# Public CI never runs this: the production origin is this script, run by the owner (docs/ops/editor-deploy.md §7).
# shellcheck source=scripts/editor-deploy/lib.sh
source "$(dirname "$0")/lib.sh"
load_deploy_env
cd "$REPO_ROOT" || exit 1

build=1
allow_dirty=0
for arg in "$@"; do
  case "$arg" in
    --no-build) build=0 ;;
    --allow-dirty) allow_dirty=1 ;;
    *) die "unknown option: $arg" ;;
  esac
done

if [[ $build -eq 1 ]]; then
  TAG="$(git rev-parse --short=12 HEAD)"
  if [[ -n "$(git status --porcelain)" ]]; then
    [[ $allow_dirty -eq 1 ]] || die "the worktree has uncommitted changes (deploy what is committed, or pass --allow-dirty)"
    TAG="$TAG-dirty"
  fi
else
  serving="$(gcp run services describe "$SERVICE" --region "$GCP_REGION" \
    --format='value(spec.template.spec.containers[0].image)')"
  [[ "$serving" == "$IMAGE:"* ]] || die "$SERVICE is not serving an image of $IMAGE (first deploy needs a build)"
  TAG="${serving#"$IMAGE:"}"
fi
CONNECTION="$(cloudsql_connection_name)"
SERVICE_URL="$(service_url "$SERVICE")"

# Login (#47, §13). niho uses the dedicated NIHO editor session; google lets the addresses in GOOGLE_ALLOWED_EMAILS in, and
# needs the OAuth client secret (set-google-oauth-secret.sh). Without an enabled newest version of that secret the service
# still starts, but the login screen says it is unavailable, so the secret is attached only when it is there.
google=0
if [[ "$EDITOR_AUTH_MODE" == google ]]; then
  if google_oauth_secret_ready; then
    google=1
    # The addresses themselves are not printed (they are in deploy.env, which is not committed).
    log "login: google (only the addresses in GOOGLE_ALLOWED_EMAILS of $DEPLOY_ENV can log in)"
  else
    log "login: google, but the newest version of $SECRET_GOOGLE_OAUTH is missing or not enabled: nobody can log in (run scripts/editor-deploy/set-google-oauth-secret.sh)"
  fi
else
  log "login: niho (dedicated editor session; upstream origin is configured)"
fi

# AI (#38): on only when the newest version of the key secret is enabled (set-ai-key.sh). Otherwise nothing is added for AI and
# the app answers 503 ai_unavailable. Read every deploy, so disabling the versions and redeploying turns AI off.
ai=0
if ai_key_ready; then
  ai=1
  log "AI: on ($AI_MODEL, monthly limit $AI_MONTHLY_LIMIT_USD USD per person)"
else
  log "AI: off (the newest version of $SECRET_ANTHROPIC_KEY is missing or not enabled)"
fi

# Transcription (#36): same rule as AI (set-transcribe-key.sh). Without the key the engine stays off; the VTT import,
# which needs no engine, keeps working.
tr=0
if transcribe_key_ready; then
  tr=1
  log "transcription: on (deepgram${TRANSCRIBE_TIMEOUT_SEC:+, timeout ${TRANSCRIBE_TIMEOUT_SEC}s})"
else
  log "transcription: off (the newest version of $SECRET_DEEPGRAM_KEY is missing or not enabled)"
fi
# Gemini (#36 段 3b-4): apart from the default engine. With the key the screen can make a Gemini candidate of the same
# audio and compare it; without it only the default engine shows up. set-gemini-key.sh adds the version.
gem=0
if gemini_key_ready; then
  gem=1
  log "gemini candidates: on${GEMINI_MODEL:+ ($GEMINI_MODEL)}"
else
  log "gemini candidates: off (the newest version of $SECRET_GEMINI_KEY is missing or not enabled)"
fi
# The dispatcher is the other half (#36, §12): the key alone cannot transcribe audio, because a transcription does not fit
# in one request of the app. With TRANSCRIBE_MODE=cloud-tasks the start enqueues, and the worker route runs it apart.
if [[ "$TRANSCRIBE_MODE" == cloud-tasks ]]; then
  log "transcription dispatcher: cloud-tasks (queue $TRANSCRIBE_QUEUE, sweep $TRANSCRIBE_SWEEP_JOB)"
else
  log "transcription dispatcher: off (TRANSCRIBE_MODE is empty: transcribing audio answers 503; the VTT import still works)"
fi

if [[ $build -eq 1 ]]; then
  log "build $IMAGE:$TAG (Cloud Build)"
  if [[ $allow_dirty -eq 1 ]]; then
    # 手元の変更ごと送る。何を送るかは .gcloudignore が決める。
    gcp builds submit --config scripts/editor-deploy/cloudbuild.yaml --substitutions="_IMAGE=$IMAGE,_TAG=$TAG" .
  else
    # commit 済みの木だけを tar にして送る。ディレクトリを送ると、この checkout の中の
    # .claude/worktrees/（別セッションの worktree）や手元の build 出力まで一緒に送られ、
    # 送っている最中に別セッションがファイルを消すと gcloud が落ちる（2026-11-01 の配備がこれで止まった）。
    src_dir="$(mktemp -d)"
    trap 'rm -rf "$src_dir"' EXIT
    git archive --format=tar.gz -o "$src_dir/source.tgz" HEAD
    gcp builds submit --config scripts/editor-deploy/cloudbuild.yaml --substitutions="_IMAGE=$IMAGE,_TAG=$TAG" "$src_dir/source.tgz"
    rm -rf "$src_dir"
    trap - EXIT
  fi
else
  log "no build: redeploying the serving image $IMAGE:$TAG"
fi

log "migrate: run job $MIGRATE_JOB with $IMAGE-migrate:$TAG"
gcp run jobs deploy "$MIGRATE_JOB" \
  --region "$GCP_REGION" \
  --image "$IMAGE-migrate:$TAG" \
  --service-account "$MIGRATE_SA_EMAIL" \
  --set-cloudsql-instances "$CONNECTION" \
  --network "$VPC_NETWORK" --subnet "$VPC_SUBNET" --vpc-egress private-ranges-only \
  --set-secrets "DATABASE_URL=$SECRET_MIGRATE_DATABASE_URL:latest,EDITOR_APP_DATABASE_URL=$SECRET_DATABASE_URL:latest" \
  --max-retries 0 --task-timeout 10m --memory 512Mi --labels "$COST_LABEL" \
  --execute-now --wait

log "deploy $SERVICE with $IMAGE:$TAG"
# The service is reachable by anyone (people sign in inside the app); the app refuses every caller with no session.
gcp run deploy "$SERVICE" \
  --region "$GCP_REGION" \
  --image "$IMAGE:$TAG" \
  --service-account "$RUNNER_SA_EMAIL" \
  --no-invoker-iam-check --ingress all \
  --port 8080 --min-instances 0 --max-instances 2 \
  --cpu 1 --memory 512Mi --cpu-boost --concurrency 40 --timeout "$(service_request_timeout)" \
  --add-cloudsql-instances "$CONNECTION" \
  --network "$VPC_NETWORK" --subnet "$VPC_SUBNET" --vpc-egress private-ranges-only \
  --set-secrets "$(service_secrets "$ai" "$tr" "$google" "$gem")" \
  --set-env-vars "$(service_env_vars "$ai" "$tr" "$gem")$(steps_env_vars)$(transcribe_env_vars)" \
  --labels "$COST_LABEL,commit=${TAG:0:12}"

# 一度でも特定の revision へ traffic を割り当てる（docs/ops/editor-deploy.md §9 の戻し方）と、Cloud Run は以降のデプロイもその割り当てを
# 引き継ぎ、新しい revision へ traffic を送らない。smoke が古い revision に通らないよう、毎回、最新の revision へ明示的に向ける。
log "route all traffic to the latest revision of $SERVICE"
gcp run services update-traffic "$SERVICE" --region "$GCP_REGION" --to-latest

log "smoke: $SERVICE_URL"
# `-D -` prints the headers; the checks read the headers and status only, never a body.
smoke_headers() { curl -sS -o /dev/null -D - --retry 5 --retry-all-errors --max-time 20 "$SERVICE_URL$1"; }
for path in / /api/pages /robots.txt; do
  headers="$(smoke_headers "$path")"
  grep -qi '^x-robots-tag: noindex, nofollow' <<< "$headers" || die "$path: X-Robots-Tag noindex, nofollow is missing"
  log "ok noindex  $path"
done
status="$(curl -sS -o /dev/null -w '%{http_code}' --retry 5 --retry-all-errors --max-time 20 "$SERVICE_URL/api/pages")"
[[ "$status" == 401 ]] || die "/api/pages answered $status to a caller with no session (expected 401)"
log "ok 401      /api/pages with no session"
# The worker routes check Google's OIDC token themselves (the service is public): no token must be 401.
worker_paths=()
if [[ "$STEPS_MODE" == cloud-tasks ]]; then worker_paths+=(/api/internal/steps/run /api/internal/steps/sweep); fi
if [[ "$TRANSCRIBE_MODE" == cloud-tasks ]]; then worker_paths+=(/api/internal/transcription/run /api/internal/transcription/sweep); fi
for path in ${worker_paths+"${worker_paths[@]}"}; do
  status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{}' \
    --retry 5 --retry-all-errors --max-time 20 "$SERVICE_URL$path")"
  [[ "$status" == 401 ]] || die "$path answered $status to a caller with no token (expected 401)"
  log "ok 401      $path with no token"
done
log "done: $TAG  $(app_origin)"
