import { describe, it, expect } from "vitest";
import type { Collection, Db } from "mongodb";
import { createLogger, AppError } from "@billy/shared";
import type { AuthContext, BaseDoc } from "@billy/types";
import type { DomainEvent, DomainEventEmitter } from "@/platform/service.js";
import { InvoiceRepository } from "@/modules/invoices/repository.js";
import { InvoiceService, type BankAccountRecord, type ClientRecord } from "@/modules/invoices/service.js";
import { InvoiceCreateSchema, AddPaymentSchema, CreateFromQuoteSchema } from "@/modules/invoices/schema.js";
import { stripInvoiceFinancial } from "@/modules/invoices/routes.js";
import type { Invoice } from "@/modules/invoices/types.js";
import {
  ShareTokenStore,
  hashToken,
  SHARE_TOKENS_COLLECTION,
  type ShareToken,
} from "@/modules/public-links/share-tokens.js";

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
 * In-memory InvoiceRepository. Extends the real class (protected members prevent
 * a structural fake), passing a dummy collection to super and overriding every
 * public method against a Map.
 */
class FakeInvoiceRepository extends InvoiceRepository {
  readonly byId = new Map<string, Invoice>();
  private seq = 0;

  constructor() {
    super(undefined as unknown as Collection<Invoice>);
  }

  override async findById(_ctx: AuthContext, id: string): Promise<Invoice | null> {
    const doc = this.byId.get(id);
    return doc && !doc.deletedAt ? doc : null;
  }

  override async insert(_ctx: AuthContext, data: Omit<Invoice, keyof BaseDoc>): Promise<Invoice> {
    const ts = new Date().toISOString();
    const doc = {
      ...(data as object),
      id: `inv-${++this.seq}`,
      version: 1,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      deletedAt: null,
    } as Invoice;
    this.byId.set(doc.id, doc);
    return doc;
  }

  override async updateVersioned(
    _ctx: AuthContext,
    id: string,
    expectedVersion: number,
    patch: Partial<Invoice>,
  ): Promise<Invoice> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt) throw notFound();
    if (doc.archivedAt) throw notFound();
    if (doc.version !== expectedVersion) throw versionConflict();
    const next = { ...doc, ...patch, version: doc.version + 1, updatedAt: new Date().toISOString() } as Invoice;
    this.byId.set(id, next);
    return next;
  }

  override async replaceState(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    patch: Partial<Invoice>,
  ): Promise<Invoice> {
    return this.updateVersioned(ctx, id, expectedVersion, patch);
  }

  override async archive(_ctx: AuthContext, id: string, expectedVersion: number): Promise<Invoice> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt) throw notFound();
    if (doc.version !== expectedVersion) throw versionConflict();
    const next = { ...doc, archivedAt: new Date().toISOString(), version: doc.version + 1 } as Invoice;
    this.byId.set(id, next);
    return next;
  }

  override async restore(_ctx: AuthContext, id: string, expectedVersion: number): Promise<Invoice> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt || !doc.archivedAt) throw notFound();
    if (doc.version !== expectedVersion) throw versionConflict();
    const next = { ...doc, archivedAt: null, version: doc.version + 1 } as Invoice;
    this.byId.set(id, next);
    return next;
  }

  override async softDelete(_ctx: AuthContext, id: string): Promise<void> {
    const doc = this.byId.get(id);
    if (doc) this.byId.set(id, { ...doc, deletedAt: new Date().toISOString() });
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

const tokenMatches = (doc: Record<string, unknown>, filter: Record<string, unknown>): boolean => {
  return Object.entries(filter).every(([k, cond]) => doc[k] === cond);
};

const fakeShareTokenDb = (): { db: Db; rows: ShareToken[] } => {
  const rows: ShareToken[] = [];
  const collection = {
    async createIndex() {
      return "idx";
    },
    async insertOne(doc: ShareToken) {
      rows.push(doc);
      return { insertedId: doc.tokenHash };
    },
    async deleteMany(filter: Record<string, unknown>) {
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (tokenMatches(rows[i] as unknown as Record<string, unknown>, filter)) {
          rows.splice(i, 1);
          n++;
        }
      }
      return { deletedCount: n };
    },
    async findOne(filter: Record<string, unknown>) {
      return rows.find((r) => tokenMatches(r as unknown as Record<string, unknown>, filter)) ?? null;
    },
  };
  const db = {
    collection(name: string) {
      if (name === SHARE_TOKENS_COLLECTION) return collection;
      throw new Error(`unexpected collection ${name}`);
    },
  } as unknown as Db;
  return { db, rows };
};

