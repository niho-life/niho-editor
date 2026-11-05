# 書く・考えをまとめるを支援する機能の調査（2026-11-05）

NIHO editor（左: ページ一覧／中: エディタ／右: AI）に足すとよさそうな機能と UI を、執筆アプリ・ジャーナリングアプリ・「参照しながら書く」の 3 方面から調べた。オーナーの発案（別ページや Web 記事を右に置いて書く）を軸に、NIHO で実現しやすい順に並べる。出典は各項目の末尾。

## 1. 参照しながら書く（右パネルを「AI／参照」にする）

### 方針
- 右パネルは **1 枚＋タブ**で止める。Obsidian は 3 枚超の split で破綻し、Mem は 2 ペイン、Capacities は側パネル 3 枚に制限している。幅・履歴・狭い画面の状態管理が爆発するので、NIHO は「中央 1 枚＋右 1 枚（AI か参照）」。
  - https://help.mem.ai/features/tabs-and-split-screen / https://docs.capacities.io/reference/navigation / https://forum.obsidian.md/t/a-look-into-heptabases-split-writing-experience/36364
- 最小構成の split の手本は Outline（2026-07）: 文書メニュー「Open in split view」、修飾キー付きクリック、仕切りドラッグ、ダブルクリックで 50/50、各ペイン独立の履歴。 https://www.getoutline.com/changelog/split-view.md
- Heptabase の「書く 1 枚＋右に参照リスト（折りたたみ）」は多段 split より疲れないと評価されている。 https://wiki.heptabase.com/user-interface-logic

### 案 A: 自分の別ページを右に読み取り専用で開く
- 一覧の行を **Shift+クリック**（Logseq・Capacities・Tana の慣習）、またはページの「⋯」→「右に開く」。右は AI と同じ枠にタブで出し、開き直すと置き換える（Mem 方式）。
- 非アクティブ側を少し薄くして「どちらに書いているか」を示す（Ulysses の Dim Second Editor）。 https://help.ulysses.app/split-view
- 同じページを両側に開かない（Capacities の制約と同じ）。狭い画面では右をシートに（既存の narrow 判定に乗る）。
- 既存の `EditorFrame` のレール枠（`.es-rail`）をそのまま使えるので、実装は「読み取り専用ページ描画＋タブ」だけ。

### 案 B: 右から「引用して挿入」
- 右で段落を選ぶ→浮きボタン（またはドラッグ）→左に blockquote＋出典（自ページへのリンク＋ブロック ID）。Zotero の「Add to Note＝引用付き挿入」の自ページ版。 https://www.zotero.org/support/pdf_reader
- Web の引用には **Text Fragments**（`URL#:~:text=`）を付けて原文の該当箇所へ飛べるようにする。Safari 16.1・Firefox 131 で揃い Baseline 化。 https://web-platform-dx.github.io/web-features-explorer/features/scroll-to-text-fragment
- 共通パターン: 「引用＝テキスト＋出典（URL／ページ ID）＋位置（text fragment／ページ番号／タイムスタンプ）」を 1 ブロックとして保存する。

### 案 C: Web 記事は reader コピーで（iframe は使わない）
- 任意サイトの iframe は `X-Frame-Options` / `CSP frame-ancestors` で多数が真っ白になる。Notion の Embed が「Open as page」で逃がしているのがその実態。 https://noc.org/learn/x-frame-options
- 現実解: URL を入れるとサーバーで fetch→本文抽出→清書 HTML を**ページの添付としてユーザー別に保存**して右に表示。失敗時はリンクカード＋「ブラウザで開く」。
  - 抽出ライブラリ: **Defuddle**（kepano、MIT。Obsidian Web Clipper の中身。HTML/Markdown 出力、脚注・数式・コードの正規化） https://github.com/kepano/defuddle 、fallback に **@mozilla/readability**（Firefox Reader View・Obsidian Web viewer の中身） https://github.com/mozilla/readability
  - Obsidian Web viewer（1.8.0、2024-12）は Chromium webview＋Reader view（Readability）＋「vault に保存」。「主ブラウザの代替ではない」と明記し、cookie を持つサイトは外へ逃がしている。 https://obsidian.md/help/plugins/web-viewer
