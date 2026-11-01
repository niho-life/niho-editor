# 公開境界とゼロトラスト契約

2026-10-20 時点の公開方針。NIHO Docs と NIHO Photo の公開クライアントは、ソース・配布物・通信・API contract が攻撃者に知られ、改変できることを前提にする。公開は利用許諾を意味しない。

## 公開するもの

原則として、次は公開リポジトリで開発・検証する。

- Docs / Photo クライアント、共通 UI / Core、ローカル保存とクラウド共有のクライアント
- OAuth 2.1 / Authorization Code + PKCE のクライアント、client ID、公開 endpoint
- クラウド共有の状態機械、型、エラー分類、mock、合成データを使う contract test
- build / test / lint、secretless で fork-safe な CI、SBOM、固定 SHA 取り込み契約
- NIHO が権利を持つアイコン・画像・テンプレート等の資産

クライアントは表示や操作を制御できても、認証・認可の最終判断をしない。endpoint を隠すこと、難読化、client 側の role 判定、推測しにくい ID だけを防御として扱わない。

## 非公開に残すもの

非公開にする範囲は、秘密・実データ・最終権限・運用詳細に限定する。

- client secret、署名鍵、service account、storage credential、runtime token
- ユーザー文書・写真・共有データ・PII・実ログ・監査記録
- 認証 / 認可の最終判定、API 実装、DB、object storage、鍵管理
- 内部ネットワーク、管理者専用 route、運用上の回避経路
- 正確な abuse / rate-limit 閾値、検知ルール、未修正脆弱性、incident 詳細
- signing / notarization / deploy / production release の権限と実処理
- 権利関係を確認できない第三者資産

「非公開だから安全」とは扱わない。サーバーは公開された client と契約を前提に、毎 request で認証・認可する。

## 攻撃者モデルとサーバー要件

攻撃者は、公開ソース・配布バイナリ・endpoint・request / response を知り、正規アカウントと token を持ち、client を改変し、object ID や share ID を観測・推測・再送できる。

private API は少なくとも次を強制する。

- token の issuer / audience / expiry / signature と、user / tenant / workspace / resource の所有権・操作権限を毎 request 検証する。
- request の actor / owner / role / quota / MIME / size / object key を信用せず、object ID を知るだけではアクセスさせない。
- upload / download capability は短命・用途限定・resource 限定にする。永続 storage credential を client へ渡さない。
- MIME 宣言だけに頼らず、magic bytes・size・checksum・quota を検証する。
- idempotency と nonce または同等手段で replay と重複処理を制御する。失効済み capability や share は拒否する。
- rate limit・abuse 検知・監査・強制失効を server-side で行う。
- 管理者 API を public client contract に混ぜず、error から内部構成・他 tenant の存在・秘密を漏らさない。

公開 test は合成データだけを使う。versioned contract の test-only reference model は負例と期待 error を確認するもので、production API の実装でも server-side authorization の証明でもない。

## Docs / Photo 共通 contract

Docs / Photo 共通クラウド contract の正本と変更責任者は `niho-docs` の [`packages/niho-cloud-contract`](../../packages/niho-cloud-contract/) とする。初版は version `1`。型・操作・error code・adversarial test vector を同じ version の下で管理し、Photo 側の利用 PR はこの正本の commit SHA を固定する。

contract の更新には次を必須にする。

1. 正本側で versioned contract test を通す。
2. Photo 側にも同じ SHA を取り込む PR を用意し、その CI を通す。
3. 両方の PR に相互リンクを付け、両側の review を終えてから merge する。
4. 互換性を壊す変更は新しい major version とし、旧版の利用期間と移行条件を明記する。

contract は認証 context、resource owner / tenant / workspace、upload / download / share / revoke / list、capability の scope / expiry / 再利用条件、idempotency、content 検証、error 分類を含める。秘密、実データ、内部 topology、正確な abuse 閾値は含めない。現在の version 1 は [`cloud-contract-v1.md`](cloud-contract-v1.md) を参照する。

## editor.niho.life（NIHO editor）の API

`apps/editor-web`（[設計](../architecture/editor-niho-life-design.md)、[配備](../ops/editor-deploy.md)）は、ページを書く Web と、その保存の API を持つ。Docs / Photo のクラウド contract とは別の面で、ここに範囲を決める。

**公開リポジトリに置くもの**
- Web のクライアントと、`/api/pages`（一覧・作成・取得・保存）の実装。owner で絞った保存と読み戻しだけで、秘密・実データ・最終権限を含まない。
- ページの正本の migration（`packages/editor-store/migrations`）。実レコードを含まない。
- 公開 API（NIHO Experience・NIHO・本人のサイトへ公開した版を渡す API、[設計 §9](../architecture/editor-niho-life-design.md)）の**契約**と、合成データでの contract test。鍵・プレビュー用トークンの実値は契約に含めない。
- セキュリティヘッダー（CSP・HSTS・`noindex`）と、その検証。

