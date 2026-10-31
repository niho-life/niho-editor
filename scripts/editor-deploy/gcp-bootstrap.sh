#!/usr/bin/env bash
# One-time creation of the GCP resources of editor.niho.life (docs/ops/editor-deploy.md §3). Idempotent: what exists is kept.
#
#   scripts/editor-deploy/gcp-bootstrap.sh resources   # APIs, service accounts, Cloud SQL database and roles,
#                                                      # secrets (the AI key's without a version), Artifact Registry,
#                                                      # assets bucket  (before the first deploy)
#   scripts/editor-deploy/deploy.sh                    # first build, migration and deploy
#   scripts/editor-deploy/gcp-bootstrap.sh domain      # custom domain mapping + the DNS record to add (after the first deploy)
#
# Secret values are generated here; they are never written to a file or printed. The AI key is not: the owner adds it
# with scripts/editor-deploy/set-ai-key.sh.
# Needs scripts/editor-deploy/deploy.env (see deploy.env.example) and a gcloud login with project access.
# shellcheck source=scripts/editor-deploy/lib.sh
source "$(dirname "$0")/lib.sh"
load_deploy_env
cd "$REPO_ROOT" || exit 1

phase="${1:-resources}"
case "$phase" in resources|domain) ;; *) die "usage: $0 [resources|domain]" ;; esac

# No pipelines here: with `set -o pipefail` a `head` closing early kills the script with SIGPIPE.
gen_password() { openssl rand -hex 20; }
ensure_secret() {
  gcp secrets describe "$1" > /dev/null 2>&1 \
    || gcp secrets create "$1" --replication-policy automatic --labels "$COST_LABEL"
  gcp secrets update "$1" --update-labels "$COST_LABEL" > /dev/null
}
ensure_service_account() {
  local email="$1" name="$2"
  gcp iam service-accounts describe "$email" > /dev/null 2>&1 \
    || gcp iam service-accounts create "${email%%@*}" --display-name "$name"
}

