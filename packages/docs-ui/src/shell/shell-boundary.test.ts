import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = path.resolve(__dirname, "..");
const shellDir = __dirname;

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));

/** コメントの中の説明（DocsHost・shell.css など）は数えない。 */
const code = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const shellSources = walk(shellDir).filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file));

describe("shell の境界（既存の画面・Mac アプリを止めない）", () => {
  it("shell は DocsHost・fetch・保存・既存の components/screens を使わず、lucide-react も使わない", () => {
    expect(shellSources.length).toBeGreaterThan(15);
    for (const file of shellSources) {
      const source = code(file);
      const name = path.basename(file);
      expect(source, name).not.toMatch(/\bfetch\s*\(|localStorage|sessionStorage|indexedDB|DocsHost/);
      for (const match of source.matchAll(/from\s*["']([^"']+)["']/g)) {
        const specifier = match[1]!;
        expect(specifier, name).not.toMatch(/lucide-react|@niho\/docs-core|@tauri-apps|\.\.\/(components|screens|host|lib|editor|flow|sharing)\b/);
        if (specifier.startsWith(".")) expect(path.resolve(path.dirname(file), specifier).startsWith(shellDir), `${name}: ${specifier}`).toBe(true);
      }
    }
  });

  it("shell の TS/TSX に色の生 hex（特に緑）を書かない", () => {
    // brand.tsx はアプリのアイコン（apps/docs/src-tauri/icons/icon.svg のグリフ）をそのまま描くので、アイコン自身の固定色だけを例外にする
    for (const file of shellSources.filter((name) => path.basename(name) !== "brand.tsx")) {
      expect(code(file), path.basename(file)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  it("shell.css を import するのはギャラリーとテストだけ（既存のどのファイルも読まない）", () => {
    for (const file of walk(srcRoot).filter((name) => /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name))) {
      if (file.endsWith(`${path.sep}styles${path.sep}shell.css`)) continue;
      expect(code(file), path.relative(srcRoot, file)).not.toMatch(/shell\.css/);
    }
  });

  // page/ は shell の上に載る新しい本文のエディタ（Mac・Web 共通。#45）なので、shell の部品・クラスを使ってよい
  const pageDir = path.join(srcRoot, "page");

  it("既存の画面は es- のクラスや editor-tokens を読まない", () => {
    for (const file of walk(srcRoot).filter((name) => /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.startsWith(shellDir) && !name.startsWith(pageDir) && !name.endsWith("shell.css"))) {
      expect(code(file), path.relative(srcRoot, file)).not.toMatch(/\bes-root\b|editor-tokens/);
    }
  });
});
