import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "@billy/shared";
import type { NotificationJob } from "@billy/types";
import type { ProcessorContext } from "@/processors.js";

/**
 * Worker push handler test. `web-push` + `mongodb` are mocked (no live push
 * service / DB). Because the handler configures VAPID once at module level, each
 * test re-imports the module fresh (`vi.resetModules()` + dynamic import) so the
 * "disabled once" / "configured once" state doesn't leak between cases.
 */

// ── web-push mock ─────────────────────────────────────────────────────────────
const setVapidDetails = vi.fn();
const sendNotification = vi.fn();
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}));

// ── mongodb mock: notification doc + subscription list + prune capture ─────────
let notificationDoc: Record<string, unknown> | null = null;
let subscriptionDocs: Array<Record<string, unknown>> = [];
const deletedEndpoints: string[] = [];

const deleteOne = vi.fn(async (filter: { endpoint: string }) => {
  deletedEndpoints.push(filter.endpoint);
  return { deletedCount: 1 };
});

const makeCollection = (name: string) => {
  return {
    findOne: vi.fn(async () => (name === "notifications" ? notificationDoc : null)),
    find: vi.fn(() => ({ toArray: async () => subscriptionDocs })),
    deleteOne,
  };
};

vi.mock("mongodb", () => {
  class MongoClient {
    db() {
      return { collection: (name: string) => makeCollection(name) };
    }
  }
  return { MongoClient };
});

const stubCtx = (): ProcessorContext => {
  const noop = vi.fn();
  const logger = { info: noop, error: noop, warn: noop, debug: noop } as unknown as Logger;
  return { logger };
};

const VAPID_KEYS = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "MONGO_URI"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of VAPID_KEYS) saved[k] = process.env[k];

const setVapidEnv = (): void => {
  process.env.VAPID_PUBLIC_KEY = "test-public-key";
  process.env.VAPID_PRIVATE_KEY = "test-private-key";
  process.env.VAPID_SUBJECT = "mailto:admin@billy.local";
  process.env.MONGO_URI = "mongodb://localhost:27017/billy-test";
};

const loadHandler = async () => {
  vi.resetModules();
  const mod = await import("@/handlers/push.js");
  return mod.pushHandler;
};

const JOB: NotificationJob = {
  userId: "user_1",
  eventType: "invoice.paid",
  entityId: "inv_1",
  accountId: "biz_1",
};

beforeEach(() => {
  setVapidDetails.mockClear();
  sendNotification.mockReset();
  deleteOne.mockClear();
  deletedEndpoints.length = 0;
  notificationDoc = null;
  subscriptionDocs = [];
});

afterEach(() => {
  for (const k of VAPID_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("pushHandler — web push fan-out", () => {
  it("sends the SW payload to EACH subscription with title/body/data.url", async () => {
    setVapidEnv();
    notificationDoc = {
      title: "Invoice paid",
      body: "INV-1 was paid",
      entityType: "invoice",
      entityId: "inv_1",
      type: "invoice.paid",
    };
    subscriptionDocs = [
      { endpoint: "https://push.example/a", keys: { p256dh: "pa", auth: "aa" } },
      { endpoint: "https://push.example/b", keys: { p256dh: "pb", auth: "ab" } },
    ];
    sendNotification.mockResolvedValue({ statusCode: 201 });

    const pushHandler = await loadHandler();
    const result = await pushHandler(JOB, stubCtx());

    expect(setVapidDetails).toHaveBeenCalledWith(
      "mailto:admin@billy.local",
      "test-public-key",
      "test-private-key",
    );
    expect(sendNotification).toHaveBeenCalledTimes(2);
    // Payload shape the SW consumes.
    const [sub, serialized] = sendNotification.mock.calls[0]!;
    expect(sub).toEqual({ endpoint: "https://push.example/a", keys: { p256dh: "pa", auth: "aa" } });
    const payload = JSON.parse(serialized as string) as {
      title: string;
      body: string;
      data: { url: string };
    };
    expect(payload).toEqual({
      title: "Invoice paid",
      body: "INV-1 was paid",
      data: { url: "/invoices/inv_1" },
    });
    expect(result).toEqual({ sent: 2, pruned: 0, total: 2 });
    expect(deleteOne).not.toHaveBeenCalled();
  });

  it("PRUNES a subscription on a 410 (Gone) and keeps sending to the rest", async () => {
    setVapidEnv();
    notificationDoc = { title: "T", body: "B", entityType: "invoice", entityId: "inv_1", type: "invoice.paid" };
    subscriptionDocs = [
      { endpoint: "https://push.example/dead", keys: { p256dh: "p1", auth: "a1" } },
      { endpoint: "https://push.example/live", keys: { p256dh: "p2", auth: "a2" } },
    ];
    sendNotification
      .mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 }))
      .mockResolvedValueOnce({ statusCode: 201 });

    const pushHandler = await loadHandler();
    const result = await pushHandler(JOB, stubCtx());

    expect(deleteOne).toHaveBeenCalledTimes(1);
    expect(deletedEndpoints).toEqual(["https://push.example/dead"]);
    expect(result).toEqual({ sent: 1, pruned: 1, total: 2 });
  });

  it("logs + continues (does NOT prune) on a non-Gone send error", async () => {
    setVapidEnv();
    notificationDoc = { title: "T", body: "B", entityType: "invoice", entityId: "inv_1", type: "invoice.paid" };
    subscriptionDocs = [
      { endpoint: "https://push.example/err", keys: { p256dh: "p1", auth: "a1" } },
      { endpoint: "https://push.example/ok", keys: { p256dh: "p2", auth: "a2" } },
    ];
    sendNotification
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { statusCode: 500 }))
      .mockResolvedValueOnce({ statusCode: 201 });

    const pushHandler = await loadHandler();
    const result = await pushHandler(JOB, stubCtx());

    expect(deleteOne).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 1, pruned: 0, total: 2 });
  });

  it("no-ops (disabled) when VAPID keys are absent — never throws", async () => {
    // No VAPID env set.
    for (const k of VAPID_KEYS) delete process.env[k];
    subscriptionDocs = [{ endpoint: "https://push.example/a", keys: { p256dh: "p", auth: "a" } }];

    const pushHandler = await loadHandler();
    const result = await pushHandler(JOB, stubCtx());

    expect(result).toEqual({ sent: 0, pruned: 0, total: 0, disabled: true });
    expect(setVapidDetails).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("returns early when the user has no subscriptions", async () => {
    setVapidEnv();
    notificationDoc = { title: "T", body: "B", type: "invoice.paid", entityId: "inv_1" };
    subscriptionDocs = [];

    const pushHandler = await loadHandler();
    const result = await pushHandler(JOB, stubCtx());

    expect(result).toEqual({ sent: 0, pruned: 0, total: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("falls back to a generic title from eventType when no notification doc is found", async () => {
    setVapidEnv();
    notificationDoc = null; // no matching in-app row
    subscriptionDocs = [{ endpoint: "https://push.example/a", keys: { p256dh: "p", auth: "a" } }];
    sendNotification.mockResolvedValue({ statusCode: 201 });

    const pushHandler = await loadHandler();
    await pushHandler(JOB, stubCtx());

    const [, serialized] = sendNotification.mock.calls[0]!;
    const payload = JSON.parse(serialized as string) as { title: string; body: string; data: { url: string } };
    expect(payload.title).toBe("Invoice paid"); // "invoice.paid" → "Invoice paid"
    expect(payload.body).toBe("");
    // No doc → no entityType; deep link falls back to the notification center.
    expect(payload.data.url).toBe("/notifications");
  });
});
