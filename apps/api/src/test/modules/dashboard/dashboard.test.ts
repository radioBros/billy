import { describe, it, expect } from "vitest";
import type { Db } from "mongodb";
import type { AuthContext, Capabilities } from "@billy/types";
import { createLogger } from "@billy/shared";
import {
  DashboardService,
  RECENT_ACTIVITY_DAYS,
  aggregateInvoiceTotals,
  aggregateInvoiceTotalsForPeriod,
  buildMonthlyCounts,
  buildMonthlyTotals,
  buildRevenueSeries,
  buildYearSeries,
  deriveYearRange,
  monthlyFactor,
  normalizeMrrByCurrency,
  roundHalfAwayFromZero,
  shapeSummary,
  sumByCurrency,
  yearMonthKeys,
  type InvoiceMoneyRow,
} from "@/modules/dashboard/service.js";
import type { ExpenseMoneyRow } from "@/modules/dashboard/types.js";

/** Empty invoice/quote totals (all four maps empty) — used as a fixture. */
const EMPTY_INVOICE_QUOTE = { invoicedThisMonth: {}, collectedThisMonth: {}, outstanding: {}, overdue: {} };
import type {
  DashboardCounts,
  DashboardFinancials,
  DashboardRecentActivity,
  SubscriptionMoneyRow,
} from "@/modules/dashboard/types.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const logger = createLogger({ level: "silent", pretty: false, service: "test" });

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  canManageSettings: true,
  canManageUsers: true,
  canPermanentlyDelete: true,
  canViewFinancialTotals: true,
  canExportData: true,
  ...over,
});

const adminCtx: AuthContext = { userId: "u1", role: "administrator", capabilities: caps(), accountId: "default" };

/** A member WITHOUT canViewFinancialTotals — financials must be stripped (SEC5). */
const restrictedMember: AuthContext = {
  userId: "m1",
  role: "member",
  capabilities: caps({ canViewFinancialTotals: false }),
  accountId: "default",
};

// ── Pure helpers ───────────────────────────────────────────────────────────

describe("roundHalfAwayFromZero (conventions §1)", () => {
  it("rounds .5 away from zero for positives and negatives", () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3); // Math.round would give -2
    expect(roundHalfAwayFromZero(2.4)).toBe(2);
    expect(roundHalfAwayFromZero(100)).toBe(100);
  });
});

describe("monthlyFactor", () => {
  it("normalizes each interval to a per-month factor", () => {
    expect(monthlyFactor("monthly")).toBe(1);
    expect(monthlyFactor("quarterly")).toBeCloseTo(1 / 3, 10);
    expect(monthlyFactor("yearly")).toBeCloseTo(1 / 12, 10);
    expect(monthlyFactor("weekly")).toBeCloseTo(52 / 12, 10);
  });
});

describe("sumByCurrency (per-currency grouping, never blended — L2)", () => {
  it("groups totals by currency and never sums across currencies", () => {
    const totals = sumByCurrency([
      { currency: "EUR", amountMinor: 1000 },
      { currency: "USD", amountMinor: 500 },
      { currency: "EUR", amountMinor: 234 },
    ]);
    expect(totals).toEqual({ EUR: 1234, USD: 500 });
  });

  it("returns an empty map for no rows", () => {
    expect(sumByCurrency([])).toEqual({});
  });

  it("rounds each line half-away-from-zero before summing", () => {
    // 2.5 → 3, 3.5 → 4 (per-line), summed = 7 (not round(6.0)=6 in this case,
    // but proves per-line rounding is applied via the helper).
    expect(sumByCurrency([
      { currency: "EUR", amountMinor: 2.5 },
      { currency: "EUR", amountMinor: 3.5 },
    ])).toEqual({ EUR: 7 });
  });
});

