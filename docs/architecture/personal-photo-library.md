# 本人の写真ライブラリ v1

Epic #148 / P00 #149。2026-11-01の契約。本文と [`photo-library-contract`](../../packages/photo-library-contract/) を後続 #150〜#162 の正本とする。これは設計と合成fixtureの確定であり、本番の認証・API・保存・編集・配布の実装完了を表さない。

## 1. 利用者に提供するもの

- Macの「このMac」はフォルダを開く既存機能を維持する。ログイン不要・NIHOの利用費用ゼロ・ローカルファイルを自動送信しない。
- 「NIHOクラウド」は本人専用の写真置き場。NIHOの安定したユーザーIDごとに初期1ライブラリ、5 × 1024³ = **5,368,709,120 byte**。表示は「5GB」とし、容量表示のヘルプでバイトの定義を説明する。
- 同じアカウントのMacとiPhoneが同じ原本・補正・版を読む。拠点への所属やホスト権限を必要としない。別ユーザーの招待・公開共有リンク・拠点写真の自動移行はv1に含めない。
- iPhoneは保護された `/photo` をSafariで開く。ホーム画面へのPWA追加は任意で、同じUIとAPIを使う。インストールしない利用者も閲覧・追加・編集できる。iOSネイティブアプリは新設しない。
- 常設の自前サーバー連携は後続企画。今回のクラウド用workerを利用者の私有サーバーに依存させない。

文書のcloud-only方針はNIHO photoのローカルモードに適用しない。文書のPage、録音、既存の拠点共有ライブラリとも台帳・APIを分ける。

## 2. 実装するリポジトリと認証境界

| 面 | 実装先 | 契約 |
| --- | --- | --- |
| 個人写真API・Web/PWA・DB・media処理 | `niho-life/niho-editor` | 本文、`packages/photo-library-contract` |
| 再利用する編集UI・engine・SDK生成器 | `niho-life/niho-photo` | immutable SDK releaseとそのmanifest |
| Macのクラウド接続・「クラウドにコピー」 | `niho-life/niho-photo` | P08の共通adapterを固定版で採用し、既存cloudBindingへ注入 |
| NIHOの本人確認・失効・退会イベントの最終接続 | 非公開の認証側 | P01が公開側のverified-actor接続口を満たす。公開へ実URL・鍵・運用値を書かない |
| 本番のDB/storage/worker権限・署名・配備 | 非公開の運用側 | P13で接続・受入・配布。公開CIから実行しない |

`apps/editor-web/src/auth/niho.ts` はP01でNIHO editor専用のopaque browser session consumerになった。ただしfeature flag、双方の固定origin/callback、実アカウントでの受入はP13の配備事項であり、既存のログイン画面や合成テストを本人の写真が本番で使える証拠にしない。

### P01の認証プロトコル

- clientは`niho-editor`、写真APIのaudienceは`niho-photo`に固定する。native AppConnect、Experience editor、一般NIHO APIのcredentialを相互利用しない。
- WebのBFFがstateとPKCE verifierを生成し、NIHO側の相対endpointで10分のattemptを開始する。BFF cookieは`__Host-` prefix、Secure、HttpOnly、SameSite=Lax、Path=/で、attempt ID、state、verifier、安全なeditor内の戻り先、期限だけを保持する。cookie自体はrequest timeout margin（10秒）だけattempt期限より長く残し、callbackは10分の期限を厳守する一方、logoutと次のbeginはmargin中の期限切れproofもcancelへ送る。重複cookie、余分なfield、外部戻り先を拒否する。
- browser接続はprotocol v2（`responseMode=form_post`）に固定する。beginは固定の`/api/auth/editor-connect/request`だけを返す。BFFのstandalone formからNIHOへattemptId/stateをPOSTし、NIHOは登録済みconsumer origin・form・DB stateを確認して短期HttpOnly request Cookieへ束縛し、queryなしの確認画面へ303する。確認画面とログインreturn URLにもcode/stateを載せず、v1 query transportへfallbackしない。
- NIHOの確認画面は固定の「NIHO editor」「本人用の写真同期」だけを表示する。ログイン中のactiveなLOGINアカウントが明示承認したときだけ、5分・一回限りのcodeを、query/fragmentのない固定callbackへcode/stateのform POSTで返す。private DBはstate/code/credential secretのhashだけを保存する。
- callbackはNIHO originからの厳密なPOSTを受け、Cookieを書き替えず・exchangeせず、同じoriginへ再POSTするstandalone relayを返す。同じoriginのPOSTだけがpending stateと期限を照合してからcode＋verifierを交換する。これによりcross-site POSTでもSameSite=Laxを維持する。成功時だけopaque credentialを`__Host-editor-niho-session` cookieへ置き、pendingを消す。無効・古いcallbackは現在のpending cookieを消さない。
- browser sessionは毎要求NIHO introspectionを通し、canonical `User.id`、LOGIN/deleted、Firebase失効、auth time、親session、子credential世代、期限を再確認する。30日目安の親sessionと複数の10分grace世代でrefreshを線形化し、3並列refreshの応答が逆順に届いても有効にする。期限外世代の再利用は親sessionを失効する。
- logoutはsession revokeとpending cancelの両方が成功するまでcookieを保持し、NIHOが確認不能なら再試行可能な503にする。新規接続では、そのブラウザが`replaceCredential`として提示した旧cookieだけを失効し、同じcanonical IDのiPhone Safari・PWA・別ブラウザsessionを一括失効しない。取消、交換、refresh、logoutはDB row lockで競合を閉じる。
- Mac bearerは公開サーバーから固定のMac検証endpointへだけ渡す。NIHO側が`niho-camera`のnative ID tokenを署名・issuer・audience・期限・失効込みで検証し、active AppConnectionと同じcanonical `User.id`を返す。公開側はJWTをdecodeしただけでは本人にせず、browser cookieとbearerが同時なら曖昧な認証として拒否する。
- `GET /api/photo/v1/auth/session`は`sessionId`、`userId`、`expiresAt`、`refreshRequired`だけをno-storeで返す。token、cookie値、email、roleは返さない。写真は`POST /photo/auth/refresh`でcookieを書き替え、同一origin以外を拒否する。

