#!/usr/bin/env bash
# Owner-only input. The agent must never execute this with real key material.
# The keyring is granted only to the web runtime; the cleanup job's dedicated identity cannot read it.
# Reads one JSON keyring line from stdin, validates in memory, and adds a Secret version.
# No value is printed, persisted locally, passed as an argument, or reused from another capability.
set +x
# shellcheck source=scripts/editor-deploy/lib.sh
source "$(dirname "$0")/lib.sh"
load_deploy_env
cd "$REPO_ROOT"
[[ $# -eq 0 ]] || die "usage: $0 (owner supplies JSON on standard input)"
secret_name=niho-editor-private-jobs-key-ring
[[ "$PRIVATE_JOBS_MAINTENANCE" == true ]] || die "set PRIVATE_JOBS_MAINTENANCE=true before preparing the keyring"
private_jobs_infra_ready || die "private-job cleanup is not ready: verify its dedicated identity and enabled 5-minute cleanup before adding the keyring"
keyring=""
trap 'unset keyring' EXIT
if [[ -t 0 ]]; then
  printf 'Private jobs keyring JSON (input hidden): ' >&2
  IFS= read -r -s keyring || true
  printf '\n' >&2
else
  IFS= read -r keyring || true
fi
[[ -n "$keyring" && ${#keyring} -le 4096 ]] || die "invalid keyring: nothing was added"
# Validate before starting gcloud: invalid input must not create an empty Secret version.
printf '%s' "$keyring" | node --input-type=module -e '
import { readFileSync } from "node:fs";
import { createPrivateJobPayloadCipher } from "./apps/editor-web/src/storage/private-job-payload.ts";
if (!createPrivateJobPayloadCipher({ EDITOR_PRIVATE_JOBS_KEY_RING: readFileSync(0,"utf8") })) process.exit(65);
' || die "invalid keyring: nothing was added"
gcp secrets describe "$secret_name" >/dev/null 2>&1 \
  || gcp secrets create "$secret_name" --replication-policy automatic >/dev/null
gcp secrets add-iam-policy-binding "$secret_name" \
  --member "serviceAccount:$RUNNER_SA_EMAIL" --role roles/secretmanager.secretAccessor >/dev/null
version="$(printf '%s' "$keyring" | gcp secrets versions add "$secret_name" --data-file=- --format='value(name)')"
unset keyring
version="${version##*/}"
[[ "$version" =~ ^[1-9][0-9]*$ ]] || die "version was added: read its metadata to pin the numeric version"
printf 'EDITOR_PRIVATE_JOBS_KEY_RING_SECRET_REF=%s:%s\n' "$secret_name" "$version"
