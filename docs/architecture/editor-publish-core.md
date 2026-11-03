# editor 公開の実処理：公開のシートと発信先の設定

Issue #39（公開のシート）と #41（発信先の設定）の「実処理」の方針です。画面の見た目は現行モック v7／`packages/docs-ui` の shell（#48）が持ち、ここでは **画面の裏で動く判定と状態遷移** を `packages/editor-publish` に置きます。読み取り API の契約は [editor 公開 API contract v1](../security/editor-publish-api-v1.md)（#40）です。設計は [editor-niho-life-design.md](editor-niho-life-design.md) §8・§9・§10・§12。

## 置き場所と境界

- `packages/editor-publish`（`@niho/editor-publish`）：純粋な TypeScript。DB・HTTP・時計・乱数・資産の置き場は **ポート（interface）** として受け取る。`@niho/editor-publish-contract` にだけ依存する。
- Postgres の実装：表は `editor-store` の migration 0009、SQL は `packages/editor-store/src/publications.ts`、ポートへの adapter は `apps/editor-web/src/publish/pg-store.ts`（`pgPublishStore` は `PublishService` と `ConnectionService` の両方の store）。受入の流れと巻き戻しを、メモリの実装（`test-support/`）と実 PostgreSQL（`pg-store.pg.test.ts`）の両方で確かめる。
- 行ロック：同じページへの公開はページの行で、解除と公開のすれ違いは接続の行で直列にする（`pg-store.ts` の各メソッドのコメント）。
- 鍵の生成・ハッシュ・照合の**コード**は公開してよい。守るのはコードの秘匿ではなく、256 bit の乱数と、ハッシュしか保存しないこと、失効を次の request から効かせること（publication-gates.md の方針）。

## #39 公開のシート

### 発信先の宣言（JSON）

条件は editor にハードコードせず、発信先が宣言する JSON を読む。取得先と更新は配備側（案：`https://{host}/.well-known/niho-editor-destination.json`、ETag で再検証）で、このパッケージは**受け取った JSON の検証と評価**だけをする。

```
DestinationDeclaration
  schemaVersion: 1
  id: "exp" | "niho" | "site"            ← 本人のサイトの宣言は接続の設定から editor が作る（#41）
  label, host, path                      ← URL は https://{host}/{path}/{slug}
  ranges: ("live"|"unlisted")[]          ← 限定公開は NIHO の面だけ
  extras: ("app"|"news"|"xp")[]          ← 「あわせて」で選べるもの
  accepts: { blocks: Block["type"][], marks: Mark["type"][] }
  requires: Condition[]
Condition = { id, message, fix, kind, …kind ごとの引数 }
  kind: lang(equals) | cover(consent) | lead(max?) | category(oneOf?) | headings(min) | noConfirm | relatedLive
  fix : lang | cover | lead | category | body | related     ← 「直す」で開く欄
```

- 語彙は閉じている。**未知の `kind`・未知のフィールド・型の違いは宣言ごと拒否**し、その発信先は「いまは公開できません」になる（無視して公開を通さない＝fail closed）。
- 「関連する体験が掲載中」（`relatedLive`）のような外の事実は、サーバーが `facts` として渡す。`null`（不明）は**満たさない**扱い。

### 公開の前に（評価）

`evaluateReadiness(declaration, facts)` → `{ ready, problems[], notices[] }`。

- どの発信先でも要る条件：題名が空でない、本文に内容がある、`accepts` の外の要素（例：NIHO Experience に引用）がない。
- 発信先の `requires` を順に評価し、満たさないものを `problems`（`id`、一言の `message`、`fix`）に積む。`ready` は `problems` が空のときだけ true。**true になるまで公開ボタンは押せない**。
- `notices` は止めない知らせ：録音のブロックは公開版に含まれない、など。
- 入力は `collectFacts(page, assets, serverFacts)` が作る。評価は純粋関数で、同じ入力に同じ出力。

### URL（slug）

- `slugFromTitle(title, pageId)`：NFKC → 小文字 → 英数字とハイフンだけ → 80 文字まで。英数字が残らない題名（日本語など）は `p-` ＋ページ ID の先頭 8 桁。
- 検証：`^[a-z0-9]+(-[a-z0-9]+)*$`、160 文字以内、予約語（`index` `new` `edit` `preview` `tag` `tags` `category` `categories` `page` `feed` `rss` `sitemap` `api` `admin`）を除く。
- 同じ発信先で使われていれば `-2`, `-3` … を付けて提案する。**初回の公開まで変えられ、公開後は固定**。再公開（公開をやめたあと）は同じ slug・同じ URL。

