# NIHOの役割・記事連携をEditorへ接続する条件

2026-11-03。Editor [#42](https://github.com/niho-life/niho-editor/issues/42) の接続・受入条件。[製品設計 §10](editor-niho-life-design.md) に従う。役割表示・記事連携は、ページ作成・同期・文字起こしの基本提供条件とは別の後続機能。

## 現在の境界

- NIHO app [#19478](https://github.com/niho-coliving/niho-app/issues/19478) のEditor認証接続はclosed。ログインができることは、役割・招待APIを呼べることの証明ではない。
- [#19479](https://github.com/niho-coliving/niho-app/issues/19479) の役割・招待・連携状態の安定API schemaは未確定。Issueの候補endpointを実装済み契約として使わない。独自endpoint/response shape/RoleReader adapterを追加しない。
- [#19480](https://github.com/niho-coliving/niho-app/issues/19480) はNIHOカード、[#19481](https://github.com/niho-coliving/niho-app/issues/19481) は記事面。Editorの役割表示・招待操作とは別のconsumerで、公開APIにも依存する。
- [`AuthProvider.apiToken`](../../apps/editor-web/src/auth/types.ts) は、NIHO側でEditor用途を受け付ける契約が確定するまでnullのままにする。Photoのcredential・cookieやブラウザの自己申告roleで代用しない。

## 接続開始に必要な確定事項

NIHO側#19479と依存#19459・#19462・#19470の契約・実装・受入で次を確認し、採用するschema/versionとsource SHAを記録する。

| 契約 | 必要な情報 |
| --- | --- |
| 認証 | Editor client/audience/scopeを受理する本人API、serverからの呼出し方法、期限・失効・上流一時障害の扱い。既存ログインcredentialを無条件に転用しない |
| 役割の読取 | 本人の役割と公開先の許可、役割剥奪の反映時点、未知roleの扱い。内部ID・不要な個人情報をbrowserへ返さない |
| 招待 | 本人向け一覧、承諾・辞退、取消済み/期限切れ/重複操作/並行操作の応答と再送条件。管理者向け一覧を流用しない |
| 連携状態 | 承諾済み・取消・失効を区別する本人向けread modelと、使える公開中体験の候補。承諾前の体験を候補へ混ぜない |
| 公開時再確認 | サーバーから役割と連携の最新状態を読み、公開先と体験の所有・連携を確認できること。clientのrole/cacheを権限の根拠にしない |
| 非公開運用 | APIの配備済み版と合成アカウントでの負例受入。endpoint名だけ・未配備sourceだけでEditorを接続しない |

## 確定後のEditor実装と受入

1. 確定契約のserver-only consumerを接続し、`/account` に本人情報・役割・招待・承諾済み連携を表示する。roleをEditorの永続的な権限として保存しない。
2. 招待の承諾/辞退を接続する。結果不明の再送、二重クリック、別端末での取消、期限切れを契約どおりに扱い、画面を再取得する。
3. 本人と承諾済み連携先の公開中体験だけを候補へ出す。拒否・取消・非公開化が次の取得で消えることを確認する。
4. 既存の公開処理のRoleReaderへ確定adapterを接続する。画面表示後のrole剥奪・連携取消でも、次の公開操作をserverで拒否する。
5. 別本人、未知role、期限切れ/失効session、未承諾/取消済み連携、上流一時障害の負例を合成データで検証し、NIHO側の固定版との実接続を受け入れる。

未知role・API確認不能・未受入の接続を許可扱いにしない。token・メール・招待内容・実体験情報を公開fixtureやIssueへ残さない。共有UIはWebとMacで同じものを使い、Photoライブラリは接続しない。
