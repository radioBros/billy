import { describe, it, expect, beforeEach } from "vitest";
import type { Db } from "mongodb";
import { AppError, createLogger } from "@billy/shared";
import type { DomainEvent, DomainEventEmitter } from "@/platform/service.js";
import { computeLine } from "@/platform/money.js";
import { PublicLinkService } from "@/modules/public-links/service.js";
import { createInMemoryRateLimiter } from "@/modules/public-links/rate-limit.js";
import { createPublicLinksRouter } from "@/modules/public-links/routes.js";
import { ShareTokenStore, SHARE_TOKENS_COLLECTION } from "@/modules/public-links/share-tokens.js";
import type { ShareDocumentType } from "@/modules/public-links/share-tokens.js";
import type { PublicInvoiceDoc, PublicQuoteDoc } from "@/modules/public-links/types.js";

const logger = createLogger({ level: "silent", pretty: false, service: "test" });

const newEmitter = (): { emitter: DomainEventEmitter; events: DomainEvent[] } => {
  const events: DomainEvent[] = [];
  return { emitter: { emit: (e) => void events.push(e) }, events };
};

// ── Minimal in-memory Db fake: only `.collection(name)` → { findOne, updateOne } ─
type Doc = Record<string, unknown>;

const matches = (doc: Doc, filter: Doc): boolean => {
  return Object.entries(filter).every(([k, cond]) => {
    const v = doc[k];
    if (cond !== null && typeof cond === "object" && "$in" in (cond as Doc)) {
      return (((cond as Doc).$in as unknown[]) ?? []).includes(v);
    }
    return v === cond;
  });
};