- 法律面: ロクラクII・まねきTV 最高裁（2011）の主体論で、事業者がサーバー側で複製すると私的使用に収まらない恐れ。**ユーザー操作で取得し、キャッシュをユーザー間で共有しない**設計にする。 https://internet.watch.impress.co.jp/docs/news/421875.html
- Mac 殻（Tauri 2）: 同一ウィンドウ内の子 webview は `unstable` feature 必須で保守が薄い。安定 API の別 `WebviewWindow` を本体の右に並べる形なら可。 https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html
- 退役例: Word の Researcher ペイン（2025-01）、Docs の Explore。汎用 Web 検索ペインを内蔵する路線は廃れ、検索は AI か外部ブラウザへ。 https://www.neowin.net/news/microsoft-quietly-kills-a-neat-office-word-feature/

### 案 D: PDF と録音の文字起こしを参照に
- PDF は pdf.js で右に表示→ページ番号付き引用（Obsidian の「Copy as quote」。選択位置へのリンクは壊れやすいので最初はページ番号だけ）。 https://obsidian.md/help/pdf
- 録音ページの文字起こしを右に置き、タイムスタンプ付きで引用。Granola 式に「手打ちが主、AI 補筆は灰色で各文が transcript 行へリンク」。Notion AI Meeting Notes は要約の引用番号→transcript 行へジャンプ。 https://granola.ai / https://www.notion.com/help/ai-meeting-notes

### 案 E: AI に出典を渡す
- AI パネルで `@ページ` `@出典` をチップで添付（Notion／Cursor）。回答の引用番号は NotebookLM 式（hover で全文、クリックで右パネルがその箇所へスクロール）。 https://support.google.com/notebooklm/answer/14276569
- Reflect の「範囲を絞ってから聞く（このページ／今週／タグ）＋出典ノートへのリンク」が信頼を作る。 https://reflect.app/blog/chat-with-your-notes

### 避けること
1. 任意サイトの iframe 前提の設計。
2. ペイン数無制限の多段 split。
3. 取得記事の共有キャッシュ・全文横断保存・内蔵 Web 検索ペイン。

## 2. 書いて考えを整理する（執筆アプリから）

- **浮遊目次＋見出しドラッグで章の並べ替え**: Notion は見出しが 2 つ以上で右端に細い目次が常駐（hover で展開）。Obsidian の Outline は見出しをドラッグすると本文のセクションが入れ替わる。目次を「構造を操作する場所」にする。 https://www.notion.com/help/columns-headings-and-dividers / https://obsidian.md/help/plugins/outline
- **Focus モード**: iA Writer の Sentence／Paragraph Focus（カーソルのある単位だけ濃く）＋ Typewriter（カーソル行を縦中央固定）。公式は「下書きで ON、推敲で OFF」と明言。⌘D で切替。 https://ia.net/writer/support/editor/focus-mode
- **AI はコメントで返す**: Lex はサイドコメントで `@lex` にメンションすると、その箇所について「構造」「論証の弱さ」「筆が止まった時の問い」などのプリセットでフィードバック。Checks は段落を自分で選んで監査し、提案ごとに accept／reject、「?」で理由。 https://lex.page/faq / https://buttondown.com/lex/archive/new-in-lex-check-for-brevity-readability-grammar-8714/
- **AI 由来の文は灰色**: iA Writer 7 の Authorship。AI から貼った文は灰色、書き換えた分だけ黒に戻る。「AI は対話相手、ゴーストライターではない」。 https://ia.net/writer/how-to/track-authors-and-ai
- **版は「上書きせず試す」ための道具**: Lex の Rewind（過去版をスクラブ）＋Versions（名前付きセーブポイント）。Scrivener の Snapshot＋語単位 Compare。AI 書き換え前に自動で版を切る。 https://lex.page/faq / https://kirkville.com/how-to-manage-compare-and-restore-snapshots-in-your-scrivener-projects/
- **Unlinked mentions → 1 クリックでリンク化**（Obsidian／Bear の ⓘ）、**行末 `#型名` でオブジェクト化**（Capacities）: 日記からアイデアを拾い上げる動線を 1 操作に。 https://obsidian.md/help/plugins/backlinks / https://docs.capacities.io/reference/use-cases/daily-notes
- **執筆目標は一覧の小さな丸**（Ulysses Goals: 青→緑→赤、締切から日割り）。本文は汚さない。 https://help.ulysses.app/goals
- **ⓘ に統計・目次・被リンクをまとめる**（Bear 2 Info Panel。ライブ統計は 1 指標だけ常時）。今回の右下文字数ポップオーバーと同じ思想。 https://bear.app/faq/how-to-use-the-info-panel-table-of-contents-and-backlinks-in-bear/
- **Craft AI は結果を copy／insert の選択制**で本文に勝手に入れない。 https://www.craft.do/blog/how-to-use-craft-ai-assistant
- **Workflowy の Zoom**（bullet を押すとその枝だけ表示）、**Scrivener の Corkboard**（カードの並べ替え＝原稿の順）、**Obsidian Canvas**（半端なアイデアを散らしてから束ねる）。 https://workflowy.com/learn/bullets / https://www.literatureandlatte.com/scrivener/features / https://obsidian.md/help/plugins/canvas

