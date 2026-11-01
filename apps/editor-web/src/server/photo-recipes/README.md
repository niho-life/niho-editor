# P05 recipe/version routes

Issue #154 のrecipe CAS・保存版・route境界。`PUT /photos/{photoId}/recipe` と `GET/PUT /photos/{photoId}/versions` をP01の検証済みactorへ接続し、ownerはrequest bodyから受け取りません。mutationは冪等キーと上限付きJSON bodyを要求し、応答は`private, no-store`です。recipe競合は409とcurrentRevisionを返します。

保存版の復元は現在のrecipe revisionをbaseにした通常のrecipe PUTとして扱います。原本や既存recipe revisionを書き換えず、復元したsettingsが新revisionになります。VersionSetは別revisionでCASし、P02のtransaction writerがowner/lifecycle、mask所有、冪等性、media outbox fenceを再確認します。

settingsの互換性、canonical SHA-256、mask参照抽出は固定Photo SDK/runtimeの`PhotoRecipeValidator`へ委譲します。未知settingsやmask不足を推測で補いません。P02 store adapterは接続済みですが、production runtimeはP13による正式SDK validator・capability設定の接続まで依存を`null`にし、認証後に503で閉じます。実SDK・本番runtime・Mac/iPhoneの往復受入が揃うまでIssue #154はopenのままです。
