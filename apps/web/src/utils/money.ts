export const minorToDisplay = (amountMinor: number | null | undefined, currency: string | null | undefined, placeholder = "—"): string => {
  if (amountMinor == null || !Number.isFinite(amountMinor)) return placeholder;
  const ccy = currency && /^[A-Z]{3}$/u.test(currency) ? currency : undefined;
  const major = amountMinor / 100;
  if (ccy) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: ccy }).format(major);
    } catch {
      // Unknown/invalid currency code — fall through to a plain number.
    }
  }
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(major);
};

export const majorToMinor = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
};

export const minorToMajor = (amountMinor: number | null | undefined): number | null => {
  if (amountMinor == null || !Number.isFinite(amountMinor)) return null;
  return amountMinor / 100;
};

const roundHalfAwayFromZero = (n: number): number => {
  return n < 0 ? -Math.round(-n) : Math.round(n);
};

export interface LineTotalsInput {
  quantity: number;
  unitPriceMinor: number;
  discountRate?: number;
  taxRate?: number;
}

export interface DocumentTotals {
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  grandTotalMinor: number;
}

export const computeDisplayTotals = (lines: readonly LineTotalsInput[]): DocumentTotals => {
  let subtotalMinor = 0;
  let discountMinor = 0;
  let taxMinor = 0;
  let grandTotalMinor = 0;
  for (const l of lines) {
    const qty = Number(l.quantity) || 0;
    const unit = Number(l.unitPriceMinor) || 0;
    const lineSubtotal = roundHalfAwayFromZero(qty * unit);
    const lineDiscount = roundHalfAwayFromZero((lineSubtotal * (l.discountRate ?? 0)) / 100);
    const taxable = lineSubtotal - lineDiscount;
    const lineTax = roundHalfAwayFromZero((taxable * (l.taxRate ?? 0)) / 100);
    subtotalMinor += lineSubtotal;
    discountMinor += lineDiscount;
    taxMinor += lineTax;
    grandTotalMinor += taxable + lineTax;
  }
  return { subtotalMinor, discountMinor, taxMinor, grandTotalMinor };
};
