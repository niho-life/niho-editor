BEGIN;

-- #221: a run owns the recipe design used by every queued, retried and resumed attempt.
ALTER TABLE step_runs ADD COLUMN recipe_snapshot jsonb;
ALTER TABLE step_runs ADD COLUMN recipe_revision integer;

-- #224: old single digests carry no reason information. Preserve them as JSON strings;
-- the reader treats them as unrecorded, so deployment alone never marks pages stale.
ALTER TABLE step_attempts DROP CONSTRAINT step_attempts_input_basis_check;
ALTER TABLE step_attempts ALTER COLUMN input_basis TYPE jsonb USING to_jsonb(input_basis);
CREATE FUNCTION editor_step_basis_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  item text;
  artifact jsonb;
BEGIN
  IF jsonb_typeof(value) <> 'object' OR
     (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(value) AS key) <>
       ARRAY['artifacts', 'guide', 'info', 'refs', 'source', 'step'] THEN
    RETURN false;
  END IF;
  FOREACH item IN ARRAY ARRAY['source', 'refs', 'info', 'guide', 'step'] LOOP
    IF jsonb_typeof(value->item) <> 'string' OR (value->>item) !~ '^[0-9a-f]{64}$' THEN
      RETURN false;
    END IF;
  END LOOP;
  IF jsonb_typeof(value->'artifacts') <> 'object' THEN RETURN false; END IF;
  FOR item, artifact IN SELECT key, val FROM jsonb_each(value->'artifacts') AS a(key, val) LOOP
    IF jsonb_typeof(artifact) <> 'string' OR artifact #>> '{}' !~ '^[0-9a-f]{64}$' THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;
