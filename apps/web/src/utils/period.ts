/**
 * Period helpers for the month bar → list-query bridge.
 *
 * The list grammar filters a date field via `field[gte]`/`field[lte]` (a range),
 * so a month selection must collapse to a `[from, to]` date-only span. A single
 * month → that month; several months → the span from the earliest to the latest
 * selected month (a contiguous range; non-contiguous picks widen to the span —
 * an accepted, Fatture-like behaviour). Empty selection → the whole year.
 */

const pad = (n: number): string => String(n).padStart(2, "0");

/** Days in a 1-based month of a year. */
const daysInMonth = (year: number, month1: number): number =>
  new Date(year, month1, 0).getDate();

export interface DateBounds {
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
}

/**
 * The inclusive date-only bounds for a year + month selection. `months` is a set
 * of 1-based month numbers; empty ⇒ the whole year (Jan 1 .. Dec 31).
 */
export const monthRangeBounds = (year: number, months: readonly number[]): DateBounds => {
  const valid = months.filter((m) => Number.isInteger(m) && m >= 1 && m <= 12);
  if (valid.length === 0) {
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }
  const lo = Math.min(...valid);
  const hi = Math.max(...valid);
  return {
    from: `${year}-${pad(lo)}-01`,
    to: `${year}-${pad(hi)}-${pad(daysInMonth(year, hi))}`,
  };
};
