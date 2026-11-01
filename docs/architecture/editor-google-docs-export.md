# editor の Google ドキュメント書き出し

旧 NIHO docs にあって editor に無い機能（[editor-migration-map.md](editor-migration-map.md)）の最後の 1 つ、**Google ドキュメントへの書き出し**の方針です。

## 結論

**editor は Google を直接呼びません。NIHO が既に動かしている `https://niho.life/api/me/docs-drive/*` を、サーバー側から本人として呼びます。**

Google の側（OAuth クライアント・同意画面・本人ごとの接続と refresh token の保管・Markdown から Google ドキュメントへの変換）は **niho-app に既にあり、本番で動いています**。
editor はそれの 2 番目の客になるだけです。**Google Cloud のコンソールでの作業も、client secret も、refresh token を預かる表も要りません。**

> **依存：この機能はDocs API専用の最小権限credential契約が出るまで使えません。** NIHO editorのopaque browser sessionは写真本人確認に限定し、
> native AppConnect・Experience token・一般NIHO API tokenを流用せず、`apiToken`はnullのままにします。
> それでもこの方式を採ります（書き出しは今すぐ要る機能ではなく、ここで token の預かりとコンソール作業を増やす見返りが小さい）。
> **先に使いたくなったときは §7 の予備案から作れます。**

## 1. 旧版の棚卸し（何が、どこに、生きているか）

| 旧版の部品 | どこ | editor から |
| --- | --- | --- |
| Google の OAuth クライアント・同意画面・scope | **niho-app（本番）** | **そのまま使う。** 作り直さない |
| 本人ごとの接続と refresh token の保管 | **niho-app（本番）** | **そのまま使う。** editor は持たない |
| Markdown → Google ドキュメントの変換 | **niho-app（本番）** | **そのまま使う。** editor は Markdown を渡すだけ |
| HTTP の契約（`me/docs-drive/*`） | `apps/docs/src-tauri/src/google_docs.rs`（この repo） | **写す。** 検証・失敗の対応づけも含めて §2 |
| 画面の状態機械（受付・再試行・再接続） | `packages/docs-ui/src/lib/use-google-docs.ts`（この repo） | 意味を引き継ぐ。コードは使わない（§4） |
| Mac だけの部品（Tauri の bridge・ローカルのファイル） | `apps/docs`・`local-google-docs-folder-export.ts` | 使わない |

旧版の Rust（`google_docs.rs`）は **Google を呼んでいません**。「本人の Google ドキュメント接続・書き出し専用の HTTP 境界」で、相手は NIHO の API です。
`DocsDriveConnection` の注記（「内部 credential や token は Bridge へ出さない」）も同じことを言っています。**Google を呼ぶ場所は、最初から 1 か所だけ**でした。

API が生きていることは確かめました（資格情報なしの要求に 401 が返る。中身は見ていません）:

```
GET  https://niho.life/api/me/docs-drive/connection → 401
POST https://niho.life/api/me/docs-drive/exports    → 401
```

## 2. 使う契約（`google_docs.rs` から写す）

`Authorization: Bearer <NIHO の ID token>`。応答の本文は 1 MiB まで、1 回の呼び出しは 45 秒で切る。

| | |
| --- | --- |
| `GET me/docs-drive/connection` | `{ connection: { status: "CONNECTED"｜"DISCONNECTED"｜"ERROR", connectedEmail, reason } }` |
| `POST me/docs-drive/connect` | `{ returnTo }` → `{ authorizationUrl }`（Google の同意へ送る URL） |
| `DELETE me/docs-drive/connection` | 解除 → `{ connection }` |
| `POST me/docs-drive/exports` | `{ exportId, title, markdown }` → `{ status: "completed", documentId, url }`｜`{ status: "pending", retryable }` |
| `GET me/docs-drive/exports/{exportId}` | 同じ形（受付の確認） |

**受け取った値は必ず形を確かめます**（旧版と同じ規則。ここを緩めない）:

- `authorizationUrl`: `https` ／ host が **`accounts.google.com` と完全一致** ／ port 443 ／ path が `/o/oauth2/` で始まる ／ 資格情報なし。違えば送らない。
- `documentId`: `[A-Za-z0-9_-]` だけ、10〜256 文字。
- `url`: **使いません。** `https://docs.google.com/document/d/{documentId}/edit` と完全に一致するかだけ見て、画面に出すのは**こちらで組み立てた URL**。
- `exportId`: 小文字の UUID（36 文字）。題名は 1〜200 文字（UTF-16）。本文は空でなく 1,000,000 文字・4 MiB 以内。

失敗は API の `{ error: { details: { reason } } }` と HTTP ステータスの組で分けます（旧版の `api_error` と同じ対応）:

