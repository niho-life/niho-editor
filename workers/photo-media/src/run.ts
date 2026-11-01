import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PHOTO_LIMITS, type MediaState } from "../../../packages/photo-library-contract/src/v1.ts";
import { isPinnedRenderer } from "./baseline.ts";
import { matchesSource, mediaJobKey } from "./identity.ts";
import type { MediaClaim, MediaAttemptFailure, MediaJobs, MediaObjects, MediaProvider, MediaSource, ProviderOutput, StoredDerivative } from "./types.ts";
import { MediaProviderError } from "./types.ts";

export const MEDIA_WORKER_LIMITS = Object.freeze({ concurrency: 1, timeoutMs: 60_000, maxAttempts: 3, thumbnailBytes: 2 * 1024 ** 2, previewBytes: 8 * 1024 ** 2, workingCopyBytes: 64 * 1024 ** 2 });
/** Private executor result; never serialize this union as a Photo API response. */
export type RunResult = "not_claimed" | "published" | "stale" | MediaAttemptFailure;
class RunError extends Error {
  readonly code: MediaAttemptFailure;
  constructor(code: MediaAttemptFailure) { super(`photo-media: ${code}`); this.code = code; }
}

function immutable<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const entry of Object.values(value)) immutable(entry, seen);
    Object.freeze(value);
  }
  return value;
}

function assertActive(signal: AbortSignal, expiresAt: number, now: () => number): void {
  if (signal.aborted) throw signal.reason instanceof RunError ? signal.reason : new RunError("cancelled");
  if (now() >= expiresAt) throw new RunError("timeout");
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let abort: () => void = () => {};
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

async function spoolOriginal(claim: MediaClaim, objects: MediaObjects, path: string, signal: AbortSignal, now: () => number, deadlineAt: number): Promise<void> {
  const input = await abortable(objects.readOriginal(claim.identity, signal), signal);
  const file = await open(path, "wx", 0o600);
  const digest = createHash("sha256");
  let size = 0;
  try {
    const iterator = input[Symbol.asyncIterator]();
    try {
      while (true) {
        const chunk = await abortable(iterator.next(), signal);
        if (chunk.done) break;
        assertActive(signal, deadlineAt, now);
        if (!(chunk.value instanceof Uint8Array)) throw new RunError("original_changed");
        size += chunk.value.byteLength;
        if (size > claim.identity.original.sizeBytes || size > PHOTO_LIMITS.maxFileBytes) throw new RunError("original_changed");
        digest.update(chunk.value);
        let offset = 0;
        while (offset < chunk.value.byteLength) {
          const { bytesWritten } = await file.write(chunk.value, offset, chunk.value.byteLength - offset);
          if (!bytesWritten) throw new RunError("decoder_failed");
          offset += bytesWritten;
        }
      }
    } finally {
      // An aborted remote reader may never settle; its adapter must close its connection on signal.
      const closing = iterator.return?.();
      if (signal.aborted) void Promise.resolve(closing).catch(() => {});
      else await abortable(Promise.resolve(closing), signal);
    }
    if (size !== claim.identity.original.sizeBytes || digest.digest("hex") !== claim.identity.original.sha256) throw new RunError("original_changed");
  } finally { await file.close(); }
}

function needsWorkingCopy(source: MediaSource): boolean {
  return !["jpeg", "png"].includes(source.format)
    || source.width * source.height > PHOTO_LIMITS.browserDirectMaxPixels
    || source.original.sizeBytes > (source.format === "jpeg" ? 64 : 10) * 1024 ** 2;
}

function validWorkingMeta(value: unknown): boolean {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const pending: [unknown, number][] = [[value, 0]];
    const seen = new Set<object>();
    let nodes = 0;
    while (pending.length) {
      const [entry, depth] = pending.pop()!;
      if (++nodes > 8192 || depth > PHOTO_LIMITS.maxJsonDepth) return false;
      if (entry === null || typeof entry === "string" || typeof entry === "boolean") continue;
      if (typeof entry === "number") { if (!Number.isFinite(entry)) return false; continue; }
      if (typeof entry !== "object" || seen.has(entry)) return false;
      seen.add(entry);
      if (!Array.isArray(entry) && ![Object.prototype, null].includes(Object.getPrototypeOf(entry))) return false;
      for (const child of Object.values(entry)) pending.push([child, depth + 1]);
    }
    return Buffer.byteLength(JSON.stringify(value)) <= PHOTO_LIMITS.maxWorkingCopyMetaBytes;
  } catch { return false; }
}

