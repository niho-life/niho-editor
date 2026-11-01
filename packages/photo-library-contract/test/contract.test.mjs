import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PHOTO_API_PREFIX, PHOTO_ERROR_STATUS, PHOTO_LIMITS, PHOTO_ROUTES } from "../src/v1.ts";
import {
  emptyLibrary, emptyPage, failedMediaPhoto, fullLibrary, futureRecipePhoto, library,
  maskedPhoto, mask, page, pendingMediaPhoto, readyPhoto, recipe, responses, storedPhoto, trashedPhoto,
  verifyingUpload,
} from "../fixtures/v1.ts";

const load = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const baseline = await load("../sdk-baseline.json");
const vectors = await load("../fixtures/security-cases.json");
const design = await readFile(new URL("../../../docs/architecture/personal-photo-library.md", import.meta.url), "utf8");

test("every JSON operation has a fixture and a documented HTTP binding", () => {
  assert.equal(PHOTO_API_PREFIX, "/api/photo/v1");
  assert.deepEqual(Object.keys(responses).sort(), Object.keys(PHOTO_ROUTES).filter((k) => k !== "content.get").sort());
  const bindings = new Set();
  for (const [name, route] of Object.entries(PHOTO_ROUTES)) {
    const binding = `${route.method} ${route.path}`;
    assert(!bindings.has(binding), `duplicate binding: ${name}`);
    bindings.add(binding);
    assert(design.includes(`| ${name} | ${route.method} \`${route.path}\``), `undocumented: ${name}`);
    assert(!/https?:|ownerId|spotId|tenantId|workspaceId/.test(route.path));
    if (route.method === "GET") assert.equal(route.idempotency, "none");
  }
});

test("capacity fixtures distinguish used, reservation, trash and physical purge", () => {
  assert.equal(PHOTO_LIMITS.quotaBytes, 5_368_709_120);
  for (const fixture of [library, emptyLibrary, fullLibrary]) {
    const u = fixture.usage;
    for (const value of Object.values(u)) assert(Number.isSafeInteger(value) && value >= 0);
    assert.equal(u.usedBytes, u.originalBytes + u.maskBytes);
    assert.equal(u.availableBytes, u.quotaBytes - u.usedBytes - u.reservedBytes);
    assert(u.trashBytes <= u.usedBytes && u.pendingPurgeBytes <= u.usedBytes);
  }
  assert.equal(emptyPage.items.length, 0);
  assert.equal(fullLibrary.usage.availableBytes, 0);
  assert.equal(page.items[0].id, readyPhoto.id);
  assert.equal(library.usage.originalBytes, storedPhoto.original.sizeBytes);
  assert.equal(library.usage.maskBytes, mask.sizeBytes);
});

test("metadata distinguishes verification, durable original, failed media and current preview", () => {
  assert.equal(verifyingUpload.state, "verifying");
  assert(!Object.hasOwn(verifyingUpload, "result"));
  assert.equal(storedPhoto.storageState, "stored");
  assert.equal(storedPhoto.media.state, "processing");
  assert.equal(pendingMediaPhoto.storageState, "stored");
  assert.deepEqual(pendingMediaPhoto.media, { state: "pending" });
  assert.equal(failedMediaPhoto.storageState, "stored");
  assert.deepEqual(failedMediaPhoto.original, storedPhoto.original);
  assert.equal(readyPhoto.media.recipeRevision, readyPhoto.recipe.revision);
  assert.equal(readyPhoto.media.rendererManifestSha256, baseline.engine.manifest.sha256);
  assert.equal(responses["recipes.put"].value.media.state, "processing");
  assert.equal(Date.parse(trashedPhoto.purgeAfter) - Date.parse(trashedPhoto.trashedAt), PHOTO_LIMITS.trashRetentionDays * 86_400_000);
});

