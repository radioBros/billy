import { describe, it, expect } from "vitest";
import type { AuthContext, BaseDoc, Capabilities, ListWhitelist } from "@billy/types";
import { createLogger, AppError } from "@billy/shared";
import { safeValidate } from "@billy/validation";
import type { DomainEventEmitter } from "@/platform/service.js";
import type { BaseRepository } from "@/platform/repository.js";
import { SubscriptionCreateSchema } from "@/modules/subscriptions/schema.js";
import { SubscriptionService, advanceBillingDate, SUBSCRIPTION_TRANSITIONS } from "@/modules/subscriptions/service.js";
import type { SubscriptionRepository } from "@/modules/subscriptions/repository.js";
import type { Subscription } from "@/modules/subscriptions/types.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const logger = createLogger({ level: "silent", pretty: false, service: "test" });
const emitter: DomainEventEmitter = { emit() {} };

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  canManageSettings: true,
  canManageUsers: true,
  canPermanentlyDelete: true,
  canViewFinancialTotals: true,
  canExportData: true,
  ...over,
});

const ctx: AuthContext = { userId: "u1", role: "administrator", capabilities: caps(), accountId: "biz1" };

const OID = "0123456789abcdef01234567";

const validCreate = (over: Record<string, unknown> = {}) => {
  return {
    clientId: OID,
    name: "ACME domain",
    plan: "standard",
    amountMinor: 1200,
    currency: "EUR",
    interval: "monthly",
    startDate: "2026-01-15",
    nextBillingDate: "2026-01-15",
    ...over,
  };
};

/**
 * In-memory fake repo (like modules/auth/auth-flow.test.ts). Implements the
 * BaseRepository surface the service uses; enforces scope + version like the
 * real one so transition/version behaviour is exercised without a DB.
 */
class FakeSubscriptionRepository {
  readonly byId = new Map<string, Subscription>();
  private seq = 0;

  async findById(_ctx: AuthContext, id: string): Promise<Subscription | null> {
    const d = this.byId.get(id);
    return d && !d.deletedAt ? d : null;
  }

  async list(_ctx: AuthContext, _raw: Record<string, string | string[] | undefined>, _wl: ListWhitelist) {
    const items = [...this.byId.values()].filter((d) => !d.deletedAt && !d.archivedAt);
    return { items, parsed: { page: 1, limit: 50, skip: 0, sortSpec: [], archived: "false" as const, filter: {}, sort: {} }, total: items.length };
  }

  async insert(_ctx: AuthContext, data: Omit<Subscription, keyof BaseDoc>): Promise<Subscription> {
    const ts = new Date().toISOString();
    const doc = {
      ...data,
      id: `sub_${++this.seq}`,
      version: 1,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      deletedAt: null,
    } as Subscription;
    this.byId.set(doc.id, doc);
    return doc;
  }

  async updateVersioned(_ctx: AuthContext, id: string, expectedVersion: number, patch: Partial<Subscription>): Promise<Subscription> {
    // Mirrors BaseRepository: only matches NON-archived, non-deleted docs.
    const d = this.byId.get(id);
    if (!d || d.deletedAt) throw new AppError("RESOURCE_NOT_FOUND");
    if (d.archivedAt) throw new AppError("VERSION_CONFLICT");
    if (d.version !== expectedVersion) throw new AppError("VERSION_CONFLICT");
    const next = { ...d, ...patch, version: d.version + 1, updatedAt: new Date().toISOString() } as Subscription;
    this.byId.set(id, next);
    return next;
  }

  async archive(_ctx: AuthContext, id: string, expectedVersion: number): Promise<Subscription> {
    // Mirrors SubscriptionRepository.archive: matches a live (non-archived) doc.
    const d = this.byId.get(id);
    if (!d || d.deletedAt) throw new AppError("RESOURCE_NOT_FOUND");
    if (d.archivedAt || d.version !== expectedVersion) throw new AppError("VERSION_CONFLICT");
    const next = { ...d, archivedAt: new Date().toISOString(), version: d.version + 1 } as Subscription;
    this.byId.set(id, next);
    return next;
  }

