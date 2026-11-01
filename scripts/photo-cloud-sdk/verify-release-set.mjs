#!/usr/bin/env node
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import {
  CONFIG_PATH,
  EXPECTED_PEERS,
  FORBIDDEN_ENTRY,
  FULL_SHA,
  PACKAGE_DEFINITIONS,
  RELEASE_TAG,
  RELEASE_VERSION,
  REPOSITORY,
  SEMVER,
  SHA256,
  TOOLING_PATHS,
  auditImports,
  gitBytes,
  recordDigest,
  resolveSource,
  safeRelative,
  sha256,
  treeFiles,
  validateConfig,
} from "./release-lib.mjs";

const MAX_TARBALL = 16 * 1024 * 1024;
const MAX_ENTRY = 8 * 1024 * 1024;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const LOCAL_SPEC = /^(?:file:|link:|workspace:|\.\.?\/|\/)/u;

export class PhotoCloudVerificationError extends Error {}

function fail(message) {
  throw new PhotoCloudVerificationError(message);
}

export function sri(bytes) {
  return `sha256-${Buffer.from(sha256(bytes), "hex").toString("base64")}`;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} がobjectではありません`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} field集合が不正です`);
}

function octal(buffer, start, length, label) {
  const value = buffer.subarray(start, start + length).toString("ascii").replace(/\0.*$/su, "").trim();
  if (!/^[0-7]+$/u.test(value)) fail(`${label} tar octalが不正です`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`${label} tar数値が不正です`);
  return parsed;
}

function tarString(buffer, start, length) {
  return buffer.subarray(start, start + length).toString("utf8").replace(/\0.*$/su, "");
}

export function readTarEntries(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_TARBALL) fail("tarball sizeが不正です");
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || !bytes.subarray(4, 8).every((byte) => byte === 0)) fail("gzip headerがdeterministicではありません");
  let archive;
  try { archive = gunzipSync(bytes, { maxOutputLength: MAX_TARBALL * 4 }); } catch { fail("tarball gzipが不正です"); }
  const entries = new Map();
  let offset = 0;
  let ended = false;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (archive.length - offset < 1024 || !archive.subarray(offset, offset + 1024).every((byte) => byte === 0)) fail("tarball終端が不正です");
      ended = true;
      break;
    }
    const stored = octal(header, 148, 8, "checksum");
    let calculated = 0;
    for (let index = 0; index < 512; index += 1) calculated += index >= 148 && index < 156 ? 32 : header[index];
    if (stored !== calculated) fail("tar header checksumが一致しません");
    if (tarString(header, 257, 6) !== "ustar" || tarString(header, 263, 2) !== "00") fail("tar formatが不正です");
    if (octal(header, 100, 8, "mode") !== 0o644 || octal(header, 108, 8, "uid") !== 0 || octal(header, 116, 8, "gid") !== 0 || octal(header, 136, 12, "mtime") !== 0) fail("tar metadataがdeterministicではありません");
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    try { safeRelative(fullName, "tar entry"); } catch (error) { fail(error.message); }
    if (!fullName.startsWith("package/")) fail("tar entryはpackage/配下が必要です");
    const relative = fullName.slice("package/".length);
    try { safeRelative(relative, "package entry"); } catch (error) { fail(error.message); }
    if (String.fromCharCode(header[156] || 48) !== "0") fail(`symlink・特殊tar entryは禁止です: ${relative}`);
    if (FORBIDDEN_ENTRY.test(relative)) fail(`公開禁止fileがtarballにあります: ${relative}`);
    const size = octal(header, 124, 12, "size");
    if (size > MAX_ENTRY) fail(`tar entryが大きすぎます: ${relative}`);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > archive.length || entries.has(relative)) fail("tar entryの境界または重複が不正です");
    entries.set(relative, Buffer.from(archive.subarray(bodyStart, bodyEnd)));
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  if (!ended || entries.size === 0 || !archive.subarray(offset).every((byte) => byte === 0)) fail("tarball終端または内容が不正です");
  return entries;
}

