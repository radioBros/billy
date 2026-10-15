import { describe, it, expect } from "vitest";
import type { Collection, Db } from "mongodb";
import { createLogger, AppError } from "@billy/shared";
import type { AuthContext, BaseDoc } from "@billy/types";
import type { DomainEvent, DomainEventEmitter } from "@/platform/service.js";
import { QuoteRepository } from "@/modules/quotes/repository.js";
import { QuoteService, type QuoteEmailPort, type QuoteInvoicePorts } from "@/modules/quotes/service.js";
import { QuoteCreateSchema, QuoteUpdateSchema } from "@/modules/quotes/schema.js";
import type { ConvertToInvoicePayload, ConvertedInvoiceRef, Quote } from "@/modules/quotes/types.js";
import { ShareTokenStore, SHARE_TOKENS_COLLECTION, type ShareToken } from "@/modules/public-links/share-tokens.js";

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

const notFound = () => {
  return new AppError("RESOURCE_NOT_FOUND");
};
const versionConflict = () => {
  return new AppError("VERSION_CONFLICT");
};

/**
 * In-memory QuoteRepository. Extends the real class (its `collection` is protected,
 * so a structural fake cannot satisfy `BaseRepository<Quote>`), passing a dummy
 * collection to super and overriding every public method against a Map.
 */
class FakeQuoteRepository extends QuoteRepository {
  readonly byId = new Map<string, Quote>();
  private seq = 0;

  constructor() {
    super(undefined as unknown as Collection<Quote>);
  }

  override async findById(_ctx: AuthContext, id: string): Promise<Quote | null> {
    const doc = this.byId.get(id);
    return doc && !doc.deletedAt ? doc : null;
  }

  override async insert(_ctx: AuthContext, data: Omit<Quote, keyof BaseDoc>): Promise<Quote> {
    const ts = new Date().toISOString();
    const doc = {
      ...(data as object),
      id: `q-${++this.seq}`,
      version: 1,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
      deletedAt: null,
    } as Quote;
    this.byId.set(doc.id, doc);
    return doc;
  }

  override async updateVersioned(
    _ctx: AuthContext,
    id: string,
    expectedVersion: number,
    patch: Partial<Quote>,
  ): Promise<Quote> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt) throw notFound();
    if (doc.archivedAt) throw notFound();
    if (doc.version !== expectedVersion) throw versionConflict();
    const next = { ...doc, ...patch, version: doc.version + 1, updatedAt: new Date().toISOString() } as Quote;
    this.byId.set(id, next);
    return next;
  }

  override async archive(_ctx: AuthContext, id: string, expectedVersion: number): Promise<Quote> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt) throw notFound();
    if (doc.version !== expectedVersion) throw versionConflict();
    const next = { ...doc, archivedAt: new Date().toISOString(), version: doc.version + 1 } as Quote;
    this.byId.set(id, next);
    return next;
  }

  override async restore(_ctx: AuthContext, id: string, expectedVersion: number): Promise<Quote> {
    const doc = this.byId.get(id);
    if (!doc || doc.deletedAt || !doc.archivedAt) throw notFound();
    if (doc.version !== expectedVersion) throw versionConflict();
    const next = { ...doc, archivedAt: null, version: doc.version + 1 } as Quote;
    this.byId.set(id, next);
    return next;
  }

  override async softDelete(_ctx: AuthContext, id: string): Promise<void> {
    const doc = this.byId.get(id);
    if (doc) this.byId.set(id, { ...doc, deletedAt: new Date().toISOString() });
  }
}

const tokenMatches = (doc: Record<string, unknown>, filter: Record<string, unknown>): boolean => {
  return Object.entries(filter).every(([k, cond]) => doc[k] === cond);
};

/** Filters the fake `clients` collection was queried with (scoping assertions). */
type Filters = Record<string, unknown>[];

const BUSINESS_SETTINGS = { key: "business", accountId: "default", data: { businessName: "Billy Studio Srl" } };

