# P03 写真転送 core

Issue #152 の transfer core と薄い Next route。P00 の wire contract と P02 の容量予約・lease・generation 台帳を使う、依存注入式のサーバー処理。**本番の decoder、ticket broker、停止後 reconciler と P13 capability wiring の接続完了ではない。#152 は閉じない。**

`createPhotoTransferRoutes(deps)` は要求ごとに P01 の本物の `verifyPhotoActor` で NIHO browser session / Mac bearer を検証し、その後だけ `createPhotoTransferApi(deps)` を呼ぶ。owner は検証済み `VerifiedPhotoActor.userId` のみ。メール、リクエスト本文、query、owner header、未検証 JWT から actor を作る経路はない。既定の認証成功や、production の fake 選択はない。

## HTTP route と既定 runtime

Next の Node.js route を P00 通り `/api/photo/v1` 配下に置く。

- `POST /uploads`、`GET /uploads/{uploadId}`
- `POST /uploads/{uploadId}/renew`、`POST /uploads/{uploadId}/complete`、`POST /uploads/{uploadId}/cancel`
- `GET /photos/{photoId}/content/{assetId}`、`GET /photos/{photoId}/masks/{surfaceId}`

`runtime.ts` は実認証を接続済みだが、transfer capability resolver は常に `null`。認証できた要求も generic `503 temporarily_unavailable` / private/no-store で閉じ、DB・storage を呼ばない。認証失敗は P00 の共通 error envelope に写し、本人確認の内部詳細は公開しない。この状態で route は配備できるが、転送の本番利用はできない。有効化する環境変数はない。

`p02.ts` の `createP02PhotoMutationJournal(db)` は `bindPhotoRequest` の永続・原子的 binding に接続する。`createP02PhotoTransferStore(db)` は `getPhotoSnapshot` / `getPhotoUploadByStartKey` / `getPhotoMaskBySurfaceId` などの owner 指定 API に接続し、最新 recipe/media の locator-free Photo を投影する。job未作成のnull mediaはP00の`pending`へ投影し、originalがretainedの原本であることを確認する。投影関数は P04 の adapter 合流後に共通化できるよう、このファイル内に限定する。DB・migration は変更しない。これらの adapter が存在すること自体は production capability の接続を意味しない。

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
| P13 | 接続済みの P01 request 認証、薄い route、P02 永続 journal / owner 指定投影に、以下の実 capability を統合する。正規 origin は設定で渡し、Host/forwarded header から推測しない |
| P06/P13 | 全ファイルを実 decoder で検証する `PhotoProbe`。不正/truncated 画像、PNG CRC/IDAT/終端、形式偽装、decompression bomb を拒否し、allocation 前の寸法制限と向き適用を守る。accepted HEIC/RAW 等の capability は実 provider の受入後にだけ有効化する |
| P13 | `PhotoTicketBroker` の issue/renew/progress。private upstream session をサーバー内だけに置き、公開 capability を毎回新規発行し、各 PUT で最大15分の期限・サイズ・種類・staging限定を実強制する。resume は GCS が返す offset を使う。GCS へ redirect しない |
| P07/P13 | 停止・copy 結果不明・遅着 PUT の reconciler。upload ID から staging key を再導出し、unique final prefix の実 generation を発見して P02 台帳へ入れ、P07 が破壊処理を行う |

P02 の `photo_mutations` は trash/restore/purge 専用であり、complete/cancel には転用しない。start/complete/cancel は `photo_request_journal` を使い、owner + operation + resource + key で分離し、hash 不一致を `idempotency_conflict` にする。全ての必須 capability が受入されるまで既定 runtime の transfer を接続しない。

GCS resumable session URI 自体は最長約1週間使えるため、`expiresAt` だけ15分に書き換えて返してはいけない。GCS 実装は broker を必須にし、raw session URI を公開 ticket として返す実装を拒否する。broker 内の資格情報はログ・DB・クライアントの永続領域へ出さない。

GCS の copy path と source/destination precondition は [Objects: copy の公式 API](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/copy) に従う。実 GCS の受入は P13 に残る。

検証中の一時失敗では staging generation を GC 対象にしない。content reject は現在の lease で reject/fence できた後にだけ stage を台帳化する。copy 後の DB 応答が曖昧な場合も、P02 の live-asset 検査が保存済み generation の誤回収を防ぐ。プロセス停止を跨ぐ完全な回収は上記 reconciler の接続が必要。

## 対象限定検証

```sh
npm -C apps/editor-web run test -- src/server/photo-transfer/api.test.ts src/server/photo-transfer/routes.test.ts src/server/photo-transfer/p02.test.ts src/server/photo-auth/photo-auth.test.ts src/storage/photo-gcs.test.ts
npm -C apps/editor-web run typecheck
```

route テストは実 `verifyPhotoActor` と transfer core を通し、NIHO verifier 応答・DB・probe・storage は合成 fixture。7本の実 route の既定503、認証失敗前の依存未呼び出し、browser/Mac owner 境界、P02 adapter の委譲と locator 除外を検証する。本物の NIHO・DB・decoder・GCS の受入証跡に数えない。依存 manifest、認証実装、既存 ObjectStorage、P02 writer ファイル、migration、共有 CI は変更しない。
