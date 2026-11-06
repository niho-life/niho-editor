# NIHO docs の公開開発と本番配布の境界

2026-10-19 時点の運用判断。非公開側の作業台帳は [niho-app #19125](https://github.com/niho-coliving/niho-app/issues/19125)。

本文書は旧 Docs（`niho.life/app/docs`。非公開側の Web・API・DB を使う）の境界。`editor.niho.life` と Mac アプリ NIHO editor の本番反映は、起点をこのリポジトリ側に置く別の判断になった（オーナー決定 2026-11-06）: [editor-release-boundary.md](editor-release-boundary.md)。

## 現在地

- この公開リポジトリは Docs の Mac アプリ、共有 UI・Core・端末保存クライアントの開発と、秘密値を使わない CI を担当する。
- 本番の `niho.life/app/docs` は、非公開 `niho-app` の Next.js Web ホスト、API、認証・認可、DB を使う。Mac の updater も現時点では非公開側の `docs-release.yml` が作る。公開 `main` のマージだけでは本番は更新されない。
- `niho-app` は Docs Core/UI をリポジトリ内の `file:` 依存で読むが、公開 `main` の commit SHA とファイル hash を固定して取り込み・検証する仕組みで管理する。クライアントの修正 PR は公開側で作り、非公開側のコピーを直接編集しない。両リポで同じクライアントを編集し続ける運用は採らない（2026-10-22 更新）。
- `VITE_NIHO_DOCS_LOCAL_FOLDER_EXPORT`、`VITE_NIHO_DOCS_CLOUD_CLOSING`、`VITE_NIHO_DOCS_DEVICE_DELIVERY` の入口は、対応する非公開 API の配備・受入まで既定 OFF。自動参考のクライアントは API 側の受付・固定入力契約と同時に統合する。

## 採用する接続

1. **公開版を正本にする。** Docs のクライアント変更はここでレビューし、標準 GitHub-hosted runner で型検査・テスト・署名不要のビルドを完了する。Web の Next.js ホストと API/DB は非公開側で開発する。Web と Mac で共有できる純粋な UI/ロジックだけをここに置く。
2. **非公開側へ一方向に取り込む。** 統合 PR はレビュー済みの公開 `main` の変更不能な commit SHA を記録し、対応するソースの hash を検証して取り込む。オーナーの2026-10-22方針に従い、Web/APIの共通コードは[固定版SDK](docs-sdk.md)で接続する。初回SDKの公開・統合受入までは既存の `file:` 依存と配布 workflow を保ち、Macの署名に必要なnative source snapshotも移行完了まで維持する。手作業で同じソースを両方修正しない。
3. **統合時だけ非公開の契約を確認する。** 公開 CI を通った版に対し、非公開 API/Web の型・契約テスト、必要な Mac ビルドと実アプリ受入を行う。公開 CI と同じ Docs 単体/ネイティブ検査をすべての機能 PR で重複実行しない。公開版を取り込む統合 PR の検査は残す。
4. **本番への起点は非公開側に保つ。** API/DB と Web は `niho-app` の `v*` release tag から既存の production Environment / Cloud Run workflow で配備する。現行の API と Web の workflow は同じ tag でそれぞれ起動するため、到着順に依存する機能は入口を OFF に保ち、両方の配備・受入後に有効化する。Mac は非公開の `docs-release.yml` で updater 署名鍵・配布権限を使い、`docs-v*` と updater feed を発行する。公開 CI に本番秘密値、署名鍵、Cloud Run 権限を置かない。公開リポからの push で本番配備を直接起動しない。

## 配備順と証跡

| 順番 | 実施すること | 通過条件 |
| --- | --- | --- |
| 1 | 固定した公開 SHA を非公開の統合 PR に取り込み、API/Web を後方互換で検証 | private SHA と public SHA、migration・API 契約・権限・予算制御・Web 型検査を記録 |
| 2 | stg の API/Web と実アプリで受入 | 新旧クライアント、保存先、失敗時の挙動を確認 |
| 3 | 非公開 `v*` の本番 API と Web 配備を確認 | 両方の Cloud Run revision が期待 SHA を提供し、旧クライアントが継続利用できる |
| 4 | 本番の接続を受入し、必要な入口だけ有効化 | 対象 API の受入・監視と機能ゲートを確認 |
| 5 | 同じ固定版で Mac を配布 | `docs-v*`、updater 署名・公開成果物、updater feed と実機更新を確認 |

失敗時は入口を OFF にし、前に検証済みの **private SHA + public SHA** の組を基準に戻す。DB の変更は旧クライアントとの互換期間を設ける。Mac の updater には必要に応じて上位版番号の修正版を配る。

## 費用と複雑さの判定

[GitHub の課金仕様](https://docs.github.com/en/billing/concepts/product-billing/github-actions)では標準 GitHub-hosted runner は公開リポジトリで無料だが、大型 runner・Actions の保存領域・非公開統合 CI と updater の配布は別に扱う。節約額は公開化だけで発生せず、非公開で重複するジョブを実際に減らして確認する。計測の正は [niho-app #19053](https://github.com/niho-coliving/niho-app/issues/19053)。

この分割を維持する条件は、機能ごとに公開 PR を完結でき、非公開側の変更が API/Web 固有差分またはまとめた固定版取り込みに限られること。毎回両リポで同じソースを手修正する、公開版との差が追えない、統合 PR の待ちが開発を遅らせる、Actions 実行量が減らない場合は、切り出し範囲を縮めるか self-hosted/CI 最適化へ戻す。Web アプリ全体の第三リポへの分離は、現時点では選ばない。

公開 PR と fork の CI は読み取り専用 token と秘密値なしで動かす。[GitHub が警告する](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)特権 `pull_request_target` で未信頼コードを実行しない。公開 SHA のレビュー、固定・hash 検証、非公開側の契約検査と配布権限の分離を、リポジトリ境界の条件とする。
