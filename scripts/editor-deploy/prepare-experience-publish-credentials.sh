#!/usr/bin/env bash
# Owner-only setup for the Experience staging reader of Editor's public API.
# Never execute this with real cloud credentials from an AI session.
set -euo pipefail
set +x

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/editor-deploy/lib.sh
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib.sh"
load_deploy_env
load_article_deploy_settings

[[ $# -eq 0 ]] || die "usage: $0 (owner runs interactively; no arguments accepted)"
[[ "$EDITOR_EXPERIENCE_ARTICLE_AUTHORITY_ENABLED" == false ]] \
  || die "disable Editor Experience article authority before preparing initial credentials"
[[ -z "$EDITOR_FACE_CREDENTIALS_SECRET_REF" ]] \
  || die "a fixed Editor face verifier reference is already configured; review rotation manually"

for command_name in gcloud python3 shasum; do
  command -v "$command_name" >/dev/null 2>&1 || die "$command_name is required"
done
active_account="$(gcloud auth list --filter='status:ACTIVE' --format='value(account)' 2>/dev/null || true)"
[[ -n "$active_account" ]] || die "no active gcloud account is available"
unset active_account

trap 'unset token verifier digest expires_at confirmation experience_project experience_project_id experience_runtime_email verifier_version token_version' EXIT
read -r -p 'Type EDITOR to confirm the project loaded from deploy.env: ' confirmation
[[ "$confirmation" == EDITOR ]] || die "canceled; Editor project confirmation did not match"
unset confirmation

printf 'Experience staging project ID (input hidden): ' >&2
IFS= read -r -s experience_project || true
printf '\n' >&2
[[ "$experience_project" =~ ^[a-z0-9][a-z0-9-]*-stg$ ]] \
  || die "enter a staging project ID ending in -stg"
experience_project_id="$(gcloud projects describe "$experience_project" --format='value(projectId)' 2>/dev/null)" \
  || die "could not confirm the Experience staging project"
[[ "$experience_project_id" == "$experience_project" ]] || die "the Experience project ID did not match"
unset experience_project_id

EXPERIENCE_TOKEN_SECRET="experience-stg-editor-api-token"
EDITOR_VERIFIER_SECRET="niho-editor-face-credentials"
experience_runtime_email="experience-host-stg-runtime@${experience_project}.iam.gserviceaccount.com"
gcloud iam service-accounts describe "$experience_runtime_email" \
  --project="$experience_project" --format='value(email)' >/dev/null 2>&1 \
  || die "the Experience staging runtime service account could not be confirmed"

ensure_secret() {
  local project="$1"
  local name="$2"
  if ! gcloud secrets describe "$name" --project="$project" >/dev/null 2>&1; then
    gcloud secrets create "$name" --project="$project" --replication-policy=automatic --quiet >/dev/null
  fi
}

enabled_version_count() {
  local project="$1"
  local name="$2"
  gcloud secrets versions list "$name" --project="$project" --format=json \
    | python3 -c 'import json,sys; print(sum(item.get("state") == "ENABLED" for item in json.load(sys.stdin)))'
}

assert_direct_secret_accessors() {
  local project="$1"
  local name="$2"
  local allowed_email="$3"
  local require_allowed="$4"
  local policy
  policy="$(gcloud secrets get-iam-policy "$name" --project="$project" --format=json)" \
    || die "could not verify the direct IAM policy for a publication credential"
  printf '%s' "$policy" | python3 -c '
import json
import sys

policy = json.load(sys.stdin)
allowed = "serviceAccount:" + sys.argv[1]
require_allowed = sys.argv[2] == "true"
found = False
for binding in policy.get("bindings", []):
    if binding.get("role") != "roles/secretmanager.secretAccessor":
        continue
    if binding.get("condition"):
        raise SystemExit(1)
    members = binding.get("members", [])
    if any(member != allowed for member in members):
        raise SystemExit(1)
    found = found or allowed in members
if require_allowed and not found:
    raise SystemExit(1)
' "$allowed_email" "$require_allowed" || die "a publication credential has an unexpected direct Secret Accessor binding; review IAM manually"
  unset policy
}

ensure_secret "$GCP_PROJECT" "$EDITOR_VERIFIER_SECRET"
ensure_secret "$experience_project" "$EXPERIENCE_TOKEN_SECRET"
assert_direct_secret_accessors "$GCP_PROJECT" "$EDITOR_VERIFIER_SECRET" "$RUNNER_SA_EMAIL" false
assert_direct_secret_accessors "$experience_project" "$EXPERIENCE_TOKEN_SECRET" "$experience_runtime_email" false
[[ "$(enabled_version_count "$GCP_PROJECT" "$EDITOR_VERIFIER_SECRET")" == 0 ]] \
  || die "an enabled Editor verifier version already exists; review rotation manually"
[[ "$(enabled_version_count "$experience_project" "$EXPERIENCE_TOKEN_SECRET")" == 0 ]] \
  || die "an enabled Experience token version already exists; review rotation manually"

gcloud secrets add-iam-policy-binding "$EDITOR_VERIFIER_SECRET" \
  --project="$GCP_PROJECT" --member="serviceAccount:$RUNNER_SA_EMAIL" \
  --role=roles/secretmanager.secretAccessor --condition=None --quiet >/dev/null
gcloud secrets add-iam-policy-binding "$EXPERIENCE_TOKEN_SECRET" \
  --project="$experience_project" --member="serviceAccount:$experience_runtime_email" \
  --role=roles/secretmanager.secretAccessor --condition=None --quiet >/dev/null
assert_direct_secret_accessors "$GCP_PROJECT" "$EDITOR_VERIFIER_SECRET" "$RUNNER_SA_EMAIL" true
assert_direct_secret_accessors "$experience_project" "$EXPERIENCE_TOKEN_SECRET" "$experience_runtime_email" true

token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32), end="")')"
[[ "$token" =~ ^[A-Za-z0-9_-]{43}$ ]] || die "generated token has an unexpected shape"
digest="$(printf '%s' "$token" | shasum -a 256 | awk '{print $1}')"
expires_at="$(python3 -c 'from datetime import datetime, timedelta, timezone; print((datetime.now(timezone.utc) + timedelta(days=90)).isoformat(timespec="seconds").replace("+00:00", "Z"))')"
verifier="$(python3 - "$digest" "$expires_at" <<'PY'
import json
import sys

