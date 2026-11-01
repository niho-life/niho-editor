import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";

import {
  PACKAGE_DEFINITIONS,
  TOOLING_PATHS,
  PhotoCloudReleaseError,
  createTarGzip,
  gzipStored,
  packReleaseSet,
  recordDigest,
  sha256,
  sri,
} from "./release-lib.mjs";
import {
  PhotoCloudVerificationError,
  readTarEntries,
  verifyReleaseSet,
  verifyReproducedReleaseSet,
} from "./verify-release-set.mjs";
import { smokeConsumer } from "./smoke-consumer.mjs";

const realRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function git(root, args) {
  return execFileSync("git", ["-C", root, "-c", "user.name=Photo SDK Test", "-c", "user.email=photo-sdk@example.invalid", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function put(root, relative, value) {
  const target = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value);
}

function copy(root, relative) {
  const source = path.join(realRoot, ...relative.split("/"));
  const target = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

function workflowJob(workflow, name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `${name} jobがありません`);
  const bodyStart = start + marker.length;
  const nextJob = workflow.slice(bodyStart).search(/\n  [a-z0-9_-]+:\n/u);
  return workflow.slice(start, nextJob === -1 ? undefined : bodyStart + nextJob);
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "niho-photo-cloud-sdk-fixture-"));
  git(root, ["init", "--initial-branch=main"]);
  for (const relative of TOOLING_PATHS) copy(root, relative);
  for (const definition of PACKAGE_DEFINITIONS) {
    for (const relative of definition.include) {
      if (relative === "src/**") copy(root, `${definition.sourceRoot}/src`);
      else copy(root, `${definition.sourceRoot}/${relative}`);
    }
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture"]);
  return { root, sha: git(root, ["rev-parse", "HEAD"]) };
}

function pack(data, name, toolingWorktree = false) {
  const output = path.join(path.dirname(data.root), `${path.basename(data.root)}-${name}`);
  const result = packReleaseSet({ repoRoot: data.root, toolingRoot: realRoot, sourceSha: data.sha, outputDirectory: output, toolingWorktree });
  return { output, ...result, manifestPath: path.join(output, result.manifestFile) };
}

function updatePackage(packResult, id, bytes, entryRecords) {
  const manifest = JSON.parse(readFileSync(packResult.manifestPath, "utf8"));
  const item = manifest.packages.find((record) => record.id === id);
  writeFileSync(path.join(packResult.output, item.file), bytes);
  item.size = bytes.length;
  item.sha256 = sha256(bytes);
  item.integrity = sri(bytes);
  if (entryRecords) {
    item.entries.files = entryRecords;
    item.entries.digest = recordDigest(entryRecords);
  }
  writeFileSync(packResult.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function tarWithType(bytes, type) {
  const archive = gunzipSync(bytes);
  archive[156] = type.charCodeAt(0);
  archive.fill(32, 148, 156);
  let checksum = 0;
  for (let index = 0; index < 512; index += 1) checksum += archive[index];
  archive.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  archive[154] = 0;
  archive[155] = 32;
  return gzipSync(archive, { level: 9, mtime: 0 });
}

test("gzip bytesはOS・zlibに依存せず既知CRCとblock境界を維持する", () => {
  assert.equal(gzipStored(Buffer.from("123456789")).toString("hex"), "1f8b08000000000000ff010900f6ff3132333435363738392639f4cb09000000");
  for (const length of [0, 1, 65535, 65536, 131070, 131071]) {
    const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 31) % 256));
    const packed = gzipStored(bytes);
    assert.deepEqual(gunzipSync(packed), bytes);
    assert.deepEqual(packed.subarray(0, 10), Buffer.from([31, 139, 8, 0, 0, 0, 0, 0, 0, 255]));
    if (length > 65535) {
      assert.equal(packed[10], 0);
      assert.equal(packed[10 + 5 + 65535] & 6, 0);
    }
  }
});

