import { describe, it, expect } from "vitest";
import type { Collection } from "mongodb";
import { createLogger } from "@billy/shared";
import type { AuthContext, BaseDoc } from "@billy/types";
import type { DomainEvent, DomainEventEmitter } from "@/platform/service.js";
import { NotificationRepository, NotificationPreferencesRepository } from "@/modules/notifications/repository.js";
import { NotificationService, categoryForEvent } from "@/modules/notifications/service.js";
import type { Notification, NotificationPreferences } from "@/modules/notifications/types.js";

// ── Test doubles ─────────────────────────────────────────────────────────────

const logger = createLogger({ level: "silent", pretty: false, service: "test" });

const newEmitter = (): { emitter: DomainEventEmitter; events: DomainEvent[] } => {
  const events: DomainEvent[] = [];
  return { emitter: { emit: (e) => void events.push(e) }, events };
};

const ctxFor = (userId: string): AuthContext => {
  return {
    userId,
    role: "member",
    capabilities: {
      canManageSettings: false,
      canManageUsers: false,
      canPermanentlyDelete: false,
      canViewFinancialTotals: false,
      canExportData: false,
    },
    accountId: "default", // shared across users on purpose
  };
};

const ALICE = ctxFor("u-alice");
const BOB = ctxFor("u-bob");

/**
 * In-memory NotificationRepository. Extends the real class (its `collection` is
 * protected, so a structural fake cannot satisfy BaseRepository<Notification>),
 * passing a dummy collection to super and overriding every method against a Map.
 * Every override filters by `ctx.userId` — mirroring the real userId scoping.
 */
class FakeNotificationRepository extends NotificationRepository {
  readonly byId = new Map<string, Notification>();
  private seq = 0;

  constructor() {
    super(undefined as unknown as Collection<Notification>);
  }

  private mine(ctx: AuthContext): Notification[] {
    return [...this.byId.values()].filter((n) => n.userId === ctx.userId && !n.deletedAt);
  }

  override async findById(ctx: AuthContext, id: string): Promise<Notification | null> {
    const doc = this.byId.get(id);
    return doc && doc.userId === ctx.userId && !doc.deletedAt ? doc : null;
  }

  override async insert(
    ctx: AuthContext,
    data: Omit<Notification, keyof BaseDoc | "userId">,
  ): Promise<Notification> {
    const ts = new Date().toISOString();
    const doc = {
      ...(data as object),
      userId: ctx.userId,
      id: `n-${++this.seq}`,
      version: 1,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      deletedAt: null,
    } as Notification;
    this.byId.set(doc.id, doc);
    return doc;
  }

  override async list(
    ctx: AuthContext,
  ): Promise<{ items: Notification[]; parsed: never; total: number }> {
    // Unread-first: unread (readAt null) before read, then newest first.
    const items = this.mine(ctx).sort((a, b) => {
      const ar = a.readAt ? 1 : 0;
      const br = b.readAt ? 1 : 0;
      if (ar !== br) return ar - br;
      return b.createdAt.localeCompare(a.createdAt);
    });
    const parsed = {
      page: 1,
      limit: 50,
      skip: 0,
      sortSpec: [],
      archived: "false",
      filter: {},
      sort: {},
    } as unknown as never;
    return { items, parsed, total: items.length };
  }

  override async countUnread(ctx: AuthContext): Promise<number> {
    return this.mine(ctx).filter((n) => !n.readAt).length;
  }

  override async markRead(ctx: AuthContext, id: string): Promise<Notification | null> {
    const doc = this.byId.get(id);
    if (!doc || doc.userId !== ctx.userId || doc.deletedAt) return null;
    if (!doc.readAt) {
      const next = { ...doc, readAt: new Date().toISOString() } as Notification;
      this.byId.set(id, next);
      return next;
    }
    return doc; // idempotent
  }

  override async markAllRead(ctx: AuthContext): Promise<number> {
    let n = 0;
    for (const doc of this.mine(ctx)) {
      if (!doc.readAt) {
        this.byId.set(doc.id, { ...doc, readAt: new Date().toISOString() });
        n++;
      }
    }
    return n;
  }
}

/** In-memory preferences store keyed by userId. */
class FakePreferencesRepository extends NotificationPreferencesRepository {
  readonly byUser = new Map<string, NotificationPreferences>();

  constructor() {
    super(undefined as unknown as Collection<NotificationPreferences>);
  }

  override async findForUser(ctx: AuthContext): Promise<NotificationPreferences | null> {
    return this.byUser.get(ctx.userId) ?? null;
  }

