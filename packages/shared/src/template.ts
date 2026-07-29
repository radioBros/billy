// -----------------------------------------------------------------------------
// Document placeholder engine.
//
// Resolves `{{token}}` and `{{date|"fmt"}}` placeholders in a document's
// free-text fields (notes, terms, line-item descriptions, header/footer HTML) at
// RENDER time -- never mutating the stored text. This keeps recurring documents
// dynamic: each occurrence resolves {{date}} etc. against its own context.
//
// Design constraints:
//   - CURATED ALLOWLIST: only known tokens resolve. Unknown tokens are left
//     verbatim (so a literal "{{foo}}" the user typed survives, and there is no
//     way to reach arbitrary object fields -> no injection / field-leak surface).
//   - PURE: no I/O, no clock. The "current date" is passed in via context.now so
//     rendering is deterministic and testable (and the worker/api share one impl).
//   - Lives in @billy/shared because the worker cannot import api modules; both
//     the PDF render path and the recurring generator consume it.
// -----------------------------------------------------------------------------

/** Address parts used by the {{*.address}} tokens. All optional. */
export interface TemplateAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

/**
 * Data available to placeholder resolution. All fields optional -- a missing
 * value renders as an empty string (never the literal token, never "undefined").
 */
export interface TemplateContext {
  /** The reference "now"/occurrence date as an ISO date or datetime string. */
  now?: string;
  /** Document dates (ISO `YYYY-MM-DD`). */
  issueDate?: string | null;
  dueDate?: string | null;
  expiryDate?: string | null;
  /** Document identity + totals. */
  document?: {
    number?: string | null;
    total?: string | null;
  };
  /** Client the document is addressed to. */
  client?: {
    name?: string | null;
    email?: string | null;
    vat?: string | null;
    address?: TemplateAddress | null;
  };
  /** The issuing company (from settings). */
  company?: {
    name?: string | null;
    email?: string | null;
    vat?: string | null;
    address?: TemplateAddress | null;
  };
  /** BCP-47 locale for date formatting (defaults to "en"). */
  locale?: string;
  /** Default date format when {{date}} is used without an explicit format. */
  defaultDateFormat?: string;
}

const s = (v: string | null | undefined): string => (v == null ? "" : String(v));

/** One-line address: joins the present parts with ", ". */
const formatAddress = (a: TemplateAddress | null | undefined): string => {
  if (!a) return "";
  return [a.line1, a.line2, a.postalCode, a.city, a.region, a.country]
    .map((p) => s(p).trim())
    .filter((p) => p.length > 0)
    .join(", ");
};

// -- Date formatting ----------------------------------------------------------
// A small token grammar over Intl (no date library, per the repo's stack). The
// tokens are the common subset users expect from "dd MMM YYYY"-style formats.

const MONTHS_LONG: Record<string, string[]> = {};
const MONTHS_SHORT: Record<string, string[]> = {};

const monthNames = (locale: string, short: boolean): string[] => {
  const cache = short ? MONTHS_SHORT : MONTHS_LONG;
  if (cache[locale]) return cache[locale];
  const fmt = new Intl.DateTimeFormat(locale, { month: short ? "short" : "long", timeZone: "UTC" });
  const names = Array.from({ length: 12 }, (_, m) => fmt.format(new Date(Date.UTC(2021, m, 1))));
  cache[locale] = names;
  return names;
};

const pad = (n: number, len = 2): string => String(n).padStart(len, "0");

