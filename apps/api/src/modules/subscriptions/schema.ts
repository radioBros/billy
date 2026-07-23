import { z } from "zod";
import type { ListWhitelist } from "@billy/types";
import { Money, DateOnly, ObjectIdString, NonEmptyString } from "@billy/validation";

/**
 * Subscription Zod schemas. One schema authored here,
 * shared by API + web. Validation proves SHAPE only; the service owns money +
 * transitions + date advancement.
 *
 * No-secrets constraint: this simplified shape carries
 * no credential-shaped fields (no password / SSH key / API key / accountReference).
 */

export const SUBSCRIPTION_INTERVALS = ["weekly", "monthly", "quarterly", "yearly"] as const;
export const SUBSCRIPTION_STATUSES = ["active", "paused", "cancelled"] as const;

/** ISO 4217 alpha-3, upper-case. */
const Currency = z.string().regex(/^[A-Z]{3}$/u, { message: "currency.invalid" });

export const SubscriptionCreateSchema = z
  .object({
    clientId: ObjectIdString.nullable().optional(),
    projectId: ObjectIdString.nullable().optional(),
    name: NonEmptyString,
    plan: NonEmptyString,
    amountMinor: Money.refine((n) => n > 0, { message: "money.must_be_positive" }),
    currency: Currency,
    interval: z.enum(SUBSCRIPTION_INTERVALS),
    startDate: DateOnly,
    nextBillingDate: DateOnly,
    url: z.string().trim().url({ message: "url.invalid" }).nullable().optional(),
    note: z.string().trim().nullable().optional(),
  })
  .strict()
  .refine((v) => v.nextBillingDate >= v.startDate, {
    message: "date.next_billing_before_start",
    path: ["nextBillingDate"],
  });

/** Partial update — status changes go through the dedicated action routes. */
export const SubscriptionUpdateSchema = z
  .object({
    name: NonEmptyString,
    plan: NonEmptyString,
    amountMinor: Money.refine((n) => n > 0, { message: "money.must_be_positive" }),
    currency: Currency,
    interval: z.enum(SUBSCRIPTION_INTERVALS),
    startDate: DateOnly,
    nextBillingDate: DateOnly,
    url: z.string().trim().url({ message: "url.invalid" }).nullable().optional(),
    note: z.string().trim().nullable().optional(),
  })
  .strict()
  .partial();

export type SubscriptionCreateInput = z.infer<typeof SubscriptionCreateSchema>;
export type SubscriptionUpdateInput = z.infer<typeof SubscriptionUpdateSchema>;

/** Whitelisted sort/filter/search fields — keeps queries index-backed. */
export const SUBSCRIPTION_LIST_WHITELIST: ListWhitelist = {
  sortable: ["createdAt", "updatedAt", "name", "nextBillingDate", "startDate", "status", "amountMinor"],
  filterable: ["status", "interval", "clientId", "currency", "nextBillingDate"],
  searchable: ["name", "plan"],
};
