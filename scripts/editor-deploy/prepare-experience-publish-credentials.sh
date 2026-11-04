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
  || die "disable Editor Experience article authority before preparing credentials"
if [[ -n "$EDITOR_FACE_CREDENTIALS_SECRET_REF" ]]; then
  [[ "$EDITOR_FACE_CREDENTIALS_SECRET_REF" =~ ^niho-editor-face-credentials:[1-9][0-9]*$ ]] \
    || die "the configured Editor face verifier reference is not the expected Secret; review it manually"
fi

for command_name in gcloud python3; do
  command -v "$command_name" >/dev/null 2>&1 || die "$command_name is required"
done
active_account="$(gcloud auth list --filter='status:ACTIVE' --format='value(account)' 2>/dev/null || true)"
[[ -n "$active_account" ]] || die "no active gcloud account is available"
unset active_account

verifier_version=""
token_version=""
cleanup() {
  local status=$?
  trap - EXIT
  if (( status != 0 )); then
    if [[ -n "$token_version" ]]; then
      gcloud secrets versions disable "$token_version" --secret="$EXPERIENCE_TOKEN_SECRET" \
        --project="${experience_project:-}" --quiet >/dev/null 2>&1 || true
    fi
    if [[ -n "$verifier_version" ]]; then
      gcloud secrets versions disable "$verifier_version" --secret="$EDITOR_VERIFIER_SECRET" \
        --project="$GCP_PROJECT" --quiet >/dev/null 2>&1 || true
    fi
  fi
  unset token expires_at experience_project experience_project_id confirmation experience_runtime_email verifier_version token_version base_version
  exit "$status"
}
trap cleanup EXIT
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

secret_exists() {
  local project="$1"
  local name="$2"
  local secrets_json
  secrets_json="$(gcloud secrets list --project="$project" --format=json 2>/dev/null)" \
    || die "could not list Secret Manager metadata in a target project"
  python3 -c '
import json
import sys

name = sys.argv[1]
try:
    items = json.loads(sys.stdin.read())
except Exception:
    raise SystemExit(2)
print("true" if any(item.get("name", "").rsplit("/", 1)[-1] == name for item in items) else "false")
' "$name" <<<"$secrets_json"
  unset secrets_json
}

enabled_versions() {
  local project="$1"
  local name="$2"
  local versions_json
  versions_json="$(gcloud secrets versions list "$name" --project="$project" --format=json 2>/dev/null)" \
    || die "could not list versions for a target Secret"
  python3 -c '
import json
import re
import sys

try:
    items = json.loads(sys.stdin.read())
except Exception:
    raise SystemExit(2)
versions = []
for item in items:
    if item.get("state") == "ENABLED":
        version = item.get("name", "").rsplit("/", 1)[-1]
        if not re.fullmatch(r"[1-9][0-9]*", version):
            raise SystemExit(2)
        versions.append(version)
print(",".join(versions))
' <<<"$versions_json"
  unset versions_json
}

