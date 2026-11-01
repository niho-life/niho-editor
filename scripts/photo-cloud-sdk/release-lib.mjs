import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "../../packages/photo-cloud-library/node_modules/typescript/lib/typescript.js";

export const CONFIG_PATH = "sdk/photo-cloud-release-set.json";
export const NOTICE_PATH = "sdk/PHOTO_CLOUD_THIRD_PARTY_NOTICES.md";
export const REPOSITORY = "niho-life/niho-editor";
export const RELEASE_VERSION = "0.1.1";
export const RELEASE_TAG = "photo-cloud-sdk-v0.1.1";
export const FULL_SHA = /^[a-f0-9]{40}$/u;
export const SHA256 = /^[a-f0-9]{64}$/u;
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
export const PACKAGE_DEFINITIONS = [
  { id: "cloud-library", name: "@niho/photo-cloud-library", sourceRoot: "packages/photo-cloud-library", include: ["package.json", "README.md", "src/**"] },
  { id: "library-contract", name: "@niho/photo-library-contract", sourceRoot: "packages/photo-library-contract", include: ["package.json", "README.md", "src/**", "sdk-baseline.json"] },
];
export const EXPECTED_PEERS = new Map([
  ["@niho/photo-cloud-library", {
    "@niho/photo-library-contract": "0.1.1",
    "niho-photo-contract": "0.1.6",
    "niho-photo-editing": "0.1.6",
  }],
  ["@niho/photo-library-contract", {}],
]);
export const TOOLING_PATHS = [
  CONFIG_PATH,
  NOTICE_PATH,
  "scripts/photo-cloud-sdk/release-lib.mjs",
  "scripts/photo-cloud-sdk/pack-release-set.mjs",
  "scripts/photo-cloud-sdk/verify-release-set.mjs",
  "scripts/photo-cloud-sdk/smoke-consumer.mjs",
  "scripts/photo-cloud-sdk/release-set.test.mjs",
  ".github/workflows/photo-cloud-sdk-ci.yml",
  ".github/workflows/photo-cloud-sdk-release.yml",
  "docs/architecture/photo-cloud-sdk.md",
  "packages/photo-cloud-library/package-lock.json",
  "packages/photo-library-contract/package-lock.json",
  "LICENSE",
];
export const RUNTIME_TOOL_PATHS = [
  "scripts/photo-cloud-sdk/release-lib.mjs",
  "scripts/photo-cloud-sdk/pack-release-set.mjs",
  "scripts/photo-cloud-sdk/verify-release-set.mjs",
];
export const FORBIDDEN_ENTRY = /(?:^|\/)(?:node_modules|test|tests|testing|fixtures|__tests__|native|tauri|firebase|next|private|\.git|\.github)(?:\/|$)|(?:\.test|\.spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:tsconfig|vite\.config|vitest\.config|eslint\.config|package-lock\.json|\.env|\.npmrc)(?:\.|$)/u;
const FORBIDDEN_DEPENDENCY = /^(?:next|firebase|@tauri-apps(?:\/|$)|niho-photo-ui(?:\/|$)|react(?:\/|$)|react-dom(?:\/|$))/u;

export class PhotoCloudReleaseError extends Error {}

export function fail(message) {
  throw new PhotoCloudReleaseError(message);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sri(bytes) {
  return `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
}

export function safeRelative(value, label = "path") {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/u.test(value) || value.split("/").some((part) => !part || part === "." || part === "..")) fail(`${label} が安全な相対pathではありません`);
  return value;
}

function git(repoRoot, args, options = {}) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], { maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options });
  } catch (error) {
    const detail = error?.stderr?.toString("utf8").trim();
    fail(`Git objectの読み取りに失敗しました${detail ? `: ${detail}` : ""}`);
  }
}

export function resolveSource(repoRoot, sourceSha) {
  if (!FULL_SHA.test(sourceSha ?? "")) fail("--source-sha は40桁full SHAが必要です");
  const commit = git(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${sourceSha}^{commit}`], { encoding: "utf8" }).trim();
  const tree = git(repoRoot, ["rev-parse", "--verify", `${commit}^{tree}`], { encoding: "utf8" }).trim();
  if (commit !== sourceSha || !FULL_SHA.test(tree)) fail("source SHAをcommitとして解決できません");
  return { commit, tree };
}

export function gitBytes(repoRoot, commit, relative) {
  safeRelative(relative, "Git object path");
  return git(repoRoot, ["show", `${commit}:${relative}`]);
}

