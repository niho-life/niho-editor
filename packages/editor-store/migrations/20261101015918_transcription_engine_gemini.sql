BEGIN;

-- 文字起こしに Gemini を足す（#36。オーナー「gemini も早く文字起こしに取り入れて」2026-11-01）。
-- 0012 の実行の表は engine を 'deepgram' か 'fake' に限っていたので、'gemini' を許す。
-- 案（文字起こしの別案）の engine は text（0024 相当の migration）なので、こちらは直さなくてよい。
-- 既にある行は触らない（値は増えるだけ）。

ALTER TABLE transcription_runs
  DROP CONSTRAINT transcription_runs_engine_check,
  ADD CONSTRAINT transcription_runs_engine_check CHECK (engine IN ('deepgram', 'fake', 'gemini'));

COMMIT;
