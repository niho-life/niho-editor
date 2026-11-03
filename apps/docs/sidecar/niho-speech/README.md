# niho-speech

NIHO docs（Epic #18380）の「この Mac」の文字起こしを行う小さな CLI。S1-C #18403。macOS の **SpeechAnalyzer（SpeechTranscriber）** で日本語の音声を時刻付きで書き起こし、FluidAudio の固定モデルで端末内の話者分離も行う。音声の変換（16 kHz・mono・16-bit PCM の WAV）と無音位置での区切りも行う。呼ぶのは `apps/docs`（S1-A #18382）で、`convert → diarize（元音声ごとに一度）→ silence → transcribe（同じ speaker map を全区切りで共有）` の順に回して文字起こしの Markdown にする。ファイルを渡すエンジン（Gemini のサブスクリプション＝Antigravity CLI など）には `slice` で区切りごとの WAV を作る。マイクの録音（`record`・`mic-status`。#18590）も行い、録った音声はそのまま案件の音声になる（Mac の音声＝画面共有の相手の声などは第 2 段）。

- **macOS 26 以上・Apple Silicon** だけで動く。共有 package `NihoOnDeviceSpeech` と FluidAudio 0.15.6 を SwiftPM で固定する（Swift 6）。
- 前例: `packages/develop-engine/tools/apple-raw-linear/`（Swift ツールを sidecar にした例）。無音の区切りは `apps/api/src/ops/article-authoring-gemini-transcribe.ts`（NIHO の Gemini 文字起こし）と同じ決まり。
- 同梱と版の固定は S4 #18385: `apps/docs/sidecar.lock.json`（版・`swift-tools-version`・署名 ID・ソースの指紋）と `apps/docs/scripts/sidecar-lock.mjs`。sidecar または `packages/apple-speech` の `Package.swift`・`Package.resolved`・`Sources/` を変えたら `node apps/docs/scripts/sidecar-lock.mjs update`（docs-ci の `sidecar-lock.mjs check` が落とす。lock は出荷対象なので、main に入ると `docs-release.yml` が次の版を採番して公開する。PR では版を触らない）。手順は `apps/docs/README.md`「配布」。

## ビルドとテスト

```bash
cd apps/docs/sidecar/niho-speech
swift build -c release          # .build/release/niho-speech（arm64）
swift test                      # 引数・区切りの計画（NIHO の TS のテストと同じ例）・無音の検出（ffmpeg silencedetect と同じ判定・
                                # 固定サンプルで ffmpeg の区間と比較）・WAV の読み書き・変換（stereo の平均・末尾の補填）・
                                # 語彙ヒントの読み込み・JSON の行・範囲の検証（印字の長さまでの --end）・切り出し（区切りをつなぐと元と同じ）・CLI の終了コード・
                                # 録音の芯（合成した音を入力の代わりに入れる: 長さ・音量・装置の切り替え・途中で切れた CAF が読める・
                                # 書き出した m4a の長さ・書き出しに失敗したら CAF を返す）
NIHO_SPEECH_E2E=1 swift test    # この Mac の日本語モデルで固定サンプルを convert → silence → transcribe に通す。
                                # 入力の装置があり、テストを動かすプロセスにマイクの許可があれば、本物のマイクで 2 秒録って SIGTERM で止める
```

- E2E は `NIHO_SPEECH_E2E=1` のときだけ動き、SpeechTranscriber が使えない Mac や日本語モデルが未取得の Mac では skip する（CI には日本語モデルが無いので skip）。録音の E2E は入力の装置が無い・マイクの許可が `authorized` でないと skip する（許可を聞かない）。
- 入力の装置が無い Mac（CI・マイクの無い Mac Studio）では、CLI のテストが `record` の `no_input_device`（終了コード 2）を確かめる。装置がある Mac では `record` がマイクの許可を聞きうるので、そのテストは skip する。
- macOS の読み上げで作った固定サンプルは公開リポジトリに含めない。従来の固定サンプルをローカルで所持している場合は `NIHO_SPEECH_TEST_FIXTURE=/absolute/path/to/ja-sample.m4a swift test` で変換テストを実行できる。指定がない場合、そのテストだけ skip する。

## 契約

