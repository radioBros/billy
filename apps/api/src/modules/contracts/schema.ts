import { z } from "zod";
import { DateOnly, Money, NonEmptyString, ObjectIdString, endOnOrAfterStart } from "@billy/validation";
import type { ListWhitelist } from "@billy/types";

/**
 * Contract Zod schemas. One shared schema, imported by API + web. Cross-field
 * rule: `endDate` ≥ `startDate` via `endOnOrAfterStart` — enforced with
 * `.refine`, failing key
 * `endDate` (→ VALIDATION_FAILED / DATE_RANGE_INVALID surfaced by details map).
 * Money (`valueMinor`) is integer minor units; server owns it, client shape only.
 */

const ContractTypeSchema = z.enum([
  "development",
  "maintenance",
  "hosting",
  "support",
  "consulting",
  "service_agreement",
  "retainer",
  "other",
]);

/** Currency: ISO 4217 alpha-3. */
const Currency = z.string().regex(/^[A-Z]{3}$/u, { message: "currency.invalid" });

/**
 * Create payload. `status` is NOT client-settable on create — a new contract is
 * always `draft`; lifecycle moves happen through the guarded actions. `endDate`
 * ≥ `startDate`. Financial pair kept together: `valueMinor` + `currency`.
 */
export const ContractCreateSchema = z
  .object({
    clientId: ObjectIdString,
    projectId: ObjectIdString.nullable().optional(),
    title: NonEmptyString,
    type: ContractTypeSchema,
    startDate: DateOnly,
    endDate: DateOnly.nullable().optional(),
    valueMinor: Money.nullable().optional(),
    currency: Currency.nullable().optional(),
    relatedRecurringProfileId: ObjectIdString.nullable().optional(),
    fileId: ObjectIdString.nullable().optional(),
    terms: z.string().trim().nullable().optional(),
    notes: z.string().trim().nullable().optional(),
  })
  .refine((v) => endOnOrAfterStart(v.startDate, v.endDate), {
    message: "date.end_before_start",
    path: ["endDate"],
  });

export type ContractCreateInput = z.infer<typeof ContractCreateSchema>;

/**
 * Update payload — all fields optional; `version` carries optimistic concurrency
 * (also acceptable via If-Match). `endDate` ≥ `startDate`
 * enforced only when both are present in the patch.
 */
export const ContractUpdateSchema = z
  .object({
    projectId: ObjectIdString.nullable().optional(),
    title: NonEmptyString.optional(),
    type: ContractTypeSchema.optional(),
    startDate: DateOnly.optional(),
    endDate: DateOnly.nullable().optional(),
    valueMinor: Money.nullable().optional(),
    currency: Currency.nullable().optional(),
    relatedRecurringProfileId: ObjectIdString.nullable().optional(),
    fileId: ObjectIdString.nullable().optional(),
    terms: z.string().trim().nullable().optional(),
    notes: z.string().trim().nullable().optional(),
    version: z.number().int().nonnegative().optional(),
  })
  .refine(
    (v) => v.startDate == null || v.endDate === undefined || endOnOrAfterStart(v.startDate, v.endDate),
    { message: "date.end_before_start", path: ["endDate"] },
  );

export type ContractUpdateInput = z.infer<typeof ContractUpdateSchema>;

/** Renew payload — new term dates. `newEndDate` ≥ `newStartDate`. */
export const ContractRenewSchema = z
  .object({
    newStartDate: DateOnly,
    newEndDate: DateOnly.nullable().optional(),
    version: z.number().int().nonnegative().optional(),
  })
  .refine((v) => endOnOrAfterStart(v.newStartDate, v.newEndDate), {
    message: "date.end_before_start",
    path: ["newEndDate"],
  });

export type ContractRenewInput = z.infer<typeof ContractRenewSchema>;

/** Whitelisted query fields — keeps list queries index-backed. */
export const CONTRACT_LIST_WHITELIST: ListWhitelist = {
  sortable: ["startDate", "endDate", "createdAt", "updatedAt", "status", "type", "title"],
  filterable: ["status", "type", "clientId", "startDate", "endDate"],
  searchable: ["title", "notes"],
};
