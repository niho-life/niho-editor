import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { stagePhotoSdkRuntime } from "../scripts/stage-photo-sdk-runtime.mjs";

const LICENSE_FILES = [
  "LICENSE.md",
  "ASSET_LICENSE.md",
  "LICENSES.md",
  "THIRD_PARTY_NOTICES.md",
  "TRADEMARKS.md",
  "licenses/Adobe-DNG-SDK-LICENSE.txt",
];
const ADOBE_DNG_LICENSE = "Synthetic Adobe DNG SDK license text for staging tests.\n";
const HOST_SDK_PACKAGES = ["niho-photo-ui", "niho-photo-editing", "niho-photo-cloud-contract", "niho-photo-contract", "niho-photo-develop-engine-runtime"];

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function createFixture(root, options = {}) {
  const sdkVersion = options.sdkVersion ?? "0.1.5";
  const releaseTag = options.releaseTag ?? `photo-sdk-v${sdkVersion}`;
  const sourceCommit = options.sourceCommit ?? "a".repeat(40);
  const engineVersion = options.engineVersion ?? "test-engine";
  const crateVersion = options.crateVersion ?? "1.2.3";
  const runtimePackageRoot = path.join(root, `runtime-${sdkVersion}-${options.fixtureName ?? "default"}`);
  const engineRoot = path.join(runtimePackageRoot, "develop-engine", engineVersion);
  const publicRoot = path.join(root, "public");
  const baselinePath = path.join(root, `baseline-${sdkVersion}-${options.fixtureName ?? "default"}.json`);
  const appPackagePath = path.join(root, `host-${sdkVersion}-${options.fixtureName ?? "default"}.json`);
  const appLockPath = path.join(root, `lock-${sdkVersion}-${options.fixtureName ?? "default"}.json`);
  await mkdir(engineRoot, { recursive: true });
  await writeJson(path.join(runtimePackageRoot, "package.json"), {
    name: "niho-photo-develop-engine-runtime",
    version: sdkVersion,
  });
  for (const license of LICENSE_FILES) {
    const target = path.join(runtimePackageRoot, license);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, license === "licenses/Adobe-DNG-SDK-LICENSE.txt"
      ? ADOBE_DNG_LICENSE
      : `${license} ${sdkVersion}\n`);
  }

  const sourceFiles = options.sourceFiles ?? {
    "engine.wasm": Buffer.from(`wasm-${sdkVersion}`),
    "model/data.f32": Buffer.from(`model-${sdkVersion}`),
    "worker.js": Buffer.from(`worker-${sdkVersion}`),
    "undeclared.bin": Buffer.from("must-not-be-published"),
  };
  for (const [relative, bytes] of Object.entries(sourceFiles)) {
    const target = path.join(engineRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }

  const metadata = (relative) => ({
    sha256: digest(sourceFiles[relative]),
    bytes: sourceFiles[relative].byteLength,
  });
  const manifest = {
    schemaVersion: 1,
    engine: engineVersion,
    version: crateVersion,
    source: { repository: "example/photo", commit: sourceCommit },
    files: options.files ?? {
      "engine.wasm": metadata("engine.wasm"),
      "model/data.f32": metadata("model/data.f32"),
    },
    threads: {
      files: options.threadFiles ?? { "worker.js": metadata("worker.js") },
    },
  };
  const manifestFile = `manifest-${crateVersion}.json`;
  await writeJson(path.join(engineRoot, manifestFile), manifest);
  const manifestBytes = await readFile(path.join(engineRoot, manifestFile));
  const baseline = {
    schemaVersion: 1,
    repository: "niho-life/niho-photo",
    releaseTag,
    sourceCommit,
    manifest: {
      file: `release-${sdkVersion}.json`,
      sha256: digest(Buffer.from(`release-set-${sdkVersion}-${options.fixtureName ?? "default"}`)),
    },
    packages: HOST_SDK_PACKAGES.map((name) => {
      const bytes = Buffer.from(`${name}-${sdkVersion}`);
      const sha256 = digest(bytes);
      return { name, file: `${name}-${sdkVersion}.tgz`, size: bytes.length, sha256, integrity: `sha256-${Buffer.from(sha256, "hex").toString("base64")}` };
    }),
    engine: {
      version: engineVersion,
      crateVersion,
      manifest: {
        file: manifestFile,
        sha256: digest(manifestBytes),
        size: manifestBytes.byteLength,
      },
    },
  };
  await writeJson(baselinePath, baseline);
  const dependencies = Object.fromEntries(baseline.packages.map((entry) => [entry.name,
    `https://github.com/${baseline.repository}/releases/download/${releaseTag}/${entry.file}`]));
  await writeJson(appPackagePath, { dependencies });
  await writeJson(appLockPath, { lockfileVersion: 3, packages: {
    "": { dependencies },
    ...Object.fromEntries(baseline.packages.map((entry) => [`node_modules/${entry.name}`, {
      version: sdkVersion, resolved: dependencies[entry.name], integrity: entry.integrity,
    }])),
  } });
  const namespace = path.join(
    publicRoot,
    "photo-runtime",
    releaseTag,
    baseline.manifest.sha256,
    "develop-engine",
    engineVersion,
  );
  return { baseline, baselinePath, appPackagePath, appLockPath, engineRoot, manifestFile, namespace, publicRoot, runtimePackageRoot };
}

