BEGIN;

-- 正規化されていないneutral JSONも固定SDKが判定できる。未知設定は保守的にedited。
ALTER TABLE photo_recipe_revisions ADD COLUMN has_edits boolean NOT NULL DEFAULT true;
ALTER TABLE photo_recipes ADD COLUMN has_edits boolean NOT NULL DEFAULT true;
UPDATE photo_recipe_revisions SET has_edits = false WHERE settings_sha256 IN
  ('198b7c25b44f10770c7301d31d8144dfedbb0393288d3555b7ce1d17a35ca62c', '3a383e927baab026edf69699800751b6ad03f3e1e055bcf6b102345c003631af');
UPDATE photo_recipes SET has_edits = false WHERE settings_sha256 IN
  ('198b7c25b44f10770c7301d31d8144dfedbb0393288d3555b7ce1d17a35ca62c', '3a383e927baab026edf69699800751b6ad03f3e1e055bcf6b102345c003631af');

-- APIのInstantはミリ秒精度なので、keysetも同じ精度とtie-breakを使う。
CREATE INDEX photos_owner_added_millis_idx ON photos
  (owner, date_trunc('milliseconds', added_at AT TIME ZONE 'UTC') DESC, id DESC)
  WHERE lifecycle IN ('active', 'trashed');
CREATE INDEX photos_owner_captured_millis_idx ON photos
  (owner, date_trunc('milliseconds', captured_at AT TIME ZONE 'UTC') DESC NULLS LAST,
   date_trunc('milliseconds', added_at AT TIME ZONE 'UTC') DESC, id DESC)
  WHERE lifecycle IN ('active', 'trashed');

-- 公開APIのrequest bindingと成功したCASのreceipt。応答や資格情報は保存しない。
CREATE TABLE photo_request_journal (
  owner text NOT NULL REFERENCES photo_libraries(owner) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('uploads.start', 'uploads.complete', 'uploads.cancel')),
  resource_id text NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 128),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, operation, resource_id, idempotency_key)
);
CREATE TABLE photo_write_receipts (
  owner text NOT NULL,
  photo_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('recipe', 'versions')),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result_revision bigint NOT NULL CHECK (result_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, photo_id, operation, idempotency_key),
  FOREIGN KEY (owner, photo_id) REFERENCES photos(owner, id) ON DELETE CASCADE
);

