# NIHO docs から editor.niho.life への移行：対応表と手順

Issue #45 の前半（対応表とデータの移行手順）です。Mac アプリの作り直し（後半）は、段階 1〜2 の完了が先なので、方針と順番だけを §6 に置きます。設計は [editor-niho-life-design.md](editor-niho-life-design.md) §3・§13・§14、方針は [editor-niho-life.md](editor-niho-life.md)。

事実はコードと文書を読んで確かめたものです。**推測**と書いたものは、実行して確かめていません。クラウド保管庫（`/api/me/docs-vault`）のサーバー側の DB の形は非公開の niho-app にあり、この repo からは読めません。§4 の取り込みは、その形を確認してから確定します。

## 0. 決まっていること

- 正本はサーバー。**Mac アプリ・ブラウザ・PWA は同じ UI を同じサーバー相手に描く。** Mac は editor.niho.life を読む殻 ＋ 端末の力（マイク録音・端末内の文字起こし・CLI の AI・ファイル選択・鍵）。ファイル同期は実装しない（Epic #30 §1・§2、設計 §13。オーナー決定 2026-11-01）。
- 「この Mac だけ」は保存先ではなく、**端末内の文字起こしのための一時置き場**。結果はサーバーに書く（設計 §2.1。オーナー決定 2026-11-01）。`desktop-vault` と `DocsStorageMode` は退役。
- **フォルダ構造は維持する**。editor では「子を持てるページ」（`pages.parent`）で表す（オーナー決定 2026-11-01）。
- docs-ui は既存の部品を書き換えず、`shell/` を足してきた（#48）。Mac の旧い画面は殻に置き換わるまで動く。
- オフラインを主な作業場にすることはしない（#50 はこの線に縮める）。

## 1. 機能の対応表

状態：**そのまま**（editor に同じ機能がある）／**変換**（形を変えて移せる）／**受け皿なし**（editor のモデルに置き場が無い。§7 で決める）／**Mac のみ**。

