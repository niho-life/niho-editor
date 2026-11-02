import { PHOTO_LIMITS, type Photo, type PhotoFormat, type Upload, type UploadTicket } from "@niho/photo-library-contract";
import { createPhotoApiClient, type AuthenticatedFetch, type CloudPhotoScope } from "@niho/photo-cloud-library";
import { Sha256 } from "@/lib/sha256-stream";

export type PhotoUploadStage = "preparing" | "uploading" | "confirming" | "processing";
export type PhotoUploadResult = { kind: "stored" | "existing"; photo: Photo };
export class PhotoUploadError extends Error {
  constructor(readonly reason: "unsupported" | "too_large" | "resume" | "cancelled" | "failed",
    readonly confirmedServerCancel = false) { super(reason); }
}

const formatByExtension: Record<string, PhotoFormat> = {
  jpg: "jpeg", jpeg: "jpeg", png: "png", heic: "heic", heif: "heif", tif: "tiff", tiff: "tiff",
  dng: "raw", cr2: "raw", cr3: "raw", nef: "raw", arw: "raw", raf: "raw", orf: "raw", rw2: "raw", pef: "raw",
};

export function photoFileFormat(file: File): PhotoFormat | null {
  return formatByExtension[file.name.split(".").at(-1)?.toLowerCase() ?? ""] ?? null;
}

export async function uploadPhotoFile(options: {
  file: File;
  /** A fresh opaque ID for each newly selected upload; reused only while retrying that row. */
  uploadAttemptId: string;
  scope: CloudPhotoScope;
  currentScope: () => CloudPhotoScope | null;
  authenticatedFetch: AuthenticatedFetch;
  signal: AbortSignal;
  onProgress: (stage: PhotoUploadStage, fraction: number | null) => void;
  /** Increment only after the server confirms an explicit cancellation. */
  cancelledGeneration?: number;
}): Promise<PhotoUploadResult> {
  const { file, signal, onProgress } = options;
  const format = photoFileFormat(file);
  if (!format) throw new PhotoUploadError("unsupported");
  if (file.size === 0 || file.size > PHOTO_LIMITS.maxFileBytes) throw new PhotoUploadError("too_large");
  onProgress("preparing", null);
  const hash = new Sha256();
  for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
    if (signal.aborted) throw new PhotoUploadError("cancelled");
    hash.update(new Uint8Array(await file.slice(offset, offset + 1024 * 1024).arrayBuffer()));
  }
  if (signal.aborted) throw new PhotoUploadError("cancelled");
  const startRequest = {
    target: { kind: "original" as const, fileName: file.name, format }, sizeBytes: file.size,
    sha256: hash.digest(), contentType: contentTypeFor(format),
  };
  // The request journal is owner scoped. The same bytes/name/metadata replay the same reservation
  // after an ambiguous network failure, without exposing the name or digest in the header.
  const startKey = stableKey(["uploads.start", options.scope.actorId, options.scope.libraryId,
    options.uploadAttemptId, startRequest, options.cancelledGeneration ?? 0]);
  const keys = new Map<string, string>([["uploads.start", startKey]]);
  const client = createPhotoApiClient({
    scope: options.scope, currentScope: options.currentScope, authenticatedFetch: options.authenticatedFetch,
    idempotencyKey: (operation) => {
      const key = keys.get(operation);
      if (!key) throw new PhotoUploadError("failed");
      return key;
    },
  });
  let uploadId: string | null = null;
  try {
    const started = await client.request("uploads.start", startRequest, { signal });
    if (started.value.kind === "existing") return { kind: "existing", photo: started.value.photo };
    const upload = started.value.upload;
    uploadId = upload.id;
    keys.set("uploads.complete", stableKey(["uploads.complete", startKey, uploadId]));
    keys.set("uploads.cancel", stableKey(["uploads.cancel", startKey, uploadId]));
    if (upload.state === "stored") return storedResult(upload);
    if (upload.state === "verifying") return storedResult(await waitForStored(client, uploadId, signal, onProgress));
    if (upload.state !== "reserved" || !started.value.ticket) throw new PhotoUploadError("failed");
    await sendTicket(file, started.value.ticket, signal, (fraction) => onProgress("uploading", fraction));
    onProgress("confirming", null);
    const receipt = await client.request("uploads.complete", { uploadId }, { signal });
    const confirmed = receipt.value.state === "verifying" ? await waitForStored(client, uploadId, signal, onProgress) : receipt.value;
    return storedResult(confirmed);
  } catch (error) {
    if (signal.aborted && uploadId) {
      // Cancellation races with server confirmation. Ask the server before showing a final state.
      try {
        const current = await client.request("uploads.get", { uploadId });
        if (current.state === "stored") return storedResult(current);
        if (current.state === "reserved") {
          const cancelled = await client.request("uploads.cancel", { uploadId });
          if (cancelled.value.state === "cancelled") throw new PhotoUploadError("cancelled", true);
        }
      } catch (confirmationError) {
        if (confirmationError instanceof PhotoUploadError && confirmationError.reason === "cancelled") throw confirmationError;
        throw new PhotoUploadError("failed");
      }
      throw new PhotoUploadError("failed");
    }
    if (signal.aborted) throw new PhotoUploadError("cancelled");
    throw error;
  } finally {
    client.dispose();
  }
}