認証formのHTMLは要求と独立したnonce・送信先を限定したCSP・no-store・`Referrer-Policy: origin`を持つ。Originの欠落/null/不一致、重複/余分なfield、4KiB超、2秒の時間切れ、不正UTF-8を拒否する。長期credentialとPKCE verifierをHTML/JavaScriptへ出さない。Nextのdocument CSPとreferrer例外は`/auth/login/start`、`/auth/callback`、`/photo/auth/start`のexact pathだけで、通常画面とGoogle GET callbackの方式は維持する。

公開側の接続先は`EDITOR_NIHO_ORIGIN`にpath/query/fragment/credentialsのないexact HTTPS originを設定する。`EDITOR_AUTH_MODE=niho`で未設定・不正ならportを開く前に停止する。全server fetchはredirect拒否、no-store、時間切れ、応答byte上限、closed response shapeを持つ。公開リポジトリの例は`.invalid`だけとし、実origin、callback、project、identity、secretは置かない。NIHO editor sessionは写真本人確認専用で、Google Docs用の`apiToken`はnullのままにする。

### Docsと写真の認証を同じoriginで併用する

既存Docsは`EDITOR_AUTH_MODE=google`と既存Google cookie・所有者IDを維持できる。写真だけは明示された有効な`EDITOR_NIHO_ORIGIN`からNIHO providerを選び、`/photo/auth/login`・`/photo/auth/start`・`/photo/auth/refresh`・`/photo/auth/logout`を使う。未設定なら写真の接続は閉じ、Googleやstubの本人へフォールバックしない。別cookieのGoogle本人BとNIHO本人Aが同居しても、写真catalog/transfer/recipe/lifecycle/sessionの本人はAになる。メールによるID連結・所有者の移行はしない。

固定callbackは既存の`/auth/callback`を使う。GETはDocsの既定provider、POSTは写真用NIHO providerへ渡す。戻り先は`/photo`、`/photo/trash`、`/photo/<UUID>`だけに閉じ、写真の認証routeやDocsへのループを許さない。写真のproviderが返す失敗・logoutのログイン先だけを写真ログインへ戻し、成功先・Cookie・CSPを保つ。Macのbearer検証はこのbrowser選択から独立する。

この配線は写真storage/providerやPWA画面の有効化を意味しない。下記の実環境受入とP13のprovider・容量・失効確認は別に必要である。

### 実環境の受入（P13）

合成テストとは別に、flagと双方の固定設定をオーナーが投入した環境で次を証跡化する。

1. 同じNIHOアカウントでiPhoneのWebとMacから接続し、auth snapshotの`userId`が同じcanonical IDになることを、tokenやcookie値を記録せず確認する。
2. 別アカウントでは別IDになり、相互の写真ID・asset IDを指定しても同じ404になることを確認する。
3. logout、全端末logout、退会、Firebase失効、featureのglobal kill後に、既存cookie・Mac token・遅着callback・遅着refreshが拒否されることを確認する。
4. NIHO停止時は既存sessionを未認証へ黙って落とさず503になり、logout cookieを保持して再試行できることを確認する。
5. flag未設定ではprivate routeが404、公開側のNIHO origin未設定・不正では起動がfail-closedになることを確認する。

P01では実写真を使わず合成fixtureだけを使う。写真API、store、adapter、写真UI、完全なクラウド有効化はそれぞれの後続writerとP13の範囲である。

### 本人の導出

