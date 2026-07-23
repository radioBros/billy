import type { BaseDoc } from "@billy/types";
import type { LineItemComputed } from "@/platform/money.js";

/**
 * CreditNote entity.
 *
 * A credit note is a refund/correcting document against a finalized invoice. Its
 * shape mirrors an Invoice (client snapshot, server-computed line-item money in
 * integer minor units, currency, notes) PLUS a reference to the originating
 * invoice (`creditedInvoiceId` / `creditedInvoiceNumber`). Totals carry positive
 * magnitudes — the *semantics* are a credit; consumers negate when aggregating.
 *
 * Two-phase lifecycle (mirrors invoice finalize): `draft` (fully editable, no
 * number, hard-deletable) → `issued` (own `CN-` number assigned once, client
 * snapshot + line items locked, immutable). `void` reachable from any non-terminal
 * state for correction with the row retained. All money is integer minor units
 * and **server-computed** from `lineItems` via `platform/money.ts`
 * — client-sent totals are ignored.
 *
 * DEFERRED (documented): the transactional `amountApplied` +
 * derived effective-outstanding require cross-module aggregation
 * against invoices; PDF, send/email, notifications, dashboard integration are
 * separate follow-ups. The correcting-document relationship (`creditedInvoiceId`)
 * is stored here so a future application step can consume it.
 *
 * NAMING DIVERGENCE (flagged): the codebase invoice idiom is `finalize`/`finalized`;
 * the task's contract for this module uses `issue`/`issued`. Behaviour is identical
 * to invoice finalize (assign number, snapshot client, lock, immutable).
 */
export type CreditNoteStatus = "draft" | "issued" | "void";

/**
 * Immutable client copy embedded at issue time. Mirrors the invoices module's
 * `ClientSnapshot` (kept local so the modules stay decoupled — no invoices import).
 */
export interface ClientSnapshot {
  clientId: string;
  displayName: string;
  legalName?: string | null;
  email?: string | null;
  billingAddress?: unknown | null;
  vatNumber?: string | null;
  currency: string;
  preferredLanguage?: string | null;
  referral?: string | null;
}

export interface CreditNote extends BaseDoc {
  clientId: string;
  projectId?: string | null;
  clientSnapshot?: ClientSnapshot | null;
  creditNoteNumber?: string | null; // assigned once, at issue (CN-{YEAR}-{SEQ})

  // Reference to the originating invoice being credited.
  creditedInvoiceId: string;
  creditedInvoiceNumber?: string | null;

  currency: string;
  issueDate: string; // DateOnly (YYYY-MM-DD)
  subject?: string | null; // optional short title shown above the line items

  lineItems: LineItemComputed[]; // server-computed; locked at issue

  // Server-recomputed document totals (money.ts). Never client-set. Positive
  // magnitudes; the credit semantics are carried by the document type.
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  grandTotalMinor: number;

  status: CreditNoteStatus;
  reason?: string | null;
  notes?: string | null;
}
