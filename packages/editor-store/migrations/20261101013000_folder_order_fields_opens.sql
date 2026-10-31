BEGIN;

-- 旧 NIHO docs の一覧・フォルダまわりで editor に受け皿が無かったもの（docs/architecture/editor-migration-map.md §5）。
-- オーナー判断（2026-11-01「旧版の機能は全部必要」）で 3 つを足す。名前は日時（#127 の new-migration）。
--
-- 1. 手動の並び（旧 `PageIndex.order`）: pages.sort_order。既定の 0 は「並べ替えていない」で、今までの更新順と同じに出る。
-- 2. フォルダの登場人物・固有名詞（旧 project.json の info.entities・info.terms）: 表 page_fields。
--    背景情報はフォルダのページの本文そのものなので、列は持たない（規則は docs/architecture/editor-recipes-and-folders.md §3）。
-- 3. 「最近」（旧 `recent.json`）: 表 page_opens。開いた時刻だけを持つ（回数・端末は持たない）。

-- 1. 手動の並び（同じ親の中の順。小さいほど上）。0 は並べ替えていない行で、並べ替えると 1 から振り直す
ALTER TABLE pages
  ADD COLUMN sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0);

-- 同じ親の中を並びの順に読む（一覧は owner と親で絞る）
CREATE INDEX pages_owner_parent_order_idx
  ON pages (owner, parent, sort_order)
  WHERE deleted_at IS NULL;

-- 2. フォルダの欄（登場人物・固有名詞）。行が無ければ空（どのページでも持てるが、画面で出すのはフォルダ＝親ページ）。
-- 値の形と上限は packages/editor-store/src/page-fields.ts が決め、ここでは配列であることと件数だけを守る。
CREATE TABLE page_fields (
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  page_id uuid NOT NULL,
  -- 登場人物（[{ name, reading, role, note }]）
  entities jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(entities) = 'array' AND jsonb_array_length(entities) <= 200),
  -- 固有名詞と誤りやすい表記（[{ term, reading, variants, note }]。設定の glossary と同じ形）
  terms jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(terms) = 'array' AND jsonb_array_length(terms) <= 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, page_id),
  CHECK (updated_at >= created_at),
  -- 同じ owner のページだけ。ページを完全に消すと一緒に消える（ゴミ箱の間は残る）
  FOREIGN KEY (owner, page_id) REFERENCES pages (owner, id) ON DELETE CASCADE
);

-- 3. 「最近」: ページを開いた時刻（owner ごとに 1 ページ 1 行。開くたびに時刻を進める）
CREATE TABLE page_opens (
  owner text NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  page_id uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, page_id),
  FOREIGN KEY (owner, page_id) REFERENCES pages (owner, id) ON DELETE CASCADE
);

CREATE INDEX page_opens_owner_at_idx ON page_opens (owner, opened_at DESC);

COMMIT;
