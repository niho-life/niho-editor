# 手順の表とフォルダの木（#37 T1・T2）

状態: 手順の表は**実装済み**（migration `20261101001500_recipes.sql`）。フォルダは **2026-11-06 に作り直し**（§3。`kind = 'folder'` と録音の欄）。Issue #37、設計 [editor-niho-life-design.md](editor-niho-life-design.md) §3・§7.2、実行基盤は [editor-steps-execution.md](editor-steps-execution.md)。

この文書が決めるのは 2 つ。**手順（記事制作・議事録・インサイト整理）をどこに持つか**と、**フォルダをどう表すか**。どちらも「正本はサーバーに 1 つ」（オーナー判断 2026-10-31）に従う。

## 1. 決めたこと

| | 前 | 後 |
| --- | --- | --- |
| 手順の既定 | editor-web の TypeScript の定数（`DEFAULT_RECIPES`） | 表 `recipes` の行（`origin = 'builtin'`） |
| 手順に手を入れた分 | `editor_settings.recipes`（jsonb の列。0013） | 同じ表の同じ行 |
| 手順が持てるもの | 名前・お手本・工程の名前と指示 | ＋ 工程のプロファイル・この手順の固有名詞・お手本の文書 |
| フォルダ | 2026-11-01: 子を持てるふつうのページ（`pages.parent`） | **2026-11-06: `kind = 'folder'` のただの入れ物**（§3）。背景・登場人物・固有名詞は録音ページへ |

## 2. 手順の表（`recipes`）

```
recipes (owner, id)   -- 主キー。人ごとに 1 行ずつ
  name          手順の名前（「記事制作」）
  guide         お手本（文書ガイドの Markdown。全工程の入力に入る）
  steps         工程 [{ id, name, instruction, profile, provider? }]
  terms         この手順の固有名詞 [{ term, reading, variants, note }]
  samples       お手本の文書 [{ id, name, chars, truncatedFrom?, sourceUrl? }]
  origin        builtin | own | import
  sort_order    一覧の並び（0 から）
  revision      中身が変わるたびに 1 つ増える
  imported_from 取り込みの受け皿（旧 NIHO docs の工程設計の id）
```

- **値の形と上限を決めるのは [packages/editor-store/src/recipes.ts](../../packages/editor-store/src/recipes.ts) の 1 か所**（`recipesProblem`）。表の `CHECK` は配列であることと件数だけを守る。上限は設定（0013）と同じ値を使う（手順 20・工程 12・指示 8,000 字・お手本 20,000 字）。
- **既定の中身（指示文の正）は docs-core の `FLOW_TEMPLATES`**。表にその文字列を SQL で書き込むことはしない（migration は行を持たない。`test/schema.test.ts` がそれを守る）。
- **既定が表に入るのは、その人の行が 1 つも無い最初の読み出しのとき**（[apps/editor-web/src/server/recipe-source.ts](../../apps/editor-web/src/server/recipe-source.ts)）。行が 1 つでもあれば書かない（消した手順を勝手に戻さない）。
- **既定の手順を増やすのは `DEFAULT_RECIPE_IDS` に 1 つ足すだけ。** もう表に行がある人にも、次の読み出しで足りない既定だけが並びの後ろに入る（`addRecipes`）。既にある行は中身も並びも版も動かさない。コーチング（docs-core の `tpl-4`）を入れ直すかは**オーナー確認待ち**で、この PR では足していない。
- **0013 の列からの引き継ぎはその 1 回だけ**。写すときに `editor_settings.recipes`（既定に手を入れた分・足した分）をかぶせる。設定の形には工程のプロファイルが無いので、同じ id の工程のプロファイルを既定から引き継ぎ、足した手順・新しい工程は「標準」にする。
- **列を落とすのは引き継ぎが要らなくなる配備の 1 つ後**（expand → contract）。この migration では `editor_settings.recipes` に触らない。
- 工程を 1 つも持たない行は読み出しで落とす（実行できない手順を runner に渡さない）。

### 送り受けの形

