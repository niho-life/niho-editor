import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  HASH, IDS, failedMediaPhoto, futureRecipePhoto, library as libraryFixture, mask, maskedPhoto, page, pendingMediaPhoto, readyPhoto, responses,
  trashedPhoto, versions,
} from "@niho/photo-library-contract/fixtures";
import { PHOTO_LIMITS } from "@niho/photo-library-contract";
import { BrowserPhotoSourceError, CloudPhotoError, createCloudPhotoLibrary } from "../src/index.ts";
import { parsePage, parsePhoto } from "../src/validate.ts";

const scope = { actorId: IDS.userA, libraryId: IDS.library, sessionEpoch: 1 };
const runtime = {
  settingsVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  engines: ["niho-14"],
  features: ["geometry", "masks"],
  acceptsRecipe: (settings) => !Object.hasOwn(settings, "futureField"),
  crop: true,
  mobile: false,
  engineManifestUrl: "/fixed/manifest-0.27.0.json",
};
const json = (value, init = {}) => Response.json(structuredClone(value), { status: 200, ...init });
const error = (code, status, extra = {}) => json({ error: { code, requestId: "synthetic-request", retryable: false, ...extra } }, { status });
const canonical = (value) => Array.isArray(value) ? value.map(canonical) :
  value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const canonicalSha256 = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

test("accepts pending media in photo details and list pages", () => {
  const photo = structuredClone(pendingMediaPhoto);
  assert.deepEqual(parsePhoto(photo, IDS.library, IDS.photo), photo);
  const pendingPage = { ...structuredClone(page), items: [photo] };
  assert.deepEqual(parsePage(pendingPage, IDS.library), pendingPage);
});

function fixtureFetch(overrides = {}) {
  const calls = [];
  let currentPhoto = structuredClone(overrides.photo ?? readyPhoto);
  const fetch = async (input, init) => {
    calls.push({ input, init });
    if (overrides.handler) {
      const handled = await overrides.handler(input, init, calls);
      if (handled) return handled;
    }
    const url = new URL(input, "https://host.invalid");
    const path = url.pathname;
    if (path.endsWith("/library")) return json(overrides.library ?? libraryFixture);
    if (path.endsWith("/photos") && init.method === "GET") return json({ ...page, items: [currentPhoto] });
    if (path.endsWith(`/photos/${encodeURIComponent(IDS.photo)}`)) return json(currentPhoto);
    if (path.endsWith(`/photos/${IDS.photo}/info`)) return json(responses["photos.info"]);
    if (path.endsWith("/photos/lookup")) return json(responses["photos.lookup"]);
    if (path.endsWith(`/photos/${IDS.photo}/recipe`)) {
      if (overrides.stale) return error("revision_conflict", 409, { currentRevision: 1 });
      currentPhoto = structuredClone(responses["recipes.put"].value);
      return json({ value: currentPhoto, replayed: false });
    }
    if (path.endsWith(`/photos/${IDS.photo}/versions`) && init.method === "GET") return json(overrides.versions ?? versions);
    if (path.endsWith(`/photos/${IDS.photo}/versions`) && init.method === "PUT") return json(responses["versions.put"]);
    if (path.endsWith(`/photos/${IDS.photo}/media`)) return json(responses["media.ensure"]);
    if (path.endsWith(`/photos/${IDS.photo}/trash`)) return json(responses["photos.trash"]);
    if (path.includes("/content/")) {
      const size = overrides.contentSize ?? readyPhoto.original.sizeBytes;
      return new Response(new Uint8Array(size), { status: 200, headers: { "content-length": String(size), "content-type": "image/jpeg" } });
    }
    if (path.includes("/masks/")) return json(mask);
    throw new Error(`unhandled fixture route: ${init.method} ${path}`);
  };
  return { fetch, calls, photo: () => currentPhoto };
}

function setup(overrides = {}) {
  let current = scope;
  const scopeListeners = new Set();
  const transport = fixtureFetch(overrides);
  const cloud = createCloudPhotoLibrary({
    scope,
    currentScope: () => current,
    authenticatedFetch: transport.fetch,
    runtime,
    randomId: (() => { let n = 0; return () => `opaque-${++n}`; })(),
    idempotencyKey: (operation) => `fixture-${operation.replaceAll(".", "-")}-0001`,
    subscribeScopeChange: (listener) => { scopeListeners.add(listener); return () => scopeListeners.delete(listener); },
  });
  return { cloud, transport, setScope: (value) => { current = value; for (const listener of scopeListeners) listener(); } };
}

