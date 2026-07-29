/** Small date helpers for form defaults. All operate on `YYYY-MM-DD` strings. */

/** Today as a local `YYYY-MM-DD`. */
export const todayIso = (): string => new Date().toISOString().slice(0, 10);

/**
 * Add `n` days to a `YYYY-MM-DD` date, returning `YYYY-MM-DD`. Falls back to
 * today+n if the input isn't a valid date-only string.
 */
export const addDays = (isoDate: string, n: number): string => {
  const base = /^\d{4}-\d{2}-\d{2}$/.test(isoDate) ? new Date(`${isoDate}T00:00:00Z`) : new Date();
  base.setUTCDate(base.getUTCDate() + n);
  return base.toISOString().slice(0, 10);
};