function globRegex(pattern) {
  safeRelative(pattern.replaceAll("*", "x"), "source glob");
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") { index += 1; expression += "(?:.*/)?"; } else expression += ".*";
    } else if (character === "*") expression += "[^/]*";
    else expression += /[.+?^${}()|[\]\\]/u.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${expression}$`, "u");
}

function selected(relative, definition) {
  return definition.include.some((pattern) => globRegex(pattern).test(relative));
}

export function treeFiles(repoRoot, commit, definition) {
  const output = git(repoRoot, ["ls-tree", "-rz", "-r", "--full-tree", commit, "--", definition.sourceRoot]);
  if (!output.length) fail(`Git sourceがありません: ${definition.sourceRoot}`);
  const prefix = `${definition.sourceRoot}/`;
  const result = [];
  for (const record of output.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/u.exec(record);
    if (!match) fail("git ls-tree recordが不正です");
    const [, mode, type, object, file] = match;
    safeRelative(file, "Git tree entry");
    if (!file.startsWith(prefix)) fail("Git tree entryがsource root外です");
    const relative = file.slice(prefix.length);
    if (!selected(relative, definition)) continue;
    if (mode === "120000") fail(`symlinkはsourceに含められません: ${file}`);
    if (!mode.startsWith("100") || type !== "blob") fail(`特殊fileはsourceに含められません: ${file}`);
    if (FORBIDDEN_ENTRY.test(relative)) fail(`公開禁止sourceが選択されました: ${file}`);
    result.push({ relative, repositoryPath: file, object });
  }
  return result.sort((left, right) => left.relative.localeCompare(right.relative, "en"));
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { fail(`${label} JSONが不正です`); }
}

function exactObject(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value) !== JSON.stringify(expected)) fail(`${label} が固定契約と一致しません`);
}

export function validateConfig(config) {
  if (!config || config.schemaVersion !== 1 || config.repository !== REPOSITORY || config.version !== RELEASE_VERSION || config.releaseTag !== RELEASE_TAG) fail("photo cloud release config基本契約が不正です");
  if (JSON.stringify(config.packages) !== JSON.stringify(PACKAGE_DEFINITIONS)) fail("package source allowlistが不正です");
  const expectedUpstream = {
    baselinePath: "packages/photo-library-contract/sdk-baseline.json",
    baselineSha256: "aa5defc1f64a28e80aeaa1ab1e146d3151ae6255f838ea17d0fc70f4318aeb2d",
    repository: "niho-life/niho-photo",
    releaseTag: "photo-sdk-v0.1.6",
    version: "0.1.6",
    sourceCommit: "bc95b2764b089dfd4bc7beaf3626c12c636f809a",
    manifestSha256: "043f234ed28c765e0dd10d6c37e1a5a2d18dcc09f37d6060844c1716d40b3dc5",
  };
  exactObject(config.upstreamSdk, expectedUpstream, "upstream SDK pin");
  return config;
}

function validateBaseline(bytes, pin) {
  if (sha256(bytes) !== pin.baselineSha256) fail("upstream SDK baseline hashがpinと一致しません");
  const baseline = parseJson(bytes, "sdk-baseline.json");
  if (baseline.repository !== pin.repository || baseline.releaseTag !== pin.releaseTag || baseline.sourceCommit !== pin.sourceCommit || baseline.manifest?.sha256 !== pin.manifestSha256 || !baseline.packages?.every((item) => item?.file?.endsWith(`-${pin.version}.tgz`))) fail("upstream SDK baseline内容がpinと一致しません");
  return { ...pin };
}

function fileSetRecords(files, prefix = "") {
  return [...files].sort(([left], [right]) => left.localeCompare(right, "en")).map(([file, bytes]) => ({
    path: prefix ? `${prefix}/${file}` : file,
    size: bytes.length,
    sha256: sha256(bytes),
  }));
}

export function recordDigest(records) {
  return sha256(Buffer.from(records.map(({ path: itemPath, size, sha256: digest }) => `${itemPath}\0${size}\0${digest}\n`).join("")));
}

function packageManifest(definition, original, repository) {
  const manifest = structuredClone(original);
  for (const field of ["private", "scripts", "dependencies", "devDependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies", "peerDependenciesMeta"]) delete manifest[field];
  manifest.name = definition.name;
  manifest.version = RELEASE_VERSION;
  manifest.type = "module";
  manifest.license = "SEE LICENSE IN LICENSE";
  manifest.repository = { type: "git", url: `https://github.com/${repository}.git`, directory: definition.sourceRoot };
  manifest.files = definition.id === "library-contract" ? ["src", "README.md", "sdk-baseline.json", "LICENSE", "THIRD_PARTY_NOTICES.md"] : ["src", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"];
  manifest.exports = definition.id === "library-contract"
    ? { ".": "./src/v1.ts", "./sdk-baseline": "./sdk-baseline.json" }
    : { ".": "./src/index.ts" };
  const peers = EXPECTED_PEERS.get(definition.name);
  if (Object.keys(peers).length) manifest.peerDependencies = peers;
  else delete manifest.peerDependencies;
  return manifest;
}