const newService = (opts: { tolerance?: number } = {}) => {
  const repo = new FakeInvoiceRepository();
  const { emitter, events } = newEmitter();
  let counter = 0;
  const { db: tokenDb, rows: tokenRows } = fakeShareTokenDb();
  const shareTokens = new ShareTokenStore(tokenDb);
  const svc = new InvoiceService({
    repo,
    emitter,
    logger,
    loadClient: async (_ctx, clientId) => (clientId === CLIENT.id ? CLIENT : null),
    nextInvoiceNumber: async (_accountId, year) => `INV-${year}-${String(++counter).padStart(4, "0")}`,
    overpaymentToleranceMinor: opts.tolerance ?? 0,
    shareTokens,
  });
  return { repo, svc, events, shareTokens, tokenRows };
};

const newServiceWithBanks = (accounts: BankAccountRecord[]) => {
  const repo = new FakeInvoiceRepository();
  const { emitter, events } = newEmitter();
  let counter = 0;
  const svc = new InvoiceService({
    repo,
    emitter,
    logger,
    loadClient: async (_ctx, clientId) => (clientId === CLIENT.id ? CLIENT : null),
    nextInvoiceNumber: async (_accountId, year) => `INV-${year}-${String(++counter).padStart(4, "0")}`,
    loadBankAccounts: async () => accounts,
  });
  return { repo, svc, events };
};

// A valid create input: two lines. Line 1: qty 2 × 1000 = 2000, 10% tax = 200 → 2200.
// Line 2: qty 1 × 500, 50% discount = 250, no tax → 250. grandTotal = 2450.
const CREATE_INPUT = {
  clientId: "c".repeat(24),
  currency: "EUR",
  issueDate: "2026-01-10",
  dueDate: "2026-02-10",
  lineItems: [
    { description: "Consulting", quantity: 2, unitPriceMinor: 1000, taxRate: 10 },
    { description: "Discounted item", quantity: 1, unitPriceMinor: 500, discountRate: 50 },
  ],
  notes: "Thanks",
} as const;

const makeDraft = async (svc: InvoiceService, repo: FakeInvoiceRepository) => {
  const draft = await svc.create(ADMIN, InvoiceCreateSchema.parse(CREATE_INPUT));
  // Point clientId at the fake client so finalize's loadClient resolves.
  repo.byId.set(draft.id, { ...repo.byId.get(draft.id)!, clientId: CLIENT.id });
  return repo.byId.get(draft.id)!;
};

// ── Schema ────────────────────────────────────────────────────────────────────

describe("invoice schema", () => {
  it("accepts a valid create payload and defaults", () => {
    const r = InvoiceCreateSchema.safeParse(CREATE_INPUT);
    expect(r.success).toBe(true);
  });

  it("rejects dueDate before issueDate (§37 dueOnOrAfterIssue)", () => {
    const r = InvoiceCreateSchema.safeParse({ ...CREATE_INPUT, dueDate: "2026-01-01" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.join(".") === "dueDate")).toBe(true);
  });

  it("requires at least one line item", () => {
    const r = InvoiceCreateSchema.safeParse({ ...CREATE_INPUT, lineItems: [] });
    expect(r.success).toBe(false);
  });

  it("addPayment schema rejects non-positive amounts (isPositiveAmount)", () => {
    expect(AddPaymentSchema.safeParse({ amountMinor: 0, date: "2026-02-01", method: "card" }).success).toBe(false);
    expect(AddPaymentSchema.safeParse({ amountMinor: -5, date: "2026-02-01", method: "card" }).success).toBe(false);
    expect(AddPaymentSchema.safeParse({ amountMinor: 100, date: "2026-02-01", method: "card" }).success).toBe(true);
  });
});

