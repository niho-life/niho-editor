import { randomBytes } from "node:crypto";
import {
  StorageError,
  isByteRange,
  isObjectPath,
  type ObjectStorage,
  type ReadObject,
  type ReadObjectOptions,
  type StartUploadInput,
  type StoredObject,
  type UploadTicket,
} from "./types";

/**
 * メモリの中だけの偽の保存先（開発と CI だけ。本番では src/storage/config.ts が受け付けない）。
 * ticket の url は `/api/dev/fake-storage/{token}`（同じ origin の dev 用の受け口。src/app/api/dev/fake-storage/[token]/route.ts）で、
 * そこへの PUT が putFakeObject を呼ぶ。GCS と同じく、同じ場所に object が既にあれば上書きしない。
 * 偽物は PUT の大きさを申告と照らさない（完了の時の大きさの照合をサーバーの側で試せるように）。
 * 読み取り（readObject）は置いてあるバイト列を流す（画像の中継・録音の再生を開発でも試せるように。範囲は slice）。
 */

/** 偽の受け口の path の接頭辞。 */
export const FAKE_STORAGE_PATH = "/api/dev/fake-storage/";
/** 偽の受け口が受け取る本文の上限（偽物なので小さく）。 */
export const FAKE_STORAGE_MAX_BYTES = 64 * 1024 * 1024;
/** ticket の有効な時間。 */
export const FAKE_TICKET_TTL_MS = 60 * 60 * 1000;
/** token の形（32 バイトの乱数の base64url）。 */
export const FAKE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type Session = { objectPath: string; contentType: string; sizeBytes: number; expiresAtMs: number };
type FakeObject = { bytes: Uint8Array; contentType: string | null };

export type FakeStorageState = {
  sessions: Map<string, Session>;
  completedSessions: Map<string, Session>;
  objects: Map<string, FakeObject>;
  partials: Map<string, Uint8Array>;
};

/** ok: 置いた / not_found: token が無い・期限切れ / exists: 同じ場所に既にある / too_large: 上限を超える */
export type FakePutResult = "ok" | "partial" | "not_found" | "exists" | "too_large" | "range_mismatch";
export type FakeUploadStatus = { status: "partial"; receivedBytes: number } | { status: "complete" | "not_found" | "exists" | "range_mismatch" };

export interface FakeStorage extends ObjectStorage {
  readonly kind: "fake";
  /** dev の受け口から: token のセッションの場所に object を置く。 */
  putFakeObject(token: string, bytes: Uint8Array, contentType: string | null, range?: { start: number; end: number; total: number }): FakePutResult;
  fakeUploadStatus(token: string, total: number): FakeUploadStatus;
}

export function createFakeStorageState(): FakeStorageState {
  return { sessions: new Map(), completedSessions: new Map(), objects: new Map(), partials: new Map() };
}

