import type { AudioPart, OwnerId } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { AUDIO_CONTENT_TYPES } from "../recording/audio-limits";
import { contentRange, resolveAudioRange, unsatisfiedContentRange } from "../recording/audio-range";
import { StorageError, type ObjectStorage, type ReadObject } from "../storage/types";
import { ROBOTS_HEADER_VALUE, errorResponse, jsonResponse, notFoundResponse } from "./http";

/**
 * 録音の音声Partの再生（#36 段 3b-2・#231）: `GET /api/pages/{id}/recording/audio?part={index}`。partを省略したときは0。
 *
 * 実行 ID（Cloud Run のサービスアカウント）には署名付き URL の権限が無いので、同じ origin のこの route が保存先から読み出して流す
 * （`<audio src>` がここを指す。同じ origin なので cookie が付き、CSP の `media-src 'self'` のままでよい）。
 * - 本人の・ゴミ箱でないページの録音で、指定した音声Partがアップロード済み（uploaded）かつ保持の期限の内側のときだけ流す。別の人・存在しない・
 *   不正な id・削除済み・録音の無い・音声の無い・アップロード途中・期限切れ・保存先に object が無いは、どれも同じ 404（本文・header とも）。
 * - `Range`: 範囲 1 つだけ（src/recording/audio-range.ts）。範囲なしは 200 で全体、範囲ありは 206 と `Content-Range`、満たせない・
 *   複数・不正は 416 と `Content-Range: bytes *` ＋全体の大きさ。全体の大きさは DB の値（完了のときに保存先の大きさと照らした値）。
 *   `If-Range` が付いていたら範囲は無視して全体（検証子を出していないので、一致することが無い。RFC 9110 §13.1.5）。
 * - 本文は保存先の流れをそのまま渡す（全部をメモリに読まない）。要求が切られたら（`request.signal`）・応答の流れが cancel されたら、
 *   保存先の流れも cancel する。
 * - object の場所は DB の値だけを使う（要求の値から場所を作らない）。保存先の場所・bucket 名・token はログ・エラー・応答に出さない。
 * - 保存先を使わない設定は 503 `storage_unavailable`、保存先の失敗・大きさの食い違いは 502 `storage_failed`。
 */

/** 再生の API が使う store の操作。返る列は認証済み owner と page に必ず絞られる。 */
export type AudioStreamStore = {
  listAudioParts: (owner: OwnerId, pageId: string) => Promise<Pick<AudioPart, "partIndex" | "objectPath" | "status" | "bytes" | "contentType" | "expiresAt">[]>;
};

export type AudioStreamApiDeps = {
  auth: () => AuthProvider;
  /** DB が使えないときは null（503 unavailable）。 */
  store: () => AudioStreamStore | null;
  /** 保存先が使えないときは null（503 storage_unavailable）。 */
  storage: () => ObjectStorage | null;
  /** 期限と比べる今の時刻（テストで差し替える）。 */
  now?: () => number;
};

const ROUTE = "GET /api/pages/[id]/recording/audio";

/** 中身の応答の header（API の他の応答と同じ private・no-store・nosniff・noindex に、範囲と inline）。 */
const STREAM_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Accept-Ranges": "bytes",
  "Cache-Control": "private, no-store",
  // ダウンロードさせない・名前を出さない（今の画面の中の <audio> で使うだけ）
  "Content-Disposition": "inline",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": ROBOTS_HEADER_VALUE,
});

type StreamErrorCode = "storage_unavailable" | "storage_failed";

function streamError(code: StreamErrorCode): Response {
  return jsonResponse(code === "storage_unavailable" ? 503 : 502, { error: code });
}

/** 416（範囲を満たせない）。全体の大きさだけを `Content-Range` で伝える。 */
function rangeNotSatisfiable(totalBytes: number): Response {
  const response = jsonResponse(416, { error: "range_not_satisfiable" });
  response.headers.set("Accept-Ranges", "bytes");
  response.headers.set("Content-Range", unsatisfiedContentRange(totalBytes));
  return response;
}

/** 返す種類（開始で受け付けた音声の種類だけ。パラメータなし。それ以外は中身を推測させない octet-stream）。 */
function servedContentType(contentType: string): string {
  return AUDIO_CONTENT_TYPES.includes(contentType) ? contentType : "application/octet-stream";
}

/** 再生できる音声か（アップロード済みで、期限が無いか期限の前）。 */
function playable(part: Pick<AudioPart, "status" | "expiresAt">, now: number): boolean {
  if (part.status !== "uploaded") return false;
  if (part.expiresAt === null) return true;
  const at = Date.parse(part.expiresAt);
  return Number.isFinite(at) && now < at;
}

