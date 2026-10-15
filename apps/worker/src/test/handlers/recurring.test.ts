import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "@billy/shared";
import type { ProcessorContext } from "@/processors.js";

const makeDb = (
  scheduledInvoices: Record<string, unknown>[],
  profiles: Record<string, unknown>[] = [],
  extra: { files?: Record<string, unknown>[]; settings?: Record<string, unknown>[]; proformas?: Record<string, unknown>[]; clientMissing?: boolean } = {},
) => {
  const counters = new Map<string, number>();
  const clientLookups: Record<string, unknown>[] = [];
  const finalizedCalls: { id: string; number: string; set: Record<string, unknown> }[] = [];
  const insertedInvoices: Record<string, unknown>[] = [];
  const files = extra.files ?? [];
  const settings = extra.settings ?? [];
  const proformaDocs = extra.proformas ?? [];
  // Version-guarded claim shared by invoices + proformas (auto-send exactly-once).
  const claim = (docs: Record<string, unknown>[]) =>
    (filter: Record<string, unknown>, update: { $set?: Record<string, unknown>; $inc?: Record<string, number> }) => {
      const d = docs.find((x) => (x as { id: string }).id === (filter as { id: string }).id) as Record<string, unknown> | undefined;
      if (!d) return Promise.resolve(null);
      // Honor the guards present in the filter (version + autoSendPending/status).
      for (const [k, v] of Object.entries(filter)) {
        if (k === "id") continue;
        if (d[k] !== v) return Promise.resolve(null);
      }
      Object.assign(d, update.$set ?? {});
      if (update.$inc) for (const [k, n] of Object.entries(update.$inc)) d[k] = ((d[k] as number) ?? 0) + n;
      return Promise.resolve(d);
    };
  const db = {
    collection(name: string) {
      if (name === "files") {
        // Two query shapes: PDF lookup by owner (sort().limit().toArray()) and the
        // extra-attachment lookup by {id:{$in}} (toArray()).
        const runQuery = (filter: Record<string, unknown>) => {
          const inClause = (filter as { id?: { $in?: string[] } }).id?.$in;
          if (inClause) return files.filter((f) => inClause.includes((f as { id: string }).id));
          return files.filter(
            (f) => (f as { ownerType?: string }).ownerType === (filter as { ownerType?: string }).ownerType && (f as { ownerId?: string }).ownerId === (filter as { ownerId?: string }).ownerId,
          );
        };
        return {
          find: (filter: Record<string, unknown>) => ({
            sort: () => ({ limit: () => ({ toArray: () => Promise.resolve(runQuery(filter)) }) }),
            toArray: () => Promise.resolve(runQuery(filter)),
          }),
        };
      }
      if (name === "settings") {
        return {
          findOne: (filter: { key: string; accountId?: string }) =>
            Promise.resolve(
              settings.find(
                (s) => (s as { key: string }).key === filter.key && (filter.accountId === undefined || (s as { accountId?: string }).accountId === filter.accountId),
              ) ?? null,
            ),
        };
      }
      if (name === "counters") {
        return {
          findOneAndUpdate: (filter: { _id: string }) => {
            const next = (counters.get(filter._id) ?? 0) + 1;
            counters.set(filter._id, next);
            return Promise.resolve({ _id: filter._id, seq: next });
          },
        };
      }
      if (name === "clients") {
        return {
          findOne: (filter: { accountId?: string }) => {
            clientLookups.push(filter);
            if (extra.clientMissing) return Promise.resolve(null);
            return Promise.resolve({
              id: "c1", type: "company", displayName: "Acme", legalName: "Acme S.r.l.", email: "a@b.c", vatNumber: "IT01234567890",
              taxCode: "01234567890", recipientCode: "ABC1234", pecEmail: "acme@pec.it", country: "IT",
              billingAddress: { line1: "Via Roma 1", city: "Milano" },
            });
          },
        };
      }
      if (name === "invoices") {
        return {
          // Scan 1 queries {status:"scheduled",...}; Scan 3 queries {autoSendPending:true}.
          find: (filter: Record<string, unknown> = {}) => ({
            limit: () => ({
              toArray: () =>
                Promise.resolve(
                  "autoSendPending" in filter
                    ? scheduledInvoices.filter((i) => (i as { autoSendPending?: boolean }).autoSendPending === true)
                    : scheduledInvoices,
                ),
            }),
            toArray: () =>
              Promise.resolve(
                "autoSendPending" in filter
                  ? scheduledInvoices.filter((i) => (i as { autoSendPending?: boolean }).autoSendPending === true)
                  : scheduledInvoices,
              ),
          }),
          findOneAndUpdate: (filter: Record<string, unknown>, update: { $set?: Record<string, unknown>; $inc?: Record<string, number> }) => {
            // Scheduled-finalize path (status guard) vs auto-send claim (autoSendPending guard).
            if ((filter as { status?: string }).status === "scheduled") {
              const inv = scheduledInvoices.find((i) => (i as { id: string }).id === (filter as { id: string }).id);
              if (!inv || (inv as { status: string }).status !== "scheduled") return Promise.resolve(null);
              (inv as { status: string }).status = "finalized";
              finalizedCalls.push({ id: (filter as { id: string }).id, number: (update.$set as { invoiceNumber: string }).invoiceNumber, set: update.$set ?? {} });
              return Promise.resolve({ ...inv, ...update.$set });
            }
            return claim(scheduledInvoices)(filter, update);
          },
          updateOne: (filter: Record<string, unknown>, update: { $set?: Record<string, unknown> }) => {
            const d = scheduledInvoices.find((x) => (x as { id: string }).id === (filter as { id: string }).id) as Record<string, unknown> | undefined;
            if (d) Object.assign(d, update.$set ?? {});
            return Promise.resolve({ matchedCount: d ? 1 : 0 });
          },
          insertOne: (doc: Record<string, unknown>) => {
            insertedInvoices.push(doc);
            return Promise.resolve({ insertedId: doc.id });
          },
        };
      }
      if (name === "proformas") {
        return {
          find: (filter: Record<string, unknown> = {}) => ({
            limit: () => ({ toArray: () => Promise.resolve("autoSendPending" in filter ? proformaDocs.filter((i) => (i as { autoSendPending?: boolean }).autoSendPending === true) : proformaDocs) }),
            toArray: () => Promise.resolve("autoSendPending" in filter ? proformaDocs.filter((i) => (i as { autoSendPending?: boolean }).autoSendPending === true) : proformaDocs),
          }),
          findOneAndUpdate: claim(proformaDocs),
          updateOne: (filter: Record<string, unknown>, update: { $set?: Record<string, unknown> }) => {
            const d = proformaDocs.find((x) => (x as { id: string }).id === (filter as { id: string }).id) as Record<string, unknown> | undefined;
            if (d) Object.assign(d, update.$set ?? {});
            return Promise.resolve({ matchedCount: d ? 1 : 0 });
          },
          insertOne: (doc: Record<string, unknown>) => {
            insertedInvoices.push({ ...doc, __collection: name });
            proformaDocs.push(doc);
            return Promise.resolve({ insertedId: doc.id });
          },
        };
      }
      if (name === "expenses") {
        return {
          insertOne: (doc: Record<string, unknown>) => {
            insertedInvoices.push({ ...doc, __collection: name });
            return Promise.resolve({ insertedId: doc.id });
          },
        };
      }
      if (name === "recurringProfiles") {
        return {
          find: () => ({ toArray: () => Promise.resolve(profiles) }),
          // Honors simple equality filters (null ⇒ absent/null) so replay guards are testable.
          findOne: (filter: Record<string, unknown>) =>
            Promise.resolve(
              profiles.find((x) =>
                Object.entries(filter).every(([k, v]) =>
                  v === null ? (x as Record<string, unknown>)[k] == null : typeof v === "object" ? true : (x as Record<string, unknown>)[k] === v,
                ),
              ) ?? null,
            ),
          findOneAndUpdate: (filter: { id: string; version: number; status: string }, update: { $set: Record<string, unknown> }) => {
            const p = profiles.find((x) => (x as { id: string }).id === filter.id) as Record<string, unknown> | undefined;
            if (!p || p.version !== filter.version || p.status !== "active") return Promise.resolve(null);
            Object.assign(p, update.$set, { version: (p.version as number) + 1 });
            return Promise.resolve(p);
          },
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  };
  return { db, counters, finalizedCalls, insertedInvoices, clientLookups };
};

const mongoConnect = vi.fn();
let currentDb: unknown;
vi.mock("mongodb", () => ({
  MongoClient: class {
    connect() {
      mongoConnect();
      return Promise.resolve();
    }
    db() {
      return currentDb;
    }
  },
}));
vi.mock("@billy/config", () => ({ loadConfig: () => ({ MONGO_URI: "mongodb://x/db", REDIS_URL: "redis://x:6379" }) }));

// Capture BullMQ enqueues (email + pdf) without a real Redis. `enqueuedJobs` is
// reset per test in beforeEach.
const enqueuedJobs: { queue: string; name: string; payload: unknown; opts?: unknown }[] = [];
vi.mock("bullmq", () => ({
  Queue: class {
    constructor(public readonly qname: string) {}
    add(name: string, payload: unknown, opts?: unknown) {
      enqueuedJobs.push({ queue: this.qname, name, payload, opts });
      return Promise.resolve({ id: `${this.qname}:${enqueuedJobs.length}` });
    }
  },
}));
vi.mock("ioredis", () => ({ Redis: class {} }));

/** "Today" in the default business timezone (no settings ⇒ Europe/Rome). */
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const plusDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const stubCtx = (): ProcessorContext => {
  const noop = () => undefined;
  return { logger: { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger };
};

beforeEach(() => {
  vi.clearAllMocks();
  enqueuedJobs.length = 0;
});

describe("recurringTickHandler — scheduled-send finalize", () => {
  it("finalizes due scheduled invoices, assigning {seq}/{year} numbers", async () => {
    const invoices = [
      { id: "i1", version: 1, clientId: "c1", currency: "EUR", issueDate: "2026-07-01", status: "scheduled", scheduledSendDate: "2026-07-01" },
      { id: "i2", version: 1, clientId: "c1", currency: "EUR", issueDate: "2026-07-05", status: "scheduled", scheduledSendDate: "2026-07-05" },
    ];
    const { db, finalizedCalls } = makeDb(invoices);
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    const result = await recurringTickHandler({} as never, stubCtx());

    expect(result.finalized).toBe(2);
    expect(finalizedCalls.map((c) => c.number)).toEqual(["1/2026", "2/2026"]);
    // both docs flipped to finalized
    expect(invoices.every((i) => i.status === "finalized")).toBe(true);
  });

  it("is idempotent: an already-finalized doc (status guard) is not re-finalized", async () => {
    const invoices = [
      { id: "i1", version: 1, clientId: "c1", currency: "EUR", issueDate: "2026-07-01", status: "finalized", scheduledSendDate: "2026-07-01" },
    ];
    const { db, finalizedCalls } = makeDb(invoices);
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    const result = await recurringTickHandler({} as never, stubCtx());
    // find() returned it (test feeds it), but the status guard rejects the update.
    expect(result.finalized).toBe(0);
    expect(finalizedCalls).toHaveLength(0);
  });
});

describe("recurringTickHandler — recurring-profile auto-generate", () => {
  it("generates a finalized occurrence from a due active profile + advances nextRunAt", async () => {
    const profiles = [
      {
        id: "p1", version: 1, clientId: "c1", currency: "EUR",
        interval: "monthly", intervalCount: 1, nextRunAt: "2026-07-01",
        endDate: null, maxOccurrences: null, occurrencesGenerated: 0, status: "active",
        lineItems: [{ lineSubtotalMinor: 10000, lineDiscountMinor: 0, lineTaxMinor: 2200, lineTotalMinor: 12200 }],
      },
    ];
    const { db, insertedInvoices } = makeDb([], profiles);
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    const result = await recurringTickHandler({} as never, stubCtx());

    expect(result.generated).toBe(1);
    // one finalized invoice created, money summed from the computed lines
    expect(insertedInvoices).toHaveLength(1);
    expect(insertedInvoices[0]).toMatchObject({ status: "finalized", grandTotalMinor: 12200, sourceRecurringProfileId: "p1" });
    // Backdated occurrence → issued today (account tz), numbered in today's year.
    expect(insertedInvoices[0]!.invoiceNumber).toBe(`1/${TODAY.slice(0, 4)}`);
    expect(insertedInvoices[0]!.issueDate).toBe(TODAY);
    // profile advanced monthly + occurrence counted
    expect(profiles[0]!.nextRunAt).toBe("2026-08-01");
    expect(profiles[0]!.occurrencesGenerated).toBe(1);
    expect(profiles[0]!.status).toBe("active");
  });

  it("marks the profile completed when maxOccurrences is reached", async () => {
    const profiles = [
      {
        id: "p2", version: 1, clientId: "c1", currency: "EUR",
        interval: "monthly", intervalCount: 1, nextRunAt: "2026-07-01",
        endDate: null, maxOccurrences: 1, occurrencesGenerated: 0, status: "active",
        lineItems: [{ lineSubtotalMinor: 5000, lineDiscountMinor: 0, lineTaxMinor: 0, lineTotalMinor: 5000 }],
      },
    ];
    const { db, insertedInvoices } = makeDb([], profiles);
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    const result = await recurringTickHandler({} as never, stubCtx());
    expect(result.generated).toBe(1);
    expect(insertedInvoices).toHaveLength(1);
    expect(profiles[0]!.status).toBe("completed"); // exhausted after 1
  });

  it("generates the right DOCUMENT TYPE (proforma → proformas coll, slashYear number, issued)", async () => {
    const profiles = [
      {
        id: "p3", version: 1, clientId: "c1", currency: "EUR", documentType: "proforma",
        interval: "monthly", intervalCount: 1, nextRunAt: "2026-07-01",
        endDate: null, maxOccurrences: null, occurrencesGenerated: 0, status: "active",
        lineItems: [{ lineSubtotalMinor: 7000, lineDiscountMinor: 0, lineTaxMinor: 0, lineTotalMinor: 7000 }],
      },
    ];
    const { db, insertedInvoices } = makeDb([], profiles);
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    const result = await recurringTickHandler({} as never, stubCtx());
    expect(result.generated).toBe(1);
    expect(insertedInvoices[0]).toMatchObject({
      __collection: "proformas",
      status: "issued",
      proformaNumber: `1/${TODAY.slice(0, 4)}`,
      grandTotalMinor: 7000,
    });
    // NOT an invoice
    expect(insertedInvoices[0]!.invoiceNumber).toBeUndefined();
  });

  it("generates an expense (expenses coll, EXP- number, single amount)", async () => {
    const profiles = [
      {
        id: "p4", version: 1, clientId: "c1", currency: "EUR", documentType: "expense",
        interval: "monthly", intervalCount: 1, nextRunAt: "2026-07-01",
        endDate: null, maxOccurrences: null, occurrencesGenerated: 0, status: "active",
        lineItems: [{ lineSubtotalMinor: 3000, lineDiscountMinor: 0, lineTaxMinor: 0, lineTotalMinor: 3000 }],
      },
    ];
    const { db, insertedInvoices } = makeDb([], profiles);
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    const result = await recurringTickHandler({} as never, stubCtx());
    expect(result.generated).toBe(1);
    expect(insertedInvoices[0]).toMatchObject({ __collection: "expenses", amountMinor: 3000, expenseNumber: `EXP-${TODAY.slice(0, 4)}-0001` });
  });
});

describe("recurringTickHandler — auto-send (Scan 3)", () => {
  const autoSendProfile = (over: Record<string, unknown> = {}) => ({
    id: "pAS", version: 1, clientId: "c1", currency: "EUR", documentType: "invoice",
    interval: "monthly", intervalCount: 1, nextRunAt: "2026-07-01",
    endDate: null, maxOccurrences: null, occurrencesGenerated: 0, status: "active",
    lineItems: [{ lineSubtotalMinor: 10000, lineDiscountMinor: 0, lineTaxMinor: 0, lineTotalMinor: 10000 }],
    autoSend: { enabled: true, to: "billing@client.co", subject: "Invoice {{document.number}} for {{client.name}}", body: "Hello {{client.name}}, see attached." },
    ...over,
  });

  it("generation stamps autoSendPending + enqueues the occurrence PDF when autoSend is on", async () => {
    const profiles = [autoSendProfile()];
    const { db, insertedInvoices } = makeDb([], profiles);
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    await recurringTickHandler({} as never, stubCtx());
    // The generated occurrence carries the pending marker.
    expect(insertedInvoices[0]).toMatchObject({ autoSendPending: true, autoSendAt: null });
    // A pdf render was enqueued for it.
    const pdfJob = enqueuedJobs.find((j) => j.queue === "pdf");
    expect(pdfJob).toBeTruthy();
    expect((pdfJob!.payload as { documentType: string }).documentType).toBe("invoice");
    // No email yet — the PDF isn't clean in the same tick.
    expect(enqueuedJobs.some((j) => j.queue === "email")).toBe(false);
  });

  it("sends a pending occurrence once its PDF is clean: resolves placeholders, enqueues email, marks sent", async () => {
    // A previously-generated occurrence already pending, WITH a clean PDF on file.
    const occ = {
      id: "invAS", version: 5, accountId: "default", currency: "EUR", issueDate: "2026-07-01",
      invoiceNumber: "7/2026", grandTotalMinor: 10000, sourceRecurringProfileId: "pAS",
      clientSnapshot: { displayName: "Acme SpA", email: "snapshot@acme.co" },
      autoSendPending: true, status: "finalized",
    };
    const profiles = [autoSendProfile({ nextRunAt: "2099-01-01" })]; // not due → no generation this tick
    const files = [{ id: "f1", ownerType: "invoice", ownerId: "invAS", contentType: "application/pdf", filename: "7-2026.pdf", scanStatus: "clean", deletedAt: null, createdAt: "2026-07-01T01:00:00Z" }];
    const settings = [{ key: "business", accountId: "default", data: { businessName: "My Co" } }];
    const { db } = makeDb([occ], profiles, { files, settings });
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    const result = await recurringTickHandler({} as never, stubCtx());

    expect(result.autoSent).toBe(1);
    const emailJob = enqueuedJobs.find((j) => j.queue === "email");
    expect(emailJob).toBeTruthy();
    const p = emailJob!.payload as { to: string; attachments: { fileId: string }[]; data: { subject: string; html: string } };
    expect(p.to).toBe("billing@client.co"); // configured `to` wins over the snapshot
    expect(p.attachments[0]!.fileId).toBe("f1");
    // Placeholders resolved against THIS occurrence: {{document.number}} + {{client.name}}.
    expect(p.data.subject).toBe("Invoice 7/2026 for Acme SpA");
    expect(p.data.html).toContain("Hello Acme SpA");
    expect(p.data.subject).not.toContain("{{");
    // Marked sent (pending cleared) → idempotent.
    expect(occ.autoSendPending).toBe(false);
    expect((occ as { autoSendAt?: string }).autoSendAt).toBeTruthy();
  });

  it("does NOT send when the PDF is not clean yet (re-enqueues render, leaves pending)", async () => {
    const occ = {
      id: "invNoPdf", version: 2, accountId: "default", currency: "EUR", issueDate: "2026-07-01",
      invoiceNumber: "8/2026", grandTotalMinor: 5000, sourceRecurringProfileId: "pAS",
      clientSnapshot: { displayName: "Acme", email: "a@b.c" }, autoSendPending: true,
    };
    const profiles = [autoSendProfile({ nextRunAt: "2099-01-01" })];
    const files = [{ id: "f2", ownerType: "invoice", ownerId: "invNoPdf", contentType: "application/pdf", scanStatus: "pending", deletedAt: null, createdAt: "2026-07-01T01:00:00Z" }];
    const { db } = makeDb([occ], profiles, { files });
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    const result = await recurringTickHandler({} as never, stubCtx());
    expect(result.autoSent).toBe(0);
    expect(enqueuedJobs.some((j) => j.queue === "email")).toBe(false);
    // Still pending for a later tick; a render was (re-)enqueued.
    expect(occ.autoSendPending).toBe(true);
    expect(enqueuedJobs.some((j) => j.queue === "pdf")).toBe(true);
  });

  it("clears the pending flag (no email) when the profile's auto-send was turned OFF", async () => {
    const occ = {
      id: "invOff", version: 1, accountId: "default", currency: "EUR", issueDate: "2026-07-01",
      invoiceNumber: "9/2026", grandTotalMinor: 5000, sourceRecurringProfileId: "pAS",
      clientSnapshot: { displayName: "Acme", email: "a@b.c" }, autoSendPending: true,
    };
    // Profile exists but auto-send is now disabled (user toggled it off after generation).
    const profiles = [autoSendProfile({ nextRunAt: "2099-01-01", autoSend: { enabled: false } })];
    const files = [{ id: "f3", ownerType: "invoice", ownerId: "invOff", contentType: "application/pdf", scanStatus: "clean", deletedAt: null, createdAt: "2026-07-01T01:00:00Z" }];
    const { db } = makeDb([occ], profiles, { files });
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    const result = await recurringTickHandler({} as never, stubCtx());
    expect(result.autoSent).toBe(0);
    expect(enqueuedJobs.some((j) => j.queue === "email")).toBe(false);
    // Stale pending flag cleared → the scan won't re-read it every tick.
    expect(occ.autoSendPending).toBe(false);
  });

  it("attaches clean extra attachments and DROPS unavailable ones (invoice PDF always sent)", async () => {
    const occ = {
      id: "invExtra", version: 1, accountId: "default", currency: "EUR", issueDate: "2026-07-01",
      invoiceNumber: "10/2026", grandTotalMinor: 10000, sourceRecurringProfileId: "pAS",
      clientSnapshot: { displayName: "Acme", email: "a@b.c" }, autoSendPending: true,
    };
    const profiles = [autoSendProfile({ nextRunAt: "2099-01-01", autoSend: {
      enabled: true, to: "b@acme.co", subject: "S", body: "B",
      attachmentFileIds: ["extraClean", "extraDirty", "extraMissing"],
    } })];
    const files = [
      // the occurrence's own PDF
      { id: "pdf1", ownerType: "invoice", ownerId: "invExtra", contentType: "application/pdf", filename: "10-2026.pdf", scanStatus: "clean", accountId: "default", deletedAt: null, createdAt: "2026-07-01T01:00:00Z" },
      // extras
      { id: "extraClean", filename: "terms.pdf", scanStatus: "clean", accountId: "default", deletedAt: null },
      { id: "extraDirty", filename: "virus.pdf", scanStatus: "pending", accountId: "default", deletedAt: null },
      // extraMissing intentionally absent
    ];
    const { db } = makeDb([occ], profiles, { files });
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    const result = await recurringTickHandler({} as never, stubCtx());
    expect(result.autoSent).toBe(1);
    const emailJob = enqueuedJobs.find((j) => j.queue === "email");
    const atts = (emailJob!.payload as { attachments: { fileId: string }[] }).attachments;
    // occurrence PDF + only the clean extra; dirty + missing dropped.
    expect(atts.map((a) => a.fileId)).toEqual(["pdf1", "extraClean"]);
  });
});

describe("recurringTickHandler — scheduled finalize: fiscal correctness (e-invoicing prerequisites)", () => {
  const sched = (over: Record<string, unknown> = {}) => ({
    id: "i1", version: 1, accountId: "acct1", clientId: "c1", currency: "EUR",
    issueDate: "2020-01-01", dueDate: "2020-01-31", status: "scheduled", scheduledSendDate: "2020-01-05", ...over,
  });

  it("numbers from the PER-ACCOUNT series (same counter key as the api), never a shared one", async () => {
    const invoices = [sched({ id: "i1", accountId: "acctA" }), sched({ id: "i2", accountId: "acctB" })];
    const { db, counters, finalizedCalls } = makeDb(invoices);
    currentDb = db;
    const year = new Date().getUTCFullYear();
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    await recurringTickHandler({} as never, stubCtx());
    expect([...counters.keys()].sort()).toEqual([`acctA:invoice-${year}`, `acctB:invoice-${year}`]);
    // each account starts its own sequence at 1
    expect(finalizedCalls.map((c) => c.number)).toEqual([`1/${year}`, `1/${year}`]);
  });

  it("looks the client up scoped by the invoice's accountId", async () => {
    const { db, clientLookups } = makeDb([sched({ accountId: "acctZ" })]);
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    await recurringTickHandler({} as never, stubCtx());
    expect(clientLookups[0]).toMatchObject({ id: "c1", accountId: "acctZ" });
  });

  it("freezes the full fiscal client snapshot (SDI code, PEC, CF, country) like the api does", async () => {
    const { db, finalizedCalls } = makeDb([sched()]);
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    await recurringTickHandler({} as never, stubCtx());
    expect(finalizedCalls[0]!.set.clientSnapshot).toMatchObject({
      clientId: "c1", type: "company", recipientCode: "ABC1234", pecEmail: "acme@pec.it",
      taxCode: "01234567890", vatNumber: "IT01234567890", country: "IT", currency: "EUR",
    });
  });

  it("sets issueDate to the real finalize date and preserves the payment term", async () => {
    const { db, finalizedCalls } = makeDb([sched()]); // drafted 2020-01-01, due +30d
    currentDb = db;
    const { recurringTickHandler, todayIn } = await import("@/handlers/recurring.js");
    await recurringTickHandler({} as never, stubCtx());
    const today = todayIn("Europe/Rome");
    const set = finalizedCalls[0]!.set as { issueDate: string; dueDate: string };
    expect(set.issueDate).toBe(today);
    const gap = (Date.parse(set.dueDate) - Date.parse(set.issueDate)) / 86_400_000;
    expect(gap).toBe(30);
  });

  it("uses the account's business timezone (default Europe/Rome) for 'today'", async () => {
    const { todayIn } = await import("@/handlers/recurring.js");
    // 23:30 UTC on Dec 31 is already Jan 1 in Rome and Auckland, still Dec 31 in New York.
    const at = new Date("2026-12-31T23:30:00Z");
    expect(todayIn("Europe/Rome", at)).toBe("2027-01-01");
    expect(todayIn("America/New_York", at)).toBe("2026-12-31");
    expect(todayIn("Not/AZone", at)).toBe("2026-12-31"); // bad zone → UTC, never throws
  });

  it("does not finalize an invoice whose send date is still tomorrow in the account's timezone", async () => {
    const { todayIn } = await import("@/handlers/recurring.js");
    const tomorrow = new Date(Date.parse(`${todayIn("Europe/Rome")}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const { db, finalizedCalls } = makeDb([sched({ scheduledSendDate: tomorrow })]);
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    const result = await recurringTickHandler({} as never, stubCtx());
    expect(result.finalized).toBe(0);
    expect(finalizedCalls).toHaveLength(0);
  });
});

describe("recurringTickHandler — payment term + generate-now", () => {
  const baseProfile = (over: Record<string, unknown> = {}) => ({
    id: "p1", version: 1, accountId: "default", clientId: "c1", currency: "EUR",
    interval: "monthly", intervalCount: 1, nextRunAt: "2026-07-15",
    endDate: null, maxOccurrences: null, occurrencesGenerated: 0, status: "active",
    lineItems: [{ lineSubtotalMinor: 10000, lineDiscountMinor: 0, lineTaxMinor: 0, lineTotalMinor: 10000 }],
    ...over,
  });

  it("dates a generated invoice due 7 days after issue when the profile stores no term", async () => {
    const { db, insertedInvoices } = makeDb([], [baseProfile({ nextRunAt: TODAY })]);
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    await recurringTickHandler({} as never, stubCtx());
    expect(insertedInvoices[0]).toMatchObject({ issueDate: TODAY, dueDate: plusDays(TODAY, 7) });
  });

  it("uses the profile's stored paymentTermDays (0 = due on issue)", async () => {
    const profiles = [baseProfile({ nextRunAt: TODAY, paymentTermDays: 30 }), baseProfile({ id: "p2", nextRunAt: TODAY, paymentTermDays: 0 })];
    const { db, insertedInvoices } = makeDb([], profiles);
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    await recurringTickHandler({} as never, stubCtx());
    expect(insertedInvoices.find((d) => d.sourceRecurringProfileId === "p1")).toMatchObject({ dueDate: plusDays(TODAY, 30) });
    expect(insertedInvoices.find((d) => d.sourceRecurringProfileId === "p2")).toMatchObject({ dueDate: TODAY });
  });

  it("generate-now creates the NEXT occurrence even before it is due (issued today), and advances the profile", async () => {
    const profiles = [baseProfile({ nextRunAt: "2999-01-15" })];
    const { db, insertedInvoices } = makeDb([], profiles);
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    const res = await recurringTickHandler(
      { recurringProfileId: "p1", scheduledOccurrenceDate: "2999-01-15", accountId: "default", generateNow: true },
      stubCtx(),
    );
    expect(res.generated).toBe(1);
    expect(insertedInvoices).toHaveLength(1);
    // Issued TODAY (chronological numbering), term counted from today; the
    // schedule still advances from the occurrence date.
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const due = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    expect(insertedInvoices[0]).toMatchObject({ issueDate: today, dueDate: due, sourceRecurringProfileId: "p1" });
    expect(profiles[0]!.nextRunAt).toBe("2999-02-15");
    expect(profiles[0]!.occurrencesGenerated).toBe(1);
  });

  it("a replayed/stale generate-now (nextRunAt already moved on) creates nothing", async () => {
    const profiles = [baseProfile({ nextRunAt: "2999-02-15" })];
    const { db, insertedInvoices } = makeDb([], profiles);
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    const res = await recurringTickHandler(
      { recurringProfileId: "p1", scheduledOccurrenceDate: "2999-01-15", accountId: "default", generateNow: true },
      stubCtx(),
    );
    expect(res.generated).toBe(0);
    expect(insertedInvoices).toHaveLength(0);
  });
});

describe("recurringTickHandler — audit fixes (bank/notes/project, exhaustion, numbering, catch-up, proforma, expense, deleted client)", () => {
  const prof = (over: Record<string, unknown> = {}) => ({
    id: "p1", version: 1, accountId: "default", clientId: "c1", currency: "EUR",
    interval: "monthly", intervalCount: 1, nextRunAt: TODAY,
    endDate: null, maxOccurrences: null, occurrencesGenerated: 0, status: "active",
    lineItems: [{ description: "Hosting", lineSubtotalMinor: 10000, lineDiscountMinor: 0, lineTaxMinor: 0, lineTotalMinor: 10000 }],
    ...over,
  });
  const BANKS = [
    { id: "b1", label: "Main EUR", details: "IBAN IT00\nBIC ABCDIT22", iban: "IT60X0542811101000000123456" },
    { id: "b2", label: "USD", details: "ACC 123" },
  ];
  const bizSettings = (bankAccounts: unknown[]) => [{ key: "business", accountId: "default", data: { bankAccounts } }];

  it("copies notes, subject and project, and snapshots the chosen bank (with iban) onto an invoice", async () => {
    const profiles = [prof({ notes: "Thanks!", subject: "Hosting", projectId: "proj1", bankAccountId: "b1" })];
    const { db, insertedInvoices } = makeDb([], profiles, { settings: bizSettings(BANKS) });
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    await recurringTickHandler({} as never, stubCtx());
    expect(insertedInvoices[0]).toMatchObject({
      notes: "Thanks!",
      subject: "Hosting",
      projectId: "proj1",
      bankSnapshot: { label: "Main EUR", details: "IBAN IT00\nBIC ABCDIT22", iban: "IT60X0542811101000000123456" },
    });
  });

  it("defaults to the single bank account when the profile stores none; null when ambiguous", async () => {
    const { resolveBankSnapshot } = await import("@/handlers/recurring.js");
    expect(resolveBankSnapshot([BANKS[1]!], null, "invoice")).toEqual({ label: "USD", details: "ACC 123" });
    expect(resolveBankSnapshot(BANKS, null, "invoice")).toBeNull();
    expect(resolveBankSnapshot(BANKS, "gone", "invoice")).toBeNull();
    expect(resolveBankSnapshot([], null, "invoice")).toBeNull();
    // Proforma snapshot has no iban (its type is { label, details }).
    expect(resolveBankSnapshot(BANKS, "b1", "proforma")).toEqual({ label: "Main EUR", details: "IBAN IT00\nBIC ABCDIT22" });
  });

  it("pre-checks exhaustion: maxOccurrences already reached → completed, no document, no number", async () => {
    const profiles = [prof({ maxOccurrences: 2, occurrencesGenerated: 2 })];
    const { db, insertedInvoices, counters } = makeDb([], profiles);
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    const res = await recurringTickHandler({} as never, stubCtx());
    expect(res.generated).toBe(0);
    expect(insertedInvoices).toHaveLength(0);
    expect(counters.size).toBe(0);
    expect(profiles[0]!.status).toBe("completed");
  });

  it("pre-checks exhaustion: nextRunAt already past endDate → completed, no document", async () => {
    const profiles = [prof({ endDate: plusDays(TODAY, -1) })];
    const { db, insertedInvoices, counters } = makeDb([], profiles);
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    await recurringTickHandler({} as never, stubCtx());
    expect(insertedInvoices).toHaveLength(0);
    expect(counters.size).toBe(0);
    expect(profiles[0]!.status).toBe("completed");
  });

  it("allocates no number when the version-guarded advance loses the race", async () => {
    // The listed profile is stale (version 1) but the stored one moved on (version 2).
    const stored = prof({ version: 2 });
    const { db, insertedInvoices, counters } = makeDb([], [stored]);
    const stale = { ...stored, version: 1 };
    const realCollection = db.collection.bind(db);
    db.collection = ((name: string) => {
      const c = realCollection(name) as Record<string, unknown>;
      if (name === "recurringProfiles") return { ...c, find: () => ({ toArray: () => Promise.resolve([stale]) }) };
      return c;
    }) as typeof db.collection;
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    const res = await recurringTickHandler({} as never, stubCtx());
    expect(res.generated).toBe(0);
    expect(insertedInvoices).toHaveLength(0);
    expect(counters.size).toBe(0);
  });

  it("backdated occurrence is issued TODAY with the term counted from today; schedule advances from the occurrence date", async () => {
    const past = plusDays(TODAY, -40);
    const profiles = [prof({ nextRunAt: past, paymentTermDays: 10 })];
    const { db, insertedInvoices, counters } = makeDb([], profiles);
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    await recurringTickHandler({} as never, stubCtx());
    expect(insertedInvoices[0]).toMatchObject({ issueDate: TODAY, dueDate: plusDays(TODAY, 10), invoiceNumber: `1/${TODAY.slice(0, 4)}` });
    expect([...counters.keys()]).toEqual([`default:invoice-${TODAY.slice(0, 4)}`]);
    const { advanceRecurrence } = await import("@billy/shared");
    expect(profiles[0]!.nextRunAt).toBe(advanceRecurrence(past, "monthly", 1));
  });

  it("proforma: writes expiryDate = issue + term and NO invoice payment fields", async () => {
    const profiles = [prof({ documentType: "proforma", paymentTermDays: 15, notes: "N", bankAccountId: "b1" })];
    const { db, insertedInvoices } = makeDb([], profiles, { settings: bizSettings(BANKS) });
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    await recurringTickHandler({} as never, stubCtx());
    const doc = insertedInvoices[0]!;
    expect(doc).toMatchObject({ __collection: "proformas", status: "issued", issueDate: TODAY, expiryDate: plusDays(TODAY, 15), notes: "N" });
    expect(doc.bankSnapshot).toEqual({ label: "Main EUR", details: "IBAN IT00\nBIC ABCDIT22" });
    for (const k of ["dueDate", "amountPaidMinor", "amountDueMinor", "payments", "invoiceNumber"]) expect(doc).not.toHaveProperty(k);
  });

  it("expense: draft status, carries category/vendor/description/billable/project, no invoice-only fields", async () => {
    const profiles = [prof({
      documentType: "expense", projectId: "proj9",
      expense: { category: "Software", vendor: "Hetzner", description: "VPS", billable: true },
      lineItems: [{ description: "VPS", lineSubtotalMinor: 2500, lineDiscountMinor: 0, lineTaxMinor: 0, lineTotalMinor: 2500 }],
    })];
    const { db, insertedInvoices } = makeDb([], profiles);
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    await recurringTickHandler({} as never, stubCtx());
    const doc = insertedInvoices[0]!;
    expect(doc).toMatchObject({
      __collection: "expenses", status: "draft", amountMinor: 2500, date: TODAY,
      category: "Software", vendor: "Hetzner", description: "VPS", billable: true,
      projectId: "proj9", clientId: "c1", sourceRecurringProfileId: "p1", invoiceId: null,
    });
    for (const k of ["lineItems", "clientSnapshot", "grandTotalMinor", "subtotalMinor", "taxMinor", "issueDate", "subject"]) expect(doc).not.toHaveProperty(k);
  });

  it("expense from a legacy profile (no expense block) still gets a non-empty vendor/category", async () => {
    const profiles = [prof({ documentType: "expense", notes: "Office rent" })];
    const { db, insertedInvoices } = makeDb([], profiles);
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    await recurringTickHandler({} as never, stubCtx());
    expect(insertedInvoices[0]).toMatchObject({ status: "draft", category: "recurring", vendor: "Hosting", description: "Office rent", billable: false });
  });

  it("deleted client: skips the occurrence (no document, no number, profile not advanced)", async () => {
    const profiles = [prof()];
    const { db, insertedInvoices, counters } = makeDb([], profiles, { clientMissing: true });
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    const res = await recurringTickHandler({} as never, stubCtx());
    expect(res.generated).toBe(0);
    expect(insertedInvoices).toHaveLength(0);
    expect(counters.size).toBe(0);
    expect(profiles[0]!).toMatchObject({ nextRunAt: TODAY, occurrencesGenerated: 0, status: "active", version: 1 });
  });

  it("auto-send of a proforma resolves {{expiryDate}} from its expiry date", async () => {
    const occ = {
      id: "pro1", version: 1, accountId: "default", currency: "EUR", issueDate: "2026-07-01", expiryDate: "2026-07-31",
      proformaNumber: "3/2026", grandTotalMinor: 100, sourceRecurringProfileId: "pAS",
      clientSnapshot: { displayName: "Acme", email: "a@b.c" }, autoSendPending: true,
    };
    const profiles = [prof({ id: "pAS", documentType: "proforma", nextRunAt: "2099-01-01", autoSend: { enabled: true, to: "x@y.z", subject: "Valid until {{expiryDate}}", body: "B" } })];
    const files = [{ id: "fp", ownerType: "proforma", ownerId: "pro1", contentType: "application/pdf", filename: "p.pdf", scanStatus: "clean", deletedAt: null, createdAt: "2026-07-01T01:00:00Z" }];
    const { db } = makeDb([], profiles, { files, proformas: [occ] });
    currentDb = db;
    const { recurringTickHandler } = await import("@/handlers/recurring.js");
    await recurringTickHandler({} as never, stubCtx());
    const emailJob = enqueuedJobs.find((j) => j.queue === "email");
    const subject = (emailJob!.payload as { data: { subject: string } }).data.subject;
    expect(subject).not.toContain("{{");
    // Rendered from the proforma's expiry (2026-07-31), never empty.
    expect(subject).toMatch(/31/);
    expect(subject).not.toBe("Valid until ");
  });
});
