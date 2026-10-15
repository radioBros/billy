import { describe, it, expect } from "vitest";
import type { Collection } from "mongodb";
import { createLogger, AppError } from "@billy/shared";
import type { AuthContext, BaseDoc } from "@billy/types";
import type { DomainEvent, DomainEventEmitter } from "@/platform/service.js";
import { RecurringProfileRepository } from "@/modules/recurring-billing/repository.js";
import { RecurringProfileService, advanceDate } from "@/modules/recurring-billing/service.js";
import { RecurringProfileCreateSchema, RecurringProfileUpdateSchema } from "@/modules/recurring-billing/schema.js";
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

describe("autoSend schema validation", () => {
  const parse = (autoSend: unknown, over: Record<string, unknown> = {}) =>
    RecurringProfileCreateSchema.safeParse({ ...CREATE_INPUT, autoSend, ...over });

  it("accepts a disabled block with no other fields", () => {
    expect(parse({ enabled: false }).success).toBe(true);
  });

  it("accepts an enabled block with to + subject + body", () => {
    expect(parse({ enabled: true, to: "a@b.co", subject: "S", body: "B" }).success).toBe(true);
  });

  it("rejects enabled without to/subject/body (mandatory-when-on)", () => {
    const r = parse({ enabled: true });
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("autoSend.to");
      expect(paths).toContain("autoSend.subject");
      expect(paths).toContain("autoSend.body");
    }
  });

  it("rejects enabled auto-send for an expense profile (no PDF to email)", () => {
    const r = parse({ enabled: true, to: "a@b.co", subject: "S", body: "B" }, { documentType: "expense" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path.join("."))).toContain("autoSend.enabled");
  });
});

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

// ── softDelete cascade: auto-send attachment files removed with the profile ──────

