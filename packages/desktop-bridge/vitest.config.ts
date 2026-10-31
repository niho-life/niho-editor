import { defineConfig } from "vitest/config";

// package 単独のテスト（`npm -C packages/desktop-bridge test`。CI は docs-core-ci.yml の desktop-bridge）。
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
