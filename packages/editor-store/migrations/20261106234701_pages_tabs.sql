BEGIN;

-- フォルダ › ページ › タブ（オーナー決定 2026-11-06。Issue #307、親は #288）。
-- 本文を持つ今の行をそのまま「タブ」にし、その上に「入れ物」（kind = 'page'。題名・役割・並びだけを持ち、本文は持たない）を足す。
-- タブの id は変えない（/p/<id>・共有・公開・assets・page_recordings・page_fields・ai_conversations はそのまま生きる）。
-- 入れ物とタブは同じフォルダ（parent）に並び、タブは `page` で入れ物を指す（親子にしない: 段の規則と今の `parent` の使い方を変えない）。
--
-- 1. pages.kind に 'page'（入れ物）。
-- 2. pages.page（タブが属する入れ物）・role（入れ物の役割。文字起こし／手順の段階）・made_from（タブが何から作られたか）・
--    last_tab（入れ物で最後に開いたタブ）。
-- 3. 既存データ: 本文を持つ全ページ（folder・step 以外）1 行ごとに入れ物を 1 行作り、タブとして結ぶ。
--    録音の下の step（手順のサブページ）は触らない（#309 でフォルダ直下の役割ページのタブへ移す）。
-- 落とすものは無い（expand だけ）。

ALTER TABLE pages DROP CONSTRAINT pages_kind_check;

ALTER TABLE pages
  ADD CONSTRAINT pages_kind_check CHECK (kind IN ('note', 'rec', 'article', 'step', 'folder', 'page'));

ALTER TABLE pages
  ADD COLUMN page uuid,
  ADD COLUMN role jsonb CHECK (role IS NULL OR jsonb_typeof(role) = 'object'),
  ADD COLUMN made_from jsonb CHECK (made_from IS NULL OR jsonb_typeof(made_from) = 'object'),
  ADD COLUMN last_tab uuid,
  -- タブは同じ owner の入れ物にだけ属す（複合キーの SET NULL は owner まで NULL にするので使わない。入れ物を完全に消す前に
  -- purgeTrash が `page` を外し、タブは入れ物の無いページ（1 枚だけの形）として残る）
  ADD CONSTRAINT pages_page_owner_fkey FOREIGN KEY (owner, page) REFERENCES pages (owner, id) ON DELETE RESTRICT,
  ADD CONSTRAINT pages_page_not_self CHECK (page IS NULL OR page <> id);

-- 入れ物のタブを読む（一覧の数・並び）
CREATE INDEX pages_page_idx ON pages (owner, page) WHERE page IS NOT NULL;

-- フォルダの中の役割のあるページ（手順の出力先を探す）
CREATE INDEX pages_role_idx ON pages (owner, parent) WHERE role IS NOT NULL;

-- 既存データ: 本文を持つ行ごとに入れ物を作り、タブとして結ぶ（同じ transaction。tab_map は COMMIT で消える）
CREATE TEMP TABLE tab_map ON COMMIT DROP AS
  SELECT id AS tab, gen_random_uuid() AS page_id
    FROM pages
   WHERE kind NOT IN ('folder', 'step', 'page') AND page IS NULL;

INSERT INTO pages (id, owner, kind, title, lang, blocks, parent, sort_order, created_at, updated_at, deleted_at, last_tab)
SELECT m.page_id, p.owner, 'page', p.title, p.lang, '[]'::jsonb, p.parent, p.sort_order, p.created_at, p.updated_at, p.deleted_at, p.id
  FROM pages AS p
  JOIN tab_map AS m ON m.tab = p.id;

UPDATE pages AS p
   SET page = m.page_id
  FROM tab_map AS m
 WHERE p.id = m.tab;

COMMIT;
