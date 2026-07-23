import { z } from "zod";
import type { ListWhitelist } from "@billy/types";
import { DateOnly, LineItemSchema, ObjectIdString } from "@billy/validation";

/**
 * RecurringProfile Zod schemas — one
 * schema per entity, shared by API + web. Line items reuse the frozen
 * `@billy/validation` `LineItemSchema`; the server recomputes all money from them
 * (money.ts) and never trusts client totals.
 *
 * Create/update accept ONLY editable inputs (client, currency, cadence, dates,
 * limits, line items, notes). `nextRunAt`, totals, `occurrencesGenerated`,
 * `lastRunAt`, `createdInvoiceIds`, and `status` are server-owned.
 */

const CurrencyCode = z.string().regex(/^[A-Z]{3}$/u, { message: "currency.invalid" });

const IntervalSchema = z.enum(["weekly", "monthly", "quarterly", "yearly"]);

/** The document type a recurring profile generates. Recurring is a PROPERTY of a
 *  document (invoice/proforma/expense), not a standalone type — the worker tick
 *  branches on this to write the right doc. Defaults to `invoice` (back-compat). */
export const RecurringDocumentTypeSchema = z.enum(["invoice", "proforma", "expense"]);
export type RecurringDocumentType = z.infer<typeof RecurringDocumentTypeSchema>;

/** Shape common to create + update. */
const profileShape = {
  clientId: ObjectIdString,
  currency: CurrencyCode,
  documentType: RecurringDocumentTypeSchema.default("invoice"),
  interval: IntervalSchema,
  intervalCount: z.number().int().min(1, { message: "interval_count.must_be_positive" }),
  /** Optional "every Nth of month" anchor (1–31) for monthly-family intervals. */
  dayOfMonth: z.number().int().min(1).max(31, { message: "day_of_month.out_of_range" }).nullable().optional(),
  startDate: DateOnly,
  endDate: DateOnly.nullable().optional(),
  maxOccurrences: z.number().int().positive().nullable().optional(),
  lineItems: z.array(LineItemSchema).min(1, { message: "line_items.required" }),
  /** Optional subject copied onto each generated document (above line items). */
  subject: z.string().trim().nullable().optional(),
  notes: z.string().trim().nullable().optional(),
} as const;

const refineDates = (
  data: { startDate?: string; endDate?: string | null; interval?: string; dayOfMonth?: number | null },
  ctx: z.RefinementCtx,
): void => {
  if (data.startDate != null && data.endDate != null && data.endDate < data.startDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endDate"], message: "date.end_before_start" });
  }
  // A day-of-month anchor only makes sense for monthly-family cadences.
  if (data.dayOfMonth != null && data.interval === "weekly") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dayOfMonth"], message: "day_of_month.weekly_not_allowed" });
  }
};

/** Create payload (POST /recurring-profiles) — profile starts `active`; nextRunAt = startDate. */
export const RecurringProfileCreateSchema = z.object(profileShape).superRefine(refineDates);

/**
 * Update payload (PATCH /:id). All fields optional; `version` is the optimistic-
 * concurrency guard, also accepted via `If-Match`.
 */
export const RecurringProfileUpdateSchema = z
  .object({
    ...profileShape,
    version: z.number().int().nonnegative().optional(),
  })
  .partial()
  .superRefine(refineDates);

export type RecurringProfileCreateInput = z.infer<typeof RecurringProfileCreateSchema>;
export type RecurringProfileUpdateInput = z.infer<typeof RecurringProfileUpdateSchema>;

/**
 * List query whitelist — keeps list queries index-backed.
 * `nextRunAt`/`status` are the scheduler's scan fields.
 */
export const RECURRING_PROFILE_LIST_WHITELIST: ListWhitelist = {
  sortable: ["nextRunAt", "startDate", "endDate", "createdAt", "updatedAt", "status", "grandTotalMinor"],
  filterable: ["status", "clientId", "currency", "interval", "nextRunAt", "startDate", "endDate"],
  searchable: ["notes"],
};