/**
 * 保存先の流れを 1 chunk ずつ渡す流れ（読む側が求めた分だけ読む）。読む側が cancel したら・要求が切られたら、保存先の流れを cancel する。
 */
function forwardBody(source: ReadableStream<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let settled = false;
  const stop = () => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", onAbort);
  };
  const onAbort = () => {
    stop();
    void reader.cancel().catch(() => undefined);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            stop();
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch {
          // 保存先の失敗の中身は出さない
          stop();
          controller.error(new StorageError("unavailable"));
        }
      },
      cancel() {
        stop();
        return reader.cancel().catch(() => undefined);
      },
    },
    // 先読みしない（求められたら 1 chunk）
    { highWaterMark: 0 },
  );
}

async function discard(read: ReadObject): Promise<void> {
  await read.body.cancel().catch(() => undefined);
}

/**
 * 想定外の失敗は 500 の汎用エラー（内部の情報は応答に出さず、ログにも名前と code だけを書く。場所・token を出さない）。
 * 保存先の失敗（StorageError）は 502 storage_failed。
 */
async function guarded(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof StorageError) {
      console.error("editor-web: object storage failed", { route: ROUTE, code: error.code });
      return streamError("storage_failed");
    }
    const name = error instanceof Error ? error.name : "unknown";
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
    console.error("editor-web: request failed", { route: ROUTE, name, code });
    return errorResponse("internal");
  }
}

/** GET /api/pages/{id}/recording/audio?part={index} — 本人だけ。`Range` は範囲 1 つ。 */
export function streamAudioRoute(request: Request, id: string, deps: AudioStreamApiDeps): Promise<Response> {
  return guarded(async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const storage = deps.storage();
    if (!storage) return streamError("storage_unavailable");

    // owner は認証の層の本人だけ（要求の値からは決めない）
    const url = new URL(request.url);
    const rawPart = url.searchParams.get("part");
    const partIndex = rawPart === null ? 0 : /^(0|[1-9]\d*)$/.test(rawPart) ? Number(rawPart) : Number.NaN;
    if (!Number.isSafeInteger(partIndex) || partIndex < 0) return notFoundResponse();
    const part = (await store.listAudioParts(session.userId, id)).find((candidate) => candidate.partIndex === partIndex);
    if (!part || !playable(part, (deps.now ?? Date.now)())) return notFoundResponse();
    const info = { objectPath: part.objectPath, bytes: part.bytes, contentType: part.contentType };
    const totalBytes = info.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) throw new TypeError("editor-web: the audio size is not an integer");

    const wanted = resolveAudioRange(request.headers.has("if-range") ? null : request.headers.get("range"), totalBytes);
    if (wanted.kind === "unsatisfiable") return rangeNotSatisfiable(totalBytes);

    let read: ReadObject | null;
    try {
      read = await storage.readObject(info.objectPath, wanted.kind === "partial" ? { range: { start: wanted.start, end: wanted.end } } : undefined);
    } catch (error) {
      // DB の大きさで満たせる範囲を保存先が満たせない（大きさの食い違い）。DB の大きさで 416 を返す
      if (error instanceof StorageError && error.code === "range_not_satisfiable") return rangeNotSatisfiable(totalBytes);
      throw error;
    }
    // 期限の前に保存先の規則で消えた・まだ無い: 他の 404 と同じ
    if (!read) return notFoundResponse();

    const headers: Record<string, string> = { "Content-Type": servedContentType(info.contentType), ...STREAM_HEADERS };
    let status = 200;
    if (wanted.kind === "partial" && read.range?.start === wanted.start && read.range.end === wanted.end && read.totalBytes === totalBytes) {
      status = 206;
      headers["Content-Range"] = contentRange(wanted.start, wanted.end, totalBytes);
      headers["Content-Length"] = String(wanted.end - wanted.start + 1);
    } else if (read.sizeBytes === totalBytes && (wanted.kind === "full" || (read.range?.start === 0 && read.range.end === totalBytes - 1))) {
      // 範囲なし、または保存先が範囲を無視して全体を返した（HTTP は範囲を無視した 200 を許す）
      headers["Content-Length"] = String(totalBytes);
    } else {
      await discard(read);
      throw new StorageError("unavailable");
    }
    return new Response(forwardBody(read.body, request.signal), { status, headers });
  });
}

/**
 * HEAD は GET と同じ status・header で本文なし（保存先の流れはすぐ cancel する。HEAD を書かないと Next は GET をそのまま使い、
 * 返した本文の流れを誰が読み捨てるかが Next の内側の扱いに任される）。
 */
export async function headAudioRoute(request: Request, id: string, deps: AudioStreamApiDeps): Promise<Response> {
  const response = await streamAudioRoute(request, id, deps);
  await response.body?.cancel().catch(() => undefined);
  return new Response(null, { status: response.status, headers: response.headers });
}
