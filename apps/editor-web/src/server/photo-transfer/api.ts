import "server-only";
import { randomUUID } from "node:crypto";
import type { PhotoAssetRecord, PhotoUploadRecord } from "@niho/editor-store";
import { PHOTO_LIMITS, type Photo, type PhotoAsset, type StoredUploadResult, type Upload } from "../../../../../packages/photo-library-contract/src/v1";
import { boundedPhotoStream, type PhotoObject } from "../../storage/photo-types";
import { PRIVATE_PHOTO_HEADERS, PhotoTransferError, authorize, canonicalHash, closed, errorResponse, fail, idempotency, isDigest, json, parseRange, readBody, resourceId, startBody } from "./http";
import type { PhotoTransferActor, PhotoTransferDeps } from "./types";
import { verifyPhotoObject } from "./verify";

export function publicPhotoAsset(asset: PhotoAsset): PhotoAsset {
  return { id: asset.id, kind: asset.kind, sha256: asset.sha256, sizeBytes: asset.sizeBytes, contentType: asset.contentType, width: asset.width, height: asset.height };
}
/** Whitelist nested asset fields even when a projection accidentally retains private DB columns. */
function publicPhoto(photo: Photo): Photo {
  const media = photo.media;
  const recipe = photo.recipe;
  return {
    id: photo.id, libraryId: photo.libraryId, storageState: photo.storageState, lifecycle: photo.lifecycle, fileName: photo.fileName,
    format: photo.format, hasEdits: photo.hasEdits, addedAt: photo.addedAt, capturedAt: photo.capturedAt, width: photo.width, height: photo.height,
    original: publicPhotoAsset(photo.original), trashedAt: photo.trashedAt, purgeAfter: photo.purgeAfter,
    recipe: { revision: recipe.revision, settings: recipe.settings, settingsSha256: recipe.settingsSha256, baseVersion: recipe.baseVersion, maskSurfaceIds: recipe.maskSurfaceIds, updatedAt: recipe.updatedAt },
    media: media.state === "ready" ? { state: "ready", thumbnail: publicPhotoAsset(media.thumbnail), preview: publicPhotoAsset(media.preview),
      workingCopy: media.workingCopy ? { asset: publicPhotoAsset(media.workingCopy.asset), baseVersion: media.workingCopy.baseVersion, encoding: media.workingCopy.encoding, meta: media.workingCopy.meta } : null,
      recipeRevision: media.recipeRevision, rendererManifestSha256: media.rendererManifestSha256 }
      : "jobId" in media ? { state: media.state, jobId: media.jobId } : { state: media.state, code: media.code },
  };
}
function stageKey(id: string) { return `photo/stage/${id}`; }
function asObject(asset: PhotoAssetRecord): PhotoObject {
  return { key: asset.objectKey, generation: asset.objectGeneration, sizeBytes: asset.sizeBytes, contentType: asset.contentType };
}
function requireUpload(upload: PhotoUploadRecord | null): PhotoUploadRecord { if (!upload) fail("not_found"); return upload; }
function currentReserved(upload: PhotoUploadRecord, now: number) {
  if (upload.state === "expired" || Date.parse(upload.expiresAt) <= now) fail("upload_expired");
  if (upload.state !== "reserved") fail("upload_state_conflict");
}