test("Git objectだけから2 packageを再現し、source/entry/upstream pinを検証する", (t) => {
  const data = fixture();
  const one = pack(data, "one");
  const two = pack(data, "two");
  t.after(() => { rmSync(data.root, { recursive: true, force: true }); rmSync(one.output, { recursive: true, force: true }); rmSync(two.output, { recursive: true, force: true }); });
  const verified = verifyReproducedReleaseSet(one.manifestPath, two.manifestPath, { expectedSource: data.sha, expectedVersion: "0.1.2", sourceRepositoryRoot: data.root });
  assert.equal(verified.releaseReady, true);
  assert.equal(verified.upstreamSdk.version, "0.1.7");
  assert.equal(verified.upstreamSdk.baselineSha256, "35f1f68ad0b57cdc7e40f98f9a6958387743d5c3403071531e5620a48112f78d");
  assert.equal(verified.packages.length, 2);
  const cloud = verified.packages.find(({ id }) => id === "cloud-library");
  const cloudEntries = readTarEntries(readFileSync(path.join(one.output, cloud.file)));
  const cloudManifest = JSON.parse(cloudEntries.get("package.json"));
  assert.deepEqual(cloudManifest.peerDependencies, {
    "@niho/photo-library-contract": "0.1.2",
    "niho-photo-contract": "0.1.7",
    "niho-photo-editing": "0.1.7",
  });
  assert.equal([...cloudEntries].some(([name]) => /(?:test|fixture|tsconfig|package-lock)/u.test(name)), false);
  const contract = verified.packages.find(({ id }) => id === "library-contract");
  const contractEntries = readTarEntries(readFileSync(path.join(one.output, contract.file)));
  assert.deepEqual(JSON.parse(contractEntries.get("package.json")).exports, { ".": "./src/v1.ts", "./sdk-baseline": "./sdk-baseline.json" });
  assert.equal(contractEntries.has("fixtures/v1.ts"), false);
  assert.deepEqual(smokeConsumer(one.manifestPath, { repoRoot: realRoot }).packages, ["@niho/photo-cloud-library", "@niho/photo-library-contract"]);
});

test("dirty worktreeを無視し、tooling previewはrelease verifierが拒否する", (t) => {
  const data = fixture();
  put(data.root, "packages/photo-cloud-library/src/index.ts", "export const dirty = true;\n");
  const preview = pack(data, "preview", true);
  t.after(() => { rmSync(data.root, { recursive: true, force: true }); rmSync(preview.output, { recursive: true, force: true }); });
  assert.equal(preview.manifest.releaseReady, false);
  assert.throws(() => verifyReleaseSet(preview.manifestPath), (error) => error instanceof PhotoCloudVerificationError && /preview/u.test(error.message));
  assert.equal(verifyReleaseSet(preview.manifestPath, { allowPreview: true }).releaseReady, false);
  const cloud = preview.manifest.packages.find(({ id }) => id === "cloud-library");
  const entries = readTarEntries(readFileSync(path.join(preview.output, cloud.file)));
  assert.doesNotMatch(entries.get("src/index.ts").toString("utf8"), /dirty/u);
});

test("選択commitと実行script/config/lockが不一致ならrelease packを拒否する", (t) => {
  const data = fixture();
  t.after(() => rmSync(data.root, { recursive: true, force: true }));
  put(data.root, "scripts/photo-cloud-sdk/release-lib.mjs", "export const replaced = true;\n");
  git(data.root, ["add", "scripts/photo-cloud-sdk/release-lib.mjs"]);
  git(data.root, ["commit", "-m", "replace tooling"]);
  data.sha = git(data.root, ["rev-parse", "HEAD"]);
  assert.throws(() => pack(data, "tooling-mismatch"), (error) => error instanceof PhotoCloudReleaseError && /実行tooling/u.test(error.message));
});

