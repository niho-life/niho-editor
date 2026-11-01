BEGIN;

-- 本人所有の写真ライブラリ（#151）。owner ごとの quota 行を直列化点にし、未確定 upload と
-- 恒久保存済み photo/asset を別表に置く。object の資格情報や公開 URL は保存しない。

CREATE TABLE photo_libraries (
  owner text PRIMARY KEY CHECK (length(owner) BETWEEN 1 AND 256),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deleting')),
  quota_bytes bigint NOT NULL DEFAULT 5368709120 CHECK (quota_bytes = 5368709120),
  used_bytes bigint NOT NULL DEFAULT 0,
  original_bytes bigint NOT NULL DEFAULT 0,
  mask_bytes bigint NOT NULL DEFAULT 0,
  trash_bytes bigint NOT NULL DEFAULT 0,
  pending_purge_bytes bigint NOT NULL DEFAULT 0,
  reserved_bytes bigint NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  next_photo_sequence bigint NOT NULL DEFAULT 1 CHECK (next_photo_sequence > 0),
  lifecycle_epoch bigint NOT NULL DEFAULT 0 CHECK (lifecycle_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id),
  UNIQUE (owner, id),
  CHECK (used_bytes >= 0 AND original_bytes >= 0 AND mask_bytes >= 0 AND reserved_bytes >= 0),
  CHECK (used_bytes = original_bytes + mask_bytes),
  CHECK (trash_bytes >= 0 AND pending_purge_bytes >= 0),
  CHECK (trash_bytes + pending_purge_bytes <= used_bytes),
  CHECK (used_bytes + reserved_bytes <= quota_bytes),
  CHECK (updated_at >= created_at)
);

CREATE TABLE photos (
  owner text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL,
  original_asset_id uuid NOT NULL,
  creation_sequence bigint NOT NULL CHECK (creation_sequence > 0),
  storage_state text NOT NULL DEFAULT 'stored' CHECK (storage_state = 'stored'),
  lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'trashed', 'purging', 'purged')),
  lifecycle_epoch bigint NOT NULL DEFAULT 0 CHECK (lifecycle_epoch >= 0),
  file_name text NOT NULL CHECK (octet_length(file_name) BETWEEN 1 AND 255),
  format text NOT NULL CHECK (format IN ('jpeg', 'png', 'heic', 'heif', 'tiff', 'raw')),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  captured_at timestamptz,
  added_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  trashed_at timestamptz,
  purge_after timestamptz,
  purged_at timestamptz,
  recipe_revision bigint NOT NULL DEFAULT 0 CHECK (recipe_revision >= 0),
  versions_revision bigint NOT NULL DEFAULT 0 CHECK (versions_revision >= 0),
  PRIMARY KEY (owner, id),
  UNIQUE (id),
  UNIQUE (owner, library_id, creation_sequence),
  UNIQUE (owner, id, original_asset_id),
  FOREIGN KEY (owner, library_id) REFERENCES photo_libraries (owner, id) ON DELETE RESTRICT,
  CHECK (
    (lifecycle = 'active' AND trashed_at IS NULL AND purge_after IS NULL AND purged_at IS NULL)
    OR (lifecycle = 'trashed' AND trashed_at IS NOT NULL AND purge_after IS NOT NULL AND purged_at IS NULL)
    OR (lifecycle = 'purging' AND trashed_at IS NOT NULL AND purge_after IS NOT NULL AND purged_at IS NULL)
    OR (lifecycle = 'purged' AND trashed_at IS NOT NULL AND purge_after IS NOT NULL AND purged_at IS NOT NULL)
  )
);

CREATE INDEX photos_owner_sequence_idx ON photos (owner, creation_sequence, id)
  WHERE lifecycle IN ('active', 'trashed');
CREATE INDEX photos_owner_added_idx ON photos (owner, added_at DESC, id DESC)
  WHERE lifecycle IN ('active', 'trashed');
CREATE INDEX photos_owner_captured_idx ON photos (owner, captured_at DESC NULLS LAST, added_at DESC, id DESC)
  WHERE lifecycle IN ('active', 'trashed');
CREATE INDEX photos_owner_purge_due_idx ON photos (owner, purge_after, id)
  WHERE lifecycle = 'trashed';