/** No auth resolver/default actor and no Next runtime wiring. Every invocation needs a verified actor. */
export function createPhotoTransferApi(deps: PhotoTransferDeps) {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60_000 || deps.origins.some((origin) => {
    try { const url = new URL(origin); return url.origin !== origin || !["http:", "https:"].includes(url.protocol); } catch { return true; }
  })) throw new Error("photo transfer configuration invalid");

  async function result(owner: string, upload: PhotoUploadRecord): Promise<StoredUploadResult> {
    if (!upload.resultPhotoId || !upload.resultAssetId) fail("not_found");
    const photo = await deps.store.photo(owner, upload.resultPhotoId);
    if (!photo || photo.id !== upload.resultPhotoId) fail("not_found");
    if (photo.lifecycle === "trashed") fail("photo_trashed");
    if (upload.operation === "original") {
      if (photo.original.id !== upload.resultAssetId) fail("not_found");
      return { kind: "original", photo: publicPhoto(photo) };
    }
    const asset = await deps.store.asset(owner, upload.resultPhotoId, upload.resultAssetId);
    if (!asset || asset.photoId !== photo.id || asset.kind !== "mask" || asset.deletionState !== "retained") fail("not_found");
    return { kind: "mask", photoId: photo.id, asset: publicPhotoAsset(asset) };
  }
  async function publicUpload(owner: string, upload: PhotoUploadRecord, uploadedBytes = 0): Promise<Upload> {
    const target = upload.operation === "original"
      ? { kind: "original" as const, fileName: upload.fileName!, format: upload.format! }
      : { kind: "mask" as const, photoId: upload.targetPhotoId! };
    const base = { id: upload.id, target, sizeBytes: upload.sizeBytes, sha256: upload.sha256, expiresAt: upload.expiresAt };
    switch (upload.state) {
      case "reserved": return { ...base, state: "reserved", uploadedBytes };
      case "verifying": if (!upload.verificationJobId) fail("temporarily_unavailable"); return { ...base, state: "verifying", jobId: upload.verificationJobId };
      case "stored": return { ...base, state: "stored", result: await result(owner, upload) };
      case "rejected": return { ...base, state: "rejected", code: upload.rejectionCode ?? "content_rejected" };
      default: return { ...base, state: upload.state };
    }
  }
  async function ticket(request: Request, owner: string, upload: PhotoUploadRecord, signal: AbortSignal) {
    currentReserved(upload, now());
    const expiresAt = new Date(Math.min(now() + PHOTO_LIMITS.uploadTicketMaxSeconds * 1000, Date.parse(upload.expiresAt))).toISOString();
    const value = await deps.storage.ticket({ key: stageKey(upload.id), sizeBytes: upload.sizeBytes, contentType: upload.contentType, expiresAt, origin: request.headers.get("origin") }, signal);
    const latest = requireUpload(await deps.store.upload(owner, upload.id));
    currentReserved(latest, now());
    if (latest.leaseGeneration !== upload.leaseGeneration || value.expiresAt !== expiresAt || value.method !== "PUT"
      || !Number.isSafeInteger(value.resumeOffsetBytes) || value.resumeOffsetBytes < 0 || value.resumeOffsetBytes > upload.sizeBytes) fail("temporarily_unavailable");
    return value;
  }
  async function run(request: Request, actor: PhotoTransferActor, method: "GET" | "POST", action: (owner: string, signal: AbortSignal) => Promise<Response>) {
    try {
      const verified = authorize(request, actor, deps.origins, now(), method === "POST");
      if (request.method !== method) fail("invalid_request");
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
      signal.throwIfAborted();
      return await action(verified.userId, signal);
    } catch (error) { return errorResponse(error); }
  }
  const uploadAction = (request: Request, actor: PhotoTransferActor, id: string, operation: "renew" | "cancel" | "complete") => run(request, actor, "POST", async (owner, signal) => {
    const uploadId = resourceId(id);
    // Authorize ownership before binding a request key or touching storage.
    let upload = requireUpload(await deps.store.upload(owner, uploadId));
    const body = await readBody(request, signal); closed(body, []);
    if (operation === "renew") {
      const value = await ticket(request, owner, upload, signal);
      const visible = await publicUpload(owner, upload);
      if (visible.state !== "reserved") fail("upload_state_conflict");
      return json({ upload: { ...visible, uploadedBytes: value.resumeOffsetBytes }, ticket: value });
    }
    const replayed = await deps.journal.bind({ owner, operation: `uploads.${operation}`, resourceId: uploadId, key: idempotency(request), requestHash: canonicalHash({ uploadId }) });
    // Recheck after the durable key binding: a concurrent cancel/complete may have won.
    upload = requireUpload(await deps.store.upload(owner, uploadId));
    if (operation === "cancel") {
      const cancelled = requireUpload(await deps.store.cancel(owner, uploadId));
      const staged = await deps.storage.stat(stageKey(uploadId), null, signal);
      if (staged) await deps.store.orphan(owner, { uploadId, objectKey: staged.key, objectGeneration: staged.generation, reason: "cancelled_upload" });
      return json({ value: await publicUpload(owner, cancelled), replayed });
    }
    if (upload.state === "stored") return json({ value: await publicUpload(owner, upload), replayed: true });
    if (upload.state === "expired" || Date.parse(upload.expiresAt) <= now()) fail("upload_expired");
    if (upload.state === "rejected") fail(upload.rejectionCode ?? "content_rejected");
    if (upload.state === "cancelled") fail("upload_state_conflict");
    if (upload.state === "verifying" && upload.verificationLeaseUntil && Date.parse(upload.verificationLeaseUntil) > now()) {
      return json({ value: await publicUpload(owner, upload), replayed }, 202);
    }
    let claim: PhotoUploadRecord;
    try { claim = requireUpload(await deps.store.claim(owner, uploadId)); }
    catch (error) {
      // Another valid claimant may have won between the read and claim.
      const latest = requireUpload(await deps.store.upload(owner, uploadId));
      if (latest.state === "stored") return json({ value: await publicUpload(owner, latest), replayed: true });
      if (latest.state === "verifying" && latest.verificationLeaseUntil && Date.parse(latest.verificationLeaseUntil) > now()) return json({ value: await publicUpload(owner, latest), replayed }, 202);
      throw error;
    }
    let stage: PhotoObject | null = null; let final: PhotoObject | null = null;
    try {
      stage = await deps.storage.stat(stageKey(uploadId), null, signal);
      if (!stage || stage.key !== stageKey(uploadId)) fail("content_rejected");
      // All further reads and copies bind the pinned generation, never latest.
      const verified = await verifyPhotoObject(deps.storage, deps.probe, claim, stage, signal);
      const destination = `photo/final/${uploadId}/${randomUUID()}`;
      final = await deps.storage.copy(stage, destination, signal);
      if (final.sizeBytes !== verified.sizeBytes || final.contentType !== verified.contentType || final.key !== destination) fail("content_rejected");
      const saved = await deps.store.complete(owner, uploadId, { ...verified, leaseGeneration: claim.leaseGeneration, objectKey: final.key, objectGeneration: final.generation });
      if (!saved) fail("not_found");
      // P02 atomically records deduplicated final copies; stage generations are always retired.
      await deps.store.orphan(owner, { uploadId, objectKey: stage.key, objectGeneration: stage.generation, reason: "late_upload" });
      const current = requireUpload(await deps.store.upload(owner, uploadId));
      return json({ value: await publicUpload(owner, current), replayed: replayed || saved.replayed });
    } catch (error) {
      // Ambiguous DB success is safe: P02 refuses to ledger a live asset generation.
      if (final) await deps.store.orphan(owner, { uploadId, objectKey: final.key, objectGeneration: final.generation, reason: "copy_db_failure" });
      if (error instanceof PhotoTransferError && ["content_rejected", "unsupported_format", "pixel_limit_exceeded"].includes(error.code)) {
        await deps.store.reject(owner, uploadId, claim.leaseGeneration, error.code as "content_rejected" | "unsupported_format" | "pixel_limit_exceeded");
        if (stage) await deps.store.orphan(owner, { uploadId, objectKey: stage.key, objectGeneration: stage.generation, reason: "rejected_upload" });
      }
      throw error;
    }
  });
  return {
    start: (request: Request, actor: PhotoTransferActor) => run(request, actor, "POST", async (owner, signal) => {
      const body = startBody(await readBody(request, signal));
      const target = body.target;
      const key = idempotency(request); const requestHash = canonicalHash(body);
      const replayed = await deps.journal.bind({ owner, operation: "uploads.start", resourceId: target.kind, key, requestHash });
      const reserved = await deps.store.reserve(owner, { operation: target.kind, sizeBytes: body.sizeBytes, sha256: body.sha256, contentType: body.contentType,
        ...(target.kind === "original" ? { fileName: target.fileName, format: target.format } : { targetPhotoId: target.photoId }), idempotencyKey: key, requestHash });
      if (!reserved) fail("not_found");
      if (reserved.status === "existing") {
        if (target.kind === "mask") {
          const stored = requireUpload(await deps.store.uploadByStartKey(owner, "mask", key));
          if (stored.operation !== "mask" || stored.targetPhotoId !== target.photoId || stored.sha256 !== body.sha256 || stored.state !== "stored") fail("temporarily_unavailable");
          return json({ value: { kind: "upload", upload: await publicUpload(owner, stored), ticket: null }, replayed });
        }
        const photo = await deps.store.photo(owner, reserved.photoId);
        if (!photo || photo.id !== reserved.photoId || photo.original.id !== reserved.assetId) fail("not_found"); if (photo.lifecycle === "trashed") fail("photo_trashed");
        return json({ value: { kind: "existing", photo: publicPhoto(photo) }, replayed });
      }
      const upload = requireUpload(await deps.store.upload(owner, reserved.upload.id));
      if (["cancelled", "expired", "rejected"].includes(upload.state)) {
        if (upload.state === "expired") fail("upload_expired");
        if (upload.state === "rejected") fail(upload.rejectionCode ?? "content_rejected");
        fail("upload_state_conflict");
      }
      let issued = null;
      if (upload.state === "reserved") {
        try { issued = await ticket(request, owner, upload, signal); }
        catch (error) { if (reserved.status === "created") await deps.store.cancel(owner, upload.id); throw error; }
      }
      const visible = await publicUpload(owner, upload);
      return json({ value: { kind: "upload", upload: visible.state === "reserved" ? { ...visible, uploadedBytes: issued?.resumeOffsetBytes ?? 0 } : visible, ticket: issued }, replayed: replayed || reserved.status === "replayed" }, reserved.status === "created" ? 201 : 200);
    }),
    get: (request: Request, actor: PhotoTransferActor, id: string) => run(request, actor, "GET", async (owner, signal) => {
      const upload = requireUpload(await deps.store.upload(owner, resourceId(id)));
      const offset = upload.state === "reserved" ? await deps.storage.progress(stageKey(upload.id), upload.sizeBytes, signal) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > upload.sizeBytes) fail("temporarily_unavailable");
      return json(await publicUpload(owner, upload, offset));
    }),
    renew: (request: Request, actor: PhotoTransferActor, id: string) => uploadAction(request, actor, id, "renew"),
    cancel: (request: Request, actor: PhotoTransferActor, id: string) => uploadAction(request, actor, id, "cancel"),
    complete: (request: Request, actor: PhotoTransferActor, id: string) => uploadAction(request, actor, id, "complete"),
    content: (request: Request, actor: PhotoTransferActor, photo: string, asset: string) => run(request, actor, "GET", async (owner, signal) => {
      const photoId = resourceId(photo); const assetId = resourceId(asset);
      const found = await deps.store.asset(owner, photoId, assetId);
      if (!found || found.photoId !== photoId || found.id !== assetId || found.deletionState !== "retained") fail("not_found");
      // Owner + relation checks precede Range parsing, including malformed ranges.
      let range;
      try { range = parseRange(request.headers.get("range"), found.sizeBytes); }
      catch (error) {
        if (!(error instanceof PhotoTransferError) || error.code !== "range_not_satisfiable") throw error;
        const response = errorResponse(error); response.headers.set("Content-Range", `bytes */${found.sizeBytes}`); return response;
      }
      const length = range ? range.end - range.start + 1 : found.sizeBytes;
      const body = boundedPhotoStream(await deps.storage.read(asObject(found), range, signal), length, signal);
      return new Response(body, { status: range ? 206 : 200, headers: { ...PRIVATE_PHOTO_HEADERS, "Content-Type": found.contentType,
        "Content-Length": String(length), "Accept-Ranges": "bytes", ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${found.sizeBytes}` } : {}) } });
    }),
    // P00 masks.get returns locator-free metadata. Binary reads use content.get with this asset ID.
    mask: (request: Request, actor: PhotoTransferActor, photo: string, surface: string) => run(request, actor, "GET", async (owner) => {
      const photoId = resourceId(photo); if (!isDigest(surface)) fail("not_found");
      const found = await deps.store.mask(owner, photoId, surface);
      if (!found || found.photoId !== photoId || found.sha256 !== surface || found.kind !== "mask" || found.deletionState !== "retained") fail("not_found");
      return json(publicPhotoAsset(found));
    }),
  };
}
