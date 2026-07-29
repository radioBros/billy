import type { Db, Filter, Document } from "mongodb";
import type { AuthContext } from "@billy/types";
import { errors, type Logger } from "@billy/shared";
import { assertAuthContext } from "@/platform/repository.js";
import { canSeeFinancials } from "@/platform/serializer.js";
import type {
  CurrencyTotals,
  DashboardCounts,
  DashboardFinancials,
  DashboardInvoiceQuoteTotals,
  DashboardRecentActivity,
  DashboardSummary,
  DashboardYears,
  DatedMoneyRow,
  DatedRow,
  ExpenseMoneyRow,
  MonthlyCountsPoint,
  MonthlyTotalsPoint,
  MonthlyDocCounts,
  SubscriptionIntervalName,
  SubscriptionMoneyRow,
} from "@/modules/dashboard/types.js";

/**
 * Dashboard aggregation service. READ-ONLY: it reads
 * across sibling collections (populated by other modules) via the injected `db`
 * and never writes or emits. It owns no collection and defines no domain data.
 *
 * All money aggregation is PER CURRENCY (`{ currency: minorUnits }` maps, never
 * a blended sum), and the whole financial
 * block is omitted for callers without `canViewFinancialTotals`.
 *
 * The numeric/normalization math is kept in exported PURE helpers so it is unit-
 * testable without Mongo. The service only does the reads and the assembly.
 */

/** Rolling window (days) for "recent activity" counts. UTC cutoff — business-tz
 *  windows are out of scope; a UTC cutoff is acceptable here. */
export const RECENT_ACTIVITY_DAYS = 30;

export const roundHalfAwayFromZero = (value: number): number => {
  return Math.sign(value) * Math.round(Math.abs(value));
};

export const monthlyFactor = (interval: SubscriptionIntervalName): number => {
  switch (interval) {
    case "weekly":
      return 52 / 12;
    case "monthly":
      return 1;
    case "quarterly":
      return 1 / 3;
    case "yearly":
      return 1 / 12;
  }
};

export const sumByCurrency = (rows: readonly { currency: string; amountMinor: number }[]): CurrencyTotals => {
  const totals: CurrencyTotals = {};
  for (const row of rows) {
    const minor = roundHalfAwayFromZero(row.amountMinor);
    totals[row.currency] = (totals[row.currency] ?? 0) + minor;
  }
  return totals;
};

export const normalizeMrrByCurrency = (rows: readonly SubscriptionMoneyRow[]): CurrencyTotals => {
  const totals: CurrencyTotals = {};
  for (const row of rows) {
    if (row.status !== "active") continue;
    const perMonth = roundHalfAwayFromZero(row.amountMinor * monthlyFactor(row.interval));
    totals[row.currency] = (totals[row.currency] ?? 0) + perMonth;
  }
  return totals;
};

/** A bare invoice money row read for dashboard aggregation. */
export interface InvoiceMoneyRow {
  currency: string;
  status: string;
  issueDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  grandTotalMinor: number;
  amountPaidMinor: number;
  amountDueMinor: number;
}

/** Statuses that represent a REAL (issued) invoice — draft + void are excluded
 *  from every financial roll-up. */
const ISSUED_STATUSES = new Set(["finalized", "partially_paid", "paid", "overdue"]);
/** Statuses still owing money (contribute to outstanding/overdue). */
const OPEN_STATUSES = new Set(["finalized", "partially_paid", "overdue"]);

export const monthKey = (date: string): string => {
  return date.slice(0, 7);
};

export const aggregateInvoiceTotals = (rows: readonly InvoiceMoneyRow[], ym: string, todayIso: string): DashboardInvoiceQuoteTotals => {
  const invoicedThisMonth: CurrencyTotals = {};
  const collectedThisMonth: CurrencyTotals = {};
  const outstanding: CurrencyTotals = {};
  const overdue: CurrencyTotals = {};
  const add = (m: CurrencyTotals, cur: string, v: number): void => {
    m[cur] = (m[cur] ?? 0) + roundHalfAwayFromZero(v);
  };
  for (const r of rows) {
    if (!ISSUED_STATUSES.has(r.status)) continue;
    if (monthKey(r.issueDate) === ym) {
      add(invoicedThisMonth, r.currency, r.grandTotalMinor);
      add(collectedThisMonth, r.currency, r.amountPaidMinor);
    }
    if (OPEN_STATUSES.has(r.status) && r.amountDueMinor > 0) {
      add(outstanding, r.currency, r.amountDueMinor);
      if (r.dueDate < todayIso.slice(0, 10)) add(overdue, r.currency, r.amountDueMinor);
    }
  }
  return { invoicedThisMonth, collectedThisMonth, outstanding, overdue };
};

