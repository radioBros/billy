import { describe, it, expect } from "vitest";
import type { Collection } from "mongodb";
import { createLogger, AppError } from "@billy/shared";
import type { AuthContext, BaseDoc } from "@billy/types";
import type { DomainEvent, DomainEventEmitter } from "@/platform/service.js";
import { ProformaRepository } from "@/modules/proforma/repository.js";
import { ProformaService, type ClientRecord } from "@/modules/proforma/service.js";
import { ProformaCreateSchema } from "@/modules/proforma/schema.js";
import { stripProformaFinancial } from "@/modules/proforma/routes.js";
import type { Proforma } from "@/modules/proforma/types.js";

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
 * In-memory ProformaRepository. Extends the real class (protected members prevent a
 * structural fake). Filters by `accountId` so list-scoping is exercised.
 */
class FakeProformaRepository extends ProformaRepository {
  readonly byId = new Map<string, Proforma & { accountId: string }>();
  private seq = 0;

  constructor() {
    super(undefined as unknown as Collection<Proforma>);
  }

  override async findById(ctx: AuthContext, id: string): Promise<Proforma | null> {
    const doc = this.byId.get(id);
    return doc && !doc.deletedAt && doc.accountId === ctx.accountId ? doc : null;
  }

  override async list(
    ctx: AuthContext,
    _raw: Record<string, string | string[] | undefined>,
    _whitelist: unknown,
  ): Promise<{ items: Proforma[]; parsed: never; total: number }> {
    const items = [...this.byId.values()].filter(
      (d) => !d.deletedAt && !d.archivedAt && d.accountId === ctx.accountId,
    );
    const parsed = { page: 1, limit: 20, sortSpec: [], q: undefined } as unknown as never;
    return { items, parsed, total: items.length };
  }

  override async insert(ctx: AuthContext, data: Omit<Proforma, keyof BaseDoc>): Promise<Proforma> {
    const ts = new Date().toISOString();
    const doc = {
      ...(data as object),
      id: `pro-${++this.seq}`,
      version: 1,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      deletedAt: null,
      accountId: ctx.accountId,
    } as Proforma & { accountId: string };
    this.byId.set(doc.id, doc);
    return doc;
  }

  override async updateVersioned(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    patch: Partial<Proforma>,
  ): Promise<Proforma> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt || doc.accountId !== ctx.accountId) throw notFound();
    if (doc.archivedAt) throw notFound();
    if (doc.version !== expectedVersion) throw versionConflict();
    const next = {
      ...doc,
      ...patch,
      version: doc.version + 1,
      updatedAt: new Date().toISOString(),
    } as Proforma & { accountId: string };
    this.byId.set(id, next);
    return next;
  }

  override async replaceState(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    patch: Partial<Proforma>,
  ): Promise<Proforma> {
    return this.updateVersioned(ctx, id, expectedVersion, patch);
  }

  override async archive(ctx: AuthContext, id: string, expectedVersion: number): Promise<Proforma> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt || doc.accountId !== ctx.accountId) throw notFound();
    if (doc.version !== expectedVersion) throw versionConflict();
    const next = { ...doc, archivedAt: new Date().toISOString(), version: doc.version + 1 };
    this.byId.set(id, next);
    return next;
  }

  override async restore(ctx: AuthContext, id: string, expectedVersion: number): Promise<Proforma> {
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
  const repo = new FakeProformaRepository();
  const { emitter, events } = newEmitter();
  let counter = 0;
  const svc = new ProformaService({
    repo,
    emitter,
    logger,
    loadClient: async (_ctx, clientId) => (clientId === CLIENT.id ? CLIENT : null),
    nextProformaNumber: async (_accountId, year) => `PRO-${year}-${String(++counter).padStart(4, "0")}`,
  });
  return { repo, svc, events };
};

const newServiceWithConvert = () => {
  const repo = new FakeProformaRepository();
  const { emitter, events } = newEmitter();
  let counter = 0;
  const invoices = new Map<string, { id: string } & Record<string, unknown>>();
  const mints: Record<string, unknown>[] = [];
  let invSeq = 0;
  const svc = new ProformaService({
    repo,
    emitter,
    logger,
    loadClient: async (_ctx, clientId) => (clientId === CLIENT.id ? CLIENT : null),
    nextProformaNumber: async (_accountId, year) => `PRO-${year}-${String(++counter).padStart(4, "0")}`,
    mintInvoiceFromProforma: async (_ctx, data) => {
      mints.push({ ...data });
      const inv = { id: `inv-${++invSeq}`, status: "draft", ...data };
      invoices.set(inv.id, inv);
      return inv;
    },
    loadInvoice: async (_ctx, invoiceId) => invoices.get(invoiceId) ?? null,
  });
  return { repo, svc, events, invoices, mints };
};

