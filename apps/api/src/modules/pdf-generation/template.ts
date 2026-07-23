/**
 * PURE PDF HTML template builder.
 *
 * Builds standalone A4 print-CSS HTML for invoice + quote documents from the
 * **server-recomputed** document doc (money in integer minor units)
 * plus a branding view-model. NO business math here — totals arrive already
 * computed on the doc; this module only *presents* them. NO
 * I/O, NO Playwright — pure string building, fully unit-testable.
 *
 * DUPLICATION NOTE (intentional, mirrors handlers/email.ts crypto duplication):
 * the worker owns the *canonical* render path and carries its own byte-identical
 * copy of these builders (apps/worker/src/handlers/pdf.ts) because the worker
 * cannot import api modules (tsconfig `rootDir` scoping + no-playwright-in-api).
 * This api copy is the source of truth for shape/tests and any api-side
 * preview; any change to layout/formatting MUST be mirrored in both files.
 */

import { countryName, docLabels, type DocLabels } from "@billy/shared";

// ── Minimal structural view of the source documents (subset consumed here) ────
// Kept local so the template is decoupled from the full invoice/quote entity and
// so the worker's copy can mirror it without importing api types.

export interface TemplateLineItem {
  description: string;
  quantity: number;
  unitPriceMinor: number;
  discountRate?: number;
  taxRate?: number;
  lineSubtotalMinor: number;
  lineDiscountMinor: number;
  lineTaxMinor: number;
  lineTotalMinor: number;
}

/** Structured recipient address (frozen @billy/validation Address shape; country is an ISO alpha-2 code). */
export interface TemplateAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export interface TemplateClientSnapshot {
  displayName: string;
  legalName?: string | null;
  email?: string | null;
  vatNumber?: string | null;
  /** Recipient billing address — rendered as name / addr1 / locality(+country) lines. */
  billingAddress?: TemplateAddress | null;
  /** RECIPIENT's frozen preferred language — drives document localization. */
  preferredLanguage?: string | null;
}

export interface InvoiceView {
  invoiceNumber?: string | null;
  currency: string;
  issueDate: string;
  dueDate: string;
  subject?: string | null;
  clientSnapshot?: TemplateClientSnapshot | null;
  lineItems: TemplateLineItem[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  grandTotalMinor: number;
  amountPaidMinor?: number;
  amountDueMinor?: number;
  notes?: string | null;
  status?: string;
}

export interface QuoteView {
  quoteNumber?: string | null;
  subject?: string | null;
  currency: string;
  issueDate: string;
  expiryDate: string;
  clientSnapshot?: TemplateClientSnapshot | null;
  lineItems: TemplateLineItem[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  grandTotalMinor: number;
  notes?: string | null;
  status?: string;
}

export interface ContractView {
  contractNumber?: string | null;
 /** Owning client id — used as the client-party fallback when no snapshot exists. */
  clientId?: string | null;
  title: string;
 /** `YYYY-MM-DD` in business timezone. */
  startDate: string;
 /** `YYYY-MM-DD`; null/absent for open-ended contracts. */
  endDate?: string | null;
  currency?: string | null;
  valueMinor?: number | null;
  clientSnapshot?: TemplateClientSnapshot | null;
  terms?: string | null;
  notes?: string | null;
  status?: string;
}

/** Branding view-model (settings branding group). */
export interface BrandingView {
  appName: string;
  primaryColor?: string;
  secondaryColor?: string;
 /** Raw HTML fragments the admin configured. */
  documentHeaderHtml?: string | null;
  documentFooterHtml?: string | null;
 /** Contract-specific header/footer fragments (Request B, documents settings). Fall back to documentHeaderHtml/FooterHtml when absent. */
  contractHeaderHtml?: string | null;
  contractFooterHtml?: string | null;
 // NEW — company identity for the redesigned document header (business + documents settings).
  companyName?: string | null;
 /** Resolved URL/data for the COMPANY logo (worker resolves from documents.companyLogoFileId). */
  companyLogoUrl?: string | null;
 /** Pre-formatted company address lines (street / postal-city / province). */
  companyAddressLines?: string[];
  companyVatNumber?: string | null;
  companyTaxCode?: string | null;
  companyEmail?: string | null;
 /** left = logo left / company details right; right INVERTS the columns. */
  logoPosition?: "left" | "right";
  showBankDetails?: boolean;
 /** Pre-formatted bank detail lines (empty when disabled / no bank details). */
  bankLines?: string[];
}

// ── Formatting helpers (never float math on amounts) ──────────────────────────

/** Minor-unit exponent per ISO-4217 currency (default 2; zero-decimal & 3-dp sets). */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "HUF", "XAF", "XOF"]);
const THREE_DECIMAL = new Set(["BHD", "KWD", "OMR", "TND", "JOD", "IQD", "LYD"]);

