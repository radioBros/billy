import { z } from "zod";
import type { ListWhitelist } from "@billy/types";
import { LineItemSchema, NonEmptyString, ObjectIdString, DateOnly } from "@billy/validation";

/**
 * CreditNote Zod schemas (one schema per entity, shared by API + web). Line
 * items reuse the frozen
 * `@billy/validation` `LineItemSchema`; the server recomputes all money from them
 * (money.ts) and never trusts client totals.
 *
 * Create/update accept ONLY editable inputs (credited invoice, client, currency,
 * date, lineItems, reason, notes). Totals, `status`, and `creditNoteNumber` are
 * NEVER client-set — they are server-owned.
 */

const CurrencyCode = z.string().regex(/^[A-Z]{3}$/u, { message: "currency.invalid" });

/** Shape common to create + update. */
const creditNoteShape = {
  clientId: ObjectIdString,
  projectId: ObjectIdString.nullable().optional(),
  creditedInvoiceId: ObjectIdString,
  currency: CurrencyCode,
  issueDate: DateOnly,
  /** Optional short title shown above the line items on the document. */
  subject: z.string().trim().nullable().optional(),
  lineItems: z.array(LineItemSchema).min(1, { message: "line_items.required" }),
  reason: z.string().trim().nullable().optional(),
  notes: z.string().trim().nullable().optional(),
} as const;

/** Create payload (POST /credit-notes) — always a draft; no number/totals/status. */
export const CreditNoteCreateSchema = z.object(creditNoteShape);

/**
 * Update payload (PATCH /credit-notes/:id) — draft only (the service rejects a
 * non-draft with INVOICE_NOT_EDITABLE). All fields optional; `version` is the
 * optimistic-concurrency guard, also accepted via `If-Match`.
 */
export const CreditNoteUpdateSchema = z
  .object({
    ...creditNoteShape,
    version: z.number().int().nonnegative().optional(),
  })
  .partial();

export type CreditNoteCreateInput = z.infer<typeof CreditNoteCreateSchema>;
export type CreditNoteUpdateInput = z.infer<typeof CreditNoteUpdateSchema>;

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
 * Defines the sortable/filterable/searchable fields.
 */
export const CREDIT_NOTE_LIST_WHITELIST: ListWhitelist = {
  sortable: ["issueDate", "createdAt", "updatedAt", "grandTotalMinor", "status", "creditNoteNumber"],
  filterable: ["status", "clientId", "currency", "creditedInvoiceId", "issueDate"],
  searchable: ["creditNoteNumber", "creditedInvoiceNumber", "reason", "notes"],
};
