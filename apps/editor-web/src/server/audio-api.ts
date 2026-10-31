import { randomUUID } from "node:crypto";
import {
  audioObjectPath,
  type AudioInfo,
  type AudioPart,
  type CompleteAudioPartResult,
  type CompleteAudioUploadResult,
  type DiscardAudioPartResult,
  type OwnerId,
  type Recording,
  type StartAudioPartInput,
  type StartAudioPartResult,
  type StartAudioRecordingInput,
  type StartAudioRecordingResult,
} from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { AUDIO_RETENTION_DAYS, audioLimits, audioRequestHash, validateAudioStart, type AudioStartRejection } from "../recording/audio-limits";
import { StorageError, type ObjectStorage, type StoredObject, type UploadTicket } from "../storage/types";
import { errorResponse, expectedOrigin, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";
import { withSpeakers } from "./recordings-api";

/**
 * 録音の音声のアップロード（#36 段 2a・段 3b-4）の API: 上限の取得・開始・完了と、**2 本目以降の音声を足す**（parts）。
 *
 * - 開始: 要求を検査し（上限を超えたら保存の前に断る）、保存先のアップロードのセッションを作ってから、録音ページ・音声の資産・録音
 *   （状態 uploading）を作る。ブラウザは返した ticket の url へ直接 PUT する（サーバーは音声を受け取らない）。
 * - 完了: 保存先にある object の大きさが申告どおりなら uploaded にする。
 * 作法は録音の API（recordings-api.ts）と同じ: 本人の・ゴミ箱でないページだけ、未認証 401、更新系は同じ origin からだけ（403）、
 * 別の人・存在しない・不正な id・削除済み・音声の無いページは同じ 404、エラーの本文は短い code と理由だけ。
 * ticket の url（持っている人がアップロードできる）・bucket 名・object の場所はログにもエラーにも出さない。
 * sha256・content type・大きさ・長さはクライアントの申告（サーバーは音声を読まず、sha256 を検証しない）。
 */

/** 音声の API が使う store の操作（packages/editor-store の関数に Pool を渡したもの）。null はページ（音声）が無い。 */
export type AudioStore = {
  startAudioRecording: (owner: OwnerId, input: StartAudioRecordingInput) => Promise<StartAudioRecordingResult>;
  completeAudioUpload: (owner: OwnerId, pageId: string, stored: { sizeBytes: number }) => Promise<CompleteAudioUploadResult | null>;
  audioInfo: (owner: OwnerId, pageId: string) => Promise<AudioInfo | null>;
  getRecording: (owner: OwnerId, pageId: string) => Promise<Recording | null>;
  /** 2 本目以降の音声（#36 段 3b-4）。 */
  startAudioPart: (owner: OwnerId, pageId: string, input: StartAudioPartInput) => Promise<StartAudioPartResult | null>;
  completeAudioPart: (owner: OwnerId, pageId: string, partIndex: number, stored: { sizeBytes: number }) => Promise<CompleteAudioPartResult | null>;
  listAudioParts: (owner: OwnerId, pageId: string) => Promise<AudioPart[]>;
  /** アップロードが済んでいない音声を取り除く（やめた取り込みが文字起こしを止め続けない）。null は無い番号・ページ。 */
  discardAudioPart: (owner: OwnerId, pageId: string, partIndex: number) => Promise<DiscardAudioPartResult | null>;
};

export type AudioApiDeps = {
  auth: () => AuthProvider;
  /** DB が使えないときは null（503 unavailable）。 */
  store: () => AudioStore | null;
  /** 保存先が使えないときは null（503 storage_unavailable）。 */
  storage: () => ObjectStorage | null;
  env?: Readonly<Record<string, string | undefined>>;
  /** 資産の id を作る（テストで差し替える）。 */
  newAssetId?: () => string;
};

/** 開始の要求の本文の上限（名前・種類・大きさ・ハッシュ・言語・長さだけなので小さい）。超えたら 413。 */
export const AUDIO_START_BODY_MAX_BYTES = 16 * 1024;

const START_KEYS = ["name", "contentType", "sizeBytes", "sha256", "lang", "durationSec"] as const;
/** 2 本目以降は言語を持たない（ページの言語を使う）。 */
const PART_START_KEYS = ["name", "contentType", "sizeBytes", "sha256", "durationSec"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AudioBadRequestReason = "body" | "idempotency_key" | AudioStartRejection;

type AudioErrorCode = "storage_unavailable" | "storage_failed" | "idempotency_conflict" | "incomplete" | "too_many_audios" | "not_unfinished";

const AUDIO_STATUS: Record<AudioErrorCode, number> = {
  // 1 ページに持てる音声の本数を超えた（#36 段 3b-4）
  too_many_audios: 409,
  // 保存先を使わない設定（off・本番の fake・設定の誤り）
  storage_unavailable: 503,
  // 保存先が失敗した・断った（中身は出さない）
  storage_failed: 502,
  // 同じ Idempotency-Key で内容の違う要求（またはそのキーのページがゴミ箱にある）
  idempotency_conflict: 409,
  // 完了を呼んだが、保存先に object が無い（missing）か大きさが申告と違う（size_mismatch）
  incomplete: 409,
  // 取り除こうとした音声は、もうアップロードが済んでいる（済んだ音声は消さない）
  not_unfinished: 409,
};

/** http.ts に無い音声の code。header は他の応答と同じ（jsonResponse）。 */
function audioError(code: AudioErrorCode, reason?: "missing" | "size_mismatch"): Response {
  return jsonResponse(AUDIO_STATUS[code], reason ? { error: code, reason } : { error: code });
}

function badRequest(reason: AudioBadRequestReason): Response {
  return jsonResponse(400, { error: "bad_request", reason });
}

/**
 * 想定外の失敗は 500 の汎用エラー（内部の情報は応答に出さず、ログにも名前と code だけを書く。URL・token・場所を出さない）。
 * recordings-api.ts の guarded と同じ。保存先の失敗（StorageError）は 502 storage_failed。
 */
async function guarded(route: string, handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof StorageError) {
      console.error("editor-web: object storage failed", { route, code: error.code });
      return audioError("storage_failed");
    }
    const name = error instanceof Error ? error.name : "unknown";
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
    console.error("editor-web: request failed", { route, name, code });
    return errorResponse("internal");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 応答に載せる ticket（決まった項目だけ）。maxBytes は申告の大きさ（保存先はこれを超える PUT を断る。完了で一致を確かめる）。 */
function uploadBody(ticket: UploadTicket, sizeBytes: number) {
  return { url: ticket.url, method: ticket.method, headers: { ...ticket.headers }, expiresAt: ticket.expiresAt, maxBytes: sizeBytes };
}

/** GET /api/recordings/audio/limits — 上限と受け付ける形式（画面に出す）。 */
export function audioLimitsRoute(request: Request, deps: Pick<AudioApiDeps, "auth">): Promise<Response> {
  return guarded("GET /api/recordings/audio/limits", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    return jsonResponse(200, audioLimits());
  });
}

/**
 * POST /api/recordings/audio/start — 音声のアップロードを始める。
 * 201 `{ page, recording, upload }`。同じ Idempotency-Key・同じ内容の再送は 200 で同じページ（uploading なら ticket を作り直す。
 * uploaded なら upload: null）。同じキーで内容が違えば 409 idempotency_conflict。
 */
export function startAudioRoute(request: Request, deps: AudioApiDeps): Promise<Response> {
  return guarded("POST /api/recordings/audio/start", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const storage = deps.storage();
    if (!storage) return audioError("storage_unavailable");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");

    const body = await readJsonBody(request, AUDIO_START_BODY_MAX_BYTES);
    if (!body.ok) return body.response.status === 400 ? badRequest("body") : body.response;
    const value = body.value;
    if (!isPlainObject(value) || !Object.keys(value).every((key) => (START_KEYS as readonly string[]).includes(key))) return badRequest("body");
    const rawKey = request.headers.get("idempotency-key");
    if (rawKey !== null && !UUID.test(rawKey.trim())) return badRequest("idempotency_key");
    const uploadKey = rawKey === null ? null : rawKey.trim().toLowerCase();

    const checked = validateAudioStart({
      name: value.name,
      contentType: value.contentType,
      sizeBytes: value.sizeBytes,
      sha256: value.sha256,
      lang: value.lang,
      durationSec: value.durationSec,
    });
    if (!checked.ok) return badRequest(checked.reason);
    const start = checked.value;

    const assetId = (deps.newAssetId ?? randomUUID)();
    const origin = expectedOrigin(request, deps.env);
    // 先に保存先のセッションを作る（失敗したら何も書かない。作ったまま使われないセッションは object を作らない）
    const ticket = await storage.startUpload({ objectPath: audioObjectPath(assetId), contentType: start.contentType, sizeBytes: start.sizeBytes, origin });
    // owner は認証の層の本人だけ（要求の値からは決めない）
    const started = await store.startAudioRecording(session.userId, {
      assetId,
      title: start.title,
      lang: start.lang,
      sourceName: start.name,
      contentType: start.contentType,
      bytes: start.sizeBytes,
      sha256: start.sha256,
      durationSec: start.durationSec,
      uploadKey,
      requestHash: audioRequestHash(start),
      retentionDays: AUDIO_RETENTION_DAYS,
    });
    if (started.status === "conflict") return audioError("idempotency_conflict");
    if (started.status === "created") {
      return jsonResponse(201, { page: started.page, ...withSpeakers(started.recording), upload: uploadBody(ticket, start.sizeBytes) });
    }
    // 同じキー・同じ内容の再送: 先に作った録音を返す。まだアップロード中なら、その資産の場所に ticket を作り直す
    const audio = started.recording.audio;
    let upload: ReturnType<typeof uploadBody> | null = null;
    if (audio?.status === "uploading") {
      const again = await storage.startUpload({ objectPath: audioObjectPath(started.assetId), contentType: audio.contentType, sizeBytes: audio.bytes, origin });
      upload = uploadBody(again, audio.bytes);
    }
    return jsonResponse(200, { page: started.page, ...withSpeakers(started.recording), upload });
  });
}

