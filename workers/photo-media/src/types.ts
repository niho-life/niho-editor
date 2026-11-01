import type { JsonObject, MediaState, PhotoAsset, PhotoFormat, RecipeDocument, RenderCapability } from "../../../packages/photo-library-contract/src/v1.ts";

/** Private attempt/lease diagnostics, never a Photo API response or MediaState.failed.code. */
export type MediaAttemptFailure = "renderer_unavailable" | "unsupported_settings" | "decoder_failed" | "original_changed" | "timeout" | "cancelled" | "invalid_output" | "infrastructure_unavailable";
export type OriginalRef = { readonly assetId: string; readonly generation: string; readonly sha256: string; readonly sizeBytes: number };
export interface MediaSource {
  readonly ownerId: string;
  readonly photoId: string;
  readonly lifecycle: "active" | "trashed" | "purged";
  readonly lifecycleGeneration: number;
  readonly original: OriginalRef;
  readonly format: PhotoFormat;
  readonly width: number;
  readonly height: number;
  /** Server-selected canonical decoder/base, fixed before enqueue; null for direct raster input. */
  readonly baseVersion: string | null;
  readonly recipe: RecipeDocument;
}
export interface MediaIdentity {
  readonly ownerId: string;
  readonly photoId: string;
  readonly lifecycleGeneration: number;
  readonly original: OriginalRef;
  readonly format: PhotoFormat;
  readonly width: number;
  readonly height: number;
  readonly baseVersion: string | null;
  readonly recipeRevision: number;
  readonly settingsSha256: string;
  readonly rendererManifestSha256: string;
  readonly thumbnailMaxEdge: number;
  readonly previewMaxEdge: number;
  readonly workingCopyMaxEdge: number;
}
export interface MediaClaim {
  readonly jobId: string;
  readonly key: string;
  readonly identity: MediaIdentity;
  readonly generation: number;
  readonly attempt: number;
  readonly expiresAt: number;
}
export type StoredDerivative = { readonly asset: PhotoAsset; readonly generation: string };

/** P02 implements these operations atomically; no in-memory store is shipped as a runtime. */
export interface MediaJobs {
  claim(jobId: string): Promise<MediaClaim | null>;
  current(ownerId: string, photoId: string): Promise<MediaSource | null>;
  /** Compare claim generation, lease AND execution deadline, entire identity, current owner/lifecycle/recipe and library revision in one transaction. */
  publish(claim: MediaClaim, media: Extract<MediaState, { state: "ready" }>, objects: readonly StoredDerivative[], deadlineAt: number): Promise<boolean>;
  /** Private terminal superseded attempt state, CAS on the still-current claim generation only. Never change a newer job or expose this as photo media state. */
  supersede(claim: MediaClaim): Promise<boolean>;
  /** Private attempt/lease CAS while the identity remains active; retryAt=null is terminal. Lifecycle/job fencing makes this a no-op. Do not write these codes into public MediaState.failed; that wire union remains P00's three codes. */
  fail(claim: MediaClaim, code: MediaAttemptFailure, retryAt: number | null): Promise<boolean>;
}

export interface MediaObjects {
  /** P03 resolves this owner/photo/asset relation and reads exactly this immutable generation. */
  readOriginal(identity: MediaIdentity, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
  /** Register a durable cleanup record BEFORE writing; create-only and verify the written bytes/hash. Also cover interrupted/unknown-result writes. */
  stage(claim: MediaClaim, input: { path: string; kind: PhotoAsset["kind"]; sha256: string; sizeBytes: number; contentType: string; width: number; height: number }, signal: AbortSignal): Promise<{ id: string; generation: string }>;
  /** Queue candidates in P07's durable ledger; reconcile publication/reference state before deletion, including unknown publish results. Never delete a referenced output. */
  abandon(claim: MediaClaim, objects: readonly StoredDerivative[]): Promise<void>;
}

export interface ProviderOutput {
  readonly kind: "thumbnail" | "preview" | "working-copy";
  /** Regular file inside the runner's private scratch directory. */
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly contentType: "image/jpeg" | "image/png";
  readonly workingCopy?: { readonly baseVersion: string; readonly encoding: "png16" | "jpeg8"; readonly meta: JsonObject };
}
export interface VerifiedOutput {
  readonly width: number;
  readonly height: number;
  readonly contentType: "image/jpeg" | "image/png";
  readonly orientationApplied: boolean;
  readonly colorSpace: "srgb" | "canonical-working-copy";
  readonly privateMetadataRemoved: boolean;
  readonly workingCopyCompatible?: boolean;
}

/** Trusted server adapter. Install only after pinned-artifact and real decoder acceptance. A fake adapter is test-only. */
export interface MediaProvider {
  readonly renderer: RenderCapability;
  readonly acceptedFormats: readonly PhotoFormat[];
  /** Validate full settings with the pinned SDK, canonical settings hash, base and mask feature compatibility. */
  supports(recipe: RecipeDocument): boolean;
  /** Decoder must probe pixel limits before allocation, isolate resources, and terminate its process on abort. */
  render(input: { originalPath: string; scratchDirectory: string; source: MediaSource; identity: MediaIdentity; signal: AbortSignal }): Promise<readonly ProviderOutput[]>;
  /** Real decoder inspection, including output metadata/color/orientation; declarations from the client are insufficient. */
  inspect(output: ProviderOutput, signal: AbortSignal): Promise<VerifiedOutput>;
}

/** A decoder bridge uses this only for a confirmed media failure. Unknown errors remain infrastructure failures. */
export class MediaProviderError extends Error {
  readonly code: "decoder_failed" | "unsupported_settings" | "renderer_unavailable";
  constructor(code: "decoder_failed" | "unsupported_settings" | "renderer_unavailable") {
    super(`photo-media: ${code}`);
    this.code = code;
  }
}
