# NIHO docs から editor.niho.life への機能対応と Mac の切り替え

Issue #45 の対応表と Mac アプリの切り替え方針です。**機能の対応表であり、旧版のデータを editor に取り込む計画ではありません。** 設計は [editor-niho-life-design.md](editor-niho-life-design.md) §3・§13・§14、方針は [editor-niho-life.md](editor-niho-life.md)。

対応状況は editor の現行コードと設計を見て記載しています。旧版からのデータ移行をしないため、非公開の niho-app にある旧保管庫の DB 形状調査や変換器はこの Issue の作業に含めません。

## 0. 決まっていること

- 正本はサーバー。**Mac アプリ・ブラウザ・PWA は同じ UI を同じサーバー相手に描く。** Mac は editor.niho.life を読む殻 ＋ 端末の力（マイク録音・端末内の文字起こし・CLI の AI・ファイル選択・鍵）。ファイル同期は実装しない（Epic #30 §1・§2、設計 §13。オーナー決定 2026-11-01）。
- 「この Mac だけ」は保存先ではなく、**端末内の文字起こしのための一時置き場**。結果はサーバーに書く（設計 §2.1。オーナー決定 2026-11-01）。`desktop-vault` と `DocsStorageMode` は退役。
- **フォルダ構造は維持する**。editor では「子を持てるページ」（`pages.parent`）で表す（オーナー決定 2026-11-01）。
- docs-ui は既存の部品を書き換えず、`shell/` を足してきた（#48）。Mac の配布版は editor.niho.life を既定で開き、旧画面は切り戻し時だけ明示して使う。
- オフラインを主な作業場にすることはしない（#50 はこの線に縮める）。

## 1. 機能の対応表

状態：**そのまま**（editor に同じ機能がある）／**変換**（editor では形を変えて提供する）／**受け皿なし**（editor に同じ機能がない）／**Mac のみ**。この状態は機能の対応を示し、旧版データのコピーは行いません。

