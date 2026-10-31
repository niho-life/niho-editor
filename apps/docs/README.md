# NIHO docs（apps/docs）

工程を本人が設計できる、Mac のドキュメント制作アプリ（Tauri 2 ＋ React）。仕様は `specs/initiatives/niho-docs.md`（Epic #18380）。

| 場所 | 中身 |
|---|---|
| `src/` | 画面（レール・文書・AIと作る・工程設計・設定・初回） |
| `src-tauri/` | 薄い adapter: 案件フォルダ（`store.rs`）・CLI 実行基盤の adapter（`local_ai.rs`）・API キー方式の adapter と CLI との振り分け（`api_ai.rs`）・本人のGoogleドキュメント書き出し境界（`google_docs.rs`）・鍵の保存先＝app data の `api-keys/`（`secrets.rs`）・文字起こし sidecar の呼び出し（`speech.rs`）・録音（`recording.rs`） |
| `crates/api-ai/` | API キー方式の実行基盤 `niho-api-ai`（S2b #18383。Anthropic Messages・OpenAI Responses・Gemini generateContent を SSE で呼び、`local-ai` と同じ意味のイベントに直す。Gemini の Files API と Deepgram の文字起こし・鍵の軽い確かめ。Tauri 非依存・依存は lock にある reqwest〔rustls・ring〕と tokio だけ） |
| `crates/local-ai/` | CLI 実行基盤 `niho-local-ai`（S1-B #18402。Claude Code・Codex CLI・Antigravity CLI（`agy`。Gemini）を、工程の実行ではツール無しで、「AIと作る」では案件フォルダの中だけを読み書きできる形で、文字起こしでは区切りの WAV を 1 つ読むだけの形で動かす） |
| `sidecar/niho-speech/` | 文字起こし・録音の sidecar（S1-C #18403・録音 #18590。Swift・SpeechAnalyzer・AVAudioEngine） |
| `sidecar/fake/` | 開発・テスト用の偽物（`claude`・`codex`・`agy`・`niho-speech`） |
| `scripts/` | 配布（S4 #18385）: 版（`docs-version.mjs`）・sidecar の lock（`sidecar-lock.mjs`・`sidecar.lock.json`）・更新の署名の確認（`updater-key.mjs`）・dmg（`build-dmg.sh`）・Release（`publish-dmg.sh`）・CI の中身（`ci-docs-release.sh`） |
| `fixtures/turn-events/` | イベントの共有の fixture（Rust と docs-core のテストが読む） |

## 開発

```sh
npm -C apps/docs ci
# Rust のビルド前に環境と、その環境の公開 Firebase Web API key を設定（値をログへ出さない）
export NIHO_ACCOUNT_ENV=stg
export NIHO_FIREBASE_API_KEY="<niho-app-stg の公開 Web API key>"
npm -C apps/docs run sidecar:build   # 手元で 1 回（macOS 26 以上の Apple Silicon・Swift 6.2 以上。CI は docs-ci・docs-release が macos-26 でビルドする）
npm -C apps/docs run dev             # このMacの Claude Code・Codex CLI・Antigravity CLI と、sidecar:build の niho-speech で起動
npm -C apps/docs run dev:fake        # 偽の claude・codex・agy と偽の niho-speech で起動（本物が無くても工程の実行・設定の行・Gemini の文字起こしを試せる）
```

- 文字起こし sidecar は 同梱（`.app` の `Contents/MacOS/niho-speech`）→ `sidecar/niho-speech/.build/release/niho-speech`（`sidecar:build` の出力）→ 開発ビルドだけ偽物 の順に探す。偽物で代わりに動いているときは、設定の「この Mac の音声認識」に `npm run sidecar:build` の案内が出る。
- Claude Code・Codex CLI・Antigravity CLI は crate が探す（`~/.local/bin` → npm → Homebrew → ログインシェル）。差し替えは環境変数 `NIHO_DOCS_CLAUDE_CLI_PATH`・`NIHO_DOCS_CODEX_CLI_PATH`・`NIHO_DOCS_AGY_CLI_PATH`（設定より優先）か、app data の `settings.json` の `cliPaths: {"claude": "/abs/path", "gpt": "/abs/path", "gemini": "/abs/path"}`。どちらも起動時に読む。
- 診断ログは `~/Library/Logs/life.niho.docs/local-ai.log`（1 MB で回して 3 世代。指示文・本文は書かない）。
- 開発・試験の起動（`dev`・`dev:fake` の debug ビルドと、上の環境変数で CLI・音声認識を差し替えた起動）は、文書作成用のデータを本番と分ける: app data は `~/Library/Application Support/life.niho.docs.dev`（設定・アプリ用の CODEX_HOME・ログ `logs/local-ai.log`）、保存先の既定は `~/Documents/NIHO docs dev`、API キーはその app data の `api-keys/`（以前の版の鍵を移すときは Keychain の `life.niho.docs.dev.api-key` を読む）、窓の題名は「NIHO docs（開発版）」、自動更新はしない。場所を決めたいときは `NIHO_DOCS_DATA_DIR`・`NIHO_DOCS_ROOT`。本番の窓と同時に開いても、本番の AI 接続・設定・案件に書かない。NIHO アカウントの接続は次節のとおり共有する。クラウドの保管庫は本番のアカウントのものなので、開発・試験の起動では同期しない（設定の「クラウド」は理由を返す）。試すときだけ `NIHO_DOCS_CLOUD=1` を付けて起動する（試験の案件が本人の保管庫に上がる）。
- `dev:fake` の偽物: `codex` は状態の確認とログインだけ（ログインの印は app data の `codex-home/` に置く。工程の実行は失敗で返す）。`agy` は状態・`/usage`・工程の 1 往復・区切りの文字起こし（偽の niho-speech の `slice` が書いた範囲を返す）。`sidecar/fake/.agy-logged-out` を置くと未ログインとして振る舞う。

### 新しい editor の画面（#45 第 1 段）

`editor.niho.life` と同じ shell の枠・同じ本文のエディタ（限定 AST・「/」・書式の帯・囲み）で、保管庫のページを一覧して書く画面。
**既定は今までの画面**で、環境変数を立てたときだけ出る（利用者のデータと権限は今までのまま。bundle identifier・deep link・保存先・配布物の名前は変えない）。

```sh
VITE_NIHO_DOCS_EDITOR_SHELL=true npm -C apps/docs run dev:fake
```