| | 読む | 書く |
| --- | --- | --- |
| 実行（`/api/pages/{id}/steps/**`） | `ownerRecipes`（表） | — |
| 設定の画面（`/api/settings`） | `settingsDto`（手順の名前・お手本・工程の名前と指示だけ） | `mergeRecipes` → `putRecipes`（全部入れ替え） |

設定の画面が送り受けするのは今までと同じ形で、**工程のプロファイル・固有名詞・お手本の文書は送られてこないので表の値をそのまま残す**（それらを変えるのは工程設計の画面）。保存は「効いている手順の全部」を送る形のまま：既定の値をそのまま送れば「既定に戻す」、送らなければその手順は消える。

### 旧 NIHO docs からの取り込み

**未決（オーナー確認待ち）。この PR では実装しない。** 受け皿だけ用意してある。

- `origin = 'import'` と `imported_from`（旧の工程設計の id）を持てる。`imported_from` を持てるのは `origin = 'import'` の行だけ（表の `CHECK`）。
- 取り込みを足すときに要るのは、旧の `Flow` → `RecipeInput` の変換（`guide`・`terms`・`samples`・工程の `profile` はそのまま移せる形にしてある）と、お手本の本文を資産として置く所。表の変更は要らない見込み。

## 3. フォルダ（`pages.kind = 'folder'`）と録音の欄「この録音について」

状態: **設計（オーナー決定 2026-11-06）**。モックは [docs/mockups/editor-folders-v1.html](../mockups/editor-folders-v1.html)。

2026-10-31 の「フォルダ＝子を持てるふつうのページ」をやめる。理由は 3 つ。

1. 利用者にフォルダという物が見えない。空で作れず、作る入口も無く、ページを別のページの行へドラッグする以外に方法が無かった。
2. フォルダの本文が AI の背景情報として暗黙に渡っていた。本人はそれを知らずにメモを書く。
3. 背景・登場人物・固有名詞は「音声を文字にして記事にする」工程の入力であって、入れ物の属性ではない。執筆だけのフォルダには要らない。話者人数・言語が録音ページにあるのと同じ理屈で、録音ページに付く。

### 3.1 決めたこと

| | 2026-11-01 | 2026-11-06 |
| --- | --- | --- |
| フォルダ | 子を持てるふつうのページ。空の状態は持たない | `kind = 'folder'` の行。空で作れる。本文も欄も持たない |
| 背景情報 | フォルダの本文 | 録音ページの `page_fields.background` |
| 登場人物・固有名詞 | 親フォルダの `page_fields` | 録音ページ自身の `page_fields` |
| 工程が読む背景・人物・用語 | 親フォルダから | 録音ページから（`readStepInput`） |
| 文字起こしのヒント | 無し | 録音ページの固有名詞を `terms` として開始に渡す |
| 参考ページ | 同じフォルダの直下のほかのページ | 同じ（変えない） |
| 「新しいページ ▾」 | 空のページ／録音から（音声ファイルからは録音ブロックの中） | 空のページ／録音から／フォルダ。フォルダの中では上に「『◯◯』の中に」 |
| フォルダを開く | ふつうのページのエディタ | 中身の一覧と「新しいページ」「録音から」だけ |
| ヘッダーのパンくず | ページの題名 | 場所（親のフォルダ › 親の録音）だけ。題名は本文の題名にだけ出す |

### 3.2 フォルダの規則

行は `pages` のまま。**木・移動・ゴミ箱・並び・zip 書き出しは今までの実装がそのまま効き、`kind` で意味と画面だけを分ける**（別の表にすると、それらを 2 本持つことになる）。

