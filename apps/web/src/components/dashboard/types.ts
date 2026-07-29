/**
 * Shared dashboard-analytics contract shapes + per-type drilldown metadata.
 *
 * The dashboard's per-year charts all bind to the backend contract:
 *   GET /v1/dashboard/summary?year=        → counts, recentActivity, financials?
 *   GET /v1/dashboard/revenue-series?year= → 12× {month, invoiced, collected, expenses}
 *   GET /v1/dashboard/monthly-counts?year= → 12× {month, monthNumber, counts, total}
 *   GET /v1/dashboard/years                → {minYear, maxYear}
 *
 * Money is per-currency integer minor units, NEVER blended. financials +
 * a non-empty revenue series are gated on canViewFinancialTotals.
 */

/** Per-currency minor-unit amounts (e.g. { USD: 250000 }). */
export type MoneyByCurrency = Record<string, number>;

/** The six document types the monthly-counts chart + drilldown cover. */
export type DocType = "invoices" | "proforma" | "quotes" | "creditNotes" | "contracts" | "expenses";

export const DOC_TYPES: readonly DocType[] = [
  "invoices",
  "proforma",
  "quotes",
  "creditNotes",
  "contracts",
  "expenses",
] as const;

export interface RevenueMonth {
  month: string; // YYYY-MM
  invoiced: MoneyByCurrency;
  collected: MoneyByCurrency;
  /** Added by the per-year contract; absent on the legacy last-12-months shape. */
  expenses?: MoneyByCurrency;
}

export interface MonthlyCount {
  month: string; // YYYY-MM
  monthNumber: number; // 1..12
  counts: Record<DocType, number>;
  total: number;
}

export interface DashboardYears {
  minYear: number;
  maxYear: number;
}

/**
 * Drilldown reconciliation per doc type (spec CONFIRMED CONTRACT → DRILLDOWN):
 *  - path:       the existing list endpoint.
 *  - dateField:  the bucketing date field the counts chart uses.
 *  - statusIn:   status[in] filter matching the counts chart's ISSUED_STATUSES /
 *                non-draft rule (undefined = no status filter — contracts/expenses).
 *  - routeName:  the row's navigation target (expenses have no detail route → edit).
 *  - numberField / titleField: which field labels the row.
 */
export interface DrilldownMeta {
  path: string;
  dateField: string;
  statusIn?: readonly string[];
  routeName: string;
  numberField?: string;
  titleField?: string;
}

export const DRILLDOWN: Record<DocType, DrilldownMeta> = {
  invoices: {
    path: "/v1/invoices",
    dateField: "issueDate",
    // Matches the counts chart's ISSUED_STATUSES exactly (backend service.ts):
    // {finalized, partially_paid, paid, overdue} — NOT "sent"/"scheduled"/"draft".
    statusIn: ["finalized", "partially_paid", "paid", "overdue"],
    routeName: "invoice-detail",
    numberField: "invoiceNumber",
  },
  proforma: {
    path: "/v1/proformas",
    dateField: "issueDate",
    statusIn: ["issued", "void"], // exclude draft
    routeName: "proforma-detail",
    numberField: "proformaNumber",
  },
  quotes: {
    path: "/v1/quotes",
    dateField: "issueDate",
    statusIn: ["sent", "accepted", "declined", "expired", "converted"], // exclude draft
    routeName: "quote-detail",
    numberField: "quoteNumber",
  },
  creditNotes: {
    path: "/v1/credit-notes",
    dateField: "issueDate",
    statusIn: ["issued", "void"], // exclude draft
    routeName: "credit-note-detail",
    numberField: "creditNoteNumber",
  },
  contracts: {
    // All non-deleted, any status — no status filter (spec).
    path: "/v1/contracts",
    dateField: "startDate",
    routeName: "contract-detail",
    titleField: "title",
  },
  expenses: {
    // No draft concept, no status filter. Expenses have no detail route → edit.
    path: "/v1/expenses",
    dateField: "date",
    routeName: "expense-edit",
    titleField: "vendor",
  },
};

export const lastDayOfMonth = (year: number, monthNumber: number): number => {
  return new Date(year, monthNumber, 0).getDate();
};

export const buildDrilldownQuery = (type: DocType, year: number, monthNumbers: number[]): Record<string, string | number> => {
  const meta = DRILLDOWN[type];
  const months = monthNumbers.length > 0 ? [...monthNumbers].sort((a, b) => a - b) : [1, 12];
  const first = months[0]!;
  const last = months[months.length - 1]!;
  const pad = (n: number): string => String(n).padStart(2, "0");
  const from = `${year}-${pad(first)}-01`;
  const to = `${year}-${pad(last)}-${pad(lastDayOfMonth(year, last))}`;
  const query: Record<string, string | number> = {
    [`${meta.dateField}[gte]`]: from,
    [`${meta.dateField}[lte]`]: to,
    sort: `-${meta.dateField}`,
    limit: 100,
  };
  if (meta.statusIn) query["status[in]"] = meta.statusIn.join(",");
  return query;
};

/** English month abbreviations used as chart category labels (locale-independent axis). */
export const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
