import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IDS, recipe } from "../../../packages/photo-library-contract/fixtures/v1.ts";
import { createPinnedWasmMediaProvider } from "../src/pinned-provider.ts";
import { inspectPng } from "../src/png.ts";
import { MediaProviderError } from "../src/types.ts";
import { syntheticOrientedJpeg } from "./synthetic-jpeg.mjs";
import { syntheticPng, withSyntheticTextMetadata } from "./synthetic-png.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const png = syntheticPng();
const canonical = (value) => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const rehash = (settings) => ({ ...structuredClone(recipe), settings: structuredClone(settings), settingsSha256: sha(Buffer.from(canonical(settings))) });

function source(overrides = {}) {
  return {
    ownerId: IDS.userA,
    photoId: IDS.photo,
    lifecycle: "active",
    lifecycleGeneration: 1,
    original: { assetId: IDS.original, generation: "1", sha256: sha(png), sizeBytes: png.length },
    format: "png",
    width: 2,
    height: 1,
    baseVersion: null,
    recipe: structuredClone(recipe),
    ...overrides,
  };
}

test("pinned v0.1.7 runtime decodes bounded PNG and emits metadata-free sRGB derivatives", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "photo-media-pinned-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalPath = join(root, "original.png");
  await writeFile(originalPath, png, { mode: 0o600 });
  const provider = createPinnedWasmMediaProvider();
  const item = source();
  assert.equal(provider.renderer.sdkVersion, "0.1.7");
  assert.equal(provider.supports(item.recipe), true);
  const outputs = await provider.render({ originalPath, scratchDirectory: root, source: item, identity: {}, signal: new AbortController().signal });
  assert.deepEqual(outputs.map((output) => output.kind).sort(), ["preview", "thumbnail"]);
  for (const output of outputs) {
    const verified = await provider.inspect(output, new AbortController().signal);
    assert.equal(verified.colorSpace, "srgb");
    assert.equal(verified.privateMetadataRemoved, true);
    const bytes = await readFile(output.path);
    const parsed = inspectPng(bytes, { output: true });
    assert.deepEqual(parsed.chunks, ["IHDR", "sRGB", "IDAT", "IEND"]);
    assert.equal(parsed.width, 2);
    assert.equal(parsed.height, 1);
  }
});

test("future, masked, geometry, based, and hash-mismatched recipes fail closed", async () => {
  const provider = createPinnedWasmMediaProvider();
  const cases = [
    { ...structuredClone(recipe), settingsSha256: "a".repeat(64) },
    rehash({ ...recipe.settings, futureField: true }),
    rehash({ ...recipe.settings, geometry: { rotate: 90 } }),
    rehash({ ...recipe.settings, masks: [] }),
    { ...structuredClone(recipe), baseVersion: "base-1" },
  ];
  for (const candidate of cases) assert.equal(provider.supports(candidate), false);
});

test("PNG inspection rejects bad CRCs and derivative metadata chunks", () => {
  const corrupted = Buffer.from(png);
  corrupted[corrupted.length - 5] ^= 1;
  assert.throws(() => inspectPng(corrupted), /invalid png/);
  assert.throws(() => inspectPng(withSyntheticTextMetadata(png), { output: true }), /unsafe png output/);
});

test("pinned JPEG decoder applies EXIF orientation and strips original metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "photo-media-pinned-jpeg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalPath = join(root, "original.jpg");
  await writeFile(originalPath, syntheticOrientedJpeg, { mode: 0o600 });
  const provider = createPinnedWasmMediaProvider();
  const item = source({
    original: { assetId: IDS.original, generation: "1", sha256: sha(syntheticOrientedJpeg), sizeBytes: syntheticOrientedJpeg.length },
    format: "jpeg",
    width: 1,
    height: 2,
  });
  const outputs = await provider.render({ originalPath, scratchDirectory: root, source: item, identity: {}, signal: new AbortController().signal });
  for (const output of outputs) {
    assert.equal(output.contentType, "image/png");
    assert.equal(output.width, 1);
    assert.equal(output.height, 2);
    const verified = await provider.inspect(output, new AbortController().signal);
    assert.equal(verified.orientationApplied, true);
    assert.equal(verified.privateMetadataRemoved, true);
    assert.deepEqual(inspectPng(await readFile(output.path), { output: true }).chunks, ["IHDR", "sRGB", "IDAT", "IEND"]);
  }
});

test("malformed or mismatched image bytes are a decoder failure without output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "photo-media-pinned-bad-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bad = Buffer.from("not a png");
  const originalPath = join(root, "original.png");
  await writeFile(originalPath, bad, { mode: 0o600 });
  const provider = createPinnedWasmMediaProvider();
  const item = source({ original: { assetId: IDS.original, generation: "1", sha256: sha(bad), sizeBytes: bad.length } });
  await assert.rejects(provider.render({ originalPath, scratchDirectory: root, source: item, identity: {}, signal: new AbortController().signal }), (error) => {
    assert.ok(error instanceof MediaProviderError);
    assert.equal(error.code, "decoder_failed");
    return true;
  });
});

test("aborted render terminates the isolated decoder process", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "photo-media-pinned-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalPath = join(root, "original.png");
  await writeFile(originalPath, png, { mode: 0o600 });
  const provider = createPinnedWasmMediaProvider();
  const abort = new AbortController();
  abort.abort(new Error("test abort"));
  await assert.rejects(provider.render({ originalPath, scratchDirectory: root, source: source(), identity: {}, signal: abort.signal }), /test abort/);
});