function validateRecords(container, key, expectedPaths, label) {
  exactKeys(container, ["algorithm", "digest", key], label);
  const records = container[key];
  if (container.algorithm !== "sha256-path-size-content-v1" || !SHA256.test(container.digest ?? "") || !Array.isArray(records) || records.length !== expectedPaths.length) fail(`${label} record集合が不正です`);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    exactKeys(record, ["path", "size", "sha256"], `${label} record`);
    if (record.path !== expectedPaths[index] || !Number.isSafeInteger(record.size) || record.size < 0 || !SHA256.test(record.sha256)) fail(`${label} recordが不正です`);
  }
  if (container.digest !== recordDigest(records)) fail(`${label} digestが一致しません`);
  return records;
}

function packageEntryPaths(definition, sourcePaths) {
  const relative = sourcePaths.map((item) => item.slice(`${definition.sourceRoot}/`.length));
  return [...new Set([...relative, "LICENSE", "THIRD_PARTY_NOTICES.md"])].sort((left, right) => left.localeCompare(right, "en"));
}

function validateSourcePaths(definition, records) {
  const prefix = `${definition.sourceRoot}/`;
  let previous = "";
  for (const { path: itemPath } of records) {
    if (!itemPath.startsWith(prefix)) fail(`${definition.id} source pathがroot外です`);
    const relative = itemPath.slice(prefix.length);
    const allowed = relative === "package.json" || relative === "README.md" || relative.startsWith("src/") || (definition.id === "library-contract" && relative === "sdk-baseline.json");
    if (!allowed || FORBIDDEN_ENTRY.test(relative) || itemPath.localeCompare(previous, "en") <= 0) fail(`${definition.id} source allowlist/orderが不正です`);
    previous = itemPath;
  }
}

function validateDependencyMap(value, expected, label) {
  if (Object.keys(expected).length === 0) {
    if (value !== undefined) fail(`${label} は不要です`);
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value) !== JSON.stringify(expected)) fail(`${label} exact pinが不正です`);
  for (const spec of Object.values(value)) if (typeof spec !== "string" || LOCAL_SPEC.test(spec) || !SEMVER.test(spec)) fail(`${label} にlocal/可変specがあります`);
}