describe("normalizeMrrByCurrency (MRR normalization, D2)", () => {
  const row = (over: Partial<SubscriptionMoneyRow>): SubscriptionMoneyRow => ({
    currency: "EUR",
    amountMinor: 1200,
    interval: "monthly",
    status: "active",
    ...over,
  });

  it("normalizes intervals to a monthly figure per currency", () => {
    const mrr = normalizeMrrByCurrency([
      row({ interval: "monthly", amountMinor: 1200 }), // 1200/mo
      row({ interval: "yearly", amountMinor: 1200 }), // 100/mo
      row({ interval: "quarterly", amountMinor: 300 }), // 100/mo
    ]);
    expect(mrr).toEqual({ EUR: 1200 + 100 + 100 });
  });

  it("groups MRR by currency and never blends", () => {
    const mrr = normalizeMrrByCurrency([
      row({ currency: "EUR", interval: "monthly", amountMinor: 1000 }),
      row({ currency: "USD", interval: "monthly", amountMinor: 2000 }),
    ]);
    expect(mrr).toEqual({ EUR: 1000, USD: 2000 });
  });

  it("excludes non-active (paused / cancelled) subscriptions", () => {
    const mrr = normalizeMrrByCurrency([
      row({ status: "active", amountMinor: 500 }),
      row({ status: "paused", amountMinor: 999 }),
      row({ status: "cancelled", amountMinor: 999 }),
    ]);
    expect(mrr).toEqual({ EUR: 500 });
  });

  it("normalizes weekly as 52/12 per month, rounded half-away-from-zero", () => {
    // 100 * 52/12 = 433.33… → 433
    expect(normalizeMrrByCurrency([row({ interval: "weekly", amountMinor: 100 })])).toEqual({ EUR: 433 });
  });
});

describe("aggregateInvoiceTotals — per-currency invoice roll-ups (D1, L2)", () => {
  const rows: InvoiceMoneyRow[] = [
    // this month (2026-07): finalized, partially paid
    { currency: "EUR", status: "finalized", issueDate: "2026-07-05", dueDate: "2026-08-05", grandTotalMinor: 100000, amountPaidMinor: 0, amountDueMinor: 100000 },
    { currency: "EUR", status: "partially_paid", issueDate: "2026-07-10", dueDate: "2026-07-01", grandTotalMinor: 50000, amountPaidMinor: 20000, amountDueMinor: 30000 },
    // paid this month (fully collected)
    { currency: "USD", status: "paid", issueDate: "2026-07-12", dueDate: "2026-07-20", grandTotalMinor: 80000, amountPaidMinor: 80000, amountDueMinor: 0 },
    // last month, still open + overdue (dueDate < today)
    { currency: "EUR", status: "finalized", issueDate: "2026-06-01", dueDate: "2026-06-15", grandTotalMinor: 40000, amountPaidMinor: 0, amountDueMinor: 40000 },
    // excluded: draft + void never count
    { currency: "EUR", status: "draft", issueDate: "2026-07-02", dueDate: "2026-08-02", grandTotalMinor: 999999, amountPaidMinor: 0, amountDueMinor: 999999 },
    { currency: "EUR", status: "void", issueDate: "2026-07-02", dueDate: "2026-08-02", grandTotalMinor: 999999, amountPaidMinor: 0, amountDueMinor: 999999 },
  ];
  const t = aggregateInvoiceTotals(rows, "2026-07", "2026-07-16T00:00:00.000Z");

  it("invoicedThisMonth sums issued grand totals in the month, per currency, excluding draft/void", () => {
    expect(t.invoicedThisMonth).toEqual({ EUR: 150000, USD: 80000 });
  });
  it("collectedThisMonth sums amountPaid in the month, per currency", () => {
    expect(t.collectedThisMonth).toEqual({ EUR: 20000, USD: 80000 });
  });
  it("outstanding sums amountDue of all open invoices (any date), per currency", () => {
    expect(t.outstanding).toEqual({ EUR: 170000 }); // 100000 + 30000 + 40000; USD paid → 0 due
  });
  it("overdue counts only open invoices past due date", () => {
    expect(t.overdue).toEqual({ EUR: 70000 }); // 30000 (due 07-01) + 40000 (due 06-15)
  });
  it("never blends currencies", () => {
    expect(Object.keys(t.invoicedThisMonth).sort()).toEqual(["EUR", "USD"]);
  });
});

describe("buildRevenueSeries — contiguous monthly buckets (per currency)", () => {
  const rows: InvoiceMoneyRow[] = [
    { currency: "EUR", status: "paid", issueDate: "2026-07-05", dueDate: "2026-07-20", grandTotalMinor: 100000, amountPaidMinor: 100000, amountDueMinor: 0 },
    { currency: "EUR", status: "finalized", issueDate: "2026-05-05", dueDate: "2026-06-05", grandTotalMinor: 30000, amountPaidMinor: 0, amountDueMinor: 30000 },
    { currency: "EUR", status: "draft", issueDate: "2026-07-05", dueDate: "2026-08-05", grandTotalMinor: 999, amountPaidMinor: 0, amountDueMinor: 999 }, // excluded
  ];
  const series = buildRevenueSeries(rows, "2026-07", 3); // May, Jun, Jul

  it("returns a contiguous month range ending at endYm", () => {
    expect(series.map((p) => p.month)).toEqual(["2026-05", "2026-06", "2026-07"]);
  });
  it("buckets invoiced/collected per month per currency, empty months present", () => {
    expect(series[0]!.invoiced).toEqual({ EUR: 30000 }); // May
    expect(series[1]!.invoiced).toEqual({}); // June empty
    expect(series[2]!.invoiced).toEqual({ EUR: 100000 }); // July (draft excluded)
    expect(series[2]!.collected).toEqual({ EUR: 100000 });
  });
});

