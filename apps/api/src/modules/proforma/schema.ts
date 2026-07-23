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
 * Proforma Zod schemas — one schema per entity, shared by API + web. Line items
 * reuse the frozen `@billy/validation` `LineItemSchema`; the server recomputes all
 * money from them (money.ts) and never
 * trusts client totals. `expiryDate ≥ issueDate` is the cross-field rule
 * (`expiryOnOrAfterIssue`), applied when both are present.
 *
 * Create/update accept ONLY editable inputs (client, currency, dates, lineItems,
 * notes). Totals, `status`, and `proformaNumber` are NEVER client-set.
 */

const CurrencyCode = z.string().regex(/^[A-Z]{3}$/u, { message: "currency.invalid" });

/** Shape common to create + update. */
const proformaShape = {
  clientId: ObjectIdString,
  projectId: ObjectIdString.nullable().optional(),
  currency: CurrencyCode,
  issueDate: DateOnly,
  expiryDate: DateOnly.nullable().optional(),
  /** Optional short title shown above the line items on the document. */
  subject: z.string().trim().nullable().optional(),
  lineItems: z.array(LineItemSchema).min(1, { message: "line_items.required" }),
  notes: z.string().trim().nullable().optional(),
} as const;

const refineExpiry = (data: { issueDate?: string; expiryDate?: string | null }, ctx: z.RefinementCtx): void => {
  if (
    data.issueDate != null &&
    data.expiryDate != null &&
    !expiryOnOrAfterIssue(data.issueDate, data.expiryDate)
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiryDate"], message: "date.expiry_before_issue" });
  }
};

/** Create payload (POST /proformas) — always a draft; no number/totals/status. */
export const ProformaCreateSchema = z.object(proformaShape).superRefine(refineExpiry);

/**
 * Update payload (PATCH /proformas/:id) — draft only (the service rejects a
 * non-draft with INVOICE_NOT_EDITABLE). All fields optional; `version` is the
 * optimistic-concurrency guard, also accepted via `If-Match`.
 */
export const ProformaUpdateSchema = z
  .object({
    ...proformaShape,
    version: z.number().int().nonnegative().optional(),
  })
  .partial()
  .superRefine(refineExpiry);

export type ProformaCreateInput = z.infer<typeof ProformaCreateSchema>;
export type ProformaUpdateInput = z.infer<typeof ProformaUpdateSchema>;

/** Immutable client-snapshot shape (mirrors invoices). Referenced by the service. */
export const ClientSnapshotSchema = z.object({
  clientId: ObjectIdString,
  displayName: NonEmptyString,
  legalName: z.string().trim().nullable().optional(),
  email: z.string().email().nullable().optional(),
  billingAddress: z.unknown().nullable().optional(),
  vatNumber: z.string().trim().nullable().optional(),
  currency: CurrencyCode,
});

/**
 * List query whitelist (keeps list queries index-backed).
 */
export const PROFORMA_LIST_WHITELIST: ListWhitelist = {
  sortable: ["issueDate", "expiryDate", "createdAt", "updatedAt", "grandTotalMinor", "status", "proformaNumber"],
  filterable: ["status", "clientId", "currency", "issueDate", "convertedInvoiceId"],
  searchable: ["proformaNumber", "notes"],
};
