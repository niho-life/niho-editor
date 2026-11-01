# editor.niho.life の配備

`apps/editor-web` を GCP（Cloud Run・Cloud SQL・GCS）に配備する手順。設計は [editor-niho-life-design.md](../architecture/editor-niho-life-design.md) §13、Issue は #46（土台の実環境）と #44（ドメイン・公開境界）。先例は NIHO finance の配備（同じ本番プロジェクト・同じ共有 Cloud SQL・同じドメインマッピング）。

このリポジトリは公開なので、プロジェクト ID・プロジェクト番号・URL・バケット名は書かない。それらは手元の `scripts/editor-deploy/deploy.env`（`.gitignore` 済み。雛形は [`deploy.env.example`](../../scripts/editor-deploy/deploy.env.example)）に置き、スクリプトが読む。別の場所に置くときは `DEPLOY_ENV=/path/to/deploy.env scripts/editor-deploy/deploy.sh`。

## 1. 構成

| 資源 | 名前（既定） | 内容 |
| --- | --- | --- |
| Cloud Run サービス | `niho-editor` | 画面と `/api/pages`。誰でも呼べる（ログインはアプリの中）。min 0 / max 2、`EDITOR_AUTH_MODE` は `deploy.env` の値（既定 `niho`。§13）。要求の時間切れは 300 秒（AI の提案は 1 回の呼び出し 120 秒まで × 分けた要求の数。§10） |
| Cloud Run ジョブ | `niho-editor-migrate` | 配備のたびに 1 回。migration の適用と、アプリ用ロールの作成・権限付与 |
| Cloud SQL | 既存の共有インスタンスに データベース `niho_editor` | ロール 2 つ: `niho_editor_migrate`（表の所有者。migrate ジョブだけが使う）と `niho_editor_app`（DML だけ。DDL と migration の記録の書き換えは不可） |
| GCS | 資産バケット（private） | 均一なバケットレベルのアクセス、公開アクセス禁止。実行 ID は作成と閲覧だけ（削除・上書き不可） |
| Secret Manager | `niho-editor-database-url`（アプリ）、`niho-editor-migrate-database-url`（migrate）、`niho-editor-anthropic-key`（AI の鍵）、`niho-editor-deepgram-key`（文字起こしの鍵）、`niho-editor-google-oauth-secret`（Google のログインの client secret。§13） | アプリは自分の URL と AI の鍵だけ読める。migrate ジョブは DB の 2 つを読む（アプリ用ロールを作るため）。AI の鍵の版はオーナーが入れる（§10） |
| サービスアカウント | `niho-editor-runner`（画面）、`niho-editor-migrate`（ジョブ） | 別々にして、画面からは表の所有者の資格情報に届かないようにする |
| Artifact Registry | `niho-editor`（Docker） | 配備の image。直近 5 個だけ残す |
| Cloud Build | — | `scripts/editor-deploy/cloudbuild.yaml` で web と migrate の 2 つの image を 1 回で作る |

手順の実行基盤（Cloud Tasks のキュー・OIDC 用のサービスアカウント・Cloud Scheduler の掃除）は §11。

ラベルを付けられる資源は `app=niho-editor` を持つ。Cloud Billing のレポートでラベルに絞ると NIHO アプリと分けて見られる。

接続は finance と同じ。Cloud SQL は private IP だけなので、サービスとジョブは Direct VPC egress（`default` ネットワーク・`private-ranges-only`）に出て、Cloud SQL コネクタの Unix ソケットで接続する。`DATABASE_URL` は `postgresql://<role>:<password>@localhost/niho_editor?host=/cloudsql/<接続名>` の形（`pg` がソケットとして解釈する）。

## 2. 環境変数

| 変数 | 値 | 内容 |
| --- | --- | --- |
| `EDITOR_AUTH_MODE` | `deploy.env` の `EDITOR_AUTH_MODE`（既定 `niho`） | ログインの方式。本番は `niho` か `google` 以外だと起動しない（[apps/editor-web/README.md](../../apps/editor-web/README.md)）。`google` は §13 の一時的な方式 |
| `EDITOR_NIHO_ORIGIN` | `deploy.env` の同名設定 | `niho`のときだけ渡す専用接続先。exact HTTPS originだけを許し、未設定・不正なら配備前とアプリ起動時の両方で止める。実値はgit管理外 |
| `EDITOR_GOOGLE_CLIENT_ID` | `GOOGLE_OAUTH_CLIENT_ID` | `EDITOR_AUTH_MODE=google` のときだけ渡す。OAuth クライアント ID（§13） |
| `EDITOR_GOOGLE_ALLOWED_EMAILS` | `GOOGLE_ALLOWED_EMAILS` | 同上。入れる人のアドレス（コンマ区切り）。空では起動しない |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Secret | 同上。`niho-editor-google-oauth-secret` の最新の版が有効なときだけ渡す（§13） |
| `EDITOR_ORIGIN` | `https://<APP_DOMAIN>` | 更新系の要求の `Origin` 検査。独自ドメインが無いうちは `run.app` の URL。`google` では `/auth/callback` の URL もこれから作る |
| `EDITOR_STORAGE` | `gcs` | 資産の保存先。**毎回渡す**。未設定は本番で `off` の扱いになり、画像と音声の API が 503 `storage_unavailable` を返す（`apps/editor-web/src/storage/config.ts`） |
| `EDITOR_ASSETS_BUCKET` | 資産バケット名 | 画像（#33）と音声（#36）の実体。実行 ID はこのバケットに作成と閲覧だけできる |
| `EDITOR_TRANSCRIBE_ENGINE` | `deepgram` | 文字起こしの**既定の**エンジン。`niho-editor-deepgram-key` に有効な版があるときだけ渡す（§12） |
| `DEEPGRAM_API_KEY` | Secret | 同上 |
| `GEMINI_API_KEY` | Secret | 任意。渡すと **Gemini の案**（#36 段 3b-4）を作れる（既定のエンジンは変わらない）。鍵は `niho-editor-gemini-key` に置く |
| `EDITOR_GEMINI_MODEL` | 任意 | Gemini のモデル。空ならアプリの既定（`gemini-3.8-flash`） |
| `EDITOR_TRANSCRIBE_TIMEOUT_SEC` | `TRANSCRIBE_TIMEOUT_SEC` | 同上。任意。空ならアプリの既定（1200 秒） |
| `EDITOR_TRANSCRIBE_MODE` ほか 3 つ | `TRANSCRIBE_MODE=cloud-tasks` のときだけ | 文字起こしの呼び出し口（キュー・worker の URL・OIDC の身元。§12） |
| `DATABASE_URL` | Secret | アプリ用ロール |
| `ANTHROPIC_API_KEY` | Secret | AI の鍵。`niho-editor-anthropic-key` の最新の版が有効なときだけ渡す（§10） |
| `EDITOR_AI_MODE` | `anthropic` | 同上。版が無ければ渡さない（AI は 503 のまま） |
| `EDITOR_AI_MODEL` | `AI_MODEL`（既定 `claude-sonnet-5-5`） | 同上 |
| `EDITOR_AI_MONTHLY_LIMIT_USD` | `AI_MONTHLY_LIMIT_USD`（既定 `10`） | 同上。1 人・1 か月の上限（見込みの USD） |

手順（#37）の `EDITOR_STEPS_*` は `STEPS_MODE=cloud-tasks` のときだけ足す（§11）。

`EDITOR_AUTH_MODE=google` のときは、許可リスト自体がコンマを含むので、`--set-env-vars` 全体を gcloud の区切り指定の形（`^|^A=1|B=2`）で渡す（`scripts/editor-deploy/lib.sh` の `ENV_SEP`）。値に `|`・空白・`=` が入る設定は `load_deploy_env` が断る。

migrate ジョブには `DATABASE_URL`（migrate ロール）と `EDITOR_APP_DATABASE_URL`（アプリ用ロールの URL。ここからロール名とパスワードを取って作る）が Secret で渡る。