test("P00 fixtureをlist/get/usageへ写し、formatと未対応filterを閉じる", async () => {
  const { cloud, transport } = setup();
  const listed = await cloud.library.list({ sort: "captured", kind: "heic", edited: false, limit: 200 });
  assert.equal(listed.items[0].id, IDS.photo);
  assert.equal(listed.items[0].contentSha256, HASH.original);
  assert.equal(listed.usage.usedBytes, libraryFixture.usage.usedBytes);
  const listCall = transport.calls.find((call) => String(call.input).includes("/photos?"));
  const query = new URL(listCall.input, "https://host.invalid").searchParams;
  assert.deepEqual(query.getAll("formats"), ["heic", "heif"]);
  assert.equal(query.get("sort"), "captured-desc");
  assert.equal(query.get("limit"), "100");
  assert.equal(query.has("actorId"), false);
  assert.equal(query.has("libraryId"), false);
  const got = await cloud.library.get(IDS.photo);
  assert.equal(got.developRevision, readyPhoto.recipe.revision);
  assert.deepEqual(await cloud.usage(), libraryFixture.usage);
  await assert.rejects(() => cloud.library.list({ favorite: true }), (reason) => reason instanceof CloudPhotoError && reason.code === "unsupported_operation");
});

test("opaque original refだけをrelative content routeへ送り、byte上限とsignalを守る", async () => {
  const { cloud, transport } = setup();
  const opened = await cloud.library.openOriginal(IDS.photo);
  assert.match(opened.source.ref, /^cloud-content:opaque-/);
  assert(!opened.source.ref.includes(IDS.photo));
  const file = await cloud.library.loadOriginal(IDS.photo, opened.source, {
    signal: new AbortController().signal, fileName: "local-name.jpg", maxBytes: readyPhoto.original.sizeBytes,
  });
  assert.equal(file.size, readyPhoto.original.sizeBytes);
  const contentCall = transport.calls.find((call) => String(call.input).includes("/content/"));
  assert.equal(String(contentCall.input).startsWith("/api/photo/v1/"), true);
  await assert.rejects(() => cloud.library.loadOriginal(IDS.photo, { ref: "https://evil.invalid/x", expiresAt: null }, {
    signal: new AbortController().signal, fileName: "x.jpg", maxBytes: 10,
  }), (reason) => reason instanceof CloudPhotoError && reason.code === "invalid_response");

  const oversized = setup({ contentSize: readyPhoto.original.sizeBytes + 1 });
  const source = await oversized.cloud.library.openOriginal(IDS.photo);
  await assert.rejects(() => oversized.cloud.library.loadOriginal(IDS.photo, source.source, {
    signal: new AbortController().signal, fileName: "x.jpg", maxBytes: readyPhoto.original.sizeBytes,
  }), (reason) => reason instanceof BrowserPhotoSourceError && reason.reason === "too_large");
});

test("recipe CASはexpectedRevision必須でsaved/staleをSDK形にする", async () => {
  const saved = setup();
  const photo = await saved.cloud.library.get(IDS.photo);
  await assert.rejects(() => saved.cloud.library.saveDevelopSettings(IDS.photo, photo.developSettings),
    (reason) => reason instanceof CloudPhotoError && reason.code === "invalid_request");
  const result = await saved.cloud.library.saveDevelopSettings(IDS.photo, photo.developSettings, { expectedRevision: 0 });
  assert.equal(result.kind, "saved");
  const put = saved.transport.calls.find((call) => call.init.method === "PUT" && String(call.input).endsWith("/recipe"));
  assert.match(put.init.headers.get("Idempotency-Key"), /^fixture-recipes-put-/);
  const body = JSON.parse(put.init.body);
  assert.equal(Object.hasOwn(body, "ownerId"), false);
  assert.equal(Object.hasOwn(body, "actorId"), false);
  assert.equal(Object.hasOwn(body, "libraryId"), false);

  const stale = setup({ stale: true });
  const stalePhoto = await stale.cloud.library.get(IDS.photo);
  const staleResult = await stale.cloud.library.saveDevelopSettings(IDS.photo, stalePhoto.developSettings, { expectedRevision: 0 });
  assert.equal(staleResult.kind, "stale");
});

