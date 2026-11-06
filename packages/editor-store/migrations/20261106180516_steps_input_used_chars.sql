BEGIN;

-- #277: まとめる段階の資料を上限（合計 100,000 字）で切ったときに、実際に使った字数（code point）。
-- 帯に「入力が長いので先頭 N 字だけ使いました」と出すため（黙って欠けさせない）。切っていなければ NULL。
-- 追加だけ（expand）。古い行は NULL のままで、帯には何も出ない。

ALTER TABLE step_attempts
  ADD COLUMN input_used_chars integer
    CHECK (input_used_chars IS NULL OR input_used_chars >= 0);

COMMIT;