## 3. 初回だけ

`scripts/editor-deploy/gcp-bootstrap.sh resources` が冪等に作る（あるものは飛ばす）。パスワードは生成して Secret に入れ、ファイルにも画面にも出さない。

1. API の有効化
2. サービスアカウント 2 つと `roles/cloudsql.client`
3. Cloud SQL にデータベース `niho_editor` と migrate ロール（アプリ用ロールは migrate ジョブが作る）
4. Secret 6 つと、読める人の限定（AI の鍵・文字起こしの鍵・Gemini の鍵・Google の client secret は版なしで作る。値はオーナーが §10・§12・§13 の手順で入れる）
5. Artifact Registry（直近 5 個だけ残す）
6. 資産バケット（private）
7. 手順の実行基盤（`scripts/editor-deploy/steps-infra.sh`。§11）と文字起こしの実行基盤（`scripts/editor-deploy/transcribe-infra.sh`。§12）

続けて `scripts/editor-deploy/deploy.sh`、そのあと `gcp-bootstrap.sh domain`（§6）。

## 4. 毎回の配備

```sh
scripts/editor-deploy/deploy.sh            # 現在の HEAD を配備する（clean な worktree で）
scripts/editor-deploy/deploy.sh --no-build # いま動いている image のまま配備し直す（Secret の新しい版を読ませる）
```

1. Cloud Build で web と migrate の image を作る（タグは git の SHA）。送るのは `git archive HEAD`、つまり **commit 済みの木だけ**（5MB ほど）。この checkout を送ると `.claude/worktrees/` の別セッションの worktree や手元の build 出力まで入って 3.4 GiB になり、送っている最中にそのファイルが消えて落ちる。`--allow-dirty` のときだけディレクトリを送り、範囲は `.gcloudignore` が決める
2. migrate ジョブを新しい image で実行して終わるまで待つ（失敗したら配備を止める）
3. `niho-editor` を新しい image で配備（env と Secret も毎回渡す）
4. smoke: `/`・`/api/pages`・`/robots.txt` が `X-Robots-Tag: noindex, nofollow` を返すこと、`/api/pages` がセッションなしで 401 を返すこと（`STEPS_MODE=cloud-tasks` なら、`/api/internal/steps/run`・`/sweep` が OIDC トークンなしで 401 を返すことも）

migration は expand → contract（列の削除は配備の 1 つ後）。適用済みのファイルは書き換えない（書き換えると migrate が止まる）。

**新しい migration の名前は自分で決めない。** `npm -C packages/editor-store run new-migration -- <名前>` が
`YYYYMMDDHHMMSS_<名前>.sql` を作る（雛形つき）。連番（`0001`〜）を人が選ぶと並行作業で同じ番号を取り合うため
（実際に #90 と #93 が 0008、#100 と #93 が 0009 で衝突した）。適用は辞書順で、`"0" < "2"` なので
既存の連番がすべて先に走る。**既にある連番のファイルは名前を変えない**（適用済みの名前が記録の主キーで、
変えると未適用に見えるうえ checksum も合わなくなる）。

## 5. `niho`ログインの有効化境界

`niho`モードはNIHO editor専用のopaque browser sessionを使う。`EDITOR_NIHO_ORIGIN`が未設定・不正ならportを開く前に終了し、NIHO側のfeature flagまたは固定callbackが無効ならログイン開始は利用不能のまま閉じる。`stub`へ落とす経路は無い（`NODE_ENV=production`で`EDITOR_AUTH_MODE`が`niho`・`google`以外でも起動しない）。

実origin、NIHO側の固定callback、feature flagは非公開の配備設定へ運用手順に従って投入する。鍵・secret値の投入はAGENTSのオーナー専用手順に従う。設定と実アカウント受入が済むまでは`EDITOR_AUTH_MODE=google`（Googleのサインイン＋許可リスト）を一時的に使える（§13）。`stub`を本番で開ける案は却下した（認証なしの固定ユーザーで、URLを知った誰でも全ページを書ける。noindexはアクセス制御ではない）。

既存のproduction trafficが`google`を使っている間は、そのserviceの環境変数を直接`niho`へ切り替えない。まずtrafficを受けない候補service/revisionを作り、その候補だけのexact callbackをNIHO側へ登録し、同じcanonical IDになるiPhone/Mac往復と失効を受入する。認証transportはv2のform POSTだけを使い、開始・確認・login return・callbackの生成URLへcode/stateを載せない。候補で合成値をPOSTし、応答HTMLのactionと実際のrequest URLに合成値/query/fragmentがないことを確認する。request logのpositive controlと保存結果を照合し、POST本文・Cookie・Authorizationがapp/error/access logへ記録されないことも確認する。旧GET callbackはNIHOモードで拒否する。ログexclusionの有無だけを非保存の根拠とせず、既存production loggingへ広い除外を加えない。実際の応答のCSP・nonce・Referrer-Policy originと、SameSite=Lax Cookie付き同一origin再POSTまで確認する。この証跡とオーナーの切替判断が揃うまで、既存production service/revisionのtraffic・`EDITOR_AUTH_MODE=google`・Google所有者IDを変更しない。

## 6. 独自ドメインと TLS

画面サービスに Cloud Run のドメインマッピングを付ける（証明書は Google が発行・更新。追加費用なし。プレビュー機能なので、止まったときは `run.app` の URL で動く）。

1. ドメインの所有確認（Search Console）が gcloud のアカウントで済んでいること: `gcloud domains list-user-verified`
2. `scripts/editor-deploy/gcp-bootstrap.sh domain` — マッピングを作り、DNS に登録する record を表示する
3. DNS（Cloudflare）に表示された CNAME を **プロキシなし（DNS only）** で登録する
4. 証明書が出るまで待つ（数分〜1 時間）。`https://<APP_DOMAIN>/api/pages` が 401 と `X-Robots-Tag: noindex, nofollow` を返せば通っている

## 7. 本番の起点（公開境界）

[release-boundary.md](../architecture/release-boundary.md) の「公開 CI に本番秘密値・Cloud Run 権限を置かない。公開リポからの push で本番配備を直接起動しない」を守る。

- 公開 CI（[editor-web-ci.yml](../../.github/workflows/editor-web-ci.yml)）は secret なし・合成データ・GitHub-hosted runner で、型検査・テスト・build・image の build までを確かめる。
- 本番への配備は、権限のある gcloud ログインを持つオーナーが手元で `deploy.sh` を実行する。GitHub Actions からは配備しない（OIDC の Workload Identity も作らない）。
- 配備設定（`deploy.env`）は公開リポに置かない。

## 8. コストの見込み

| 項目 | 見込み |
| --- | --- |
| Cloud Run（min 0） | 0 円台。使った分だけ |
| Cloud SQL | 既存インスタンスに同居なので追加の固定費なし。共有なので、負荷が出たら分ける |
| GCS | 保存量しだい（いまは空） |
| Secret Manager（有効な版 6 つまで無料） | 0 円（DB の 2 つと AI の鍵 1 つ） |
| Anthropic API（AI） | 使った分。1 人・1 か月 $10 が上限（§10） |
| Artifact Registry（直近 5 個） | 10 円未満 |
| Cloud Build（1 日 120 分まで無料） | 0 円 |
| Cloud Tasks・Cloud Scheduler（手順。§11） | 月 15 円ほど（Scheduler 1 件） |

## 9. 戻し方

- 配備を戻す: 前の revision へ全トラフィックを戻す（`gcloud run services update-traffic niho-editor --to-revisions <revision>=100`）。DB は expand → contract なので旧版と互換。戻したあとの次のデプロイでは、`deploy.sh` が毎回 `update-traffic --to-latest` で最新の revision へ traffic を向け直す（Cloud Run は割り当てを引き継ぐため、これが無いと smoke が古い revision に通る）。
- サービスを止める: 独自ドメインのマッピングを消せば `run.app` の URL だけが残る。サービスごと止めるなら `gcloud run services delete niho-editor`（DB とバケットは残る）。