### 公開版（スナップショット）

`buildSnapshot(…)` が、編集中の本文（TipTap の `content`）から**不変の公開版**を作る。

- 変換：`paragraph`、`heading`（1→2、2→2、3 以降→3）、`bulletList`/`orderedList`（入れ子は同じ階層に平らにする）、`blockquote`→`quote`（段落ごと）、`horizontalRule`→`divider`、`image`（`attrs.assetId`・`alt`・`caption`）→`figure`、囲み（`note` / `callout`）→`note`。`hardBreak` は空白。mark は `bold` `italic` `strike` `code` `link` だけ残す（他の書式は落とす）。`[CONFIRM: …]` と書かれたテキストと `confirm` ノードは `confirm` にする。
- **知らないノードは黙って落とさず、公開の前の問題（`fix: body`）にする**。録音は意図して落とし、`notices` に出す。空の段落は落とす。
- 変換後は `markdown` を契約の `renderMarkdown` で作り、最後に契約の `parsePublishedDoc(doc, { requireProjection: true })` で自己検証する。通らなければ公開を失敗にする。
- 公開版は深く freeze し、`fingerprint`（正規化した内容の SHA-256）を持つ。**「更新あり」は「いまの下書きの fingerprint が公開版と違う」こと**で、保存の時刻では決めない（直して元に戻せば「更新あり」でなくなる）。
- 入力の約束：画像ノードは `attrs: { assetId, alt, caption? }`、資産は `{ id, kind, bytes, sha256, contentType, alt, credit, consent }`（#33 の編集がこの形で保存する）。

### 状態と主ボタン

`deriveStatus(publication, draftFingerprint)` は docs-ui の `ShellStatusState` と同じ語を返す：`private`（自分だけ）、`published`、`updated`（更新あり）、`limited`（限定公開）、`stopped`（公開をやめた）。`sheetPlan(…)` はシートの描画に要るものを返す：選べる発信先（役割で出せるもの・接続したサイト・出せない理由）、範囲、あわせて、`problems`、URL、slug を変えられるか、主ボタン（`publish` ＝公開する／`update` ＝更新を公開／`save` ＝設定だけ変えた／なし）、公開をやめられるか。

### 操作とトランザクション

`PublishService` の操作はすべて **1 つのトランザクション**で行い、途中で失敗したら全部元に戻す。**前の公開版と下書きは必ず残る**。

| 操作 | 振る舞い |
| --- | --- |
| `publish` | 役割を NIHO から**毎回読み**（保存しない）、出せない発信先は拒否。宣言を評価して満たさなければ `not_ready`。slug を検証し、公開版（新しい版）を作って公開に切り替える。再公開は同じ URL |
| `update` | 同じ発信先・同じ slug で新しい公開版に入れ替える。`publishedAt` は初回のまま、`updatedAt` が動く。設定だけ変えたときの「保存」も新しい公開版を作る |
| `stop` | 公開版を残したまま公開をやめた状態にする（`stoppedAt`）。NIHO の面は旧 URL を**一覧へ転送**する記録を作る。本人のサイトは転送を約束しない。もう一度呼んでも同じ結果 |
| `changeDestination` | 公開中のページの発信先を変える。**NIHO の面の間は旧 URL → 新 URL の転送を作る**（既存の転送は新 URL へつなぎ直し、鎖を 1 段にする）。面→本人のサイトは旧 URL を一覧へ、本人のサイト→面は旧 URL に何もしない。移し先で条件を再評価し、slug が使われていれば `slug_taken`（新しい URL なので slug を選び直せる） |

転送の記録は `{ from: { dest, slug }, to: { dest, slug } | "list" }`。`resolveRedirect` は鎖を最大 8 段たどり、輪になっていたら一覧とする。面は 410 の `movedTo`（契約）と一覧への転送で旧 URL をさばく。

**保存先**（[設計 §2.1](editor-niho-life-design.md)、Issue #50）：アカウントの保存先を NIHO から操作のたびに読み（`StorageModeReader`、保存しない）、`CLOUD`（未選択の `UNSET` を含む）以外では `publish`・`update`・`changeDestination` を `storage_not_cloud` で断る（知らない値も断る＝fail closed）。`stop` は常にできる。`sheetPlan` は `storageBlock` を返し、主ボタンを押せなくして理由を示す。