function storedResult(upload: Upload): PhotoUploadResult {
  if (upload.state !== "stored" || upload.result.kind !== "original") throw new PhotoUploadError("failed");
  return { kind: "stored", photo: upload.result.photo };
}

function contentTypeFor(format: PhotoFormat): string {
  return ({ jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif", tiff: "image/tiff", raw: "application/octet-stream" })[format];
}

function stableKey(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return `photo_${new Sha256().update(bytes).digest()}`;
}

async function waitForStored(client: ReturnType<typeof createPhotoApiClient>, uploadId: string, signal: AbortSignal,
  onProgress: (stage: PhotoUploadStage, fraction: number | null) => void): Promise<Upload> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    onProgress("processing", null);
    await pause(2000, signal);
    const current = await client.request("uploads.get", { uploadId }, { signal });
    if (current.state !== "verifying") return current;
  }
  throw new PhotoUploadError("failed");
}

function sendTicket(file: File, ticket: UploadTicket, signal: AbortSignal, progress: (fraction: number) => void): Promise<void> {
  const offset = ticket.resumeOffsetBytes;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size) return Promise.reject(new PhotoUploadError("resume"));
  if (offset === file.size) { progress(1); return Promise.resolve(); }
  const range = `bytes ${offset}-${file.size - 1}/${file.size}`;
  let url: URL;
  try { url = new URL(ticket.url); } catch { return Promise.reject(new PhotoUploadError("failed")); }
  if (url.protocol !== "https:" || url.username || url.password || ticket.method !== "PUT") {
    return Promise.reject(new PhotoUploadError("failed"));
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.open("PUT", url.href);
    xhr.withCredentials = false;
    xhr.timeout = 15 * 60 * 1000;
    for (const [name, value] of Object.entries(ticket.headers)) {
      if (/^(cookie|authorization|proxy-authorization)$/i.test(name)) {
        signal.removeEventListener("abort", abort);
        reject(new PhotoUploadError("failed"));
        return;
      }
      if (/^content-range$/i.test(name)) {
        if (value !== range) { signal.removeEventListener("abort", abort); reject(new PhotoUploadError("resume")); return; }
        continue;
      }
      xhr.setRequestHeader(name, value);
    }
    xhr.setRequestHeader("Content-Range", range);
    progress(offset / file.size);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) progress(Math.min(1, (offset + event.loaded) / file.size)); };
    xhr.onload = () => {
      signal.removeEventListener("abort", abort);
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new PhotoUploadError("failed"));
    };
    xhr.onerror = xhr.ontimeout = () => { signal.removeEventListener("abort", abort); reject(new PhotoUploadError("failed")); };
    xhr.onabort = () => { signal.removeEventListener("abort", abort); reject(new PhotoUploadError("cancelled")); };
    if (signal.aborted) { xhr.abort(); return; }
    xhr.send(file.slice(offset, file.size, file.type || "application/octet-stream"));
  });
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(new PhotoUploadError("cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
