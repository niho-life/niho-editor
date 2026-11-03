# Mac ローカル音声経路の検証記録

対象は `apple-local` / `mac-local` と Mac の native 音声取り込みです。この文書は再現手順と記録欄であり、長時間音声や話者品質の合格を示すものではありません。実在人物の音声、無許可音声、秘密を含む音声は使いません。

## 自動検証で固定する範囲

- 合成 AIFC を AVFoundation で実際に decode し、16 kHz・mono・16-bit WAV へ変換する。破損 AIFC は失敗し、元ファイルを残す。
- 0 B、2 GiB ちょうど / +1、6 時間ちょうど / +1 を、巨大メモリを確保せず sparse file と小さい DTO で検査する。
- native IPC は 4 MiB 以下の連番 chunk だけを返す。offset 不一致、途中中断、再送、owner scope 不一致を拒否する。
- server の run は page / owner / operation / generation / base revision / candidate revision / audio manifest を照合し、遅着結果を保存しない。
- 保存応答が不明なときは認識結果を Mac に残し、同じ結果だけを再送する。server 保存成功後だけ音声と結果を破棄する。
- native の復旧 metadata は最初の作成時刻を保持し、再開しても 30 日の期限を延長しない。保存待ち結果も最大 30 日で掃除する。

## 復旧 namespace と削除境界

Mac の復旧対象をログイン所有者ごとに分離する `ownerScope` は、Editor DB が `(owner, auth_mode)` ごとに一度だけ発行するランダムな namespace を、復旧用途へ SHA-256 で目的分離した不透明な 64 hex です。NIHO ID、Google ID、一般 token、provider credential は DTO に含めません。同じ owner でも auth mode が違えば別 namespace になり、同じ owner と auth mode なら再ログイン、token refresh、Editor/Mac の再起動をまたいで同じ値になります。DB が使えないときは新しい推測可能な値へ fallback せず、復旧 context API を 503 で閉じます。

namespace 行は既存の Editor user-owned metadata と同じ所有者削除境界です。ページの trash/purge、録音・run・候補の削除では消さず、owner の認証 metadata を管理上削除するときだけ同じ owner の namespace も削除対象にします。現時点では account metadata の自動 purge はないため、この feature だけの期限削除も行いません。Mac 内の音声・復旧 metadata・保存待ち結果には別の 30 日上限があり、30 日ちょうどから一覧、読取、再開、認識 cache に使えません。

## resumable upload の再開契約

- 新規・再送とも、最初に空の `PUT` と `Content-Range: bytes */TOTAL` で同じ session の保存位置を照会する。
- `308` は公開された `Range` の upper + 1 だけを次 offset とし、`Range` がなければ 0 とする。送信済み chunk 全体の保存を推定しない。
- 応答不明または `5xx` は同じ session を照会してから続ける。後退、範囲外、不正 `Range`、進捗なしは bounded retry 後に安全に失敗する。
- `412` だけでは完了とせず、既存 object の metadata/readback と server complete で一致を確認する。owner/session 変更または abort 後は次 chunk、complete、Mac 側音声削除へ進まない。

## 許可済み fixture で後から行う計測

1、15、60 分の固定 fixture を同じ入力から作るか、同一内容の許可済み fixture を用意します。正式 source の承認前、実 provider・実マイク・音声 upload・署名・配布は実行しません。

```sh
shasum -a 256 <fixture>
sw_vers -productVersion
uname -m
<niho-speech> --version
/usr/bin/time -l <niho-speech> convert --input <fixture> --output <temporary-wav>
```

端末内認識は配布候補と同じ `niho-speech` / Apple engine で実行し、次を 1 回の記録にまとめます。

| 項目 | 記録値 |
|---|---|
| fixture 名・長さ | |
| 入力 SHA-256 | |
| source 承認者・承認日 | |
| macOS / CPU | |
| NIHO editor build / commit | |
| niho-speech version | |
| engine / model・asset version | |
| wall time | |
| peak resident memory | |
| 変換後 bytes / duration | |
| transcript WER（正解文がある場合） | |
| 話者分離の誤り | |
| 話者帰属の誤り | |
| 中断・再開結果 | |

WER と話者評価は別に記録します。別 Part の同じ話者番号を同一人物とはみなしません。自動テストの成功だけで、実音声品質、Apple 話者品質、正式 source 承認、公式配布を完了扱いにしません。

## CI / 実機で残す証跡

- TypeScript: Editor API・DTO・UI orchestration・ACL・Store integration の対象テスト名と commit SHA。
- Swift: AIFC decode、破損、2 GiB / 6 時間境界の対象テスト名と Xcode / SDK。
- Rust: chunk offset、owner scope、復旧 metadata、変換後上限の対象テスト名と Rust toolchain。
- 実機: 許可拒否、利用不可、停止、ページ切替、owner 切替、異常終了、sleep 後復旧をそれぞれ成功表示しないこと。
- 配布: 固定 source 台帳、署名、公証、配布 build の exact SHA。別リポジトリの台帳が固定する native 版を、未配布の main と取り違えないこと。

## 2026-11-03: 既存配布 helper の合成入力計測

今回の候補コードではなく、既にインストールされた app 0.1.115 / helper 0.3.1 を macOS 26.5.2 で直接実行した。helper SHA-256 は `747ce8bfcb8d49a6e49125cb50e3abbb0ccd3826a6d1eddaac6af988cea4ccf7`。日本語の合成1話者の同じ文章を、文を途中で切らず繰り返し、末尾の無音で尺を合わせた。実マイク・実話者・provider送信は行っていない。

| 尺 | 16 kHz mono入力 | 認識時間 | 日本語CER | CLIの最大RSS |
| --- | ---: | ---: | ---: | ---: |
| 1分 | 1,920,044 bytes | 0.740秒 | 2 / 220 = 0.91% | 約20.6 MiB |
| 15分 | 28,800,044 bytes | 8.393秒 | 627 / 4,290 = 14.62% | 約21.9 MiB |
| 60分 | 115,200,044 bytes | 36.003秒 | 1,245 / 17,160 = 7.26% | 約22.0 MiB |

CERは句読点と明示した数値表記を正規化した文字誤り率で、WERではない。CLIのRSSはAppleの共有認識サービスを含まない。長尺の誤り率は悪化しており、品質合格・話者分離品質・最適な区切り時間の根拠にはしない。

2 GiBちょうどの疎な合成PCM無音WAV（48 kHz stereo、11,184.8104375秒）も実decoderで変換した。1.764秒で16 kHz monoの178,956,967 frames / 357,913,978 bytesを得て、32 bit切詰めは観測しなかった。CLI最大RSSは約53.7 MiB。AIFCの実変換と破損AIFCの拒否、失敗時に原本と既存出力が残ることも確認した。いずれも新しいbridgeの取込・upload・復旧・公式配布の受入とは区別する。

記録: [#239 の計測結果](https://github.com/niho-life/niho-editor/issues/239#issuecomment-6601221957)。