## 10. AI（#38）

AI の提案は Anthropic の Messages API（`https://api.anthropic.com/v1/messages`。ホストはコードで固定）を呼ぶ。鍵は Secret Manager の `niho-editor-anthropic-key` に置き、画面の実行 ID（`niho-editor-runner`）だけが読める。**Secret に版が無い、または最新の版が無効なあいだ、AI は閉じたまま**（提案・採用は 503 `ai_unavailable`。使用量の表示は動く）。`deploy.sh` は配備のたびに最新の版（作成が最も新しい版。サービスは `:latest` で読むので、古い有効な版は数えない）の状態を見て、有効なときだけ鍵と AI の環境変数を足す（ログに `AI: on` / `AI: off`）。

**鍵は公開リポジトリ・Issue・PR・チャット・ログ・シェルの履歴に出さない。** 入れる経路は `set-ai-key.sh` だけ（標準入力から読み、画面・ファイル・コマンドラインに出さない。引数では受け付けない）。アプリも鍵・プロンプト・本文をエラーやログに出さない（ログは失敗の種類と HTTP ステータスだけ）。

### 推奨値と理由

| `deploy.env` | 既定（推奨） | 渡る環境変数 | 理由 |
| --- | --- | --- | --- |
| `AI_MODEL` | `claude-sonnet-5-5` | `EDITOR_AI_MODEL` | 文を整える・要約・見出しには十分な品質で、Opus 系の約半額（入力 $2・出力 $10／100 万トークン）。docs-core の単価表にあり、見込み金額が出る |
| `AI_MONTHLY_LIMIT_USD` | `10` | `EDITOR_AI_MONTHLY_LIMIT_USD` | 1 人・1 か月の見込みの上限。数段落の提案は 1 回 $0.01 前後、出力が上限まで出るいちばん悪い 1 回の呼び出し（本文 約 4,000 文字・出力 12,000 トークン）でも約 $0.13 なので、普段使いでは届かず、誤用や暴走は止まる |

会話（AI チャット）はページごとに DB（`ai_conversations`・`ai_messages`・`ai_message_changes`。migration 0022・0025）に残る。残すのは頼んだことと提案の中身・作業の要約（道具とページの名前と成否）・採用や書き換えで残った版の番号だけで、**鍵・プロンプト・モデルへ送った文は残さない**。ページを消せば会話も消える。GCP の追加の資源は無い。

**Mac アプリ（この Mac の CLI）がサーバーへ返す口は 2 つ**（設計 §6.1）。`POST /api/pages/{id}/ai/proposals/device` は**提案として返す**（ページは変わらず、採用のときだけ版に残して保存する＝ブラウザの提案と同じ扱い。差分はサーバーが今の本文から作り、Mac から来た差分は信用しない）。`POST /api/pages/{id}/ai/chat/turns` は**直接書き換える**（チャットと同じ道：作業場の確認 → 版を残す → 保存 → 会話に記録）。どちらもモデルをサーバーで呼ばず、**月の上限には数えない**。

**使用量は経路ごとに分けて数える**（サーバーの API は表 `ai_usage`、この Mac の CLI は表 `ai_usage_device`。**`ai_usage` の形は 0005 のまま変えない** — 主キーを貼り替えると、migration がサービスの入れ替えより先に走るぶん、**まだ動いている古い revision の `ON CONFLICT (owner, month)` が落ちる**。そのため列ではなく表で分けている）。**月の上限（USD）で止めるのは
`server`（サーバーの API）だけ**で、`device`（Mac アプリがこの Mac の CLI で作ったもの。`POST /api/pages/{id}/ai/chat/turns`
で書き戻す）は回数だけ記録し、止めない（利用者のサブスクで従量が出ないため）。`GET /api/ai/usage` の `usage` は
サーバー経路の合計（上限が効く方）で、`device` は別の欄に出る。

**AI に渡す文脈が増えた**（旧 NIHO docs の引き継ぎ）: 「あなたについて」（設定。2,000 字まで）と、**自動参考ページ**
（開いているページと同じフォルダの直下のほかのページ。サブページは入れない）。参考は 1 枚 4,000 字・合わせて 16,000 字まで
入れ、それを超えた分は名前だけにする。**1 回の提案に入る量の目安**は、本文（最大 4,000 字 × 分けた回数）＋ 参考 16,000 字
＋ あなたについて 2,000 字で、日本語なら 1 回の呼び出しで**およそ 2 万〜3 万トークン**（`claude-sonnet-5-5` の入力
$2／100 万トークンで **1 回あたり $0.04〜0.06**）。フォルダが空なら今までどおり（$0.01 前後）。

**チャット（自由入力）は AI がページを直接書き換える**（候補の提案は採用を待つ）。1 回の依頼でモデルと往復するのは 8 回まで・道具は 12 回までで、触れるのは「開いているページ・その親・そのサブページ」だけ（同じフォルダのほかのページは読むだけ）。書く前の本文は必ず版（`ai`）に残り、画面の「元に戻す」で戻せる。1 回の依頼で何度か往復するので、提案 1 回より費用がかかる（往復のたびに上限を見て、上限以上はその場で止める）。**出力の上限で切れた往復の道具は実行しない**（引数が途中で切れた write で本文を欠けさせないため）ので、`EDITOR_AI_MAX_TOKENS`（既定 12,000 トークン）に収まらない長さのページは、チャットでは丸ごと書き換えられない（範囲を分けて頼む。段階の実行器だけは続きを書かせて繋ぐ）。

1 回の提案で送る本文は 30,000 文字まで（超えたら 413 `too_large`。範囲を選んで頼む）で、段落の切れ目で約 4,000 文字ずつに分けて順に呼ぶ。1 回の呼び出しの時間切れ（`EDITOR_AI_TIMEOUT_MS`、既定 120 秒）と出力の上限（`EDITOR_AI_MAX_TOKENS`、既定 12,000 トークン。思考の分を含む）は `deploy.sh` から渡さない（アプリの既定のまま）。Cloud Run の要求の時間切れはそれに合わせて 300 秒。自動の再試行はしない。上流の失敗（401・429・529・5xx・時間切れ）と、使えない応答（JSON でない・出力の上限で途中で切れた）は 502 `ai_failed`。

### 有効にする

1. （初回だけ）`scripts/editor-deploy/gcp-bootstrap.sh resources` — Secret `niho-editor-anthropic-key` を版なしで作り、実行 ID に `roles/secretmanager.secretAccessor` を付ける（既存の資源はそのまま）。
2. Anthropic の Console で、この用途だけの API キーを作る（workspace を分けて使用上限も付けておくと、アプリの上限とは別の歯止めになる）。
3. `scripts/editor-deploy/set-ai-key.sh` — 端末で実行すると、入力を画面に出さずに鍵を求める（貼り付けて Enter）。パスワード管理の CLI から渡すときは `<鍵を出すコマンド> | scripts/editor-deploy/set-ai-key.sh`。空の入力は何もしない。
4. `scripts/editor-deploy/deploy.sh --no-build` — `ANTHROPIC_API_KEY`（Secret の `latest`）と `EDITOR_AI_MODE=anthropic`・`EDITOR_AI_MODEL`・`EDITOR_AI_MONTHLY_LIMIT_USD` が付く。`DATABASE_URL` の Secret はそのまま。
5. 画面で 1 回だけ提案を頼み、設定の使用量が増えることを確かめる。

### 無効にする

1. 有効な版をすべて無効にする: `gcloud secrets versions list niho-editor-anthropic-key --filter='state:ENABLED'` で版を見て、それぞれ `gcloud secrets versions disable <版> --secret niho-editor-anthropic-key`。
2. `scripts/editor-deploy/deploy.sh --no-build` — 最新の版が無効なので、AI の Secret と環境変数を付けずに配備する（`--set-secrets`・`--set-env-vars` は毎回の全量なので、前の revision の分は残らない）。ログに `AI: off`。
3. 1 と 2 の間も、動いているインスタンスは起動の時に読んだ鍵を持っている。すぐ止めたいときは先に Console で鍵を無効にする（以後の提案は 502 `ai_failed`）。