サーバーだけが `VerifiedPhotoActor` を構築する。`userId` はNIHOのcanonicalな安定IDで、メール、クライアントが渡すownerId、拠点ID、OAuthクライアントごとに異なる可能性のあるsubをそのまま使わない。P01の私有接続でMacとWebが同じIDになることを実証する。サーバーで本人に一意なライブラリを遅延作成し、DBに `UNIQUE(owner_id)` を置く。

- Web/Safari/PWA: server-side session＋Secure/HttpOnly/SameSite cookie。アクセストークンをJS・localStorage・IndexedDBへ出さない。全POST/PUTはJSON、正規originの照合を必須にする。Originの欠落・不一致は403。lookupやticket更新もPOSTなので対象。
- Mac: 接続で得た写真API向けbearerをhostの安全な保存先で管理し、API側でissuer/audience/用途/期限/失効を検証する。汎用のID tokenを無条件に受け入れない。cookie認証と混用せず、Macを理由に検証を省かない。Originが送られた場合は許可値を照合する。
- 未認証・失効は401。IDが不正・存在しない・別人所有は同じ404。全SQLとjoinをownerで絞り、assetもphoto・ownerとの関係を再確認する。IDやdigestを知るだけでは読めない。
- requestのschemaは閉じる。所有者・quota・object locator・role・libraryIdをbodyやqueryで指定させない。本人以外のリソースを知る必要のない経路を作る。
- ログアウト・アカウント切替・401で転送とworkerをabortし、QueryClient、object URL、写真bytes、本人のdraftを破棄する。再ログインで前のアカウントの表示を引き継がない。

すべてのJSON・写真・エラーは `Cache-Control: private, no-store`、`X-Robots-Tag: noindex, nofollow`、`Referrer-Policy: no-referrer`。内容をservice worker、CDN、analytics、エラー本文へ流さない。API・contentはrequestごとに認証し、ログアウト後の新規取得を止める。取得済みの端末内コピーを遠隔で消せるとは約束しない。

## 3. HTTPと互換性

prefixは **`/api/photo/v1`**。成功は型どおりのJSON、失敗は `PhotoErrorEnvelope`。status/codeは `PHOTO_ERROR_STATUS` が正本。GETにbodyを載せない。path項目はpath、一覧条件・hash以外の読取条件はquery、Rangeはheader、残りはJSONに置く。`content.get` だけ200/206のbyte streamで、範囲不正は416 `range_not_satisfiable`。範囲の検査より先に本人・assetの関係を検証する。

| operation | method / 相対path | writer |
| --- | --- | --- |
| library.get | GET `/library` | P04 |
| photos.list | GET `/photos` | P04 |
| photos.get | GET `/photos/{photoId}` | P04 |
| photos.info | GET `/photos/{photoId}/info` | P04 |
| photos.lookup | POST `/photos/lookup` | P04 |
| uploads.start | POST `/uploads` | P03 |
| uploads.get | GET `/uploads/{uploadId}` | P03 |
| uploads.renew | POST `/uploads/{uploadId}/renew` | P03 |
| uploads.complete | POST `/uploads/{uploadId}/complete` | P03 |
| uploads.cancel | POST `/uploads/{uploadId}/cancel` | P03 |
| content.get | GET `/photos/{photoId}/content/{assetId}` | P03 |
| masks.get | GET `/photos/{photoId}/masks/{surfaceId}` | P03 |
| recipes.put | PUT `/photos/{photoId}/recipe` | P05 |
| versions.get | GET `/photos/{photoId}/versions` | P05 |
| versions.put | PUT `/photos/{photoId}/versions` | P05 |
| media.ensure | POST `/photos/{photoId}/media` | P06 |
| photos.trash | POST `/photos/{photoId}/trash` | P07 |
| photos.restore | POST `/photos/{photoId}/restore` | P07 |
| photos.purge | POST `/photos/{photoId}/purge` | P07 |
| jobs.get | GET `/jobs/{jobId}` | P07（purge専用） |

`PHOTO_ROUTES` がmethod/path/idempotencyを機械可読にする。必要なmutationは **`Idempotency-Key`** を付ける。keyは本人・operation・リソースでスコープし、正規化したpayload hashをDBで照合する。同じkeyとpayloadは同じリソースの結果＋`replayed:true`、異なるpayloadは409 `idempotency_conflict`。元の認証や現在のリソース状態は再送時にも確認する。purge済みのphotoを古い成功応答で復活させない。

resource IDはserver発行のUUID、digestは小文字64桁hex、byte/revision/pixelは非負のsafe integer（入力size/寸法は正）。不正な型・limit範囲外・未知queryは400。JSONの深さは32以下、fileNameと版名はUTF-8で255 bytes以下、ファイル名の制御文字とpath区切りを拒み、storage pathとして解釈しない。idempotency keyは16〜128文字のASCII英数字/`-`/`_`。recipe bodyはJSON 2MiB、versions bodyは5MiB、それ以外のJSON bodyは64KiBを上限にし、個別payloadの上限も照合する。