// ── Server-recomputed totals ───────────────────────────────────────────────────

describe("invoice totals — server recompute (never trust client)", () => {
  it("persists an optional projectId (round-trip)", async () => {
    const { svc } = newService();
    const pid = "abcdef012345678901234567"; // valid 24-char hex ObjectId
    const inv = await svc.create(ADMIN, InvoiceCreateSchema.parse({ ...CREATE_INPUT, projectId: pid }));
    expect(inv.projectId).toBe(pid);
    // Omitted → null, never undefined-dropped.
    const inv2 = await svc.create(ADMIN, InvoiceCreateSchema.parse(CREATE_INPUT));
    expect(inv2.projectId).toBeNull();
  });

  it("computes subtotal/discount/tax/grandTotal from line items", async () => {
    const { svc } = newService();
    const inv = await svc.create(ADMIN, InvoiceCreateSchema.parse(CREATE_INPUT));
    expect(inv.subtotalMinor).toBe(2500); // 2000 + 500
    expect(inv.discountMinor).toBe(250); // 0 + 250
    expect(inv.taxMinor).toBe(200); // 200 + 0
    expect(inv.grandTotalMinor).toBe(2450); // 2200 + 250
    expect(inv.amountPaidMinor).toBe(0);
    expect(inv.amountDueMinor).toBe(2450);
    expect(inv.status).toBe("draft");
    expect(inv.invoiceNumber).toBeNull();
  });

  it("ignores any client-sent totals and recomputes on update", async () => {
    const { svc } = newService();
    const inv = await svc.create(ADMIN, InvoiceCreateSchema.parse(CREATE_INPUT));
    // Attempt to inject bogus totals via a raw cast — service must ignore them.
    const updated = await svc.update(ADMIN, inv.id, inv.version, {
      lineItems: [{ description: "X", quantity: 1, unitPriceMinor: 999 }],
      // @ts-expect-error client cannot set totals
      grandTotalMinor: 1,
    });
    expect(updated.grandTotalMinor).toBe(999);
    expect(updated.subtotalMinor).toBe(999);
  });
});

// ── Multi-bank: bankSnapshot at create ──────────────────────────────────────────

describe("invoice bankSnapshot (multi-bank, snapshot-not-reference)", () => {
  const ACCOUNTS: BankAccountRecord[] = [
    { id: "bank-a", label: "Main EUR", details: "IBAN IT00\nBIC ABCDIT22" },
    { id: "bank-b", label: "USD account", details: "IBAN US11\nBIC XYZUS33" },
  ];

  it("snapshots the chosen account when bankAccountId is provided", async () => {
    const { svc } = newServiceWithBanks(ACCOUNTS);
    const inv = await svc.create(ADMIN, InvoiceCreateSchema.parse({ ...CREATE_INPUT, bankAccountId: "bank-b" }));
    expect(inv.bankSnapshot).toEqual({ label: "USD account", details: "IBAN US11\nBIC XYZUS33" });
  });

  it("auto-defaults to the single account when exactly one exists and no id is given", async () => {
    const { svc } = newServiceWithBanks([ACCOUNTS[0]!]);
    const inv = await svc.create(ADMIN, InvoiceCreateSchema.parse(CREATE_INPUT));
    expect(inv.bankSnapshot).toEqual({ label: "Main EUR", details: "IBAN IT00\nBIC ABCDIT22" });
  });

  it("leaves bankSnapshot null when no account exists", async () => {
    const { svc } = newServiceWithBanks([]);
    const inv = await svc.create(ADMIN, InvoiceCreateSchema.parse(CREATE_INPUT));
    expect(inv.bankSnapshot).toBeNull();
  });

  it("leaves bankSnapshot null when >1 account and no id is given (ambiguous)", async () => {
    const { svc } = newServiceWithBanks(ACCOUNTS);
    const inv = await svc.create(ADMIN, InvoiceCreateSchema.parse(CREATE_INPUT));
    expect(inv.bankSnapshot).toBeNull();
  });

  it("leaves bankSnapshot null when the loader is unwired (back-compat)", async () => {
    const { svc } = newService();
    const inv = await svc.create(ADMIN, InvoiceCreateSchema.parse({ ...CREATE_INPUT, bankAccountId: "bank-a" }));
    expect(inv.bankSnapshot).toBeNull();
  });

  it("does not persist bankAccountId on the invoice (only the snapshot)", async () => {
    const { svc } = newServiceWithBanks(ACCOUNTS);
    const inv = await svc.create(ADMIN, InvoiceCreateSchema.parse({ ...CREATE_INPUT, bankAccountId: "bank-a" }));
    expect("bankAccountId" in (inv as unknown as Record<string, unknown>)).toBe(false);
  });
});