/** Parse an ISO date/datetime into UTC parts; returns null if unparseable. */
const parseIso = (iso: string): Date | null => {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Format an ISO date string with a token pattern. Supported tokens:
 *   YYYY year(4)  YY year(2)
 *   MMMM month long  MMM month short  MM month(2)  M month
 *   DD day(2)  dd day(2)  D day
 *   HH hour(2)  mm minute(2)  ss second(2)
 * Text inside single quotes is emitted literally. Unknown chars pass through.
 */
export const formatDate = (iso: string | null | undefined, pattern: string, locale = "en"): string => {
  if (!iso) return "";
  const d = parseIso(String(iso));
  if (!d) return String(iso);

  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-based
  const day = d.getUTCDate();
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  const second = d.getUTCSeconds();

  const values: Record<string, () => string> = {
    YYYY: () => String(year),
    YY: () => pad(year % 100),
    MMMM: () => monthNames(locale, false)[month]!,
    MMM: () => monthNames(locale, true)[month]!,
    MM: () => pad(month + 1),
    M: () => String(month + 1),
    DD: () => pad(day),
    dd: () => pad(day),
    D: () => String(day),
    HH: () => pad(hour),
    mm: () => pad(minute),
    ss: () => pad(second),
  };

  // SINGLE-PASS tokeniser: at each position match a quoted literal OR the longest
  // date token, so a substituted value (e.g. "Mar") is never re-scanned by a
  // shorter token (avoids the "M" inside "Mar" turning into the month number).
  const TOKEN = /'([^']*)'|YYYY|YY|MMMM|MMM|MM|M|DD|dd|D|HH|mm|ss/g;
  return pattern.replace(TOKEN, (match, quoted?: string) => {
    if (quoted !== undefined) return quoted;
    const fn = values[match];
    return fn ? fn() : match;
  });
};

// -- Token registry -----------------------------------------------------------
// Each entry maps a token name to a value getter. `date` is special (it takes an
// optional format arg) and handled in the resolver.

const scalarToken = (ctx: TemplateContext, name: string): string | null => {
  const dateFmt = ctx.defaultDateFormat ?? "YYYY-MM-DD";
  const locale = ctx.locale ?? "en";
  switch (name) {
    case "issueDate":
      return formatDate(ctx.issueDate, dateFmt, locale);
    case "dueDate":
      return formatDate(ctx.dueDate, dateFmt, locale);
    case "expiryDate":
      return formatDate(ctx.expiryDate, dateFmt, locale);
    case "document.number":
      return s(ctx.document?.number);
    case "total":
      return s(ctx.document?.total);
    case "client.name":
      return s(ctx.client?.name);
    case "client.email":
      return s(ctx.client?.email);
    case "client.vat":
      return s(ctx.client?.vat);
    case "client.address":
      return formatAddress(ctx.client?.address);
    case "company.name":
      return s(ctx.company?.name);
    case "company.email":
      return s(ctx.company?.email);
    case "company.vat":
      return s(ctx.company?.vat);
    case "company.address":
      return formatAddress(ctx.company?.address);
    default:
      return null; // unknown -> not a registered token
  }
};

/** All resolvable token names (for docs / a future insert-menu). `date` extra. */
export const KNOWN_TOKENS: readonly string[] = [
  "date",
  "issueDate",
  "dueDate",
  "expiryDate",
  "document.number",
  "total",
  "client.name",
  "client.email",
  "client.vat",
  "client.address",
  "company.name",
  "company.email",
  "company.vat",
  "company.address",
];

// -- Placeholder catalog (for the in-app legend + right-click insert menu) --------
// One entry per usable placeholder. Descriptions are NOT stored here — the UI reads
// them from i18n (`placeholders.tokens.<descKey>`), so this stays locale-agnostic and
// shared by api/worker/web. `insert` is the exact text an insert-menu drops at the
// caret. `docTypes` scopes which document families the token is MEANINGFUL for (e.g.
// dueDate only on invoices; expiryDate only on quotes/proformas), so the legend can
// hide tokens that would resolve to empty on the current document.

/** Document families a placeholder applies to. */
export type PlaceholderDocType = "invoice" | "quote" | "proforma" | "credit-note" | "contract";

/** Display grouping for the legend. */
export type PlaceholderGroup = "date" | "document" | "client" | "company";

export interface PlaceholderInfo {
  /** Canonical token, e.g. "client.name" (no braces). */
  token: string;
  /** Text inserted at the caret, e.g. "{{client.name}}". */
  insert: string;
  /** Legend grouping. */
  group: PlaceholderGroup;
  /** i18n description key: `placeholders.tokens.<descKey>`. */
  descKey: string;
  /** Doc families this token is meaningful for; omitted = ALL families. */
  docTypes?: readonly PlaceholderDocType[];
  /** True for tokens that accept a `|"format"` (and, for `date`, a month offset). */
  formattable?: boolean;
}

