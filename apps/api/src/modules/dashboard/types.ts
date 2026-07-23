/**
 * Dashboard DTOs.
 *
 * The dashboard is a READ/AGGREGATION layer: it defines no domain data and owns
 * no collection. The interfaces below are:
 *   - the summary DTO returned by `GET /dashboard/summary`, and
 *   - minimal local projections of the source documents this module reads
 *     (declared here, NOT imported from sibling modules, so the dashboard stays
 *     self-contained and defines none of its own data.
 *
 * Money rule: every monetary aggregate is an integer
 * minor-units total grouped BY currency — a `{ [currency]: minorUnits }` map,
 * never a single blended cross-currency sum.
 */

/** Per-currency money map: ISO-4217 code → integer minor units. Never blended. */
export type CurrencyTotals = Record<string, number>;

/** Non-financial counts — always visible regardless of `canViewFinancialTotals`. */
export interface DashboardCounts {
  clients: number;
  activeSubscriptions: number;
  /** Time entries that are billable but not yet billed (see service). */
  unbilledTimeEntries: number;
  expenses: number;
}

/** Recent-activity counts within a rolling window (see `RECENT_ACTIVITY_DAYS`). */
export interface DashboardRecentActivity {
  windowDays: number;
  clients: number;
  expenses: number;
  timeEntries: number;
  subscriptions: number;
}

/**
 * Invoice/quote-derived money aggregates. NOT YET IMPLEMENTED — the invoices and
 * quotes modules do not exist yet, so these are returned as explicit empty
 * per-currency maps. Structured so each field becomes a real aggregation query
 * later without changing the DTO shape.
 */
export interface DashboardInvoiceQuoteTotals {
  /** Revenue invoiced this month, by currency (aggregateInvoiceTotals). */
  invoicedThisMonth: CurrencyTotals;
  /** Payments collected this month, by currency. */
  collectedThisMonth: CurrencyTotals;
  /** Outstanding (open-invoice amountDue) total, by currency. */
  outstanding: CurrencyTotals;
  /** Overdue (past-due open-invoice amountDue) total, by currency. */
  overdue: CurrencyTotals;
}

/**
 * Financial block. Present ONLY when the caller may view financial totals
 * (server-side stripping); OMITTED entirely otherwise — fields are
 * absent from the payload, not merely hidden by the UI.
 */
export interface DashboardFinancials {
  /** Sum of non-deleted expenses, by currency (integer minor units). */
  expenseTotal: CurrencyTotals;
  /** Monthly-normalized MRR of ACTIVE subscriptions, by currency. */
  subscriptionMrr: CurrencyTotals;
  /** Invoice/quote-derived aggregates (stubbed — see interface). */
  invoiceQuote: DashboardInvoiceQuoteTotals;
}

/** `GET /dashboard/summary` payload. */
export interface DashboardSummary {
  /** The year (YYYY) the counts + financial roll-ups are scoped to. */
  year: number;
  counts: DashboardCounts;
  recentActivity: DashboardRecentActivity;
  /** Present iff `canViewFinancialTotals` (or administrator); omitted otherwise. */
  financials?: DashboardFinancials;
}

/**
 * Available-year range across all bucketed documents. Populates the frontend
 * year dropdown. When there are NO dated documents at all, both fall back to the
 * current year (so the dropdown always has at least the current year).
 */
export interface DashboardYears {
  minYear: number;
  maxYear: number;
}

/** Per-currency counts-by-doc-type for a single month (monthly-counts). */
export interface MonthlyDocCounts {
  invoices: number;
  proforma: number;
  quotes: number;
  creditNotes: number;
  contracts: number;
  expenses: number;
}

/**
 * One month bucket of the monthly-counts series. `counts` breaks down by doc
 * type (for the grouped/stacked counts chart + per-type heatmap); `total` is the
 * sum across all types (for the single-intensity heatmap).
 */
export interface MonthlyCountsPoint {
  /** `YYYY-MM` month key. */
  month: string;
  /** 1..12 month ordinal within the year (convenience for the chart x-axis). */
  monthNumber: number;
  counts: MonthlyDocCounts;
  total: number;
}

/** Minimal projection carrying only a bucket-date field, used for counts. */
export interface DatedRow {
  /** The type's bucket date (`YYYY-MM-DD` or ISO); may be null/absent for drafts. */
  date: string | null | undefined;
}

/**
 * One month bucket of the per-collection MONTH-BAR series: the document count and
 * the per-currency money total for that month. Powers the list-page month bar
 * (Fatture-style "N doc / € total" per month).
 */
export interface MonthlyTotalsPoint {
  /** `YYYY-MM` month key. */
  month: string;
  /** 1..12 month ordinal within the year. */
  monthNumber: number;
  /** Number of matching documents bucketed into this month. */
  count: number;
  /** Per-currency money total for the month (integer minor units, never blended). */
  totals: CurrencyTotals;
}

/** A row read for the month-bar totals: a bucket date + optional money/currency. */
export interface DatedMoneyRow {
  date: string | null | undefined;
  amountMinor?: number | null;
  currency?: string | null;
}

// ── Local source-document projections (read-only; minimal fields only) ────────

/** Minimal expense projection the aggregation reads. */
export interface ExpenseMoneyRow {
  currency: string;
  amountMinor: number;
  /** Expense date (`YYYY-MM-DD`); bucket field for the per-month expense series. */
  date?: string;
}

/** Minimal subscription projection the MRR aggregation reads. */
export interface SubscriptionMoneyRow {
  currency: string;
  amountMinor: number;
  interval: SubscriptionIntervalName;
  status: string;
}

/** Billing cadences understood by the MRR normalizer (mirrors the subscriptions enum). */
export type SubscriptionIntervalName = "weekly" | "monthly" | "quarterly" | "yearly";
