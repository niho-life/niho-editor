BEGIN;

-- Apple の端末内認識を Gemini CLI と別の executor / engine として同じ CAS 台帳へ載せる。
-- mac-local は本人の Mac からだけ確定し、server worker / sweep は executor='server' だけを扱う。
ALTER TABLE transcription_runs
  DROP CONSTRAINT transcription_runs_engine_check,
  ADD CONSTRAINT transcription_runs_engine_check CHECK (
    engine IN ('deepgram', 'fake', 'gemini', 'gemini-cli', 'apple-local')
  ),
  DROP CONSTRAINT transcription_runs_executor_check,
  ADD CONSTRAINT transcription_runs_executor_check CHECK (executor IN ('server', 'mac-cli', 'mac-local')),
  DROP CONSTRAINT transcription_runs_mac_shape_check,
  ADD CONSTRAINT transcription_runs_mac_shape_check CHECK (
    (executor = 'server' AND engine IN ('deepgram', 'fake', 'gemini') AND operation_id IS NULL)
    OR
    (executor = 'mac-cli' AND engine = 'gemini-cli' AND operation_id IS NOT NULL AND settings IS NOT NULL AND audio_manifest IS NOT NULL)
    OR
    (executor = 'mac-local' AND engine = 'apple-local' AND operation_id IS NOT NULL AND settings IS NOT NULL AND audio_manifest IS NOT NULL)
  );

DROP INDEX transcription_runs_mac_operation_idx;
CREATE UNIQUE INDEX transcription_runs_mac_operation_idx
  ON transcription_runs (owner, operation_id)
  WHERE executor IN ('mac-cli', 'mac-local');

COMMIT;
