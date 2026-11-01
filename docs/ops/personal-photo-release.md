# 個人写真ライブラリの統合と配布

対象は #161（P12独立検証）と #162（P13統合・配布）。同じNIHO本人のiPhoneとMacで原本・編集を共有する。自前サーバー、他ユーザーへの招待、既存拠点写真の移管は含めない。

## 証跡を分ける

| 検証 | 証明する範囲 | 追加で必要な受入 |
| --- | --- | --- |
| P00の34ケース | 契約と期待する拒否・不変条件 | 実handler・DB・providerとの接続 |
| P12のhandler＋PostgreSQL試験 | 合成本人・専用schemaでのowner境界、容量予約、再送、取消とlate commit | 実認証、実route、実storage・decoder |
| photo-media-worker CI | 合成providerでのlease、source identity、publish fence、清掃のorchestration | HEIC/RAWを含む実decode・固定engine・実storage |
| Photo SDKの型・bundle検証 | 固定SDKの依存・exports・Worker/WASM/CSS互換 | 実ブラウザ・署名済みMacでの往復 |
| 候補環境の外形確認 | 対象source hash、未認証401、対象外保存APIの拒否 | 実NIHO本人による接続・失効・別端末併存 |

`apps/editor-web/src/server/photo-conformance/registry.ts` は34ケースの対応表であり、未完ケースを合格へ置き換えるものではない。実DB試験もsynthetic storage/probeを使う範囲を明示する。公開CIへ実画像、本人情報、URL/ticket、cookie、secretを渡さない。

## 配備する組を固定する

非公開の受入台帳へ、次をimmutableな値で保存する。公開台帳にはsource SHA・版・合成試験結果だけを戻す。

- public/privateのsource SHA、各required CIのrunと対象head
- P00契約版、NIHO本人接続契約、SDK公式manifest・tarballのhash、engine/renderer manifestのhash
- migration集合と適用記録、worker/API/Web/PWA/Macの互換なimage・artifact
- 本人認証、原本保存先のIAM/lifecycle/backup、容量回復・退会purgeの実設定のreadback
- 実端末の対象OS/アプリ版、現行Mac署名方式・updater署名・配布結果

SDKの既存release assetを上書きしない。公式release workflowをmain由来のexact source SHAで実行し、公式manifest・attestation・hashを検証してからhostの依存を更新する。公開candidateは検証用であり、updater署名付きの利用者配布物には数えない。Macは現行の正式配布手順に従い、ad-hoc署名の検証とupdater署名・実更新を確認する。

## 段階配備

1. #150の実NIHO受入を先に通す。候補origin/callbackは非公開設定へexactに登録する。TLS検証が成功し、callback queryが実際の保存先へ残らないことを合成queryとhealthのpositive controlで確認してから実codeを流す。
2. 対象DBのbackup/復旧入口、migrationのexpand互換、appとmigrateの権限分離を確認する。写真用のmigrationを適用し、容量・owner・孤児検査を合成データで確認する。
3. P02 writer、P03/P04/P05の実route、実storage/decoder、media/purge/reconciler workerを互換な組で候補へ配備する。必須providerが欠けた組で写真の利用可能表示を出さない。
4. 固定SDKを取り込んだWeb/PWAとMacを候補APIへ接続する。既存DocsのGoogle認証・所有者IDの移行を写真配備へ混ぜない。無料のMacローカル編集を維持する。
5. P12の未完項目と下記の実機シナリオを実行する。CI成功・workflow dispatch・image作成だけを配備済みとは記録せず、稼働source/imageと認証済みsmokeを読み戻す。
6. 現行の正式配布手順でad-hoc署名を検証したMacと、updater署名付きの公式更新経路とPWA更新を受入した後、本人クラウドの入口を有効にする。鍵の投入は[AGENTS.md](../../AGENTS.md)のオーナー専用手順に従い、値を取り出して証跡へ貼らない。

実プロジェクト、origin、保存先、実行ID、資格情報、接続URLは公開repoへ置かない。配備は既存の[公式手順](editor-deploy.md)と非公開側の対応runbookを使い、対象serviceとexact sourceを照合する。

### P02 workerのGCS能力を分離する

`apps/editor-web/src/storage/photo-gcs-worker.ts` のfactoryは、P02 media worker用のgeneration固定read/create-only能力と、purge worker用のexact-generation delete-only能力を別々に返す。public routeやstorage modeの既定値には接続せず、候補環境でbucket・実行ID・IAMを照合したproduction compositionだけが明示的に構築する。media実行IDへdelete権限、purge実行IDへobject作成権限を持たせない。

