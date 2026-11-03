BEGIN;

-- Issue #220: 旧NIHO docsから欠けていた呼び名を、本人単位のAI設定へ追加する。
-- 既存のabout自由記述は変更せず、公開プロフィールや著者情報にも接続しない。
ALTER TABLE editor_settings
  ADD COLUMN about_name text NOT NULL DEFAULT '' CHECK (length(about_name) <= 80);

COMMIT;
