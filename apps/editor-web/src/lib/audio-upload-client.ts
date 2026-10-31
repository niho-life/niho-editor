/**
 * ブラウザから録音の音声をアップロードする関数（#36 段 2a の薄い関数と、段 3b-1 の画面から呼ぶ一続きの流れ）。
 * 流れ: getAudioLimits（上限を出す）→ startAudioUpload（録音ページと ticket）→ putAudio（ticket の url へ直接 PUT。保存先は
 * 本番では GCS、開発では同じ origin の偽物）→ completeAudioUpload（大きさを確かめて uploaded にする）。
 * 画面は `uploadAudioFile` を呼ぶ（上限の確認 → 事前検査 → sha256 → 開始 → XHR の PUT（進み具合・中止）→ 完了）。
 *
 * - sha256 は申告値（サーバーは検証しない）。2 GiB まであるので、自前の逐次の SHA-256 で 4 MiB ずつ計算する（file-sha256.ts）。
 * - ticket の url は持っている人がアップロードできる値なので、ログ・保存・送信・画面の文言・例外の文言に使わない。
 * - API の呼び出しは同じ origin（cookie・token はここでは扱わない）。PUT は credentials を付けない（保存先は別の origin）。
 * - 再開（resumable の続き）は作らない。PUT が失敗したら、同じ Idempotency-Key で始め直す（同じ録音ページに新しい ticket）。
 */
import { contentTypeForAudio, extensionOfName, isSafeAudioName } from "./audio-formats";
import { fileSha256 } from "./file-sha256";

export type AudioLimits = {
  maxBytes: number;
  maxDurationSec: number;
  retentionDays: number;
  extensions: string[];
  contentTypes: string[];
};

export type AudioUploadTicket = {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
  /** 申告の大きさ（この大きさを PUT する）。 */
  maxBytes: number;
};

export type AudioStartRequest = {
  name: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  lang?: "ja" | "en";
  durationSec?: number;
};

/** 開始の結果。`upload` が null なら既に済んでいる（同じ Idempotency-Key の再送）。録音は GET の応答と同じ形。 */
export type AudioStartResponse = {
  status: 200 | 201;
  page: { id: string; kind: "rec"; title: string; lang: "ja" | "en"; createdAt: string; updatedAt: string };
  recording: Record<string, unknown> & { audio: { status: "uploading" | "uploaded"; bytes: number; contentType: string; expiresAt: string | null } | null };
  speakers: unknown[];
  upload: AudioUploadTicket | null;
};

export type AudioCompleteResponse = { recording: AudioStartResponse["recording"]; speakers: unknown[] };

/** 音声 1 本（#36 段 3b-4。応答の形。保存先の場所・資産の id は入らない）。 */
export type AudioPartView = {
  partIndex: number;
  status: "uploading" | "uploaded";
  bytes: number;
  contentType: string;
  durationSec: number | null;
  /** 文字起こしをずらす量（秒）。 */
  offsetSec: number;
  sourceName: string | null;
  expiresAt: string | null;
};

/** 2 本目以降の音声の開始の結果（`upload` が null なら既に済んでいる）。 */
export type AudioPartStartResponse = { status: 200 | 201; part: AudioPartView; parts: AudioPartView[]; upload: AudioUploadTicket | null };
export type AudioPartCompleteResponse = { part: AudioPartView; parts: AudioPartView[] };

/** API の失敗。`error` と `reason` はサーバーの短い code（`bad_request`・`too_large`・`incomplete`・`size_mismatch` など）。 */
export class AudioUploadError extends Error {
  override readonly name = "AudioUploadError";
  constructor(
    readonly status: number,
    readonly error: string | null = null,
    readonly reason: string | null = null,
  ) {
    super(`audio upload failed with ${status}${error ? ` (${error}${reason ? `: ${reason}` : ""})` : ""}`);
  }
}

