# P03 写真転送 core

Issue #152 の最初の実装単位。P00 の wire contract と P02 の容量予約・lease・generation 台帳を使う、依存注入式のサーバー処理。**本番 route、認証 runtime、decoder、ticket broker の接続完了ではない。#152 は閉じない。**

`createPhotoTransferApi(deps)` の各呼び出しに、サーバーで検証済みの `VerifiedPhotoActor` を渡す。`Session`、メール、リクエスト本文、未検証 JWT から actor を作る経路はない。既定の認証成功や、production の fake 選択はない。

実装済みの処理:

- start/get/renew/complete/cancel、content の generation 固定ストリーム、mask の非公開 metadata lookup。
- mutation の Origin 照合、閉じた JSON schema、64KiB 上限、canonical hash、公開エラーと private/no-store ヘッダー。
- 予約後の ticket 発行、新規 ticket 発行失敗時の予約取消、現在の状態を読む replay、storage 確認済み offset。
- lease 取得、staging generation の固定、全 byte の SHA-256、0600 の非公開一時ファイルへの定量メモリ spool、decoder 呼び出し、magic/寸法/pixel/gray8 mask 検査。
- unique final key への create-only copy、検証結果だけの P02 commit、既知の余剰 generation の GC 台帳登録。削除処理は持たない。
- GCS の generation 指定 stat/read/copy、source/destination 条件、redirect 拒否、request/stream timeout、consumer cancel と abort の伝播。

`masks.get` は P00 `PhotoOperationMap` に従い `PhotoAsset` JSON を返す。面の bytes はその asset ID で `content.get` を呼ぶ。locators や署名付き GET URL は返さない。

## 接続前に必要なもの

| 担当境界 | 必須の接続 |
| --- | --- |
| P01/P13 | request ごとに本人・用途・失効を検証する本物の actor resolver と、薄い Next route。正規 origin は設定で渡し、Host/forwarded header から推測しない |
| P02/P13 | `PhotoMutationJournal.bind` の永続で原子的な key/hash binding。owner + operation + resource + key で分離し、hash 不一致を `idempotency_conflict` にする。応答キャッシュだけでは満たさない |
| P02/P04/P05/P06 | 完全な最新 `Photo` の owner 指定投影、owner/photo/digest で絞る mask lookup、owner/operation/start key で絞る upload lookup。`createP02PhotoTransferStore` はこれらを必須引数として残す |
| P06/P13 | 全ファイルを実 decoder で検証する `PhotoProbe`。不正/truncated 画像、PNG CRC/IDAT/終端、形式偽装、decompression bomb を拒否し、allocation 前の寸法制限と向き適用を守る。accepted HEIC/RAW 等の capability は実 provider の受入後にだけ有効化する |
| P13 | `PhotoTicketBroker` の issue/renew/progress。private upstream session をサーバー内だけに置き、公開 capability を毎回新規発行し、各 PUT で最大15分の期限・サイズ・種類・staging限定を実強制する。resume は GCS が返す offset を使う。GCS へ redirect しない |
| P07/P13 | 停止・copy 結果不明・遅着 PUT の reconciler。upload ID から staging key を再導出し、unique final prefix の実 generation を発見して P02 台帳へ入れ、P07 が破壊処理を行う |

P02 の現行 `photo_mutations` は trash/restore/purge 専用であり、complete/cancel の journal に転用しない。全ての必須 port が実装されるまで route を公開しない。

GCS resumable session URI 自体は最長約1週間使えるため、`expiresAt` だけ15分に書き換えて返してはいけない。GCS 実装は broker を必須にし、raw session URI を公開 ticket として返す実装を拒否する。broker 内の資格情報はログ・DB・クライアントの永続領域へ出さない。

GCS の copy path と source/destination precondition は [Objects: copy の公式 API](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/copy) に従う。実 GCS の受入は P13 に残る。

検証中の一時失敗では staging generation を GC 対象にしない。content reject は現在の lease で reject/fence できた後にだけ stage を台帳化する。copy 後の DB 応答が曖昧な場合も、P02 の live-asset 検査が保存済み generation の誤回収を防ぐ。プロセス停止を跨ぐ完全な回収は上記 reconciler の接続が必要。

## 対象限定検証

```sh
npm -C apps/editor-web run test -- src/server/photo-transfer/api.test.ts src/storage/photo-gcs.test.ts
npm -C apps/editor-web run typecheck
```

テストの actor、journal、probe、storage は合成の port fixture。本物の認証・decoder・GCS の受入証跡に数えない。依存 manifest、認証、既存 ObjectStorage、P02 ファイル、migration、共有 CI は変更しない。