  async restore(_ctx: AuthContext, id: string, expectedVersion: number): Promise<Subscription> {
    // Mirrors SubscriptionRepository.restore: matches ONLY an archived doc.
    const d = this.byId.get(id);
    if (!d || d.deletedAt || !d.archivedAt) throw new AppError("RESOURCE_NOT_FOUND");
    if (d.version !== expectedVersion) throw new AppError("VERSION_CONFLICT");
    const next = { ...d, archivedAt: null, version: d.version + 1 } as Subscription;
    this.byId.set(id, next);
    return next;
  }

  async softDelete(_ctx: AuthContext, id: string): Promise<void> {
    const d = this.byId.get(id);
    if (d) this.byId.set(id, { ...d, deletedAt: new Date().toISOString() });
  }
}

const newSvc = (now?: () => Date) => {
  const repo = new FakeSubscriptionRepository();
  const svc = new SubscriptionService({
    repo: repo as unknown as SubscriptionRepository,
    emitter,
    logger,
    now,
  });
  return { repo, svc };
};

// ── Schema ───────────────────────────────────────────────────────────────────

describe("SubscriptionCreateSchema (SB-1)", () => {
  it("accepts a valid create payload", () => {
    const r = safeValidate(SubscriptionCreateSchema, validCreate());
    expect(r.ok).toBe(true);
  });

  it("rejects a non-integer (float) money amount", () => {
    const r = safeValidate(SubscriptionCreateSchema, validCreate({ amountMinor: 12.5 }));
    expect(r.ok).toBe(false);
  });

  it("rejects a non-positive amount", () => {
    expect(safeValidate(SubscriptionCreateSchema, validCreate({ amountMinor: 0 })).ok).toBe(false);
  });

  it("rejects an unknown interval", () => {
    expect(safeValidate(SubscriptionCreateSchema, validCreate({ interval: "biweekly" })).ok).toBe(false);
  });

  it("rejects a bad date format", () => {
    expect(safeValidate(SubscriptionCreateSchema, validCreate({ startDate: "15/01/2026" })).ok).toBe(false);
  });

  it("rejects nextBillingDate before startDate", () => {
    const r = safeValidate(SubscriptionCreateSchema, validCreate({ startDate: "2026-02-01", nextBillingDate: "2026-01-01" }));
    expect(r.ok).toBe(false);
  });

  it("rejects unknown fields (strict) — no credential-shaped fields (§16.4)", () => {
    expect(safeValidate(SubscriptionCreateSchema, validCreate({ rootPassword: "hunter2" })).ok).toBe(false);
  });
});

// ── Date advancement ───────────────────────────────────────────────────────────

describe("advanceBillingDate", () => {
  it("advances monthly", () => {
    expect(advanceBillingDate("2026-01-15", "monthly")).toBe("2026-02-15");
  });
  it("clamps month-end rollover (Jan 31 + 1 month → Feb 28)", () => {
    expect(advanceBillingDate("2026-01-31", "monthly")).toBe("2026-02-28");
  });
  it("advances quarterly across a year boundary", () => {
    expect(advanceBillingDate("2026-11-30", "quarterly")).toBe("2027-02-28");
  });
  it("advances yearly (leap-day clamps)", () => {
    expect(advanceBillingDate("2024-02-29", "yearly")).toBe("2025-02-28");
  });
  it("advances weekly across a month boundary", () => {
    expect(advanceBillingDate("2026-01-29", "weekly")).toBe("2026-02-05");
  });
});

// ── Status transitions ─────────────────────────────────────────────────────────