purgeは`DELETE`の204/404だけでは台帳を確定しない。同じkey・generationについてlive metadataと`softDeleted=true` metadataがともに404であることを確認してから容量を返す。soft delete、retention、権限不足、timeout、曖昧なprovider応答が残る間はjobをretry対象のままにする。このadapterの導入を、bucketのretention/soft-delete policyやIAMを変更する許可、実GCS・本番認証・decoderの受入完了とは扱わない。

HTTP条件は[Objects: insert](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/insert)、[Objects: delete](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/delete)、[Objects: get](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/get)に従う。soft-deleted objectの不存在確認が使えない保存先では、安全側に停止し、削除完了や容量回復を返さない。

## 実機の必須シナリオ

- 拠点権限のない同じNIHO本人でMac・Safari・ホーム画面PWAへ接続し、独立sessionが併存する。
- JPEG/PNG/HEIC系と対応RAW原本を明示操作でコピーし、検証確定後に他端末で開く。原本のhashと版付き作業コピーを確認する。
- iPhone→Mac、Mac→iPhoneの補正・履歴を読み戻し、二端末の同時保存で競合を回復する。
- 5GiB直前の並行転送、切断・再開・suspend、予約切れ、worker停止、rendererの切戻しを通す。
- 別ユーザーへの切替、logout、取消、退会後に古い応答・outbox・cache・ticket・jobで写真が復活しない。
- ゴミ箱・復元・完全削除・purge途中失敗を通し、実objectの削除確定前に容量を返さない。
- 無料ローカル編集、既存Docs保存/公開/PWA、既存拠点写真を回帰確認する。

## 切り戻し

入口を閉じ、新規転送と新規job受付を止め、互換な直前のAPI/worker/Web/Macの固定組へ戻す。原本・編集履歴とexpandした表は保持する。表drop、バケット削除、lifecycleの一括短縮、ownerの書換えをrollbackに使わない。

処理中のleaseはgenerationとsource identityでfenceする。rendererをA→B→Aと戻した場合も、supersededな旧jobを新しいclaimとして再queueし、旧claimのpublishを拒否できることを確認する。削除/GCはgeneration付きの永続台帳とlive asset照合を経て再開する。

未解決の認可・原本保全・容量・削除の欠陥がある間は有効化しない。#161と#162は、必要な実設定・実端末・正式更新の証跡が揃うまでopenを維持する。

## Web hostの固定SDK runtime

`apps/editor-web` は `packages/photo-library-contract/sdk-baseline.json` に固定したPhoto SDKをexact release URLで取得する。`npm install` は `--ignore-scripts --no-audit --no-fund` を付け、baselineに記録したSHA-256 SRIとlockのintegrityが一致することを維持する。`@niho/photo-cloud-library` と `@niho/photo-library-contract` はmonorepo内の `file:` 依存を使う。

`npm run build` のprebuildは `scripts/stage-photo-sdk-runtime.mjs` を実行する。scriptはhostのpackage/lockのexact URL・版・SHA-256 SRIをbaselineと照合し、SDKの重複installationも拒否する。続いてインストール済み `niho-photo-develop-engine-runtime` のmanifest、全single-thread/thread runtime file、source commit、engine/crate版をbaselineと照合し、次のimmutable namespaceへ配置する。

```text
/photo-runtime/<releaseTag>/<release-manifest-sha256>/develop-engine/<engineVersion>/manifest-<crateVersion>.json
```

配置先が同一bytesなら再実行できるが、異なるbytesは上書きしない。別releaseのnamespaceも削除しない。WASM/Rustを再buildせず、networkからruntimeを追加取得しない。生成される `apps/editor-web/public/photo-runtime/` はGit管理外であり、Docker/standaloneへprebuild成果物をコピーする。

`src/photo-sdk/runtime-assets.ts` は固定runtimeのdescriptorを提供する。公式declarationsを含む0.1.6のimmutable Releaseを検証し、P00 baseline・P08 package・host lockへ固定採用済みである。`src/photo-sdk/host-sdk.ts` は編集UI、provider、単一dialog hostのclient exportをまとめ、hostのstrict/noUncheckedIndexedAccessを弱めずNext/React 19の型検査とbuildを通した。これらのexportだけでは認証、API、provider、写真UI、PWA、token、実配備を有効化しない。

P12はSDK0.1.6のNode契約とcrate0.27.0の実WASM validatorをtest-only portからP05 route/P02 DBへつないでいる。本番用validatorは、known settingsの妥当性に加え、未知の描画featureのread-only、work base/meta、maskの本人・写真・世代・寸法を含む書込能力を受け入れてから接続する。WASMの`validateSettings`が`[]`を返すことだけでは未知fieldの書込許可を判断できない。conformanceのportをそのままproductionへ採用しない。