test("未知recipeをrawで保全し、projection/open/save/versions書込をread-onlyにする", async () => {
  const { cloud, transport } = setup({ photo: futureRecipePhoto });
  const projected = await cloud.library.get(IDS.photo);
  assert.equal(projected.developSettings, null);
  assert.deepEqual(cloud.rawRecipe(IDS.photo).settings.futureField, { keep: [1, "opaque"] });
  await assert.rejects(() => cloud.library.openOriginal(IDS.photo), (reason) => reason.code === "unsupported_settings");
  await assert.rejects(() => cloud.library.saveDevelopSettings(IDS.photo, readyPhoto.recipe.settings, { expectedRevision: 7 }),
    (reason) => reason.code === "unsupported_settings");
  assert.equal(transport.calls.some((call) => call.init.method === "PUT"), false);

  const unknownField = structuredClone(readyPhoto);
  unknownField.recipe.settings.futureField = { keep: true };
  unknownField.recipe.settingsSha256 = HASH.futureSettings;
  const fieldOnly = setup({ photo: unknownField });
  assert.equal((await fieldOnly.cloud.library.get(IDS.photo)).developSettings, null);
  assert.deepEqual(fieldOnly.cloud.rawRecipe(IDS.photo).settings.futureField, { keep: true });
});

test("foreign owner/library responseを拒否する", async () => {
  const foreignOwner = setup({ library: { ...libraryFixture, owner: { type: "user", userId: IDS.userB } } });
  await assert.rejects(() => foreignOwner.cloud.library.capabilities(), (reason) => reason.code === "invalid_response");
  const foreignLibrary = setup({ photo: { ...readyPhoto, libraryId: "foreign-library" } });
  await assert.rejects(() => foreignLibrary.cloud.library.get(IDS.photo), (reason) => reason.code === "invalid_response");
});

test("owner切替・ABA session epoch・disposeが遅着応答をabortし書込を止める", async () => {
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const fixture = setup({ handler: async (input, init) => {
    if (String(input).endsWith("/library")) { await delayed; return json(libraryFixture); }
    return null;
  } });
  const pending = fixture.cloud.library.capabilities();
  fixture.setScope({ ...scope, sessionEpoch: 2 });
  release();
  await assert.rejects(pending, (reason) => reason.code === "scope_changed" || reason.name === "AbortError");
  const before = fixture.transport.calls.length;
  await assert.rejects(() => fixture.cloud.library.delete([IDS.photo]), (reason) => reason.code === "scope_changed");
  assert.equal(fixture.transport.calls.length, before);

  const disposed = setup({ handler: async (input, init) => {
    if (String(input).endsWith("/library")) return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
    return null;
  } });
  const waiting = disposed.cloud.library.capabilities();
  disposed.cloud.dispose();
  await assert.rejects(waiting, (reason) => reason.name === "AbortError" || reason.code === "scope_changed");
});

test("caller signalでstream途中のbyte読取を中断する", async () => {
  const fixture = setup({ handler: async (input, init) => {
    if (!String(input).includes("/content/")) return null;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
      },
    });
    return new Response(stream, { headers: { "content-length": String(readyPhoto.original.sizeBytes), "content-type": "image/jpeg" } });
  } });
  const opened = await fixture.cloud.library.openOriginal(IDS.photo);
  const controller = new AbortController();
  const pending = fixture.cloud.library.loadOriginal(IDS.photo, opened.source, {
    signal: controller.signal, fileName: "x.jpg", maxBytes: readyPhoto.original.sizeBytes,
  });
  queueMicrotask(() => controller.abort(new DOMException("Stopped", "AbortError")));
  await assert.rejects(pending, (reason) => reason.name === "AbortError");
});