-- rendererの選択前にも、確定したsourceを失わずにscheduleできるoutbox。
CREATE TABLE photo_media_outbox (
  owner text NOT NULL,
  photo_id uuid NOT NULL,
  lifecycle_epoch bigint NOT NULL CHECK (lifecycle_epoch >= 0),
  recipe_revision bigint NOT NULL CHECK (recipe_revision >= 0),
  settings_sha256 text NOT NULL CHECK (settings_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz,
  PRIMARY KEY (owner, photo_id, lifecycle_epoch, recipe_revision, settings_sha256),
  FOREIGN KEY (owner, photo_id) REFERENCES photos(owner, id) ON DELETE CASCADE
);
CREATE INDEX photo_media_outbox_pending_idx ON photo_media_outbox(owner, created_at, photo_id) WHERE consumed_at IS NULL;

ALTER TABLE photos ADD COLUMN current_media_job_id uuid;
ALTER TABLE photo_media_jobs
  ADD COLUMN library_lifecycle_epoch bigint NOT NULL DEFAULT 0 CHECK (library_lifecycle_epoch >= 0),
  ADD COLUMN original_asset_id uuid,
  ADD COLUMN original_sha256 text,
  ADD COLUMN original_size_bytes bigint,
  ADD COLUMN source_format text,
  ADD COLUMN source_width integer,
  ADD COLUMN source_height integer,
  ADD COLUMN job_key text,
  ADD COLUMN claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN retry_at timestamptz,
  ADD COLUMN terminal_reason text,
  ADD COLUMN attempt_error text,
  ADD COLUMN ready_media jsonb CHECK (ready_media IS NULL OR jsonb_typeof(ready_media) = 'object');
UPDATE photo_media_jobs AS j SET
  library_lifecycle_epoch = l.lifecycle_epoch,
  original_asset_id = a.id, original_sha256 = a.sha256, original_size_bytes = a.size_bytes,
  source_format = p.format, source_width = p.width, source_height = p.height,
  job_key = j.id::text
FROM photos AS p JOIN photo_libraries AS l ON l.owner = p.owner
JOIN photo_assets AS a ON a.owner = p.owner AND a.photo_id = p.id AND a.id = p.original_asset_id
WHERE p.owner = j.owner AND p.id = j.photo_id;
ALTER TABLE photo_media_jobs
  ALTER COLUMN original_asset_id SET NOT NULL,
  ALTER COLUMN original_sha256 SET NOT NULL,
  ALTER COLUMN original_size_bytes SET NOT NULL,
  ALTER COLUMN source_format SET NOT NULL,
  ALTER COLUMN source_width SET NOT NULL,
  ALTER COLUMN source_height SET NOT NULL,
  ALTER COLUMN job_key SET NOT NULL,
  ADD CHECK (original_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CHECK (original_size_bytes > 0),
  ADD CHECK (source_format IN ('jpeg', 'png', 'heic', 'heif', 'tiff', 'raw')),
  ADD CHECK (source_width > 0 AND source_height > 0),
  ADD CONSTRAINT photo_media_original_asset_fkey FOREIGN KEY (owner, photo_id, original_asset_id)
    REFERENCES photo_assets(owner, photo_id, id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX photo_media_jobs_key_idx ON photo_media_jobs(owner, job_key);
CREATE INDEX photo_media_jobs_pending_idx ON photo_media_jobs(owner, retry_at, created_at, id) WHERE state IN ('queued', 'processing') AND terminal_reason IS NULL;
ALTER TABLE photos ADD CONSTRAINT photos_current_media_job_fkey FOREIGN KEY (owner, current_media_job_id)
  REFERENCES photo_media_jobs(owner, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- objectの書込前にallocationを記録し、結果不明も照合・清掃できる。公開後は削除候補にしない。
CREATE TABLE photo_media_candidates (
  owner text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  claim_generation bigint NOT NULL CHECK (claim_generation > 0),
  kind text NOT NULL CHECK (kind IN ('thumbnail', 'preview', 'working-copy')),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png')),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 1024 AND object_key !~ '^[a-zA-Z][a-zA-Z0-9+.-]*://' AND object_key !~ '(^|/)\.\.(/|$)'),
  object_generation text CHECK (object_generation IS NULL OR length(object_generation) BETWEEN 1 AND 255),
  state text NOT NULL DEFAULT 'allocated' CHECK (state IN ('allocated', 'staged', 'published', 'abandoned', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, id),
  UNIQUE (id),
  UNIQUE (object_key),
  FOREIGN KEY (owner, job_id) REFERENCES photo_media_jobs(owner, id) ON DELETE RESTRICT,
  CHECK (state NOT IN ('staged', 'published', 'deleted') OR object_generation IS NOT NULL)
);
CREATE INDEX photo_media_candidates_cleanup_idx ON photo_media_candidates(owner, created_at, id) WHERE state IN ('allocated', 'abandoned');

CREATE FUNCTION enqueue_photo_recipe_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE photos SET current_media_job_id = NULL WHERE owner = NEW.owner AND id = NEW.photo_id;
  INSERT INTO photo_media_outbox(owner, photo_id, lifecycle_epoch, recipe_revision, settings_sha256)
    SELECT p.owner, p.id, p.lifecycle_epoch, NEW.revision, NEW.settings_sha256
      FROM photos AS p JOIN photo_libraries AS l ON l.owner = p.owner
     WHERE p.owner = NEW.owner AND p.id = NEW.photo_id AND p.lifecycle = 'active' AND l.state = 'active'
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER photo_recipes_media_outbox AFTER INSERT OR UPDATE ON photo_recipes
  FOR EACH ROW EXECUTE FUNCTION enqueue_photo_recipe_outbox();
CREATE FUNCTION enqueue_photo_lifecycle_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lifecycle_epoch IS DISTINCT FROM OLD.lifecycle_epoch THEN
    UPDATE photos SET current_media_job_id = NULL WHERE owner = NEW.owner AND id = NEW.id;
    INSERT INTO photo_media_outbox(owner, photo_id, lifecycle_epoch, recipe_revision, settings_sha256)
      SELECT p.owner, p.id, p.lifecycle_epoch, r.revision, r.settings_sha256
        FROM photos AS p JOIN photo_libraries AS l ON l.owner = p.owner
        JOIN photo_recipes AS r ON r.owner = p.owner AND r.photo_id = p.id
       WHERE p.owner = NEW.owner AND p.id = NEW.id AND p.lifecycle = 'active' AND l.state = 'active'
      ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER photos_lifecycle_media_outbox AFTER UPDATE OF lifecycle, lifecycle_epoch ON photos
  FOR EACH ROW EXECUTE FUNCTION enqueue_photo_lifecycle_outbox();
COMMIT;
