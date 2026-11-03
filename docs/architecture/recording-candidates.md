# 録音の文字起こし候補

Issue #236 で確定した、同じ録音に対する独立した文字起こし案の契約。録音・ページの正本は既存の NIHO クラウドであり、`vault`、`candidateSets`、端末内の正本は作らない。

## 正本と後続工程

- `page_recordings` は採用中の本文の正本である。既存の録音 editor、手順、入力変更検知はこの行だけを読む。
- `page_recording_candidates` は独立案の台帳である。閲覧、比較、編集、生成、履歴表示、復元だけでは採用されず、手順も動かさない。
- 明示した「採用」だけが、選んだ候補の `segments`、`speaker_names`、`engine`、`duration_sec` を `page_recordings` に写し、録音 revision を進める。既存の step ページは残り、既存の入力変更検知が後続を stale にする。
- 候補ごとの chat、export、engine 全体設定、公開連携は持たない。

採用中候補の本文は録音 editor で編集する。DB trigger が `page_recordings` から採用中候補へ一方向に同期し、候補一覧・詳細が古い snapshot を返さない。採用中候補は名前だけ候補 API で変更できる。非採用候補は名前、段落本文、話者名を独立して編集できる。

## revision、競合、生成との race

- 全候補は `revision >= 1` の単調増加番号を持つ。名前・本文・話者名・engine・language・duration の内容変化だけで進み、`adopted` の付け替えでは進まない。
- 編集と復元は `expectedRevision`、採用は `expectedCandidateRevision` と `expectedRecordingRevision` を必須にする。不一致は何も書かず 409 と最新 snapshot を返す。画面は利用者の draft を保持し、自動で最新本文を上書きしない。
- 編集競合では相手の最新版も表示し、本人が確認して自分の入力を使うと選ぶまで再保存を止める。採用の応答待ちは録音の編集をinertにし、通信中の入力を採用応答で消さない。ページごとに録音のUIを作り直し、前のページの非同期応答を次のページへ適用しない。
- mutation は UUID の `operationId` と正規化内容の SHA-256 receipt を保存する。同じ ID・同じ内容の再送は重複版を作らず成功として扱い、同じ ID の別内容は拒否する。同一内容の保存も no-op で revision を進めない。receipt は候補ごとに直近 200 件へ有界化する。
- 同じページで `queued` / `running` の文字起こしがある間は候補の編集・復元・採用を拒否する。
- 候補宛ての run は enqueue 時の `candidate_revision` を保持する。finish は run 世代に加えてこの revision を照合し、開始後に手編集・復元された候補へ遅着結果を書かない。再試行、Mac CLI、server worker も同じ fence を使う。

lock 順序は候補操作では `page_recordings`、次に `page_recording_candidates` とする。finish は run を先に確定してから recording、candidate の順に進み、候補操作は run 行を lock しない。採用は先に `adopted` を新候補へ付け替えてから recording を更新する。これにより recording → candidate trigger が旧候補を選択案の本文で上書きせず、逆向き同期や二重同期も起こさない。

## 履歴

`page_recording_candidate_versions` は候補ごとの immutable snapshot で、版番号、理由、時刻、名前、本文、話者名、文字起こしメタデータを持つ。理由は次の 5 種類。

- `initial`: 既存案の backfill、または新規案
- `edit`: 非採用案の編集、採用中案の名前変更
- `recording`: 採用中本文を既存録音 editor で編集
- `asr`: 文字起こし結果の確定
- `restore`: 旧版を新しい current として復元

current を含む直近 100 版だけを残す。復元は過去の行を書き換えず、新しい revision と `restore` 版を作る。単なる採用印の変化では版を増やさない。候補またはページの hard delete では FK の cascade で版と receipt を回収する。

## API と認可境界

全 API は認証 session の owner と active page で絞る。別 owner、存在しない page/candidate/version、不正 UUID、ゴミ箱、録音のないページは同じ 404 とする。mutation は同一 origin、`application/json`、strict body、既存 JSON 上限を維持し、本文・話者名・識別情報をログへ出さない。

- `GET/PATCH /api/pages/{page}/recording/candidates/{candidate}`: 詳細取得と CAS 保存
- `GET /.../{candidate}/versions`: 新しい順の履歴（最大 100、本文なし）
- `GET /.../{candidate}/versions/{version}`: 本文つき snapshot
- `POST /.../{candidate}/versions/{version}/restore`: CAS 復元
- `POST /.../{candidate}/adopt`: candidate/recording 二重 CAS の明示採用

## 比較と音声

画面は ready な任意 2 案を選べる。話者番号や段落位置は案ごとに独立しており、自動対応・自動マージしない。各 segment の時刻ボタンは親録音の共通 `playback.seekTo` に接続する。音声が期限切れ、取り込み中、欠落の場合もテキストの閲覧・比較・編集は続け、seek だけを無効にして理由を表示する。

狭い画面では 2 案を切り替えて表示し、各 panel を `min-width: 0` の 1 列にする。横スクロールを前提にしない。案ごとの draft は案の選択変更、生成状態のポーリング、操作失敗、409 で破棄しない。保存、復元、採用は別々の明示ボタンとする。