test("既知HTTP errorだけをtyped errorへ写し未知本文・URL・写真名を漏らさない", async () => {
  for (const [code, status] of [["not_found", 404], ["quota_exceeded", 409], ["rate_limited", 429]]) {
    const fixture = setup({ handler: async (input) => String(input).endsWith(`/photos/${IDS.photo}`) ? error(code, status) : null });
    const value = await fixture.cloud.library.get(IDS.photo).catch((reason) => reason);
    if (code === "not_found") assert.equal(value, null);
    else { assert.equal(value.code, code); assert(!value.message.includes(IDS.photo)); }
  }
  const unknown = setup({ handler: async (input) => String(input).endsWith(`/photos/${IDS.photo}`)
    ? new Response(`<html>secret https://private.invalid/${readyPhoto.fileName}</html>`, { status: 500 }) : null });
  const failure = await unknown.cloud.library.get(IDS.photo).catch((reason) => reason);
  assert.equal(failure.code, "invalid_response");
  assert(!failure.message.includes("private.invalid"));
  assert(!failure.message.includes(readyPhoto.fileName));
});

test("working-copy状態、versions、mask読取、trash結果をfixtureで写す", async () => {
  const workingAsset = { ...readyPhoto.original, id: "99999999-9999-4999-8999-999999999999", kind: "working-copy",
    sizeBytes: 16, contentType: "image/jpeg", width: 2560, height: 1707 };
  const readyWithWork = { ...readyPhoto, media: { ...readyPhoto.media, workingCopy: {
    asset: workingAsset, baseVersion: "fixture-base", encoding: "jpeg8", meta: { orientation: 1 },
  } } };
  const fixture = setup({ photo: readyWithWork, contentSize: 16 });
  const ensured = await fixture.cloud.library.ensureWorkingCopy(IDS.photo);
  assert.equal(ensured.kind, "ready");
  const loaded = await fixture.cloud.library.loadWorkingCopy(IDS.photo, ensured.download, { signal: new AbortController().signal });
  assert.equal(loaded.bytes.byteLength, 16);
  assert.equal(loaded.baseVersion, "fixture-base");
  assert.deepEqual(await fixture.cloud.library.developVersions(IDS.photo), { revision: 0, versions: [] });
  const savedVersions = await fixture.cloud.library.saveDevelopVersions(IDS.photo, [], { expectedRevision: 0 });
  assert.deepEqual(savedVersions, { kind: "saved", revision: 1, versions: [] });
  const deleted = await fixture.cloud.library.delete([IDS.photo]);
  assert.deepEqual(deleted, { deleted: [IDS.photo], errors: [] });

  const masked = setup({ photo: maskedPhoto, contentSize: mask.sizeBytes });
  const bytes = await masked.cloud.library.loadMaskSurface(IDS.photo, HASH.mask);
  assert.equal(bytes.byteLength, mask.sizeBytes);
});

test("編集・版capabilityとactive lifecycleが閉じていればwriterとretryを送らない", async () => {
  const editsClosed = setup({
    photo: failedMediaPhoto,
    library: { ...libraryFixture, capabilities: { ...libraryFixture.capabilities, edits: false } },
  });
  assert.equal((await editsClosed.cloud.library.get(IDS.photo)).developSettings, null);
  assert.deepEqual(await editsClosed.cloud.library.retryWorkingCopy(IDS.photo), { kind: "notApplicable" });
  await assert.rejects(() => editsClosed.cloud.library.saveDevelopSettings(IDS.photo, readyPhoto.recipe.settings, { expectedRevision: 0 }),
    (reason) => reason.code === "unsupported_settings");
  assert.equal(editsClosed.transport.calls.some((call) => String(call.input).endsWith("/media")), false);
  assert.equal(editsClosed.transport.calls.some((call) => call.init.method === "PUT"), false);

  const unknownRecipe = setup({ photo: { ...futureRecipePhoto, media: failedMediaPhoto.media } });
  assert.deepEqual(await unknownRecipe.cloud.library.retryWorkingCopy(IDS.photo), { kind: "notApplicable" });
  assert.equal(unknownRecipe.transport.calls.some((call) => String(call.input).endsWith("/media")), false);

  const versionsClosed = setup({
    library: { ...libraryFixture, capabilities: { ...libraryFixture.capabilities, versions: false } },
  });
  await assert.rejects(() => versionsClosed.cloud.library.saveDevelopVersions(IDS.photo, [], { expectedRevision: 0 }),
    (reason) => reason.code === "unsupported_settings");
  assert.equal(versionsClosed.transport.calls.some((call) => call.init.method === "PUT" && String(call.input).endsWith("/versions")), false);

  const trashedFailed = setup({ photo: { ...trashedPhoto, media: failedMediaPhoto.media } });
  assert.deepEqual(await trashedFailed.cloud.library.retryWorkingCopy(IDS.photo), { kind: "notApplicable" });
  await assert.rejects(() => trashedFailed.cloud.library.saveDevelopSettings(IDS.photo, readyPhoto.recipe.settings, { expectedRevision: 0 }),
    (reason) => reason.code === "unsupported_settings");
  assert.equal(trashedFailed.transport.calls.some((call) => String(call.input).endsWith("/media")), false);
});

