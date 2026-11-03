# Mac アプリの Gemini CLI 文字起こしを新 editor へ接続する案

状態: 実装済み・検証中。オーナーが 2026-11-03 に **10 分を既定にして実装する**ことを決定した。

## Goal

旧 NIHO docs にあった Gemini のサブスクリプション経由の文字起こしを、新 editor の同じ録音画面から使えるようにする。
対象はまず Mac アプリ（オーナー回答 2026-11-03）。ブラウザから別の Mac に依頼する仕組みは今回含めない。
画面・結果の保存先・文字起こしの比較は Web と共通にし、Mac は音声処理と CLI 実行を担当する。

## Current system

### 再利用できる旧実装

| 部品 | 確認できた実装 |
| --- | --- |
| [speech.rs](../../apps/docs/src-tauri/src/speech.rs) | `prepare_audio` が WAV へ変換し、無音の近くで区切る（調査時点は目標 **5 分**、本変更で **10 分**へ）。区切りの有音時間も取得する |
| [lib.rs](../../apps/docs/src-tauri/src/lib.rs) | `transcribe_audio_part_with` が区切りを切り出し、`ToolPolicy::ReadFile` で渡す。区切りの時間上限は 20 分 |
| [agy.rs](../../apps/docs/crates/local-ai/src/agy.rs) | `Provider::GeminiCli` の実体は **Antigravity CLI (`agy`)**。`view_file` だけを持つ専用エージェントで音声を読み、イベントを共通形式へ変換する |
| [audio-transcription.ts](../../packages/docs-core/src/audio-transcription.ts) | 要約・捏造を避ける指示、固有名詞、言語、話者人数、直前 6 段落の参照、時刻の補正、話者番号の正規化 |
| [runner.ts](../../packages/docs-ui/src/lib/runner.ts) | `runGeminiTranscription` が分割・実行・結合を制御する。短すぎる出力・出力上限・一時失敗の再試行、停止、途中結果の checkpoint がある |

旧 runner は `DocsHost`、Project、旧録音・版・checkpoint の保存に結び付いている。そのまま新画面から呼ばず、依存のない実行ロジックを抽出し、保存部分を差し替える。
旧 native command も旧 Store の録音参照を使うので、その command を remote の許可一覧に追加する移植はしない。

旧モデル既定は `gemini-3.8-flash` / effort `low`。この値を初期候補とし、実装・実機受入時にログイン中の CLI のモデル一覧と照合する。
CLI の利用枠・利用制限は残る。「API の従量課金に勝手に切り替えない」ことと「無制限・無料」は区別する。

### 新 editor で不足している接続

1. **録音画面と Mac bridge の接続**。初回調査後の main で AI チャット用の bridge 接続は入ったが、録音の CLI 文字起こしは未接続。チャットの検出・エラー処理のパターンを再利用する。
2. **音声を CLI に渡す native command**。現行 `shell_transcribe_local` は同梱の音声認識 sidecar 用。`shell_ai_turn` は Markdown 編集用で、音声ファイルを渡せない。CLI 文字起こしの固定 command が必要。
3. **サーバー結果受付**。現行の候補作成 API はサーバー runner とその `engines` を要求する。Mac の結果を同じ録音・候補へ確定する受付はない。
4. **サーバーにある音声の staging**。`ShellAudioSource` は native 録音 ID / staging ID のみ。既存のクラウド音声を Mac の一時置き場へ受ける接続が必要。

現行の `gemini` エンジンは **サーバーの Gemini API** で、`GEMINI_API_KEY` が必要。これを有効にするだけでは、Mac のサブスクリプション経由にはならない。

参照: [shell-bridge.ts](../../packages/desktop-bridge/src/shell-bridge.ts)、[shell-contract.ts](../../packages/desktop-bridge/src/shell-contract.ts)、[remote の権限](../../apps/docs/src-tauri/permissions/docs.toml)、[recording-candidates-api.ts](../../apps/editor-web/src/server/recording-candidates-api.ts)、[config.ts](../../apps/editor-web/src/transcription/config.ts)。

### 調査で確認した範囲

