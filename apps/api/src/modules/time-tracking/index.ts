/** time-tracking module barrel. */
export { createTimeTrackingRouter } from "@/modules/time-tracking/routes.js";
export { TIME_ENTRIES_COLLECTION, TimeEntryRepository } from "@/modules/time-tracking/repository.js";
export { TimeEntryService } from "@/modules/time-tracking/service.js";
export type { TimeEntry, TimerState } from "@/modules/time-tracking/types.js";