```
niho-speech probe      [--language ja]
  → {"available":true,"needsDownload":false,"engine":"SpeechAnalyzer","locale":"ja_JP","diarization":{"state":"ready","detail":null}}
niho-speech download   [--language ja]
  → {"type":"progress","ratio":0.42,"phase":"diarization"} …（取得中だけ） → {"type":"done","ok":true}
niho-speech convert    --input a.m4a --output a.wav
  → {"durationSec":4354.2}
niho-speech silence    --input a.wav [--target 900] [--window 60] [--min 60]
  → {"cuts":[2.5],"durationSec":5,"soundSec":[2,2]}（5秒の例）
niho-speech slice      --input a.wav --output chunk-02.wav [--start 897.3] [--end 1801]
  → {"durationSec":903.7}
niho-speech diarize    --input a.wav --output speaker-map.json [--speakers 2 | --minimum-speakers 4]
  → {"ok":true,"turns":412}
niho-speech transcribe --input a.wav [--language ja] [--hints hints.json] [--speaker-map speaker-map.json] [--start 0] [--end 900]
  → JSONL: {"type":"segment","start":12.4,"end":15.9,"text":"…","speaker":1} / {"type":"progress","ratio":0.42} / {"type":"done","segments":412,"durationMs":65000}
niho-speech record     --output rec.m4a
  → {"type":"started","device":"MacBook Pro のマイク","sampleRate":24000}
    {"type":"level","db":-32.5,"durationSec":12.4} …（約 0.2 秒ごと） → SIGTERM で止める →
    {"type":"done","file":"/…/rec.m4a","durationSec":1425.36,"bytes":8650123}
niho-speech mic-status [--request]
  → {"status":"authorized"}（authorized・denied・notDetermined・restricted）
niho-speech version    → {"name":"niho-speech","version":"0.3.1"}
niho-speech help       → 使い方（文字列）
失敗: 標準出力に 1 行 {"type":"error","code":"model_not_installed","message":"…"} を出し、終了コードで種類を返す
終了コード: 0 成功 / 1 引数の誤り・想定外の失敗 / 2 この Mac で今は使えない / 3 入力の不備 / 4 権限（ファイル・マイク）
hints.json: [{"term":"NIHO鎌倉","reading":"にほかまくら","variants":["NIHO 鎌倉"]}, …]
```

- 標準出力は JSON の行だけ（1 行 1 オブジェクト・UTF-8・日本語はエスケープしない。1 行は 1 回の write で出し、混ざらない）。人向けの注記は標準エラーだけ。オプションは `--key value` と `--key=value` のどちらでもよい。引数なし・`help`・`--help` は使い方、`version`・`--version` は版。
- 秒（`start`・`end`・`cuts`・`durationSec`）は 0.01 秒に丸め、`ratio` は 0.01 刻み（切り捨て。1 は終わり）の 0〜1、`durationMs` は整数。
- `message` は英語（OS のエラーは `NSOSStatusErrorDomain error -12345` のような domain と code。OS の言語で変わる `localizedDescription` は使わない）。
- 停止は呼ぶ側がプロセスに SIGTERM を送る。それまでに出た `segment` は有効。`record` は SIGTERM（と SIGINT）で終わらずに録音を閉じて書き出し、`done` を出してから終了コード 0 で終わる。

| 終了コード | `code` |
|---|---|
| 1 | `invalid_arguments`（知らないコマンド・オプション、必須の欠け、数でない値、同じオプションの重複、入力と出力が同じ、`--target`／`--min` が 0 以下、`--window` が負、`record` の `--output` が `.m4a` でない）・`write_failed`（`record` の `--output` か録音中の CAF が既にある、も）・`download_failed`・`transcription_failed`・`recording_failed`（入力の装置を始められない・変換できない）・`internal_error` |
| 2 | `model_not_installed`（`download` を案内する）・`engine_unavailable`（この Mac では SpeechTranscriber が使えない）・`no_input_device`（入力の装置が無い。マイクをつなげば使える＝「今は使えない」なので 3 ではなく 2） |
| 3 | `input_not_found`・`input_unreadable`（音声として読めない・音声のトラックが無い）・`input_empty`（`record` は音が 1 つも届かずに止まったとき）・`input_too_large`（`convert` の入力が 1 ファイル 2 GiB か長さ 6 時間を超える）・`input_format`（`silence`／`slice`／`transcribe` に `convert` の出力でない WAV）・`invalid_range`・`invalid_hints`・`unsupported_language` |
| 4 | `permission_denied`（入力のファイルを開く権限が無い: EACCES／EPERM。macOS が守るフォルダにアプリの許可が無いときなど。**音声認識の許可は SpeechTranscriber では要らない**ので、それで 4 になることは無い）・`microphone_permission_denied`（`record` のマイクの許可が無い・断られた・制限されている） |

