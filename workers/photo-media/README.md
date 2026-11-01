# 写真media workerの独立コア（P06 / #155）

P00の固定値と本人写真contractを使う、依存注入式の実行コア。P01/P02/P03/P05が実装中のため、HTTP route、実DB、object storage、decoder、SDK runtime loaderをまだ接続していない。常設serverや資格情報は含まない。このpackageだけで写真クラウドを有効にしない。

```sh
npm -C workers/photo-media ci
npm -C workers/photo-media run check
```

`src/identity.ts` はowner/photo、原本asset/hash/generation、lifecycle世代、recipe revision/settings hash、canonical base、renderer manifestと出力上限を一つのjob keyに固定する。同じキーへのenqueue収束と永続状態はP02が実装する。

`src/run.ts` は同時実行を1件、1回60秒以下、最大3 attemptに制限する。実行開始時と派生物stage前に現在値を読み、最後はP02の原子的publish CASへ全identityとlease世代を渡す。古い結果はpublishできず、まだ同じclaimならsupersededへterminal CASする。旧claimの失敗・supersedeが新claimを変更しないことをstore portに要求する。外部の一時障害とdecoderが確認した画像の失敗を区別し、未知例外は`infrastructure_unavailable`で上限付きretryへ送る。

`MediaAttemptFailure`・`RunResult`・supersededはworker内部のattempt/lease状態だけに使う。`infrastructure_unavailable`、`timeout`、`cancelled`、`original_changed`、`invalid_output`を写真APIのmedia失敗codeへ保存・返却しない。公開`MediaState.failed.code`はP00の`decoder_failed` / `renderer_unavailable` / `unsupported_settings`のまま。実store接続時に公開状態への反映を別途対応させる。

通常のAbortSignalはtask/processの停止として扱い、同じactive identityでattemptが残る場合は上限付きbackoffで再試行する。P00に公開のmedia job取消操作はない。P02/P07がlifecycleやjobをfenceした場合は失敗CASを何も変更しない処理にする。

原本は世代指定のstreamから私有の一時directoryへ最大256MiBだけ書き、実size/SHA-256を再検査する。派生物はthumbnail、preview、working-copyを別assetとして生成し、出力寸法・サイズ・hash、scratch内の通常ファイル、sRGB/向き/不要metadata除去、canonical working-copyとの互換を検査してからcreate-only stageへ渡す。原本hash不一致や古いrecipeでは原本・写真行を変更しない。退出経路で一時directoryを消す。

実接続時に以下の境界を満たす。

- **P02**: `MediaJobs`のclaim/publish/fail/supersedeをDB transactionで実装する。publishはlease期限・実行deadline・claim世代・owner・active lifecycle・原本generation/hash・base・recipe revision/hashを同時照合し、派生物参照とlibrary revisionを一度だけ確定する。query自体のtimeoutとprocess停止後のlease回収もDB側で行う。
- **P03/P07**: `MediaObjects`を本人/photo付きで世代指定readとcreate-only stageへ接続する。stageはobjectを書き始める前にdurable清掃台帳へ登録し、実書込bytes/hashも検査する。通信結果不明・process停止・遅着書込を回収し、`abandon`はその世代だけを再開可能な清掃候補へ残す。publish応答の喪失時はDBへ確定済みの場合があるため、物理削除前に必ずpublish状態と参照を再照合し、参照済み派生物を消さない。
- **P06 decoder bridge**: 実release bytesを`verifyPinnedArtifact`で検査してSDKをロードする。providerのrenderer自己申告だけをartifact検証の代用にしない。`supports`は固定SDKで設定全体・canonical hash・base・mask/featureを検証する。decode前にpixel上限をprobeし、別processのCPU/メモリ/一時領域を制限し、abortでprocessを終了する。`inspect`は実decoderで出力を調べる。JPEG/PNG、LinuxのHEIC/HEIF bridge、検証済みRW2と色/向きの実decode証跡はまだない。
- **P03/P06のbase選択**: RAW等のworking-copyが必須な入力は、serverが選んだcanonical baseVersionをjob作成前に固定して`MediaSource.baseVersion`へ渡す。既存recipeにbaseがある場合は一致が必須。base未確定のまま任意のworking-copyを成功扱いしない。このmappingは実store/decoder接続で確定する。
- **P01/P13**: 認証済みactor、rate/queue上限、workerの実行ID、公式配備、起動時の停止済みprocessのscratch清掃、メモリ予算を接続する。100MP入力の予算が未確定のため並行数2以上は拒否する。owner以外へ内部identity・locator・失敗本文を返さない。

テストはP00の合成ID/recipeとメモリ上の合成PNGを使う**orchestrationの単体試験**である。fake providerは実decodeを行わず、HEIC/RAW対応・画素・色・実SDKの合格を表さない。実providerを登録するfactoryや、ingest/workingCopyをtrueにする公開capabilityはまだ提供しない。#155の完了には上記の実接続とP12/P13の独立受入が必要。
