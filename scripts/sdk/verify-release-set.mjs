#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORIES = new Set(["niho-coliving/niho-docs", "niho-life/niho-docs", "niho-life/niho-editor"]);
const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const PACKAGES = new Map([
  ["core", { name: "@niho/docs-core", fileBase: "niho-docs-core" }],
  ["docs-ui", { name: "niho-docs-ui", fileBase: "niho-docs-ui" }],
  ["sdk-ui", { name: "niho-docs-sdk-ui", fileBase: "niho-docs-sdk-ui" }],
]);
const EXPECTED_PEERS = new Map([
  ["@niho/docs-core", []],
  ["niho-docs-ui", ["@niho/docs-core", "@tiptap/core", "@tiptap/extension-bubble-menu", "@tiptap/extension-floating-menu", "@tiptap/extension-list", "@tiptap/extension-table", "@tiptap/pm", "@tiptap/react", "@tiptap/starter-kit", "@tiptap/suggestion", "lucide-react", "markdown-it", "niho-docs-sdk-ui", "prosemirror-markdown", "prosemirror-search", "react", "react-dom"]],
  ["niho-docs-sdk-ui", ["@radix-ui/react-dialog", "@radix-ui/react-popover", "clsx", "lucide-react", "react", "react-dom", "tailwind-merge"]],
]);
const OWNED_PATHS = [
  "apps/docs/package.json",
  "apps/docs/package-lock.json",
  "packages/docs-core",
  "packages/docs-ui",
  "packages/ui",
  "sdk",
  "scripts/sdk",
  ".github/workflows/docs-sdk-ci.yml",
  ".github/workflows/docs-sdk-release.yml",
  "docs/architecture/docs-sdk.md",
  "LICENSE",
];
const FORBIDDEN_ARTIFACT = /(?:^|\/)(?:node_modules|test|tests|testing|fixtures|__tests__|\.git|\.github)(?:\/|$)|(?:\.test|\.spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:tsconfig|vite\.config|vitest\.config|eslint\.config)(?:\.|$)|(?:^|\/)(?:\.env|\.npmrc|npm-debug\.log)(?:\.|$)/u;
const LOCAL_SPEC = /^(?:file:|link:|workspace:|\.\.?\/|\/)/u;
const MAX_TARBALL = 64 * 1024 * 1024;
const MAX_ENTRY = 16 * 1024 * 1024;

export class ReleaseVerificationError extends Error {}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sri(bytes) {
  return `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
}

function fail(message) {
  throw new ReleaseVerificationError(message);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} がobjectではありません`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} のfield集合が不正です`);
}

function safeRelative(value, label) {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0") ||
    value.startsWith("/") || /^[A-Za-z]:/u.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) fail(`${label} が安全な相対pathではありません`);
  return value;
}

function octal(buffer, start, length, label) {
  const text = buffer.subarray(start, start + length).toString("ascii").replace(/\0.*$/su, "").trim();
  if (!/^[0-7]+$/u.test(text)) fail(`${label} のtar octalが不正です`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} のtar数値が不正です`);
  return value;
}

function tarString(buffer, start, length) {
  return buffer.subarray(start, start + length).toString("utf8").replace(/\0.*$/su, "");
}

