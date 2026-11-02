import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import baseline from "../../../packages/photo-library-contract/sdk-baseline.json" with { type: "json" };
import { PHOTO_LIMITS, type Json } from "../../../packages/photo-library-contract/src/v1.ts";
import { isEditableDevelopSettings, readDevelopSettings, supportsDevelopSettingsWrite } from "niho-photo-contract";
import { inspectPng, markSrgbPng } from "./png.ts";

const ENGINE = baseline.engine.version;
const CRATE_VERSION = baseline.engine.crateVersion;
const ENGINE_PREFIX = `niho_develop_wasm-${CRATE_VERSION}`;
const MAX_PIXELS = PHOTO_LIMITS.browserDirectMaxPixels;
const SHA256 = /^[a-f0-9]{64}$/;

type Settings = Record<string, Json> & { readonly v: number; readonly engine: string; readonly base: null };
type Request = {
  readonly originalPath: string;
  readonly scratchDirectory: string;
  readonly format: "jpeg" | "png";
  readonly width: number;
  readonly height: number;
  readonly settings: Settings;
  readonly settingsSha256: string;
};

function record(value: unknown): value is Record<string, unknown> {
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
  if (depth > PHOTO_LIMITS.maxJsonDepth) throw new TypeError("invalid settings");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    if (!scalarString(value)) throw new TypeError("invalid settings");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("invalid settings");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  if (!record(value)) throw new TypeError("invalid settings");
  return `{${Object.keys(value).sort().map((key) => {
    if (!scalarString(key)) throw new TypeError("invalid settings");
    return `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`;
  }).join(",")}}`;
}

function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

function verifyBytes(bytes: Uint8Array, expected: { readonly sha256: string; readonly size: number }): void {
  if (bytes.byteLength !== expected.size || digest(bytes) !== expected.sha256) throw new Error("runtime unavailable");
}

async function loadVerifiedRuntime() {
  try {
    const sdkVersion = /^photo-sdk-v(\d+\.\d+\.\d+)$/.exec(baseline.releaseTag)?.[1];
    if (!sdkVersion
      || baseline.sourceCommit.length !== 40 || !SHA256.test(baseline.engine.manifest.sha256)) throw new Error("baseline unavailable");
    const contractPackageUrl = new URL(import.meta.resolve("niho-photo-contract/package.json"));
    const contractPackage: unknown = JSON.parse((await readFile(contractPackageUrl)).toString("utf8"));
    if (!record(contractPackage) || contractPackage.version !== sdkVersion) throw new Error("contract package unavailable");
    const manifestSpecifier = "niho-photo-develop-engine-runtime/manifest";
    const manifestBytes = await readFile(new URL(import.meta.resolve(manifestSpecifier)));
    verifyBytes(manifestBytes, { sha256: baseline.engine.manifest.sha256, size: baseline.engine.manifest.size });
    const parsed: unknown = JSON.parse(manifestBytes.toString("utf8"));
    if (!record(parsed) || parsed.schemaVersion !== 1 || parsed.engine !== ENGINE || parsed.version !== CRATE_VERSION
      || !record(parsed.source) || parsed.source.repository !== baseline.repository || parsed.source.commit !== baseline.sourceCommit || !record(parsed.files)) throw new Error("manifest unavailable");
    const files = parsed.files;
    const metadata = (file: string): { readonly sha256: string; readonly size: number } => {
      const entry = files[file];
      if (!record(entry) || typeof entry.sha256 !== "string" || typeof entry.bytes !== "number") throw new Error("manifest file unavailable");
      return { sha256: entry.sha256, size: entry.bytes };
    };
    const glue = `${ENGINE_PREFIX}.js`;
    const wasm = `niho_develop_wasm_bg-${CRATE_VERSION}.wasm`;
    const glueSpecifier = `niho-photo-develop-engine-runtime/${glue}`;
    const wasmSpecifier = `niho-photo-develop-engine-runtime/${wasm}`;
    const runtimePackageUrl = new URL("../../package.json", new URL(import.meta.resolve(glueSpecifier)));
    const runtimePackage: unknown = JSON.parse((await readFile(runtimePackageUrl)).toString("utf8"));
    if (!record(runtimePackage) || runtimePackage.version !== sdkVersion) throw new Error("runtime package unavailable");
    const [glueBytes, wasmBytes] = await Promise.all([
      readFile(new URL(import.meta.resolve(glueSpecifier))),
      readFile(new URL(import.meta.resolve(wasmSpecifier))),
    ]);
    verifyBytes(glueBytes, metadata(glue));
    verifyBytes(wasmBytes, metadata(wasm));
    const runtime = await import(glueSpecifier) as {
      initSync: (input: { module: Uint8Array }) => unknown;
      imageSize: (input: Uint8Array) => unknown;
      rasterDecodeSize: (settings: string, width: number, height: number, maxEdge: number, cap: number) => number;
      exportPng: (input: Uint8Array, settings: string, maxEdge: number, cap: number) => Uint8Array;
      validateSettings: (settings: string) => string;
      version: () => string;
    };
    runtime.initSync({ module: wasmBytes });
    if (runtime.version() !== `niho-develop ${CRATE_VERSION} (engine ${ENGINE})`) throw new Error("runtime version unavailable");
    return runtime;
  } catch {
    throw new Error("renderer_unavailable");
  }
}

