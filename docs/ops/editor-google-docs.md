# Google ドキュメント書き出しを開ける

設計は [editor-google-docs-export.md](../architecture/editor-google-docs-export.md)。

**Google Cloud のコンソールでの作業はありません。鍵も Secret も増えません。** editor は Google を直接呼ばず、
NIHO が既に動かしている `https://niho.life/api/me/docs-drive/*` を本人として呼びます（OAuth クライアント・同意画面・本人ごとの接続と refresh token・Markdown からの変換は、すべて niho-app 側にあります）。

> **現在は閉じたままです。** NIHO editorの専用sessionは写真本人確認だけに限定し、Docs Drive用の`apiToken`を発行しません。
> 書き出しを開くには、ログインとは別の最小権限credential契約とNIHO側の許可・失効受入が必要です。

## 1. 開く前に要るもの（niho-app 側）

editor 側の配備だけでは開きません。**次の 3 つは niho-app に頼むことです。**

1. **Docs API専用credentialの契約。** editorの写真本人確認sessionやnative AppConnectを流用せず、`me/docs-drive/*`だけを本人として呼べる最小権限tokenをserver側に渡すこと。
2. **editor からの呼び出しを許すこと。** 今の API は `403 niho_docs_app_required` で、**NIHO docs からの呼び出しだけ**を通します。許されるまで、書き出しは画面で `app_not_allowed`（「NIHO 側の許可待ちです」）になります。
3. **`returnTo` の値を受け入れること。** 旧 Mac アプリは `"niho-docs"` を送っていました。editor は既定で `"niho-editor"` を送ります（`deploy.env` の `NIHO_RETURN_TO` で変えられます）。Google の同意のあとに本人を戻す先を、この値で決めてもらいます。

## 2. editor 側の配備

| 変数 | 値 | 内容 |
| --- | --- | --- |
| `EDITOR_GOOGLE_DOCS_MODE` | `niho` | 空・未設定なら全部 503 `google_docs_unavailable`（**既定は閉じたまま**） |
| `EDITOR_NIHO_API_ORIGIN` | `https://niho.life/api` | API の起点。`https` だけ。既定はこの値 |
| `EDITOR_NIHO_RETURN_TO` | `niho-editor` | 1-3 の値。既定はこの値 |

1. `deploy.env` に 1 行足します（秘密ではありません）。

   ```
   GOOGLE_DOCS_MODE=niho
   ```

   API の起点と `returnTo` を既定から変えるときだけ `NIHO_API_ORIGIN`・`NIHO_RETURN_TO` も足します。
2. `scripts/editor-deploy/deploy.sh --no-build` — `EDITOR_GOOGLE_DOCS_MODE` ほかが付きます（ログに `Google Docs: on` / `off`）。
3. 画面で確かめます。ページの「…」›「Google ドキュメントへ」→ 未接続なら案内の画面 →「接続する」→ Google の同意 → 戻ってもう一度「Google ドキュメントへ」→ 自分のドライブに文書ができ、開けること。

> NIHOログインが使えても、Docs用credentialが無い間はこの機能だけ503 `google_docs_unavailable`のままです。

## 3. やめる・閉じる

**利用者がつながりをやめる**ときは、`/google-docs/connect` の「接続をやめる」を押します（`DELETE me/docs-drive/connection`）。
預かっているもの（refresh token）を持っているのは niho-app なので、**消すのと Google 側で失効させるのも niho-app 側**です
（旧 Mac アプリの解除と同じ経路。editor は何も持っていません）。本人の Google アカウントの「サードパーティ製アプリとサービス」からも取り消せます。

**機能を閉じる**ときは `deploy.env` の `GOOGLE_DOCS_MODE` を空にして `deploy.sh --no-build`（以後は 503 `google_docs_unavailable`）。
**本人と Google のつながりは niho-app 側にあるので、editor を閉じても切れません**（NIHO docs からは使えたままです）。

**鍵を回す手順はありません**（editor は鍵も Secret も持ちません）。

## 4. 費用

**editor 側の追加はありません。** Google への呼び出しも保管も niho-app 側で、Secret の版も増えません。

## 5. editor が自分で Google を呼ぶことになったら

niho-app の API を使えない事情が出たときの予備案（OAuth クライアントを editor 用に作り、refresh token を editor が包んで預かる形）は
[editor-google-docs-export.md](../architecture/editor-google-docs-export.md) §7 にあります。**そちらを選ぶときだけ**、Google Cloud のコンソールでの作業（同意画面・公開状態を「本番」にする・`drive.file` の追加・OAuth クライアントの作成）と client secret の投入が発生します。
