# 写真media workerの独立コア（P06 / #155）

P00の固定値と本人写真contractを使う、依存注入式の実行コア。`src/p02.ts`がP02のPostgreSQL writerへ接続する。object storageの実backend、decoder、SDK runtime loader、常設server、資格情報は含まない。このpackageだけで写真クラウドを有効にしない。

```sh
npm -C packages/editor-store ci
npm -C workers/photo-media ci
npm -C workers/photo-media run check
```

`src/identity.ts` はowner/photo、原本asset/hash/generation、lifecycle世代、recipe revision/settings hash、canonical base、renderer manifestと出力上限をP02と同じcanonical identity objectのSHA-256に固定する。同じキーへのenqueue収束と永続状態はP02が実装する。

`src/run.ts` は同時実行を1件、1回60秒以下、最大3 attemptに制限する。実行開始時と派生物stage前に現在値を読み、最後はP02の原子的publish CASへ全identityとlease世代を渡す。古い結果はpublishできず、まだ同じclaimならsupersededへterminal CASする。旧claimの失敗・supersedeが新claimを変更しないことをstore portに要求する。外部の一時障害とdecoderが確認した画像の失敗を区別し、未知例外は`infrastructure_unavailable`で上限付きretryへ送る。

`MediaAttemptFailure`・`RunResult`・supersededはworker内部のattempt/lease状態だけに使う。`infrastructure_unavailable`、`timeout`、`cancelled`、`original_changed`、`invalid_output`を写真APIのmedia失敗codeへ保存・返却しない。公開`MediaState.failed.code`はP00の`decoder_failed` / `renderer_unavailable` / `unsupported_settings`のまま。P02 adapterはprocess停止のretryを`infrastructure_unavailable`へ写像し、decoder確認済み失敗はterminalにする。公開codeの射影はP02が担う。

通常のAbortSignalはtask/processの停止として扱い、同じactive identityでattemptが残る場合は上限付きbackoffで再試行する。P00に公開のmedia job取消操作はない。P02/P07がlifecycleやjobをfenceした場合は失敗CASを何も変更しない処理にする。

原本は世代指定のstreamから私有の一時directoryへ最大256MiBだけ書き、実size/SHA-256を再検査する。派生物はthumbnail、preview、working-copyを別assetとして生成し、出力寸法・サイズ・hash、scratch内の通常ファイル、sRGB/向き/不要metadata除去、canonical working-copyとの互換を検査してからcreate-only stageへ渡す。原本hash不一致や古いrecipeでは原本・写真行を変更しない。退出経路で一時directoryを消す。

`createP02MediaJobs(db, owner)`は信頼済みschedulerが固定したownerだけを扱い、claim/current/publish/fail/supersedeをP02へ渡す。`createP02MediaObjects(db, owner, storage)`は本人/photo/原本generationを再照合し、P02 candidateをallocateしてから`MediaObjectStorage.create(..., ifGenerationMatch: 0)`を呼ぶ。createは指定keyだけへ書き、成功応答はgenerationと実size/contentTypeだけを返す。台帳と再readのkeyはallocate済みkeyに固定し、backend応答のlocatorを受け取らない。送信した全bytesと、返った世代を再readした全bytesのsize/SHA-256を検査する。generationが分かればmetadata不一致やabortでも先に台帳へ登録し、失敗時と`abandon`は台帳だけをabandonedへ進める。応答喪失時はobject keyとnull generationを残し、実backendの後続照合へ渡す。物理削除はしない。

実接続時に以下の境界を満たす。

- **P02接続済み**: `MediaJobs`のclaim/publish/fail/supersedeはP02のDB transactionを使う。publishはlease期限・実行deadline・claim世代・owner・active lifecycle・原本generation/hash・base・recipe revision/hashを同時照合し、派生物参照とlibrary revisionを一度だけ確定する。実運用のDB query timeoutとprocess停止後のlease回収はP13のscheduler配備でも設定する。
- **P03/P07残件**: `MediaObjectStorage`に実backendを接続し、通信結果不明・process停止・遅着書込のgeneration照合と清掃executorを受け入れる。publish応答の喪失時はDBへ確定済みの場合があるため、物理削除前に必ずpublish状態と参照を再照合し、参照済み派生物を消さない。P02台帳の接続試験だけで、実storageの中断・遅着書込の回収を合格扱いしない。
- **P06 decoder bridge**: 実release bytesを`verifyPinnedArtifact`で検査してSDKをロードする。providerのrenderer自己申告だけをartifact検証の代用にしない。`supports`は固定SDKで設定全体・canonical hash・base・mask/featureを検証する。decode前にpixel上限をprobeし、別processのCPU/メモリ/一時領域を制限し、abortでprocessを終了する。`inspect`は実decoderで出力を調べる。JPEG/PNG、LinuxのHEIC/HEIF bridge、検証済みRW2と色/向きの実decode証跡はまだない。
- **P03/P06のbase選択**: RAW等のworking-copyが必須な入力は、serverが選んだcanonical baseVersionをjob作成前に固定して`MediaSource.baseVersion`へ渡す。既存recipeにbaseがある場合は一致が必須。base未確定のまま任意のworking-copyを成功扱いしない。このmappingは実store/decoder接続で確定する。
- **P01/P13**: 認証済みactor、rate/queue上限、workerの実行ID、公式配備、起動時の停止済みprocessのscratch清掃、メモリ予算を接続する。100MP入力の予算が未確定のため並行数2以上は拒否する。owner以外へ内部identity・locator・失敗本文を返さない。

テストはP00の合成ID/recipeとメモリ上の合成PNGを使うorchestrationの単体試験と、`TEST_DATABASE_URL`指定時の**P02 PostgreSQL adapter統合試験**である。CIは使い捨てPostgreSQLでadapter試験を必須実行する。fake provider/storageは実decode・実storageを行わず、HEIC/RAW対応・画素・色・実SDKの合格を表さない。実providerを登録するfactoryや、ingest/workingCopyをtrueにする公開capabilityはまだ提供しない。#155の完了には上記の実backend/decoder接続とP12/P13の独立受入が必要。