| API | editor が返す code | 画面 |
| --- | --- | --- |
| 401 `app_connect_disabled` ／ 429 ／ 5xx ／ `export_temporarily_unavailable`・`access_token_failed`・`oauth_config_missing` | `temporarily_unavailable` | 少し待ってもう一度 |
| 401 その他 | `signed_out` | ログインし直す |
| 403 `niho_docs_app_required` | `app_not_allowed` | **niho-app 側が editor を許すまで出る**（§6） |
| 409 `drive_not_connected` ／ 422 `credential_invalid`・`auth_revoked` | `drive_reconnect_required` | Google へつなぎ直す |
| 409 `google_account_changed`・`drive_connection_changed` | `drive_connection_changed` | 接続先が変わった。新しい書き出しとしてやり直す |
| 409 `export_payload_conflict` | `export_payload_conflict` | 同じ受付で中身が変わった。やり直す |
| 404 `export_not_found` | `export_not_found` | まだ受け付けられていない |
| 400・413 | `too_large` | 題名か本文を短くする |
| 送ったが応答が分からない（時間切れ・通信の失敗） | `export_result_unknown` | **同じ `exportId` で状態を問い合わせてから**再試行 |

`export_result_unknown` は書き出しの POST だけに付けます（旧版の `uncertain_export`）。二重に文書を作らない仕掛けは **`exportId`** で、持っているのは API 側です。
**editor は受付の表を持ちません**（DB の migration を足しません）。進行中の `exportId` は画面が持ち、確認は `GET exports/{exportId}` に聞きます。

## 3. 置き場所

```
apps/editor-web/src/google-docs/
  config.ts     EDITOR_GOOGLE_DOCS_MODE・API の origin・returnTo の解決（src/transcription/config.ts と同じ形）
  gateway.ts    editor が使う口（port）・失敗の code・受付の id と documentId の形
  niho.ts       上の契約の実装（fetch。応答の検証と code の対応づけ）
  runtime.ts    要求ごとに口と本人の資格情報を作る（どちらも無ければ null＝503）
src/server/google-docs-api.ts            route の実装（接続・解除・書き出し・状態）
src/app/api/google-docs/{connection,connect,disconnect,exports/[exportId]}/route.ts
src/app/api/pages/[id]/export/google-doc/route.ts
src/app/google-docs/connect/page.tsx     未接続のときに案内する画面
src/components/GoogleDocsConnectView.tsx その画面（JavaScript を使わず form だけ）
src/lib/google-docs-paths.ts             画面とサーバーが共有する path
```

**migration は足しません**（受付の表は API 側が持つ）。本人の token の口だけ `AuthProvider` に足します
（`apiToken`。`niho`も`stub`もnullを返す＝閉じたまま。写真本人確認とは別のcredential契約だけがここを埋める）。

`gateway.ts` を**口（interface）**にしておくので、将来 editor が自分で Google を呼ぶ必要が出たときは実装を 1 本足すだけです（§7 の予備案）。
`packages/docs-ui` には足しません（共有画面は `fetch` を書けない＝`isolation.test.ts`。旧版の hook を使うには Mac の bridge とアカウント状態を作り直すことになり、割に合いません）。
`shellMoreItems` の「書き出し」の補足は**すでに** `".md · Google ドキュメント"` なので、editor 側で `.md` に差し替えている 1 行（`src/lib/use-page-menu.ts`）を戻します。

## 4. 本文は Markdown のまま渡す

API が受け取るのは Markdown なので、**editor が既に持っている `src/export/markdown.ts` の出力をそのまま使えます**。限定 AST の知識を二重に持ちません。

1 つだけ変える所があります。`.md` の書き出しは囲み（引用・callout）を niho-experience のサブセットである `:::note` … `:::` で書きますが、
これは一般の Markdown では**ただの文字**になります。そこで囲みの書き方だけを選べるようにし、Google ドキュメントへ渡すときは `> `（引用）にします。

```ts
exportMarkdown(blocks)                   // .md の書き出し（今まで通り :::note）
exportMarkdown(blocks, { boxes: "quote" }) // Google ドキュメントへ渡す分
```

画像・区切り線・録音は `.md` と同じく出しません（旧版のフォルダ書き出しも `imagesSkipped` を数えていました）。

## 5. 画面の流れ

```
「…」›「Google ドキュメントへ」
  └ まだ届いていない変更を保存（flush）→ POST /api/pages/{id}/export/google-doc { exportId }
      本文はサーバーが保存済みの blocks から作る（ブラウザは本文を送らない）
      題名はページの題名。**500 文字まで入るので、API の上限 200（UTF-16）で切る**（断らない。`googleDocTitle`）
      ├ completed → 文書を新しいタブで開く（URL は documentId から組み立てる）
      ├ drive_reconnect_required / 未接続 → /google-docs/connect?next=… へ案内
      │    「接続する」→ POST /api/google-docs/connect → API の authorizationUrl を検証して 303
      │    （Google の同意のあとは niho.life 側の callback に戻るので、editor へは本人が戻る）
      └ export_result_unknown → GET /api/pages/{id}/export/google-doc/{exportId} で確かめてから、同じ id で再試行
```