/** Dependency を使わず、npm tarball の通常fileだけを安全に読み取る。 */
export function readTarEntries(tarballBytes) {
  if (!Buffer.isBuffer(tarballBytes) || tarballBytes.length === 0 || tarballBytes.length > MAX_TARBALL) fail("tarball size が不正です");
  let archive;
  try { archive = gunzipSync(tarballBytes, { maxOutputLength: MAX_TARBALL * 4 }); } catch { fail("tarball gzip が不正です"); }
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
    const storedChecksum = octal(header, 148, 8, "header checksum");
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (checksum !== storedChecksum) fail("tar header checksum が一致しません");
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    safeRelative(fullName, "tar entry");
    if (!fullName.startsWith("package/")) fail("tar entry は package/ 配下が必要です");
    const relative = fullName.slice("package/".length);
    safeRelative(relative, "package entry");
    const type = String.fromCharCode(header[156] || 48);
    if (type !== "0") fail(`通常file以外のtar entryは禁止です: ${relative}`);
    const size = octal(header, 124, 12, "entry size");
    if (size > MAX_ENTRY) fail(`tar entryが大きすぎます: ${relative}`);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > archive.length) fail("tar entry が途中で終わっています");
    if (entries.has(relative)) fail(`tar entryが重複しています: ${relative}`);
    if (FORBIDDEN_ARTIFACT.test(relative)) fail(`公開禁止fileがtarballにあります: ${relative}`);
    entries.set(relative, Buffer.from(archive.subarray(bodyStart, bodyEnd)));
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  if (!ended || entries.size === 0 || !archive.subarray(offset).every((byte) => byte === 0)) fail("tarball終端または内容が不正です");
  return entries;
}

