import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

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
    // Inline Vuetify so its `.css` side-effect imports go through Vite's transform
    // instead of Node's ESM loader (which cannot resolve `.css`). Required to mount
    // Vuetify components in component tests (Vitest 2.x: test.server.deps.inline).
    server: { deps: { inline: ["vuetify"] } },
  },
});