/**
 * POST /api/pages/{id}/recording/audio/complete — アップロードの完了。保存先の object の大きさが申告どおりなら uploaded にする。
 * 200 `{ recording, speakers }`（GET と同じ形）。済んでいればそのまま 200。object が無い・大きさが違うは 409 incomplete。
 */
export function completeAudioRoute(request: Request, id: string, deps: AudioApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/recording/audio/complete", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const storage = deps.storage();
    if (!storage) return audioError("storage_unavailable");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");

    const info = await store.audioInfo(session.userId, id);
    if (!info) return notFoundResponse();
    if (info.status === "uploaded") {
      // 済んだものは保存先に問い合わせない（期限で消えた後も、済んだ記録は済んだまま）
      const recording = await store.getRecording(session.userId, id);
      return recording ? jsonResponse(200, withSpeakers(recording)) : notFoundResponse();
    }
    const stored: StoredObject | null = await storage.stat(info.objectPath);
    if (!stored) return audioError("incomplete", "missing");
    const result = await store.completeAudioUpload(session.userId, id, { sizeBytes: stored.sizeBytes });
    if (!result) return notFoundResponse();
    if (result.status === "size_mismatch") return audioError("incomplete", "size_mismatch");
    return jsonResponse(200, withSpeakers(result.recording));
  });
}