### probe・download

- `--language` の既定は `ja`。`SpeechTranscriber.supportedLocale(equivalentTo:)` で解決し、`locale` に識別子（`ja_JP`）を返す。非対応は `available:false`・`locale:null`。地域の無い言語は推定の地域を先に試す（`en` → `en_US`・`fr` → `fr_FR`・`pt` → `pt_BR`）。`supportedLocale(equivalentTo:)` だけだと `en` が `en_GB`、`fr` が実行のたびに `fr_CA` や `fr_CH` になった。
- `needsDownload` は `SpeechTranscriber.installedLocales` と固定話者分離モデルの検証結果で判定する。話者分離モデルは manifest の全 21 ファイルについて byte 数と SHA-256 が一致したときだけ `ready`。`AssetInventory.status(forModules:)` は導入済みの日本語でも `supported` を返すので使わない。
- **`AssetInventory.assetInstallationRequest` は呼ぶだけで言語を予約する**（実行ファイルの署名 ID ごとに最大 5。別名のバイナリからは見えない）。だから `probe` では呼ばず、`download` だけが呼ぶ。`download` は予約したまま解除しない。同梱する sidecar の署名 ID は版を上げても変えない（S4 #18385: `Sources/niho-speech/Info.plist`（`CFBundleIdentifier` = `niho-speech`）を実行ファイルに埋め込み、NIHO docs の `.app` を ad-hoc で署名し直しても ID が `niho-speech` のまま。`swift build` の linker の署名もファイル名の `niho-speech` なので、手元のビルドと同じ ID。`apps/docs/scripts/sidecar-lock.mjs check-app` が確かめる）。
- 日本語のモデルは約 340 MB（`/System/Library/AssetsV2/com_apple_MobileAsset_UAF_Speech_AutomaticSpeechRecognition`）。
- 話者分離モデルは FluidAudio の `speaker-diarization-coreml` を immutable revision `7eab74f3463c736418d0eb10296261ae581146c9` から `download` の明示操作だけで取得する。一時 URL を逐次検証して private staging へ置き、全ファイルの検証後にだけ atomic install する。推論時は `ModelHub.offlineMode = true` のままにし、SDK の自動取得・復旧は使わない。

### diarize

- `convert` 済みの元 WAV 全体を disk-backed URL のまま一度だけ処理し、全区切りで共有する `speaker-map.json` を書く。15 分区切りをまたいでも話者 ID は同じ元音声の中で安定する。別の元音声の同じ番号を同一人物とは扱わない。
- SDK の話者文字列は元音声での初出順に 1 始まりへ正規化する。名前は推定しない。`--speakers` は正確な人数、`--minimum-speakers` は下限を SDK へ渡し、同時指定はできない。
- モデル未準備・破損・処理失敗は fail closed で、クラウドへ自動 fallback しない。

### convert

- AVFoundation が読める音声・動画（m4a・mp3・wav・aiff・caf・mp4・mov など）の全音声トラックを混ぜて、16 kHz・mono・16-bit 整数の PCM にする（`AVAssetReaderAudioMixOutput`）。
- NIHO の `ffmpeg -ac 1 -ar 16000 -sample_fmt s16` と音量・長さを揃える（無音の判定が -35 dB の閾値に依るため）:
  - 2 チャンネル以上の音声は 16 kHz の stereo で読み、(L + R) / 2 にする（ffmpeg と同じ）。AVFoundation に mono で出させると (L + R) / √2 で 3 dB 大きくなる。3 チャンネル以上は AVFoundation が stereo に畳んでから平均する（ffmpeg とは完全には一致しない）。
  - AVAssetReader の変換は最後を出し切らず、末尾の 6〜12 標本を落とす。音声トラックの終わりまで無音で埋める（最大 10 ms）。先頭は ffmpeg と同じ位置（相互相関で確認）。
