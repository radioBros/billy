import { describe, it, expect, beforeEach } from "vitest";
import type { Collection } from "mongodb";
import type { AuthContext, Capabilities, ListWhitelist } from "@billy/types";
import { AppError, createLogger } from "@billy/shared";
import { safeValidate } from "@billy/validation";
import type { DomainEventEmitter } from "@/platform/service.js";
import type { ParsedListQuery } from "@/platform/list-query.js";
import { TimeEntryRepository } from "@/modules/time-tracking/repository.js";
import { TimeEntryService } from "@/modules/time-tracking/service.js";
import { TimeEntryCreateSchema } from "@/modules/time-tracking/schema.js";
import type { TimeEntry } from "@/modules/time-tracking/types.js";

// ── in-memory fake repository (mirrors modules/auth/auth-flow.test.ts stores) ──
class InMemoryTimeEntryRepository extends TimeEntryRepository {
  readonly byId = new Map<string, TimeEntry>();
  private seq = 0;

  constructor() {
    // The base ctor only stores the collection reference; the overrides below
    // never touch it, so a stub satisfies the type without a live DB.
    super(null as unknown as Collection<TimeEntry>);
  }

  private nextId(): string {
    this.seq += 1;
    return this.seq.toString(16).padStart(24, "0");
  }

  override async findById(_ctx: AuthContext, id: string): Promise<TimeEntry | null> {
    // Mirror BaseRepository: default read excludes soft-deleted AND archived.
    const doc = this.byId.get(id);
    return doc && !doc.deletedAt && !doc.archivedAt ? doc : null;
  }

  override async findByIdAnyArchive(_ctx: AuthContext, id: string): Promise<TimeEntry | null> {
    const doc = this.byId.get(id);
    return doc && !doc.deletedAt ? doc : null;
  }

  override async restore(_ctx: AuthContext, id: string, expectedVersion: number): Promise<TimeEntry> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt) throw new AppError("RESOURCE_NOT_FOUND", "not found");
    if (doc.version !== expectedVersion) throw new AppError("VERSION_CONFLICT", "conflict");
    const next = { ...doc, archivedAt: null, version: doc.version + 1, updatedAt: new Date().toISOString() };
    this.byId.set(id, next);
    return next;
  }

  override async findActiveTimer(_ctx: AuthContext, userId: string): Promise<TimeEntry | null> {
    return (
      [...this.byId.values()].find(
        (d) => d.userId === userId && !d.deletedAt && (d.timerState === "running" || d.timerState === "paused"),
      ) ?? null
    );
  }

  override async insert(_ctx: AuthContext, data: Omit<TimeEntry, keyof import("@billy/types").BaseDoc>): Promise<TimeEntry> {
    const ts = new Date().toISOString();
    const doc = {
      ...data,
      id: this.nextId(),
      version: 1,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      deletedAt: null,
    } as unknown as TimeEntry;
    this.byId.set(doc.id, doc);
    return doc;
  }

  override async updateVersioned(
    _ctx: AuthContext,
    id: string,
    expectedVersion: number,
    patch: Partial<TimeEntry>,
  ): Promise<TimeEntry> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt) throw new AppError("RESOURCE_NOT_FOUND", "not found");
    if (doc.version !== expectedVersion) throw new AppError("VERSION_CONFLICT", "conflict");
    const next = { ...doc, ...patch, version: doc.version + 1, updatedAt: new Date().toISOString() };
    this.byId.set(id, next);
    return next;
  }

  override async softDelete(_ctx: AuthContext, id: string): Promise<void> {
    const doc = this.byId.get(id);
    if (doc) this.byId.set(id, { ...doc, deletedAt: new Date().toISOString() });
  }

  override async list(_ctx: AuthContext, _raw: Record<string, string | string[] | undefined>, _wl: ListWhitelist) {
    const items = [...this.byId.values()].filter((d) => !d.deletedAt);
    const parsed = { page: 1, limit: 50, skip: 0, sort: {}, sortSpec: [], archived: "false", filter: {} } as unknown as ParsedListQuery;
    return { items, parsed, total: items.length };
  }
}

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  canManageSettings: false,
  canManageUsers: false,
  canPermanentlyDelete: false,
  canViewFinancialTotals: true,
  canExportData: false,
  ...over,
});

const ctx: AuthContext = { userId: "user-1", role: "member", capabilities: caps(), accountId: "default" };
const logger = createLogger({ level: "silent", pretty: false, service: "test" });
const emitter: DomainEventEmitter = { emit() {} };

const newSvc = () => {
  const repo = new InMemoryTimeEntryRepository();
  const svc = new TimeEntryService({ repo, emitter, logger });
  return { repo, svc };
};

const expectCode = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toBeInstanceOf(AppError);
  await p.catch((e: unknown) => expect((e as AppError).code).toBe(code));
};