print(json.dumps([{"audience": "exp", "sha256": sys.argv[1], "expiresAt": sys.argv[2]}], separators=(",", ":")))
PY
)"
unset digest expires_at

verifier_version="$(printf '%s' "$verifier" | gcloud secrets versions add "$EDITOR_VERIFIER_SECRET" \
  --project="$GCP_PROJECT" --data-file=- --format='value(name)')"
verifier_version="${verifier_version##*/}"
[[ "$verifier_version" =~ ^[1-9][0-9]*$ ]] || die "Editor verifier version was added; read its metadata to pin a numeric version"
unset verifier

if ! token_version="$(printf '%s' "$token" | gcloud secrets versions add "$EXPERIENCE_TOKEN_SECRET" \
  --project="$experience_project" --data-file=- --format='value(name)')"; then
  gcloud secrets versions disable "$verifier_version" --secret="$EDITOR_VERIFIER_SECRET" \
    --project="$GCP_PROJECT" --quiet >/dev/null 2>&1 || true
  die "the Experience token upload failed; the new Editor verifier was disabled. Check for and disable any newly created active token version before retrying"
fi
unset token
token_version="${token_version##*/}"
[[ "$token_version" =~ ^[1-9][0-9]*$ ]] || die "Experience token version was added; read its metadata to pin a numeric version"
unset experience_project experience_runtime_email

printf 'EDITOR_FACE_CREDENTIALS_SECRET_REF=%s:%s\n' "$EDITOR_VERIFIER_SECRET" "$verifier_version"
printf 'GUIDE_EDITOR_API_TOKEN_REF=%s:%s\n' "$EXPERIENCE_TOKEN_SECRET" "$token_version"
