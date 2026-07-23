import { z } from "zod";
import { DateOnly, Money, NonEmptyString, ObjectIdString, isNonNegativeDuration } from "@billy/validation";
import type { ListWhitelist } from "@billy/types";

/**
 * TimeEntry Zod schemas. Validation proves SHAPE only;
 * the service owns money recompute, timer math, and authority.
 * `durationMinutes` uses the `isNonNegativeDuration` refinement.
 */

const durationMinutes = z
  .number()
  .refine(isNonNegativeDuration, { message: "duration.must_be_non_negative_integer" });

/** POST /time-entries — manual entry. `userId`/timer fields are server-owned, never accepted here. */
export const TimeEntryCreateSchema = z.object({
  clientId: ObjectIdString.optional(),
  projectId: ObjectIdString.optional(),
  description: NonEmptyString,
  date: DateOnly,
  durationMinutes: durationMinutes.default(0),
  billable: z.boolean().default(true),
  rateMinor: Money.optional(),
});

/** PATCH /time-entries/:id — partial; `version` carried separately via If-Match/body. */
export const TimeEntryUpdateSchema = z
  .object({
    clientId: ObjectIdString.nullable(),
    projectId: ObjectIdString.nullable(),
    description: NonEmptyString,
    date: DateOnly,
    durationMinutes,
    billable: z.boolean(),
    rateMinor: Money.nullable(),
  })
  .partial();

/** POST /timer/start — optional metadata for the newly-created running entry. */
export const TimerStartSchema = z.object({
  clientId: ObjectIdString.optional(),
  projectId: ObjectIdString.optional(),
  description: NonEmptyString.optional(),
  date: DateOnly.optional(),
  billable: z.boolean().optional(),
  rateMinor: Money.optional(),
});

/** POST /timer/{stop,pause,resume} — targets an entry by id. */
export const TimerActionSchema = z.object({
  id: ObjectIdString,
});

/** POST /time-entries/:id/mark-billed — links the entry to a created invoice. */
export const MarkBilledSchema = z.object({
  invoiceId: ObjectIdString,
});

export type TimeEntryCreateInput = z.infer<typeof TimeEntryCreateSchema>;
export type TimeEntryUpdateInput = z.infer<typeof TimeEntryUpdateSchema>;
export type TimerStartInput = z.infer<typeof TimerStartSchema>;
export type TimerActionInput = z.infer<typeof TimerActionSchema>;
export type MarkBilledInput = z.infer<typeof MarkBilledSchema>;

/** Index-backed list grammar whitelist. */
export const TIME_ENTRY_LIST_WHITELIST: ListWhitelist = {
  sortable: ["date", "createdAt", "updatedAt", "durationMinutes", "billable", "billed"],
  filterable: ["date", "clientId", "projectId", "userId", "billable", "billed", "invoiceId", "timerState"],
  searchable: ["description"],
};