// Line 1: qty 2 × 1000 = 2000, 10% tax = 200 → 2200.
// Line 2: qty 1 × 500, 50% discount = 250, no tax → 250. grandTotal = 2450.
const CREATE_INPUT = {
  clientId: "c".repeat(24),
  currency: "EUR",
  issueDate: "2026-01-10",
  expiryDate: "2026-02-10",
  lineItems: [
    { description: "Consulting", quantity: 2, unitPriceMinor: 1000, taxRate: 10 },
    { description: "Discounted item", quantity: 1, unitPriceMinor: 500, discountRate: 50 },
  ],
  notes: "Preview",
} as const;

const makeDraft = async (svc: ProformaService, repo: FakeProformaRepository) => {
  const draft = await svc.create(ADMIN, ProformaCreateSchema.parse(CREATE_INPUT));
  repo.byId.set(draft.id, { ...repo.byId.get(draft.id)!, clientId: CLIENT.id });
  return repo.byId.get(draft.id)!;
};

// ── Schema ────────────────────────────────────────────────────────────────────

describe("proforma schema", () => {
  it("accepts a valid create payload", () => {
    expect(ProformaCreateSchema.safeParse(CREATE_INPUT).success).toBe(true);
  });

  it("accepts an omitted expiryDate (optional)", () => {
    const { expiryDate: _drop, ...noExpiry } = CREATE_INPUT;
    void _drop;
    expect(ProformaCreateSchema.safeParse(noExpiry).success).toBe(true);
  });

  it("rejects expiryDate before issueDate (expiryOnOrAfterIssue)", () => {
    const r = ProformaCreateSchema.safeParse({ ...CREATE_INPUT, expiryDate: "2026-01-01" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.join(".") === "expiryDate")).toBe(true);
  });

  it("requires at least one line item", () => {
    expect(ProformaCreateSchema.safeParse({ ...CREATE_INPUT, lineItems: [] }).success).toBe(false);
  });
});

// ── Server-recomputed totals ───────────────────────────────────────────────────

describe("proforma totals — server recompute (never trust client)", () => {
  it("computes subtotal/discount/tax/grandTotal from line items; no balance fields", async () => {
    const { svc } = newService();
    const pro = await svc.create(ADMIN, ProformaCreateSchema.parse(CREATE_INPUT));
    expect(pro.subtotalMinor).toBe(2500);
    expect(pro.discountMinor).toBe(250);
    expect(pro.taxMinor).toBe(200);
    expect(pro.grandTotalMinor).toBe(2450);
    expect(pro.status).toBe("draft");
    expect(pro.proformaNumber).toBeNull();
    // NON-FISCAL: never carries payment/balance fields.
    expect("amountPaidMinor" in pro).toBe(false);
    expect("amountDueMinor" in pro).toBe(false);
  });

  it("ignores client-sent totals and recomputes on update", async () => {
    const { svc } = newService();
    const pro = await svc.create(ADMIN, ProformaCreateSchema.parse(CREATE_INPUT));
    const updated = await svc.update(ADMIN, pro.id, pro.version, {
      lineItems: [{ description: "X", quantity: 1, unitPriceMinor: 999 }],
      // @ts-expect-error client cannot set totals
      grandTotalMinor: 1,
    });
    expect(updated.grandTotalMinor).toBe(999);
    expect(updated.subtotalMinor).toBe(999);
  });
});

// ── Issue: number + snapshot + lock ─────────────────────────────────────────────

