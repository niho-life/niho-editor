# editor-web（editor.niho.life）

NIHO editor の Web。Next 16（App Router）。今は枠（NIHO ログインの入口・サイドバー・ページの一覧・新しいページ）と、ページを書いて残すところまで（#46・#47・#32）。
設計は [docs/architecture/editor-niho-life-design.md](../../docs/architecture/editor-niho-life-design.md)。

## ローカルで動かす

前提: Node 24、PostgreSQL 16（空の DB を 1 つ）。

```sh
# 1. 依存（packages/* は install-links で複製して入る。packages を変えたら入れ直す）
npm -C apps/editor-web ci
npm -C packages/editor-store ci

# 2. 空の DB に migration を適用（未適用のものだけ。適用済みは editor_store_migrations に記録）
export DATABASE_URL=postgres://<user>@127.0.0.1:5432/<db>
npm -C packages/editor-store run migrate

# 3. stub で起動（開発用の固定ユーザー。画面の右下に「stub」と出る）
EDITOR_AUTH_MODE=stub npm -C apps/editor-web run dev
```

| 環境変数 | 意味 |
| --- | --- |
| `DATABASE_URL` | ページの正本の PostgreSQL。未設定なら API は 503、画面は「保存先を使えません」 |
| `EDITOR_AUTH_MODE` | `stub`（開発・CI だけ）・`niho`・`google` のどれか。開発では未設定で `stub` |
| `EDITOR_NIHO_ORIGIN` | `niho` で必須。NIHO editor専用接続先のexact HTTPS origin。path・query・fragment・credentialsを含む値は起動時に拒否する。実値は配備設定だけに置く |
| `EDITOR_GOOGLE_ALLOWED_EMAILS` | `google` で入れる人のアドレス（コンマ区切り。小文字に正規化して完全一致）。本番で空なら起動しない |
| `EDITOR_GOOGLE_CLIENT_ID` | `google` の OAuth クライアント ID（`aud` の期待値）。空ならログインは `unavailable` |
| `GOOGLE_OAUTH_CLIENT_SECRET` | `google` の client secret。サーバーだけが読む（本番は Secret Manager から。[editor-deploy.md](../../docs/ops/editor-deploy.md) §13）。リポジトリ・ログに書かない |
| `EDITOR_ORIGIN` | 任意。更新系の要求の Origin 検査に使う origin（未設定なら Host と転送の header から）。`google` では `/auth/callback` の URL もここから作る |
| `EDITOR_AI_MODE` | 任意。未設定・`off` は AI を使わない（提案・採用は 503 `ai_unavailable`）。`anthropic` は本物のモデル（Anthropic の Messages API。`ANTHROPIC_API_KEY` が空・未設定なら 503）。`fake` は偽物のモデル（開発・CI だけ。`NODE_ENV=production` では 503） |
| `ANTHROPIC_API_KEY` | `EDITOR_AI_MODE=anthropic` の鍵。サーバーだけが要求のたびに読む（本番は Secret Manager から。[editor-deploy.md](../../docs/ops/editor-deploy.md) §10）。リポジトリ・ログに書かない |
| `EDITOR_AI_MODEL` | 任意。`anthropic` のモデル。既定 `claude-sonnet-5-5`。`^[a-z0-9][a-z0-9._-]{0,63}$` に合わなければ 503 |
| `EDITOR_AI_TIMEOUT_MS` | 任意。モデルの 1 回の呼び出しの時間切れ（ミリ秒）。既定 120,000、1,000〜300,000 に丸める |
| `EDITOR_AI_MAX_TOKENS` | 任意。1 回の出力の上限（トークン。思考の分を含む）。既定 12,000、256〜32,000 に丸める（提案は送る文字数からこれ以下で決める） |
| `EDITOR_AI_MONTHLY_LIMIT_USD` | 任意。owner ごとの月の上限（見込みの USD）。未設定は上限なし。0 以上の数でない値は 0（AI を止める） |
| `EDITOR_STEPS_MODE` | 手順の実行の方式。`inline`（開発・CI だけ）か `cloud-tasks`（本番。下の 3 つが揃い形が正しいときだけ）。未設定・`off`・未知の値、本番（`NODE_ENV=production`）の `inline`、3 つが欠けた `cloud-tasks` では手順の開始は 503 |
| `EDITOR_STEPS_QUEUE` | `cloud-tasks` のキュー（`projects/<p>/locations/<l>/queues/<q>`） |
| `EDITOR_STEPS_WORKER_URL` | `cloud-tasks` の worker の基点（`https://<host>`。path なし）。task の宛先と OIDC の audience |
| `EDITOR_STEPS_INVOKER_SA` | `cloud-tasks` の task と掃除の OIDC トークンの身元（`<name>@<project>.iam.gserviceaccount.com`）。worker の route はこの 1 つだけを通す |
| `EDITOR_FACE_CREDENTIALS` | 任意（secret）。公開 API を NIHO の面が読むサービス間の資格。JSON の配列 `[{ "audience": "exp"\|"niho", "sha256": "<token の SHA-256 の小文字 hex>", "expiresAt": "<ISO 8601 UTC>" }]`。token の平文は置かない。未設定・不正（1 つでも形が違う）なら面は誰も読めない（不正は起動時と最初の要求で「不正」とだけログ）。署名つきのサービス間 token の契約ができるまでの暫定 |
| `EDITOR_PUBLIC_API_RATE_LIMIT_PER_MINUTE` | 任意。公開 API の資格（の SHA-256）ごとの 1 分の要求数の上限（instance ごと）。未設定・不正は 600 |
| `EDITOR_STUB_ROLES` | stub の方式だけ。NIHO の役割の代わり（カンマ区切り）。未設定なら `writer,kamakura`（両方の面に出せる）、空なら役割なし。niho の方式では読まず、役割の契約（#42）まで面には出せない（公開もプレビューの発行も） |
| `EDITOR_DESTINATION_DECLARATIONS` | 任意。面の宣言の取得先 `{"exp": url, "niho": url}`（https だけ）。60 秒だけ持ち ETag で確かめ直す（5 秒・64 KiB まで。redirect は同じ host の https だけ）。未設定なら stub は同梱の dev 用の宣言（`src/publish/dev-declarations.ts`）、niho は「いまは公開できません」。値が読めなければどちらも宣言なし。公開 API のプレビューも、まだ公開していない面の URL をここから作る（宣言が無ければ 404） |
| `EDITOR_ASSET_ORIGIN` | 任意。公開版の写真の URL の origin（https の origin だけ）。写真は `${origin}/assets/${sha256}.${ext}`。未設定・不正なら写真のあるページは公開できない（422。シートでは押せない）。公開 API のプレビューの写真も同じ URL（未設定なら写真のある下書きのプレビューは 503） |
| `EDITOR_STORAGE` | 任意。資産（音声・画像）の保存先。`fake`（メモリの偽物。開発・CI だけで、`NODE_ENV=production` では起動しない）・`gcs`・`off`。未設定は本番 `off`（音声・画像の API は 503 `storage_unavailable`）、それ以外は `fake`。未知の値は起動しない |
| `EDITOR_ASSETS_BUCKET` | `EDITOR_STORAGE=gcs` のとき必須。資産の bucket 名（無い・規則に合わなければ起動しない。値は表示しない） |
| `EDITOR_TRANSCRIBE_ENGINE` | 任意。文字起こしの**既定の**エンジン（#36 段 2b）。`fake`（偽物。開発・CI だけで、`NODE_ENV=production` では起動しない）・`deepgram`・`gemini`・`off`。未設定は本番 `off`、それ以外は `fake`。未知の値は起動しない |
| `DEEPGRAM_API_KEY` | `EDITOR_TRANSCRIBE_ENGINE=deepgram` のとき必須。無い・空白や改行や制御文字を含むなら起動しない（前後の空白は除いて使う。値は表示しない） |
| `GEMINI_API_KEY` | `EDITOR_TRANSCRIBE_ENGINE=gemini` のとき必須（検査は Deepgram の鍵と同じ）。**既定が別のエンジンでも、この鍵が入っていれば Gemini の案を作れる**（#36 段 3b-4。鍵が無いエンジンは画面に出ない） |
| `EDITOR_GEMINI_MODEL` | 任意。Gemini のモデル（既定 `gemini-3.8-flash`。小文字英数と `.`・`-` の 1〜64 文字。規則に合わなければ起動しない） |
| `EDITOR_TRANSCRIBE_TIMEOUT_SEC` | 任意。1 回の文字起こしの時間切れ（秒）。既定 1200、60〜3300 の整数（範囲の外・整数でなければ起動しない） |

確認のコマンド: `typecheck`・`lint`・`test`（vitest。`TEST_DATABASE_URL` があれば `*.pg.test.ts` も専用の schema で動く）・`build`・`test:startup`（build の後。本番の起動の守り）・`test:e2e`（`DATABASE_URL` と migration、build が要る。`next dev` を起動して API と画面を確かめ、公開 API は本番の build で確かめる。作った行・schema は消す）。packages を入れ直したあとは `.next` を消してから（`rm -rf .next`）build・e2e をする。

## 決まっていること