function validateDependencyMap(value, label) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} が不正です`);
  for (const [name, spec] of Object.entries(value)) {
    if (typeof name !== "string" || !name || typeof spec !== "string" || !spec || LOCAL_SPEC.test(spec)) fail(`${label} にlocal dependencyがあります`);
  }
}

function exportTargets(value, targets = []) {
  if (typeof value === "string") targets.push(value);
  else if (value && typeof value === "object" && !Array.isArray(value)) for (const child of Object.values(value)) exportTargets(child, targets);
  else fail("package exports が不正です");
  return targets;
}

function wildcardExists(target, entries) {
  if (!target.includes("*")) return entries.has(target.replace(/^\.\//u, ""));
  const [before, after] = target.replace(/^\.\//u, "").split("*");
  return [...entries.keys()].some((entry) => entry.startsWith(before) && entry.endsWith(after));
}

export function validatePackageTarball(bytes, expectedName, version) {
  if (!SEMVER.test(version ?? "")) fail("package expected versionが不正です");
  const entries = readTarEntries(bytes);
  for (const required of ["package.json", "LICENSE", "THIRD_PARTY_NOTICES.md"]) if (!entries.has(required)) fail(`${expectedName} に ${required} がありません`);
  let manifest;
  try { manifest = JSON.parse(entries.get("package.json").toString("utf8")); } catch { fail(`${expectedName} package.json が不正です`); }
  if (manifest.name !== expectedName || manifest.version !== version || manifest.private !== undefined) fail(`${expectedName} package identity が不正です`);
  if (manifest.scripts !== undefined) fail(`${expectedName} にscriptは含められません`);
  if (manifest.devDependencies !== undefined || manifest.optionalDependencies !== undefined || manifest.bundledDependencies !== undefined || manifest.bundleDependencies !== undefined) fail(`${expectedName} に公開不要dependencyがあります`);
  if (manifest.dependencies !== undefined) fail(`${expectedName} はruntime dependencyを直接同梱しません`);
  validateDependencyMap(manifest.peerDependencies, "peerDependencies");
  const peerNames = Object.keys(manifest.peerDependencies ?? {}).sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(peerNames) !== JSON.stringify(EXPECTED_PEERS.get(expectedName))) fail(`${expectedName} peer dependency allowlistが不正です`);
  if (expectedName === "niho-docs-ui" && (manifest.peerDependencies["@niho/docs-core"] !== version || manifest.peerDependencies["niho-docs-sdk-ui"] !== version)) fail("Docs SDK package間version pinが不正です");
  if ((expectedName === "niho-docs-ui" || expectedName === "niho-docs-sdk-ui") && (manifest.peerDependencies.react === undefined || manifest.peerDependencies["react-dom"] === undefined)) fail("React/ReactDOM peer contractが不正です");
  for (const target of exportTargets(manifest.exports)) {
    if (!target.startsWith("./") || target.includes("../") || !wildcardExists(target, entries)) fail(`${expectedName} のexport targetがtarball内で閉じていません: ${target}`);
  }
  if (expectedName === "@niho/docs-core" && (!entries.has("dist/server/index.js") || !entries.has("dist/server/index.d.ts"))) fail("@niho/docs-core ./server buildがありません");
  if (expectedName === "niho-docs-ui" && manifest.exports?.["./sdk-dialog-host"] !== "./src/sdk-dialog-host.tsx") fail("Docs SDK dialog host exportがありません");
  return { entries, manifest };
}

function ownershipDigest(records) {
  return sha256(Buffer.from(records.map(({ path: itemPath, files, sha256: digest }) => `${itemPath}\0${files}\0${digest}\n`).join("")));
}

export function validateReleaseManifest(manifest, { expectedSource, expectedVersion, allowPreview = false } = {}) {
  exactKeys(manifest, ["schemaVersion", "repository", "version", "source", "buildTooling", "packages", "sourceOwnership", "uiSingleton"], "release manifest");
  if (manifest.schemaVersion !== 1 || !REPOSITORIES.has(manifest.repository) || !SEMVER.test(manifest.version) || (expectedVersion && manifest.version !== expectedVersion)) fail("release manifest基本契約が不正です");
  exactKeys(manifest.source, ["commit", "tree", "configOrigin"], "source");
  if (!COMMIT.test(manifest.source.commit) || !COMMIT.test(manifest.source.tree) || (expectedSource && manifest.source.commit !== expectedSource)) fail("source SHAが不正です");
  if (manifest.source.configOrigin !== "git" && !(allowPreview && manifest.source.configOrigin === "worktree-preview")) fail("worktree preview manifestはreleaseできません");
  exactKeys(manifest.buildTooling, ["typescriptVersion", "packageJsonSha256", "packageLockSha256"], "buildTooling");
  if (!SEMVER.test(manifest.buildTooling.typescriptVersion) || !SHA256.test(manifest.buildTooling.packageJsonSha256) || !SHA256.test(manifest.buildTooling.packageLockSha256)) fail("build tooling provenanceが不正です");
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== PACKAGES.size) fail("package集合が不正です");
  const ids = new Set();
  const names = new Set();
  const files = new Set();
  for (const item of manifest.packages) {
    exactKeys(item, ["id", "name", "file", "size", "sha256", "integrity"], "package record");
    const expectedPackage = PACKAGES.get(item.id);
    if (expectedPackage?.name !== item.name || `${expectedPackage.fileBase}-${manifest.version}.tgz` !== item.file || ids.has(item.id) || names.has(item.name) || files.has(item.file)) fail("package allowlistが不正です");
    if (!SAFE_FILE.test(item.file) || !item.file.endsWith(".tgz") || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > MAX_TARBALL || !SHA256.test(item.sha256) || item.integrity !== `sha256-${Buffer.from(item.sha256, "hex").toString("base64")}`) fail("package recordが不正です");
    ids.add(item.id); names.add(item.name); files.add(item.file);
  }
  exactKeys(manifest.sourceOwnership, ["algorithm", "digest", "paths"], "sourceOwnership");
  if (manifest.sourceOwnership.algorithm !== "sha256-git-file-set-v1" || !SHA256.test(manifest.sourceOwnership.digest) || !Array.isArray(manifest.sourceOwnership.paths) || manifest.sourceOwnership.paths.length !== OWNED_PATHS.length) fail("source ownershipが不正です");
  for (let index = 0; index < OWNED_PATHS.length; index += 1) {
    const record = manifest.sourceOwnership.paths[index];
    exactKeys(record, ["path", "files", "sha256"], "source ownership record");
    if (record.path !== OWNED_PATHS[index] || !Number.isSafeInteger(record.files) || record.files < 0 || (!allowPreview && record.files === 0) || !SHA256.test(record.sha256)) fail("source ownership pathが不正です");
  }
  if (manifest.sourceOwnership.digest !== ownershipDigest(manifest.sourceOwnership.paths)) fail("source ownership digestが不正です");
  exactKeys(manifest.uiSingleton, ["package", "hostExport"], "uiSingleton");
  if (manifest.uiSingleton.package !== "niho-docs-sdk-ui" || manifest.uiSingleton.hostExport !== "niho-docs-ui/sdk-dialog-host") fail("UI singleton契約が不正です");
  return manifest;
}

function gitRead(repoRoot, args, label) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 128 * 1024 * 1024 });
  } catch {
    fail(`選択sourceの${label}を読めません`);
  }
}

function gitObject(repoRoot, source, file) {
  return gitRead(repoRoot, ["show", `${source}:${file}`], `検証対象: ${file}`);
}

function sourceOwnership(repoRoot, source) {
  const paths = OWNED_PATHS.map((ownedPath) => {
    const output = gitRead(repoRoot, ["ls-tree", "-rz", "--full-tree", source, "--", ownedPath], `tree: ${ownedPath}`);
    const files = output.toString("utf8").split("\0").filter(Boolean).map((record) => {
      const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/u.exec(record);
      if (!match || !match[1].startsWith("100") || match[2] !== "blob") fail(`選択sourceに通常file以外があります: ${ownedPath}`);
      safeRelative(match[4], "Git tree entry");
      return match[4];
    });
    const material = files.map((file) => `${file}\0${sha256(gitObject(repoRoot, source, file))}\n`).join("");
    return { path: ownedPath, files: files.length, sha256: sha256(Buffer.from(material)) };
  });
  return { algorithm: "sha256-git-file-set-v1", digest: ownershipDigest(paths), paths };
}

function verifySelectedSource(manifest, repoRoot, expectedSource, expectedVersion) {
  if (!path.isAbsolute(repoRoot ?? "") || !expectedSource || !expectedVersion) fail("selected source検証にはrepository/source/versionが必要です");
  let resolved;
  try { resolved = execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", `${expectedSource}^{commit}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { fail("選択source commitを解決できません"); }
  if (resolved !== expectedSource) fail("選択source commitが一致しません");
  const tree = gitRead(repoRoot, ["rev-parse", "--verify", `${expectedSource}^{tree}`], "tree SHA").toString("utf8").trim();
  if (manifest.source.tree !== tree) fail("選択source treeが一致しません");
  const packageJson = gitObject(repoRoot, expectedSource, "apps/docs/package.json");
  const packageLock = gitObject(repoRoot, expectedSource, "apps/docs/package-lock.json");
  const releaseConfig = gitObject(repoRoot, expectedSource, "sdk/release-set.json");
  let lock;
  let config;
  try {
    lock = JSON.parse(packageLock.toString("utf8"));
    config = JSON.parse(releaseConfig.toString("utf8"));
  } catch {
    fail("選択sourceのtooling/config JSONが不正です");
  }
  const typescriptVersion = lock?.packages?.["node_modules/typescript"]?.version ?? lock?.dependencies?.typescript?.version;
  if (config?.version !== expectedVersion || manifest.version !== expectedVersion) fail("選択sourceとrelease versionが一致しません");
  if (manifest.buildTooling.packageJsonSha256 !== sha256(packageJson) || manifest.buildTooling.packageLockSha256 !== sha256(packageLock) || manifest.buildTooling.typescriptVersion !== typescriptVersion) fail("選択sourceとbuild tooling provenanceが一致しません");
  if (JSON.stringify(manifest.sourceOwnership) !== JSON.stringify(sourceOwnership(repoRoot, expectedSource))) fail("選択sourceとsource ownership provenanceが一致しません");
}

