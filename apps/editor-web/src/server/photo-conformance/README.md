# Photo conformance P12

P00 の `security-cases.json` 34件を、P03 transfer handler core、P04 catalog route、P05 recipe route、P07 lifecycle routeとP02 PostgreSQL writerの現在の接続範囲で独立検証する。`registry.ts` は34件を必ず一度だけ分類し、`partial` と `blocked` を合格として扱わない。現在の集計は `db-handler` 21件、`handler-precondition` 3件、`partial` 7件、`blocked` 3件である。

## この試験が証明する範囲

- 合成 actor を handler に注入し、owner が request body から採用されないこと
- 専用 random schema 上の PostgreSQL writer を handler 経由で動かした owner scope、quota直列化、idempotency、complete/cancel/expiry/lifecycle fence
- generation を持つ合成 storage port に対し、DBに保存した immutable generation で content read すること
- 合成バイト列を全量hashし、test-only probe の結果とmagic、サイズ、format、pixel上限を照合すること
- P04の本番route factoryとDB adapterで、写真詳細・hash lookup・cursorのowner境界とcreation watermarkを保つこと（能力と認証portは合成fixture）
- P07の本番route factoryとDB adapterで、browser/Mac Origin境界、trash/restoreのquota保持とidempotency、purge 202後のpending bytes保持、purge後のrestore拒否、jobのowner境界を保つこと
- P05の本番route factoryとDB adapterで、recipe CASを直列化し、勝者だけをrecipe・receipt・media outboxへcommitすること。同一payloadのreplayと同一keyの変更payload拒否も含む
- `missing-mask` では合成validatorをmask surface ID抽出portとしてだけ使い、別ownerに実在するmaskをP02 writerがcommitしないこと。これはaccepted SDK validatorの証拠ではない

DBはlocalでは専用の loopback `56542` だけを許可する。`CI=true` では使い捨てfixtureの loopback `5432`、user `editor_ci`、database `editor_ci` の組み合わせだけを許可し、外部hostや別DBを拒否する。suiteごとに random schemaを作り、migration適用後、終了時にそのschemaだけを `CASCADE` で削除してpoolを閉じる。setup途中の失敗でも作成済みschemaを削除する。動的値はschema名以外すべてSQL parameterで渡す。CIで `TEST_DATABASE_URL` が無ければ失敗し、localで無ければDB integration suiteだけをskipする。

P02の本番用snapshot、mask/start-key lookup、永続request journal、recipe CAS/outbox、lifecycle mutation/purge ledgerと、P04/P05/P07の本番用wire変換を接続する。job作成前は実装どおり `media.pending` を返し、job IDを補わない。media workerの受入は別途必要。purge 202はobject delete完了ではなく、未確認assetの `usedBytes` と `pendingPurgeBytes` が保持される境界だけを `partial` として記録する。

## 証明しない範囲

- 実Cookie／bearerの検証・失効、実認証provider（route factoryには合成actorを注入する）
- 実decoderが画像全体を安全にdecodeできること。probe fixtureはdecoderの代用品ではない
- 実GCSの署名URL、resumable upload、generation precondition、IAM、provider error
- catalog/recipe/lifecycleの実NIHO認証runtime、accepted SDK recipe validator、media worker、実purge worker/object delete provider
- ブラウザ／Mac実機、実画像、性能、ネットワーク障害時の受入

`missing-mask` ではP02 writerのowner不一致・不存在に対し、P00期待どおりstatus 422と`missing_mask_surface`、recipe/revision/outbox不変を確認する。accepted SDK validatorが未接続のため、このcase全体は`partial`のままにする。`unknown-recipe`も同じvalidatorが未接続のため`blocked`を維持する。

合成fixtureだけを使い、実URL、cookie、token、provider error本文は出力しない。
