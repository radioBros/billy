import { describe, it, expect } from "vitest";
import type { Collection } from "mongodb";
import { createLogger, AppError } from "@billy/shared";
import type { AuthContext, BaseDoc } from "@billy/types";
import type { DomainEvent, DomainEventEmitter } from "@/platform/service.js";
import { CreditNoteRepository } from "@/modules/credit-notes/repository.js";
import { CreditNoteService, type ClientRecord } from "@/modules/credit-notes/service.js";
import { CreditNoteCreateSchema } from "@/modules/credit-notes/schema.js";
import { stripCreditNoteFinancial } from "@/modules/credit-notes/routes.js";
import type { CreditNote } from "@/modules/credit-notes/types.js";

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
 * In-memory CreditNoteRepository. Extends the real class (protected members prevent
 * a structural fake), passing a dummy collection to super and overriding every
 * public method against a Map. Filters by `accountId` so list-scoping is
 * exercised (mirrors the real scoped filter).
 */
class FakeCreditNoteRepository extends CreditNoteRepository {
  readonly byId = new Map<string, CreditNote & { accountId: string }>();
  private seq = 0;

  constructor() {
    super(undefined as unknown as Collection<CreditNote>);
  }

  override async findById(ctx: AuthContext, id: string): Promise<CreditNote | null> {
    const doc = this.byId.get(id);
    return doc && !doc.deletedAt && doc.accountId === ctx.accountId ? doc : null;
  }

  override async list(
    ctx: AuthContext,
    _raw: Record<string, string | string[] | undefined>,
    _whitelist: unknown,
  ): Promise<{ items: CreditNote[]; parsed: never; total: number }> {
    const items = [...this.byId.values()].filter(
      (d) => !d.deletedAt && !d.archivedAt && d.accountId === ctx.accountId,
    );
    const parsed = { page: 1, limit: 20, sortSpec: [], q: undefined } as unknown as never;
    return { items, parsed, total: items.length };
  }

  override async insert(ctx: AuthContext, data: Omit<CreditNote, keyof BaseDoc>): Promise<CreditNote> {
    const ts = new Date().toISOString();
    const doc = {
      ...(data as object),
      id: `cn-${++this.seq}`,
      version: 1,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      deletedAt: null,
      accountId: ctx.accountId,
    } as CreditNote & { accountId: string };
    this.byId.set(doc.id, doc);
    return doc;
  }

  override async updateVersioned(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    patch: Partial<CreditNote>,
  ): Promise<CreditNote> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt || doc.accountId !== ctx.accountId) throw notFound();
    if (doc.archivedAt) throw notFound();
    if (doc.version !== expectedVersion) throw versionConflict();
    const next = {
      ...doc,
      ...patch,
      version: doc.version + 1,
      updatedAt: new Date().toISOString(),
    } as CreditNote & { accountId: string };
    this.byId.set(id, next);
    return next;
  }

  override async replaceState(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    patch: Partial<CreditNote>,
  ): Promise<CreditNote> {
    return this.updateVersioned(ctx, id, expectedVersion, patch);
  }

  override async archive(ctx: AuthContext, id: string, expectedVersion: number): Promise<CreditNote> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt || doc.accountId !== ctx.accountId) throw notFound();
    if (doc.version !== expectedVersion) throw versionConflict();
    const next = { ...doc, archivedAt: new Date().toISOString(), version: doc.version + 1 };
    this.byId.set(id, next);
    return next;
  }

  override async restore(ctx: AuthContext, id: string, expectedVersion: number): Promise<CreditNote> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt || !doc.archivedAt || doc.accountId !== ctx.accountId) throw notFound();
    if (doc.version !== expectedVersion) throw versionConflict();
    const next = { ...doc, archivedAt: null, version: doc.version + 1 };
    this.byId.set(id, next);
    return next;
  }

  override async softDelete(ctx: AuthContext, id: string): Promise<void> {
    const doc = this.byId.get(id);
    if (doc && doc.accountId === ctx.accountId) {
      this.byId.set(id, { ...doc, deletedAt: new Date().toISOString() });
    }
  }
}

const CLIENT: ClientRecord = {
  id: "c-1",
  displayName: "Acme SpA",
  legalName: "Acme S.p.A.",
  email: "billing@acme.io",
  vatNumber: "IT12345678901",
  preferredCurrency: "EUR",
};

