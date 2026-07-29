/**
 * Realtime store (realtime/websocket-server). Owns the ONE socket.io connection
 * for the app. The socket authenticates with the SAME `billy_session` cookie as
 * HTTP (no token param) via `withCredentials: true`, connects to path
 * `/socket.io`, and forwards every `"event"` payload to the notifications store.
 *
 * Lifecycle: `connect()` is called when the user becomes authenticated and
 * `disconnect()` when they log out (AppShell wires this to `auth.isAuthenticated`).
 * A singleton guard prevents double-connect across login/logout churn. socket.io's
 * default reconnection handles transient drops; when the socket is down the bell
 * still shows the REST-seeded list (this store never blocks the UI).
 *
 * CONNECTION TARGET: the socket.io server lives at the API server *origin*, NOT
 * at the `API_URL` path. `API_URL` is e.g. `http://localhost:3000/api`; the socket
 * connects to `http://localhost:3000` with `path: "/socket.io"`. When `API_URL`
 * is a relative path (the fallback `/api`), we connect same-origin.
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import { io, type Socket } from "socket.io-client";
import { getConfig } from "@/config";
import { useNotificationsStore } from "@/stores/notifications";
import type { WsEvent } from "@/types/domain";

/** socket.io path — must match the backend `REALTIME_PATH`. */
const REALTIME_PATH = "/socket.io";
/** socket.io channel the backend emits WsEvents on (`WS_EVENT_CHANNEL`). */
const WS_EVENT_CHANNEL = "event";

export const realtimeUrl = (apiUrl: string): string | undefined => {
  try {
    return new URL(apiUrl).origin;
  } catch {
    // Relative API_URL (e.g. "/api") → same-origin connection.
    return undefined;
  }
};

export const useRealtimeStore = defineStore("realtime", () => {
  // The raw socket is held module-locally (not in the store's public return) so
  // socket.io's (non-portable) internal types never leak into this store's
  // emitted declaration — only the plain booleans/functions below are exported.
  let socket: Socket | null = null;
  const connected = ref<boolean>(false);

  /**
   * Open the single socket connection (idempotent). Seeds the notifications
   * store first so the bell has data even before the first WS event (and even if
   * the socket never connects). Reconnection is handled by socket.io defaults.
   */
  function connect(): void {
    if (socket) return; // singleton guard

    const notifications = useNotificationsStore();
    void notifications.seed();

    const url = realtimeUrl(getConfig().API_URL);
    // `io(opts)` connects same-origin; `io(url, opts)` to the origin.
    const s: Socket = url
      ? io(url, { path: REALTIME_PATH, withCredentials: true })
      : io({ path: REALTIME_PATH, withCredentials: true });

    s.on("connect", () => {
      connected.value = true;
    });
    s.on("disconnect", () => {
      connected.value = false;
    });
    s.on(WS_EVENT_CHANNEL, (evt: WsEvent) => {
      notifications.ingest(evt);
    });

    socket = s;
  }

  /** Close the socket and clear notification state (logout). */
  function disconnect(): void {
    if (socket) {
      socket.off();
      socket.disconnect();
      socket = null;
    }
    connected.value = false;
    useNotificationsStore().clear();
  }

  /** True when a socket instance exists (connected or reconnecting). */
  function isOpen(): boolean {
    return socket !== null;
  }

  return { connected, connect, disconnect, isOpen };
});
