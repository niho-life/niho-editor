import assert from "node:assert/strict";
import { test } from "node:test";
import { executePurge, parsePurgeMode } from "../src/purge-command.ts";

test("private payload cleanup cannot delete pages or objects", async () => {
  let trashCalls = 0;
  const result = await executePurge(parsePurgeMode(["--private-jobs-only"]), {
    trash: async () => { trashCalls++; throw new Error("page deletion forbidden"); },
    privateJobs: async () => ["opaque-object"],
  });
  assert.equal(trashCalls, 0);
  assert.deepEqual(result, { pages: 0, assets: 0, pendingObjects: 1 });
});
test("a misspelled mode is rejected before any purge", () => {
  for (const args of [["--privateJobs-only"], ["--private-jobs-only", "--all"], ["--all"]]) assert.throws(() => parsePurgeMode(args));
});
test("the existing explicit trash command retains its behavior", async () => {
  let calls = 0;
  const result = await executePurge(parsePurgeMode([]), {
    trash: async () => { calls++; return { pages: 2, assetPaths: ["asset"] }; },
    privateJobs: async () => [],
  });
  assert.equal(calls, 1); assert.equal(result.pages, 2);
});