- 出力はヘッダーが **44 バイト固定**の WAV。同じフォルダの一時ファイル（`.<名前>.partial-<pid>`）に書いてから置き換える（途中で止まっても `--output` に壊れた WAV を残さない）。長い音声でもメモリは一定。音声のトラックはあるが長さが 0 なら `input_empty`。
- 入力の上限: 1 ファイル 2 GiB（2,147,483,648 バイト）・長さ 6 時間（spec §6.2）。超えると復号の前に（長さが分からない入力は復号しながら）終了コード 3 の `input_too_large` で断り、`--output` は触らない。案件の合計 6 時間は呼ぶ側が数える（アプリの取り込みと、文字起こしの前に `convert` の `durationSec` の合計で）。

### silence

- NIHO の Gemini 文字起こしの ffmpeg 経路（`silencedetect=noise=-35dB:d=0.35` → `planArticleAudioChunks`）と同じ結果を返す。
  - 無音の標本: 16-bit の値 s が `-582 < s < 582`（-35 dB = 0.017783 × 32767 = 582.69 を ffmpeg と同じく整数に切り捨て）。
  - 無音の区間: 無音の標本が 5,600 個（0.35 秒）以上続いた区間。始まりは最初の無音の標本、終わりは次の音のある標本（終端まで続けば長さ）。区間の中点を候補にする。
  - 区切り: 目標 `--target` 秒ごとの時刻の前後 `--window` 秒にある、前の切れ目から `--min` 秒以上離れた無音の中点のうち最も近いもの。無ければ目標時刻。終端から `--min` 秒以内には置かず、最後の区切りが `--min` 秒未満なら前へ併合する。長さが `--target` 以下なら `cuts` は空。
  - `soundSec` は区切りごとの無音以外の秒数。Gemini の極端に短い返答を判定するときに使う。音声認識による発話時間ではなく、上記の音量閾値に基づく。
- 隣り合う区切りに同じ値を `--end`／`--start` で渡すと、標本の位置（`round(秒 × 16000)`）が一致し、隙間も重なりも無い。

### slice

- `--start`／`--end` の範囲（`transcribe` と同じ規則・同じ標本）を、ヘッダー 44 バイトの 16 kHz・mono・16-bit の WAV に写す。`convert` と同じく一時ファイルに書いてから置き換える。隣り合う区切りを `cuts` の同じ値で切ると、つなげて元の WAV と同じ標本になる。
- 使い道: 区切りのファイルを読ませるエンジン。Gemini のサブスクリプションは Antigravity CLI（`agy`）のエージェントに `view_file` で区切りの WAV を読ませると Gemini 3.8 Flash が書き起こす（15 分の WAV＝28.8 MB で確認・S0 #18381）。呼ぶ側はフォルダに区切りのファイルだけを置き、シェルを使わないよう指示し、返った `[mm:ss]` に区切りの開始秒を足し、区切りの長さを超える時刻は丸める（Gemini の時刻は目安で、15 分の終わりで +18 秒ずれた例がある）。

### transcribe

- `--start`／`--end` の範囲だけを読む（既定は全体）。`--end` が `convert`／`silence` の印字した長さ（0.01 秒に丸めた値）以上なら終端の標本まで読む（最後の区切りに印字の長さを渡しても、丸めで数 ms を落とさない）。`--start` が負・長さ以上、`--end` が `--start` 以下は `invalid_range`。
- 音声は 1 秒ずつ読み、各バッファに WAV 全体での時刻を付けて渡す（長い音声でもメモリは一定）。
- 時刻は**元の音声の絶対秒**。`--speaker-map` を指定しない従来経路は SpeechTranscriber の確定した結果 1 つを `speaker` なしの `segment` 1 行として返す。指定した経路は AttributedString の run ごとの `audioTimeRange` だけを根拠に共有 alignment へ渡し、`speaker` に 1 始まりの番号または不明の `null` を返す。結果全体の範囲を文字数で按分しない。
- SpeechTranscriber は結果の最初の run に前の結果の終わりからの無音を含めた時刻を付ける。話者の根拠は run の終わりから「文字数 × 0.3 秒」の範囲だけで見る（返す時刻は変えない）。以前はほぼ全ての発言の先頭 1 文字が `speaker:null` に分かれていた（0.3.1・`apps/docs/sidecar/speech-bench` で計測）。
- 無時刻の句読点は本文順を保って隣接文字へ残し、根拠の薄い run、複数話者の強い重なり、音声対応不足は `speaker:null` にする。ASR の文字列は既存の trim を除いて変えず、隣接する同じ話者だけをまとめる。
- `progress` は直前の `segment` の終わりの位置（範囲の中の割合）で、1% 以上進んだときだけ出し、最後は 1。`done.durationMs` は処理にかかった実時間（音声の長さではない）。
- その言語のモデルが未取得なら、読み始める前に終了コード 2（`model_not_installed`。message に `niho-speech download --language <言語>` を書く）。モデルの取得も言語の予約もしない。

