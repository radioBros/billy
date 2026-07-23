import { describe, it, expect } from "vitest";
import type { Collection } from "mongodb";
import { createLogger, AppError } from "@billy/shared";
import type { AuthContext, BaseDoc } from "@billy/types";
import type { DomainEvent, DomainEventEmitter } from "@/platform/service.js";
import { RecurringProfileRepository } from "@/modules/recurring-billing/repository.js";
import { RecurringProfileService, advanceDate } from "@/modules/recurring-billing/service.js";
import { RecurringProfileCreateSchema } from "@/modules/recurring-billing/schema.js";
import { stripProfileFinancial } from "@/modules/recurring-billing/routes.js";
import type { RecurringProfile } from "@/modules/recurring-billing/types.js";

// ── Test doubles ─────────────────────────────────────────────────────────────

const logger = createLogger({ level: "silent", pretty: false, service: "test" });

const newEmitter = (): { emitter: DomainEventEmitter; events: DomainEvent[] } => {
  const events: DomainEvent[] = [];
  return { emitter: { emit: (e) => void events.push(e) }, events };
};

const ADMIN: AuthContext = {
  userId: "u-admin",
  role: "administrator",
  capabilities: {
    canManageSettings: true,
    canManageUsers: true,
    canPermanentlyDelete: true,
    canViewFinancialTotals: true,
    canExportData: true,
  },
  accountId: "default",
};

const MEMBER: AuthContext = {
  userId: "u-member",
  role: "member",
  capabilities: {
    canManageSettings: false,
    canManageUsers: false,
    canPermanentlyDelete: false,
    canViewFinancialTotals: false,
    canExportData: false,
  },
  accountId: "default",
};

const notFound = () => {
  return new AppError("RESOURCE_NOT_FOUND");
};
const versionConflict = () => {
  return new AppError("VERSION_CONFLICT");
};

/**
 * In-memory RecurringProfileRepository. Extends the real class (protected members
 * prevent a structural fake), passing a dummy collection to super and overriding
 * every public method against a Map.
 */
class FakeRecurringProfileRepository extends RecurringProfileRepository {
  readonly byId = new Map<string, RecurringProfile>();
  private seq = 0;

  constructor() {
    super(undefined as unknown as Collection<RecurringProfile>);
  }

  override async findById(_ctx: AuthContext, id: string): Promise<RecurringProfile | null> {
    const doc = this.byId.get(id);
    return doc && !doc.deletedAt ? doc : null;
  }

  override async insert(_ctx: AuthContext, data: Omit<RecurringProfile, keyof BaseDoc>): Promise<RecurringProfile> {
    const ts = new Date().toISOString();
    const doc = {
      ...(data as object),
      id: `rp-${++this.seq}`,
      version: 1,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      deletedAt: null,
    } as RecurringProfile;
    this.byId.set(doc.id, doc);
    return doc;
  }

  override async updateVersioned(
    _ctx: AuthContext,
    id: string,
    expectedVersion: number,
    patch: Partial<RecurringProfile>,
  ): Promise<RecurringProfile> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt) throw notFound();
    if (doc.archivedAt) throw notFound();
    if (doc.version !== expectedVersion) throw versionConflict();
    const next = { ...doc, ...patch, version: doc.version + 1, updatedAt: new Date().toISOString() } as RecurringProfile;
    this.byId.set(id, next);
    return next;
  }

  override async replaceState(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    patch: Partial<RecurringProfile>,
  ): Promise<RecurringProfile> {
    return this.updateVersioned(ctx, id, expectedVersion, patch);
  }

  override async archive(_ctx: AuthContext, id: string, expectedVersion: number): Promise<RecurringProfile> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt) throw notFound();
    if (doc.version !== expectedVersion) throw versionConflict();
    const next = { ...doc, archivedAt: new Date().toISOString(), version: doc.version + 1 } as RecurringProfile;
    this.byId.set(id, next);
    return next;
  }

  override async restore(_ctx: AuthContext, id: string, expectedVersion: number): Promise<RecurringProfile> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt || !doc.archivedAt) throw notFound();
    if (doc.version !== expectedVersion) throw versionConflict();
    const next = { ...doc, archivedAt: null, version: doc.version + 1 } as RecurringProfile;
    this.byId.set(id, next);
    return next;
  }

  override async softDelete(_ctx: AuthContext, id: string): Promise<void> {
    const doc = this.byId.get(id);
    if (doc) this.byId.set(id, { ...doc, deletedAt: new Date().toISOString() });
  }
}

