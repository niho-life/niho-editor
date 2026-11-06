BEGIN;

-- 画像ごとの「共有画像にも使ってよい」許諾（SNS・検索結果に出る OG 画像や Article.image に使う）。
-- 掲載許諾（consent。ページに載せてよい）とは別の許諾で、公開版はカバーが consent かつ share のときだけ
-- `coverShareable: true` を持つ（docs/architecture/editor-publish-core.md）。
-- expand だけ（既存の行は false＝共有には使わない、として読む。公開済みの版は変わらない）。
ALTER TABLE assets
  ADD COLUMN share boolean NOT NULL DEFAULT false;

COMMIT;
