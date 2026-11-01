BEGIN;

-- 旧revisionも既存active runも開始時revisionが分からないため、0を安全な失効sentinelにする。
-- default 0 はexpand配備中の旧アプリが列を省いても書き込みを継続でき、新コードでは必ず実revisionを指定する。
ALTER TABLE transcription_runs
  ADD COLUMN IF NOT EXISTS base_revision integer NOT NULL DEFAULT 0;

ALTER TABLE transcription_runs
  ADD CONSTRAINT transcription_runs_base_revision_check CHECK (base_revision >= 0);

COMMIT;
