# NIHO本人認証と記事連携の境界

2026-11-07更新（editor #332、Experience #476）。Experienceの記事はExperienceの `/write` で書き、正本をExperience DBに置く。editorからExperienceへの記事公開・役割確認・体験関連付け・招待操作は撤去する。

## 維持する本人認証

NIHO用の接続はEditor専用cookieからserver-onlyで取得する。同じ要求の現在sessionと本人・接続ID・期限を照合し、資格をSession DTOやブラウザへ返さない。Photoのcookie・旧接続・自己申告roleを代用しない。

既存client IDの `niho-experience-editor` とcallbackは本人認証の互換のために維持する。名前にExperienceが含まれていても、記事公開の許可を意味しない。ページの作成・同期・文字起こし・本人サイト公開はExperienceのwriter権限を必要としない。

本人情報は設定ページの先頭に表示し、左下は歯車＋「設定」の入口とする。独立したアカウント画面は持たず、旧 `/account` は設定へ転送する。Experienceの接続状態・記事招待・承諾・辞退は表示しない。

表示名を取得できないNIHO sessionにだけ、設定内の「名前を再取得」から同じNIHOアカウントへ接続し直せる。`sameAccount=1` の開始時に現在actorを確認し、短命のpending cookieへstateとactorのhashを結ぶ。callbackで別actorになった場合は新しい未使用接続だけを失効させ、元のsessionと原稿の所有者を維持し、設定に理由を表示する。配備前に始めた再取得も旧 `/account` から設定へ戻す。表示名は確認後のNIHO exchangeから読み、認可には用いない。

## 閉じる記事専用の経路

- NIHOの専用roles、article-links一覧・承諾・辞退を呼ばない。
- Experienceのカテゴリ・関連体験候補・公開時検証APIを呼ばない。
- 旧Experienceの発信先詳細、article-links、experience-options、内部publication authorityは閉じる。
- `destination=exp` の新規ページへの手渡し文脈は廃止する。通常のログイン後の戻り先と録音開始は維持する。
- Experienceの公開・公開APIの面資格・プレビューtokenを受け付けない。旧設定・資格・tokenが残っていても再開しない。

本人サイトの接続・公開API・プレビュー・書き出しは維持する。保存済みのページ・公開版・履歴は削除しない。公開写真は本人サイトの有効な公開版だけを根拠とする。

## 配備

旧authority flagは未設定または `false` だけを認める。公式配備はExperienceのorigin・audience・allowlist・面資格のSecret参照をruntimeへ渡さない。新規資格の発行helperも撤去する。Secret値の取得・削除やIAM変更は行わない。

合成データで、旧writer許可・face資格・token・設定でもExperienceの記事が公開・読取できないこと、上流への記事専用通信が発生しないこと、NIHO本人認証と本人サイト公開が使えることを確認する。将来editorへ全面移管する場合は別途決める。