CREATE TABLE photo_assets (
  owner text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL,
  photo_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('original', 'mask', 'thumbnail', 'preview', 'working-copy')),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  content_type text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 255),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  object_key text NOT NULL CHECK (
    length(object_key) BETWEEN 1 AND 1024
    AND object_key !~ '^[a-zA-Z][a-zA-Z0-9+.-]*://'
    AND object_key !~ '(^|/)\.\.(/|$)'
  ),
  object_generation text NOT NULL CHECK (length(object_generation) BETWEEN 1 AND 255),
  counts_toward_quota boolean NOT NULL,
  deletion_state text NOT NULL DEFAULT 'retained' CHECK (deletion_state IN ('retained', 'pending', 'deleted')),
  deletion_requested_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, id),
  UNIQUE (id),
  UNIQUE (owner, photo_id, id),
  UNIQUE (object_key, object_generation),
  FOREIGN KEY (owner, library_id) REFERENCES photo_libraries (owner, id) ON DELETE RESTRICT,
  FOREIGN KEY (owner, photo_id) REFERENCES photos (owner, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CHECK (counts_toward_quota = (kind IN ('original', 'mask'))),
  CHECK (kind <> 'mask' OR content_type = 'image/png'),
  CHECK (
    (deletion_state = 'retained' AND deletion_requested_at IS NULL AND deleted_at IS NULL)
    OR (deletion_state = 'pending' AND deletion_requested_at IS NOT NULL AND deleted_at IS NULL)
    OR (deletion_state = 'deleted' AND deletion_requested_at IS NOT NULL AND deleted_at IS NOT NULL)
  )
);

ALTER TABLE photos
  -- NO ACTION の遅延照合で、物理削除後のmetadata消去を同一transaction内で行える。
  -- RESTRICT は循環するphoto/assetの先行DELETEを即時に拒むため使わない。
  ADD CONSTRAINT photos_original_asset_owner_fkey
  FOREIGN KEY (owner, id, original_asset_id)
  REFERENCES photo_assets (owner, photo_id, id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX photo_assets_original_digest_idx
  ON photo_assets (owner, sha256, size_bytes)
  WHERE kind = 'original' AND deletion_state = 'retained';
CREATE UNIQUE INDEX photo_assets_mask_digest_idx
  ON photo_assets (owner, photo_id, sha256)
  WHERE kind = 'mask' AND deletion_state = 'retained';
CREATE INDEX photo_assets_photo_idx ON photo_assets (owner, photo_id, kind, id);
CREATE INDEX photo_assets_pending_delete_idx ON photo_assets (owner, deletion_requested_at, id)
  WHERE deletion_state = 'pending';

CREATE FUNCTION reject_photo_asset_immutable_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.owner, NEW.id, NEW.library_id, NEW.photo_id, NEW.kind, NEW.sha256,
         NEW.size_bytes, NEW.content_type, NEW.width, NEW.height,
         NEW.object_key, NEW.object_generation, NEW.counts_toward_quota)
     IS DISTINCT FROM
     ROW(OLD.owner, OLD.id, OLD.library_id, OLD.photo_id, OLD.kind, OLD.sha256,
         OLD.size_bytes, OLD.content_type, OLD.width, OLD.height,
         OLD.object_key, OLD.object_generation, OLD.counts_toward_quota) THEN
    RAISE EXCEPTION 'immutable photo asset fields cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER photo_assets_immutable_update
  BEFORE UPDATE ON photo_assets
  FOR EACH ROW EXECUTE FUNCTION reject_photo_asset_immutable_change();

CREATE FUNCTION reject_photo_original_reference_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.owner, NEW.id, NEW.library_id, NEW.original_asset_id, NEW.creation_sequence)
     IS DISTINCT FROM
     ROW(OLD.owner, OLD.id, OLD.library_id, OLD.original_asset_id, OLD.creation_sequence) THEN
    RAISE EXCEPTION 'immutable photo identity fields cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER photos_immutable_identity_update
  BEFORE UPDATE ON photos
  FOR EACH ROW EXECUTE FUNCTION reject_photo_original_reference_change();

