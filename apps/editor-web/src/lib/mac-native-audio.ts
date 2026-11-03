import type { ShellAudioRecovery, ShellPreparedAudioFile } from "niho-desktop-bridge/shell-contract";
import type { ShellBridge } from "niho-desktop-bridge/shell-bridge";
import {
  completeAudioPartUpload,
  completeAudioUpload,
  startAudioPartUpload,
  startAudioUpload,
  type AudioStartResponse,
  type AudioUploadTicket,
} from "./audio-upload-client";

const OWNER_SCOPE = /^[a-f0-9]{64}$/;
const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const UPLOAD_RETRY_LIMIT = 4;

class UploadNeedsCompletionCheck extends Error {
  override readonly name = "UploadNeedsCompletionCheck";
}

export async function macNativeAudioOwnerScope(signal?: AbortSignal): Promise<string> {
  const response = await fetch("/api/recordings/audio/native-context", { credentials: "same-origin", cache: "no-store", signal });
  const body: unknown = await response.json().catch(() => null);
  const value = body && typeof body === "object" ? (body as { ownerScope?: unknown }).ownerScope : null;
  if (!response.ok || typeof value !== "string" || !OWNER_SCOPE.test(value)) throw new Error("native audio context unavailable");
  return value;
}

export async function stableUploadKey(stagingId: string, index: number): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`niho-native-audio\0${stagingId}\0${index}`)));
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function validateMacNativeAudioRecovery(recovery: ShellAudioRecovery, ownerScope: string): void {
  if (recovery.ownerScope !== ownerScope || !Number.isSafeInteger(recovery.createdAtMs) || recovery.createdAtMs < 1 ||
    recovery.state !== "ready" || recovery.files.length < 1 || recovery.files.length > 256) throw new Error("native audio recovery changed");
  let offset = 0;
  for (const [index, file] of recovery.files.entries()) {
    if (file.index !== index || file.contentType !== "audio/wav" || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 2 * 1024 ** 3 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isFinite(file.durationSec) || file.durationSec <= 0 || file.offsetSec !== offset) throw new Error("native audio recovery changed");
    offset += file.durationSec;
  }
  if (offset > 6 * 60 * 60) throw new Error("native audio recovery too long");
}

type UploadPosition = { complete: true } | { complete: false; offset: number };

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
}

async function positionFromResponse(response: Response, total: number): Promise<UploadPosition> {
  const range = response.headers.get("range");
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 200 || response.status === 201) return { complete: true };
  if (response.status === 412) throw new UploadNeedsCompletionCheck("upload object may already exist");
  if (response.status !== 308) throw new Error("native audio upload failed");
  if (range === null) return { complete: false, offset: 0 };
  const match = /^bytes=0-(\d+)$/i.exec(range);
  if (!match) throw new Error("native audio upload range invalid");
  const upper = Number(match[1]);
  if (!Number.isSafeInteger(upper) || upper < 0 || upper >= total) throw new Error("native audio upload range invalid");
  return { complete: false, offset: upper + 1 };
}

async function queryUploadPosition(
  ticket: AudioUploadTicket,
  total: number,
  signal: AbortSignal,
  assertActive: () => Promise<void>,
): Promise<UploadPosition> {
  for (let attempt = 0; attempt < UPLOAD_RETRY_LIMIT; attempt += 1) {
    throwIfAborted(signal);
    await assertActive();
    try {
      const response = await fetch(ticket.url, {
        method: "PUT",
        headers: { ...ticket.headers, "Content-Range": `bytes */${total}` },
        body: null,
        credentials: "omit",
        cache: "no-store",
        signal,
      });
      if (response.status >= 500 && response.status <= 599) {
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      const position = await positionFromResponse(response, total);
      // 308 が全byteを示しても完了応答ではない。同じsessionを再照会して200/201を要求する。
      if (!position.complete && position.offset === total) continue;
      return position;
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof UploadNeedsCompletionCheck || (error instanceof Error && error.message.includes("range"))) throw error;
      if (attempt + 1 === UPLOAD_RETRY_LIMIT) throw new Error("native audio upload status unavailable");
    }
  }
  throw new Error("native audio upload status unavailable");
}