class FakeCollection {
  constructor(private readonly docs: Doc[]) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async findOne(filter: Doc): Promise<Doc | null> {
    return this.docs.find((d) => matches(d, filter)) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async updateOne(filter: Doc, update: Doc): Promise<{ modifiedCount: number }> {
    const doc = this.docs.find((d) => matches(d, filter));
    if (!doc) return { modifiedCount: 0 };
    const set = (update.$set as Doc) ?? {};
    for (const [k, val] of Object.entries(set)) doc[k] = val;
    const inc = (update.$inc as Doc) ?? {};
    for (const [k, val] of Object.entries(inc)) doc[k] = (Number(doc[k]) || 0) + Number(val);
    return { modifiedCount: 1 };
  }

  // ── Extra ops used by ShareTokenStore (mint/resolve/revoke) ──
  // eslint-disable-next-line @typescript-eslint/require-await
  async createIndex(): Promise<string> {
    return "idx";
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async insertOne(doc: Doc): Promise<{ insertedId: unknown }> {
    this.docs.push(doc);
    return { insertedId: doc.tokenHash };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async deleteMany(filter: Doc): Promise<{ deletedCount: number }> {
    let n = 0;
    for (let i = this.docs.length - 1; i >= 0; i--) {
      if (matches(this.docs[i]!, filter)) {
        this.docs.splice(i, 1);
        n++;
      }
    }
    return { deletedCount: n };
  }
}

interface Store {
  quotes: PublicQuoteDoc[];
  invoices: PublicInvoiceDoc[];
  settings: Doc[];
}

const fakeDb = (store: Store): Db => {
  const collections: Record<string, FakeCollection> = {
    quotes: new FakeCollection(store.quotes as unknown as Doc[]),
    invoices: new FakeCollection(store.invoices as unknown as Doc[]),
    settings: new FakeCollection(store.settings),
    [SHARE_TOKENS_COLLECTION]: new FakeCollection([]),
  };
  return {
    collection(name: string) {
      // Persist unknown collections too, so repeated lookups share one instance.
      return (collections[name] ??= new FakeCollection([]));
    },
  } as unknown as Db;
};

const seedToken = async (db: Db, type: ShareDocumentType, docId: string): Promise<string> => {
  return new ShareTokenStore(db).mint(type, docId, "admin");
};

// ── Fixtures ────────────────────────────────────────────────────────────────
const BUSINESS = [{ key: "business", accountId: "default", data: { businessName: "Acme LLC" } }];

const line = () => {
  return computeLine({ description: "Widget", quantity: 2, unitPriceMinor: 5000, taxRate: 10 });
};

const baseQuote = (overrides: Partial<PublicQuoteDoc> = {}): PublicQuoteDoc => {
  return {
    id: "q-1",
    accountId: "default",
    version: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    clientId: "c-1",
    clientSnapshot: {
      clientId: "c-1",
      displayName: "Client Co",
      legalName: "Client Co Ltd",
      email: "secret@client.example",
      vatNumber: "VAT-999",
      billingAddress: { street: "1 Secret Way" },
      currency: "USD",
      snapshotAt: "2026-01-01T00:00:00.000Z",
    },
    quoteNumber: "Q-2026-0001",
    currency: "USD",
    issueDate: "2026-01-01",
    expiryDate: "2026-02-01",
    lineItems: [line()],
    subtotalMinor: 10000,
    discountMinor: 0,
    taxMinor: 1000,
    grandTotalMinor: 11000,
    status: "sent",
    notes: "INTERNAL: chase this client",
    convertedInvoiceId: null,
    acceptedAt: null,
    declinedAt: null,
    ...overrides,
  } as PublicQuoteDoc;
};

const baseInvoice = (overrides: Partial<PublicInvoiceDoc> = {}): PublicInvoiceDoc => {
  return {
    id: "inv-1",
    accountId: "default",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    clientId: "c-1",
    clientSnapshot: {
      clientId: "c-1",
      displayName: "Client Co",
      email: "secret@client.example",
      vatNumber: "VAT-999",
      billingAddress: { street: "1 Secret Way" },
      currency: "USD",
    },
    invoiceNumber: "INV-2026-0001",
    currency: "USD",
    issueDate: "2026-01-01",
    dueDate: "2026-02-01",
    lineItems: [line()],
    subtotalMinor: 10000,
    discountMinor: 0,
    taxMinor: 1000,
    grandTotalMinor: 11000,
    amountPaidMinor: 0,
    amountDueMinor: 11000,
    payments: [],
    status: "finalized",
    convertedFromQuoteId: null,
    notes: "INTERNAL note",
    ...overrides,
  } as PublicInvoiceDoc;
};

const makeService = async (store: Store) => {
  const { emitter, events } = newEmitter();
  const db = fakeDb(store);
  const shareTokens = new ShareTokenStore(db);
  const service = new PublicLinkService({ db, emitter, logger, shareTokens });
  // Seed a real share token for the primary quote / invoice (mint→resolve path).
  const quoteToken = store.quotes[0] ? await shareTokens.mint("quote", store.quotes[0].id, "admin") : "";
  const invoiceToken = store.invoices[0] ? await shareTokens.mint("invoice", store.invoices[0].id, "admin") : "";
  return { service, events, quoteToken, invoiceToken, db, shareTokens };
};

// ── Tests ─────────────────────────────────────────────────────────────────
describe("PublicLinkService — resolution & enumeration safety", () => {
  let store: Store;
  beforeEach(() => {
    store = { quotes: [baseQuote()], invoices: [baseInvoice()], settings: [...BUSINESS] };
  });

  it("unknown token → RESOURCE_NOT_FOUND (no enumeration signal)", async () => {
    const { service } = await makeService(store);
    await expect(service.getQuote("does-not-exist")).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("soft-deleted quote token → identical RESOURCE_NOT_FOUND", async () => {
    store.quotes = [baseQuote({ deletedAt: "2026-03-01T00:00:00.000Z" })];
    const { service, quoteToken } = await makeService(store);
    await expect(service.getQuote(quoteToken)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("archived quote token → identical RESOURCE_NOT_FOUND", async () => {
    store.quotes = [baseQuote({ archivedAt: "2026-03-01T00:00:00.000Z" })];
    const { service, quoteToken } = await makeService(store);
    await expect(service.getQuote(quoteToken)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("non-shareable status (draft) token → RESOURCE_NOT_FOUND", async () => {
    store.quotes = [baseQuote({ status: "draft" })];
    const { service, quoteToken } = await makeService(store);
    await expect(service.getQuote(quoteToken)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("unknown-token error is byte-identical to archived-token error", async () => {
    const { service: s1 } = await makeService({ quotes: [baseQuote()], invoices: [], settings: [...BUSINESS] });
    const { service: s2, quoteToken } = await makeService({
      quotes: [baseQuote({ archivedAt: "2026-03-01T00:00:00.000Z" })],
      invoices: [],
      settings: [...BUSINESS],
    });
    const e1 = await s1.getQuote("nope").catch((e: AppError) => e);
    const e2 = await s2.getQuote(quoteToken).catch((e: AppError) => e);
    expect((e1 as AppError).code).toBe((e2 as AppError).code);
    expect((e1 as AppError).message).toBe((e2 as AppError).message);
    expect((e1 as AppError).details).toBeUndefined();
    expect((e2 as AppError).details).toBeUndefined();
  });
});

describe("PublicLinkService — minimal projection (allowlist)", () => {
  it("valid quote token → projection with ONLY safe fields", async () => {
    const store: Store = { quotes: [baseQuote()], invoices: [], settings: [...BUSINESS] };
    const { service, quoteToken } = await makeService(store);
    const dto = await service.getQuote(quoteToken);

    expect(dto.documentNumber).toBe("Q-2026-0001");
    expect(dto.clientDisplayName).toBe("Client Co");
    expect(dto.issuer.businessName).toBe("Acme LLC");
    expect(dto.grandTotalMinor).toBe(11000);
    expect(dto.status).toBe("sent");

    const keys = Object.keys(dto);
    // internal ids / tokens / versions must be structurally absent
    for (const forbidden of ["id", "clientId", "publicToken", "version", "notes", "clientSnapshot", "convertedInvoiceId"]) {
      expect(keys).not.toContain(forbidden);
    }
    // no other-entity PII leaks anywhere in the serialized payload
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain("secret@client.example");
    expect(serialized).not.toContain("VAT-999");
    expect(serialized).not.toContain("1 Secret Way");
    expect(serialized).not.toContain("INTERNAL");
    expect(serialized).not.toContain(quoteToken);
    expect(serialized).not.toContain("c-1"); // clientId
    expect(serialized).not.toContain("q-1"); // internal id
  });

  it("line items expose only presentation + computed fields", async () => {
    const store: Store = { quotes: [baseQuote()], invoices: [], settings: [...BUSINESS] };
    const { service, quoteToken } = await makeService(store);
    const dto = await service.getQuote(quoteToken);
    const l = dto.lineItems[0]!;
    expect(l.description).toBe("Widget");
    expect(l.lineTotalMinor).toBeGreaterThan(0);
  });

  it("valid invoice token → read-only projection, no internals", async () => {
    const store: Store = { quotes: [], invoices: [baseInvoice()], settings: [...BUSINESS] };
    const { service, invoiceToken } = await makeService(store);
    const dto = await service.getInvoice(invoiceToken);
    expect(dto.documentNumber).toBe("INV-2026-0001");
    expect(dto.issuer.businessName).toBe("Acme LLC");
    const keys = Object.keys(dto);
    for (const forbidden of ["id", "clientId", "publicToken", "payments", "amountPaidMinor", "amountDueMinor", "notes"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("PublicLinkService — accept/decline transitions", () => {
  let store: Store;
  beforeEach(() => {
    store = { quotes: [baseQuote()], invoices: [], settings: [...BUSINESS] };
  });

  it("accept transitions sent → accepted, sets acceptedAt, emits once with actorId null", async () => {
    const { service, events, quoteToken } = await makeService(store);
    const dto = await service.acceptQuote(quoteToken);
    expect(dto.status).toBe("accepted");
    expect(dto.acceptedAt).toBeTruthy();
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe("quote.accepted");
    expect(events[0]!.actorId).toBeNull();
  });

  it("accept is idempotent — replay returns same result, no second emit", async () => {
    const { service, events, quoteToken } = await makeService(store);
    await service.acceptQuote(quoteToken);
    const again = await service.acceptQuote(quoteToken);
    expect(again.status).toBe("accepted");
    expect(events).toHaveLength(1); // no re-emit on replay
  });

  it("decline transitions sent → declined and emits quote.declined", async () => {
    const { service, events, quoteToken } = await makeService(store);
    const dto = await service.declineQuote(quoteToken);
    expect(dto.status).toBe("declined");
    expect(dto.declinedAt).toBeTruthy();
    expect(events[0]!.name).toBe("quote.declined");
  });

  it("accept after decline → INVALID_STATE_TRANSITION", async () => {
    const { service, quoteToken } = await makeService(store);
    await service.declineQuote(quoteToken);
    await expect(service.acceptQuote(quoteToken)).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  it("accept on unknown token → RESOURCE_NOT_FOUND", async () => {
    const { service } = await makeService(store);
    await expect(service.acceptQuote("nope")).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("accept on archived quote → RESOURCE_NOT_FOUND", async () => {
    store.quotes = [baseQuote({ archivedAt: "2026-03-01T00:00:00.000Z" })];
    const { service, quoteToken } = await makeService(store);
    await expect(service.acceptQuote(quoteToken)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("accept on non-shareable-status quote (converted) → RESOURCE_NOT_FOUND, same as GET", async () => {
    // A real quote that still carries a token but is no longer shareable must
    // not leak existence via a distinct error — it mirrors GET's notFound.
    store.quotes = [baseQuote({ status: "converted" })];
    const { service, quoteToken } = await makeService(store);
    await expect(service.getQuote(quoteToken)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(service.acceptQuote(quoteToken)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });
});

describe("rate limiter", () => {
  it("trips after the ceiling within the window", () => {
    let t = 0;
    const rl = createInMemoryRateLimiter({ max: 2, windowMs: 1000, now: () => t });
    expect(rl.check("k")).toBeNull();
    expect(rl.check("k")).toBeNull();
    const tripped = rl.check("k");
    expect(tripped).not.toBeNull();
    expect(tripped!.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("resets after the window elapses", () => {
    let t = 0;
    const rl = createInMemoryRateLimiter({ max: 1, windowMs: 1000, now: () => t });
    expect(rl.check("k")).toBeNull();
    expect(rl.check("k")).not.toBeNull();
    t = 1001;
    expect(rl.check("k")).toBeNull();
  });

  it("keys are independent (token+IP composite)", () => {
    let t = 0;
    const rl = createInMemoryRateLimiter({ max: 1, windowMs: 1000, now: () => t });
    expect(rl.check("tokenA:1.1.1.1")).toBeNull();
    expect(rl.check("tokenA:2.2.2.2")).toBeNull(); // different IP, own bucket
    expect(rl.check("tokenA:1.1.1.1")).not.toBeNull();
  });
});

describe("router — rate limit trips to RATE_LIMITED with Retry-After", () => {
  interface FakeCtx {
    method: string;
    path: string;
    url: string;
    params: Record<string, string>;
    ip: string;
    set: (k: string, v: string) => void;
    status: number;
    body: unknown;
    headers: Record<string, string>;
    state: Record<string, unknown>;
    request: Record<string, unknown>;
    captures?: unknown;
  }

  function fakeCtx(path: string): FakeCtx {
    const headers: Record<string, string> = {};
    return {
      method: "GET",
      path,
      url: path,
      params: {},
      request: {},
      ip: "9.9.9.9",
      set: (k, v) => {
        headers[k] = v;
      },
      status: 404,
      body: undefined,
      headers,
      state: {},
    };
  }

  it("first GET serves 200, second trips RATE_LIMITED and sets Retry-After", async () => {
    const store: Store = { quotes: [baseQuote()], invoices: [], settings: [...BUSINESS] };
    const { emitter } = newEmitter();
    const rl = createInMemoryRateLimiter({ max: 1, windowMs: 60_000 });
    const db = fakeDb(store);
    const token = await seedToken(db, "quote", "q-1");
    const router = createPublicLinksRouter({ db, emitter, logger, rateLimiter: rl });
    const dispatch = router.routes();
    const path = `/public/quotes/${token}`;

    const drive = async (ctx: FakeCtx) =>
      dispatch(
        ctx as unknown as Parameters<typeof dispatch>[0],
        (async () => undefined) as unknown as Parameters<typeof dispatch>[1],
      );

    const first = fakeCtx(path);
    await drive(first);
    expect(first.status).toBe(200);
    expect((first.body as { data: unknown }).data).toBeTruthy();

    const second = fakeCtx(path);
    const caught = await drive(second).then(
      () => undefined,
      (e: AppError) => e,
    );
    expect(caught).toBeInstanceOf(AppError);
    expect(caught!.code).toBe("RATE_LIMITED");
    expect(caught!.status).toBe(429);
    expect(second.headers["Retry-After"]).toBeTruthy();
  });

  it("limit is per-token: a different token from the same IP is NOT limited", async () => {
    const store: Store = {
      quotes: [baseQuote(), baseQuote({ id: "q-2" })],
      invoices: [],
      settings: [...BUSINESS],
    };
    const { emitter } = newEmitter();
    const rl = createInMemoryRateLimiter({ max: 1, windowMs: 60_000 });
    const db = fakeDb(store);
    const tokenA = await seedToken(db, "quote", "q-1");
    const tokenB = await seedToken(db, "quote", "q-2");
    const router = createPublicLinksRouter({ db, emitter, logger, rateLimiter: rl });
    const dispatch = router.routes();
    const drive = async (ctx: FakeCtx) =>
      dispatch(
        ctx as unknown as Parameters<typeof dispatch>[0],
        (async () => undefined) as unknown as Parameters<typeof dispatch>[1],
      );

    // Exhaust the window for tokenA (max:1) from this IP.
    const a = fakeCtx(`/public/quotes/${tokenA}`);
    await drive(a);
    expect(a.status).toBe(200);

    // A DIFFERENT token from the SAME IP must have its own bucket → 200, not 429.
    const b = fakeCtx(`/public/quotes/${tokenB}`);
    await drive(b);
    expect(b.status).toBe(200);
    expect((b.body as { data: unknown }).data).toBeTruthy();
  });
});
