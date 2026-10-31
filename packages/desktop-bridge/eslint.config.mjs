import tsParser from "@typescript-eslint/parser";

import { noFragileTextPxRule } from "../ui/eslint-rules/no-fragile-text-px.mjs";

// Mac の殻の包み（niho-desktop-bridge）の ESLint。packages/desktop-account/ts と同じ形。React を持たないのでフックの規則は無い。
export default [
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**"],
  },
  {
    files: ["**/*.{js,mjs,ts}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      niho: { rules: { "no-fragile-text-px": noFragileTextPxRule } },
    },
    rules: {
      "niho/no-fragile-text-px": "error",
    },
  },
];