| 現行の機能 | 現行の場所 | editor での置き場所 | 状態 | 難所 |
| --- | --- | --- | --- | --- |
| ホーム／最近 | `pages.json`、`HomeScreen`、`recent.json` | サイドバーの木（手動の並び ＋ 更新順）と「最近」 | そのまま | 手動の並びは `pages.sort_order`、「最近」は `page_opens`（migration `20261101013000_folder_order_fields_opens`。[editor-recipes-and-folders.md](editor-recipes-and-folders.md) §4）。`pages.json` に更新時刻が無く、Rust が mtime から出している |
| フォルダ（入れ子なし） | `Project`、`project.json`、`FolderScreen`、`FolderInfo` | フォルダ＝子を持てるページ（`pages.parent`。サイドバーは 1 本の木） | そのまま | 背景情報はフォルダのページの本文、登場人物・固有名詞は `page_fields`（`20261101013000_folder_order_fields_opens`）。自動参考ページは `GET /api/pages/{id}/children` を T5 が使う（§3・§4） |
| 文書ページ | `pages/<id>.md`、`DocumentScreen`、`BlockEditor` | `pages`（`kind=note`）＋ `blocks` | 変換 | Markdown → TipTap。表・コードなど限定 AST 外の要素。画像 `niho-docs-asset:` → `assets`。editor の本文は 1 MiB まで（現行は最大 8 MiB） |
| 録音ページ・音声 | `Recording`、`inputs/`、`RecordingScreen`、`AudioPlaybackBar` | `pages`（`kind=rec`）＋ `page_recordings` ＋ `assets`（`kind=audio`）＋ `page_recording_audios`（2 本目以降） | 変換 | 複数音声は Part ごとに行を持ち、`offset_sec`（前の音声の長さ）で時刻をずらして 1 本につなぐ。上限は 1 ファイル 2 GiB・1 本 6 時間（`audio-limits.ts`）。`available:false` は Part の `status`（取り込み中）と `expires_at`（30 日で bucket から消える）に当たる。**再生は 1 本目だけ**（Part ごとの再生は後段） |
| 文字起こし・話者・別エンジン案 | `transcript.md`、`transcript-speakers.ts`、`candidateSets`（工程 1） | `page_recordings.segments`・`speaker_names` ＋ `page_recording_candidates`（案） | 変換 | `[hh:mm:ss] 話者N: 本文` の行を分解する。終了時刻とミリ秒は `segments` の `start`・`end`（秒の小数）に入るので、editor では原本頼みでなくなる。話者名は**案ごと**に持ち（旧版の「版ごと」に当たる）、採用した案の名前が正本になる。案の状態は列に持たず、有効な run と段落の有無から決める |
| 工程設計（フロー）・テンプレート | `Flow`、`FLOW_TEMPLATES`、`flows/*.json` | 設定 › 手順（`recipes` 表。既定手順・複製・編集） | 変換 | guide・固有名詞・お手本・段階ごとの重さを手順として扱う。旧 Flow 定義は取り込まない |
| 成果物・工程の帯 | `artifacts/<stepId>.md`、`ArtifactScreen`、`WorkView`、`RunBand` | 手順のサブページ（`kind=step`、`parent`＝録音、`step_status`）と手順の帯 | 変換 | stale は `Basis` のハッシュ比較で決まる。原データが無いと再計算できない。複数案（`candidateSets`）の行き先なし |
| 版・履歴・この版に戻す | `versions/<stepId>/v_*.md`、`runs.jsonl`、`auto-version.ts` | `page_versions`、「…」の履歴 | 変換 | `reason` に restore や手動が無い。版の本文は Markdown → blocks。版の数とサイズ |
| AI と作る | `conversation.ts`、`composer.ts`、`ChatPanel`、`DiffDialog` | ページごとの会話、提案の差分、採用・元に戻す。Mac は CLI の AI も同じページにつなぐ | 変換 | 会話・提案の保存形式は editor のもの。旧会話・実行記録は取り込まない |
| リンクで共有 | `page-sharing.ts`、`page-sharing-panel.tsx` | 「…」›リンクで共有、`/s/{token}`（#34） | 変換 | 旧 URL の転送や共有設定のコピーは行わない。転送の要否は旧 Web 停止と合わせて決める |
| 書き出し | `PageTop`、`folder-export-tree.ts`、`GoogleDocs*` | Markdown、Google ドキュメント、フォルダ内の Markdown・写真 zip | 変換 | Finder で表示する動作は Mac の端末機能。旧出力履歴は取り込まない |
| 取り込み（VTT・音声・お手本） | `vtt.ts`、`importAudio`、`FlowDesign` のお手本 | 録音から／音声ファイルから（.vtt 可）、手順のお手本 | 変換 | `transcriptImport` のメタデータと `source.vtt` の原本の置き場。ページや保管庫全体の取り込みは現行に無い |
| 設定：あなたについて | `about.json`（2,000 字） | 設定 › プロフィール（紹介）または AI | 受け皿なし | 意味が違う（プロンプト用の本人情報と、公開時の著者情報） |
| 設定：接続・モデル | `settings.json`、`Settings.tsx` | Web は不要（サーバー側） | Mac のみ | API キー・CLI のログインは移せない |
| 設定：文字起こし | `AppSettings.transcription` | 設定 › 文字起こし | 変換 | 「この Mac」のエンジンは Mac のみ。言語・時刻表示は端末設定（同期しない） |
| 設定：残りの工程・この Mac で続きを受ける | `execution.json`、`PcRunnerSettings` | — | Mac のみ | Web の対応物なし |
| 設定：保存先・使用量 | `CloudSettings`、`DocsStorageModeScreen` | editor は NIHO クラウドを正本にする。Mac は文字起こし用の一時置き場だけ | 変換 | 保存先切り替え・三方向同期は退役。端末内の旧データは自動削除しない |
| 新規作成（⌘N／⇧⌘N） | `Rail.NewMenu`、[home-creation.md](home-creation.md) | 新しいページ▾ | そのまま | — |
| 競合・削除 | `ConflictDialog`、削除したフォルダ | 「別の画面で保存されました」の帯、ゴミ箱 30 日 | そのまま | 旧データを移さないため、旧形式の競合情報は持ち込まない |

