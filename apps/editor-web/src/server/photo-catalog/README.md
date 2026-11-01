# P04 photo catalog API

Issue #153 のhandler coreとHTTP route。/api/photo/v1/library、/photos、/photos/{photoId}、/photos/{photoId}/info、/photos/lookupを、P01 VerifiedPhotoActorから得た本人IDでP02 store adapterへ接続する。queryやbodyからownerを受け取らない。

PhotoCatalogStoreはP02唯一のDB writer境界に接続するread adapter。owner、photo/library relation、lifecycle、filter、stable order、creation watermarkをDB snapshotで強制する。このPRではmigrationやSQLを追加しない。

含むもの:

- 閉じたquery parser、最大100件、repeated formats、edited/editable/lifecycle filter
- owner/filter/sort/watermark/after/expiryをAES-256-GCMで暗号化・認証する15分opaque cursor
- 4MiB以内へ切り詰める一覧。cursorは最後に返した写真から継続
- owner別revision ETag、private/no-store response
- asset/library capability/infoのallowlist serializer、working-copy meta 64KiB上限
- 原本保存済み・outbox job未作成の写真はP00の`media.pending`として一覧/詳細へ返し、疑似job IDを作らない
- owner-scoped lightweight hash lookup（最大100件）
- P01 actorの有効期限をrouteで再確認し、認証・cursor鍵・能力設定・DBのどれかが未設定/不正なら503で閉じる
- private runtime設定はEDITOR_PHOTO_CATALOG_ENABLED、hexのEDITOR_PHOTO_CATALOG_CURSOR_SECRET、EDITOR_PHOTO_CATALOG_CAPABILITIES、DATABASE_URL。秘密値は公開repoへ置かずP13の配備設定で管理する

route/unit/DB contract検査は含む。P01の実NIHO runtime認証、P06 workerによる全outbox消化、Mac/iPhone同一ownerの実受入が残るのでIssue #153はopenのまま。
