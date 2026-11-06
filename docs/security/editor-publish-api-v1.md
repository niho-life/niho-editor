# editor 公開 API contract v1

この仕様の機械可読な型・検証・負例は [`packages/editor-publish-contract`](../../packages/editor-publish-contract/) が正本です。ここでは v1 の外部 observable behavior と、サーバーが守る義務を定めます。API の実装、DB、鍵の保管、認可の最終判断は公開 contract に含めません（[publication-gates.md](publication-gates.md)）。設計の正本は [editor-niho-life-design.md](../architecture/editor-niho-life-design.md) §8・§9、Issue は #40 です。

発信先の面（NIHO Experience、NIHO、本人のサイト）は、同じ 3 本の読み取り API だけで公開版を描画します。Webhook は持たず、発信先が一定間隔で一覧を読みます。

## 用語

| 語 | 意味 |
| --- | --- |
| 発信先（dest） | `exp`（NIHO Experience）、`niho`（NIHO）、`site`（本人のサイト） |
| 面（face） | NIHO が運営する発信先（`exp`、`niho`）。サービス間認証で読む |
| 接続（connection） | 本人のサイトを発信先にした設定。接続ごとに `handle` と鍵を持つ |
| handle | 読み取り先の識別子。面は予約語 `exp` / `niho`。本人のサイトは接続を作るときに決まり、変えられない |
| 公開版（snapshot） | 公開した時点の不変のスナップショット。下書きの編集は公開版に触れない |

`handle` の形は `^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$`（3〜32 文字）。`exp`、`niho`、`preview`、`v1`、`api`、`admin`、`editor` は本人の接続には使えない。

## 呼び出し元と認証

読み取りは常に認証が要ります。認証 context はサーバーが検証して作り、request の `handle` や body は権限の根拠にしません。

| 呼び出し元 | 資格 | サーバーが確定するもの |
| --- | --- | --- |
| 本人のサイト | `Authorization: Bearer ek_…`（接続ごとの鍵） | 鍵が属する接続の `handle`。他の `handle` は読めない |
| NIHO の面 | `Authorization: Bearer <サービス間の token>` | 検証済み token の audience から面（`exp` / `niho`）。他の面の `handle` は読めない |
| プレビュー | 上のどちらか＋パスの `pv_…` token | token が拘束する page・dest・期限 |

- 鍵は `ek_` ＋ 43 文字の base64url（256 bit のランダム）。作成・再発行の response だけに平文を返し、サーバーは SHA-256 のハッシュだけを保存する。一覧と設定画面には `ek_••••••••` ＋末尾 4 文字しか出さない。
- 鍵の再発行・接続の解除・失効は、次の request から有効になる（鍵の結果をキャッシュしない）。失効した鍵・旧鍵は `unauthenticated`。
- プレビュー token は `pv_` ＋ 43 文字の base64url。本人の操作でだけ発行し、有効期限は発行から 15 分以内、1 つの page・1 つの dest・1 つの下書きの時点に拘束する。token だけでは読めず、token が拘束する dest の資格も同時に必要（token が漏れても別の発信先からは読めない）。

## Endpoints

prefix は `https://api.editor.niho.life`。メソッドは `GET` と `HEAD` だけ。

| Path | 返すもの |
| --- | --- |
| `/v1/{handle}/published.json?limit=&cursor=&include=` | 公開中の一覧（`PublishedIndex`） |
| `/v1/{handle}/published/{id}.json` | 公開版 1 件（`PublishedDoc`）。`id` は page の UUID |
| `/v1/preview/{token}.json` | 下書き 1 件（`PreviewDoc`）。`PublishedDoc` ＋ `preview` |

### 一覧

- 本体は `{ contractVersion, items, nextCursor }`（次がなければ `nextCursor` は `null`）。並びは `updatedAt` の新しい順、同時刻は `id` の昇順。`limit` は 1〜100（既定 50）、`cursor` は不透明な文字列。
- 載るのは、その `handle` の発信先に、範囲が `live` で公開中のものだけ。公開をやめたもの・自分だけのページ・下書き・他の発信先に公開したものは載らない。
- 範囲が `unlisted`（限定公開、NIHO の面だけ）は載らない。面は `include=unlisted` を付けると載せられる。本人のサイトが `include` を付けたら `invalid_request`。
- `include` に未知の値を渡したら `invalid_request`。

### 公開版

- 認証済みで、その `handle` の発信先に公開中の `id` なら 200。`unlisted` は面の資格でだけ読める。
- 公開をやめた `id` は **410 `gone`**（その `handle` を読める資格がある呼び出し元だけ）。再公開すると同じ `id`・同じ URL で再び 200。
- NIHO の面から別の NIHO の面へ発信先を変えた公開版は、元の面の資格で読むと 410 `gone` に `movedTo`（`{ dest, canonicalUrl }`）を添える。元の面は旧 URL から新 URL へ転送できる。公開をやめたとき、本人のサイトへ・から移したときは `movedTo` を付けない（元の面は一覧へ転送する）。本人のサイトの資格には `movedTo` を返さない。
- 下書き・自分だけ・存在しない・他の発信先・他人の `id`、資格のない `handle` は、すべて同じ **404 `not_found`**（本文もヘッダーも同一。存在を推測させない）。