| 現行の機能 | 現行の場所 | editor での置き場所 | 状態 | 難所 |
| --- | --- | --- | --- | --- |
| ホーム／最近 | `pages.json`、`HomeScreen`、`recent.json` | サイドバーの一覧（更新順） | 変換 | 手動の並び（`PageIndex.order`）は無くなる。`pages.json` に更新時刻が無く、Rust が mtime から出している |
| フォルダ（入れ子なし） | `Project`、`project.json`、`FolderScreen`、`FolderInfo` | サイドバーにフォルダは無い（親子は録音→手順のサブページだけ） | 受け皿なし | 背景情報、登場人物、固有名詞、自動参考ページ（同じフォルダの独立文書を最大 64 枚）の行き先 |
| 文書ページ | `pages/<id>.md`、`DocumentScreen`、`BlockEditor` | `pages`（`kind=note`）＋ `blocks` | 変換 | Markdown → TipTap。表・コードなど限定 AST 外の要素。画像 `niho-docs-asset:` → `assets`。editor の本文は 1 MiB まで（現行は最大 8 MiB） |
| 録音ページ・音声 | `Recording`、`inputs/`、`RecordingScreen`、`AudioPlaybackBar` | `pages`（`kind=rec`）＋ `page_recordings` ＋ `assets`（`kind=audio`）＋ `page_recording_audios`（2 本目以降） | 変換 | 複数音声は Part ごとに行を持ち、`offset_sec`（前の音声の長さ）で時刻をずらして 1 本につなぐ。上限は 1 ファイル 2 GiB・1 本 6 時間（`audio-limits.ts`）。`available:false` は Part の `status`（取り込み中）と `expires_at`（30 日で bucket から消える）に当たる。**再生は 1 本目だけ**（Part ごとの再生は後段） |
| 文字起こし・話者・別エンジン案 | `transcript.md`、`transcript-speakers.ts`、`candidateSets`（工程 1） | `page_recordings.segments`・`speaker_names` ＋ `page_recording_candidates`（案） | 変換 | `[hh:mm:ss] 話者N: 本文` の行を分解する。終了時刻とミリ秒は `segments` の `start`・`end`（秒の小数）に入るので、editor では原本頼みでなくなる。話者名は**案ごと**に持ち（旧版の「版ごと」に当たる）、採用した案の名前が正本になる。案の状態は列に持たず、有効な run と段落の有無から決める |
| 工程設計（フロー）・テンプレート | `Flow`、`FLOW_TEMPLATES`（記事制作・議事録・インサイト整理・コーチング）、`flows/*.json` | 設定 › 手順（`pages.recipe`） | 受け皿なし | 手順の実体の表が無い（`recipe` は text の参照だけ）。`guide`、`terms`、`samples`、プロファイル（標準・高性能・軽量）。録音ごとの `flowSnapshot` |
| 成果物・工程の帯 | `artifacts/<stepId>.md`、`ArtifactScreen`、`WorkView`、`RunBand` | 手順のサブページ（`kind=step`、`parent`＝録音、`step_status`）と手順の帯 | 変換 | stale は `Basis` のハッシュ比較で決まる。原データが無いと再計算できない。複数案（`candidateSets`）の行き先なし |
| 版・履歴・この版に戻す | `versions/<stepId>/v_*.md`、`runs.jsonl`、`auto-version.ts` | `page_versions`、「…」の履歴 | 変換 | `reason` に restore や手動が無い。版の本文は Markdown → blocks。版の数とサイズ |
| AI と作る | `conversation.ts`、`composer.ts`、`ChatPanel`、`DiffDialog` | ページの AI（書式バーの「AI」＋差分の提案） | 受け皿なし | 会話履歴の置き場が無い（設計 §6 は提案を採用まで保存しない）。新しい文書を作る動作、フォルダ内の他ページを見る動作は消える。CLI 方式は Mac のみ |
| リンクで共有 | `page-sharing.ts`、`page-sharing-panel.tsx` | 「…」›リンクで共有、`/s/{token}`（#34） | 変換 | 既存 URL は `niho.life/docs/p#<22文字>`。`share` の列が無い。「最新の本文」型か固定した版か |
| 書き出し | `PageTop`、`folder-export-tree.ts`、`GoogleDocs*` | 「…」›書き出し（.md＋写真の zip、Google ドキュメント）、設定 › 保存 | 変換 | フォルダ前提の木を、ページ＋サブページの木に作り替える。「Finder で表示」は Mac のみ。全ページの一括書き出しは現行に無い |
| 取り込み（VTT・音声・お手本） | `vtt.ts`、`importAudio`、`FlowDesign` のお手本 | 録音から／音声ファイルから（.vtt 可）、手順のお手本 | 変換 | `transcriptImport` のメタデータと `source.vtt` の原本の置き場。ページや保管庫全体の取り込みは現行に無い |
| 設定：あなたについて | `about.json`（2,000 字） | 設定 › プロフィール（紹介）または AI | 受け皿なし | 意味が違う（プロンプト用の本人情報と、公開時の著者情報） |
| 設定：接続・モデル | `settings.json`、`Settings.tsx` | Web は不要（サーバー側） | Mac のみ | API キー・CLI のログインは移せない |
| 設定：文字起こし | `AppSettings.transcription` | 設定 › 文字起こし | 変換 | 「この Mac」のエンジンは Mac のみ。言語・時刻表示は端末設定（同期しない） |
| 設定：残りの工程・この Mac で続きを受ける | `execution.json`、`PcRunnerSettings` | — | Mac のみ | Web の対応物なし |
| 設定：保存先・使用量 | `CloudSettings`、`DocsStorageModeScreen` | 設定 › 保存 | 受け皿なし（使用量） | 使用量は実行記録（`runs.jsonl`）から出していた。editor に実行記録の表が無い |
| 新規作成（⌘N／⇧⌘N） | `Rail.NewMenu`、[home-creation.md](home-creation.md) | 新しいページ▾ | そのまま | — |
| 競合・削除 | `ConflictDialog`、削除したフォルダ | 「別の画面で保存されました」の帯、ゴミ箱 30 日 | そのまま | 移行の対象外にするか |

## 2. データの対応

| 現行 | 形 | editor | 変換 |
| --- | --- | --- | --- |
| `pages/<id>.md`（文書） | Markdown。画像は `niho-docs-asset:<name>` | `pages.blocks`（TipTap の限定 AST）、`assets` | `editor/markdown.ts` の `createDocsMarkdown` が再利用候補（**推測**）。未対応の要素は取り込み時に報告 |
| `recordings/<recId>/recording.json`・`inputs/*`・`transcript.md` | JSON ＋音声＋ Markdown | `pages`（`rec`）、`assets`（`audio`） | `Segment` に分解。複数音声は Part 境界を offset に落とす |
| `artifacts/<stepId>.md`、`versions/<stepId>/v_*.md`、`runs.jsonl` | Markdown ＋ JSON Lines | `pages`（`step`）、`page_versions` | `versionPath` で版と実行記録を突き合わせる。旧い `created_at` を指定して入れる |
| `flows/<id>.json` | JSON | 手順（実体の表が必要） | §3 |
| `about.json`、`execution.json` | JSON（`profile` 同期の対象） | プロフィール／AI | §7 の決定後 |
| `settings.json`、API キー、`codex-home`、`device.json`、`vault/` | 端末のみ（同期しない） | 移行しない | 再設定 |
| 共有の `publicId` と URL | クラウド保管庫 | `share` | §7 の決定後 |

