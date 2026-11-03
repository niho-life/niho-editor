BEGIN;

-- #228: お手本文書の本文と抽出プレビューを、hot-path の recipes JSON から分けてユーザー別に保持する。
CREATE TABLE recipe_sample_bodies (
  owner text NOT NULL,
  recipe_id text NOT NULL,
  sample_id text NOT NULL CHECK (sample_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 30000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, recipe_id, sample_id),
  FOREIGN KEY (owner, recipe_id) REFERENCES recipes(owner, id) ON DELETE CASCADE
);

CREATE TABLE recipe_sample_extractions (
  owner text NOT NULL,
  recipe_id text NOT NULL,
  sample_ids jsonb NOT NULL CHECK (jsonb_typeof(sample_ids) = 'array' AND jsonb_array_length(sample_ids) BETWEEN 1 AND 5),
  guide text NOT NULL CHECK (char_length(guide) BETWEEN 1 AND 4000),
  candidates jsonb NOT NULL CHECK (jsonb_typeof(candidates) = 'array' AND jsonb_array_length(candidates) <= 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner, recipe_id),
  FOREIGN KEY (owner, recipe_id) REFERENCES recipes(owner, id) ON DELETE CASCADE
);

COMMIT;
