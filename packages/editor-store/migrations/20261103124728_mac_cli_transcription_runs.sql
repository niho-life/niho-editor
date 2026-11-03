BEGIN;

-- Mac の Antigravity CLI で実行する文字起こしを、既存の台帳と有効 run 一意制約に載せる。
-- executor が server の行だけを Cloud Tasks worker / sweep が扱い、mac-cli は本人の Mac からだけ確定する。
ALTER TABLE transcription_runs
  ADD COLUMN IF NOT EXISTS executor text NOT NULL DEFAULT 'server',
  ADD COLUMN IF NOT EXISTS operation_id uuid,
  ADD COLUMN IF NOT EXISTS settings jsonb,
  ADD COLUMN IF NOT EXISTS audio_manifest jsonb;

ALTER TABLE transcription_runs
  DROP CONSTRAINT transcription_runs_engine_check,
  ADD CONSTRAINT transcription_runs_engine_check CHECK (engine IN ('deepgram', 'fake', 'gemini', 'gemini-cli')),
  DROP CONSTRAINT transcription_runs_error_code_check,
  ADD CONSTRAINT transcription_runs_error_code_check CHECK (
    error_code IS NULL
    OR error_code IN (
      'audio_missing', 'audio_expired', 'engine_unavailable', 'engine_rejected', 'engine_timeout',
      'engine_bad_response', 'too_large', 'internal', 'stopped'
    )
  ),
  ADD CONSTRAINT transcription_runs_executor_check CHECK (executor IN ('server', 'mac-cli')),
  ADD CONSTRAINT transcription_runs_mac_shape_check CHECK (
    (executor = 'server' AND engine IN ('deepgram', 'fake', 'gemini') AND operation_id IS NULL)
    OR
    (executor = 'mac-cli' AND engine = 'gemini-cli' AND operation_id IS NOT NULL AND settings IS NOT NULL AND audio_manifest IS NOT NULL)
  );

CREATE UNIQUE INDEX transcription_runs_mac_operation_idx
  ON transcription_runs (owner, operation_id)
  WHERE executor = 'mac-cli';

COMMIT;
