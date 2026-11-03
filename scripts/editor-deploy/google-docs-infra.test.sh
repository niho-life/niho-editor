#!/usr/bin/env bash
# Dry-run check of google-docs-infra.sh, of transcribe_env_vars and of service_request_timeout (lib.sh) with a fake gcloud
# and the example env file. Nothing reaches GCP: the fake only records its arguments. Run by the editor-deploy job of
# editor-web-ci.yml.
#
#   scripts/editor-deploy/google-docs-infra.test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp "$here/deploy.env.example" "$work/deploy.env"
cat > "$work/gcloud" << 'FAKE'
#!/usr/bin/env bash
# Fake gcloud: appends its arguments to $FAKE_LOG. `describe` fails (nothing exists) unless FAKE_EXISTS=1.
printf '%s\n' "$*" >> "$FAKE_LOG"
case "$*" in
  *" projects describe "*) printf '000000000000\n' ;;
  *" describe "*) [[ "${FAKE_EXISTS:-0}" == 1 ]] || exit 1 ;;
esac
exit 0
FAKE
chmod +x "$work/gcloud"

fail() { printf 'google-docs-infra.test: %s\n' "$*" >&2; exit 1; }
expect_line() {
  grep -qxF -- "$2" "$1" || fail "missing gcloud call: $2"
}
refuse_line() {
  if grep -qF -- "$2" "$1"; then fail "unexpected gcloud call: $2"; fi
}

run_infra() {
  : > "$work/calls"
  FAKE_LOG="$work/calls" FAKE_EXISTS="$1" GCLOUD="$work/gcloud" DEPLOY_ENV="$work/deploy.env" \
    "$here/google-docs-infra.sh" > /dev/null
}

project=my-gcp-project
region=asia-northeast1
url="https://niho-editor-000000000000.$region.run.app"
tasks_sa="niho-editor-tasks@$project.iam.gserviceaccount.com"
runner_sa="niho-editor-runner@$project.iam.gserviceaccount.com"
# One transcription takes up to 20 minutes: fewer attempts, a longer backoff and fewer at once than the steps queue.
queue_flags="--location $region --max-attempts=3 --min-backoff=60s --max-backoff=300s --max-concurrent-dispatches=3"
job_flags="--location $region --schedule */5 * * * * --time-zone Asia/Tokyo --uri $url/api/internal/google-docs/sweep --http-method post --oidc-service-account-email $tasks_sa --oidc-token-audience $url --attempt-deadline 300s --max-retry-attempts 0 --message-body {} --description NIHO editor Google Docs batches (#238): requeue durable export items and reconcile receipts"
create_job_flags="$job_flags --headers Content-Type=application/json"
update_job_flags="$job_flags --update-headers Content-Type=application/json"
g="--project $project --quiet"

# Nothing exists yet: everything is created.
run_infra 0
calls="$work/calls"
expect_line "$calls" "$g services enable cloudtasks.googleapis.com cloudscheduler.googleapis.com"
expect_line "$calls" "$g iam service-accounts create niho-editor-tasks --display-name NIHO editor workers (Cloud Tasks / Scheduler OIDC)"
expect_line "$calls" "$g tasks queues create niho-editor-google-docs $queue_flags"
expect_line "$calls" "$g tasks queues add-iam-policy-binding niho-editor-google-docs --location $region --member serviceAccount:$runner_sa --role roles/cloudtasks.enqueuer"
expect_line "$calls" "$g iam service-accounts add-iam-policy-binding $tasks_sa --member serviceAccount:$runner_sa --role roles/iam.serviceAccountUser"
expect_line "$calls" "$g scheduler jobs create http niho-editor-google-docs-sweep $create_job_flags"
# The tasks account is only an identity: no role is granted to it anywhere.
refuse_line "$calls" "--member serviceAccount:$tasks_sa"
# The steps queue and its sweep belong to steps-infra.sh; this script does not touch them.
refuse_line "$calls" "niho-editor-steps "
refuse_line "$calls" "/api/internal/steps/"

# Everything exists: updated in place, nothing created.
run_infra 1
expect_line "$calls" "$g tasks queues update niho-editor-google-docs $queue_flags"
expect_line "$calls" "$g scheduler jobs update http niho-editor-google-docs-sweep $update_job_flags"
refuse_line "$calls" " create"
refuse_line "$calls" "--member serviceAccount:$tasks_sa"

# Closed by default. Explicit setup may not silently enable the feature.
env_of() {
  FAKE_LOG="$work/calls" GCLOUD="$work/gcloud" DEPLOY_ENV="$work/deploy.env" \
    bash -c 'source "$1/lib.sh"; load_deploy_env; google_docs_env_vars' _ "$here"
}
[[ -z "$(env_of)" ]] || fail "Google Docs must stay off by default"
refuse_line "$calls" " resume "
# Enabling batches without cleanup/keyring is rejected before any GCP mutation.
printf '\nGOOGLE_DOCS_MODE=niho\nEDITOR_AUTH_MODE=niho\nEDITOR_NIHO_ORIGIN=https://niho.example.test\nEDITOR_NIHO_FIREBASE_API_KEY=synthetic-public-client-config\nEDITOR_NIHO_API_ORIGIN=https://niho.example.test/api\nGOOGLE_DOCS_BATCH_MODE=cloud-tasks\n' >> "$work/deploy.env"
if env_of >/dev/null 2>&1; then fail "batch without private cleanup/keyring accepted"; fi
printf '\nPRIVATE_JOBS_MAINTENANCE=true\nEDITOR_PRIVATE_JOBS_KEY_RING_SECRET_REF=synthetic-private-jobs:7\nEDITOR_GOOGLE_DOCS_NIHO_SERVICE_AUDIENCE=https://niho.example.test/api/internal/editor-docs-drive\n' >> "$work/deploy.env"
on="$(env_of)"
[[ "$on" == *"EDITOR_GOOGLE_DOCS_MODE=niho"* ]] || fail "single gateway missing"
[[ "$on" == *"EDITOR_GOOGLE_DOCS_QUEUE=projects/$project/locations/$region/queues/niho-editor-google-docs"* ]] || fail "queue is not fixed"
[[ "$on" == *"EDITOR_GOOGLE_DOCS_INVOKER_SERVICE_ACCOUNT=$tasks_sa"* ]] || fail "worker identity mismatch"
[[ "$on" != *'me/docs-drive'* ]] || fail "legacy caller adapter exposed"
printf '\nEDITOR_NIHO_API_ORIGIN=https://elsewhere.example.test/api\n' >> "$work/deploy.env"
if env_of >/dev/null 2>&1; then fail "API base different from NIHO auth accepted"; fi
printf 'google-docs-infra.test: ok\n'
