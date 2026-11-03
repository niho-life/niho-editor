import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import { createTarGzip, packReleaseSet, SdkReleaseError } from "./release-set-lib.mjs";
import { readTarEntries, sha256, sri, verifyReleaseSet, verifyReproducedReleaseSet, ReleaseVerificationError } from "./verify-release-set.mjs";

const realRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const releaseConfig = JSON.parse(readFileSync(path.join(realRoot, "sdk/release-set.json"), "utf8"));

function put(root, relative, value) {
  const target = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value);
}

function git(root, args) {
  return execFileSync("git", ["-C", root, "-c", "user.name=SDK Test", "-c", "user.email=sdk@example.invalid", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture({ docsSource = 'export const DocsApp = () => null;\nexport type DocsHost = { kind: "native" };\nexport type DocsWorkspaceHost = { kind: "vault-workspace" };\n', version = releaseConfig.version, repository = releaseConfig.repository, toolingMismatch = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "niho-docs-sdk-fixture-"));
  git(root, ["init", "--initial-branch=main"]);
  put(root, "LICENSE", "Fixture license\n");
  put(root, "sdk/release-set.json", `${JSON.stringify({ ...releaseConfig, version, repository }, null, 2)}\n`);
  put(root, "sdk/THIRD_PARTY_NOTICES.md", "Fixture notices\n");
  mkdirSync(path.join(root, "apps/docs"), { recursive: true });
  cpSync(path.join(realRoot, "apps/docs/package.json"), path.join(root, "apps/docs/package.json"));
  cpSync(path.join(realRoot, "apps/docs/package-lock.json"), path.join(root, "apps/docs/package-lock.json"));
  if (toolingMismatch) writeFileSync(path.join(root, "apps/docs/package.json"), "{}\n");
  put(root, "scripts/sdk/fixture.txt", "tooling ownership\n");
  for (const name of ["pack-release-set.mjs", "release-set-lib.mjs", "verify-release-set.mjs"]) {
    cpSync(path.join(realRoot, "scripts/sdk", name), path.join(root, "scripts/sdk", name));
  }
  put(root, ".github/workflows/docs-sdk-ci.yml", "name: fixture ci\n");
  put(root, ".github/workflows/docs-sdk-release.yml", "name: fixture release\n");
  put(root, "docs/architecture/docs-sdk.md", "# Fixture\n");
  put(root, "packages/docs-core/package.json", `${JSON.stringify({
    name: "@niho/docs-core", version: "0.1.0", private: true, type: "module",
    exports: { "./package.json": "./package.json", ".": { types: "./src/index.ts", default: "./src/index.ts" }, "./server": { types: "./dist/server/index.d.ts", default: "./dist/server/index.js" } },
    scripts: { test: "do-not-publish" }, devDependencies: { typescript: "*" }, engines: { node: "24.x" },
  }, null, 2)}\n`);
  put(root, "packages/docs-core/src/index.ts", 'export function pageTitle(value: string): string { return `committed:${value}`; }\n');
  put(root, "packages/docs-ui/package.json", `${JSON.stringify({
    name: "niho-docs-ui", version: "0.1.0", private: true,
    exports: { ".": "./src/index.ts", "./package.json": "./package.json", "./styles/*": "./src/styles/*" },
    scripts: { test: "do-not-publish" },
    peerDependencies: {
      "@niho/docs-core": "*", "@tiptap/core": "3.31.3", "@tiptap/extension-bubble-menu": "3.31.3",
      "@tiptap/extension-floating-menu": "3.31.3", "@tiptap/extension-list": "3.31.3", "@tiptap/extension-table": "3.31.3", "@tiptap/pm": "3.31.3",
      "@tiptap/react": "3.31.3", "@tiptap/starter-kit": "3.31.3", "@tiptap/suggestion": "3.31.3",
      "lucide-react": "1.58.0", "markdown-it": "^14.3.2", "niho-ui": "*", "prosemirror-markdown": "^1.13.8",
      "prosemirror-search": "^1.1.1", react: "^18 || ^19", "react-dom": "^18 || ^19",
    },
    devDependencies: { "niho-ui": "file:../ui" },
  }, null, 2)}\n`);
  put(root, "packages/docs-ui/README.md", 'Peer: `niho-ui`.\n```ts\nimport "niho-ui/styles/tokens.css";\n```\n');
  put(root, "packages/docs-ui/src/index.ts", docsSource);
  put(root, "packages/docs-ui/src/styles/app.css", ":root { color: black; }\n");
  put(root, "packages/docs-ui/src/testing/fixture.ts", "export const mustNotShip = true;\n");
  put(root, "packages/ui/package.json", `${JSON.stringify({
    name: "niho-ui", version: "0.1.0", private: true,
    exports: { "./components/*": "./src/components/*.tsx", "./styles/tokens.css": "./src/styles/tokens.css", "./package.json": "./package.json" },
    scripts: { test: "do-not-publish" }, peerDependencies: {
      "@radix-ui/react-dialog": "^1.1.23", "@radix-ui/react-popover": "^1.1.23", clsx: "^2.1.1",
      "lucide-react": "^1.48.0", react: "^18 || ^19", "react-dom": "^18 || ^19", "tailwind-merge": "^3.7.0",
    },
  }, null, 2)}\n`);
  put(root, "packages/ui/tailwind-theme.cjs", "module.exports = {};\n");
  put(root, "packages/ui/src/components/app-dialog-host.tsx", "export function AppDialogHost() { return null; }\n");
  put(root, "packages/ui/src/styles/tokens.css", ":root { --fixture: 1; }\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture"]);
  return { root, sha: git(root, ["rev-parse", "HEAD"]) };
}

function packFixture(data, suffix) {
  const output = path.join(data.root, `../out-${path.basename(data.root)}-${suffix}`);
  const result = packReleaseSet({ repoRoot: data.root, toolingRoot: realRoot, sourceSha: data.sha, outputDirectory: output });
  return { output, ...result, manifestPath: path.join(output, result.manifestFile) };
}

function rewritePackage(pack, id, bytes) {
  const manifest = JSON.parse(readFileSync(pack.manifestPath, "utf8"));
  const record = manifest.packages.find((item) => item.id === id);
  writeFileSync(path.join(pack.output, record.file), bytes);
  record.size = bytes.length;
  record.sha256 = sha256(bytes);
  record.integrity = sri(bytes);
  writeFileSync(pack.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test("移管前のsourceは旧repositoryの成果物として再生成・検証できる", (t) => {
  const data = fixture({ repository: "niho-coliving/niho-docs" });
  const pack = packFixture(data, "legacy");
  t.after(() => { rmSync(data.root, { recursive: true, force: true }); rmSync(pack.output, { recursive: true, force: true }); });
  assert.equal(verifyReleaseSet(pack.manifestPath).repository, "niho-coliving/niho-docs");
  const core = pack.manifest.packages.find(({ id }) => id === "core");
  const entries = readTarEntries(readFileSync(path.join(pack.output, core.file)));
  assert.deepEqual(JSON.parse(entries.get("package.json")).repository, {
    type: "git", url: "https://github.com/niho-coliving/niho-docs.git",
  });
});

test("移管元・移管先以外のrepositoryはSDK生成で拒否する", (t) => {
  const data = fixture({ repository: "unknown/niho-docs" });
  t.after(() => rmSync(data.root, { recursive: true, force: true }));
  assert.throws(() => packFixture(data, "unknown"), SdkReleaseError);
});

test("source選択はdirty worktreeを無視し、digestとtarballは再現可能", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.root, { recursive: true, force: true }));
  put(data.root, "packages/docs-core/src/index.ts", "export const dirty = true;\n");
  const one = packFixture(data, "one");
  const two = packFixture(data, "two");
  t.after(() => { rmSync(one.output, { recursive: true, force: true }); rmSync(two.output, { recursive: true, force: true }); });
  assert.deepEqual(one.manifest.packages, two.manifest.packages);
  assert.equal(one.manifest.sourceOwnership.digest, two.manifest.sourceOwnership.digest);
  const core = one.manifest.packages.find(({ id }) => id === "core");
  const entries = readTarEntries(readFileSync(path.join(one.output, core.file)));
  assert.match(entries.get("src/index.ts").toString("utf8"), /committed:/u);
  assert.doesNotMatch(entries.get("src/index.ts").toString("utf8"), /dirty/u);
  const docsUi = one.manifest.packages.find(({ id }) => id === "docs-ui");
  const docsUiEntries = readTarEntries(readFileSync(path.join(one.output, docsUi.file)));
  assert.equal([...docsUiEntries.keys()].some((file) => file.startsWith("src/testing/")), false);
  assert.match(docsUiEntries.get("README.md").toString("utf8"), /niho-docs-sdk-ui\/styles\/tokens\.css/u);
  assert.doesNotMatch(docsUiEntries.get("README.md").toString("utf8"), /\bniho-ui\b/u);
  assert.match(readFileSync(path.join(data.root, "packages/docs-ui/README.md"), "utf8"), /\bniho-ui\b/u);
  assert.equal(verifyReproducedReleaseSet(one.manifestPath, two.manifestPath, { expectedSource: data.sha, expectedVersion: releaseConfig.version, sourceRepositoryRoot: data.root }).source.commit, data.sha);
});

