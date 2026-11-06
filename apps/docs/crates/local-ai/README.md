# niho-local-ai

NIHO docs の「このMacの AI」の実行基盤（Issue #18402・Epic #18380 の S1-B）。
Claude Code・Codex CLI・Antigravity CLI（`agy`。Gemini を動かす。`Provider::GeminiCli`）を、ツールを持たない「文を書くだけの AI」として 1 回ずつ起動し、出力を共通の `TurnEvent` に直して返す。Tauri には依存しない（S1-A の Tauri 側が呼ぶ）。

2026-06-18 に gemini CLI が個人向けの契約の受け付けを終えたので、`geminiCli` は後継の agy で動かす（名前と JSON は変えない）。

子プロセスの環境（`env_clear` ＋ 21 個の allowlist）・プロセスグループ・停止（SIGTERM → 猶予 → SIGKILL）・時間切れ・同時 2 件・0600 の一時ファイル・上限と未ログインの判定は、NIHO Desktop の記事エージェント（`apps/desktop/src-tauri/src/article_agent.rs` ほか）から写した。ツールは CLI ごとのフラグ（agy は独自のエージェント）で切り、それでも出力にツールの気配があれば止めて `RUNTIME_NOT_CONFIGURED` にする（fail closed）。

## 公開 API

| 名前 | 何をするか |
|---|---|
| `run_turn(req, on_event)` / `run_turn_with(&Runtime, req, on_event)` | 1 回実行する。別スレッドで動き、`on_event` に `ThinkingDelta`・`TextDelta`（修正の会話では `ToolUse`・`ToolResult` も）を流し、最後に `Done` か `Error` をちょうど 1 回送る。`TurnHandle` を返す |
| `TurnHandle::stop()` / `is_finished()` / `wait()` | 止める（`Done { stop_reason: Stopped }` で終わる）・終わったか・最後のイベントを渡し終えるまで待つ |
| `provider_status(p)` / `provider_status_with` | 入っているか・版・ログイン・`--help` の必要なフラグ（codex は加えて `codex features list` に、`--disable=` で切る機能の名前が全部あること。古い codex は知らない名前で起動しないため、無ければ `--disable=<名前>` を足りないフラグとして返し、画面は「古い版です。更新してください」と出す。実行中に「Unknown feature flag」で止まったときも更新を案内する）・できること（`Capabilities`）・使えるモデル（`models`。agy は `agy models` の 1 列目で、ログインの確認を兼ねる。codex はログイン後の `codex debug models` で visibility が list のもの。claude は空） |
| `start_auth(p)` / `start_auth_with` | 公式のログインを始める（claude は `auth login`、codex は `login`。agy は Err。ターミナルで `agy` を起動してログインする） |
| `install_claude()` / `install_claude_with` | 公式インストーラ（`https://claude.ai/install.sh`）を 0600 の一時ファイルに取って実行する。入っていれば何もしない |
| `update_claude()` / `update_claude_with` | `claude update` だけを渡して更新し、必要なフラグを確かめ直す |
| `provider_usage(p)` / `provider_usage_with` | 使用量の残り（agy だけ。`agy -p "/usage" --output-format json` の群ごとの週の残り＝`UsageWindow { group, name, window, remainingFraction, resetTime }`）。claude・codex は `usage_unsupported`、取れなければ `usage_unavailable`（画面は「取得できません」） |
| `has_running_turns()` / `shutdown()` | 実行中の工程があるか / アプリ終了時に工程（SIGTERM → 800ms → SIGKILL）とログイン待ちを止める |
| `merge_continuation(prev, next)` | 続きの先頭と前の末尾の重なり（最長一致・4〜400 文字。空白だけの重なりは除かない）を除いてつなぐ（spec 5.4 の規則。アプリの続きの結合＝docs-core の `continuationOverlap` と同じ） |

型: `Provider`・`Effort`・`TurnRequest`（JSON は camelCase、時間は `timeoutMs`）・`ToolPolicy`・`TurnEvent`・`StopReason`・`Usage`（`modelUsed` は実際に答えたモデルの ID。Claude Code は stream の `message_start`・無ければ init、Antigravity CLI は init から取る。Codex CLI の JSON にはモデル名が無いので null）・`ReasonCode`（`RUNTIME_…` の文字列）・`ProviderStatus`・`Capabilities`・`LocalAiError`・`ClaudeUpdateResult`・`Runtime`（`codex_home` を含む）・`InstallerConfig`・`ProviderUsage`・`UsageWindow`。

