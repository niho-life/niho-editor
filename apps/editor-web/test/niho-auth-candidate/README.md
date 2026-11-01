# NIHO本人接続の候補環境

#150の実NIHO接続だけを受入するHTTP service。写真・Docs・DB・AI・storageの操作経路を持たない。通常のeditor productionとは別のserviceに配備し、既存Google認証のtrafficやowner IDを変えない。

`src/auth`のNIHO provider・設定・cookie・returnTo、`src/server/auth-routes`・`http`・`photo-auth`を同じsourceからTypeScriptでコンパイルする。authロジックの別実装やdeployableなstub fallbackは持たない。`/health`のsource commitとファイルhashを実接続証跡へ記録する。共有している認証処理の型検査・回帰はeditor-web CI、HTTP変換と経路の制限はこのpackageで検証する。

- `EDITOR_AUTH_MODE=niho`、exact HTTPSの`EDITOR_NIHO_ORIGIN` / `EDITOR_ORIGIN`が必須。不備はportを開く前に拒否する。
- 経路は接続案内・health、login/start、callback、logout、refresh、写真の本人snapshotだけ。その他は404。bodyは64KiBまで。
- NIHOのWeb originは同一originの`/api`がprivate NIHO APIへ届くものを使う。callbackは候補の`EDITOR_ORIGIN`＋`/auth/callback`をprivate側へ完全一致登録する。
- API key・DB URL・Google secret・写真storage資格情報は渡さない。秘密の投入や既存productionの切替は行わない。
- protocol v2のform POSTで開始・callbackを渡す。生成navigation/action/login return URLにcode/state/query/fragmentを載せず、NIHO GET callbackを受け付けない。NIHO-origin POSTは同一origin再POSTのrelayを返し、SameSite=Lax Cookieを維持する。
- form HTMLは独立nonce/CSP/no-storeとReferrer-Policy originを持つ。合成POSTの実request URLとlogのpositive controlを照合し、POST本文・cookie・Authorizationを保存しないことを実code発行前に確認する（`docs/ops/editor-deploy.md`）。source/環境区分・検証結果だけを公開台帳へ戻し、user ID・code・cookie・credentialは出さない。
- 実アカウントでログイン・本人snapshot・refresh・logout・別接続の併存を検証し、最後にテストsessionをlogoutする。この確認だけで写真クラウドやMac/iPhoneの写真UI受入を完了扱いにしない。

ローカルの合成HTTP test:

```sh
npm -C apps/editor-web/test/niho-auth-candidate ci --ignore-scripts
SOURCE_COMMIT=$(git rev-parse HEAD) npm -C apps/editor-web/test/niho-auth-candidate run build
npm -C apps/editor-web/test/niho-auth-candidate test
```

imageはリポジトリrootをcontextにし、`Dockerfile`へexact SHAを`SOURCE_COMMIT`として渡して作る。`server-only`は公式packageを`react-server`条件で読み、Nodeのserver内だけで実行する。配備後のhealth hashと受入対象mainを照合し、実環境登録前は未完了と記録する。
