import type { BaseDoc } from "@billy/types";

/**
 * TimeEntry entity. Field list is the
 * simplified shape: durations are stored as **minutes**
 * (non-negative integer) and the running/paused timer is modelled directly on
 * the entry via `timerState` + `timerStartedAt` — no separate timer collection.
 *
 * `userId` is server-set from `ctx.authContext.userId` at insert (never
 * client-supplied). It is required to enforce "one running timer per user"
 * — the accountId-based repository scoping cannot express per-user
 * ownership in this single-tenant build, so ownership lives on the document.
 *
 * Cross-module references are plain string ids (clientId, projectId, invoiceId)
 * — those entities belong to other modules.
 */
export type TimerState = "running" | "paused" | null;

export interface TimeEntry extends BaseDoc {
  /** Owner — server-set from the auth context; enforces one-running-timer-per-user. */
  userId: string;
  clientId?: string;
  projectId?: string;
  description: string;
  /** Calendar date `YYYY-MM-DD` (business day of the entry). */
  date: string;
  /** Server-authoritative elapsed minutes (non-negative integer). */
  durationMinutes: number;
  billable: boolean;
  /** Hourly rate in integer minor units (financial — stripped when not permitted). */
  rateMinor?: number;
  billed: boolean;
  invoiceId?: string | null;
  /** UTC ISO timestamp the current running segment started; null when not running. */
  timerStartedAt?: string | null;
  timerState?: TimerState;
}

/** Financial fields stripped from responses when the caller lacks canViewFinancialTotals. */
export const TIME_ENTRY_FINANCIAL_FIELDS = ["rateMinor"] as const;
