#!/usr/bin/env bash
# Product payload retention, not an agent heartbeat. No page/object deletion, provider call, or key read.
# Provision separately from normal deploy. GCLOUD may be a fake in tests.
set -euo pipefail
# shellcheck source=scripts/editor-deploy/lib.sh
source "$(dirname "$0")/lib.sh"
load_deploy_env
[[ "$PRIVATE_JOBS_MAINTENANCE" == true ]] || die "set PRIVATE_JOBS_MAINTENANCE=true and deploy the cleanup job first"
private_jobs_job_safe || die "cleanup job command is not private-jobs-only"

gcp services enable cloudscheduler.googleapis.com
gcp iam service-accounts describe "$PRIVATE_JOBS_SCHEDULER_EMAIL" > /dev/null 2>&1 \
  || gcp iam service-accounts create "$PRIVATE_JOBS_SCHEDULER_SA" --display-name "NIHO Editor private payload cleanup"
# OAuth identity has only execute permission on this one job; no overrides, secrets, or DB access.
gcp run jobs add-iam-policy-binding "$PRIVATE_JOBS_JOB" --region "$GCP_REGION" \
  --member "serviceAccount:$PRIVATE_JOBS_SCHEDULER_EMAIL" --role roles/run.jobsExecutor > /dev/null
flags=(--location "$GCP_REGION" --schedule "*/5 * * * *" --time-zone Asia/Tokyo
  --uri "$(private_jobs_scheduler_uri)" --http-method post --message-body '{}'
  --oauth-service-account-email "$PRIVATE_JOBS_SCHEDULER_EMAIL"
  --oauth-token-scope https://www.googleapis.com/auth/cloud-platform
  --attempt-deadline 30s --max-retry-attempts 0
  --description "NIHO Editor: erase expired private job payloads; never delete pages or objects")
# Updating preserves a paused job; resuming is an explicit operational action.
if gcp scheduler jobs describe "$PRIVATE_JOBS_SWEEP_JOB" --location "$GCP_REGION" > /dev/null 2>&1; then
  gcp scheduler jobs update http "$PRIVATE_JOBS_SWEEP_JOB" "${flags[@]}" > /dev/null
else
  gcp scheduler jobs create http "$PRIVATE_JOBS_SWEEP_JOB" "${flags[@]}"
fi
log "private jobs cleanup provisioned; verify readiness before adding the keyring reference"
