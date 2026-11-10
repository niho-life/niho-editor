# 作業座席と topic branch の運用

この文書は既存 seat の再利用と topic branch の準備を定めます。並行編集・worktree の制約は [AGENTS.md](../../AGENTS.md)、公開範囲と権利条件は [CONTRIBUTING.md](../../CONTRIBUTING.md) が正です。

## 座席の状態

既にある `niho-editor-N` の worktree を使います。新しい clone / worktree や `niho-docs-N` は owner が明示した場合以外は作りません。

```sh
scripts/seat.sh status
```

- `空き`: detached の座席に変更や保存先のない commit がありません。
- `再利用可・branch保持`: clean な topic branch が checkout 済みです。branch があるだけでは使用中と判断しません。
- `変更あり・保護`: 未コミット差分があるため作業を切り替えません。
- `要確認`: detached HEAD に remote 未到達 commit があります。branch を付けて保護してください。

## 新しい作業を始める

既存の `niho-editor-N` の中で、repo の branch 命名に合わせた名前を指定します。

```sh
cd ../niho-editor-1
scripts/seat.sh start docs/editor-guide
```

`start` は clean な seat なら topic branch があっても使えます。新しい branch を最新 `origin/main` から作り、checkout 中だった branch ref はそのまま残します。既存の同名 branch は上書きせず停止します。

未コミット差分は保護のため停止します。branch のない detached commit も、保存先の ref を付けるまで切り替えません。

## 作業終了

```sh
scripts/seat.sh release
```

`release` は clean な seat を `origin/main` に detach します。以前の branch と commit は削除しません。別端末にも必要な commit は push してください。stash は使いません。
