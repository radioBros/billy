import { describe, it, expect } from "vitest";
import { minorToDisplay, majorToMinor, minorToMajor, computeDisplayTotals } from "@/utils/money";

describe("minorToDisplay", () => {
  it("formats integer minor units as a currency amount", () => {
    // Non-breaking spaces vary by locale/runtime; assert the digits + code instead.
    const out = minorToDisplay(1050, "EUR");
    expect(out).toMatch(/10[.,]50/u);
    expect(out).toContain("€");
  });

  it("renders a placeholder when the amount is absent (stripped for restricted users)", () => {
    expect(minorToDisplay(undefined, "EUR")).toBe("—");
    expect(minorToDisplay(null, "USD")).toBe("—");
    expect(minorToDisplay(0, "EUR")).not.toBe("—");
  });

  it("falls back to a plain 2dp number when currency is missing or invalid", () => {
    expect(minorToDisplay(1050, undefined)).toMatch(/10[.,]50/u);
    expect(minorToDisplay(1050, "notacode")).toMatch(/10[.,]50/u);
  });
});

describe("majorToMinor", () => {
  it("converts a major-unit value to integer minor units", () => {
    expect(majorToMinor("10.50")).toBe(1050);
    expect(majorToMinor(10.5)).toBe(1050);
    expect(majorToMinor(0)).toBe(0);
  });

  it("rounds to the nearest minor unit", () => {
    expect(majorToMinor("10.005")).toBe(1001);
    expect(majorToMinor("10.004")).toBe(1000);
  });

  it("returns null for blank/invalid input", () => {
    expect(majorToMinor("")).toBeNull();
    expect(majorToMinor(null)).toBeNull();
    expect(majorToMinor(undefined)).toBeNull();
    expect(majorToMinor("abc")).toBeNull();
  });
});

describe("minorToMajor", () => {
  it("round-trips with majorToMinor", () => {
    expect(minorToMajor(1050)).toBe(10.5);
    expect(minorToMajor(null)).toBeNull();
  });
});

describe("computeDisplayTotals", () => {
  it("computes quantity × unit price for a plain line", () => {
    const t = computeDisplayTotals([{ quantity: 3, unitPriceMinor: 1000 }]);
    expect(t.subtotalMinor).toBe(3000);
    expect(t.discountMinor).toBe(0);
    expect(t.taxMinor).toBe(0);
    expect(t.grandTotalMinor).toBe(3000);
  });

  it("applies discount then tax on the discounted base", () => {
    // 2 × €10 = 2000; 10% discount = 200; taxable 1800; 20% tax = 360; total 2160.
    const t = computeDisplayTotals([{ quantity: 2, unitPriceMinor: 1000, discountRate: 10, taxRate: 20 }]);
    expect(t.subtotalMinor).toBe(2000);
    expect(t.discountMinor).toBe(200);
    expect(t.taxMinor).toBe(360);
    expect(t.grandTotalMinor).toBe(2160);
  });

  it("sums per-line (already-rounded) values across multiple lines", () => {
    const t = computeDisplayTotals([
      { quantity: 1, unitPriceMinor: 1000, taxRate: 10 },
      { quantity: 2, unitPriceMinor: 500 },
    ]);
    // line1: 1000 +100 tax = 1100; line2: 1000; total 2100.
    expect(t.subtotalMinor).toBe(2000);
    expect(t.taxMinor).toBe(100);
    expect(t.grandTotalMinor).toBe(2100);
  });
});