test("scope通知はraw cache・refs・server cacheを即破棄し、dispose後getterも閉じる", async () => {
  const fixture = setup();
  const opened = await fixture.cloud.library.openOriginal(IDS.photo);
  await fixture.cloud.library.developVersions(IDS.photo);
  assert(fixture.cloud.rawRecipe(IDS.photo));
  assert(fixture.cloud.rawVersions(IDS.photo));

  fixture.setScope({ ...scope, sessionEpoch: 2 });
  assert.throws(() => fixture.cloud.rawRecipe(IDS.photo), (reason) => reason.code === "scope_changed");
  fixture.setScope(scope);
  assert.equal(fixture.cloud.rawRecipe(IDS.photo), null);
  assert.equal(fixture.cloud.rawVersions(IDS.photo), null);
  await fixture.cloud.library.capabilities();
  assert.equal(fixture.transport.calls.filter((call) => String(call.input).endsWith("/library")).length, 2);
  await assert.rejects(() => fixture.cloud.library.loadOriginal(IDS.photo, opened.source, {
    signal: new AbortController().signal, fileName: "x.jpg", maxBytes: readyPhoto.original.sizeBytes,
  }), (reason) => reason.code === "invalid_response");

  fixture.cloud.dispose();
  assert.throws(() => fixture.cloud.rawRecipe(IDS.photo), (reason) => reason.code === "scope_changed");
});

test("scope changeとdisposeはsignalを無視するcontent readerの待機も終了させる", { timeout: 1_000 }, async () => {
  const handler = async (input) => {
    if (!String(input).includes("/content/")) return null;
    const stream = new ReadableStream({
      pull() { return new Promise(() => {}); },
      cancel() { return new Promise(() => {}); },
    });
    return new Response(stream, { headers: { "content-length": String(readyPhoto.original.sizeBytes), "content-type": "image/jpeg" } });
  };
  const fixture = setup({ handler });
  const opened = await fixture.cloud.library.openOriginal(IDS.photo);
  const pending = fixture.cloud.library.loadOriginal(IDS.photo, opened.source, {
    signal: new AbortController().signal, fileName: "x.jpg", maxBytes: readyPhoto.original.sizeBytes,
  });
  queueMicrotask(() => fixture.setScope({ ...scope, sessionEpoch: 2 }));
  await assert.rejects(pending, (reason) => reason.name === "AbortError");

  const disposed = setup({ handler });
  const disposedOpened = await disposed.cloud.library.openOriginal(IDS.photo);
  const disposedPending = disposed.cloud.library.loadOriginal(IDS.photo, disposedOpened.source, {
    signal: new AbortController().signal, fileName: "x.jpg", maxBytes: readyPhoto.original.sizeBytes,
  });
  queueMicrotask(() => disposed.cloud.dispose());
  await assert.rejects(disposedPending, (reason) => reason.name === "AbortError");
});

test("requested identifierと異なるphoto・lookup・mask応答を拒否する", async () => {
  const wrongPhoto = setup({ photo: { ...readyPhoto, id: "99999999-9999-4999-8999-999999999999" } });
  await assert.rejects(() => wrongPhoto.cloud.library.get(IDS.photo), (reason) => reason.code === "invalid_response");

  const wrongLookup = setup({ handler: async (input) => String(input).includes("/photos/lookup")
    ? json({ matches: [{ ...responses["photos.lookup"].matches[0], sha256: "f".repeat(64) }] }) : null });
  await assert.rejects(() => wrongLookup.cloud.library.lookup([HASH.original]), (reason) => reason.code === "invalid_response");

  const wrongMask = setup({ photo: maskedPhoto, handler: async (input) => String(input).includes("/masks/")
    ? json({ ...mask, sha256: "e".repeat(64) }) : null });
  await assert.rejects(() => wrongMask.cloud.library.loadMaskSurface(IDS.photo, HASH.mask), (reason) => reason.code === "invalid_response");
});

