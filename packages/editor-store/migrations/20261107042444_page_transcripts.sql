BEGIN;

-- 文字起こしをタブに（#310。親は #288。前提は #307 #308 #309）。オーナー決定 2026-11-06: 文字起こしは「文字起こし」ページのタブ（エンジンごと）。候補と「採用」はやめる。
-- 1. page_transcripts: 文字起こしのタブ（pages.kind = 'note'・made_from = {kind:'transcript', recording, engine}）に 1 行。段落・話者名は page_recordings と同じ形。
--    音声は録音のタブの資産のまま（assets.page_id・page_recordings.audio_* は動かさない）。recording_page_id は録音のタブ（外部キーにしない:
--    録音が完全に消えても文字起こしの本文は残す。ゴミ箱なら画面が「再生できません」と出す）。
-- 2. page_transcript_versions: タブの版（候補の版を写す。編集・ASR の書き込み・戻しで増える。100 まで）。
-- 3. transcription_runs.target_tab: run の出力先のタブ（server・Mac とも）。
-- 4. 既存のデータ: 段落か案のある録音ごとに、フォルダの中に役割 transcript の入れ物「文字起こし」を作り、案 1 つ＝タブ 1 つ、
--    採用済みの案が無ければ正本（page_recordings）の段落を 1 つのタブに写す。録音がフォルダの外なら、その題名でフォルダを作って包む。
-- 候補の表・採用の口は expand → contract: この配備の 1 つ後の migration で落とす（AGENTS.md）。page_recordings.segments も残す。

CREATE TABLE page_transcripts (
  page_id uuid PRIMARY KEY,
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  recording_page_id uuid NOT NULL,
  engine text NOT NULL CHECK (length(engine) BETWEEN 1 AND 64),
  language text NOT NULL CHECK (language IN ('ja', 'en')),
  segments jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(segments) = 'array'),
  speaker_names jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(speaker_names) = 'object'),
  duration_sec numeric CHECK (duration_sec IS NULL OR duration_sec >= 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (owner, page_id) REFERENCES pages (owner, id) ON DELETE CASCADE,
  CONSTRAINT page_transcripts_segments_max CHECK (
    CASE WHEN jsonb_typeof(segments) = 'array' THEN jsonb_array_length(segments) <= 20000 ELSE false END
  ),
  CHECK (updated_at >= created_at)
);

CREATE INDEX page_transcripts_recording_idx ON page_transcripts (owner, recording_page_id);

