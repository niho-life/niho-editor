import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_BASELINE_PATH = path.resolve(APP_DIR, "../../packages/photo-library-contract/sdk-baseline.json");
const DEFAULT_PUBLIC_ROOT = path.join(APP_DIR, "public");
const PHOTO_LIBRARY_PACKAGE = "@niho/photo-cloud-library";
const PHOTO_LIBRARY_FILE_SPEC = "file:../../packages/photo-cloud-library";
const HOST_SDK_PACKAGES = Object.freeze([
  "niho-photo-ui",
  "niho-photo-editing",
  "niho-photo-cloud-contract",
  "niho-photo-contract",
  "niho-photo-develop-engine-runtime",
]);
const LICENSE_FILES = Object.freeze([
  "LICENSE.md",
  "ASSET_LICENSE.md",
  "LICENSES.md",
  "THIRD_PARTY_NOTICES.md",
  "TRADEMARKS.md",
  "licenses/Adobe-DNG-SDK-LICENSE.txt",
]);

function fail(message) {
  throw new Error(`photo runtime staging: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function assertNamespacePart(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    fail(`${label} is not a safe namespace component`);
  }
  return value;
}

function assertSafeRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    fail(`${label} is not a safe relative path`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) fail(`${label} contains traversal`);
  return parts.join(path.sep);
}

async function readRegularFile(root, relative, label) {
  const safeRelative = assertSafeRelativePath(relative, label);
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${label} root is missing`);
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail(`${label} root must be a regular directory`);
  const parts = safeRelative.split(path.sep);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") fail(`${label} is missing`);
      throw error;
    }
    if (stat.isSymbolicLink()) fail(`${label} must not be a symlink`);
    if (index < parts.length - 1 && !stat.isDirectory()) fail(`${label} has a non-directory parent`);
    if (index === parts.length - 1 && !stat.isFile()) fail(`${label} must be a regular file`);
  }
  return readFile(current);
}

function assertFileMetadata(value, label) {
  const metadata = assertPlainObject(value, label);
  if (typeof metadata.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.sha256)) fail(`${label}.sha256 is invalid`);
  if (!Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0) fail(`${label}.bytes is invalid`);
  return metadata;
}

function verifyBytes(bytes, expected, label) {
  if (bytes.byteLength !== expected.bytes) fail(`${label} size mismatch`);
  if (sha256(bytes) !== expected.sha256) fail(`${label} sha256 mismatch`);
}

async function readJsonFile(filePath, label) {
  let bytes;
  try {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a regular file`);
    bytes = await readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${label} is missing`);
    throw error;
  }
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function sdkVersionFromReleaseTag(releaseTag) {
  if (typeof releaseTag !== "string") fail("baseline.releaseTag is invalid");
  const match = /^photo-sdk-v(\d+\.\d+\.\d+)$/.exec(releaseTag);
  if (!match) fail("baseline.releaseTag is invalid");
  return match[1];
}