### record・mic-status（#18590）

- 録るのはシステムの**既定の入力の装置**（AVAudioEngine の入力）。Mac の音声（画面共有の相手の声など）は第 2 段。
- 順番: 入力の装置を確かめる（無ければ `no_input_device`。マイクの許可は聞かない）→ マイクの許可（未決定なら聞く。断られたら `microphone_permission_denied`）→ 録り始めて `started`。
- 録っている間は `--output` と同じ場所の `<名前>.recording.caf`（24 kHz・mono・16-bit 整数のリニア PCM）に書き続ける。CAF の data の大きさは録音中 -1（ファイルの終わりまで）なので、落ちても・SIGKILL でも、それまでの音を AVFoundation・afinfo・`convert` が読める。約 10 秒ごとに fsync。止めると本当の大きさを書く。
- 入力は装置の形式（48 kHz の stereo など）のまま受け、24 kHz・mono に変換する（2 チャンネル以上は混ぜる）。`level` は変換した音の 0.2 秒ごとの RMS（dBFS・0.1 刻み。無音は -160）と、録った長さ（0.2 秒の区切りの終わり）。最初の `level` は `started` の後（それより前の音も録音には入る）。
- 装置が変わったら（ヘッドセットを外した・別の入力を選んだ）新しい既定の装置で続け、`started` をもう一度出す。入力の装置が無くなったら、そこまでで止めて `done` を出す（呼ぶ側は止めていないのに `done` が来る）。保存先に書けなくなったときも同じ（そこまでの CAF を返す）。
- SIGTERM・SIGINT で止める。親（NIHO docs）がいなくなったときも止めて保存する（1 秒ごとに親のプロセスを見る）。SIGPIPE は無視する（標準出力が閉じても書き出しを続ける）。
- 止めたら CAF を閉じ、AAC（`.m4a`・mono・24 kHz・48 kbps。実測で 1 時間 ≈ 22 MB、書き出しは約 750 倍速）に書き出して CAF を消す。書き出しは同じ場所の一時ファイル（`.<名前>.partial-<pid>.m4a`）に書いてから置き換える。**書き出しに失敗したら CAF を残し、`done` の `file` に CAF を返す**（`convert` は CAF も読める）。音が 1 つも届かずに止まったら CAF を消して `input_empty`。
- `--output` か CAF が既にあれば `write_failed`（前の録音を上書きしない）。
- 録っている間はシステムのスリープを止める（`ProcessInfo.beginActivity` の `.userInitiated`・`.idleSystemSleepDisabled`。画面は消える。蓋を閉じると眠る）。
- マイクの許可は、NIHO docs から起動したときは .app に付く（責任のあるプロセス＝アプリ）。.app の Info.plist の `NSMicrophoneUsageDescription`（`src-tauri/Info.plist`）が問いの文になる。この実行ファイルの Info.plist にも同じ文を入れてある（単体で起動したとき用）。
- `mic-status` は状態を読むだけで聞かない。`--request` なら未決定のときだけ聞き、答えるまで返らない。

### アプリ内の録音と復旧（P5 #18568）

文書ヘッダーの「録音」と、空の録音ページの「この Mac で録音」からこの `record` を呼ぶ。録音の所有は App に置き、ページ・案件・設定を移っても帯と録音を保つ。停止後に「M/D HH:mm の録音」のページへ音声を取り込み、文書から始めた場合はその文書を参考に付ける。文書は録音中も編集でき、停止後のページ移動前に最新の本文を保存する。別の録音の工程は並行して実行できる。

元音声の耐久性は Rust の `recordings/`（クラッシュ時は CAF）、開始元と保存途中の紐付けは WebView の永続ストレージ `niho-docs-recording-journal-v1` が担う。開始前に保存先 root・案件・元文書または空ページ・工程 snapshot と日時を記録し、ページ作成・取り込み後にページ id と取り込んだ音声を追記する。取り込みとページ保存が完了するまで元音声は消さない。再起動時の「前回の録音」は文書・設定の画面にも表示する。再試行は保存途中のページと音声を再利用し、保存済みの音声を重複させない。元文書が消えた場合は参考なし、保存先が消えた場合は復旧時に開いている案件へ参考なしで保存する。