1. **空で作れる。** 一覧では子が無くてもフォルダのアイコンと開閉で出る。
2. **本文を持たない。** `blocks` は常に空で、保存 API は `folder` の本文を `bad_request` で断る。開くと中身の一覧と「新しいページ」「録音から」。題名はその場で直せる。
3. **できないこと**: 公開・共有リンク・録音ブロック・工程の親（`createRun` は `rec` だけ）・英語版・**フォルダの中のフォルダ**。API はどれも `bad_request`（理由 `folder`）。
4. **親になれるのは本人の、ゴミ箱に入っていない `folder` だけ**（`movePage`。それ以外の親は `not_folder`）。別の人のページ・ゴミ箱の中・無い id はすべて同じ 404（列挙を防ぐ）。録音のサブページは `step_runs` が録音を親に固定して作るので、この規則の外。
5. **段は 3 つのまま**（`MAX_PAGE_DEPTH = 2`）: フォルダ › ページ › 工程のサブページ。`folder` を別の `folder` へ入れる移動は `not_folder` より先に `cycle`／`too_deep` と同じく何も書かずに断る。
6. **作るときに親を指定できる**（`POST /api/pages` の `{ kind?: 'note' | 'rec' | 'folder', parent?: id }`）。`parent` は本人の生きている `folder` だけ。`kind: 'folder'` に `parent` は付けられない。
7. **`parent` を変える所は 1 つ**（`EditorStore.movePage`）。深くなりすぎる移動は `too_deep`、自分自身・子孫の下は `cycle`。どちらも何も書かない。
8. **移動が変えるのは `parent` だけ。** 本文・`revision`・`updated_at` は動かさない。同じ親の中の並びは §4 の規則。
9. **フォルダを削除すると中のページも一緒にゴミ箱へ入り、戻すと親子のまま戻る**。削除の確認は中のページの数を言う。ゴミ箱から完全に消すときは子から先に消し、残った親の子は `parent = NULL` にする（`purgeTrash`）。
10. **既存データ**: 工程のサブページ以外の子を持つ上の段のページは、migration で `kind = 'folder'` にする。その本文は消さないが画面には出さない（旧「背景情報」は、中の録音ページの背景へ人が写す。自動では写さない。消すのは expand → contract の次の配備）。

```
フォルダ（0 の段。kind = 'folder'。本文なし）
└ ページ（1 の段）        ← 記事・メモ・録音ページ
  └ 録音のサブページ（2 の段） ← 手順の成果物（kind = 'step'）
```

### 3.3 録音の欄「この録音について」

- **置き場**: 録音ページの録音ブロックの直下に 1 枚。**録音ブロックがあるページにだけ出る**（執筆だけのページには無い）。畳めて、空のうちは開いた状態、埋まったら「2人 · 日本語 · 登場人物 2 · 固有名詞 3 · 背景あり」の 1 行。
- **中身**: 話者人数・言語（既存。文字起こしの開始の値）、登場人物（`page_fields.entities`）、固有名詞（`page_fields.terms`）、背景（`page_fields.background`。文字。4,000 字まで）。`page_fields` の行はページごとに 1 つで、録音ページ自身の id で持つ（これまで親フォルダの id で持っていた）。
- **使い道**: 固有名詞は文字起こしの開始にヒント（`terms`）として渡す。登場人物・固有名詞・背景は工程の入力（`readStepInput` の `fields`・`background`）に入り、前提（`input_basis.info`）に含まれる。変えると下流が「前提変更」になる。
- **アカウント共通の固有名詞**（`editor_settings.glossary`）は今までどおり足す。混ぜる順は 録音 → 手順 → アカウント共通。
- **文字起こしは「文字起こし」ページのタブ**（§3.6。#310。オーナー決定 2026-11-06）。録音のタブの本文は録音ブロックと「この録音について」、再生、文字起こしの開始、文字起こしのタブの一覧。段落は録音のタブには出ない。
- 文字起こしの前は、録音のタブに「文字起こしをはじめる」（と流れの「文字起こし 作成 ▾」）だけが出る。段階は文字起こしのタブから作る。

### 3.4 ページ › タブ（`kind = 'page'` の入れ物。#307。オーナー決定 2026-11-06、#288）

状態: **データ（migration `20261106234701_pages_tabs`）と画面（#308。migration `20261107003531_pages_tab_name`）**。手順の出力先は §3.5（#309）、文字起こしのタブは §3.6（#310）。モックは [docs/mockups/editor-folder-pages-v1.html](../mockups/editor-folder-pages-v1.html)。

