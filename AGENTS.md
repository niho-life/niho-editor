# NIHO editor 作業ルール

`editor.niho.life`（`apps/editor-web`）と Mac アプリ（`apps/docs`）、共有の `packages/` を扱うときの決まり。設計は [`docs/architecture/editor-niho-life-design.md`](docs/architecture/editor-niho-life-design.md)、配備は [`docs/ops/editor-deploy.md`](docs/ops/editor-deploy.md)、本番反映の境界（起点・鍵・守り）は [`docs/architecture/editor-release-boundary.md`](docs/architecture/editor-release-boundary.md)。

## 言語

オーナー向けの報告、Issue、PR、docs は日本語。識別子・ログ・コードは英語のまま。

## マージ

- `main` へは PR だけ。守りは main の branch protection: 必須チェック・未解決スレッド 0・admin も例外なし・マージキュー。**必須レビューと CODEOWNERS の承認は置かない**（オーナー決定 2026-11-06。鍵と配備の権限を GitHub に置かないことが承認の代わり。[`docs/architecture/editor-release-boundary.md`](docs/architecture/editor-release-boundary.md) §3）。必須チェックの一覧は `ghN api repos/niho-life/niho-editor/branches/main/protection --jq .required_status_checks.contexts` で読む。
- 必須チェックにする job は、workflow の `paths` で止めない（workflow ごと走らないと pending のままで queue に入れない）。`changes` job で変更を見分け、jobs の `if` で skip する（skip は成功と数える。`docs-core-ci.yml`・`editor-web-ci.yml` の形）。
- **セッションは次の 3 つが揃ったときだけ、自分の PR をマージキューへ入れてよい**（オーナー決定 2026-11-01）。
  1. 全チェックが緑（失敗 0・保留 0）
  2. 未解決のレビュースレッドが 0
  3. **自分で差分を見直した**
- 3 を飛ばさない。実際に、マージ前の自己確認で設計の誤り（#129）や本文が消える欠陥（#109）が見つかっている。
- このリポは**マージキュー**方式で、`ghN pr merge <PR> --auto --squash` は `Auto merge is not allowed for this repository` と断られる（auto-merge は無効）。キューへは GraphQL で入れる。マージの仕方（squash）はキューの設定が決める。

  ```sh
  id=$(ghN pr view <PR> --repo niho-life/niho-editor --json id --jq .id)
  ghN api graphql -f query='mutation($id:ID!){enqueuePullRequest(input:{pullRequestId:$id}){mergeQueueEntry{position}}}' -F id="$id"
  ```

  入れたら `ghN pr view <PR> --repo niho-life/niho-editor --json state,mergedAt` で結果を確かめる（キューが赤で弾き返すことがある）。待つ間は 1 分に 1 回まで。
- CI のトリガーに `paths` / `paths-ignore` を足さない。

## migration

- **名前を自分で決めない。** `npm -C packages/editor-store run new-migration -- <名前>` が `YYYYMMDDHHMMSS_<名前>.sql` を作る。連番を人が選ぶと並行作業で取り合いになる（実際に #90 と #93 が 0008、#100 と #93 が 0009 で衝突した）。
- **既にある連番（`0001`〜）は名前を変えない。** 適用済みの名前が `editor_store_migrations` の主キーで、変えると未適用に見えるうえ checksum も合わなくなる。
- expand → contract。列の削除は、引き継ぎが要らなくなる配備の 1 つ後の別の migration にする。

## 鍵と秘密

- 鍵・token は Secret Manager に置き、画面の実行 ID だけが読む。**入れるのはオーナーだけ**（`scripts/editor-deploy/set-*-key.sh` が標準入力から読む。引数では受け付けない）。**AI エージェントは鍵を扱わない。**
- 鍵・token・プロンプト・本文を、ログ・エラーの本文・DB の平文・画面・Issue・PR に出さない。ログは失敗の種類と HTTP ステータスだけ。
- このリポジトリは公開。**本番のプロジェクト ID・プロジェクト番号・バケット名・URL・メールアドレスを書かない。** それらは `scripts/editor-deploy/deploy.env`（`.gitignore` 済み）に置く。
- 実データ・顧客の非公開情報・秘密鍵・DB 接続情報をコミットしない。fixture は合成データだけ。

## 認証

- 本番は fail-closed。`EDITOR_AUTH_MODE` が許す値以外（未設定を含む）なら、port を開く前に起動を止める。
- **`stub` は開発と CI だけ。本番で通せるようにしない。** 認証なしの固定ユーザーで、`editor.niho.life` は誰でも到達できる（`noindex` はアクセス制御ではない）。

## 並行作業と worktree

- 同じファイルを 2 つのレーンが書かない。**触らない範囲を PR 本文に書く。**
- 既存の `niho-editor-N` seat を使い、新しい seat / clone は owner が明示した場合だけ作る。`scripts/seat.sh status` で確認し、clean な topic branch がある seat も再利用できる。`scripts/seat.sh start <branch>` は最新 `origin/main` から新しい branch を作り、前の branch ref を残す。未コミット差分と detached HEAD の unreferenced commit は保護する。詳細は [座席と topic branch の運用](docs/panes/panes-workflow.md)。
- 番号付きの `niho-docs-N` を勝手に増やさない。worktree を作ったら、**終わったら片付ける**（`git worktree remove --force` と `git worktree prune`）。容量不足でセッションが起動できなくなる。
- **`git stash` を使わない。** stash は全 worktree で共有で、他のセッションの変更を pop してしまう。退避は WIP commit で。
- 共有のチェックアウトで作業するときは、**commit の直前に `git branch --show-current` を確かめる**。push は ref を明示（`git push origin <branch>:<branch>`）。

## 画面と共有パッケージ

- 画面は 1 回だけ作る。工程設計・AI チャット・録音の画面は Web 側（`apps/editor-web` と `packages/docs-ui`）に作り、Mac 用の画面は作らない。Mac は同じ UI を同じサーバー相手に描く殻＋端末の力（オーナー決定 2026-10-31）。
- **`packages/docs-ui` は Tauri-free**（`src/isolation.test.ts` が強制）。Mac だけの処理を入れない。
- 色は `packages/ui/src/styles/tokens.css` の token から引く。生の hex を増やさない。主ボタンは緑のグラデーションで面と文字をセット（`docs/design/color-style-guide.md`）。状態を色だけで表さない。
- 320px で横スクロールなし、axe の serious 以上ゼロ、文字は 12px 以上。