export function verifyReleaseSet(manifestPath, { expectedSource, expectedVersion, expectedManifestSha256, sourceRepositoryRoot, allowPreview = false, exactDirectory = true } = {}) {
  const absolute = path.resolve(manifestPath);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("manifestは通常fileが必要です");
  const manifestBytes = readFileSync(absolute);
  if (expectedManifestSha256 !== undefined && (!SHA256.test(expectedManifestSha256) || sha256(manifestBytes) !== expectedManifestSha256)) fail("再生成で確認済みのmanifest hashと一致しません");
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch { fail("manifest JSONが不正です"); }
  validateReleaseManifest(manifest, { expectedSource, expectedVersion, allowPreview });
  if (sourceRepositoryRoot) verifySelectedSource(manifest, sourceRepositoryRoot, expectedSource, expectedVersion);
  const expectedManifestName = `niho-docs-sdk-${manifest.version}-${manifest.source.commit}.json`;
  if (path.basename(absolute) !== expectedManifestName) fail("manifest file名が不正です");
  const directory = path.dirname(absolute);
  const expectedFiles = new Set([expectedManifestName, ...manifest.packages.map(({ file }) => file)]);
  if (exactDirectory) {
    const actual = readdirSync(directory).sort();
    if (actual.length !== expectedFiles.size || actual.some((name) => !expectedFiles.has(name))) fail("artifact directoryにunexpected fileがあります");
  }
  for (const item of manifest.packages) {
    const file = path.join(directory, item.file);
    const itemStat = lstatSync(file);
    if (!itemStat.isFile() || itemStat.isSymbolicLink()) fail("package artifactは通常fileが必要です");
    const bytes = readFileSync(file);
    if (bytes.length !== item.size || sha256(bytes) !== item.sha256 || sri(bytes) !== item.integrity) fail(`${item.name} のhash/sizeが一致しません`);
    validatePackageTarball(bytes, item.name, manifest.version);
  }
  return manifest;
}

