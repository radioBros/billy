import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * The api uses `@/` alias imports with NodeNext `.js` extensions (e.g.
 * `@/platform/crypto.js`). tsc + esbuild read the tsconfig `paths` natively, but
 * Vitest needs an explicit resolve alias. A regex alias maps `@/<path>.js` →
 * `<srcDir>/<path>` and lets Vite resolve the real `.ts` — so the `.js` specifier
 * (required by NodeNext) works under Vitest too.
 */
const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@\/(.*)\.js$/, replacement: `${src}/$1` }],
  },
  test: {
    environment: "node",
    globals: false,
  },
});