resources() {
  local number connection
  number="$(project_number)"
  connection="$(cloudsql_connection_name)"

  log "APIs"
  gcp services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
    artifactregistry.googleapis.com cloudbuild.googleapis.com iamcredentials.googleapis.com logging.googleapis.com

  log "service accounts: runtime (the web service) and migrate (the migration job) are separate"
  ensure_service_account "$RUNNER_SA_EMAIL" "NIHO editor runtime (Cloud Run)"
  ensure_service_account "$MIGRATE_SA_EMAIL" "NIHO editor migration job"
  local email
  for email in "$RUNNER_SA_EMAIL" "$MIGRATE_SA_EMAIL"; do
    gcp projects add-iam-policy-binding "$GCP_PROJECT" --condition=None \
      --member "serviceAccount:$email" --role roles/cloudsql.client > /dev/null
  done
  # Signed URLs (assets) are signed through the IAM credentials API with the runtime's own identity.
  gcp iam service-accounts add-iam-policy-binding "$RUNNER_SA_EMAIL" \
    --member "serviceAccount:$RUNNER_SA_EMAIL" --role roles/iam.serviceAccountTokenCreator > /dev/null

  log "Cloud SQL: database $DB_NAME in $CLOUDSQL_INSTANCE"
  gcp sql databases describe "$DB_NAME" --instance "$CLOUDSQL_INSTANCE" > /dev/null 2>&1 \
    || gcp sql databases create "$DB_NAME" --instance "$CLOUDSQL_INSTANCE"

  log "Cloud SQL: migration role (owns the tables) and its secret"
  ensure_secret "$SECRET_MIGRATE_DATABASE_URL"
  local users password
  users="$(gcp sql users list --instance "$CLOUDSQL_INSTANCE" --format='value(name)')"
  if grep -qx "$DB_MIGRATE_ROLE" <<< "$users"; then
    secret_has_version "$SECRET_MIGRATE_DATABASE_URL" \
      || die "$DB_MIGRATE_ROLE exists but $SECRET_MIGRATE_DATABASE_URL has no version: reset the password with 'gcloud sql users set-password' and add it as a new version"
  else
    password="$(gen_password)"
    gcp sql users create "$DB_MIGRATE_ROLE" --instance "$CLOUDSQL_INSTANCE" --password "$password"
    printf 'postgresql://%s:%s@localhost/%s?host=/cloudsql/%s' "$DB_MIGRATE_ROLE" "$password" "$DB_NAME" "$connection" \
      | gcp secrets versions add "$SECRET_MIGRATE_DATABASE_URL" --data-file=- > /dev/null
    unset password
  fi

  log "app role secret (the role itself is created by the migrate job from this URL)"
  ensure_secret "$SECRET_DATABASE_URL"
  if ! secret_has_version "$SECRET_DATABASE_URL"; then
    password="$(gen_password)"
    printf 'postgresql://%s:%s@localhost/%s?host=/cloudsql/%s' "$DB_APP_ROLE" "$password" "$DB_NAME" "$connection" \
      | gcp secrets versions add "$SECRET_DATABASE_URL" --data-file=- > /dev/null
    unset password
  fi
  # The web service reads only the app role's URL. The migration job reads both (it creates the app role).
  gcp secrets add-iam-policy-binding "$SECRET_DATABASE_URL" \
    --member "serviceAccount:$RUNNER_SA_EMAIL" --role roles/secretmanager.secretAccessor > /dev/null
  gcp secrets add-iam-policy-binding "$SECRET_DATABASE_URL" \
    --member "serviceAccount:$MIGRATE_SA_EMAIL" --role roles/secretmanager.secretAccessor > /dev/null
  gcp secrets add-iam-policy-binding "$SECRET_MIGRATE_DATABASE_URL" \
    --member "serviceAccount:$MIGRATE_SA_EMAIL" --role roles/secretmanager.secretAccessor > /dev/null

  log "AI key secret (#38): created without a version; the owner adds the key with set-ai-key.sh (no version = AI stays off)"
  ensure_secret "$SECRET_ANTHROPIC_KEY"
  # Only the web service reads it (the migration job does not).
  gcp secrets add-iam-policy-binding "$SECRET_ANTHROPIC_KEY" \
    --member "serviceAccount:$RUNNER_SA_EMAIL" --role roles/secretmanager.secretAccessor > /dev/null

  log "transcription key secret (#36): created without a version; the owner adds the key with set-transcribe-key.sh (no version = the engine stays off)"
  ensure_secret "$SECRET_DEEPGRAM_KEY"
  # Only the web service reads it (the migration job does not).
  gcp secrets add-iam-policy-binding "$SECRET_DEEPGRAM_KEY" \
    --member "serviceAccount:$RUNNER_SA_EMAIL" --role roles/secretmanager.secretAccessor > /dev/null

  log "gemini key secret (#36 段 3b-4): created without a version; the owner adds the key with set-gemini-key.sh (no version = no Gemini candidates)"
  ensure_secret "$SECRET_GEMINI_KEY"
  # Only the web service reads it (the migration job does not).
  gcp secrets add-iam-policy-binding "$SECRET_GEMINI_KEY" \
    --member "serviceAccount:$RUNNER_SA_EMAIL" --role roles/secretmanager.secretAccessor > /dev/null

  log "google OAuth client secret (#47 google): created without a version if it is missing; an existing secret and its versions are left alone (the owner adds a version with set-google-oauth-secret.sh; no version = nobody can log in)"
  ensure_secret "$SECRET_GOOGLE_OAUTH"
  # Only the web service reads it (the migration job does not).
  gcp secrets add-iam-policy-binding "$SECRET_GOOGLE_OAUTH" \
    --member "serviceAccount:$RUNNER_SA_EMAIL" --role roles/secretmanager.secretAccessor > /dev/null

  log "Cloud Build: the build runs as the compute default service account; it reads the source tarball"
  gcp storage buckets add-iam-policy-binding "gs://${GCP_PROJECT}_cloudbuild" \
    --member "serviceAccount:$number-compute@developer.gserviceaccount.com" \
    --role roles/storage.objectViewer > /dev/null

  log "Artifact Registry $ARTIFACT_REPO"
  gcp artifacts repositories describe "$ARTIFACT_REPO" --location "$GCP_REGION" > /dev/null 2>&1 \
    || gcp artifacts repositories create "$ARTIFACT_REPO" --location "$GCP_REGION" \
      --repository-format docker --description "NIHO editor images"
  gcp artifacts repositories update "$ARTIFACT_REPO" --location "$GCP_REGION" \
    --update-labels "$COST_LABEL" > /dev/null
  gcp artifacts repositories set-cleanup-policies "$ARTIFACT_REPO" --location "$GCP_REGION" \
    --policy "$SCRIPT_DIR/artifact-cleanup.json" --no-dry-run > /dev/null
  # Pushing and pulling the images: Cloud Build (compute default service account) writes, Cloud Run reads.
  gcp artifacts repositories add-iam-policy-binding "$ARTIFACT_REPO" --location "$GCP_REGION" \
    --member "serviceAccount:$number-compute@developer.gserviceaccount.com" \
    --role roles/artifactregistry.writer > /dev/null

  log "assets bucket (private): uniform access, public access prevention"
  if ! gcp storage buckets describe "gs://$ASSETS_BUCKET" > /dev/null 2>&1; then
    gcp storage buckets create "gs://$ASSETS_BUCKET" --location "$GCP_REGION" \
      --uniform-bucket-level-access --public-access-prevention
  fi
  gcp storage buckets update "gs://$ASSETS_BUCKET" --update-labels "$COST_LABEL" > /dev/null
  # Create and read only: the runtime cannot delete or overwrite objects. Deleting (the 30-day trash) is a later,
  # separate grant to a separate identity.
  local role
  for role in roles/storage.objectCreator roles/storage.objectViewer; do
    gcp storage buckets add-iam-policy-binding "gs://$ASSETS_BUCKET" \
      --member "serviceAccount:$RUNNER_SA_EMAIL" --role "$role" > /dev/null
  done
  "$SCRIPT_DIR/steps-infra.sh"
  "$SCRIPT_DIR/transcribe-infra.sh"
  log "resources: done. Next: scripts/editor-deploy/deploy.sh"
}

