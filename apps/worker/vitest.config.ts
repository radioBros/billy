import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/** Resolve `@/<path>.js` → `<srcDir>/<path>` for Vitest (NodeNext `.js` specifiers).
 *  tsc + esbuild read tsconfig `paths` natively; Vitest needs this explicit alias. */
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
