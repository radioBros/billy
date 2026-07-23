import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "@billy/shared";
import type { ProcessorContext } from "@/processors.js";

const makeDb = (scheduledInvoices: Record<string, unknown>[], profiles: Record<string, unknown>[] = []) => {
  const counters = new Map<string, number>();
  const finalizedCalls: { id: string; number: string }[] = [];
  const insertedInvoices: Record<string, unknown>[] = [];
  const db = {
    collection(name: string) {
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
          find: () => ({ toArray: () => Promise.resolve(scheduledInvoices) }),
          findOneAndUpdate: (filter: { id: string; status: string }, update: { $set: { invoiceNumber: string } }) => {
            // Simulate the status guard: only flips if still scheduled.
            const inv = scheduledInvoices.find((i) => (i as { id: string }).id === filter.id);
            if (!inv || (inv as { status: string }).status !== "scheduled") return Promise.resolve(null);
            (inv as { status: string }).status = "finalized";
            finalizedCalls.push({ id: filter.id, number: update.$set.invoiceNumber });
            return Promise.resolve({ ...inv, ...update.$set });
          },
          insertOne: (doc: Record<string, unknown>) => {
            insertedInvoices.push(doc);
            return Promise.resolve({ insertedId: doc.id });
          },
        };
      }
      if (name === "proformas" || name === "expenses") {
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
vi.mock("@billy/config", () => ({ loadConfig: () => ({ MONGO_URI: "mongodb://x/db" }) }));

const stubCtx = (): ProcessorContext => {
  const noop = () => undefined;
  return { logger: { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger };
};

beforeEach(() => {
  vi.clearAllMocks();
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
