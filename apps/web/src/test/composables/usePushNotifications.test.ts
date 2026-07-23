import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isPushSupported, urlBase64ToUint8Array, usePushNotifications } from "@/composables/usePushNotifications";

// Mock the api client so subscribe/unsubscribe don't hit the network.
const post = vi.fn<(path: string, body?: unknown) => Promise<unknown>>(async () => ({}));
vi.mock("@/api/client", () => ({ post: (path: string, body?: unknown) => post(path, body) }));

const installServiceWorker = (opts: {
  existing?: { toJSON: () => unknown; endpoint: string; unsubscribe: () => Promise<boolean> } | null;
  subscribeResult?: { toJSON: () => unknown; endpoint: string };
}): { subscribe: ReturnType<typeof vi.fn>; getSubscription: ReturnType<typeof vi.fn> } => {
  const getSubscription = vi.fn(async () => opts.existing ?? null);
  const subscribe = vi.fn(async () => opts.subscribeResult);
  const registration = { pushManager: { getSubscription, subscribe } };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve(registration) },
  });
  return { subscribe, getSubscription };
};

const VAPID = "BEIMOs4gGYAp5wDHXA920kZOb3nwTSD3mKn7lBnwFWpIdG6Z3xxbLjeZJl0ye5Rnlew8IcrfZais_DSetCuNuzM";

beforeEach(() => {
  post.mockClear();
  // Provide the PushManager + Notification globals the gate looks for.
  (window as unknown as { PushManager?: unknown }).PushManager = class {};
  (globalThis as unknown as { Notification?: unknown }).Notification = Object.assign(
    function Notification(): void {},
    { permission: "default" as NotificationPermission, requestPermission: vi.fn(async () => "granted" as const) },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isPushSupported", () => {
  it("is false when the VAPID key is empty", () => {
    window.__APP_CONFIG__ = { VAPID_PUBLIC_KEY: "" };
    expect(isPushSupported()).toBe(false);
  });

  it("is true with SW + PushManager + a configured VAPID key", () => {
    window.__APP_CONFIG__ = { VAPID_PUBLIC_KEY: VAPID };
    installServiceWorker({ existing: null });
    expect(isPushSupported()).toBe(true);
  });

  it("is false when PushManager is absent even with a VAPID key", () => {
    window.__APP_CONFIG__ = { VAPID_PUBLIC_KEY: VAPID };
    delete (window as unknown as { PushManager?: unknown }).PushManager;
    expect(isPushSupported()).toBe(false);
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodes a URL-safe base64 VAPID key to bytes", () => {
    const out = urlBase64ToUint8Array(VAPID);
    expect(out).toBeInstanceOf(Uint8Array);
    // P-256 uncompressed public keys are 65 bytes.
    expect(out.length).toBe(65);
    expect(out[0]).toBe(0x04);
  });
});

describe("usePushNotifications.subscribe", () => {
  it("requests permission, subscribes, and POSTs the subscription JSON", async () => {
    window.__APP_CONFIG__ = { VAPID_PUBLIC_KEY: VAPID };
    const subJson = { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } };
    const { subscribe: pushSubscribe } = installServiceWorker({
      existing: null,
      subscribeResult: { toJSON: () => subJson, endpoint: subJson.endpoint },
    });

    const push = usePushNotifications();
    const ok = await push.subscribe();

    expect(ok).toBe(true);
    expect(pushSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) }),
    );
    expect(post).toHaveBeenCalledWith("/v1/push/subscribe", subJson);
    expect(push.isSubscribed.value).toBe(true);
  });

  it("does nothing and returns false when permission is denied", async () => {
    window.__APP_CONFIG__ = { VAPID_PUBLIC_KEY: VAPID };
    (globalThis.Notification as unknown as { requestPermission: () => Promise<string> }).requestPermission =
      vi.fn(async () => "denied");
    installServiceWorker({ existing: null });

    const push = usePushNotifications();
    const ok = await push.subscribe();

    expect(ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
    expect(push.permission.value).toBe("denied");
  });

  it("subscribe() is a no-op when push is unsupported (no VAPID key)", async () => {
    window.__APP_CONFIG__ = { VAPID_PUBLIC_KEY: "" };
    const push = usePushNotifications();
    expect(push.isSupported).toBe(false);
    const ok = await push.subscribe();
    expect(ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("usePushNotifications.unsubscribe", () => {
  it("unsubscribes locally and POSTs the endpoint", async () => {
    window.__APP_CONFIG__ = { VAPID_PUBLIC_KEY: VAPID };
    const localUnsub = vi.fn(async () => true);
    installServiceWorker({
      existing: { toJSON: () => ({}), endpoint: "https://push.example/abc", unsubscribe: localUnsub },
    });

    const push = usePushNotifications();
    const ok = await push.unsubscribe();

    expect(ok).toBe(true);
    expect(localUnsub).toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith("/v1/push/unsubscribe", { endpoint: "https://push.example/abc" });
    expect(push.isSubscribed.value).toBe(false);
  });
});
