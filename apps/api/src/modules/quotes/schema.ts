import { z } from "zod";
import type { ListWhitelist } from "@billy/types";
import {
  DateOnly,
  LineItemSchema,
  NonEmptyString,
  ObjectIdString,
  expiryOnOrAfterIssue,
} from "@billy/validation";

/**
 * Quote Zod schemas — one schema per entity,
 * shared by API + web. Line items reuse the frozen `@billy/validation`
 * LineItemSchema; monetary totals are NEVER accepted from the client
 * — they are absent from the shape, so Zod strips any client-sent totals and the
 * service recomputes them via `computeDocumentTotals`. The `expiryDate ≥ issueDate`
 * cross-field rule uses the shared `expiryOnOrAfterIssue` predicate.
 */

const CurrencyCode = z.string().regex(/^[A-Z]{3}$/u, { message: "currency.invalid" });

/** Shape common to create + update. Totals intentionally excluded — server-computed. */
const quoteShape = {
  clientId: ObjectIdString,
  projectId: ObjectIdString.nullable().optional(),
  currency: CurrencyCode,
  issueDate: DateOnly,
  expiryDate: DateOnly,
  /** Optional short title shown above the line items on the document. */
  subject: z.string().trim().nullable().optional(),
  lineItems: z.array(LineItemSchema).min(1, { message: "field.required" }),
  notes: z.string().trim().nullable().optional(),
} as const;

/** Create payload (POST /quotes). */
export const QuoteCreateSchema = z
  .object(quoteShape)
  .superRefine((data, ctx) => {
    if (!expiryOnOrAfterIssue(data.issueDate, data.expiryDate)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiryDate"], message: "date.expiry_before_issue" });
    }
  });

/**
 * Update payload (PATCH /quotes/:id). All fields optional; the expiry rule is
 * re-checked only when BOTH dates are present. `version` carries the expected
 * optimistic-concurrency version — also accepted via `If-Match`.
 */
export const QuoteUpdateSchema = z
  .object({
    ...quoteShape,
    version: z.number().int().nonnegative().optional(),
  })
  .partial()
  .superRefine((data, ctx) => {
    if (data.issueDate != null && data.expiryDate != null && !expiryOnOrAfterIssue(data.issueDate, data.expiryDate)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiryDate"], message: "date.expiry_before_issue" });
    }
  });

export type QuoteCreateInput = z.infer<typeof QuoteCreateSchema>;
export type QuoteUpdateInput = z.infer<typeof QuoteUpdateSchema>;

/**
 * List query whitelist — keeps list queries index-backed.
 * Sortable/filterable/searchable fields.
 */
export const QUOTE_LIST_WHITELIST: ListWhitelist = {
  sortable: ["createdAt", "updatedAt", "issueDate", "expiryDate", "grandTotalMinor", "status", "quoteNumber"],
  filterable: ["status", "clientId", "currency", "issueDate", "expiryDate"],
  searchable: ["quoteNumber", "notes"],
};