uploadの重複startでは新規201・既存200、completeでは検証中202・保存済み200、purgeは202、その他の成功は200。一時失敗はretryableと必要ならRetry-Afterを返す。ticket更新は古いbearerを再掲せず新規発行するので、idempotency対象外。完了記録はuploadが参照可能な間保持し、key単体の短期キャッシュだけに依存しない。

startの再送は同じupload IDと**現在の進行状態**を返す。reservedなら新ticket、verifying/storedならticket:nullで、古いbearerを再掲しない。cancelled/expired/rejectedのuploadを同じkeyで再開せず、現在の失敗を返す。renewはreservedだけ受け付け、その他はupload_state_conflict（期限切れはupload_expired）。

v1へ互換な応答フィールドを追加できるが、既存requestや意味は変えない。破壊的変更は `/v2` とpackage majorを増やす。旧SDKのengineやsettingsを新既定へ暗黙変換しない。共通 `niho-cloud-contract` の拠点・共有用v1は改変せず、この本人用contractを別packageで管理する。

## 4. 原本・予約・5GBの台帳

P02が次を一つのowner lock/transactionで守る。

```text
usedBytes = originalBytes + maskBytes
availableBytes = quotaBytes - usedBytes - reservedBytes
0 <= usedBytes + reservedBytes <= 5,368,709,120
```

- 課金対象は、本人の再生成できない保存済みbinary（原本とマスクの面）。ゴミ箱中と物理削除待ちもusedに含む。trashBytes/pendingPurgeBytesはusedの内数で、加算し直さない。
- 再生成可能なthumbnail/preview/working-copyはサービス側のcache費用。recipe/historyは上限付きmetadataとして写真容量から除外する。これを「全物理使用量が5GB」と説明しない。worker・cache・一時uploadの別上限と清掃は運用で守る。
- 新規予約はdeclared bytesをreservedへ原子的に足す。sizeは正のsafe integer。検証で元bytesと違えば確定せず、quotaの差額を無断追加しない。確定はreservedからusedへ一度だけ移す。
- 原本は本人内のsha256＋sizeで重複照合する。本人の検証済み原本が既にあればstartは既存photoを返し、容量追加・上書き・補正の置換をしない。ゴミ箱の同原本は409 `photo_trashed` とし、明示restoreを求める。他人の同hashは照合せず存在を返さない。
- maskはphoto内のdigestで重複照合する。別photoで同じ面を使えばそれぞれ計数する。原本・各photoのmaskはそれぞれ別のquota参照とし、物理dedupを理由にowner境界を混ぜない。
- 同時予約の勝者だけが残量を取得する。cancel/expiry/失敗の解放も一度だけ。verifyingのleaseを単純な時刻超過だけで解放し、古いworkerをcommit可能なまま残してはいけない。

### upload状態

```text
reserved -> verifying -> stored
reserved/verifying -> cancelled | expired | rejected
```

予約の有効期間は24時間、PUT ticketは最大15分。再開時はuploadIdを読み直し、storageで確認したoffsetからrenewする。端末に保存してよいのは本人にscopeしたuploadId・digest・サイズ等の再開情報までで、bearer URLや元の絶対pathは保存しない。元ファイルを失ったiPhoneでは選び直してdigestを確認する。バックグラウンド中の完走は約束しない。

PUTは**一時領域だけ**を指す。完了時にサーバーがsize・sha256・magic bytes・形式・寸法を検証し、検証したgenerationだけを条件付きでimmutableな確定領域へ移す。クライアントに確定領域の上書き権限を渡さない。PUT再送や期限内ticketの再利用が確定後の原本を変えない。サーバーが全byteのsha256を計算し、providerのstat/MIME宣言だけで確定しない。

P03は既存の音声用ObjectStorageを変更せず、photo専用portを作る。staging ticket/offset、generation指定のstat/read/copy/delete、size/content検証の結果を扱える形にする。既存portはsize/contentTypeだけをstatし、実行権限もcreate/readだけなので、そのままphotoの確定や削除に使わない。写真原本へ音声用の30日lifecycleを適用しない。

cancel/expireはworker leaseをfenceし、古い検証完了をcommitさせない。copy済みだがDB未確定のobject、遅着PUT、一時object、重複原本の余剰copyをgeneration付き清掃台帳へ残す。process停止後のreconcilerが回収できることをP02/P03/P07で検証する。

**`storageState:stored` は原本の恒久保存完了。** 検証中にはPhotoを通常一覧へ出さない。恒久保存後、outboxからworker jobが作成されるまではmediaを`pending`とし、job作成後はqueued/processing/ready/failed/unsupportedへ進む。preview生成失敗だけで原本や編集値を失わせない。画面の「アップロード中」「確認中」「保存済み・プレビュー準備中」を区別する。

## 5. 形式・寸法・media

