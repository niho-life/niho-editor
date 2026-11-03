#!/usr/bin/env bash
# Google Docs background export queue and five-minute recovery sweep (#238).
# Run separately after the merged worker routes and common private-job cleanup are deployed.
# Same queue invoker identity pattern as steps/transcription; no user token or Google secret is used.
# Runtime can enqueue only this queue, and act as the existing task identity.
# The NIHO export caller is the runtime's own metadata identity, bound to registered grants.
# Paused recovery jobs remain paused. This script does not enable the application feature.
#
# Queues, service accounts and Scheduler jobs take no labels; their cost stays in the free tier (docs/ops/editor-google-docs-batch.md).
# GCLOUD=<binary> replaces gcloud (google-docs-infra.test.sh checks the arguments with a fake one; it never reaches GCP).
# shellcheck source=scripts/editor-deploy/lib.sh
source "$(dirname "$0")/lib.sh"
load_deploy_env

google_docs_infra() {
  local worker_url
  worker_url="$(service_url "$SERVICE")"

  log "google-docs: APIs (Cloud Tasks, Cloud Scheduler)"
  gcp services enable cloudtasks.googleapis.com cloudscheduler.googleapis.com

  log "google-docs: service account $TASKS_SA (the OIDC identity of the tasks and the sweep; no roles)"
  gcp iam service-accounts describe "$TASKS_SA_EMAIL" > /dev/null 2>&1 \
    || gcp iam service-accounts create "$TASKS_SA" --display-name "NIHO editor workers (Cloud Tasks / Scheduler OIDC)"

  log "google-docs: Cloud Tasks queue $GOOGLE_DOCS_QUEUE"
  local queue_flags=(--location "$GCP_REGION" --max-attempts=3 --min-backoff=60s --max-backoff=300s --max-concurrent-dispatches=3)
  if gcp tasks queues describe "$GOOGLE_DOCS_QUEUE" --location "$GCP_REGION" > /dev/null 2>&1; then
    gcp tasks queues update "$GOOGLE_DOCS_QUEUE" "${queue_flags[@]}" > /dev/null
  else
    gcp tasks queues create "$GOOGLE_DOCS_QUEUE" "${queue_flags[@]}"
  fi

  log "google-docs: the runtime enqueues into the queue and signs the tasks' OIDC token as the tasks account"
  gcp tasks queues add-iam-policy-binding "$GOOGLE_DOCS_QUEUE" --location "$GCP_REGION" \
    --member "serviceAccount:$RUNNER_SA_EMAIL" --role roles/cloudtasks.enqueuer > /dev/null
  gcp iam service-accounts add-iam-policy-binding "$TASKS_SA_EMAIL" \
    --member "serviceAccount:$RUNNER_SA_EMAIL" --role roles/iam.serviceAccountUser > /dev/null

  log "google-docs: Cloud Scheduler job $GOOGLE_DOCS_SWEEP_JOB (every 5 minutes)"
  local job_flags=(
    --location "$GCP_REGION"
    --schedule "*/5 * * * *" --time-zone Asia/Tokyo
    --uri "$worker_url/api/internal/google-docs/sweep" --http-method post
    --oidc-service-account-email "$TASKS_SA_EMAIL" --oidc-token-audience "$worker_url"
    --attempt-deadline 300s --max-retry-attempts 0
    --message-body '{}'
    --description "NIHO editor Google Docs batches (#238): requeue durable export items and reconcile receipts"
  )
  # update keeps the job's state (a paused job stays paused: docs/ops/editor-deploy.md docs/ops/editor-google-docs-batch.md)
  if gcp scheduler jobs describe "$GOOGLE_DOCS_SWEEP_JOB" --location "$GCP_REGION" > /dev/null 2>&1; then
    gcp scheduler jobs update http "$GOOGLE_DOCS_SWEEP_JOB" "${job_flags[@]}" --update-headers "Content-Type=application/json" > /dev/null
  else
    gcp scheduler jobs create http "$GOOGLE_DOCS_SWEEP_JOB" "${job_flags[@]}" --headers "Content-Type=application/json"
  fi

  if [[ "$GOOGLE_DOCS_BATCH_MODE" == cloud-tasks ]]; then
    log "google-docs: done. Next: scripts/editor-deploy/deploy.sh (GOOGLE_DOCS_BATCH_MODE=cloud-tasks; the limited NIHO gateway and private-job keyring must be ready)"
  else
    log "google-docs: done. Google Docs batches stay off until GOOGLE_DOCS_BATCH_MODE=cloud-tasks in $DEPLOY_ENV and scripts/editor-deploy/deploy.sh"
  fi
}

google_docs_infra
