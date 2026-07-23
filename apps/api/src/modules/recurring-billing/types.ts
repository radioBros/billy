import type { BaseDoc } from "@billy/types";
import type { LineItemComputed, LineItemInput } from "@/platform/money.js";

/**
 * RecurringProfile entity. A profile
 * is the *template* the scheduler reads to generate invoices; issued invoices are
 * independent snapshot copies, so later profile edits never
 * mutate past invoices.
 *
 * Money is server-computed from `lineItems` via `platform/money.ts` —
 * client totals are ignored. `nextRunAt` is advanced by the PURE `advanceDate`
 * (service.ts) with a month-end clamp; the scheduler queries
 * `status=active AND nextRunAt<=now`.
 *
 * Lifecycle status: a profile is created
 * `active` (there is no `draft`), and moves active⇄paused, then
 * →completed (exhausted via endDate/maxOccurrences) or →cancelled.
 */
export type RecurringInterval = "weekly" | "monthly" | "quarterly" | "yearly";

export type RecurringProfileStatus = "active" | "paused" | "completed" | "cancelled";

export interface RecurringProfile extends BaseDoc {
  clientId: string;
  /** Which document type each occurrence generates (invoice/proforma/expense).
   *  Recurring is a property of a document, not a standalone type. */
  documentType: "invoice" | "proforma" | "expense";
  /** Template line items; server-computed money (money.ts). Copied (raw) into each generated doc. */
  lineItems: LineItemComputed[];
  currency: string;

  interval: RecurringInterval;
  /** Steps per advance, ≥ 1 (e.g. `interval=monthly, intervalCount=2` → every 2 months). */
  intervalCount: number;
  /**
   * Optional day-of-month ANCHOR (1–31) for monthly-family intervals: "every Nth
   * of the month" (e.g. 1 → every 1st, 15 → every 15th). Each advance lands on
   * this day (clamped to the month length, drift-free — see shared
   * `advanceRecurrence`). Ignored for weekly. Absent ⇒ advance preserves the
   * start day.
   */
  dayOfMonth?: number | null;

  startDate: string; // DateOnly (YYYY-MM-DD)
  /** Next occurrence date the scheduler will generate; advanced by `advanceDate`. */
  nextRunAt: string; // DateOnly
  endDate?: string | null; // DateOnly — no occurrence scheduled after this
  maxOccurrences?: number | null; // stop after N generated

  occurrencesGenerated: number;
  status: RecurringProfileStatus;
  lastRunAt?: string | null; // DateOnly of the last generated occurrence
  createdInvoiceIds: string[]; // appended by the jobs layer once invoices are created

  // Server-recomputed document totals (money.ts). Never client-set.
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  grandTotalMinor: number;

  subject?: string | null;
  notes?: string | null;
}

/**
 * Draft payload returned by `generateOccurrence`. The recurring
 * module does NOT import invoices; the jobs layer feeds this to the invoices
 * service (create → finalize → send) so numbering + snapshot + immutability are
 * enforced in one place. `lineItems` are the RAW inputs (not computed `*Minor`
 * fields) so the invoices service recomputes them.
 */
export interface InvoiceDraftPayload {
  clientId: string;
  currency: string;
  lineItems: LineItemInput[];
  sourceRecurringProfileId: string;
  issueDate: string; // DateOnly — the occurrence date
}

// Occurrence records + state machine (scheduled→generating→generated/failed),
//   auto actions (finalize/send), failure log + BullMQ retry, `/history`, and the
//   cron scan (nextRunAt<=now) are wired in the jobs layer, not in this module.