## 3. 続ける・振り返る（ジャーナリングアプリから）

- **「今日のページ」を自動で用意**（Obsidian Daily notes／Notion の Repeat テンプレ）。白紙問題の半分は「どこに書くか」。 https://obsidian.md/help/plugins/daily-notes
- **On This Day** を一覧の一等地に（Day One／Journey Throwback／Penzu のメール）。過去の自分に返事を書く動機になり、記事化の素材発見にもなる。 https://dayoneapp.com/features/on-this-day/
- **週単位ストリーク＋書いた日のドットだけ**（Apple Journal Insights。「今週 1 本」で継続扱い、Calendar の空白日は後から埋められる）。Still のような「評価しないカウンタ」も参考。 https://www.tapsmart.com/tips-and-tricks/insights-in-journal/ / https://www.producthunt.com/posts/still-2
- **録音→下書き生成→保存はユーザーが決める**（Apple Journal の「文字起こしする？」、Day One Daily Chat の Generate Entry）。既存の録音機能に直結。 https://dayoneapp.com/guides/ai-features/daily-chat/
- **本文由来の追い質問を 1 問だけ**（Day One Go Deeper／Mindsera の余白コメント）。汎用プロンプトは Pixel Journal で「AI 要らない」と批判された。 https://dayoneapp.com/guides/ai-features/ / https://www.mindsera.com/
- **週次・月次レビューを「下書き」として生成し、記事に昇格**（Mindsera Story View／Reflection Annual Review／Day One Multi-Entry Summary＋Title Suggestions）。ジャーナル→記事という NIHO の二重用途に最も直結。 https://www.reflection.app/
- **AI は既定 OFF・1 トグルで全 OFF・ページ単位の private 除外**（Reflection／Reflect／Day One）。「何が送られるか」をその機能の手前に 1 行。 https://reflect.app/
- **自動メタデータは控えめに、でも「追加された」フィードバックは出す**（Day One／Diarium。Apple Journal は確認が薄く機能が隠れすぎと批判）。 https://ixd.prattsi.org/2026/02/design-critique-journal-iphone-app/
- **書く面と統計面を分離**（750 Words: 白いページとカウンタだけ、統計は別ページ）。 https://www.andrlik.org/dispatches/review-750-words/

## 4. NIHO で優先する順（提案）

1. 右パネルを「AI／参照」のタブにし、自分のページを Shift+クリックで右に開く＋引用して挿入（案 A・B）。既存の枠で済み、効果が大きい。
2. Web 記事の reader コピー（案 C）。サーバーで Defuddle→添付保存。iframe は使わない。
3. 「今日のページ」自動作成＋ On This Day。
4. AI をコメント方式に（段落を選んで「構造」「反論」「不明点」のプリセット）＋ AI 由来は灰色＋書き換え前に版を切る。
5. 浮遊目次（見出しドラッグ）と Focus モード（⌘D）。
6. 週次レビューの下書き生成→記事へ昇格。

## 注記
- Lex は新規受付停止中（2026-11）。Arc は 2026-12 に終了予定。Word Researcher・Docs Explore は退役。Pocket は 2025-10 に終了。
- Craft に 2 文書の split は見当たらず（タブ＋hover プレビュー）。Readwise の deep link、Matter の開発状況は未確認。