const fakeDb = (client?: Record<string, unknown>, clientFilters: Filters = []): Db => {
  let seq = 0;
  const tokenRows: ShareToken[] = [];
  const shareTokens = {
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
  return {
    collection(name: string) {
      if (name === "clients") {
        return {
          findOne: async (filter: Record<string, unknown>) => {
            clientFilters.push(filter);
            return client ?? null;
          },
        };
      }
      if (name === "settings") {
        return {
          findOne: async (filter: Record<string, unknown>) =>
            filter.key === BUSINESS_SETTINGS.key && filter.accountId === BUSINESS_SETTINGS.accountId ? BUSINESS_SETTINGS : null,
        };
      }
      if (name === "counters") {
        return { findOneAndUpdate: async () => ({ _id: "quote-x", seq: ++seq }) };
      }
      if (name === SHARE_TOKENS_COLLECTION) {
        return shareTokens;
      }
      throw new Error(`unexpected collection ${name}`);
    },
  } as unknown as Db;
};

/** In-memory invoice ports: records every createFromQuote payload. */
const fakeInvoices = () => {
  const created: (ConvertedInvoiceRef & { payload: ConvertToInvoicePayload; deleted?: boolean })[] = [];
  const ports: QuoteInvoicePorts = {
    createInvoiceFromQuote: async (_ctx, payload) => {
      const inv = { id: `inv-${created.length + 1}`, invoiceNumber: null, status: "draft", payload };
      created.push(inv);
      return { id: inv.id, invoiceNumber: null, status: "draft" };
    },
    findInvoiceForQuote: async (_ctx, quoteId) => {
      const inv = created.find((i) => i.payload.quoteId === quoteId && !i.deleted);
      return inv ? { id: inv.id, invoiceNumber: null, status: "draft" } : null;
    },
    discardInvoice: async (_ctx, invoiceId) => {
      const inv = created.find((i) => i.id === invoiceId);
      if (inv) inv.deleted = true;
    },
  };
  return { ports, created };
};

const newService = (client?: Record<string, unknown>, opts: { emailer?: QuoteEmailPort } = {}) => {
  const repo = new FakeQuoteRepository();
  const { emitter, events } = newEmitter();
  const clientFilters: Filters = [];
  const db = fakeDb(client, clientFilters);
  const shareTokens = new ShareTokenStore(db);
  const invoices = fakeInvoices();
  const svc = new QuoteService({ repo, emitter, logger, db, shareTokens, invoices: invoices.ports, emailer: opts.emailer });
  return { repo, svc, events, shareTokens, invoices, clientFilters };
};

const CLIENT = {
  id: "aaaaaaaaaaaaaaaaaaaaaaaa",
  displayName: "Acme SpA",
  legalName: "Acme S.p.A.",
  email: "billing@acme.io",
  vatNumber: "IT123",
  billingAddress: { line1: "1 Main St", city: "Rome", postalCode: "00100", country: "IT" },
  preferredCurrency: "EUR",
};

const BASE_INPUT = {
  clientId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  currency: "EUR",
  issueDate: "2026-07-01",
  expiryDate: "2026-07-31",
  lineItems: [
    { description: "Consulting", quantity: 3, unitPriceMinor: 1000, discountRate: 10, taxRate: 22 },
    { description: "License", quantity: 2, unitPriceMinor: 500, taxRate: 22 },
  ],
} as const;

// ── Schema: expiry ≥ issue validation ────────────────────────────────────────

describe("quote schema — expiry ≥ issue (§37)", () => {
  it("accepts a quote whose expiryDate ≥ issueDate", () => {
    expect(QuoteCreateSchema.safeParse(BASE_INPUT).success).toBe(true);
  });

  it("rejects a quote whose expiryDate < issueDate", () => {
    const r = QuoteCreateSchema.safeParse({ ...BASE_INPUT, expiryDate: "2026-06-30" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.join(".") === "expiryDate")).toBe(true);
  });

  it("strips client-sent totals from the parsed input", () => {
    const parsed = QuoteCreateSchema.parse({ ...BASE_INPUT, grandTotalMinor: 999999, subtotalMinor: 1 });
    expect("grandTotalMinor" in parsed).toBe(false);
    expect("subtotalMinor" in parsed).toBe(false);
  });

  it("update re-checks expiry only when both dates present", () => {
    expect(QuoteUpdateSchema.safeParse({ notes: "x" }).success).toBe(true);
    expect(QuoteUpdateSchema.safeParse({ issueDate: "2026-07-10", expiryDate: "2026-07-05" }).success).toBe(false);
  });
});

// ── Service: server-recomputed totals (ignore client totals) ─────────────────

describe("quote service — totals are server-recomputed", () => {
  it("computes doc totals from lineItems on create, ignoring any client-sent totals", async () => {
    const { svc } = newService();
    // Cast bogus totals into the input; the service must ignore them.
    const input = { ...QuoteCreateSchema.parse(BASE_INPUT), grandTotalMinor: 12345, subtotalMinor: 1 } as never;
    const created = await svc.create(ADMIN, input);
    // line1: 3×1000=3000, -10%=2700, +22%=3294 ; line2: 2×500=1000, +22%=1220
    expect(created.subtotalMinor).toBe(4000);
    expect(created.discountMinor).toBe(300);
    expect(created.taxMinor).toBe(594 + 220);
    expect(created.grandTotalMinor).toBe(3294 + 1220);
    expect(created.status).toBe("draft");
    expect(created.quoteNumber).toBeNull();
    expect(created.clientSnapshot).toBeNull();
    expect(created.lineItems[0]!.lineTotalMinor).toBe(3294);
  });

  it("recomputes totals when lineItems change on update", async () => {
    const { svc } = newService();
    const created = await svc.create(ADMIN, QuoteCreateSchema.parse(BASE_INPUT));
    const updated = await svc.update(ADMIN, created.id, created.version, {
      lineItems: [{ description: "One", quantity: 1, unitPriceMinor: 1000 }],
    });
    expect(updated.grandTotalMinor).toBe(1000);
    expect(updated.taxMinor).toBe(0);
  });
});

// ── Service: lifecycle transitions ───────────────────────────────────────────

describe("quote service — lifecycle", () => {
  async function sendable() {
    const { svc, repo, events } = newService(CLIENT);
    const created = await svc.create(ADMIN, QuoteCreateSchema.parse(BASE_INPUT));
    const sent = await svc.send(ADMIN, created.id, created.version);
    return { svc, repo, events, created, sent };
  }

  it("send freezes the client snapshot and assigns a slashYear number", async () => {
    const { sent } = await sendable();
    expect(sent.status).toBe("sent");
    expect(sent.quoteNumber).toBe("1/2026");
    expect(sent.clientSnapshot).toMatchObject({
      clientId: CLIENT.id,
      displayName: "Acme SpA",
      vatNumber: "IT123",
      currency: "EUR",
    });
    expect(sent.clientSnapshot!.snapshotAt).toBeTruthy();
  });

  it("numbers by the quote's ISSUE year, not the wall-clock year", async () => {
    const { svc } = newService(CLIENT);
    const created = await svc.create(ADMIN, QuoteCreateSchema.parse({ ...BASE_INPUT, issueDate: "2019-12-30", expiryDate: "2020-01-30" }));
    const sent = await svc.send(ADMIN, created.id, created.version);
    expect(sent.quoteNumber).toBe("1/2019");
  });

  it("reads the client strictly within the caller's account", async () => {
    const { svc, clientFilters } = newService(CLIENT);
    const created = await svc.create(ADMIN, QuoteCreateSchema.parse(BASE_INPUT));
    await svc.send(ADMIN, created.id, created.version);
    expect(clientFilters).toHaveLength(1);
    expect(clientFilters[0]).toMatchObject({ id: CLIENT.id, accountId: ADMIN.accountId, deletedAt: null });
  });

  it("the sent email carries the formatted total and the ACCOUNT's business name", async () => {
    const sentMails: Parameters<QuoteEmailPort["send"]>[0][] = [];
    const emailer: QuoteEmailPort = {
      send: async (input) => {
        sentMails.push(input);
        return "job-1";
      },
    };
    const { svc } = newService(CLIENT, { emailer });
    const created = await svc.create(ADMIN, QuoteCreateSchema.parse(BASE_INPUT));
    await svc.send(ADMIN, created.id, created.version);
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]!.to).toBe(CLIENT.email);
    expect(sentMails[0]!.data).toMatchObject({
      quoteNumber: "1/2026",
      total: "EUR 45.14", // grandTotalMinor 4514 in the quote currency — never "4514"
      businessName: "Billy Studio Srl", // the sender, not the client's legal name
      viewUrl: "",
    });
  });

  it("emits quote.sent", async () => {
    const { events } = await sendable();
    expect(events.map((e) => e.name)).toContain("quote.sent");
  });

  it("rejects an illegal transition (draft → accepted) with INVALID_STATE_TRANSITION", async () => {
    const { svc } = newService(CLIENT);
    const created = await svc.create(ADMIN, QuoteCreateSchema.parse(BASE_INPUT));
    await expect(svc.accept(ADMIN, created.id, created.version)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
  });

  it("accept moves sent → accepted; decline is then illegal", async () => {
    const { svc, sent } = await sendable();
    const accepted = await svc.accept(ADMIN, sent.id, sent.version);
    expect(accepted.status).toBe("accepted");
    await expect(svc.decline(ADMIN, accepted.id, accepted.version)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
  });
});

// ── Service: convert (creates + links the draft invoice) ─────────────────────

describe("quote service — convert", () => {
  async function accepted(lines?: unknown[]) {
    const ctx = newService(CLIENT);
    const input = lines ? { ...BASE_INPUT, lineItems: lines, subject: "Website", projectId: "bbbbbbbbbbbbbbbbbbbbbbbb", notes: "Thanks" } : BASE_INPUT;
    const created = await ctx.svc.create(ADMIN, QuoteCreateSchema.parse(input));
    const sent = await ctx.svc.send(ADMIN, created.id, created.version);
    const acc = await ctx.svc.accept(ADMIN, sent.id, sent.version);
    return { ...ctx, acc };
  }

  it("creates the draft invoice, marks the quote converted AND links it in one write", async () => {
    const { svc, acc, events, invoices } = await accepted();
    const { quote, invoice } = await svc.convert(ADMIN, acc.id, acc.version);
    expect(invoice).toEqual({ id: "inv-1", invoiceNumber: null, status: "draft" });
    expect(quote.status).toBe("converted");
    expect(quote.convertedInvoiceId).toBe("inv-1");
    expect(quote.version).toBe(acc.version + 1); // single write: status + link together
    expect(invoices.created).toHaveLength(1);
    const payload = invoices.created[0]!.payload;
    expect(payload).toMatchObject({ quoteId: acc.id, clientId: CLIENT.id, currency: "EUR" });
    expect(payload.clientSnapshot.displayName).toBe("Acme SpA");
    // Raw inputs only — NO computed line money fields.
    expect(payload.lineItems).toEqual([
      { description: "Consulting", quantity: 3, unitPriceMinor: 1000, discountRate: 10, taxRate: 22 },
      { description: "License", quantity: 2, unitPriceMinor: 500, taxRate: 22 },
    ]);
    expect(payload.lineItems[0]).not.toHaveProperty("lineTotalMinor");
    expect(events.find((e) => e.name === "quote.converted")?.payload).toEqual({ invoiceId: "inv-1" });
  });

  it("carries nature, subject, projectId and notes onto the invoice payload", async () => {
    const { svc, acc, invoices } = await accepted([
      { description: "Exempt service", quantity: 1, unitPriceMinor: 10000, taxRate: 0, nature: "N2.2" },
    ]);
    await svc.convert(ADMIN, acc.id, acc.version);
    const payload = invoices.created[0]!.payload;
    expect(payload.lineItems).toEqual([
      { description: "Exempt service", quantity: 1, unitPriceMinor: 10000, taxRate: 0, nature: "N2.2" },
    ]);
    expect(payload).toMatchObject({ subject: "Website", projectId: "bbbbbbbbbbbbbbbbbbbbbbbb", notes: "Thanks" });
  });

  it("re-converting a converted quote → QUOTE_ALREADY_CONVERTED (no second invoice)", async () => {
    const { svc, acc, invoices } = await accepted();
    const { quote } = await svc.convert(ADMIN, acc.id, acc.version);
    await expect(svc.convert(ADMIN, quote.id, quote.version)).rejects.toMatchObject({
      code: "QUOTE_ALREADY_CONVERTED",
    });
    expect(invoices.created).toHaveLength(1);
  });

  it("a stale version → VERSION_CONFLICT and NO invoice is created", async () => {
    const { svc, acc, invoices } = await accepted();
    await expect(svc.convert(ADMIN, acc.id, acc.version - 1)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(invoices.created).toHaveLength(0);
    expect((await svc.get(ADMIN, acc.id)).status).toBe("accepted");
  });

  it("a failed link leaves the quote ACCEPTED (never converted without an invoice) and names the invoice", async () => {
    const { svc, repo, acc, invoices } = await accepted();
    const original = repo.updateVersioned.bind(repo);
    repo.updateVersioned = async () => {
      throw new AppError("INTERNAL_ERROR", "db down");
    };
    await expect(svc.convert(ADMIN, acc.id, acc.version)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      details: { invoiceId: "inv-1" },
    });
    repo.updateVersioned = original;
    const after = await svc.get(ADMIN, acc.id);
    expect(after.status).toBe("accepted");
    expect(after.convertedInvoiceId ?? null).toBeNull();

    // Retry REUSES the already-created draft instead of creating a duplicate.
    const { quote, invoice } = await svc.convert(ADMIN, after.id, after.version);
    expect(invoice.id).toBe("inv-1");
    expect(quote.convertedInvoiceId).toBe("inv-1");
    expect(invoices.created).toHaveLength(1);
  });

  it("losing a race to a concurrent convert discards our duplicate draft", async () => {
    const { svc, repo, acc, invoices } = await accepted();
    const original = repo.updateVersioned.bind(repo);
    // Simulate the other request linking ITS invoice between our create and our write.
    repo.updateVersioned = async (ctx, id, _v, _patch) => {
      repo.updateVersioned = original;
      await original(ctx, id, acc.version, { status: "converted", convertedInvoiceId: "inv-other" } as Partial<Quote>);
      throw new AppError("VERSION_CONFLICT");
    };
    // Make the lookup miss so this request creates its own draft.
    invoices.ports.findInvoiceForQuote = async () => null;
    await expect(svc.convert(ADMIN, acc.id, acc.version)).rejects.toMatchObject({ code: "QUOTE_ALREADY_CONVERTED" });
    expect(invoices.created[0]!.deleted).toBe(true);
  });

  it("a concurrent request that linked the SAME (reused) invoice → success, not an error", async () => {
    const { svc, repo, acc, invoices } = await accepted();
    const original = repo.updateVersioned.bind(repo);
    repo.updateVersioned = async (ctx, id, _v, _patch) => {
      repo.updateVersioned = original;
      await original(ctx, id, acc.version, { status: "converted", convertedInvoiceId: "inv-1" } as Partial<Quote>);
      throw new AppError("VERSION_CONFLICT");
    };
    const { quote, invoice } = await svc.convert(ADMIN, acc.id, acc.version);
    expect(invoice.id).toBe("inv-1");
    expect(quote.convertedInvoiceId).toBe("inv-1");
    expect(invoices.created[0]!.deleted).toBeUndefined();
  });

  it("repairs a legacy quote marked converted WITHOUT an invoice (old flow): creates + links one", async () => {
    const { svc, repo, acc, invoices } = await accepted();
    repo.byId.set(acc.id, { ...repo.byId.get(acc.id)!, status: "converted", convertedInvoiceId: null });
    const { quote, invoice } = await svc.convert(ADMIN, acc.id, acc.version);
    expect(invoices.created).toHaveLength(1);
    expect(quote).toMatchObject({ status: "converted", convertedInvoiceId: invoice.id });
  });

  it("throws internal when the invoice ports are unwired", async () => {
    const repo = new FakeQuoteRepository();
    const db = fakeDb(CLIENT);
    const svc = new QuoteService({ repo, emitter: newEmitter().emitter, logger, db });
    const created = await svc.create(ADMIN, QuoteCreateSchema.parse(BASE_INPUT));
    await expect(svc.convert(ADMIN, created.id, created.version)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("linkConvertedInvoice sets convertedInvoiceId", async () => {
    const { svc, acc } = await accepted();
    const linked = await svc.linkConvertedInvoice(ADMIN, acc.id, acc.version, "inv-9");
    expect(linked.convertedInvoiceId).toBe("inv-9");
  });
});

// ── Service: public token mint / revoke ──────────────────────────────────────

describe("quote service — public token", () => {
  it("mints a high-entropy token (returned, not stored on the doc) and revokes it", async () => {
    const { svc, shareTokens } = newService();
    const created = await svc.create(ADMIN, QuoteCreateSchema.parse(BASE_INPUT));
    const { quote, token } = await svc.mintPublicToken(ADMIN, created.id, created.version);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThanOrEqual(20);
    // No RAW token ever lands on the quote doc — it lives (hashed) in shareTokens.
    expect((quote as unknown as Record<string, unknown>).publicToken ?? null).toBeNull();
    expect((quote as unknown as Record<string, unknown>).publicToken).not.toBe(token);
    // mintPublicToken bumps the version via a no-op state touch.
    expect(quote.version).toBe(created.version + 1);
    // Revoke clears the shareTokens row → the token stops resolving.
    const revoked = await svc.revokePublicToken(ADMIN, quote.id, quote.version);
    expect((revoked as unknown as Record<string, unknown>).publicToken ?? null).toBeNull();
    expect(await shareTokens.resolve(token)).toBeNull();
  });

  it("share round-trips: minted token resolves to {quote, id}", async () => {
    const { svc, shareTokens } = newService();
    const created = await svc.create(ADMIN, QuoteCreateSchema.parse(BASE_INPUT));
    const { quote, token } = await svc.mintPublicToken(ADMIN, created.id, created.version);
    expect(await shareTokens.resolve(token)).toEqual({ documentType: "quote", documentId: quote.id });
  });
});