describe("TimeEntry schema — durationMinutes (§37 isNonNegativeDuration)", () => {
  const base = { description: "work", date: "2026-07-15" };

  it("accepts a non-negative integer duration", () => {
    const r = safeValidate(TimeEntryCreateSchema, { ...base, durationMinutes: 90 });
    expect(r.ok).toBe(true);
  });

  it("defaults durationMinutes to 0 when omitted", () => {
    const r = safeValidate(TimeEntryCreateSchema, base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.durationMinutes).toBe(0);
  });

  it("rejects a negative duration", () => {
    const r = safeValidate(TimeEntryCreateSchema, { ...base, durationMinutes: -5 });
    expect(r.ok).toBe(false);
  });

  it("rejects a fractional duration", () => {
    const r = safeValidate(TimeEntryCreateSchema, { ...base, durationMinutes: 12.5 });
    expect(r.ok).toBe(false);
  });
});

describe("timer — one running timer per user (§13.2)", () => {
  it("starts a running timer", async () => {
    const { svc } = newSvc();
    const t = await svc.startTimer(ctx, {});
    expect(t.timerState).toBe("running");
    expect(t.userId).toBe("user-1");
    expect(t.timerStartedAt).toBeTruthy();
  });

  it("rejects a second start while one is running → TIMER_ALREADY_RUNNING", async () => {
    const { svc } = newSvc();
    await svc.startTimer(ctx, {});
    await expectCode(svc.startTimer(ctx, {}), "TIMER_ALREADY_RUNNING");
  });

  it("rejects a start while a timer is paused → TIMER_ALREADY_RUNNING", async () => {
    const { svc } = newSvc();
    const t = await svc.startTimer(ctx, {});
    await svc.pauseTimer(ctx, t.id);
    await expectCode(svc.startTimer(ctx, {}), "TIMER_ALREADY_RUNNING");
  });

  it("allows a new timer after the previous is stopped", async () => {
    const { svc } = newSvc();
    const t = await svc.startTimer(ctx, {});
    await svc.stopTimer(ctx, t.id);
    const t2 = await svc.startTimer(ctx, {});
    expect(t2.timerState).toBe("running");
  });

  it("pause → resume → stop clears timer state", async () => {
    const { svc } = newSvc();
    const t = await svc.startTimer(ctx, {});
    const paused = await svc.pauseTimer(ctx, t.id);
    expect(paused.timerState).toBe("paused");
    expect(paused.timerStartedAt).toBeNull();
    const resumed = await svc.resumeTimer(ctx, t.id);
    expect(resumed.timerState).toBe("running");
    const stopped = await svc.stopTimer(ctx, t.id);
    expect(stopped.timerState).toBeNull();
    expect(stopped.timerStartedAt).toBeNull();
  });
});

describe("billing — prevent double billing (§13.4)", () => {
  const invoiceId = "aaaaaaaaaaaaaaaaaaaaaaaa";

  it("marks an entry billed once", async () => {
    const { svc } = newSvc();
    const e = await svc.create(ctx, { description: "w", date: "2026-07-15", durationMinutes: 60, billable: true });
    const billed = await svc.markBilled(ctx, e.id, invoiceId);
    expect(billed.billed).toBe(true);
    expect(billed.invoiceId).toBe(invoiceId);
  });

  it("rejects billing twice → TIME_ENTRY_ALREADY_BILLED", async () => {
    const { svc } = newSvc();
    const e = await svc.create(ctx, { description: "w", date: "2026-07-15", durationMinutes: 60, billable: true });
    await svc.markBilled(ctx, e.id, invoiceId);
    await expectCode(svc.markBilled(ctx, e.id, invoiceId), "TIME_ENTRY_ALREADY_BILLED");
  });
});

describe("archive lifecycle + capability gates", () => {
  const mk = (svc: TimeEntryService) =>
    svc.create(ctx, { description: "w", date: "2026-07-15", durationMinutes: 30, billable: true });

  it("archive then restore round-trips (restore reaches an archived entry)", async () => {
    const { svc } = newSvc();
    const e = await mk(svc);
    const archived = await svc.archive(ctx, e.id, e.version);
    expect(archived.archivedAt).toBeTruthy();
    const restored = await svc.restore(ctx, e.id, archived.version);
    expect(restored.archivedAt).toBeNull();
  });

  it("softDelete requires canPermanentlyDelete for a member → CAPABILITY_DENIED", async () => {
    const { svc } = newSvc();
    const e = await mk(svc);
    await expectCode(svc.softDelete(ctx, e.id), "CAPABILITY_DENIED");
  });

  it("administrator may softDelete", async () => {
    const { svc } = newSvc();
    const e = await mk(svc);
    const admin: AuthContext = { ...ctx, role: "administrator" };
    await expect(svc.softDelete(admin, e.id)).resolves.toBeUndefined();
    expect(await svc.getById(admin, e.id).catch((x: AppError) => x.code)).toBe("RESOURCE_NOT_FOUND");
  });
});
