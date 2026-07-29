// -----------------------------------------------------------------------------
// Recurrence date math — the SINGLE source of truth for advancing a recurring
// profile's next-run date. Lives in @billy/shared because the worker cannot
// import api modules; both the api recurring-billing service and the worker
// generator consume this one pure function (previously two hand-synced copies).
//
// Optional day-of-month ANCHOR ("every 1st", "every 15th", "every 31st"):
//   - When `dayOfMonth` is set on a monthly-family interval, each advance lands
//     on that day of the target month, clamped to the month length.
//   - ANCHOR-DRIFT FIX: the target day is re-derived from the STORED `dayOfMonth`
//     every cycle, NOT from the previous occurrence's day. So a 31st schedule
//     goes Jan 31 → Feb 28 → Mar 31 (recovers), never Feb 28 → Mar 28 (drift).
// -----------------------------------------------------------------------------

export type RecurringInterval = "weekly" | "monthly" | "quarterly" | "yearly";

const pad = (n: number): string => String(n).padStart(2, "0");

/** Days in a 1-indexed month (month1: 1..12). */
export const daysInMonth = (year: number, month1: number): number =>
  new Date(Date.UTC(year, month1, 0)).getUTCDate();

const fmt = (y: number, m1: number, d: number): string => `${y}-${pad(m1)}-${pad(d)}`;

const parseDateOnly = (dateOnly: string): [number, number, number] => {
  const parts = dateOnly.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (parts.length !== 3 || !Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    throw new Error(`Invalid date: ${dateOnly}`);
  }
  return [y, m, d];
};

const addDays = (y: number, m: number, d: number, days: number): string => {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};

/**
 * Add `months` to (y, m, d). If `anchorDay` is given, the result day is
 * `min(anchorDay, daysInTargetMonth)` (re-applied from the stored anchor, no
 * drift); otherwise it clamps the ORIGINAL day `d` to the target month.
 */
const addMonths = (y: number, m: number, d: number, months: number, anchorDay?: number): string => {
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month1 = (total % 12) + 1;
  const wanted = anchorDay ?? d;
  const day = Math.min(wanted, daysInMonth(year, month1));
  return fmt(year, month1, day);
};

/**
 * Advance a `YYYY-MM-DD` date by one recurrence step. `intervalCount` (≥1) is the
 * multiplier (e.g. monthly ×2 = every 2 months). `dayOfMonth` (1–31), when set,
 * anchors monthly-family advances to that day (drift-free); it is ignored for
 * weekly.
 */
export const advanceRecurrence = (
  dateOnly: string,
  interval: RecurringInterval,
  intervalCount: number,
  dayOfMonth?: number | null,
): string => {
  const [y, m, d] = parseDateOnly(dateOnly);
  const count = Number.isInteger(intervalCount) && intervalCount >= 1 ? intervalCount : 1;
  const anchor = dayOfMonth != null && dayOfMonth >= 1 && dayOfMonth <= 31 ? dayOfMonth : undefined;
  switch (interval) {
    case "weekly":
      return addDays(y, m, d, 7 * count);
    case "monthly":
      return addMonths(y, m, d, 1 * count, anchor);
    case "quarterly":
      return addMonths(y, m, d, 3 * count, anchor);
    case "yearly":
      return addMonths(y, m, d, 12 * count, anchor);
  }
};

/**
 * The first run date on or after `startDate` that lands on `dayOfMonth`. If
 * startDate is already on/before the anchor day this month, use this month;
 * otherwise roll to next month. Day is clamped to month length.
 */
export const firstRunOnOrAfter = (startDate: string, dayOfMonth: number): string => {
  const [y, m, d] = parseDateOnly(startDate);
  const thisMonthDay = Math.min(dayOfMonth, daysInMonth(y, m));
  if (d <= thisMonthDay) return fmt(y, m, thisMonthDay);
  return addMonths(y, m, d, 1, dayOfMonth);
};