### 鍵を回す

1. Console で新しい鍵を作り、`set-ai-key.sh` で新しい版として足す（`latest` が新しい版になる）。
2. `scripts/editor-deploy/deploy.sh --no-build`（新しい revision が新しい鍵を読む）。提案が通ることを確かめる。
3. 古い版を `gcloud secrets versions disable <古い版> --secret niho-editor-anthropic-key` で無効にし、Console で古い鍵を無効にする。

### 費用の見方

- **0025 が本番の既存の行に触る所は無い**（足すのは新しい表だけ）。戻すときも、足した表を落とせば 0005 の形に戻る。
- 1 人・1 か月（Asia/Tokyo の月）の見込み金額は、画面の設定（`GET /api/ai/usage`）に出る。返ったトークン数 × docs-core の単価表。上限の 80% 以上で一言出し、上限以上はモデルを呼ぶ前に 429 `quota_exceeded`。上限を変えるときは `deploy.env` の `AI_MONTHLY_LIMIT_USD` を変えて `deploy.sh --no-build`。
- 請求の正は Anthropic の Console の使用量と請求。アプリの金額は見込み。応答が届いて使えなかった呼び出し（JSON でない・途中で切れた）の分も数える。HTTP の失敗・時間切れ・通信の失敗はトークン数が返らないので数えない。
- GCP 側の追加は Secret の版 1 つだけ（無料の範囲）。

## 11. 手順の実行基盤（#37）

手順（記事制作・議事録・インサイト整理）の段階を、画面を閉じても進むようにサーバー側で実行する。方式は [editor-steps-execution.md](../architecture/editor-steps-execution.md) の B（§5.2 実行・§5.5 費用）。

**段階は本物の AI（§10 と同じ Anthropic の鍵・モデル・月の上限）で実行する。** 実行器を偽物に戻さないこと（戻すと `[fake]` の印の付いた文書がページに書かれる）。この約束は `apps/editor-web/src/server/steps-deps.test.ts` が守っていて、偽物に差し替えると CI が落ちる。 1 段階 = モデルの 1 往復で、資料は段階 1 が録音ページの本文、それ以降は前の段階の結果（合わせて 24,000 文字まで。超えた分は先頭だけ送る）。作られるのは見出し・段落・箇条書き・囲みだけ。配線は `apps/editor-web/src/server/steps-deps.ts` の 1 か所。
**`EDITOR_AI_MODE` が無効なあいだ、段階は `ai_unavailable` で失敗する**（手順を使うなら §10 の AI も有効にする）。開発と CI の `EDITOR_AI_MODE=fake` では偽物の 1 往復（`[fake]` の印が付く）で、本番では偽物を受け付けない。

### 構成

```text
画面 ── POST /api/pages/{id}/steps/runs ──▶ niho-editor（受付: run を作り、最初の段階を積む）
                                               │ tasks.create（名前 = <run>-<段階>-<世代>。同じ名前は ALREADY_EXISTS ＝積み済み）
                                               ▼
                                  Cloud Tasks キュー niho-editor-steps
                                               │ POST /api/internal/steps/run（OIDC: niho-editor-tasks、audience = run.app の URL）
                                               ▼
                                  niho-editor の内部の route（同じサービス）: claim → 実行 → 確定 → 次の段階を積む

Cloud Scheduler niho-editor-steps-sweep ── 5 分おき POST /api/internal/steps/sweep（同じ OIDC）──▶ niho-editor
    lease の切れた段階は、claim で進んだ世代のまま積み直す（落ちた task の名前は claim の前の世代なのでぶつからない）
    queued のまま残った段階は、世代を 1 つ進めた新しい名前で積み直す（消えた task の名前がふさがっていても拾える）
```

| 資源 | 名前（既定） | 内容 |
| --- | --- | --- |
| Cloud Tasks キュー | `niho-editor-steps` | 最大 5 回・10〜300 秒の間隔で再試行・同時 5 本。1 つの task は最大 30 分（`dispatchDeadline`）。段階の再試行の間隔は 10・20・40 秒（`defaultRetryDelaySeconds`）で、掃除の 5 分より短い |
| サービスアカウント | `niho-editor-tasks`（deploy.env の `TASKS_SA`） | task と掃除の OIDC トークンの身元だけ。**どの資源の権限も持たない** |
| Cloud Scheduler | `niho-editor-steps-sweep` | `*/5 * * * *`（Asia/Tokyo）・試行の期限 300 秒・再試行なし |
| 権限 | 実行 ID（`niho-editor-runner`） | キューへの `roles/cloudtasks.enqueuer` と、`niho-editor-tasks` への `roles/iam.serviceAccountUser`（task に OIDC を付けるため） |

サービスは誰でも呼べる設定のまま（invoker の IAM は使わない）なので、worker の route が自分で Google の ID トークンを検証する（`apps/editor-web/src/server/google-oidc.ts`）: アルゴリズムは RS256 だけ、鍵は Google の JWKS（固定の URL）、`iss` は Google、`aud` は run.app の URL と完全一致、期限は時計のずれ 60 秒まで、`email` は `niho-editor-tasks` と完全一致かつ確認済み。通らない要求は本文を読まずに 401、`Origin` の付いた要求（ブラウザ）は 403。キュー・サービスアカウント・Scheduler のジョブはラベルを付けられない（費用は §8 のとおり小さい）。

`deploy.sh` が足す環境変数（`STEPS_MODE=cloud-tasks` のときだけ。3 つが揃い形が正しいときだけアプリは手順を開く。欠ければ手順の開始は 503、worker の route は 404）:

| 変数 | 値 |
| --- | --- |
| `EDITOR_STEPS_MODE` | `cloud-tasks` |
| `EDITOR_STEPS_QUEUE` | `projects/<project>/locations/<region>/queues/niho-editor-steps` |
| `EDITOR_STEPS_WORKER_URL` | サービスの run.app の URL（独自ドメインではない。OIDC の audience にも使う） |
| `EDITOR_STEPS_INVOKER_SA` | `niho-editor-tasks@<project>.iam.gserviceaccount.com` |

### 有効にする

1. `scripts/editor-deploy/gcp-bootstrap.sh resources`（中で `steps-infra.sh` を呼ぶ。`scripts/editor-deploy/steps-infra.sh` だけでもよい）: API・キュー・サービスアカウント・権限・Scheduler を冪等に作る（あるものは更新）。Scheduler は作った時から 5 分おきに呼ぶが、次の 2 つが済むまでは worker の route が 404 を返す（ジョブの失敗として残るだけで、再試行しない）。
2. `deploy.env` に `STEPS_MODE=cloud-tasks`
3. `scripts/editor-deploy/deploy.sh`（コードが同じなら `--no-build`）: 環境変数を足し、smoke で worker の route が OIDC トークンなしで 401 を返すことを確かめる。

### 無効にする

1. `deploy.env` の `STEPS_MODE` を空にして `deploy.sh --no-build`（手順の開始は 503、worker の route は 404 になる）。
2. 掃除を止める: `gcloud scheduler jobs pause niho-editor-steps-sweep --location <region>`（戻すときは `resume`）。`steps-infra.sh` を流し直しても、止めた状態は保たれる。
3. 積まれている task を止めるなら `gcloud tasks queues pause niho-editor-steps --location <region>`（任意。止めなくても worker の route が 404 を返し、5 回の試行で消える。段階は queued のまま残り、有効にし直すと掃除が拾う）。

### 費用

| 項目 | 見込み |
| --- | --- |
| Cloud Tasks | 月 100 万回まで無料。1 つの段階で 1 回（再試行・掃除の積み直しも 1 回）。無料の範囲 |
| Cloud Scheduler | ジョブ 1 件で月 15 円ほど |
| Cloud Run | 5 分おきの掃除で、使われていなくても 1 日 288 回起こす。1 回は DB の問い合わせ 2 つで短いので、無料の範囲 |