function validatePackage(entries, definition, version) {
  for (const required of ["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "src/index.ts"].filter((name) => definition.id === "cloud-library" || name !== "src/index.ts")) if (!entries.has(required)) fail(`${definition.name} に ${required} がありません`);
  if (definition.id === "library-contract" && (!entries.has("src/v1.ts") || !entries.has("sdk-baseline.json"))) fail("contract packageの必須entryがありません");
  let manifest;
  try { manifest = JSON.parse(entries.get("package.json").toString("utf8")); } catch { fail(`${definition.name} package.jsonが不正です`); }
  if (manifest.name !== definition.name || manifest.version !== version || manifest.private !== undefined || manifest.type !== "module") fail(`${definition.name} package identityが不正です`);
  for (const field of ["scripts", "dependencies", "devDependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies", "peerDependenciesMeta"]) if (manifest[field] !== undefined) fail(`${definition.name} に公開禁止manifest fieldがあります: ${field}`);
  const expectedExports = definition.id === "library-contract" ? { ".": "./src/v1.ts", "./sdk-baseline": "./sdk-baseline.json" } : { ".": "./src/index.ts" };
  if (JSON.stringify(manifest.exports) !== JSON.stringify(expectedExports)) fail(`${definition.name} exportsが不正です`);
  validateDependencyMap(manifest.peerDependencies, EXPECTED_PEERS.get(definition.name), `${definition.name} peerDependencies`);
  for (const target of Object.values(manifest.exports)) if (!target.startsWith("./") || target.includes("../") || !entries.has(target.slice(2))) fail(`${definition.name} export targetが閉じていません`);
  try { auditImports(entries, manifest); } catch (error) { fail(error.message); }
  return manifest;
}

function expectedPackageFile(definition, version) {
  return `${definition.name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`;
}

export function validateReleaseManifest(manifest, { expectedSource, expectedVersion, allowPreview = false } = {}) {
  exactKeys(manifest, ["schemaVersion", "releaseReady", "repository", "version", "releaseTag", "source", "sourceSet", "buildTooling", "upstreamSdk", "packages"], "release manifest");
  if (manifest.schemaVersion !== 1 || manifest.repository !== REPOSITORY || manifest.version !== RELEASE_VERSION || manifest.releaseTag !== RELEASE_TAG || (expectedVersion && manifest.version !== expectedVersion)) fail("release manifest基本契約が不正です");
  if (manifest.releaseReady !== true && !(allowPreview && manifest.releaseReady === false)) fail("preview manifestはreleaseできません");
  exactKeys(manifest.source, ["commit", "tree", "configOrigin"], "source");
  if (!FULL_SHA.test(manifest.source.commit) || !FULL_SHA.test(manifest.source.tree) || (expectedSource && manifest.source.commit !== expectedSource)) fail("source SHAが不正です");
  if (manifest.releaseReady ? manifest.source.configOrigin !== "git" : manifest.source.configOrigin !== "worktree-preview") fail("source config originが不正です");
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== PACKAGE_DEFINITIONS.length) fail("package集合が不正です");
  const sourcePaths = PACKAGE_DEFINITIONS.flatMap((definition) => manifest.packages?.find((item) => item?.id === definition.id)?.source?.entries?.map((record) => record.path) ?? []).sort((left, right) => left.localeCompare(right, "en"));
  validateRecords(manifest.sourceSet, "entries", sourcePaths, "sourceSet");
  validateRecords(manifest.buildTooling, "files", TOOLING_PATHS, "buildTooling");
  exactKeys(manifest.upstreamSdk, ["baselinePath", "baselineSha256", "repository", "releaseTag", "version", "sourceCommit", "manifestSha256"], "upstreamSdk");
  const configPin = validateConfig(JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../sdk/photo-cloud-release-set.json"), "utf8"))).upstreamSdk;
  if (JSON.stringify(manifest.upstreamSdk) !== JSON.stringify(configPin)) fail("upstream SDK pinが不正です");
  for (let index = 0; index < PACKAGE_DEFINITIONS.length; index += 1) {
    const definition = PACKAGE_DEFINITIONS[index];
    const item = manifest.packages[index];
    exactKeys(item, ["id", "name", "file", "size", "sha256", "integrity", "source", "entries"], "package record");
    if (item.id !== definition.id || item.name !== definition.name || item.file !== expectedPackageFile(definition, manifest.version) || !SAFE_FILE.test(item.file) || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > MAX_TARBALL || !SHA256.test(item.sha256) || item.integrity !== `sha256-${Buffer.from(item.sha256, "hex").toString("base64")}`) fail("package recordが不正です");
    const sourceExpected = item.source.entries?.map(({ path: itemPath }) => itemPath) ?? [];
    validateRecords(item.source, "entries", sourceExpected, `${item.id} source`);
    validateSourcePaths(definition, item.source.entries);
    const entryExpected = packageEntryPaths(definition, sourceExpected);
    validateRecords(item.entries, "files", entryExpected, `${item.id} entries`);
  }
  const flattened = manifest.packages.flatMap((item) => item.source.entries).sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (JSON.stringify(flattened) !== JSON.stringify(manifest.sourceSet.entries)) fail("sourceSetとpackage source集合が一致しません");
  return manifest;
}

function verifyGitSource(manifest, repoRoot) {
  const { commit, tree } = resolveSource(repoRoot, manifest.source.commit);
  if (tree !== manifest.source.tree) fail("source treeがGit objectと一致しません");
  const config = validateConfig(JSON.parse(gitBytes(repoRoot, commit, CONFIG_PATH).toString("utf8")));
  if (config.version !== manifest.version || config.releaseTag !== manifest.releaseTag) fail("選択source configがmanifestと一致しません");
  const selectedSource = [];
  for (const definition of PACKAGE_DEFINITIONS) {
    const records = treeFiles(repoRoot, commit, definition).map(({ repositoryPath }) => {
      const bytes = gitBytes(repoRoot, commit, repositoryPath);
      return { path: repositoryPath, size: bytes.length, sha256: sha256(bytes) };
    });
    const item = manifest.packages.find(({ id }) => id === definition.id);
    if (JSON.stringify(records) !== JSON.stringify(item.source.entries)) fail(`${definition.id} source recordsがGit objectと一致しません`);
    selectedSource.push(...records);
  }
  const sortedSource = selectedSource.sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (JSON.stringify(sortedSource) !== JSON.stringify(manifest.sourceSet.entries)) fail("sourceSetがGit objectと一致しません");
  const tooling = TOOLING_PATHS.map((relative) => {
    const bytes = gitBytes(repoRoot, commit, relative);
    return { path: relative, size: bytes.length, sha256: sha256(bytes) };
  });
  if (JSON.stringify(tooling) !== JSON.stringify(manifest.buildTooling.files)) fail("build toolingが選択Git objectと一致しません");
  const baseline = gitBytes(repoRoot, commit, config.upstreamSdk.baselinePath);
  if (sha256(baseline) !== manifest.upstreamSdk.baselineSha256) fail("upstream baselineが選択Git objectと一致しません");
}

export function verifyReleaseSet(manifestPath, { expectedSource, expectedVersion, expectedManifestSha256, sourceRepositoryRoot, allowPreview = false, exactDirectory = true } = {}) {
  const absolute = path.resolve(manifestPath);
  const directory = path.dirname(absolute);
  const manifestName = path.basename(absolute);
  if (!SAFE_FILE.test(manifestName)) fail("manifest file名が不正です");
  const bytes = readFileSync(absolute);
  if (expectedManifestSha256 && (!SHA256.test(expectedManifestSha256) || sha256(bytes) !== expectedManifestSha256)) fail("manifest輸送hashが一致しません");
  let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); } catch { fail("release manifestがJSONではありません"); }
  validateReleaseManifest(manifest, { expectedSource, expectedVersion, allowPreview });
  if (manifestName !== `niho-photo-cloud-sdk-${manifest.version}-${manifest.source.commit}.json`) fail("manifest file名が不正です");
  const expectedFiles = new Set([manifestName, ...manifest.packages.map(({ file }) => file)]);
  if (exactDirectory) {
    const names = readdirSync(directory).sort();
    if (names.length !== expectedFiles.size || names.some((name) => !expectedFiles.has(name))) fail("artifact directoryに未検証fileがあります");
  }
  for (const item of manifest.packages) {
    const filePath = path.join(directory, item.file);
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("tarballは通常fileである必要があります");
    const tarball = readFileSync(filePath);
    if (tarball.length !== item.size || sha256(tarball) !== item.sha256 || sri(tarball) !== item.integrity) fail(`${item.name} tarball hashが一致しません`);
    const entries = readTarEntries(tarball);
    const records = [...entries].sort(([left], [right]) => left.localeCompare(right, "en")).map(([entryPath, entryBytes]) => ({ path: entryPath, size: entryBytes.length, sha256: sha256(entryBytes) }));
    if (JSON.stringify(records) !== JSON.stringify(item.entries.files)) fail(`${item.name} entry集合/hashがmanifestと一致しません`);
    const definition = PACKAGE_DEFINITIONS.find(({ id }) => id === item.id);
    validatePackage(entries, definition, manifest.version);
  }
  if (sourceRepositoryRoot) {
    if (!path.isAbsolute(sourceRepositoryRoot) || !expectedSource || !expectedVersion) fail("source repository検証には絶対pathとexpected source/versionが必要です");
    if (!manifest.releaseReady) fail("preview manifestにsource release検証は使えません");
    verifyGitSource(manifest, sourceRepositoryRoot);
  }
  return manifest;
}