## ツールの方針（`TurnRequest.tool_policy`。S5 #18386）

| 値 | 使う場面 | 何を許すか |
|---|---|---|
| `ToolPolicy::None`（既定。JSON `{"kind":"none"}`） | 工程の実行 | ツールを全部切る（下の「起動フラグ」）。`workdir` で動く |
| `ToolPolicy::ProjectFolder { dir, writable }`（JSON `{"kind":"projectFolder","dir":"/abs","writable":["artifacts"]}`） | 修正の会話（AIと作る） | `dir`（絶対パスの、リンクでない workspace）を基準に読む。Claude は `dir` を cwd にして `writable` の下だけを書ける。Codex は `writable` がちょうど 1 つのとき、その場所を cwd にして書ける。Antigravity CLI は `dir` を cwd にして `writable` の下の `.md` だけを書ける。`TurnRequest.web_search`（JSON `webSearch`。既定 true）なら Web の検索・取得も使える（下の「Web の検索」）。シェル・MCP・サブエージェントは使えない |
| `ToolPolicy::ReadFile { file }`（JSON `{"kind":"readFile","file":"/abs/part-01.wav"}`） | 音声の区切りの文字起こし（S2a #18383。Gemini のサブスクリプション） | Antigravity CLI だけ。`file`（絶対パスの、リンクでない普通のファイル。名前は英数字と `._-`）をその回だけの作業フォルダに同じ名前で写し（0600）、`view_file` だけを持つエージェントに読ませる。続き（`resume_session`）は受けない |

- 契約: `dir` が無い・相対・リンク、`writable` の名前が `[A-Za-z0-9._-]` を `/` でつないだもの以外（`..`・空白・括弧など）・その中に無い・リンクなら、起動せずに `NotConfigured`。Codex は `writable` が 0 個または複数なら起動しない。Antigravity CLI（`GeminiCli`）は `writable` が 0 個・`.` で始まる部分を含む、または `dir` に agy が決まりとして読むもの（`.agents`・`AGENTS.md`・`GEMINI.md`）があれば起動しない。`ReadFile` は claude・codex では起動せずに `NotConfigured`。
- `ReadFile` の agy: エージェントは `niho-docs-transcriber`（`tools: [view_file]`・`subagent: false`・`commandExecutionPolicy: off`。本文がシステムプロンプト）。`view_file` の step は `tool_info.parameters` の絶対パスが作業フォルダの中のときだけ通し、外を読む step・`manage_task` と `view_file` 以外の道具・別のエージェントでの起動は止める（`NotConfigured`）。拒否された道具（`denied_actions`）で終わったら、読めなかったとして `TransientFailure`（呼ぶ側がやり直す。S0 #18381）。`--mode plan` は付けない（agy 1.3.5 は `--disable-slash-commands` と一緒だと「--mode plan has no effect」で効かない。スキルを展開させないほうを取り、道具はエージェントで絞る）。
- イベント: `ToolUse { id, name, summary }`（`name` は claude のツール名 Read・Edit・Write・Glob・Grep、codex は変更の種類で Edit・Write・Delete、agy は道具を写して view_file → Read・list_dir → Glob・write_to_file → Write・replace_file_content と multi_replace_file_content → Edit。`summary` は対象のファイル名だけで、フォルダのパス・本文・検索語は流さない）と `ToolResult { id, name, ok }`（成否だけ。読んだ中身・エラーの文は流さない）。`id` で組にする（claude は tool_use の ID、codex は `<item の ID>:<変更の番号>`、agy は `step-<step_index>`）。JSON は `{"type":"toolUse",…}`・`{"type":"toolResult",…}`。
- `Done.text` は返答（最後のツールの呼び出しより後の文）。それより前の文（実況）は `TextDelta` にだけ流れる。
- Claude Code: cwd を `dir` の実体のパスにし、`--tools "Read,Edit,Write,Glob,Grep"`・`--allowedTools`（`writable` が空なら同じ 5 つ、あれば `Read,Glob,Grep,Edit(./<writable>/**)`）・`--permission-mode`（`writable` が空なら `acceptEdits`、あれば `dontAsk`＝規則に合わない書き込みは確認なしで断る）。`--setting-sources ""`・`--strict-mcp-config`・`--restricted`（cwd と `--add-dir` の外のファイルを読み書きさせない）・`--disable-slash-commands` は保ち、`--add-dir` は付けない。init の `tools` が 5 つの部分集合でない・MCP がある・ほかのツール（Bash・WebFetch・Task・MCP・サーバーのツール）の呼び出し・サブエージェントの内側のイベントは止める（fail closed）。
- Codex CLI: `-C <dir>/<sole writable root>`（続きは同じ cwd）・`--sandbox workspace-write`（続きは `-c sandbox_mode="workspace-write"`）・`-c sandbox_workspace_write.exclude_slash_tmp=true -c sandbox_workspace_write.exclude_tmpdir_env_var=true`（既定では /tmp と $TMPDIR にも書けるため）。`--disable` は `code_mode_host` だけを外した 17 個（0.154.0 の apply_patch は code mode の中にある。シェル・exec_command は切ったままで、code mode の JS は fs もネットワークも持たない）。file_change だけを通し、書ける場所の外のパスが出たら止める。command_execution・mcp_tool_call・web_search・collab_tool_call・知らない item は止める。読むツールは無いので、文書は指示に添えて渡す。
- Antigravity CLI: cwd を `dir` の実体のパスにし、`dir/.agents/agents/niho-docs-editor/agent.md`（フォルダは 0700・agent.md は 0600。`tools: [view_file, list_dir, write_to_file, replace_file_content, multi_replace_file_content]`・`subagent: false`・`commandExecutionPolicy: off`、本文がシステムプロンプト）を置いて `--agent niho-docs-editor --mode accept-edits` で動かす（`.agents` は終わったら消す。続きは `--conversation <id>` で、会話の ID が違えば `RUNTIME_SESSION_NOT_FOUND`）。init のエージェントが違う・`manage_task` とこの 5 つ以外の道具（run_command・search_web・read_url_content・ブラウザなど）・サブエージェントは止める。道具の step の `tool_info.parameters` のパス（`TargetFile`・`AbsolutePath`・`DirectoryPath` など。中身・説明でない鍵の `/`・`~`・`file:` で始まる値も）は、絶対パスで `..` を含まず、`dir` の下にあり、あるところまでの実体（リンクを解いたパス）も `dir` の下でなければ止める。書く道具の `TargetFile` は `writable` の下の、`.` で始まる部分の無い `.md` でなければ止める（書き先を確かめられないまま終わった書く道具も止める）。拒否された道具（`denied_actions`）があって返答が空なら `NotConfigured`。`ToolResult.ok` は step が DONE で error が無いとき true（ERROR・CANCELED などは false）。