- `gemini --version`: 0.46.0、`agy --version`: 1.4.12（この Mac）。認証情報は読んでいない。
- `npm -C apps/docs test -- test/gemini-transcription.test.ts`: **12 テスト成功**。分割、話者・時刻、途中失敗、短文、無音、出力上限、停止などを確認する既存テスト。
- 上記テストの bridge は偽物。実装中に、個人情報を含まない短い日本語の合成音声を既存 `ReadFile` adapter から `agy` に渡したが、`UsageLimitReached` で停止した。**実 CLI での文字起こし完走は未確認**。この結果から音声認識品質や 10 分分割の忠実度を評価することはできない。
- Google の [headless mode](https://antigravity.google/docs/cli/headless/) には stdin の `stream-json` と、結果・ツール実行・使用量のイベントが記載されている。音声は stdin の独自バイナリ形式で渡さず、既存 adapter のファイル読取経路を使う。
- Google は [Gemini CLI からの移行](https://antigravity.google/docs/cli/gcli-migration/) を案内している。Gemini CLI 自体にも [音声ファイル読取](https://geminicli.com/docs/tools/file-system/) の記載はあるが、別 adapter を新設するより、旧 NIHO docs の agy 経路の維持を優先する。

## User journey

### 分割時間と捏造対策（2026-11-03 の追加調査）

評価の優先順は **発話にない文章の挿入を避けること → 省略を避けること → 話者・時刻 → 処理時間・呼出回数**。
モデルの入力上限が大きいことは、長時間音声を忠実に文字起こしできる根拠にしない。

確認できた一次資料:

- [Brown 大学 CCV の運用資料](https://docs.ccv.brown.edu/ai-tools/services/transcribe/getting-better-transcriptions)は、Gemini / Whisper で発話にない文章や反復が生じうるとし、ファイルを短くすること、音質を確認すること、長い無音・非発話部分に注意することを推奨する。特定の最適分数は示していない。
- [Google AI Developers Forum の当事者報告](https://discuss.ai.google.dev/t/how-to-get-consistent-multi-speaker-transcription-output-from-gemini-2-5-pro/87391)には、30 分の多話者音声で省略・捏造が起き、5 分への分割案や、5〜10 分にすると捏造が減った経験が記載されている。2025 年の Gemini 2.5 Pro の報告であり、現行 Flash / agy の比較試験や Google の公式推奨値ではない。
- [video-intel の開発者自身の記録](https://github.com/dzivkovi/video-intel/issues/248)では、30 分分割で 20 本中 4 本の出力が崩れ、3 本は 10 分、残り 1 本は 5 分への短縮で回復したと報告されている。この記録の失敗は主に出力省略・時間切れで、捏造率の比較とは区別する。

公開情報から **5 分が最適とも、10 分・15 分が安全とも断定できない**。実用上の比較候補は 5〜10 分で、15 分を既定にする十分な根拠は得られていない。

| 分割の目標 | 1 時間の音声の呼出回数（無音への調整・重なり・再試行を除く） | 現時点の位置付け |
| --- | --- | --- |
| 5 分 | 12 回 | 旧実装の値。品質比較・問題のある区間の再試行の候補 |
| 10 分 | 6 回 | **オーナー指定の既定値（2026-11-03）。目標 600 秒で実装する** |
| 15 分 | 4 回 | 比較試験用。入力上限に収まるだけでは採用しない |

実装方針:

- 利用者の操作は録音全体に対して 1 回。内部の分割・結合・再試行はアプリが行う。呼出回数が多いほど CLI 起動と共通指示の処理は増えるが、音声 1 時間を 12 回まるごと送る構成にはしない。
- **10 分を既定にする**（オーナー指定）。15 分への一律延長は行わない。モデル・CLI が変われば品質を再確認する。
- 時間だけで機械的に切らず、近傍の無音・発話境界を使う。長い無音を発話として処理させず、元の音声時刻は保持する。静かな発話を無音として捨てない。
- 境界の短い音声の重なりと直前の参考文を使い、対応する発話を根拠に重複・話者ラベルを調整する。重なり秒数は比較試験で決める。
- 明示的な出力上限・省略・ループなどを検出した区間は、同じ長さの再送だけを繰り返さず、さらに短く分けて再試行する。認証・利用制限には分割で対処しない。
- 「文章が自然」「文字数が十分」「最後の時刻がある」だけでは捏造を検知できない。原音を根拠に評価し、全文を別のテキスト LLM に整えさせるだけの処理を捏造対策としない。

品質評価では、正解を確認できる日本語の対談・会議・講義、長い無音や雑音を含む音声を、同一モデル・設定で比較できるようにする。
発話にない文の挿入、欠落、反復、話者誤り、CER、処理時間、再試行数を比較する。観測した捏造がゼロでも無発生を保証するものではない。
5 / 10 / 15 分の比較は最適値を追跡するための評価であり、今回の 10 分での実装を保留する条件にはしない。現時点ではこの比較を実行していない。

### 画面の流れ

1. Mac アプリで録音ページを開き、「Gemini（この Mac の CLI）」を選ぶ。サーバーの API key の有無とは独立して利用可否を判定する。
2. 未導入・未ログイン・対応モデルなしなら理由を表示する。CLI が使えない場合に自動で Gemini API / Deepgram へ送らない。
3. native 録音・ファイル選択直後は既存のローカル音声を使う。クラウドにしかない音声は、認証済みの画面が取得して private staging へ渡す。
4. 変換 → 区切り → 「3 / 12 を文字起こし中」→ 結合 → 保存、と進みを表示する。途中で停止できる。
5. 結果は同じサーバーの録音ページに保存する。最初の文字起こしは、開始後に編集されていなければ表示中の文字起こしへ反映する。既存の文字起こしがある場合は別案にし、今ある結果を保持して比較・採用できるようにする。

「この Mac の CLI」は起動場所の説明であり、推論は Google 側で行われる。送信先はそのように表示し、完全な端末内音声認識と混同させない。

失敗時の動作:

- 保存通信が失敗したら結果を app data に保持する。「保存を再試行」で結果だけ送り直し、文字起こしを繰り返さない。
- 途中で停止・CLI 制限・出力不足になったら完了扱いにしない。完了した区切りを保持し、「もう一度」で同じ音声・設定なら未完了の区切りから再開する。
- アプリ終了・クラッシュ後は、保存待ち / 中断状態を復元する。閉じたままの常駐実行は初版に含めない。
- 別アカウントへの切替、録音の削除・音声の変更、古い実行からの遅着結果は、サーバーへの確定を拒否する。
- 文字起こし中の編集を、遅れて返った完了結果で上書きしない。差があれば別案として扱い、採用を利用者に委ねる。

## Options

| 案 | 効果・コスト・制約 |
| --- | --- |
| **A. Mac bridge + 既存の CLI 音声処理 + 共通の録音保存（推奨）** | 旧機能を再利用でき、画面と保存先が統一される。native 境界と結果受付の追加が必要 |
| B. サーバーの Gemini API を使う | サーバー経路は実装済み。ただし Mac のサブスクリプションを使う要求を満たさず、API key と別の費用管理が必要 |
| C. Mac を常駐 worker にし、ブラウザからも依頼する | 後の拡張には有効だが、端末登録・ジョブ配送・不在時の扱いが増える。今回の対象外 |

VTT へ変換して既存 import に渡す方法は短い技術検証には使えるが、既存ページの候補・再試行・実行元の記録が不自然になるので正式な完成形にはしない。

## Recommendation

**A を採用し、UI の二重実装と旧 vault 依存の復活を避ける。**

### 1. pure logic と native の能力を接続する

- 指示文・返事の解析・結合は `docs-core` を使用する。旧 runner の区切り制御を、準備・実行・checkpoint・停止の port を受ける形に抽出する。
- `speech::prepare_audio` / `slice_part` と `niho-local-ai` の `ToolPolicy::ReadFile` を再利用する。旧 Project / Store は新経路へ持ち込まない。
- 仮称 `shell_transcription_prepare` / `shell_transcription_part` / `shell_transcription_stop` / `shell_transcription_release` と状態復元の口を追加する。許す引数は job ID、audio source ID、区切り番号、固定したモデル・言語・固有名詞などだけにする。
- パス・CLI の任意引数・環境・任意 URL は受け取らない。native が作る private staging とファイル名を使う。TS の契約・Rust command・Tauri ACL を同じ変更で更新する。
- 既存の CLI 状態検査を利用し、文字起こし対応 capability を返す。通常ブラウザでは native の選択肢を出さない。
- 既存クラウド音声は、所有者の認証を通る取得経路から画面が読み、上限付きの分割データで native staging に書く。現行 bridge の一括 512 MB 読取に、2 GiB の音声をそのまま載せない。native はサーバーの資格情報を持たない。

### 2. サーバー側の実行・結果受付を足す

- `transcription_runs` / `page_recording_candidates` を再利用し、実行元を `server` と `mac-cli` で明示的に区別する。既存のサーバー claim が Mac 用 run を取得しない条件を入れる。
- Gemini API と CLI の出どころを分ける。現在 `engine` に許す値は DB 制約を含め `deepgram / fake / gemini` なので、表示名だけ追加して済ませず、契約と migration を整合させる。
- 所有者認証と同一 origin 検査を通す Mac 用 run 開始・結果確定・失敗 / 中断受付を追加する。サーバーの API key / runner が無くても使える受付にする。
- run / generation / audio set / 開始時 revision / 実行設定を対応付ける。結果の大きさ・段落・話者・時刻はサーバーでも既存規則で再検証する。
- 確定は冪等にし、重複応答・停止後の遅着・別ユーザー・別ページ・古い世代を拒否する。通信失敗で状態が不明なときも、同じ run の受付状態を照会してから再送する。
- 既存 `finishRun` の世代検査と編集競合の考え方を維持する。lease / 更新時刻を加える場合は Mac 用の長時間実行を既存 stale 掃除と分離して判定する。
- migration は `new-migration` コマンドで作り、expand のみで配備する。

### 3. 共通画面へつなぎ、保存・再開まで確認する

- Tauri の import は `packages/desktop-bridge` に閉じる。app が native / server の port を組み立て、`packages/docs-ui` は Tauri-free を維持する。
- 録音開始・既存録音の両方から同じエンジン選択へつなぐ。進行表示、停止、保存再試行、別案の比較は既存画面へ組み込む。
- app data の checkpoint に、音声の識別値・設定の識別値・完了した区切り・サーバー run ID・保存状態を記録する。設定が変わったときは古い結果を混ぜない。
- 音声・結果の一時置き場は保存成功を確かめるまで保持する。秘密・本文をログに出さず、掃除は既存の staging の運用に合わせる。
- native command が増えるので Web の配備だけでは完了しない。対応した Mac アプリをビルド・配布し、新旧アプリで capability の有無により表示を切り替える。

## Open questions

- **確定:** 初版は Mac アプリ。ブラウザから別 Mac へ依頼する worker は不要。
- **推奨既定:** 最初の結果は空の場合だけ反映、既存の結果があれば別案。途中で手修正されていれば自動で置き換えない。
- **推奨既定:** 旧経路の Flash / low を初期値とし、現行 CLI で利用可能な正確なモデル ID を実機検証して固定する。利用不可なら理由を表示する。
- **初版の範囲:** 中断からの再開・保存再試行は含める。窓を閉じたまま継続する常駐処理、CLI の自動インストール / 自動ログインは含めない。
- **確定:** 通常の分割の目標は 600 秒。無音の近くで切り、利用者の操作は録音全体に対して 1 回にする。
- **実装時の検証:** agy 1.4.12 で合成音声を読み、現行の tool 制限・モデル ID・返事の形式が旧 adapter と合うか確認する。短い疎通確認を長時間音声の無捏造の証明には使わない。

## Next steps

実装は次の 3 つに分けて進める。

1. 現行 CLI の短い合成音声での疎通と、旧ロジックの抽出・native / 型付き bridge。音声 staging と ACL の対象限定テストもここで行う。
2. Mac 実行の開始・結果確定 API と store 契約。重複確定・所有者・音声変更・停止後の遅着・編集競合・サーバー worker との混線をテストする。
3. 共通画面への接続と Mac での受入。5 分をまたぐ複数音声、無音、CLI 制限、停止→再開、保存だけ失敗→再送、起動し直し、別案の採用を確かめる。320px と axe、Mac ビルドを確認する。

全件の Rust / Web 検証は既存 CI に任せ、手元は対象限定テストと合成音声での疎通を実施する。実データ・鍵・CLI の応答全文は証跡へ載せない。

## 実装後の記録

実装の境界・保存・再開の仕様は [設計](../../docs/architecture/editor-mac-gemini-transcription.md) にまとめた。通常経路は10分、出力不足は同区間を最大3回再試行する。10→5分の自動再分割は未実装。実CLIの完走と長時間の品質比較は利用枠復帰後の確認として残る。