/** One month bucket of the revenue time-series (per currency). */
export interface RevenueMonthPoint {
  month: string; // YYYY-MM
  invoiced: CurrencyTotals;
  collected: CurrencyTotals;
}

export const buildRevenueSeries = (rows: readonly InvoiceMoneyRow[], endYm: string, months: number): RevenueMonthPoint[] => {
  // Enumerate the last `months` YYYY-MM keys ending at endYm.
  const [ey, em] = endYm.split("-").map(Number) as [number, number];
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const total = ey * 12 + (em - 1) - i;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    keys.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  const byMonth = new Map<string, RevenueMonthPoint>(
    keys.map((k) => [k, { month: k, invoiced: {}, collected: {} }]),
  );
  for (const r of rows) {
    if (!ISSUED_STATUSES.has(r.status)) continue;
    const pt = byMonth.get(monthKey(r.issueDate));
    if (!pt) continue;
    pt.invoiced[r.currency] = (pt.invoiced[r.currency] ?? 0) + roundHalfAwayFromZero(r.grandTotalMinor);
    pt.collected[r.currency] = (pt.collected[r.currency] ?? 0) + roundHalfAwayFromZero(r.amountPaidMinor);
  }
  return keys.map((k) => byMonth.get(k)!);
};

export const yearMonthKeys = (year: number): string[] => {
  const keys: string[] = [];
  for (let m = 1; m <= 12; m++) keys.push(`${year}-${String(m).padStart(2, "0")}`);
  return keys;
};

/** One month bucket of the per-YEAR revenue/expense series (per currency). */
export interface YearMonthPoint {
  month: string; // YYYY-MM
  invoiced: CurrencyTotals;
  collected: CurrencyTotals;
  /** Σ expense amountMinor with `date` in this month, per currency. */
  expenses: CurrencyTotals;
}

export const buildYearSeries = (invoiceRows: readonly InvoiceMoneyRow[], expenseRows: readonly ExpenseMoneyRow[], year: number): YearMonthPoint[] => {
  const keys = yearMonthKeys(year);
  const byMonth = new Map<string, YearMonthPoint>(
    keys.map((k) => [k, { month: k, invoiced: {}, collected: {}, expenses: {} }]),
  );
  for (const r of invoiceRows) {
    if (!ISSUED_STATUSES.has(r.status)) continue;
    const pt = byMonth.get(monthKey(r.issueDate));
    if (!pt) continue;
    pt.invoiced[r.currency] = (pt.invoiced[r.currency] ?? 0) + roundHalfAwayFromZero(r.grandTotalMinor);
    pt.collected[r.currency] = (pt.collected[r.currency] ?? 0) + roundHalfAwayFromZero(r.amountPaidMinor);
  }
  for (const e of expenseRows) {
    if (!e.date) continue;
    const pt = byMonth.get(monthKey(e.date));
    if (!pt) continue;
    pt.expenses[e.currency] = (pt.expenses[e.currency] ?? 0) + roundHalfAwayFromZero(e.amountMinor);
  }
  return keys.map((k) => byMonth.get(k)!);
};

/**
 * A recurrence-free PERIOD: a year plus an optional set of 1-based month numbers.
 * An empty/absent `months` set means "the whole year" (all 12 months). Any month
 * outside 1..12 is ignored.
 */
export interface DashboardPeriod {
  year: number;
  months?: readonly number[];
}

/** Normalize a period's months into a Set (empty Set ⇒ caller treats as "all"). */
const monthSetOf = (months?: readonly number[]): Set<number> => {
  const s = new Set<number>();
  for (const m of months ?? []) {
    if (Number.isInteger(m) && m >= 1 && m <= 12) s.add(m);
  }
  return s;
};

/** True iff `dateOnly` (YYYY-MM-DD) falls inside the period (year + month subset). */
const inPeriod = (dateOnly: string, yearPrefix: string, monthSet: Set<number>): boolean => {
  if (dateOnly.slice(0, 4) !== yearPrefix) return false;
  if (monthSet.size === 0) return true; // whole year
  const month = Number(dateOnly.slice(5, 7));
  return monthSet.has(month);
};

