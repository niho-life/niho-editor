BEGIN;

-- 1 つの録音ページに音声を複数持つ（#36 段 3b-4）と、同じ音声の文字起こしの案を複数持つ（旧 NIHO docs の candidateSets の工程 1 ぶん）。
--
-- 音声（旧 Recording.source.audio の Part に当たる）:
--   最初の音声は 0008 の page_recordings.audio_*（part 0）のまま置き、**2 本目から**この表に入れる。
--   こうすると、再生・文字起こしの claim・期限の表示といった既存の読み取りがそのまま動き、同じ音声を 2 か所に持たない。
--   読む側は part 0（page_recordings）＋ この表（part_index >= 1）を並べて 1 本の音声の列として扱う（listAudioParts）。
--   offset_sec は、その音声の文字起こしをずらす量（秒）＝ 足した時点の「それまでの文字起こしの長さ」。
--   文字起こしの時刻は、前の音声の長さだけずらして 1 本につなぐ（apps/editor-web の append-transcript.ts・compose-parts.ts と同じ規則）。
--   音声の実体は 0008 と同じ private bucket の `audio/{asset id}`（assets.bucket_path）。ブラウザが直接アップロードし、
--   サーバーは「開始」と「完了」だけを見る。30 日で消すのは bucket のライフサイクル規則で、アプリは期限を持って画面に出すだけ。
--
-- 案（page_recording_candidates）:
--   同じ音声を別のエンジンで起こして見比べ、採用する案を選ぶ。段落・話者名は案ごとに持つ（エンジンごとに話者の番号の付け方が
--   違うため。旧版の「話者名が版ごと」に当たる）。採用中の案（adopted）の本文が page_recordings.segments に入っている。
--   案の状態（作っている・できた・失敗した）は列に持たず、有効な run と段落の有無から読む側が決める（実行の表と二重に持たない）。
--   エンジンの名前は text（増えても表を作り直さない）。
--
-- page_recordings.audio_duration_sec:
--   part 0 の**音声そのものの長さ**（申告の値）。duration_sec は「文字起こしの長さ」で、あとの音声・字幕を足すと伸びるので、
--   音声 1 本の長さは別に持つ。既にある行には、今の duration_sec（＝その音声の長さ）を入れる。

ALTER TABLE page_recordings
  ADD COLUMN audio_duration_sec numeric CHECK (audio_duration_sec IS NULL OR audio_duration_sec >= 0);

-- 既にある音声の録音は、文字起こしの長さがその音声の長さ（足す仕組みより前の行）
UPDATE page_recordings SET audio_duration_sec = duration_sec WHERE audio_status <> 'none';

CREATE TABLE page_recording_audios (
  page_id uuid NOT NULL,
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  -- 足した順。part 0 は page_recordings の音声なので、この表は 1 から
  part_index integer NOT NULL CHECK (part_index >= 1),
  asset uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('uploading', 'uploaded')),
  -- 申告の長さ（秒）。分からなければ NULL
  duration_sec numeric CHECK (duration_sec IS NULL OR duration_sec >= 0),
  -- この音声の文字起こしをずらす量（秒）
  offset_sec numeric NOT NULL CHECK (offset_sec >= 0),
  -- 元のファイルの名前だけ（パス・制御文字を含まない。0007 の source_name と同じ規則）
  source_name text CHECK (
    source_name IS NULL
    OR (length(source_name) BETWEEN 1 AND 200 AND source_name !~ '[/\\]' AND source_name !~ '[[:cntrl:]]')
  ),
  -- 音声の期限（表示のためだけに持つ。消すのは bucket のライフサイクル規則）
  expires_at timestamptz,
  -- 開始の要求の冪等キー（任意。同じ owner の中で 1 つ）
  upload_key uuid,
  -- 開始の要求の正規化した内容の SHA-256。同じキーで内容の違う要求を見分ける
  request_hash text CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (page_id, part_index),
  -- 音声は同じ owner のページにだけ付く。ページを消す（hard delete・ゴミ箱の purge）と音声の行も消える
  FOREIGN KEY (owner, page_id) REFERENCES pages (owner, id) ON DELETE CASCADE,
  -- 資産は同じ owner のものだけ。0008 と同じ理由で commit まで遅らせる（ページを消すときの CASCADE の順に頼らない）
  FOREIGN KEY (owner, asset) REFERENCES assets (owner, id) DEFERRABLE INITIALLY DEFERRED,
  -- 1 つの資産を指す音声は 1 行だけ
  CONSTRAINT page_recording_audios_asset_key UNIQUE (owner, asset),
  -- 冪等キーは owner ごとに 1 つ（NULL は重複してよい）
  CONSTRAINT page_recording_audios_upload_key_key UNIQUE (owner, upload_key)
);

CREATE INDEX page_recording_audios_page_idx ON page_recording_audios (owner, page_id, part_index);

CREATE TABLE page_recording_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL,
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  -- 画面の名前（「Deepgram」「Deepgram 2」。前後に空白なし・制御文字なし・60 文字まで）
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60 AND name = btrim(name) AND name !~ '[[:cntrl:]]'),
  -- 作ったエンジン（分からない案は NULL）。増えても表を作り直さないので text
  engine text CHECK (engine IS NULL OR length(engine) BETWEEN 1 AND 64),
  language text NOT NULL CHECK (language IN ('ja', 'en')),
  segments jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(segments) = 'array'),
  speaker_names jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(speaker_names) = 'object'),
  -- その案の文字起こしの長さ（秒）
  duration_sec numeric CHECK (duration_sec IS NULL OR duration_sec >= 0),
  -- 採用中（この案の本文が page_recordings.segments に入っている）。1 ページに 1 つ
  adopted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- 案は同じ owner のページにだけ付く。ページを消すと案も消える
  FOREIGN KEY (owner, page_id) REFERENCES pages (owner, id) ON DELETE CASCADE,
  -- 段落の数の上限（0007 の page_recordings と同じ）
  CONSTRAINT page_recording_candidates_segments_max CHECK (
    CASE WHEN jsonb_typeof(segments) = 'array' THEN jsonb_array_length(segments) <= 20000 ELSE false END
  ),
  CHECK (updated_at >= created_at)
);

CREATE INDEX page_recording_candidates_page_idx ON page_recording_candidates (owner, page_id, created_at);

-- 採用中の案は 1 ページに 1 つ
CREATE UNIQUE INDEX page_recording_candidates_adopted_idx
  ON page_recording_candidates (page_id)
  WHERE adopted;

-- 実行の宛先: どの案に書くか（NULL は正本＝page_recordings.segments）。案を消すと、その案の実行も消える
ALTER TABLE transcription_runs
  ADD COLUMN candidate uuid,
  ADD CONSTRAINT transcription_runs_candidate_fkey
    FOREIGN KEY (candidate) REFERENCES page_recording_candidates (id) ON DELETE CASCADE;

CREATE INDEX transcription_runs_candidate_idx ON transcription_runs (candidate) WHERE candidate IS NOT NULL;

COMMIT;
