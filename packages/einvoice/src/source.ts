import { addDaysIso } from "./dates.js";
import { mapDocument, type MapResult } from "./mapper.js";
import { isConnected, toMapperSettings, type EInvoicingSettingsData } from "./settings.js";
import type { PreflightIssue, SourceAddress, SourceClient, SourceDocument, SourceLine, SourceSeller } from "./types.js";

/** Loose shapes of the Mongo docs (api and worker both read them as plain objects). */
interface RawLine extends SourceLine {}
interface RawSnapshot extends SourceClient {}
export interface RawInvoiceLike {
  invoiceNumber?: string | null;
  creditNoteNumber?: string | null;
  issueDate: string;
  dueDate?: string | null;
  currency: string;
  lineItems: RawLine[];
  grandTotalMinor: number;
  clientSnapshot?: RawSnapshot | null;
  bankSnapshot?: { iban?: string | null } | null;
  creditedInvoiceNumber?: string | null;
  creditedIssueDate?: string | null;
}
export interface RawBusinessLike {
  businessName: string;
  legalName?: string | null;
  vatNumber?: string | null;
  taxCode?: string | null;
  address?: SourceAddress | null;
}

export type DocKind = "invoice" | "credit_note";

export const buildSourceDocument = (kind: DocKind, d: RawInvoiceLike): SourceDocument => ({
  kind,
  number: (kind === "credit_note" ? d.creditNoteNumber : d.invoiceNumber) ?? "",
  issueDate: d.issueDate,
  dueDate: d.dueDate ?? null,
  currency: d.currency,
  lines: d.lineItems,
  grandTotalMinor: d.grandTotalMinor,
  client: d.clientSnapshot ?? { displayName: "" },
  iban: d.bankSnapshot?.iban ?? null,
  creditedNumber: d.creditedInvoiceNumber ?? null,
  creditedDate: d.creditedIssueDate ?? null,
});

export const buildSourceSeller = (b: RawBusinessLike): SourceSeller => ({
  name: (b.legalName || b.businessName || "").trim(),
  vatNumber: b.vatNumber ?? null,
  taxCode: b.taxCode ?? null,
  address: b.address ?? null,
});

/** Last day to transmit (invoice date + N days, art. 21 DPR 633/72). */
export const sendDeadline = (issueDate: string, days: number, today: string): { dueBy: string; overdue: boolean } => {
  const dueBy = addDaysIso(issueDate, days);
  return { dueBy, overdue: today > dueBy };
};

export interface EvaluateInput {
  kind: DocKind;
  doc: RawInvoiceLike;
  business: RawBusinessLike;
  settings: EInvoicingSettingsData;
  envApiUrl?: string | null;
  /** `YYYY-MM-DD` in the account's timezone. */
  today: string;
  /** createdAt/finalizedAt of the doc, to flag documents issued before e-invoicing was enabled. */
  docFinalizedAt?: string | null;
  crmInvoiceRef: string;
}

/**
 * The single readiness check used by the API (preflight, submit gate) and the worker
 * (before every submission): integration state + fiscal mapping + legal deadline.
 */
export const evaluateDocument = (i: EvaluateInput): MapResult => {
  const extra: PreflightIssue[] = [];
  if (!i.settings.enabled) extra.push({ code: "einvoicing.disabled", severity: "error", fix: "settings" });
  else if (!isConnected(i.settings, i.envApiUrl)) extra.push({ code: "einvoicing.not_connected", severity: "error", fix: "settings" });

  const r = mapDocument(
    buildSourceDocument(i.kind, i.doc),
    buildSourceSeller(i.business),
    toMapperSettings(i.settings),
    { passoSellerId: i.settings.passoSellerId ?? "", crmInvoiceRef: i.crmInvoiceRef },
  );
  const warnings: PreflightIssue[] = [];
  if (i.doc.issueDate && sendDeadline(i.doc.issueDate, i.settings.sendDeadlineDays, i.today).overdue) {
    warnings.push({ code: "invoice.deadline_passed", severity: "warning", fix: "none", params: { days: i.settings.sendDeadlineDays } });
  }
  if (i.settings.enabledAt && i.docFinalizedAt && i.docFinalizedAt < i.settings.enabledAt) {
    warnings.push({ code: "invoice.finalized_before_enable", severity: "warning", fix: "none" });
  }
  const issues = [...extra, ...r.issues, ...warnings];
  const ok = !issues.some((x) => x.severity === "error");
  return { ...r, issues, ok, body: ok ? r.body : null };
};
