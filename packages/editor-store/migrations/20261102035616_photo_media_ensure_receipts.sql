BEGIN;

-- media.ensure の成功した要求だけを owner と photo の下に拘束する。
-- 資格・本文・renderer情報は保存せず、serverが決めた本文hashだけを比較する。
CREATE TABLE photo_media_ensure_receipts (
  owner text NOT NULL,
  photo_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, photo_id, idempotency_key),
  FOREIGN KEY (owner, photo_id) REFERENCES photos(owner, id) ON DELETE CASCADE
);

COMMIT;
