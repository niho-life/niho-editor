BEGIN;

-- #238: owner の保存済みページを固定 snapshot として Google Docs へ順番に書き出す。
-- 題名・本文は既存 private-job cipher の暗号文だけを持ち、本人 token・cookie・Google credential は持たない。
-- Cloud Tasks への投入は durable outbox に分け、応答消失・重複配送・lease 切れから同じ export id へ収束させる。

CREATE TABLE google_docs_batch_jobs (
  id uuid PRIMARY KEY,
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  root_page_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  options jsonb NOT NULL CHECK (
    jsonb_typeof(options) = 'object'
    AND options ?& ARRAY['includeBackground', 'includeTranscript']
    AND options - ARRAY['includeBackground', 'includeTranscript'] = '{}'::jsonb
    AND jsonb_typeof(options->'includeBackground') = 'boolean'
    AND jsonb_typeof(options->'includeTranscript') = 'boolean'
  ),
  status text NOT NULL DEFAULT 'prepared' CHECK (
    status IN ('prepared', 'queued', 'running', 'cancelling', 'cancelled', 'completed', 'failed', 'expired')
  ),
  grant_id uuid UNIQUE,
  grant_expires_at timestamptz,
  grant_revoked_at timestamptz,
  next_ordinal integer NOT NULL DEFAULT 0 CHECK (next_ordinal >= 0),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  lease_until timestamptz,
  heartbeat_at timestamptz,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cancelled_at timestamptz,
  completed_at timestamptz,
  UNIQUE (owner, id),
  UNIQUE (owner, operation_id),
  FOREIGN KEY (owner, root_page_id) REFERENCES pages (owner, id) ON DELETE CASCADE,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '23 hours 50 minutes'),
  CHECK ((grant_id IS NULL) = (grant_expires_at IS NULL)),
  CHECK (grant_expires_at IS NULL OR (grant_expires_at > created_at AND grant_expires_at <= expires_at + interval '10 minutes')),
  CHECK (grant_revoked_at IS NULL OR (grant_id IS NOT NULL AND grant_revoked_at >= created_at)),
  CHECK (updated_at >= created_at),
  CHECK (cancelled_at IS NULL OR cancelled_at >= created_at),
  CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE INDEX google_docs_batch_jobs_owner_created_idx
  ON google_docs_batch_jobs (owner, created_at DESC);
CREATE INDEX google_docs_batch_jobs_recovery_idx
  ON google_docs_batch_jobs (status, updated_at, id)
  WHERE status IN ('prepared', 'queued', 'running', 'cancelling');

CREATE TABLE google_docs_batch_items (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL,
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  ordinal integer NOT NULL CHECK (ordinal >= 0 AND ordinal < 200),
  page_id uuid NOT NULL,
  page_revision integer NOT NULL CHECK (page_revision > 0),
  export_id uuid NOT NULL UNIQUE,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload_bytes integer NOT NULL CHECK (payload_bytes > 0 AND payload_bytes <= 4194304),
  omissions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(omissions) = 'array' AND jsonb_array_length(omissions) <= 16
  ),
  payload_key_id text CHECK (payload_key_id IS NULL OR payload_key_id ~ '^[A-Za-z0-9._-]{1,32}$'),
  payload_nonce bytea,
  payload_ciphertext bytea,
  payload_tag bytea,
  status text NOT NULL DEFAULT 'prepared' CHECK (
    status IN ('prepared', 'queued', 'running', 'pending', 'completed', 'failed', 'cancelled', 'expired')
  ),
  sent_at timestamptz,
  document_id text CHECK (document_id IS NULL OR document_id ~ '^[A-Za-z0-9_-]{10,256}$'),
  retryable boolean NOT NULL DEFAULT false,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (job_id, ordinal),
  UNIQUE (owner, job_id, id),
  FOREIGN KEY (owner, job_id) REFERENCES google_docs_batch_jobs (owner, id) ON DELETE CASCADE,
  FOREIGN KEY (owner, page_id) REFERENCES pages (owner, id) ON DELETE CASCADE,
  CHECK (
    (payload_key_id IS NULL AND payload_nonce IS NULL AND payload_ciphertext IS NULL AND payload_tag IS NULL)
    OR
    (payload_key_id IS NOT NULL AND octet_length(payload_nonce) = 12 AND octet_length(payload_ciphertext) > 0 AND octet_length(payload_tag) = 16)
  ),
  CHECK ((status = 'completed') = (document_id IS NOT NULL)),
  CHECK (updated_at >= created_at)
);

CREATE INDEX google_docs_batch_items_job_status_idx
  ON google_docs_batch_items (job_id, status, ordinal);

CREATE TABLE google_docs_batch_outbox (
  job_id uuid NOT NULL REFERENCES google_docs_batch_jobs (id) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation > 0),
  dispatch_attempt integer NOT NULL CHECK (dispatch_attempt > 0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'submitted')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (job_id, generation, dispatch_attempt),
  CHECK ((state = 'submitted') = (submitted_at IS NOT NULL)),
  CHECK (updated_at >= created_at)
);

CREATE INDEX google_docs_batch_outbox_pending_idx
  ON google_docs_batch_outbox (available_at, job_id, generation, dispatch_attempt)
  WHERE state = 'pending';

-- A selected descendant is as much a source of the encrypted snapshot as the root.
-- Purge the whole snapshot before any source page is hard-deleted; deleting the job
-- cascades its items/outbox but never asks Google to delete an already-created document.
CREATE FUNCTION purge_google_docs_batches_for_deleted_page() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM google_docs_batch_jobs j
  WHERE j.owner = OLD.owner
    AND (j.root_page_id = OLD.id OR EXISTS (
      SELECT 1 FROM google_docs_batch_items i
      WHERE i.job_id = j.id AND i.owner = OLD.owner AND i.page_id = OLD.id
    ));
  RETURN OLD;
END;
$$;

CREATE TRIGGER pages_purge_google_docs_batches
BEFORE DELETE ON pages
FOR EACH ROW EXECUTE FUNCTION purge_google_docs_batches_for_deleted_page();

COMMIT;
