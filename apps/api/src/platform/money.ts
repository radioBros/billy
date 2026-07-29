export const roundHalfAwayFromZero = (n: number): number => {
  return Math.sign(n) * Math.round(Math.abs(n));
};

export interface LineItemInput {
  description: string;
  /** May be fractional (e.g. hours). */
  quantity: number;
  /** Unit price in integer minor units. */
  unitPriceMinor: number;
  /** Percentage discount on the line, 0–100 (optional). */
  discountRate?: number;
  /** Percentage tax on the (post-discount) line, 0–100 (optional). */
  taxRate?: number;
}

export interface LineItemComputed extends LineItemInput {
  lineSubtotalMinor: number; // quantity × unitPrice, rounded
  lineDiscountMinor: number; // rounded
  lineTaxMinor: number; // rounded, on (subtotal − discount)
  lineTotalMinor: number; // subtotal − discount + tax
}

export const computeLine = (input: LineItemInput): LineItemComputed => {
  const lineSubtotalMinor = roundHalfAwayFromZero(input.quantity * input.unitPriceMinor);
  const discountRate = input.discountRate ?? 0;
  const taxRate = input.taxRate ?? 0;
  const lineDiscountMinor = roundHalfAwayFromZero((lineSubtotalMinor * discountRate) / 100);
  const taxableMinor = lineSubtotalMinor - lineDiscountMinor;
  const lineTaxMinor = roundHalfAwayFromZero((taxableMinor * taxRate) / 100);
  return {
    ...input,
    lineSubtotalMinor,
    lineDiscountMinor,
    lineTaxMinor,
    lineTotalMinor: taxableMinor + lineTaxMinor,
  };
};

export interface DocumentTotals {
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  grandTotalMinor: number;
  lines: LineItemComputed[];
}

export const computeDocumentTotals = (lines: readonly LineItemInput[]): DocumentTotals => {
  const computed = lines.map(computeLine);
  const sum = (pick: (l: LineItemComputed) => number): number => computed.reduce((a, l) => a + pick(l), 0);
  return {
    subtotalMinor: sum((l) => l.lineSubtotalMinor),
    discountMinor: sum((l) => l.lineDiscountMinor),
    taxMinor: sum((l) => l.lineTaxMinor),
    grandTotalMinor: sum((l) => l.lineTotalMinor),
    lines: computed,
  };
};
