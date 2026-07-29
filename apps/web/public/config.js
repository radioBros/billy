// Runtime frontend config (AS-1b / env-vars §E7).
// DEV DEFAULT ONLY (served by the Vite dev server). URLs are RELATIVE so requests
// go through the dev-server proxy → the Docker backend (vite.config.ts routes
// /api, /public, /socket.io to VITE_API_PROXY_TARGET). Same-origin keeps session
// cookies + WebSocket working with no CORS.
// In production the `web` container renders this file from the public subset of
// .env (APP_URL, API_URL, VAPID_PUBLIC_KEY) and nginx serves it as a bind-mount,
// so the SPA is repointed by editing .env + restart — no rebuild. Never put
// secrets here; only the public whitelist.
window.__APP_CONFIG__ = {
  APP_URL: "http://localhost:3489",
  API_URL: "/api",
  VAPID_PUBLIC_KEY: "",
};
