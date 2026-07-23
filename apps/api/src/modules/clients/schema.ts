import { z } from "zod";
import type { ListWhitelist } from "@billy/types";
import {
  Address,
  CountryCode,
  Email,
  NonEmptyString,
} from "@billy/validation";

/**
 * Client Zod schemas — one schema per entity, shared by API + web. Company vs
 * individual conditional-required fields are a cross-field rule; enforced with
 * `superRefine` so both create and update payloads validate the same way.
 * Addresses reuse the frozen `@billy/validation` Address.
 */

const ClientTypeSchema = z.enum(["company", "individual"]);

/** Shape common to create + update (all optional-at-shape; conditional rules applied via refine). */
const clientShape = {
  type: ClientTypeSchema,

  displayName: NonEmptyString,
  legalName: NonEmptyString.nullable().optional(),
  firstName: NonEmptyString.nullable().optional(),
  lastName: NonEmptyString.nullable().optional(),

  email: Email.nullable().optional(),
  phone: z.string().trim().min(1).nullable().optional(),
  website: z.string().trim().url({ message: "url.invalid" }).nullable().optional(),

  vatNumber: z.string().trim().min(1).nullable().optional(),
  taxCode: z.string().trim().min(1).nullable().optional(),
  recipientCode: z.string().trim().min(1).nullable().optional(),
  pecEmail: Email.nullable().optional(),

  billingAddress: Address.nullable().optional(),
  shippingAddress: Address.nullable().optional(),

  country: CountryCode.nullable().optional(),
  preferredCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/u, { message: "currency.invalid" })
    .nullable()
    .optional(),
  // The client's preferred language — drives the language their documents +
  // emails are rendered in (falls back to the company default, then "en").
  preferredLanguage: z.string().trim().min(2).max(5).nullable().optional(),
  // A single "First Last" contact-person name (referral / attention-of).
  referral: z.string().trim().min(1).nullable().optional(),
  paymentTermsDays: z.number().int().nonnegative().nullable().optional(),
  defaultTaxRate: z.number().nonnegative().nullable().optional(),

  notes: z.string().trim().nullable().optional(),
  tags: z.array(NonEmptyString).default([]),
} as const;

const refineByType = (data: { type?: string; legalName?: unknown; firstName?: unknown; lastName?: unknown }, ctx: z.RefinementCtx): void => {
  if (data.type === "company") {
    if (data.legalName == null || data.legalName === "") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["legalName"], message: "field.required" });
    }
  } else if (data.type === "individual") {
    if (data.firstName == null || data.firstName === "") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["firstName"], message: "field.required" });
    }
    if (data.lastName == null || data.lastName === "") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lastName"], message: "field.required" });
    }
  }
};

/** Create payload (POST /clients). `type` + display naming required per discriminator. */
export const ClientCreateSchema = z.object(clientShape).superRefine(refineByType);

/**
 * Update payload (PATCH /clients/:id). All fields optional, but if `type` is
 * present the conditional naming rule still holds. `version` carries the
 * expected optimistic-concurrency version — also accepted via the `If-Match`
 * header in the route.
 */
export const ClientUpdateSchema = z
  .object({
    ...clientShape,
    type: ClientTypeSchema.optional(),
    displayName: NonEmptyString.optional(),
    tags: z.array(NonEmptyString).optional(),
    version: z.number().int().nonnegative().optional(),
  })
  .partial()
  .superRefine((data, ctx) => {
    if (data.type !== undefined) refineByType(data, ctx);
  });

export type ClientCreateInput = z.infer<typeof ClientCreateSchema>;
export type ClientUpdateInput = z.infer<typeof ClientUpdateSchema>;

/**
 * List query whitelist — keeps list queries index-backed.
 */
export const CLIENT_LIST_WHITELIST: ListWhitelist = {
  sortable: ["displayName", "createdAt", "updatedAt", "type"],
  filterable: ["type", "country", "preferredCurrency", "tags", "email", "vatNumber"],
  searchable: ["displayName", "legalName", "firstName", "lastName", "email", "vatNumber"],
};
