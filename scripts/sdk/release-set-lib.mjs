import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import ts from "../../apps/docs/node_modules/typescript/lib/typescript.js";

import { sha256, sri, validatePackageTarball } from "./verify-release-set.mjs";

const REPOSITORIES = new Set(["niho-coliving/niho-docs", "niho-life/niho-docs", "niho-life/niho-editor"]);
const FULL_SHA = /^[a-f0-9]{40}$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;
const NOTICE_PATH = "sdk/THIRD_PARTY_NOTICES.md";
const OWNED_SOURCE_PATHS = [
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
const EXPECTED_PACKAGES = [
  { id: "core", name: "@niho/docs-core", sourceRoot: "packages/docs-core", include: ["package.json", "src/**"], exclude: ["**/*.test.*", "fixtures/**", "test/**"] },
  { id: "docs-ui", name: "niho-docs-ui", sourceRoot: "packages/docs-ui", include: ["package.json", "README.md", "src/**"], exclude: ["**/*.test.*", "src/**/fixtures/**", "src/testing/**"] },
  { id: "sdk-ui", name: "niho-docs-sdk-ui", sourceRoot: "packages/ui", include: ["package.json", "tailwind-theme.cjs", "src/**"], exclude: ["**/*.test.*"] },
];
const EXPECTED_PEERS = {
  core: [],
  "docs-ui": ["@niho/docs-core", "@tiptap/core", "@tiptap/extension-bubble-menu", "@tiptap/extension-floating-menu", "@tiptap/extension-list", "@tiptap/extension-table", "@tiptap/pm", "@tiptap/react", "@tiptap/starter-kit", "@tiptap/suggestion", "lucide-react", "markdown-it", "niho-docs-sdk-ui", "prosemirror-markdown", "prosemirror-search", "react", "react-dom"],
  "sdk-ui": ["@radix-ui/react-dialog", "@radix-ui/react-popover", "clsx", "lucide-react", "react", "react-dom", "tailwind-merge"],
};
const FORBIDDEN_DEPENDENCIES = ["next", "@tauri-apps", "firebase", "niho-desktop-account"];
const FORBIDDEN_PATH = /(?:^|\/)(?:node_modules|test|tests|testing|fixtures|__tests__|\.git|\.github)(?:\/|$)|(?:\.test|\.spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:\.env|\.npmrc|npm-debug\.log)(?:\.|$)|(?:^|\/)(?:tsconfig|vite\.config|vitest\.config|eslint\.config)(?:\.|$)/u;

export class SdkReleaseError extends Error {}

function fail(message) {
  throw new SdkReleaseError(message);
}

function safeRelative(value, label = "path") {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0") ||
    value.startsWith("/") || /^[A-Za-z]:/u.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) fail(`${label} が安全な相対pathではありません`);
  return value;
}

function globRegex(pattern) {
  safeRelative(pattern.replaceAll("*", "x"), "glob");
  let result = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") { index += 1; result += "(?:.*/)?"; }
        else result += ".*";
      } else result += "[^/]*";
    } else result += /[.+?^${}()|[\]\\]/u.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${result}$`, "u");
}

function selected(relative, definition) {
  return definition.include.some((pattern) => globRegex(pattern).test(relative)) && !definition.exclude.some((pattern) => globRegex(pattern).test(relative));
}

export function validateConfig(config) {
  if (!config || config.schemaVersion !== 1 || !REPOSITORIES.has(config.repository) || !SEMVER.test(config.version ?? "")) fail("release-set基本契約が不正です");
  if (!Array.isArray(config.packages) || config.packages.length !== EXPECTED_PACKAGES.length) fail("release-set package集合が不正です");
  for (let index = 0; index < EXPECTED_PACKAGES.length; index += 1) {
    const definition = config.packages[index];
    const expected = EXPECTED_PACKAGES[index];
    if (!definition || definition.id !== expected.id || definition.name !== expected.name || definition.sourceRoot !== expected.sourceRoot || !PACKAGE_NAME.test(definition.name)) fail("release-set package allowlistが不正です");
    if (!Array.isArray(definition.include) || !definition.include.length || !Array.isArray(definition.exclude)) fail("release-set include/excludeが不正です");
    if (JSON.stringify(definition.include) !== JSON.stringify(expected.include) || JSON.stringify(definition.exclude) !== JSON.stringify(expected.exclude)) fail("release-set source pattern allowlistが不正です");
    for (const pattern of [...definition.include, ...definition.exclude]) globRegex(pattern);
  }
  if (JSON.stringify(config.ownedSourcePaths) !== JSON.stringify(OWNED_SOURCE_PATHS)) fail("owned source allowlistが不正です");
  return config;
}

function git(repoRoot, args, options = {}) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], { maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options });
  } catch (error) {
    const detail = error?.stderr?.toString("utf8").trim();
    fail(`Git objectの読み取りに失敗しました${detail ? `: ${detail}` : ""}`);
  }
}

function resolveSource(repoRoot, sourceSha) {
  if (!FULL_SHA.test(sourceSha ?? "")) fail("--source-sha は40桁のfull SHAが必要です");
  const commit = git(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${sourceSha}^{commit}`], { encoding: "utf8" }).trim();
  const tree = git(repoRoot, ["rev-parse", "--verify", `${commit}^{tree}`], { encoding: "utf8" }).trim();
  if (commit !== sourceSha || !FULL_SHA.test(tree)) fail("source SHAをcommitとして解決できません");
  return { commit, tree };
}