async function checkedOutput(output: ProviderOutput, scratch: string, provider: MediaProvider, source: MediaSource, signal: AbortSignal): Promise<{ path: string; sha256: string; sizeBytes: number }> {
  if (!["thumbnail", "preview", "working-copy"].includes(output.kind) || !["image/jpeg", "image/png"].includes(output.contentType)) throw new RunError("invalid_output");
  const edge = output.kind === "thumbnail" ? PHOTO_LIMITS.thumbnailMaxEdge : output.kind === "preview" ? PHOTO_LIMITS.previewMaxEdge : PHOTO_LIMITS.workingCopyMaxEdge;
  if (!Number.isSafeInteger(output.width) || !Number.isSafeInteger(output.height) || output.width < 1 || output.height < 1 || Math.max(output.width, output.height) > edge) throw new RunError("invalid_output");
  const candidate = resolve(output.path);
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !(await realpath(candidate)).startsWith(`${scratch}${sep}`)) throw new RunError("invalid_output");
  const limit = output.kind === "thumbnail" ? MEDIA_WORKER_LIMITS.thumbnailBytes : output.kind === "preview" ? MEDIA_WORKER_LIMITS.previewBytes : MEDIA_WORKER_LIMITS.workingCopyBytes;
  if (stat.size < 1 || stat.size > limit) throw new RunError("invalid_output");
  if (output.kind === "working-copy") {
    const work = output.workingCopy;
    if (!work || !source.baseVersion || work.baseVersion !== source.baseVersion
      || !["png16", "jpeg8"].includes(work.encoding)
      || output.contentType !== (work.encoding === "png16" ? "image/png" : "image/jpeg")
      || !validWorkingMeta(work.meta)) throw new RunError("invalid_output");
  } else if (output.workingCopy) throw new RunError("invalid_output");
  const inspected = await abortable(provider.inspect(output, signal), signal);
  if (inspected.width !== output.width || inspected.height !== output.height || inspected.contentType !== output.contentType
    || !inspected.orientationApplied || !inspected.privateMetadataRemoved
    || inspected.colorSpace !== (output.kind === "working-copy" ? "canonical-working-copy" : "srgb")
    || (output.kind === "working-copy" && !inspected.workingCopyCompatible)) throw new RunError("invalid_output");
  const digest = createHash("sha256");
  let size = 0;
  for await (const bytes of createReadStream(candidate, { signal })) {
    size += bytes.length;
    if (size > limit) throw new RunError("invalid_output");
    digest.update(bytes);
  }
  if (size !== stat.size) throw new RunError("invalid_output");
  return { path: candidate, sizeBytes: size, sha256: digest.digest("hex") };
}