test("versions.putはmodified settingsのcanonical SHA-256とmask参照を送り、未知raw版を上書きしない", async () => {
  const fixture = setup({ handler: async (input, init) => {
    if (init.method !== "PUT" || !String(input).endsWith("/versions")) return null;
    const body = JSON.parse(init.body);
    return json({ value: { revision: 1, versions: body.versions }, replayed: false });
  } });
  const settings = structuredClone(readyPhoto.recipe.settings);
  settings.exposure = 1;
  const version = { id: "named-1", name: "明るい", kind: "named", createdAt: "2026-11-01T01:00:00.000Z", developSettings: settings };
  const originalVersion = { ...version, id: "named-2", name: "元の値", developSettings: readyPhoto.recipe.settings };
  const saved = await fixture.cloud.library.saveDevelopVersions(IDS.photo, [version, originalVersion], { expectedRevision: 0 });
  assert.equal(saved.kind, "saved");
  const put = fixture.transport.calls.find((call) => call.init.method === "PUT" && String(call.input).endsWith("/versions"));
  const body = JSON.parse(put.init.body);
  assert.equal(body.versions[0].recipe.settingsSha256, canonicalSha256(settings));
  assert.notEqual(body.versions[0].recipe.settingsSha256, HASH.settings);
  assert.notEqual(body.versions[0].recipe.settingsSha256, "0".repeat(64));
  assert.deepEqual(body.versions[0].recipe.maskSurfaceIds, []);
  assert.equal(body.versions[1].recipe.settingsSha256, HASH.settings);

  const masked = setup({ photo: maskedPhoto, handler: async (input, init) => {
    if (init.method !== "PUT" || !String(input).endsWith("/versions")) return null;
    const request = JSON.parse(init.body);
    return json({ value: { revision: 1, versions: request.versions }, replayed: false });
  } });
  await masked.cloud.library.saveDevelopVersions(IDS.photo, [{ ...version, developSettings: maskedPhoto.recipe.settings }], { expectedRevision: 0 });
  const maskedPut = masked.transport.calls.find((call) => call.init.method === "PUT" && String(call.input).endsWith("/versions"));
  assert.deepEqual(JSON.parse(maskedPut.init.body).versions[0].recipe.maskSurfaceIds, [HASH.mask]);

  const unknownVersions = { revision: 4, versions: [{
    id: "future-1", name: "future", kind: "named", createdAt: "2026-11-01T00:00:00.000Z", recipe: futureRecipePhoto.recipe,
  }] };
  const unknown = setup({ versions: unknownVersions });
  await assert.rejects(() => unknown.cloud.library.saveDevelopVersions(IDS.photo, [], { expectedRevision: 4 }),
    (reason) => reason.code === "unsupported_settings");
  assert.equal(unknown.transport.calls.some((call) => call.init.method === "PUT" && String(call.input).endsWith("/versions")), false);
});

test("working-copyはcurrent recipe descriptorだけを使い外部download改変とstale mediaを拒否する", async () => {
  const asset = { ...readyPhoto.original, id: "99999999-9999-4999-8999-999999999999", kind: "working-copy",
    sizeBytes: 16, contentType: "image/png", width: 2560, height: 1707 };
  const work = { asset, baseVersion: "raw-apple.fixture", encoding: "png16", meta: { z: 1, orientation: 6 } };
  const current = { ...readyPhoto, media: { ...readyPhoto.media, workingCopy: work } };
  const fixture = setup({ photo: current, contentSize: 16 });
  const ensured = await fixture.cloud.library.ensureWorkingCopy(IDS.photo);
  ensured.download.work.baseVersion = "attacker-base";
  ensured.download.work.meta.orientation = 1;
  const loaded = await fixture.cloud.library.loadWorkingCopy(IDS.photo, ensured.download, { signal: new AbortController().signal });
  assert.equal(loaded.baseVersion, "raw-apple.fixture");
  assert.equal(loaded.encoding, "png16");
  assert.deepEqual(JSON.parse(loaded.metaJson), { orientation: 6, z: 1 });

  const stale = setup({ photo: { ...current, media: { ...current.media, recipeRevision: current.recipe.revision + 1 } } });
  await assert.rejects(() => stale.cloud.library.ensureWorkingCopy(IDS.photo), (reason) => reason.code === "invalid_response");
  assert.equal(stale.transport.calls.some((call) => String(call.input).endsWith("/media")), true);
});

