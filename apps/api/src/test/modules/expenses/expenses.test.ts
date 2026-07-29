import { describe, it, expect } from "vitest";
import type { Collection } from "mongodb";
import { createLogger, AppError } from "@billy/shared";
import type { AuthContext, Capabilities } from "@billy/types";
import type { DomainEventEmitter } from "@/platform/service.js";
import { stripFinancial } from "@/platform/serializer.js";
import { ExpenseRepository } from "@/modules/expenses/repository.js";
import { ExpenseService } from "@/modules/expenses/service.js";
import { ExpenseCreateSchema, ExpenseMarkInvoicedSchema } from "@/modules/expenses/schema.js";
import type { Expense } from "@/modules/expenses/types.js";
import { safeValidate } from "@billy/validation";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const logger = createLogger({ level: "silent", pretty: false, service: "test" });
const emitter: DomainEventEmitter = { emit() {} };

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  canManageSettings: false,
  canManageUsers: false,
  canPermanentlyDelete: false,
  canViewFinancialTotals: false,
  canExportData: false,
  ...over,
});

const admin: AuthContext = { userId: "admin1", role: "administrator", capabilities: caps(), accountId: "default" };
const restrictedMember: AuthContext = {
  userId: "m1",
  role: "member",
  capabilities: caps(), // no canViewFinancialTotals
  accountId: "default",
};

/**
 * In-memory ExpenseRepository (like modules/auth/auth-flow.test.ts). BaseRepository
 * is a class with protected members, so an object literal cannot satisfy it —
 * we subclass, back it with a Map, and override only the methods the service
 * calls. The stubbed collection is passed to `super` via a cast (not `any`); the
 * overrides never touch it.
 */
class InMemoryExpenseRepository extends ExpenseRepository {
  readonly byId = new Map<string, Expense>();
  private seq = 0;

  constructor() {
    super({} as unknown as Collection<Expense>);
  }

  override async findById(_ctx: AuthContext, id: string): Promise<Expense | null> {
    const doc = this.byId.get(id);
    return doc && !doc.deletedAt ? doc : null;
  }

  override async insert(_ctx: AuthContext, data: Omit<Expense, keyof import("@billy/types").BaseDoc>): Promise<Expense> {
    const ts = new Date().toISOString();
    const doc: Expense = {
      ...(data as Omit<Expense, keyof import("@billy/types").BaseDoc>),
      id: `exp${++this.seq}`.padStart(24, "0"),
      version: 1,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      deletedAt: null,
    } as Expense;
    this.byId.set(doc.id, doc);
    return doc;
  }

  override async updateVersioned(
    _ctx: AuthContext,
    id: string,
    expectedVersion: number,
    patch: Partial<Expense>,
  ): Promise<Expense> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt) throw new AppError("RESOURCE_NOT_FOUND", "not found");
    if (doc.version !== expectedVersion) throw new AppError("VERSION_CONFLICT", "conflict");
    const next: Expense = { ...doc, ...patch, version: doc.version + 1, updatedAt: new Date().toISOString() };
    this.byId.set(id, next);
    return next;
  }
}

const newService = (): { repo: InMemoryExpenseRepository; svc: ExpenseService } => {
  const repo = new InMemoryExpenseRepository();
  const svc = new ExpenseService({ repo, emitter, logger });
  return { repo, svc };
};

const validCreate = {
  amountMinor: 1234,
  currency: "EUR",
  category: "hosting",
  date: "2026-07-01",
  vendor: "AcmeCloud",
  description: "monthly VPS",
  billable: true,
};

// ── Schema ─────────────────────────────────────────────────────────────────

describe("ExpenseCreateSchema (VAL / §37 positive-amount refinement)", () => {
  it("accepts a valid positive integer minor-units amount", () => {
    const r = safeValidate(ExpenseCreateSchema, validCreate);
    expect(r.ok).toBe(true);
  });

  it("rejects a zero amount", () => {
    const r = safeValidate(ExpenseCreateSchema, { ...validCreate, amountMinor: 0 });
    expect(r.ok).toBe(false);
  });

  it("rejects a negative amount", () => {
    const r = safeValidate(ExpenseCreateSchema, { ...validCreate, amountMinor: -500 });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-integer (float) amount — never floats for money", () => {
    const r = safeValidate(ExpenseCreateSchema, { ...validCreate, amountMinor: 12.34 });
    expect(r.ok).toBe(false);
  });

  it("mark-invoiced body requires a valid invoiceId + version", () => {
    expect(safeValidate(ExpenseMarkInvoicedSchema, { invoiceId: "x", version: 1 }).ok).toBe(false);
    expect(safeValidate(ExpenseMarkInvoicedSchema, { invoiceId: "a".repeat(24), version: 1 }).ok).toBe(true);
  });
});

// ── Service: markInvoiced guard ──────────────────────────────────────────────

describe("ExpenseService.markInvoiced (duplicate-invoicing guard §14.4)", () => {
  it("sets invoiceId/invoicedAt/status on first invoice", async () => {
    const { svc } = newService();
    const created = await svc.create(admin, ExpenseCreateSchema.parse(validCreate));
    const invoiced = await svc.markInvoiced(admin, created.id, created.version, "b".repeat(24));
    expect(invoiced.invoiceId).toBe("b".repeat(24));
    expect(invoiced.invoicedAt).toBeTruthy();
    expect(invoiced.status).toBe("invoiced");
  });

  it("invoicing twice → EXPENSE_ALREADY_INVOICED", async () => {
    const { svc } = newService();
    const created = await svc.create(admin, ExpenseCreateSchema.parse(validCreate));
    const invoiced = await svc.markInvoiced(admin, created.id, created.version, "b".repeat(24));
    await expect(svc.markInvoiced(admin, invoiced.id, invoiced.version, "c".repeat(24))).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === "EXPENSE_ALREADY_INVOICED",
    );
  });
});

// ── Serializer: financial stripping ──────────────────────────────────────────

describe("stripFinancial (SEC5 — amountMinor hidden for restricted member)", () => {
  it("keeps amountMinor for an administrator", async () => {
    const { svc } = newService();
    const created = await svc.create(admin, ExpenseCreateSchema.parse(validCreate));
    const out = stripFinancial(admin, { ...created } as Record<string, unknown>, ["amountMinor"]);
    expect(out.amountMinor).toBe(1234);
  });

  it("removes amountMinor from the payload for a member without canViewFinancialTotals", async () => {
    const { svc } = newService();
    const created = await svc.create(admin, ExpenseCreateSchema.parse(validCreate));
    const out = stripFinancial(restrictedMember, { ...created } as Record<string, unknown>, ["amountMinor"]);
    expect("amountMinor" in out).toBe(false);
    // non-financial fields survive
    expect(out.vendor).toBe("AcmeCloud");
  });
});
