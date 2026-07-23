import { describe, it, expect } from "vitest";
import type { Collection, Db } from "mongodb";
import { createLogger, AppError } from "@billy/shared";
import type { AuthContext, BaseDoc } from "@billy/types";
import type { DomainEvent, DomainEventEmitter } from "@/platform/service.js";
import { QuoteRepository } from "@/modules/quotes/repository.js";
import { QuoteService } from "@/modules/quotes/service.js";
import { QuoteCreateSchema, QuoteUpdateSchema } from "@/modules/quotes/schema.js";
import type { Quote } from "@/modules/quotes/types.js";
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

const fakeDb = (client?: Record<string, unknown>): Db => {
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
        return { findOne: async () => client ?? null };
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

const newService = (client?: Record<string, unknown>) => {
  const repo = new FakeQuoteRepository();
  const { emitter, events } = newEmitter();
  const db = fakeDb(client);
  const shareTokens = new ShareTokenStore(db);
  const svc = new QuoteService({ repo, emitter, logger, db, shareTokens });
  return { repo, svc, events, shareTokens };
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
    expect(sent.quoteNumber).toBe(`1/${new Date().getUTCFullYear()}`);
    expect(sent.clientSnapshot).toMatchObject({
      clientId: CLIENT.id,
      displayName: "Acme SpA",
      vatNumber: "IT123",
      currency: "EUR",
    });
    expect(sent.clientSnapshot!.snapshotAt).toBeTruthy();
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

// ── Service: convert + double-convert guard ──────────────────────────────────

describe("quote service — convert", () => {
  async function accepted() {
    const { svc, repo, events } = newService(CLIENT);
    const created = await svc.create(ADMIN, QuoteCreateSchema.parse(BASE_INPUT));
    const sent = await svc.send(ADMIN, created.id, created.version);
    const acc = await svc.accept(ADMIN, sent.id, sent.version);
    return { svc, repo, events, acc };
  }

  it("produces the ConvertToInvoicePayload (raw lineItems) and marks the quote converted", async () => {
    const { svc, acc, events } = await accepted();
    const { quote, payload } = await svc.convert(ADMIN, acc.id, acc.version);
    expect(quote.status).toBe("converted");
    expect(payload).toMatchObject({
      quoteId: acc.id,
      clientId: CLIENT.id,
      currency: "EUR",
    });
    expect(payload.clientSnapshot.displayName).toBe("Acme SpA");
    // Raw inputs only — NO computed line money fields.
    expect(payload.lineItems).toEqual([
      { description: "Consulting", quantity: 3, unitPriceMinor: 1000, discountRate: 10, taxRate: 22 },
      { description: "License", quantity: 2, unitPriceMinor: 500, taxRate: 22 },
    ]);
    expect(payload.lineItems[0]).not.toHaveProperty("lineTotalMinor");
    expect(events.map((e) => e.name)).toContain("quote.converted");
  });

  it("re-converting a converted quote → QUOTE_ALREADY_CONVERTED", async () => {
    const { svc, acc } = await accepted();
    const { quote } = await svc.convert(ADMIN, acc.id, acc.version);
    await expect(svc.convert(ADMIN, quote.id, quote.version)).rejects.toMatchObject({
      code: "QUOTE_ALREADY_CONVERTED",
    });
  });

  it("linkConvertedInvoice sets convertedInvoiceId", async () => {
    const { svc, acc } = await accepted();
    const { quote } = await svc.convert(ADMIN, acc.id, acc.version);
    const linked = await svc.linkConvertedInvoice(ADMIN, quote.id, quote.version, "inv-1");
    expect(linked.convertedInvoiceId).toBe("inv-1");
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