function dependencyRoot(specifier) {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

function resolveRelative(files, from, specifier) {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (joined === ".." || joined.startsWith("../") || joined.startsWith("/")) return { escaped: true };
  const withoutExtension = joined.replace(/\.(?:m?js)$/u, "");
  const candidates = [joined, `${joined}.ts`, `${joined}.tsx`, `${joined}.js`, `${joined}.json`, `${withoutExtension}.ts`, `${withoutExtension}.tsx`, `${joined}/index.ts`, `${joined}/index.tsx`];
  return { file: candidates.find((candidate) => files.has(candidate)) };
}

export function auditImports(files, manifest) {
  const names = new Set(files.keys());
  const peers = new Set(Object.keys(manifest.peerDependencies ?? {}));
  for (const [file, bytes] of files) {
    if (/\.(?:pem|key|p12|pfx)$/iu.test(file) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(bytes.toString("utf8"))) fail(`credentialを含む可能性があるfileは禁止です: ${file}`);
    if (!/\.[cm]?[jt]sx?$/u.test(file)) continue;
    const text = bytes.toString("utf8");
    const imports = new Set(ts.preProcessFile(text, true, true).importedFiles.map(({ fileName }) => fileName));
    for (const match of text.matchAll(/(?:import\s*\(|require\s*\()\s*["']([^"']+)["']/gu)) imports.add(match[1]);
    for (const specifier of imports) {
      if (specifier.startsWith(".")) {
        const resolved = resolveRelative(names, file, specifier);
        if (resolved.escaped) fail(`package外へのimportは禁止です: ${file} -> ${specifier}`);
        if (!resolved.file) fail(`相対import closureに欠落があります: ${file} -> ${specifier}`);
      } else {
        const dependency = dependencyRoot(specifier);
        if (FORBIDDEN_DEPENDENCY.test(dependency)) fail(`公開SDK禁止dependencyです: ${file} -> ${specifier}`);
        if (!peers.has(dependency)) fail(`source importに対応するexact peerがありません: ${file} -> ${specifier}`);
      }
    }
  }
}

function writeOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) fail("tar数値がfieldに収まりません");
  header.write(encoded, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function tarPath(value) {
  if (Buffer.byteLength(value) <= 100) return { name: value, prefix: "" };
  for (let index = value.lastIndexOf("/"); index > 0; index = value.lastIndexOf("/", index - 1)) {
    const prefix = value.slice(0, index);
    const name = value.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  fail(`tar pathが長すぎます: ${value}`);
}

export function gzipStored(bytes) {
  const data = Buffer.from(bytes);
  if (data.length > 0xffffffff) throw new RangeError("gzip input exceeds 32-bit size");
  const chunks = [Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255])];
  let offset = 0;
  do {
    const size = Math.min(65535, data.length - offset);
    const block = Buffer.alloc(5);
    block[0] = offset + size === data.length ? 1 : 0;
    block.writeUInt16LE(size, 1);
    block.writeUInt16LE(size ^ 0xffff, 3);
    chunks.push(block, data.subarray(offset, offset + size));
    offset += size;
  } while (offset < data.length);
  let checksum = 0xffffffff;
  for (const byte of data) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE((checksum ^ 0xffffffff) >>> 0, 0);
  trailer.writeUInt32LE(data.length, 4);
  chunks.push(trailer);
  return Buffer.concat(chunks);
}

export function createTarGzip(entries) {
  const chunks = [];
  for (const [relative, bytes] of [...entries].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    safeRelative(relative, "tar entry");
    const full = `package/${relative}`;
    const { name, prefix } = tarPath(full);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, bytes.length);
    writeOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    if (prefix) header.write(prefix, 345, 155, "utf8");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    header[154] = 0;
    header[155] = 32;
    chunks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipStored(Buffer.concat(chunks));
}

function actualToolBytes(toolingRoot, relative) {
  const executingRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const root = relative.startsWith("scripts/photo-cloud-sdk/") ? executingRoot : toolingRoot;
  try { return readFileSync(path.join(root, ...relative.split("/"))); } catch { fail(`実行tooling fileがありません: ${relative}`); }
}

function toolingRecords(repoRoot, toolingRoot, commit, preview) {
  return TOOLING_PATHS.map((relative) => {
    const actual = actualToolBytes(toolingRoot, relative);
    if (!preview) {
      const selected = gitBytes(repoRoot, commit, relative);
      if (sha256(actual) !== sha256(selected)) fail(`実行toolingが選択commitと一致しません: ${relative}`);
    }
    return { path: relative, size: actual.length, sha256: sha256(actual) };
  });
}

function collectPackage(repoRoot, commit, definition, license, notice, repository) {
  const source = new Map();
  for (const entry of treeFiles(repoRoot, commit, definition)) source.set(entry.relative, gitBytes(repoRoot, commit, entry.repositoryPath));
  const required = definition.id === "library-contract" ? ["package.json", "README.md", "src/v1.ts", "sdk-baseline.json"] : ["package.json", "README.md", "src/index.ts"];
  for (const relative of required) if (!source.has(relative)) fail(`${definition.id} sourceに必須fileがありません: ${relative}`);
  const transformed = new Map(source);
  const originalManifest = parseJson(source.get("package.json"), `${definition.id}/package.json`);
  const manifest = packageManifest(definition, originalManifest, repository);
  transformed.set("package.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  transformed.set("LICENSE", license);
  transformed.set("THIRD_PARTY_NOTICES.md", notice);
  auditImports(transformed, manifest);
  const sourceEntries = fileSetRecords(source, definition.sourceRoot);
  const entries = fileSetRecords(transformed);
  return {
    source: { algorithm: "sha256-path-size-content-v1", digest: recordDigest(sourceEntries), entries: sourceEntries },
    entries: { algorithm: "sha256-path-size-content-v1", digest: recordDigest(entries), files: entries },
    bytes: createTarGzip(transformed),
  };
}

function artifactName(definition) {
  return `${definition.name.replace(/^@/u, "").replace("/", "-")}-${RELEASE_VERSION}.tgz`;
}

export function packReleaseSet({ repoRoot, toolingRoot = repoRoot, sourceSha, outputDirectory, toolingWorktree = false } = {}) {
  if (!path.isAbsolute(repoRoot ?? "") || !path.isAbsolute(toolingRoot ?? "") || !path.isAbsolute(outputDirectory ?? "")) fail("repoRoot/toolingRoot/outputDirectoryは絶対pathが必要です");
  const { commit, tree } = resolveSource(repoRoot, sourceSha);
  const configBytes = toolingWorktree ? readFileSync(path.join(toolingRoot, CONFIG_PATH)) : gitBytes(repoRoot, commit, CONFIG_PATH);
  const notice = toolingWorktree ? readFileSync(path.join(toolingRoot, NOTICE_PATH)) : gitBytes(repoRoot, commit, NOTICE_PATH);
  const config = validateConfig(parseJson(configBytes, CONFIG_PATH));
  const license = gitBytes(repoRoot, commit, "LICENSE");
  const baseline = gitBytes(repoRoot, commit, config.upstreamSdk.baselinePath);
  const upstreamSdk = validateBaseline(baseline, config.upstreamSdk);
  const toolingFiles = toolingRecords(repoRoot, toolingRoot, commit, toolingWorktree);
  if (existsSync(outputDirectory)) fail("output directoryは未作成である必要があります");
  const parent = path.dirname(outputDirectory);
  if (!existsSync(parent) || !lstatSync(parent).isDirectory()) fail("outputの親directoryがありません");
  mkdirSync(outputDirectory, { mode: 0o755 });
  try {
    const packages = [];
    const allSourceEntries = [];
    for (const definition of config.packages) {
      const packed = collectPackage(repoRoot, commit, definition, license, notice, config.repository);
      const file = artifactName(definition);
      writeFileSync(path.join(outputDirectory, file), packed.bytes, { flag: "wx", mode: 0o644 });
      packages.push({
        id: definition.id,
        name: definition.name,
        file,
        size: packed.bytes.length,
        sha256: sha256(packed.bytes),
        integrity: sri(packed.bytes),
        source: packed.source,
        entries: packed.entries,
      });
      allSourceEntries.push(...packed.source.entries);
    }
    const sourceEntries = allSourceEntries.sort((left, right) => left.path.localeCompare(right.path, "en"));
    const manifest = {
      schemaVersion: 1,
      releaseReady: !toolingWorktree,
      repository: config.repository,
      version: config.version,
      releaseTag: config.releaseTag,
      source: { commit, tree, configOrigin: toolingWorktree ? "worktree-preview" : "git" },
      sourceSet: { algorithm: "sha256-path-size-content-v1", digest: recordDigest(sourceEntries), entries: sourceEntries },
      buildTooling: { algorithm: "sha256-path-size-content-v1", digest: recordDigest(toolingFiles), files: toolingFiles },
      upstreamSdk,
      packages,
    };
    const manifestFile = `niho-photo-cloud-sdk-${config.version}-${commit}.json`;
    writeFileSync(path.join(outputDirectory, manifestFile), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    return { manifest, manifestFile };
  } catch (error) {
    rmSync(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}