- Web の検索（#283。オーナー決定 2026-11-06: 3 つとも検索あり・Bash は禁止）: `ProjectFolder` で `web_search` が true のとき、Claude Code は `--tools`・`--allowedTools` の後ろに `WebSearch,WebFetch`、Codex CLI は `-c web_search="live"` と Web 検索の機能（`web_search_request`・`web_search_cached`）を切る一覧から外す（web_search の item を止めずに流す）、Antigravity CLI は修正用のエージェントの `tools` に `search_web, read_url_content` を足す。コマンド実行（Bash・shell_tool・unified_exec・run_command）は足さず、ほかの道具は今まで通り止める。イベントは `ToolUse { name: "WebSearch" | "WebFetch" }`（`summary` は検索なら空、読むページならホスト名だけ）。1 依頼で検索が 5 回を超えたら止める（`RUNTIME_TRANSIENT_FAILURE`。読むだけの取得は数えない）。`web_search` が false なら 3 つとも Web の道具を許さず、最初に `Notice { code: webSearchOff }`（JSON `{"type":"notice","code":"webSearchOff","message":"検索は切っています。"}`）を送る。Claude Code の init・agy の init の道具の一覧に Web の道具が無ければ `Notice { code: webSearchUnsupported }` を送って検索なしで続ける（Codex は事前に見分けられないので送らない）。Web の検索は本物の CLI ではまだ確かめていない。

同時に動かせる工程はこのMacで 2 件まで。CLI の更新・ログイン・インストールとは排他にする。

## 起動フラグ