CREATE TABLE photo_uploads (
  owner text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  library_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('original', 'mask')),
  target_photo_id uuid,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'verifying', 'stored', 'cancelled', 'expired', 'rejected')),
  declared_size_bytes bigint NOT NULL CHECK (declared_size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content_type text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 255),
  file_name text CHECK (file_name IS NULL OR octet_length(file_name) BETWEEN 1 AND 255),
  format text CHECK (format IS NULL OR format IN ('jpeg', 'png', 'heic', 'heif', 'tiff', 'raw')),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  reserved_bytes bigint NOT NULL,
  library_lifecycle_epoch bigint NOT NULL CHECK (library_lifecycle_epoch >= 0),
  target_lifecycle_epoch bigint CHECK (target_lifecycle_epoch IS NULL OR target_lifecycle_epoch >= 0),
  lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  verification_job_id uuid,
  verification_lease_until timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '24 hours'),
  result_photo_id uuid,
  result_asset_id uuid,
  completed_lease_generation bigint,
  completed_object_key text,
  completed_object_generation text,
  completed_content_type text,
  completed_format text,
  completed_width integer,
  completed_height integer,
  completed_captured_at timestamptz,
  deduplicated boolean NOT NULL DEFAULT false,
  rejection_code text CHECK (rejection_code IS NULL OR rejection_code IN ('content_rejected', 'unsupported_format', 'pixel_limit_exceeded')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, id),
  UNIQUE (id),
  UNIQUE (owner, operation, idempotency_key),
  FOREIGN KEY (owner, library_id) REFERENCES photo_libraries (owner, id) ON DELETE RESTRICT,
  FOREIGN KEY (owner, target_photo_id) REFERENCES photos (owner, id) ON DELETE RESTRICT,
  FOREIGN KEY (owner, result_photo_id) REFERENCES photos (owner, id) ON DELETE RESTRICT,
  FOREIGN KEY (owner, result_photo_id, result_asset_id) REFERENCES photo_assets (owner, photo_id, id) ON DELETE RESTRICT,
  CHECK ((operation = 'original' AND target_photo_id IS NULL AND file_name IS NOT NULL AND format IS NOT NULL)
      OR (operation = 'mask' AND target_photo_id IS NOT NULL AND file_name IS NULL AND format IS NULL)),
  CHECK (operation <> 'mask' OR content_type = 'image/png'),
  CHECK ((operation = 'original') = (target_lifecycle_epoch IS NULL)),
  CHECK ((state IN ('reserved', 'verifying') AND reserved_bytes = declared_size_bytes)
      OR (state IN ('stored', 'cancelled', 'expired', 'rejected') AND reserved_bytes = 0)),
  CHECK ((state = 'verifying') = (verification_job_id IS NOT NULL AND verification_lease_until IS NOT NULL)),
  CHECK ((state = 'stored') = (result_photo_id IS NOT NULL AND result_asset_id IS NOT NULL
    AND completed_lease_generation IS NOT NULL AND completed_object_key IS NOT NULL AND completed_object_generation IS NOT NULL)),
  CHECK ((state = 'stored') = (completed_content_type IS NOT NULL AND completed_width IS NOT NULL AND completed_height IS NOT NULL)),
  CHECK (completed_object_key IS NULL OR (
    length(completed_object_key) BETWEEN 1 AND 1024
    AND completed_object_key !~ '^[a-zA-Z][a-zA-Z0-9+.-]*://'
    AND completed_object_key !~ '(^|/)\.\.(/|$)'
  )),
  CHECK (completed_object_generation IS NULL OR length(completed_object_generation) BETWEEN 1 AND 255),
  CHECK (completed_content_type IS NULL OR length(completed_content_type) BETWEEN 1 AND 255),
  CHECK (completed_format IS NULL OR completed_format IN ('jpeg', 'png', 'heic', 'heif', 'tiff', 'raw')),
  CHECK ((operation = 'original' AND state = 'stored') = (completed_format IS NOT NULL)),
  CHECK (completed_width IS NULL OR completed_width > 0),
  CHECK (completed_height IS NULL OR completed_height > 0),
  CHECK (NOT deduplicated OR state = 'stored'),
  CHECK ((state = 'rejected') = (rejection_code IS NOT NULL)),
  CHECK (updated_at >= created_at)
);

CREATE INDEX photo_uploads_owner_state_expiry_idx ON photo_uploads (owner, state, expires_at, id);
CREATE INDEX photo_uploads_verification_lease_idx ON photo_uploads (verification_lease_until, id)
  WHERE state = 'verifying';

CREATE TABLE photo_mutations (
  owner text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('trash', 'restore', 'purge')),
  photo_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, operation, photo_id, idempotency_key),
  FOREIGN KEY (owner, photo_id) REFERENCES photos (owner, id) ON DELETE RESTRICT
);

CREATE TABLE photo_recipe_revisions (
  owner text NOT NULL,
  photo_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  settings_sha256 text NOT NULL CHECK (settings_sha256 ~ '^[0-9a-f]{64}$'),
  base_version text,
  mask_surface_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(mask_surface_ids) = 'array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, photo_id, revision),
  FOREIGN KEY (owner, photo_id) REFERENCES photos (owner, id) ON DELETE RESTRICT
);

CREATE TABLE photo_recipes (
  owner text NOT NULL,
  photo_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  settings_sha256 text NOT NULL CHECK (settings_sha256 ~ '^[0-9a-f]{64}$'),
  base_version text,
  mask_surface_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(mask_surface_ids) = 'array'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, photo_id),
  FOREIGN KEY (owner, photo_id, revision) REFERENCES photo_recipe_revisions (owner, photo_id, revision) ON DELETE RESTRICT
);

CREATE TABLE photo_versions (
  owner text NOT NULL,
  photo_id uuid NOT NULL,
  set_revision bigint NOT NULL CHECK (set_revision >= 0),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255),
  kind text NOT NULL CHECK (kind IN ('named', 'auto')),
  recipe jsonb NOT NULL CHECK (jsonb_typeof(recipe) = 'object'),
  settings_sha256 text NOT NULL CHECK (settings_sha256 ~ '^[0-9a-f]{64}$'),
  base_version text,
  mask_surface_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(mask_surface_ids) = 'array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, photo_id, id),
  FOREIGN KEY (owner, photo_id) REFERENCES photos (owner, id) ON DELETE RESTRICT
);

