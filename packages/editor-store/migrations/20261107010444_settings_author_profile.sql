BEGIN;

-- 公開用の著者紹介（肩書・紹介文）。公開のとき公開版に `authorProfile` として固定する（名前と同じく、
-- あとで設定を変えても既存の公開版は変わらない）。「あなたについて」（about・about_name。AI に渡すもので公開しない）とは別物。
-- 空は NULL。上限は公開 API v1 の PUBLISHED_LIMITS（maxAuthorRoleChars・maxAuthorBioChars）と同じ。
-- expand だけ（既存の行は両方 NULL＝紹介なし、として読む）。
ALTER TABLE editor_settings
  ADD COLUMN author_role text NULL CHECK (author_role IS NULL OR char_length(author_role) <= 120),
  ADD COLUMN author_bio text NULL CHECK (author_bio IS NULL OR char_length(author_bio) <= 600);

COMMIT;
