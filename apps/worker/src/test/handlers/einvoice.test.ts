import { describe, it, expect, vi, beforeEach } from "vitest";
import { encryptSecret } from "@billy/einvoice";
import type { Logger } from "@billy/shared";
import type { ProcessorContext } from "@/processors.js";

const KEY = "test-data-encryption-key";

// ── Minimal in-memory Mongo (equality + $ne/$lte/$in/$exists, dotted $set) ────
type Doc = Record<string, unknown>;
const get = (o: Doc, path: string): unknown => path.split(".").reduce<unknown>((a, k) => (a == null ? undefined : (a as Doc)[k]), o);
const match = (d: Doc, f: Doc): boolean =>
  Object.entries(f).every(([k, v]) => {
    const val = get(d, k);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Doc;
      if ("$ne" in o) return val !== o.$ne;
      if ("$lte" in o) return val != null && (val as string) <= (o.$lte as string);
      if ("$in" in o) return (o.$in as unknown[]).includes(val);
      if ("$exists" in o) return (val !== undefined) === o.$exists;
    }
    return val === v || (v === null && val === undefined);
  });
const setPath = (d: Doc, path: string, v: unknown): void => {
  const ks = path.split(".");
  let cur = d;
  ks.slice(0, -1).forEach((k) => (cur = (cur[k] ??= {}) as Doc));
  cur[ks[ks.length - 1]!] = v;
};
const store: Record<string, Doc[]> = {};
const fakeDb = {
  collection(name: string) {
    const rows = (store[name] ??= []);
    const q = (f: Doc) => rows.filter((r) => match(r, f));
    return {
      findOne: (f: Doc) => Promise.resolve(q(f)[0] ?? null),
      find: (f: Doc) => {
        let out = q(f);
        const c = {
          sort: (s: Record<string, number>) => { const [k, dir] = Object.entries(s)[0]!; out = [...out].sort((a, b) => ((get(a, k) as number) - (get(b, k) as number)) * dir); return c; },
          limit: (n: number) => { out = out.slice(0, n); return c; },
          toArray: () => Promise.resolve(out),
        };
        return c;
      },
      countDocuments: (f: Doc) => Promise.resolve(q(f).length),
      distinct: (k: string, f: Doc) => Promise.resolve([...new Set(q(f).map((r) => r[k]))]),
      insertOne: (d: Doc) => { rows.push(d); return Promise.resolve({}); },
      updateOne: (f: Doc, u: { $set?: Doc }) => { const r = q(f)[0]; if (r) for (const [k, v] of Object.entries(u.$set ?? {})) setPath(r, k, v); return Promise.resolve({ matchedCount: r ? 1 : 0 }); },
    };
  },
};
vi.mock("mongodb", () => ({ MongoClient: class { connect() { return Promise.resolve(); } db() { return fakeDb; } } }));
vi.mock("@billy/config", () => ({
  loadConfig: () => ({ MONGO_URI: "mongodb://x/db", REDIS_URL: "redis://x:6379", DATA_ENCRYPTION_KEY: KEY, PASSO_API_URL: "http://passo-api:3000", PASSO_POLL_INTERVAL_SEC: 120 }),
}));
const enqueued: { name: string; data: unknown; opts?: unknown }[] = [];
vi.mock("bullmq", () => ({ Queue: class { add(name: string, data: unknown, opts?: unknown) { enqueued.push({ name, data, opts }); return Promise.resolve({}); } } }));
vi.mock("ioredis", () => ({ Redis: class {} }));