結果は `{ ok: true, … } | { ok: false, reason, … }`。`reason`：`not_found`、`forbidden_destination`、`storage_not_cloud`、`not_ready`（`problems` つき）、`slug_locked`、`slug_taken`、`invalid_slug`、`destination_unavailable`、`failed`（再試行できる）。

## #41 発信先の設定

### 接続

- NIHO の面（`exp`、`niho`）は役割で自動で出る。本人のサイトは「発信先を追加」で**接続**を作る：`mode`（公開 API で受け取る／WordPress／Ghost）、`handle`（契約の形と予約語。作ったあと変えられない）、サイトの URL（https）、URL の形（`{host}/{path}/{slug}`）、写真の扱い（取り込み時に複製。v1 は固定）。
- WordPress・Ghost は v1 では入口だけ：`mode` と設定を保存でき、送信は動かさない（`pushEnabled: false`）。公開 API で読まれる経路はどの `mode` でも同じ。
- 本人のサイトの宣言（`requires` なし）は接続の設定から editor が組み立てる。URL の形を変えたら、**次の「更新を公開」から**新しい `canonicalUrl` になる（出した公開版は変えない）。

### 鍵

- `issueKey` / `rotateKey` は平文の鍵を**その response でだけ**返す。保存するのは SHA-256 のハッシュ、末尾 4 文字、作成時刻、失効時刻だけ。
- **`rotateKey` は新しい鍵の作成と旧鍵の失効を同じトランザクションで行う**。失効は次の request から効く。
- `authenticateKey(plaintext)` は、形式が正しい・ハッシュが一致・失効していない・接続が解除されていない、のときだけ接続を返す。それ以外は区別せず `null`。鍵・平文を例外メッセージやログに入れない。

### 接続の解除

`disconnect` は 1 つのトランザクションで、鍵をすべて失効し、接続を解除済みにし、その接続に公開中のページを**すべて公開をやめた状態**にする（ページ自体は残る。転送は作らない）。公開中の一覧は空になり、公開 API は旧鍵・接続の `handle` ともに読めない。

### 書き出し

`buildExportArchive(entries)`：Markdown ＋写真の zip（無圧縮 STORE、依存なし）。ページごとに `{slug}.md`（題名・言語・日時の front matter ＋ 契約の `renderMarkdown`、写真は `photos/{sha256}.{ext}` への相対パス）、写真は `sha256` で重複を省く。パスは `..`・先頭 `/`・制御文字・`\` を持てない（zip-slip を作らない）。サービスの `exportConnection` は、その接続に公開した（公開をやめたものを含む）ページの**最後の公開版**を対象にし、解除したあとでも呼べる。

## 受入との対応

| 受入 | 確かめるテスト |
| --- | --- |
| 条件がそろうまで公開ボタンが押せない | `sheetPlan` の主ボタンが `problems` のあいだ無効。宣言ごとの評価 |
| 公開に失敗しても前の公開版と下書きが残る | ストアの途中で例外を注入し、公開・更新・停止・発信先の変更のすべてで元に戻る |
| 公開をやめた記事の URL が一覧へ転送される（NIHO の面） | `stop` の転送記録と `resolveRedirect` |
| 鍵を再発行すると旧鍵で読めない | `rotateKey` 後に `authenticateKey(旧鍵)` が `null` |
| 接続を解除すると公開中のページは「公開をやめた」になる | `disconnect` 後の `deriveStatus` が `stopped`、一覧が空 |

## まだ無いもの

- HTTP の経路と画面：鍵を表示するコピー／再発行の画面（#41）、プレビューを開く画面。公開のシートは `apps/editor-web`（#39。経路は `src/server/publish-api.ts`、画面は `src/components/PagePublish.tsx`）、公開 API v1 も `apps/editor-web`（#40。`src/public-api/`。プレビューは公開のシートと同じ宣言・写真の置き場・役割を使い、著者は token に結ぶ）。
- シートに出していないもの：公開の知らせ（`notices`）、本人のサイトが 2 つ以上のときの選び方、カテゴリ・関連する体験の欄。
- 宣言の取得（`.well-known` の配備）、NIHO からの役割の読み取り（#42 と niho-app 側）。ポートまでを定義する。
- WordPress・Ghost への送信。