describe("yearMonthKeys", () => {
  it("enumerates 01..12 of the year", () => {
    const keys = yearMonthKeys(2026);
    expect(keys).toHaveLength(12);
    expect(keys[0]).toBe("2026-01");
    expect(keys[11]).toBe("2026-12");
  });
});

describe("buildYearSeries — all 12 months incl. per-currency expenses", () => {
  const invoices: InvoiceMoneyRow[] = [
    { currency: "EUR", status: "paid", issueDate: "2026-01-05", dueDate: "2026-01-20", grandTotalMinor: 100000, amountPaidMinor: 100000, amountDueMinor: 0 },
    { currency: "USD", status: "finalized", issueDate: "2026-03-10", dueDate: "2026-04-10", grandTotalMinor: 40000, amountPaidMinor: 0, amountDueMinor: 40000 },
    { currency: "EUR", status: "draft", issueDate: "2026-03-01", dueDate: "2026-04-01", grandTotalMinor: 999, amountPaidMinor: 0, amountDueMinor: 999 }, // excluded
    { currency: "EUR", status: "paid", issueDate: "2025-12-31", dueDate: "2026-01-05", grandTotalMinor: 5000, amountPaidMinor: 5000, amountDueMinor: 0 }, // prior year → not in range
  ];
  const expenses: ExpenseMoneyRow[] = [
    { currency: "EUR", amountMinor: 3000, date: "2026-01-15" },
    { currency: "USD", amountMinor: 1200, date: "2026-03-20" },
    { currency: "EUR", amountMinor: 500, date: "2025-06-01" }, // prior year → ignored
    { currency: "EUR", amountMinor: 999 }, // no date → ignored
  ];
  const series = buildYearSeries(invoices, expenses, 2026);

  it("returns exactly 12 contiguous months of the year", () => {
    expect(series.map((p) => p.month)).toEqual(yearMonthKeys(2026));
  });
  it("buckets invoiced/collected per month per currency, excluding drafts + other years", () => {
    expect(series[0]!.invoiced).toEqual({ EUR: 100000 }); // Jan
    expect(series[0]!.collected).toEqual({ EUR: 100000 });
    expect(series[2]!.invoiced).toEqual({ USD: 40000 }); // Mar (draft excluded)
    expect(series[1]!.invoiced).toEqual({}); // Feb empty
  });
  it("adds expense totals per month per currency, never blended", () => {
    expect(series[0]!.expenses).toEqual({ EUR: 3000 }); // Jan
    expect(series[2]!.expenses).toEqual({ USD: 1200 }); // Mar
    expect(series[5]!.expenses).toEqual({}); // Jun (prior-year expense ignored)
  });
});

