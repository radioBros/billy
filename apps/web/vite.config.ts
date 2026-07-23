import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";

// Build-time env is NOT used for runtime config (AS-1b): API_URL/APP_URL/VAPID
// are read at runtime from window.__APP_CONFIG__ (public/config.js). Vite only
// bundles the app; config.js is loaded by index.html before the bundle.
//
// DEV ONLY: the local dev server (`pnpm dev`) proxies /api + /socket.io to the
// backend so the SPA stays same-origin (cookies + WS work, no CORS). The target
// comes from `VITE_API_PROXY_TARGET` in apps/web/.env* (see .env.example),
// defaulting to the local Docker stack at http://localhost:3480. This is a
// dev-server convenience; production still serves the SPA statically behind the
// reverse proxy with runtime config.js — nothing here is baked into the build.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, new URL(".", import.meta.url).pathname, "VITE_");
  const apiProxyTarget = env.VITE_API_PROXY_TARGET ?? "http://localhost:3480";
  return {
  plugins: [
    vue(),
    // PWA (installable + offline app shell + web push). Self-host friendly: no
    // external CDN. We use `injectManifest` (not `generateSW`) because web push
    // needs a HAND-WRITTEN service worker (src/sw.ts) with `push` +
    // `notificationclick` handlers — generateSW cannot emit those. The plugin
    // still injects the precache manifest into our SW via `self.__WB_MANIFEST`.
    VitePWA({
      // Custom SW authored in TypeScript. `srcDir`/`filename` point the plugin at
      // it; the build compiles src/sw.ts → dist/sw.js and injects the manifest.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      // prompt: a new SW installs + WAITS; the app shows an "update available"
      // modal and only reloads on user consent (see PwaPrompts.vue +
      // useRegisterSW). injectRegister is null because useRegisterSW() registers
      // the SW itself — "auto" would double-register.
      registerType: "prompt",
      injectRegister: null,
      includeAssets: ["favicon.ico", "favicon.png", "billy.png"],
      manifest: {
        name: "Billy",
        short_name: "Billy",
        description: "Billy — invoicing",
        theme_color: "#5b5bd6",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "maskable-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      // Manifest-injection options for injectManifest. The runtime caching /
      // navigateFallback / NetworkOnly-/api rules that generateSW used to emit are
      // now hand-coded in src/sw.ts (see that file).
      injectManifest: {
        // Precache the built app shell (JS/CSS/HTML/icons). Offline: the shell
        // loads and SPA routes resolve via the index.html fallback (sw.ts).
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff,woff2}"],
        // config.js is bind-mounted RUNTIME config (repoint via .env, no rebuild).
        // A precached copy would go stale, so never precache it.
        globIgnores: ["**/config.js"],
      },
      // Keep the SW out of dev so the dev server / tests are unaffected.
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
    // Sass compilation uses the modern compiler API (the only API as of Vite 8;
    // the legacy JS API and its explicit opt-in were removed). Requires the
    // `sass` dev dependency.
    server: {
      // Billy's assigned port range is 3480–3490; the Vite dev server uses 3489.
      port: 3489,
      // Dev proxy → local Docker backend. Keeps the SPA same-origin so the
      // runtime config.js fallback (`API_URL: "/api"`) + session cookies + the
      // socket.io upgrade all work without CORS.
      proxy: {
        "/api": { target: apiProxyTarget, changeOrigin: true },
        "/public": { target: apiProxyTarget, changeOrigin: true },
        "/socket.io": { target: apiProxyTarget, changeOrigin: true, ws: true },
      },
    },
    build: {
      outDir: "dist",
      // config.js is served/mounted separately at runtime; never inlined.
      emptyOutDir: true,
    },
  };
});
