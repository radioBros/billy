/** Whole-day arithmetic on `YYYY-MM-DD` strings (UTC, no DST surprises). */
export const addDaysIso = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export const daysBetweenIso = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** `YYYY-MM-DD` for `now` in an IANA timezone (bad zone → UTC). */
export const todayInZone = (timeZone: string | null | undefined, now: Date = new Date()): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
};