const newService = () => {
  const repo = new FakeCreditNoteRepository();
  const { emitter, events } = newEmitter();
  let counter = 0;
  const svc = new CreditNoteService({
    repo,
    emitter,
    logger,
    loadClient: async (_ctx, clientId) => (clientId === CLIENT.id ? CLIENT : null),
    nextCreditNoteNumber: async (_accountId, year) => `CN-${year}-${String(++counter).padStart(4, "0")}`,
  });
  return { repo, svc, events };
};

// Line 1: qty 2 × 1000 = 2000, 10% tax = 200 → 2200.
// Line 2: qty 1 × 500, 50% discount = 250, no tax → 250. grandTotal = 2450.
const CREATE_INPUT = {
  clientId: "c".repeat(24),
  creditedInvoiceId: "d".repeat(24),
  currency: "EUR",
  issueDate: "2026-01-10",
  lineItems: [
    { description: "Refund consulting", quantity: 2, unitPriceMinor: 1000, taxRate: 10 },
    { description: "Discounted item", quantity: 1, unitPriceMinor: 500, discountRate: 50 },
  ],
  reason: "Overbilled hours",
  notes: "Credit",
} as const;

const makeDraft = async (svc: CreditNoteService, repo: FakeCreditNoteRepository) => {
  const draft = await svc.create(ADMIN, CreditNoteCreateSchema.parse(CREATE_INPUT));
  // Point clientId at the fake client so issue's loadClient resolves.
  repo.byId.set(draft.id, { ...repo.byId.get(draft.id)!, clientId: CLIENT.id });
  return repo.byId.get(draft.id)!;
};

// ── Schema ────────────────────────────────────────────────────────────────────

describe("credit-note schema", () => {
  it("accepts a valid create payload", () => {
    expect(CreditNoteCreateSchema.safeParse(CREATE_INPUT).success).toBe(true);
  });

  it("requires a credited invoice id", () => {
    const { creditedInvoiceId: _drop, ...noInvoice } = CREATE_INPUT;
    void _drop;
    expect(CreditNoteCreateSchema.safeParse(noInvoice).success).toBe(false);
  });

  it("requires at least one line item", () => {
    expect(CreditNoteCreateSchema.safeParse({ ...CREATE_INPUT, lineItems: [] }).success).toBe(false);
  });
});

// ── Server-recomputed totals ───────────────────────────────────────────────────

describe("credit-note totals — server recompute (never trust client)", () => {
  it("computes subtotal/discount/tax/grandTotal from line items", async () => {
    const { svc } = newService();
    const cn = await svc.create(ADMIN, CreditNoteCreateSchema.parse(CREATE_INPUT));
    expect(cn.subtotalMinor).toBe(2500);
    expect(cn.discountMinor).toBe(250);
    expect(cn.taxMinor).toBe(200);
    expect(cn.grandTotalMinor).toBe(2450);
    expect(cn.status).toBe("draft");
    expect(cn.creditNoteNumber).toBeNull();
    expect(cn.creditedInvoiceId).toBe("d".repeat(24));
  });

  it("ignores client-sent totals and recomputes on update", async () => {
    const { svc } = newService();
    const cn = await svc.create(ADMIN, CreditNoteCreateSchema.parse(CREATE_INPUT));
    const updated = await svc.update(ADMIN, cn.id, cn.version, {
      lineItems: [{ description: "X", quantity: 1, unitPriceMinor: 999 }],
      // @ts-expect-error client cannot set totals
      grandTotalMinor: 1,
    });
    expect(updated.grandTotalMinor).toBe(999);
    expect(updated.subtotalMinor).toBe(999);
  });
});

// ── Issue: number + snapshot + lock ─────────────────────────────────────────────