// ── PASSO stub via global fetch ───────────────────────────────────────────────
interface Call { method: string; url: string; headers: Record<string, string>; body?: unknown }
let calls: Call[] = [];
let responder: (c: Call) => { status: number; body: unknown };
vi.stubGlobal("fetch", (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
  const c: Call = { method: init.method, url, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
  calls.push(c);
  const r = responder(c);
  return Promise.resolve({ status: r.status, text: () => Promise.resolve(JSON.stringify(r.body)) });
});

const ctx = (): ProcessorContext => {
  const n = () => undefined;
  return { logger: { info: n, warn: n, error: n, debug: n } as unknown as Logger };
};

const seed = (over: { einv?: Doc; invoice?: Doc; client?: Doc } = {}) => {
  for (const k of Object.keys(store)) delete store[k];
  store.settings = [
    { key: "business", accountId: "A", data: { businessName: "Fornitore", legalName: "Fornitore S.r.l.", vatNumber: "IT01234567890", taxCode: "01234567890", timezone: "Europe/Rome", address: { line1: "Via Roma 12", city: "Milano", region: "MI", postalCode: "20100", country: "IT" } } },
    { key: "einvoicing", accountId: "A", data: { enabled: true, passoSellerId: "seller-1", apiKeyEnc: encryptSecret("passo_live_x", KEY), ...over.einv } },
  ];
  store.invoices = [{
    id: "inv1", accountId: "A", status: "finalized", invoiceNumber: "7/2026", issueDate: new Date().toISOString().slice(0, 10), dueDate: "2099-01-01", currency: "EUR", grandTotalMinor: 122000,
    lineItems: [{ description: "Servizi", quantity: 1, unitPriceMinor: 100000, discountRate: 0, taxRate: 22, lineSubtotalMinor: 100000, lineDiscountMinor: 0, lineTaxMinor: 22000, lineTotalMinor: 122000 }],
    clientSnapshot: { type: "company", displayName: "Cli", legalName: "Cliente S.p.A.", vatNumber: "IT09876543210", recipientCode: "ABC1234", country: "IT", billingAddress: { line1: "Corso Italia 5", city: "Milano", region: "MI", postalCode: "20124", country: "IT" } },
    ...over.invoice,
  }];
  store.einvoiceSubmissions = [];
  calls = [];
  enqueued.length = 0;
};

const accepted = { submissionId: "p1", status: "queued", invoiceNumber: "7/2026", progressivoInvio: "0001P", fileName: "IT01234567890_0001P.xml" };
beforeEach(() => seed());

describe("einvoice submit", () => {
  const job = { kind: "submit", accountId: "A", docKind: "invoice", docId: "inv1", trigger: "manual" } as const;

  it("maps, submits with an idempotency key, records the attempt, archives the XML and schedules a sync", async () => {
    responder = (c) => (c.method === "POST" && c.url.endsWith("/api/v1/invoices") ? { status: 202, body: accepted } : { status: 200, body: { submissionId: "p1", xml: "<xml/>", hashes: { xmlSha256: "abc" } } });
    const { einvoiceHandler } = await import("@/handlers/einvoice.js");
    await einvoiceHandler(job, ctx());

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.headers["idempotency-key"]).toBe("billy:A:inv1:1");
    expect(post.headers.authorization).toBe("Bearer passo_live_x");
    const body = post.body as { sellerId: string; crmInvoiceRef: string; invoice: { number: string; recipientCode: string } };
    expect(body).toMatchObject({ sellerId: "seller-1", crmInvoiceRef: "billy:A:inv1" });
    expect(body.invoice).toMatchObject({ number: "7/2026", recipientCode: "ABC1234" });

    const sub = store.einvoiceSubmissions![0]!;
    expect(sub).toMatchObject({ docId: "inv1", attempt: 1, passoSubmissionId: "p1", status: "queued", xml: "<xml/>", xmlSha256: "abc" });
    expect((store.invoices![0]!.einvoice as Doc)).toMatchObject({ status: "queued", currentSubmissionId: sub.id, fileName: accepted.fileName, lastError: null });
    expect(enqueued.some((e) => e.name === "einvoice-sync")).toBe(true);
  });

  it("blocks (and never calls PASSO) when the preflight fails", async () => {
    seed({ invoice: { clientSnapshot: { type: "individual", displayName: "Mario", firstName: "Mario", lastName: "Rossi", taxCode: "RSSMRA80A01H501U", billingAddress: { line1: "Via X 1", city: "Roma", region: "RM", postalCode: "00100", country: "IT" } } } });
    responder = () => ({ status: 500, body: {} });
    const { einvoiceHandler } = await import("@/handlers/einvoice.js");
    await einvoiceHandler(job, ctx());
    expect(calls).toHaveLength(0);
    expect(store.invoices![0]!.einvoice).toMatchObject({ status: "blocked", lastError: { code: "client.routing_missing" } });
  });

  it("is a no-op when the integration is disabled", async () => {
    seed({ einv: { enabled: false } });
    responder = () => ({ status: 202, body: accepted });
    const { einvoiceHandler } = await import("@/handlers/einvoice.js");
    expect(await einvoiceHandler(job, ctx())).toMatchObject({ skipped: "disabled" });
    expect(calls).toHaveLength(0);
  });

  it("does not resubmit a document that is already in flight or legally issued", async () => {
    seed({ invoice: { einvoice: { status: "delivered", legallyIssued: true, currentSubmissionId: "s9" } } });
    responder = () => ({ status: 202, body: accepted });
    const { einvoiceHandler } = await import("@/handlers/einvoice.js");
    expect(await einvoiceHandler(job, ctx())).toMatchObject({ skipped: "status_delivered" });
    expect(calls).toHaveLength(0);
  });

  it("marks a permanent PASSO rejection as blocked with the reason, but rethrows transient errors for BullMQ", async () => {
    responder = () => ({ status: 422, body: { error: { code: "ERR_XSD_INVALID", message: "schema says no", retryable: false } } });
    const { einvoiceHandler } = await import("@/handlers/einvoice.js");
    await einvoiceHandler(job, ctx());
    expect(store.invoices![0]!.einvoice).toMatchObject({ status: "blocked", lastError: { code: "ERR_XSD_INVALID" } });
    expect(store.einvoiceSubmissions).toHaveLength(0);

    seed();
    responder = () => ({ status: 503, body: { error: { code: "ERR_CHANNEL_UNAVAILABLE", message: "down", retryable: true } } });
    await expect(einvoiceHandler(job, ctx())).rejects.toMatchObject({ transient: true });
    expect(store.invoices![0]!.einvoice).toMatchObject({ status: "queued" }); // claimed; retry is idempotent via the key
  });

  it("PASSO's duplicate-number 500 is NOT retried", async () => {
    responder = () => ({ status: 500, body: { error: { code: "ERR_INTERNAL", message: "dup", retryable: true } } });
    const { einvoiceHandler } = await import("@/handlers/einvoice.js");
    await einvoiceHandler(job, ctx());
    expect(store.invoices![0]!.einvoice).toMatchObject({ status: "blocked", lastError: { code: "ERR_INTERNAL" } });
  });

  it("sends a credit note as TD04 with the prefixed number and the credited invoice reference", async () => {
    store.creditNotes = [{
      id: "cn1", accountId: "A", status: "issued", creditNoteNumber: "1/2026", issueDate: new Date().toISOString().slice(0, 10), currency: "EUR", grandTotalMinor: 12200, creditedInvoiceId: "inv1", creditedInvoiceNumber: "7/2026",
      lineItems: [{ description: "Storno", quantity: 1, unitPriceMinor: 10000, taxRate: 22, lineSubtotalMinor: 10000, lineDiscountMinor: 0, lineTaxMinor: 2200, lineTotalMinor: 12200 }],
      clientSnapshot: (store.invoices![0]!.clientSnapshot as Doc),
    }];
    responder = (c) => (c.method === "POST" ? { status: 202, body: { ...accepted, submissionId: "p2" } } : { status: 200, body: { xml: "<x/>" } });
    const { einvoiceHandler } = await import("@/handlers/einvoice.js");
    await einvoiceHandler({ kind: "submit", accountId: "A", docKind: "credit_note", docId: "cn1", trigger: "manual" }, ctx());
    const inv = (calls.find((c) => c.method === "POST")!.body as { invoice: { documentType: string; number: string; lines: { description: string }[] } }).invoice;
    expect(inv).toMatchObject({ documentType: "TD04", number: "NC 1/2026" });
    expect(inv.lines[0]!.description).toContain("rif. fattura n. 7/2026");
  });
});