CREATE TABLE page_transcript_versions (
  page_id uuid NOT NULL REFERENCES page_transcripts (page_id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  engine text NOT NULL,
  language text NOT NULL,
  segments jsonb NOT NULL,
  speaker_names jsonb NOT NULL,
  duration_sec numeric,
  reason text NOT NULL CHECK (reason IN ('initial', 'edit', 'asr', 'restore')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (page_id, version)
);

ALTER TABLE transcription_runs ADD COLUMN target_tab uuid;
CREATE INDEX transcription_runs_target_idx ON transcription_runs (target_tab) WHERE target_tab IS NOT NULL;

-- 対象の録音（生きているタブ。段落か案があるもの）
CREATE TEMP TABLE tx_recs ON COMMIT DROP AS
  SELECT rec.id AS rec, rec.owner, rec.page AS holder, rec.parent AS folder, rec.lang, rec.title,
         r.language, r.engine, r.segments, r.speaker_names, r.duration_sec, r.revision, r.created_at, r.updated_at
    FROM pages rec
    JOIN page_recordings r ON r.owner = rec.owner AND r.page_id = rec.id
   WHERE rec.kind = 'rec' AND rec.deleted_at IS NULL AND rec.page IS NOT NULL
     AND (jsonb_array_length(r.segments) > 0
          OR EXISTS (SELECT 1 FROM page_recording_candidates c WHERE c.owner = rec.owner AND c.page_id = rec.id));

-- フォルダの外の録音は、その入れ物の題名でフォルダを作って入れ物ごと入れる（#309 の wrapInFolder と同じ）
CREATE TEMP TABLE tx_folders ON COMMIT DROP AS
  SELECT t.rec, t.owner, t.holder, gen_random_uuid() AS folder, t.title, t.lang, t.created_at
    FROM tx_recs t
   WHERE NOT EXISTS (SELECT 1 FROM pages f WHERE f.owner = t.owner AND f.id = t.folder AND f.kind = 'folder' AND f.deleted_at IS NULL);

INSERT INTO pages (id, owner, kind, title, lang, blocks, created_at, updated_at)
  SELECT folder, owner, 'folder', title, lang, '[]'::jsonb, created_at, created_at FROM tx_folders;

UPDATE pages p
   SET parent = w.folder
  FROM tx_folders w
 WHERE p.owner = w.owner AND (p.id = w.holder OR p.page = w.holder) AND p.deleted_at IS NULL;

UPDATE tx_recs t SET folder = w.folder FROM tx_folders w WHERE w.rec = t.rec;

-- 「文字起こし」の入れ物（役割 transcript）: フォルダに 1 つ。既にあればそれを使う
CREATE TEMP TABLE tx_holders ON COMMIT DROP AS
  SELECT DISTINCT ON (owner, folder) owner, folder, gen_random_uuid() AS id, lang, created_at
    FROM tx_recs
   ORDER BY owner, folder, created_at, rec;

UPDATE tx_holders h
   SET id = e.id
  FROM pages e
 WHERE e.owner = h.owner AND e.parent = h.folder AND e.kind = 'page' AND e.deleted_at IS NULL AND e.role = '{"kind":"transcript"}'::jsonb;

INSERT INTO pages (id, owner, kind, title, lang, blocks, parent, role, created_at, updated_at)
  SELECT h.id, h.owner, 'page', '文字起こし', h.lang, '[]'::jsonb, h.folder, '{"kind":"transcript"}'::jsonb, h.created_at, h.created_at
    FROM tx_holders h
   WHERE NOT EXISTS (SELECT 1 FROM pages e WHERE e.id = h.id);

-- タブ: 案 1 つ＝タブ 1 つ（札は案の名前）。採用済みの案が無い録音は、正本の段落を 1 つのタブに（札はエンジンの名前）
CREATE TEMP TABLE tx_tabs ON COMMIT DROP AS
  SELECT gen_random_uuid() AS tab, c.id AS candidate, t.rec, t.owner, t.folder, h.id AS holder, h.lang,
         c.name AS tab_name, COALESCE(c.engine, 'import') AS engine, c.language, c.segments, c.speaker_names, c.duration_sec, c.revision,
         c.created_at, GREATEST(c.updated_at, c.created_at) AS updated_at
    FROM page_recording_candidates c
    JOIN tx_recs t ON t.owner = c.owner AND t.rec = c.page_id
    JOIN tx_holders h ON h.owner = t.owner AND h.folder = t.folder
  UNION ALL
  SELECT gen_random_uuid(), NULL, t.rec, t.owner, t.folder, h.id, h.lang,
         CASE COALESCE(t.engine, 'import')
           WHEN 'deepgram' THEN 'Deepgram' WHEN 'gemini' THEN 'Gemini' WHEN 'gemini-cli' THEN 'Gemini（このMacのCLI）'
           WHEN 'apple-local' THEN 'Apple（このMac内）' WHEN 'vtt-import' THEN '取り込んだ字幕' WHEN 'fake' THEN '開発の偽物'
           ELSE COALESCE(t.engine, '取り込み') END,
         COALESCE(t.engine, 'import'), t.language, t.segments, t.speaker_names, t.duration_sec, t.revision,
         t.created_at, GREATEST(t.updated_at, t.created_at)
    FROM tx_recs t
    JOIN tx_holders h ON h.owner = t.owner AND h.folder = t.folder
   WHERE jsonb_array_length(t.segments) > 0
     AND NOT EXISTS (SELECT 1 FROM page_recording_candidates c WHERE c.owner = t.owner AND c.page_id = t.rec AND c.adopted);

INSERT INTO pages (id, owner, kind, title, lang, blocks, parent, page, made_from, sort_order, tab_name, created_at, updated_at)
  SELECT x.tab, x.owner, 'note', '文字起こし', x.lang, '[]'::jsonb, x.folder, x.holder,
         jsonb_build_object('kind', 'transcript', 'recording', x.rec, 'engine', x.engine),
         row_number() OVER (PARTITION BY x.holder ORDER BY x.created_at, x.tab),
         left(x.tab_name, 100), x.created_at, x.updated_at
    FROM tx_tabs x;

INSERT INTO page_transcripts (page_id, owner, recording_page_id, engine, language, segments, speaker_names, duration_sec, revision, created_at, updated_at)
  SELECT tab, owner, rec, engine, language, segments, speaker_names, duration_sec, revision, created_at, updated_at FROM tx_tabs;

INSERT INTO page_transcript_versions (page_id, version, engine, language, segments, speaker_names, duration_sec, reason, created_at)
  SELECT x.tab, v.version, COALESCE(v.engine, x.engine), v.language, v.segments, v.speaker_names, v.duration_sec,
         CASE v.reason WHEN 'recording' THEN 'edit' ELSE v.reason END, v.created_at
    FROM page_recording_candidate_versions v
    JOIN tx_tabs x ON x.candidate = v.candidate_id;

UPDATE pages h
   SET last_tab = (SELECT x.tab FROM tx_tabs x WHERE x.holder = h.id ORDER BY x.created_at DESC, x.tab LIMIT 1),
       updated_at = GREATEST(h.updated_at, (SELECT max(x.updated_at) FROM tx_tabs x WHERE x.holder = h.id))
  FROM tx_holders s
 WHERE h.id = s.id;

-- run の出力先: 案に書いた run はその案のタブ、正本に書いた run は正本のタブ（正本から作ったタブ。採用済みの案があればその案のタブ）
UPDATE transcription_runs r SET target_tab = x.tab FROM tx_tabs x WHERE x.candidate IS NOT NULL AND r.candidate = x.candidate;
UPDATE transcription_runs r SET target_tab = x.tab
  FROM tx_tabs x
 WHERE r.candidate IS NULL AND r.owner = x.owner AND r.page_id = x.rec
   AND (x.candidate IS NULL OR EXISTS (SELECT 1 FROM page_recording_candidates c WHERE c.id = x.candidate AND c.adopted));

COMMIT;