更新系はすべて**同じ origin から**だけ（違えば 403）。NIHO の token はサーバーの中だけで使い、ブラウザへは接続状態・`documentId`・短い code しか出しません。

## 5.1 権限の広さと、やめられること

この方式では **editor は Google の scope を 1 つも要求しません**。同意を取るのも、scope を決めるのも niho-app 側の同意画面です
（旧 NIHO docs の利用者が見ていたものと同じ）。**フォルダ単位の書き出し（§8）でも、editor 側に scope は増えません。**
もし将来 editor 自身が Google を呼ぶ（§7 の予備案）ことになった場合は、`drive.file`（アプリが作った文書しか触れない）だけを求め、
**そこから広げる判断は別途オーナーに相談します**（勝手に広げない）。

やめられる形も要ります。画面の「接続をやめる」は `DELETE me/docs-drive/connection` を呼び、**預かっているもの（refresh token）を持っているのは
niho-app なので、消すのと Google 側で失効させるのも API 側で行います**（旧 Mac アプリの解除とまったく同じ経路）。
editor は何も持たないので、editor 側に消すものはありません。**API が実際に Google の revoke を呼んでいるかは niho-app 側の実装**なので、
専用credentialの受入項目に入れます（§6）。利用者は本人のGoogleアカウントの「サードパーティ製アプリとサービス」からも取り消せます。

## 6. niho-app 側に要るもの（editor だけでは開かない）

1. **Docs API専用credentialの契約。** editorの写真本人確認sessionや既存AppConnectを広げず、`me/docs-drive/*`だけを呼べるserver-side tokenを発行・失効できること。
2. **editor を許すこと。** 今の API は `403 niho_docs_app_required` で **NIHO docs からの呼び出しだけ**を通します。editor からの呼び出しを許してもらう必要があります。
3. **`returnTo` の値。** 旧版は `"niho-docs"` を送っていました。editor 用の値（`EDITOR_NIHO_RETURN_TO`、既定 `niho-editor`）を受け入れてもらいます。
4. **解除で Google 側の失効まで行うこと。** `DELETE me/docs-drive/connection` が refresh token を消すだけでなく、Google の revoke も呼んでいることを確かめます（§5.1）。

この4つが揃うまで、書き出しは**閉じたまま**です（APIは503 `google_docs_unavailable`）。AI（§10）・文字起こし（§12）と同じpostureです。

## 7. 予備案：editor が自分で Google を呼ぶ（採らない）

niho-app の API を使えない事情（API を畳む・editor を独立させる）が出たときの備えとして、方式だけ残します。**この PR では作りません。**

- 本人の Google アカウントで OAuth 2.0（Authorization Code ＋ PKCE）。scope は `https://www.googleapis.com/auth/drive.file` だけ（Google の分類で non-sensitive＝審査なし。アプリが作った文書しか触れない）。
- refresh token はサーバーだけが持ち、AES-256-GCM で包んで Cloud SQL に置く（行ごとの IV、AAD に `user_id` と鍵の版）。鍵は Secret Manager（`gcp-bootstrap.sh` が生成）。access token は保存しない。
- 本文は限定 AST から **HTML** を作り、Drive の multipart upload（`uploadType=multipart`、metadata の `mimeType` に `application/vnd.google-apps.document`）で変換させる。
  Docs API（`documents.batchUpdate`）は scope が増えるので使わない。Markdown の取り込みは受け付ける MIME が明記されていないので契約にできない。
- refresh token を包む鍵を回すときは、**その版で包まれた行が 1 つも無いことを DB で確かめるまで、前の版を読めるようにしておく**
  （`key_version` を数える）。「皆が 1 度書き出した頃」は安全な引退条件ではない（1 度も書き出さない人の行が読めなくなる）。
  先に全部の行を包み直す migration を流してから外す形でもよい。
