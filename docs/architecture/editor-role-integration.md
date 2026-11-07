# NIHOの役割・記事連携をEditorへ接続する契約

2026-11-03。対象: Editor #42、NIHO app #19459 / #19460 / #19462 / #19479、Experience #254 / #255。ページの作成・同期・文字起こしは、記事公開の役割がなくても利用できる。

## 正本と認証

ページ・本文・画像・下書き・版・公開操作はEditorクラウド、現在のライター権限と記事連携の同意はNIHO、現在の提供者OWNER・公開体験・カテゴリはExperience Storeが所有する。記事ライターは商品・予約・顧客・売上の操作権限を持たない。

NIHO用の接続はEditor専用cookieからserver-onlyで取得する。同じ要求の現在sessionと本人・接続ID・期限を照合し、資格をSession DTOやブラウザへ返さない。Photoのcookie・旧接続・自己申告roleを代用しない。

| NIHOの固定path（`/api/auth/experience-editor-connect`配下） | 契約 |
| --- | --- |
| `GET /roles` | `{version:1, roles:["writer"]|[], destinations:["exp"]|[]}` |
| `GET /article-links` | `{items:[ArticleLinkDto]}` |
| `POST /article-links/{id}/accept`、`/decline` | 空JSONを送り、現在の`ArticleLinkDto`を返す |

`ArticleLinkDto`は招待UUID、状態、提供者名、招待者名、ライター表示名と短い補助ラベル、期限・受諾・作成時刻だけを持つ。メール・NIHO user ID・tokenを含めない。現在のAPI版が不明、失効、依存障害なら許可へ倒さない。

役割は発信先の接続表示、公開操作、プレビューtoken発行時に読み直し、永続保存しない。今回のExperience連携で確定した役割は`writer`だけで、鎌倉の人・住民等を所属から推測しない。NIHOカード #19480 と niho.life/article #19481 は別の範囲である。

本人情報と発信先は分ける。左下と設定には現在のsessionの本人名を表示し、`/account`は本人情報だけを扱う。Experienceは発信先の一つで、未招待・未承諾・writerなしは正常な「未接続」、利用可能なら「接続済み」とする。取得失敗だけを確認エラーにし、任意の提供者との連携が読めないことを、確認済みの発信先の未接続や権限喪失として扱わない。招待操作は発信先詳細に置く。

表示名を持たない旧sessionは、本人情報の更新から同じNIHOアカウントへ接続し直せる。`sameAccount=1`の開始時に現在actorを確認し、短命のpending cookieへstateとactorのhashを結ぶ。callbackで別actorになった場合は新しい未使用接続だけを失効させ、元のsessionと原稿の所有者を維持する。表示名はこの確認後のNIHO exchangeから読み、認可には用いない。

## 公開条件と現在性

Experienceの現在activeカテゴリと、本人OWNERまたは現在承諾済み連携先の公開中体験をserver-only APIから取得する。公開時には同じ事実を再確認し、停止済みカテゴリ・未承諾・取消済み・OWNER変更・writer解除を古い宣言や画面の選択で許可しない。

カテゴリslugはv1の文字列のまま、英日表示名・表示順・revisionをサーバーの現在カテゴリから公開版へ固定する。カテゴリ停止後も過去の公開版はその表示名を保持する。最新のowner決定により、Experience向けもカバー写真とリードは任意。設定した値の形式・長さ・許諾は検証する。

Experienceの`/write?experience={slug}`は固定Editorの`/p/new?destination=exp&lang=en&experience={slug}`へ移動する。許可した文脈だけをログイン後も保ち、新しい私的ページへ着地させる。slugとroleはヒントで、GETでは公開しない。

Experience runtimeだけがGoogleサービスID tokenで`POST /internal/article-authority/v1/publication`を呼べる。現在expへ公開中の同じ版からだけ、内部の著者IDと関連slugを返す。本人token・Photo資格・公開APIの面の資格では呼べず、通常の公開APIへIDを追加しない。公開写真も現在の公開版・画像状態・許諾を確認し、未公開写真を一般公開しない。

## 配備

追加契約のsourceと本番稼働は区別する。NIHO追加APIを先にレビュー・マージ・配備し、次にEditorとExperienceを固定SHAで配備する。実値はignored `deploy.env`とSecret Managerだけに置く。新機能は既定OFF。

- `EDITOR_EXPERIENCE_ARTICLE_AUTHORITY_ENABLED`、固定Experience origin/audienceで候補・現在性の確認を開く。公式配備は同じoriginの公開条件宣言を設定する。
- `EDITOR_ARTICLE_AUTHORITY_API_ENABLED`、固定audienceとExperience runtimeの許可サービスアカウントで公開版authorityを開く。
- `EDITOR_FACE_CREDENTIALS_SECRET_REF`はownerが作成した公開APIの検証情報の固定Secret版。生tokenを設定ファイルへ書かない。Secretの値の投入はAGENTSのowner専用手順を使う。
- 設定の検査とCloud Runへの受渡しは`editor-deploy/lib.sh`が担う。flag OFFへ戻す際も公開版・同意履歴を削除しない。

対象の合成テストで、別用途・別本人・失効・未知版・上流障害、カテゴリ停止、関連権限の取消、手渡し文脈、操作後の再取得を確認する。owner指示により画面受入と実機操作は省略する。