- 本文の正本はこの Mac の保管庫の既存の口（Rust の `open_page_document` / `save_opened_document`）。editor にフォルダは無いので、
  **フォルダの外**の空間（保存先直下の `pages.json` と `pages/<id>.md`）だけを使う。旧い画面のフォルダには触らない。
- 保管庫は Markdown、エディタは限定 AST なので `niho-docs-ui/page` の往復を通す。表・コード・画像・やることのリストなど
  限定 AST の外の要素があるページは、**黙って欠けさせず開かずに知らせる**（移行は #45 第 2 段）。
- まだ無いもの: 公開のシート・発信先・情報パネル・手順の帯・AI・録音・本文の画像・版と履歴・⌘K の全文検索（一覧の題名の絞り込みだけ）。

### Mac の殻（#45 の T7・第 1 段）

設計（`docs/architecture/editor-niho-life-design.md` §13）のとおり、Mac アプリは **editor.niho.life を読む殻 ＋ 端末の力**になる。
この段で入ったのは殻の骨格だけで、**既定は今までの画面のまま**（`NIHO_DOCS_SHELL` を立てたときだけ editor を読む）。

```sh
NIHO_DOCS_SHELL=remote npm -C apps/docs run dev:fake    # editor.niho.life を読む
NIHO_DOCS_SHELL=dev    npm -C apps/docs run dev:fake    # 開発の editor（localhost:3000。開発・試験の起動だけ）
```

- URL は `src-tauri/src/shell.rs` の定数だけ。環境変数やページから URL を受け取らない。
- **remote origin から呼べるコマンド**は `src-tauri/capabilities/remote-editor.json`（`remote.urls` は `https://editor.niho.life` だけ、
  permission は `allow-editor-shell`＝`shell_capabilities` だけ）。保管庫・設定・鍵・CLI の起動の引数には届かない。
  `acl_tests.rs` がこれを固定している（`allow-docs-*` が remote に混ざると落ちる）。
- 開発の `localhost:3000` は `capabilities/remote-editor-dev.json` に分け、`tauri.dev.conf.json`（`npm run dev` / `dev:fake` が付ける）
  のときだけ数える。配布物の `tauri.conf.json` は `app.security.capabilities` を `["default", "remote-editor"]` に固定しているので入らない。
- `shell_capabilities` は殻の自己紹介（版・開発の起動か・端末の力の有無）。画面はこれが返ることで Mac の殻の中だと分かる。
  鍵・パス・端末の名前は返さない。
- **端末の力 ①**（第 2 段）：remote から呼べる command を足した。すべて **id だけ**でやり取りし、パスは画面に返さない。
  - 録音：`shell_mic_status` / `shell_recording_start` / `shell_recording_stop`（名前・長さ・書き出せたか）/ `shell_recording_discard` /
    `shell_recording_read`（書き出した `.m4a` のバイト列。画面がサーバーへ上げる。1 回 512 MB まで）
  - 音声ファイル：`shell_audio_pick`（Mac の選択ダイアログ → 一時置き場 `staging/<id>/audio/<n>.<ext>` に写す）/ `shell_audio_read` /
    `shell_staging_discard`
  - 端末内の文字起こし：`shell_transcribe_local`（出どころは `{ kind: "recording", recordingId }` か `{ kind: "staged", stagingId }`。
    同梱の `niho-speech` で、進みは channel で画面へ）/ `shell_transcribe_stop`
  - 一時置き場（`src-tauri/src/staging.rs`）は app data の `staging/<操作の id>/`（0700・中は 0600）。起動時に 24 時間より古い残骸を掃く。
    端末内の文字起こしと CLI の AI で同じ仕組みを使う（設計 §13）。
  - 結果（文字起こし・音声）をサーバーへ書くのは画面の側（native はサーバーの API に触らない）。
- **端末の力 ②**（第 3 段・`src-tauri/src/shell_ai.rs`）：CLI の AI。本人のサブスクのアカウントで Claude Code・Codex CLI・Antigravity CLI を
  この Mac で動かし、旧アプリと同じく**文書ファイルを直接編集する**。
  - `shell_ai_engines`：3 つの CLI の状態（入っているか・ログイン済みか・使えるモデルの一覧）。パス・版は返さない。
  - `shell_ai_turn(turnId, request)`：依頼は固定の形 `{ engine: "cli:claude-code" | "cli:codex" | "cli:antigravity", model, effort?,
    conversationId?, resumeSession?, instruction, page: { pageId, title, markdown }, context: [{ name, title, markdown }] }`（知らない項目は断る）。
    一時置き場 `staging/<会話の id の hash>/` に `page/body.md`（書ける唯一の場所）・`context/<name>.md`・`instructions.md` を 0600 で置き、
    `ToolPolicy::ProjectFolder { writable: ["page"] }` で CLI を起動する（cwd は一時置き場。同じ会話は同じ path＝CLI の続きが効く）。
    進みは channel に `{ turnId, seq, event }`、結果は `{ finalEvent, page?: { pageId, markdown }, pageRemoved, extraFiles }`。
    **サーバーへ書くのは画面**（T5 の `POST /api/pages/{id}/ai/chat/turns` の `writes`）。終わったら置き場は消す。
  - `shell_ai_stop(turnId)`：止める。
  - 安全性（設計 §13）：remote 由来の文字列で CLI の引数に載るのは**モデルの ID だけ**（`is_safe_model`：空白・制御文字なし・`-` で始まらない）。
    システムプロンプトは native が組み、画面の文字列は題名（1 行に畳む）だけ入れる。指示は標準入力。`/bin/sh` は通らない。
    Codex は唯一の writable root（`page/`）が cwd（crate の `TurnCtx::command`）なので、プロンプトの相対パスは provider ごとに組む。
    同じ会話の依頼は重ねない（置き場の lease。重なったら `shell_ai_busy`）。
- 画面側の包みは `packages/desktop-bridge`（TS。editor-web が `detectShell()` で殻の中かを見分けて使う。Tauri の import はそこだけ。
  command の一覧は `permissions/docs.toml` の `allow-editor-shell` とテストで突き合わせる）。
- 次の段で足すもの：旧い画面の退役、配布の既定を remote に（Web 側に工程設計・AI・録音の画面がそろってから）。

### NIHO アカウント（L5 #18557）

