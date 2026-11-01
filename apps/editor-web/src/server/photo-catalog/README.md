# P04 photo catalog core

Issue #153 のhandler core。HTTP routeとP01 actor resolverは接続していない。各メソッドの`owner`には、routeが認証・失効確認済みのactorから得たuser IDだけを渡す。queryやbodyでownerを受け取らない。

`PhotoCatalogStore`はP02唯一のwriter境界に接続する必須port。owner、photo/library relation、lifecycle、filter、stable order、creation watermarkを同じDB snapshotで強制する。現行P02にcatalog page/filter/cursorとrecipe/mediaを含む完全なPhoto projectionは未exportなので、このPRでschema/storeやSQLは変更しない。

coreに含むもの:

- 閉じたquery parser、最大100件、repeated `formats`、edited/editable/lifecycle filter
- owner/filter/sort/watermark/after/expiryをAES-256-GCMで暗号化・認証する15分opaque cursor
- 4MiB以内へ切り詰める一覧。cursorは最後に返した写真から継続
- owner別revision ETag、認証済みrouteから使うprivate/no-store response
- asset/library capability/infoのallowlist serializer、working-copy meta 64KiB上限
- owner-scoped lightweight hash lookup（最大100件）

P01 verified actor route、P02 catalog store API、P05 recipe projection、P06 media projectionの接続後にroute受入を行うまでIssue #153はopenのまま。
