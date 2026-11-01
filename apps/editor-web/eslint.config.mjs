import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const SERVER_ONLY = "DB と認証の方式はサーバー専用です（src/server・src/auth を経由し、ブラウザへ渡さない）。";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // ブラウザで動く部品から DB・認証の実装を読み込まない（token・接続をブラウザへ持ち込まない）
    files: ["src/components/**/*.tsx", "src/lib/**/*.ts"],
    // test はブラウザへ配らないので、画面の受入を本物の受付 API（src/server）で確かめてよい（例: PageSteps.test.tsx）
    ignores: ["src/components/StubBadge.tsx", "src/components/Notice.tsx", "src/components/**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", {
        paths: [
          { name: "pg", message: SERVER_ONLY, allowTypeImports: true },
          { name: "@niho/editor-store", message: SERVER_ONLY, allowTypeImports: true },
        ],
        patterns: [
          { group: ["@/server/*", "@/auth", "@/auth/index", "@/auth/stub", "@/auth/niho"], message: SERVER_ONLY, allowTypeImports: true },
        ],
      }],
    },
  },
  globalIgnores([".next/**", "next-env.d.ts", "test/**/*.mjs", "public/photo-runtime/**"]),
]);