test("release workflowのreproduce/publishはtrusted main verifierを維持して選択sourceのGit objectを検証する", () => {
  const workflow = readFileSync(path.join(realRoot, ".github/workflows/photo-cloud-sdk-release.yml"), "utf8");
  const reproduce = workflowJob(workflow, "reproduce");
  const publish = workflowJob(workflow, "publish");
  const trustedFullCheckout = /- uses: actions\/checkout@[a-f0-9]{40}\n        with:\n          ref: \$\{\{ github\.sha \}\}\n          fetch-depth: 0\n          persist-credentials: false/u;

  for (const [name, job] of [["reproduce", reproduce], ["publish", publish]]) {
    assert.equal(job.match(/actions\/checkout@/gu)?.length, 1, `${name} checkoutはtrusted workflow SHAの1回だけにする`);
    assert.match(job, trustedFullCheckout, `${name} はgithub.shaをfull fetchする`);
    assert.doesNotMatch(job, /(?:^|\n)\s*git (?:checkout|switch|reset)\b/u, `${name} verifierを選択sourceへ切り替えない`);
  }

  assert.match(reproduce, /SOURCE_SHA: \$\{\{ needs\.build\.outputs\.source-sha \}\}/u);
  assert.match(reproduce, /git merge-base --is-ancestor "\$SOURCE_SHA" "\$GITHUB_SHA"/u);
  assert.match(reproduce, /node scripts\/photo-cloud-sdk\/pack-release-set\.mjs --source-sha "\$SOURCE_SHA"/u);
  assert.match(reproduce, /node scripts\/photo-cloud-sdk\/verify-release-set\.mjs[\s\S]*--source-repository "\$GITHUB_WORKSPACE"/u);
  assert.match(publish, /node scripts\/photo-cloud-sdk\/verify-release-set\.mjs[\s\S]*--source-repository "\$GITHUB_WORKSPACE"/u);
});

test("閉じていない相対importと禁止dependencyをpack時に拒否する", (t) => {
  const missing = fixture();
  const forbidden = fixture();
  t.after(() => { rmSync(missing.root, { recursive: true, force: true }); rmSync(forbidden.root, { recursive: true, force: true }); });
  put(missing.root, "packages/photo-cloud-library/src/index.ts", 'export * from "./missing.ts";\n');
  git(missing.root, ["add", "."]); git(missing.root, ["commit", "-m", "missing import"]); missing.sha = git(missing.root, ["rev-parse", "HEAD"]);
  put(forbidden.root, "packages/photo-cloud-library/src/index.ts", 'export { redirect } from "next/navigation";\n');
  git(forbidden.root, ["add", "."]); git(forbidden.root, ["commit", "-m", "forbidden import"]); forbidden.sha = git(forbidden.root, ["rev-parse", "HEAD"]);
  assert.throws(() => pack(missing, "missing"), (error) => error instanceof PhotoCloudReleaseError && /closure/u.test(error.message));
  assert.throws(() => pack(forbidden, "forbidden"), (error) => error instanceof PhotoCloudReleaseError && /禁止dependency/u.test(error.message));
});

test("verifierはextra entryの自己申告、symlink、tamper、未検証fileを拒否する", (t) => {
  const data = fixture();
  const original = pack(data, "verify");
  t.after(() => { rmSync(data.root, { recursive: true, force: true }); rmSync(original.output, { recursive: true, force: true }); });
  const cloud = original.manifest.packages.find(({ id }) => id === "cloud-library");
  const file = path.join(original.output, cloud.file);
  const originalBytes = readFileSync(file);
  const originalRecords = cloud.entries.files;
  const entries = readTarEntries(originalBytes);
  entries.set("extra.ts", Buffer.from("export const extra = true;\n"));
  const extraBytes = createTarGzip(entries);
  const extraRecords = [...entries].sort(([left], [right]) => left.localeCompare(right, "en")).map(([entryPath, bytes]) => ({ path: entryPath, size: bytes.length, sha256: sha256(bytes) }));
  updatePackage(original, "cloud-library", extraBytes, extraRecords);
  assert.throws(() => verifyReleaseSet(original.manifestPath), PhotoCloudVerificationError);

  updatePackage(original, "cloud-library", tarWithType(originalBytes, "2"), originalRecords);
  assert.throws(() => verifyReleaseSet(original.manifestPath), (error) => error instanceof PhotoCloudVerificationError && /symlink|特殊/u.test(error.message));

  const tampered = Buffer.from(readFileSync(file));
  tampered[tampered.length - 1] ^= 1;
  writeFileSync(file, tampered);
  assert.throws(() => verifyReleaseSet(original.manifestPath), PhotoCloudVerificationError);

  writeFileSync(path.join(original.output, "unverified.txt"), "x\n");
  assert.throws(() => verifyReleaseSet(original.manifestPath), (error) => error instanceof PhotoCloudVerificationError && /未検証/u.test(error.message));
  assert.throws(() => createTarGzip(new Map([["../escape", Buffer.from("x")]])), PhotoCloudReleaseError);
});