async function readRequest(): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > PHOTO_LIMITS.maxRecipeBytes + 8192) throw new Error("invalid request");
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!record(value) || typeof value.originalPath !== "string" || !isAbsolute(value.originalPath)
    || typeof value.scratchDirectory !== "string" || !isAbsolute(value.scratchDirectory)
    || (value.format !== "jpeg" && value.format !== "png") || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
    || !record(value.settings) || typeof value.settingsSha256 !== "string") throw new Error("invalid request");
  return value as unknown as Request;
}

function validSettings(request: Request): { readonly value: string } | null {
  try {
    const settings = request.settings;
    const canonical = canonicalJson(settings);
    if (Buffer.byteLength(canonical) > PHOTO_LIMITS.maxRecipeBytes || !SHA256.test(request.settingsSha256)
      || digest(Buffer.from(canonical)) !== request.settingsSha256 || !supportsDevelopSettingsWrite(settings)
      || !readDevelopSettings(settings) || !isEditableDevelopSettings(settings)
      || settings.base !== null || Object.hasOwn(settings, "geometry") || Object.hasOwn(settings, "masks")
      || !baseline.recipeCompatibility.supportedVersions.includes(settings.v)
      || !baseline.recipeCompatibility.engineIdentifiers.includes(settings.engine)) return null;
    return { value: canonical };
  } catch { return null; }
}

function imageSize(value: unknown): { readonly width: number; readonly height: number } | null {
  if (!record(value) || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)) return null;
  return { width: value.width as number, height: value.height as number };
}

async function render(): Promise<unknown> {
  let request: Request;
  try { request = await readRequest(); }
  catch { return { ok: false, code: "unsupported_settings" }; }
  const settings = validSettings(request);
  if (!settings) return { ok: false, code: "unsupported_settings" };
  let runtime: Awaited<ReturnType<typeof loadVerifiedRuntime>>;
  try { runtime = await loadVerifiedRuntime(); }
  catch { return { ok: false, code: "renderer_unavailable" }; }

  try {
    const scratchStat = await lstat(request.scratchDirectory);
    if (!scratchStat.isDirectory() || scratchStat.isSymbolicLink()) throw new Error("invalid scratch directory");
    const scratch = await realpath(request.scratchDirectory);
    const file = await lstat(request.originalPath);
    const maxBytes = request.format === "jpeg" ? 64 * 1024 ** 2 : 10 * 1024 ** 2;
    const originalPath = await realpath(request.originalPath);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || !originalPath.startsWith(`${scratch}${sep}`)
      || file.size < 1 || file.size > maxBytes) throw new Error("invalid original");
    const original = await readFile(originalPath);
    if (request.format === "png") {
      const png = inspectPng(original);
      if (!original.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("format mismatch");
      void png;
    } else if (original[0] !== 0xff || original[1] !== 0xd8) {
      throw new Error("format mismatch");
    }
    const dimensions = imageSize(runtime.imageSize(original));
    if (!dimensions || dimensions.width !== request.width || dimensions.height !== request.height
      || dimensions.width < 1 || dimensions.height < 1 || dimensions.width * dimensions.height > MAX_PIXELS) throw new Error("source dimensions mismatch");
    const wasmErrors: unknown = JSON.parse(runtime.validateSettings(settings.value));
    if (!Array.isArray(wasmErrors) || wasmErrors.length !== 0) return { ok: false, code: "unsupported_settings" };
    const outputs: { kind: "thumbnail" | "preview"; file: string; width: number; height: number }[] = [];
    for (const [kind, maxEdge] of [["thumbnail", PHOTO_LIMITS.thumbnailMaxEdge], ["preview", PHOTO_LIMITS.previewMaxEdge]] as const) {
      const decodedEdge = runtime.rasterDecodeSize(settings.value, dimensions.width, dimensions.height, maxEdge, MAX_PIXELS);
      if (!Number.isSafeInteger(decodedEdge) || decodedEdge < 1 || decodedEdge > maxEdge) throw new Error("decode limit rejected");
      const raw = runtime.exportPng(original, settings.value, maxEdge, MAX_PIXELS);
      const bytes = markSrgbPng(raw);
      const info = inspectPng(bytes, { output: true });
      const sdkInfo = imageSize(runtime.imageSize(bytes));
      if (!sdkInfo || sdkInfo.width !== info.width || sdkInfo.height !== info.height
        || Math.max(info.width, info.height) > maxEdge || info.width * info.height > MAX_PIXELS) throw new Error("invalid rendered output");
      const name = `${kind}.png`;
      await writeFile(join(scratch, name), bytes, { flag: "wx", mode: 0o600 });
      outputs.push({ kind, file: name, width: info.width, height: info.height });
    }
    return { ok: true, outputs };
  } catch {
    return { ok: false, code: "decoder_failed" };
  }
}

const result = await render();
process.stdout.write(JSON.stringify(result));
