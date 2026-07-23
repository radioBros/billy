import type { BaseDoc } from "@billy/types";

/**
 * Expense entity. Models the narrowed
 * field set: money as a single `amountMinor`
 * (integer minor units) in the document `currency`, plus
 * the client-billing axis (`billable` → `invoiceId`). All other entities are
 * referenced by string id only. Receipt attachments are OUT OF SCOPE.
 * `version` + `deletedAt` come from BaseDoc.
 */

/**
 * Expense status. NOTE: no shared Expense status enum exists, so
 * it is defined locally and kept minimal. The invoiced fact is durable on
 * `invoiceId`; status is a display convenience, never the guard source.
 */
export const EXPENSE_STATUSES = ["draft", "invoiced"] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export interface Expense extends BaseDoc {
  amountMinor: number; // Money — integer minor units, in `currency`. Server-authoritative.
  currency: string; // ISO 4217
  category: string;
  date: string; // DateOnly (YYYY-MM-DD) — expense date
  vendor: string;
  description: string;
  clientId?: string; // other entities referenced by string id only
  projectId?: string | null;
  billable: boolean;
  status: ExpenseStatus;
  invoicedAt?: string | null; // UTC ISO — set when added to an invoice
  invoiceId?: string | null; // draft-invoice reference; presence = invoiced
}