保存の場所：Mac は `~/Documents/NIHO docs/`（DB は無く、Markdown と JSON のファイル）。クラウド保管庫は同じ構造を `packages/desktop-vault` が `/api/me/docs-vault` と三方向併合で同期する（範囲は `docs-root`・各フォルダ・`flows`・`profile`）。音声は別の背景キューで上げ下げする。

## 3. editor のモデルに足りないもの

`packages/editor-store` の migration 0001（`pages`・`page_versions`・`assets`・`publications`）と、設計 §3 を比べた不足です。

| 不足 | 理由 |
| --- | --- |
| 録音の列（`recording{asset, transcript, speakers, engine}`）、音声の長さ・元ファイル名・複数音声・`source.vtt` | 録音ページを移せない |
| 手順（recipes）の表 | `pages.recipe` は text の参照だけ |
| `share{token, enabled}` | 共有リンクを移せない（#34 が足す） |
| 取り込み元の ID と冪等性の列 | 再実行しても二重に入らないため。旧 `pageId`（短い乱数）→ UUID の対応表が要る |
| `created_at`・`updated_at` を指定して入れる口 | 旧データの時刻を保つ |
| `page_versions.reason` の語彙（`restore`・手動）、作成者・モデルの列 | 版の意味を保つ |
| 実行の記録と使用量（トークン・費用・モデル） | 使用量の表示を残すなら |
| `author` のスナップショット、プロフィール、設定の表 | 著者・提案言語・固有名詞・文字起こしのエンジン |

どれも §7 の決定のあとに migration を切る。この Issue では足さない。

## 4. 移行の手順

方針：**旧データを書き換えず、新しいものを作る**。取り込みは何度実行しても同じ結果（冪等）にし、旧 Web／Mac と editor の書き込み先が二重にならない並走期間を決める。

1. **準備**：旧 ID → 新 ID（UUID）の対応表と、取り込み元の ID の列を用意する。合成データ（§8）で変換器を先に通す。
2. **クラウド保管庫のユーザー**：保管庫から本文・録音・版・共有を読み、変換して editor に取り込む。実行の主体は (i) サーバー側の一括変換（非公開側）か、(ii) 本人が「取り込み」を実行する（§7-2）。本文は Markdown → blocks、文字起こしは行 → `Segment`、版は旧い時刻つきで。1 MiB を超える本文と、変換できない要素は**取り込まずに一覧で報告**する（黙って欠けさせない）。
3. **「この Mac だけ」のユーザー**：サーバーに何も無いので、Mac から取り出す新しい機能が要る（保管庫全体の書き出しは現行に無い）。Mac で zip（Markdown ＋写真＋音声＋メタデータ）に書き出し、editor で取り込む。同期はしない。
4. **並走と切り替え**：旧 Web（`niho.life/app/docs`）の書き込み停止日、旧 URL（共有リンク）の転送、editor 側の受け付け開始日を決める。
5. **確認**：取り込んだ件数・欠けた要素を本人に見せる。旧データは削除せず、一定期間残す。

## 5. 失われやすいもの（editor に受け皿が無い）

手動の並び、「最近」、自動参考ページ、stale 判定の根拠（`Basis`）、AI と作る の会話と差分の控え、実行記録と使用量、`RunCheckpoint`、派生文書の出典（`derivation`）、端末ごとの設定（`settings.json`・API キー・CLI のログイン）。残すか捨てるかは §7-4。残す場合は書き出し（zip）に入れるか、新しい表を切る。

受け皿ができたもの: 複数案（`candidateSets`）は**工程 1（文字起こし）の案だけ** `page_recording_candidates` に入る（#36 段 3b-4。同じ音声を別のエンジンで起こして見比べ、採用する）。成果物の工程（工程 2 以降）の案は、まだ受け皿なし。フォルダは維持（§7-1 の決定）。

## 6. Mac アプリ（#45 の後半）：作り直さず、殻にする