describe("proforma issue transition", () => {
  it("assigns a PRO- number, snapshots the client, and moves draft→issued", async () => {
    const { svc, repo, events } = newService();
    const draft = await makeDraft(svc, repo);
    const issued = await svc.issue(ADMIN, draft.id, draft.version);
    expect(issued.status).toBe("issued");
    expect(issued.proformaNumber).toBe("PRO-2026-0001");
    expect(issued.clientSnapshot?.displayName).toBe("Acme SpA");
    expect(issued.clientSnapshot?.currency).toBe("EUR");
    expect(events.map((e) => e.name)).toContain("proforma.issued");
  });

  it("blocks editing an issued proforma → INVOICE_NOT_EDITABLE", async () => {
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

// ── markConverted (in-module half of PR7 convert) ───────────────────────────────

describe("proforma markConverted", () => {
  it("records convertedInvoiceId on an issued proforma", async () => {
    const { svc, repo, events } = newService();
    const draft = await makeDraft(svc, repo);
    const issued = await svc.issue(ADMIN, draft.id, draft.version);
    const converted = await svc.markConverted(ADMIN, issued.id, issued.version, "inv-999");
    expect(converted.convertedInvoiceId).toBe("inv-999");
    // The PRO- number is preserved — never reused as an INV- number.
    expect(converted.proformaNumber).toBe("PRO-2026-0001");
    expect(events.map((e) => e.name)).toContain("proforma.converted");
  });

  it("rejects converting a draft proforma → INVALID_STATE_TRANSITION", async () => {
    const { svc, repo } = newService();
    const draft = await makeDraft(svc, repo);
    await expect(svc.markConverted(ADMIN, draft.id, draft.version, "inv-1")).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
  });
});

// ── convert (full PR7: mint a DRAFT invoice from an issued proforma) ────────────

describe("proforma convert", () => {
  it("mints a DRAFT invoice from an issued proforma and sets convertedInvoiceId", async () => {
    const { svc, repo, events, mints } = newServiceWithConvert();
    const draft = await makeDraft(svc, repo);
    const issued = await svc.issue(ADMIN, draft.id, draft.version);

    const { invoice, proforma } = await svc.convert(ADMIN, issued.id, issued.version);
    expect(invoice.id).toBe("inv-1");
    expect(proforma.convertedInvoiceId).toBe("inv-1");
    // Minted from the proforma's clientId + line items (client re-snapshots at finalize).
    expect(mints).toHaveLength(1);
    expect(mints[0]).toMatchObject({ clientId: CLIENT.id, currency: "EUR" });
    expect((mints[0]!.lineItems as unknown[])).toHaveLength(2);
    expect(events.map((e) => e.name)).toContain("proforma.converted");
  });

  it("is IDEMPOTENT: converting twice returns the same invoice and mints only once", async () => {
    const { svc, repo, mints } = newServiceWithConvert();
    const draft = await makeDraft(svc, repo);
    const issued = await svc.issue(ADMIN, draft.id, draft.version);

    const first = await svc.convert(ADMIN, issued.id, issued.version);
    // Second call uses the post-convert version; must NOT mint again.
    const afterFirst = await svc.get(ADMIN, issued.id);
    const second = await svc.convert(ADMIN, afterFirst.id, afterFirst.version);

    expect(second.invoice.id).toBe(first.invoice.id);
    expect(mints).toHaveLength(1);
    // Replay does not bump the proforma version again (no second markConverted).
    expect(second.proforma.version).toBe(afterFirst.version);
  });

  it("rejects converting a draft proforma → INVALID_STATE_TRANSITION", async () => {
    const { svc, repo } = newServiceWithConvert();
    const draft = await makeDraft(svc, repo);
    await expect(svc.convert(ADMIN, draft.id, draft.version)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
  });

  it("rejects converting a void proforma → INVALID_STATE_TRANSITION", async () => {
    const { svc, repo } = newServiceWithConvert();
    const draft = await makeDraft(svc, repo);
    const voided = await svc.void(ADMIN, draft.id, draft.version);
    await expect(svc.convert(ADMIN, voided.id, voided.version)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
  });

  it("throws internal when the convert ports are unwired (back-compat)", async () => {
    const { svc, repo } = newService();
    const draft = await makeDraft(svc, repo);
    const issued = await svc.issue(ADMIN, draft.id, draft.version);
    await expect(svc.convert(ADMIN, issued.id, issued.version)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });
});

// ── void ────────────────────────────────────────────────────────────────────

describe("proforma void", () => {
  it("voids an issued proforma", async () => {
    const { svc, repo, events } = newService();
    const draft = await makeDraft(svc, repo);
    const issued = await svc.issue(ADMIN, draft.id, draft.version);
    const voided = await svc.void(ADMIN, issued.id, issued.version);
    expect(voided.status).toBe("void");
    expect(events.map((e) => e.name)).toContain("proforma.void");
  });
});

// ── Capability gating (softDelete → canPermanentlyDelete) ───────────────────────

describe("proforma capability gating", () => {
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

describe("proforma list scoping", () => {
  it("only returns proformas within the caller's accountId", async () => {
    const { svc } = newService();
    await svc.create(ADMIN, ProformaCreateSchema.parse(CREATE_INPUT));
    await svc.create(ADMIN, ProformaCreateSchema.parse(CREATE_INPUT));
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

describe("stripProformaFinancial", () => {
  it("keeps all money for a financial-capable caller", async () => {
    const { svc } = newService();
    const pro = await svc.create(ADMIN, ProformaCreateSchema.parse(CREATE_INPUT));
    const out = stripProformaFinancial(ADMIN, pro);
    expect(out.grandTotalMinor).toBe(2450);
    expect(out.lineItems[0]!.lineTotalMinor).toBeDefined();
  });

  it("strips top-level *Minor AND nested line money for a member", async () => {
    const { svc } = newService();
    const pro = await svc.create(ADMIN, ProformaCreateSchema.parse(CREATE_INPUT));
    const out = stripProformaFinancial(MEMBER, pro) as unknown as Record<string, unknown>;
    for (const f of ["subtotalMinor", "discountMinor", "taxMinor", "grandTotalMinor"]) {
      expect(f in out).toBe(false);
    }
    const line = (out.lineItems as Record<string, unknown>[])[0]!;
    for (const f of ["unitPriceMinor", "lineSubtotalMinor", "lineDiscountMinor", "lineTaxMinor", "lineTotalMinor"]) {
      expect(f in line).toBe(false);
    }
    expect(line.description).toBe("Consulting"); // non-money fields survive
  });
});