// ---------------------------------------------------------------------------
// 2 本目以降の音声（#36 段 3b-4）。part 0 は上の開始・完了のまま。

/** 応答に載せる音声 1 本（保存先の場所・資産の id は出さない）。 */
export function audioPartBody(part: AudioPart) {
  return {
    partIndex: part.partIndex,
    status: part.status,
    bytes: part.bytes,
    contentType: part.contentType,
    durationSec: part.durationSec,
    offsetSec: part.offsetSec,
    sourceName: part.sourceName,
    expiresAt: part.expiresAt,
  };
}

/**
 * POST /api/pages/{id}/recording/audio/parts — 2 本目以降の音声のアップロードを始める。
 * 201 `{ part, parts, upload }`。同じ Idempotency-Key・同じ内容の再送は 200 で同じ音声（まだアップロード中なら ticket を作り直す）。
 * 同じキーで内容が違えば 409 idempotency_conflict、本数の上限は 409 too_many_audios、録音が無ければ 404。
 */
export function startAudioPartRoute(request: Request, id: string, deps: AudioApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/recording/audio/parts", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const storage = deps.storage();
    if (!storage) return audioError("storage_unavailable");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");

    const body = await readJsonBody(request, AUDIO_START_BODY_MAX_BYTES);
    if (!body.ok) return body.response.status === 400 ? badRequest("body") : body.response;
    const value = body.value;
    if (!isPlainObject(value) || !Object.keys(value).every((key) => (PART_START_KEYS as readonly string[]).includes(key))) return badRequest("body");
    const rawKey = request.headers.get("idempotency-key");
    if (rawKey !== null && !UUID.test(rawKey.trim())) return badRequest("idempotency_key");
    const uploadKey = rawKey === null ? null : rawKey.trim().toLowerCase();

    const checked = validateAudioStart({ name: value.name, contentType: value.contentType, sizeBytes: value.sizeBytes, sha256: value.sha256, durationSec: value.durationSec });
    if (!checked.ok) return badRequest(checked.reason);
    const start = checked.value;

    const assetId = (deps.newAssetId ?? randomUUID)();
    const origin = expectedOrigin(request, deps.env);
    // 先に保存先のセッションを作る（失敗したら何も書かない）
    const ticket = await storage.startUpload({ objectPath: audioObjectPath(assetId), contentType: start.contentType, sizeBytes: start.sizeBytes, origin });
    // owner は認証の層の本人だけ（要求の値からは決めない）
    const started = await store.startAudioPart(session.userId, id, {
      assetId,
      sourceName: start.name,
      contentType: start.contentType,
      bytes: start.sizeBytes,
      sha256: start.sha256,
      durationSec: start.durationSec,
      uploadKey,
      requestHash: audioRequestHash(start),
      retentionDays: AUDIO_RETENTION_DAYS,
    });
    if (!started) return notFoundResponse();
    if (started.status === "conflict") return audioError("idempotency_conflict");
    if (started.status === "too_many") return audioError("too_many_audios");
    const parts = await store.listAudioParts(session.userId, id);
    if (started.status === "created") {
      return jsonResponse(201, { part: audioPartBody(started.part), parts: parts.map(audioPartBody), upload: uploadBody(ticket, start.sizeBytes) });
    }
    // 同じキー・同じ内容の再送: まだアップロード中なら、その資産の場所に ticket を作り直す
    let upload: ReturnType<typeof uploadBody> | null = null;
    if (started.part.status === "uploading") {
      const again = await storage.startUpload({ objectPath: started.part.objectPath, contentType: started.part.contentType, sizeBytes: started.part.bytes, origin });
      upload = uploadBody(again, started.part.bytes);
    }
    return jsonResponse(200, { part: audioPartBody(started.part), parts: parts.map(audioPartBody), upload });
  });
}