- 設定 › 接続設定の「NIHO アカウント」の丸ボタンから接続する。ログインは任意で、未ログインでも文書作成・工程・AI 接続を使える。
- 「NIHO でログイン」で既定のブラウザが開き、NIHO でのログインと接続の確認を経て `niho-docs://auth` で元の窓へ戻る。設定を閉じていても結果をトーストで知らせる。名前・顔写真・オフライン・期限切れ・ログアウトは共通の `AccountPopover` と `useNihoAccount` が扱う。
- 認証・PKCE・コード交換・更新・token の保存・コールバック処理は `packages/desktop-account`。docs 固有の認証処理は持たない。ID token と custom token は Rust のメモリだけ、接続 refresh token と pending は app data の `account/account-secrets/`（ディレクトリ 0700・ファイル 0600。ad-hoc 署名では Keychain が版の更新ごとに確認を求めるため、Developer ID 署名までは Keychain を使わない。spec D-16 改・#18558）。接続 refresh token は更新のたびに取り替わる。画面・設定・ログに token を渡さない。プロフィールと顔写真は共通 plugin の app data `account/` に保存する（ユーザーに属する）。画像を読める asset scope は `account/account-avatar.*` だけ。
- `NIHO_ACCOUNT_ENV` は `prod`（既定）/ `stg` のみ。対応する公開 Web API key を `NIHO_FIREBASE_API_KEY` で Rust ビルドに埋める。空・環境名の誤りはビルド失敗になる。フロントエンドの `VITE_*` や実行時設定にはしない。公開 key は認証 token ではない。referer 制限のないネイティブ用 key の要否は L1 の受入で確認する。
- macOS のスキーム登録にはバンドルした `.app` が必要。`NIHO_ACCOUNT_ENV=stg` と stg の key を設定して `npm -C apps/docs run tauri -- build --debug`、`apps/docs/target/debug/bundle/macos/NIHO docs.app` を一度起動してから接続する。`tauri dev` だけでは OS に登録されない。prod / stg は別ビルドで、配布 dmg は prod 固定。アカウントの保存（app data の `account/`）は bundle ID ごとで、開発版も同じ接続を使うため、stg 受入では本番接続のない検証用 macOS ユーザーを使う。
- 共通 UI の Tailwind v4 は `account.css` の `@source` でアカウント関連の4部品に限定し、PostCSS で theme と utilities を `.docs-account` 内へ閉じ込める。utilities のみ読み込み preflight は使わない。Portal も同じ要素へ置き、docs の既存 CSS に影響させない。
- CI の Rust check / release dry-run は `ci-not-for-login` で compile だけ行う。配布 workflow は `NIHO_ACCOUNT_ENV=prod` と GitHub variable `NIHO_DESKTOP_FIREBASE_API_KEY_PROD`（未設定なら既存の `WEB_NEXT_PUBLIC_FIREBASE_API_KEY`）を渡す。ネイティブ用 key が必要なら前者を登録する。`build-dmg.sh` は key が無い・stg のときビルド前に止まる。
- 実ログインの受入は L1（API / key 制限・claims）と L2（接続画面）の配備後、L6 #18558 で行う。ログイン→ブラウザ→コールバック→名前と顔写真、閉じたアプリの起動、接続解除後の再ログイン、ログアウト、改ざん state を確認する。L5 のローカル確認は偽の transport による状態・操作・通知と、設定・CSP・ビルド契約まで。

### Google ドキュメントへの書き出し

- 設定の「Google ドキュメント」で本人のGoogleアカウントを接続する。外部認証後はブラウザの完了画面に留まり、NIHO docsへ戻るとfocusで接続状態を確認する。新しいdeep linkは使わない。
- 文書のページと成果物の子ページの「書き出し › Google ドキュメント」（タイトルバーの右端）は同じ確認ダイアログを開く。未保存の文書本文・編集中の成果物・選択中の履歴を含む、その時点で見えている本文の写しから新しい文書を作る。元の案件・ページ・成果物は変更しない。
- 最初の送信で `exportId`・タイトル・本文・接続先を凍結する。通信結果が不明なときは同じIDをGETで確認し、未受付またはAPIが再試行可能と返した場合だけ同じID・同じ内容でPOSTする。閉じたり同じGoogleへ再接続したりしても受付を保持し、別の内容を新規作成するときは作成済みの可能性を確認してから新しいIDにする。別Googleへ旧IDは送らない。成功後も、本人が「Google ドキュメントを開く」を押すまでブラウザは開かない。
- ID token、Google credential、本文はRustの専用HTTP境界だけで扱う。画面に返すのは接続の公開状態と公開結果だけ。詳しい契約・受入・ロールアウトは `ops/runbooks/niho-docs/google-docs-export-app.md`。

### 接続設定（S2a・S2b #18383）

設定 → 接続設定 の見出しの右で方式を選ぶ（**サブスクリプション／API キー**の全体 1 択）。上限・失敗でも自動で切り替えず、実行中（工程・会話・文字起こし）は画面でも Tauri（`save_settings` が `connection_busy`）でも切り替えない。方式ごとに 登録した AI・プロファイルの表・文字起こしのエンジンを持ち、案件とフローはそのまま。作成済みの案件の工程は、案件を作った方式と違う方式で実行すると同じプロファイル × 提供元を今の方式の表で解決し直す（実際に使ったモデルを `runs.jsonl` に残す）。その AI が今の方式に登録されていなければ、別の AI に寄せずに止めて理由を出す。

#### サブスクリプション方式

設定 → 接続設定 には**登録した AI の行だけ**が出る（初めは Claude）。「＋ 追加」で Claude／GPT／Gemini から 1 つ選ぶと、その CLI の導入・ログインを確かめて行にする。行の ⋯ に 確認・解除（最後の 1 つは解除できない）。AI を 1 つだけ登録しているあいだは、どの画面にも他社の名前・行・選択肢が出ない。

| AI | CLI | 導入 | ログイン |
|---|---|---|---|
| Claude | Claude Code | 行の「導入」（公式のインストーラ） | 行の「ログイン」（ブラウザ） |
| GPT | Codex CLI | `brew install --cask codex`（または `npm install -g @openai/codex`） | 行の「ログイン」。NIHO docs は app data の `codex-home/` を `CODEX_HOME` にして動かすので、ターミナルの codex でログイン済みでも、ここで一度ログインする（`~/.codex/AGENTS.md` とスキルを工程に混ぜないため） |
| Gemini | Antigravity CLI（`agy`） | `brew install --cask antigravity-cli` | ターミナルで `agy` を起動して Google のアカウントでログインし、行の「確認」 |