describe("aggregateInvoiceTotalsForPeriod — period-scoped (year + month subset)", () => {
  const rows: InvoiceMoneyRow[] = [
    { currency: "EUR", status: "finalized", issueDate: "2026-02-05", dueDate: "2026-03-05", grandTotalMinor: 100000, amountPaidMinor: 0, amountDueMinor: 100000 }, // open, past-due vs 07-16 → overdue
    { currency: "EUR", status: "paid", issueDate: "2026-11-10", dueDate: "2026-11-20", grandTotalMinor: 50000, amountPaidMinor: 50000, amountDueMinor: 0 },
    { currency: "EUR", status: "finalized", issueDate: "2025-06-01", dueDate: "2025-06-15", grandTotalMinor: 40000, amountPaidMinor: 0, amountDueMinor: 40000 }, // PRIOR YEAR: now excluded from ALL four metrics (issue-date scoped)
    { currency: "EUR", status: "draft", issueDate: "2026-01-01", dueDate: "2026-02-01", grandTotalMinor: 999999, amountPaidMinor: 0, amountDueMinor: 999999 }, // excluded (draft)
    { currency: "EUR", status: "finalized", issueDate: "2026-08-01", dueDate: "2026-08-15", grandTotalMinor: 20000, amountPaidMinor: 0, amountDueMinor: 20000 }, // Aug, not-yet-due vs 07-16 → outstanding not overdue
  ];
  const today = "2026-07-16T00:00:00.000Z";

  describe("whole year (no month subset)", () => {
    const t = aggregateInvoiceTotalsForPeriod(rows, { year: 2026 }, today);
    it("invoiced sums the whole year of issued invoices (prior year + draft excluded)", () => {
      expect(t.invoicedThisMonth).toEqual({ EUR: 170000 }); // Feb 100000 + Nov 50000 + Aug 20000
    });
    it("collected sums the whole year of paid amounts", () => {
      expect(t.collectedThisMonth).toEqual({ EUR: 50000 });
    });
    it("outstanding/overdue are ISSUE-DATE-scoped to the period (the fix)", () => {
      // The 2025 open invoice is EXCLUDED now — it is not issued in the period.
      expect(t.outstanding).toEqual({ EUR: 120000 }); // Feb 100000 + Aug 20000 (both open in 2026)
      expect(t.overdue).toEqual({ EUR: 100000 }); // only Feb is past due vs 07-16; Aug not-yet-due
    });
  });

  describe("month subset {2} — outstanding/overdue MOVE with the period", () => {
    const t = aggregateInvoiceTotalsForPeriod(rows, { year: 2026, months: [2] }, today);
    it("invoiced/collected narrow to February", () => {
      expect(t.invoicedThisMonth).toEqual({ EUR: 100000 });
      expect(t.collectedThisMonth).toEqual({ EUR: 0 }); // Feb invoice matched but unpaid (0 collected)
    });
    it("outstanding/overdue narrow to Feb-issued invoices (Aug drops out)", () => {
      expect(t.outstanding).toEqual({ EUR: 100000 }); // only the Feb invoice
      expect(t.overdue).toEqual({ EUR: 100000 });
    });
  });

  describe("month subset {8} — a different subset yields different totals", () => {
    const t = aggregateInvoiceTotalsForPeriod(rows, { year: 2026, months: [8] }, today);
    it("only the August invoice contributes; it is outstanding but NOT overdue", () => {
      expect(t.invoicedThisMonth).toEqual({ EUR: 20000 });
      expect(t.outstanding).toEqual({ EUR: 20000 });
      expect(t.overdue).toEqual({}); // due 2026-08-15 > today 2026-07-16
    });
  });
});

