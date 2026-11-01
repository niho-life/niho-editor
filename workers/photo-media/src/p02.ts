import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  abandonPhotoMediaCandidates, allocatePhotoMediaCandidate, claimPhotoMediaJob, failPhotoMediaJob,
  getPhotoAsset, getPhotoMediaSource, publishPhotoMediaJob, stagePhotoMediaCandidate, supersedePhotoMediaJob,
} from "../../../packages/editor-store/src/photo-store.ts";
import type { Database } from "../../../packages/editor-store/src/types.ts";
import { matchesSource } from "./identity.ts";
import type { MediaClaim, MediaJobs, MediaObjects } from "./types.ts";

/** Private object locators stay inside the trusted worker/storage boundary. */
export type MediaObject = { readonly key: string; readonly generation: string; readonly sizeBytes: number; readonly contentType: string };
export type CreatedMediaObject = Pick<MediaObject, "generation" | "sizeBytes" | "contentType">;
/** No production backend is installed here. The accepted backend must honor cancellation and generation preconditions. */
export interface MediaObjectStorage {
  read(object: MediaObject, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
  /** Consume all bytes and create only at input.key if absent. The returned generation belongs to that exact key. */
  create(input: { readonly key: string; readonly bytes: AsyncIterable<Uint8Array>; readonly sizeBytes: number; readonly contentType: string; readonly ifGenerationMatch: 0 }, signal: AbortSignal): Promise<CreatedMediaObject>;
}

function assertOwner(owner: string): void {
  if (typeof owner !== "string" || !owner || owner.length > 512) throw new TypeError("photo-media: invalid owner");
}
function own(owner: string, claim: MediaClaim): void {
  if (claim.identity.ownerId !== owner) throw new TypeError("photo-media: foreign claim");
}
function invalid(): never { throw new Error("photo-media: invalid storage result"); }

/** The owner is supplied by the trusted scheduler, never by a job payload or an object locator. */
export function createP02MediaJobs(db: Database, owner: string): MediaJobs {
  assertOwner(owner);
  return {
    claim: (id) => claimPhotoMediaJob(db, owner, id),
    current: (requestedOwner, photoId) => requestedOwner === owner ? getPhotoMediaSource(db, owner, photoId) : Promise.resolve(null),
    publish: (claim, media, objects, deadlineAt) => {
      own(owner, claim);
      if (media.recipeRevision !== claim.identity.recipeRevision || media.rendererManifestSha256 !== claim.identity.rendererManifestSha256) invalid();
      return publishPhotoMediaJob(db, owner, claim, {
        thumbnailId: media.thumbnail.id, previewId: media.preview.id,
        workingCopy: media.workingCopy ? { assetId: media.workingCopy.asset.id, baseVersion: media.workingCopy.baseVersion, encoding: media.workingCopy.encoding, meta: media.workingCopy.meta } : null,
      }, objects.map(({ asset, generation }) => ({ id: asset.id, generation })), deadlineAt);
    },
    supersede: (claim) => { own(owner, claim); return supersedePhotoMediaJob(db, owner, claim); },
    fail: (claim, code, retryAt) => {
      own(owner, claim);
      // P02 retries transport/process interruptions. A decoder-confirmed image failure is terminal.
      const storedCode = code === "cancelled" && retryAt !== null ? "infrastructure_unavailable" : code;
      return failPhotoMediaJob(db, owner, claim, storedCode, code === "decoder_failed" ? null : retryAt);
    },
  };
}

/** P02 owns durable allocation, publication fencing and cleanup. This adapter never deletes objects. */
export function createP02MediaObjects(db: Database, owner: string, storage: MediaObjectStorage): MediaObjects {
  assertOwner(owner);
  return {
    async readOriginal(identity, signal) {
      if (identity.ownerId !== owner) throw new TypeError("photo-media: foreign original");
      signal.throwIfAborted();
      const source = await getPhotoMediaSource(db, owner, identity.photoId);
      if (!matchesSource(identity, source)) invalid();
      const asset = await getPhotoAsset(db, owner, identity.photoId, identity.original.assetId);
      if (!asset || asset.kind !== "original" || asset.objectGeneration !== identity.original.generation
        || asset.sha256 !== identity.original.sha256 || asset.sizeBytes !== identity.original.sizeBytes) invalid();
      signal.throwIfAborted();
      return storage.read({ key: asset.objectKey, generation: asset.objectGeneration, sizeBytes: asset.sizeBytes, contentType: asset.contentType }, signal);
    },
    async stage(claim, input, signal) {
      own(owner, claim);
      signal.throwIfAborted();
      if (!["thumbnail", "preview", "working-copy"].includes(input.kind) || !["image/jpeg", "image/png"].includes(input.contentType)) invalid();
      const candidate = await allocatePhotoMediaCandidate(db, owner, claim, {
        kind: input.kind as "thumbnail" | "preview" | "working-copy", sha256: input.sha256, sizeBytes: input.sizeBytes,
        contentType: input.contentType as "image/jpeg" | "image/png", width: input.width, height: input.height,
        objectKey: `photo/final/${claim.identity.photoId}/${randomUUID()}`,
      });
      if (!candidate) invalid();
      try {
        signal.throwIfAborted();
        let writtenBytes = 0, consumed = false;
        const digest = createHash("sha256");
        const bytes = (async function* () {
          const file = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.nlink !== 1) invalid();
            for await (const chunk of file.createReadStream({ signal, autoClose: false })) {
              writtenBytes += chunk.byteLength;
              if (writtenBytes > input.sizeBytes) invalid();
              digest.update(chunk);
              yield chunk;
            }
            consumed = true;
          } finally { await file.close(); }
        })();
        let created: CreatedMediaObject;
        try { created = await storage.create({ key: candidate.objectKey, bytes, sizeBytes: input.sizeBytes, contentType: input.contentType, ifGenerationMatch: 0 }, signal); }
        finally { await bytes.return(); }
        const object: MediaObject = { key: candidate.objectKey, generation: created.generation, sizeBytes: created.sizeBytes, contentType: created.contentType };
        // Record a known generation even after cancellation or inconsistent metadata, so cleanup can name it.
        if (typeof object.generation !== "string" || !object.generation || object.generation.length > 128) invalid();
        const staged = await stagePhotoMediaCandidate(db, owner, claim, candidate.id, object.generation);
        if (!staged || staged.state !== "staged" || staged.objectGeneration !== object.generation
          || object.sizeBytes !== input.sizeBytes || object.contentType !== input.contentType
          || !consumed || writtenBytes !== input.sizeBytes || digest.digest("hex") !== input.sha256) invalid();
        signal.throwIfAborted();
        // Verify the committed generation, rather than trusting storage metadata or the local file alone.
        let storedBytes = 0;
        const storedDigest = createHash("sha256");
        for await (const chunk of await storage.read(object, signal)) {
          signal.throwIfAborted();
          if (!(chunk instanceof Uint8Array)) invalid();
          storedBytes += chunk.byteLength;
          if (storedBytes > input.sizeBytes) invalid();
          storedDigest.update(chunk);
        }
        if (storedBytes !== input.sizeBytes || storedDigest.digest("hex") !== input.sha256) invalid();
        signal.throwIfAborted();
        return { id: candidate.id, generation: object.generation };
      } catch (error) {
        // Unknown/late writes retain their allocated key, including a null generation for provider reconciliation.
        await abandonPhotoMediaCandidates(db, owner, claim, [candidate.id]);
        throw error;
      }
    },
    async abandon(claim) {
      own(owner, claim);
      // Include interrupted stages whose return value never reached the executor. Published rows are excluded by P02.
      await abandonPhotoMediaCandidates(db, owner, claim);
    },
  };
}
