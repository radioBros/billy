import type { BaseDoc } from "@billy/types";

/**
 * Subscription entity. Tracks the
 * business's own recurring outgoing costs (domains, VPS, licenses,...).
 *
 * This module uses a deliberately simplified shape: `amountMinor` (not `amount`),
 * `nextBillingDate` (not `nextPaymentDate`), a single `interval` enum (rather than
 * separate `billingFrequency`/`intervalCount`/`intervalUnit`), `plan` (not `type`),
 * and a three-value `status`.
 *
 * Money is integer minor units; the document carries a
 * single `currency`, so `amountMinor` is a bare integer in that currency.
 * Cross-module relations are stored by string id (no embedded documents).
 */

/** Billing cadence. Every value MUST be handled by `advanceBillingDate`. */
export type SubscriptionInterval = "weekly" | "monthly" | "quarterly" | "yearly";

/** Lifecycle status (3-value set). `archived` is orthogonal (`archivedAt`). */
export type SubscriptionStatus = "active" | "paused" | "cancelled";

export interface Subscription extends BaseDoc {
 /** Owning client (cross-module reference by string id). Optional — a
 * subscription need not be bound to a client. */
  clientId?: string | null;
  projectId?: string | null;
  name: string;
  plan: string;
 /** Integer minor units, interpreted in `currency`. */
  amountMinor: number;
 /** ISO 4217. */
  currency: string;
  interval: SubscriptionInterval;
  status: SubscriptionStatus;
 /** `YYYY-MM-DD` — first billing day. */
  startDate: string;
 /** `YYYY-MM-DD` — next day a payment is due. */
  nextBillingDate: string;
 /** UTC ISO timestamp of the last recorded payment, or null. */
  lastPaidAt?: string | null;
 /** Optional link to the vendor/service (e.g. the billing portal). */
  url?: string | null;
 /** Optional free-text note. */
  note?: string | null;
}

/** Financial fields stripped from responses without `canViewFinancialTotals`. */
export const SUBSCRIPTION_FINANCIAL_FIELDS = ["amountMinor"] as const;
