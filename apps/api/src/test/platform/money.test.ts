import { describe, it, expect } from "vitest";
import { roundHalfAwayFromZero, computeLine, computeDocumentTotals } from "@/platform/money.js";
import { nextSequence, formatDocumentNumber, type Counter } from "@/platform/numbering.js";

describe("money — rounding", () => {
  it("rounds half away from zero", () => {
    expect(roundHalfAwayFromZero(0.5)).toBe(1);
    expect(roundHalfAwayFromZero(1.5)).toBe(2);
    expect(roundHalfAwayFromZero(2.5)).toBe(3); // not banker's rounding
    expect(roundHalfAwayFromZero(-0.5)).toBe(-1);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
  });
});

describe("money — line + document totals (integer minor units)", () => {
  it("computes a line with discount + tax", () => {
    // 3 × €10.00 = €30.00; 10% discount = €3.00; 22% tax on €27.00 = €5.94
    const l = computeLine({ description: "x", quantity: 3, unitPriceMinor: 1000, discountRate: 10, taxRate: 22 });
    expect(l.lineSubtotalMinor).toBe(3000);
    expect(l.lineDiscountMinor).toBe(300);
    expect(l.lineTaxMinor).toBe(594);
    expect(l.lineTotalMinor).toBe(3294);
  });
  it("handles fractional quantity (hours) with rounding", () => {
    // 1.5 × €12.34 = 1851 (1850.999… → 1851 half-away)
    const l = computeLine({ description: "hrs", quantity: 1.5, unitPriceMinor: 1234 });
    expect(l.lineSubtotalMinor).toBe(1851);
    expect(l.lineTotalMinor).toBe(1851);
  });
  it("sums rounded lines so lines reconcile to the total", () => {
    const t = computeDocumentTotals([
      { description: "a", quantity: 1, unitPriceMinor: 999, taxRate: 22 },
      { description: "b", quantity: 2, unitPriceMinor: 500, taxRate: 22 },
    ]);
    expect(t.subtotalMinor).toBe(1999);
    expect(t.taxMinor).toBe(t.lines[0]!.lineTaxMinor + t.lines[1]!.lineTaxMinor);
    expect(t.grandTotalMinor).toBe(t.lines.reduce((a, l) => a + l.lineTotalMinor, 0));
  });
});

describe("numbering", () => {
  it("formats document numbers with padding + optional year", () => {
    expect(formatDocumentNumber({ prefix: "INV", seq: 7, padding: 4, year: 2026 })).toBe("INV-2026-0007");
    expect(formatDocumentNumber({ prefix: "Q", seq: 42, padding: 3 })).toBe("Q-042");
  });
  it("slashYear style formats as {seq}/{year}, no prefix/padding", () => {
    expect(formatDocumentNumber({ prefix: "INV", seq: 20, padding: 4, year: 2026, style: "slashYear" })).toBe("20/2026");
    expect(formatDocumentNumber({ prefix: "INV", seq: 3, padding: 4, style: "slashYear" })).toBe("3");
  });
  it("nextSequence increments atomically (fake collection)", async () => {
    let seq = 0;
    const fake = {
      findOneAndUpdate: async () => ({ _id: "invoice-2026", seq: ++seq }),
    } as unknown as import("mongodb").Collection<Counter>;
    expect(await nextSequence(fake, "acct", "invoice-2026")).toBe(1);
    expect(await nextSequence(fake, "acct", "invoice-2026")).toBe(2);
  });
});