### 失敗の見方

- **Cloud Tasks のキュー**（コンソールの Cloud Tasks → `niho-editor-steps`）: 積まれている数と試行の回数。worker の route が 200 以外を返した task は 5 回まで試され、その後消える。段階は queued のまま残り、**次の掃除（5 分以内）がそのまま拾い直す**。**Cloud Tasks は消した task の名前を最大 24 時間使わせない**ので、掃除は積む前に段階の世代を 1 つ進め、前の task とは別の名前（`<run>-<段階>-<世代>`）で積む（`requeueAttempt`）。同じ名前で積み直すと、消えた task と積まれたままの task を `ALREADY_EXISTS` で区別できず、その段階が 24 時間止まってしまうため。まだ積まれている task と重なったときは同じ段階の task が 2 つになるが、先に届いた方だけが claim でき、後の方は何もせず終わる（二重には実行されない）。
- **Cloud Run のログ**（短い code だけ。トークン・本文・クレームの値は出さない）:
  - `editor-web: worker request refused`: 検証に通らなかった（`code` は `missing_token`・`bad_audience`・`bad_email`・`expired`・`bad_signature`・`jwks_unavailable` など）。Scheduler・Cloud Tasks からの要求でこれが出るなら、`EDITOR_STEPS_WORKER_URL` と `--oidc-token-audience`、`TASKS_SA` の食い違いを疑う。
  - `editor-web: request failed`（500）: `code` は `tasks_http_<status>`（Cloud Tasks の拒否。403 なら実行 ID の権限）・`tasks_token_*`（メタデータサーバー）・DB の code。Cloud Tasks が同じ task を再試行する。
  - `editor-web: sweep could not requeue every step`: 掃除の積み直しの一部が失敗した（次の回でまた拾う）。
  - `editor-web: sweep read only the oldest queued steps`: queued の段階が 1,000 件を超えて残っている（掃除は古い順に 100 件ずつ 10 回まで読む）。Cloud Tasks のキューが止まっていないか（`gcloud tasks queues describe`）を見る。
- **段階の失敗の理由**: 帯（`GET /api/pages/{id}/steps` の `errorCode`）。`lease_expired` は実行中に worker が落ちて lease が切れたもの。AI の分は次のとおり（再試行するものは Cloud Tasks が自動で、しないものはその段階で失敗にする）:
  - 再試行しない: `ai_unavailable`（`EDITOR_AI_MODE` が無効・鍵が無い）・`quota_exceeded`（今月の上限に達した。モデルを呼ぶ前に止めた）・`ai_auth`（鍵が通らない。401・402・403）・`ai_bad_request`・`invalid_output`（答えが使える形でなかった）・`output_too_long`（出力の上限で切れ、続きを 8 回頼んでも終わらなかった）・`unknown_step`
  - 再試行する: `ai_rate_limit`（429）・`ai_overloaded`（529）・`ai_server`（5xx）・`ai_timeout`・`ai_network`・`usage_unavailable`（DB に届かず使用量を数えられなかった）
- **段階の費用**: §10 の使用量（`GET /api/ai/usage`）に提案と一緒に入る（1 人・1 か月の見込みの上限は同じものが効く）。
- **Cloud Scheduler のジョブ**の最後の実行: 成功は 200 `{"requeued": n}`。

### 制約

- 続きが終わらずに失敗した段階は、**そこまでに書けた本文を `StepError.partial` で運ぶ**（払った分を捨てないため）。記録（`step_attempts.partial_blocks`。#138）には残すが、**サブページの本文には書かず、ログにも code にも出さない**（中途半端な文書が黙って入る方が、はっきり失敗するより悪い）。
- **出力が `EDITOR_AI_MAX_TOKENS`（既定 12,000）で切れたら、同じ答えの続きを書かせて繋ぐ**（旧 NIHO docs と同じ。続きは 8 回まで、重なりは 400 字まで除く。docs-core の `MAX_CONTINUATIONS`・`joinContinuation`）。続きの 1 回ずつも使用量に数え、月の上限は続きの前にも見る（上限に達したらそこで止める）。8 回で終わらなければ `output_too_long` で失敗し、**途中まで書けた文書はページに書かない**。
- 1 つの段階は 1 回の要求（続きを頼んだ分だけ往復は増える）。今の `deploy.sh` の Cloud Run の要求の上限（`lib.sh` の `service_request_timeout`。既定 300 秒）を超える段階は途中で切れる（Cloud Tasks が再試行し、lease が切れれば掃除が拾う）。1 回のモデルの呼び出しの時間切れは `EDITOR_AI_TIMEOUT_MS`（既定 120 秒）なので、今の 300 秒に収まる。長い資料で足りなくなったら、要求の上限を段階の長さに合わせて上げる（上限は task の 30 分）。

## 12. 文字起こし（#36）

録音の音声をサーバー側で文字起こしする。エンジンは Deepgram（`apps/editor-web/src/transcription/deepgram.ts`）。

音声から起こすには **2 つ**が要ります。どちらかが欠けていれば、開始は 503 `transcription_unavailable` のままです。

1. **エンジンの鍵**: Secret Manager の `niho-editor-deepgram-key`。画面の実行 ID（`niho-editor-runner`）だけが読める。**Secret に版が無い、または最新の版が無効なあいだ、エンジンは閉じたまま。** `deploy.sh` は配備のたびに最新の版の状態を見て、有効なときだけ鍵と環境変数を足す（ログに `transcription: on` / `transcription: off`）。
2. **呼び出し口（dispatcher）**: `deploy.env` の `TRANSCRIBE_MODE=cloud-tasks`。1 回の文字起こしは最長 20 分かかり、**1 回の要求に収まりません**（Cloud Run は応答のあとに CPU を絞る）。そこで手順（#37、§11）と同じ形で、Cloud Tasks に積み、同じサービスの OIDC で守った worker の route が実行します。空のままだと、鍵があっても起こす処理は動きません（ログに `transcription dispatcher: off`）。

**VTT の取り込みは、鍵も呼び出し口も必要としません。** 既に文字起こし済みのファイルを持ち込む経路は、どちらが閉じていても動きます。

#### 3 つ目（任意）: Gemini の案

同じ音声を**別のエンジンでも起こして見比べる**（#36 段 3b-4）ための鍵です。**既定のエンジンは変わりません**（上の `deepgram` のまま）。

- 鍵は Secret Manager の `niho-editor-gemini-key`（実行 ID だけが読める）。最新の版が有効なときだけ `deploy.sh` が
  `GEMINI_API_KEY` を足し、ログに `gemini candidates: on` / `off` と出す。
- 版が無ければ、画面に出るエンジンは Deepgram だけ（案は「別の案を作る」で同じエンジンの 2 本目になる）。
- モデルは任意の `deploy.env` の `GEMINI_MODEL`（空ならアプリの既定 `gemini-3.8-flash`）。`deploy.sh` は `EDITOR_GEMINI_MODEL`
  としてだけ渡す（鍵は env に出さない）。形が規則に合わなければ配備を止める（新しい revision が起動しない値を通さない）。
- 入れ方: ① （初回だけ）`gcp-bootstrap.sh resources`（Secret を版なしで作り、実行 ID に読む権限を付ける）→
  ② Google AI Studio でこの用途だけの API キーを作る（使用上限も付ける）→ ③ `scripts/editor-deploy/set-gemini-key.sh`
  （標準入力から読む。引数では受け付けない）→ ④ `deploy.sh --no-build`。
- 音声は Gemini に渡ります（上げてから消すまでの経路は `apps/editor-web/src/transcription/gemini.ts`。終わったら
  Gemini 側のファイルを消す）。**実際の Gemini API での通しはまだ取れていません**（下の「実地の確認」と同じ事情）。

鍵の扱いは AI（§10）と同じ規則です。**鍵は公開リポジトリ・Issue・PR・チャット・ログ・シェルの履歴に出さない。** 入れる経路は `set-transcribe-key.sh` だけ（標準入力から読み、画面・ファイル・コマンドラインに出さない。引数では受け付けない）。