const newService = () => {
  const repo = new FakeRecurringProfileRepository();
  const { emitter, events } = newEmitter();
  const svc = new RecurringProfileService({ repo, emitter, logger });
  return { repo, svc, events };
};

// Two lines. Line 1: qty 2 × 1000 = 2000, 10% tax = 200 → 2200.
// Line 2: qty 1 × 500, 50% discount = 250, no tax → 250. grandTotal = 2450.
const CREATE_INPUT = {
  clientId: "c".repeat(24),
  currency: "EUR",
  interval: "monthly",
  intervalCount: 1,
  startDate: "2026-01-31",
  lineItems: [
    { description: "Retainer", quantity: 2, unitPriceMinor: 1000, taxRate: 10 },
    { description: "Discounted item", quantity: 1, unitPriceMinor: 500, discountRate: 50 },
  ],
  notes: "Monthly retainer",
} as const;

const createInput = (overrides: Record<string, unknown> = {}) => {
  return RecurringProfileCreateSchema.parse({ ...CREATE_INPUT, ...overrides });
};

// ── advanceDate (PURE, month-end clamp — L8) ────────────────────────────────────

describe("advanceDate (pure)", () => {
  it("advances weekly by 7 days per count", () => {
    expect(advanceDate("2026-01-01", "weekly", 1)).toBe("2026-01-08");
    expect(advanceDate("2026-01-01", "weekly", 2)).toBe("2026-01-15");
  });

  it("advances monthly and clamps month-end (Jan 31 → Feb 28)", () => {
    expect(advanceDate("2026-01-31", "monthly", 1)).toBe("2026-02-28");
    // No drift: the clamped Feb date advances to the full month end again.
    expect(advanceDate("2026-02-28", "monthly", 1)).toBe("2026-03-28");
  });

  it("clamps to Feb 29 in a leap year", () => {
    expect(advanceDate("2024-01-31", "monthly", 1)).toBe("2024-02-29");
  });

  it("advances quarterly (+3 months) with clamp", () => {
    expect(advanceDate("2026-01-15", "quarterly", 1)).toBe("2026-04-15");
    expect(advanceDate("2025-11-30", "quarterly", 1)).toBe("2026-02-28"); // Nov 30 +3mo, clamped
  });

  it("advances yearly (+12 months) incl. leap-day clamp", () => {
    expect(advanceDate("2026-06-15", "yearly", 1)).toBe("2027-06-15");
    expect(advanceDate("2024-02-29", "yearly", 1)).toBe("2025-02-28"); // leap → non-leap clamp
  });

  it("honours intervalCount > 1 for months", () => {
    expect(advanceDate("2026-01-31", "monthly", 2)).toBe("2026-03-31");
    expect(advanceDate("2026-01-31", "quarterly", 2)).toBe("2026-07-31"); // +6 months
  });

  it("rejects a malformed date", () => {
    expect(() => advanceDate("not-a-date", "monthly", 1)).toThrow(AppError);
  });

  it("honours a day-of-month anchor (every Nth), drift-free across February", () => {
    // 15th anchor stays on the 15th.
    expect(advanceDate("2026-01-15", "monthly", 1, 15)).toBe("2026-02-15");
    // 31st anchor: Jan 31 → Feb 28 (clamped) → Mar 31 (RECOVERS from the stored
    // anchor, not from the clamped 28 — the drift-free property).
    expect(advanceDate("2026-01-31", "monthly", 1, 31)).toBe("2026-02-28");
    expect(advanceDate("2026-02-28", "monthly", 1, 31)).toBe("2026-03-31");
    // Anchor is ignored for weekly.
    expect(advanceDate("2026-01-01", "weekly", 1, 15)).toBe("2026-01-08");
  });
});

// ── create: server totals + active defaults ─────────────────────────────────────

