BEGIN;

-- 文字起こしの候補（案）と「採用」、録音の正本の段落を落とす（#310 の contract。expand は 20261107042444_page_transcripts）。
-- 文字起こしは「文字起こし」ページのエンジンごとのタブ（page_transcripts・page_transcript_versions・transcription_runs.target_tab）が持つ。
-- この migration は、そのタブを読み書きするコードが動いている revision に載ってから流す（AGENTS.md の expand → contract。
-- 落とす表・列を読む古い revision が動いている間に流さない）。
--
-- 落とすもの:
--   1. 候補の 3 表（page_recording_candidates・_versions・_operations）と、その trigger・関数
--   2. page_recordings.segments・speaker_names の同期 trigger（sync_adopted_recording_candidate）
--   3. transcription_runs.candidate・candidate_revision・replace と、関連の外部キー・CHECK・index
--   4. page_recordings.segments・speaker_names（と segments の CHECK）。録音の行は音声・原本の名前・長さだけを持つ
-- 残すもの: page_recordings.revision（音声の状態の変化では進めない値。以後は誰も進めない）、transcription_runs.target_tab・base_revision
--   （target_tab が null の古い run は、終わったものの履歴としてだけ残る）。

-- 動いている古い run が無いこと。target_tab の無い queued・running の run は、候補か正本に書く古い経路の run で、
-- 列を落とすと書き先を失う。残っていれば止める（終わるのを待つか、失敗にしてから配備し直す）
DO $$
DECLARE
  live integer;
BEGIN
  SELECT count(*)::integer INTO live
    FROM transcription_runs
   WHERE target_tab IS NULL AND status IN ('queued', 'running');
  IF live > 0 THEN
    RAISE EXCEPTION 'drop_recording_candidates: % transcription run(s) without target_tab are still queued or running; wait for them to finish and deploy again', live
      USING ERRCODE = '55000';
  END IF;
END
$$;

-- 正本の段落がタブに写されないまま消えないこと。#310 の移行は、生きている録音の段落をタブに写した。そのあとに古い revision が
-- 録音の正本へ書いた段落（タブの無い録音）が残っていれば止める。ゴミ箱の録音は移行の対象外だった（#310。復元しても段落は出ない）ので数えない
DO $$
DECLARE
  unconverted integer;
BEGIN
  SELECT count(*)::integer INTO unconverted
    FROM page_recordings AS r
    JOIN pages AS p ON p.owner = r.owner AND p.id = r.page_id AND p.deleted_at IS NULL
   WHERE jsonb_array_length(r.segments) > 0
     AND NOT EXISTS (SELECT 1 FROM page_transcripts AS t WHERE t.owner = r.owner AND t.recording_page_id = r.page_id);
  IF unconverted > 0 THEN
    RAISE EXCEPTION 'drop_recording_candidates: % recording(s) still keep paragraphs that no transcript tab holds; move them into a transcript tab first', unconverted
      USING ERRCODE = '55000';
  END IF;
END
$$;

-- 1. 録音の正本 → 採用中の案への一方向同期
DROP TRIGGER page_recordings_sync_adopted_candidate ON page_recordings;
DROP FUNCTION sync_adopted_recording_candidate();

-- 2. run の宛先（案・案の revision・置き換えの可否）。index と外部キー・CHECK を先に落とす（列を落とせば一緒に消えるが、名前で残す）
DROP INDEX transcription_runs_candidate_idx;
ALTER TABLE transcription_runs
  DROP CONSTRAINT transcription_runs_candidate_revision_pair,
  DROP CONSTRAINT transcription_runs_candidate_fkey,
  DROP COLUMN candidate_revision,
  DROP COLUMN candidate,
  DROP COLUMN replace;

-- 3. 候補の表（trigger は表と一緒に消える）と trigger の関数
DROP TABLE page_recording_candidate_operations;
DROP TABLE page_recording_candidate_versions;
DROP TABLE page_recording_candidates;
DROP FUNCTION reject_recording_candidate_version_update();
DROP FUNCTION record_recording_candidate_revision();
DROP FUNCTION save_recording_candidate_version();
DROP FUNCTION save_initial_recording_candidate_version();

-- 4. 録音の正本の段落・話者名
ALTER TABLE page_recordings
  DROP CONSTRAINT page_recordings_segments_max,
  DROP COLUMN segments,
  DROP COLUMN speaker_names;

COMMIT;
