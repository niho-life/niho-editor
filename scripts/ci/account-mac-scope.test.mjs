import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import {
  classifyChangedPaths,
  evaluateAccountMacScope,
} from "./account-mac-scope.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER_PATH = join(REPO_ROOT, "scripts/ci/account-mac-scope.mjs");
const WORKFLOW_PATH = join(REPO_ROOT, ".github/workflows/account-mac-ci.yml");
const tempRoots = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "account-mac-scope-"));
  tempRoots.push(cwd);
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.name", "Scope Test");
  git(cwd, "config", "user.email", "scope-test@example.invalid");
  write(cwd, "README.md", "synthetic repository\n");
  git(cwd, "add", "--all");
  git(cwd, "commit", "-q", "-m", "initial");
  return cwd;
}

function write(cwd, path, contents) {
  const absolute = join(cwd, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function commit(cwd, path, contents, message = path) {
  if (contents === null) {
    rmSync(join(cwd, path));
  } else {
    write(cwd, path, contents);
  }
  git(cwd, "add", "--all");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function pushResult(cwd, before, after, overrides = {}) {
  return evaluateAccountMacScope({
    cwd,
    eventName: "push",
    event: { before, after, forced: false, ...overrides.event },
    githubSha: overrides.githubSha ?? after,
    githubRef: "refs/heads/main",
  });
}

function makePullRequest(changePath) {
  const cwd = initRepo();
  const payloadBase = git(cwd, "rev-parse", "HEAD");
  git(cwd, "checkout", "-q", "-b", "feature");
  const head = commit(cwd, changePath, "changed\n", "feature");
  git(cwd, "checkout", "-q", "main");
  const actualBase = commit(cwd, "docs/base-progress.md", "base advanced\n", "base advanced");
  git(cwd, "merge", "-q", "--no-ff", "feature", "-m", "synthetic merge");
  const merge = git(cwd, "rev-parse", "HEAD");
  const event = {
    number: 207,
    pull_request: {
      number: 207,
      base: { sha: payloadBase },
      head: { sha: head },
    },
  };
  return { cwd, payloadBase, actualBase, head, merge, event };
}

test("path policy distinguishes TS/docs from native and conservative inputs", () => {
  assert.equal(
    classifyChangedPaths([
      "packages/desktop-account/ts/src/account-state.ts",
      "packages/docs-ui/src/account.tsx",
      "packages/desktop-account/README.md",
      "docs/README.md",
    ]),
    false,
  );

  for (const path of [
    "packages/desktop-account/src/lib.rs",
    "packages/desktop-account/Cargo.lock",
    "packages/desktop-account/permissions/default.toml",
    "packages/desktop-account/new-native-input.xyz",
    "packages/desktop-account/README.rs",
    "Cargo.toml",
    "packages/Cargo.lock",
    ".cargo/config.toml",
    "packages/.cargo/config.toml",
    "rust-toolchain.toml",
    "unknown-root-config",
    ".github/workflows/account-mac-ci.yml",
    "scripts/ci/account-mac-scope.mjs",
    "scripts/ci/account-mac-scope.test.mjs",
  ]) {
    assert.equal(classifyChangedPaths([path]), true, path);
  }
});

test("PR uses the real two-parent merge and its first parent even with stale payload base", () => {
  const fixture = makePullRequest("packages/desktop-account/src/new.rs");
  assert.notEqual(fixture.payloadBase, fixture.actualBase);
  const result = evaluateAccountMacScope({
    cwd: fixture.cwd,
    eventName: "pull_request",
    event: fixture.event,
    githubSha: fixture.merge,
    githubRef: "refs/pull/207/merge",
  });
  assert.equal(result.runMac, true);
  assert.ok(result.paths.includes("packages/desktop-account/src/new.rs"));
  assert.ok(!result.paths.includes("docs/base-progress.md"));
});

test("PR can skip a TS-only merge", () => {
  const fixture = makePullRequest("packages/desktop-account/ts/src/new.ts");
  const result = evaluateAccountMacScope({
    cwd: fixture.cwd,
    eventName: "pull_request",
    event: fixture.event,
    githubSha: fixture.merge,
    githubRef: "refs/pull/207/merge",
  });
  assert.equal(result.runMac, false);
});

test("PR ref, checkout, parent, and payload-head mismatches all fall back to Mac", () => {
  const fixture = makePullRequest("packages/desktop-account/ts/src/new.ts");
  const baseArgs = {
    cwd: fixture.cwd,
    eventName: "pull_request",
    event: fixture.event,
    githubSha: fixture.merge,
    githubRef: "refs/pull/207/merge",
  };

  assert.equal(
    evaluateAccountMacScope({ ...baseArgs, githubRef: "refs/heads/main" }).runMac,
    true,
  );
  const wrongHeadEvent = structuredClone(fixture.event);
  wrongHeadEvent.pull_request.head.sha = fixture.actualBase;
  assert.equal(
    evaluateAccountMacScope({ ...baseArgs, event: wrongHeadEvent }).runMac,
    true,
  );

  git(fixture.cwd, "checkout", "-q", fixture.actualBase);
  assert.equal(evaluateAccountMacScope(baseArgs).runMac, true);
  assert.equal(
    evaluateAccountMacScope({ ...baseArgs, githubSha: fixture.actualBase }).runMac,
    true,
  );
});

test("push supports multiple commits and rejects force, unknown before, and empty comparisons", () => {
  const cwd = initRepo();
  const before = git(cwd, "rev-parse", "HEAD");
  commit(cwd, "packages/desktop-account/ts/src/a.ts", "a\n");
  const after = commit(cwd, "packages/desktop-account/ts/src/b.ts", "b\n");
  assert.equal(pushResult(cwd, before, after).runMac, false);
  assert.equal(pushResult(cwd, before, after, { event: { forced: true } }).runMac, true);
  assert.equal(pushResult(cwd, "0".repeat(40), after).runMac, true);
  assert.equal(pushResult(cwd, before, after, { githubSha: before }).runMac, true);
  assert.equal(pushResult(cwd, after, after).runMac, true);
});

test("merge_group validates base/head, checkout, and ancestry", () => {
  const cwd = initRepo();
  const base = git(cwd, "rev-parse", "HEAD");
  const head = commit(cwd, "packages/desktop-account/Cargo.lock", "synthetic\n");
  const args = {
    cwd,
    eventName: "merge_group",
    event: { merge_group: { base_sha: base, head_sha: head } },
    githubSha: head,
    githubRef: "refs/heads/gh-readonly-queue/main/pr-207",
  };
  assert.equal(evaluateAccountMacScope(args).runMac, true);
  assert.equal(
    evaluateAccountMacScope({
      ...args,
      event: { merge_group: { base_sha: head, head_sha: base } },
    }).runMac,
    true,
  );
  assert.equal(
    evaluateAccountMacScope({ ...args, githubSha: base }).runMac,
    true,
  );
});

test("rename and deletion retain the old native path because diff disables renames", () => {
  const renameRepo = initRepo();
  commit(renameRepo, "packages/desktop-account/src/old.rs", "old\n");
  const renameBase = git(renameRepo, "rev-parse", "HEAD");
  mkdirSync(join(renameRepo, "packages/desktop-account/ts/src"), { recursive: true });
  renameSync(
    join(renameRepo, "packages/desktop-account/src/old.rs"),
    join(renameRepo, "packages/desktop-account/ts/src/old.ts"),
  );
  git(renameRepo, "add", "--all");
  git(renameRepo, "commit", "-q", "-m", "rename native to ts");
  const renameHead = git(renameRepo, "rev-parse", "HEAD");
  const renameResult = pushResult(renameRepo, renameBase, renameHead);
  assert.equal(renameResult.runMac, true);
  assert.ok(renameResult.paths.includes("packages/desktop-account/src/old.rs"));

  const deleteRepo = initRepo();
  commit(deleteRepo, "packages/desktop-account/permissions/old.toml", "old\n");
  const deleteBase = git(deleteRepo, "rev-parse", "HEAD");
  const deleteHead = commit(
    deleteRepo,
    "packages/desktop-account/permissions/old.toml",
    null,
    "delete permission",
  );
  assert.equal(pushResult(deleteRepo, deleteBase, deleteHead).runMac, true);
});

test("real push comparisons cover Rust, lock, permissions, overrides, workflow, and helper", () => {
  for (const path of [
    "packages/desktop-account/src/lib.rs",
    "packages/desktop-account/Cargo.lock",
    "packages/desktop-account/permissions/default.toml",
    ".cargo/config.toml",
    ".github/workflows/account-mac-ci.yml",
    "scripts/ci/account-mac-scope.mjs",
  ]) {
    const cwd = initRepo();
    const before = git(cwd, "rev-parse", "HEAD");
    const after = commit(cwd, path, "changed\n");
    assert.equal(pushResult(cwd, before, after).runMac, true, path);
  }
});

test("unknown events and workflow_dispatch use the safe run fallback", () => {
  const cwd = initRepo();
  const sha = git(cwd, "rev-parse", "HEAD");
  for (const eventName of ["schedule", "repository_dispatch", undefined]) {
    assert.equal(
      evaluateAccountMacScope({ cwd, eventName, event: {}, githubSha: sha }).runMac,
      true,
    );
  }
  assert.equal(
    evaluateAccountMacScope({
      cwd,
      eventName: "workflow_dispatch",
      event: {},
      githubSha: sha,
    }).runMac,
    true,
  );
});

test("CLI writes run_mac=true when event data is unknown", () => {
  const cwd = initRepo();
  const eventPath = join(cwd, "event.json");
  const outputPath = join(cwd, "github-output.txt");
  writeFileSync(eventPath, "{}\n");
  const result = spawnSync(process.execPath, [HELPER_PATH], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "unknown",
      GITHUB_SHA: git(cwd, "rev-parse", "HEAD"),
      GITHUB_REF: "refs/heads/main",
      GITHUB_OUTPUT: outputPath,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(outputPath, "utf8"), "run_mac=true\n");
});

test("workflow boundary pins actions and preserves the public read-only contract", () => {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");
  const actionRefs = [...workflow.matchAll(/uses:\s+[^@\s]+@([^\s#]+)/g)].map(
    (match) => match[1],
  );
  assert.equal(actionRefs.length, 4);
  assert.ok(actionRefs.every((ref) => /^[0-9a-f]{40}$/.test(ref)));
  assert.match(workflow, /^name: Account Mac CI$/m);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(workflow, /^\s+id-token:/m);
  assert.doesNotMatch(workflow, /^\s+environment:/m);
  assert.doesNotMatch(workflow, /\bsecrets\b/);
  assert.doesNotMatch(workflow, /self-hosted/);
  assert.doesNotMatch(workflow, /^\s+paths(?:-ignore)?:/m);
  assert.match(workflow, /pull_request:\n    types: \[opened, reopened, synchronize, ready_for_review\]/);
  assert.match(workflow, /push:\n    branches: \[main\]/);
  assert.match(workflow, /^  merge_group:$/m);
  assert.match(workflow, /^  workflow_dispatch:$/m);
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.equal((workflow.match(/ref: \$\{\{ github\.sha \}\}/g) ?? []).length, 2);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 2);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /needs\.scope\.result != 'success'/);
  assert.match(workflow, /needs\.scope\.outputs\.run_mac != 'false'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /runs-on: macos-26/);
  assert.match(workflow, /^  account-mac:$/m);
  assert.match(workflow, /name: Account Rust Mac \(1\.99\.1, macos-26\)/);
  assert.match(workflow, /test "\$RUNNER_ARCH" = "ARM64"/);
  assert.match(workflow, /test "\$RUNNER_ENVIRONMENT" = "github-hosted"/);
  assert.match(workflow, /working-directory: packages\/desktop-account/);
  assert.match(workflow, /CARGO_TERM_COLOR: always/);
  assert.match(workflow, /CARGO_INCREMENTAL: "0"/);
  assert.match(workflow, /CARGO_PROFILE_DEV_DEBUG: line-tables-only/);
  assert.match(workflow, /~\/\.cargo\/registry\/index\//);
  assert.match(workflow, /~\/\.cargo\/registry\/cache\//);
  assert.match(workflow, /~\/\.cargo\/git\/db\//);
  assert.match(workflow, /packages\/desktop-account\/target\//);
  assert.match(workflow, /runner\.os.*runner\.arch.*rust-1\.99\.1.*hashFiles\('packages\/desktop-account\/Cargo\.lock'\)/);

  const requiredSteps = [
    ["Setup Rust", "rustup toolchain install 1.99.1 --profile minimal --component rustfmt --component clippy"],
    ["Format", "cargo fmt --all -- --check"],
    ["Clippy", "cargo clippy --locked --all-features --all-targets -- -D warnings"],
    ["Test (core)", "cargo test --locked"],
    ["Test (all features)", "cargo test --locked --all-features"],
    ["Permissions are committed", "git diff --exit-code -- permissions"],
  ];
  let previousIndex = -1;
  for (const [name, command] of requiredSteps) {
    const index = workflow.indexOf(`- name: ${name}`);
    assert.ok(index > previousIndex, `${name} exists in order`);
    assert.ok(workflow.indexOf(command, index) > index, `${name} runs its command`);
    previousIndex = index;
  }
});

// Failed/missing scope must run Mac; GitHub's implicit success() must not skip it.
test("Mac guard runs on failure/missing output and honors cancellation", () => {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");
  const condition = workflow.split("  account-mac:\n")[1].match(/^    if: \$\{\{ (.*) \$?\}\}/m)?.[1];
  assert.ok(condition);
  assert.match(condition, /always\(\)/);
  assert.match(workflow, /RUSTUP_TOOLCHAIN: 1\.99\.1/);
  for (const result of ["success", "failure", "skipped"]) for (const output of ["false", "true", "", undefined]) for (const cancelled of [false, true]) {
    const selected = Function("github", "needs", "always", "cancelled", `return (${condition});`)(
      { event_name: "push", ref: "refs/heads/main", event: {} },
      { scope: { result, outputs: { run_mac: output } } }, () => true, () => cancelled,
    );
    assert.equal(selected, !cancelled && (result !== "success" || output !== "false"));
  }
});
