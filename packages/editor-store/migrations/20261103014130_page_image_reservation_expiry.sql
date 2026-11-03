BEGIN;

-- #219: 開始応答を失った画像予約も、GCS の 7 日 ticket が失効した後に解放できるようにする。
-- 既存の uploading 行には移行時から 8 日の猶予を置く。
ALTER TABLE assets ADD COLUMN reservation_expires_at timestamptz;
UPDATE assets
   SET reservation_expires_at = clock_timestamp() + interval '8 days'
 WHERE kind = 'image' AND upload_status = 'uploading';

COMMIT;