| CLI | 起動引数（指示は標準入力） |
|---|---|
| Claude Code | `-p --output-format stream-json --verbose --include-partial-messages [--thinking-display summarized] --setting-sources "" --strict-mcp-config --restricted --tools "" --disable-slash-commands --permission-mode dontAsk --model <model> [--effort <e>] [--max-budget-usd <n>] --system-prompt-file <0600> (--session-id <uuid> \| --resume <id>)` |
| Codex CLI | `exec --json --sandbox read-only --skip-git-repo-check --ignore-user-config --ignore-rules --disable=<18 個> -c web_search="disabled" -c project_doc_max_bytes=0 -c skills.include_instructions=false -c include_permissions_instructions=false -c include_environment_context=false -c include_collaboration_mode_instructions=false -c include_apps_instructions=false -c model_instructions_file="<0600>" -m <model> [-c model_reasoning_effort="<e>"]`。続きは `exec resume <id>` を先頭にし、`--sandbox read-only` の代わりに `-c sandbox_mode="read-only"`。`CODEX_HOME` は `Runtime.codex_home` |
| Antigravity CLI（agy） | `--agent niho-docs-writer --input-format stream-json --output-format stream-json --model <model> [--effort <e>] --disable-slash-commands --print-timeout 0 [--conversation <id>]`。指示は標準入力に 1 行の JSON（`{"event":"user","message":{"content":…}}`）。cwd はその回だけの空の作業フォルダ。`ReadFile` は `--agent niho-docs-transcriber` で、作業フォルダに読ませるファイルを置く。`ProjectFolder` は `--agent niho-docs-editor --mode accept-edits`（`--agent` の直後）で、cwd は `dir`。使用量は `-p /usage --output-format json`（標準入力は閉じる・cwd は空の作業フォルダ） |

- claude: `--thinking-display` を unknown option で拒否されたら、外して 1 回だけやり直し、以後付けない（`update_claude` で忘れる）。先頭が `/` の指示は改行を 1 つ前置する。
- codex の `--disable`: `shell_tool unified_exec code_mode_host apps plugins image_generation goals multi_agent view_image tool_suggest browser_use computer_use in_app_browser skill_search sleep_tool hooks workspace_dependencies skill_mcp_dependency_install`。
- codex のシステムプロンプト: 0.154.0 は `-c base_instructions` を無視して既定のコーディング用の指示のままだった（#18383。本物で「返答の先頭に決まった語」を書かなかった）。0600 のファイルに書いて `-c model_instructions_file` で渡すと既定の指示ごと置き換わる（入力が 1 回あたり約 9.7k → 2.6k トークン）。空のシステムプロンプトはファイルにしない。
- codex が既定で足す指示: スキルの一覧（`~/.agents/skills` と同梱のもの。`CODEX_HOME` を分けても出る）は `skills.include_instructions=false` で切る。ツール無しの工程では権限・環境（cwd・日付）・協調モード・アプリの説明も切る（修正の会話は書ける場所と cwd の説明を残し、スキルとアプリだけ）。`codex debug prompt-input` で、残るのが利用者の `$CODEX_HOME/AGENTS.md` だけであることを確かめた。これは外す設定が無いので、呼び出し側が `Runtime.codex_home`（NIHO docs は app data の下）を渡す。すると、どの codex の呼び出し（版・ログインの確認・`login`・`debug models`・工程）も `CODEX_HOME` がそこになり（無ければ 0700 で作る）、ログインもこのアプリ用になる（ChatGPT の資格情報を写すと refresh token の回転で片方が切れうるので、写さない）。
- agy: 作業フォルダの中を自動で読み書きできるので、利用者の `workdir` ではなく 0700 の一時フォルダの下の空の `ws/` で動かす（会話は agy の側に保存され、`--conversation` は別の cwd からでも続けられる）。ツールは `ws/.agents/agents/niho-docs-writer/agent.md`（0600。`tools: []`・`subagent: false`・`commandExecutionPolicy: off`、本文がシステムプロンプト）の独自のエージェントで切り、`--dangerously-skip-permissions` は付けない。init のエージェントが違う・`manage_task` 以外のツールの step・サブエージェント・拒否されたツールがあれば止める。agy は見つからない会話を新しい会話で続けてしまうので、続きで会話の ID が違えば止めて `RUNTIME_SESSION_NOT_FOUND` にする。effort はそのまま渡し、モデルに合わなければ `RUNTIME_MODEL_NOT_FOUND`。使用量は会話の累計の `result.usage` ではなく、この回の step の和。
- 子プロセスの環境は allowlist だけ（codex は `CODEX_HOME` も。`Runtime.codex_home` があればそれで上書き）。`ANTHROPIC_API_KEY`・`GEMINI_API_KEY`（渡すと API の従量課金になる）などは渡らない。

## テスト

