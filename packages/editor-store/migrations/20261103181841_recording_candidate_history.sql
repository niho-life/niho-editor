BEGIN;

-- Issue #236: 文字起こし候補を独立して編集・復元できるようにする。
-- candidate.revision は本文・話者名・名前・文字起こしメタデータの単調増加 CAS。
-- adopted の切り替えだけでは進めない。candidate_versions は current を含む直近 100 版を残す。
ALTER TABLE page_recording_candidates
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1);

CREATE TABLE page_recording_candidate_versions (
  candidate_id uuid NOT NULL REFERENCES page_recording_candidates (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  name text NOT NULL,
  engine text,
  language text NOT NULL,
  segments jsonb NOT NULL,
  speaker_names jsonb NOT NULL,
  duration_sec numeric,
  reason text NOT NULL CHECK (reason IN ('initial', 'edit', 'recording', 'asr', 'restore')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (candidate_id, version)
);

CREATE INDEX page_recording_candidate_versions_list_idx
  ON page_recording_candidate_versions (candidate_id, version DESC);

CREATE FUNCTION reject_recording_candidate_version_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'recording candidate versions are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER page_recording_candidate_versions_immutable
BEFORE UPDATE ON page_recording_candidate_versions
FOR EACH ROW EXECUTE FUNCTION reject_recording_candidate_version_update();

-- 応答消失後の同じ operation_id の再送を内容 hash と照合する。候補ごとに直近 200 件へ有界化する。
CREATE TABLE page_recording_candidate_operations (
  candidate_id uuid NOT NULL REFERENCES page_recording_candidates (id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('edit', 'restore', 'adopt')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result_revision integer NOT NULL CHECK (result_revision >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (candidate_id, operation_id)
);

CREATE INDEX page_recording_candidate_operations_gc_idx
  ON page_recording_candidate_operations (candidate_id, created_at DESC, operation_id DESC);

-- 候補の全 writer を 1 箇所で捕捉する。理由は transaction-local setting で指定する。
CREATE FUNCTION record_recording_candidate_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('niho.recording_candidate_force_revision', true) = 'true'
     OR ROW(NEW.name, NEW.engine, NEW.language, NEW.segments, NEW.speaker_names, NEW.duration_sec)
       IS DISTINCT FROM ROW(OLD.name, OLD.engine, OLD.language, OLD.segments, OLD.speaker_names, OLD.duration_sec) THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION save_recording_candidate_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version_reason text;
BEGIN
  IF NEW.revision = OLD.revision THEN
    RETURN NEW;
  END IF;
  version_reason := current_setting('niho.recording_candidate_reason', true);
  IF version_reason IS NULL OR version_reason NOT IN ('edit', 'recording', 'asr', 'restore') THEN
    version_reason := 'edit';
  END IF;
  INSERT INTO page_recording_candidate_versions
    (candidate_id, version, name, engine, language, segments, speaker_names, duration_sec, reason)
  VALUES
    (NEW.id, NEW.revision, NEW.name, NEW.engine, NEW.language, NEW.segments, NEW.speaker_names,
     NEW.duration_sec, version_reason);

  DELETE FROM page_recording_candidate_versions AS obsolete_version
   WHERE obsolete_version.candidate_id = NEW.id
     AND obsolete_version.version NOT IN (
       SELECT keep.version
         FROM page_recording_candidate_versions AS keep
        WHERE keep.candidate_id = NEW.id
        ORDER BY keep.version DESC
        LIMIT 100
     );
  RETURN NEW;
END;
$$;

CREATE TRIGGER page_recording_candidates_revision_before
BEFORE UPDATE ON page_recording_candidates
FOR EACH ROW EXECUTE FUNCTION record_recording_candidate_revision();

CREATE TRIGGER page_recording_candidates_version_after
AFTER UPDATE ON page_recording_candidates
FOR EACH ROW EXECUTE FUNCTION save_recording_candidate_version();

-- 既存候補と今後の INSERT を初期版として残す。
INSERT INTO page_recording_candidate_versions
  (candidate_id, version, name, engine, language, segments, speaker_names, duration_sec, reason, created_at)
SELECT id, revision, name, engine, language, segments, speaker_names, duration_sec, 'initial', created_at
  FROM page_recording_candidates;

CREATE FUNCTION save_initial_recording_candidate_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO page_recording_candidate_versions
    (candidate_id, version, name, engine, language, segments, speaker_names, duration_sec, reason, created_at)
  VALUES
    (NEW.id, NEW.revision, NEW.name, NEW.engine, NEW.language, NEW.segments, NEW.speaker_names,
     NEW.duration_sec, 'initial', NEW.created_at);
  RETURN NEW;
END;
$$;

CREATE TRIGGER page_recording_candidates_initial_after
AFTER INSERT ON page_recording_candidates
FOR EACH ROW EXECUTE FUNCTION save_initial_recording_candidate_version();

-- 採用中本文の正本は page_recordings。既存 editor・ASR を含む全 writer を候補へ一方向同期する。
-- 採用切替は先に adopted flag を切り替えてから recording を書くため、旧候補を新本文で上書きしない。
CREATE FUNCTION sync_adopted_recording_candidate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.engine, NEW.language, NEW.segments, NEW.speaker_names, NEW.duration_sec)
       IS NOT DISTINCT FROM ROW(OLD.engine, OLD.language, OLD.segments, OLD.speaker_names, OLD.duration_sec) THEN
    RETURN NEW;
  END IF;
  PERFORM set_config(
    'niho.recording_candidate_reason',
    CASE WHEN current_setting('niho.recording_candidate_reason', true) = 'asr' THEN 'asr' ELSE 'recording' END,
    true
  );
  UPDATE page_recording_candidates
     SET engine = NEW.engine,
         language = NEW.language,
         segments = NEW.segments,
         speaker_names = NEW.speaker_names,
         duration_sec = NEW.duration_sec,
         updated_at = GREATEST(clock_timestamp(), updated_at)
   WHERE owner = NEW.owner AND page_id = NEW.page_id AND adopted;
  RETURN NEW;
END;
$$;

CREATE TRIGGER page_recordings_sync_adopted_candidate
AFTER UPDATE OF engine, language, segments, speaker_names, duration_sec ON page_recordings
FOR EACH ROW EXECUTE FUNCTION sync_adopted_recording_candidate();

-- 旧実装で recording editor の変更後に候補 snapshot が古いまま残った行も、移行時に一度だけ正本へ合わせる。
SELECT set_config('niho.recording_candidate_reason', 'recording', true);
UPDATE page_recording_candidates AS c
   SET engine = r.engine,
       language = r.language,
       segments = r.segments,
       speaker_names = r.speaker_names,
       duration_sec = r.duration_sec,
       updated_at = GREATEST(clock_timestamp(), c.updated_at)
  FROM page_recordings AS r
 WHERE c.owner = r.owner AND c.page_id = r.page_id AND c.adopted
   AND ROW(c.engine, c.language, c.segments, c.speaker_names, c.duration_sec)
       IS DISTINCT FROM ROW(r.engine, r.language, r.segments, r.speaker_names, r.duration_sec);

-- 候補宛て ASR を enqueue 時の candidate revision に固定し、遅着結果で手編集を消さない。
ALTER TABLE transcription_runs
  ADD COLUMN candidate_revision integer CHECK (candidate_revision IS NULL OR candidate_revision >= 1);

UPDATE transcription_runs AS t
   SET candidate_revision = c.revision
  FROM page_recording_candidates AS c
 WHERE t.candidate = c.id;

ALTER TABLE transcription_runs
  ADD CONSTRAINT transcription_runs_candidate_revision_pair CHECK (
    (candidate IS NULL AND candidate_revision IS NULL)
    OR (candidate IS NOT NULL AND candidate_revision IS NOT NULL)
  );

COMMIT;