- 本文を持つ行（`note`・`rec`・`article`）はそのまま**タブ**。その上に**入れ物**（`kind = 'page'`。題名・役割 `role`・並び・最後に開いたタブ `last_tab`。本文は持たない）が 1 行。タブは `page` で入れ物を指し、入れ物と**同じフォルダ**（`parent`）に並ぶ（親子にしない: 段の規則と `parent` の使い方は変えない）。
- `createPage` は入れ物と 1 つ目のタブを一緒に作り、**タブの行**を返す。`/p/<id>`・公開・共有・資産・録音・欄・会話はすべてタブの id（既存の id は migration で変わらない）。`kind: 'page'` を直に作ることはできない。
- **題名はページの名前**で、入れ物と全てのタブで同じ（#308。モックの h1）。タブの保存で題名を変えると、`savePage` が入れ物と兄弟のタブへ写す（兄弟の `revision` は進めない）。公開・共有・検索・書き出しが読む `title` はこれまでどおりタブの行にある。まっさらなタブ（`createTab`）の題名は入れ物の題名。
- **タブの名前** `tab_name`（タブだけ。帯の短い札: 下書き・英語版・Gemini など。1〜100 字、無ければ null）。札は `tabLabel`: 付けた名前か、入れ物の中の位置の番号（`tabPos`。`#tabsOf` の並び）。`renameTab` で付ける・外す。複製は「札のコピー」（題名はページの名前のまま）。検索の結果は、入れ物にタブが 2 つ以上あるときだけ札 `tab` を添える（画面は「ページ名 › 札」）。
- 一覧（`listPages`／`listPageChunk`／`listPageChildren`）は既定でタブの行（入れ物は出さない。API の既定も同じ）。`view: 'pages'` で入れ物の行（`tabsCount` つき）、`view: 'all'` で入れ物もタブも（**画面の一覧**はこれを読み、`lib/sidebar-items.ts` が入れ物の行にタブを集める: 行の id は入れ物、`tabs`・`count`。開いているタブを持つ行が今の行）。タブの行の `sortOrder` は入れ物の並び（並べ替えは入れ物に書く。`pageSiblingOrders` は入れ物とそのタブの両方を返す）。`listPageTree`（書き出し）は入れ物を出さない。
- タブの操作: `createTab`（まっさら。本文なし）、複製（`duplicatePage`。同じ入れ物の末尾に `made_from: { kind: 'dup', from }`）、`listTabs`、`reorderTabs`、`moveTab`（別の入れ物へ。空になった入れ物は消す）、`renameTab`、`resolvePage`（タブ → 入れ物と自分、入れ物 → 最後に開いたタブ）、`touchLastTab`。
- 役割 `role`（入れ物だけ）: `{ kind: 'transcript' }`／`{ kind: 'step', recipe, stepId }`。系譜 `made_from`（タブだけ）: 文字起こし・段階・複製の出どころ。手順がこれを使う（#309）。
- ゴミ箱: 入れ物を消すとタブも、最後のタブを消すと入れ物も（同じ `deleted_at`）。戻すと一緒に戻る。`discardEmptyPage` は空のタブを捨て、最後なら入れ物も。完全に消すときは `page` を先に外し（複合キーの `SET NULL` は使わない）、タブを持たない入れ物はついでに消す。
- 入れ物の無い 1 枚だけのページ（移行前の行・入れ物が完全に消えた行・手順のサブページ）はそのまま 1 枚として扱い、タブを足すときに入れ物を作って結ぶ。
- API: `GET /api/pages/{id}/tabs`（`{ page, tab, tabs }`）、`POST …/tabs`（足す。`{ name? }`）、`PATCH …/tabs`（並び）、`PATCH …/tab`（`{ name }` で名前、`{ page }` で移す）、`GET /api/pages?view=all`。`/p/<入れ物の id>` は最後に開いたタブへ redirect（`?side=` は保つ）。
- 画面（#308）: 本文の上にタブの帯（docs-ui `page/TabBar.tsx`、`components/PageTabs.tsx`）。ページ名の上、本文のコンテンツ幅の薄い罫線と右端の ＋（まっさらなタブをすぐ足す）。タブが 2 つ以上なら左に札、開いているタブに ▾（名前を変える・複製・並べて開く・別のページへ移す・削除）。
  本文に手順の帯・ボタンは置かない（手順の操作は「ページ」パネルの「流れ」。§3.5）。一覧は入れ物 1 行（タブの数の印。今の行は網掛けせず太字。録音の 2 行目「録音」は出さない）。フォルダの画面は入れ物 1 行で、タブが 2 つ以上なら 2 行目に札。

