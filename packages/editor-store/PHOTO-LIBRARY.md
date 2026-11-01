# 個人写真のstore

`photo-store.ts` は、個人写真ライブラリのowner付きPostgreSQL接続口。`owner` は検証済みserver actorから渡し、公開requestから受け取らない。契約の正本は [`personal-photo-library.md`](../../docs/architecture/personal-photo-library.md)。

## uploadの流れ

1. `reservePhotoUpload` が本人に一つのlibraryを遅延作成し、その行をlockする。本人内の重複を照合し、申告bytesを原子的にreservedへ移す。
2. `claimPhotoUploadVerification` がreservedをverifyingへ変え、新しいlease generationを返す。再取得・取消・拒否・期限切れでは世代を進め、古いworkerのcompleteを拒む。
3. 転送workerは全bytesを読み、size・SHA-256・magic bytes・形式・寸法を検証し、検証したgenerationだけをimmutableな確定keyへ条件付きcopyする。provider statやclient申告だけでは検証済みにならない。
4. `completePhotoUpload` は、その検証結果と現在のlease generationだけを受ける。reservedをusedへ原子的に移してstored photo/assetを作る。同じ本人の重複原本なら既存recipeを維持して収束する。物理copy後にDB確定が失敗した場合、呼出側は `recordPhotoOrphan(..., reason: "copy_db_failure")` で清掃台帳へ残す。清掃台帳へ一度登録された物理generationはretire済みで、後着のcompleteはassetとして採用しない。反対に、既存assetが参照するgenerationをorphan登録してもno-opになる。
5. `cancelPhotoUpload`・`rejectPhotoUpload`・`expirePhotoUploads` は予約を一度だけ解放し、古いworkerをfenceする。

`getPhotoUpload`・`getPhoto`・`getPhotoAsset`・`lookupPhotoByOriginal`・`getPhotoLibrary`・`getPhotoUsage` は必ず検証済みownerを受ける。不正UUID・不存在・別ownerのIDは同じnullにする。

## lifecycleとGC

物理削除確認だけで、ファイル名・digest・recipe等のmetadata消去まで完了したとは扱わない。P07は子台帳からmetadataを消すtransactionも実装する。photo/assetの循環FKは遅延NO ACTIONで、その消去を可能にしている。退会中のlibraryは最小限のdeleting tombstoneを残し、遅着requestで新規予約が復活しないようにする。

`trashPhoto`・`restorePhoto` はusedを変えずにactive/trashの内数を動かす。`beginPhotoPurge` はtombstoneと新しいlifecycle epochを記録し、保持assetをgeneration付きの削除待ちへ移す。`listPhotoPurgeAssets` が削除対象を返し、`confirmPhotoAssetDeleted` は正確なimmutable generationの削除確認後にだけusedを解放する。

`recordPhotoOrphan`・`listPhotoOrphans`・`confirmPhotoOrphanDeleted` は、生きたDB参照のないcopy/staging objectの再試行可能な清掃台帳。物理locatorはownerをまたいで一意だが、その存在やlocatorは公開応答に出さず、trusted server-only入力の境界を維持する。清掃一覧も防御的にasset参照中のgenerationを除外する。

`markPhotoLibraryDeleting` は新規予約を拒み、未完了の予約を解放し、accountと各photoの世代を進める。deleting中はP07が全原本を同じ台帳で消せるよう、active photoも `beginPhotoPurge` へ渡せる。active accountでこの省略は使えない。

migrationには、現在のrecipeとrevision、named/auto versions、media job、purge job、canonical media metadataのowner付き保存先を用意した。初期recipeはSDKのneutralと揃え、RAWは `neutralDevelopSettings(null, { raw: true })` 相当の `niho-2`、ラスタは既存の `niho-14` を保存する。canonical base確定後の初期recipe整合はP05/P06で接続する。すでに保存された補正は自動昇格・自動置換しない。P05/P06はこの基盤に完全なCAS/worker操作を接続する。適用済みのmigrationを編集しない。

重複を検出して容量予約なしで成功するstartも、同じ`photo_uploads`台帳にpayload hashと対象photo/assetを保存する。この行は`stored`・予約0・完了lease generation 0（新しい転送なし）で、再送のpayload照合と現在のphoto状態の再検証を通す。実転送の検証leaseは1以上なので区別でき、trash/purge後に同じキーからuploadを新設しない。
