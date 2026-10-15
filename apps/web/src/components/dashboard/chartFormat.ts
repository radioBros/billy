/**
 * Phone-sized chart axis helpers for the dashboard charts.
 *
 * On a 360px screen a full "€12,000.00" y-axis label eats a third of the plot,
 * so phone charts label the money axis in compact notation ("€12K") and the
 * month axis with short month names. Tooltips keep the exact amounts.
 */
import { MONTH_ABBR } from "@/components/dashboard/types";

/** Compact currency for axis ticks: minor units → "€12K" / "$1.5M" (plain number when no currency). */
export const minorToCompact = (minor: number, currency: string | null | undefined): string => {
  const major = minor / 100;
  const ccy = currency && /^[A-Z]{3}$/u.test(currency) ? currency : undefined;
  try {
    return new Intl.NumberFormat(undefined, {
      ...(ccy ? { style: "currency", currency: ccy } : {}),
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(major);
  } catch {
    return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(major);
  }
};

/** "2026-03" → "Mar" (falls back to the raw value when it isn't a YYYY-MM key). */
export const monthKeyToAbbr = (month: string): string => {
  const n = Number(month.slice(5, 7));
  return MONTH_ABBR[n - 1] ?? month;
};
