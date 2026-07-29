#!/usr/bin/env node
/**
 * Standalone service bundler (deployment / docker-compose_spec §1.2).
 *
 * Bundles an app's TypeScript entry (api or worker) into a single ESM file in
 * `apps/<svc>/dist/` that runs on the bare `node` runtime image. The bind-mount
 * / updatable-without-rebuild model depends on this: `dist/` + a MINIMAL prod
 * `node_modules` (only the externals below) is what gets mounted; updating the
 * app = rebuild locally + `docker compose restart`, never `docker build`.
 *
 * WHY externals (not "zero node_modules"): esbuild cannot inline a native addon
 * or a module that spawns worker threads via runtime require. So we bundle all
 * pure-JS app + dep code and mark a small, explicit set external; those few
 * packages must be present in the runtime image / mounted prod node_modules.
 *   - @node-rs/argon2 — Rust `.node` native addon (api only).
 *   - playwright      — launches a separate Chromium binary (worker only; the
 *                       worker runtime image ships Chromium + fonts).
 *
 * pino IS bundled: Billy uses it in plain-JSON mode (no `transport`/`pino-pretty`
 * worker threads — see packages/shared/src/index.ts), so the usual esbuild
 * worker-thread footgun doesn't apply and bundling it avoids a dangling external.
 *
 * The mounted runtime needs only a MINIMAL prod node_modules holding the
 * externals above (e.g. `pnpm deploy --prod` or an explicit install into the
 * mounted folder); everything else is inlined into the single bundle.
 *
 * Usage: node scripts/build-service.mjs <api|worker>
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync } from "node:fs";

const svc = process.argv[2];
if (svc !== "api" && svc !== "worker") {
  console.error("usage: build-service.mjs <api|worker>");
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Externals: only native addons / separate-binary launchers that CANNOT be
// inlined. Everything else (incl. pino) is bundled.
const EXTERNAL = [];
if (svc === "api") EXTERNAL.push("@node-rs/argon2");
if (svc === "worker") EXTERNAL.push("playwright", "playwright-core");

await build({
  entryPoints: [resolve(root, `apps/${svc}/src/index.ts`)],
  outfile: resolve(root, `apps/${svc}/dist/index.js`),
  bundle: true,
  platform: "node",
  // ESM output (the entry uses top-level await for the first-run seed).
  format: "esm",
  target: "node20",
  // The few externals are native/binary; keep the createRequire shim so any
  // inlined CJS dep that calls require() at runtime still works under ESM.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  external: EXTERNAL,
  logLevel: "info",
});

// Mark dist/ as ESM so Node doesn't re-parse the bundle as CJS-then-ESM (the
// MODULE_TYPELESS_PACKAGE_JSON warning + a startup perf hit).
writeFileSync(resolve(root, `apps/${svc}/dist/package.json`), JSON.stringify({ type: "module" }, null, 2) + "\n");

console.log(`built apps/${svc}/dist/index.js (externals: ${EXTERNAL.join(", ")})`);