/** 再生成はread-only jobの信頼済み生成器で行い、受領artifactのコードは実行しない。 */
export function verifyReproducedReleaseSet(manifestPath, reproducedManifestPath, options) {
  if (!options?.expectedSource || !options?.expectedVersion || !options?.sourceRepositoryRoot) fail("再生成照合には選択Git source/version/repositoryが必要です");
  const actual = verifyReleaseSet(manifestPath, options);
  const reproduced = verifyReleaseSet(reproducedManifestPath, options);
  for (const item of actual.packages) {
    const expectedItem = reproduced.packages.find(({ id }) => id === item.id);
    const entries = readTarEntries(readFileSync(path.join(path.dirname(manifestPath), item.file)));
    const expectedEntries = readTarEntries(readFileSync(path.join(path.dirname(reproducedManifestPath), expectedItem.file)));
    if (entries.size !== expectedEntries.size) fail(`${item.name} の再生成file集合が一致しません`);
    for (const [file, bytes] of expectedEntries) {
      if (!entries.get(file)?.equals(bytes)) fail(`${item.name}/${file} が選択sourceからの再生成結果と一致しません`);
    }
  }
  return actual;
}

function cli(argv) {
  const values = {};
  const allowed = new Set(["--manifest", "--expected-source", "--expected-version", "--source-repository", "--reproduced-manifest", "--expected-manifest-sha256"]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || value.startsWith("--") || values[key]) fail("使い方: verify-release-set.mjs --manifest PATH [--expected-source FULLSHA --expected-version SEMVER --source-repository PATH]");
    values[key] = value;
  }
  if (!values["--manifest"] || (values["--expected-source"] && !COMMIT.test(values["--expected-source"])) || (values["--expected-version"] && !SEMVER.test(values["--expected-version"]))) fail("verifier引数が不正です");
  if (values["--source-repository"] && (!values["--expected-source"] || !values["--expected-version"])) fail("source repository検証にはexpected source/versionが必要です");
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = cli(process.argv.slice(2));
    const options = {
      expectedSource: values["--expected-source"],
      expectedVersion: values["--expected-version"],
      expectedManifestSha256: values["--expected-manifest-sha256"],
      sourceRepositoryRoot: values["--source-repository"] ? path.resolve(values["--source-repository"]) : undefined,
    };
    const manifest = values["--reproduced-manifest"]
      ? verifyReproducedReleaseSet(values["--manifest"], values["--reproduced-manifest"], options)
      : verifyReleaseSet(values["--manifest"], options);
    console.log(`Docs SDK release setを検証しました（${manifest.packages.length} packages）`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Docs SDK release setの検証に失敗しました");
    process.exitCode = 1;
  }
}