/**
 * Per-currency invoice roll-ups for a PERIOD (year + optional month subset). ALL
 * FOUR metrics are period-scoped:
 *   - invoiced/collected: issued invoices whose ISSUE date is in the period.
 *   - outstanding/overdue: open invoices whose ISSUE date is in the period (this
 *     is the "balance on invoices issued in the selected period" — it MOVES with
 *     the period, unlike the previous as-of-now-all-time behaviour). Overdue is
 *     the outstanding slice whose due date is before today.
 */
export const aggregateInvoiceTotalsForPeriod = (
  rows: readonly InvoiceMoneyRow[],
  period: DashboardPeriod,
  todayIso: string,
): DashboardInvoiceQuoteTotals => {
  const yearPrefix = String(period.year);
  const monthSet = monthSetOf(period.months);
  const today = todayIso.slice(0, 10);
  const invoicedThisMonth: CurrencyTotals = {};
  const collectedThisMonth: CurrencyTotals = {};
  const outstanding: CurrencyTotals = {};
  const overdue: CurrencyTotals = {};
  const add = (m: CurrencyTotals, cur: string, v: number): void => {
    m[cur] = (m[cur] ?? 0) + roundHalfAwayFromZero(v);
  };
  for (const r of rows) {
    if (!ISSUED_STATUSES.has(r.status)) continue;
    if (!inPeriod(r.issueDate, yearPrefix, monthSet)) continue;
    add(invoicedThisMonth, r.currency, r.grandTotalMinor);
    add(collectedThisMonth, r.currency, r.amountPaidMinor);
    if (OPEN_STATUSES.has(r.status) && r.amountDueMinor > 0) {
      add(outstanding, r.currency, r.amountDueMinor);
      if (r.dueDate < today) add(overdue, r.currency, r.amountDueMinor);
    }
  }
  return { invoicedThisMonth, collectedThisMonth, outstanding, overdue };
};

/** The doc-type keys of the monthly-counts breakdown. */
const MONTHLY_COUNT_TYPES = [
  "invoices",
  "proforma",
  "quotes",
  "creditNotes",
  "contracts",
  "expenses",
] as const;

/** Per-type dated rows for the monthly-counts aggregation. A row counts toward a
 *  month iff its `date` (already the type's bucket field) is a non-empty string
 *  falling within that month of the year. Drafts/non-issued rows carry no bucket
 *  date and are excluded by the caller's projection filter (issueDate present). */
export interface MonthlyCountsInput {
  invoices: readonly DatedRow[];
  proforma: readonly DatedRow[];
  quotes: readonly DatedRow[];
  creditNotes: readonly DatedRow[];
  contracts: readonly DatedRow[];
  expenses: readonly DatedRow[];
}

export const buildMonthlyCounts = (input: MonthlyCountsInput, year: number): MonthlyCountsPoint[] => {
  const keys = yearMonthKeys(year);
  const zero = (): MonthlyDocCounts => ({
    invoices: 0,
    proforma: 0,
    quotes: 0,
    creditNotes: 0,
    contracts: 0,
    expenses: 0,
  });
  const byMonth = new Map<string, MonthlyCountsPoint>(
    keys.map((k, i) => [k, { month: k, monthNumber: i + 1, counts: zero(), total: 0 }]),
  );
  for (const type of MONTHLY_COUNT_TYPES) {
    for (const row of input[type]) {
      if (typeof row.date !== "string" || row.date.length < 7) continue;
      const pt = byMonth.get(monthKey(row.date));
      if (!pt) continue;
      pt.counts[type] += 1;
      pt.total += 1;
    }
  }
  return keys.map((k) => byMonth.get(k)!);
};

/**
 * Build the per-month MONTH-BAR series for a single collection: 12 zero-filled
 * months, each with a doc count and a per-currency money total. A row counts
 * toward a month iff its bucket `date` falls in that month of `year`. Money is
 * summed per currency (never blended); rows with no/zero money still count.
 */
export const buildMonthlyTotals = (rows: readonly DatedMoneyRow[], year: number): MonthlyTotalsPoint[] => {
  const keys = yearMonthKeys(year);
  const byMonth = new Map<string, MonthlyTotalsPoint>(
    keys.map((k, i) => [k, { month: k, monthNumber: i + 1, count: 0, totals: {} }]),
  );
  for (const r of rows) {
    if (typeof r.date !== "string" || r.date.length < 7) continue;
    const pt = byMonth.get(monthKey(r.date));
    if (!pt) continue;
    pt.count += 1;
    const cur = r.currency;
    const minor = r.amountMinor;
    if (cur && typeof minor === "number") {
      pt.totals[cur] = (pt.totals[cur] ?? 0) + roundHalfAwayFromZero(minor);
    }
  }
  return keys.map((k) => byMonth.get(k)!);
};