```
フォルダ（0 の段。kind = 'folder'）
├ 入れ物 A（kind = 'page'。題名・役割・並び。本文なし）
├ タブ A-1（note／rec／article。page = A）   ← 本文・版・公開・共有
├ タブ A-2（page = A）
├ 入れ物 B …
└ 役割ページ（kind = 'page'。role = { kind: 'step', recipe, stepId }）
  └ タブ（段階の出力。made_from = { kind: 'step', run, input, inputRevision }）
```

### 3.5 流れ（手順の実行の出力先。#309。オーナー決定 2026-11-06、#288）

状態: **データ（migration `20261107021307_step_runs_folder`）・API・画面**。モックは [docs/mockups/editor-folder-pages-v1.html](../mockups/editor-folder-pages-v1.html) の「流れ」。

- **1 フォルダに 1 つの手順**（`pages.recipe`。フォルダだけ。無ければ既定の `tpl-1`。`PATCH /api/pages/{id}/flow { recipe }` で替える）。
- **run の親はフォルダ**（`step_runs.parent`。1 フォルダに進行中の run は 1 つ）。入力は `step_runs.input_tab`（タブ）と `input_revision`。始めの段階は入力のタブの役割で決まる（録音・役割なし → 0、段階 k の入れ物のタブ → k+1）。`createRun(owner, folder, { recipe, inputTab, toStep })`。
- **出力は新しいタブ**: 段階ごとに、フォルダ直下の役割ページ（`role = { kind: 'step', recipe, stepId }` の入れ物。無ければ段階の名前で作る）へタブを 1 つ足す（`kind = 'note'`・題名は入れ物の題名・`step_status`・`made_from = { kind: 'step', run, input, inputRevision }`）。録音の下には何も増えない。決定的な id の `step` サブページ（`stepPageId`）は廃止。migration は、フォルダの中の録音の下にあった `step` サブページを役割ページのタブに動かし、run をフォルダに結ぶ（フォルダの外の録音の run はそのまま）。
- **作り直す（AI）**（段階の出力のタブの ▾・流れの失敗の「作り直す」）＝ `{ regenerate: tabId }`: 同じ入力（`made_from.input`）で同じタブへ書く（直前の本文は版 `ai` に残る）。**同じ入力でもう 1 つ（AI）** ＝ `{ sibling: tabId }`: 同じ入れ物に新しいタブ。▾ はタブが 2 つ以上のときだけ出る（#308）ので、1 つだけのタブは ＋ で足してから。
- 入力の読み方（`readStepInput`）: 入力のタブの系譜（`made_from.input` を最大 8 段）の根が資料（文字起こしのタブなら `page_transcripts.segments` を「[分:秒] 話者: 文」の段落に。移行前の録音のタブは `page_recordings.segments`）、「この録音について」はその根の欄（文字起こしのタブは `made_from.recording` の録音のもの）、参考は同じフォルダの役割の無い入れ物のタブ。前提変更（`refreshStale`）はフォルダの最新 run の出力のタブについて測る。
- **フォルダの外のタブ**で「作成」を押すと、その入れ物の題名でフォルダを作って入れ物ごと入れてから始める（`wrapInFolder`）。
- API（`apps/editor-web/src/server/flow-api.ts`）: `GET /api/pages/{タブ}/flow`（フォルダの id に `?tab=` でも）→ 行・フォルダの手順・候補・最新の run。`POST /api/pages/{タブ}/flow/runs { inputTab, toStep } | { regenerate } | { sibling }`（202。`opened` は開くタブ）。取消・やり直し・途中出力・設計の更新は `…/{フォルダ}/steps/runs/{run}/…` のまま。文字起こしの「作成 ▾」は行の録音へ `POST …/recording/transcribe { engine }`（結果は新しいタブ。§3.6）。
- 画面: docs-ui `page/PageFlow.tsx`（Tauri-free）を「ページ」パネル（`PagePanel.tsx`）に。見出し「<手順名> ▾ · <フォルダ名>」、行は 録音 › 文字起こし › 段階…。あるページは名前と札、無い段階は「（まだ）」。今の行は強調し「◯◯ から」。各行の右端に **作成**／**済み**（今のタブより前の段階と録音には出ない。「済み」は今のタブから系譜で作られたタブがその入れ物にあるとき）。文字起こしの行は役割 transcript の入れ物とそのタブ。録音のタブか文字起こしのタブを開いているときはエンジンのメニュー（その録音で使ったものは済み）。**録音のタブからは段階を作らない**（入力は文字起こしのタブ。AI の工程の選択も同じ）。作成中は回る印。状態の読み込みは `components/FlowWatcher.tsx`（何も描かない。動いている間だけ読み直し、パネル・AI の工程の選択・一覧の行へ渡す）。

