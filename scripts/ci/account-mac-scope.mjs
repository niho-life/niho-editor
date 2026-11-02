import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_PATHS = new Set([
  ".github/workflows/account-mac-ci.yml",
  "scripts/ci/account-mac-scope.mjs",
  "scripts/ci/account-mac-scope.test.mjs",
]);

function git(cwd, args) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function successfulStdout(cwd, args) {
  const result = git(cwd, args);
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed`);
  }
  return result.stdout.trim();
}

function requireCommit(cwd, sha) {
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("commit SHA is missing or malformed");
  }
  const result = git(cwd, ["cat-file", "-e", `${sha}^{commit}`]);
  if (result.status !== 0) {
    throw new Error("commit is unavailable");
  }
}

function requireHead(cwd, expectedSha) {
  const head = successfulStdout(cwd, ["rev-parse", "HEAD"]);
  if (head !== expectedSha) {
    throw new Error("HEAD does not match GITHUB_SHA");
  }
}

function requireAncestor(cwd, base, head) {
  const result = git(cwd, ["merge-base", "--is-ancestor", base, head]);
  if (result.status !== 0) {
    throw new Error("comparison base is not an ancestor");
  }
}

function changedPaths(cwd, base, head) {
  requireCommit(cwd, base);
  requireCommit(cwd, head);
  const result = git(cwd, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    base,
    head,
    "--",
  ]);
  if (result.status !== 0) {
    throw new Error("git diff failed");
  }
  const paths = result.stdout.split("\0").filter(Boolean);
  if (paths.length === 0) {
    throw new Error("comparison is empty");
  }
  return paths;
}

function isReadme(path) {
  return /(^|\/)readme(?:\.(?:md|txt|rst|adoc))?$/i.test(path);
}

function isAncestorNativeOverride(path) {
  if (path === ".cargo" || path.startsWith(".cargo/")) return true;
  if (path === "packages/.cargo" || path.startsWith("packages/.cargo/")) return true;

  const rootParts = path.split("/");
  const isRootFile = rootParts.length === 1;
  const isPackagesFile = rootParts.length === 2 && rootParts[0] === "packages";
  if (!isRootFile && !isPackagesFile) return false;

  const name = rootParts.at(-1);
  if (isReadme(path)) return false;
  if (name === "Cargo.toml" || name === "Cargo.lock") return true;
  if (name.startsWith("rust-toolchain")) return true;

  // A previously unseen file at either Cargo ancestor can change native builds.
  return true;
}

export function pathRequiresAccountMac(rawPath) {
  const path = rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (SELF_PATHS.has(path)) return true;

  const accountRoot = "packages/desktop-account/";
  if (path === "packages/desktop-account") return true;
  if (path.startsWith(accountRoot)) {
    const relative = path.slice(accountRoot.length);
    if (isReadme(relative)) return false;
    if (relative === "ts" || relative.startsWith("ts/")) return false;
    return true;
  }

  return isAncestorNativeOverride(path);
}

export function classifyChangedPaths(paths) {
  return paths.some(pathRequiresAccountMac);
}

function comparisonForPullRequest({ cwd, event, githubSha, githubRef }) {
  const number = event.pull_request?.number ?? event.number;
  const headSha = event.pull_request?.head?.sha;
  if (!number || githubRef !== `refs/pull/${number}/merge`) {
    throw new Error("pull request merge ref is invalid");
  }

  requireCommit(cwd, githubSha);
  requireHead(cwd, githubSha);
  const parents = successfulStdout(cwd, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    githubSha,
  ]).split(/\s+/);
  if (parents.length !== 3 || parents[0] !== githubSha) {
    throw new Error("pull request checkout is not a two-parent merge commit");
  }
  if (parents[2] !== headSha) {
    throw new Error("pull request merge second parent does not match head SHA");
  }
  return { base: parents[1], head: githubSha };
}

function comparisonForPush({ cwd, event, githubSha }) {
  const { before, after, forced } = event;
  if (forced !== false) {
    throw new Error("forced or unspecified push cannot be scoped safely");
  }
  if (after !== githubSha) {
    throw new Error("push after SHA does not match GITHUB_SHA");
  }
  requireCommit(cwd, before);
  requireCommit(cwd, after);
  requireHead(cwd, githubSha);
  requireAncestor(cwd, before, after);
  return { base: before, head: after };
}

function comparisonForMergeGroup({ cwd, event, githubSha }) {
  const base = event.merge_group?.base_sha;
  const head = event.merge_group?.head_sha;
  if (head !== githubSha) {
    throw new Error("merge group head SHA does not match GITHUB_SHA");
  }
  requireCommit(cwd, base);
  requireCommit(cwd, head);
  requireHead(cwd, githubSha);
  requireAncestor(cwd, base, head);
  return { base, head };
}

export function evaluateAccountMacScope({
  cwd = process.cwd(),
  eventName,
  event,
  githubSha,
  githubRef = "",
}) {
  try {
    if (eventName === "workflow_dispatch") {
      return { runMac: true, reason: "workflow_dispatch always runs", paths: [] };
    }

    let comparison;
    if (eventName === "pull_request") {
      comparison = comparisonForPullRequest({ cwd, event, githubSha, githubRef });
    } else if (eventName === "push") {
      comparison = comparisonForPush({ cwd, event, githubSha });
    } else if (eventName === "merge_group") {
      comparison = comparisonForMergeGroup({ cwd, event, githubSha });
    } else {
      throw new Error("unknown event");
    }

    const paths = changedPaths(cwd, comparison.base, comparison.head);
    const runMac = classifyChangedPaths(paths);
    return {
      runMac,
      reason: runMac ? "native scope changed" : "only non-native scope changed",
      paths,
    };
  } catch (error) {
    return {
      runMac: true,
      reason: `safe fallback: ${error instanceof Error ? error.message : "unknown error"}`,
      paths: [],
    };
  }
}

function main() {
  let result;
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    result = evaluateAccountMacScope({
      cwd: process.cwd(),
      eventName: process.env.GITHUB_EVENT_NAME,
      event,
      githubSha: process.env.GITHUB_SHA,
      githubRef: process.env.GITHUB_REF,
    });
  } catch (error) {
    result = {
      runMac: true,
      reason: `safe fallback: ${error instanceof Error ? error.message : "unknown error"}`,
      paths: [],
    };
  }

  appendFileSync(process.env.GITHUB_OUTPUT, `run_mac=${result.runMac}\n`);
  console.log(`Account Mac scope: run_mac=${result.runMac}; ${result.reason}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
