import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // server-only は Next の外では import しただけで throw するので、テストでは空にする
      "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    server: {
      deps: {
        // TypeScript のままの packages（install-links で node_modules に複製）を Vite で変換する
        inline: ["@niho/docs-core", "@niho/editor-publish", "@niho/editor-publish-contract", "@niho/editor-store", "niho-docs-ui", "niho-ui"],
      },
    },
  },
});