describe("recurring profile create", () => {
  it("creates active, sets nextRunAt=startDate, recomputes totals", async () => {
    const { svc } = newService();
    const p = await svc.create(ADMIN, createInput());
    expect(p.status).toBe("active");
    expect(p.nextRunAt).toBe("2026-01-31");
    expect(p.occurrencesGenerated).toBe(0);
    expect(p.createdInvoiceIds).toEqual([]);
    expect(p.lastRunAt).toBeNull();
    expect(p.subtotalMinor).toBe(2500);
    expect(p.discountMinor).toBe(250);
    expect(p.taxMinor).toBe(200);
    expect(p.grandTotalMinor).toBe(2450);
  });

  it("anchors nextRunAt to the day-of-month on/after startDate", async () => {
    const { svc } = newService();
    // startDate 2026-01-31, anchor 15 → 31 is past the 15th, so first run rolls
    // to the 15th of the NEXT month (Feb 15). The anchor is persisted.
    const p = await svc.create(ADMIN, createInput({ interval: "monthly", dayOfMonth: 15 }));
    expect(p.dayOfMonth).toBe(15);
    expect(p.nextRunAt).toBe("2026-02-15");
  });

  it("rejects a day-of-month anchor on a weekly cadence (schema refine)", () => {
    expect(() => createInput({ interval: "weekly", dayOfMonth: 15 })).toThrow();
  });

  it("ignores client-sent totals and recomputes on update", async () => {
    const { svc } = newService();
    const p = await svc.create(ADMIN, createInput());
    const updated = await svc.update(ADMIN, p.id, p.version, {
      lineItems: [{ description: "X", quantity: 1, unitPriceMinor: 999 }],
      // @ts-expect-error client cannot set totals
      grandTotalMinor: 1,
    });
    expect(updated.grandTotalMinor).toBe(999);
    expect(updated.subtotalMinor).toBe(999);
  });
});

// ── status transitions ──────────────────────────────────────────────────────────