- モデル: 設定 → モデル の表（プロファイル × 登録した AI → モデル × 思考量）。GPT・Gemini の選択肢はログイン後に CLI が返す一覧（`codex debug models`・`agy models` の Gemini だけ）、取れなければ控えの一覧。無い組み合わせ（Gemini 3.8 Flash の「最大」・思考量入りのモデル名に別の思考量）は選べない。初期値は 標準＝Claude Sonnet 4.6 × 高・GPT-5.6-Terra × 高・Gemini 3.8 Flash × 中、高性能＝Claude Opus 4.8 × 高・GPT-5.6-Terra × 最大・Gemini 3.8 Flash × 高。
- 文字起こし: 既定のエンジンは Gemini → この Mac の順で登録した分だけ出し、既定は使える中の先頭（Gemini を登録していれば Gemini）。Gemini は音声を `niho-speech convert → silence → slice` で区切りの WAV にし、区切りごとに agy に `view_file` で読ませて `[hh:mm:ss] 話者N: 本文` の 1 本にする（指示と結合は docs-core の `audio-transcription.ts`）。終わった区切りまでは checkpoint に残る。
- 使用量: 今月の 登録した AI ごとの実行・入力／出力トークン・所要と実際に使ったモデル、文字起こしの回数・音声の長さ。Gemini には agy の `/usage` の週の残りを添える。返らない値は「取得できません」。
- 登録していない AI を指す工程は登録した AI の先頭で実行し、工程設計のカードと実行の行で知らせる。作成済みの録音が登録を外した AI に解決済みなら、別の AI で実行せず止め、録音のページの「この録音の工程を今の設計に更新」で直す。
#### API キー方式（S2b）

「＋ 追加」で Claude（Anthropic）／GPT（OpenAI）／Gemini（Google Gemini）と、文字起こし用の Deepgram（API キー方式だけ）から選ぶと行になる。行に API キーを貼り付けて「保存」すると、1 回の軽い呼び出し（モデルの一覧。Deepgram はプロジェクトの一覧。料金はかからない）で確かめてからこの Mac の app data に保存する（失敗なら保存しない）。

- 鍵の置き場: app data の `api-keys/<account>`（account は `anthropic`／`openai`／`gemini`／`deepgram`。ディレクトリ 0700・ファイル 0600・一時ファイルから rename で書き換え）だけ（#18769）。配布物は ad-hoc 署名でビルドごとに署名の要件（`cdhash`）が変わり、Keychain の項目は版を上げるたびに確認（ログインのパスワード）を求めるため、Developer ID 署名（2027 年の予定）までは Keychain に置かない。以前の版が Keychain（service `life.niho.docs.api-key`）に置いた鍵は、初めて要るときに鍵ごとに 1 回だけ確認が出て `api-keys/` へ移る。拒否したら行に「入れ直してください」が出て、以後 Keychain は見ない（記録は `api-keys/legacy.json`。Keychain の項目は新しいビルドから消せないので残る。不要ならキーチェーンアクセスで消す）。画面へは返さない（行に出すのは 未設定・保存済み〔末尾 4 文字〕・無効）。`settings.json`・案件フォルダ（`project.json`・`runs.jsonl`・checkpoint・会話）・診断ログ・会話の履歴に書かない。提供元のエラーの本文に鍵らしい文字列があれば伏せてからログに残す。鍵は HTTP のヘッダーだけに付ける（URL に入れない）。
- 行の操作: 確認（保存済みの鍵で 1 回）・⋯ に 鍵を入れ直す・鍵を削除・解除（解除は鍵もこの Mac から消す。最後の AI は解除できない）。
- 呼び先: Anthropic `POST /v1/messages`（`stream`・`max_tokens` 64,000・`thinking: adaptive`〔要約を思考に出す〕・`output_config.effort`）、OpenAI `POST /v1/responses`（`stream`・`store: false`・`max_output_tokens` 64,000・`reasoning.effort`〔最大は `xhigh`〕）、Gemini `models/{model}:streamGenerateContent?alt=sse`（`maxOutputTokens` 65,535・`thinkingConfig.thinkingLevel`）。工程の実行ではツールを渡さない（「AIと作る」は下）。上限で止まったら（`max_tokens`・`incomplete_details.reason=max_output_tokens`・`MAX_TOKENS`）アプリが同じ会話で続きを頼む。会話の履歴は crate が app data の `workspaces/<実行>/api-session-<id>.json`（0600・24 時間で掃除）に持ち、続きは履歴ごと送る（各社のサーバーに会話を残さない）。
- 失敗: 鍵が無い → 「〈提供元〉 の API キーが保存されていません」、鍵が無効（401・403）→「API キーが無効です。設定 › 接続設定で確かめてください。」、429・残高不足 → 利用上限か残高、モデルが無い（404）→ 設定のモデル、5xx・途中で切れた → 一時的、接続できない・時間切れ。どれもそこで止める（別の方式・別の AI で実行し直さない）。
- モデル: 表は API キー方式だけの別の表。控えは版つきの ID（CLI の別名は API で使えないので出さない）: Claude Sonnet 4.6・Opus 4.8・Fable 5、GPT-5.6-Terra・Luna、Gemini 3.8 Flash・3.1 Pro。鍵を確かめたときに返った一覧（工程に使える種類だけ）があればそれ。初期値は 標準＝Claude Sonnet 4.6 × 高・GPT-5.6-Terra × 高・Gemini 3.8 Flash × 中、高性能＝Claude Opus 4.8 × 高・GPT-5.6-Terra × 最大・Gemini 3.1 Pro × 高。
- 文字起こし: エンジンは Gemini → この Mac → Deepgram（登録した分だけ。既定は使える中の先頭）。Gemini API はサブスクリプションと同じ区切りの WAV を Files API に上げて添え（`ACTIVE` を待ち、終われば失敗・停止でも消す）、指示と結合は docs-core の `audio-transcription.ts`（「添付の音声を…」）。Deepgram は NIHO 本体の設定の写し（`nova-3`・`smart_format=false`・`punctuate`・話者を分けるときだけ `diarize_model=latest`・`utterances`・`paragraphs=false`・固有名詞の表記を `keyterm`〔500 トークンまで〕）で録音を同期で送り、返りを docs-core の `deepgram.ts` で `[hh:mm:ss] 話者N: 本文` にする。
- 使用量・見込み金額: 設定の使用量は方式ごとに数え、API キー方式は「見込み」の列（サブスクリプションは金額を出さない）。単価表は docs-core の `pricing.ts`（出典と確認日を注記。直して main に入ると次の版で配られる）。実行の行（▶ 〈工程名〉を実行）と履歴に送る字数と見込み金額を添える。トークン数が返らない・単価表に無いモデルは推測せず「取得できません」。
- 「AIと作る」: アプリが持つ道具（`list_files`・`read_file`・`edit_file`・`write_file`。会話の隔離 workspace の中だけ・書けるのは `artifacts/` の下の `.md` だけ）を各社の API の形で渡し、道具の呼び出しが続く間はアプリが実行して結果を返す（最大 40 往復）。会話の履歴は app data の `local-ai/chat-sessions/<案件>/<会話>/` に残し、続きは履歴ごと送る。使用量は API キー方式の記録として見込み金額で数える。

