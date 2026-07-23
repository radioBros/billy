import type { BaseDoc } from "@billy/types";
import type { LineItemComputed } from "@/platform/money.js";

/**
 * Quote entity. Embeds the
 * shared LineItem (server-recomputed to `LineItemComputed` on every write — never
 * trusts client totals) and a frozen `ClientSnapshot`
 * captured at send-time so a later client edit cannot mutate a sent quote.
 *
 * Status lifecycle:
 *   draft → sent → accepted | declined | expired;  accepted → converted.
 * `expired` is a derived status owned by the expiry scanner (out of scope here);
 * `archived` is expressed via `archivedAt` on BaseDoc, not a status value.
 *
 * `quoteNumber` is null until send (numbering assigned at send, gap-safe drafts).
 * `publicToken` is minted/revoked here; the no-auth `/public/quotes/:token`
 * surface is handled elsewhere — NOT built in this module.
 * `convertedInvoiceId` is set when the invoices module links the created invoice.
 *
 * All cross-entity references are by string id only (never embedded).
 */
export type QuoteStatus = "draft" | "sent" | "accepted" | "declined" | "expired" | "converted";

/**
 * Immutable client snapshot embedded at send-time. Deliberately a SUBSET of the
 * canonical client shape — this is the exact
 * shape carried forward on conversion, so the invoices module must match it.
 */
export interface ClientSnapshot {
  clientId: string;
  displayName: string;
  legalName?: string | null;
  email?: string | null;
  billingAddress?: unknown;
  vatNumber?: string | null;
  currency: string;
  preferredLanguage?: string | null;
  referral?: string | null;
  snapshotAt: string;
}

export interface Quote extends BaseDoc {
  clientId: string;
  projectId?: string | null;
  /** Frozen at send-time (null in draft). */
  clientSnapshot?: ClientSnapshot | null;
  /** Assigned at send via the atomic Q-{YEAR}-{SEQ} counter (null in draft). */
  quoteNumber?: string | null;
  currency: string;
  issueDate: string;
  expiryDate: string;
  subject?: string | null;
  /** Server-recomputed on every write from the raw line inputs. */
  lineItems: LineItemComputed[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  grandTotalMinor: number;
  status: QuoteStatus;
  notes?: string | null;
  /** Set when the caller links the invoice produced by convert(). */
  convertedInvoiceId?: string | null;
}

/**
 * Handoff payload produced by `QuoteService.convert()` and consumed by the
 * invoices module to create an invoice with `sourceType=quote`.
 * `lineItems` are the RAW inputs (invoices recomputes totals server-side; it
 * never trusts the quote's stored computed line/doc totals). The invoices module
 * must match this exact shape plus the ClientSnapshot shape above.
 */
export interface ConvertToInvoiceLineInput {
  description: string;
  quantity: number;
  unitPriceMinor: number;
  discountRate?: number;
  taxRate?: number;
}

export interface ConvertToInvoicePayload {
  quoteId: string;
  clientId: string;
  clientSnapshot: ClientSnapshot;
  currency: string;
  lineItems: ConvertToInvoiceLineInput[];
  notes?: string | null;
}
