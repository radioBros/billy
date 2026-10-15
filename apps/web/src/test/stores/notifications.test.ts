import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import {
  isRawEntityRef,
  notificationBody,
  notificationTitle,
  useNotificationsStore,
  type NotificationTranslate,
} from "@/stores/notifications";
import { i18n, setI18nLocale } from "@/plugins/i18n";
import type { Notification, WsEvent } from "@/types/domain";

const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

const notif = (over: Partial<Notification> = {}): Notification => {
  return {
    id: over.id ?? "n1",
    userId: "u1",
    category: "invoices",
    type: "invoice.paid",
    severity: "info",
    title: "Invoice paid",
    body: "invoice inv1",
    entityType: "invoice",
    entityId: "inv1",
    readAt: null,
    metadata: null,
    version: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    ...over,
  };
};

const listEnvelope = (items: Notification[]): Response => {
  return jsonResponse({ data: items, meta: { total: items.length }, error: null });
};

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notifications store", () => {
  it("seeds the list + unread count from REST", async () => {
    const unread = notif({ id: "n1", readAt: null });
    const read = notif({ id: "n2", readAt: "2026-01-02T00:00:00.000Z" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/unread-count")) {
        return jsonResponse({ data: { count: 1 }, meta: {}, error: null });
      }
      return listEnvelope([unread, read]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = useNotificationsStore();
    await store.seed();

    expect(store.items).toHaveLength(2);
    expect(store.unreadCount).toBe(1);
    expect(store.seeded).toBe(true);
  });

  it("increments on a simulated WS notification.created event", async () => {
    // Seed round 0: one unread. The WS event triggers a reseed (round 1) where
    // the server now reports two unread — the store is authoritative from REST.
    let round = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/unread-count")) {
        return jsonResponse({ data: { count: round === 0 ? 1 : 2 }, meta: {}, error: null });
      }
      // A list request marks the start of a seed round; bump AFTER building.
      const items =
        round === 0 ? [notif({ id: "n1" })] : [notif({ id: "n2" }), notif({ id: "n1" })];
      return listEnvelope(items);
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = useNotificationsStore();
    await store.seed();
    expect(store.unreadCount).toBe(1);
    round = 1;

    const evt: WsEvent = {
      eventId: "e1",
      eventType: "notification.created",
      entityType: "notification",
      entityId: "n2",
      timestamp: "2026-01-03T00:00:00.000Z",
      payload: { userId: "u1" },
    };
    store.ingest(evt);
    // ingest triggers an async reseed; await a microtask flush.
    await vi.waitFor(() => expect(store.unreadCount).toBe(2));
    expect(store.items).toHaveLength(2);
  });

  it("ignores non-notification WS events", async () => {
    const fetchMock = vi.fn(async () => listEnvelope([]));
    vi.stubGlobal("fetch", fetchMock);
    const store = useNotificationsStore();

    store.ingest({
      eventId: "e2",
      eventType: "invoice.updated",
      entityType: "invoice",
      entityId: "inv9",
      timestamp: "2026-01-03T00:00:00.000Z",
      payload: {},
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("markRead optimistically flips readAt and posts to the read endpoint", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/n1/read")) {
        return jsonResponse({
          data: notif({ id: "n1", readAt: "2026-01-04T00:00:00.000Z" }),
          meta: {},
          error: null,
        });
      }
      return jsonResponse({ data: { count: 0 }, meta: {}, error: null });
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = useNotificationsStore();
    store.items = [notif({ id: "n1", readAt: null })];
    store.unreadCount = 1;

    await store.markRead("n1");

    expect(store.items[0]?.readAt).not.toBeNull();
    expect(store.unreadCount).toBe(0);
    const readCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/n1/read"));
    expect(readCall).toBeDefined();
    expect((readCall?.[1] as unknown as RequestInit).method).toBe("POST");
  });

  it("clear() empties state (logout)", () => {
    const store = useNotificationsStore();
    store.items = [notif()];
    store.unreadCount = 3;
    store.clear();
    expect(store.items).toHaveLength(0);
    expect(store.unreadCount).toBe(0);
    expect(store.seeded).toBe(false);
  });
});

// ── Display text: never a raw id ─────────────────────────────────────────────

describe("notification display text", () => {
  const HEX = "6a5e57c282ed0a773ca0f182";
  const t: NotificationTranslate = (key, params) => i18n.global.t(key, params ?? {});
  afterEach(() => setI18nLocale("en"));

  /** Legacy doc as stored before human labels: params.entity = "invoice <hex>". */
  const legacy = (over: Partial<Notification> = {}): Notification =>
    notif({
      type: "invoice.paid",
      title: "Invoice Paid",
      body: `invoice ${HEX}`,
      titleKey: "notification.event.invoice.paid.title",
      bodyKey: "notification.event.invoice.paid.body",
      params: { entity: `invoice ${HEX}`, entityType: "invoice", entityId: HEX },
      entityId: HEX,
      ...over,
    });

  it("detects raw entity references", () => {
    expect(isRawEntityRef(`invoice ${HEX}`)).toBe(true);
    expect(isRawEntityRef(HEX)).toBe(true);
    expect(isRawEntityRef("recurring_profile 6a5e57c282ed0a773ca0f1aa")).toBe(true);
    expect(isRawEntityRef("INV-2026-0001")).toBe(false);
    expect(isRawEntityRef("")).toBe(false);
  });

  it("renders a human label from params.entity", () => {
    const n = legacy({ params: { entity: "INV-2026-0007", entityType: "invoice", entityId: HEX } });
    expect(notificationTitle(t, n)).toBe("Invoice paid");
    expect(notificationBody(t, n)).toBe("Invoice INV-2026-0007 was paid in full");
  });

  it("drops a legacy raw id from the sentence (en + it)", () => {
    expect(notificationBody(t, legacy())).toBe("Invoice was paid in full");
    setI18nLocale("it");
    const body = notificationBody(t, legacy());
    expect(body).toBe("La fattura è stata pagata per intero");
    expect(body).not.toContain(HEX);
  });

  it("translates the draft marker", () => {
    const n = legacy({ params: { entity: "Draft", entityDraft: "1", entityType: "invoice", entityId: HEX } });
    setI18nLocale("it");
    expect(notificationBody(t, n)).not.toContain("Draft");
  });

  it("an event without a catalog key + raw stored body falls back to the generic text with the entity type", () => {
    const n = legacy({
      type: "recurring.something_new",
      title: "Recurring Something New",
      body: `recurring_profile ${HEX}`,
      titleKey: "notification.event.recurring.something_new.title",
      bodyKey: "notification.event.recurring.something_new.body",
      params: { entity: `recurring_profile ${HEX}`, entityType: "recurring_profile", entityId: HEX },
      entityType: "recurring_profile",
    });
    expect(notificationTitle(t, n)).toBe("Recurring Something New");
    expect(notificationBody(t, n)).toBe("Update for Recurring profile");
  });
});