#### 共通

- 「AIと作る」（S5 #18386）: 録音のページと成果物の子ページの右レールの入力欄の指示を、録音の文書（工程 1 の文字起こし・文章は `artifacts/source.md` として）を写した会話ごとの隔離 workspace（app data の `local-ai/chat-workspaces/`）を作業フォルダにして AI に送る。AI はその中だけを読み、書けるのは `artifacts/` の下だけ（文書のページには出さない。crate の `ToolPolicy::ProjectFolder`。Claude Code・Codex CLI・Antigravity CLI・API キー方式の 3 社）。入力欄の「＋」から工程を実行できる。AI が書き換えた文書は版になり（`runs.jsonl` に `kind: agent`）、会話は `conversations/<id>.json`。`dev:fake` の偽の claude は、会話では `artifacts/` の最初の文書の末尾に 1 行足して返す。

### 録音（#18590）

文書ヘッダーまたは空の録音ページの「この Mac で録音」でマイク録音を始める。録音は画面移動後も続き、全画面共通の録音帯から止めると、開始元の案件に日時付きの録音ページを作って音声を保存する（開始元が文書なら参考ページにする。録音ページに既存素材がある場合は上書きしない。Mac の音声＝画面共有の相手の声などは第 2 段）。

- 録るのは sidecar の `niho-speech record`（`sidecar/niho-speech/README.md`「record・mic-status」）。Tauri の `recording.rs` が app data の `recordings/<録音の id>.m4a` に起動し、行（録り始め・約 0.2 秒ごとの音量と長さ）を画面に流す。同時に 1 本まで。工程の実行・文字起こしとは同時に動かせる。
- 画面: 赤い点・経過（`00:05`・`1:02:03`）・音量のメーター・入力の装置の名前・「止める」。止めると AAC（mono・24 kHz・48 kbps。1 時間 ≈ 22 MB）に書き出し、音声の一覧に「録音 10/16 15:30」として入る。保存で案件の `inputs/` に写し、写し終えた録音は `recordings/` から消す（写す前に消すと、保存に失敗したときに録音を失うので、保存の後）。
- 録っている間は `recordings/<id>.recording.caf` に書き続ける（落ちても読める CAF）。アプリが落ちた・書き出しやページ保存に失敗したときの録音は、画面に依らず全画面共通の録音帯に「前回の録音」として出て、「録音のページに保存」か「捨てる」（確かめる）を選べる。再試行では同じページ・音声を使い、保存完了まで元音声を消さない。
- ページ・案件・設定を移っても録音は止まらない。窓を閉じるときは確かめ、止めるなら録音ページへ保存してから閉じる。⌘Q で終えたときは確かめずに止めて元音声を残し、次回の「前回の録音」にする。「更新して再起動」は録音中なら確かめてから止める（`restart_to_update` の `busy` に録音も入る）。マイクが外れて入力の装置が無くなったときは、そこまでで止めて録音ページへ保存する（別の装置に変わったときは続ける）。録っている間はシステムのスリープを止める（蓋を閉じると眠る）。
- マイクの許可（macOS の「プライバシーとセキュリティ」→「マイク」）は NIHO docs に付く（.app の Info.plist の `NSMicrophoneUsageDescription`＝`src-tauri/Info.plist`。Tauri が `tauri build` で merge し、`tauri dev` では実行ファイルに埋め込む）。初めて「この Mac で録音」を押したときに聞く。断られていれば案内と「システム設定を開く」を出す。マイクが無ければ「マイクが見つかりません」。
- **既知の制限: ad-hoc 署名のままなので、版を上げるたび（自動更新を含む）に macOS がマイクの許可を聞き直す**（許可は署名に付くため。Issue #18590 の試作で確認。Developer ID で署名するまで直さない・owner 2026-10-16）。
- `dev:fake` の偽の niho-speech: `record` は 0.2 秒ごとに音量の行を出し、止めると固定サンプル（13.35 秒）を写す。`sidecar/fake/.mic-denied` を置くと許可が無い、`sidecar/fake/.mic-none` を置くとマイクが無い として振る舞う。

## ビルド

`npm -C apps/docs run build:app` は `sidecar:build` のあと `tauri build --config src-tauri/tauri.sidecar.conf.json` で、niho-speech を externalBin として `.app` に入れる。externalBin を `tauri.conf.json` 本体に書かないのは、普段の `cargo build`（docs-ci の `cargo check`・`dev:fake`）でもバイナリを要求して止まるため（NIHO Desktop の写真編集エンジンの overlay と同じ）。配る dmg は下の「配布」の `build-dmg.sh` で作る。

## 配布（S4 #18385）

**出荷対象を変えた PR が main に入ると、公開の workflow が次の版を決めて自動で公開し、各 Mac の NIHO docs が更新を取得する**（PR では版を上げない。#18744・owner 2026-10-17）。起動時と1時間ごとの確認で取得した後でも、「更新して再起動」を押した時点で最新公開版を再確認し、途中の版を順に入れずにその版へ更新する。最新版の確認・取得に失敗したら再起動せず、もう一度押して再試行できる。手元でビルドしない。署名（Developer ID）と公証はまだしない（NIHO Desktop・NIHO camera と同じ。owner 2026-10-15）。

