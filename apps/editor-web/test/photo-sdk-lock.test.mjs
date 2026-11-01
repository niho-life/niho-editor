import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const json = (url) => JSON.parse(readFileSync(url, "utf8"));
const baseline = json(new URL("../../../packages/photo-library-contract/sdk-baseline.json", import.meta.url));
const lock = json(new URL("../package-lock.json", import.meta.url));
const adapter = json(new URL("../../../packages/photo-cloud-library/package.json", import.meta.url));

test("hostの全SDK lock entryを検証済みreleaseへ固定する", () => {
  const packages = new Map(baseline.packages.map((item) => [item.name, item]));
  const version = baseline.releaseTag.slice("photo-sdk-v".length);
  let count = 0;
  for (const [location, entry] of Object.entries(lock.packages)) {
    const artifact = packages.get(location.split("node_modules/").at(-1));
    if (!artifact) continue;
    count += 1;
    assert.equal(entry.version, version, location);
    assert.equal(entry.resolved, `https://github.com/${baseline.repository}/releases/download/${baseline.releaseTag}/${artifact.file}`, location);
    assert.equal(entry.integrity, artifact.integrity, location);
  }
  assert.ok(count >= 5, "hostのruntimeを含むSDK依存が必要");
  assert.deepEqual(lock.packages["node_modules/@niho/photo-cloud-library"].dependencies, adapter.dependencies);
});

test("frozen installでもadapterの実runtimeが同じSDKへ解決する", () => {
  const installed = new URL("../node_modules/@niho/photo-cloud-library/package.json", import.meta.url);
  assert.deepEqual(json(installed).dependencies, adapter.dependencies);
  const resolved = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
    "console.log(JSON.stringify({url:import.meta.resolve('niho-photo-contract'),exports:Object.keys(await import('niho-photo-contract'))}))",
  ], { cwd: fileURLToPath(new URL(".", installed)), encoding: "utf8" }));
  assert.ok(resolved.exports.includes("readDevelopSettings"));
  let directory = path.dirname(fileURLToPath(resolved.url));
  const root = path.parse(directory).root;
  while (directory !== root) {
    try {
      const manifest = json(path.join(directory, "package.json"));
      if (manifest.name === "niho-photo-contract") {
        assert.equal(manifest.version, baseline.releaseTag.slice("photo-sdk-v".length));
        assert.equal(directory, fileURLToPath(new URL("../node_modules/niho-photo-contract", import.meta.url)));
        return;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    directory = path.dirname(directory);
  }
  assert.fail("adapter runtime packageを解決できません");
});