assert_direct_secret_accessors() {
  local project="$1"
  local name="$2"
  local allowed_email="$3"
  local require_allowed="$4"
  local policy
  policy="$(gcloud secrets get-iam-policy "$name" --project="$project" --format=json 2>/dev/null)" \
    || die "could not verify a direct IAM policy for a publication credential"
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

# Read every relevant resource before creating a Secret or changing IAM. If the Editor verifier already
# has one enabled version, the owner-run helper will append to that version's JSON while preserving entries.
editor_secret_exists="$(secret_exists "$GCP_PROJECT" "$EDITOR_VERIFIER_SECRET")"
experience_secret_exists="$(secret_exists "$experience_project" "$EXPERIENCE_TOKEN_SECRET")"
[[ "$editor_secret_exists" == true || "$editor_secret_exists" == false ]] || die "invalid Editor Secret metadata"
[[ "$experience_secret_exists" == true || "$experience_secret_exists" == false ]] || die "invalid Experience Secret metadata"

base_version=""
if [[ "$editor_secret_exists" == true ]]; then
  assert_direct_secret_accessors "$GCP_PROJECT" "$EDITOR_VERIFIER_SECRET" "$RUNNER_SA_EMAIL" false
  editor_versions="$(enabled_versions "$GCP_PROJECT" "$EDITOR_VERIFIER_SECRET")"
  if [[ -n "$editor_versions" ]]; then
    [[ "$editor_versions" != *,* ]] || die "multiple Editor verifier versions are enabled; review credential rotation manually"
    base_version="$editor_versions"
    [[ -z "$EDITOR_FACE_CREDENTIALS_SECRET_REF" || "$EDITOR_FACE_CREDENTIALS_SECRET_REF" == "$EDITOR_VERIFIER_SECRET:$base_version" ]] \
      || die "the configured Editor verifier reference does not match its sole enabled version; review it manually"
  else
    [[ -z "$EDITOR_FACE_CREDENTIALS_SECRET_REF" ]] \
      || die "the configured Editor verifier reference has no enabled version; review it manually"
  fi
  unset editor_versions
else
  [[ -z "$EDITOR_FACE_CREDENTIALS_SECRET_REF" ]] \
    || die "an Editor verifier reference is configured but its Secret is missing"
fi

if [[ "$experience_secret_exists" == true ]]; then
  assert_direct_secret_accessors "$experience_project" "$EXPERIENCE_TOKEN_SECRET" "$experience_runtime_email" false
  experience_versions="$(enabled_versions "$experience_project" "$EXPERIENCE_TOKEN_SECRET")"
  [[ -z "$experience_versions" ]] \
    || die "an enabled Experience token version already exists; review credential rotation manually"
  unset experience_versions
fi

token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32), end="")')"
[[ "$token" =~ ^[A-Za-z0-9_-]{43}$ ]] || die "generated token has an unexpected shape"
expires_at="$(python3 -c 'from datetime import datetime, timedelta, timezone; print((datetime.now(timezone.utc) + timedelta(days=90)).isoformat(timespec="seconds").replace("+00:00", "Z"))')"

build_verifier_payload() {
  python3 -c '
import hashlib
import json
import os
import re
import sys
from datetime import datetime

raw = sys.stdin.read()
token = os.fdopen(3).read().rstrip("\n")
try:
    entries = json.loads(raw) if raw.strip() else []
except Exception:
    raise SystemExit("the existing Editor verifier payload is not valid JSON")
if not isinstance(entries, list):
    raise SystemExit("the existing Editor verifier payload is not a JSON array")
if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
    raise SystemExit("the generated Experience token has an invalid shape")
seen = set()
for item in entries:
    if not isinstance(item, dict) or set(item) != {"audience", "sha256", "expiresAt"}:
        raise SystemExit("the existing Editor verifier payload has an unexpected shape")
    digest = item["sha256"]
    expiry = item["expiresAt"]
    if item["audience"] not in ("exp", "niho") or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise SystemExit("the existing Editor verifier payload has an invalid entry")
    if digest in seen or not isinstance(expiry, str) or not expiry.endswith("Z"):
        raise SystemExit("the existing Editor verifier payload has a duplicate or invalid entry")
    try:
        datetime.fromisoformat(expiry[:-1] + "+00:00")
    except ValueError:
        raise SystemExit("the existing Editor verifier payload has an invalid expiry")
    seen.add(digest)
new_digest = hashlib.sha256(token.encode("ascii")).hexdigest()
if new_digest in seen:
    raise SystemExit("the generated verifier unexpectedly duplicates an existing credential")
expiry = sys.argv[1]
try:
    datetime.fromisoformat(expiry[:-1] + "+00:00")
except (ValueError, IndexError):
    raise SystemExit("the generated verifier expiry is invalid")
entries.append({"audience": "exp", "sha256": new_digest, "expiresAt": expiry})
print(json.dumps(entries, separators=(",", ":")))
' "$1"
}

