BEGIN;

-- AI チャットをアプリ全体で 1 つに（#312。親は #288。オーナー決定 2026-11-06）。
-- 会話はページでなく利用者（owner）に属し、ページを移っても続く。ai_conversations.page_id は「始めたページ」として残すだけ。
-- 発言には、その turn で開いていたページ（タブ）を page_id で残す（返答の見出し「◯◯ で」）。
-- ページが消えても会話は消さない（複合キーの ON DELETE SET NULL は owner まで NULL にするので、FK を外し、
-- ページの物理削除のときに trigger で page_id を外す）。落とすものは無い（expand だけ）。

ALTER TABLE ai_conversations ALTER COLUMN page_id DROP NOT NULL;
ALTER TABLE ai_conversations DROP CONSTRAINT ai_conversations_owner_page_id_fkey;

-- 利用者の会話の一覧（新しい順）
CREATE INDEX ai_conversations_owner_idx ON ai_conversations (owner, updated_at DESC, id DESC);

-- その turn で開いていたページ（タブ）。消えたページは trigger で NULL になる（題名は読むときに pages から引く）
ALTER TABLE ai_messages ADD COLUMN page_id uuid;

CREATE FUNCTION ai_conversations_unlink_page() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ai_conversations SET page_id = NULL WHERE page_id = OLD.id;
  UPDATE ai_messages SET page_id = NULL WHERE page_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER pages_unlink_ai_conversations
  BEFORE DELETE ON pages
  FOR EACH ROW EXECUTE FUNCTION ai_conversations_unlink_page();

COMMIT;
