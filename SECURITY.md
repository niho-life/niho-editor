# 脆弱性の報告

未修正の脆弱性、再現手順、exploit、実データ、token、署名 URL は public issue / pull request に投稿しないでください。

1. GitHub の [private vulnerability reporting](https://github.com/niho-life/niho-editor/security/advisories/new) から非公開で報告してください。
2. private reporting が利用できない場合は、技術詳細を含めずに issue を作成し、maintainer へ非公開連絡先を問い合わせてください。
3. 報告には可能な範囲で影響範囲、再現条件、修正案を含めます。実ユーザー情報や認証情報は添付しないでください。

脆弱性情報の公開時期と修正内容は maintainer が報告者と調整します。GitHub の private reporting の説明は[公式ドキュメント](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately)を参照してください。

## CI・配布・採用時の確認

maintainerは、workflow、release/verifier、依存lock、install scripts、認証境界の変更を重点的に確認します。
全PRを自動的にレビュー依頼へ割り当てる運用にはせず、既存のmain保護・必須検査・未解決threadの解消と、マージ前の差分確認を維持します。
通常の公開PRはread-onlyのGitHub-hosted環境で検証し、本番の秘密、private checkout、trusted self-hosted runnerを渡しません。
Actionは完全commit SHAを指定し、checkoutの資格情報を保存しません。更新時は同じmajor版でも出所と差分を確認します。
SDKのpublishはbuildから分離し、固定source/run/attemptとartifact ID/digestを検証する既存経路を使います。
利用側は採用版の差分・互換性・必要な認可検査を確認します。公開mainへの反映だけで利用側の本番採用とはしません。