/** One process has a bounded number of active jobs. Durable queue/lease state belongs to P02. */
export function createMediaExecutor(deps: { jobs: MediaJobs; objects: MediaObjects; provider: MediaProvider | null; now?: () => number; scratchRoot?: string; timeoutMs?: number; concurrency?: number }) {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? MEDIA_WORKER_LIMITS.timeoutMs;
  const concurrency = deps.concurrency ?? MEDIA_WORKER_LIMITS.concurrency;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MEDIA_WORKER_LIMITS.concurrency || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MEDIA_WORKER_LIMITS.timeoutMs) throw new RangeError("photo-media: invalid worker limits");
  let active = 0;
  return async function execute(jobId: string, externalSignal?: AbortSignal): Promise<RunResult> {
    if (active >= concurrency) return "not_claimed";
    active++;
    let claim: MediaClaim | null = null;
    let scratch: string | null = null;
    let published = false;
    const staged: StoredDerivative[] = [];
    const controller = new AbortController();
    const cancel = () => controller.abort(new RunError("cancelled"));
    externalSignal?.addEventListener("abort", cancel, { once: true });
    if (externalSignal?.aborted) cancel();
    let deadlineAt = now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => controller.abort(new RunError("timeout")), timeoutMs);
    try {
      if (controller.signal.aborted) return "cancelled";
      const claimed = await abortable(deps.jobs.claim(jobId), controller.signal);
      if (!claimed) return "not_claimed";
      claim = immutable(structuredClone(claimed));
      if (claim.key !== mediaJobKey(claim.identity) || claim.jobId !== jobId || !Number.isSafeInteger(claim.generation) || claim.generation < 1 || !Number.isSafeInteger(claim.attempt) || claim.attempt < 1 || claim.attempt > MEDIA_WORKER_LIMITS.maxAttempts || !Number.isFinite(claim.expiresAt)) return "stale";
      deadlineAt = Math.min(deadlineAt, claim.expiresAt);
      assertActive(controller.signal, deadlineAt, now);
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new RunError("timeout")), Math.max(1, deadlineAt - now()));
      const current = await abortable(deps.jobs.current(claim.identity.ownerId, claim.identity.photoId), controller.signal);
      const source = current ? immutable(structuredClone(current)) : null;
      if (!matchesSource(claim.identity, source)) { await abortable(deps.jobs.supersede(claim), controller.signal); return "stale"; }
      const provider = deps.provider;
      if (!provider || !isPinnedRenderer(provider.renderer) || !provider.acceptedFormats.includes(source.format)) throw new RunError("renderer_unavailable");
      if (!provider.renderer.settingsVersions.includes(source.recipe.settings.v) || !provider.renderer.engines.includes(source.recipe.settings.engine) || !provider.supports(source.recipe)) throw new RunError("unsupported_settings");
      if (needsWorkingCopy(source) && !source.baseVersion) throw new RunError("unsupported_settings");
      const scratchDirectory = await realpath(await mkdtemp(join(deps.scratchRoot ?? tmpdir(), "niho-photo-media-")));
      scratch = scratchDirectory;
      const originalPath = join(scratchDirectory, "original");
      await spoolOriginal(claim, deps.objects, originalPath, controller.signal, now, deadlineAt);
      const outputs = await abortable(provider.render({ originalPath, scratchDirectory, source, identity: claim.identity, signal: controller.signal }), controller.signal);
      assertActive(controller.signal, deadlineAt, now);
      if (outputs.length < 2 || outputs.length > 3 || new Set(outputs.map((entry) => entry.kind)).size !== outputs.length
        || !outputs.some((entry) => entry.kind === "thumbnail") || !outputs.some((entry) => entry.kind === "preview")
        || (needsWorkingCopy(source) && !outputs.some((entry) => entry.kind === "working-copy"))) throw new RunError("invalid_output");
      const checked = [];
      for (const output of outputs) checked.push({ output, file: await checkedOutput(output, scratchDirectory, provider, source, controller.signal) });
      if (!matchesSource(claim.identity, await abortable(deps.jobs.current(claim.identity.ownerId, claim.identity.photoId), controller.signal))) { await abortable(deps.jobs.supersede(claim), controller.signal); return "stale"; }
      for (const { output, file } of checked) {
        assertActive(controller.signal, deadlineAt, now);
        // stage owns interrupted writes in its durable ledger even if this call never returns.
        const stored = await abortable(deps.objects.stage(claim, { ...file, kind: output.kind, contentType: output.contentType, width: output.width, height: output.height }, controller.signal), controller.signal);
        if (typeof stored.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(stored.id)
          || stored.id === claim.identity.original.assetId || staged.some((entry) => entry.asset.id === stored.id)
          || typeof stored.generation !== "string" || !stored.generation || stored.generation.length > 128) {
          // The object port has violated its result contract. This is an infrastructure error;
          // the durable staging ledger owns cleanup even though this worker cannot name the object.
          throw new RunError("infrastructure_unavailable");
        }
        staged.push({ asset: { id: stored.id, kind: output.kind, sha256: file.sha256, sizeBytes: file.sizeBytes, contentType: output.contentType, width: output.width, height: output.height }, generation: stored.generation });
      }
      assertActive(controller.signal, deadlineAt, now);
      const thumbnail = staged.find((entry) => entry.asset.kind === "thumbnail")!.asset;
      const preview = staged.find((entry) => entry.asset.kind === "preview")!.asset;
      const work = outputs.find((entry) => entry.kind === "working-copy")?.workingCopy;
      const workingCopy = work ? { ...work, asset: staged.find((entry) => entry.asset.kind === "working-copy")!.asset } : null;
      const media: Extract<MediaState, { state: "ready" }> = { state: "ready", thumbnail, preview, workingCopy, recipeRevision: claim.identity.recipeRevision, rendererManifestSha256: claim.identity.rendererManifestSha256 };
      published = await abortable(deps.jobs.publish(claim, media, staged, deadlineAt), controller.signal);
      if (!published) await abortable(deps.jobs.supersede(claim), controller.signal);
      return published ? "published" : "stale";
    } catch (error) {
      const code: MediaAttemptFailure = controller.signal.aborted ? (controller.signal.reason as RunError).code : error instanceof RunError || error instanceof MediaProviderError ? error.code : "infrastructure_unavailable";
      if (claim) {
        const retryable = ["decoder_failed", "timeout", "cancelled", "infrastructure_unavailable"].includes(code) && claim.attempt < MEDIA_WORKER_LIMITS.maxAttempts;
        try { await abortable(deps.jobs.fail(claim, code, retryable ? now() + Math.min(60_000, 1000 * 2 ** (claim.attempt - 1)) : null), AbortSignal.timeout(5000)); }
        catch { return "infrastructure_unavailable"; }
      }
      return code;
    } finally {
      if (timer) clearTimeout(timer);
      externalSignal?.removeEventListener("abort", cancel);
      let cleanupFailed = false;
      try { if (claim && !published) await abortable(deps.objects.abandon(claim, staged), AbortSignal.timeout(5000)); } catch { cleanupFailed = true; }
      try { if (scratch) await rm(scratch, { recursive: true, force: true }); } catch { cleanupFailed = true; }
      active--;
      if (cleanupFailed) return "infrastructure_unavailable";
    }
  };
}
