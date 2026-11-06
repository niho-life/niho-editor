# NIHO editorの署名前Mac配布候補

公開製品のMac buildと、別のfresh MacによるDATA検証は、このrepo自身の標準GitHub-hosted runnerで行う。公式updaterの署名鍵と配布権限はconsumer側に残す。追跡: #273、niho-coliving/niho-app#19890。

## 開始条件

- `editor-mac-candidate.yml`がレビューされmainへ入っていること。
- 製品sourceはmainに含まれる40桁SHAに固定する。workflow/controllerのSHAとは別に記録する。
- 配布先で次の版を確認し、そのstrict semver（`X.Y.Z`）を指定する。同時配布で版が先行した場合は古い候補を拒否し、privateで再buildしない。
- ownerが`NIHO_DESKTOP_FIREBASE_API_KEY_PROD`に既存の公開client設定を用意する。配布アプリに含まれる公開設定で、updater署名鍵ではない。GitHub Actionsによる自動ログマスクのため、参照元はrepository secretとする。空値やテスト用設定は配布候補に使わない。エージェントはownerの明示許可なしに値を取得・登録せず、値をログ出力しない。
- 本番の署名鍵・cloud資格・非公開checkout・実音声は、このworkflowへ渡さない。

## 作成と採用

```sh
ghN workflow run editor-mac-candidate.yml --repo niho-life/niho-editor --ref main \
  -f source_sha=<製品sourceの40桁SHA> -f version=<X.Y.Z>
```

PR/push/merge-groupでは合成データを使うLinuxテストだけを実行する。手動main実行でのみMac build、fresh Mac検証、prerelease公開へ進む。公開PRからprivate配布を起動する経路は持たない。

1. mainのcontrollerがsourceの祖先関係と版を確認する。
2. 鍵なしMacで候補を1回buildする。
3. 別のfresh Macでtar/DMGをDATAとして読み、展開制限、bundle識別子・版、sidecar、codesign、DMGとtarの全file一致を検査する。候補内のbinary/scriptは起動しない。
4. Linuxのpublish jobがfile集合・manifest・receiptのhashを再確認し、manifestへGitHubの実行証明を付ける。write/OIDC権限はこのjobだけが持つ。
5. `editor-candidate-v<VERSION>-<SOURCE_SHA>-run-<RUN_ID>-attempt-<ATTEMPT>`のprereleaseへ候補を置く。official updater/latestにはしない。

配布先は、レビュー済みcontroller SHA、製品source、run/attempt、repo/workflow/ref、実行証明、全file hash、公開client設定のhashを確認する。版・source・実行元・内容が一致しなければ採用しない。公式署名と配布はその後にconsumerが行う。

## 成果物

- `editor-candidate.dmg` / `editor-candidate.app.tar.gz`: 同じappを収めた署名前の不変bytes。
- `editor-candidate-mac.json`: fresh MacのDATA検証receipt。
- `editor-candidate.json`: source/controller/run/attempt・版・配布契約・file hash・receipt hash。
- `editor-candidate.sigstore.json`: manifestに対するGitHubの実行証明。

一時Actions artifactは3日で期限切れになる。採用用のprereleaseはconsumerの受入とrollback期間が終わるまで維持する。再実行は別attemptの別候補として扱い、前の候補を上書きしない。

再試行はGitHubの **Re-run all jobs** を使う。plan/build/verify/publishを同じattemptに揃えるため、成功済みjobを残す部分再実行は、古い成果物のdownloadや重いbuildの前に拒否する。新しいattemptでは全工程を再実行し、別の候補tagと証跡を作る。

## 失敗と撤退

設定不足・古い版・main外source・検査失敗は公開前に停止する。consumer側の証明不一致でも停止し、privateでの自動full buildへ切り替えない。既存の公式署名鍵・配布feedを変更する必要はない。workflowの成功やprereleaseの存在だけで公式配布済みとは扱わない。