function verifyHostSdkPins(baseline, sdkVersion, appPackage, appLock, photoLibraryPackage) {
  if (baseline.repository !== "niho-life/niho-photo") fail("baseline.repository is not the official Photo SDK repository");
  if (!Array.isArray(baseline.packages)) fail("baseline.packages must be an array");
  const dependencies = assertPlainObject(appPackage.dependencies, "host package dependencies");
  const lockedPackages = assertPlainObject(appLock.packages, "host lock packages");
  const lockedDependencies = assertPlainObject(lockedPackages[""]?.dependencies, "host lock root dependencies");
  for (const name of HOST_SDK_PACKAGES) {
    const matches = baseline.packages.filter((entry) => entry?.name === name);
    if (matches.length !== 1) fail(`baseline must declare exactly one ${name}`);
    const metadata = matches[0];
    if (metadata.file !== `${name}-${sdkVersion}.tgz`) fail(`${name} baseline filename does not match SDK version`);
    assertFileMetadata({ sha256: metadata.sha256, bytes: metadata.size }, `${name} baseline`);
    const integrity = `sha256-${Buffer.from(metadata.sha256, "hex").toString("base64")}`;
    if (metadata.integrity !== integrity) fail(`${name} baseline SRI does not match sha256`);
    const url = `https://github.com/${baseline.repository}/releases/download/${baseline.releaseTag}/${metadata.file}`;
    if (dependencies[name] !== url || lockedDependencies[name] !== url) fail(`${name} host URL does not match SDK baseline`);
    const locked = assertPlainObject(lockedPackages[`node_modules/${name}`], `${name} host lock`);
    if (locked.version !== sdkVersion || locked.resolved !== url || locked.integrity !== integrity) {
      fail(`${name} host lock version, URL or SRI does not match SDK baseline`);
    }
    if (Object.keys(lockedPackages).some((key) => key.endsWith(`/node_modules/${name}`) && key !== `node_modules/${name}`)) {
      fail(`${name} has a second host installation`);
    }
  }

  if (dependencies[PHOTO_LIBRARY_PACKAGE] !== PHOTO_LIBRARY_FILE_SPEC
    || lockedDependencies[PHOTO_LIBRARY_PACKAGE] !== PHOTO_LIBRARY_FILE_SPEC) {
    fail("host photo cloud library file dependency does not match the monorepo package");
  }
  const photoLibrary = assertPlainObject(photoLibraryPackage, "photo cloud library package");
  const photoLibraryDependencies = assertPlainObject(photoLibrary.dependencies, "photo cloud library dependencies");
  const lockedPhotoLibrary = assertPlainObject(
    lockedPackages[`node_modules/${PHOTO_LIBRARY_PACKAGE}`],
    "photo cloud library host lock",
  );
  if (lockedPhotoLibrary.version !== photoLibrary.version || lockedPhotoLibrary.resolved !== PHOTO_LIBRARY_FILE_SPEC) {
    fail("photo cloud library host lock identity does not match its package");
  }
  const lockedPhotoLibraryDependencies = assertPlainObject(
    lockedPhotoLibrary.dependencies,
    "photo cloud library host lock dependencies",
  );
  const photoLibraryDependencyNames = Object.keys(photoLibraryDependencies).sort();
  const lockedPhotoLibraryDependencyNames = Object.keys(lockedPhotoLibraryDependencies).sort();
  if (photoLibraryDependencyNames.length !== lockedPhotoLibraryDependencyNames.length
    || photoLibraryDependencyNames.some((name, index) => name !== lockedPhotoLibraryDependencyNames[index])) {
    fail("photo cloud library lock dependency set does not match its package");
  }
  for (const [name, spec] of Object.entries(photoLibraryDependencies)) {
    if (lockedPhotoLibraryDependencies[name] !== spec) fail(`photo cloud library lock dependency does not match ${name}`);
  }
  const contract = baseline.packages.find((entry) => entry?.name === "niho-photo-contract");
  const contractUrl = `https://github.com/${baseline.repository}/releases/download/${baseline.releaseTag}/${contract.file}`;
  if (photoLibraryDependencies["niho-photo-contract"] !== contractUrl) {
    fail("photo cloud library SDK dependency does not match the baseline");
  }
  if (Object.keys(lockedPackages).some((key) => (
    key.endsWith("/node_modules/niho-photo-contract") && key !== "node_modules/niho-photo-contract"
  ))) {
    fail("niho-photo-contract has a second host installation");
  }
}

function runtimePackageRootFromInstall() {
  const require = createRequire(import.meta.url);
  let manifestPath;
  try {
    manifestPath = require.resolve("niho-photo-develop-engine-runtime/manifest");
  } catch {
    fail("niho-photo-develop-engine-runtime is not installed");
  }
  return path.resolve(path.dirname(manifestPath), "../..");
}

async function ensureDirectoryTree(root, relativeParts) {
  await mkdir(root, { recursive: true });
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("public root must be a regular directory");
  let current = root;
  for (const part of relativeParts) {
    current = path.join(current, part);
    try {
      await mkdir(current);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("runtime namespace parent must be a regular directory");
  }
  return current;
}

function expectedDirectories(entries) {
  const directories = new Set();
  for (const relative of entries.keys()) {
    const parts = relative.split("/");
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join("/"));
  }
  return directories;
}

