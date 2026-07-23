import { z } from "zod";
import { Money, DateOnly, NonEmptyString, ObjectIdString, isPositiveAmount } from "@billy/validation";
import type { ListWhitelist } from "@billy/types";

/**
 * Expense Zod schemas (one schema per entity, shared with
 * the web). Validation proves SHAPE only; the service recomputes/authorizes the
 * server-side amount. `amountMinor` must be a positive integer in
 * minor units — the `Money` primitive itself permits negatives (credit notes),
 * so the create/update schemas add the `isPositiveAmount` refinement.
 */

const positiveAmount = Money.refine(isPositiveAmount, {
  message: "money.must_be_positive_minor_units",
});

/** ISO 4217 — 3 upper-case letters. */
const Currency = z.string().regex(/^[A-Z]{3}$/u, { message: "currency.invalid" });

export const ExpenseCreateSchema = z.object({
  amountMinor: positiveAmount,
  currency: Currency,
  category: NonEmptyString,
  date: DateOnly,
  vendor: NonEmptyString,
  projectId: ObjectIdString.nullable().optional(),
  description: z.string().trim().default(""),
  clientId: ObjectIdString.optional(),
  billable: z.boolean().default(false),
});
export type ExpenseCreateInput = z.infer<typeof ExpenseCreateSchema>;

/** PATCH — all mutable fields optional; `version` carries optimistic concurrency. */
export const ExpenseUpdateSchema = z
  .object({
    amountMinor: positiveAmount,
    currency: Currency,
    category: NonEmptyString,
    date: DateOnly,
    vendor: NonEmptyString,
    description: z.string().trim(),
    clientId: ObjectIdString.nullable(),
    projectId: ObjectIdString.nullable(),
    billable: z.boolean(),
    version: z.number().int().nonnegative(),
  })
  .partial()
  .extend({ version: z.number().int().nonnegative() });
export type ExpenseUpdateInput = z.infer<typeof ExpenseUpdateSchema>;

/** mark-invoiced body — the draft invoice to attach to + optimistic version. */
export const ExpenseMarkInvoicedSchema = z.object({
  invoiceId: ObjectIdString,
  version: z.number().int().nonnegative(),
});
export type ExpenseMarkInvoicedInput = z.infer<typeof ExpenseMarkInvoicedSchema>;

/**
 * Whitelisted list fields — keeps queries index-backed.
 * Sort/filter cover the primary date, category, client, billable, status, amount.
 */
export const EXPENSE_LIST_WHITELIST: ListWhitelist = {
  sortable: ["date", "category", "amountMinor", "createdAt", "updatedAt"],
  filterable: ["category", "clientId", "billable", "status", "currency", "date", "invoiceId"],
  searchable: ["vendor", "description", "category"],
};