- 公開: main に入ると `.github/workflows/docs-release.yml` の `plan` が、最後に公開した版（`docs-v*` の tag で semver が最大のもの）から出荷対象が変わっていれば公開すると決め、次の版を採番する（下の「版」）。公開の前に「公開前の前提」を確かめ、通れば `macos-26` で作業場の 5 か所を次の版に書き換えて（`docs-version.mjs apply`。main には commit しない）`scripts/build-dmg.sh` を通し、`scripts/publish-dmg.sh` で GitHub Release `docs-v<版>-<sha12>`（prerelease）に `NIHO-docs-<版>-<sha12>.dmg`・`.sha256`・自動更新の `.app.tar.gz`・`.sig` を上げ、`https://niho.life/docs/updater/latest.json` が新しい版を返すまで確かめる。中身は `scripts/ci-docs-release.sh`（`plan` / `publish` / `dry-run`）。workflow・`scripts/`・`sidecar.lock.json`・`tauri.sidecar.conf.json` を変えた PR では、使い捨ての署名鍵でビルドまで行う dry-run が走る（公開しない）。失敗したときのやり直しは `gh workflow run docs-release.yml --ref main`。
- 版: PR では版を触らない。出荷対象（`src/`・`index.html`・`vite.config.ts`・`packages/docs-core/src/`・`packages/docs-ui/src/`・`src-tauri/`・`crates/local-ai/` の `src/` と `Cargo.toml`・`Cargo.*`・`package*.json`・`sidecar.lock.json`・sidecar を同梱する `scripts/stage-speech-sidecar.mjs`。テスト・文書・ほかの `scripts/` は外す）が最後の公開から変わっていれば、`plan` が `max(main の版, 公開済みの最大 ＋1 patch)` を次の版にする（`git ls-remote --tags origin 'refs/tags/docs-v*' | node apps/docs/scripts/docs-version.mjs next`）。main の 5 か所（`package.json`・`package-lock.json`・`tauri.conf.json`・`src-tauri/Cargo.toml`・`Cargo.lock`）の版は「床」で、普段は誰も触らない（公開した版は tag の名前に残る。作り直すときは tag の commit を checkout して `docs-version.mjs apply <版>`）。途中で落ちた公開の番号は使い回さない。`publish-dmg.sh` は公開済みの最大以下の版を上げない（手元から古い版を出してダウンロードの欄が戻るのを防ぐ）。待っている間に次の merge が来ると、GitHub の concurrency で待ちの run が新しい方に置き換わり、数本の merge が 1 つの版にまとまる。サーバーが「この版以上なら」で機能を分ける作りは、PR の時点で番号が分からないので使わない（機能の有無で分ける）。
- 公開前の前提: `release-requirements.json` に「main のコードが前提にするサーバーの設定」を並べ、`plan` が公開と決めたときだけ `scripts/release-requirements.mjs check` で本番へ問い合わせる（認証なしの GET）。`enforce: true` の項目が満たされない・確かめられないときは公開せず run を赤にし、summary に足りないものと直し方を出す（main のコードは入ったまま、配るのだけ待つ）。`enforce: false` は警告だけ。今は「本番でログインを受け付ける」（`/api/auth/app-connections` が `404 app_connect_disabled` でない）の 1 件で、#18730 以降のアプリは閉じている間もログイン画面で塞がないので `enforce: false`。アプリを本番の設定に頼る作りにする PR（例: 閉じていてもログイン画面で塞ぐ）は、この表に項目を足すか `enforce` を true にする。
- 文字起こし sidecar: `scripts/build-dmg.sh` が `npm run sidecar:build`（`swift build -c release`）の出力を `src-tauri/binaries/niho-speech-aarch64-apple-darwin` に置き、`.app` の `Contents/MacOS/niho-speech` に入れる。`sidecar.lock.json` に sidecar の版（`Sources/NihoSpeech/Tool.swift`）・`Package.swift` の `swift-tools-version`・署名 ID（`niho-speech`。SpeechAnalyzer の言語の予約は署名 ID ごとなので変えない）・ソース（`Package.swift`・`Sources/`）の指紋を固定する。ソースを変えたら `node apps/docs/scripts/sidecar-lock.mjs update`（lock は出荷対象なので、main に入ると公開される）。docs-ci が `sidecar-lock.mjs check` で照らし、macos-26 で release ビルドの版・arm64・macOS の dylib だけを確かめて `swift test` を回す。配る `.app` は `check-app`（版・署名 ID）まで通す。
- 自動更新: `src-tauri/src/updater.rs`。起動時と、その後 1 時間ごと（取得するまで）に `plugins.updater.endpoints`（`https://niho.life/docs/updater/latest.json`。Web の `apps/web/app/docs/updater/` が private の Release を `DESKTOP_RELEASE_GH_TOKEN` で代理で読む。NIHO Desktop と同じ token・同じ作り）を見て、新しい版があれば取得して署名（`plugins.updater.pubkey`）を確かめ、手元に持つ。`.app` は動いている間は差し替えない（文字起こしは区切りごとに `.app` の中の `niho-speech` を起動するので、途中で差し替えると古い版が新しい版の sidecar を起動してしまう）。差し替えるのは終わるとき（`RunEvent::Exit`。工程・文字起こしを止めた後）だけで、別の NIHO docs が工程を実行している間は差し替えない。画面にはレールの下端（工程設計・設定の上。起動の失敗の画面ではその画面）に「新しい版 X があります」と「更新して再起動」を出す（押すと `restart_to_update` で開き直す。工程・会話・文字起こしが動いている間は `busy` が返り、画面が「止めて再起動」を確かめてから `force` で頼み直す。別の NIHO docs が工程を実行している間は `otherAppRunning` で、force でも開き直さない。30 秒たっても閉じなければ「閉じて開き直すと切り替わる」に変える。押さなければ、閉じたときに差し替えて次の起動で新しい版になる）。結果は診断ログ（`local-ai.log` の `auto_update.staged` / `auto_update.installed` / `auto_update.install_deferred` / `auto_update.failed`）。公開鍵がプレースホルダー（`REPLACE_WITH_DOCS_UPDATER_PUBKEY`）の間と開発ビルドでは、updater を初期化せず、画面にも出さない。
- 未公証: `.app` は Tauri が ad-hoc で署名する（`tauri.conf.json` の `bundle.macOS.signingIdentity: "-"`・hardened runtime なし。Developer ID ではない）。linker の署名だけの `.app`（NIHO Desktop の今の形）は `codesign --verify` が通らず、ブラウザで落とすと「壊れている」扱いになりうるので、NIHO camera と同じ「正しい ad-hoc 署名」にした（`syspolicy_check distribution` は ad-hoc と未公証の 2 つだけになる）。ブラウザで落とした dmg の初回だけ、開くと止められるので **システム設定 →「プライバシーとセキュリティ」→「このまま開く」** で許可する（macOS 15 以降は右クリック →「開く」では通らない）。自動更新で入れ替わった版は許可が要らない。sidecar は署名し直されても署名 ID が `niho-speech` のまま（実行ファイルに埋め込んだ Info.plist。`check-app` が確かめる）。

### 署名鍵と公開鍵（最初の 1 回・2026-10-15 に設定済み）

