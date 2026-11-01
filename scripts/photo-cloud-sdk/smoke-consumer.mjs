#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readTarEntries, verifyReleaseSet } from "./verify-release-set.mjs";

export class PhotoCloudSmokeError extends Error {}

function write(root, relative, bytes) {
  const target = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes, { flag: "wx", mode: 0o644 });
}

function extractPackage(tarball, destination) {
  for (const [relative, bytes] of readTarEntries(tarball)) write(destination, relative, bytes);
}

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    const detail = [error?.stdout, error?.stderr].filter(Boolean).map((value) => value.toString().trim()).filter(Boolean).join("\n");
    throw new PhotoCloudSmokeError(`consumer smoke commandが失敗しました${detail ? `\n${detail}` : ""}`);
  }
}

export function smokeConsumer(manifestPath, { repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") } = {}) {
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = verifyReleaseSet(absoluteManifest);
  const consumer = mkdtempSync(path.join(tmpdir(), "niho-photo-cloud-consumer-"));
  try {
    for (const item of manifest.packages) {
      const destination = path.join(consumer, "node_modules", ...item.name.split("/"));
      mkdirSync(destination, { recursive: true });
      extractPackage(readFileSync(path.join(path.dirname(absoluteManifest), item.file)), destination);
    }
    const peerRoot = path.join(repoRoot, "packages/photo-cloud-library/node_modules");
    for (const peer of ["niho-photo-contract", "niho-photo-editing"]) {
      const source = path.join(peerRoot, peer);
      const destination = path.join(consumer, "node_modules", peer);
      cpSync(source, destination, { recursive: true, dereference: true, errorOnExist: true });
    }
    write(consumer, "src/type-smoke.ts", `
import {
  PHOTO_LIBRARY_CONTRACT_VERSION,
  PHOTO_LIMITS,
  type PhotoOperationMap,
} from "@niho/photo-library-contract";
import {
  CloudPhotoError,
  createPhotoApiClient,
  type CloudPhotoLibraryOptions,
  type PhotoApiClient,
} from "@niho/photo-cloud-library";

const version: 1 = PHOTO_LIBRARY_CONTRACT_VERSION;
const limit: number = PHOTO_LIMITS.listMaxCount;
const request: PhotoOperationMap["library.get"]["request"] = {};
const clientFactory: typeof createPhotoApiClient = createPhotoApiClient;
const error: Error = new CloudPhotoError("invalid_response", null, null, false);
export type SmokeTypes = [CloudPhotoLibraryOptions, PhotoApiClient];
void [version, limit, request, clientFactory, error];
`);
    write(consumer, "runtime-smoke.mjs", `
import { PHOTO_LIBRARY_CONTRACT_VERSION, PHOTO_LIMITS } from "@niho/photo-library-contract";
import { CloudPhotoError, createPhotoApiClient } from "@niho/photo-cloud-library";
if (PHOTO_LIBRARY_CONTRACT_VERSION !== 1 || typeof PHOTO_LIMITS.listMaxCount !== "number") throw new Error("contract export mismatch");
if (typeof createPhotoApiClient !== "function") throw new Error("adapter export mismatch");
const error = new CloudPhotoError("invalid_response", null, null, false);
if (error.code !== "invalid_response") throw new Error("error export mismatch");
`);
    const typescriptModule = pathToFileURL(path.join(peerRoot, "typescript/lib/typescript.js")).href;
    write(consumer, "ts-loader.mjs", `
import { readFile } from "node:fs/promises";
import ts from ${JSON.stringify(typescriptModule)};
export async function load(url, context, nextLoad) {
  if (!/\\.tsx?$/.test(new URL(url).pathname)) return nextLoad(url, context);
  const source = await readFile(new URL(url), "utf8");
  return {
    format: "module",
    shortCircuit: true,
    source: ts.transpileModule(source, { fileName: new URL(url).pathname, compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      verbatimModuleSyntax: false,
    } }).outputText,
  };
}
`);
    write(consumer, "tsconfig.json", `${JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        types: [],
      },
      include: ["src/type-smoke.ts"],
    }, null, 2)}\n`);
    const compiler = path.join(peerRoot, "typescript/bin/tsc");
    run(process.execPath, [compiler, "-p", "tsconfig.json"], consumer);
    run(process.execPath, ["--experimental-loader", "./ts-loader.mjs", "runtime-smoke.mjs"], consumer);
    for (const item of manifest.packages) {
      const installed = JSON.parse(readFileSync(path.join(consumer, "node_modules", ...item.name.split("/"), "package.json"), "utf8"));
      if (Object.values(installed.peerDependencies ?? {}).some((value) => /^(?:file:|link:|workspace:)/u.test(value))) throw new PhotoCloudSmokeError("consumer packageにlocal peer解決が残っています");
    }
    return { packages: manifest.packages.map(({ name }) => name) };
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    if (argv.length !== 2 || argv[0] !== "--manifest" || !argv[1]) throw new PhotoCloudSmokeError("使い方: smoke-consumer.mjs --manifest PATH");
    const result = smokeConsumer(argv[1]);
    console.log(`repo外Photo cloud consumer smokeが通りました（${result.packages.length} packages）`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "consumer smokeに失敗しました");
    process.exitCode = 1;
  }
}
