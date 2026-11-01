import "server-only";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PhotoUploadRecord } from "@niho/editor-store";
import { PHOTO_LIMITS } from "../../../../../packages/photo-library-contract/src/v1";
import { boundedPhotoStream, type PhotoObject, type PhotoStorage } from "../../storage/photo-types";
import { fail } from "./http";
import type { PhotoProbe, ProbeResult } from "./types";

/** Independent magic check; a declared MIME or a trusting provider cannot substitute for bytes. */
function checkMagic(header: Buffer, result: ProbeResult) {
  if (result.format === "png") {
    if (header.length < 33 || !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || header.readUInt32BE(8) !== 13 || header.toString("ascii", 12, 16) !== "IHDR"
      || header.readUInt32BE(16) !== result.width || header.readUInt32BE(20) !== result.height) fail("content_rejected");
  } else if (result.format === "jpeg") {
    if (header.length < 3 || header[0] !== 255 || header[1] !== 216 || header[2] !== 255) fail("content_rejected");
  } else if (result.format === "heic" || result.format === "heif") {
    if (header.length < 16 || header.toString("ascii", 4, 8) !== "ftyp") fail("content_rejected");
    const brands = header.subarray(8, Math.min(header.readUInt32BE(0), header.length)).toString("ascii");
    if (!/(heic|heix|hevc|hevx|mif1|msf1)/.test(brands) || /avif|avis/.test(brands)) fail("content_rejected");
  } else if (result.format === "tiff") {
    if (!header.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) && !header.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))) fail("content_rejected");
  }
  // RAW magic is camera-specific and belongs to the accepted decoder, not an extension heuristic.
}

/** Constant-memory spool/hash. The private file is removed on success, rejection, abort or provider failure. */
export async function verifyPhotoObject(storage: PhotoStorage, probe: PhotoProbe, upload: PhotoUploadRecord, object: PhotoObject, signal: AbortSignal) {
  const max = upload.operation === "mask" ? PHOTO_LIMITS.maxMaskBytes : PHOTO_LIMITS.maxFileBytes;
  if (object.sizeBytes !== upload.sizeBytes || object.sizeBytes > max || object.contentType !== upload.contentType) fail("content_rejected");
  const directory = await mkdtemp(join(tmpdir(), "niho-photo-transfer-"));
  const path = join(directory, "source");
  try {
    const file = await open(path, "wx", 0o600);
    const hash = createHash("sha256");
    const header = Buffer.alloc(512);
    let headerLength = 0; let size = 0;
    try {
      const reader = boundedPhotoStream(await storage.read(object, null, signal), object.sizeBytes, signal).getReader();
      try {
        for (;;) {
          const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > upload.sizeBytes || size > max) fail("content_rejected");
          hash.update(chunk.value);
          const take = Math.min(chunk.value.byteLength, header.length - headerLength);
          header.set(chunk.value.subarray(0, take), headerLength); headerLength += take;
          // FileHandle.write may make partial progress.
          let offset = 0;
          while (offset < chunk.value.byteLength) {
            signal.throwIfAborted();
            const written = await file.write(chunk.value, offset, chunk.value.byteLength - offset);
            if (written.bytesWritten < 1) throw new Error("photo spool unavailable");
            offset += written.bytesWritten;
          }
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    } finally { await file.close(); }
    if (size !== upload.sizeBytes || hash.digest("hex") !== upload.sha256) fail("content_rejected");
    const result = await probe.inspect(path, { maxPixels: PHOTO_LIMITS.maxPixels, maxEdge: upload.operation === "mask" ? PHOTO_LIMITS.maxMaskEdge : null }, signal);
    signal.throwIfAborted();
    if (!Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || result.width < 1 || result.height < 1) fail("content_rejected");
    if (result.width > PHOTO_LIMITS.maxPixels || result.height > PHOTO_LIMITS.maxPixels || result.width * result.height > PHOTO_LIMITS.maxPixels) fail("pixel_limit_exceeded");
    checkMagic(header.subarray(0, headerLength), result);
    if (result.contentType !== upload.contentType) fail("content_rejected");
    if (upload.operation === "mask") {
      if (result.format !== "png" || result.bitDepth !== 8 || result.channels !== "gray" || header[24] !== 8 || header[25] !== 0
        || header[26] !== 0 || header[27] !== 0 || header[28] !== 0) fail("content_rejected");
      if (result.width > PHOTO_LIMITS.maxMaskEdge || result.height > PHOTO_LIMITS.maxMaskEdge) fail("pixel_limit_exceeded");
    } else if (result.format !== upload.format) fail("content_rejected");
    return { sha256: upload.sha256, sizeBytes: size, contentType: result.contentType, width: result.width, height: result.height,
      ...(upload.operation === "original" ? { format: result.format } : {}) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
