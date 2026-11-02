import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import baseline from "../../../packages/photo-library-contract/sdk-baseline.json" with { type: "json" };
import { PHOTO_LIMITS, type RecipeDocument } from "../../../packages/photo-library-contract/src/v1.ts";
import { isEditableDevelopSettings, readDevelopSettings, supportsDevelopSettingsWrite } from "niho-photo-contract";
import { MEDIA_BASELINE } from "./baseline.ts";
import { inspectPng } from "./png.ts";
import { MediaProviderError, type MediaProvider, type MediaSource, type ProviderOutput, type VerifiedOutput } from "./types.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const DIRECT_MAX_PIXELS = PHOTO_LIMITS.browserDirectMaxPixels;
const MAX_SETTINGS_BYTES = PHOTO_LIMITS.maxRecipeBytes;
const OUTPUT_LIMITS = Object.freeze({ thumbnail: 2 * 1024 ** 2, preview: 8 * 1024 ** 2 });

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function scalarString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > PHOTO_LIMITS.maxJsonDepth) throw new TypeError("invalid photo settings");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    if (!scalarString(value)) throw new TypeError("invalid photo settings");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("invalid photo settings");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  if (!plainRecord(value)) throw new TypeError("invalid photo settings");
  return `{${Object.keys(value).sort().map((key) => {
    if (!scalarString(key)) throw new TypeError("invalid photo settings");
    return `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`;
  }).join(",")}}`;
}

function validSettings(recipe: RecipeDocument): boolean {
  try {
    const settings = recipe.settings;
    const canonical = canonicalJson(settings);
    if (recipe.baseVersion !== null || Buffer.byteLength(canonical) > MAX_SETTINGS_BYTES || !SHA256.test(recipe.settingsSha256)
      || createSha256(canonical) !== recipe.settingsSha256 || !supportsDevelopSettingsWrite(settings)
      || !readDevelopSettings(settings) || !isEditableDevelopSettings(settings)
      || settings.base !== null || Object.hasOwn(settings, "geometry") || Object.hasOwn(settings, "masks")) return false;
    return baseline.recipeCompatibility.supportedVersions.includes(settings.v)
      && baseline.recipeCompatibility.engineIdentifiers.includes(settings.engine);
  } catch { return false; }
}

function createSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function acceptedSource(source: MediaSource): boolean {
  const maxBytes = source.format === "jpeg" ? 64 * 1024 ** 2 : source.format === "png" ? 10 * 1024 ** 2 : 0;
  return maxBytes > 0 && source.recipe.baseVersion === null && source.baseVersion === null
    && source.recipe.maskSurfaceIds.length === 0
    && Number.isSafeInteger(source.width) && Number.isSafeInteger(source.height)
    && source.width > 0 && source.height > 0 && source.width * source.height <= DIRECT_MAX_PIXELS
    && source.original.sizeBytes > 0 && source.original.sizeBytes <= maxBytes;
}

interface ChildResult {
  readonly ok: true;
  readonly outputs: readonly { readonly kind: "thumbnail" | "preview"; readonly file: string; readonly width: number; readonly height: number }[];
}

interface ChildFailure { readonly ok: false; readonly code: "renderer_unavailable" | "unsupported_settings" | "decoder_failed" }

function childMessage(stdout: Buffer): ChildResult | ChildFailure | null {
  if (stdout.byteLength < 2 || stdout.byteLength > 64 * 1024) return null;
  try {
    const value: unknown = JSON.parse(stdout.toString("utf8"));
    if (!plainRecord(value) || typeof value.ok !== "boolean") return null;
    if (value.ok === false && ["renderer_unavailable", "unsupported_settings", "decoder_failed"].includes(String(value.code))) return value as unknown as ChildFailure;
    if (value.ok !== true || !Array.isArray(value.outputs) || value.outputs.length !== 2) return null;
    const outputs = value.outputs as unknown[];
    const normalized = outputs.map((entry) => {
      if (!plainRecord(entry) || (entry.kind !== "thumbnail" && entry.kind !== "preview")
        || typeof entry.file !== "string" || !["thumbnail.png", "preview.png"].includes(entry.file)
        || !Number.isSafeInteger(entry.width) || !Number.isSafeInteger(entry.height)) return null;
      return entry as unknown as ChildResult["outputs"][number];
    });
    if (normalized.some((entry) => entry === null) || new Set(normalized.map((entry) => entry!.kind)).size !== 2) return null;
    return { ok: true, outputs: normalized as ChildResult["outputs"] };
  } catch { return null; }
}

