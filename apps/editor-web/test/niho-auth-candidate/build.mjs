import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(root, "../../src");
const output = path.join(root, "dist");
const sourceCommit = process.env.SOURCE_COMMIT;
if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? "")) throw new Error("SOURCE_COMMIT must be an exact SHA");
const sources = ["auth/auto-form.ts", "auth/config.ts", "auth/types.ts", "auth/return-to.ts", "auth/niho.ts", "server/http.ts", "server/auth-routes.ts", "server/photo-auth/index.ts"];
const hashes = {};
for (const relative of sources) {
  const source = await readFile(path.join(sourceRoot, relative), "utf8");
  hashes[relative] = createHash("sha256").update(source).digest("hex");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } });
  const target = path.join(output, "src", relative.replace(/\.ts$/, ".js"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, compiled.outputText);
}
await writeFile(path.join(output, "package.json"), JSON.stringify({ type: "commonjs" }));
await writeFile(path.join(output, "manifest.json"), JSON.stringify({ sourceCommit, hashes }));
await mkdir(path.join(output, "node_modules"), { recursive: true });
await cp(path.join(root, "node_modules/server-only"), path.join(output, "node_modules/server-only"), { recursive: true });
for (const file of ["app.mjs", "server.mjs"]) await cp(path.join(root, file), path.join(output, file));