2026-10-15 に設定済み（鍵 ID `F34393DB22906F01`・秘密鍵は Mac Studio の `~/.niho/docs-updater.key`、パスワードは空＝NIHO Desktop と同じ）。鍵を作り直すと、それまでに配った版は以後の更新を受け取れなくなるので、作り直さない。以下は最初に設定したときの手順の記録（鍵を無くしたときは、その下の「鍵を無くしたとき」）。

自動更新の成果物は Tauri updater の鍵（minisign）で署名し、各 Mac は `tauri.conf.json` の公開鍵で確かめる。鍵が無い間は公開しない（`ci-docs-release.sh plan` が publish=false にして summary に手順を出す）。

1. 鍵を作る（パスワードを聞かれる。空でもよい）: `npm -C apps/docs exec -- tauri signer generate -w ~/.niho/docs-updater.key` → 秘密鍵 `~/.niho/docs-updater.key` と公開鍵 `~/.niho/docs-updater.key.pub`。秘密鍵は commit しない・人に渡さない（無くすと、配った版がそれ以降の更新を受け取れない）。
2. GitHub の Settings → Environments に `docs-release` を作り、Deployment branches を `main` だけにして、secret を置く: `TAURI_SIGNING_PRIVATE_KEY`（`~/.niho/docs-updater.key` の中身）・`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（1 のパスワード。空のときは置かない＝GitHub の secret は空の値を持てず、未設定は空として渡る）。
3. `src-tauri/tauri.conf.json` の `plugins.updater.pubkey` を `~/.niho/docs-updater.key.pub` の中身に差し替える PR を出す（この PR が main に入ると、その版から公開が始まる）。`node apps/docs/scripts/updater-key.mjs status` で鍵 ID が出れば形は合っている。公開のたびに `updater-key.mjs verify` が、上げる `.sig` をこの公開鍵で確かめる（秘密鍵との組の取り違えを止める）。
4. Web（本番）に `/docs/updater/latest.json` が配備済みであること（S4 の PR の Web の変更）。公開の最後に `ci-docs-release.sh` がこのフィードの版を確かめる。

**鍵を無くしたとき**（配った版は、それ以後の更新を受け取れない）:

1. 上の 1・2 で新しい鍵を作り、Environment `docs-release` の secret を置き換える。
2. 上の 3 の公開鍵の差し替え PR を出す。`tauri.conf.json` は出荷対象なので、main に入ると `plan` が次の版を採番して新しい公開鍵の版を公開する（版上げは要らない）。
3. 配った版は古い公開鍵で署名を確かめるので、新しい版へは自動更新されない。各 Mac で新しい版の dmg を落として入れ直す（下の「新しい Mac への導入」の 1〜3）。

### 手元でのビルド・公開（CI が使えないときの予備）

```sh
git ls-remote --tags origin 'refs/tags/docs-v*' | node apps/docs/scripts/docs-version.mjs next   # 次の版を出す
node apps/docs/scripts/docs-version.mjs apply <次の版>   # 作業場の 5 か所だけ書き換える（commit しない）
NIHO_ACCOUNT_ENV=prod NIHO_FIREBASE_API_KEY="<本番の公開 Web API key>" ./apps/docs/scripts/build-dmg.sh      # apps/docs/release/ に dmg（鍵があれば updater の成果物も）。Apple Silicon・Node 24・Rust・Xcode 26
./apps/docs/scripts/publish-dmg.sh    # docs-v<版>-<sha12> の Release に上げる（merge 済み main の commit・版の 5 ファイル以外は clean・公開済みより大きい版・鍵の確認つき）
```

- 鍵は `TAURI_SIGNING_PRIVATE_KEY`（と `_PASSWORD`）か `~/.niho/docs-updater.key`。無ければ dmg だけ作る（配らない。`publish-dmg.sh` が止める）。
- 確かめるだけなら `./apps/docs/scripts/ci-docs-release.sh dry-run`（使い捨ての鍵で署名と検証まで）と `publish-dmg.sh --dry-run`。

### 新しい Mac への導入（Apple Silicon・macOS 26 以上を推奨）

1. 最新の `NIHO-docs-<版>-<sha12>.dmg` を落とす。NIHO にログインして（拠点のホスト・スタッフか管理者）開発者向けページ `https://niho.life/developer#docs` の「.dmg をダウンロード」を押す（Web の `apps/web/app/docs/latest-release`・`download` が、private の Release `docs-v*` の最新の dmg を代理で返す）。GitHub に権限があるなら、ブラウザか `gh release download <tag> --repo niho-coliving/niho-app --pattern 'NIHO-docs-*.dmg'` でもよい。
2. dmg を開いて `NIHO editor.app` を「アプリケーション」へドラッグする（dmg の中から直接開かない。自動更新が `.app` を差し替えられない）。
   以前の名前（`NIHO docs.app`）で入っている場合は、先に終了してゴミ箱へ入れてから置く（旧名と新名を並べない。bundle identifier と保存先は同じなので、設定・ページは同じ場所から読まれる）。同じ名前で入っている場合は置き換え、別名のコピーは作らない。アプリ本体のコピーは macOS 側で作れるが、同じユーザーの同じ保存領域を使うアプリは、場所・版が違っても 1 つだけ起動する。2 回目に開くと既存の画面を表示し、設定・同期・工程をもう一度始めない。認証 callback で開いた場合は同じユーザー専用 socket で URL を既存プロセスへ渡し、受領を確認する。ログイン時の `--background` が重なった場合は画面を出さない。旧版にはこの排他がないため、導入時は旧版を終了してから新しい版を開く。
3. 開く。止められたら システム設定 →「プライバシーとセキュリティ」→「このまま開く」。
4. 設定 → 接続設定 で Claude Code の「導入」「ログイン」（ブラウザで本人がログイン）、「この Mac の音声認識」の「取得」（日本語のモデル・約 340 MB。macOS 26 以上）。GPT・Gemini を使うなら「＋ 追加」（上の「接続設定」）。起動すると前回のページ（初めてならホーム）が開き、工程を選ぶ前でも設定を開ける。
5. タイトルバーのアプリ名の右（レールの右端）の ＋（新規作成）→「ページ」で空の文書のページが開く（名前は聞かず、題はページの上で書く）。「フォルダ」は無題のフォルダを作ってフォルダのホームを開く（フォルダはページの入れ物。#18867）。音声から工程を回すときは、新規作成の ＋ かフォルダの行の ＋ の「音声」（か文書のページの「/」→「録音のページ」）で録音のページを足し、「ファイルを選択」か「この Mac で録音」で音声を入れると「工程を実行」できる。録音のページで話者人数・言語と「参考」（同じ案件の文書のページ。工程の入力に入る。P3 #18566）を選べる。初めて録音のページを足すときにだけ「工程を選ぶ」（記事制作・議事録・インサイト整理・白紙から）が出る。あとから工程設計の「テンプレート ▾」で選び直せる。案件は `~/Documents/NIHO docs/projects/<id>/`（フォルダ名は短い id。案件名とページの一覧は `project.json`、文書は `pages/<id>.md`、録音は `recordings/<id>/`。P1 より前の案件は案件フォルダの直下が録音 1 枚。保存先は設定で変えられる）。