test("自己申告hashとprovenanceが整っていても、source・変換物・追加fileの差異を再生成照合で拒否", (t) => {
  const data = fixture();
  const expected = packFixture(data, "reproduced");
  const casesRoot = mkdtempSync(path.join(tmpdir(), "niho-docs-sdk-reproduction-"));
  t.after(() => { rmSync(data.root, { recursive: true, force: true }); rmSync(expected.output, { recursive: true, force: true }); rmSync(casesRoot, { recursive: true, force: true }); });
  const options = { expectedSource: data.sha, expectedVersion: releaseConfig.version, sourceRepositoryRoot: data.root };
  for (const [id, file] of [["core", "src/index.ts"], ["core", "dist/server/index.js"], ["core", "dist/server/index.d.ts"], ["docs-ui", "README.md"], ["docs-ui", "package.json"], ["sdk-ui", "src/styles/tokens.css"], ["core", "extra.txt"]]) {
    const output = path.join(casesRoot, `${id}-${file.replaceAll("/", "-")}`);
    cpSync(expected.output, output, { recursive: true });
    const actual = { output, manifestPath: path.join(output, expected.manifestFile) };
    const item = expected.manifest.packages.find((record) => record.id === id);
    const entries = readTarEntries(readFileSync(path.join(output, item.file)));
    const original = entries.get(file) ?? Buffer.alloc(0);
    entries.set(file, file === "package.json"
      ? Buffer.from(JSON.stringify({ ...JSON.parse(original), description: "altered" }))
      : Buffer.concat([original, Buffer.from("\n/* altered */\n")]));
    rewritePackage(actual, id, createTarGzip([...entries].map(([name, bytes]) => ({ name, bytes }))));
    // 構造とGit provenanceだけの検証は通るが、配布内容の照合では通らない。
    assert.doesNotThrow(() => verifyReleaseSet(actual.manifestPath, options));
    assert.throws(() => verifyReproducedReleaseSet(actual.manifestPath, expected.manifestPath, options), (error) => error instanceof ReleaseVerificationError && /再生成/u.test(error.message));
    assert.throws(() => verifyReleaseSet(actual.manifestPath, { ...options, expectedManifestSha256: sha256(readFileSync(expected.manifestPath)) }), ReleaseVerificationError);
  }
});