60 分相当の合成 PCM を実際の resampler → CAF → AAC にストリーミングする検証（マイク不要・通常は skip）:

```bash
NIHO_SPEECH_LONG_RECORDING_TEST=1 swift test --package-path apps/docs/sidecar/niho-speech --jobs 2 --filter RecordingTests/testOneHourSyntheticRecordingKeepsDurationAndBoundedMemory
```

実測（Mac mini M4・macOS・2026-10-17、debug XCTest）: 出力 **3,600.0 秒／86,400,000 frames**、音量 18,000 回、AAC **18,113,862 bytes**、所要 **5.89 秒**。プロセスの peak RSS は開始時 **22,659,072 bytes** → **32,096,256 bytes**（増加 **9,289,728 bytes ≈ 8.86 MiB**）。入力は 48 kHz stereo の 1 秒分を繰り返し、CAF と AAC の両方の長さを AVAudioFile で検証し、メモリ増加を 128 MiB 未満に制限する。これは保存経路の長時間容量の検証であり、実マイクを 60 分つないだ測定や sleep・permission UI の検証は含まない。

### 語彙ヒント（`--hints`）は効かない

macOS 27.0（2026-10-15）の実測:

- SpeechAnalyzer の `AnalysisContext.contextualStrings[.general]` に語を渡しても、SpeechTranscriber・DictationTranscriber とも出力が変わらない（同じ音声でヒントの有無を比較。初期化時に渡しても `setContext` でも同じ）。
- DictationTranscriber のカスタム言語モデル（`SFCustomLanguageModelData` に語と X-SAMPA の読み → `.customizedLanguage`）でも固有名詞は直らず、重み 1.0 では悪化した。DictationTranscriber は素の精度も SpeechTranscriber より低い。
- `SFSpeechRecognizer.contextualStrings` は「Siri と音声入力」が無効だと `kLSRErrorDomain 201` で止まり、システム設定の変更と許可が要る。

そのため `--hints` は受け付けて検証し（不正なら `invalid_hints`）、`term` だけを contextual strings に渡す（最大 100 語。将来の OS で効けば効く）。**固有名詞は文字起こし修正の工程で直す**。`variants`（誤りやすい表記）は誤った表記へ寄せてしまうので認識には渡さない。`reading` は使わない。

## 実測（Mac mini M4・16 GB・macOS 27.0・2026-10-15）

日本語の実録音 60 分（m4a・48 kHz・AAC）:

| 工程 | 所要 | 最大メモリ（この CLI） |
|---|---|---|
| `convert` | 1.1 秒 | 25 MB |
| `silence` | 0.06 秒（区切り 899.49／1799.43／2698.36 秒。ffmpeg 経由の NIHO の計画と同じ値） | 10 MB |
| `transcribe` × 4 区切り | 計 41.9 秒（約 86 倍） | 22 MB |
| `transcribe` 通し（参考） | 41.5 秒 | 22 MB |

- 認識はシステムのプロセスで動く（この CLI のメモリは長さに依らず一定）。
- 区切りの文字起こしは、時刻が通しと同じ絶対秒で、区切りの前後で言葉の欠けも重なりも無い（全体の本文の一致率 0.97。違いは言い回しの揺れだけ）。
- 権限: ファイルの文字起こしに音声認識の許可（TCC）も言語の予約も要らなかった。
- 品質の比較（Deepgram nova-3 と並べた目視）は S0 #18381 の 1。

### 指定した話者人数と異なる結果（#239）

話者人数が自動の場合は推定結果を返す。ちょうどN人/最少N人を明示した場合は、推論後の話者ID数も検査する。人数が一致/下限を満たさなければ固定の失敗として返し、新しいspeaker mapを書かない。人数を満たすための架空の分割や自動の別engineへのfallbackはしない。録音原本と既存候補は呼出側の通常の復旧経路で保つ。

2026-11-03の承認済み0.3.1での合成OS音声2種類/6交代/60秒では、自動・2人指定とも1話者となった。この結果は識別品質の合格証拠ではない。0.3.2は指定に反した結果の成功扱いを防ぐ補修で、モデル精度を改善したと主張しない。実イベント・重なり音声の品質確認は別に必要。