async function runIsolated(input: {
  readonly originalPath: string;
  readonly scratchDirectory: string;
  readonly source: MediaSource;
  readonly signal: AbortSignal;
}): Promise<readonly ProviderOutput[]> {
  if (input.signal.aborted) throw input.signal.reason ?? new Error("cancelled");
  const childPath = fileURLToPath(new URL("./pinned-provider-child.ts", import.meta.url));
  const child = spawn(process.execPath, ["--max-old-space-size=256", childPath], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  let stdout = Buffer.alloc(0);
  let overflow = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (stdout.byteLength + chunk.byteLength > 64 * 1024) { overflow = true; child.kill("SIGKILL"); return; }
    stdout = Buffer.concat([stdout, chunk]);
  });
  const request = JSON.stringify({
    originalPath: input.originalPath,
    scratchDirectory: input.scratchDirectory,
    format: input.source.format,
    width: input.source.width,
    height: input.source.height,
    settings: input.source.recipe.settings,
    settingsSha256: input.source.recipe.settingsSha256,
  });
  if (Buffer.byteLength(request) > MAX_SETTINGS_BYTES + 4096) { child.kill("SIGKILL"); throw new MediaProviderError("unsupported_settings"); }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      input.signal.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve();
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", () => settle(new MediaProviderError("renderer_unavailable")));
    child.once("close", (code, signal) => {
      if (input.signal.aborted) { settle(input.signal.reason instanceof Error ? input.signal.reason : new Error("cancelled")); return; }
      if (overflow || code !== 0 || signal) { settle(new MediaProviderError("renderer_unavailable")); return; }
      const result = childMessage(stdout);
      if (!result) { settle(new MediaProviderError("renderer_unavailable")); return; }
      if (!result.ok) {
        settle(new MediaProviderError(result.code === "renderer_unavailable" ? "renderer_unavailable" : result.code));
        return;
      }
      settle();
    });
    child.stdin.once("error", () => settle(new MediaProviderError("renderer_unavailable")));
    child.stdin.end(request);
    // Keep abort behavior deterministic even if abort happened between the first check and listener registration.
    if (input.signal.aborted) onAbort();
  }).catch((error: unknown) => { throw error; });

  const result = childMessage(stdout);
  if (!result?.ok) throw new MediaProviderError("renderer_unavailable");
  return result.outputs.map((entry) => ({
    kind: entry.kind,
    path: `${input.scratchDirectory}/${entry.file}`,
    width: entry.width,
    height: entry.height,
    contentType: "image/png",
  }));
}

/** Candidate P06 adapter. It is intentionally not registered as a production provider. */
export function createPinnedWasmMediaProvider(): MediaProvider {
  const renderer = Object.freeze({
    ...MEDIA_BASELINE,
    settingsVersions: [...baseline.recipeCompatibility.supportedVersions],
    engines: [...baseline.recipeCompatibility.engineIdentifiers],
    features: [],
    maskKinds: [],
    maskSurfaces: false,
  });
  return {
    renderer,
    acceptedFormats: ["jpeg", "png"],
    supports(recipe) { return validSettings(recipe); },
    async render(input) {
      if (!acceptedSource(input.source) || !validSettings(input.source.recipe)) throw new MediaProviderError("unsupported_settings");
      return runIsolated(input);
    },
    async inspect(output, signal): Promise<VerifiedOutput> {
      if (signal.aborted) throw signal.reason ?? new Error("cancelled");
      const limit = output.kind === "thumbnail" ? OUTPUT_LIMITS.thumbnail : output.kind === "preview" ? OUTPUT_LIMITS.preview : 0;
      if (!limit) throw new MediaProviderError("decoder_failed");
      const info = await lstat(output.path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > limit) throw new MediaProviderError("decoder_failed");
      const bytes = await readFile(output.path);
      if (signal.aborted) throw signal.reason ?? new Error("cancelled");
      if (bytes.byteLength !== info.size || bytes.byteLength > limit) throw new MediaProviderError("decoder_failed");
      const png = inspectPng(bytes, { output: true });
      if (!png.chunks.includes("sRGB") || Math.max(png.width, png.height) > (output.kind === "thumbnail" ? PHOTO_LIMITS.thumbnailMaxEdge : PHOTO_LIMITS.previewMaxEdge)) throw new MediaProviderError("decoder_failed");
      return {
        width: png.width,
        height: png.height,
        contentType: "image/png",
        orientationApplied: true,
        colorSpace: "srgb",
        privateMetadataRemoved: true,
      };
    },
  };
}
