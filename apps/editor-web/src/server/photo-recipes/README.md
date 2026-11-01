# P05 recipe/version core

Issue #154 のrecipe・VersionSet mutation core。HTTP routeとP01 actor resolverは未接続。`owner`は認証済みrouteから渡すuser IDだけを受け、request bodyからは読まない。

このcoreは固定Photo SDK/runtimeの`PhotoRecipeValidator`を必須依存にする。settingsの互換性、canonical SHA-256、mask参照抽出はvalidatorへ委譲し、このhandlerでSDK判定を複製しない。validator未設定、未知settings、形式・engine非対応は書込を拒否する。履歴GETは将来settingsを削らず返し、古いhostでもread-only表示できるようにする。

`PhotoRecipeStore`はP02唯一のwriter境界。次の処理をDB transactionで一体に実装する必要がある。

- owner/photo/library/lifecycleの再確認とrecipe revisionまたはVersionSet revision CAS
- mask surfaceが同じowner/photoに保存済みかの再確認
- idempotency keyと正規化payload hashの比較・再送判定
- recipe確定・library revision更新・新revision専用media outboxの同時記録
- trash/account deletingと並行したwrite、および古いmedia job確定のfence

schema・migration・P02 adapterは変更していない。現行P02にrecipe/version CASとmask lookup APIがなく、P01 auth routeと実SDK runtimeも未接続なので、このPR単体では本番APIを公開しない。すべてのwriter連携と端末間受入が揃うまでIssue #154はopenのまま。