const minorExponent = (currency: string): number => {
  const c = currency.toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
};

export const formatMoney = (amountMinor: number, currency: string): string => {
  const exp = minorExponent(currency);
  const negative = amountMinor < 0;
  const abs = Math.abs(Math.trunc(amountMinor));
  const divisor = 10 ** exp;
  const whole = Math.floor(abs / divisor);
  const frac = abs - whole * divisor;
 // Group the integer part with thousands separators.
  const wholeStr = whole.toLocaleString("en-US");
  const amountStr =
    exp === 0 ? wholeStr : `${wholeStr}.${String(frac).padStart(exp, "0")}`;
  return `${negative ? "-" : ""}${currency.toUpperCase()} ${amountStr}`;
};

export const escapeHtml = (value: unknown): string => {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const formatRate = (rate?: number): string => {
  return rate === undefined || rate === null ? "" : `${rate}%`;
};

// ── Shared markup ─────────────────────────────────────────────────────────────

const PRINT_CSS = `
  @page { size: A4; margin: 18mm 16mm; }
 * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1a1a1a; font-size: 12px; line-height: 1.45;
  }
  .doc { width: 100%; }
  .doc-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-bottom: 16px; }
  .doc-header .logo-col { flex: 0 0 auto; max-width: 45%; }
  .doc-header .company-col { flex: 1; }
  .doc-header .company-col.align-right { text-align: right; }
  .company-logo { max-height: 72px; max-width: 100%; }
  .brand { font-size: 20px; font-weight: 700; color: var(--brand-primary, #111827); }
  .company-name { font-size: 15px; font-weight: 700; color: #111827; }
  .company-line { font-size: 11px; color: #374151; }
  .doc-title { margin-top: 10px; font-size: 15px; color: var(--brand-primary, #111827); }
  .doc-title strong { font-weight: 700; }
  .status-badge { display: inline-block; margin-top: 6px; padding: 2px 8px; border-radius: 4px; font-size: 10px; text-transform: uppercase; background: var(--brand-secondary, #e5e7eb); color: #111827; }
  .hairline { border: 0; border-top: 1px solid #e5e7eb; margin: 12px 0; }
  .meta { display: flex; justify-content: space-between; margin-bottom: 8px; gap: 24px; }
  .meta .block { flex: 1; }
  .meta .block.recipient { text-align: right; }
  .meta .block.dates { text-align: right; flex: 0 0 auto; }
  .meta h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #6b7280; margin: 0 0 4px; }
  .meta .label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #374151; }
  .meta .line { font-size: 12px; }
  table.items { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  table.items th { text-align: left; border-bottom: 2px solid var(--brand-primary, #111827); padding: 6px 8px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; color: #374151; }
  table.items td { padding: 6px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  table.items td.num, table.items th.num { text-align: right; white-space: nowrap; }
  .totals { width: 52%; margin-left: auto; }
  .totals table { width: 100%; border-collapse: collapse; }
  .totals td { padding: 4px 8px; white-space: nowrap; }
  .totals td.num { text-align: right; white-space: nowrap; }
  .totals tr.grand td { border-top: 2px solid var(--brand-primary, #111827); font-weight: 700; font-size: 14px; }
  .totals tr.grand-total td { font-weight: 700; font-size: 26px; color: var(--brand-primary, #111827); padding-top: 8px; white-space: nowrap; }
  .notes { margin-top: 20px; padding-top: 12px; border-top: 1px solid #e5e7eb; }
  .notes h2 { font-size: 11px; text-transform: uppercase; color: #6b7280; margin: 0 0 4px; }
  .subject { margin: 0 0 14px; }
  .subject h2 { font-size: 11px; text-transform: uppercase; color: #6b7280; margin: 0 0 4px; letter-spacing: 0.04em; }
  .subject-text { font-size: 14px; font-weight: 700; color: #111827; }
  .bank-details { margin-top: 20px; padding-top: 12px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #374151; }
  .bank-details h2 { font-size: 11px; text-transform: uppercase; color: #6b7280; margin: 0 0 4px; }
  .doc-footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid #e5e7eb; font-size: 10px; color: #6b7280; }
  tr { page-break-inside: avoid; }
`;

const renderClientBlock = (snap: TemplateClientSnapshot | null | undefined, locale: string, labels: DocLabels): string => {
  if (!snap) return `<div class="line">—</div>`;
  const addr = snap.billingAddress;
  // Locality line: postal code, city, province, and COUNTRY all on ONE line —
  // structurally identical to the company block's composed locality line. The
  // country renders as its localized full name (ISO alpha-2 → name via countryName).
  const localityLine = addr
    ? [addr.postalCode, addr.city, addr.region ? `(${addr.region})` : "", countryName(addr.country, locale)].filter(Boolean).join(" ").trim()
    : "";
  const lines = [
    `<div class="line"><strong>${escapeHtml(snap.displayName)}</strong></div>`,
    snap.legalName ? `<div class="line">${escapeHtml(snap.legalName)}</div>` : "",
    addr?.line1 ? `<div class="line">${escapeHtml(addr.line1)}</div>` : "",
    addr?.line2 ? `<div class="line">${escapeHtml(addr.line2)}</div>` : "",
    localityLine ? `<div class="line">${escapeHtml(localityLine)}</div>` : "",
    snap.email ? `<div class="line">${escapeHtml(snap.email)}</div>` : "",
    snap.vatNumber ? `<div class="line">${escapeHtml(labels.vat)}: ${escapeHtml(snap.vatNumber)}</div>` : "",
  ];
  return lines.join("");
};

const renderCompanyLogo = (branding: BrandingView): string => {
  if (branding.companyLogoUrl && branding.companyLogoUrl.trim().length > 0) {
    const alt = escapeHtml(branding.companyName || branding.appName);
    return `<img class="company-logo" src="${escapeHtml(branding.companyLogoUrl)}" alt="${alt}">`;
  }
  return "";
};

const renderCompanyBlock = (branding: BrandingView, labels: DocLabels, docTitle: string, docNumber: string, issueDate: string, status?: string): string => {
  const idParts = [
    branding.companyVatNumber ? `${escapeHtml(labels.vat)} ${escapeHtml(branding.companyVatNumber)}` : "",
    branding.companyTaxCode ? `C.F. ${escapeHtml(branding.companyTaxCode)}` : "",
  ].filter(Boolean);
  const addressLines = (branding.companyAddressLines ?? [])
    .filter((l) => l && l.trim().length > 0)
    .map((l) => `<div class="company-line">${escapeHtml(l)}</div>`)
    .join("");
  // Company email lives ONLY here in the header identity block — the old redundant
  // "Sender" column in .meta was removed, so this is the single place it appears.
  const emailLine = branding.companyEmail ? `<div class="company-line">${escapeHtml(branding.companyEmail)}</div>` : "";
  return `
    <div class="company-name">${escapeHtml(branding.companyName || branding.appName)}</div>
    ${addressLines}
    ${idParts.length ? `<div class="company-line">${idParts.join(" - ")}</div>` : ""}
    ${emailLine}
    <div class="doc-title"><strong>${escapeHtml(docTitle)}</strong> ${escapeHtml(labels.numberWord)} <strong>${escapeHtml(docNumber)}</strong> ${escapeHtml(labels.dateWord)} <strong>${escapeHtml(issueDate)}</strong></div>
    ${status ? `<div class="status-badge">${escapeHtml(status)}</div>` : ""}`;
};

const renderBankDetails = (branding: BrandingView, labels: DocLabels): string => {
  const lines = (branding.bankLines ?? []).filter((l) => l && l.trim().length > 0);
  if (branding.showBankDetails === false || lines.length === 0) return "";
  const body = lines.map((l) => `<div class="company-line">${escapeHtml(l)}</div>`).join("");
  return `<div class="bank-details"><h2>${escapeHtml(labels.bankDetails)}</h2>${body}</div>`;
};

const renderLineRows = (items: TemplateLineItem[], currency: string, labels: DocLabels): string => {
  return items
    .map((li) => {
      const rateParts = [formatRate(li.discountRate) && `−${formatRate(li.discountRate)}`, formatRate(li.taxRate) && `+${formatRate(li.taxRate)} ${labels.tax.toLowerCase()}`]
        .filter(Boolean)
        .join(" ");
      return `
        <tr>
          <td>${escapeHtml(li.description)}${rateParts ? `<div style="color:#6b7280;font-size:10px">${escapeHtml(rateParts)}</div>` : ""}</td>
          <td class="num">${escapeHtml(li.quantity)}</td>
          <td class="num">${formatMoney(li.unitPriceMinor, currency)}</td>
          <td class="num">${formatMoney(li.lineTotalMinor, currency)}</td>
        </tr>`;
    })
    .join("");
};

interface TotalsRow {
  label: string;
  amountMinor: number;
 /** Subtotal-line grand emphasis (border + bold), used for intermediate "Total" when a payment splits it. */
  grand?: boolean;
 /** The single primary grand-total figure — rendered MUCH larger in the primary color. */
  grandTotal?: boolean;
}

/** Optional subject block shown above the line items. Empty → nothing. */
const renderSubject = (labels: DocLabels, subject?: string | null): string => {
  if (!subject || subject.trim().length === 0) return "";
  return `<div class="subject"><h2>${escapeHtml(labels.subject)}</h2><div class="subject-text">${escapeHtml(subject)}</div></div>`;
};

const renderTotals = (rows: TotalsRow[], currency: string): string => {
  const body = rows
    .map((r) => {
      const cls = r.grandTotal ? "grand-total" : r.grand ? "grand" : "";
      return `<tr class="${cls}"><td>${escapeHtml(r.label)}</td><td class="num">${formatMoney(r.amountMinor, currency)}</td></tr>`;
    })
    .join("");
  return `<div class="totals"><table><tbody>${body}</tbody></table></div>`;
};

const renderHeader = (branding: BrandingView, labels: DocLabels, docTitle: string, docNumber: string, issueDate: string, status?: string): string => {
  const logoInner =
    branding.documentHeaderHtml && branding.documentHeaderHtml.trim().length > 0
      ? branding.documentHeaderHtml // trusted admin-configured fragment
      : renderCompanyLogo(branding);
  const logoCol = `<div class="logo-col">${logoInner}</div>`;
  const onRight = branding.logoPosition === "right";
  const companyCol = `<div class="company-col ${onRight ? "" : "align-right"}">${renderCompanyBlock(branding, labels, docTitle, docNumber, issueDate, status)}</div>`;
  const cols = onRight ? `${companyCol}${logoCol}` : `${logoCol}${companyCol}`;
  return `<div class="doc-header">${cols}</div>`;
};

const renderSenderBlock = (branding: BrandingView, labels: DocLabels): string => {
  const lines = [
    branding.companyVatNumber ? `<div class="line"><span class="label">${escapeHtml(labels.vat)}</span> ${escapeHtml(branding.companyVatNumber)}</div>` : "",
    branding.companyEmail ? `<div class="line"><span class="label">EMAIL</span> ${escapeHtml(branding.companyEmail)}</div>` : "",
  ].filter(Boolean);
  return lines.join("");
};

const renderFooter = (branding: BrandingView): string => {
  if (branding.documentFooterHtml && branding.documentFooterHtml.trim().length > 0) {
    return `<div class="doc-footer">${branding.documentFooterHtml}</div>`;
  }
  return `<div class="doc-footer">${escapeHtml(branding.appName)}</div>`;
};

const shell = (branding: BrandingView, inner: string): string => {
  const vars = [
    branding.primaryColor ? `--brand-primary:${escapeHtml(branding.primaryColor)}` : "",
    branding.secondaryColor ? `--brand-secondary:${escapeHtml(branding.secondaryColor)}` : "",
  ]
    .filter(Boolean)
    .join(";");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PRINT_CSS}</style></head><body style="${vars}"><div class="doc">${inner}</div></body></html>`;
};

// ── Public builders ────────────────────────────────────────────────────────────

export const renderInvoiceHtml = (invoice: InvoiceView, branding: BrandingView, locale = "en"): string => {
  const L = docLabels(locale);
  const currency = invoice.currency;
  const number = invoice.invoiceNumber ?? "DRAFT";
  const totalsRows: TotalsRow[] = [
    { label: L.subtotal, amountMinor: invoice.subtotalMinor },
  ];
  if (invoice.discountMinor) totalsRows.push({ label: L.discount, amountMinor: -invoice.discountMinor });
  totalsRows.push({ label: L.tax, amountMinor: invoice.taxMinor });
  const hasPayment = invoice.amountPaidMinor !== undefined && invoice.amountPaidMinor > 0;
  totalsRows.push({ label: L.total, amountMinor: invoice.grandTotalMinor, grand: true, grandTotal: !hasPayment });
  if (hasPayment) {
    totalsRows.push({ label: L.paid, amountMinor: -(invoice.amountPaidMinor ?? 0) });
    totalsRows.push({ label: L.amountDue, amountMinor: invoice.amountDueMinor ?? invoice.grandTotalMinor - (invoice.amountPaidMinor ?? 0), grandTotal: true });
  }

  // Recipient block: ONLY the client's own data (name / address / email / VAT).
  // The company (sender) identity lives solely in the header — no redundant sender
  // column here. A small dates sub-block sits beside the recipient.
  const recipientCol = `<div class="block"><h2>${escapeHtml(L.recipient)}</h2>${renderClientBlock(invoice.clientSnapshot, locale, L)}</div>`;
  const datesCol = `<div class="block dates"><div class="line">${escapeHtml(L.issueDate)}: ${escapeHtml(invoice.issueDate)}</div><div class="line">${escapeHtml(L.dueDate)}: ${escapeHtml(invoice.dueDate)}</div></div>`;

  const inner = `
    ${renderHeader(branding, L, L.invoice, number, invoice.issueDate, invoice.status)}
    <hr class="hairline">
    <div class="meta">
      ${recipientCol}${datesCol}
    </div>
    <hr class="hairline">
    ${renderSubject(L, invoice.subject)}
    <table class="items">
      <thead><tr><th>${escapeHtml(L.description)}</th><th class="num">${escapeHtml(L.quantity)}</th><th class="num">${escapeHtml(L.unitPrice)}</th><th class="num">${escapeHtml(L.amount)}</th></tr></thead>
      <tbody>${renderLineRows(invoice.lineItems, currency, L)}</tbody>
    </table>
    ${renderTotals(totalsRows, currency)}
    ${invoice.notes ? `<div class="notes"><h2>${escapeHtml(L.notes)}</h2><div>${escapeHtml(invoice.notes)}</div></div>` : ""}
    ${renderBankDetails(branding, L)}
    ${renderFooter(branding)}`;
  return shell(branding, inner);
};

export const renderQuoteHtml = (quote: QuoteView, branding: BrandingView, locale = "en"): string => {
  const L = docLabels(locale);
  const currency = quote.currency;
  const number = quote.quoteNumber ?? "DRAFT";
  const totalsRows: TotalsRow[] = [
    { label: L.subtotal, amountMinor: quote.subtotalMinor },
  ];
  if (quote.discountMinor) totalsRows.push({ label: L.discount, amountMinor: -quote.discountMinor });
  totalsRows.push({ label: L.tax, amountMinor: quote.taxMinor });
  totalsRows.push({ label: L.total, amountMinor: quote.grandTotalMinor, grand: true, grandTotal: true });

  // Recipient block holds ONLY client data; company identity is header-only.
  const recipientCol = `<div class="block"><h2>${escapeHtml(L.recipient)}</h2>${renderClientBlock(quote.clientSnapshot, locale, L)}</div>`;
  const datesCol = `<div class="block dates"><div class="line">${escapeHtml(L.issueDate)}: ${escapeHtml(quote.issueDate)}</div><div class="line">Valid until: ${escapeHtml(quote.expiryDate)}</div></div>`;

  const inner = `
    ${renderHeader(branding, L, L.quote, number, quote.issueDate, quote.status)}
    <hr class="hairline">
    <div class="meta">
      ${recipientCol}${datesCol}
    </div>
    <hr class="hairline">
    ${renderSubject(L, quote.subject)}
    <table class="items">
      <thead><tr><th>${escapeHtml(L.description)}</th><th class="num">${escapeHtml(L.quantity)}</th><th class="num">${escapeHtml(L.unitPrice)}</th><th class="num">${escapeHtml(L.amount)}</th></tr></thead>
      <tbody>${renderLineRows(quote.lineItems, currency, L)}</tbody>
    </table>
    ${renderTotals(totalsRows, currency)}
    ${quote.notes ? `<div class="notes"><h2>${escapeHtml(L.notes)}</h2><div>${escapeHtml(quote.notes)}</div></div>` : ""}
    ${renderBankDetails(branding, L)}
    ${renderFooter(branding)}`;
  return shell(branding, inner);
};

const renderContractCompanyBlock = (branding: BrandingView, labels: DocLabels, contract: ContractView): string => {
  const idParts = [
    branding.companyVatNumber ? `${escapeHtml(labels.vat)} ${escapeHtml(branding.companyVatNumber)}` : "",
    branding.companyTaxCode ? `C.F. ${escapeHtml(branding.companyTaxCode)}` : "",
  ].filter(Boolean);
  const addressLines = (branding.companyAddressLines ?? [])
    .filter((l) => l && l.trim().length > 0)
    .map((l) => `<div class="company-line">${escapeHtml(l)}</div>`)
    .join("");
  const period = `${escapeHtml(contract.startDate)}${contract.endDate ? ` — ${escapeHtml(contract.endDate)}` : " — open-ended"}`;
  return `
    <div class="company-name">${escapeHtml(branding.companyName || branding.appName)}</div>
    ${addressLines}
    ${idParts.length ? `<div class="company-line">${idParts.join(" - ")}</div>` : ""}
    <div class="doc-title"><strong>${escapeHtml(labels.contract)}</strong>: <strong>${escapeHtml(contract.title)}</strong></div>
    <div class="company-line">${period}</div>
    ${contract.status ? `<div class="status-badge">${escapeHtml(contract.status)}</div>` : ""}`;
};

const renderContractHeader = (branding: BrandingView, labels: DocLabels, contract: ContractView): string => {
  const headerHtml = branding.contractHeaderHtml ?? branding.documentHeaderHtml;
  const logoInner =
    headerHtml && headerHtml.trim().length > 0
      ? headerHtml // trusted admin-configured fragment
      : renderCompanyLogo(branding);
  const logoCol = `<div class="logo-col">${logoInner}</div>`;
  const onRight = branding.logoPosition === "right";
  const companyCol = `<div class="company-col ${onRight ? "" : "align-right"}">${renderContractCompanyBlock(branding, labels, contract)}</div>`;
  const cols = onRight ? `${companyCol}${logoCol}` : `${logoCol}${companyCol}`;
  return `<div class="doc-header">${cols}</div>`;
};

const renderContractFooter = (branding: BrandingView): string => {
  if (branding.contractFooterHtml && branding.contractFooterHtml.trim().length > 0) {
    return `<div class="doc-footer">${branding.contractFooterHtml}</div>`;
  }
  return renderFooter(branding);
};

export const renderContractHtml = (contract: ContractView, branding: BrandingView, locale = "en"): string => {
  const L = docLabels(locale);
 // Contracts carry only a clientId (no embedded snapshot); fall back to the id as
 // the client-party display name when no snapshot is present.
  const client = contract.clientSnapshot ?? (contract.clientId ? { displayName: contract.clientId } : null);
  const recipientOnRight = branding.logoPosition !== "right";
  const senderCol = `<div class="block ${recipientOnRight ? "" : "recipient"}"><h2>Provider</h2>${renderSenderBlock(branding, L)}</div>`;
  const recipientCol = `<div class="block ${recipientOnRight ? "recipient" : ""}"><h2>Client</h2>${renderClientBlock(client, locale, L)}<div class="line">Start date: ${escapeHtml(contract.startDate)}</div><div class="line">End date: ${escapeHtml(contract.endDate ?? "—")}</div></div>`;

  const valueLine =
    contract.valueMinor !== undefined && contract.valueMinor !== null && contract.currency
      ? `<div class="line"><span class="label">Contract value</span> ${formatMoney(contract.valueMinor, contract.currency)}</div>`
      : "";

  const inner = `
    ${renderContractHeader(branding, L, contract)}
    <hr class="hairline">
    <div class="meta">
      ${recipientOnRight ? `${senderCol}${recipientCol}` : `${recipientCol}${senderCol}`}
    </div>
    <hr class="hairline">
    ${valueLine}
    ${contract.terms ? `<div class="notes"><h2>Terms</h2><div>${escapeHtml(contract.terms)}</div></div>` : ""}
    ${contract.notes ? `<div class="notes"><h2>${escapeHtml(L.notes)}</h2><div>${escapeHtml(contract.notes)}</div></div>` : ""}
    ${renderContractFooter(branding)}`;
  return shell(branding, inner);
};
