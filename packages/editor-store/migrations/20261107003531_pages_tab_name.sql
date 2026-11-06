BEGIN;

-- タブの名前（#308。親は #288、前提は #307 の入れ物とタブ）。
-- 画面では、題名（本文の上の h1）はページの名前で、入れ物とその全てのタブで同じ（モック editor-folder-pages-v1。
-- 公開・共有・検索・書き出しが読む `title` はこれまでどおりタブの行にあり、保存のたびに入れ物と兄弟のタブへ写す）。
-- タブの帯に出す「タブの名前」（下書き・英語版・Gemini など）は、それとは別の短い札なので、列を分ける。
-- NULL は名前を付けていないタブ（画面は入れ物の中の位置の番号を出す）。入れ物・フォルダ・手順のサブページは持たない。
-- 落とすものは無い（expand だけ）。

ALTER TABLE pages
  ADD COLUMN tab_name text,
  ADD CONSTRAINT pages_tab_name_tabs_only CHECK (tab_name IS NULL OR page IS NOT NULL),
  ADD CONSTRAINT pages_tab_name_length CHECK (tab_name IS NULL OR char_length(tab_name) BETWEEN 1 AND 100);

COMMIT;