async function withTemp(t, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "editor-photo-runtime-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await run(root);
}

test("stages the verified manifest closure and licenses", (t) => withTemp(t, async (root) => {
  const fixture = await createFixture(root);
  const result = await stagePhotoSdkRuntime(fixture);
  assert.equal(result.status, "staged");
  assert.equal(result.directory, fixture.namespace);
  assert.deepEqual((await readdir(fixture.namespace)).sort(), [
    "ASSET_LICENSE.md",
    "LICENSE.md",
    "LICENSES.md",
    "THIRD_PARTY_NOTICES.md",
    "TRADEMARKS.md",
    "engine.wasm",
    "licenses",
    fixture.manifestFile,
    "model",
    "worker.js",
  ].sort());
  assert.deepEqual(await readFile(path.join(fixture.namespace, "engine.wasm")), Buffer.from("wasm-0.1.5"));
  assert.deepEqual(await readFile(path.join(fixture.namespace, "model/data.f32")), Buffer.from("model-0.1.5"));
  for (const license of LICENSE_FILES.filter((relative) => !relative.includes("/"))) {
    assert.match(await readFile(path.join(fixture.namespace, license), "utf8"), new RegExp(license));
  }
  assert.equal(
    await readFile(path.join(fixture.namespace, "licenses/Adobe-DNG-SDK-LICENSE.txt"), "utf8"),
    ADOBE_DNG_LICENSE,
  );
}));

test("is idempotent when the immutable namespace has identical bytes", (t) => withTemp(t, async (root) => {
  const fixture = await createFixture(root);
  assert.equal((await stagePhotoSdkRuntime(fixture)).status, "staged");
  assert.equal((await stagePhotoSdkRuntime(fixture)).status, "unchanged");
}));

test("rejects host dependency, lock and baseline pin drift before publishing", (t) => withTemp(t, async (root) => {
  for (const mode of ["package-url", "lock-url", "version", "integrity", "nested", "baseline-sri"]) {
    const fixture = await createFixture(root, { fixtureName: mode });
    const appPackage = JSON.parse(await readFile(fixture.appPackagePath, "utf8"));
    const lock = JSON.parse(await readFile(fixture.appLockPath, "utf8"));
    const name = "niho-photo-editing";
    const locked = lock.packages[`node_modules/${name}`];
    if (mode === "package-url") appPackage.dependencies[name] = "https://example.invalid/mutable.tgz";
    if (mode === "lock-url") locked.resolved = "https://example.invalid/mirror.tgz";
    if (mode === "version") locked.version = "0.1.4";
    if (mode === "integrity") locked.integrity = `sha256-${Buffer.alloc(32).toString("base64")}`;
    if (mode === "nested") lock.packages[`node_modules/other/node_modules/${name}`] = locked;
    if (mode === "baseline-sri") {
      fixture.baseline.packages.find((entry) => entry.name === name).integrity = `sha256-${Buffer.alloc(32).toString("base64")}`;
      await writeJson(fixture.baselinePath, fixture.baseline);
    }
    await writeJson(fixture.appPackagePath, appPackage);
    await writeJson(fixture.appLockPath, lock);
    await assert.rejects(stagePhotoSdkRuntime(fixture), /host URL|host lock|second host installation|baseline SRI/);
    await assert.rejects(readdir(fixture.publicRoot), { code: "ENOENT" });
  }
}));

test("preserves a different release namespace", (t) => withTemp(t, async (root) => {
  const first = await createFixture(root, { fixtureName: "first" });
  await stagePhotoSdkRuntime(first);
  const marker = path.join(first.namespace, "engine.wasm");
  const before = await readFile(marker);
  const second = await createFixture(root, {
    fixtureName: "second",
    sdkVersion: "0.1.6",
    sourceCommit: "b".repeat(40),
  });
  await stagePhotoSdkRuntime(second);
  assert.deepEqual(await readFile(marker), before);
  assert.notEqual(first.namespace, second.namespace);
}));