- Mac 専用の画面は作らない。**Tauri が editor.niho.life を読み、端末の力だけを bridge で足す**（設計 §13）。工程設計・AI と作る・版と履歴・公開・発信先・検索はサーバー側にあるものを使う。
- Mac に残すのは native 層：マイク録音（`niho-speech record`）、端末内の文字起こし（`packages/apple-speech`、`niho-speech` の sidecar）、**CLI の AI（`apps/docs/crates/local-ai`。サブスクのアカウントで起動する旧 NIHO docs の AI チャットの経路は、残すのではなく維持する機能。設計 §6.1）**、ファイル選択、鍵。結果はサーバーの同じ API に書く。一時置き場は文字起こしと AI で 1 つの仕組み（設計 §13）。
- 退役：`DocsApp` 一式、#109 の `EditorScreen`・`vault-pages`・`vault-recordings`、`desktop-vault`（三方向併合）、`DocsStorageMode`、`remote-runner`（スマホから受ける実行。要るなら別 Issue）。
- 殻の安全性（capability の `remote.urls` を editor.niho.life に限る、command の allowlist、CSP）は設計 §13 に書いたとおり。
- 依存：録音の API（#36）がそろった時点で録音・端末内の文字起こしから着手できる。CLI の AI は T5 の API の後。

## 7. オーナーに決めてほしいこと

◎は暫定の推奨です。

| # | 質問 | 選択肢 |
| --- | --- | --- |
| 1 | フォルダをどうするか | (A) フォルダ名の空ページの下にぶら下げる (B) フラットにして題名の接頭辞などで残す ◎ (C) 捨てる。背景情報・登場人物・固有名詞は録音の「背景」と設定の固有名詞へ振り分ける案。自動参考ページ（最大 64 枚）は捨てるか、明示的な参考にするか |
| 2 | 誰がいつ移行するか | (i) サーバー側の一括変換（旧 Web の停止日と転送を決める） (ii) 本人が「取り込み」を実行。並走期間の長さ |
| 3 | 「この Mac だけ」の新しい形式 | 今のファイル構造にアダプタを付けるか、別の局所ストアか。`desktop-vault` は廃止か縮小か。Mac の同じ一覧にサーバーのページと混ぜるか |
| 4 | 捨てていいデータ | AI と作る の会話、使用量、複数案、別エンジンの文字起こし案、`RunCheckpoint`、stale の根拠 |

決まったもの（オーナー 2026-11-01）：**1** → フォルダは維持。editor では子を持てるページ（深さはフォルダ › ページ › 録音のサブページまで）。**3** → 「この Mac だけ」は保存先ではなく端末内の文字起こしの一時置き場だけ。`desktop-vault` は退役。**4** → 旧版のデータは**運ばない**（オーナー「旧版のデータは全て削除でも良い。簡単な方で」。受け皿ができた複数案も移行では運ばない）。**2 は未決**（旧 Web の停止日・旧 URL の転送だけが残る。データを運ばないので一括変換も取り込みも作らない）。
| 5 | 「あなたについて」の行き先 | プロフィールの「紹介」（公開時の著者）と統合するか、AI の項目として別に持つか |
| 6 | 版の持ち方 | 全版か直近 N 版か。`reason` に `restore` を足すか |
| 7 | 既存の画像の掲載許諾 | `consent=false` で入れ、公開時に再確認 ◎ |
| 8 | 共有リンク | 既存の `niho.life/docs/p#…` を生かす（クライアント側の転送が要る）か、新しい `/s/{token}` に作り直して旧を失効するか。固定した版か最新の本文か |
| 9 | 手順の移行 | ユーザーが作った `Flow` を全て手順にするか。プロファイル（標準・高性能・軽量）を editor でも見せるか。最終工程を `article` にするか `step` のままか |
| 10 | 上限 | 本文 1 MiB（現行は 8 MiB）、音声の長さ・容量（現行 2 GiB・6 時間）を設定にどう明記するか（設計 §12） |
| 11 | Web の AI | サーバー側の AI だけにするか、API キーの持ち込みを許すか。CLI・API キー・「Mac で続きを受ける」は Mac だけの力として残す、でよいか |
| 12 | 同じ ID か | クラウド保管庫の本人（accountKey）と editor の `owner`（NIHO の安定したユーザー ID）が同じ ID か（非公開側で確認） |

## 8. 確かめ方（受入）

合成データで、次の 4 件をそれぞれ変換して editor で開く：録音あり（複数音声・話者つき）／フォルダあり／共有中／「この Mac だけ」。件数・本文・版・時刻・話者名が欠けないこと、変換できない要素が報告されること、取り込みを 2 回実行しても二重にならないことを確かめる。合成データには個人情報・実データ・秘密を入れない（[publication-gates.md](../security/publication-gates.md)）。

## 9. この文書に含まないもの

変換器・取り込みの実装、migration、Mac アプリの差し替え、旧 Web の停止、データの実移行。§7 の決定のあとに、Issue を切って進める。