### 有効にする

1. （初回だけ）`scripts/editor-deploy/gcp-bootstrap.sh resources` — Secret `niho-editor-deepgram-key` を版なしで作り、実行 ID に `roles/secretmanager.secretAccessor` を付ける。あわせて呼び出し口の資源（`transcribe-infra.sh`。キュー・サービスアカウント・掃除の Scheduler）も冪等に作る。Scheduler は作った時から 5 分おきに呼ぶが、次の 4 つが済むまでは worker の route が 404 を返す（ジョブの失敗として残るだけで、再試行しない）。
2. Deepgram の Console で、この用途だけの API キーを作る（使用上限も付けておくと歯止めになる）。
3. `scripts/editor-deploy/set-transcribe-key.sh` — 端末で実行すると、入力を画面に出さずに鍵を求める。パスワード管理の CLI から渡すときは `<鍵を出すコマンド> | scripts/editor-deploy/set-transcribe-key.sh`。
4. `deploy.env` に `TRANSCRIBE_MODE=cloud-tasks`（任意で `TRANSCRIBE_TIMEOUT_SEC`）。
5. `scripts/editor-deploy/deploy.sh --no-build` — `DEEPGRAM_API_KEY`（Secret の `latest`）・`EDITOR_TRANSCRIBE_ENGINE=deepgram` と、呼び出し口の 4 つの環境変数が付く。要求の上限も時間切れに合わせて上がる。smoke で worker の route が OIDC トークンなしで 401 を返すことを確かめる。
6. 短い音声を 1 つ起こして、段落と話者が出ることを確かめる。**これは今できない**（下の「実地の確認」）。

### 実地の確認（NIHO editor接続の実環境設定後）

**本番で音声を1本通した確認は、まだ取れていません。** 画面から音声を上げるには本人のsessionが要るため、NIHO側feature flag、候補環境専用の固定callback・公開側originとPOST transportを対向配備し、code/stateを生成URLやログへ残さない合成受入を済ませたうえで、trafficを受けない候補環境で実アカウントの接続受入を先に行う。未設定の間は`/auth/login/start`が`/auth/login?error=unavailable`へ戻る。`stub`へ落とす経路は本番にはない。

**代わりに取れている確認**（2026-11-01 の配備、revision `niho-editor-00004-ntd`）:

| 確かめたこと | どう確かめたか |
| --- | --- |
| エンジンと呼び出し口の両方が入った | `deploy.sh` のログに `transcription: on (deepgram)` と `transcription dispatcher: cloud-tasks (queue niho-editor-transcribe, sweep niho-editor-transcribe-sweep)` |
| 鍵が形として通っている | 起動時検査（`checkStartupConfig`）は鍵が無い・形が不正なら port を開く前に終了する。revision が traffic を受けている＝通っている |
| 内部 route が本番に居る | 配備前は 404、配備後は 401（`/api/internal/transcription/run`・`/sweep`、トークンなし） |
| OIDC が実際に効いている | Cloud Scheduler の掃除が **200**（配備前は 404）。403 や 401 ではないので、audience と `niho-editor-tasks` の一致、route、DB、掃除の処理まで通っている |
| 設定が噛み合っている | Cloud Run の要求の上限が 1320 秒（＝時間切れ 1200 ＋ 2 分）、キューは 3 回・60〜300 秒・同時 3 本、Scheduler の audience は run.app の URL |

**接続が出たら、これだけ確かめれば完了と言えます**:

1. 本人でログインし、録音ページに**短い音声（30 秒ほど）**を上げて「文字起こし」を押す。状態が `queued` → `running` → `succeeded` と進む。
2. **段落と話者**が本文に入る（話者を分けた場合は 1 始まりの番号、名前は空）。長さが入る。
3. わざと失敗させて、**音声が残り「もう一度」ができる**こと。エンジンを入れたまま、形は合うが Deepgram が受け付けない鍵の版（でたらめな 1 行。`set-transcribe-key.sh` で足す）で配備する。起動時検査は鍵の形しか見ないので配備は通る。音声を上げて「文字起こし」を押すと、run が `failed` になり、`errorCode`（Deepgram の 401 は `engine_unavailable` に写される）が画面に出て、音声は消えない。確かめたら**正しい鍵をもう一度入れて版を足し、配備し直してから**「もう一度」を押し、`succeeded` まで進むこと。なお、鍵の版を無効にして配備しても失敗の経路は通らない（エンジンが `off` になり、開始が 503 `transcription_unavailable` で断られるだけで、run が作られない）。
4. 時間切れの扱いと、Cloud Run の要求の上限との順序。**時間切れは音声の長さではなく、エンジンが返すまでにかかった時間**（`TRANSCRIBE_TIMEOUT_SEC`、既定 1200 秒）で決まる。20 分を超える音声でも、その間に返れば成功するので、長い音声を上げても `engine_timeout` になるとは限らない。確かめるのは次の 2 つ。
   - **順序**: Cloud Run の要求の上限が時間切れより先に切れないこと。`gcloud run services describe niho-editor --region <region> --format='value(spec.template.spec.timeoutSeconds)'` が 1320（＝時間切れ 1200 ＋ 2 分）になっている。
   - **`engine_timeout` になること**: 時間切れの扱い自体は `run.test.ts`（エンジンの応答を遅らせるテスト）で固定してある。本番で実際に見るなら、`deploy.env` の `TRANSCRIBE_TIMEOUT_SEC=60`（下限）で配備し、処理に 60 秒より長くかかる音声を上げる。60 秒以内に返れば成功するので、起きなくても失敗ではない。確かめたら `TRANSCRIBE_TIMEOUT_SEC` を戻して配備し直す。
5. 掃除が効くこと: 実行中の run を DB で `running` のまま古くして、5 分以内に `engine_timeout` で失敗にされる（または queued の run が積み直される）。

### 無効にする・回す

**鍵**は AI（§10）と同じ手順です。版を無効にして `deploy.sh --no-build`（ログに `transcription: off`）。回すときは新しい版を足して配備し、古い版を無効にします。

**呼び出し口**を止めるときは、`deploy.env` の `TRANSCRIBE_MODE` を空にして `deploy.sh --no-build`（開始は 503、worker の route は 404 になる）。あわせて掃除を止めるなら `gcloud scheduler jobs pause niho-editor-transcribe-sweep --location <region>`（戻すときは `resume`）。`transcribe-infra.sh` を流し直しても、止めた状態は保たれます。積まれている task を止めるなら `gcloud tasks queues pause niho-editor-transcribe --location <region>`（任意。止めなくても worker の route が 404 を返し、3 回の試行で消える。run は queued のまま残るが、掃除も 404 になるので積み直されず、呼び出し口を戻したときに掃除が拾う）。

### 呼び出し口の構成（`TRANSCRIBE_MODE=cloud-tasks`）

```text
画面 ── POST /api/pages/{id}/recording/transcribe ──▶ niho-editor（受付: run を queued で作り、task を積む）
                                               │ tasks.create（名前 = <run>-<世代>。世代は claim と積み直しのたびに進む）
                                               ▼
                                  Cloud Tasks キュー niho-editor-transcribe
                                               │ POST /api/internal/transcription/run（OIDC: niho-editor-tasks、audience = run.app の URL）
                                               ▼
                                  niho-editor の内部の route（同じサービス）: claim → 保存先の音声 → エンジン → 段落を確定

Cloud Scheduler niho-editor-transcribe-sweep ── 5 分おき POST /api/internal/transcription/sweep（同じ OIDC）──▶ niho-editor
    (a) 時間切れ ＋ 5 分を過ぎた有効な run を失敗にする（running は engine_timeout、queued は internal）
    (b) まだ queued の run（1 分より前に作られたもの）を、世代を 1 つ進めた新しい名前で積み直す
```