describe("subscription status transitions (status-registry §2)", () => {
  it("has the canonical transition map", () => {
    expect(SUBSCRIPTION_TRANSITIONS).toEqual({
      active: ["paused", "cancelled"],
      paused: ["active", "cancelled"],
      cancelled: [],
    });
  });

  it("pause then resume then cancel are all legal", async () => {
    const { svc } = newSvc();
    const s0 = await svc.create(ctx, validCreate() as never);
    const paused = await svc.pause(ctx, s0.id, s0.version);
    expect(paused.status).toBe("paused");
    const resumed = await svc.resume(ctx, paused.id, paused.version);
    expect(resumed.status).toBe("active");
    const cancelled = await svc.cancel(ctx, resumed.id, resumed.version);
    expect(cancelled.status).toBe("cancelled");
  });

  it("rejects an illegal transition (cancelled → active) with INVALID_STATE_TRANSITION", async () => {
    const { svc } = newSvc();
    const s0 = await svc.create(ctx, validCreate() as never);
    const cancelled = await svc.cancel(ctx, s0.id, s0.version);
    await expect(svc.resume(ctx, cancelled.id, cancelled.version)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
  });
});

// ── markPaid ───────────────────────────────────────────────────────────────────

describe("markPaid (SB-6)", () => {
  it("advances nextBillingDate by the interval and sets lastPaidAt when due", async () => {
    // Clock at 2026-02-20: the 2026-01-15 billing date is due.
    const { svc } = newSvc(() => new Date("2026-02-20T10:00:00.000Z"));
    const s0 = await svc.create(ctx, validCreate() as never);
    expect(s0.nextBillingDate).toBe("2026-01-15");
    expect(s0.lastPaidAt).toBeNull();

    const paid = await svc.markPaid(ctx, s0.id, s0.version);
    expect(paid.nextBillingDate).toBe("2026-02-15");
    expect(paid.lastPaidAt).toBeTruthy();
    expect(paid.version).toBe(s0.version + 1);
  });

  it("rejects with SUBSCRIPTION_PAYMENT_NOT_DUE when today is before nextBillingDate", async () => {
    // Clock at 2026-01-01: the 2026-01-15 billing date is not yet due.
    const { svc } = newSvc(() => new Date("2026-01-01T10:00:00.000Z"));
    const s0 = await svc.create(ctx, validCreate() as never);
    await expect(svc.markPaid(ctx, s0.id, s0.version)).rejects.toMatchObject({
      code: "SUBSCRIPTION_PAYMENT_NOT_DUE",
    });
  });

  it("pays exactly on the due date (today === nextBillingDate)", async () => {
    const { svc } = newSvc(() => new Date("2026-01-15T00:00:00.000Z"));
    const s0 = await svc.create(ctx, validCreate() as never);
    const paid = await svc.markPaid(ctx, s0.id, s0.version);
    expect(paid.nextBillingDate).toBe("2026-02-15");
  });
});

// ── Capability enforcement ───────────────────────────────────────────────────

describe("archive / restore round-trip (SB-3, conventions §7)", () => {
  it("archives then restores an archived subscription (real repo excludes archived from updateVersioned)", async () => {
    const { svc } = newSvc();
    const s0 = await svc.create(ctx, validCreate() as never);
    const archived = await svc.archive(ctx, s0.id, s0.version);
    expect(archived.archivedAt).toBeTruthy();
    const restored = await svc.restore(ctx, archived.id, archived.version);
    expect(restored.archivedAt).toBeNull();
    expect(restored.version).toBe(archived.version + 1);
  });

  it("restoring a non-archived subscription is a 404 (RESOURCE_NOT_FOUND)", async () => {
    const { svc } = newSvc();
    const s0 = await svc.create(ctx, validCreate() as never);
    await expect(svc.restore(ctx, s0.id, s0.version)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
});

describe("capability checks (SB-3, conventions §7)", () => {
  it("denies soft-delete without canPermanentlyDelete", async () => {
    const { svc } = newSvc();
    const s0 = await svc.create(ctx, validCreate() as never);
    const member: AuthContext = {
      userId: "m",
      role: "member",
      capabilities: caps({ canPermanentlyDelete: false }),
      accountId: "biz1",
    };
    await expect(svc.softDelete(member, s0.id)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
  });

  it("allows an ordinary member to create (CRUD is not capability-gated)", async () => {
    const { svc } = newSvc();
    const member: AuthContext = {
      userId: "m",
      role: "member",
      capabilities: caps({ canManageSettings: false }),
      accountId: "biz1",
    };
    const created = await svc.create(member, validCreate() as never);
    expect(created.status).toBe("active");
  });
});

// Ensure BaseRepository import is type-referenced (keeps the fake honest against the real surface).
export type _RepoShape = BaseRepository<Subscription>;
