# editor の本番反映の境界（起点はこのリポジトリ側・鍵は GitHub に置かない）

オーナー決定 2026-11-06。台帳は [#286](https://github.com/niho-life/niho-editor/issues/286)。対象は `editor.niho.life`（`apps/editor-web`）と Mac アプリ NIHO editor（`apps/docs`）の本番反映。旧 Docs（`niho.life/app/docs`）の境界は [release-boundary.md](release-boundary.md)（2026-10-19）で、そちらは非公開側に起点を置く別の判断。

## 1. 原則

1. **本番反映の起点はこのリポジトリ側。** Web の配備も Mac の署名・公開もここから始める。`niho-app` に残すのは NIHO の本人確認と API の契約（§5）、既存の `/developer` download導線だけ。
2. **鍵と配備の権限を GitHub に置かない。** Secrets・Environments・OIDC のどれにも、更新の署名鍵・gcloud の権限・本番の接続情報を置かない。配備と署名はオーナーの手元で、オーナーの Mac にある鍵と gcloud ログインで行う。
3. **承認・レビューのプロセスは入れない。** 必須レビューも CODEOWNERS の承認も置かない。マージできるのはオーナーのアカウント（write と admin はすべてオーナー）だけ。2 が承認の代わり: main に入った workflow が何をしても、持ち出せる鍵が無い。
4. **公開 CI は無料のまま、本番を守る検査はすべて必須チェック。** GitHub-hosted runner・secret なし・合成データ。`merge_group` で走る job は必須チェックに入れる（走るのに必須でない job は、赤でもマージされるので意味が無い）。
5. **`niho-app` の Actions を editor のために使わない。** `niho-app` は非公開で Actions が有料。editor の build・検証・配布を `niho-app` の workflow で行わない。

このリポジトリは公開だが、LICENSE は複製不可のまま（2026-11-06 時点）。公開は無料の CI のためで、コードの再利用を許す意図ではない。

## 2. 何がどこで動くか

| 領域 | 公開 CI（このリポジトリ・無料・secret なし） | オーナーの手元 | `niho-app`（非公開） |
| --- | --- | --- | --- |
| Web `editor.niho.life` | 型検査・テスト・build・image の build（[editor-web-ci.yml](../../.github/workflows/editor-web-ci.yml)） | `scripts/editor-deploy/deploy.sh`（Cloud Build → migrate ジョブ → Cloud Run → smoke。[editor-deploy.md](../ops/editor-deploy.md) §4・§7） | 本人確認の API（connect / session / refresh）・記事の authority・Google Docs の gateway |
| Mac アプリ NIHO editor | 鍵なしの候補 build・別 Mac での DATA 検証・prerelease と実行証明（[editor-mac-candidate.yml](../../.github/workflows/editor-mac-candidate.yml)。オーナーが `workflow_dispatch`。[editor-mac-candidate.md](../ops/editor-mac-candidate.md)） | 候補の検証・再確認・minisign 署名・draft Releaseへの成果物公開と検証（`scripts/editor-candidate/`。§4） | 認証 API・`/developer` の導線のみ。Mac updater feed と Editor 配布の Actions は使わない |
| 共有の `packages/` | 単体テスト（Client packages CI） | — | 旧 Docs の退役まで、固定 SHA の SDK 取り込み（[docs-sdk.md](docs-sdk.md)） |

## 3. 守り（承認の代わりに何があるか）

### 鍵の不在

- 更新の署名鍵（minisign。`~/.niho/docs-updater.key`。[apps/docs/README.md](../../apps/docs/README.md)「配布」）は Mac Studio だけにある。**作り直さない**（配った版が以後の更新を受け取れなくなる）。
- Web の配備は `deploy.env`（`.gitignore` 済み）と、オーナーの gcloud ログインで行う。Workload Identity Federation は作らない。
- 鍵・token・本番の接続情報は Secret Manager とオーナーの Mac にだけある。GitHub の Secrets にあるのは公開してよいクライアント設定（`NIHO_DESKTOP_FIREBASE_API_KEY_PROD`）だけ。

### main の branch protection（classic）

- 必須チェック: `merge_group` で走る job（matrix 名の job を除く）。2026-11-06 時点の一覧は #286 の「設定」。正は設定そのもので、`ghN api repos/niho-life/niho-editor/branches/main/protection --jq .required_status_checks.contexts` で読む。
- 未解決のレビュースレッド 0（conversation resolution）。レビューは任意で、スレッドが付いたら解決してから入れる。
- admin も例外なし（`enforce_admins`）。force push・削除は不可。
- マージキュー（squash）。auto-merge は無効。
- 必須レビュー 0・CODEOWNERS の承認なし。これは意図（§1 の 3）。

必須チェックにする job は、workflow の `paths` で止めない。workflow ごと走らないと check が pending のままになり、PR を queue に入れられない。`changes` job で変更を見分け、jobs の `if` で skip する（skip は成功と数える）。

長い job は並列の job に分けてよいが、必須チェックの名前は増やさない。分けた job は、同じ名前の**集約 job**（`needs` で 3 つを待ち、全部 `success` のときだけ成功。`!cancelled()` で、どれかが赤でも必ず走って赤にする）が 1 つの check として報告する（`editor-web` ＝ `editor-web-check` / `editor-web-build` / `editor-web-e2e`。Issue #292）。

### 公開リポジトリの設定

- fork からの PR の workflow は、外部の contributor 全員について承認が要る（`approval_policy: all_external_contributors`）。承認しなければ走らない。
- `GITHUB_TOKEN` の既定は read。`pull_request_target` は使わない。
- actions は commit SHA で固定する（`uses: owner/action@<sha> # vN`）。
- secret scanning と push protection は有効。
- fork からの PR はマージできず、secret も受けず、workflow も走らない。置かれるだけで害が無いので、Interaction limits（期限付きで恒久化できない）は使わない。

### アカウント

- write を持つのはオーナーのアカウントだけ。外部の collaborator を増やさない。
- org は 2FA 必須。token は fine-grained PAT で、要る権限だけ。
- AI セッションはオーナーのアカウントで動くので、「オーナーのみ」には AI セッションも含まれる。コードの誤りはレビューではなく、必須チェック（§3）と手元の最後の確認（§4）で止める。

### 守れないもの

- オーナーのアカウントか token が盗まれれば main に入れられる。鍵が GitHub に無いので、その場合も配布と配備には届かない。配備は次にオーナーが手元で `deploy.sh` や署名スクリプトを実行したときに起きるので、その前に main を見る。
- 公開 CI の結果は、workflow が改ざんされていれば信用できない。だから手元の署名スクリプトは CI の結果を鵜呑みにせず、候補の中身を手元で再確認する（§4）。

## 4. Mac アプリの流れ

```
オーナー: workflow_dispatch（source SHA・版）
  → 公開 CI: 鍵なし候補 build → 別 Mac で DATA 検証 → prerelease editor-candidate-v<版>-… ＋ 実行証明（sigstore）
オーナーの手元: scripts/editor-candidate/ の署名・公開スクリプト
  1. 候補 prerelease の asset を取得（dmg・.app.tar.gz・manifest・receipt・sigstore）
  2. 実行証明を確かめる（gh attestation verify）。manifest / receipt / file hash を照合（candidate.py validate）
  3. 候補の中身を手元で再確認（bundle identifier・版・codesign。中の binary は実行しない）
  4. 配布済みの版より大きいことを確かめる（公開 latest.json・公開済みの docs-v* の tag）
  5. ~/.niho/docs-updater.key で .app.tar.gz に minisign 署名 → updater-key.mjs verify で tauri.conf.json の公開鍵との組を確かめる
  6. latest.json を含む全 asset を draft Release docs-v<版>-<sha12> に上げ、asset 一覧を検証してから公開
  7. latest alias と updater feed を読み戻し、署名済み archive と manifest の一致を確かめる
各 Mac: GitHub latest.json → 新しい版を取得 → 公開鍵で署名を確かめる → 終了時に差し替え
```

- 更新 feed は `https://github.com/niho-life/niho-editor/releases/latest/download/latest.json`。Tauri が読む `darwin-aarch64`・署名文字列・tag固定のarchive URLを同じ公開 Release に置く。Release はdraftで完成させてから公開し、公開途中のasset集合を updater に見せない。
- 既存アプリには旧 `https://niho.life/docs/updater/latest.json` が焼き込まれている。配布先ごとに最初の1回だけ、新しい公開 Release のdmgを手動で入れ直す。以降はアプリの「更新して再起動」で直接更新できる。初回公開だけはまだdirect feedがないため、Studioで `NIHO_DOCS_SKIP_FEED=1` を明示する。次のリリースからfeedの版も必ず検査する。
- 初回入れ替え用dmgはこのrepoの公開 Releaseから直接取得できる。`niho-app` のPR・Actions・`/docs/updater/latest.json` proxyはアプリ更新に使わない。NIHO `/developer` のdownload導線を更新する作業は別途必要だが、更新配布のたびの依存ではない。
- 候補は ad-hoc 署名済み（`tauri.conf.json` の `signingIdentity: "-"`）。手元で codesign し直さない。手元の署名は minisign だけなので、Xcode は要らない。
- Developer ID 署名と公証（2027 年予定）も、資格はオーナーの Mac に置き、同じスクリプトの中で行う。

## 5. `niho-app` との契約

自動更新とアプリ公開はこのrepoで完結する。`niho-app` とのAPI契約は版で固定し、editor側の機能追加でPRが要らないようにする。既存の `/developer` download導線は残るが、更新feedには使わない。feature flag と callback URL は `niho-app` の env なのでPR不要。

| 契約 | 何のため | editor 側の設定 |
| --- | --- | --- |
| 本人確認（`/connect/niho-editor` の開始・session・refresh） | NIHO アカウントでのログイン（[editor-deploy.md](../ops/editor-deploy.md) §5・§13） | `EDITOR_AUTH_MODE=niho`・`EDITOR_NIHO_ORIGIN` |
| 記事の authority | Experience への記事の連携 | `EDITOR_EXPERIENCE_*`・`EDITOR_ARTICLE_AUTHORITY_*` |
| Google Docs の gateway | Google ドキュメントへの書き出し（[editor-google-docs-export.md](editor-google-docs-export.md)） | `GOOGLE_DOCS_MODE`・`EDITOR_NIHO_API_ORIGIN` |

新しい契約が要るときは、editor 側の機能を先に作って入口を閉じたまま出し、`niho-app` の変更はまとめて 1 回にする。旧 Docs（`niho.life/app/docs`）の退役（niho-coliving/niho-app#19125 / #19761）が済めば、`packages/` の SDK 取り込み PR も無くなり、`niho-app` に editor の UI コードは残らない。

## 6. 移行の順番

1. この文書・`editor-web-ci.yml` の `merge_group`・AGENTS.md の修正（PR1）。
2. 必須チェックに `editor-store` / `editor-web` / `editor-deploy` / `editor-auth-acceptance` ほか `merge_group` で走る job を追加（設定。PR1 のマージ後）。
3. 手元の署名・公開スクリプト（PR2）。[editor-mac-candidate.md](../ops/editor-mac-candidate.md) と [apps/docs/README.md](../../apps/docs/README.md)「配布」を新しい流れに。
4. オーナーが候補 1 版を署名し、公開 Release に置く。
5. 各Macで初回だけ公開Releaseのdmgを手動入れ替え。以降の更新は本repoの公開Release feedから取得する。
6. `niho-app` の `/developer` download導線と旧 `docs-release.yml` は移行時に別途整理できるが、Editorの更新配布を止める依存にはしない。
7. Developer ID 署名と公証。

## 7. やらないこと

- 鍵を GitHub Environment に置く（main 限定・承認必須にしても、main に入った workflow が読める）。
- CODEOWNERS や必須レビュー。
- Interaction limits。
- `niho-app` の workflow で editor を build・検証・配布する。
- このリポジトリの public CI から本番（Cloud Run・Release の署名）へ到達する経路。
