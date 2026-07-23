import { z } from "zod";
import type { ListWhitelist } from "@billy/types";
import {
  DateOnly,
  LineItemSchema,
  NonEmptyString,
  ObjectIdString,
  dueOnOrAfterIssue,
  isPositiveAmount,
} from "@billy/validation";

/**
 * Invoice Zod schemas (one schema per entity, shared by API + web). Line items
 * reuse the frozen `@billy/validation` `LineItemSchema`; the server recomputes
 * all money from them (money.ts) and never trusts client totals.
 * `dueDate ≥ issueDate` is the cross-field rule (`dueOnOrAfterIssue`).
 *
 * Create/update accept ONLY editable inputs (client, currency, dates, lineItems,
 * notes). Totals, `amountPaid`/`amountDue`, `status`, and `invoiceNumber` are
 * NEVER client-set — they are server-owned.
 */

const CurrencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/u, { message: "currency.invalid" });

const PaymentMethodSchema = z.enum([
  "bank_transfer",
  "card",
  "cash",
  "paypal",
  "stripe",
  "direct_debit",
  "other",
]);

/** Shape common to create + update. */
const invoiceShape = {
  clientId: ObjectIdString,
  /** Optional project assignment (account-scoped). */
  projectId: ObjectIdString.nullable().optional(),
  currency: CurrencyCode,
  issueDate: DateOnly,
  dueDate: DateOnly,
  /** Optional short title shown above the line items on the document. */
  subject: z.string().trim().nullable().optional(),
  lineItems: z.array(LineItemSchema).min(1, { message: "line_items.required" }),
  notes: z.string().trim().nullable().optional(),
} as const;

const refineDueDate = (data: { issueDate?: string; dueDate?: string }, ctx: z.RefinementCtx): void => {
  if (data.issueDate != null && data.dueDate != null && !dueOnOrAfterIssue(data.issueDate, data.dueDate)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dueDate"], message: "date.due_before_issue" });
  }
};

/**
 * Create payload (POST /invoices) — always a draft; no number/totals/status.
 * `bankAccountId` (optional) picks which business bank account to snapshot into
 * `bankSnapshot`; it is a settings id (NonEmptyString), NOT an ObjectId. It is
 * NOT persisted on the invoice — the service resolves it to `bankSnapshot` at
 * create then drops it.
 */
export const InvoiceCreateSchema = z
  .object({ ...invoiceShape, bankAccountId: NonEmptyString.optional() })
  .superRefine(refineDueDate);

/**
 * Update payload (PATCH /invoices/:id) — draft only (service rejects non-draft
 * with INVOICE_NOT_EDITABLE). All fields optional; `version` is the optimistic-
 * concurrency guard, also accepted via `If-Match`.
 */
/** Schedule payload (POST /invoices/:id/schedule). The worker finalizes on this date. */
export const ScheduleSchema = z.object({
  scheduledSendDate: DateOnly,
});
export type ScheduleInput = z.infer<typeof ScheduleSchema>;

export const InvoiceUpdateSchema = z
  .object({
    ...invoiceShape,
    version: z.number().int().nonnegative().optional(),
  })
  .partial()
  .superRefine(refineDueDate);

/** Add-payment payload (POST /invoices/:id/payments). Amount strictly positive. */
export const AddPaymentSchema = z
  .object({
    amountMinor: z.number().int({ message: "money.must_be_integer_minor_units" }),
    date: DateOnly,
    method: PaymentMethodSchema,
    reference: NonEmptyString.nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (!isPositiveAmount(data.amountMinor)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amountMinor"], message: "amount.must_be_positive" });
    }
  });

/**
 * createFromQuote payload (matches the quotes module's
 * `ConvertToInvoicePayload`). DIVERGENCE (flagged): quotes does not exist yet, so
 * the shape is unverified. `clientSnapshot` uses the local ClientSnapshot shape.
 */
export const ClientSnapshotSchema = z.object({
  clientId: ObjectIdString,
  displayName: NonEmptyString,
  legalName: z.string().trim().nullable().optional(),
  email: z.string().email().nullable().optional(),
  billingAddress: z.unknown().nullable().optional(),
  vatNumber: z.string().trim().nullable().optional(),
  currency: CurrencyCode,
  preferredLanguage: z.string().trim().nullable().optional(),
  referral: z.string().trim().nullable().optional(),
});

export const CreateFromQuoteSchema = z
  .object({
    quoteId: ObjectIdString,
    clientId: ObjectIdString,
    clientSnapshot: ClientSnapshotSchema,
    currency: CurrencyCode,
    lineItems: z.array(LineItemSchema).min(1, { message: "line_items.required" }),
    issueDate: DateOnly.optional(),
    dueDate: DateOnly.optional(),
    notes: z.string().trim().nullable().optional(),
  })
  .superRefine(refineDueDate);

export type InvoiceCreateInput = z.infer<typeof InvoiceCreateSchema>;
export type InvoiceUpdateInput = z.infer<typeof InvoiceUpdateSchema>;
export type AddPaymentInput = z.infer<typeof AddPaymentSchema>;
export type CreateFromQuoteInput = z.infer<typeof CreateFromQuoteSchema>;

/**
 * List query whitelist (keeps list queries index-backed).
 * Sortable/filterable/searchable fields.
 */
export const INVOICE_LIST_WHITELIST: ListWhitelist = {
  sortable: ["issueDate", "dueDate", "createdAt", "updatedAt", "grandTotalMinor", "status", "invoiceNumber"],
  filterable: ["status", "clientId", "currency", "dueDate", "issueDate", "convertedFromQuoteId"],
  searchable: ["invoiceNumber", "notes"],
};
