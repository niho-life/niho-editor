#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FULL_SHA, PhotoCloudReleaseError, packReleaseSet } from "./release-lib.mjs";
import { verifyReleaseSet } from "./verify-release-set.mjs";

function argumentsOf(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--tooling-worktree") {
      if (values[key]) throw new PhotoCloudReleaseError("--tooling-worktreeが重複しています");
      values[key] = true;
      continue;
    }
    if (key !== "--source-sha" && key !== "--output") throw new PhotoCloudReleaseError("使い方: pack-release-set.mjs --source-sha FULLSHA --output DIR [--tooling-worktree]");
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || values[key]) throw new PhotoCloudReleaseError("pack引数が不正です");
    values[key] = value;
    index += 1;
  }
  if (!FULL_SHA.test(values["--source-sha"] ?? "") || !values["--output"]) throw new PhotoCloudReleaseError("pack引数が不足または不正です");
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = argumentsOf(process.argv.slice(2));
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const outputDirectory = path.resolve(values["--output"]);
    const result = packReleaseSet({
      repoRoot,
      toolingRoot: repoRoot,
      sourceSha: values["--source-sha"],
      outputDirectory,
      toolingWorktree: values["--tooling-worktree"] === true,
    });
    verifyReleaseSet(path.join(outputDirectory, result.manifestFile), { allowPreview: values["--tooling-worktree"] === true });
    console.log(`Photo cloud SDKを生成しました: ${result.manifestFile}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Photo cloud SDK生成に失敗しました");
    process.exitCode = 1;
  }
}