# Validate the existing payload before creating a Secret or changing IAM. Secret values remain on pipes,
# and the token itself is supplied to Python on a file descriptor rather than an argument or output.
if [[ -n "$base_version" ]]; then
  gcloud secrets versions access "$base_version" --secret="$EDITOR_VERIFIER_SECRET" --project="$GCP_PROJECT" \
    | build_verifier_payload "$expires_at" 3<<<"$token" >/dev/null \
    || die "could not validate the existing Editor verifier payload; no credentials were changed"
else
  printf '[]' | build_verifier_payload "$expires_at" 3<<<"$token" >/dev/null \
    || die "could not prepare the Editor verifier payload; no credentials were changed"
fi

if [[ "$editor_secret_exists" == false ]]; then
  gcloud secrets create "$EDITOR_VERIFIER_SECRET" --project="$GCP_PROJECT" --replication-policy=automatic --quiet >/dev/null \
    || die "could not create the Editor verifier Secret"
fi
if [[ "$experience_secret_exists" == false ]]; then
  gcloud secrets create "$EXPERIENCE_TOKEN_SECRET" --project="$experience_project" --replication-policy=automatic --quiet >/dev/null \
    || die "could not create the Experience token Secret"
fi

gcloud secrets add-iam-policy-binding "$EDITOR_VERIFIER_SECRET" \
  --project="$GCP_PROJECT" --member="serviceAccount:$RUNNER_SA_EMAIL" \
  --role=roles/secretmanager.secretAccessor --condition=None --quiet >/dev/null
gcloud secrets add-iam-policy-binding "$EXPERIENCE_TOKEN_SECRET" \
  --project="$experience_project" --member="serviceAccount:$experience_runtime_email" \
  --role=roles/secretmanager.secretAccessor --condition=None --quiet >/dev/null
assert_direct_secret_accessors "$GCP_PROJECT" "$EDITOR_VERIFIER_SECRET" "$RUNNER_SA_EMAIL" true
assert_direct_secret_accessors "$experience_project" "$EXPERIENCE_TOKEN_SECRET" "$experience_runtime_email" true

if [[ -n "$base_version" ]]; then
  verifier_version="$(gcloud secrets versions access "$base_version" --secret="$EDITOR_VERIFIER_SECRET" --project="$GCP_PROJECT" \
    | build_verifier_payload "$expires_at" 3<<<"$token" \
    | gcloud secrets versions add "$EDITOR_VERIFIER_SECRET" --project="$GCP_PROJECT" --data-file=- --format='value(name)')" \
    || die "could not add the new Editor verifier version; inspect version metadata before retrying"
else
  verifier_version="$(printf '[]' | build_verifier_payload "$expires_at" 3<<<"$token" \
    | gcloud secrets versions add "$EDITOR_VERIFIER_SECRET" --project="$GCP_PROJECT" --data-file=- --format='value(name)')" \
    || die "could not add the new Editor verifier version; inspect version metadata before retrying"
fi
verifier_version="${verifier_version##*/}"
[[ "$verifier_version" =~ ^[1-9][0-9]*$ ]] || die "Editor verifier version was added; read its metadata to pin a numeric version"

token_version="$(printf '%s' "$token" | gcloud secrets versions add "$EXPERIENCE_TOKEN_SECRET" \
  --project="$experience_project" --data-file=- --format='value(name)')" \
  || die "the Experience token upload failed; any new verifier version was disabled. Check version metadata before retrying"
unset token expires_at
token_version="${token_version##*/}"
[[ "$token_version" =~ ^[1-9][0-9]*$ ]] || die "Experience token version was added; read its metadata to pin a numeric version"
unset experience_project experience_runtime_email base_version

printf 'EDITOR_FACE_CREDENTIALS_SECRET_REF=%s:%s\n' "$EDITOR_VERIFIER_SECRET" "$verifier_version"
printf 'GUIDE_EDITOR_API_TOKEN_REF=%s:%s\n' "$EXPERIENCE_TOKEN_SECRET" "$token_version"
