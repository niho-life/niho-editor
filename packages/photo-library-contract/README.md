# 個人写真ライブラリ contract v1

Epic #148 / P00 #149。型・HTTP binding・合成fixture・機械可読の負例・SDK採用基準の正本。[設計と担当境界](../../docs/architecture/personal-photo-library.md) に仕様判断と後続の実装先を記録する。サーバー・DB・認証・UIの実装は含まない。

```sh
npm -C packages/photo-library-contract ci
npm -C packages/photo-library-contract run check
```

Node 24。runtime dependencyなし。TypeScript sourceを使う契約packageで、単独のHTTPサーバーではない。Web/Mac consumerへの配布はP08でimmutable artifactとhashを固定する。

```ts
import type { PhotoOperationMap } from "@niho/photo-library-contract";
import { responses, readyPhoto, futureRecipePhoto } from "@niho/photo-library-contract/fixtures";

// 各test/hostでcloneし、fixtureの共有オブジェクト自体を書き換えない。
const response: PhotoOperationMap["photos.list"]["response"] = structuredClone(responses["photos.list"]);
```

- `src/v1.ts`: 型、公開上限、20 operationのmethod/path/idempotency、errorとstatus。
- `fixtures/v1.ts`: 本人A/Bのsynthetic ID、quota、派生job作成前のpending/処理中/失敗/ready/trash/未知recipe、uploadの予約/検証/完了、全JSON operationの応答。assetのhash/sizeは**metadata fixture用のダミー**で、実decodeやcontentのchecksum検証には使わない。
- `fixtures/security-cases.json`: 認証・所有権・容量・並行予約・再送・lease・CAS・削除の入力/前提/期待statusとcode。P12がcase IDを実HTTP/DB検証へ接続する。現時点では期待値であり、backendが合格したという記録ではない。
- `sdk-baseline.json`: SDK 0.1.5 / crate 0.27.0 のpublic releaseから取得したmanifestをsha256で照合し、6 tarballとreceiptのhashを固定。P08が取得bytesを検査して採用する。ここにSDK本体をvendorしない。

`content.get` はbyte streamなのでJSON fixtureに含めない。転送テストは権利安全なメモリ生成画像を独自に用意し、このpackageのID・状態・期待errorを共用する。成功fixtureのHEIC/RAW capabilityは完成後のUIを作るための合成値で、本番のprovider対応を証明しない。

契約はowner由来・容量・原本不変・CASをクライアントへ説明するが、権限は与えない。`VerifiedPhotoActor` はserver-only接続口。body/queryのowner指定や、既存拠点用 `niho-cloud-contract` のIDをこの本人用契約へ読み替えない。