export async function putPrepared(
  shell: ShellBridge,
  recovery: ShellAudioRecovery,
  file: ShellPreparedAudioFile,
  ticket: AudioUploadTicket,
  signal: AbortSignal,
  onProgress?: (fraction: number) => void,
  assertActive: () => Promise<void> = async () => undefined,
): Promise<void> {
  const initial = await queryUploadPosition(ticket, file.bytes, signal, assertActive);
  if (initial.complete) {
    onProgress?.(1);
    return;
  }
  let offset = initial.offset;
  let stalled = 0;
  while (offset < file.bytes) {
    throwIfAborted(signal);
    await assertActive();
    const chunk = await shell.audioPreparedChunk(recovery.stagingId, recovery.ownerScope, file.index, offset);
    const expected = Math.min(UPLOAD_CHUNK_BYTES, file.bytes - offset);
    if (chunk.byteLength !== expected) throw new Error("native audio chunk changed");
    const end = offset + chunk.byteLength - 1;
    const body = new ArrayBuffer(chunk.byteLength);
    new Uint8Array(body).set(chunk);
    let position: UploadPosition;
    try {
      const response = await fetch(ticket.url, {
        method: "PUT",
        headers: { ...ticket.headers, "Content-Range": `bytes ${offset}-${end}/${file.bytes}` },
        body,
        credentials: "omit",
        cache: "no-store",
        signal,
      });
      if (response.status >= 500 && response.status <= 599) {
        await response.body?.cancel().catch(() => undefined);
        position = await queryUploadPosition(ticket, file.bytes, signal, assertActive);
      } else {
        position = await positionFromResponse(response, file.bytes);
        if (!position.complete && position.offset === file.bytes) {
          position = await queryUploadPosition(ticket, file.bytes, signal, assertActive);
        }
      }
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof UploadNeedsCompletionCheck || (error instanceof Error && error.message.includes("range"))) throw error;
      position = await queryUploadPosition(ticket, file.bytes, signal, assertActive);
    }
    if (position.complete) {
      if (end + 1 !== file.bytes) throw new Error("native audio upload completed outside final range");
      offset = file.bytes;
    } else {
      if (position.offset < offset || position.offset > end + 1) throw new Error("native audio upload range moved outside request");
      stalled = position.offset === offset ? stalled + 1 : 0;
      if (stalled >= UPLOAD_RETRY_LIMIT) throw new Error("native audio upload made no progress");
      offset = position.offset;
    }
    onProgress?.(offset / file.bytes);
  }
}

export async function uploadMacNativeAudio(input: {
  shell: ShellBridge;
  recovery: ShellAudioRecovery;
  ownerScope: string;
  signal: AbortSignal;
  onProgress?: (value: { file: number; files: number; fraction: number }) => void;
}): Promise<{ page: AudioStartResponse["page"] }> {
  const assertOwner = async () => {
    if (await macNativeAudioOwnerScope(input.signal) !== input.ownerScope) throw new Error("native audio owner changed");
  };
  await assertOwner();
  validateMacNativeAudioRecovery(input.recovery, input.ownerScope);
  let page: AudioStartResponse["page"] | null = null;
  for (const [index, file] of input.recovery.files.entries()) {
    await assertOwner();
    const request = { name: `audio-${index + 1}.wav`, contentType: "audio/wav", sizeBytes: file.bytes, sha256: file.sha256, durationSec: file.durationSec };
    const idempotencyKey = await stableUploadKey(input.recovery.stagingId, index);
    if (index === 0) {
      const started = await startAudioUpload(request, { idempotencyKey });
      page = started.page;
      if (started.upload) {
        try {
          await putPrepared(input.shell, input.recovery, file, started.upload, input.signal, (fraction) => input.onProgress?.({ file: index, files: input.recovery.files.length, fraction }), assertOwner);
        } catch (error) {
          // 412 は完了証拠にしない。続く server complete が同じobjectをreadbackし、申告bytesと一致した場合だけ確定する。
          if (!(error instanceof UploadNeedsCompletionCheck)) throw error;
        }
      }
      await assertOwner();
      await completeAudioUpload(started.page.id);
    } else {
      if (!page) throw new Error("native audio page missing");
      const started = await startAudioPartUpload(page.id, request, { idempotencyKey });
      if (started.upload) {
        try {
          await putPrepared(input.shell, input.recovery, file, started.upload, input.signal, (fraction) => input.onProgress?.({ file: index, files: input.recovery.files.length, fraction }), assertOwner);
        } catch (error) {
          if (!(error instanceof UploadNeedsCompletionCheck)) throw error;
        }
      }
      await assertOwner();
      await completeAudioPartUpload(page.id, started.part.partIndex);
    }
  }
  if (!page) throw new Error("native audio empty");
  await assertOwner();
  await input.shell.audioPreparedCommit(input.recovery.stagingId, input.ownerScope);
  return { page };
}