| 項目 | v1の契約 |
| --- | --- |
| 入力の原本 | 1ファイル256MiB以下、向き適用後100,000,000 pixels以下。pixel allocation前に検査 |
| 初回配布に必要な形式 | JPEG、PNG、HEIC/HEIF。RAWは実decoderで検証した機種・形式を公開capabilityに出す |
| RAW | SDKの登録拡張子を受付候補にし、全機種対応とは表示しない。初期受入に検証済みRW2経路を含む |
| TIFF | SDKの候補に含むが、server providerの受入が完了するまでingest:false |
| browser直接入力 | SDKの上限に従い40MP以下。JPEG64MiB、その他10MiBを超える直接読取を避け、working-copyへ迂回 |
| canonical working-copy | 長辺2560以下、SDKのpng16/jpeg8＋正確なbaseVersion/meta。単なる縮小previewを代用しない |
| 一覧thumbnail / preview | 長辺512 / 1280以下。向き適用、sRGB、位置・不要なEXIFを除く |
| マスクの面 | SDKの正規8bit gray PNG、8MiB以下、1〜4096px、PNG内容のsha256がsurface ID |
| recipe/history | 1 recipeのcanonical JSONは1MiB以下、version配列全体4MiB以下、最大100版 |

capabilityのingest/workingCopyは、実行中providerが処理できる範囲だけtrueにする。保存を許可する前にserverで形式・寸法をprobeし、未対応や偽装を拒む。検証済み原本に対する一時的なmedia失敗は再試行可能とする。

現行SDKのHEIC/TIFF用Apple helperはmacOS依存で、Nextサーバーへ置くだけではLinuxで動かない。P06は `workers/photo-media/` にprovider境界を作り、サーバー用HEIC decode/色/向きのbridgeを追加する。Linuxの段1 RAWにはSDK source内の `niho-base-raw` を使えるが、配布用のMac native closureがそのままserver用の全形式decoderになるとは扱わない。provider・ライセンス・実decode・実行環境の証跡はP06/P13の出荷条件で、HEICを仮にtrueにしたfixtureはその証拠ではない。

media jobはowner/photo/original generation/baseVersion/settings hash/recipe revision/engine manifest hash/出力寸法に束縛する。古いrevisionのpreviewを現在の補正済み画像として公開しない。原本・working-copy・previewは別asset。jobは重複enqueueしても同じキーへ収束し、結果公開前にowner・現revision・非削除状態を再確認する。mediaの状態はphoto再取得で読み、purge用jobs.getと混ぜない。

`POST /photos/{photoId}/media`は閉じた`{recipeRevision}`とIdempotency-Keyを必須にする。owner lock/transaction内で現在版・成功receipt・job収束と再試行を確定し、古い版は409/currentRevisionを返す。同じkeyと本文の成功replayは現在状態を返し、jobや試行予算を更新しない。同じkeyで本文を変えれば409 idempotency_conflictとなる。新しいkeyでfailed jobを明示再試行するときだけ予算を戻して旧claimをfenceし、原本・容量を再登録しない。queued/processing/ready/unsupportedを新しいkeyだけで初期化しない。

## 6. 補正・マスク・複数端末の競合

recipeのrevisionは0から始め、**全保存でexpectedRevision必須**。現在値が一致するときだけ+1し、409 `revision_conflict` ではcurrentRevisionを返す。adapterが最新photoを読み直してSDKの`stale`へ対応する。last-write-winsや自動のengine昇格を使わない。Macの未送信編集は本人＋写真hash＋generationに結び付け、競合時に利用者が選べる状態で残す。

`RecipeDocument.settings` はSDKのJSON全体を保つ。設定のhashはUTF-8のRFC 8785 canonical JSONのsha256。settings内のbaseとenvelopeのbaseVersionを照合し、work metadataとの互換性をSDKのruntime validatorで確認する。対応するv1〜v9/engineだけを書込可能にし、未知version/engine/描画featureはread-onlyにする。未知フィールドを捨てた再シリアライズ、初期値への置換、部分的に読めた値だけでの上書きをしない。既知versionでも未知の描画項目があれば同じ扱いにする。

P13の`createPinnedPhotoRecipeValidator`は、固定SDKのmanifest/source/glue/WASMをhash・size・実versionで照合してから初期化し、SDKのstrict write gate、実WASMの数値検証、base/meta互換性を組み合わせる。互換性helperの返す補完済みJSONは保存せず、元JSONを共通canonical helperでhash化する。canonical baseにはreadyなworking-copy metadataを必須とし、無いときはpreviewや推定値で代用しない。null baseはSDKの直接読取上限内のJPEG/PNGだけを対象に、未指定contextで互換性を確認する。pending mediaのmetadata resolverと本番runtime配線は別の受入事項で、factory単体で書込口を有効化しない。