  override async upsertForUser(
    ctx: AuthContext,
    categories: NotificationPreferences["categories"],
  ): Promise<NotificationPreferences> {
    const ts = new Date().toISOString();
    const existing = this.byUser.get(ctx.userId);
    const doc: NotificationPreferences = existing
      ? { ...existing, categories: { ...existing.categories, ...categories }, version: existing.version + 1, updatedAt: ts }
      : {
          id: `p-${ctx.userId}`,
          userId: ctx.userId,
          categories,
          version: 1,
          createdAt: ts,
          updatedAt: ts,
          archivedAt: null,
          deletedAt: null,
        };
    this.byUser.set(ctx.userId, doc);
    return doc;
  }
}

const newService = () => {
  const repo = new FakeNotificationRepository();
  const prefsRepo = new FakePreferencesRepository();
  const { emitter, events } = newEmitter();
  const svc = new NotificationService({ repo, prefsRepo, emitter, logger });
  return { repo, prefsRepo, svc, events };
};

const eventOf = (name: string, entityId = "e-1"): DomainEvent => {
  return {
    name,
    actorId: "u-actor",
    entityType: name.split(".")[0]!,
    entityId,
    payload: { foo: "bar" },
  };
};

// ── categoryForEvent (event name prefix → plural category) ───────────────────

describe("categoryForEvent", () => {
  it("maps singular event prefixes to plural categories", () => {
    expect(categoryForEvent("invoice.paid")).toBe("invoices");
    expect(categoryForEvent("quote.sent")).toBe("quotes");
    expect(categoryForEvent("recurring.invoice_generated")).toBe("recurring_billing");
    expect(categoryForEvent("subscription.expired")).toBe("subscriptions");
    expect(categoryForEvent("system.backup_failed")).toBe("system");
  });

  it("falls back to system for unmapped prefixes (client.*, auth.*)", () => {
    expect(categoryForEvent("client.created")).toBe("system");
    expect(categoryForEvent("auth.login")).toBe("system");
  });
});

// ── createFromEvent ──────────────────────────────────────────────────────────

describe("createFromEvent", () => {
  it("creates one in-app notification per recipient, owned by the recipient (not the actor)", async () => {
    const { svc, repo } = newService();
    const created = await svc.createFromEvent(eventOf("invoice.paid"), [ALICE.userId, BOB.userId], "default");
    expect(created).toHaveLength(2);
    // Owner is the recipient, never the actor.
    expect(created.every((n) => n.userId === ALICE.userId || n.userId === BOB.userId)).toBe(true);
    expect(created.some((n) => n.userId === "u-actor")).toBe(false);
    expect(repo.byId.size).toBe(2);
    expect(created[0]!.category).toBe("invoices");
    expect(created[0]!.readAt).toBeNull();
    expect(created[0]!.entityId).toBe("e-1");
  });

  it("defaults in-app ON when the user has no preferences doc", async () => {
    const { svc } = newService();
    const created = await svc.createFromEvent(eventOf("quote.sent"), [ALICE.userId], "default");
    expect(created).toHaveLength(1);
  });

  it("respects an OFF in-app toggle: suppresses the notification for that category", async () => {
    const { svc, prefsRepo, repo } = newService();
    // Alice turns invoices in-app OFF; Bob leaves defaults (ON).
    await prefsRepo.upsertForUser(ALICE, { invoices: { inApp: false } });

    const created = await svc.createFromEvent(eventOf("invoice.paid"), [ALICE.userId, BOB.userId], "default");
    // Only Bob receives it.
    expect(created).toHaveLength(1);
    expect(created[0]!.userId).toBe(BOB.userId);
    expect(repo.byId.size).toBe(1);

    // A different category is NOT suppressed by the invoices toggle.
    const q = await svc.createFromEvent(eventOf("quote.sent"), [ALICE.userId], "default");
    expect(q).toHaveLength(1);
  });
});

// ── markRead / markAllRead ───────────────────────────────────────────────────

describe("markRead", () => {
  it("sets readAt on an unread notification and is idempotent", async () => {
    const { svc } = newService();
    const [n] = await svc.createFromEvent(eventOf("invoice.paid"), [ALICE.userId], "default");
    expect(n!.readAt).toBeNull();

    const read = await svc.markRead(ALICE, n!.id);
    expect(read!.readAt).toBeTruthy();

    // Idempotent — second call keeps the same readAt, still returns the doc.
    const again = await svc.markRead(ALICE, n!.id);
    expect(again!.readAt).toBe(read!.readAt);
  });

  it("returns null when marking a notification the caller does not own", async () => {
    const { svc } = newService();
    const [n] = await svc.createFromEvent(eventOf("invoice.paid"), [ALICE.userId], "default");
    // Bob cannot mark Alice's notification.
    expect(await svc.markRead(BOB, n!.id)).toBeNull();
  });

  it("markAllRead marks only the caller's unread notifications", async () => {
    const { svc } = newService();
    await svc.createFromEvent(eventOf("invoice.paid"), [ALICE.userId, ALICE.userId], "default");
    await svc.createFromEvent(eventOf("quote.sent"), [BOB.userId], "default");
    expect(await svc.unreadCount(ALICE)).toBe(2);

    const updated = await svc.markAllRead(ALICE);
    expect(updated).toBe(2);
    expect(await svc.unreadCount(ALICE)).toBe(0);
    // Bob's is untouched.
    expect(await svc.unreadCount(BOB)).toBe(1);
  });
});

