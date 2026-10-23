import process from "node:process";
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// Node 25+ ships a native localStorage global that shadows jsdom's Storage and
// breaks store tests. --no-webstorage drops it so jsdom owns the API.
// Flag does not exist on Node 24 — only apply on >= 25.
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0]!, 10);

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    execArgv: nodeMajor >= 25 ? ["--no-webstorage"] : [],
    // Inline Vuetify so its `.css` side-effect imports go through Vite's transform
    // instead of Node's ESM loader (which cannot resolve `.css`). Required to mount
    // Vuetify components in component tests (Vitest 2.x: test.server.deps.inline).
    server: { deps: { inline: ["vuetify"] } },
  },
});