```sh
cd apps/docs/crates/local-ai
cargo test
```

本物の CLI は起動しない。`tests/fake_cli.rs` は `#!/bin/sh` の偽の CLI で、引数・標準入力・一時ファイルの中身・停止・時間切れ・同時実行・ログイン・更新・インストールを確かめる。一時ファイルは `std::env::temp_dir()` の下の固有のフォルダに作って消す。修正の会話は、cwd と許したツールの引数・ツールのイベント・init の違反・フォルダの外（と artifacts/ の外）への Write を断る偽の claude（`--restricted` が無ければ外にも書いてしまう）・codex の workspace-write と外への file_change・agy の修正用のエージェント（cwd・agent.md・`--mode accept-edits`・続き）と、作業フォルダの外・`..`・artifacts/ の外や `.md` 以外への書き込み・ほかの道具の停止、決まりのある作業フォルダを断ることを確かめる。

## 本物で確かめる

```sh
cargo run --example smoke -- claude sonnet medium
cargo run --example smoke -- codex gpt-5.6-luna max
cargo run --example smoke -- gemini gemini-3.8-flash low
```

（`gemini` の指定は agy で動く。agy のモデル ID は `agy models` で見られる）

一時フォルダを作業フォルダにして 1 往復（30 までの漢数字）と、同じ会話での続き（40 まで）を送り、終わり方・会話の ID・使用量・続きの回数・本文の先頭 200 文字・イベントの数と、最後に `provider_status` を表示する。

2026-10-15 に Claude Code 2.1.267（Max）と codex-cli 0.154.0（ChatGPT）で 1 往復と続きが通ることを確かめた。codex で使えるモデル名はアカウントによって違う（`~/.codex/models_cache.json` に出る名前）。

修正の会話（`ToolPolicy::ProjectFolder`）は `tests/real_cli.rs` の `#[ignore]` のテストで確かめる（一時フォルダに案件フォルダを作り、「見出しを短くして」の 1 往復で文書が変わること、フォルダの外・/tmp・artifacts/ の外の project.json への書き込みを頼んでも変わらないこと）:

```sh
cargo test -p niho-local-ai --test real_cli -- --ignored --nocapture
```

2026-10-15 に Claude Code 2.1.267（Max・sonnet）で Read → Edit で見出しが変わり、外の 3 つへの Write はどれも失敗で返って変わらないこと、codex-cli 0.154.0（gpt-5.6-luna）で apply_patch で見出しが変わり、フォルダの外と /tmp への追加が断られることを確かめた（`model_instructions_file` に変えた後も同じ）。

音声の区切りの文字起こし（`ReadFile`）は、まだ本物の agy で確かめていない（2026-10-15 時点で Studio の agy は未ログイン。S0 #18381 の手作業の確認だけ）。偽の CLI では `tests/fake_cli.rs` の `agy_read_file_copies_the_file_and_lets_the_transcriber_view_only_it`・`agy_read_file_outside_the_workspace_or_other_tools_are_stopped`・`agy_read_file_that_was_denied_is_a_retryable_failure` と、apps/docs/src-tauri の `gemini_reads_one_audio_part_and_reports_usage_through_the_crate`・`dev_fake_codex_and_agy_show_their_rows_and_run_through_the_crate`（開発用の偽の agy と偽の niho-speech の `slice`）で確かめる。

修正の会話の agy（`ProjectFolder`）も、まだ本物の agy で確かめていない（2026-10-16 時点で Studio の agy 1.3.6 は未ログイン）。ログイン後に `cargo test -p niho-local-ai --test real_cli real_agy_edits -- --ignored --nocapture` で、修正用のエージェントで見出しが変わること・同じ会話で続けられること・外への書き込みが変わらないことと、道具の step の形（`tool_info.parameters` の鍵・失敗の state・error）を確かめる。偽の CLI では `tests/fake_cli.rs` の `agy_project_folder_*` と、apps/docs/src-tauri の `dev_fake_agy_edits_a_document_in_the_project_folder`（開発用の偽の agy）で確かめる。

システムプロンプトが届くこと（返答の先頭に決まった語を書く決まりをシステム側にだけ置く）は `real_codex_system_prompt_reaches_the_model`・`real_agy_writes_one_turn_with_the_system_prompt` で確かめる。2026-10-15 に codex-cli 0.154.0（gpt-5.6-luna）と agy 1.3.5（gemini-3.8-flash）で通った。