export const PLACEHOLDER_CATALOG: readonly PlaceholderInfo[] = [
  // Dates — `date` is the flexible one (offset + format); the rest are the doc's own dates.
  { token: "date", insert: '{{date}}', group: "date", descKey: "date", formattable: true },
  { token: "issueDate", insert: "{{issueDate}}", group: "date", descKey: "issueDate", formattable: true },
  { token: "dueDate", insert: "{{dueDate}}", group: "date", descKey: "dueDate", formattable: true, docTypes: ["invoice"] },
  { token: "expiryDate", insert: "{{expiryDate}}", group: "date", descKey: "expiryDate", formattable: true, docTypes: ["quote", "proforma"] },
  // Document.
  { token: "document.number", insert: "{{document.number}}", group: "document", descKey: "documentNumber" },
  { token: "total", insert: "{{total}}", group: "document", descKey: "total" },
  // Client.
  { token: "client.name", insert: "{{client.name}}", group: "client", descKey: "clientName" },
  { token: "client.email", insert: "{{client.email}}", group: "client", descKey: "clientEmail" },
  { token: "client.vat", insert: "{{client.vat}}", group: "client", descKey: "clientVat" },
  { token: "client.address", insert: "{{client.address}}", group: "client", descKey: "clientAddress" },
  // Company.
  { token: "company.name", insert: "{{company.name}}", group: "company", descKey: "companyName" },
  { token: "company.email", insert: "{{company.email}}", group: "company", descKey: "companyEmail" },
  { token: "company.vat", insert: "{{company.vat}}", group: "company", descKey: "companyVat" },
  { token: "company.address", insert: "{{company.address}}", group: "company", descKey: "companyAddress" },
];

/** The subset of the catalog meaningful for a given document type (undocTypes = all). */
export const placeholdersForDocType = (docType: PlaceholderDocType): readonly PlaceholderInfo[] =>
  PLACEHOLDER_CATALOG.filter((p) => !p.docTypes || (p.docTypes as readonly string[]).includes(docType));

// Matches {{ token }}, {{ date|"fmt" }}, and {{ date -1|"fmt" }} / {{ date +2 }}.
// The token is [A-Za-z0-9_.]; an optional signed MONTH OFFSET (e.g. -1, +2) and an
// optional |"..." format arg both apply to `date` only. A literal "{{foo}}" the
// user typed still passes through untouched (allowlist safety preserved).
const PLACEHOLDER_RE =
  /\{\{\s*([A-Za-z0-9_.]+)\s*(?:([+-]?\d+)\s*)?(?:\|\s*["']([^"']*)["']\s*)?\}\}/g;

/**
 * Shift an ISO date by `months`, clamping the day to the target month's last valid
 * day so e.g. 2026-03-31 −1 month → 2026-02-28 (never spilling into March). Pure —
 * operates in UTC on the passed date, no clock. Returns an ISO `YYYY-MM-DD` string.
 */
const shiftMonths = (iso: string, months: number): string => {
  const d = parseIso(iso);
  if (!d) return iso;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const targetY = y + Math.floor(m / 12);
  const targetM = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetY, targetM + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), lastDay);
  return `${targetY}-${pad(targetM + 1)}-${pad(day)}`;
};

/**
 * Resolve all known placeholders in `text` against `ctx`. Unknown tokens are left
 * exactly as written. `null`/`undefined` text returns "".
 */
export const resolvePlaceholders = (
  text: string | null | undefined,
  ctx: TemplateContext,
): string => {
  if (text == null) return "";
  const locale = ctx.locale ?? "en";
  return String(text).replace(PLACEHOLDER_RE, (whole, name: string, offset?: string, fmt?: string) => {
    if (name === "date") {
      let iso = ctx.now ?? ctx.issueDate ?? null;
      if (!iso) return "";
      // Optional signed month offset: {{date -1}} = one month before the anchor,
      // day-clamped to the target month (see shiftMonths). Only `date` supports it.
      if (offset) iso = shiftMonths(iso, Number(offset));
      return formatDate(iso, fmt || ctx.defaultDateFormat || "YYYY-MM-DD", locale);
    }
    // A month offset is only meaningful for `date`; a fixed token with a stray
    // offset (e.g. {{issueDate -1}}) is not a registered form -> leave verbatim.
    if (offset) return whole;
    const val = scalarToken(ctx, name);
    // Unknown token -> leave the original text untouched.
    return val === null ? whole : val;
  });
};