// ── Finalize: number + snapshot + lock ─────────────────────────────────────────

describe("invoice finalize", () => {
  it("assigns a number, snapshots the client, and moves draft→finalized", async () => {
    const { svc, repo, events } = newService();
    const draft = await makeDraft(svc, repo);
    const finalized = await svc.finalize(ADMIN, draft.id, draft.version);
    expect(finalized.status).toBe("finalized");
    expect(finalized.invoiceNumber).toBe("INV-2026-0001");
    expect(finalized.clientSnapshot?.displayName).toBe("Acme SpA");
    expect(finalized.clientSnapshot?.vatNumber).toBe("IT12345678901");
    expect(finalized.clientSnapshot?.currency).toBe("EUR");
    expect(events.map((e) => e.name)).toContain("invoice.finalized");
  });

  it("blocks editing a finalized invoice → INVOICE_NOT_EDITABLE", async () => {
    const { svc, repo } = newService();
    const draft = await makeDraft(svc, repo);
    const finalized = await svc.finalize(ADMIN, draft.id, draft.version);
    await expect(
      svc.update(ADMIN, finalized.id, finalized.version, { notes: "late edit" }),
    ).rejects.toMatchObject({ code: "INVOICE_NOT_EDITABLE" });
  });

  it("rejects re-finalize → INVOICE_ALREADY_FINALIZED", async () => {
    const { svc, repo } = newService();
    const draft = await makeDraft(svc, repo);
    const finalized = await svc.finalize(ADMIN, draft.id, draft.version);
    await expect(svc.finalize(ADMIN, finalized.id, finalized.version)).rejects.toMatchObject({
      code: "INVOICE_ALREADY_FINALIZED",
    });
  });
});

// ── Payments: recompute amountDue, guards, status derivation ────────────────────