/**
 * POST /api/pages/{id}/recording/audio/parts/{index}/complete — 2 本目以降のアップロードの完了。
 * 200 `{ part, parts }`。object が無い・大きさが違うは 409 incomplete。無い番号・録音の無いページは同じ 404。
 */
export function completeAudioPartRoute(request: Request, id: string, index: string, deps: AudioApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/recording/audio/parts/[index]/complete", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const storage = deps.storage();
    if (!storage) return audioError("storage_unavailable");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");

    // 番号は 1 以上の 10 進（part 0 は /audio/complete）
    if (!/^[1-9][0-9]{0,2}$/.test(index)) return notFoundResponse();
    const partIndex = Number(index);
    const parts = await store.listAudioParts(session.userId, id);
    const part = parts.find((item) => item.partIndex === partIndex);
    if (!part) return notFoundResponse();
    if (part.status === "uploaded") {
      // 済んだものは保存先に問い合わせない（期限で消えた後も、済んだ記録は済んだまま）
      return jsonResponse(200, { part: audioPartBody(part), parts: parts.map(audioPartBody) });
    }
    const stored: StoredObject | null = await storage.stat(part.objectPath);
    if (!stored) return audioError("incomplete", "missing");
    const result = await store.completeAudioPart(session.userId, id, partIndex, { sizeBytes: stored.sizeBytes });
    if (!result) return notFoundResponse();
    if (result.status === "size_mismatch") return audioError("incomplete", "size_mismatch");
    const after = await store.listAudioParts(session.userId, id);
    return jsonResponse(200, { part: audioPartBody(result.part), parts: after.map(audioPartBody) });
  });
}

/**
 * DELETE /api/pages/{id}/recording/audio/parts/{index} — アップロードが済んでいない 2 本目以降の音声を取り除く。
 * 途中でやめた取り込みの行が残ると、その録音は文字起こしを始められなくなる（全部の音声が済んでいるときだけ始められる）。
 * 200 `{ parts }`（残った音声の列）。済んでいる音声は 409 not_unfinished（消さない）、無い番号・録音の無いページは同じ 404。
 */
export function discardAudioPartRoute(request: Request, id: string, index: string, deps: AudioApiDeps): Promise<Response> {
  return guarded("DELETE /api/pages/[id]/recording/audio/parts/[index]", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");

    // 番号は 1 以上の 10 進（part 0 は取り除けない）
    if (!/^[1-9][0-9]{0,2}$/.test(index)) return notFoundResponse();
    const result = await store.discardAudioPart(session.userId, id, Number(index));
    if (result === null) return notFoundResponse();
    if (result === "not_unfinished") return audioError("not_unfinished");
    const parts = await store.listAudioParts(session.userId, id);
    return jsonResponse(200, { parts: parts.map(audioPartBody) });
  });
}