function treeEntries(repoRoot, commit, sourcePath, { missing = false } = {}) {
  safeRelative(sourcePath, "Git source path");
  const output = git(repoRoot, ["ls-tree", "-rz", "--full-tree", commit, "--", sourcePath]);
  if (!output.length) {
    if (missing) return [];
    fail(`Git sourceがありません: ${sourcePath}`);
  }
  return output.toString("utf8").split("\0").filter(Boolean).map((record) => {
    const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/u.exec(record);
    if (!match) fail("git ls-tree recordが不正です");
    const [, mode, type, object, file] = match;
    safeRelative(file, "Git tree entry");
    if (mode === "120000") fail(`symlinkはSDK sourceに含められません: ${file}`);
    if (!mode?.startsWith("100") || type !== "blob") fail(`通常file以外はSDK sourceに含められません: ${file}`);
    return { file, object };
  });
}

function gitBytes(repoRoot, commit, file) {
  safeRelative(file, "Git object path");
  return git(repoRoot, ["show", `${commit}:${file}`]);
}

function readJson(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { fail(`${label} JSONが不正です`); }
}

function packageManifest(definition, original, version, repository) {
  const manifest = structuredClone(original);
  delete manifest.private;
  delete manifest.scripts;
  delete manifest.devDependencies;
  delete manifest.dependencies;
  delete manifest.optionalDependencies;
  delete manifest.bundledDependencies;
  delete manifest.bundleDependencies;
  manifest.name = definition.name;
  manifest.version = version;
  manifest.license = "SEE LICENSE IN LICENSE";
  manifest.repository = { type: "git", url: `https://github.com/${repository}.git` };
  manifest.files = definition.id === "core" ? ["src", "dist/server", "LICENSE", "THIRD_PARTY_NOTICES.md"] : ["src", "LICENSE", "THIRD_PARTY_NOTICES.md", ...(definition.id === "sdk-ui" ? ["tailwind-theme.cjs"] : []), ...(definition.id === "docs-ui" ? ["README.md"] : [])];
  const peers = { ...(manifest.peerDependencies ?? {}) };
  if (definition.id === "docs-ui") {
    delete peers["niho-ui"];
    peers["@niho/docs-core"] = version;
    peers["niho-docs-sdk-ui"] = version;
    const exports = { ...(manifest.exports ?? {}) };
    delete exports["./testing/*"];
    manifest.exports = { ...exports, "./sdk-dialog-host": "./src/sdk-dialog-host.tsx" };
    manifest.sideEffects = ["./src/styles/*.css"];
  }
  if (definition.id === "sdk-ui") manifest.sideEffects = ["./src/styles/*.css"];
  manifest.peerDependencies = Object.fromEntries(Object.entries(peers).sort(([left], [right]) => left.localeCompare(right, "en")));
  return manifest;
}

