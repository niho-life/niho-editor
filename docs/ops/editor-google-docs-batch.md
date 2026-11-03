# Google Docs一括書き出しの配備と復旧（#238）

本文はEditor、本人のGoogle接続と作成receiptはNIHOが正本。各ページを別のGoogleドキュメントにする。GoogleのOAuth client/refresh tokenをEditorへ複製しない。通常NIHO APIのEditor token拒否は維持し、固定の専用gatewayだけを使う。

## 配備順

1. NIHO側の専用gateway、grant migrationとlifecycleをマージ・公式配備する。`EDITOR_DOCS_DRIVE_ENABLED`は初期false。`EDITOR_DOCS_DRIVE_AUDIENCE`に固定HTTPS audience、`EDITOR_DOCS_DRIVE_WORKER_SERVICE_ACCOUNT_EMAIL`にEditor runtimeの実行identityを指定する。値はNIHOの非公開運用設定で管理する。本人tokenではinternal口を呼べない。
2. Editorを`GOOGLE_DOCS_MODE=off`・`GOOGLE_DOCS_BATCH_MODE=off`・`PRIVATE_JOBS_MAINTENANCE=true`・keyring参照なしで配備し、新migrationと共通private-job cleanupの固定command/argsを確認する。
3. `private-jobs-infra.sh`で共通の5分回収を設定し、`google-docs-infra.sh`で専用queueと5分の復旧sweepを設定する。後者はtask identityとqueueだけに既存の最小権限を与え、ユーザー資格情報・Google秘密を持たない。停止中のSchedulerを自動再開しない。この時点ではアプリ機能を有効にしない。
4. オーナーが`set-private-jobs-keyring.sh`へ、安全な標準入力で1行JSONのkeyringを渡す。鍵はチャット・コマンド引数・ファイル・AIへ渡さない。helperが返す非機密の固定数値版参照だけを`EDITOR_PRIVATE_JOBS_KEY_RING_SECRET_REF`へ設定する。翻訳と共通のkeyringを使い、purpose/AADは用途別に分離する。回収が準備できるまで参照付き配備を拒否する。
5. NIHOのgatewayを有効にし、Editorの`EDITOR_NIHO_API_ORIGIN`を専用NIHO認証originの`/api`へ固定する。`GOOGLE_DOCS_MODE=niho`で単一書き出しを、前提がそろった後`GOOGLE_DOCS_BATCH_MODE=cloud-tasks`で一括処理を有効にする。`EDITOR_GOOGLE_DOCS_NIHO_SERVICE_AUDIENCE`はNIHOと完全一致させる。Editor/NIHO双方の固定SHAとrevisionを記録する。

非秘密設定の実値・project/SAメール・bucketはignored deploy.envだけに置く。公開CIは合成値を使う。通常deployはIAMや鍵を作らず、インフラの設定と分離する。

## 稼働確認

未認証のページ/結果API、OIDCなし・別callerのrun/sweepが拒否されることを確認する。本人の事前確認でページ木・revision・省略内容を確認してから開始する。画面受入を省略しても、owner境界・CAS・取消後のcreate停止・応答消失時の同じexportId・失効・payload回収を機能検証する。

受付上限は200件/合計32MiB、各Markdown4MiB/100万文字。operation IDで同内容の受付へ収束し、本文はサーバーが固定する。画像/録音の省略を開始前に説明し、private asset URLや本人tokenをGoogleへ渡さない。暗号化snapshotは23時間50分以内で期限切れとなり、共通5分回収で正常稼働時24時間以内に消す。完了・取消・本人/元ページ消去時も不要payloadを回収する。回収jobを重複して作らない。

## 失敗・取消・戻し方

queue投入やHTTP応答が消えた場合は、同じjob/exportIdの保存状態とNIHO receiptを先に確認する。UNCERTAINを未作成に戻し、新しい文書を作らない。lease/generationとdurable outboxにより再配送する。grant発行応答が消えたworkerは登録済みlookupだけを使い、新しいgrantを作れない。

取消は後続の作成を止める。既に送った1件は完成しうるため、取消後もDBのcompleted receiptだけから確定する。Google/OAuthの再照会やcreateはしない。既存Google文書を削除しない。接続解除・別Googleアカウント・Editor接続失効では旧jobを止め、新しい許可へ差し替えない。

停止はbatch modeをoffにした公式revisionへ配備し、必要ならqueueと復旧sweepをpauseする。共通private-job cleanupを止めず、payload回収を継続する。本文のないreceiptだけを見て成功を捏造せず、結果不明は不明として残す。エラーの集計は固定code/件数だけで行い、本文・タイトル・資格情報をログから取得しない。
