# Photo conformance P12

P00 の `security-cases.json` 34件を、P03 transfer handler core と P02 PostgreSQL writer の現在の接続範囲で独立検証する。`registry.ts` は34件を必ず一度だけ分類し、`partial` と `blocked` を合格として扱わない。現在の集計は `db-handler` 13件、`handler-precondition` 3件、`partial` 6件、`blocked` 12件である。

## この試験が証明する範囲

- 合成 actor を handler に注入し、owner が request body から採用されないこと
- 専用 random schema 上の PostgreSQL writer を handler 経由で動かした owner scope、quota直列化、idempotency、complete/cancel/expiry/lifecycle fence
- generation を持つ合成 storage port に対し、DBに保存した immutable generation で content read すること
- 合成バイト列を全量hashし、test-only probe の結果とmagic、サイズ、format、pixel上限を照合すること

DBはlocalでは専用の loopback `56542` だけを許可する。`CI=true` では使い捨てfixtureの loopback `5432`、user `editor_ci`、database `editor_ci` の組み合わせだけを許可し、外部hostや別DBを拒否する。suiteごとに random schemaを作り、migration適用後、終了時にそのschemaだけを `CASCADE` で削除してpoolを閉じる。setup途中の失敗でも作成済みschemaを削除する。動的値はschema名以外すべてSQL parameterで渡す。CIで `TEST_DATABASE_URL` が無ければ失敗し、localで無ければDB integration suiteだけをskipする。

P02に公開projectionがまだ無いため、stored resultに必要な `Photo` は owner-scoped `getPhoto` と owner/photoで絞ったrecipe行から組み立てるtest-only shimを使う。mediaの `queued` 値はwire shapeを満たすための合成値であり、media workerの証拠ではない。

## 証明しない範囲

- 実Cookie／bearerの検証・失効、実 route wiring、実認証provider
- 実decoderが画像全体を安全にdecodeできること。probe fixtureはdecoderの代用品ではない
- 実GCSの署名URL、resumable upload、generation precondition、IAM、provider error
- catalog/recipe/media/lifecycle/jobの未接続portとroute、実purge worker
- ブラウザ／Mac実機、実画像、性能、ネットワーク障害時の受入

合成fixtureだけを使い、実URL、cookie、token、provider error本文は出力しない。
