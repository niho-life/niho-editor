import { execFileSync } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const scanRoots = [
  ".github/workflows",
  "apps/docs/dist",
  "packages/niho-cloud-contract/v1",
  "packages/editor-publish-contract/v1",
];
const textExtensions = new Set([
  ".css", ".html", ".js", ".json", ".log", ".map", ".md", ".mjs", ".svg", ".txt", ".ts", ".xml", ".yaml", ".yml",
]);

const secretPatterns = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["github-token", /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["stripe-live-key", /\b(?:sk|rk)_live_[A-Za-z0-9]{12,}\b/],
  ["google-access-token", /\bya29\.[A-Za-z0-9_-]{20,}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["credential-url", /https?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/i],
];
const privateEndpointPatterns = [
  ["private-hostname", /https?:\/\/[a-z0-9.-]+\.(?:internal|corp|svc\.cluster\.local)(?=[:/?#\s]|$)/i],
  ["private-ip", /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3})\b/],
];
const fixturePiiPatterns = [
  ["non-example-email", /\b[A-Z0-9._%+-]+@(?!example\.(?:com|net|org)\b|example\.test\b|test\b|invalid\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ["absolute-user-path", /(?:\/Users\/(?!example\/|test\/|runner\/)[^/\s]+\/|\/home\/(?!example\/|test\/|runner\/)[^/\s]+\/)/],
];
const workflowPatterns = [
  ["privileged-pull-request", /^\s*pull_request_target\s*:/m],
  ["workflow-secret-reference", /\bsecrets\s*(?:\.[A-Z0-9_]+|\[)/i],
  ["write-all-permissions", /^\s*permissions\s*:\s*write-all\s*$/m],
];

function patternsForFile(relativePath) {
  const patterns = [...secretPatterns, ...privateEndpointPatterns];
  if (relativePath.startsWith(".github/workflows/")) patterns.push(...workflowPatterns);
  if (relativePath.includes("/fixtures/") || relativePath.includes("/test/fixtures/") || relativePath.endsWith("/security-cases.json")) {
    patterns.push(...fixturePiiPatterns);
  }
  if (relativePath.endsWith(".map") || relativePath.endsWith(".log")) {
    patterns.push(...fixturePiiPatterns);
  }
  return patterns;
}

export function trackedFixturePaths(paths) {
  return [...new Set(paths.filter((relativePath) =>
    /(?:^|\/)fixtures(?:\/|$)/.test(relativePath)
      && textExtensions.has(path.extname(relativePath).toLowerCase()),
  ))].sort();
}

export function findFindings(relativePath, content) {
  return patternsForFile(relativePath)
    .filter(([rule, pattern]) => pattern.test(rule === "workflow-secret-reference" ? withoutMaskedPublicClientConfig(relativePath, content) : content))
    .map(([rule]) => rule);
}

function withoutMaskedPublicClientConfig(relativePath, content) {
  if (relativePath !== ".github/workflows/editor-mac-candidate.yml") return content;
  const jobs = [...content.matchAll(/^  ([a-z_]+):\n([\s\S]*?)(?=^  [a-z_]+:|$(?![\s\S]))/gm)];
  const plan = jobs.find((match) => match[1] === "plan")?.[2] ?? "";
  const gate = "    if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.repository == 'niho-life/niho-editor'";
  if (!plan.split("\n").includes(gate) || /continue-on-error:\s*true/.test(content)) return content;
  let checked = content;
  for (const match of jobs) {
    const [block, name, body] = match;
    const setting = name === "plan" ? "CLIENT_CONFIG" : name === "build" ? "NIHO_FIREBASE_API_KEY" : null;
    if (!setting || (name === "build" && (!/^    needs: plan$/m.test(body) || /^    if:/m.test(body)))) continue;
    // This client setting is already embedded in the public app. Secret storage
    // supplies log masking; it grants no signing, cloud or private-repo authority.
    const reference = "          " + setting + ": ${{ secrets.NIHO_DESKTOP_FIREBASE_API_KEY_PROD }}";
    const sanitized = block.split("\n").map((line) => line === reference ? `          ${setting}: masked-public-client-config` : line).join("\n");
    checked = checked.replace(block, sanitized);
  }
  return checked;
}

async function filesUnder(relativePath) {
  const absolutePath = path.join(root, relativePath);
  let entries;
  try {
    entries = await readdir(absolutePath, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const childRelative = path.posix.join(relativePath, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(childRelative));
    else if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) files.push(childRelative);
  }
  return files;
}

async function main() {
  const findings = [];
  const pathsToScan = new Set();
  for (const scanRoot of scanRoots) {
    for (const relativePath of await filesUnder(scanRoot)) pathsToScan.add(relativePath);
  }
  const trackedPaths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const relativePath of trackedFixturePaths(trackedPaths)) {
    const info = await lstat(path.join(root, relativePath));
    if (info.isFile()) pathsToScan.add(relativePath);
  }
  for (const relativePath of pathsToScan) {
    const content = await readFile(path.join(root, relativePath), "utf8");
    for (const rule of findFindings(relativePath, content)) findings.push({ path: relativePath, rule });
  }

  if (findings.length > 0) {
    for (const finding of findings) process.stderr.write(`public-boundary-guard: ${finding.rule} in ${finding.path}\n`);
    process.stderr.write(`public-boundary-guard: ${findings.length} finding(s); values were not printed\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`public-boundary-guard: scanned ${pathsToScan.size} public workflows, artifacts, logs, and tracked fixture files; no findings\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