## 2. 旧版データの扱い

オーナー決定（2026-11-01）：**旧版のデータは editor へ移さない**。ページ・録音・版・共有・手順・設定・複数案を変換する importer、migration、zip export/import は作らない。既存の `~/Documents/NIHO docs/` と旧クラウド保管庫は、この切り替え処理では削除しない。旧保管庫の DB 形状やユーザーごとのデータ内容を調査する必要もない。

## 3. Mac アプリ：editor.niho.life を読む殻

- Mac 専用の画面は作らない。**Tauri が editor.niho.life を読み、端末の力だけを bridge で足す**（設計 §13）。工程設計・AI と作る・版と履歴・公開・発信先・検索はサーバー側にあるものを使う。
- Mac に残すのは native 層：マイク録音（`niho-speech record`）、端末内の文字起こし（`packages/apple-speech`、`niho-speech` の sidecar）、**CLI の AI（`apps/docs/crates/local-ai`。サブスクのアカウントで起動する旧 NIHO docs の AI チャットの経路は、残すのではなく維持する機能。設計 §6.1）**、ファイル選択、鍵。結果はサーバーの同じ API に書く。一時置き場は文字起こしと AI で 1 つの仕組み（設計 §13）。
- **旧画面は通常経路から退役**：`DocsApp` 一式、#109 の `EditorScreen`・`vault-pages`・`vault-recordings` は配布版の既定画面にしない。受入確認が済むまでは `NIHO_DOCS_SHELL=local` の切り戻し用に残す。`desktop-vault`（三方向併合）、`DocsStorageMode`、`remote-runner`（スマホから受ける実行）は使わない。
- 殻の安全性（capability の `remote.urls` を editor.niho.life に限る、command の allowlist、CSP）は設計 §13 に書いたとおり。
- 配布版は `NIHO_DOCS_SHELL` 未指定なら editor.niho.life を開く。`NIHO_DOCS_SHELL=local` は切り戻し用、`dev` は開発起動だけで localhost を開く。開発起動で未指定なら同梱画面を使う。
- T7 の第 1〜4 段は実装済み：remote shell、id だけでの録音・音声選択・端末内文字起こし、CLI AI、型付き command。remote origin と許可 command は Tauri capability で制限し続ける。
- Mac の UI は別に作らない。editor のログイン・ページ編集・公開は Web と同じ UI/API を使う。native の録音・文字起こし・CLI AI の結果も editor の同じページへ書く。

## 4. 旧 Web の終了と URL

データ移行をしないため、残る切り替え判断は旧 Web の停止日と旧共有 URL の扱いです。停止日・転送先が決まるまで旧 Web の停止や旧 URL の転送はこの Issue から行いません。旧データを editor へ複製したり、旧 Web と editor の間で同期したりしません。

## 5. 受入確認

- 配布版 Mac アプリを起動し、editor.niho.life のログイン画面と共通 UI が表示される。
- ログイン後、サーバーにあるページを開き、本文を保存し、同じページで公開のシートを使える。
- Mac の録音・音声選択・端末内文字起こし・CLI AI が bridge の固定 command を使い、結果をサーバーの同じページへ保存する。remote から旧 vault・任意のファイルパス・任意コマンドへ届かないことを既存 capability/ACL test と targeted test で確認する。
- bundle identifier・deep link・配布物名・tag を変えず、既存アプリの更新経路を維持する。
- 実アカウントの確認は NIHO ログイン接続が使える状態で行う。ログイン依存を偽の本番 fallback で回避しない。

旧版データの変換・取り込み・削除、旧 Web の停止、旧共有 URL の転送は、この Issue の受入に含めない。旧 Web の停止と URL の扱いは、決定後に別 Issue で進める。
