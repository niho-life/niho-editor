# NIHO docs

NIHO Docs の公開クライアントコードと、NIHO Photo と共有するクラウド contract を管理します。クライアント、共通 UI / Core、ローカル保存とクラウド共有 client contract は原則公開し、認証・認可の最終権限、実データ、API / DB / storage 実装、運用秘密は非公開側に置きます。公式サービスの利用には NIHO ログインが必要です。

既存 seat の再利用と topic branch の準備は [Pane 作業フロー](docs/panes/panes-workflow.md) を参照してください。

## 公開境界と利用条件

公開は自由な再利用の許諾を意味しません。NIHO 保有コード・素材は all rights reserved です。GitHub 上の閲覧・fork と第三者資産・依存ライブラリには各適用条件があります。詳細は [`LICENSE`](LICENSE)、[`ASSET_LICENSE.md`](ASSET_LICENSE.md)、[`TRADEMARKS.md`](TRADEMARKS.md)、[`CONTRIBUTING.md`](CONTRIBUTING.md) を参照してください。

公開側と非公開側の境界、CI、脆弱性報告は [`docs/security/publication-gates.md`](docs/security/publication-gates.md) に記録しています。Docs / Photo が共有するクラウド contract は [`packages/niho-cloud-contract`](packages/niho-cloud-contract/) が versioned SSOT です。

公開開発から非公開の本番配布までの現在地と接続方針は [`docs/architecture/release-boundary.md`](docs/architecture/release-boundary.md) に記録しています。 このリポジトリを `editor.niho.life`（ページを書く工房）へ再編する方針は [`docs/architecture/editor-niho-life.md`](docs/architecture/editor-niho-life.md) にあります（Epic [#30](https://github.com/niho-life/niho-editor/issues/30)、詳細設計 [`docs/architecture/editor-niho-life-design.md`](docs/architecture/editor-niho-life-design.md)）。公開 `main` の更新だけでは公式サービスは更新されません。security vulnerability の詳細は public issue に書かず [`SECURITY.md`](SECURITY.md) の手順を使ってください。

## 現在の抽出範囲

- `packages/docs-core`: Docs の純粋な型・文書規則・会話・実行状態のロジック。
- `packages/docs-ui`: Mac・Web/PWA 共通の Docs 画面とホスト接続契約。
- `packages/ui`: Docs / Photo / Web で共通の画面部品。
- `packages/desktop-account`: 既存の NIHO 接続 API を使う Mac 側の PKCE・token 更新・状態の実装。ログイン判定を行う API / DB はこのリポジトリに含めない。
- `packages/desktop-vault`: Docs の端末内保存と本人保管庫との同期クライアント。本人・所有権の判定は API 側で行う。
- `packages/niho-cloud-contract`: Docs / Photo 共通の versioned cloud API 型と security test vector。private API の認証・認可実装は含めない。
- `apps/docs`: NIHO docs の Mac アプリ本体。API・DB・アカウント発行側は含めず、署名・配布 workflow はこの段階では有効化しない。
- `packages/apple-speech`: Mac の音声文字起こしに使う共有 Swift 実装。
- `packages/article-style-sample-core`: Mac と非公開 API が参照する、ネットワーク取得を含まない記事お手本の抽出ロジック。API 側の参照切り替えは統合 PR で行う。
- `apps/docs/fixtures`: Docs Core と将来の Mac 実装が共有する合成テストデータの一部。

`packages/docs-core` のテストのうち、NIHO の非公開仕様書・デザインガイドを直接読む 3 ファイルは元リポジトリに残しています。公開側の単体テストと、元リポジトリ側の仕様整合テストを両方通してから依存を切り替えます。

`packages/desktop-account` のテストのうち、非公開サーバーの登録表をソースとして読む 2 件も元リポジトリに残しています。公開側の端末テストに加え、元リポジトリ側の契約照合を依存切り替え時に維持します。

## LOCAL フォルダの Google ドキュメント書き出し

Mac のクライアント実装は公開側で検証します。既存の CLOUD 書き出し形式も読み取れます。`この Mac だけ` の書き出し入口は既定で非表示です。非公開 API の `/me/docs-drive/folder-exports/plan-local` とアップロード受付を配備・受入したビルドだけ、`VITE_NIHO_DOCS_LOCAL_FOLDER_EXPORT=true` を指定して有効にします。選んだファイルは一時的に NIHO API の管理する保存先へ送ります。

CLOUD から `この Mac だけ` への切り替え入口も、非公開 API の事前確認・全件受信・確定を配備・受入したビルドに限り `VITE_NIHO_DOCS_CLOUD_CLOSING=true` で有効にします。すでに移行中のアカウントを再開する操作は、入口の設定に関係なく表示します。

LOCAL の後続工程を NIHO API に一時配送する入口は、非公開 API の端末配送受付・結果受領を配備・受入したビルドに限り `VITE_NIHO_DOCS_DEVICE_DELIVERY=true` で有効にします。無効のビルドは従来の実行経路を使います。

```sh
npm -C packages/docs-core ci
npm -C packages/docs-core run check
npm -C packages/ui ci
npm -C packages/ui run typecheck
npm -C packages/ui run lint
npm -C packages/ui test
npm -C packages/docs-ui ci
npm -C packages/docs-ui run typecheck
npm -C packages/docs-ui run lint
npm -C packages/docs-ui test
cargo test --manifest-path packages/desktop-account/Cargo.toml --locked
npm -C packages/desktop-account/ts ci
npm -C packages/desktop-account/ts run typecheck
npm -C packages/desktop-account/ts run lint
npm -C packages/desktop-account/ts test
cargo test --manifest-path packages/desktop-vault/Cargo.toml --locked
npm -C apps/docs ci
npm -C apps/docs run typecheck
npm -C apps/docs test
npm -C apps/docs run build
cargo test --manifest-path apps/docs/Cargo.toml --locked --workspace
swift test --package-path apps/docs/sidecar/niho-speech
swift test --package-path packages/apple-speech
```
