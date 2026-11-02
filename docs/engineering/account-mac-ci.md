# Account Mac CI

`Account Mac CI` は `packages/desktop-account` の公開リポジトリ側Mac検査である。標準のGitHub-hosted `macos-26` ARM64 runnerだけを使い、10月15日の公式stable patchであるRust `1.99.1`を `Setup Rust` で固定して `Format`、`Clippy`、`Test (core)`、`Test (all features)`、`Permissions are committed` を実行する。Keychainの `#[ignore]` テストは解除しない。

Mac jobはaccount Rust・lock・permissions・未知ファイル、Cargo祖先のnative override、およびworkflow/scope helper自身の変更を対象にする。accountの `ts/`、README、Docs UIだけの変更は負例としてMacを省略できる。この閉包はaccountの `Cargo.toml` にlocal path依存がないことを前提とし、追加時はscopeを先に更新する。PRは実merge commitの第一親との差、pushは検証済みbefore/after、merge queueは検証済みbase/headを比較する。比較不能、未知イベント、不整合、空比較では省略せずMacを実行し、`workflow_dispatch` もmainから必ず実行する。

これは公開sourceのpure testであり、server認可、実Keychain受入、product releaseの証明ではない。次段のprivate consumerは、固定した公開repository・workflow・source SHAに対するrun IDとrun attemptをGitHub上の結果で照合すること。Issue本文やPR本文の自己申告だけで検査を省略してはならない。