function rewriteDocsUi(bytes, file) {
  if (file === "README.md") return Buffer.from(bytes.toString("utf8").replace(/\bniho-ui\b/gu, "niho-docs-sdk-ui"));
  if (!/\.[cm]?[jt]sx?$/u.test(file)) return bytes;
  return Buffer.from(bytes.toString("utf8").replace(/(["'])niho-ui(?=\/|["'])/gu, "$1niho-docs-sdk-ui"));
}

function dependencyRoot(specifier) {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

function resolveRelative(files, fromFile, specifier) {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  if (joined === ".." || joined.startsWith("../") || joined.startsWith("/")) return { escaped: true };
  const withoutJs = joined.replace(/\.(?:m?js)$/u, "");
  const candidates = [joined, `${joined}.ts`, `${joined}.tsx`, `${joined}.js`, `${joined}.mjs`, `${joined}.json`, `${joined}.css`, `${withoutJs}.ts`, `${withoutJs}.tsx`, `${withoutJs}.js`, `${joined}/index.ts`, `${joined}/index.tsx`, `${joined}/index.js`];
  return { file: candidates.find((candidate) => files.has(candidate)) };
}

export function auditPackageClosure(files, manifest) {
  const names = new Set(files.keys());
  const allowedDependencies = new Set(Object.keys(manifest.peerDependencies ?? {}));
  for (const [file, bytes] of files) {
    if (FORBIDDEN_PATH.test(file)) fail(`公開禁止pathが選択されました: ${file}`);
    if (/\.(?:pem|key|p12|pfx)$/iu.test(file) || /(?:^|\/)(?:id_rsa|google-services\.json|service-account[^/]*\.json)$/iu.test(file) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(bytes.toString("utf8"))) fail(`credentialを含む可能性があるfileは禁止です: ${file}`);
    if (file.endsWith(".css")) {
      const text = bytes.toString("utf8");
      const references = [
        ...[...text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gu)].map((match) => match[1]),
        ...[...text.matchAll(/@import\s+["']([^"']+)["']/gu)].map((match) => match[1]),
      ];
      for (const reference of references) {
        if (/^(?:data:|https?:|#)/u.test(reference)) continue;
        const clean = reference.split(/[?#]/u, 1)[0];
        const resolved = resolveRelative(names, file, clean);
        if (resolved.escaped) fail(`package外へ出るCSS参照は禁止です: ${file} -> ${reference}`);
        if (!resolved.file) fail(`CSS dependency closureに欠落があります: ${file} -> ${reference}`);
      }
    }
    if (!/\.[cm]?[jt]sx?$/u.test(file)) continue;
    const text = bytes.toString("utf8");
    const specifiers = new Set(ts.preProcessFile(text, true, true).importedFiles.map(({ fileName }) => fileName));
    for (const match of text.matchAll(/(?:import\s*\(|require\s*\(|new\s+URL\s*\()\s*["']([^"']+)["']/gu)) specifiers.add(match[1]);
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) {
        const resolved = resolveRelative(names, file, specifier);
        if (resolved.escaped) fail(`package外へ出るimportは禁止です: ${file} -> ${specifier}`);
        if (!resolved.file) fail(`dependency closureに欠落があります: ${file} -> ${specifier}`);
        continue;
      }
      const dependency = dependencyRoot(specifier);
      if (FORBIDDEN_DEPENDENCIES.some((name) => dependency === name || dependency.startsWith(`${name}/`))) fail(`公開SDK禁止dependencyです: ${file} -> ${specifier}`);
      if (!allowedDependencies.has(dependency)) fail(`peer dependencyに無いimportです: ${file} -> ${specifier}`);
    }
  }
  return true;
}

function writeStage(root, files) {
  for (const [relative, bytes] of files) {
    safeRelative(relative, "stage file");
    const target = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: "wx", mode: 0o644 });
  }
}

function collectFiles(root, prefix = "") {
  const result = new Map();
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) fail(`stage symlinkは禁止です: ${relative}`);
    if (entry.isDirectory()) for (const [name, bytes] of collectFiles(full, relative)) result.set(name, bytes);
    else if (entry.isFile()) result.set(relative, readFileSync(full));
    else fail(`stage特殊fileは禁止です: ${relative}`);
  }
  return result;
}

function compilerDetails(toolingRoot) {
  const compiler = path.join(toolingRoot, "apps/docs/node_modules/typescript/bin/tsc");
  if (!existsSync(compiler)) fail("apps/docs/node_modules の TypeScript compilerがありません");
  let output;
  try {
    output = execFileSync(process.execPath, [compiler, "--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    fail("TypeScript compiler versionを取得できません");
  }
  const match = /^Version (\S+)$/u.exec(output);
  if (!match || match[1] !== ts.version) fail("TypeScript compilerとparserのversionが一致しません");
  return { compiler, version: match[1] };
}

function buildTooling(repoRoot, toolingRoot, commit, toolingWorktree) {
  if (!toolingWorktree) {
    const executingRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    for (const name of ["pack-release-set.mjs", "release-set-lib.mjs", "verify-release-set.mjs"]) {
      const relative = `scripts/sdk/${name}`;
      const actual = readFileSync(path.join(executingRoot, relative));
      if (sha256(actual) !== sha256(gitBytes(repoRoot, commit, relative))) {
        fail(`実行中のSDK toolingが選択sourceと一致しません: ${relative}`);
      }
    }
  }
  const records = new Map();
  for (const relative of ["apps/docs/package.json", "apps/docs/package-lock.json"]) {
    const selected = gitBytes(repoRoot, commit, relative);
    let actual;
    try { actual = readFileSync(path.join(toolingRoot, relative)); } catch { fail(`build tooling fileがありません: ${relative}`); }
    if (!toolingWorktree && sha256(actual) !== sha256(selected)) fail(`build toolingが選択sourceと一致しません: ${relative}`);
    records.set(relative, sha256(actual));
  }
  const compiler = compilerDetails(toolingRoot);
  return {
    typescriptVersion: compiler.version,
    packageJsonSha256: records.get("apps/docs/package.json"),
    packageLockSha256: records.get("apps/docs/package-lock.json"),
  };
}

function compileCore(toolingRoot, stage) {
  const configPath = path.join(stage, "tsconfig.sdk.json");
  writeFileSync(configPath, `${JSON.stringify({
    compilerOptions: {
      target: "ES2022", lib: ["ES2022"], types: [], module: "NodeNext", moduleResolution: "NodeNext",
      strict: true, noUncheckedIndexedAccess: true, noImplicitOverride: true, verbatimModuleSyntax: true,
      isolatedModules: true, skipLibCheck: true, noEmit: false, declaration: true, rootDir: "./src", outDir: "./dist/server",
    },
    include: ["src/**/*.ts"],
  }, null, 2)}\n`);
  const { compiler } = compilerDetails(toolingRoot);
  try {
    execFileSync(process.execPath, [compiler, "-p", configPath], { cwd: stage, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    const detail = [error?.stdout, error?.stderr].filter(Boolean).map((value) => value.toString("utf8").trim()).filter(Boolean).join("\n");
    fail(`docs-core server compileに失敗しました${detail ? `\n${detail}` : ""}`);
  } finally {
    rmSync(configPath, { force: true });
  }
}

function writeOctal(header, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length > length - 1) fail("tar数値がfieldに収まりません");
  header.write(text, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function tarPathParts(value) {
  if (Buffer.byteLength(value) <= 100) return { name: value, prefix: "" };
  for (let index = value.lastIndexOf("/"); index > 0; index = value.lastIndexOf("/", index - 1)) {
    const prefix = value.slice(0, index);
    const name = value.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  fail(`tar pathが長すぎます: ${value}`);
}

/** deterministic tar.gz。testはunsafe entryのverifier確認にも利用する。 */
export function createTarGzip(entries) {
  const chunks = [];
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const fullName = entry.name.startsWith("package/") ? entry.name : `package/${entry.name}`;
    const { name, prefix } = tarPathParts(fullName);
    const bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes ?? "");
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    writeOctal(header, 100, 8, entry.mode ?? 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, bytes.length);
    writeOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    if (prefix) header.write(prefix, 345, 155, "utf8");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    const checksumText = checksum.toString(8).padStart(6, "0");
    header.write(checksumText, 148, 6, "ascii");
    header[154] = 0;
    header[155] = 32;
    chunks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

function ownershipRecords(repoRoot, commit) {
  const records = OWNED_SOURCE_PATHS.map((ownedPath) => {
    const entries = treeEntries(repoRoot, commit, ownedPath, { missing: true });
    const material = entries.map(({ file }) => `${file}\0${sha256(gitBytes(repoRoot, commit, file))}\n`).join("");
    return { path: ownedPath, files: entries.length, sha256: sha256(Buffer.from(material)) };
  });
  const digest = sha256(Buffer.from(records.map(({ path: ownedPath, files, sha256: itemSha }) => `${ownedPath}\0${files}\0${itemSha}\n`).join("")));
  return { algorithm: "sha256-git-file-set-v1", digest, paths: records };
}

function stagePackage({ repoRoot, toolingRoot, commit, definition, version, repository, license, notice, temporaryRoot }) {
  const prefix = `${definition.sourceRoot}/`;
  const sourceEntries = treeEntries(repoRoot, commit, definition.sourceRoot);
  const files = new Map();
  for (const entry of sourceEntries) {
    const relative = entry.file.slice(prefix.length);
    if (!selected(relative, definition)) continue;
    if (FORBIDDEN_PATH.test(relative)) fail(`公開禁止sourceが選択されました: ${entry.file}`);
    const original = gitBytes(repoRoot, commit, entry.file);
    files.set(relative, definition.id === "docs-ui" ? rewriteDocsUi(original, relative) : original);
  }
  const originalManifest = readJson(files.get("package.json") ?? Buffer.alloc(0), `${definition.id} package.json`);
  const manifest = packageManifest(definition, originalManifest, version, repository);
  const peerNames = Object.keys(manifest.peerDependencies ?? {}).sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(peerNames) !== JSON.stringify(EXPECTED_PEERS[definition.id])) fail(`${definition.id} peer dependency allowlistが不正です`);
  files.set("package.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  files.set("LICENSE", license);
  files.set("THIRD_PARTY_NOTICES.md", notice);
  if (definition.id === "docs-ui") files.set("src/sdk-dialog-host.tsx", Buffer.from('export { AppDialogHost as DocsSdkDialogHost } from "niho-docs-sdk-ui/components/app-dialog-host";\n'));
  auditPackageClosure(files, manifest);

  const stage = path.join(temporaryRoot, definition.id);
  mkdirSync(stage);
  writeStage(stage, files);
  if (definition.id === "core") compileCore(toolingRoot, stage);
  const finalFiles = collectFiles(stage);
  const tarball = createTarGzip([...finalFiles].map(([name, bytes]) => ({ name, bytes })));
  validatePackageTarball(tarball, definition.name, version);
  return tarball;
}

function artifactName(definition, version) {
  return `${definition.name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`;
}

export function packReleaseSet({ repoRoot, toolingRoot = repoRoot, sourceSha, outputDirectory, toolingWorktree = false } = {}) {
  if (!path.isAbsolute(repoRoot ?? "") || !path.isAbsolute(outputDirectory ?? "")) fail("repoRoot/outputDirectoryは絶対pathが必要です");
  const { commit, tree } = resolveSource(repoRoot, sourceSha);
  let configBytes;
  let notice;
  if (toolingWorktree) {
    configBytes = readFileSync(path.join(repoRoot, "sdk/release-set.json"));
    notice = readFileSync(path.join(repoRoot, NOTICE_PATH));
  } else {
    configBytes = gitBytes(repoRoot, commit, "sdk/release-set.json");
    notice = gitBytes(repoRoot, commit, NOTICE_PATH);
  }
  const config = validateConfig(readJson(configBytes, "sdk/release-set.json"));
  const tooling = buildTooling(repoRoot, toolingRoot, commit, toolingWorktree);
  const license = gitBytes(repoRoot, commit, "LICENSE");
  if (existsSync(outputDirectory)) fail("output directoryは未作成である必要があります");
  const parent = path.dirname(outputDirectory);
  if (!existsSync(parent) || !lstatSync(parent).isDirectory()) fail("outputの親directoryがありません");
  mkdirSync(outputDirectory, { mode: 0o755 });
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "niho-docs-sdk-pack-"));
  try {
    const packageRecords = [];
    for (const definition of config.packages) {
      const tarball = stagePackage({ repoRoot, toolingRoot, commit, definition, version: config.version, repository: config.repository, license, notice, temporaryRoot });
      const file = artifactName(definition, config.version);
      writeFileSync(path.join(outputDirectory, file), tarball, { flag: "wx", mode: 0o644 });
      packageRecords.push({ id: definition.id, name: definition.name, file, size: tarball.length, sha256: sha256(tarball), integrity: sri(tarball) });
    }
    const ownership = ownershipRecords(repoRoot, commit);
    if (!toolingWorktree && ownership.paths.some(({ files }) => files === 0)) fail("release source ownership pathがcommitにありません");
    const manifest = {
      schemaVersion: 1,
      repository: config.repository,
      version: config.version,
      source: { commit, tree, configOrigin: toolingWorktree ? "worktree-preview" : "git" },
      buildTooling: tooling,
      packages: packageRecords,
      sourceOwnership: ownership,
      uiSingleton: { package: "niho-docs-sdk-ui", hostExport: "niho-docs-ui/sdk-dialog-host" },
    };
    const manifestFile = `niho-docs-sdk-${config.version}-${commit}.json`;
    writeFileSync(path.join(outputDirectory, manifestFile), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    return { manifest, manifestFile };
  } catch (error) {
    rmSync(outputDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
