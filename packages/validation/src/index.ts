import { z } from "zod";
import { Timestamp, ObjectIdString, Money, NonEmptyString } from "./primitives.js";

export * from "./primitives.js";
export * from "./refinements.js";

/**
 * Canonical line-item schema shared by quotes, invoices,
 * and recurring profiles. Money fields are integer minor units; the server
 * recomputes `lineSubtotal`/`lineTax`/`lineTotal` from these (never trusts client
 * totals) via `apps/api/src/platform/money.ts`.
 */
export const LineItemSchema = z.object({
  description: NonEmptyString,
  quantity: z.number().positive({ message: "quantity.must_be_positive" }),
  unitPriceMinor: Money,
  discountRate: z.number().min(0).max(100).optional(),
  taxRate: z.number().min(0).max(100).optional(),
});
export type LineItemSchemaType = z.infer<typeof LineItemSchema>;

/**
 * Base document mixin schema. Per-entity schemas extend
 * this. `z.infer` here matches `BaseDoc` in @billy/types (types are derived from
 * schemas, never hand-written).
 */
export const BaseDocSchema = z.object({
  id: ObjectIdString,
  version: z.number().int().nonnegative(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  archivedAt: Timestamp.nullable().optional(),
  deletedAt: Timestamp.nullable().optional(),
});

/**
 * Framework-agnostic Zod-error formatter → `{ "field.path": messageKey }`
 * (the error `details`). The backend wraps this in a
 * `VALIDATION_FAILED` AppError; the web binds the same keys to form fields.
 * Pure — no server/AppError dependency, so this package bundles on the web.
 */
export function formatZodError(error: z.ZodError): Record<string, string> {
  const details: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_root";
    if (!(key in details)) details[key] = issue.message;
  }
  return details;
}

/** Parse helper returning a discriminated result (no throw) for pure consumers. */
export function safeValidate<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
): { ok: true; value: z.infer<T> } | { ok: false; details: Record<string, string> } {
  const r = schema.safeParse(data);
  return r.success ? { ok: true, value: r.data } : { ok: false, details: formatZodError(r.error) };
}
