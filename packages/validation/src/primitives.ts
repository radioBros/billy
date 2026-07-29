import { z } from "zod";

/**
 * Shared Zod primitives. Authored ONCE, imported
 * by both the Koa API and the Vue web app. This package stays
 * dependency-pure (zod + @billy/types) so it bundles cleanly on the web too —
 * no node-only imports. Messages are i18n keys, never raw strings.
 * Backend maps failures to VALIDATION_FAILED.
 */

/** Money = integer minor units. Refuses floats/strings. May be negative (credit notes). */
export const Money = z.number().int({ message: "money.must_be_integer_minor_units" });

/** Calendar date, `YYYY-MM-DD` (lexicographically comparable). */
export const DateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, { message: "date.invalid_format" });

/** UTC ISO-8601 timestamp. */
export const Timestamp = z.string().datetime({ message: "timestamp.invalid" });

/** Mongo ObjectId as a 24-char hex string. */
export const ObjectIdString = z
  .string()
  .regex(/^[0-9a-f]{24}$/iu, { message: "id.invalid" });

/** Email — normalized to lowercase. */
export const Email = z
  .string()
  .email({ message: "email.invalid" })
  .transform((s) => s.toLowerCase());

export const NonEmptyString = z.string().trim().min(1, { message: "field.required" });

/** ISO-3166-1 alpha-2 country code. */
export const CountryCode = z
  .string()
  .regex(/^[A-Z]{2}$/u, { message: "country.invalid" });

/**
 * Base address. The definitive per-client field
 * list lives in the clients module, which refines this shape there.
 */
export const Address = z.object({
  line1: NonEmptyString,
  line2: z.string().trim().optional(),
  city: NonEmptyString,
  region: z.string().trim().optional(),
  postalCode: NonEmptyString,
  country: CountryCode,
});

export type AddressInput = z.infer<typeof Address>;
