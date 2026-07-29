/**
 * usePushNotifications — client-side Web Push subscribe/unsubscribe flow.
 *
 * Support gating (`isSupported`) requires all three: the ServiceWorker API, the
 * PushManager API, and a non-empty runtime VAPID public key (config.ts). When
 * any is missing, push is unavailable and the UI hides/disables the control.
 *
 * subscribe(): request Notification permission → subscribe via the SW's
 * PushManager (with the VAPID key) → POST the browser PushSubscription JSON to
 * `/api/v1/push/subscribe` (requireAuth). unsubscribe(): read the current
 * subscription, unsubscribe locally, then POST its endpoint to
 * `/api/v1/push/unsubscribe`.
 *
 * The composable is a thin, module-testable wrapper: state is reactive so the
 * UI reflects permission + subscription changes.
 */
import { ref, readonly, type Ref, type DeepReadonly } from "vue";
import { getConfig } from "@/config";
import { post } from "@/api/client";

export const isPushSupported = (): boolean => {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined" &&
    getConfig().VAPID_PUBLIC_KEY.length > 0
  );
};

export const urlBase64ToUint8Array = (base64String: string): Uint8Array<ArrayBuffer> => {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/gu, "+").replace(/_/gu, "/");
  const rawData = atob(base64);
  // Back the view with a concrete ArrayBuffer so it satisfies BufferSource
  // (applicationServerKey) under TS's generic-typed-array typings.
  const output = new Uint8Array(new ArrayBuffer(rawData.length));
  for (let i = 0; i < rawData.length; i += 1) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
};

export interface UsePushNotifications {
  /** Whether push is available (APIs + VAPID key). */
  isSupported: boolean;
  /** Reactive Notification permission: "default" | "granted" | "denied". */
  permission: DeepReadonly<Ref<NotificationPermission>>;
  /** Reactive: true when this device currently holds a push subscription. */
  isSubscribed: DeepReadonly<Ref<boolean>>;
  /** Reactive: true while a subscribe/unsubscribe call is in flight. */
  busy: DeepReadonly<Ref<boolean>>;
  /** Request permission + subscribe + register with the API. Returns success. */
  subscribe: () => Promise<boolean>;
  /** Unsubscribe locally + deregister with the API. Returns success. */
  unsubscribe: () => Promise<boolean>;
  /** Re-read permission + existing subscription (e.g. on mount). */
  refresh: () => Promise<void>;
  /**
   * One-time auto-prompt: the FIRST time a supported browser loads the app (and
   * permission is still "default"), ask + subscribe. Guarded by a localStorage
   * flag so we never nag — if the user dismisses/denies, they can still use the
   * manual toggle later. No-op when unsupported / already decided / already asked.
   */
  maybeAutoPrompt: () => Promise<void>;
}

/** localStorage flag so the first-visit auto-prompt fires at most once per browser. */
const AUTO_PROMPT_KEY = "billy.push.autoPrompted";

export const usePushNotifications = (): UsePushNotifications => {
  const supported = isPushSupported();
  const permission = ref<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "default",
  );
  const isSubscribed = ref(false);
  const busy = ref(false);

  /**
   * `navigator.serviceWorker.ready` NEVER resolves when no service worker will
   * ever control the page (SW registration disabled/failed, e.g. dev mode). That
   * would hang subscribe()/unsubscribe() forever and leave the toggle spinning.
   * Race it against a timeout so the flow always settles.
   */
  async function readyRegistration(): Promise<ServiceWorkerRegistration> {
    return Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("service worker not ready (registration unavailable)")), 8000),
      ),
    ]);
  }

  async function refresh(): Promise<void> {
    if (!supported) return;
    permission.value = Notification.permission;
    try {
      const reg = await readyRegistration();
      const sub = await reg.pushManager.getSubscription();
      isSubscribed.value = sub !== null;
    } catch {
      isSubscribed.value = false;
    }
  }

  async function subscribe(): Promise<boolean> {
    if (!supported || busy.value) return false;
    busy.value = true;
    try {
      const result = await Notification.requestPermission();
      permission.value = result;
      if (result !== "granted") return false;

      const reg = await readyRegistration();
      const existing = await reg.pushManager.getSubscription();
      const sub =
        existing ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(getConfig().VAPID_PUBLIC_KEY),
        }));

      // POST the browser PushSubscription JSON (endpoint + keys{p256dh,auth}) —
      // matches the /api/v1/push/subscribe request schema.
      await post("/v1/push/subscribe", sub.toJSON());
      isSubscribed.value = true;
      return true;
    } catch {
      return false;
    } finally {
      busy.value = false;
    }
  }

  async function unsubscribe(): Promise<boolean> {
    if (!supported || busy.value) return false;
    busy.value = true;
    try {
      const reg = await readyRegistration();
      const sub = await reg.pushManager.getSubscription();
      if (!sub) {
        isSubscribed.value = false;
        return true;
      }
      const { endpoint } = sub;
      await sub.unsubscribe();
      await post("/v1/push/unsubscribe", { endpoint });
      isSubscribed.value = false;
      return true;
    } catch {
      return false;
    } finally {
      busy.value = false;
    }
  }

  async function maybeAutoPrompt(): Promise<void> {
    if (!supported) return;
    // Only on a browser that has never been asked by us AND hasn't already decided.
    if (Notification.permission !== "default") return;
    try {
      if (localStorage.getItem(AUTO_PROMPT_KEY)) return;
      localStorage.setItem(AUTO_PROMPT_KEY, "1");
    } catch {
      // localStorage unavailable (private mode) — still fine to prompt once.
    }
    // subscribe() requests permission + subscribes; if the user declines, it just
    // returns false and the manual toggle remains available.
    await subscribe();
  }

  return {
    isSupported: supported,
    permission: readonly(permission),
    isSubscribed: readonly(isSubscribed),
    busy: readonly(busy),
    subscribe,
    unsubscribe,
    refresh,
    maybeAutoPrompt,
  };
};
