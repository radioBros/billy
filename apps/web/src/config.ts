/**
 * Runtime config.
 *
 * Public config is provided at RUNTIME via `window.__APP_CONFIG__`, set by
 * `/config.js` which `index.html` loads before this bundle. We deliberately do
 * NOT read `import.meta.env` for these values — that would bake them at build
 * time and defeat the bind-mount deploy model (repoint via .env + restart, no
 * rebuild).
 *
 * `getConfig()` reads `window` at call time (not a module-load constant) so that
 * tests can set `window.__APP_CONFIG__` per case, and so a late-loaded config.js
 * is still honored.
 */

export interface AppConfig {
  /** Public origin the SPA is served from. */
  APP_URL: string;
  /** Base URL of the REST API, e.g. "http://localhost:3000/api". */
  API_URL: string;
  /** Web Push VAPID public key (public — safe in config.js). */
  VAPID_PUBLIC_KEY: string;
}

declare global {
  interface Window {
    __APP_CONFIG__?: Partial<AppConfig>;
  }
}

const FALLBACK: AppConfig = {
  APP_URL: "",
  API_URL: "/api",
  VAPID_PUBLIC_KEY: "",
};

export function getConfig(): AppConfig {
  const raw = typeof window !== "undefined" ? window.__APP_CONFIG__ : undefined;
  if (!raw) {
    // No config.js loaded: fall back to a same-origin "/api" default rather than
    // throwing, so the app can still render (e.g. a misconfigured deploy shows
    // its error states instead of a white screen). Integrators must mount config.js.
    return { ...FALLBACK };
  }
  return {
    APP_URL: raw.APP_URL ?? FALLBACK.APP_URL,
    API_URL: raw.API_URL ?? FALLBACK.API_URL,
    VAPID_PUBLIC_KEY: raw.VAPID_PUBLIC_KEY ?? FALLBACK.VAPID_PUBLIC_KEY,
  };
}

/** Convenience: the API base URL, read at call time (never cached at import). */
export function apiBaseUrl(): string {
  return getConfig().API_URL;
}