describe("invoice payments", () => {
  async function finalizedInvoice(tolerance = 0) {
    const { svc, repo, events } = newService({ tolerance });
    const draft = await makeDraft(svc, repo);
    const finalized = await svc.finalize(ADMIN, draft.id, draft.version);
    return { svc, repo, events, finalized };
  }

  it("partial payment → partially_paid, recomputes amountDue", async () => {
    const { svc, finalized } = await finalizedInvoice();
    const paid = await svc.addPayment(ADMIN, finalized.id, finalized.version, {
      amountMinor: 1000,
      date: "2026-02-01",
      method: "bank_transfer",
    });
    expect(paid.status).toBe("partially_paid");
    expect(paid.amountPaidMinor).toBe(1000);
    expect(paid.amountDueMinor).toBe(1450); // 2450 - 1000
    expect(paid.payments).toHaveLength(1);
  });

  it("full payment → paid (single shot finalized→paid), amountDue 0", async () => {
    const { svc, events, finalized } = await finalizedInvoice();
    const paid = await svc.addPayment(ADMIN, finalized.id, finalized.version, {
      amountMinor: 2450,
      date: "2026-02-01",
      method: "card",
    });
    expect(paid.status).toBe("paid");
    expect(paid.amountPaidMinor).toBe(2450);
    expect(paid.amountDueMinor).toBe(0);
    expect(events.map((e) => e.name)).toContain("invoice.paid");
  });

  it("PAYMENT_EXCEEDS_TOTAL beyond tolerance", async () => {
    const { svc, finalized } = await finalizedInvoice();
    await expect(
      svc.addPayment(ADMIN, finalized.id, finalized.version, {
        amountMinor: 2451,
        date: "2026-02-01",
        method: "cash",
      }),
    ).rejects.toMatchObject({ code: "PAYMENT_EXCEEDS_TOTAL" });
  });

  it("overpayment within tolerance is accepted and marks paid", async () => {
    const { svc, finalized } = await finalizedInvoice(100);
    const paid = await svc.addPayment(ADMIN, finalized.id, finalized.version, {
      amountMinor: 2500, // 2450 + 50, within tolerance 100
      date: "2026-02-01",
      method: "cash",
    });
    expect(paid.status).toBe("paid");
    expect(paid.amountDueMinor).toBe(-50);
  });

  it("adding a payment to a fully-paid invoice → INVOICE_ALREADY_PAID", async () => {
    const { svc, finalized } = await finalizedInvoice();
    const paid = await svc.addPayment(ADMIN, finalized.id, finalized.version, {
      amountMinor: 2450,
      date: "2026-02-01",
      method: "card",
    });
    await expect(
      svc.addPayment(ADMIN, paid.id, paid.version, { amountMinor: 1, date: "2026-02-02", method: "cash" }),
    ).rejects.toMatchObject({ code: "INVOICE_ALREADY_PAID" });
  });

  it("cannot pay a draft invoice", async () => {
    const { svc, repo } = newService();
    const draft = await makeDraft(svc, repo);
    await expect(
      svc.addPayment(ADMIN, draft.id, draft.version, { amountMinor: 100, date: "2026-02-01", method: "cash" }),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  it("removePayment recomputes and reverts status (paid→finalized on zero)", async () => {
    const { svc, finalized } = await finalizedInvoice();
    const paid = await svc.addPayment(ADMIN, finalized.id, finalized.version, {
      amountMinor: 2450,
      date: "2026-02-01",
      method: "card",
    });
    const paymentId = paid.payments[0]!.id;
    const after = await svc.removePayment(ADMIN, paid.id, paid.version, paymentId);
    expect(after.status).toBe("finalized");
    expect(after.amountPaidMinor).toBe(0);
    expect(after.amountDueMinor).toBe(2450);
    expect(after.payments).toHaveLength(0);
  });
});

// ── void ────────────────────────────────────────────────────────────────────

describe("invoice void", () => {
  it("voids a finalized invoice", async () => {
    const { svc, repo, events } = newService();
    const draft = await makeDraft(svc, repo);
    const finalized = await svc.finalize(ADMIN, draft.id, draft.version);
    const voided = await svc.void(ADMIN, finalized.id, finalized.version);
    expect(voided.status).toBe("void");
    expect(events.map((e) => e.name)).toContain("invoice.void");
  });

  it("cannot void a paid invoice → INVOICE_ALREADY_PAID", async () => {
    const { svc, repo } = newService();
    const draft = await makeDraft(svc, repo);
    const finalized = await svc.finalize(ADMIN, draft.id, draft.version);
    const paid = await svc.addPayment(ADMIN, finalized.id, finalized.version, {
      amountMinor: 2450,
      date: "2026-02-01",
      method: "card",
    });
    await expect(svc.void(ADMIN, paid.id, paid.version)).rejects.toMatchObject({
      code: "INVOICE_ALREADY_PAID",
    });
  });

  it("removePayment on a voided invoice keeps status void (no resurrection)", async () => {
    const { svc, repo } = newService();
    const draft = await makeDraft(svc, repo);
    const finalized = await svc.finalize(ADMIN, draft.id, draft.version);
    const partial = await svc.addPayment(ADMIN, finalized.id, finalized.version, {
      amountMinor: 1000,
      date: "2026-02-01",
      method: "cash",
    });
    const voided = await svc.void(ADMIN, partial.id, partial.version);
    expect(voided.status).toBe("void");
    expect(voided.payments).toHaveLength(1); // retained for audit
    const after = await svc.removePayment(ADMIN, voided.id, voided.version, voided.payments[0]!.id);
    expect(after.status).toBe("void");
  });
});

// ── Financial stripping (SEC5 — top-level + nested line/payment money) ──────────

describe("stripInvoiceFinancial", () => {
  it("keeps all money for a financial-capable caller", async () => {
    const { svc, repo } = newService();
    const draft = await makeDraft(svc, repo);
    const finalized = await svc.finalize(ADMIN, draft.id, draft.version);
    const paid = await svc.addPayment(ADMIN, finalized.id, finalized.version, {
      amountMinor: 100,
      date: "2026-02-01",
      method: "cash",
    });
    const out = stripInvoiceFinancial(ADMIN, paid);
    expect(out.grandTotalMinor).toBe(2450);
    expect(out.lineItems[0]!.lineTotalMinor).toBeDefined();
    expect(out.payments[0]!.amountMinor).toBe(100);
  });

  it("strips top-level *Minor AND nested line/payment money for a member", async () => {
    const { svc, repo } = newService();
    const draft = await makeDraft(svc, repo);
    const finalized = await svc.finalize(ADMIN, draft.id, draft.version);
    const paid = await svc.addPayment(ADMIN, finalized.id, finalized.version, {
      amountMinor: 100,
      date: "2026-02-01",
      method: "cash",
    });
    const out = stripInvoiceFinancial(MEMBER, paid) as unknown as Record<string, unknown>;
    // top-level
    for (const f of ["subtotalMinor", "discountMinor", "taxMinor", "grandTotalMinor", "amountPaidMinor", "amountDueMinor"]) {
      expect(f in out).toBe(false);
    }
    // nested line money
    const line = (out.lineItems as Record<string, unknown>[])[0]!;
    for (const f of ["unitPriceMinor", "lineSubtotalMinor", "lineDiscountMinor", "lineTaxMinor", "lineTotalMinor"]) {
      expect(f in line).toBe(false);
    }
    expect(line.description).toBe("Consulting"); // non-money fields survive
    // nested payment money
    const pay = (out.payments as Record<string, unknown>[])[0]!;
    expect("amountMinor" in pay).toBe(false);
    expect(pay.method).toBe("cash"); // non-money fields survive
  });
});

// ── createFromQuote ────────────────────────────────────────────────────────────

describe("invoice createFromQuote", () => {
  it("builds a draft with convertedFromQuoteId and the payload snapshot", async () => {
    const { svc } = newService();
    const payload = CreateFromQuoteSchema.parse({
      quoteId: "a".repeat(24),
      clientId: "b".repeat(24),
      clientSnapshot: {
        clientId: "b".repeat(24),
        displayName: "Beta LLC",
        currency: "USD",
      },
      currency: "USD",
      issueDate: "2026-03-01",
      dueDate: "2026-03-31",
      lineItems: [{ description: "Project", quantity: 1, unitPriceMinor: 100000 }],
      notes: "from quote",
    });
    const inv = await svc.createFromQuote(ADMIN, payload);
    expect(inv.status).toBe("draft");
    expect(inv.convertedFromQuoteId).toBe("a".repeat(24));
    expect(inv.clientSnapshot?.displayName).toBe("Beta LLC");
    expect(inv.grandTotalMinor).toBe(100000);
    expect(inv.invoiceNumber).toBeNull();
  });
});

// ── Public share token (mintPublicToken) ───────────────────────────────────────

describe("invoice mintPublicToken (public share)", () => {
  it("mints a raw high-entropy token (returned, hashed at rest) and emits invoice.updated", async () => {
    const { svc, events, shareTokens } = newService();
    const draft = await svc.create(ADMIN, InvoiceCreateSchema.parse(CREATE_INPUT));

    const { invoice, token } = await svc.mintPublicToken(ADMIN, draft.id);
    expect(typeof token).toBe("string");
    // base64url token (same generator/length as quotes).
    expect(token.length).toBeGreaterThanOrEqual(20);
    expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true);
    // The raw token resolves back to this invoice via the shareTokens store.
    expect(await shareTokens.resolve(token)).toEqual({ documentType: "invoice", documentId: draft.id });
    // Invoice mint does NOT bump the version (token lives in shareTokens, not on the doc).
    expect(invoice.version).toBe(draft.version);
    // Emits invoice.updated with the shared marker.
    const emitted = events.filter((e) => e.name === "invoice.updated");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.entityType).toBe("invoice");
    expect(emitted[0]!.entityId).toBe(draft.id);
    expect(emitted[0]!.payload).toEqual({ shared: true });
  });

  it("ROTATES: a second /share mints a DIFFERENT token; the OLD one stops resolving, the NEW one works", async () => {
    const { svc, events, shareTokens } = newService();
    const draft = await svc.create(ADMIN, InvoiceCreateSchema.parse(CREATE_INPUT));

    const first = await svc.mintPublicToken(ADMIN, draft.id);
    const second = await svc.mintPublicToken(ADMIN, first.invoice.id);
    // Rotation: the two raw tokens differ.
    expect(second.token).not.toBe(first.token);
    // The OLD token no longer resolves; only the NEW token does.
    expect(await shareTokens.resolve(first.token)).toBeNull();
    expect(await shareTokens.resolve(second.token)).toEqual({ documentType: "invoice", documentId: draft.id });
    // Each mint emits its own invoice.updated (rotation is a real state change → two emits).
    expect(events.filter((e) => e.name === "invoice.updated")).toHaveLength(2);
  });

  // ── LOCK-IN: no raw token is ever at rest (the point of the hashed-store refactor) ──
  it("stores the SHA-256 HASH — never the raw token — and keeps no token on the invoice doc", async () => {
    const { svc, repo, tokenRows } = newService();
    const draft = await svc.create(ADMIN, InvoiceCreateSchema.parse(CREATE_INPUT));
    const { invoice, token } = await svc.mintPublicToken(ADMIN, draft.id);

    // (a) No `publicToken` property on the returned OR stored invoice doc.
    expect("publicToken" in (invoice as unknown as Record<string, unknown>)).toBe(false);
    expect("publicToken" in (repo.byId.get(draft.id)! as unknown as Record<string, unknown>)).toBe(false);

    // (b) What is persisted in the shareTokens collection is the HASH, not the raw token.
    expect(tokenRows).toHaveLength(1);
    const stored = tokenRows[0]!;
    expect(stored.tokenHash).toBe(hashToken(token));
    expect(stored.tokenHash).not.toBe(token);
    // The raw token appears nowhere in the persisted row.
    expect(JSON.stringify(stored)).not.toContain(token);
  });
});

// ── Share route (POST /:id/share) — behind requireAuth, returns { publicToken } ─

describe("invoice /share route", () => {
  interface FakeCtx {
    method: string;
    path: string;
    url: string;
    params: Record<string, string>;
    status: number;
    body: unknown;
    state: Record<string, unknown>;
    request: { body?: unknown };
    get: (h: string) => string;
    set: (k: string, v: string) => void;
  }

  /** A minimal fake Mongo Db exposing only what the /share path touches on `invoices`. */
  function fakeDb(invoices: Map<string, Invoice>) {
    const invoicesCollection = {
      async findOne(filter: Record<string, unknown>) {
        const doc = invoices.get(filter.id as string);
        if (!doc) return null;
        if (filter.deletedAt === null && doc.deletedAt) return null;
        if (filter.archivedAt === null && doc.archivedAt) return null;
        if (typeof filter.version === "number" && doc.version !== filter.version) return null;
        return { ...doc };
      },
      async findOneAndUpdate(
        filter: Record<string, unknown>,
        update: { $set?: Record<string, unknown>; $inc?: Record<string, number> },
      ) {
        const doc = invoices.get(filter.id as string);
        if (!doc || (typeof filter.version === "number" && doc.version !== filter.version)) return null;
        const next = {
          ...doc,
          ...(update.$set ?? {}),
          version: doc.version + (update.$inc?.version ?? 0),
        } as Invoice;
        invoices.set(next.id, next);
        return { ...next };
      },
    };
    // A persistent in-memory shareTokens collection so the router's internally
    // constructed ShareTokenStore can mint/resolve (mint deletes-then-inserts).
    const tokenRows: ShareToken[] = [];
    const shareTokensCollection = {
      async createIndex() {
        return "idx";
      },
      async insertOne(doc: ShareToken) {
        tokenRows.push(doc);
        return { insertedId: doc.tokenHash };
      },
      async deleteMany(filter: Record<string, unknown>) {
        let n = 0;
        for (let i = tokenRows.length - 1; i >= 0; i--) {
          if (tokenMatches(tokenRows[i] as unknown as Record<string, unknown>, filter)) {
            tokenRows.splice(i, 1);
            n++;
          }
        }
        return { deletedCount: n };
      },
      async findOne(filter: Record<string, unknown>) {
        return tokenRows.find((r) => tokenMatches(r as unknown as Record<string, unknown>, filter)) ?? null;
      },
    };
    const other = {
      async findOne() {
        return null;
      },
    };
    return {
      collection(name: string) {
        if (name === "invoices") return invoicesCollection;
        if (name === SHARE_TOKENS_COLLECTION) return shareTokensCollection;
        return other;
      },
    } as never;
  }

  function fakeCtx(id: string, authed: boolean): FakeCtx {
    return {
      method: "POST",
      path: `/api/v1/invoices/${id}/share`,
      url: `/api/v1/invoices/${id}/share`,
      params: {},
      status: 404,
      body: undefined,
      state: authed ? { authContext: ADMIN } : {},
      request: { body: {} },
      get: () => "",
      set: () => undefined,
    };
  }

  function seededInvoice(): Invoice {
    const ts = new Date().toISOString();
    return {
      id: "inv-share-1",
      clientId: "c-1",
      clientSnapshot: null,
      invoiceNumber: null,
      currency: "EUR",
      issueDate: "2026-01-10",
      dueDate: "2026-02-10",
      lineItems: [],
      subtotalMinor: 0,
      discountMinor: 0,
      taxMinor: 0,
      grandTotalMinor: 0,
      amountPaidMinor: 0,
      amountDueMinor: 0,
      payments: [],
      status: "finalized",
      convertedFromQuoteId: null,
      notes: null,
      version: 1,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      deletedAt: null,
    };
  }

  async function driveShare(authed: boolean) {
    // Imported lazily so the route module (which pulls in koa-router) is only
    // loaded for this route test.
    const { createInvoicesRouter } = await import("@/modules/invoices/routes.js");
    const invoices = new Map<string, Invoice>([["inv-share-1", seededInvoice()]]);
    const { emitter } = newEmitter();
    const router = createInvoicesRouter({ db: fakeDb(invoices), emitter, logger });
    const dispatch = router.routes();
    const ctx = fakeCtx("inv-share-1", authed);
    const err = await dispatch(
      ctx as unknown as Parameters<typeof dispatch>[0],
      (async () => undefined) as unknown as Parameters<typeof dispatch>[1],
    ).then(
      () => undefined,
      (e: AppError) => e,
    );
    return { ctx, err, invoices };
  }

  it("returns { publicToken } in the standard envelope when authenticated", async () => {
    const { ctx, err, invoices } = await driveShare(true);
    expect(err).toBeUndefined();
    expect(ctx.status).toBe(200);
    const body = ctx.body as { data: { publicToken: string } };
    // The raw token is returned ONCE in the envelope (stored hashed at rest).
    expect(typeof body.data.publicToken).toBe("string");
    expect(body.data.publicToken.length).toBeGreaterThanOrEqual(20);
    // The raw token is NOT written onto the invoice doc (it lives hashed in shareTokens).
    expect("publicToken" in (invoices.get("inv-share-1")! as unknown as Record<string, unknown>)).toBe(false);
  });

  it("rejects with UNAUTHENTICATED (401) when there is no auth context", async () => {
    const { err } = await driveShare(false);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(401);
  });
});