既知の制限（v1）: Apple Silicon だけ（Intel・Windows は無い）・未公証（初回だけ許可）・録音と この Mac・Gemini の文字起こしは macOS 26 以上（それより前は Deepgram〔API キー方式〕だけ。設定と録音のページに理由が出る）・API キー方式の見込み金額は単価表 × 返ったトークン数（請求額ではない。長い入力の割増・キャッシュは数えない）・Antigravity CLI のログインは画面から始められない（ターミナルで `agy`）・更新は次の起動で切り替わる（窓を開いたままだと古い版のまま）・録音のマイクの許可は版を上げるたびに聞き直される（ad-hoc 署名）・録音は Mac の音声を録らない（マイクだけ）。

## App Icon

ページに筆のイラスト（`src-tauri/icons/`）。NIHO アプリの石・NIHOkamakura の家の中の石・NIHO camera のカメラと同じ色（水色の面・紺の行・
橙の筆・生成りの土台）で、Dock で並べたときに同じ家族に見えて、文書のアプリだと分かる形にした（owner 2026-10-16。案の比較は
`idea/mock/niho-docs-app-icon-v1.html` の案 D）。それまでは NIHO Desktop と同じ PWA 由来のアイコンだった。

- 元は手描き風の SVG `src-tauri/icons/icon.svg`（1024px・viewBox 256・角丸と影まで含む macOS の土台つき。比較のモックの案 D の
  `icon-d` と土台の `tile` をそのまま単独の SVG にしたもの）。`rsvg-convert -w <寸法> -h <寸法> src-tauri/icons/icon.svg` で 16〜1024px の
  PNG に描き出し、`iconutil -c icns` で `icon.icns` にした（描き出した 256px・1024px は置いている PNG と画素まで一致する）。macOS で使う
  `icon.icns`・`icon.png`（1024px）・`32x32.png`・`128x128.png`・`128x128@2x.png`（256px）を置く（NIHO docs は Mac だけ。`icon.svg` は
  元データで、`tauri.conf.json` の `bundle.icon` には入れない）。`tauri icon` は使っていない（四角のまま icns にするので、角丸と影を自分で
  足すことになる）。
- 直すときは `icon.svg` を直して描き出し直す。出荷対象なので、main に入ると次の版で配られる。

## テスト

```sh
cd apps/docs
cargo fmt --all --check
# compile 専用の偽 key。本物のログインはしない
NIHO_FIREBASE_API_KEY=ci-not-for-login cargo check --locked --workspace --all-targets
NIHO_FIREBASE_API_KEY=ci-not-for-login cargo test --locked --workspace
npm -C apps/docs test && npm -C packages/docs-core test && npm -C packages/docs-ui test
```

- Rust のテストは crate の `Runtime.cli_paths` に偽の CLI（`sidecar/fake/claude`・`codex`・`agy` と、fixture の出力を流すだけの台本）を渡し、adapter → crate → 偽の CLI を通す。
- API キー方式は 127.0.0.1 の偽の API サーバーで確かめる（本物の鍵は使わない）: `crates/api-ai/tests/fake_api.rs`（3 社の stream・上限で止まる → 同じ会話で続き・429・401・404・5xx・時間切れ・停止・Gemini の Files API・Deepgram・鍵の確かめ）、`crates/api-ai/tests/folder_tools.rs`（「AIと作る」の道具の往復: 3 社とも read_file → edit_file → 返答、2 往復目に thinking の signature・encrypted reasoning・thoughtSignature をそのまま返す、パスの抜け道は道具のエラー、40 往復で止まる、往復の間の停止、道具の往復を含む続き）、`src-tauri/src/api_ai_tests.rs`（メモリの鍵の保存先で、鍵の確かめと保存・振り分け・偽の鍵で工程と文字起こしを通した後に、イベント・診断ログ・app data のどこにも鍵が無いこと）、`test/api-key.test.tsx`（画面: 方式の切り替え・鍵の行・Deepgram・見込み・入力欄・1 社だけ・画面が書くファイルに鍵が無いこと）。
- 本物で確かめる（CI では走らない。`cd apps/docs` で）:
  - `cargo test -p niho_docs real_claude -- --ignored --nocapture`（このMacの Claude Code で 1 往復）
  - `cargo test -p niho-local-ai --test real_cli -- --ignored --nocapture`（「AIと作る」: 案件フォルダの文書を Edit で直し、フォルダの外・artifacts/ の外への書き込みは断られる。Claude Code・Codex CLI・Antigravity CLI〔`real_agy_edits`〕）
  - `cargo test -p niho_docs real_sidecar -- --ignored --nocapture`（`sidecar:build` の niho-speech で固定サンプルを convert → silence → transcribe）
  - `NIHO_SPEECH_E2E=1 swift test --package-path sidecar/niho-speech --filter RecordEndToEndTests`（本物のマイクで 2 秒録って SIGTERM で止める。入力の装置があり、テストを動かすプロセス〔ターミナル〕にマイクの許可があるときだけ。許可は聞かない）
  - `cargo test -p niho_docs --lib keychain_round_trip -- --ignored`（本物の Keychain に、テスト用の service `life.niho.docs.api-key.test` で偽の鍵を書いて読んで消す。Developer ID 署名の後に Keychain へ戻すときの adapter）
  - `read -rs KEY && printf '%s\n' "$KEY" | cargo run -p niho-api-ai --example smoke -- anthropic claude-sonnet-4-6 medium`（本物の API。料金がかかる。鍵は標準入力から。`openai gpt-5.6-luna low`・`gemini gemini-3.8-flash low [区切りの.wav]`・`deepgram - - 録音.m4a` も同じ）。鍵の確かめ → 上限を小さくした 1 往復 → 同じ会話で続き。4 つめに `chat` を渡すと「AIと作る」の道具の往復（一時の workspace の文書を直す → 同じ会話で続き）