surface画像はP03のmask uploadで先に保存し、P05がsettingsの参照を抽出して本人・同じphoto・digest・寸法・保存済みを照合してからrecipeをCASする。**宣言されたmaskSurfaceIdsを信用しない。** ブラシ・被写体・空の面は同じ経路を使い、画像のない参照を保存しない。v1のserverで新たに被写体を検出する機能は不要。sky検出などhostの道具は実engine capabilityがあるときだけ有効化する。

別端末はrecipe内のsurface IDからmasks.getでasset metadataを引き、content.getで面のbytesを読む。全参照をphoto/ownerで再検証する。infoの撮影条件・位置情報は本人用の詳細routeだけに返し、一覧と派生物には含めない。

named/auto versionsはSDKのVersionSetに対応させ、現在のrecipeとは別のrevisionで配列をCASする。古い版の適用も現在recipeへのCASで行う。過去版・現在版から参照されるmaskを削除しない。未参照の面は24時間の猶予後、参照確認とfence付きでGCできる。参照が消えた面を使うdraftは再uploadしてから保存する。

version保存でも各settingsを検証し、hash・mask参照・時刻はserverで確定する。requestに含むrecipe revision/hashを権威として使わない。trash中はrecipe/version/mask/mediaの新規書込を拒み、restore後に再取得させる。各非同期処理は開始時のlifecycle世代に束縛し、trash/restore/purgeで世代を変えて遅着結果をfenceする。

## 7. カタログ・同期・削除

一覧はlimit最大100。通常はactiveかつstoredだけを返し、ゴミ箱一覧はlifecycleで分ける。added-descは不変のaddedAt＋id、captured-descはcapturedAt（nullは末尾）＋addedAt＋idで安定sortする。登録後に並びキーを変更しない。

一覧のJSON全体は4MiB以下にし、件数上限より早く切る場合も最後に返した行からのcursorを返す。raw bytesや履歴配列を含めず、working-copy metaも64KiB以下にする。hash lookupは最大100件でid/hash/recipeRevisionだけを返し、必要な詳細はphotoごとに取得する。adapterは同時数を制限してSDKのlookup形へ変換し、100枚の巨大recipeを一つの応答へ詰めない。

formatsはqueryで同名を繰り返す（例 `formats=heic&formats=heif`）。SDKのjpegフィルタはjpegだけ、heicはheic/heif、rawはrawへ対応し、PNG/TIFFはフィルタなしで見える。editedはSDKのneutral判定によるhasEditsに対応し、revisionが増えたという理由だけでtrueにしない。editableはruntimeとrecipeの互換性による別の絞り込み。未対応のfavorite/album/flagを黙って無視しない。

cursorはowner・filter・sort・初回の作成watermark・最後のtuple・期限をserverで署名したopaque値。初回snapshotに属し、まだ可視な行は重複も取りこぼしもなく走査し、新規追加分は再読込で出す。途中で削除された行は返さない。別owner/改ざん/条件違いは同じ400 invalid_cursor、期限切れは410。offset paginationにしない。P02は作成sequence/watermarkとowner付きindexを用意する。

addedAt/updatedAt/期限はserverのUTC時刻で返す。capturedAtのsortにはoffsetが確定した撮影時刻だけを使い、不明ならnullにする。EXIFのtimezone不明の時計表示はinfo側に元の値を残し、serverのtimezoneを撮影地として補わない。

library revisionをupload確定・recipe/history・media公開・trash/restore/purgeで増やす。P04はowner別ETagの条件付GETを提供し、認証後にだけ304を返す。P08はfocus/復帰/保存後に再取得し、可視時だけ既定15秒程度の限定polling、失敗時backoffを使う。隠れた画面で無限pollingしない。WebSocketやリアルタイム共同編集は不要。

ゴミ箱は30日。restoreで原本・recipe/historyを復帰し、quotaを二重加算しない。明示purgeと保持期限切れpurgeは、先にtombstoneで読み書きを止めてworkerに渡す。物理deleteはimmutable generationを指定し、確認後にだけusedを解放する。失敗中はpendingPurgeBytesとjob状態を本人に返す。recipe/history/mask/派生物/孤立uploadも対象にする。

退会イベントは非公開の本人確認済み接続から受け、accountをdeletingにして全session/予約/workerを失効させ、owner全体を同じpurge台帳へ送る。公開clientに任意ownerの削除APIを作らない。通常の復元や古いcompleteはtombstoneを越えられない。backupの保持期間・削除完了の説明・復元時のtombstone再適用をP13の非公開運用に固定し、それが未確定なら出荷しない。

## 8. SDKの再利用と新設範囲

採用版は **SDK 0.1.5 / crate 0.27.0 / source `f78926d805b5f2c115349d8f15ac184fde453ad1`**。[`sdk-baseline.json`](../../packages/photo-library-contract/sdk-baseline.json) に公式release manifest/receipt/6 tarball/engine manifestのSHA-256を固定した。公式workflow attestationとartifact identityを検証し、P08のpackage/lockは取得bytesのSRIへ固定する。branch/tag名/latestだけに追従しない。実hostへの接続と実機受入は別の完了条件である。

