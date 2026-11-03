/**
 * 資産の保存先（private bucket）の接続口。音声（#36）と画像（#33）が同じ口を使う。
 *
 * アップロードでサーバーは中身を受け取らない: 「開始」で保存先のアップロードのセッションを作ってブラウザに渡し
 * （ブラウザが保存先へ直接 PUT する）、「完了」で object の大きさを確かめるだけ。削除と上書きはしない
 * （実行 ID の権限が作成と閲覧だけ。期限での削除は bucket の規則）。
 *
 * 読み取り（readObject）だけは中身を通す: 画像（#33）はサーバーが中継し（`/api/assets/{id}`・共有は `/s/{token}/a/{id}`）、
 * 署名付き GET URL をブラウザへ渡さない。
 *
 * 秘密の扱い: ticket の url は持っている人がアップロードできる値（bearer）。応答で本人に渡すだけで、ログ・エラー・DB に書かない。
 * StorageError のメッセージには bucket 名・object の場所・token・URL を入れない（固定の文だけ）。
 */

/** ブラウザが保存先へ直接アップロードするための情報。 */
export type UploadTicket = {
  /** アップロード先（持っている人が PUT できる。ログに出さない）。 */
  url: string;
  method: "PUT";
  /** PUT に付ける header。 */
  headers: Record<string, string>;
  /** url が使えなくなる見込みの時刻（ISO 8601）。 */
  expiresAt: string;
};

export type StartUploadInput = {
  /** bucket の中の場所（`audio/{asset id}` など。OBJECT_PATH_PATTERN の形だけ）。 */
  objectPath: string;
  contentType: string;
  /** アップロードする大きさ（バイト。保存先はこの大きさを超える PUT を断る）。 */
  sizeBytes: number;
  /** editor の画面の origin（保存先の CORS がこの origin からの PUT を通す）。分からなければ null。 */
  origin: string | null;
};

/** 保存先にある object（無ければ null）。 */
export type StoredObject = { sizeBytes: number; contentType: string | null; /** immutable object generation, when the backend provides one */ generation?: string };

export type CopyObjectInput = {
  sourceObjectPath: string;
  targetObjectPath: string;
  /** 再送時は初回が固定した source generation。同じ object 名の別世代へ追随しない。 */
  sourceGeneration: string;
};

export type CopiedObject = StoredObject & { sourceGeneration: string };

/** 読み出す範囲（バイト。start も end も含む。0 ≤ start ≤ end の整数）。 */
export type ByteRange = { start: number; end: number };

/**
 * 保存先から読み出した object（中身は 1 回だけ読める流れ。読み終えるか cancel する。読まずに捨てると保存先との接続が残る）。
 * 画像（#33）の中継と、文字起こし（#36 段 2b。サーバーが音声をエンジンへ流す）と、録音の再生（#36 段 3b-2。範囲つき）が使う。
 * 中身はログ・エラー・DB に書かない。
 */
export type ReadObject = {
  body: ReadableStream<Uint8Array>;
  contentType: string | null;
  /** body の大きさ（範囲を読んだときは、返した範囲の大きさ）。 */
  sizeBytes: number;
  /**
   * 範囲を求めたときだけ: 返した範囲。終わりは object の終わりで切る。保存先が範囲を無視して全体を返したときは全体の範囲
   * （求めた範囲と違うことがあるので、呼び出し側が見分ける）。
   */
  range?: ByteRange;
  /** 範囲を求めたときだけ: object 全体の大きさ。 */
  totalBytes?: number;
};

export type ReadObjectOptions = {
  /** 渡すとその範囲だけを読む（始まりが object の大きさ以上なら StorageError の range_not_satisfiable）。 */
  range?: ByteRange;
};

export interface ObjectStorage {
  readonly kind: "fake" | "gcs";
  /** アップロードのセッションを作る。同じ場所に object が既にあれば上書きしない（保存先が断る）。 */
  startUpload(input: StartUploadInput): Promise<UploadTicket>;
  /** object の大きさと種類。無ければ null。 */
  stat(objectPath: string): Promise<StoredObject | null>;
  /** source generation 固定・destination generation=0 で非上書き copy する。 */
  copyObject?(input: CopyObjectInput): Promise<CopiedObject>;
  /**
   * object の中身を読む（画像の中継・音声の再生。無ければ null）。範囲を渡さなければ全体（今までどおり）。
   * 応答の流れをそのまま返すので、呼び出し側は返した body を読み切るか cancel する。
   */
  readObject(objectPath: string, options?: ReadObjectOptions): Promise<ReadObject | null>;
}

/**
 * unavailable: 保存先に届かない・権限・一時的な失敗 / rejected: 保存先が要求を断った（形・既にある・大きさ）/
 * range_not_satisfiable: 範囲の始まりが object の大きさ以上（範囲を求めたときだけ）。
 */
export type StorageErrorCode = "unavailable" | "rejected" | "range_not_satisfiable";

const MESSAGES: Record<StorageErrorCode, string> = {
  unavailable: "editor-web: object storage is unavailable",
  rejected: "editor-web: object storage rejected the request",
  range_not_satisfiable: "editor-web: object storage cannot serve the range",
};

/** 範囲として正しい形か（整数・0 ≤ start ≤ end）。 */
export function isByteRange(value: unknown): value is ByteRange {
  if (typeof value !== "object" || value === null) return false;
  const { start, end } = value as { start?: unknown; end?: unknown };
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && (start as number) >= 0 && (start as number) <= (end as number);
}

/** 保存先の失敗。メッセージは code ごとの固定の文だけ（bucket 名・場所・token・URL を含めない）。 */
export class StorageError extends Error {
  override readonly name = "StorageError";
  readonly code: StorageErrorCode;
  constructor(code: StorageErrorCode) {
    super(MESSAGES[code]);
    this.code = code;
  }
}

/**
 * object の場所の形: `{種類}/{名前}`（種類は小文字の英字・数字・`-`、名前は英数字・`_`・`-`。`.` と `/` を含まない＝親へ上がれない）。
 * 音声は `audio/{asset id}`、画像は `image/{asset id}`。
 */
export const OBJECT_PATH_PATTERN = /^[a-z][a-z0-9-]{0,31}\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isObjectPath(value: unknown): value is string {
  return typeof value === "string" && OBJECT_PATH_PATTERN.test(value);
}
