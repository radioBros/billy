import { z } from "zod";
import { NonEmptyString } from "@billy/validation";

/**
 * Account Zod schemas. Validation proves SHAPE only; the service owns slug
 * derivation/uniqueness and the destructive delete flow. Sysadmin-only surface.
 */

/** URL-safe slug: lowercase letters, digits, hyphens; 2–48 chars. */
const Slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/u, { message: "slug.invalid" })
  .min(2)
  .max(48);

export const AccountCreateSchema = z.object({
  name: NonEmptyString,
  /** Optional — derived from name when omitted. */
  slug: Slug.optional(),
  note: z.string().trim().nullable().optional(),
  /** First account admin to create alongside the account. */
  admin: z
    .object({
      email: z.string().trim().toLowerCase().email({ message: "email.invalid" }),
      displayName: NonEmptyString,
      password: z.string().min(8, { message: "password.tooShort" }).max(200),
    })
    .optional(),
});

export const AccountUpdateSchema = z
  .object({
    name: NonEmptyString,
    slug: Slug,
    note: z.string().trim().nullable(),
    status: z.enum(["active", "suspended"]),
  })
  .partial();

/**
 * Destructive delete confirmation. The client must echo the EXACT account name
 * and re-supply the sysadmin's password (verified server-side). This is the
 * secure multi-step guard for an irreversible full-data wipe.
 */
export const AccountDeleteSchema = z.object({
  confirmName: NonEmptyString,
  password: NonEmptyString,
});

export type AccountCreateInput = z.infer<typeof AccountCreateSchema>;
export type AccountUpdateInput = z.infer<typeof AccountUpdateSchema>;
export type AccountDeleteInput = z.infer<typeof AccountDeleteSchema>;
