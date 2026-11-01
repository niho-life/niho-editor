# P07 photo lifecycle

Issue #156 のlifecycle routeと、狭いobject deletion portを使うpurge executor契約です。

- `POST /photos/{photoId}/trash` と `/restore` はP02のowner-scoped mutation writerを使い、原本やquota bytesを物理削除しません。
- `POST /photos/{photoId}/purge` はP02のdurable purge ledgerにtombstone/jobを作り、202でqueued receiptだけを返します。202は物理削除完了を意味しません。
- `GET /jobs/{jobId}` は検証済みactor ownerで絞ったpurge jobの状態だけを返します。object locator・asset一覧・他ownerのjobは返しません。
- `workers/photo-purge/src/executor.ts` はP02のowner-bound asset listとexact-generation delete portを受けます。providerがimmutable generationの削除またはそのgenerationの不存在を確認した後だけP02へconfirmationを書きます。generation違い・provider error・P02 confirmation失敗では成功へ進めず、再実行は未確認assetから続きます。

P02のHTTP/worker adapterは既存のowner-bound trash/restore/purge/job/asset/confirmation APIだけを呼びます。workerへ渡すassetはIDと削除対象objectのkey/generationに限定します。schema、migration、SQL、bucket IAMは変更しません。account deletionのowner全体iteratorと認証済み内部event接続はP02/P13の窓口に残し、公開routeに任意ownerを受ける操作は作りません。

production runtimeのpurge dependencyは現在`null`で、P01認証後に503でfail-closedします。worker provider、狭い削除権限、retry/reconciliation scheduler、account purge、実DB/実object storage受入が揃うまでIssue #156はopenのままです。