// ── list scoped to userId (isolation — same accountId, different userId) ──

describe("list per-user isolation", () => {
  it("a user only sees their own notifications (scoped by userId, not accountId)", async () => {
    const { svc } = newService();
    // Both callers share accountId 'default'; only userId differs.
    await svc.createFromEvent(eventOf("invoice.paid", "inv-a"), [ALICE.userId], "default");
    await svc.createFromEvent(eventOf("quote.sent", "q-b"), [BOB.userId], "default");

    const aliceList = await svc.list(ALICE, {});
    const bobList = await svc.list(BOB, {});

    expect(aliceList.items).toHaveLength(1);
    expect(aliceList.items.every((n) => n.userId === ALICE.userId)).toBe(true);
    expect(bobList.items).toHaveLength(1);
    expect(bobList.items.every((n) => n.userId === BOB.userId)).toBe(true);
    // No cross-user leakage.
    expect(aliceList.items.some((n) => n.entityId === "q-b")).toBe(false);
  });

  it("list is unread-first", async () => {
    const { svc } = newService();
    const [first] = await svc.createFromEvent(eventOf("invoice.paid", "inv-1"), [ALICE.userId], "default");
    await svc.createFromEvent(eventOf("invoice.paid", "inv-2"), [ALICE.userId], "default");
    // Read the first one; it should sort AFTER the still-unread one.
    await svc.markRead(ALICE, first!.id);

    const { items } = await svc.list(ALICE, {});
    expect(items).toHaveLength(2);
    expect(items[0]!.readAt).toBeNull(); // unread first
    expect(items[1]!.id).toBe(first!.id);
  });
});

// ── NE8: notification.created / notification.updated domain emits ────────────

describe("NE8 domain-event emission", () => {
  it("emits notification.created with payload.userId = the RECIPIENT (not the actor)", async () => {
    const { svc, events } = newService();
    const [alice] = await svc.createFromEvent(eventOf("invoice.paid"), [ALICE.userId], "default");

    const created = events.filter((e) => e.name === "notification.created");
    expect(created).toHaveLength(1);
    const ev = created[0]!;
    expect(ev.entityType).toBe("notification");
    expect(ev.entityId).toBe(alice!.id);
    // The realtime projection routes on payload.userId — it MUST be the recipient.
    expect(ev.payload).toEqual({ userId: ALICE.userId });
    // Never the original event actor.
    expect(ev.payload!.userId).not.toBe("u-actor");
  });

  it("emits one notification.created per recipient, each carrying its own userId", async () => {
    const { svc, events } = newService();
    await svc.createFromEvent(eventOf("invoice.paid"), [ALICE.userId, BOB.userId], "default");

    const created = events.filter((e) => e.name === "notification.created");
    expect(created).toHaveLength(2);
    const recipients = created.map((e) => e.payload!.userId).sort();
    expect(recipients).toEqual([ALICE.userId, BOB.userId].sort());
  });

  it("does NOT emit notification.created when the in-app toggle suppresses the notification", async () => {
    const { svc, prefsRepo, events } = newService();
    await prefsRepo.upsertForUser(ALICE, { invoices: { inApp: false } });
    await svc.createFromEvent(eventOf("invoice.paid"), [ALICE.userId], "default");
    expect(events.filter((e) => e.name === "notification.created")).toHaveLength(0);
  });

  it("emits notification.updated on markRead with payload.userId = owner", async () => {
    const { svc, events } = newService();
    const [n] = await svc.createFromEvent(eventOf("invoice.paid"), [ALICE.userId], "default");
    await svc.markRead(ALICE, n!.id);

    const updated = events.filter((e) => e.name === "notification.updated");
    expect(updated).toHaveLength(1);
    expect(updated[0]!.entityType).toBe("notification");
    expect(updated[0]!.entityId).toBe(n!.id);
    expect(updated[0]!.payload).toEqual({ userId: ALICE.userId });
  });

  it("does NOT emit notification.updated when markRead targets a notification the caller does not own", async () => {
    const { svc, events } = newService();
    const [n] = await svc.createFromEvent(eventOf("invoice.paid"), [ALICE.userId], "default");
    await svc.markRead(BOB, n!.id); // Bob does not own it → null → no emit
    expect(events.filter((e) => e.name === "notification.updated")).toHaveLength(0);
  });
});