test("未知recipeでもdownloadOriginalはread-only raw経路で取得でき、openOriginalは閉じる", async () => {
  const fixture = setup({ photo: futureRecipePhoto });
  const item = await fixture.cloud.library.get(IDS.photo);
  await assert.rejects(() => fixture.cloud.library.openOriginal(IDS.photo), (reason) => reason.code === "unsupported_settings");
  const downloaded = await fixture.cloud.library.downloadOriginal(item);
  assert.equal(downloaded.blob.size, futureRecipePhoto.original.sizeBytes);
  assert.equal(downloaded.fileName, futureRecipePhoto.fileName);
});

test("SDK 0.1.4 release URL/version/SRIと実sourceのPhotoLibrary必須methodをbaselineへ固定する", async () => {
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const baseline = JSON.parse(await readFile(new URL("../../photo-library-contract/sdk-baseline.json", import.meta.url), "utf8"));
  const sdkConfig = JSON.parse(await readFile(new URL("../tsconfig.sdk.json", import.meta.url), "utf8"));
  assert.equal(sdkConfig.compilerOptions.strict, true);
  assert.equal(sdkConfig.compilerOptions.exactOptionalPropertyTypes, true);
  assert.equal(sdkConfig.compilerOptions.noUncheckedIndexedAccess, false);
  await assert.rejects(() => readFile(new URL("../src/photo-library-sdk.d.ts", import.meta.url)), (reason) => reason.code === "ENOENT");
  const ids = { "niho-photo-contract": "photo-contract", "niho-photo-editing": "photo-editing", "niho-photo-ui": "ui", "niho-photo-cloud-contract": "cloud-contract" };
  for (const [name, id] of Object.entries(ids)) {
    const locked = lock.packages[`node_modules/${name}`];
    const artifact = baseline.packages.find((item) => item.id === id);
    assert.equal(locked.version, "0.1.4");
    assert.equal(locked.resolved, `https://github.com/niho-life/niho-photo/releases/download/${baseline.releaseTag}/${artifact.file}`);
    assert.equal(locked.integrity, artifact.integrity);
  }
  const source = await readFile(new URL("../node_modules/niho-photo-editing/src/library/photo-library.ts", import.meta.url), "utf8");
  for (const method of ["capabilities", "rollout", "list", "get", "lookup", "openOriginal", "loadOriginal", "ensureWorkingCopy", "loadWorkingCopy", "retryWorkingCopy", "saveDevelopSettings", "downloadOriginal", "delete"]) {
    assert.match(source, new RegExp(`\\n  ${method}\\??\\(`), `SDK method missing: ${method}`);
  }
  for (const property of ["place", "initialCapabilities", "engineAssets", "limits", "errors", "presets"]) {
    assert.match(source, new RegExp(`\\n  readonly ${property}[: ]`), `SDK property missing: ${property}`);
  }
  assert.equal(PHOTO_LIMITS.lookupMaxCount, 100);
});


test("現在recipeから外した過去版のmaskをowner-filtered APIへ照会する", async () => {
  assert.equal(readyPhoto.recipe.maskSurfaceIds.includes(HASH.mask), false);
  const saved = setup({ handler: async (input) => String(input).includes("/content/")
    ? new Response(new Uint8Array(mask.sizeBytes), { headers: { "content-type": "image/png" } }) : null });
  const bytes = await saved.cloud.library.loadMaskSurface(IDS.photo, HASH.mask);
  assert.equal(bytes.byteLength, mask.sizeBytes);
  assert.equal(saved.transport.calls.some(call => String(call.input).includes(`/masks/${HASH.mask}`)), true);
  const missing = setup({ handler: async input => String(input).includes("/masks/") ? error("not_found", 404) : null });
  assert.equal(await missing.cloud.library.loadMaskSurface(IDS.photo, HASH.mask), null);
  await assert.rejects(() => saved.cloud.library.loadMaskSurface(IDS.photo, "bad-surface"), reason => reason.code === "invalid_request");
});