describe("einvoice sync / retry / tick", () => {
  const withSubmission = (status = "queued") => {
    store.einvoiceSubmissions = [{ id: "s1", accountId: "A", docKind: "invoice", docId: "inv1", attempt: 1, idempotencyKey: "k", passoSubmissionId: "p1", status, receipts: [], trigger: "manual", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nextSyncAt: new Date(Date.now() - 1000).toISOString(), pollingDone: false }];
    store.invoices![0]!.einvoice = { status, legallyIssued: false, currentSubmissionId: "s1" };
  };

  it("applies an MC: issued, receipt stored and acked, polling slows to daily", async () => {
    withSubmission("transmitted");
    responder = (c) => (c.method === "GET" && c.url.endsWith("/p1")
      ? { status: 200, body: { submissionId: "p1", status: "awaiting_delivery", identificativoSdI: "999", notifications: [{ type: "MC", receivedAt: "2026-10-02T10:00:00Z" }] } }
      : { status: 200, body: { xml: "<x/>", acknowledged: 1 } });
    const { einvoiceHandler } = await import("@/handlers/einvoice.js");
    await einvoiceHandler({ kind: "sync", accountId: "A", submissionId: "s1" }, ctx());
    const sub = store.einvoiceSubmissions![0]!;
    expect(sub).toMatchObject({ status: "awaiting_delivery", pollingDone: false });
    expect((sub.receipts as Doc[])[0]).toMatchObject({ type: "MC" });
    expect((sub.receipts as Doc[])[0]!.ackedAt).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/ack"))).toBe(true);
    expect(Date.parse(sub.nextSyncAt as string) - Date.now()).toBeGreaterThan(23 * 3600 * 1000);
    expect(store.invoices![0]!.einvoice).toMatchObject({ status: "awaiting_delivery", legallyIssued: true, identificativoSdI: "999" });
  });

  it("applies an NS: not issued, SdI error kept, polling stops", async () => {
    withSubmission("transmitted");
    responder = (c) => (c.method === "GET" && c.url.endsWith("/p1")
      ? { status: 200, body: { submissionId: "p1", status: "rejected", notifications: [{ type: "NS", receivedAt: "2026-10-02T10:00:00Z", errors: [{ code: "00400", description: "bad data", remedy: "fix it" }] }] } }
      : { status: 200, body: { xml: "<x/>" } });
    const { einvoiceHandler } = await import("@/handlers/einvoice.js");
    await einvoiceHandler({ kind: "sync", accountId: "A", submissionId: "s1" }, ctx());
    expect(store.einvoiceSubmissions![0]).toMatchObject({ status: "rejected", pollingDone: true, nextSyncAt: null });
    expect(store.invoices![0]!.einvoice).toMatchObject({ status: "rejected", legallyIssued: false, lastError: { code: "00400" } });
  });

  it("retry re-runs only a failed submission on the same PASSO id", async () => {
    withSubmission("failed");
    responder = () => ({ status: 202, body: { submissionId: "p1" } });
    const { einvoiceHandler } = await import("@/handlers/einvoice.js");
    await einvoiceHandler({ kind: "retry", accountId: "A", docKind: "invoice", docId: "inv1" }, ctx());
    expect(calls.map((c) => `${c.method} ${c.url.replace("http://passo-api:3000", "")}`)).toEqual(["POST /api/v1/invoices/p1/retry"]);
    expect(store.einvoiceSubmissions![0]).toMatchObject({ status: "queued" });

    withSubmission("transmitted");
    calls = [];
    expect(await einvoiceHandler({ kind: "retry", accountId: "A", docKind: "invoice", docId: "inv1" }, ctx())).toMatchObject({ skipped: "not_failed" });
    expect(calls).toHaveLength(0);
  });

  it("tick fans out one sync per account with due submissions", async () => {
    withSubmission("queued");
    responder = () => ({ status: 200, body: {} });
    const { einvoiceHandler } = await import("@/handlers/einvoice.js");
    await einvoiceHandler({ kind: "tick", accountId: "*" }, ctx());
    expect(enqueued.filter((e) => e.name === "einvoice-sync")).toHaveLength(1);
  });
});