describe("softDelete — auto-send attachment cascade", () => {
  interface FileRow { id: string; objectKey: string; ownerType: string; ownerId: string; accountId: string; deletedAt: string | null }
  const cascadeService = (files: FileRow[]) => {
    const removed: string[] = [];
    const db = {
      collection() {
        return {
          find: (filter: Record<string, unknown>) => ({
            toArray: () =>
              Promise.resolve(
                files.filter(
                  (f) => f.ownerType === filter.ownerType && f.ownerId === filter.ownerId && f.accountId === filter.accountId && f.deletedAt === null,
                ),
              ),
          }),
          updateMany: (filter: Record<string, unknown>, update: { $set: { deletedAt: string } }) => {
            for (const f of files) {
              if (f.ownerType === filter.ownerType && f.ownerId === filter.ownerId && f.accountId === filter.accountId && f.deletedAt === null) {
                f.deletedAt = update.$set.deletedAt;
              }
            }
            return Promise.resolve({ matchedCount: files.length });
          },
        };
      },
    } as never;
    const minio = { client: { removeObject: (_bucket: string, key: string) => { removed.push(key); return Promise.resolve(); } } } as never;
    const repo = new FakeRecurringProfileRepository();
    const { emitter } = newEmitter();
    const svc = new RecurringProfileService({ repo, emitter, logger, db, minio });
    return { svc, removed, files };
  };

  it("removes the profile's owned files from MinIO + soft-deletes their metadata", async () => {
    const { svc, removed, files } = cascadeService([]);
    const p = await svc.create(ADMIN, createInput());
    files.push(
      { id: "fa", objectKey: "default/recurring-profile/" + p.id + "/a", ownerType: "recurring-profile", ownerId: p.id, accountId: ADMIN.accountId, deletedAt: null },
      { id: "fb", objectKey: "default/recurring-profile/" + p.id + "/b", ownerType: "recurring-profile", ownerId: p.id, accountId: ADMIN.accountId, deletedAt: null },
      // an unrelated file that must NOT be touched
      { id: "fx", objectKey: "default/invoice/other/x", ownerType: "invoice", ownerId: "other", accountId: ADMIN.accountId, deletedAt: null },
    );
    await svc.softDelete(ADMIN, p.id);
    expect(removed.sort()).toEqual(["default/recurring-profile/" + p.id + "/a", "default/recurring-profile/" + p.id + "/b"].sort());
    expect(files.find((f) => f.id === "fa")!.deletedAt).toBeTruthy();
    expect(files.find((f) => f.id === "fx")!.deletedAt).toBeNull(); // untouched
  });

  it("still deletes the profile when MinIO removeObject fails (best-effort cleanup)", async () => {
    const repo = new FakeRecurringProfileRepository();
    const { emitter } = newEmitter();
    const db = {
      collection() {
        return {
          find: () => ({ toArray: () => Promise.resolve([{ id: "f1", objectKey: "k1" }]) }),
          updateMany: () => Promise.resolve({ matchedCount: 1 }),
        };
      },
    } as never;
    const minio = { client: { removeObject: () => Promise.reject(new Error("minio down")) } } as never;
    const svc = new RecurringProfileService({ repo, emitter, logger, db, minio });
    const p = await svc.create(ADMIN, createInput());
    // Must not throw despite the storage failure.
    await expect(svc.softDelete(ADMIN, p.id)).resolves.toBeUndefined();
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

// ── requestGenerateNow: worker-backed "Generate now" ──────────────────────────────

describe("requestGenerateNow", () => {
  it("enqueues a generate-now job for the next occurrence and reports generated once the profile advances", async () => {
    const repo = new FakeRecurringProfileRepository();
    const { emitter } = newEmitter();
    const enqueued: { id: string; nextRunAt: string; accountId: string }[] = [];
    const svc = new RecurringProfileService({
      repo,
      emitter,
      logger,
      // Simulate the worker: generating advances the profile.
      enqueueGenerateNow: async (p) => {
        enqueued.push(p);
        const doc = repo.byId.get(p.id)!;
        repo.byId.set(p.id, { ...doc, occurrencesGenerated: doc.occurrencesGenerated + 1, version: doc.version + 1 });
      },
    });
    const p = await svc.create(ADMIN, createInput());
    const res = await svc.requestGenerateNow(ADMIN, p.id, { pollMs: 1, timeoutMs: 200 });
    expect(res).toEqual({ generated: true });
    expect(enqueued).toEqual([{ id: p.id, nextRunAt: p.nextRunAt, accountId: ADMIN.accountId }]);
  });

  it("reports pending when the worker has not produced the document within the wait", async () => {
    const repo = new FakeRecurringProfileRepository();
    const { emitter } = newEmitter();
    const svc = new RecurringProfileService({ repo, emitter, logger, enqueueGenerateNow: async () => undefined });
    const p = await svc.create(ADMIN, createInput());
    const res = await svc.requestGenerateNow(ADMIN, p.id, { pollMs: 1, timeoutMs: 20 });
    expect(res).toEqual({ generated: false, pending: true });
    // Nothing advanced the schedule on the API side.
    expect(repo.byId.get(p.id)!.occurrencesGenerated).toBe(0);
  });

  it("completes an exhausted profile without enqueueing (returns null)", async () => {
    const repo = new FakeRecurringProfileRepository();
    const { emitter } = newEmitter();
    let called = 0;
    const svc = new RecurringProfileService({ repo, emitter, logger, enqueueGenerateNow: async () => { called++; } });
    const p = await svc.create(ADMIN, createInput({ maxOccurrences: 1 }));
    const doc = repo.byId.get(p.id)!;
    repo.byId.set(p.id, { ...doc, occurrencesGenerated: 1 });
    const res = await svc.requestGenerateNow(ADMIN, p.id, { pollMs: 1, timeoutMs: 20 });
    expect(res).toBeNull();
    expect(called).toBe(0);
    expect(repo.byId.get(p.id)!.status).toBe("completed");
  });

  it("refuses with QUEUE_UNAVAILABLE when no queue is wired (never advances silently)", async () => {
    const { svc, repo } = newService();
    const p = await svc.create(ADMIN, createInput());
    await expect(svc.requestGenerateNow(ADMIN, p.id)).rejects.toMatchObject({ code: "QUEUE_UNAVAILABLE" });
    expect(repo.byId.get(p.id)!.occurrencesGenerated).toBe(0);
  });

  it("stores paymentTermDays from the create payload", async () => {
    const { svc } = newService();
    const p = await svc.create(ADMIN, createInput({ paymentTermDays: 30 }));
    expect(p.paymentTermDays).toBe(30);
  });
});

// ── Audit fixes: bank/project/expense, clearing bounds, cadence edit, resume, events ──

const update = (overrides: Record<string, unknown>) => RecurringProfileUpdateSchema.parse(overrides);

describe("profile template: bank account, project, expense fields", () => {
  it("stores bankAccountId (a settings id, not an ObjectId) and projectId", async () => {
    const { svc } = newService();
    const p = await svc.create(ADMIN, createInput({ bankAccountId: "bank-main", projectId: "a".repeat(24) }));
    expect(p.bankAccountId).toBe("bank-main");
    expect(p.projectId).toBe("a".repeat(24));
  });

  it("stores the expense template for an expense profile (defaults applied)", async () => {
    const { svc } = newService();
    const p = await svc.create(ADMIN, createInput({ documentType: "expense", expense: { category: "Software", vendor: "Hetzner" } }));
    expect(p.expense).toEqual({ category: "Software", vendor: "Hetzner", description: "", billable: false });
  });

  it("drops an expense block sent with a non-expense profile", async () => {
    const { svc } = newService();
    const p = await svc.create(ADMIN, createInput({ expense: { category: "X", vendor: "Y" } }));
    expect(p.expense).toBeNull();
  });

  it("rejects an expense block without vendor/category", () => {
    expect(() => createInput({ documentType: "expense", expense: { category: "", vendor: "V" } })).toThrow();
    expect(() => createInput({ documentType: "expense", expense: { category: "C" } })).toThrow();
  });

  it("edits bank + project on update", async () => {
    const { svc } = newService();
    const p = await svc.create(ADMIN, createInput({ bankAccountId: "b1" }));
    const u = await svc.update(ADMIN, p.id, p.version, update({ bankAccountId: "b2", projectId: "b".repeat(24) }));
    expect(u.bankAccountId).toBe("b2");
    expect(u.projectId).toBe("b".repeat(24));
  });
});

describe("update: clearing bounds", () => {
  it("an explicit null CLEARS endDate / maxOccurrences / paymentTermDays", async () => {
    const { svc } = newService();
    const p = await svc.create(ADMIN, createInput({ endDate: "2026-12-31", maxOccurrences: 5, paymentTermDays: 30 }));
    const u = await svc.update(ADMIN, p.id, p.version, update({ endDate: null, maxOccurrences: null, paymentTermDays: null }));
    expect(u.endDate).toBeNull();
    expect(u.maxOccurrences).toBeNull();
    expect(u.paymentTermDays).toBeNull();
  });

  it("absent keys keep the existing bounds", async () => {
    const { svc } = newService();
    const p = await svc.create(ADMIN, createInput({ endDate: "2026-12-31", maxOccurrences: 5, paymentTermDays: 30 }));
    const u = await svc.update(ADMIN, p.id, p.version, update({ notes: "changed" }));
    expect(u).toMatchObject({ endDate: "2026-12-31", maxOccurrences: 5, paymentTermDays: 30, notes: "changed" });
  });
});

describe("update: cadence edit recomputes nextRunAt", () => {
  it("a new day-of-month anchor moves nextRunAt to the first anchored day on/after the current one", async () => {
    const { svc } = newService();
    const p = await svc.create(ADMIN, createInput({ startDate: "2026-03-05" })); // nextRunAt 03-05
    const later = await svc.update(ADMIN, p.id, p.version, update({ dayOfMonth: 20 }));
    expect(later.nextRunAt).toBe("2026-03-20");
    const rolled = await svc.update(ADMIN, later.id, later.version, update({ dayOfMonth: 1 }));
    // never moves backwards (no back-fill) → next month's 1st
    expect(rolled.nextRunAt).toBe("2026-04-01");
  });

  it("switching to weekly drops the anchor and keeps nextRunAt", async () => {
    const { svc } = newService();
    const p = await svc.create(ADMIN, createInput({ startDate: "2026-03-05", dayOfMonth: 15 })); // 03-15
    const u = await svc.update(ADMIN, p.id, p.version, update({ interval: "weekly" }));
    expect(u.dayOfMonth).toBeNull();
    expect(u.nextRunAt).toBe("2026-03-15");
  });

  it("interval/count changes alone keep nextRunAt", async () => {
    const { svc } = newService();
    const p = await svc.create(ADMIN, createInput({ startDate: "2026-03-05" }));
    const u = await svc.update(ADMIN, p.id, p.version, update({ interval: "quarterly", intervalCount: 2 }));
    expect(u.nextRunAt).toBe("2026-03-05");
  });
});

describe("resume skips the paused period (no back-fill)", () => {
  const svcAt = (today: string) => {
    const repo = new FakeRecurringProfileRepository();
    const { emitter, events } = newEmitter();
    const svc = new RecurringProfileService({ repo, emitter, logger, todayFor: async () => today });
    return { svc, repo, events };
  };

  it("moves nextRunAt to the first occurrence on/after today, keeping the anchor", async () => {
    const { svc, events } = svcAt("2026-10-15");
    let p = await svc.create(ADMIN, createInput({ startDate: "2026-03-01", dayOfMonth: 1 }));
    p = await svc.pause(ADMIN, p.id, p.version);
    p = await svc.resume(ADMIN, p.id, p.version);
    expect(p.status).toBe("active");
    expect(p.nextRunAt).toBe("2026-11-01");
    expect(p.occurrencesGenerated).toBe(0);
    expect(events.map((e) => e.name)).toContain("recurring.profile_resumed");
  });

  it("an occurrence due exactly today is kept", async () => {
    const { svc } = svcAt("2026-10-01");
    let p = await svc.create(ADMIN, createInput({ startDate: "2026-03-01", dayOfMonth: 1 }));
    p = await svc.pause(ADMIN, p.id, p.version);
    p = await svc.resume(ADMIN, p.id, p.version);
    expect(p.nextRunAt).toBe("2026-10-01");
  });

  it("leaves a future nextRunAt untouched", async () => {
    const { svc } = svcAt("2026-01-10");
    let p = await svc.create(ADMIN, createInput()); // 2026-01-31
    p = await svc.pause(ADMIN, p.id, p.version);
    p = await svc.resume(ADMIN, p.id, p.version);
    expect(p.nextRunAt).toBe("2026-01-31");
  });

  it("still rejects resuming a non-paused profile", async () => {
    const { svc } = svcAt("2026-10-15");
    const p = await svc.create(ADMIN, createInput());
    const c = await svc.cancel(ADMIN, p.id, p.version);
    await expect(svc.resume(ADMIN, c.id, c.version)).rejects.toBeInstanceOf(AppError);
  });
});

describe("requestGenerateNow emits the occurrence event once the worker advanced the profile", () => {
  it("emits recurring.occurrence_generated (and profile_completed when the run exhausted it)", async () => {
    const repo = new FakeRecurringProfileRepository();
    const { emitter, events } = newEmitter();
    const svc = new RecurringProfileService({
      repo,
      emitter,
      logger,
      enqueueGenerateNow: async (p) => {
        const doc = repo.byId.get(p.id)!;
        repo.byId.set(p.id, { ...doc, occurrencesGenerated: 1, status: "completed", version: doc.version + 1 });
      },
    });
    const p = await svc.create(ADMIN, createInput({ maxOccurrences: 1 }));
    await svc.requestGenerateNow(ADMIN, p.id, { pollMs: 1, timeoutMs: 200 });
    const gen = events.find((e) => e.name === "recurring.occurrence_generated");
    expect(gen).toMatchObject({ entityId: p.id, payload: { scheduledDate: p.nextRunAt, occurrencesGenerated: 1 } });
    expect(events.some((e) => e.name === "recurring.profile_completed")).toBe(true);
  });

  it("emits nothing while the worker has not produced the document", async () => {
    const repo = new FakeRecurringProfileRepository();
    const { emitter, events } = newEmitter();
    const svc = new RecurringProfileService({ repo, emitter, logger, enqueueGenerateNow: async () => undefined });
    const p = await svc.create(ADMIN, createInput());
    await svc.requestGenerateNow(ADMIN, p.id, { pollMs: 1, timeoutMs: 10 });
    expect(events.some((e) => e.name === "recurring.occurrence_generated")).toBe(false);
  });
});
