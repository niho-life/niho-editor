BEGIN;

-- recipes_chunked_default: 既定の手順の写し（origin = 'builtin'）の「文字起こし修正」を、長い入力は区切って処理する（chunked）にそろえる（#277）。
--
-- #277 の配備より前に読み出しがあった人の `recipes` の行は、そのときの既定（chunked の印が無い）の写しなので、
-- 既定が ON になっても自動では変わらない。全文を書き直す段階（文字起こし修正）が区切られないままだと、90 分の録音で後半が欠ける。
-- そこで、既定の 2 つ（記事制作 tpl-1・コーチング tpl-4）の「文字起こし修正」だけに `chunked: true` を足す。
--
-- 守ること（利用者が手で変えたものを上書きしない）:
-- - origin = 'builtin' の行だけ。段階の id と名前がともに既定のままのものだけ。
-- - すでに `chunked` の印がある段階（利用者が設定で ON／OFF にしたもの）は触らない。
-- - revision を 1 つ進める。run が写した設計と食い違うので、帯に「設計が変わりました」が出て、利用者が「今の設計に更新」できる
--   （設定を保存したときと同じ道。進行中の run の写しは変わらない）。
-- 何度流しても同じ結果（印があれば何もしない）。run の写し（step_runs.recipe_snapshot）には触らない。
--
-- **この migration は #277 のコードが動いている revision に載ってから流す。** 古い revision（#277 より前）は
-- `isRecipeStep` が知らないキーを持つ段階を読み落とすので、migration が入れ替えより先に走る配備では、入れ替わるまでの間、
-- この手順の「文字起こし修正」が見えなくなる。#277 を配備したあとの配備でこの migration を載せる。

UPDATE recipes AS r
   SET steps = (
         SELECT jsonb_agg(
                  CASE
                    WHEN (   (r.id = 'tpl-1' AND s.step ->> 'id' = 'k7m2q9xa')
                          OR (r.id = 'tpl-4' AND s.step ->> 'id' = 'c5v8n3qd'))
                     AND s.step ->> 'name' = '文字起こし修正'
                     AND NOT (s.step ? 'chunked')
                    THEN s.step || '{"chunked": true}'::jsonb
                    ELSE s.step
                  END
                  ORDER BY s.ord)
           FROM jsonb_array_elements(r.steps) WITH ORDINALITY AS s(step, ord)
       ),
       revision = r.revision + 1,
       updated_at = GREATEST(clock_timestamp(), r.updated_at)
 WHERE r.origin = 'builtin'
   AND r.id IN ('tpl-1', 'tpl-4')
   AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(r.steps) AS s(step)
          WHERE (   (r.id = 'tpl-1' AND s.step ->> 'id' = 'k7m2q9xa')
                 OR (r.id = 'tpl-4' AND s.step ->> 'id' = 'c5v8n3qd'))
            AND s.step ->> 'name' = '文字起こし修正'
            AND NOT (s.step ? 'chunked')
       );

COMMIT;
