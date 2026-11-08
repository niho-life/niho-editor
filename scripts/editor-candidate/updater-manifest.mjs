#!/usr/bin/env node
// Build the static Tauri updater manifest published as the latest GitHub Release asset.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const REPOSITORY = "niho-life/niho-editor";
const EXIT_USAGE = 2;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    options[arg.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

/** @param {{version:string, tag:string, assetName:string, signature:string, notes:string, pubDate:string}} input */
export function createManifest(input) {
  const { version, tag, assetName, notes, pubDate } = input;
  const signature = String(input.signature ?? "").trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("version must be a stable X.Y.Z version");
  }
  const tagMatch = tag.match(/^docs-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-([a-f0-9]{12})$/);
  if (!tagMatch || tagMatch[1] !== version) throw new Error("tag must match docs-v<version>-<12 digit source SHA>");
  const shortSha = tagMatch[2];
  const expectedAsset = `NIHO-docs-${version}-${shortSha}.app.tar.gz`;
  if (assetName !== expectedAsset || assetName.includes("/") || assetName.includes("\\")) {
    throw new Error("assetName must be the updater archive for this version and release tag");
  }
  if (!signature || /[\r\n]/.test(signature)) throw new Error("signature must be a non-empty single-line Tauri .sig value");
  const decodedSignature = Buffer.from(signature, "base64").toString("utf8");
  if (!decodedSignature.startsWith("untrusted comment:") || !decodedSignature.includes("\ntrusted comment: ")) {
    throw new Error("signature is not a Tauri updater .sig value");
  }
  if (typeof notes !== "string") throw new Error("notes must be a string");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(pubDate) || Number.isNaN(Date.parse(pubDate))) {
    throw new Error("pubDate must be an RFC 3339 UTC timestamp");
  }

  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      "darwin-aarch64": {
        signature,
        url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${assetName}`,
      },
    },
  };
}

function run(argv) {
  const { command, options } = parseArgs(argv);
  if (command !== "create") throw new Error("usage: updater-manifest.mjs create --version X.Y.Z --tag TAG --asset-name FILE --signature-file FILE --output FILE --notes TEXT");
  for (const required of ["version", "tag", "asset-name", "signature-file", "output", "notes"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  const pubDate = options["pub-date"] ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const manifest = createManifest({
    version: options.version,
    tag: options.tag,
    assetName: options["asset-name"],
    signature: fs.readFileSync(options["signature-file"], "utf8"),
    notes: options.notes,
    pubDate,
  });
  fs.writeFileSync(options.output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = EXIT_USAGE;
  }
}
