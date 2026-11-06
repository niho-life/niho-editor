BEGIN;

-- steps_chunks: 全文を書き直す段階（手順の段階の `chunked` が ON）を、長い入力では約 1.6 万字ずつの区切りで処理する（#277）。
-- 段階の attempt は 1 つのまま（主キーは変えない）で、attempt が区切りを順に進む。1 区切り = 1 回の claim。
-- 追加だけ（expand）。古い行・区切らない段階は chunk_count が NULL のまま。
--
-- chunk_count : 区切りの数（区切らないなら NULL。1〜60）
-- chunk_index : 終えた区切りの数（＝次に処理する区切りの番号。0 始まり）
-- chunk_blocks: 終えた区切りごとの出力ブロックの配列の配列（長さ = chunk_index）。入りかけの出力に partial_blocks は使わない
-- chunk_basis : 最初の区切りを始めたときの入力の基準（sha256 の 16 進 64 字）。区切りの途中で入力が変われば止める

ALTER TABLE step_attempts
  ADD COLUMN chunk_count integer
    CHECK (chunk_count IS NULL OR chunk_count BETWEEN 1 AND 60),
  ADD COLUMN chunk_index integer NOT NULL DEFAULT 0
    CHECK (chunk_index >= 0),
  ADD COLUMN chunk_blocks jsonb
    CHECK (chunk_blocks IS NULL OR jsonb_typeof(chunk_blocks) = 'array'),
  ADD COLUMN chunk_basis text
    CHECK (chunk_basis IS NULL OR chunk_basis ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT step_attempts_chunk_index_range
    CHECK (chunk_count IS NULL OR chunk_index < chunk_count);

COMMIT;
