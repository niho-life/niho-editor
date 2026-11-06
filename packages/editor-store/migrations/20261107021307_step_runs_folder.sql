BEGIN;

-- 手順の run をフォルダに結ぶ（#309。親は #288。前提は #307 #308 のページ › タブ。オーナー決定 2026-11-06: 1 フォルダに 1 つの手順）。
-- 1. step_runs.parent は録音ページではなく**フォルダ**。run の入力は input_tab（どのタブから作ったか）と、そのときの revision。
--    進行中の run はフォルダに 1 つ（step_runs_active_idx はそのまま）。
-- 2. 既存の run: 親の録音がフォルダの中なら、親をそのフォルダに、input_tab を録音にする（フォルダの外の録音の run はそのまま残り、
--    次の作成でフォルダに包まれる）。
-- 3. 録音の下の段階のサブページ（kind = 'step'）は、フォルダ直下の役割ページ（role = step）のタブにする（id は変えない。本文・版・公開はそのまま）。
-- 落とすものは無い（expand だけ）。

ALTER TABLE step_runs
  ADD COLUMN input_tab uuid,
  ADD COLUMN input_revision integer CHECK (input_revision IS NULL OR input_revision >= 0);

-- 同じフォルダに進行中の run が 2 つ以上集まると step_runs_active_idx に当たるので、フォルダごとに最新の 1 つだけ残し、古い進行中の run は取消にする
WITH moving AS (
  SELECT r.id, r.owner, f.id AS folder, r.created_at
    FROM step_runs r
    JOIN pages rec ON rec.owner = r.owner AND rec.id = r.parent AND rec.kind = 'rec'
    JOIN pages f ON f.owner = rec.owner AND f.id = rec.parent AND f.kind = 'folder' AND f.deleted_at IS NULL
   WHERE r.state IN ('queued', 'running')
), losers AS (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY owner, folder ORDER BY created_at DESC, id DESC) AS rn FROM moving
  ) ranked WHERE rn > 1
)
UPDATE step_runs SET state = 'canceled', finished_at = clock_timestamp(), updated_at = clock_timestamp()
 WHERE id IN (SELECT id FROM losers);

UPDATE step_attempts a
   SET state = 'canceled', generation = generation + 1, lease_until = NULL, finished_at = clock_timestamp()
  FROM step_runs r
 WHERE r.id = a.run_id AND r.state = 'canceled' AND r.finished_at IS NOT NULL AND a.state IN ('pending', 'queued', 'running')
   AND r.updated_at >= clock_timestamp() - interval '1 minute';

-- 親の録音が**フォルダ**の中にある run だけを動かす（親がフォルダでない行はそのまま）
UPDATE step_runs r
   SET parent = f.id, input_tab = rec.id, input_revision = rec.revision
  FROM pages rec
  JOIN pages f ON f.owner = rec.owner AND f.id = rec.parent AND f.kind = 'folder' AND f.deleted_at IS NULL
 WHERE rec.owner = r.owner AND rec.id = r.parent AND rec.kind = 'rec';

-- 段階のサブページ → 役割ページのタブ（生きているものだけ。ゴミ箱の中のサブページはそのまま）
-- 系譜（made_from.input）: 最初の段階は録音、後の段階は同じ run の直前の段階の出力（生きていれば。無ければ録音）
CREATE TEMP TABLE step_tab_map ON COMMIT DROP AS
  SELECT p.id AS tab, p.owner, f.id AS folder, rec.id AS rec, p.recipe, p.title, p.lang, p.created_at, a.step_id, a.run_id,
         COALESCE(prev.page_id, rec.id) AS input
    FROM pages p
    JOIN pages rec ON rec.owner = p.owner AND rec.id = p.parent AND rec.kind = 'rec'
    JOIN pages f ON f.owner = rec.owner AND f.id = rec.parent AND f.kind = 'folder' AND f.deleted_at IS NULL
    JOIN LATERAL (
      SELECT a.step_id, a.run_id, a.step_index
        FROM step_attempts a
        JOIN step_runs r ON r.id = a.run_id
       WHERE r.owner = p.owner AND a.page_id = p.id
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT 1
    ) a ON true
    LEFT JOIN LATERAL (
      SELECT b.page_id
        FROM step_attempts b
        JOIN pages q ON q.id = b.page_id AND q.owner = p.owner AND q.deleted_at IS NULL
       WHERE b.run_id = a.run_id AND b.step_index = a.step_index - 1
    ) prev ON a.step_index > 0
   WHERE p.kind = 'step' AND p.deleted_at IS NULL AND p.recipe IS NOT NULL;

CREATE TEMP TABLE step_holder_map ON COMMIT DROP AS
  SELECT owner, folder, recipe, step_id, gen_random_uuid() AS holder, min(title) AS title, min(lang) AS lang, min(created_at) AS created_at
    FROM step_tab_map
   GROUP BY owner, folder, recipe, step_id;

INSERT INTO pages (id, owner, kind, title, lang, blocks, parent, role, created_at, updated_at)
  SELECT holder, owner, 'page', title, lang, '[]'::jsonb, folder,
         jsonb_build_object('kind', 'step', 'recipe', recipe, 'stepId', step_id), created_at, created_at
    FROM step_holder_map;

UPDATE pages p
   SET kind = 'note', page = h.holder, parent = m.folder,
       made_from = jsonb_build_object('kind', 'step', 'run', m.run_id, 'input', m.input, 'inputRevision', 0),
       sort_order = (SELECT count(*) FROM step_tab_map o
                      WHERE o.owner = m.owner AND o.folder = m.folder AND o.recipe = m.recipe AND o.step_id = m.step_id
                        AND (o.created_at, o.tab) <= (m.created_at, m.tab))
  FROM step_tab_map m
  JOIN step_holder_map h ON h.owner = m.owner AND h.folder = m.folder AND h.recipe = m.recipe AND h.step_id = m.step_id
 WHERE p.id = m.tab;

UPDATE pages h
   SET last_tab = (SELECT m.tab FROM step_tab_map m
                    WHERE m.owner = s.owner AND m.folder = s.folder AND m.recipe = s.recipe AND m.step_id = s.step_id
                    ORDER BY m.created_at, m.tab LIMIT 1)
  FROM step_holder_map s
 WHERE h.id = s.holder;

COMMIT;
