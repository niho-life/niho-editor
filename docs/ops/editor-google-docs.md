# Google Docsへの書き出しを開ける

NIHOの既存Google接続・OAuth・変換・receiptを再用する。EditorはGoogleのrefresh tokenを持たない。Googleのclientやscopeを増やさず、drive.file/userinfo.emailの既存境界を維持する。

認証は`AuthProvider.docsApiToken(session,request)`の固定用途だけ。現在のcookie/session/owner/接続/期限を再照合して、`/api/auth/experience-editor-connect/docs-drive`のconnection/connect/exports/status/限定batch grantだけを呼ぶ。generic apiTokenはnullのまま。writer承認は書き出しの条件ではなく、Experience公開に必要な権限として分離する。

NIHO側とEditor側の両方の変更をマージ・配備するまで機能は閉じたままにする。旧`/api/me/docs-drive`のrequireAuth/client制限を緩めて開けない。Google同意の`niho-editor` returnToは署名state/本人/flow/期限をNIHOが検証した後、固定Editor接続画面へだけ戻す。

単一書き出しは`GOOGLE_DOCS_MODE=niho`、API起点は専用NIHO認証originと同じ`/api`へ固定する。一括書き出しは暗号化snapshotと背景queueも必要であり、追加のruntime用keyringはオーナー専用入力で設定する。手順と復旧は[editor-google-docs-batch.md](editor-google-docs-batch.md)を正とする。

作成結果が不明なら同じexportIdのreceiptを確認する。Google文書を二重に作らず、同じpayloadだけを再試行する。既存Google文書を更新・削除しない。接続解除はNIHOが持つcredentialと限定grantを失効させ、プロジェクト全体のGoogle同意をrevokeしない。