test("release-set version bumpはartifact名・package・verifierに一貫して反映される", (t) => {
  const data = fixture({ version: "0.2.0-beta.1" });
  const pack = packFixture(data, "version-bump");
  t.after(() => { rmSync(data.root, { recursive: true, force: true }); rmSync(pack.output, { recursive: true, force: true }); });
  assert.equal(pack.manifest.version, "0.2.0-beta.1");
  assert.ok(pack.manifest.packages.every(({ file }) => file.endsWith("-0.2.0-beta.1.tgz")));
  assert.equal(verifyReleaseSet(pack.manifestPath, { expectedSource: data.sha, expectedVersion: "0.2.0-beta.1", sourceRepositoryRoot: data.root }).version, "0.2.0-beta.1");
  assert.throws(() => verifyReleaseSet(pack.manifestPath, { expectedVersion: "0.2.0" }), ReleaseVerificationError);
});

test("release packは選択sourceと異なるbuild toolingを拒否", (t) => {
  const data = fixture({ toolingMismatch: true });
  t.after(() => rmSync(data.root, { recursive: true, force: true }));
  assert.throws(() => packFixture(data, "tooling-mismatch"), (error) => error instanceof SdkReleaseError && /build tooling/u.test(error.message));
});

test("選択commitと異なるSDK生成器をrelease packに使えない", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.root, { recursive: true, force: true }));
  put(data.root, "scripts/sdk/release-set-lib.mjs", "export const otherGenerator = true;\n");
  git(data.root, ["add", "scripts/sdk/release-set-lib.mjs"]);
  git(data.root, ["commit", "-m", "different tooling"]);
  data.sha = git(data.root, ["rev-parse", "HEAD"]);
  assert.throws(() => packFixture(data, "generator-mismatch"), (error) => error instanceof SdkReleaseError && /SDK tooling/u.test(error.message));
});