test("unknown settings round-trip without normalization; masks resolve by content hash", () => {
  const copy = structuredClone(futureRecipePhoto);
  assert.deepEqual(JSON.parse(JSON.stringify(copy)).recipe.settings, futureRecipePhoto.recipe.settings);
  assert(!library.capabilities.renderer.settingsVersions.includes(copy.recipe.settings.v));
  assert.notEqual(copy.recipe.settingsSha256, recipe.settingsSha256);
  assert.deepEqual(copy.recipe.settings.futureField, { keep: [1, "opaque"] });
  assert.equal(maskedPhoto.recipe.settings.masks[0].surface.id, mask.sha256);
  assert.equal(maskedPhoto.recipe.maskSurfaceIds[0], responses["masks.get"].sha256);
  assert.notEqual(mask.sha256, mask.id);
});

test("recipe fixtures carry distinct hashes of canonical settings", () => {
  // Fixture JSON is ASCII with finite JSON numbers; the full runtime canonicalizer is P05's duty.
  const canonical = (v) => Array.isArray(v) ? v.map(canonical) :
    v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
  for (const r of [recipe, maskedPhoto.recipe, futureRecipePhoto.recipe]) {
    assert.equal(createHash("sha256").update(JSON.stringify(canonical(r.settings))).digest("hex"), r.settingsSha256);
  }
});

test("SDK baseline pins a complete release set and all declared recipe engines", () => {
  assert.match(baseline.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(baseline.releaseTag, "photo-sdk-v0.1.6");
  assert.equal(baseline.engine.crateVersion, "0.27.0");
  assert.equal(baseline.packages.length, 6);
  const names = new Set();
  for (const artifact of [baseline.manifest, baseline.receipt, baseline.engine.manifest, ...baseline.packages]) {
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert(!names.has(artifact.file));
    names.add(artifact.file);
  }
  assert.deepEqual(library.capabilities.renderer.engines, baseline.recipeCompatibility.engineIdentifiers);
  assert.deepEqual(library.capabilities.renderer.settingsVersions, baseline.recipeCompatibility.supportedVersions);
  assert.equal(baseline.uiSingleton.hostExport, "niho-photo-editing/sdk-dialog-host");
  assert(PHOTO_LIMITS.workingCopyMaxEdge ** 2 <= PHOTO_LIMITS.browserDirectMaxPixels);
});

test("machine-readable security vectors reference valid operations and stable errors", () => {
  assert.equal(vectors.contractVersion, 1);
  assert.equal(vectors.syntheticOnly, true);
  const ids = new Set();
  for (const c of vectors.cases) {
    assert(!ids.has(c.id), `duplicate case: ${c.id}`);
    ids.add(c.id);
    assert(Object.hasOwn(PHOTO_ROUTES, c.operation), c.operation);
    assert(["user-a", "user-b", "none", "revoked"].includes(c.actor));
    assert(c.expected.invariants.length > 0, c.id);
    if (c.expected.code) assert.equal(c.expected.status, PHOTO_ERROR_STATUS[c.expected.code], c.id);
    else assert(c.expected.status >= 200 && c.expected.status < 300, c.id);
    if (c.actor === "none" || c.actor === "revoked") assert.equal(c.expected.status, 401, c.id);
  }
  for (const required of ["owner-in-request", "foreign-original", "foreign-hash", "foreign-cursor", "cookie-origin", "revoked-content", "quota-concurrent-loser", "duplicate-complete", "cancel-verification", "complete-after-expiry", "generation-race", "recipe-stale", "missing-mask", "unknown-recipe", "pending-purge-retains-quota", "account-deleting"]) {
    assert(ids.has(required), `missing mandatory vector: ${required}`);
  }
});

test("fixtures do not share state across independently cloned consumers", () => {
  const mac = structuredClone(responses["photos.get"]);
  const iphone = structuredClone(responses["photos.get"]);
  mac.recipe.settings.exposure = 2;
  assert.equal(iphone.recipe.settings.exposure, 0);
  assert.equal(responses["photos.get"].recipe.settings.exposure, 0);
});