export const deriveYearRange = (dates: readonly (string | null | undefined)[], currentYear: number): DashboardYears => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const d of dates) {
    if (typeof d !== "string" || d.length < 4) continue;
    const y = Number(d.slice(0, 4));
    if (!Number.isFinite(y)) continue;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { minYear: currentYear, maxYear: currentYear };
  }
  // Always include the current year in the selectable range so "this year" is
  // never missing from the dropdown even before any docs land in it.
  return { minYear: Math.min(min, currentYear), maxYear: Math.max(max, currentYear) };
};

export const shapeSummary = (canSee: boolean, parts: {
    year: number;
    counts: DashboardCounts;
    recentActivity: DashboardRecentActivity;
    financials: DashboardFinancials;
  }): DashboardSummary => {
  const base: DashboardSummary = {
    year: parts.year,
    counts: parts.counts,
    recentActivity: parts.recentActivity,
  };
  if (canSee) base.financials = parts.financials;
  return base;
};

/**
 * MONTH-BAR sources: the list types that expose a per-month `{count, totals}`
 * bar. Each maps a public `kind` → its collection, bucket-date field, optional
 * money field, and an optional status filter that mirrors the collection's
 * "real document" definition (draft/void excluded like everywhere else).
 */
export interface MonthBarSource {
  collection: string;
  dateField: string;
  /** Money field summed per currency; absent ⇒ count-only (e.g. contracts). */
  moneyField?: string;
  /** Extra filter narrowing to issued/non-draft docs (kind-specific). */
  statusFilter?: Filter<Document>;
}

export const MONTH_BAR_SOURCES: Record<string, MonthBarSource> = {
  invoices: {
    collection: "invoices",
    dateField: "issueDate",
    moneyField: "grandTotalMinor",
    statusFilter: { status: { $in: ["finalized", "partially_paid", "paid", "overdue"] } },
  },
  quotes: {
    collection: "quotes",
    dateField: "issueDate",
    moneyField: "grandTotalMinor",
    statusFilter: { status: { $ne: "draft" } },
  },
  proformas: {
    collection: "proformas",
    dateField: "issueDate",
    moneyField: "grandTotalMinor",
    statusFilter: { status: { $ne: "draft" } },
  },
  creditNotes: {
    collection: "creditNotes",
    dateField: "issueDate",
    moneyField: "grandTotalMinor",
    statusFilter: { status: { $ne: "draft" } },
  },
  expenses: {
    collection: "expenses",
    dateField: "date",
    moneyField: "amountMinor",
  },
  contracts: {
    collection: "contracts",
    dateField: "startDate",
  },
};

/** Collections read by the dashboard (all populated by other modules). */
const COLLECTIONS = {
  clients: "clients",
  expenses: "expenses",
  subscriptions: "subscriptions",
  timeEntries: "timeEntries",
  invoices: "invoices",
  quotes: "quotes",
  proformas: "proformas",
  creditNotes: "creditNotes",
  contracts: "contracts",
} as const;

/** Projection for invoice money rows used by the financial roll-ups. */
const INVOICE_MONEY_PROJECTION = {
  _id: 0,
  currency: 1,
  status: 1,
  issueDate: 1,
  dueDate: 1,
  grandTotalMinor: 1,
  amountPaidMinor: 1,
  amountDueMinor: 1,
} as const;

/**
 * Base non-deleted, non-archived, ACCOUNT-SCOPED filter (matches the platform
 * default list semantics). The dashboard reads collections directly (bypassing
 * BaseRepository), so it MUST inject `accountId` itself — otherwise it would
 * aggregate every account's financial totals together. Fail-closed: built from
 * `ctx.accountId` per request.
 */
const liveFilterFor = (ctx: AuthContext): Filter<Document> => ({
  deletedAt: null,
  archivedAt: null,
  accountId: ctx.accountId,
});

export interface DashboardServiceDeps {
  db: Db;
  logger: Logger;
  /** Clock injection for deterministic recent-activity windows in tests. */
  now?: () => Date;
}

