import type { Quote } from "@/modules/quotes/types.js";
import type { Invoice } from "@/modules/invoices/types.js";

/**
 * Public-links module types.
 *
 * This is the PUBLIC, UNAUTHENTICATED read surface. It exposes ONLY a dedicated
 * allowlist projection of a shared quote/invoice — never the authenticated
 * serializer, never internal ids/financial internals/other-entity data.
 *
 * TOKEN STORAGE: share tokens are stored HASHED in a
 * dedicated `shareTokens` collection (share-tokens.ts) — SHA-256 at rest, indexed
 * hash lookup, constant-time compare, uniform 404. NO raw token is on the quote
 * or invoice document. Resolution here goes token→hash→{type,id}→load doc by id.
 *
 * Remaining divergences:
 * - ACCEPT/DECLINE METADATA: `acceptedAt`/`declinedAt` are written by this module
 * but are **not** on the canonical `Quote` type (see {@link PublicQuoteDoc}).
 * - viewedAt / quote.viewed / invoice.viewed events are DEFERRED.
 */

export type PublicQuoteDoc = Quote & {
 /** Recipient-action metadata (not on the canonical Quote type — divergence). */
  acceptedAt?: string | null;
  declinedAt?: string | null;
};

export type PublicInvoiceDoc = Invoice;

/** A single line item as exposed to the public (presentation fields only). */
export interface PublicLineItemDTO {
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

/** Issuer branding exposed publicly — business name ONLY (no contact internals). */
export interface PublicIssuerDTO {
  businessName: string;
}

/** Public quote projection (allowlist, constructed field-by-field — never a copy). */
export interface PublicQuoteDTO {
  documentType: "quote";
  documentNumber: string | null;
  status: string;
  currency: string;
  issueDate: string;
  expiryDate: string;
  lineItems: PublicLineItemDTO[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  grandTotalMinor: number;
  clientDisplayName: string | null;
  issuer: PublicIssuerDTO;
  acceptedAt?: string | null;
  declinedAt?: string | null;
}

/** Public invoice projection (allowlist, read-only). */
export interface PublicInvoiceDTO {
  documentType: "invoice";
  documentNumber: string | null;
  status: string;
  currency: string;
  issueDate: string;
  dueDate: string;
  lineItems: PublicLineItemDTO[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  grandTotalMinor: number;
  clientDisplayName: string | null;
  issuer: PublicIssuerDTO;
}

/**
 * Per-token+IP rate limiter. Injectable so tests can supply a low-ceiling
 * or deterministic fake. `check` returns `null` when allowed, or the number of
 * seconds to wait (for `Retry-After`) when the window ceiling is exceeded.
 */
export interface RateLimiter {
  check(key: string): { retryAfterSeconds: number } | null;
}
