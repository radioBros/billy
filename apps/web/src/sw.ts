/// <reference lib="webworker" />
/**
 * Custom service worker (PWA + Web Push).
 *
 * Built via vite-plugin-pwa `injectManifest` (vite.config.ts): the plugin
 * replaces `self.__WB_MANIFEST` with the precache manifest of the built app
 * shell, and compiles this file to `dist/sw.js`.
 *
 * Why hand-written instead of generateSW: web push requires `push` +
 * `notificationclick` event handlers, which generateSW cannot emit. We keep the
 * same offline behaviour the old generateSW config had (precache the shell,
 * SPA navigateFallback to index.html, never precache the runtime config.js, and
 * never cache /api — requests always hit the network and fail gracefully via the
 * api client's DEPENDENCY_UNAVAILABLE path).
 */
import {
  precacheAndRoute,
  createHandlerBoundToURL,
  cleanupOutdatedCaches,
} from "workbox-precaching";

// Service-worker global scope typing so tsc/vue-tsc is happy about `self`,
// `skipWaiting`, `clients`, `registration`, etc.
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

/** App icons for notifications (precached; see manifest in vite.config.ts). */
const NOTIFICATION_ICON = "/pwa-192x192.png";
const NOTIFICATION_BADGE = "/pwa-192x192.png";

/** Push payload shape sent by the worker (MATCH the backend contract). */
interface PushPayload {
  title: string;
  body: string;
  data?: { url?: string };
}

// --- Precache the app shell + SPA navigation fallback ------------------------
// `precacheAndRoute` registers a cache-first route for every asset in the
// injected manifest. `cleanupOutdatedCaches` drops precaches from prior builds.
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// SPA navigation fallback: serve the precached index.html for navigations so
// deep links resolve offline. Denylist /api and /config.js (runtime, uncached)
// so those still hit the network. Guarded because `createHandlerBoundToURL`
// throws if index.html was not precached (e.g. dev), which must not break push.
try {
  const navigationHandler = createHandlerBoundToURL("/index.html");
  const denylist = [/^\/api\//u, /\/config\.js$/u];
  self.addEventListener("fetch", (event: FetchEvent) => {
    const req = event.request;
    if (req.mode !== "navigate") return;
    const url = new URL(req.url);
    if (denylist.some((re) => re.test(url.pathname))) return;
    event.respondWith(navigationHandler({ event, request: req, url, params: undefined }));
  });
} catch {
  // index.html not precached (dev / test build): skip the SPA fallback route.
}

// --- Lifecycle: PROMPT-mode update ------------------------------------------
// registerType is "prompt": a new SW installs and WAITS (no auto-skipWaiting), so
// the app can show an "update available" modal. It only takes over when the user
// consents — the page posts { type: "SKIP_WAITING" } (via updateServiceWorker(true)).
self.addEventListener("message", (event: ExtendableMessageEvent) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});
self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim());
});

// --- Web Push ----------------------------------------------------------------
self.addEventListener("push", (event: PushEvent) => {
  if (!event.data) return;
  let payload: PushPayload;
  try {
    payload = event.data.json() as PushPayload;
  } catch {
    // Non-JSON payload: show the raw text as the body with a generic title.
    payload = { title: "Billy", body: event.data.text() };
  }
  const title = payload.title || "Billy";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body ?? "",
      data: payload.data ?? {},
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_BADGE,
    }),
  );
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const data = (event.notification.data ?? {}) as { url?: string };
  const target = data.url || "/";
  event.waitUntil(
    (async (): Promise<void> => {
      const targetUrl = new URL(target, self.location.origin);
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Focus an existing client on the same origin, navigating it if possible.
      for (const client of all) {
        if (new URL(client.url).origin === targetUrl.origin) {
          await client.focus();
          if ("navigate" in client && client.url !== targetUrl.href) {
            await client.navigate(targetUrl.href).catch(() => undefined);
          }
          return;
        }
      }
      // No client open: open a new window.
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl.href);
      }
    })(),
  );
});