async function verifyExistingNamespace(destination, expectedEntries) {
  let rootStat;
  try {
    rootStat = await lstat(destination);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("existing runtime namespace is not a regular directory");

  const expectedDirs = expectedDirectories(expectedEntries);
  const seen = new Set();
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail(`existing runtime namespace contains symlink ${relative}`);
      if (entry.isDirectory()) {
        if (!expectedDirs.has(relative)) fail(`existing runtime namespace contains unexpected directory ${relative}`);
        await visit(path.join(directory, entry.name), relative);
      } else if (entry.isFile()) {
        const expected = expectedEntries.get(relative);
        if (!expected) fail(`existing runtime namespace contains unexpected file ${relative}`);
        const actual = await readRegularFile(destination, relative, `existing runtime ${relative}`);
        if (!actual.equals(expected)) fail(`existing runtime namespace differs at ${relative}`);
        seen.add(relative);
      } else {
        fail(`existing runtime namespace contains special file ${relative}`);
      }
    }
  }
  await visit(destination);
  for (const relative of expectedEntries.keys()) {
    if (!seen.has(relative)) fail(`existing runtime namespace is missing ${relative}`);
  }
  return true;
}

async function writeStagedNamespace(tempDirectory, entries) {
  for (const [relative, entry] of entries) {
    const target = path.join(tempDirectory, assertSafeRelativePath(relative, `output ${relative}`));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.bytes, { flag: "wx" });
  }
}

