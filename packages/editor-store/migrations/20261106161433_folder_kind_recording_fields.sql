BEGIN;

-- フォルダを本物の入れ物にし、背景・登場人物・固有名詞を録音ページへ移す（オーナー決定 2026-11-06。
-- docs/architecture/editor-recipes-and-folders.md §3）。名前は日時（new-migration）。
--
-- 1. pages.kind に 'folder' を足す。フォルダは本文も欄も持たず、公開・録音・工程の親にならず、入れ子にしない
--    （守るのは packages/editor-store/src/store.ts と apps/editor-web の API。表は値の集合だけを守る）。
-- 2. page_fields に背景（background。文字）を足す。登場人物・固有名詞と同じ行で、録音ページ自身の id で持つ。
--    上限（4,000 字）は packages/editor-store/src/page-fields.ts が 1 か所で決め、ここでは長さだけを守る。
-- 3. 既存データ: 工程のサブページ以外の子を持つ上の段のページ（これまでの「フォルダ＝親ページ」）を folder にする。
--    本文（blocks）は消さない（画面には出さない。旧「背景情報」は中の録音ページの背景へ人が写す）。
--    消すのは expand → contract の次の配備。親フォルダの id で持っていた page_fields の行も同じ理由で残す。

ALTER TABLE pages DROP CONSTRAINT pages_kind_check;

ALTER TABLE pages
  ADD CONSTRAINT pages_kind_check CHECK (kind IN ('note', 'rec', 'article', 'step', 'folder'));

ALTER TABLE page_fields
  ADD COLUMN background text NOT NULL DEFAULT '' CHECK (length(background) <= 4000);

UPDATE pages p
   SET kind = 'folder'
 WHERE p.kind = 'note'
   AND p.parent IS NULL
   AND EXISTS (
     SELECT 1 FROM pages c
      WHERE c.owner = p.owner AND c.parent = p.id AND c.kind <> 'step' AND c.deleted_at IS NULL
   );

COMMIT;