### プレビュー

- 下書きの**現在の内容**を読む。token は page と handle（本人のサイトは接続）と発行した本人の著者に拘束し、下書きの版には拘束しない（自動保存で内容が変わっても、同じ token で読み直せる）。`preview` に `{ expiresAt, dest, noindex: true }` を持つ。公開前の下書きには公開日時がないので、`publishedAt`・`updatedAt` は下書きの保存時刻、`version` は下書きの版。
- 期限切れ・未知・形の不正・15 分を超える有効期限・別の dest の資格で読んだ token は、すべて同じ 404（サービス間の token や鍵の期限切れは、プレビューに限らず 401）。
- `author` は token を発行したときの本人の著者（読み取りの要求には本人がいないので、発行のときに token に結ぶ）。token に著者が無ければ、そのページのいまの公開版の著者。どちらも無ければ組めないので 404。
- 発信先は `noindex` のページとして描画する。見え方の正本は発信先側にある。

## 本文

- 本文は `blocks`（限定 AST）と `markdown`（安全な Markdown の部分集合）の両方を返す。AST が正本、Markdown は投影。サーバーは `renderMarkdown(blocks, assets)` で投影する。検証器は既定では `markdown` が部分集合に収まることだけを確かめる（古い投影で保存した公開版を、新しい版の destination が読めなくならないように）。サーバーが返す直前の自己検証では `requireProjection` で投影との完全一致も確かめる。
- **AST**：`paragraph`、`heading`（2・3）、`list`（箇条書き・番号付き、入れ子なし）、`quote`、`figure`（画像）、`divider`、`note`（囲み）。インライン：`text`（`bold`・`italic`・`strike`・`code`・`link` の mark を持てる）と `confirm`（未確認の印）。HTML は含まない。未知のブロック・mark は拒否する（描画せずに通さない）。
- **リンク**は `https` の URL、またはサイト内の `/` から始まるパスだけ。資格情報つきの URL、`http:`・`mailto:`・`javascript:`・`data:`・`//host` は拒否する。
- **画像**は `figure` が `assetId` を参照し、`assets` の `url`（editor の資産置き場から配信する `https` の URL）、`contentType`、`bytes`、`sha256`、`alt`、`credit` を持つ。本人のサイトは取り込むときに複製し、`sha256` で確かめる。録音の資産は公開版に含めない。
- **Markdown** は niho-experience の `guide-markdown` が受ける範囲に限る：`##` `###`、段落、`-` / `1.` の箇条書き（入れ子なし）、独立した行の `![alt](src "caption")`、`:::note` … `:::`、インラインの `**` `*` `[text](href)` `[CONFIRM: …]`、句読点の `\` エスケープ。HTML・`_`・`` ` ``・`~~`・引用・区切り線は出さない。AST の `quote` は段落に、`divider` は省き、`strike`・`code` は素のテキストにして Markdown に投影する（AST は変えない）。発信先が「引用を受けない」などを宣言していれば、editor は公開の前に止める（#39）。
- 上限：1 つのブロックの文字数 20,000、ブロック数 2,000、公開版全体（正規化した JSON）1 MiB。

## 一覧の項目と公開版

```
PublishedListItem
  id, slug, dest, lang, title, lead|null, cover|null, category|null,
  coverShareable?: true                    ← 任意。カバーを共有画像（OG 画像・Article.image）にも使ってよいときだけ
  author { name, handle|null, url|null }   ← 公開した時点のスナップショット
  authorProfile?: { role|null, bio|null }  ← 任意。公開した時点の著者紹介（肩書・紹介文）
  range: live | unlisted
  version, publishedAt, updatedAt          ← updatedAt は「いまの公開版を公開した時刻」。下書きの編集は反映しない
  canonicalUrl, extras { app, news, xp }, related: ExperienceSlug[]
PublishedDoc = PublishedListItem + { blocks, markdown, assets, contractVersion }
```

発信先の面は、公開版を受け取るときに自分で再確認する（体験が掲載中か、連携が有効か。[設計](../architecture/editor-niho-life-design.md) §10）。API の `related` は申告であり認可の根拠にならない。

任意の項目（値があるときだけ出す。無い公開版の応答・`ETag` は前と同じ）：

- `coverShareable`：`true` だけ。著者がカバーに「掲載許諾」と「共有画像にも使ってよい許諾」の両方を付けたときだけ出る。無ければ、発信先はカバーをページの中には載せてよいが、OG 画像・`Article.image` など共有画像には使わない。`cover` が `null` なのに出ていれば拒否する。
- `authorProfile`：`{ role, bio }`（欄はこの 2 つだけ。どちらも `null` か空でない 1 行で、肩書は 120 字・紹介文は 600 字まで。両方 `null` は拒否）。`author` と同じく公開した時点の値で、あとで設定を変えても公開版は変わらない。プレビューには出ない。
- どちらも**トップレベル**に置き、`cover`（`PublishedAsset`）や `author` の中には入れない。入れ子のオブジェクトは厳密（未知のキーは拒否）なので、中に足すとこの項目を知らない古い版の検証器が応答ごと拒否する。トップレベルの未知の項目は古い検証器が無視して落とすので、古い発信先はそのまま読める。

