# Docs / Photo の認証・クラウド境界 v1

2026-11-03。Editor [#15](https://github.com/niho-life/niho-editor/issues/15) の公開境界。共通の安全条件を定義し、製品別データ契約の正本・責任者・検証先を固定する。新しいendpoint、共通保存backend、tokenの相互利用は定義しない。

## 共通に守る認証・防御条件

| 境界 | 要求 |
| --- | --- |
| 本人確認 | 検証済みNIHO本人だけをactorにする。token発行元は署名・issuer・audience・期限・接続の失効を検査する。consumerは登録済みclientと用途の契約だけを使い、JWTのローカルdecodeやメール一致を本人確認にしない |
| 製品 | Editorのsession/cookie/tokenをPhoto用に読み替えない。逆も同じ。製品ごとのclient・callback・cookie・用途を検証し、別製品へのfallbackを拒否する |
| 所有権 | 毎要求でserverのactorとresource recordを照合する。body/queryのowner・tenant・workspace・roleは権限の根拠にしない。他人のIDと存在しないIDは同じ応答にする |
| 失効・本人切替 | 接続の失効後は次の操作を拒否する。製品/本人/session世代でcache・進行中要求を隔離し、旧応答を次の本人へ反映しない。refresh成功だけで失効済み接続を復活させない |
| 転送 | 対象resource・method・内容・期限に拘束した短命capabilityを使う。永続storage資格情報をclientへ渡さない。実bytes、magic bytes、size、checksum、quotaをserverで検証する |
| 再送・競合 | mutationの同一payload再送を安全にし、異なるpayloadでのkey再利用を拒否する。確定済みupload、期限切れ/失効capability、古いrevisionからの書込みを拒否する |
| 秘密・エラー | token、code/state、capability URL、share URL、本文・写真・ローカルpathをlog/analytics/errorへ出さない。エラーは分類と必要なstatusだけにし、他人の存在や内部構成を漏らさない |
| 本番 | 未登録client・未検証の能力・合成認証・mock storageを有効化しない。未認証と上流一時障害を区別し、確認不能を権限付与へ変えない |

同じ安全条件でもwireのfield名、HTTP status、認証方式を製品間で揃えるとは限らない。各adapterが、その製品の確定契約へ変換する。管理者API・内部route・実設定は公開contractへ混ぜない。

## 正本と変更責任

| 契約 | 正本・責任 | 適用範囲 |
| --- | --- | --- |
| 共通の安全条件 | 本書と [公開境界](publication-gates.md)。Editor #15のmaintainerが変更窓口 | 認証・越権・転送・失効・再送・秘密の扱い |
| NIHO認証の最終判断 | 非公開NIHO認証authority。公開consumerは [Editorの接続口](../../apps/editor-web/src/auth/types.ts) と [Photoの接続契約](https://github.com/niho-life/niho-photo/blob/7460e4045e3615821a312cdec4fb9c475fb3c2f0/docs/architecture/personal-photo-cloud.md) に従う | client登録・用途・exact callback・本人/接続の検証。Editorの役割APIは [#42の接続条件](../architecture/editor-role-integration.md) で別管理 |
| Editorの保存・ページ添付 | このrepoの `apps/editor-web` / `packages/editor-store`。Editor maintainer | ページownerに従う文書・添付。Photoの一覧・原本・補正・5GiB枠を参照しない |
| Editorの公開版配信 | [`packages/editor-publish-contract`](../../packages/editor-publish-contract/) / [公開API v1](editor-publish-api-v1.md) | 公開済み文書と発信先。Photo原本への権限を与えない |
| Photo本人クラウドv2 | Photo [C00 #193](https://github.com/niho-life/niho-photo/issues/193) / [専用package](https://github.com/niho-life/niho-photo/tree/7460e4045e3615821a312cdec4fb9c475fb3c2f0/packages/photo-library-contract)。変更窓口はPhoto C00/C08 | 本人5GiB、原本・mask・補正・競合・即時purge。型・fixture・負例・operation対応表をPhotoで保守する。旧Editorの写真DB/contractと双方向同期しない |
| 既存共有リンクv1 | [`packages/niho-cloud-contract`](../../packages/niho-cloud-contract/) / [wire仕様](cloud-contract-v1.md)。Editorが正本、Photoは固定SHAのconsumer | 既存共有リンクconsumerの互換契約。現行2製品の保存APIや本人ライブラリを統合する契約ではない |

Editor添付をPhoto一覧に載せず、Photo原本をEditorの画像候補として暗黙に読み込まない。今後、本人が明示してコピーする機能を設ける場合も、読取元・書込先それぞれで認可し、保存量と削除を独立して扱う。その機能は本境界の完了条件に含めない。

## 固定版と変更手順

- 既存共有リンクv1はPhotoの [`cloud-contract-source.json`](https://github.com/niho-life/niho-photo/blob/7460e4045e3615821a312cdec4fb9c475fb3c2f0/docs/security/cloud-contract-source.json) がEditor source `0e25ca445f855139f8d05846e575d080f065a699` の7ファイルを指定する。型・mock・負例・参照モデル・仕様のbytesとpublication manifestのhashをPhoto CIが検査する。これは既存v1の取り込み証跡であり、Photo本人クラウドv2の接続完了を示さない。
- 共有リンクv1を変える場合はEditor/Photoの対応PRを相互リンクし、同じsource SHAのcontract test・hash検査を通す。Photoが固定した旧版を、Editor main更新だけで自動的に新契約へ変えない。互換破壊は新majorとし、旧consumerの利用期間・移行条件を残す。
- 本書の安全条件を変える場合も、Editor #15とPhoto [#8](https://github.com/niho-life/niho-photo/issues/8) / [#192](https://github.com/niho-life/niho-photo/issues/192) に影響する契約・consumer・検証を列挙する。影響する両製品のPR/CIを対応付け、片側だけの変更で完了にしない。認証authorityに変更が必要なら非公開側の契約受入も先に確認する。
- 製品別の保存契約は各製品で版を管理する。Photo v2の変更を共有リンクv1へ転記せず、Editor公開APIの変更をPhoto本人クラウドへ転記しない。

## 公開側で確認する負例と証拠の限界

| 検証 | 実行先・証拠 |
| --- | --- |
| 別owner/tenant、偽のowner指定、期限切れ・失効・再利用capability、冪等key競合、MIME/checksum/size不一致 | [`docs-core/test/cloud-contract.test.ts`](../../packages/docs-core/test/cloud-contract.test.ts) と共有v1のsecurity cases。test-only参照モデルで検証し、実backendの認可証明にはしない |
| NIHO接続のPKCE・callback Origin/state・HttpOnly cookie・毎要求の接続確認・credential非露出・別製品cookie拒否・失効後の再要求・期限切れ/上流障害 | [`niho-experience.test.ts`](../../apps/editor-web/src/auth/niho-experience.test.ts)。上流応答をmockしたconsumerの検証であり、実NIHO発行・失効の受入とは別 |
| Photoの契約取り込み改変・欠落・出典SHA/hash不一致 | Photoの [`cloud-contract-sync.test.mjs`](https://github.com/niho-life/niho-photo/blob/7460e4045e3615821a312cdec4fb9c475fb3c2f0/scripts/ci/cloud-contract-sync.test.mjs) と資格情報なしの固定SHA取得CI |
| secret、private endpoint、fixture/source map/logのPII、特権PR trigger | [`public-boundary-guard`](../../scripts/ci/public-boundary-guard.mjs) と [その負例](../../scripts/ci/public-boundary-guard.test.mjs)。guardの検査範囲だけを証拠とし、全ての漏洩を検知できるとは扱わない |
| 実NIHOの発行・失効、製品をまたぐtoken/cookie拒否、実storageでの越権・quota・purge、Mac/iPhone往復 | 非公開統合とPhoto [C01 #194](https://github.com/niho-life/niho-photo/issues/194) / [C07 #200](https://github.com/niho-life/niho-photo/issues/200) / [C08 #201](https://github.com/niho-life/niho-photo/issues/201)。公開mock・型・CIだけで合格にしない |

Editor #15は公開境界・契約・検証の責任を追う。Photoの実接続・配備・署名更新・実機受入はPhoto Epic #192、Editorの役割・記事連携は#42で追い、Editorの基本提供条件と混ぜない。本書の追加だけで各製品の実環境受入を完了にしない。
