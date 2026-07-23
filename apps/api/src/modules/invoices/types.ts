import type { BaseDoc } from "@billy/types";
import type { LineItemComputed } from "@/platform/money.js";

/**
 * Invoice entity (extends the BaseDoc mixin).
 *
 * Two-phase lifecycle: `draft` (fully editable, no number) →
 * `finalized` (numbered, line items + snapshot locked). All money fields are
 * integer minor units and **server-computed** from `lineItems`
 * via `platform/money.ts` — client-sent totals are ignored.
 *
 * `amountPaidMinor` / `amountDueMinor` obey the derived-total rule: they are
 * maintained ONLY by the payment-mutation transaction (never by the editor /
 * client), where `amountPaidMinor = Σ payments.amountMinor` and
 * `amountDueMinor = grandTotalMinor − amountPaidMinor`.
 *
 * DIVERGENCE (flagged for integrator): payments are embedded sub-docs here
 * rather than an own `payments` collection. Embedded `Payment` has no `currency`
 * field, so the CURRENCY_MISMATCH guard is deferred — a payment is implicitly in
 * the invoice currency.
 */
export type InvoiceStatus =
  | "draft"
  | "scheduled"
  | "finalized"
  | "sent"
  | "partially_paid"
  | "paid"
  | "void";

/**
 * Embedded payment record. DIVERGENCE: the canonical shape also lists
 * `invoiceId`, `currency`, `notes`, `createdBy`, `updatedAt`; this keeps a
 * minimal embedded shape. Flagged for reconciliation.
 */
export interface Payment {
  id: string;
  amountMinor: number;
  date: string; // DateOnly (YYYY-MM-DD)
  method: PaymentMethod;
  reference?: string | null;
  createdAt: string; // UTC ISO
}

/** Payment methods. */
export type PaymentMethod =
  | "bank_transfer"
  | "card"
  | "cash"
  | "paypal"
  | "stripe"
  | "direct_debit"
  | "other";

/**
 * Immutable client copy embedded at finalize/convert time.
 *
 * DIVERGENCE (flagged): the canonical `ClientSnapshot` is richer —
 * `type`, `taxCode`, `recipientCode`, `pecEmail`, `country`, `preferredLanguage`,
 * `snapshotAt`, a REQUIRED `billingAddress`, and `preferredCurrency` (not
 * `currency`). This local shape MUST match the quotes module's
 * `ConvertToInvoicePayload.clientSnapshot`; quotes does not exist yet, so this is
 * unverified — the integrator reconciles.
 */
export interface ClientSnapshot {
  clientId: string;
  displayName: string;
  legalName?: string | null;
  email?: string | null;
  billingAddress?: unknown | null;
  vatNumber?: string | null;
  currency: string;
  /** Client's language at issue — FROZEN here so the doc's rendered language
   *  (and email) never changes if the client later switches language. */
  preferredLanguage?: string | null;
  /** "First Last" contact-person, snapshotted (printed on the document). */
  referral?: string | null;
}

/**
 * Immutable copy of the chosen bank account, snapshotted at create from the
 * business-settings `bankAccounts` list (multi-bank support). NEVER a live FK —
 * the account can later be renamed/removed without altering issued invoices.
 * `details` is freeform multiline text rendered verbatim on the document.
 */
export interface BankSnapshot {
  label: string;
  details: string;
}

export interface Invoice extends BaseDoc {
  clientId: string;
  /** Optional project assignment (account-scoped projects entity). */
  projectId?: string | null;
  clientSnapshot?: ClientSnapshot | null;
  invoiceNumber?: string | null; // assigned once, at finalize
  currency: string;
  /** Snapshotted bank account (multi-bank). Set at create; null when no account resolved. */
  bankSnapshot?: BankSnapshot | null;

  issueDate: string; // DateOnly
  dueDate: string; // DateOnly (≥ issueDate)
  subject?: string | null; // optional short title shown above the line items

  lineItems: LineItemComputed[]; // server-computed; locked at finalize

  // Server-recomputed document totals (money.ts). Never client-set.
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  grandTotalMinor: number;

  // Derived totals — maintained ONLY by the payment transaction.
  amountPaidMinor: number;
  amountDueMinor: number;

  payments: Payment[]; // embedded (see DIVERGENCE above)

  status: InvoiceStatus;
  /**
   * Future send/issue date. Set when status is
   * `scheduled`: the invoice stays a pre-finalized DRAFT (no number) until the
   * worker's scheduled-send tick reaches this date, then finalizes it (assigns
   * the number, at that time — never at schedule time, to keep numbering
   * ordered by issue). `null`/absent for immediately-created invoices.
   */
  scheduledSendDate?: string | null; // DateOnly
  convertedFromQuoteId?: string | null;
  notes?: string | null;
  // Share tokens are NOT stored on the invoice — they live HASHED in the
  // `shareTokens` collection (see public-links share-tokens.ts). `/share`
  // mints one there and returns the raw token once.
}