| 既存資産 | 再利用 | P08〜P13で必要な差分 |
| --- | --- | --- |
| PhotoLibrary / PhotoLibraryProvider / PhotoEditingHost | 保存先を替える既存接続口 | `packages/photo-cloud-library/` に個人API adapterを新設。APIの形式をSDK行へ変換し、spot前提の表示値を本人用に正規化 |
| desktop/mobile workbench、補正・crop・版・マスク | SDK編集UIを共用 | Web `/photo` の入口と本人scope、未対応capabilityの非表示。docs-uiへ編集面を複製しない |
| React peer | SDKは18/19対応、hostは19 | React/ReactDOMはhostの単一19 runtime。SSRの外でclient boundaryを作る |
| Query hooks | 既存SDKのquery設計 | 写真配下にQueryClientProvider。actor/libraryをkeyへ含め、切替時にcacheを破棄。旧spotId propを個人APIのownerとして使わない |
| dialog/store/styles | SDKのUI | `niho-photo-editing/sdk-dialog-host` を使い、既存niho-uiの別dialog storeで代用しない。CSSはphoto layoutに閉じ、token衝突を検証 |
| Worker/WASM/sky model | 固定runtimeを共用 | manifest経由のhash付きassets配置、Worker URL、CSPの最小追加。iPhoneはsingle-thread経路を必須にし、SAB/COOP/COEPへ依存させない |
| current/older recipes | `niho-photo-contract` のnode validator | v1〜v9と全保存済みengineを保全し、runtime capabilityとの積集合だけ編集可 |
| 原寸native export | Macの既存sidecar | Webはbrowserの許容範囲の保存。nativeExport/exportFolderはfalse。Macは同梱rendererの対応だけtrueにする |
| local source / device picker / cloudBinding | niho-photoの既存機能 | P11が本人APIを注入。「クラウドへコピー」は原本＋補正＋参照maskを移し、恒久保存完了まで元を消さない |

v1 adapterはalbums/articleImages/favorites/flagsをfalse/未実装にし、対応しないfilterを勝手に適用しない。info、versions、maskSurfaces、addFiles、mobile、cropは対応するAPI/hostを検証して有効化する。attachEditedPreviewはv1では提供せず、補正後previewをserver生成する。usageはusedとreservedを分けて表示し、SDKの既存usage欄だけで予約残量を隠さない。

adapterはSDKの省略可能なexpectedRevisionを個人APIでは必須にし、欠けた場合に最新revisionを取得して古いsettingsを強制保存しない。通常保存と一括保存の呼出元が開始時のrevisionを渡すことをP08で確認する。serverのprivate content routeをbrowserは同一originで読み、bearerが必要なMacのimgにはadapterが取得した短命のobject URLを渡す。public/signed GET URLを一覧へ作らず、unmount/切替/logoutでURLをrevokeする。

新設は本人auth接続・quota/catalog/blob/recipe/media/lifecycle・個人API adapter・Web入口・配布接続。デスクトップ編集UIや数式を一式作り直す計画ではない。SDKの不足はniho-photoで直して新releaseを固定し、host内コピーで分岐させない。

SDK 0.1.5のworkbenchとquery hookは `scopeKey`（`personal:<libraryId>:<actorId>`）を明示できる。既存の拠点用 `spotId` は互換のまま保ち、個人UIではrole/拠点rolloutを読まない。P09/P11は固定SDKと本人・library・session epochを組み合わせたhost接続を使い、アカウント切替時のcache破棄を実機で確認する。

## 9. writerとセッションの境界

表にないshared fileへ必要が出たら、先に担当へ依頼する。各レーンのPRに触らない範囲も書く。DB interfaceが必要なレーンはP02へ要求し、自分でmigrationを足さない。以下のパス名を確定名とし、変更時はP00契約PRで調整する。

