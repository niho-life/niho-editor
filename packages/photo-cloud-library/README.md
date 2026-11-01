# 本人写真API → PhotoLibrary adapter（段階1）

Issue #157 P08のfixture先行実装。`@niho/photo-library-contract`のP00合成fixtureをcloneし、SDK 0.1.5の`PhotoLibrary`へ本人用APIを写す。実APIや本番認証へ接続した完成物ではないため、#157はこの段階ではcloseしない。

```sh
npm -C packages/photo-cloud-library ci --ignore-scripts
npm -C packages/photo-cloud-library run check
```

## この段階で確認する範囲

- trusted hostが`actorId`・`libraryId`・`sessionEpoch`と、credentialを外へ出さない`authenticatedFetch`を注入する。adapterはtokenを保存・表示せず、owner/scopeをbody・queryへ送らない。
- P00の`PHOTO_ROUTES`をmethod/path/idempotencyの正本にし、相対URLだけを認証fetchへ渡す。contentはadapter発行のopaque参照をowner/photo/assetへ束縛する。
- library/photo/asset応答のowner・library・hashを検証し、hostの`subscribeScopeChange`通知とlogout相当の`dispose()`でfetchとstream読取をabortして参照/raw cacheを破棄する。
- list/get/lookup/info、original/content、working-copy ensure/retry、recipe CAS、versions、既存mask読取、trash deleteをSDK形へ写す。favorite/album/flag等の未対応filterは拒否する。
- recipeはraw JSONを別に保全する。compiled `niho-photo-contract` validator、active lifecycle、serverの`edits`/`versions` capability、hostが実証したruntime capabilityの積集合だけを書込可能にし、未知version/engine/描画fieldはSDK projectionを`null`としてopen/save/version書込を拒否する。未知recipeでもread-onlyのoriginal downloadは別経路で許可する。
- capabilityはfail-closed。`nativeExport`、`exportFolder`、`articleImages`、`albums`、`favorites`、`flags`、`cutout`、`device`、`editedPreview`は提供しない。engine manifest URLはhostの固定値だけを返す。
- `addFile`と`saveMaskSurface`はmethodを持たず、`addFiles`/`maskSurfaces`はfalse。P03のupload/mask転送接続待ち。presetはhost注入可能で、未注入時はlist空・保存/変更/削除を明示拒否する。
- contentは`Content-Length`とstream実byteの両方を上限検査し、AbortSignalを伝播する。scope変更・dispose時はadapter cacheと参照を即時破棄し、注入fetch/streamがsignalを無視してもreader待機を終了する。テストはNode 24のメモリfetchだけで、network・secret・productionへ接続しない。

## 残る接続

- P01〜P07の実API・NIHO本人認証・storage/media/lifecycleとの接続と、P12の独立conformance。
- SDK 0.1.5は個人用`scopeKey`を含む固定releaseとして採用済み。実hostからのscope注入とQueryClient破棄の受入は残る。
- React 19 / Next client boundary、QueryClient破棄、WASM/Worker/manifest/CSP、Web `/photo` mount、Mac native fetchとblob URL lifecycleの実host接続。
- P03の`addFile`/`saveMaskSurface`転送、実decoder/runtime/HEIC・RAW・mask・mobile/cropの受入。
- manifest＋full source SHA＋tarball SHA-256を伴う公開配布、niho-photo側の固定採用、署名済みMac/iPhone往復、本番配備。

SDK packageはrelease URL/version/SHA-256 SRIをP00 baselineと照合する。`PhotoLibrary`型の手書きshimは持たず、通常の`tsconfig.json`と`tsconfig.sdk.json`の両方がpin済み0.1.5の実TS sourceを直接解決し、adapterの`… satisfies PhotoLibrary`を`strict:true`・`exactOptionalPropertyTypes:true`で検査する。testでも実sourceの必須methodを照合する。型importなのでSDK sourceをruntime importしない。

0.1.5の実SDK sourceは`noUncheckedIndexedAccess:true`ではSDK内部（`browser-photo-adjustments.ts`、`develop-geometry.ts`、`develop-perspective.ts`）にstrict errorが出る。またpackageに`type:module`が無いTS sourceなので、`verbatimModuleSyntax:true`ではSDK内部をCommonJSと判定したmodule errorになる。このrepoでは上流SDKを改造せず、両tsconfigの`noUncheckedIndexedAccess`と`verbatimModuleSyntax`を`false`にしている。したがって`tsconfig.sdk.json`が保証するのは「実SDK sourceを含む通常のstrict型検査と、実`PhotoLibrary`境界への適合」であり、SDK全体の`noUncheckedIndexedAccess`適合や`verbatimModuleSyntax`適合までは保証しない。