### 3.6 文字起こしのタブ（#310。オーナー決定 2026-11-06、#288）

状態: **データ（migration `20261107042444_page_transcripts`）・API・画面**。モックは [docs/mockups/editor-folder-pages-v1.html](../mockups/editor-folder-pages-v1.html) の「文字起こし」。候補（案）と「採用」（#36 段 3b-4・#236。[recording-candidates.md](recording-candidates.md)）は廃止。

- **文字起こしはエンジンごとのタブ**: フォルダ直下の「文字起こし」ページ（`role = { kind: 'transcript' }` の入れ物。1 フォルダに 1 つ、無ければ作る）のタブ（`kind = 'note'`・題名は「文字起こし」・札 `tab_name` はエンジンの名前（同じ札があれば「Gemini 2」）・`made_from = { kind: 'transcript', recording, engine }`）。本文（段落・話者名・長さ）は `page_transcripts`（`page_id` = タブ、`recording_page_id`、`engine`、`language`、`segments`、`speaker_names`、`duration_sec`、`revision`）。直す前の本文は `page_transcript_versions`（`reason`: initial／edit／asr／restore。100 まで）。音声は録音のタブの資産のまま。
- **録音はいつもフォルダの中**（1 フォルダ 1 手順）。フォルダの外の録音で文字起こしを始める・VTT を取り込むと、その入れ物の題名でフォルダを作って入れ物ごと入れる（#309 の `wrapInFolder` と同じ）。
- **開始**（`POST /api/pages/{録音}/recording/transcribe { engine?, lang?, diarize?, terms?, tab? }` → 202 `{ run, tab }`）: 新しいタブを作り、run（`transcription_runs.target_tab`・`base_revision` はタブの revision）の書き先にする。`tab` を添えると、この録音の既存のタブ（失敗した・空のタブ）に書き直す（「もう一度」。別の録音のタブなら 409 `tab_missing`）。`replace`・`has_transcript` は無い（正本を置き換えないので、確認は要らない）。同じ録音で動く run は 1 つ（`existing` はその run と書き先）。確定（`finishRun`）はタブの revision が開始時のままのときだけ書き、直されていた・消えていたら `superseded`。Mac の CLI・端末内も同じ（開始でタブを作り、応答の `tab` に書く）。
- **本文**: `GET /api/pages/{タブ}/transcript` → `{ transcript（revision・recording・engine・engineLabel・language・durationSec・segments・speakerNames）, speakers, run }`（`run` はこのタブに書く最新の実行）。`PATCH …/transcript { baseRevision, edits | renameSpeaker | mergeSpeakers | appendVtt }`（録音の PATCH と同じ本文。409 で最新）。版は `GET …/transcript/versions`・`GET …/versions/{n}`・`POST …/versions/{n}/restore { baseRevision }`。録音の `GET …/recording` は `transcripts`（この録音から作ったタブの一覧: id・label・engine・segmentCount・durationSec…）を返し、`candidates` は無い。
- **VTT の取り込み**（`POST /api/recordings/import-vtt` → 201 `{ page, transcript, recording, speakers }`）: 録音のタブと、段落を入れた文字起こしのタブ（札「取り込んだ字幕」）をフォルダの中に作る。画面は `transcript` のタブを開く。
- **移行**: 録音の正本（`page_recordings.segments`）と案（`page_recording_candidates`）を、フォルダの「文字起こし」ページのタブに写す（案の名前が札。採用中の案が正本を代表する。候補の版は `page_transcript_versions` へ）。フォルダの外の録音は題名のフォルダに包む。`page_recordings.segments`・候補の表は expand の間は残す（contract は後の migration）。移行前の録音の run（`target_tab` が null）は正本に書く。
- **読み手**: 段階の入力（§3.5）・AI チャットの `read_page`／`search_transcript`（文字起こしのタブと、録音のタブはその最新のタブ。`editor-store` の `readTranscriptText`）・Google Docs の書き出し（録音の最新のタブ）・複製（タブの本文も写す）・空のページの片付け。
- **画面**: 録音のタブ（`components/RecordingTranscript.tsx`）は再生・「文字起こしをはじめる」（既定のエンジン。別のエンジンは流れの ▾）・音声を足す・**文字起こしのタブの一覧**（押すと開く）。文字起こしのタブ（`components/TranscriptPage.tsx`。`madeFrom.kind = 'transcript'` のタブ）は元の録音の音声で再生、段落の編集・話者の名前・まとめる（`lib/transcript-client.ts`）、あとの .vtt を足す、版（直す前の本文に戻す）、このタブに書く実行の状態（失敗の「もう一度」は同じタブに同じエンジンで。サーバーで使えるエンジンのときだけ）。始めたら結果を書くタブを開く。