CREATE INDEX photo_versions_set_idx ON photo_versions (owner, photo_id, set_revision, created_at, id);

CREATE TABLE photo_media_jobs (
  owner text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  photo_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'processing', 'ready', 'failed', 'unsupported')),
  lifecycle_epoch bigint NOT NULL CHECK (lifecycle_epoch >= 0),
  original_generation text NOT NULL CHECK (length(original_generation) BETWEEN 1 AND 255),
  base_version text,
  recipe_revision bigint NOT NULL CHECK (recipe_revision >= 0),
  settings_sha256 text NOT NULL CHECK (settings_sha256 ~ '^[0-9a-f]{64}$'),
  renderer_manifest_sha256 text NOT NULL CHECK (renderer_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  output_spec jsonb NOT NULL CHECK (jsonb_typeof(output_spec) = 'object'),
  output_spec_sha256 text NOT NULL CHECK (output_spec_sha256 ~ '^[0-9a-f]{64}$'),
  canonical_metadata jsonb CHECK (canonical_metadata IS NULL OR jsonb_typeof(canonical_metadata) = 'object'),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, id),
  UNIQUE (id),
  FOREIGN KEY (owner, photo_id) REFERENCES photos (owner, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX photo_media_jobs_convergence_idx
  ON photo_media_jobs
    (owner, photo_id, lifecycle_epoch, original_generation, COALESCE(base_version, ''), recipe_revision,
     settings_sha256, renderer_manifest_sha256, output_spec_sha256);

CREATE TABLE photo_purge_jobs (
  owner text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  photo_id uuid NOT NULL,
  lifecycle_epoch bigint NOT NULL CHECK (lifecycle_epoch > 0),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'completed', 'retrying')),
  pending_bytes bigint NOT NULL CHECK (pending_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (owner, id),
  UNIQUE (id),
  UNIQUE (owner, photo_id),
  FOREIGN KEY (owner, photo_id) REFERENCES photos (owner, id) ON DELETE RESTRICT,
  CHECK ((state = 'completed') = (completed_at IS NOT NULL))
);

CREATE TABLE photo_gc_objects (
  owner text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  upload_id uuid,
  object_key text NOT NULL CHECK (
    length(object_key) BETWEEN 1 AND 1024
    AND object_key !~ '^[a-zA-Z][a-zA-Z0-9+.-]*://'
    AND object_key !~ '(^|/)\.\.(/|$)'
  ),
  object_generation text NOT NULL CHECK (length(object_generation) BETWEEN 1 AND 255),
  reason text NOT NULL CHECK (reason IN ('copy_db_failure', 'late_upload', 'duplicate_copy', 'cancelled_upload', 'rejected_upload', 'expired_upload')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  PRIMARY KEY (owner, id),
  UNIQUE (id),
  UNIQUE (object_key, object_generation),
  FOREIGN KEY (owner, upload_id) REFERENCES photo_uploads (owner, id) ON DELETE RESTRICT,
  CHECK ((state = 'deleted') = (deleted_at IS NOT NULL))
);

CREATE INDEX photo_gc_pending_idx ON photo_gc_objects (owner, created_at, id) WHERE state = 'pending';

-- 物理generationは全ownerで一意にし、asset採用とGC登録を同じlocator lockで直列化する。
-- GCへ一度入ったgenerationはretire済みとして、後着のassetから復活させない。
CREATE FUNCTION lock_photo_object_locator(object_key text, object_generation text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(octet_length(object_key)::text || ':' || object_key || object_generation, 0)
  );
END;
$$;

CREATE FUNCTION guard_photo_asset_locator() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM lock_photo_object_locator(NEW.object_key, NEW.object_generation);
  IF EXISTS (
    SELECT 1 FROM photo_gc_objects
     WHERE object_key = NEW.object_key AND object_generation = NEW.object_generation
  ) THEN
    RAISE EXCEPTION 'retired photo object generation cannot become a live asset' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER photo_assets_locator_insert
  BEFORE INSERT ON photo_assets
  FOR EACH ROW EXECUTE FUNCTION guard_photo_asset_locator();

CREATE FUNCTION guard_photo_gc_locator() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM lock_photo_object_locator(NEW.object_key, NEW.object_generation);
  IF EXISTS (
    SELECT 1 FROM photo_assets
     WHERE object_key = NEW.object_key AND object_generation = NEW.object_generation
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER photo_gc_objects_locator_insert
  BEFORE INSERT ON photo_gc_objects
  FOR EACH ROW EXECUTE FUNCTION guard_photo_gc_locator();

COMMIT;