describe("buildMonthlyCounts — per-month per-type doc counts + total", () => {
  const series = buildMonthlyCounts(
    {
      invoices: [{ date: "2026-01-05" }, { date: "2026-01-20" }, { date: "2026-03-01" }, { date: null }, { date: undefined }, { date: "2025-01-01" }],
      proforma: [{ date: "2026-01-10" }],
      quotes: [{ date: "2026-03-15" }, { date: "2026-03-16" }],
      creditNotes: [{ date: "2026-12-31" }],
      contracts: [{ date: "2026-01-01" }],
      expenses: [{ date: "2026-01-02" }, { date: "2026-01-03" }, { date: "2026-01-04" }],
    },
    2026,
  );

  it("returns 12 months, each with monthNumber 1..12", () => {
    expect(series).toHaveLength(12);
    expect(series.map((p) => p.monthNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
  it("counts per type per month, ignoring null/undefined/other-year dates", () => {
    const jan = series[0]!;
    expect(jan.counts).toEqual({ invoices: 2, proforma: 1, quotes: 0, creditNotes: 0, contracts: 1, expenses: 3 });
    expect(jan.total).toBe(7);
    const mar = series[2]!;
    expect(mar.counts.invoices).toBe(1);
    expect(mar.counts.quotes).toBe(2);
    expect(mar.total).toBe(3);
    expect(series[11]!.counts.creditNotes).toBe(1); // Dec
  });
  it("zero-fills months with no docs", () => {
    expect(series[5]!.total).toBe(0); // Jun
    expect(series[5]!.counts).toEqual({ invoices: 0, proforma: 0, quotes: 0, creditNotes: 0, contracts: 0, expenses: 0 });
  });
});

describe("buildMonthlyTotals — per-month count + per-currency totals", () => {
  const series = buildMonthlyTotals(
    [
      { date: "2026-01-05", amountMinor: 100000, currency: "EUR" },
      { date: "2026-01-20", amountMinor: 50000, currency: "EUR" },
      { date: "2026-01-25", amountMinor: 3000, currency: "USD" }, // Jan, other currency
      { date: "2026-03-10", amountMinor: 20000, currency: "EUR" },
      { date: null, amountMinor: 999, currency: "EUR" }, // no date → ignored
      { date: "2025-12-31", amountMinor: 777, currency: "EUR" }, // other year → ignored
      { date: "2026-06-01" }, // counts, but no money (e.g. contracts)
    ],
    2026,
  );

  it("returns 12 months with monthNumber 1..12", () => {
    expect(series).toHaveLength(12);
    expect(series.map((p) => p.monthNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
  it("counts docs per month, ignoring null/other-year dates", () => {
    expect(series[0]!.count).toBe(3); // Jan
    expect(series[2]!.count).toBe(1); // Mar
    expect(series[5]!.count).toBe(1); // Jun (no-money row still counts)
    expect(series[1]!.count).toBe(0); // Feb
  });
  it("sums money per currency, never blended", () => {
    expect(series[0]!.totals).toEqual({ EUR: 150000, USD: 3000 }); // Jan
    expect(series[2]!.totals).toEqual({ EUR: 20000 }); // Mar
    expect(series[5]!.totals).toEqual({}); // Jun (count without money)
  });
});

describe("DashboardService.monthlyTotals (integration)", () => {
  it("returns invoices' per-month count + € totals (issued only, year-scoped)", async () => {
    const totals = await seededService().monthlyTotals(adminCtx, "invoices", 2026);
    expect(totals).toHaveLength(12);
    // Jan: paid 100000; Mar: finalized 50000; draft (Feb) + 2025 excluded.
    expect(totals[0]!.count).toBe(1);
    expect(totals[0]!.totals).toEqual({ EUR: 100000 });
    expect(totals[1]!.count).toBe(0); // Feb draft excluded
    expect(totals[2]!.count).toBe(1);
    expect(totals[2]!.totals).toEqual({ EUR: 50000 });
  });

  it("emits counts but EMPTY money totals for a restricted member (SEC5)", async () => {
    const totals = await seededService().monthlyTotals(restrictedMember, "invoices", 2026);
    expect(totals[0]!.count).toBe(1); // count still visible
    expect(totals[0]!.totals).toEqual({}); // money stripped
  });

  it("rejects an unknown kind", async () => {
    await expect(seededService().monthlyTotals(adminCtx, "bogus", 2026)).rejects.toThrow();
  });
});

describe("deriveYearRange — available-year span", () => {
  it("derives min/max from bucket dates and always includes the current year", () => {
    expect(deriveYearRange(["2024-05-01", "2026-02-02", "2025-01-01"], 2026)).toEqual({ minYear: 2024, maxYear: 2026 });
  });
  it("extends the range to include the current year when docs are older", () => {
    expect(deriveYearRange(["2022-01-01", "2023-01-01"], 2026)).toEqual({ minYear: 2022, maxYear: 2026 });
  });
  it("ignores null/blank/invalid entries", () => {
    expect(deriveYearRange([null, undefined, "", "xx", "2025-09-09"], 2026)).toEqual({ minYear: 2025, maxYear: 2026 });
  });
  it("falls back to [currentYear, currentYear] when no usable dates", () => {
    expect(deriveYearRange([null, undefined, ""], 2026)).toEqual({ minYear: 2026, maxYear: 2026 });
  });
});

describe("shapeSummary — SEC5 financial gating (D3)", () => {
  const counts: DashboardCounts = { clients: 3, activeSubscriptions: 2, unbilledTimeEntries: 1, expenses: 4 };
  const recentActivity: DashboardRecentActivity = {
    windowDays: RECENT_ACTIVITY_DAYS,
    clients: 1,
    expenses: 2,
    timeEntries: 0,
    subscriptions: 1,
  };
  const financials: DashboardFinancials = {
    expenseTotal: { EUR: 1000 },
    subscriptionMrr: { EUR: 1200 },
    invoiceQuote: EMPTY_INVOICE_QUOTE,
  };

  it("includes financials when the caller may see them", () => {
    const s = shapeSummary(true, { year: 2026, counts, recentActivity, financials });
    expect(s.year).toBe(2026);
    expect(s.financials).toEqual(financials);
    expect(s.counts).toEqual(counts);
  });

  it("OMITS the financial block entirely when the caller may not (absent, not zeroed)", () => {
    const s = shapeSummary(false, { year: 2026, counts, recentActivity, financials });
    expect(s.financials).toBeUndefined();
    expect("financials" in s).toBe(false);
    // Non-financial counts remain visible; year is always present.
    expect(s.year).toBe(2026);
    expect(s.counts).toEqual(counts);
    expect(s.recentActivity).toEqual(recentActivity);
  });
});

// ── Service against an in-memory fake Db ─────────────────────────────────────

interface Doc {
  [k: string]: unknown;
  deletedAt?: string | null;
  archivedAt?: string | null;
  createdAt?: string;
}

const fakeDb = (seed: Record<string, Doc[]>): Db => {
  const matches = (doc: Doc, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([key, cond]) => {
      const val = doc[key];
      if (cond !== null && typeof cond === "object") {
        const c = cond as Record<string, unknown>;
        let ok = true;
        if ("$gte" in c) ok &&= typeof val === "string" && val >= (c.$gte as string);
        if ("$lt" in c) ok &&= typeof val === "string" && val < (c.$lt as string);
        if ("$ne" in c) ok &&= val !== c.$ne;
        if ("$in" in c) ok &&= (c.$in as unknown[]).includes(val);
        return ok;
      }
      return val === cond;
    });

  const collection = (name: string) => {
    const docs = seed[name] ?? [];
    const project = (rows: Doc[], proj: Record<string, unknown>): Doc[] => {
      // Support 1-projections AND `"$field"` alias-projections (used by
      // monthly-counts to alias each type's bucket date to `date`).
      const entries = Object.entries(proj).filter(([k]) => k !== "_id");
      const inclusive = entries.filter(([, v]) => v === 1);
      const aliases = entries.filter(([, v]) => typeof v === "string" && (v as string).startsWith("$"));
      if (inclusive.length === 0 && aliases.length === 0) return rows.map((r) => ({ ...r }));
      return rows.map((r) => {
        const out: Doc = {};
        for (const [k] of inclusive) out[k] = r[k];
        for (const [k, expr] of aliases) out[k] = r[(expr as string).slice(1)];
        return out;
      });
    };
    return {
      async countDocuments(filter: Record<string, unknown> = {}): Promise<number> {
        return docs.filter((d) => matches(d, filter)).length;
      },
      find(filter: Record<string, unknown> = {}, opts?: { projection?: Record<string, unknown> }) {
        let rows = docs.filter((d) => matches(d, filter));
        const proj = opts?.projection ?? {};
        const cursor = {
          sort(spec: Record<string, 1 | -1>) {
            const [field, dir] = Object.entries(spec)[0] as [string, 1 | -1];
            rows = [...rows].sort((a, b) => {
              const av = String(a[field] ?? "");
              const bv = String(b[field] ?? "");
              return av < bv ? -dir : av > bv ? dir : 0;
            });
            return cursor;
          },
          limit(n: number) {
            rows = rows.slice(0, n);
            return cursor;
          },
          async toArray(): Promise<Doc[]> {
            return project(rows, proj);
          },
        };
        return cursor;
      },
    };
  };
  return { collection } as unknown as Db;
};

const live = (over: Doc): Doc => ({ accountId: "default", deletedAt: null, archivedAt: null, createdAt: "2026-07-15T00:00:00.000Z", ...over });

const seededService = (now: () => Date = () => new Date("2026-07-15T12:00:00.000Z")) => {
  const db = fakeDb({
    clients: [live({}), live({}), live({ deletedAt: "2026-01-01T00:00:00.000Z" })], // 2 live
    expenses: [
      live({ currency: "EUR", amountMinor: 1000, date: "2026-02-10" }),
      live({ currency: "EUR", amountMinor: 500, date: "2026-05-20" }),
      live({ currency: "USD", amountMinor: 250, date: "2026-06-01" }),
      live({ currency: "EUR", amountMinor: 999, date: "2026-03-03", archivedAt: "2026-01-01T00:00:00.000Z" }), // excluded (archived)
      live({ currency: "EUR", amountMinor: 7777, date: "2025-04-04" }), // excluded (prior year)
    ],
    subscriptions: [
      live({ currency: "EUR", amountMinor: 1200, interval: "monthly", status: "active" }),
      live({ currency: "EUR", amountMinor: 1200, interval: "yearly", status: "active" }), // 100/mo
      live({ currency: "USD", amountMinor: 3000, interval: "monthly", status: "active" }),
      live({ currency: "EUR", amountMinor: 9999, interval: "monthly", status: "paused" }), // excluded from MRR + active count
    ],
    timeEntries: [
      live({ billable: true, billed: false }),
      live({ billable: true, billed: false }),
      live({ billable: true, billed: true }), // billed → not unbilled
      live({ billable: false, billed: false }), // non-billable → not unbilled
    ],
    invoices: [
      live({ currency: "EUR", status: "paid", issueDate: "2026-01-10", dueDate: "2026-01-20", grandTotalMinor: 100000, amountPaidMinor: 100000, amountDueMinor: 0 }),
      live({ currency: "EUR", status: "finalized", issueDate: "2026-03-05", dueDate: "2026-04-05", grandTotalMinor: 50000, amountPaidMinor: 0, amountDueMinor: 50000 }),
      live({ currency: "EUR", status: "draft", issueDate: "2026-02-01", dueDate: "2026-03-01", grandTotalMinor: 999, amountPaidMinor: 0, amountDueMinor: 999 }), // draft: financials excluded; monthly-counts still bucket-filtered on issueDate presence (see note)
      live({ currency: "EUR", status: "paid", issueDate: "2025-05-05", dueDate: "2025-05-20", grandTotalMinor: 7000, amountPaidMinor: 7000, amountDueMinor: 0 }), // prior year
    ],
    quotes: [
      live({ issueDate: "2026-01-15" }),
      live({ issueDate: "2026-03-15" }),
    ],
    proformas: [live({ issueDate: "2026-01-20" })],
    creditNotes: [live({ issueDate: "2026-12-31" })],
    contracts: [live({ startDate: "2026-01-01" }), live({ startDate: "2025-06-06" })],
  });
  return new DashboardService({ db, logger, now });
};

describe("DashboardService.summary (D2, integration against fake Db)", () => {
  it("computes counts, recent activity, and per-currency financials for an admin", async () => {
    const s = await seededService().summary(adminCtx);

    expect(s.year).toBe(2026); // defaults to the current (clock) year
    expect(s.counts).toEqual({
      clients: 2, // one soft-deleted excluded
      activeSubscriptions: 3, // paused excluded
      unbilledTimeEntries: 2, // billable & !billed
      expenses: 3, // archived + prior-year excluded → 3 in 2026
    });

    expect(s.recentActivity.windowDays).toBe(RECENT_ACTIVITY_DAYS);
    expect(s.recentActivity.clients).toBe(2); // both live clients created within 30d of 2026-07-15

    expect(s.financials).toBeDefined();
    expect(s.financials?.expenseTotal).toEqual({ EUR: 1500, USD: 250 }); // year-scoped to 2026
    expect(s.financials?.subscriptionMrr).toEqual({ EUR: 1200 + 100, USD: 3000 });
    // Year-scoped (2026): invoiced = paid 100000 + finalized 50000 (draft + 2025 excluded).
    expect(s.financials?.invoiceQuote.invoicedThisMonth).toEqual({ EUR: 150000 });
    expect(s.financials?.invoiceQuote.collectedThisMonth).toEqual({ EUR: 100000 });
    // The finalized invoice (due 2026-04-05) is past today (2026-07-15) → outstanding + overdue.
    expect(s.financials?.invoiceQuote.outstanding).toEqual({ EUR: 50000 });
    expect(s.financials?.invoiceQuote.overdue).toEqual({ EUR: 50000 });
  });

  it("omits the financial block for a restricted member (SEC5) but keeps counts", async () => {
    const s = await seededService().summary(restrictedMember);
    expect(s.financials).toBeUndefined();
    expect(s.counts.clients).toBe(2);
    expect(s.counts.activeSubscriptions).toBe(3);
  });

  it("excludes activity older than the window from recent-activity counts", async () => {
    // Clock far in the future → nothing is within the 30-day window.
    const s = await seededService(() => new Date("2027-01-01T00:00:00.000Z")).summary(adminCtx);
    expect(s.recentActivity.clients).toBe(0);
    expect(s.recentActivity.expenses).toBe(0);
    // Totals (non-windowed) are unaffected.
    expect(s.counts.clients).toBe(2);
  });

  it("scopes to a month subset: only that month's invoices + expenses contribute", async () => {
    // 2026 seed invoices: Jan paid 100000, Mar finalized 50000 (due 04-05 → overdue).
    // Selecting only March → invoiced 50000, collected 0, outstanding+overdue 50000.
    const s = await seededService().summary(adminCtx, 2026, [3]);
    expect(s.year).toBe(2026);
    expect(s.financials?.invoiceQuote.invoicedThisMonth).toEqual({ EUR: 50000 });
    expect(s.financials?.invoiceQuote.collectedThisMonth).toEqual({ EUR: 0 });
    expect(s.financials?.invoiceQuote.outstanding).toEqual({ EUR: 50000 });
    expect(s.financials?.invoiceQuote.overdue).toEqual({ EUR: 50000 });
    // Expenses: only the Feb/May/Jun expenses exist in 2026; March has none.
    expect(s.counts.expenses).toBe(0);
    expect(s.financials?.expenseTotal).toEqual({});
  });

  it("month subset {1} (January) picks up the Jan paid invoice only", async () => {
    const s = await seededService().summary(adminCtx, 2026, [1]);
    expect(s.financials?.invoiceQuote.invoicedThisMonth).toEqual({ EUR: 100000 });
    expect(s.financials?.invoiceQuote.collectedThisMonth).toEqual({ EUR: 100000 });
    // Jan invoice is fully paid (amountDue 0) → no outstanding/overdue.
    expect(s.financials?.invoiceQuote.outstanding).toEqual({});
    expect(s.financials?.invoiceQuote.overdue).toEqual({});
  });

  it("scopes to a caller-supplied prior year (financials + expense count follow)", async () => {
    const s = await seededService().summary(adminCtx, 2025);
    expect(s.year).toBe(2025);
    // Only the 2025 expense (7777, archived-excluded one aside) is in range.
    expect(s.counts.expenses).toBe(1);
    expect(s.financials?.expenseTotal).toEqual({ EUR: 7777 });
    // 2025 invoiced: the single paid 2025 invoice (7000); the 2026 ones drop out.
    expect(s.financials?.invoiceQuote.invoicedThisMonth).toEqual({ EUR: 7000 });
  });
});

describe("DashboardService.revenueSeries — per-year, incl. expenses (integration)", () => {
  it("returns 12 months of the year with invoiced/collected + expenses per currency", async () => {
    const series = await seededService().revenueSeries(adminCtx); // defaults to 2026
    expect(series).toHaveLength(12);
    expect(series.map((p) => p.month)[0]).toBe("2026-01");
    // Jan: paid invoice 100000; Feb: draft excluded; Mar: finalized 50000.
    expect(series[0]!.invoiced).toEqual({ EUR: 100000 });
    expect(series[0]!.collected).toEqual({ EUR: 100000 });
    expect(series[1]!.invoiced).toEqual({}); // Feb (only a draft)
    expect(series[2]!.invoiced).toEqual({ EUR: 50000 }); // Mar
    // Expenses bucket by date: Feb 1000, May 500, Jun 250(USD). Archived + 2025 excluded.
    expect(series[1]!.expenses).toEqual({ EUR: 1000 }); // Feb
    expect(series[4]!.expenses).toEqual({ EUR: 500 }); // May
    expect(series[5]!.expenses).toEqual({ USD: 250 }); // Jun
  });

  it("returns an empty series for a caller without canViewFinancialTotals (SEC5)", async () => {
    const series = await seededService().revenueSeries(restrictedMember);
    expect(series).toEqual([]);
  });
});

describe("DashboardService.monthlyCounts — per-month doc counts (integration)", () => {
  it("counts issued docs by bucket date, EXCLUDING drafts, per month", async () => {
    const counts = await seededService().monthlyCounts(adminCtx); // 2026
    expect(counts).toHaveLength(12);
    const jan = counts[0]!;
    // Jan 2026: 1 paid invoice, 1 quote, 1 proforma, 0 credit-notes, 1 contract, 0 expenses (Feb/May/Jun).
    expect(jan.counts).toEqual({ invoices: 1, proforma: 1, quotes: 1, creditNotes: 0, contracts: 1, expenses: 0 });
    expect(jan.total).toBe(4);
    // Feb: the ONLY invoice is a draft → excluded → 0 (proves the status filter).
    expect(counts[1]!.counts.invoices).toBe(0);
    expect(counts[1]!.counts.expenses).toBe(1); // Feb expense
    // Mar: finalized invoice + a quote.
    expect(counts[2]!.counts.invoices).toBe(1);
    expect(counts[2]!.counts.quotes).toBe(1);
    // Dec: the credit note.
    expect(counts[11]!.counts.creditNotes).toBe(1);
    // The 2025 contract does NOT appear in the 2026 series.
    const total2026Contracts = counts.reduce((a, c) => a + c.counts.contracts, 0);
    expect(total2026Contracts).toBe(1);
  });

  it("is NOT SEC5-gated (a restricted member still sees counts)", async () => {
    const counts = await seededService().monthlyCounts(restrictedMember);
    expect(counts).toHaveLength(12);
    expect(counts[0]!.counts.invoices).toBe(1);
  });
});

describe("DashboardService.years — available-year range (integration)", () => {
  it("spans the min/max bucket date across docs, incl. the current year", async () => {
    // Docs span 2025 (invoice/contract) .. 2026; clock year 2026.
    const y = await seededService().years(adminCtx);
    expect(y).toEqual({ minYear: 2025, maxYear: 2026 });
  });
});