| Issue / lane | 唯一のwriterとなる範囲 | 他レーンに渡すもの |
| --- | --- | --- |
| #149 P00 | `packages/photo-library-contract/**`、本文、photoの公開境界 | v1型・fixture・負例・SDK baseline。今後の契約変更もこの担当 |
| #150 P01 | `src/auth/**`、`src/server/photo-auth/**`（apps/editor-web配下） | VerifiedPhotoActor、Web/Macの検証、失効/退会接続 |
| #151 P02 | `packages/editor-store/src/photo-*`、`test/photo-*`、全photo migration、store shared export | owner-scoped transaction/store interfaceと作成watermark。migration generatorを使う |
| #152 P03 | `src/server/photo-transfer/**`、`src/storage/photo-*`、uploads/content/masksのroute | quota予約とgeneration付きstorage port、原本とmaskの転送 |
| #153 P04 | `src/server/photo-catalog/**`、library/photos/list/detail/info/lookupのroute | catalog serializer、ETag、cursor |
| #154 P05 | `src/server/photo-recipes/**`、recipe/versionsのroute | CAS、history、mask参照検証 |
| #155 P06 | `workers/photo-media/**`、`src/server/photo-media/**`、mediaのroute | provider/decoder bridge、immutable output、media result |
| #156 P07 | `workers/photo-purge/**`、`src/server/photo-lifecycle/**`、trash/restore/purge/jobsのroute | fence/tombstone、GCと退会purge |
| #157 P08 | `packages/photo-cloud-library/**`、同packageのlock/build、専用SDK release workflow、niho-photoのscopeKey接続口 | credential注入式adapter＋contractを含むimmutable配布物。Next/Tauri依存なし |
| #158 P09 | `apps/editor-web/src/photo/**`（pwa以外）、`src/app/photo/**` | 共用SDKのWeb mount、storage/競合/保存状態UI |
| #159 P10 | `src/photo/pwa/**`、`public/photo-sw.js`、photo manifestのroute | 同じ/photoから任意install。iPhoneの中断・メモリ・logout受入 |
| #160 P11 | niho-photoの `apps/camera` 内のcloudBindingとnative adapter | P08配布物をhash固定で採用、無料localとcopyの接続 |
| #161 P12 | 独立したphoto conformance/integration test harness | fixtureケースを本物のHTTP/DB/storageへ通す証拠。実装担当のmockだけで合格にしない |
| #162 P13 | host依存package.json/lock、Dockerfile、root layout、CSP、既存SW/manifest、共有CI・配備・release | 共通入口の統合・実機・本番・署名済みMac配布 |

`src/` と `public/` の未修飾パスは `apps/editor-web/` 配下。routeは `src/app/api/photo/v1/` 配下の表3の末端だけを各担当が所有する。photosの既存detail routeへ別担当の処理を足さず、recipe/trash等の子routeに分ける。共通photo deps/HTTP helperのwriterはP13。P02だけがstore indexを変更する。

P00では専用のcontract CIだけを追加する。P13のshared file統合は各レーンの最終完了を待たず、必要になった順に先行PRで行う。P08のadapter fixture作業、P10のiPhone fixture受入、P11のcopy設計、P12のharnessはP00 merge後に先行できるが、実接続完了にはEpicの依存Issueが必要。

P08はcontractとadapterのpackageをmanifest＋full source SHA＋tarball SHA-256付きで配布する。P11はそれを固定して採用し、niho-editorの可変mainや隣のcheckoutを直接importしない。パッケージ採用時は両repoのPRを相互リンクする。P08の専用release生成器とfixture同期は自身の範囲で、host lockfileの変更はP13へ渡す。

PWAはmanifest id/start_url/scopeを `/photo` に分け、既存文書PWAを変更しない。専用`public/photo-sw.js`のscopeも `/photo` とし、photo配下のmetadataとproduction限定登録を使う。root `public/sw.js`は`niho-editor-*`、写真workerは`niho-photo-*`の古いcacheだけを削除し、他namespaceを保持する。

写真workerが保存するのは、同一originの`/_next/static/`のGETで、query/fragment/Authorizationがなく、200/basic/public/immutableかつJS・CSS・fontの応答だけ。件数128、保存量64MiB、単体8MiB、同時body copy 2本を実byteで制限する。quota・cache障害時もonline応答を返す。写真原本・派生物・API・認証・HTML・ticket・共有URL・SDK runtimeは保存せず、no-store/reload要求もcacheへ入れない。個人draftの端末保持、offline編集、iOS background upload完走はこの基盤では提供しない。

写真APIの`Referrer-Policy: no-referrer`はNextのcatch-allにも上書きされないよう写真API pathへ限定して保つ。認証formのexactな`origin`例外は維持する。実iPhoneのSafari/ホーム画面PWAで、`/photo` scope外の固定callbackからの安全な復帰、本人切替・再起動・中断再開を受入するまでP10を完了扱いにしない。

## 10. 検証と出荷の境界

P00の `npm -C packages/photo-library-contract ci && npm -C packages/photo-library-contract run check` は型、fixtureの整合、route/エラー/SDK pin、機械可読の負例を検証する。写真bytes・token・本番endpointは含まない。**fixtureが返ることをserver側の認可・容量・decoderの検証結果として数えない。**

P12はfixtureのcase IDごとに実handler/store/providerへ対応する検証を作る。並行予約、complete/cancel/expiry、古いgeneration、別人IDとhash、失効後content、recipe CAS、missing surface、trash/物理削除待ちを含む。P13は実NIHOアカウントのMac/iPhone往復、HEICと検証済みRAW、現実の中断/復帰、5GB境界、配備後smoke、署名済みMac候補と利用者への更新まで確認する。

公開main/SDKの更新だけでは利用者へ届かない。P01の本人確認、P02〜P07の保存処理、P08〜P11の接続、P12の独立検証、P13の非公開運用と配布が揃うまでクラウドを有効化しない。
