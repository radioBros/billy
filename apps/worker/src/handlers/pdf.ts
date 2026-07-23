import { randomUUID } from "node:crypto";
import { AppError, countryName, docLabels, resolveDocumentLocale, resolveLocalized, resolvePlaceholders, type DocLabels, type LocalizedText, type Logger, type TemplateContext } from "@billy/shared";
import type { PdfJob } from "@billy/types";
import { Client as MinioClient } from "minio";
import { MongoClient, ObjectId } from "mongodb";
import { chromium, type Browser } from "playwright";
import type { ProcessorContext } from "@/processors.js";

/**
 * PDF render + store handler.
 *
 * Runs ONLY in the worker (isolation — never the API). It uses a SINGLE bounded
 * headless Chromium (no programmatic fallback), a
 * hard in-process concurrency cap (`PDF_CONCURRENCY`, default 2) so memory is
 * bounded by the cap not by job volume, then:
 *   1. fetch the invoice/quote doc + branding settings from Mongo (lazy client),
 *   2. build standalone A4 print-CSS HTML from the SERVER-recomputed doc (money
 *      in integer minor units — never re-derived here),
 *   3. render via `page.setContent` → `page.pdf({format:"A4"})` → Buffer,
 *   4. store the PDF in MinIO ("billy-files") at a server-generated objectKey and
 *      upsert a FileObject into the "files" collection.
 *
 * DUPLICATION NOTE (intentional, mirrors handlers/email.ts crypto duplication):
 * the pure HTML builders below are a byte-for-byte mirror of
 * apps/api/src/modules/pdf-generation/template.ts. The worker cannot import api
 * modules (tsconfig `rootDir` scoping) and Playwright is forbidden in the api,
 * so the WORKER owns the canonical render path and carries its own copy. Any
 * change to layout/formatting MUST be mirrored in both files.
 *
 * DEGRADATION: if Chromium is unavailable it throws
 * PDF_GENERATION_FAILED so BullMQ retries → DLQ; the doc data is never blocked on
 * the PDF. The browser singleton is kept alive across jobs; only pages are
 * closed.
 */

// ─────────────────────────────────────────────────────────────────────────────
// PURE TEMPLATE (mirror of apps/api/src/modules/pdf-generation/template.ts)
// ─────────────────────────────────────────────────────────────────────────────

