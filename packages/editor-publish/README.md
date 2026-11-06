# @niho/editor-publish

editor の公開のシート（#39）と発信先の設定（#41）の裏で動く判定と状態遷移。仕様の正本は [editor-publish-core.md](../../docs/architecture/editor-publish-core.md)、公開版の形と読み取り API は [editor 公開 API contract v1](../../docs/security/editor-publish-api-v1.md)（[`@niho/editor-publish-contract`](../editor-publish-contract/)）、画面と役割は [editor-niho-life-design.md](../../docs/architecture/editor-niho-life-design.md) §8・§10・§12。

純粋な TypeScript で、依存は `@niho/editor-publish-contract` だけ（Node 24 と標準の Web Crypto）。DB・HTTP・NIHO の役割・時計・資産の置き場はポートで受け取る。

## 持つもの

| モジュール | 内容 |
| --- | --- |
| `declaration` | 発信先の宣言の検証（閉じた語彙。未知の `kind`・フィールド・型の違いは宣言ごと拒否） |
| `readiness` | `collectFacts` と `evaluateReadiness`（公開の前に：`problems` と `notices`） |
| `slug` | `slugFromTitle`・`validateSlug`・`suggestSlug` |
| `snapshot` | TipTap の本文 → 契約の AST、公開版（`buildSnapshot`、契約で自己検証して freeze）、`fingerprint` |
| `status` | `deriveStatus`（`ShellStatusState` と同じ語）と `sheetPlan`（`problems` があれば主ボタンは `null`） |
| `redirects` | NIHO の面の転送（`resolveRedirect` は最大 8 段、輪は一覧。鎖は 1 段に保つ） |
| `service` | `PublishService`：`publish`・`update`（保存を含む）・`stop`・`changeDestination`。各操作は 1 トランザクション |

## ポート

| ポート | 役目 |
| --- | --- |
| `PublishStore` / `PublishTx` | ページ・資産・公開・公開版・転送。失敗したら全部元に戻すトランザクション |
| `RoleReader` | NIHO の役割を操作のたびに読む（保存しない） |
| `StorageModeReader` | アカウントの保存先（`CLOUD`／`LOCAL`／`CLOSING`／`UNSET`）を NIHO から操作のたびに読む（保存しない）。`CLOUD`（`UNSET` を含む）以外では `publish`・`update`・`changeDestination` を `storage_not_cloud` で断り、シートの主ボタンも押せなくする。`stop` は常にできる（設計 §2.1） |
| `ConnectionSource` | 本人のサイトの接続があるか（#41 の `connectionSource` が実装） |
| `DeclarationSource` | 発信先の宣言 JSON（検証はこのパッケージ） |
| `AuthorSource` | 公開した時点の著者（名前・handle・url と、任意の著者紹介 `profile`。紹介は公開版の `authorProfile` になる） |
| `FactsSource` | 関連する体験が掲載中か（`null` は満たさない） |
| `AssetUrls` | 資産の https URL |
| `Clock` | 時刻 |

## #41 発信先の設定

| モジュール | 内容 |
| --- | --- |
| `connections` | `ConnectionService`（接続・鍵・接続の解除・公開中の一覧・書き出しの入口）と、#39 へのアダプタ `connectionSource`・`siteDeclarationSource` |
| `export` | `buildExportArchive`：`{slug}.md`（YAML の front matter ＋契約の Markdown、写真は `photos/{sha256}.{ext}` への相対パス）＋写真（sha256 で重複を省き、バイト列を照合） |
| `zip` | `buildZip`：無圧縮 STORE・CRC-32・UTF-8 名・決定的。zip-slip になる名前・重複・65,535 件超・4 GiB 以上は結果で拒否（ZIP64 なし） |

| 操作 | 振る舞い |
| --- | --- |
| `createConnection` | 接続と最初の鍵。`handle` は契約の形と予約語、一意（解除済みの接続の handle も再利用しない）、作ったあと変えられない。`siteUrl` は https（資格情報・ポート・IDN・IP 不可）、`urlShape` は宣言の `host`／`path` の規則 |
| `rotateKey` | 新しい鍵の作成と有効な鍵すべての失効を 1 トランザクションで。平文はこの結果にだけ |
| `revokeKey` | 1 本を失効（何度呼んでも同じ結果） |
| `updateConnection` | `mode`・`siteUrl`・`urlShape`。handle は `handle_locked`。出した公開版は変えず、次の「更新を公開」から新しい URL |
| `disconnect` | 1 トランザクションで、鍵をすべて失効・接続を解除済み・その handle に公開中のページをすべて公開をやめた状態に（公開版は残す、転送は作らない）。2 回目は 0 件 |
| `listPublished` | その接続に公開したページ（公開をやめたものを含む）と状態（`deriveStatus`） |
| `getConnectionView` / `listConnections` | 設定ページ用。`apiUrl`、URL の形、`ek_••••••••`＋末尾 4 文字の鍵の一覧、`pushEnabled: false` |
| `exportConnection` | その接続の各ページの最後の公開版を zip に。解除したあとも持ち主なら呼べる。写真が欠けた・食い違ったら黙って省かず失敗 |
| `authenticateKey` | 形式・ハッシュ・失効・接続の解除を毎回確かめ、失敗は理由を区別しない `null`。ストアが答えられないときは値を持たない `AuthenticationUnavailable` |

持ち主以外の接続・存在しない接続は、どの操作でも同じ `not_found`。鍵の平文は作成・再発行の結果にしか現れず、ストアには SHA-256 と末尾 4 文字だけを渡す。

| ポート | 役目 |
| --- | --- |
| `ConnectionStore` / `ConnectionTx` | 接続・鍵。`PublishTx` を含み、公開・公開版と同じトランザクションで扱う |
| `RandomSource` | 乱数（既定は Web Crypto の `getRandomValues`） |
| `DraftFingerprints` | 「更新あり」の判定に使う下書きの fingerprint |
| `AssetBytes` | 書き出しで写真のバイト列を読む |
| `Clock` | 時刻（#39 と共通） |

## 持たないもの

Postgres の実装、HTTP の経路、宣言の取得、NIHO からの役割の読み取り、WordPress・Ghost への送信、鍵を表示する画面、シートの React 実装。

`test-support/memory-store.ts` はテスト用のメモリ実装で、本番では使わない。`test-support/reference-world.ts` はメモリストアの状態を契約の参照モデル（`ReferenceWorld`）に写すテスト用の関数。

```sh
npm ci
npm run check   # typecheck + tests
```