export function verifyReproducedReleaseSet(candidatePath, reproducedPath, options = {}) {
  const candidate = verifyReleaseSet(candidatePath, options);
  const reproduced = verifyReleaseSet(reproducedPath, options);
  if (!readFileSync(candidatePath).equals(readFileSync(reproducedPath))) fail("独立再生成manifestが一致しません");
  for (const item of candidate.packages) {
    const left = readFileSync(path.join(path.dirname(candidatePath), item.file));
    const right = readFileSync(path.join(path.dirname(reproducedPath), item.file));
    if (!left.equals(right)) fail(`独立再生成tarballが一致しません: ${item.file}`);
  }
  return reproduced;
}

function parseArguments(argv) {
  const allowed = new Set(["--manifest", "--reproduced-manifest", "--expected-source", "--expected-version", "--expected-manifest-sha256", "--source-repository", "--receipt", "--artifact-id", "--artifact-digest", "--artifact-name", "--run-id", "--run-attempt"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || value.startsWith("--") || values[key]) fail("verifier引数が不正です");
    values[key] = value;
  }
  if (!values["--manifest"] || (values["--expected-source"] && !FULL_SHA.test(values["--expected-source"])) || (values["--expected-version"] && !SEMVER.test(values["--expected-version"]))) fail("verifier引数が不足または不正です");
  if (values["--source-repository"] && (!values["--expected-source"] || !values["--expected-version"])) fail("source repository検証にはexpected source/versionが必要です");
  return values;
}