describe("credit-note issue transition", () => {
  it("assigns a CN- number, snapshots the client, and moves draft→issued", async () => {
    const { svc, repo, events } = newService();
    const draft = await makeDraft(svc, repo);
    const issued = await svc.issue(ADMIN, draft.id, draft.version);
    expect(issued.status).toBe("issued");
    expect(issued.creditNoteNumber).toBe("CN-2026-0001");
    expect(issued.clientSnapshot?.displayName).toBe("Acme SpA");
    expect(issued.clientSnapshot?.currency).toBe("EUR");
    expect(events.map((e) => e.name)).toContain("creditNote.issued");
  });

  it("blocks editing an issued credit note → INVOICE_NOT_EDITABLE", async () => {
    const { svc, repo } = newService();
    const draft = await makeDraft(svc, repo);
    const issued = await svc.issue(ADMIN, draft.id, draft.version);
    await expect(
      svc.update(ADMIN, issued.id, issued.version, { notes: "late edit" }),
    ).rejects.toMatchObject({ code: "INVOICE_NOT_EDITABLE" });
  });

  it("rejects re-issue → INVALID_STATE_TRANSITION", async () => {
    const { svc, repo } = newService();
    const draft = await makeDraft(svc, repo);
    const issued = await svc.issue(ADMIN, draft.id, draft.version);
    await expect(svc.issue(ADMIN, issued.id, issued.version)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
  });
});

// ── void ────────────────────────────────────────────────────────────────────

describe("credit-note void", () => {
  it("voids an issued credit note (retained for audit)", async () => {
    const { svc, repo, events } = newService();
    const draft = await makeDraft(svc, repo);
    const issued = await svc.issue(ADMIN, draft.id, draft.version);
    const voided = await svc.void(ADMIN, issued.id, issued.version);
    expect(voided.status).toBe("void");
    expect(events.map((e) => e.name)).toContain("creditNote.void");
  });

  it("cannot void an already-void credit note → INVALID_STATE_TRANSITION", async () => {
    const { svc, repo } = newService();
    const draft = await makeDraft(svc, repo);
    const issued = await svc.issue(ADMIN, draft.id, draft.version);
    const voided = await svc.void(ADMIN, issued.id, issued.version);
    await expect(svc.void(ADMIN, voided.id, voided.version)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
  });
});

// ── Capability gating (softDelete → canPermanentlyDelete) ───────────────────────

describe("credit-note capability gating", () => {
  it("denies softDelete for a member lacking canPermanentlyDelete → CAPABILITY_DENIED", async () => {
    const { svc, repo } = newService();
    const draft = await makeDraft(svc, repo);
    await expect(svc.softDelete(MEMBER, draft.id)).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
  });

  it("allows softDelete for an administrator", async () => {
    const { svc, repo } = newService();
    const draft = await makeDraft(svc, repo);
    await expect(svc.softDelete(ADMIN, draft.id)).resolves.toBeUndefined();
    expect(await repo.findById(ADMIN, draft.id)).toBeNull();
  });
});

// ── List scoping (accountId isolation) ──────────────────────────────────────

describe("credit-note list scoping", () => {
  it("only returns credit notes within the caller's accountId", async () => {
    const { svc } = newService();
    await svc.create(ADMIN, CreditNoteCreateSchema.parse(CREATE_INPUT));
    await svc.create(ADMIN, CreditNoteCreateSchema.parse(CREATE_INPUT));
    const OTHER: AuthContext = { ...ADMIN, accountId: "other-org" };

    const mine = await svc.list(ADMIN, {});
    expect(mine.items).toHaveLength(2);
    expect(mine.meta.total).toBe(2);

    const theirs = await svc.list(OTHER, {});
    expect(theirs.items).toHaveLength(0);
    expect(theirs.meta.total).toBe(0);
  });
});

// ── Financial stripping (SEC5 — top-level + nested line money) ──────────────────

describe("stripCreditNoteFinancial", () => {
  it("keeps all money for a financial-capable caller", async () => {
    const { svc } = newService();
    const cn = await svc.create(ADMIN, CreditNoteCreateSchema.parse(CREATE_INPUT));
    const out = stripCreditNoteFinancial(ADMIN, cn);
    expect(out.grandTotalMinor).toBe(2450);
    expect(out.lineItems[0]!.lineTotalMinor).toBeDefined();
  });

  it("strips top-level *Minor AND nested line money for a member", async () => {
    const { svc } = newService();
    const cn = await svc.create(ADMIN, CreditNoteCreateSchema.parse(CREATE_INPUT));
    const out = stripCreditNoteFinancial(MEMBER, cn) as unknown as Record<string, unknown>;
    for (const f of ["subtotalMinor", "discountMinor", "taxMinor", "grandTotalMinor"]) {
      expect(f in out).toBe(false);
    }
    const line = (out.lineItems as Record<string, unknown>[])[0]!;
    for (const f of ["unitPriceMinor", "lineSubtotalMinor", "lineDiscountMinor", "lineTaxMinor", "lineTotalMinor"]) {
      expect(f in line).toBe(false);
    }
    expect(line.description).toBe("Refund consulting"); // non-money fields survive
  });
});