type FetchLike = typeof fetch;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function failure(response: Response): Promise<AudioUploadError> {
  const body = await readJson(response);
  const error = isPlainObject(body) && typeof body.error === "string" ? body.error : null;
  const reason = isPlainObject(body) && typeof body.reason === "string" ? body.reason : null;
  return new AudioUploadError(response.status, error, reason);
}

function isTicket(value: unknown): value is AudioUploadTicket {
  if (!isPlainObject(value) || value.method !== "PUT" || typeof value.url !== "string" || typeof value.expiresAt !== "string") return false;
  if (typeof value.maxBytes !== "number" || !isPlainObject(value.headers)) return false;
  return Object.values(value.headers).every((header) => typeof header === "string");
}

/** 上限と受け付ける形式。 */
export async function getAudioLimits(fetchImpl: FetchLike = fetch): Promise<AudioLimits> {
  const response = await fetchImpl("/api/recordings/audio/limits", { method: "GET", credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw await failure(response);
  const body = await readJson(response);
  if (
    !isPlainObject(body) ||
    typeof body.maxBytes !== "number" ||
    typeof body.maxDurationSec !== "number" ||
    typeof body.retentionDays !== "number" ||
    !Array.isArray(body.extensions) ||
    !Array.isArray(body.contentTypes)
  ) {
    throw new AudioUploadError(500);
  }
  return {
    maxBytes: body.maxBytes,
    maxDurationSec: body.maxDurationSec,
    retentionDays: body.retentionDays,
    extensions: body.extensions.filter((item): item is string => typeof item === "string"),
    contentTypes: body.contentTypes.filter((item): item is string => typeof item === "string"),
  };
}

/** アップロードを始める。同じファイルの再送には同じ idempotencyKey（UUID）を渡す（同じ録音ページが返る）。 */
export async function startAudioUpload(
  input: AudioStartRequest,
  options: { idempotencyKey?: string; fetch?: FetchLike } = {},
): Promise<AudioStartResponse> {
  const fetchImpl = options.fetch ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.idempotencyKey !== undefined) {
    if (!UUID_PATTERN.test(options.idempotencyKey)) throw new TypeError("idempotencyKey must be a UUID");
    headers["idempotency-key"] = options.idempotencyKey;
  }
  const body: Record<string, unknown> = { name: input.name, contentType: input.contentType, sizeBytes: input.sizeBytes, sha256: input.sha256 };
  if (input.lang !== undefined) body.lang = input.lang;
  if (input.durationSec !== undefined) body.durationSec = input.durationSec;
  const response = await fetchImpl("/api/recordings/audio/start", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status !== 200 && response.status !== 201) throw await failure(response);
  const data = await readJson(response);
  if (!isPlainObject(data) || !isPlainObject(data.page) || typeof data.page.id !== "string" || !isPlainObject(data.recording)) {
    throw new AudioUploadError(500);
  }
  if (data.upload !== null && !isTicket(data.upload)) throw new AudioUploadError(500);
  return {
    status: response.status as 200 | 201,
    page: data.page as AudioStartResponse["page"],
    recording: data.recording as AudioStartResponse["recording"],
    speakers: Array.isArray(data.speakers) ? data.speakers : [],
    upload: data.upload as AudioUploadTicket | null,
  };
}

function isPartView(value: unknown): value is AudioPartView {
  if (!isPlainObject(value)) return false;
  const { partIndex, status, bytes, contentType, offsetSec } = value;
  return (
    typeof partIndex === "number" &&
    Number.isSafeInteger(partIndex) &&
    partIndex >= 0 &&
    (status === "uploading" || status === "uploaded") &&
    typeof bytes === "number" &&
    typeof contentType === "string" &&
    typeof offsetSec === "number"
  );
}

function partsOf(value: unknown): AudioPartView[] {
  return Array.isArray(value) ? value.filter(isPartView) : [];
}

/** 2 本目以降の音声のアップロードを始める（#36 段 3b-4。録音ページは作らない）。 */
export async function startAudioPartUpload(
  pageId: string,
  input: AudioStartRequest,
  options: { idempotencyKey?: string; fetch?: FetchLike } = {},
): Promise<AudioPartStartResponse> {
  const fetchImpl = options.fetch ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.idempotencyKey !== undefined) {
    if (!UUID_PATTERN.test(options.idempotencyKey)) throw new TypeError("idempotencyKey must be a UUID");
    headers["idempotency-key"] = options.idempotencyKey;
  }
  const body: Record<string, unknown> = { name: input.name, contentType: input.contentType, sizeBytes: input.sizeBytes, sha256: input.sha256 };
  // 言語はページのもの（2 本目以降は送らない）
  if (input.durationSec !== undefined) body.durationSec = input.durationSec;
  const response = await fetchImpl(`/api/pages/${encodeURIComponent(pageId)}/recording/audio/parts`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status !== 200 && response.status !== 201) throw await failure(response);
  const data = await readJson(response);
  if (!isPlainObject(data) || !isPartView(data.part)) throw new AudioUploadError(500);
  if (data.upload !== null && !isTicket(data.upload)) throw new AudioUploadError(500);
  return { status: response.status as 200 | 201, part: data.part, parts: partsOf(data.parts), upload: data.upload as AudioUploadTicket | null };
}