## 4. 一覧の並びと「最近」と書き出し（`20261101013000_folder_order_fields_opens`）

旧 NIHO docs で editor に受け皿が無かった 3 つ（[editor-migration-map.md](editor-migration-map.md) §5）。
オーナー判断（2026-11-01「旧版の機能は全部必要」）で足した。

### 手動の並び（旧 `PageIndex.order`）

- `pages.sort_order`。**小さいほど上。0 は「並べ替えていない」**で、既定のままなら今までと同じ順に出る。
- 同じ値のときの順は **上の段が更新の新しい順、フォルダ・録音の中が作った順**（手順のサブページが段の順に並ぶ）。
  SQL（`orderOf`）と画面（`sidebar-items.ts`）で同じ規則にする。
- 動かすのは `EditorStore.movePageOrder`（上へ・下へ 1 つ）。動かすと**同じ親の全ての行に 1 から振り直す**ので、
  0 のままの行が混ざって並びが決まらなくなることがない。もう端なら `edge`（何も書かない）。
- 画面は `PATCH /api/pages/{id}/order` を送り、届いたら読み込んである行を同じ規則で作り直す（読み直さない）。
  **手動の並びが効くのは読み込んである分**で、続きを読むとその分も並ぶ。

### 「最近」（旧 `recent.json`）

- `page_opens`（owner・page_id・opened_at）。開いた時刻だけを持ち、**回数・端末・滞在時間は持たない**。
- 記録するのは `POST /api/pages/{id}/open`（ページを開いた画面が送る）。ゴミ箱のページは一覧から外し、戻せばまた出る。
- 出すのはサイドバーの木の上の「最近」（10 件。開閉できる）。検索しているあいだは出さない。

### フォルダ単位の書き出し（旧 `folder-export-tree.ts`）