test("tar終端後のnonzero dataを拒否", () => {
  const valid = createTarGzip([{ name: "file.txt", bytes: "ok\n" }]);
  const archive = gunzipSync(valid);
  const trailing = gzipSync(Buffer.concat([archive, Buffer.from([1])]));
  assert.throws(() => readTarEntries(trailing), (error) => error instanceof ReleaseVerificationError && /終端/u.test(error.message));
});

test("相対import closure欠落と禁止runtime dependencyをpack時に拒否", (t) => {
  const missing = fixture({ docsSource: 'import "./missing";\nexport const DocsApp = () => null;\n' });
  const forbidden = fixture({ docsSource: 'import "next/navigation";\nexport const DocsApp = () => null;\n' });
  t.after(() => { rmSync(missing.root, { recursive: true, force: true }); rmSync(forbidden.root, { recursive: true, force: true }); });
  assert.throws(() => packFixture(missing, "missing"), (error) => error instanceof SdkReleaseError && /closure/u.test(error.message));
  assert.throws(() => packFixture(forbidden, "forbidden"), (error) => error instanceof SdkReleaseError && /禁止dependency/u.test(error.message));
});

test("core ./serverは選択Git sourceから実JSとdeclarationをbuildする", async (t) => {
  const data = fixture();
  const pack = packFixture(data, "server");
  const consumer = mkdtempSync(path.join(tmpdir(), "niho-docs-core-consumer-"));
  t.after(() => { rmSync(data.root, { recursive: true, force: true }); rmSync(pack.output, { recursive: true, force: true }); rmSync(consumer, { recursive: true, force: true }); });
  const core = pack.manifest.packages.find(({ id }) => id === "core");
  const entries = readTarEntries(readFileSync(path.join(pack.output, core.file)));
  assert.ok(entries.has("dist/server/index.js"));
  assert.ok(entries.has("dist/server/index.d.ts"));
  const install = path.join(consumer, "node_modules/@niho/docs-core");
  for (const [relative, bytes] of entries) put(install, relative, bytes);
  const imported = await import(`${pathToFileURL(path.join(install, "dist/server/index.js")).href}?fixture=${Date.now()}`);
  assert.equal(imported.pageTitle("x"), "committed:x");
});

test("verifierはtamper、path traversal、symlink、unexpected file、malformed manifestを拒否", (t) => {
  const data = fixture();
  const original = packFixture(data, "verify");
  const casesRoot = mkdtempSync(path.join(tmpdir(), "niho-docs-sdk-verify-cases-"));
  t.after(() => { rmSync(data.root, { recursive: true, force: true }); rmSync(original.output, { recursive: true, force: true }); rmSync(casesRoot, { recursive: true, force: true }); });
  assert.equal(verifyReleaseSet(original.manifestPath).repository, "niho-life/niho-docs");

  const makeCase = (name) => {
    const output = path.join(casesRoot, name);
    cpSync(original.output, output, { recursive: true });
    return { output, manifestPath: path.join(output, original.manifestFile) };
  };
  const tamper = makeCase("tamper");
  const tamperManifest = JSON.parse(readFileSync(tamper.manifestPath, "utf8"));
  const tamperFile = path.join(tamper.output, tamperManifest.packages[0].file);
  const changed = Buffer.from(readFileSync(tamperFile)); changed[changed.length - 1] ^= 1; writeFileSync(tamperFile, changed);
  assert.throws(() => verifyReleaseSet(tamper.manifestPath), ReleaseVerificationError);

  const traversal = makeCase("traversal");
  rewritePackage(traversal, "core", createTarGzip([{ name: "../escape", bytes: "x" }]));
  assert.throws(() => verifyReleaseSet(traversal.manifestPath), (error) => error instanceof ReleaseVerificationError && /相対path/u.test(error.message));

  const symlink = makeCase("symlink");
  rewritePackage(symlink, "core", createTarGzip([{ name: "link", bytes: "target", type: "2" }]));
  assert.throws(() => verifyReleaseSet(symlink.manifestPath), (error) => error instanceof ReleaseVerificationError && /通常file/u.test(error.message));

  const unexpected = makeCase("unexpected");
  put(unexpected.output, "extra.txt", "no\n");
  assert.throws(() => verifyReleaseSet(unexpected.manifestPath), (error) => error instanceof ReleaseVerificationError && /unexpected/u.test(error.message));

  const malformed = makeCase("malformed");
  const badManifest = JSON.parse(readFileSync(malformed.manifestPath, "utf8"));
  delete badManifest.repository;
  writeFileSync(malformed.manifestPath, `${JSON.stringify(badManifest)}\n`);
  assert.throws(() => verifyReleaseSet(malformed.manifestPath), ReleaseVerificationError);
});
