/**
 * Reusable cross-field business rules.
 * Pure predicates so each can be unit-tested in isolation and composed into any
 * entity schema via `.refine`/`.superRefine`. `YYYY-MM-DD` strings compare
 * correctly with `>=` (lexicographic == chronological).
 */

/** Invoice: dueDate ≥ issueDate. */
export const dueOnOrAfterIssue = (issueDate: string, dueDate: string): boolean => dueDate >= issueDate;

/** Quote: expiryDate ≥ issueDate. */
export const expiryOnOrAfterIssue = (issueDate: string, expiryDate: string): boolean => expiryDate >= issueDate;

/** Contract: endDate ≥ startDate (when an end is set). */
export const endOnOrAfterStart = (startDate: string, endDate: string | null | undefined): boolean =>
  endDate == null || endDate >= startDate;

/** Payment amount must be strictly positive (minor units). */
export const isPositiveAmount = (amountMinor: number): boolean => Number.isInteger(amountMinor) && amountMinor > 0;

/** Duration (e.g. time entry minutes) must be non-negative. */
export const isNonNegativeDuration = (value: number): boolean => Number.isInteger(value) && value >= 0;
