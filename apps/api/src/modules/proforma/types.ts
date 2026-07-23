import type { BaseDoc } from "@billy/types";
import type { LineItemComputed } from "@/platform/money.js";

/**
 * Proforma entity.
 *
 * A proforma is a preliminary, **NON-FISCAL** preview document. It has the same
 * shape as an invoice (client snapshot, server-computed line-item money in integer
 * minor units, currency, notes) but is NOT a real invoice: it has no payments, no
 * balance fields, and contributes nothing to revenue/outstanding. It is typically
 * convertible to a real invoice later (which mints the `INV-` number).
 *
 * Two-phase lifecycle (mirrors invoice finalize, but non-fiscal): `draft` (fully
 * editable, no number, hard-deletable) → `issued` (own `PRO-` number assigned once,
 * client snapshot + line items locked). `void` reachable from any non-terminal
 * state. `convertedInvoiceId` is set by the DEFERRED convert step (see below). All
 * money is integer minor units and **server-computed** from
 * `lineItems` via `platform/money.ts` — client-sent totals are ignored.
 *
 * DEFERRED (documented): convert → real `Invoice` mints an invoice and would
 * require importing/mutating the invoices module (the field is present so the
 * wiring is additive). PDF, send/email, expiry scanner, notifications are separate
 * follow-ups.
 *
 * NAMING: the codebase invoice idiom is `finalize`/`finalized`; this module uses
 * `issue`/`issued`. The behaviour (assign number, snapshot client, lock) is
 * identical.
 */
export type ProformaStatus = "draft" | "issued" | "void";

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

export interface Proforma extends BaseDoc {
  clientId: string;
  projectId?: string | null;
  clientSnapshot?: ClientSnapshot | null;
  proformaNumber?: string | null; // assigned once, at issue (PRO-{YEAR}-{SEQ})
  currency: string;

  issueDate: string; // DateOnly (YYYY-MM-DD)
  expiryDate?: string | null; // DateOnly, optional (≥ issueDate)
  subject?: string | null; // optional short title shown above the line items

  lineItems: LineItemComputed[]; // server-computed; locked at issue

  // Server-recomputed document totals (money.ts). Never client-set. NON-FISCAL:
  // no amountPaid/amountDue — a proforma affects no balances.
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  grandTotalMinor: number;

  status: ProformaStatus;
  convertedInvoiceId?: string | null; // set by the DEFERRED convert step
  notes?: string | null;
}