export async function stagePhotoSdkRuntime(options = {}) {
  const baselinePath = options.baselinePath ?? DEFAULT_BASELINE_PATH;
  const publicRoot = options.publicRoot ?? DEFAULT_PUBLIC_ROOT;
  const runtimePackageRoot = options.runtimePackageRoot ?? runtimePackageRootFromInstall();
  const photoLibraryPackagePath = options.photoLibraryPackagePath
    ?? path.resolve(APP_DIR, "../../packages/photo-cloud-library/package.json");
  const appPackagePath = options.appPackagePath ?? path.join(APP_DIR, "package.json");
  const appLockPath = options.appLockPath ?? path.join(APP_DIR, "package-lock.json");

  const { value: baselineValue } = await readJsonFile(baselinePath, "SDK baseline");
  const baseline = assertPlainObject(baselineValue, "SDK baseline");
  if (baseline.schemaVersion !== 1) fail("unsupported baseline schemaVersion");
  const releaseTag = assertNamespacePart(baseline.releaseTag, "baseline.releaseTag");
  const sourceCommit = typeof baseline.sourceCommit === "string" && /^[a-f0-9]{40}$/.test(baseline.sourceCommit)
    ? baseline.sourceCommit
    : fail("baseline.sourceCommit is invalid");
  const sdkVersion = sdkVersionFromReleaseTag(releaseTag);
  const appPackage = (await readJsonFile(appPackagePath, "host package.json")).value;
  const appLock = (await readJsonFile(appLockPath, "host package-lock.json")).value;
  const photoLibraryPackage = (await readJsonFile(photoLibraryPackagePath, "photo cloud library package.json")).value;
  verifyHostSdkPins(baseline, sdkVersion, appPackage, appLock, photoLibraryPackage);
  const baselineManifest = assertPlainObject(baseline.manifest, "baseline.manifest");
  const manifestSetHash = assertNamespacePart(baselineManifest.sha256, "baseline.manifest.sha256");
  if (!/^[a-f0-9]{64}$/.test(manifestSetHash)) fail("baseline.manifest.sha256 is invalid");
  const engineBaseline = assertPlainObject(baseline.engine, "baseline.engine");
  const engineVersion = assertNamespacePart(engineBaseline.version, "baseline.engine.version");
  const crateVersion = assertNamespacePart(engineBaseline.crateVersion, "baseline.engine.crateVersion");
  const engineManifestBaseline = assertPlainObject(engineBaseline.manifest, "baseline.engine.manifest");
  const expectedManifestName = `manifest-${crateVersion}.json`;
  if (engineManifestBaseline.file !== expectedManifestName) fail("baseline engine manifest filename does not match crateVersion");
  const manifestMetadata = {
    bytes: engineManifestBaseline.size,
    sha256: engineManifestBaseline.sha256,
  };
  assertFileMetadata(manifestMetadata, "baseline.engine.manifest");

  const runtimePackage = (await readJsonFile(path.join(runtimePackageRoot, "package.json"), "runtime package.json")).value;
  if (runtimePackage?.name !== "niho-photo-develop-engine-runtime" || runtimePackage.version !== sdkVersion) {
    fail("runtime package identity does not match SDK baseline");
  }

  const engineRelativeRoot = `develop-engine/${engineVersion}`;
  const manifestBytes = await readRegularFile(
    runtimePackageRoot,
    `${engineRelativeRoot}/${expectedManifestName}`,
    "engine manifest",
  );
  verifyBytes(manifestBytes, manifestMetadata, "engine manifest");
  let manifest;
  try {
    manifest = assertPlainObject(JSON.parse(manifestBytes.toString("utf8")), "engine manifest");
  } catch (error) {
    if (error instanceof SyntaxError) fail("engine manifest is not valid JSON");
    throw error;
  }
  if (manifest.schemaVersion !== 1 || manifest.engine !== engineVersion || manifest.version !== crateVersion || manifest.source?.commit !== sourceCommit) {
    fail("engine manifest identity does not match SDK baseline");
  }

  const stagedEntries = new Map();
  const addVerifiedEntry = async (relative, metadata, label) => {
    const outputRelative = relative.split(path.sep).join("/");
    if (stagedEntries.has(outputRelative)) fail(`${label} is declared more than once`);
    const bytes = await readRegularFile(runtimePackageRoot, `${engineRelativeRoot}/${relative}`, label);
    verifyBytes(bytes, assertFileMetadata(metadata, label), label);
    stagedEntries.set(outputRelative, { bytes });
  };

  stagedEntries.set(expectedManifestName, {
    bytes: manifestBytes,
  });
  const files = assertPlainObject(manifest.files, "engine manifest.files");
  for (const [relative, metadata] of Object.entries(files)) await addVerifiedEntry(relative, metadata, `manifest.files[${JSON.stringify(relative)}]`);
  const threadFiles = assertPlainObject(manifest.threads, "engine manifest.threads").files;
  for (const [relative, metadata] of Object.entries(assertPlainObject(threadFiles, "engine manifest.threads.files"))) {
    await addVerifiedEntry(relative, metadata, `manifest.threads.files[${JSON.stringify(relative)}]`);
  }

  for (const licenseFile of LICENSE_FILES) {
    const bytes = await readRegularFile(runtimePackageRoot, licenseFile, licenseFile);
    if (stagedEntries.has(licenseFile)) fail(`${licenseFile} collides with an engine manifest entry`);
    stagedEntries.set(licenseFile, { bytes });
  }

  const namespaceParts = [
    "photo-runtime",
    releaseTag,
    manifestSetHash,
    "develop-engine",
    engineVersion,
  ];
  const parent = await ensureDirectoryTree(publicRoot, namespaceParts.slice(0, -1));
  const destination = path.join(parent, namespaceParts.at(-1));
  const expectedBytes = new Map([...stagedEntries].map(([relative, entry]) => [relative, entry.bytes]));
  if (await verifyExistingNamespace(destination, expectedBytes)) {
    return { status: "unchanged", directory: destination, namespace: `/${namespaceParts.join("/")}` };
  }

  const tempDirectory = path.join(parent, `.photo-runtime-stage-${engineVersion}-${process.pid}-${randomUUID()}`);
  await mkdir(tempDirectory);
  try {
    await writeStagedNamespace(tempDirectory, stagedEntries);
    try {
      await rename(tempDirectory, destination);
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
      if (!(await verifyExistingNamespace(destination, expectedBytes))) fail("concurrent runtime namespace disappeared");
      return { status: "unchanged", directory: destination, namespace: `/${namespaceParts.join("/")}` };
    }
    return { status: "staged", directory: destination, namespace: `/${namespaceParts.join("/")}` };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const result = await stagePhotoSdkRuntime();
  process.stdout.write(`photo runtime ${result.status}: ${result.namespace}\n`);
}
