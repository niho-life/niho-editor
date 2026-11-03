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
      printf '%s' '{"spec":{"template":{"spec":{"template":{"spec":{"containers":[{"command":["node"],"args":["packages/editor-store/src/purge-cli.ts","--private-jobs-only"]}]}}}}}}'
    fi ;;
  *'iam service-accounts describe'*) exit 1 ;;
  *'scheduler jobs describe'*) [[ "${EXISTS:-false}" == true ]] ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$test_dir/gcloud"
export CALLS="$test_dir/calls" GCLOUD="$test_dir/gcloud" DEPLOY_ENV="$test_dir/deploy.env"
bash "$here/private-jobs-infra.sh" > /dev/null
rg -q 'run jobs add-iam-policy-binding niho-editor-private-jobs .*--role roles/run.jobsExecutor' "$CALLS"
rg -q 'scheduler jobs create http niho-editor-private-jobs-sweep .*--message-body \{\}' "$CALLS"
rg -q -- '--oauth-service-account-email niho-editor-private-jobs-cron@' "$CALLS"
if rg -q 'secrets (versions|access)|storage |projects add-iam-policy-binding|--oidc|--overrides|scheduler jobs resume' "$CALLS"; then exit 1; fi
EXISTS=true bash "$here/private-jobs-infra.sh" > /dev/null
rg -q 'scheduler jobs update http niho-editor-private-jobs-sweep' "$CALLS"
if BAD_JOB=true bash "$here/private-jobs-infra.sh" > /dev/null 2>&1; then exit 1; fi
printf 'private jobs infra: synthetic checks passed\n'