ALTER TABLE step_attempts ADD CONSTRAINT step_attempts_input_basis_check CHECK (
  input_basis IS NULL OR (jsonb_typeof(input_basis) = 'string' AND input_basis #>> '{}' ~ '^[0-9a-f]{64}$') OR editor_step_basis_valid(input_basis)
);

-- Templates are copied from docs-core at migration creation time. Existing owners normally
-- have a recipes row; settings and these templates cover pre-table runs. Sample bodies stay out.
WITH defaults AS (SELECT '{"tpl-1":{"name":"記事制作","guide":"## 記事の目的と読者\n取材や座談会で聞いた話をもとに、その場にいなかった読者へ出来事の要点と人の言葉を伝える。読み終えた人が、話の背景と次にできることを理解できる記事にする。\n\n## 構成\n本文 2,000〜3,000 字、見出し 4〜6 本。\n### タイトル\n内容の核心を 30 字前後で表す。固有名詞を 1 つ入れる。\n### 冒頭\n3 文以内で場面と主題を示し、何の話かを伝える。\n### 本編\n時系列ではなく論点ごとに見出しを立て、各見出しの中に当事者の言葉を 1 つ置く。\n### 結び\n読者が次にできること（問い合わせ先・次の機会など）を 1 段落で示す。\n\n## 書き方・文体・口調\n- 「です・ます」で書き、語りかけすぎない。\n- 発言はかぎかっこで短く引用し、地の文で補う。発言を要約した地の文に「〜と語った」を重ねない。\n- 1 段落は 3〜4 文。強調の太字は 1 記事に 2 か所まで。\n- 専門用語は初出で短く言い換え、読者が前提を知らなくても読めるようにする。\n\n## 表記\n- 数字は算用数字、年は西暦。\n- 人名は初出でフルネーム、以降は「〇〇さん」。団体名・地名は背景情報の表記に合わせる。\n\n## してはいけないこと\n- 文字起こしで確かめられない数字や事実を書かない。\n- 発言の趣旨を変える要約や、本人が言っていない言葉の引用をしない。\n- 宣伝の決まり文句で締めない。\n- 登場する人を評価する言葉（「素晴らしい」など）で地の文を飾らない。\n\n## 見直しのチェックリスト\n- 冒頭 3 文で何の話か分かるか\n- 各見出しに当事者の言葉があるか\n- 固有名詞が背景情報の表記と一致しているか\n- 数字と日付が文字起こしと一致しているか\n- 引用した発言が文字起こしの言葉と一致しているか","steps":[{"id":"k7m2q9xa","name":"文字起こし修正","instruction":"文字起こしの原文を、背景情報を踏まえて読みやすい日本語の文字起こし修正版に整える。出力は要約ではなく、後続の工程で全文を参照するための修正版。\n- 原文の発話順・話題の流れ・発言量をできるだけ保ち、要約・短縮・論点の統合・記事向けの再構成はしない。\n- 発言・具体例・数字・質問回答・脱線は、文意が完全に取れない箇所以外は省略しない。\n- 誤字脱字や明らかな聞き取り違いは補正する。意味を変える創作や、原文に無い情報の追加はしない。\n- 不明瞭で正確な文言が分からない箇所は、削らずに（※聞き取り不明瞭）または（おそらく〇〇）として残す。\n- 専門用語・固有名詞は、文脈と背景情報（表記・よみ・誤りやすい表記）から妥当な表記へ補正し、不確かなときは注記する。\n- 句読点・段落・改行を整える。段落の整理で内容を圧縮しない。\n- 話者ラベルがある文字起こしでは番号を保ち、背景情報の話者の対応表にある番号だけ名前に置き換える。対応表に無い番号を推測で名前にしない。話者ラベルが無い文字起こしでは、背景情報と文脈から発話を分けてラベルを付け、確信の持てない発話は「話者?:」にする。推定で付けた名前は最初の 1 回に「（推定）」を添える。\n- 年月日・金額・人数・時間などの漢数字は算用数字にする（「一つ」「二人」のような慣用の表記は残す）。\n- 大きなテーマが切り替わる箇所に ## 見出しを付ける。見出しは全文を読みやすくするための区切りで、本文の置き換えではない。\n- 「はい」「そうそう」などの相槌、「えー」「あの」などのフィラー、言い直しは省く。言い回し・語尾は残す。\n- 最後に誤字と表記の揺れを確かめる。","profile":"light"},{"id":"r4t8wz3c","name":"記事方針","instruction":"修正済みの文字起こしと背景情報をもとに、記事作成の方針を Markdown で整理する。\n- 核となるメッセージ、想定読者、主要テーマ、切り口、構成方針、文体、読者に期待する反応、避けたい表現を含める。\n- この段階では本文を書かず、後続の記事本文が迷わない編集方針に絞る。\n- 文字起こしにある具体的な事実・数字・固有名詞・印象的な発言を見落とさず、推測が強い点は断定しない。\n- 構成と文体は文書ガイドの決まりに沿わせ、ガイドと食い違う方針を立てない。","profile":"advanced"},{"id":"h2n6v5pe","name":"記事本文","instruction":"文字起こし修正と記事方針をもとに、公開を想定した記事本文を Markdown で書く。\n- 文書ガイドの構成・書き方・表記・してはいけないことに従う。タイトルは H1 にする。\n- 読者に伝わる具体性を重視し、過度な誇張は避ける。\n- 出典の無い内容を断定しない。発言の引用は短く、固有名詞は背景情報の表記に揃える。\n- 分量は文書ガイドの目安に合わせる（指定が無ければ 2,500 字前後）。\n- 書き終えたら、文書ガイドの見直しのチェックリストで確かめてから出す。","profile":"advanced"}]},"tpl-2":{"name":"議事録","guide":"## 文書の目的と読者\n欠席した運営メンバーが 2 分で状況を把握し、自分の宿題を見つけるための記録。\n\n## 構成\n議題ごとに ## 見出し。各議題は 決まったこと → 宿題 → 論点 の順。全体で 1,500 字前後。\n\n## 書き方・文体・口調\n- 体言止めと言い切り。敬語は使わない。\n- 1 行 1 件。箇条書きの中で改行しない。\n\n## 表記\n- 日付は 10/14 の形。担当は姓だけ。金額は円・税込で統一。\n\n## してはいけないこと\n- 発言者の意見を「決まったこと」に書かない。\n- 原文に無い期限を補わない。\n\n## 見直しのチェックリスト\n- 宿題に担当と期限があるか\n- 議題の数が議事録と会議で一致しているか","steps":[{"id":"d9c3x7mf","name":"議事録","instruction":"会議の文字起こしから議事録を Markdown で作る。議題ごとに ## 見出しを立て、その下に「決まったこと」「宿題」「論点」の ### を置く。\n- 発言者名は背景情報の話者の対応表に合わせ、対応表に無い番号を推測で名前にしない。\n- 文字起こし修正で「（推定）」や「話者?」の付いた発言は、担当者や決定の根拠にしない（担当は「未定」にする）。\n- 決まったことは結論だけを言い切りで書く。経緯は論点に回す。\n- 宿題は「内容・担当・期限」を 1 行に 1 件。担当や期限が発言に無ければ「未定」と書く。\n- 論点は結論が出なかった話と次回に持ち越した話。発言の要旨を短く残す。\n- 議題を落とさない。雑談と相槌は省く。数字・日付・固有名詞は原文どおりに残す。\n- 原文に無い決定や期限を補わない。","profile":"standard"},{"id":"w5q1j8ks","name":"共有用の要約","instruction":"議事録を 300 字以内の共有用の要約にする。\n- 決まったこと → 宿題（担当・期限） → 持ち越し の順に書く。\n- 1 件 1 文で言い切る。経緯や理由は書かない。\n- 固有名詞と日付は議事録のまま。新しい情報を足さない。","profile":"standard"}]},"tpl-3":{"name":"インサイト整理","guide":"","steps":[{"id":"u3e7z6rh","name":"インサイト","instruction":"インタビューの文字起こしから、背景にある動機や満たされていないニーズを 5 つまでのインサイトにまとめる。\n- 1 つのインサイトは ## 見出し＋2〜3 文の説明＋根拠の発言で書く。根拠は言い換えず、原文を 1〜2 文で短く引用する。話者名は背景情報に合わせる。\n- 発言の表面ではなく「なぜそう言うのか」を書く。\n- 根拠の無い推測は書かない。根拠が 1 件しか無いものは「仮説」と添える。\n- 全体を通して読み、前半に偏らない。聞き手の質問は根拠にしない。\n- 背景情報の「背景・目的」にある問い（何を知りたいか）に答える順に並べる。","profile":"advanced"}]},"tpl-4":{"name":"コーチング","guide":"## 文書の目的と読者\nコーチングのセッションを、本人とコーチがあとで振り返り、次のセッションの準備に使うための記録。\n\n## 構成\n分析は 5 つの見出し（要約・事前メモの問いへの答え・本人が決めたこと・変化と気づき・次回に向けて）。全体で 1,500〜2,500 字。\n\n## 書き方・文体・口調\n- 「です・ます」で書く。本人の言葉はかぎかっこで短く引用する。\n- 本人が話したことと、コーチの問いや提案を分けて書く。\n- 評価や励ましの言葉で地の文を飾らない。\n\n## 表記\n- 人名は背景情報の表記に合わせる。日付は 10/14 の形。\n\n## してはいけないこと\n- 本人が言っていない決意や気持ちを書かない。\n- 診断や、医療・法律・お金の判断をしない。\n\n## 見直しのチェックリスト\n- 事前メモの問いのすべてに、答えか「話に出なかった」があるか\n- 本人が決めたことが、本人の言葉に基づいているか","steps":[{"id":"c5v8n3qd","name":"文字起こし修正","instruction":"文字起こしの原文を、背景情報を踏まえて読みやすい日本語の文字起こし修正版に整える。出力は要約ではなく、後続の工程で全文を参照するための修正版。\n- 原文の発話順・話題の流れ・発言量をできるだけ保ち、要約・短縮・論点の統合・記事向けの再構成はしない。\n- 発言・具体例・数字・質問回答・脱線は、文意が完全に取れない箇所以外は省略しない。\n- 誤字脱字や明らかな聞き取り違いは補正する。意味を変える創作や、原文に無い情報の追加はしない。\n- 不明瞭で正確な文言が分からない箇所は、削らずに（※聞き取り不明瞭）または（おそらく〇〇）として残す。\n- 専門用語・固有名詞は、文脈と背景情報（表記・よみ・誤りやすい表記）から妥当な表記へ補正し、不確かなときは注記する。\n- 句読点・段落・改行を整える。段落の整理で内容を圧縮しない。\n- コーチの問いと本人の答えの対応が分かるように段落を分ける。\n- 話者ラベルがある文字起こしでは番号を保ち、背景情報の話者の対応表にある番号だけ名前に置き換える。対応表に無い番号を推測で名前にしない。話者ラベルが無い文字起こしでは、背景情報と文脈から発話を分けてラベルを付け、確信の持てない発話は「話者?:」にする。推定で付けた名前は最初の 1 回に「（推定）」を添える。\n- 年月日・金額・人数・時間などの漢数字は算用数字にする（「一つ」「二人」のような慣用の表記は残す）。\n- 大きなテーマが切り替わる箇所に ## 見出しを付ける。見出しは全文を読みやすくするための区切りで、本文の置き換えではない。\n- 「はい」「そうそう」などの相槌、「えー」「あの」などのフィラー、言い直しは省く。言い回し・語尾は残す。\n- 最後に誤字と表記の揺れを確かめる。","profile":"light"},{"id":"a3m9t6kw","name":"分析","instruction":"修正済みの文字起こしと参考ページ（事前メモ）をもとに、このセッションの分析を Markdown で書く。見出しは次の 5 つをこの順に ## で立てる。\n- 要約: セッションで話した主題と流れを 5 文以内で書く。\n- 事前メモの問いへの答え: 参考ページにある問い・話したいことを 1 つずつ ### で挙げ、本人の発言から答えを書く。話に出なかった問いは「話に出なかった」と書き、推測で埋めない。参考ページが無ければ、セッションの冒頭で本人が挙げた話題を問いとして扱う。\n- 本人が決めたこと: 本人が自分で決めた行動・方針を 1 行 1 件で書く（期限が話に出ていれば添える）。コーチの提案に本人が同意していないものは書かない。\n- 変化と気づき: 事前メモや前回の話と比べて変わった考え・新しく気づいたことを、根拠の発言（引用）と一緒に書く。\n- 次回に向けて: 次のセッションで確かめたいこと・続きを話したい問いを 3 つまで書く。\n- 本人の言葉は短く引用し、言い換えで意味を変えない。評価・診断・助言は書かない。\n- 事実の根拠は文字起こしにする。参考ページは事前の問いとして読み、そこに書かれたことを起きたこととして扱わない。","profile":"advanced"}]}}'::jsonb AS recipes),
source AS (
  SELECT sr.id AS run_id, sr.recipe,
         r.id AS stored_id, r.name AS stored_name, r.guide AS stored_guide,
         r.steps AS stored_steps, r.terms AS stored_terms, r.samples AS stored_samples, r.revision,
         saved.value AS saved, defaults.recipes -> sr.recipe AS builtin
    FROM step_runs sr
    LEFT JOIN recipes r ON r.owner = sr.owner AND r.id = sr.recipe
    LEFT JOIN editor_settings settings ON settings.owner = sr.owner
    LEFT JOIN LATERAL (
      SELECT value FROM jsonb_array_elements(COALESCE(settings.recipes, '[]'::jsonb)) value
       WHERE value->>'id' = sr.recipe LIMIT 1
    ) saved ON true
    CROSS JOIN defaults
), prepared AS (
  SELECT run_id, recipe, revision,
         COALESCE(stored_name, saved->>'name', builtin->>'name') AS name,
         COALESCE(stored_guide, saved->>'guide', builtin->>'guide', '') AS guide,
         COALESCE(stored_steps, saved->'steps', builtin->'steps') AS steps,
         COALESCE(stored_terms, '[]'::jsonb) AS terms,
         COALESCE(stored_samples, '[]'::jsonb) AS samples,
         builtin
    FROM source
), backfill AS (
  SELECT run_id, revision,
         CASE WHEN name IS NULL OR steps IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object(
                'id', recipe, 'name', name, 'guide', guide,
                'steps', (SELECT jsonb_agg(jsonb_build_object(
                  'id', item.step->>'id', 'name', item.step->>'name',
                  'instruction', item.step->>'instruction',
                  'profile', COALESCE(item.step->>'profile',
                    (SELECT def->>'profile' FROM jsonb_array_elements(COALESCE(builtin->'steps', '[]'::jsonb)) def
                      WHERE def->>'id' = item.step->>'id' LIMIT 1), 'standard')) ORDER BY item.ord)
                  FROM jsonb_array_elements(steps) WITH ORDINALITY AS item(step, ord)),
                'terms', terms, 'samples', samples)
         END AS snapshot
    FROM prepared
)
UPDATE step_runs sr SET recipe_snapshot = backfill.snapshot,
                        recipe_revision = COALESCE(backfill.revision, CASE WHEN backfill.snapshot <> '{}'::jsonb THEN 1 END)
  FROM backfill WHERE sr.id = backfill.run_id;

ALTER TABLE step_runs ALTER COLUMN recipe_snapshot SET NOT NULL;
ALTER TABLE step_runs ADD CONSTRAINT step_runs_recipe_revision_check CHECK (recipe_revision IS NULL OR recipe_revision > 0);

COMMIT;