test("rejects a tampered declared file", (t) => withTemp(t, async (root) => {
  const fixture = await createFixture(root);
  await writeFile(path.join(fixture.engineRoot, "engine.wasm"), "tampered");
  await assert.rejects(stagePhotoSdkRuntime(fixture), /engine\.wasm.*(size|sha256) mismatch/);
}));

test("rejects a missing declared file", (t) => withTemp(t, async (root) => {
  const fixture = await createFixture(root);
  await rm(path.join(fixture.engineRoot, "worker.js"));
  await assert.rejects(stagePhotoSdkRuntime(fixture), /worker\.js.*missing/);
}));

test("rejects manifest traversal", (t) => withTemp(t, async (root) => {
  const fixture = await createFixture(root, {
    files: {
      "../escape.wasm": { sha256: "0".repeat(64), bytes: 0 },
    },
  });
  await assert.rejects(stagePhotoSdkRuntime(fixture), /traversal/);
}));

test("rejects a symlink in the declared closure", (t) => withTemp(t, async (root) => {
  const fixture = await createFixture(root);
  await rm(path.join(fixture.engineRoot, "engine.wasm"));
  await symlink(path.join(fixture.engineRoot, "worker.js"), path.join(fixture.engineRoot, "engine.wasm"));
  await assert.rejects(stagePhotoSdkRuntime(fixture), /engine\.wasm.*symlink/);
}));

test("rejects a missing Adobe DNG license without changing an existing namespace", (t) => withTemp(t, async (root) => {
  const fixture = await createFixture(root);
  await stagePhotoSdkRuntime(fixture);
  const stagedLicense = path.join(fixture.namespace, "licenses/Adobe-DNG-SDK-LICENSE.txt");
  const before = await readFile(stagedLicense);
  await rm(path.join(fixture.runtimePackageRoot, "licenses/Adobe-DNG-SDK-LICENSE.txt"));
  await assert.rejects(stagePhotoSdkRuntime(fixture), /Adobe-DNG-SDK-LICENSE\.txt.*missing/);
  assert.deepEqual(await readFile(stagedLicense), before);
}));

test("rejects a symlinked Adobe DNG license without changing an existing namespace", (t) => withTemp(t, async (root) => {
  const fixture = await createFixture(root);
  await stagePhotoSdkRuntime(fixture);
  const stagedLicense = path.join(fixture.namespace, "licenses/Adobe-DNG-SDK-LICENSE.txt");
  const before = await readFile(stagedLicense);
  const sourceLicense = path.join(fixture.runtimePackageRoot, "licenses/Adobe-DNG-SDK-LICENSE.txt");
  await rm(sourceLicense);
  await symlink(path.join(fixture.runtimePackageRoot, "LICENSE.md"), sourceLicense);
  await assert.rejects(stagePhotoSdkRuntime(fixture), /Adobe-DNG-SDK-LICENSE\.txt.*symlink/);
  assert.deepEqual(await readFile(stagedLicense), before);
}));

test("refuses to overwrite an abnormal existing namespace", (t) => withTemp(t, async (root) => {
  const fixture = await createFixture(root);
  await stagePhotoSdkRuntime(fixture);
  const target = path.join(fixture.namespace, "engine.wasm");
  await writeFile(target, "existing-anomaly");
  await assert.rejects(stagePhotoSdkRuntime(fixture), /existing runtime namespace differs/);
  assert.equal(await readFile(target, "utf8"), "existing-anomaly");
}));

test("refuses unknown files in an existing immutable namespace", (t) => withTemp(t, async (root) => {
  const fixture = await createFixture(root);
  await stagePhotoSdkRuntime(fixture);
  const extra = path.join(fixture.namespace, "unexpected.js");
  await writeFile(extra, "unreviewed");
  await assert.rejects(stagePhotoSdkRuntime(fixture), /unexpected file unexpected\.js/);
  assert.equal(await readFile(extra, "utf8"), "unreviewed");
}));

test("refuses a symlinked public root", (t) => withTemp(t, async (root) => {
  const fixture = await createFixture(root);
  const other = path.join(root, "other-public");
  await mkdir(other);
  await symlink(other, fixture.publicRoot);
  await assert.rejects(stagePhotoSdkRuntime(fixture), /public root must be a regular directory/);
  assert.deepEqual(await readdir(other), []);
}));
