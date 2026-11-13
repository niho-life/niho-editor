# EditorからGoogle Docsへの書き出し

対象は単一ページと#238のフォルダ一括書き出し。本文の正本はEditor、Googleの接続・OAuth・変換・作成receiptはNIHO。各ページを本人のMy Driveへ新しいGoogleドキュメントとして作り、既存文書を更新・削除しない。旧NIHO vaultのfolder exportやGoogle文書tabsを再用しない。

## 認証と本人の接続

`AuthProvider.docsApiToken(session,request)`は現在の要求cookieとsessionのowner・接続・期限を再照合し、固定用途の資格だけを返す。generic `apiToken`はnullのまま。Google/stub/Photo/native AppConnectへfallbackしない。NIHO Adminによるwriter承認はExperience公開の権限であり、Google書き出しの条件にしない。

Editor serverはNIHOの`/api/auth/experience-editor-connect/docs-drive`だけを呼ぶ。通常NIHO APIは引き続きEditor専用tokenを拒否する。旧`/api/me/docs-drive`のrequireAuth/client制限を緩めない。NIHO側は現在のUser/Person/Firebase・Editor connectionと期限を既存authorityで確認する。

| 専用prefix配下 | 入出力 |
| --- | --- |
| `GET connection` | `{connection:{status,connectedEmail,reason}}`。本人だけに返す |
| `POST connect` | `{returnTo:"niho-editor"}`からGoogle同意URLを得る |
| `DELETE connection` | NIHO保持のcredentialと既存grantを解除する |
| `POST exports` | `{exportId,title,markdown}`からcompletedまたはpendingを返す |
| `GET exports/{exportId}` | 同じ本人のreceiptを照会する |
| `POST batch-grants` | `{jobId,items:[{exportId,payloadSha256,payloadBytes}]}`に限定grantを発行 |
| `DELETE batch-grants/{grantId}` | 現在の本人が自分のgrantを取り消す。他人と不存在は同じ404 |

Google scopeは既存drive.file/userinfo.emailのまま。OAuthの`niho-editor` returnToは署名state・本人・flow・期限をNIHOが検証した後、固定Editor接続画面にだけ戻す。未署名state hintを成功根拠や任意return URLとして使わない。解除でプロジェクト全体のGoogle同意をrevokeしない。

## 本文と一括受付

サーバーが本人のactiveなroot/子孫を木順に読む。requestにはroot、operation UUID、選択page ID/expectedRevision、順序・背景optionsだけを渡し、本文と題名を受け取らない。未保存編集をflushし、他人・別tree・ゴミ箱・重複・revision競合は開始前に拒否する。200ページ/合計32MiB、各Markdown4MiB/100万文字以内。画像・録音・非対応ブロックの省略を事前に説明し、private/token付きasset URLをGoogleへ送らない。

transactionで本文・題名・revision・順番・export UUIDを固定する。受付後の原稿編集で差し替えない。本文と題名の一時snapshotは共通private-job cipherで暗号化し、用途・本人・job・item・期限をAADへ束縛する。平文本文、題名、本人token/cookie/Google refresh tokenを背景jobやログへ保存しない。

正規payload hashはSHA256(`${UTF8byteLength(title)}:${title}${markdown}`)。payloadBytesはtitle+markdownのUTF8 byte数。日本語/emojiを含む共通vectorでNIHOと一致させる。同じoperation IDは同じ選択/revision/optionsのjobへだけ収束し、異なる内容は409。

## 限定grantと背景処理

NIHOはjob UUIDを全体一意にし、本人・現在Editor connection・固定worker・現在Google account hash/connectedAt・期限・最大200 itemのhash/bytesへ束縛する。題名/本文/tokenは持たない。期限は最長24時間かつ現在Editor接続期限以下。同じ本人/job/接続/contentだけ冪等。

prepared→grant確定→durable queue outbox→running/completedと進む。外部呼出しをDB transactionへ入れない。Cloud Tasksの内部run/sweepは専用OIDC audienceと固定task identityだけを通す。workerは1回に1item、job/ordinal/generation/leaseをCASする。queue応答消失、重複配送、途中停止、lease切れをoutboxと5分sweepから回復し、古いgenerationの結果で上書きしない。

workerがNIHOを呼ぶときはruntimeの固定Google metadata identityを使い、NIHO専用audienceに束縛する。登録済みgrantのlookupは応答消失の回復だけで、新しいgrantを発行・復活させない。NIHOのinternal exports/statusはowner/job/item/hash/bytes・現在の本人/接続/Google bindingを毎回照合する。create直前も再確認し、接続変更後の作成を止める。

一度送信したitemは同じexportIdのstatusを先に確認する。UNCERTAINを未作成に戻さず、新しいcreateを送らない。NIHOが安全な再送可能を明示した場合だけ同じID/固定payloadで再試行する。Google文書URLは検証済みdocumentIdから組み立てる。

## 取消・保持・消去

取消は後続作成を止め、現在の本人からNIHO grantをrevokeする。既に送った1件は完成しうるため、その事実を表示する。取消・期限切れ・接続失効後はactiveなownerと登録grant/item/caller一致時のDB completed receiptだけで確定し、Google/OAuth再照会・create・再処理をしない。workerはinternal statusへ`receiptOnly:true`を明示し、NIHOへのrevoke要求が未確認でも照会を狭める。NIHO #19731のこの追加契約が未反映なら400で止まり、通常のstatusへfallbackしない。結果不明を未作成と断定しない。既存Google文書を削除しない。

Google account/Editor接続の変更で旧jobを止め、本人の確認なしに新しいgrantへ切り替えない。本人・元ページの消去で一時snapshotを消す。NIHO grantは統合先へ移さず、退会/PII purgeに接続する。

一時payloadは22時間50分以内で期限切れとし、共通の1時間おきcleanupで正常稼働時24時間以内に回収する。完了/取消時も不要payloadを即時消去する。鍵なし・cleanup未準備なら受付を閉じ、通常ページ編集は継続する。鍵破棄をpayload削除の代用にしない。

## 検証と配備

認証/owner/CAS/上限、固定snapshot、暗号化/期限/消去、grant/queue応答消失、duplicate/lease/古いgeneration、UNCERTAIN、取消中の完成、接続切替を合成fixtureで検証する。実Googleへ本文を送る試験は通常のworkerでは行わない。画面受入の省略を機能検証の成功と読み替えない。

方式は既定OFF。対向NIHO APIとEditor双方のマージ・公式配備・現在設定/HTTPの読戻しがそろってから有効にする。鍵はオーナーだけが投入し、AIは扱わない。[配備・復旧手順](../ops/editor-google-docs-batch.md)を参照する。
