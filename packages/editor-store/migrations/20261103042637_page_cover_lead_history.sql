BEGIN;

-- #230: ページのカバー・リードを保存し、以後の履歴から復元できるようにする。
-- 既存の本文履歴はこの情報を持たないため metadata_tracked=false のままにし、復元時は現行値を保つ。
ALTER TABLE page_versions
  ADD COLUMN cover uuid,
  ADD COLUMN lead text,
  ADD COLUMN metadata_tracked boolean NOT NULL DEFAULT false;

COMMIT;