export class DashboardService {
  private readonly db: Db;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(deps: DashboardServiceDeps) {
    this.db = deps.db;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => new Date());
  }

  /** Resolve the effective year: the caller-supplied one, else the current year. */
  private resolveYear(year?: number): number {
    if (year != null && Number.isFinite(year)) return Math.trunc(year);
    return this.now().getUTCFullYear();
  }

  /** Sanitize a month subset (1..12); empty ⇒ whole year. */
  private resolveMonths(months?: readonly number[]): number[] {
    return [...monthSetOf(months)].sort((a, b) => a - b);
  }

  /**
   * Compute the full dashboard summary for the caller (read-only), scoped to
   * `year` (default: current year). Counts of docs whose bucket date honors the
   * year (invoices/quotes/proforma/credit-notes/contracts/expenses) and the
   * financial roll-ups are year-scoped; "as-of-now" resource counts (live
   * clients, active subscriptions, unbilled time) and `recentActivity` (rolling
   * 30d) are NOT year-scoped.
   */
  async summary(ctx: AuthContext, year?: number, months?: readonly number[]): Promise<DashboardSummary> {
    assertAuthContext(ctx);
    const liveFilter = liveFilterFor(ctx);
    const targetYear = this.resolveYear(year);
    const targetMonths = this.resolveMonths(months);
    const monthSet = new Set(targetMonths);
    const yearStart = `${targetYear}-01-01`;
    const yearEndExclusive = `${targetYear + 1}-01-01`;
    const inYear = (field: string): Filter<Document> => ({
      ...liveFilter,
      [field]: { $gte: yearStart, $lt: yearEndExclusive },
    });
    // In-period (year + optional month subset) predicate for post-query filtering
    // of date-bucketed rows. Empty monthSet ⇒ whole year (matches inYear).
    const rowInPeriod = (dateOnly: string | undefined | null): boolean => {
      if (typeof dateOnly !== "string" || dateOnly.length < 7) return false;
      if (dateOnly.slice(0, 4) !== String(targetYear)) return false;
      if (monthSet.size === 0) return true;
      return monthSet.has(Number(dateOnly.slice(5, 7)));
    };

    const clients = this.db.collection(COLLECTIONS.clients);
    const expenses = this.db.collection(COLLECTIONS.expenses);
    const subscriptions = this.db.collection(COLLECTIONS.subscriptions);
    const timeEntries = this.db.collection(COLLECTIONS.timeEntries);
    const invoices = this.db.collection(COLLECTIONS.invoices);

    const cutoffIso = new Date(this.now().getTime() - RECENT_ACTIVITY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const recentFilter: Filter<Document> = { ...liveFilter, createdAt: { $gte: cutoffIso } };
    // "unbilled" = billable time that has not yet been billed (billed=false).
    const unbilledFilter: Filter<Document> = { ...liveFilter, billable: true, billed: false };
    const activeSubFilter: Filter<Document> = { ...liveFilter, status: "active" };
    // Year-scoped expense count buckets by expense `date` within the year.
    const expensesInYear = inYear("date");

    const [
      clientCount,
      activeSubCount,
      unbilledTimeCount,
      expenseCount,
      recentClients,
      recentExpenses,
      recentTimeEntries,
      recentSubscriptions,
      expenseRows,
      subscriptionRows,
      invoiceRows,
    ] = await Promise.all([
      clients.countDocuments(liveFilter),
      subscriptions.countDocuments(activeSubFilter),
      timeEntries.countDocuments(unbilledFilter),
      expenses.countDocuments(expensesInYear),
      clients.countDocuments(recentFilter),
      expenses.countDocuments(recentFilter),
      timeEntries.countDocuments(recentFilter),
      subscriptions.countDocuments(recentFilter),
      expenses
        .find(expensesInYear, { projection: { _id: 0, currency: 1, amountMinor: 1, date: 1 } })
        .toArray() as unknown as Promise<ExpenseMoneyRow[]>,
      subscriptions
        .find(activeSubFilter, { projection: { _id: 0, currency: 1, amountMinor: 1, interval: 1, status: 1 } })
        .toArray() as unknown as Promise<SubscriptionMoneyRow[]>,
      invoices
        .find(liveFilter, { projection: INVOICE_MONEY_PROJECTION })
        .toArray() as unknown as Promise<InvoiceMoneyRow[]>,
    ]);

    const counts: DashboardCounts = {
      clients: clientCount,
      activeSubscriptions: activeSubCount,
      unbilledTimeEntries: unbilledTimeCount,
      expenses: expenseCount,
    };

    const recentActivity: DashboardRecentActivity = {
      windowDays: RECENT_ACTIVITY_DAYS,
      clients: recentClients,
      expenses: recentExpenses,
      timeEntries: recentTimeEntries,
      subscriptions: recentSubscriptions,
    };

    const todayIso = this.now().toISOString();
    // Narrow the year-scoped rows to the selected month subset (empty ⇒ whole year).
    const periodExpenseRows = expenseRows.filter((e) => rowInPeriod(e.date));
    const periodExpenseCount = monthSet.size === 0 ? expenseCount : periodExpenseRows.length;
    const financials: DashboardFinancials = {
      // expenseTotal is period-scoped (year + optional month subset).
      expenseTotal: sumByCurrency(periodExpenseRows),
      subscriptionMrr: normalizeMrrByCurrency(subscriptionRows),
      invoiceQuote: aggregateInvoiceTotalsForPeriod(invoiceRows, { year: targetYear, months: targetMonths }, todayIso),
    };

    const periodCounts: DashboardCounts = { ...counts, expenses: periodExpenseCount };
    return shapeSummary(canSeeFinancials(ctx), { year: targetYear, counts: periodCounts, recentActivity, financials });
  }

  /**
   * Per-YEAR monthly revenue/expense time-series: all 12 months of `year`
   * (default: current year), each with invoiced + collected + expense totals per
   * currency. Financial data → requires `canViewFinancialTotals`; returns
   * an empty series otherwise.
   */
  async revenueSeries(ctx: AuthContext, year?: number): Promise<YearMonthPoint[]> {
    assertAuthContext(ctx);
    const liveFilter = liveFilterFor(ctx);
    if (!canSeeFinancials(ctx)) return [];
    const targetYear = this.resolveYear(year);
    const yearStart = `${targetYear}-01-01`;
    const yearEndExclusive = `${targetYear + 1}-01-01`;
    const invoices = this.db.collection(COLLECTIONS.invoices);
    const expenses = this.db.collection(COLLECTIONS.expenses);
    const [invoiceRows, expenseRows] = await Promise.all([
      invoices.find(liveFilter, { projection: INVOICE_MONEY_PROJECTION }).toArray() as unknown as Promise<
        InvoiceMoneyRow[]
      >,
      expenses
        .find(
          { ...liveFilter, date: { $gte: yearStart, $lt: yearEndExclusive } },
          { projection: { _id: 0, currency: 1, amountMinor: 1, date: 1 } },
        )
        .toArray() as unknown as Promise<ExpenseMoneyRow[]>,
    ]);
    return buildYearSeries(invoiceRows, expenseRows, targetYear);
  }

  /**
   * Per-month (01..12) document counts for `year`, broken down by doc type
   * (invoices, proforma, quotes, creditNotes, contracts, expenses) with a
   * per-month total. Buckets by each type's bucket date; drafts/non-issued docs
   * (no issueDate) are excluded via the query. Non-financial (pure counts) — NOT
   * financial-gated.
   */
  async monthlyCounts(ctx: AuthContext, year?: number): Promise<MonthlyCountsPoint[]> {
    assertAuthContext(ctx);
    const liveFilter = liveFilterFor(ctx);
    const targetYear = this.resolveYear(year);
    const yearStart = `${targetYear}-01-01`;
    const yearEndExclusive = `${targetYear + 1}-01-01`;
    const inYear = (field: string): Filter<Document> => ({
      ...liveFilter,
      [field]: { $gte: yearStart, $lt: yearEndExclusive },
    });
    // Project each type's bucket date AS `date` so the pure helper is uniform.
    // `extra` carries a per-type status filter that EXCLUDES drafts/non-issued
    // (consistent with ISSUED_STATUSES) — drafts carry an issueDate in this
    // system, so date-presence alone would wrongly count them.
    const datedFind = (coll: string, field: string, extra: Filter<Document> = {}): Promise<DatedRow[]> =>
      this.db
        .collection(coll)
        .find({ ...inYear(field), ...extra }, { projection: { _id: 0, date: `$${field}` } })
        .toArray() as unknown as Promise<DatedRow[]>;

    const issuedInvoice: Filter<Document> = { status: { $in: [...ISSUED_STATUSES] } };
    const notDraft: Filter<Document> = { status: { $ne: "draft" } };

    const [invoices, proforma, quotes, creditNotes, contracts, expenses] = await Promise.all([
      datedFind(COLLECTIONS.invoices, "issueDate", issuedInvoice),
      datedFind(COLLECTIONS.proformas, "issueDate", notDraft),
      datedFind(COLLECTIONS.quotes, "issueDate", notDraft),
      datedFind(COLLECTIONS.creditNotes, "issueDate", notDraft),
      // Contracts: all non-deleted (any status).
      datedFind(COLLECTIONS.contracts, "startDate"),
      // Expenses: no draft concept.
      datedFind(COLLECTIONS.expenses, "date"),
    ]);
    return buildMonthlyCounts({ invoices, proforma, quotes, creditNotes, contracts, expenses }, targetYear);
  }

  /**
   * Per-month `{count, totals}` MONTH-BAR series for ONE list `kind` (invoices,
   * quotes, proformas, creditNotes, expenses, contracts), scoped to `year`.
   * Money totals are per currency (contracts are count-only). Buckets by the
   * kind's date field; draft/void excluded per the kind's status filter. This is
   * what the list-page month bar reads to show "N doc / € total" per month.
   *
   * Financial gating: money totals require `canViewFinancialTotals`. Without it
   * the counts are still returned but `totals` is emptied (counts are never
   * gated, consistent with monthlyCounts).
   */
  async monthlyTotals(ctx: AuthContext, kind: string, year?: number): Promise<MonthlyTotalsPoint[]> {
    assertAuthContext(ctx);
    const source = MONTH_BAR_SOURCES[kind];
    if (!source) throw errors.validation(`Unknown month-bar kind: ${kind}`);
    const liveFilter = liveFilterFor(ctx);
    const targetYear = this.resolveYear(year);
    const yearStart = `${targetYear}-01-01`;
    const yearEndExclusive = `${targetYear + 1}-01-01`;
    const canSeeMoney = canSeeFinancials(ctx);

    const filter: Filter<Document> = {
      ...liveFilter,
      [source.dateField]: { $gte: yearStart, $lt: yearEndExclusive },
      ...(source.statusFilter ?? {}),
    };
    // Project the bucket date AS `date`; money/currency only when the caller may
    // see it and the kind carries money (contracts have none).
    const projection: Document = { _id: 0, date: `$${source.dateField}` };
    if (source.moneyField && canSeeMoney) {
      projection.amountMinor = `$${source.moneyField}`;
      projection.currency = 1;
    }
    const rows = (await this.db
      .collection(source.collection)
      .find(filter, { projection })
      .toArray()) as unknown as DatedMoneyRow[];
    return buildMonthlyTotals(rows, targetYear);
  }

  /**
   * Available-year range across all bucketed documents (for the year dropdown).
   * Reads the min/max bucket date per collection and folds them together; always
   * includes the current year. Non-financial — NOT financial-gated.
   */
  async years(ctx: AuthContext): Promise<DashboardYears> {
    assertAuthContext(ctx);
    const liveFilter = liveFilterFor(ctx);
    // For each collection, fetch just the min and max of its bucket date via
    // sorted single-doc reads (cheap; avoids scanning every doc into memory).
    const edge = async (coll: string, field: string): Promise<(string | null)[]> => {
      const c = this.db.collection(coll);
      const present: Filter<Document> = { ...liveFilter, [field]: { $ne: null } };
      const [lo, hi] = await Promise.all([
        c.find(present, { projection: { _id: 0, [field]: 1 } }).sort({ [field]: 1 }).limit(1).toArray(),
        c.find(present, { projection: { _id: 0, [field]: 1 } }).sort({ [field]: -1 }).limit(1).toArray(),
      ]);
      return [
        (lo[0]?.[field] as string | undefined) ?? null,
        (hi[0]?.[field] as string | undefined) ?? null,
      ];
    };
    const pairs = await Promise.all([
      edge(COLLECTIONS.invoices, "issueDate"),
      edge(COLLECTIONS.proformas, "issueDate"),
      edge(COLLECTIONS.quotes, "issueDate"),
      edge(COLLECTIONS.creditNotes, "issueDate"),
      edge(COLLECTIONS.contracts, "startDate"),
      edge(COLLECTIONS.expenses, "date"),
    ]);
    const dates = pairs.flat();
    return deriveYearRange(dates, this.now().getUTCFullYear());
  }
}