interface TemplateLineItem {
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
interface TemplateAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

interface TemplateClientSnapshot {
  displayName: string;
  legalName?: string | null;
  email?: string | null;
  vatNumber?: string | null;
  /** Recipient billing address — rendered as name / addr1 / locality(+country) lines. */
  billingAddress?: TemplateAddress | null;
  /** RECIPIENT's frozen preferred language — drives document localization. */
  preferredLanguage?: string | null;
}

interface InvoiceView {
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

interface QuoteView {
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

interface ContractView {
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

interface BrandingView {
  appName: string;
  primaryColor?: string;
  secondaryColor?: string;
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
  const wholeStr = whole.toLocaleString("en-US");
  const amountStr = exp === 0 ? wholeStr : `${wholeStr}.${String(frac).padStart(exp, "0")}`;
  return `${negative ? "-" : ""}${currency.toUpperCase()} ${amountStr}`;
};

/**
 * Resolve `{{...}}` placeholders in a document's free-text fields (notes +
 * line-item descriptions) at RENDER time. Mutates a shallow copy of the doc and
 * returns it; the pure template builders then render the resolved text. Keeps
 * recurring documents dynamic ({{date}} etc. resolve per render). `now` defaults
 * to the doc's issueDate so a bare {{date}} matches the document date.
 */
interface RenderableDoc {
  issueDate?: string;
  dueDate?: string | null;
  expiryDate?: string | null;
  currency?: string;
  grandTotalMinor?: number;
  notes?: string | null;
  lineItems?: { description: string }[];
  clientSnapshot?: { displayName?: string; email?: string | null; vatNumber?: string | null } | null;
  [k: string]: unknown;
}
const resolveDocText = <T>(docIn: T, branding: BrandingView, docNumber: string): T => {
  const doc = docIn as RenderableDoc;
  const ctx: TemplateContext = {
    now: doc.issueDate,
    issueDate: doc.issueDate ?? null,
    dueDate: doc.dueDate ?? null,
    expiryDate: doc.expiryDate ?? null,
    document: {
      number: docNumber,
      total: doc.currency != null && doc.grandTotalMinor != null ? formatMoney(doc.grandTotalMinor, doc.currency) : null,
    },
    client: {
      name: doc.clientSnapshot?.displayName ?? null,
      email: doc.clientSnapshot?.email ?? null,
      vat: doc.clientSnapshot?.vatNumber ?? null,
    },
    company: {
      name: branding.companyName ?? branding.appName ?? null,
      email: branding.companyEmail ?? null,
      vat: branding.companyVatNumber ?? null,
      address: { line1: (branding.companyAddressLines ?? []).join(", ") },
    },
  };
  const out: RenderableDoc = {
    ...doc,
    notes: doc.notes != null ? resolvePlaceholders(doc.notes, ctx) : doc.notes,
    lineItems: doc.lineItems?.map((li) => ({ ...li, description: resolvePlaceholders(li.description, ctx) })),
  };
  // Contract-specific free-text fields, resolved when present.
  if (typeof doc.terms === "string") out.terms = resolvePlaceholders(doc.terms, ctx);
  return out as T;
};

const escapeHtml = (value: unknown): string => {
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

// ─────────────────────────────────────────────────────────────────────────────
// Lazy module-level singletons (mirrors handlers/email.ts self-contained pattern)
// ─────────────────────────────────────────────────────────────────────────────

const FILES_BUCKET = "billy-files";
const FILES_COLLECTION = "files";
const PDF_CONTENT_TYPE = "application/pdf";
const DEFAULT_CONCURRENCY = 2;

const pdfConcurrency = (): number => {
  const raw = process.env.PDF_CONCURRENCY;
  const n = raw && Number.isFinite(Number(raw)) ? Number(raw) : DEFAULT_CONCURRENCY;
  return n >= 1 ? Math.trunc(n) : DEFAULT_CONCURRENCY;
};

/** Single long-lived Chromium (one warm browser, reused across jobs). */
let browserPromise: Promise<Browser> | null = null;

const getBrowser = async (): Promise<Browser> => {
  if (!browserPromise) {
    // `headless: true` (single bounded Chromium). The worker image
    // ships a matching Chromium so no path is needed. `PLAYWRIGHT_CHROMIUM_
    // EXECUTABLE` optionally pins a specific Chromium binary (constrained images
    // / pinned-version envs); when set we use `--headless=new` on the full binary
    // rather than the separate headless-shell.
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
    const launchOpts = executablePath
      ? { executablePath, args: ["--headless=new"] }
      : { headless: true };
    browserPromise = chromium.launch(launchOpts).catch((err) => {
      // Reset so a later job can retry the launch (image ships Chromium; a dev
      // box without it fails fast into the retry/DLQ path).
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
};

/** Lazy MinIO client from @billy/config env (constructed once, reused). */
let minioClient: MinioClient | null = null;

const getMinio = (): MinioClient => {
  if (!minioClient) {
    minioClient = new MinioClient({
      endPoint: process.env.MINIO_ENDPOINT ?? "localhost",
      port: process.env.MINIO_PORT ? Number(process.env.MINIO_PORT) : 9000,
      useSSL: (process.env.MINIO_USE_SSL ?? "false") === "true",
      accessKey: process.env.MINIO_ACCESS_KEY ?? "billy-admin",
      secretKey: process.env.MINIO_SECRET_KEY ?? "change-me-in-env",
    });
  }
  return minioClient;
};

/** Lazy Mongo client (short server-selection timeout; reused across jobs). */
let mongoClient: MongoClient | null = null;

const getMongo = (): MongoClient => {
  if (!mongoClient) {
    const uri = process.env.MONGO_URI ?? "mongodb://localhost:27017/billy";
    mongoClient = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  }
  return mongoClient;
};

// ── In-process concurrency semaphore (hard cap) ───────────────────────────────

let active = 0;
const waiters: Array<() => void> = [];

const acquire = async (): Promise<void> => {
  if (active < pdfConcurrency()) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active += 1;
};

const release = (): void => {
  active -= 1;
  const next = waiters.shift();
  if (next) next();
};

// ── Doc + branding fetch (raw Mongo; docs are stored with `id` + soft-delete) ──
// The api persists docs with a hex `id` field and projects `_id` out (see
// platform/repository.ts). Lookup is therefore by `{ id, deletedAt: null }`, NOT
// by `_id`. Collection names mirror the api repos (invoices/quotes/settings).

interface StoredInvoice extends InvoiceView {
  id: string;
  /** Snapshotted bank account attached at create; source of the document's bank block. */
  bankSnapshot?: { label: string; details: string } | null;
}
interface StoredQuote extends QuoteView {
  id: string;
}

/**
 * Proforma/credit-note are INVOICE-SHAPED but carry their own number field
 * (proformaNumber/creditNoteNumber) and no dueDate — the handler field-maps them
 * onto InvoiceView before rendering. Modelled loosely here (the raw stored doc) so
 * the map is explicit at the call site.
 */
interface StoredProforma {
  id: string;
  proformaNumber?: string | null;
  currency: string;
  issueDate: string;
  expiryDate?: string | null;
  subject?: string | null;
  clientSnapshot?: TemplateClientSnapshot | null;
  lineItems: TemplateLineItem[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  grandTotalMinor: number;
  notes?: string | null;
  status?: string;
}
interface StoredCreditNote {
  id: string;
  creditNoteNumber?: string | null;
  currency: string;
  issueDate: string;
  subject?: string | null;
  clientSnapshot?: TemplateClientSnapshot | null;
  lineItems: TemplateLineItem[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  grandTotalMinor: number;
  notes?: string | null;
  status?: string;
}
interface StoredContract extends ContractView {
  id: string;
}

const fetchInvoice = async (id: string): Promise<StoredInvoice | null> => {
  const db = getMongo().db();
  const doc = await db
    .collection<StoredInvoice>("invoices")
    .findOne({ id, deletedAt: null } as never, { projection: { _id: 0 } });
  return (doc as StoredInvoice | null) ?? null;
};

const fetchQuote = async (id: string): Promise<StoredQuote | null> => {
  const db = getMongo().db();
  const doc = await db
    .collection<StoredQuote>("quotes")
    .findOne({ id, deletedAt: null } as never, { projection: { _id: 0 } });
  return (doc as StoredQuote | null) ?? null;
};

const fetchProforma = async (id: string): Promise<StoredProforma | null> => {
  const db = getMongo().db();
  const doc = await db
    .collection<StoredProforma>("proformas")
    .findOne({ id, deletedAt: null } as never, { projection: { _id: 0 } });
  return (doc as StoredProforma | null) ?? null;
};

const fetchCreditNote = async (id: string): Promise<StoredCreditNote | null> => {
  const db = getMongo().db();
  const doc = await db
    .collection<StoredCreditNote>("creditNotes")
    .findOne({ id, deletedAt: null } as never, { projection: { _id: 0 } });
  return (doc as StoredCreditNote | null) ?? null;
};

const fetchContract = async (id: string): Promise<StoredContract | null> => {
  const db = getMongo().db();
  const doc = await db
    .collection<StoredContract>("contracts")
    .findOne({ id, deletedAt: null } as never, { projection: { _id: 0 } });
  return (doc as StoredContract | null) ?? null;
};

const proformaToInvoiceView = (p: StoredProforma): InvoiceView => {
  return {
    invoiceNumber: p.proformaNumber ?? null,
    currency: p.currency,
    issueDate: p.issueDate,
    dueDate: p.expiryDate ?? p.issueDate,
    subject: p.subject ?? null,
    clientSnapshot: p.clientSnapshot,
    lineItems: p.lineItems,
    subtotalMinor: p.subtotalMinor,
    discountMinor: p.discountMinor,
    taxMinor: p.taxMinor,
    grandTotalMinor: p.grandTotalMinor,
    notes: p.notes,
    status: p.status,
  };
};

const creditNoteToInvoiceView = (c: StoredCreditNote): InvoiceView => {
  return {
    invoiceNumber: c.creditNoteNumber ?? null,
    currency: c.currency,
    issueDate: c.issueDate,
    dueDate: c.issueDate,
    subject: c.subject ?? null,
    clientSnapshot: c.clientSnapshot,
    lineItems: c.lineItems,
    subtotalMinor: c.subtotalMinor,
    discountMinor: c.discountMinor,
    taxMinor: c.taxMinor,
    grandTotalMinor: c.grandTotalMinor,
    notes: c.notes,
    status: c.status,
  };
};

// Shapes of the settings docs this handler reads (subset of the api settings
// types; kept local so the worker doesn't import api modules — see DUPLICATION
// NOTE). Only the fields the document header/footer needs are modelled.
interface StoredAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}
interface StoredBusinessData {
  businessName?: string | null;
  vatNumber?: string | null;
  taxCode?: string | null;
  address?: StoredAddress | null;
  email?: string | null;
}
interface StoredDocumentsData {
  logoPosition?: "left" | "right";
  showBankDetails?: boolean;
  companyLogoFileId?: string | null;
  // Request B contract header/footer fragments (added to the documents settings group
  // by the settings schema). Read if present; the contract template falls back to the
  // documentHeaderHtml/FooterHtml branding fragments when absent.
  // Localized free-text (string | per-locale map) — resolved to a string at the boundary.
  contractHeaderHtml?: LocalizedText;
  contractFooterHtml?: LocalizedText;
}
/** Branding settings source — header/footer free-text is localized (resolved at the boundary). */
interface StoredBrandingData {
  appName?: string | null;
  primaryColor?: string | null;
  secondaryColor?: string | null;
  documentHeaderHtml?: LocalizedText;
  documentFooterHtml?: LocalizedText;
}
/** The company localization singleton — only `defaultLocale` is needed (company-default fallback tier). */
interface StoredLocalizationData {
  defaultLocale?: string | null;
}
/**
 * Raw branding sources + company default locale, fetched ONCE per job. Header/footer
 * free-text stays UNRESOLVED (needs the per-document locale); `resolveBrandingView`
 * turns it into the plain-string BrandingView the templates consume.
 */
interface RawBrandingSources {
  branding?: StoredBrandingData;
  business?: StoredBusinessData;
  documents?: StoredDocumentsData;
  /** localization.defaultLocale — company-default fallback tier for locale + free-text. */
  companyDefault?: string;
}

const formatAddressLines = (address: StoredAddress | null | undefined, locale: string): string[] => {
  if (!address) return [];
  const lines: string[] = [];
  if (address.line1) lines.push(address.line1);
  if (address.line2) lines.push(address.line2);
  // Locality line: postal code, city, province, and COUNTRY all on ONE line. The
  // country renders as its localized full name (ISO alpha-2 → name via countryName).
  const localityLine = [address.postalCode, address.city, address.region ? `(${address.region})` : "", countryName(address.country, locale)]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (localityLine.length > 0) lines.push(localityLine);
  return lines;
};

const bankLinesFromSnapshot = (snapshot?: { details: string } | null): string[] => {
  if (!snapshot) return [];
  return snapshot.details
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
};

/**
 * Fetch the raw branding sources + company default locale ONCE per job. Reads the
 * localization singleton's `defaultLocale` from the SAME `settings` collection
 * (mirrors branding/business/documents), activating the company-default fallback
 * tier for both locale selection and localized free-text resolution. The
 * header/footer free-text is returned RAW (string OR per-locale map) — resolved to
 * a plain string by `resolveBrandingView` once the recipient locale is known.
 */
const fetchBrandingSources = async (accountId: string): Promise<RawBrandingSources | null> => {
  try {
    const db = getMongo().db();
    const settings = db.collection<{ key: string; data: Record<string, unknown> }>("settings");
    // Per-account settings singletons — scope by the rendered document's account.
    const [brandingDoc, businessDoc, documentsDoc, localizationDoc] = await Promise.all([
      settings.findOne({ key: "branding", accountId } as never),
      settings.findOne({ key: "business", accountId } as never),
      settings.findOne({ key: "documents", accountId } as never),
      settings.findOne({ key: "localization", accountId } as never),
    ]);
    const localization = localizationDoc?.data as StoredLocalizationData | undefined;
    return {
      branding: brandingDoc?.data as StoredBrandingData | undefined,
      business: businessDoc?.data as StoredBusinessData | undefined,
      documents: documentsDoc?.data as StoredDocumentsData | undefined,
      companyDefault: localization?.defaultLocale ?? undefined,
    };
  } catch {
    return null;
  }
};

/** Collect a Readable (minio getObject) stream into a single Buffer. */
const streamToBuffer = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

/**
 * Resolve `documents.companyLogoFileId` → a Chromium-loadable base64 `data:` URI.
 *
 * fileId → files.findOne({ id, deletedAt: null, accountId }) → objectKey +
 * contentType → MinIO getObject → Buffer → `data:<contentType>;base64,<...>`.
 * ONLY a `clean` file is embedded (mirrors the files-storage download gate). Any
 * miss (no fileId / file gone / not clean / storage error) → undefined so the
 * header falls back to the company-name text. NEVER throws — a logo failure must
 * not break PDF generation.
 */
export const resolveLogoDataUri = async (
  accountId: string,
  fileId: string | null | undefined,
): Promise<string | undefined> => {
  if (!fileId) return undefined;
  try {
    const db = getMongo().db();
    const file = await db
      .collection<{ id: string; objectKey: string; contentType: string; scanStatus: string }>(FILES_COLLECTION)
      .findOne({ id: fileId, deletedAt: null, accountId } as never, { projection: { _id: 0 } });
    if (!file || file.scanStatus !== "clean") return undefined;
    const stream = await getMinio().getObject(FILES_BUCKET, file.objectKey);
    const buf = await streamToBuffer(stream);
    return `data:${file.contentType};base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
};

/**
 * Build the plain-string BrandingView the templates consume, resolving each
 * localized free-text field to the recipient's `locale` (company `companyDefault`
 * as the middle fallback tier). Legacy plain strings pass through unchanged.
 *
 * `companyLogoUrl` is the base64 `data:` URI resolved ONCE per render from
 * documents.companyLogoFileId (see `resolveLogoDataUri`) and injected here — it is
 * account-level, not per-locale, so it is resolved by the caller and threaded in.
 * When absent (no logo / not clean / any error) the header falls back to the
 * company-name text (renderCompanyLogo handles the empty case).
 */
const resolveBrandingView = (raw: RawBrandingSources, locale: string, companyLogoUrl?: string): BrandingView => {
  const { branding, business, documents, companyDefault } = raw;
  const showBankDetails = documents?.showBankDetails ?? true;
  const rl = (field: LocalizedText): string | undefined => {
    const s = resolveLocalized(field, locale, companyDefault);
    return s.length > 0 ? s : undefined;
  };
  return {
    appName: branding?.appName || "Billy",
    primaryColor: branding?.primaryColor ?? undefined,
    secondaryColor: branding?.secondaryColor ?? undefined,
    documentHeaderHtml: rl(branding?.documentHeaderHtml),
    documentFooterHtml: rl(branding?.documentFooterHtml),
    contractHeaderHtml: rl(documents?.contractHeaderHtml),
    contractFooterHtml: rl(documents?.contractFooterHtml),
    companyName: business?.businessName ?? undefined,
    companyLogoUrl,
    companyAddressLines: formatAddressLines(business?.address, locale),
    companyVatNumber: business?.vatNumber ?? undefined,
    companyTaxCode: business?.taxCode ?? undefined,
    companyEmail: business?.email ?? undefined,
    logoPosition: documents?.logoPosition ?? "left",
    showBankDetails,
    bankLines: [], // populated per-document from the invoice's bankSnapshot (pdfHandler).
  };
};

// ── FileObject write (matches the shape BaseRepository persists / FileService reads) ──

const upsertFileObject = async (fields: {
  ownerType: string;
  ownerId: string;
  filename: string;
  sizeBytes: number;
  objectKey: string;
  uploadedBy: string;
}): Promise<string> => {
  const db = getMongo().db();
  const ts = new Date().toISOString();
  const newId = new ObjectId().toHexString();
  const result = await db.collection(FILES_COLLECTION).findOneAndUpdate(
    { ownerType: fields.ownerType, ownerId: fields.ownerId, contentType: PDF_CONTENT_TYPE, deletedAt: null } as never,
    {
      $set: {
        filename: fields.filename,
        sizeBytes: fields.sizeBytes,
        objectKey: fields.objectKey,
        scanStatus: "clean",
        uploadedBy: fields.uploadedBy,
        updatedAt: ts,
      },
      $inc: { version: 1 },
      $setOnInsert: {
        id: newId,
        ownerType: fields.ownerType,
        ownerId: fields.ownerId,
        contentType: PDF_CONTENT_TYPE,
        createdAt: ts,
        archivedAt: null,
        deletedAt: null,
      },
    } as never,
    { upsert: true, returnDocument: "after", projection: { _id: 0 } },
  );
  const doc = result as { id?: string } | null;
  return doc?.id ?? newId;
};

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

export interface PdfHandlerResult {
  fileId: string;
  objectKey: string;
  sizeBytes: number;
}

export const pdfHandler = async (payload: PdfJob, ctx: ProcessorContext): Promise<PdfHandlerResult> => {
  const logger: Logger = ctx.logger;
  const { documentType, documentId, accountId } = payload;

  // invoice/quote/proforma/credit-note/contract are in scope. `receipt` stays in the
  // PdfJob union but is a separate follow-up → still the "unsupported" case here.
  if (
    documentType !== "invoice" &&
    documentType !== "quote" &&
    documentType !== "proforma" &&
    documentType !== "credit-note" &&
    documentType !== "contract"
  ) {
    throw new AppError("PDF_GENERATION_FAILED", `Unsupported PDF document type: ${documentType}`);
  }

  // Fetch raw branding sources + company default locale ONCE. The BrandingView is
  // resolved PER-DOCUMENT below, once the recipient's document locale is known — the
  // company default is the middle fallback tier for both locale + localized free-text.
  const rawBranding = (await fetchBrandingSources(accountId)) ?? {};
  const companyDefault = rawBranding.companyDefault;
  // Resolve the company logo → base64 data URI ONCE (account-level, not per-locale).
  // Undefined on any miss → header falls back to the company-name text.
  const companyLogoUrl = await resolveLogoDataUri(accountId, rawBranding.documents?.companyLogoFileId);
  // Build the plain-string BrandingView for the recipient's locale (activates the
  // company-default fallback tier via `companyDefault`).
  const brandingFor = (clientLocale?: string | null): { locale: string; branding: BrandingView } => {
    const locale = resolveDocumentLocale(clientLocale, companyDefault);
    return { locale, branding: resolveBrandingView(rawBranding, locale, companyLogoUrl) };
  };
  let html: string;
  let docNumber: string;

  if (documentType === "invoice") {
    const invoice = await fetchInvoice(documentId);
    if (!invoice) throw new AppError("PDF_GENERATION_FAILED", `Invoice not found: ${documentId}`);
    docNumber = invoice.invoiceNumber ?? `invoice-${documentId}`;
    const { locale, branding } = brandingFor(invoice.clientSnapshot?.preferredLanguage);
    // Resolve {{...}} placeholders in the doc's free text BEFORE the pure builder.
    const resolved = resolveDocText(invoice, branding, docNumber);
    // Bank lines come from the INVOICE's bankSnapshot (not settings). Non-invoice
    // types carry no snapshot, so their bankLines stay empty.
    html = renderInvoiceHtml(resolved, { ...branding, bankLines: bankLinesFromSnapshot(invoice.bankSnapshot) }, locale);
  } else if (documentType === "quote") {
    const quote = await fetchQuote(documentId);
    if (!quote) throw new AppError("PDF_GENERATION_FAILED", `Quote not found: ${documentId}`);
    docNumber = quote.quoteNumber ?? `quote-${documentId}`;
    const { locale, branding } = brandingFor(quote.clientSnapshot?.preferredLanguage);
    html = renderQuoteHtml(resolveDocText(quote, branding, docNumber), branding, locale);
  } else if (documentType === "proforma") {
    const proforma = await fetchProforma(documentId);
    if (!proforma) throw new AppError("PDF_GENERATION_FAILED", `Proforma not found: ${documentId}`);
    docNumber = proforma.proformaNumber ?? `proforma-${documentId}`;
    const { locale, branding } = brandingFor(proforma.clientSnapshot?.preferredLanguage);
    html = renderInvoiceHtml(proformaToInvoiceView(resolveDocText(proforma, branding, docNumber)), branding, locale);
  } else if (documentType === "credit-note") {
    const creditNote = await fetchCreditNote(documentId);
    if (!creditNote) throw new AppError("PDF_GENERATION_FAILED", `Credit note not found: ${documentId}`);
    docNumber = creditNote.creditNoteNumber ?? `credit-note-${documentId}`;
    const { locale, branding } = brandingFor(creditNote.clientSnapshot?.preferredLanguage);
    html = renderInvoiceHtml(creditNoteToInvoiceView(resolveDocText(creditNote, branding, docNumber)), branding, locale);
  } else {
    const contract = await fetchContract(documentId);
    if (!contract) throw new AppError("PDF_GENERATION_FAILED", `Contract not found: ${documentId}`);
    docNumber = contract.contractNumber ?? contract.title ?? `contract-${documentId}`;
    const { locale, branding } = brandingFor(contract.clientSnapshot?.preferredLanguage);
    // Contracts carry `terms` + `notes`; resolveDocText handles notes + any line
    // items. Terms is contract-specific — resolve it too via a direct call.
    const rc = resolveDocText(contract, branding, docNumber);
    html = renderContractHtml(rc, branding, locale);
  }

  // Render under the concurrency cap. The browser is a shared singleton; only the
  // page is per-job and always closed in `finally`.
  await acquire();
  let pdf: Buffer;
  try {
    let browser: Browser;
    try {
      browser = await getBrowser();
    } catch (err) {
      // No fallback engine. Fail into BullMQ retry/DLQ with a clear log.
      logger.error({ queue: "pdf", documentType, documentId, err }, "chromium unavailable — ships in worker image; failing to retry/DLQ");
      throw new AppError("PDF_GENERATION_FAILED", "Chromium unavailable — cannot render PDF");
    }
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: "networkidle" });
      const bytes = await page.pdf({ format: "A4", printBackground: true });
      pdf = Buffer.from(bytes);
    } finally {
      await page.close();
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error({ queue: "pdf", documentType, documentId, err }, "pdf render failed");
    throw new AppError("PDF_GENERATION_FAILED", "Failed to render PDF");
  } finally {
    release();
  }

  // Store: server-generated objectKey (never from filename) + FileObject upsert.
  const objectKey = `${documentType}/${documentId}/${randomUUID()}`;
  try {
    await getMinio().putObject(FILES_BUCKET, objectKey, pdf, pdf.length, {
      "Content-Type": PDF_CONTENT_TYPE,
    });
  } catch (err) {
    logger.error({ queue: "pdf", documentType, documentId, objectKey, err }, "minio putObject failed");
    throw new AppError("PDF_GENERATION_FAILED", "Failed to store PDF in object storage");
  }

  const fileId = await upsertFileObject({
    ownerType: documentType,
    ownerId: documentId,
    filename: `${docNumber}.pdf`,
    sizeBytes: pdf.length,
    objectKey,
    uploadedBy: "system",
  });

  logger.info({ queue: "pdf", documentType, documentId, fileId, objectKey, sizeBytes: pdf.length }, "pdf rendered + stored");
  return { fileId, objectKey, sizeBytes: pdf.length };
};
