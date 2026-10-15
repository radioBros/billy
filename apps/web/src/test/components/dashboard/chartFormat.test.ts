import { describe, it, expect } from "vitest";
import { minorToCompact, monthKeyToAbbr } from "@/components/dashboard/chartFormat";
import { monthAbbr } from "@/components/dashboard/types";
import { setI18nLocale } from "@/plugins/i18n";

describe("dashboard phone chart formatters", () => {
  it("formats minor units as compact currency for axis ticks", () => {
    const out = minorToCompact(1_200_000, "EUR"); // €12,000.00
    expect(out).toMatch(/12/);
    expect(out).toMatch(/K/i);
    expect(out).not.toContain(".00");
  });

  it("falls back to a plain compact number without a valid currency", () => {
    expect(minorToCompact(150_000_000, null)).toMatch(/1\.5M/);
  });

  it("maps YYYY-MM keys to short month names", () => {
    expect(monthKeyToAbbr("2026-03")).toBe("Mar");
    expect(monthKeyToAbbr("bogus")).toBe("bogus");
  });

  it("follows the active i18n locale (capitalised) and switches back", () => {
    try {
      setI18nLocale("it");
      expect(monthKeyToAbbr("2026-01")).toBe("Gen");
      expect(monthAbbr(5)).toBe("Mag");
      setI18nLocale("de");
      expect(monthAbbr(3)).toBe("Mär");
    } finally {
      setI18nLocale("en");
    }
    expect(monthAbbr(12)).toBe("Dec");
    expect(monthAbbr(13)).toBe("13");
  });
});
