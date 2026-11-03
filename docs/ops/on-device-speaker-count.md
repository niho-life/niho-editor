# 端末内話者識別の人数制約（#239）

`niho-speech` 0.3.2は、モデルの結果が明示した話者人数に一致することを推論後にも確認する。自動モードは推定のまま、exactは同数、minimumは下限以上を要求する。不一致は失敗とし、新しいspeaker mapを書かない。架空の話者や別engineへの自動fallbackは作らない。原本・既存候補は通常の復旧経路で保つ。

承認済み0.3.1での合成OS音声2種類・6交代・60秒では、自動・2人指定とも1話者となった。CLI error=0でも識別品質の合格ではない。0.3.2の変更はこの成功扱いを止めるもので、モデル精度向上の証拠ではない。実イベント/重なり音声は別に受け入れる。画面受入はowner指示で省略。

実際のModels.swiftをFoundationだけでcompileし、過少/過剰/空/無効指定/最少/自動の10条件を確認。XCTestの境界4件を追加し、公式sidecar lock check/self-testを行う。FluidAudioを含むSwift test/native buildはrequired CI。merge後の公式採用・配布と、新binaryの実推論で不一致時の失敗・原本保持を確認する。旧0.3.1のQAを新binaryの検証として使わない。