- **認証（#47 / #150）**: `NODE_ENV=production` で `EDITOR_AUTH_MODE` が `niho` でも `google` でもなければ（未設定を含む）起動しない。`niho` はexact HTTPSの `EDITOR_NIHO_ORIGIN` が無ければ起動せず、`google` は許可リスト（`EDITOR_GOOGLE_ALLOWED_EMAILS`）が空でも起動しない。本番の入口 `scripts/server-entry.mjs` が server を読み込む前（port を開く前）に `src/auth/config.ts` で検査し、`src/instrumentation.ts`（`next start` 用）と要求ごとの方式の選択でも同じ検査をする。`next build` の途中では検査しない。`niho` は `src/auth/niho.ts` の専用opaque sessionに閉じ、Secure/HttpOnly cookieを毎要求NIHOでintrospectする。stub はcookieもtokenも作らない。`google` は `src/auth/google.ts` の**一時的な**方式（Google のサインイン＋許可リスト。[editor-deploy.md](../../docs/ops/editor-deploy.md) §13）。NIHO接続は写真の本人確認だけで、Docs Drive用の広い `apiToken` は発行しない。
- **ログイン（#32）**: `/auth/login`（枠の外の画面）、`/auth/login/start?next=`（GET）、`/auth/callback`（GET）、`/auth/logout`（POST。同じ origin でなければ 403）。route の応答は `Cache-Control: no-store`。未ログインで画面を開くと `/auth/login?next=…` へ移る（今の path は `src/proxy.ts` が header で渡すだけで、認証は読まない）。戻り先は `src/auth/return-to.ts` の `safeReturnTo` で editor の画面の path（`/`・`/p/new`・`/p/{uuid}`・`/destinations`・`/account`・`/settings` など）だけにし、それ以外（外の URL・`/auth/*`・`/api/*`）は `/`。stub はいつもログイン済みで、`/auth/login` は戻り先へ移る。
- **画面（#32）**: 枠は `app/(editor)/layout.tsx`（niho-docs-ui の shell）。`/` はデスクトップでは最後に開いたページ（cookie `editor_last_page` の id。無い・消えたなら `/p/new`）へ移る。`/p/new` は題名か本文を入力した時点で POST して作り、`history.replaceState` で `/p/{id}` に替える（エディタは作り直さない）。`/p/new?from=recording` は開始の画面だけ。`/settings` は設定（#108）、`/destinations`・`/destinations/{id}` は発信先の設定（#41。どちらも下の節）、`/account` は題名だけ。900px 以下（shell.css と同じ）では `/` が一覧の画面で、ページと設定は全画面、ヘッダーの左のボタンで一覧を出す。
- **一覧（#32）**: 更新順（同じ時刻は id の降順）で 100 件ずつ。layout が最初の 100 件を描き、末尾が近づいたら `GET /api/pages?limit=&cursor=` で続きを読む。cursor は `<updated_at（UTC・マイクロ秒まで）>_<id>`。読み込んだ親の下に子ページを作った順で並べる。検索はサイドバーの検索入力から（下の「検索（#35）」）。
- **CSP と HSTS（#44）**: ページの CSP は `src/proxy.ts` が要求ごとに作る nonce で付ける（`src/security/csp.ts`）。script は nonce ＋ `strict-dynamic` で、インラインの script・`unsafe-eval`・外部 origin を許さない。style だけ `'self' 'unsafe-inline'`（TipTap が実行時に nonce なしの `<style>` を注入し、共有の docs-ui が SSR で `style=""` を出すため。絞るには docs-ui 側の変更が要る）。nonce は静的な HTML に入れられないので、root layout で `connection()` を呼び全 route を要求のときに描く。`/api` は何も読み込まない固定の CSP（`default-src 'none'`）。`Strict-Transport-Security` は全応答。**画像（#33）は署名付き URL を使わずサーバーが中継する**（`/api/assets/{id}`・`/s/{token}/a/{id}`）ので、`img-src` は `'self' data: blob:` のまま変えない。`connect-src` は `'self'` と `https://storage.googleapis.com`（録音の音声をブラウザから GCS のセッション URI へ直接 PUT するため。#36 段 3b-1）。音声は、同じ origin の `/api/pages/{id}/recording/audio` が保存先から読み出して流す（#36 段 3b-2）ので、`media-src`（`'self' blob:`）は変えない。開発（`next dev`）だけ `unsafe-eval` と HMR の WebSocket を許す。
- **PWA（#49）**: `src/pwa/editor-manifest.ts` と明示GET route（`/manifest.webmanifest`。`display: standalone`、`start_url: /`）、アイコンは `public/icons`（NIHO docs の `icon.svg` から `node scripts/build-icons.mjs` で作る。any 192/512、maskable 512、apple-touch 180。再生成は Chrome が要る）。`public/sw.js` は**殻だけ**: `/_next/static/` と offline 画面だけを手元に置き、圏外でページを開くと `/offline.html`（「つながっていません」）を出す。ページの HTML・`/api`・認証の絡む応答はキャッシュしない。オフライン編集は含まない（#50）。登録は本番だけ（`RegisterServiceWorker`）。インストール後も全ページ noindex。standalone の出力には `public/` が入らないので、`postbuild`（`scripts/copy-standalone-assets.mjs`）と Dockerfile で置く。
- **API**: `GET/POST /api/pages`、`GET/PATCH /api/pages/{id}`。`GET /api/pages` は `{ pages, next }`（next が null なら終わり。ゴミ箱のページは出さない）。未認証 401、別の人・存在しない・UUID として不正な id は同じ 404、本文は 1 MiB まで（超えたら 413）、JSON でない・形が違う・読めない limit や cursor は 400、更新系は同じ origin でなければ 403。エラーの本文は短い code だけ。
- **保存の競合**: `PATCH /api/pages/{id}` は `baseRevision`（読んだときの revision。必須）を付ける。今の revision と違えば何も書かずに 409 と今のページ（`{ error: "conflict", page }`）。自分のページでなければ revision によらず 404。「この内容で上書き」は 409 の revision を付け直し、`overwrite: true` で再送する（上書き前の本文は版に残る）。`/p/new` で作ったページは、POST の応答の revision（1）から `baseRevision` を始める。
- **保存の状態と端末の下書き（#33）**: 自動保存は入力の 1 秒後（⌘S・Ctrl+S は今すぐ）。送れない間（オフライン・サーバーの失敗・ログイン切れ）も本文は端末の IndexedDB（`niho-editor` / `page-drafts`、key はページの id）に残し、サーバーに届いたら消す。開いたときに下書きがあれば、同じ revision なら載せて送り直し、サーバーが先へ進んでいれば競合の帯を出す（`src/lib/drafts.ts`）。`/p/new` の作る前の本文は key `new` の 1 つの枠に残し、次に `/p/new` を開いたときに載せてそのままページを作る。作ったら以後の下書きはそのページの id に書き、枠の下書きは消す。
- **版**: `GET /api/pages/{id}/versions`（新しい順・最大 100）、`GET …/versions/{n}`、`POST …/versions/{n}/restore`（`baseRevision` 付き。戻す直前の本文は版に残る。今の形で保存できない古い版は 422）。自動保存は本文が変わるとき、最新の版から 10 分以上空いていれば、保存の前の本文を版にする。1 ページ 200 版を超えたら古い自動保存の版から捨てる。
- **ゴミ箱**: `DELETE /api/pages/{id}`（子孫も一緒。公開中は 409 `published`）、`GET /api/trash`、`POST /api/trash/{id}/restore`。30 日を過ぎたものは `npm -C packages/editor-store run purge-trash` が完全に削除する（定期実行の配線はクラウド側で別途）。
- **公開のシート（#39）**: `GET /api/pages/{id}/publish`（シートの中身。発信先・条件・URL・主ボタン）、`POST /api/pages/{id}/publish`（`{ handle, range, extras, slug? }`。公開していなければ公開、同じ発信先なら更新を公開、別の発信先なら発信先を変える）、`POST /api/pages/{id}/publish/stop`（公開をやめる。もう一度呼んでも同じ）。判定と状態遷移は `packages/editor-publish`、ポートの組み立ては `src/publish/ports.ts`、Postgres は `src/publish/pg-store.ts`。公開・更新の前に自動保存を待ち（届かなければ送らない）、条件はサーバーでも評価し直す。カテゴリ・関連する体験は editor にまだ欄が無いので、同じ発信先なら公開中の値を引き継ぐ。 保存先（#50。設計 §2.1）がクラウドでない（`LOCAL`・移行中の `CLOSING`・知らない値）アカウントは、公開が 403 `storage_not_cloud` で、シートは `storageBlock` を返して主ボタンを出さない。保存先は NIHO から読む契約が出るまで「未選択（`UNSET`＝クラウドと同じ）」で、要求の本人でなければ `LOCAL`（fail closed）。
- **AI の提案（#38 段 1。サーバー側だけ）**: `POST /api/pages/{id}/ai/proposals`（`baseRevision`・`intent`（`{ preset }` か `{ text }`）・任意の `scope`（最上位のブロックの位置の範囲。`toIndex` を含む））は提案を返すだけで、ページには何も書かない。`POST /api/pages/{id}/ai/adoptions` は採用したものだけを、今の本文を版（`ai`）に残してから `baseRevision` 付きで保存する（履歴から戻せる）。`GET /api/ai/usage` は今月（Asia/Tokyo）の使用量。実装は `src/ai/`（提案エンジン・語単位の差分・候補・偽物のモデル・プロンプト・Anthropic のアダプタ）と `src/server/ai-api.ts`。モデルと鍵はサーバー側だけ。
  - 編集の対象は最上位の段落と見出しだけ（箇条書き・引用・囲み・画像などは文脈として送るだけ）。段落はブロックの位置で指す。**変更した段落の太字・斜体・リンクは外れてプレーンテキストになる**（v1 の制限）。変更しない段落には触れない。
  - 足すだけの候補（要約・見出しをつける・Add headings・記事にできそうな部分・Check facts to confirm）は、モデルが既存の文の変更を返しても捨てる。長いページは段落の切れ目で約 4,000 文字ずつに分けて頼み、30,000 文字を超える範囲は 413 `too_large`（範囲を選んで頼む）。
  - 本物のモデル（`src/ai/anthropic.ts`）: 呼ぶのは固定の `https://api.anthropic.com/v1/messages` だけ（設定で変えられない。転送も追わない）。本文は `<untrusted_data>` の中だけに入れ、規則は system に置く。応答の最初の text ブロックを JSON として読む（コードフェンスは外す）。読めない・空・途中で切れた（`stop_reason: "max_tokens"`）応答と、HTTP の失敗・時間切れは 502 `ai_failed`（読めない・途中で切れた応答の使用量は数える）。自動の再試行はしない。`temperature` は送らない（claude-sonnet-5-5 など新しいモデルは既定以外の値を断る）。鍵・プロンプト・本文はエラーとログに出さない（ログは失敗の種類と HTTP ステータスだけ）。テストは差し替えた `fetch` だけで、本物の API は CI でも手元でも呼ばない。
  - 使用量は表 `ai_usage`（migration 0005。owner × 月）に原子的に足す。金額は docs-core の単価表の見込み（偽物・単価不明は 0）。上限以上はモデルを呼ぶ前に 429 `quota_exceeded`、上限の 80% 以上で `nearLimit`。モデルの失敗・検証に通らない出力は 502 `ai_failed`（使った分は記録する）。