**非公開に残すもの**
- 本番の `DATABASE_URL`・DB の中身・資産バケットの中身・署名の資格情報（Secret Manager と実行 ID の権限）。
- 配備の設定（プロジェクト ID・バケット名など、本番を特定する値）と本番配備の実行権限。公開 CI から本番へは配備しない（[editor-deploy.md §7](../ops/editor-deploy.md)）。
- NIHO ログインの最終判定（セッションの検証・役割の読み取り）。`niho` モードの実装は非公開の niho-app の契約に従い、それまでは fail-closed（いつも未認証）。
- 公開 API の鍵・プレビュー用トークンの実値、実ユーザーのページ・音声・文字起こし。

**サーバーが毎 request で強制すること**（クライアントを信用しない）
- 全てのクエリを `owner` と `deleted_at IS NULL` で絞る。別の人のページ・存在しない id・UUID として不正な id は、本文もヘッダーも同じ 404 にして、存在を推測させない。
- 本番は `EDITOR_AUTH_MODE=niho` でなければ起動しない（開発用の `stub` に落ちない）。未認証は 401。
- 認証を使わない画面は共有リンク `/s/{token}`（#34）だけ。256 bit の乱数の token が共有中・ゴミ箱でないページに一致したときだけ、最新の保存版の題名と本文を返す。形の違う・未共有・止めた・作り直す前の token は同じ 404。`Cache-Control: private, no-store`・`Referrer-Policy: no-referrer`。
- 更新系は同一 origin の要求だけ受ける。本文は上限（1 MiB）と深さで拒む。エラーの本文は短い code だけで、内部構成を漏らさない。
- アプリ用の DB ロールは DML だけで、スキーマの変更と migration の記録の書き換えはできない。
- 全ての応答に `X-Robots-Tag: noindex, nofollow`。ページは nonce ベースの CSP で、`/api` は何も読み込まない CSP。

## editor 公開 API contract

editor.niho.life の公開版を発信先（NIHO Experience、NIHO、本人のサイト）が読む API の正本は [`packages/editor-publish-contract`](../../packages/editor-publish-contract/) で、外部 observable behavior は [`editor-publish-api-v1.md`](editor-publish-api-v1.md) に置く。型・検証器・Markdown の投影・参照モデル・負例を同じ version の下で管理し、認可の最終判断と鍵の保管はサーバー側で行う。互換性を壊す変更は新しい major version とする。

## 本人の写真ライブラリ v1（Epic #148）

2026-11-01追記。本人専用の写真保存は、上の共通共有contractと別に [`packages/photo-library-contract`](../../packages/photo-library-contract/) を正本とする。[設計・実装先・writer境界](../architecture/personal-photo-library.md) に従い、次のowner-scoped処理はNIHO editor側の公開実装に含めてよい。この節は「API実装を非公開に残す」原則に対する明示した例外で、P00自体は型とfixtureだけを追加する。

- `/api/photo/v1/*` のhandler、個人写真のDB schema/migration、容量予約/CAS/状態機械、storage接続口、media/purge workerのコードと合成データの検証。
- 本人の認証済みcontextを受け取った後のowner絞り込み、原本のgeneration固定、quotaとcontent検証、trash/purgeの一般的なアルゴリズム。公開コードにも毎requestの認証・所有権検証を必須にする。
- 写真のWeb/PWAとAPI adapter、niho-photo SDKのpublic releaseのSHA/hash採用記録。本人用のUIを拠点IDの読み替えで作らない。

非公開に残すのは、NIHO本人確認と失効・退会イベントの最終接続、実token/鍵、DB/storage/workerの実行権限と実値、ユーザーの原本・EXIF・mask・recipe・実ログ、backupの実設定、本番配備と署名の権限。公開fixtureは合成metadataだけとし、HEIC/RAWの成功fixtureを本番decoderの受入証跡にしない。

本人の写真を公開するshare APIはv1に含めない。既存の文書共有リンクや拠点共有APIへ転送しない。privateな認証接続が完成するまでfail-closedを維持し、公開CIは本番データ・秘密・実運用endpointに触れない。写真APIの公開・mergeと、利用者向け有効化・配布は別のgateで判定する。

## CI と成果物

公開 CI は標準 GitHub-hosted runner で動かし、fork の PR に secrets を渡さない。`pull_request_target` で未信頼コードを実行しない。permissions は必要最小限にし、契約の負例を合成データで検証する。

source map、artifact、log、fixture には secret、PII、private endpoint、内部 topology を含めない。公開 SHA を private 側へ固定して取り込むときは、対象 commit と source hash を記録し、private の契約検査・受入を通す。`niho-app` の実装・Actions・PR はこの公開 repo の変更対象にしない。

## 脆弱性報告

未修正脆弱性や exploit 詳細を public issue / PR に書かない。報告者には GitHub の private vulnerability reporting を使ってもらい、利用できない場合は技術詳細を公開せず、private な連絡方法を maintainer に問い合わせてもらう。利用者向け手順は [`SECURITY.md`](../../SECURITY.md) に記載する。