/** バイト列を 1 つの chunk で流す。 */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function createFakeStorage(options: { state?: FakeStorageState; now?: () => number } = {}): FakeStorage {
  const state = options.state ?? createFakeStorageState();
  // dev の HMR 前に作られた global state も、新しい status query で落とさない。
  state.completedSessions ??= new Map();
  const now = options.now ?? Date.now;
  return {
    kind: "fake",
    async startUpload(input: StartUploadInput): Promise<UploadTicket> {
      if (!isObjectPath(input.objectPath) || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) throw new StorageError("rejected");
      // 既にある場所でもセッションは作れる（上書きは PUT の時に断る。GCS の ifGenerationMatch=0 の前提条件と同じ扱い）
      const token = randomBytes(32).toString("base64url");
      const expiresAtMs = now() + FAKE_TICKET_TTL_MS;
      state.sessions.set(token, { objectPath: input.objectPath, contentType: input.contentType, sizeBytes: input.sizeBytes, expiresAtMs });
      return {
        url: `${FAKE_STORAGE_PATH}${token}`,
        method: "PUT",
        headers: { "Content-Type": input.contentType },
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },
    async stat(objectPath: string): Promise<StoredObject | null> {
      if (!isObjectPath(objectPath)) throw new StorageError("rejected");
      const object = state.objects.get(objectPath);
      return object ? { sizeBytes: object.bytes.byteLength, contentType: object.contentType } : null;
    },
    async readObject(objectPath: string, options: ReadObjectOptions = {}): Promise<ReadObject | null> {
      if (!isObjectPath(objectPath)) throw new StorageError("rejected");
      const { range } = options;
      if (range !== undefined && !isByteRange(range)) throw new StorageError("rejected");
      const object = state.objects.get(objectPath);
      if (!object) return null;
      if (range === undefined) {
        // 置いてあるバイト列の写しを 1 つの chunk で流す（読む側が持っている間に置き換わらない）
        const bytes = object.bytes.slice();
        return { body: streamOf(bytes), contentType: object.contentType, sizeBytes: bytes.byteLength };
      }
      // 範囲: GCS（Range つきの GET）と同じく、始まりが大きさ以上なら断り、終わりは object の終わりで切る
      const totalBytes = object.bytes.byteLength;
      if (range.start >= totalBytes) throw new StorageError("range_not_satisfiable");
      const end = Math.min(range.end, totalBytes - 1);
      const bytes = object.bytes.slice(range.start, end + 1);
      return { body: streamOf(bytes), contentType: object.contentType, sizeBytes: bytes.byteLength, range: { start: range.start, end }, totalBytes };
    },
    putFakeObject(token: string, bytes: Uint8Array, contentType: string | null, range?: { start: number; end: number; total: number }): FakePutResult {
      if (!FAKE_TOKEN_PATTERN.test(token)) return "not_found";
      const session = state.sessions.get(token);
      if (!session || session.expiresAtMs <= now()) return "not_found";
      if (bytes.byteLength > FAKE_STORAGE_MAX_BYTES) return "too_large";
      if (state.objects.has(session.objectPath)) return "exists";
      if (range) {
        const prior = state.partials.get(token) ?? new Uint8Array(0);
        if (range.start > prior.byteLength || range.end !== range.start + bytes.byteLength - 1 || range.total !== session.sizeBytes || range.end >= range.total) return "range_mismatch";
        const overlap = prior.byteLength - range.start;
        if (overlap > bytes.byteLength) return "range_mismatch";
        for (let index = 0; index < overlap; index += 1) {
          if (prior[range.start + index] !== bytes[index]) return "range_mismatch";
        }
        const append = bytes.subarray(overlap);
        if (prior.byteLength + append.byteLength > FAKE_STORAGE_MAX_BYTES) return "too_large";
        const joined = new Uint8Array(prior.byteLength + append.byteLength);
        joined.set(prior);
        joined.set(append, prior.byteLength);
        if (joined.byteLength < range.total) {
          state.partials.set(token, joined);
          return "partial";
        }
        state.partials.delete(token);
        state.objects.set(session.objectPath, { bytes: joined, contentType: contentType ?? session.contentType });
      } else {
        state.objects.set(session.objectPath, { bytes: bytes.slice(), contentType: contentType ?? session.contentType });
      }
      state.completedSessions.set(token, session);
      state.sessions.delete(token);
      return "ok";
    },
    fakeUploadStatus(token: string, total: number): FakeUploadStatus {
      if (!FAKE_TOKEN_PATTERN.test(token) || !Number.isSafeInteger(total) || total < 1) return { status: "not_found" };
      const completed = state.completedSessions.get(token);
      if (completed) return completed.sizeBytes === total ? { status: "complete" } : { status: "range_mismatch" };
      const session = state.sessions.get(token);
      if (!session || session.expiresAtMs <= now()) return { status: "not_found" };
      if (session.sizeBytes !== total) return { status: "range_mismatch" };
      if (state.objects.has(session.objectPath)) return { status: "exists" };
      return { status: "partial", receivedBytes: state.partials.get(token)?.byteLength ?? 0 };
    },
  };
}
