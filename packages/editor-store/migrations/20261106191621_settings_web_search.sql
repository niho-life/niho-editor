BEGIN;

-- Issue #283: AI チャットが Web を検索してよいか（設定 › AI の「Web を検索する」）。既定 ON（オーナー決定 2026-11-06）。
-- expand だけ（既存の行は既定の true として読む）。
ALTER TABLE editor_settings
  ADD COLUMN web_search boolean NOT NULL DEFAULT true;

COMMIT;