- `GET /api/pages/{id}/export.zip`。フォルダの中のページを木の順に 1 ページ 1 ファイル。ファイル名は題名から作り、同じ名前は `-2`・`-3`。
  **2026-11-06: `背景情報.md` は作らない**（フォルダは本文も欄も持たない）。代わりに録音ページの `.md` の先頭に
  「この録音について」（登場人物・固有名詞・背景）を置く。
- 写真は本文に出てくる資産だけを `photos/{sha256}.{拡張子}` に 1 回ずつ入れ、本文はその相対 path を指す。
  **読めなかった写真は黙って落とさず、その本文から画像の行を出さない**。
- 件数・字数の上限は旧版と同じ定数（docs-core の `FOLDER_EXPORT_MAX_TABS` = 100・`FOLDER_EXPORT_MAX_CHARS` = 100 万字）。
  超えたら 413 で、何も作らない。
- Google ドキュメントへの書き出しは別（この経路は `.md` ＋写真の zip だけ）。選んで書き出す（旧版の `include`）はまだ無い。

### 録音の欄（旧 `project.json` の `info`。2026-11-06 に録音ページへ）

- **背景・登場人物・固有名詞は録音ページの `page_fields`**（owner・page_id ＝ 録音ページ）。`GET・PATCH /api/pages/{id}/fields`
  （`{ entities, terms, background }`）。画面は録音ページの「この録音について」（§3.3）。フォルダに欄は無い。
- 固有名詞は 3 か所にある: アカウント共通（`editor_settings.glossary`）・手順ごと（`recipes.terms`）・この録音
  （`page_fields.terms`）。どれを AI へ渡すかは渡す側が決める。
- 話者人数・言語（docs-core の `recording-fields.ts`）は文字起こしの開始の値で、同じ欄に並べて出す。
  同じフォルダの文書を参考にする（自動参考ページ）には `GET /api/pages/{id}/children` を使う。

### 旧 NIHO docs のフォルダの取り込み

**未決（オーナー確認待ち）。** 旧のフォルダは、取り込みのときに `kind = 'folder'` の行へ 1 対 1 で対応づけられる。旧「背景情報」・登場人物・固有名詞は、その中の root の録音ページの `page_fields` へ写す（2026-11-06 の形）。対応づけの表は要らず、必要になれば `pages` に受け皿の列（旧の id）を 1 つ足すだけで足りる見込み。

## 5. 画面（2026-11-06 の形。モック `docs/mockups/editor-folders-v1.html`）

- サイドバーは 1 本の木（`ShellSidebar` の `items` が段と開閉を持つ）。**フォルダは `kind` で決まり、子が無くてもフォルダのアイコンと開閉で出る。** 録音の行は録音のアイコン、工程のサブページは小さな ✦。
- 「新しいページ ▾」は 空のページ（⌘N）／録音から／フォルダ。開いているページがフォルダの中なら上に「『◯◯』の中に」が付き、その中に作る。「フォルダ」は入れ子にしないので常に上の段にできる（それを言葉では書かない）。
- フォルダへ入れる・出す・並べ替えは行のドラッグ。キーボードとスマホの代替は「…」の「移動…」（入れ先はフォルダと「フォルダの外」）。
- フォルダを開くと、題名（その場で直せる）・「新しいページ」「録音から」・中身の一覧。公開・挿入の道具・AI は出ない。「…」は「書き出し（.zip）」「削除」だけ。
- 録音ページには録音ブロックの直下に「この録音について」（§3.3）。本文は見出し「文字起こし」の下。
- ヘッダーの左は場所（親のフォルダ › 親の録音）だけ。押すとその場所へ。上の段のページでは何も出ない。スマホはヘッダーに幅が無いので、題名の上の 1 行に出す。
- AI の欄の入力の上に「読むもの」（このページ・この録音について・同じフォルダの N ページ）を小さな札で出す。
- 左下は「設定」の直リンク。状態の丸は公開中だけ出す。「最近」は出さない（オーナー判断 2026-11-03）。