## キャッシュと条件つき request

- 200 は強い `ETag`（正規化した JSON の SHA-256）を返す。`If-None-Match` が一致したら 304（本文なし、`ETag` つき）。複数値と `*` を受ける。
- **認証が先**：失効した鍵・旧鍵・資格のない `handle` は、`If-None-Match` が一致しても 304 にしない。
- `Cache-Control: private, no-cache`（毎回再検証）、`Vary: Authorization`。プレビューは `Cache-Control: no-store`。
- 全 response に `X-Robots-Tag: noindex`、`Content-Type: application/json; charset=utf-8`。

## エラー

body は `{ "error": { "code", "requestId", "retryable" } }`。410 の `gone` だけ、上の条件で `movedTo` を同じ階層に足す。内部の構成・他者の存在・鍵・token は含めない。

| Status | code | 場面 |
| --- | --- | --- |
| 400 | `invalid_request` | 不正な `limit`・`cursor`・`include`・id の形 |
| 401 | `unauthenticated` | 資格なし・失効・旧鍵・期限切れの token（`WWW-Authenticate: Bearer`） |
| 404 | `not_found` | 存在しない／読む資格がない（区別しない） |
| 410 | `gone` | 公開をやめた公開版（資格がある呼び出し元だけ） |
| 429 | `rate_limited` | `Retry-After` を付ける。正確な閾値は公開しない |
| 503 | `temporarily_unavailable` | 再試行してよい |

`403` は使わない。認可の失敗を 404 にして、他者の page の存在を推測させない。

- 判定の順：メソッド → 認証（401）→ `handle` の認可（404）→ query・id の形（400）→ 存在（404／410）→ 304／200。資格のない `handle` は、id の形が不正でも 404。
- `GET` と `HEAD` 以外は 400 `invalid_request`（`Allow: GET, HEAD`）。未知・重複した query、先頭が 0 の `limit` も 400。
- エラー response は `Cache-Control: no-store`。`Vary: Authorization` は 304 を含む全 response に付ける。
- 検証器は迷ったら拒否する：日時は UTC の `Z`、UUID は小文字、URL は印字可能な ASCII（IDN は不可）、画像は avif・gif・jpeg・png・webp（SVG は不可）、`figure` から参照されない asset は不可（カバーは別）。

## サーバーの義務

契約テストは公開の型と合成データで負例を確かめるものです。これは認可の実装でも証明でもありません。サーバーは公開された契約を前提に、毎 request で次を行います。

1. 鍵・token の署名／ハッシュ・失効・期限・拘束（`handle`・dest・page）を検証する。結果をキャッシュして失効を遅らせない。
2. 返すのは公開版のスナップショットだけ。`title`・`lead`・本文・`updatedAt` を現在の下書きから組み立てない。
3. 公開の範囲・公開をやめた状態・接続の解除を毎回判定し、一覧と単体で食い違わせない。
4. `Authorization` と、パスの `pv_` token をログ・メトリクス・エラー報告に残さない。
5. 鍵・token の比較はハッシュで行い、タイミングで一致が分からないようにする。
6. 失敗の本文を `404` で揃え、認可の失敗と不在を区別しない。
7. rate limit・監査・強制失効をサーバー側で行う。

## 契約テスト

`packages/editor-publish-contract/v1/cases.json` は合成データのシナリオと期待結果を列挙します。少なくとも次を検証します。

- 下書き・自分だけのページ・公開をやめたページが一覧から読めない。公開をやめた単体は 410、それ以外は 404。
- 失効した鍵・再発行前の旧鍵・別の接続の鍵・別の面の token で読めない。失効した資格では `If-None-Match` が一致しても 304 にならない。
- 一覧に他の発信先の公開が混ざらない。`unlisted` は面の `include` でだけ載る。
- 面から面へ発信先を変えた公開版の 410 に `movedTo` が付く。公開をやめたとき・本人のサイトの資格・本人のサイトへ移したときは付かない。
- 公開版は下書きの編集に追従しない（直しても `updatedAt` と本文は変わらない）。再公開で同じ `id`・URL に戻る。
- プレビュー token は期限切れ・別の dest の資格・公開用の endpoint では読めない。下書きを編集したあとも同じ token で現在の下書きを読める。
- AST に未知のブロック、`javascript:` のリンク、`http:` の画像、資格情報つき URL があれば拒否する。Markdown は部分集合の外を出さない。

互換性を壊す変更は新しい major version とし、`/v2` を別に用意して、旧版の利用期間と移行条件を明記します。