domain() {
  [[ -n "$APP_DOMAIN" ]] || die "APP_DOMAIN is empty in $DEPLOY_ENV"
  gcp run services describe "$SERVICE" --region "$GCP_REGION" > /dev/null 2>&1 \
    || die "$SERVICE does not exist yet: run scripts/editor-deploy/deploy.sh first"
  # Domain mappings need the gcloud account to have verified the parent domain (Search Console).
  if gcp beta run domain-mappings describe --domain "$APP_DOMAIN" --region "$GCP_REGION" > /dev/null 2>&1; then
    log "domain mapping $APP_DOMAIN already exists"
  else
    log "domain mapping $APP_DOMAIN → $SERVICE"
    gcp beta run domain-mappings create --service "$SERVICE" --domain "$APP_DOMAIN" --region "$GCP_REGION"
  fi
  log "DNS records to register (Cloudflare: type CNAME, proxy OFF = \"DNS only\"):"
  gcp beta run domain-mappings describe --domain "$APP_DOMAIN" --region "$GCP_REGION" \
    --format='table(status.resourceRecords[0].type:label=TYPE, status.resourceRecords[0].name:label=NAME, status.resourceRecords[0].rrdata:label=VALUE)'
  log "certificate status (Google issues it after the record resolves; minutes to an hour):"
  gcp beta run domain-mappings describe --domain "$APP_DOMAIN" --region "$GCP_REGION" \
    --format='value[separator=" "](status.conditions[0].type, status.conditions[0].status, status.conditions[0].message)'
}

case "$phase" in
  resources) resources ;;
  domain) domain ;;
esac
