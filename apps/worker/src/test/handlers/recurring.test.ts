import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "@billy/shared";
import type { ProcessorContext } from "@/processors.js";

const makeDb = (
  scheduledInvoices: Record<string, unknown>[],
  profiles: Record<string, unknown>[] = [],
  extra: { files?: Record<string, unknown>[]; settings?: Record<string, unknown>[]; proformas?: Record<string, unknown>[] } = {},
) => {
  const counters = new Map<string, number>();
  const finalizedCalls: { id: string; number: string }[] = [];
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
            Promise.resolve(settings.find((s) => (s as { key: string }).key === filter.key) ?? null),
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
        return { findOne: () => Promise.resolve({ id: "c1", displayName: "Acme", email: "a@b.c" }) };
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
              finalizedCalls.push({ id: (filter as { id: string }).id, number: (update.$set as { invoiceNumber: string }).invoiceNumber });
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
          findOne: (filter: { id: string }) => Promise.resolve(profiles.find((x) => (x as { id: string }).id === filter.id) ?? null),
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
  return { db, counters, finalizedCalls, insertedInvoices };
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
    expect(insertedInvoices[0]!.invoiceNumber).toBe("1/2026");
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
      proformaNumber: "1/2026",
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
    expect(insertedInvoices[0]).toMatchObject({ __collection: "expenses", amountMinor: 3000, expenseNumber: "EXP-2026-0001" });
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