describe("recurring profile transitions", () => {
  it("active → paused → active (resume)", async () => {
    const { svc } = newService();
    let p = await svc.create(ADMIN, createInput());
    p = await svc.pause(ADMIN, p.id, p.version);
    expect(p.status).toBe("paused");
    p = await svc.resume(ADMIN, p.id, p.version);
    expect(p.status).toBe("active");
  });

  it("active → cancelled (terminal); further transition rejected", async () => {
    const { svc } = newService();
    let p = await svc.create(ADMIN, createInput());
    p = await svc.cancel(ADMIN, p.id, p.version);
    expect(p.status).toBe("cancelled");
    await expect(svc.pause(ADMIN, p.id, p.version)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
  });
});

// ── generateOccurrence: advance, idempotency, guards, completion ─────────────────

describe("generateOccurrence", () => {
  it("returns a RAW-line draft payload and advances the schedule", async () => {
    const { svc, repo } = newService();
    const p = await svc.create(ADMIN, createInput());
    const payload = await svc.generateOccurrence(ADMIN, p.id);

    expect(payload).not.toBeNull();
    expect(payload!.clientId).toBe(p.clientId);
    expect(payload!.currency).toBe("EUR");
    expect(payload!.sourceRecurringProfileId).toBe(p.id);
    expect(payload!.issueDate).toBe("2026-01-31");
    // RAW line inputs — no computed *Minor line fields.
    expect(payload!.lineItems[0]).toEqual({ description: "Retainer", quantity: 2, unitPriceMinor: 1000, taxRate: 10 });
    expect(payload!.lineItems[0]).not.toHaveProperty("lineTotalMinor");

    const after = repo.byId.get(p.id)!;
    expect(after.nextRunAt).toBe("2026-02-28"); // Jan 31 monthly clamp
    expect(after.lastRunAt).toBe("2026-01-31");
    expect(after.occurrencesGenerated).toBe(1);
    expect(after.status).toBe("active");
  });

  it("is idempotent: a duplicate enqueue for the same occurrence → OCCURRENCE_ALREADY_GENERATED", async () => {
    const { svc, repo } = newService();
    const p = await svc.create(ADMIN, createInput());
    await svc.generateOccurrence(ADMIN, p.id); // 2026-01-31 → nextRunAt 2026-02-28, lastRunAt 2026-01-31

    // Simulate a duplicate enqueue that reset nextRunAt back to the generated date.
    const cur = repo.byId.get(p.id)!;
    repo.byId.set(p.id, { ...cur, nextRunAt: "2026-01-31" });

    await expect(svc.generateOccurrence(ADMIN, p.id)).rejects.toMatchObject({
      code: "OCCURRENCE_ALREADY_GENERATED",
    });
    // No second generation: counter unchanged.
    expect(repo.byId.get(p.id)!.occurrencesGenerated).toBe(1);
  });

  it("throws RECURRING_PROFILE_INACTIVE when the profile is paused", async () => {
    const { svc } = newService();
    let p = await svc.create(ADMIN, createInput());
    p = await svc.pause(ADMIN, p.id, p.version);
    await expect(svc.generateOccurrence(ADMIN, p.id)).rejects.toMatchObject({
      code: "RECURRING_PROFILE_INACTIVE",
    });
  });

  it("completes at maxOccurrences: boundary run generates, then completes", async () => {
    const { svc, repo } = newService();
    const p = await svc.create(ADMIN, createInput({ maxOccurrences: 2, interval: "monthly", startDate: "2026-01-15" }));

    const first = await svc.generateOccurrence(ADMIN, p.id);
    expect(first).not.toBeNull();
    expect(repo.byId.get(p.id)!.status).toBe("active");

    const second = await svc.generateOccurrence(ADMIN, p.id); // 2nd of 2 → boundary
    expect(second).not.toBeNull(); // payload STILL returned on the boundary run
    const after = repo.byId.get(p.id)!;
    expect(after.occurrencesGenerated).toBe(2);
    expect(after.status).toBe("completed");

    // A further call hits the inactive guard.
    await expect(svc.generateOccurrence(ADMIN, p.id)).rejects.toMatchObject({
      code: "RECURRING_PROFILE_INACTIVE",
    });
  });

  it("completes without generating when nextRunAt is already past endDate", async () => {
    const { svc, repo } = newService();
    const p = await svc.create(ADMIN, createInput({ startDate: "2026-01-15", endDate: "2026-01-31" }));

    // Advance nextRunAt beyond endDate to simulate an exhausted schedule.
    repo.byId.set(p.id, { ...repo.byId.get(p.id)!, nextRunAt: "2026-02-15" });

    const payload = await svc.generateOccurrence(ADMIN, p.id);
    expect(payload).toBeNull(); // no invoice generated
    expect(repo.byId.get(p.id)!.status).toBe("completed");
    expect(repo.byId.get(p.id)!.occurrencesGenerated).toBe(0);
  });

  it("completes on the run whose next date passes endDate (boundary via endDate)", async () => {
    const { svc, repo } = newService();
    // startDate Jan 15, endDate Feb 1: Jan 15 generates, next (Feb 15) > endDate → complete.
    const p = await svc.create(ADMIN, createInput({ startDate: "2026-01-15", endDate: "2026-02-01" }));
    const payload = await svc.generateOccurrence(ADMIN, p.id);
    expect(payload).not.toBeNull();
    const after = repo.byId.get(p.id)!;
    expect(after.occurrencesGenerated).toBe(1);
    expect(after.status).toBe("completed");
  });
});

// ── financial stripping (SEC5) ──────────────────────────────────────────────────

describe("stripProfileFinancial", () => {
  it("keeps money for a financial-capable caller", async () => {
    const { svc } = newService();
    const p = await svc.create(ADMIN, createInput());
    const out = stripProfileFinancial(ADMIN, p);
    expect(out.grandTotalMinor).toBe(2450);
    expect(out.lineItems[0]!.lineTotalMinor).toBeDefined();
  });

  it("strips top-level *Minor and nested line money for a member", async () => {
    const { svc } = newService();
    const p = await svc.create(ADMIN, createInput());
    const out = stripProfileFinancial(MEMBER, p) as unknown as Record<string, unknown>;
    for (const f of ["subtotalMinor", "discountMinor", "taxMinor", "grandTotalMinor"]) {
      expect(f in out).toBe(false);
    }
    const line = (out.lineItems as Record<string, unknown>[])[0]!;
    for (const f of ["unitPriceMinor", "lineSubtotalMinor", "lineDiscountMinor", "lineTaxMinor", "lineTotalMinor"]) {
      expect(f in line).toBe(false);
    }
    expect(line.description).toBe("Retainer"); // non-money fields survive
  });
});