| 資源 | 名前（既定） | 内容 |
| --- | --- | --- |
| Cloud Tasks キュー | `niho-editor-transcribe` | 最大 3 回・60〜300 秒の間隔で再試行・同時 3 本。1 つの task の上限は積むときにアプリが決める（時間切れ ＋ 2 分。上限は 30 分） |
| サービスアカウント | `niho-editor-tasks`（deploy.env の `TASKS_SA`） | **手順（§11）と同じ 1 つ**。task と掃除の OIDC トークンの身元だけで、どの資源の権限も持たない |
| Cloud Scheduler | `niho-editor-transcribe-sweep` | `*/5 * * * *`（Asia/Tokyo）・試行の期限 300 秒・再試行なし |
| 権限 | 実行 ID（`niho-editor-runner`） | キューへの `roles/cloudtasks.enqueuer` と、`niho-editor-tasks` への `roles/iam.serviceAccountUser` |

守り方は手順の worker（§11）とまったく同じです。サービスは誰でも呼べる設定のまま（invoker の IAM は使わない）なので、worker の route が自分で Google の ID トークンを検証します（`apps/editor-web/src/server/google-oidc.ts`）: アルゴリズムは RS256 だけ、鍵は Google の JWKS（固定の URL）、`iss` は Google、`aud` は run.app の URL と完全一致、期限は時計のずれ 60 秒まで、`email` は `niho-editor-tasks` と完全一致かつ確認済み。通らない要求は本文を読まずに 401、`Origin` の付いた要求（ブラウザ）は 403、`TRANSCRIBE_MODE` が空なら 404。

`deploy.sh` が足す環境変数（`TRANSCRIBE_MODE=cloud-tasks` のときだけ。4 つが揃い形が正しいときだけアプリは呼び出し口を開く）:

| 変数 | 値 |
| --- | --- |
| `EDITOR_TRANSCRIBE_MODE` | `cloud-tasks` |
| `EDITOR_TRANSCRIBE_QUEUE` | `projects/<project>/locations/<region>/queues/niho-editor-transcribe` |
| `EDITOR_TRANSCRIBE_WORKER_URL` | サービスの run.app の URL（独自ドメインではない。OIDC の audience にも使う） |
| `EDITOR_TRANSCRIBE_INVOKER_SA` | `niho-editor-tasks@<project>.iam.gserviceaccount.com` |

### 時間切れと費用

1 回の文字起こしの時間切れは `TRANSCRIBE_TIMEOUT_SEC`（空ならアプリの既定 1200 秒＝20 分。60〜3300 秒）。3 つの上限が噛み合うようにしてあり、**いちばん短いのがエンジンの時間切れ**です（run が `engine_timeout` で終わり、「もう一度」ができる）:

| 上限 | 値 | 決める所 |
| --- | --- | --- |
| エンジンの時間切れ | `TRANSCRIBE_TIMEOUT_SEC`（既定 1200 秒） | `EDITOR_TRANSCRIBE_TIMEOUT_SEC`。`executeRun` の `AbortSignal` |
| Cloud Run の 1 要求 | 時間切れ ＋ 2 分（既定 1320 秒。`TRANSCRIBE_MODE` が空なら 300 秒。上限 3600 秒） | `deploy.sh` の `--timeout`（`lib.sh` の `service_request_timeout`） |
| 1 つの task（`dispatchDeadline`） | 時間切れ ＋ 2 分（上限 1800 秒＝Cloud Tasks の決まり） | アプリが積むときに（`src/transcription/cloud-tasks.ts`） |
| 掃除が取り残しと見なす | 時間切れ ＋ 5 分 | `src/server/transcription-worker-api.ts` の `STALE_MARGIN_SECONDS` |
| 消した task の名前が空くまで | 最大 24 時間（Cloud Tasks の決まり） | 待たずに済むよう、掃除は積む前に run の世代を 1 つ進める（`requeueRun`） |

`TRANSCRIBE_TIMEOUT_SEC` を 1700 秒より長くすると、task の上限（1800 秒）が先に来ます。その場合 Cloud Tasks は task を失敗と見て積み直しますが、run は `running` のままなので claim できず、2 本目は何もせず終わります（二重に起こすことはない）。長い音声を扱うときも、まず音声の上限（`apps/editor-web/src/recording/audio-limits.ts`）に収まるかを見てください。超えたら保存の前に断ります。クラウドに置いた音声は 30 日で消えます（バケットのライフサイクル規則）。

| 項目 | 見込み |
| --- | --- |
| Deepgram | 請求の正は Deepgram の Console。音声の長さに応じた従量 |
| Cloud Tasks | 月 100 万回まで無料。1 回の文字起こしで 1 回（再試行・掃除の積み直しも 1 回）。無料の範囲 |
| Cloud Scheduler | ジョブ 1 件で月 15 円ほど（§11 の手順の掃除と合わせて 2 件。無料枠は 3 件まで） |
| Cloud Run | 5 分おきの掃除で、使われていなくても 1 日 288 回起こす。1 回は DB の問い合わせ 2 つで短いので、無料の範囲。文字起こしの最中は 1 要求が最長 20 分 CPU を持つので、そのぶんの秒課金が増える |

### 失敗の見方

- **Cloud Tasks のキュー**（コンソールの Cloud Tasks → `niho-editor-transcribe`）: 積まれている数と試行の回数。worker の route が 200 以外を返した task は 3 回まで試され、その後消える。run は queued のまま残り、**次の掃除（5 分以内）がそのまま拾い直す**。**Cloud Tasks は消した task の名前を最大 24 時間使わせない**ので、掃除は積む前に run の世代を 1 つ進め、前の task とは別の名前（`<run>-<世代>`）で積む。それでも拾えないまま時間切れ ＋ 5 分を過ぎれば、掃除が失敗にする（画面から「もう一度」）。
- **Cloud Run のログ**（短い code だけ。トークン・本文・クレームの値・音声・鍵は出さない）:
  - `editor-web: transcription worker request refused`: 検証に通らなかった（`code` は `missing_token`・`bad_audience`・`bad_email`・`expired`・`bad_signature`・`jwks_unavailable` など）。Scheduler・Cloud Tasks からの要求でこれが出るなら、`EDITOR_TRANSCRIBE_WORKER_URL` と `--oidc-token-audience`、`TASKS_SA` の食い違いを疑う。
  - `editor-web: transcription dispatch failed`: 開始が task を積めなかった（run は失敗にして、画面から「もう一度」ができる）。実行 ID の `roles/cloudtasks.enqueuer` と、キューが止まっていないかを見る。
  - `editor-web: transcription failed`: run そのものの失敗。`code` は `audio_missing`・`audio_expired`・`engine_unavailable`・`engine_rejected`・`engine_timeout`・`engine_bad_response`・`too_large`・`internal`。
  - `editor-web: transcription sweep could not requeue every run`: 掃除の積み直しの一部が失敗した（次の回でまた拾う）。
  - `editor-web: transcription sweep read only the oldest queued runs`: queued の run が 100 件を超えて残っている（1 ページで有効な run は 1 つなので、これが出るのは異常。キューが止まっていないかを見る）。
- **文字起こしの失敗の理由**: 録音ページの状態（`GET /api/pages/{id}/recording/transcription` の `errorCode`）。
- **Cloud Scheduler のジョブ**の最後の実行: 成功は 200 `{"failed": n, "requeued": m}`。

## 13. Google のログイン（#47。**一時的**）

NIHO editor専用接続の実環境設定と受入が済むまで本番を試せるようにする**一時的な**方式が`EDITOR_AUTH_MODE=google`：Googleのサインインで本人を確かめ、**許可リストに挙げたアドレスだけ**を入れる。受入後は`niho`に戻す（下の「`niho`に戻す」）。

