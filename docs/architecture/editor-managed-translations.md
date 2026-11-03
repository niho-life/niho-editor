# Editorの日本語原文と確認付き英語版（Experience #213）

本文の正本はEditor。Experience内CMSを復活しない。現在のAI toEnglish presetは最上位の段落/見出しだけを変更する提案であり、記事全体・題名・リード・写真altの管理翻訳を実装済みとはみなさない。

## 原文と英語版

ユーザー所有の日本語pageと英語pageを、Editor内の言語版relationで結ぶ。DBの現在のpage/lang/版/保存/公開モデルを維持する。source/targetは必ず同owner。元ページと英語ページは各々通常の版履歴と手編集を持つ。sourcePage/targetPage/翻訳元revision/確認した原文revision・英語revisionを管理する。sourceを消したらtargetを自動削除/非公開にせず、原文不明を表示し、次の公開更新は原文/対応を確かめるまで止める。本人のアカウント消去は両方を現行cascadeで消す。

元の日本語を直すと、英語版には原文更新の表示を出す。新しい翻訳を実行しても、手編集中/保存済み/公開中の英語版は自動で変更しない。

## 翻訳候補

本人がページを保存してから明示実行。原文のtitle/lead/許可ASTの本文/写真alt・caption・必要な公開説明をsnapshotし、出力候補を作る。画像URL/asset id/link URL/ブロック構造・mark属性はAIに変更させない。変換する文字列を安定したfield pathへ列挙し、モデルは同じpathの英訳だけを返す。欠落/重複/未知path/サイズ超過/未知schemaを拒否し、部分結果だけを英語版へ適用しない。既存AI provider/予算・使用量・同意の経路を再利用し、実行前に送信先を示す。provider失敗から別の有料経路へ自動fallbackしない。

翻訳はdurable proposal/jobで保持し、generation/lease/operation idと入力hashで再送/遅着を保護する。本文/指示/上流error/秘密をログに出さない。候補の生成/閲覧はページlang/本文や公開版を変えない。題名・リード・全本文・alt・事実表現を本人が確認できる画面を作る。候補採用はsourceとtargetのexpected revisionを照合し、初回は英語の非公開pageとして作成、既存英語へは明示採用で新版を作る。競合時は双方を保持し、自動で相手の変更を上書きしない。

画像はページに属する資産。元pageのasset id/objectKeyを新pageの所有物として偽装しない。既存の正規storage copyで英語page用の独立資産にし、原文側の削除/GCで英語画像が消えないことを検証する。複製の途中失敗は原文/既存英語を壊さず、孤立物を現行cleanupへ返す。無断にpublic化しない。元の許諾/creditを維持し、altの英訳だけを本人が確認する。

## 確認と公開

翻訳生成と公開は別操作。managed translationだけは、確認済みのsource revisionとtarget revisionが現在と一致するまで新しい公開/更新を拒否する。原文だけ更新された場合は、再翻訳または内容を手で確認して対応を確定する。targetの手編集後も再確認する。初期の既存英語ページや手で書いた英語記事に一律の翻訳条件を足さない。

写真許諾/個人情報/固有名詞/時間・価格等の事実確認は既存の公開条件と組み合わせる。AIが成功したことだけで「確認済み」にしない。公開済み英語snapshotは再翻訳失敗で書き換えない。

Experienceの初期面は英語guidesのまま。日本語URLを捏造してhreflangを増やさない。実在する両言語のlive公開版がある場合だけ、公開可能なalternates/canonicalを検証して描画する。unlisted/private/stopped/foreign-ownerをalternateや検索/sitemapへ露出させない。カテゴリ/関連体験は各公開先の現在条件で再判定し、翻訳によって権限を増やさない。

## 検証

合成の画像/本文/モデルadapterで、全fieldの網羅と構造不変、他人/削除source拒否、CAS/遅着/再送、手編集・公開版保持、原文更新表示、画像copy/GC/失敗、確認と公開の分離、未確認metadata/alt、無効alternateを対象テストする。実provider/個人本文送信/公開操作はworkerで行わない。画面受入はowner指示で省略可能。

## 現行scopeと実装判断の補足（2026-11-03）

オーナーはNIHO日本語記事面と「鎌倉の人」の役割を撤廃した。今回の日本語原文はEditorの個人ページ、英語版の公開先はExperience。日本語版の公開先/hreflang URLを追加せず、実在しない日本語ページをSEOへ出さない。既存本人サイト接続は壊さないが、このfeatureで新しい日本語の公開面は作らない。