- **索引に載せない**: 全ての応答に `X-Robots-Tag: noindex, nofollow`（`next.config.ts`）、全ページに `<meta name="robots" content="noindex, nofollow">`。`robots.txt` は Disallow を付けない（クロールを止めると noindex が読まれない）。公開 API の `/v1/*` だけは契約どおり `X-Robots-Tag: noindex` を handler が付ける（Next は config の header があると route の値を捨てるので、全体の規則から `/v1/` を外している）。
- **本文**: niho-docs-ui の `BlockEditor`（TipTap）を使い、`blocks` は TipTap の doc の `content`（ブロックの配列）をそのまま保存する。サーバーが見るのは「`type` を持つ object の配列で、大きさと深さが上限の内側」だけ。**限定 AST としての厳密な検証（許すブロックの種類・HTML の正規化）は #33。**
- **React を 1 本にする**: `.npmrc` の `install-links=true` で packages/* を node_modules に複製して入れる。docs-ui の側の node_modules（React 18）を拾わず、react・TipTap はこの app の 1 本に解決する（`src/components/PageEditor.test.tsx` が確かめる）。packages を書き換えたら `npm install` し直し、`apps/editor-web/.next` も消す（packages の version が同じだと webpack の cache が古い版を使い続け、`next build` は警告だけで通って実行時に 500 になる。CI は毎回新しい checkout なので影響しない）。
- **bundler は webpack**（`--webpack`）: docs-core は `./types.js` で `./types.ts` を指す書き方で、Turbopack は node_modules の中のこれを解決しないため。`experimental.extensionAlias` で `.js` を `.ts` にも当てる。
- **packages/editor-store**: migration（`migrations/NNNN_*.sql`、BEGIN/COMMIT で包み辞書順）と `EditorStore`。全てのクエリが `owner` と `deleted_at IS NULL` で絞る。`page_versions` には保存・上書き・戻す直前の本文を書く。`assets` は音声（`src/recording-audio.ts`）と画像（`src/images.ts`）が書く。公開（公開版・転送・接続・鍵・プレビューの token）の表は `0009_publications.sql`（プレビューの token に結ぶ著者の列は `0010_preview_token_author.sql`）、SQL は `src/publications.ts`。

## 検索（#35）

- **API**: `GET /api/search?q=&limit=`。題名と本文を、空白で区切った語の AND・大文字小文字を区別しない部分一致で探す（`%` `_` `\` は文字どおり）。自分の・ゴミ箱でないページだけ、更新順、既定 30 件・最大 100 件。結果は `{ id, kind, title, snippet, updatedAt }` だけ（snippet は当たった所の前後 約 80 字）。未認証 401、DB が無い 503、`q` が無い・空は空の結果、`q` が 100 文字を超える・`limit` が不正は 400。
- **索引**: migration `0003_search_text.sql` が `pages.search_text`（題名 + 本文の text ノードの文字だけ。generated column なので保存のコードは触らない）と pg_trgm の GIN（`deleted_at IS NULL`）を足す。pg_trgm は PostgreSQL の contrib（Cloud SQL・postgres:16-alpine・homebrew の postgresql@16 に入っている）。検索のコードは `packages/editor-store/src/search.ts`。
- **フック**: `usePageSearch(query)`（150ms 止まってから 1 回だけ問い合わせ、古い要求は中止。`idle | loading | ready | error`）と `useSearchShortcut(onOpen)`（Mac は ⌘K、それ以外は Ctrl+K。入力欄の中でも効き、IME の変換中は無視）。
- **画面（`EditorFrame`）**: サイドバーの検索入力に打つと、サーバーで題名と本文を探し、結果を更新順に出す（2 行目に当たった所の一文）。検索中は続きの読み込みを止め、一覧の下に状況（「N 件」「探しています…」「見つかりませんでした」と失敗）を `role="status"` で出す。検索語が空に戻ればふつうの一覧。⌘K（Mac 以外は Ctrl+K）で、畳まれた一覧を出し（狭い画面ではページから一覧へ）、検索入力を開いてフォーカスする。すでに開いていれば入力へフォーカスを戻す。専用のパレットは作っていない（モック v6 にもサイドバー内の検索しかない）。
- **まだ**: 絞り込み（公開中・録音。`/api/search` に引数が無く、公開中は `publications` の join が要る＝公開の配線の後）。

## リンクで共有・複製・書き出し（#34）

- **API**（全て本人の・ゴミ箱でないページだけ。未認証 401、DB が無い 503、別の人・存在しない・不正な id・削除済みは同じ 404、更新系は同じ origin でなければ 403）:
  `GET /api/pages/{id}/share`（状態）・`PUT …/share`（共有を始める。冪等）・`POST …/share/rotate`（リンクを作り直す）・`DELETE …/share`（止める。冪等）は `{"share": DocsPageShareState}`（docs-core の `page-sharing.ts`）。`POST …/duplicate` は 201 `{"page"}`、`GET …/export.md` は Markdown の attachment。
- **共有の状態**: `url` は `${origin}/s/{token}`（origin は `EDITOR_ORIGIN` か Host から。決まらなければ null）。token は `url` の中だけに出し、`publicId` には token から一方向に作った値（作り直すと変わる）を入れる。`rotate` は `expectedPublicId` を見ない（今は常に作り直す）。
- **`/s/{token}`**（`src/app/s/[token]/page.tsx`。`app/(editor)` の外なので、枠・一覧を出さず、未ログインでもログインへ移さない。CSP の nonce は他の画面と同じく `src/proxy.ts` が付ける）: 認証を使わず、題名と本文（最新の保存版）だけを `src/share/render-blocks.tsx` で React の要素にする（HTML を注入しない。リンクは https・http・mailto だけ、`rel="noopener noreferrer nofollow ugc"`）。形の違う・未共有・止めた・作り直す前の token とゴミ箱のページは同じ 404、DB を使えないときは汎用の 500。header は `next.config.ts` の `/s/:token*` の規則で `Cache-Control: private, no-store`・`Referrer-Policy: no-referrer`（全体の規則の後に置き、値は 1 つ）。`next dev` はページの Cache-Control を開発用の値に置き換えるので、本番の値は `test:startup` で確かめる。
- **表**: migration `0004_page_shares.sql`（共有中のページに 1 行。止める＝行を消す。token は 256 bit の乱数の base64url を平文で持つ）。コードは `packages/editor-store/src/shares.ts`・`duplicate.ts`。
- **書き出し**（`src/export/markdown.ts`）: niho-experience の Markdown サブセット（`apps/web/src/lib/guide-markdown.ts`）として読める形だけを出す。見出しは `##`/`###`、リストは 1 行 1 項目に平坦化、引用・囲みは `:::note`、リンクは https だけ、画像・区切り線は出さない。本文の記号は `\` で逃がす（日本語は変えない）。parser の受理規則を写した oracle が `src/export/markdown.test.ts` にある。
- **画面から呼ぶ関数**: `src/lib/page-actions-client.ts`（`getPageShare`・`startPageShare`・`rotatePageShare`・`stopPageShare`・`duplicatePageRequest`（新しい id・題名・種類を返す）・`pageExportUrl`・`deletePageRequest`・`listPageVersions`・`restorePageVersion`（`baseRevision` 付き。30 秒で打ち切る））。
- **ヘッダーの状態と「…」（#34 第 1 段・第 2 段）**:
  - **状態の丸**（docs-ui の `StatusDot`）: 公開の状態（公開中・更新あり・限定公開・公開をやめた。公開のシートが読んだもの。#39）＋保存の状態（「公開中 · … · 保存済み」「自分だけ · 保存中」「· オフライン・この端末に保持」など。言葉は `src/lib/save-status.ts` の `headerStatus`）。公開のシートがまだ読めていない間は「自分だけ」。ページの外（`/`・設定・録音から）では出さない。
  - **読み上げ**: 保存の状態を読み上げるのはヘッダーの丸（`aria-live="polite"`）だけ。本文の上の「保存済み」などの表示は見える文字として残し、live region にしない（二重に読み上げない）。
  - **「…」**: リンクで共有・書き出し（.md）・履歴・複製・削除（docs-ui の `shellMoreItems` の順）。Google ドキュメントへの書き出しは NIHO の API 待ち。まだ作っていないページ（`/p/new`）と、端末の下書きを読み終える前は出さない。開閉と項目の移動は `ShellMenu`（↑↓・Home・End・Esc）で、選んだらフォーカスは「…」へ戻る。リンクで共有の補足「共有中」は、共有していると分かっているときだけ出す（`/p/{id}` の RSC が開くときに真偽だけを読んで渡し、共有のシートで読んだ・変えた値で更新する。読めなければ出さない。リンクそのものは RSC の payload に入れない）。
  - **どの操作も先に保存する**: まだ届いていない変更を今送り、全て届くまで待つ（`Autosave.settle`）。届かなければ（オフライン・ログイン切れ・サーバーの失敗・競合で止めている）操作を止め、シートも開かずに「〜の前に変更を保存できませんでした」（履歴は「履歴を開く前に…」）と出す（編集は捨てない）。同じページの操作は 1 つずつ。
  - **複製**: `POST …/duplicate` → 一覧の上に足し、`/p/{新しい id}` へ。失敗は「…」の左に短く（`role="alert"`。「複製できませんでした」）。
  - **書き出し**: 同じ origin の `<a href="/api/pages/{id}/export.md" download>` を押す（本文は fetch で読まない。ファイル名はサーバーの Content-Disposition）。
  - **削除**: 確認のダイアログ（docs-ui の `ShellSheet` を `EditorShell` の overlay に。外は inert、Esc・「やめる」で閉じ、フォーカスは「…」へ戻る）→ `DELETE /api/pages/{id}`（204）→ 一覧からそのページと子孫（読み込み済みの分。サーバーは子孫ごとゴミ箱へ入れる）を外し、`/` へ（`editor_last_page` が消したページを指していても、`/` はサーバーで確かめて新しいページへ移す）。409 `published` は「公開中のページは、先に公開をやめてください」、他の失敗は「削除できませんでした」をダイアログの中に出し、閉じない（一覧もページもそのまま）。送っている間は 2 回目を送らず、閉じない（応答は 30 秒で打ち切る）。
  - **リンクで共有**（`src/lib/use-page-share.ts`・`src/components/ShareSheet.tsx`。ShellSheet）: 開くたびに `GET …/share` を読む（その間「読み込み中」を `role="status"`）。共有していなければ「リンクを作る」（`PUT`）、共有中ならリンク（読み取り専用の入力）・「コピー」・「作り直す」・「共有を止める」（`DELETE`）。「作り直す」はその場で「作り直すと、古いリンクは読めなくなります。」と確かめてから `POST …/share/rotate`（やめる・Esc は確かめるのをやめるだけ）。コピーは `navigator.clipboard.writeText`、使えなければ入力を選んで「⌘C でコピー」（Mac 以外は Ctrl+C）。作った・作り直した・止めた・コピーしたは同じ `role="status"` で短く知らせ、失敗はシートの中に短く（閉じない）。操作は同じページで 1 つずつで、送っている間もシートは閉じられる（開き直すと、その結果を待つ。2 つ目は送らない）。リンクは共有中のこのシートにだけ出し、例外・ログには入れない。
  - **履歴**（`src/lib/use-page-history.ts`・`src/components/HistorySheet.tsx`。ShellSheet）: 開くたびに `GET …/versions`（新しい順）を読み、各行に いつ（一覧と同じ `formatWhen`）・理由（自動保存／AI の提案の前／公開／上書きの前／戻す前）・ブロック数・「この版に戻す」。0 件は「まだ履歴がありません」。「この版に戻す」は同じシートで確かめる（「本文がこの版になります（題名はそのまま）。いまの本文は、戻したあとも履歴から戻せます。」。サーバーは戻す前の本文を版 `restore` に残してから戻し、題名は変えない）。「戻す」でもう一度保存を確かめ、今の revision を `baseRevision` に `POST …/versions/{n}/restore`。409 は「別の画面で保存されました。開き直してからもう一度」、422 は「この版には戻せません」（どちらもシートの中。閉じない）。戻している間は閉じず、2 回目を送らない。戻せたらシートを閉じ、エディタを応答のページ（題名・本文・revision）で開き直し（`PageEditor` が key を替えて作り直す。保存・下書き・Undo の部品も新しく、次の保存はその revision の上に送るので競合にしない。端末の下書きは開いたときと同じく比べ直す）、ヘッダーの `role="status"` で「この版の本文に戻しました」と知らせ、一覧の上へ動かす。下書きを読み直す間に「…」が消えてフォーカスが外れたら、出し直したときに「…」へ戻す。
  - **枠とページの橋渡し**: ヘッダーは枠（`EditorFrame`）、保存の状態とエディタはページの中（`PageEditor`）にあるので、`PageEditor` が `useEditorFrame().attachPage({ id, status, flush, revision, reopen, shared, setShared })`（`src/lib/attached-page.ts`）で自分を登録し（保存の状態が変わるたびに登録し直す）、画面を離れたら外す。操作は「…」を開いたページの id に対して行い、終わったときに別のページへ移っていたら（id と flush で見分ける。版に戻して開き直した画面も別の画面）、その画面には何も出さず移動も開き直しもしない（複製・削除が済んだことは一覧には反映する）。一覧からは `pageRemoved(id)` で外す。
  - **まだ**: 版の中身を見る（`GET …/versions/{n}` は使っていない。一覧から戻すだけ）、写真の zip と Google ドキュメントへの書き出し。競合の帯が出ている（自動保存を止めている）間は、共有・履歴も開かない（先に帯で決める）。検索の結果からは、この画面で削除したページと一覧に読み込んであった子孫だけを外す（読み込んでいない子孫は、次に探すまで結果に残る）。
  - **情報パネル（右のレール。#34 第 3 段）**: ヘッダーのボタンで開閉し、デスクトップではページを替えても開いたまま（狭い画面では開いたページだけ全画面）。出すのは、言語（`PageBody.lang` として題名・本文と同じ自動保存に載せて 1 秒を待たずに送る。次の保存は保存後の revision の上。失敗したらサーバーが持つ言語に戻して「言語を保存できませんでした」。端末の下書きも `lang` を持つ）、著者（ログイン中の名前。肩書は NIHO の役割が要るので出さない）、ページの情報（作成・更新の日付、録音の長さ〔`kind=rec` のときだけ。RSC が既存の `getRecording` から長さだけ〕、本文の文字数〔ja は空白を除いた文字、en は語〕）、Markdown の書き出し、ページの削除（「…」と同じ確認）。**公開の欄はレールに出さない**（発信先・URL・更新・やめるは、ヘッダーの「公開」のシート〔#39〕。カテゴリ・関連する体験の欄はまだ無い）。docs-ui の `ShellPageSettings` に任意の `onExportMarkdown`・`onExportGoogle`（渡さなければ Google ドキュメントのボタンを出さない）・`onDelete`・`langNote` を足してある。

## 手順（#37）

録音ページから手順（記事制作 `tpl-1`・議事録 `tpl-2`・インサイト整理 `tpl-3`。docs-core のテンプレートの写し）を実行し、各段階の結果をサブページ（`kind=step`）に書く。方式は [editor-steps-execution.md](../../docs/architecture/editor-steps-execution.md) の B。**今は実行の骨格だけで、実行器は偽物（`[fake]` の印を付けた決定的な結果。AI は呼ばない）。**

- **API**: `POST /api/pages/{id}/steps/runs`（`{ recipe, fromStep? }`、任意の `Idempotency-Key`。202。進行中は 409 `run_in_progress`、上流が済んでいない `fromStep` は 400 `invalid_from_step`、方式が無いと 503 `steps_unavailable`）、`GET /api/pages/{id}/steps`（最新の run。返す前に前提変更を再計算）、`POST /api/pages/{id}/steps/runs/{runId}/cancel`（冪等）。作法は `/api/pages` と同じ（401・403・404 は同一・413・noindex）。
- **状態の正**は `packages/editor-store/src/step-runs.ts`（表は migration `0006_step_runs.sql`）。遷移はすべて世代と状態を条件にした UPDATE で、claim のたびに世代が進み、確定・失敗・生存確認は世代が一致するときだけ通る（取消・lease 切れの後に遅れて返った結果で上書きしない）。確定（サブページの本文と状態・次の段階）は 1 transaction。
- **サブページの id** は親・recipe・段階から決定的に作る（作り直しても同じページ）。`fromStep` から作り直すと、前の段階の済んだサブページを再利用する。
- **失敗**: 一時的な失敗は 3 回まで（間隔を空けて積み直す）、超えるか入力の誤りなら失敗。後続は取り消し、上流は残す。lease が切れた段階は `sweepExpiredLeases` が積み直す（下の掃除の route から）。
- **前提変更**: 前の段階（段階 0 は録音ページ）の本文と指示文の基準が、実行したときの基準と違えば、その段階から後を `stale` にし、戻れば `done` に戻す。
- **実行**（`src/steps/`）: `runAttempt` が claim → 入力を読む → 生存確認（lease の 1/3 おき）→ 実行器 → 確定 → 次を積む。`inline` は同じプロセスで最後まで進める（要求は待たない）。実行器は `src/server/steps-deps.ts` の 1 か所で選ぶ（今は偽物）。**本物の AI・画面は後段**。
- **`cloud-tasks`**（本番。配備は [editor-deploy.md](../../docs/ops/editor-deploy.md) §10）: `src/steps/cloud-tasks.ts` が Cloud Tasks の REST に task を積む（名前は `taskName`。同じ名前の 2 度目は `ALREADY_EXISTS` で積み済み。再試行の間隔は `scheduleTime`、1 つの task は最大 30 分。アクセストークンは Cloud Run のメタデータサーバーから）。task は同じサービスの worker の route を呼ぶ:
  - `POST /api/internal/steps/run`（本文 `{ runId, stepIndex }`・1 KiB まで）: `runAttempt` を呼び、`completed`・`retry`・`failed`・`stale`・`skipped` のどれも 200 `{ status }`。例外は 500（Cloud Tasks が再試行する）。
  - `POST /api/internal/steps/sweep`（Cloud Scheduler が 5 分おき。本文は読まない）: lease の切れた段階を queued に戻し（`sweepExpiredLeases`）、進行中の run の queued の段階（`listQueuedAttempts`）を全て同じ task の名前で積み直す。200 `{ requeued }`（新しく積んだ数）。
  - **OIDC で守る**: サービスは誰でも呼べるので、route が Google の ID トークンを検証する（`src/server/google-oidc.ts`。依存なし。RS256 だけ・Google の JWKS・`iss`・`aud` = `EDITOR_STEPS_WORKER_URL`・期限（ずれ 60 秒）・`email` = `EDITOR_STEPS_INVOKER_SA` かつ確認済み）。方式が `cloud-tasks` でなければ 404、トークンが無い・通らなければ本文を読まずに 401、`Origin` が付いていれば 403。応答とログは短い code だけ。

## 録音と文字起こし（#36 段 1）

- **API**（全て本人の・ゴミ箱でないページだけ。未認証 401、DB が無い 503、更新系は同じ origin でなければ 403）:
  `POST /api/recordings/import-vtt`（本文 `{ name, vtt, lang? }`。録音ページ（`kind=rec`・本文は空）と文字起こしを 1 つの transaction で作り、201 `{ page, recording, speakers }`）・
  `GET /api/pages/{id}/recording`（200 `{ recording, speakers }`）・`PATCH /api/pages/{id}/recording`（`baseRevision` と、`edits`・`renameSpeaker`・`mergeSpeakers` のちょうど 1 つ）。
  別の人・存在しない・不正な id・削除済み・録音の無いページは同じ 404。400 の本文は `{"error":"bad_request","reason":…}`（`body`・`name`・`lang`・`vtt_empty`・`vtt_too_large`・`vtt_invalid`・`index`・`text`・`speaker`・`merge`）。
- **競合**: 書き込みは `baseRevision` が今の `revision` と同じときだけ（行を `FOR UPDATE` で押さえて比べる）。違えば書かずに 409 `{"error":"conflict","recording","speakers"}` で最新を返す（画面は自分の文章を残したまま、最新に当て直せる）。成功すると `revision` が 1 進む。
- **形**: `segments` は docs-core の `SpeechResultV1` と同じ `{ start, end, text, speaker }`（時刻は秒、話者は 1 始まりの番号か null）。名前は `speakerNames`（番号 → 名前）の表に 1 つだけ持ち、表示は番号から引く（名前を変えると全段落に反映される）。話者名の規則は docs-core の `resolveTranscriptSpeakerName`（60 文字・改行とコロンなし・「話者N」の形は不可・NFKC で同じに見える名前は不可）と、制御文字なし。
- **VTT**（`src/recording/vtt-import.ts`）: docs-core の `parseVtt` で検査し、cue を段落にする。`<v 話者>` は最初に出た順に 1 から番号を付け、規則に合わない名前は番号だけ。1 つの cue に別々の話者がいれば話者ごとに分ける。タグは外し、文字参照は文字に戻す。題名はファイル名（パスと拡張子を除く）、原本は SHA-256 と名前だけを持つ。
- **上限**: VTT は UTF-8 で 4 MiB（取り込みの要求の本文は 5 MiB まで。超えたら 413）、段落は 20,000 個・1 段落 5,000 文字・本文の合計 8 MiB（docs-core の文字起こしの同期上限と同じ）、1 回の `edits` は 200 件（`PATCH` の本文は 4 MiB まで）。
- **表**: migration `0007_page_recordings.sql`（録音ページに 1 行。ページを消す（hard delete）と消える。ゴミ箱の間は残る）。コードは `packages/editor-store/src/recordings.ts`、段落と話者の操作（純粋な関数）は `src/recording/`。
- 音声の取り込み・エンジンは段 2a・2b、マイク録音と文字起こしの開始の画面は段 3b-1、再生とタイムスタンプの画面は段 3b-2（下の各節）。
- **画面（段 3a。音声に依存しない部分）**:
  - **できること**: 「録音から」（`/p/new?from=recording`）で文字起こし済みの `.vtt` を選ぶ（ドロップも可。4 MiB 超は送る前に断る）と、`importVtt` で録音ページを作って `/p/{id}` へ移る。失敗は画面に日本語で出し、選んだファイルは残す。録音ページ（`kind=rec`）は、`PageEditor` の上に文字起こし（`RecordingTranscript`）が入る。段落をその場で直して確定（フォーカスが外れたとき・Enter。変換中は確定しない）すると保存し、話者を押すと名前を変えられ、別の話者にまとめられる（確認は 1 回）。時刻の表示は端末ごとの好み（localStorage）。
  - **保存**: 書き込みは 1 本ずつ順に送り、`baseRevision` は直前の応答の revision。別の画面が先に直していたら（409）自分の文章は消さず、最新に合わせて「別の場所で先に直されました。最新に合わせました」と出す。直した段落は止めておき、「もう一度保存」か書き直して確定すると送る（勝手には送り直さない）。クライアントは `src/lib/recording-client.ts`、サーバーの reason の日本語は `recordingErrorMessage`。
  - **まだできない**: 実データの波形は出さない。音声ファイルとマイクは段 3b-1（下の「画面（段 3b-1）」）、再生は段 3b-2（下の「画面（段 3b-2）」）。「この録音から」（`ShellMakeFrom`）とサブページは手順（#37）の画面で出す。背景情報と「このあと」は入力できるが、まだ使われない（登場人物・固有名詞も未接続）。サイドバーの行は、取り込んだ直後は「録音」の 2 行目が出ない（読み込み直すと出る。`EditorFrame` の `pageCreated` が種類を受けない）。段落の数が多い録音の仮想化はしていない。

## 録音の音声（#36 段 2a）

録音の音声ファイルを、ブラウザから保存先（本番は GCS）へ直接アップロードする（開始 → ブラウザが PUT → 完了）。文字起こしのエンジン（段 2b）・マイク録音と再生の画面（段 3）・bucket の設定そのもの（infra）は含まない。

- **API**（作法は段 1 と同じ: 未認証 401、DB が無い 503、更新系は同じ origin でなければ 403、別の人・存在しない・不正な id・削除済み・音声の無いページは同じ 404）:
  `GET /api/recordings/audio/limits`（200 `{ maxBytes, maxDurationSec, retentionDays, extensions, contentTypes }`）・
  `POST /api/recordings/audio/start`（本文 `{ name, contentType, sizeBytes, sha256, lang?, durationSec? }`、任意の `Idempotency-Key`（UUID）。201 `{ page, recording, speakers, upload: { url, method: "PUT", headers, expiresAt, maxBytes } }`。録音ページ（`kind=rec`・本文は空）・音声の資産・録音（状態 uploading・段落は空）を 1 つの transaction で作る）・
  `POST /api/pages/{id}/recording/audio/complete`（200 `{ recording, speakers }`）。`GET /api/pages/{id}/recording` の `recording.audio` は `{ status: "uploading" | "uploaded", bytes, contentType, expiresAt }`、音声の無い録音（VTT）は null。
- **流れ**: start → ブラウザが `upload.url` へ `upload.headers` を付けて直接 PUT（credentials なし。サーバーは音声を受け取らない）→ complete（保存先の object の大きさが申告と同じなら uploaded）。画面から呼ぶ関数は `src/lib/audio-upload-client.ts`（画面への組み込みは段 3）。
- **エラー**: 400 `{"error":"bad_request","reason":…}`（`body`・`idempotency_key`・`name`・`content_type`・`extension`・`size`・`too_large`・`sha256`・`lang`・`duration`・`too_long`）、413（開始の本文が 16 KiB 超）、503 `storage_unavailable`（保存先を使わない設定）、502 `storage_failed`（保存先の失敗。中身は出さない）、409 `idempotency_conflict`（同じキーで内容が違う・そのキーのページがゴミ箱にある）、409 `{"error":"incomplete","reason":"missing"|"size_mismatch"}`。
- **冪等**: 同じ `Idempotency-Key`・同じ内容（名前・種類・大きさ・sha256・言語・長さを正規化した SHA-256 で比べる）は 200 で同じページ。アップロード中なら ticket を作り直し、済んでいれば `upload: null`。complete は何度呼んでもよい（済んだものは保存先に問い合わせない）。
- **上限**（`src/recording/audio-limits.ts` の 1 か所。**仮置き・オーナーの決定待ち**）: 1 ファイル 2 GiB・6 時間（長さは申告があるときだけ確かめる）・保持 30 日。形式は m4a・mp3・wav・aac・ogg・flac・webm（`audio/webm`。ブラウザのマイク録音の形）で、ファイル名の拡張子と content type が対応すること（content type はパラメータ（`;codecs=opus` など）を除いて比べ、除いた形で持つ。`.vtt` は VTT の取り込みを使う）。超えたら保存（ページ・資産・保存先のセッション）の前に断る。
- **申告値**: `sha256`・`contentType`・`sizeBytes`・`durationSec` はクライアントの申告。サーバーは音声を読まず、sha256 を検証しない（assets.sha256 にも申告のまま入れる）。大きさだけは complete で保存先と照らす。ブラウザでは自前の逐次の SHA-256（`src/lib/sha256-stream.ts`。依存を足さず、`node:crypto` と突き合わせてテスト）で 4 MiB ずつ計算する（段 3b-1）。
- **表**: migration `0008_recording_audio.sql`（page_recordings に `audio_asset`・`audio_status`（none／uploading／uploaded）・`audio_expires_at`・`audio_upload_key`・`audio_request_hash`）。資産は assets（`kind=audio`、`bucket_path` = `audio/{asset id}`）。コードは `packages/editor-store/src/recording-audio.ts`。ページの複製では音声を写さない（音声から作った録音は、録音の行ごと写さない）。
- **保存先**（`src/storage/`。画像（#33）も同じ口で足せる形）: `fake` はメモリの偽物で、ticket の url は同じ origin の `/api/dev/fake-storage/{token}`（`EDITOR_STORAGE` が fake で `NODE_ENV` が production でないときだけ動き、それ以外は 404）。`gcs` は fetch と Cloud Run のメタデータサーバーの token だけ（依存を足さない）で、サーバーが resumable upload のセッションを `ifGenerationMatch=0`（上書きしない）で始め、そのセッション URI を返す（署名付き URL は使わない。実行 ID に署名の権限が無い前提）。ticket の url・token・bucket 名・object の場所はログにもエラーにも出さない。**gcs は実際の GCS では未検証**（fetch を差し替えたテストだけ）。
- **本番の守り**: `NODE_ENV=production` で `EDITOR_STORAGE=fake`、`gcs` で `EDITOR_ASSETS_BUCKET` が無い・不正、未知の値は起動しない（`src/startup-check.ts`。値は表示しない）。要求ごとの解決（`src/storage/runtime.ts`）でも同じ規則で、誤りは 503。入口 `scripts/server-entry.mjs` と Dockerfile は認証だけを見る（AI の設定と同じく変えていない）ので、保存先の誤りは server の起動処理の中で止まる。
- **アプリは音声を消さない**: 30 日での削除は bucket のライフサイクル規則。ゴミ箱の purge は資産の行だけを消し、object は残す（ライフサイクル規則が消す）。

### bucket に要求する設定（infra の側で）

- **ライフサイクル規則**: 条件 `age: 30`（日）かつ `matchesPrefix: ["audio/"]`、動作 `Delete`。アプリはこれを前提に期限（`audio_expires_at`）を出すだけ。
- **CORS**: `origin` は editor の origin（`EDITOR_ORIGIN` と同じ）だけ、`method` は `PUT`、`responseHeader` は `Content-Type`、`maxAgeSeconds` は 3600 など。resumable のセッション URI は開始の要求の `Origin` に応じる仕様だが、あわせて設定しておく。
- **権限**: 実行 ID（`niho-editor-runner`）に作成と閲覧（`storage.objects.create`・`storage.objects.get`）だけ。削除・上書き・署名は要らない。
- 配備で `EDITOR_STORAGE=gcs` を渡すまで、本番の音声の API は 503 `storage_unavailable`。
- 画面の CSP の `connect-src` に `https://storage.googleapis.com` を足した（段 3b-1）。bucket の CORS が無いと、ブラウザの PUT は断られる（画面では「音声を送れませんでした」）。

### 画面（段 3b-1。音声ファイルとマイク、文字起こしの開始と状態）

- **「録音から」**（`src/components/RecordingStartScreen.tsx`）: 音声ファイル（.m4a .mp3 .wav .aac .ogg .flac .webm）を選ぶ・ドロップすると「取り込む」。上限（`GET …/limits` の値。画面の間は覚える）で送る前に断り、sha256（4 MiB ずつ・8 MiB ごとに処理を譲る。`src/lib/file-sha256.ts`）→ 開始（`Idempotency-Key`。同じファイルの取り込み直しは同じキーで同じ録音ページ）→ `XMLHttpRequest` で保存先へ PUT（upload の進み具合・中止）→ 完了 → `/p/{id}`。進み具合は `<progress>` と段階（確認しています・準備しています・送っています・仕上げています）の `aria-live`、失敗は `role="alert"`（URL・内部の情報は出さない）。流れは `src/lib/audio-upload-client.ts` の `uploadAudioFile`。再開（resumable の続き）は無く、失敗したら最初から。
- **マイク**（`src/lib/mic-recorder.ts`・`use-mic-capture.ts`）: 「録音する」→「録音をはじめる」で `MediaRecorder`（`audio/webm;codecs=opus` → `audio/webm` → `audio/mp4` → 既定）。経過時間・「止める」（止めると同じ取り込みの流れに乗る）・「やり直す」（確認 1 回で捨てる）。ファイル名は `録音 YYYY-MM-DD HH-mm.webm`（mp4 は `.m4a`）。6 時間で自動で止める。止めた・捨てた・画面を離れたらトラックを止める。許可の拒否・マイクなし・非対応は文言を分ける。録音中・取り込み中・まだ取り込んでいない録音があるときは、閉じる前にブラウザの確認を出す（画面の中の移動では確かめない）。
- **録音ページ**（`src/components/RecordingTranscription.tsx`。音声のある録音だけ）: 音声がアップロード済みで段落が空なら「文字起こしをはじめる」。状態（待機中・文字起こし中）は 3 秒ごとに読む（画面が見えない間は 15 秒。済んだ・失敗・画面を離れたら止める。続けて 3 回読めなければ「更新できません」で止め、「更新する」で読み直す。`src/lib/use-transcription.ts`）。失敗は理由（`errorCode` ごと）と「もう一度」。段落があるときの「もう一度文字起こしする」・失敗の「もう一度」は、置き換えを 1 回確かめてから `replace: true`。音声の期限（「音声は M月D日に削除されます」／過ぎたら「音声は削除されました」）を小さく出す。外部のエンジンに音声が渡る一言（「音声は文字起こしのため外部のサービスに送られます」）は始めるボタンの近くに 1 行だけ（**文言はオーナー確認待ちの仮置き**）。
- **未検証**: 実際のブラウザのマイク・GCS（CORS を含む）・Deepgram では動かしていない（偽物の XHR・MediaRecorder・fetch のテストだけ）。

### 画面（段 3b-2。再生とタイムスタンプ）

- **音声を読み出す route**（`GET /api/pages/{id}/recording/audio`。HEAD も。`src/server/audio-stream-api.ts`）: 実行 ID には署名 URL の権限が無いので、同じ origin のこの route が保存先から読み出して流す（`<audio src>` がここを指す）。本人の・ゴミ箱でないページの録音で、音声がアップロード済みかつ期限内のときだけ。他人・存在しない・不正な id・削除済み・録音なし・音声なし・アップロード途中・期限切れ・保存先に無いは、どれも同じ 404（本文・header とも）。保存先を使わない設定は 503、保存先の失敗は 502。object の場所は DB の値だけ。本文は保存先の stream をそのまま渡し（全部を読まない）、要求が切られたら・応答の流れが cancel されたら保存先の stream も cancel する。`Content-Type` は開始で受け付けた音声の種類だけ（他は `application/octet-stream`）、`Content-Disposition: inline`（名前は出さない）、`Cache-Control: private, no-store`、`nosniff`。
- **`Range`**（`src/recording/audio-range.ts`）: 範囲は 1 つだけ（`a-b`・`a-`・`-n`）。範囲なしは 200 で全体、ありは 206 と `Content-Range`。終わりが全体を超えたら全体の終わりで切り、`-n` が全体より大きければ先頭から返す。416（`Content-Range: bytes */全体`）は、複数の範囲・形の不正・始まりが全体以上・`-0`・空の音声への範囲。単位が `bytes` 以外は無視して 200（RFC 9110 §14.2）、`If-Range` が付いていたら範囲を無視して 200（検証子を出していないため）。全体の大きさは DB の値（完了のときに保存先の大きさと照らした値）。保存先が範囲を無視して全体を返したら 200 で全体、大きさが食い違ったら 502。
- **画面**（`RecordingTranscript`・`PlaybackSeek`・`src/lib/use-recording-playback.ts`・`playback.ts`）: 音声が再生できるときだけ `<audio preload="metadata">` を持つ。段落の時刻を押すとそこから再生（`onPlayFrom`）、再生ボタン（`onPlay`）は再生と一時停止のトグル、スライダーで再生位置を動かす（キーボードで操作できる）。再生中の段落は現在位置から**二分探索**で求める（timeupdate・seeked・play・pause のたび。時刻の無い段落は対象外、同じ開始時刻なら最初の段落、終わりの時刻は見ない）。変わったときだけ状態を更新し、段落をその場で直している最中でも入力を壊さない。段落の行は `memo`（段落 20,000 の録音で、強調が移るたびの全行の描き直しを避ける）。音声の `error` は「音声を再生できません」と「もう一度」。画面を離れたら止めて `src` を外し、期限の時刻に再生の部品を外す。
- **まだ**: 段落がまだ無い録音（文字起こしの前・失敗のあと）では再生の部品を出さない（3b-1 で段落の欄自体を出さない設計に合わせた。聞けるようにするかは決める）。実データの波形は後続（今はスライダー）。
- **未検証**: 実際の GCS（206・`Content-Range`・416 の実物）・本物の音声（m4a・マイクの webm）・Safari と iOS・本番 build を実ブラウザで開いての確認はしていない（実ブラウザは `next dev` と偽の保存先、合成の WAV）。

## ショートカット（#43）

設計 §11 のキー。Mac は ⌘、それ以外は Ctrl（Mac の Ctrl+K・Ctrl+N は入力欄の操作なので使わない）。入力欄・本文の中でも効く。IME の変換中・ほかの処理が扱った keydown・想定外の修飾キー付き（⌥ など）は無視する。判定は `src/lib/shortcuts.ts` の 1 か所。

| キー | すること | 効く条件 |
| --- | --- | --- |
| ⌘N | 新しいページ（一覧の「＋」→「空のページ」と同じ） | 公開のシートを開いていないとき。新しいページの画面と、移っている最中は二つ目を作らない |
| ⌘K | 一覧を出し、検索の入力欄へ | 公開のシートを開いていないとき |
| ⌘S | 待たずに保存（ブラウザの「ページを保存」は出さない） | ページの画面。⌘S だけはどの端末でも ⌘・Ctrl の両方で、変換中も取る |
| ⌘/ | ブロックの一覧（「＋」と同じ項目）。行が空ならその行を、文字があればその下に足す行を変える。↑↓・Enter・Esc | 本文にフォーカスがあるとき |
| ⌘⇧P | 公開のシート（ヘッダーの「公開」と同じ） | ページ（`/p/{id}`）の画面だけ。一覧・設定・新しいページ・録音から、狭い画面で一覧を出しているときは無視 |

- **ブラウザが先に取るキー**: ページは keydown を `preventDefault` できるときだけ勝てる。⌘N（Ctrl+N）はブラウザのタブでは新しいウィンドウが開き、ページに届かない（そのときは一覧の「＋」から）。Firefox の Ctrl+Shift+P（プライベートウィンドウ）も届かない見込み。どちらも実ブラウザ・インストールした PWA の窓では確かめていない。
- **公開のシートの開き方**: ヘッダーの「公開」、⌘⇧P、ページから `useEditorFrame().openPublish()`。シートの中身（発信先・条件・URL・更新・やめる）は `src/components/PagePublish.tsx`（#39）。⌘⇧P は `src/lib/shortcuts.ts` の判定で、シートが開いているあいだは ⌘N・⌘K を効かせない。

## 公開 API v1（#40）

発信先（NIHO Experience・NIHO・本人のサイト）が公開版を読む API。契約は [editor-publish-api-v1.md](../../docs/security/editor-publish-api-v1.md) と `@niho/editor-publish-contract`。データは Postgres（`DATABASE_URL` が無ければ `/v1/*` もプレビューの発行も 503 `temporarily_unavailable`）。

- **経路**: `src/app/v1/[...path]/route.ts`（GET・HEAD。他のメソッドも handler に渡して 400 ＋ `Allow: GET, HEAD`）。`/v1/{handle}/published.json`・`/v1/{handle}/published/{id}.json`・`/v1/preview/{token}.json`。`src/proxy.ts` は `/v1/` を通さない（CSP の nonce も戻り先の header も要らない。ログインへも移さない）。
- **handler**（`src/public-api/handler.ts`）: 判定の順・404 の同一性・410 の `movedTo`・ETag と `If-None-Match`（認証が先）・header・requestId つきのエラー・query の検証・プレビューの規則を契約どおりにし、返す直前に契約の検証器（`requireProjection`）で自己検証する（通らなければ 503）。資格・token は SHA-256 にしてから引き、ログ・例外には入れない。cursor は不透明（位置と一覧の範囲に結んだ印つき。書き換え・別の handle や include の cursor は 400。印は鍵を使わないので偽造は防がないが、cursor は権限を持たない）。
- **データの port**: `src/public-api/source.ts` の `PublicApiSource`（鍵 → handle、一覧の keyset、handle × id の公開版、プレビュー token の拘束、現在の下書き）。Postgres の実装は `src/public-api/pg-source.ts`（SQL は packages/editor-store の `publications.ts`）。失効・解除・公開をやめた・移動は、記録されていれば時刻によらず効く（時計がずれても失効した鍵で読めない側に倒す）。期限は要求の時刻と比べる。面の資格は `EDITOR_FACE_CREDENTIALS`。
- **プレビューの中身**: 現在の下書き（ページ・資産・公開・公開版を 1 つの読み取りの transaction で読む）から `buildSnapshot` で組み、version と時刻はページの保存の版（`revision`）と時刻（`updated_at`）。その handle に公開している（やめたものも含む）ページは、その公開の設定と、いまの公開版の URL を使う。公開していない handle では、URL を発信先の宣言（本人のサイトは接続の設定、面は `EDITOR_DESTINATION_DECLARATIONS`。stub は同梱の dev 用）から作る（無ければ 404）。著者は token に結んだもの（発行したときの本人。公開・更新が本人の名前で組むのと同じ）で、token に著者が無ければいまの公開版の著者（どちらも無ければ 404）。写真の URL は公開と同じ `EDITOR_ASSET_ORIGIN`（未設定なら写真のある下書きのプレビューは 503）。配線は公開のシート（#39）の部品（`src/publish/config.ts`・`ports.ts`）を `src/server/deps.ts` の `publicApiDeps` でつなぐ。
- **rate limit**: 資格の SHA-256 ごとの 1 分の固定窓、instance ごと（instance が増えると全体の上限も増える）。超えたら 429 ＋ `Retry-After`。
- **プレビューの発行**: `POST /api/pages/{id}/preview-token`（本文 `{ handle }`。本人だけ・同じ origin だけ）。201 `{ token, expiresAt, url }`。ページは本人の・ゴミ箱でないもの、handle は本人が役割で出せる面か本人の解除していない接続（どちらも満たさなければ同じ 404）。15 分、保存はハッシュと著者だけ（`PreviewTokenStore`。表は `preview_tokens`）。NIHO の役割と著者は公開のシート（#39）と同じ（`roleReaderOf`・`sessionAuthors`）: stub は `EDITOR_STUB_ROLES`（既定で両方の面に出せる）、niho は役割の契約（#42）まで面へは出せない（本人のサイトの接続へは出せる）。著者は session の名前で、無い・token に結べない形（256 文字を超える、url が https でない、など）なら著者なしで発行する（migration 0009。発行の前の token も著者なし）。
- **テスト**: `src/public-api/handler.test.ts` が production の handler（＋メモリの `PublicApiSource`）と契約の参照モデル（テスト専用）を、cases.json の全シナリオと合成の world（400 個 × 60 要求、各一覧の cursor の全走査）で突き合わせ、status・header・本文がバイト単位で同じことを確かめる（cursor の文字列だけは違ってよい）。`src/public-api/pg-source.pg.test.ts` は同じ公開・接続の操作をメモリの store と Postgres の store で行い、両方の応答が同じことを確かめる。`test:e2e` は本番の build と実 DB で、鍵・面の資格・410・304・HEAD・プレビューの発行と読み取り（token の著者・stub の役割での面・`EDITOR_ASSET_ORIGIN` の写真の URL）・header を確かめる。
- **Vary**: Next は App Router の全ての応答の Vary に自分の header（`rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch`）を足すので、実際の値はそれに `Authorization` を続けたもの（契約の文言は `Vary: Authorization`。オーナーの判断待ち）。

## 文字起こし（#36 段 2b）

アップロード済みの録音の音声（段 2a）を、サーバー側のエンジンで文字起こしし、話者と時刻つきの段落（段 1 の `segments`。話者名の表は空から）として保存する。失敗しても音声は残り、もう一度できる。マイク録音・再生・タイムスタンプの画面（段 3）・設定画面・エンジンの選択を保存する場所・Gemini（長い音声を区切る処理が Web のサーバー側に無い）は含まない。

- **API**（作法は段 1 と同じ: 未認証 401、DB が無い 503、更新系は同じ origin でなければ 403、別の人・存在しない・不正な id・削除済み・録音の無いページは同じ 404）:
  `POST /api/pages/{id}/recording/transcribe`（本文 `{ lang?, diarize?, replace?, terms? }`。202 `{ run }`＝作って、応答のあとに実行を始めた／200 `{ run }`＝有効な run（queued・running）が既にある。積み直さない）・
  `GET /api/pages/{id}/recording/transcription`（200 `{ run }`。まだ無ければ `{ run: null }`）。`GET /api/pages/{id}/recording` にも `transcription`（最新の run か null）が付く。
  run は `{ id, status: "queued" | "running" | "succeeded" | "failed", engine, language, errorCode, createdAt, startedAt, finishedAt }`。
- **本文**: `lang`（既定は録音の言語）・`diarize`（話者を分けるか。既定 true）・`replace`（既定 false）・`terms`（固有名詞の表記。100 個まで・1 つ 64 文字まで・制御文字なし。Deepgram には docs-core の `deepgramKeyterms` で 500 バイトの予算まで渡す）。エンジンは設定で決まり、要求からは選ばせない。
- **エラー**: 400 `{"error":"bad_request","reason":…}`（`body`・`lang`・`diarize`・`replace`・`terms`）、413（本文が 64 KiB 超）、409 `{"error":"cannot_start","reason":…}`（`audio_not_ready`＝アップロードが済んでいない・音声の無い録音、`audio_expired`＝保持の期限を過ぎた、`has_transcript`＝段落があって `replace` が無い）、503 `transcription_unavailable`（`off`・本番・保存先を使わない設定）。
- **`replace`**: 段落が既にある録音（直した文章を含む）は、`replace: true` が無いと 409 `has_transcript`（直した文章を失わせない）。`replace: true` は確定のときに段落を丸ごと置き換え、話者名の表を空にする（前の段落・直した文章は残らない。録音には版が無いので、画面で確かめてから送る）。確定は録音の `revision` を 1 進めるので、開いている画面の古い revision の書き込みは 409（最新を受け取る）になる。`replace` でない run の間に段落が入っていたら、書かずに失敗（`internal`）にする。
- **失敗の理由**（`errorCode`）: `audio_missing`（音声の資産が無い・アップロードが済んでいない・保存先に無い）、`audio_expired`（保持の期限を過ぎた）、`engine_unavailable`（エンジンに届かない・鍵・混雑）、`engine_rejected`（エンジンが音声・要求を断った）、`engine_timeout`（時間切れ・実行が途中で止まって掃除された）、`engine_bad_response`（応答の形が違う・段落が無い）、`too_large`（応答が 64 MiB・段落が 20,000 個・本文が 8 MiB を超える）、`internal`（保存先の失敗・積めなかった・その他）。どれも音声は消さないので、`POST …/transcribe` で新しい run を作り直せる。
- **実行**（`src/transcription/`）: `run.ts` の `executeRun` が claim（世代を 1 進める）→ 音声の資産 → 保存先から読み出し（`ObjectStorage.readObject（画像の中継 #33 と同じ読み出し）`。GCS は `alt=media` の GET）→ エンジン → 正規化（`normalize.ts`: 話者を最初に出た順に 1 始まりの連番に・時刻順・5,000 文字を超える段落を文の終わり → 空白 → 文字数で割る・上限）→ 確定（段落・ページの更新時刻・run の状態を 1 transaction）。確定・失敗は claim のときの世代と一致して running のときだけ通る（掃除のあとに遅れて返った結果で上書きしない）。状態の表は migration `0012_transcription_runs.sql`（1 ページに有効な run は 1 つ。本文・音声・応答・鍵は持たない）、コードは `packages/editor-store/src/transcription-runs.ts`。`sweepStaleRuns`（古い running を `engine_timeout`、古い queued を `internal` で失敗にする）はあるが、定期の呼び出しはまだ無い。
- **実行の口**: 開発と CI は `inline`（同じプロセスで、応答のあとに実行する）。**本番（`NODE_ENV=production`）は、実行の口（Cloud Tasks に積み、内向きの worker が run の id で `executeRun` を呼ぶ。worker の認証と OIDC は #37 の側）ができるまで、開始は 503 `transcription_unavailable`**（Cloud Run は応答のあとに CPU を絞るので、同じプロセスで長い文字起こしを続けられる保証が無い。偽物の実行器も本番に出さない）。開発で `next dev` を実行の途中で止めると、その run が有効なまま残り、同じページで開始できなくなる（`sweepStaleRuns` で掃除する）。
- **音声が外部のエンジンに渡る**: `deepgram` では、サーバーが保存先から音声を読み出して Deepgram（`https://api.deepgram.com/v1/listen`）へそのまま送る。利用者への表示（外部に送ることの説明）は画面の側（段 3）で必要。鍵・音声・応答の本文・URL・bucket 名・object の場所はログにもエラーにも出さない。**Deepgram と GCS の読み出しは実物では未検証**（fetch を差し替えたテストだけ）。
- **Deepgram の呼び出し**（`src/transcription/deepgram.ts`）: Mac 版（`apps/docs/crates/api-ai/src/deepgram.rs`）と同じ `model=nova-3`・`smart_format=false`・`punctuate=true`・`utterances=true`・`paragraphs=false`・`diarize_model=latest`（話者を分けるとき）・`keyterm`、header `Authorization: Token <鍵>`、本文は音声のバイト列そのまま（`Content-Length` 付き）。違いは `diarize=true|false` を明示すること。応答は 64 MiB まで、`results.utterances` が無い・空なら `engine_bad_response`。
- **偽物**（`src/transcription/fake.ts`。開発と CI だけ）: 音声を読み捨て、`[fake]` の印を付けた固定の段落 3 つ（話者 2 人）を返す。`EDITOR_TRANSCRIBE_FAKE_FAIL`（`unavailable`・`rejected`・`timeout`・`bad_response`）を設定すると、その理由で失敗する（e2e 用。本番では偽物が起動しないので効かない）。
- **画面から呼ぶ関数**（組み込みは段 3）: `src/lib/transcription-client.ts`（`startTranscription`・`getTranscription`・`isTranscriptionDone`）。
- **本番の守り**: `NODE_ENV=production` で `EDITOR_TRANSCRIBE_ENGINE=fake`、`deepgram`・`gemini` でその鍵が無い・不正、未知の値、時間切れの範囲の外は起動しない（`src/startup-check.ts`。値は表示しない）。要求ごとの解決（`src/transcription/runtime.ts`）でも同じ規則で、誤りは 503。入口 `scripts/server-entry.mjs` と Dockerfile は変えていない（保存先の設定と同じ）。

## 本文の画像（#33）

本文に画像を入れる（貼り付け・ドロップ・ファイル選択）。実体は private bucket に置き、**読み取りはサーバーが中継する**（署名付き URL をブラウザへ渡さないので、CSP の `img-src` は `'self' data: blob:` のまま）。アップロードは音声（#36 段 2a）と同じ二段で、保存先の口（`src/storage/`）も同じものを使う。

- **本文に保存するのは資産の id と欄だけ**: 限定 AST の `image`（`assetId`・`alt`・`credit`・`consent`。`src/ast/blocks.ts`）。URL は保存しない。貼り付けた HTML の外部の `<img src>` は文字どおり落とす（`src/editor/paste.ts`。他のサイトの画像に繋いだまま（hotlink）にしない）。
- **API**（本人の・ゴミ箱でないページだけ。未認証 401、DB が無い 503、更新系は同じ origin でなければ 403、別の人・存在しない・不正な id・削除済み・画像でない資産・まだ済んでいない画像は同じ 404）:
  `POST /api/pages/{id}/images/start`（本文 `{ contentType, sizeBytes, sha256 }`、任意の `Idempotency-Key`（UUID）。201 `{ assetId, upload: { url, method: "PUT", headers, expiresAt, maxBytes } }`）・
  `POST /api/pages/{id}/images/{assetId}/complete`（200 `{ image }`）・
  `PATCH /api/assets/{assetId}`（`{ alt?, credit?, consent? }` のうち 1 つ以上。200 `{ image }`）・
  `GET /api/assets/{assetId}`（中身の中継。`Content-Type` は行の値、`Content-Disposition: inline`、`X-Content-Type-Options: nosniff`、`Cache-Control: private, max-age=86400, immutable`）・
  `GET /s/{token}/a/{assetId}`（共有リンクの中継。ログイン不要。`Cache-Control: private, no-store`）。`image` は `{ assetId, pageId, status, bytes, contentType, alt, credit, consent }`（object の場所・sha256 は出さない）。
- **流れ**: start → ブラウザが `upload.url` へ直接 PUT（credentials なし）→ complete（保存先の object の大きさが申告と同じなら ready）。画面から呼ぶ関数とエディタに渡す口は `src/lib/image-upload-client.ts`。
- **エラー**: 400 `{"error":"bad_request","reason":…}`（`body`・`idempotency_key`・`content_type`・`size`・`too_large`・`too_many`・`sha256`・`alt`・`credit`・`consent`）、413（開始の本文が 4 KiB 超・欄の本文が 16 KiB 超）、503 `storage_unavailable`、502 `storage_failed`、409 `idempotency_conflict`、409 `{"error":"incomplete","reason":"missing"|"size_mismatch"}`。
- **上限**（`src/image/image-limits.ts` の 1 か所）: 受け付ける種類は `image/jpeg`・`image/png`・`image/webp`・`image/avif`・`image/gif`（**SVG は script を持てるので受け付けない**）、1 枚 **20MB**、1 ページ **100 枚**、alt 1000 文字・クレジット 500 文字。種類と大きさはブラウザでも先に見て、枚数はサーバーが数える。超えたら保存（資産の行・保存先のセッション）の前に断る。
- **申告値**: `sha256`・`contentType`・`sizeBytes` はクライアントの申告（ブラウザで sha256 を計算して送る）。サーバーは中身を読まず、sha256 を検証しない。大きさだけ complete で保存先と照らす。中継のときだけ中身を通す。
- **冪等**: 同じ `Idempotency-Key`・同じページ・同じ内容（ページ・種類・大きさ・sha256 を正規化した SHA-256 で比べる）は 200 で同じ資産。アップロード中なら ticket を作り直し、済んでいれば `upload: null`。complete は何度呼んでもよい。
- **エディタ**（`src/editor/`）: `image-node.ts`（TipTap のノード。block・atom・draggable、貼り付け・ドロップのファイルを受ける plugin、「/」「＋」の「画像」からのファイル選択）と `ImageNodeView.tsx`（React の NodeView。`src` は中継の path。**画像を選ぶと alt・クレジット・掲載許諾の欄をここに出し**、直すと本文の自動保存と資産の行の両方へ入る）。入れられないとき（ページがまだ無い・種類・大きさ・枚数・失敗）は本文を変えずに、本文の下に理由を出す。
- **表**: migration `0011_image_assets.sql`（assets に `upload_status`（uploading／ready）・`upload_key`・`request_hash`）。資産は assets（`kind=image`、`bucket_path` = `image/{asset id}`、`alt`・`credit`・`consent` は 0001 から）。コードは `packages/editor-store/src/images.ts`。
- **共有リンク**: `/s/{token}` の本文の画像は `sharedImageAsset`（その token のページの、ready の画像だけ）で絞って中継する。描くのは `src/share/render-blocks.tsx`（`assetSrc` を渡さなければ画像を描かない＝読めない `img` を置かない。クレジットは `figcaption`）。**ページの複製（#34）は本文（資産の id）を写すが資産の行は写さない**ので、複製したページの共有リンクでは画像が出ない（資産は 1 つのページに属する。必要になったら写す側で足す）。
- **消さない**: アプリは画像の object を消さない。ゴミ箱の purge は資産の行だけを消し、object は残る（`purgeTrash` が場所を返す。画像には音声のような期限のライフサイクル規則を置かない）。

## 本文の囲み（#33）

補足や注意を本文から少し浮かせて置く入れ物。限定 AST の `callout` で、**属性は持たない**（種類・色・見出しの区別を作らない）。
中に置けるのはこの schema のブロックだけ（`block+`）＝ 保存のときに限定 AST の検査を必ず通る。空の囲みは作れない。

- 作り方: 「/」「＋」のブロックの一覧の「囲み」、または書式の帯の「行の種類」。引用と同じ扱い（行の種類のひとつ）。
  ローマ字の別名は `kakoi`（`kakomi` にすると `mi` を含むので `/mi` の見出しに混ざる。別名は部分一致なので `kako` で当たる）。
- 外し方: 「行の種類」の「テキスト」（中のブロックはそのまま残る）。
- DOM は `aside[data-callout]`。見た目は共有の docs-ui（`packages/docs-ui/src/styles/editor.css`）に置き、Web と Mac で同じにする。
  `aside` にしているのは、本文から少し外れた補足だと読み上げにも伝わるため。
- 共有ページ（`/s/{token}`）も同じ `aside[data-callout]` で描く（`src/share/render-blocks.tsx`）。
- Markdown の書き出しでは引用と同じ `:::note`（`src/export/markdown.ts`。#69 で入っていたので、ここでは変えていない）。

## 発信先の設定（#41）

`/destinations` と `/destinations/{id}`。画面は共有の docs-ui（`packages/docs-ui/src/shell/editor-destinations.tsx` の
`EditorDestinationsPage`・`EditorSitePage`。モック v6 の V.dest・V.site）で、`src/components/DestinationsView.tsx`・`SiteView.tsx` が
状態と通信だけを持つ。実処理は `@niho/editor-publish` の `ConnectionService`（docs/architecture/editor-publish-core.md「#41 発信先の設定」）。

- **一覧**: NIHO の面（`exp`・`niho`）は役割で自動に出て、役割が無い・宣言が読めないときは理由を一言。本人のサイトは接続ごとに 1 行
  （公開中の数つき）。「発信先を追加」で `mode`（公開 API で受け取る／WordPress／Ghost）・handle・サイトの URL・記事の前に付く path を入れる。
- **サイトの設定**: 公開 API の URL（コピー）、鍵（伏せ字と再発行）、送り方、書き出し（Markdown ＋写真の zip）、URL の形の編集、
  この発信先に公開した一覧（公開をやめたものも）、接続の解除。
- **鍵**: 平文は**作ったとき・再発行したときの応答にだけ**入り、画面はその 1 回だけ出す（「閉じる」で消える）。保存するのは
  SHA-256 と末尾 4 文字で、ほかの場所に出るのは `ek_••••••••` ＋末尾 4 文字。URL・localStorage・ログ・エラーの本文には出さない。
  再発行は旧鍵の失効と同じトランザクションで、**次の request から**公開 API が旧鍵を 401 にする。
- **接続の解除**: 鍵の失効・接続の解除・その接続に公開中のページを「公開をやめた」にすることを同じトランザクションで行う（ページは残る）。
  解除した接続は設定できず、画面は一覧へ戻る。書き出しだけは解除のあとでも呼べる。
- **WordPress・Ghost**: v1 では入口だけ（`mode` を保存できるが送信は動かない。`pushEnabled` は常に false）。画面にも一言出す。
- **API**: `GET/POST /api/destinations`、`GET/PATCH /api/destinations/{id}`、`POST /api/destinations/{id}/key`、
  `POST /api/destinations/{id}/disconnect`、`GET /api/destinations/{id}/export`（`src/server/connections-api.ts`）。
  未認証 401、別の origin からの更新 403、別の人・存在しない・不正な id はどれも同じ 404、DB なし 503。
  書き出しの写真は保存先から読む（`src/publish/export-assets.ts`。1 回で 200 MiB まで。超えたら 413 で、公開版と下書きは変わらない）。

## 設定（#108）

`/settings`。画面は共有の docs-ui（`packages/docs-ui/src/shell/editor-settings.tsx` の `EditorSettingsPage`。モック v6 の V.settings）で、
`src/components/SettingsView.tsx` が状態と通信だけを持つ。節は AI・手順・文字起こし・保存の 4 つ（モックのプロフィールは NIHO アカウントの値なので持たない）。

- **変えられるもの**（`editor_settings`。migration `0013_editor_settings.sql`、コードは `packages/editor-store/src/settings.ts`）:
  - **AI の提案の言語**（書いた言語のまま／日本語／English）。`buildRequest` の `lang` になる（`src/ai/engine.ts`）。
  - **固有名詞と誤りやすい表記**。AI の提案のプロンプトの表になる（`src/ai/prompt.ts` の `glossary`）。
  - **手順**（段階の名前・指示・お手本）。既定の 3 つ（docs-core の `FLOW_TEMPLATES`）に手を入れた写しと、足したものだけを保存し、
    読むときに既定へかぶせる（`src/steps/recipes.ts` の `recipesOf`）。既定の値を送り返すと写しが消えて既定に戻る。
    既定の手順は**段階の数を変えられない**（できあがったサブページがその段階の id に結んでいる）。
    手順は次に始めた run から効く（受付は `src/server/steps-api.ts`、worker は `claim.owner` で読む。`src/steps/runner.ts`）。
- **読むだけのもの**（サーバー側が決める。`src/settings/facts.ts`）:
  - **文字起こしのエンジン**（`EDITOR_TRANSCRIBE_ENGINE`）と 1 回の時間切れ。Web からは選べない。Gemini は長い音声の区切りがサーバー側に無いのでまだ出さない。
  - **音声の上限**（1 ファイルの容量と長さ・受け付ける形式）と、**クラウドの音声が消えるまでの日数**（`src/recording/audio-limits.ts`。設計 §12 の「設定に明記」）。
  - **保存先**（公開と同じ読み手で NIHO から毎回読み、editor に保存しない。設計 §2.1）。Web では選べない。
- **AI の使用量**: 画面が `GET /api/ai/usage` を開いたときに 1 回読み、上限の 80% を超えていたら一言出す。
- **API**: `GET /api/settings`・`PATCH /api/settings`（`src/server/settings-api.ts`）。未認証 401、別の origin からの更新 403、DB なし 503、
  通らない値は 400（何も書かない）。渡した項目だけを入れ替え、入れ替えた後の設定を返す。owner は認証の層の本人だけで、要求の値からは決めない。

## まだやらないこと

見た目（#48）、版・履歴・オフライン・ブロックと「/」メニューの仕上げ・IME の扱い（#33）、プレビューを開く画面（token の発行は API だけ。#40 の後）、公開の知らせ（録音は公開版に含まれない、など）の表示と、公開のシートで本人のサイトが 2 つ以上のときの選び方（#39 の後）、録音の開始（#36）、検索の絞り込み（#35）、役割とつながりの中身（#42）、WordPress・Ghost への送信（#41 は入口だけ）、GCS バケット・Cloud Run・Cloud SQL・NIHO接続の実環境設定と受入。