/** 2 本目以降の音声のアップロードの完了。 */
export async function completeAudioPartUpload(pageId: string, partIndex: number, fetchImpl: FetchLike = fetch): Promise<AudioPartCompleteResponse> {
  const response = await fetchImpl(`/api/pages/${encodeURIComponent(pageId)}/recording/audio/parts/${partIndex}/complete`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw await failure(response);
  const data = await readJson(response);
  if (!isPlainObject(data) || !isPartView(data.part)) throw new AudioUploadError(500);
  return { part: data.part, parts: partsOf(data.parts) };
}

/**
 * アップロードが済んでいない 2 本目以降の音声を取り除く（途中でやめた取り込みの行が、その録音の文字起こしを止め続けないように）。
 * 済んでいる音声は 409（not_unfinished）で消えない。残った音声の列を返す。
 */
export async function discardAudioPartUpload(pageId: string, partIndex: number, fetchImpl: FetchLike = fetch): Promise<AudioPartView[]> {
  const response = await fetchImpl(`/api/pages/${encodeURIComponent(pageId)}/recording/audio/parts/${partIndex}`, {
    method: "DELETE",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw await failure(response);
  const data = await readJson(response);
  if (!isPlainObject(data)) throw new AudioUploadError(500);
  return partsOf(data.parts);
}

/** ticket の url へ音声を直接 PUT する。412（既に置いてある）は成功と同じに扱い、続けて完了を呼べばよい。 */
export async function putAudio(ticket: AudioUploadTicket, body: Blob, fetchImpl: FetchLike = fetch): Promise<void> {
  const response = await fetchImpl(ticket.url, { method: "PUT", headers: { ...ticket.headers }, body, credentials: "omit", cache: "no-store" });
  await response.body?.cancel().catch(() => undefined);
  if (response.ok || response.status === 412) return;
  // 保存先の応答の本文は読まない（中身を出さない）
  throw new AudioUploadError(response.status);
}

/** アップロードの完了。保存先に無い・大きさが違うは AudioUploadError（409、reason が missing・size_mismatch）。 */
export async function completeAudioUpload(pageId: string, fetchImpl: FetchLike = fetch): Promise<AudioCompleteResponse> {
  const response = await fetchImpl(`/api/pages/${encodeURIComponent(pageId)}/recording/audio/complete`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw await failure(response);
  const data = await readJson(response);
  if (!isPlainObject(data) || !isPlainObject(data.recording)) throw new AudioUploadError(500);
  return { recording: data.recording as AudioCompleteResponse["recording"], speakers: Array.isArray(data.speakers) ? data.speakers : [] };
}

// ---- 画面から呼ぶ一続きの流れ（#36 段 3b-1） ----

/** XMLHttpRequest のうち、PUT に使う部分（テストで偽物に替える）。 */
export type XhrLike = {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob): void;
  abort(): void;
  readonly status: number;
  withCredentials: boolean;
  upload: { onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  ontimeout: (() => void) | null;
};

function abortError(): DOMException {
  return new DOMException("The upload was aborted.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException ? error.name === "AbortError" : typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/**
 * ticket の url へ XMLHttpRequest で PUT する（upload の進み具合と中止のため。fetch には upload の進行が無い）。
 * credentials なし、ticket の headers を付ける。2xx と 412（既に置いてある）は成功。つながらない・CORS で断られた・時間切れは
 * AudioUploadError（status 0、error が network・timeout）、それ以外の状態は AudioUploadError(status)。中止は AbortError。
 * 応答の本文は読まない（保存先の中身を出さない）。
 */
export function putAudioWithProgress(
  ticket: AudioUploadTicket,
  body: Blob,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal; createXhr?: () => XhrLike } = {},
): Promise<void> {
  const { onProgress, signal } = options;
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const xhr = options.createXhr ? options.createXhr() : (new XMLHttpRequest() as unknown as XhrLike);
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = () => {
      xhr.abort();
      finish(abortError());
    };
    xhr.open("PUT", ticket.url);
    xhr.withCredentials = false;
    for (const [name, value] of Object.entries(ticket.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable && event.total > 0 ? event.total : body.size;
      if (total > 0) onProgress?.(Math.min(1, event.loaded / total));
    };
    xhr.onload = () => {
      const { status } = xhr;
      if ((status >= 200 && status < 300) || status === 412) {
        onProgress?.(1);
        finish();
      } else {
        finish(new AudioUploadError(status));
      }
    };
    xhr.onerror = () => finish(new AudioUploadError(0, "network"));
    xhr.ontimeout = () => finish(new AudioUploadError(0, "timeout"));
    xhr.onabort = () => finish(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    xhr.send(body);
  });
}

/** 画面が表す段階。 */
export type AudioUploadStage = "hashing" | "starting" | "uploading" | "completing";
export type AudioUploadProgress = { stage: AudioUploadStage; /** 段階の中の割合（0〜1。割合の無い段階は 0）。 */ fraction: number };

/**
 * 取り込みの失敗の理由（画面の文言は audioUploadMessage）。
 * format=形式が違う・too_large=大きすぎる・too_long=長すぎる・empty=空・name=名前が使えない・unreadable=読めない・
 * network=保存先へ送れない（CORS を含む）・connection=サーバーにつながらない・unavailable=保存先が使えない（503・502）・
 * incomplete=最後まで届いていない（完了の 409）・unauthorized=ログインが切れた（401）・aborted=中止した・other=その他。
 */
export type AudioUploadFailureKind =
  | "format"
  | "too_large"
  | "too_long"
  | "empty"
  | "name"
  | "unreadable"
  | "network"
  | "connection"
  | "unavailable"
  | "incomplete"
  | "unauthorized"
  | "aborted"
  | "other";

/** 取り込みの失敗。文言（message）は理由の code だけで、URL・token・サーバーの本文を含めない。 */
export class AudioUploadFailure extends Error {
  override readonly name = "AudioUploadFailure";
  constructor(readonly kind: AudioUploadFailureKind) {
    super(`audio upload failed: ${kind}`);
  }
}

export type AudioFileCheck =
  | { ok: true; extension: string; contentType: string; durationSec: number | undefined }
  | { ok: false; kind: Extract<AudioUploadFailureKind, "format" | "too_large" | "too_long" | "empty" | "name"> };

/**
 * 送る前の検査（server の validateAudioStart と同じ順と規則）: 名前 → 拡張子（上限の一覧にあるか）→ 種類 → 大きさ → 長さ。
 * 長さは分かるときだけ確かめる（不正な値は送らない）。
 */
export function checkAudioFile(input: { name: string; size: number; type: string; durationSec?: number | null }, limits: AudioLimits): AudioFileCheck {
  if (!isSafeAudioName(input.name)) return { ok: false, kind: "name" };
  const extension = extensionOfName(input.name);
  if (extension === null || !limits.extensions.includes(extension)) return { ok: false, kind: "format" };
  const contentType = contentTypeForAudio(input.name, input.type);
  if (contentType === null || !limits.contentTypes.includes(contentType)) return { ok: false, kind: "format" };
  if (!Number.isSafeInteger(input.size) || input.size < 1) return { ok: false, kind: "empty" };
  if (input.size > limits.maxBytes) return { ok: false, kind: "too_large" };
  const duration = input.durationSec;
  let durationSec: number | undefined;
  if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
    if (duration > limits.maxDurationSec) return { ok: false, kind: "too_long" };
    durationSec = duration;
  }
  return { ok: true, extension, contentType, durationSec };
}

let limitsCache: Promise<AudioLimits> | null = null;

/** 上限（画面の間は覚えておく。失敗したら覚えない）。 */
export function getAudioLimitsCached(fetchImpl: FetchLike = fetch): Promise<AudioLimits> {
  if (!limitsCache) {
    const pending = getAudioLimits(fetchImpl);
    limitsCache = pending;
    pending.catch(() => {
      if (limitsCache === pending) limitsCache = null;
    });
  }
  return limitsCache;
}

/** テスト用: 覚えた上限を捨てる。 */
export function resetAudioLimitsCache(): void {
  limitsCache = null;
}

/** 計算した sha256（同じファイルをもう一度取り込むとき、2 GiB を計算し直さない）。 */
const hashCache = new WeakMap<Blob, string>();

export type UploadAudioFileInput = {
  /** 取り込むファイル（マイクの録音は名前つきの File にして渡す）。 */
  file: Blob & { name: string };
  lang?: "ja" | "en";
  durationSec?: number | null;
  /** 同じファイルの取り込み直しには同じ値（UUID）。無ければ作る。 */
  idempotencyKey?: string;
  onProgress?: (progress: AudioUploadProgress) => void;
  signal?: AbortSignal;
  /** テスト用。 */
  fetch?: FetchLike;
  createXhr?: () => XhrLike;
};

export type UploadAudioFileResult = { page: AudioStartResponse["page"]; recording: AudioStartResponse["recording"]; speakers: unknown[] };

/** API の失敗（AudioUploadError）を理由にする。 */
function failureOfApi(error: AudioUploadError): AudioUploadFailure {
  const { status, reason } = error;
  if (status === 0) return new AudioUploadFailure("connection");
  if (status === 401) return new AudioUploadFailure("unauthorized");
  if (status === 502 || status === 503) return new AudioUploadFailure("unavailable");
  if (status === 409 && error.error === "incomplete") return new AudioUploadFailure("incomplete");
  if (status === 400) {
    if (reason === "too_large") return new AudioUploadFailure("too_large");
    if (reason === "extension" || reason === "content_type") return new AudioUploadFailure("format");
    if (reason === "too_long" || reason === "duration") return new AudioUploadFailure("too_long");
    if (reason === "size") return new AudioUploadFailure("empty");
    if (reason === "name") return new AudioUploadFailure("name");
  }
  return new AudioUploadFailure("other");
}

/** 開始と完了だけが違う 2 つの流れ（録音ページを作る / 2 本目以降の音声を足す）。 */
type UploadSteps<S extends { upload: AudioUploadTicket | null }, C> = {
  start: (request: AudioStartRequest, options: { idempotencyKey: string; fetch: FetchLike }) => Promise<S>;
  complete: (started: S, fetchImpl: FetchLike) => Promise<C>;
};

/**
 * 音声 1 つを保存先へ送る一続きの流れ: 上限の確認 → 事前検査 → sha256 → 開始 → ticket の url へ直接 PUT（進み具合・中止）→ 完了。
 * 段階（hashing → starting → uploading → completing）と割合を onProgress で返す。失敗はすべて AudioUploadFailure
 * （中止は kind が aborted）。送る前に断れるものは、保存先にもサーバーにも何も作らない。
 * `upload` が null（同じキーで既に済んでいる）なら PUT をとばして完了だけ呼ぶ。
 */
async function uploadAudio<S extends { upload: AudioUploadTicket | null }, C>(
  input: UploadAudioFileInput,
  steps: UploadSteps<S, C>,
): Promise<{ started: S; completed: C }> {
  const { file, signal, onProgress } = input;
  const baseFetch = input.fetch ?? fetch;
  // API の呼び出しにも中止を効かせる
  const fetchImpl: FetchLike = (resource, init) => baseFetch(resource, { ...init, ...(signal ? { signal } : {}) });
  const guard = () => {
    if (signal?.aborted) throw new AudioUploadFailure("aborted");
  };
  try {
    guard();
    let limits: AudioLimits;
    try {
      limits = await getAudioLimitsCached(baseFetch);
    } catch (error) {
      throw error instanceof AudioUploadError ? failureOfApi(error) : new AudioUploadFailure("connection");
    }
    guard();
    const check = checkAudioFile({ name: file.name, size: file.size, type: file.type, durationSec: input.durationSec }, limits);
    if (!check.ok) throw new AudioUploadFailure(check.kind);

    onProgress?.({ stage: "hashing", fraction: 0 });
    let sha256 = hashCache.get(file);
    if (sha256 === undefined) {
      try {
        sha256 = await fileSha256(file, { signal, onProgress: (fraction) => onProgress?.({ stage: "hashing", fraction }) });
      } catch (error) {
        throw isAbortError(error) ? new AudioUploadFailure("aborted") : new AudioUploadFailure("unreadable");
      }
      hashCache.set(file, sha256);
    } else {
      onProgress?.({ stage: "hashing", fraction: 1 });
    }
    guard();

    onProgress?.({ stage: "starting", fraction: 0 });
    const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
    const request: AudioStartRequest = { name: file.name, contentType: check.contentType, sizeBytes: file.size, sha256 };
    if (input.lang !== undefined) request.lang = input.lang;
    if (check.durationSec !== undefined) request.durationSec = check.durationSec;
    let started: S;
    try {
      started = await steps.start(request, { idempotencyKey, fetch: fetchImpl });
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw new AudioUploadFailure("aborted");
      throw error instanceof AudioUploadError ? failureOfApi(error) : new AudioUploadFailure("connection");
    }
    guard();

    if (started.upload) {
      onProgress?.({ stage: "uploading", fraction: 0 });
      try {
        await putAudioWithProgress(started.upload, file, {
          signal,
          createXhr: input.createXhr,
          onProgress: (fraction) => onProgress?.({ stage: "uploading", fraction }),
        });
      } catch (error) {
        // 保存先への PUT の失敗は、状態によらず「送れなかった」（CORS で断られたときも、ブラウザは理由を教えない）
        throw isAbortError(error) ? new AudioUploadFailure("aborted") : new AudioUploadFailure("network");
      }
      guard();
    }

    onProgress?.({ stage: "completing", fraction: 0 });
    let completed: C;
    try {
      completed = await steps.complete(started, fetchImpl);
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw new AudioUploadFailure("aborted");
      throw error instanceof AudioUploadError ? failureOfApi(error) : new AudioUploadFailure("connection");
    }
    return { started, completed };
  } catch (error) {
    if (error instanceof AudioUploadFailure) throw error;
    throw new AudioUploadFailure(isAbortError(error) ? "aborted" : "other");
  }
}

/** 音声ファイルを取り込んで録音ページを作る（#36 段 3b-1）。 */
export async function uploadAudioFile(input: UploadAudioFileInput): Promise<UploadAudioFileResult> {
  const { started, completed } = await uploadAudio(input, {
    start: (request, options) => startAudioUpload(request, options),
    complete: (first, fetchImpl) => completeAudioUpload(first.page.id, fetchImpl),
  });
  return { page: started.page, recording: completed.recording, speakers: completed.speakers };
}

export type UploadAudioPartInput = UploadAudioFileInput & { pageId: string };
export type UploadAudioPartResult = AudioPartCompleteResponse;

/**
 * 2 本目以降の音声を、いまの録音ページに足す（#36 段 3b-4）。流れは録音ページを作るときと同じ（開始と完了だけが違う）。
 * 言語はページのものを使う（送らない）。
 */
export async function uploadAudioPart(input: UploadAudioPartInput): Promise<UploadAudioPartResult> {
  const { completed } = await uploadAudio(input, {
    start: (request, options) => startAudioPartUpload(input.pageId, request, options),
    complete: (part, fetchImpl) => completeAudioPartUpload(input.pageId, part.part.partIndex, fetchImpl),
  });
  return completed;
}

function bytesLabel(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

function hoursLabel(seconds: number): string {
  const hours = seconds / 3600;
  return Number.isInteger(hours) ? `${hours} 時間` : `${Math.round(seconds / 60)} 分`;
}

/**
 * 画面に出す上限の案内（設計 §12「1 ファイルの長さと容量の上限を設定に明記」と、クラウドの音声の保持日数）。
 * 上限がまだ読めていなければ空（案内を出さない。数を推測で出さない）。
 */
export function audioLimitsNote(limits: Pick<AudioLimits, "maxBytes" | "maxDurationSec" | "retentionDays"> | null | undefined): string {
  if (!limits) return "";
  return `音声は 1 つ ${hoursLabel(limits.maxDurationSec)}・${bytesLabel(limits.maxBytes)} まで。クラウドの音声は ${limits.retentionDays} 日で消えます（文字起こしは残ります）`;
}

/** 失敗を、画面に出す日本語の短い文言にする（URL・内部の情報を含めない）。上限は分かれば添える。 */
export function audioUploadMessage(kind: AudioUploadFailureKind, limits?: Pick<AudioLimits, "maxBytes" | "maxDurationSec" | "extensions"> | null): string {
  switch (kind) {
    case "format":
      return limits
        ? `この形式は取り込めません。${limits.extensions.map((extension) => `.${extension}`).join(" ")} の音声ファイルを選んでください。`
        : "この形式は取り込めません。音声ファイルを選んでください。";
    case "too_large":
      return limits ? `ファイルが大きすぎます。音声は ${bytesLabel(limits.maxBytes)} までです。` : "ファイルが大きすぎます。";
    case "too_long":
      return limits ? `録音が長すぎます。${hoursLabel(limits.maxDurationSec)}までです。` : "録音が長すぎます。";
    case "empty":
      return "ファイルが空です。音声の入ったファイルを選んでください。";
    case "name":
      return "ファイル名が使えません。ファイル名を変えて、もう一度選んでください。";
    case "unreadable":
      return "ファイルを読み込めませんでした。選び直してください。";
    case "network":
      return "音声を送れませんでした。ネットワークを確かめて、もう一度試してください。";
    case "connection":
      return "つながりませんでした。ネットワークを確かめて、もう一度試してください。";
    case "unavailable":
      return "いまは音声を取り込めません。少ししてから、もう一度試してください。";
    case "incomplete":
      return "音声が最後まで届きませんでした。もう一度試してください。";
    case "unauthorized":
      return "ログインが切れました。ログインし直してください。";
    case "aborted":
      return "取り込みを中止しました。";
    default:
      return "うまくいきませんでした。もう一度試してください。";
  }
}
