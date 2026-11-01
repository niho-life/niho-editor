# Photo cloud SDK immutable release

## 目的と境界

Mac が本人用写真 library の contract と cloud adapter を source tree から手コピーせず、同じ Git commit から生成した immutable release として採用するための配布経路である。配布版は `photo-cloud-sdk-v0.1.1`。実認証、実 API、画面、利用可能表示、配備は含めない。

既存 Docs SDK の `sdk/release-set.json` と workflow は独立している。Photo cloud SDK は `sdk/photo-cloud-release-set.json`、`scripts/photo-cloud-sdk/`、専用 workflow だけを使う。

## 配布 package

- `@niho/photo-cloud-library` 0.1.1: `package.json`、`README.md`、`src/**` のみを選択する。
- `@niho/photo-library-contract` 0.1.1: 上記に `sdk-baseline.json` を加える。公開 export は `.` と `./sdk-baseline` だけで、fixture は配布しない。

pack staging で `private`、script、開発用 dependency を除き、必要な外部 import だけを exact peer にする。package 間 peer は 0.1.1、Photo SDK peer は検証済み baseline の 0.1.5 に固定する。両 package は TS source 配布であり、consumer が TypeScript 6 / Node 24 の解決規則で読む。

各 tarball には repository の公開 `LICENSE` と専用 `PHOTO_CLOUD_THIRD_PARTY_NOTICES.md` を同梱する。native code、Next、Tauri、Firebase、秘密、fixture、test、設定、CI は含めない。

## 再現性と検証

pack は40桁 commit SHAを受け、通常 file の Git blob だけを読む。symlink、特殊 file、安全でない path、allowlist 外 source、閉じていない相対 import、未宣言の外部 import を拒否する。実行中の pack/verifier/config/lock と選択 commit が一致しない場合も拒否する。

manifest は commit/tree、選択 source file 集合、実行 tooling、upstream Photo SDK baseline、変換後の全 tar entry、tarball の size/SHA-256/SRI を固定する。tarはpath、mode、uid/gid、mtimeを固定する。gzipは固定headerと非圧縮DEFLATE blockを使い、OSやzlib版によって配布bytesが変わらないようにする。verifier は tarball を独立に読み、manifest と entry 集合・size・hash・package contract を照合する。独立再生成 manifest が指定された場合は manifest 全体の byte 一致も必要である。

`--tooling-worktree` は未 commit の packaging 検証専用で、manifest を `releaseReady: false` にする。release verifier は preview manifest を常に拒否する。

## CI と release

CI は pull request、merge queue、main の全変更で packaging 負例、2回生成の再現性、preview の拒否、repo 外 consumer smoke を行う。consumer smoke は2 tarballを一時 `node_modules` に展開し、実 export と型を確認する。workspace/source tree への fallback は使わない。

release workflow は `workflow_dispatch(source_sha)` だけを入口にし、main 上の workflow SHA の祖先である source だけを扱う。read-only build と独立 reproduce/verify の後、publish job が Actions API の artifact ID、digest、run ID、attempt と固定 manifest hash を再確認する。manifest は公式 workflow identity で attest し、新規 tag と新規 release に manifest、2 tarball、artifact receipt を添付する。既存 tag/release/asset は上書きせず、latest release にもしない。