1. 生成は既存 `resolveAiCompose` のAnthropicClient/設定・JST月次usage/予算を使い、実行前に送信先と従量対象を示して本人が「APIで英語案を作る」を選ぶ。Macの既定CLI設定から、無説明に有料APIへfallbackしない。既存clientの構造化応答・usageエラー処理は再利用するが、`buildComposePrompt` の24,000文字clampを翻訳に使わない（省略は不可）。初期上限は翻訳対象20,000 codepoints/256 fields。超過はproviderを呼ぶ前に説明して拒否し、分割を案内する。
2. 新しいCloud Tasks基盤を翻訳専用に作ることは必須にしない。固定入力を持つproposal/operation/generation/leaseで1回の生成を占有し、同時・応答消失の再送は同じproposalを返す。request停止/provider失敗は候補を採用せず固定codeで失敗する。新しい明示再実行だけが別generationを開始する。モデルが返した値だけを英語ページへ自動保存しない。
3. field pathはtitle、lead、本文のtext、写真alt/captionなど人間の文だけ。リンクURL/asset ID/構造/mark/credit/ライセンスを維持し、codeやrecording等の非対象は勝手に変換/削除しない。対象外を事前に説明し、未知構造・上限・未知/missing/duplicate pathsを拒否する。CONFIRMの未確認印をモデルが消すことも許可しない。
4. relationは現在の同ownerのsource ja→target en。初回採用は非公開の英語ページを作り、再翻訳はproposalとして比較してからtargetのexpectedRevisionとsourceRevisionを照合して採用する。sourceの保存後に並行変更があれば候補を保持して409。既存英語の公開snapshot/手編集を自動上書きしない。source更新・target手編集でreviewed revisionを古くし、次の公開/更新まで人が固有名詞/価格/時刻/個人情報/写真altを確認する。元から独立した英語ページには翻訳条件を足さない。
5. 既存 `duplicatePage` は画像の資産を複製しないため、そのまま使って画像付きの英語ページにしない。Editor ObjectStorageは現在read/stat/startUploadだけで、PhotoObjectStorage.copyは独立製品なので流用しない。Editor側に固定object path/非上書きのcopy portを追加し、GCSではsource generation固定・destination generation=0のrewrite/copyとmetadataを照合する。新しいdelete/overwrite権限は要求しない。sourceのasset metadataを固定し、新target用の独立asset ID/object keyへ写してからrelation/pageのDB確定をCASする。コピーoperation/mappingをproposalに追跡し、同じproposalの再送では同じ宛先へ収束する。失敗/中断時に原本や既存英語を壊さず、未採用copyを追跡不能な孤立物にしない。元ページ側のpurge/GCが英語側の独立objectへ届かないことをテストする。
6. sourceがtrash/purgeされた場合は原文不明を示し、既存公開snapshotは変えない。次の公開は原文を復元して確認するか、本人が現在英語本文を確認して「原文との対応を外して独立した英語ページにする」を明示するまで止める。対応解除は公開操作ではなく、writer/カテゴリ/写真/関連体験の現在検査も省略しない。新しい大きな多言語CMSをExperienceに作らない。

新migrationは公式generator、documented table集合/schema guardを更新し、原文や実データをschemaへ埋め込まない。公開sourceの秘密/実project/実bucket/サービスの内部URLをdocsやtestsに書かない。

## 一時候補の機密と鍵

新しく保持する翻訳proposalの原文/指示/候補title/lead/text/altはDBへ平文複製しない。既存の通常pageの保存方式は変えない。新private-job-payload portをAES-256-GCM、random 96bit IV、owner/proposal/purpose/expiryをAADに束縛して作り、非機密metadataだけ別列に置く。runtimeはowner投入Secretの`EDITOR_PRIVATE_JOBS_KEY_RING` JSON `{active:"v1",keys:{v1:"base64-of-32-bytes"}}`を読み、key id/個数/bytes/formatを厳密検証する。設定なしは生成/候補採用を閉じ、既存英語ページや通常編集へ影響させない。実鍵の生成/投入/読出は禁止、合成test keyのみ。鍵を既存Photo/Firebase/会員tokenから流用しない。proposal内容は採用/期限24h後に消し、owner purgeにも含める。sourceの正本pageは通常の保持に従う。keyring rotationは24h以内の旧候補が残る間だけ旧keyを維持する。Google Docs batchでもこのportをpurpose分離して使う予定。