- **二重に作らない仕掛けは、editor 自身では作りきれない。** 変換を伴う upload には Drive の事前生成 ID が使えないので、
  `appProperties.nihoExportId` を付けて作り、再試行では `files.list` で引き当ててから作ることになるが、
  **これは引き当て（reconciliation）の目印で、atomic な冪等の仕組みではない**:
  30 秒で切った upload が Google 側でまだ処理されていることがあり、再試行の `files.list` が「無い」と見てもう 1 つ作ると、
  同じ `nihoExportId` の文書が 2 つできる。採るなら、少なくとも次を決めてから作る。
  - 受付の表（editor 側）に `running` / `unknown` を持ち、**`unknown` のあいだは新しい upload を始めない**。
  - `unknown` の受付は、`files.list` で引き当てられたらその文書を採用する。引き当てられず、かつ**最初の試行から
    Google の処理が残り得る時間（要求の時間切れ＋余裕）を過ぎていない**あいだは、作らずに「まだ分からない」を返す。
  - その時間を過ぎてから作る場合も、**遅れて届いた元の upload で 2 つできる残りの危険**は消えないので、引き当てで
    古いほうを残して重複を知らせる後始末を持つ。
  - テストは「元の upload が遅れて成功する」筋を含める（`files.list` が空を返したことを失敗の証拠にしない）。

  この PR の方式では、二重に作らない仕掛けは **API 側（`exportId`）**にあり、editor は分からないときに
  `export_result_unknown` を返して**確かめてから**同じ id で再試行します（§2）。上の面倒は、予備案を採るときに引き受けるものです。
- サービスアカウント＋共有ドライブは採らない（鍵 1 つで全員分の文書に手が届く。文書の持ち主も保存容量も NIHO 側になる）。
- **同意の URL を editor が開く形になるので、`validate_authorization_url` と同じ検証を必ず持たせる**
  （`https` ／ host が `accounts.google.com` と完全一致 ／ port 443 ／ path が `/o/oauth2/` で始まる ／ 資格情報なし。旧 Mac アプリの
  `apps/docs/src-tauri/src/google_docs.rs` が良い先例で、この PR の `src/google-docs/niho.ts` も同じ検証を持っている）。
  **任意の URL を開かせない。** 自分で組み立てる場合も、組み立てた URL を同じ検証に通してから使う。

こちらを選ぶ場合は、オーナーに Google Cloud のコンソールでの作業（同意画面・公開状態を「本番」にする・scope の追加・OAuth クライアントの作成）と client secret の投入が発生します。

## 8. フォルダ単位の書き出し（この PR では出しません）

旧版は `folder-export-tree` でフォルダの木を 1 つの文書の**タブ**に並べ、本文は送らず **API が本人の NIHO クラウドから読んで**いました。
editor のページは editor の Cloud SQL にあるので、**その口（`me/docs-drive/folder-exports/*`）はそのままでは使えません**。editor では次のようにします。

- **木を数える口は作りません。** フォルダ＝親ページの木は **T1** が用意する一覧をそのまま読み、入ってから繋ぎます。
- 1 ページずつ `POST me/docs-drive/exports` を呼び、**ページごとの文書**を作ります（タブで 1 つにまとめる形は採りません）。
- ページ数が多いと 1 要求に収まらないので、文字起こし（§12）・手順（§11）と**同じ形**でサーバー側に逃がします（Cloud Tasks ＋ 同じサービスの OIDC で守った worker の route。`src/server/google-oidc.ts` は既にあります）。

## 9. 確かめ方

**Google も niho.life も実際には呼びません。** 偽の `fetch` を注入して、契約・検証・失敗の対応づけ・権限を固定します。

- `src/google-docs/niho.test.ts`: 契約（path・`Authorization`・本文の形）／`authorizationUrl` の host と path を偽ったら送らない／`documentId` の形が違えば受けない／**API が返した `url` を使わない**／`reason` と HTTP ステータスの組が §2 の code になる／通信の失敗は書き出しだけ `export_result_unknown`／題名と本文は送る前に確かめる／token と応答の本文がどの失敗にも出ない。
- `src/google-docs/config.test.ts`: 既定は閉じたまま／起点は `https` だけ（開発では localhost の `http` も）／`returnTo` の形／誤りのメッセージに値を入れない。
- `src/server/google-docs-api.test.ts`: 未認証 401／方式が閉じている・token が出せないとき 503／別 origin 403／他人のページと存在しない id は同じ 404／**本文と題名はサーバーが作る**（ブラウザからは受け取らない）／書き出せるブロックが無いページは API を呼ばない／code ごとの HTTP ステータス。
- `src/lib/page-actions-client.test.ts`・`src/lib/use-page-menu.test.ts`: 送るのは受付の id だけ／`documentId` と合わない `url` の応答は受け付けない／「…」の項目と失敗の文言。
- `src/components/GoogleDocsConnectView.test.tsx`: 接続・解除の form の行き先／使えないときは入口を出さない／code をそのまま画面に出さない。
- `src/export/markdown.test.ts`: 囲みの書き方の変種（`:::note` と `>`）と、箱の外は何も変わらないこと。
- `packages/docs-ui` は**触っていない**ので `isolation.test.ts` の対象は変わりません（共有画面には足していません）。
