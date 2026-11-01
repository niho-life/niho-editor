# Photo conformance P12

P00 の `security-cases.json` 34件を、P03 transfer handler core、P04 catalog route、P05 recipe route、P07 lifecycle route、P02 PostgreSQL writerとmedia workerの現在の接続範囲で独立検証する。`registry.ts` は34件を必ず一度だけ分類し、`partial` と `blocked` を合格として扱わない。現在の集計は `db-handler` 22件、`handler-precondition` 3件、`partial` 9件、`blocked` 0件である。

## この試験が証明する範囲

- 合成 actor を handler に注入し、owner が request body から採用されないこと
- 専用 random schema 上の PostgreSQL writer を handler 経由で動かした owner scope、quota直列化、idempotency、complete/cancel/expiry/lifecycle fence
- generation を持つ合成 storage port に対し、DBに保存した immutable generation で content read すること
- 合成バイト列を全量hashし、test-only probe の結果とmagic、サイズ、format、pixel上限を照合すること
- P04の本番route factoryとDB adapterで、写真詳細・hash lookup・cursorのowner境界とcreation watermarkを保つこと（能力と認証portは合成fixture）
- P07の本番route factoryとDB adapterで、browser/Mac Origin境界、trash/restoreのquota保持とidempotency、purge 202後のpending bytes保持、purge後のrestore拒否、jobのowner境界を保つこと
- P05の本番route factoryとDB adapterで、recipe CASを直列化し、勝者だけをrecipe・receipt・media outboxへcommitすること。同一payloadのreplayと同一keyの変更payload拒否も含む
- recipe CASと`missing-mask`では、固定SDK0.1.6のNode reader/editability判定とcrate0.27.0の実WASM `validateSettings`をtest-only portへ接続する。manifest/source/WASM hashとruntime版を照合し、別ownerに実在するmaskをP02 writerがcommitしないことを確認する。範囲外の露光量と壊れたmaskも422となり、recipe/receipt/outboxが変わらない
- `unknown-recipe` ではP00のv10/future engine/future fieldを専用schemaのnewer-writer fixtureとして配置し、P04がopaque JSONを保持して読むことと、SDK 0.1.6/P00 capabilities外のversion/engineをP05 capability guardがvalidatorより先に422で拒否してrecipe/outboxを変えないこと
- `stored-media-failed` ではP03 upload、P02 enqueue/adapter、本番media executor、P04 route/storeを接続し、合成providerが明示的に返す`decoder_failed`をcurrent jobへ記録した後もoriginal bytes・quota・owner境界を保つこと
- `stale-preview` ではP02の古いclaim generationと合成storage上のcandidateを保持し、P05 recipe CAS後の本番P02 publishを拒否してP04 snapshotが古いpreviewをcurrentにしないこと

DBはlocalでは専用の loopback `56542` だけを許可する。`CI=true` では使い捨てfixtureの loopback `5432`、user `editor_ci`、database `editor_ci` の組み合わせだけを許可し、外部hostや別DBを拒否する。suiteごとに random schemaを作り、migration適用後、終了時にそのschemaだけを `CASCADE` で削除してpoolを閉じる。setup途中の失敗でも作成済みschemaを削除する。動的値はschema名以外すべてSQL parameterで渡す。CIで `TEST_DATABASE_URL` が無ければ失敗し、localで無ければDB integration suiteだけをskipする。

P02の本番用snapshot、mask/start-key lookup、永続request journal、recipe CAS/outbox、media job/candidate/lease fence、lifecycle mutation/purge ledgerと、P04/P05/P07の本番用wire変換を接続する。job作成前は実装どおり `media.pending` を返し、job IDを補わない。purge 202はobject delete完了ではなく、未確認assetの `usedBytes` と `pendingPurgeBytes` が保持される境界だけを `partial` として記録する。

## 証明しない範囲

- 実Cookie／bearerの検証・失効、実認証provider（route factoryには合成actorを注入する）
- 実decoderが画像全体を安全にdecodeできること。probe fixture、合成`decoder_failed` provider、opaque derivative bytesはいずれもdecoderの代用品ではない
- 実GCSの署名URL、resumable upload、generation precondition、IAM、provider error
- catalog/recipe/lifecycleの実NIHO認証runtime、本番用SDK recipe validatorの全書込能力ゲート、実media provider/storage、実purge worker/object delete provider
- 未接続の`media.ensure` HTTP route。`stale-preview`のP00期待409と`stored-media-failed`の`retry_media_only`は偽装せず、両caseを`partial`に保つ
- ブラウザ／Mac実機、実画像、性能、ネットワーク障害時の受入

`missing-mask` では実SDKでknown maskの形を検証した後、P02 writerのowner不一致・不存在に対し、P00期待どおりstatus 422と`missing_mask_surface`、recipe/revision/outbox不変を確認する。本番用validator接続は未完のため、このcase全体は`partial`のままにする。`unknown-recipe`はcapability guardだけで具体的なP00期待を満たすため`db-handler`とするが、合成validatorが呼ばれないことを確認し、SDK validator全体の受入完了とは扱わない。

このtest-only portを本番へ転用しない。SDK0.1.6では、known versionのneutral settingsへ未知の合成fieldを追加してもWASMが`[]`、Nodeのeditability判定が`true`を返すことを独立計測した。未知JSONの保全と、未知の描画featureを書き込めることは別である。P13はP00どおり未知featureのread-onlyとwork base/meta互換性を確認できる書込ゲートを接続するまで、production recipe runtimeを閉じたままにする。

合成fixtureだけを使い、実URL、cookie、token、provider error本文は出力しない。