- 入れるのは `GOOGLE_ALLOWED_EMAILS` のアドレスだけ（小文字に正規化して**完全一致**。部分一致・ドメイン一致では通らない）。許可リストが空なら、本番のサービスは port を開く前に終了する（誰でも入れる状態で動かさないため）。
- 取る権限は `openid email` だけ（Drive などは足さない）。Google の token（code・access token・ID トークン）はサーバーの中だけで使い、cookie にもブラウザの JavaScript・storage にも渡さない。残すのは Google の `sub`（アドレスが変わっても変わらない id）とアドレスだけ。
- セッションはサーバーが署名した HttpOnly cookie（`HttpOnly; Secure; SameSite=Lax; Path=/`、12 時間）。署名の鍵は client secret から導くので、別の秘密を増やさない。許可リストから外したアドレスは、cookie が残っていても次の要求で入れない。
- 画面に出るのは「このアカウントでは入れません」だけ（アドレス・理由は画面にもログにも出さない）。ログに出るのは失敗の種類だけ。
- 実装は `apps/editor-web/src/auth/google.ts` の 1 ファイル（route は方式に依存しない）。ID トークンの検証は worker の route と同じ `src/server/google-oidc.ts`（Google の JWKS で署名・`iss`・`aud`・`exp`・`email_verified` を確かめる）。

### オーナーが Google Cloud のコンソールでやること

editor を動かしているのと同じ GCP プロジェクトで行う（別プロジェクトでもよいが、同じにしておくと見る場所が増えない）。

1. **OAuth 同意画面**（API とサービス → OAuth 同意画面）: User Type は **外部**、公開ステータスは **テスト**のまま。アプリ名・サポートメール・デベロッパーの連絡先を入れる。スコープは追加しない（`openid`・`email` は既定で足りる）。**テストユーザー**に、入れる人のアドレス（許可リストと同じもの）を追加する。テストのままなら、ここに無いアカウントは Google 側で断られる（許可リストと二重の歯止めになる）。審査は要らない。
2. **OAuth クライアント ID**（API とサービス → 認証情報 → 認証情報を作成 → OAuth クライアント ID）: 種類は **ウェブ アプリケーション**。
   - **承認済みのリダイレクト URI**: `https://<APP_DOMAIN>/auth/callback`（独自ドメインが無いうちは `https://<run.app の URL>/auth/callback`）。**`deploy.env` の `APP_DOMAIN` と文字列まで同じ**にする（`EDITOR_ORIGIN` から同じ URL を作って送るので、違うと Google が `redirect_uri_mismatch` を返す）。
   - 承認済みの JavaScript 生成元は要らない（ブラウザから Google を呼ばない）。
   - 作ると**クライアント ID**（公開されてよい値）と**クライアント シークレット**が出る。シークレットはこの場でだけ見られるので、そのままパスワード管理に入れる。
3. もし別の GCP プロジェクトでクライアントを作ったら、そのプロジェクトで「Identity Toolkit」などの API を有効にする必要はない（OAuth の口は常に使える）。

### どの値をどこに入れるか

| 値 | 置き場所 | 備考 |
| --- | --- | --- |
| 方式 | `deploy.env` の `EDITOR_AUTH_MODE=google` | 既定は `niho`。アプリには同じ名前で渡る |
| クライアント ID | `deploy.env` の `GOOGLE_OAUTH_CLIENT_ID` | 公開されてよい値。`deploy.env` は git 管理外。アプリには `EDITOR_GOOGLE_CLIENT_ID` で渡る |
| 入れる人のアドレス | `deploy.env` の `GOOGLE_ALLOWED_EMAILS` | コンマ区切り（例 `you@example.com,you@gmail.com`）。空白を入れない。アプリには `EDITOR_GOOGLE_ALLOWED_EMAILS` で渡る。**この値をリポジトリ・Issue・PR に書かない** |
| クライアント シークレット | Secret Manager の `niho-editor-google-oauth-secret` | `scripts/editor-deploy/set-google-oauth-secret.sh` でだけ入れる（標準入力から読み、画面・ファイル・コマンドラインに出さない）。アプリには `GOOGLE_OAUTH_CLIENT_SECRET` で `:latest` を渡す |
| 戻り先 | `deploy.env` の `APP_DOMAIN` | `https://<APP_DOMAIN>/auth/callback` を Google へ送るので、コンソールに登録したリダイレクト URI と**同じ文字列**にする。空なら `google` では配備を止める |

手順:

1. （初回だけ）`scripts/editor-deploy/gcp-bootstrap.sh resources` — Secret `niho-editor-google-oauth-secret` が無ければ版なしで作り、画面の実行 ID に `roles/secretmanager.secretAccessor` を付ける。**既にある Secret とその版には触らない**（入れ直しは要らない）。
2. `deploy.env` に `EDITOR_AUTH_MODE=google`・`GOOGLE_OAUTH_CLIENT_ID`・`GOOGLE_ALLOWED_EMAILS` を入れる。値の形が違う（空白・`|`・`=` が入る、アドレスでない、クライアント ID が空）ときは `deploy.sh` が配備の前に止まる。
3. `scripts/editor-deploy/set-google-oauth-secret.sh` — シークレットの版をまだ入れていないとき（と、あとで鍵を回すとき）に使う。端末で実行すると、入力を画面に出さずにシークレットを求める（貼り付けて Enter）。パスワード管理の CLI から渡すときは `<シークレットを出すコマンド> | scripts/editor-deploy/set-google-oauth-secret.sh`。空の入力は何もしない。
4. `scripts/editor-deploy/deploy.sh --no-build` — ログに `login: google (...)` が出て、`EDITOR_AUTH_MODE=google`・`EDITOR_GOOGLE_CLIENT_ID`・`EDITOR_GOOGLE_ALLOWED_EMAILS` と Secret `GOOGLE_OAUTH_CLIENT_SECRET` が付く。シークレットの版が無い・最新の版が無効なら、その旨をログに出して Secret を付けずに配備する（サービスは動くが、ログインは「ログインできませんでした」のまま）。
5. `https://<APP_DOMAIN>/` を開く → ログインの画面 → Google のサインイン → 戻って編集できることを確かめる。許可リストに無いアカウントで試すと「このアカウントでは入れません」になる。

### `niho` に戻す（専用接続を受入したとき）

1. `deploy.env`の`EDITOR_AUTH_MODE`を`niho`に戻し、`EDITOR_NIHO_ORIGIN`へレビュー済みのexact HTTPS originを設定する（実値はcommitしない）。`GOOGLE_OAUTH_CLIENT_ID`・`GOOGLE_ALLOWED_EMAILS`は消してよい（`niho`では渡らない）。
2. `scripts/editor-deploy/deploy.sh --no-build` — ログに `login: niho (...)`。`--set-env-vars`・`--set-secrets` は毎回の全量なので、Google の環境変数と Secret は前の revision の分も残らない。これで出ているセッションの cookie も読めなくなる（方式が変わると誰も入れない）。
3. Secret の有効な版をすべて無効にする: `gcloud secrets versions list niho-editor-google-oauth-secret --filter='state:ENABLED'` で版を見て、それぞれ `gcloud secrets versions disable <版> --secret niho-editor-google-oauth-secret`。
4. Google Cloud のコンソールで OAuth クライアントを削除する（または無効にする）。テストユーザーの登録も消す。
5. `apps/editor-web/src/auth/google.ts` と `EDITOR_GOOGLE_*` を消す PR を出す（この節も消す）。`src/auth/config.ts` の `AUTH_MODES` から `google` を外せば、設定が残っていても起動しない。

### 費用と限界

- 追加費用は Secret の版 1 つだけ（無料の範囲）。Google のサインインに費用はかからない。
- 同意画面を**テスト**のままにしているので、入れるのはテストユーザーに登録したアカウントだけ（最大 100）。公開（本番）にすると審査が要るので、公開しない。
- セッションは 12 時間で切れる（続けるには入り直す）。複数の端末・ブラウザで同時に入れる。
- ログインの画面のボタンは共有 UI（niho-docs-ui）の文のまま「NIHOでログイン」と出る。押すと Google のサインインへ行く。一時的な方式なので共有 UI の文は変えていない。サインインのとき毎回アカウントを選べる（`prompt=select_account`）。
