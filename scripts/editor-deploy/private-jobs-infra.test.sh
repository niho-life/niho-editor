#!/usr/bin/env bash
# Synthetic gcloud only. Proves the caller cannot override this into page deletion or key access.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
cp "$here/deploy.env.example" "$test_dir/deploy.env"
printf '\nPRIVATE_JOBS_MAINTENANCE=true\n' >> "$test_dir/deploy.env"
cat > "$test_dir/gcloud" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS"
case "$*" in
  *'run jobs describe'*)
    if [[ "${BAD_JOB:-false}" == true ]]; then printf '{}'; else
      service_account=niho-editor-private@my-gcp-project.iam.gserviceaccount.com
      env='[{"name":"NODE_ENV","value":"production"},{"name":"DATABASE_URL","valueFrom":{"secretKeyRef":{"name":"niho-editor-database-url","key":"latest"}}}]'
      [[ "${BAD_IDENTITY:-false}" != true ]] || service_account=niho-editor-runner@my-gcp-project.iam.gserviceaccount.com
      [[ "${EXTRA_SECRET:-false}" != true ]] || env='[{"name":"NODE_ENV","value":"production"},{"name":"DATABASE_URL","valueFrom":{"secretKeyRef":{"name":"niho-editor-database-url","key":"latest"}}},{"name":"EDITOR_PRIVATE_JOBS_KEY_RING","valueFrom":{"secretKeyRef":{"name":"niho-editor-private-jobs-key-ring","key":"7"}}}]'
      printf '%s' "{\"spec\":{\"template\":{\"spec\":{\"template\":{\"spec\":{\"serviceAccountName\":\"$service_account\",\"volumes\":[],\"containers\":[{\"command\":[\"node\"],\"args\":[\"packages/editor-store/src/purge-cli.ts\",\"--private-jobs-only\"],\"env\":$env}]}}}}}}"
    fi ;;
  *'iam service-accounts describe'*) exit 1 ;;
  *'scheduler jobs describe'*) [[ "${EXISTS:-false}" == true ]] ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$test_dir/gcloud"
export CALLS="$test_dir/calls" GCLOUD="$test_dir/gcloud" DEPLOY_ENV="$test_dir/deploy.env"
bash "$here/private-jobs-infra.sh" > /dev/null
grep -Eq 'run jobs add-iam-policy-binding niho-editor-private-jobs .*--role roles/run.jobsExecutor' "$CALLS"
grep -Eq 'scheduler jobs create http niho-editor-private-jobs-sweep .*--message-body \{\}' "$CALLS"
grep -Eq -- '--oauth-service-account-email niho-editor-private-jobs-cron@' "$CALLS"
grep -Eq -- '--schedule 7 \* \* \* \* --time-zone Asia/Tokyo' "$CALLS"
if grep -Eq 'secrets (versions|access)|storage |projects add-iam-policy-binding|--oidc|--overrides|scheduler jobs resume' "$CALLS"; then exit 1; fi
EXISTS=true bash "$here/private-jobs-infra.sh" > /dev/null
grep -Eq 'scheduler jobs update http niho-editor-private-jobs-sweep' "$CALLS"
if BAD_JOB=true bash "$here/private-jobs-infra.sh" > /dev/null 2>&1; then exit 1; fi
if BAD_IDENTITY=true bash "$here/private-jobs-infra.sh" > /dev/null 2>&1; then exit 1; fi
if EXTRA_SECRET=true bash "$here/private-jobs-infra.sh" > /dev/null 2>&1; then exit 1; fi
printf 'private jobs infra: synthetic checks passed\n'