function normalizeDigest(value) {
  if (SHA256.test(value ?? "")) return `sha256:${value}`;
  if (/^sha256:[a-f0-9]{64}$/u.test(value ?? "")) return value;
  fail("artifact digestが不正です");
}

function writeReceipt(file, manifestPath, manifest, values) {
  const id = values["--artifact-id"];
  const name = values["--artifact-name"];
  const runId = values["--run-id"];
  const runAttempt = values["--run-attempt"];
  const expectedName = `niho-photo-cloud-sdk-${manifest.source.commit}-run-${runId}-attempt-${runAttempt}`;
  if (!/^[1-9]\d*$/u.test(id ?? "") || !/^[1-9]\d*$/u.test(runId ?? "") || !/^[1-9]\d*$/u.test(runAttempt ?? "") || name !== expectedName) fail("artifact receipt入力が不正です");
  const receipt = {
    schemaVersion: 1,
    repository: manifest.repository,
    sourceSha: manifest.source.commit,
    version: manifest.version,
    runId,
    runAttempt,
    artifact: { id, name, digest: normalizeDigest(values["--artifact-digest"]) },
    releaseManifest: { file: path.basename(manifestPath), sha256: sha256(readFileSync(manifestPath)) },
  };
  writeFileSync(path.resolve(file), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o644 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = parseArguments(process.argv.slice(2));
    const options = {
      expectedSource: values["--expected-source"],
      expectedVersion: values["--expected-version"],
      expectedManifestSha256: values["--expected-manifest-sha256"],
      sourceRepositoryRoot: values["--source-repository"] ? path.resolve(values["--source-repository"]) : undefined,
    };
    const manifest = values["--reproduced-manifest"]
      ? verifyReproducedReleaseSet(path.resolve(values["--manifest"]), path.resolve(values["--reproduced-manifest"]), options)
      : verifyReleaseSet(path.resolve(values["--manifest"]), options);
    if (values["--receipt"]) writeReceipt(values["--receipt"], path.resolve(values["--manifest"]), manifest, values);
    console.log(`Photo cloud SDK release setを検証しました（${manifest.packages.length} packages）`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Photo cloud SDK検証に失敗しました");
    process.exitCode = 1;
  }
}
